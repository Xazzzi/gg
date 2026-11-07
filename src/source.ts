// Internal helpers shared by feed, select and catching. Not exported from the package.
export const VAL = Symbol.for("gg.Val");
/** Does nothing, as a default callback and a rejection sink. */
export const noop = () => {};

/** Tells if a value is a function. */
const callable = (value: unknown) => typeof value === "function";

/** Reads `then` from an object or a function, and gives undefined for primitives. */
export const thenOf = (value: any) =>
  (typeof value === "object" && value !== null) || callable(value)
    ? value.then
    : undefined;

/** Tells if a value has a callable `then`. */
export const isThenable = (value: any): value is PromiseLike<unknown> =>
  callable(thenOf(value));

/** Wraps a thenable as an iterator of one value, so it needs no pull path of its own. */
const once = (source: any, then: any) => {
  let pulled = false;
  return {
    next() {
      const done = pulled;
      pulled = true;
      return {
        done,
        value: done
          ? undefined
          : new Promise((resolve, reject) =>
              then.call(source, resolve, reject),
            ),
      };
    },
  };
};

/** Pairs an iterator with its `next` method, read one time. */
const record = (iterator: any): [any, any] => [iterator, iterator.next];

/**
 * Finds how to read a source as a promise, an async iterable, an iterable or an iterator.
 * Runs once per call, and keeps what it read, so a later use never detects again. */
export function detect(
  source: any,
): { stream: boolean; open: () => [any, any] } | undefined {
  if (typeof source === "string") return undefined;
  const then = thenOf(source);
  if (callable(then))
    return { stream: false, open: () => record(once(source, then)) };
  const asyncIterator = source?.[Symbol.asyncIterator];
  if (callable(asyncIterator))
    return { stream: true, open: () => record(asyncIterator.call(source)) };
  const iterator = source?.[Symbol.iterator];
  if (callable(iterator))
    return { stream: true, open: () => record(iterator.call(source)) };
  const next = source?.next;
  return callable(next)
    ? { stream: true, open: () => [source, next] }
    : undefined;
}

/**
 * Splices items into a list in place, and gives the removed items.
 * Array.prototype.splice takes items as arguments, which limits their number. */
export const replace = <V>(
  list: V[],
  start: number,
  count: number,
  items: V[],
) => {
  const rest = list.splice(start),
    removed = rest.splice(0, count);
  for (const item of items.concat(rest)) list.push(item);
  return removed;
};

/** Reorders a list in place, so index `to` takes the old item at `order[to]`. */
export const relocate = <V>(list: V[], order: number[]) => {
  const old = [...list];
  order.forEach((from, to) => {
    list[to] = old[from];
  });
};

/** Throws a `TypeError` for an option that is defined and not of its type. */
export const checkOptions = (options: any, types: Record<string, string>) => {
  for (const key in types) {
    const value = options[key];
    if (value !== undefined && typeof value !== types[key])
      throw new TypeError(`Option ${key} must be a ${types[key]}`);
  }
};

/** Marks a native promise as handled, so its rejection is not reported. */
export const quiet = (value: unknown) => {
  if (value instanceof Promise)
    Promise.prototype.then.call(value, undefined, noop);
};

/**
 * Calls `return()` on an iterator, and ignores what it throws or rejects with.
 * The call happens synchronously, and the promise settles with the iterator's return(). */
export const quietReturn = async (iterator: any) => {
  try {
    await iterator.return(); // A missing method throws here, and is ignored too
  } catch {}
};
