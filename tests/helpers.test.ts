import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { inspect } from "node:util";
import { abortable, catching, isVal, select, spread } from "../src/index.ts";

const end = (value?: unknown) => ({ value, done: true });
const val = (value: unknown) => ({ value, done: false });
const isPending = (promise: Promise<unknown>) =>
  inspect(promise).includes("<pending>");
const noop = () => {};

const listening = (signal: AbortSignal) =>
  getEventListeners(signal, "abort").length;

test("HE-001 settles as the promise settles", async () => {
  const { signal } = new AbortController();
  assert.equal(await abortable(Promise.resolve(1), signal), 1);
  const failure = new Error("x");
  await assert.rejects(
    abortable(Promise.reject(failure), signal),
    e => e === failure,
  );
});

test("HE-002 HE-005 an abort wins, and a late rejection is handled", async () => {
  const control = new AbortController();
  const source = Promise.withResolvers<number>();
  const result = abortable(source.promise, control.signal);
  control.abort("why");
  await assert.rejects(result, e => e === "why");
  source.reject(new Error("late"));
  await setImmediate();
});

test("HE-003 HE-005 an aborted signal rejects without calling then", async () => {
  const signal = AbortSignal.abort("why");
  let calls = 0;
  await assert.rejects(
    abortable(
      {
        then() {
          calls++;
        },
      } as any,
      signal,
    ),
    e => e === "why",
  );
  assert.equal(calls, 0);
  await assert.rejects(
    abortable(Promise.reject(new Error("x")), signal),
    e => e === "why",
  );
  await setImmediate();
});

test("HE-004 the listener goes once settled", async () => {
  const control = new AbortController();
  const running = abortable(new Promise(noop), control.signal);
  assert.equal(listening(control.signal), 1);
  await abortable(Promise.resolve(1), control.signal);
  await abortable(Promise.reject(new Error("x")), control.signal).catch(noop);
  const failure = new Error("y");
  await assert.rejects(
    abortable(
      {
        then() {
          throw failure;
        },
      } as any,
      control.signal,
    ),
    e => e === failure,
  );
  await setImmediate();
  assert.equal(listening(control.signal), 1);
  control.abort("why");
  await assert.rejects(running, e => e === "why");
  await setImmediate();
  assert.equal(listening(control.signal), 0);
});

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

test("HE-020 isVal reads the brand only", async () => {
  const s = select(
    { a: Promise.resolve(1) },
    { autoStart: true, backPressure: false },
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
