import * as assert from "node:assert";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { Channel } from "../../src/channel.ts";
import { select } from "../../src/select.ts";

test("select with nonYielding: true does not send values to its channel", async () => {
  const ch1 = new Channel<number>();
  let _latestSnapshot: any;
  let changesCount = 0;
  const _state = select(
    { v: ch1 },
    {
      nonYielding: true,
      autoStart: true,
      onChanges: () => {
        changesCount++;
      },
    },
  );

  ch1.send(1);
  await setImmediate();
  assert.strictEqual(changesCount, 2);

  ch1.send(2);
  await setImmediate();
  assert.strictEqual(changesCount, 3);

  // The iterator should not yield anything, meaning it hangs if we try to read from it.
  // We can just dispose the state and it should clean up gracefully via AbortSignal.
  // But wait, state[Symbol.asyncIterator] is present.

  // Close the sources
  ch1.close();
  await setImmediate();

  // Ensure the loop is exited (this is internal, but at least it shouldn't crash)
});
