import { register } from "./devtools.ts";
import {
  attach,
  bind,
  ends,
  isDynamic,
  LIVE,
  toNodes,
  unmount,
} from "./host.ts";

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

const SVG = "http://www.w3.org/2000/svg";
// Children exist before their parent, so a tag alone picks the namespace.
const SVG_TAGS = new Set(
  "svg g defs symbol use image switch foreignObject desc metadata path rect circle ellipse line polyline polygon text tspan textPath linearGradient radialGradient stop pattern clipPath mask marker filter view animate animateMotion animateTransform set mpath".split(
    " ",
  ),
);
/** Mounts children into parent, keeps dynamic children live, and gives a function that unmounts them. */
export function mount(parent: Element, ...children: Child[]): () => void {
  attach(parent, children, true);
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
  const live: [string, unknown][] = [],
    dynamic: [string, unknown][] = [];
  for (const name of Object.keys(props)) {
    const value = props[name];
    if (name === "children" || value == null || value === false) continue;
    if (isDynamic(value)) {
      if (name.startsWith("on"))
        throw new TypeError(`${name} does not take a dynamic value`);
      dynamic.push([name, value]);
    } else if (typeof value === "function" && name.startsWith("on"))
      element.addEventListener(name.slice(2).toLowerCase(), value as any);
    else if (LIVE.has(name)) live.push([name, value]);
    else element.setAttribute(name, value === true ? "" : `${value}`);
  }
  attach(element, props.children, false);
  // After the children, so a select finds the option that its value names.
  for (const [name, value] of live) (element as any)[name] = value;
  if (dynamic.length) bind(element, dynamic);
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

export {
  type Context,
  consume,
  createContext,
  Provide,
  use,
} from "./context.ts";
export { each, type Item } from "./each.ts";
