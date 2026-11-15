import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { inspect } from "node:util";
import {
  applyOps,
  CHAN,
  Channel,
  catching,
  derive,
  type Op,
  select,
  spread,
} from "../src/index.ts";
import { REPORT } from "../src/select.ts";

const end = (value?: unknown) => ({ value, done: true });
const val = (value: unknown) => ({ value, done: false });
const isPending = (promise: Promise<unknown>) =>
  inspect(promise).includes("<pending>");
const noop = () => {};

test("HE-010 onError is required", () => {
  assert.throws(() => catching([1], undefined as any), TypeError);
});

test("HE-011 detection order and rejected kinds", async () => {
  for (const bad of ["abc", 1, null, undefined, {}] as any[])
    assert.throws(() => catching(bad, noop), TypeError);
  const thenFirst: any = {
    then: (ok: (v: number) => void) => ok(1),
    [Symbol.asyncIterator]: () => assert.fail(),
  };
  assert.deepEqual(await catching<number>(thenFirst, noop).next(), val(1));
  const asyncFirst: any = {
    async *[Symbol.asyncIterator]() {
      yield 2;
    },
    [Symbol.iterator]: () => assert.fail(),
  };
  assert.deepEqual(await catching<number>(asyncFirst, noop).next(), val(2));
  const syncFirst: any = {
    *[Symbol.iterator]() {
      yield 3;
    },
    next: () => assert.fail(),
  };
  assert.deepEqual(await catching<number>(syncFirst, noop).next(), val(3));
  assert.deepEqual(
    await catching<number>(
      { next: () => ({ value: 4, done: false }) },
      noop,
    ).next(),
    val(4),
  );
});

test("HE-01E detection errors propagate to the caller", () => {
  const failure = new Error("x");
  assert.throws(
    () =>
      catching(
        {
          get then() {
            throw failure;
          },
        } as any,
        noop,
      ),
    e => e === failure,
  );
});

test("HE-01E detection runs once, at the call", async () => {
  let reads = 0;
  const it = catching(
    {
      get then() {
        reads++;
        return (ok: (v: number) => void) => ok(1);
      },
    } as any,
    noop,
  );
  assert.equal(reads, 1);
  assert.deepEqual(await it.next(), val(1));
  assert.equal(reads, 1);
  let iterators = 0;
  const source: any = {
    get [Symbol.iterator]() {
      iterators++;
      return () => [1][Symbol.iterator]();
    },
  };
  const list = catching(source, noop);
  assert.equal(iterators, 1);
  await list.next();
  assert.equal(iterators, 1);
  let nexts = 0;
  const raw = catching(
    {
      get next() {
        nexts++;
        return () => ({ value: 1, done: false });
      },
    } as any,
    noop,
  );
  await raw.next();
  await raw.next();
  assert.equal(nexts, 1);
});

test("HE-012 a thenable yields one value", async () => {
  const it = catching(Promise.resolve(1), noop);
  assert.deepEqual(await it.next(), val(1));
  assert.deepEqual(await it.next(), end());
});

test("HE-013 HE-017 values and the return value are awaited", async () => {
  const it = catching(
    (function* () {
      yield Promise.resolve(1) as any;
      return Promise.resolve(2);
    })(),
    noop,
  );
  assert.deepEqual(await it.next(), val(1));
  assert.deepEqual(await it.next(), end(2));
});

test("HE-014 a failure calls onError once, then finishes", async () => {
  const failure = new Error("x");
  for (const source of [
    Promise.reject(failure),
    {
      next() {
        throw failure;
      },
    },
    { next: () => Promise.reject(failure) },
    { next: () => ({ value: Promise.reject(failure), done: false }) },
    { next: () => ({ value: Promise.reject(failure), done: true }) },
    {
      [Symbol.iterator]() {
        throw failure;
      },
    },
  ] as any[]) {
    const seen: unknown[] = [];
    const it = catching(source, error => {
      seen.push(error);
    });
    assert.deepEqual(await it.next(), end());
    assert.deepEqual(seen, [failure]);
    assert.deepEqual(await it.next(), end());
    assert.equal(seen.length, 1);
  }
});

test("HE-014 a non-object result is a TypeError failure", async () => {
  const seen: unknown[] = [];
  await catching({ next: () => 1 } as any, error => {
    seen.push(error);
  }).next();
  assert.ok(seen[0] instanceof TypeError);
});

test("HE-014 an error from reading done or value is a failure with no return", async () => {
  for (const key of ["done", "value"]) {
    const failure = new Error(key);
    const seen: unknown[] = [];
    let returned = 0;
    const result = Object.defineProperty({ done: false, value: 1 }, key, {
      get() {
        throw failure;
      },
    });
    const it = catching(
      {
        next: () => result,
        return() {
          returned++;
          return {};
        },
      } as any,
      error => {
        seen.push(error);
      },
    );
    assert.deepEqual(await it.next(), end());
    assert.deepEqual(seen, [failure]);
    assert.equal(returned, 0, key);
  }
});

test("HE-016 a throwing then getter on a value closes the iterator", async () => {
  let returned = 0;
  const value = {
    get then() {
      throw new Error("x");
    },
  };
  await catching(
    {
      next: () => ({ value, done: false }),
      return() {
        returned++;
        return {};
      },
    } as any,
    noop,
  ).next();
  assert.equal(returned, 1);
});

test("HE-015 an onError failure rejects next", async () => {
  const failure = new Error("y");
  const it = catching(
    {
      next() {
        throw new Error("x");
      },
    } as any,
    () => {
      throw failure;
    },
  );
  await assert.rejects(it.next(), e => e === failure);
  assert.deepEqual(await it.next(), end());
});

test("HE-016 a rejected value closes an open inner iterator, ignoring errors", async () => {
  let returned = 0;
  const value = (done: boolean) => ({
    next: () => ({ value: Promise.reject(new Error("x")), done }),
    return() {
      returned++;
      throw new Error("ignored");
    },
  });
  await catching(value(false) as any, noop).next();
  assert.equal(returned, 1);
  await catching(value(true) as any, noop).next();
  assert.equal(returned, 1);
  await catching(
    {
      next() {
        throw new Error("x");
      },
      return() {
        returned++;
      },
    } as any,
    noop,
  ).next();
  assert.equal(returned, 1);
});

test("HE-018 return forwards before the first next", async () => {
  const seen: unknown[] = [];
  const it = catching(
    {
      next: () => assert.fail(),
      return: (v: unknown) => (seen.push(v), { done: true, value: "inner" }),
    } as any,
    noop,
  );
  assert.deepEqual(await it.return("x"), end("inner"));
  assert.deepEqual(seen, ["x"]);
  assert.deepEqual(await it.next(), end());
  assert.deepEqual(await it.return("y"), end("y"));
  assert.equal(seen.length, 1);
});

test("HE-018 return without an inner return resolves with the value", async () => {
  let touched = 0;
  const iterable: any = {
    [Symbol.iterator]() {
      touched++;
      return [];
    },
  };
  assert.deepEqual(await catching(iterable, noop).return("x"), end("x"));
  assert.equal(touched, 0);
  const thenable: any = {
    then() {
      touched++;
    },
    return: () => assert.fail(),
  };
  assert.deepEqual(await catching(thenable, noop).return("y"), end("y"));
  assert.equal(touched, 0);
  const it = catching([1, 2], noop);
  await it.next();
  assert.deepEqual(await it.return("z"), end("z"));
});

test("HE-018 return settles as the inner return settles", async () => {
  const failure = new Error("x");
  const it = catching(
    {
      next: () => ({ value: 1, done: false }),
      return: () => Promise.reject(failure),
    } as any,
    noop,
  );
  await it.next();
  await assert.rejects(it.return(), e => e === failure);
});

test("HE-018 HE-01A return during a pending next resolves it at once", async () => {
  const pull = Promise.withResolvers<IteratorResult<number>>();
  let returned = 0,
    failed = 0;
  const it = catching<number>(
    {
      next: () => pull.promise,
      return() {
        returned++;
        return { done: true, value: "r" };
      },
    } as any,
    () => {
      failed++;
    },
  );
  const first = it.next(),
    second = it.next();
  await setImmediate();
  assert.deepEqual(await it.return(), end("r"));
  assert.equal(returned, 1);
  assert.deepEqual(await first, end());
  assert.deepEqual(await second, end());
  pull.reject(new Error("late"));
  await setImmediate();
  assert.equal(failed, 0);
  assert.deepEqual(await it.next(), end());
});

test("HE-01A a stuck pull does not block later calls", async () => {
  const it = catching<number>({ next: () => new Promise(noop) } as any, noop);
  const first = it.next();
  await it.return();
  assert.deepEqual(await first, end());
  assert.deepEqual(await it.next(), end());
});

test("HE-01A return discards a late value", async () => {
  const pull = Promise.withResolvers<IteratorResult<number>>();
  const it = catching<number>({ next: () => pull.promise } as any, noop);
  const first = it.next();
  await setImmediate();
  await it.return();
  pull.resolve({
    value: Promise.reject(new Error("late")) as any,
    done: false,
  });
  assert.deepEqual(await first, end());
  await setImmediate();
});

test("HE-019 a Promise is handled, and other thenables wait", async () => {
  catching(Promise.reject(new Error("x")), noop);
  let calls = 0;
  const it = catching(
    {
      then(ok: (v: number) => void) {
        calls++;
        ok(1);
      },
    } as any,
    noop,
  );
  await setImmediate();
  assert.equal(calls, 0);
  await it.next();
  assert.equal(calls, 1);
});

test("HE-01B finished wrapper answers fixed results", async () => {
  const it = catching([], noop);
  assert.deepEqual(await it.next(), end());
  assert.deepEqual(await it.next(), end());
  assert.deepEqual(await it.return("x"), end("x"));
});

test("HE-01B a finished wrapper never pulls again", async () => {
  let pulls = 0;
  const done = catching(
    {
      next() {
        pulls++;
        return { value: 1, done: true };
      },
    } as any,
    noop,
  );
  await done.next();
  await done.next();
  assert.equal(pulls, 1);
  const failed = catching(
    {
      next() {
        pulls++;
        throw new Error("x");
      },
    } as any,
    noop,
  );
  await Promise.all([failed.next(), failed.next()]);
  assert.equal(pulls, 2);
});

test("HE-018 an iterable with its own return receives it before the first next", async () => {
  const sync = (function* () {
      yield 1;
    })(),
    asynchronous = (async function* () {
      yield 1;
    })();
  await catching(sync, noop).return();
  await catching(asynchronous, noop).return();
  assert.equal(sync.next().done, true);
  assert.equal((await asynchronous.next()).done, true);
});

test("HE-01C overlapping next calls run in order, one pull at a time", async () => {
  let running = 0,
    peak = 0,
    n = 0;
  const source: any = {
    async next() {
      peak = Math.max(peak, ++running);
      await setImmediate();
      running--;
      return { value: ++n, done: false };
    },
  };
  const it = catching<number>(source, noop);
  const results = await Promise.all([it.next(), it.next(), it.next()]);
  assert.deepEqual(
    results.map(r => r.value),
    [1, 2, 3],
  );
  assert.equal(peak, 1);
});

test("HE-01D Caught has no throw, and iterates itself", () => {
  const it = catching([], noop);
  assert.equal("throw" in it, false);
  assert.equal(it[Symbol.asyncIterator](), it);
});

test("HE-01A return during onError leaves next with onError", async () => {
  const running = Promise.withResolvers<void>();
  const failure = new Error("y");
  const it = catching(
    {
      next() {
        throw new Error("x");
      },
    } as any,
    () =>
      running.promise.then(() => {
        throw failure;
      }),
  );
  const pending = it.next(),
    late = it.next();
  await setImmediate();
  assert.deepEqual(await it.return("v"), end("v"));
  assert.ok(isPending(pending));
  running.resolve();
  await assert.rejects(pending, e => e === failure);
  assert.deepEqual(await late, end());
});

test("HE-020 spread takes a Val by its brand only", async () => {
  const isVal = (value: unknown) => "xLoading" in spread({ x: value });
  const s = select(
    { a: Promise.resolve(1) },
    { autoClose: true, autoStart: true, backPressure: false },
  );
  const it = s[Symbol.asyncIterator]();
  const { value }: any = await it.next();
  assert.ok(isVal(value.a));
  assert.ok(!isVal({ ...value.a }));
  assert.ok(!isVal(Object.create(value.a)));
  assert.ok(
    !isVal({
      status: "pending",
      value: undefined,
      reason: undefined,
      done: false,
    }),
  );
  assert.ok(!isVal(null));
  assert.ok(!isVal(1));
  assert.ok(
    isVal(Object.defineProperty({}, Symbol.for("gg.Val"), { value: true })),
  );
});

const brand = <T extends object>(o: T) =>
  Object.freeze(
    Object.defineProperty(o, Symbol.for("gg.Val"), { value: true }),
  );
const pending = brand({
  status: "pending",
  value: undefined,
  reason: undefined,
  done: false,
}) as any;
const fulfilled = brand({
  status: "fulfilled",
  value: 42,
  reason: undefined,
  done: true,
}) as any;
const rejected = brand({
  status: "rejected",
  value: undefined,
  reason: "why",
  done: true,
}) as any;

test("HE-030 HE-031 HE-032 object snapshots", () => {
  const input = { p: pending, q: fulfilled, r: rejected, n: 1 };
  const copy = { ...input };
  assert.deepEqual(spread(input), {
    p: undefined,
    pLoading: true,
    pError: null,
    pDone: false,
    q: 42,
    qLoading: false,
    qError: null,
    qDone: true,
    r: undefined,
    rLoading: false,
    rError: "why",
    rDone: true,
    n: 1,
  });
  assert.deepEqual(input, copy);
});

test("HE-033 array snapshots use one frozen object per Val", () => {
  const [a, b, c] = spread([pending, 1, fulfilled]) as any[];
  assert.deepEqual(a, {
    value: undefined,
    loading: true,
    error: null,
    done: false,
  });
  assert.equal(b, 1);
  assert.deepEqual(c, { value: 42, loading: false, error: null, done: true });
  assert.ok(Object.isFrozen(a));
  assert.equal((spread([pending]) as any[])[0], a);
  assert.deepEqual((spread([rejected]) as any[])[0].error, "why");
});

test("HE-034 HE-035 other values and symbol keys copy unchanged", () => {
  const key = Symbol("k"),
    other = {};
  const out: any = spread({ other, [key]: pending });
  assert.equal(out.other, other);
  assert.equal(out[key], pending);
  assert.deepEqual(Object.keys(out), ["other"]);
});

test("HE-036 a colliding field throws", () => {
  for (const name of ["aLoading", "aError", "aDone"])
    assert.throws(() => spread({ a: pending, [name]: 1 }), TypeError);
  assert.throws(() => spread({ aLoading: pending, a: pending }), TypeError);
});

test("HE-037 a non-object snapshot returns unchanged", () => {
  const fn = () => {};
  for (const value of [null, undefined, 5, "x", fn])
    assert.equal(spread(value), value);
});

test("HE-031 a __proto__ key stays an own field", () => {
  const input = Object.fromEntries([["__proto__", pending]]);
  const out: any = spread(input);
  assert.equal(Object.getPrototypeOf(out), Object.prototype);
  assert.ok(Object.hasOwn(out, "__proto__"));
});

const eager = { eager: true };
const added = (start: number, ...values: unknown[]): Op => ({
  op: "splice",
  start,
  removed: [],
  added: values,
});

test("HE-040 replay follows order, works in place and returns target", () => {
  const target: unknown[] = [];
  const ops: Op[] = [
    added(0, "a", "b"),
    { op: "set", key: 1, value: "c", prev: "b" },
  ];
  assert.equal(applyOps(target, ops), target);
  assert.deepEqual(target, ["a", "c"]);
});

test("HE-040 a mirror equals the outputs of a real select", async () => {
  const mirror: number[] = [];
  const state = select([3, 1], {
    autoStart: true,
    autoClose: false,
    backPressure: false,
    [REPORT]: ops => applyOps(mirror, ops),
  });
  await setImmediate();
  state.push(2);
  state.sort();
  state.reverse();
  state.splice(1, 1, 7, 8);
  state[1] = 9;
  state.fill(4, 3);
  await setImmediate();
  assert.deepEqual(mirror, [...state]);
  state[Symbol.dispose]();
});

test("HE-041 set passes the own entry, and only an own one, as prev", () => {
  const seen: unknown[][] = [];
  const target: any = { a: "old" };
  const map = (value: unknown, prev: unknown) => (
    seen.push([value, prev]), `${value}!`
  );
  applyOps(
    target,
    [
      { op: "set", key: "a", value: 1, prev: undefined },
      { op: "set", key: "toString", value: 2, prev: undefined },
    ],
    map,
    eager,
  );
  assert.deepEqual(seen, [
    [1, "old"],
    [2, undefined],
  ]);
  assert.equal(target.a, "1!");
  assert.equal(target.toString, "2!");
});

test("HE-042 delete removes the key without map", () => {
  const target: Record<string, unknown> = { a: 1, b: 2 };
  const map = () => assert.fail("map ran");
  applyOps(target, [{ op: "delete", key: "a", prev: 1 }], map, eager);
  assert.deepEqual(target, { b: 2 });
});

test("HE-043 splice maps in order, pairing removed entries by match", () => {
  for (const [options, prevs] of [
    [eager, ["B", undefined, "A"]],
    [{ ...eager, key: (value: string) => value[0] }, ["B", "A", undefined]],
  ] as const) {
    const seen: unknown[][] = [];
    const target = ["x", "A", "B", "y"];
    applyOps(
      target,
      [
        {
          op: "splice",
          start: 1,
          removed: ["a", "b"],
          added: ["b", "a2", "a"],
        },
      ],
      (value, prev) => {
        seen.push([value, prev, target.length]);
        return value as string;
      },
      options,
    );
    assert.deepEqual(
      seen,
      ["b", "a2", "a"].map((value, i) => [value, prevs[i], 4]),
    );
    assert.deepEqual(target, ["x", "b", "a2", "a", "y"]);
  }
});

test("HE-044 splice takes more values than a call has arguments", () => {
  const values = Array.from({ length: 500_000 }, (_, index) => index);
  const target: number[] = [];
  for (const options of [eager, {}]) {
    target.length = 0;
    applyOps(
      target,
      [{ op: "splice", start: 0, removed: [], added: values }],
      undefined,
      options,
    );
    assert.equal(target.length, values.length);
    target.splice(0, Infinity, -1, -2);
    applyOps(
      target,
      [{ op: "splice", start: 1, removed: [], added: values }],
      undefined,
      options,
    );
    assert.deepEqual([target[0], target[1], target.at(-1)], [-1, 0, -2]);
    assert.equal(target.length, values.length + 2);
  }
});

test("HE-045 move reads each entry from order without map", () => {
  const target = ["a", "b", "c"];
  const map = () => assert.fail("map ran");
  applyOps(target, [{ op: "move", order: [2, 0, 1] }], map, eager);
  assert.deepEqual(target, ["c", "a", "b"]);
});

test("HE-046 a __proto__ key stays an own entry", () => {
  const target: any = {};
  const value = { polluted: true };
  const op: Op = { op: "set", key: "__proto__", value, prev: undefined };
  applyOps(target, [op], undefined, eager);
  assert.equal(Object.getPrototypeOf(target), Object.prototype);
  assert.equal(
    Object.getOwnPropertyDescriptor(target, "__proto__")?.value,
    value,
  );
  applyOps(
    target,
    [{ ...op, value: 2 }],
    (next, prev) => {
      assert.equal(prev, value);
      return next;
    },
    eager,
  );
  const entry = Object.getOwnPropertyDescriptor(target, "__proto__");
  assert.deepEqual(entry, {
    value: 2,
    writable: true,
    enumerable: true,
    configurable: true,
  });
});

test("HE-046 other keys stay plain assignments a reactive target sees", () => {
  for (const options of [eager, {}]) {
    const writes: PropertyKey[] = [];
    const target = new Proxy({} as any, {
      set(object, key, value) {
        writes.push(key);
        return Reflect.set(object, key, value);
      },
    });
    const op: Op = { op: "set", key: "a", value: 1, prev: undefined };
    applyOps(target, [op], undefined, options);
    assert.deepEqual(writes, ["a"]);
  }
});

test("HE-047 invalid arguments throw a TypeError", () => {
  for (const target of [null, 1, "x"])
    assert.throws(() => applyOps(target as any, []), TypeError);
  assert.throws(() => applyOps([], [], 1 as any), TypeError);
  assert.throws(
    () => applyOps([], [{ op: "x" } as any], undefined, eager),
    TypeError,
  );
  assert.throws(() => applyOps({}, [added(0, 1)], undefined, eager), TypeError);
  assert.throws(
    () => applyOps({}, [{ op: "move", order: [] }], undefined, eager),
    TypeError,
  );
});

test("HE-048 a map error keeps earlier operations only", () => {
  const failure = new Error("x");
  const target: number[] = [];
  const map = (value: unknown) => {
    if (value === 2) throw failure;
    return value as number;
  };
  assert.throws(
    () => applyOps(target, [added(0, 1), added(1, 3, 2)], map, eager),
    e => e === failure,
  );
  assert.deepEqual(target, [1]);
});

const tag = (seen: unknown[][]) => (value: unknown, prev: unknown) => (
  seen.push([value, prev]), `${value}!`
);
const set = (key: string | number, value: unknown): Op => ({
  op: "set",
  key,
  value,
  prev: undefined,
});
const drop = (key: string): Op => ({ op: "delete", key, prev: undefined });
const cut = (start: number, count: number, ...values: unknown[]): Op => ({
  op: "splice",
  start,
  removed: Array.from({ length: count }),
  added: values,
});

test("HE-049 another option key throws", () => {
  const target = ["a"];
  assert.throws(
    () => applyOps(target, [set(0, "x")], undefined, { other: 1 } as any),
    TypeError,
  );
  assert.deepEqual(target, ["a"]);
});

test("HE-049 eager must be a boolean", () => {
  assert.throws(
    () => applyOps([], [], undefined, { eager: 1 as any }),
    TypeError,
  );
});

test("HE-04A lazy matches an eager replay on arrays", () => {
  let seed = 7;
  const rand = (n: number) => (seed = (seed * 48271) % 2147483647) % n;
  for (let run = 0; run < 200; run++) {
    const start = Array.from({ length: rand(5) }, (_, i) => `s${i}`);
    const ops: Op[] = [];
    let size = start.length;
    for (let step = 0, id = 0; step < 8; step++) {
      const kind = rand(3);
      if (kind === 0 && size) ops.push(set(rand(size), `v${id++}`));
      else if (kind === 1 && size)
        ops.push({
          op: "move",
          order: Array.from({ length: size }, (_, i) => size - 1 - i),
        });
      else {
        const at = rand(size + 1),
          count = rand(size - at + 1);
        const values = Array.from({ length: rand(3) }, () => `v${id++}`);
        ops.push(cut(at, count, ...values));
        size += values.length - count;
      }
    }
    assert.deepEqual(
      applyOps([...start], ops, value => value as string),
      applyOps([...start], ops, value => value as string, eager),
    );
  }
});

test("HE-04A lazy keeps the key order of an eager replay", () => {
  const ops = [drop("a"), set("c", 1), set("a", 2), drop("b"), set("b", 3)];
  const stepped = applyOps({ a: 0, b: 0, k: 0 } as any, ops, undefined, eager);
  const folded = applyOps({ a: 0, b: 0, k: 0 } as any, ops);
  assert.deepEqual(Object.entries(folded), Object.entries(stepped));
});

test("HE-04B lazy maps only values that land, once, in index order", () => {
  const seen: unknown[][] = [];
  const target = applyOps(
    [] as string[],
    [
      cut(0, 0, "a", "b", "c"),
      set(0, "x"),
      set(0, "y"),
      cut(1, 1),
      { op: "move", order: [1, 0] },
    ],
    tag(seen),
  );
  assert.deepEqual(target, ["c!", "y!"]);
  assert.deepEqual(seen, [
    ["c", undefined],
    ["y", undefined],
  ]);
});

test("HE-04B lazy on an object maps the last set only, and a move skips map", () => {
  const seen: unknown[][] = [];
  const target: any = applyOps(
    { a: "A" } as any,
    [set("a", 1), set("a", 2), set("b", 3), drop("b")],
    tag(seen),
  );
  assert.deepEqual(target, { a: "2!" });
  assert.deepEqual(seen, [[2, "A"]]);
  const map = () => assert.fail("map ran");
  const list = applyOps(["a", "b"], [{ op: "move", order: [1, 0] }], map);
  assert.deepEqual(list, ["b", "a"]);
});

test("HE-04B lazy on an object maps in final key order", () => {
  const seen: unknown[] = [];
  const mark = (value: unknown) => (seen.push(value), value);
  const target: any = applyOps(
    { b: 0, a: 0, c: 0, 2: 0 } as any,
    [set("a", "a"), set("b", "b"), drop("c"), set("c", "c"), set("n", "n")],
    mark,
  );
  assert.deepEqual(seen, ["b", "a", "c", "n"]);
  assert.deepEqual(Object.keys(target), ["2", "b", "a", "c", "n"]);
  seen.length = 0;
  applyOps({ b: 0, 1: 0 } as any, [set("b", "b"), set(1, "one")], mark);
  assert.deepEqual(seen, ["one", "b"]);
});

test("HE-04B lazy keeps a symbol key after the string keys", () => {
  const key = Symbol();
  const target: any = applyOps({ a: 0 } as any, [set(key as any, 1)]);
  assert.deepEqual(Reflect.ownKeys(target), ["a", key]);
  assert.equal(target[key], 1);
});

test("HE-04C an update follows its entry through moves and repeat writes", () => {
  const seen: unknown[][] = [];
  const kept = (key: number, value: unknown, prev: unknown): Op => ({
    op: "set",
    key,
    value,
    prev,
    kept: true,
  });
  const target = applyOps(
    ["A", "B", "C"],
    [
      { op: "move", order: [2, 1, 0] },
      kept(0, "c2", "c"),
      kept(0, "c3", "c2"),
      splice(1, ["b", "a"], ["a", "x", "b"]),
    ],
    tag(seen),
  );
  assert.deepEqual(target, ["c3!", "A", "x!", "B"]);
  assert.deepEqual(seen, [
    ["c3", "C"],
    ["x", undefined],
  ]);
});

test("HE-04C a key removed and set again inherits its entry, once", () => {
  const seen: unknown[][] = [];
  applyOps(
    { a: "A", toString: "own" } as any,
    [
      drop("a"),
      drop("a"),
      set("a", 1),
      drop("a"),
      set("a", 2),
      set("valueOf", 3),
    ],
    tag(seen),
  );
  assert.deepEqual(seen, [
    [2, "A"],
    [3, undefined],
  ]);
  const fresh: unknown[][] = [];
  applyOps({} as any, [set("hasOwnProperty", 1)], tag(fresh));
  assert.deepEqual(fresh, [[1, undefined]]);
});

test("HE-04C a value that matches nothing takes over the entry that left its index, and one past the removed range has no prev", () => {
  const seen: unknown[][] = [];
  const target = applyOps(["A", "B"], [cut(0, 1, 1, 2)], tag(seen));
  assert.deepEqual(seen, [
    [1, "A"],
    [2, undefined],
  ]);
  assert.deepEqual(target, ["1!", "2!", "B"]);
});

test("HE-04C a set past the end has no prev", () => {
  const seen: unknown[][] = [];
  const target = applyOps(["a"], [set(1, "b")], tag(seen));
  assert.deepEqual(seen, [["b", undefined]]);
  assert.deepEqual(target, ["a", "b!"]);
});

test("HE-04D a lazy map error leaves target untouched", () => {
  const failure = new Error("x");
  const fail = () => {
    throw failure;
  };
  const list = ["a"];
  const ops = [cut(1, 0, "b"), cut(0, 1)];
  assert.throws(
    () => applyOps(list, ops, fail),
    e => e === failure,
  );
  assert.deepEqual(list, ["a"]);
  const object = { a: 1, b: 2 };
  assert.throws(
    () => applyOps(object, [drop("a"), set("b", 3)], fail),
    e => e === failure,
  );
  assert.deepEqual(object, { a: 1, b: 2 });
});

test("HE-04E lazy writes only the indexes that changed", () => {
  const writes: PropertyKey[] = [];
  const target = new Proxy(["a", "b", "c"], {
    set(list, key, value) {
      writes.push(key);
      return Reflect.set(list, key, value);
    },
  });
  applyOps(target, [set(1, "x")]);
  assert.deepEqual(writes, ["1"]);
  const back = (key: number, value: unknown, prev: unknown): Op => ({
    op: "set",
    key,
    value,
    prev,
  });
  applyOps(target, [back(0, "z", "a"), back(0, "a", "z"), back(2, "q", "c")]);
  assert.deepEqual(writes, ["1", "2"]);
  writes.length = 0;
  const grown = applyOps([] as unknown[], [set(0, undefined)]);
  assert.equal(grown.length, 1);
  assert.equal(applyOps(["a"] as unknown[], [set(1, undefined)]).length, 2);
  applyOps(target, [set(1, "y"), cut(3, 0)]);
  assert.deepEqual(writes, ["1"]);
});

test("HE-04B HE-04C HE-04H lazy sets map in index order, one time for each index that changes", () => {
  const calls: unknown[][] = [];
  const map = (value: unknown, prev: unknown) => {
    calls.push([value, prev]);
    return `${value}!`;
  };
  const was = (key: number, value: unknown, prev: unknown): Op => ({
    op: "set",
    key,
    value,
    prev,
  });
  const target = ["a", "b", "c"];
  target.length = 5;
  applyOps(
    target,
    [
      was(6, "g", undefined),
      was(2, "x", "c"),
      was(0, "y", "a"),
      was(2, "z", "x"),
      was(1, "q", "b"),
      was(1, "b", "q"),
      was(3, undefined, undefined),
    ],
    map,
  );
  // "b" comes back to index 1, so it keeps its entry, and the other values take over the entries of their indexes.
  assert.deepEqual(calls, [
    ["y", "a"],
    ["z", "c"],
    [undefined, undefined],
    ["g", undefined],
  ]);
  assert.deepEqual(
    [...target],
    ["y!", "b", "z!", "undefined!", undefined, undefined, "g!"],
  );
  assert.equal(4 in target, false);
});

test("HE-04D HE-04F lazy sets leave the target unchanged after a misfit or a map error", () => {
  const target = ["a", "b"];
  assert.throws(() => applyOps(target, [set(0, "x"), set(-1, "y")]), TypeError);
  const failure = new Error("map");
  assert.throws(
    () =>
      applyOps(target, [set(0, "x"), set(1, "y")], value => {
        if (value === "y") throw failure;
        return value as string;
      }),
    e => e === failure,
  );
  assert.deepEqual(target, ["a", "b"]);
});

test("HE-04E lazy stores an undefined entry, and shrinks the target", () => {
  const grown = applyOps([] as unknown[], [cut(0, 0, undefined)], undefined);
  assert.ok(Object.hasOwn(grown, 0));
  const empty = applyOps(["a", "b"], [cut(0, 2)]);
  assert.equal(empty.length, 0);
});

test("HE-04G lazy treats a hole as an undefined entry, as eager does", () => {
  const sparse = (length: number, entries: object) => {
    const list: unknown[] = [];
    list.length = length;
    return Object.assign(list, entries);
  };
  const replay = (target: unknown[], ops: Op[], options?: { eager: boolean }) =>
    Array.from(applyOps(target.slice(), ops, undefined, options));
  const cases: [unknown[], Op[]][] = [
    [sparse(2, { 1: 1 }), [{ op: "move", order: [1, 0] }]],
    [
      sparse(3, { 0: 1, 2: 2 }),
      [{ op: "splice", start: 0, removed: [1], added: [] }],
    ],
    [[], [set(2, 1), { op: "splice", start: 0, removed: [], added: ["a"] }]],
    [
      sparse(2, { 1: 1 }),
      [
        { op: "move", order: [1, 0] },
        { op: "splice", start: 1, removed: [undefined], added: ["a"] },
      ],
    ],
  ];
  for (const [target, ops] of cases)
    assert.deepEqual(replay(target, ops), replay(target, ops, eager));
  const seen: unknown[] = [];
  applyOps(sparse(2, { 1: "a" }), [{ op: "move", order: [1, 0] }], value => {
    seen.push(value);
    return value;
  });
  assert.deepEqual(seen, []);
});

test("HE-04A a splice that shrinks the array moves the end that later operations touch", () => {
  const ops = [cut(0, 2), set(1, "v")];
  assert.deepEqual(applyOps(["a", "b", "c", "d"], ops), ["c", "v"]);
  const grown = [cut(0, 0, "x", "y"), set(5, "v")];
  assert.deepEqual(applyOps(["a", "b", "c", "d"], grown), "xyabcv".split(""));
});

test("HE-04I lazy reads only the indexes between the first and the last that operations touch", () => {
  const reads = new Set<number>();
  const watched = (list: unknown[]) => {
    reads.clear();
    const read = (key: PropertyKey) =>
      typeof key === "string" && /^\d+$/.test(key) && reads.add(+key);
    return new Proxy(list, {
      get: (target, key) => (read(key), Reflect.get(target, key)),
      has: (target, key) => (read(key), Reflect.has(target, key)),
      getOwnPropertyDescriptor: (target, key) => (
        read(key), Reflect.getOwnPropertyDescriptor(target, key)
      ),
    });
  };
  const list = watched(["a", "b", "c", "d", "e"]);
  applyOps(list, [cut(1, 1, "x"), set(2, "y")]);
  assert.deepEqual([...reads].sort(), [1, 2]);
  assert.deepEqual([...list], ["a", "x", "y", "d", "e"]);
  applyOps(watched(["a", "b", "c", "d", "e"]), [set(1, "x"), set(3, "y")]);
  assert.deepEqual([...reads].sort(), [1, 3]);
});

test("HE-04F an index ends below the maximum array length", () => {
  const list: unknown[] = [];
  applyOps(list, [set(2 ** 32 - 2, 1)], undefined, eager);
  assert.equal(list.length, 2 ** 32 - 1);
  for (const options of [{}, eager])
    assert.throws(
      () => applyOps([], [set(2 ** 32 - 1, 1)], undefined, options),
      TypeError,
    );
});

test("HE-04F an operation that does not fit throws", () => {
  const list = ["a"];
  for (const options of [{}, eager]) {
    for (const key of ["x", "0", -1, 0.5, Symbol()])
      assert.throws(
        () => applyOps(list, [set(key as any, 1)], undefined, options),
        TypeError,
      );
    assert.throws(
      () => applyOps(list, [drop("0")], undefined, options),
      TypeError,
    );
    assert.throws(
      () => applyOps(list, [drop(0 as any)], undefined, options),
      TypeError,
    );
    assert.throws(
      () => applyOps({}, [cut(0, 0)], undefined, options),
      TypeError,
    );
    assert.throws(
      () => applyOps({}, [{ op: "move", order: [] }], undefined, options),
      TypeError,
    );
  }
  assert.deepEqual(list, ["a"]);
  assert.deepEqual(Reflect.ownKeys(list), ["0", "length"]);
});

test("HE-04A a __proto__ key stays an own entry under lazy", () => {
  const target: any = applyOps({} as any, [set("__proto__", 1)], undefined);
  assert.equal(Object.getPrototypeOf(target), Object.prototype);
  assert.ok(Object.hasOwn(target, "__proto__"));
});

const splice = (start: number, removed: unknown[], added: unknown[]): Op => ({
  op: "splice",
  start,
  removed,
  added,
});

test("HE-04H a splice that keeps values moves their entries, and maps only new values", () => {
  const seen: unknown[][] = [];
  const target = applyOps(
    ["a!", "b!", "c!"],
    [splice(0, ["a", "b", "c"], ["c", "a", "x"])],
    tag(seen),
  );
  assert.deepEqual(target, ["c!", "a!", "x!"]);
  assert.deepEqual(seen, [["x", undefined]]);
});

test("HE-04H equal values take entries in leaving order, and -0 differs from 0", () => {
  const target = applyOps(
    ["d1", "d2", "zero", "minus"],
    [splice(0, ["d", "d", 0, -0], [-0, "d", 0, "d"])],
    () => assert.fail("map runs"),
  );
  assert.deepEqual(target, ["minus", "d1", "zero", "d2"]);
});

test("HE-04H a value that left is taken over by its match, and not by position", () => {
  const seen: unknown[][] = [];
  const target = applyOps(
    ["a!"],
    [splice(0, ["a"], ["x"]), splice(1, [], ["a"])],
    tag(seen),
  );
  assert.deepEqual(target, ["x!", "a!"]);
  assert.deepEqual(seen, [["x", undefined]]);
});

test("HE-04H a value traces back through sets, and reuses an entry with the same output", () => {
  const seen: unknown[][] = [];
  const update = (key: number, value: unknown, prev: unknown): Op => ({
    op: "set",
    key,
    value,
    prev,
    ...(key === 0 && { kept: true as const }),
  });
  const target = applyOps(
    ["a!", "b!", "c!"],
    [
      update(0, "a2", "a"),
      splice(0, ["a2", "b"], ["b", "a2"]),
      update(2, "x", "c"),
      update(2, "c", "x"),
    ],
    tag(seen),
  );
  assert.deepEqual(target, ["b!", "a2!", "c!"]);
  assert.deepEqual(seen, [["a2", "a!"]]);
});

test("HE-04H two sets that swap values move their entries, with no map", () => {
  const a = { id: 1 },
    b = { id: 2 },
    seen: unknown[][] = [];
  const target = applyOps(
    ["A", "x", "B"],
    [
      { op: "set", key: 0, value: b, prev: a },
      { op: "set", key: 2, value: a, prev: b },
    ],
    tag(seen),
  );
  assert.deepEqual(target, ["B", "x", "A"]);
  assert.deepEqual(seen, []);
});

test("HE-04H a set of a new value takes over the entry at its index, and a set of the same value updates it", () => {
  const a = { id: 1 },
    copy = { ...a },
    seen: unknown[][] = [];
  const target = applyOps(
    ["A", "B"],
    [
      { op: "set", key: 0, value: copy, prev: a },
      { op: "set", key: 1, value: "b", prev: "b" },
    ],
    (value, prev) => (seen.push([value, prev]), "new"),
  );
  assert.deepEqual(target, ["new", "new"]);
  assert.deepEqual(seen, [
    [copy, "A"],
    ["b", "B"],
  ]);
});

test("HE-04H with key, a value takes over the entry with its key, and a new key replaces", () => {
  const key = (row: { id: number }) => row.id,
    rows = [1, 2, 3].map(id => ({ id, v: 0 })),
    seen: unknown[][] = [];
  const map = (value: any, prev: unknown) => (
    seen.push([value.id, prev]), `${value.id}:${value.v}`
  );
  for (const options of [{ key }, { key, eager: true }]) {
    seen.length = 0;
    const target = applyOps(
      ["1", "2", "3"],
      [
        { op: "set", key: 0, value: { id: 1, v: 1 }, prev: rows[0] },
        { op: "set", key: 1, value: { id: 9, v: 0 }, prev: rows[1] },
        splice(2, [rows[2]], [{ id: 3, v: 2 }]),
      ],
      map,
      options,
    );
    assert.deepEqual(target, ["1:1", "9:0", "3:2"]);
    assert.deepEqual(seen, [
      [1, "1"],
      [9, undefined],
      [3, "3"],
    ]);
  }
  // With key, a value with the same output and key moves its entry, with no map.
  const target = applyOps(
    ["1", "2"],
    [splice(0, rows.slice(0, 2), [rows[1], rows[0]])],
    () => assert.fail("map ran"),
    { key },
  );
  assert.deepEqual(target, ["2", "1"]);
});

test("HE-04H an update claims its entry, so a value that matches the output it left with takes no entry", () => {
  const seen: unknown[][] = [];
  const target = applyOps(
    ["A"],
    [
      { op: "set", key: 0, value: "a2", prev: "a", kept: true },
      splice(1, [], ["a"]),
    ],
    tag(seen),
  );
  assert.deepEqual(target, ["a2!", "a!"]);
  assert.deepEqual(seen, [
    ["a2", "A"],
    ["a", undefined],
  ]);
});

test("HE-04H HE-04I a set past the end leaves no entry for another value to match", () => {
  for (const past of [1, 2]) {
    const seen: unknown[][] = [];
    applyOps(
      ["A"],
      [
        { op: "set", key: past, value: "x", prev: undefined },
        { op: "set", key: 0, value: undefined, prev: "a" },
      ],
      tag(seen),
    );
    assert.deepEqual(seen, [
      [undefined, "A"],
      ["x", undefined],
    ]);
  }
});

test("HE-041 under eager, an array set without key passes the entry at its index", () => {
  const seen: unknown[][] = [];
  applyOps(
    ["A"],
    [{ op: "set", key: 0, value: "x", prev: "a" }],
    tag(seen),
    eager,
  );
  assert.deepEqual(seen, [["x", "A"]]);
});

test("HE-049 key must be a function", () => {
  for (const key of [1, "id", null])
    assert.throws(() => applyOps([], [], undefined, { key } as any), TypeError);
});

test("HE-050 derive checks its source and map", () => {
  for (const source of [null, 1, [1], { next() {} }])
    assert.throws(() => derive(source as any, String), {
      name: "TypeError",
      message: "derive source is not an async iterable",
    });
  assert.throws(() => derive(new Channel(), 1 as any), {
    name: "TypeError",
    message: "derive map must be a function",
  });
});

test("HE-051 HE-052 derive maps each value in order, awaits a thenable result, and opens the source at the first next", async () => {
  let opened = 0;
  const source = {
    [Symbol.asyncIterator]: async function* () {
      opened++;
      yield 1;
      yield 2;
    },
  };
  const it = derive(source, n => (n === 1 ? Promise.resolve("a") : "b"));
  await setImmediate();
  assert.equal(opened, 0);
  assert.deepEqual(await it.next(), val("a"));
  assert.deepEqual(await it.next(), val("b"));
  assert.deepEqual(await it.next(), end());
  assert.equal(opened, 1);
});

test("HE-052 derive rejects with the error of the source or of map", async () => {
  const error = new Error("x");
  const failing = {
    [Symbol.asyncIterator]: async function* () {
      yield 1;
      throw error;
    },
  };
  const it = derive(failing, n => n);
  await it.next();
  await assert.rejects(it.next(), error);
  const ch = new Channel<number>();
  ch.send(1);
  await assert.rejects(
    derive(ch, () => {
      throw error;
    }).next(),
    error,
  );
});

test("HE-053 return calls return on the iterator of the source one time, and awaits it", async () => {
  let returned = 0;
  const gate = Promise.withResolvers<void>();
  const source = {
    [Symbol.asyncIterator]: () => ({
      next: async () => ({ value: 1, done: false }),
      return: async () => (
        returned++, await gate.promise, { value: undefined, done: true }
      ),
    }),
  };
  const it = derive(source, n => n);
  await it.next();
  const first = it.return();
  assert.equal(returned, 1);
  await setImmediate();
  assert.ok(isPending(first));
  gate.resolve();
  assert.deepEqual(await first, end());
  assert.deepEqual(await it.return(), end());
  assert.equal(returned, 1);
  assert.deepEqual(await it.next(), end());
});

test("HE-053 return before the first next does not open the source, and a source with no return finishes", async () => {
  let opened = 0;
  const source = {
    [Symbol.asyncIterator]: () => (
      opened++, { next: async () => ({ value: 1, done: false }) }
    ),
  };
  const early = derive(source, n => n);
  assert.deepEqual(await early.return(), end());
  assert.deepEqual(await early.next(), end());
  assert.equal(opened, 0);
  const it = derive(source, n => n);
  assert.deepEqual(await it.next(), val(1));
  assert.deepEqual(await it.return(), end());
  assert.deepEqual(await it.next(), end());
});

test("HE-055 return during a pending next returns the source at once, finishes each pending next, and discards the late value", async () => {
  const late = Promise.withResolvers<IteratorResult<number>>();
  let maps = 0,
    returned = 0;
  const slow = {
    [Symbol.asyncIterator]: () => ({
      next: () => late.promise,
      return: async () => (returned++, { value: undefined, done: true }),
    }),
  };
  const it = derive(slow, n => (maps++, n));
  const first = it.next(),
    second = it.next();
  await setImmediate();
  assert.ok(isPending(first));
  const stopped = it.return();
  assert.equal(returned, 1);
  assert.deepEqual(await first, end());
  assert.deepEqual(await second, end());
  assert.deepEqual(await stopped, end());
  const after = it.next(); // The old read of the source still pends
  late.resolve({ value: 1, done: false });
  assert.deepEqual(await after, end());
  await setImmediate();
  assert.equal(maps, 0);
});

test("HE-055 return discards a late failure of the source and a late result of map", async () => {
  const late = Promise.withResolvers<IteratorResult<number>>();
  let returned = 0;
  const failing = {
    [Symbol.asyncIterator]: () => ({
      next: () => late.promise,
      return: async () => (returned++, { value: undefined, done: true }),
    }),
  };
  const it = derive(failing, n => n);
  const read = it.next();
  await it.return();
  late.reject(new Error("late"));
  assert.deepEqual(await read, end());
  await setImmediate();
  assert.equal(returned, 1);
  const mapped = Promise.withResolvers<string>();
  const ch = new Channel<number>();
  ch.send(1);
  const slow = derive(ch, () => mapped.promise);
  const pending = slow.next();
  await setImmediate();
  await slow.return();
  mapped.resolve("x");
  assert.deepEqual(await pending, end());
});

test("HE-056 next calls queue in order, and each call after the finish gives done", async () => {
  const ch = new Channel<number>();
  const it = derive(ch, n => n * 2);
  const reads = [it.next(), it.next(), it.next(), it.next()];
  ch.send(1);
  ch.send(2);
  ch.close();
  assert.deepEqual(await Promise.all(reads), [val(2), val(4), end(), end()]);
  assert.deepEqual(await it.next(), end());
  assert.equal(it[Symbol.asyncIterator](), it);
});

test("HE-057 a throw of map returns the source, and a failure of the source does not", async () => {
  const error = new Error("x");
  let returned = 0,
    fail = false;
  const source = {
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        if (fail) throw error;
        return { value: 1, done: false };
      },
      return: async () => {
        returned++;
        throw new Error("ignored");
      },
    }),
  };
  const it = derive(source, () => {
    throw error;
  });
  await assert.rejects(it.next(), error);
  assert.equal(returned, 1);
  assert.deepEqual(await it.next(), end());
  assert.deepEqual(await it.return(), end());
  assert.equal(returned, 1);
  fail = true;
  const other = derive(source, n => n);
  await assert.rejects(other.next(), error);
  assert.equal(returned, 1);
});

test("HE-058 await using returns the derive at the end of its scope", async () => {
  const ch = new Channel<number>();
  ch.send(1);
  let seen: Promise<IteratorResult<number, void>>;
  {
    await using it = derive(ch, n => n);
    assert.deepEqual(await it.next(), val(1));
    seen = it.next();
  }
  assert.deepEqual(await seen, end());
});

test("HE-054 derive with a key maps the outputs of that slot, only when it changes", async () => {
  const s = select({ a: 1, b: 1 });
  const calls: number[] = [];
  const it = derive(s, "a", a => (calls.push(a), a * 10));
  assert.deepEqual(await it.next(), { done: false, value: 10 });
  s.b = 2;
  await setImmediate();
  s.a = 2;
  assert.deepEqual(await it.next(), { done: false, value: 20 });
  assert.deepEqual(calls, [1, 2]);
  s[CHAN].close();
  assert.deepEqual(await it.next(), end());
});

test("HE-050 HE-054 derive with a key checks the map, the state and the key", () => {
  assert.throws(() => derive(select({ a: 1 }), "a" as any, undefined as any), {
    name: "TypeError",
    message: "derive map must be a function",
  });
  assert.throws(() => derive(new Channel() as any, "a", String), {
    name: "TypeError",
    message: "watch needs a select proxy",
  });
  assert.throws(() => derive(select({ a: 1 }), {} as any, String), {
    name: "TypeError",
    message: "An object slice takes property keys",
  });
});
