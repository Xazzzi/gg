// biome-ignore-all lint/correctness/useYield: tests
import * as assert from "node:assert";
import { test } from "node:test";
import { select } from "../../src/select.ts";

test("select changeValues tracking", async () => {
  let changesA: any;
  const iterA = select(
    { a: Promise.resolve(1) },
    {
      onChanges(c) {
        changesA = c;
      },
    },
  )[Symbol.asyncIterator]();

  await iterA.next();
  assert.ok(changesA);
  assert.strictEqual(changesA.a, "a"); // Set.entries() yields [key, key]

  let changesB: any;
  const iterB = select(
    { b: Promise.resolve(1) },
    {
      changeValues: true,
      onChanges(c) {
        changesB = c;
      },
    },
  )[Symbol.asyncIterator]();

  await iterB.next();
  assert.ok(changesB);
  // Initial value is { status: 'pending' }
  assert.deepStrictEqual(changesB.b, { status: "pending" });
});
