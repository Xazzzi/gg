# Scope

This file records what the library intends to provide, and the decisions behind it.
Rules live in `channel.md`, `feed.md`, `select.md` and `helpers.md`.
The specs take precedence over docs, tests and code when they disagree.

## Purpose

`gg` provides minimal primitives to build on.
`Channel` and `feed` move values.
`Select` is an app state and messaging backbone.
Developer experience is a first-class constraint.
The library does no work that nothing observes.

## Spec format

Specs are numbered prose rules with stable IDs, such as `CH-012`.
A cut rule's ID is never reused, so gaps in numbering are expected.
Each spec is self-contained, and an agent MUST be able to implement from it alone.
Tests reference rule IDs in their names.
Gherkin is not used.

## Decided

- Array shapes stay in `Select`.
- Array changes must be replayable onto a derived structure, such as DOM nodes.
  This avoids array diffing and keyed nodes in consumers.
- `onChanges` receives an operation log.
  It replaces `changeValues` and `RelocatedProxy`.
- `unwrap` lets consumers read values without extracting `.value`.
  It replaces `simple`, and a rejection under it fails the channel.
- `spread` is a snapshot projection, passed as `mapSnapshot: spread`.
- `applyOps` is the one replay of `onChanges`, with an optional `map` for derived entries.
- Proxy reads return sources, because `State` keeps the input types.
- `sort` follows the proxy and compares sources, so `sortOutputs` is the explicit way to compare outputs.
- Removed sources are not closed, because they return to the caller.
- `Channel` rejects thenables, and projections are synchronous.
- `StopError`, `isVal` and `CHAN` work across library copies.
  A `Channel` and the `feed` using it must come from one copy.
- `nonYielding` stays, so `Select` builds no snapshots when nothing reads them.
- Sync iterators stay.

## Package exports

The package root MUST export these names, and nothing else is public.
The package MUST set `sideEffects: false`, so unused helpers can be tree-shaken.

| Spec         | Values                                     | Types                                                                         |
| ------------ | ------------------------------------------ | ----------------------------------------------------------------------------- |
| `channel.md` | `Channel`, `StopError`                     | `ChannelOptions`, `FirstReceive`, `ThenReceive`, `StopStyle`                  |
| `feed.md`    | `feed`                                     | `Source`, `FeedOptions`                                                       |
| `select.md`  | `select`, `CHAN`                           | `SelectShape`, `SelectOptions`, `Snapshot`, `Unwrapped`, `State`, `Val`, `Op` |
| `helpers.md` | `abortable`, `catching`, `isVal`, `spread` | `Caught`, `Spread`                                                            |

## Cuts

| Surface                            | Action          | Reason                                                   |
| ---------------------------------- | --------------- | -------------------------------------------------------- |
| `name` option                      | Cut             | Nothing reads it.                                        |
| `channel()` factory                | Cut             | It only wraps `new Channel`.                             |
| `Channel.pipe()`, `Channel.feed()` | Cut             | They make `Channel` depend on `feed`.                    |
| `pipe()`                           | Cut             | It only saves one line over `new Channel` plus `feed`.   |
| `send(value, nextAck)`             | Internal        | It exposes ack machinery.                                |
| `STOP` export                      | Internal        | `StopError` covers the public need.                      |
| `isStopError`                      | Cut             | `instanceof StopError` replaces it.                      |
| `onReturn`                         | Cut             | `onReturn: "ignore"` equals `autoClose: false`.          |
| `holdDone`                         | Fixed behaviour | The option adds little.                                  |
| `closed`                           | Cut             | `abortable` covers racing APIs that lack signal support. |
| `onThrow`                          | Cut             | `catching` replaces it.                                  |
| `autoClose: "strong"`              | Cut             | `feed` returns a promise that can close the channel.     |
| `feed` sync source guard           | Cut             | Always-ready async sources starve the event loop too.    |
| `mapFields`, `FieldMapper`         | Cut             | `unwrap` and `mapSnapshot` cover them.                   |
| `Symbol.asyncDispose`              | Cut             | It would only repeat `Symbol.dispose`.                   |
| Parking, `unsend`                  | Cut             | It requires patching the caller's iterator.              |
