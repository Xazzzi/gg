import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { Channel, feed, type Source, StopError } from "../src/index.ts";

const collect = globalThis.gc as () => void; // --expose-gc is in the test command
const noop = () => {};
const iter = <T, R>(ch: Channel<T, R>) => ch[Symbol.asyncIterator]();
const all = async <T, R>(ch: Channel<T, R>) => {
  const out: T[] = [];
  for await (const value of ch) out.push(value);
  return out;
};
const every = <T>() =>
  new Channel<T>({ firstReceive: "first", thenReceive: "every" });

const raw = (results: unknown[], extra: object = {}) => {
  let i = 0;
  return { calls: { returned: 0 }, next: () => results[i++], ...extra } as any;
};

test("FE-001 defaults wait for a consumer, close, and use asend", async () => {
  const ch = every<number>();
  const log: string[] = [];
  const run = feed(
    (function* () {
      log.push("pulled");
      yield 1;
    })(),
    ch,
  );
  await setImmediate();
  assert.deepEqual(log, []);
  assert.deepEqual(await all(ch), [1]);
  assert.equal(await run, undefined);
  assert.ok(ch.signal.aborted);
});

test("FE-002 feed adds nothing to Channel", () => {
  assert.equal("feed" in Channel.prototype, false);
});

test("FE-010 detection order", async () => {
  const both: any = {
    then: (ok: (v: number) => void) => ok(1),
    [Symbol.asyncIterator]: () => assert.fail(),
    [Symbol.iterator]: () => assert.fail(),
    next: () => assert.fail(),
  };
  const ch = every<number>();
  feed(both, ch);
  assert.deepEqual(await all(ch), [1]);
  const asyncFirst: any = {
    async *[Symbol.asyncIterator]() {
      yield 2;
    },
    [Symbol.iterator]: () => assert.fail(),
    next: () => assert.fail(),
  };
  const ch2 = every<number>();
  feed(asyncFirst, ch2);
  assert.deepEqual(await all(ch2), [2]);
  const syncFirst: any = {
    *[Symbol.iterator]() {
      yield 3;
    },
    next: () => assert.fail(),
  };
  const ch3 = every<number>();
  feed(syncFirst, ch3);
  assert.deepEqual(await all(ch3), [3]);
  const ch4 = every<number>();
  feed(raw([{ value: 4, done: false }, { done: true }]), ch4);
  assert.deepEqual(await all(ch4), [4]);
});

test("FE-011 FE-014 FE-052 FE-053 usage errors throw synchronously", () => {
  const ch = new Channel<any>();
  for (const bad of [1, null, undefined, {}, "abc", true] as any[])
    assert.throws(() => feed(bad, ch), TypeError);
  assert.throws(() => feed([1], {} as any), TypeError);
  assert.throws(() => feed([1], null as any), TypeError);
  assert.ok(!ch.signal.aborted);
});

test("FE-019 FE-054 detection errors propagate to the caller", () => {
  const failure = new Error("x");
  const ch = new Channel<any>();
  assert.throws(
    () =>
      feed(
        {
          get then() {
            throw failure;
          },
        } as any,
        ch,
      ),
    e => e === failure,
  );
  assert.throws(
    () =>
      feed(
        {
          get next() {
            throw failure;
          },
        } as any,
        ch,
      ),
    e => e === failure,
  );
  assert.ok(!ch.signal.aborted);
});

test("FE-019 detection runs once, at the call", async () => {
  const reads = { then: 0, async: 0, sync: 0 };
  const ch = every<number>();
  const source: any = {
    get then() {
      reads.then++;
      return undefined;
    },
    get [Symbol.asyncIterator]() {
      reads.async++;
      return undefined;
    },
    get [Symbol.iterator]() {
      reads.sync++;
      return function* () {
        yield 1;
      };
    },
  };
  feed(source, ch);
  assert.deepEqual(reads, { then: 1, async: 1, sync: 1 });
  assert.deepEqual(await all(ch), [1]);
  assert.deepEqual(reads, { then: 1, async: 1, sync: 1 });
  let thens = 0;
  const ch2 = every<number>();
  feed(
    {
      get then() {
        thens++;
        return (ok: (v: number) => void) => ok(2);
      },
    } as any,
    ch2,
  );
  assert.deepEqual(await all(ch2), [2]);
  assert.equal(thens, 1);
});

test("FE-019 pulls use the next that detection read", async () => {
  let reads = 0,
    n = 0;
  const ch = every<number>();
  const next = () => ({ value: n, done: n++ > 1 });
  feed(
    {
      get next() {
        reads++;
        return next;
      },
    } as any,
    ch,
  );
  assert.deepEqual(await all(ch), [0, 1]);
  assert.equal(reads, 1);
  let opened = 0,
    m = 0;
  const iterator = {
    get next() {
      opened++;
      return () => ({ value: m, done: m++ > 1 });
    },
  };
  const ch2 = every<number>();
  feed({ [Symbol.iterator]: () => iterator } as any, ch2);
  assert.deepEqual(await all(ch2), [0, 1]);
  assert.equal(opened, 1);
});

test("FE-017 a Promise's then is not read again", async () => {
  let reads = 0;
  const source = Promise.resolve(1);
  Object.defineProperty(source, "then", {
    get() {
      reads++;
      return Promise.prototype.then;
    },
  });
  const ch = every<number>();
  feed(source, ch);
  assert.equal(reads, 1);
  await all(ch);
  assert.equal(reads, 1);
});

test("FE-054 FE-065 a Channel lookalike throws", () => {
  assert.throws(() => feed([1], Object.create(Channel.prototype)), TypeError);
});

test("FE-012 a thenable delivers one value, including undefined", async () => {
  const ch = every<undefined>();
  feed(Promise.resolve(undefined), ch);
  assert.deepEqual(await all(ch), [undefined]);
});

test("FE-013 sync iterators deliver settled values", async () => {
  const ch = every<number>();
  feed([Promise.resolve(1), 2] as any, ch);
  assert.deepEqual(await all(ch), [1, 2]);
});

test("FE-015 the return value is not sent by default", async () => {
  const ch = every<number>();
  feed(
    (function* () {
      yield 1;
      return 2;
    })(),
    ch,
  );
  assert.deepEqual(await all(ch), [1]);
});

test("FE-016 sendReturn sends a defined return value last", async () => {
  const ch = every<number>();
  feed(
    (function* () {
      yield 1;
      return Promise.resolve(2) as any;
    })(),
    ch,
    { sendReturn: true },
  );
  assert.deepEqual(await all(ch), [1, 2]);
  const ch2 = every<number>();
  feed(
    (function* () {
      yield 1;
    })(),
    ch2,
    { sendReturn: true },
  );
  assert.deepEqual(await all(ch2), [1]);
  const ch3 = every<number>();
  feed(Promise.resolve(1), ch3, { sendReturn: true });
  assert.deepEqual(await all(ch3), [1]);
  const ch4 = every<number>();
  feed(
    // biome-ignore lint/correctness/useYield: the generator returns without yielding
    (function* () {
      return 1;
    })() as any,
    ch4,
    { sendReturn: true, backPressure: false },
  );
  assert.deepEqual(await all(ch4), [1]);
});

test("FE-017 an early rejection is handled, and fails the channel at start", async () => {
  const ch = every<number>();
  const failure = new Error("x");
  feed(Promise.reject(failure), ch);
  await setImmediate();
  await assert.rejects(iter(ch).next(), e => e === failure);
});

test("FE-018 FE-023 FE-024 nothing happens before start", async () => {
  const ch = every<number>();
  let touched = 0;
  const thenable: any = {
    then(ok: (v: number) => void) {
      touched++;
      ok(1);
    },
  };
  const iterable: any = {
    [Symbol.iterator]() {
      touched++;
      return [][Symbol.iterator]();
    },
  };
  feed(thenable, ch);
  feed(iterable, ch);
  await setImmediate();
  assert.equal(touched, 0);
  await all(ch);
  assert.equal(touched, 2);
});

test("FE-020 autoStart pulls at the call", () => {
  const ch = new Channel<number>();
  let pulled = 0;
  feed(
    {
      next() {
        pulled++;
        return { done: true, value: undefined };
      },
    } as any,
    ch,
    { autoStart: true, autoClose: false },
  );
  assert.equal(pulled, 1);
});

test("FE-021 FE-022 a consumer in any first mode starts the run", async () => {
  for (const firstReceive of ["first", "unread", "latest", "next"] as const) {
    const ch = new Channel<number>({ firstReceive, thenReceive: "every" });
    feed([1], ch);
    const it = iter(ch);
    assert.deepEqual(await it.next(), { value: 1, done: false });
  }
});

test("FE-021 an ended consumer does not count", async () => {
  const ch = new Channel<number>();
  ch.send(0);
  const it = iter(ch);
  await it.next();
  await it.return(undefined);
  let pulled = 0;
  feed(
    {
      next() {
        pulled++;
        return { done: true };
      },
    } as any,
    ch,
  );
  await setImmediate();
  assert.equal(pulled, 0);
  ch.close();
});

test("FE-025 FE-045 a run ending before start uses only the source's return", async () => {
  const ch = new Channel<number>();
  let returned = 0,
    touched = 0;
  const source: any = {
    next: () => assert.fail(),
    return() {
      returned++;
      return {};
    },
  };
  const iterable: any = {
    [Symbol.iterator]() {
      touched++;
      return [];
    },
  };
  const thenable: any = {
    then() {
      touched++;
    },
    return() {
      touched++;
    },
  };
  const runs = [feed(source, ch), feed(iterable, ch), feed(thenable, ch)];
  ch.close();
  await Promise.all(runs);
  assert.equal(returned, 1);
  assert.equal(touched, 0);
});

test("FE-025 a terminal channel at autoStart ends without pulling", async () => {
  const ch = new Channel<number>();
  ch.close();
  await feed(
    // biome-ignore lint/correctness/useYield: the body must never run
    (function* () {
      assert.fail();
    })(),
    ch,
    { autoStart: true },
  );
});

test("FE-030 backPressure waits for the read", async () => {
  const ch = every<number>();
  let pulls = 0;
  feed(
    (function* () {
      for (;;) yield ++pulls;
    })(),
    ch,
    { autoStart: true },
  );
  await setImmediate();
  assert.equal(pulls, 1);
  const it = iter(ch);
  await it.next();
  await setImmediate();
  assert.equal(pulls, 2);
  ch.close();
});

test("FE-031 no backPressure uses send", async () => {
  const ch = every<number>();
  await feed([1, 2, 3], ch, {
    autoStart: true,
    backPressure: false,
    autoClose: false,
  });
  assert.ok(!ch.signal.aborted);
  ch.close();
  assert.deepEqual(await all(ch), [1, 2, 3]);
});

test("FE-041 failures reach channel.throw unchanged", async () => {
  const failure = new Error("x");
  const foreign = new Channel();
  foreign.close();
  const cases: [Source<number>, unknown][] = [
    [Promise.reject(failure), failure],
    [
      raw([], {
        next() {
          throw failure;
        },
      }),
      failure,
    ],
    [raw([], { next: () => Promise.reject(failure) }), failure],
    [
      raw([], { next: () => Promise.reject(foreign.signal.reason) }),
      foreign.signal.reason,
    ],
    [
      raw([Promise.resolve({ value: Promise.reject(failure), done: false })]),
      failure,
    ],
  ];
  for (const [source, error] of cases) {
    const ch = every<number>();
    assert.equal(await feed(source, ch, { autoStart: true }), undefined);
    await assert.rejects(iter(ch).next(), e => e === error);
  }
});

test("FE-041 a non-object result fails with a TypeError", async () => {
  const ch = every<number>();
  await feed(raw([1]), ch, { autoStart: true });
  await assert.rejects(iter(ch).next(), TypeError);
});

test("FE-041 a throwing iterator factory fails the channel", async () => {
  const failure = new Error("x");
  const ch = every<number>();
  const source: any = {
    [Symbol.iterator]() {
      throw failure;
    },
  };
  await feed(source, ch, { autoStart: true });
  await assert.rejects(iter(ch).next(), e => e === failure);
});

test("FE-042 a terminal channel stops the run before the next pull", async () => {
  const ch = new Channel<number>();
  let pulls = 0,
    returned = 0;
  const source: any = {
    next() {
      pulls++;
      return { value: 1, done: false };
    },
    return() {
      returned++;
      return {};
    },
  };
  const run = feed(source, ch, {
    autoStart: true,
    backPressure: false,
    autoClose: false,
  });
  ch.close();
  await run;
  assert.equal(pulls, 1);
  assert.equal(returned, 1);
});

test("FE-042 the check runs before the first pull", async () => {
  const ch = new Channel<number>();
  let pulls = 0,
    returned = 0;
  const iterator = {
    next() {
      pulls++;
      return { done: true, value: undefined };
    },
    return() {
      returned++;
      return {};
    },
  };
  const source: any = {
    [Symbol.iterator]() {
      ch.close();
      return iterator;
    },
  };
  await feed(source, ch, { autoStart: true });
  assert.equal(pulls, 0);
  assert.equal(returned, 1);
});

test("FE-042 FE-047 a pull in progress loses the race, and return is not awaited", async () => {
  const ch = new Channel<number>();
  const pull = Promise.withResolvers<IteratorResult<number>>();
  let returned = 0;
  const source: any = {
    next: () => pull.promise,
    return() {
      returned++;
      return new Promise(() => {});
    },
  };
  const run = feed(source, ch, { autoStart: true });
  await setImmediate();
  ch.close();
  await run;
  assert.equal(returned, 1);
  pull.reject(new Error("late"));
  await setImmediate();
});

test("FE-042 a discarded result with a rejecting value is not unhandled", async () => {
  const ch = new Channel<number>();
  const pull = Promise.withResolvers<IteratorResult<number>>();
  const run = feed({ next: () => pull.promise } as any, ch, {
    autoStart: true,
  });
  await setImmediate();
  ch.close();
  await run;
  pull.resolve({
    value: Promise.reject(new Error("late")) as any,
    done: false,
  });
  await setImmediate();
});

test("FE-042 a pull race retains nothing per pull", async () => {
  const ch = new Channel<object>({
    firstReceive: "next",
    thenReceive: "every",
  });
  const it = iter(ch);
  let added = 0;
  const { addEventListener } = ch.signal;
  ch.signal.addEventListener = function (this: AbortSignal, ...args: any[]) {
    added++;
    return (addEventListener as any).apply(this, args);
  } as any;
  feed(
    (function* () {
      for (let i = 0; i < 50; i++) yield {};
    })(),
    ch,
    { autoClose: false },
  );
  for (let i = 0; i < 50; i++) await it.next();
  assert.equal(added, 1);
  ch.close();
});

test("FE-043 FE-044 FE-047 a stop while sending awaits return", async () => {
  const ch = every<number>();
  const log: string[] = [];
  const run = feed(
    (function* () {
      try {
        yield 1;
      } finally {
        log.push("return");
      }
    })(),
    ch,
    { autoStart: true },
  );
  await setImmediate();
  ch.close();
  await run;
  assert.deepEqual(log, ["return"]);
});

test("FE-043 a stop during the last send skips return", async () => {
  const ch = every<number>();
  let returned = 0;
  const source: any = {
    next: () => ({ value: 1, done: true }),
    return() {
      returned++;
      return {};
    },
  };
  const run = feed(source, ch, { autoStart: true, sendReturn: true });
  await setImmediate();
  ch.close();
  await run;
  assert.equal(returned, 0);
});

test("FE-044 a value failure calls return", async () => {
  const ch = every<number>();
  const failure = new Error("x");
  let returned = 0;
  const source: any = {
    next: () => ({ value: Promise.reject(failure), done: false }),
    return() {
      returned++;
      return {};
    },
  };
  await feed(source, ch, { autoStart: true });
  assert.equal(returned, 1);
  await assert.rejects(iter(ch).next(), e => e === failure);
});

test("FE-046 no return after a source failure or a failed return value", async () => {
  const failure = new Error("x");
  let returned = 0;
  const count = () => {
    returned++;
    return {};
  };
  await feed(
    {
      next() {
        throw failure;
      },
      return: count,
    } as any,
    every<number>(),
    { autoStart: true },
  );
  await feed({ next: () => 1, return: count } as any, every<number>(), {
    autoStart: true,
  });
  await feed(
    {
      next: () => ({ done: true, value: Promise.reject(failure) }),
      return: count,
    } as any,
    every<number>(),
    { autoStart: true, sendReturn: true },
  );
  await feed(
    (function* () {
      yield 1;
    })(),
    every<number>(),
    { autoStart: true, backPressure: false },
  );
  assert.equal(returned, 0);
});

test("FE-003 options of the wrong type throw, and undefined selects the default", async () => {
  for (const key of ["autoStart", "autoClose", "backPressure", "sendReturn"])
    for (const value of [1, "yes", null, {}]) {
      const ch = new Channel<number>();
      let touched = 0;
      const source = {
        next() {
          touched++;
          return { done: true };
        },
      } as any;
      assert.throws(() => feed(source, ch, { [key]: value }), TypeError);
      await setImmediate();
      assert.equal(touched, 0);
      assert.ok(!ch.signal.aborted);
    }
  const ch = every<number>();
  feed([1], ch, {
    autoStart: undefined,
    autoClose: undefined,
    backPressure: undefined,
    sendReturn: undefined,
  });
  assert.deepEqual(await all(ch), [1]);
});

test("FE-046 no return when the channel ends during the await of a return value", async () => {
  const ch = every<number>();
  let returned = 0;
  const source = {
    next: () => ({ done: true, value: new Promise(noop) }),
    return() {
      returned++;
      return {};
    },
  };
  const run = feed(source as any, ch, { autoStart: true, sendReturn: true });
  await setImmediate();
  ch.close();
  await run;
  assert.equal(returned, 0);
});

test("FE-046 an error from reading done or value is a source failure", async () => {
  for (const key of ["done", "value"]) {
    const failure = new Error(key);
    let returned = 0;
    const result = Object.defineProperty({ done: false, value: 1 }, key, {
      get() {
        throw failure;
      },
    });
    const ch = every<number>();
    await feed(
      {
        next: () => result,
        return() {
          returned++;
          return {};
        },
      } as any,
      ch,
      { autoStart: true },
    );
    assert.equal(returned, 0, key);
    await assert.rejects(iter(ch).next(), e => e === failure);
  }
});

test("FE-044 a throwing then getter on a value is a value failure", async () => {
  const failure = new Error("x");
  let returned = 0;
  const value = {
    get then() {
      throw failure;
    },
  };
  const ch = every<number>();
  await feed(
    {
      next: () => ({ value, done: false }),
      return() {
        returned++;
        return {};
      },
    } as any,
    ch,
    { autoStart: true },
  );
  assert.equal(returned, 1);
  await assert.rejects(iter(ch).next(), e => e === failure);
});

test("FE-040 no pull follows a source finishing with a sent return value", async () => {
  let pulls = 0;
  const ch = every<number>();
  await feed(
    {
      next() {
        pulls++;
        return { value: 1, done: true };
      },
    } as any,
    ch,
    { autoStart: true, backPressure: false, sendReturn: true },
  );
  assert.equal(pulls, 1);
});

test("FE-045 an iterable with its own return receives it before start", async () => {
  const ch = new Channel<number>();
  const sync = (function* () {
      yield 1;
    })(),
    asynchronous = (async function* () {
      yield 1;
    })();
  const runs = [feed(sync, ch), feed(asynchronous, ch)];
  ch.close();
  await Promise.all(runs);
  assert.equal(sync.next().done, true);
  assert.equal((await asynchronous.next()).done, true);
});

test("FE-04D a run keeps one abort listener, and removes it at the end", async () => {
  const ch = new Channel<number>({ firstReceive: "next" });
  const hold = Promise.withResolvers<number>();
  const run = feed(hold.promise, ch, {
    autoStart: true,
    autoClose: false,
    backPressure: false,
  });
  assert.equal(getEventListeners(ch.signal, "abort").length, 1);
  hold.resolve(1);
  await run;
  assert.equal(getEventListeners(ch.signal, "abort").length, 0);
});

test("FE-048 errors from return are ignored", async () => {
  const ch = new Channel<number>();
  ch.close();
  await feed(
    {
      next() {},
      return() {
        throw new Error("x");
      },
    } as any,
    ch,
    { autoStart: true },
  );
  await feed(
    { next() {}, return: () => Promise.reject(new Error("x")) } as any,
    ch,
    { autoStart: true },
  );
  await feed({ next() {}, return: 1 } as any, ch, { autoStart: true });
});

test("FE-049 the last run closes the channel", async () => {
  const ch = every<number>();
  const a = Promise.withResolvers<number>(),
    b = Promise.withResolvers<number>();
  const first = feed(a.promise, ch, { autoStart: true, backPressure: false });
  const second = feed(b.promise, ch, { autoStart: true, backPressure: false });
  a.resolve(1);
  await first;
  assert.ok(!ch.signal.aborted);
  b.resolve(2);
  await second;
  assert.ok(ch.signal.aborted);
});

test("FE-04A autoClose false counts as active and never closes", async () => {
  const ch = every<number>();
  const a = Promise.withResolvers<number>();
  const open = feed(a.promise, ch, {
    autoStart: true,
    autoClose: false,
    backPressure: false,
  });
  await feed([1], ch, { autoStart: true, backPressure: false });
  assert.ok(!ch.signal.aborted);
  a.resolve(2);
  await open;
  assert.ok(!ch.signal.aborted);
});

test("FE-04B runs count per channel", async () => {
  const a = every<number>(),
    b = every<number>();
  const hold = Promise.withResolvers<number>();
  feed(hold.promise, a, { autoStart: true });
  await feed([1], b, { autoStart: true, backPressure: false });
  assert.ok(b.signal.aborted);
  assert.ok(!a.signal.aborted);
  a.close();
});

test("FE-04C run tracking does not retain a channel", async () => {
  let done = false;
  const registry = new FinalizationRegistry(() => (done = true));
  await (async () => {
    const ch = new Channel<number>();
    registry.register(ch, 0);
    await feed([1], ch, {
      autoStart: true,
      backPressure: false,
      autoClose: false,
    });
  })();
  for (let i = 0; i < 20 && !done; i++) {
    await setImmediate();
    collect();
  }
  assert.ok(done);
});

test("FE-050 FE-051 feed resolves undefined for errors", async () => {
  const ch = new Channel<number>();
  assert.equal(
    await feed(Promise.reject(new Error("x")), ch, { autoStart: true }),
    undefined,
  );
});

test("Examples close when a chosen source ends", async () => {
  const ch = every<number>();
  const ticks = (async function* () {
    yield 1;
    await new Promise(() => {});
  })();
  const until = Promise.resolve(2);
  feed(ticks, ch, { autoStart: true, backPressure: false });
  await feed(until, ch, { autoStart: true, backPressure: false }).then(() =>
    ch.close(),
  );
  assert.ok(ch.signal.aborted);
});

test("Examples merge two sources", async () => {
  const ch = new Channel<string>({ thenReceive: "every" });
  feed(["a"], ch);
  feed(["b"], ch);
  assert.deepEqual((await all(ch)).sort(), ["a", "b"]);
});

test("StopError from another channel is not treated as a stop", async () => {
  const other = new Channel();
  other.close();
  const ch = every<number>();
  await feed(Promise.reject(other.signal.reason), ch, { autoStart: true });
  await assert.rejects(
    iter(ch).next(),
    e => e instanceof StopError && e === other.signal.reason,
  );
});

test("FE-035 values from one run keep their order", async () => {
  const ch = every<number>();
  feed([1, 2, 3], ch);
  feed([4, 5, 6], ch);
  const out = await all(ch);
  assert.deepEqual(
    out.filter(n => n < 4),
    [1, 2, 3],
  );
  assert.deepEqual(
    out.filter(n => n > 3),
    [4, 5, 6],
  );
});

test("FE-015 a rejecting return value is not awaited, and fails nothing", async () => {
  const ch = every<number>();
  let pulls = 0;
  const source = {
    next: () =>
      pulls++
        ? { done: true, value: Promise.reject(new Error("discarded")) }
        : { done: false, value: 1 },
  };
  await feed(source as any, ch, { autoStart: true, backPressure: false });
  assert.deepEqual(await all(ch), [1]);
  await setImmediate();
});

test("FE-015 a return value that never settles does not hold the run", async () => {
  const ch = every<number>();
  const source = raw([{ done: true, value: new Promise(() => {}) }]);
  await feed(source, ch, { autoStart: true });
  assert.equal(ch.signal.aborted, true);
});

test("FE-015 a thenable return value is not touched", async () => {
  const ch = every<number>();
  let called = false;
  const value = { then: () => (called = true) };
  await feed(raw([{ done: true, value }]), ch, { autoStart: true });
  assert.equal(called, false);
  assert.deepEqual(await all(ch), []);
});

test("FE-060 return takes effect only after the generator's await settles", async () => {
  const gate = Promise.withResolvers<void>();
  const log: string[] = [];
  async function* source() {
    try {
      yield 1;
      await gate.promise;
    } finally {
      log.push("finally");
    }
  }
  const ch = every<number>();
  const run = feed(source(), ch, { autoStart: true, backPressure: false });
  await setImmediate();
  ch.close();
  await run;
  assert.deepEqual(log, []);
  gate.resolve();
  await setImmediate();
  assert.deepEqual(log, ["finally"]);
});

test("FE-061 a value pulled for a terminal channel never gets to another consumer", async () => {
  const queue = new Channel<number>({ thenReceive: "unread" });
  const ch = every<number>();
  const run = feed(queue, ch, { autoStart: true });
  await setImmediate();
  ch.close();
  await run;
  queue.send(1);
  await setImmediate();
  queue.close();
  assert.equal((await iter(queue).next()).done, true);
});

test("FE-062 a run with no read stays blocked until the channel is terminal", async () => {
  const ch = every<number>();
  let ended = false;
  const run = feed([1], ch, { autoStart: true }).then(() => {
    ended = true;
  });
  await setImmediate();
  assert.equal(ended, false);
  ch.close();
  await run;
});

test("FE-063 a failed run stops the other runs", async () => {
  const ch = every<number>();
  const failure = new Error("x");
  let returned = 0;
  const open = {
    next: () => new Promise(noop),
    return() {
      returned++;
      return {};
    },
  };
  await Promise.all([
    feed(open as any, ch, { autoStart: true }),
    feed(Promise.reject(failure), ch, { autoStart: true }),
  ]);
  assert.equal(returned, 1);
  await assert.rejects(iter(ch).next(), e => e === failure);
});

test("FE-064 an always-ready source starves the event loop", async () => {
  let ticked = false;
  setImmediate().then(() => {
    ticked = true;
  });
  async function* source() {
    for (let i = 0; i < 100; i++) yield i;
  }
  await feed(source(), every<number>(), {
    autoStart: true,
    backPressure: false,
  });
  assert.equal(ticked, false);
});

test("FE-066 stop with no backPressure can discard the final values", async () => {
  const ch = new Channel<number>({ stopStyle: "stop" });
  await feed([1], ch, { autoStart: true, backPressure: false });
  assert.equal((await iter(ch).next()).done, true);
});
