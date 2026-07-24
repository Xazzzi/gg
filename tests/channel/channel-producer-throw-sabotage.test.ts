import * as assert from "node:assert";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { Channel } from "../../src/channel.ts";

test("one producer cannot sabotage others via a throwing nextAck", async () => {
  const ch = new Channel<number>();

  // 1. First producer sends a value with a malicious nextAck that throws
  let maliciousAckCalled = false;
  ch.send(1, {
    resolve: () => {
      maliciousAckCalled = true;
      throw new Error("Malicious consumer throw");
    },
    reject: () => {},
  } as any);

  // 2. Second producer sends a value with a normal nextAck (via asend)
  let normalAckResolved = false;
  ch.asend(2).then(() => {
    normalAckResolved = true;
  });

  // 3. Consumer reads the first value
  const iter = ch[Symbol.asyncIterator]();
  const res1 = await iter.next();

  assert.strictEqual(res1.value, 1);
  assert.strictEqual(maliciousAckCalled, true);

  // Wait for microtasks to flush so the second producer's asend can resolve
  await setImmediate();

  // The first producer threw, but the loop in Channel should have caught it
  // and continued to process (and resolve) the second producer's ack when its value is read!
  // Wait, the second producer's value hasn't been read yet.
  // It will be resolved when it gets READ. Let's read it.
  const res2 = await iter.next();
  assert.strictEqual(res2.value, 2);

  await setImmediate();
  assert.strictEqual(
    normalAckResolved,
    true,
    "Second producer should be resolved",
  );
});

test("one producer cannot sabotage channel throw via a throwing reject", async () => {
  const ch = new Channel<number>();

  let maliciousRejectCalled = false;
  ch.send(1, {
    resolve: () => {},
    reject: () => {
      maliciousRejectCalled = true;
      throw new Error("Malicious consumer reject");
    },
  } as any);

  ch.throw(new Error("Boom"));

  await setImmediate();

  assert.strictEqual(maliciousRejectCalled, true);
});
