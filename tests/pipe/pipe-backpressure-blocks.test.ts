import * as assert from "node:assert";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { pipe } from "../../src/pipe.ts";

test("pipe with backPressure: true (default) blocks start() until read", async () => {
  // Promise
  const ch1 = pipe(Promise.resolve(1), {
    autoStart: true,
    backPressure: true,
    autoClose: true,
  });

  // AsyncIterator (loop, pure iterator)
  const iter2 = {
    count: 0,
    next() {
      this.count++;
      return Promise.resolve({ value: 2, done: false });
    },
  };
  const ch2 = pipe(iter2, {
    autoStart: true,
    backPressure: true,
    autoClose: true,
  });

  // AsyncIterator (return, pure iterator)
  const iter3 = {
    count: 0,
    next() {
      this.count++;
      return Promise.resolve({ value: 99, done: true });
    },
  };
  const ch3 = pipe(iter3, {
    autoStart: true,
    backPressure: true,
    autoClose: true,
  });

  // Wait for microtask queue flush
  await setImmediate();

  // None of them should be closed because they are blocked on send!
  assert.strictEqual(ch1.signal.aborted, false);

  // If backpressure works, iter2 should be blocked after first yield!
  assert.strictEqual(iter2.count, 1);
  assert.strictEqual(ch2.signal.aborted, false);

  // If backpressure works on return, iter3 should have returned 99 and BLOCKED on sending it.
  assert.strictEqual(iter3.count, 1);
  assert.strictEqual(ch3.signal.aborted, false);

  // Clean up by reading values so they can finish
  await ch1[Symbol.asyncIterator]().next();
  await ch2[Symbol.asyncIterator]().next();
  await ch3[Symbol.asyncIterator]().next();
});

test("pipe with backPressure: false does not block start(), auto-closes immediately", async () => {
  // Promise
  const ch1 = pipe(Promise.resolve(1), {
    autoStart: true,
    backPressure: false,
    autoClose: true,
  });

  // AsyncIterator (loop)
  async function* gen2() {
    yield 2;
  }
  const ch2 = pipe(gen2(), {
    autoStart: true,
    backPressure: false,
    autoClose: true,
  });

  // AsyncIterator (return)
  const iter3 = {
    count: 0,
    next() {
      if (this.count++ === 0) return Promise.resolve({ value: 3, done: false });
      return Promise.resolve({ value: 99, done: true });
    },
  };
  const ch3 = pipe(iter3, {
    autoStart: true,
    backPressure: false,
    autoClose: true,
  });

  await setImmediate();

  // All of them should be closed immediately because they don't block!
  assert.strictEqual(ch1.signal.aborted, true);
  assert.strictEqual(ch2.signal.aborted, true);
  assert.strictEqual(ch3.signal.aborted, true);
});
