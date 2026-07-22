// biome-ignore-all lint/correctness/useYield: tests
import * as assert from "node:assert";
import { describe, test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { select } from "./select.ts";

describe("select", () => {
  test("select on plain object", async () => {
    const s = select({ a: 1, b: "two" });
    const it = s[Symbol.asyncIterator]();

    // Initial and only emit
    const v1 = await it.next();
    assert.deepEqual(v1.value, { a: 1, b: "two" });

    // Channel closes immediately after since no pending promises
    const v2 = await it.next();
    assert.strictEqual(v2.done, true);
  });

  test("select with promises", async () => {
    const p1 = Promise.withResolvers<number>();
    const p2 = Promise.withResolvers<string>();

    const s = select({ a: 1, b: p1.promise, c: p2.promise });
    const it = s[Symbol.asyncIterator]();

    // initial emit
    const v1 = await it.next();
    assert.deepEqual(v1.value, {
      a: 1,
      b: { status: "pending" },
      c: { status: "pending" },
    });

    p1.resolve(42);
    const v2 = await it.next();
    assert.deepEqual(v2.value, {
      a: 1,
      b: { status: "fulfilled", value: 42 },
      c: { status: "pending" },
    });

    p2.reject("err");
    const v3 = await it.next();
    assert.deepEqual(v3.value, {
      a: 1,
      b: { status: "fulfilled", value: 42 },
      c: { status: "rejected", reason: "err" },
    });

    // Both promises settled, checkClose should fire
    const v4 = await it.next();
    assert.strictEqual(v4.done, true);
  });

  test("select with async generator", async () => {
    const p1 = Promise.withResolvers<void>();
    const p2 = Promise.withResolvers<void>();

    async function* gen() {
      await p1.promise;
      yield 100;
      await p2.promise;
      yield 200;
    }

    const s = select({ g: gen() });
    const it = s[Symbol.asyncIterator]();

    let v = await it.next();
    assert.deepEqual(v.value, { g: { status: "pending" } });

    p1.resolve();
    v = await it.next();
    assert.deepEqual(v.value, {
      g: { status: "fulfilled", value: 100, done: false },
    });

    p2.resolve();
    v = await it.next();
    assert.deepEqual(v.value, {
      g: { status: "fulfilled", value: 200, done: false },
    });

    // The final state change (done: true) queued a second emit of the same mutable object
    v = await it.next();
    assert.deepEqual(v.value, {
      g: { status: "fulfilled", value: 200, done: true },
    });

    // generator exhausted, checkClose fires
    v = await it.next();
    assert.strictEqual(v.done, true);
  });

  test("select with generator throwing error", async () => {
    const p1 = Promise.withResolvers<void>();

    async function* gen() {
      await p1.promise;
      throw "boom";
    }

    const s = select({ g: gen() });
    const it = s[Symbol.asyncIterator]();

    let v = await it.next();
    assert.deepEqual(v.value, { g: { status: "pending" } });

    p1.resolve();
    v = await it.next();
    assert.deepEqual(v.value, { g: { status: "rejected", reason: "boom" } });

    v = await it.next();
    assert.strictEqual(v.done, true);
  });

  test("select handles null and primitives without crashing", async () => {
    // biome-ignore lint/suspicious/noThenProperty: test
    const s = select({ a: null, b: undefined, c: false, d: { then: 1 } });
    const it = s[Symbol.asyncIterator]();
    const v = await it.next();
    assert.deepEqual(v.value, {
      a: null,
      b: undefined,
      c: false,
      // biome-ignore lint/suspicious/noThenProperty: test
      d: { then: 1 },
    });
    const v2 = await it.next();
    assert.strictEqual(v2.done, true);
  });

  test("select batches synchronous updates", async () => {
    const p1 = Promise.withResolvers<number>();
    const p2 = Promise.withResolvers<number>();
    const s = select({ a: p1.promise, b: p2.promise });
    const it = s[Symbol.asyncIterator]();

    await it.next(); // pending

    p1.resolve(1);
    p2.resolve(2);

    const v = await it.next();
    assert.deepEqual(v.value, {
      a: { status: "fulfilled", value: 1 },
      b: { status: "fulfilled", value: 2 },
    });

    const v2 = await it.next();
    assert.strictEqual(v2.done, true);
  });

  test("select with pure async iterable", async () => {
    const iterable = {
      async *[Symbol.asyncIterator]() {
        yield 42;
      },
    };
    const s = select({ a: iterable });
    const it = s[Symbol.asyncIterator]();

    await it.next(); // pending
    const v = await it.next();
    assert.deepEqual(v.value, {
      a: { status: "fulfilled", value: 42, done: false },
    });

    // The final state change (done: true) queues a second emit
    const v2 = await it.next();
    assert.deepEqual(v2.value, {
      a: { status: "fulfilled", value: 42, done: true },
    });

    // No more changes to expect - channel closes
    const v3 = await it.next();
    assert.strictEqual(v3.done, true);
  });

  test("select with array in shape remains as is", async () => {
    const s = select({ a: [1, 2, 3] });
    const it = s[Symbol.asyncIterator]();

    let v = await it.next();
    assert.deepEqual(v.value, { a: [1, 2, 3] });

    v = await it.next();
    assert.strictEqual(v.done, true);
  });

  test("select with array shape itself", async () => {
    const p1 = Promise.withResolvers<number>();
    const p2 = Promise.withResolvers<void>();
    const iterable = {
      async *[Symbol.asyncIterator]() {
        await p2.promise;
        yield "hello";
      },
    };

    const s = select([p1.promise, iterable, 42]);
    const it = s[Symbol.asyncIterator]();

    let v = await it.next();
    assert.ok(Array.isArray(v.value));
    assert.deepEqual(v.value, [
      { status: "pending" },
      { status: "pending" },
      42,
    ]);

    p1.resolve(100);
    v = await it.next();
    assert.deepEqual(v.value, [
      { status: "fulfilled", value: 100 },
      { status: "pending" },
      42,
    ]);

    // let iterable resolve
    p2.resolve();
    v = await it.next();
    assert.deepEqual(v.value, [
      { status: "fulfilled", value: 100 },
      { status: "fulfilled", value: "hello", done: false },
      42,
    ]);

    // iterable finishes
    v = await it.next();
    assert.deepEqual(v.value, [
      { status: "fulfilled", value: 100 },
      { status: "fulfilled", value: "hello", done: true },
      42,
    ]);

    // Channel closes, no further updates expected
    assert.equal((await it.next()).done, true);
  });

  test("select empty array shape", async () => {
    const s = select([]);
    const it = s[Symbol.asyncIterator]();
    const v = await it.next();
    assert.deepEqual(v.value, []);
    assert.equal(v.done, false);
    assert.equal((await it.next()).done, true);
  });

  test("select ignores updates after being manually closed", async () => {
    const p = Promise.withResolvers<number>();
    const s = select({ a: p.promise });

    // Start it
    const it = s[Symbol.asyncIterator]();
    await it.next(); // pending

    // Manually abort
    s.close();

    // Resolve promise AFTER close
    p.resolve(42);

    const after = await it.next();
    assert.ok(after.done);
    assert.strictEqual(after.value, undefined);
  });

  test("select with generator yielding undefined", async () => {
    async function* gen() {
      yield 1;
      yield undefined;
    }
    const s = select({ g: gen() });
    const it = s[Symbol.asyncIterator]();
    await it.next(); // pending
    let v = await it.next();
    assert.deepEqual(v.value, {
      g: { status: "fulfilled", value: 1, done: false },
    });
    v = await it.next();
    assert.deepEqual(v.value, {
      g: { status: "fulfilled", value: undefined, done: false },
    });
    v = await it.next();
    assert.deepEqual(v.value, {
      g: { status: "fulfilled", value: undefined, done: true },
    });
  });

  test("select with sync iterator yielding non-promises only advances on promise resolves", async () => {
    const p1 = Promise.withResolvers<number>();
    const p2 = Promise.withResolvers<number>();

    function* gen() {
      yield 1;
      yield p2.promise;
      yield 3;
    }

    const s = select({ p: p1.promise, g: gen() });
    const it = s[Symbol.asyncIterator]();

    let v = await it.next();
    assert.deepEqual(v.value, {
      p: { status: "pending" },
      g: { status: "fulfilled", value: 1, done: false },
    });

    p1.resolve(42);

    // because we resolved a promise, sync gen will advance,
    // yields a promise, that will in turn drive one more step.
    // until that resolves the value is held.
    v = await it.next();
    assert.deepEqual(v.value, {
      p: { status: "fulfilled", value: 42 },
      g: { status: "fulfilled", value: 1, done: false },
    });

    p2.resolve(69);

    // p2 is resolved. no other pending promises.
    const v2 = await it.next();
    assert.deepEqual(v2.value, {
      p: { status: "fulfilled", value: 42 },
      g: { status: "fulfilled", value: 69, done: false },
    });
  });

  test("select with sync iterator yielding promises", async () => {
    const p1 = Promise.withResolvers<number>();
    const p2 = Promise.withResolvers<number>();
    const p3 = Promise.withResolvers<number>();

    function* gen() {
      yield p1.promise;
      yield p2.promise;
      yield 3;
    }

    const s = select({ p3: p3.promise, g: gen() });
    const it = s[Symbol.asyncIterator]();

    let v = await it.next();
    assert.deepEqual(v.value, {
      p3: { status: "pending" },
      g: { status: "pending" },
    });

    p1.resolve(100);
    v = await it.next();
    assert.deepEqual(v.value, {
      p3: { status: "pending" },
      g: { status: "fulfilled", value: 100, done: false },
    });

    p3.resolve(300);
    v = await it.next();
    assert.deepEqual(v.value, {
      p3: { status: "fulfilled", value: 300 },
      g: { status: "fulfilled", value: 100, done: false }, // Retains previous state while p2 is pending
    });

    p2.resolve(200);
    v = await it.next();
    assert.deepEqual(v.value, {
      p3: { status: "fulfilled", value: 300 },
      g: { status: "fulfilled", value: 200, done: false },
    });

    v = await it.next();
    assert.strictEqual(v.done, true);
  });

  test("select with generator throwing synchronously", async () => {
    function* gen() {
      throw "sync boom";
    }

    const s = select({ g: gen() });
    const it = s[Symbol.asyncIterator]();

    let v = await it.next();
    assert.deepEqual(v.value, {
      g: { status: "rejected", reason: "sync boom" },
    });

    v = await it.next();
    assert.strictEqual(v.done, true);
  });

  test("select with generator returning synchronously alongside another promise", async () => {
    const p = Promise.withResolvers<void>();
    function* gen() {
      return "sync done";
    }

    const s = select({ p: p.promise, g: gen() });
    const it = s[Symbol.asyncIterator]();

    const v = await it.next();
    assert.deepEqual(v.value, {
      p: { status: "pending" },
      g: { status: "fulfilled", value: "sync done", done: true },
    });
  });

  test("select with async generator returning a value", async () => {
    const p = Promise.withResolvers<void>();
    async function* gen() {
      await p.promise;
      return "async final";
    }
    const s = select({ g: gen() });
    const it = s[Symbol.asyncIterator]();

    let v = await it.next();
    assert.deepEqual(v.value, { g: { status: "pending" } });

    p.resolve();
    v = await it.next();
    assert.deepEqual(v.value, {
      g: { status: "fulfilled", value: "async final", done: true },
    });
  });

  test("select does not pull sync generator after being manually closed", async () => {
    let pulled = false;
    function* gen() {
      yield 1; // Evaluated during setup pull
      yield 2; // Evaluated at the end of the initial emit()
      pulled = true; // Should never be reached because channel is aborted before next emit
      yield 3;
    }
    const p = Promise.withResolvers<void>();
    const s = select({ p: p.promise, g: gen() });
    const it = s[Symbol.asyncIterator]();

    await it.next();

    s.close();
    p.resolve();

    await Promise.resolve();
    assert.strictEqual(pulled, false);
  });

  test("select with async generator throwing synchronously in next()", async () => {
    const iterable = {
      [Symbol.asyncIterator]() {
        return {
          next() {
            throw new Error("async boom");
          },
        };
      },
    };
    const s = select({ a: iterable });
    const it = s[Symbol.asyncIterator]();

    // If empty catch block mutated, it.next() will hang, emptying event loop and failing silently.
    // Wrap in race to force timeout failure.
    const v = await Promise.race([
      it.next(),
      setTimeout(50).then(() => Promise.reject(new Error("Timeout"))),
    ]);
    assert.strictEqual((v.value as any).a.status, "rejected");
    assert.strictEqual((v.value as any).a.reason.message, "async boom");
    const v2 = await it.next();
    assert.strictEqual(v2.done, true);
  });

  test("select with async iterator missing next method", async () => {
    const iterable = {
      [Symbol.asyncIterator]() {
        return {} as any; // No next method!
      },
    };
    const s = select({ a: iterable });
    const it = s[Symbol.asyncIterator]();

    const v = await Promise.race([
      it.next(),
      setTimeout(50).then(() => Promise.reject(new Error("Timeout"))),
    ]);
    assert.strictEqual((v.value as any).a.status, "rejected");
    assert.ok((v.value as any).a.reason instanceof TypeError);
  });

  test("select with async iterator throwing synchronously on second next()", async () => {
    let calls = 0;
    const iterable = {
      [Symbol.asyncIterator]() {
        return {
          next() {
            if (calls === 0) {
              calls++;
              return Promise.resolve({ value: 42, done: false });
            }
            throw new Error("async boom 2");
          },
        };
      },
    };
    const s = select({ a: iterable });
    const it = s[Symbol.asyncIterator]();

    // First pull emits pending state synchronously
    const v0 = await it.next();
    assert.deepEqual((v0.value as any).a, { status: "pending" });

    // When the promise resolves, it emits the fulfilled state
    const v1 = await it.next();
    assert.deepEqual((v1.value as any).a, {
      status: "fulfilled",
      value: 42,
      done: false,
    });

    // After v1 is read, pullAsync is driven and throws synchronously
    const v2 = await Promise.race([
      it.next(),
      setTimeout(50).then(() => Promise.reject(new Error("Timeout"))),
    ]);
    assert.strictEqual((v2.value as any).a.status, "rejected");
    assert.strictEqual((v2.value as any).a.reason.message, "async boom 2");
  });

  test("select with raw async iterator", async () => {
    let calls = 0;
    const rawAsyncIterator = {
      next() {
        if (calls++ === 0) return Promise.resolve({ value: 42, done: false });
        return Promise.resolve({ value: undefined, done: true });
      },
    };
    const s = select({ r: rawAsyncIterator });
    const it = s[Symbol.asyncIterator]();

    let v = await it.next();
    assert.deepEqual(v.value, {
      r: { status: "pending" },
    });

    v = await it.next();
    assert.deepEqual(v.value, {
      r: { status: "fulfilled", value: 42, done: false },
    });
  });

  test("select holdDone retains last value for sync iterators", async () => {
    function* gen() {
      yield 42;
      return undefined; // done: true, value: undefined
    }
    const other = Promise.withResolvers<number>();
    const s = select({ g: gen(), o: other.promise }, { holdDone: true });
    const it = s[Symbol.asyncIterator]();

    await it.next(); // 42 and o: pending

    other.resolve(1);
    const v2 = await it.next(); // o: 1, g returns undefined!

    assert.deepEqual((v2.value as any).g, {
      status: "fulfilled",
      value: 42,
      done: true,
    });
  });

  test("select without holdDone does not retain last value for sync iterators", async () => {
    function* gen() {
      yield 42;
      return undefined;
    }
    const other = Promise.withResolvers<number>();
    const s = select(
      { g: gen(), o: other.promise },
      { autoClose: false, holdDone: false },
    );
    const it = s[Symbol.asyncIterator]();

    await it.next();
    other.resolve(1);
    const v2 = await it.next();

    assert.deepEqual((v2.value as any).g, {
      status: "fulfilled",
      value: undefined,
      done: true,
    });
  });

  test("done sync iterators are deleted and don't re-emit", async () => {
    function* gen() {
      yield 42;
    }
    let changes: any;
    const p1 = Promise.withResolvers<number>();
    const p2 = Promise.withResolvers<number>();
    const s = select(
      { g: gen(), p1: p1.promise, p2: p2.promise },
      { onChanges: c => (changes = c) },
    );
    const it = s[Symbol.asyncIterator]();

    await it.next();
    p1.resolve(1);
    await it.next(); // g completes here

    p2.resolve(2);
    await it.next(); // g should not be in changes!
    assert.ok(!("g" in changes));
  });

  test("select holdDone retains last value", async () => {
    async function* gen() {
      yield 42;
      return undefined; // done: true, value: undefined
    }
    const s = select({ g: gen() }, { holdDone: true });
    const it = s[Symbol.asyncIterator]();

    await it.next(); // pending
    await it.next(); // 42, done false
    const fin = await it.next(); // return undefined -> 42, done true
    assert.deepEqual(fin.value?.g, {
      status: "fulfilled",
      value: 42,
      done: true,
    });
  });

  test("select with sync iterator yielding multiple promises concurrently", async () => {
    const p1 = Promise.withResolvers<number>();
    const p2 = Promise.withResolvers<number>();
    let yields = 0;
    function* gen() {
      yield p1.promise;
      yields++;
      yield p2.promise;
    }
    const other = Promise.withResolvers<number>();
    const s = select({ g: gen(), o: other.promise });
    const it = s[Symbol.asyncIterator]();

    await it.next(); // pulls p1 and o.

    // Now trigger an emit by resolving 'o'
    other.resolve(1);
    await it.next(); // emits { o: 1, g: pending }

    // Because 'g' wasn't in changes, pullSync('g') was called again!
    // gen() yields p2.promise!
    assert.strictEqual(yields, 1);

    // Now resolve p1. It should be ignored because p2 is the latest!
    p1.resolve(100);
    // MUST wait for microtasks to flush, otherwise p1 and p2 batch into the same emit, hiding the bug!
    await new Promise(r => setImmediate(r));

    p2.resolve(200);

    const v = await it.next();
    // It should emit 200, not 100!
    assert.deepEqual((v.value as any).g, {
      status: "fulfilled",
      value: 200,
      done: false,
    });
  });

  test("select with sync iterator yielding multiple promises concurrently (rejection race)", async () => {
    const p1 = Promise.withResolvers<number>();
    const p2 = Promise.withResolvers<number>();
    function* gen() {
      yield p1.promise;
      yield p2.promise;
    }
    const other = Promise.withResolvers<number>();
    const s = select({ g: gen(), o: other.promise });
    const it = s[Symbol.asyncIterator]();
    await it.next();
    other.resolve(1);
    await it.next();

    p1.reject("ignore me");
    await new Promise(r => setImmediate(r));
    p2.reject("latest error");

    const v = await it.next();
    assert.deepEqual((v.value as any).g, {
      status: "rejected",
      reason: "latest error",
    });
  });

  test("select changeValues tracking", async () => {
    let changesA: any;
    for await (const _update of select(
      { a: Promise.resolve(1) },
      {
        onChanges(c) {
          changesA = c;
        },
      },
    )) {
      // console.log('A', update, changesA)
    }
    assert.ok(changesA);
    assert.strictEqual(changesA.a, "a"); // Set.entries() yields [key, key]

    let changesB: any;
    for await (const _update of select(
      { b: Promise.resolve(1) },
      {
        changeValues: true,
        onChanges(c) {
          changesB = c;
        },
      },
    )) {
      // console.log('B', update, changesB)
    }
    assert.ok(changesB);
    // Initial value is { status: 'pending' }
    assert.deepEqual(changesB.b, { status: "pending" });
  });
});
