# Select

The `select` function multiplexes multiple asynchronous sources (Promises, Iterators, and Async Iterables) into a single unified reactive stream. It takes a "shape" (an object or an array) and returns a `Channel` that yields synchronized snapshots of the shape's state over time.

## Overview

Whenever any underlying promise resolves, or any generator yields a new value, `select` emits a new cloned snapshot of the entire shape, reflecting the latest state of all its sources.

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
Generators include a `done` boolean flag.
```typescript
{ status: "pending" } // Before first yield
{ status: "fulfilled", value: 100, done: false } // Intermediate yields
{ status: "fulfilled", value: 200, done: true } // Generator returned
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
`select` is heavily optimized for reactive UI and state-binding use cases. If multiple sources resolve or yield synchronously (in the same event loop tick), `select` debounces the updates using a microtask, ensuring that consumers only receive a single, unified state emission instead of a flood of intermediate states.

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
By default, the returned `Channel` will automatically close itself when all asynchronous sources in the shape have fully resolved, rejected, or exhausted their iterators. This prevents memory leaks and allows `for await...of` loops to cleanly terminate.

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
