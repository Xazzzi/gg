// Timing checks run apart from the suite, because a microtask loop starves test timeouts.
import assert from "node:assert/strict";
import { Channel, select } from "../src/index.ts";

const within = async (name: string, budget: number, run: () => unknown) => {
  const start = performance.now();
  await run();
  const elapsed = performance.now() - start;
  console.log(`${name}: ${elapsed.toFixed(0)}ms`);
  assert.ok(elapsed < budget, `${name} took over ${budget}ms`);
};

const size = 200_000;

await within("asend backlog drain", 3000, async () => {
  const ch = new Channel<number>({ thenReceive: "every" });
  for (let i = 0; i < size; i++) ch.asend(i);
  const it = ch[Symbol.asyncIterator]();
  for (let i = 0; i < size; i++) await it.next();
});

await within("select large array", 3000, () => {
  const s = select(new Array(size).fill(0), { nonYielding: true });
  s.length = size * 2;
  s.shift();
  s[Symbol.dispose]();
});
