import * as assert from "node:assert";
import { test } from "node:test";
import { pipe } from "../../src/pipe.ts";

test("pipe onThrow: 'throw' throws error into channel", async () => {
  const p = Promise.reject(new Error("err"));
  p.catch(() => {});
  const ch = pipe(p, { autoStart: true, onThrow: "throw" });

  const it = ch[Symbol.asyncIterator]();
  await assert.rejects(it.next(), /err/);
});
