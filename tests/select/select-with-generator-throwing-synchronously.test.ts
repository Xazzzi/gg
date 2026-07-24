// biome-ignore-all lint/correctness/useYield: tests
import * as assert from "node:assert";
import { test } from "node:test";
import { select } from "../../src/select.ts";

test("select with generator throwing synchronously", async () => {
  function* gen() {
    throw "sync boom";
  }
  const s = select({ g: gen() });
  const it = s[Symbol.asyncIterator]();

  let v = await it.next();
  assert.deepStrictEqual(v.value, {
    g: { status: "rejected", reason: "sync boom" },
  });

  v = await it.next();
  assert.strictEqual(v.done, true);
});
