// biome-ignore-all lint/correctness/useYield: tests
import * as assert from "node:assert";
import { test } from "node:test";
import { select } from "../../src/select.ts";

test("select proxy array mutators are not intercepted on objects", () => {
  const s = select({ push: 1 });
  assert.strictEqual(s.push, 1);
});
