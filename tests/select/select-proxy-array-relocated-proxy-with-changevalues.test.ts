// biome-ignore-all lint/correctness/useYield: tests
import * as assert from "node:assert";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { select } from "../../src/select.ts";

test("select proxy array relocated proxy with changeValues", async () => {
  let changes: any;
  const s = select([10, 20], {
    changeValues: true,
    autoStart: true,
    onChanges: c => (changes = c),
  });
  s.unshift(30);
  await setImmediate();

  assert.strictEqual("0" in changes, true);
  assert.strictEqual("1" in changes, true);
  assert.strictEqual("2" in changes, true);
  assert.strictEqual("3" in changes, false);
  assert.strictEqual(Symbol("test") in changes, false);
  assert.strictEqual("foo" in changes, false);

  assert.strictEqual(changes[0], 10);
  assert.strictEqual(changes[1], 20);
  assert.strictEqual(changes[2], undefined);
  assert.strictEqual(changes[3], undefined);
  assert.strictEqual(changes[Symbol("test")], undefined);
  assert.strictEqual(changes.foo, undefined);

  assert.deepStrictEqual(Object.keys(changes), ["0", "1", "2"]);

  assert.deepStrictEqual(Object.getOwnPropertyDescriptor(changes, "1"), {
    value: 20,
    configurable: true,
    enumerable: true,
    writable: false,
  });
  assert.strictEqual(Object.getOwnPropertyDescriptor(changes, "3"), undefined);
  assert.strictEqual(
    Object.getOwnPropertyDescriptor(changes, Symbol("test") as any),
    undefined,
  );
});
