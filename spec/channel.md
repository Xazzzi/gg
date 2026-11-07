# Channel

This document is self-contained.
An implementation made from this document alone MUST be complete and valid.
The key words MUST, MUST NOT, SHOULD and MAY are normative.
Rule IDs are stable.
The name of a test contains the ID of its rule.

## Purpose

`Channel` is an async stream with multiple producers and multiple consumers.
Producers push values with `send` or `asend`.
Consumers pull values through the async iterator protocol, usually with `for await`.
Options set the channel to act as a broadcast, a store of the latest value or a work queue.

## Environment

The implementation targets ES2024 with explicit resource management.
It has no runtime dependencies.
It MUST NOT use timers.

## Public API

```ts
export type FirstReceive = "first" | "unread" | "latest" | "next";
export type ThenReceive = "every" | "latest" | "unread";
export type StopStyle = "drain" | "stop";

type Sendable<T> = T extends PromiseLike<any> ? never : T;

export type ChannelOptions = {
  firstReceive?: FirstReceive;
  thenReceive?: ThenReceive;
  stopStyle?: StopStyle;
};

export class Channel<T, TReturn = undefined>
  implements AsyncIterable<T, TReturn | undefined>, Disposable
{
  constructor(options?: ChannelOptions);
  readonly signal: AbortSignal;
  send(value: Sendable<T>): void;
  asend(value: Sendable<T>): Promise<void>;
  close(value?: Sendable<TReturn>): void;
  throw(value: unknown): void;
  [Symbol.asyncIterator](): AsyncGenerator<T, TReturn | undefined, void>;
  [Symbol.dispose](): void;
}

export class StopError extends Error {
  constructor(reason?: unknown);
  readonly name: "StopError";
  readonly reason: unknown;
}
```

The return type includes `undefined` because `close()` and `Symbol.dispose` give no value.
No other name is public.

## Model

These terms define the behaviour.
The implementation MAY use any internal structure that gives the same observable behaviour.

- **Log**: all values sent, in `send` call order, numbered from 1.
- **Newest**: the log's last value.
- **Producer**: code that calls `send` or `asend`.
- **Consumer**: one iterator returned by `ch[Symbol.asyncIterator]()`.
- **Attach**: a consumer's first `next()` call.
  A `ch[Symbol.asyncIterator]()` call has no effect.
- **Active consumer**: a consumer that attached and did not end.
  An attached consumer stays active if code abandons it, because the channel cannot see this.
- **Read**: a consumer takes a value from the log.
  A read occurs in a microtask, and never during the `send` call.
- **Blocked**: a consumer has a pending `next()` and no value to read.
- **Busy**: a consumer got a value and did not call `next()` again.
- **Position**: the number of the last value a consumer read.
- **Head**: one shared log number that `"unread"` modes use.
- **Terminal**: the state of a channel after its first `close` or `throw` call.
- **Stop error**: the `StopError` that producers and `signal` get when the channel is terminal.
- **Retain**: prevent garbage collection of a value.

## Construction

- CH-001: The defaults MUST be `firstReceive: "unread"`, `thenReceive: "every"`, `stopStyle: "drain"`.
- CH-002: The constructor MUST throw a `TypeError` if `thenReceive` is `"unread"` and `firstReceive` is not `"unread"`.
- CH-003: The constructor MUST throw a `TypeError` for an option value that the Public API does not list.

CH-002 exists because `thenReceive: "unread"` guarantees that one consumer gets each value.
This guarantee needs all consumers to take values from the shared head.
`firstReceive: "first"` and `"latest"` can read a value that another consumer took.
`firstReceive: "next"` can skip values that no consumer took.

## Sending

- CH-010: `send` MUST add the value to the log.
  It MUST return `undefined` synchronously.
- CH-011: `send` MUST NOT run consumer code synchronously.
- CH-012: The channel MUST accept any value except a thenable, including `undefined` and `null`.
- CH-013: `send` MUST throw a `TypeError` for a thenable.
  `asend` MUST reject with a `TypeError` for a thenable.
  A thenable is an object or function with a callable `then` property.
  The log does not get the value.
  If the read of `then` throws an error, `send` MUST throw that error and `asend` MUST reject with it.
- CH-014: `send` on a terminal channel MUST throw the stop error.
  This rule has priority over CH-013.
  `send` MUST do this check again after it reads `then`, because a `then` getter can close the channel.
  An error from the read of `then` has priority over the second check.
- CH-015: `asend` MUST add the value to the log as `send` does.
- CH-016: `asend` on a terminal channel MUST reject with the stop error.
  `asend` does the checks of CH-014.
- CH-017: `asend` MUST resolve with `undefined` when a consumer reads its value or a later value.
- CH-018: `asend` MUST resolve at the read.
  It MUST NOT wait for the consumer to finish its work on the value.
- CH-019: `asend` MUST stay pending while no consumer has read its value or a later value.
  If there are no consumers, it stays pending until the channel is terminal.
- CH-01A: A pending `asend` MUST reject with the stop error when the channel becomes terminal.
- CH-01B: A pending `asend` MUST NOT depend on garbage collection.
- CH-01C: A rejection of `asend` with the stop error MUST NOT cause an `unhandledRejection`.
  A producer that awaits the `asend` still gets the rejection.
  A CH-013 rejection stays unhandled if the producer ignores it, because it is a programming error.
- CH-01D: A CH-01A rejection does not mean that the channel discarded the value.
  Under `"drain"`, a consumer can still read the value.
  So a producer that retries MUST tolerate duplicates.

## First receive

`firstReceive` sets the first value that a consumer reads.

- CH-020: `"first"` MUST start at value 1.
- CH-021: `"unread"` MUST start at the head.
  The read's microtask evaluates the head.
- CH-022: `"latest"` MUST start at the newest value at attach.
  If the log is empty, it MUST start at the next value sent.
- CH-023: `"next"` MUST start at the first value sent after attach.
- CH-024: A consumer MUST block while its starting value is not in the log.

## Then receive

`thenReceive` sets each value after the first.

- CH-030: `"every"` MUST read position + 1.
- CH-031: `"latest"` MUST read the newest value if that value is after the position.
  The consumer does this check when the `next()` call starts to run, after all earlier `next()` calls of this consumer settle.
- CH-032: If there is no such value, `"latest"` MUST block.
  It MUST then read the first value that a producer sends after the block starts.
- CH-033: `"latest"` MUST NOT give the same value to one consumer two times.
- CH-034: `"unread"` MUST read the head.
- CH-035: Under `"unread"`, two consumers MUST NOT get the same value.
- CH-036: This spec does not define the order in which blocked `"unread"` consumers get values.
- CH-037: Consumers MUST keep independent positions.

## Head

- CH-040: The head MUST start at 1.
- CH-041: A read of the head under `thenReceive: "every"` or `"unread"` MUST increase it by one.
- CH-042: A read of the head under `thenReceive: "latest"` MUST move it to the next value to send.
- CH-043: A read of any other value MUST NOT move the head.
- CH-044: `firstReceive: "first"`, `"latest"` and `"next"` MUST NOT move the head.

## Valid modes

| firstReceive | `every`              | `latest`             | `unread`         |
| ------------ | -------------------- | -------------------- | ---------------- |
| `first`      | Replay all, then all | Value 1, then newest | Invalid (CH-002) |
| `unread`     | Head, then all       | Head, then newest    | Work queue       |
| `latest`     | Newest, then all     | Newest, then newest  | Invalid (CH-002) |
| `next`       | Future values only   | Next, then newest    | Invalid (CH-002) |

The table has 9 valid modes.
`stopStyle` applies to each mode.
So there are 18 valid configurations.

## Memory

- CH-050: If no current or future consumer can read a value, the garbage collector MUST be able to collect it.
- CH-051: The channel MUST NOT limit its backlog, because `asend` gives backpressure.

Under CH-050, the channel retains only these values:

| firstReceive | Retained for future consumers                                                                           |
| ------------ | ------------------------------------------------------------------------------------------------------- |
| `first`      | The whole log under `every`, and value 1 and the newest value under `latest`                            |
| `unread`     | Values from the head under `every` and `unread`, and the head value and the newest value under `latest` |
| `latest`     | The newest value                                                                                        |
| `next`       | Nothing                                                                                                 |

Under `unread`, the channel retains the newest value only while the head value is unread.
A consumer under `every` also retains every value after its position.
A consumer under `latest` retains only its next value.

## Termination

- CH-060: The first `close` or `throw` call MUST make the channel terminal.
- CH-061: Later `close` and `throw` calls MUST have no effect.
  This includes the return value.
- CH-062: `signal` MUST abort synchronously, with the stop error as its reason.
- CH-063: `ch[Symbol.dispose]()` MUST behave as `close()`.
- CH-064: Under `"drain"`, a consumer MUST keep reading by its modes until it has no value to read.
- CH-065: Under `"stop"`, a read MUST NOT occur when the channel is terminal.
  The check occurs in the read's microtask.
  So `send(1); close();` in one synchronous run always discards `1`.
  A consumer still gets a value that it read before the channel became terminal.
- CH-066: After `close(value)`, the end of a consumer MUST produce `{ done: true, value }`.
- CH-067: After `throw(error)`, the end of a consumer MUST reject the `next()` call with the unchanged `error`.
- CH-068: CH-066 and CH-067 apply to blocked consumers, busy consumers and consumers that attach late.
- CH-069: Under `"drain"`, a consumer that attaches after the channel is terminal MUST read by its modes, then end.
- CH-06A: Under `"stop"`, a consumer that attaches after the channel is terminal MUST end on its first `next()`.
- CH-06B: After a consumer ends, each later `next()` MUST produce `{ done: true, value: undefined }`.
- CH-06C: `close` MUST throw a `TypeError` for a thenable.
  The channel stays open.
  Without this rule, an async generator adopts the thenable.
  CH-066 then fails.
  If the read of `then` throws an error, `close` MUST throw that error.
  That `close` call does not make the channel terminal.
  `close` on a terminal channel does not read `then`, so CH-061 applies.
  If a `then` getter closes the channel and does not throw, CH-061 applies.
  If that getter throws, `close` MUST throw that error, because the channel was open at the start of the call.

## Consumer lifetime

The consumer is an async generator.
These rules come from generator semantics.

- CH-070: `return()` MUST detach only that consumer.
  It MUST NOT close the channel.
- CH-071: `throw(error)` MUST end only that consumer.
  That consumer rejects with `error`.
- CH-072: `return()` and `throw()` on a consumer MUST NOT resolve an `asend`.
- CH-073: If a `next()` is pending, `return()` and `throw()` wait until that `next()` settles.
  The pending `next()` still reads a value.
  So under `"unread"`, no other consumer gets that value.
  If this is a problem, a caller MUST NOT abandon a pending `next()`.
- CH-074: `break` in `for await` MUST behave as `return()`.
  No `next()` is pending at that point.
  So CH-073 does not apply.

## Stop error

- CH-080: The stop error MUST be a `StopError`, which extends `Error`, with the message `"Channel closed"`.
- CH-081: Its `reason` property MUST be `undefined` after `close`.
  It MUST be the thrown value after `throw`.
- CH-082: A channel MUST use one stop error instance for all producers and `signal.reason`.
- CH-083: Consumers MUST NOT get the stop error.
  CH-066 and CH-067 define how consumers end.
- CH-084: `instanceof StopError` MUST return true across separate copies of the library.
  `StopError` implements `Symbol.hasInstance` over a `Symbol.for("gg.StopError")` brand on its instances.

Producers detect a terminal channel with `instanceof`:

```ts
try {
  await ch.asend(42);
} catch (err) {
  if (err instanceof StopError) console.log("Stopped, reason:", err.reason);
  else throw err;
}
```

## Internal API

Library modules share this API.
The package MUST NOT export it.

- CH-090: `attached(channel)` MUST return a promise that resolves when the channel has an active consumer.
- CH-091: It MUST resolve immediately if an active consumer exists at the call.
- CH-092: It MUST reject with the stop error if the channel is terminal, or becomes terminal first.
  This rule has priority over CH-091.
- CH-093: It MUST NOT add anything to the log.
- CH-094: The channel MUST keep a count of active consumers.
  A consumer MUST leave the count when it ends, for any reason.
- CH-095: This API works only within one copy of the library.

## Examples

`stopStyle: "drain"` lets a consumer read all values before it ends:

```ts
const ch = new Channel<number, string>();
ch.send(1);
ch.send(2);
ch.send(3);
const it = ch[Symbol.asyncIterator]();
await it.next(); // => { value: 1, done: false } (CH-021)
await it.next(); // => { value: 2, done: false } (CH-030)
ch.close("end");
await it.next(); // => { value: 3, done: false } (CH-064)
await it.next(); // => { value: 'end', done: true } (CH-066)
await it.next(); // => { value: undefined, done: true } (CH-06B)
```

Work queue:

```ts
const ch = new Channel<number>({ thenReceive: "unread" });
const a = ch[Symbol.asyncIterator]();
const b = ch[Symbol.asyncIterator]();
ch.send(1);
ch.send(2);
await a.next(); // => { value: 1, done: false } (CH-035)
await b.next(); // => { value: 2, done: false } (CH-035)
```

`stopStyle: "stop"` discards values that a consumer did not get:

```ts
const ch = new Channel<number>({ stopStyle: "stop" });
const it = ch[Symbol.asyncIterator]();
const pending = it.next(); // Blocked
ch.send(1);
ch.close();
await pending; // => { value: undefined, done: true } (CH-065)
```

Producers and consumers see different errors after `throw`:

```ts
const ch = new Channel<number>();
const failure = new Error("upstream");
ch.throw(failure);
ch.send(1); // => throws StopError: Channel closed (CH-014)
ch.signal.reason.reason === failure; // => true (CH-081)
await ch[Symbol.asyncIterator]().next(); // => throws Error: upstream (CH-067)
```
