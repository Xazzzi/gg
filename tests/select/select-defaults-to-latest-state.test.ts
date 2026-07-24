// biome-ignore-all lint/correctness/useYield: tests
import * as assert from "node:assert";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { select } from "../../src/select.ts";

test("select defaults to latest state", async () => {
  // If we don't pass firstReceive, it defaults to "latest" and skips ancient history
  const s = select({ a: 1 }, { autoStart: true });

  s.a = 2; // queue another state

  // Change does not immediately propagate, batched with other sync changes in this tick
  // it.next in this tick resumes consumer syncronously to capture 1
  const ita = s[Symbol.asyncIterator]();
  const va = await ita.next();
  assert.strictEqual((va.value as any).a, 1);

  await setImmediate(); // let emit flush

  const it = s[Symbol.asyncIterator]();
  const v1 = await it.next();
  assert.strictEqual((v1.value as any).a, 2);
});
