import * as assert from "node:assert";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { Channel } from "../../src/channel.ts";

test("latest configurations garbage collect intermediate promises when consumer is busy", async () => {
  if (typeof global.gc !== "function") return; // Skip if not running with --expose-gc

  const ch = new Channel<object>({
    firstReceive: "next",
    thenReceive: "latest",
  });
  const iter = ch[Symbol.asyncIterator]();

  // Consumer awaits first item, holding a reference to Promise 1 in its closure
  const _first = iter.next();
  ch.send({ name: "first" }); // Resolves Promise 1

  // Send the object we want to track (Promise 2)
  let obj: object | null = { name: "leaked" };
  const ref = new WeakRef(obj);
  ch.send(obj); // Resolves Promise 2 with [obj, Promise 3] (if mutant active)
  obj = null; // Drop our strong reference

  // Send one more to move this.#latest to Promise 3
  ch.send({ name: "latest" });

  // const advance = iter.next();

  // Force V8 GC a few times to ensure sweep happens
  global.gc();
  await setImmediate();
  global.gc();
  await setImmediate();

  // If the GC chain optimization is active, Promise 1 -> [first, undefined]
  // Promise 2 and obj are completely unreferenced and should be null
  assert.strictEqual(
    ref.deref(),
    undefined,
    "Memory leak detected in latest channel! Intermediate promises are not being garbage collected.",
  );
});
