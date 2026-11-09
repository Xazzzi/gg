import { derive, mount } from "@xazzzi/gg";
import { Footer } from "./components/Footer.tsx";
import { Header } from "./components/Header.tsx";
import { Main } from "./components/Main.tsx";
import { BENCH, send, view } from "./state.ts";

const $ = (selector: string) => document.querySelector(selector) as Element;
mount(
  $(".todoapp"),
  <Header send={send} />,
  <Main view={view} send={send} />,
  <Footer view={view} send={send} />,
);
// A text child follows the save state, so the runtime changes one Text node.
mount(
  $(".saved"),
  derive(view, "saved", saved => (saved ? "Saved" : "Saving…")),
);
($(".new-todo") as HTMLInputElement).focus();
if (BENCH) import("./bench.ts");
