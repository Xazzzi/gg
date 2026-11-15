import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { inspect } from "node:util";
import { applyOps, CHAN, changes, type Op, select } from "../src/index.ts";
import { REPORT } from "../src/select.ts";

const open = { autoStart: true, autoClose: false, nonYielding: true } as const;
const done = { done: true, value: undefined };
const started = async <T>(state: T) => (await setImmediate(), state);
const pending = (promise: Promise<unknown>) => /pending/.test(inspect(promise));
const set = (value: number, prev: unknown) => ({
  done: false,
  value: [{ op: "set", key: "a", value, prev }],
});
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

test("SE-140 changes needs a select proxy", () => {
  for (const bad of [{}, null, 1, [], new Proxy({}, {})])
    assert.throws(() => changes(bad as any), {
      name: "TypeError",
      message: "changes needs a select proxy",
    });
});

test("SE-141 changes returns a new reader, which is its own iterator", async () => {
  const s = await started(select(["a"], open));
  const a = changes(s),
    b = changes(s);
  assert.notEqual(a, b);
  assert.equal(a[Symbol.asyncIterator](), a);
});

test("SE-142 outputs is a copy of the outputs at the call, without mapSnapshot", async () => {
  const s = await started(
    select(
      { p: Promise.resolve(1), n: 2 },
      { ...open, nonYielding: false, unwrap: true, mapSnapshot: () => 0 },
    ),
  );
  const a = changes(s);
  assert.deepEqual(a.outputs, { p: 1, n: 2 });
  s.n = 3;
  assert.deepEqual(a.outputs, { p: 1, n: 2 });
  assert.notEqual(changes(s).outputs, a.outputs);
  const v = await started(select([Promise.resolve(1)], open));
  assert.equal(changes(v).outputs[0].status, "fulfilled");
});

test("SE-142 SE-107 before start, outputs is empty and the first read describes the shape", async () => {
  const a = select(["a", "b"], { autoClose: false, nonYielding: true }),
    o = select({ k: 1 }, { autoClose: false, nonYielding: true });
  const ra = changes(a),
    ro = changes(o);
  assert.deepEqual(ra.outputs, []);
  assert.deepEqual(ro.outputs, {});
  void a[CHAN][Symbol.asyncIterator]().next();
  void o[CHAN][Symbol.asyncIterator]().next();
  assert.deepEqual((await ra.next()).value, [
    { op: "splice", start: 0, removed: [], added: ["a", "b"] },
  ]);
  assert.deepEqual((await ro.next()).value, [
    { op: "set", key: "k", value: 1, prev: undefined },
  ]);
});

test("SE-143 a reader skips the operations that the log holds at the call", async () => {
  const reports: Op[][] = [];
  const s = await started(
    select(["a"], { ...open, [REPORT]: ops => void reports.push(ops) }),
  );
  s.push("b");
  const a = changes(s);
  assert.deepEqual(a.outputs, ["a", "b"]);
  await setImmediate();
  assert.deepEqual(reports.at(-1), [
    { op: "splice", start: 1, removed: [], added: ["b"] },
  ]);
  const next = a.next();
  await setImmediate();
  assert.match(inspect(next), /pending/);
  s.push("c");
  assert.deepEqual((await next).value, [
    { op: "splice", start: 2, removed: [], added: ["c"] },
  ]);
});

test("SE-143 SE-14B a reader starts after the log, which keeps what a lagging reader did not read", async () => {
  const s = await started(select([] as string[], open));
  const a = changes(s),
    b = changes(s);
  const added = async (reader: typeof a) =>
    (await reader.next()).value?.map(op => (op as { added: string[] }).added);
  s.push("a");
  await setImmediate();
  await a.next();
  await b.next();
  s.push("b");
  await setImmediate();
  s.push("c");
  await setImmediate();
  assert.deepEqual(await added(a), [["b"], ["c"]]);
  const c = changes(s);
  s.push("d");
  await setImmediate();
  assert.deepEqual(await added(c), [["d"]]);
  assert.deepEqual(await added(b), [["b"], ["c"], ["d"]]);
});

test("SE-144 SE-145 a replay of the reads onto outputs equals the outputs", async () => {
  const s = await started(select(["a", "b", "c"], open)),
    o = await started(select({ x: 1, y: 2 } as Record<string, number>, open));
  const a = changes(s),
    b = changes(o);
  const mirror = [...a.outputs],
    keys = { ...b.outputs };
  s.push("d");
  s.reverse();
  await setImmediate();
  s[0] = "e";
  s.splice(1, 2);
  await setImmediate();
  o.z = 3;
  delete o.x;
  await setImmediate();
  o.y = 4;
  await setImmediate();
  const { value: ops = [] } = await a.next();
  assert.equal(ops.length, 4);
  assert.deepEqual(applyOps(mirror, ops), [...s]);
  assert.deepEqual(applyOps(keys, (await b.next()).value as Op[]), {
    y: 4,
    z: 3,
  });
});

test("SE-145 a read excludes operations that no report contains, and gives a new array", async () => {
  const s = await started(select(["a"], open));
  const a = changes(s),
    b = changes(s);
  s.push("b");
  await setImmediate();
  s.push("c");
  const [x, y] = await Promise.all([a.next(), b.next()]);
  assert.deepEqual(x.value, [
    { op: "splice", start: 1, removed: [], added: ["b"] },
  ]);
  assert.notEqual(x.value, y.value);
  assert.deepEqual(x.value, y.value);
  assert.equal((await a.next()).value?.[0].op, "splice");
});

test("SE-146 SE-147 next() blocks until a report, and reads settle in call order", async () => {
  const s = await started(select([] as string[], open));
  const a = changes(s);
  const first = a.next(),
    second = a.next();
  await setImmediate();
  assert.match(inspect(first), /pending/);
  s.push("a");
  await setImmediate();
  assert.match(inspect(second), /pending/);
  s.push("b");
  assert.deepEqual((await first).value?.[0], {
    op: "splice",
    start: 0,
    removed: [],
    added: ["a"],
  });
  assert.deepEqual((await second).value?.[0], {
    op: "splice",
    start: 1,
    removed: [],
    added: ["b"],
  });
});

test("SE-148 SE-149 return() and dispose finish a reader, and settle pending reads", async () => {
  const s = await started(select(["a"], open));
  const a = changes(s),
    b = changes(s);
  const pending = a.next();
  assert.deepEqual(await a.return(), done);
  assert.deepEqual(await pending, done);
  s.push("b");
  await setImmediate();
  assert.deepEqual(await a.next(), done);
  b[Symbol.dispose]();
  assert.deepEqual(await b.next(), done);
  assert.deepEqual(await b.return(), done);
});

test("SE-040 report makes operations readable before it calls the report hook", async () => {
  let read: Promise<IteratorResult<Op[]>> | undefined,
    a: ReturnType<typeof changes> | undefined;
  const s = await started(
    select(["a"], { ...open, [REPORT]: () => void (read ??= a?.next()) }),
  );
  a = changes(s);
  s.push("b");
  await setImmediate();
  assert.equal((await read)?.value?.length, 1);
  a.return();
  s.push("c");
  await setImmediate();
});

test("SE-14A a reader reads all reports after close, then finishes", async () => {
  const s = await started(select(["a"], open));
  const a = changes(s),
    b = changes(s);
  const pending = b.next();
  s.push("b");
  await setImmediate();
  s[CHAN].close();
  assert.equal((await a.next()).value?.length, 1);
  assert.deepEqual(await a.next(), done);
  assert.equal((await pending).value?.length, 1);
  assert.deepEqual(await b.next(), done);
  assert.deepEqual(changes(s).outputs, ["a", "b"]);
  assert.deepEqual(await changes(s).next(), done);
});

test("SE-14A after a failure, one read rejects with the error after all reports", async () => {
  const failure = new Error("x"),
    s = await started(select(["a"], open));
  const a = changes(s),
    b = changes(s),
    c = changes(s);
  const pending = b.next();
  s.push("b");
  await setImmediate();
  c.return();
  s[CHAN].throw(failure);
  assert.equal((await a.next()).value?.length, 1);
  await assert.rejects(a.next(), failure);
  assert.deepEqual(await a.next(), done);
  assert.equal((await pending).value?.length, 1);
  await assert.rejects(b.next(), failure);
  assert.deepEqual(await c.next(), done);
  await assert.rejects(changes(s).next(), failure);
  const waiting = select([], open);
  await setImmediate();
  const d = changes(waiting).next();
  waiting[CHAN].throw(failure);
  await assert.rejects(d, failure);
});

test("SE-14B the log drops operations that each attached reader read", async () => {
  const s = await started(select([] as object[], open));
  const a = changes(s),
    b = changes(s);
  let ref!: WeakRef<object>;
  (() => {
    const value = {};
    ref = new WeakRef(value);
    s.push(value);
  })();
  await setImmediate();
  s.pop();
  await setImmediate();
  await a.next();
  globalThis.gc?.();
  await setImmediate();
  assert.ok(ref.deref());
  await b.next();
  globalThis.gc?.();
  await setImmediate();
  globalThis.gc?.();
  assert.equal(ref.deref(), undefined);
});

test("SE-14B with no attached reader, the log keeps no operation", async () => {
  const s = await started(
    select([] as object[], { ...open, [REPORT]: () => {} }),
  );
  const dropped = collected(value => s.push(value));
  await setImmediate();
  s.pop();
  assert.ok(await dropped);
});

test("SE-14C SE-14A the last reader to finish on close drops the operations that no report has", async () => {
  const s = await started(select({ a: 0 as unknown }, open));
  const a = changes(s);
  const dropped = collected(value => {
    s.a = value;
    s.a = 2;
    s[CHAN].close();
    changes(s); // A reader after close never attaches
  });
  assert.deepEqual(await a.next(), done);
  assert.ok(await dropped);
});

test("SE-14C the report hook keeps the log after the last reader finishes", async () => {
  const reports: Op[][] = [];
  const s = await started(
    select(["a"], { ...open, [REPORT]: ops => void reports.push(ops) }),
  );
  changes(s).return();
  const t = await started(select(["a"], open));
  changes(t).return();
  t.push("b");
  const late = changes(t);
  assert.deepEqual(late.outputs, ["a", "b"]);
  s.push("b");
  await setImmediate();
  assert.equal(reports.length, 2);
  t.push("c");
  assert.deepEqual((await late.next()).value?.length, 1);
});

test("SE-14C without the report hook, the log drops its operations when the last reader finishes", async () => {
  const registry = new FinalizationRegistry<() => void>(done => done());
  let collected = false;
  const s = select({ a: 0 as unknown }, { autoStart: true, autoClose: false });
  await s[Symbol.asyncIterator]().next(); // The next flush blocks at publish, so operations would collect
  s.a = 1;
  await setImmediate();
  const reader = changes(s);
  (() => {
    const value = {};
    registry.register(value, () => (collected = true));
    s.a = value;
    s.a = 2;
  })();
  reader.return();
  for (let i = 0; i < 20 && !collected; i++) {
    await setImmediate();
    globalThis.gc?.();
  }
  assert.ok(collected);
  s[CHAN].close();
});

test("SE-037 the first read of a reader starts the select, and a reader alone does not", async () => {
  const s = select({ a: 1 });
  const r = changes(s);
  await setImmediate();
  assert.deepEqual(changes(s).outputs, {});
  assert.deepEqual(await r.next(), set(1, undefined));
  assert.deepEqual(changes(s).outputs, { a: 1 });
  s[CHAN].close();
});

test("SE-037 SE-030 reads and a consumer start the select once", async () => {
  const s = select({ a: 1 }, { backPressure: false });
  const r = changes(s);
  const first = r.next(),
    second = r.next();
  void s[Symbol.asyncIterator]().next();
  assert.deepEqual(await first, set(1, undefined));
  await setImmediate();
  assert.ok(pending(second));
  s[CHAN].close();
});

test("SE-04A a waiting read releases a flush that no consumer reads", async () => {
  const s = select({ a: 1 });
  const r = changes(s);
  assert.deepEqual(await r.next(), set(1, undefined));
  s.a = 2;
  assert.deepEqual(await r.next(), set(2, 1));
  s.a = 3;
  assert.deepEqual(await r.next(), set(3, 2));
  s[CHAN].close();
});

test("SE-04A a later read releases a waiting flush, and each flush waits for its own read", async () => {
  const s = select({ a: 1 });
  const r = changes(s);
  await r.next();
  s.a = 2;
  await setImmediate();
  s.a = 3;
  await setImmediate();
  assert.deepEqual(await r.next(), set(2, 1));
  await setImmediate();
  s.a = 4;
  await setImmediate();
  assert.deepEqual(await r.next(), set(3, 2));
  assert.deepEqual(await r.next(), set(4, 3));
  s[CHAN].close();
});

test("SE-04A under ackStyle all, only a snapshot consumer releases a flush", async () => {
  const s = select({ a: 1 }, { ackStyle: "all" });
  const r = changes(s);
  await r.next();
  s.a = 2;
  const read = r.next();
  await setImmediate();
  assert.ok(pending(read));
  await s[Symbol.asyncIterator]().next();
  assert.deepEqual(await read, set(2, 1));
  s[CHAN].close();
});

test("SE-14E a dropped reader retains no operation, for a whole log, an index slice and a key slice", async () => {
  const list = await started(select([0] as unknown[], open)),
    keys = await started(select({ a: 0 as unknown }, open));
  (() => {
    changes(list);
    changes(list, [0]);
    changes(keys, ["a"]);
  })();
  assert.ok(await collected(value => (list.push(value), list.pop())));
  assert.ok(await collected(value => ((list[0] = value), (list[0] = 0))));
  assert.ok(await collected(value => ((keys.a = value), (keys.a = 0))));
});

test("SE-14E a dropped reader with a pending next() stays, and gets the next report", async () => {
  const s = await started(select({ a: 0 }, open));
  let got: unknown;
  (() => {
    changes(s)
      .next()
      .then(result => (got = result));
  })();
  for (let i = 0; i < 5; i++) {
    await setImmediate();
    globalThis.gc?.();
  }
  s.a = 1;
  await setImmediate();
  assert.deepEqual(got, set(1, 0));
});

test("SE-14E a reader that the collector took before the registry ran is skipped at start, at a report and at close", async () => {
  const gc = globalThis.gc as () => void;
  const s = select({ a: 0 as unknown }, { ...open, autoStart: false }),
    list = select([0] as unknown[], { ...open, autoStart: false });
  (() => {
    changes(s);
    changes(s, ["a"]);
    changes(list, [0]);
  })();
  const kept = changes(s);
  await setImmediate();
  gc(); // The registry runs in a later task, so the log still has the refs here
  void kept.next();
  list[CHAN][Symbol.asyncIterator]().next();
  await setImmediate();
  gc();
  s.a = 1;
  list[0] = 1;
  await setImmediate();
  gc();
  s[CHAN].close();
  assert.deepEqual(await kept.next(), set(1, 0));
  assert.deepEqual(await kept.next(), done);
});

test("SE-14E a reader whose read settled is not retained", async () => {
  const keys = await started(select({ a: 0 as unknown }, open));
  (() => void changes(keys).next())();
  keys.a = 1;
  await setImmediate();
  assert.ok(await collected(value => ((keys.a = value), (keys.a = 0))));
});

test("SE-14E SE-14C a log whose last reader the collector took drops its operations", async () => {
  const s = select({ a: 0 as unknown }, { autoStart: true, autoClose: false });
  await s[Symbol.asyncIterator]().next(); // The next flush blocks at publish, so operations would collect
  s.a = 1;
  await setImmediate();
  let gone = false;
  const registry = new FinalizationRegistry<number>(() => (gone = true));
  (() => registry.register(changes(s), 0))();
  for (let i = 0; i < 20 && !gone; i++) {
    await setImmediate();
    globalThis.gc?.();
  }
  await setImmediate(); // The registry of the log may run after this one
  assert.ok(gone);
  assert.ok(await collected(value => ((s.a = value), (s.a = 2))));
});
