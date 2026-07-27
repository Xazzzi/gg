import * as assert from "node:assert";
import { test } from "node:test";
import { pipe } from "../../src/pipe.ts";

test("pipe correctly consumes a Promise", async () => {
  const p = Promise.resolve(42);
  const ch = pipe(p, { autoStart: true });
  const it = ch[Symbol.asyncIterator]();
  const v = await it.next();
  assert.strictEqual(v.value, 42);
  const end = await it.next();
  assert.strictEqual(end.done, true);
});
