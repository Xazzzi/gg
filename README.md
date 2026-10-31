# @xazzzi/gg [![CI](https://github.com/Xazzzi/gg/actions/workflows/ci.yml/badge.svg)](https://github.com/Xazzzi/gg/actions/workflows/ci.yml)

Tiny zero-dependency concurrent primitives for JavaScript and TypeScript.
`Channel` moves values, `feed` fills channels from sources, and `select` combines sources into one state.

Requires Node 22 or later, and is ESM only.


```sh
npm install @xazzzi/gg
```


## Channel

`Channel` is an async stream with multiple producers and multiple consumers.

```ts
import { Channel } from "@xazzzi/gg";

const ch = new Channel<number>({ thenReceive: "every" });
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

Defaults are `firstReceive: "unread"`, `thenReceive: "latest"` and `stopStyle: "drain"`.
`stopStyle: "stop"` discards values not yet read when the channel ends.

## feed

`feed` moves a promise or iterator into a channel, and several calls merge their sources.
The channel closes after the last source finishes, and a source failure fails the channel.

```ts
import { Channel, feed } from "@xazzzi/gg";

async function* lines(name: string) {
  yield `${name}: ready`;
}

const ch = new Channel<string>({ thenReceive: "every" });
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

## Helpers

- `abortable(promise, signal)` waits for a promise until a signal aborts.
- `catching(source, onError)` wraps a source so a failure ends it quietly.
- `spread` turns `Val` fields into `kLoading`, `kError` and `kDone`, for `mapSnapshot: spread`.
- `isVal(value)` tests for a `Val`, across copies of the library.

## Specification

[`spec/`](spec/) defines intended behaviour, with numbered rules that the tests reference.
[`learn-gg.ts`](learn-gg.ts) is a runnable tour of the library, and needs `npm run build` first.

## License

MIT
