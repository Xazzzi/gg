import * as assert from "node:assert";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { pipe } from "../../src/pipe.ts";

test("pipe backPressure: false sends values immediately", async () => {
  // Promise
  const ch1 = pipe(Promise.resolve(1), {
    autoStart: true,
    backPressure: false,
    autoClose: false,
  });

  // AsyncIterable
  async function* gen2() {
    yield 2;
  }
  const ch2 = pipe(gen2(), {
    autoStart: true,
    backPressure: false,
    autoClose: false,
  });

  // Iterator (Async)
  const iter3 = {
    count: 0,
    next() {
      if (this.count++ === 0) return Promise.resolve({ value: 3, done: false });
      return Promise.resolve({ done: true, value: undefined });
    },
  };
  const ch3 = pipe(iter3, {
    autoStart: true,
    backPressure: false,
    autoClose: false,
  });

  await setImmediate();

  assert.strictEqual((await ch1[Symbol.asyncIterator]().next()).value, 1);
  assert.strictEqual((await ch2[Symbol.asyncIterator]().next()).value, 2);
  assert.strictEqual((await ch3[Symbol.asyncIterator]().next()).value, 3);
});

test("pipe backPressure: false rejects synchronous iterators", async () => {
  function* gen4() {
    yield 4;
  }
  const ch4 = pipe(gen4(), { autoStart: true, backPressure: false });
  const iter4 = ch4[Symbol.asyncIterator]();
  await assert.rejects(iter4.next(), {
    name: "TypeError",
    message: "Synchronous iterators require backPressure: true",
  });
});

test("pipe backPressure: false rejects synchronous iterables", async () => {
  const arr = [5];
  const ch5 = pipe(arr, { autoStart: true, backPressure: false });
  const iter5 = ch5[Symbol.asyncIterator]();
  await assert.rejects(iter5.next(), {
    name: "TypeError",
    message: "Synchronous iterables require backPressure: true",
  });
});
