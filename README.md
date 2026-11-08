# @xazzzi/gg [![CI](https://github.com/Xazzzi/gg/actions/workflows/ci.yml/badge.svg)](https://github.com/Xazzzi/gg/actions/workflows/ci.yml)

Tiny zero-dependency concurrent primitives for JavaScript and TypeScript.
`Channel` moves values, `feed` fills channels from sources, and `select` combines sources into one state.

10kB gzipped, tree-shakeable.
Features 100% coverage, including Stryker mutation tests.
Requires Node 22 or later. ESM only.

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

Defaults are `firstReceive: "unread"`, `thenReceive: "every"` and `stopStyle: "drain"`.
`stopStyle: "stop"` discards values not yet read when the channel ends.

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

const state = select({ title: "Users", users: fetchUsers() }, { unwrap: true });
for await (const { title, users } of state) render(title, users);
```

Without `unwrap`, each source appears as a `Val` with `status`, `value`, `reason` and `done`.
`onChanges` receives each change as an ordered operation, so arrays can be replayed without diffing.
`changes(state)` gives a reader of those operations at any time, and each read takes all of them since the last read.
`sort` and `reverse` move slots without restarting sources, and `sort` compares sources.
`sortOutputs` moves slots the same way, and compares outputs once.

`break` detaches one consumer, and leaves the sources running.
Bind the state with `using`, or call `close` in `finally`, to stop them.

```ts
using state = select({ users: pollUsers() }, { unwrap: true });
for await (const { users } of state) if (users?.length) break;
```

## Helpers

- `abortable(promise, signal)` waits for a promise until a signal aborts.
- `catching(source, onError)` wraps a source so a failure ends it quietly.
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
Props set attributes, and `value`, `checked`, `selected`, `indeterminate` and `muted` set properties.
SVG tags get the SVG namespace, and an `xmlns` prop sets any namespace.
`mount` returns a function that stops the components and empties the parent.

```tsx
import { type Channel, each, mount, select } from "@xazzzi/gg";

async function* Row({ todo }: { todo: Channel<Todo> }) {
  const li = (<li />) as HTMLLIElement;
  yield li;
  for await (const { title } of todo) li.textContent = title;
}

const todos = select([] as Todo[], {
  autoStart: true,
  autoClose: false,
  nonYielding: true,
});
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
A row that finishes renders again with the next value, so a row can also read its item once.
So a row updates itself, and the list moves only nodes that change place.
State needs no UI code, and a busy list renders all changes since its last read in one pass.
[`examples/todomvc`](examples/todomvc) renders with it, [`examples/orbits`](examples/orbits) draws a simulation in SVG with views that mount and unmount, and [`examples/forms`](examples/forms) binds each kind of input to one state.

## Specification

[`spec/`](spec/) defines intended behaviour, with numbered rules that the tests reference.
[`learn-gg.ts`](learn-gg.ts) is a runnable tour of the library, and needs `npm run build` first.

## License

MIT
