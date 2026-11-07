// Seeds rows, then runs seeded random actions in steps, and reports the time of each step.
// Open ?bench, or ?bench&auto, with rows, steps, ops and seed as optional parameters.
import { type Action, actions, view } from "./state.ts";

const { todos } = view;

const params = new URLSearchParams(location.search);
const option = (key: string, fallback: number) =>
  Number(params.get(key)) || fallback;
const ROWS = option("rows", 10_000),
  STEPS = option("steps", 200),
  OPS = option("ops", 20),
  SEED = option("seed", 1);

// Mulberry32, so a seed gives the same run on each load.
const generator = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// A macrotask runs after all microtasks, so the actions, flushes and DOM writes are done.
// The browser can render before that task, so a step time can include a frame.
const settled = () => new Promise(resolve => setTimeout(resolve));

type Frame = PerformanceEntry & {
  renderStart: number;
  styleAndLayoutStart: number;
};
// Long animation frames split the time into work before rendering and the rendering itself.
const frames = () => {
  const list: Frame[] = [];
  const observer = new PerformanceObserver(entries =>
    list.push(...(entries.getEntries() as Frame[])),
  );
  try {
    observer.observe({ type: "long-animation-frame" });
  } catch {} // Chrome only
  return () => {
    list.push(...(observer.takeRecords() as Frame[]));
    observer.disconnect();
    const sum = (part: (frame: Frame) => number) =>
      list.reduce((total, frame) => total + part(frame), 0);
    const end = (frame: Frame) => frame.startTime + frame.duration;
    return {
      count: list.length,
      work: sum(f => (f.renderStart || end(f)) - f.startTime),
      render: sum(f => (f.renderStart ? end(f) - f.renderStart : 0)),
      layout: sum(f =>
        f.styleAndLayoutStart ? end(f) - f.styleAndLayoutStart : 0,
      ),
    };
  };
};

const panel = document.createElement("aside");
panel.className = "bench";
panel.innerHTML = `<b>Bench</b> ${ROWS} rows, ${STEPS} steps × ${OPS} ops, seed ${SEED}
  <button type="button">Run</button><pre></pre>`;
document.body.append(panel);
const output = panel.querySelector("pre") as HTMLElement;
const button = panel.querySelector("button") as HTMLButtonElement;

const stats = (times: number[]) => {
  const sorted = [...times].sort((a, b) => a - b);
  const at = (q: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  const total = times.reduce((a, b) => a + b, 0);
  return { median: at(0.5), p95: at(0.95), max: at(1), total };
};
const ms = (value: number) => `${value.toFixed(1)} ms`;

async function run() {
  button.disabled = true;
  output.textContent = "Running…";
  const random = generator(SEED);
  const pick = (size: number) => Math.floor(random() * size);
  let made = 0;
  const counts = { insert: 0, toggle: 0, remove: 0, clearCompleted: 0 };

  // Ops read the list before the reducer applies earlier ops of the step, as stale UI events do.
  const next = (): Action => {
    const roll = random(),
      size = todos.length;
    if (roll < 0.35 || !size) {
      counts.insert++;
      return { type: "insert", index: pick(size + 1), title: `Task ${++made}` };
    }
    if (roll < 0.9975) {
      let todo = todos[pick(size)];
      for (let i = 0; roll >= 0.8 && i < 20 && !todo.completed; i++)
        todo = todos[pick(size)];
      const remove = roll >= 0.8 && todo.completed;
      counts[remove ? "remove" : "toggle"]++;
      return { type: remove ? "remove" : "toggle", id: todo.id };
    }
    counts.clearCompleted++;
    return { type: "clearCompleted" };
  };

  todos.length = 0;
  await settled();
  const stop = frames();
  performance.mark("gg-bench seed");
  let start = performance.now();
  todos.push(
    ...Array.from({ length: ROWS }, (_, i) => ({
      id: `seed-${i}`,
      title: `Seed ${i}`,
      completed: random() < 0.3,
    })),
  );
  await settled();
  const seedScript = performance.now() - start;
  document.body.offsetHeight; // Forces style and layout
  const seedTotal = performance.now() - start;
  performance.measure("gg-bench seed", "gg-bench seed");

  const steps: number[] = [];
  for (let step = 0; step < STEPS; step++) {
    performance.mark("gg-bench step");
    start = performance.now();
    for (let i = 0; i < OPS; i++) actions.send(next());
    await settled();
    steps.push(performance.now() - start);
    performance.measure(`gg-bench step ${step}`, "gg-bench step");
    await new Promise(requestAnimationFrame); // Paints between steps, as the UI does
  }

  const step = stats(steps),
    frame = stop();
  const report = [
    `seed       ${ms(seedScript)} script, ${ms(seedTotal)} with layout`,
    `step       median ${ms(step.median)}, p95 ${ms(step.p95)}, max ${ms(step.max)}`,
    `ops        ${STEPS * OPS} in ${ms(step.total)}, ${Math.round((STEPS * OPS * 1000) / step.total)} ops/s`,
    `frames     ${frame.count} long: ${ms(frame.work)} work, ${ms(frame.render)} render, ${ms(frame.layout)} of it style and layout`,
    `mix        ${Object.entries(counts)
      .map(([k, v]) => `${k} ${v}`)
      .join(", ")}`,
    `rows       ${todos.length}`,
  ].join("\n");
  output.textContent = report;
  console.log(`gg bench\n${report}`);
  (globalThis as any).ggBench = {
    seedScript,
    seedTotal,
    step,
    frame,
    counts,
    rows: todos.length,
  };
  button.disabled = false;
}

button.addEventListener("click", run);
if (params.has("auto")) run();
