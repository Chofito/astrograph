// Deterministic star/constellation visuals. No Math.random at runtime → identical
// output on server + client (no hydration mismatch), and an organic (non-grid) field.

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STAR_TINTS = [
  'var(--color-astro-star)',
  'var(--color-astro-star)',
  'var(--color-astro-star)',
  'var(--color-astro-purple)',
  'var(--color-astro-cyan)',
];

type Star = { cx: number; cy: number; r: number; o: number; dur: number; delay: number; fill: string };

function buildStars(seed: number, count: number, w: number, h: number): Star[] {
  const rand = mulberry32(seed);
  const stars: Star[] = [];
  for (let i = 0; i < count; i++) {
    const big = rand() > 0.92;
    stars.push({
      cx: Math.round(rand() * w),
      cy: Math.round(rand() * h),
      r: big ? 1.6 + rand() * 1.4 : 0.4 + rand() * 1.1,
      o: 0.18 + rand() * 0.72,
      dur: 2.6 + rand() * 5.5,
      delay: rand() * 6,
      fill: STAR_TINTS[Math.floor(rand() * STAR_TINTS.length)] ?? 'var(--color-astro-star)',
    });
  }
  return stars;
}

const FIELD_W = 1440;
const FIELD_H = 960;
// Two layers at different depths → real parallax drift (back slow, front faster).
const FAR_STARS = buildStars(20260603, 130, FIELD_W, FIELD_H);
const NEAR_STARS = buildStars(72050914, 46, FIELD_W, FIELD_H);

/** Full-bleed animated starfield background for the home page. */
export function Starfield() {
  return (
    <div className="astro-starfield" aria-hidden="true">
      <svg
        className="astro-starfield-layer astro-starfield-far"
        viewBox={`0 0 ${FIELD_W} ${FIELD_H}`}
        preserveAspectRatio="xMidYMid slice"
      >
        {FAR_STARS.map((s, i) => (
          <circle
            key={i}
            cx={s.cx}
            cy={s.cy}
            r={s.r}
            fill={s.fill}
            className="astro-star"
            style={{ opacity: s.o, animationDuration: `${s.dur}s`, animationDelay: `${s.delay}s` }}
          />
        ))}
      </svg>
      <svg
        className="astro-starfield-layer astro-starfield-near"
        viewBox={`0 0 ${FIELD_W} ${FIELD_H}`}
        preserveAspectRatio="xMidYMid slice"
      >
        {NEAR_STARS.map((s, i) => (
          <circle
            key={i}
            cx={s.cx}
            cy={s.cy}
            r={s.r + 0.5}
            fill={s.fill}
            className="astro-star astro-star-bright"
            style={{ opacity: s.o, animationDuration: `${s.dur}s`, animationDelay: `${s.delay}s` }}
          />
        ))}
      </svg>
    </div>
  );
}

// A real graph: nodes have coordinates; edges reference node indices, so lines
// ALWAYS connect to the dots. Loosely shaped like a code dependency graph.
const NODES: { x: number; y: number; r?: number }[] = [
  { x: 70, y: 96, r: 5 }, // 0
  { x: 150, y: 52, r: 4 }, // 1
  { x: 232, y: 104, r: 6 }, // 2 (hub)
  { x: 128, y: 168, r: 4 }, // 3
  { x: 320, y: 70, r: 4 }, // 4
  { x: 356, y: 176, r: 5 }, // 5
  { x: 262, y: 232, r: 4 }, // 6
  { x: 168, y: 286, r: 5 }, // 7
  { x: 74, y: 244, r: 4 }, // 8
  { x: 300, y: 312, r: 3 }, // 9
];
const EDGES: [number, number][] = [
  [0, 1], [1, 2], [2, 4], [4, 5], [2, 3], [0, 3],
  [3, 8], [3, 6], [6, 5], [6, 7], [7, 8], [6, 9], [5, 9],
];

/** Hero constellation — the graph motif (edges genuinely connect nodes). */
export function HeroConstellation() {
  return (
    <svg
      className="astro-constellation"
      viewBox="0 0 400 360"
      fill="none"
      aria-hidden="true"
    >
      <g className="astro-constellation-edges">
        {EDGES.map(([a, b], i) => (
          <line
            key={i}
            x1={NODES[a]!.x}
            y1={NODES[a]!.y}
            x2={NODES[b]!.x}
            y2={NODES[b]!.y}
            className="astro-edge"
            style={{ animationDelay: `${i * 140}ms` }}
          />
        ))}
      </g>
      <g className="astro-constellation-nodes">
        {NODES.map((n, i) => (
          <g key={i} style={{ animationDelay: `${i * 260}ms` }} className="astro-node-g">
            <circle cx={n.x} cy={n.y} r={(n.r ?? 4) + 6} className="astro-node-halo" />
            <circle cx={n.x} cy={n.y} r={n.r ?? 4} className="astro-node-core" />
          </g>
        ))}
      </g>
    </svg>
  );
}
