import * as assert from "node:assert";
import { test } from "node:test";
import { Channel, STOP } from "../../src/channel.ts";

test("pipe gracefully handles AbortError from source", async () => {
  const ch = new Channel();
  // biome-ignore lint/correctness/useYield: test
  async function* gen() {
    throw Object.assign(new Error(), { reason: STOP });
  }

  ch.pipe(gen(), { autoStart: true, onThrow: "throw" });

  // It shouldn't throw AbortError on the channel, just close it gracefully.
  const it = ch[Symbol.asyncIterator]();
  assert.strictEqual((await it.next()).done, true);
});
