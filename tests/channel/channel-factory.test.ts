import * as assert from "node:assert";
import { test } from "node:test";
import { Channel, channel } from "../../src/channel.ts";

test("channel factory function creates a Channel", () => {
  const ch = channel<number>();
  assert.ok(ch instanceof Channel);
});
