import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import {
  CHAN,
  Channel,
  type ChannelOptions,
  type Op,
  select,
} from "../src/index.ts";

const seeds = Number(process.env.FUZZ_SEEDS ?? 8);
const steps = 40;

// mulberry32, so a failure repeats from its seed.
const random = (seed: number) => (limit: number) => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return (((t ^ (t >>> 14)) >>> 0) % limit) as number;
};

type Mode = Required<Pick<ChannelOptions, "firstReceive" | "thenReceive">>;
type Consumer = {
  it: AsyncGenerator<number, unknown, void>;
  pos: number;
  started: boolean;
  pending?: { read: Promise<IteratorResult<number>>; target: number };
};

// A naive log that follows the Then receive, First receive and Head sections.
async function channelRun(mode: Mode, seed: number) {
  const roll = random(seed);
  const { firstReceive: first, thenReceive: then } = mode;
  const ch = new Channel<number>(mode);
  const log: number[] = [];
  const consumers: Consumer[] = [];
  let head = 1;

  const target = (c: Consumer) => {
    if (c.started) {
      if (then === "every") return c.pos + 1;
      if (then === "unread") return head;
      return log.length > c.pos ? log.length : log.length + 1;
    }
    if (first === "first") return 1;
    if (first === "unread") return head;
    if (first === "latest") return Math.max(log.length, 1);
    return log.length + 1;
  };
  const usesHead = (c: Consumer) =>
    first === "unread" && (!c.started || then === "unread");
  const landed = (c: Consumer, n: number) => {
    c.pos = n;
    c.started = true;
    if (first === "unread" && n === head)
      head = then === "latest" ? log.length + 1 : head + 1;
  };
  const settle = async () => {
    await setImmediate();
    for (const c of consumers) {
      if (!c.pending || c.pending.target > log.length) continue;
      const { read, target: n } = c.pending;
      c.pending = undefined;
      assert.deepEqual(await read, { value: n, done: false });
      landed(c, n);
    }
  };
  const next = (c: Consumer) => {
    const n = target(c);
    // Blocked consumers on the head race, by CH-036, so they never block here.
    if (c.pending || (usesHead(c) && n > log.length)) return;
    c.pending = { read: c.it.next(), target: n };
  };

  for (let step = 0; step < steps; step++) {
    const c = consumers[roll(consumers.length || 1)];
    const action = roll(10);
    if (action < 4) {
      ch.send(log.length + 1);
      log.push(log.length + 1);
    } else if (action < 5)
      consumers.push({ it: iterate(ch), pos: 0, started: false });
    else if (c && action < 9) next(c);
    else if (c && !c.pending) {
      await c.it.return(undefined);
      consumers.splice(consumers.indexOf(c), 1);
    }
    await settle();
  }

  ch.close();
  for (const c of consumers) {
    if (c.pending && c.pending.target > log.length) {
      assert.equal((await c.pending.read).done, true);
      continue;
    }
    await settle();
    for (;;) {
      const n = target(c);
      const { value, done } = await c.it.next();
      if (n > log.length) {
        assert.equal(done, true);
        break;
      }
      assert.equal(value, n);
      landed(c, n);
    }
  }
}

const iterate = (ch: Channel<number>) =>
  ch[Symbol.asyncIterator]() as AsyncGenerator<number, unknown, void>;

const modes: Mode[] = [
  { firstReceive: "first", thenReceive: "every" },
  { firstReceive: "first", thenReceive: "latest" },
  { firstReceive: "unread", thenReceive: "every" },
  { firstReceive: "unread", thenReceive: "latest" },
  { firstReceive: "unread", thenReceive: "unread" },
  { firstReceive: "latest", thenReceive: "every" },
  { firstReceive: "latest", thenReceive: "latest" },
  { firstReceive: "next", thenReceive: "every" },
  { firstReceive: "next", thenReceive: "latest" },
];

for (const mode of modes)
  test(`Fuzz CH-020 CH-030 CH-040 CH-050 ${mode.firstReceive} then ${mode.thenReceive} matches the log`, async () => {
    for (let seed = 0; seed < seeds; seed++) await channelRun(mode, seed);
  });

const replay = (ops: Op[], base: any) => {
  for (const op of ops) {
    if (op.op === "set") base[op.key] = op.value;
    else if (op.op === "delete") delete base[op.key];
    else base.splice(op.start, op.removed.length, ...op.added);
  }
  return base;
};

const sources = (roll: (limit: number) => number) => {
  const deferred: PromiseWithResolvers<number>[] = [];
  const make = () => {
    const kind = roll(6);
    if (kind === 0) return undefined;
    if (kind === 1) return roll(100);
    if (kind === 2) return [roll(9), roll(9)][Symbol.iterator]();
    if (kind === 3)
      return (async function* () {
        yield roll(9);
      })();
    if (kind === 4) return Promise.resolve(roll(9));
    const source = Promise.withResolvers<number>();
    deferred.push(source);
    return source.promise;
  };
  const settle = () => {
    const source = deferred.splice(roll(deferred.length || 1), 1)[0];
    if (roll(2)) source?.resolve(roll(9));
    else source?.reject(new Error("fuzz"));
  };
  return { make, settle };
};

// mapSnapshot runs right after onChanges, so it sees the outputs at each report.
const replayed = (base: () => unknown) => {
  const ops: Op[] = [];
  return {
    onChanges: (list: Op[]) => void ops.push(...list),
    mapSnapshot: (snapshot: unknown) => {
      assert.deepEqual(replay(ops, base()), snapshot);
      return 0;
    },
    autoStart: true,
    autoClose: false,
    backPressure: false,
  } as const;
};

async function arrayRun(seed: number) {
  const roll = random(seed);
  const { make, settle } = sources(roll);
  const model: unknown[] = Array.from({ length: roll(4) }, make);
  const s = select([...model], replayed(() => []) as any) as any;
  const same = (actual: unknown, expected: unknown) =>
    assert.ok(Object.is(actual, expected), `seed ${seed}`);
  const both = (name: string, ...args: unknown[]) => {
    const actual = s[name](...args);
    const expected = (model as any)[name](...args);
    if (Array.isArray(expected)) {
      assert.equal(actual.length, expected.length);
      for (const [index, item] of expected.entries()) same(actual[index], item);
    } else same(actual, expected);
  };

  await setImmediate();
  for (let step = 0; step < steps; step++) {
    const action = roll(9),
      index = roll(model.length + 3);
    if (action === 0) both("push", make(), make());
    else if (action === 1) both("pop");
    else if (action === 2) both("shift");
    else if (action === 3) both("unshift", make());
    else if (action === 4) both("splice", index - 1, roll(3), make());
    else if (action === 5) {
      const source = make();
      s[index] = source;
      if (index > model.length) model.length = index;
      model[index] = source;
    } else if (action === 6) {
      const length = roll(model.length + 3);
      s.length = length;
      model.length = length;
    } else if (action === 7) {
      delete s[index];
      if (index < model.length) model[index] = undefined;
    } else settle();
    if (roll(3) === 0) await setImmediate();
    assert.equal(s.length, model.length);
    for (let i = 0; i < model.length; i++) same(s[i], model[i]);
  }
  await setImmediate();
  assert.ifError(s[CHAN].signal.reason?.reason);
  s[CHAN].close();
}

async function objectRun(seed: number) {
  const roll = random(seed);
  const { make, settle } = sources(roll);
  const keys = ["a", "b", "c", Symbol.for("d")];
  const model: Record<string | symbol, unknown> = { a: make() };
  const s = select({ ...model }, replayed(() => ({})) as any) as any;

  await setImmediate();
  for (let step = 0; step < steps; step++) {
    const key = keys[roll(keys.length)],
      action = roll(3);
    if (action === 0) {
      delete s[key];
      delete model[key];
    } else if (action === 1) {
      const source = make();
      s[key] = source;
      model[key] = source;
    } else settle();
    if (roll(3) === 0) await setImmediate();
    assert.deepEqual(
      Reflect.ownKeys(s).sort(order),
      Reflect.ownKeys(model).sort(order),
    );
    for (const name of keys) assert.ok(Object.is(s[name], model[name]));
  }
  await setImmediate();
  assert.ifError(s[CHAN].signal.reason?.reason);
  s[CHAN].close();
}

const order = (a: PropertyKey, b: PropertyKey) =>
  String(a).localeCompare(String(b));

test("Fuzz SE-091 SE-108 an array shape matches Array, and its operations replay", async () => {
  for (let seed = 0; seed < seeds * 2; seed++) await arrayRun(seed);
});

test("Fuzz SE-086 SE-108 an object shape matches its model, and its operations replay", async () => {
  for (let seed = 0; seed < seeds * 2; seed++) await objectRun(seed);
});
