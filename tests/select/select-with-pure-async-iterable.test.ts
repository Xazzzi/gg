// biome-ignore-all lint/correctness/useYield: tests
import * as assert from "node:assert";
import { test } from "node:test";
import { select } from "../../src/select.ts";

test("select with pure async iterable", async () => {
  const iterable = {
    async *[Symbol.asyncIterator]() {
      yield 42;
    },
  };
  const s = select({ a: iterable });
  const it = s[Symbol.asyncIterator]();

  await it.next(); // pending
  const v = await it.next();
  assert.deepStrictEqual(v.value, {
    a: { status: "fulfilled", value: 42, done: false },
  });

  // The final state change (done: true) queues a second emit
  const v2 = await it.next();
  assert.deepStrictEqual(v2.value, {
    a: { status: "fulfilled", value: 42, done: true },
  });

  // No more changes to expect - channel closes
  const v3 = await it.next();
  assert.strictEqual(v3.done, true);
});
