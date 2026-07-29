import * as assert from "node:assert";
import { test } from "node:test";
import { select, spread } from "../../src/select.ts";

test("select holdDone with mapField on sync iterators", async () => {
  function* syncGen() {
    yield 200;
  }
  const p = Promise.withResolvers<void>();
  const stream = select(
    { g: syncGen(), p: p.promise },
    { mapFields: spread, holdDone: true },
  );

  const it = stream[Symbol.asyncIterator]();
  let next = await it.next();

  assert.equal(next.value.g, 200);
  assert.equal(next.value.gDone, false);

  p.resolve();
  next = await it.next();

  assert.equal(next.value.g, 200);
  assert.equal(next.value.gDone, true);
});
