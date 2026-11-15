// A minimal DOM for the JSX tests, with counters of child inserts and removals on each parent.

export class FakeNode {
  parentNode: FakeNode | null = null;
  childNodes: FakeNode[] = [];
  counts = { insert: 0, remove: 0 };
  nodeType: number;
  constructor(nodeType: number) {
    this.nodeType = nodeType;
  }
  get firstChild() {
    return this.childNodes[0] ?? null;
  }
  get lastChild(): FakeNode | null {
    return this.childNodes.at(-1) ?? null;
  }
  get nextSibling(): FakeNode | null {
    const siblings = (this.parentNode as FakeNode).childNodes;
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }
  get previousSibling(): FakeNode | null {
    const siblings = (this.parentNode as FakeNode).childNodes;
    return siblings[siblings.indexOf(this) - 1] ?? null;
  }
  insertBefore(node: FakeNode, ref: FakeNode | null) {
    this.counts.insert++;
    node.detach();
    const at = ref ? this.childNodes.indexOf(ref) : this.childNodes.length;
    this.childNodes.splice(at, 0, node);
    node.parentNode = this;
    return node;
  }
  append(...nodes: FakeNode[]) {
    for (const node of nodes) this.insertBefore(node, null);
  }
  detach() {
    const siblings = this.parentNode?.childNodes;
    siblings?.splice(siblings.indexOf(this), 1);
    this.parentNode = null;
  }
  remove() {
    if (this.parentNode) this.parentNode.counts.remove++;
    this.detach();
  }
  // Calls the listeners of each node from the target up, until one stops propagation.
  dispatchEvent(event: Event) {
    for (let at: any = this; at && !event.cancelBubble; at = at.parentNode)
      for (const [type, listener] of at.listeners ?? [])
        if (type === event.type) listener(event);
    return true;
  }
  replaceChildren(...nodes: FakeNode[]) {
    for (const node of [...this.childNodes]) node.remove();
    this.append(...nodes);
  }
}

export class FakeText extends FakeNode {
  data: string;
  constructor(data: string) {
    super(3);
    this.data = data;
  }
}

export class FakeElement extends FakeNode {
  attributes = new Map<string, string>();
  listeners: [string, unknown][] = [];
  tagName: string;
  namespaceURI: string;
  constructor(tagName: string, namespaceURI = "http://www.w3.org/1999/xhtml") {
    super(1);
    this.tagName = tagName;
    this.namespaceURI = namespaceURI;
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
  }
  addEventListener(type: string, listener: unknown) {
    this.listeners.push([type, listener]);
  }
  attachShadow() {
    return Object.assign(new FakeNode(11), { host: this });
  }
}
// The browser has a handler property for each DOM event on the prototype of an element.
for (const type of ["click", "dblclick", "input", "change", "keydown", "blur"])
  Object.defineProperty(FakeElement.prototype, `on${type}`, {
    value: null,
    writable: true,
  });

// The browser has id and title on the prototype of an element, so they are never own properties (JX-0B1).
for (const name of ["id", "title"])
  Object.defineProperty(FakeElement.prototype, name, {
    value: "",
    writable: true,
  });

// A registry of custom elements: an element of a defined tag is made by its class, which takes the tag.
const classes = new Map<string, typeof FakeElement>(),
  definitions = new Map<string, PromiseWithResolvers<void>>();
const definition = (tag: string) => {
  let wait = definitions.get(tag);
  if (!wait) definitions.set(tag, (wait = Promise.withResolvers()));
  return wait;
};
export const fakeCustomElements = {
  define(tag: string, type: typeof FakeElement) {
    classes.set(tag, type);
    definition(tag).resolve();
  },
  get: (tag: string) => classes.get(tag),
  // A name that the HTML standard reserves, such as font-face, is not valid.
  whenDefined: (tag: string) =>
    tag === "font-face"
      ? Promise.reject(new SyntaxError(`${tag} is not a valid name`))
      : definition(tag).promise,
  // Gives an element made before the definition of its tag the class, with the fields of that class, and leaves an element of no definition.
  upgrade(node: FakeElement) {
    const { tagName } = node,
      type = classes.get(tagName);
    if (!type) return;
    Object.setPrototypeOf(node, type.prototype);
    const fresh: any = new type(tagName);
    for (const key of Object.keys(fresh))
      if (!Object.hasOwn(node, key)) (node as any)[key] = fresh[key];
  },
};

export const fakeDocument = {
  createElement: (tag: string) => new (classes.get(tag) ?? FakeElement)(tag),
  createElementNS: (namespace: string, tag: string) =>
    new FakeElement(tag, namespace),
  createTextNode: (data: string) => new FakeText(data),
  createComment: (data: string) => Object.assign(new FakeNode(8), { data }),
  createDocumentFragment: () => new FakeNode(11),
};

// Writes a node as HTML-like text, so a test compares a whole tree.
export const html = (node: any): string =>
  node.nodeType === 3
    ? node.data
    : node.nodeType === 11
      ? node.childNodes.map(html).join("")
      : `<${node.tagName}${[...node.attributes]
          .map(([k, v]: string[]) => ` ${k}="${v}"`)
          .join("")}>${node.childNodes.map(html).join("")}</${node.tagName}>`;

(globalThis as any).document = fakeDocument;
(globalThis as any).customElements = fakeCustomElements;
(globalThis as any).HTMLElement = FakeElement;
