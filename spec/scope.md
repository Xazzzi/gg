# Scope

This file records the intended features of the library and the decisions behind them.
The rules are in `channel.md`, `feed.md`, `select.md` and `helpers.md`.
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
- `applyOps` is the only replay of `onChanges`. Its optional `map` makes derived entries.
- A proxy read returns a source, because `State` keeps the input types.
- `sort` compares sources, because all proxy methods operate on sources. `sortOutputs` is the explicit method that compares outputs.
- `select` does not call `return()` on a removed source, because the source returns to the caller.
- `Channel` rejects thenables. Projections are synchronous.
- `StopError`, `isVal` and `CHAN` operate across copies of the library. A `Channel` and the `feed` that uses it MUST come from one copy.

## Package exports

The package root MUST export these names.
No other name is public.
The package MUST set `sideEffects: false`, so that a bundler can remove unused helpers.

| Spec         | Values                                                 | Types                                                                         |
| ------------ | ------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `channel.md` | `Channel`, `StopError`                                 | `ChannelOptions`, `FirstReceive`, `ThenReceive`, `StopStyle`                  |
| `feed.md`    | `feed`                                                 | `Source`, `FeedOptions`                                                       |
| `select.md`  | `select`, `CHAN`                                       | `SelectShape`, `SelectOptions`, `Snapshot`, `Unwrapped`, `State`, `Val`, `Op` |
| `helpers.md` | `abortable`, `applyOps`, `catching`, `isVal`, `spread` | `Caught`, `Spread`                                                            |
