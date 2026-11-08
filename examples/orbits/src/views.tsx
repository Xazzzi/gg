import { each, type Item } from "@xazzzi/gg";
import { type Body, type Sim, STAR, type Stats } from "./sim.ts";

const TRAIL = 60,
  SAMPLES = 240,
  SVG = "http://www.w3.org/2000/svg";

/** Formats each value of a source, so the runtime keeps one live Text node. */
export async function* live<T>(
  source: AsyncIterable<T>,
  format: (value: T) => string,
) {
  for await (const value of source) yield format(value);
}

// A planet owns its nodes, and its loop ends when its body leaves the list or the view unmounts.
async function* Planet({ body }: { body: Item<Body> }) {
  const color = `hsl(${body.value.hue} 85% 65%)`;
  const trail = (
    <polyline class="trail" stroke={color} />
  ) as SVGPolylineElement;
  const dot = (<circle r={body.value.r} fill={color} />) as SVGCircleElement;
  yield (
    <g>
      {trail}
      {dot}
    </g>
  );
  const points: string[] = [];
  for await (const { x, y } of body) {
    dot.setAttribute("cx", x.toFixed(1));
    dot.setAttribute("cy", y.toFixed(1));
    if (points.push(`${x.toFixed(1)},${y.toFixed(1)}`) > TRAIL) points.shift();
    trail.setAttribute("points", points.join(" "));
  }
}

// A plain function component, because its children update themselves.
// title is an HTML tag too, so it needs xmlns to be an SVG title (JX-001).
export const Orrery = ({ sim }: { sim: Sim }) => (
  <svg viewBox="-300 -300 600 600">
    <title xmlns={SVG}>Bodies orbiting a star</title>
    <defs>
      <radialGradient id="glow">
        <stop offset="0" stop-color="#fff6c0" />
        <stop offset="0.35" stop-color="#ffb000" stop-opacity="0.6" />
        <stop offset="1" stop-color="#ff6000" stop-opacity="0" />
      </radialGradient>
      <filter id="soft">
        <feGaussianBlur stdDeviation="1.5" />
      </filter>
    </defs>
    <circle r="70" fill="url(#glow)" />
    <circle r={STAR} fill="#fff2b0" filter="url(#soft)" />
    <g>
      {each(sim.bodies, body => (
        <Planet body={body} />
      ))}
    </g>
    <text x="-290" y="-280">
      {live(sim.stats, s => `t ${s.tick}`)}
    </text>
  </svg>
);

// Yields a new line per sample, so an unmount ends it at the next sample (JX-041).
async function* Speed({ stats }: { stats: AsyncIterable<Stats> }) {
  const speeds: number[] = [];
  for await (const { speed } of stats) {
    if (speeds.push(speed) > SAMPLES) speeds.shift();
    const top = Math.max(...speeds) || 1;
    const points = speeds.map((s, i) => `${i},${58 - (s / top) * 54}`);
    yield <polyline class="line" points={points.join(" ")} />;
  }
}

export const Chart = ({ sim }: { sim: Sim }) => (
  <svg viewBox={`0 0 ${SAMPLES} 60`} preserveAspectRatio="none">
    <title xmlns={SVG}>Mean speed of the bodies</title>
    <Speed stats={sim.stats} />
  </svg>
);
