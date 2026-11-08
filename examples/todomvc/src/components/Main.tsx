import { derive, each } from "@xazzzi/gg";
import type { Send, View } from "../state.ts";
import { Row } from "./Row.tsx";

// Dynamic props follow the view, so the section needs no loop of its own.
export function Main({ view, send }: { view: View; send: Send }) {
  const toggleAll = (
    <input
      id="toggle-all"
      class="toggle-all"
      type="checkbox"
      checked={derive(
        view,
        ({ todos = [] }) =>
          todos.length > 0 && todos.every(todo => todo.completed),
      )}
      onchange={() => send({ type: "toggleAll", completed: toggleAll.checked })}
    />
  ) as HTMLInputElement;
  // each replays the changes of todos onto rows, so the list never diffs.
  return (
    <section
      class="main"
      hidden={derive(view, ({ todos = [] }) => !todos.length)}
    >
      {toggleAll}
      <label for="toggle-all">Mark all as complete</label>
      <ul
        class={derive(
          view,
          ({ filter = "all" }) => `todo-list filter-${filter}`,
        )}
      >
        {each(view.todos, todo => (
          <Row todo={todo} send={send} />
        ))}
      </ul>
    </section>
  );
}
