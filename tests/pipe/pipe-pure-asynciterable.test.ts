import * as assert from "node:assert";
import { test } from "node:test";
import { pipe } from "../../src/pipe.ts";

test("pipe processes pure AsyncIterable (not Iterator)", async () => {
  const pureAsyncIterable = {
    async *[Symbol.asyncIterator]() {
      yield 42;
    },
  };

  const ch = pipe(pureAsyncIterable, { autoStart: true });
  const it = ch[Symbol.asyncIterator]();

  assert.strictEqual((await it.next()).value, 42);
  assert.strictEqual((await it.next()).done, true);
});
