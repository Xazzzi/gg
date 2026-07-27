import * as assert from "node:assert";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { Channel } from "../../src/channel.ts";

test("pipe with backPressure respects channel backlog", async () => {
  const ch = new Channel<number>();
  let count = 0;
  async function* gen() {
    count++;
    yield 1;
    count++;
    yield 2;
  }

  ch.pipe(gen(), { autoStart: true, backPressure: true });

  await setImmediate();
  // 1 is sent and blocked
  assert.strictEqual(count, 1);

  const it = ch[Symbol.asyncIterator]();
  await it.next();
  await setImmediate();
  assert.strictEqual(count, 2);
});
