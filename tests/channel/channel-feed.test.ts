import * as assert from "node:assert";
import { test } from "node:test";
import { Channel } from "../../src/channel.ts";

test("Channel.feed() feeds a source to the channel and returns a promise", async () => {
  const ch = new Channel<number>();

  const source = [1, 2, 3];

  // Call the convenience method
  const result = ch.feed(source, { autoStart: true, autoClose: true });

  // Method returns a Promise
  assert.ok(result instanceof Promise);

  const it = ch[Symbol.asyncIterator]();

  assert.strictEqual((await it.next()).value, 1);
  assert.strictEqual((await it.next()).value, 2);
  assert.strictEqual((await it.next()).value, 3);
  assert.strictEqual((await it.next()).done, true);

  // The promise should resolve when the feed is done
  await result;
  assert.ok(true);
});
