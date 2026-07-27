import { test } from "node:test";
import * as assert from "node:assert";
import { Channel } from "../../src/channel.ts";
import { select } from "../../src/select.ts";
import { setImmediate } from "node:timers/promises";

test("select with backPressure: false sends without awaiting consumer", async () => {
  const ch1 = new Channel<number>();
  let changesCount = 0;
  const state = select(
    { v: ch1 },
    {
      backPressure: false,
      autoStart: true,
      onChanges: () => {
        changesCount++;
      },
    },
  );

  // Constructor emit calls onChanges (changesCount = 1)
  ch1.send(1);
  await setImmediate();
  assert.strictEqual(changesCount, 2);
  
  ch1.send(2);
  await setImmediate();
  assert.strictEqual(changesCount, 3);

  state[Symbol.dispose]();
});

test("select with backPressure: true blocks on unread consumers", async () => {
  const ch1 = new Channel<number>();
  let changesCount = 0;
  const state = select(
    { v: ch1 },
    {
      backPressure: true, // This is default
      autoStart: true,
      onChanges: () => {
        changesCount++;
      },
    },
  );

  // Constructor emit calls onChanges (changesCount = 1)
  ch1.send(1);
  await setImmediate();
  // 1st value processed, onChanges fired. But asend blocks, so pullAsync is skipped.
  assert.strictEqual(changesCount, 2);
  
  ch1.send(2);
  await setImmediate();
  // 2nd value is not pulled because pullAsync was skipped in previous blocked emit.
  assert.strictEqual(changesCount, 2);

  state[Symbol.dispose]();
});
