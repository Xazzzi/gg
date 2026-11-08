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
Objects that the JSX runtime makes, such as components and item channels, go out only while a tree tab shows, or when a detail links to them.
Objects from one site share one entry in a site table, so a 10k row list opens the panel with a batch of a few kB.
The panel uses gg and its JSX runtime: `select` holds the panel state, and `each` fills the object list and the log tables.
`npm run devtools` compiles the extension and the library, and points the library imports at the compiled files, because extension pages have no import map.
The list collapses more than 10 objects from one creation site into one row, which a click opens.
An idle page sends nothing, and "Pause" stops the batches, so a performance trace stays clean.

- Channels show their options, sent and read counts, consumers and how far each is behind, and a message log.
- Selects show their slots, reported operations, and the consumers and messages of their channel, where the `send` filter lists the snapshots.
- Feeds show their source and target channel.
- The Components tab shows a tree of components and `each` lists, like React DevTools, and the Data tab lists selects, channels and feeds.
- The Elements tab shows the DOM around all hosts, with rows for the component and the `each` list that show each run of nodes.
  An element with dynamic children is marked as a host, and a click opens its host entry.
  A double-click outlines the node in the page, and a node row has "Show", which outlines it, and "Inspect".
  A node that the Elements panel selects selects its row.
  It walks up to 5000 nodes, and a selected node with 100 siblings on each side, and shows the rest as "… N more".
- "Pick" selects an element in the page without the Elements panel, which is slow on a large DOM, and Escape cancels it.
  A component's "Show" selects its node in the Elements tab and outlines it in the page, and "Inspect" opens Chrome's Elements panel.
- A prop that holds an `Item` links to the item channel once the component reads it, and the channel names the component as its reader.
  A component nests under the host that drives it, or under the closest component or mount around its nodes.
  Its detail shows its props, with links to tracked objects, its parent, and a link that opens its function in Sources, as does a double-click in the tree.
  Its "Reads" section lists the channels and selects that live readers in its function read, also through helper functions that it calls.
  An item channel shows only under the component that holds its item.
  A reader that opens while its host resumes the component belongs to that instance, and its consumer row links to it.
  A reader that opens after an `await` or a `yield*`, such as right after `yield* use(context)`, matches by function name.
  Instances of one function share those reads, so the detail says how many are live.
  A component's Read log lists what its readers read, also readers that ended, with the select or channel of each read.
  While the tab shows, a node that the Elements panel selects selects the component that shows it, and "Show" goes back.
  The selects and item channels that the JSX runtime makes for a host are under its owner, not in the list.
- Consumers are named by the function that reads, such as `persist`, or by the select slot or feed that reads.
  A `changes` or `watch` reader shows as a consumer of the channel of its select, with the keys of a slice, and a component's Reads show them too.
  In a bundle, which shares one URL with the library, a consumer takes the name of the closest component function on its stack.
  Logs filter by event type and by consumer.
- A source that is a tracked channel or select links to it.
- A list with more children than the panel fits shows a tenth of a screen at each end, and the rest around the selected child.
  A "… N more" row moves that window, and so does a selection or a key move past its end.
  A list with more than 10 children starts closed, and so do its rows.
- The arrow keys move through the list and the trees: Up and Down move, Right opens a row or goes to its first child, Left closes it or goes to its parent, and Home and End jump.
  Down in the filter goes to the list.
- "Log" logs the object to the console, and keeps it as `$gg`.

Labels are the creation site, as a path for same-origin scripts, and a click opens it in Sources.
Names come from the binding at the creation site, such as `const todos = select(...)`, in the script that the page loaded.
A source map leads names, labels, stack lines and Sources links to the original code, and the extension needs access to all sites to fetch it.
A factory takes its function name, as `makeList()`, and a feed without a binding shows as `source → channel`.
Workers and iframes are not tracked yet.

## Try it

Run `npm run serve:examples`, and open http://localhost:5173/examples/todomvc/.

`?bench` adds a benchmark panel to the example: 10k rows, then seeded random inserts, toggles and removals of completed rows.
Parameters are `rows`, `steps`, `ops` and `seed`, and `auto` starts the run on load.
Each step shows in a performance trace as a `gg-bench step` measure.
