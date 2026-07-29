import * as assert from "node:assert";
import { test } from "node:test";
import { select } from "../../src/select.ts";

test("select handles bad custom mappers returning null with spread: true gracefully", () => {
  const badMapper = Object.assign((_key: any, _state: any) => null, {
    spread: true,
    _T: null as any,
    type: null as any,
  });

  const stream = select(
    { p1: Promise.resolve(1) },
    { mapFields: badMapper as any },
  );
  const it = stream[Symbol.asyncIterator]();

  // No assertions needed other than it doesn't crash during construction and setup
  assert.ok(it);
});

test("select handles bad custom mappers returning string with spread: true gracefully", async () => {
  const badMapper = Object.assign((_key: any, _state: any) => "hello", {
    spread: true,
    _T: null as any,
    type: null as any,
  });

  const stream = select(
    { p1: Promise.resolve(1) },
    { mapFields: badMapper as any },
  );
  const it = stream[Symbol.asyncIterator]();

  const next = await it.next();
  assert.strictEqual(next.value.p1, "hello");
});
