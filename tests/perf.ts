// Timing checks run apart from the suite, because a microtask loop starves test timeouts.
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { Channel, each, jsx, mount, select, watch } from "../src/index.ts";
import { fakeDocument } from "./dom.ts";

setFlagsFromString("--expose-gc");
const collect: () => void = runInNewContext("gc");

/** Checks that the heap grows by under budget bytes for each round of run, after a warm up. */
const flat = async (name: string, budget: number, run: () => unknown) => {
  const rounds = 10_000;
  for (let i = 0; i < 100; i++) await run();
  collect();
  const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < rounds; i++) await run();
  collect();
  const grown = (process.memoryUsage().heapUsed - before) / rounds;
  console.log(`${name}: ${grown.toFixed(0)} bytes per round`);
  assert.ok(grown < budget, `${name} grew over ${budget} bytes per round`);
};

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

await within("SE-048 single writes in a large array", 1000, async () => {
  const s = select(new Array(size).fill(0), {
    autoStart: true,
    autoClose: false,
    nonYielding: true,
    onChanges: () => {},
  });
  await new Promise(resolve => setTimeout(resolve));
  for (let i = 1; i <= 1000; i++) {
    s[0] = i;
    await new Promise<void>(resolve => queueMicrotask(resolve));
  }
  s[Symbol.dispose]();
});

await within("SE-048 settles in a large array", 1000, async () => {
  const gates = Array.from({ length: size / 4 }, () =>
    Promise.withResolvers<number>(),
  );
  const { promise, resolve } = Promise.withResolvers<void>();
  const s = select(
    gates.map(gate => gate.promise),
    {
      autoStart: true,
      nonYielding: true,
      onChanges: ops => {
        if (ops.length === gates.length) resolve();
      },
    },
  );
  await new Promise(done => setTimeout(done));
  for (const [i, gate] of gates.entries()) gate.resolve(i);
  await promise;
  s[Symbol.dispose]();
});

await within(
  "SE-158 single key writes with many key watchers",
  400,
  async () => {
    const keys = Array.from({ length: 4000 }, (_, i) => `k${i}`);
    const s = select(Object.fromEntries(keys.map(key => [key, 0])), {
      autoStart: true,
      nonYielding: true,
    });
    for (const key of keys)
      (async () => {
        for await (const _ of watch(s, key));
      })();
    await setImmediate();
    for (let i = 1; i <= 2000; i++) {
      s.k0 = i;
      await new Promise<void>(resolve => queueMicrotask(resolve));
    }
    s[Symbol.dispose]();
  },
);

{
  const s = select({ n: 0 }, { unwrap: true });
  (async () => {
    for await (const _ of s);
  })();
  await flat("SE-04B flushes that only a consumer reads", 100, () => {
    s.n++;
    return setImmediate();
  });
  s[Symbol.dispose]();
}

{
  (globalThis as any).document = fakeDocument;
  const list = select([] as number[], { nonYielding: true });
  const stop = mount(
    fakeDocument.createElement("ul") as any,
    each(list, item => jsx("li", { children: `${item.value}` })),
  );
  await flat("JX-070 reads of each with static rows", 100, () => {
    list.push(1);
    list.shift();
    return setImmediate();
  });
  stop();
  list[Symbol.dispose]();
}
