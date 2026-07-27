import * as assert from "node:assert";
import { test } from "node:test";
import { Channel } from "../../src/channel.ts";

test("Channel.pipe() pipes a source to the channel", async () => {
  const ch = new Channel<number>();

  const source = [1, 2, 3];

  // Call the convenience method
  const result = ch.pipe(source, { autoStart: true, autoClose: true });

  // Method returns the channel itself
  assert.strictEqual(result, ch);

  const it = ch[Symbol.asyncIterator]();

  assert.strictEqual((await it.next()).value, 1);
  assert.strictEqual((await it.next()).value, 2);
  assert.strictEqual((await it.next()).value, 3);
  assert.strictEqual((await it.next()).done, true);
});
