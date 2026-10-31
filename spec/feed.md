# Feed

This document is self-contained, except that it builds on `Channel` from `channel.md`.
An implementation built from these two documents MUST be complete and valid.
The key words MUST, MUST NOT, SHOULD and MAY are normative.

## Purpose

`feed` moves values from one source into an existing channel.
Several `feed` calls may share a channel, which merges their sources.

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

With `sendReturn: true`, the caller guarantees the return value has type `T`.
The types do not check this.
`Iterable<string>` accepts a primitive string at compile time, and FE-014 rejects it at runtime.

## Terms

- **Run**: one `feed` call, from the call until it stops using its source.
- **Active run**: a run that has not ended, including one waiting to start.
- **Start**: the moment a run may first pull.
- **Pull**: requesting the next value from a source, and awaiting it by FE-013.
- **Stream source**: any source other than a thenable.
- **Source failure**: a thenable source rejects, or `next()` throws or rejects.
  A `next()` result that is not an object is also a source failure, with a `TypeError`.
  So is an error from calling `Symbol.asyncIterator` or `Symbol.iterator` at start, from reading `next` on the iterator, or from reading `done` or `value` on a result.
- **Value failure**: a value awaited by FE-013 rejects.
  The stream source is still open at that point, unless the value is a return value by FE-016.
  An error from `send` or `asend` other than the stop error is also a value failure.
- **Usage error**: a call that can never work, regardless of what the source produces.

## Options

- FE-001: Defaults MUST be `autoStart: false`, `autoClose: true`, `backPressure: true`, `sendReturn: false`.
- FE-002: `feed` MUST NOT add methods to `Channel`.
- FE-003: An option value of the wrong type MUST make `feed` throw a `TypeError` synchronously.
  `undefined` selects the default.

## Source handling

- FE-010: Source kinds MUST be detected in this order:
  thenable, `Symbol.asyncIterator`, `Symbol.iterator`, callable `next`.
- FE-011: Any other source MUST make `feed` throw a `TypeError` synchronously.
  No run exists in that case, so the channel and source are untouched.
- FE-012: A thenable source MUST deliver one value, including `undefined`.
- FE-013: Each pulled value MUST be awaited before it is sent.
  Sync iterators yielding promises therefore deliver the settled values.
- FE-014: A primitive string is not a source, and MUST follow FE-011.
  This takes precedence over `Symbol.iterator` detection.
- FE-015: With `sendReturn: false`, a stream source's return value MUST NOT be sent or awaited.
  A discarded value therefore cannot fail or hold the run, and a discarded `Promise` MUST NOT cause an `unhandledRejection`.
- FE-016: With `sendReturn: true`, a return value other than `undefined` MUST be sent as the final value.
  The test runs on the awaited value.
  It follows FE-013, FE-030 and FE-031.
  Only a source that finishes by itself has its return value sent.
  `sendReturn` has no effect on thenable sources.
- FE-017: A `Promise` source MUST have a rejection handler from the `feed` call.
  An early rejection therefore never becomes an `unhandledRejection`.
  At start, it is handled as FE-041 requires.
- FE-018: Other thenables MUST NOT have `then` called before start, because `then` may trigger work.
- FE-019: Detection MUST run once, at the `feed` call, and an error from it MUST propagate to the caller.
  Later steps MUST use what it read, and an iterator's `next` MUST be read once.
  It therefore cannot surface during a run.

## Starting

- FE-020: With `autoStart: true`, the run MUST start immediately, during the `feed` call.
- FE-021: With `autoStart: false`, the run MUST start once `channel` has an active consumer.
  A consumer that has already ended does not count.
- FE-022: FE-021 MUST hold for every `firstReceive` mode, and MUST NOT add a value to the log.
  It uses `attached(channel)` from `channel.md`.
- FE-023: A source MUST NOT be pulled before start.
- FE-024: A stream source's iterator MUST be obtained at start, not at the `feed` call.
- FE-025: If the channel is terminal at start, or turns terminal before it, the run MUST end without pulling.

## Moving values

- FE-030: With `backPressure: true`, each value MUST use `asend`, and the next pull waits for it.
- FE-031: With `backPressure: false`, each value MUST use `send`.
- FE-035: The interleaving of values from concurrent runs is unspecified.
  Values from one run keep their order.

## Ending

- FE-040: A source that finishes by itself MUST end the run.
- FE-041: A source failure or value failure MUST call `channel.throw` with the unchanged error, and end the run.
  This applies to any error from the source, including a `StopError` from another channel.
- FE-042: The run MUST check for a terminal channel before each pull.
  A terminal channel stops the run early.
  Each pull in progress MUST also be raced against `channel.signal`, so the run stops without waiting for the pull.
  The race MUST retain nothing per pull, and a late result or rejection from that pull MUST be discarded.
  A discarded result whose `value` is a rejecting `Promise` MUST NOT cause an `unhandledRejection`.
- FE-043: A `StopError` from `channel` while sending MUST stop the run early, without `channel.throw`.
- FE-044: Stopping early and value failure MUST call `return()` on the source's iterator, if it has one.
  This applies to every stream source kind.
- FE-045: If the run ended before start, FE-044 applies only if the source itself has `return`.
  An `AsyncIterable` or `Iterable` without `return` is left untouched.
- FE-046: `return()` MUST NOT be called after a source failure, or after a source finishes by itself.
  This takes precedence over FE-044, including when a return value fails.
- FE-047: With no pull in progress, the run MUST await `return()`, and it ends once `return()` settles.
  With a pull in progress, the run MUST call `return()` without awaiting it, and end at once.
  A generator queues that `return()` behind the pull.
- FE-048: Errors from `return()` MUST be ignored.
- FE-049: When a run ends with `autoClose: true` and no active runs remain, `channel.close()` MUST be called.
  An already terminal channel is unaffected, by CH-061.
- FE-04A: A run with `autoClose: false` MUST still count as active for other runs.
  It never closes the channel when it ends, even if it is the last run.
- FE-04B: Runs MUST be counted per channel.
- FE-04C: Run tracking MUST NOT keep an otherwise unreachable channel alive.
- FE-04D: A run MUST remove its abort listener from `channel.signal` when it ends.
  Many short runs on one long-lived channel therefore retain nothing per run.

## Returned promise

- FE-050: `feed` MUST resolve with `undefined` when its run ends.
- FE-051: `feed` MUST NOT reject for any source, value or channel error.
  Those errors belong to the stream, and consumers receive them by FE-041.
- FE-052: Usage errors belong to the caller, so `feed` MUST throw them synchronously.
- FE-053: `feed` MUST NOT be an `async function`, because FE-011 needs a synchronous throw.
- FE-054: A `channel` that is not a `Channel` from this copy of the library MUST make `feed` throw a `TypeError` synchronously.

## Limits

These behaviours follow from the rules above and are intentional.

- FE-060: A generator suspended at its own `await` cannot be interrupted, so its `return()` takes effect only after that `await` settles.
  If it never settles, the generator's `finally` blocks never run.
- FE-061: A value pulled for a terminal channel is lost.
  With a `thenReceive: "unread"` channel as the source, that item never reaches another worker.
- FE-062: With `backPressure: true`, a run stays blocked while no read reaches its value, by CH-019.
  This happens with no consumers, or with `autoStart: true` and a late `firstReceive: "next"` consumer.
  The run ends when the channel turns terminal.
- FE-063: A failed run fails the whole channel, so other runs stop by FE-042.
- FE-064: With `backPressure: false`, an always-ready source runs on microtasks alone and starves the event loop.
- FE-065: `feed` and `channel` MUST come from one copy of the library, by CH-095 and FE-04B.
- FE-066: With `stopStyle: "stop"` and `backPressure: false`, auto close can drop the final values by CH-065.

## Examples

Create a channel from a source:

```ts
const ch = new Channel<Job>({ thenReceive: "unread" });
feed(jobs(), ch);
```

Close a channel when one chosen source ends:

```ts
feed(ticks, ch);
feed(until, ch).then(() => ch.close());
```

Merge two sources:

```ts
const ch = new Channel<string>();
feed(serverA(), ch);
feed(serverB(), ch);
for await (const line of ch) console.log(line); // Ends after both sources finish
```

Send a generator's return value:

```ts
function* steps() {
  yield 1;
  return 2;
}
const ch = new Channel<number>();
feed(steps(), ch, { sendReturn: true });
for await (const n of ch) console.log(n); // 1, then 2
```
