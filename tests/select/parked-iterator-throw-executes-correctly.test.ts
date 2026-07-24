// biome-ignore-all lint/correctness/useYield: tests

import * as assert from "node:assert";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { select } from "../../src/select.ts";

test("parked iterator throw() executes correctly", async () => {
  const p = Promise.withResolvers<void>();
  async function* gen() {
    await p.promise;
    throw new Error("background boom");
  }
  const iter = gen();
  const s: any = select({ g: iter });
  await s[Symbol.asyncIterator]().next();
  delete s.g;

  // Background promise rejects, unsend patches iterator with isError = true
  p.reject(new Error("background boom"));
  await setImmediate();

  // Manually call throw on the patched iterator!
  // It should yield the parked rejection ("background boom") instead of what we throw in.
  await assert.rejects(
    iter.throw(new Error("manual throw")),
    /background boom/,
  );
});

test("parked iterator throw() executes correctly when parked with normal value", async () => {
  const p = Promise.withResolvers<void>();
  async function* gen() {
    await p.promise;
    yield 42;
    await p.promise;
  }
  const iter = gen();
  const s: any = select({ g: iter });
  await s[Symbol.asyncIterator]().next();
  delete s.g;

  // Background promise resolves, yielding 42. Generator is parked with normal value.
  p.resolve();
  await setImmediate();

  // Manually call throw on the patched iterator!
  // It should forward the manual throw to the generator instead of returning the parked value.
  await assert.rejects(iter.throw(new Error("manual throw")), /manual throw/);
});
