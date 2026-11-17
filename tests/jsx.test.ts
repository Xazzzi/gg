import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { inspect } from "node:util";
import { CHAN, Channel, derive, StopError, select } from "../src/index.ts";
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
    data: "x",
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
      ["data", "x"],
      ["d", ""],
      ["e", "0"],
      ["f", "s"],
    ],
  );
  assert.equal(html(h("a", { href: "x", children: "t" })), '<a href="x">t</a>');
  assert.throws(
    () => h("p", { data: fn }),
    /TypeError: data does not take a function/,
  );
});

test("JX-002 an event type keeps its case, unless the element has a handler property for the lower case key", () => {
  const listen = () => {};
  const node = h("div", {
    onClick: listen,
    onDblClick: listen,
    onitemSelected: listen,
    "onsl-change": listen,
    onDOMContentLoaded: listen,
  });
  assert.deepEqual(
    node.listeners.map(([type]: [string]) => type),
    ["click", "dblclick", "itemSelected", "sl-change", "DOMContentLoaded"],
  );
});

test("JX-002 an object with no text of its own, and a symbol, throw at an attribute", () => {
  assert.throws(
    () => h("p", { style: { color: "red" } }),
    /TypeError: style does not take a plain object/,
  );
  assert.throws(() => h("p", { style: Object.create(null) }), TypeError);
  assert.throws(() => h("p", { title: Symbol("t") }), TypeError);
  const url = { toString: () => "/x" };
  assert.equal(
    html(h("a", { href: url, rel: ["a", "b"], value: {} })),
    '<a href="/x" rel="a,b"></a>',
  );
});

test("JX-001 takes the namespace from xmlns, then from an SVG tag", () => {
  const SVG = "http://www.w3.org/2000/svg",
    XHTML = "http://www.w3.org/1999/xhtml",
    MATH = "http://www.w3.org/1998/Math/MathML";
  for (const tag of ["svg", "path", "mpath", "feBlend", "feTurbulence", "feX"])
    assert.equal(h(tag).namespaceURI, SVG, tag);
  for (const tag of ["div", "a", "title", "fe", "feed", "feblend", "x-feBlend"])
    assert.equal(h(tag).namespaceURI, XHTML, tag);
  assert.equal(h("math", { xmlns: MATH }).namespaceURI, MATH);
  const link = h("a", { xmlns: SVG, href: "#x" });
  assert.equal(link.namespaceURI, SVG);
  assert.equal(html(link), `<a xmlns="${SVG}" href="#x"></a>`);
  assert.equal(h("svg", { xmlns: 1 }).namespaceURI, SVG);
  assert.equal(h("div", { xmlns: null }).namespaceURI, XHTML);
});

test("JX-002 assigns live properties, also null and false, and skips them for undefined", () => {
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
  const off = h("input", { value: null, checked: false, muted: undefined });
  assert.deepEqual(
    [off.value, off.checked, "muted" in off],
    [null, false, false],
  );
  assert.deepEqual([...off.attributes], []);
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

test("JX-007 a Fragment holds static nodes, and gives children with a dynamic child to a host", async () => {
  const fragment = Fragment({ children: ["a", el("b")] }) as any;
  assert.equal(fragment.nodeType, 11);
  assert.equal(html(fragment), "a<b></b>");
  assert.equal(html(Fragment({}) as any), "");
  const count = latest<number>();
  count.send(1);
  for (const children of [count, ["a", [el("b"), Promise.resolve("p")], "c"]])
    assert.equal(Fragment({ children }), children);
  const parent = el();
  mount(parent, "x", h(Fragment, { children: ["a", [count], "c"] }), "y");
  assert.equal(html(parent), "<div>xacy</div>");
  await setImmediate();
  assert.equal(html(parent), "<div>xa1cy</div>");
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

test("JX-023 an output that keeps the nodes does not place", async () => {
  const parent = el(),
    node = el("n"),
    values = latest<any>();
  mount(parent, values);
  values.send("a");
  await setImmediate();
  parent.append(el("own"));
  values.send("b");
  await setImmediate();
  values.send("b");
  await setImmediate();
  assert.equal(html(parent), "<div>b<own></own></div>");
  values.send(node);
  await setImmediate();
  assert.equal(html(parent), "<div><n></n></div>");
  parent.append(el("own"));
  values.send(node);
  await setImmediate();
  assert.equal(html(parent), "<div><n></n><own></own></div>");
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

test("JX-028 JX-027 a rejection or a bad output reports an error, and the entry keeps its nodes", async () => {
  reported.length = 0;
  const parent = el(),
    failure = new Error("x"),
    values = latest<any>();
  mount(parent, Promise.reject(failure), values, Promise.resolve("ok"));
  values.send("v");
  await setImmediate();
  values.send({});
  await setImmediate();
  assert.equal(html(parent), "<div>vok</div>");
  assert.equal(reported[0], failure);
  assert.ok(reported[1] instanceof TypeError);
  assert.equal(reported.length, 2);
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

test("JX-060 a dynamic on prop throws", () => {
  for (const value of [Promise.resolve(() => {}), latest()])
    assert.throws(() => h("button", { onclick: value }), {
      name: "TypeError",
      message: "onclick does not take a dynamic value",
    });
});

test("JX-061 JX-064 a dynamic prop waits for placement, then sets and removes its attribute", async () => {
  const cls = latest<unknown>(),
    node = h("p", { title: "t", class: cls });
  cls.send("a");
  await setImmediate();
  assert.equal(html(node), '<p title="t"></p>');
  mount(el(), node);
  await setImmediate();
  assert.equal(html(node), '<p title="t" class="a"></p>');
  const outputs: [unknown, string][] = [
    [true, '<p title="t" class=""></p>'],
    [false, '<p title="t"></p>'],
    [1, '<p title="t" class="1"></p>'],
    [null, '<p title="t"></p>'],
    ["b", '<p title="t" class="b"></p>'],
    [undefined, '<p title="t"></p>'],
  ];
  for (const [value, expected] of outputs) {
    cls.send(value);
    await setImmediate();
    assert.equal(html(node), expected);
  }
  cls.close();
});

test("JX-061 JX-066 the select of dynamic props closes when they finish", async () => {
  const p = Promise.withResolvers<string>(),
    node = h("p", { title: p.promise });
  const [channel] = await selects(async () => {
    mount(el(), node);
    await setImmediate();
  });
  assert.equal(channel.signal.aborted, false);
  p.resolve("t");
  await setImmediate();
  assert.equal(html(node), '<p title="t"></p>');
  assert.equal(channel.signal.aborted, true);
});

test("JX-061 an element starts its children before its dynamic props", async () => {
  const log: string[] = [],
    thenable = (name: string) => ({ then: () => log.push(name) });
  mount(
    el(),
    h("select", { value: thenable("prop"), children: thenable("child") }),
  );
  await setImmediate();
  assert.deepEqual(log, ["child", "prop"]);
});

test("JX-062 a pending state and a repeat output change nothing", async () => {
  const title = latest<unknown>(),
    gate = Promise.withResolvers<string>(),
    node = h("p", { title, lang: gate.promise }),
    calls: string[] = [];
  node.setAttribute = (name: string) => calls.push(`set ${name}`);
  node.removeAttribute = (name: string) => calls.push(`remove ${name}`);
  mount(el(), node);
  title.send(undefined);
  await setImmediate();
  title.send("a");
  await setImmediate();
  title.send("a");
  await setImmediate();
  assert.deepEqual(calls, ["set title"]);
  gate.resolve("en");
  await setImmediate();
  assert.deepEqual(calls, ["set title", "set lang"]);
  title.close();
});

test("JX-063 an output at a live property is assigned as it is", async () => {
  const value = latest<unknown>(),
    checked = latest<unknown>(),
    node = h("input", { value, checked });
  mount(el(), node);
  value.send("x");
  checked.send(true);
  await setImmediate();
  assert.equal(node.value, "x");
  assert.equal(node.checked, true);
  value.send(null);
  checked.send(false);
  await setImmediate();
  assert.equal(node.value, null);
  assert.equal(node.checked, false);
  assert.equal(html(node), "<input></input>");
  value.close();
  checked.close();
});

test("JX-064 JX-065 a plain object output at an attribute reports a TypeError", async () => {
  reported.length = 0;
  const style = latest<unknown>(),
    node = h("p", { style });
  mount(el(), node);
  style.send("a");
  await setImmediate();
  style.send({ color: "red" });
  await setImmediate();
  assert.equal(reported.length, 1);
  assert.ok(reported[0] instanceof TypeError);
  assert.equal(html(node), '<p style="a"></p>');
  style.close();
});

test("JX-065 a rejection and a failed output report, and the other props continue", async () => {
  reported.length = 0;
  const error = new Error("bad"),
    title = latest<unknown>(),
    value = latest<unknown>(),
    node = h("input", { title, value, lang: Promise.reject(error) });
  Object.defineProperty(node, "value", {
    set() {
      throw error;
    },
  });
  mount(el(), node);
  title.send("a");
  await setImmediate();
  title.send(Symbol("s"));
  value.send("v");
  await setImmediate();
  assert.equal(reported.length, 3);
  assert.equal(reported[0], error);
  assert.ok(reported.includes(error));
  assert.equal(html(node), '<input title="a"></input>');
  title.send("b");
  await setImmediate();
  assert.equal(html(node), '<input title="b"></input>');
  title.close();
  value.close();
});

test("JX-066 a dynamic prop keeps its last output, and stops with the unmount of a mount around it", async () => {
  const outer = latest<unknown>(),
    inner = latest<unknown>(),
    child = h("b", { title: inner }),
    parent = h("p", { title: outer, children: child }),
    root = el();
  const unmount = mount(root, parent);
  outer.send("o");
  inner.send("i");
  await setImmediate();
  const stop = mount(parent, child);
  stop();
  mount(parent, child);
  outer.send("o2");
  inner.send("i2");
  await setImmediate();
  assert.equal(html(parent), '<p title="o2"><b title="i"></b></p>');
  unmount();
  outer.send("o3");
  await setImmediate();
  assert.equal(html(parent), '<p title="o2"><b title="i"></b></p>');
  const done = h("p", { title: Promise.resolve("x") });
  mount(el(), done);
  await setImmediate();
  assert.equal(html(done), '<p title="x"></p>');
});

test("JX-02A an unmount function does nothing after a later mount into the same parent", async () => {
  const parent = el(),
    ch = latest<string>();
  const first = mount(parent, "a");
  const second = mount(parent, h("p", { children: ch }));
  first();
  ch.send("b");
  await setImmediate();
  assert.equal(html(parent), "<div><p>b</p></div>");
  second();
  assert.equal(html(parent), "<div></div>");
  // A later call removes no child that other code added.
  parent.append(fakeDocument.createTextNode("x"));
  second();
  assert.equal(html(parent), "<div>x</div>");
  // A mount after an unmount gets its own function.
  const third = mount(parent, "c");
  second();
  assert.equal(html(parent), "<div>c</div>");
  third();
  assert.equal(html(parent), "<div></div>");
});

test("JX-02A JX-081 an unmount function after the unmount of a mount around it empties its parent", async () => {
  const root = el(),
    box = el("section"),
    ch = latest<string>();
  const outer = mount(root, box);
  const inner = mount(box, ch);
  ch.send("a");
  await setImmediate();
  outer(); // Stops the scope of box, which the mount around it holds
  inner();
  assert.equal(html(box), "<section></section>");
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

test("JX-02B a placement walks no node while no element waits", async () => {
  const spy = () => {
    const node = el("b");
    let reads = 0;
    Object.defineProperty(node, "firstChild", { get: () => (reads++, null) });
    return { node, reads: () => reads };
  };
  // Waits of collected elements from other tests count until a collection.
  let idle = spy();
  for (let i = 0; i < 20; i++) {
    await setImmediate();
    globalThis.gc?.();
    mount(el(), (idle = spy()).node);
    if (!idle.reads()) break;
  }
  assert.equal(idle.reads(), 0);
  const child = h("p", { children: latest() }),
    prop = h("p", { title: latest() });
  const walked = spy();
  mount(el(), walked.node);
  assert.equal(walked.reads(), 1);
  mount(child, "x");
  mount(el(), prop);
  await setImmediate();
  const after = spy();
  mount(el(), after.node);
  assert.equal(after.reads(), 0);
});

test("JX-02B a later placement starts no element again, and none whose wait ended", async () => {
  const parent = el(),
    output = latest<any>(),
    text = latest<string>(),
    idle = h("p", { children: text }),
    node = h("p", { title: text, children: text }),
    ended = h("p", { children: text });
  text.send("t");
  mount(ended, "x");
  const channels = await selects(async () => {
    mount(parent, output);
    for (const value of [node, null, [node, ended]]) {
      output.send(value);
      await setImmediate();
    }
  });
  assert.equal(channels.length, 3);
  assert.equal(html(parent), '<div><p title="t">t</p><p>x</p></div>');
  assert.equal(html(idle), "<p></p>");
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
    backPressure: false,
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
      backPressure: false,
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

test("JX-028 JX-037 an item that rejects or gives a bad child does not make each yield", async () => {
  for (const settle of [
    (p: PromiseWithResolvers<unknown>) => p.reject(new Error("x")),
    (p: PromiseWithResolvers<unknown>) => p.resolve({}),
  ]) {
    const gate = Promise.withResolvers<unknown>(),
      items = select(["a"], {
        autoStart: true,
        autoClose: false,
        backPressure: false,
      }),
      list = each(items, () => gate.promise as any);
    await setImmediate();
    await list.next();
    const next = list.next(),
      count = reported.length;
    settle(gate);
    await setImmediate();
    assert.equal(reported.length, count + 1);
    assert.match(inspect(next), /pending/);
    await list.return();
  }
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

test("JX-033 JX-03G JX-037 a swap by two sets moves the rows, and a new value at an index goes to its row", async () => {
  const s = mounted(["a", "b", "c"]);
  await setImmediate();
  reset(s.parent);
  [s.items[0], s.items[2]] = [s.items[2], s.items[0]];
  await setImmediate();
  assert.equal(html(s.parent), rows("c", "b", "a"));
  assert.equal(s.renders(), 3);
  assert.deepEqual(s.log, ["a", "b", "c"]);
  assert.deepEqual(s.parent.counts, { insert: 2, remove: 0 });
  s.items[1] = "x";
  await setImmediate();
  assert.equal(html(s.parent), rows("c", "x", "a"));
  assert.equal(s.renders(), 3);
  assert.deepEqual(s.log, ["a", "b", "c", "x"]);
});

test("JX-037 JX-03G a read of sets that replaces one row of several places the nodes", async () => {
  const parent = el("ul"),
    items = select(["a1", "b1"], { autoStart: true });
  mount(
    parent,
    each(items, item => h("li", { children: item.value }), {
      key: value => value[0],
    }),
  );
  await setImmediate();
  items[0] = "c1";
  items[1] = "b2";
  await setImmediate();
  assert.equal(html(parent), "<ul><li>c1</li><li>b1</li></ul>");
  items[CHAN].close();
});

test("JX-03G a slot that gives the same value again gives it to its item again", async () => {
  const row = { v: 1 },
    source = latest<typeof row>(),
    items = select([source], { autoStart: true, unwrap: true }),
    values: unknown[] = [];
  source.send(row);
  mount(
    el("ul"),
    each(items, item => {
      void (async () => {
        for await (const value of item) values.push(value && { ...value });
      })();
      return el("li");
    }),
  );
  await setImmediate();
  row.v = 2;
  source.send(row);
  await setImmediate();
  assert.deepEqual(values.at(-1), { v: 2 });
  assert.ok(values.length >= 2);
  items[CHAN].close();
});

test("JX-03G with key, a value with the key of an item updates its row, and a new key renders a new row", async () => {
  const parent = el("ul"),
    items = select(
      [
        { id: 1, v: "a" },
        { id: 2, v: "b" },
      ],
      { autoStart: true },
    ),
    seen: Item<{ id: number; v: string }>[] = [];
  mount(
    parent,
    each(items, item => (seen.push(item), el("li")), { key: row => row.id }),
  );
  await setImmediate();
  items[0] = { id: 1, v: "a2" };
  items[1] = { id: 3, v: "c" };
  await setImmediate();
  assert.equal(seen.length, 3);
  assert.equal(seen[0].value.v, "a2");
  assert.ok(seen[1].signal.aborted);
  assert.equal(seen[2].value.v, "c");
  assert.throws(() => each(items, () => null, { key: 1 } as any), TypeError);
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

test("JX-035 an entry that leaves stops the hosts and the dynamic props that started in its nodes", async () => {
  const parent = el("ul"),
    text = latest<string>(),
    title = latest<string>();
  text.send("t");
  title.send("p");
  const items = select(["a", "b"], {
    autoStart: true,
    autoClose: false,
    backPressure: false,
  });
  const row = () =>
    h("li", {
      title,
      children: [
        h("span", { children: h("i", { title }) }),
        h("b", { title, children: text }),
      ],
    });
  const channels = await selects(async () => {
    mount(parent, each(items, row));
    await setImmediate();
  });
  const li =
    '<li title="p"><span><i title="p"></i></span><b title="p">t</b></li>';
  assert.equal(html(parent), `<ul>${li}${li}</ul>`);
  assert.equal(channels.length, 10);
  items.shift();
  await setImmediate();
  assert.equal(html(parent), `<ul>${li}</ul>`);
  assert.deepEqual(
    channels.map(channel => channel.signal.aborted),
    [false, false, true, true, true, true, false, false, false, false],
  );
});

test("JX-046 JX-080 a started element that code moves stays bound to the entry under which it started", async () => {
  const parent = el("ul"),
    text = latest<string>(),
    moved = h("b", { children: text }),
    li = h("li", { children: [moved, h("i", { children: text })] });
  text.send("t");
  const items = select(["a"], {
    autoStart: true,
    autoClose: false,
    backPressure: false,
  });
  const channels = await selects(async () => {
    mount(
      parent,
      each(items, () => li),
    );
    await setImmediate();
  });
  const span = el("span");
  span.append(moved);
  li.append(span);
  items.pop();
  await setImmediate();
  assert.equal(html(parent), "<ul></ul>");
  assert.deepEqual(
    channels.map(channel => channel.signal.aborted),
    [false, false, true, true],
  );
});

test("JX-029 a place arranges only the children between the ones that stay at both ends", async () => {
  const parent = el(),
    output = latest<any>(),
    [a, b, c, d, e] = ["a", "b", "c", "d", "e"].map(el);
  mount(parent, output);
  const step = async (nodes: any[], insert: number, remove: number) => {
    reset(parent);
    output.send(nodes);
    await setImmediate();
    assert.equal(
      html(parent),
      `<div>${[...new Set(nodes.toReversed())].toReversed().map(html).join("")}</div>`,
    );
    assert.deepEqual(parent.counts, { insert, remove });
  };
  await step([a, b, c], 3, 0);
  await step([a, b, c, d], 1, 0);
  await step([e, a, b, c, d], 1, 0);
  await step([e, a, c, d], 0, 1);
  await step([e, c, a, d], 1, 0);
  await step([e, b, d], 1, 2);
  await step([e, d], 0, 1);
  await step([e, d, e], 1, 0);
  await step([d, d, e], 0, 0);
  await step([], 0, 2);
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
      backPressure: false,
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
      backPressure: false,
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

test("JX-031 SE-037 each starts a select that did not start, and renders the start description", async () => {
  const parent = el(),
    items = select(["a", "b"]);
  mount(
    parent,
    each(items, () => "x"),
  );
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
      backPressure: false,
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

test("JX-03A JX-039 an error from render ends the items that the same read rendered before it", async () => {
  const failure = new Error("x"),
    seen: Item<string>[] = [],
    returned: string[] = [],
    items = select(["a"], {
      autoStart: true,
      autoClose: false,
      backPressure: false,
    });
  // Row b gives a dynamic child that the drive never got, so each returns it itself.
  const child = {
    [Symbol.asyncIterator]: () => child,
    next: async () => ({ done: false, value: "y" }),
    return: async () => (returned.push("b"), { done: true, value: undefined }),
  };
  const list = each(items, item => {
    if (item.value === "c") throw failure;
    seen.push(item);
    return item.value === "b" ? child : "x";
  });
  await setImmediate();
  await list.next();
  items.push("b", "c");
  await assert.rejects(list.next(), failure);
  assert.deepEqual(returned, ["b"]);
  assert.deepEqual(
    seen.map(item => [item.value, item.signal.aborted]),
    [
      ["a", true],
      ["b", true],
    ],
  );
  const reader = (seen[1] as Item<string>)[Symbol.asyncIterator]();
  assert.deepEqual(await reader.next(), { done: false, value: "b" });
  assert.deepEqual(await reader.next(), { done: true, value: undefined });
});

test("JX-03A a render result with a nested dynamic child ends each", async () => {
  const items = select(["a"], {
    autoStart: true,
    autoClose: false,
    backPressure: false,
  });
  const list = each(items, () => [Promise.resolve("x")]);
  await setImmediate();
  await assert.rejects(list.next(), {
    name: "TypeError",
    message: "A dynamic child is not permitted here",
  });
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
      backPressure: false,
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

test("JX-03C JX-024 an entry that renders again keeps its nodes while its new child is pending", async () => {
  const parent = el(),
    later = Promise.withResolvers<unknown>();
  const { items, list } = gated(["a"], item =>
    item.value === "a"
      ? Promise.resolve(h("b", { children: "a" }))
      : later.promise,
  );
  mount(parent, list);
  await setImmediate();
  assert.equal(html(parent), "<div><b>a</b></div>");
  items[0] = "b";
  await setImmediate();
  assert.equal(html(parent), "<div><b>a</b></div>");
  later.resolve(h("b", { children: "b" }));
  await setImmediate();
  assert.equal(html(parent), "<div><b>b</b></div>");
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
  const next = list.next();
  items[0] = "b";
  assert.deepEqual(
    (await next).value?.map(node => (node as any).data),
    ["s"],
  );
  await list.return();
});

test("JX-03C a static child of a new render yields at once", async () => {
  let renders = 0;
  const { items, list } = gated(["a"], item =>
    renders++
      ? "s"
      : (async () => {
          for await (const _ of item) break;
        })(),
  );
  await setImmediate();
  await list.next();
  await setImmediate();
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
      backPressure: false,
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

test("JX-03E signal is one object, and aborts with a StopError when the item leaves", async () => {
  const { items, seen } = handles(["a", "b"]);
  await setImmediate();
  const [a, b] = seen,
    signal = a.signal;
  assert.equal(a.signal, signal);
  assert.equal(signal.aborted, false);
  items.length = 0;
  await setImmediate();
  assert.equal(signal.aborted, true);
  assert.ok(signal.reason instanceof StopError);
  assert.equal(signal.reason.reason, "item left");
  assert.ok(b.signal.reason instanceof StopError);
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
    backPressure: false,
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

test("JX-054 JX-041 JX-089 a use that its drive lets go before a place throws a StopError, which no code reports", async () => {
  reported.length = 0;
  const log: unknown[] = [];
  async function* Waits() {
    try {
      yield* use(Theme);
      log.push("placed");
    } catch (error) {
      log.push(error instanceof StopError, (error as StopError).reason);
      throw error;
    } finally {
      log.push("finally");
    }
  }
  // No host places the nodes of this each, so its drive pulls each row again, which then waits in use.
  const items = select(["a"], { autoStart: true, backPressure: false }),
    list = each(items, () => h(Waits));
  await list.next();
  void list.next(); // Reads the rows, and yields their placeholders
  await setImmediate();
  assert.deepEqual(log, []);
  await list.return();
  await setImmediate();
  assert.deepEqual(log, [true, "use not placed", "finally"]);
  assert.deepEqual(reported, []);
});

test("JX-054 HE-059 a use whose placeholder a builder stops throws a StopError", async () => {
  const n = new Channel<number>(),
    waits: Promise<unknown>[] = [];
  const view = derive(n, value => {
    const wait = use(Theme);
    void wait.next();
    waits.push(wait.next());
    return value;
  });
  n.send(1), n.send(2);
  await view.next();
  await view.next();
  await assert.rejects(
    waits[0],
    (error: unknown) => error instanceof StopError,
  );
  await view.return();
  await assert.rejects(
    waits[1],
    (error: unknown) => error instanceof StopError,
  );
});

test("JX-054 HE-059 a use that a builder stops while no code waits for it causes no unhandledRejection", async () => {
  const n = new Channel<number>(),
    seen: unknown[] = [],
    listeners = process.listeners("unhandledRejection");
  process.removeAllListeners("unhandledRejection");
  process.on("unhandledRejection", error => seen.push(error));
  try {
    // The generator stays at the yield of its placeholder, so no code reads the rejection.
    const view = derive(n, value => (void use(Theme).next(), value));
    n.send(1);
    await view.next();
    await view.return();
    await setImmediate();
    assert.deepEqual(seen, []);
  } finally {
    process.removeAllListeners("unhandledRejection");
    for (const listener of listeners)
      process.on("unhandledRejection", listener);
  }
});

test("JX-088 a place that throws reports the error, and stops the drive of the host", async () => {
  reported.length = 0;
  const parent = el(),
    failure = new Error("place"),
    bad = el("b"),
    values = latest<any>(),
    insert = parent.insertBefore;
  parent.insertBefore = function (node: any, ref: any) {
    if (node === bad) throw failure;
    return insert.call(this, node, ref);
  };
  mount(parent, values);
  values.send(bad);
  await setImmediate();
  assert.deepEqual(reported, [failure]);
  values.send("ok");
  await setImmediate();
  assert.equal(html(parent), "<div></div>");
});

test("JX-088 a start that throws in a place reports the error, and stops the drive of the host", async () => {
  reported.length = 0;
  const failure = new Error("start");
  let reads = 0;
  // The conversion reads then one time, and the start of the inner host reads it again.
  const source = {
    get then() {
      if (++reads > 1) throw failure;
      return () => {};
    },
  };
  const parent = el(),
    values = latest<any>();
  mount(parent, values);
  values.send(h("p", { children: source }));
  await setImmediate();
  assert.deepEqual(reported, [failure]);
  values.send("ok");
  await setImmediate();
  assert.equal(html(parent), "<div><p></p></div>");
});

test("JX-089 a row that fails after its item leaves reports the error", async () => {
  reported.length = 0;
  const failure = new Error("row"),
    state = select(["a"]),
    parent = el();
  async function* Row({ item }: { item: Item<string> }) {
    yield h("li", { children: item.value });
    for await (const value of item) void value;
    throw failure;
  }
  mount(
    parent,
    each(state, item => h(Row, { item })),
  );
  await setImmediate();
  assert.equal(html(parent), "<div><li>a</li></div>");
  state.pop();
  await setImmediate();
  assert.deepEqual(reported, [failure]);
});

test("JX-089 a return() that fails when the host stops reports the error, and a child with no return() reports nothing", async () => {
  reported.length = 0;
  const failure = new Error("return"),
    never = () => new Promise<IteratorResult<string>>(() => {});
  const failing = {
      [Symbol.asyncIterator]: () => ({
        next: never,
        return() {
          throw failure;
        },
      }),
    },
    bare = { [Symbol.asyncIterator]: () => ({ next: never }) };
  const unmount = mount(el(), failing, bare);
  await setImmediate();
  unmount();
  await setImmediate();
  assert.deepEqual(reported, [failure]);
});

test("JX-089 a promise row that rejects after its item leaves reports the error", async () => {
  reported.length = 0;
  const failure = new Error("late"),
    row = Promise.withResolvers<string>(),
    state = select(["a"]),
    parent = el();
  mount(
    parent,
    each(state, () => row.promise),
  );
  await setImmediate();
  state.pop();
  await setImmediate();
  row.reject(failure);
  await setImmediate();
  assert.deepEqual(reported, [failure]);
});

// A card defines items and render as fields, and label and note as accessors, which log each assignment with the count of children.
class Card extends FakeElement {
  items: unknown = "none";
  render: unknown;
  log: string[] = [];
  get label() {
    return this.log.at(-1);
  }
  set label(value: unknown) {
    this.log.push(`label ${value} ${this.childNodes.length}`);
  }
  get note() {
    return this.log.at(-1);
  }
  set note(value: unknown) {
    this.log.push(`note ${value} ${this.childNodes.length}`);
  }
}
let tags = 0;
/** Gives a new tag, which a test can define when it chooses. */
const tag = () => `x-card${tags++}`;
/** Defines a new tag as a Card, and gives it. */
const card = () => {
  const name = tag();
  customElements.define(name, Card as any);
  return name;
};
// Each own property of a fake element, and a sink of the prototype of each element.
Object.defineProperty(FakeElement.prototype, "innerHTML", {
  set(value) {
    this.sunk = value;
  },
});

test("JX-0B0 a custom element gets its own properties as properties after its children, and attributes for the rest", () => {
  const items = [1, 2],
    render = () => "r";
  const node = h(card(), {
    items,
    label: { text: "l" },
    render,
    id: "i",
    class: "c",
    "data-x": 1,
    slot: null,
    children: "t",
  });
  assert.ok(node instanceof Card);
  assert.equal(node.items, items);
  assert.deepEqual(node.log, ["label [object Object] 1"]);
  assert.equal(node.render, render);
  assert.deepEqual(
    [...node.attributes],
    [
      ["id", "i"],
      ["class", "c"],
      ["data-x", "1"],
    ],
  );
  // An element of a dashed tag with no customElements is not a custom element.
  const registry = globalThis.customElements;
  delete (globalThis as any).customElements;
  try {
    assert.throws(() => h("x-plain", { items: {} }), TypeError);
  } finally {
    (globalThis as any).customElements = registry;
  }
  // xmlns makes an element that is not a custom element.
  assert.throws(() => h(card(), { xmlns: "urn:x", items: {} }), TypeError);
  // A field of an element that is not a custom element stays an attribute.
  assert.deepEqual(
    [...h("div", { tagName: "x" }).attributes],
    [["tagName", "x"]],
  );
});

test("JX-0B0 JX-002 JX-0B2 a static null or false sets an own property, also after a hold, and undefined keeps the field", async () => {
  const defined = h(card(), { items: false, render: null, label: undefined });
  assert.deepEqual(
    [defined.items, defined.render, defined.log],
    [false, null, []],
  );
  const name = tag(),
    node = h(name, { items: null, render: false, label: undefined, id: false });
  customElements.define(name, Card as any);
  await setImmediate();
  assert.deepEqual([node.items, node.render, node.log], [null, false, []]);
  assert.deepEqual([...node.attributes], []);
});

test("JX-0B0 JX-063 a dynamic prop assigns an own property as it is", async () => {
  const source = latest<unknown>(),
    node = h(card(), { items: source });
  mount(el(), node);
  source.send([1]);
  await setImmediate();
  assert.deepEqual(node.items, [1]);
  source.send(null);
  await setImmediate();
  assert.equal(node.items, null);
  assert.deepEqual([...node.attributes], []);
});

test("JX-0B1 a property of HTMLElement.prototype is no own property, so data reaches no sink", () => {
  const node = h(card(), { innerHTML: "<b>x</b>", title: "t" });
  assert.equal(node.sunk, undefined);
  assert.deepEqual(
    [...node.attributes],
    [
      ["innerHTML", "<b>x</b>"],
      ["title", "t"],
    ],
  );
  assert.throws(() => h(card(), { onclick: "alert(1)" }), TypeError);
});

test("JX-0B4 a hold of a tag that code never defines retains nothing after its element goes", async () => {
  // A WeakRef that tells when the collector takes it, which it can only after the hold lets it go.
  const Real = globalThis.WeakRef,
    registry = new FinalizationRegistry<() => void>(done => done());
  let done = false;
  globalThis.WeakRef = class<T extends WeakKey> extends Real<T> {
    constructor(target: T) {
      super(target);
      registry.register(this, () => (done = true));
    }
  } as WeakRefConstructor;
  try {
    (() => jsx("x-never", { label: "a" }))();
  } finally {
    globalThis.WeakRef = Real;
  }
  for (let i = 0; i < 20 && !done; i++) {
    await setImmediate();
    globalThis.gc?.();
  }
  assert.ok(done);
});

test("JX-0B4 a definition lets the refs of its tag go while their elements live", async () => {
  const Real = globalThis.WeakRef,
    registry = new FinalizationRegistry<() => void>(done => done()),
    name = tag();
  let done = false;
  globalThis.WeakRef = class<T extends WeakKey> extends Real<T> {
    constructor(target: T) {
      super(target);
      registry.register(this, () => (done = true));
    }
  } as WeakRefConstructor;
  let element: Element;
  try {
    element = h(name, { items: [1] });
  } finally {
    globalThis.WeakRef = Real;
  }
  customElements.define(name, Card as any);
  for (let i = 0; i < 20 && !done; i++) {
    await setImmediate();
    globalThis.gc?.();
  }
  assert.ok(done);
  assert.ok(element);
});

test("JX-0B2 JX-0B3 a custom element of a tag with no definition holds its values, and applies them in key order after the definition", async () => {
  const name = tag(),
    source = latest<unknown>(),
    note = latest<unknown>(),
    title = latest<unknown>(),
    clicks: unknown[] = [];
  const node = h(name, {
    note,
    label: "a",
    items: source,
    id: "i",
    title,
    class: "c",
    onClick: (event: unknown) => clicks.push(event),
    children: [h("p", { children: latest<string>() }), "t"],
  });
  assert.ok(!(node instanceof Card));
  // A key of HTMLElement.prototype is never own, so it writes at once, and class waits.
  assert.deepEqual([...node.attributes], [["id", "i"]]);
  assert.equal(node.listeners.length, 1);
  const parent = el();
  mount(parent, node);
  source.send("x");
  source.send([2]);
  note.send("n");
  title.send("t");
  await setImmediate();
  // The children and the drives run while the values wait.
  assert.equal(
    html(parent),
    `<div><${name} id="i" title="t"><p></p>t</${name}></div>`,
  );
  const other = h(name, { label: "b" });
  customElements.define(name, Card as any);
  await setImmediate();
  assert.ok(node instanceof Card);
  // The note comes first in key order, though its output came after the label.
  assert.deepEqual(node.log, ["note n 2", "label a 2"]);
  assert.deepEqual(other.log, ["label b 0"]);
  assert.deepEqual(node.items, [2]);
  assert.deepEqual(
    [...node.attributes],
    [
      ["id", "i"],
      ["title", "t"],
      ["class", "c"],
    ],
  );
  source.send([3]);
  await setImmediate();
  assert.deepEqual(node.items, [3]);
});

test("JX-0B2 a dynamic prop with no output before the definition keeps the field of the class", async () => {
  const name = tag(),
    node = h(name, { items: latest<unknown>() });
  mount(el(), node);
  customElements.define(name, Card as any);
  await setImmediate();
  assert.equal(node.items, "none");
});

test("JX-0B2 a tag that whenDefined rejects applies its values as attributes", async () => {
  reported.length = 0;
  const node = h("font-face", { label: "a", items: () => {}, id: "i" });
  await setImmediate();
  assert.deepEqual(
    [...node.attributes],
    [
      ["id", "i"], // Written at once, as a key that is never own
      ["label", "a"],
    ],
  );
  assert.match(String(reported[0]), /items does not take a function/);
  assert.equal(reported.length, 1);
  // A later element of the tag waits for whenDefined again.
  const next = h("font-face", { label: "b" });
  await setImmediate();
  assert.deepEqual([...next.attributes], [["label", "b"]]);
});

test("JX-0B4 a hold retains no element, and a definition skips a collected one", async () => {
  const registry = new FinalizationRegistry<() => void>(done => done()),
    name = tag();
  let collected = false;
  (() => {
    registry.register(h(name, { items: [1] }), () => (collected = true));
  })();
  await setImmediate();
  (globalThis.gc as () => void)(); // The registries run in a later task, so the hold still has the ref here
  customElements.define(name, Card as any);
  for (let i = 0; i < 20 && !collected; i++) {
    await setImmediate();
    globalThis.gc?.();
  }
  assert.ok(collected);
});

test("JX-008 a value at an on key that is no function throws, except null, undefined and false", () => {
  for (const value of ["alert(1)", true, 0])
    assert.throws(
      () => h("img", { onerror: value }),
      /TypeError: onerror takes a function/,
    );
  for (const value of [null, undefined, false]) {
    const node = h("img", { onerror: value });
    assert.deepEqual([node.listeners, [...node.attributes]], [[], []]);
  }
});

test("JX-008 JX-060 an on key in any case takes only a function, and listens as in lower case", () => {
  for (const name of ["OnClick", "ONERROR", "oNload"])
    assert.throws(
      () => h("img", { [name]: "alert(1)" }),
      new RegExp(`TypeError: ${name} takes a function`),
    );
  assert.throws(
    () => h("img", { OnError: latest<string>() }),
    /TypeError: OnError does not take a dynamic value/,
  );
  const listener = () => {},
    node = h("button", { OnClick: listener, ONDBLCLICK: listener });
  assert.deepEqual(node.listeners, [
    ["click", listener],
    ["dblclick", listener],
  ]);
});

test("JX-009 a javascript: URL throws at a URL attribute, as the URL parser reads it", () => {
  const script = "javascript:".split("");
  const urls = [
    "javascript:alert(1)",
    "JavaScript:x",
    " \u0000\u001Fjavascript:x",
    script.join("\t"),
    script.join("\n"),
    script.join("\r"),
  ];
  for (const url of urls)
    assert.throws(
      () => h("a", { href: url }),
      /TypeError: href does not take a javascript: URL/,
    );
  for (const name of ["src", "action", "formAction", "xlink:href", "HREF"])
    assert.throws(() => h("a", { [name]: "javascript:x" }), TypeError);
  const safe = h("a", {
    href: "/javascript:x",
    src: "x javascript:",
    action: "javascripts:x",
    title: "javascript:x",
  });
  assert.equal(safe.attributes.get("href"), "/javascript:x");
  assert.equal(safe.attributes.get("title"), "javascript:x");
});

test("JX-009 a javascript: URL throws at the data of an object, and at each value of an SVG animation", () => {
  assert.throws(
    () => h("object", { data: "javascript:alert(1)" }),
    /TypeError: data does not take a javascript: URL/,
  );
  const animations: [string, object][] = [
    ["set", { attributeName: "href", to: " javascript:alert(1)" }],
    ["animate", { attributeName: "href", FROM: "JavaScript:x" }],
    ["animate", { attributeName: "href", values: "/a; java\tscript:x" }],
  ];
  for (const [tag, props] of animations)
    assert.throws(() => h(tag, props), TypeError);
  const safe = h("animate", {
    attributeName: "x",
    values: "0;10;0",
    to: "/a;javascript:x",
  });
  assert.equal(safe.attributes.get("values"), "0;10;0");
  assert.equal(safe.attributes.get("to"), "/a;javascript:x"); // Only values is a list
  const movie = h("object", { data: "/movie.svg" });
  assert.equal(movie.attributes.get("data"), "/movie.svg");
});

test("JX-00A a rejected static prop throws before the element takes its children", () => {
  for (const props of [
    { href: "javascript:x" },
    { title: {} },
    { onclick: "x" },
  ]) {
    const child = el("b");
    assert.throws(() => h("a", { ...props, children: child }), TypeError);
    assert.equal(child.parentNode, null);
  }
});

test("JX-009 JX-065 a dynamic javascript: URL reports a TypeError, and keeps the attribute", async () => {
  reported.length = 0;
  const href = latest<string>(),
    link = h("a", { href });
  mount(el(), link);
  href.send("/a");
  await setImmediate();
  href.send("javascript:x");
  await setImmediate();
  assert.equal(link.attributes.get("href"), "/a");
  assert.ok(reported[0] instanceof TypeError);
  assert.equal(reported.length, 1);
  href.close();
});
