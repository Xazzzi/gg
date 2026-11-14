import { Channel } from "./channel.ts";
import { owned, register } from "./devtools.ts";
import { applyOps } from "./helpers.ts";
import {
  applyOutput,
  converted,
  drive,
  type Entry,
  isDynamic,
  release,
  toNodes,
} from "./host.ts";
import type { Child } from "./jsx.ts";
import { changes, isState, type Op, type State } from "./select.ts";

// `finished` marks a finished child, and `sent` a value sent after the last render (JX-03C).
type Kept = Entry & {
  handle: Handle<unknown>;
  item: unknown;
  finished?: boolean;
  sent?: boolean;
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

/** Renders one entry for each item of an array select, and gives each entry an `Item` handle. */
export function each<T>(
  state: State<readonly unknown[], any, T[]>,
  render: (item: Item<T>) => Child,
): AsyncGenerator<Node[], void, void> {
  if (!isState(state) || !Array.isArray(state))
    throw new TypeError("each needs a select proxy with an array shape");
  if (typeof render !== "function")
    throw new TypeError("each render must be a function");
  const control = new AbortController();
  const iterator: AsyncGenerator<Node[], void, void> = replay(
    state,
    render,
    () => iterator,
    control.signal,
  );
  // A generator queues return() behind a pending next(), so the abort wakes the wait first (JX-03B).
  const finish = iterator.return.bind(iterator);
  iterator.return = value => {
    control.abort();
    return finish(value);
  };
  register("each", iterator, { state });
  return iterator;
}

/** Replays the changes of state onto the entries of each, and yields their nodes when they change. */
async function* replay<T>(
  state: State<readonly unknown[], any, T[]>,
  render: (item: Item<T>) => Child,
  owner: () => object,
  signal: AbortSignal,
) {
  const self = owner(),
    entries: Kept[] = [],
    stale: Kept[] = [];
  let fresh: Kept[] = [],
    dirty = true,
    woke = Promise.withResolvers<void>();
  // A child that ends after a send may have missed it, so it restarts at once.
  const host = drive(
    self,
    applyOutput,
    () => {
      dirty = true;
      woke.resolve();
    },
    false,
    (entry: Kept) => {
      if (!entry.sent) entry.finished = true;
      else {
        stale.push(entry);
        woke.resolve();
      }
    },
  );
  /** Renders the item into the entry, which keeps its nodes until a dynamic child outputs. */
  const start = (entry: Entry & { item: unknown }): Kept => {
    const handle = new Handle(entry.item, self),
      kept = Object.assign(entry, { handle, finished: false, sent: false }),
      child = render(handle as Item<T>);
    if (isDynamic(child)) {
      kept.source = child;
      fresh.push(kept);
    } else kept.nodes = toNodes(child);
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
   * A read with only set operations sends values, and adds and removes no entry. */
  const apply = (ops: Op[]) => {
    const before = ops.some(op => op.op !== "set") && [...entries];
    applyOps(entries, ops, map);
    if (before) {
      const kept = new Set(entries);
      for (const entry of before)
        if (!kept.has(entry)) {
          leave(entry.handle);
          host.remove(entry);
          entry.nodes.forEach(release);
        }
      dirty = true;
    }
  };
  const reader = owned(self, () => changes(state)); // DV-043
  signal.addEventListener("abort", () => woke.resolve());
  try {
    for (const value of reader.outputs) entries.push(map(value));
    // A read starts only to wait, so reports during a yield join one read (JX-037).
    for (let read: ReturnType<typeof reader.next> | undefined; ; ) {
      // A removed entry has a handle that left, and stays removed.
      for (const entry of stale.splice(0))
        if (!left(entry.handle)) restart(entry);
      for (const entry of fresh) host.add(entry);
      fresh = [];
      if (dirty) {
        dirty = false;
        const nodes = entries.flatMap(entry => entry.nodes);
        // Stryker disable next-line CallExpression: a conversion gives the same nodes
        converted.add(nodes);
        yield nodes;
      }
      const result = await Promise.race([
        (read ??= reader.next()),
        woke.promise,
      ]);
      if (signal.aborted) return;
      if (!result) woke = Promise.withResolvers();
      else if (result.done) return;
      else {
        read = undefined;
        apply(result.value);
      }
    }
  } finally {
    reader[Symbol.dispose]();
    for (const entry of entries) leave(entry.handle);
    host.stop();
  }
}
