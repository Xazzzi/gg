/// # Learn gg in Y minutes
///
/// `gg` gives you three primitives.
/// `Channel` moves values, `feed` fills channels, and `select` turns many sources into one state.
///
/// The block below is one ES module.
/// It runs top to bottom, and each `// =>` comment shows what the line prints.
/// Each section sits in its own `{ }` scope, so names can repeat.
/// The rules behind all of this live in [`spec/`](spec/).
import { styleText } from "node:util";
import {
  abortable,
  applyOps,
  CHAN,
  Channel,
  catching,
  feed,
  isVal,
  type Op,
  StopError,
  select,
  spread,
} from "@xazzzi/gg";

const topic = (title: string, prefix = "\n") =>
  console.log(styleText(["bold", "cyan"], prefix + title));
const tick = () => new Promise(resolve => setImmediate(resolve));

topic("Channel: send, then read with for await");
{
  // A log of values. By default, each consumer reads all of them.
  const ch = new Channel<number>();

  ch.send(1); // Synchronous, never blocks, and runs no consumer code
  ch.send(2);
  ch.close(); // Values already sent can still be read

  for await (const n of ch) console.log(n); // => 1, then 2
}

topic('"latest" skips: head first, then newest');
{
  const ch = new Channel<number>({ thenReceive: "latest" });

  ch.send(1);
  ch.send(2);
  ch.send(3);

  const it = ch[Symbol.asyncIterator]();
  console.log((await it.next()).value); // => 1, the oldest unread value
  console.log((await it.next()).value); // => 3, 2 was skipped
}

topic("Two options pick the channel's behaviour");
// firstReceive picks a consumer's first value.
// thenReceive picks every value after that.
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
  const price = new Channel<number>({
    firstReceive: "latest",
    thenReceive: "latest",
  });
  price.send(100);
  price.send(101);
  console.log((await price[Symbol.asyncIterator]().next()).value); // => 101
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
topic("stopStyle", "- ");
{
  // "drain", the default, lets consumers finish. "stop" drops what is unread.
  const ch = new Channel<number>({ stopStyle: "stop" });
  ch.send(1);
  ch.close();
  console.log((await ch[Symbol.asyncIterator]().next()).done); // => true
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

topic("feed: move a source into a channel");
topic("Sources", "- ");
{
  // A source is a promise or any iterator, sync or async.
  async function* numbers() {
    yield 1;
    yield 2;
  }

  const ch = new Channel<number>();
  feed(numbers(), ch); // Waits for a consumer, then respects backpressure

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
topic("feed options", "- ");
{
  // autoStart runs with no consumer, backPressure: false skips the wait.
  // sendReturn also sends a generator's return value.
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

topic("select: one state from many sources");
{
  const user = Promise.withResolvers<string>();
  const state = select({ title: "Home", user: user.promise });
  const it = state[Symbol.asyncIterator]();

  // Plain values stay as they are. Sources become a Val.
  const first = (await it.next()).value;
  console.log(first.title, first.user.status); // => Home pending

  user.resolve("Ada");
  const second = (await it.next()).value;
  console.log(second.user.status, second.user.value); // => fulfilled Ada

  // Nothing can change a slot any more, so the channel closes itself.
  console.log((await it.next()).done); // => true
}

topic("unwrap gives plain values, and a rejection fails the channel");
topic("unwrap", "- ");
{
  const state = select({ user: Promise.resolve("Ada") }, { unwrap: true });
  for await (const { user } of state) console.log(user); // => Ada
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
topic("One Channel in two slots", "- ");
{
  // A Channel opens one reader per slot, so both slots read every value.
  const ch = new Channel<number>({ firstReceive: "first" });
  feed([1, 2], ch);
  for await (const vals of select([ch, ch], { unwrap: true }))
    console.log(vals);
  // => [undefined, undefined]
  // => [1, 1]
  // => [2, 2]
}

topic("The shape stays mutable");
{
  const state = select({ a: 1 } as Record<string, unknown>, {
    autoClose: false,
  });
  const it = state[Symbol.asyncIterator]();
  await it.next();

  state.b = Promise.resolve(2); // Adds a slot
  state.a = 10; // Replaces a source
  delete state.b; // Removes a slot, and never closes the removed source

  console.log((await it.next()).value); // => { a: 10 }

  // Reads return the source you assigned, not its state.
  console.log(state.a); // => 10

  state[CHAN].close(); // CHAN reaches the underlying Channel
}

topic("Arrays and the operation log");
topic("onChanges", "- ");
{
  // onChanges gets ordered operations, so a UI can replay them without diffing.
  const seen: Op[] = [];
  const rows = select(["a"], {
    autoStart: true, // Starts with no consumer
    autoClose: false,
    nonYielding: true, // Builds no snapshots, because nothing reads them
    onChanges: ops => seen.push(...ops),
  });
  await tick();

  rows.push("b");
  rows.shift();
  await tick();

  for (const op of seen) console.log(op);
  // => { op: 'splice', start: 0, removed: [], added: [ 'a' ] }
  // => { op: 'splice', start: 1, removed: [], added: [ 'b' ] }
  // => { op: 'splice', start: 0, removed: [ 'a' ], added: [] }

  // sort and reverse move slots without restarting sources.
  seen.length = 0;
  rows.push("a");
  rows.sort();
  await tick();
  console.log(seen.at(-1)); // => { op: 'move', order: [ 1, 0 ] }

  // fill and copyWithin replace a range with one splice.
  rows.fill("z");
  await tick();
  console.log(seen.at(-1));
  // => { op: 'splice', start: 0, removed: [ 'a', 'b' ], added: [ 'z', 'z' ] }

  rows[CHAN].close();
}
topic("sort comparators", "- ");
{
  // sort compares outputs, so unwrap passes values and pending slots go last.
  const scores = select([Promise.resolve(2), 3, 1], {
    unwrap: true,
    autoStart: true,
    autoClose: false,
    nonYielding: true,
  });
  await tick();

  scores.sort((a, b) => b - a);
  console.log(scores[0], scores[2]); // => 3 1
  scores[CHAN].close();
}

topic("Sync iterators advance once per flush");
{
  function* ids() {
    yield 1;
    yield 2;
  }

  // A sync iterator never keeps the channel open, and nothing pulls it again.
  // Wrap it in catching to make it async if it must run to the end.
  for await (const snapshot of select({ id: ids() }))
    console.log(snapshot.id.value); // => 1
}

topic("Helpers");
topic("spread", "- ");
{
  // spread flattens each Val into fields, usually as mapSnapshot.
  const state = select(
    { user: Promise.resolve("Ada") },
    {
      mapSnapshot: spread,
    },
  );
  for await (const view of state)
    console.log(view.user, view.userLoading, view.userError, view.userDone);
  // => Ada false null true
}
topic("isVal", "- ");
{
  // isVal tells a Val from a lookalike.
  const snapshot = (
    await select({ a: Promise.resolve(1) })
      [Symbol.asyncIterator]()
      .next()
  ).value;
  console.log(isVal(snapshot.a), isVal({ status: "pending" })); // => true false
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
  const rows = select(["a"], {
    autoStart: true,
    autoClose: false,
    nonYielding: true,
    onChanges: ops =>
      applyOps(labels, ops, (value, prev) => `${value} (was ${prev})`),
  });
  await tick();

  rows[0] = "b";
  rows.push("c");
  await tick();
  console.log(labels); // => [ 'b (was a (was undefined))', 'c (was undefined)' ]
  rows[CHAN].close();
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

// # Traps
// asend with no consumer stays pending until the channel ends.
// A next() left pending on a work queue still takes a value, which is then lost.
// With backPressure, select stops at the publish step until a consumer reads.
// Use autoStart with nonYielding, or backPressure: false, for unattended sources.
// break does not stop select, so use `using` or close the channel.
// sort is a one-off, so later updates do not move slots.
// A comparator that changes the shape gets a TypeError.
// One iterator in two slots shares a cursor, so each value reaches one slot.
// fill and copyWithin can do this silently, and leave overwritten iterators open.
// An attached consumer that is dropped without return() keeps its backlog alive.
// An always-ready source with backPressure: false starves the event loop.
// Under stopStyle: "stop", send(1) then close() in one run always drops 1.
