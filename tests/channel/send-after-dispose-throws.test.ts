import * as assert from "node:assert";
import { test } from "node:test";
import { Channel } from "../../src/channel.ts";

test("send() after dispose() throws", () => {
  const ch = new Channel<number>();
  ch[Symbol.dispose]();
  assert.throws(() => ch.send(1));
});
