/// # Learn gg in Y minutes
///
/// `gg` gives you three primitives.
/// `Channel` moves values, `feed` fills channels, and `select` turns many sources into one state.
///
/// The block below is one ES module.
/// It runs top to bottom, and each `// =>` comment shows what the line prints.
/// Each section sits in its own `{ }` scope, so names can repeat.
/// The rules behind all of this live in [`spec/`](spec/).

import {
  abortable,
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

const tick = () => new Promise(resolve => setImmediate(resolve));

// 1. Channel: send, then read with for await
{
  // A log of values. "every" means each consumer reads all of them.
  const ch = new Channel<number>({ thenReceive: "every" });

  ch.send(1); // Synchronous, never blocks, and runs no consumer code
  ch.send(2);
  ch.close(); // Values already sent can still be read

  for await (const n of ch) console.log(n); // => 1, then 2
}

// 2. The default mode skips: head first, then newest
{
  const ch = new Channel<number>(); // unread, latest, drain

  ch.send(1);
  ch.send(2);
  ch.send(3);

  const it = ch[Symbol.asyncIterator]();
  console.log((await it.next()).value); // => 1, the oldest unread value
  console.log((await it.next()).value); // => 3, 2 was skipped
}

// 3. Two options pick the channel's behaviour
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
{
  // Broadcast: a late consumer replays the whole log.
  const log = new Channel<string>({
    firstReceive: "first",
    thenReceive: "every",
  });
  log.send("a");
  log.send("b");
  log.close();
  for await (const line of log) console.log(line); // => a, then b
  for await (const line of log) console.log(line); // => a, then b
}
{
  // Work queue: each value reaches exactly one consumer.
  const jobs = new Channel<number>({ thenReceive: "unread" });
  const a = jobs[Symbol.asyncIterator]();
  const b = jobs[Symbol.asyncIterator]();
  jobs.send(1);
  jobs.send(2);
  console.log((await a.next()).value); // => 1
  console.log((await b.next()).value); // => 2
}
{
  // Latest holder: a new consumer sees the current value at once.
  const price = new Channel<number>({ firstReceive: "latest" });
  price.send(100);
  price.send(101);
  console.log((await price[Symbol.asyncIterator]().next()).value); // => 101
}

// 4. Backpressure with asend
{
  const ch = new Channel<number>();

  // asend appends like send, and resolves when a consumer reads the value.
  // With no consumer it stays pending, so await here would wait forever.
  const sent = ch.asend(1);

  await ch[Symbol.asyncIterator]().next();
  await sent; // Resolves at the read, not when the consumer finishes its work
  console.log("read"); // => read
}

// 5. Ending a channel
{
  // close(value) becomes the consumer's return value.
  const ch = new Channel<number, string>();
  ch.close("bye");
  console.log(await ch[Symbol.asyncIterator]().next());
  // => { value: 'bye', done: true }

  console.log(ch.signal.aborted); // => true, signal aborts synchronously
  ch.close("ignored"); // The first close or throw wins
}
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
{
  // "drain", the default, lets consumers finish. "stop" drops what is unread.
  const ch = new Channel<number>({ stopStyle: "stop" });
  ch.send(1);
  ch.close();
  console.log((await ch[Symbol.asyncIterator]().next()).done); // => true
}
{
  // `using` closes the channel at the end of the scope.
  // Node 24 runs it natively, and Node 22 needs a transpiler or `ch[Symbol.dispose]()`.
  using ch = new Channel<number>();
  ch.send(1);
}
{
  // break detaches one consumer, and the channel stays open.
  const ch = new Channel<number>();
  ch.send(1);
  for await (const _ of ch) break;
  console.log(ch.signal.aborted); // => false
}

// 6. Channels refuse thenables
{
  const ch = new Channel<unknown>();
  try {
    ch.send(Promise.resolve(1));
  } catch (error) {
    console.log((error as Error).name); // => TypeError
  }
  // Await the promise first, or let feed do it.
}

// 7. feed: move a source into a channel
{
  // A source is a promise or any iterator, sync or async.
  async function* numbers() {
    yield 1;
    yield 2;
  }

  const ch = new Channel<number>({ thenReceive: "every" });
  feed(numbers(), ch); // Waits for a consumer, then respects backpressure

  // The channel closes once the last source finishes.
  for await (const n of ch) console.log(n); // => 1, then 2
}
{
  // Several feeds merge. One run keeps its order, but runs interleave.
  const ch = new Channel<string>({ thenReceive: "every" });
  feed(["a"], ch);
  feed(Promise.resolve("b"), ch);

  const out: string[] = [];
  for await (const value of ch) out.push(value);
  console.log(out.sort()); // => [ 'a', 'b' ]
}
{
  // autoStart runs with no consumer, backPressure: false skips the wait.
  // sendReturn also sends a generator's return value.
  function* steps() {
    yield 1;
    return 2;
  }

  const ch = new Channel<number>({ thenReceive: "every" });
  await feed(steps(), ch, {
    autoStart: true,
    backPressure: false,
    sendReturn: true,
  });

  for await (const n of ch) console.log(n); // => 1, then 2
}
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

// 8. select: one state from many sources
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

// 9. unwrap gives plain values, and a rejection fails the channel
{
  const state = select({ user: Promise.resolve("Ada") }, { unwrap: true });
  for await (const { user } of state) console.log(user); // => Ada
}
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

// 10. The shape stays mutable
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

// 11. Arrays and the operation log
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

  // sort, reverse, fill and copyWithin throw, because no operation describes them.
  try {
    rows.sort();
  } catch (error) {
    console.log((error as Error).name); // => TypeError
  }

  rows[CHAN].close();
}

// 12. Sync iterators advance once per flush
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

// 13. Helpers
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
{
  // isVal tells a Val from a lookalike.
  const snapshot = (
    await select({ a: Promise.resolve(1) })
      [Symbol.asyncIterator]()
      .next()
  ).value;
  console.log(isVal(snapshot.a), isVal({ status: "pending" })); // => true false
}
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

// 14. Traps
// asend with no consumer stays pending until the channel ends.
// A next() left pending on a work queue still takes a value, which is then lost.
// With backPressure, select stops at the publish step until a consumer reads.
// Use autoStart with nonYielding, or backPressure: false, for unattended sources.
// break does not stop select, so use `using` or close the channel.
// An attached consumer that is dropped without return() keeps its backlog alive.
// An always-ready source with backPressure: false starves the event loop.
// Under stopStyle: "stop", send(1) then close() in one run always drops 1.
