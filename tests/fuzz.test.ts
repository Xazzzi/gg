import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import {
  CHAN,
  Channel,
  type ChannelOptions,
  changes,
  type Op,
  select,
  watch,
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
    else if (op.op === "move") {
      const old = [...base];
      op.order.forEach((from, to) => {
        base[to] = old[from];
      });
    } else base.splice(op.start, op.removed.length, ...op.added);
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
const replayed = (base: () => unknown, seen?: (snapshot: any) => void) => {
  const ops: Op[] = [];
  return {
    onChanges: (list: Op[]) => void ops.push(...list),
    mapSnapshot: (snapshot: unknown) => {
      assert.deepEqual(replay(ops, base()), snapshot);
      seen?.(snapshot);
      return 0;
    },
    autoStart: true,
    autoClose: false,
    backPressure: false,
  } as const;
};

// Follows a slice reader and a watch of the slots that random indexes name, as a model of slot identities says.
const sliced = (s: any, ids: unknown[], roll: (limit: number) => number) => {
  const indexes = Array.from({ length: roll(3) }, () => roll(ids.length + 2)),
    chosen = new Set(indexes.map(index => ids[index]).filter(id => id)),
    watched = ids[indexes[0] ?? 0],
    reader = changes(s, indexes);
  const mirror: unknown[] = [...reader.outputs];
  let seen: unknown,
    gone = false;
  void (async () => {
    for await (const ops of reader) replay(ops, mirror);
  })();
  void (async () => {
    for await (const value of watch(s, indexes[0] ?? 0)) seen = value;
    gone = true;
  })();
  return (outputs: unknown[]) => {
    const expected = ids.flatMap((id, index) =>
      chosen.has(id) ? [outputs[index]] : [],
    );
    assert.deepEqual(mirror, expected);
    const at = ids.indexOf(watched);
    if (watched && at >= 0) assert.ok(Object.is(seen, outputs[at]));
    else assert.ok(gone);
  };
};

/** Replays an array action onto slot identities, where a new slot gets a new id. */
const identities = () => {
  let next = 1;
  const fresh = (count: number) =>
    Array.from({ length: Math.max(count, 0) }, () => next++);
  return { fresh };
};

async function arrayRun(seed: number) {
  const roll = random(seed);
  const { make, settle } = sources(roll);
  const model: unknown[] = Array.from({ length: roll(4) }, make);
  const { fresh } = identities(),
    ids: unknown[] = fresh(model.length);
  let outputs: unknown[] = [];
  const s = select(
    [...model],
    replayed(
      () => [],
      snapshot => (outputs = snapshot),
    ) as any,
  ) as any;
  // A range that an Array method replaces with new slots, from a marked copy of the ids
  const replaced = (name: string, ...args: unknown[]) => {
    const marks = ids.map(() => 0) as any;
    marks[name](1, ...args);
    marks.forEach((mark: number, index: number) => {
      if (mark) ids[index] = fresh(1)[0];
    });
  };
  let check = roll(2) ? sliced(s, ids, roll) : undefined;
  const both = (name: string, ...args: unknown[]) => {
    const actual = s[name](...args);
    const expected = (model as any)[name](...args);
    if (Array.isArray(expected)) {
      assert.equal(actual.length, expected.length);
      for (const [index, item] of expected.entries()) same(actual[index], item);
    } else same(actual, expected);
  };
  const same = (actual: unknown, expected: unknown) =>
    assert.ok(Object.is(actual, expected), `seed ${seed}`);

  await setImmediate();
  for (let step = 0; step < steps; step++) {
    const action = roll(12),
      index = roll(model.length + 3);
    if (action === 8) both("reverse"), ids.reverse();
    else if (action === 10) {
      const args = [index - 1, roll(5) - 1, roll(5)];
      both("copyWithin", ...args);
      const marks = ids.map((_, i) => i);
      marks.copyWithin(...(args as [number, number, number]));
      marks.forEach((from, i) => {
        if (from !== i) ids[i] = fresh(1)[0];
      });
    } else if (action === 9) {
      const args = [index - 1, roll(5) - 1];
      both("fill", make(), ...args);
      replaced("fill", ...args);
    } else if (action === 0)
      both("push", make(), make()), ids.push(...fresh(2));
    else if (action === 1) both("pop"), ids.pop();
    else if (action === 2) both("shift"), ids.shift();
    else if (action === 3) both("unshift", make()), ids.unshift(...fresh(1));
    else if (action === 4) {
      const args = [index - 1, roll(3)] as const;
      both("splice", ...args, make());
      ids.splice(...args, ...fresh(1));
    } else if (action === 5) {
      const source = make();
      s[index] = source;
      if (index >= model.length) ids.push(...fresh(index - model.length + 1));
      if (index > model.length) model.length = index;
      model[index] = source;
    } else if (action === 6) {
      const length = roll(model.length + 3);
      s.length = length;
      ids.push(...fresh(length - ids.length));
      ids.length = length;
      model.length = length;
    } else if (action === 7) {
      delete s[index];
      if (index < model.length) model[index] = undefined;
    } else settle();
    if (roll(3) === 0) {
      await setImmediate();
      check?.(outputs);
      if (!roll(4)) check = sliced(s, ids, roll);
    }
    assert.equal(s.length, model.length);
    for (let i = 0; i < model.length; i++) same(s[i], model[i]);
  }
  await setImmediate();
  check?.(outputs);
  assert.ifError(s[CHAN].signal.reason?.reason);
  s[CHAN].close();
}

async function objectRun(seed: number) {
  const roll = random(seed);
  const { make, settle } = sources(roll);
  const keys = ["a", "b", "c", Symbol.for("d")];
  const model: Record<string | symbol, unknown> = { a: make() };
  let outputs: any = {};
  const s = select(
    { ...model },
    replayed(
      () => ({}),
      snapshot => (outputs = snapshot),
    ) as any,
  ) as any;
  const chosen = keys.filter(() => roll(2)),
    reader = changes(s, chosen),
    mirror: any = { ...reader.outputs };
  void (async () => {
    for await (const ops of reader) replay(ops, mirror);
  })();
  const check = () =>
    assert.deepEqual(
      mirror,
      Object.fromEntries(
        chosen.filter(key => key in outputs).map(key => [key, outputs[key]]),
      ),
    );

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
    if (roll(3) === 0) await setImmediate(), check();
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

test("Fuzz SE-091 SE-108 SE-154 SE-163 an array shape matches Array, and its operations, slices and watches replay", async () => {
  for (let seed = 0; seed < seeds * 2; seed++) await arrayRun(seed);
});

test("Fuzz SE-086 SE-108 SE-153 an object shape matches its model, and its operations and slices replay", async () => {
  for (let seed = 0; seed < seeds * 2; seed++) await objectRun(seed);
});
