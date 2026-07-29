import * as assert from "node:assert";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { select, spread } from "../../src/select.ts";

test("select mapField expands state successfully via spread", async () => {
  const p1 = Promise.resolve(42);

  let rejectFn!: (r: Error) => void;
  const p2 = new Promise<string>((_, r) => {
    rejectFn = r;
  });

  function* g3() {
    yield 1;
    yield "one";
    yield null;
    return 1000n;
  }

  const shape = [p1, p2, g3(), 10, "yo", 10n] as const;
  const stream = select(shape, { mapFields: spread });
  const it = stream[Symbol.asyncIterator]();

  // First state: p1 fulfilled, p2 pending
  await setImmediate(); // wait for p1 to resolve
  let next = await it.next();

  assert.strictEqual(next.done, false);
  assert.strictEqual(next.value[0].value, 42);
  assert.strictEqual(next.value[0].loading, false);
  assert.strictEqual(next.value[0].error, null);
  assert.strictEqual(next.value[0].done, true);

  assert.strictEqual(next.value[1].value, undefined);
  assert.strictEqual(next.value[1].loading, true);
  assert.strictEqual(next.value[1].error, null);
  assert.strictEqual(next.value[1].done, false);

  assert.strictEqual(next.value[2].value, 1);
  assert.strictEqual(next.value[2].loading, false);
  assert.strictEqual(next.value[2].error, null);
  assert.strictEqual(next.value[2].done, false);

  assert.strictEqual(next.value[3], 10);
  assert.strictEqual(next.value[4], "yo");
  assert.strictEqual(next.value[5], 10n);

  // Reject p2
  rejectFn(new Error("fail"));
  next = await it.next();
  assert.strictEqual(next.done, false);

  assert.strictEqual(next.value[1].value, undefined);
  assert.strictEqual(next.value[1].loading, false);
  assert.deepStrictEqual(next.value[1].error, new Error("fail"));
  assert.strictEqual(next.value[1].done, true);
});

test("select mapSnapshot maps full snapshot", async () => {
  const p1 = Promise.resolve(10);
  const stream = select(
    { p1 },
    {
      mapSnapshot: state => ({
        total: state.p1.status === "fulfilled" ? state.p1.value : 0,
      }),
    },
  );

  const it = stream[Symbol.asyncIterator]();
  await setImmediate();
  const next = await it.next();
  assert.deepStrictEqual(next.value, { total: 10 });
});
