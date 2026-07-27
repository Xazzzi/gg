import * as assert from "node:assert";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { Channel } from "../../src/channel.ts";

test("pipe autoClose: true (normal) keeps channel open until all sources finish", async () => {
  const ch = new Channel<number>();
  const p1 = Promise.withResolvers<number>();
  const p2 = Promise.withResolvers<number>();

  ch.pipe(p1.promise, { autoStart: true });
  ch.pipe(p2.promise, { autoStart: true });

  // Finish first source
  p1.resolve(1);

  const it = ch[Symbol.asyncIterator]();
  assert.strictEqual((await it.next()).value, 1);

  // Channel should still be open
  const nextP = it.next();
  await setImmediate();
  assert.ok((await import("node:util")).inspect(nextP).includes("<pending>"));

  // Finish second source
  p2.resolve(2);
  assert.strictEqual((await nextP).value, 2);

  // Now channel should close
  assert.strictEqual((await it.next()).done, true);
});
