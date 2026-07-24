// biome-ignore-all lint/correctness/useYield: tests
import * as assert from "node:assert";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { select } from "../../src/select.ts";
import { assertStatus } from "../utils.test.ts";

test("select proxy array length truncation", async () => {
  const p1 = Promise.withResolvers<number>();
  const p2 = Promise.withResolvers<void>();

  async function* gen() {
    await p2.promise;
    yield 42;
  }
  const s = select([p1.promise, gen()]);
  const it = s[Symbol.asyncIterator]();

  await it.next(); // [{pending}, {pending}]

  // Truncating removes the generator which is stored in siter/aiter
  s.length = 1;
  const v = await it.next();
  assert.deepStrictEqual(v.value, [{ status: "pending" }]);

  // Ensure the dropped generator doesn't emit when it resolves in the background
  p2.resolve();
  await setImmediate();

  // The channel should not have received any new updates
  await assertStatus(it.next(), "pending");
});
