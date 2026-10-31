# Project

The library provides `Channel`, `feed` and `Select`.
`spec/` defines intended behaviour and takes precedence over docs, tests and code.
All source needs 100% V8 branch coverage and 100% Stryker mutation coverage.

## Rules

Run `.ts` files directly with Node, without `tsx`.
Include `.ts` in imports.
Write condensed code.
Run tests with `node --expose-gc --test --test-timeout=250 --test-reporter=dot tests/index.test.ts`.
`npm test` regenerates `tests/index.test.ts`, so use it after adding a test file.
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
