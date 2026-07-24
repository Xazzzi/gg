import * as assert from "node:assert";
import { test } from "node:test";
import { Channel } from "../../src/channel.ts";

test("channel firstReceive: 'latest' without pre-existing value", async () => {
  const ch = new Channel<number>({ firstReceive: "latest" });

  // Create iterator BEFORE sending, so this.#latest is undefined,
  // falling back to this.#value.promise via the ?? operator.
  const it = ch[Symbol.asyncIterator]();

  // Call it.next() BEFORE sending. This forces the generator body to execute
  // while this.#latest is still undefined, hitting the ?? fallback.
  const nextPromise = it.next();

  ch.send(42);

  const v = await nextPromise;
  assert.strictEqual(v.value, 42);
});
