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

// Or leverage explicit resource management:
using ch = new Channel<number>();
```

## Configuration options

The channel can be fine-tuned via the options object passed into constructor to perfectly match your synchronization, backlog, and load-shedding requirements.

### `firstReceive`
Controls what a *newly attached* consumer receives upon its very first iteration:
- **`"first"`**: Consumer replays the absolute beginning of the channel's entire history.
- **`"unread"`** *(default)*: Consumer starts from the oldest *unconsumed* value in the queue, skipping history that has already been consumed by other listeners.
- **`"latest"`**: Consumer immediately receives the most recently resolved value (if one exists), or waits for the next one.
- **`"next"`**: Consumer ignores all past transmissions and strictly waits for the next future value.

### `thenReceive`
Controls how an attached consumer processes subsequent values:
- **`"every"`**: The consumer sequentially processes every single value broadcasted.
- **`"latest"`** *(default)*: If a consumer is slow or actively busy processing, it drops unread intermediate values and skips straight to the most recently broadcasted value to catch up.

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
Consumers blocked on the channel will immediately reject, allowing downstream `try/catch` blocks to gracefully handle the failure.
