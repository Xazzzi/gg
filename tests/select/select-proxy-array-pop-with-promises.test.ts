// biome-ignore-all lint/correctness/useYield: tests
import * as assert from "node:assert";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { select } from "../../src/select.ts";

test("select proxy array pop with promises", async () => {
  const p1 = Promise.withResolvers<number>();
  const p2 = Promise.withResolvers<number>();
  const s = select([p1.promise, p2.promise], { autoClose: false });
  const it = s[Symbol.asyncIterator]();
  await it.next();

  // pop removes p2.promise.
  s.pop();

  p2.resolve(42); // Should be ignored since it was popped!
  await setImmediate();

  p1.resolve(100); // This should be the next emit
  await setImmediate();
  const v = await it.next();
  assert.strictEqual((v.value as any).length, 1);
  assert.strictEqual((v.value as any)[0].value, 100);
});
