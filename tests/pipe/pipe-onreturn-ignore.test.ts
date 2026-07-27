import * as assert from "node:assert";
import { test } from "node:test";
import { pipe } from "../../src/pipe.ts";

test("pipe onReturn: 'ignore' does not trigger autoClose", async () => {
  const p = Promise.resolve(1);
  const ch = pipe(p, {
    autoStart: true,
    autoClose: true,
    onReturn: "ignore",
  });

  const it = ch[Symbol.asyncIterator]();
  assert.strictEqual((await it.next()).value, 1);

  // It shouldn't be closed!
  const p2 = it.next();
  ch.send(2);
  assert.strictEqual((await p2).value, 2);
});
