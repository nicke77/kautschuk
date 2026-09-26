export type Vec = { x: number; y: number };

export type Oil = { x: number; y: number; rx: number; ry: number };

export type Gate = { a: Vec; b: Vec; nx: number; ny: number };

export type Track = {
  id: string;
  name: string;
  blurb: string;
  outer: Vec[];
  inner: Vec[];
  oils: Oil[];
  gates: Gate[];
  spawns: { x: number; y: number; h: number }[];
  line: Vec[];
};

export type Input = {
  throttle: number;
  brake: number;
  steer: number;
  handbrake: boolean;
};

export const ZERO_INPUT: Input = { throttle: 0, brake: 0, steer: 0, handbrake: false };

export type Car = {
  id: number;
  name: string;
  bot: boolean;
  x: number;
  y: number;
  heading: number;
  vx: number;
  vy: number;
  lap: number;
  next: number;
  drift: number;
  chain: number;
  skid: number;
  onOil: boolean;
  finished: boolean;
  stuck: number;
  wp: number;
};

export type SnapCar = {
  id: number;
  name: string;
  bot: boolean;
  x: number;
  y: number;
  h: number;
  vx: number;
  vy: number;
  lap: number;
  next: number;
  drift: number;
  skid: number;
  oil: boolean;
  finished: boolean;
};

export const CAR_COLORS = ["#f0b429", "#f4efe6", "#e23d2b", "#c46a3a"] as const;
export const LAPS = 3;
export const RADIUS = 18;
