import * as assert from "node:assert";
import { test } from "node:test";
import { Channel } from "../../src/channel.ts";

test("firstReceive: unread (default) advances the global read pointer for subsequent consumers", async () => {
  const ch = new Channel<number>({ thenReceive: "every" }); // default is firstReceive: "unread"

  ch.send(1);
  ch.send(2);
  ch.send(3);

  const iter1 = ch[Symbol.asyncIterator]();
  assert.strictEqual((await iter1.next()).value, 1);
  assert.strictEqual((await iter1.next()).value, 2);

  // Since iter1 read 1 and 2, the "unread" pointer advanced.
  // A new consumer should start reading from 3!
  const iter2 = ch[Symbol.asyncIterator]();
  assert.strictEqual((await iter2.next()).value, 3);
});
