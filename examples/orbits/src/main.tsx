import { type Child, derive, latest, mount } from "@xazzzi/gg";
import { createSim } from "./sim.ts";
import { Chart, Orrery } from "./views.tsx";

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
    {derive(sim.running, on => (on ? "Stop" : "Start"))}
  </button>,
  <button type="button" onclick={() => sim.step()}>
    Step
  </button>,
  <button type="button" onclick={() => sim.add(5)}>
    +50
  </button>,
  <button type="button" onclick={() => sim.remove()}>
    -50
  </button>,
  <label>
    Bodies
    <input
      type="range"
      min="0"
      max="1000"
      value={derive(sim.stats, s => s.count)}
      oninput={e => sim.resize(e.currentTarget.valueAsNumber)}
    />
  </label>,
  <label>
    Time step
    <input
      type="range"
      min="0.1"
      max="3"
      step="0.1"
      value={sim.pace}
      oninput={e => sim.setPace(e.currentTarget.valueAsNumber)}
    />
    {derive(sim.pace, p => p.toFixed(1))}
  </label>,
  <label>
    Trails
    <input
      type="checkbox"
      checked={sim.trail}
      onchange={e => sim.setTrail(e.currentTarget.checked)}
    />
  </label>,
  <button type="button" class="view" onclick={orrery.toggle}>
    {derive(orrery.shown, label)} orrery
  </button>,
  <button type="button" class="view" onclick={chart.toggle}>
    {derive(chart.shown, label)} chart
  </button>,
);
mount(
  $(".status"),
  derive(
    sim.stats,
    s => `t ${s.tick} · ${s.count} bodies · speed ${s.speed.toFixed(2)}`,
  ),
);
sim.start();
