import { StopError } from "./channel.ts";
import { register } from "./devtools.ts";
import {
  aborts,
  adopt,
  attach,
  attribute,
  bind,
  ends,
  guard,
  isDynamic,
  NONE,
  outlive,
  type Parent,
  property,
  put,
  quitSource,
  toNodes,
  unmount,
} from "./host.ts";
import { chunked, record } from "./source.ts";

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

/** A prop value, or a promise or an async iterable of it, which makes a dynamic prop. */
type Live<V> = V | PromiseLike<V> | AsyncIterable<V>;
type Text = string | number | bigint | boolean | null | undefined;
type Handlers<E> = {
  [K in keyof HTMLElementEventMap as `on${K}`]?: (
    event: HTMLElementEventMap[K] & { currentTarget: E },
  ) => void;
};
type LiveProp<E, K extends string> =
  E extends Record<K, infer V> ? Live<V | number | null | undefined> : unknown;
/** The props of an element of type E, with typed listeners and live properties, and any other attribute. */
interface ElementProps<E> extends Handlers<E> {
  children?: Child;
  value?: LiveProp<E, "value">;
  checked?: LiveProp<E, "checked">;
  selected?: LiveProp<E, "selected">;
  indeterminate?: LiveProp<E, "indeterminate">;
  muted?: LiveProp<E, "muted">;
  class?: Live<Text>;
  id?: Live<Text>;
  style?: Live<string | false | null | undefined>;
  title?: Live<Text>;
  hidden?: Live<Text>;
  xmlns?: string;
  [name: `on${string}`]: ((event: any) => void) | undefined;
  [name: string]: unknown;
}
type Tags = HTMLElementTagNameMap &
  Omit<SVGElementTagNameMap, keyof HTMLElementTagNameMap>;
/** The own properties of a custom element, which take data (JX-0B0). */
type OwnProps<E> = {
  [K in Exclude<keyof E, keyof HTMLElement> as K extends `on${string}`
    ? never
    : K]?: Live<E[K]>;
};
type Known = {
  [K in keyof Tags]: K extends `${string}-${string}`
    ? ElementProps<Tags[K]> & OwnProps<Tags[K]>
    : ElementProps<Tags[K]>;
};

export declare namespace JSX {
  type Element = Child;
  interface IntrinsicElements extends Known {
    [tag: string]: Props;
  }
  interface ElementChildrenAttribute {
    children: unknown;
  }
}

const SVG = "http://www.w3.org/2000/svg";
// Children exist before their parent, so a tag alone picks the namespace.
// The filter primitives are the tags that start with fe and an upper case letter.
const SVG_TAGS = new Set(
    "svg g defs symbol use image switch foreignObject desc metadata path rect circle ellipse line polyline polygon text tspan textPath linearGradient radialGradient stop pattern clipPath mask marker filter view animate animateMotion animateTransform set mpath".split(
      " ",
    ),
  ),
  isSvg = (tag: string) => SVG_TAGS.has(tag) || /^fe[A-Z]/.test(tag);
/** Tells if a key starts with on in any case, as the DOM takes an attribute name of an HTML element (JX-008). */
const isOn = (name: string) =>
  (name.charCodeAt(0) | 32) === 111 && (name.charCodeAt(1) | 32) === 110;
// The last mount into each parent, which its unmount function ends (JX-02A).
const mounts = new WeakMap<Parent, object>();
/** Mounts children into parent, keeps dynamic children live, and gives a function that unmounts them. */
export function mount(parent: Parent, ...children: Child[]): () => void {
  attach(parent, children, true);
  const mine = {};
  mounts.set(parent, mine);
  return () => {
    // A later mount into parent owns its children, and stopped the ones of this mount (JX-02A).
    if (mounts.get(parent) !== mine) return;
    mounts.delete(parent);
    unmount(parent);
    parent.replaceChildren();
  };
}

/** The second argument of a component, with a signal that aborts when the runtime lets the instance go (JX-0C0). */
export type Instance = { readonly signal: AbortSignal };

let finish: (instance: Life) => void;
const stopped = () => new StopError("component stopped");
/** Makes its controller only when code reads the signal. */
class Life implements Instance {
  #control?: AbortController;
  #ended = false;

  static {
    finish = life => {
      life.#ended = true;
      life.#control?.abort(stopped());
    };
  }

  get signal(): AbortSignal {
    if (!this.#control) {
      this.#control = new AbortController();
      if (this.#ended) this.#control.abort(stopped());
    }
    return this.#control.signal;
  }
}

/** Creates an element with props and children, or calls a component with props, and an instance if it takes one. */
export function jsx(
  type: string | ((props: any, instance: Instance) => Child),
  props: Props,
  _key?: unknown,
): Child {
  if (typeof type === "function") {
    const life = type.length > 1 ? new Life() : undefined,
      result = type(props, life as Life);
    if (life) {
      const end = () => finish(life);
      if (isDynamic(result)) aborts.set(result as object, end);
      else if ((result as Node | null)?.nodeType === 1)
        outlive(result as Element, end);
    }
    if (typeof result === "object" && result) {
      const emit = register("component", result, { type, props });
      // Stryker disable next-line ConditionalExpression: an undefined emitter only costs a WeakMap entry
      if (emit) ends.set(result, emit);
      if (isDynamic(result)) record(() => quitSource(result)); // HE-059
    }
    return result;
  }
  const { xmlns } = props;
  const html = typeof xmlns !== "string" && !isSvg(type),
    element = html
      ? document.createElement(type)
      : document.createElementNS(typeof xmlns === "string" ? xmlns : SVG, type);
  const values =
      html && type.includes("-") && globalThis.customElements
        ? adopt(element, type)
        : undefined,
    live: [string, unknown][] = [],
    dynamic: [string, unknown][] = [];
  for (const name of Object.keys(props)) {
    const value = props[name];
    if (name === "children" || value === undefined) continue;
    const on = isOn(name);
    if (isDynamic(value)) {
      if (on) throw new TypeError(`${name} does not take a dynamic value`);
      dynamic.push([name, value]);
      values?.set(name, NONE);
    } else if (on) {
      if (value === null || value === false) continue;
      // A text value would make an inline handler, which runs text as code (JX-008).
      if (typeof value !== "function")
        throw new TypeError(`${name} takes a function`);
      // A custom event keeps its case, unless the element has a handler property for the lower case key.
      const lower = name.toLowerCase();
      element.addEventListener(
        (lower in element ? lower : name).slice(2),
        value as any,
      );
    } else if (values && !(name in HTMLElement.prototype))
      values.set(name, value); // JX-0B2 holds only a key that can be own
    // A property takes null and false as a dynamic output does (JX-002).
    else if (property(element, name)) live.push([name, value]);
    else if (value !== null && value !== false)
      element.setAttribute(name, attribute(name, value));
  }
  attach(element, props.children, false);
  // After the children, so a select finds the option that its value names.
  for (const [name, value] of live) put(element, name, value);
  if (dynamic.length) bind(element, dynamic);
  return element;
}

/** Makes its one element child a boundary, which shows fallback in place of what is inside it after a failure (JX-090). */
export function Catch({
  fallback,
  children,
}: {
  fallback: (error: unknown) => Child;
  children?: Child;
}): Element {
  if ((children as Node | undefined)?.nodeType !== 1)
    throw new TypeError("Catch needs one element child");
  if (typeof fallback !== "function")
    throw new TypeError("Catch fallback must be a function");
  guard(children as Element, fallback);
  return children as Element;
}

export const jsxs = jsx,
  jsxDEV = jsx;

/** Tells if a child holds a dynamic child, at any depth of its arrays. */
const live = (child: unknown): boolean =>
  Array.isArray(child) ? child.some(live) : isDynamic(child);

/** Groups static children into a `DocumentFragment`, and gives children with a dynamic child unchanged, for a host to drive. */
export function Fragment(props: { children?: Static }): DocumentFragment;
export function Fragment(props: { children?: Child }): Child;
export function Fragment({ children }: { children?: Child }): Child {
  if (live(children)) return children;
  const fragment = document.createDocumentFragment();
  chunked(toNodes(children), part => fragment.append(...part));
  return fragment;
}

export {
  type Context,
  consume,
  createContext,
  Provide,
  use,
} from "./context.ts";
export { type EachOptions, each, type Item } from "./each.ts";
