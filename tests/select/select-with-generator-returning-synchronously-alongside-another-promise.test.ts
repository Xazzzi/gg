// biome-ignore-all lint/correctness/useYield: tests
import * as assert from "node:assert";
import { test } from "node:test";
import { select } from "../../src/select.ts";

test("select with generator returning synchronously alongside another promise", async () => {
  const p = Promise.withResolvers<void>();
  function* gen() {
    return "sync done";
  }
  const s = select({ p: p.promise, g: gen() });
  const it = s[Symbol.asyncIterator]();

  const v = await it.next();
  assert.deepStrictEqual(v.value, {
    p: { status: "pending" },
    g: { status: "fulfilled", value: "sync done", done: true },
  });
});
