import { derive } from "@xazzzi/gg";
import type { Send, Todo, View } from "../state.ts";

const left = (todos: Todo[]) => todos.filter(todo => !todo.completed).length;

// Dynamic props and text children follow the view, so the footer needs no loop of its own.
export function Footer({ view, send }: { view: View; send: Send }) {
  const filters = [
    ["#/", "all", "All"],
    ["#/active", "active", "Active"],
    ["#/completed", "completed", "Completed"],
  ];
  return (
    <footer
      class="footer"
      hidden={derive(view, ({ todos = [] }) => !todos.length)}
    >
      <span class="todo-count">
        <strong>{derive(view, ({ todos = [] }) => left(todos))}</strong>
        {derive(view, ({ todos = [] }) =>
          left(todos) === 1 ? " item left" : " items left",
        )}
      </span>
      <ul class="filters">
        {filters.map(([hash, key, name]) => (
          <li>
            <a
              href={hash}
              class={derive(view, ({ filter = "all" }) =>
                filter === key ? "selected" : null,
              )}
            >
              {name}
            </a>
          </li>
        ))}
      </ul>
      <button
        class="clear-completed"
        type="button"
        hidden={derive(view, ({ todos = [] }) => left(todos) === todos.length)}
        onclick={() => send({ type: "clearCompleted" })}
      >
        Clear completed
      </button>
    </footer>
  );
}
