import * as assert from "node:assert";
import { test } from "node:test";
import { unsend } from "../../src/utils.ts";

test("unsend monkey-patches and restores iter.next and iter.throw correctly", async () => {
  let originalNextCalled = 0;
  let originalThrowCalled = 0;

  const originalNext = async (v?: any) => {
    originalNextCalled++;
    return { value: v, done: false };
  };

  const originalThrow = async (e?: any) => {
    originalThrowCalled++;
    throw e;
  };

  const iter = {
    next: originalNext,
    throw: originalThrow,
  } as unknown as AsyncIterator<any>;

  let callbackCalled = 0;
  const callback = () => {
    callbackCalled++;
  };

  // 1. Test next() restores next and throw
  unsend(iter, Promise.resolve({ value: 100, done: false }), false, callback);
  assert.notStrictEqual(iter.next, originalNext);
  assert.notStrictEqual(iter.throw, originalThrow);

  const res = await iter.next();
  assert.deepStrictEqual(res, { value: 100, done: false });
  assert.strictEqual(callbackCalled, 1);
  assert.strictEqual(originalNextCalled, 0); // original next not called because result was provided
  assert.strictEqual(iter.next, originalNext); // next is restored
  assert.strictEqual(iter.throw, originalThrow); // throw is restored!

  // Reset counters
  callbackCalled = 0;
  originalNextCalled = 0;
  originalThrowCalled = 0;

  // 2. Test throw() restores next and throw
  unsend(iter, Promise.reject(new Error("test")), true, callback);
  assert.notStrictEqual(iter.next, originalNext);
  assert.notStrictEqual(iter.throw, originalThrow);

  await assert.rejects(iter.throw?.(), /test/);
  assert.strictEqual(callbackCalled, 1);
  assert.strictEqual(originalThrowCalled, 0); // original throw not called because result was provided
  assert.strictEqual(iter.next, originalNext); // next is restored
  assert.strictEqual(iter.throw, originalThrow); // throw is restored!

  // Reset counters
  callbackCalled = 0;
  originalNextCalled = 0;
  originalThrowCalled = 0;

  // 3. Test next() restores but falls back if result is undefined
  unsend(iter, undefined, false, callback);
  assert.notStrictEqual(iter.next, originalNext);
  assert.notStrictEqual(iter.throw, originalThrow);

  const res2 = await iter.next(55);
  assert.deepStrictEqual(res2, { value: 55, done: false });
  assert.strictEqual(callbackCalled, 1);
  assert.strictEqual(originalNextCalled, 1); // original next IS called
  assert.strictEqual(iter.next, originalNext); // next is restored
  assert.strictEqual(iter.throw, originalThrow); // throw is restored!

  // Reset counters
  callbackCalled = 0;
  originalNextCalled = 0;
  originalThrowCalled = 0;

  // 4. Test throw() restores but falls back if result is undefined
  unsend(iter, undefined, false, callback);
  assert.notStrictEqual(iter.next, originalNext);
  assert.notStrictEqual(iter.throw, originalThrow);

  await assert.rejects(iter.throw?.(new Error("real error")), /real error/);
  assert.strictEqual(callbackCalled, 1);
  assert.strictEqual(originalThrowCalled, 1);
  assert.strictEqual(iter.next, originalNext);
  assert.strictEqual(iter.throw, originalThrow);

  // 5. Test unsend on iterator WITHOUT a throw method
  const iterWithoutThrow = {
    next: async () => ({ value: 1, done: false }),
  } as any;

  unsend(iterWithoutThrow, { value: 1, done: false }, false);

  // It shouldn't add a throw or return method during monkey-patching!
  // If `if (originalThrow)` or `if (originalReturn)` mutants are active, this will fail.
  assert.strictEqual(
    "throw" in iterWithoutThrow,
    false,
    "Should not add throw method",
  );
  assert.strictEqual(
    "return" in iterWithoutThrow,
    false,
    "Should not add return method",
  );

  await iterWithoutThrow.next();

  // After restoring, it still shouldn't have a throw or return method!
  assert.strictEqual(
    "throw" in iterWithoutThrow,
    false,
    "Should not add throw property",
  );
  assert.strictEqual(
    "return" in iterWithoutThrow,
    false,
    "Should not add return property",
  );

  // 6. Test return() restores next, throw, and return
  let originalReturnCalled = 0;
  const originalReturn = async (v?: any) => {
    originalReturnCalled++;
    return { value: v, done: true };
  };

  const iterWithReturn = {
    next: originalNext,
    throw: originalThrow,
    return: originalReturn,
  } as unknown as AsyncIterator<any>;

  unsend(
    iterWithReturn,
    Promise.resolve({ value: 10, done: false }),
    false,
    callback,
  );
  assert.notStrictEqual(iterWithReturn.next, originalNext);
  assert.notStrictEqual(iterWithReturn.throw, originalThrow);
  assert.notStrictEqual(iterWithReturn.return, originalReturn);

  const res3 = await iterWithReturn.return?.();
  assert.deepStrictEqual(res3, { value: undefined, done: true });
  assert.strictEqual(originalReturnCalled, 1);
  assert.strictEqual(iterWithReturn.next, originalNext);
  assert.strictEqual(iterWithReturn.throw, originalThrow);
  assert.strictEqual(iterWithReturn.return, originalReturn);

  // 7. Test unsend without callback on return()
  let returnCalled2 = 0;
  const iterWithReturn2 = {
    next: async () => ({ value: 1, done: false }),
    return: async () => {
      returnCalled2++;
      return { value: undefined, done: true };
    },
  } as any;
  unsend(iterWithReturn2, { value: 1, done: false }); // No callback!
  await iterWithReturn2.return?.();
  assert.strictEqual(returnCalled2, 1);
});
