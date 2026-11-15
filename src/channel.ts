import { bindPulled, type Emit, pulledSource, register } from "./devtools.ts";
import { checkKeys, isThenable, noop } from "./source.ts";

export type FirstReceive = "first" | "unread" | "latest" | "next";
export type ThenReceive = "every" | "latest" | "unread";
export type StopStyle = "drain" | "stop";
export type AckStyle = "any" | "all";

type Sendable<T> = T extends PromiseLike<any> ? never : T;

export type ChannelOptions = {
  firstReceive?: FirstReceive;
  thenReceive?: ThenReceive;
  stopStyle?: StopStyle;
  ackStyle?: AckStyle;
};

// The tail cell is empty and receives the next value, so n <= the newest number means filled.
type Cell<T> = { n: number; value?: T; next?: Cell<T> };
// A placed reader reads the newest value next, while an unplaced one reads the head.
type Reader<T> = { at?: Cell<T>; pos: number; placed?: boolean };
type Ack = PromiseWithResolvers<void> & { n: number; next?: Ack };
// The stop flag of a consumer, and its own wake while it blocks under thenReceive "unread" (CH-075).
type Stop = { on?: true; wake?: () => void };

const STOP_BRAND = Symbol.for("gg.StopError");
/** The values that each channel option takes. */
export const CHOICES: Record<keyof ChannelOptions, string[]> = {
  firstReceive: ["first", "unread", "latest", "next"],
  thenReceive: ["every", "latest", "unread"],
  stopStyle: ["drain", "stop"],
  ackStyle: ["any", "all"],
};

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
/** Tells if the channel is terminal, with no signal to make. */
export let terminal: (channel: Channel<any, any>) => boolean;
/** Gives the value that `close` or `throw` ended the channel with. */
export let resultOf: (channel: Channel<any, any>) => unknown;
/** Calls ended when the channel turns terminal, before its signal aborts, for the one select of the channel. */
export let onEnd: (channel: Channel<any, any>, ended: () => void) => void;
/** Calls joined when a consumer attaches, before it takes its start, for the one select of the channel. */
export let onAttach: (channel: Channel<any, any>, joined: () => void) => void;
/** Tells if the channel has an active consumer. */
export let consumed: (channel: Channel<any, any>) => boolean;

let silent: boolean | undefined, // Set while a preset makes its channel, which it registers itself
  connect: (channel: Channel<any, any>, emit: Emit | undefined) => void;

/** The options that a preset takes, because the preset sets the receive modes. */
export type PresetOptions = Pick<ChannelOptions, "stopStyle" | "ackStyle">;
type Preset = <T, TReturn = undefined>(
  options?: PresetOptions,
) => Channel<T, TReturn>;
const STYLES = { stopStyle: 0, ackStyle: 0 };

/** Makes a preset of the receive modes, which takes only the stop and ack styles. */
const preset =
  (firstReceive: FirstReceive, thenReceive: ThenReceive): Preset =>
  (options = {}) => {
    checkKeys(options, STYLES);
    const chosen = {
      firstReceive,
      thenReceive,
      stopStyle: options.stopStyle ?? "drain",
      ackStyle: options.ackStyle ?? "any",
    };
    silent = true;
    let channel: Channel<any, any>;
    try {
      channel = new Channel(chosen);
    } finally {
      silent = false;
    }
    // Here, so the hook finds the caller at its fixed depth (DV-003).
    connect(channel, register("channel", channel, chosen));
    return channel;
  };

/** Makes a channel that gives each consumer the newest value, and then each newer value. */
export const latest: Preset = preset("latest", "latest");
/** Makes a work queue, which gives each value to one consumer. */
export const queue: Preset = preset("unread", "unread");
/** Makes a channel that gives each consumer each value sent after it attached. */
export const broadcast: Preset = preset("next", "every");
/** Makes a channel that gives each consumer every value from the first one. */
export const replay: Preset = preset("first", "every");

/** An async stream with many producers and consumers, whose options set what each consumer reads. */
export class Channel<T, TReturn = undefined>
  implements AsyncIterable<T, TReturn | undefined>, Disposable
{
  #first: FirstReceive;
  #then: ThenReceive;
  #stops: boolean;
  #readers?: Set<Reader<T>>; // The active consumers, which an ack waits for under "all"
  #control?: AbortController; // Made on the first read of signal
  #stop?: StopError;
  #terminal = false;
  #tail: Cell<T> = { n: 1 };
  #anchor!: Cell<T>; // The head for "unread", value 1 for "first", and read only once set
  #newest?: Cell<T>;
  #active = 0;
  #placed = 0;
  #behind = 0; // Placed consumers whose position is before the newest value
  #acked = {} as Ack; // The last settled ack, or a blank one
  #lastAck = this.#acked;
  #wake?: PromiseWithResolvers<void>; // The one wake of all blocked consumers, except under "unread"
  // Under "unread" one consumer reads each value, so a send wakes only the first one that blocked.
  #queue?: Stop[];
  #consumer?: PromiseWithResolvers<void>;
  #failed?: boolean;
  #result: unknown;
  #ended?: () => void;
  #joined?: () => void;
  #emit?: Emit;

  static {
    attached = channel =>
      channel.#terminal
        ? Promise.reject(channel.#stopError())
        : channel.#active
          ? Promise.resolve()
          : (channel.#consumer ??= Promise.withResolvers()).promise;
    isChannel = value => Object(value) === value && #tail in (value as object);
    connect = (channel, emit) => {
      channel.#emit = emit;
    };
    failed = channel => !!channel.#failed;
    terminal = channel => channel.#terminal;
    resultOf = channel => channel.#result;
    onEnd = (channel, ended) => {
      channel.#ended = ended;
    };
    onAttach = (channel, joined) => {
      channel.#joined = joined;
    };
    consumed = channel => channel.#active > 0;
  }

  /** Aborts when the channel is terminal, with the stop error as its reason. */
  get signal(): AbortSignal {
    if (!this.#control) {
      this.#control = new AbortController();
      if (this.#terminal) this.#control.abort(this.#stopError());
    }
    return this.#control.signal;
  }

  /** Checks the options, and registers the channel with devtools. */
  constructor(options: ChannelOptions = {}) {
    const {
      firstReceive = "unread",
      thenReceive = "every",
      stopStyle = "drain",
      ackStyle = "any",
    } = options;
    const chosen = { firstReceive, thenReceive, stopStyle, ackStyle };
    checkKeys(options, CHOICES);
    for (const name of Object.keys(CHOICES) as (keyof ChannelOptions)[])
      if (!CHOICES[name].includes(chosen[name]))
        throw new TypeError(
          `Option ${name} must be one of ${CHOICES[name].join(", ")}`,
        );
    if (thenReceive === "unread" && firstReceive !== "unread")
      throw new TypeError(
        'thenReceive "unread" requires firstReceive "unread"',
      );
    if (thenReceive === "unread" && ackStyle === "all")
      throw new TypeError(
        'ackStyle "all" does not apply to thenReceive "unread"',
      );
    this.#first = firstReceive;
    this.#then = thenReceive;
    this.#stops = stopStyle === "stop";
    if (ackStyle === "all") this.#readers = new Set();
    // Stryker disable next-line ConditionalExpression,StringLiteral,ArrayDeclaration: without the queue each consumer wakes, and all but one block again, so only the work differs
    if (thenReceive === "unread") this.#queue = [];
    if (firstReceive === "first" || firstReceive === "unread")
      this.#anchor = this.#tail;
    if (!silent) this.#emit = register("channel", this, chosen);
  }

  /** Appends a value to the log, and wakes blocked consumers. */
  send(value: Sendable<T>): void {
    if (this.#terminal) throw this.#stopError();
    const thenable = isThenable(value);
    if (this.#terminal) throw this.#stopError(); // A then getter can close the channel
    if (thenable) throw new TypeError("Channel does not accept thenables");
    const cell: Cell<T> = this.#tail;
    this.#tail = { n: cell.n + 1 };
    cell.value = value;
    // Under "latest" nothing walks the links, so a retained cell retains only its own value.
    if (this.#then !== "latest") cell.next = this.#tail;
    this.#behind = this.#placed;
    this.#newest = this.#keepsNewest() ? cell : undefined;
    if (this.#queue) this.#hand();
    else this.#rouse();
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
      if (!this.#terminal || error !== this.#stop) return Promise.reject(error); // CH-013 stays loud when ignored
      ack.reject(error);
    }
    ack.promise.catch(noop); // CH-01C, and an awaiting producer still sees the rejection
    return ack.promise;
  }

  /** Ends the channel, so consumers finish with value after the values that stopStyle keeps. */
  close(value?: Sendable<TReturn>): void {
    // The second check is CH-061, because a then getter can close the channel.
    if (!this.#terminal && isThenable(value) && !this.#terminal)
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

  /**
   * Gives a new consumer, which attaches at its first `next()`.
   * Its `return()` and `throw()` end a pending `next()` at once (CH-073). */
  [Symbol.asyncIterator](): AsyncGenerator<T, TReturn | undefined, void> {
    const stop: Stop = {},
      consumer = this.#consume(stop),
      end = consumer.return.bind(consumer),
      fail = consumer.throw.bind(consumer);
    const halt = () => {
      stop.on = true;
      if (!this.#queue) return this.#rouse();
      const { wake } = stop;
      stop.wake = undefined; // So the queue skips this consumer
      wake?.();
    };
    consumer.return = value => (halt(), end(value));
    consumer.throw = error => (halt(), fail(error));
    bindPulled(consumer); // JX-041
    return consumer;
  }

  /** Reads values for one consumer until it ends, or until stop is on. */
  async *#consume(stop: Stop): AsyncGenerator<T, TReturn | undefined, void> {
    const reader = this.#attach();
    try {
      for (;;) {
        await null; // A read always happens in a microtask
        while (!stop.on && !this.#readable(reader)) {
          if (this.#terminal) {
            if (this.#failed) throw this.#result;
            return this.#result as TReturn;
          }
          await this.#block(stop);
        }
        if (stop.on) return undefined;
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
      if (this.#readers?.delete(reader)) this.#ack(this.#floor()); // CH-01E
      // A consumer that a send woke can end before it reads, so it passes the wake on (CH-075).
      if (this.#queue && this.#readable(reader)) this.#hand();
    }
  }

  /** Waits for a wake: the one of all consumers, or its own in the queue under "unread". */
  #block(stop: Stop) {
    const queue = this.#queue;
    if (!queue) return (this.#wake ??= Promise.withResolvers()).promise;
    return new Promise<void>(resolve => {
      stop.wake = resolve;
      queue.push(stop);
    });
  }

  /** Wakes the first consumer in the queue, and drops the ones that halted. */
  #hand() {
    const queue = this.#queue as Stop[];
    for (let stop: Stop | undefined; (stop = queue.shift()); ) {
      const { wake } = stop;
      if (!wake) continue;
      stop.wake = undefined;
      wake();
      // Stryker disable next-line BlockStatement: a wake of each queued consumer gives the same reads, with more work
      return;
    }
  }

  /** Wakes each consumer that waits, so it checks the channel again. */
  #rouse() {
    this.#wake?.resolve();
    this.#wake = undefined;
  }

  /** Counts a new consumer, and starts it where its first receive mode says. */
  #attach(): Reader<T> {
    this.#joined?.(); // A send here is the newest value at attach
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
    this.#readers?.add(reader);
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
      !(this.#stops && this.#terminal) &&
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
    this.#ack(this.#readers ? this.#floor() : n);
    this.#emit?.("read", value, n, reader);
    return value as T;
  }

  /** Resolves the acks of values up to n. */
  #ack(n: number) {
    let ack = this.#acked.next;
    while (ack && ack.n <= n) {
      ack.resolve();
      this.#acked = ack;
      ack = ack.next;
    }
  }

  /**
   * Gives the last value that every active consumer read or starts after, or 0 with no consumer (CH-01E).
   * Only "first" and "unread" leave a consumer unplaced, and it starts at the anchor. */
  #floor() {
    let floor = Infinity;
    for (const { placed, pos } of this.#readers as Set<Reader<T>>)
      floor = Math.min(floor, placed ? pos : this.#anchor.n - 1);
    return floor === Infinity ? 0 : floor;
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
    if (this.#terminal) return;
    this.#failed = failed;
    this.#result = result;
    for (let ack = this.#acked.next; ack; ack = ack.next)
      ack.reject(this.#stopError());
    this.#acked = this.#lastAck;
    this.#consumer?.reject(this.#stopError());
    this.#consumer = undefined;
    this.#rouse();
    if (this.#queue) for (const stop of this.#queue.splice(0)) stop.wake?.();
    if (this.#stops) {
      this.#newest = undefined;
      this.#anchor = this.#tail;
    }
    this.#emit?.("end", failed, result);
    this.#terminal = true;
    this.#ended?.();
    this.#control?.abort(this.#stopError());
  }
}
