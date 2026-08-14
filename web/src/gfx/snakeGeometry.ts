/**
 * The polyline the snake renderer paints, derived once per frame.
 *
 * A port of the geometry half of `snake/gfx/render.py` (`_snake_geometry`,
 * `_frames`, `_bank_points`, `_find_crossings`). It turns a {@link Snake} into
 * four parallel arrays - point, radius, unit left normal, signed curvature -
 * plus the *banking* offset that slides every point toward the inside of its
 * own turn, and the list of places where the head end is lying on top of a
 * distant part of the body.
 *
 * Two things are worth knowing before reading the maths:
 *
 * - **The tangent points forward along travel.** It is the direction from
 *   point `i+1` toward point `i-1`, so a "left normal" `(-ty, tx)` really is to
 *   the left of the creature as it moves. Curvature is the 2-D cross product of
 *   the tangents either side of a point, which is `sin(turn angle)`: already
 *   signed, already in -1..1, and free of extra square roots.
 * - **Crossings are found on the banked (drawn) polyline**, not on the
 *   simulation's collision circles. The overpass decoration has to land where
 *   the two tubes visually overlap, which is where the banking put them.
 *
 * Everything is stored in preallocated `Float64Array`s that are reused frame
 * after frame; the renderer is the only consumer and reads them by index. That
 * is also why the loops below use `!` on element access - every index is bounded
 * by the loop itself, and `noUncheckedIndexedAccess` would otherwise force a
 * branch into the hottest code in the game.
 */

import * as C from "../core/config";
import { clamp, lerp } from "../core/mathx";
import type { Snake } from "../core/snake";

/**
 * How far a body point slides toward the inside of its own turn, as a fraction
 * of that point's radius. Small on purpose: the drawn body must stay honest
 * about where the collision circles actually are.
 */
export const BANK_STRENGTH = 0.34;

/**
 * Banking is faded in over this many segments so the head itself is drawn
 * exactly on the simulated head position.
 */
export const BANK_RAMP = 4.0;

/**
 * Segments counted as "the head end" for cross-over layering. Everything with a
 * higher index is painted first, so the neck and head land on top of it.
 */
export const FRONT_SPAN = 9;

/** At most this many overpasses are decorated per frame. */
export const MAX_CROSSINGS = 3;

/** One place where the head end lies on top of a distant body segment. */
export interface Crossing {
  /** Index of the front sample that is doing the crossing (0, 2, 4 or 6). */
  f: number;
  /** The rear point it overlaps. */
  x: number;
  y: number;
  /** Overlap of the two circles, 0..1. */
  depth: number;
}

export class SnakeGeometry {
  /** Number of live points. Index 0 is the head. */
  n = 0;

  /** Banked points - the polyline that is actually drawn. */
  x = new Float64Array(0);
  y = new Float64Array(0);
  /** Drawn radius per point. */
  radii = new Float64Array(0);
  /** Unit left normal per point, taken from the *unbanked* frame. */
  nx = new Float64Array(0);
  ny = new Float64Array(0);
  /** Signed curvature per point, -1..1. */
  curv = new Float64Array(0);
  /** Banking lean per point, -1..1; also drives the scale-plate light split. */
  lean = new Float64Array(0);

  /** Up to {@link MAX_CROSSINGS} entries; only the first {@link crossingCount}. */
  readonly crossings: Crossing[] = [];
  crossingCount = 0;

  // Raw (unbanked) points and the tangent frame they generate.
  private rx = new Float64Array(0);
  private ry = new Float64Array(0);
  private tx = new Float64Array(0);
  private ty = new Float64Array(0);
  private cap = 0;

  constructor() {
    for (let i = 0; i < MAX_CROSSINGS; i++) {
      this.crossings.push({ f: 0, x: 0, y: 0, depth: 0 });
    }
    this.ensure(64);
  }

  private ensure(need: number): void {
    if (need <= this.cap) return;
    const cap = Math.max(64, need + 32);
    this.x = new Float64Array(cap);
    this.y = new Float64Array(cap);
    this.radii = new Float64Array(cap);
    this.nx = new Float64Array(cap);
    this.ny = new Float64Array(cap);
    this.curv = new Float64Array(cap);
    this.lean = new Float64Array(cap);
    this.rx = new Float64Array(cap);
    this.ry = new Float64Array(cap);
    this.tx = new Float64Array(cap);
    this.ty = new Float64Array(cap);
    this.cap = cap;
  }

  /** Rebuild every array from the simulation. Cheap enough to call per frame. */
  build(snake: Snake): void {
    const segs = snake.segments;
    this.ensure(segs.length + 1);
    const rx = this.rx;
    const ry = this.ry;

    // Head first. `snake.x/y` is what `headPos()` copies, read directly so a
    // frame costs no throwaway objects.
    rx[0] = snake.x;
    ry[0] = snake.y;
    let m = 1;
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      if (s === undefined) continue;
      // `segments[0]` is often just the head again. The test stays live while
      // only the head has been kept, exactly as the Python does, so a second
      // coincident segment is dropped too.
      if (m === 1 && Math.hypot(s.x - rx[0]!, s.y - ry[0]!) < 1.0) continue;
      rx[m] = s.x;
      ry[m] = s.y;
      m++;
    }
    this.n = m;

    const radii = this.radii;
    for (let i = 0; i < m; i++) {
      // Note the index: `radiusAt` is indexed by *segment*, but the polyline
      // has the head at index 0, so every body point asks for the radius of the
      // segment one further back. That is the Python's behaviour and the taper
      // is smooth enough that it never shows.
      radii[i] = Math.max(1.5, snake.radiusAt(i));
    }

    this.frames(snake.heading);
    this.bank(clamp(snake.turnInput, -1, 1));
  }

  /** Unit left normal and signed curvature for every point. */
  private frames(heading: number): void {
    const n = this.n;
    const { rx, ry, tx, ty, nx, ny, curv } = this;
    const fx = Math.cos(heading);
    const fy = Math.sin(heading);
    for (let i = 0; i < n; i++) {
      const a = i > 0 ? i - 1 : 0;
      const b = i + 1 < n ? i + 1 : n - 1;
      const dx = rx[a]! - rx[b]!;
      const dy = ry[a]! - ry[b]!;
      const mm = dx * dx + dy * dy;
      if (mm > 1e-8) {
        const inv = 1.0 / Math.sqrt(mm);
        tx[i] = dx * inv;
        ty[i] = dy * inv;
      } else if (i > 0) {
        // Degenerate link: hold the previous frame rather than snapping.
        tx[i] = tx[i - 1]!;
        ty[i] = ty[i - 1]!;
      } else {
        tx[i] = fx;
        ty[i] = fy;
      }
    }

    for (let i = 0; i < n; i++) {
      nx[i] = -ty[i]!;
      ny[i] = tx[i]!;
      curv[i] = 0;
      if (i > 0 && i < n - 1) {
        curv[i] = clamp(
          tx[i + 1]! * ty[i - 1]! - ty[i + 1]! * tx[i - 1]!,
          -1.0,
          1.0,
        );
      }
    }
    if (n > 2) {
      curv[0] = curv[1]!;
      curv[n - 1] = curv[n - 2]!;
    }
  }

  /**
   * Slide every point toward the inside of its own turn.
   *
   * `turn` is the snake's raw steering signal. Near the head the polyline has
   * barely bent yet, so the steering input leads the geometry over the first
   * eight points - without it the lean arrives visibly late into a hairpin.
   */
  private bank(turn: number): void {
    const n = this.n;
    const { rx, ry, nx, ny, curv, radii, x, y, lean } = this;
    for (let i = 0; i < n; i++) {
      const ramp = clamp(i / BANK_RAMP, 0.0, 1.0);
      let k = curv[i]! * 3.4;
      if (i < 8) k = lerp(turn, k, i / 8.0);
      k = clamp(k, -1.0, 1.0);
      lean[i] = k;
      const off = k * ramp * radii[i]! * BANK_STRENGTH;
      x[i] = rx[i]! + nx[i]! * off;
      y[i] = ry[i]! + ny[i]! * off;
    }
  }

  /**
   * Locate places where the head end lies on top of a distant body segment.
   *
   * A handful of front samples are tested against every other rear point, with
   * a cheap axis-aligned reject first, so the cost is a few hundred float
   * compares even on a 400-segment snake. Only the deepest hit per front sample
   * is kept.
   */
  findCrossings(): void {
    this.crossingCount = 0;
    const n = this.n;
    const skip = Math.max(2, C.SELF_COLLISION_SKIP);
    if (n <= skip + 2) return;
    const { x, y, radii } = this;

    for (let s = 0; s < 4; s++) {
      const f = s * 2; // front samples 0, 2, 4, 6
      if (f >= skip) break;
      const fx = x[f]!;
      const fy = y[f]!;
      const rf = radii[f]!;
      let best = 0.0;
      let bx = 0.0;
      let by = 0.0;
      for (let j = skip; j < n; j += 2) {
        const sx = x[j]!;
        const sy = y[j]!;
        let dx = sx - fx;
        if (dx < 0.0) dx = -dx;
        const rr = rf + radii[j]!;
        if (dx > rr) continue;
        let dy = sy - fy;
        if (dy < 0.0) dy = -dy;
        if (dy > rr) continue;
        const d2 = dx * dx + dy * dy;
        if (d2 >= rr * rr) continue;
        const depth = 1.0 - Math.sqrt(d2) / rr;
        if (depth > best) {
          best = depth;
          bx = sx;
          by = sy;
        }
      }
      if (best > 0.0) {
        const slot = this.crossings[this.crossingCount]!;
        slot.f = f;
        slot.x = bx;
        slot.y = by;
        slot.depth = best;
        this.crossingCount++;
        if (this.crossingCount >= MAX_CROSSINGS) break;
      }
    }
  }
}
