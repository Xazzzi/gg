import * as assert from "node:assert";
import { test } from "node:test";
import { Channel } from "../../src/channel.ts";

test("pipe autoClose: 'strong' closes channel immediately even if other sources are active", async () => {
  const ch = new Channel<number>();
  const p1 = Promise.withResolvers<number>();
  const p2 = Promise.resolve(2);

  ch.pipe(p1.promise, { autoStart: true });
  ch.pipe(p2, { autoStart: true, autoClose: "strong" });

  const it = ch[Symbol.asyncIterator]();
  assert.strictEqual((await it.next()).value, 2);
  // because p2 finishes and uses 'strong', it should close ch!
  assert.strictEqual((await it.next()).done, true);
});
