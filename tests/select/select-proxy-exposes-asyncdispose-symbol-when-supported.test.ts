// biome-ignore-all lint/correctness/useYield: tests
import * as assert from "node:assert";
import { test } from "node:test";
import { Channel } from "../../src/channel.ts";
import { select } from "../../src/select.ts";

test("select proxy exposes asyncDispose symbol when supported", async () => {
  const originalAsyncDispose = (Channel.prototype as any)[Symbol.asyncDispose];
  try {
    let called = false;
    (Channel.prototype as any)[Symbol.asyncDispose] = () => {
      called = true;
    };
    const s = select({ a: 1 }) as any;
    assert.ok(s[Symbol.asyncDispose]);
    s[Symbol.asyncDispose]();
    assert.strictEqual(called, true);
  } finally {
    (Channel.prototype as any)[Symbol.asyncDispose] = originalAsyncDispose;
  }
});
