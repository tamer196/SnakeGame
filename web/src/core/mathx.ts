/**
 * Geometry and easing helpers.
 *
 * A direct port of `snake/core/contracts.py`. The names and semantics match
 * the Python original deliberately: the ported simulation is verified against
 * the same assertions, so any drift here would be invisible until a level
 * played differently.
 */

export const TAU = Math.PI * 2;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function dist(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(bx - ax, by - ay);
}

export function distSq(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  return dx * dx + dy * dy;
}

export function angleTo(ax: number, ay: number, bx: number, by: number): number {
  return Math.atan2(by - ay, bx - ax);
}

/** Fold an angle into -pi .. +pi. */
export function wrapAngle(a: number): number {
  let x = (a + Math.PI) % TAU;
  if (x < 0) x += TAU;
  return x - Math.PI;
}

/** Rotate `current` toward `target` by at most `maxStep` radians. */
export function approachAngle(
  current: number,
  target: number,
  maxStep: number,
): number {
  let diff = wrapAngle(target - current);
  if (diff > maxStep) diff = maxStep;
  else if (diff < -maxStep) diff = -maxStep;
  return wrapAngle(current + diff);
}

export function easeOutCubic(t: number): number {
  const x = clamp(t, 0, 1) - 1;
  return x * x * x + 1;
}

export function easeInOutCubic(t: number): number {
  const x = clamp(t, 0, 1);
  if (x < 0.5) return 4 * x * x * x;
  const f = 2 * x - 2;
  return 0.5 * f * f * f + 1;
}

export function easeOutBack(t: number): number {
  const x = clamp(t, 0, 1);
  const c1 = 1.70158;
  const c3 = c1 + 1;
  const f = x - 1;
  return 1 + c3 * f * f * f + c1 * f * f;
}

/** A 0..1 sine oscillation, for glow and scale throbbing. */
export function pulse(t: number, speed = 1): number {
  return 0.5 + 0.5 * Math.sin(t * speed);
}

/** Shortest distance from a point to a line segment. */
export function pointSegmentDist(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq <= 1e-9) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = clamp(t, 0, 1);
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

/** Deterministic RNG (mulberry32) so replays and tests are reproducible. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randRange(rng: () => number, lo: number, hi: number): number {
  return lo + (hi - lo) * rng();
}

export interface RectLike {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function rectContains(r: RectLike, px: number, py: number): boolean {
  return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
}

export function rectOverlapsCircle(
  r: RectLike,
  cx: number,
  cy: number,
  rad: number,
): boolean {
  const nx = clamp(cx, r.x, r.x + r.w);
  const ny = clamp(cy, r.y, r.y + r.h);
  const dx = cx - nx;
  const dy = cy - ny;
  return dx * dx + dy * dy <= rad * rad;
}
