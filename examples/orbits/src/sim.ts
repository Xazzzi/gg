import { latest, outputs, select } from "@xazzzi/gg";
import { pull } from "./fmm.ts";

export type Body = {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  hue: number;
};
export type Stats = { tick: number; count: number; speed: number };
export type Sim = ReturnType<typeof createSim>;

// The star sits at the origin, and a body of radius r has mass G * r³.
// A mass pulls with its mass over the distance, as in two dimensions, so orbits stay bound.
export const STAR = 18;
const GM = 49,
  G = 0.0049,
  SOFT = 25,
  SUBSTEPS = 4;

let ids = 0;
/** Makes a body on a near circular orbit around the star. */
const orbit = (): Body => {
  const d = 60 + Math.random() * 200,
    a = Math.random() * 2 * Math.PI,
    v = Math.sqrt(GM) * (0.9 + Math.random() * 0.15);
  return {
    id: ids++,
    x: d * Math.cos(a),
    y: d * Math.sin(a),
    vx: -v * Math.sin(a),
    vy: v * Math.cos(a),
    r: 2 + Math.random() * 4,
    hue: (Math.random() * 360) | 0,
  };
};

/** Advances each body by dt frames under the star and the other bodies. */
const gravity = (list: Body[], dt = 1 / SUBSTEPS) => {
  const { ax, ay } = pull(
    list.map(b => b.x),
    list.map(b => b.y),
    list.map(b => G * b.r ** 3),
    SOFT,
  );
  return list.map((b, i) => {
    const k = -GM / (b.x ** 2 + b.y ** 2),
      vx = b.vx + (ax[i] + k * b.x) * dt,
      vy = b.vy + (ay[i] + k * b.y) * dt;
    return { ...b, x: b.x + vx * dt, y: b.y + vy * dt, vx, vy };
  });
};

/** Runs bodies around a star on animation frames, with no knowledge of any view. */
export const createSim = (count = 12) => {
  // Views read the bodies with each, so a view can mount at any time.
  const bodies = select(Array.from({ length: count }, orbit), {
    autoStart: true,
    backPressure: false,
  });
  const running = latest<boolean>(),
    trail = latest<boolean>(),
    stats = latest<Stats>(),
    pace = latest<number>();
  let tick = 0,
    frame = 0,
    rate = 1;
  const publish = () => {
    const speed = outputs(bodies).reduce(
      (sum, b) => sum + Math.hypot(b.vx, b.vy),
      0,
    );
    stats.send({
      tick,
      count: bodies.length,
      speed: speed / (bodies.length || 1),
    });
  };
  const advance = () => {
    let next = [...bodies];
    for (let i = 0; i < SUBSTEPS; i++) next = gravity(next, rate / SUBSTEPS);
    // A write per index gives each row its new value, and keeps the row.
    for (const [i, b] of next.entries()) bodies[i] = b;
    // Bodies that hit the star leave from the end, so lower indexes stay valid.
    for (let i = next.length; i--; )
      if (Math.hypot(next[i].x, next[i].y) < STAR) bodies.splice(i, 1);
    tick++;
    publish();
  };
  const loop = () => {
    advance();
    frame = requestAnimationFrame(loop);
  };
  const start = () => {
    if (frame) return;
    frame = requestAnimationFrame(loop);
    running.send(true);
  };
  const stop = () => {
    cancelAnimationFrame(frame);
    frame = 0;
    running.send(false);
  };
  const add = (n: number) => {
    bodies.push(...Array.from({ length: n }, orbit));
    publish();
  };
  running.send(false);
  pace.send(rate);
  trail.send(true);
  publish();
  return {
    bodies,
    trail,
    running,
    stats,
    pace,
    /** Sets the frames that one step advances. */
    setPace: (value: number) => pace.send((rate = value)),
    /** Adds bodies or removes them from the end, to have n. */
    resize(n: number) {
      if (n > bodies.length) add(n - bodies.length);
      else if (n < bodies.length) {
        bodies.splice(n, bodies.length - n);
        publish();
      }
    },
    start,
    stop,
    toggle: () => (frame ? stop() : start()),
    step: () => frame || advance(),
    add(n = 50) {
      bodies.push(...Array.from({ length: n }, orbit));
      publish();
    },
    remove(n = 50) {
      bodies.splice(0, n);
      publish();
    },
    setTrail(set: boolean) {
      trail.send(set);
    },
  };
};
