import type { Send } from "../state.ts";

export function Header({ send }: { send: Send }) {
  const input = (
    <input
      class="new-todo"
      placeholder="What needs to be done?"
      onkeydown={(event: KeyboardEvent) => {
        const title = input.value.trim();
        if (event.key !== "Enter" || !title) return;
        send({ type: "add", title });
        input.value = "";
      }}
    />
  ) as HTMLInputElement;
  return (
    <header class="header">
      <h1>todos</h1>
      {input}
    </header>
  );
}
