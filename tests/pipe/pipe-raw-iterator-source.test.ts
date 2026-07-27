import * as assert from "node:assert";
import { test } from "node:test";
import { pipe } from "../../src/pipe.ts";

test("pipe correctly consumes a raw Iterator", async () => {
  const iter = {
    count: 0,
    next() {
      if (this.count++ < 2) return { value: this.count, done: false };
      return { done: true, value: undefined };
    },
  };
  const ch = pipe(iter, { autoStart: true });
  const it = ch[Symbol.asyncIterator]();
  assert.strictEqual((await it.next()).value, 1);
  assert.strictEqual((await it.next()).value, 2);
  assert.strictEqual((await it.next()).done, true);
});
