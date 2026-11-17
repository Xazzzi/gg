// The host machinery of the JSX runtime: conversion, placement, drives, placement waits and dynamic props.
import { StopError } from "./channel.ts";
import { type Emit, owned, pulling, register, release } from "./devtools.ts";
import { BIND } from "./helpers.ts";
import type { Child } from "./jsx.ts";
import { CHAN, FAULT, REPORT, RETURNS, select, type Val } from "./select.ts";
import { chunked, noop, record } from "./source.ts";

// An entry that a drive keys, with its source and its last applied output.
type Driven = { key?: string; source?: unknown; value?: unknown; via?: Gated };
// A part is a dynamic child in an output of the entry `in`, or a run of static nodes between two of them (JX-085).
export type Entry = Driven & {
  nodes: Node[];
  text?: Text;
  parts?: Entry[]; // The parts of the last output, in order
  pool?: Map<unknown, Entry>; // Each part that the outputs of the entry made, by its source
  in?: Entry;
  gate?: PromiseWithResolvers<void>; // Of a parked part
  ended?: true; // Its drive took it out
};
type Gated = { next(): unknown; return(): unknown };
// A node whose children a host places: an element, or a shadow root (JX-02C).
export type Parent = Element | ShadowRoot;
// What adds a part to the drive of its entry, what takes it out, and what hands on a failure (JX-092).
type Parts = {
  add(entry: Entry): void;
  quit(entry: Entry): void;
  fail(error: unknown): void;
  held(): Promise<void> | undefined; // The wait of a parked drive
};
type Prop = Driven & { name: string };
// Properties whose attribute sets only the initial state, or that have no attribute.
export const LIVE = new Set([
  "value",
  "checked",
  "selected",
  "indeterminate",
  "muted",
]);

// The attributes that load or navigate to a URL, or that an SVG animation sets href to, and the javascript: scheme as the URL parser reads it (JX-009).
// The values of an animation are a list that ; separates.
const URLS = new Set([
  "href",
  "src",
  "action",
  "formaction",
  "xlink:href",
  "data",
  "to",
  "from",
  "values",
]);
const SCRIPT =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the URL parser skips leading C0 controls
  /^[\u0000-\u001F ]*j[\t\n\r]*a[\t\n\r]*v[\t\n\r]*a[\t\n\r]*s[\t\n\r]*c[\t\n\r]*r[\t\n\r]*i[\t\n\r]*p[\t\n\r]*t[\t\n\r]*:/i;

/** Gives the attribute text of a value, and throws for a function or an object with no text of its own (JX-002), or a javascript: URL (JX-009). */
export const attribute = (name: string, value: any): string => {
  if (value === true) return "";
  if (typeof value === "function")
    throw new TypeError(`${name} does not take a function`);
  if (value.toString === Object.prototype.toString)
    throw new TypeError(`${name} does not take a plain object`);
  const text = `${value}`,
    lower = name.toLowerCase();
  if (
    URLS.has(lower) &&
    (lower === "values" ? text.split(";") : [text]).some(url =>
      SCRIPT.test(url),
    )
  )
    throw new TypeError(`${name} does not take a javascript: URL`);
  return text;
};

// The custom elements that jsx made, and the held values of those whose tag has no definition yet, in key order (JX-0B2).
const customs = new WeakSet<Element>(),
  held = new WeakMap<Element, Map<string, unknown>>(),
  // Weak, so a hold retains no element (JX-0B4).
  wanted = new Map<string, Set<WeakRef<Element>>>(),
  // Takes the ref of a collected element out, so a tag that code never defines grows nothing.
  forgotten = new FinalizationRegistry<{
    refs: Set<WeakRef<Element>>;
    ref: WeakRef<Element>;
  }>(({ refs, ref }) => refs.delete(ref));
/** Marks a value that a dynamic prop holds before its first output. */
export const NONE: unique symbol = Symbol() as any;

/** Tells if a prop of element is an own property of a custom element (JX-0B0, JX-0B1). */
const own = (element: Element, name: string) =>
  customs.has(element) && name in element && !(name in HTMLElement.prototype);

/** Tells if a prop of element sets a property: a live one, or an own one of a custom element. */
export const property = (element: Element, name: string) =>
  LIVE.has(name) || own(element, name);

/** Assigns a property, or sets or removes an attribute, as JX-063 and JX-064 say. */
export const put = (element: Element, name: string, value: unknown) => {
  if (property(element, name)) (element as any)[name] = value;
  else if (value == null || value === false) element.removeAttribute(name);
  else element.setAttribute(name, attribute(name, value));
};

/**
 * Marks element as a custom element, and gives the map that holds its values when its tag has no definition yet (JX-0B2).
 * The map lists the keys in order before any value arrives. */
export const adopt = (element: Element, tag: string) => {
  customs.add(element);
  if (customElements.get(tag)) return undefined;
  const values = new Map<string, unknown>();
  held.set(element, values);
  let refs = wanted.get(tag);
  if (!refs) {
    wanted.set(tag, (refs = new Set()));
    // A rejection marks a name that is not valid, which upgrade leaves as it is.
    const apply = () => defined(tag);
    customElements.whenDefined(tag).then(apply, apply);
  }
  // A held value and no closure, because a closure here would share its context with apply, which retains it.
  const ref = new WeakRef(element);
  forgotten.register(element, { refs: refs.add(ref), ref }, ref);
  return values;
};

/** Applies the held values of the elements of tag, and fails each error to the scope around its element (JX-0B5). */
const defined = (tag: string) => {
  const refs = wanted.get(tag) as Set<WeakRef<Element>>;
  wanted.delete(tag);
  for (const ref of refs) {
    forgotten.unregister(ref);
    const element = ref.deref();
    if (!element) continue;
    const values = held.get(element) as Map<string, unknown>;
    held.delete(element);
    customElements.upgrade(element);
    for (const [name, value] of values)
      if (value !== NONE)
        try {
          put(element, name, value);
        } catch (error) {
          failIn(around(element), error);
        }
  }
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
  parent: Parent,
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
  for (const node of leave) shift(node, true);
  // Stryker disable next-line ConditionalExpression,BlockStatement: the general path gives the same nodes, with one removal for each
  if (!old.size && whole) {
    parent.replaceChildren();
    chunked(want, part => parent.append(...part));
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
const place = (parent: Parent, entries: Entry[]): Node[] => {
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
};

// Stryker restore all
// The node arrays that each yields hold converted nodes, so a host takes them as they are.
export const converted = new WeakSet<Node[]>();

// What a drive tells each source when it parks or resumes, so an each parks the drive of its rows (JX-084).
export const PARK: unique symbol = Symbol() as any;
// What a drive gives each source, so an each hands the failures of its rows to the host that drives it (JX-092).
export const ROUTE: unique symbol = Symbol() as any;
// What takes the part of a source out of its drive, for the builder that owns the source (HE-059).
const evict = new WeakMap<object, () => void>();

/**
 * Reads the source of a part for a drive, and pulls it only while the part and its drive are not parked (JX-083, JX-086).
 * A drive can park before the first pull of a part, which its select makes before the report. */
const gated = (part: Entry, host: Parts): Gated => {
  const source = part.source as AsyncIterable<unknown>;
  let iterator: AsyncIterator<unknown> | undefined;
  const pull = () =>
    pulling(source, () => (iterator ??= source[Symbol.asyncIterator]()).next()); // DV-052
  const next = (): Promise<unknown> => {
    const wait = part.gate?.promise ?? host.held();
    // A part that its drive took out while the drive was parked pulls nothing at the resume.
    return part.ended ? new Promise(noop) : wait ? wait.then(next) : pull();
  };
  return { next, return: () => iterator?.return?.() };
};

/** Parks or resumes a part and the parts of its last output. */
const hold = (part: Entry, on: boolean) => {
  if (!part.gate === !on) return;
  if (on) part.gate = Promise.withResolvers();
  else
    (part.gate as PromiseWithResolvers<void>).resolve(),
      (part.gate = undefined);
  (part.source as any)[PARK]?.(on);
  if (part.parts) for (const sub of part.parts) if (sub.source) hold(sub, on);
};

/** Throws for a source that an entry or an entry around it reads, because one iterator has one reader. */
const check = (entry: Entry, source: unknown) => {
  for (let at: Entry | undefined = entry; at; at = at.in)
    if (at.source === source)
      throw new TypeError("A dynamic child is in its own output");
};

/** Gives the part of entry for a source, and adds a new part to the drive. */
const take = (entry: Entry, source: any, host: Parts): Entry => {
  const pool = (entry.pool ??= new Map());
  let part: Entry | undefined = pool.get(source);
  if (part) return part;
  part = { nodes: [], source, in: entry };
  pool.set(source, part);
  // A promise has no pull to park.
  if (typeof source.then !== "function") {
    part.via = gated(part, host);
    register("part", part.via, { source });
  }
  evict.set(source, () => {
    pool.delete(source);
    host.quit(part);
  });
  host.add(part);
  return part;
};

/** Stops a dynamic child that a builder owns, in the drive that holds it or by its own `return` (HE-059). */
export const quitSource = (source: any) => {
  const out = evict.get(source);
  if (out) out();
  else abort(source), source.return?.();
};

/**
 * Applies a source state to the nodes of its entry, and tells if the nodes of its host changed.
 * A pending state has an undefined value, as a new entry has, so it keeps the nodes. */
export const applyOutput = (
  entry: Entry,
  state: Val<unknown>,
  host: Parts,
): boolean => {
  if (state.status === "rejected") {
    host.fail(state.reason);
    return false;
  }
  const { value } = state;
  // An entry that each renders again keeps the output of its old child (JX-03C).
  if (state.status === "pending" || Object.is(value, entry.value)) return false;
  const retext = !!entry.text && isText(value);
  if (retext) (entry.text as Text).data = `${value}`;
  else
    try {
      let nodes: Node[] = [],
        parts: Entry[] | undefined;
      const cuts: [number, unknown][] = [];
      // Stryker disable next-line ConditionalExpression: a conversion gives the same nodes
      if (converted.has(value as Node[])) nodes = value as Node[];
      else
        convert(
          value,
          node => nodes.push(node),
          source => cuts.push([nodes.length, source]),
        );
      // Stryker disable next-line ConditionalExpression: an output with no dynamic child makes one static part with the same nodes
      if (cuts.length) {
        for (const [, source] of cuts) check(entry, source);
        parts = [];
        let from = 0;
        for (const [at, source] of cuts) {
          parts.push(
            { nodes: nodes.slice(from, at) },
            take(entry, source, host),
          );
          from = at;
        }
        parts.push({ nodes: nodes.slice(from) });
        // The parts in the output run as the entry does (JX-086).
        for (const part of parts) if (part.source) hold(part, !!entry.gate);
        nodes = parts.flatMap(part => part.nodes);
      }
      // The parts that left the output park.
      if (entry.parts)
        for (const part of entry.parts)
          if (part.source && !parts?.includes(part)) hold(part, true);
      entry.parts = parts;
      entry.nodes = nodes;
      entry.text = isText(value) ? (entry.nodes[0] as Text) : undefined;
    } catch (error) {
      host.fail(error);
      return false;
    }
  entry.value = value;
  if (retext) return false;
  // The nodes of a part are in the nodes of each entry around it, while its output holds the part.
  for (let part = entry, at = entry.in; at; part = at, at = at.in) {
    if (!at.parts?.includes(part)) return false;
    at.nodes = at.parts.flatMap(each => each.nodes);
  }
  return true;
};

// The emitters of component results, which a host ends one time (DV-045).
export const ends = new WeakMap<object, Emit>(),
  // The aborts of the signals of component results, which run one time (JX-0C2).
  aborts = new WeakMap<object, () => void>();
/** Aborts the signal of a component result, which a second abort does not change. */
const abort = (source: unknown) => aborts.get(source as object)?.();
/** Tells devtools one time that a component result ended, and aborts its signal. */
export const end = (source: unknown) => {
  abort(source);
  ends.get(source as object)?.("end");
  ends.delete(source as object);
};

type Driving = { stop(): void; park(on: boolean): void };

/**
 * Drives dynamic entries with one select by key, so a move in the host never restarts a source.
 * Calls changed after a report in which apply changed the nodes of an entry (JX-023), done for each entry whose source finished, and over when no entry is left. */
export const drive = <E extends Driven>(
  owner: object,
  apply: (entry: E, state: Val<unknown>, parts: Parts) => unknown, // Tells if the nodes changed
  changed: () => void,
  autoClose: boolean,
  route: (error: unknown) => void, // Hands a failure to a boundary
  done?: (entry: E) => void,
  over: () => void = noop,
) => {
  const keyed = new Map<string, E>();
  let id = 0,
    parked = false,
    stopped = false,
    gate: PromiseWithResolvers<void> | undefined;
  // A drive that stopped shows nothing, so no boundary takes its failure (JX-094).
  const fail = (error: unknown) =>
    stopped ? reportError(error) : route(error);
  /** Gives the wait that a resume ends, while the drive is parked. */
  const held = () =>
    parked ? (gate ??= Promise.withResolvers()).promise : undefined;
  /** Lets each source go, which ends what its pulls opened (JX-041, DV-045). */
  const letGo = () => {
    for (const entry of keyed.values())
      end(entry.source), release(entry.source);
  };
  const sources = owned(owner, () =>
    select({} as Record<string, unknown>, {
      autoStart: true,
      autoClose,
      backPressure: false,
      [RETURNS]: true, // A removed entry ends its source (JX-035, JX-041)
      // A child that fails after its drive let it go, or in its return(), has no entry to report it (JX-089).
      // A stop error tells a source that it stopped, so it is no failure.
      [FAULT]: error => error instanceof StopError || reportError(error),
      [REPORT]: ops => {
        try {
          let moved = false;
          for (const op of ops) {
            const { key } = op as { key: string },
              entry = keyed.get(key),
              state = (op as { value: Val<unknown> }).value;
            if (!entry) continue;
            // A boundary can stop the drive in this report, so the rest only reports (JX-094).
            if (stopped) {
              if (state.status === "rejected") reportError(state.reason);
              continue;
            }
            if (apply(entry, state, parts)) moved = true;
            if (state.done) {
              end(entry.source);
              release(entry.source);
              // Stryker disable next-line ConditionalExpression: each marks a finished part, which it never renders again
              if (!(entry as Driven as Entry).in) done?.(entry);
              keyed.delete(key);
              // A boundary that stopped the drive in this report can have given its scope a new drive (JX-092).
              if (!keyed.size && !stopped) over();
            }
          }
          if (moved && !stopped) changed();
        } catch (error) {
          // The select has no consumer to get the error, so the drive hands it on, and SE-110 stops it (JX-088).
          fail(error);
          letGo();
          // A boundary that took the error stopped the drive, and can have given its scope a new drive (JX-092).
          if (!stopped) over();
          throw error;
        }
        // A parked drive applies the outputs that it has, and pulls no more until it resumes (JX-083).
        return held();
      },
    }),
  );
  /** Takes an entry and the parts that its outputs made out of the select, which returns their sources. */
  const quit = (entry: Entry) => {
    if (entry.pool) for (const part of entry.pool.values()) quit(part);
    entry.pool = undefined;
    keyed.delete(entry.key as string);
    delete sources[entry.key as string];
    entry.gate = undefined; // So a parked pull of the part never runs
    entry.ended = true;
    end(entry.source);
    release(entry.source); // JX-041
  };
  const add = (entry: Driven) => {
    // Stryker disable next-line UpdateOperator: keys only need to differ
    entry.key = `${id++}`;
    keyed.set(entry.key, entry as E);
    (entry.source as any)[ROUTE]?.(fail);
    sources[entry.key] = entry.via ?? entry.source;
  };
  const parts: Parts = { add, quit, fail, held };
  return {
    add: add as (entry: E) => void,
    remove: quit as unknown as (entry: E) => void,
    park(on: boolean) {
      parked = on;
      // Stryker disable next-line ConditionalExpression: a drive parks only while it runs, and a running drive has no gate
      if (!on) gate?.resolve(), (gate = undefined);
      // A part that left its output stays parked (JX-086).
      for (const entry of keyed.values())
        if (!(entry as Driven as Entry).gate) (entry.source as any)[PARK]?.(on);
    },
    stop() {
      stopped = true;
      sources[CHAN].close();
      letGo();
    },
  };
};

// The drives of a started element, and the scopes of the elements that started under it (JX-080).
// A scope is live while its top and the tops of the scopes above it are in the tree.
type Scope = {
  node: Node;
  up?: Scope; // The scope of the closest started element above, or of a mount
  top?: Node; // The child of the node of up that holds node, or node
  kids?: Set<Scope>;
  host?: Driving; // The drive of the children
  props?: Driving; // The drive of the dynamic props
  binds?: Set<Driving>; // The props that a shared derive gives with no drive (JX-067), and component aborts (JX-0C3)
  off?: boolean; // A place removed top
  live: boolean;
  guard?: true; // A boundary, which stays a scope (JX-091)
  fallback?: (error: unknown) => Child; // Of a boundary that takes no failure yet
};
const scopes = new WeakMap<Node, Scope>(),
  under = new WeakMap<Node, Set<Scope>>(); // The scopes that a top holds
// What starts when a runtime placement first reaches a node: a host (JX-02B), or the wait of use (JX-054).
export const waiting = new WeakMap<Node, () => void>(),
  binding = new WeakMap<Node, () => void>(), // The dynamic props, which start after the host (JX-061)
  stopping = new WeakMap<Node, () => void>(), // The aborts of components that gave the element (JX-0C3)
  guarding = new WeakMap<Node, () => void>(); // A boundary, which starts before what is inside it (JX-091)
type Wait = (() => void) & { ref: WeakRef<Node>; lost?: () => void };
// The nodes of the waits that are not started, so a placement walks no node when there is none.
const unstarted = new Set<WeakRef<Node>>();

/**
 * Makes start wait in map until a runtime placement reaches node, and records the node for a builder (HE-059).
 * The builder that ends the wait calls lost. */
export const defer = (
  map: WeakMap<Node, () => void>,
  node: Node,
  start: () => void,
  lost?: () => void,
) => {
  const ref = new WeakRef(node),
    wait = () => {
      settle(map, node);
      start();
    };
  unstarted.add(ref);
  map.set(node, Object.assign(wait, { ref, lost }));
  record(() => quit(node));
};
/** Ends the wait of node in map, if it has one. */
const settle = (map: WeakMap<Node, () => void>, node: Node) => {
  const wait = map.get(node) as Wait | undefined;
  if (wait) unstarted.delete(wait.ref);
  map.delete(node);
};
/**
 * Tells if a wait can still start, and forgets the waits of collected nodes.
 * A place then walks only the nodes that it adds, which code just built, so the walk costs a constant factor (scope.md). */
const waits = () => {
  for (const ref of unstarted) if (!ref.deref()) unstarted.delete(ref);
  return unstarted.size > 0;
};
/** Starts the waiting hosts and dynamic props in node and its descendants, in tree order. */
const wake = (node: Node) => {
  guarding.get(node)?.();
  waiting.get(node)?.();
  binding.get(node)?.();
  stopping.get(node)?.();
  for (let child = node.firstChild; child; child = child.nextSibling)
    wake(child);
};

/** Gives the parent of node, or the host of a shadow root (JX-02C). */
const above = (node: Node): Node | null =>
  node.parentNode ?? (node.nodeType === 11 ? (node as ShadowRoot).host : null);
/** Gives the scope at node or around it. */
const around = (node: Node) => {
  for (let at: Node | null = node; at; at = above(at)) {
    const scope = scopes.get(at);
    if (scope) return scope;
  }
};

/** Gives the scope of node, and binds a new scope to the closest scope above it. */
const enter = (node: Node): Scope => {
  let scope = scopes.get(node);
  if (scope) return scope;
  scope = { node, live: true };
  scopes.set(node, scope);
  for (let top = node, at = above(node); at; top = at, at = above(at)) {
    const up = scopes.get(at);
    if (!up) continue;
    Object.assign(scope, { up, top, live: up.live });
    (up.kids ??= new Set()).add(scope);
    under.get(top)?.add(scope) ?? under.set(top, new Set([scope]));
    break;
  }
  return scope;
};
/** Takes a scope out of the scope above it. */
const leave = (scope: Scope) => {
  scopes.delete(scope.node);
  if (scope.up) (scope.up.kids as Set<Scope>).delete(scope);
  under.get(scope.top as Node)?.delete(scope);
};
/** Stops the drive of the children of a scope, and each scope under it. */
const clear = (scope: Scope) => {
  scope.host?.stop();
  scope.host = undefined;
  if (scope.kids) for (const kid of scope.kids) stop(kid);
};
/** Stops the drives of a scope and of each scope under it, for good. */
const stop = (scope: Scope) => {
  clear(scope);
  scope.props?.stop();
  scope.props = undefined;
  if (scope.binds) for (const bound of scope.binds) bound.stop();
  scope.binds = undefined;
  leave(scope);
};
/** Takes out a scope that drives nothing and holds no scope, and then the scopes above that it leaves empty. */
const tidy = (scope: Scope) => {
  if (
    scope.host ||
    scope.props ||
    scope.binds?.size ||
    scope.kids?.size ||
    !scope.up ||
    scope.guard
  )
    return;
  leave(scope);
  tidy(scope.up);
};
/** Parks or resumes the drives of a scope and of the scopes under it that are not off (JX-083). */
const sync = (scope: Scope, live: boolean) => {
  // Stryker disable next-line ConditionalExpression: a park or a resume of a drive in that state changes nothing
  if (scope.live === live) return;
  scope.live = live;
  scope.host?.park(!live);
  scope.props?.park(!live);
  if (scope.binds) for (const bound of scope.binds) bound.park(!live);
  if (scope.kids) for (const kid of scope.kids) sync(kid, live && !kid.off);
};
/** Parks the scopes that node holds when a place removes it, and resumes them when a place adds it again. */
const shift = (node: Node, off: boolean) => {
  const held = under.get(node);
  if (held)
    for (const scope of held) {
      scope.off = off;
      sync(scope, !off && (scope.up as Scope).live);
    }
};
/** Starts a drive of node in its scope, parked if the scope is not live. */
const driveIn = <D extends Driving>(
  node: Node,
  slot: "host" | "props",
  make: (scope: Scope, over: () => void) => D,
): D => {
  const scope = enter(node),
    driving = make(scope, () => {
      scope[slot] = undefined;
      tidy(scope);
    });
  scope[slot] = driving;
  if (!scope.live) driving.park(true);
  return driving;
};

/** Tells if node holds a scope, so its owner keeps it to stop it later. */
export const holds = (node: Node) => !!under.get(node)?.size;
/** Stops the scopes that node holds (JX-035). */
export const stopIn = (node: Node) => under.get(node)?.forEach(stop);
/** Ends the waits of node and stops its scope, for the builder that owns it (HE-059). */
const quit = (node: Node) => {
  (waiting.get(node) as Wait | undefined)?.lost?.();
  outlast(node);
  settle(guarding, node);
  settle(waiting, node);
  settle(binding, node);
  const scope = scopes.get(node);
  if (scope) stop(scope);
};
/** Stops the drive of the children of node and each scope under it (JX-02A). */
export const unmount = (node: Node) => {
  const scope = scopes.get(node);
  if (scope) clear(scope);
};
/** Places the entries of a host, resumes the nodes that come back, and wakes the nodes that were not its children (JX-02B). */
const settleIn = (parent: Parent, entries: Entry[], scope: Scope) => {
  const added = place(parent, entries);
  for (const node of added) shift(node, false);
  if (scope.live && waits()) added.forEach(wake);
};

/** Makes element a boundary when a runtime placement first reaches it (JX-091). */
export const guard = (element: Element, fallback: (error: unknown) => Child) =>
  defer(guarding, element, () => {
    Object.assign(enter(element), { guard: true, fallback });
  });

/** Hands a failure to the nearest armed boundary at or above scope, which shows its fallback, or reports it (JX-092, JX-093). */
const failIn = (scope: Scope | undefined, error: unknown) => {
  for (let at = scope; at; at = at.up) {
    const { fallback } = at;
    if (!fallback) continue;
    at.fallback = undefined; // A boundary takes one failure, so a failure of its fallback goes up
    clear(at);
    try {
      attach(at.node as Element, fallback(error), true);
    } catch (thrown) {
      failIn(at, thrown);
    }
    return;
  }
  reportError(error);
};

/** Applies an output of a dynamic prop to its element, and changes no node (JX-062 to JX-065). */
const applyProp = (
  element: Element,
  entry: Prop,
  state: Val<unknown>,
  fail: (error: unknown) => void,
) => {
  const { value } = state,
    name = entry.name as string;
  if (state.status === "rejected") fail(state.reason);
  else if (!Object.is(value, entry.value))
    try {
      const values = held.get(element);
      // A custom element of a tag with no definition holds the output, unless the key is never own (JX-0B2).
      if (values && !(name in HTMLElement.prototype)) values.set(name, value);
      else put(element, name, value);
      entry.value = value;
    } catch (error) {
      fail(error);
    }
};

/**
 * Makes the dynamic props of an element wait until the runtime places it, and then drives them (JX-061).
 * A derive with a shared source gives its outputs to the prop with no drive (JX-067). */
export const bind = (element: Element, props: [string, unknown][]) =>
  defer(binding, element, () => {
    const driven = props.filter(([, source]) => !(source as any)[BIND]);
    for (const [name, source] of props) {
      const attach = (source as any)[BIND];
      if (!attach) continue;
      const scope = enter(element),
        entry: Prop = { name, source },
        binds = (scope.binds ??= new Set()),
        fail = (error: unknown) => failIn(scope, error);
      const bound: Driving = attach(
        {
          value: (value: unknown) =>
            applyProp(
              element,
              entry,
              { status: "fulfilled", value } as any,
              fail,
            ),
          fail,
        },
        !scope.live,
      );
      binds.add(bound);
    }
    if (!driven.length) return;
    const host = driveIn(element, "props", (scope, over) =>
      drive(
        element,
        (entry: Prop, state, parts) =>
          applyProp(element, entry, state, parts.fail),
        noop,
        true,
        error => failIn(scope, error),
        undefined,
        over,
      ),
    );
    for (const [name, source] of driven) host.add({ name, source });
  });

// The aborts of the components that gave an element, until its scope stops (JX-0C3).
const outlived = new WeakMap<Element, Set<() => void>>();
/** Aborts when the scope of element stops, or when a builder stops element before a placement reaches it. */
export const outlive = (element: Element, abort: () => void) => {
  const set = outlived.get(element);
  if (set) return void set.add(abort);
  outlived.set(element, new Set([abort]));
  defer(stopping, element, () => {
    const stop = () => outlast(element);
    (enter(element).binds ??= new Set()).add({ stop, park: noop });
  });
};
/** Runs the aborts of node, so a later component that gives node waits for a new place. */
const outlast = (node: Node) => {
  const all = outlived.get(node as Element);
  outlived.delete(node as Element);
  // Stryker disable next-line CallExpression: a wait that stays only makes a place abort aborted signals again
  settle(stopping, node);
  if (all) for (const each of all) each();
};

/**
 * Makes parent a host for children, with static runs and dynamic entries in order.
 * mount and jsx both call it, so the hook finds their caller at one depth (DV-003). */
export const attach = (parent: Parent, children: Child, placed: boolean) => {
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
    guarding.get(parent)?.(); // A mount into a boundary keeps it a boundary
    settle(waiting, parent);
    const scope = enter(parent);
    clear(scope);
    settleIn(parent, entries, scope);
  }
  // A new element has no child and no host, so its nodes land in order with no placement.
  else
    for (const entry of entries)
      chunked(entry.nodes, part => parent.append(...part));
  if (!dynamic.length) return;
  register("mount", parent, {});
  const start = () => {
    const host = driveIn(parent, "host", (scope, over) =>
      drive(
        parent,
        applyOutput,
        () => settleIn(parent, entries, scope),
        true,
        error => failIn(scope, error),
        undefined,
        over,
      ),
    );
    for (const entry of dynamic) host.add(entry);
  };
  if (placed) start();
  else defer(waiting, parent, start);
};
