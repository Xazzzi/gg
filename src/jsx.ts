import { Channel } from "./channel.ts";
import { type Emit, owned, register } from "./devtools.ts";
import { applyOps } from "./helpers.ts";
import {
  changes,
  isState,
  type Op,
  type State,
  select,
  type Val,
} from "./select.ts";

export type Static =
  | Node
  | string
  | number
  | bigint
  | boolean
  | null
  | undefined
  | readonly Static[];
export type Dynamic = PromiseLike<Static> | AsyncIterable<Child>;
export type Child = Static | Dynamic | readonly Child[];
export type Props = {
  [name: `on${string}`]: ((event: any) => void) | undefined;
} & { [name: string]: unknown; children?: Child };

export declare namespace JSX {
  type Element = Child;
  interface IntrinsicElements {
    [tag: string]: Props;
  }
  interface ElementChildrenAttribute {
    children: unknown;
  }
}

type Entry = {
  nodes: Node[];
  value?: unknown;
  text?: Text;
  key?: string;
  source?: unknown;
};
// `ended` marks a finished child, and `sent` a value sent after the last render (JX-03C).
type Kept = Entry & {
  handle: Handle<unknown>;
  item: unknown;
  ended?: boolean;
  sent?: boolean;
};

const SVG = "http://www.w3.org/2000/svg";
// Children exist before their parent, so a tag alone picks the namespace.
const SVG_TAGS = new Set(
  "svg g defs symbol use image switch foreignObject desc metadata path rect circle ellipse line polyline polygon text tspan textPath linearGradient radialGradient stop pattern clipPath mask marker filter view animate animateMotion animateTransform set mpath".split(
    " ",
  ),
);
// Properties whose attribute sets only the initial state, or that have no attribute.
const LIVE = new Set([
  "value",
  "checked",
  "selected",
  "indeterminate",
  "muted",
]);

/** Tells if a value renders as a `Text` node. */
const isText = (value: unknown) =>
  typeof value === "string" ||
  typeof value === "number" ||
  typeof value === "bigint";
/** Tells if a value is a promise or an async iterable, which a host drives. */
const isDynamic = (value: any) =>
  value != null &&
  (typeof value.then === "function" ||
    typeof value[Symbol.asyncIterator] === "function");

/**
 * Converts a child to nodes in order, and hands each dynamic child to found.
 * Without found, a dynamic child throws. */
const convert = (
  child: any,
  push: (node: Node) => void,
  found?: (child: unknown) => void,
): void => {
  if (Array.isArray(child))
    for (const item of child) convert(item, push, found);
  else if (isDynamic(child)) {
    if (!found) throw new TypeError("A dynamic child is not permitted here");
    found(child);
  } else if (typeof child?.nodeType === "number")
    if (child.nodeType === 11) for (const node of child.childNodes) push(node);
    else push(child);
  else if (isText(child)) push(document.createTextNode(`${child}`));
  else if (child != null && typeof child !== "boolean")
    throw new TypeError(`${String(child)} is not a JSX child`);
};

/** Converts a static child to an array of nodes. */
const toNodes = (child: unknown) => {
  const nodes: Node[] = [];
  convert(child, node => nodes.push(node));
  return nodes;
};

/** Gives the indices of one longest increasing run of seq, last first. */
const longest = (seq: number[]) => {
  // Stryker disable next-line ArrayDeclaration: no value ranks above an extra first tail, so the first step overwrites it
  const tails: number[] = [],
    // Stryker disable next-line ArrayDeclaration: the first step overwrites prev[0]
    prev: number[] = [];
  for (let i = 0; i < seq.length; i++) {
    let lo = 0,
      hi = tails.length;
    // Stryker disable next-line all: a value past the last tail skips a search that finds the same slot
    if (hi && seq[tails[hi - 1]] < seq[i]) lo = hi;
    else
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        // Stryker disable next-line EqualityOperator: seq holds distinct positions
        if (seq[tails[mid]] < seq[i]) lo = mid + 1;
        else hi = mid;
      }
    prev[i] = lo ? tails[lo - 1] : -1;
    tails[lo] = i;
  }
  // Stryker disable next-line ArrayDeclaration: an extra item marks no index of fixed
  const run: number[] = [];
  for (let i = tails[tails.length - 1]; i >= 0; i = prev[i]) run.push(i);
  return run;
};

/**
 * Puts the nodes of all entries into parent in order, and removes other children.
 * Moves only the nodes outside a longest run that keeps its order, so a swap moves two nodes. */
const place = (parent: Element, entries: Entry[]) => {
  let want = entries.flatMap(entry => entry.nodes);
  const keep = new Set(want);
  // A node that appears twice lands at its last place.
  // Stryker disable next-line ConditionalExpression,EqualityOperator: a filter of distinct nodes keeps all
  if (keep.size < want.length)
    want = want.filter((node, i) => want.lastIndexOf(node) === i);
  const old = new Map<Node, number>(),
    leave: ChildNode[] = [];
  for (let at = parent.firstChild; at; at = at.nextSibling)
    if (keep.has(at)) old.set(at, old.size);
    else leave.push(at);
  // Stryker disable next-line ConditionalExpression,BlockStatement: the general path gives the same nodes, with one removal for each
  if (!old.size) {
    parent.replaceChildren();
    for (const node of want) parent.insertBefore(node, null);
    return;
  }
  for (const node of leave) node.remove();
  const at: number[] = [],
    seq: number[] = [];
  want.forEach((node, i) => {
    const n = old.get(node);
    if (n !== undefined) at.push(i), seq.push(n);
  });
  const fixed = new Uint8Array(want.length);
  for (const i of longest(seq)) fixed[at[i]] = 1;
  let anchor: Node | null = null;
  for (let i = want.length; i--; anchor = want[i])
    if (!fixed[i]) parent.insertBefore(want[i], anchor);
};

// The node arrays that each yields hold converted nodes, so a host takes them as they are.
const converted = new WeakSet<Node[]>();

/**
 * Applies a source state to the nodes of its entry.
 * A pending state has an undefined value, as a new entry has, so it keeps the nodes. */
const update = (entry: Entry, state: Val<unknown>) => {
  if (state.status === "rejected") return reportError(state.reason);
  const { value } = state;
  if (Object.is(value, entry.value)) return;
  if (entry.text && isText(value)) entry.text.data = `${value}`;
  else
    try {
      // Stryker disable next-line ConditionalExpression: a conversion gives the same nodes
      entry.nodes = converted.has(value as Node[])
        ? (value as Node[])
        : toNodes(value);
      entry.text = isText(value) ? (entry.nodes[0] as Text) : undefined;
    } catch (error) {
      return reportError(error);
    }
  entry.value = value;
};

// The emitters of component results, which a host ends one time (DV-045).
const ends = new WeakMap<object, Emit>();
/** Tells devtools one time that a component result ended. */
const end = (source: unknown) => {
  ends.get(source as object)?.("end");
  ends.delete(source as object);
};

/**
 * Drives dynamic entries with one select by key, so a move in the host never restarts a source.
 * Calls changed after each report, and done for each entry whose source finished. */
const drive = <E extends Entry>(
  owner: object,
  changed: () => void,
  autoClose: boolean,
  done?: (entry: E) => void,
) => {
  const keyed = new Map<string, E>();
  let id = 0;
  const sources = owned(owner, () =>
    select({} as Record<string, unknown>, {
      autoStart: true,
      autoClose,
      nonYielding: true,
      onChanges: ops => {
        for (const op of ops) {
          const entry = keyed.get((op as { key: string }).key),
            state = (op as { value: Val<unknown> }).value;
          if (!entry) continue;
          update(entry, state);
          if (state.done) end(entry.source), done?.(entry);
        }
        changed();
      },
    }),
  );
  return {
    add(entry: E) {
      // Stryker disable next-line UpdateOperator: keys only need to differ
      keyed.set((entry.key = `${id++}`), entry);
      sources[entry.key] = entry.source;
    },
    remove({ key, source }: Entry) {
      keyed.delete(key as string);
      delete sources[key as string];
      end(source);
    },
    stop() {
      sources[Symbol.dispose]();
      for (const entry of keyed.values()) end(entry.source);
    },
  };
};

// The stop function of the drive of each host.
const hosts = new WeakMap<Node, () => void>();
/** Stops the drives of node and its descendants. */
const unmount = (node: Node) => {
  hosts.get(node)?.();
  for (const child of node.childNodes) unmount(child);
};

/**
 * Makes parent a host for children, with static runs and dynamic entries in order.
 * mount and jsx both call it, so the hook finds their caller at one depth (DV-003). */
const attach = (parent: Element, children: Child) => {
  let run: Entry = { nodes: [] };
  const entries = [run],
    dynamic: Entry[] = [];
  convert(
    children,
    node => run.nodes.push(node),
    source => {
      const entry = { nodes: [], source };
      dynamic.push(entry);
      entries.push(entry, (run = { nodes: [] }));
    },
  );
  hosts.get(parent)?.();
  place(parent, entries);
  if (!dynamic.length) return;
  register("mount", parent, {});
  const host = drive(parent, () => place(parent, entries), true);
  hosts.set(parent, host.stop);
  for (const entry of dynamic) host.add(entry);
};

/** Mounts children into parent, keeps dynamic children live, and gives a function that unmounts them. */
export function mount(parent: Element, ...children: Child[]): () => void {
  attach(parent, children);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    unmount(parent);
    parent.replaceChildren();
  };
}

/** Creates an element with props and children, or calls a component with props. */
export function jsx(
  type: string | ((props: any) => Child),
  props: Props,
  _key?: unknown,
): Child {
  if (typeof type === "function") {
    const result = type(props);
    if (typeof result === "object" && result) {
      const emit = register("component", result, { type, props });
      // Stryker disable next-line ConditionalExpression: an undefined emitter only costs a WeakMap entry
      if (emit) ends.set(result, emit);
    }
    return result;
  }
  const { xmlns } = props;
  const element =
    typeof xmlns === "string"
      ? document.createElementNS(xmlns, type)
      : SVG_TAGS.has(type) || /^fe[A-Z]/.test(type)
        ? document.createElementNS(SVG, type)
        : document.createElement(type);
  const live: [string, unknown][] = [];
  for (const name of Object.keys(props)) {
    const value = props[name];
    if (name === "children" || value == null || value === false) continue;
    if (typeof value === "function" && name.startsWith("on"))
      element.addEventListener(name.slice(2).toLowerCase(), value as any);
    else if (LIVE.has(name)) live.push([name, value]);
    else element.setAttribute(name, value === true ? "" : `${value}`);
  }
  attach(element, props.children);
  // After the children, so a select finds the option that its value names.
  for (const [name, value] of live) (element as any)[name] = value;
  return element;
}

export const jsxs = jsx,
  jsxDEV = jsx;

/** Groups static children into a `DocumentFragment`. */
export function Fragment({ children }: { children?: Child }) {
  const fragment = document.createDocumentFragment();
  fragment.append(...toNodes(children));
  return fragment;
}

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
  iterator.return = value => (control.abort(), finish(value));
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
    () => ((dirty = true), woke.resolve()),
    false,
    (entry: Kept) => {
      if (entry.sent) stale.push(entry), woke.resolve();
      else entry.ended = true;
    },
  );
  /** Renders the item into the entry, which keeps its nodes until a dynamic child outputs. */
  const start = (entry: Entry & { item: unknown }): Kept => {
    const handle = new Handle(entry.item, self),
      kept = Object.assign(entry, { handle, ended: false, sent: false }),
      child = render(handle as Item<T>);
    if (isDynamic(child)) (kept.source = child), fresh.push(kept);
    else kept.nodes = toNodes(child);
    return kept;
  };
  /**
   * Ends the handle of the entry, and renders its item again with a new handle (JX-03C).
   * The drive reports the removal, so each yields a static child of the new render. */
  const restart = (entry: Kept) => {
    leave(entry.handle);
    host.remove(entry);
    start(entry);
  };
  /** Makes an entry for a new item, or gives the value to the entry that keeps it. */
  const map = (value: unknown, prev?: Kept): Kept => {
    if (!prev) return start({ nodes: [], item: value });
    prev.item = value;
    if (prev.ended) restart(prev);
    else deliver(prev.handle, value), (prev.sent = true);
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
        if (!kept.has(entry)) leave(entry.handle), host.remove(entry);
      dirty = true;
    }
  };
  const reader = changes(state);
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
      else (read = undefined), apply(result.value);
    }
  } finally {
    reader[Symbol.dispose]();
    for (const entry of entries) leave(entry.handle);
    host.stop();
  }
}
