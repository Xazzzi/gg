---
name: gg
description: Use when you write or review code that imports @xazzzi/gg, such as Channel, feed, select, changes, applyOps, mount, each and JSX components. It gives the mental model and the defaults that stall or close a state.
---

# gg

`gg` has three primitives and a JSX runtime.
`Channel` moves values, `feed` fills a channel from a source, and `select` combines sources into one state.
The JSX runtime builds DOM nodes with no virtual DOM, and components change their own nodes.
The rules have stable IDs, such as SE-080, in [`spec/`](https://github.com/Xazzzi/gg/tree/master/spec).
When this file and the spec do not agree, the spec is correct.

## Mental model

- A `Channel` is a log of values with many producers and many consumers.
  `send` never blocks, and `asend` resolves when a consumer reads the value (CH-017).
- A `select` is a mutable proxy over an object or array shape.
  Each key is a slot with a source: a plain value, a promise or an async iterable.
  A change publishes a snapshot of the whole shape to the channel of the select.
  It also reports ordered operations to `onChanges` and to readers from `changes`.
- A read through the proxy gives the source, not its value (SE-080).
  Read values from a snapshot, from `for await`, or from `changes(state).outputs`.
- `select` tracks only the top level of the shape.
  A nested object needs its own `select`, or a replacement of the whole item.
- No work occurs when no code observes the result.

We recommend that state does not import UI code.
The UI then reads state through `for await`, `changes` and `each`, and state stays testable without a DOM.

## Options that matter

| Option         | Default | Use                                                                         |
| -------------- | ------- | --------------------------------------------------------------------------- |
| `autoStart`    | `false` | Without it, a select starts only when a `for await` attaches (SE-030).      |
| `autoClose`    | `true`  | Set `false` for long-lived state, or the select closes when sources finish. |
| `backPressure` | `true`  | A flush waits until a consumer reads its snapshot (SE-042).                 |
| `nonYielding`  | `false` | Set `true` when only `changes`, `each` or `onChanges` read the state.       |
| `unwrap`       | `false` | Gives values, not `Val` objects. A rejection then fails the channel.        |

`feed` has the same `autoStart`, `autoClose` and `backPressure` defaults (FE-001).

## Pitfalls

- A select of plain values with default `autoClose` closes after its first flush (SE-074).
  After that, writes change the proxy with no tracking and no error (SE-08A).
- A `changes` reader and `each` do not start a select.
  Use `autoStart: true`, or give the select a `for await` consumer.
- With `autoStart` and default `backPressure`, a select with no snapshot consumer stops after its first publish.
  Its later changes do not reach `changes` readers or `onChanges`.
  Use `nonYielding: true`, `backPressure: false`, or a consumer.
  One consumer that reads unblocks it for all (CH-017).
- `state.items[0].done = true` changes nothing that `select` sees.
  Write `state.items[0] = { ...state.items[0], done: true }`.
- An index write replaces the source, so an iterator in that slot restarts (SE-088).
  `sort` and `reverse` move slots and do not restart them (SE-09C).
- Many single changes cost more than one splice.
  Write `items.splice(0, items.length, ...items.filter(keep))`, not a `splice` for each item.
- Under `unwrap`, a pending slot reads as `undefined`.
  Give defaults when you destructure a snapshot.
- `break` in `for await` detaches one consumer, and the sources keep running.
  Bind the select with `using`, or call `state[Symbol.dispose]()`.
- A `changes` reader that you do not finish keeps the log in memory (SE-14B).
  Call `return()`, call `[Symbol.dispose]()`, or bind the reader with `using`.
- A default `Channel` keeps each value until a consumer reads it, because a later consumer can read the head.
  Use `{ firstReceive: "latest", thenReceive: "latest" }` for a current value.
- `send`, `close` and `mapSnapshot` results cannot be thenables (CH-013, SE-052).
- `send` on a closed channel throws a `StopError` (CH-014).

## Components

- Set `"jsx": "react-jsx"` and `"jsxImportSource": "@xazzzi/gg"`.
- A component runs one time for each use.
  There is no re-render, no hook and no diff.
- A plain function component returns nodes.
- An async generator component yields its root node, then changes the nodes that it owns.
  It yields again only to replace its root, or to wake its host with the same node (JX-025).
- A promise or an async iterable is a dynamic child.
  A channel of strings is live text.
- `on*` props with a function become listeners, and the event type is the lower case rest of the key.
- Cast elements to their DOM type: `<input /> as HTMLInputElement`.

```tsx
async function* Title({ title }: { title: Channel<string> }) {
  const h1 = (<h1 />) as HTMLElement;
  yield h1;
  for await (const text of title) h1.textContent = text;
}
```

## Lists with each

- `each(state, render)` needs a select proxy with an array shape (JX-030).
- `render` gets an `Item<T>` for one item, and runs one time for that item.
  `item.value` is the current value, so a component reads its first props with no `await`.
- A write to an item gives the new value to the same `Item`, so the instance stays (JX-034).
- `for await (const value of item)` reads a `"latest"` channel that the `Item` makes at the first iteration (JX-03F).
  To combine an item with other sources, put it in a `select`.
- An item that leaves ends its `Item` (JX-035).
  Its `signal` aborts, and a `for await` on it ends.
- An instance that finishes while its item stays renders again with the next value (JX-03C).
  So a component can read its item once and return.
- A move moves nodes and does not render again.
  So does a `splice` that keeps items, such as a filter, because `applyOps` matches items by value (HE-04H).
- A busy list applies all changes since its last read in one pass.

## Limits of the runtime

- A dynamic child ends only when its source finishes (JX-040).
  Removal of its nodes does not end it.
  Close the channel that a component reads to end the component.
- An element with dynamic children belongs to the runtime (JX-043).
  Do not add or remove its children by hand.
  You can change attributes and the content of nodes inside an entry.
- A rejected dynamic child calls `globalThis.reportError`, and keeps its nodes (JX-028).

## Mirrors without JSX

`changes(state)` gives `outputs` and batches of operations, and `applyOps` replays them onto a copy.
`applyOps(target, ops, map)` derives one entry for each item that lands, so it can build nodes or view models.
An item that leaves and comes back in one call keeps its entry, with no `map` call.

```ts
using reader = changes(items);
const mirror = [...reader.outputs];
for await (const ops of reader) applyOps(mirror, ops);
```

## Helpers

- `catching(source, onError)` ends a source quietly on failure, so an `unwrap` select stays open.
- `abortable(promise, signal)` waits for a promise until a signal aborts.
- `spread` with `mapSnapshot: spread` turns `Val` fields into `kLoading`, `kError` and `kDone` keys.
- `isVal(value)` tests for a `Val`, across copies of the library.
