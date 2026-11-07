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

export class StopError extends Error {
  readonly name = "StopError" as const;
  readonly reason: unknown;

  constructor(reason?: unknown) {
    super("Channel closed");
    this.reason = reason;
    Object.defineProperty(this, STOP_BRAND, { value: true });
  }

  static [Symbol.hasInstance](value: unknown) {
    return (value as any)?.[STOP_BRAND] === true;
  }
}

export let attached: (channel: Channel<any, any>) => Promise<void>;
export let isChannel: (value: unknown) => boolean;

export class Channel<T, TReturn = undefined>
  implements AsyncIterable<T, TReturn | undefined>, Disposable
{
  #first: FirstReceive;
  #then: ThenReceive;
  #stops: boolean;
  #control = new AbortController();
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

  readonly signal = this.#control.signal;

  static {
    attached = channel =>
      channel.signal.aborted
        ? Promise.reject(channel.signal.reason)
        : channel.#active
          ? Promise.resolve()
          : (channel.#consumer ??= Promise.withResolvers()).promise;
    isChannel = value => Object(value) === value && #tail in (value as object);
  }

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
  }

  send(value: Sendable<T>): void {
    if (this.signal.aborted) throw this.signal.reason;
    const thenable = isThenable(value);
    if (this.signal.aborted) throw this.signal.reason; // A then getter can close the channel
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
  }

  asend(value: Sendable<T>): Promise<void> {
    const ack: Ack = { ...Promise.withResolvers<void>(), n: 0 };
    try {
      this.send(value);
      ack.n = this.#tail.n - 1; // Read after send, because a then getter can send too
      this.#lastAck = this.#lastAck.next = ack;
    } catch (error) {
      if (!this.signal.aborted || error !== this.signal.reason)
        return Promise.reject(error); // CH-013 stays loud when ignored
      ack.reject(error);
    }
    ack.promise.catch(noop); // CH-01C, and an awaiting producer still sees the rejection
    return ack.promise;
  }

  close(value?: Sendable<TReturn>): void {
    // The second check is CH-061, because a then getter can close the channel.
    if (!this.signal.aborted && isThenable(value) && !this.signal.aborted)
      throw new TypeError("Channel does not accept thenables");
    this.#end(false, value);
  }

  throw(value: unknown): void {
    this.#end(true, value);
  }

  [Symbol.dispose](): void {
    this.close();
  }

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
          if (this.signal.aborted) {
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
      this.#active--;
      if (reader.placed) {
        this.#placed--;
        if (reader.pos < this.#tail.n - 1) this.#behind--;
      }
      this.#prune();
    }
  }

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
    return reader;
  }

  #place(reader: Reader<T>) {
    reader.placed = true;
    this.#placed++;
    if (reader.pos < this.#tail.n - 1) this.#behind++;
  }

  #readable(reader: Reader<T>) {
    return (
      !(this.#stops && this.signal.aborted) &&
      (reader.at ?? this.#anchor).n < this.#tail.n
    );
  }

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
    return value as T;
  }

  // CH-050 keeps the newest value for a latest holder, and for a later "then newest" read.
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

  #prune() {
    if (!this.#keepsNewest()) this.#newest = undefined;
  }

  #end(failed: boolean, result: unknown) {
    if (this.signal.aborted) return;
    const stop = new StopError(failed ? result : undefined);
    this.#failed = failed;
    this.#result = result;
    for (let ack = this.#acked.next; ack; ack = ack.next) ack.reject(stop);
    this.#acked = this.#lastAck;
    this.#consumer?.reject(stop);
    this.#consumer = undefined;
    this.#wake?.resolve();
    this.#wake = undefined;
    if (this.#stops) {
      this.#newest = undefined;
      this.#anchor = this.#tail;
    }
    this.#control.abort(stop);
  }
}
