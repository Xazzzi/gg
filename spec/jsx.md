# JSX

This document uses `Channel` from `channel.md`, `select`, `changes`, `State` and `Val` from `select.md`, and `applyOps` from `helpers.md`.
The key words MUST, MUST NOT, SHOULD and MAY are normative.

## Purpose

The JSX runtime builds DOM nodes from JSX, with no virtual DOM and no diff.
A component is a function.
An async generator function gives a component instance for each use.
The instance yields its node, and then changes the nodes that it owns.
It yields again only when its host must know about it.
`select` drives the instances, and `each` replays lists from `changes` with `applyOps`.
So components compose with the same primitives as app state.

The package root exports the runtime, and the `@xazzzi/gg/jsx-runtime` entry exports it for the JSX transform.
A bundler drops it from code that does not use it.
Set `"jsx": "react-jsx"` and `"jsxImportSource": "@xazzzi/gg"` to use it.

## Public API

```ts
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

export function jsx(
  type: string | ((props: any) => Child),
  props: Props,
  key?: unknown,
): Child;
export const jsxs: typeof jsx;
export const jsxDEV: typeof jsx;
export function Fragment(props: { children?: Child }): DocumentFragment;
export function mount(parent: Element, ...children: Child[]): () => void;
export type Item<T> = AsyncIterable<T> & {
  readonly value: T;
  readonly signal: AbortSignal;
};
export function each<T>(
  state: State<readonly unknown[], any, T[]>,
  render: (item: Item<T>) => Child,
): AsyncGenerator<Node[], void, void>;
export type Context<T> = { readonly [VALUE]?: T }; // VALUE is a type-only symbol
export const createContext: <T>(key: unknown) => Context<T>;
export function Provide<T>(props: {
  context: Context<T>;
  value: T;
  children?: Child;
}): Element;
export function consume<T>(node: Node, context: Context<T>): T;
export function use<T>(context: Context<T>): AsyncGenerator<Comment, T, unknown>;

export declare namespace JSX {
  type Element = Child;
  interface IntrinsicElements {
    [tag: string]: Props;
  }
  interface ElementChildrenAttribute {
    children: unknown;
  }
}
```

A JSX expression has the type `Child`.
An async iterable child can produce any `Child` in its type, so a component yields JSX with no cast.
A dynamic value in an output still fails at runtime (JX-027, JX-028).
Cast an element to its DOM type, such as `<input /> as HTMLInputElement`.
The runtime uses the global `document` when it creates nodes.

## Terms

- **Dynamic child**: a value with a callable `then`, or with a callable `Symbol.asyncIterator`.
- **Static child**: any other child.
- **Host**: an element whose children the runtime owns.
- **Entry**: one part of a host, with the nodes that the part has now.
  A host keeps its entries in order.
- **Output**: the last value that the source of a dynamic entry produced.
- **Place**: put the nodes of all entries into the host in order, and remove all other children of the host.
- **Text value**: a string, a number or a bigint.
- **SVG tag**: `svg`, `g`, `defs`, `symbol`, `use`, `image`, `switch`, `foreignObject`, `desc`, `metadata`, `path`, `rect`, `circle`, `ellipse`, `line`, `polyline`, `polygon`, `text`, `tspan`, `textPath`, `linearGradient`, `radialGradient`, `stop`, `pattern`, `clipPath`, `mask`, `marker`, `filter`, `view`, `animate`, `animateMotion`, `animateTransform`, `set` or `mpath`, or a tag that starts with `fe` and an upper case letter.
- **Live property**: `value`, `checked`, `selected`, `indeterminate` or `muted`.
  Its attribute sets only the initial state, or it has no attribute.

## Elements

- JX-001: `jsx` with a string `type` MUST create an element, and return it.
  If `props.xmlns` is a string, it MUST use `document.createElementNS(props.xmlns, type)`.
  Otherwise, for an SVG tag, it MUST use `document.createElementNS("http://www.w3.org/2000/svg", type)`.
  Otherwise, it MUST use `document.createElement(type)`.
  JSX creates children before their parent, so the namespace of a parent cannot apply to its children.
  So `a`, `script`, `style` and `title`, which are also HTML tags, need `xmlns` inside an SVG element.
- JX-002: For each own enumerable key of `props` other than `children`, `jsx` MUST apply the value in key order.
  A function value at a key that starts with `on` MUST become a listener, with `addEventListener`.
  The event type is the rest of the key in lower case.
  `null`, `undefined` and `false` MUST set nothing.
  Another value at a live property MUST be assigned to the property of the element, after JX-003 mounts the children.
  So a `<select value>` finds its options.
  `true` MUST set the attribute to `""`.
  Other values MUST set the attribute to `String(value)`.
- JX-003: `jsx` MUST mount `props.children` into the element, as `mount` does, except that the element waits to drive its dynamic children (JX-02B).
- JX-004: `jsx` MUST ignore `key`.
- JX-005: `jsx` with a function `type` MUST return `type(props)` unchanged.
  So a call of an async generator function gives one instance for each use.
- JX-006: `jsxs` and `jsxDEV` MUST be `jsx`.
- JX-007: `Fragment` MUST return a new `DocumentFragment` with the nodes of its children.
  A dynamic child in a `Fragment` MUST throw a `TypeError`.

## Children

The runtime converts a child to nodes by these rules, in order.

- JX-010: An array MUST convert each item in order, at any depth.
- JX-011: A dynamic child MUST become an entry, if the place permits it.
  Otherwise it MUST throw a `TypeError`.
- JX-012: A value with a `nodeType` of type number is a node.
  A `DocumentFragment` MUST give its child nodes at the time of the conversion.
  Another node MUST give itself.
- JX-013: A text value MUST give a new `Text` node with the data `String(value)`.
- JX-014: `null`, `undefined` and booleans MUST give no node.
- JX-015: Any other value MUST throw a `TypeError`.
- JX-016: A conversion that throws MUST change nothing.

## Mount

- JX-020: `mount` MUST make `parent` a host for `children`.
  If `parent` is a host already, `mount` MUST stop its drive first, after the conversion.
  Each dynamic child is one entry.
  The static nodes between two dynamic children are one entry.
- JX-021: `mount` MUST place the static nodes synchronously.
- JX-022: `mount` MUST drive the dynamic children with one `select`, with `autoStart`, `nonYielding` and `autoClose`.
  So the children start in a microtask (SE-031), and the host does no more work when they all finish (SE-070).
  `mount` does no `select` call if there is no dynamic child.
- JX-023: The runtime MUST place after each report of that `select`.
- JX-024: A pending state MUST keep the nodes of the entry.
- JX-025: An output that is the `Object.is` same as the previous output MUST keep the nodes.
  So a component yields its node again to wake a host with no change to the DOM.
- JX-026: A text value output MUST change the `data` of the entry's `Text` node, if the runtime made that node for the previous output.
- JX-027: Another output MUST replace the nodes of the entry with the conversion of the output.
  A dynamic child in an output is not permitted (JX-011).
- JX-028: A rejected state MUST call `globalThis.reportError` with the reason.
  A conversion error MUST call `globalThis.reportError` with that error.
  The entry MUST keep its nodes.
  The other entries continue.
- JX-029: To place, the runtime MUST NOT move a node that stays in order.
  It MUST move only the nodes outside one longest run of nodes that keep their order, so a swap moves two nodes.
  It MUST remove a node that leaves the host, and MUST NOT move the nodes after it.
  A node that two entries give MUST land at its last place.
- JX-02A: `mount` MUST return an unmount function.
  Its first call MUST stop the drive of each host in `parent` and its descendants at the time of the call, and then remove all children of `parent`.
  Its later calls MUST do nothing.
  To stop a drive, the runtime closes its `select`, so each unfinished child gets `return()` (SE-120).
- JX-02B: An element that `jsx` creates with a dynamic child MUST wait, and MUST NOT create its `select` until the runtime places it.
  The runtime places nodes when `mount` places its children, and when a started host places nodes that were not its children.
  For each node that it places, the runtime MUST start each waiting element in the node and its descendants, in tree order.
  An element MUST start one time.
  `mount` into a waiting element MUST end its wait, so its earlier children never start.
  So an element starts only when its ancestors are in place, and an element that is never placed costs no `select`.

## Each

`each` is a dynamic child that renders one entry for each item of a `select` with an array shape.
It reads the changes of that `select`, and gives each new value of an item to the `Item` of that item.
An `Item` has the current value, and makes a channel only when code iterates it.
So a component instance updates its own nodes, and the host moves only nodes that change place.
A component instance that finishes renders again with the next value of its item, so a component can read its item once.
`each` owns only the nodes of its entries, so the other children of its host keep their nodes.

- JX-030: `each` MUST throw a `TypeError` synchronously if `state` is not a `select` proxy with an array shape, or if `render` is not a function.
  It MUST return an async generator, and MUST NOT call `changes` before the first `next()`.
- JX-031: The first `next()` MUST call `changes(state)`, make one entry for each item of `outputs`, and yield the nodes of all entries in order.
- JX-032: For a new item, `each` MUST create an `Item` with the value, and call `render` with it.
  The result of `render` is the child of the entry.
  It MUST be a static child, or one dynamic child.
- JX-033: `each` MUST replay each read onto its mirror of entries with `applyOps`.
  So an item that leaves and comes back in one read keeps its entry, its `Item` and its instance (HE-04H).
- JX-034: For an item that keeps its entry, `each` MUST give the new value to the `Item` of that entry.
  The `Item` MUST set `value`, and then send the value to its channel, if it has one.
  It MUST NOT call `render`, unless JX-03C applies.
- JX-035: For an item that leaves the mirror, `each` MUST end its `Item` and stop the drive of its child.
  To end an `Item`, `each` MUST close its channel if it has one, and abort its `signal`.
- JX-036: `each` MUST drive the dynamic children of its entries with one `select`, with `autoStart`, `nonYielding` and no `autoClose`.
  JX-024 to JX-028 apply.
- JX-037: When the nodes of its entries changed after its last yield, `each` MUST yield a new array of the nodes of all entries in order.
  A read with only `set` operations changes no node of `each` itself.
  `each` MUST NOT yield while no node changed.
  So a host that is busy gets one output for all changes since its last pull.
- JX-038: `each` MUST NOT change a node outside its entries.
  JX-029 keeps the order of the other children of its host.
- JX-039: When the reader finishes, `each` MUST end the `Item` of each entry, stop its drive and finish.
  The host keeps the last nodes of `each` (SE-024).
  If the reader rejects, `each` MUST do the same, and then reject with the unchanged error.
- JX-03A: An error from `render` or from `applyOps` MUST end `each` as a rejection of the reader does.
  `each` MUST finish its reader first.
- JX-03B: `return()` on the generator MUST finish the reader, end the `Item` of each entry and stop the drive.
  It MUST do so also while a `next()` is pending, which then resolves with `{ done: true, value: undefined }`.
  So a host that stops ends its `each` children at once.
- JX-03C: When the dynamic child of an entry finishes and the item stays, `each` MUST render the item again.
  It MUST end the `Item` of the entry, and call `render` with a new `Item` as JX-032 does.
  It MUST do so at once if it gave a value to the `Item` after the last `render`, and at the next value of the item otherwise.
  The entry keeps its nodes until the new child gives an output (JX-024).
  A rejected child also finishes.
- JX-03D: `value` MUST give the last value that `each` gave the `Item`.
  It keeps that value after the `Item` ends.
- JX-03E: `signal` MUST give one `AbortSignal`, which aborts with no reason when the `Item` ends.
- JX-03F: The first iteration of an `Item` MUST create a `Channel` with `firstReceive: "latest"` and `thenReceive: "latest"`, send `value`, and close it if the `Item` ended.
  Each iteration MUST give a reader of that one channel.
  So a component that never iterates its `Item` costs no channel.

## Context

A context gives a value to the components inside a provider, so components need no module-level state, and a test provides a fake.
JSX creates a child before its parent, so a component can ask only after the runtime places its node.
The runtime uses the `context-request` event of the community context protocol of web components.
So providers and consumers of other libraries that follow it work with it.
A context value does not change, so the runtime asks without `subscribe`.
Provide a `Channel` or a `select` for a value that changes.

- JX-050: `createContext(key)` MUST return `key`.
  So contexts compare by identity, and two libraries that share a key share the context.
- JX-051: `Provide` MUST throw a `TypeError` if `children` is not one element.
  Otherwise it MUST add a `"context-request"` listener to that element, and return the element.
- JX-052: The listener MUST ignore an event whose `context` is not the same as the provided context.
  Otherwise it MUST stop the propagation of the event, and call `event.callback(value)`.
  So the nearest provider of a context answers.
- JX-053: `consume(node, context)` MUST dispatch an `Event` of type `"context-request"` with `bubbles` and `composed` at `node`.
  The event MUST have `context`, `contextTarget` set to `node`, `subscribe` set to `false`, and `callback`.
  `consume` MUST return the value of the first `callback` call.
  If no call happened during the dispatch, it MUST throw a `TypeError`.
  So an event handler, which runs when its element is in place, can call `consume(event.currentTarget, context)`.
- JX-054: `use(context)` MUST return an async generator that yields one new empty `Comment`, waits until the runtime places that comment (JX-02B), and returns `consume(comment, context)`.
  So `const value = yield* use(context)` in a component yields a placeholder, and the next yield of the component replaces it (JX-027).
  A component in an element that the runtime never places waits.

## Limits

- JX-040: The runtime does not end a dynamic child when its nodes leave the host.
  A dynamic child ends when its source finishes, or when its host stops (JX-02A).
  So close the channels that a component reads to end the component, as `each` does.
  In `each`, a child that finishes renders again (JX-03C).
- JX-041: An async generator queues `return()` behind a pending `next()`.
  So a component that waits on an open channel ends only when that channel closes, or at its next `yield`.
  This holds when its host stops too, but not for `each` (JX-03B).
- JX-042: A node in the entries of two hosts, or in two entries of one host, has no defined position.
- JX-043: The children of a host belong to the runtime.
  A place removes nodes that other code adds.
  Code can change the attributes and the content of the nodes in an entry.
- JX-044: `jsx` assigns a live property one time, so it does not apply to options that a dynamic child adds later.
  It assigns the value as it is, so a `value` on a file input throws, as the DOM does.
- JX-045: Other code that inserts a waiting element, for example with `append`, does not start it (JX-02B).
  Yield the element or make it a child, so that a host places it.

## Example

```tsx
import { Channel } from "@xazzzi/gg";

async function* Counter({ count }: { count: Channel<number> }) {
  const value = (<b>0</b>) as HTMLElement;
  yield <p>Clicks: {value}</p>;
  for await (const n of count) value.textContent = `${n}`;
}

const count = new Channel<number>({
  firstReceive: "latest",
  thenReceive: "latest",
});
mount(document.body, <Counter count={count} />);
count.send(1);
```

A list beside static siblings:

```tsx
import { type Channel, select } from "@xazzzi/gg";

async function* Item({ name }: { name: Channel<string> }) {
  const li = (<li />) as HTMLElement;
  yield li;
  for await (const value of name) li.textContent = value;
}

const names = select(["ann", "bob"], {
  autoStart: true,
  autoClose: false,
  nonYielding: true,
});
mount(
  document.body,
  <ul>
    <li>first</li>
    {each(names, name => (
      <Item name={name} />
    ))}
    <li>last</li>
  </ul>,
);
names.reverse(); // Moves two nodes, and keeps "first" and "last" in place
```
