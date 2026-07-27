import * as assert from "node:assert";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { Channel } from "../../src/channel.ts";

test("pipe respects aborted channel", async () => {
  // Promise abort
  const ch1 = new Channel<number>();
  ch1.close();
  const p1 = Promise.resolve(1);
  ch1.pipe(p1, { autoStart: true });

  // AsyncIterable abort
  const ch2 = new Channel<number>();
  async function* gen2() {
    yield 1;
  }
  ch2.close();
  ch2.pipe(gen2(), { autoStart: true });

  // Iterator abort
  const ch3 = new Channel<number>();
  const iter3 = {
    next() {
      return { value: 1, done: false };
    },
  };
  ch3.close();
  ch3.pipe(iter3, { autoStart: true });

  // SyncIterable abort
  const ch4 = new Channel<number>();
  function* gen4() {
    yield 1;
  }
  ch4.close();
  ch4.pipe(gen4(), { autoStart: true });

  await setImmediate();
  assert.ok(true); // if it doesn't throw or hang, it passes
});
