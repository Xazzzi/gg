import * as assert from "node:assert";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { Channel } from "../../src/channel.ts";

test("channel safely skips GC'd observers in send loop", async () => {
  const ch = new Channel<number>();

  let resolvers: any = Promise.withResolvers<number>();
  resolvers.promise.catch(() => {});
  ch.send(10, resolvers);
  resolvers = null;

  global.gc?.();
  await setImmediate();
  global.gc?.();
  await setImmediate();

  const iter = ch[Symbol.asyncIterator]();
  const res = await iter.next();
  assert.strictEqual(res.value, 10);
});

test("channel safely handles GC'd observers before FinalizationRegistry fires", async () => {
  const ch = new Channel<number>();

  let resolvers: any = Promise.withResolvers<number>();
  resolvers.promise.catch(() => {});
  ch.send(10, resolvers);
  resolvers = null;

  // Flush all event loop queues to ensure 'resolvers' is detached
  await setImmediate();

  // Sweep the WeakRef
  global.gc?.();
  global.gc?.();

  // The FinalizationRegistry callback is now queued in the macrotask queue.
  // We pull from the channel. `await iter.next()` will queue a microtask because `#value.promise` is resolved.
  // Microtasks run before macrotasks, so `#acks` will be iterated before the registry cleans it up!
  const iter = ch[Symbol.asyncIterator]();
  const res = await iter.next();

  assert.strictEqual(res.value, 10);
});

test("channel safely handles GC'd observers before FinalizationRegistry fires during throw", async () => {
  const ch = new Channel<number>();

  let resolvers: any = Promise.withResolvers<number>();
  resolvers.promise.catch(() => {});
  ch.send(10, resolvers);
  resolvers = null;

  await setImmediate();
  global.gc?.();
  global.gc?.();

  ch.throw(new Error("custom"));
});
