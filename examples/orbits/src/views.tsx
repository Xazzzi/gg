import { type Channel, derive, each, type Item, iff, latest } from "@xazzzi/gg";
import { type Body, type Sim, STAR, type Stats } from "./sim.ts";

const TRAIL = 60,
  SAMPLES = 240,
  SVG = "http://www.w3.org/2000/svg";

/** Gives the last TRAIL positions of a body as polyline points. */
async function* trail(body: Item<Body>) {
  const points: string[] = [];
  for await (const { x, y } of body) {
    if (points.push(`${x.toFixed(1)},${y.toFixed(1)}`) > TRAIL) points.shift();
    yield points.join(" ");
  }
}

// Each dynamic prop reads the item, so the props end when its body leaves the list or the view unmounts.
const Planet = ({
  body,
  withTrail,
}: {
  body: Item<Body>;
  withTrail: Channel<boolean>;
}) => {
  const color = `hsl(${body.value.hue} 85% 65%)`;
  return (
    <g>
      {iff(withTrail, () => (
        <polyline class="trail" stroke={color} points={trail(body)} />
      ))}
      <circle
        r={body.value.r}
        fill={color}
        cx={derive(body, ({ x }) => x.toFixed(1))}
        cy={derive(body, ({ y }) => y.toFixed(1))}
      />
    </g>
  );
};

// A plain function component, because its children update themselves.
// title is an HTML tag too, so it needs xmlns to be an SVG title (JX-001).
export const Orrery = ({ sim }: { sim: Sim }) => {
  const zoom = latest<number>();
  let scale = 1;
  zoom.send(scale);
  // The wheel scales the view about the star, within a range.
  const wheel = (e: WheelEvent) => {
    e.preventDefault();
    zoom.send(
      (scale = Math.min(8, Math.max(0.2, scale * Math.exp(-e.deltaY * 0.001)))),
    );
  };
  return (
    <svg
      viewBox={derive(
        zoom,
        z => `${-300 / z} ${-300 / z} ${600 / z} ${600 / z}`,
      )}
      onwheel={wheel}
    >
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
        {each(
          sim.bodies,
          body => (
            <Planet body={body} withTrail={sim.trail} />
          ),
          // Each frame writes new bodies, so a key keeps each planet.
          { key: body => body.id },
        )}
      </g>
      <text x="-290" y="-280">
        {derive(sim.stats, s => `t ${s.tick}`)}
      </text>
    </svg>
  );
};

// Yields a new line per sample, and its read opens in a pull, so an unmount ends it at once (JX-041).
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
