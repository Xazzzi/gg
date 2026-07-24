// biome-ignore-all lint/correctness/useYield: tests
import * as assert from "node:assert";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { select } from "../../src/select.ts";

test("select proxy array relocated proxy edge cases (kill mutants)", async () => {
  let changes: any;
  const s = select([1, 2, 3], {
    changeValues: true,
    autoStart: true,
    onChanges: c => (changes = c),
  });

  // Trigger relocation on index 1
  s.splice(1, 1); // array becomes [1, 3]
  await setImmediate();

  // Kill `this.vals = vals` vs `this.vals = vals.slice()`
  const snapshot = changes;
  assert.strictEqual(snapshot[1], 2);
  s[0] = 99; // mutate after snapshot
  await setImmediate();
  assert.strictEqual(snapshot[1], 2); // should not reflect 99!

  // Kill `if (isRelocated) -> if (true)` in get
  // Index 0 is NOT relocated (rStart = 1).
  assert.strictEqual(snapshot[0], undefined);

  // Also verify for insertions (kills true && idx < length mutant)
  let c2: any;
  const s2 = select([10, 20, 30], {
    changeValues: true,
    autoStart: true,
    onChanges: c => (c2 = c),
  });
  (s2 as any).splice(1, 0, 88);
  await setImmediate();
  // rStart = 2, rOffset = 1.
  // Original: 0 is not relocated -> c2[0] is undefined.
  // Mutant (true && idx < length): 0 is relocated -> c2[0] = vals[0 + 1] = vals[1] = 88.
  assert.strictEqual(c2[0], undefined);
  assert.deepStrictEqual(Reflect.ownKeys(c2), ["1", "2", "3"]);

  // Also verify idx < this.vals.length mutant in getRelocation
  // If idx=99, original is false. Mutant without idx < length gives isRelocated = true.
  // Which means Reflect.has(c2, "99") would be true!
  assert.strictEqual(Reflect.has(c2, "99"), false);

  // Kill `!Number.isInteger(idx)` -> false
  assert.strictEqual("foo" in snapshot, false);
  assert.strictEqual(snapshot.foo, undefined);
  assert.strictEqual(
    Object.getOwnPropertyDescriptor(snapshot, "foo"),
    undefined,
  );
});
