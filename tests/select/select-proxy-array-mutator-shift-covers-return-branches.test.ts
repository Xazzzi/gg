// biome-ignore-all lint/correctness/useYield: tests
import * as assert from "node:assert";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { select } from "../../src/select.ts";

test("select proxy array mutator shift covers return branches", async () => {
  let changes: any;
  const s = select([10, 20, 30], {
    changeValues: true,
    autoStart: true,
    onChanges: c => (changes = c),
  });

  s.shift();
  await setImmediate();
  assert.deepStrictEqual(Object.keys(changes).sort(), ["0", "1", "2"]);
  assert.strictEqual(changes[0], 10);
  assert.strictEqual(changes[1], 20);
  assert.strictEqual(changes[2], 30);
});
