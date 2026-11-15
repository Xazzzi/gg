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
  With `ackStyle: "all"`, `asend` waits for every consumer, so a slow consumer under `"every"` holds at most one unread value for each producer that awaits (CH-01E).
- A `select` is a mutable proxy over an object or array shape.
  Each key is a slot with a source: a plain value, a promise or an async iterable.
  A change publishes a snapshot of the whole shape to the channel of the select.
  It also reports ordered operations to readers from `changes`.
- A read through the proxy gives the source, not its value (SE-080).
  Read values from a snapshot, from `for await`, or from `outputs(state)`.
- `select` tracks only the top level of the shape.
  A nested object needs its own `select`, or a replacement of the whole item.
- No work occurs when no code observes the result.
  An observer of a select is a `for await` consumer, or a reader from `changes` that reads.
  `watch` and `each` read through `changes`, so they observe too.

We recommend that state does not import UI code.
The UI then reads state through `for await`, `changes` and `each`, and state stays testable without a DOM.

## Options that matter

| Option         | Default | Use                                                                         |
| -------------- | ------- | --------------------------------------------------------------------------- |
| `autoStart`    | `false` | Without it, a select starts at its first observer (SE-030, SE-037).         |
| `autoClose`    | `false` | Set `true` to close the select when its sources finish, as a join.          |
| `backPressure` | `true`  | A flush waits until a consumer reads, or a reader reads or waits (SE-04A).  |
| `nonYielding`  | `false` | Set `true` when only `changes` or `each` read, to skip snapshots.           |
| `unwrap`       | `false` | Gives values, not `Val` objects. A rejection then fails the channel.        |

`feed` has the same `autoStart` and `backPressure` defaults, but `autoClose: true` (FE-001).
[`spec/scope.md`](https://github.com/Xazzzi/gg/blob/master/spec/scope.md#defaults) gives the reason for each default.

## Pitfalls

- With `autoClose: true`, a select of plain values closes after its first flush (SE-074).
  After that, writes change the proxy with no tracking and no error (SE-08A).
- Under `ackStyle: "all"`, only snapshot consumers release a flush, so a select with only readers stops at its first publish (SE-04A).
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
  To read the current outputs one time, call `outputs(state)`, which makes no reader (SE-14D).
  Call `return()`, call `[Symbol.dispose]()`, or bind the reader with `using`.
- A default `Channel` keeps each value until a consumer reads it, because a later consumer can read the head.
  Use `latest()` for a current value, which sets `firstReceive: "latest"` and `thenReceive: "latest"` (CH-006).
- A misspelled option key throws a `TypeError` (CH-005, SE-008, FE-004).
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
- `on*` props with a function become listeners, and the event type is the lower case rest of the key. Another value at an `on*` key throws (JX-008).
- A `javascript:` URL at `href`, `src`, `action`, `formaction` or `xlink:href` throws (JX-009).
- Other props set attributes, except `value`, `checked`, `selected`, `indeterminate` and `muted`, which set properties (JX-002).
- A promise or an async iterable prop is live, so `class={channel}` changes the attribute with each value, and `null`, `undefined` or `false` removes it (JX-064).
  An `on*` prop cannot be dynamic (JX-060).
- `derive(source, map)` maps each value of a `select`, a `Channel`, a `watch` or an `Item`, so a dynamic prop or child follows a computed value (HE-051).
  ``class={derive(view, "filter", filter => `list-${filter}`)}`` needs no loop in the component.
  When a map reads one key, use `derive(state, key, map)`, so the map runs only when that key changes (HE-054).
  `derive(state, map)` runs the map on every snapshot.
- `iff(gate, () => <View />, otherwise?)` shows a view while a source is truthy, and `class={iff(gate, "active")}` picks a prop value (HE-061).
  `derive` and `iff` stop the views that their map built at the next output (HE-059).
  A node that code built outside the map is parked while it is out of the tree, and resumes when an output holds it again (JX-082).
  An output can hold dynamic children, so a component can yield another component (JX-085).
- SVG tags get the SVG namespace (JX-001).
  `a`, `script`, `style` and `title` inside an SVG element need `xmlns="http://www.w3.org/2000/svg"`.
- Cast elements to their DOM type: `<input /> as HTMLInputElement`.

```tsx
async function* Title({ title }: { title: Channel<string> }) {
  const h1 = (<h1 />) as HTMLElement;
  yield h1;
  for await (const text of title) h1.textContent = text;
}
```

## Context

- `const Form = createContext<Form>(Symbol("form"))` makes a key.
- `<Provide context={Form} value={form}><main>…</main></Provide>` answers for its one element child.
- In a component, `const form = yield* use(Form)` yields a placeholder, waits until it is placed, and gives the value (JX-054).
  Build the nodes after it, and the next yield replaces the placeholder.
- In an event handler, `consume(event.currentTarget, Form)` gives the value at once (JX-053).
- Provide a `Channel` or a `select` for a value that changes.
- Pass app state through context instead of module-level constants, so a test mounts a component under its own provider.

## Lists with each

- `each(state, render)` needs a select proxy with an array shape (JX-030).
- `render` gets an `Item<T>` for one item, and runs one time for that item.
  `item.value` is the current value, so a component reads its first props with no `await`.
- A write to an item gives the new value to the same `Item`, so the instance stays (JX-034).
- `for await (const value of item)` reads a `"latest"` channel that the `Item` makes at the first iteration (JX-03F).
  To combine an item with other sources, put it in a `select`.
- An item that leaves ends its `Item`, and stops the dynamic children and dynamic props inside its nodes (JX-035).
  Its `signal` aborts, and a `for await` on it ends.
- An instance that finishes while its item stays renders again with the next value (JX-03C).
  So a component can read its item once and return.
- A move moves nodes and does not render again.
  So does a `splice` that keeps items, such as a filter, because `applyOps` matches items by value (HE-04H).
- A busy list applies all changes since its last read in one pass.
- Use `each` for an array, not a `watch` or a slice reader for each row.
  `each` reads the array once and gives each `Item` only the changes of its row, while a reader per row wakes on each report.
- In a row, read other state with `watch(state, key)`, so a change of another key does not wake the row.
  Do not give every row a `watch` of one shared key, such as a selected id, because one change then wakes all rows.
  Write the change into the rows that it affects, as `examples/bench` does with `selected`.

## Limits of the runtime

- A dynamic child ends only when its source finishes, when its host stops, or when its row leaves `each` (JX-040, JX-035).
  Removal of its nodes does not end it.
  Close the channel that a component reads to end the component.
- `mount` returns an unmount function (JX-02A).
  It stops every host inside the parent, which ends `each` lists and their items, and empties the parent.
  A component that waits on an open channel still ends only when that channel closes (JX-041).
- An element with dynamic children starts only when `mount` or a host places it (JX-02B).
  An element that you `append` by hand stays idle (JX-045), so yield it or make it a child.
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

`changes(state, keys)` reads only the slots that `keys` names, and a report without them does not wake it.
An array index names a slot, which the reader follows when the array moves it.
`watch(state, key)` gives the output of one slot, then each new one, so a control of one field skips the others.

```ts
for await (const volume of watch(form, "volume")) input.valueAsNumber = volume;
```

## Helpers

- `catching(source, onError)` ends a source quietly on failure, so an `unwrap` select stays open.
- `abortable(promise, signal)` waits for a promise until a signal aborts.
- `spread` with `mapSnapshot: spread` turns `Val` fields into `kLoading`, `kError` and `kDone` keys.
- `isVal(value)` tests for a `Val`, across copies of the library.
