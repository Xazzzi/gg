import * as assert from "node:assert";
import { test } from "node:test";
import { Channel } from "../../src/channel.ts";

test("pipe onThrow: 'ignore' swallows error", async () => {
  const ch = new Channel();
  const p = Promise.reject(new Error("silent err"));
  p.catch(() => {});

  ch.pipe(p, { autoStart: true, onThrow: "ignore" });

  // It shouldn't throw on the channel, just close it.
  const it = ch[Symbol.asyncIterator]();
  assert.strictEqual((await it.next()).done, true);
});
