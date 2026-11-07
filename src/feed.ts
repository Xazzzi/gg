import { attached, type Channel, isChannel } from "./channel.ts";
import { checkOptions, detect, noop, quiet, quietReturn } from "./source.ts";

export type Source<T> =
  | PromiseLike<T>
  | AsyncIterable<T>
  | AsyncIterator<T>
  | Iterable<T>
  | Iterator<T>;

export type FeedOptions = {
  autoStart?: boolean;
  autoClose?: boolean;
  backPressure?: boolean;
  sendReturn?: boolean;
};

const ABORTED = Symbol();
const OPTION_TYPES = {
  autoStart: "boolean",
  autoClose: "boolean",
  backPressure: "boolean",
  sendReturn: "boolean",
};
const runs = new WeakMap<object, { active: number }>();

async function run(
  source: any,
  { stream, open }: NonNullable<ReturnType<typeof detect>>,
  channel: Channel<any, any>,
  autoStart: boolean,
  backPressure: boolean,
  sendReturn: boolean,
) {
  const { signal } = channel;
  if (!autoStart) await attached(channel).catch(noop);
  if (signal.aborted) {
    if (stream) await quietReturn(source);
    return;
  }
  let iterator: any,
    next: any,
    done: any,
    answered: any,
    cancel: (value: unknown) => void = noop;
  // One listener per run, so the race retains nothing per pull.
  const onAbort = () => cancel(ABORTED);
  const pull = async () => {
    const result = await next.call(iterator);
    if (Object(result) !== result)
      throw new TypeError("Iterator result is not an object");
    done = !!result.done;
    const { value } = result; // A throwing getter stays a source failure
    answered = true;
    return done && !sendReturn ? quiet(value) : value; // FE-015 awaits nothing it discards
  };
  signal.addEventListener("abort", onAbort);
  try {
    [iterator, next] = open();
    for (;;) {
      if (signal.aborted) return await quietReturn(iterator);
      answered = false;
      const value = await new Promise((resolve, reject) => {
        cancel = resolve;
        pull().then(resolve, reject);
      });
      if (value === ABORTED) return void (done || quietReturn(iterator));
      if (done && value === undefined) return;
      if (backPressure) await channel.asend(value);
      else channel.send(value);
      if (done) return;
    }
  } catch (error) {
    channel.throw(error); // A no-op for this channel's own stop error
    if (answered && !done) await quietReturn(iterator);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export function feed<T, TReturn>(
  source: Source<T>,
  channel: Channel<T, TReturn>,
  options: FeedOptions = {},
): Promise<void> {
  const detected = detect(source);
  if (!detected)
    throw new TypeError("feed source is not a promise or iterator");
  if (!isChannel(channel)) throw new TypeError("feed target is not a Channel");
  checkOptions(options, OPTION_TYPES);
  const {
    autoStart = false,
    autoClose = true,
    backPressure = true,
    sendReturn = false,
  } = options;
  quiet(source);
  const count = runs.get(channel) ?? { active: 0 };
  runs.set(channel, count);
  count.active++;
  return run(
    source,
    detected,
    channel,
    autoStart,
    backPressure,
    sendReturn,
  ).then(() => {
    if (!--count.active && autoClose) channel.close();
  });
}
