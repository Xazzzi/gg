// biome-ignore-all lint/correctness/useYield: tests
import * as assert from "node:assert";
import { test } from "node:test";
import { select } from "../../src/select.ts";

test("select proxy array mutators shift indices correctly", async () => {
  const p1 = Promise.withResolvers<number>();
  const p2 = Promise.withResolvers<number>();
  const p3 = Promise.withResolvers<number>();
  const p4 = Promise.withResolvers<number>();

  const s = select([p1.promise, p2.promise]);
  const it = s[Symbol.asyncIterator]();

  let v = await it.next();
  assert.deepStrictEqual(v.value, [
    { status: "pending" },
    { status: "pending" },
  ]);

  // Push
  s.push(p3.promise);
  v = await it.next();
  assert.deepStrictEqual(v.value, [
    { status: "pending" },
    { status: "pending" },
    { status: "pending" },
  ]);

  // Pop
  s.pop();
  v = await it.next();
  assert.deepStrictEqual(v.value, [
    { status: "pending" },
    { status: "pending" },
  ]);

  // Unshift
  s.unshift(p4.promise);
  v = await it.next();
  assert.deepStrictEqual(v.value, [
    { status: "pending" },
    { status: "pending" },
    { status: "pending" },
  ]);

  // Resolve what was originally p1 (now at index 1)
  p1.resolve(100);
  v = await it.next();
  assert.deepStrictEqual(v.value, [
    { status: "pending" },
    { status: "fulfilled", value: 100 },
    { status: "pending" },
  ]);

  // Shift
  s.shift();
  v = await it.next();
  assert.deepStrictEqual(v.value, [
    { status: "fulfilled", value: 100 },
    { status: "pending" },
  ]);

  // Splice
  const p5 = Promise.withResolvers<number>();
  s.splice(1, 0, p5.promise);
  v = await it.next();
  assert.deepStrictEqual(v.value, [
    { status: "fulfilled", value: 100 },
    { status: "pending" },
    { status: "pending" },
  ]);
});
