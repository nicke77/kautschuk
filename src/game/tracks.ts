import type { Oil, Track, Vec } from "./types";

const ring = (x0: number, y0: number, x1: number, y1: number): Vec[] => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];

/**
 * Compact circuit so the whole track fits a phone and the cars still read.
 * Travel is screen-CCW: right along the bottom, up the right, left on top, down the left.
 */
function circuit(opts: {
  id: string;
  name: string;
  blurb: string;
  outer: [number, number, number, number];
  inner: [number, number, number, number];
  oils?: Oil[];
}): Track {
  const [ox0, oy0, ox1, oy1] = opts.outer;
  const [ix0, iy0, ix1, iy1] = opts.inner;
  const midX = (ox0 + ox1) / 2;
  const midY = (oy0 + oy1) / 2;
  const bottomY = (iy1 + oy1) / 2;
  const topY = (oy0 + iy0) / 2;
  const rightX = (ix1 + ox1) / 2;
  const leftX = (ox0 + ix0) / 2;
  const oils: Oil[] = opts.oils ?? [
    { x: rightX, y: (iy1 + oy1) / 2, rx: 52, ry: 34 },
    { x: rightX, y: (oy0 + iy0) / 2, rx: 52, ry: 34 },
    { x: leftX, y: (oy0 + iy0) / 2, rx: 46, ry: 32 },
    { x: leftX, y: (iy1 + oy1) / 2, rx: 58, ry: 36 },
  ];
  return {
    id: opts.id,
    name: opts.name,
    blurb: opts.blurb,
    outer: ring(ox0, oy0, ox1, oy1),
    inner: ring(ix0, iy0, ix1, iy1),
    oils,
    gates: [
      { a: { x: midX, y: iy1 }, b: { x: midX, y: oy1 }, nx: 1, ny: 0 },
      { a: { x: ix1, y: midY }, b: { x: ox1, y: midY }, nx: 0, ny: -1 },
      { a: { x: midX, y: oy0 }, b: { x: midX, y: iy0 }, nx: -1, ny: 0 },
      { a: { x: ox0, y: midY }, b: { x: ix0, y: midY }, nx: 0, ny: 1 },
    ],
    spawns: [
      { x: midX + 48, y: bottomY - 14, h: Math.PI / 2 },
      { x: midX + 96, y: bottomY + 16, h: Math.PI / 2 },
      { x: midX + 12, y: bottomY + 18, h: Math.PI / 2 },
      { x: midX + 132, y: bottomY - 6, h: Math.PI / 2 },
    ],
    line: [
      { x: midX + 110, y: bottomY },
      { x: rightX, y: iy1 + 24 },
      { x: rightX, y: midY },
      { x: rightX, y: iy0 - 24 },
      { x: midX, y: topY },
      { x: leftX, y: iy0 - 24 },
      { x: leftX, y: midY },
      { x: leftX, y: iy1 + 24 },
      { x: midX - 20, y: bottomY },
    ],
  };
}

export const TRACKS: Track[] = [
  circuit({
    id: "oljeringen",
    name: "Oljeringen",
    blurb: "Bred ring. Olja i varje hörn.",
    outer: [24, 72, 616, 568],
    inner: [168, 196, 472, 430],
  }),
  circuit({
    id: "harnolen",
    name: "Hårnålen",
    blurb: "Smal topp och en stor slick.",
    outer: [36, 64, 604, 576],
    inner: [176, 168, 480, 456],
    oils: [
      { x: 320, y: 116, rx: 120, ry: 36 },
      { x: 540, y: 516, rx: 48, ry: 32 },
      { x: 100, y: 320, rx: 40, ry: 70 },
    ],
  }),
];

export function trackBounds(track: Track): { x: number; y: number; w: number; h: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of track.outer) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}
