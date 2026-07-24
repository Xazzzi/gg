// biome-ignore-all lint/correctness/useYield: tests
import * as assert from "node:assert";
import { test } from "node:test";
import { select } from "../../src/select.ts";

test("select proxy array setting index works", async () => {
  const s = select([1], { autoClose: false });
  const it = s[Symbol.asyncIterator]();
  await it.next();
  s[0] = 2;
  const v = await it.next();
  assert.strictEqual((v.value as any)[0], 2);

  delete s[0];
  const v2 = await it.next();
  assert.strictEqual((v2.value as any)[0], undefined);
});
