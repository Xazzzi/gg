import * as assert from "node:assert";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { select } from "../../src/select.ts";

test("select proxy array mutator push covers empty and multiple arguments", async () => {
  let changes: any[] | undefined;
  const s = select([10, 20], {
    changeValues: true,
    autoStart: true,
    onChanges: (c: any) => (changes = c),
  });

  await setImmediate();
  changes = undefined;

  // 1. Push with no arguments
  const len = s.push();
  await setImmediate();
  assert.strictEqual(len, 2);
  assert.strictEqual(changes, undefined); // No changes emitted!
  assert.deepStrictEqual([...s], [10, 20]);

  // 2. Push with multiple arguments
  s.push(30, 40);
  await setImmediate();
  // start = 2, args.length = 2
  // It should track changes for indices 2 and 3!
  assert.ok(changes);
  assert.deepStrictEqual(Object.keys(changes).sort(), ["2", "3"]);
  assert.strictEqual(changes[2], undefined); // Previous value at index 2 was undefined
  assert.strictEqual(changes[3], undefined);
  assert.deepStrictEqual([...s], [10, 20, 30, 40]);
});
