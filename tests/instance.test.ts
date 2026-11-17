import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { Channel, derive, type Instance, StopError } from "../src/index.ts";
import { jsx, mount } from "../src/jsx.ts";
import { fakeDocument, html } from "./dom.ts";

const el = (tag = "div") => fakeDocument.createElement(tag) as any;
const h = (type: any, props: any = {}) => jsx(type, props) as any;
const reported: unknown[] = [];
const stopped = (signal: AbortSignal) =>
  signal.reason instanceof StopError &&
  signal.reason.reason === "component stopped";

test("JX-0C0 JX-0C1 a component with one parameter gets no instance (its length is 1), and a signal is made once, when code reads it", () => {
  const args: unknown[] = [];
  let instance: Instance | undefined;
  h(function One(_: object) {
    // biome-ignore lint/complexity/noArguments: test
    args.push(arguments[1]);
    return null;
  });
  h(function Two(_: object, life: Instance) {
    instance = life;
    return null;
  });
  assert.deepEqual(args, [undefined]);
  const life = instance as Instance;
  assert.equal(life.signal, life.signal);
  assert.equal(life.signal.aborted, false);
});

test("JX-0C2 JX-089 a component that waits in other work gets an abort when its drive lets it go, which no code reports", async t => {
  const report = globalThis.reportError;
  (globalThis as any).reportError = (error: unknown) => reported.push(error);
  t.after(() => (globalThis.reportError = report));
  const log: unknown[] = [];
  async function* Loads(_: object, { signal }: Instance) {
    yield "loading";
    try {
      await new Promise((_, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason)),
      );
    } catch (error) {
      log.push(error instanceof StopError);
      throw error;
    } finally {
      log.push("finally");
    }
  }
  const parent = el(),
    unmount = mount(parent, h(Loads));
  await setImmediate();
  assert.equal(html(parent), "<div>loading</div>");
  unmount();
  await setImmediate();
  assert.deepEqual(log, [true, "finally"]);
  assert.deepEqual(reported, []);
});

test("JX-0C2 a signal aborts when its result finishes, and a later read gives an aborted signal", async () => {
  let life: Instance | undefined;
  const parent = el();
  mount(
    parent,
    h(async (_: object, instance: Instance) => ((life = instance), "done")),
  );
  await setImmediate();
  assert.equal(html(parent), "<div>done</div>");
  assert.ok(stopped((life as Instance).signal));
});

test("JX-0C2 JX-083 a parked component keeps its signal live", async () => {
  let signal: AbortSignal | undefined;
  const view = new Channel<any>({ thenReceive: "latest" }),
    inner = h(async function* Waits(_: object, life: Instance) {
      signal = life.signal;
      yield "in";
      await new Promise(() => {});
    }),
    box = h("p", { children: inner }),
    parent = el();
  mount(parent, view);
  view.send(box);
  await setImmediate();
  assert.equal(html(parent), "<div><p>in</p></div>");
  view.send("out");
  await setImmediate();
  assert.equal(html(parent), "<div>out</div>");
  assert.equal((signal as AbortSignal).aborted, false);
});

test("JX-0C2 HE-059 a builder that stops a component result aborts its signal, also before any drive takes it", async () => {
  const n = new Channel<number>(),
    signals: AbortSignal[] = [];
  const view = derive(n, () =>
    h((_: object, life: Instance) => {
      signals.push(life.signal);
      return (async function* () {
        yield "x";
      })();
    }),
  );
  n.send(1), n.send(2);
  await view.next();
  await view.next();
  assert.ok(stopped(signals[0] as AbortSignal));
  await view.return();
  assert.equal(signals.length, 2);
  assert.ok(stopped(signals[1] as AbortSignal));
});

test("JX-0C2 HE-059 derive stops what a map that throws or rejects built", async () => {
  const n = new Channel<number>(),
    signals: AbortSignal[] = [];
  const Loads = (_: object, life: Instance) => (
    signals.push(life.signal),
    (async function* () {
      yield "x";
    })()
  );
  n.send(1), n.send(2);
  const throws = derive(n, () => {
    h(Loads);
    throw new Error("sync");
  });
  await assert.rejects(throws.next(), /sync/);
  const rejects = derive(n, async () => {
    h(Loads);
    await null;
    throw new Error("async");
  });
  await assert.rejects(rejects.next(), /async/);
  assert.equal(signals.length, 2);
  assert.ok(signals.every(stopped));
});

test("JX-0C3 a component that gives an element aborts when the scope of the element stops, and not when a place removes it", async () => {
  const signals: AbortSignal[] = [];
  const Card = (_: object, life: Instance) => (
    signals.push(life.signal), h("p")
  );
  const Outer = (_: object, life: Instance) => (
    signals.push(life.signal), h(Card)
  );
  const view = new Channel<any>({ thenReceive: "latest" }),
    card = h(Outer),
    parent = el(),
    unmount = mount(parent, view);
  view.send(card);
  await setImmediate();
  assert.equal(html(parent), "<div><p></p></div>");
  view.send("out");
  await setImmediate();
  assert.deepEqual(
    signals.map(signal => signal.aborted),
    [false, false],
  );
  view.send(card);
  await setImmediate();
  h((_: object, life: Instance) => (signals.push(life.signal), card));
  unmount();
  assert.equal(signals.length, 3);
  assert.ok(signals.every(stopped));
  // A stopped scope ran its aborts, so a later component that gives the element waits for a new place.
  h((_: object, life: Instance) => (signals.push(life.signal), card));
  const again = mount(el(), card);
  assert.equal((signals[3] as AbortSignal).aborted, false);
  again();
  assert.ok(stopped(signals[3] as AbortSignal));
});

test("JX-0C3 HE-059 a builder that stops an element before a place aborts the components that gave it", async () => {
  const n = new Channel<number>(),
    signals: AbortSignal[] = [];
  const view = derive(n, () =>
    h((_: object, life: Instance) => (signals.push(life.signal), h("p"))),
  );
  n.send(1), n.send(2);
  await view.next();
  await view.next();
  assert.ok(stopped(signals[0] as AbortSignal));
  assert.equal((signals[1] as AbortSignal).aborted, false);
  await view.return();
  assert.ok(stopped(signals[1] as AbortSignal));
});

test("JX-0C3 a component that gives a static value other than an element never aborts", async () => {
  let signal: AbortSignal | undefined;
  const parent = el(),
    unmount = mount(
      parent,
      h((_: object, life: Instance) => ((signal = life.signal), "text")),
    );
  unmount();
  await setImmediate();
  assert.equal((signal as AbortSignal).aborted, false);
});
