import * as assert from "node:assert";
import { test } from "node:test";
import { Channel } from "../../src/channel.ts";

test("throw custom reason", async () => {
  const ch = new Channel();
  const iter = ch[Symbol.asyncIterator]();
  ch.throw("custom boom");
  try {
    await iter.next();
    assert.fail("Should have thrown");
  } catch (e) {
    assert.strictEqual(e, "custom boom");
    assert.strictEqual(ch.signal.reason, "custom boom");
  }
});
