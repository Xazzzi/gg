# Select

This document uses `Channel` from `channel.md`.
The key words MUST, MUST NOT, SHOULD and MAY are normative.

## Purpose

`select` combines promises, iterators and plain values under one object or array shape.
It publishes a snapshot of the whole shape when a source changes.
It also reports each change as an ordered operation.
So consumers can replay changes and need no diff.
The shape stays mutable.
So code can add, replace and remove sources at any time.
`select` tracks only the top level of the shape.
A nested shape needs its own `select`.

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
`Y` is the settled value type of the source, plus its iterator return type, because SE-023 puts a return value in the slot.
A return type of `any`, `void` or `undefined` adds nothing, because SE-024 keeps the last value.
An iterator that finishes with no value is outside this type (SE-024).
A plain key keeps its type.

`Unwrapped<T>` is `Snapshot<T>`, with each source key mapped to `Y | undefined`.
Narrow an `unwrap` of type `boolean` before the call, so that an overload can match.

`State<T, R, O = Snapshot<T>>` is `Mutable<T, O>`, plus `AsyncIterable<R>`, `Disposable` and `{ [CHAN]: Channel<R> }`.
`O` is the snapshot type, which is `Unwrapped<T>` under `unwrap`.
For an array shape, `Mutable<T, O>` is `T[number][]` plus `sortOutputs`.
It uses `T[number][]` because mutators can change the length.
It also overloads `reverse` to keep `sortOutputs`.
It MUST stay assignable to `T[number][]`, so that a function that takes that array accepts the state.
The `sortOutputs` comparator gets elements of `O` without `undefined`.
`sort`, `sortOutputs`, `reverse` and `fill` return the same array type.
For an object shape, it is `T`.
It keeps the input types because the proxy reads and writes sources, not states.

## Terms

- **Slot**: one key of the shape, with a source and a state.
  A slot keeps its identity when array operations move it.
- **Source**: the value assigned to a slot.
- **State**: the slot's current output.
  It is a `Val` for an asynchronous slot, and the source itself for a plain slot.
- **Output**: the state, or with `unwrap` the `value` of an asynchronous slot's `Val`.
  A plain slot that holds a `Val` keeps that `Val`.
- **Plain slot**: a slot with a source of the kind Plain.
- **Asynchronous slot**: a slot with a source of any other kind.
- **Write**: an assignment through the proxy to a key or to `length`.
- **Mutator**: the proxy method `push`, `pop`, `shift`, `unshift`, `splice`, `sort`, `sortOutputs`, `reverse`, `fill` or `copyWithin`.
- **Flush**: one publish cycle, defined in the Flush section.
- **Publish**: a send of a snapshot to the channel.
- **Pull**: a call of `next()` on an iterator, and the await of the result and of its value.
- **Raw iterator**: an iterator that `select` detects by a callable `next`.
- **Async iterator**: an iterator from `Symbol.asyncIterator`, or a raw iterator that SE-014 makes async.
- **Sync iterator**: a raw iterator that SE-014 makes sync.
- **Finished**: an iterator produced `done: true`, or failed (SE-025).
- **Idle**: a slot's iterator has no pull in progress and did not finish.
- **Reserved key**: `Symbol.asyncIterator`, `Symbol.dispose` or `CHAN`.
- **Terminal**: the state of a channel after its first `close` or `throw` call.

## Options

- SE-001: The defaults MUST be `autoStart: false`, `autoClose: true`, `backPressure: true`, `nonYielding: false`, `unwrap: false`.
- SE-002: `thenReceive` MUST default to `"latest"`.
  `firstReceive` MUST default to `"latest"`, or to `"unread"` when `thenReceive` is `"unread"`.
- SE-003: `select` MUST pass other `ChannelOptions` to the channel unchanged.
- SE-004: `select` MUST NOT change `shape`.
  The proxy operates on a shallow copy, which is a plain object or a plain array.
- SE-005: `select` returns a `Proxy`.
  `Array.isArray` MUST return true for an array shape.
- SE-006: If `shape` is not a non-null object, `select` MUST throw a `TypeError` synchronously.
- SE-007: For an option value of the wrong type, `select` MUST throw a `TypeError` synchronously.
  `undefined` selects the default.

## Source kinds

`select` detects kinds in this order.

| Kind           | Test                                                           |
| -------------- | -------------------------------------------------------------- |
| Promise        | A thenable                                                     |
| Async iterator | Callable `Symbol.asyncIterator`, using the iterator it returns |
| Raw iterator   | Callable `next`                                                |
| Plain          | Anything else, including arrays and strings                    |

- SE-010: Own enumerable string and symbol keys MUST become slots.
  An array shape uses indices only.
  A hole in an array shape MUST become a plain slot that holds `undefined`.
- SE-011: A plain slot's state MUST be the value itself.
- SE-012: An asynchronous slot's state MUST start as pending.
- SE-013: An iterator from `Symbol.asyncIterator` MUST be async for its full life.
  `select` MUST await each result.
- SE-014: The first result of a raw iterator sets its behaviour.
  A thenable result makes it async for its full life.
  A non-thenable result makes it sync.
- SE-015: The first pull of a raw iterator MUST occur in step 1 of a flush.
  Step 1 MUST repeat for a raw iterator assigned during step 1.
  SE-061 prevents a second advance.
- SE-016: Detection MUST run one time per assignment, before any write.
  An error from detection MUST propagate to the caller of `select` or the write.
  Later steps MUST use the values that detection read.
  `select` MUST read the `next` of an iterator one time.
- SE-017: A write or mutator that throws MUST change nothing.
  A rejection handler that SE-034 adds is not a change.

## States

- SE-020: A settled promise MUST become fulfilled with `done: true`, or rejected.
- SE-021: An iterator result MUST become fulfilled with `done` coerced to a boolean.
  Each result is a state change with a new `Val`, even if its value is equal.
- SE-022: Between results, an iterator slot MUST keep its last state.
- SE-023: A result with `done: true` and a defined value MUST use that value.
- SE-024: A result with `done: true` and `value: undefined` MUST keep the last fulfilled value.
  If there is no earlier value, the slot becomes fulfilled with `undefined`.
  This test uses the awaited value.
- SE-025: An iterator fails when `next()` throws or rejects, or when a value that SE-027 awaits rejects.
  A result that is not an object MUST fail the iterator with a `TypeError`.
  An error from a read of `done`, `value` or the `then` of a result also fails the iterator.
  No `return()` follows that error, as in `for await`.
  A thenable result from a sync iterator MUST also fail the iterator.
  A rejection of that `Promise` MUST NOT become unhandled.
  The slot of a failed iterator MUST become rejected.
  `select` does not pull the iterator again.
- SE-026: Without `unwrap`, a rejected source MUST NOT fail the channel.
- SE-027: A fulfilled `value` MUST NOT be a thenable.
  `select` MUST await a thenable value first.
  A value with a `then` getter that throws is a rejecting value, as with `await`.
- SE-028: `select` MUST freeze each `Val`.
  A slot MUST keep the same `Val` object until its state changes.
- SE-029: A `Val` MUST carry a non-enumerable `Symbol.for("gg.Val")` brand.
  `isVal` in `helpers.md` reads this brand.
  So it operates across copies of the library.
- SE-02A: If an iterator did not finish when a value rejects, it MUST get `return()` immediately, if it has `return`.
  A sync iterator that fails on a thenable result MUST also get `return()`.
  `select` does not await that `return()`.
  It MUST ignore errors from that `return()`.
- SE-02B: Under `unwrap`, a slot with an iterator that finishes under SE-024 MUST produce no snapshot and no operation, because its output does not change.
  The flush MUST still run.
  So auto close occurs.
  Other changes in that flush still publish.

## Start

- SE-030: Without `autoStart`, the slots MUST start when the channel has an active consumer.
  This uses `attached(channel)` from `channel.md`.
  A rejection from `attached` means no start.
- SE-031: With `autoStart`, the slots MUST start in a microtask queued by `select`.
- SE-032: The first flush MUST run in a microtask after start.
  If code assigns a settled `Promise` before start, it MUST show as settled in the first snapshot.
  This spec does not define whether any other promise shows as settled, because this depends on microtask counts.
- SE-033: `select` MUST NOT pull iterators before start.
- SE-034: A `Promise` source MUST have a rejection handler from assignment, also on a terminal channel.
  So its rejection is never unhandled.
  `select` records the state changes of that `Promise` before start, without a flush.
  `select` calls the own callable `then` of a `Promise` at assignment.
  SE-035 applies if that call throws.
- SE-035: `select` MUST NOT call `then` on other thenables before start or on a terminal channel, because `then` can start work.
  If the `then` call throws, the slot MUST become rejected.
  SE-055 then applies.
- SE-036: `select` MUST call `[Symbol.asyncIterator]()` at start, or at assignment after start.
  If this call or a read of `next` on its result throws, the slot MUST become rejected.
  SE-055 then applies.

## Flush

All changes in one synchronous run MUST share one flush.
`select` schedules that flush as a microtask.
A flush runs these steps in order.

1. Advance idle sync iterators, and make the first pull on each new raw iterator.
2. Report.
3. Publish.
4. With `backPressure`, wait until a consumer reads that publish.
5. Advance each sync iterator due under SE-064.
6. Pull each idle async iterator.
7. Apply the auto close rule.
8. If changes collected during this flush, schedule the next flush.

- SE-040: Report MUST call `onChanges` with the operations since the last report, if `onChanges` exists and there are operations.
- SE-041: Without `nonYielding`, publish MUST build a snapshot.
  It MUST then apply `mapSnapshot` and send the result.
  SE-02B skips steps 3 and 4 for a flush with no other change.
- SE-042: With `backPressure`, publish MUST use `asend`.
  Otherwise it MUST use `send`.
- SE-043: At most one flush MUST run at a time.
  A change during step 1 belongs to that flush.
  Changes from step 2 onward MUST collect for the next flush.
  A snapshot shows the slots at publish.
  So it can include a change that the next flush reports.
- SE-044: An async iterator MUST have at most one pull in progress.
- SE-045: With `nonYielding`, a flush MUST NOT build a snapshot.
  Steps 3 and 4 do not run.
  `select` does not call `mapSnapshot`.
- SE-046: A flush MUST do no more steps if the channel is terminal.
  It MUST check before each step, and before each iterator in steps 1, 5 and 6.

## Snapshots

- SE-050: A snapshot MUST be a new shallow copy of all outputs, in slot order.
  It is a plain array for an array shape, and a plain object otherwise.
- SE-051: An unchanged slot MUST keep the same reference across snapshots.
- SE-052: `mapSnapshot` MUST be synchronous, because a thenable result fails (CH-013).
- SE-053: `unwrap` MUST output `value` for a fulfilled `Val`, and `undefined` for a pending one.
- SE-054: A snapshot is a channel value.
  So a snapshot with a callable `then` key fails (CH-013).
- SE-055: With `unwrap`, a slot that becomes rejected MUST call `channel.throw` with the unchanged reason.
  A rejection before start has its effect at start.

## Sync iterators

- SE-060: A flush MUST advance an idle sync iterator one time, before the snapshot.
- SE-061: A flush MUST skip an iterator if its state changed after the previous flush reached step 2.
  An assignment of an iterator to a slot does not count as a change here.
- SE-062: A flush MUST NOT advance an iterator with a pending yielded promise.
- SE-063: A yielded promise MUST set the slot's result when it settles.
- SE-064: The flush that reports that result MUST advance the iterator one time, in step 5.
- SE-065: A plain value from SE-064 MUST schedule one flush.
  SE-061 prevents more advances.
- SE-066: A rejected yielded promise MUST follow SE-025 and SE-02A.

## Auto close

- SE-070: With `autoClose`, step 7 MUST close the channel if no source can still change a slot.
  SE-071 to SE-075 define this condition.
- SE-071: Pending promises and unfinished async iterators MUST keep the channel open.
- SE-072: A sync iterator with a pending yielded promise MUST keep the channel open.
- SE-073: An idle sync iterator MUST NOT keep the channel open, because it can stay unfinished forever.
- SE-074: A shape with no such sources MUST close after its first flush.
- SE-075: Collected changes, a pending flush or a pending `asend` MUST keep the channel open.

## Proxy

- SE-080: A read of a key MUST return the source assigned to that key, not its state.
  A read of a key with no slot MUST return what the prototype gives.
- SE-081: `ownKeys` and `getOwnPropertyDescriptor` MUST reflect the current slots.
  `has` MUST return true for slots, reserved keys and inherited keys.
- SE-082: `Symbol.asyncIterator` MUST iterate the channel.
- SE-083: `Symbol.dispose` MUST close the channel.
- SE-084: `CHAN` MUST return the channel.
  `CHAN` MUST be `Symbol.for("gg.CHAN")`.
  So it operates across copies of the library.
- SE-085: An assignment to a reserved key or a `delete` of a reserved key MUST throw a `TypeError`.
- SE-086: An assignment to a key MUST replace its source, or add a slot.
- SE-087: An assignment of the `Object.is` same source MUST do nothing.
  This includes a write of the current `length`.
- SE-088: A source replacement MUST reset the state as SE-011 and SE-012 define.
- SE-089: `delete` MUST remove an object slot.
  On an array, it MUST assign `undefined` to an index below `length`.
  A `delete` of a missing key, or of an index at or past `length`, MUST do nothing.
  A `delete` of `length` MUST fail as on an `Array`.
  So the trap returns false.
- SE-08A: On a terminal channel, writes and mutators MUST succeed on the proxy, with no tracking, no flush and no reopen.
  SE-034, SE-085, SE-095, SE-098, SE-099, SE-09A and SE-09F still apply.
  They have priority over this rule.
  No detection runs, except the `Promise` check of SE-034.
- SE-08B: If `shape` has an own reserved key, enumerable or not, `select` MUST throw a `TypeError` synchronously.
- SE-08C: `defineProperty`, `preventExtensions` and `setPrototypeOf` on the proxy MUST throw a `TypeError`.
  So the `set` trap MUST NOT pass the proxy as the receiver to `Reflect.set`.

## Arrays

- SE-090: Mutators and `length` writes MUST move slots, not rebuild them.
  A read of a mutator MUST return one stable function per proxy, not the `Array.prototype` method.
- SE-091: Mutators other than `sortOutputs` MUST return what the matching `Array` method returns, using sources.
- SE-092: A slot's updates MUST reach its current index after any move.
- SE-093: `select` MUST discard updates of a removed slot.
- SE-095: An assignment to a non-index key other than `length` MUST throw a `TypeError`.
- SE-096: An assignment to an index at or past `length` MUST grow the array.
  Each skipped index MUST become a plain slot that holds `undefined`.
- SE-097: A mutator call that changes nothing MUST produce no operation and no flush.
  A mutator that removes a source and adds it again makes a change.
  That source restarts.
- SE-098: A `length` write MUST follow `Array` semantics, including a `RangeError` for an invalid length.
- SE-099: `sort` MUST order slots by their sources.
  It MUST return the proxy.
  As `Array.prototype.sort` does, it is stable.
  It compares strings if there is no comparator.
  It puts `undefined` last.
  It does not call the comparator for `undefined`.
  A comparator that is not a function and not `undefined` MUST throw a `TypeError`.
  A comparator that throws MUST change nothing.
- SE-09A: A shape change during a comparator run MUST throw a `TypeError`.
- SE-09B: `reverse` MUST reverse the slots.
  It MUST return the proxy.
- SE-09C: `sort`, `sortOutputs` and `reverse` MUST move slots.
  They MUST NOT restart slots.
  They MUST produce one `move`.
  If the order does not change, SE-097 applies.
- SE-09D: `fill` MUST follow `Array` range rules.
  It MUST return the proxy.
  It MUST act as one `splice` of the range.
  Each slot in the range gets the source.
  SE-132 applies to an iterator.
  An empty range changes nothing, but SE-034 still applies to the source.
- SE-09E: `copyWithin` MUST follow `Array` range rules.
  It MUST return the proxy.
  It MUST act as one `splice` of the target range with the copied sources.
  A copy onto the same index MUST change nothing (SE-097).
  A copied slot restarts as pending.
  SE-132 applies to an iterator.
- SE-09F: `sortOutputs` MUST follow SE-099.
  It MUST order slots by their outputs, before `mapSnapshot`.
  The order applies one time.
  So later updates MUST NOT move slots.
  On a terminal channel, it MUST throw a `TypeError`.
  The reason is that `select` does not track writes on a terminal channel (SE-08A).
  So slots can differ from the proxy.
  `"sortOutputs" in state` MUST return true for an array shape.

## Operation log

- SE-100: Operations MUST appear in the order of the changes.
- SE-101: `select` MUST NOT merge operations.
- SE-102: `value`, `prev`, `removed` and `added` MUST hold outputs.
- SE-103: A state change, an assignment to an object key, or an assignment to an index below `length` MUST produce `set`.
  SE-02B is the exception.
  A new object key has `prev: undefined`.
  On an array, `key` MUST be a number.
- SE-104: `delete` on an object MUST produce `delete`.
- SE-105: Each array structure change other than SE-09C MUST produce one `splice`.
  `push` and SE-096 use `start` equal to the old length.
  `length` growth and skipped indices add `undefined` entries.
- SE-106: The indices of each operation MUST refer to the array after the previous operation.
  In a `move`, the slot at `to` after the operation came from index `order[to]`.
- SE-107: The first report MUST start with a description of the whole shape at start.
  An object gets one `set` per key, with `prev: undefined`.
  A non-empty array gets one `splice` with `start: 0`.
  An empty shape gets no operation.
  Changes before start MUST NOT produce their own operations.
- SE-108: After each report, replaying all operations reported so far onto an empty object or array MUST equal the outputs at that report.
- SE-109: `onChanges` MUST run on each flush with changes, even if consumers skip snapshots.
- SE-10A: Without `onChanges`, the library MUST NOT build operations.
- SE-10B: `select` MUST discard the operations that no report contains when the channel becomes terminal.

## Errors

- SE-110: If `onChanges` or `mapSnapshot` throws, `select` MUST call `channel.throw` with that error.
- SE-111: A failed send of a thenable snapshot MUST do the same.
- SE-112: After a `StopError` from its own channel during publish, the flush MUST do no more steps.
  That error MUST have no other effect.
- SE-113: A flush MUST NOT produce an unhandled rejection.

## Ownership and cleanup

- SE-120: When the channel becomes terminal, each unfinished iterator in a slot MUST get `return()`, if it has `return`.
- SE-121: `select` MUST ignore errors from that `return()`.
- SE-122: The removal of a source from a slot returns the source to the caller.
  `select` MUST NOT call `return()` on that source.
- SE-124: `select` MUST discard the results and rejections of a pending promise or pull from a removed source.
  They MUST NOT cause an unhandled rejection.
  This includes a discarded result with a `value` that is a rejecting `Promise`.
- SE-125: If the channel becomes terminal before start, SE-120 applies only if the source itself has `return`.
  `select` does not touch an `AsyncIterable` without `return`.
- SE-126: After the channel is terminal, `select` MUST discard results and rejections from promises and pulls.
  They MUST NOT cause an unhandled rejection.
  This includes a discarded result with a `value` that is a rejecting `Promise`.

## Limits

These behaviours come from the rules above and are intentional.

- SE-130: With `backPressure` and no consumer, a flush blocks at step 4.
  So `select` does not pull async iterators.
  Use `autoStart` with `nonYielding` or `backPressure: false` for sources that need to run without a consumer.
- SE-131: `break` in a consumer does not close the channel.
  Close the channel, for example with `using`.
  `select` then does no more work.
- SE-132: Slots that share an iterator share its position.
  So one slot gets each value, in pull order.
  A `Channel` in many slots gets one consumer per slot.
  So each slot reads each value.
  `fill` and `copyWithin` can create this sharing.
  `select` does not call `return()` on an iterator that they overwrite (SE-122).
- SE-133: With `autoStart`, `backPressure` and a late `firstReceive: "next"` consumer, no consumer ever reads the first publish.
  The flush blocks at step 4 until the channel becomes terminal.
- SE-134: With `stopStyle: "stop"` and `backPressure: false`, auto close can discard the final snapshot (CH-065).
- SE-135: With `backPressure`, a flush blocks at step 4 while a consumer makes no `next()` call.
  `select` does not call `onChanges` during that time.
  Operations collect with no limit.
- SE-136: `select` discards a value that it pulled for a removed slot or a terminal channel.
  If the source is a `thenReceive: "unread"` channel, no other consumer gets that value.
  If a caller calls `next()` on a removed iterator, the caller gets the value after the value in progress.
- SE-137: With `backPressure: false` or `nonYielding`, an async source with results that are always ready executes on microtasks only.
  So the event loop executes no macrotask while that source has results.
- SE-138: `Array.prototype` mutators applied with `.call` do not follow SE-090 and SE-09C.
  Each of their writes then follows the rules for index and `length` writes.
- SE-139: Each index is a slot.
  So a huge `length` can use all memory, unlike a sparse `Array`.
- SE-13A: The library does not support objects that inherit from the proxy.
  This spec does not define a write through such an object.

## Examples

Default states, with a pending promise:

```ts
const p = Promise.withResolvers<number>();
const s = select({ a: 42, b: p.promise });
const it = s[Symbol.asyncIterator]();
(await it.next()).value; // => { a: 42, b: { status: 'pending', value: undefined, reason: undefined, done: false } }
p.resolve(1);
(await it.next()).value; // => { a: 42, b: { status: 'fulfilled', value: 1, reason: undefined, done: true } }
await it.next(); // => { value: undefined, done: true } (SE-070)
```

Plain outputs, where a rejection fails the channel:

```ts
const fetchUser = async () => "ann";
const s = select({ user: fetchUser() }, { unwrap: true });
for await (const { user } of s) console.log(user); // => ann
```

Plain outputs, where a failure of one source does not fail the channel:

```ts
const fetchUser = async () => "ann";
const fetchAds = async () => {
  throw new Error("offline");
};
const log = (error: unknown) => console.log(`${error}`);
const s = select(
  { user: fetchUser(), ads: catching(fetchAds(), log) },
  { unwrap: true },
);
for await (const snapshot of s) console.log(snapshot); // => { user: 'ann', ads: undefined }, Error: offline
```

Replay array changes onto DOM nodes:

```ts
import { setImmediate } from "node:timers/promises";
const s = select([] as string[], {
  nonYielding: true,
  autoClose: false,
  autoStart: true,
  onChanges: ops => console.log(...ops),
});
await null; // Start has run
s.push("a", "b");
await setImmediate(); // => { op: 'splice', start: 0, removed: [], added: [ 'a', 'b' ] }
s.shift();
await setImmediate(); // => { op: 'splice', start: 0, removed: [ 'a' ], added: [] }
s.push("c");
s.reverse();
await setImmediate(); // => { op: 'splice', start: 1, removed: [], added: [ 'c' ] } { op: 'move', order: [ 1, 0 ] }
```
