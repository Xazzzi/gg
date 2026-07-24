// biome-ignore-all lint/correctness/useYield: tests
import * as assert from "node:assert";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { select } from "../../src/select.ts";

test("select starts eagerly with autoStart and lazy without", async () => {
  let eagerlyStarted = false;
  const iter = {
    next: () => {
      eagerlyStarted = true;
      return { done: true, value: undefined };
    },
  };

  // Without autoStart, it shouldn't evaluate iterators until start()
  const s = select({ a: iter } as any);
  assert.strictEqual(eagerlyStarted, false);

  // Mutating before start shouldn't trigger emit either
  s.b = 2;
  await setImmediate();
  assert.strictEqual(eagerlyStarted, false);

  // With autoStart, it starts eagerly in the constructor
  select({ a: iter }, { autoStart: true });
  assert.strictEqual(eagerlyStarted, true);
});
