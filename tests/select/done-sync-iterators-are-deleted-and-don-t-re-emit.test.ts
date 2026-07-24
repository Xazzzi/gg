// biome-ignore-all lint/correctness/useYield: tests
import * as assert from "node:assert";
import { test } from "node:test";
import { select } from "../../src/select.ts";

test("done sync iterators are deleted and don't re-emit", async () => {
  function* gen() {
    yield 42;
  }
  let changes: any;
  const p1 = Promise.withResolvers<number>();
  const p2 = Promise.withResolvers<number>();
  const s = select(
    { g: gen(), p1: p1.promise, p2: p2.promise },
    { onChanges: c => (changes = c) },
  );
  const it = s[Symbol.asyncIterator]();

  await it.next();
  p1.resolve(1);
  await it.next(); // g completes here

  p2.resolve(2);
  await it.next(); // g should not be in changes!
  assert.ok(!("g" in changes));
});
