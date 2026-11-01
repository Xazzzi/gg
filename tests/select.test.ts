import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { inspect } from "node:util";
import {
  CHAN,
  Channel,
  catching,
  feed,
  isVal,
  type Op,
  select,
  spread,
  type Val,
} from "../src/index.ts";

const iter = (s: any) => s[Symbol.asyncIterator]();
const pendingVal = {
  status: "pending",
  value: undefined,
  reason: undefined,
  done: false,
};
const ok = (value: unknown, done = true) => ({
  status: "fulfilled",
  value,
  reason: undefined,
  done,
});
const bad = (reason: unknown) => ({
  status: "rejected",
  value: undefined,
  reason,
  done: true,
});
const open = {
  autoStart: true,
  autoClose: false,
  backPressure: false,
} as const;

const opLog = () => {
  const ops: Op[] = [];
  return { ops, onChanges: (list: Op[]) => void ops.push(...list) };
};

const replay = (ops: Op[], base: any) => {
  for (const op of ops) {
    if (op.op === "set") base[op.key] = op.value;
    else if (op.op === "delete") delete base[op.key];
    else if (op.op === "move") {
      const old = [...base];
      op.order.forEach((from, to) => {
        base[to] = old[from];
      });
    } else base.splice(op.start, op.removed.length, ...op.added);
  }
  return base;
};

const returning = (results: unknown[], extra: object = {}) => {
  let i = 0;
  return {
    next: () => results[i++] ?? { done: true, value: undefined },
    ...extra,
  } as any;
};

test("Examples default states with a pending promise", async () => {
  const p = Promise.withResolvers<number>();
  const s = select({ a: 42, b: p.promise });
  const it = iter(s);
  assert.deepEqual((await it.next()).value, { a: 42, b: pendingVal });
  p.resolve(1);
  assert.deepEqual((await it.next()).value, { a: 42, b: ok(1) });
  assert.equal((await it.next()).done, true);
});

test("Examples unwrap outputs and a rejection fails the channel", async () => {
  const p = Promise.withResolvers<string>();
  const seen: unknown[] = [];
  const s = select({ user: p.promise }, { unwrap: true });
  const run = (async () => {
    for await (const { user } of s) seen.push(user);
  })();
  await setImmediate();
  p.resolve("u");
  await run;
  assert.deepEqual(seen, [undefined, "u"]);
  const failure = new Error("x");
  const f = select({ user: Promise.reject(failure) }, { unwrap: true });
  await assert.rejects(iter(f).next(), e => e === failure);
});

test("Examples catching keeps one source quiet under unwrap", async () => {
  const seen: unknown[] = [];
  const s = select(
    {
      user: Promise.resolve("u"),
      ads: catching(Promise.reject(new Error("x")), e => void seen.push(e)),
    },
    { unwrap: true },
  );
  let last: any;
  for await (const value of s) last = value;
  assert.deepEqual(last, { user: "u", ads: undefined });
  assert.equal(seen.length, 1);
});

test("Examples replay array changes", async () => {
  const log = opLog();
  const s = select([] as string[], {
    nonYielding: true,
    autoClose: false,
    autoStart: true,
    ...log,
  });
  await null;
  s.push("a", "b");
  s.shift();
  await setImmediate();
  assert.deepEqual(log.ops, [
    { op: "splice", start: 0, removed: [], added: ["a", "b"] },
    { op: "splice", start: 0, removed: ["a"], added: [] },
  ]);
});

test("SE-001 SE-002 option defaults", async () => {
  const s = select({ a: 1 });
  const ch = s[CHAN];
  await setImmediate();
  assert.ok(!ch.signal.aborted); // No autoStart
  assert.deepEqual((await iter(s).next()).value, { a: 1 });
  await setImmediate();
  assert.ok(ch.signal.aborted); // autoClose
  const q = select({ a: 1 }, { thenReceive: "unread" });
  assert.deepEqual((await iter(q).next()).value, { a: 1 });
  assert.throws(
    () => select({}, { firstReceive: "latest", thenReceive: "unread" }),
    TypeError,
  );
});

test("SE-002 thenReceive defaults to latest", async () => {
  const s = select({ a: 1 }, { backPressure: false, autoClose: false });
  const it = iter(s);
  assert.deepEqual((await it.next()).value, { a: 1 });
  s.a = 2;
  await setImmediate();
  s.a = 3;
  await setImmediate();
  assert.deepEqual((await it.next()).value, { a: 3 });
  s[Symbol.dispose]();
});

test("SE-007 options of the wrong type throw, and undefined selects the default", async () => {
  for (const key of [
    "autoStart",
    "autoClose",
    "backPressure",
    "nonYielding",
    "unwrap",
  ])
    for (const value of [1, "yes", null, {}])
      assert.throws(() => select({}, { [key]: value } as any), TypeError);
  for (const key of ["onChanges", "mapSnapshot"])
    for (const value of [1, "x", null, {}])
      assert.throws(() => select({}, { [key]: value } as any), TypeError);
  const undefineds: any = {
    autoStart: undefined,
    autoClose: undefined,
    backPressure: undefined,
    nonYielding: undefined,
    unwrap: undefined,
    onChanges: undefined,
    mapSnapshot: undefined,
  };
  assert.deepEqual((await iter(select({ a: 1 }, undefineds)).next()).value, {
    a: 1,
  });
});

test("SE-003 invalid options reach the channel unchanged", () => {
  assert.throws(() => select({}, { firstReceive: null as any }), TypeError);
  assert.throws(() => select({}, { stopStyle: "x" as any }), TypeError);
});

test("SE-003 options pass to the channel", async () => {
  const s = select(
    { a: 1 },
    {
      stopStyle: "stop",
      firstReceive: "next",
      autoStart: true,
      backPressure: false,
    },
  );
  await setImmediate();
  assert.equal((await iter(s).next()).done, true);
});

test("SE-004 SE-005 SE-006 shape handling", () => {
  const shape = { a: 1 },
    list = [1];
  const s = select(shape, open),
    l = select(list, open);
  s.a = 2;
  l.push(2);
  assert.deepEqual(shape, { a: 1 });
  assert.deepEqual(list, [1]);
  assert.ok(Array.isArray(l));
  assert.ok(!Array.isArray(s));
  for (const bad of [null, undefined, 1, "x", () => {}] as any[])
    assert.throws(() => select(bad), TypeError);
});

test("SE-010 SE-011 enumerable string and symbol keys, holes and plain kinds", async () => {
  const key = Symbol("k");
  const hidden = Object.defineProperty({ a: "str", [key]: [1] }, "h", {
    value: 1,
    enumerable: false,
  });
  assert.deepEqual((await iter(select(hidden)).next()).value, {
    a: "str",
    [key]: [1],
  });
  // biome-ignore lint/suspicious/noSparseArray: the test needs a hole
  const holes = select([1, , 3]);
  assert.ok(1 in holes);
  assert.deepEqual((await iter(holes).next()).value, [1, undefined, 3]);
});

test("SE-012 SE-020 SE-026 promise states", async () => {
  const failure = new Error("x");
  const s = select(
    {
      a: Promise.resolve(1),
      b: Promise.reject(failure),
      c: new Promise(() => {}),
    },
    { autoStart: true },
  );
  await setImmediate();
  const { value } = await iter(s).next();
  assert.deepEqual(value, { a: ok(1), b: bad(failure), c: pendingVal });
  s[CHAN].close();
});

test("SE-013 an async iterable stays async, and each result is awaited", async () => {
  const seen: unknown[] = [];
  const s = select({
    a: (async function* () {
      yield 1;
      yield 2;
    })(),
  });
  for await (const value of s as any) seen.push(value.a);
  assert.deepEqual(seen, [pendingVal, ok(1, false), ok(2, false), ok(2, true)]);
});

test("SE-013 a plain result from an async iterator is accepted", async () => {
  const it: any = {
    [Symbol.asyncIterator]() {
      return returning([{ value: 1, done: true }]);
    },
  };
  let last: any;
  for await (const value of select({ it }) as any) last = value;
  assert.deepEqual(last, { it: ok(1) });
});

test("SE-014 a thenable first result makes a raw iterator async", async () => {
  const raw = returning([
    Promise.resolve({ value: 1, done: false }),
    Promise.resolve({ value: 2, done: true }),
  ]);
  let last: any;
  for await (const value of select({ raw }) as any) last = value;
  assert.deepEqual(last, { raw: ok(2) });
});

test("SE-014 a sync raw iterator is not treated as async", async () => {
  const seen: unknown[] = [];
  for await (const value of select({
    raw: returning([
      { value: 1, done: false },
      { value: 2, done: false },
    ]),
  }) as any)
    seen.push(value.raw);
  assert.deepEqual(seen, [ok(1, false)]);
});

test("SE-015 SE-033 a raw iterator's first pull waits for a flush", async () => {
  let pulls = 0;
  const raw = {
    next() {
      pulls++;
      return { value: 1, done: false };
    },
  };
  const s = select({ raw });
  await setImmediate();
  assert.equal(pulls, 0);
  await iter(s).next();
  assert.equal(pulls, 1);
});

test("SE-016 a detection error propagates and changes nothing", async () => {
  const failure = new Error("x");
  const bad = {
    get then() {
      throw failure;
    },
  };
  assert.throws(
    () => select({ bad }),
    e => e === failure,
  );
  assert.throws(
    () => select([bad]),
    e => e === failure,
  );
  const log = opLog();
  const s: any = select({ a: 1 }, { ...open, ...log });
  const l: any = select([1], { ...open, ...log });
  await setImmediate();
  log.ops.length = 0;
  assert.throws(
    () => (s.a = bad),
    e => e === failure,
  );
  assert.throws(
    () => (s.b = bad),
    e => e === failure,
  );
  assert.throws(
    () => (l[0] = bad),
    e => e === failure,
  );
  assert.throws(
    () => l.push(Promise.resolve(2), bad),
    e => e === failure,
  );
  await setImmediate();
  assert.deepEqual({ ...s }, { a: 1 });
  assert.deepEqual([...l], [1]);
  assert.deepEqual(log.ops, []);
  s[CHAN].close();
  l[CHAN].close();
});

test("SE-016 detection runs once, and later steps use what it read", async () => {
  const reads = { then: 0, async: 0, next: 0, promise: 0 };
  let factories = 0;
  const thenable = {
    get then() {
      reads.then++;
      return (ok: (v: number) => void) => ok(1);
    },
  };
  const iterable = {
    get [Symbol.asyncIterator]() {
      reads.async++;
      return () => (factories++, returning([]));
    },
  };
  const raw = {
    get next() {
      reads.next++;
      return () => ({ value: 1, done: false });
    },
  };
  const promise = Promise.resolve(2);
  Object.defineProperty(promise, "then", {
    get() {
      reads.promise++;
      return Promise.prototype.then;
    },
  });
  const expected = { then: 1, async: 1, next: 1, promise: 1 };
  const s: any = select(
    { thenable, iterable, raw, promise, x: 0 },
    { ...open },
  );
  assert.deepEqual(reads, expected);
  await setImmediate();
  s.x = 1;
  await setImmediate();
  assert.deepEqual(reads, expected);
  assert.equal(factories, 1);
  s[CHAN].close();
});

test("SE-021 equal results are new states", async () => {
  const s: any = select(
    { raw: { next: () => ({ value: 1, done: false }) }, x: 0 },
    { ...open, thenReceive: "every", firstReceive: "first" },
  );
  const it = iter(s);
  const first = (await it.next()).value.raw;
  s.x = 1;
  assert.notEqual((await it.next()).value.raw, first);
  s[CHAN].close();
});

test("SE-021 SE-023 SE-024 iterator ends", async () => {
  const cases: [unknown[], unknown][] = [
    [
      [
        { value: 1, done: 0 },
        { value: 2, done: 1 },
      ],
      ok(2),
    ],
    [[{ value: 1, done: false }, { done: true }], ok(1)],
    [[{ done: true }], ok(undefined)],
  ];
  for (const [results, expected] of cases) {
    const raw = {
      i: 0,
      next() {
        return Promise.resolve(results[this.i++]);
      },
    };
    let last: any;
    for await (const value of select({ raw }) as any) last = value.raw;
    assert.deepEqual(last, expected);
  }
});

test("SE-022 a slot keeps its state between results", async () => {
  const gate = Promise.withResolvers<void>();
  const other = Promise.withResolvers<number>();
  const source = (async function* () {
    yield 1;
    await gate.promise;
  })();
  const s = select(
    { source, other: other.promise },
    {
      autoStart: true,
      backPressure: false,
      thenReceive: "every",
      firstReceive: "first",
    },
  );
  await setImmediate();
  other.resolve(2);
  await setImmediate();
  const it = iter(s);
  await it.next();
  await it.next();
  const { value } = await it.next();
  assert.deepEqual(value, { source: ok(1, false), other: ok(2) });
  s[CHAN].close();
  gate.resolve();
});

test("SE-025 iterator failures", async () => {
  const failure = new Error("x");
  for (const raw of [
    {
      next() {
        throw failure;
      },
    },
    { next: () => Promise.reject(failure) },
    returning([{ value: Promise.reject(failure), done: false }]),
    returning([
      Promise.resolve({ value: Promise.reject(failure), done: false }),
    ]),
  ]) {
    let last: any;
    for await (const value of select({ raw }) as any) last = value.raw;
    assert.deepEqual(last, bad(failure));
  }
  for (const raw of [returning([1]), returning([Promise.resolve(1)])]) {
    let last: any;
    for await (const value of select({ raw }) as any) last = value.raw;
    assert.ok(last.reason instanceof TypeError);
  }
});

test("SE-025 a thenable result from a sync iterator fails with a TypeError", async () => {
  let pulls = 0,
    returned = 0;
  const raw = {
    next: () =>
      pulls++ ? Promise.reject(new Error("x")) : { value: 1, done: false },
    return() {
      returned++;
      throw new Error("ignored");
    },
  };
  const s: any = select(
    { raw, x: 0 },
    { ...open, thenReceive: "every", firstReceive: "first" },
  );
  const it = iter(s);
  assert.deepEqual((await it.next()).value.raw, ok(1, false));
  s.x = 1;
  const { raw: state } = (await it.next()).value;
  assert.equal(state.status, "rejected");
  assert.ok(state.reason instanceof TypeError);
  assert.equal(returned, 1); // SE-02A
  s.x = 2;
  await setImmediate();
  assert.equal(pulls, 2);
  s[CHAN].close();
  assert.equal(returned, 1);
});

test("SE-025 an error from reading done or value fails with no return", async () => {
  for (const wrap of [(r: unknown) => r, (r: unknown) => Promise.resolve(r)])
    for (const key of ["done", "value"]) {
      const failure = new Error(key);
      let returned = 0;
      const result = Object.defineProperty({ done: false, value: 1 }, key, {
        get() {
          throw failure;
        },
      });
      let last: any;
      for await (const value of select({
        raw: {
          next: () => wrap(result),
          return() {
            returned++;
          },
        },
      }) as any)
        last = value.raw;
      assert.deepEqual(last, bad(failure));
      assert.equal(returned, 0, key);
    }
});

test("SE-02A a throwing then getter on a value counts as a rejected value", async () => {
  const failure = new Error("x");
  for (const wrap of [(r: unknown) => r, (r: unknown) => Promise.resolve(r)]) {
    let returned = 0;
    const value = {
      get then() {
        throw failure;
      },
    };
    let last: any;
    for await (const snap of select({
      raw: {
        next: () => wrap({ value, done: false }),
        return() {
          returned++;
        },
      },
    }) as any)
      last = snap.raw;
    assert.deepEqual(last, bad(failure));
    assert.equal(returned, 1);
  }
});

test("SE-025 a failed iterator is not pulled again", async () => {
  let pulls = 0;
  const raw = {
    next() {
      pulls++;
      throw new Error("x");
    },
  };
  const s: any = select(
    { raw, other: 1 },
    { autoStart: true, autoClose: false, backPressure: false },
  );
  await setImmediate();
  s.other = 2;
  await setImmediate();
  assert.equal(pulls, 1);
});

test("SE-027 a fulfilled value is never a thenable", async () => {
  const s = select({
    a: returning([{ value: Promise.resolve(1), done: true }]),
  });
  let last: any;
  for await (const value of s as any) last = value;
  assert.deepEqual(last, { a: ok(1) });
});

test("SE-028 SE-029 SE-051 a Val is frozen, branded and stable", async () => {
  const p = Promise.withResolvers<number>();
  const plain = {};
  const s: any = select(
    { a: new Promise(() => {}), b: p.promise, plain },
    { ...open, thenReceive: "every", firstReceive: "first" },
  );
  const it = iter(s);
  const first = (await it.next()).value;
  p.resolve(1);
  const second = (await it.next()).value;
  assert.ok(Object.isFrozen(first.a));
  assert.ok(isVal(first.a));
  assert.deepEqual(Object.keys(first.a), ["status", "value", "reason", "done"]);
  assert.equal(first.a, second.a);
  assert.equal(first.plain, second.plain);
  assert.notEqual(first, second);
  s[CHAN].close();
});

test("SE-02A a value rejection closes an open iterator, ignoring errors", async () => {
  let returned = 0;
  const raw = (done: boolean) =>
    returning([{ value: Promise.reject(new Error("x")), done }], {
      return() {
        returned++;
        throw new Error("ignored");
      },
    });
  for await (const _ of select({ raw: raw(false) }) as any);
  assert.equal(returned, 1);
  for await (const _ of select({ raw: raw(true) }) as any);
  assert.equal(returned, 1);
});

test("SE-030 SE-031 SE-032 start timing", async () => {
  const log: string[] = [];
  const s = select(
    { a: 1 },
    {
      autoStart: true,
      backPressure: false,
      autoClose: false,
      onChanges: () => void log.push("flush"),
    },
  );
  log.push("called");
  await null;
  log.push("started");
  await null;
  log.push("after");
  assert.deepEqual(log, ["called", "started", "flush", "after"]);
  s[CHAN].close();
});

test("SE-030 a terminal channel means no start", async () => {
  let touched = 0;
  const s = select({
    a: {
      then() {
        touched++;
      },
    },
  });
  s[CHAN].close();
  await setImmediate();
  const auto = select(
    {
      a: {
        [Symbol.asyncIterator]() {
          touched++;
        },
      } as any,
    },
    { autoStart: true },
  );
  auto[Symbol.dispose]();
  await setImmediate();
  assert.equal(touched, 0);
});

test("SE-032 a settled Promise assigned before start appears settled", async () => {
  const failure = new Error("x");
  const { value } = await iter(
    select({ a: Promise.resolve(1), b: Promise.reject(failure) }),
  ).next();
  assert.deepEqual(value, { a: ok(1), b: bad(failure) });
  const s: any = select({} as any, { autoStart: true });
  s.a = Promise.resolve(2);
  assert.deepEqual((await iter(s).next()).value, { a: ok(2) });
});

test("SE-034 a Promise is handled from assignment, even when terminal", async () => {
  const s: any = select({ a: Promise.reject(new Error("x")) });
  s.b = Promise.reject(new Error("y"));
  s[CHAN].close();
  s.c = Promise.reject(new Error("z"));
  const l: any = select([]);
  l.push(Promise.reject(new Error("y")));
  l[CHAN].close();
  l.push(Promise.reject(new Error("z")));
  await setImmediate();
});

test("SE-034 a rejection before start records without flushing", async () => {
  const log = opLog();
  const failure = new Error("x");
  const s = select(
    { a: Promise.reject(failure) },
    { ...log, backPressure: false },
  );
  await setImmediate();
  assert.deepEqual(log.ops, []);
  iter(s).next();
  await setImmediate();
  assert.deepEqual(log.ops, [
    { op: "set", key: "a", value: bad(failure), prev: undefined },
  ]);
});

test("SE-035 a thenable waits for start, and is untouched on terminal", async () => {
  let calls = 0;
  const thenable = () => ({
    then(ok: (v: number) => void) {
      calls++;
      ok(1);
    },
  });
  const s: any = select({ a: thenable() });
  await setImmediate();
  assert.equal(calls, 0);
  assert.deepEqual((await iter(s).next()).value, { a: ok(1) });
  assert.equal(calls, 1);
  s[CHAN].close();
  s.b = thenable();
  await setImmediate();
  assert.equal(calls, 1);
});

test("SE-035 a throwing then rejects the slot, and SE-055 applies", async () => {
  const failure = new Error("x");
  const source = {
    then() {
      throw failure;
    },
  };
  assert.deepEqual((await iter(select({ source })).next()).value, {
    source: bad(failure),
  });
  await assert.rejects(
    iter(select({ source }, { unwrap: true })).next(),
    e => e === failure,
  );
});

test("SE-036 the async iterator is obtained at start or assignment", async () => {
  let factory = 0;
  const source = {
    [Symbol.asyncIterator]() {
      factory++;
      return returning([]);
    },
  };
  const s: any = select({ source }, { backPressure: false, autoClose: false });
  await setImmediate();
  assert.equal(factory, 0);
  iter(s).next();
  await setImmediate();
  assert.equal(factory, 1);
  s.more = source;
  assert.equal(factory, 2);
  s[CHAN].close();
});

test("SE-036 a throwing factory rejects the slot", async () => {
  const failure = new Error("x");
  const source: any = {
    [Symbol.asyncIterator]() {
      throw failure;
    },
  };
  assert.deepEqual((await iter(select({ source })).next()).value, {
    source: bad(failure),
  });
  await assert.rejects(
    iter(select({ source }, { unwrap: true })).next(),
    e => e === failure,
  );
});

test("SE-036 an async iterator without a callable next fails its slot", async () => {
  for (const iterator of [{}, undefined]) {
    const source = { [Symbol.asyncIterator]: () => iterator } as any;
    let last: any;
    for await (const value of select({ source }) as any) last = value.source;
    assert.ok(last.reason instanceof TypeError);
  }
});

test("SE-036 assignment before start touches nothing", async () => {
  let factory = 0;
  const source = {
    [Symbol.asyncIterator]() {
      factory++;
      return returning([]);
    },
  };
  const s: any = select({} as any, { backPressure: false, autoClose: false });
  const l: any = select([] as any[], { backPressure: false, autoClose: false });
  s.source = source;
  l.push(source);
  assert.equal(factory, 0);
  iter(s).next();
  iter(l).next();
  await setImmediate();
  assert.equal(factory, 2);
  s[CHAN].close();
  l[CHAN].close();
});

test("SE-036 SE-035 mutators activate what they add after start", async () => {
  let factory = 0,
    thens = 0,
    pulls = 0;
  const s: any = select([] as any[], open);
  await setImmediate();
  s.push(
    {
      [Symbol.asyncIterator]() {
        factory++;
        return returning([]);
      },
    },
    {
      then(ok: (v: number) => void) {
        thens++;
        ok(1);
      },
    },
    {
      next() {
        pulls++;
        return { value: 1, done: true };
      },
    },
  );
  assert.deepEqual([factory, thens], [1, 1]);
  await setImmediate();
  assert.equal(pulls, 1);
  s[CHAN].close();
});

test("SE-036 unwrap skips activation once a rejection failed the channel", async () => {
  let factory = 0;
  const failure = new Error("x");
  const source: any = {
    [Symbol.asyncIterator]() {
      factory++;
      return returning([]);
    },
  };
  const s = select({ bad: Promise.reject(failure), source }, { unwrap: true });
  await setImmediate();
  await assert.rejects(iter(s).next(), e => e === failure);
  assert.equal(factory, 0);
});

test("SE-040 changes in one run share one flush", async () => {
  const log: Op[][] = [];
  const s: any = select(
    { a: 1 },
    { ...open, onChanges: ops => void log.push(ops) },
  );
  await setImmediate();
  log.length = 0;
  s.a = 2;
  s.a = 3;
  await setImmediate();
  assert.equal(log.length, 1);
  assert.equal(log[0].length, 2);
  s[CHAN].close();
});

test("SE-040 no operations means no report", async () => {
  let reports = 0;
  const raw = { next: () => ({ value: 1, done: true }) };
  const s = select([], { ...open, onChanges: () => void reports++ });
  const t = select({}, { ...open, onChanges: () => void reports++ });
  await setImmediate();
  assert.equal(reports, 0);
  const u: any = select({ raw }, { ...open, onChanges: () => void reports++ });
  await setImmediate();
  assert.equal(reports, 1);
  for (const state of [s, t, u]) state[CHAN].close();
});

test("SE-040 changes in one run publish once", async () => {
  let published = 0;
  const s: any = select(
    { a: 1 },
    { ...open, mapSnapshot: snap => (published++, snap) },
  );
  await setImmediate();
  s.a = 2;
  s.b = 3;
  await setImmediate();
  assert.equal(published, 2);
  s[CHAN].close();
});

test("SE-041 mapSnapshot applies to the sent value", async () => {
  const s = select({ a: 1 }, { mapSnapshot: snap => snap.a + 1 });
  assert.equal((await iter(s).next()).value, 2);
});

test("SE-042 SE-043 backPressure holds the next flush until the read", async () => {
  const log: Op[][] = [];
  const s: any = select(
    { a: 1 },
    { autoStart: true, autoClose: false, onChanges: ops => void log.push(ops) },
  );
  await setImmediate();
  s.a = 2;
  await setImmediate();
  assert.equal(log.length, 1);
  await iter(s).next();
  await setImmediate();
  assert.equal(log.length, 2);
  s[CHAN].close();
});

test("SE-043 a change during step 1 belongs to that flush", async () => {
  const log: Op[][] = [];
  const s: any = select(
    {
      raw: {
        next() {
          s.y = 1;
          return { value: 1, done: false };
        },
      },
    } as any,
    { ...open, onChanges: ops => void log.push(ops) },
  );
  await setImmediate();
  assert.equal(log.length, 1);
  assert.deepEqual(
    log[0].map(op => (op as any).key),
    ["raw", "y", "raw"],
  );
  s[CHAN].close();
});

test("SE-043 a raw iterator assigned during step 1 gets its first pull in that flush", async () => {
  const log: Op[][] = [];
  let pulls = 0;
  const added = {
    next() {
      pulls++;
      return { value: 2, done: false };
    },
  };
  const s: any = select(
    {
      raw: {
        next() {
          s.added ??= added;
          return { value: 1, done: false };
        },
      },
    } as any,
    { ...open, onChanges: ops => void log.push(ops) },
  );
  await setImmediate();
  assert.equal(pulls, 1);
  assert.equal(log.length, 1);
  s[CHAN].close();
});

test("SE-043 a slot replaced during step 1 is pulled once, and a removed one not at all", async () => {
  let replaced = 0,
    removed = 0,
    first = 0;
  const s: any = select(
    [
      {
        next() {
          if (!first++) {
            s[1] = {
              next() {
                replaced++;
                return { value: 1, done: false };
              },
            };
            s.pop();
          }
          return { value: 1, done: false };
        },
      },
      {
        next() {
          removed++;
          return { value: 1, done: false };
        },
      },
      {
        next() {
          removed++;
          return { value: 1, done: false };
        },
      },
    ],
    open,
  );
  await setImmediate();
  assert.deepEqual([first, replaced, removed], [1, 1, 0]);
  s[CHAN].close();
});

test("SE-043 changes from step 2 onward wait for the next flush", async () => {
  const log: Op[][] = [];
  const s: any = select(
    { a: 1 },
    {
      ...open,
      onChanges(ops) {
        log.push(ops);
        if (log.length === 1) s.a = 2;
      },
    },
  );
  await setImmediate();
  assert.deepEqual(
    log.map(ops => ops.length),
    [1, 1],
  );
  s[CHAN].close();
});

test("SE-044 one pull at a time on an async iterator", async () => {
  let running = 0,
    peak = 0;
  const source = {
    async *[Symbol.asyncIterator]() {
      for (let i = 0; i < 3; i++) {
        peak = Math.max(peak, ++running);
        await setImmediate();
        running--;
        yield i;
      }
    },
  };
  const s: any = select({ source, x: 0 }, { ...open });
  for (let i = 0; i < 8; i++) {
    s.x = i + 1;
    await setImmediate();
  }
  assert.equal(peak, 1);
  s[CHAN].close();
});

test("SE-044 a raw async iterator has one pull in progress", async () => {
  let pulls = 0;
  const raw = {
    next() {
      pulls++;
      return new Promise(() => {});
    },
  };
  const s: any = select({ raw, x: 0 }, open);
  await setImmediate();
  s.x = 1;
  await setImmediate();
  s.x = 2;
  await setImmediate();
  assert.equal(pulls, 1);
  s[CHAN].close();
});

test("SE-015 a raw async iterator is pulled after the publish is read", async () => {
  const pulls: PromiseWithResolvers<IteratorResult<number>>[] = [];
  const raw = {
    next() {
      const pull = Promise.withResolvers<IteratorResult<number>>();
      pulls.push(pull);
      return pull.promise;
    },
  };
  const s: any = select(
    { raw },
    { autoClose: false, thenReceive: "every", firstReceive: "first" },
  );
  const it = iter(s);
  await it.next();
  assert.equal(pulls.length, 1);
  pulls[0].resolve({ value: 1, done: false });
  await setImmediate();
  assert.equal(pulls.length, 1);
  await it.next();
  await setImmediate();
  assert.equal(pulls.length, 2);
  s[CHAN].close();
});

test("SE-045 nonYielding sends nothing and skips step 4", async () => {
  let mapped = 0;
  const raw = (async function* () {
    yield 1;
    yield 2;
  })();
  const log = opLog();
  const s = select(
    { raw },
    {
      autoStart: true,
      nonYielding: true,
      mapSnapshot: () => void mapped++,
      ...log,
    },
  );
  await setImmediate();
  await setImmediate();
  assert.equal(mapped, 0);
  assert.ok(s[CHAN].signal.aborted);
  assert.deepEqual(replay(log.ops, {}), { raw: ok(2) });
  assert.equal((await iter(s).next()).done, true);
});

test("SE-050 SE-053 unwrap snapshot, in slot order", async () => {
  const s = select([Promise.resolve(1), new Promise(() => {}), 3], {
    unwrap: true,
    autoStart: true,
    backPressure: false,
  });
  await setImmediate();
  assert.deepEqual((await iter(s).next()).value, [1, undefined, 3]);
  s[CHAN].close();
});

test("SE-050 a __proto__ key stays an own snapshot field", async () => {
  const s: any = select(Object.fromEntries([["__proto__", 1]]));
  Reflect.set(s, "__proto__", 2);
  const value = (await iter(s).next()).value;
  assert.equal(Object.getPrototypeOf(value), Object.prototype);
  assert.ok(Object.hasOwn(value, "__proto__"));
  assert.equal(Object.getPrototypeOf(s), Object.prototype);
});

test("SE-052 SE-054 SE-111 a thenable snapshot fails the channel", async () => {
  for (const backPressure of [true, false])
    for (const options of [{ mapSnapshot: () => ({ then() {} }) }, {}]) {
      const s = select({ then: () => {} }, { ...options, backPressure } as any);
      await assert.rejects(iter(s).next(), TypeError);
    }
});

test("SE-055 a rejection before start takes effect at start, unless replaced", async () => {
  const failure = new Error("x");
  const s: any = select({ a: Promise.reject(failure) }, { unwrap: true });
  await setImmediate();
  s.a = 1;
  assert.deepEqual((await iter(s).next()).value, { a: 1 });
});

test("SE-055 a rejection after start throws unchanged", async () => {
  const p = Promise.withResolvers<number>();
  const failure = new Error("x");
  const log = opLog();
  const s = select({ a: p.promise }, { unwrap: true, ...log });
  const it = iter(s);
  await it.next();
  const count = log.ops.length;
  p.reject(failure);
  await assert.rejects(it.next(), e => e === failure);
  assert.equal(log.ops.length, count);
});

test("SE-060 SE-061 a flush advances an idle sync iterator once", async () => {
  let pulls = 0;
  const raw = {
    next() {
      return { value: ++pulls, done: false };
    },
  };
  const s: any = select(
    { raw, x: 0 },
    { ...open, thenReceive: "every", firstReceive: "first" },
  );
  const it = iter(s);
  assert.equal((await it.next()).value.raw.value, 1);
  s.x = 1;
  assert.equal((await it.next()).value.raw.value, 2);
  s.x = 2;
  assert.equal((await it.next()).value.raw.value, 3);
  assert.equal(pulls, 3);
  s[CHAN].close();
});

test("SE-062 SE-063 SE-064 SE-065 yielded promises flow, and plain values stop", async () => {
  const gate = Promise.withResolvers<number>();
  let pulls = 0;
  const seq = [gate.promise, Promise.resolve(2), 3, 4, 5];
  const raw = {
    next() {
      return { value: seq[pulls++], done: false };
    },
  };
  const seen: unknown[] = [];
  const s: any = select(
    { raw, x: 0 },
    {
      ...open,
      thenReceive: "every",
      firstReceive: "first",
      onChanges: ops =>
        void seen.push(
          ...ops
            .filter(o => o.op === "set" && o.key === "raw")
            .map((o: any) => o.value.value),
        ),
    },
  );
  await setImmediate();
  assert.equal(pulls, 1);
  s.x = 1; // SE-062, the pending promise blocks an advance
  await setImmediate();
  assert.equal(pulls, 1);
  gate.resolve(1);
  await setImmediate();
  assert.equal(pulls, 3); // SE-064 for values 1 and 2, then the plain 3 stops
  assert.deepEqual(seen, [undefined, 1, 2, 3]);
  s.x = 2; // A new reason to flush advances once
  await setImmediate();
  assert.equal(pulls, 4);
  s[CHAN].close();
});

test("SE-066 a rejected yielded promise fails the iterator", async () => {
  let returned = 0;
  const failure = new Error("x");
  const raw = returning([{ value: Promise.reject(failure), done: false }], {
    return() {
      returned++;
    },
  });
  let last: any;
  for await (const value of select({ raw }) as any) last = value.raw;
  assert.deepEqual(last, bad(failure));
  assert.equal(returned, 1);
});

test("SE-070 SE-071 pending sources keep the channel open", async () => {
  const p = Promise.withResolvers<number>();
  const s = select({ p: p.promise }, { autoStart: true, backPressure: false });
  await setImmediate();
  assert.ok(!s[CHAN].signal.aborted);
  p.resolve(1);
  await setImmediate();
  assert.ok(s[CHAN].signal.aborted);
  const a = select(
    {
      a: (async function* () {
        await new Promise(() => {});
      })(),
    },
    { autoStart: true, backPressure: false },
  );
  await setImmediate();
  assert.ok(!a[CHAN].signal.aborted);
  a[CHAN].close();
});

test("SE-072 SE-073 sync iterators keep it open only with a pending yield", async () => {
  const gate = Promise.withResolvers<number>();
  const s = select(
    {
      raw: returning([
        { value: gate.promise, done: false },
        { value: 2, done: false },
      ]),
    },
    { autoStart: true, backPressure: false },
  );
  await setImmediate();
  assert.ok(!s[CHAN].signal.aborted);
  gate.resolve(1);
  await setImmediate();
  assert.ok(s[CHAN].signal.aborted);
});

test("SE-074 a shape with no sources closes after its first flush", async () => {
  for (const shape of [{}, [], { a: 1 }]) {
    const s = select(shape, { autoStart: true, backPressure: false });
    await setImmediate();
    assert.ok(s[CHAN].signal.aborted);
  }
});

test("SE-075 collected changes keep the channel open", async () => {
  const s: any = select({ a: 1 }, { autoStart: true });
  await setImmediate();
  s.b = 2;
  const it = iter(s);
  assert.deepEqual((await it.next()).value, { a: 1 });
  assert.deepEqual((await it.next()).value, { a: 1, b: 2 });
  assert.equal((await it.next()).done, true);
});

test("SE-080 SE-081 reads return sources, and keys reflect slots", () => {
  const p = Promise.resolve(1),
    key = Symbol("k");
  const s: any = select({ p, [key]: 1 }, open);
  assert.equal(s.p, p);
  assert.equal(s.missing, undefined);
  assert.equal(s.toString, Object.prototype.toString);
  assert.deepEqual(Reflect.ownKeys(s), ["p", key]);
  assert.deepEqual(Object.getOwnPropertyDescriptor(s, "p"), {
    value: p,
    writable: true,
    enumerable: true,
    configurable: true,
  });
  for (const reserved of [Symbol.asyncIterator, Symbol.dispose, CHAN])
    assert.ok(reserved in s);
  assert.ok("p" in s);
  assert.ok(!("q" in s));
});

test("SE-082 SE-083 SE-084 reserved keys", async () => {
  const s = select({ a: 1 }, open);
  assert.ok(s[CHAN] instanceof Channel);
  assert.equal(CHAN, Symbol.for("gg.CHAN"));
  assert.deepEqual((await iter(s).next()).value, { a: 1 });
  s[Symbol.dispose]();
  assert.ok(s[CHAN].signal.aborted);
});

test("SE-085 SE-08A reserved writes throw, even when terminal", () => {
  const s: any = select({}, open);
  const check = () => {
    for (const key of [Symbol.asyncIterator, Symbol.dispose, CHAN]) {
      assert.throws(() => (s[key] = 1), TypeError);
      assert.throws(() => delete s[key], TypeError);
    }
  };
  check();
  s[CHAN].close();
  check();
});

test("SE-086 SE-088 assignment replaces or adds, and resets state", async () => {
  const s: any = select(
    { a: Promise.resolve(1) },
    { ...open, thenReceive: "every", firstReceive: "first" },
  );
  const it = iter(s);
  await setImmediate();
  await it.next();
  s.a = new Promise(() => {});
  s.b = 2;
  assert.deepEqual((await it.next()).value, { a: pendingVal, b: 2 });
  s[CHAN].close();
});

test("SE-087 the same source does nothing", async () => {
  const log = opLog();
  const value = {};
  const s: any = select({ a: value, n: NaN }, { ...open, ...log });
  const l: any = select([1], { ...open, ...log });
  await setImmediate();
  log.ops.length = 0;
  s.a = value;
  s.n = NaN;
  l[0] = 1;
  l.length = 1;
  await setImmediate();
  assert.deepEqual(log.ops, []);
});

test("SE-089 SE-104 delete", async () => {
  const log = opLog();
  const s: any = select({ a: 1 }, { ...open, ...log });
  await setImmediate();
  log.ops.length = 0;
  delete s.a;
  delete s.missing;
  await setImmediate();
  assert.deepEqual(log.ops, [{ op: "delete", key: "a", prev: 1 }]);
  assert.ok(!("a" in s));
  assert.deepEqual((await iter(s).next()).value, {});
});

test("SE-089 delete on an array assigns undefined", async () => {
  const log = opLog();
  const s: any = select([1, 2], { ...open, ...log });
  await setImmediate();
  log.ops.length = 0;
  delete s[0];
  delete s[9];
  delete s.other;
  assert.throws(() => delete s.length, TypeError);
  await setImmediate();
  assert.deepEqual(log.ops, [{ op: "set", key: 0, value: undefined, prev: 1 }]);
  assert.equal(s.length, 2);
});

test("SE-08A terminal writes succeed without tracking", async () => {
  const log = opLog();
  const s: any = select({ a: 1 }, { ...open, ...log });
  const l: any = select([1, 2], { ...open, ...log });
  await setImmediate();
  s[CHAN].close();
  l[CHAN].close();
  log.ops.length = 0;
  let pulled = 0;
  s.a = 2;
  s.raw = {
    next() {
      pulled++;
    },
  };
  delete s.a;
  l.push(3);
  l[0] = 9;
  l.length = 1;
  await setImmediate();
  assert.deepEqual(Object.keys(s), ["raw"]);
  assert.deepEqual([...l], [9]);
  assert.equal(pulled, 0);
  assert.deepEqual(log.ops, []);
  assert.ok(s[CHAN].signal.aborted);
  assert.throws(() => (l.x = 1), TypeError);
});

test("SE-08A terminal writes run no detection", () => {
  let reads = 0;
  const source = {
    get then() {
      reads++;
      throw new Error("x");
    },
  };
  const s: any = select({ a: 1 }, open);
  const l: any = select([1], open);
  s[CHAN].close();
  l[CHAN].close();
  s.a = source;
  s.b = source;
  l[0] = source;
  l.push(source);
  l.unshift(source);
  assert.equal(reads, 0);
  assert.equal(s.b, source);
  assert.equal(l.length, 3);
});

test("SE-08B an own reserved key in the shape throws, enumerable or not", () => {
  for (const key of [Symbol.asyncIterator, Symbol.dispose, CHAN]) {
    assert.throws(() => select({ [key]: 1 }), TypeError);
    assert.throws(
      () => select(Object.defineProperty({}, key, { value: 1 })),
      TypeError,
    );
  }
});

test("SE-08C structural traps throw, and set does not depend on them", () => {
  const s: any = select({ a: 1 }, open);
  assert.throws(() => Object.defineProperty(s, "b", { value: 1 }), TypeError);
  assert.throws(() => Object.preventExtensions(s), TypeError);
  assert.throws(() => Object.setPrototypeOf(s, null), TypeError);
  assert.throws(() => Object.freeze(s), TypeError);
  s.a = 2;
  assert.equal(s.a, 2);
});

test("SE-090 SE-091 SE-092 mutators move slots and return like Array", async () => {
  const later = Promise.withResolvers<number>();
  const s: any = select([later.promise, 2], {
    ...open,
    thenReceive: "every",
    firstReceive: "first",
  });
  await setImmediate();
  const model: unknown[] = [...s];
  const both = (name: string, ...args: unknown[]) =>
    assert.deepEqual(s[name](...args), (model as any)[name](...args), name);
  both("unshift", 0);
  both("push", 3, 4);
  both("pop");
  both("shift");
  both("unshift", 7, 8);
  both("splice", 1, 1);
  both("splice", -1);
  both("splice", 1, 0, "a", "b");
  both("splice", 0, 1.5, "c");
  both("splice", 100, 2);
  both("splice", -100, 0);
  both("splice", 1, -1);
  both("splice", "1", undefined);
  both("splice", NaN, "x");
  both("splice");
  assert.deepEqual([...s], model);
  const index = model.indexOf(later.promise);
  later.resolve(5);
  await setImmediate();
  let last: any;
  const it = iter(s);
  for (let i = 0; i < 20; i++) {
    const race = await Promise.race([
      it.next(),
      setImmediate().then(() => undefined),
    ]);
    if (!race) break;
    last = (race as any).value;
    if (last[index]?.status === "fulfilled") break;
  }
  assert.deepEqual(last[index], ok(5));
  s[CHAN].close();
});

test("SE-091 pop and shift on an empty array", () => {
  const s: any = select([], open);
  assert.equal(s.pop(), undefined);
  assert.equal(s.shift(), undefined);
  assert.equal(s.push(), 0);
  assert.equal(s.unshift(), 0);
  assert.deepEqual(s.splice(0, 1), []);
});

test("SE-093 SE-124 a removed slot's updates are ignored", async () => {
  const log = opLog();
  const a = Promise.withResolvers<number>(),
    b = Promise.withResolvers<number>();
  const pull = Promise.withResolvers<IteratorResult<number>>();
  const raw = { next: () => pull.promise };
  const s: any = select([a.promise, raw, 1], { ...open, ...log });
  const o: any = select({ b: b.promise }, { ...open, ...log });
  await setImmediate();
  s.shift();
  s.shift();
  delete o.b;
  await setImmediate();
  log.ops.length = 0;
  a.reject(new Error("x"));
  b.resolve(2);
  pull.reject(new Error("y"));
  await setImmediate();
  assert.deepEqual(log.ops, []);
  s[CHAN].close();
  o[CHAN].close();
});

test("SE-09E copyWithin replaces the target range through one splice", async () => {
  const log = opLog();
  const s: any = select([1, 2, 3, 4], { ...open, ...log });
  await setImmediate();
  log.ops.length = 0;
  assert.equal(s.copyWithin(0, 2), s);
  await setImmediate();
  assert.deepEqual([...s], [3, 4, 3, 4]);
  assert.deepEqual(log.ops, [
    { op: "splice", start: 0, removed: [1, 2], added: [3, 4] },
  ]);
  s[CHAN].close();
});

test("SE-09E copyWithin follows Array range rules", () => {
  const ranges = [
    [0, 1],
    [1, 0],
    [2, 0],
    [0, 1, 2],
    [-2, 0],
    [0, -2],
    [1, 3, 2],
    [0, 2, -1],
    ["1", "2"],
    [9, 0],
    [0, 9],
    [Number.NaN, 1, undefined],
  ];
  for (const range of ranges) {
    const s: any = select([1, 2, 3, 4], open);
    s.copyWithin(...range);
    assert.deepEqual(
      [...s],
      [1, 2, 3, 4].copyWithin(...(range as [number, number, number])),
    );
    s[CHAN].close();
  }
});

test("SE-09E a copy that changes nothing produces no flush", async () => {
  const log = opLog();
  const s: any = select([1, 2], { ...open, ...log });
  await setImmediate();
  log.ops.length = 0;
  assert.equal(s.copyWithin(1, 1), s);
  assert.equal(s.copyWithin(0, 1, 1), s);
  await setImmediate();
  assert.deepEqual(log.ops, []);
  s[CHAN].close();
});

test("SE-09E copyWithin restarts a copied promise as pending", async () => {
  const p = Promise.withResolvers<number>();
  const s: any = select([1, p.promise], { ...open, unwrap: true });
  const it = iter(s);
  await it.next();
  s.copyWithin(0, 1);
  p.resolve(7);
  await setImmediate();
  assert.deepEqual((await it.next()).value, [7, 7]);
  s[CHAN].close();
});

test("SE-09E on a terminal channel, copyWithin changes the proxy only", async () => {
  const log = opLog();
  const s: any = select([1, 2], { ...open, ...log });
  await setImmediate();
  s[CHAN].close();
  const count = log.ops.length;
  s.copyWithin(0, 1);
  assert.deepEqual([...s], [2, 2]);
  await setImmediate();
  assert.equal(log.ops.length, count);
});

test("SE-099 sort compares sources, with or without unwrap", async () => {
  const a = Promise.resolve(2),
    b = Promise.resolve(1);
  for (const unwrap of [false, true]) {
    const s: any = select([a, b], { ...open, unwrap } as any);
    await setImmediate();
    const seen: unknown[] = [];
    s.sort((x: unknown, y: unknown) => (seen.push(x, y), x === b ? -1 : 1));
    assert.ok(seen.every(item => item === a || item === b));
    assert.deepEqual([...s], [b, a]);
    s[CHAN].close();
  }
});

test("SE-09F sortOutputs compares outputs and restarts no source", async () => {
  const log = opLog();
  let pulls = 0;
  const source = {
    next: async () => {
      pulls++;
      return { done: pulls > 1, value: pulls > 1 ? undefined : 5 };
    },
  };
  const s: any = select([9, source, 1], { ...open, unwrap: true, ...log });
  await setImmediate();
  const pulled = pulls;
  assert.equal(
    s.sortOutputs((a: number, b: number) => a - b),
    s,
  );
  await setImmediate();
  assert.deepEqual(s[0], 1);
  assert.equal(s[1], source);
  assert.deepEqual(s[2], 9);
  assert.ok(pulls <= pulled + 1);
  assert.deepEqual(log.ops.at(-1), { op: "move", order: [2, 1, 0] });
  s[CHAN].close();
});

test("SE-09F sortOutputs passes Val outputs without unwrap", async () => {
  const s: any = select([Promise.resolve(2), Promise.resolve(1)], open);
  await setImmediate();
  const [two, one] = [...s];
  s.sortOutputs(
    (a: Val<number>, b: Val<number>) =>
      (a.value as number) - (b.value as number),
  );
  assert.deepEqual([...s], [one, two]);
  s[CHAN].close();
});

test("SE-09F sortOutputs moves undefined last in stable order, unseen by compare", async () => {
  const a = Promise.withResolvers<number>(),
    b = Promise.withResolvers<number>();
  const s: any = select([a.promise, 2, b.promise, 1], {
    ...open,
    unwrap: true,
  });
  await setImmediate();
  const seen: unknown[] = [];
  s.sortOutputs((x: number, y: number) => (seen.push(x, y), x - y));
  assert.deepEqual([...s], [1, 2, a.promise, b.promise]);
  assert.ok(!seen.includes(undefined));
  s[CHAN].close();
});

test("SE-099 sort matches Array.prototype.sort across merges", () => {
  let seed = 7;
  const next = (limit: number) => (seed = (seed * 31 + 17) % 1009) % limit;
  const items = Array.from({ length: 300 }, (_, index) => {
    const kind = next(4);
    if (kind === 0) return undefined;
    return kind === 1 ? `${next(40)}` : kind === 2 ? next(40) : index;
  });
  const s: any = select(items, open);
  s.sort();
  const expected = [...items].sort();
  for (const [index, item] of expected.entries()) assert.equal(s[index], item);
  const c: any = select(items, open);
  c.sort((a: unknown, b: unknown) => Number(a) - Number(b));
  const compared = [...items].sort((a, b) => Number(a) - Number(b));
  for (const [index, item] of compared.entries()) assert.equal(c[index], item);
  s[CHAN].close();
  c[CHAN].close();
});

test("SE-099 sort reads undefined on either side of a comparison", () => {
  for (const items of [
    [2, undefined, 1],
    [undefined, 2, undefined, 1],
    [1, 2, undefined],
  ]) {
    const seen: unknown[] = [];
    const s: any = select(items, open);
    s.sort((x: number, y: number) => (seen.push(x, y), x - y));
    assert.deepEqual([...s], [...items].sort());
    assert.ok(!seen.includes(undefined));
    s[CHAN].close();
  }
});

test("SE-099 sort keeps equal strings stable", () => {
  const s: any = select(["1", 1, "1", 1], open);
  s.sort();
  assert.deepEqual([...s], ["1", 1, "1", 1]);
  s[CHAN].close();
});

test("SE-099 sort without compare orders strings", () => {
  const s: any = select([10, 9, 10, undefined, 1], open);
  s.sort();
  assert.deepEqual([...s], [1, 10, 10, 9, undefined]);
  s[CHAN].close();
});

test("SE-099 sort rejects a bad comparator, and a failing one changes nothing", () => {
  const s: any = select([2, 1], open);
  for (const bad of [null, 1, {}]) assert.throws(() => s.sort(bad), TypeError);
  const error = new Error("x");
  assert.throws(
    () =>
      s.sort(() => {
        throw error;
      }),
    error,
  );
  assert.deepEqual([...s], [2, 1]);
  s[0] = 3; // The lock is released
  assert.deepEqual([...s], [3, 1]);
  s[CHAN].close();
});

test("SE-09F sortOutputs with no compare orders output strings", async () => {
  const s: any = select([Promise.resolve("b"), "a"], {
    ...open,
    unwrap: true,
  });
  await setImmediate();
  const [promise] = [...s];
  s.sortOutputs();
  assert.deepEqual([...s], ["a", promise]);
  s[CHAN].close();
});

test("SE-09F sortOutputs rejects a bad comparator and a mutating one", () => {
  const s: any = select([2, 1], open);
  for (const bad of [null, 1, {}])
    assert.throws(() => s.sortOutputs(bad), TypeError);
  let error: unknown;
  s.sortOutputs(() => {
    try {
      s.push(3);
    } catch (e) {
      error = e;
    }
    return 0;
  });
  assert.ok(error instanceof TypeError);
  assert.throws(
    () =>
      s.sort(() => {
        s.sortOutputs();
        return 0;
      }),
    TypeError,
  );
  s[CHAN].close();
});

test("SE-09F sortOutputs throws on a terminal channel and changes nothing", () => {
  const s: any = select([2, 1], open);
  s[CHAN].close();
  assert.throws(() => s.sortOutputs(), TypeError);
  assert.deepEqual([...s], [2, 1]);
});

test("SE-09F a comparator that closes the channel still sorts outputs", async () => {
  const s: any = select([2, 1], open);
  await setImmediate();
  s.sortOutputs((a: number, b: number) => (s[CHAN].close(), a - b));
  assert.deepEqual([...s], [1, 2]);
});

test("SE-09F sortOutputs is in an array state only", () => {
  const list: any = select([1], open),
    object: any = select({ a: 1 }, open);
  assert.ok("sortOutputs" in list);
  assert.ok(!("sortOutputs" in object));
  assert.equal(object.sortOutputs, undefined);
  list[CHAN].close();
  object[CHAN].close();
});

test("SE-09A a comparator cannot change the shape", () => {
  const s: any = select([2, 1, 3], open);
  const attempts = [
    () => (s[0] = 9),
    () => (s[9] = 9),
    () => s.push(9),
    () => s.pop(),
    () => s.reverse(),
    () => s.sort(),
    () => s.fill(9),
    () => s.copyWithin(0, 1),
    () => (s.length = 0),
    () => delete s[0],
  ];
  for (const attempt of attempts) {
    let error: unknown;
    s.sort(() => {
      try {
        attempt();
      } catch (e) {
        error = e;
      }
      return 0;
    });
    assert.ok(error instanceof TypeError);
  }
  assert.deepEqual([...s], [2, 1, 3]);
  s.sort(() => {
    s[0] = 2; // The same source changes nothing, so SE-087 holds
    s.splice(1, 0);
    return 0;
  });
  s[CHAN].close();
});

test("SE-09B reverse moves slots and returns the proxy", async () => {
  const log = opLog();
  const s: any = select([1, 2, 3], { ...open, ...log });
  await setImmediate();
  assert.equal(s.reverse(), s);
  await setImmediate();
  assert.deepEqual([...s], [3, 2, 1]);
  assert.deepEqual(log.ops.at(-1), { op: "move", order: [2, 1, 0] });
  assert.deepEqual(replay(log.ops, []), [3, 2, 1]);
  s[CHAN].close();
});

test("SE-09B a moved slot's updates reach its new index", async () => {
  const later = Promise.withResolvers<number>();
  const log = opLog();
  const s: any = select([later.promise, 1, 2], {
    ...open,
    unwrap: true,
    ...log,
  });
  await setImmediate();
  s.reverse();
  await setImmediate();
  later.resolve(7);
  await setImmediate();
  assert.deepEqual(log.ops.at(-1), {
    op: "set",
    key: 2,
    value: 7,
    prev: undefined,
  });
  assert.deepEqual(replay(log.ops, []), [2, 1, 7]);
  s[CHAN].close();
});

test("SE-09C a sort or reverse that changes nothing produces no flush", async () => {
  const log = opLog();
  const s: any = select([1, 2], { ...open, ...log });
  const single: any = select([1], { ...open, ...log });
  const it = iter(s);
  await it.next();
  await setImmediate();
  const count = log.ops.length;
  assert.equal(s.sort(), s);
  assert.equal(single.reverse(), single);
  const read = it.next();
  await setImmediate();
  assert.match(inspect(read), /pending/);
  assert.equal(log.ops.length, count);
  s[CHAN].close();
  single[CHAN].close();
});

test("SE-09C sort before start moves slots with no operation", async () => {
  const log = opLog();
  const s: any = select([2, 1], { ...log, autoClose: false });
  s.reverse();
  assert.deepEqual((await iter(s).next()).value, [1, 2]);
  assert.deepEqual(log.ops, [
    { op: "splice", start: 0, removed: [], added: [1, 2] },
  ]);
  s[CHAN].close();
});

test("SE-09C on a terminal channel, sort and reverse order sources", async () => {
  const log = opLog();
  const p = Promise.resolve(1);
  const s: any = select([2, p, 1], { ...open, ...log });
  await setImmediate();
  s[CHAN].close();
  const count = log.ops.length;
  s.push(0);
  s.sort(
    (a: unknown, b: unknown) =>
      Number(typeof a === "object") - Number(typeof b === "object") ||
      (a as number) - (b as number),
  );
  assert.deepEqual([...s], [0, 1, 2, p]);
  s.reverse();
  assert.deepEqual([...s], [p, 2, 1, 0]);
  await setImmediate();
  assert.equal(log.ops.length, count);
});

test("SE-09C a comparator that closes the channel still sorts the proxy", async () => {
  const log = opLog();
  const s: any = select([2, 1], { ...open, ...log });
  await setImmediate();
  s.sort((a: number, b: number) => (s[CHAN].close(), a - b));
  assert.deepEqual([...s], [1, 2]);
  assert.ok(!log.ops.some(op => op.op === "move"));
});

test("SE-09D fill replaces a range through one splice", async () => {
  const log = opLog();
  const s: any = select([1, 2, 3, 4], { ...open, ...log });
  await setImmediate();
  log.ops.length = 0;
  assert.equal(s.fill(0, 1, 3), s);
  await setImmediate();
  assert.deepEqual([...s], [1, 0, 0, 4]);
  assert.deepEqual(log.ops, [
    { op: "splice", start: 1, removed: [2, 3], added: [0, 0] },
  ]);
  s[CHAN].close();
});

test("SE-09D fill follows Array range rules", () => {
  const ranges = [
    [],
    [1],
    [-2],
    [1, -1],
    [3, 1],
    [-9, 9],
    ["1", "2"],
    [1.9, 2.9],
    [Number.NaN, undefined],
  ];
  for (const range of ranges) {
    const s: any = select([1, 2, 3], open);
    s.fill(0, ...range);
    assert.deepEqual([...s], [1, 2, 3].fill(0, ...(range as number[])));
    s[CHAN].close();
  }
});

test("SE-09D an empty fill changes nothing", async () => {
  const log = opLog();
  const s: any = select([1, 2], { ...open, ...log });
  await setImmediate();
  log.ops.length = 0;
  s.fill(0, 1, 1);
  await setImmediate();
  assert.deepEqual(log.ops, []);
  s[CHAN].close();
});

test("SE-09D SE-034 an empty fill leaves no unhandled rejection", async () => {
  const s: any = select([1, 2], open);
  s.fill(Promise.reject(new Error("x")), 1, 1);
  await setImmediate();
  s[CHAN].close();
});

test("SE-09D fill starts a promise source in each slot", async () => {
  const s: any = select([1, 2], { ...open, unwrap: true });
  const it = iter(s);
  await it.next();
  s.fill(Promise.resolve(7));
  await setImmediate();
  assert.deepEqual((await it.next()).value, [7, 7]);
  s[CHAN].close();
});

test("SE-043 changes in one tick schedule one flush", async () => {
  const s: any = select(
    { a: 1, p: new Promise(() => {}) },
    { stopStyle: "stop", unwrap: true },
  );
  const it = iter(s);
  await it.next();
  await setImmediate();
  delete s.p; // Nothing keeps the channel open, so a second flush would close it
  s.a = 2;
  await setImmediate();
  assert.deepEqual((await it.next()).value, { a: 2 });
});

test("SE-02B unwrap skips the snapshot for a finish that keeps the value", async () => {
  async function* gen() {
    yield 1;
    yield 2;
  }
  const seen: unknown[] = [];
  const log = opLog();
  for await (const v of select([gen()], { unwrap: true, ...log })) seen.push(v);
  assert.deepEqual(seen, [[undefined], [1], [2]]);
  assert.equal(log.ops.filter(op => op.op === "set").length, 2);
});

test("SE-02B unwrap still publishes a return value and a repeated value", async () => {
  async function* gen() {
    yield 1;
    yield 1;
    return 2;
  }
  const seen: unknown[] = [];
  for await (const v of select([gen()], { unwrap: true })) seen.push(v);
  assert.deepEqual(seen, [[undefined], [1], [1], [2]]);
});

test("SE-02B without unwrap the finish still publishes done", async () => {
  async function* gen() {
    yield 1;
  }
  const seen: boolean[] = [];
  for await (const [v] of select([gen()]) as any) seen.push(v.done);
  assert.deepEqual(seen, [false, false, true]);
});

test("SE-02B a skipped snapshot still reports other changes", async () => {
  const gate = Promise.withResolvers<void>();
  async function* gen() {
    yield 1;
    await gate.promise;
  }
  const s: any = select({ a: gen(), b: 1 }, { unwrap: true, autoClose: false });
  const it = iter(s);
  await it.next();
  assert.deepEqual((await it.next()).value, { a: 1, b: 1 });
  gate.resolve();
  await setImmediate();
  s.b = 2;
  assert.deepEqual((await it.next()).value, { a: 1, b: 2 });
  s[CHAN].close();
});

test("SE-132 slots sharing an iterator deal its values in pull order", async () => {
  async function* gen() {
    yield 1;
    yield 2;
    yield 3;
  }
  const it = gen();
  const seen: unknown[] = [];
  for await (const v of select([it, it], { unwrap: true })) seen.push(v);
  assert.deepEqual(seen.at(-1), [3, 2]);
});

test("SE-132 a Channel in two slots reaches both", async () => {
  const ch = new Channel<number>({ firstReceive: "first" });
  feed([1, 2], ch);
  const seen: unknown[] = [];
  for await (const v of select([ch, ch], { unwrap: true })) seen.push(v);
  assert.deepEqual(seen, [
    [undefined, undefined],
    [1, 1],
    [2, 2],
  ]);
});

test("SE-095 a non-index key throws on arrays", () => {
  const s: any = select([1], open);
  for (const key of ["x", "01", "-1", "1.5", Symbol("k"), String(2 ** 32 - 1)])
    assert.throws(() => (s[key] = 1), TypeError);
});

test("SE-096 SE-105 writing past the end grows with plain slots", async () => {
  const log = opLog();
  const s: any = select([1], { ...open, ...log });
  await setImmediate();
  log.ops.length = 0;
  s[3] = 4;
  s[4] = 5;
  await setImmediate();
  assert.deepEqual(log.ops, [
    { op: "splice", start: 1, removed: [], added: [undefined, undefined, 4] },
    { op: "splice", start: 4, removed: [], added: [5] },
  ]);
  assert.equal(s.length, 5);
});

test("SE-097 a no-op mutator produces no flush", async () => {
  const log: Op[][] = [];
  const s: any = select([], { ...open, onChanges: ops => void log.push(ops) });
  await setImmediate();
  const count = log.length;
  s.pop();
  s.shift();
  s.push();
  s.unshift();
  s.splice(0, 0);
  s.length = 0;
  await setImmediate();
  assert.equal(log.length, count);
});

test("SE-098 length writes follow Array", async () => {
  const log = opLog();
  const s: any = select([1, 2, 3], { ...open, ...log });
  await setImmediate();
  log.ops.length = 0;
  for (const bad of [-1, 1.5, "x", 2 ** 32])
    assert.throws(() => (s.length = bad), RangeError);
  s.length = 1;
  s.length = "3";
  await setImmediate();
  assert.deepEqual(log.ops, [
    { op: "splice", start: 1, removed: [2, 3], added: [] },
    { op: "splice", start: 1, removed: [], added: [undefined, undefined] },
  ]);
  assert.deepEqual([...s], [1, undefined, undefined]);
});

test("SE-100 SE-101 SE-103 SE-106 operations stay ordered and unmerged", async () => {
  const log = opLog();
  const s: any = select(["a", "b"], { ...open, ...log });
  await setImmediate();
  log.ops.length = 0;
  s[1] = "c";
  s[1] = "d";
  s.shift();
  s[0] = "e";
  await setImmediate();
  assert.deepEqual(log.ops, [
    { op: "set", key: 1, value: "c", prev: "b" },
    { op: "set", key: 1, value: "d", prev: "c" },
    { op: "splice", start: 0, removed: ["a"], added: [] },
    { op: "set", key: 0, value: "e", prev: "d" },
  ]);
});

test("SE-102 operations hold outputs", async () => {
  const log = opLog();
  const p = Promise.withResolvers<number>();
  const s: any = select([p.promise], { ...open, ...log });
  await setImmediate();
  s.unshift(0);
  p.resolve(1);
  await setImmediate();
  assert.deepEqual(log.ops, [
    { op: "splice", start: 0, removed: [], added: [pendingVal] },
    { op: "splice", start: 0, removed: [], added: [0] },
    { op: "set", key: 1, value: ok(1), prev: pendingVal },
  ]);
  const unwrapLog = opLog();
  const u: any = select(
    { a: Promise.resolve(1) },
    { ...open, unwrap: true, ...unwrapLog },
  );
  await setImmediate();
  u.a = new Promise(() => {});
  await setImmediate();
  assert.deepEqual(unwrapLog.ops, [
    { op: "set", key: "a", value: 1, prev: undefined },
    { op: "set", key: "a", value: undefined, prev: 1 },
  ]);
});

test("SE-103 a new object key produces set", async () => {
  const log = opLog();
  const s: any = select({}, { ...open, ...log });
  await setImmediate();
  s.a = 1;
  await setImmediate();
  assert.deepEqual(log.ops, [
    { op: "set", key: "a", value: 1, prev: undefined },
  ]);
});

test("SE-107 the first report describes the shape at start", async () => {
  const log = opLog();
  const s: any = select(
    { a: 1 },
    { ...log, backPressure: false, autoClose: false },
  );
  s.a = 2;
  s.b = 3;
  delete s.a;
  iter(s).next();
  await setImmediate();
  assert.deepEqual(log.ops, [
    { op: "set", key: "b", value: 3, prev: undefined },
  ]);
  const list = opLog();
  const l: any = select([1], {
    ...list,
    backPressure: false,
    autoClose: false,
  });
  l.push(2);
  iter(l).next();
  await setImmediate();
  assert.deepEqual(list.ops, [
    { op: "splice", start: 0, removed: [], added: [1, 2] },
  ]);
  s[CHAN].close();
  l[CHAN].close();
});

test("SE-107 an empty shape gets no operation", async () => {
  const log: Op[][] = [];
  const s: any = select([], { ...open, onChanges: ops => void log.push(ops) });
  await setImmediate();
  assert.deepEqual(log, []);
  s.push(1);
  await setImmediate();
  assert.deepEqual(log, [
    [{ op: "splice", start: 0, removed: [], added: [1] }],
  ]);
  s[CHAN].close();
});

test("SE-108 replay equals the outputs at each report", async () => {
  for (const unwrap of [false, true] as const) {
    const replayed: any[] = [];
    const seen: unknown[] = [];
    const s: any = select(
      [1, 2] as unknown[],
      {
        autoStart: true,
        autoClose: false,
        unwrap: unwrap as any,
        thenReceive: "every",
        firstReceive: "first",
        onChanges: (ops: Op[]) => void replay(ops, replayed),
        mapSnapshot: (snap: any) => (
          seen.push(structuredClone(snap)),
          assert.deepEqual([...replayed], [...snap]),
          snap
        ),
      } as any,
    );
    const it = iter(s);
    await it.next();
    s.push(Promise.resolve(3));
    s[0] = 9;
    await it.next();
    await setImmediate();
    s.splice(1, 1, "x", "y");
    s.length = 2;
    await it.next();
    s[CHAN].close();
  }
});

test("SE-109 onChanges runs for every flush, even if snapshots are skipped", async () => {
  const log: Op[][] = [];
  const s: any = select(
    { a: 1 },
    { ...open, onChanges: ops => void log.push(ops) },
  );
  await setImmediate();
  s.a = 2;
  await setImmediate();
  s.a = 3;
  await setImmediate();
  assert.equal(log.length, 3);
  s[CHAN].close();
});

test("SE-10A without onChanges no operation is built", async () => {
  const s: any = select([1, 2], open);
  await setImmediate();
  s.push(3);
  s[0] = 2;
  delete s[0];
  await setImmediate();
  assert.equal(s.length, 3);
  const o: any = select({ a: 1 }, open);
  await setImmediate();
  delete o.a;
  o.b = 1;
  await setImmediate();
  s[CHAN].close();
  o[CHAN].close();
});

test("SE-10B changes not yet reported at terminal stay unreported", async () => {
  const log = opLog();
  const s: any = select({ a: 1 }, { ...open, ...log });
  await setImmediate();
  log.ops.length = 0;
  s.a = 2;
  s[CHAN].close();
  await setImmediate();
  assert.deepEqual(log.ops, []);
});

test("SE-10B a terminal turn in step 2 stays unreported", async () => {
  const log: Op[][] = [];
  const failure = new Error("x");
  const s = select(
    {
      raw: {
        next() {
          throw failure;
        },
      },
    },
    { unwrap: true, autoStart: true, onChanges: ops => void log.push(ops) },
  );
  await setImmediate();
  assert.deepEqual(log, []);
  await assert.rejects(iter(s).next(), e => e === failure);
});

test("SE-110 callback errors reach channel.throw", async () => {
  const failure = new Error("x");
  await assert.rejects(
    iter(
      select(
        { a: 1 },
        {
          onChanges() {
            throw failure;
          },
        },
      ),
    ).next(),
    e => e === failure,
  );
  await assert.rejects(
    iter(
      select(
        { a: 1 },
        {
          mapSnapshot() {
            throw failure;
          },
        },
      ),
    ).next(),
    e => e === failure,
  );
});

test("SE-112 SE-113 a stop while publishing ends quietly", async () => {
  const s = select({ a: 1 }, { autoStart: true, autoClose: false });
  await setImmediate();
  s[CHAN].close();
  for (const backPressure of [true, false]) {
    const c: any = select(
      { a: 1 },
      {
        autoStart: true,
        backPressure,
        mapSnapshot: snap => (c[CHAN].close(), snap),
      },
    );
    await setImmediate();
    assert.ok(c[CHAN].signal.aborted);
    assert.equal((await iter(c).next()).done, true);
  }
});

test("SE-046 a flush stops before publish", async () => {
  let pulls = 0,
    mapped = 0;
  const source = {
    [Symbol.asyncIterator]: () => ({
      next() {
        pulls++;
        return new Promise(() => {});
      },
    }),
  };
  for (const nonYielding of [false, true]) {
    const s: any = select(
      { source },
      {
        autoStart: true,
        nonYielding,
        mapSnapshot: () => void mapped++,
        onChanges() {
          s[CHAN].close();
        },
      },
    );
    await setImmediate();
    assert.ok(s[CHAN].signal.aborted);
    assert.equal((await iter(s).next()).done, true);
  }
  assert.deepEqual([pulls, mapped], [0, 0]);
});

test("SE-046 a flush stops after a terminal publish wait", async () => {
  let pulls = 0;
  const source = {
    [Symbol.asyncIterator]: () => ({
      next() {
        pulls++;
        return new Promise(() => {});
      },
    }),
  };
  const s = select({ source }, { autoStart: true });
  await setImmediate();
  s[CHAN].close();
  await setImmediate();
  assert.equal(pulls, 0);
});

test("SE-046 a flush stops between iterators in step 1", async () => {
  let pulled = 0,
    reports = 0;
  const s: any = select(
    {
      a: {
        next() {
          s[CHAN].close();
          return { value: 1, done: false };
        },
      },
      b: {
        next() {
          pulled++;
          return { value: 1, done: false };
        },
      },
    },
    { ...open, onChanges: () => void reports++ },
  );
  await setImmediate();
  assert.equal(pulled, 0);
  assert.equal(reports, 0); // SE-10B
});

test("SE-046 a flush stops between iterators in step 4", async () => {
  let pulled = 0;
  const yielded = (next: () => void) => {
    let i = 0;
    return {
      next() {
        if (i++) next();
        return { value: Promise.resolve(i), done: false };
      },
    };
  };
  const s: any = select(
    { a: yielded(() => s[CHAN].close()), b: yielded(() => pulled++) },
    open,
  );
  await setImmediate();
  assert.ok(s[CHAN].signal.aborted);
  assert.equal(pulled, 0);
});

test("SE-046 a flush stops between iterators in step 5", async () => {
  let pulled = 0;
  const iterator = (next: () => void) => ({
    [Symbol.asyncIterator]: () => ({
      next() {
        next();
        return new Promise(() => {});
      },
    }),
  });
  const s: any = select(
    { a: iterator(() => s[CHAN].close()), b: iterator(() => pulled++) },
    open,
  );
  await setImmediate();
  assert.ok(s[CHAN].signal.aborted);
  assert.equal(pulled, 0);
});

test("SE-120 SE-121 terminal returns unfinished iterators, ignoring errors", async () => {
  const log: string[] = [];
  const pull = Promise.withResolvers<IteratorResult<number>>();
  const source = (name: string) => ({
    [Symbol.asyncIterator]: () => ({
      next: () => pull.promise,
      return() {
        log.push(name);
        throw new Error("x");
      },
    }),
  });
  const raw = {
    next: () => ({ value: 1, done: false }),
    return() {
      log.push("raw");
      return Promise.reject(new Error("y"));
    },
  };
  const finished = {
    next: () => ({ value: 1, done: true }),
    return() {
      log.push("finished");
    },
  };
  const noReturn = { next: () => ({ value: 1, done: false }) };
  const s = select(
    { a: source("a"), raw, finished, noReturn },
    { autoStart: true, backPressure: false, autoClose: false },
  );
  await setImmediate();
  s[CHAN].close();
  assert.deepEqual(log.sort(), ["a", "raw"]);
  pull.resolve({ value: 1, done: false });
  await setImmediate();
});

test("SE-122 a removed source is not closed", async () => {
  let returned = 0;
  const raw = {
    next: () => ({ value: 1, done: false }),
    return() {
      returned++;
    },
  };
  const s: any = select({ raw }, open);
  await setImmediate();
  s.raw = 1;
  s[CHAN].close();
  assert.equal(returned, 0);
});

test("SE-125 before start only the source's own return runs", () => {
  let returned = 0,
    factory = 0;
  const raw = {
    next() {},
    return() {
      returned++;
    },
  };
  const iterable = {
    [Symbol.asyncIterator]() {
      factory++;
      return raw;
    },
  };
  const s = select({ raw, iterable });
  s[CHAN].close();
  assert.equal(returned, 1);
  assert.equal(factory, 0);
});

test("SE-126 late results and rejections after terminal are discarded", async () => {
  const pull = Promise.withResolvers<any>(),
    other = Promise.withResolvers<any>(),
    yielded = Promise.withResolvers<number>();
  const log = opLog();
  const s = select(
    {
      a: { next: () => pull.promise },
      b: { next: () => other.promise },
      c: returning([{ value: yielded.promise, done: false }]),
    },
    { ...open, ...log },
  );
  await setImmediate();
  log.ops.length = 0;
  s[CHAN].close();
  pull.resolve({ value: Promise.reject(new Error("x")), done: false });
  other.reject(new Error("y"));
  yielded.reject(new Error("z"));
  await setImmediate();
  assert.deepEqual(log.ops, []);
});

test("SE-130 no consumer holds the flush at step 4", async () => {
  let pulls = 0;
  const source = {
    [Symbol.asyncIterator]() {
      return {
        next() {
          pulls++;
          return new Promise(() => {});
        },
      };
    },
  };
  const s = select({ source }, { autoStart: true });
  await setImmediate();
  assert.equal(pulls, 0);
  s[CHAN].close();
});

test("SE-131 break does not close", async () => {
  const s = select({ a: new Promise(() => {}) });
  for await (const _ of s) break;
  assert.ok(!s[CHAN].signal.aborted);
  s[CHAN].close();
});

test("SE-133 a late next consumer never reads the first publish", async () => {
  const s = select(
    { a: 1 },
    { autoStart: true, firstReceive: "next", thenReceive: "every" },
  );
  await setImmediate();
  const pending = iter(s).next();
  await setImmediate();
  s[CHAN].close();
  assert.equal((await pending).done, true);
});

test("SE-134 stop with no backPressure can drop the final snapshot", async () => {
  const s = select({ a: 1 }, { stopStyle: "stop", backPressure: false });
  assert.equal((await iter(s).next()).done, true);
});

test("SE-138 Array.prototype mutators follow the write rules", async () => {
  const s: any = select([1, 2, 3], open);
  await setImmediate();
  Array.prototype.push.call(s, 4);
  assert.deepEqual([...s], [1, 2, 3, 4]);
  assert.equal(Array.prototype.shift.call(s), 1);
  assert.deepEqual([...s], [2, 3, 4]);
  Array.prototype.reverse.call(s);
  assert.deepEqual([...s], [4, 3, 2]);
  s[CHAN].close();
});

test("SE-053 a plain slot holding a Val keeps it under unwrap", async () => {
  const held = (await iter(select({ a: Promise.resolve(1) })).next()).value.a;
  const s = select({ held }, { unwrap: true });
  assert.equal((await iter(s).next()).value.held, held);
});

test("SE-053 plain slots never fail the channel at start under unwrap", async () => {
  const lookalike = { status: "rejected", reason: "x" };
  const s = select({ lookalike, none: null }, { unwrap: true });
  assert.deepEqual((await iter(s).next()).value, { lookalike, none: null });
});

test("SE-089 deleting at length or a symbol on an array does nothing", async () => {
  const log = opLog();
  const s: any = select([1, 2], { ...open, ...log });
  await setImmediate();
  log.ops.length = 0;
  delete s[2];
  delete s[Symbol("k")];
  await setImmediate();
  assert.equal(s.length, 2);
  assert.deepEqual(log.ops, []);
  s[CHAN].close();
});

test("SE-089 deleting length reports failure as Array does", () => {
  const s: any = select([1], open);
  assert.equal(Reflect.deleteProperty(s, "length"), false);
  assert.equal(Reflect.deleteProperty(s, "other"), true);
  s[CHAN].close();
});

test("SE-08A SE-098 an invalid length throws on a terminal channel", () => {
  const s: any = select([1], open);
  s[CHAN].close();
  assert.throws(() => (s.length = -1), RangeError);
});

test("SE-090 a mutator read is one stable function", () => {
  const s: any = select([1], open),
    t: any = select([1], open);
  assert.equal(s.push, s.push);
  assert.notEqual(s.push, Array.prototype.push);
  assert.notEqual(s.push, t.push);
});

test("SE-097 re-adding a source through a mutator restarts it", async () => {
  const log = opLog();
  let pulls = 0;
  const raw = {
    next() {
      pulls++;
      return { value: 1, done: true };
    },
  };
  const s: any = select([raw], { ...open, ...log });
  await setImmediate();
  log.ops.length = 0;
  s.splice(0, 1, s[0]);
  await setImmediate();
  assert.equal(pulls, 2);
  assert.equal(log.ops[0].op, "splice");
  s[CHAN].close();
});

test("SE-043 a snapshot can include a change the next flush reports", async () => {
  const log: Op[][] = [];
  const seen: unknown[] = [];
  const s: any = select(
    { a: 1 },
    {
      ...open,
      mapSnapshot: snap => (seen.push({ ...snap }), snap),
      onChanges(ops) {
        log.push(ops);
        if (log.length === 1) s.b = 2;
      },
    },
  );
  await setImmediate();
  assert.deepEqual(seen[0], { a: 1, b: 2 });
  assert.deepEqual(log[1], [
    { op: "set", key: "b", value: 2, prev: undefined },
  ]);
  s[CHAN].close();
});

test("SE-124 an ignored result with a rejecting value is not unhandled", async () => {
  const pull = Promise.withResolvers<any>();
  const s: any = select({ raw: { next: () => pull.promise } }, open);
  await setImmediate();
  delete s.raw;
  pull.resolve({ value: Promise.reject(new Error("late")), done: false });
  await setImmediate();
  s[CHAN].close();
});

test("SE-025 a throwing then getter on a result fails with no return", async () => {
  const failure = new Error("x");
  let returned = 0;
  const raw = {
    next: () => ({
      get then() {
        throw failure;
      },
    }),
    return() {
      returned++;
    },
  };
  let last: any;
  for await (const value of select({ raw }) as any) last = value.raw;
  assert.deepEqual(last, bad(failure));
  assert.equal(returned, 0);
});

test("SE-036 an error reading next on the iterator rejects the slot", async () => {
  const failure = new Error("x");
  const source = {
    [Symbol.asyncIterator]: () => ({
      get next() {
        throw failure;
      },
    }),
  } as any;
  assert.deepEqual((await iter(select({ source })).next()).value, {
    source: bad(failure),
  });
});

test("SE-08A deleting a key added on a terminal channel succeeds", () => {
  const s: any = select({}, open);
  s[CHAN].close();
  s.a = 1;
  delete s.a;
  assert.ok(!("a" in s));
});

test("SE-097 SE-105 splice bounds", async () => {
  const log = opLog();
  const s: any = select([1, 2, 3], { ...open, ...log });
  await setImmediate();
  log.ops.length = 0;
  s.splice(3, 2);
  s.splice(3);
  await setImmediate();
  assert.deepEqual(log.ops, []);
  s.splice(-1, 1);
  await setImmediate();
  assert.deepEqual(log.ops, [
    { op: "splice", start: 2, removed: [3], added: [] },
  ]);
  s[CHAN].close();
});

test("SE-120 only iterators receive return", () => {
  let returned = 0;
  const count = () => {
    returned++;
  };
  const s = select(
    { plain: { return: count }, thenable: { then() {}, return: count } },
    open,
  );
  s[CHAN].close();
  assert.equal(returned, 0);
});

test("SE-124 a removed slot's rejecting yield does not close its iterator", async () => {
  let returned = 0;
  const gate = Promise.withResolvers<number>();
  const raw = returning([{ value: gate.promise, done: false }], {
    return() {
      returned++;
    },
  });
  const s: any = select({ raw }, open);
  await setImmediate();
  delete s.raw;
  gate.reject(new Error("x"));
  await setImmediate();
  assert.equal(returned, 0);
  s[CHAN].close();
});

test("Read-only array methods work through the proxy", () => {
  const s: any = select([1, 2], open);
  assert.deepEqual(
    s.map((v: number) => v * 2),
    [2, 4],
  );
  assert.equal(s.includes(2), true);
  assert.equal(JSON.stringify(s), "[1,2]");
});

test("spread as mapSnapshot", async () => {
  const p = Promise.withResolvers<number>();
  const s = select({ p: p.promise }, { mapSnapshot: spread });
  const it = iter(s);
  assert.deepEqual((await it.next()).value, {
    p: undefined,
    pLoading: true,
    pError: null,
    pDone: false,
  });
  p.resolve(42);
  assert.deepEqual((await it.next()).value, {
    p: 42,
    pLoading: false,
    pError: null,
    pDone: true,
  });
});

const size = 300_000;

test("SE-010 an array shape has no argument limit", { timeout: 3000 }, () => {
  const s = select(new Array(size).fill(0), { ...open, nonYielding: true });
  assert.equal(s.length, size);
  s[CHAN].close();
});

test("SE-098 a length write has no argument limit", {
  timeout: 3000,
}, async () => {
  const s = select([] as unknown[], { ...open, nonYielding: true });
  await setImmediate();
  s.length = size;
  assert.equal(s.length, size);
  s.length = 0;
  assert.equal(s.length, 0);
  s[CHAN].close();
  s.length = size;
  assert.equal(s.length, size);
});

test("SE-091 mutators have no argument limit", { timeout: 3000 }, async () => {
  const s = select([1, 2] as unknown[], { ...open, nonYielding: true });
  await setImmediate();
  s[size] = 3;
  assert.equal(s.length, size + 1);
  assert.deepEqual(
    s.splice(1, size - 1),
    new Array(size - 1).fill(undefined).with(0, 2),
  );
  assert.deepEqual([...s], [1, 3]);
  s[CHAN].close();
});

test("SE-034 a Promise with a non-callable then is a plain slot", async () => {
  const p: any = Promise.resolve(1);
  p.then = null;
  const s = select({ p }, open);
  assert.equal((await iter(s).next()).value.p, p);
  s[CHAN].close();
});

test("SE-034 SE-035 a Promise whose then throws rejects the slot", async () => {
  const boom = new Error("boom");
  const p: any = Promise.resolve(1);
  p.then = () => {
    throw boom;
  };
  let last: any;
  for await (const snap of select({ p })) last = snap;
  assert.deepEqual(last.p, bad(boom));
});

test("SE-034 SE-035 a mutator keeps a Promise whose then throws", async () => {
  const boom = new Error("boom");
  const p: any = Promise.resolve(1);
  p.then = () => {
    throw boom;
  };
  const { ops, onChanges } = opLog();
  const s = select([] as unknown[], { ...open, nonYielding: true, onChanges });
  await setImmediate();
  s.push(p);
  await setImmediate();
  assert.deepEqual(ops.at(-1), {
    op: "set",
    key: 0,
    value: bad(boom),
    prev: pendingVal,
  });
  s[CHAN].close();
});

test("SE-034 a Promise with a patched then is still handled", async () => {
  const p: any = Promise.reject(new Error("boom"));
  p.then = () => {};
  const s = select({ p }, open);
  await setImmediate();
  s[CHAN].close();
});

test("SE-035 a thenable borrowing Promise then rejects the slot", async () => {
  let last: any;
  for await (const snap of select({ p: { then: Promise.prototype.then } }))
    last = snap;
  assert.equal(last.p.status, "rejected");
  assert.ok(last.p.reason instanceof TypeError);
});

test("SE-017 a write or mutator that throws changes nothing", async () => {
  const boom = new Error("boom");
  const hostile = {
    get then() {
      throw boom;
    },
  };
  const { ops, onChanges } = opLog();
  const object = select({ a: 1 } as any, { ...open, onChanges });
  const array = select([1] as unknown[], { ...open, onChanges });
  await setImmediate();
  const before = ops.length;
  assert.throws(() => (object.a = hostile), boom);
  assert.throws(() => array.push(2, hostile), boom);
  assert.throws(() => (array[0] = hostile), boom);
  await setImmediate();
  assert.equal(object.a, 1);
  assert.deepEqual([...array], [1]);
  assert.equal(ops.length, before);
  object[CHAN].close();
  array[CHAN].close();
});

test("SE-081 a written key has a plain data descriptor", async () => {
  const s = select({} as Record<string, unknown>, open);
  await setImmediate();
  s.a = 1;
  assert.deepEqual(Object.getOwnPropertyDescriptor(s, "a"), {
    value: 1,
    writable: true,
    enumerable: true,
    configurable: true,
  });
  s[CHAN].close();
});
