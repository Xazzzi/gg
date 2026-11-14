# Project

The library provides `Channel`, `feed` and `select`, and a JSX runtime, which the root and `@xazzzi/gg/jsx-runtime` export.
`spec/` defines intended behaviour and takes precedence over docs, tests and code.
Read `spec/scope.md` before a review or an evaluation, because its Decided, Defaults and Review sections list what is intentional and not a finding.
All source needs 100% V8 branch coverage and 100% Stryker mutation coverage.

## Layout

- `src/`: `channel.ts`, `select.ts` (`Select` is also the proxy handler, with `Log`, `Reader`, slices and `Watcher`; also `changes`, `outputs`, `watch`, `Val`, `Op`), `feed.ts`, `helpers.ts` (`applyOps` etc.), `source.ts` (`detect`, `open` and other internals of feed, select and catching), `jsx.ts` (runtime, `mount`, and re-exports), `host.ts` (conversion, placement, drives, waits, scopes, parking, output parts and dynamic props), `each.ts`, `context.ts`, `devtools.ts` (hook, `owned`, `register`), `index.ts` (root exports, JSX included).
- `spec/<module>.md`: rules with stable IDs (`CH-`, `SE-`, `FE-`, `HE-`, `JX-`, `DV-`). Test names contain the rule IDs they cover.
- `tests/<module>.test.ts`; `tests/scope.test.ts` covers scopes, parking, output parts, `derive` ownership and `iff`; `tests/slice.test.ts` covers slice readers and `watch`; `tests/dom.ts` is the fake DOM (`fakeDocument`, `html`); `tests/jsx.test.ts` has `setup`/`mounted`/`plain` helpers for `each`.
- `browser/<example>.spec.ts`: Playwright checks of the examples in the Chrome of the system; `npm run test:browser` runs them and prints real times and heap sizes of the bench app, and `browser/page.ts` fails a test for a page error.
- `devtools/`: Chrome extension; `src/hook.ts` runs in the page, `src/panel.tsx` is the panel (gg JSX), `src/types.d.ts` holds the batch shape. It has no tests.
- `examples/todomvc/`, `examples/orbits/`, `examples/forms/`, `examples/bench/`: JSX demo apps (orbits is SVG with mount/unmount, forms binds every input kind to a select) and js-framework-benchmark app; `npm run serve:examples` builds and serves them with esbuild.
- `npm run spec:examples` rewrites `// =>` results in spec blocks of channel, feed, helpers and select.
- `npm run checks` runs types, Biome, tests and the spec example check.
- `npm run test:branches` lists uncovered branches, and prints nothing at 100%.
- `npm run bench` times table and primitive workloads on the linked-list DOM of `tests/bench-dom.ts`; `tests/jsx-types.tsx` holds type checks of JSX props.

## Rules

Run `.ts` files directly with Node, without `tsx`.
Include `.ts` in imports.
Write condensed code.
Run tests with `node --expose-gc --test --test-timeout=250 --test-reporter=dot tests/index.test.ts`.
`npm test` regenerates `tests/index.test.ts`, so use it after adding a test file.
Run `npm run spec:examples` after a change to a spec example or to behaviour that it shows.
The user runs Stryker (`npm run test:mutations`), or `npm run test:survivors` for the survivors of the last report and the src lines changed since HEAD (`node rerun-survivors.ts --dry` prints the ranges).
Mark untestable optimizations with `// Stryker disable next-line ConditionalExpression`, followed by a reason.
Put `// Stryker restore all` before a statement, because Stryker reads it only as a leading comment, and at the end of a block it ignores the rest of the file.
Run `npx biome check --write spec` after a spec edit, because Biome formats the code blocks in it.
Run `npm run build:devtools` after a devtools change, and ask the user to reload the extension.
Bump `PROTOCOL` in `devtools/src/hook.ts` and `devtools/src/panel.tsx` together when the batch shape changes.
Call esbuild as `node_modules/.bin/esbuild`, which is a binary, not a script for `node`.

## Names

Source names follow the terms of `spec/scope.md`:
- `finished`: a source produced `done: true` or failed.
- `ended`: a consumer, a reader or a run does no more work.
- `terminal`: a channel after its first `close` or `throw`.
- `dead`: a slot that left its shape, or whose channel is terminal.
- `left`: an `Item` whose entry left `each`.
- `stop`: ends a drive, a reader or a `watch`.
- `parked`: a drive or a part that pulls no source until it resumes.
- `scope`: a `mount` or a started element, with the elements that started under it.
- `done`: the field of an iterator result.

## Testing

Call `await assert.rejects(iter.next())` to hit top-level generator throws.
Use `Reflect.ownKeys()` to test proxy key filters.
Use `await setImmediate()` from `node:timers/promises` to flush microtasks.
Use `util.inspect(promise)` to check pending promise states synchronously.
Use `{ thenReceive: "every" }` to test final values in shutdown races.
Omit `Symbol.asyncIterator` from custom iterators to test pure `AsyncIterator` branches.
Wait for a generator to yield before you call `iter.throw(err)`.
Use `collected()` with a put that overwrites its value, as `s.a = value, s.a = 0`, because the proxy target keeps the last source.
Run `FUZZ_SEEDS=200` with `tests/fuzz.test.ts` for a deeper fuzz run after a change to operations or readers.
Check a hook change in Node on a bundled example, because a bundle gives the library and the app one URL and breaks URL-based frame filters.
Load `devtools/build/devtools/src/hook.js` with `new Function`, give `fakeDocument` an `EventTarget` for the `gg-devtools:*` events, and send `connect` and `inspect` commands.
Code after an `await` or a `yield*` in a component resumes outside the host pull, so only code after a plain `yield` runs inside it (DV-052).
