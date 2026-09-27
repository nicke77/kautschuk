import { RADIUS, type Car, type Input, type Track, type Vec } from "./types";

/** Heading 0 faces up. Clockwise is positive. A (steer +1) decreases heading so the nose goes left. */
export function forward(h: number): Vec {
  return { x: Math.sin(h), y: -Math.cos(h) };
}

export function rightVec(h: number): Vec {
  return { x: Math.cos(h), y: Math.sin(h) };
}

export function wrapAngle(a: number): number {
  let v = a;
  while (v > Math.PI) v -= Math.PI * 2;
  while (v < -Math.PI) v += Math.PI * 2;
  return v;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export function forwardSpeed(car: Pick<Car, "heading" | "vx" | "vy">): number {
  const f = forward(car.heading);
  return car.vx * f.x + car.vy * f.y;
}

function pointInPoly(poly: Vec[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x;
    const yi = poly[i].y;
    const xj = poly[j].x;
    const yj = poly[j].y;
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + 0.0000001) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

export function onTrack(track: Track, x: number, y: number): boolean {
  return pointInPoly(track.outer, x, y) && !pointInPoly(track.inner, x, y);
}

export function inOil(track: Track, x: number, y: number): boolean {
  for (const o of track.oils) {
    const dx = (x - o.x) / o.rx;
    const dy = (y - o.y) / o.ry;
    if (dx * dx + dy * dy <= 1) return true;
  }
  return false;
}

function closestOnPoly(poly: Vec[], x: number, y: number): Vec {
  let bestX = poly[0].x;
  let bestY = poly[0].y;
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const len2 = abx * abx + aby * aby;
    const t = len2 < 1e-6 ? 0 : clamp(((x - a.x) * abx + (y - a.y) * aby) / len2, 0, 1);
    const px = a.x + abx * t;
    const py = a.y + aby * t;
    const d2 = (x - px) ** 2 + (y - py) ** 2;
    if (d2 < best) {
      best = d2;
      bestX = px;
      bestY = py;
    }
  }
  return { x: bestX, y: bestY };
}

function polyCenter(poly: Vec[]): Vec {
  let x = 0;
  let y = 0;
  for (const p of poly) {
    x += p.x;
    y += p.y;
  }
  return { x: x / poly.length, y: y / poly.length };
}

function resolveWalls(car: Car, track: Track): boolean {
  let hit = false;
  for (let n = 0; n < 4; n++) {
    const outside = !pointInPoly(track.outer, car.x, car.y);
    const inHole = pointInPoly(track.inner, car.x, car.y);
    if (!outside && !inHole) break;
    hit = true;
    const poly = outside ? track.outer : track.inner;
    const c = closestOnPoly(poly, car.x, car.y);
    const center = polyCenter(poly);
    let ix = outside ? center.x - c.x : c.x - center.x;
    let iy = outside ? center.y - c.y : c.y - center.y;
    const mag = Math.hypot(ix, iy) || 1;
    ix /= mag;
    iy /= mag;
    car.x = c.x + ix * (RADIUS + 1);
    car.y = c.y + iy * (RADIUS + 1);
    const into = car.vx * -ix + car.vy * -iy;
    if (into > 0) {
      car.vx += ix * into;
      car.vy += iy * into;
    }
    car.vx *= 0.82;
    car.vy *= 0.82;
  }
  return hit;
}

function segmentsCross(a: Vec, b: Vec, c: Vec, d: Vec): boolean {
  const rx = b.x - a.x;
  const ry = b.y - a.y;
  const sx = d.x - c.x;
  const sy = d.y - c.y;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-8) return false;
  const qpx = c.x - a.x;
  const qpy = c.y - a.y;
  const t = (qpx * sy - qpy * sx) / den;
  const u = (qpx * ry - qpy * rx) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

function crossGates(car: Car, track: Track, x0: number, y0: number): void {
  if (car.finished) return;
  const a = { x: x0, y: y0 };
  const b = { x: car.x, y: car.y };
  const index = car.next;
  const gate = track.gates[index];
  if (!gate) return;
  if (!segmentsCross(a, b, gate.a, gate.b)) return;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (dx * gate.nx + dy * gate.ny <= 0) return;
  if (index === 0) car.lap += 1;
  car.next = (index + 1) % track.gates.length;
}

export function createCar(spawn: { x: number; y: number; h: number }, id: number, name: string, bot: boolean): Car {
  return {
    id,
    name,
    bot,
    x: spawn.x,
    y: spawn.y,
    heading: spawn.h,
    vx: 0,
    vy: 0,
    lap: 0,
    next: 1,
    drift: 0,
    chain: 0,
    skid: 0,
    onOil: false,
    finished: false,
    finishAt: -1,
    stuck: 0,
    wp: 0,
  };
}

export function stepCar(car: Car, input: Input, track: Track, dt: number, totalLaps: number): boolean {
  if (car.finished) {
    car.vx *= 1 - Math.min(1, 1.4 * dt);
    car.vy *= 1 - Math.min(1, 1.4 * dt);
    car.skid = Math.max(0, car.skid - dt * 2);
    return false;
  }

  const f = forward(car.heading);
  const r = rightVec(car.heading);
  car.onOil = inOil(track, car.x, car.y);

  const force = input.throttle * 520 - input.brake * 980;
  car.vx += f.x * force * dt;
  car.vy += f.y * force * dt;

  const drag = input.throttle < 0.08 && input.brake < 0.08 ? 1.15 : 0.62;
  car.vx -= car.vx * drag * dt;
  car.vy -= car.vy * drag * dt;

  const fwd = car.vx * f.x + car.vy * f.y;
  const lat = car.vx * r.x + car.vy * r.y;
  let grip = 2.05;
  if (car.onOil) grip *= 0.22;
  if (input.handbrake) grip *= 0.2;
  const damp = 1 - Math.exp(-grip * dt);
  car.vx -= r.x * lat * damp;
  car.vy -= r.y * lat * damp;

  const speed = Math.hypot(car.vx, car.vy);
  const auth = clamp(speed / 64, 0, 1);
  const reverse = fwd < -24 ? -1 : 1;
  // steer +1 is left: heading must decrease
  let yaw = -input.steer * 2.35 * auth * reverse;
  if (input.handbrake) yaw += -input.steer * 1.7 * auth;
  car.heading = wrapAngle(car.heading + yaw * dt);

  const maxSpeed = car.onOil ? 250 : 275;
  const sp = Math.hypot(car.vx, car.vy);
  if (sp > maxSpeed) {
    car.vx *= maxSpeed / sp;
    car.vy *= maxSpeed / sp;
  }

  const x0 = car.x;
  const y0 = car.y;
  car.x += car.vx * dt;
  car.y += car.vy * dt;
  const hit = resolveWalls(car, track);
  if (!onTrack(track, car.x, car.y)) {
    car.x = x0;
    car.y = y0;
    car.vx *= -0.15;
    car.vy *= -0.15;
  }
  crossGates(car, track, x0, y0);

  if (car.lap >= totalLaps) {
    car.finished = true;
    car.chain = 0;
  }

  const f2 = forward(car.heading);
  const r2 = rightVec(car.heading);
  const fwd2 = car.vx * f2.x + car.vy * f2.y;
  const lat2 = car.vx * r2.x + car.vy * r2.y;
  const spd2 = Math.hypot(car.vx, car.vy);
  const slip = Math.atan2(lat2, Math.max(48, Math.abs(fwd2)));
  const drifting = Math.abs(slip) > 0.2 && spd2 > 72 && !car.finished;
  if (drifting) {
    car.chain = Math.min(6, car.chain + dt * 0.85);
    const opposite = input.steer !== 0 && Math.sign(input.steer) !== Math.sign(lat2) ? 1.55 : 1;
    const oilBonus = car.onOil ? 1.65 : 1;
    const hbBonus = input.handbrake ? 1.28 : 1;
    car.drift += Math.abs(slip) * spd2 * (1 + car.chain * 0.55) * opposite * oilBonus * hbBonus * dt * 0.035;
    car.skid = clamp(Math.abs(slip) * 1.7, 0, 1);
  } else {
    car.chain = Math.max(0, car.chain - dt * 2.4);
    car.skid = Math.max(0, car.skid - dt * 2.2);
  }

  if (input.throttle > 0.55 && spd2 < 18) car.stuck += dt;
  else car.stuck = Math.max(0, car.stuck - dt);
  if (car.stuck > 1.15) {
    car.vx += f2.x * 120;
    car.vy += f2.y * 120;
    car.stuck = 0;
  }
  return hit;
}

export function separateCars(cars: Car[]): void {
  for (let i = 0; i < cars.length; i++) {
    for (let j = i + 1; j < cars.length; j++) {
      const a = cars[i];
      const b = cars[j];
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      let d = Math.hypot(dx, dy);
      const min = RADIUS * 2;
      if (d >= min) continue;
      if (d < 0.001) {
        dx = 1;
        dy = 0;
        d = 1;
      }
      const overlap = (min - d) / 2;
      const nx = dx / d;
      const ny = dy / d;
      a.x -= nx * overlap;
      a.y -= ny * overlap;
      b.x += nx * overlap;
      b.y += ny * overlap;
      const push = 40;
      a.vx -= nx * push;
      a.vy -= ny * push;
      b.vx += nx * push;
      b.vy += ny * push;
    }
  }
}

export function botInput(car: Car, track: Track): Input {
  const wp = track.line[car.wp % track.line.length];
  const dx = wp.x - car.x;
  const dy = wp.y - car.y;
  if (dx * dx + dy * dy < 55 * 55) car.wp = (car.wp + 1) % track.line.length;
  const desired = Math.atan2(dx, -dy);
  const err = wrapAngle(desired - car.heading);
  const speed = Math.hypot(car.vx, car.vy);
  const sharp = Math.abs(err) > 0.62;
  return {
    throttle: sharp ? 0.42 : 1,
    brake: Math.abs(err) > 1.35 && speed > 220 ? 0.35 : 0,
    steer: clamp(-err * 1.55, -1, 1),
    handbrake: Math.abs(err) > 0.95 && speed > 170,
  };
}

export function rankCars(cars: Car[]): Car[] {
  return [...cars].sort((a, b) => {
    if (a.finished !== b.finished) return a.finished ? -1 : 1;
    if (a.finished && b.finished && a.finishAt !== b.finishAt) return a.finishAt - b.finishAt;
    if (b.lap !== a.lap) return b.lap - a.lap;
    if (b.next !== a.next) return b.next - a.next;
    return a.id - b.id;
  });
}
