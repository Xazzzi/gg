import * as assert from "node:assert";
import { test } from "node:test";
import { Channel } from "../../src/channel.ts";

test("channel.throw(customError) rejects pending producers with custom error", async () => {
  const ch = new Channel<number>();

  let rejectionError: unknown;
  ch.asend(1).catch(err => {
    rejectionError = err;
  });

  const customError = new Error("Custom error");
  ch.throw(customError);

  // Wait for microtasks to flush
  await new Promise(resolve => setImmediate(resolve));

  assert.strictEqual(rejectionError, customError);
});
