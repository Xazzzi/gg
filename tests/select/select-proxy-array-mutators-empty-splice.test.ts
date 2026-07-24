import * as assert from "node:assert";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { select } from "../../src/select.ts";

test("select proxy array mutator splice with no args does nothing", async () => {
  let changes: any;
  const s = select([1, 2, 3], {
    changeValues: true,
    autoStart: true,
    onChanges: c => (changes = c),
  });

  await setImmediate();
  changes = undefined; // clear initial emit

  const res = (s as any).splice();
  await setImmediate();

  assert.deepStrictEqual(res, []);
  assert.deepStrictEqual([...s], [1, 2, 3]);

  // No changes emitted
  assert.strictEqual(changes, undefined);
});
