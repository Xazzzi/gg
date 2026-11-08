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
 * Puts the nodes of all entries into parent in order, removes other children, and gives the nodes that were not children.
 * Moves only the nodes outside a longest run that keeps its order, so a swap moves two nodes. */
const place = (parent: Element, entries: Entry[]): Node[] => {
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
    return want;
  }
  for (const node of leave) node.remove();
  const at: number[] = [],
    seq: number[] = [],
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
  let anchor: Node | null = null;
  for (let i = want.length; i--; anchor = want[i])
    if (!fixed[i]) parent.insertBefore(want[i], anchor);
  return added;
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
/** Starts the waiting hosts and dynamic props in node and its descendants, in tree order. */
const wake = (node: Node) => {
  waiting.get(node)?.();
  binding.get(node)?.();
  for (const child of node.childNodes) wake(child);
};
/** Stops the drives of node and its descendants, and the dynamic props of the descendants. */
export const unmount = (node: Node, props = false) => {
  hosts.get(node)?.();
  if (props) bound.get(node)?.();
  for (const child of node.childNodes) unmount(child, true);
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
      else element.setAttribute(name, value === true ? "" : `${value}`);
      entry.value = value;
    } catch (error) {
      reportError(error);
    }
};

/** Makes the dynamic props of an element wait until the runtime places it, and then drives them (JX-061). */
export const bind = (element: Element, props: [string, unknown][]) =>
  binding.set(element, () => {
    binding.delete(element);
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
  hosts.get(parent)?.();
  waiting.delete(parent);
  const added = place(parent, entries);
  if (placed) added.forEach(wake);
  if (!dynamic.length) return;
  register("mount", parent, {});
  const start = () => {
    waiting.delete(parent);
    const host = drive(
      parent,
      applyOutput,
      () => place(parent, entries).forEach(wake),
      true,
    );
    hosts.set(parent, host.stop);
    for (const entry of dynamic) host.add(entry);
  };
  if (placed) start();
  else waiting.set(parent, start);
};
