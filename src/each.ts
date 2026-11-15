import { Channel } from "./channel.ts";
import { owned, register } from "./devtools.ts";
import { applyOps, untouched } from "./helpers.ts";
import {
  applyOutput,
  converted,
  drive,
  type Entry,
  end,
  holds,
  isDynamic,
  PARK,
  ROUTE,
  stopIn,
  toNodes,
} from "./host.ts";
import type { Child } from "./jsx.ts";
import { changes, isState, type Op, type State } from "./select.ts";
import { append, checkOptions, noop, SHARE } from "./source.ts";

// `finished` marks a finished child, and `sent` a value sent after the last render (JX-03C).
type Kept = Entry & {
  handle: Handle<unknown>;
  item: unknown;
  finished?: boolean;
  sent?: boolean;
  round?: number; // The last structural read that kept the entry
  past?: Set<Node>; // Earlier nodes that hold a scope, which stops when the entry leaves (JX-035)
  view?: unknown; // A static result of render, which ends when the entry leaves (DV-045)
};

/** The item that `each` gives `render`, with its current value, its later values and its end. */
export type Item<T> = AsyncIterable<T> & {
  readonly value: T;
  readonly signal: AbortSignal;
};

let deliver: (handle: Handle<unknown>, value: unknown) => void,
  leave: (handle: Handle<unknown>) => void,
  left: (handle: Handle<unknown>) => boolean;

/** Holds the value of an item, and makes its signal and its channel only when code reads them. */
class Handle<T> implements Item<T> {
  #value: T;
  #owner: object;
  #channel?: Channel<T>;
  #control?: AbortController;
  #left = false;
  readonly [SHARE] = true; // Each reader reads the newest value, so derives share one

  static {
    deliver = (handle, value) => handle.#deliver(value);
    leave = handle => handle.#leave();
    left = handle => handle.#left;
  }

  constructor(value: T, owner: object) {
    this.#value = value;
    this.#owner = owner;
  }

  get value(): T {
    return this.#value;
  }

  get signal(): AbortSignal {
    if (!this.#control) {
      this.#control = new AbortController();
      if (this.#left) this.#control.abort();
    }
    return this.#control.signal;
  }

  /** Gives a reader of a latest channel, which starts at the current value. */
  [Symbol.asyncIterator](): AsyncIterator<T> {
    if (!this.#channel) {
      const channel = owned(
        this.#owner,
        () => new Channel<T>({ firstReceive: "latest", thenReceive: "latest" }),
      );
      channel.send(this.#value as never);
      if (this.#left) channel.close();
      this.#channel = channel;
      // Outside owned, so the hook finds the reader at its fixed depth (DV-003).
      register("item", this, { channel, owner: this.#owner });
    }
    return this.#channel[Symbol.asyncIterator]();
  }

  /** Sets the value, and sends it to the channel. */
  #deliver(value: T) {
    this.#value = value;
    this.#channel?.send(value as never);
  }

  /** Closes the channel and aborts the signal. */
  #leave() {
    this.#left = true;
    this.#channel?.close();
    this.#control?.abort();
  }
}

/** The options of `each`. */
export type EachOptions<T> = { key?: (value: T) => unknown };

/** Renders one entry for each item of an array select, and gives each entry an `Item` handle. */
export function each<T>(
  state: State<readonly unknown[], any, T[]>,
  render: (item: Item<T>) => Child,
  options: EachOptions<T> = {},
): AsyncGenerator<Node[], void, void> {
  if (!isState(state) || !Array.isArray(state))
    throw new TypeError("each needs a select proxy with an array shape");
  if (typeof render !== "function")
    throw new TypeError("each render must be a function");
  checkOptions(options, { key: "function" });
  const control = new AbortController(),
    rows: Rows = {};
  const iterator: AsyncGenerator<Node[], void, void> = replay(
    state,
    render,
    options.key,
    () => iterator,
    control.signal,
    rows,
  );
  // The drive of the rows parks with the host that holds each (JX-084).
  (iterator as any)[PARK] = (on: boolean) => rows.park?.(on);
  // The failures of the rows go to the drive of the host that holds each (JX-092).
  (iterator as any)[ROUTE] = (fail: (error: unknown) => void) => {
    rows.fail = fail;
  };
  // A generator queues return() behind a pending next(), so the abort wakes the wait first (JX-03B).
  const finish = iterator.return.bind(iterator);
  iterator.return = value => {
    control.abort();
    return finish(value);
  };
  register("each", iterator, { state });
  return iterator;
}

// The park function of the drive of the rows, which exists after the first `next()`.
type Rows = {
  park?: (on: boolean) => void;
  fail?: (error: unknown) => void; // The failure route of the host that drives each
};

/** Replays the changes of state onto the entries of each, and yields their nodes when they change. */
async function* replay<T>(
  state: State<readonly unknown[], any, T[]>,
  render: (item: Item<T>) => Child,
  key: ((value: T) => unknown) | undefined,
  owner: () => object,
  signal: AbortSignal,
  rows: Rows,
) {
  const self = owner(),
    entries: Kept[] = [],
    stale: Kept[] = [];
  let fresh: Kept[] = [],
    dirty = true,
    round = 0,
    reading = false,
    woken: boolean | undefined, // A wake since the last wait
    wait = noop,
    take: (() => IteratorResult<Op[], undefined>) | undefined; // Set by the read that settled
  /** Ends the wait of the loop, or its next wait when it does not wait now. */
  const wake = () => {
    woken = true;
    wait();
  };
  // A child that ends after a send may have missed it, so it restarts at once.
  const host = drive(
    self,
    (entry: Kept, state, parts) => {
      const old = entry.nodes,
        moved = applyOutput(entry, state, parts);
      // The entry of each around a part keeps the old nodes of the part.
      let top: Entry = entry;
      while (top.in) top = top.in;
      // Stryker disable next-line ConditionalExpression: an apply that moves nothing leaves no node of the entry
      if (moved) keep(top as Kept, old);
      return moved;
    },
    () => {
      dirty = true;
      wake();
    },
    false,
    error => (rows.fail ?? reportError)(error),
    (entry: Kept) => {
      if (!entry.sent) entry.finished = true;
      else {
        stale.push(entry);
        wake();
      }
    },
  );
  rows.park = host.park;
  /** Keeps the old nodes of an entry that hold a scope and left its nodes, so the entry stops them when it leaves. */
  const keep = (entry: Kept, old: Node[]) => {
    for (const node of old)
      if (holds(node) && !entry.nodes.includes(node))
        (entry.past ??= new Set()).add(node);
  };
  /** Renders the item into the entry, which keeps its nodes until a dynamic child outputs. */
  const start = (entry: Entry & { item: unknown }): Kept => {
    const handle = new Handle(entry.item, self),
      kept: Kept = Object.assign(entry, {
        handle,
        finished: false,
        sent: false,
      }),
      child = render(handle as Item<T>);
    if (isDynamic(child)) {
      kept.source = child;
      fresh.push(kept);
    } else {
      const old = kept.nodes;
      kept.view = child;
      kept.nodes = toNodes(child);
      keep(kept, old);
    }
    return kept;
  };
  /**
   * Ends the handle of the entry, and renders its item again with a new handle (JX-03C).
   * A static child of the new render changes the nodes at once, so each yields it. */
  const restart = (entry: Kept) => {
    const { source } = entry;
    leave(entry.handle);
    host.remove(entry);
    if (start(entry).source === source) dirty = true;
  };
  /** Makes an entry for a new item, or gives the value to the entry that keeps it. */
  const map = (value: unknown, prev?: Kept): Kept => {
    if (!prev) return start({ nodes: [], item: value });
    prev.item = value;
    if (prev.finished) restart(prev);
    else {
      deliver(prev.handle, value);
      prev.sent = true;
    }
    return prev;
  };
  /**
   * Replays a read onto the entries, and closes the entries that leave.
   * A read with only set operations reads only the indexes that it names. */
  const apply = (ops: Op[]) => {
    const sets = ops.every(op => op.op === "set");
    // An entry can leave only from the indexes that the sets name, or from between the entries that no operation touches.
    let span: () => (Kept | undefined)[];
    // Stryker disable next-line ConditionalExpression: the span between the untouched entries holds the named indexes too, with more work
    if (sets) {
      const named = [...new Set(ops.map(op => (op as { key: number }).key))];
      span = () => named.map(index => entries[index]);
    } else {
      const [head, tail] = untouched(ops, entries.length);
      // Stryker disable next-line ArithmeticOperator: a wider span holds the same entries that leave, with more work
      span = () => entries.slice(head, entries.length - tail);
    }
    const before = span();
    applyOps(entries, ops, map, { key: key as any });
    const after = span();
    // Stryker disable next-line UpdateOperator: rounds only need to differ
    round++;
    for (const entry of after) (entry as Kept).round = round;
    // A set that keeps each entry at its index changes no node (JX-037).
    if (!sets || after.some((entry, i) => entry !== before[i])) dirty = true;
    for (const entry of before)
      if (entry && entry.round !== round) {
        leave(entry.handle);
        end(entry.view);
        host.remove(entry);
        entry.nodes.forEach(stopIn);
        entry.past?.forEach(stopIn);
      }
  };
  const reader = owned(self, () => changes(state)); // DV-043
  signal.addEventListener("abort", wake);
  try {
    for (const value of reader.outputs) entries.push(map(value));
    // A read starts only to wait, so reports during a yield join one read (JX-037).
    for (;;) {
      // A removed entry has a handle that left, and stays removed.
      for (const entry of stale.splice(0))
        if (!left(entry.handle)) restart(entry);
      for (const entry of fresh) host.add(entry);
      fresh = [];
      if (dirty) {
        dirty = false;
        const nodes: Node[] = [];
        for (const entry of entries) append(nodes, entry.nodes);
        // Stryker disable next-line CallExpression: a conversion gives the same nodes
        converted.add(nodes);
        yield nodes;
      }
      if (!reading) {
        reading = true;
        reader.next().then(
          result => {
            take = () => result;
            wait();
          },
          error => {
            take = () => {
              throw error;
            };
            wait();
          },
        );
      }
      // One promise for each wait, so a read retains no wake, and a wake retains no read.
      await new Promise<void>(resolve => {
        wait = resolve;
        if (woken || take) resolve();
      });
      woken = false;
      if (signal.aborted) return;
      if (!take) continue;
      const result = take();
      take = undefined;
      reading = false;
      if (result.done) return;
      apply(result.value);
    }
  } finally {
    reader[Symbol.dispose]();
    for (const entry of entries) leave(entry.handle), end(entry.view);
    host.stop();
  }
}
