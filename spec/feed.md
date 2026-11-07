# Feed

This document uses `Channel` from `channel.md`.
An implementation made from these two documents MUST be complete and valid.
The key words MUST, MUST NOT, SHOULD and MAY are normative.

## Purpose

`feed` moves values from one source into an existing channel.
Many `feed` calls can use one channel.
This merges their sources.

## Public API

```ts
export type Source<T> =
  | PromiseLike<T>
  | AsyncIterable<T>
  | AsyncIterator<T>
  | Iterable<T>
  | Iterator<T>;

export type FeedOptions = {
  autoStart?: boolean;
  autoClose?: boolean;
  backPressure?: boolean;
  sendReturn?: boolean;
};

export function feed<T, TReturn>(
  source: Source<T>,
  channel: Channel<T, TReturn>,
  options?: FeedOptions,
): Promise<void>;
```

With `sendReturn: true`, the caller guarantees that the return value has type `T`.
The types do not check this.
`Iterable<string>` accepts a primitive string at compile time.
FE-014 rejects it at runtime.

## Terms

- **Run**: one `feed` call, from the call until its last use of the source.
- **Active run**: a run that did not end, including a run that waits to start.
- **Start**: the time when a run can pull for the first time.
- **Pull**: a request for the next value from a source, and the await of the result and of its value (FE-013).
- **Stream source**: any source other than a thenable.
- **Exhausted**: a stream source produced `done: true`, or a thenable source fulfilled.
- **Source failure**: a thenable source rejects, or `next()` throws or rejects.
  A `next()` result that is not an object is also a source failure, with a `TypeError`.
  A call of `Symbol.asyncIterator` or `Symbol.iterator` at start that throws is also a source failure.
  A read of `next` on the iterator that throws is also a source failure.
  A read of `done` or `value` on a result that throws is also a source failure.
- **Value failure**: a value that FE-013 awaits rejects.
  The stream source did not finish at that time, unless the value is a return value (FE-016).
  A `send` or `asend` error other than the stop error is also a value failure.
- **Usage error**: a call that cannot work with any source.
- **Early end**: a run ends because the channel is terminal, and its source is not exhausted.

## Options

- FE-001: The defaults MUST be `autoStart: false`, `autoClose: true`, `backPressure: true`, `sendReturn: false`.
- FE-002: `feed` MUST NOT add methods to `Channel`.
- FE-003: An option value of the wrong type MUST make `feed` throw a `TypeError` synchronously.
  `undefined` selects the default.

## Source handling

- FE-010: `feed` MUST detect source kinds in this order:
  thenable, `Symbol.asyncIterator`, `Symbol.iterator`, callable `next`.
- FE-011: For any other source, `feed` MUST throw a `TypeError` synchronously.
  No run exists.
  So the channel and the source do not change.
- FE-012: A thenable source MUST deliver one value, including `undefined`.
- FE-013: `feed` MUST await each pulled value before it sends that value.
  So a sync iterator that yields promises delivers the settled values.
- FE-014: A primitive string is not a source.
  It MUST follow FE-011.
  This rule has priority over `Symbol.iterator` detection.
- FE-015: With `sendReturn: false`, `feed` MUST NOT send or await the return value of a stream source.
  So a discarded value cannot fail or block the run.
  A discarded `Promise` MUST NOT cause an `unhandledRejection`.
- FE-016: With `sendReturn: true`, `feed` MUST send a return value other than `undefined` as the final value.
  This test uses the awaited value.
  FE-013, FE-030 and FE-031 apply to this value.
  `feed` sends the return value only of an exhausted source.
  `sendReturn` has no effect on thenable sources.
- FE-017: A `Promise` source MUST have a rejection handler from the `feed` call.
  So an early rejection never causes an `unhandledRejection`.
  At start, FE-041 handles the rejection.
- FE-018: `feed` MUST NOT call `then` on other thenables before start, because `then` can start work.
- FE-019: `feed` MUST do detection one time, at the `feed` call.
  An error from detection MUST propagate to the caller.
  Later steps MUST use the values that detection read.
  `feed` MUST read the `next` of an iterator one time.
  So this error cannot occur during a run.

## Starting

- FE-020: With `autoStart: true`, the run MUST start immediately, during the `feed` call.
- FE-021: With `autoStart: false`, the run MUST start when `channel` has an active consumer.
  A consumer that ended does not count.
- FE-022: FE-021 MUST apply to all `firstReceive` modes.
  It MUST NOT add a value to the log.
  It uses `attached(channel)` from `channel.md`.
- FE-023: `feed` MUST NOT pull a source before start.
- FE-024: `feed` MUST get the iterator of a stream source at start, not at the `feed` call.
- FE-025: If the channel is terminal at start, or becomes terminal before start, the run MUST end.
  It MUST NOT pull.

## Moving values

- FE-030: With `backPressure: true`, `feed` MUST use `asend` for each value.
  The next pull MUST wait for that `asend`.
- FE-031: With `backPressure: false`, `feed` MUST use `send` for each value.
- FE-035: This spec does not define the order of values from concurrent runs.
  Values from one run stay in order.

## Ending

- FE-040: An exhausted source MUST end the run.
- FE-041: A source failure or a value failure MUST call `channel.throw` with the unchanged error.
  The run MUST then end.
  This applies to all errors from the source, including a `StopError` from another channel.
- FE-042: The run MUST check for a terminal channel before each pull.
  A terminal channel causes an early end.
  If `channel.signal` aborts during a pull, the run MUST end its wait for that pull immediately.
  This MUST retain nothing per pull.
  The run MUST discard a late result or rejection from that pull.
  A discarded result with a `value` that is a rejecting `Promise` MUST NOT cause an `unhandledRejection`.
- FE-043: A `StopError` from `channel` during a send MUST cause an early end, without `channel.throw`.
- FE-044: An early end or a value failure MUST call `return()` on the iterator of the source, if it has one.
  This applies to all stream source kinds.
- FE-045: If the run ended before start, FE-044 applies only if the source itself has `return`.
  `feed` does not touch an `AsyncIterable` or `Iterable` without `return`.
- FE-046: `feed` MUST NOT call `return()` after a source failure, or on an exhausted source.
  This rule has priority over FE-044, also when a return value fails.
- FE-047: If no pull is in progress, the run MUST await `return()`.
  The run ends when `return()` settles.
  If a pull is in progress, the run MUST call `return()`.
  The run MUST then end immediately.
  It MUST NOT await that `return()`.
  A generator puts that `return()` in a queue behind the pull.
- FE-048: `feed` MUST ignore errors from `return()`.
- FE-049: When a run with `autoClose: true` ends and no active runs remain, `feed` MUST call `channel.close()`.
  This has no effect on a terminal channel (CH-061).
- FE-04A: A run with `autoClose: false` MUST still count as active for other runs.
  It never closes the channel when it ends, even if it is the last run.
- FE-04B: `feed` MUST count runs per channel.
- FE-04C: Run tracking MUST NOT retain an unreachable channel.
- FE-04D: A run MUST remove its abort listener from `channel.signal` when it ends.
  So many short runs on one long-lived channel retain nothing per run.

## Returned promise

- FE-050: `feed` MUST resolve with `undefined` when its run ends.
- FE-051: `feed` MUST NOT reject for a source, value or channel error.
  These errors belong to the stream.
  Consumers get them (FE-041).
- FE-052: Usage errors belong to the caller.
  So `feed` MUST throw them synchronously.
- FE-053: `feed` MUST NOT be an `async function`, because FE-011 needs a synchronous throw.
- FE-054: If `channel` is not a `Channel` from this copy of the library, `feed` MUST throw a `TypeError` synchronously.

## Limits

These behaviours come from the rules above and are intentional.

- FE-060: Code cannot interrupt a generator that waits at its own `await`.
  Its `return()` has effect only after that `await` settles.
  If the `await` never settles, the `finally` blocks of the generator never execute.
- FE-061: `feed` discards a value that it pulled for a terminal channel.
  If the source is a `thenReceive: "unread"` channel, no other consumer gets that value.
- FE-062: With `backPressure: true`, a run blocks while no consumer has read its value or a later value (CH-019).
  This occurs with no consumers, or with `autoStart: true` and a late `firstReceive: "next"` consumer.
  The run ends when the channel becomes terminal.
- FE-063: A failed run fails the whole channel.
  So other runs have an early end (FE-042).
- FE-064: With `backPressure: false`, a source with results that are always ready executes on microtasks only.
  So the event loop executes no macrotask while that source has results.
- FE-065: `feed` and `channel` MUST come from one copy of the library (CH-095, FE-04B).
- FE-066: With `stopStyle: "stop"` and `backPressure: false`, auto close can discard the final values (CH-065).

## Examples

Create a channel from a source:

```ts
function* jobs() {
  yield "a";
  yield "b";
}
const ch = new Channel<string>({ thenReceive: "unread" });
feed(jobs(), ch);
for await (const job of ch) console.log(job); // => a, b
```

Close a channel when one chosen source ends:

```ts
async function* ticks() {
  yield "tick";
  await new Promise(() => {});
}
const until = Promise.resolve("stop");
const ch = new Channel<string>();
feed(ticks(), ch);
feed(until, ch).then(() => ch.close());
for await (const value of ch) console.log(value); // => tick, stop
```

Merge two sources:

```ts
function* serverA() {
  yield "a1";
  yield "a2";
}
function* serverB() {
  yield "b1";
}
const ch = new Channel<string>();
feed(serverA(), ch);
feed(serverB(), ch);
for await (const line of ch) console.log(line); // => a1, b1, a2 (FE-049)
```

Send a generator's return value:

```ts
function* steps() {
  yield 1;
  return 2;
}
const ch = new Channel<number>();
feed(steps(), ch, { sendReturn: true });
for await (const n of ch) console.log(n); // => 1, 2 (FE-016)
```
