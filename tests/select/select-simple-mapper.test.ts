import * as assert from "node:assert";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { select, simple } from "../../src/select.ts";

test("select simple mapper maps correctly", async () => {
  const p1 = Promise.resolve(42);
  let rejectFn!: (r: Error) => void;
  const p2 = new Promise<string>((_, r) => {
    rejectFn = r;
  });

  const stream = select({ p1, p2, syncNum: 10 }, { mapFields: simple });
  const it = stream[Symbol.asyncIterator]();

  let next = await it.next();
  assert.strictEqual(next.done, false);
  // initial state
  assert.strictEqual(next.value.p1, null); // wait, for resolved promise, it resolves asynchronously

  await setImmediate();
  next = await it.next();
  assert.strictEqual(next.done, false);
  assert.strictEqual(next.value.p1, 42); // fulfilled
  assert.strictEqual(next.value.p2, null); // still pending
  assert.strictEqual(next.value.syncNum, 10); // sync unmodified

  rejectFn(new Error("fail"));
  next = await it.next();
  assert.strictEqual(next.done, false);
  assert.strictEqual(next.value.p2, null); // rejected
});
