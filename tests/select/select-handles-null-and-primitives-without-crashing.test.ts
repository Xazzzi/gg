// biome-ignore-all lint/correctness/useYield: tests
import * as assert from "node:assert";
import { test } from "node:test";
import { select } from "../../src/select.ts";

test("select handles null and primitives without crashing", async () => {
  // biome-ignore lint/suspicious/noThenProperty: test
  const s = select({ a: null, b: undefined, c: false, d: { then: 1 } });
  const it = s[Symbol.asyncIterator]();
  const v = await it.next();
  assert.deepStrictEqual(v.value, {
    a: null,
    b: undefined,
    c: false,
    // biome-ignore lint/suspicious/noThenProperty: test
    d: { then: 1 },
  });
  const v2 = await it.next();
  assert.strictEqual(v2.done, true);
});
