import { Channel, feed, select } from "@xazzzi/gg";

export type Todo = { id: string; title: string; completed: boolean };
export type Action =
  | { type: "add"; title: string }
  | { type: "insert"; index: number; title: string }
  | { type: "toggle"; id: string }
  | { type: "toggleAll"; completed: boolean }
  | { type: "edit"; id: string; title: string }
  | { type: "remove"; id: string }
  | { type: "clearCompleted" };

// Bench mode starts empty, and saves apart from the real list.
export const BENCH = new URLSearchParams(location.search).has("bench");
const STORAGE = BENCH ? "gg-todomvc-bench" : "gg-todomvc";

const load = (): Todo[] => {
  try {
    return JSON.parse(localStorage.getItem(STORAGE) ?? "[]");
  } catch {
    return [];
  }
};

// A simulated slow save shows a promise slot that goes from pending to fulfilled.
const save = (items: Todo[]) =>
  new Promise<number>(resolve =>
    setTimeout(() => {
      localStorage.setItem(STORAGE, JSON.stringify(items));
      resolve(Date.now());
    }, 400),
  );

export const actions = new Channel<Action>();
export const send = (action: Action) => actions.send(action);
export type Send = typeof send;

// The UI reads the changes of todos with each, so state needs no UI code.
const todos = select(BENCH ? [] : load(), { autoClose: false });

// The route is a "latest" channel that a feed fills from hash changes.
async function* hashes() {
  for (;;) {
    yield location.hash.replace(/^#\/?/, "") || "all";
    await new Promise(resolve =>
      addEventListener("hashchange", resolve, { once: true }),
    );
  }
}
const route = new Channel<string>({
  firstReceive: "latest",
  thenReceive: "latest",
});
feed(hashes(), route, { autoStart: true, backPressure: false });

// A read of view.todos gives the todos select itself (SE-080).
export const view = select(
  { todos, filter: route, saved: Promise.resolve(0) },
  { unwrap: true },
);
export type View = typeof view;

const find = (id: string) => todos.findIndex(todo => todo.id === id);

async function reduce() {
  for await (const action of actions) {
    if (action.type === "add")
      todos.push({
        id: crypto.randomUUID(),
        title: action.title,
        completed: false,
      });
    else if (action.type === "insert")
      todos.splice(action.index, 0, {
        id: crypto.randomUUID(),
        title: action.title,
        completed: false,
      });
    else if (action.type === "toggle") {
      const i = find(action.id);
      if (i >= 0) todos[i] = { ...todos[i], completed: !todos[i].completed };
    } else if (action.type === "toggleAll")
      todos.forEach((todo, i) => {
        if (todo.completed !== action.completed)
          todos[i] = { ...todo, completed: action.completed };
      });
    else if (action.type === "edit") {
      const i = find(action.id);
      if (i < 0) continue;
      if (!action.title) todos.splice(i, 1);
      else if (todos[i].title !== action.title)
        todos[i] = { ...todos[i], title: action.title };
    } else if (action.type === "remove") {
      const i = find(action.id);
      if (i >= 0) todos.splice(i, 1);
    } else {
      // One splice replaces the list, because a splice per item is quadratic.
      todos.splice(0, todos.length, ...todos.filter(todo => !todo.completed));
    }
  }
}

// The todos channel keeps only the latest snapshot, so a slow save skips the ones between.
async function persist() {
  for await (const items of todos) await (view.saved = save(items));
}

reduce();
persist();
