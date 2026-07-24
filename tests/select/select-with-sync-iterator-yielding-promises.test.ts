// biome-ignore-all lint/correctness/useYield: tests
import * as assert from "node:assert";
import { test } from "node:test";
import { select } from "../../src/select.ts";

test("select with sync iterator yielding promises", async () => {
  const p1 = Promise.withResolvers<number>();
  const p2 = Promise.withResolvers<number>();
  const p3 = Promise.withResolvers<number>();

  function* gen() {
    yield p1.promise;
    yield p2.promise;
    yield 3;
  }
  const s = select({ p3: p3.promise, g: gen() });
  const it = s[Symbol.asyncIterator]();

  let v = await it.next();
  assert.deepStrictEqual(v.value, {
    p3: { status: "pending" },
    g: { status: "pending" },
  });

  p1.resolve(100);
  v = await it.next();
  assert.deepStrictEqual(v.value, {
    p3: { status: "pending" },
    g: { status: "fulfilled", value: 100, done: false },
  });

  p3.resolve(300);
  v = await it.next();
  assert.deepStrictEqual(v.value, {
    p3: { status: "fulfilled", value: 300 },
    g: { status: "fulfilled", value: 100, done: false }, // Retains previous state while p2 is pending
  });

  p2.resolve(200);
  v = await it.next();
  assert.deepStrictEqual(v.value, {
    p3: { status: "fulfilled", value: 300 },
    g: { status: "fulfilled", value: 200, done: false },
  });

  v = await it.next();
  assert.strictEqual(v.done, true);
});
