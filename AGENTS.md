# Project

The library provides `Channel`, `feed` and `select`, and a JSX runtime, which the root and `@xazzzi/gg/jsx-runtime` export.
`spec/` defines intended behaviour and takes precedence over docs, tests and code.
All source needs 100% V8 branch coverage and 100% Stryker mutation coverage.

## Layout

- `src/`: `channel.ts`, `select.ts` (also `changes`, `Val`, `Op`), `feed.ts`, `helpers.ts` (`applyOps` etc.), `jsx.ts` (runtime, `each`, `mount`), `devtools.ts` (hook, `owned`, `register`), `index.ts` (root exports, JSX included).
- `spec/<module>.md`: rules with stable IDs (`CH-`, `SE-`, `FE-`, `HE-`, `JX-`, `DV-`). Test names contain the rule IDs they cover.
- `tests/<module>.test.ts`; `tests/dom.ts` is the fake DOM (`fakeDocument`, `html`); `tests/jsx.test.ts` has `setup`/`mounted`/`plain` helpers for `each`.
- `examples/todomvc/`, `examples/orbits/`, `examples/forms/`, `examples/bench/`: JSX demo apps (orbits is SVG with mount/unmount, forms binds every input kind to a select) and js-framework-benchmark app; `npm run serve:examples` builds and serves them with esbuild.
- `npm run spec:examples` rewrites `// =>` results in spec blocks of channel, feed, helpers and select.
- `npm run checks` runs types, Biome, tests and the spec example check.

## Rules

Run `.ts` files directly with Node, without `tsx`.
Include `.ts` in imports.
Write condensed code.
Run tests with `node --expose-gc --test --test-timeout=250 --test-reporter=dot tests/index.test.ts`.
`npm test` regenerates `tests/index.test.ts`, so use it after adding a test file.
Run `npm run spec:examples` after a change to a spec example or to behaviour that it shows.
The user runs Stryker (`npm run test:mutations`).
Mark untestable optimizations with `// Stryker disable next-line ConditionalExpression`, followed by a reason.

## Testing

Call `await assert.rejects(iter.next())` to hit top-level generator throws.
Use `Reflect.ownKeys()` to test proxy key filters.
Use `await setImmediate()` from `node:timers/promises` to flush microtasks.
Use `util.inspect(promise)` to check pending promise states synchronously.
Use `{ thenReceive: "every" }` to test final values in shutdown races.
Omit `Symbol.asyncIterator` from custom iterators to test pure `AsyncIterator` branches.
Wait for a generator to yield before you call `iter.throw(err)`.
