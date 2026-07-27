import { Channel, type ChannelOptions, isStopError, STOP } from "./channel.ts";
import { isAsyncIterable, isIterator, isPromise } from "./utils.ts";

export type Source<T> =
  | Promise<T>
  | AsyncIterable<T>
  | AsyncIterator<T>
  | Iterable<T>
  | Iterator<T>;

export type PipeOptions = {
  autoStart?: boolean;
  autoClose?: boolean | "strong";
  onThrow?: "throw" | "ignore";
  onReturn?: "close" | "ignore";
  backPressure?: boolean;
};

const pipeSources = new WeakMap<Channel<any>, Set<WeakRef<object>>>();

export async function feed<T>(
  source: Source<T>,
  channel: Channel<T>,
  {
    autoStart = false,
    autoClose = true,
    onThrow = "throw",
    onReturn = "close",
    backPressure = true,
  }: PipeOptions = {},
): Promise<void> {
  let sources = pipeSources.get(channel);
  if (!sources) {
    sources = new Set();
    pipeSources.set(channel, sources);
  }
  const sourceRef = new WeakRef(source as object);
  sources.add(sourceRef);

  if (!autoStart) {
    const resolvers = Promise.withResolvers<number>();
    channel.send(STOP as unknown as T, resolvers);
    await resolvers.promise;
  }

  try {
    if (isPromise(source)) {
      const val = await source;
      if (backPressure) await channel.asend(val);
      else channel.send(val);
    } else if (isAsyncIterable(source)) {
      for await (const val of source as AsyncIterable<T>) {
        if (backPressure) await channel.asend(val);
        else channel.send(val);
      }
    } else if (isIterator(source)) {
      const iter = source as any;
      for (;;) {
        const rawRes = iter.next();
        if (!backPressure && !isPromise(rawRes)) {
          throw new TypeError(
            "Synchronous iterators require backPressure: true",
          );
        }
        const res = await rawRes;
        if (res.done) {
          if (res.value !== undefined) {
            if (backPressure) await channel.asend(res.value);
            else channel.send(res.value);
          }
          break;
        }
        if (backPressure) await channel.asend(res.value);
        else channel.send(res.value);
      }
    } else {
      if (!backPressure) {
        throw new TypeError("Synchronous iterables require backPressure: true");
      }
      for (const val of source as Iterable<T>) {
        await channel.asend(val);
      }
    }
  } catch (err: any) {
    if (!isStopError(err)) {
      if (onThrow === "throw") channel.throw(err);
    }
  } finally {
    sources.delete(sourceRef);
    if (onReturn === "close" && autoClose && !channel.signal.aborted) {
      if (autoClose === "strong" || sources.size === 0) {
        channel.close();
      }
    }
  }
}

export function pipe<T>(
  source: Source<T>,
  options?: PipeOptions & ChannelOptions,
): Channel<T> {
  const ch = new Channel<T>(options);
  feed(source, ch, options);
  return ch;
}
