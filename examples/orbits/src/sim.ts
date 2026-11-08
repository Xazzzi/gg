import { Channel, select } from "@xazzzi/gg";

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
export const STAR = 18;
const GM = 5000,
  G = 0.5,
  SOFT = 25,
  EDGE = 450,
  SUBSTEPS = 4;

export const latest = <T>() =>
  new Channel<T>({ firstReceive: "latest", thenReceive: "latest" });

let ids = 0;
/** Makes a body on a near circular orbit around the star. */
const orbit = (): Body => {
  const d = 60 + Math.random() * 200,
    a = Math.random() * 2 * Math.PI,
    v = Math.sqrt(GM / d) * (0.9 + Math.random() * 0.15);
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
const gravity = (list: Body[], dt = 1 / SUBSTEPS) =>
  list.map(b => {
    const k = -GM / (b.x ** 2 + b.y ** 2) ** 1.5;
    let ax = k * b.x,
      ay = k * b.y;
    for (const o of list) {
      if (o === b) continue;
      const dx = o.x - b.x,
        dy = o.y - b.y,
        f = (G * o.r ** 3) / (dx * dx + dy * dy + SOFT) ** 1.5;
      ax += f * dx;
      ay += f * dy;
    }
    const vx = b.vx + ax * dt,
      vy = b.vy + ay * dt;
    return { ...b, x: b.x + vx * dt, y: b.y + vy * dt, vx, vy };
  });

/** Runs bodies around a star on animation frames, with no knowledge of any view. */
export const createSim = (count = 12) => {
  // Views read the bodies with each, so a view can mount at any time.
  const bodies = select(Array.from({ length: count }, orbit), {
    autoStart: true,
    autoClose: false,
    nonYielding: true,
  });
  const running = latest<boolean>(),
    stats = latest<Stats>();
  let tick = 0,
    frame = 0;
  const publish = () => {
    const list = [...bodies];
    const speed = list.reduce((sum, b) => sum + Math.hypot(b.vx, b.vy), 0);
    stats.send({ tick, count: list.length, speed: speed / (list.length || 1) });
  };
  const advance = () => {
    let next = [...bodies];
    for (let i = 0; i < SUBSTEPS; i++) next = gravity(next);
    // A write per index gives each row its new value, and keeps the row.
    for (const [i, b] of next.entries()) bodies[i] = b;
    // Bodies that hit the star or escape leave from the end, so lower indexes stay valid.
    for (let i = next.length; i--; ) {
      const d = Math.hypot(next[i].x, next[i].y);
      if (d < STAR || d > EDGE) bodies.splice(i, 1);
    }
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
  running.send(false);
  publish();
  return {
    bodies,
    running,
    stats,
    start,
    stop,
    toggle: () => (frame ? stop() : start()),
    step: () => frame || advance(),
    add(n = 5) {
      bodies.push(...Array.from({ length: n }, orbit));
      publish();
    },
  };
};
