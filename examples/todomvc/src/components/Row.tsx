import type { Item } from "@xazzzi/gg";
import type { Send, Todo } from "../state.ts";

// A row owns its nodes, and changes them on each value from the list.
// The list closes the channel when the todo leaves, so the loop ends.
export async function* Row({ todo, send }: { todo: Item<Todo>; send: Send }) {
  // The list keys rows by id, so a row keeps its todo.
  const { id } = todo.value;
  const toggle = (
    <input
      class="toggle"
      type="checkbox"
      onchange={() => send({ type: "toggle", id })}
    />
  ) as HTMLInputElement;
  const label = (
    <label
      ondblclick={() => {
        li.classList.add("editing");
        edit.value = label.textContent ?? "";
        edit.focus();
      }}
    />
  ) as HTMLLabelElement;
  // Escape marks the field, so the blur that follows discards the edit.
  const edit = (
    <input
      class="edit"
      onkeydown={(event: KeyboardEvent) => {
        if (event.key === "Escape") edit.dataset.cancel = "1";
        if (event.key === "Enter" || event.key === "Escape") edit.blur();
      }}
      onblur={() => {
        li.classList.remove("editing");
        if (edit.dataset.cancel) delete edit.dataset.cancel;
        else send({ type: "edit", id, title: edit.value.trim() });
      }}
    />
  ) as HTMLInputElement;
  const li = (
    <li>
      <div class="view">
        {toggle}
        {label}
        <button
          class="destroy"
          type="button"
          onclick={() => send({ type: "remove", id })}
        />
      </div>
      {edit}
    </li>
  ) as HTMLLIElement;
  yield li;
  for await (const item of todo) {
    li.classList.toggle("completed", item.completed);
    toggle.checked = item.completed;
    label.textContent = item.title;
  }
}
