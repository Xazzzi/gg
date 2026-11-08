import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { inspect } from "node:util";
import { CHAN, Channel, select } from "../src/index.ts";
import {
  consume,
  createContext,
  each,
  Fragment,
  type Item,
  jsx,
  jsxDEV,
  jsxs,
  mount,
  Provide,
  use,
} from "../src/jsx.ts";
import { FakeElement, FakeNode, FakeText, fakeDocument, html } from "./dom.ts";

const el = (tag = "div") => fakeDocument.createElement(tag) as any;
const h = (type: any, props: any = {}) => jsx(type, props) as any;
const reset = (node: any) => (node.counts = { insert: 0, remove: 0 });
const reported: unknown[] = [];
(globalThis as any).reportError = (error: unknown) => reported.push(error);

// Captures the channel and the proxy of each select, through the devtools hook.
const HOOK = Symbol.for("gg.devtools");
const selects = async (run: () => unknown, targets: object[] = []) => {
  const channels: Channel<unknown>[] = [];
  (globalThis as any)[HOOK] = (kind: string, target: object, detail: any) => {
    if (kind === "select") channels.push(detail.channel), targets.push(target);
  };
  try {
    await run();
  } finally {
    delete (globalThis as any)[HOOK];
  }
  return channels;
};

const latest = <T>() =>
  new Channel<T>({ firstReceive: "latest", thenReceive: "latest" });

test("JX-001 JX-004 creates an element, and ignores key", () => {
  const node = jsx("p", {}, "k") as any;
  assert.ok(node instanceof FakeElement);
  assert.equal(html(node), "<p></p>");
});

test("JX-002 applies props in key order", () => {
  const click = () => {},
    fn = () => {};
  const node = h("input", {
    onClick: click,
    onkeydown: undefined,
    onblur: "x",
    data: fn,
    a: null,
    b: undefined,
    c: false,
    d: true,
    e: 0,
    f: "s",
    children: "t",
  });
  assert.deepEqual(node.listeners, [["click", click]]);
  assert.deepEqual(
    [...node.attributes],
    [
      ["onblur", "x"],
      ["data", `${fn}`],
      ["d", ""],
      ["e", "0"],
      ["f", "s"],
    ],
  );
  assert.equal(html(h("a", { href: "x", children: "t" })), '<a href="x">t</a>');
});

test("JX-001 takes the namespace from xmlns, then from an SVG tag", () => {
  const SVG = "http://www.w3.org/2000/svg",
    XHTML = "http://www.w3.org/1999/xhtml",
    MATH = "http://www.w3.org/1998/Math/MathML";
  for (const tag of ["svg", "path", "mpath", "feBlend", "feTurbulence"])
    assert.equal(h(tag).namespaceURI, SVG, tag);
  for (const tag of ["div", "a", "title", "fe", "feed", "x-feBlend"])
    assert.equal(h(tag).namespaceURI, XHTML, tag);
  assert.equal(h("math", { xmlns: MATH }).namespaceURI, MATH);
  const link = h("a", { xmlns: SVG, href: "#x" });
  assert.equal(link.namespaceURI, SVG);
  assert.equal(html(link), `<a xmlns="${SVG}" href="#x"></a>`);
  assert.equal(h("svg", { xmlns: 1 }).namespaceURI, SVG);
  assert.equal(h("div", { xmlns: null }).namespaceURI, XHTML);
});

test("JX-002 assigns live properties, and skips them for null, undefined and false", () => {
  const node = h("input", {
    value: 0,
    checked: true,
    selected: "s",
    indeterminate: 1,
    muted: true,
    other: true,
  });
  assert.deepEqual(
    [node.value, node.checked, node.selected, node.indeterminate, node.muted],
    [0, true, "s", 1, true],
  );
  assert.deepEqual([...node.attributes], [["other", ""]]);
  const empty = h("input", { value: null, checked: false, muted: undefined });
  assert.deepEqual(
    Reflect.ownKeys(empty),
    Reflect.ownKeys(new FakeElement("input")),
  );
});

test("JX-002 JX-003 assigns live properties after the children mount", () => {
  const seen: number[] = [],
    create = fakeDocument.createElement;
  fakeDocument.createElement = (tag: string) =>
    Object.defineProperty(create(tag), "value", {
      set(this: FakeElement) {
        seen.push(this.childNodes.length);
      },
    });
  try {
    h("select", { value: "b", children: [el("option"), el("option")] });
  } finally {
    fakeDocument.createElement = create;
  }
  assert.deepEqual(seen, [2]);
});

test("JX-003 JX-010 JX-012 JX-013 JX-014 mounts children of all static kinds", () => {
  const b = el("b"),
    fragment = h(Fragment, { children: [el("i"), "f"] });
  const node = h("p", {
    children: ["a", [1, [2n, null, undefined, true, false]], b, fragment],
  });
  assert.equal(html(node), "<p>a12<b></b><i></i>f</p>");
  assert.equal(fragment.childNodes.length, 0);
});

test("JX-005 calls a function type with props, and returns its result", () => {
  const props = { x: 1 };
  assert.equal(h((p: unknown) => [p], props)[0], props);
  async function* Comp() {}
  const a = h(Comp),
    b = h(Comp);
  assert.notEqual(a, b);
  assert.equal(typeof a.next, "function");
});

test("JX-006 jsxs and jsxDEV are jsx", () => {
  assert.equal(jsxs, jsx);
  assert.equal(jsxDEV, jsx);
});

test("JX-007 JX-011 a Fragment holds static nodes, and rejects a dynamic child", () => {
  const fragment = Fragment({ children: ["a", el("b")] }) as any;
  assert.equal(fragment.nodeType, 11);
  assert.equal(html(fragment), "a<b></b>");
  assert.equal(html(Fragment({}) as any), "");
  assert.throws(
    () => Fragment({ children: [Promise.resolve("x")] }),
    /not permitted/,
  );
  assert.throws(
    () => Fragment({ children: { [Symbol.asyncIterator]() {} } as any }),
    TypeError,
  );
});

test("JX-015 JX-016 rejects other values, and changes nothing", () => {
  const parent = el(),
    old = el("old");
  parent.append(old);
  for (const bad of [Symbol("s"), {}, () => {}, { then: 1 }]) {
    assert.throws(
      () => mount(parent, el("b"), bad as any),
      /is not a JSX child/,
    );
    assert.deepEqual(parent.childNodes, [old]);
  }
});

test("JX-020 JX-021 mount places static nodes synchronously, and removes other children", async () => {
  const parent = el(),
    keep = el("keep");
  parent.append(el("gone"), keep);
  const channels = await selects(() => mount(parent, "a", keep, el("b")));
  assert.equal(html(parent), "<div>a<keep></keep><b></b></div>");
  assert.equal(channels.length, 0);
});

test("JX-020 JX-022 JX-023 dynamic children start in a microtask, between static entries", async () => {
  const parent = el();
  const channels = await selects(() => {
    mount(parent, "a", Promise.resolve("p"), "b", [Promise.resolve("q")], "c");
    assert.equal(html(parent), "<div>abc</div>");
  });
  assert.equal(channels.length, 1);
  await setImmediate();
  assert.equal(html(parent), "<div>apbqc</div>");
  assert.equal(channels[0].signal.aborted, true);
});

test("JX-022 the host stays open while a child runs", async () => {
  const parent = el(),
    count = latest<number>();
  const channels = await selects(() => mount(parent, count));
  count.send(1);
  await setImmediate();
  assert.equal(html(parent), "<div>1</div>");
  assert.equal(channels[0].signal.aborted, false);
  count.close();
  await setImmediate();
  assert.equal(channels[0].signal.aborted, true);
  assert.equal(html(parent), "<div>1</div>");
});

test("JX-024 a pending child has no nodes until it settles", async () => {
  const parent = el(),
    { promise, resolve } = Promise.withResolvers<string>();
  mount(parent, "a", promise);
  await setImmediate();
  assert.equal(html(parent), "<div>a</div>");
  resolve("b");
  await setImmediate();
  assert.equal(html(parent), "<div>ab</div>");
});

test("JX-025 JX-027 a component replaces its node, and a repeat yield changes nothing", async () => {
  const parent = el(),
    first = el("first"),
    second = h(Fragment, { children: [el("x"), el("y")] }),
    step = latest<number>();
  async function* Comp() {
    yield first;
    for await (const n of step)
      if (n === 1) yield first;
      else if (n === 2) yield second;
      else if (n === 3) yield second;
      else yield null;
  }
  mount(parent, "a", h(Comp), "b");
  await setImmediate();
  assert.equal(html(parent), "<div>a<first></first>b</div>");
  reset(parent);
  step.send(1);
  await setImmediate();
  assert.deepEqual(parent.counts, { insert: 0, remove: 0 });
  step.send(2);
  await setImmediate();
  assert.equal(html(parent), "<div>a<x></x><y></y>b</div>");
  reset(parent);
  step.send(3);
  await setImmediate();
  assert.deepEqual(parent.counts, { insert: 0, remove: 0 });
  step.send(4);
  await setImmediate();
  assert.equal(html(parent), "<div>ab</div>");
});

test("JX-026 a text output changes the data of the runtime Text node", async () => {
  const parent = el(),
    values = latest<any>(),
    own = new FakeText("own");
  mount(parent, values);
  values.send("a");
  await setImmediate();
  const text = parent.childNodes[0];
  values.send(2);
  await setImmediate();
  assert.equal(parent.childNodes[0], text);
  assert.equal(text.data, "2");
  values.send(3n);
  await setImmediate();
  assert.equal(text.data, "3");
  values.send(own);
  await setImmediate();
  assert.deepEqual(parent.childNodes, [own]);
  values.send("b");
  await setImmediate();
  assert.equal(own.data, "own");
  assert.equal(html(parent), "<div>b</div>");
  values.send(el("i"));
  await setImmediate();
  values.send("c");
  await setImmediate();
  assert.equal(html(parent), "<div>c</div>");
  values.close();
});

test("JX-028 a rejection or a bad output reports an error, and the entry keeps its nodes", async () => {
  reported.length = 0;
  const parent = el(),
    failure = new Error("x"),
    values = latest<any>();
  mount(parent, Promise.reject(failure), values, Promise.resolve("ok"));
  values.send("v");
  await setImmediate();
  values.send({});
  await setImmediate();
  values.send([Promise.resolve(1)]);
  await setImmediate();
  assert.equal(html(parent), "<div>vok</div>");
  assert.equal(reported[0], failure);
  assert.ok(reported[1] instanceof TypeError);
  assert.ok(reported[2] instanceof TypeError);
  assert.equal(reported.length, 3);
  values.send("w");
  await setImmediate();
  assert.equal(html(parent), "<div>wok</div>");
  values.close();
});

test("JX-020 a mount into a host stops its drive first, after the conversion", async () => {
  const parent = el(),
    count = latest<number>();
  const channels = await selects(() => mount(parent, count));
  count.send(1);
  await setImmediate();
  assert.throws(() => mount(parent, {} as any), /is not a JSX child/);
  assert.equal(channels[0].signal.aborted, false);
  mount(parent, "x");
  assert.equal(channels[0].signal.aborted, true);
  count.send(2);
  await setImmediate();
  assert.equal(html(parent), "<div>x</div>");
});

test("JX-02A JX-03B unmount stops each host inside the parent, ends each at once, and empties the parent", async () => {
  const root = el(),
    count = latest<number>();
  let s!: ReturnType<typeof setup>, unmount!: () => void;
  const channels = await selects(async () => {
    s = setup(["a", "b"]);
    unmount = mount(
      root,
      h("p", { children: [h("ul", { children: s.list })] }),
      count,
    );
    count.send(1);
    await setImmediate();
  });
  assert.equal(html(root), "<div><p><ul><li>a</li><li>b</li></ul></p>1</div>");
  assert.equal(channels.length, 4);
  unmount();
  assert.equal(html(root), "<div></div>");
  await setImmediate();
  assert.deepEqual(s.log, ["a", "b", "end", "end"]);
  assert.deepEqual(
    channels.map(channel => channel.signal.aborted),
    [false, true, true, true],
  );
  mount(root, "x");
  unmount();
  assert.equal(html(root), "<div>x</div>");
});

test("JX-001 JX-02B an element mounts a component when a mount places it", async () => {
  async function* Comp({ name }: { name: string }) {
    yield h("b", { children: name });
  }
  const node = h("p", { children: ["a", h(Comp, { name: "n" })] });
  await setImmediate();
  assert.equal(html(node), "<p>a</p>");
  mount(el(), node);
  await setImmediate();
  assert.equal(html(node), "<p>a<b>n</b></p>");
  assert.ok(node.childNodes[0] instanceof FakeNode);
});

test("JX-02B nested elements wait until a placement reaches them, then start in tree order", async () => {
  const targets: object[] = [];
  let outer: any, inner: any;
  const channels = await selects(async () => {
    inner = h("b", { children: Promise.resolve("i") });
    outer = h("div", {
      children: [h("p", { children: inner }), Promise.resolve("o")],
    });
    await setImmediate();
  }, targets);
  assert.equal(channels.length, 0);
  assert.equal(html(outer), "<div><p><b></b></p></div>");
  const later = await selects(async () => {
    mount(el(), outer);
    await setImmediate();
  });
  assert.equal(later.length, 2);
  assert.equal(html(outer), "<div><p><b>i</b></p>o</div>");
});

test("JX-02B a host starts an element that it places, one time", async () => {
  const parent = el(),
    values = latest<any>(),
    child = latest<string>();
  const node = h("p", { children: child });
  const channels = await selects(async () => {
    mount(parent, values);
    values.send(node);
    await setImmediate();
    child.send("a");
    await setImmediate();
    values.send("x");
    await setImmediate();
    values.send(node);
    await setImmediate();
  });
  child.send("b");
  await setImmediate();
  assert.equal(channels.length, 2);
  assert.equal(html(parent), "<div><p>b</p></div>");
});

test("JX-02B a mount into a waiting element ends its wait", async () => {
  const node = h("p", { children: Promise.resolve("old") });
  mount(node, "new");
  mount(el(), node);
  await setImmediate();
  assert.equal(html(node), "<p>new</p>");
});

test("JX-045 an element that other code appends into a host stays idle", async () => {
  const parent = el(),
    values = latest<any>();
  mount(parent, values);
  const box = el("section");
  values.send(box);
  await setImmediate();
  box.append(h("p", { children: Promise.resolve("p") }));
  await setImmediate();
  assert.equal(html(parent), "<div><section><p></p></section></div>");
});

// Runs each over a select between static siblings, with rows that log values and their end.
const setup = (initial: string[] = []) => {
  const parent = el("ul"),
    log: string[] = [];
  let renders = 0;
  async function* Row({ item }: { item: Item<string> }) {
    const li = el("li"),
      text = new FakeText("");
    li.append(text);
    yield li;
    try {
      for await (const value of item) {
        text.data = value;
        log.push(value);
      }
    } finally {
      log.push("end");
    }
  }
  const items = select(initial, {
    autoStart: true,
    autoClose: false,
    nonYielding: true,
  });
  const list = each(items, item => (renders++, h(Row, { item })));
  return { parent, log, items, list, renders: () => renders };
};
const rows = (...values: string[]) =>
  `<ul>first${values.map(v => `<li>${v}</li>`).join("")}last</ul>`;
// Runs each with static rows, so each yields only for its own changes.
const plain = (initial: string[] = []) => {
  const items = select(initial, {
      autoStart: true,
      autoClose: false,
      nonYielding: true,
    }),
    seen: Item<string>[] = [];
  const list = each(items, item => (seen.push(item), el("li")));
  return { items, list, seen };
};
const mounted = (initial?: string[]) => {
  const s = setup(initial);
  mount(s.parent, "first", s.list, "last");
  return s;
};

test("JX-030 each checks its arguments synchronously", () => {
  const items = select(["a"]),
    shape = select({ a: 1 });
  for (const bad of [["a"], shape, null])
    assert.throws(() => each(bad as any, () => null), /array shape/);
  assert.throws(() => each(items, 1 as any), /must be a function/);
});

test("JX-030 JX-031 each reads the outputs at its first next, not at the call", async () => {
  const s = plain(["a"]);
  await setImmediate();
  s.items.push("b");
  await setImmediate();
  const first = await s.list.next();
  assert.equal(first.value?.length, 2);
  assert.equal(s.seen.length, 2);
  await s.list.return();
});

test("JX-031 JX-032 JX-036 each renders all items, and drives them with one select", async () => {
  let s!: ReturnType<typeof mounted>;
  const channels = await selects(async () => {
    s = mounted(["a", "b"]);
    await setImmediate();
  });
  assert.equal(html(s.parent), rows("a", "b"));
  assert.equal(channels.length, 3);
  s.items.push("c");
  await setImmediate();
  assert.equal(html(s.parent), rows("a", "b", "c"));
  assert.equal(s.renders(), 3);
  s.items.length = 0;
  await setImmediate();
  assert.equal(html(s.parent), rows());
  assert.equal(channels[2].signal.aborted, false);
});

test("JX-032 JX-03F a new item channel starts at the latest value", async () => {
  const { items, list, seen } = plain();
  await setImmediate();
  await list.next();
  items.push("a");
  await list.next();
  items[0] = "b";
  const next = list.next();
  await setImmediate();
  items[0] = "c";
  await setImmediate();
  const value = await seen[0][Symbol.asyncIterator]().next();
  assert.equal(value.value, "c");
  assert.match(inspect(next), /pending/);
  items[CHAN].close();
  assert.equal((await next).done, true);
});

test("JX-034 JX-037 a set gives the value to the item, and changes no node of the host", async () => {
  const s = mounted(["a", "b"]);
  await setImmediate();
  reset(s.parent);
  s.items[1] = "c";
  await setImmediate();
  assert.equal(html(s.parent), rows("a", "c"));
  assert.equal(s.renders(), 2);
  assert.deepEqual(s.parent.counts, { insert: 0, remove: 0 });
});

test("JX-037 each does not yield after a read with only set operations", async () => {
  const s = plain(["a"]);
  await setImmediate();
  await s.list.next();
  const next = s.list.next();
  s.items[0] = "b";
  await setImmediate();
  assert.match(inspect(next), /pending/);
  s.items.push("c");
  assert.equal((await next).value?.length, 2);
  await s.list.return();
});

test("JX-037 a busy host gets one output for all reads since its last pull", async () => {
  const s = plain();
  await setImmediate();
  await s.list.next();
  s.items.push("a");
  await setImmediate();
  s.items.push("b");
  await setImmediate();
  s.items.shift();
  await setImmediate();
  const { value } = await s.list.next();
  assert.equal(value?.length, 1);
  assert.equal(s.seen.length, 1);
  const next = s.list.next();
  await setImmediate();
  assert.match(inspect(next), /pending/);
  s.items[CHAN].close();
  assert.equal((await next).done, true);
});

test("JX-033 a splice that keeps items keeps their instances, and moves their nodes", async () => {
  const s = mounted(["a", "b", "c"]);
  await setImmediate();
  reset(s.parent);
  s.items.splice(0, 3, "c", "a");
  await setImmediate();
  assert.equal(html(s.parent), rows("c", "a"));
  assert.equal(s.renders(), 3);
  assert.deepEqual(s.log, ["a", "b", "c", "end"]);
  assert.deepEqual(s.parent.counts, { insert: 1, remove: 1 });
});

test("JX-035 JX-029 a removed item ends, and other nodes stay", async () => {
  const s = mounted(["a", "b", "c"]);
  await setImmediate();
  reset(s.parent);
  s.items.shift();
  await setImmediate();
  assert.equal(html(s.parent), rows("b", "c"));
  assert.deepEqual(s.parent.counts, { insert: 0, remove: 1 });
  assert.deepEqual(s.log, ["a", "b", "c", "end"]);
});

test("JX-029 JX-038 a move reorders the nodes, keeps the instances and the siblings", async () => {
  const s = mounted(["a", "b", "c"]);
  await setImmediate();
  const [first, a, b, c, last] = s.parent.childNodes;
  s.items.reverse();
  await setImmediate();
  assert.deepEqual(s.parent.childNodes, [first, c, b, a, last]);
  assert.equal(s.renders(), 3);
  reset(s.parent);
  s.items.unshift("z");
  await setImmediate();
  assert.equal(html(s.parent), rows("z", "c", "b", "a"));
  assert.equal(s.parent.childNodes[0], first);
  assert.equal(s.parent.childNodes[5], last);
  assert.deepEqual(s.parent.counts, { insert: 1, remove: 0 });
});

// Gives each order of the items, so a test can try all moves.
const orders = <T>(items: T[]): T[][] =>
  items.length < 2
    ? [items]
    : items.flatMap((item, i) =>
        orders(items.filter((_, j) => j !== i)).map(rest => [item, ...rest]),
      );
// The length of a longest increasing run, by the plain quadratic method.
const runLength = (seq: number[]) => {
  const best = seq.map(() => 1);
  seq.forEach((v, i) => {
    for (let j = 0; j < i; j++)
      if (seq[j] < v) best[i] = Math.max(best[i], best[j] + 1);
  });
  return Math.max(0, ...best);
};

test("JX-029 a place moves only the nodes outside a longest run in order", async () => {
  const parent = el(),
    first = el("first"),
    last = el("last"),
    nodes = [0, 1, 2, 3, 4].map(i => fakeDocument.createTextNode(`${i}`)),
    output = latest<any>();
  mount(parent, first, output, last);
  for (const order of orders([0, 1, 2, 3, 4])) {
    output.send(nodes);
    await setImmediate();
    reset(parent);
    output.send(order.map(i => nodes[i]));
    await setImmediate();
    assert.deepEqual(parent.childNodes, [
      first,
      ...order.map(i => nodes[i]),
      last,
    ]);
    assert.deepEqual(parent.counts, {
      insert: 5 - runLength(order),
      remove: 0,
    });
  }
});

test("JX-029 a place that keeps no node removes all and inserts the new ones", async () => {
  const parent = el(),
    output = latest<any>();
  mount(parent, output);
  output.send([el("x"), el("y")]);
  await setImmediate();
  reset(parent);
  output.send(el("z"));
  await setImmediate();
  assert.equal(html(parent), "<div><z></z></div>");
  assert.deepEqual(parent.counts, { insert: 1, remove: 2 });
});

test("JX-029 a node that two entries give lands at its last place", async () => {
  const parent = el(),
    a = el("a"),
    output = latest<any>();
  mount(parent, a, el("b"), output);
  output.send(a);
  await setImmediate();
  assert.equal(html(parent), "<div><b></b><a></a></div>");
  const after = el(),
    late = latest<any>();
  mount(after, late, el("b"), a);
  await setImmediate();
  late.send(a);
  await setImmediate();
  assert.equal(html(after), "<div><b></b><a></a></div>");
});

test("JX-029 a place with a longest run of one node moves the others", async () => {
  const parent = el(),
    [x, y, z] = [el("x"), el("y"), el("z")],
    output = latest<any>();
  mount(parent, output);
  output.send([x, y, z]);
  await setImmediate();
  reset(parent);
  output.send([z, y, x]);
  await setImmediate();
  assert.equal(html(parent), "<div><z></z><y></y><x></x></div>");
  assert.deepEqual(parent.counts, { insert: 2, remove: 0 });
});

test("JX-033 JX-035 a read with a set and a removal places the nodes", async () => {
  const s = mounted(["a", "b"]);
  await setImmediate();
  s.items[0] = "c";
  s.items.pop();
  await setImmediate();
  assert.equal(html(s.parent), rows("c"));
  assert.deepEqual(s.log, ["a", "b", "c", "end"]);
});

test("JX-032 a static render result, and its removal", async () => {
  const parent = el(),
    items = select(["a", "b"], {
      autoStart: true,
      autoClose: false,
      nonYielding: true,
    });
  mount(
    parent,
    each(items, item => [`${item.value}:`, el("b")]),
  );
  await setImmediate();
  assert.equal(html(parent), "<div>a:<b></b>b:<b></b></div>");
  items.shift();
  await setImmediate();
  assert.equal(html(parent), "<div>b:<b></b></div>");
  items.pop();
  await setImmediate();
  assert.equal(html(parent), "<div></div>");
});

test("JX-036 JX-037 a dynamic item that settles later makes each yield again", async () => {
  const parent = el(),
    { promise, resolve } = Promise.withResolvers<string>(),
    items = select(["a"], {
      autoStart: true,
      autoClose: false,
      nonYielding: true,
    });
  mount(
    parent,
    each(items, () => promise),
  );
  await setImmediate();
  assert.equal(html(parent), "<div></div>");
  resolve("p");
  await setImmediate();
  assert.equal(html(parent), "<div>p</div>");
});

test("JX-031 each over a select that did not start renders the start description", async () => {
  const parent = el(),
    items = select(["a", "b"], { autoClose: false, backPressure: false });
  mount(
    parent,
    each(items, () => "x"),
  );
  await setImmediate();
  assert.equal(html(parent), "<div></div>");
  void items[Symbol.asyncIterator]().next();
  await setImmediate();
  assert.equal(html(parent), "<div>xx</div>");
});

test("JX-039 when the select closes, each ends the items, stops its drive and keeps its nodes", async () => {
  let s!: ReturnType<typeof mounted>;
  const channels = await selects(async () => {
    s = mounted(["a", "b"]);
    await setImmediate();
  });
  s.items[CHAN].close();
  await setImmediate();
  assert.deepEqual(s.log, ["a", "b", "end", "end"]);
  assert.equal(channels[2].signal.aborted, true);
  assert.equal(channels[0].signal.aborted, true);
  assert.equal(html(s.parent), rows("a", "b"));
});

test("JX-039 when the select fails, each ends the items and rejects with the error", async () => {
  reported.length = 0;
  const s = mounted(["a"]),
    failure = new Error("x");
  await setImmediate();
  s.items[CHAN].throw(failure);
  await setImmediate();
  assert.deepEqual(s.log, ["a", "end"]);
  assert.deepEqual(reported, [failure]);
  assert.equal(html(s.parent), rows("a"));
});

test("JX-03A an error from render ends each, and ends the items", async () => {
  const failure = new Error("x"),
    seen: Item<string>[] = [],
    items = select(["a"], {
      autoStart: true,
      autoClose: false,
      nonYielding: true,
    });
  const list = each(items, item => {
    if (seen.push(item) > 1) throw failure;
    return "x";
  });
  await setImmediate();
  await list.next();
  items.push("b");
  await assert.rejects(list.next(), failure);
  assert.equal(seen[0].signal.aborted, true);
  assert.deepEqual(await list.next(), { done: true, value: undefined });
});

test("JX-03A a render result with a nested dynamic child ends each", async () => {
  const items = select(["a"], {
    autoStart: true,
    autoClose: false,
    nonYielding: true,
  });
  const list = each(items, () => [Promise.resolve("x")]);
  await setImmediate();
  await assert.rejects(list.next(), TypeError);
});

test("JX-03B return() ends the items and stops the drive", async () => {
  let s!: ReturnType<typeof setup>;
  const channels = await selects(async () => {
    s = setup(["a"]);
    await setImmediate();
    await s.list.next();
  });
  await setImmediate();
  await s.list.return();
  await setImmediate();
  assert.deepEqual(s.log, ["a", "end"]);
  assert.equal(channels[1].signal.aborted, true);
  // A finished reader leaves no log behind, so the items let go of a value.
  const registry = new FinalizationRegistry<() => void>(done => done());
  let collected = false;
  (() => {
    const value = {};
    registry.register(value, () => (collected = true));
    (s.items as unknown[]).push(value);
  })();
  await setImmediate();
  s.items.pop();
  for (let i = 0; i < 20 && !collected; i++) {
    await setImmediate();
    globalThis.gc?.();
  }
  assert.ok(collected);
});

test("JX-03B return() during a pending next() ends each at once", async () => {
  const s = plain(["a"]);
  await setImmediate();
  await s.list.next();
  const pending = s.list.next();
  await setImmediate();
  assert.match(inspect(pending), /pending/);
  const done = s.list.return();
  assert.deepEqual(await pending, { done: true, value: undefined });
  assert.deepEqual(await done, { done: true, value: undefined });
  assert.equal(s.seen[0].signal.aborted, true);
});

// Runs each over components that finish on a gate, and logs each item that render gets.
const gated = (
  initial: string[],
  component: (item: Item<string>, gate: Promise<void>) => unknown,
) => {
  const items = select(initial, {
      autoStart: true,
      autoClose: false,
      nonYielding: true,
    }),
    seen: Item<string>[] = [],
    gate = Promise.withResolvers<void>();
  const list = each(
    items,
    item => (seen.push(item), component(item, gate.promise) as any),
  );
  return { items, list, seen, gate };
};

test("JX-03C a child that reads once renders again at the next value, and keeps its nodes until then", async () => {
  const parent = el(),
    targets: object[] = [];
  let s!: ReturnType<typeof gated>;
  await selects(async () => {
    s = gated(["a"], async item => {
      for await (const value of item) return h("b", { children: value });
    });
    mount(parent, s.list);
    await setImmediate();
  }, targets);
  const { items, seen } = s,
    drive = targets[2];
  assert.equal(targets.length, 3);
  assert.deepEqual(Reflect.ownKeys(drive), ["0"]);
  assert.equal(html(parent), "<div><b>a</b></div>");
  assert.equal(seen.length, 1);
  reset(parent);
  items[0] = "b";
  await setImmediate();
  assert.equal(html(parent), "<div><b>b</b></div>");
  assert.deepEqual(parent.counts, { insert: 1, remove: 1 });
  assert.equal(seen.length, 2);
  assert.equal(seen[0].signal.aborted, true);
  assert.equal(seen[1].signal.aborted, false);
  assert.deepEqual(Reflect.ownKeys(drive), ["1"]);
  items[0] = "c";
  await setImmediate();
  assert.equal(html(parent), "<div><b>c</b></div>");
  assert.equal(seen.length, 3);
});

test("JX-03C a child that ends after a send renders again at once with the latest value", async () => {
  const { items, list, seen, gate } = gated(["a"], async function* (_, gate) {
    yield el("b");
    await gate;
  });
  mount(el(), list);
  await setImmediate();
  items[0] = "b";
  await setImmediate();
  assert.equal(seen.length, 1);
  gate.resolve();
  await setImmediate();
  assert.equal(seen.length, 2);
  assert.equal((await seen[1][Symbol.asyncIterator]().next()).value, "b");
  await setImmediate();
  assert.equal(seen.length, 2);
});

test("JX-03C a static child from a new render changes the nodes after a set", async () => {
  const { items, list, seen } = gated(["a"], async item => {
    if (seen.length > 1) return "s";
    for await (const _ of item) break;
  });
  await setImmediate();
  await list.next();
  await setImmediate();
  await list.next();
  const next = list.next();
  items[0] = "b";
  assert.deepEqual(
    (await next).value?.map(node => (node as any).data),
    ["s"],
  );
  await list.return();
});

test("JX-03C an entry that leaves after its child ends does not render again", async () => {
  const { items, list, seen, gate } = gated(["a"], async function* (_, gate) {
    yield el("b");
    await gate;
  });
  await setImmediate();
  await list.next();
  await setImmediate();
  await list.next();
  items[0] = "b";
  items.push("c");
  await setImmediate();
  await list.next();
  gate.resolve();
  items.shift();
  await setImmediate();
  const { value } = await list.next();
  assert.equal(value?.length, 1);
  assert.equal(seen.length, 2);
  await list.return();
});

// Mounts each with static rows, and keeps the item that render gets for each row.
const handles = (initial: string[]) => {
  const parent = el(),
    items = select(initial, {
      autoStart: true,
      autoClose: false,
      nonYielding: true,
    }),
    seen: Item<string>[] = [];
  mount(
    parent,
    each(items, item => (seen.push(item), el("li"))),
  );
  return { parent, items, seen };
};

test("JX-03D value follows the item, and keeps the last value after it leaves", async () => {
  const { items, seen } = handles(["a"]);
  await setImmediate();
  const [item] = seen;
  assert.equal(item.value, "a");
  items[0] = "b";
  await setImmediate();
  assert.equal(item.value, "b");
  items.pop();
  await setImmediate();
  assert.equal(item.value, "b");
});

test("JX-03E signal is one object, and aborts when the item leaves", async () => {
  const { items, seen } = handles(["a", "b"]);
  await setImmediate();
  const [a, b] = seen,
    signal = a.signal;
  assert.equal(a.signal, signal);
  assert.equal(signal.aborted, false);
  items.length = 0;
  await setImmediate();
  assert.equal(signal.aborted, true);
  assert.equal(signal.reason.name, "AbortError");
  assert.equal(b.signal.aborted, true);
  assert.equal(b.signal, b.signal);
});

test("JX-03F an item makes one latest channel at its first iteration", async () => {
  const made: unknown[] = [];
  (globalThis as any)[Symbol.for("gg.devtools")] = (
    kind: string,
    target: unknown,
  ) => {
    if (kind === "channel") made.push(target);
  };
  try {
    const { items, seen } = handles(["a", "b"]);
    await setImmediate();
    const selects = made.length;
    made.length = 0;
    assert.equal(selects, 3); // The channels of the items select and of two drives
    const [a, b] = seen,
      first = a[Symbol.asyncIterator](),
      second = a[Symbol.asyncIterator]();
    assert.equal(made.length, 1);
    items[0] = "c";
    items[0] = "d";
    await setImmediate();
    assert.deepEqual(await first.next(), { value: "d", done: false });
    assert.deepEqual(await second.next(), { value: "d", done: false });
    items.length = 0;
    await setImmediate();
    assert.deepEqual(await first.next(), { value: undefined, done: true });
    const late = b[Symbol.asyncIterator]();
    assert.deepEqual(await late.next(), { value: "b", done: false });
    assert.deepEqual(await late.next(), { value: undefined, done: true });
    assert.equal(made.length, 2);
  } finally {
    delete (globalThis as any)[Symbol.for("gg.devtools")];
  }
});

const Theme = createContext<string>(Symbol("theme"));

test("JX-050 createContext gives its key", () => {
  const key = Symbol("key");
  assert.equal(createContext(key), key);
});

test("JX-051 Provide needs one element child, and gives it with a listener", () => {
  for (const bad of [
    undefined,
    "x",
    [el()],
    new FakeText("t"),
    Promise.resolve(el()),
  ])
    assert.throws(
      () => Provide({ context: Theme, value: "v", children: bad as any }),
      /one element child/,
    );
  const node = el();
  assert.equal(Provide({ context: Theme, value: "v", children: node }), node);
  assert.deepEqual(
    node.listeners.map(([type]: [string]) => type),
    ["context-request"],
  );
});

test("JX-052 JX-053 the nearest provider of a context answers, and stops the request", () => {
  const Other = createContext<number>(Symbol("other")),
    inner = new FakeText("i") as any,
    outer = new FakeText("o") as any,
    reached: unknown[] = [],
    root = el();
  root.addEventListener("context-request", (event: any) =>
    reached.push(event.context),
  );
  root.append(
    h(Provide, {
      context: Theme,
      value: "outer",
      children: h("div", {
        children: [
          h(Provide, {
            context: Theme,
            value: "inner",
            children: h("p", {
              children: h(Provide, {
                context: Other,
                value: 1,
                children: h("b", { children: inner }),
              }),
            }),
          }),
          h("i", { children: outer }),
        ],
      }),
    }),
  );
  assert.equal(consume(inner, Theme), "inner");
  assert.equal(consume(inner, Other), 1);
  assert.equal(consume(outer, Theme), "outer");
  assert.deepEqual(reached, []);
  assert.throws(() => consume(outer, Other), /No provider/);
  assert.deepEqual(reached, [Other]);
});

test("JX-053 consume dispatches a context-request event, and takes the first answer", () => {
  const node = el(),
    leaf = new FakeText("t") as any,
    seen: any[] = [];
  node.addEventListener("context-request", (event: any) => {
    seen.push(event);
    event.callback(1);
    event.callback(2);
  });
  node.append(leaf);
  assert.equal(consume(leaf, Theme), 1);
  const [event] = seen;
  assert.deepEqual(
    [
      event.type,
      event.bubbles,
      event.composed,
      event.context,
      event.contextTarget,
      event.subscribe,
    ],
    ["context-request", true, true, Theme, leaf, false],
  );
  assert.ok(event instanceof Event);
});

test("JX-054 use waits until the runtime places its placeholder, also in each rows", async () => {
  reported.length = 0;
  const { value: anchor } = (await use(Theme).next()) as { value: Comment };
  assert.deepEqual([anchor.nodeType, anchor.data], [8, ""]);
  async function* Label({ prefix }: { prefix: string }) {
    const theme = yield* use(Theme);
    yield h("b", { children: `${prefix}${theme}` });
  }
  const items = select(["a", "b"], {
    autoStart: true,
    autoClose: false,
    nonYielding: true,
  });
  const tree = h(Provide, {
    context: Theme,
    value: "!",
    children: h("div", {
      children: [
        h(Label, { prefix: "x" }),
        h("ul", {
          children: each(items, item => h(Label, { prefix: item.value })),
        }),
      ],
    }),
  });
  await setImmediate();
  assert.equal(html(tree), "<div><ul></ul></div>");
  mount(el(), tree);
  await setImmediate();
  assert.equal(html(tree), "<div><b>x!</b><ul><b>a!</b><b>b!</b></ul></div>");
  assert.deepEqual(reported, []);
});
