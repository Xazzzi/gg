import * as assert from "node:assert";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { select } from "../../src/select.ts";

test("relocated proxy snapshots are isolated from subsequent array mutations", async () => {
  let snapshot: any;
  const s = select([10], {
    changeValues: true,
    autoStart: true,
    onChanges: c => (snapshot = c),
  });
  await setImmediate();

  // 1. Mutate the array. This creates relocations and emits a changes proxy.
  s.unshift(20); // Array becomes [20, 10]. Relocation { start: 1, offset: 1 } created.
  await setImmediate();

  // unshift tracks index 0. Index 1 is yielded by getRelocation.
  // The previous value at index 1 was undefined (array only had length 1).
  assert.deepStrictEqual(Object.keys(snapshot), ["0", "1"]);
  assert.strictEqual(snapshot[1], undefined);

  // 3. Mutate the array AGAIN!
  s.push(30); // Array becomes [20, 10, 30].

  // 4. Verify the PREVIOUS snapshot was not affected by the subsequent push!
  // If `this.vals` wasn't sliced, the mutant array length becomes 3, and getRelocation
  // would incorrectly yield "2" as a relocated key!
  assert.deepStrictEqual(Object.keys(snapshot), ["0", "1"]);
  assert.strictEqual(snapshot[1], undefined);
  assert.strictEqual(snapshot[2], undefined);
});
