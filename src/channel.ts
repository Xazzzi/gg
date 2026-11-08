import { type Emit, pulledSource, register } from "./devtools.ts";
import { isThenable, noop } from "./source.ts";

export type FirstReceive = "first" | "unread" | "latest" | "next";
export type ThenReceive = "every" | "latest" | "unread";
export type StopStyle = "drain" | "stop";

type Sendable<T> = T extends PromiseLike<any> ? never : T;

export type ChannelOptions = {
  firstReceive?: FirstReceive;
  thenReceive?: ThenReceive;
  stopStyle?: StopStyle;
};

// The tail cell is empty and receives the next value, so n <= the newest number means filled.
type Cell<T> = { n: number; value?: T; next?: Cell<T> };
// A placed reader reads the newest value next, while an unplaced one reads the head.
type Reader<T> = { at?: Cell<T>; pos: number; placed?: boolean };
type Ack = PromiseWithResolvers<void> & { n: number; next?: Ack };

const STOP_BRAND = Symbol.for("gg.StopError");
const FIRST_RECEIVE = ["first", "unread", "latest", "next"];
const THEN_RECEIVE = ["every", "latest", "unread"];
const STOP_STYLE = ["drain", "stop"];

/** The error that producers and `signal` get after a channel closes or throws. */
export class StopError extends Error {
  readonly name = "StopError" as const;
  readonly reason: unknown;

  constructor(reason?: unknown) {
    super("Channel closed");
    this.reason = reason;
    Object.defineProperty(this, STOP_BRAND, { value: true });
  }

  /** Matches stop errors by brand, so copies from other realms or bundles match too. */
  static [Symbol.hasInstance](value: unknown) {
    return (value as any)?.[STOP_BRAND] === true;
  }
}

/** Resolves when the channel has an active consumer, and rejects when it ends first. */
export let attached: (channel: Channel<any, any>) => Promise<void>;
/** Tells if a value is a real `Channel`, by its private field. */
export let isChannel: (value: unknown) => boolean;
/** Tells if the channel ended with `throw`. */
export let failed: (channel: Channel<any, any>) => boolean;

/** An async stream with many producers and consumers, whose options set what each consumer reads. */
export class Channel<T, TReturn = undefined>
  implements AsyncIterable<T, TReturn | undefined>, Disposable
{
  #first: FirstReceive;
  #then: ThenReceive;
  #stops: boolean;
  #control?: AbortController; // Made on the first read of signal
  #stop?: StopError;
  #ended = false;
  #tail: Cell<T> = { n: 1 };
  #anchor!: Cell<T>; // The head for "unread", value 1 for "first", and read only once set
  #newest?: Cell<T>;
  #active = 0;
  #placed = 0;
  #behind = 0; // Placed consumers whose position is before the newest value
  #acked = {} as Ack; // The last settled ack, or a blank one
  #lastAck = this.#acked;
  #wake?: PromiseWithResolvers<void>;
  #consumer?: PromiseWithResolvers<void>;
  #failed?: boolean;
  #result: unknown;
  #emit?: Emit;

  static {
    attached = channel =>
      channel.#ended
        ? Promise.reject(channel.#stopError())
        : channel.#active
          ? Promise.resolve()
          : (channel.#consumer ??= Promise.withResolvers()).promise;
    isChannel = value => Object(value) === value && #tail in (value as object);
    failed = channel => !!channel.#failed;
  }

  /** Aborts when the channel is terminal, with the stop error as its reason. */
  get signal(): AbortSignal {
    if (!this.#control) {
      this.#control = new AbortController();
      if (this.#ended) this.#control.abort(this.#stopError());
    }
    return this.#control.signal;
  }

  /** Checks the options, and registers the channel with devtools. */
  constructor({
    firstReceive = "unread",
    thenReceive = "every",
    stopStyle = "drain",
  }: ChannelOptions = {}) {
    if (
      !FIRST_RECEIVE.includes(firstReceive) ||
      !THEN_RECEIVE.includes(thenReceive) ||
      !STOP_STYLE.includes(stopStyle)
    )
      throw new TypeError("Invalid channel option");
    if (thenReceive === "unread" && firstReceive !== "unread")
      throw new TypeError(
        'thenReceive "unread" requires firstReceive "unread"',
      );
    this.#first = firstReceive;
    this.#then = thenReceive;
    this.#stops = stopStyle === "stop";
    if (firstReceive === "first" || firstReceive === "unread")
      this.#anchor = this.#tail;
    this.#emit = register("channel", this, {
      firstReceive,
      thenReceive,
      stopStyle,
    });
  }

  /** Appends a value to the log, and wakes blocked consumers. */
  send(value: Sendable<T>): void {
    if (this.#ended) throw this.#stopError();
    const thenable = isThenable(value);
    if (this.#ended) throw this.#stopError(); // A then getter can close the channel
    if (thenable) throw new TypeError("Channel does not accept thenables");
    const cell: Cell<T> = this.#tail;
    this.#tail = { n: cell.n + 1 };
    cell.value = value;
    // Under "latest" nothing walks the links, so a retained cell retains only its own value.
    if (this.#then !== "latest") cell.next = this.#tail;
    this.#behind = this.#placed;
    this.#newest = this.#keepsNewest() ? cell : undefined;
    this.#wake?.resolve();
    this.#wake = undefined;
    this.#emit?.("send", value, cell.n);
  }

  /** Sends a value, and resolves when a consumer reads it or a later value. */
  asend(value: Sendable<T>): Promise<void> {
    const ack: Ack = { ...Promise.withResolvers<void>(), n: 0 };
    try {
      this.send(value);
      ack.n = this.#tail.n - 1; // Read after send, because a then getter can send too
      this.#lastAck = this.#lastAck.next = ack;
    } catch (error) {
      if (!this.#ended || error !== this.#stop) return Promise.reject(error); // CH-013 stays loud when ignored
      ack.reject(error);
    }
    ack.promise.catch(noop); // CH-01C, and an awaiting producer still sees the rejection
    return ack.promise;
  }

  /** Ends the channel, so consumers finish with value after the values that stopStyle keeps. */
  close(value?: Sendable<TReturn>): void {
    // The second check is CH-061, because a then getter can close the channel.
    if (!this.#ended && isThenable(value) && !this.#ended)
      throw new TypeError("Channel does not accept thenables");
    this.#end(false, value);
  }

  /** Ends the channel, so consumers reject with value after the values that stopStyle keeps. */
  throw(value: unknown): void {
    this.#end(true, value);
  }

  /** Closes the channel with no value. */
  [Symbol.dispose](): void {
    this.close();
  }

  /** Gives a new consumer, which attaches at its first `next()`. */
  async *[Symbol.asyncIterator](): AsyncGenerator<
    T,
    TReturn | undefined,
    void
  > {
    const reader = this.#attach();
    try {
      for (;;) {
        await null; // A read always happens in a microtask
        while (!this.#readable(reader)) {
          if (this.#ended) {
            if (this.#failed) throw this.#result;
            return this.#result as TReturn;
          }
          await (this.#wake ??= Promise.withResolvers()).promise;
        }
        yield this.#take(reader);
        if (this.#then === "latest")
          reader.at =
            this.#newest && this.#newest.n > reader.pos
              ? this.#newest
              : this.#tail;
      }
    } finally {
      this.#emit?.("detach", reader);
      this.#active--;
      if (reader.placed) {
        this.#placed--;
        if (reader.pos < this.#tail.n - 1) this.#behind--;
      }
      this.#prune();
    }
  }

  /** Counts a new consumer, and starts it where its first receive mode says. */
  #attach(): Reader<T> {
    this.#active++;
    this.#consumer?.resolve();
    this.#consumer = undefined;
    const first = this.#first;
    const at =
      first === "latest"
        ? (this.#newest ?? this.#tail)
        : first === "next"
          ? this.#tail
          : undefined;
    // Stryker disable next-line ArithmeticOperator: pos only matters after a read, as a reader with no read ends only under "stop", which drops the newest
    const reader: Reader<T> = { at, pos: at ? at.n - 1 : 0 };
    if (at) this.#place(reader);
    this.#emit?.("attach", reader, pulledSource());
    return reader;
  }

  /** Marks a reader as one that follows the newest value. */
  #place(reader: Reader<T>) {
    reader.placed = true;
    this.#placed++;
    if (reader.pos < this.#tail.n - 1) this.#behind++;
  }

  /** Tells if the reader has a value to take now. */
  #readable(reader: Reader<T>) {
    return (
      !(this.#stops && this.#ended) &&
      (reader.at ?? this.#anchor).n < this.#tail.n
    );
  }

  /** Reads the next value for the reader, moves the head, and resolves acks up to it. */
  #take(reader: Reader<T>) {
    const cell = reader.at ?? this.#anchor;
    const { n, next, value } = cell;
    reader.pos = n;
    reader.at = this.#then === "every" ? next : undefined;
    if (this.#first === "unread" && cell === this.#anchor)
      this.#anchor = this.#then === "latest" ? this.#tail : (next as Cell<T>);
    if (!reader.placed) this.#place(reader);
    else if (n === this.#tail.n - 1) this.#behind--;
    this.#prune();
    let ack = this.#acked.next;
    while (ack && ack.n <= n) {
      ack.resolve();
      this.#acked = ack;
      ack = ack.next;
    }
    this.#emit?.("read", value, n, reader);
    return value as T;
  }

  /** Tells if the newest value must stay, for a latest holder or a later "then newest" read (CH-050). */
  #keepsNewest() {
    const first = this.#first;
    if (first === "latest") return true;
    if (this.#then !== "latest") return false;
    return (
      this.#behind > 0 ||
      first === "first" ||
      (first === "unread" && this.#anchor.n < this.#tail.n)
    );
  }

  /** Drops the newest value when no reader can need it. */
  #prune() {
    if (!this.#keepsNewest()) this.#newest = undefined;
  }

  /**
   * Gives the one stop error of the channel, and makes it on first use.
   * Most channels end with no producer and no signal reader, so they never pay for its stack. */
  #stopError() {
    return (this.#stop ??= new StopError(
      this.#failed ? this.#result : undefined,
    ));
  }

  /** Makes the channel terminal one time, rejects pending acks, and aborts the signal. */
  #end(failed: boolean, result: unknown) {
    if (this.#ended) return;
    this.#failed = failed;
    this.#result = result;
    for (let ack = this.#acked.next; ack; ack = ack.next)
      ack.reject(this.#stopError());
    this.#acked = this.#lastAck;
    this.#consumer?.reject(this.#stopError());
    this.#consumer = undefined;
    this.#wake?.resolve();
    this.#wake = undefined;
    if (this.#stops) {
      this.#newest = undefined;
      this.#anchor = this.#tail;
    }
    this.#emit?.("end", failed, result);
    this.#ended = true;
    this.#control?.abort(this.#stopError());
  }
}
