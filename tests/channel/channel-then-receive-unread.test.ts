import * as assert from "node:assert";
import { test } from "node:test";
import { Channel } from "../../src/channel.ts";

test("Channel throws if thenReceive=unread and firstReceive!=unread", () => {
  assert.throws(
    () => new Channel({ thenReceive: "unread", firstReceive: "latest" }),
    { message: 'thenReceive: "unread" requires firstReceive: "unread"' },
  );
  assert.throws(
    () => new Channel({ thenReceive: "unread", firstReceive: "first" }),
    { message: 'thenReceive: "unread" requires firstReceive: "unread"' },
  );
  assert.throws(
    () => new Channel({ thenReceive: "unread", firstReceive: "next" }),
    { message: 'thenReceive: "unread" requires firstReceive: "unread"' },
  );
});

test("thenReceive=unread distributes values and losers continue loop", async () => {
  const ch = new Channel<number>({ thenReceive: "unread" });

  const iter1 = ch[Symbol.asyncIterator]();
  const iter2 = ch[Symbol.asyncIterator]();
  const iter3 = ch[Symbol.asyncIterator]();

  // All 3 iterators await the very first value synchronously
  const p1 = iter1.next();
  const p2 = iter2.next();
  const p3 = iter3.next();

  ch.send(1);
  ch.send(2);
  ch.send(3);
  ch.close();

  const results = await Promise.all([p1, p2, p3]);
  const values = results.map(r => r.value).sort();
  assert.deepStrictEqual(values, [1, 2, 3]);
});
