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
export function Fragment(props: { children?: Static }): DocumentFragment;
export function Fragment(props: { children?: Child }): Child;
export function mount(
  parent: Element | ShadowRoot,
  ...children: Child[]
): () => void;
export type Item<T> = AsyncIterable<T> & {
  readonly value: T;
  readonly signal: AbortSignal;
};
export type EachOptions<T> = { key?: (value: T) => unknown };
export function each<T>(
  state: State<readonly unknown[], any, T[]>,
  render: (item: Item<T>) => Child,
  options?: EachOptions<T>,
): AsyncGenerator<Node[], void, void>;
export type Context<T> = { readonly [VALUE]?: T }; // VALUE is a type-only symbol
export const createContext: <T>(key: unknown) => Context<T>;
export function Provide<T>(props: {
  context: Context<T>;
  value: T;
  children?: Child;
}): Element;
export function consume<T>(node: Node, context: Context<T>): T;
export function Catch(props: {
  fallback: (error: unknown) => Child;
  children?: Child;
}): Element;
export function use<T>(context: Context<T>): AsyncGenerator<Comment, T, unknown>;

export declare namespace JSX {
  type Element = Child;
  interface IntrinsicElements extends Known {
    [tag: string]: Props;
  }
  interface ElementChildrenAttribute {
    children: unknown;
  }
}
```

`Known` gives each HTML and SVG tag name the props of its element type.
A listener at an `on` key of a DOM event takes that event, with the element as its `currentTarget`.
A live property takes the type of that property of the element, or a number.
`class`, `id`, `title` and `hidden` take a text value or a boolean, and `style` takes a string.
Each of these props also takes `null`, `undefined` and a dynamic value.
A custom element tag of `HTMLElementTagNameMap` also takes each own property of its element type, with the type of that property, or a dynamic value of it.
Any other prop, and any prop of another tag, takes any value.
A JSX expression has the type `Child`.
An async iterable child can produce any `Child` in its type, so a component yields JSX with no cast.
A dynamic child in an output becomes a part of its entry (JX-085).
The type of a promise child permits only a static child, because a recursive type has no `await`.
Cast an element to its DOM type, such as `<input /> as HTMLInputElement`.
The runtime uses the global `document` when it creates nodes.

## Terms

- **Dynamic child**: a value with a callable `then`, or with a callable `Symbol.asyncIterator`.
- **Static child**: any other child.
- **Dynamic prop**: a prop other than `children` with a dynamic value.
- **Host**: an element whose children the runtime owns.
- **Entry**: one part of a host, with the nodes that the part has now.
  A host keeps its entries in order.
- **Output**: the last value that the source of a dynamic entry produced.
- **Part**: a dynamic child in an output, which the host of the entry drives.
- **Scope**: a `mount`, or a started element, with the elements that started under it.
- **Boundary**: an element that `Catch` returns, which takes the failures of the scopes under it (JX-090).
- **Failure**: an error that JX-028, JX-065, JX-087 or JX-088 reports for a drive.
  The scope of a failure is the scope of that drive.
  The drive of an `each` belongs to the scope of the host that drives the `each`.
- **Park**: pull a source no more, and not return it.
  A parked drive resumes.
- **Stop**: close the `select` of a drive, so each unfinished source gets `return()`.
  A stopped drive does not resume.
- **Place**: put the nodes of all entries into the host in order, and remove all other children of the host.
- **Text value**: a string, a number or a bigint.
- **SVG tag**: `svg`, `g`, `defs`, `symbol`, `use`, `image`, `switch`, `foreignObject`, `desc`, `metadata`, `path`, `rect`, `circle`, `ellipse`, `line`, `polyline`, `polygon`, `text`, `tspan`, `textPath`, `linearGradient`, `radialGradient`, `stop`, `pattern`, `clipPath`, `mask`, `marker`, `filter`, `view`, `animate`, `animateMotion`, `animateTransform`, `set` or `mpath`, or a tag that starts with `fe` and an upper case letter.
- **Live property**: `value`, `checked`, `selected`, `indeterminate` or `muted`.
  Its attribute sets only the initial state, or it has no attribute.
- **Custom element**: an element that `document.createElement` creates for a tag with a `-`, while `globalThis.customElements` exists.
- **Own property**: a property that a custom element has, and that `HTMLElement.prototype` does not have.

## Elements

- JX-001: `jsx` with a string `type` MUST create an element, and return it.
  If `props.xmlns` is a string, it MUST use `document.createElementNS(props.xmlns, type)`.
  Otherwise, for an SVG tag, it MUST use `document.createElementNS("http://www.w3.org/2000/svg", type)`.
  Otherwise, it MUST use `document.createElement(type)`.
  JSX creates children before their parent, so the namespace of a parent cannot apply to its children.
  So `a`, `script`, `style` and `title`, which are also HTML tags, need `xmlns` inside an SVG element.
- JX-002: For each own enumerable key of `props` other than `children`, `jsx` MUST apply the value in key order.
  A dynamic value makes a dynamic prop (JX-060).
  A function value at a key that starts with `on` MUST become a listener, with `addEventListener`.
  If the element has a property at the key in lower case, such as `onclick`, the event type is the rest of the key in lower case.
  Otherwise the event type is the rest of the key as it is.
  So `onClick` listens to `click`, and `onitemSelected` listens to `itemSelected`, which a web component can dispatch.
  `null`, `undefined` and `false` MUST set nothing.
  Another value at a live property, or at an own property (JX-0B0), MUST be assigned to the property of the element, after JX-003 mounts the children.
  So a `<select value>` finds its options.
  `true` MUST set the attribute to `""`.
  An object whose `toString` is `Object.prototype.toString` MUST throw a `TypeError`, because it has no text of its own.
  So `style` takes a string, and not an object.
  A function MUST throw a `TypeError`, because its text is its source code.
  Other values MUST set the attribute to `String(value)`.
  So an array sets its items with commas between them, as `accept` and `srcset` need, and as `setAttribute` does.
- JX-003: `jsx` MUST mount `props.children` into the element, as `mount` does, except that the element waits to drive its dynamic children (JX-02B).
- JX-004: `jsx` MUST ignore `key`.
- JX-005: `jsx` with a function `type` MUST return `type(props)` unchanged.
  So a call of an async generator function gives one instance for each use.
- JX-006: `jsxs` and `jsxDEV` MUST be `jsx`.
- JX-007: `Fragment` MUST return a new `DocumentFragment` with the nodes of its children, if no child is dynamic.
  With a dynamic child, at any depth of its arrays, `Fragment` MUST return `props.children` unchanged.
  So the host that gets those children drives them (JX-020).

- JX-008: A value at a key that starts with `on` MUST throw a `TypeError`, unless it is a function, `null`, `undefined` or `false`.
  An event attribute runs its text as code, so a text value from data would run that data.
  JX-060 does the same for a dynamic value.
- JX-009: At `href`, `src`, `action`, `formaction` and `xlink:href`, in any case, a text that has the `javascript:` scheme MUST throw a `TypeError`.
  The check reads the text as the URL parser does: it skips leading C0 controls and spaces, and it skips tabs and newlines.
  A link from data then cannot run code when the user clicks it.
  A dynamic prop reports the error (JX-065).
- JX-00A: A static prop that JX-002, JX-008 or JX-009 rejects MUST throw before the element takes its children.
  So the children of a `jsx` call that throws stay where they were.

## Custom elements

A web component takes data through its properties, and an attribute takes only text.
So the runtime assigns the properties that the class of a custom element defines, and JSX needs no syntax for them.

- JX-0B0: At an own property of a custom element, JX-002 and JX-063 MUST assign the value to the property.
  Another key follows JX-002 and JX-064, so `id`, `class`, `slot`, `style`, `aria-*` and `data-*` stay attributes.
- JX-0B1: Each property that `HTMLElement.prototype` has, also from its prototypes, is not an own property.
  So data cannot reach `innerHTML`, `outerHTML`, `textContent` or an `on` property, and JX-008 and JX-009 stay true.
  What a class does with its own properties is the concern of that class.
- JX-0B2: If the tag of a custom element has no definition when `jsx` creates it, the runtime MUST hold each value of its props other than `children` and the `on` keys.
  When `customElements.whenDefined` resolves for the tag, the runtime MUST call `customElements.upgrade` on the element, and then apply the held values in key order.
  A dynamic prop holds its last output, which applies as JX-063 or JX-064 says.
  If `whenDefined` rejects, the runtime MUST apply the held values as for an element that is not a custom element.
  So a prop gives the same result, whether the definition comes before or after the element.
- JX-0B3: A hold MUST NOT delay the children, the listeners, the start (JX-02B), the drives or the stop of the element.
  Only the writes of the held values wait.
- JX-0B4: A hold MUST NOT retain the element.
  So an element of a tag that has no definition yet can be collected.
- JX-0B5: An error that a held value throws when it applies MUST go to the boundary of the closest scope at or around the element (JX-092), or to `globalThis.reportError` if no boundary takes it.
  The other held values continue.

## Children

The runtime converts a child to nodes by these rules, in order.

- JX-010: An array MUST convert each item in order, at any depth.
- JX-011: A dynamic child MUST become an entry in the children of a host, and a part in an output (JX-085).
  In a static `Fragment` and in a static result of `render`, it MUST throw a `TypeError`.
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
- JX-022: `mount` MUST drive the dynamic children with one `select`, with `autoStart`, `autoClose` and no `backPressure`.
  So the children start in a microtask (SE-031), and the host does no more work when they all finish (SE-070).
  `mount` does no `select` call if there is no dynamic child.
- JX-023: The runtime MUST place after each report of that `select` that changes the nodes of an entry.
  So an output that keeps the nodes costs no place.
- JX-024: A pending state MUST keep the nodes of the entry.
- JX-025: An output that is the `Object.is` same as the previous output MUST keep the nodes.
  So a component yields its node again to wake a host with no change to the DOM.
- JX-026: A text value output MUST change the `data` of the entry's `Text` node, if the runtime made that node for the previous output.
- JX-027: Another output MUST replace the nodes of the entry with the conversion of the output.
  A dynamic child in an output becomes a part (JX-085).
- JX-028: A rejected state MUST call `globalThis.reportError` with the reason.
  A conversion error MUST call `globalThis.reportError` with that error.
  The entry MUST keep its nodes.
  The other entries continue.
- JX-088: If a drive throws while it applies a report, the runtime MUST call `globalThis.reportError` with that error, and the drive MUST stop (SE-110).
  For example, a place throws for a node that holds its host, and the start of a waiting element can throw.
  The select of a drive has no consumer, so without this rule no code gets the error.
  The nodes stay as they are, and the scopes under the host continue.
- JX-08A: The select of each drive MUST have the return flag (SE-128).
  So a drive that removes an entry calls `return()` on the iterator of its source, and on the iterators of its parts (JX-035, JX-041).
- JX-089: The select of each drive MUST have a fault hook that calls `globalThis.reportError` (SE-127).
  So a child that fails after its drive removed or stopped it, and a `return()` that fails when a drive stops, report the error.
- JX-029: To place, the runtime MUST NOT move a node that stays in order.
  It MUST move only the nodes outside one longest run of nodes that keep their order, so a swap moves two nodes.
  It MUST remove a node that leaves the host, and MUST NOT move the nodes after it.
  A node that two entries give MUST land at its last place.
- JX-02A: `mount` MUST return an unmount function.
  Its first call MUST stop the drive of `parent`, and each scope under the scope of `parent` (JX-081), and then remove all children of `parent`.
  So it stops each element that started under `parent`, also one that is not in the tree at the time of the call.
  Its later calls MUST do nothing.
  To stop a drive, the runtime closes its `select`, so each unfinished child gets `return()` (SE-120).
- JX-02C: `mount` MUST accept a `ShadowRoot` as `parent`.
  To find the scope above a node (JX-080), the runtime MUST continue from the `host` of a `ShadowRoot`.
  So a mount in the shadow root of an element stops with the scope that holds the element.
- JX-02B: An element that `jsx` creates with a dynamic child MUST wait, and MUST NOT create its `select` until the runtime places it.
  The runtime places nodes when `mount` places its children, and when a started host places nodes that were not its children.
  For each node that it places, the runtime MUST start each waiting element in the node and its descendants, in tree order.
  An element MUST start one time.
  `mount` into a waiting element MUST end its wait, so its earlier children never start.
  So an element starts only when its ancestors are in place, and an element that is never placed costs no `select`.

## Dynamic props

A dynamic prop changes with its source, so a component needs no code to update an attribute or a live property.

- JX-060: A dynamic prop at a key that starts with `on` MUST throw a `TypeError`, because an event attribute runs its value as code.
- JX-061: An element with a dynamic prop MUST wait as JX-02B says, and MUST then drive its dynamic props with one `select`, with `autoStart`, `autoClose` and no `backPressure`.
  The element MUST start its children before its dynamic props.
  This `select` is apart from the drive of the children, so `mount` into the element keeps its dynamic props (JX-020).
- JX-062: A pending state, and an output that is the `Object.is` same as the last applied output, MUST change nothing.
  A new dynamic prop has `undefined` as its last applied output.
- JX-063: An output at a live property, or at an own property (JX-0B0), MUST be assigned to the property of the element as it is.
- JX-064: Another output MUST set the attribute as JX-002 does, except that `null`, `undefined` and `false` MUST remove the attribute.
- JX-065: A rejected state, and an error that applying an output throws, MUST call `globalThis.reportError`.
  The element keeps its attribute or property, and the other dynamic props continue.
- JX-066: A dynamic prop MUST keep its last output when its source finishes.
  It stops when the scope of the element stops (JX-081).
- JX-067: A dynamic prop whose source is a `derive` with a shared reader (HE-05A) MUST NOT get a drive.
  The runtime MUST bind it to the shared reader instead, under the scope of the element.
  A binding MUST map each value and apply the output as JX-062 to JX-066 say, and hand a failure to the boundary (JX-092).
  A parked binding MUST NOT map, and MUST map the newest value when it resumes (JX-083).
  A binding MUST stop with its scope, and MUST then stop what its `map` built (HE-059).
  So each prop costs no `select` slot, and all props of one slot cost one reader.

## Scopes

Each started element is a scope, and belongs to the scope above it.
So the code that places an element passes the duty to stop it up the tree, to a `mount` or to an entry of `each`.
An element that is not in the tree does no work, and continues when it comes back.
So a component can keep the views that it built, and show one of them at a time.

- JX-080: When an element starts a drive (JX-02B, JX-061), the runtime MUST bind it to the closest ancestor that is a scope.
  It binds through the top: the child of that ancestor that holds the element, or the element itself.
  `mount` MUST make `parent` a scope, and bind it the same way if an ancestor is a scope.
  The binding does not change after that (JX-046).
- JX-081: To stop a scope, the runtime MUST stop its drives and each scope bound to it, and end its binding.
  The unmount function stops what is under the scope of `parent` (JX-02A), and a `mount` into a host does the same before it places (JX-020).
  `each` stops the scopes of an entry that leaves (JX-035).
  When the drives of an element all finish and no scope is bound to it, the runtime MUST end its binding.
  It MUST then do the same for the scope above, if that scope drives nothing and holds no scope.
  So a finished element is not retained.
- JX-082: When a place removes a node, the runtime MUST park each scope that is bound through that node, and each scope under it.
  When a place adds that node again, the runtime MUST resume them, except a scope whose own top is not in place, and the scopes under that one.
  A place by a parked scope MUST NOT start a waiting element (JX-02B).
  The resume of the scope starts it.
  A drive that starts in a parked scope starts parked.
- JX-083: A parked drive MUST apply the results of the pulls that are pending, and MUST NOT pull again until it resumes (SE-04C).
  A drive that starts parked pulls nothing.
  So a source keeps the values that the drive did not read, as its options say, and an `asend` waits.
- JX-084: A drive that parks or resumes MUST tell each `each` that it drives.
  That `each` MUST park or resume the drive of its entries.
  A parked host does not pull its `each`, so the `each` replays the missed operations at the first pull after the resume.

## Parts

An output can hold dynamic children, so a component yields another component, and `derive` gives a component with no element around it.

- JX-085: For each dynamic child in an output, the host MUST make a part, and add its source to the drive of the entry.
  The nodes of the entry are the nodes of the output in order, with the nodes of each part at the place of its dynamic child.
  JX-024 to JX-028 apply to a part.
  A part can hold parts.
  An async iterable is opened one time, at the first pull of its part.
- JX-086: An entry keeps the parts that its outputs made, by source.
  When an output does not hold a part of the output before it, the host MUST park that part and the parts in its last output.
  A parked part follows JX-083.
  When a later output of the same entry holds that source again, the host MUST use the same part, with its nodes, and resume it.
  A part of a parked part starts parked.
  A parked part stays parked when its drive resumes, and its `each` too (JX-084).
  A part that finished keeps its nodes.
  The stop of the drive returns each unfinished part (SE-120), and `each` returns the parts of an entry that leaves or renders again.
- JX-087: An output that holds the source of its entry, or of an entry around it, MUST call `globalThis.reportError` with a `TypeError`, and the entry MUST keep its nodes and its parts.
  The same holds for an output with a child that fails to convert (JX-028).
  Two sources that give each other have no defined result.

## Each

`each` is a dynamic child that renders one entry for each item of a `select` with an array shape.
It reads the changes of that `select`, and gives each new value of an item to the `Item` of that item.
An `Item` has the current value, and makes a channel only when code iterates it.
So a component instance updates its own nodes, and the host moves only nodes that change place.
A component instance that finishes renders again with the next value of its item, so a component can read its item once.
`each` owns only the nodes of its entries, so the other children of its host keep their nodes.

- JX-030: `each` MUST throw a `TypeError` synchronously if `state` is not a `select` proxy with an array shape, or if `render` is not a function.
  It MUST also throw a `TypeError` if `options.key` is not a function and not `undefined`, or for another own enumerable string key of `options`.
  It MUST return an async generator, and MUST NOT call `changes` before the first `next()`.
- JX-031: The first `next()` MUST call `changes(state)`, make one entry for each item of `outputs`, and yield the nodes of all entries in order.
- JX-032: For a new item, `each` MUST create an `Item` with the value, and call `render` with it.
  The result of `render` is the child of the entry.
  It MUST be a static child, or one dynamic child.
- JX-033: `each` MUST replay each read onto its mirror of entries with `applyOps`, with the `key` of `options`.
  So an item that leaves and comes back in one read keeps its entry, its `Item` and its instance (HE-04H).
- JX-03G: Without `key`, a value takes the row of the same value that left, and otherwise the row that left its index (HE-04H).
  So two sets that swap two items move their rows, and an assignment of a new value at an index gives the value to the row there.
  A slot that gives a new output keeps its row (SE-10C), and so does a slot that gives the same output again.
  With `key`, a row belongs to the key of the output.
  So a new value with the key of a row gives the value to its `Item`, and a new key renders a new row.
- JX-034: For an item that keeps its entry, `each` MUST give the new value to the `Item` of that entry.
  The `Item` MUST set `value`, and then send the value to its channel, if it has one.
  It MUST NOT call `render`, unless JX-03C applies.
- JX-035: For an item that leaves the mirror, `each` MUST end its `Item` and stop the drive of its child.
  To end an `Item`, `each` MUST close its channel if it has one, and abort its `signal`.
  `each` MUST then stop each scope that is bound through a node of the entry (JX-080).
  This includes a node that an earlier output of the child or of one of its parts gave, if a scope is still bound through it.
  It MUST also return the child, and each part that the outputs of the child made (JX-086, JX-08A).
  So a row that leaves ends the dynamic children and the dynamic props inside it, also the ones that are parked.
- JX-036: `each` MUST drive the dynamic children of its entries with one `select`, with `autoStart`, no `autoClose` and no `backPressure`.
  JX-024 to JX-028 apply.
- JX-037: When the nodes of its entries changed after its last yield, `each` MUST yield a new array of the nodes of all entries in order.
  A read with only `set` operations that keep each entry at its index changes no node of `each` itself.
  Such a read MUST read only the entries at the indexes that it names.
  `each` MUST NOT yield while no node changed.
  So a host that is busy gets one output for all changes since its last pull.
- JX-038: `each` MUST NOT change a node outside its entries.
  JX-029 keeps the order of the other children of its host.
- JX-039: When the reader finishes, `each` MUST end the `Item` of each entry, stop its drive and finish.
  The host keeps the last nodes of `each` (SE-024).
  If the reader rejects, `each` MUST do the same, and then reject with the unchanged error.
- JX-03A: An error from `render` or from `applyOps` MUST end `each` as a rejection of the reader does.
  `each` MUST finish its reader first.
- JX-070: A wait of `each` for a read or for its drive MUST NOT retain an object after it ends.
  So an `each` that lives long grows no memory with each read.
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

## Boundaries

A boundary takes the failures of the scopes under it, so that one broken view does not break the page, and the app shows a fallback in its place.
Boundaries follow the scopes, and not the components.
An async generator queues `throw()` behind a pending `next()` (JX-041), and a host always has a `next()` pending on a component.
So a component cannot catch the failure of a view that it yielded.
The scopes give a tree that needs no part of the generator.

- JX-090: `Catch` MUST throw a `TypeError` if `children` is not one element, or if `fallback` is not a function.
  Otherwise it MUST make that element a boundary, and return it.
- JX-091: A boundary MUST wait as JX-02B says, and its start MUST make it a scope with no drive (JX-080).
  JX-02B starts the nodes in tree order, so the elements inside a boundary bind to it.
  JX-081 MUST NOT end the binding of a boundary that drives nothing and holds no scope.
  A boundary scope ends when the scope above it stops.
  So an element that starts inside it later still binds to it.
- JX-092: The runtime MUST hand a failure to the nearest armed boundary, at the scope of the failure or above it, by the bindings of JX-080.
  The boundary then takes the failure, and the runtime MUST NOT call `globalThis.reportError` for it.
  Without an armed boundary, the rule of the failure applies, and the runtime calls `globalThis.reportError`.
  A boundary is armed from its start until it takes a failure.
- JX-093: A boundary that takes a failure MUST stop the drive of its children and each scope bound to it, as the unmount function does (JX-02A).
  It MUST keep its dynamic props, and stay a scope.
  It MUST then call `fallback` with the unchanged error, and mount the result into its element as `mount` does (JX-020).
  If `fallback` throws, the runtime MUST hand that error to the boundary above, as a failure of the scope of the boundary.
  A boundary takes one failure, so a failure in its fallback goes to the boundary above.
- JX-094: The runtime MUST NOT hand these errors to a boundary, and MUST call `globalThis.reportError` with them:
  an error of JX-089, because it comes from a child that its drive removed or stopped, so no view shows that child;
  and a failure of a drive whose scope stopped, for example a later output of the report in which the boundary took a failure.
- JX-095: A boundary that takes a failure while its scope is parked mounts the fallback parked (JX-082).
  The fallback starts when the scope resumes.
- JX-096: A synchronous error of `jsx`, `mount` or a conversion in `mount` MUST throw to the caller, and MUST NOT go to a boundary.
  The caller can catch it with `try`.

## Limits

- JX-040: The runtime does not stop an element or a part when an output replaces it.
  It parks them (JX-082, JX-086), and they stop with their scope (JX-081).
  So a source that gives a new element for each output grows its scope, until the scope stops.
  `derive` and `iff` stop what their `map` built (HE-059).
  A generator component that builds a view for each value has no such owner, so wrap the view in `derive`.
  In `each`, a child that finishes renders again (JX-03C).
- JX-041: When a drive lets a source go, because it stops, removes the entry, or the source finishes, the runtime MUST call `return()` on each `Channel` consumer and each reader of `changes` that code opened while the drive pulled that source.
  A `watch` opens its reader at its first `next()`, so a `for await` on a `watch` in the pull is bound too.
  So a component that waits on an open channel ends at once (CH-073).
  Code after an `await` or a `yield*` resumes outside the pull (DV-052), so what it opens is not bound.
  A plain `yield` of the same node before that code wakes the host and binds it.
  An async generator queues `return()` behind a pending `next()`, so a component that waits on anything else ends only at its next `yield`.
- JX-042: A node in the entries of two hosts, or in two entries of one host, has no defined position.
- JX-043: The children of a host belong to the runtime.
  A place removes nodes that other code adds.
  Code can change the attributes and the content of the nodes in an entry.
- JX-044: `jsx` assigns a static live property one time, so it does not apply to options that a dynamic child adds later.
  It assigns the value as it is, so a `value` on a file input throws, as the DOM does.
- JX-045: Other code that inserts a waiting element, for example with `append`, does not start it (JX-02B).
  Yield the element or make it a child, so that a host places it.
- JX-046: An element stays bound to the scope under which it started (JX-080).
  So a started element that code moves into another entry or another host stops with the first scope.
- JX-047: Only a place of the runtime parks and resumes (JX-082).
  Other code that removes a node, for example with `remove`, parks nothing.

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
  backPressure: false,
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
