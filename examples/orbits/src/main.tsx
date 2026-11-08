import { type Child, mount } from "@xazzzi/gg";
import { createSim, latest } from "./sim.ts";
import { Chart, live, Orrery } from "./views.tsx";

const $ = (selector: string) => document.querySelector(selector) as Element;
const sim = createSim();

/** Mounts a view into stage at each other toggle, and unmounts it between, while the simulation runs on. */
const mountable = (stage: Element, view: () => Child) => {
  const shown = latest<boolean>();
  let unmount: (() => void) | undefined;
  const toggle = () => {
    if (unmount) unmount(), (unmount = undefined);
    else unmount = mount(stage, view());
    shown.send(!!unmount);
  };
  toggle();
  return { shown, toggle };
};

const orrery = mountable($(".orrery"), () => <Orrery sim={sim} />);
const chart = mountable($(".chart"), () => <Chart sim={sim} />);
const label = (shown: boolean) => (shown ? "Unmount" : "Mount");

mount(
  $(".controls"),
  <button type="button" class="run" onclick={sim.toggle}>
    {live(sim.running, on => (on ? "Stop" : "Start"))}
  </button>,
  <button type="button" onclick={() => sim.step()}>
    Step
  </button>,
  <button type="button" onclick={() => sim.add()}>
    Add 5
  </button>,
  <button type="button" class="view" onclick={orrery.toggle}>
    {live(orrery.shown, label)} orrery
  </button>,
  <button type="button" class="view" onclick={chart.toggle}>
    {live(chart.shown, label)} chart
  </button>,
);
mount(
  $(".status"),
  live(
    sim.stats,
    s => `t ${s.tick} · ${s.count} bodies · speed ${s.speed.toFixed(2)}`,
  ),
);
sim.start();
