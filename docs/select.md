# Select

The `select` function multiplexes multiple asynchronous sources (Promises, Iterators, and Async Iterables) into a single unified reactive stream. It takes a "shape" (an object or an array) and returns a **Proxy** that allows you to dynamically mutate the shape while also acting as an async iterable (`Channel`) that yields synchronized snapshots of the shape's state over time.

> **Note on Shallowness**: `select` only tracks the shape **shallowly**. If you have deeply nested objects containing promises or iterators, you must manually wrap those nested objects in their own `select` call and pass the resulting proxy into the parent shape!

## Overview

Whenever any underlying promise resolves, or an *async* generator yields a new value, `select` emits a new cloned snapshot of the entire shape, reflecting the latest state of all its sources. (Synchronous generators work strictly in pull-mode, so they only push an update if they explicitly yield a `Promise`).

```typescript
import { select } from "./select.ts";

const p1 = Promise.resolve("hello");
const p2 = Promise.resolve("world");

const stream = select({ first: p1, second: p2 });

for await (const state of stream) {
  console.log(state);
}
```

## State Object

Asynchronous sources are tracked using a state object that describes their current lifecycle.

**For Promises:**
```typescript
{ status: "pending" }
{ status: "fulfilled", value: "hello" }
{ status: "rejected", reason: Error(...) }
```

**For Generators & Async Iterables:**
Generators include a `done` boolean flag. If the generator throws an error, it transitions to a `rejected` state.
```typescript
{ status: "pending" } // Before first yield (or while awaiting next async value)
{ status: "fulfilled", value: 100, done: false } // Intermediate yields
{ status: "fulfilled", value: 200, done: true } // Generator explicitly returned
{ status: "rejected", reason: Error(...) } // Generator threw an error
```

**For Plain Values:**
Plain primitives or synchronous values passed in the shape remain exactly as they are.

```typescript
const s = select({ a: 42, b: Promise.resolve(1) });
// Yields: { a: 42, b: { status: "pending" } }
// Yields: { a: 42, b: { status: "fulfilled", value: 1 } }
```

## Features

### Synchronous Batching
`select` is heavily optimized for reactive UI and state-binding use cases. If multiple sources resolve/yield synchronously (in the same event loop tick), or if you perform multiple synchronous mutations on the Proxy (e.g., `s.a = 1; s.b = 2;`), `select` debounces all updates using a microtask. This ensures that consumers only receive a single, unified state emission containing all changes instead of a flood of intermediate states.

### Immutable Snapshots
Every emitted event is a shallow-cloned snapshot. Unchanged properties will be ref-identical in subsequent snapshots.

### Array Support
`select` perfectly preserves the structural type of its input. If you pass an array, it returns an array of states.
```typescript
const s = select([ Promise.resolve(1), Promise.resolve(2) ]);
// Yields: [{ status: "pending" }, { status: "pending" }]
// Yields: [{ status: "fulfilled", value: 1 }, { status: "fulfilled", value: 2 }]
```

### Auto Close
By default (`autoClose: true`), the returned `Channel` will automatically close itself when all asynchronous sources in the shape have fully resolved, rejected, or exhausted their iterators. This prevents memory leaks and allows `for await...of` loops to cleanly terminate. 

> **Note**: Once a channel is closed (either manually via `.close()`, disposal, or auto-close), any subsequent dynamic mutations to the Proxy (e.g., `s.newProp = Promise.resolve()`) are silently ignored and will not reopen the channel.

> **Note on Synchronous Generators**: Synchronous iterators (which yield plain values) do **not** keep the channel open. Because `select` is an asynchronous multiplexer, synchronous iterators are "pulled along" only when an asynchronous event triggers an update. However, if a synchronous generator explicitly `yield`s a `Promise`, `select` will actively track that Promise, which **will** keep the channel open until the Promise resolves!

To disable this behavior, you can pass `autoClose: false` in the options:
```typescript
const s = select({ p: Promise.resolve(1) }, { autoClose: false });
```

### Hold Done (`holdDone`)
When a generator finishes, it typically returns `{ value: undefined, done: true }`. By default, `select` will automatically retain the *last known value* while flipping `done` to `true` (`holdDone: true`).

> **Note**: `holdDone` only triggers if the generator returns `undefined`. If your generator explicitly returns a value (e.g., `return 42;`), `select` will correctly emit that final explicit value regardless of the `holdDone` setting.

If you want the final state to accurately reflect the generator's literal return value of `undefined`, you can disable this by passing `holdDone: false`:
```typescript
const s = select({ g: myGenerator() }, { holdDone: false });
```

### Change Tracking (`onChanges` & `changeValues`)
If you need to know exactly which keys triggered the current snapshot update, you can provide an `onChanges` callback.

```typescript
const s = select({ p: Promise.resolve(1) }, { 
  onChanges: (changes) => console.log("Changed keys:", changes) 
});
```
By default, `onChanges` receives an object where keys are the names of the updated properties, and values are the property keys themselves (e.g., `{ p: "p" }`). 

If you set `changeValues: true`, the `changes` object will contain the **old (previous) state** of the updated properties right before the mutation occurred. This is extremely useful for diffing state transitions:
```typescript
const s = select({ p: Promise.resolve(1) }, { 
  changeValues: true,
  onChanges: (changes) => {
    // changes.p will contain { status: "pending" }, which was the state BEFORE it fulfilled!
    console.log("Previous states of changed keys:", changes);
  }
});
```
 
## Dynamic Mutations (Proxy)
The object returned by `select` is a Proxy. This means you can dynamically add, modify, or delete properties on the shape *after* creation, and the multiplexer will automatically track the new promises/iterators and emit updated snapshots!

```typescript
const s = select({ a: Promise.resolve(1) });
s.b = Promise.resolve(2); // Dynamically adds 'b' to the reactive stream!
delete s.a; // Dynamically removes 'a' from the stream!
```

## Array Mutators
If your shape is an Array, `select` intercepts standard array mutators (`push`, `pop`, `shift`, `unshift`, `splice`). Calling these methods on the proxy will correctly mutate the underlying state iterators and emit a new state snapshot.

```typescript
const s = select([Promise.resolve(1)]);
s.push(Promise.resolve(2)); // Safely appends and tracks the new promise
```

### Relocated Array Changes
When using `onChanges` with `changeValues: true` on an Array, array mutators like `splice` or `shift` physically shift elements and overwrite indices. `select` handles this gracefully by returning a specialized `RelocatedProxy` in the `onChanges` callback. This proxy transparently remaps indices so that reading `changes[i]` always returns the *original* value at index `i` exactly as it was *before* the array was mutated! This allows you to safely diff elements that were just `pop()`ped or `splice()`d away.

## Initialization (`autoStart`)
By default, `select` is **lazy**. It will not start pulling from iterators or awaiting promises until you explicitly consume the stream (e.g., via `for await` or calling `.next()`).
To make it evaluate eagerly upon creation, pass `autoStart: true`:
```typescript
const s = select({ g: myGenerator() }, { autoStart: true });
```

## Resource Management (Disposable)
The returned proxy implements `Symbol.dispose` and `Symbol.asyncDispose`. This means you can use it with TypeScript's `using` keyword to automatically close the channel and stop multiplexing when it falls out of scope:
```typescript
{
  using s = select({ p: Promise.resolve(1) });
  // ... use the stream ...
} // Channel automatically closes when block ends
```
