// Times the JS cost of table and primitive workloads, apart from the suite, and prints one line for each.
import assert from "node:assert/strict";
import { setImmediate as settle } from "node:timers/promises";
import {
  Channel,
  each,
  type Item,
  jsx,
  mount,
  select,
  watch,
} from "../src/index.ts";
import { count } from "./bench-dom.ts";

type Row = { id: number; label: string; selected: boolean };

let nextId = 1;
const build = (size: number) =>
  Array.from(
    { length: size },
    (): Row => ({ id: nextId++, label: `row ${nextId}`, selected: false }),
  );
const report = (name: string, start: number) =>
  console.log(
    `${name.padEnd(34)} ${(performance.now() - start).toFixed(1).padStart(8)}ms`,
  );

const rows = select([] as Row[], { autoStart: true, backPressure: false });
async function* RowView({ row }: { row: Item<Row> }) {
  const { id } = row.value;
  const label: any = jsx("a", { onclick: () => {} });
  const tr: any = jsx("tr", {
    children: [
      jsx("td", { class: "col-md-1", children: id }),
      jsx("td", { class: "col-md-4", children: label }),
      jsx("td", {
        class: "col-md-1",
        children: jsx("a", {
          onclick: () => {},
          children: jsx("span", { class: "glyphicon", "aria-hidden": "true" }),
        }),
      }),
      jsx("td", { class: "col-md-6" }),
    ],
  });
  yield tr;
  for await (const item of row) {
    label.textContent = item.label;
    tr.className = item.selected ? "danger" : "";
  }
}
const tbody: any = document.createElement("tbody");
mount(
  tbody,
  each(rows, row => jsx(RowView, { row })),
);

/** Times run and the flushes after it, and checks the row count. */
const time = async (name: string, expected: number, run: () => void) => {
  const start = performance.now();
  run();
  await settle();
  await settle();
  report(name, start);
  assert.equal(count(tbody), expected, name);
};
const replace = (size: number) => {
  rows.length = 0;
  rows.push(...build(size));
};
const update = () => {
  for (let i = 0; i < rows.length; i += 10)
    rows[i] = { ...rows[i], label: `${rows[i].label}!` };
};
const pick = () => {
  rows[5] = { ...rows[5], selected: true };
};
const swap = () =>
  rows.splice(1, 998, rows[998], ...rows.slice(2, 998), rows[1]);

for (let i = 0; i < 5; i++) await time("warm up", 1000, () => replace(1000));
await time("create 1k", 1000, () => replace(1000));
await time("update every 10th of 1k", 1000, update);
await time("select a row of 1k", 1000, pick);
await time("swap rows of 1k", 1000, swap);
await time("remove a row of 1k", 999, () => rows.splice(500, 1));
await time("append 1k to 1k", 1999, () => rows.push(...build(1000)));
await time("clear 2k", 0, () => (rows.length = 0));
await time("create 10k", 10000, () => replace(10000));
await time("select a row of 10k", 10000, pick);
await time("update every 10th of 10k", 10000, update);
await time("remove a row of 10k", 9999, () => rows.splice(500, 1));
await time("swap rows of 10k", 9999, swap);
await time("append 1k to 10k", 10999, () => rows.push(...build(1000)));
await time("clear 11k", 0, () => (rows.length = 0));

const size = 200_000;
{
  const ch = new Channel<number>();
  const start = performance.now();
  for (let i = 0; i < size; i++) ch.send(i);
  ch.close();
  for await (const _ of ch);
  report("channel send and read 200k", start);
}
{
  const ch = new Channel<number>();
  const start = performance.now();
  (async () => {
    for (let i = 0; i < size; i++) await ch.asend(i);
    ch.close();
  })();
  for await (const _ of ch);
  report("channel asend and read 200k", start);
}
{
  const s = select({ a: 0, b: 0 }, { unwrap: true });
  const start = performance.now();
  (async () => {
    for (let i = 1; i <= 50_000; i++) {
      s.a = i;
      for (let tick = 0; tick < 4; tick++) await null;
    }
    s[Symbol.dispose]();
  })();
  for await (const _ of s);
  report("select write and snapshot 50k", start);
}
/** Times one write to each slot, with one watch reader for each slot. */
const watchers = async (name: string, s: any, keys: PropertyKey[]) => {
  const readers = keys.map(key => watch(s, key as never));
  await Promise.all(readers.map(reader => reader.next()));
  const start = performance.now();
  const reads = readers.map(reader => reader.next());
  for (const key of keys) s[key] = 1;
  await Promise.all(reads);
  report(name, start);
  s[Symbol.dispose]();
};
const keys = Array.from({ length: 2000 }, (_, i) => i);
await watchers(
  "2k index watchers, 2k sets",
  select(new Array(keys.length).fill(0), {
    autoStart: true,
    backPressure: false,
  }),
  keys,
);
await watchers(
  "2k key watchers, 2k sets",
  select(Object.fromEntries(keys.map(i => [`k${i}`, 0])), {
    autoStart: true,
    backPressure: false,
  }),
  keys.map(i => `k${i}`),
);
{
  const s = select(build(10000), { autoStart: true, backPressure: false });
  await settle();
  let start = performance.now();
  for (let i = 0; i < 100; i++) s.findIndex(row => row.id === -1);
  report("proxy findIndex of 10k, 100 times", start);
  start = performance.now();
  for (let i = 0; i < 2000; i++) s.shift();
  report("2k shifts of 10k", start);
  s[Symbol.dispose]();
}
