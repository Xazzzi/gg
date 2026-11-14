// The host machinery of the JSX runtime: conversion, placement, drives, placement waits and dynamic props.
import { type Emit, owned, register } from "./devtools.ts";
import type { Child } from "./jsx.ts";
import { select, type Val } from "./select.ts";
import { noop } from "./source.ts";

// An entry that a drive keys, with its source and its last applied output.
type Driven = { key?: string; source?: unknown; value?: unknown };
export type Entry = Driven & { nodes: Node[]; text?: Text };
type Prop = Driven & { name: string };
// Properties whose attribute sets only the initial state, or that have no attribute.
export const LIVE = new Set([
  "value",
  "checked",
  "selected",
  "indeterminate",
  "muted",
]);

/** Gives the attribute text of a value, and throws for an object with no text of its own (JX-002). */
export const attribute = (name: string, value: any): string => {
  if (value === true) return "";
  if (value.toString === Object.prototype.toString)
    throw new TypeError(`${name} does not take a plain object`);
  return `${value}`;
};

/** Tells if a value renders as a `Text` node. */
const isText = (value: unknown) =>
  typeof value === "string" ||
  typeof value === "number" ||
  typeof value === "bigint";
/** Tells if a value is a promise or an async iterable, which a host drives. */
export const isDynamic = (value: any) =>
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
export const toNodes = (child: unknown) => {
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
 * Puts want into parent in order between the children first and after, and removes the other children between them.
 * Gives the nodes that were not children, or undefined when a child outside that range is in want.
 * Moves only the nodes outside a longest run that keeps its order, so a swap moves two nodes. */
const arrange = (
  parent: Element,
  want: Node[],
  first: ChildNode | null,
  after: ChildNode | null,
  whole: boolean,
): Node[] | undefined => {
  const keep = new Set(want);
  // A node that appears twice lands at its last place.
  // Stryker disable next-line ConditionalExpression,EqualityOperator: a filter of distinct nodes keeps all
  if (keep.size < want.length)
    want = want.filter((node, i) => want.lastIndexOf(node) === i);
  const old = new Map<Node, number>(),
    leave: ChildNode[] = [];
  for (let at = first; at !== after; at = (at as ChildNode).nextSibling)
    if (keep.has(at as ChildNode)) old.set(at as ChildNode, old.size);
    else leave.push(at as ChildNode);
  // Stryker disable next-line ConditionalExpression: the whole range holds each child of parent
  if (!whole) {
    let inside = 0;
    // Stryker disable next-line ConditionalExpression: a count that is too high arranges the whole range
    for (const node of keep) if (node.parentNode === parent) inside++;
    // Stryker disable next-line ConditionalExpression,EqualityOperator: the whole range gives the same nodes
    if (inside > old.size) return undefined;
  }
  // Stryker disable next-line ConditionalExpression,BlockStatement: the general path gives the same nodes, with one removal for each
  if (!old.size && whole) {
    parent.replaceChildren();
    for (const node of want) parent.insertBefore(node, null);
    return want;
  }
  for (const node of leave) node.remove();
  const at: number[] = [],
    seq: number[] = [],
    // Stryker disable next-line ArrayDeclaration: a value that is not a node wakes nothing
    added: Node[] = [];
  want.forEach((node, i) => {
    const n = old.get(node);
    if (n === undefined) added.push(node);
    else {
      at.push(i);
      seq.push(n);
    }
  });
  const fixed = new Uint8Array(want.length);
  for (const i of longest(seq)) fixed[at[i]] = 1;
  let anchor: Node | null = after;
  for (let i = want.length; i--; anchor = want[i])
    if (!fixed[i]) parent.insertBefore(want[i], anchor);
  return added;
};

/**
 * Puts the nodes of all entries into parent in order, removes other children, and gives the nodes that were not children.
 * Arranges only the nodes between the first and the last children that stay in place, so a change costs no walk of the rest. */
const place = (parent: Element, entries: Entry[]): Node[] => {
  const want = entries.flatMap(entry => entry.nodes);
  let from = 0,
    to = want.length,
    first = parent.firstChild,
    after: ChildNode | null = null;
  // Stryker disable all: a range that is too wide gives the same nodes, and one that holds a child from outside it falls back to the whole range
  for (; want[from] === first; first = (first as ChildNode).nextSibling) from++;
  // A child after first exists while after is not first, and no child before first is at the end of want.
  for (
    let last = parent.lastChild;
    after !== first && want[to - 1] === last;
    last = (last as ChildNode).previousSibling
  ) {
    after = last;
    to--;
  }
  const some = from || after;
  return (
    (some && arrange(parent, want.slice(from, to), first, after, false)) ||
    (arrange(parent, want, parent.firstChild, null, true) as Node[])
  );
  // Stryker restore all
};

// The node arrays that each yields hold converted nodes, so a host takes them as they are.
export const converted = new WeakSet<Node[]>();

/**
 * Applies a source state to the nodes of its entry, and tells if the nodes changed.
 * A pending state has an undefined value, as a new entry has, so it keeps the nodes. */
export const applyOutput = (entry: Entry, state: Val<unknown>): boolean => {
  if (state.status === "rejected") {
    reportError(state.reason);
    return false;
  }
  const { value } = state;
  if (Object.is(value, entry.value)) return false;
  const retext = !!entry.text && isText(value);
  if (retext) (entry.text as Text).data = `${value}`;
  else
    try {
      // Stryker disable next-line ConditionalExpression: a conversion gives the same nodes
      entry.nodes = converted.has(value as Node[])
        ? (value as Node[])
        : toNodes(value);
      entry.text = isText(value) ? (entry.nodes[0] as Text) : undefined;
    } catch (error) {
      reportError(error);
      return false;
    }
  entry.value = value;
  return !retext;
};

// The emitters of component results, which a host ends one time (DV-045).
export const ends = new WeakMap<object, Emit>();
/** Tells devtools one time that a component result ended. */
export const end = (source: unknown) => {
  ends.get(source as object)?.("end");
  ends.delete(source as object);
};

/**
 * Drives dynamic entries with one select by key, so a move in the host never restarts a source.
 * Calls changed after a report in which apply changed the nodes of an entry (JX-023), and done for each entry whose source finished. */
export const drive = <E extends Driven>(
  owner: object,
  apply: (entry: E, state: Val<unknown>) => unknown, // Tells if the nodes changed
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
        let moved = false;
        for (const op of ops) {
          const entry = keyed.get((op as { key: string }).key),
            state = (op as { value: Val<unknown> }).value;
          if (!entry) continue;
          if (apply(entry, state)) moved = true;
          if (state.done) {
            end(entry.source);
            done?.(entry);
          }
        }
        if (moved) changed();
      },
    }),
  );
  return {
    add(entry: E) {
      // Stryker disable next-line UpdateOperator: keys only need to differ
      entry.key = `${id++}`;
      keyed.set(entry.key, entry);
      sources[entry.key] = entry.source;
    },
    remove({ key, source }: E) {
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

// The stop function of the drive of each host, and of the dynamic props of each element.
const hosts = new WeakMap<Node, () => void>(),
  bound = new WeakMap<Node, () => void>();
// What starts when a runtime placement first reaches a node: a host (JX-02B), or the wait of use (JX-054).
export const waiting = new WeakMap<Node, () => void>(),
  binding = new WeakMap<Node, () => void>(); // The dynamic props, which start after the host (JX-061)
type Wait = (() => void) & { ref: WeakRef<Node> };
// The nodes of the waits that are not started, so a placement walks no node when there is none.
const unstarted = new Set<WeakRef<Node>>();
// The ancestors that an element had when its drive started, so a stop of a subtree walks only to drives.
const holds = new WeakSet<Node>();

/** Makes start wait in map until a runtime placement reaches node. */
export const defer = (
  map: WeakMap<Node, () => void>,
  node: Node,
  start: () => void,
) => {
  const ref = new WeakRef(node),
    wait = () => {
      settle(map, node);
      start();
    };
  unstarted.add(ref);
  map.set(node, Object.assign(wait, { ref }));
};
/** Ends the wait of node in map, if it has one. */
const settle = (map: WeakMap<Node, () => void>, node: Node) => {
  const wait = map.get(node) as Wait | undefined;
  if (wait) unstarted.delete(wait.ref);
  map.delete(node);
};
/** Tells if a wait can still start, and forgets the waits of collected nodes. */
const waits = () => {
  for (const ref of unstarted) if (!ref.deref()) unstarted.delete(ref);
  return unstarted.size > 0;
};
/** Marks the ancestors of an element whose drive starts. */
const hold = (node: Node) => {
  for (let at = node.parentNode; at && !holds.has(at); at = at.parentNode)
    holds.add(at);
};
/** Starts the waiting hosts and dynamic props in node and its descendants, in tree order. */
const wake = (node: Node) => {
  waiting.get(node)?.();
  binding.get(node)?.();
  for (let child = node.firstChild; child; child = child.nextSibling)
    wake(child);
};
/** Places the entries of a started host, and wakes the nodes that were not its children (JX-02B). */
const settleIn = (parent: Element, entries: Entry[]) => {
  const added = place(parent, entries);
  if (waits()) added.forEach(wake);
};
/** Stops the drives of node and its descendants, and the dynamic props of the descendants. */
export const unmount = (node: Node, props = false) => {
  hosts.get(node)?.();
  if (props) bound.get(node)?.();
  for (const child of node.childNodes) unmount(child, true);
};
/** Stops the drives and the dynamic props that started in node and its descendants (JX-035). */
export const release = (node: Node) => {
  hosts.get(node)?.();
  bound.get(node)?.();
  if (holds.has(node))
    for (let child = node.firstChild; child; child = child.nextSibling)
      release(child);
};

/** Applies an output of a dynamic prop to its element, and changes no node (JX-062 to JX-065). */
const applyProp = (element: Element, entry: Prop, state: Val<unknown>) => {
  const { value } = state,
    name = entry.name as string;
  if (state.status === "rejected") reportError(state.reason);
  else if (!Object.is(value, entry.value))
    try {
      if (LIVE.has(name)) (element as any)[name] = value;
      else if (value == null || value === false) element.removeAttribute(name);
      else element.setAttribute(name, attribute(name, value));
      entry.value = value;
    } catch (error) {
      reportError(error);
    }
};

/** Makes the dynamic props of an element wait until the runtime places it, and then drives them (JX-061). */
export const bind = (element: Element, props: [string, unknown][]) =>
  defer(binding, element, () => {
    hold(element);
    const host = drive(
      element,
      (entry: Prop, state) => applyProp(element, entry, state),
      noop,
      true,
    );
    bound.set(element, host.stop);
    for (const [name, source] of props) host.add({ name, source });
  });

/**
 * Makes parent a host for children, with static runs and dynamic entries in order.
 * mount and jsx both call it, so the hook finds their caller at one depth (DV-003). */
export const attach = (parent: Element, children: Child, placed: boolean) => {
  let run: Entry = { nodes: [] };
  const entries = [run],
    dynamic: Entry[] = [];
  convert(
    children,
    node => run.nodes.push(node),
    source => {
      const entry = { nodes: [], source };
      dynamic.push(entry);
      run = { nodes: [] };
      entries.push(entry, run);
    },
  );
  if (placed) {
    hosts.get(parent)?.();
    settle(waiting, parent);
    settleIn(parent, entries);
  }
  // A new element has no child and no host, so its nodes land in order with no placement.
  else
    for (const entry of entries)
      for (const node of entry.nodes) parent.insertBefore(node, null);
  if (!dynamic.length) return;
  register("mount", parent, {});
  const start = () => {
    hold(parent);
    const host = drive(
      parent,
      applyOutput,
      () => settleIn(parent, entries),
      true,
    );
    hosts.set(parent, host.stop);
    for (const entry of dynamic) host.add(entry);
  };
  if (placed) start();
  else defer(waiting, parent, start);
};
