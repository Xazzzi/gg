import { mount } from "@xazzzi/gg";
import { Footer } from "./components/Footer.tsx";
import { Header } from "./components/Header.tsx";
import { Main } from "./components/Main.tsx";
import { Status } from "./components/Status.ts";
import { BENCH, send, view } from "./state.ts";

const $ = (selector: string) => document.querySelector(selector) as Element;
mount(
  $(".todoapp"),
  <Header send={send} />,
  <Main view={view} send={send} />,
  <Footer view={view} send={send} />,
);
mount($(".saved"), <Status view={view} />);
($(".new-todo") as HTMLInputElement).focus();
if (BENCH) import("./bench.ts");
