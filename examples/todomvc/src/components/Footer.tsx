import type { Send, View } from "../state.ts";

export async function* Footer({ view, send }: { view: View; send: Send }) {
  const count = (<span class="todo-count" />) as HTMLElement;
  const links = [
    ["#/", "All"],
    ["#/active", "Active"],
    ["#/completed", "Completed"],
  ].map(([hash, name]) => (<a href={hash}>{name}</a>) as HTMLAnchorElement);
  const clear = (
    <button
      class="clear-completed"
      type="button"
      onclick={() => send({ type: "clearCompleted" })}
    >
      Clear completed
    </button>
  ) as HTMLButtonElement;
  const footer = (
    <footer class="footer" hidden>
      {count}
      <ul class="filters">
        {links.map(link => (
          <li>{link}</li>
        ))}
      </ul>
      {clear}
    </footer>
  ) as HTMLElement;
  yield footer;
  for await (const { todos: items = [], filter = "all" } of view) {
    const left = items.filter(todo => !todo.completed).length;
    footer.hidden = !items.length;
    count.innerHTML = `<strong>${left}</strong> item${left === 1 ? "" : "s"} left`;
    clear.hidden = left === items.length;
    for (const link of links)
      link.classList.toggle(
        "selected",
        (link.hash.replace(/^#\/?/, "") || "all") === filter,
      );
  }
}
