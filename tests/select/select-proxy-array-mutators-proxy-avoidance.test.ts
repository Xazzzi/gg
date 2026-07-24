import * as assert from "node:assert";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import * as util from "node:util";
import { select } from "../../src/select.ts";

test("select array mutators avoid Proxy allocation when relocations are useless", async () => {
  let changes: any;

  // 1. shift() on array of length 1 (leaves it empty, no relocations needed)
  const s1 = select([10], {
    changeValues: true,
    autoStart: true,
    onChanges: c => (changes = c),
  });
  await setImmediate();
  changes = undefined;

  s1.shift();
  await setImmediate();
  assert.strictEqual(
    util.types.isProxy(changes),
    false,
    "shift on array of length 1 should avoid Proxy allocation",
  );

  // 2. unshift() on empty array (inserts elements, but no existing elements to relocate)
  const s2 = select([] as any[], {
    changeValues: true,
    autoStart: true,
    onChanges: c => (changes = c),
  });
  await setImmediate();
  changes = undefined;

  s2.unshift(10, 20);
  await setImmediate();
  assert.strictEqual(
    util.types.isProxy(changes),
    false,
    "unshift on empty array should avoid Proxy allocation",
  );
});
