// Builds the benchmark table from gg sources from the parent repo, so a run measures the current code.
import { each, type Item, mount, select } from "@xazzzi/gg";

type Row = { id: number; label: string; selected: boolean };

const adjectives = [
  "pretty",
  "large",
  "big",
  "small",
  "tall",
  "short",
  "long",
  "handsome",
  "plain",
  "quaint",
  "clean",
  "elegant",
  "easy",
  "angry",
  "crazy",
  "helpful",
  "mushy",
  "odd",
  "unsightly",
  "adorable",
  "important",
  "inexpensive",
  "cheap",
  "expensive",
  "fancy",
]; // prettier-ignore
const colors = [
  "red",
  "yellow",
  "blue",
  "green",
  "pink",
  "brown",
  "purple",
  "brown",
  "white",
  "black",
  "orange",
]; // prettier-ignore
const nouns = [
  "table",
  "chair",
  "house",
  "bbq",
  "desk",
  "car",
  "pony",
  "cookie",
  "sandwich",
  "burger",
  "pizza",
  "mouse",
  "keyboard",
]; // prettier-ignore

const random = (max: number) => Math.round(Math.random() * 1000) % max;
let nextId = 1;
const build = (count: number) =>
  Array.from(
    { length: count },
    (): Row => ({
      id: nextId++,
      label: `${adjectives[random(adjectives.length)]} ${colors[random(colors.length)]} ${nouns[random(nouns.length)]}`,
      selected: false,
    }),
  );

// Only each reads the rows, so the select runs with no snapshot consumer.
const rows = select([] as Row[], {
  autoStart: true,
  autoClose: false,
  nonYielding: true,
});
let selected = 0;

const find = (id: number) => rows.findIndex(row => row.id === id);
// A splice that replaces all rows reuses entries by position, so the rows leave first.
const replace = (count: number) => {
  rows.length = 0;
  rows.push(...build(count));
};
const actions = {
  run: () => replace(1_000),
  runlots: () => replace(10_000),
  add: () => rows.push(...build(1_000)),
  update: () => {
    for (let i = 0; i < rows.length; i += 10)
      rows[i] = { ...rows[i], label: `${rows[i].label} !!!` };
  },
  clear: () => {
    rows.length = 0;
  },
  // One splice keeps all values, so applyOps moves the two rows by value (HE-04H).
  swaprows: () => {
    if (rows.length > 998)
      rows.splice(1, 998, rows[998], ...rows.slice(2, 998), rows[1]);
  },
};
const choose = (id: number) => {
  const prev = find(selected),
    next = find((selected = id));
  if (prev >= 0) rows[prev] = { ...rows[prev], selected: false };
  if (next >= 0) rows[next] = { ...rows[next], selected: true };
};
const remove = (id: number) => {
  const i = find(id);
  if (i >= 0) rows.splice(i, 1);
};

// A row builds its nodes from the first value, and changes them on each later value.
async function* RowView({ row }: { row: Item<Row> }) {
  const { id } = row.value;
  const label = (<a onclick={() => choose(id)} />) as HTMLAnchorElement;
  const tr = (
    <tr>
      <td class="col-md-1">{id}</td>
      <td class="col-md-4">{label}</td>
      <td class="col-md-1">
        <a onclick={() => remove(id)}>
          <span class="glyphicon glyphicon-remove" aria-hidden="true" />
        </a>
      </td>
      <td class="col-md-6" />
    </tr>
  ) as HTMLTableRowElement;
  yield tr;
  for await (const item of row) {
    label.textContent = item.label;
    tr.className = item.selected ? "danger" : "";
  }
}

const Button = ({ id, text }: { id: keyof typeof actions; text: string }) => (
  <div class="col-sm-6 smallpad">
    <button
      id={id}
      class="btn btn-primary btn-block"
      type="button"
      onclick={actions[id]}
    >
      {text}
    </button>
  </div>
);

mount(
  document.getElementById("main") as HTMLElement,
  <div class="container">
    <div class="jumbotron">
      <div class="row">
        <div class="col-md-6">
          <h1>gg-keyed</h1>
        </div>
        <div class="col-md-6">
          <div class="row">
            <Button id="run" text="Create 1,000 rows" />
            <Button id="runlots" text="Create 10,000 rows" />
            <Button id="add" text="Append 1,000 rows" />
            <Button id="update" text="Update every 10th row" />
            <Button id="clear" text="Clear" />
            <Button id="swaprows" text="Swap Rows" />
          </div>
        </div>
      </div>
    </div>
    <table class="table table-hover table-striped test-data">
      <tbody>
        {each(rows, row => (
          <RowView row={row} />
        ))}
      </tbody>
    </table>
    <span class="preloadicon glyphicon glyphicon-remove" aria-hidden="true" />
  </div>,
);
