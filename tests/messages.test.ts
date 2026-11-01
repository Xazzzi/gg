import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyOps,
  CHAN,
  Channel,
  catching,
  feed,
  select,
  spread,
} from "../src/index.ts";

const noop = () => {};
const ch = () => new Channel<any, any>();
const list = () =>
  select([1] as any[], {
    autoStart: true,
    backPressure: false,
    autoClose: false,
  }) as any;

// Messages are not in the spec, but a wrong one is still a defect in a developer-facing error.
const cases: [string, () => unknown, RegExp][] = [
  [
    "applyOps misfit",
    () => applyOps(["a"], [{ op: "delete", key: "0", prev: 1 }]),
    /cannot replay delete on this target/,
  ],
  ["applyOps target", () => applyOps(1 as any, []), /target must be an object/],
  ["applyOps map", () => applyOps([], [], 1 as any), /map must be a function/],
  [
    "applyOps op",
    () => applyOps([], [{ op: "x" } as any], undefined, { eager: true }),
    /unknown operation/,
  ],
  [
    "applyOps move",
    () => applyOps({}, [{ op: "move", order: [] }], undefined, { eager: true }),
    /move needs an array target/,
  ],
  [
    "applyOps splice",
    () =>
      applyOps(
        {},
        [{ op: "splice", start: 0, removed: [], added: [] }],
        undefined,
        { eager: true },
      ),
    /splice needs an array target/,
  ],
  ["sort comparator", () => list().sort(1), /comparator must be a function/],
  [
    "sort mutation",
    () => {
      const s = list();
      s.push(2);
      s.sort(() => s.push(3));
    },
    /A comparator cannot change a select proxy/,
  ],
  [
    "option value",
    () => new Channel({ firstReceive: "x" as any }),
    /Invalid channel option/,
  ],
  [
    "unread pairing",
    () => new Channel({ firstReceive: "latest", thenReceive: "unread" }),
    /requires firstReceive "unread"/,
  ],
  [
    "send thenable",
    () => ch().send({ then() {} }),
    /does not accept thenables/,
  ],
  [
    "close thenable",
    () => ch().close({ then() {} }),
    /does not accept thenables/,
  ],
  [
    "feed null source",
    () => feed(null as any, ch()),
    /feed source is not a promise or iterator/,
  ],
  [
    "feed undefined source",
    () => feed(undefined as any, ch()),
    /feed source is not a promise or iterator/,
  ],
  [
    "feed number channel",
    () => feed([1], 1 as any),
    /feed target is not a Channel/,
  ],
  [
    "feed option",
    () => feed([1], ch(), { autoStart: 1 as any }),
    /Option autoStart must be a boolean/,
  ],
  [
    "catching null source",
    () => catching(null as any, noop),
    /catching source is not a promise or iterator/,
  ],
  [
    "catching onError",
    () => catching([1], 1 as any),
    /catching requires onError/,
  ],
  ["select shape", () => select(1 as any), /select shape must be an object/],
  [
    "select null shape",
    () => select(null as any),
    /select shape must be an object/,
  ],
  [
    "select reserved",
    () => select({ [CHAN]: 1 }),
    /select shape holds a reserved key/,
  ],
  [
    "select option",
    () => select({}, { onChanges: 1 as any }),
    /Option onChanges must be a function/,
  ],
  [
    "proxy define",
    () => Object.defineProperty(list(), "x", { value: 1 }),
    /not supported on a select proxy/,
  ],
  ["length", () => (list().length = -1), /Invalid array length/],
  ["reserved write", () => (list()[CHAN] = 1), /Reserved select key/],
  ["reserved delete", () => delete list()[CHAN], /Reserved select key/],
  ["array key", () => (list().x = 1), /accepts index keys only/],
  [
    "spread collision",
    () =>
      spread({
        a: Object.defineProperty({}, Symbol.for("gg.Val"), { value: true }),
        aDone: 1,
      }),
    /spread field aDone collides/,
  ],
];

for (const [name, run, message] of cases)
  test(`Messages ${name}`, () => assert.throws(run, message));

test("Messages iterator results", async () => {
  const seen: Error[] = [];
  await catching(
    { next: () => 1 } as any,
    error => void seen.push(error as Error),
  ).next();
  const target = new Channel<number>({ firstReceive: "first" });
  await feed({ next: () => 1 } as any, target, { autoStart: true });
  await target[Symbol.asyncIterator]()
    .next()
    .catch(error => seen.push(error));
  for await (const { raw } of select({ raw: { next: () => 1 } }) as any)
    seen.push((raw as any).reason);
  assert.deepEqual(
    seen.map(error => error.message),
    Array(3).fill("Iterator result is not an object"),
  );
});

test("Messages sync iterator thenable", async () => {
  let pulls = 0;
  const raw = {
    next: () => (pulls++ ? Promise.resolve() : { value: 1, done: false }),
  };
  const s: any = select(
    { raw, x: 0 },
    {
      autoStart: true,
      autoClose: false,
      backPressure: false,
      thenReceive: "every",
      firstReceive: "first",
    },
  );
  const it = s[Symbol.asyncIterator]();
  await it.next();
  s.x = 1;
  assert.match(
    (await it.next()).value.raw.reason.message,
    /Sync iterator returned a thenable/,
  );
  s[CHAN].close();
});
