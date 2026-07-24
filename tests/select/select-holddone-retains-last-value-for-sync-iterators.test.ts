// biome-ignore-all lint/correctness/useYield: tests
import * as assert from "node:assert";
import { test } from "node:test";
import { select } from "../../src/select.ts";

test("select holdDone retains last value for sync iterators", async () => {
  function* gen() {
    yield 42;
    return undefined; // done: true, value: undefined
  }
  const other = Promise.withResolvers<number>();
  const s = select({ g: gen(), o: other.promise }, { holdDone: true });
  const it = s[Symbol.asyncIterator]();

  await it.next(); // 42 and o: pending

  other.resolve(1);
  const v2 = await it.next(); // o: 1, g returns undefined!

  assert.deepStrictEqual((v2.value as any).g, {
    status: "fulfilled",
    value: 42,
    done: true,
  });
});
