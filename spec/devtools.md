# Devtools

This document uses `Channel` from `channel.md`, `feed` from `feed.md`, `select` from `select.md` and the JSX runtime from `jsx.md`.
The key words MUST, MUST NOT, SHOULD and MAY are normative.

## Purpose

The devtools hook lets a debugger observe channels, feeds and selects, and the components and hosts of the JSX runtime.
The Chrome extension in `devtools/` installs the hook.
The hook is not public API.
So this spec defines only the contract with that extension.

## Terms

- **Hook**: a function at `globalThis[Symbol.for("gg.devtools")]`.
- **Emitter**: the function that the hook returns for one object.
- **Owner**: the target of a `"mount"` or `"each"` registration, for the objects that its runtime creates.

## Registration

- DV-001: The library MUST read the hook when it creates a `Channel`, when `feed` or `select` is called, and for each registration of DV-040 to DV-042, DV-046 and DV-050.
  If the value is not a function, the library does no devtools work for that object.
- DV-002: The library MUST call the hook as `hook(kind, target, detail)`.
  The hook returns an emitter or `undefined`.
- DV-003: The call stack of the hook MUST be the hook, an internal function, the `Channel` constructor, the `feed`, `select`, `jsx` or `each` function or the `[Symbol.asyncIterator]` method of an `Item`, and then the caller.
  For `"mount"`, it MUST be the hook, two internal functions, `mount` or `jsx`, and then the caller.
  So the hook can find the caller in `new Error().stack`.
  A `"reader"` registration has no fixed depth, because `watch` opens its reader inside `next()`.
- DV-004: The library MUST NOT catch errors from the hook or from an emitter.
  The hook MUST NOT throw.

| `kind`        | `target`                         | `detail`                                                                             |
| ------------- | -------------------------------- | ------------------------------------------------------------------------------------ |
| `"channel"`   | The channel                      | `{ firstReceive, thenReceive, stopStyle }`, with defaults applied                    |
| `"feed"`      | The source                       | `{ channel, autoStart, autoClose, backPressure, sendReturn }`, with defaults applied |
| `"select"`    | The proxy                        | `{ channel, array, unwrap, slots }`                                                  |
| `"component"` | What the component returned      | `{ type, props }`                                                                    |
| `"mount"`     | The parent                       | `{}`                                                                                 |
| `"each"`      | The iterator that `each` returns | `{ state }`                                                                          |
| `"item"`      | The `Item`                       | `{ channel }`                                                                        |
| `"reader"`    | The reader that `changes` makes  | `{ state, keys, source }`, with `keys` undefined for a reader of all slots           |

- DV-005: Each `detail` MUST also have `owner`, which is the owner that creates the object, or `undefined`.

## Channel events

- DV-010: `send` MUST emit `("send", value, n)` after the value is in the channel.
  `n` is the number of the value, from 1.
- DV-011: A consumer MUST emit `("attach", reader, source)` when its first `next()` call runs, and `("detach", reader)` when it ends.
  `source` is the slot source of DV-052, or `undefined`.
  `reader` is an object that identifies the consumer.
- DV-012: A read MUST emit `("read", value, n, reader)`.
- DV-013: The first `close` or `throw` MUST emit `("end", failed, result)` before `signal` aborts.

## Feed events

- DV-020: The end of a run MUST emit `("end")`, before auto close.

## Select events

- DV-030: With an emitter, `select` MUST build operations as if `onChanges` exists.
- DV-031: Start MUST emit `("start")`, before the first operation.
- DV-032: Each report MUST emit `("report", ops)` before it calls `onChanges`.
- DV-033: `detail.slots()` MUST return one entry per slot, in slot order.
  An entry is `{ key, kind, sync, source, state, busy, finished }`.
  `kind` is `"plain"`, `"promise"`, `"async"` or `"raw"`.
  `sync` is the SE-014 result for a raw iterator, `false` for an async iterator, and `undefined` otherwise.

## JSX registrations

- DV-040: `jsx` with a function `type` MUST register `"component"` after `type(props)` returns an object.
  A primitive result has no registration.
- DV-041: `mount` and `jsx` MUST register `"mount"` for a parent with a dynamic child, before they create the select that drives it.
- DV-042: `each` MUST register `"each"` before it returns.
- DV-043: The owner of the select that drives the children of a `mount` is the parent.
  The owner of the select that drives the items of `each`, of each item channel, and of its reader of `state`, is the iterator.
- DV-044: The library MUST ignore what the hook returns for `"mount"`, `"each"` and `"item"`.
- DV-045: A host MUST emit `("end")` once to the emitter of a component result that it drives, when the result finishes or fails, leaves the host, or the host stops.

- DV-046: The first iteration of an `Item` MUST register `"item"` after it creates its channel (JX-03F).
  Its owner is the iterator of `each`, which owns the channel too (DV-043).
  So a debugger can link a prop that holds the item to the channel that the component reads.

## Reader events

- DV-050: `changes` MUST register `"reader"` when it opens a reader, and `watch` when it opens its reader (SE-161).
  So a debugger can name the code that reads a select through `changes`, `watch` or `each`.
- DV-051: A reader MUST emit `("end")` one time, when it finishes, or when an array slice has no selected slot left (SE-156).
- DV-053: A read that resolves with operations MUST emit `("read", ops)`, with the operations that it gives.
- DV-052: While a `select` with an emitter calls `next()` on the iterator of a slot, `source` of a `"reader"` registration and of an `"attach"` event MUST be the source of that slot.
  At other times it MUST be `undefined`.
  A host pulls each component result as a slot source, so a debugger can tell which component instance opens a reader.
  Code after an `await` or a `yield*` runs outside the pull, so a reader that it opens has no source.
