import * as assert from "node:assert";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { select } from "../../src/select.ts";

test("relocated proxy ignores non-integer properties", async () => {
  let changes: any;
  const s = select([10, 20, 30], {
    changeValues: true,
    autoStart: true,
    onChanges: c => (changes = c),
  });
  await setImmediate();
  changes = undefined;

  // trigger a relocation so we get a relocated proxy
  s.shift();
  await setImmediate();

  // changes is a relocated proxy!
  // If `isInteger` checks are removed, `getRelocation` might incorrectly
  // report `1.5` as a relocated element since `1.5 >= 0` and `1.5 < length`.
  assert.strictEqual("1.5" in changes, false);
  assert.strictEqual(changes["1.5"], undefined);
});
