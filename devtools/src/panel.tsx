import { Channel, select } from "@xazzzi/gg";
import { type Child, each, Fragment, mount } from "@xazzzi/gg/jsx-runtime";
import { type Origin, originAt } from "./names.ts";

const HOOK = 'globalThis[Symbol.for("gg.devtools")]';
const PROTOCOL = 7; // Keep equal to the hook's
const TREE_LIMIT = 2000; // The tree shows this many rows
const LOG_LIMIT = 500;
const GROUP = 10; // More objects from one site collapse to one row
const GROUP_LIMIT = 200; // An open group shows this many rows

// Batches fill the store, and a write to `state` tells the components to read it again.
const entries = new Map<number, GG.Entry>();
const details = new Map<number, GG.Detail>();
// A stack line resolves one time, so objects from one site share a name and an original site.
const origins = new Map<string, Origin | undefined>();
const expanded = new Set<string>();
// Tree nodes that differ from their default, which is open except for a long each.
const toggled = new Set<number>();
let tree: [number, number, number][] = [];
// The label and host entry of each DOM node row in the elements tree, which has negative ids.
let labels = new Map<number, [string, number]>();
let scripts = new Map<string, Promise<string | undefined>>();
// The frame and label of each site that the page sent in this connection.
let sites = new Map<number, [string, string]>();
let session = "",
  slots: GG.Slot[] | undefined;

const state = select(
  {
    version: 0,
    filter: "",
    selected: 0,
    paused: false,
    tab: "data" as Tab,
    status: "Waiting for the page, reload it if it loaded before the extension",
  },
  { autoStart: true, autoClose: false, backPressure: false },
);
type Tab = "data" | "components" | "elements";
type View = {
  version: number;
  filter: string;
  selected: number;
  paused: boolean;
  tab: Tab;
  status: string;
};
const changed = () => state.version++;
const latest = <T,>() =>
  new Channel<T>({ firstReceive: "latest", thenReceive: "latest" });

const evaluate = <T,>(expression: string) =>
  new Promise<T>((resolve, reject) =>
    chrome.devtools.inspectedWindow.eval(expression, (result, error) =>
      error ? reject(new Error(error.value ?? "eval failed")) : resolve(result),
    ),
  );

const time = (at: number) => {
  const d = new Date(at);
  return `${d.toTimeString().slice(0, 8)}.${String(d.getMilliseconds()).padStart(3, "0")}`;
};
// The page's own copy of a script comes first, so that it matches what ran.
const load = (url: string) => {
  let text = scripts.get(url);
  if (!text)
    scripts.set(
      url,
      (text = new Promise<string | undefined>(resolve =>
        chrome.devtools.inspectedWindow.getResources(all => {
          const resource = all.find(r => r.url === url);
          if (!resource) return resolve(undefined);
          resource.getContent(content => resolve(content ?? undefined));
        }),
      ).then(
        content =>
          content ??
          fetch(url).then(
            r => (r.ok ? r.text() : undefined),
            () => undefined,
          ),
      )),
    );
  return text;
};
// A feed without a binding takes the names of its source and channel.
const nameOf = (e?: GG.Entry): string | undefined => {
  if (!e) return;
  if (e.kind === "component") return `<${e.sourceText}>`;
  if (e.kind === "mount") return e.sourceText;
  if (e.kind === "each")
    return `each ${nameOf(entries.get(e.source ?? 0)) ?? (e.source ? `#${e.source}` : "")}`.trim();
  const name = origins.get(e.frame)?.name;
  if (name || e.kind !== "feed") return name;
  const to = nameOf(entries.get(e.channel ?? 0));
  return to && `${nameOf(entries.get(e.source ?? 0)) ?? ""} → ${to}`.trim();
};
const named = (name?: string) =>
  name ? [" ", <span class="name">{name}</span>] : null;

const pick = (id: number) => {
  state.selected = id;
  slots = undefined;
  details.clear();
  send({ type: "inspect", id });
};
const link = (id?: number) => {
  const e = id ? entries.get(id) : undefined;
  return e ? (
    <a onclick={() => pick(e.id)}>
      {e.kind} #{e.id}
      {named(nameOf(e))}
    </a>
  ) : id ? (
    `#${id} (gone)`
  ) : (
    "–"
  );
};
const originOf = (line: string) => {
  if (!origins.has(line)) {
    origins.set(line, undefined);
    const own = scripts;
    originAt(line, load).then(at => {
      if (!at || own !== scripts) return;
      origins.set(line, at);
      if (at.label)
        for (const e of entries.values())
          if (e.frame === line) e.label = at.label;
      changed();
    });
  }
  return origins.get(line);
};
// The promise rejects for a URL that DevTools does not know, such as a script from an old page.
const openResource = (url: string, row: number, column: number) =>
  Promise.resolve(
    chrome.devtools.panels.openResource(url, row - 1, column - 1),
  );
// Links a stack line to its source, the original one when a source map leads to it, in the Sources panel.
const frame = (line: string, text?: string) => {
  const match = /at (?:.+? \()?(.+?):(\d+):(\d+)\)?$/.exec(line);
  if (!match) return text ?? line;
  const [, url, row, column] = match,
    at = originOf(line),
    site = at?.label;
  const open = () =>
    (site
      ? openResource(at.url, at.line, at.column).catch(() =>
          openResource(url, +row, +column),
        )
      : openResource(url, +row, +column)
    ).catch(() => {});
  // A label that is a site, or a whole stack line, shows the original site.
  const shown =
    !site || (text && !/:\d+:\d+$/.test(text))
      ? (text ?? line)
      : text
        ? site
        : line.replace(/[^\s(]+:\d+:\d+(?=\)?$)/, site);
  return <a onclick={open}>{shown}</a>;
};
const pill = (state: string) => <span class={`pill ${state}`}>{state}</span>;

// A select's or a host's state follows its channel once that channel ends.
const stateOf = (e: GG.Entry) => {
  const channel =
    e.kind !== "channel" &&
    e.kind !== "feed" &&
    e.channel &&
    entries.get(e.channel);
  return channel && channel.state !== "open" ? channel.state : e.state;
};
const logOf = (id?: number) => (id && details.get(id)?.log) || [];
const counts = (e: GG.Entry) =>
  e.kind === "channel"
    ? `${e.sent}↑ ${e.read}↓ ${e.consumers}c`
    : e.kind === "select"
      ? `${e.reports} reports`
      : "";

// Writes only the positions whose key changed, so `each` sends values only to rows that change.
const sync = <T extends { key: string }>(rows: T[], items: T[]) => {
  items.forEach((item, i) => {
    if (rows[i]?.key !== item.key) rows[i] = item;
  });
  rows.length = items.length;
};
// A log only drops old items and adds new ones, so it replays as two splices.
const follow = (rows: GG.Item[], items: GG.Item[]) => {
  const first = items[0]?.seq ?? Number.POSITIVE_INFINITY,
    last = rows[rows.length - 1]?.seq ?? -1;
  let drop = 0;
  while (drop < rows.length && rows[drop].seq < first) drop++;
  if (drop) rows.splice(0, drop);
  rows.push(...items.filter(item => item.seq > last));
};

// Draws a part on each value, and yields it only when its text changes.
async function* part(feed: AsyncIterable<unknown>, draw: () => Child) {
  let text: string | undefined;
  for await (const _ of feed) {
    const node = Fragment({ children: draw() });
    if (node.textContent !== text) yield ((text = node.textContent), node);
  }
}
// A row that draws itself again on each value from its list.
async function* Drawn<T>({
  row,
  draw,
}: {
  row: AsyncIterable<T>;
  draw: (row: T) => Child;
}) {
  for await (const value of row) yield draw(value);
}

// A table that `each` fills, and that shows a note while it has no rows.
// It closes its rows when its feed closes, so the row components end too.
async function* Table<T>(props: {
  feed: Channel<View>;
  head: string[];
  write: (rows: T[]) => void;
  draw: (row: T) => Child;
  empty: () => string;
}) {
  const { feed, head, write, draw, empty } = props;
  const rows = select([] as T[], {
    autoStart: true,
    autoClose: false,
    nonYielding: true,
  });
  const blank = (<div class="empty" />) as HTMLElement;
  const box = (
    <div class="log">
      <table>
        <thead>
          <tr>
            {head.map(name => (
              <th>{name}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {each(rows, row => (
            <Drawn row={row as AsyncIterable<T>} draw={draw} />
          ))}
        </tbody>
      </table>
    </div>
  ) as HTMLElement;
  let shown: Node | undefined;
  try {
    for await (const _ of feed) {
      const pinned = box.scrollTop + box.clientHeight >= box.scrollHeight - 4;
      write(rows);
      blank.textContent = empty();
      const next = rows.length ? box : blank;
      if (next !== shown) yield (shown = next);
      if (pinned)
        requestAnimationFrame(() => (box.scrollTop = box.scrollHeight));
    }
  } finally {
    rows[Symbol.dispose]();
  }
}
// A consumer is a function, a site, or a slot of a select or a feed.
const consumer = (r?: GG.Reader) =>
  !r
    ? ""
    : r.link
      ? `${r.label} ${nameOf(entries.get(r.link)) ?? `#${r.link}`}`
      : (r.label ?? "");

// Replaces the options of a filter when they change, and keeps its choice when it still exists.
const fill = (select: HTMLSelectElement, options: [string, string][]) => {
  const text = JSON.stringify(options);
  if (select.dataset.options === text) return;
  select.dataset.options = text;
  const value = select.value;
  select.replaceChildren(
    select.options[0],
    ...options.map(
      ([v, label]) => (<option value={v}>{label}</option>) as Node,
    ),
  );
  select.value = options.some(([v]) => v === value) ? value : "";
};

// A log filters by event type and by consumer, and starts over when a filter changes.
const Log = (props: {
  feed: Channel<View>;
  items: () => GG.Item[];
  columns: ("n" | "reader")[];
  readers?: () => GG.Reader[];
}) => {
  const type = (
    <select onchange={changed}>
      <option value="">All events</option>
    </select>
  ) as HTMLSelectElement;
  const reader = (
    <select onchange={changed}>
      <option value="">All consumers</option>
    </select>
  ) as HTMLSelectElement;
  const known = () => new Map((props.readers?.() ?? []).map(r => [r.id, r]));
  let key = "";
  return [
    <div class="filters">
      {type}
      {props.readers ? reader : null}
    </div>,
    <Table
      feed={props.feed}
      head={["time", "event", ...props.columns, "value"]}
      write={(rows: GG.Item[]) => {
        const all = props.items();
        fill(
          type,
          [...new Set(all.map(item => item.type))].map(t => [t, t]),
        );
        fill(
          reader,
          [...known().values()].map(r => [
            `${r.id}`,
            `#${r.id} ${consumer(r)}`,
          ]),
        );
        const next = `${type.value} ${reader.value}`;
        if (next !== key) (key = next), (rows.length = 0);
        follow(
          rows,
          all.filter(
            item =>
              (!type.value || item.type === type.value) &&
              (!reader.value || `${item.reader}` === reader.value),
          ),
        );
      }}
      draw={(item: GG.Item) => (
        <tr>
          <td>{time(item.time)}</td>
          <td>{item.type}</td>
          {props.columns.map(column => (
            <td>
              {column === "reader" && item.reader
                ? `${item.reader} ${consumer(known().get(item.reader))}`
                : (item[column] ?? "")}
            </td>
          ))}
          <td class="text">{item.text}</td>
        </tr>
      )}
      empty={() => "Nothing recorded"}
    />,
  ];
};

const props = (pairs: [string, Child | undefined][]) => (
  <dl>
    {pairs
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [<dt>{key}</dt>, <dd>{value}</dd>])}
  </dl>
);
const commas = (items: Child[]) =>
  items.flatMap((item, i) => (i ? [", ", item] : [item]));

const channelBody = (
  id: number,
  entry: () => GG.Entry,
  feed: Channel<View>,
) => [
  part(feed, () => {
    const e = entry(),
      feeds = [...entries.values()].filter(
        f => f.kind === "feed" && f.channel === id,
      );
    return props([
      ["options", e.options],
      ["owner", e.owner ? link(e.owner) : undefined],
      ["sent", `${e.sent}`],
      ["read", `${e.read}`],
      ["result", e.result],
      ["feeds", feeds.length ? commas(feeds.map(f => link(f.id))) : undefined],
    ]);
  }),
  <h4>Consumers</h4>,
  <Table
    feed={feed}
    head={["reader", "consumer", "last read", "behind"]}
    write={(rows: (GG.Reader & { key: string; behind: number })[]) => {
      const sent = entry().sent ?? 0;
      sync(
        rows,
        (details.get(id)?.readers ?? [])
          .filter(r => !r.gone)
          .map(r => ({
            ...r,
            behind: sent - r.pos,
            key: `${r.id} ${r.pos} ${sent} ${consumer(r)}`,
          })),
      );
    }}
    draw={r => (
      <tr>
        <td>{r.id}</td>
        <td class="text">
          {r.link
            ? [`${r.label} `, link(r.link)]
            : r.frame
              ? frame(r.frame, r.label)
              : (r.label ?? "–")}
        </td>
        <td>{r.pos || "–"}</td>
        <td>{r.behind}</td>
      </tr>
    )}
    empty={() => "No active consumer"}
  />,
  <h4>Messages</h4>,
  <Log
    feed={feed}
    items={() => logOf(id)}
    columns={["n", "reader"]}
    readers={() => details.get(id)?.readers ?? []}
  />,
];

const selectBody = (id: number, entry: () => GG.Entry, feed: Channel<View>) => {
  const channel = () => entries.get(entry().channel ?? 0);
  return [
    part(feed, () => {
      const e = entry(),
        c = channel();
      return props([
        ["shape", e.options],
        ["owner", e.owner ? link(e.owner) : undefined],
        [
          "channel",
          c ? `#${c.id} ${c.options}, ${c.consumers} consumers` : undefined,
        ],
        ["result", c?.result],
        ["reports", `${e.reports}`],
        ["snapshots", c ? `${c.sent}` : undefined],
      ]);
    }),
    <h4>
      {part(feed, () => `Slots${slots?.length === 500 ? ", first 500" : ""}`)}
    </h4>,
    <Table
      feed={feed}
      head={["key", "kind", "status", "value", "source", ""]}
      write={(rows: { key: string; slot: GG.Slot }[]) =>
        sync(
          rows,
          (slots ?? []).map(slot => ({
            slot,
            key: JSON.stringify(slot) + nameOf(entries.get(slot.link ?? 0)),
          })),
        )
      }
      draw={({ slot }) => (
        <tr>
          <td>{slot.key}</td>
          <td>{slot.kind}</td>
          <td>{pill(slot.status)}</td>
          <td class="text">{slot.value}</td>
          <td class="text">{slot.link ? link(slot.link) : slot.source}</td>
          <td>
            {slot.busy ? "busy " : ""}
            {slot.finished ? "finished" : ""}
          </td>
        </tr>
      )}
      empty={() =>
        slots ? "Empty shape" : "Slots are unavailable after collection"
      }
    />,
    <h4>Operations</h4>,
    <Log feed={feed} items={() => logOf(id)} columns={[]} />,
    <h4>Snapshots</h4>,
    <Log
      feed={feed}
      items={() => logOf(channel()?.id).filter(item => item.type === "send")}
      columns={["n"]}
    />,
    <h4>Channel events</h4>,
    <Log
      feed={feed}
      items={() => logOf(channel()?.id).filter(item => item.type !== "send")}
      columns={["n", "reader"]}
      readers={() => details.get(channel()?.id ?? 0)?.readers ?? []}
    />,
  ];
};

const hostBody = (id: number, entry: () => GG.Entry, feed: Channel<View>) => [
  part(feed, () => {
    const e = entry(),
      items = e.items ?? 0,
      parent = tree.find(([node]) => node === id)?.[1];
    return props([
      [
        "component",
        e.kind === "component" ? (
          <a
            title="Open the function in Sources"
            onclick={() => evaluate(`inspect(${HOOK}?.type?.(${id}))`)}
          >
            {e.sourceText}
          </a>
        ) : undefined,
      ],
      ["element", e.kind === "mount" ? e.sourceText : undefined],
      ["state", e.kind === "each" ? link(e.source) : undefined],
      ["owner", e.owner ? link(e.owner) : undefined],
      ["select", e.select ? link(e.select) : undefined],
      ["items", e.kind === "each" ? `${items}` : undefined],
      ["parent", parent ? link(parent) : undefined],
    ]);
  }),
  part(feed, () => {
    const pairs = entry().props ?? [];
    return pairs.length
      ? [
          <h4>Props</h4>,
          props(
            pairs.map(([key, text, to]) => [
              key,
              to ? link(to) : <span class="text">{text}</span>,
            ]),
          ),
        ]
      : null;
  }),
  <h4>Events</h4>,
  <Log feed={feed} items={() => logOf(id)} columns={[]} />,
];

const feedBody = (id: number, entry: () => GG.Entry, feed: Channel<View>) => [
  part(feed, () => {
    const e = entry();
    return props([
      ["source", e.source ? link(e.source) : e.sourceText],
      ["channel", link(e.channel)],
      ["options", e.options || "defaults off"],
    ]);
  }),
  <h4>Events</h4>,
  <Log feed={feed} items={() => logOf(id)} columns={[]} />,
];

// The parts of one object read the store on each value from `feed`.
// They keep the last summary, because a batch can remove the object first.
const Shown = ({ id, feed }: { id: number; feed: Channel<View> }) => {
  let last = entries.get(id) as GG.Entry;
  const entry = () => (last = entries.get(id) ?? last);
  const e = entry();
  const body =
    e.kind === "channel"
      ? channelBody
      : e.kind === "select"
        ? selectBody
        : e.kind === "feed"
          ? feedBody
          : hostBody;
  return [
    <h2>
      {e.kind} <span class="id">#{id}</span>
      {part(feed, () => named(nameOf(entry())))}{" "}
      {part(feed, () => pill(stateOf(entry())))}
      <button
        type="button"
        onclick={() => evaluate(`${HOOK}?.reveal?.(${id})`)}
      >
        Log to console
      </button>
      {e.kind === "component" ? (
        <>
          <button
            type="button"
            title="Select its node in the Elements tab, and outline it in the page"
            onclick={() => {
              showTab("elements");
              evaluate(`${HOOK}?.showNode?.(${id})`);
            }}
          >
            Show element
          </button>
          {inspectButton(`${HOOK}?.nodeOf?.(${id})`)}
        </>
      ) : null}
    </h2>,
    <div class="source">{frame(e.frame, e.label)}</div>,
    <details>
      <summary>Stack</summary>
      <pre>
        {part(feed, () =>
          (details.get(id)?.stack ?? [e.frame]).map((line, i) => [
            i ? "\n" : "",
            frame(line),
          ]),
        )}
      </pre>
    </details>,
    ...body(id, entry, feed),
  ];
};

// Yields a new section for each selection, and closes the feed of the old one, so its parts end.
// Opens a node in the Elements panel of Chrome, which is slow on a large DOM.
const inspectButton = (node: string) => (
  <button
    type="button"
    title="Open in the Elements panel of Chrome"
    onclick={() =>
      evaluate(
        `(n => (((n?.nodeType === 1 ? n : n?.parentElement)?.scrollIntoView({ block: "center" })), inspect(n)))(${node})`,
      )
    }
  >
    Inspect in Elements panel
  </button>
);
// A DOM node row of the elements tab, with its host entry.
const nodeDetail = (id: number) => {
  const [label, host] = labels.get(id) ?? ["", 0];
  return [
    <h2>
      node <span class="name">{label}</span>{" "}
      <button
        type="button"
        onclick={() => evaluate(`${HOOK}?.flashDom?.(${id})`)}
      >
        Show in page
      </button>
      {inspectButton(`${HOOK}?.domOf?.(${id})`)}
    </h2>,
    host ? props([["host", link(host)]]) : null,
  ];
};

async function* Detail() {
  let key = "",
    feed: Channel<View> | undefined;
  for await (const view of state) {
    const e = entries.get(view.selected),
      next = `${view.selected} ${e?.kind}`;
    if (next !== key) {
      feed?.close();
      key = next;
      feed = latest<View>();
      yield (
        <section id="detail">
          {e ? (
            <Shown id={e.id} feed={feed} />
          ) : view.selected < 0 && labels.has(view.selected) ? (
            nodeDetail(view.selected)
          ) : (
            <div class="empty">Select an object</div>
          )}
        </section>
      );
    }
    feed?.send(view);
  }
}

type Line = { key: string; draw: () => Child };
const row = (e: GG.Entry, selected: number, child = false): Line => {
  const name = nameOf(e),
    count = counts(e),
    status = stateOf(e);
  return {
    key: `row ${e.id} ${name} ${e.label} ${count} ${status} ${e.id === selected} ${child}`,
    draw: () => (
      <div
        class={`row${child ? " child" : ""}${e.id === selected ? " selected" : ""}`}
        onclick={() => pick(e.id)}
      >
        <span class="id">#{e.id}</span>
        {named(name)}
        <span class="label" title={e.label}>
          <bdi>{e.label}</bdi>
        </span>
        <span class="count">{count}</span>
        {pill(status)}
      </div>
    ),
  };
};
const site = (key: string, items: GG.Entry[]): Line => {
  const open = expanded.has(key),
    name = nameOf(items[0]),
    { label } = items[0],
    live = items.filter(e => stateOf(e) !== "closed").length;
  const toggle = () => {
    if (!expanded.delete(key)) expanded.add(key);
    changed();
  };
  return {
    key: `site ${key} ${open} ${items.length} ${name} ${live}`,
    draw: () => (
      <div class="row group" onclick={toggle}>
        <span class="id">
          {open ? "▾" : "▸"} ×{items.length}
        </span>
        {named(name)}
        <span class="label" title={label}>
          <bdi>{label}</bdi>
        </span>
        <span class="count">{live} not closed</span>
      </div>
    ),
  };
};
const note = (text: string): Line => ({
  key: `note ${text}`,
  draw: () => <div class="empty">{text}</div>,
});

const lines = ({ filter, selected }: View) => {
  const query = filter.toLowerCase(),
    out: Line[] = [];
  const all = [...entries.values()].filter(
    e =>
      !query ||
      `${e.kind} #${e.id} ${nameOf(e) ?? ""} ${e.label}`
        .toLowerCase()
        .includes(query),
  );
  const groups: [string, ...GG.Kind[]][] = [
    ["Selects", "select"],
    ["Channels", "channel"],
    ["Feeds", "feed"],
  ];
  for (const [title, ...kinds] of groups) {
    const sites = new Map<string, GG.Entry[]>();
    for (const e of all)
      if (kinds.includes(e.kind) && !e.owner) {
        const key = `${e.kind} ${e.label}`;
        sites.get(key)?.push(e) ?? sites.set(key, [e]);
      }
    if (!sites.size) continue;
    out.push({ key: `head ${title}`, draw: () => <h3>{title}</h3> });
    for (const [key, items] of sites) {
      if (items.length <= GROUP) {
        out.push(...items.map(e => row(e, selected)));
        continue;
      }
      out.push(site(key, items));
      if (!expanded.has(key)) continue;
      out.push(...items.slice(0, GROUP_LIMIT).map(e => row(e, selected, true)));
      if (items.length > GROUP_LIMIT)
        out.push(
          note(`${items.length - GROUP_LIMIT} more, filter by id to find one`),
        );
    }
  }
  return out.length ? out : [note("No gg objects yet")];
};

// A long each, or a DOM node with many children, starts closed.
const long = (id: number, count: number) =>
  (id < 0 || entries.get(id)?.kind === "each") && count > GROUP;
const known = (id: number) => (id < 0 ? labels.has(id) : entries.has(id));
const textOf = (id: number) =>
  id < 0 ? (labels.get(id)?.[0] ?? "") : (nameOf(entries.get(id)) ?? "");

// Mounts are hidden, so their children hang under the closest component or each.
const treeLines = ({ filter, selected }: View) => {
  const parentOf = new Map<number, number>(),
    rankOf = new Map<number, number>(),
    kids = new Map<number, number[]>();
  for (const [id, parent, rank] of tree)
    if (known(id)) parentOf.set(id, parent), rankOf.set(id, rank);
  const up = (id: number): number => {
    const p = parentOf.get(id) ?? 0;
    return p && entries.get(p)?.kind === "mount" ? up(p) : p;
  };
  for (const id of rankOf.keys()) {
    if (entries.get(id)?.kind === "mount") continue;
    const p = up(id);
    kids.get(p)?.push(id) ?? kids.set(p, [id]);
  }
  for (const list of kids.values())
    list.sort((a, b) => (rankOf.get(a) ?? 0) - (rankOf.get(b) ?? 0));
  // A filter shows the matches and their ancestors, all open.
  const query = filter.toLowerCase();
  let keep: Set<number> | undefined;
  if (query) {
    keep = new Set();
    for (const id of rankOf.keys())
      if (`#${id} ${textOf(id)}`.toLowerCase().includes(query))
        for (let x = id; x && !keep.has(x); x = up(x)) keep.add(x);
  }
  // The selected component and its ancestors, so a long list shows the rows around it.
  const path = new Set<number>();
  for (let x = selected; x && !path.has(x); x = up(x)) path.add(x);
  const out: Line[] = [];
  const gap = (
    id: number,
    depth: number,
    skipped: number,
    at: number,
  ): Line => ({
    key: `gap ${id} ${at} ${skipped} ${depth}`,
    draw: () => (
      <div class="empty" style={`padding-left: ${depth * 14 + 18}px`}>
        … {skipped} more
      </div>
    ),
  });
  const walk = (id: number, depth: number) => {
    if (out.length >= TREE_LIMIT || (keep && !keep.has(id))) return;
    const all = kids.get(id) ?? [],
      open = !!keep || long(id, all.length) === toggled.has(id);
    out.push(
      id < 0
        ? nodeRow(id, depth, all.length, open, selected)
        : treeRow(
            entries.get(id) as GG.Entry,
            depth,
            all.length,
            open,
            selected,
          ),
    );
    if (!open) return;
    const children = keep ? all.filter(child => keep.has(child)) : all;
    const at = children.findIndex(child => path.has(child)),
      head = Math.min(children.length, GROUP_LIMIT),
      from = at < head ? head : Math.max(head, at - 25),
      to = at < head ? head : Math.min(children.length, at + 25);
    for (let i = 0; i < head; i++) walk(children[i], depth + 1);
    if (from > head) out.push(gap(id, depth + 1, from - head, head));
    for (let i = from; i < to; i++) walk(children[i], depth + 1);
    if (to < children.length)
      out.push(gap(id, depth + 1, children.length - to, to));
  };
  for (const id of kids.get(0) ?? []) walk(id, 0);
  if (out.length >= TREE_LIMIT)
    out.push(note(`First ${TREE_LIMIT} rows, filter to find more`));
  return out.length
    ? out
    : [
        note(
          query ? "No match" : labels.size ? "No mounts" : "No components yet",
        ),
      ];
};
// A DOM node row, which links to the host entry of an element with dynamic children.
const nodeRow = (
  id: number,
  depth: number,
  count: number,
  open: boolean,
  selected: number,
): Line => {
  const [label, host] = labels.get(id) as [string, number];
  const toggle = (event: MouseEvent) => {
    event.stopPropagation();
    if (!toggled.delete(id)) toggled.add(id);
    changed();
  };
  return {
    key: `node ${id} ${label} ${depth} ${count} ${open} ${host} ${id === selected}`,
    draw: () => (
      <div
        class={`row tree${id === selected ? " selected" : ""}`}
        style={`padding-left: ${depth * 14 + 4}px`}
        onclick={() => pick(id)}
        ondblclick={() => evaluate(`${HOOK}?.flashDom?.(${id})`)}
        title="Double-click to show in the page"
      >
        <span class="twisty" onclick={toggle}>
          {count ? (open ? "▾" : "▸") : ""}
        </span>
        <span class={label.startsWith("<") ? "node" : "text"}>{label}</span>
        {host ? <span class="count">host</span> : null}
        {count && !open ? <span class="count">×{count}</span> : null}
      </div>
    ),
  };
};
const treeRow = (
  e: GG.Entry,
  depth: number,
  count: number,
  open: boolean,
  selected: number,
): Line => {
  const name = nameOf(e),
    status = stateOf(e);
  const toggle = (event: MouseEvent) => {
    event.stopPropagation();
    if (!toggled.delete(e.id)) toggled.add(e.id);
    changed();
  };
  return {
    key: `tree ${e.id} ${name} ${depth} ${count} ${open} ${status} ${e.id === selected}`,
    draw: () => (
      <div
        class={`row tree${e.id === selected ? " selected" : ""}`}
        style={`padding-left: ${depth * 14 + 4}px`}
        onclick={() => pick(e.id)}
        ondblclick={() =>
          e.kind === "component" &&
          evaluate(`inspect(${HOOK}?.type?.(${e.id}))`)
        }
        title={e.kind === "component" ? "Double-click to open the source" : ""}
      >
        <span class="twisty" onclick={toggle}>
          {count ? (open ? "▾" : "▸") : ""}
        </span>
        <span class={`name ${e.kind}`}>{name}</span>
        {e.kind === "each" ? <span class="count">×{count}</span> : null}
        {status === "live" ? null : pill(status)}
      </div>
    ),
  };
};

async function* List() {
  const rows = select([] as Line[], {
    autoStart: true,
    autoClose: false,
    nonYielding: true,
  });
  yield (
    <nav id="list">
      {each(rows, line => (
        <Drawn row={line} draw={(l: Line) => l.draw()} />
      ))}
    </nav>
  );
  for await (const view of state)
    sync(rows, view.tab === "data" ? lines(view) : treeLines(view));
}

async function* status() {
  for await (const view of state) yield view.status;
}

const Header = () => {
  const filter = (
    <input
      id="filter"
      type="search"
      placeholder="Filter"
      oninput={() => (state.filter = filter.value)}
    />
  ) as HTMLInputElement;
  const pause = (
    <button
      type="button"
      onclick={() => {
        state.paused = !state.paused;
        send({ type: "pause", value: state.paused });
        pause.textContent = state.paused ? "Resume" : "Pause";
      }}
    >
      Pause
    </button>
  ) as HTMLButtonElement;
  const clear = () => {
    for (const d of details.values()) d.log = [];
    changed();
  };
  // The page builds a tree only while a tree tab shows.
  const show = (showTab = (tab: Tab) => {
    state.tab = tab;
    tree = [];
    labels = new Map();
    sendTree(tab);
    for (const button of tabs)
      button.classList.toggle("active", button.dataset.tab === tab);
  });
  const tabs = (
    [
      ["data", "Data"],
      ["components", "Components"],
      ["elements", "Elements"],
    ] as const
  ).map(
    ([tab, title]) =>
      (
        <button
          type="button"
          data-tab={tab}
          class={`tab${state.tab === tab ? " active" : ""}`}
          onclick={() => show(tab)}
        >
          {title}
        </button>
      ) as HTMLButtonElement,
  );
  // The page picker selects in a tree tab, so a pick from the data tab opens the components tab.
  const picker = (
    <button
      type="button"
      id="pick"
      title="Select an element in the page"
      onclick={() => {
        const on = !picker.classList.contains("active");
        if (on && state.tab === "data") show("components");
        send({ type: "pick", value: on });
      }}
    >
      Pick
    </button>
  ) as HTMLButtonElement;
  return (
    <header>
      <span class="tabs">{tabs}</span>
      {picker}
      {filter}
      {pause}
      <button type="button" onclick={clear}>
        Clear logs
      </button>
      <span id="status">{status()}</span>
    </header>
  );
};

// Chrome loads content scripts only when the extension loads, so a page can run an older hook.
const apply = (batch: GG.Poll) => {
  if (batch.protocol !== PROTOCOL) {
    state.status =
      "The page runs another hook version, reload the extension and then the page";
    return;
  }
  if (batch.session !== session) {
    tree = [];
    state.selected = 0;
    origins.clear();
    scripts = new Map();
  }
  if (batch.tree) {
    tree = batch.tree;
    labels = new Map(
      (batch.elements ?? []).map(([id, label, host]) => [id, [label, host]]),
    );
  }
  if (batch.full) {
    entries.clear();
    details.clear();
    sites = new Map();
    // An inspect sent before the page connected is lost
    if (state.selected) send({ type: "inspect", id: state.selected });
  }
  session = batch.session;
  for (const [id, frame, label] of batch.sites) sites.set(id, [frame, label]);
  for (const { site, ...wire } of batch.entries) {
    const [frame, label] = sites.get(site) ?? ["", ""];
    const next: GG.Entry = {
      ...wire,
      frame,
      label: originOf(frame)?.label ?? label,
    };
    entries.set(next.id, next);
  }
  for (const next of batch.details) {
    const old = details.get(next.id);
    if (old && !next.full)
      next.log = old.log.concat(next.log).slice(-LOG_LIMIT);
    details.set(next.id, next);
  }
  for (const id of batch.removed) entries.delete(id), details.delete(id);
  if (batch.slots || batch.full) slots = batch.slots;
  state.status = `${batch.count} objects`;
  document.getElementById("pick")?.classList.toggle("active", batch.picking);
  if (batch.picked && known(batch.picked)) reveal(batch.picked);
  changed();
};

// The page pushes batches only on changes, so an idle page stays quiet in a performance trace.
// While disconnected, commands drop, and connect sends the current ones again.
const messages = new Channel<string>();
let port: chrome.runtime.Port | undefined;
const send = (command: object) => port?.postMessage(command);
// Header sets it, so the detail can switch tabs too.
let showTab: (tab: Tab) => void = () => {};
const sendTree = (tab: Tab) =>
  send({ type: "tree", value: tab !== "data", elements: tab === "elements" });
const connect = () => {
  port = chrome.runtime.connect({ name: "gg-panel" });
  port.onMessage.addListener(text => messages.send(text));
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    port = undefined;
    setTimeout(connect, 500);
  });
  send({ tabId: chrome.devtools.inspectedWindow.tabId });
  send({ type: "inspect", id: state.selected });
  if (state.paused) send({ type: "pause", value: true });
  sendTree(state.tab);
};
async function receive() {
  for await (const text of messages) apply(JSON.parse(text));
}

document.body.classList.toggle(
  "dark",
  chrome.devtools.panels.themeName === "dark",
);
mount(
  document.body,
  <Header />,
  <main>
    <List />
    <Detail />
  </main>,
);
// Opens the tree down to a component, and selects it.
const reveal = (id: number) => {
  const parentOf = new Map<number, number>(),
    count = new Map<number, number>();
  for (const [node, parent] of tree) {
    parentOf.set(node, parent);
    count.set(parent, (count.get(parent) ?? 0) + 1);
  }
  for (let p = parentOf.get(id) ?? 0; p; p = parentOf.get(p) ?? 0)
    if (long(p, count.get(p) ?? 0)) toggled.add(p);
    else toggled.delete(p);
  pick(id);
  // The list renders after the state changes, in a later task.
  setTimeout(
    () =>
      document
        .querySelector("#list .selected")
        ?.scrollIntoView({ block: "center" }),
    50,
  );
};
// The tree tabs follow the node that the Elements panel selects, to the component that shows it or to its row.
chrome.devtools.panels.elements.onSelectionChanged.addListener(() => {
  if (state.tab === "data") return;
  evaluate(`${HOOK}?.choose?.($0)`).catch(() => {});
});

receive();
connect();
