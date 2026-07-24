// biome-ignore-all lint/correctness/useYield: tests
import * as assert from "node:assert";
import { test } from "node:test";
import { CHAN, select } from "../../src/select.ts";

test("select ignores updates after being manually closed", async () => {
  const p = Promise.withResolvers<number>();
  const s = select({ a: p.promise });

  // Start it
  const it = s[Symbol.asyncIterator]();
  await it.next(); // pending

  // Manually abort
  s[CHAN].close();

  // Resolve promise AFTER close
  p.resolve(42);

  const after = await it.next();
  assert.ok(after.done);
  assert.strictEqual(after.value, undefined);
});
