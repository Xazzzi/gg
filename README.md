# @xazzzi/gg [![CI](https://github.com/Xazzzi/gg/actions/workflows/ci.yml/badge.svg)](https://github.com/Xazzzi/gg/actions/workflows/ci.yml)

Zero-dependency concurrent primitives for JavaScript and TypeScript.
`Channel` moves values, `feed` fills channels from sources, and `select` combines sources into one state.

14kB gzipped, tree-shakeable.
Features 100% coverage, including Stryker mutation tests.
Requires Node 24 or later, or a browser with `Promise.withResolvers`. ESM only, and `require` loads it too.
The examples use `using`, which needs a transpiler in most browsers.

WARNING: Experimental project coded by Opus 5.5. No warranty, use at own risk.

```sh
npm install @xazzzi/gg
```


## Channel

`Channel` is an async stream with multiple producers and multiple consumers.

```ts
import { Channel } from "@xazzzi/gg";

const ch = new Channel<number>();
ch.send(1);
ch.send(2);
ch.close();
for await (const n of ch) console.log(n); // 1, then 2
```

`send` never blocks.
`asend` resolves when a consumer reads the value, which gives backpressure.
`close` and `throw` end the channel, and producers then receive a `StopError`.

Options select the mode:

| firstReceive | `every`              | `latest`             | `unread`   |
| ------------ | -------------------- | -------------------- | ---------- |
| `first`      | Replay all, then all | Value 1, then newest | Invalid    |
| `unread`     | Head, then all       | Head, then newest    | Work queue |
| `latest`     | Newest, then all     | Newest, then newest  | Invalid    |
| `next`       | Future values only   | Next, then newest    | Invalid    |

Defaults are `firstReceive: "unread"`, `thenReceive: "every"`, `stopStyle: "drain"` and `ackStyle: "any"`.
`latest()` makes a channel of a current value, with `firstReceive: "latest"` and `thenReceive: "latest"`.
`stopStyle: "stop"` discards values not yet read when the channel ends.
`ackStyle: "all"` makes `asend` wait for every consumer, so a slow consumer holds at most one unread value for each producer that awaits.

## feed

`feed` moves a promise or iterator into a channel, and several calls merge their sources.
The channel closes after the last source finishes, and a source failure fails the channel.

```ts
import { Channel, feed } from "@xazzzi/gg";

async function* lines(name: string) {
  yield `${name}: ready`;
}

const ch = new Channel<string>();
feed(lines("a"), ch);
feed(lines("b"), ch);
for await (const line of ch) console.log(line);
```

## select

`select` publishes a snapshot of a whole shape whenever a source changes.
The shape stays mutable, so sources can be added, replaced and removed.

```ts
import { select } from "@xazzzi/gg";

// `using` closes the state at the end of the block, which stops its sources.
using state = select({ title: "Users", users: fetchUsers() }, { unwrap: true });
for await (const { title, users } of state) render(title, users);
```

Without `unwrap`, each source appears as a `Val` with `status`, `value`, `reason` and `done`.
A select records each change as an ordered operation, so arrays can be replayed without diffing.
`changes(state)` gives a reader of those operations at any time, and each read takes all of them since the last read.
`outputs(state)` gives the current outputs, with no reader to finish.
`changes(state, keys)` reads only some slots, and `watch(state, key)` gives the values of one slot, so a reader of one field wakes only when that field changes.
`sort` and `reverse` move slots without restarting sources, and `sort` compares sources.
`sortOutputs` moves slots the same way, and compares outputs once.

A select starts at its first observer, which is a `for await` or a read of `changes`, and stays open until code closes it.
[`spec/scope.md`](spec/scope.md#defaults) gives the reason for each default.

`break` detaches one consumer, and leaves the sources open.
Bind the state with `using`, or call `close` in `finally`, to stop them.

```ts
using state = select({ users: pollUsers() }, { unwrap: true });
for await (const { users } of state) if (users?.length) break;
```

## Helpers

- `abortable(promise, signal)` waits for a promise until a signal aborts.
- `catching(source, onError)` wraps a source so a failure ends it quietly.
- `derive(source, map)` maps each value of an async iterable, so a dynamic prop or child follows a computed value.
  When `map` reads one key of a `select`, use `derive(state, key, map)`, so `map` runs only when that key changes.
- `iff(source, then, otherwise?)` gives one of two values for a truthy or falsy source, and calls a function branch at each change, so a `Channel<boolean>` gates a view or picks a prop value.
  `derive` and `iff` stop the views that their map built, when the next output replaces them. A view that other code built is parked while it is out of the tree, and stops with the `mount` or the `each` entry above it.
- `spread` turns `Val` fields into `kLoading`, `kError` and `kDone`, for `mapSnapshot: spread`.
- `isVal(value)` tests for a `Val`, across copies of the library.
- `applyOps(target, ops, map?, { eager })` replays operations onto a mirror, and `map` derives each entry.
  An item that leaves and comes back in one call keeps its entry.
  It folds a report or a read first, so `map` runs only for entries that land, and `eager` maps every step.

## JSX

The JSX runtime builds DOM nodes from JSX, with no virtual DOM.
Set `"jsx": "react-jsx"` and `"jsxImportSource": "@xazzzi/gg"`.
A bundler drops it from code that does not use it.

A component is an async generator function, and each use gives one instance.
The instance yields its node, then changes the nodes it owns.
It yields again only to replace its node, or to wake its host with the same node.
A promise or an async iterable is a child, so a channel of strings is live text.
A fragment takes such children too, and its host drives them.
Props set attributes, and `value`, `checked`, `selected`, `indeterminate` and `muted` set properties.
An `on` prop takes only a function, and a URL attribute rejects a `javascript:` URL, so data in a prop cannot run code.
Each HTML and SVG tag has typed listeners and live properties, and takes any other attribute.
A promise or an async iterable prop is live, and sets its attribute or property with each value.
SVG tags get the SVG namespace, and an `xmlns` prop sets any namespace.
`mount` returns a function that stops the components and empties the parent.
An element runs its dynamic children only once `mount` or a host places it, so a detached element costs nothing.
`<Provide context={Key} value={v}>` gives a value to the components inside it, and a component reads it with `const v = yield* use(Key)`.
It uses the `context-request` event of the web components community protocol, so it works with other libraries that follow it.

```tsx
import { type Channel, each, mount, select } from "@xazzzi/gg";

async function* Row({ todo }: { todo: Channel<Todo> }) {
  const li = (<li />) as HTMLLIElement;
  yield li;
  for await (const { title } of todo) li.textContent = title;
}

// Only each reads todos, so it builds no snapshots.
const todos = select([] as Todo[], { nonYielding: true });
mount(
  document.body,
  <ul>
    {each(todos, todo => (
      <Row todo={todo} />
    ))}
  </ul>,
);
```

`each` reads the changes of `todos` with `changes`, and replays them onto its rows.
It gives each item a channel, sends it each new value, and closes it when the item leaves.
A row that leaves also stops the dynamic children and dynamic props inside it.
A row that finishes renders again with the next value, so a row can also read its item once.
So a row updates itself, and the list moves only nodes that change place.
State needs no UI code, and a busy list renders all changes since its last read in one pass.
[`examples/todomvc`](examples/todomvc) renders with it, [`examples/orbits`](examples/orbits) draws a simulation in SVG with views that mount and unmount, and [`examples/forms`](examples/forms) binds each kind of input to one state.

## Specification

[`spec/`](spec/) defines intended behaviour, with numbered rules that the tests reference.
[`learn-gg.tsx`](learn-gg.tsx) is a runnable tour of the library and its JSX, and `npm run learn` runs it.

## License

MIT
