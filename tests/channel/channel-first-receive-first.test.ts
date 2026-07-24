import * as assert from "node:assert";
import { test } from "node:test";
import { Channel } from "../../src/channel.ts";

test("firstReceive: first pulls the very first value sent to the channel even if already read", async () => {
  const ch = new Channel<number>({ firstReceive: "first" });
  ch.send(1);
  ch.send(2);

  const iter1 = ch[Symbol.asyncIterator]();
  assert.strictEqual((await iter1.next()).value, 1);
  assert.strictEqual((await iter1.next()).value, 2);

  // A new consumer with firstReceive: "first" will also start from 1!
  const iter2 = ch[Symbol.asyncIterator]();
  assert.strictEqual((await iter2.next()).value, 1);
  assert.strictEqual((await iter2.next()).value, 2);
});
