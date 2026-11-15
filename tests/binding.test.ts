import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { CHAN, Channel, changes, derive, select, watch } from "../src/index.ts";
import { Catch, each, type Item, jsx, mount } from "../src/jsx.ts";
import { fakeDocument, html } from "./dom.ts";

const el = (tag = "div") => fakeDocument.createElement(tag) as any;
const h = (type: any, props: any = {}) => jsx(type, props) as any;
// Other test files set reportError too, so a test sets its own, and gives back a restore.
const reported: unknown[] = [];
const reports = () => {
  const outer = (globalThis as any).reportError;
  reported.length = 0;
  (globalThis as any).reportError = (error: unknown) => reported.push(error);
  return () => {
    (globalThis as any).reportError = outer;
  };
};

// Counts the registrations of each kind, and the events of each kind, through the devtools hook.
const HOOK = Symbol.for("gg.devtools");
const counting = async (run: () => unknown) => {
  const counts: Record<string, number> = {};
  const count = (name: string) => {
    counts[name] = (counts[name] ?? 0) + 1;
  };
  (globalThis as any)[HOOK] = (kind: string) => {
    count(kind);
    return (event: string) => count(`${kind} ${event}`);
  };
  try {
    await run();
  } finally {
    delete (globalThis as any)[HOOK];
  }
  return counts;
};

test("HE-05A derives of one object slot share one reader", async () => {
  const s = select({ a: 1, b: 2 }, { autoStart: true });
  const seen: unknown[][] = [];
  const counts = await counting(async () => {
    const one = derive(s, "a", n => n * 10),
      two = derive(s, "a", n => -n);
    seen.push([(await one.next()).value, (await two.next()).value]);
    s.a = 2;
    seen.push([(await one.next()).value, (await two.next()).value]);
    await one.return();
    s.a = 3;
    seen.push([(await two.next()).value]);
    await two.return();
  });
  assert.deepEqual(seen, [[10, -1], [20, -2], [-3]]);
  assert.equal(counts.reader, 1);
  // After the last derive leaves, the next one opens a new reader.
  const again = await counting(async () => {
    const three = derive(s, "a", n => n);
    assert.equal((await three.next()).value, 3);
    await three.return();
  });
  assert.equal(again.reader, 1);
  s[CHAN].close();
});

test("HE-05A an array slot shares no reader, because a slot moves", async () => {
  const s = select([1, 2], { autoStart: true });
  const counts = await counting(async () => {
    const one = derive(s, 0, n => n),
      two = derive(s, 0, n => n);
    await Promise.all([one.next(), two.next()]);
    await Promise.all([one.return(), two.return()]);
  });
  assert.equal(counts.reader, 2);
  s[CHAN].close();
});

test("HE-05A a derive of a slot that leaves finishes, and a failure of the select reaches each derive", async () => {
  const s: any = select({ a: 1 }, { autoStart: true });
  const one = derive(s, "a", n => n),
    two = derive(s, "a", n => n);
  assert.equal((await one.next()).value, 1);
  assert.equal((await two.next()).value, 1);
  delete s.a;
  assert.equal((await one.next()).done, true);
  assert.equal((await two.next()).done, true);
  // A finished hub gives its end to a later derive of the same key.
  assert.equal((await derive(s, "a", n => n).next()).done, true);
  const error = new Error("fail");
  const t: any = select({ a: 1 }, { autoStart: true });
  const three = derive(t, "a", n => n),
    four = derive(t, "a", n => n);
  await Promise.all([three.next(), four.next()]);
  t[CHAN].throw(error);
  await assert.rejects(three.next(), e => e === error);
  await assert.rejects(four.next(), e => e === error);
});

test("HE-05A derives of one item share one channel reader", async () => {
  const items = select(["a"], { autoStart: true }),
    values: unknown[] = [];
  const counts = await counting(async () => {
    mount(
      el("ul"),
      each(items, (item: Item<string>) =>
        h("li", {
          title: derive(item, v => `t:${v}`),
          class: derive(item, v => `c:${v}`),
          children: derive(item, v => (values.push(v), v)),
        }),
      ),
    );
    await setImmediate();
  });
  assert.equal(counts["channel attach"], 1); // One consumer of the item channel
  assert.deepEqual(values, ["a"]);
  items[CHAN].close();
});

test("JX-067 a prop from a shared derive needs no drive, and follows its slot", async () => {
  const s = select({ a: "x" }, { autoStart: true }),
    parent = el();
  const counts = await counting(async () => {
    mount(
      parent,
      h("p", {
        title: derive(s, "a", v => `${v}!`),
        id: derive(s, "a", v => v),
      }),
    );
    await setImmediate();
  });
  assert.equal(html(parent), '<div><p title="x!" id="x"></p></div>');
  assert.equal(counts.reader, 1);
  assert.equal(counts.select ?? 0, 0);
  s.a = "y";
  await setImmediate();
  assert.equal(html(parent), '<div><p title="y!" id="y"></p></div>');
  s[CHAN].close();
});

test("JX-067 a parked binding maps nothing, and maps the newest value when it resumes", async () => {
  const s = select({ a: 1 }, { autoStart: true }),
    view = select({ show: true } as Record<string, unknown>, {
      autoStart: true,
    }),
    maps: unknown[] = [];
  const p = h("p", { title: derive(s, "a", v => (maps.push(v), `${v}`)) }),
    parent = el();
  mount(
    parent,
    derive(view, "show", on => (on ? p : null)),
  );
  await setImmediate();
  assert.deepEqual(maps, [1]);
  view.show = false;
  await setImmediate();
  s.a = 2;
  await setImmediate();
  s.a = 3;
  await setImmediate();
  assert.deepEqual(maps, [1]);
  view.show = true;
  await setImmediate();
  assert.deepEqual(maps, [1, 3]);
  assert.equal(html(p), `<p title="3"></p>`);
  s[CHAN].close();
  view[CHAN].close();
});

test("JX-067 a stop ends the binding and returns the shared reader", async () => {
  const s = select({ a: 1 }, { autoStart: true }),
    parent = el(),
    maps: unknown[] = [];
  const unmount = mount(
    parent,
    h("p", { title: derive(s, "a", v => (maps.push(v), v)) }),
  );
  await setImmediate();
  unmount();
  s.a = 2;
  await setImmediate();
  assert.deepEqual(maps, [1]);
  s[CHAN].close();
});

test("JX-067 a later async output wins, and a map failure goes to the boundary", async () => {
  const s = select({ a: 1 }, { autoStart: true }),
    gates = [Promise.withResolvers<string>(), Promise.withResolvers<string>()],
    parent = el();
  let n = 0;
  const p = h("p", { title: derive(s, "a", () => gates[n++].promise) });
  mount(parent, p);
  await setImmediate();
  s.a = 2;
  await setImmediate();
  gates[1].resolve("second");
  await setImmediate();
  gates[0].resolve("first");
  await setImmediate();
  assert.equal(html(p), `<p title="second"></p>`);
  s[CHAN].close();

  const t = select({ a: 1 }, { autoStart: true }),
    error = new Error("map"),
    shown = el();
  mount(
    shown,
    h(Catch, {
      fallback: (e: Error) => `caught ${e.message}`,
      children: h("div", {
        children: h("p", {
          title: derive(t, "a", v => {
            if (v === 2) throw error;
            return v;
          }),
          // The boundary stops this binding before the hub gives it the value.
          id: derive(t, "a", v => v),
        }),
      }),
    }),
  );
  await setImmediate();
  t.a = 2;
  await setImmediate();
  assert.equal(html(shown), "<div><div>caught map</div></div>");
  t.a = 3;
  await setImmediate();
  t[CHAN].close();
});

test("JX-066 JX-067 a binding whose slot leaves keeps its last value, and its scope tidies", async () => {
  const s: any = select({ a: 1 }, { autoStart: true }),
    parent = el();
  mount(parent, h("p", { title: derive(s, "a", v => v) }));
  await setImmediate();
  delete s.a;
  await setImmediate();
  assert.equal(html(parent), '<div><p title="1"></p></div>');
  s[CHAN].close();
});

test("HE-05A HE-055 a return during a pending next of a shared derive ends it at once", async () => {
  const s = select({ a: 1 }, { autoStart: true });
  const one = derive(s, "a", n => n);
  await one.next();
  const pending = one.next();
  await setImmediate(); // So the read waits for a change
  await one.return();
  assert.deepEqual(await pending, { done: true, value: undefined });
  s[CHAN].close();
});

test("JX-067 DV-061 a binding tells devtools its start and values, and a failure of its select reaches the boundary", async () => {
  const s = select({ a: 1 }, { autoStart: true }),
    events: unknown[] = [],
    parent = el();
  (globalThis as any)[HOOK] = (kind: string) =>
    kind === "derive" ? (event: string) => events.push(event) : undefined;
  try {
    mount(parent, h("p", { title: derive(s, "a", v => v) }));
    await setImmediate();
  } finally {
    delete (globalThis as any)[HOOK];
  }
  assert.deepEqual(events, ["start", "value"]);
  const error = new Error("select");
  const restore = reports();
  s[CHAN].throw(error);
  await setImmediate();
  assert.deepEqual(reported, [error]);
  assert.deepEqual(events, ["start", "value", "end"]);
  restore();
});

test("JX-067 a map failure that a later value overtook is discarded, and results after a failure are ignored", async () => {
  const s = select({ a: 1 }, { autoStart: true }),
    first = Promise.withResolvers<string>(),
    error = new Error("late"),
    parent = el();
  const restore = reports();
  const p = h("p", {
    title: derive(s, "a", v => (v === 1 ? first.promise : `${v}`)),
  });
  mount(parent, p);
  await setImmediate();
  s.a = 2;
  await setImmediate();
  first.reject(error);
  await setImmediate();
  assert.equal(html(p), `<p title="2"></p>`);
  assert.deepEqual(reported, []);
  const t = select({ a: 1 }, { autoStart: true }),
    fail = new Error("map"),
    maps: unknown[] = [];
  mount(
    el(),
    h("p", {
      title: derive(t, "a", v => {
        maps.push(v);
        if (v === 2) throw fail;
        return v;
      }),
      id: derive(t, "a", v => v),
    }),
  );
  await setImmediate();
  t.a = 2;
  await setImmediate();
  t.a = 3;
  await setImmediate();
  assert.deepEqual(maps, [1, 2]);
  assert.deepEqual(reported, [fail]);
  s[CHAN].close();
  t[CHAN].close();
  restore();
});

test("JX-041 a stop returns the consumers, readers and watches that a component opened in a pull", async () => {
  const ch = new Channel<number>(),
    s = select({ a: 1 }, { autoStart: true }),
    log: string[] = [];
  async function* Reads() {
    const p = el("p");
    yield p;
    // Each read opens after a plain yield, so it runs in the pull of the host.
    void (async () => {
      for await (const _ of changes(s));
      log.push("reader");
    })();
    void (async () => {
      for await (const _ of watch(s, "a"));
      log.push("watch");
    })();
    try {
      for await (const _ of ch);
    } finally {
      log.push("channel");
    }
  }
  const unmount = mount(el(), h(Reads));
  await setImmediate();
  unmount();
  await setImmediate();
  assert.deepEqual(log.sort(), ["channel", "reader", "watch"]);
  s[CHAN].close();
});

test("JX-041 a read that opens after an await is not bound, and a plain yield before it binds it", async () => {
  const ch = new Channel<number>(),
    log: string[] = [];
  async function* Late({ again }: { again: boolean }) {
    const p = el("p");
    yield p;
    await null;
    if (again) yield p; // The same node wakes the host, and the code after it runs in a pull
    try {
      for await (const _ of ch);
    } finally {
      log.push(again ? "bound" : "unbound");
    }
  }
  const unmount = mount(
    el(),
    h(Late, { again: false }),
    h(Late, { again: true }),
  );
  await setImmediate();
  unmount();
  await setImmediate();
  assert.deepEqual(log, ["bound"]);
  ch.close();
  await setImmediate();
  assert.deepEqual(log, ["bound", "unbound"]);
});

test("JX-041 a row that leaves each returns what its component opened", async () => {
  const ch = new Channel<number>(),
    items = select(["a"], { autoStart: true }),
    log: string[] = [];
  async function* Row() {
    yield el("li");
    try {
      for await (const _ of ch);
    } finally {
      log.push("end");
    }
  }
  mount(
    el("ul"),
    each(items, () => h(Row)),
  );
  await setImmediate();
  items.pop();
  await setImmediate();
  assert.deepEqual(log, ["end"]);
  items[CHAN].close();
});

test("HE-05A a derive that returns before its first value returns the shared reader", async () => {
  const s = select({ a: 1 }, { autoStart: true });
  const one = derive(s, "a", n => n);
  const first = one.next();
  await one.return();
  assert.deepEqual(await first, { done: true, value: undefined });
  const counts = await counting(async () => {
    const two = derive(s, "a", n => n);
    assert.equal((await two.next()).value, 1);
    await two.return();
  });
  assert.equal(counts.reader, 1);
  s[CHAN].close();
});

test("JX-061 JX-067 a derive with no shared reader in a prop gets a drive", async () => {
  const ch = new Channel<string>({
      firstReceive: "latest",
      thenReceive: "latest",
    }),
    parent = el();
  ch.send("x");
  const counts = await counting(async () => {
    mount(parent, h("p", { title: derive(ch, v => `${v}!`) }));
    await setImmediate();
  });
  assert.equal(html(parent), '<div><p title="x!"></p></div>');
  assert.equal(counts.select, 1);
  ch.close();
});

test("JX-067 DV-062 a binding ends once, at a failure of its map, at the end of its slot, or at a stop", async () => {
  const ends = (events: string[]) => events.filter(e => e === "end").length;
  const watching = (events: string[]) => {
    (globalThis as any)[HOOK] = (kind: string) =>
      kind === "derive" ? (event: string) => events.push(event) : undefined;
  };
  const s: any = select({ a: 1, b: 1 }, { autoStart: true }),
    failing: string[] = [],
    leaving: string[] = [],
    restore = reports();
  try {
    watching(failing);
    const off = mount(
      el(),
      h("p", {
        title: derive(s, "a", v => {
          if (v === 2) throw new Error("map");
          return v;
        }),
      }),
    );
    watching(leaving);
    const unmount = mount(el(), h("p", { title: derive(s, "b", v => v) }));
    await setImmediate();
    s.a = 2;
    delete s.b;
    await setImmediate();
    assert.equal(ends(failing), 1); // The failure ends the binding at once
    assert.equal(ends(leaving), 1); // So does the end of its slot
    unmount();
    off();
    assert.equal(ends(failing), 1);
    assert.equal(ends(leaving), 1);
    assert.equal(reported.length, 1);
  } finally {
    delete (globalThis as any)[HOOK];
    restore();
  }
  // After a map failure, the binding leaves the shared reader, so a new derive opens a new one.
  s.a = 3;
  const afterFailure = await counting(async () => {
    const again = derive(s, "a", v => v);
    assert.equal((await again.next()).value, 3);
    await again.return();
  });
  assert.equal(afterFailure.reader, 1);
  // After a stop, a new derive of the key opens a new reader.
  const t = select({ a: 1 }, { autoStart: true });
  const unmount = mount(el(), h("p", { title: derive(t, "a", v => v) }));
  await setImmediate();
  unmount();
  const counts = await counting(async () => {
    const again = derive(t, "a", v => v);
    await again.next();
    await again.return();
  });
  assert.equal(counts.reader, 1);
  s[CHAN].close();
  t[CHAN].close();
});

test("JX-067 JX-092 a failure of a select reaches its boundary once, for all its bindings", async () => {
  const s = select({ a: 1 }, { autoStart: true }),
    shown = el(),
    restore = reports();
  mount(
    shown,
    h(Catch, {
      fallback: (e: Error) => `caught ${e.message}`,
      children: h("div", {
        children: h("p", {
          title: derive(s, "a", v => v),
          id: derive(s, "a", v => v),
        }),
      }),
    }),
  );
  await setImmediate();
  s[CHAN].throw(new Error("select"));
  await setImmediate();
  assert.equal(html(shown), "<div><div>caught select</div></div>");
  assert.deepEqual(reported, []);
  restore();
});

test("JX-067 a binding that resumes with no new value maps nothing", async () => {
  const s = select({ a: 1 }, { autoStart: true }),
    view = select({ show: true } as Record<string, unknown>, {
      autoStart: true,
    }),
    maps: unknown[] = [];
  const p = h("p", { title: derive(s, "a", v => (maps.push(v), `${v}`)) }),
    restore = reports();
  mount(
    el(),
    derive(view, "show", on => (on ? p : null)),
  );
  await setImmediate();
  view.show = false;
  await setImmediate();
  view.show = true;
  await setImmediate();
  assert.deepEqual(maps, [1]);
  assert.deepEqual(reported, []);
  restore();
  s[CHAN].close();
  view[CHAN].close();
});

test("JX-041 a component that finishes returns the reads that it left open", async () => {
  const s = select({ a: 1 }, { autoStart: true }),
    log: string[] = [];
  async function* Once() {
    yield el("p");
    void (async () => {
      for await (const _ of changes(s));
      log.push("reader");
    })();
  }
  mount(el(), h(Once));
  await setImmediate();
  await setImmediate();
  assert.deepEqual(log, ["reader"]);
  s[CHAN].close();
});
