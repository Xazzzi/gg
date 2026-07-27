import * as assert from "node:assert";
import { test } from "node:test";
import { pipe } from "../../src/pipe.ts";

test("pipe correctly consumes a standard Array (Iterable, not Iterator)", async () => {
  const arr = [1, 2, 3];

  const ch = pipe(arr, { autoStart: true });
  const it = ch[Symbol.asyncIterator]();

  assert.strictEqual((await it.next()).value, 1);
  assert.strictEqual((await it.next()).value, 2);
  assert.strictEqual((await it.next()).value, 3);
  assert.strictEqual((await it.next()).done, true);
});
