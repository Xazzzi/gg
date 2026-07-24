import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { select } from "../../src/select.ts";

test("dropped raw promise gracefully ignores background settlements", async () => {
  const p1 = Promise.withResolvers<number>();
  const p2 = Promise.withResolvers<number>();
  const s: any = select(
    { p1: p1.promise, p2: p2.promise },
    { autoClose: false },
  );
  await s[Symbol.asyncIterator]().next();

  // Drop both promises from the shape
  delete s.p1;
  delete s.p2;

  // Settle them in the background. Because they are raw promises (no iterator),
  // handleAsyncNext should safely return without trying to unsend anything.
  p1.resolve(1);
  p2.reject(new Error("ignored background reject"));
  await setImmediate();
  // No assertions needed; we just want to ensure it doesn't crash.
});
