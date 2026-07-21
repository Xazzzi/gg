export function noop() {}

export function unreachable(): never {
  throw new Error("Unreachable branch did evaluate");
}

export function narrow<T>(v: unknown): asserts v is T {}

export function isPromise(val: any): val is Promise<any> {
  return typeof val?.then === "function";
}

export function isAsyncIterable(val: any): val is AsyncIterable<any> {
  return typeof val?.[Symbol.asyncIterator] === "function";
}

export function isIterator(
  val: any,
): val is Iterator<any> | AsyncIterator<any> {
  return typeof val?.next === "function";
}
