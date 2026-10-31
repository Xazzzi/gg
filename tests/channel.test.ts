import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { inspect } from "node:util";
import { attached } from "../src/channel.ts";
import { Channel, type ChannelOptions, StopError } from "../src/index.ts";

const collect = globalThis.gc as () => void; // --expose-gc is in the test command
const iter = <T, R>(ch: Channel<T, R>) => ch[Symbol.asyncIterator]();
const val = (value: unknown) => ({ value, done: false });
const end = (value?: unknown) => ({ value, done: true });
const isPending = (promise: Promise<unknown>) =>
  inspect(promise).includes("<pending>");

async function collectible(
  make: () => object,
  hold: (value: object) => unknown,
) {
  const registry = new FinalizationRegistry<() => void>(done => done());
  let collected = false;
  const held = (() => {
    const value = make();
    registry.register(value, () => (collected = true));
    return hold(value);
  })();
  for (let i = 0; i < 20 && !collected; i++) {
    await setImmediate();
    collect();
  }
  return { collected, held };
}

test("CH-001 defaults are unread, latest, drain", async () => {
  const ch = new Channel<number>();
  ch.send(1);
  ch.send(2);
  ch.send(3);
  const it = iter(ch);
  assert.deepEqual(await it.next(), val(1));
  assert.deepEqual(await it.next(), val(3));
  ch.close();
  assert.deepEqual(await it.next(), end());
});

test("CH-002 thenReceive unread requires firstReceive unread", () => {
  for (const firstReceive of ["first", "latest", "next"] as const)
    assert.throws(
      () => new Channel({ firstReceive, thenReceive: "unread" }),
      TypeError,
    );
  new Channel({ firstReceive: "unread", thenReceive: "unread" });
});

test("CH-003 unlisted option values throw", () => {
  for (const options of [
    { firstReceive: "x" },
    { thenReceive: "x" },
    { stopStyle: "x" },
    { firstReceive: null },
    { thenReceive: 1 },
    { stopStyle: "" },
  ] as any[])
    assert.throws(() => new Channel(options), TypeError);
  new Channel({
    firstReceive: undefined,
    thenReceive: undefined,
    stopStyle: undefined,
  });
});

test("CH-010 CH-012 send returns undefined and accepts null and undefined", async () => {
  const ch = new Channel<unknown>({ thenReceive: "every" });
  assert.equal(ch.send(undefined), undefined);
  ch.send(null);
  const it = iter(ch);
  assert.deepEqual(await it.next(), val(undefined));
  assert.deepEqual(await it.next(), val(null));
});

test("CH-011 send never runs consumer code synchronously", async () => {
  const ch = new Channel<number>();
  let seen = 0;
  const reading = iter(ch)
    .next()
    .then(() => seen++);
  ch.send(1);
  assert.equal(seen, 0);
  await reading;
  assert.equal(seen, 1);
});

test("CH-013 thenables are rejected and not appended", async () => {
  const ch = new Channel<any>({ firstReceive: "first", thenReceive: "every" });
  const fn = Object.assign(() => {}, { then() {} });
  assert.throws(() => ch.send({ then() {} }), TypeError);
  assert.throws(() => ch.send(fn), TypeError);
  assert.throws(() => ch.send(Promise.resolve()), TypeError);
  await assert.rejects(ch.asend({ then() {} }), TypeError);
  ch.send({ then: 1 });
  assert.deepEqual(await iter(ch).next(), val({ then: 1 }));
});

test("CH-013 an error from reading then propagates", async () => {
  const failure = new Error("x");
  const value = {
    get then() {
      throw failure;
    },
  };
  const ch = new Channel<any, any>({
    firstReceive: "first",
    thenReceive: "every",
  });
  assert.throws(
    () => ch.send(value),
    e => e === failure,
  );
  await assert.rejects(ch.asend(value), e => e === failure);
  assert.throws(
    () => ch.close(value),
    e => e === failure,
  );
  ch.send(1);
  assert.deepEqual(await iter(ch).next(), val(1));
});

test("CH-014 a then getter that closes the channel stops the send", async () => {
  const ch = new Channel<any>({ firstReceive: "first", thenReceive: "every" });
  const value = {
    get then() {
      ch.close();
      return undefined;
    },
  };
  await assert.rejects(ch.asend(value), e => e === ch.signal.reason);
  assert.deepEqual(await iter(ch).next(), end());
});

test("CH-014 CH-016 terminal send wins over the thenable check", async () => {
  const ch = new Channel<any>();
  ch.close();
  const stop = ch.signal.reason;
  assert.throws(
    () => ch.send({ then() {} }),
    e => e === stop,
  );
  await assert.rejects(ch.asend(1), e => e === stop);
  await assert.rejects(ch.asend({ then() {} }), e => e === stop);
});

test("CH-015 CH-017 asend appends, and a later read resolves it", async () => {
  const ch = new Channel<number>();
  const a = ch.asend(1),
    b = ch.asend(2);
  const it = iter(ch);
  await setImmediate();
  assert.ok(isPending(a));
  await it.next();
  assert.equal(await a, undefined);
  assert.ok(isPending(b));
  await it.next();
  await b;
});

test("CH-017 a read of a later value resolves earlier asends", async () => {
  const ch = new Channel<number>({ firstReceive: "latest" });
  const a = ch.asend(1),
    b = ch.asend(2);
  assert.deepEqual(await iter(ch).next(), val(2));
  await Promise.all([a, b]);
});

test("CH-018 asend resolves without the consumer calling next again", async () => {
  const ch = new Channel<number>();
  const sent = ch.asend(1);
  await iter(ch).next();
  await sent;
});

test("CH-019 CH-01A asend stays pending, then rejects with the stop error", async () => {
  const ch = new Channel<number>();
  const sent = ch.asend(1);
  await setImmediate();
  assert.ok(isPending(sent));
  ch.close();
  await assert.rejects(sent, e => e === ch.signal.reason);
});

test("CH-01C an ignored pending or terminal asend is not an unhandledRejection", async () => {
  const ch = new Channel<number>();
  ch.asend(1);
  ch.throw(new Error("x"));
  ch.asend(2);
  ch.asend({ then() {} } as any);
  await setImmediate();
});

test("CH-01C a stop error from a closing then getter is not unhandled", async () => {
  const ch = new Channel<any>();
  ch.asend({
    get then() {
      ch.close();
      return undefined;
    },
  });
  await setImmediate();
});

test("CH-013 a then getter error stays an asend rejection after terminal", async () => {
  const ch = new Channel<any>();
  const failure = new Error("x");
  await assert.rejects(
    ch.asend({
      get then() {
        ch.close();
        throw failure;
      },
    }),
    e => e === failure,
  );
});

test("CH-013 a then getter error stays unhandled even if the channel closed", async () => {
  const seen = Promise.withResolvers<unknown>();
  const listeners = process.listeners("unhandledRejection");
  process.removeAllListeners("unhandledRejection");
  process.once("unhandledRejection", error => seen.resolve(error));
  const failure = new Error("x");
  const ch = new Channel<any>();
  ch.asend({
    get then() {
      ch.close();
      throw failure;
    },
  });
  const error = await seen.promise;
  for (const listener of listeners) process.on("unhandledRejection", listener);
  assert.equal(error, failure);
});

test("CH-01C a terminal asend still rejects an awaiting producer", async () => {
  const ch = new Channel<number>();
  ch.close();
  await assert.rejects(ch.asend(1), e => e === ch.signal.reason);
});

test("CH-01C an ignored thenable asend stays unhandled", async () => {
  const seen = Promise.withResolvers<unknown>();
  const onUnhandled = (error: unknown) => seen.resolve(error);
  const listeners = process.listeners("unhandledRejection");
  process.removeAllListeners("unhandledRejection");
  process.once("unhandledRejection", onUnhandled);
  new Channel<any>().asend({ then() {} });
  const error = await seen.promise;
  for (const listener of listeners) process.on("unhandledRejection", listener);
  assert.ok(error instanceof TypeError);
});

test("CH-01C CH-01D an awaiting producer sees the rejection, and drain still reads", async () => {
  const ch = new Channel<number>();
  const sent = ch.asend(1);
  ch.close();
  await assert.rejects(sent, StopError);
  assert.deepEqual(await iter(ch).next(), val(1));
});

test("CH-020 first starts at value 1", async () => {
  const ch = new Channel<number>({
    firstReceive: "first",
    thenReceive: "every",
  });
  const a = iter(ch),
    b = iter(ch);
  ch.send(1);
  ch.send(2);
  assert.deepEqual(await a.next(), val(1));
  assert.deepEqual(await a.next(), val(2));
  assert.deepEqual(await b.next(), val(1));
});

test("CH-022 latest evaluates the newest at attach", async () => {
  const ch = new Channel<number>({ firstReceive: "latest" });
  ch.send(1);
  const pending = iter(ch).next();
  ch.send(2);
  assert.deepEqual(await pending, val(1));
});

test("CH-022 latest starts at the newest, or the next value", async () => {
  const ch = new Channel<number>({ firstReceive: "latest" });
  const pending = iter(ch).next();
  ch.send(1);
  ch.send(2);
  assert.deepEqual(await pending, val(1));
  assert.deepEqual(await iter(ch).next(), val(2));
});

test("CH-023 CH-024 next starts at the first value after attach", async () => {
  const ch = new Channel<number>({
    firstReceive: "next",
    thenReceive: "every",
  });
  ch.send(1);
  const it = iter(ch);
  const pending = it.next();
  await setImmediate();
  assert.ok(isPending(pending));
  ch.send(2);
  ch.send(3);
  assert.deepEqual(await pending, val(2));
  assert.deepEqual(await it.next(), val(3));
});

test("CH-031 latest is evaluated at the next call", async () => {
  const ch = new Channel<number>({ firstReceive: "first" });
  ch.send(1);
  ch.send(2);
  const it = iter(ch);
  await it.next();
  const pending = it.next();
  ch.send(3);
  assert.deepEqual(await pending, val(2));
  assert.deepEqual(await it.next(), val(3));
});

test("CH-031 a queued next evaluates after the earlier next settles", async () => {
  const ch = new Channel<number>({ firstReceive: "first" });
  ch.send(1);
  ch.send(2);
  ch.send(3);
  const it = iter(ch);
  const a = it.next(),
    b = it.next();
  ch.send(4);
  assert.deepEqual(await a, val(1));
  assert.deepEqual(await b, val(4));
});

test("CH-032 CH-033 latest blocks and reads the first value after that", async () => {
  const ch = new Channel<number>();
  const it = iter(ch);
  ch.send(1);
  await it.next();
  const pending = it.next();
  await setImmediate();
  assert.ok(isPending(pending));
  ch.send(2);
  ch.send(3);
  assert.deepEqual(await pending, val(2));
  assert.deepEqual(await it.next(), val(3));
});

test("CH-034 CH-035 CH-037 unread gives each value to one consumer", async () => {
  const ch = new Channel<number>({ thenReceive: "unread" });
  const a = iter(ch),
    b = iter(ch);
  const pa = a.next(),
    pb = b.next();
  ch.send(1);
  ch.send(2);
  ch.send(3);
  assert.deepEqual([(await pa).value, (await pb).value].sort(), [1, 2]);
  assert.deepEqual(await a.next(), val(3));
});

test("CH-041 CH-043 reading the head under every advances it by one", async () => {
  const ch = new Channel<number>({ thenReceive: "every" });
  ch.send(1);
  ch.send(2);
  ch.send(3);
  const a = iter(ch);
  assert.deepEqual(await a.next(), val(1));
  assert.deepEqual(await a.next(), val(2));
  const b = iter(ch);
  assert.deepEqual(await b.next(), val(3));
  const c = iter(ch);
  const pending = c.next();
  assert.deepEqual(await a.next(), val(3)); // Not the head, so it does not move
  ch.send(4);
  assert.deepEqual(await pending, val(4));
});

test("CH-042 CH-043 reading the head under latest moves it past the log", async () => {
  const ch = new Channel<number>();
  ch.send(1);
  ch.send(2);
  ch.send(3);
  const a = iter(ch);
  await a.next();
  ch.send(4);
  ch.send(5);
  assert.deepEqual(await a.next(), val(5));
  const b = iter(ch);
  assert.deepEqual(await b.next(), val(4));
  assert.deepEqual(await b.next(), val(5));
});

test("CH-044 other first modes do not move the head", async () => {
  for (const firstReceive of ["first", "latest"] as const) {
    const ch = new Channel<number>({ firstReceive, thenReceive: "every" });
    ch.send(1);
    assert.deepEqual(await iter(ch).next(), val(1));
    assert.deepEqual(await iter(ch).next(), val(1));
  }
});

const modes: [ChannelOptions, number, number][] = [
  [{ firstReceive: "first", thenReceive: "every" }, 1, 2],
  [{ firstReceive: "first", thenReceive: "latest" }, 1, 3],
  [{ firstReceive: "unread", thenReceive: "every" }, 1, 2],
  [{ firstReceive: "unread", thenReceive: "latest" }, 1, 3],
  [{ firstReceive: "unread", thenReceive: "unread" }, 1, 2],
  [{ firstReceive: "latest", thenReceive: "every" }, 3, 0],
  [{ firstReceive: "latest", thenReceive: "latest" }, 3, 0],
];

for (const stopStyle of ["drain", "stop"] as const)
  for (const [options, first, then] of modes)
    test(`Valid modes ${options.firstReceive}/${options.thenReceive}/${stopStyle}`, async () => {
      const ch = new Channel<number, string>({ ...options, stopStyle });
      ch.send(1);
      ch.send(2);
      ch.send(3);
      const it = iter(ch);
      assert.deepEqual(await it.next(), val(first));
      if (then) assert.deepEqual(await it.next(), val(then));
      ch.close("end");
      const last = await it.next();
      if (stopStyle === "stop") assert.deepEqual(last, end("end"));
      assert.equal(
        last.done ||
          options.thenReceive === "every" ||
          options.thenReceive === "unread",
        true,
      );
    });

for (const thenReceive of ["every", "latest"] as const)
  test(`Valid modes next/${thenReceive}`, async () => {
    const ch = new Channel<number>({ firstReceive: "next", thenReceive });
    ch.send(1);
    const it = iter(ch);
    const pending = it.next();
    ch.send(2);
    assert.deepEqual(await pending, val(2));
    ch.close();
    assert.deepEqual(await it.next(), end());
  });

test("CH-050 busy consumer does not retain the value it read", async () => {
  for (const thenReceive of ["every", "latest"] as const) {
    const ch = new Channel<object>({ firstReceive: "next", thenReceive });
    const it = iter(ch);
    let done = false;
    const registry = new FinalizationRegistry(() => (done = true));
    await (async () => {
      const value = {};
      registry.register(value, 0);
      const pending = it.next();
      ch.send(value);
      await pending;
    })();
    for (let i = 0; i < 20 && !done; i++) {
      await setImmediate();
      collect();
    }
    assert.ok(done, thenReceive);
  }
});

test("CH-050 next retains nothing with no consumers", async () => {
  for (const thenReceive of ["every", "latest"] as const) {
    const ch = new Channel<object>({ firstReceive: "next", thenReceive });
    assert.ok(
      (
        await collectible(
          () => ({}),
          value => ch.send(value),
        )
      ).collected,
    );
  }
});

test("CH-050 latest retains only the newest value", async () => {
  const ch = new Channel<object>({
    firstReceive: "latest",
    thenReceive: "every",
  });
  const { collected } = await collectible(
    () => ({}),
    value => {
      ch.send(value);
      ch.send({});
    },
  );
  assert.ok(collected);
});

test("CH-050 first under latest retains value 1 and the newest", async () => {
  const ch = new Channel<object>({ firstReceive: "first" });
  ch.send({ id: 1 });
  const { collected } = await collectible(
    () => ({}),
    value => {
      ch.send(value);
      ch.send({ id: 3 });
    },
  );
  assert.ok(collected);
  const it = iter(ch);
  assert.deepEqual((await it.next()).value, { id: 1 });
  assert.deepEqual((await it.next()).value, { id: 3 });
});

test("CH-050 head under latest retains the head and the newest", async () => {
  const ch = new Channel<object>();
  ch.send({ id: 1 });
  const { collected } = await collectible(
    () => ({}),
    value => {
      ch.send(value);
      ch.send({ id: 3 });
    },
  );
  assert.ok(collected);
});

test("CH-050 a value behind the head is collectable", async () => {
  for (const thenReceive of ["every", "unread"] as const) {
    const ch = new Channel<object>({ thenReceive });
    const it = iter(ch);
    let done = false;
    const registry = new FinalizationRegistry(() => (done = true));
    await (async () => {
      const value = {};
      registry.register(value, 0);
      ch.send(value);
      await it.next();
    })();
    for (let i = 0; i < 20 && !done; i++) {
      await setImmediate();
      collect();
    }
    assert.ok(done, thenReceive);
  }
});

test("CH-050 read head under latest is collectable", async () => {
  const ch = new Channel<object>();
  const it = iter(ch);
  let done = false;
  const registry = new FinalizationRegistry(() => (done = true));
  await (async () => {
    const value = {};
    registry.register(value, 0);
    ch.send(value);
    await it.next();
  })();
  for (let i = 0; i < 20 && !done; i++) {
    await setImmediate();
    collect();
  }
  assert.ok(done);
});

test("CH-050 stop drops retained values at terminal", async () => {
  const ch = new Channel<object>({
    firstReceive: "first",
    thenReceive: "every",
    stopStyle: "stop",
  });
  const { collected } = await collectible(
    () => ({}),
    value => (ch.send(value), ch.close()),
  );
  assert.ok(collected);
});

const collectedAfter = (track: (register: (value: object) => void) => void) => {
  let done = false;
  const registry = new FinalizationRegistry(() => (done = true));
  track(value => registry.register(value, 0));
  return async () => {
    for (let i = 0; i < 20 && !done; i++) {
      await setImmediate();
      collect();
    }
    return done;
  };
};

test("CH-050 a detached behind consumer releases the newest", async () => {
  const ch = new Channel<object>({ firstReceive: "next" });
  const it = iter(ch);
  const pending = it.next();
  ch.send({});
  await pending;
  const collected = collectedAfter(register => {
    const value = {};
    register(value);
    ch.send(value);
  });
  assert.ok(!(await collected()));
  await it.return(undefined);
  assert.ok(await collected());
});

test("CH-050 a detaching consumer leaves the newest for one still behind", async () => {
  const ch = new Channel<number>({ firstReceive: "next" });
  const a = iter(ch),
    b = iter(ch);
  const pa = a.next(),
    pb = b.next();
  ch.send(1);
  await pa;
  await pb;
  ch.send(2);
  await a.next();
  await a.return(undefined);
  assert.deepEqual(await b.next(), val(2));
});

test("CH-050 a consumer attaching at the newest does not count as behind", async () => {
  const ch = new Channel<object>({ firstReceive: "next" });
  const a = iter(ch);
  const first = a.next();
  ch.send({});
  await first;
  const collected = collectedAfter(register => {
    const value = {};
    register(value);
    ch.send(value);
  });
  const blocked = iter(ch).next();
  await a.next();
  assert.ok(await collected());
  ch.close();
  await blocked;
});

test("CH-050 under every, a dropped consumer does not make the channel retain", async () => {
  const ch = new Channel<object>({
    firstReceive: "next",
    thenReceive: "every",
  });
  await (async () => {
    const it = iter(ch);
    const pending = it.next();
    ch.send({});
    await pending;
  })();
  const collected = collectedAfter(register => {
    const value = {};
    register(value);
    ch.send(value);
  });
  assert.ok(await collected());
});

test("CH-051 the backlog has no bound", async () => {
  const ch = new Channel<number>({ thenReceive: "every" });
  for (let i = 0; i < 10_000; i++) ch.send(i);
  assert.deepEqual(await iter(ch).next(), val(0));
});

test("CH-060 CH-061 only the first terminal call counts", async () => {
  const ch = new Channel<number, string>();
  ch.close("a");
  const stop = ch.signal.reason;
  ch.close("b");
  ch.throw(new Error("c"));
  assert.equal(ch.signal.reason, stop);
  assert.deepEqual(await iter(ch).next(), end("a"));
});

test("CH-062 signal aborts synchronously with the stop error", () => {
  const ch = new Channel();
  let seen: unknown;
  ch.signal.addEventListener("abort", () => (seen = ch.signal.reason));
  ch.close();
  assert.ok(ch.signal.aborted);
  assert.ok(seen instanceof StopError);
});

test("CH-063 dispose acts as close", async () => {
  const ch = new Channel<number>();
  ch[Symbol.dispose]();
  assert.ok(ch.signal.aborted);
  assert.deepEqual(await iter(ch).next(), end());
});

test("CH-064 CH-069 drain reads by modes, then ends", async () => {
  const ch = new Channel<number>({
    firstReceive: "first",
    thenReceive: "every",
  });
  ch.send(1);
  ch.send(2);
  ch.close();
  const it = iter(ch);
  assert.deepEqual(await it.next(), val(1));
  assert.deepEqual(await it.next(), val(2));
  assert.deepEqual(await it.next(), end());
  assert.deepEqual(await it.next(), end());
});

test("CH-065 stop drops a value sent in the same run as close", async () => {
  const ch = new Channel<number>({ stopStyle: "stop" });
  const it = iter(ch);
  const pending = it.next();
  ch.send(1);
  ch.close();
  assert.deepEqual(await pending, end());
});

test("CH-065 stop delivers a value read before terminal", async () => {
  const ch = new Channel<number>({ stopStyle: "stop" });
  const it = iter(ch);
  const pending = it.next();
  await ch.asend(1);
  ch.close();
  assert.deepEqual(await pending, val(1));
});

test("CH-066 CH-067 CH-068 endings reach blocked, busy and late consumers", async () => {
  const failure = new Error("x");
  const closed = new Channel<number, string>({ stopStyle: "stop" });
  const thrown = new Channel<number>({ stopStyle: "stop" });
  for (const ch of [closed, thrown] as Channel<number, any>[]) {
    const busy = iter(ch);
    ch.send(1);
    await busy.next();
    const blocked = iter(ch);
    const pending = blocked.next();
    const pendingBusy = busy.next();
    await setImmediate();
    if (ch === closed) {
      ch.close("end");
      assert.deepEqual(await pending, end("end"));
      assert.deepEqual(await pendingBusy, end("end"));
      assert.deepEqual(await iter(ch).next(), end("end"));
    } else {
      ch.throw(failure);
      await assert.rejects(pending, e => e === failure);
      await assert.rejects(pendingBusy, e => e === failure);
      await assert.rejects(iter(ch).next(), e => e === failure);
    }
  }
});

test("CH-06A stop ends a late consumer on its first next", async () => {
  for (const firstReceive of ["first", "unread", "latest", "next"] as const) {
    const ch = new Channel<number>({
      firstReceive,
      thenReceive: "every",
      stopStyle: "stop",
    });
    ch.send(1);
    ch.close();
    assert.deepEqual(await iter(ch).next(), end());
  }
});

test("CH-06B further next calls produce undefined", async () => {
  const ch = new Channel<number, string>();
  ch.close("a");
  const it = iter(ch);
  assert.deepEqual(await it.next(), end("a"));
  assert.deepEqual(await it.next(), end());
});

test("CH-06C close rejects a thenable and the channel stays open", async () => {
  const ch = new Channel<number, any>();
  for (const value of [
    Promise.resolve(1),
    { then() {} },
    Object.assign(() => {}, { then() {} }),
  ])
    assert.throws(() => ch.close(value), TypeError);
  assert.ok(!ch.signal.aborted);
  ch.close({ then: 1 });
  assert.deepEqual(await iter(ch).next(), end({ then: 1 }));
});

test("CH-06C a then getter error propagates and the channel stays open", () => {
  const ch = new Channel<number, any>();
  const failure = new Error("x");
  assert.throws(
    () =>
      ch.close({
        get then() {
          throw failure;
        },
      }),
    e => e === failure,
  );
  assert.ok(!ch.signal.aborted);
});

test("CH-06C CH-061 takes precedence on a terminal channel", async () => {
  const ch = new Channel<number, any>();
  ch.close("a");
  ch.close({
    get then() {
      return assert.fail();
    },
  });
  assert.deepEqual(await iter(ch).next(), end("a"));
});

test("CH-070 CH-072 return detaches without closing or acknowledging", async () => {
  const ch = new Channel<number>({ thenReceive: "every" });
  ch.send(1);
  const it = iter(ch);
  await it.next();
  const sent = ch.asend(2);
  assert.deepEqual(await it.return(undefined), end());
  await setImmediate();
  assert.ok(isPending(sent));
  assert.ok(!ch.signal.aborted);
  ch.close();
  await sent.catch(() => {});
});

test("CH-071 throw ends only that consumer", async () => {
  const ch = new Channel<number>();
  ch.send(1);
  const it = iter(ch);
  await it.next();
  const failure = new Error("x");
  await assert.rejects(it.throw(failure), e => e === failure);
  assert.ok(!ch.signal.aborted);
});

test("CH-073 return waits for a pending next, which still reads", async () => {
  const ch = new Channel<number>({ thenReceive: "unread" });
  const it = iter(ch);
  const pending = it.next();
  await setImmediate();
  const returning = it.return(undefined);
  await setImmediate();
  assert.ok(isPending(returning));
  ch.send(1);
  assert.deepEqual(await pending, val(1));
  await returning;
});

test("CH-074 break detaches", async () => {
  const ch = new Channel<number>();
  ch.send(1);
  for await (const _ of ch) break;
  assert.ok(!ch.signal.aborted);
});

test("CH-080 CH-081 CH-082 stop error shape", async () => {
  const closed = new Channel<number>(),
    thrown = new Channel<number>();
  const failure = new Error("x");
  assert.equal(new StopError(failure).reason, failure);
  const sent = closed.asend(1);
  closed.close();
  thrown.throw(failure);
  const stop = closed.signal.reason;
  assert.ok(stop instanceof Error);
  assert.equal(stop.name, "StopError");
  assert.equal(stop.message, "Channel closed");
  assert.equal((stop as StopError).reason, undefined);
  assert.equal(thrown.signal.reason.reason, failure);
  await assert.rejects(sent, e => e === stop);
  assert.throws(
    () => closed.send(1),
    e => e === stop,
  );
});

test("CH-083 consumers do not receive the stop error", async () => {
  const ch = new Channel<number>();
  ch.close();
  assert.deepEqual(await iter(ch).next(), end());
});

test("CH-084 instanceof works across copies by brand", () => {
  const foreign = Object.defineProperty(
    new Error("x"),
    Symbol.for("gg.StopError"),
    { value: true },
  );
  assert.ok(foreign instanceof StopError);
  assert.ok(!(new Error("x") instanceof StopError));
  assert.ok(!((null as any) instanceof StopError));
  assert.ok(!(("x" as any) instanceof StopError));
});

test("CH-090 CH-091 CH-093 attached resolves with a consumer", async () => {
  const ch = new Channel<number>({
    firstReceive: "first",
    thenReceive: "every",
  });
  const waiting = attached(ch);
  assert.ok(isPending(waiting));
  const it = iter(ch);
  it.next();
  await waiting;
  await attached(ch);
  ch.send(1);
  ch.close();
});

test("CH-092 attached rejects on terminal", async () => {
  const ch = new Channel<number>();
  const waiting = attached(ch);
  ch.close();
  await assert.rejects(waiting, e => e === ch.signal.reason);
  await assert.rejects(attached(ch), e => e === ch.signal.reason);
});

test("CH-092 terminal wins over an active consumer", async () => {
  const ch = new Channel<number>();
  ch.send(1);
  const it = iter(ch);
  await it.next();
  ch.close();
  await assert.rejects(attached(ch), e => e === ch.signal.reason);
});

test("CH-094 an ended consumer leaves the count", async () => {
  const ch = new Channel<number>();
  ch.send(1);
  const it = iter(ch);
  await it.next();
  await it.return(undefined);
  const waiting = attached(ch);
  assert.ok(isPending(waiting));
  ch.close();
  await assert.rejects(waiting);
});

test("Unattached iterator has no effect", async () => {
  const ch = new Channel<number>();
  const it = iter(ch);
  await it.return(undefined);
  const waiting = attached(ch);
  assert.ok(isPending(waiting));
  ch.close();
  await assert.rejects(waiting);
});

test("CH-050 a consumer blocked on the head does not retain the newest", async () => {
  const ch = new Channel<object>();
  const a = iter(ch);
  const b = iter(ch);
  ch.send({});
  const { collected } = await collectible(
    () => ({}),
    value => {
      ch.send(value);
      return (async () => {
        const first = a.next();
        b.next();
        await first;
        await a.next();
        a.next();
      })();
    },
  );
  assert.equal(collected, true);
});

test("CH-017 asend waits for its own value when a then getter sends first", async () => {
  const ch = new Channel<unknown>({ thenReceive: "every" });
  const value = {
    get then() {
      ch.send("inner");
      return undefined;
    },
  };
  const sent = ch.asend(value);
  const it = iter(ch);
  assert.deepEqual(await it.next(), val("inner"));
  await setImmediate();
  assert.equal(isPending(sent), true);
  await it.next();
  await sent;
});

test("CH-01B a pending asend survives collection and rejects at terminal", async () => {
  const ch = new Channel<number>();
  const sent = ch.asend(1);
  collect();
  await setImmediate();
  assert.equal(isPending(sent), true);
  ch.close();
  await assert.rejects(sent, StopError);
});

test("CH-021 unread evaluates the head in the read's microtask", async () => {
  const ch = new Channel<number>({ thenReceive: "every" });
  ch.send(1);
  ch.send(2);
  const first = iter(ch).next();
  const second = iter(ch).next();
  assert.deepEqual(await first, val(1));
  assert.deepEqual(await second, val(2));
});

test("CH-030 every reads position + 1", async () => {
  const ch = new Channel<number>({ thenReceive: "every" });
  for (const n of [1, 2, 3]) ch.send(n);
  const it = iter(ch);
  for (const n of [1, 2, 3]) assert.deepEqual(await it.next(), val(n));
});

test("CH-036 blocked unread consumers each receive one value", async () => {
  const ch = new Channel<number>({ thenReceive: "unread" });
  const reads = [iter(ch).next(), iter(ch).next()];
  await setImmediate();
  ch.send(1);
  ch.send(2);
  const values = (await Promise.all(reads)).map(read => read.value);
  assert.deepEqual(values.sort(), [1, 2]);
});

test("CH-040 the head starts at 1", async () => {
  const ch = new Channel<number>();
  ch.send(1);
  ch.send(2);
  assert.deepEqual(await iter(ch).next(), val(1));
});

test("CH-095 attached rejects a channel from another copy", () => {
  assert.throws(
    () => attached({ signal: { aborted: false } } as any),
    TypeError,
  );
});

test("CH-050 a consumer with no read does not end the newest for one behind", async () => {
  const ch = new Channel<number>();
  ch.send(1);
  ch.send(2);
  const a = iter(ch);
  const first = a.next();
  const blocked = iter(ch).next();
  assert.deepEqual(await first, val(1));
  await setImmediate();
  ch.close();
  assert.deepEqual(await blocked, end());
  assert.deepEqual(await a.next(), val(2));
});

test("CH-050 a detached consumer stops counting for later sends", async () => {
  const ch = new Channel<object | number>({ firstReceive: "next" });
  const a = iter(ch);
  const first = a.next();
  await setImmediate();
  ch.send(1);
  await first;
  await a.return(undefined);
  const b = iter(ch);
  const { collected } = await collectible(
    () => ({}),
    value => {
      const read = b.next();
      return setImmediate().then(() => {
        ch.send(value);
        return read.then(() => undefined);
      });
    },
  );
  assert.equal(collected, true);
});

test("CH-031 a consumer blocked at next counts as behind", async () => {
  const ch = new Channel<number>({ firstReceive: "next" });
  const it = iter(ch);
  const first = it.next();
  await setImmediate();
  for (const n of [1, 2, 3]) ch.send(n);
  assert.deepEqual(await first, val(1));
  assert.deepEqual(await it.next(), val(3));
});
