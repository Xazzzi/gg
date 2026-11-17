// Internal helpers shared by feed, select and catching. Not exported from the package.
export const VAL = Symbol.for("gg.Val");
/** Does nothing, as a default callback and a rejection sink. */
export const noop = () => {};
// Marks a source whose readers each get its newest value, so one read can serve all derives of it (HE-05A).
export const SHARE: unique symbol = Symbol() as any;

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

// The kinds of source that detect finds.
export const PLAIN = 0,
  PROMISE = 1,
  ASYNC = 2,
  RAW = 3,
  ITERABLE = 4;
export type Detected = { kind: number; method?: any };

/**
 * Finds the kind of a source, and keeps the method that it read, so a later use never reads it again (SE-016).
 * Only iterables reads `Symbol.iterator`, because select keeps an iterable such as an array as a plain value. */
export const detect = (source: any, iterables = false): Detected => {
  const then = thenOf(source);
  if (callable(then)) return { kind: PROMISE, method: then };
  const asyncIterator = source?.[Symbol.asyncIterator];
  if (callable(asyncIterator)) return { kind: ASYNC, method: asyncIterator };
  const iterator = iterables ? source?.[Symbol.iterator] : undefined;
  if (callable(iterator)) return { kind: ITERABLE, method: iterator };
  const next = source?.next;
  return callable(next) ? { kind: RAW, method: next } : { kind: PLAIN };
};

/** Finds how feed and catching read a source, which is not a string and not a plain value. */
export const detectStream = (source: unknown) => {
  if (typeof source === "string") return undefined;
  const detected = detect(source, true);
  return detected.kind === PLAIN ? undefined : detected;
};

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

/** Opens a detected source as an iterator and its `next` method, read one time. */
export const open = (source: any, { kind, method }: Detected): [any, any] => {
  if (kind === RAW) return [source, method];
  const iterator =
    kind === PROMISE ? once(source, method) : method.call(source);
  return [iterator, iterator.next];
};

// The most items that one call takes as arguments, because a larger spread overflows the stack.
const CHUNK = 1024;
/** Hands items to use in parts of at most CHUNK items, so each part can be spread into one call. */
export const chunked = <V>(
  items: readonly V[],
  use: (part: V[]) => unknown,
) => {
  // Stryker disable next-line ConditionalExpression,EqualityOperator: the parts give the same calls, with one copy
  if (items.length <= CHUNK) return void use(items as V[]);
  // Stryker disable next-line EqualityOperator: one more part is empty, and use adds nothing for it
  for (let at = 0; at < items.length; at += CHUNK)
    use(items.slice(at, at + CHUNK));
};
/** Appends items to a list in place, in chunked spreads. */
export const append = <V>(list: V[], items: readonly V[]) =>
  chunked(items, part => list.push(...part));

/**
 * Splices items into a list in place, and gives the removed items.
 * Array.prototype.splice takes items as arguments, which limits their number. */
export const replace = <V>(
  list: V[],
  start: number,
  count: number,
  items: V[],
) => {
  // Stryker disable next-line ConditionalExpression,EqualityOperator: the appends give the same list, with more copies
  if (items.length <= CHUNK) return list.splice(start, count, ...items);
  const rest = list.splice(start),
    removed = rest.splice(0, count);
  append(list, items);
  append(list, rest);
  return removed;
};

/** Reorders a list in place, so index `to` takes the old item at `order[to]`. */
export const relocate = <V>(list: V[], order: number[]) => {
  const old = [...list];
  order.forEach((from, to) => {
    list[to] = old[from];
  });
};

/** Throws a `TypeError` for an own enumerable string key of options that names no option. */
export const checkKeys = (options: any, ...known: object[]) => {
  for (const key of Object.keys(options))
    if (!known.some(names => Object.hasOwn(names, key)))
      throw new TypeError(`Unknown option ${key}`);
};

/** Throws a `TypeError` for an unknown option, and for an option that is defined and not of its type. */
export const checkOptions = (
  options: any,
  types: Record<string, string>,
  others: object = types,
) => {
  checkKeys(options, types, others);
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
 * Calls `return()` on an iterator, if it has one, and hands what it throws or rejects with to onError.
 * The call happens synchronously, and the promise settles with the iterator's return(). */
export const quietReturn = async (
  iterator: any,
  onError: (error: unknown) => void = noop,
) => {
  try {
    const close = iterator.return;
    if (typeof close === "function") await close.call(iterator);
  } catch (error) {
    onError(error);
  }
};

// The stop functions of what code builds now, while a builder runs.
let built: (() => void)[] | undefined;
/** Runs make, and gives its result with the stop functions of the elements that it builds (HE-059). */
export const building = <R>(make: () => R): [R, (() => void)[]] => {
  const outer = built,
    list: (() => void)[] = (built = []);
  try {
    const made = make();
    built = outer;
    return [made, list];
  } catch (error) {
    built = outer;
    for (const stop of list) stop(); // A make that throws gives no output to own them
    throw error;
  }
};
/** Records what stops a thing that code builds now, if a builder runs. */
export const record = (stop: () => void) => built?.push(stop);
