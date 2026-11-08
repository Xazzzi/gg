import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { inspect } from "node:util";
import {
  applyOps,
  CHAN,
  changes,
  type Op,
  select,
  watch,
} from "../src/index.ts";

const open = { autoStart: true, autoClose: false, nonYielding: true } as const;
const done = { done: true, value: undefined };
const started = async <T>(state: T) => (await setImmediate(), state);
const pending = (promise: Promise<unknown>) => /pending/.test(inspect(promise));
// Resolves whether the value that put hands over gets collected.
const collected = async (put: (value: object) => unknown) => {
  const registry = new FinalizationRegistry<() => void>(done => done());
  let done = false;
  (() => {
    const value = {};
    registry.register(value, () => (done = true));
    put(value);
  })();
  for (let i = 0; i < 20 && !done; i++) {
    await setImmediate();
    globalThis.gc?.();
  }
  return done;
};

test("SE-150 changes checks slice keys synchronously", async () => {
  const o = select({ a: 1 }, open),
    a = select([1], open),
    changes_ = changes as (state: unknown, keys?: unknown) => any;
  for (const bad of [1, "a", null, { length: 1 }])
    assert.throws(() => changes_(o, bad), {
      name: "TypeError",
      message: "changes keys must be an array",
    });
  for (const bad of [true, null, undefined, {}, 1n])
    assert.throws(() => changes_(o, [bad]), {
      name: "TypeError",
      message: "An object slice takes property keys",
    });
  for (const bad of [-1, 1.5, "0", Number.NaN, Infinity, 1n])
    assert.throws(() => changes_(a, [0, bad]), {
      name: "TypeError",
      message: "An array slice takes indexes",
    });
  assert.deepEqual(changes_(o, ["a", Symbol.for("b"), 1]).outputs, {});
  assert.deepEqual(changes_(a, []).outputs, []);
  assert.deepEqual(changes_(o, undefined).outputs, {});
});

test("SE-150 SE-152 outputs hold the selected slots, once each, in slot order", async () => {
  const b = Symbol.for("b");
  const o = await started(select({ a: 1, [b]: 2, 3: 3, c: 4 }, open)),
    a = await started(select(["a", "b", "c", "d"], open));
  const picked = changes(o, ["c", b, 3, "a", "z" as "a", "c"]).outputs;
  assert.deepEqual(Reflect.ownKeys(picked), ["3", "a", "c", b]);
  assert.deepEqual(picked, { a: 1, [b]: 2, 3: 3, c: 4 });
  assert.deepEqual(changes(a, [3, 1, 9, 3]).outputs, ["b", "d"]);
  const outputs = changes(a, [0]).outputs;
  a[0] = "x";
  assert.deepEqual(outputs, ["a"]);
  const v = await started(select([Promise.resolve(1)], open));
  assert.equal(changes(v, [0]).outputs[0]?.status, "fulfilled");
});

test("SE-151 SE-153 an object slice reads the set and delete operations of its keys, unchanged", async () => {
  const reports: Op[][] = [];
  const s = await started(
    select({ a: 1, b: 2 } as Record<string, number>, {
      ...open,
      onChanges: ops => void reports.push(ops),
    }),
  );
  const r = changes(s, ["a"]);
  const next = r.next();
  s.b = 3;
  await setImmediate();
  assert.ok(pending(next));
  s.a = 4;
  delete s.a;
  s.b = 5;
  s.a = 6;
  const { value = [] } = await next;
  const [report = []] = reports.slice(-1);
  assert.deepEqual(value, [report[0], report[1], report[3]]);
  assert.equal(value[0], report[0]);
  assert.deepEqual(applyOps({ ...r.outputs }, value), { a: 6 });
});

test("SE-152 before start, a slice has empty outputs, and the object description sets its keys", async () => {
  const s = select({ a: 1, b: 2 }, { autoClose: false, nonYielding: true });
  const r = changes(s, ["b"]);
  assert.deepEqual(r.outputs, {});
  void s[CHAN][Symbol.asyncIterator]().next();
  assert.deepEqual((await r.next()).value, [
    { op: "set", key: "b", value: 2, prev: undefined },
  ]);
});

test("SE-154 an array set becomes a set at the index of outputs", async () => {
  const s = await started(select(["a", "b", "c"], open));
  const r = changes(s, [0, 2]);
  s[1] = "x";
  s[2] = "y";
  s[0] = "z";
  assert.deepEqual((await r.next()).value, [
    { op: "set", key: 1, value: "y", prev: "c" },
    { op: "set", key: 0, value: "z", prev: "a" },
  ]);
});

test("SE-154 a splice moves the selected slots, and its removal becomes a splice of outputs", async () => {
  const s = await started(select(["a", "b", "c", "d", "e"], open));
  const r = changes(s, [1, 3, 4]);
  const next = r.next();
  s.unshift("u", "v");
  s.splice(3, 0, "w");
  s.push("p");
  await setImmediate();
  assert.ok(pending(next));
  assert.deepEqual([...s], ["u", "v", "a", "w", "b", "c", "d", "e", "p"]);
  s[4] = "B";
  s.splice(3, 4, "q");
  s[4] = "E";
  assert.deepEqual((await next).value, [
    { op: "set", key: 0, value: "B", prev: "b" },
    { op: "splice", start: 0, removed: ["B", "d"], added: [] },
    { op: "set", key: 0, value: "E", prev: "e" },
  ]);
});

test("SE-154 a move becomes a move of outputs, only if the selected order changes", async () => {
  const s = await started(select([3, 1, 2, 0], open));
  const r = changes(s, [1, 2]);
  const next = r.next();
  s.sort();
  await setImmediate();
  assert.ok(pending(next));
  assert.deepEqual([...s], [0, 1, 2, 3]);
  s.reverse();
  s[2] = 4;
  const { value = [] } = await next;
  assert.deepEqual(value, [
    { op: "move", order: [1, 0] },
    { op: "set", key: 1, value: 4, prev: 1 },
  ]);
  assert.deepEqual(applyOps([...r.outputs], value), [2, 4]);
});

test("SE-144 SE-151 a replay of the slice reads onto outputs equals the selected outputs", async () => {
  const s = await started(select(["a", "b", "c", "d"], open));
  const r = changes(s, [1, 2]),
    mirror = [...r.outputs];
  s.reverse();
  s.splice(0, 1, "x", "y");
  s[3] = "C";
  s.sort();
  applyOps(mirror, (await r.next()).value ?? []);
  assert.deepEqual([...s], ["C", "a", "c", "x", "y"]);
  assert.deepEqual(mirror, ["C", "c"]);
});

test("SE-155 a slice made before start names the slots at start, and describes them", async () => {
  const s = select(["a", "b", "c"], { autoClose: false, nonYielding: true });
  const r = changes(s, [1, 3, 5]);
  assert.deepEqual(r.outputs, []);
  s.unshift("z");
  s[1] = "A";
  void s[CHAN][Symbol.asyncIterator]().next();
  assert.deepEqual((await r.next()).value, [
    { op: "splice", start: 0, removed: [], added: ["A", "c"] },
  ]);
  s[0] = "y";
  s[3] = "C";
  assert.deepEqual((await r.next()).value, [
    { op: "set", key: 1, value: "C", prev: "c" },
  ]);
});

test("SE-156 a slice made before start finishes at start when it names no slot", async () => {
  for (const [shape, keys] of [
    [[], [0]],
    [["a"], [1]],
  ] as const) {
    const s = select([...shape], { autoClose: false, nonYielding: true });
    const r = changes(s, [...keys]);
    const next = r.next();
    await setImmediate();
    assert.ok(pending(next));
    void s[CHAN][Symbol.asyncIterator]().next();
    assert.deepEqual(await next, done);
  }
});

test("SE-156 an array slice finishes after it reads the removal of its last slot", async () => {
  const s = await started(select(["a", "b", "c"], open));
  assert.deepEqual(await changes(s, [3]).next(), done);
  assert.deepEqual(await changes(s, []).next(), done);
  const r = changes(s, [0, 2]);
  s.pop();
  s.shift();
  await setImmediate();
  s.push("d");
  assert.deepEqual((await r.next()).value, [
    { op: "splice", start: 1, removed: ["c"], added: [] },
    { op: "splice", start: 0, removed: ["a"], added: [] },
  ]);
  assert.deepEqual(await r.next(), done);
  const o = await started(select({ a: 1 } as Record<string, number>, open));
  const k = changes(o, ["a"]);
  delete o.a;
  await setImmediate();
  o.a = 2;
  await setImmediate();
  assert.equal((await k.next()).value?.length, 2);
});

test("SE-157 a slice takes each operation once, while a lagging reader keeps the log", async () => {
  const s = await started(select(["a", "b"], open));
  changes(s); // Never reads, so the log keeps all operations
  const r = changes(s, [0]);
  s[0] = "c";
  await setImmediate();
  s[0] = "d";
  await setImmediate();
  assert.deepEqual((await r.next()).value, [
    { op: "set", key: 0, value: "c", prev: "a" },
    { op: "set", key: 0, value: "d", prev: "c" },
  ]);
});

test("SE-157 a slice keeps no operation of the log, and only its own operations", async () => {
  const s = await started(
    select({ a: 0, b: 0 } as Record<string, unknown>, open),
  );
  changes(s, ["a"]);
  assert.ok(await collected(value => ((s.b = value), (s.b = 0))));
  assert.ok(!(await collected(value => ((s.a = value), (s.a = 0)))));
  const a = await started(select([0, 0] as unknown[], open));
  changes(a, [0]);
  assert.ok(await collected(value => ((a[1] = value), (a[1] = 0))));
});

test("SE-151 SE-14A a slice reads its operations after close, then finishes, or rejects after a failure", async () => {
  const s = await started(select(["a", "b"], open));
  const r = changes(s, [1]);
  s[1] = "c";
  await setImmediate();
  s[CHAN].close();
  assert.deepEqual((await r.next()).value, [
    { op: "set", key: 0, value: "c", prev: "b" },
  ]);
  assert.deepEqual(await r.next(), done);
  const t = await started(select(["a", "b"], open));
  const q = changes(t, [1]),
    error = new Error("boom");
  t[1] = "c";
  await setImmediate();
  t[CHAN].throw(error);
  assert.equal((await q.next()).value?.length, 1);
  await assert.rejects(q.next(), error);
  assert.deepEqual(await q.next(), done);
  await assert.rejects(changes(t, [0]).next(), error);
});

test("SE-151 SE-148 return() and dispose finish a slice, settle its reads, and drop its operations", async () => {
  const s = await started(select(["a", "b"] as unknown[], open));
  const r = changes(s, [0]),
    q = changes(s, [0]),
    p = changes(s, [1]);
  const dropped = collected(value => ((s[0] = value), (s[0] = "c")));
  await setImmediate();
  const next = p.next();
  assert.deepEqual(await r.return(), done);
  q[Symbol.dispose]();
  p[Symbol.dispose]();
  assert.ok(await dropped);
  assert.deepEqual(await next, done);
  assert.deepEqual(await r.next(), done);
  assert.deepEqual(await q.next(), done);
});

test("SE-160 watch checks its arguments synchronously", () => {
  const watch_ = watch as (state: unknown, key: unknown) => unknown;
  for (const bad of [{}, null, []])
    assert.throws(() => watch_(bad, "a"), {
      name: "TypeError",
      message: "watch needs a select proxy",
    });
  assert.throws(() => watch_(select([1]), -1), {
    name: "TypeError",
    message: "An array slice takes indexes",
  });
  assert.throws(() => watch_(select({}), null), {
    name: "TypeError",
    message: "An object slice takes property keys",
  });
});

test("SE-161 SE-162 watch opens at the first next(), and gives the output there", async () => {
  const s = await started(select(["a", "b"], open));
  const w = watch(s, 0);
  assert.equal(w[Symbol.asyncIterator](), w);
  s.unshift("z");
  assert.deepEqual(await w.next(), { done: false, value: "z" });
  s[1] = "A";
  s[0] = "Z";
  assert.deepEqual(await w.next(), { done: false, value: "Z" });
  const o = await started(select({ a: 1 } as Record<string, number>, open));
  const k = watch(o, "b"),
    next = k.next();
  await setImmediate();
  assert.ok(pending(next));
  o.b = 2;
  assert.deepEqual(await next, { done: false, value: 2 });
});

test("SE-161 the first next() of watch names the slot at that call", async () => {
  const s = await started(select(["a", "b"], open));
  const w = watch(s, 0),
    first = w.next();
  s.unshift("z");
  s[1] = "A";
  assert.deepEqual(await first, { done: false, value: "a" });
  assert.deepEqual(await w.next(), { done: false, value: "A" });
});

test("SE-162 SE-163 watch gives a first output of undefined, then skips an equal one", async () => {
  const s = await started(select([undefined, 1] as unknown[], open));
  const w = watch(s, 0);
  assert.deepEqual(await w.next(), { done: false, value: undefined });
  const next = w.next();
  s[0] = null;
  assert.deepEqual(await next, { done: false, value: null });
});

test("SE-162 SE-155 a watch before start gives the output that start describes", async () => {
  const s = select(["a", "b"], { autoClose: false, nonYielding: true }),
    o = select({ k: 1 }, { autoClose: false, nonYielding: true });
  const w = watch(s, 1).next(),
    k = watch(o, "k").next();
  void s[CHAN][Symbol.asyncIterator]().next();
  void o[CHAN][Symbol.asyncIterator]().next();
  assert.deepEqual(await w, { done: false, value: "b" });
  assert.deepEqual(await k, { done: false, value: 1 });
});

test("SE-163 watch gives the last output of each read, and skips an equal one", async () => {
  const s = await started(
    select({ a: 1, b: 0 } as Record<string, number>, open),
  );
  const w = watch(s, "a");
  assert.deepEqual(await w.next(), { done: false, value: 1 });
  s.a = 2;
  s.a = 3;
  await setImmediate();
  s.a = 4;
  assert.deepEqual(await w.next(), { done: false, value: 4 });
  const next = w.next();
  s.a = 5;
  s.a = 4;
  await setImmediate();
  assert.ok(pending(next));
  s.a = Number.NaN;
  assert.deepEqual(await next, { done: false, value: Number.NaN });
  const z = await started(select([0], open));
  const v = watch(z, 0);
  await v.next();
  z[0] = -0;
  assert.ok(Object.is((await v.next()).value, -0));
});

test("SE-164 watch finishes when its slot goes, and with its reader", async () => {
  const s = await started(select({ a: 1 } as Record<string, unknown>, open));
  const w = watch(s, "a");
  await w.next();
  delete s.a;
  s.a = 2;
  assert.deepEqual(await w.next(), { done: false, value: 2 });
  delete s.a;
  assert.deepEqual(await w.next(), done);
  assert.ok(await collected(value => ((s.a = value), (s.a = 3))));
  assert.deepEqual(await w.next(), done);
  const a = await started(select(["a", "b"], open));
  const v = watch(a, 1);
  await v.next();
  a.pop();
  assert.deepEqual(await v.next(), done);
  const c = await started(select(["a"], open));
  const x = watch(c, 0);
  await x.next();
  c[CHAN].close();
  assert.deepEqual(await x.next(), done);
  const t = await started(select(["a"], open)),
    error = new Error("boom");
  const y = watch(t, 0);
  await y.next();
  const failing = y.next();
  t[CHAN].throw(error);
  await assert.rejects(failing, error);
  assert.deepEqual(await y.next(), done);
});

test("SE-165 return() and dispose finish watch, and settle pending calls", async () => {
  const s = await started(select(["a"], open));
  const w = watch(s, 0);
  assert.deepEqual(await w.return(), done);
  assert.deepEqual(await w.next(), done);
  const v = watch(s, 0);
  await v.next();
  const next = v.next();
  v[Symbol.dispose]();
  assert.deepEqual(await next, done);
  s[0] = "b";
  assert.deepEqual(await v.next(), done);
});

test("SE-165 return() during a report settles the pending call that the report woke", async () => {
  let w: ReturnType<typeof watch<string[], number>> | undefined;
  const s = await started(
    select(["a"], { ...open, onChanges: () => void w?.return() }),
  );
  w = watch(s, 0);
  await w.next();
  const next = w.next();
  s[0] = "b";
  assert.deepEqual(await next, done);
});

test("SE-166 the calls of watch settle in call order", async () => {
  const s = await started(select(["a"], open));
  const w = watch(s, 0);
  const first = w.next(),
    second = w.next();
  await setImmediate();
  assert.ok(pending(second));
  s[0] = "b";
  assert.deepEqual(await Promise.all([first, second]), [
    { done: false, value: "a" },
    { done: false, value: "b" },
  ]);
});
