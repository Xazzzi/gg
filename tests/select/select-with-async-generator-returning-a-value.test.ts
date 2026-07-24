// biome-ignore-all lint/correctness/useYield: tests
import * as assert from "node:assert";
import { test } from "node:test";
import { select } from "../../src/select.ts";

test("select with async generator returning a value", async () => {
  const p = Promise.withResolvers<void>();
  async function* gen() {
    await p.promise;
    return "async final";
  }
  const s = select({ g: gen() });
  const it = s[Symbol.asyncIterator]();

  let v = await it.next();
  assert.deepStrictEqual(v.value, { g: { status: "pending" } });

  p.resolve();
  v = await it.next();
  assert.deepStrictEqual(v.value, {
    g: { status: "fulfilled", value: "async final", done: true },
  });
});
