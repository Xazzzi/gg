// biome-ignore-all lint/correctness/useYield: tests
import * as assert from "node:assert";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { select } from "../../src/select.ts";

test("select proxy array shift with promises", async () => {
  const p1 = Promise.withResolvers<number>();
  const p2 = Promise.withResolvers<number>();
  const s = select([p1.promise, p2.promise], { autoClose: false });
  const it = s[Symbol.asyncIterator]();
  await it.next();

  // shift removes p1.promise, moves p2 to index 0.
  s.shift();

  p1.resolve(42); // Should be ignored since it was shifted!
  await setImmediate();

  p2.resolve(100); // Should be emitted at index 0!
  await setImmediate();
  const v = await it.next();
  assert.strictEqual((v.value as any).length, 1);
  assert.strictEqual((v.value as any)[0].value, 100);
});
