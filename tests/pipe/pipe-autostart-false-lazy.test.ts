import * as assert from "node:assert";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { Channel } from "../../src/channel.ts";

test("pipe lazy starts only when consumed", async () => {
  let pulled = false;
  async function* gen() {
    pulled = true;
    yield 1;
  }
  const ch = new Channel<number>();
  ch.pipe(gen());

  await setImmediate();
  assert.strictEqual(pulled, false);

  const it = ch[Symbol.asyncIterator]();
  const nextP = it.next();
  await setImmediate();
  assert.strictEqual(pulled, true);

  assert.strictEqual((await nextP).value, 1);
});
