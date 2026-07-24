import { test } from "node:test";
import { Channel } from "../../src/channel.ts";
import { assertStatus } from "../utils.test.ts";

test("does not prematurely resolve newer promises when reading older values", async () => {
  const ch = new Channel<number>({ thenReceive: "every" });
  const iter = ch[Symbol.asyncIterator]();

  const p1 = ch.asend(1);
  const p2 = ch.asend(2); // Map now has {1: ref1, 2: ref2}

  await Promise.race([
    iter.next(),
    new Promise((_, r) =>
      setImmediate(() => r(new Error("Hanged on first iter.next"))),
    ),
  ]); // pulls 1. Map iteration should break before resolving p2!
  await assertStatus(p1, "resolved");
  await assertStatus(p2, "pending");

  await Promise.race([
    iter.next(),
    new Promise((_, r) =>
      setImmediate(() => r(new Error("Hanged on second iter.next"))),
    ),
  ]); // pulls 2.
  await assertStatus(p2, "resolved");
});
