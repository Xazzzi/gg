import { Channel, type ChannelOptions } from "./channel.ts";
import {
  isAsyncIterable,
  isIterator,
  isPromise,
} from "./utils.ts";

type State<T> =
  | { status: "pending" }
  | { status: "fulfilled"; value: T; done?: boolean }
  | { status: "rejected"; reason: unknown };

type Vals<T> = T extends
  | Promise<infer U>
  | AsyncIterable<infer U>
  | AsyncIterator<infer U>
  | Iterator<infer U>
  ? State<U>
  : T;

type ValsOf<T extends Record<keyof any, any>> = {
  [K in keyof T]: Vals<T[K]>;
};

export type SelectOptions = {
  autoClose?: boolean;
  holdDone?: boolean;
  changeValues?: boolean;
  onChanges?: (changes: unknown) => void;
};

export function select<T extends Record<keyof any, unknown> | unknown[]>(
  shape: T,
  {
    autoClose = true,
    holdDone = true,
    changeValues = false,
    onChanges,
    ...channelOptions
  }: SelectOptions & ChannelOptions = {},
): Channel<ValsOf<T>> {
  const ch = new Channel<ValsOf<T>>(channelOptions);
  const isArray = Array.isArray(shape);
  const aiter = new Map<any, AsyncIterator<unknown>>();
  const siter = new Map<any, Iterator<unknown>>();
  const next = new Map<any, Promise<unknown>>();
  const vals: any = isArray ? [] : {};
  const changes = onChanges && changeValues ? new Map() : new Set();

  let queued: boolean;

  const checkClose = () => {
    if (autoClose && next.size === 0 && !queued) ch.close();
  };

  const setval = (key: keyof any, value: unknown) => {
    if (changeValues) (changes as Map<any, any>).set(key, vals[key]);
    else (changes as Set<any>).add(key);
    vals[key] = value;
  };

  const handleAsyncNext = (
    iterMap: Map<any, any> | null,
    key: string,
    iterPromise: Promise<IteratorResult<unknown>>,
  ) => {
    let self: Promise<unknown>;
    if (!Object.hasOwn(vals, key)) setval(key, { status: "pending" });
    next.set(
      key,
      (self = iterPromise.then(
        res => {
          if (next.get(key) !== self) return;
          // For sync iters yielding promises, most recent ones win
          setval(key, {
            ...res,
            status: "fulfilled",
            value:
              holdDone && res.done && res.value === undefined
                ? (vals[key] as any).value
                : res.value,
          });
          if (res.done && iterMap) iterMap.delete(key);
          next.delete(key);
          notify();
        },
        reason => {
          if (next.get(key) !== self) return;
          // For sync iters yielding promises, most recent ones win
          setval(key, { status: "rejected", reason });
          iterMap?.delete(key);
          next.delete(key);
          notify();
        },
      )),
    );
  };

  const pullAsync = (key: string) => {
    try {
      // biome-ignore lint/style/noNonNullAssertion: called sync by loop over aiter
      const promise = aiter.get(key)!.next();
      handleAsyncNext(aiter, key, promise);
    } catch (reason) {
      setval(key, { status: "rejected", reason });
      aiter.delete(key);
      notify();
    }
  };

  const pullSync = (key: string) => {
    try {
      // biome-ignore lint/style/noNonNullAssertion: called sync by loop over siter
      const res = siter.get(key)!.next();
      if (isPromise(res)) {
        // AsyncIterable in siters, move it where it belongs
        aiter.set(key, siter.get(key) as any);
        siter.delete(key);
        handleAsyncNext(aiter, key, res);
      } else if (isPromise(res.value)) {
        handleAsyncNext(
          siter,
          key,
          res.value.then(value => ({ ...res, value })),
        );
      } else {
        setval(key, {
          status: "fulfilled",
          value:
            holdDone && res.done && res.value === undefined
              ? (vals[key] as any).value
              : res.value,
          done: res.done,
        });
        if (res.done) siter.delete(key);
      }
    } catch (reason) {
      setval(key, { status: "rejected", reason });
      siter.delete(key);
      next.delete(key);
    }
  };

  const emit = async () => {
    queued = false;
    if (ch.signal.aborted) return;
    // (sync)Iterators driven whenever emit triggers
    for (const key of siter.keys()) !changes.has(key) && pullSync(key);
    const changesSnapshot = Object.fromEntries(changes.entries());
    changes.clear();
    onChanges?.(changesSnapshot); // should set before consumers see the update
    await ch.asend(isArray ? [...vals] : { ...vals });
    // AsyncIterators driven after read from a channel actually happens
    for (const key of aiter.keys()) !next.has(key) && pullAsync(key);
    checkClose();
  };

  const notify = () => queued || ((queued = true), queueMicrotask(emit));

  for (const [key, val] of Object.entries(shape)) {
    // Initially place both AsyncIterator and (sync)Iterator into siter map.
    // First emit will drive them once, then move to aiter map.
    if (isAsyncIterable(val)) {
      const inst = val[Symbol.asyncIterator]();
      siter.set(key, inst as any);
    } else if (isIterator(val)) {
      siter.set(key, val as any);
    } else if (isPromise(val)) {
      handleAsyncNext(
        null,
        key,
        val.then(value => ({ value })),
      );
    } else {
      vals[key] = val;
    }
  }

  emit(); // first value to come alive

  return ch;
}
