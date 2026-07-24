// biome-ignore-all lint/correctness/useYield: tests
import * as assert from "node:assert";
import { test } from "node:test";
import { select } from "../../src/select.ts";

test("select with promises", async () => {
  const p1 = Promise.withResolvers<number>();
  const p2 = Promise.withResolvers<string>();

  const s = select({ a: 1, b: p1.promise, c: p2.promise });
  const it = s[Symbol.asyncIterator]();

  // initial emit
  const v1 = await it.next();
  assert.deepStrictEqual(v1.value, {
    a: 1,
    b: { status: "pending" },
    c: { status: "pending" },
  });

  p1.resolve(42);
  const v2 = await it.next();
  assert.deepStrictEqual(v2.value, {
    a: 1,
    b: { status: "fulfilled", value: 42 },
    c: { status: "pending" },
  });

  p2.reject("err");
  const v3 = await it.next();
  assert.deepStrictEqual(v3.value, {
    a: 1,
    b: { status: "fulfilled", value: 42 },
    c: { status: "rejected", reason: "err" },
  });

  // Both promises settled, checkClose should fire
  const v4 = await it.next();
  assert.strictEqual(v4.done, true);
});
