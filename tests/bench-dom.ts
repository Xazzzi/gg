// A linked-list DOM for the benchmark, so a sibling walk costs O(1) as in a browser.

class BenchNode {
  parentNode: BenchNode | null = null;
  firstChild: BenchNode | null = null;
  lastChild: BenchNode | null = null;
  nextSibling: BenchNode | null = null;
  previousSibling: BenchNode | null = null;
  nodeType: number;
  data?: string;
  constructor(nodeType: number, data?: string) {
    this.nodeType = nodeType;
    this.data = data;
  }
  get childNodes() {
    const list: BenchNode[] = [];
    for (let at = this.firstChild; at; at = at.nextSibling) list.push(at);
    return list;
  }
  detach() {
    const parent = this.parentNode;
    if (!parent) return;
    if (this.previousSibling)
      this.previousSibling.nextSibling = this.nextSibling;
    else parent.firstChild = this.nextSibling;
    if (this.nextSibling)
      this.nextSibling.previousSibling = this.previousSibling;
    else parent.lastChild = this.previousSibling;
    this.parentNode = this.nextSibling = this.previousSibling = null;
  }
  remove() {
    this.detach();
  }
  insertBefore(node: BenchNode, ref: BenchNode | null) {
    node.detach();
    node.parentNode = this;
    const before = ref ? ref.previousSibling : this.lastChild;
    node.previousSibling = before;
    node.nextSibling = ref;
    if (before) before.nextSibling = node;
    else this.firstChild = node;
    if (ref) ref.previousSibling = node;
    else this.lastChild = node;
    return node;
  }
  append(...nodes: BenchNode[]) {
    for (const node of nodes) this.insertBefore(node, null);
  }
  replaceChildren() {
    for (let at = this.firstChild; at; ) {
      const next = at.nextSibling;
      at.parentNode = at.nextSibling = at.previousSibling = null;
      at = next;
    }
    this.firstChild = this.lastChild = null;
  }
  set textContent(value: string) {
    this.replaceChildren();
    this.insertBefore(new BenchNode(3, value), null);
  }
}

class BenchElement extends BenchNode {
  attributes = new Map<string, string>();
  className = "";
  tagName: string;
  constructor(tagName: string) {
    super(1);
    this.tagName = tagName;
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
  }
  addEventListener() {}
}

(globalThis as any).document = {
  createElement: (tag: string) => new BenchElement(tag),
  createElementNS: (_: string, tag: string) => new BenchElement(tag),
  createTextNode: (data: string) => new BenchNode(3, data),
  createComment: (data: string) => new BenchNode(8, data),
  createDocumentFragment: () => new BenchNode(11),
};

/** Counts the children of a node. */
export const count = (node: any) => {
  let total = 0;
  for (let at = node.firstChild; at; at = at.nextSibling) total++;
  return total;
};
