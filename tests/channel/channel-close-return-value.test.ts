import * as assert from "node:assert";
import { test } from "node:test";
import { Channel } from "../../src/channel.ts";

test("close(returnValue) sets the return value of the AsyncIterable", async () => {
  const ch = new Channel<number, string>();
  ch.send(1);
  ch.close("done");

  const _results = [];
  const iter = ch[Symbol.asyncIterator]();

  const first = await iter.next();
  assert.deepStrictEqual(first, { value: 1, done: false });

  const second = await iter.next();
  assert.deepStrictEqual(second, { value: "done", done: true });
});
