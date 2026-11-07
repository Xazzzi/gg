import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { CHAN, Channel, changes, feed, select } from "../src/index.ts";
import { type Child, each, jsx, mount } from "../src/jsx.ts";
import { fakeDocument } from "./dom.ts";

const HOOK = Symbol.for("gg.devtools");
const collect = globalThis.gc as () => void;
const g = globalThis as any;

// Records every registration and event, until the returned function removes the hook.
const install = (check?: (kind: string, target: any) => void) => {
  const log: unknown[][] = [];
  const details = new Map<object, any>();
  g[HOOK] = (kind: string, target: object, detail: object) => {
    details.set(target, detail);
    log.push([kind, "register"]);
    return (event: string, ...args: unknown[]) => {
      check?.(kind, target);
      log.push([kind, event, ...args]);
    };
  };
  return { log, details, off: () => delete g[HOOK] };
};

test("DV-001 a missing or non-function hook does no devtools work", async () => {
  for (const value of [undefined, {}]) {
    g[HOOK] = value;
    const ch = new Channel<number>();
    ch.send(1);
    const s = select({ a: 1 }, { autoStart: true, nonYielding: true });
    feed([1], new Channel(), { autoStart: true });
    await setImmediate();
    assert.ok(s[CHAN].signal.aborted);
  }
  delete g[HOOK];
});

test("DV-002 registration passes kind, target and detail with defaults", async () => {
  const { log, details, off } = install();
  try {
    const ch = new Channel<number>();
    assert.deepEqual(details.get(ch), {
      firstReceive: "unread",
      thenReceive: "every",
      stopStyle: "drain",
      owner: undefined,
    });
    const custom = new Channel<number>({
      firstReceive: "first",
      thenReceive: "latest",
      stopStyle: "stop",
    });
    assert.deepEqual(details.get(custom), {
      firstReceive: "first",
      thenReceive: "latest",
      stopStyle: "stop",
      owner: undefined,
    });
    const source = [1];
    feed(source, ch, { autoClose: false });
    assert.deepEqual(details.get(source), {
      channel: ch,
      autoStart: false,
      autoClose: false,
      backPressure: true,
      sendReturn: false,
      owner: undefined,
    });
    const s = select([1], { unwrap: true });
    const detail = details.get(s);
    assert.equal(detail.channel, s[CHAN]);
    assert.equal(detail.array, true);
    assert.equal(detail.unwrap, true);
    const o = select({ a: 1 });
    assert.equal(details.get(o).array, false);
    assert.equal(details.get(o).unwrap, false);
    assert.deepEqual(log.map(([kind]) => kind).slice(0, 4), [
      "channel",
      "channel",
      "feed",
      "channel",
    ]);
    assert.deepEqual(log[4], ["select", "register"]);
  } finally {
    off();
  }
});

test("DV-003 the hook finds the caller at a fixed stack depth", () => {
  const frames: string[] = [];
  g[HOOK] = (kind: string) => {
    frames.push(`${kind} ${(new Error().stack as string).split("\n")[4]}`);
  };
  try {
    new Channel();
    feed([1], new Channel());
    select({});
  } finally {
    delete g[HOOK];
  }
  assert.equal(frames.length, 5);
  assert.match(frames[3], /^channel .*select\.ts/); // The channel that select owns
  frames.splice(3, 1);
  for (const frame of frames) assert.match(frame, /devtools\.test\.ts/);
});

test("DV-004 errors from the hook propagate", () => {
  const error = new Error("hook");
  g[HOOK] = () => {
    throw error;
  };
  try {
    assert.throws(() => new Channel(), error);
  } finally {
    delete g[HOOK];
  }
});

test("DV-010 DV-011 DV-012 channel events carry values, numbers and readers", async () => {
  const { log, off } = install();
  try {
    const ch = new Channel<string>();
    log.length = 0;
    ch.send("a");
    const it = ch[Symbol.asyncIterator]();
    await it.next();
    ch.send("b");
    await it.next();
    await it.return(undefined);
    const reader = log[1][2];
    assert.equal(typeof reader, "object");
    assert.deepEqual(log, [
      ["channel", "send", "a", 1],
      ["channel", "attach", reader],
      ["channel", "read", "a", 1, reader],
      ["channel", "send", "b", 2],
      ["channel", "read", "b", 2, reader],
      ["channel", "detach", reader],
    ]);
  } finally {
    off();
  }
});

test("DV-011 each consumer has its own reader", async () => {
  const { log, off } = install();
  try {
    const ch = new Channel<number>({ firstReceive: "first" });
    const a = ch[Symbol.asyncIterator](),
      b = ch[Symbol.asyncIterator]();
    ch.send(1);
    await a.next();
    await b.next();
    const reads = log.filter(entry => entry[1] === "read");
    assert.equal(reads.length, 2);
    assert.notEqual(reads[0][4], reads[1][4]);
  } finally {
    off();
  }
});

test("DV-013 the first close or throw emits end before the abort", () => {
  const aborted: boolean[] = [];
  const { log, off } = install((_, target) =>
    aborted.push(target.signal.aborted),
  );
  try {
    const closed = new Channel<number, string>();
    closed.close("done");
    closed.close("again");
    const failed = new Channel();
    const error = new Error("x");
    failed.throw(error);
    assert.deepEqual(
      log.filter(entry => entry[1] === "end"),
      [
        ["channel", "end", false, "done"],
        ["channel", "end", true, error],
      ],
    );
    assert.deepEqual(aborted, [false, false]);
  } finally {
    off();
  }
});

test("DV-020 the end of a run emits end before auto close", async () => {
  const aborted: boolean[] = [];
  const { log, details, off } = install((kind, target) => {
    if (kind === "feed")
      aborted.push(details.get(target).channel.signal.aborted);
  });
  try {
    const ch = new Channel<number>();
    feed(Promise.resolve(1), ch, { autoStart: true, backPressure: false });
    await setImmediate();
    assert.deepEqual(
      log.filter(([kind]) => kind === "feed"),
      [
        ["feed", "register"],
        ["feed", "end"],
      ],
    );
    assert.deepEqual(aborted, [false]);
    assert.ok(ch.signal.aborted);
  } finally {
    off();
  }
});

test("DV-030 DV-031 DV-032 select reports operations without onChanges", async () => {
  const order: string[] = [];
  const { log, off } = install();
  try {
    const s = select(
      { a: 1 },
      {
        autoStart: true,
        autoClose: false,
        nonYielding: true,
        onChanges: () => order.push("onChanges"),
      },
    );
    const bare = select([1], {
      autoStart: true,
      autoClose: false,
      nonYielding: true,
    });
    await setImmediate();
    s.a = 2;
    bare.push(2);
    await setImmediate();
    const events = log.filter(([kind]) => kind === "select");
    assert.deepEqual(events, [
      ["select", "register"],
      ["select", "register"],
      ["select", "start"],
      ["select", "start"],
      [
        "select",
        "report",
        [{ op: "set", key: "a", value: 1, prev: undefined }],
      ],
      [
        "select",
        "report",
        [{ op: "splice", start: 0, removed: [], added: [1] }],
      ],
      ["select", "report", [{ op: "set", key: "a", value: 2, prev: 1 }]],
      [
        "select",
        "report",
        [{ op: "splice", start: 1, removed: [], added: [2] }],
      ],
    ]);
    assert.deepEqual(order, ["onChanges", "onChanges"]);
    s[CHAN].close();
    bare[CHAN].close();
  } finally {
    off();
  }
});

test("DV-032 report emits before onChanges", async () => {
  const order: string[] = [];
  g[HOOK] = () => (event: string) => order.push(event);
  try {
    const s = select(
      { a: 1 },
      {
        autoStart: true,
        nonYielding: true,
        onChanges: () => order.push("onChanges"),
      },
    );
    await setImmediate();
    assert.deepEqual(
      order.filter(event => event !== "end"),
      ["start", "report", "onChanges"],
    );
    assert.ok(s[CHAN].signal.aborted);
  } finally {
    delete g[HOOK];
  }
});

test("DV-033 slots describe each slot in order", async () => {
  const { details, off } = install();
  try {
    const promise = Promise.resolve(1);
    const sync = { next: () => ({ value: 1, done: false }) };
    const raw = { next: () => new Promise(() => {}) };
    const gen = (async function* () {
      yield 1;
    })();
    const s = select([0, promise, gen, sync, raw], {
      autoStart: true,
      autoClose: false,
      backPressure: false,
    });
    const slots = details.get(s).slots;
    assert.deepEqual(
      slots().map(({ kind, sync }: any) => [kind, sync]),
      [
        ["plain", undefined],
        ["promise", undefined],
        ["async", false],
        ["raw", undefined],
        ["raw", undefined],
      ],
    );
    await setImmediate();
    const [plain, settled, iterator, first, second] = slots();
    assert.deepEqual(plain, {
      key: 0,
      kind: "plain",
      sync: undefined,
      source: 0,
      state: 0,
      busy: false,
      finished: false,
    });
    assert.equal(settled.source, promise);
    assert.equal(settled.state.value, 1);
    assert.equal(iterator.finished, true);
    assert.deepEqual([first.sync, second.sync], [true, false]);
    assert.equal(second.busy, true);
    s.reverse();
    assert.deepEqual(
      slots().map(({ key }: any) => key),
      [0, 1, 2, 3, 4],
    );
    assert.equal(slots()[0].source, raw);
    const o = select({ x: 1 });
    assert.equal(details.get(o).slots()[0].key, "x");
    s[CHAN].close();
  } finally {
    off();
  }
});

test("SE-10A DV-030 without onChanges or an emitter, operations retain no replaced source", async () => {
  const registry = new FinalizationRegistry<() => void>(done => done());
  let collected = false;
  const s: any = select({ a: 0 }, { autoStart: true, autoClose: false });
  const it = s[Symbol.asyncIterator]();
  await it.next(); // The next flush blocks at publish, so operations would collect
  s.a = 1;
  await setImmediate();
  (() => {
    const value = {};
    registry.register(value, () => (collected = true));
    s.a = value;
    s.a = 2;
  })();
  for (let i = 0; i < 20 && !collected; i++) {
    await setImmediate();
    collect();
  }
  assert.ok(collected);
  s[CHAN].close();
});

test("SE-14C DV-030 an emitter keeps the log after the last reader finishes", async () => {
  const { log, off } = install();
  try {
    const s = select([1], {
      autoStart: true,
      autoClose: false,
      nonYielding: true,
    });
    await setImmediate();
    changes(s).return();
    s.push(2);
    await setImmediate();
    const reports = log.filter(([k, e]) => k === "select" && e === "report");
    assert.equal(reports.length, 2);
  } finally {
    off();
  }
});

const el = () => fakeDocument.createElement("div") as any;
const open = { autoStart: true, autoClose: false, nonYielding: true } as const;

test("DV-003 the hook finds the caller of jsx, each and mount", async () => {
  const frames: string[] = [];
  g[HOOK] = (kind: string) => {
    const lines = (new Error().stack as string).split("\n");
    frames.push(`${kind} ${lines[kind === "mount" ? 5 : 4]}`);
  };
  try {
    jsx(() => el(), {});
    each(select([], open), () => null);
    mount(el(), Promise.resolve(1));
    jsx("p", { children: Promise.resolve(1) });
  } finally {
    delete g[HOOK];
  }
  const own = frames.filter(frame => /^(component|each|mount) /.test(frame));
  assert.equal(own.length, 4);
  for (const frame of own) assert.match(frame, /devtools\.test\.ts/);
});

test("DV-005 DV-040 a component registers what it returns, unless it is a primitive", () => {
  const { log, details, off } = install();
  try {
    const node = el(),
      props = { a: 1 },
      Comp = () => node;
    assert.equal(jsx(Comp, props), node);
    assert.deepEqual(details.get(node), {
      type: Comp,
      props,
      owner: undefined,
    });
    jsx(() => "text", {});
    jsx(() => null, {});
    assert.deepEqual(log, [["component", "register"]]);
  } finally {
    off();
  }
});

test("DV-041 DV-043 mount registers a parent with a dynamic child, and owns its select", () => {
  const { log, details, off } = install();
  try {
    mount(el(), "static");
    assert.equal(log.length, 0);
    const parent = el();
    mount(parent, Promise.resolve(1));
    assert.deepEqual(details.get(parent), { owner: undefined });
    assert.deepEqual(
      log.map(([kind]) => kind),
      ["mount", "channel", "select"],
    );
    const [channel, proxy] = [...details].slice(1);
    assert.equal(channel[1].owner, parent);
    assert.equal(proxy[1].owner, parent);
    assert.equal(details.get(new Channel()).owner, undefined);
  } finally {
    off();
  }
});

test("DV-042 DV-043 each registers its iterator, and owns its select and item channels", async () => {
  const { details, off } = install();
  try {
    const state = select(["a", "b"], open);
    await setImmediate();
    const made: Channel<string>[] = [];
    const it = each(state, item => {
      made.push(new Channel<string>()); // A channel that render makes has no owner
      return item;
    });
    assert.deepEqual(details.get(it), { state, owner: undefined });
    await it.next();
    const owned = [...details].filter(([, d]) => d.owner === it);
    assert.equal(owned.filter(([t]) => t instanceof Channel).length, 3); // Two items, and the channel of the select
    assert.equal(owned.filter(([t]) => (t as any)[CHAN]).length, 1);
    for (const channel of made)
      assert.equal(details.get(channel).owner, undefined);
    state[CHAN].close();
    await it.next();
  } finally {
    off();
  }
});

test("DV-044 the library ignores what the hook returns for mount and each", async () => {
  g[HOOK] = (kind: string) =>
    ["mount", "each"].includes(kind) ? () => assert.fail("emitted") : undefined;
  try {
    mount(el(), Promise.resolve("x"));
    const state = select(["a"], open);
    const it = each(state, item => Promise.resolve(`${item}`));
    await it.next();
    state[CHAN].close();
    await it.next();
    await setImmediate();
  } finally {
    delete g[HOOK];
  }
});

// Counts the end events of each component result.
const ends = () => {
  const counts = new Map<object, number>();
  g[HOOK] = (kind: string, target: object) =>
    kind === "component"
      ? (event: string) =>
          event === "end" && counts.set(target, (counts.get(target) ?? 0) + 1)
      : undefined;
  return counts;
};

test("DV-045 a mount ends a component result that finishes or settles, one time", async () => {
  const counts = ends();
  try {
    let release!: () => void;
    const waiting = new Promise<void>(resolve => (release = resolve));
    async function* Once() {
      yield "a";
      await waiting;
    }
    const gen = jsx(Once, {}) as object,
      promise = jsx(() => Promise.resolve("b"), {}) as object,
      node = jsx(() => el(), {}) as object;
    mount(el(), gen as Child, promise as Child, node as Child);
    await setImmediate();
    assert.equal(counts.get(gen), undefined);
    assert.equal(counts.get(promise), 1);
    release();
    await setImmediate();
    assert.equal(counts.get(gen), 1);
    assert.equal(counts.get(node), undefined);
  } finally {
    delete g[HOOK];
  }
});

test("DV-045 each ends the result of an item that leaves, and the rest when it stops", async () => {
  const counts = ends();
  try {
    const state = select(["a", "b", "c", "d"], open);
    await setImmediate();
    const results: object[] = [];
    async function* Row({ item }: { item: Channel<string> }) {
      for await (const value of item) {
        yield value;
        if (value === "d") return; // Finishes by itself
      }
    }
    mount(
      el(),
      each(state, item => {
        // The result of b stays pending after its channel closes.
        const result =
          results.length === 1
            ? jsx(() => new Promise(() => {}), {})
            : jsx(Row, { item });
        results.push(result as object);
        return result;
      }),
    );
    await setImmediate();
    const [a, b, c, d] = results;
    assert.equal(counts.get(d), 1);
    state.splice(1, 1);
    await setImmediate();
    assert.equal(counts.get(b), 1);
    assert.equal(counts.get(a), undefined);
    state[CHAN].close();
    await setImmediate();
    for (const result of [a, b, c, d]) assert.equal(counts.get(result), 1);
  } finally {
    delete g[HOOK];
  }
});

test("DV-004 DV-005 a hook error inside an owner leaves no owner behind", () => {
  const { details, off } = install();
  const hook = g[HOOK];
  g[HOOK] = (kind: string, target: object, detail: { owner?: object }) => {
    if (detail.owner) throw new Error("hook");
    return hook(kind, target, detail);
  };
  try {
    assert.throws(() => mount(el(), Promise.resolve(1)), /hook/);
    assert.equal(details.get(new Channel()).owner, undefined);
  } finally {
    off();
  }
});
