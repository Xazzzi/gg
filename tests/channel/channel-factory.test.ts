import { test } from "node:test";
import * as assert from "node:assert";
import { channel, Channel } from "../../src/channel.ts";

test("channel factory function creates a Channel", () => {
  const ch = channel<number>();
  assert.ok(ch instanceof Channel);
});
