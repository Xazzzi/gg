# Helpers

This document is self-contained, except that `isVal` and `spread` build on `Val`, and `applyOps` on `Op`, from `select.md`.
`Channel`, `feed` and `Select` MUST NOT require callers to use a helper.
The key words MUST, MUST NOT, SHOULD and MAY are normative.

## Public API

```ts
export function abortable<T>(
  promise: PromiseLike<T>,
  signal: AbortSignal,
): Promise<T>;

export interface Caught<T> extends AsyncIterableIterator<T, unknown, void> {
  return(value?: unknown): Promise<IteratorResult<T, unknown>>;
}

export function catching<T>(
  source: Source<T>,
  onError: (error: unknown) => void | PromiseLike<void>,
): Caught<T>;

export function isVal(value: unknown): value is Val<unknown>;
export function spread<S>(snapshot: S): Spread<S>;

type Entry<T> = T extends readonly (infer V)[] ? V : T[keyof T];

export function applyOps<T extends object>(
  target: T,
  ops: readonly Op[],
  map?: (value: unknown, prev: Entry<T> | undefined) => Entry<T>,
  options?: { eager?: boolean },
): T;
```

`Source<T>` is any of `PromiseLike<T>`, `AsyncIterable<T>`, `AsyncIterator<T>`, `Iterable<T>`, `Iterator<T>`.
Helpers are exported from the package root, so unused helpers can be tree-shaken.

## abortable

`abortable` waits for a promise until a signal aborts.
It suits APIs without signal support.
It does not cancel the underlying work.

- HE-001: It MUST settle as `promise` settles if `signal` has not aborted.
- HE-002: It MUST reject with `signal.reason` when `signal` aborts first.
- HE-003: If `signal` is already aborted, it MUST reject with `signal.reason`.
  It MUST NOT call `then` on a thenable that is not a `Promise`, because `then` may trigger work.
- HE-004: It MUST remove its abort listener once it settles.
  A loop over one long-lived signal therefore retains nothing per pass.
- HE-005: A later rejection of a `Promise` MUST NOT cause an `unhandledRejection`.

## catching

`catching` wraps a source so that a failure ends it quietly.
The wrapped source is a normal source for `feed` and `Select`.

A **failure** is a thenable source rejecting, `next()` throwing or rejecting, or a value awaited by HE-013 rejecting.
A `next()` result that is not an object is also a failure, with a `TypeError`.
So is an error from calling `Symbol.asyncIterator` or `Symbol.iterator`, or from reading `next` on the iterator, which happens at the first `next()`.
So is an error from reading `done` or `value` on a result, and no `return()` follows, as in `for await`.

- HE-010: `onError` is required, so swallowing an error is always explicit.
  A non-function `onError` MUST make `catching` throw a `TypeError` synchronously.
- HE-011: Source kinds MUST be detected in this order:
  thenable, `Symbol.asyncIterator`, `Symbol.iterator`, callable `next`.
  A primitive string or any other value MUST make `catching` throw a `TypeError` synchronously.
- HE-012: A thenable source MUST yield one value.
- HE-013: Each value MUST be awaited before it is yielded, and a return value MUST be awaited before it finishes the wrapper.
- HE-014: On a failure, it MUST call and await `onError` once with the unchanged error, then finish.
- HE-015: If `onError` throws or rejects, that error MUST reject the pending `next()`.
- HE-016: If a value rejects and the inner iterator has not finished, the iterator MUST also receive `return()`.
  That `return()` is not awaited, and errors from it MUST be ignored.
- HE-017: It MUST finish with the source's return value.
- HE-018: `return()` MUST forward to the inner iterator at once, including before the first `next()` and during a pending `next()`.
  Before the first `next()`, this applies only if the source itself has `return`.
  It MUST settle as the inner `return()` settles, and resolve with `{ done: true, value }` if there is none.
  A thenable source has no iterator, so its `return` MUST NOT be called.
- HE-019: A `Promise` source MUST have a rejection handler from the `catching` call.
  Other thenables MUST NOT have `then` called before the first `next()`.
- HE-01A: During `return()`, a pending `next()` MUST resolve with `{ done: true, value: undefined }`, without waiting for the inner pull.
  A late result or failure from that pull MUST be discarded, and `onError` MUST NOT run.
  A discarded result whose `value` is a rejecting `Promise` MUST NOT cause an `unhandledRejection`.
  If `onError` is already running, `return()` MUST NOT wait for it, and the pending `next()` follows HE-014 and HE-015.
- HE-01B: After it finishes, `next()` MUST resolve with `{ done: true, value: undefined }`, and `return(value)` with `{ done: true, value }`.
- HE-01C: Overlapping `next()` calls MUST run in order, one pull at a time.
- HE-01D: `Caught` has no `throw` method.
- HE-01E: Detection MUST run once, at the `catching` call, and an error from it MUST propagate to the caller.
  Later steps MUST use what it read, and an iterator's `next` MUST be read once.

An async generator body does not run on an early `return()`, and its `return()` queues behind a pending `next()`.
HE-018 and HE-01A therefore rule out a plain `async function*` wrapper.

Wrapping a sync source makes it an async iterator.
In `select`, it then follows the async rules, not SE-060 and SE-073, so it is pulled freely and keeps the channel open.

## isVal

- HE-020: `isVal` MUST return true for a `Val` from any copy of the library, and false for all other values.
  It reads the brand from SE-029, so a plain object with the same fields is not a `Val`.

## spread

`spread` is a pure snapshot projection for UI code.
It is typically passed as `mapSnapshot: spread`.

```ts
type ValKeys<S> = {
  [K in keyof S]-?: K extends string
    ? S[K] extends Val<any>
      ? K
      : never
    : never;
}[keyof S];

type Vals<V> = Extract<V, Val<any>>;
type Plain<V> = Exclude<V, Val<any>>;
type Fulfilled<V> = V extends { status: "fulfilled"; value: infer Y }
  ? Y
  : never;
type ValueOf<V> = Fulfilled<Vals<V>> | undefined;

type SpreadItem<V> =
  | Plain<V>
  | ([Vals<V>] extends [never]
      ? never
      : { value: ValueOf<V>; loading: boolean; error: unknown; done: boolean });

type SpreadField<V> =
  | Plain<V>
  | ([Vals<V>] extends [never] ? never : ValueOf<V>);

export type Spread<S> = S extends readonly unknown[]
  ? { [K in keyof S]: SpreadItem<S[K]> }
  : { [K in keyof S]: SpreadField<S[K]> } & {
      [K in ValKeys<S> as `${K}Loading`]: boolean;
    } & { [K in ValKeys<S> as `${K}Error`]: unknown } & {
      [K in ValKeys<S> as `${K}Done`]: boolean;
    };
```

A key that is only sometimes a `Val` gets no suffix fields in `Spread`, though HE-031 still adds them when it holds one.

- HE-030: It MUST NOT mutate its input.
- HE-031: For an object snapshot, a `Val` at key `k` MUST become four fields:
  `k` with the value, `kLoading`, `kError` and `kDone`.
- HE-032: `kLoading` MUST be true when pending, `kError` MUST be `reason` when rejected and `null` otherwise, and `kDone` MUST be `done`.
  A rejection with reason `null` looks like no error in `kError`, so read the `Val` if that matters.
- HE-033: For an array snapshot, a `Val` MUST become `{ value, loading, error, done }` at the same index.
  For one `Val`, this object MUST be frozen, and MUST be the same object across calls.
- HE-034: Other values MUST be copied unchanged.
- HE-035: Symbol keys holding a `Val` MUST be copied unchanged, because a suffix cannot apply.
- HE-036: A generated field name that collides with another field MUST make `spread` throw a `TypeError`.
- HE-037: A snapshot that is not a non-null object MUST be returned unchanged.

```ts
const s = select({ p: promise }, { mapSnapshot: spread });
// { p: undefined, pLoading: true, pError: null, pDone: false }
// { p: 42, pLoading: false, pError: null, pDone: true }
```

## applyOps

`applyOps` replays the operations from `onChanges` onto a mirror of the shape.
It is lazy by default, so one call folds its operations first and `map` runs only for entries that land in `target`.
With `eager: true`, each operation applies in turn and `map` runs for values a later operation overwrites.
`map` turns each incoming output into the entry to store, so a mirror can hold derived values such as DOM nodes.
Without `map`, each output is stored as it is.

- HE-040: It MUST apply `ops` to `target` in order, in place, and return `target`.
  An empty mirror replayed from the first report MUST equal the outputs, as SE-108 requires.
- HE-041: Under `eager`, `set` MUST store `map(value, prev)`, where `prev` is the own entry at that key, or `undefined` if there is none.
- HE-042: Under `eager`, `delete` MUST remove the key, and MUST NOT call `map`.
- HE-043: Under `eager`, `splice` MUST call `map` once per added value, in order, before changing `target`.
  `prev` MUST be the removed entry at the same index, or `undefined` past the removed range.
- HE-044: `splice` MUST accept any number of added values, including more than a call can take as arguments.
- HE-045: Under `eager`, `move` MUST place the entry from index `order[i]` at index `i`, and MUST NOT call `map`.
- HE-046: A `__proto__` key MUST stay an own entry, and MUST NOT change the prototype of `target`.
- HE-047: It MUST throw a `TypeError` if `target` is not an object, if `map` is given and is not a function, or if an operation is unknown.
  Under `eager`, a `splice` or `move` on a target that is not an array MUST throw a `TypeError`.
- HE-048: Under `eager`, an error from `map` MUST propagate, leave the current operation unapplied and keep earlier operations applied.
- HE-049: `options.eager` MUST be a boolean when given, or `applyOps` MUST throw a `TypeError`.
- HE-04A: Without `eager`, `target` MUST end equal to an eager replay of the same `ops` with the same `map` results, including key order.
- HE-04B: Without `eager`, `map` MUST run once for each value still in place after all `ops`, and for no other value.
  It MUST run in index order for an array, and in final key order among the written keys for an object.
- HE-04C: Without `eager`, `prev` MUST be the entry from before the call that the position or key inherited, or `undefined` if there is none.
  A moved entry carries its position, and a key removed and set again inherits its old entry.
  One entry MUST reach `prev` at most once.
- HE-04D: Without `eager`, `map` MUST run before `target` changes, so any error MUST leave `target` untouched.
- HE-04E: Without `eager`, an index whose entry did not change MUST NOT be written.
- HE-04F: Without `eager`, an operation that does not fit `target`, including `delete` on an array, MUST throw a `TypeError`.

`target` is written through plain assignment and array methods, so a reactive array or object sees each change.
Read-only views such as `node.children` cannot be a target.
Lazy folding spans one call, which is one `onChanges` report, and costs one pass over an array target.

```ts
const rows: Row[] = [];
const state = select(users, {
  unwrap: true,
  onChanges: ops =>
    applyOps(rows, ops, (user, row) => row?.update(user) ?? new Row(user)),
});
```
