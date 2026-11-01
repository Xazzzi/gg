# Select

This document is self-contained, except that it builds on `Channel` from `channel.md`.
The key words MUST, MUST NOT, SHOULD and MAY are normative.

## Purpose

`select` combines promises, iterators and plain values under one object or array shape.
It publishes a snapshot of the whole shape whenever any source changes.
It also reports each change as an ordered operation, so consumers can replay changes without diffing.
The shape stays mutable, so sources can be added, replaced and removed at any time.
`select` tracks the shape shallowly, and a nested shape needs its own `select`.

## Public API

```ts
export const CHAN: unique symbol;

export type SelectShape = Record<string | symbol, unknown> | readonly unknown[];

export type Val<T> =
  | { status: "pending"; value: undefined; reason: undefined; done: false }
  | { status: "fulfilled"; value: T; reason: undefined; done: boolean }
  | { status: "rejected"; value: undefined; reason: unknown; done: true };

export type Op =
  | { op: "set"; key: string | symbol | number; value: unknown; prev: unknown }
  | { op: "delete"; key: string | symbol; prev: unknown }
  | { op: "splice"; start: number; removed: unknown[]; added: unknown[] }
  | { op: "move"; order: number[] };

export type SelectOptions<S, R> = ChannelOptions & {
  autoStart?: boolean;
  autoClose?: boolean;
  backPressure?: boolean;
  nonYielding?: boolean;
  unwrap?: boolean;
  onChanges?: (ops: Op[]) => void;
  mapSnapshot?: (snapshot: S) => R;
};

export function select<T extends SelectShape, R = Unwrapped<T>>(
  shape: T,
  options: SelectOptions<Unwrapped<T>, R> & { unwrap: true },
): State<T, R, Unwrapped<T>>;

export function select<T extends SelectShape, R = Snapshot<T>>(
  shape: T,
  options?: SelectOptions<Snapshot<T>, R> & { unwrap?: false },
): State<T, R>;
```

`Snapshot<T>` maps each key of `T`.
For an array shape, it is an array of the mapped element union, because SE-090 can change the length.
A source key maps to `Val<Y>`.
`Y` is the source's settled value type, plus its iterator return type, as SE-023 puts a return value in the slot.
A return type of `any`, `void` or `undefined` adds nothing, because SE-024 keeps the last value.
An iterator that finishes with no value falls outside this type, by SE-024.
A plain key keeps its type.

`Unwrapped<T>` is `Snapshot<T>`, with each source key mapped to `Y | undefined`.
An `unwrap` of type `boolean` must be narrowed before the call, so an overload can match.

`State<T, R, O = Snapshot<T>>` is `Mutable<T, O>`, plus `AsyncIterable<R>`, `Disposable` and `{ [CHAN]: Channel<R> }`.
`O` is the snapshot type, which is `Unwrapped<T>` under `unwrap`.
For an array shape, `Mutable<T, O>` is `T[number][]` with `sortOutputs` added and `reverse` overloaded to keep it, because mutators can change the length.
It MUST stay assignable to `T[number][]`, so a function taking that array accepts the state.
The `sortOutputs` comparator takes elements of `O` without `undefined`, and `sort`, `sortOutputs`, `reverse` and `fill` return the same array type.
For an object shape, it is `T`.
It keeps the input types because the proxy reads and writes sources, not states.

## Terms

- **Slot**: one key of the shape, holding a source and a state.
  A slot keeps its identity when array operations move it.
- **Source**: the value assigned to a slot.
- **State**: the slot's current output.
  It is a `Val` for asynchronous sources, and the source itself for plain values.
- **Output**: the state, or with `unwrap` the `value` of an asynchronous slot's `Val`.
  A plain slot holding a `Val` keeps it.
- **Flush**: one publishing step, defined below.
- **Publish**: sending a snapshot to the channel.
- **Pull**: calling `next()` on an iterator.
- **Raw iterator**: an iterator detected through a callable `next`.
- **Async iterator**: an iterator from `Symbol.asyncIterator`, or a raw iterator made async by SE-014.
- **Sync iterator**: a raw iterator made sync by SE-014.
- **Finished**: an iterator has produced `done: true`, or has failed by SE-025.
- **Idle**: a slot's iterator has no pull in progress and has not finished.
- **Reserved key**: `Symbol.asyncIterator`, `Symbol.dispose` or `CHAN`.
- **Terminal**: the channel has been closed or thrown.

## Options

- SE-001: Defaults MUST be `autoStart: false`, `autoClose: true`, `backPressure: true`, `nonYielding: false`, `unwrap: false`.
- SE-002: `thenReceive` MUST default to `"latest"`.
  `firstReceive` MUST default to `"latest"`, or to `"unread"` when `thenReceive` is `"unread"`.
- SE-003: Other `ChannelOptions` MUST pass to the channel unchanged.
- SE-004: `select` MUST NOT mutate `shape`.
  The proxy operates on a shallow copy, which is a plain object or a plain array.
- SE-005: `select` returns a `Proxy`, and `Array.isArray` MUST hold for array shapes.
- SE-006: A `shape` that is not a non-null object MUST make `select` throw a `TypeError` synchronously.
- SE-007: An option value of the wrong type MUST make `select` throw a `TypeError` synchronously.
  `undefined` selects the default.

## Source kinds

Kinds are detected in this order.

| Kind           | Test                                                           |
| -------------- | -------------------------------------------------------------- |
| Promise        | A thenable                                                     |
| Async iterator | Callable `Symbol.asyncIterator`, using the iterator it returns |
| Raw iterator   | Callable `next`                                                |
| Plain          | Anything else, including arrays and strings                    |

- SE-010: Own enumerable string and symbol keys MUST become slots.
  Array shapes use indices only.
  A hole in an array shape MUST become a plain slot holding `undefined`.
- SE-011: A plain slot's state MUST be the value itself.
- SE-012: An asynchronous slot's state MUST start as pending.
- SE-013: An iterator from `Symbol.asyncIterator` MUST be async for its whole life, and each result MUST be awaited.
- SE-014: A raw iterator's first result decides its behaviour.
  A thenable result makes it async for its whole life.
  A non-thenable result makes it sync.
- SE-015: A raw iterator's first pull MUST happen in step 1 of a flush.
  Step 1 MUST repeat for a raw iterator assigned during it, and SE-061 stops a second advance.
- SE-016: Detection MUST run once per assignment, before any write, and an error from it MUST propagate to the caller of `select` or the write.
  Later steps MUST use what it read, and an iterator's `next` MUST be read once.
- SE-017: A write or mutator that throws MUST change nothing.
  A rejection handler attached under SE-034 is not a change.

## States

- SE-020: A settled promise MUST become fulfilled with `done: true`, or rejected.
- SE-021: An iterator result MUST become fulfilled with `done` coerced to a boolean.
  Every result is a state change with a new `Val`, even if its value is equal.
- SE-022: Between results, an iterator slot MUST keep its last state.
- SE-023: A result with `done: true` and a defined value MUST use that value.
- SE-024: A result with `done: true` and `value: undefined` MUST keep the last fulfilled value.
  With no earlier value, it is fulfilled with `undefined`.
  The test runs on the awaited value.
- SE-025: An iterator fails when `next()` throws or rejects, or when a value awaited by SE-027 rejects.
  A result that is not an object MUST fail the iterator with a `TypeError`.
  An error from reading `done`, `value` or a result's `then` fails it too, and no `return()` follows, as in `for await`.
  A thenable result from a sync iterator MUST do the same, and a rejection of that `Promise` MUST NOT become unhandled.
  A failed iterator MUST become rejected, and is not pulled again.
- SE-026: Without `unwrap`, a rejected source MUST NOT fail the channel.
- SE-027: A fulfilled `value` MUST NOT be a thenable.
  A value that is a thenable MUST be awaited first.
  A value whose `then` getter throws counts as a rejecting value, as with `await`.
- SE-028: A `Val` MUST be frozen, and a slot MUST keep the same `Val` object until its state changes.
- SE-029: A `Val` MUST carry a non-enumerable `Symbol.for("gg.Val")` brand.
  `isVal` in `helpers.md` reads this brand, so it works across copies of the library.
- SE-02A: An iterator not yet finished when a value rejects MUST receive `return()` at once, if it has one.
  So MUST a sync iterator failing on a thenable result.
  The run does not await it, and errors from it MUST be ignored.
- SE-02B: Under `unwrap`, a slot finishing by SE-024 MUST produce no snapshot and no operation, because its output is unchanged.
  The flush MUST still run, so auto close happens.
  Other changes in that flush still publish.

## Start

- SE-030: Without `autoStart`, the slots MUST start once the channel has an active consumer.
  This uses `attached(channel)` from `channel.md`, and a rejection from it means no start.
- SE-031: With `autoStart`, the slots MUST start in a microtask queued by `select`.
- SE-032: The first flush MUST run in a microtask after start.
  A `Promise` already settled when assigned before start MUST appear settled in the first snapshot.
  Whether any other promise does is unspecified, because it depends on microtask counts.
- SE-033: Iterators MUST NOT be pulled before start.
- SE-034: A `Promise` source MUST have a rejection handler from assignment, even on a terminal channel.
  Its rejection is therefore never unhandled.
  Its state changes before start are recorded without a flush.
  A `Promise` with its own callable `then` has that `then` called at assignment, and SE-035 applies if it throws.
- SE-035: Other thenables MUST NOT have `then` called before start, or on a terminal channel, because `then` may trigger work.
  If calling `then` throws, the slot MUST become rejected, and SE-055 applies.
- SE-036: `[Symbol.asyncIterator]()` MUST be called at start, or at assignment after start.
  If it throws, or reading `next` on its result throws, the slot MUST become rejected, and SE-055 applies.

## Flush

Changes in one synchronous run MUST share one flush, scheduled as a microtask.
A flush runs these steps in order.

1. Advance idle sync iterators, and make the first pull on each new raw iterator.
2. Report.
3. Publish.
4. With `backPressure`, wait for that publish to be read.
5. Advance each sync iterator due under SE-064.
6. Pull each idle async iterator.
7. Apply the auto close rule.
8. If changes collected during this flush, schedule the next flush.

- SE-040: Report MUST call `onChanges` with the operations since the last report, if `onChanges` exists and there are operations.
- SE-041: Without `nonYielding`, publish MUST build a snapshot, apply `mapSnapshot`, and send it.
  SE-02B skips steps 3 and 4 for a flush with no other change.
- SE-042: With `backPressure` it MUST use `asend`, otherwise `send`.
- SE-043: At most one flush MUST run at a time.
  A change during step 1 belongs to that flush.
  Changes made from step 2 onward MUST collect for the next flush.
  A snapshot shows the slots at publish, so it can include a change that the next flush reports.
- SE-044: An async iterator MUST have at most one pull in progress.
- SE-045: With `nonYielding`, a flush MUST NOT build a snapshot, and steps 3 and 4 are skipped.
  `mapSnapshot` is unused.
- SE-046: A flush MUST stop if the channel is terminal.
  It MUST check before each step, and before each iterator in steps 1, 5 and 6.

## Snapshots

- SE-050: A snapshot MUST be a new shallow copy of all outputs, in slot order.
  It is a plain array for an array shape, and a plain object otherwise.
- SE-051: An unchanged slot MUST keep the same reference across snapshots.
- SE-052: `mapSnapshot` MUST be synchronous, because a thenable result fails by CH-013.
- SE-053: `unwrap` MUST output `value` for a fulfilled `Val`, and `undefined` for a pending one.
- SE-054: The snapshot is sent as a channel value, so a snapshot with a callable `then` key fails by CH-013.
- SE-055: With `unwrap`, a slot turning rejected MUST call `channel.throw` with the unchanged reason.
  A rejection before start takes effect at start.

## Sync iterators

- SE-060: A flush MUST advance an idle sync iterator once, before the snapshot.
- SE-061: A flush MUST skip an iterator whose state changed since the previous flush reached step 2.
  Assigning an iterator to a slot does not count as a change here.
- SE-062: An iterator with a pending yielded promise MUST NOT be advanced.
- SE-063: A yielded promise MUST set the slot's result when it settles.
- SE-064: The flush that reports that result MUST advance the iterator once, in step 5.
- SE-065: A plain value from SE-064 MUST schedule one flush, and SE-061 stops further advances.
- SE-066: A rejected yielded promise MUST follow SE-025 and SE-02A.

## Auto close

- SE-070: With `autoClose`, step 7 MUST close the channel if no source can still change a slot.
  SE-071 to SE-075 define this.
- SE-071: Pending promises and unfinished async iterators MUST keep the channel open.
- SE-072: A sync iterator with a pending yielded promise MUST keep the channel open.
- SE-073: An idle sync iterator MUST NOT keep the channel open, so it may never finish.
- SE-074: A shape with no such sources MUST close after its first flush.
- SE-075: Collected changes, a pending flush or a pending `asend` MUST keep the channel open.

## Proxy

- SE-080: Reading a key MUST return the source assigned to it, not its state.
  A key with no slot MUST read through to the prototype.
- SE-081: `ownKeys` and `getOwnPropertyDescriptor` MUST reflect the current slots.
  `has` MUST return true for slots, reserved keys and inherited keys.
- SE-082: `Symbol.asyncIterator` MUST iterate the channel.
- SE-083: `Symbol.dispose` MUST close the channel.
- SE-084: `CHAN` MUST return the channel.
  `CHAN` MUST be `Symbol.for("gg.CHAN")`, so it works across copies of the library.
- SE-085: Assigning or deleting a reserved key MUST throw a `TypeError`.
- SE-086: Assigning a key MUST replace its source, or add a slot.
- SE-087: Assigning the `Object.is` same source MUST do nothing.
  This includes writing the current `length`.
- SE-088: Replacing a source MUST reset the state as SE-011 and SE-012 define.
- SE-089: `delete` MUST remove an object slot.
  On an array, it MUST assign `undefined` to an index below `length`.
  Deleting a missing key or an index at or past `length` MUST do nothing.
  Deleting `length` MUST fail as on an `Array`, so the trap returns false.
- SE-08A: On a terminal channel, writes and mutators MUST succeed on the proxy without tracking, flushing or reopening.
  SE-034, SE-085, SE-095, SE-098, SE-099, SE-09A and SE-09F still apply, and take precedence.
  No detection runs, except the `Promise` check of SE-034.
- SE-08B: An own reserved key in `shape`, enumerable or not, MUST make `select` throw a `TypeError` synchronously.
- SE-08C: `defineProperty`, `preventExtensions` and `setPrototypeOf` on the proxy MUST throw a `TypeError`.
  The `set` trap therefore MUST NOT pass the proxy as the receiver to `Reflect.set`.

## Arrays

- SE-090: `push`, `pop`, `shift`, `unshift`, `splice`, `sort`, `sortOutputs`, `reverse`, `fill`, `copyWithin` and `length` writes MUST move slots, not rebuild them.
  Reading a mutator MUST return one stable function per proxy, not the `Array.prototype` method.
- SE-091: Mutators MUST return what the matching `Array` method returns, using sources.
- SE-092: A slot's updates MUST reach its current index after any move.
- SE-093: A removed slot's updates MUST be ignored.
- SE-095: Assigning a non-index key other than `length` MUST throw a `TypeError`.
- SE-096: Assigning an index at or past `length` MUST grow the array, and any skipped index MUST become a plain slot holding `undefined`.
- SE-097: A mutator call that changes nothing MUST produce no operation and no flush.
  Adding a source a mutator just removed counts as a change, and restarts it.
- SE-098: A `length` write MUST follow `Array` semantics, including a `RangeError` for an invalid length.
- SE-099: `sort` MUST order slots by their sources, and return the proxy.
  Like `Array.prototype.sort`, it is stable, puts `undefined` last without calling the comparator, and compares strings with no comparator.
  A comparator that is neither a function nor `undefined` MUST throw a `TypeError`, and a comparator that throws MUST change nothing.
- SE-09A: Changing the shape while a comparator runs MUST throw a `TypeError`.
- SE-09B: `reverse` MUST reverse the slots, and return the proxy.
- SE-09C: `sort`, `sortOutputs` and `reverse` MUST move slots without restarting them, and MUST produce one `move`.
  An order that changes nothing falls under SE-097.
- SE-09D: `fill` MUST follow `Array` range rules, return the proxy, and act as one `splice` of the range.
  Each slot in the range gets the source, and SE-132 applies to an iterator.
  An empty range changes nothing, but SE-034 still applies to the source.
- SE-09E: `copyWithin` MUST follow `Array` range rules, return the proxy, and act as one `splice` of the target range using the copied sources.
  A copy onto the same index MUST change nothing, by SE-097.
  A copied slot restarts as pending, and SE-132 applies to an iterator.
- SE-09F: `sortOutputs` MUST follow SE-099, except that it orders slots by their outputs.
  An output is a slot's snapshot entry, a `Val` or under `unwrap` a value, before `mapSnapshot`.
  The order is a one-off, so later updates MUST NOT move slots.
  On a terminal channel it MUST throw a `TypeError`, because slots have no outputs to compare.
  `"sortOutputs" in state` MUST hold for an array shape.

## Operation log

- SE-100: Operations MUST appear in the order changes happened.
- SE-101: Operations MUST NOT be merged.
- SE-102: `value`, `prev`, `removed` and `added` MUST hold outputs.
- SE-103: A state change, an assignment to an object key, or an assignment to an index below `length` MUST produce `set`, except under SE-02B.
  A new object key has `prev: undefined`.
  On an array, `key` MUST be a number.
- SE-104: `delete` on an object MUST produce `delete`.
- SE-105: Every array structure change other than SE-09C MUST produce one `splice`.
  `push` and SE-096 use `start` equal to the old length.
  `length` growth and skipped indices add `undefined` entries.
- SE-106: Each operation's indices MUST use the array as it stood after the previous operation.
  In a `move`, `order[to]` is the index `from` that the slot at `to` held before the operation.
- SE-107: The first report MUST start by describing the whole shape as it stood at start.
  Objects get one `set` per key, with `prev: undefined`.
  A non-empty array gets one `splice` with `start: 0`.
  An empty shape gets no operation.
  Changes before start MUST NOT produce their own operations.
- SE-108: After each report, replaying all operations reported so far onto an empty object or array MUST equal the outputs at that report.
- SE-109: `onChanges` MUST run on every flush with changes, even if consumers skip snapshots.
- SE-10A: Without `onChanges`, the library MUST NOT build operations.
- SE-10B: Changes not yet reported when the channel turns terminal MUST NOT be reported.

## Errors

- SE-110: If `onChanges` or `mapSnapshot` throws, the channel MUST receive `throw` with that error.
- SE-111: A failed send of a thenable snapshot MUST do the same.
- SE-112: A `StopError` from its own channel while publishing MUST end the flush quietly.
- SE-113: A flush MUST NOT produce an unhandled rejection.

## Ownership and cleanup

- SE-120: When the channel turns terminal, every unfinished iterator in a slot MUST receive `return()` if it has one.
- SE-121: Errors from that `return()` MUST be ignored.
- SE-122: Removing a source from a slot returns it to the caller, and it MUST NOT be closed.
- SE-124: A pending promise or pull from a removed source MUST be ignored, and MUST NOT cause an unhandled rejection.
  This includes an ignored result whose `value` is a rejecting `Promise`.
- SE-125: If the channel turns terminal before start, SE-120 applies only if the source itself has `return`.
  An `AsyncIterable` without `return` is left untouched.
- SE-126: After terminal, results and rejections from promises and pulls MUST be discarded, and MUST NOT cause an unhandled rejection.
  This includes a discarded result whose `value` is a rejecting `Promise`.

## Limits

These behaviours follow from the rules above and are intentional.

- SE-130: With `backPressure` and no consumer, flushes stop at step 4, so async iterators stay unpulled.
  Use `autoStart` with `nonYielding` or `backPressure: false` for sources that must run unattended.
- SE-131: `break` in a consumer does not close the channel.
  Use `using` or close the channel to stop `select`.
- SE-132: Slots sharing an iterator share its cursor, so each value reaches one slot, in pull order.
  A `Channel` in several slots opens one reader per slot, so each slot reads every value.
  `fill` and `copyWithin` can create this sharing, and SE-122 leaves any iterator they overwrite open.
- SE-133: With `autoStart`, `backPressure` and a late `firstReceive: "next"` consumer, the first publish is never read.
  The flush stays at step 4 until the channel turns terminal.
- SE-134: With `stopStyle: "stop"` and `backPressure: false`, auto close can drop the final snapshot by CH-065.
- SE-135: A consumer that stops calling `next()` holds the flush at step 4, with `backPressure`.
  `onChanges` then stops running, and operations collect without bound.
- SE-136: A value pulled for a removed slot or a terminal channel is lost.
  With a `thenReceive: "unread"` channel as the source, that item never reaches another worker.
  A caller calling `next()` on a removed iterator gets the value after the one in progress.
- SE-137: With `backPressure: false` or `nonYielding`, an always-ready async source runs on microtasks alone and starves the event loop.
- SE-138: `Array.prototype` mutators applied with `.call` bypass SE-090 and SE-09C.
  Each of their writes then follows the rules for index and `length` writes.
- SE-139: Each index is a slot, so a huge `length` exhausts memory, unlike a sparse `Array`.
- SE-13A: Objects inheriting from the proxy are unsupported, and a write through one is unspecified.

## Examples

Default states, with a pending promise:

```ts
const p = Promise.withResolvers<number>();
const s = select({ a: 42, b: p.promise });
const it = s[Symbol.asyncIterator]();
await it.next(); // { a: 42, b: { status: "pending", ... } }
p.resolve(1);
await it.next(); // { a: 42, b: { status: "fulfilled", value: 1, ... } }
await it.next(); // { done: true }
```

Plain outputs, where a rejection fails the channel:

```ts
const s = select({ user: fetchUser() }, { unwrap: true });
for await (const { user } of s) render(user); // undefined, then the user
```

Plain outputs, where one source may fail quietly:

```ts
const s = select(
  { user: fetchUser(), ads: catching(fetchAds(), log) },
  { unwrap: true },
);
```

Replay array changes onto DOM nodes:

```ts
const s = select([] as Row[], {
  nonYielding: true,
  autoClose: false,
  autoStart: true,
  onChanges: ops => ops.forEach(applyToDom),
});
await null; // Start has run
s.push(rowA, rowB); // { op: "splice", start: 0, removed: [], added: [rowA, rowB] }
s.shift(); // { op: "splice", start: 0, removed: [rowA], added: [] }
s.push(rowC);
s.reverse(); // { op: "move", order: [1, 0] }
```
