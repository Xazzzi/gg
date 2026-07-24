// biome-ignore-all lint/correctness/useYield: tests
import * as assert from "node:assert";
import { test } from "node:test";
import { select } from "../../src/select.ts";

test("select with async iterator throwing synchronously on second next()", async () => {
  let calls = 0;
  const iterable = {
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (calls === 0) {
            calls++;
            return Promise.resolve({ value: 42, done: false });
          }
          throw new Error("async boom 2");
        },
      };
    },
  };
  const s = select({ a: iterable });
  const it = s[Symbol.asyncIterator]();

  // First pull emits pending state synchronously
  const v0 = await it.next();
  assert.deepStrictEqual((v0.value as any).a, { status: "pending" });

  // When the promise resolves, it emits the fulfilled state
  const v1 = await it.next();
  assert.deepStrictEqual((v1.value as any).a, {
    status: "fulfilled",
    value: 42,
    done: false,
  });

  // After v1 is read, pullAsync is driven and throws synchronously
  const v2 = await it.next();
  assert.strictEqual((v2.value as any).a.status, "rejected");
  assert.strictEqual((v2.value as any).a.reason.message, "async boom 2");
});
