// biome-ignore-all lint/correctness/useYield: tests
import * as assert from "node:assert";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { select } from "../../src/select.ts";

test("select parks dropped iterators and preserves values", async () => {
  const p = Promise.withResolvers<void>();
  async function* gen() {
    await p.promise;
    yield 42;
  }
  const iter = gen();
  const s: any = select({ g: iter }, { autoClose: false });
  const it = s[Symbol.asyncIterator]();

  let v = await it.next(); // pulls .next()
  assert.deepStrictEqual(v.value, { g: { status: "pending" } });

  // Drop it from shape!
  delete s.g;
  v = await it.next();
  assert.deepStrictEqual(v.value, {}); // empty shape

  // Resolve background promise. The GC hack will intercept it!
  p.resolve();
  await setImmediate(); // flush microtasks

  // Add it back!
  s.g = iter;

  // First it emits pending because adding an async iterable always starts pending
  v = await it.next();
  assert.deepStrictEqual(v.value, { g: { status: "pending" } });

  // Then it quickly resolves the parked value
  v = await it.next();
  assert.deepStrictEqual(v.value, {
    g: { status: "fulfilled", value: 42, done: false },
  });
});
