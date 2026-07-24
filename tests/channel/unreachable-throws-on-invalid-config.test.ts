import * as assert from "node:assert";
import { test } from "node:test";
import { Channel, type FirstReceive } from "../../src/channel.ts";

test("unreachable throws on invalid config", async () => {
  const ch = new Channel<number>({ firstReceive: "INVALID" as FirstReceive });
  const iter = ch[Symbol.asyncIterator]();
  await assert.rejects(iter.next(), /Unreachable branch/);
});
