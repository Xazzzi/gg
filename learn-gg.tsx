/// # Learn gg in Y minutes
///
/// `gg` gives you three primitives and a JSX runtime.
/// `Channel` moves values, `feed` fills channels, and `select` turns many sources into one state.
/// The JSX runtime builds DOM nodes, and components change their own nodes.
///
/// The block below is one ES module.
/// It runs top to bottom, and each `// =>` comment shows what the line prints.
/// Each section sits in its own `{ }` scope, so names can repeat.
/// Each part shows the defaults first, and then the options that change them.
/// Run it with `npm run learn`, which bundles it with esbuild, because Node does not run JSX.
/// The rules behind all of this live in [`spec/`](spec/).
import { styleText } from "node:util";
import {
  abortable,
  applyOps,
  CHAN,
  Channel,
  catching,
  changes,
  createContext,
  derive,
  each,
  feed,
  iff,
  isVal,
  latest,
  mount,
  type Op,
  Provide,
  StopError,
  select,
  spread,
  use,
  watch,
} from "@xazzzi/gg";
// Node has no DOM, so the JSX part uses the small fake DOM of the tests.
import { html } from "./tests/dom.ts";

const topic = (title: string, prefix = "\n") =>
  console.log(styleText(["bold", "cyan"], prefix + title));
const tick = () => new Promise(resolve => setImmediate(resolve));

/// ## Channel

topic("Channel: send, then read with for await");
{
  // A log of values. By default, each consumer reads every value.
  const ch = new Channel<number>();

  ch.send(1); // Synchronous, never blocks, and runs no consumer code
  ch.send(2);
  ch.close(); // Values already sent can still be read

  for await (const n of ch) console.log(n); // => 1, then 2
}

topic("Backpressure with asend");
{
  const ch = new Channel<number>();

  // asend appends like send, and resolves when a consumer reads the value.
  // With no consumer it stays pending, so await here would wait forever.
  const sent = ch.asend(1);

  await ch[Symbol.asyncIterator]().next();
  await sent; // Resolves at the read, not when the consumer finishes its work
  console.log("read"); // => read
}

topic("Producers unlock in send order");
{
  const ch = new Channel<string>();

  // Each producer sends its next value only after a consumer reads the last one.
  const a = (async () => {
    console.log("sending a1");
    await ch.asend("a1");
    console.log("a1 read, sending a2");
    await ch.asend("a2");
    console.log("a2 read, a done");
  })();
  const b = (async () => {
    console.log("sending b1");
    await ch.asend("b1");
    console.log("b1 read, sending b2");
    await ch.asend("b2");
    console.log("b2 read, b done");
  })();

  // Nothing has been read, so both producers wait with a1 and b1 in the log.
  const it = ch[Symbol.asyncIterator]();
  for (let i = 0; i < 4; i++) {
    console.log("got", (await it.next()).value);
  }
  await Promise.all([a, b]);
  // The read settles the ack first, so each producer logs before the consumer.
  // => a1 read, sending a2 / got a1
  // => b1 read, sending b2 / got b1
  // => a2 read, a done / got a2
  // => b2 read, b done / got b2
}

topic("Ending a channel");
topic("close", "- ");
{
  // close(value) becomes the consumer's return value.
  const ch = new Channel<number, string>();
  ch.close("bye");
  console.log(await ch[Symbol.asyncIterator]().next());
  // => { value: 'bye', done: true }

  console.log(ch.signal.aborted); // => true, signal aborts synchronously
  ch.close("ignored"); // The first close or throw wins
}
topic("throw", "- ");
{
  // throw fails consumers. Producers get a StopError that wraps the reason.
  const ch = new Channel<number>();
  const failure = new Error("upstream");
  ch.throw(failure);

  try {
    await ch[Symbol.asyncIterator]().next();
  } catch (error) {
    console.log(error === failure); // => true, unchanged
  }

  try {
    ch.send(1);
  } catch (error) {
    console.log(error instanceof StopError); // => true
    console.log((error as StopError).reason === failure); // => true
  }
}
topic("using", "- ");
{
  // `using` closes the channel at the end of the scope.
  // Node 24 runs it natively, and Node 22 needs a transpiler or `ch[Symbol.dispose]()`.
  using ch = new Channel<number>();
  ch.send(1);
}
topic("break", "- ");
{
  // break detaches one consumer, and the channel stays open.
  const ch = new Channel<number>();
  ch.send(1);
  for await (const _ of ch) break;
  console.log(ch.signal.aborted); // => false
}

topic("Channels refuse thenables");
{
  const ch = new Channel<unknown>();
  try {
    ch.send(Promise.resolve(1));
  } catch (error) {
    console.log((error as Error).name); // => TypeError
  }
  // Await the promise first, or let feed do it.
}

topic("Channel options");
// firstReceive picks a consumer's first value, and "unread" is the default.
// thenReceive picks every value after that, and "every" is the default.
//
//   firstReceive | every               | latest          | unread
//   -------------+---------------------+-----------------+-----------
//   first        | replay everything   | 1, then newest  | invalid
//   unread       | head, then all      | head, newest    | work queue
//   latest       | newest, then all    | newest, newest  | invalid
//   next         | future values only  | next, newest    | invalid
//
// "unread" as thenReceive needs "unread" as firstReceive.
// Any other pairing could hand one value to two consumers.
topic('"latest" skips: head first, then newest', "- ");
{
  const ch = new Channel<number>({ thenReceive: "latest" });

  ch.send(1);
  ch.send(2);
  ch.send(3);

  const it = ch[Symbol.asyncIterator]();
  console.log((await it.next()).value); // => 1, the oldest unread value
  console.log((await it.next()).value); // => 3, 2 was skipped
}
topic("Broadcast", "- ");
{
  // A late consumer replays the whole log.
  const log = new Channel<string>({ firstReceive: "first" });
  log.send("a");
  log.send("b");
  log.close();
  for await (const line of log) console.log(line); // => a, then b
  for await (const line of log) console.log(line); // => a, then b
}
topic("Work queue", "- ");
{
  // Each value reaches exactly one consumer.
  const jobs = new Channel<number>({ thenReceive: "unread" });
  const a = jobs[Symbol.asyncIterator]();
  const b = jobs[Symbol.asyncIterator]();
  jobs.send(1);
  jobs.send(2);
  console.log((await a.next()).value); // => 1
  console.log((await b.next()).value); // => 2
}
topic("Latest holder", "- ");
{
  // A new consumer sees the current value at once.
  const price = latest<number>();
  price.send(100);
  price.send(101);
  console.log((await price[Symbol.asyncIterator]().next()).value); // => 101
}
topic("stopStyle", "- ");
{
  // "drain", the default, lets consumers finish. "stop" drops what is unread.
  const ch = new Channel<number>({ stopStyle: "stop" });
  ch.send(1);
  ch.close();
  console.log((await ch[Symbol.asyncIterator]().next()).done); // => true
}
topic("ackStyle", "- ");
{
  // "any", the default, settles asend at the first read.
  // "all" waits for every consumer, so a slow consumer slows the producer.
  const ch = new Channel<number>({ firstReceive: "first", ackStyle: "all" });
  const fast = ch[Symbol.asyncIterator]();
  const slow = ch[Symbol.asyncIterator]();
  ch.send(0);
  await fast.next(); // A consumer attaches at its first next()
  await slow.next();
  let acked = false;
  const sent = ch.asend(1).then(() => (acked = true));
  await fast.next();
  await tick();
  console.log(acked); // => false, slow has not read 1
  await slow.next();
  await sent;
  console.log(acked); // => true
}

/// ## feed

topic("feed: move a source into a channel");
{
  // A source is a promise or any iterator, sync or async.
  async function* numbers() {
    yield 1;
    yield 2;
  }

  const ch = new Channel<number>();
  // By default, feed waits for a consumer, then waits for each read.
  feed(numbers(), ch);

  // The channel closes once the last source finishes.
  for await (const n of ch) console.log(n); // => 1, then 2
}
topic("Merging feeds", "- ");
{
  // Several feeds merge. One run keeps its order, but runs interleave.
  const ch = new Channel<string>();
  feed(["a"], ch);
  feed(Promise.resolve("b"), ch);

  const out: string[] = [];
  for await (const value of ch) out.push(value);
  console.log(out.sort()); // => [ 'a', 'b' ]
}
topic("Source failures", "- ");
{
  // feed never rejects. A source failure fails the channel instead.
  const ch = new Channel<number>();
  await feed(Promise.reject(new Error("nope")), ch, { autoStart: true });

  try {
    for await (const _ of ch);
  } catch (error) {
    console.log((error as Error).message); // => nope
  }
}
topic("feed options", "- ");
{
  // autoStart runs with no consumer, and backPressure: false skips the wait.
  // sendReturn also sends a generator's return value.
  // autoClose: false keeps the channel open after the last source.
  function* steps() {
    yield 1;
    return 2;
  }

  const ch = new Channel<number>();
  await feed(steps(), ch, {
    autoStart: true,
    backPressure: false,
    sendReturn: true,
  });

  for await (const n of ch) console.log(n); // => 1, then 2
}

/// ## select

topic("select: one state from many sources");
{
  const user = Promise.withResolvers<string>();
  // By default, a select starts at its first consumer, and stays open until you close it.
  using state = select({ title: "Home", user: user.promise });
  const it = state[Symbol.asyncIterator]();

  // Plain values stay as they are. Sources become a Val.
  const first = (await it.next()).value;
  console.log(first.title, first.user.status); // => Home pending

  user.resolve("Ada");
  const second = (await it.next()).value;
  console.log(second.user.status, second.user.value); // => fulfilled Ada
  // `using` closes the select here, like state[CHAN].close().
}

topic("The shape stays mutable");
{
  using state = select({ a: 1 } as Record<string, unknown>);
  const it = state[Symbol.asyncIterator]();
  await it.next();

  state.b = Promise.resolve(2); // Adds a slot
  state.a = 10; // Replaces a source
  delete state.b; // Removes a slot, and never closes the removed source

  console.log((await it.next()).value); // => { a: 10 }

  // Reads return the source you assigned, not its state.
  console.log(state.a); // => 10
  console.log(state[CHAN] instanceof Channel); // => true, CHAN reaches the channel
}

topic("unwrap gives plain values, and a rejection fails the channel");
topic("unwrap", "- ");
{
  const user = Promise.withResolvers<string>();
  using state = select({ user: user.promise }, { unwrap: true });
  const it = state[Symbol.asyncIterator]();
  console.log((await it.next()).value); // => { user: undefined }, a pending slot
  user.resolve("Ada");
  console.log((await it.next()).value); // => { user: 'Ada' }
}
topic("Rejections", "- ");
{
  const state = select(
    { user: Promise.reject(new Error("down")) },
    { unwrap: true },
  );
  try {
    for await (const _ of state);
  } catch (error) {
    console.log((error as Error).message); // => down
  }
}

topic("select options");
topic("autoClose: true joins sources", "- ");
{
  // The select closes when no source can change a slot, so for await ends.
  const state = select(
    { a: Promise.resolve(1), b: Promise.resolve(2) },
    { autoClose: true, unwrap: true },
  );
  for await (const snapshot of state) console.log(snapshot); // => { a: 1, b: 2 }
  console.log("ended"); // => ended
}
topic("One Channel in two slots", "- ");
{
  // A Channel opens one reader per slot, so both slots read every value.
  const ch = new Channel<number>({ firstReceive: "first" });
  feed([1, 2], ch);
  for await (const vals of select([ch, ch], { autoClose: true, unwrap: true }))
    console.log(vals);
  // => [undefined, undefined]
  // => [1, 1]
  // => [2, 2]
}
topic("Sync iterators advance once per flush", "- ");
{
  function* ids() {
    yield 1;
    yield 2;
  }

  // A sync iterator never keeps the channel open, and nothing pulls it again.
  // Wrap it in catching to make it async if it must run to the end.
  for await (const snapshot of select({ id: ids() }, { autoClose: true }))
    console.log(snapshot.id.value); // => 1
}
topic("Arrays and the operation log");
topic("changes reads operations at any time", "- ");
{
  // A reader gives the outputs now, and each read takes all operations since the last one.
  // So a busy reader skips states between its reads.
  using todos = select(["a"]);
  using reader = changes(todos);
  console.log(reader.outputs); // => [], because the select starts at the first read

  console.log((await reader.next()).value);
  // => [ { op: 'splice', start: 0, removed: [], added: [ 'a' ] } ], the start describes the shape

  // With backPressure, each flush waits for a read, of a reader or of a consumer.
  todos.push("b");
  todos[0] = "A";
  console.log((await reader.next()).value);
  // => [
  //   { op: 'splice', start: 1, removed: [], added: [ 'b' ] },
  //   { op: 'set', key: 0, value: 'A', prev: 'a' }
  // ]
}
topic("watch reads one slot", "- ");
{
  // watch gives the output of one slot, then each new output of it.
  using form = select({ name: "Ann", age: 1 });
  using name = watch(form, "name");
  console.log((await name.next()).value); // => Ann

  form.age = 2; // Wakes no reader of name
  form.name = "Ada";
  console.log((await name.next()).value); // => Ada
}
topic("Operations", "- ");
{
  // Operations are ordered, so a UI can replay them without diffing.
  // nonYielding builds no snapshots, for a select that only readers read.
  using rows = select(["a"], { nonYielding: true });
  using reader = changes(rows);
  const read = async () => (await reader.next()).value ?? [];
  const seen: Op[] = await read();

  rows.push("b");
  rows.shift();
  seen.push(...(await read()));

  for (const op of seen) console.log(op);
  // => { op: 'splice', start: 0, removed: [], added: [ 'a' ] }
  // => { op: 'splice', start: 1, removed: [], added: [ 'b' ] }
  // => { op: 'splice', start: 0, removed: [ 'a' ], added: [] }

  // sort and reverse move slots without restarting sources.
  rows.push("a");
  rows.sort();
  console.log((await read()).at(-1)); // => { op: 'move', order: [ 1, 0 ] }

  // fill and copyWithin replace a range with one splice.
  rows.fill("z");
  console.log((await read()).at(-1));
  // => { op: 'splice', start: 0, removed: [ 'a', 'b' ], added: [ 'z', 'z' ] }
}
topic("sort comparators", "- ");
{
  // sort compares sources, like every proxy method.
  // sortOutputs compares outputs, so unwrap passes values and pending slots go last.
  using scores = select([Promise.resolve(2), 3, 1], {
    unwrap: true,
    autoStart: true,
    nonYielding: true,
  });
  await tick();

  scores.sortOutputs((a, b) => b - a);
  console.log(scores[0], scores[2]); // => 3 1
}

/// ## Helpers

topic("Helpers");
topic("spread", "- ");
{
  // spread flattens each Val into fields, usually as mapSnapshot.
  const state = select(
    { user: Promise.resolve("Ada") },
    { autoClose: true, mapSnapshot: spread },
  );
  for await (const view of state)
    console.log(view.user, view.userLoading, view.userError, view.userDone);
  // => Ada false null true, the promise settled before the first snapshot
}
topic("isVal", "- ");
{
  // isVal tells a Val from a lookalike.
  using state = select({ a: Promise.resolve(1) });
  const snapshot = (await state[Symbol.asyncIterator]().next()).value;
  console.log(isVal(snapshot.a), isVal({ status: "pending" })); // => true false
}
topic("derive", "- ");
{
  // derive maps each value of an async iterable, such as a select.
  // derive(state, key, map) maps one key of a select, so map runs only when that key changes.
  const count = latest<number>();
  const labels = derive(count, n => `${n} items`);
  count.send(3);
  console.log((await labels.next()).value); // => 3 items
}
topic("catching", "- ");
{
  // catching ends a source quietly. onError is required, so it is explicit.
  async function* flaky() {
    yield 1;
    throw new Error("flaky");
  }

  const safe = catching(flaky(), error =>
    console.log("logged:", (error as Error).message),
  );
  for await (const n of safe) console.log(n);
  // => 1, then logged: flaky
}
topic("abortable", "- ");
{
  // abortable stops waiting on a signal. It does not cancel the work.
  const control = new AbortController();
  const waiting = abortable(new Promise(() => {}), control.signal);
  control.abort(new Error("gave up"));

  try {
    await waiting;
  } catch (error) {
    console.log((error as Error).message); // => gave up
  }
}
topic("applyOps", "- ");
{
  // applyOps replays ops onto a mirror, and map derives each entry.
  // prev is the entry being replaced, so it can be reused.
  const labels: string[] = [];
  using rows = select(["a"], { nonYielding: true });
  using reader = changes(rows);
  const replay = async () =>
    applyOps(
      labels,
      (await reader.next()).value ?? [],
      (value, prev) => `${value} (was ${prev})`,
    );
  await replay();

  rows[0] = "b";
  rows.push("c");
  await replay();
  console.log(labels); // => [ 'b (was a (was undefined))', 'c (was undefined)' ]
}
{
  // One report folds first, so map runs only for entries that land.
  // Pass { eager: true } to map every step, which here would also map a and b.
  const calls: unknown[] = [];
  const ops: Op[] = [
    { op: "splice", start: 0, removed: [], added: ["a", "b"] },
    { op: "set", key: 0, value: "c", prev: "a" },
    { op: "splice", start: 1, removed: ["b"], added: [] },
  ];
  const list = applyOps(
    [] as string[],
    ops,
    value => (calls.push(value), String(value)),
  );
  console.log(list, calls); // => [ 'c' ] [ 'c' ]
}

/// ## JSX
///
/// Set `"jsx": "react-jsx"` and `"jsxImportSource": "@xazzzi/gg"` in tsconfig.json.

topic("JSX builds real nodes");
{
  // There is no virtual DOM, so a JSX expression is the element itself.
  const note = (
    <p class="note" hidden={false}>
      Hi {"there"}
    </p>
  );
  console.log(html(note)); // => <p class="note">Hi there</p>
}

topic("mount, and live children");
{
  // A promise or an async iterable is a live child, so a channel of strings is live text.
  const parent = document.createElement("div");
  const name = latest<string>();
  const unmount = mount(parent, <b>Hi </b>, name, Promise.resolve("!"));
  console.log(html(parent)); // => <div><b>Hi </b></div>, static nodes land at once

  name.send("Ada");
  await tick();
  console.log(html(parent)); // => <div><b>Hi </b>Ada!</div>

  name.send("Bob"); // Changes the data of one Text node
  await tick();
  console.log(html(parent)); // => <div><b>Hi </b>Bob!</div>

  unmount(); // Stops the live children, and empties the parent
  console.log(html(parent)); // => <div></div>
}

topic("Dynamic props");
{
  // A promise or an async iterable prop sets its attribute with each value.
  // derive computes a prop from a source.
  const parent = document.createElement("div");
  const count = latest<number>();
  mount(
    parent,
    <button
      type="button"
      title={derive(count, n => `${n} clicks`)}
      disabled={derive(count, n => n > 2)}
    >
      Go
    </button>,
  );
  count.send(1);
  await tick();
  console.log(html(parent)); // => <div><button type="button" title="1 clicks">Go</button></div>

  count.send(3); // false removes the attribute, and true sets it to ""
  await tick();
  console.log(html(parent));
  // => <div><button type="button" title="3 clicks" disabled="">Go</button></div>
}

topic("Components");
topic("A function component", "- ");
{
  // A plain function runs once, and returns its nodes.
  const Title = ({ text }: { text: string }) => <h1>{text}</h1>;
  console.log(html(<Title text="gg" />)); // => <h1>gg</h1>
}
topic("An async generator component", "- ");
{
  // Each use gives one instance, which yields its node and then changes the nodes it owns.
  async function* Meter({ level }: { level: Channel<number> }) {
    const bar = (<div class="bar" />) as HTMLElement;
    yield bar;
    for await (const n of level) bar.setAttribute("style", `width: ${n}%`);
  }

  const parent = document.createElement("div");
  const level = latest<number>();
  mount(parent, <Meter level={level} />);
  level.send(40);
  await tick();
  console.log(html(parent)); // => <div><div class="bar" style="width: 40%"></div></div>
  level.close(); // Ends the instance, which keeps its last nodes
}
topic("Yield again to replace the node", "- ");
{
  async function* Status({ online }: { online: Channel<boolean> }) {
    for await (const on of online) yield on ? <b>online</b> : <i>offline</i>;
  }

  const parent = document.createElement("div");
  const online = latest<boolean>();
  mount(parent, <Status online={online} />);
  online.send(true);
  await tick();
  console.log(html(parent)); // => <div><b>online</b></div>
  online.send(false);
  await tick();
  console.log(html(parent)); // => <div><i>offline</i></div>
  online.close();
}

topic("each renders a list from a select");
{
  // each replays the changes of an array select onto rows, so the list never diffs.
  // Each row gets an Item, which is an async iterable of its values, so it is a live child too.
  using names = select(["ann", "bob"]);
  const parent = document.createElement("div");
  mount(
    parent,
    <ul>
      {each(names, name => (
        <li>{name}</li>
      ))}
    </ul>,
  );
  await tick();
  console.log(html(parent)); // => <div><ul><li>ann</li><li>bob</li></ul></div>

  const ul = parent.firstChild as Element;
  const ann = ul.childNodes[0];
  names[0] = "Ann"; // A set changes the text of the row, and keeps its node
  names.push("cy");
  await tick();
  names.reverse(); // A move moves nodes, and restarts nothing
  await tick();
  console.log(html(ul)); // => <ul><li>cy</li><li>bob</li><li>Ann</li></ul>
  console.log(ul.childNodes[2] === ann); // => true, the same node
}

topic("iff shows one of two views");
{
  // iff gives then while its source is truthy, and otherwise while it is not.
  // A function branch builds a new view at each change, and iff stops the view before it.
  const parent = document.createElement("div");
  const open = latest<boolean>();
  const time = latest<string>();
  time.send("12:00");
  mount(
    parent,
    iff(open, () => <b>{time}</b>, "closed"),
  );
  open.send(false);
  await tick();
  console.log(html(parent)); // => <div>closed</div>
  open.send(true);
  await tick();
  console.log(html(parent)); // => <div><b>12:00</b></div>
}

topic("Scopes: a view out of the tree parks");
{
  // Each started element belongs to the mount or the each row above it, and stops with it.
  // An element that leaves the tree pulls nothing until it comes back, so a component can keep views.
  const parent = document.createElement("div");
  const view = latest<Node | string>();
  const count = latest<number>();
  count.send(1);
  const kept = (<p>{count}</p>) as Node;
  const unmount = mount(parent, view);
  view.send(kept);
  await tick();
  view.send("away");
  await tick();
  count.send(2); // The pull that was pending takes 2
  count.send(3);
  await tick();
  console.log(html(kept)); // => <p>2</p>, parked
  view.send(kept);
  await tick();
  console.log(html(parent)); // => <div><p>3</p></div>
  unmount(); // Stops kept too, because it started under this mount
}

topic("Parts: live children inside an output");
{
  // An output can hold live children, so a component can yield another component.
  async function* Greeting({ name }: { name: Channel<string> }) {
    yield ["Hi ", name, "!"];
  }
  const parent = document.createElement("div");
  const name = latest<string>();
  mount(parent, <Greeting name={name} />);
  name.send("Ada");
  await tick();
  console.log(html(parent)); // => <div>Hi Ada!</div>
}

topic("Context");
{
  // Provide gives a value to the components inside it.
  // A component asks with yield* use, which waits until the runtime places it.
  const Theme = createContext<string>("theme");
  async function* Badge() {
    const theme = yield* use(Theme);
    yield <span class={theme}>gg</span>;
  }

  const parent = document.createElement("div");
  mount(
    parent,
    <Provide context={Theme} value="dark">
      <section>
        <Badge />
      </section>
    </Provide>,
  );
  await tick();
  console.log(html(parent)); // => <div><section><span class="dark">gg</span></section></div>
}

// # Traps
// ## Channel and feed
// asend with no consumer stays pending until the channel ends.
// A next() left pending on a work queue still takes a value, which is then lost.
// An attached consumer that is dropped without return() keeps its backlog alive.
// An always-ready source with backPressure: false starves the event loop.
// Under stopStyle: "stop", send(1) then close() in one run always drops 1.
// ## select
// A select stays open by default, so close it with `using` or state[CHAN].close().
// break does not stop select, because it detaches only one consumer.
// With backPressure, a flush waits until a consumer reads, or a reader reads or waits.
// Under ackStyle: "all", only snapshot consumers release a flush, so readers alone stall it.
// With autoClose: true, a shape of plain values closes after its first flush.
// After the close, writes change the proxy with no tracking and no error.
// select tracks the top level only, so `state.items[0].done = true` changes nothing.
// An index write replaces the source, so an iterator in that slot restarts.
// sortOutputs is a one-off, so later updates do not move slots.
// A comparator that changes the shape gets a TypeError.
// sortOutputs throws on a terminal channel, where writes are no longer tracked.
// One iterator in two slots shares a cursor, so each value reaches one slot.
// fill and copyWithin can do this silently, and leave overwritten iterators open.
// ## JSX
// The runtime owns the children of a host, so a place removes nodes that other code adds.
// An element that other code appends, for example with append, does not start.
// Removing a node does not end its component, so close the channels it reads.
// A component that waits on an open channel ends only when it closes, or at its next yield.
// Code after an await in a component runs outside the host pull.
// A dynamic prop at an on* key throws, because an event attribute runs its value as code.
