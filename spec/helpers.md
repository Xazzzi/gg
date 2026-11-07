# Helpers

`isVal` and `spread` in this document use `Val` from `select.md`.
`applyOps` uses `Op` from `select.md`.
`Channel`, `feed` and `select` MUST NOT require callers to use a helper.
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
The package root exports the helpers.
So a bundler can remove unused helpers.

## abortable

`abortable` waits for a promise until a signal aborts.
Use it for APIs that have no signal support.
It does not cancel the underlying work.

- HE-001: `abortable` MUST settle as `promise` settles if `signal` did not abort.
- HE-002: `abortable` MUST reject with `signal.reason` when `signal` aborts first.
- HE-003: If `signal` aborted already, `abortable` MUST reject with `signal.reason`.
  It MUST NOT call `then` on a thenable that is not a `Promise`, because `then` can start work.
- HE-004: `abortable` MUST remove its abort listener when it settles.
  So a loop over one long-lived signal retains nothing per pass.
- HE-005: A later rejection of a `Promise` MUST NOT cause an `unhandledRejection`.

## catching

`catching` wraps a source.
On a failure, the wrapper calls `onError` and finishes with no error (HE-014).
The wrapped source is a normal source for `feed` and `select`.

A **pull** is a call of `next()` on the inner iterator, and the await of the result and of its value (HE-013).

A **failure** occurs when a thenable source rejects, `next()` throws or rejects, or a value that HE-013 awaits rejects.
A `next()` result that is not an object is also a failure, with a `TypeError`.
A call of `Symbol.asyncIterator` or `Symbol.iterator` that throws is also a failure.
A read of `next` on the iterator that throws is also a failure.
These two failures occur at the first `next()`.
A read of `done` or `value` on a result that throws is also a failure.
No `return()` follows this failure, as in `for await`.

- HE-010: `catching` requires `onError`.
  So each failure reaches code that the caller supplied.
  If `onError` is not a function, `catching` MUST throw a `TypeError` synchronously.
- HE-011: `catching` MUST detect source kinds in this order:
  thenable, `Symbol.asyncIterator`, `Symbol.iterator`, callable `next`.
  For a primitive string or any other value, `catching` MUST throw a `TypeError` synchronously.
- HE-012: A thenable source MUST yield one value.
- HE-013: `catching` MUST await each value before it yields the value.
  It MUST await a return value before the wrapper finishes.
- HE-014: On a failure, `catching` MUST call and await `onError` one time with the unchanged error.
  The wrapper MUST then finish.
- HE-015: If `onError` throws or rejects, that error MUST reject the pending `next()`.
- HE-016: If a value rejects and the inner iterator did not finish, `catching` MUST also call `return()` on the iterator.
  It does not await that `return()`.
  It MUST ignore errors from that `return()`.
- HE-017: The wrapper MUST finish with the return value of the source.
- HE-018: `return()` MUST forward to the inner iterator immediately, also before the first `next()` and during a pending `next()`.
  Before the first `next()`, this applies only if the source itself has `return`.
  `return()` MUST settle as the inner `return()` settles.
  If there is no inner `return()`, it MUST resolve with `{ done: true, value }`.
  A thenable source has no iterator.
  So `catching` MUST NOT call its `return`.
- HE-019: A `Promise` source MUST have a rejection handler from the `catching` call.
  `catching` MUST NOT call `then` on other thenables before the first `next()`.
- HE-01A: During `return()`, a pending `next()` MUST resolve with `{ done: true, value: undefined }`.
  It MUST NOT wait for the inner pull.
  `catching` MUST discard a late result or failure from that pull.
  `onError` MUST NOT run for that pull.
  A discarded result with a `value` that is a rejecting `Promise` MUST NOT cause an `unhandledRejection`.
  If `onError` is running, `return()` MUST NOT wait for it.
  HE-014 and HE-015 then apply to the pending `next()`.
- HE-01B: After the wrapper finishes, `next()` MUST resolve with `{ done: true, value: undefined }`.
  `return(value)` MUST resolve with `{ done: true, value }`.
- HE-01C: `next()` calls that overlap MUST run in order, with one pull at a time.
- HE-01D: `Caught` has no `throw` method.
- HE-01E: Detection MUST run one time, at the `catching` call.
  An error from detection MUST propagate to the caller.
  Later steps MUST use the values that detection read.
  `catching` MUST read the `next` of an iterator one time.

The body of an async generator does not run on an early `return()`.
Its `return()` also goes in a queue behind a pending `next()`.
So HE-018 and HE-01A do not permit a plain `async function*` wrapper.

A wrapped sync source becomes an async iterator.
In `select`, it follows the async rules and not SE-060 and SE-073.
So `select` pulls it freely.
It also keeps the channel open.

## isVal

- HE-020: `isVal` MUST return true for a `Val` from any copy of the library.
  It MUST return false for all other values.
  It reads the brand from SE-029.
  So a plain object with the same fields is not a `Val`.

## spread

`spread` is a pure snapshot projection for UI code.
The usual use is `mapSnapshot: spread`.

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

If a key is only sometimes a `Val`, `Spread` gives it no suffix fields.
HE-031 still adds the fields when the key holds a `Val`.

- HE-030: `spread` MUST NOT change its input.
- HE-031: For an object snapshot, a `Val` at key `k` MUST become four fields:
  `k` with the value, `kLoading`, `kError` and `kDone`.
- HE-032: `kLoading` MUST be true when the `Val` has status `pending`.
  `kError` MUST be `reason` when the `Val` has status `rejected`, and `null` otherwise.
  `kDone` MUST be `done`.
  A rejection with reason `null` looks like no error in `kError`.
  If this is a problem, read the `Val`.
- HE-033: For an array snapshot, a `Val` MUST become `{ value, loading, error, done }` at the same index.
  `spread` MUST freeze this object.
  For one `Val`, it MUST be the same object across calls.
- HE-034: `spread` MUST copy other values unchanged.
- HE-035: `spread` MUST copy a symbol key that holds a `Val` unchanged, because a suffix cannot apply.
- HE-036: If a generated field name collides with another field, `spread` MUST throw a `TypeError`.
- HE-037: If a snapshot is not a non-null object, `spread` MUST return it unchanged.

```ts
const { promise, resolve } = Promise.withResolvers<number>();
const s = select({ p: promise }, { mapSnapshot: spread });
const it = s[Symbol.asyncIterator]();
(await it.next()).value; // => { p: undefined, pLoading: true, pError: null, pDone: false }
resolve(42);
(await it.next()).value; // => { p: 42, pLoading: false, pError: null, pDone: true }
```

## applyOps

`applyOps` replays the operations from `onChanges` or from a reader of `changes` onto a mirror.
A **mirror** is an object or array that holds one entry for each output of the shape.
By default, it is lazy.
One call first computes the combined result of its operations.
`map` then runs only for entries that stay in `target`.
An array value that leaves and comes back in one call keeps its entry, so `map` does not run for it.
With `eager: true`, `applyOps` applies each operation in turn.
`map` then also runs for values that a later operation overwrites.
`map` changes each output into the entry to store.
So a mirror can hold derived values, such as DOM nodes.
Without `map`, `applyOps` stores each output unchanged.

- HE-040: `applyOps` MUST apply `ops` to `target` in order and in place.
  It MUST return `target`.
  An empty mirror replayed from the first report MUST equal the outputs (SE-108).
- HE-041: Under `eager`, `set` MUST store `map(value, prev)`.
  `prev` is the own entry at that key, or `undefined` if there is none.
- HE-042: Under `eager`, `delete` MUST remove the key.
  It MUST NOT call `map`.
- HE-043: Under `eager`, `splice` MUST call `map` one time for each added value, in order, before it changes `target`.
  `prev` MUST be the removed entry at the same index, or `undefined` past the removed range.
- HE-044: `splice` MUST accept any number of added values, also more than a function call can take as arguments.
- HE-045: Under `eager`, `move` MUST place the entry from index `order[i]` at index `i`.
  It MUST NOT call `map`.
- HE-046: A `__proto__` key MUST stay an own entry.
  It MUST NOT change the prototype of `target`.
- HE-047: `applyOps` MUST throw a `TypeError` if `target` is not an object.
  It MUST throw a `TypeError` if `map` is not a function and not `undefined`.
  It MUST throw a `TypeError` for an operation that does not fit `target` (HE-04F).
- HE-048: Under `eager`, an error from `map` MUST propagate.
  The current operation MUST stay unapplied.
  Earlier operations MUST stay applied.
- HE-049: If `options.eager` is not a boolean and not `undefined`, `applyOps` MUST throw a `TypeError`.
- HE-04A: Without `eager`, the final `target` MUST equal an eager replay of the same `ops` with the same `map` results, including key order.
  For a value that reuses an entry (HE-04H), the `map` result is that entry.
- HE-04B: Without `eager`, `map` MUST run one time for each value that stays in place after all `ops` and reuses no entry, and for no other value.
  For an array, it MUST run in index order.
  For an object, it MUST run in final key order among the written keys.
- HE-04C: Without `eager`, `prev` MUST be the entry that the position or key inherited from before the call.
  For an array, HE-04H defines what a position inherits.
  If there is no such entry, `prev` MUST be `undefined`.
  A `move` takes the inherited entry with it to the new position.
  A key that one operation removes and a later operation sets inherits its old entry.
  One entry MUST be `prev` at most one time.
- HE-04D: Without `eager`, `map` MUST run before `target` changes.
  So any error MUST leave `target` unchanged.
- HE-04E: Without `eager`, `applyOps` MUST NOT write an index with an unchanged entry.
- HE-04F: Only `splice`, `move` and `set` with an index as a number `key` fit an array target.
  Only `set` and `delete` fit other targets.
  An unknown operation fits no target.
  Under `eager`, the operations before a misfit stay applied.
- HE-04G: `applyOps` MUST treat a hole in `target` as an entry that holds `undefined`.
  `map` MUST NOT run for a hole, because a hole is not an output.
  The result MAY have a hole or an `undefined` entry at that index.
  HE-04A treats these two as equal.
  `select` produces no holes (SE-010, SE-096).
- HE-04H: Without `eager`, a value that lands in an array MUST take over at most one value that leaves, and a leaving value MUST be taken over at most one time.
  A `set` value takes over the value at its index.
  A `splice` value first takes over the first value that left by a `splice` in the same call with the `Object.is` same output, in leaving order.
  Otherwise it takes over the value that it removes at its own index, if no other value took that over.
  The value at a position after all `ops` traces back through what it took over to an entry from before the call.
  If the output of that entry is the `Object.is` same value, the value MUST reuse that entry, with no `map` call.
  Otherwise that entry is `prev`.
  So a `splice` that keeps values, such as a filter, moves their entries and calls no `map`.

`applyOps` writes `target` with plain assignment and array methods.
So a reactive array or object sees each change.
A read-only view, such as `node.children`, cannot be a target.
Lazy replay covers one call, which is one report or one read.
It costs one pass over an array target.

```ts
import { setImmediate } from "node:timers/promises";
const rows: { user: unknown }[] = [];
const users = select(["ann", "bob"], {
  autoStart: true,
  autoClose: false,
  nonYielding: true,
  onChanges: ops =>
    applyOps(rows, ops, (user, row) => Object.assign(row ?? {}, { user })),
});
await setImmediate();
users.reverse();
await setImmediate();
rows; // => [ { user: 'bob' }, { user: 'ann' } ]
```
