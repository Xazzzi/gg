# Scope

This file records the intended features of the library and the decisions behind them.
The rules are in `channel.md`, `feed.md`, `select.md`, `helpers.md`, `jsx.md` and `devtools.md`.
If the specs and the docs, tests or code do not agree, the specs have priority.

## Purpose

`gg` provides minimal primitives for other code.
`Channel` and `feed` move values.
`select` is the base for app state and messages.
Developer experience is a primary constraint.
The library does no work if no code observes the result.

## Spec format

A spec is a list of numbered rules with stable IDs, such as `CH-012`.
The ID of a removed rule stays unused.
So the numbers can have gaps.
An agent MUST be able to implement a spec from that file and the specs that it names.
The name of a test contains the ID of its rule.
One test can name many rules.
SE-139 and SE-13A have no test, because they define no behaviour.
Coverage does not replace this link, because covered code can still break a rule.
Spec text follows ASD-STE100 Simplified Technical English.
Each sentence has one statement.
Each sentence uses the active voice.
Each word has one meaning.
Code names, key words and the terms in each spec are technical names.
A rule refers to another rule by its ID, with or without parentheses, such as CH-012 or (CH-012).
An example comment that starts with `=>` shows the real result.
`npm run examples` writes these comments.
`npm run checks` fails if a comment differs from the real result.

These words have one meaning in all specs:

- **Discard**: remove a value so that no code gets it.
- **Retain**: prevent garbage collection.
- **Ignore**: take no action for an error.
- **Abandon**: make no more use of an object and not end it.
- **Block**: stay pending until an event occurs.
- **Finish**: an iterator produces `done: true` or fails.
- **End**: a consumer or a run does no more work.
- **Close**: make a channel terminal with no error.

## Decided

- Array shapes stay in `select`.
- Consumers can replay array changes onto a derived structure, such as DOM nodes. Consumers then need no array diff and no keyed nodes.
- `onChanges` gets an operation log. It replaces `changeValues` and `RelocatedProxy`.
- With `unwrap`, consumers read values and do not extract `.value`. `unwrap` replaces `simple`. A rejection under `unwrap` fails the channel.
- `spread` is a snapshot projection. Use it as `mapSnapshot: spread`.
- `applyOps` is the only replay of operations. Its optional `map` makes derived entries.
- `changes` gives readers of one shared operation log for each `select`. A read takes all reported operations since the previous read, so a busy observer skips intermediate states. A reader carries `outputs`, because a proxy read returns sources.
- State does not depend on the UI. Code can read the changes of any `select` after construction, so `onChanges` is only the synchronous path.
- A proxy read returns a source, because `State` keeps the input types.
- `sort` compares sources, because all proxy methods operate on sources. `sortOutputs` is the explicit method that compares outputs.
- `select` does not call `return()` on a removed source, because the source returns to the caller.
- `Channel` rejects thenables. Projections are synchronous.
- A global devtools hook gives the Chrome extension in `devtools/` access to internal state. The hook is not public API. The extension needs no full spec coverage.
- `StopError`, `isVal` and `CHAN` operate across copies of the library. A `Channel` and the `feed` that uses it MUST come from one copy.
- The root exports the JSX runtime too, because it adds little to a bundle, and `sideEffects: false` lets a bundler drop it. The `@xazzzi/gg/jsx-runtime` entry exists for the JSX transform. The runtime has no virtual DOM. A component instance changes its own nodes, `select` drives the instances, and `each` replays a reader of `changes` with `applyOps`.
- `each` is a dynamic child, so it shares a host with other children and owns only its own nodes.
- A host tracks dynamic children by key, not by index, because an index write to a `select` replaces the source (SE-088).

## Defaults

Each default follows from the purpose: the library does no work if no code observes the result.
An observer of a `select` is a consumer of its channel, or a reader from `changes` that reads.
`onChanges` is not an observer, because it cannot start or slow the select.

- `Channel` defaults to `firstReceive: "unread"`, `thenReceive: "every"`, `stopStyle: "drain"` and `ackStyle: "any"` (CH-001).
  So a channel is a queue that discards no value, and the first read of a value settles its `asend`.
- `feed` defaults to `autoClose: true` (FE-001).
  A feed is a pipe, so its channel closes after the last source finishes, and `for await` on that channel ends.
- `select` defaults to `autoClose: false` (SE-001).
  A select is state, so it stays open until code closes it, and later writes stay tracked.
  A join of sources sets `autoClose: true`, so that `for await` ends when the sources finish.
- `autoStart: false` makes the sources of a `feed` or a `select` start at the first observer (FE-001, SE-030, SE-037).
  So a select with only `onChanges` needs `autoStart`.
- `backPressure: true` makes a producer wait until an observer reads its last value (FE-001, SE-042).
  For a `select`, a reader that reads, or that waits with nothing to read, counts under `ackStyle: "any"` (SE-04A).
  So a select with only `onChanges` needs `nonYielding` or `backPressure: false`.
- `nonYielding: false` makes a select publish snapshots, because `for await` is the main way to read it.
  Set `nonYielding: true` when only readers or `onChanges` read the state, so that no flush builds a snapshot.
- `unwrap: false` keeps the `status` of each source visible in a `Val`.
  Under `unwrap`, a pending slot reads as `undefined`, and a rejection fails the channel.
- `select` defaults to `thenReceive: "latest"` (SE-002).
  A consumer of state needs the newest snapshot, so a slow consumer skips the snapshots between its reads.
- A write to a terminal select changes the proxy, and does not throw (SE-08A).
  The proxy acts as a plain object, so code that only assigns does not expect an error.

## Package exports

The package root MUST export these names.
The `./jsx-runtime` and `./jsx-dev-runtime` entries MUST export the names of `jsx.md`, which the JSX transform imports.
No other name is public.
The package MUST set `sideEffects: false`, so that a bundler can remove unused helpers.

| Spec         | Values                                                                                             | Types                                                                                             |
| ------------ | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `channel.md` | `Channel`, `latest`, `StopError`                                                                   | `ChannelOptions`, `FirstReceive`, `ThenReceive`, `StopStyle`, `AckStyle`                          |
| `feed.md`    | `feed`                                                                                             | `Source`, `FeedOptions`                                                                           |
| `select.md`  | `select`, `changes`, `watch`, `CHAN`                                                               | `SelectShape`, `SelectOptions`, `Snapshot`, `Unwrapped`, `State`, `Val`, `Op`, `Changes`, `Watch` |
| `helpers.md` | `abortable`, `applyOps`, `catching`, `derive`, `isVal`, `spread`                                   | `Caught`, `Spread`                                                                                |
| `jsx.md`     | `jsx`, `jsxs`, `jsxDEV`, `Fragment`, `mount`, `each`, `createContext`, `Provide`, `consume`, `use` | `Static`, `Dynamic`, `Child`, `Props`, `Item`, `Context`, `JSX` (also entry `./jsx-runtime`)      |
