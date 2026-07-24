import * as assert from "node:assert";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { select } from "../../src/select.ts";

test("select proxy array mutator pop on empty array emits no unexpected changes", async () => {
  let changes: any;
  const s = select([], {
    changeValues: true,
    autoStart: true,
    onChanges: c => (changes = c),
  });

  s.pop();
  await setImmediate();

  // No elements existed, so no elements were shifted or deleted.
  // Changes map should be completely empty, definitely no "-1" key.
  assert.deepStrictEqual(Object.keys(changes).sort(), []);
});
