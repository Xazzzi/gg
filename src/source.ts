// Internal helpers shared by feed, select and catching. Not exported from the package.
export const VAL = Symbol.for("gg.Val");
export const noop = () => {};

const callable = (value: unknown) => typeof value === "function";

export const thenOf = (value: any) =>
  (typeof value === "object" && value !== null) || callable(value)
    ? value.then
    : undefined;

export const isThenable = (value: any): value is PromiseLike<unknown> =>
  callable(thenOf(value));

// A thenable acts as an iterator of one value, so it needs no pull path of its own.
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

const record = (iterator: any): [any, any] => [iterator, iterator.next];

// Runs once per call, and keeps what it read, so a later use never detects again.
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

// Array.prototype.splice takes items as arguments, which limits their number.
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

export const relocate = <V>(list: V[], order: number[]) => {
  const old = [...list];
  order.forEach((from, to) => {
    list[to] = old[from];
  });
};

export const checkOptions = (options: any, types: Record<string, string>) => {
  for (const key in types) {
    const value = options[key];
    if (value !== undefined && typeof value !== types[key])
      throw new TypeError(`Option ${key} must be a ${types[key]}`);
  }
};

export const quiet = (value: unknown) => {
  if (value instanceof Promise)
    Promise.prototype.then.call(value, undefined, noop);
};

// The call happens synchronously, and the promise settles with the iterator's return().
export const quietReturn = async (iterator: any) => {
  try {
    await iterator.return(); // A missing method throws here, and is ignored too
  } catch {}
};
