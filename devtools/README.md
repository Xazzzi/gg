# gg devtools

A Chrome DevTools panel that shows gg channels, feeds and selects.

## Install

1. Run `npm run devtools`.
2. Open `chrome://extensions`, turn on developer mode, and load `devtools/` unpacked.
3. Reload the pages that you debug, one time.
4. Open DevTools, then the `gg` tab.

## How it works

`build/devtools/src/hook.js` runs in each page before its scripts, and installs the hook that `spec/devtools.md` defines.
The hook tracks objects from page start, so the panel can open at any time.
It keeps the last 500 events per object as text previews, and holds objects only through `WeakRef`.
While a panel is open, the hook pushes batches of changes through `relay.js` and the background worker.
A batch has a summary of each changed object, and the log and stack only of the inspected object.
The panel uses gg and its JSX runtime: `select` holds the panel state, and `each` fills the object list and the log tables.
`npm run devtools` compiles the extension and the library, and points the library imports at the compiled files, because extension pages have no import map.
The list collapses more than 10 objects from one creation site into one row, which a click opens.
An idle page sends nothing, and "Pause" stops the batches, so a performance trace stays clean.

- Channels show their options, sent and read counts, consumers and how far each is behind, and a message log.
- Selects show their slots, reported operations, snapshots and the events of their channel.
- Feeds show their source and target channel.
- The Components tab shows a tree of components and `each` lists, like React DevTools, and the Data tab lists selects, channels and feeds.
  A component nests under the host that drives it, or under the closest component or mount around its nodes.
  Its detail shows its props, with links to tracked objects, its parent, and a link that opens its function in Sources, as does a double-click in the tree.
  While the tab shows, a node that the Elements panel selects selects the component that shows it, and "Show element" goes back.
  The selects and item channels that the JSX runtime makes for a host are under its owner, not in the list.
- Consumers are named by the function that reads, such as `persist`, or by the select slot or feed that reads.
  Logs filter by event type and by consumer.
- A source that is a tracked channel or select links to it.
- "Log to console" logs the object, and keeps it as `$gg`.

Labels are the creation site, as a path for same-origin scripts, and a click opens it in Sources.
Names come from the binding at the creation site, such as `const todos = select(...)`, in the script that the page loaded.
A source map leads to the original code, and the extension needs access to all sites to fetch it.
A factory takes its function name, as `makeList()`, and a feed without a binding shows as `source → channel`.
Workers and iframes are not tracked yet.

## Try it

Run `npm run example`, and open http://127.0.0.1:5173/examples/todomvc/.
The server strips types from `.ts` files, so the example runs `src/` with no build.

`?bench` adds a benchmark panel to the example: 10k rows, then seeded random inserts, toggles and removals of completed rows.
Parameters are `rows`, `steps`, `ops` and `seed`, and `auto` starts the run on load.
Each step shows in a performance trace as a `gg-bench step` measure.
