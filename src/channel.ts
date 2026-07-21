import { narrow, noop, unreachable } from "./utils.ts";

type Callback = (value?: unknown) => void;
type AckSeq = number;
type Next<T> = [T, Promise<Next<T>> | undefined, AckSeq];
export type FirstReceive = "first" | "unread" | "latest" | "next";
export type ThenReceive = "every" | "latest";
export type StopStyle = "drain" | "stop";

export const STOP = Symbol("STOP");

export type ChannelOptions = {
  name?: string;
  firstReceive?: FirstReceive;
  thenReceive?: ThenReceive;
  stopStyle?: StopStyle;
};

export class Channel<T> implements AsyncIterable<T>, Disposable {
  readonly name: string;

  #aborter = new AbortController();
  readonly signal = this.#aborter.signal;
  readonly closed = new Promise<Event>(ok =>
    this.#aborter.signal.addEventListener("abort", ok),
  );

  #seq: AckSeq = 1;
  #acks = new Map<WeakRef<Callback>, AckSeq>();
  #value = Promise.withResolvers<Next<T>>();
  #rxHead?: Promise<Next<T>>;
  #latest?: Promise<Next<T>>;

  #firstReceive: FirstReceive;
  #thenReceive: ThenReceive;
  #stopStyle: StopStyle;

  constructor({
    name = Math.random().toString(36),
    firstReceive = "unread",
    thenReceive = "latest",
    stopStyle = "drain",
  }: ChannelOptions = {}) {
    this.name = name;
    this.#firstReceive = firstReceive;
    this.#thenReceive = thenReceive;
    this.#stopStyle = stopStyle;
    if (firstReceive === "first" || firstReceive === "unread") {
      this.#rxHead = this.#value.promise;
    }
  }

  send(value: T, nextAck?: Callback) {
    this.signal.throwIfAborted();

    const resolve = this.#value.resolve;
    this.#latest = this.#value.promise;
    this.#value = Promise.withResolvers<Next<T>>();
    if (nextAck) this.#acks.set(new WeakRef(nextAck), (this.#seq += 1));

    const tuple: Next<T> = [
      value,
      this.#thenReceive === "every" ? this.#value.promise : undefined,
      this.#seq,
    ];

    resolve(tuple);
  }

  // Variant of send() that blocks till value yields.
  // This may never resolve in case sent value was skipped.
  async asend(value: T) {
    return await new Promise(resolve => this.send(value, resolve));
  }

  async *[Symbol.asyncIterator]() {
    const firstIsNext = this.#firstReceive === "next";
    const firstIsLatest = this.#firstReceive === "latest";
    const firstIsUnread = this.#firstReceive === "unread";
    const skipToLatest = this.#thenReceive === "latest";
    const drainOnClose = this.#stopStyle === "drain";

    let next: Promise<Next<T>> = firstIsNext
      ? this.#value.promise
      : firstIsLatest
        ? (this.#latest ?? this.#value.promise)
        : (this.#rxHead ?? unreachable());
    let value: T, seq: number;
    while (drainOnClose || !this.#aborter.signal.aborted)
      try {
        const current = next;
        // No next in chain means thenReceive=latest.
        // Depending on when this resolves, current may or may not be #latest.
        // If caught up then next must point to next value promise.
        [value, next = this.#value.promise, seq] = await current;

        // Unlock producers immediately upon read, before consumer processes the value
        for (const [ref, refSeq] of this.#acks) {
          if (refSeq > seq) break;
          const fn = ref.deref();
          if (fn) fn(seq);
          this.#acks.delete(ref);
        }

        // Channels advance rxHead to current before yielding value to observers.
        // If this code runs it means someone already called .next() on the channel.
        if (firstIsUnread && current === this.#rxHead) this.#rxHead = next;

        // Yield blocks till consumer is done reading the value
        yield value;

        // Refresh next which might've become stale while we waited
        if (skipToLatest) {
          narrow<Promise<Next<T>>>(this.#latest);
          next = this.#latest;
          if (next === current) next = this.#value.promise;
        }

        // Intentionally do not advance rxHead till next consumer actually reads
      } catch (error: unknown) {
        if (error === STOP) break;
        throw error;
      }
  }

  throw(value: unknown) {
    let reason = value;
    if (value === STOP) reason = "Channel closed";
    this.#aborter.abort(reason);
    this.#value.promise.catch(noop); // no unhandledRejection when unobserved
    this.#value.reject(value);
  }

  close() {
    this.throw(STOP);
  }

  [Symbol.dispose]() {
    this.close();
  }
}
