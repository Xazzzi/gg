import { each } from "@xazzzi/gg";
import type { Send, View } from "../state.ts";
import { Row } from "./Row.tsx";

export async function* Main({ view, send }: { view: View; send: Send }) {
  const toggleAll = (
    <input
      id="toggle-all"
      class="toggle-all"
      type="checkbox"
      onchange={() => send({ type: "toggleAll", completed: toggleAll.checked })}
    />
  ) as HTMLInputElement;
  // each replays the changes of todos onto rows, so the list never diffs.
  const rows = (
    <ul class="todo-list">
      {each(view.todos, todo => (
        <Row todo={todo} send={send} />
      ))}
    </ul>
  ) as HTMLUListElement;
  const main = (
    <section class="main" hidden>
      {toggleAll}
      <label for="toggle-all">Mark all as complete</label>
      {rows}
    </section>
  ) as HTMLElement;
  yield main;
  for await (const { todos: items = [], filter = "all" } of view) {
    main.hidden = !items.length;
    toggleAll.checked = items.length > 0 && items.every(todo => todo.completed);
    rows.className = `todo-list filter-${filter}`;
  }
}
