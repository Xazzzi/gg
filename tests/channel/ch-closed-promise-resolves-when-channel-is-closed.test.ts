import { test } from "node:test";
import { Channel } from "../../src/channel.ts";
import { assertStatus } from "../utils.test.ts";

test("ch.closed promise resolves when channel is closed", async () => {
  const ch = new Channel<number>();
  const p = ch.closed;
  await assertStatus(p, "pending");
  ch.close();
  await assertStatus(p, "resolved");
});
