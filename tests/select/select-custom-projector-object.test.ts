import * as assert from "node:assert";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { select, spread } from "../../src/select.ts";

test("select mapField expands state successfully via spread on objects", async () => {
  const p1 = Promise.resolve(42);
  let rejectFn!: (r: Error) => void;
  const p2 = new Promise<string>((_, r) => {
    rejectFn = r;
  });

  const shape = { p1, p2 };

  const stream = select(shape, { mapFields: spread, holdDone: true });

  const it = stream[Symbol.asyncIterator]();
  let next = await it.next(); // initial

  await setImmediate(); // wait for batch
  next = await it.next(); // p1 resolved

  assert.strictEqual(next.value.p1, 42);
  assert.strictEqual(next.value.p1Loading, false);
  assert.strictEqual(next.value.p1Error, null);
  assert.strictEqual(next.value.p1Done, true);

  assert.strictEqual(next.value.p2, undefined);
  assert.strictEqual(next.value.p2Loading, true);
  assert.strictEqual(next.value.p2Error, null);
  assert.strictEqual(next.value.p2Done, false);

  rejectFn(new Error("fail"));
  next = await it.next();

  assert.strictEqual(next.value.p2, undefined);
  assert.strictEqual(next.value.p2Loading, false);
  assert.deepStrictEqual(next.value.p2Error, new Error("fail"));
  assert.strictEqual(next.value.p2Done, true);
});

test("select holdDone with mapField on async iterators", async () => {
  async function* asyncGen() {
    yield 100;
  }
  const stream = select(
    { g: asyncGen() },
    { mapFields: spread, holdDone: true },
  );
  const it = stream[Symbol.asyncIterator]();
  let next = await it.next(); // initial state

  await setImmediate(); // wait for batch (yield 100 AND done: true)
  next = await it.next(); // single batched emission

  assert.strictEqual(next.value.g, 100);
  assert.strictEqual(next.value.gDone, true);
});

test("select holdDone with mapField false on async iterators", async () => {
  async function* asyncGen() {
    yield 100;
  }
  const stream = select({ g: asyncGen() }, { holdDone: true });
  const it = stream[Symbol.asyncIterator]();
  let next = await it.next(); // initial state

  await setImmediate();
  next = await it.next();

  // mapField is false, so holdDone logic hits the other branch (292/354)
  assert.strictEqual((next.value.g as any).value, 100);
});
