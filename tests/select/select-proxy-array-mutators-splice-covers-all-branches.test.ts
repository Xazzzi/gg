// biome-ignore-all lint/correctness/useYield: tests
import * as assert from "node:assert";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { select } from "../../src/select.ts";

test("select proxy array mutators splice covers all branches", async () => {
  let changes: any;
  const s = select([10, 20, 30, 40], {
    changeValues: true,
    autoStart: true,
    onChanges: c => (changes = c),
  });

  // 1. Splice with rOffset = 0 (insertCount === deleteCount)
  s.splice(1, 1, 99);
  await setImmediate();
  assert.deepStrictEqual([...s], [10, 99, 30, 40]);

  // 2. Splice with args[0] < 0 (args[0] = -10, start = 0)
  s.splice(-10, 1);
  await setImmediate();
  // Array: [99, 30, 40]. rStart = 0, rOffset = -1.
  // Relocated keys: 0, 1, 2.
  // changes[1] maps to the old value at index 1 which was 99
  assert.strictEqual(changes[1], 99);
  assert.deepStrictEqual([...s], [99, 30, 40]);

  // 3. Splice to kill rOffset = insertCount + deleteCount mutant
  // Use splice(1, 1) to make rOffset = -1.
  s.splice(1, 1);
  await setImmediate();
  // Array: [99, 40]. rStart = 1, rOffset = -1.
  // Relocated keys: 1.
  // changes[1] maps to old value at index 1 which was 30.
  // Mutant rOffset = 1 maps to vals[2] = undefined.
  assert.strictEqual(changes[1], 30);
  assert.deepStrictEqual([...s], [99, 40]);

  // 4. Splice with negative index
  s.splice(-1, 1);
  await setImmediate();
  // Array: [99]. (old was [99, 40]). start = 1.
  assert.deepStrictEqual(Object.keys(changes), ["1"]);
  assert.strictEqual(changes[1], 40);
  assert.deepStrictEqual([...s], [99]);

  // 5. Splice with 1 argument (deleteCount is undefined)
  // Re-populate array
  s.push(101, 102, 103);
  await setImmediate();
  // Array is [99, 101, 102, 103]
  s.splice(2); // deletes from index 2 to end -> deletes 102, 103
  await setImmediate();
  assert.deepStrictEqual([...s], [99, 101]);
  assert.deepStrictEqual(Object.keys(changes).sort(), ["2", "3"]);
  assert.strictEqual(changes[2], 102);
  assert.strictEqual(changes[3], 103);

  // 6. Splice with negative deleteCount
  // Array is [99, 101]
  s.splice(1, -5, 55); // negative deleteCount acts as 0. start is 1!
  await setImmediate();
  assert.deepStrictEqual([...s], [99, 55, 101]);
  // No items deleted, but items shifted!
  // old values: 1: 101
  assert.deepStrictEqual(Object.keys(changes).sort(), ["1", "2"]);
  assert.strictEqual(changes[1], 101);

  // 5. Splice with no deleteCount
  s.splice(0);
  await setImmediate();
  assert.deepStrictEqual([...s], []);

  // 6. Splice to kill insertCount Math.max -> Math.min
  // splice(1, 1, 99) -> args.length = 3. insertCount = 1.
  // Mutant Math.min gives insertCount = 0.
  const s2 = select([10, 20, 30, 40], {
    changeValues: true,
    autoStart: true,
    onChanges: c => (changes = c),
  });
  (s2 as any).splice(1, 1, 99);
  await setImmediate();
  // rOffset = 1 - 1 = 0. So no relocations.
  // Wait, if insertCount = 0, rOffset = 0 - 1 = -1!
  // If rOffset = -1, changes will have relocated keys!
  assert.deepStrictEqual(Object.keys(changes), ["1"]);
  assert.strictEqual(changes[2], undefined);

  // Splice: args[0] <= 0 survival (splice at 0, no insert)
  const s3 = select([10, 20, 30, 40], {
    changeValues: true,
    autoStart: true,
    onChanges: c => (changes = c),
  });
  (s3 as any).splice(0, 1);
  await setImmediate();
  assert.deepStrictEqual(Object.keys(changes).sort(), ["0", "1", "2", "3"]);
  // changes[1] maps to old value at index 1 which was 20.
  assert.strictEqual(changes[1], 20);

  // 7. Splice to kill rStart = start + insertCount mutant
  // splice(1, 0, 88) on [10, 20, 30, 40]
  // insertCount = 1, deleteCount = 0.
  // rStart = 1 + 1 = 2.
  // Mutant start - insertCount gives rStart = 0.
  const s4 = select([10, 20, 30, 40], {
    changeValues: true,
    autoStart: true,
    onChanges: c => (changes = c),
  });
  (s4 as any).splice(1, 0, 88);
  await setImmediate();
  // If rStart = 2, Object.keys(changes) does NOT include "0".
  // If mutant gives rStart = 0, Object.keys(changes) WILL include "0".
  assert.deepStrictEqual(Object.keys(changes).includes("0"), false);

  // 8. Splice with deleteCount > remaining items (kill oldLen + start mutant)
  const s5 = select([10, 20, 30, 40], {
    changeValues: true,
    autoStart: true,
    onChanges: c => (changes = c),
  });
  // Wait for initial emit
  await setImmediate();
  changes = undefined; // clear initial emit
  (s5 as any).splice(2, 10);
  await setImmediate();
  // Mutated `oldLen + start` = 4 + 2 = 6. Would emit changes for indices 2,3,4,5,6,7!
  // Correct `oldLen - start` = 2. Emits for indices 2,3.
  assert.deepStrictEqual(Object.keys(changes).sort(), ["2", "3"]);

  // 9. Splice with insertCount >= 2 (kill start - i mutant)
  const s6 = select([10, 20, 30, 40], {
    changeValues: true,
    autoStart: true,
    onChanges: c => (changes = c),
  });
  await setImmediate();
  changes = undefined;
  (s6 as any).splice(1, 0, 88, 99);
  await setImmediate();
  // insertCount = 2, start = 1.
  // Correct loops: start + i -> 1, 2.
  // Mutant loops: start - i -> 1, 0.
  // We assert that it tracked change for index 2, not 0!
  assert.strictEqual(changes["2"], 30); // previous value at index 2 was 30
  assert.strictEqual(changes["0"], undefined); // index 0 was untouched
});
