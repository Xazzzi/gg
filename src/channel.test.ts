import * as assert from "node:assert";
import { describe, test } from "node:test";
import { setTimeout } from "node:timers/promises";
import {
  Channel,
  type FirstReceive,
  type StopStyle,
  type ThenReceive,
} from "./channel.ts";
import { assertStatus } from "./utils.test.ts";

type Op =
  | number
  | `+${string}`
  | `?${string}`
  | `${string}=${number | "pending" | "resolved" | "rejected" | "done"}`
  | `!`
  | `!${string}`;

async function runOps(
  config:
    | {
        firstReceive?: FirstReceive;
        thenReceive?: ThenReceive;
        stopStyle?: StopStyle;
      }
    | undefined,
  ops: Op[],
) {
  const ch = config ? new Channel<number>(config) : new Channel<number>();
  const iters: Record<string, AsyncIterator<number>> = {};
  const reqs: Record<string, Promise<IteratorResult<number>>> = {};

  for (const op of ops) {
    if (typeof op === "number") {
      ch.send(op);
    } else if (typeof op === "string" && op.startsWith("!")) {
      const errStr = op.slice(1);
      if (errStr) {
        ch.throw(new Error(errStr));
      } else {
        ch.close();
      }
    } else if (op.startsWith("+")) {
      iters[op.slice(1)] = ch[Symbol.asyncIterator]();
    } else if (op.startsWith("?")) {
      const id = op.slice(1);
      reqs[id] = iters[id].next();
    } else if (op.includes("=")) {
      const [id, exp] = op.split("=");
      if (exp === "pending" || exp === "resolved" || exp === "rejected") {
        await assertStatus(reqs[id], exp);
      } else if (exp === "done") {
        const res = await reqs[id];
        assert.strictEqual(res.done, true, `Expected ${id} to be done`);
      } else {
        const res = await reqs[id];
        assert.strictEqual(
          res.done,
          false,
          `Expected ${id} to yield a value, but got done`,
        );
        assert.strictEqual(
          res.value,
          Number(exp),
          `Expected ${id} to be ${exp}`,
        );
      }
    }
  }
}

// biome-ignore-all format: keep test sequences formats in this suite
describe("Channel Behaviors Matrix", () => {
  describe("FirstReceive = 'first'", () => {
    test("every: tx -> create -> read", () => runOps(
      { firstReceive: 'first', thenReceive: 'every' },
      [1, 2, '+A', '+B', '?A', 'A=1', '?B', 'B=1', '?A', 'A=2', '?B', 'B=2'],
    ));
    test("every: create -> tx -> read", () => runOps(
      { firstReceive: 'first', thenReceive: 'every' },
      ['+A', '+B', 1, 2, '?A', 'A=1', '?B', 'B=1'],
    ));
    test("every: create -> read -> tx", () => runOps(
      { firstReceive: 'first', thenReceive: 'every' },
      ['+A', '+B', '?A', '?B', 1, 'A=1', 'B=1', '?A', '?B', 2, 'A=2', 'B=2'],
    ));
    test("latest: skips intermediate values", () => runOps(
      { firstReceive: 'first', thenReceive: 'latest' },
      ['+A', '?A', 1, 'A=1', 2, 3, '?A', 'A=3'], // Skips 2
    ));
    test("every: late consumer catches up to history", () => runOps(
      { firstReceive: 'first', thenReceive: 'every' },
      ['+A', '?A', 1, 'A=1', 2, '+B', '?B', 'B=1', '?B', 'B=2', '?A', 'A=2'],
    ));
    test("every: interleaved consumer reads", () => runOps(
      { firstReceive: 'first', thenReceive: 'every' },
      [1, '+A', '?A', 'A=1', 2, '+B', '?B', 'B=1', '?A', 'A=2', '?B', 'B=2'],
    ));
    test("latest: skips multiple rapid updates", () => runOps(
      { firstReceive: 'first', thenReceive: 'latest' },
      ['+A', '?A', 1, 'A=1', 2, 3, 4, 5, '?A', 'A=5'],
    ));
  });

  describe("FirstReceive = 'unread'", () => {
    test("every: sequential read with lazy start", () => runOps(
      {firstReceive: 'unread', thenReceive: 'every'},
      [1, 2, '+A', '+B', '?A', 'A=1', '?B', 'B=2', '?A', 'A=2', '?B', 'B=pending', '?A', 'A=pending'],
    ));
    test("every: sequential read with eager start, MPMC", () => runOps(
      {firstReceive: 'unread', thenReceive: 'every'},
      [1, 2, '+A', '+B', '?A', '?B', 'A=1', 'B=1', '?B', 'B=2', '?A', 'A=2'],
    ));
    test("every: sequential read with eager start, MPMC (mixed)", () => runOps(
      {firstReceive: 'unread', thenReceive: 'every'},
      [1, 2, '+A', '?A', 'A=1', '+B', '?B', 'B=2', '?B', 'B=pending', '?A', 'A=2', '?A', 'A=pending'],
    ));
    test("every: MPMC broadcast when blocked concurrently", () => runOps(
      {firstReceive: 'unread', thenReceive: 'every'},
      ['+A', '+B', '?A', '?B', 1, 'A=1', 'B=1', '?A', 'A=pending', '?B', 'B=pending', 2, 'A=2', 'B=2'],
    ));
    test("every: late joiners skip consumed history, but attached consumers receive all subsequent values", () => runOps(
      {firstReceive: 'unread', thenReceive: 'every'},
      [1, 2, 3, '+A', '+B', '+C', '?A', 'A=1', '?B', 'B=2', '?C', 'C=3', '?A', 'A=2', '?A', 'A=3', '?A', 'A=pending'],
    ));
    test("latest: skips unconsumed backlog", () => runOps(
      {firstReceive: 'unread', thenReceive: 'latest'},
      ['+A', '?A', 1, 'A=1', 2, 3, '?A', 'A=3'],
    ));
    test("latest: fast consumer skips backlog while slow consumer processes it", () => runOps(
      {firstReceive: 'unread', thenReceive: 'latest'},
      ['+A', '?A', 'A=pending', 1, 'A=1', 2, 3, '+B', '?B', 'B=2', '?A', 'A=3'],
    ));
  });

  describe("FirstReceive = 'next'", () => {
    test("every: misses past tx, waits for next", () => runOps(
      {firstReceive: 'next', thenReceive: 'every'},
      [1, 2, '+A', '+B', '?A', 'A=pending', '?B', 'B=pending', 3, 'A=3', 'B=3'],
    ));
    test("every: create -> read -> tx", () => runOps(
      {firstReceive: 'next', thenReceive: 'every'},
      ['+A', '+B', '?A', '?B', 1, 'A=1', 'B=1'],
    ));
    test("latest: skips intermediate values", () => runOps(
      {firstReceive: 'next', thenReceive: 'latest'},
      ['+A', '?A', 1, 'A=1', 2, 3, '?A', 'A=3'],
    ));
    test("every: late consumers miss everything", () => runOps(
      {firstReceive: 'next', thenReceive: 'every'},
      [1, 2, 3, '+A', '?A', 'A=pending', 4, 'A=4'],
    ));
    test("every: iterators evaluate start state on first next(), not creation", () => runOps(
      {firstReceive: 'next', thenReceive: 'every'},
      ['+A', 1, '?A', 'A=pending', 2, 'A=2'],
    ));
  });

  describe("FirstReceive = 'latest' (true latest resolved)", () => {
    test("every: immediately yields most recent resolved value", () => runOps(
      {firstReceive: 'latest', thenReceive: 'every'},
      [1, 2, '+A', '?A', 'A=2', '?A', 'A=pending', 3, 'A=3'],
    ));
    test("every: if no resolved value, waits for next", () => runOps(
      {firstReceive: 'latest', thenReceive: 'every'},
      ['+A', '?A', 'A=pending', 1, 'A=1'],
    ));
    test("latest: skips intermediate values", () => runOps(
      {firstReceive: 'latest', thenReceive: 'latest'},
      [1, 2, '+A', '?A', 'A=2', 3, 4, '?A', 'A=4'],
    ));
    test("every: late consumers get only the absolute most recent cached value", () => runOps(
      {firstReceive: 'latest', thenReceive: 'every'},
      [1, 2, 3, '+A', '?A', 'A=3', '?A', 'A=pending', 4, 'A=4'],
    ));
    test("every: eager consumers get the most recent cached value at the time of first .next()", () => runOps(
      {firstReceive: 'latest', thenReceive: 'every'},
      [1, '+A', 2, '?A', 'A=2', '?A', 'A=pending'],
    ));
  });

  describe("StopStyle", () => {
    test("drain: processes remaining queue before closing", () => runOps(
      {firstReceive: 'first', thenReceive: 'every', stopStyle: 'drain'},
      [1, 2, '!', '+A', '?A', 'A=1', '?A', 'A=2', '?A', 'A=done'],
    ));
    test("drain + latest: naturally jumps to last available value before close", () => runOps(
      {firstReceive: 'first', thenReceive: 'latest', stopStyle: 'drain'},
      ['+A', '?A', 1, 'A=1', 2, 3, '!', '?A', 'A=3', '?A', 'A=done'],
    ));
    test("stop: terminates immediately skipping remaining queue", () => runOps(
      {firstReceive: 'first', thenReceive: 'every', stopStyle: 'stop'},
      [1, 2, '!', '+A', '?A', 'A=done'],
    ));
    test("stop: mid-flight consumer exits instantly on next iteration", () => runOps(
      {firstReceive: 'first', thenReceive: 'every', stopStyle: 'stop'},
      [1, 2, '+A', '?A', '!', 'A=1', '?A', 'A=done'],
    ));
    test("stop: waiting consumer rejects and closes cleanly", () => runOps(
      {firstReceive: 'next', thenReceive: 'every', stopStyle: 'stop'},
      ['+A', '?A', '!', 'A=done'],
    ));
    test("drain: calling next after done repeatedly returns done", () => runOps(
      {firstReceive: 'first', thenReceive: 'every', stopStyle: 'drain'},
      [1, '!', '+A', '?A', 'A=1', '?A', 'A=done', '?A', 'A=done'],
    ));
    test("stop: calling next after done repeatedly returns done", () => runOps(
      {firstReceive: 'first', thenReceive: 'every', stopStyle: 'stop'},
      [1, '!', '+A', '?A', 'A=done', '?A', 'A=done'],
    ));
    test("drain: throws error if aborted while suspended on yield", () => runOps(
      {firstReceive: 'first', thenReceive: 'every', stopStyle: 'drain'},
      [1, 2, '+A', '?A', 'A=1', '!BOOM', '?A', 'A=2', '?A', 'A=rejected'],
    ));
    test("drain + latest: evaluates last available value before throwing error", () => runOps(
      {firstReceive: 'first', thenReceive: 'latest', stopStyle: 'drain'},
      [1, 2, 3, '+A', '?A', 'A=1', '!BOOM', '?A', 'A=3', '?A', 'A=rejected'],
    ));
    test("drain + latest: evaluates last available value if next is called before abort", () => runOps(
      {firstReceive: 'first', thenReceive: 'latest', stopStyle: 'drain'},
      [1, 2, 3, '+A', '?A', 'A=1', '?A', '!BOOM', 'A=3', '?A', 'A=rejected'],
    ));
    test("drain: throws error if aborted while waiting for next value", () => runOps(
      {firstReceive: 'first', thenReceive: 'every', stopStyle: 'drain'},
      ['+A', '?A', 1, 'A=1', '?A', 'A=pending', '!BOOM', 'A=rejected'],
    ));
    test("stop: ignores error if aborted while suspended on yield", () => runOps(
      {firstReceive: 'first', thenReceive: 'every', stopStyle: 'stop'},
      [1, 2, '+A', '?A', 'A=1', '!BOOM', '?A', 'A=done'],
    ));
    test("stop: throws error if aborted while waiting for next value", () => runOps(
      {firstReceive: 'first', thenReceive: 'every', stopStyle: 'stop'},
      ['+A', '?A', 1, 'A=1', '?A', 'A=pending', '!BOOM', 'A=rejected'],
    ));

    // Matrix on firstReceive interacting with aborts
    test("drain + firstReceive=latest: yields last available value before rejecting if joined after abort", () => runOps(
      {firstReceive: 'latest', thenReceive: 'every', stopStyle: 'drain'},
      [1, 2, '!BOOM', '+A', '?A', 'A=2', '?A', 'A=rejected'],
    ));
    test("stop + firstReceive=latest: returns done immediately if joined after abort", () => runOps(
      {firstReceive: 'latest', thenReceive: 'every', stopStyle: 'stop'},
      [1, 2, '!BOOM', '+A', '?A', 'A=done'],
    ));
    test("drain + firstReceive=next: rejects immediately if joined after abort", () => runOps(
      {firstReceive: 'next', thenReceive: 'every', stopStyle: 'drain'},
      [1, 2, '!BOOM', '+A', '?A', 'A=rejected'],
    ));
    test("stop + firstReceive=next: returns done immediately if joined after abort", () => runOps(
      {firstReceive: 'next', thenReceive: 'every', stopStyle: 'stop'},
      [1, 2, '!BOOM', '+A', '?A', 'A=done'],
    ));
    test("drain + firstReceive=unread: consumes entire backlog before rejecting if joined after abort", () => runOps(
      {firstReceive: 'unread', thenReceive: 'every', stopStyle: 'drain'},
      [1, 2, '!BOOM', '+A', '?A', 'A=1', '?A', 'A=2', '?A', 'A=rejected'],
    ));
    test("stop + firstReceive=unread: returns done immediately if joined after abort", () => runOps(
      {firstReceive: 'unread', thenReceive: 'every', stopStyle: 'stop'},
      [1, 2, '!BOOM', '+A', '?A', 'A=done'],
    ));

    // Interleaved consumers
    test("drain: multiple interleaved consumers handle backlog and errors properly", () => runOps(
      {firstReceive: 'unread', thenReceive: 'every', stopStyle: 'drain'},
      ['+A', '+B', '?A', '?B', 1, 'A=1', 'B=1', '?A', 'A=pending', 2, 'A=2', '?A', 'A=pending', '!BOOM', 'A=rejected', '?B', 'B=2', '?B', 'B=rejected']
    ));
    test("drain + latest: multiple interleaved consumers skip correctly before rejection", () => runOps(
      {firstReceive: 'unread', thenReceive: 'latest', stopStyle: 'drain'},
      [1, '+A', '?A', 'A=1', 2, 3, '!BOOM', '+B', '?B', 'B=2', '?B', 'B=3', '?B', 'B=rejected', '?A', 'A=3', '?A', 'A=rejected']
    ));
  });

  describe("Edge cases", () => {
    test("ch.closed promise resolves when channel is closed", async () => {
      const ch = new Channel<number>();
      const p = ch.closed;
      await assertStatus(p, 'pending');
      ch.close();
      await assertStatus(p, 'resolved');
    });

    test("invalid firstReceive throws unreachable", async () => {
      const ch = new Channel<number>({ firstReceive: "invalid" as any });
      await assert.rejects(ch[Symbol.asyncIterator]().next(), /Unreachable branch did evaluate/);
    });

    test("default constructor arguments", () => runOps(
      undefined,
      [
        // Proves firstReceive defaults to "unread" (A gets 1, B gets 2)
        // Proves thenReceive defaults to "latest" (A skips 2 to get 3)
        1, '+A', '?A', 'A=1', '+B', 2, '?B', 'B=2',
        3, '?A', 'A=3',
        // Proves stopStyle defaults to "drain"
        4, '!', '?B', 'B=4', '?B', 'B=done',
      ],
    ));

    test("unread: attached consumers reading history do not move rxHead backwards", () => runOps(
      {firstReceive: 'unread', thenReceive: 'every'},
      [
        1, 2, 3, '+A', '?A', 'A=1', '+B', '?B', 'B=2', '?B', 'B=3',
        // rxHead is now at P4 (after 3). A is still at P2.
        '?A', 'A=2', // A reads 2. This must NOT move rxHead back to P3!
        '+C', '?C', 'C=pending', // If rxHead was incorrectly moved back, C would get 3.
      ],
    ));

    test("send() after dispose() throws", () => {
      const ch = new Channel<number>();
      ch[Symbol.dispose]();
      assert.throws(() => ch.send(1));
    });

    test("MPMC broadcast handles dispose cleanly", () => runOps(
      { firstReceive: 'unread', thenReceive: 'every', stopStyle: 'drain' },
      ['+A', '+B', '?A', '?B', '!', 'A=done', 'B=done'],
    ));

    test("unreachable throws on invalid config", async () => {
      const ch = new Channel<number>({ firstReceive: "INVALID" as FirstReceive });
      const iter = ch[Symbol.asyncIterator]();
      await assert.rejects(iter.next(), /Unreachable branch/);
    });

    test("channel.throw() triggers defensive rethrow", () => runOps(
      undefined,
      ['+A', '?A', '!BOOM', 'A=rejected'],
    ));

    test("iter.throw() triggers defensive rethrow", async () => {
      const ch = new Channel<number>();
      const iter = ch[Symbol.asyncIterator]();
      const p = iter.next();
      ch.send(1);
      await p; // Generator must be suspended on yield, otherwise iter.throw() queues behind iter.next()

      const err = new Error("generator throw");
      await assert.rejects(iter.throw(err), err);
    });

    test("latest configurations garbage collect intermediate promises when consumer is busy", async () => {
      if (typeof global.gc !== "function") return; // Skip if not running with --expose-gc

      const ch = new Channel<object>({ firstReceive: "next", thenReceive: "latest" });
      const iter = ch[Symbol.asyncIterator]();

      // Consumer awaits first item, holding a reference to Promise 1 in its closure
      const _first = iter.next();
      ch.send({ name: "first" }); // Resolves Promise 1

      // Send the object we want to track (Promise 2)
      let obj: object | null = { name: "leaked" };
      const ref = new WeakRef(obj);
      ch.send(obj); // Resolves Promise 2 with [obj, Promise 3] (if mutant active)
      obj = null; // Drop our strong reference

      // Send one more to move this.#latest to Promise 3
      ch.send({ name: "latest" });

      // const advance = iter.next();

      // Force V8 GC a few times to ensure sweep happens
      global.gc();
      await setTimeout(100);
      global.gc();

      // If the GC chain optimization is active, Promise 1 -> [first, undefined]
      // Promise 2 and obj are completely unreferenced and should be null
      assert.strictEqual(ref.deref(), undefined, "Memory leak detected in latest channel! Intermediate promises are not being garbage collected.");
    });
  });

  describe("asend", () => {
    test("blocks until consumer reads the value", async () => {
      const ch = new Channel<number>();
      let resolved = false;

      const p = ch.asend(42).then(() => {
        resolved = true;
      });

      await setTimeout(10);
      assert.strictEqual(resolved, false, "asend should block if no consumer is reading");

      const iter = ch[Symbol.asyncIterator]();
      const first = await iter.next(); // pulls 42 and immediately unlocks producer

      await p; // Should resolve immediately without waiting for the next pull
      assert.strictEqual(resolved, true, "asend should resolve immediately upon read");
      assert.deepEqual(first.value, 42);

      ch.close();
    });

    test("skipped values unlock when a subsequent value is read", async () => {
      const ch = new Channel<number>({ firstReceive: 'latest' });
      let resolved1 = false;
      let resolved2 = false;

      ch.asend(1).then(() => { resolved1 = true; });
      ch.asend(2).then(() => { resolved2 = true; });

      await setTimeout(10);
      assert.strictEqual(resolved1, false);
      assert.strictEqual(resolved2, false);

      const iter = ch[Symbol.asyncIterator]();
      const v = await iter.next(); // skips 1, reads 2. Both should unlock!
      assert.strictEqual(v.value, 2);

      await setTimeout(10);
      assert.strictEqual(resolved1, true, "Skipped asend should resolve when subsequent value is read");
      assert.strictEqual(resolved2, true, "Consumed asend should resolve");

      ch.close();
    });

    test("resolves even if consumer breaks early", async () => {
      const ch = new Channel<number>();
      let resolved = false;

      const p = ch.asend(42).then(() => { resolved = true; });

      const iter = ch[Symbol.asyncIterator]();
      const v = await iter.next(); // reads 42, unlocks producer
      assert.strictEqual(v.value, 42);

      await iter.return(); // break loop

      await p;
      assert.strictEqual(resolved, true, "asend should resolve because the value was successfully read before the break");
    });

    test("resolves not before the value is pulled", async () => {
      const ch = new Channel<number>({ thenReceive: "every" });
      const p = ch.asend(42);

      const iter = ch[Symbol.asyncIterator]();
      await assertStatus(p, "pending");
      await iter.next(); // pulls 42
      await assertStatus(p, "resolved");
    });

    test("does not prematurely resolve newer promises when reading older values", async () => {
      const ch = new Channel<number>({ thenReceive: "every" });
      const iter = ch[Symbol.asyncIterator]();

      const p1 = ch.asend(1);
      const p2 = ch.asend(2); // Map now has {1: ref1, 2: ref2}

      await iter.next(); // pulls 1. Map iteration should break before resolving p2!
      await assertStatus(p1, "resolved");
      await assertStatus(p2, "pending");

      await iter.next(); // pulls 2.
      await assertStatus(p2, "resolved");
    });

    test("gracefully handles garbage collected asend promises", async () => {
      if (typeof global.gc !== "function") return; // Skip if not running with --expose-gc

      const ch = new Channel<number>();

      // Create an asend promise but don't hold a reference to it
      (async () => {
        ch.asend(42);
      })();

      global.gc(); // Force GC so the Promise and its resolve function are collected
      await setTimeout(100);
      global.gc(); // Force GC so the Promise and its resolve function are collected

      const iter = ch[Symbol.asyncIterator]();
      const v = await iter.next(); // Reads 42, iterates Map. ref.deref() will be undefined!
      assert.strictEqual(v.value, 42);
    });
  });

  test("throw custom reason", async () => {
    const ch = new Channel();
    const iter = ch[Symbol.asyncIterator]();
    ch.throw("custom boom");
    try {
      await iter.next();
      assert.fail("Should have thrown");
    } catch (e) {
      assert.strictEqual(e, "custom boom");
      assert.strictEqual(ch.signal.reason, "custom boom");
    }
  });

  test("close sets reason to Channel closed", () => {
    const ch = new Channel();
    ch.close();
    assert.strictEqual(ch.signal.reason, "Channel closed");
  });
});
