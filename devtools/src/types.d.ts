// Ambient types, so that the classic content script needs no import.
declare namespace GG {
  type Kind = "channel" | "select" | "feed" | "component" | "mount" | "each";
  type Item = {
    seq: number;
    time: number;
    type: string;
    text: string;
    n?: number;
    reader?: number;
  };
  type Reader = {
    id: number;
    pos: number;
    label?: string; // The consumer, as a function name, a site, or a select slot key
    frame?: string; // The stack line of the consumer
    link?: number; // The select or feed that consumes
    gone?: boolean; // Detached
  };
  type Entry = {
    id: number;
    kind: Kind;
    label: string;
    frame: string; // The first stack line, for the name lookup
    state: string;
    options: string;
    channel?: number; // The channel of a select, a feed, or the select of a host
    owner?: number; // The select that owns a channel, or the host that owns an object
    select?: number; // The select that drives the children of a host
    source?: number; // A feed source, or the state of each, that is tracked
    sourceText?: string;
    sent?: number;
    read?: number;
    consumers?: number;
    result?: string;
    reports?: number;
    props?: [string, string, number?][]; // A component's props, with links to tracked objects
    items?: number; // The channels that an each or a host owns
  };
  // An entry as a batch sends it, with its frame and label in the site table.
  type Wire = Omit<Entry, "frame" | "label"> & { site: number };
  // The log and stack of an inspected object, all of them when full, and new items otherwise.
  type Detail = {
    id: number;
    full: boolean;
    stack: string[];
    readers: Reader[];
    log: Item[];
  };
  type Slot = {
    key: string;
    kind: string;
    source: string;
    link?: number;
    status: string;
    value: string;
    busy: boolean;
    finished: boolean;
  };
  type Poll = {
    protocol: number; // Changes with the batch shape, so a panel can detect an old hook
    session: string;
    seq: number;
    entries: Wire[];
    sites: [number, string, string][]; // New sites: an index, the frame, and the label
    count: number; // All tracked objects, also the ones that this batch leaves out
    picking: boolean; // The page picker is on
    picked?: number; // The row of the node that the page picker chose, one time
    removed: number[];
    slots?: Slot[];
    details: Detail[];
    full: boolean; // Replaces all entries, after a connect
    tree?: [number, number, number][]; // Id, parent id or 0, and order among siblings
    elements?: [number, string, number][]; // With an elements tree: a node id, its label, and its host entry or 0
  };
}

declare namespace chrome.devtools.inspectedWindow {
  const tabId: number;
  type Resource = {
    url: string;
    getContent(callback: (content: string | null) => void): void;
  };
  function getResources(callback: (resources: Resource[]) => void): void;
  // biome-ignore lint/suspicious/noShadowRestrictedNames: the Chrome API name
  function eval(
    expression: string,
    callback: (result: any, exception?: { value?: string }) => void,
  ): void;
}

declare namespace chrome.devtools.panels {
  const themeName: string;
  function create(title: string, iconPath: string, pagePath: string): void;
  function openResource(url: string, line: number, column?: number): unknown;
  namespace elements {
    const onSelectionChanged: chrome.runtime.Event<() => void>;
  }
}

declare namespace chrome.runtime {
  type Event<F> = { addListener(listener: F): void };
  type Sender = { tab?: { id?: number } };
  type Port = {
    name: string;
    sender?: Sender;
    postMessage(message: any): void;
    disconnect(): void;
    onMessage: Event<(message: any) => void>;
    onDisconnect: Event<() => void>;
  };
  const lastError: { message?: string } | undefined;
  function connect(info: { name: string }): Port;
  function sendMessage(message: any): Promise<any>;
  const onConnect: Event<(port: Port) => void>;
  const onMessage: Event<
    (message: any, sender: Sender, reply: (response: any) => void) => void
  >;
}

declare namespace chrome.tabs {
  function sendMessage(
    tab: number,
    message: any,
    options?: { frameId?: number },
  ): Promise<any>;
}
