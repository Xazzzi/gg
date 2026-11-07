// Runs in the page before its scripts, and installs the hook that spec/devtools.md defines.
// It records from page start, so a panel that opens late still shows the history.
// While a panel is connected, changes go out in batches through a DOM event that relay.ts forwards.
// So an idle page runs no devtools work.
{
  const HOOK = Symbol.for("gg.devtools");
  const VAL = Symbol.for("gg.Val");
  const PROTOCOL = 3; // Keep equal to the panel's
  const LOG_LIMIT = 500;
  const BATCH_MS = 100;
  const SLOT_LIMIT = 500; // A large shape would make each batch heavy
  const OP_LIMIT = 20; // A report of a large shape would make one huge log item
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
    type?: WeakRef<(...args: never) => unknown>; // A component's function, which the panel can inspect
  };

  const session = Math.random().toString(36).slice(2);
  const entries = new Map<number, Entry>();
  const byTarget = new WeakMap<object, Entry>();
  const inspectors = new WeakMap<object, () => any[]>();
  const removed: [number, number][] = [];
  let seq = 0,
    nextId = 1,
    sentSeq = 0,
    inspect = 0,
    detailSince = 0,
    connected = false,
    paused = false,
    wantTree = false,
    sentTree = "",
    timer: ReturnType<typeof setTimeout> | undefined;

  const gone = new FinalizationRegistry<number>(id => {
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
  const consumerOf = (): Partial<GG.Reader> => {
    for (const raw of (new Error().stack ?? "").split("\n").slice(1)) {
      const line = raw.trim(),
        url = urlOf(line);
      if (!url || url === own || libs.has(url)) continue;
      const fn = /^at (?:async )?(?:new )?([^\s(]+) \(/
        .exec(line)?.[1]
        ?.split(".")
        .pop();
      return {
        label: fn && !fn.startsWith("<") ? fn : site(line),
        frame: line,
      };
    }
    return {};
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
      Object.assign(reader, consumerOf());
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
      created: Date.now(),
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
    if (kind === "component" || kind === "mount" || kind === "each") {
      const inner = byTarget.get(target);
      if (kind === "component" && inner?.kind === "component") e.inner = inner;
      byTarget.set(target, e);
      e.state = "live";
      if (kind === "mount") e.sourceText = tagOf(target);
      if (kind === "each") e.source = byTarget.get(detail.state)?.id;
      if (kind !== "component") return undefined; // DV-044
      e.sourceText = detail.type.name || "anonymous";
      e.type = new WeakRef(detail.type);
      e.props = Object.entries(detail.props ?? {})
        .filter(([key]) => key !== "children")
        .map(([key, value]) => [
          key,
          preview(value),
          byTarget.get(value as object)?.id,
        ]);
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
      if (e.inner && entries.has(e.inner.id)) parent.set(e.inner.id, e.id);
    }
    // A wrapper's nodes belong to the innermost component.
    const innermost = (e: Entry): Entry => (e.inner ? innermost(e.inner) : e);
    for (const host of live) {
      const proxy = host.select
        ? entries.get(host.select)?.ref.deref()
        : undefined;
      const slots: any[] = (proxy && inspectors.get(proxy)?.()) ?? [];
      for (const slot of slots) {
        const child = byTarget.get(slot.source);
        if (child?.kind !== "component" && child?.kind !== "each") continue;
        if (!listed.has(child)) listed.add(child), live.push(child);
        parent.set(child.id, host.id);
        rank.set(child.id, n++);
        // An each yields the nodes of its items, which belong to the item components.
        const value = child.kind === "each" ? [] : slot.state?.value;
        for (const node of Array.isArray(value) ? value : [value])
          if (node?.nodeType) shown.set(node, innermost(child));
      }
    }
    return { live, parent, rank, shown, mounts, n };
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
  const summary = (e: Entry): GG.Entry => {
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
      ...rest
    } = e;
    let consumers = 0;
    for (const reader of readers.values()) if (!reader.gone) consumers++;
    return { ...rest, frame: stack[0] ?? "", consumers };
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
        }
      : [];
  };

  const hook = (kind: GG.Kind, target: object, detail: object) => {
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

  const poll = (since: number): GG.Poll => {
    const changed: GG.Entry[] = [];
    for (const e of entries.values())
      if (e.version > since) changed.push(summary(e));
    const shown = entries.get(inspect);
    // A tree goes out only while the panel shows it, and only when it changes.
    let nodes: [number, number, number][] | undefined;
    if (wantTree) {
      nodes = tree();
      const text = JSON.stringify(nodes);
      if (text === sentTree && since) nodes = undefined;
      else sentTree = text;
    }
    return {
      tree: nodes,
      protocol: PROTOCOL,
      session,
      seq,
      entries: changed,
      removed: removed.filter(([, at]) => at > since).map(([id]) => id),
      slots: inspect ? slots(inspect) : undefined,
      details: [
        detailOf(inspect, detailSince),
        detailOf(shown?.kind === "select" ? shown.channel : 0, detailSince),
      ].flat(),
      full: !since,
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
    sentSeq = detailSince = data.seq;
    document.dispatchEvent(
      new CustomEvent("gg-devtools:page", { detail: JSON.stringify(data) }),
    );
  }

  // Commands from the panel, through relay.ts.
  document.addEventListener("gg-devtools:panel", event => {
    const command = JSON.parse((event as CustomEvent).detail);
    if (command.type === "connect") {
      connected = true;
      sentSeq = detailSince = 0;
    } else if (command.type === "disconnect") connected = false;
    else if (command.type === "inspect") {
      inspect = command.id;
      detailSince = 0;
    } else if (command.type === "pause") paused = command.value;
    else if (command.type === "tree") {
      wantTree = command.value;
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
