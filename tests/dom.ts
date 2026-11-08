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
  get nextSibling(): FakeNode | null {
    const siblings = (this.parentNode as FakeNode).childNodes;
    return siblings[siblings.indexOf(this) + 1] ?? null;
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
  addEventListener(type: string, listener: unknown) {
    this.listeners.push([type, listener]);
  }
}

export const fakeDocument = {
  createElement: (tag: string) => new FakeElement(tag),
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
