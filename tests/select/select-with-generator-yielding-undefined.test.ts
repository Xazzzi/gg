// biome-ignore-all lint/correctness/useYield: tests
import * as assert from "node:assert";
import { test } from "node:test";
import { select } from "../../src/select.ts";

test("select with generator yielding undefined", async () => {
  async function* gen() {
    yield 1;
    yield undefined;
  }
  const s = select({ g: gen() });
  const it = s[Symbol.asyncIterator]();
  await it.next(); // pending
  let v = await it.next();
  assert.deepStrictEqual(v.value, {
    g: { status: "fulfilled", value: 1, done: false },
  });
  v = await it.next();
  assert.deepStrictEqual(v.value, {
    g: { status: "fulfilled", value: undefined, done: false },
  });
  v = await it.next();
  assert.deepStrictEqual(v.value, {
    g: { status: "fulfilled", value: undefined, done: true },
  });
});
