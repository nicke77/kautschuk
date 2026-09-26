import { CAR_COLORS, type Car, type Track } from "./types";
import { trackBounds } from "./tracks";

export type View = { s: number; ox: number; oy: number };
export type Skid = { x: number; y: number; a: number; color: string };

const ASPHALT = "#141210";
const ASPHALT_2 = "#1b1814";
const CREAM = "#f4efe6";
const MUTED = "#6d655b";
const LINE = "#3a342c";

export function fitView(track: Track, w: number, h: number): View {
  const b = trackBounds(track);
  const pad = Math.max(18, Math.min(w, h) * 0.04);
  const s = Math.min((w - pad * 2) / b.w, (h - pad * 2) / b.h);
  return {
    s,
    ox: (w - b.w * s) / 2 - b.x * s,
    oy: (h - b.h * s) / 2 - b.y * s,
  };
}

function sx(view: View, x: number): number {
  return view.ox + x * view.s;
}
function sy(view: View, y: number): number {
  return view.oy + y * view.s;
}

export function drawWorld(
  ctx: CanvasRenderingContext2D,
  track: Track,
  cars: Car[],
  skids: Skid[],
  view: View,
  w: number,
  h: number,
  time: number,
  showCars: boolean,
): void {
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = ASPHALT;
  ctx.fillRect(0, 0, w, h);

  ctx.save();
  ctx.beginPath();
  poly(ctx, view, track.outer);
  ctx.fillStyle = ASPHALT_2;
  ctx.fill();
  ctx.clip();
  grain(ctx, w, h, time);

  ctx.beginPath();
  poly(ctx, view, track.inner);
  ctx.fillStyle = "#100e0c";
  ctx.fill();

  ctx.strokeStyle = LINE;
  ctx.lineWidth = Math.max(2, 5 * view.s);
  ctx.stroke();
  ctx.beginPath();
  poly(ctx, view, track.outer);
  ctx.strokeStyle = "#2a261f";
  ctx.lineWidth = Math.max(3, 8 * view.s);
  ctx.stroke();

  for (const oil of track.oils) {
    const x = sx(view, oil.x);
    const y = sy(view, oil.y);
    const rx = oil.rx * view.s;
    const ry = oil.ry * view.s;
    const g = ctx.createRadialGradient(x - rx * 0.2, y - ry * 0.3, rx * 0.1, x, y, Math.max(rx, ry));
    g.addColorStop(0, "rgba(210, 230, 214, 0.55)");
    g.addColorStop(0.35, "rgba(28, 42, 38, 0.9)");
    g.addColorStop(1, "rgba(12, 16, 14, 0.15)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(x, y, rx, ry, Math.sin(time * 0.4) * 0.15, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.lineCap = "round";
  for (const skid of skids) {
    ctx.strokeStyle = skid.color;
    ctx.globalAlpha = skid.a;
    ctx.lineWidth = Math.max(1.5, 8 * view.s);
    ctx.beginPath();
    ctx.moveTo(sx(view, skid.x), sy(view, skid.y));
    ctx.lineTo(sx(view, skid.x) + 0.6, sy(view, skid.y) + 0.6);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  const gate = track.gates[0];
  ctx.strokeStyle = CREAM;
  ctx.globalAlpha = 0.85;
  ctx.lineWidth = Math.max(2, 3 * view.s);
  ctx.setLineDash([8, 6]);
  ctx.beginPath();
  ctx.moveTo(sx(view, gate.a.x), sy(view, gate.a.y));
  ctx.lineTo(sx(view, gate.b.x), sy(view, gate.b.y));
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
  ctx.restore();

  if (!showCars) return;
  for (const car of cars) drawCar(ctx, car, view);
}

function poly(ctx: CanvasRenderingContext2D, view: View, pts: { x: number; y: number }[]): void {
  ctx.moveTo(sx(view, pts[0].x), sy(view, pts[0].y));
  for (let i = 1; i < pts.length; i++) ctx.lineTo(sx(view, pts[i].x), sy(view, pts[i].y));
  ctx.closePath();
}

function grain(ctx: CanvasRenderingContext2D, w: number, h: number, time: number): void {
  ctx.globalAlpha = 0.18;
  for (let i = 0; i < 40; i++) {
    const x = ((i * 97 + time * 8) % (w + 20)) - 10;
    const y = ((i * 53) % (h + 20)) - 10;
    ctx.fillStyle = i % 2 ? "#000" : "#3a332b";
    ctx.fillRect(x, y, 2, 2);
  }
  ctx.globalAlpha = 1;
}

function drawCar(ctx: CanvasRenderingContext2D, car: Car, view: View): void {
  const color = CAR_COLORS[car.id % CAR_COLORS.length];
  const x = sx(view, car.x);
  const y = sy(view, car.y);
  const s = Math.max(0.55, view.s);
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(car.heading);
  ctx.scale(s, s);
  ctx.fillStyle = "rgba(0,0,0,0.35)";
  ctx.beginPath();
  ctx.ellipse(2, 4, 16, 10, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(0, -20);
  ctx.lineTo(13, 14);
  ctx.lineTo(0, 8);
  ctx.lineTo(-13, 14);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "#141210";
  ctx.fillRect(-7, -2, 14, 7);
  if (car.skid > 0.45) {
    ctx.globalAlpha = car.skid;
    ctx.fillStyle = car.onOil ? "#d7ffe8" : "#f4efe6";
    ctx.fillRect(-12, 12, 4, 7);
    ctx.fillRect(8, 12, 4, 7);
  }
  ctx.restore();
  ctx.globalAlpha = 1;
  ctx.fillStyle = MUTED;
  ctx.font = `${Math.max(10, 11 * view.s)}px Outfit, Liberation Sans, sans-serif`;
  ctx.textAlign = "center";
  ctx.fillText(car.name, x, y - 22 * s);
}
