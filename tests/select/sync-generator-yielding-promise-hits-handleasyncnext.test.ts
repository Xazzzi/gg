// biome-ignore-all lint/correctness/useYield: tests
import * as assert from "node:assert";
import { test } from "node:test";
import { select } from "../../src/select.ts";

test("sync generator yielding promise hits handleAsyncNext", async () => {
  function* gen() {
    yield Promise.reject(new Error("sync gen reject"));
  }
  const s = select([gen()]);
  const it = s[Symbol.asyncIterator]();
  const res1 = await it.next();
  assert.deepStrictEqual(res1.value, [{ status: "pending" }]);
  const res2 = await it.next();
  assert.strictEqual((res2.value[0] as any).status, "rejected");
  assert.strictEqual((res2.value[0] as any).reason.message, "sync gen reject");
});
