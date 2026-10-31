# Channel

This document is self-contained.
An implementation built from it alone MUST be complete and valid.
The key words MUST, MUST NOT, SHOULD and MAY are normative.
Rule IDs are stable, and tests reference them in their names.

## Purpose

`Channel` is an async stream with multiple producers and multiple consumers.
Producers push values with `send` or `asend`.
Consumers pull values through the async iterator protocol, usually with `for await`.
Options choose whether the channel acts as a broadcast, a latest-value holder or a work queue.

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

The return type includes `undefined` because `close()` and disposal pass no value.
Nothing else is public.

## Model

These terms define behaviour.
The implementation MAY use any internal structure with the same observable behaviour.

- **Log**: all values sent, in `send` call order, numbered from 1.
- **Newest**: the log's last value.
- **Producer**: code calling `send` or `asend`.
- **Consumer**: one iterator returned by `ch[Symbol.asyncIterator]()`.
- **Attach**: a consumer's first `next()` call.
  Creating the iterator has no effect.
- **Active consumer**: a consumer that has attached and has not ended.
  An attached consumer dropped without `return()` stays active, because the channel cannot observe that.
- **Read**: a consumer takes a value from the log.
  A read happens in a microtask, never during the `send` call.
- **Blocked**: a consumer has a pending `next()` and no value to read.
- **Busy**: a consumer has received a value and has not called `next()` again.
- **Position**: the number of the last value a consumer read.
- **Head**: one shared log number, used by `"unread"` modes.
- **Terminal**: the channel has been closed or thrown.
- **Stop error**: the `StopError` given to producers and `signal` once the channel is terminal.

## Construction

- CH-001: Defaults MUST be `firstReceive: "unread"`, `thenReceive: "latest"`, `stopStyle: "drain"`.
- CH-002: The constructor MUST throw a `TypeError` if `thenReceive` is `"unread"` and `firstReceive` is not `"unread"`.
- CH-003: The constructor MUST throw a `TypeError` for an option value not listed in the Public API.

CH-002 exists because `thenReceive: "unread"` guarantees each value reaches one consumer.
That guarantee depends on every consumer taking values from the shared head.
`firstReceive: "first"` and `"latest"` could read a value another consumer already took.
`firstReceive: "next"` could skip values no consumer has taken.

## Sending

- CH-010: `send` MUST append to the log and return `undefined` synchronously.
- CH-011: `send` MUST NOT run consumer code synchronously.
- CH-012: Any value except a thenable MUST be accepted, including `undefined` and `null`.
- CH-013: `send` MUST throw a `TypeError` for a thenable, and `asend` MUST reject with one.
  A thenable is an object or function with a callable `then` property.
  The value is not appended to the log.
  An error from reading `then` MUST propagate the same way.
- CH-014: `send` on a terminal channel MUST throw the stop error.
  This takes precedence over CH-013.
  The check MUST run again after reading `then`, because a `then` getter can close the channel.
  An error from reading `then` takes precedence over that second check.
- CH-015: `asend` MUST append to the log as `send` does.
- CH-016: `asend` on a terminal channel MUST reject with the stop error, checking as CH-014 does.
- CH-017: `asend` MUST resolve with `undefined` when any consumer reads its value or a later value.
- CH-018: `asend` MUST resolve at the read, without waiting for the consumer to finish handling the value.
- CH-019: `asend` MUST stay pending while no read reaches its value.
  With no consumers, it stays pending until the channel is terminal.
- CH-01A: A pending `asend` MUST reject with the stop error when the channel turns terminal.
- CH-01B: A pending `asend` MUST NOT depend on garbage collection in any way.
- CH-01C: An `asend` rejection with the stop error MUST NOT become an `unhandledRejection`.
  A producer awaiting the `asend` still receives it.
  A rejection by CH-013 stays unhandled if ignored, because it is a programming error.
- CH-01D: A rejection by CH-01A does not mean the value was dropped.
  Under `"drain"`, a consumer can still read it, so a producer that retries MUST tolerate duplicates.

## First receive

`firstReceive` selects the first value a consumer reads.

- CH-020: `"first"` MUST start at value 1.
- CH-021: `"unread"` MUST start at the head, evaluated in the read's microtask.
- CH-022: `"latest"` MUST start at the newest value at attach, or the next value sent if the log is empty.
- CH-023: `"next"` MUST start at the first value sent after attach.
- CH-024: A consumer MUST block when its starting value has not been sent yet.

## Then receive

`thenReceive` selects each value after the first.

- CH-030: `"every"` MUST read position + 1.
- CH-031: `"latest"` MUST read the newest value if it is later than the position.
  This is evaluated when that `next()` call starts running, after any earlier `next()` call of this consumer has settled.
- CH-032: Otherwise `"latest"` MUST block, and read the first value sent after that.
- CH-033: `"latest"` MUST NOT deliver the same value twice to one consumer.
- CH-034: `"unread"` MUST read the head.
- CH-035: Under `"unread"`, two consumers MUST NOT receive the same value.
- CH-036: The order in which blocked `"unread"` consumers receive values is unspecified.
- CH-037: Consumers MUST keep independent positions.

## Head

- CH-040: The head MUST start at 1.
- CH-041: Reading the head under `thenReceive: "every"` or `"unread"` MUST advance it by one.
- CH-042: Reading the head under `thenReceive: "latest"` MUST move it to the next value to be sent.
- CH-043: Reading any other value MUST NOT move the head.
- CH-044: `firstReceive: "first"`, `"latest"` and `"next"` MUST NOT move the head.

## Valid modes

| firstReceive | `every`              | `latest`             | `unread`          |
| ------------ | -------------------- | -------------------- | ----------------- |
| `first`      | Replay all, then all | Value 1, then newest | Invalid by CH-002 |
| `unread`     | Head, then all       | Head, then newest    | Work queue        |
| `latest`     | Newest, then all     | Newest, then newest  | Invalid by CH-002 |
| `next`       | Future values only   | Next, then newest    | Invalid by CH-002 |

The table has 9 valid modes.
`stopStyle` applies to each one, which gives 18 valid configurations.

## Memory

- CH-050: A value no current or future consumer can read MUST be collectable.
- CH-051: The channel MUST NOT bound its backlog, because `asend` provides backpressure.

CH-050 retains these values, and no others:

| firstReceive | Retained for future consumers                                                                           |
| ------------ | ------------------------------------------------------------------------------------------------------- |
| `first`      | The whole log under `every`, and value 1 and the newest value under `latest`                            |
| `unread`     | Values from the head under `every` and `unread`, and the head value and the newest value under `latest` |
| `latest`     | The newest value                                                                                        |
| `next`       | Nothing                                                                                                 |

Under `unread`, the newest value is retained only while the head value is unread.
A consumer under `every` also retains every value after its position.
A consumer under `latest` retains only its next value.

## Termination

- CH-060: The first `close` or `throw` call MUST make the channel terminal.
- CH-061: Later `close` and `throw` calls MUST have no effect, including on the return value.
- CH-062: `signal` MUST abort synchronously, with the stop error as its reason.
- CH-063: `ch[Symbol.dispose]()` MUST behave as `close()`.
- CH-064: Under `"drain"`, a consumer MUST keep reading by its modes until nothing is left to read.
- CH-065: Under `"stop"`, a read MUST NOT happen once the channel is terminal.
  The check runs in the read's microtask, so `send(1); close();` in one synchronous run always drops `1`.
  A value read before terminal is still delivered.
- CH-066: Ending after `close(value)` MUST produce `{ done: true, value }`.
- CH-067: Ending after `throw(error)` MUST reject the `next()` call with `error`, unchanged.
- CH-068: CH-066 and CH-067 apply to blocked, busy and late-attaching consumers alike.
- CH-069: Under `"drain"`, a consumer attaching after terminal MUST read by its modes, then end.
- CH-06A: Under `"stop"`, a consumer attaching after terminal MUST end on its first `next()`.
- CH-06B: After ending, every further `next()` MUST produce `{ done: true, value: undefined }`.
- CH-06C: `close` MUST throw a `TypeError` for a thenable, and the channel stays open.
  An async generator would otherwise adopt it, which breaks CH-066.
  An error from reading `then` MUST propagate, and the channel stays open.
  CH-061 takes precedence.

## Consumer lifetime

The consumer is an async generator.
These rules follow from generator semantics.

- CH-070: `return()` MUST detach only that consumer and MUST NOT close the channel.
- CH-071: `throw(error)` MUST end only that consumer, which rejects with `error`.
- CH-072: Detaching MUST NOT acknowledge any value.
- CH-073: With a `next()` pending, `return()` and `throw()` wait until that `next()` settles.
  The pending `next()` still reads a value, so a work queue loses that value.
  Callers MUST NOT abandon a pending `next()` if that loss matters.
- CH-074: `break` in `for await` MUST behave as `return()`.
  No `next()` is pending at that point, so CH-073 does not apply.

## Stop error

- CH-080: The stop error MUST be a `StopError`, which extends `Error`, with the message `"Channel closed"`.
- CH-081: Its `reason` property MUST be `undefined` after `close`, and the thrown value after `throw`.
- CH-082: A channel MUST use one stop error instance for all producers and `signal.reason`.
- CH-083: Consumers MUST NOT receive the stop error, as CH-066 and CH-067 define how they end.
- CH-084: `instanceof StopError` MUST hold across separate copies of the library.
  `StopError` implements `Symbol.hasInstance` over a `Symbol.for("gg.StopError")` brand on its instances.

Producers detect a stopped channel with `instanceof`:

```ts
try {
  await ch.asend(42);
} catch (err) {
  if (err instanceof StopError) console.log("Stopped, reason:", err.reason);
  else throw err;
}
```

## Internal API

This API is shared between library modules and MUST NOT be exported from the package.

- CH-090: `attached(channel)` MUST return a promise that resolves once the channel has an active consumer.
- CH-091: It MUST resolve immediately if an active consumer exists when it is called.
- CH-092: It MUST reject with the stop error if the channel is terminal, or turns terminal first.
  This takes precedence over CH-091.
- CH-093: It MUST NOT add anything to the log.
- CH-094: The channel MUST keep a count of active consumers.
  A consumer MUST leave the count when it ends for any reason.
- CH-095: This API works only within one copy of the library.

## Examples

Default modes, with a consumer that attaches late:

```ts
const ch = new Channel<number>();
ch.send(1);
ch.send(2);
ch.send(3);
const it = ch[Symbol.asyncIterator]();
await it.next(); // { value: 1, done: false }, the head by CH-021
await it.next(); // { value: 3, done: false }, the newest by CH-031
ch.close("end");
await it.next(); // { value: "end", done: true }, nothing left to read
```

`Channel<number>` rejects `close("end")` at compile time.
This example needs `Channel<number, string>`.

Work queue:

```ts
const ch = new Channel<number>({ thenReceive: "unread" });
const a = ch[Symbol.asyncIterator]();
const b = ch[Symbol.asyncIterator]();
ch.send(1);
ch.send(2);
await a.next(); // Value 1
await b.next(); // Value 2, and never value 1
```

Stop discards values a consumer has not received:

```ts
const ch = new Channel<number>({ stopStyle: "stop" });
const it = ch[Symbol.asyncIterator]();
const pending = it.next(); // Blocked
ch.send(1);
ch.close();
await pending; // { value: undefined, done: true }
```

Producers and consumers see different errors after `throw`:

```ts
const ch = new Channel<number>();
const failure = new Error("upstream");
ch.throw(failure);
ch.send(1); // Throws a StopError with reason === failure
await ch[Symbol.asyncIterator]().next(); // Rejects with failure
```
