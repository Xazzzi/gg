import * as assert from "node:assert";
import { test } from "node:test";
import { Channel, isStopError, STOP } from "../../src/channel.ts";

test("isStopError correctly identifies stop errors from rejected producers", async () => {
  const ch = new Channel<number>({ stopStyle: "stop" });

  let rejectionError: unknown;
  ch.asend(1).catch(err => {
    rejectionError = err;
  });

  ch.close();

  // Wait for the rejection to process
  await new Promise(resolve => setImmediate(resolve));

  assert.ok(rejectionError instanceof Error);
  assert.strictEqual(rejectionError.message, "Channel closed");
  assert.strictEqual((rejectionError as any).reason, STOP);
  assert.strictEqual(isStopError(rejectionError), true);

  // Test false cases
  assert.strictEqual(isStopError(new Error("Other error")), false);
  assert.strictEqual(isStopError(null), false);
  assert.strictEqual(isStopError(undefined), false);
  assert.strictEqual(isStopError({ reason: "STOP" }), false);
});
