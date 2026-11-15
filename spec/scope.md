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
`npm run spec:examples` writes these comments.
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
- A value takes the mirror entry of the same value first, and the entry of its index second (HE-04H). So index assignments that swap values move rows, and an immutable update at an index updates the row there, with no key. `key` is an option: an entry then belongs to the key of the output, so a new key at an index renders a new row. A slot that gives a new output keeps its entry (SE-10C).
- `select` records an operation log. It replaces `changeValues` and `RelocatedProxy`.
- With `unwrap`, consumers read values and do not extract `.value`. `unwrap` replaces `simple`. A rejection under `unwrap` fails the channel.
- `spread` is a snapshot projection. Use it as `mapSnapshot: spread`.
- `applyOps` is the only replay of operations. Its optional `map` makes derived entries.
- `changes` gives readers of one shared operation log for each `select`. A read takes all reported operations since the previous read, so a busy observer skips intermediate states. A reader carries `outputs`, because a proxy read returns sources.
- State does not depend on the UI. Code can read the changes of any `select` after construction with `changes`.
- `select` has no change callback. A callback is not an observer, so it needed `autoStart` and a way to skip snapshots, and its throw failed the channel. A reader of `changes` gets the same operations. The JSX host keeps an internal report hook for its drives.
- `select` has worklists, key slices and observed flushes, because the library does no work that no observer needs. The worklists let a flush skip the slots that cannot change (SE-048). Key slices wake only the readers of the changed keys (SE-153). An observed flush lets a reader release backpressure (SE-04A). A simpler `select` walks the shape at each change, or wakes each reader at each report. `select.ts` runs the slots and the flush, and `log.ts` holds the operation log and its readers, so that each part reads alone.
- Under `thenReceive: "unread"`, a send wakes one blocked consumer, and the other modes wake all (CH-075). Only one consumer reads a value in a work queue, and each consumer reads each value in the other modes.
- A place walks the nodes that it adds, to start the waiting elements in them (JX-02B). It walks only while a wait exists. Code built those nodes just before, so the walk adds a constant factor to that work. A view that code keeps out of the tree keeps its wait, but the walk still covers only the nodes that a place adds.
- `Channel` has no buffer limit. A limit is not a concern of the producer, and a producer MUST NOT see a different behaviour because of one. A producer that must not run ahead awaits `asend`.
- `break` detaches one consumer and leaves the sources open, because a channel cannot know that no other consumer attaches later. `using` or `close` ends them. The library gives no warning for a state that code abandons.
- One failure ends a state: a rejection under `unwrap` and a throw of `mapSnapshot` fail the channel. Code that must continue reads `Val`s without `unwrap`, or wraps the source with `catching`.
- A pull binds only what code opens in it, so what a component opens after an `await` or a `yield*` is not bound (JX-041). Only `AsyncContext` can carry the pull across an `await`, and no browser has it. A plain `yield` of the same node before that code binds what it opens.
- The JSX runtime has error boundaries along scopes (JX-090). A component cannot catch the failure of a view that it yielded, because an async generator queues `throw()` behind a pending `next()` (JX-041). A component that must continue after an error uses `try` around the source that it reads, or `catching`.
- A failure that no code can catch is loud. The nearest boundary takes it, or the runtime reports it with `reportError`, and a drive that fails to apply a report stops (JX-088, JX-092). An error of a child that no view shows goes only to `reportError` (JX-094).
- `jsx` follows the DOM, except that it rejects a text at an `on` key and a `javascript:` URL (JX-008, JX-009). These are the two ways in which data in a prop runs code. Other risks, such as `srcdoc`, a `script` child or a tag name from data, stay with the code that passes the data.
- JSX has no syntax for properties. A custom element gets its own properties as properties (JX-0B0). Only the class of the element defines them, so data reaches no sink of the DOM (JX-0B1). A guess from `name in element` alone would reach `innerHTML`.
- A custom element of a tag with no definition holds its prop values until the definition (JX-0B2). So the order in which code loads does not change whether a value becomes a property or an attribute. The hold delays only the writes of those values, and no part of the lifecycle of the element (JX-0B3).
- A static `null` or `false` at a live property or an own property is assigned, as the output of a dynamic prop is (JX-002, JX-063). So `<my-toggle open={false}>` turns off a default of the class. A static `undefined` sets nothing, because it stands for a prop that code leaves out.
- The event type keeps the case of its key, unless the element has a handler property for the key in lower case (JX-002). So `onClick` listens to `click`, and a custom event such as `itemSelected`, which bubbles to any element, gets a listener. Only a standard event with no handler property, such as `focusin`, needs its key in lower case.
- The package has one entry for the primitives and the JSX runtime, while a bundler can drop the runtime. The runtime adds about 3.3 kB gzipped. A separate entry is due only if it adds more than 4 kB.
- A proxy read returns a source, because `State` keeps the input types.
- `sort` compares sources, because all proxy methods operate on sources. `sortOutputs` is the explicit method that compares outputs.
- `select` does not call `return()` on a removed source, because the source returns to the caller.
- `Channel` rejects thenables. Projections are synchronous.
- A global devtools hook gives the Chrome extension in `devtools/` access to internal state. The hook is not public API. The extension needs no full spec coverage.
- `StopError`, `spread` and `CHAN` operate across copies of the library. A `Channel` and the `feed` that uses it MUST come from one copy.
- The root exports the JSX runtime too, because it adds little to a bundle, and `sideEffects: false` lets a bundler drop it. The `@xazzzi/gg/jsx-runtime` entry exists for the JSX transform. The runtime has no virtual DOM. A component instance changes its own nodes, `select` drives the instances, and `each` replays a reader of `changes` with `applyOps`.
- A JSX expression has the type `JSX.Element`, and code casts an element to its DOM type, such as `as HTMLInputElement`. TypeScript gives every JSX expression the one type `JSX.Element`, whatever its tag. `JSX.ElementType` only checks which tags and components are valid, and does not change the type of the expression. `JSX.Element` must also hold the result of a component, which is an async generator. So a type per tag is not possible, and a review MUST NOT propose one.
- `each` is a dynamic child, so it shares a host with other children and owns only its own nodes.
- `each` drives all its rows with one drive, and each row adds one slot to its `select`. The rest of the cost of a row is its component, its `Item` and the consumer of each `for await` on the `Item`. No part of this cost is larger than the others, so a row has no single cost to remove.
- Before a place wakes the nodes that it adds, it checks each wait that has not started, to forget the waits of collected nodes (JX-02B). This check costs about 0.4 ms for 10,000 waits, and no app keeps that many views out of the tree. A `FinalizationRegistry` removes the check, but makes each element with a wait slower to create. The library does not optimize a cost of microseconds.
- Under `unwrap`, a source that has not settled reads as `undefined`, so the `map` of `derive` gets `undefined` until the source settles. `undefined` is also a valid value, so `derive` cannot skip it. A default parameter of `map` gives the initial value, so `derive` has no `initial` option.
- A host tracks dynamic children by key, not by index, because an index write to a `select` replaces the source (SE-088).
- The code that builds a view owns it. `derive` and `iff` stop what their `map` built, when the next output replaces it. A node that other code built is only parked when it leaves the tree, so a component can keep views and show one of them.
- Each started element is a scope under the `mount` or the `each` entry above it, so a view that is out of the tree still stops with that scope. The runtime has no public function to stop one node.
- A parked element does no work, because no code observes a node that is not in the tree.
- An output can hold dynamic children. The host drives them as parts of the entry.

## Defaults

Each default follows from the purpose: the library does no work if no code observes the result.
An observer of a `select` is a consumer of its channel, or a reader from `changes` that reads.
The internal report hook is not an observer, because it cannot start or slow the select.

- `Channel` defaults to `firstReceive: "unread"`, `thenReceive: "every"`, `stopStyle: "drain"` and `ackStyle: "any"` (CH-001).
  So a channel is a queue that discards no value, and the first read of a value settles its `asend`.
- `feed` defaults to `autoClose: true` (FE-001).
  A feed is a pipe, so its channel closes after the last source finishes, and `for await` on that channel ends.
- `select` defaults to `autoClose: false` (SE-001).
  A select is state, so it stays open until code closes it, and later writes stay tracked.
  A join of sources sets `autoClose: true`, so that `for await` ends when the sources finish.
- `autoStart: false` makes the sources of a `feed` or a `select` start at the first observer (FE-001, SE-030, SE-037).
- `backPressure: true` makes a producer wait until an observer reads its last value (FE-001, SE-042).
  For a `select`, a reader that reads, or that waits with nothing to read, counts under `ackStyle: "any"` (SE-04A).
- A select publishes snapshots only while its channel has a consumer (SE-045).
  So a select that only readers read builds no snapshot, and needs no option for it.
- `unwrap: false` keeps the `status` of each source visible in a `Val`.
  Under `unwrap`, a pending slot reads as `undefined`, and a rejection fails the channel.
- `select` defaults to `thenReceive: "latest"` (SE-002).
  A consumer of state needs the newest snapshot, so a slow consumer skips the snapshots between its reads.
- A write to a terminal select changes the proxy, and does not throw (SE-08A).
  The proxy acts as a plain object, so code that only assigns does not expect an error.

## Review

A review MUST read this file first.
The entries of Decided and Defaults are intended behaviour.
A review MUST NOT report one of them as a defect, unless it names a rule that the entry breaks.
The project is experimental.
So its age, its commit sizes and its Node 24 floor are not subjects of a review.

## Package exports

The package root MUST export these names.
The `./jsx-runtime` and `./jsx-dev-runtime` entries MUST export the names of `jsx.md`, which the JSX transform imports.
No other name is public.
The package MUST set `sideEffects: false`, so that a bundler can remove unused helpers.

| Spec         | Values                                                                                                      | Types                                                                                                       |
| ------------ | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `channel.md` | `Channel`, `latest`, `queue`, `broadcast`, `replay`, `StopError`                                            | `ChannelOptions`, `PresetOptions`, `FirstReceive`, `ThenReceive`, `StopStyle`, `AckStyle`                   |
| `feed.md`    | `feed`                                                                                                      | `Source`, `FeedOptions`                                                                                     |
| `select.md`  | `select`, `changes`, `outputs`, `watch`, `CHAN`                                                             | `SelectShape`, `SelectOptions`, `Snapshot`, `Unwrapped`, `State`, `Val`, `Op`, `Changes`, `Watch`           |
| `helpers.md` | `applyOps`, `catching`, `derive`, `iff`, `spread`                                                           | `ApplyOptions`, `Caught`, `Derived`, `Spread`                                                               |
| `jsx.md`     | `jsx`, `jsxs`, `jsxDEV`, `Fragment`, `mount`, `each`, `createContext`, `Provide`, `consume`, `use`, `Catch` | `Static`, `Dynamic`, `Child`, `Props`, `Item`, `EachOptions`, `Context`, `JSX` (also entry `./jsx-runtime`) |
