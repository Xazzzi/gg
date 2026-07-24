// biome-ignore-all lint/correctness/useYield: tests
import * as assert from "node:assert";
import { test } from "node:test";
import { select } from "../../src/select.ts";

test("select proxy exposes dispose symbols", async () => {
  const s = select({ a: 1 });
  assert.strictEqual(typeof s[Symbol.dispose], "function");
  assert.ok(s[Symbol.dispose]);
  assert.ok(s[Symbol.asyncDispose]);

  const it = s[Symbol.asyncIterator]();
  await it.next(); // Consume initial state

  s[Symbol.dispose]();
  // Verify it closes the channel by checking if the iterator finishes
  const v = await it.next();
  assert.strictEqual(v.done, true);
});
