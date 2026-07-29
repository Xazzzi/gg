// biome-ignore-all lint/correctness/useYield: tests
import * as assert from "node:assert";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { Channel } from "../../src/channel.ts";
import { select } from "../../src/select.ts";

test("uncovered branches", async () => {
  // 1. sync iterator yielding identical promise twice (line 189)
  const p = Promise.resolve(1);
  let genPulls = 0;
  const gen = (function* () {
    genPulls++;
    yield p;
    genPulls++;
    yield p;
  })();
  const s1 = select({ gen }, { autoStart: true });
  await setImmediate();
  (s1 as any).dummy = 1;
  await setImmediate();
  assert.strictEqual(genPulls, 2);

  // 2. splice(0,0) triggers empty emit (line 226)
  let s2Emits = 0;
  const s2 = select([1, 2], { autoStart: true, onChanges: () => s2Emits++ });
  await setImmediate();
  s2.splice(0, 0);
  await setImmediate();
  assert.strictEqual(s2Emits, 1);

  // 3. push() with no args (line 367)
  assert.strictEqual((s2 as any).push(), 2);

  // 4. unshift() with no args (line 385)
  assert.strictEqual((s2 as any).unshift(), 2);

  // 5. pop() on empty array (line 446)
  const sEmpty = select([]);
  assert.strictEqual((sEmpty as any).pop(), undefined);

  // 6. pop() with changeValues: true (line 452)
  const sPopTrue = select([1, 2], { changeValues: true, onChanges: () => {} });
  (sPopTrue as any).pop();
  await setImmediate();
  assert.deepStrictEqual([...(sPopTrue as any)], [1]);

  // 7. shift() on empty array (line 465)
  assert.strictEqual((sEmpty as any).shift(), undefined);

  // 8. set same value (line 483)
  const sSame = select({ a: 1 });
  sSame.a = 1;

  // 9. handleLengthChange with changeValues: true (line 499)
  const sLenTrue = select([1, 2], { changeValues: true, onChanges: () => {} });
  (sLenTrue as any).length = 1;
  await setImmediate();
  assert.deepStrictEqual([...(sLenTrue as any)], [1]);

  // 10. deleteProperty non-existent key (line 518)
  const sDel = select({ a: 1 });
  delete (sDel as any).b;

  // 11. emit() asend throwing custom error (line 243)
  const origQueueMicrotask = global.queueMicrotask;
  let emitPromise: Promise<void> | undefined;
  global.queueMicrotask = fn => {
    emitPromise = (fn as any)();
  };

  const sThrow = select({ a: 1 }, { autoStart: true });
  if (emitPromise) await emitPromise; // wait for initial emit

  const origAsend = (Channel as any).prototype.asend;
  const customErr = new Error("Custom asend error");
  (Channel as any).prototype.asend = async () => {
    throw customErr;
  };

  emitPromise = undefined;
  sThrow.a = 2; // triggers emit

  let caughtErr: any;
  try {
    if (emitPromise) await emitPromise;
  } catch (err) {
    caughtErr = err;
  }

  assert.strictEqual(caughtErr, customErr);

  // 12. emit() asend throwing null (line 243)
  (Channel as any).prototype.asend = async () => {
    throw null;
  };

  emitPromise = undefined;
  sThrow.a = 3; // triggers emit

  let caughtErr2: any;
  try {
    if (emitPromise) await emitPromise;
  } catch (err) {
    caughtErr2 = err;
  }

  assert.strictEqual(caughtErr2, null);

  assert.strictEqual(caughtErr2, null);

  global.queueMicrotask = origQueueMicrotask;
  (Channel as any).prototype.asend = origAsend;

  // 13. this.start?.() mutant in select.ts:281
  const sStart = select({ a: 1 });
  const iter1 = sStart[Symbol.asyncIterator]();
  const iter2 = sStart[Symbol.asyncIterator]();

  // First next calls start() and clears this.start
  await iter1.next();
  // Second next calls the second unsend callback, where this.start is now undefined!
  await iter2.next();
});
