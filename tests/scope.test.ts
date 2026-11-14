import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { Channel, derive, iff, select } from "../src/index.ts";
import { each, type Item, jsx, mount } from "../src/jsx.ts";
import { fakeDocument, html } from "./dom.ts";

const el = (tag = "div") => fakeDocument.createElement(tag) as any;
const h = (type: any, props: any = {}) => jsx(type, props) as any;
const collect = globalThis.gc as () => void;
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
    items = select(["a"], { autoStart: true, nonYielding: true });
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
  await setImmediate();
  collect();
  // The host of b still runs under p, so the scope of p stays, and the scope of i left.
  assert.deepEqual(
    refs.map(ref => !!ref.deref()),
    [true, false],
  );
  gate.resolve("late");
  await setImmediate();
  collect();
  assert.equal(refs[0].deref(), undefined);
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
    items = select(["a"], { autoStart: true, nonYielding: true }),
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
    items = select(["a"], { autoStart: true, nonYielding: true });
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
  const items = select(["a", "b"], { autoStart: true, nonYielding: true }),
    parts = [counted(), counted()],
    old = counted(),
    once = latest<any>();
  let at = 0;
  async function* Row() {
    const part = parts[at++];
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
  assert.equal(old.stats.returns, 1);
  // The child of the first row finishes, and a new value renders the row again (JX-03C).
  parts.push(counted());
  await show(once, 1);
  items[0] = "c";
  await setImmediate();
  await setImmediate();
  assert.equal(parts[0].stats.returns, 1);
  assert.equal(old.stats.returns, 2);
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

test("HE-059 derive returns the component result that map built, in its host or by itself", async () => {
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
  // The read of the first view pends, so its return waits for the next value (JX-041).
  assert.equal(log.length, 0);
  await show(wake, 1);
  assert.equal(log.join(), "end 1");
  assert.equal(html(s.parent), "<div>view 2 again</div>");
  s.unmount();
  // With no host, derive calls return on the result, also for a result with no return.
  const alone = new Channel<number>(),
    bare = { [Symbol.asyncIterator]: () => ({}) },
    owned = { ...bare, return: () => log.push("returned") };
  const plain = derive(alone, name => h(() => (name === 1 ? owned : bare), {}));
  alone.send(1), alone.send(2), alone.send(3);
  await plain.next();
  await plain.next();
  assert.equal(log.join(), "end 1,returned");
  await plain.next();
  await plain.return();
  assert.equal(log.join(), "end 1,returned");
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
  assert.throws(() => iff({} as any, 1), {
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
    items = select(["a"], { autoStart: true, nonYielding: true }),
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
