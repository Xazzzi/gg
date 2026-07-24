import * as assert from "node:assert";
import { test } from "node:test";
import { Channel } from "../../src/channel.ts";

test("close sets reason to Channel closed", () => {
  const ch = new Channel();
  ch.close();
  assert.strictEqual(ch.signal.reason, "Channel closed");
});
