import * as assert from "node:assert";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { Channel } from "../../src/channel.ts";

test("stopStyle: 'stop' hanging producers on close", async () => {
  const ch = new Channel<number>({ stopStyle: "stop" });
  const iter = ch[Symbol.asyncIterator]();

  let resolved = false;
  let rejected = false;

  // This producer will hang because the value is never read,
  // and the channel is closed with stopStyle: 'stop'.
  ch.asend(1).then(
    () => {
      resolved = true;
    },
    () => {
      rejected = true;
    },
  );

  // Close the channel immediately
  ch.close();

  // Try to read (it should return done because stopStyle: 'stop' breaks the loop immediately)
  const res = await iter.next();
  assert.strictEqual(res.done, true, "Iterator should be done");

  // Let microtasks flush
  await setImmediate();

  // They should no longer hang. They should be rejected!
  assert.strictEqual(resolved, false, "Producer should not resolve");
  assert.strictEqual(rejected, true, "Producer should be rejected on close");
});
