import * as assert from "node:assert";
import { test } from "node:test";
import { pipe } from "../../src/pipe.ts";

test("pipe extracts return value from Iterator with backpressure", async () => {
  const iter = {
    count: 0,
    next() {
      if (this.count++ === 0) return { value: 1, done: false };
      return { value: 99, done: true };
    },
  };

  const ch = pipe(iter, { autoStart: true, backPressure: true });
  const it = ch[Symbol.asyncIterator]();

  assert.strictEqual((await it.next()).value, 1);
  assert.strictEqual((await it.next()).value, 99);
});

test("pipe extracts return value from AsyncIterator with backPressure false", async () => {
  const iter = {
    count: 0,
    next() {
      if (this.count++ === 0) return Promise.resolve({ value: 1, done: false });
      return Promise.resolve({ value: 99, done: true });
    },
  };

  const ch = pipe(iter, { autoStart: true, backPressure: false });
  const it = ch[Symbol.asyncIterator]();

  assert.strictEqual((await it.next()).value, 1);
  assert.strictEqual((await it.next()).value, 99);
});
