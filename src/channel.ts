import { noop, unreachable } from "./utils.ts";

type AckSeq = number;
type Next<T> = [T, Promise<Next<T>> | undefined, AckSeq];
export type FirstReceive = "first" | "unread" | "latest" | "next";
export type ThenReceive = "every" | "latest";
export type StopStyle = "drain" | "stop";

export const STOP = Symbol("STOP");

export function isStopError(error: unknown): boolean {
  return (error as any)?.reason === STOP;
}

export type ChannelOptions = {
  name?: string;
  firstReceive?: FirstReceive;
  thenReceive?: ThenReceive;
  stopStyle?: StopStyle;
};

export class Channel<T, TReturn = any>
  implements AsyncIterable<T, TReturn>, Disposable
{
  readonly name: string;

  #aborter = new AbortController();
  readonly signal = this.#aborter.signal;
  readonly closed = new Promise<Event>(ok =>
    this.#aborter.signal.addEventListener("abort", ok),
  );

  #seq: AckSeq = 1;
  #acks = new Map<WeakRef<PromiseWithResolvers<AckSeq>>, AckSeq>();

  #registry = new FinalizationRegistry<WeakRef<PromiseWithResolvers<AckSeq>>>(
    // Stryker disable next-line ArrowFunction: GC sweep is a memory optimization
    ref => this.#acks.delete(ref),
  );

  #value = Promise.withResolvers<Next<T>>();
  #rxHead?: Promise<Next<T>>;
  #latest?: Promise<Next<T>>;
  #return?: TReturn; // value to end consumer AsyncIterables with

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

  send(value: T, nextAck?: PromiseWithResolvers<AckSeq>) {
    this.signal.throwIfAborted();

    const resolve = this.#value.resolve;
    this.#latest = this.#value.promise;
    this.#value = Promise.withResolvers<Next<T>>();

    if (nextAck) {
      const ref = new WeakRef(nextAck);
      this.#acks.set(ref, (this.#seq += 1));
      this.#registry.register(nextAck, ref);
    }

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
    const resolvers = Promise.withResolvers<AckSeq>();
    this.send(value, resolvers);
    return await resolvers.promise;
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
          try {
            // Stryker disable next-line OptionalChaining: defensively untestable due to GC race
            ref.deref()?.resolve(seq);
          } catch {
            // ignore sabotage
          }
          this.#acks.delete(ref);
        }

        // Channels advance rxHead to current before yielding value to observers.
        // If this code runs it means someone already called .next() on the channel.
        // Stryker disable next-line all: preventing redundant assignment when rxHead is already next, untestable due to FIFO microtask queue
        if (firstIsUnread && current === this.#rxHead) this.#rxHead = next;

        // Yield blocks till consumer is done reading the value
        yield value;

        // Refresh next which might've become stale while we waited
        if (skipToLatest) {
          next = this.#latest as Promise<Next<T>>;
          if (next === current) next = this.#value.promise;
        }

        // Intentionally do not advance rxHead till next consumer actually reads
      } catch (error: unknown) {
        if (error === STOP) break;
        throw error;
      }

    // biome-ignore lint/style/noNonNullAssertion: dont care if undefined
    return this.#return!;
  }

  throw(value: unknown) {
    let reason = value;
    if (value === STOP) reason = "Channel closed";
    this.#aborter.abort(reason);
    this.#value.promise.catch(noop); // no unhandledRejection when unobserved
    this.#value.reject(value);

    let err = value;
    if (value === STOP) {
      err = Object.assign(new Error("Channel closed"), { reason: STOP });
    }

    // Reject any pending producers with the same error so they don't hang
    for (const [ref] of this.#acks) {
      try {
        // Stryker disable next-line OptionalChaining: untestable GC race
        ref.deref()?.reject(err);
      } catch {} // ignore sabotage
    }
    this.#acks.clear();
  }

  close(returnValue?: TReturn) {
    this.#return = returnValue;
    this.throw(STOP);
  }

  [Symbol.dispose]() {
    this.close();
  }
}

export function channel<T>(options?: ChannelOptions): Channel<T> {
  return new Channel<T>(options);
}
