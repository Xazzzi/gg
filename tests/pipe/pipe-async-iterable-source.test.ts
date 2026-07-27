import * as assert from "node:assert";
import { test } from "node:test";
import { pipe } from "../../src/pipe.ts";

async function* gen() {
  yield 1;
  yield 2;
}

test("pipe correctly consumes an AsyncIterable", async () => {
  const ch = pipe(gen(), { autoStart: true });
  const it = ch[Symbol.asyncIterator]();
  assert.strictEqual((await it.next()).value, 1);
  assert.strictEqual((await it.next()).value, 2);
  assert.strictEqual((await it.next()).done, true);
});
