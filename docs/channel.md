# Channel primitive

A zero-dependency, robust, and highly concurrent Async Iterable stream primitive for modern JavaScript/TypeScript.

## Features
- **Native & Idiomatic**: built using modern primitives like `Promise.withResolvers`, `AbortController`, and `Symbol.asyncIterator`.
- **Memory Safe**: only necessary objects are retained in memory.
- **Concurrent & MPMC**: safely handles Multiple-Producers and Multiple-Consumers broadcasting without dropped signals or unhandled rejections.
- **100% Mutation Tested**: bulletproof, rigorously tested state logic. 100% mutational coverage using Stryker.

## Quick Start

```typescript
// Create a channel
const ch = new Channel<number>({
  firstReceive: "unread",
  thenReceive: "every",
  stopStyle: "drain"
});

// Or use the factory function
const ch2 = channel<number>();

// Supply with send calls
ch.send(1);
promise.then(result => ch.send(result));
events.addEventListener("event", event => ch.send(event));


// Consume with `for await` loop
(async () => {
  for await (const val of ch) {
    console.log(val);
  }
})();

// Or explicitly
const it = ch[Symbol.asyncIterator]();
console.log(await it.next());

// Close channel gracefully
ch.close();

// Close channel with a final return value for the iterator
ch.close("finished");

// Or leverage explicit resource management:
using ch3 = new Channel<number>();
```

## Synchronous vs Asynchronous Sending

The channel supports two modes of broadcasting values:

### Fire and Forget (`send`)
`ch.send(value)` immediately pushes the value into the channel's buffer and returns synchronously. If no consumers are listening, the value queues up according to the backlog rules.

### Backpressure and Acknowledgment (`asend`)
`await ch.asend(value)` returns a Promise that blocks the producer until *at least one* consumer explicitly reads the value (or skips past it). This allows you to build strict backpressure and ensures producers don't outpace consumers. In an MPMC scenario with multiple consumers, the producer is unblocked as soon as the *fastest* active consumer processes the transmission.

```typescript
const ch = new Channel<number>();

// The producer will suspend here until a consumer pulls the value!
await ch.asend(42); 
```

## Configuration options

The channel can be fine-tuned via the options object passed into constructor to perfectly match your synchronization, backlog, and load-shedding requirements.

### `firstReceive`
Controls what a *newly attached* consumer receives upon its very first iteration:
- **`"first"`**: Consumer replays the absolute beginning of the channel's entire history (retained in memory).
- **`"unread"`** *(default)*: Consumer starts from the oldest value that has not yet been read by *any* listener. Once the fastest listener reads a value, the channel's global unread pointer advances, meaning subsequent new listeners will skip it.
- **`"latest"`**: Consumer immediately receives the most recently resolved value (if one exists), or waits for the next one.
- **`"next"`**: Consumer ignores all past transmissions and strictly waits for the next future value.

### `thenReceive`
Controls how an attached consumer processes subsequent values:
- **`"every"`**: The consumer sequentially processes every single value broadcasted, forcing the channel to retain the backlog in memory until this consumer reads it.
- **`"latest"`** *(default)*: If a consumer is slow or actively busy processing, it drops unread intermediate values and skips straight to the most recently broadcasted value to catch up. This allows intermediate unread values to be garbage collected.

### `stopStyle`
Controls how iterators behave when `ch.close()` or `ch[Symbol.dispose]()` is called:
- **`"drain"`** *(default)*: Consumers will finish processing all remaining unread values in their local queue before gracefully returning `{ done: true }`.
- **`"stop"`**: Consumers instantly terminate on their next iteration, immediately dropping any unread backlog.

## Error Handling

### Defensive Aborts
You can explicitly abort the channel and forcefully throw an error into all active consumer iterators by using:
```typescript
ch.throw(new Error("Upstream failure"));
```
Consumers blocked on the channel will immediately reject, allowing downstream `try/catch` blocks to gracefully handle the failure. Additionally, any producers currently blocked on an `asend()` call will also instantly reject with the same error to prevent them from hanging indefinitely.

### Identifying Stop Errors
When `ch.close()` is called, it internally invokes `ch.throw(STOP)`. This causes blocked consumers and producers to reject gracefully. 
To distinguish between an expected channel closure and an actual upstream failure in your `catch` blocks, use the exported `isStopError` utility:

```typescript
import { Channel, isStopError } from "gg";

try {
  await ch.asend(42);
} catch (err) {
  if (isStopError(err)) {
    console.log("Channel gracefully closed, producer aborting.");
  } else {
    console.error("Actual failure:", err);
  }
}
```
