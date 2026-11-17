import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { inspect } from "node:util";
import { applyOutput, drive, type Entry } from "../src/host.ts";
import { Channel, derive, iff, select } from "../src/index.ts";
import { Catch, each, type Item, jsx, mount } from "../src/jsx.ts";
import { FakeElement, fakeDocument, html } from "./dom.ts";

const el = (tag = "div") => fakeDocument.createElement(tag) as any;
const h = (type: any, props: any = {}) => jsx(type, props) as any;
const collect = globalThis.gc as () => void;
// One gc may keep garbage, as Stryker runs show, so this collects until ref is empty, in a new job each time.
const freed = async (ref: WeakRef<object>) => {
  for (let i = 0; i < 20; i++) {
    await setImmediate();
    collect();
    if (!ref.deref()) return true;
  }
  return false;
};
const reported: unknown[] = [];
const latest = <T>() =>
  new Channel<T>({ firstReceive: "latest", thenReceive: "latest" });

// Captures the channel of each select, through the devtools hook.
const HOOK = Symbol.for("gg.devtools");
const selects = async (run: () => unknown) => {
  const channels: Channel<unknown>[] = [];
  (globalThis as any)[HOOK] = (kind: string, _: object, detail: any) => {
    if (kind === "select") channels.push(detail.channel);
  };
  try {
    await run();
  } finally {
    delete (globalThis as any)[HOOK];
  }
  return channels;
};
const aborted = (channels: Channel<unknown>[]) =>
  channels.map(channel => channel.signal.aborted);

// A queue that a drive reads, with the counts of its pulls and of its returns.
const counted = <T = string>() => {
  const queue = new Channel<T>(),
    stats = { pulls: 0, returns: 0, opened: 0 };
  return Object.assign(queue, {
    stats,
    source: {
      [Symbol.asyncIterator]() {
        stats.opened++;
        const iterator = queue[Symbol.asyncIterator]();
        return {
          next: () => (stats.pulls++, iterator.next()),
          return: () => (stats.returns++, iterator.return(undefined)),
        };
      },
    },
  });
};
// Mounts one dynamic child that shows what code sends.
const stage = () => {
  const parent = el(),
    view = latest<any>();
  return { parent, view, unmount: mount(parent, view) };
};
const show = async (view: Channel<any>, value: unknown) => {
  view.send(value);
  await setImmediate();
};

test("JX-080 JX-081 an element that left the tree stops with the mount under which it started", async () => {
  const text = latest<string>();
  text.send("t");
  const kept = h("b", { title: text, children: text });
  let s!: ReturnType<typeof stage>;
  const channels = await selects(async () => {
    s = stage();
    await show(s.view, kept);
    await show(s.view, "x");
  });
  assert.equal(html(s.parent), "<div>x</div>");
  assert.deepEqual(aborted(channels), [false, false, false]);
  s.unmount();
  assert.deepEqual(aborted(channels), [true, true, true]);
});

test("JX-080 an element binds to the closest started element above it, and stops with it", async () => {
  const text = latest<string>(),
    items = select(["a"], { autoStart: true, backPressure: false });
  text.send("t");
  const inner = h("i", { children: text }),
    row = h("li", { title: text, children: h("span", { children: inner }) });
  let s!: ReturnType<typeof stage>;
  const channels = await selects(async () => {
    s = stage();
    await show(s.view, h("ul", { children: each(items, () => row) }));
  });
  // The stage, the list host, the each drive, the props of the row, and the host of inner.
  assert.equal(channels.length, 5);
  // The row holds inner through its span, so the row that leaves stops both.
  items.pop();
  await setImmediate();
  assert.deepEqual(aborted(channels), [false, false, false, true, true]);
});

test("JX-081 an element whose drives finish leaves its scope, and the scopes that it leaves empty follow", async () => {
  const s = stage(),
    gate = Promise.withResolvers<string>();
  let outer: any = h("p", {
      title: Promise.resolve("t"),
      children: h("b", { children: gate.promise }),
    }),
    alone: any = h("i", { children: Promise.resolve("x") });
  const refs = [new WeakRef(outer), new WeakRef(alone)];
  await show(s.view, [outer, alone]);
  await show(s.view, "gone");
  outer = alone = undefined;
  // The host of b still runs under p, so the scope of p stays, and the scope of i left.
  assert.equal(await freed(refs[1]), true);
  assert.notEqual(refs[0].deref(), undefined);
  gate.resolve("late");
  assert.equal(await freed(refs[0]), true);
  s.unmount();
});

test("JX-081 a mount into an element binds to the scope above it, and a mount again stops what started under the first", async () => {
  const text = latest<string>();
  text.send("t");
  const box = el("section");
  let s!: ReturnType<typeof stage>, inner!: () => void;
  const channels = await selects(async () => {
    s = stage();
    await show(s.view, box);
    inner = mount(box, h("b", { children: text }), text);
    await setImmediate();
  });
  assert.equal(html(s.parent), "<div><section><b>t</b>t</section></div>");
  assert.deepEqual(aborted(channels), [false, false, false]);
  mount(box, h("i", { title: text }));
  await setImmediate();
  assert.deepEqual(aborted(channels), [false, true, true]);
  const again = await selects(async () => {
    mount(box, h("u", { children: text }));
    await setImmediate();
  });
  s.unmount();
  assert.deepEqual(aborted(again), [true]);
  inner();
});

test("JX-082 JX-083 a place parks an element that it removes, and resumes it when it places it again", async () => {
  const s = stage(),
    child = counted(),
    title = counted(),
    kept = h("b", { title: title.source, children: child.source });
  await show(s.view, kept);
  child.send("1");
  title.send("a");
  await setImmediate();
  assert.equal(html(s.parent), '<div><b title="a">1</b></div>');
  assert.deepEqual([child.stats.pulls, title.stats.pulls], [2, 2]);
  await show(s.view, "x");
  // The pull that was pending gives one value, and no pull follows.
  child.send("2");
  title.send("b");
  await setImmediate();
  child.send("3");
  title.send("c");
  await setImmediate();
  assert.equal(html(kept), '<b title="b">2</b>');
  assert.deepEqual([child.stats.pulls, title.stats.pulls], [2, 2]);
  await show(s.view, kept);
  await setImmediate();
  assert.equal(html(s.parent), '<div><b title="c">3</b></div>');
  assert.deepEqual([child.stats.pulls, title.stats.pulls], [4, 4]);
  // A resume with no held pull changes nothing.
  await show(s.view, "x");
  await show(s.view, kept);
  assert.deepEqual([child.stats.pulls, title.stats.pulls], [4, 4]);
  s.unmount();
});

test("JX-082 a parked element parks the elements that started under it, and a resume keeps the ones that are off", async () => {
  const s = stage(),
    inside = latest<any>(),
    a = counted(),
    b = counted(),
    viewA = h("i", { children: a.source }),
    viewB = h("u", { children: b.source }),
    outer = h("section", { children: [inside, viewB] });
  await show(s.view, outer);
  await show(inside, viewA);
  assert.deepEqual([a.stats.pulls, b.stats.pulls], [1, 1]);
  // viewA leaves outer, then outer leaves the stage and comes back.
  await show(inside, "none");
  await show(s.view, "x");
  a.send("1"), a.send("2"), b.send("1"), b.send("2");
  await setImmediate();
  assert.deepEqual([a.stats.pulls, b.stats.pulls], [1, 1]);
  await show(s.view, outer);
  await setImmediate();
  assert.deepEqual([a.stats.pulls, b.stats.pulls], [1, 3]);
  assert.equal(html(outer), "<section>none<u>2</u></section>");
  await show(inside, viewA);
  await setImmediate();
  assert.deepEqual([a.stats.pulls, b.stats.pulls], [3, 3]);
  // An element that comes back under a parked element stays parked.
  await show(inside, "none");
  await show(s.view, "x");
  await show(inside, viewA);
  a.send("3"), a.send("4");
  await setImmediate();
  assert.equal(a.stats.pulls, 3);
  await show(s.view, outer);
  await setImmediate();
  assert.equal(html(outer), "<section><i>4</i><u>2</u></section>");
  s.unmount();
});

test("JX-082 an element that a parked host places starts when the host resumes", async () => {
  const s = stage(),
    inside = latest<any>(),
    text = latest<string>(),
    outer = h("section", { children: inside });
  text.send("t");
  await show(s.view, outer);
  await show(s.view, "x");
  const channels = await selects(async () => {
    await show(inside, h("b", { children: text }));
    assert.equal(html(outer), "<section><b></b></section>");
  });
  assert.equal(channels.length, 0);
  const started = await selects(() => show(s.view, outer));
  assert.equal(started.length, 1);
  assert.equal(html(s.parent), "<div><section><b>t</b></section></div>");
  s.unmount();
});

test("JX-082 a mount into a parked element pulls nothing until the element resumes", async () => {
  const s = stage(),
    child = counted(),
    box = el("section"),
    outer = h("p", { title: latest(), children: box });
  await show(s.view, outer);
  await show(s.view, "x");
  mount(box, child.source);
  child.send("1"), child.send("2");
  await setImmediate();
  await setImmediate();
  // A drive that starts parked pulls nothing.
  assert.equal(html(box), "<section></section>");
  assert.equal(child.stats.pulls, 0);
  await show(s.view, outer);
  await setImmediate();
  await setImmediate();
  assert.equal(html(box), "<section>2</section>");
  s.unmount();
  assert.equal(child.stats.returns, 1);
});

test("JX-084 an each parks the drive of its rows with its host, and starts in a parked host only at the resume", async () => {
  const s = stage(),
    items = select(["a"], { autoStart: true, backPressure: false }),
    row = counted(),
    list = h("ul", { children: each(items, () => row.source) });
  await show(s.view, list);
  row.send("1");
  await setImmediate();
  assert.equal(html(list), "<ul>1</ul>");
  assert.equal(row.stats.pulls, 2);
  await show(s.view, "x");
  row.send("2"), row.send("3");
  await setImmediate();
  await setImmediate();
  assert.equal(row.stats.pulls, 2);
  await show(s.view, list);
  await setImmediate();
  assert.equal(html(list), "<ul>3</ul>");
  // A list that a mount puts into a parked element.
  const late = counted(),
    box = el("ol"),
    outer = h("p", { title: latest(), children: box });
  await show(s.view, outer);
  await show(s.view, "x");
  mount(
    box,
    each(items, () => late.source),
  );
  late.send("1"), late.send("2");
  await setImmediate();
  await setImmediate();
  assert.equal(late.stats.pulls, 0);
  await show(s.view, outer);
  await setImmediate();
  await setImmediate();
  assert.equal(html(box), "<ol>2</ol>");
  s.unmount();
});

test("JX-035 an entry that leaves stops the elements under the nodes that its child gave before", async () => {
  const text = latest<string>(),
    swap = latest<number>(),
    items = select(["a"], { autoStart: true, backPressure: false });
  text.send("t");
  const tops = [
    h("li", { children: h("b", { children: text }) }),
    h("li", { title: text }),
    h("li", {}),
  ];
  async function* Row() {
    for await (const at of swap) yield tops[at];
  }
  const parent = el("ul");
  const channels = await selects(async () => {
    mount(
      parent,
      each(items, () => Row()),
    );
    for (const at of [0, 1, 2, 1, 2]) await show(swap, at);
  });
  assert.equal(html(parent), "<ul><li></li></ul>");
  assert.deepEqual(aborted(channels), [false, false, false, false]);
  items.pop();
  await setImmediate();
  assert.deepEqual(aborted(channels), [false, false, true, true]);
});

test("JX-085 an output with dynamic children drives each of them as a part, in order", async () => {
  const s = stage(),
    word = latest<string>(),
    inner = latest<any>();
  async function* Twice() {
    yield "one";
    yield [h("b", { children: "two" }), inner, "!"];
  }
  await show(s.view, ["<", Twice(), "-", word, Promise.resolve("p"), ">"]);
  assert.equal(html(s.parent), "<div><<b>two</b>!-p></div>");
  await show(word, "w");
  await show(inner, h("i", { children: word }));
  assert.equal(html(s.parent), "<div><<b>two</b><i>w</i>!-wp></div>");
  await show(word, "v");
  assert.equal(html(s.parent), "<div><<b>two</b><i>v</i>!-vp></div>");
  await show(s.view, "plain");
  assert.equal(html(s.parent), "<div>plain</div>");
  s.unmount();
});

test("JX-083 JX-086 a drive that parks after the report that added a part opens the part only at the resume", async () => {
  let opened = 0;
  async function* part() {
    opened++;
    yield "p";
  }
  // A place of another host can park the drive between two flushes, so the next flush finds the part not pulled.
  const host = drive<Entry>(
    {},
    applyOutput,
    () => {},
    true,
    error => {
      throw error;
    },
  );
  async function* outer() {
    yield ["x", part()];
    host.park(true); // Runs in step 6 of the flush that added the part
    yield "y";
  }
  host.add({ nodes: [], source: outer() });
  for (let i = 0; i < 5; i++) await setImmediate();
  assert.equal(opened, 0);
  host.park(false);
  await setImmediate();
  assert.equal(opened, 1);
  host.stop();
});

test("JX-086 a part that leaves the output parks, and resumes with no lost value when the output holds it again", async () => {
  const s = stage(),
    a = counted(),
    sub = counted();
  async function* Outer() {
    for await (const value of a.source) yield [value, sub.source];
  }
  const outer = Outer();
  await show(s.view, ["[", outer, "]"]);
  a.send("a1");
  await setImmediate();
  sub.send("s1");
  await setImmediate();
  assert.equal(html(s.parent), "<div>[a1s1]</div>");
  assert.deepEqual([a.stats.pulls, sub.stats.pulls], [2, 2]);
  await show(s.view, "none");
  a.send("a2"), a.send("a3"), sub.send("s2"), sub.send("s3");
  await setImmediate();
  await setImmediate();
  // Each pending pull gave its value, and the parked parts pull no more.
  assert.equal(html(s.parent), "<div>none</div>");
  assert.deepEqual([a.stats.pulls, sub.stats.pulls], [2, 2]);
  await show(s.view, ["(", outer, ")"]);
  await setImmediate();
  await setImmediate();
  assert.equal(html(s.parent), "<div>(a3s3)</div>");
  assert.equal(sub.stats.opened, 1);
  s.unmount();
  await setImmediate();
  // The read of a in Outer pends, so the return of Outer waits behind it (JX-041).
  assert.deepEqual([a.stats.returns, sub.stats.returns], [0, 1]);
});

test("JX-086 a host that stops returns its parked parts, and a part that finished keeps its nodes", async () => {
  const s = stage(),
    parked = counted(),
    done = Promise.resolve("done");
  async function* Once() {
    yield "once";
  }
  const once = Once();
  await show(s.view, [parked.source, once, done]);
  assert.equal(html(s.parent), "<div>oncedone</div>");
  await show(s.view, "none");
  await show(s.view, [once, done]);
  assert.equal(html(s.parent), "<div>oncedone</div>");
  assert.equal(parked.stats.returns, 0);
  s.unmount();
  assert.equal(parked.stats.returns, 1);
});

test("JX-087 an output that holds its own source, or a bad child after a dynamic child, reports and keeps the nodes", async () => {
  reported.length = 0;
  (globalThis as any).reportError = (error: unknown) => reported.push(error);
  const s = stage(),
    part = counted(),
    wrapped = latest<any>();
  await show(s.view, "kept");
  await show(s.view, [part.source, {}]);
  assert.equal(html(s.parent), "<div>kept</div>");
  assert.equal(part.stats.opened, 0);
  await show(s.view, ["a", s.view]);
  await show(s.view, ["b", wrapped]);
  await show(wrapped, ["c", s.view]);
  assert.equal(html(s.parent), "<div>b</div>");
  assert.deepEqual(
    reported.map(error => (error as Error).message),
    [
      "[object Object] is not a JSX child",
      "A dynamic child is in its own output",
      "A dynamic child is in its own output",
    ],
  );
  s.unmount();
});

test("JX-085 JX-035 a row that leaves or renders again returns the parts of its outputs", async () => {
  const items = select(["a", "b"], { autoStart: true, backPressure: false }),
    parts = [counted(), counted()],
    olds = [counted(), counted()],
    once = latest<any>();
  let at = 0;
  async function* Row() {
    const part = parts[at],
      old = olds[at++];
    yield [old.source];
    yield ["row", part.source];
    for await (const _ of once) return;
  }
  const parent = el("ul");
  mount(
    parent,
    each(items, () => Row()),
  );
  await setImmediate();
  await setImmediate();
  assert.equal(html(parent), "<ul>rowrow</ul>");
  items.pop();
  await setImmediate();
  assert.deepEqual(
    parts.map(part => part.stats.returns),
    [0, 1],
  );
  assert.deepEqual(
    olds.map(old => old.stats.returns),
    [0, 1],
  );
  // The child of the first row finishes, and a new value renders the row again (JX-03C).
  parts.push(counted());
  olds.push(counted());
  await show(once, 1);
  items[0] = "c";
  await setImmediate();
  await setImmediate();
  assert.equal(parts[0].stats.returns, 1);
  assert.equal(olds[0].stats.returns, 1);
});

test("JX-035 JX-041 JX-08A a row that leaves returns its child, so a component that waits on other code ends at its next yield", async () => {
  const items = select(["a", "b"], { autoStart: true, backPressure: false }),
    source = counted(),
    gate = Promise.withResolvers<void>(),
    log: string[] = [];
  async function* Row() {
    try {
      yield "row";
      await gate.promise;
      yield "again";
      log.push("resumed");
    } finally {
      log.push("finally");
    }
  }
  let at = 0;
  const parent = el("ul");
  mount(
    parent,
    each(items, () => (at++ ? Row() : source.source)),
  );
  await setImmediate();
  assert.equal(source.stats.opened, 1);
  items.splice(0, 2);
  await setImmediate();
  assert.equal(source.stats.returns, 1);
  gate.resolve();
  await setImmediate();
  assert.deepEqual(log, ["finally"]);
  assert.equal(html(parent), "<ul></ul>");
});

test("HE-059 derive stops the elements that map built for the previous output, and keeps the ones that code built before", async () => {
  const text = latest<string>(),
    n = latest<number>();
  text.send("t");
  const kept = h("u", { children: text });
  let s!: ReturnType<typeof stage>, built: any;
  const view = derive(n, value =>
    value === 2
      ? kept
      : (built = h("p", {
          title: text,
          children: h("b", { children: text }),
        })),
  );
  const channels = await selects(async () => {
    s = stage();
    await show(s.view, view);
    await show(n, 1);
  });
  assert.equal(html(s.parent), '<div><p title="t"><b>t</b></p></div>');
  // The stage, the host of b, and the props of p.
  assert.deepEqual(aborted(channels), [false, false, false]);
  const first = built;
  const more = await selects(async () => {
    await show(n, 2);
    await show(n, 3);
  });
  assert.deepEqual(aborted(channels), [false, true, true]);
  assert.equal(html(first), '<p title="t"><b>t</b></p>');
  // The host of kept is parked and not stopped, and the new p runs.
  assert.deepEqual(aborted(more), [false, false, false]);
  await show(n, 2);
  assert.deepEqual(aborted(more), [false, true, true]);
  assert.equal(html(s.parent), "<div><u>t</u></div>");
  s.unmount();
  assert.deepEqual(aborted(more), [true, true, true]);
});

test("HE-059 derive ends the waits of built elements that never started, and return stops the last output", async () => {
  const text = latest<string>(),
    n = new Channel<number>();
  text.send("t");
  const built: any[] = [],
    view = derive(
      n,
      () => (built.push(h("b", { title: text, children: text })), built.length),
    );
  n.send(1), n.send(2);
  assert.deepEqual(await view.next(), { done: false, value: 1 });
  assert.deepEqual(await view.next(), { done: false, value: 2 });
  const parent = el();
  const channels = await selects(async () => {
    mount(parent, built);
    await setImmediate();
  });
  // The first element lost its waits, and the second started.
  assert.equal(html(parent), '<div><b></b><b title="t">t</b></div>');
  assert.deepEqual(aborted(channels), [false, false]);
  await view.return();
  assert.deepEqual(aborted(channels), [true, true]);
});

test("HE-059 a repeat of the last output keeps its elements, a finished source keeps the last output, and a discarded output keeps none", async () => {
  const text = latest<string>(),
    n = new Channel<number>();
  text.send("t");
  const cached = h("b", { children: text }),
    extra: any[] = [];
  let s!: ReturnType<typeof stage>;
  const channels = await selects(async () => {
    s = stage();
    await show(
      s.view,
      derive(n, () => (extra.push(h("i", { children: text })), cached)),
    );
    n.send(1), n.send(2);
    await setImmediate();
    await setImmediate();
    n.close();
    await setImmediate();
  });
  assert.equal(html(s.parent), "<div><b>t</b></div>");
  assert.deepEqual(aborted(channels), [false, false]);
  // The elements of the repeat lost their waits.
  const started = await selects(async () => {
    mount(el(), extra[1]);
    await setImmediate();
  });
  assert.equal(started.length, 0);
  s.unmount();
  // A return during an async map discards its output.
  const slow = Promise.withResolvers<unknown>(),
    source = new Channel<number>();
  let late: any;
  const view = derive(source, () => {
    late = h("b", { children: text });
    return slow.promise;
  });
  source.send(1);
  const read = view.next();
  await setImmediate();
  await view.return();
  slow.resolve(late);
  assert.deepEqual(await read, { done: true, value: undefined });
  const none = await selects(async () => {
    mount(el(), late);
    await setImmediate();
  });
  assert.equal(none.length, 0);
});

test("HE-059 JX-041 derive returns the component result that map built, in its host or by itself", async () => {
  const n = latest<number>(),
    wake = latest<number>(),
    log: string[] = [];
  async function* View({ name }: { name: number }) {
    try {
      yield `view ${name}`;
      for await (const _ of wake) yield `view ${name} again`;
    } finally {
      log.push(`end ${name}`);
    }
  }
  const s = stage();
  await show(
    s.view,
    derive(n, name => h(View, { name })),
  );
  await show(n, 1);
  assert.equal(html(s.parent), "<div>view 1</div>");
  await show(n, 2);
  assert.equal(html(s.parent), "<div>view 2</div>");
  // The first view opened its read in a pull, so the host ends that read, and the view ends at once (JX-041).
  assert.equal(log.join(), "end 1");
  await show(wake, 1);
  assert.equal(log.join(), "end 1");
  assert.equal(html(s.parent), "<div>view 2 again</div>");
  s.unmount();
  await setImmediate();
  assert.equal(log.join(), "end 1,end 2"); // The unmount ends the read of view 2 too
  // With no host, derive calls return on the result, also for a result with no return.
  const alone = new Channel<number>(),
    bare = { [Symbol.asyncIterator]: () => ({}) },
    owned = { ...bare, return: () => log.push("returned") };
  const plain = derive(alone, name => h(() => (name === 1 ? owned : bare), {}));
  alone.send(1), alone.send(2), alone.send(3);
  await plain.next();
  await plain.next();
  assert.equal(log.join(), "end 1,end 2,returned");
  await plain.next();
  await plain.return();
  assert.equal(log.join(), "end 1,end 2,returned");
});

test("HE-060 HE-061 iff gives a branch at each change of the truthiness, and calls a function branch", async () => {
  const gate = new Channel<unknown>();
  let calls = 0;
  const it = iff(gate, () => `on ${++calls}`, "off");
  for (const value of [1, "yes", 0, null, true, false]) gate.send(value);
  gate.close();
  const seen: unknown[] = [];
  for await (const value of it) seen.push(value);
  assert.deepEqual(seen, ["on 1", "off", "on 2", "off"]);
  const bare = new Channel<boolean>(),
    other = new Channel<boolean>();
  bare.send(false), bare.send(true), other.send(false);
  const one = iff(bare, "shown", () => "hidden"),
    none = iff(other, "shown");
  assert.deepEqual(await one.next(), { done: false, value: "hidden" });
  assert.deepEqual(await one.next(), { done: false, value: "shown" });
  assert.deepEqual(await none.next(), { done: false, value: undefined });
  await one.return();
  await none.return();
  for (const source of [{}, null])
    assert.throws(() => iff(source as any, 1), {
      name: "TypeError",
      message: "iff source is not an async iterable",
    });
});

test("HE-061 HE-059 iff stops the view of a function branch at the next change, and parks a view that code built", async () => {
  const gate = latest<boolean>(),
    text = latest<string>();
  text.send("t");
  const kept = h("u", { children: text });
  let s!: ReturnType<typeof stage>;
  const channels = await selects(async () => {
    s = stage();
    await show(s.view, [
      iff(gate, () => h("b", { children: text })),
      iff(gate, kept),
    ]);
    await show(gate, true);
    await show(gate, true);
  });
  assert.equal(html(s.parent), "<div><b>t</b><u>t</u></div>");
  assert.equal(channels.length, 3);
  await show(gate, false);
  assert.equal(html(s.parent), "<div></div>");
  assert.deepEqual(aborted(channels), [false, true, false]);
  s.unmount();
  assert.deepEqual(aborted(channels), [true, true, true]);
});

test("JX-084 JX-086 a parked part parks an each in it, and a row with an Item reads on", async () => {
  const s = stage(),
    items = select(["a"], { autoStart: true, backPressure: false }),
    row = counted();
  const list = each(items, (_: Item<string>) => row.source);
  await show(s.view, [list]);
  row.send("1");
  await setImmediate();
  assert.equal(html(s.parent), "<div>1</div>");
  await show(s.view, "none");
  row.send("2"), row.send("3");
  await setImmediate();
  await setImmediate();
  assert.equal(row.stats.pulls, 2);
  await show(s.view, [list]);
  await setImmediate();
  await setImmediate();
  assert.equal(html(s.parent), "<div>3</div>");
  s.unmount();
});

test("JX-035 JX-085 an entry that leaves stops the elements under the nodes that a part of its child gave before", async () => {
  const text = latest<string>(),
    inner = latest<any>(),
    row = latest<any>(),
    items = select(["a"], { autoStart: true, backPressure: false });
  text.send("t");
  row.send(["<", inner, ">"]);
  const parent = el("ul");
  const channels = await selects(async () => {
    mount(
      parent,
      each(items, () => row),
    );
    await show(inner, h("b", { children: text }));
    await show(inner, "x");
  });
  assert.equal(html(parent), "<ul><x></ul>");
  assert.deepEqual(aborted(channels), [false, false, false]);
  items.pop();
  await setImmediate();
  assert.deepEqual(aborted(channels), [false, false, true]);
});

test("JX-084 JX-086 a host that resumes keeps an each parked in a part that left its output", async () => {
  const s = stage(),
    box = el("section"),
    inner = latest<any>(),
    items = select(["a"], { autoStart: true, backPressure: false }),
    row = counted(),
    list = each(items, () => row.source);
  await show(s.view, box);
  mount(box, inner);
  await show(inner, [list]);
  row.send("1");
  await setImmediate();
  assert.equal(html(box), "<section>1</section>");
  await show(inner, "none");
  await show(s.view, "x");
  await show(s.view, box);
  row.send("2"), row.send("3");
  await setImmediate();
  await setImmediate();
  assert.equal(row.stats.pulls, 2);
  await show(inner, [list]);
  await setImmediate();
  assert.equal(html(box), "<section>3</section>");
  s.unmount();
});

test("JX-085 JX-086 a part that a parked part outputs starts parked, also an each, and runs at the resume", async () => {
  reported.length = 0;
  (globalThis as any).reportError = (error: unknown) => reported.push(error);
  const s = stage(),
    inner = latest<any>(),
    items = select(["a"], { autoStart: true, backPressure: false });
  await show(s.view, ["<", inner, ">"]);
  await show(s.view, "none");
  await show(inner, ["[", each(items, ({ value }) => value), "]"]);
  assert.equal(html(s.parent), "<div>none</div>");
  await show(s.view, ["<", inner, ">"]);
  await setImmediate();
  assert.equal(html(s.parent), "<div><[a]></div>");
  assert.deepEqual(reported, []);
  s.unmount();
});

test("JX-086 a parked part that changes its nodes does not change the nodes of each", async () => {
  const items = select(["a"], { autoStart: true, backPressure: false }),
    inner = latest<unknown>(),
    row = latest<any>();
  row.send(["<", inner, ">"]);
  const list = each(items, () => row);
  // Takes yields until each gives the nodes of want.
  const until = async (want: string) => {
    let nodes: Node[] | undefined;
    do nodes = (await list.next()).value as Node[] | undefined;
    while (nodes?.map(node => (node as Text).data).join() !== want);
  };
  inner.send("i");
  await until("<,i,>");
  row.send("plain");
  await until("plain");
  // The parked part applies its pending pull, so each has nothing to yield.
  inner.send(["j"]);
  const next = list.next();
  await setImmediate();
  assert.match(inspect(next), /pending/);
  await list.return();
});

test("JX-035 an entry that renders a static child again stops the elements under the nodes of its finished child", async () => {
  const text = latest<string>(),
    items = select(["a"], { autoStart: true, backPressure: false });
  text.send("t");
  let renders = 0;
  async function* Once() {
    yield h("b", { children: text });
  }
  const parent = el("ul");
  const channels = await selects(async () => {
    mount(
      parent,
      each(items, () => (renders++ ? "static" : Once())),
    );
    await setImmediate();
    items[0] = "b";
    await setImmediate();
  });
  assert.equal(html(parent), "<ul>static</ul>");
  assert.deepEqual(aborted(channels), [false, false, false]);
  items.pop();
  await setImmediate();
  assert.deepEqual(aborted(channels), [false, false, true]);
});

test("JX-035 JX-070 an entry keeps no earlier node that holds no scope", async () => {
  const items = select(["a"], { autoStart: true, backPressure: false }),
    row = latest<any>(),
    parent = el("ul");
  mount(
    parent,
    each(items, () => row),
  );
  let first: any = h("i", {});
  const ref = new WeakRef(first);
  await show(row, first);
  await show(row, h("u", {}));
  assert.equal(html(parent), "<ul><u></u></ul>");
  first = undefined;
  assert.equal(await freed(ref), true);
});

test("HE-059 JX-086 derive takes the component result that it stops out of the drive, and a later output makes a new part for it", async () => {
  const n = latest<number>(),
    part = counted(),
    s = stage();
  // The source returns from its iterator, not from itself.
  await show(
    s.view,
    derive(n, value => (value % 2 ? h(() => part.source, {}) : "x")),
  );
  await show(n, 1);
  part.send("p");
  await setImmediate();
  assert.equal(html(s.parent), "<div>p</div>");
  await show(n, 2);
  assert.equal(html(s.parent), "<div>x</div>");
  assert.deepEqual([part.stats.opened, part.stats.returns], [1, 1]);
  await show(n, 3);
  await show(n, 4);
  assert.deepEqual([part.stats.opened, part.stats.returns], [2, 2]);
  s.unmount();
});

test("HE-059 JX-086 derive stops a part that it never pulled, and one whose iterator has no return", async () => {
  reported.length = 0;
  (globalThis as any).reportError = (error: unknown) => reported.push(error);
  const n = latest<number>(),
    opened: number[] = [],
    bare = (id: number) => ({
      [Symbol.asyncIterator]: () => (
        opened.push(id),
        {
          next: () =>
            opened.push(id) > 2
              ? new Promise(() => {})
              : Promise.resolve({ done: false, value: `${id}` }),
        }
      ),
    }),
    view = derive(n, value => (value === 2 ? "x" : h(() => bare(value), {}))),
    s = stage();
  await show(s.view, [view]);
  await show(n, 1);
  assert.equal(html(s.parent), "<div>1</div>");
  await show(n, 2);
  assert.equal(html(s.parent), "<div>x</div>");
  // The part of 3 starts parked, so it never opens.
  await show(s.view, "none");
  await show(n, 3);
  await view.return();
  assert.deepEqual(opened, [1, 1, 1]);
  assert.deepEqual(reported, []);
  s.unmount();
});

test("HE-059 derive stops a built element that is the parent of a mount", async () => {
  const n = new Channel<number>(),
    text = latest<string>(),
    view = derive(n, () => h("b", { title: text }));
  text.send("t");
  n.send(1), n.send(2);
  const built = (await view.next()).value as any;
  const channels = await selects(async () => {
    mount(built, text);
    await setImmediate();
  });
  assert.equal(html(built), "<b>t</b>");
  await view.next();
  assert.deepEqual(aborted(channels), [true]);
  await view.return();
});

test("HE-059 derive stops no component result that is not dynamic", async () => {
  const n = new Channel<number>();
  let returns = 0;
  const view = derive(n, () => h(() => ({ return: () => returns++ }), {}));
  n.send(1), n.send(2);
  await view.next();
  await view.next();
  await view.return();
  assert.equal(returns, 0);
});

test("JX-081 a mount into an element whose scope left binds to the scope above again", async () => {
  const text = latest<string>(),
    box = el("section"),
    s = stage();
  text.send("t");
  await show(s.view, box);
  mount(box, Promise.resolve("p"));
  await setImmediate();
  const channels = await selects(async () => {
    mount(box, text);
    await setImmediate();
  });
  assert.equal(html(box), "<section>t</section>");
  s.unmount();
  assert.deepEqual(aborted(channels), [true]);
});

test("JX-081 a stopped scope leaves the scope above, so a mount again into it keeps a later mount below", async () => {
  const text = latest<string>(),
    box = el("section"),
    s = stage();
  text.send("t");
  await show(s.view, box);
  mount(box, text);
  await setImmediate();
  s.unmount();
  const channels = await selects(async () => {
    mount(box, text);
    await setImmediate();
  });
  mount(s.parent, "y");
  assert.deepEqual(aborted(channels), [false]);
});

test("JX-081 an element whose children finish keeps its scope while its dynamic props run", async () => {
  const text = latest<string>(),
    s = stage();
  text.send("t");
  const channels = await selects(async () => {
    await show(s.view, h("p", { title: text, children: Promise.resolve("x") }));
    await setImmediate();
  });
  assert.equal(html(s.parent), '<div><p title="t">x</p></div>');
  // The host of p finished, and its props run.
  assert.deepEqual(aborted(channels), [true, false]);
  s.unmount();
  assert.deepEqual(aborted(channels), [true, true]);
});

// Records reportError, and gives a fallback that shows the message of the error.
const reporting = () => {
  const list: unknown[] = [];
  (globalThis as any).reportError = (error: unknown) => list.push(error);
  return list;
};
const failed = (error: any) => `failed ${error.message}`;
const boom = (message = "boom") => Promise.reject(new Error(message));

class Box extends FakeElement {
  items: unknown;
}

test("JX-0B5 a held value that fails goes to the boundary around the element, and the other values apply", async () => {
  const list = reporting(),
    node = h("x-box0", { data: () => {}, items: [1], id: "i" });
  const parent = el();
  mount(
    parent,
    h(Catch, { fallback: failed, children: h("section", { children: node }) }),
  );
  customElements.define("x-box0", Box as any);
  await setImmediate();
  assert.equal(
    html(parent),
    "<div><section>failed data does not take a function</section></div>",
  );
  assert.deepEqual(node.items, [1]);
  assert.deepEqual([...node.attributes], [["id", "i"]]);
  // With no boundary, the error goes to reportError.
  h("x-box1", { data: () => {} });
  customElements.define("x-box1", Box as any);
  await setImmediate();
  assert.match(String(list[0]), /data does not take a function/);
  // Only a shadow root continues from its host (JX-02C), so a host field of an element leads to no scope.
  const loose = h("x-box3", { data: () => {} }),
    anchor = h("b", {}),
    other = el();
  mount(other, h(Catch, { fallback: failed, children: anchor }));
  loose.host = anchor;
  customElements.define("x-box3", Box as any);
  await setImmediate();
  assert.equal(html(other), "<div><b></b></div>");
  assert.equal(list.length, 2);
});

test("JX-0B3 a hold does not delay the stop of the element", async () => {
  const queue = counted(),
    node = h("x-box2", { items: [1], children: queue.source });
  const off = mount(el(), node);
  await setImmediate();
  assert.equal(queue.stats.pulls, 1);
  off();
  await setImmediate();
  assert.equal(queue.stats.returns, 1);
  customElements.define("x-box2", Box as any);
  await setImmediate();
  assert.deepEqual(node.items, [1]);
});

test("JX-02C a mount in a shadow root binds to the scope that holds its host, and stops with it", async () => {
  const queue = counted(),
    host = el("section"),
    root = host.attachShadow({ mode: "open" }),
    parent = el();
  const off = mount(parent, host);
  mount(root, h("p", { children: queue.source }));
  queue.send("a");
  await setImmediate();
  assert.equal(html(root), "<p>a</p>");
  off();
  await setImmediate();
  assert.equal(queue.stats.returns, 1);
  // Only a shadow root continues from its host, so an element with a host property binds to no scope.
  const other = counted(),
    owner = el(),
    loose = Object.assign(el(), { host: owner });
  const stop = mount(el(), owner);
  mount(loose, h("p", { children: other.source }));
  stop();
  await setImmediate();
  assert.equal(other.stats.returns, 0);
});

test("JX-090 Catch needs one element child and a fallback function, and gives the element", () => {
  const div = el();
  assert.equal(h(Catch, { fallback: failed, children: div }), div);
  assert.throws(
    () => h(Catch, { fallback: failed, children: "x" }),
    /TypeError: Catch needs one element child/,
  );
  assert.throws(
    () => h(Catch, { fallback: failed }),
    /TypeError: Catch needs one element child/,
  );
  assert.throws(
    () => h(Catch, { children: el() }),
    /TypeError: Catch fallback must be a function/,
  );
});

test("JX-092 JX-093 a boundary takes a failure inside it, stops what is under it, and shows the fallback", async () => {
  const list = reporting(),
    queue = counted();
  const view = h(Catch, {
    fallback: failed,
    children: h("section", {
      children: [
        h("p", { children: boom() }),
        h("b", { children: queue.source }),
      ],
    }),
  });
  const parent = el();
  mount(parent, "a", view);
  await setImmediate();
  await setImmediate();
  assert.equal(html(parent), "<div>a<section>failed boom</section></div>");
  assert.equal(queue.stats.returns, 1);
  assert.deepEqual(list, []);
});

test("JX-092 a boundary takes the failures of its own children and props, and keeps its props", async () => {
  const list = reporting(),
    title = latest<any>();
  title.send("t");
  const view = h(Catch, {
    fallback: failed,
    children: h("div", { title, children: boom("own") }),
  });
  const parent = el();
  mount(parent, view);
  await setImmediate();
  assert.equal(html(parent), '<div><div title="t">failed own</div></div>');
  title.send("u");
  await setImmediate();
  assert.equal(view.attributes.get("title"), "u");
  const other = h(Catch, {
    fallback: failed,
    children: h("div", { title: boom("prop") }),
  });
  mount(el(), other);
  await setImmediate();
  assert.equal(html(other), "<div>failed prop</div>");
  assert.deepEqual(list, []);
});

test("JX-093 a boundary takes one failure, so a failure of its fallback goes to the boundary above", async () => {
  const list = reporting();
  const inner = h(Catch, {
    fallback: () => boom("fallback"),
    children: h("p", { children: boom("inner") }),
  });
  const outer = h(Catch, {
    fallback: failed,
    children: h("div", { children: inner }),
  });
  mount(el(), outer);
  for (let i = 0; i < 3; i++) await setImmediate();
  assert.equal(html(outer), "<div>failed fallback</div>");
  const throwing = h(Catch, {
    fallback: () => {
      throw new Error("thrown");
    },
    children: h("p", { children: boom() }),
  });
  const top = h(Catch, {
    fallback: failed,
    children: h("div", { children: throwing }),
  });
  mount(el(), top);
  for (let i = 0; i < 3; i++) await setImmediate();
  assert.equal(html(top), "<div>failed thrown</div>");
  const alone = h(Catch, {
    fallback: () => boom("last"),
    children: h("p", { children: boom() }),
  });
  mount(el(), alone);
  for (let i = 0; i < 3; i++) await setImmediate();
  assert.equal((list[0] as Error).message, "last");
  assert.equal(list.length, 1);
});

test("JX-092 JX-02A a dynamic fallback in place of the last child of the boundary stays its drive, and stops with the mount", async () => {
  const list = reporting(),
    queue = counted();
  const view = h(Catch, {
    fallback: () => queue.source,
    children: h("div", { children: boom() }),
  });
  const unmount = mount(el(), view);
  queue.send("q");
  await setImmediate();
  await setImmediate();
  assert.equal(html(view), "<div>q</div>");
  unmount();
  assert.equal(queue.stats.returns, 1);
  assert.deepEqual(list, []);
});

test("JX-092 a failure with no armed boundary reports, as before", async () => {
  const list = reporting(),
    parent = el();
  mount(parent, h("p", { children: boom("plain") }));
  await setImmediate();
  assert.equal(html(parent), "<div><p></p></div>");
  assert.equal((list[0] as Error).message, "plain");
});

test("JX-088 JX-092 a place that throws under a boundary goes to the boundary", async () => {
  const list = reporting(),
    values = latest<any>(),
    bad = el("b"),
    inner = h("p", { children: values }),
    insert = inner.insertBefore,
    failure = new Error("place");
  inner.insertBefore = function (node: any, ref: any) {
    if (node === bad) throw failure;
    return insert.call(this, node, ref);
  };
  const view = h(Catch, {
    fallback: failed,
    children: h("div", { children: inner }),
  });
  mount(el(), view);
  await setImmediate();
  values.send(bad);
  await setImmediate();
  assert.equal(html(view), "<div>failed place</div>");
  assert.deepEqual(list, []);
});

test("JX-091 a boundary stays a scope when what is under it finishes, so a later start binds to it", async () => {
  const list = reporting(),
    p = h("p", { children: Promise.resolve("done") }),
    view = h(Catch, {
      fallback: failed,
      children: h("section", { children: p }),
    });
  mount(el(), view);
  for (let i = 0; i < 3; i++) await setImmediate();
  mount(p, boom("later"));
  await setImmediate();
  assert.equal(html(view), "<section>failed later</section>");
  assert.deepEqual(list, []);
});

test("JX-092 an each under a boundary hands the failure of a row to it, and JX-094 a row that left only reports", async () => {
  const list = reporting(),
    rows = select(["a", "b"]),
    late = Promise.withResolvers<string>();
  const view = h(Catch, {
    fallback: failed,
    children: h("ul", {
      children: each(rows, item =>
        item.value === "b" ? late.promise : h("li", { children: item.value }),
      ),
    }),
  });
  mount(el(), view);
  await setImmediate();
  rows.pop();
  await setImmediate();
  late.reject(new Error("left"));
  await setImmediate();
  assert.equal(html(view), "<ul><li>a</li></ul>");
  assert.equal((list[0] as Error).message, "left");
  const fresh = select(["a"]);
  const second = h(Catch, {
    fallback: failed,
    children: h("ul", { children: each(fresh, () => boom("row")) }),
  });
  mount(el(), second);
  for (let i = 0; i < 3; i++) await setImmediate();
  assert.equal(html(second), "<ul>failed row</ul>");
  assert.equal(list.length, 1);
});

test("JX-095 a parked boundary mounts its fallback parked, and starts it when it comes back", async () => {
  reporting();
  const s = stage(),
    gate = Promise.withResolvers<string>(),
    queue = counted();
  const view = h(Catch, {
    fallback: () => h("i", { children: queue.source }),
    children: h("div", { children: gate.promise }),
  });
  await show(s.view, view);
  await show(s.view, "away");
  gate.reject(new Error("parked"));
  await setImmediate();
  await setImmediate();
  assert.equal(queue.stats.opened, 0);
  await show(s.view, view);
  queue.send("q");
  await setImmediate();
  await setImmediate();
  assert.equal(queue.stats.opened, 1);
  assert.equal(html(view), "<div><i>q</i></div>");
  s.unmount();
});

test("JX-096 a synchronous error of mount throws to the caller, also under a boundary", () => {
  reporting();
  const view = h(Catch, { fallback: failed, children: h("div") });
  assert.throws(() => mount(view, {} as any), TypeError);
});

test("JX-094 a failure of a drive that the boundary stopped in the same report only reports", async () => {
  const list = reporting();
  const view = h(Catch, {
    fallback: failed,
    children: h("div", {
      children: [boom("first"), Promise.resolve("ok"), boom("second")],
    }),
  });
  mount(el(), view);
  await setImmediate();
  assert.equal(html(view), "<div>failed first</div>");
  assert.deepEqual(
    list.map(error => (error as Error).message),
    ["second"],
  );
  const rows = select(["a", "b"]);
  const ul = h(Catch, {
    fallback: failed,
    children: h("ul", { children: each(rows, item => boom(item.value)) }),
  });
  mount(el(), ul);
  for (let i = 0; i < 3; i++) await setImmediate();
  assert.equal(html(ul), "<ul>failed a</ul>");
  assert.deepEqual(
    list.map(error => (error as Error).message),
    ["second", "b"],
  );
});

test("JX-091 a mount into a boundary that did not start keeps it a boundary", async () => {
  const list = reporting(),
    view = h(Catch, { fallback: failed, children: h("div") });
  mount(view, boom());
  await setImmediate();
  assert.equal(html(view), "<div>failed boom</div>");
  assert.deepEqual(list, []);
});

test("JX-094 a drive that a boundary stopped applies no later output of the same report", async () => {
  const list = reporting(),
    fail = Promise.withResolvers<never>(),
    later = Promise.withResolvers<IteratorResult<string>>();
  let first = true;
  // Its next value settles in the same tick as the failure, so both land in one report.
  const values = {
    [Symbol.asyncIterator]: () => ({
      next: () =>
        first
          ? ((first = false), Promise.resolve({ value: "a", done: false }))
          : later.promise,
    }),
  };
  const view = h(Catch, {
    fallback: failed,
    children: h("div", { children: [fail.promise, values] }),
  });
  mount(el(), view);
  await setImmediate();
  const text = view.lastChild;
  assert.equal(text.data, "a");
  fail.reject(new Error("first"));
  later.resolve({ value: "b", done: false });
  await setImmediate();
  assert.equal(html(view), "<div>failed first</div>");
  assert.equal(text.data, "a");
  assert.deepEqual(list, []);
});

test("JX-093 a fallback that throws with no boundary above reports, and leaves what the boundary held stopped", async () => {
  const list = reporting(),
    values = latest<string>(),
    thrown = new Error("fallback"),
    fail = Promise.withResolvers<never>();
  values.send("a");
  const view = h(Catch, {
    fallback: () => {
      throw thrown;
    },
    children: h("div", { children: [fail.promise, values] }),
  });
  mount(el(), view);
  await setImmediate();
  const text = view.lastChild;
  fail.reject(new Error("first"));
  await setImmediate();
  values.send("b");
  await setImmediate();
  assert.equal(html(view), "<div>a</div>");
  assert.equal(text.data, "a");
  assert.deepEqual(list, [thrown]);
});

test("JX-091 a boundary that a builder let go before a placement reached it never arms", async () => {
  const list = reporting(),
    gate = latest<boolean>();
  let built: any;
  gate.send(true);
  mount(
    el(),
    derive(gate, on => {
      if (on) built = h(Catch, { fallback: failed, children: h("section") });
      return `${on}`;
    }),
  );
  await setImmediate();
  gate.send(false);
  await setImmediate();
  mount(built, boom());
  await setImmediate();
  assert.equal(html(built), "<section></section>");
  assert.equal((list[0] as Error).message, "boom");
});
