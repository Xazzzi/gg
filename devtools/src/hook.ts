// Runs in the page before its scripts, and installs the hook that spec/devtools.md defines.
// It records from page start, so a panel that opens late still shows the history.
// While a panel is connected, changes go out in batches through a DOM event that relay.ts forwards.
// So an idle page runs no devtools work.
{
  const HOOK = Symbol.for("gg.devtools");
  const VAL = Symbol.for("gg.Val");
  const PROTOCOL = 10; // Keep equal to the panel's
  const LOG_LIMIT = 500;
  const BATCH_MS = 100;
  const SLOT_LIMIT = 500; // A large shape would make each batch heavy
  const OP_LIMIT = 20; // A report of a large shape would make one huge log item
  const ELEMENT_LIMIT = 5000; // The elements tree walks this many nodes
  const NEAR_FOCUS = 100; // And this many siblings on each side of a focused node past the limit
  const g = globalThis as any;

  type Entry = Omit<GG.Entry, "frame" | "consumers"> & {
    stack: string[];
    version: number;
    ref: WeakRef<object>;
    log: GG.Item[];
    readers: Map<number, GG.Reader>;
    readerIds: WeakMap<object, GG.Reader>;
    nextReader: number;
    inner?: Entry; // The component whose result a wrapper component returned
    // Made by the JSX runtime, so only a tree tab or an inspection needs it, and a batch leaves it out otherwise.
    hidden?: boolean;
    via?: number; // The component that holds the item of this channel, which names a reader with no own frame
    type?: WeakRef<(...args: never) => unknown>; // A component's function, which the panel can inspect
  };

  const session = Math.random().toString(36).slice(2);
  const entries = new Map<number, Entry>();
  const byTarget = new WeakMap<object, Entry>();
  const inspectors = new WeakMap<object, () => any[]>();
  // The component props that hold each object, so an item that registers later can link them to its channel.
  const holders = new WeakMap<object, [Entry, number][]>();
  const removed: [number, number][] = [];
  let seq = 0,
    nextId = 1,
    sentSeq = 0,
    inspect = 0,
    detailSince = 0,
    connected = false,
    paused = false,
    wantTree = false,
    wantElements = false,
    treeFresh = false,
    sentTree = "",
    nextNode = 1,
    timer: ReturnType<typeof setTimeout> | undefined;

  const gone = new FinalizationRegistry<number>(id => {
    const e = entries.get(id),
      owner = e?.kind === "channel" && e.owner && entries.get(e.owner);
    if (owner) (owner.items as number)--, touch(owner);
    entries.delete(id);
    removed.push([id, ++seq]);
    schedule();
    if (removed.length > 1000) removed.shift();
  });
  const readerGone = new FinalizationRegistry<[number, number]>(([id, r]) =>
    entries.get(id)?.readers.delete(r),
  );

  const touch = (e: Entry) => {
    schedule();
    return (e.version = ++seq);
  };
  const record = (
    e: Entry,
    type: string,
    text: string,
    extra?: Partial<GG.Item>,
  ) => {
    e.log.push({ seq: touch(e), time: Date.now(), type, text, ...extra });
    if (e.log.length > LOG_LIMIT) e.log.shift();
  };

  const clip = (text: string, max: number) =>
    text.length > max ? `${text.slice(0, max)}…` : text;

  const preview = (value: any, depth = 0): string => {
    try {
      switch (typeof value) {
        case "string":
          return JSON.stringify(clip(value, 120));
        case "bigint":
          return `${value}n`;
        case "symbol":
          return value.toString();
        case "function":
          return `ƒ ${value.name || "anonymous"}()`;
      }
      if (value === null || typeof value !== "object") return String(value);
      const tracked = byTarget.get(value);
      if (tracked) return `‹${tracked.kind} #${tracked.id}›`;
      if (value[VAL]) return valText(value);
      if (value instanceof Error) return `${value.name}: ${value.message}`;
      if (typeof value.then === "function") return "Promise";
      if (value instanceof Map) return `Map(${value.size})`;
      if (value instanceof Set) return `Set(${value.size})`;
      if (Array.isArray(value)) {
        if (depth > 1) return `Array(${value.length})`;
        const items = value.slice(0, 10).map(v => preview(v, depth + 1));
        if (value.length > 10) items.push(`…${value.length - 10}`);
        return clip(`[${items.join(", ")}]`, 300);
      }
      const name = value[Symbol.toStringTag] ?? value.constructor?.name;
      const prefix = name && name !== "Object" ? `${name} ` : "";
      if (depth > 1) return `${prefix}{…}`;
      const keys = Object.keys(value);
      const parts = keys
        .slice(0, 8)
        .map(k => `${k}: ${preview(value[k], depth + 1)}`);
      if (keys.length > 8) parts.push("…");
      return clip(`${prefix}{${parts.join(", ")}}`, 300);
    } catch {
      return "‹unreadable›";
    }
  };

  const valText = (val: any) =>
    val.status === "pending"
      ? "pending"
      : val.status === "rejected"
        ? `rejected ${preview(val.reason, 1)}`
        : `${val.done ? "done" : "fulfilled"} ${preview(val.value, 1)}`;

  const few = (items: unknown[]) =>
    items
      .slice(0, 10)
      .map(v => preview(v, 2))
      .concat(items.length > 10 ? [`…${items.length - 10}`] : [])
      .join(", ");
  const opText = (op: any) =>
    op.op === "set"
      ? `set ${String(op.key)} = ${preview(op.value, 1)}`
      : op.op === "delete"
        ? `delete ${String(op.key)}`
        : op.op === "splice"
          ? `splice @${op.start} −${op.removed.length} +[${few(op.added)}]`
          : `move [${op.order.slice(0, 50).join(", ")}${op.order.length > 50 ? ", …" : ""}]`;

  // Frame 4, or 5 for a mount, is the caller (DV-003), and library frames from a bundle are skipped.
  const frames = (raw: string[], depth: number) => {
    const lines = raw.slice(depth, depth + 10).map(line => line.trim());
    const own = lines.findIndex(line => !/node_modules|@xazzzi/.test(line));
    return own > 0 ? lines.slice(own) : lines;
  };
  // A same-origin URL shows as its path, so labels stay short but still locate the file.
  const site = (line = "") => {
    const match = /at (?:.+? \()?(.+?):(\d+):(\d+)\)?$/.exec(line);
    if (!match) return "unknown";
    let path = match[1];
    try {
      const url = new URL(path);
      if (url.origin === globalThis.location?.origin) path = url.pathname;
    } catch {}
    return `${path}:${match[2]}:${match[3]}`;
  };

  const tagOf = (node: any) => {
    const id = node.id ? `#${node.id}` : "",
      classes = node.classList?.length
        ? `.${[...node.classList].join(".")}`
        : "";
    return `<${node.localName ?? "?"}${id}${classes}>`;
  };

  // Library URLs come from the frames of registrations, so a consumer frame can skip them.
  const libs = new Set<string>();
  let own = "";
  const urlOf = (line = "") =>
    /at (?:.+? \()?(.+?):\d+:\d+\)?$/.exec(line.trim())?.[1];

  // The first frame outside the hook and the library is the consumer.
  // All named frames outside the hook name the functions that read, because a bundle shares one URL with the library.
  const callers = new WeakMap<GG.Reader, string[]>();
  // Component function names, which name a consumer in a bundle, where every frame has the library URL.
  const components = new Set<string>();
  const consumerOf = (reader: GG.Reader) => {
    const names: string[] = [];
    let found = false,
      fallback: Partial<GG.Reader> | undefined;
    for (const raw of (new Error().stack ?? "").split("\n").slice(1)) {
      const line = raw.trim(),
        url = urlOf(line);
      if (!url || url === own) continue;
      const fn = /^at (?:async )?(?:new )?([^\s(]+) \(/
        .exec(line)?.[1]
        ?.split(".")
        .pop();
      const name = fn && !fn.startsWith("<") ? fn : undefined;
      if (name) names.push(name);
      if (name && !fallback && components.has(name))
        fallback = { label: name, frame: line };
      if (found || libs.has(url)) continue;
      Object.assign(reader, { label: name ?? site(line), frame: line });
      found = true;
    }
    if (!found && fallback) Object.assign(reader, fallback);
    callers.set(reader, names);
  };
  // A consumer with no such frame is a select slot or a feed that reads the channel.
  // The scan reads all slots, so it runs only for the readers of an inspected object.
  const linkOf = (e: Entry): Partial<GG.Reader> => {
    const target = e.ref.deref();
    for (const s of entries.values()) {
      const t = s.ref.deref();
      if (s.kind === "feed" && t && t === target)
        return { label: "feed", link: s.id };
      const slots: any[] =
        (s.kind === "select" && t && inspectors.get(t)?.()) || [];
      for (const slot of slots)
        if (
          slot.source === target ||
          byTarget.get(slot.source)?.channel === e.id
        )
          return { label: `[${String(slot.key)}]`, link: s.id };
    }
    return { label: "library" };
  };

  const readerOf = (e: Entry, reader: object) => {
    let info = e.readerIds.get(reader);
    if (!info) {
      info = { id: ++e.nextReader, pos: 0 };
      e.readerIds.set(reader, info);
      e.readers.set(info.id, info);
      readerGone.register(reader, [e.id, info.id]);
    }
    return info;
  };

  const channelEmit = (e: Entry) => (event: string, a: any, b: any, c: any) => {
    if (event === "send") {
      e.sent = b;
      record(e, "send", preview(a), { n: b });
    } else if (event === "read") {
      const reader = readerOf(e, c);
      reader.pos = b;
      e.read = (e.read as number) + 1;
      record(e, "read", preview(a), { n: b, reader: reader.id });
    } else if (event === "attach") {
      const reader = readerOf(e, a);
      consumerOf(reader);
      instance(reader, b);
      if (!reader.label && e.via)
        Object.assign(reader, { label: "component", link: e.via });
      record(e, "attach", "", { reader: reader.id });
    } else if (event === "detach") {
      const reader = readerOf(e, a);
      reader.gone = true; // Kept, so the log can still name it
      touch(e);
      record(e, "detach", "", { reader: reader.id });
    } else if (event === "end") {
      e.state = a ? "failed" : "closed";
      e.result = preview(b);
      record(e, "end", `${e.state} ${e.result}`);
    }
  };

  const selectEmit = (e: Entry) => (event: string, ops: any[]) => {
    if (event === "start") {
      e.state = "started";
      record(e, "start", "");
    } else if (event === "report") {
      e.reports = (e.reports as number) + 1;
      const more = ops.length - OP_LIMIT;
      record(
        e,
        "report",
        ops
          .slice(0, OP_LIMIT)
          .map(opText)
          .concat(more > 0 ? [`… ${more} more`] : [])
          .join("\n"),
      );
    }
  };

  const feedEmit = (e: Entry) => (event: string) => {
    if (event === "end") {
      e.state = "ended";
      record(e, "end", "");
    }
  };

  const create = (
    kind: GG.Kind,
    target: object,
    detail: any,
    stack: string[],
  ) => {
    const e: Entry = {
      id: nextId++,
      kind,
      label: site(stack[0]),
      stack,
      state: "open",
      options: "",
      version: ++seq,
      ref: new WeakRef(target),
      log: [],
      readers: new Map(),
      readerIds: new WeakMap(),
      nextReader: 0,
    };
    entries.set(e.id, e);
    gone.register(target, e.id);
    schedule(); // A new object changes the list and the tree, even if it never emits
    const owner = detail.owner && byTarget.get(detail.owner);
    e.owner = owner?.id; // DV-005
    e.hidden = !!owner?.hidden;
    if (kind === "component" || kind === "mount" || kind === "each") {
      e.hidden = true;
      const inner = byTarget.get(target);
      if (kind === "component" && inner?.kind === "component") e.inner = inner;
      byTarget.set(target, e);
      e.state = "live";
      if (kind === "mount") e.sourceText = tagOf(target);
      if (kind === "each") e.source = byTarget.get(detail.state)?.id;
      if (kind !== "component") return undefined; // DV-044
      e.sourceText = detail.type.name || "anonymous";
      if (detail.type.name) components.add(detail.type.name);
      e.type = new WeakRef(detail.type);
      e.props = Object.entries(detail.props ?? {})
        .filter(([key]) => key !== "children")
        .map(([key, value], i) => {
          if (Object(value) === value)
            holders.get(value as object)?.push([e, i]) ??
              holders.set(value as object, [[e, i]]);
          return [key, preview(value), byTarget.get(value as object)?.id];
        });
      // A host ends only a dynamic result (DV-045), so other results are static.
      const t = target as any;
      if (typeof t.then !== "function" && !t[Symbol.asyncIterator])
        e.state = "static";
      return (event: string) => {
        if (event !== "end") return;
        e.state = "ended";
        record(e, "end", "");
      };
    }
    if (kind === "channel") {
      byTarget.set(target, e);
      if (owner) owner.items = (owner.items ?? 0) + 1;
      e.options = `${detail.firstReceive} / ${detail.thenReceive} / ${detail.stopStyle}`;
      e.sent = e.read = 0;
      return channelEmit(e);
    }
    const channel = byTarget.get(detail.channel);
    e.channel = channel?.id;
    if (kind === "select") {
      byTarget.set(target, e);
      inspectors.set(target, detail.slots);
      e.state = "waiting";
      e.reports = 0;
      e.options = [detail.array ? "array" : "object", detail.unwrap && "unwrap"]
        .filter(Boolean)
        .join(", ");
      if (channel) {
        channel.owner = e.id;
        channel.hidden = e.hidden;
        channel.label = e.label;
        channel.stack = stack;
        touch(channel);
      }
      if (owner) {
        owner.select = e.id;
        owner.channel = channel?.id;
        touch(owner);
      }
      return selectEmit(e);
    }
    e.state = "running";
    e.source = byTarget.get(target)?.id;
    e.sourceText = preview(target);
    e.options = ["autoStart", "autoClose", "backPressure", "sendReturn"]
      .filter(key => detail[key])
      .join(", ");
    return feedEmit(e);
  };

  const slots = (id: number): GG.Slot[] | undefined => {
    const target = entries.get(id)?.ref.deref();
    const read = target && inspectors.get(target);
    return read?.()
      .slice(0, SLOT_LIMIT)
      .map(slot => {
        const val = slot.kind !== "plain" || slot.state?.[VAL];
        return {
          key: String(slot.key),
          kind:
            slot.kind === "raw" && slot.sync !== undefined
              ? `raw ${slot.sync ? "sync" : "async"}`
              : slot.kind,
          source: preview(slot.source),
          link: byTarget.get(slot.source)?.id,
          status: val ? slot.state.status : "plain",
          value: val
            ? slot.state.status === "rejected"
              ? preview(slot.state.reason)
              : preview(slot.state.value)
            : preview(slot.state),
          busy: slot.busy,
          finished: slot.finished,
        };
      });
  };

  // Components in a host's slots hang under the host, in slot order, and show the nodes of their slots.
  // An ended component stays while a host still has its slot, because the host keeps its nodes.
  // Mounts and other components hang under the closest node around them that a component shows, or a mount.
  const scan = () => {
    const parent = new Map<number, number>(),
      rank = new Map<number, number>(),
      shown = new Map<object, Entry>(),
      mounts = new Map<object, Entry>(),
      lists = new Map<object, Entry>(), // The each that yielded a node
      wrapper = new Map<number, Entry>(),
      sizes = new Map<number, number>(), // The items of each each, which an elements walk can cut
      live = [...entries.values()].filter(
        e =>
          e.kind === "mount" ||
          e.kind === "each" ||
          (e.kind === "component" && e.state !== "ended"),
      );
    const listed = new Set(live);
    let n = 0;
    for (const e of live) {
      const t = e.ref.deref() as any;
      if (e.kind === "mount" && t) mounts.set(t, e);
      if (e.kind === "component" && t?.nodeType && !shown.has(t))
        shown.set(t, e);
      if (e.inner && entries.has(e.inner.id))
        parent.set(e.inner.id, e.id), wrapper.set(e.inner.id, e);
    }
    // A wrapper's nodes belong to the innermost component.
    const innermost = (e: Entry): Entry => (e.inner ? innermost(e.inner) : e);
    for (const host of live) {
      const proxy = host.select
        ? entries.get(host.select)?.ref.deref()
        : undefined;
      const slots: any[] = (proxy && inspectors.get(proxy)?.()) ?? [];
      if (host.kind === "each") sizes.set(host.id, slots.length);
      for (const slot of slots) {
        const child = byTarget.get(slot.source);
        if (child?.kind !== "component" && child?.kind !== "each") continue;
        if (!listed.has(child)) listed.add(child), live.push(child);
        parent.set(child.id, host.id);
        rank.set(child.id, n++);
        // An each yields the nodes of its items, which belong to the item components.
        if (child.kind === "each")
          for (const node of slot.state?.value ?? []) lists.set(node, child);
        const value = child.kind === "each" ? [] : slot.state?.value;
        for (const node of Array.isArray(value) ? value : [value])
          if (node?.nodeType) shown.set(node, innermost(child));
      }
    }
    return { live, parent, rank, shown, mounts, lists, wrapper, sizes, n };
  };

  // Ids of DOM nodes are negative in the elements tree, so they never meet entry ids.
  const nodeIds = new WeakMap<Node, number>();
  let walkedNodes = new Map<number, WeakRef<Node>>(),
    focus: WeakRef<Node> | undefined; // A node that the walk reaches past its limit, as a picked one
  // The DOM under all connected hosts, in DOM order.
  // A run of nodes from one each, then from one component and its wrappers, hangs under rows for them.
  const elements = () => {
    const { shown, mounts, lists, wrapper, sizes } = scan(),
      nodes: [number, number, number][] = [],
      labels: [number, string, number][] = [],
      placed = new Set<number>();
    walkedNodes = new Map();
    const add = (id: number, parent: number) => {
      if (placed.has(id)) return;
      placed.add(id);
      nodes.push([id, parent, nodes.length]);
    };
    const chainOf = (e: Entry) => {
      const chain = [e];
      for (let w = wrapper.get(e.id); w; w = wrapper.get(w.id))
        chain.unshift(w);
      return chain;
    };
    const visit = (node: any, parent: number, near: boolean) => {
      let id = nodeIds.get(node);
      if (!id) nodeIds.set(node, (id = -nextNode++));
      walkedNodes.set(id, new WeakRef(node));
      add(id, parent);
      const text = node.nodeType === 3;
      labels.push([
        id,
        text ? preview(node.data.trim()) : tagOf(node),
        mounts.get(node)?.id ?? 0,
      ]);
      if (!text) walk(node, id, near);
    };
    const target = focus?.deref();
    // Children past the limit show as "… N more" rows, under the each that holds them, if any.
    // Past the limit, the walk still takes the siblings near the focus, and their whole subtrees.
    const walk = (node: Node, parent: number, near: boolean) => {
      const children = [...(node.childNodes as any)].filter(
        child =>
          child.nodeType === 1 || (child.nodeType === 3 && child.data.trim()),
      );
      const at = target
        ? children.findIndex(
            child => child.contains(target) || target.contains(child),
          )
        : -1;
      let list: Entry | undefined,
        skipped = 0,
        under = parent;
      const gap = () => {
        if (!skipped) return;
        const id = -nextNode++;
        add(id, under);
        labels.push([id, `… ${skipped} more`, 0]);
        skipped = 0;
      };
      children.forEach((child, i) => {
        const close = at >= 0 && i !== at && Math.abs(i - at) <= NEAR_FOCUS;
        if (walkedNodes.size >= ELEMENT_LIMIT && !near && !close && i !== at) {
          skipped++;
          under = lists.get(child)?.id ?? parent;
          return;
        }
        gap();
        const each = lists.get(child);
        if (each && each !== list) add(each.id, parent);
        list = each;
        let up = each ? each.id : parent;
        const by = shown.get(child);
        for (const e of by ? chainOf(by) : []) add(e.id, up), (up = e.id);
        visit(child, up, near || close);
      });
      gap();
    };
    // A mount of static children registers nothing, so the walk starts at the closest node around all hosts.
    let root: Node | null | undefined;
    for (const [target] of mounts)
      if ((target as Node).isConnected)
        for (root ??= target as Node; root && !root.contains(target as Node); )
          root = root.parentNode;
    if (root && root.nodeType !== 1) root = document.body;
    if (root) visit(root, 0, false);
    return { nodes, labels, sizes: [...sizes] };
  };

  const tree = () => {
    const scanned = scan(),
      { live, parent, rank, shown, mounts } = scanned;
    let { n } = scanned;
    const walked = new Set<number>(),
      anchor = new Map<number, Node>();
    for (const [node, e] of shown)
      if (!anchor.has(e.id)) anchor.set(e.id, node as Node);
    for (const e of live) {
      const t = e.ref.deref() as any;
      if (parent.has(e.id) || !t?.nodeType) continue;
      anchor.set(e.id, t);
      const self = e.kind === "mount" && shown.get(t);
      if (self) parent.set(e.id, self.id);
      else
        for (let x = t.parentNode; x; x = x.parentNode) {
          const up = shown.get(x) ?? mounts.get(x);
          if (up && up !== e) {
            parent.set(e.id, up.id);
            break;
          }
        }
      walked.add(e.id);
    }
    // Slot order is DOM order, so only a group with a walked node sorts by DOM position.
    const groups = new Map<number, Entry[]>();
    for (const e of live) {
      const p = parent.get(e.id) ?? 0;
      groups.get(p)?.push(e) ?? groups.set(p, [e]);
    }
    for (const group of groups.values()) {
      if (!group.some(e => walked.has(e.id))) continue;
      const at = (e: Entry) => anchor.get(e.id);
      group.sort((x, y) => {
        const a = at(x),
          b = at(y);
        if (!a || !b) return x.id - y.id;
        return a === b
          ? x.id - y.id
          : a.compareDocumentPosition(b) & 4
            ? -1
            : 1;
      });
      for (const e of group) rank.set(e.id, n++);
    }
    return live.map(
      e =>
        [e.id, parent.get(e.id) ?? 0, rank.get(e.id) ?? n + e.id] as [
          number,
          number,
          number,
        ],
    );
  };

  // The list gets summaries, and only the inspected objects send their logs and stacks.
  // So a page with thousands of channels sends small batches.
  // Objects from one site share a frame and a label, so a batch sends each site one time per connection.
  let siteIds = new Map<string, number>(),
    newSites: [number, string, string][] = [];
  const siteOf = (frame: string, label: string) => {
    const key = `${frame}\n${label}`;
    let id = siteIds.get(key);
    if (id === undefined) {
      siteIds.set(key, (id = siteIds.size));
      newSites.push([id, frame, label]);
    }
    return id;
  };
  const summary = (e: Entry): GG.Wire => {
    const {
      ref,
      version,
      readerIds,
      nextReader,
      readers,
      log,
      stack,
      inner,
      type,
      hidden,
      label,
      via,
      ...rest
    } = e;
    let consumers = 0;
    for (const reader of readers.values()) if (!reader.gone) consumers++;
    return { ...rest, site: siteOf(stack[0] ?? "", label), consumers };
  };
  // What the live readers in a component's function read, as the select that owns a channel, or the channel.
  // An item channel belongs to the component that holds its item, so only that one reads it.
  // Instances of one function share the other reads, so the detail counts the live ones if it has any.
  // The read log merges the reads of the component's readers, also of ended ones, with where they came from.
  const readsOf = (e: Entry, since: number) => {
    const type = e.type?.deref(),
      reads = new Map<number, Set<string> | undefined>(), // No set for a reader of all slots
      log = e.log.filter(item => item.seq > since);
    let shared = 0,
      byName = false;
    for (const c of entries.values()) {
      if (
        c.kind === "component" &&
        c.state === "live" &&
        c.type?.deref() === type
      )
        shared++;
      for (const r of c.readers.values()) {
        // A known instance decides, then the holder of an item, then the function name
        const named =
          !r.component &&
          !c.via &&
          !!type?.name &&
          !!callers.get(r)?.includes(type.name);
        const mine = r.component
          ? r.component === e.id
          : named || c.via === e.id;
        if (!mine) continue;
        const owner = c.owner ? entries.get(c.owner) : undefined,
          id = owner?.kind === "select" ? owner.id : c.id;
        for (const item of c.log)
          if (item.seq > since && item.reader === r.id && item.type === "read")
            log.push({ ...item, from: id });
        if (r.gone) continue;
        byName ||= named;
        const keys = reads.has(id) ? reads.get(id) : new Set<string>();
        if (keys && r.keys) keys.add(r.keys);
        reads.set(id, keys && r.keys ? keys : undefined);
      }
    }
    return {
      reads: [...reads].map(
        ([id, keys]) => [id, keys && [...keys].join(", ")] as [number, string?],
      ),
      shared: byName ? shared : 0,
      log: log.sort((a, b) => a.seq - b.seq).slice(-LOG_LIMIT),
    };
  };
  const detailOf = (id: number | undefined, since: number) => {
    const e = id ? entries.get(id) : undefined;
    return e
      ? {
          id: e.id,
          full: !since,
          stack: e.stack,
          readers: [...e.readers.values()].map(reader =>
            reader.label ? reader : Object.assign(reader, linkOf(e)),
          ),
          log: e.log.filter(item => item.seq > since),
          ...(e.kind === "component" && readsOf(e, since)),
        }
      : [];
  };

  // An item that a component reads links the props that hold it to its channel (DV-046).
  const link = (item: object, channel: object) => {
    const to = byTarget.get(channel);
    if (to)
      for (const [e, i] of holders.get(item) ?? []) {
        const prop = (e.props as [string, string, number?][])[i];
        prop[1] = "Item";
        prop[2] = to.id;
        to.via ??= e.id;
        touch(e);
      }
  };

  // A reader that opens while a host pulls a component belongs to that instance (DV-052).
  const instance = (reader: GG.Reader, source: unknown) => {
    const by = Object(source) === source && byTarget.get(source as object);
    if (by && by.kind === "component") reader.component = by.id;
  };
  // A changes reader is a consumer of the channel of its select, named by the code that opened it (DV-050).
  const readerHook = (target: object, detail: any) => {
    const owner = byTarget.get(detail.state),
      e = owner?.channel ? entries.get(owner.channel) : undefined;
    if (!e) return undefined;
    const reader = readerOf(e, target);
    consumerOf(reader);
    instance(reader, detail.source);
    // The reader of an each list opens inside the runtime, so its owner names it (DV-043)
    const list = detail.owner && byTarget.get(detail.owner);
    if (list?.kind === "each")
      Object.assign(reader, { label: "each", link: list.id, frame: undefined });
    if (detail.keys)
      reader.keys = clip(
        detail.keys.map((key: PropertyKey) => String(key)).join(", "),
        120,
      );
    record(e, "attach", "", { reader: reader.id });
    return (event: string, ops: any[]) => {
      if (event === "read") {
        const more = ops.length - OP_LIMIT;
        const text = ops
          .slice(0, OP_LIMIT)
          .map(opText)
          .concat(more > 0 ? [`… ${more} more`] : [])
          .join("\n");
        return record(e, "read", text, { reader: reader.id }); // DV-053
      }
      if (event !== "end") return;
      reader.gone = true; // DV-051
      record(e, "detach", "", { reader: reader.id });
    };
  };

  const hook = (
    kind: GG.Kind | "item" | "reader",
    target: object,
    detail: any,
  ) => {
    if (kind === "item") return void link(target, detail.channel); // DV-044
    if (kind === "reader")
      try {
        return readerHook(target, detail);
      } catch {
        return undefined; // DV-004
      }
    try {
      const raw = (new Error().stack ?? "").split("\n"),
        depth = kind === "mount" ? 5 : 4;
      own ||= urlOf(raw[1]) ?? "";
      for (let i = 2; i < depth; i++) {
        const url = urlOf(raw[i]);
        if (url) libs.add(url);
      }
      const stack = frames(raw, depth);
      const emit: ((...args: any[]) => void) | undefined = create(
        kind,
        target,
        detail,
        stack,
      );
      if (!emit) return undefined;
      return (...args: unknown[]) => {
        try {
          emit(...args);
        } catch {}
      };
    } catch {
      return undefined; // DV-004 needs a hook that never throws
    }
  };

  const treeKind = (e: Entry) =>
    e.kind === "component" || e.kind === "each" || e.kind === "mount";
  const poll = (since: number): GG.Poll => {
    if (!since) (siteIds = new Map()), (newSites = []);
    const shown = entries.get(inspect),
      details = [
        detailOf(inspect, detailSince),
        detailOf(shown?.kind === "select" ? shown.channel : 0, detailSince),
      ].flat();
    // The inspected object and what its detail links to go out even when hidden.
    const pinned = new Set<number | undefined>(
      shown && [
        shown.id,
        shown.owner,
        shown.channel,
        shown.select,
        shown.source,
      ],
    );
    for (const d of details) {
      for (const r of d.readers) pinned.add(r.link), pinned.add(r.component);
      for (const [id] of d.reads ?? []) pinned.add(id);
    }
    for (const [, , id] of shown?.props ?? []) pinned.add(id);
    const changed: GG.Wire[] = [];
    for (const e of entries.values())
      if (
        pinned.has(e.id) ||
        ((e.version > since || (treeFresh && treeKind(e))) &&
          (!e.hidden || (wantTree && treeKind(e))))
      )
        changed.push(summary(e));
    treeFresh = false;
    // A tree goes out only while the panel shows it, and only when it changes.
    let nodes: [number, number, number][] | undefined,
      labels: [number, string, number][] | undefined,
      sizes: [number, number][] | undefined;
    if (wantTree) {
      if (wantElements) ({ nodes, labels, sizes } = elements());
      else nodes = tree();
      const text = JSON.stringify([nodes, labels, sizes]);
      if (text === sentTree && since) nodes = labels = sizes = undefined;
      else sentTree = text;
    }
    return {
      tree: nodes,
      elements: labels,
      sizes,
      protocol: PROTOCOL,
      session,
      seq,
      entries: changed,
      sites: newSites.splice(0),
      count: entries.size,
      removed: removed.filter(([, at]) => at > since).map(([id]) => id),
      slots: inspect ? slots(inspect) : undefined,
      details,
      full: !since,
      picking: !!stopPick,
      picked: picked || undefined,
    };
  };

  function schedule() {
    if (connected && !paused && !timer) timer = setTimeout(flush, BATCH_MS);
  }
  function flush() {
    clearTimeout(timer);
    timer = undefined;
    if (!connected || paused) return;
    const data = poll(sentSeq);
    picked = 0;
    sentSeq = detailSince = data.seq;
    document.dispatchEvent(
      new CustomEvent("gg-devtools:page", { detail: JSON.stringify(data) }),
    );
  }

  // Scrolls a node into view and outlines it for a moment, as the gg way to show an element.
  const flash = (node: any) => {
    const element = node?.nodeType === 1 ? node : node?.parentElement;
    if (!element) return false;
    element.scrollIntoView({ block: "center" });
    const r = element.getBoundingClientRect(),
      box = document.createElement("div");
    box.style.cssText = `position:fixed;z-index:2147483647;pointer-events:none;background:rgba(111,168,220,.35);outline:1px solid #6fa8dc;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px`;
    document.documentElement.append(box);
    setTimeout(() => box.remove(), 1200);
    return true;
  };

  // A picker in the page, so a pick stays in the gg panel and skips the Elements panel, which is slow on a large DOM.
  // It blocks the presses and the click, so the page does not act on them.
  let stopPick: (() => void) | undefined,
    picked = 0;
  const pick = () => {
    stopPick?.();
    const box = document.createElement("div");
    box.style.cssText =
      "position:fixed;z-index:2147483647;pointer-events:none;display:none;background:rgba(111,168,220,.35);outline:1px solid #6fa8dc";
    document.documentElement.append(box);
    const over = (event: Event) => {
      const r = (event.target as Element).getBoundingClientRect?.();
      if (r)
        box.style.cssText += `;display:block;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px`;
    };
    const block = (event: Event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const choose = (event: Event) => {
      block(event);
      stopPick?.();
      hook.choose(event.target as Node);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      block(event);
      stopPick?.();
      flush();
    };
    const blocked = ["pointerdown", "mousedown", "pointerup", "mouseup"];
    addEventListener("mouseover", over, true);
    for (const type of blocked) addEventListener(type, block, true);
    addEventListener("click", choose, true);
    addEventListener("keydown", key, true);
    stopPick = () => {
      removeEventListener("mouseover", over, true);
      for (const type of blocked) removeEventListener(type, block, true);
      removeEventListener("click", choose, true);
      removeEventListener("keydown", key, true);
      box.remove();
      stopPick = undefined;
    };
  };

  // Commands from the panel, through relay.ts.
  document.addEventListener("gg-devtools:panel", event => {
    const command = JSON.parse((event as CustomEvent).detail);
    if (command.type === "connect") {
      connected = true;
      sentSeq = detailSince = 0;
    } else if (command.type === "disconnect") (connected = false), stopPick?.();
    else if (command.type === "pick") command.value ? pick() : stopPick?.();
    else if (command.type === "inspect") {
      inspect = command.id;
      detailSince = 0;
    } else if (command.type === "pause") paused = command.value;
    else if (command.type === "tree") {
      treeFresh = !wantTree && command.value; // A tree tab needs the hidden objects that earlier batches left out
      wantTree = command.value;
      wantElements = !!command.elements;
      sentTree = "";
    }
    flush();
  });

  // The component that shows a node, or a node around it, as for the node that the Elements panel selects.
  hook.ownerOf = (node: Node | null | undefined) => {
    const { shown } = scan();
    for (let x = node; x; x = x.parentNode) {
      const e = shown.get(x);
      if (e) return e.id;
    }
    return 0;
  };
  // The first node that a component shows, so the panel can reveal it with inspect().
  hook.nodeOf = (id: number) => {
    for (const [node, e] of scan().shown) if (e.id === id) return node;
  };
  // Shows the node of a component in the elements tab and in the page, with no Elements panel.
  hook.showNode = (id: number) => {
    const node = hook.nodeOf(id);
    wantTree = wantElements = true;
    picked = hook.domIdOf(node as Node | undefined);
    flush();
    return flash(node);
  };
  hook.flashDom = (id: number) => flash(walkedNodes.get(id)?.deref());
  // Sends the row of a node with the tree that holds it, as for a pick or a node that the Elements panel selects.
  hook.choose = (node: Node | null | undefined) => {
    picked = wantElements ? hook.domIdOf(node) : hook.ownerOf(node);
    flush();
  };

  // The node of an elements tree row, and the row of the closest walked node around a node.
  hook.domOf = (id: number) => walkedNodes.get(id)?.deref();
  hook.domIdOf = (node: Node | null | undefined) => {
    // The walk runs now, so a node past the limit has its row before this returns.
    focus = node ? new WeakRef(node) : undefined;
    if (wantTree && wantElements) elements(), (sentTree = ""), schedule();
    for (let x = node; x; x = x.parentNode) {
      const id = nodeIds.get(x);
      if (id && walkedNodes.has(id)) return id;
    }
    return 0;
  };

  // Gives a component's function, so the panel can open its source with inspect().
  hook.type = (id: number) => entries.get(id)?.type?.deref();

  // Logs the object to the console, and keeps it as $gg.
  hook.reveal = (id: number) => {
    const target = entries.get(id)?.ref.deref();
    if (target) console.log((g.$gg = target));
    return !!target;
  };

  if (!g[HOOK])
    Object.defineProperty(g, HOOK, { value: hook, configurable: true });
}
