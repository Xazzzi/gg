// biome-ignore-all lint/correctness/useYield: tests
import * as assert from "node:assert";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { select } from "../../src/select.ts";

test("select proxy array relocated proxy without changeValues", async () => {
  let changes: any;
  const s = select([10, 20], {
    changeValues: false,
    autoStart: true,
    onChanges: c => (changes = c),
  });
  s.unshift(30);
  await setImmediate();

  assert.strictEqual("0" in changes, true);
  assert.strictEqual("1" in changes, true);

  assert.strictEqual(changes[0], 0);
  assert.strictEqual(changes[1], 1);
  assert.strictEqual(changes[2], 2);

  assert.deepStrictEqual(Object.keys(changes), ["0", "1", "2"]);

  assert.deepStrictEqual(Object.getOwnPropertyDescriptor(changes, "1"), {
    value: 1,
    configurable: true,
    enumerable: true,
    writable: false,
  });
});
