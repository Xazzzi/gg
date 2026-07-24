export type Callback = (value?: unknown) => void;

export function noop() {}

export function unreachable(): never {
  throw new Error("Unreachable branch did evaluate");
}

export function isPromise(v: any): v is Promise<any> {
  return typeof v?.then === "function";
}

export function isAsyncIterable(v: any): v is AsyncIterable<any> {
  return typeof v?.[Symbol.asyncIterator] === "function";
}

export function isIterator(v: any): v is Iterator<any> | AsyncIterator<any> {
  return typeof v?.next === "function";
}

/** Prepends a value into an iterator. */
export function unsend<T, It extends AsyncIterator<T>>(
  iter: It,
  result?: typeof isError extends true
    ? ReturnType<NonNullable<It["throw"]>>
    : ReturnType<It["next"]> | ReturnType<NonNullable<It["return"]>>,
  // Stryker disable next-line BooleanLiteral: default parameter is only used internally where result is undefined so isError branch is never hit
  isError = false,
  callback?: Callback,
) {
  const originalNext = iter.next;
  const originalThrow = iter.throw;
  const originalReturn = iter.return;
  iter.next = (v?: any) => {
    callback?.();
    iter.next = originalNext;
    // Stryker disable all: proactive unwrapping is an untestable optimization since the wrappers transparently delegate
    if (originalThrow) iter.throw = originalThrow;
    if (originalReturn) iter.return = originalReturn;
    // Stryker restore all
    return result ? result : iter.next(v);
  };
  if (originalThrow)
    iter.throw = (e?: any) => {
      callback?.();
      iter.next = originalNext;
      iter.throw = originalThrow;
      // Stryker disable next-line all: proactive unwrapping optimization
      if (originalReturn) iter.return = originalReturn;
      return result && isError ? result : iter.throw(e);
    };
  if (originalReturn)
    iter.return = (v?: any) => {
      callback?.();
      iter.next = originalNext;
      // Stryker disable next-line all: proactive unwrapping optimization
      if (originalThrow) iter.throw = originalThrow;
      iter.return = originalReturn;
      return iter.return(v);
    };
}

export function findInMap<K, V = unknown>(
  map: Map<K, V>,
  v: V,
  hint?: K,
): K | undefined {
  // Stryker disable next-line ConditionalExpression: hint is purely a performance optimization for finding elements in the map, so disabling it doesn't change logical output
  if (hint && map.get(hint) === v) return hint;
  for (const [k, it] of map.entries()) if (v === it) return k;
}

export function moveInMap<K>(map: Map<K, any>, from: K, to: K): boolean {
  const move = map.has(from);
  if (move) {
    map.set(to, map.get(from));
    map.delete(from);
  }
  return move;
}
