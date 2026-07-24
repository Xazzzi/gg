// biome-ignore-all lint/correctness/useYield: tests
import * as assert from "node:assert";
import { test } from "node:test";
import { select } from "../../src/select.ts";

test("select without holdDone does not retain last value for sync iterators", async () => {
  function* gen() {
    yield 42;
    return undefined;
  }
  const other = Promise.withResolvers<number>();
  const s = select(
    { g: gen(), o: other.promise },
    { autoClose: false, holdDone: false },
  );
  const it = s[Symbol.asyncIterator]();

  await it.next();
  other.resolve(1);
  const v2 = await it.next();

  assert.deepStrictEqual((v2.value as any).g, {
    status: "fulfilled",
    value: undefined,
    done: true,
  });
});
