/**
 * The player snake: a continuous, mouse-steered "rope" body.
 *
 * A direct port of `snake/core/snake.py`. Unlike a classic grid snake, this one
 * is a free-floating agent. The head is a point that travels at `speed` pixels
 * per second along `heading`, and the body is *derived* from where the head has
 * been: every head position is pushed onto `path` (newest first) and the
 * visible `segments` are resampled from that path at fixed arc-length
 * intervals. That decoupling is what makes the movement read as a slither
 * instead of a chain of hops:
 *
 *     path      raw, unevenly spaced history of head positions (newest first)
 *     segments  evenly spaced points along that history, one every
 *               C.SNAKE_SEGMENT_SPACING pixels, linearly interpolated between
 *               path samples so the body is smooth rather than stepped
 *
 * Steering is rate limited, but the limit is a *radius*, not an angular rate.
 * A turn of angular rate omega at speed v carves a circle of radius v / omega,
 * so a constant omega means the faster you go the wider you turn - at level 12
 * (525 px/s, omega 5.4) a U-turn swept a ~194 px circle, which is what made
 * doubling back feel like steering a bus. Instead the snake holds
 * `C.SNAKE_MIN_TURN_RADIUS` constant and derives the rate from the current
 * speed:
 *
 *     omega = clamp(speed / SNAKE_MIN_TURN_RADIUS,
 *                   SNAKE_TURN_RATE, SNAKE_TURN_RATE_CAP)   * turnMult
 *
 * so a hairpin costs the same ~40-66 px of arena at every speed and feels
 * identical whether crawling or boosting.
 *
 * Turning that tightly means the head legitimately passes over its own neck, so
 * self-collision is forgiving by design: {@link Snake.hitsSelf} ignores the
 * first `C.SELF_COLLISION_SKIP` segments and then only counts an overlap that
 * is deeper than `C.SELF_COLLISION_DEPTH` of the combined radii. A forgiven
 * overlap is still reported through {@link Snake.crossingSelf}, so the renderer
 * can draw the cross-over and the scene can play a whoosh.
 *
 * This module is pure simulation - it contains no drawing code whatsoever and
 * touches neither pixi nor the DOM.
 */

import * as C from "./config";
import {
  angleTo,
  approachAngle,
  clamp,
  distSq,
  lerp,
  wrapAngle,
} from "./mathx";

/** A point in arena pixels. */
export interface Vec2 {
  x: number;
  y: number;
}

/** Optional overrides for {@link Snake.hitsSelf}. */
export interface HitsSelfOptions {
  /** Segments behind the head ignored outright (default `C.SELF_COLLISION_SKIP`). */
  skip?: number;
  /** Overlap depth needed to count, as a fraction of the combined radii
   *  (default `C.SELF_COLLISION_DEPTH`). */
  depth?: number;
  /** `false` disables self-collision entirely while still reporting the
   *  pass-over through {@link Snake.crossingSelf} (default `true`). */
  enabled?: boolean;
}

/** Optional per-frame modifiers for {@link Snake.update}. */
export interface SnakeUpdateOptions {
  /** True while the boost input is held (default `false`). */
  boost?: boolean;
  /** Multiplier on the cruising speed - level pace, frenzy, slow (default `1`). */
  speedMult?: number;
  /** Multiplier on the maximum steering rate (default `1`). */
  turnMult?: number;
}

// --------------------------------------------------------------------------
// Module tuning that is genuinely internal (shape of the simulation, not game
// balance). Anything a designer would want to touch lives in config.
// --------------------------------------------------------------------------

/** Never let the body shrink below this many segments, whatever hits land. */
export const MIN_LENGTH: number = 4;

/**
 * Absolute ceiling on body length, so a pathological score cannot make the
 * per-frame resample loop unbounded.
 */
export const MAX_LENGTH: number = 400;

/**
 * Head movement is integrated in sub-steps no longer than this many pixels.
 * At ~850 px/s (max speed x boost) and a 50 ms stall a single step would jump
 * 42 px - far enough to cut corners and to leave the path too coarse to
 * interpolate nicely. Sub-stepping keeps the recorded path dense and makes
 * turning arcs accurate at any frame rate.
 */
const MAX_SUBSTEP_PX = 7.0;
const MAX_SUBSTEPS = 12;

/**
 * ...and no longer than this many radians of turn. With a 20 px turn radius
 * a hairpin is only ~6 path samples long, so a coarse angular step would cut
 * the corner into a visible polygon and quietly widen the arc. ~0.1 rad keeps
 * the chord error under a tenth of a pixel.
 */
const MAX_SUBSTEP_RAD = 0.1;

/**
 * A new path sample is only recorded once the head has moved at least this
 * far; below it the newest sample is slid onto the head instead. Keeps the
 * path from filling with duplicate points while standing still.
 */
const PATH_MIN_STEP = 1.6;

/** Hard cap on stored path samples (belt and braces against runaway memory). */
const MAX_PATH_POINTS = 3000;

/**
 * Fraction of the body length over which the head radius blends into the
 * body radius; the remainder tapers body -> tail.
 */
const NECK_FRACTION = 0.16;

/**
 * Exponent of the body -> tail taper. > 1 keeps the body fat for most of its
 * length and then thins quickly near the tip, which reads as "snake" rather
 * than "cone".
 */
const TAPER_EXP = 1.55;

/**
 * Collision forgiveness: the head and body circles are tested slightly
 * smaller than they are drawn so grazes do not feel unfair.
 */
const HEAD_HIT_SCALE = 0.72;
const BODY_HIT_SCALE = 0.78;

/** Shortest signed rotation from angle `a` to angle `b`, in -pi..pi. */
function signedDelta(a: number, b: number): number {
  return wrapAngle(b - a);
}

/**
 * The player entity.
 *
 * Public fields (other modules read these directly):
 *
 *     x, y            head position in arena pixels
 *     heading         head direction, radians (0 = +x, growing clockwise on
 *                     screen because y points down)
 *     speed           cruising speed in px/s before boost / multipliers
 *     alive           false once {@link Snake.kill} has been called
 *     boost           boost stamina, 0 .. C.SNAKE_BOOST_MAX
 *     boosting        true on the frames the boost is actually engaged
 *     invuln          seconds of mercy invulnerability still remaining
 *     path            head history, newest FIRST
 *     segments        resampled body points, index 0 nearest the head
 *     targetLength    how many segments the body is growing toward
 *     currentSpeed    effective px/s used on the last update (renderers and
 *                     particle emitters use this for stretch / trail rate)
 *     bank            smoothed turn signal in -1..1, handy for leaning the
 *                     head sprite into a turn
 *     turnRate        the angular rate (rad/s) actually available on the last
 *                     update, i.e. omega after the radius model and turnMult
 *     turnInput       raw, unsmoothed banking in -1..1: how hard the snake is
 *                     turning right now as a fraction of `turnRate`
 */
export class Snake {
  /** Head x position in arena pixels. */
  public x: number;
  /** Head y position in arena pixels. */
  public y: number;
  /** Head direction in radians (0 = +x, growing clockwise because y is down). */
  public heading: number;
  /** Cruising speed in px/s, before boost and multipliers. */
  public speed: number;
  /** False once {@link Snake.kill} has been called. */
  public alive: boolean;

  /** Boost stamina, 0 .. `C.SNAKE_BOOST_MAX`. */
  public boost: number;
  /** True on the frames the boost is actually engaged. */
  public boosting: boolean;
  /** Seconds of mercy invulnerability still remaining. */
  public invuln: number;

  /** How many segments the body is growing toward. */
  public targetLength: number;
  /** Effective px/s used on the last update. */
  public currentSpeed: number;
  /** Smoothed turn signal in -1..1, for leaning the head sprite into a turn. */
  public bank: number;
  /** Angular rate (rad/s) available on the last update. */
  public turnRate: number;
  /** Raw normalised angular velocity in -1..1 on the last update. */
  public turnInput: number;
  /** Total arc length the head has travelled, in pixels. */
  public distanceTravelled: number;

  /** Head history, newest FIRST. */
  public path: Vec2[];
  /** Resampled body points, index 0 nearest the head. */
  public segments: Vec2[];

  // Self-collision scan cache. `scanTick` advances once per update, so
  // hitsSelf() and crossingSelf() share a single sweep per frame even though
  // they are called independently.
  private scanTick: number;
  private scanKeyValid: boolean;
  private scanKeyTick: number;
  private scanKeySkip: number;
  private scanKeyDepth: number;
  private scanHit: boolean;
  private scanOverlap: boolean;
  private crossTick: number;
  private cross: boolean;

  private target: Vec2 | null;
  private readonly spacing: number;
  private readonly pathMargin: number;

  /**
   * @param x       spawn head x
   * @param y       spawn head y
   * @param heading spawn heading in radians (default 0, i.e. +x)
   * @param length  starting body length in segments (default
   *                `C.SNAKE_START_LENGTH`)
   */
  public constructor(
    x: number,
    y: number,
    heading: number = 0,
    length: number = C.SNAKE_START_LENGTH,
  ) {
    this.x = x;
    this.y = y;
    this.heading = heading;
    this.speed = C.SNAKE_BASE_SPEED;
    this.alive = true;

    this.boost = C.SNAKE_BOOST_MAX;
    this.boosting = false;
    this.invuln = 0;

    this.targetLength = Math.trunc(clamp(length, MIN_LENGTH, MAX_LENGTH));
    this.currentSpeed = this.speed;
    this.bank = 0;
    this.turnRate = 0;
    this.turnInput = 0;
    this.distanceTravelled = 0;

    this.scanTick = 0;
    this.scanKeyValid = false;
    this.scanKeyTick = 0;
    this.scanKeySkip = 0;
    this.scanKeyDepth = 0;
    this.scanHit = false;
    this.scanOverlap = false;
    this.crossTick = -1;
    this.cross = false;

    this.target = null;
    // Spacing is read once and floored, so a bad config value can never turn
    // the resample loop into an infinite one.
    this.spacing = Math.max(1.0, C.SNAKE_SEGMENT_SPACING);
    // Keep a little more history than the body strictly needs; the extra tail
    // slack means growth is instantly visible.
    this.pathMargin = this.spacing * 2.0 + 8.0;

    this.path = [];
    this.segments = [];
    this.seedPath();
    this.resolveSegments();
  }

  /** Lay a straight tail behind the head so the body exists at spawn. */
  private seedPath(): void {
    this.path.length = 0;
    const step = Math.min(6.0, this.spacing * 0.5);
    const needed = this.targetLength * this.spacing + this.pathMargin;
    const count = Math.trunc(needed / step) + 2;
    const cosH = Math.cos(this.heading);
    const sinH = Math.sin(this.heading);
    for (let i = 0; i < count; i++) {
      const back = step * i;
      this.path.push({ x: this.x - cosH * back, y: this.y - sinH * back });
    }
  }

  // ------------------------------------------------------------------
  // Queries
  // ------------------------------------------------------------------

  /** Head position. */
  public headPos(): Vec2 {
    return { x: this.x, y: this.y };
  }

  /** Position of the tail tip (falls back to the head if bodyless). */
  public tailPos(): Vec2 {
    const last = this.segments[this.segments.length - 1];
    if (last !== undefined) return { x: last.x, y: last.y };
    return { x: this.x, y: this.y };
  }

  /** Unit vector along the current heading. */
  public headingVector(): Vec2 {
    return { x: Math.cos(this.heading), y: Math.sin(this.heading) };
  }

  /**
   * Point `offset` px ahead of the head centre.
   *
   * @param offset distance ahead of the head centre; defaults to the head radius.
   */
  public nosePos(offset?: number): Vec2 {
    const d = offset === undefined ? C.SNAKE_HEAD_RADIUS : offset;
    return {
      x: this.x + Math.cos(this.heading) * d,
      y: this.y + Math.sin(this.heading) * d,
    };
  }

  /** Boost stamina as 0..1, for HUD bars. */
  public boostFrac(): number {
    if (C.SNAKE_BOOST_MAX <= 0) return 0;
    return clamp(this.boost / C.SNAKE_BOOST_MAX, 0, 1);
  }

  /** Number of body segments currently resolved. */
  public length(): number {
    return this.segments.length;
  }

  /**
   * Drawn radius of body segment `i` (index 0 is nearest the head).
   *
   * The profile is head -> body over the first `NECK_FRACTION` of the body,
   * then an eased body -> tail taper over the remainder. Passing a negative
   * index asks for the head itself.
   */
  public radiusAt(i: number): number {
    if (i < 0) return C.SNAKE_HEAD_RADIUS;
    const n = this.segments.length;
    if (n <= 1) return C.SNAKE_BODY_RADIUS;
    const t = clamp(i / (n - 1), 0, 1);
    if (t < NECK_FRACTION) {
      return lerp(C.SNAKE_HEAD_RADIUS, C.SNAKE_BODY_RADIUS, t / NECK_FRACTION);
    }
    const u = (t - NECK_FRACTION) / (1.0 - NECK_FRACTION);
    return lerp(C.SNAKE_BODY_RADIUS, C.SNAKE_TAIL_RADIUS, Math.pow(u, TAPER_EXP));
  }

  /**
   * True when the head has genuinely rammed its own body.
   *
   * Because the snake can hairpin on its own line, a plain circle overlap is
   * far too harsh: the head sweeps straight over its own neck on every tight
   * turn. Two forgiveness knobs make that survivable - see
   * {@link HitsSelfOptions}. Called with no arguments it reproduces the
   * configured default behaviour.
   */
  public hitsSelf(opts?: HitsSelfOptions): boolean {
    try {
      if (!this.alive) return false;
      const skip = opts?.skip;
      const depth = opts?.depth;
      const enabled = opts?.enabled === undefined ? true : opts.enabled;
      const [hit, overlap] = this.scanSelf(
        skip === undefined ? null : skip,
        depth === undefined ? null : depth,
      );
      const real = hit && enabled;
      // Remember what this call decided so crossingSelf() reports the
      // pass-over even when the caller disabled the collision outright.
      this.crossTick = this.scanTick;
      this.cross = (overlap || hit) && !real;
      return real;
    } catch {
      // Collision must never crash a frame.
      return false;
    }
  }

  /**
   * True when the head is lying over its own body but was *forgiven*.
   *
   * Read-only: it never changes the simulation. The renderer uses it to draw
   * the head passing under/over the body and the scene uses it to cue a
   * whoosh. It reuses the sweep {@link Snake.hitsSelf} already did this frame,
   * so asking for both costs one pass, not two.
   *
   * A `true` answer from that cached sweep is taken as final. A `false` one is
   * re-checked against the *default* skip / depth, because a caller that
   * disabled self-collision does so by passing a skip larger than the body
   * (easy mode does exactly that), and such a sweep can never see an overlap
   * at all - without the re-check, easy mode would silently lose every
   * cross-over cue in the renderer. The second sweep is memoised on its own
   * key and costs a few microseconds.
   */
  public crossingSelf(): boolean {
    try {
      if (!this.alive) return false;
      if (this.crossTick === this.scanTick && this.cross) return true;
      const [hit, overlap] = this.scanSelf(null, null);
      return overlap && !hit;
    } catch {
      return false;
    }
  }

  // -- collision internals -------------------------------------------

  /**
   * Sweep the body once and return `[realHit, anyOverlap]`.
   *
   * `anyOverlap` is true when the head touches a post-skip segment at all;
   * `realHit` only when it sinks past the `depth` threshold. The result is
   * memoised per update tick and per (skip, depth) pair.
   */
  private scanSelf(
    skip: number | null,
    depth: number | null,
  ): [boolean, boolean] {
    let nSkip = Math.trunc(skip === null ? C.SELF_COLLISION_SKIP : skip);
    if (!(nSkip >= 1)) nSkip = 1;
    const fDepth = clamp(depth === null ? C.SELF_COLLISION_DEPTH : depth, 0, 1);

    if (
      this.scanKeyValid &&
      this.scanKeyTick === this.scanTick &&
      this.scanKeySkip === nSkip &&
      this.scanKeyDepth === fDepth
    ) {
      return [this.scanHit, this.scanOverlap];
    }

    let hit = false;
    let overlap = false;
    const segs = this.segments;
    if (segs.length > nSkip) {
      const hx = this.x;
      const hy = this.y;
      const headR = C.SNAKE_HEAD_RADIUS * HEAD_HIT_SCALE;
      // Overlapping by `depth` of the combined radii leaves the centres
      // (1 - depth) of that distance apart - the lethal radius.
      const bite = 1.0 - fDepth;
      for (let i = nSkip; i < segs.length; i++) {
        const seg = segs[i];
        if (seg === undefined) continue;
        const rr = headR + this.radiusAt(i) * BODY_HIT_SCALE;
        const d2 = distSq(hx, hy, seg.x, seg.y);
        if (d2 > rr * rr) continue;
        overlap = true;
        const lethal = rr * bite;
        if (d2 <= lethal * lethal) {
          hit = true;
          break; // a real hit outranks any further grazing
        }
      }
    }

    this.scanKeyValid = true;
    this.scanKeyTick = this.scanTick;
    this.scanKeySkip = nSkip;
    this.scanKeyDepth = fDepth;
    this.scanHit = hit;
    this.scanOverlap = overlap;
    return [hit, overlap];
  }

  // ------------------------------------------------------------------
  // Commands
  // ------------------------------------------------------------------

  /** Store the point (normally the pointer) the head should steer toward. */
  public setTarget(tx: number, ty: number): void {
    if (Number.isFinite(tx) && Number.isFinite(ty)) {
      this.target = { x: tx, y: ty };
    } else {
      this.target = null;
    }
  }

  /** Forget the steering target; the snake then holds its heading. */
  public clearTarget(): void {
    this.target = null;
  }

  /** Grow the body by `n` segments (clamped to MIN_LENGTH..MAX_LENGTH). */
  public grow(n: number = 1): void {
    this.targetLength = Math.trunc(
      clamp(this.targetLength + Math.trunc(n), MIN_LENGTH, MAX_LENGTH),
    );
  }

  /** Shrink the body by `n` segments (clamped to MIN_LENGTH..MAX_LENGTH). */
  public shrink(n: number = 1): void {
    this.targetLength = Math.trunc(
      clamp(this.targetLength - Math.trunc(n), MIN_LENGTH, MAX_LENGTH),
    );
  }

  /** Mark the snake dead and drop the boost. */
  public kill(): void {
    this.alive = false;
    this.boosting = false;
  }

  /**
   * Move the whole snake so the head lands on (nx, ny).
   *
   * The entire path is translated by the same delta, so the body keeps its
   * shape and the rope never develops a bogus stretched link. Used for portals
   * and for wrap-around walls.
   */
  public teleport(nx: number, ny: number): void {
    const dx = nx - this.x;
    const dy = ny - this.y;
    if (dx === 0 && dy === 0) return;
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    this.x += dx;
    this.y += dy;
    for (let i = 0; i < this.path.length; i++) {
      const p = this.path[i];
      if (p === undefined) continue;
      this.path[i] = { x: p.x + dx, y: p.y + dy };
    }
    for (let i = 0; i < this.segments.length; i++) {
      const s = this.segments[i];
      if (s === undefined) continue;
      this.segments[i] = { x: s.x + dx, y: s.y + dy };
    }
    // The body just jumped; anything cached about it is stale.
    this.scanKeyValid = false;
    this.crossTick = -1;
  }

  /**
   * Respawn in place: reset pose, path and stamina but keep nothing stale.
   *
   * `heading` and `length` are left untouched when omitted.
   */
  public reset(
    x: number,
    y: number,
    heading?: number,
    length?: number,
  ): void {
    this.x = x;
    this.y = y;
    if (heading !== undefined) this.heading = heading;
    if (length !== undefined) {
      this.targetLength = Math.trunc(clamp(length, MIN_LENGTH, MAX_LENGTH));
    }
    this.alive = true;
    this.boosting = false;
    this.bank = 0;
    this.turnInput = 0;
    this.turnRate = 0;
    this.currentSpeed = this.speed;
    this.scanKeyValid = false;
    this.scanHit = false;
    this.scanOverlap = false;
    this.crossTick = -1;
    this.cross = false;
    this.target = null;
    this.seedPath();
    this.resolveSegments();
  }

  // ------------------------------------------------------------------
  // Simulation
  // ------------------------------------------------------------------

  /**
   * Advance the snake by `dt` seconds.
   *
   * `speedMult` and `turnMult` are the hooks power-ups and levels use
   * (slow-motion, frenzy, per-level pace) - they scale the cruising speed and
   * the maximum steering rate respectively.
   */
  public update(dt: number, opts?: SnakeUpdateOptions): void {
    try {
      const boost = opts?.boost === undefined ? false : opts.boost;
      const speedMult = opts?.speedMult === undefined ? 1 : opts.speedMult;
      const turnMult = opts?.turnMult === undefined ? 1 : opts.turnMult;

      const step = clamp(dt, 0, C.MAX_DT);

      // Invalidate the self-collision cache: the body is about to move.
      this.scanTick += 1;

      // Mercy invulnerability ticks down even while dead, so the death
      // animation cannot leave a stale timer behind.
      if (this.invuln > 0) {
        this.invuln = Math.max(0, this.invuln - step);
      }

      if (!this.alive || step <= 0) {
        this.boosting = false;
        return;
      }

      const speed = this.updateBoost(step, boost, speedMult);
      this.currentSpeed = speed;

      const travel = speed * step;
      if (travel <= 0) {
        this.resolveSegments();
        return;
      }

      const turnLimit = this.turnRateFor(speed) * Math.max(0, turnMult);
      this.turnRate = turnLimit;

      // Sub-step so that neither the turning arc nor the recorded path depends
      // on the frame rate: bound each sub-step both in distance travelled and
      // in angle turned.
      let steps = Math.trunc(travel / MAX_SUBSTEP_PX) + 1;
      const turned = turnLimit * step;
      if (turned > MAX_SUBSTEP_RAD) {
        steps = Math.max(steps, Math.trunc(turned / MAX_SUBSTEP_RAD) + 1);
      }
      if (steps > MAX_SUBSTEPS) steps = MAX_SUBSTEPS;
      const subDt = step / steps;
      const headingBefore = this.heading;

      for (let i = 0; i < steps; i++) {
        this.steer(subDt, turnLimit);
        const stepLen = speed * subDt;
        this.x += Math.cos(this.heading) * stepLen;
        this.y += Math.sin(this.heading) * stepLen;
        this.distanceTravelled += stepLen;
        this.pushPath();
      }

      // `turnInput` is the raw normalised angular velocity (-1 hard left ..
      // +1 hard right); `bank` smooths it so renderers get a stable lean value
      // instead of per-frame noise.
      let raw = 0;
      if (turnLimit > 1e-6) {
        raw = clamp(
          signedDelta(headingBefore, this.heading) / (turnLimit * step),
          -1,
          1,
        );
      }
      this.turnInput = raw;
      this.bank += (raw - this.bank) * Math.min(1.0, step * 10.0);

      this.resolveSegments();
    } catch {
      // A bad frame must not kill the game.
    }
  }

  // -- internals ------------------------------------------------------

  /** Rotate the heading toward the stored target, rate limited. */
  private steer(dt: number, turnLimit: number): void {
    const target = this.target;
    if (target === null || turnLimit <= 0) return;
    // Inside the deadzone the pointer direction is meaningless (a pixel of
    // pointer jitter would flip it), so we simply hold the current heading.
    const dz = C.MOUSE_DEADZONE;
    if (distSq(this.x, this.y, target.x, target.y) <= dz * dz) return;
    const desired = angleTo(this.x, this.y, target.x, target.y);
    this.heading = approachAngle(this.heading, desired, turnLimit * dt);
  }

  /**
   * Maximum steering rate (rad/s) for `speed`, from a constant turn radius.
   *
   * The old model interpolated a fixed angular rate, which meant the turn
   * radius v / omega grew with speed - the reason doubling back at level 12
   * swept a ~194 px circle. Here the *radius* is the constant:
   *
   *     omega = speed / SNAKE_MIN_TURN_RADIUS
   *
   * clamped between the legacy floor SNAKE_TURN_RATE (so a crawling snake
   * still answers the pointer promptly rather than pivoting in place with
   * near-zero forward motion) and SNAKE_TURN_RATE_CAP (so the head cannot spin
   * faster than the body resample can follow). The cap is only reached above
   * ~320 px/s, and even at the boosted top end it holds the hairpin near 50 px
   * instead of 200.
   */
  private turnRateFor(speed: number): number {
    const radius = C.SNAKE_MIN_TURN_RADIUS;
    if (radius <= 1e-6) return C.SNAKE_TURN_RATE_CAP;
    let lo = C.SNAKE_TURN_RATE;
    let hi = C.SNAKE_TURN_RATE_CAP;
    if (hi < lo) {
      const t = lo;
      lo = hi;
      hi = t;
    }
    return clamp(Math.max(0, speed) / radius, lo, hi);
  }

  /** Run the stamina economy and return the effective speed in px/s. */
  private updateBoost(dt: number, want: boolean, speedMult: number): number {
    // A fresh boost needs a minimum reserve, but an ongoing one may run the
    // tank all the way down - that avoids a stutter at the threshold.
    let wants = want;
    if (wants) {
      wants = this.boosting
        ? this.boost > 0
        : this.boost >= C.SNAKE_BOOST_MIN_TO_START;
    }
    this.boosting = wants;

    if (wants) {
      this.boost -= C.SNAKE_BOOST_DRAIN * dt;
    } else {
      this.boost += C.SNAKE_BOOST_REGEN * dt;
    }
    this.boost = clamp(this.boost, 0, C.SNAKE_BOOST_MAX);
    if (this.boost <= 0) this.boosting = false;

    // SNAKE_MAX_SPEED caps the snake's own cruise speed; it is not a cap on
    // the multipliers layered over it. `speedMult` (level pace, frenzy, slow)
    // and SNAKE_BOOST_MULT are deliberate design multipliers, so they apply
    // *after* the clamp - which is how boost has always behaved. Clamping
    // before the multiply flattened the top of the difficulty curve: levels 11
    // and 12 both landed on exactly 460 px/s and played at an identical pace
    // despite speedMult 1.61 vs 1.70.
    let cruise = clamp(this.speed, 0, C.SNAKE_MAX_SPEED);
    cruise *= Math.max(0, speedMult);
    if (this.boosting) cruise *= C.SNAKE_BOOST_MULT;
    return cruise;
  }

  /**
   * Record the head position, newest first.
   *
   * When the head has barely moved we slide the newest sample onto it instead
   * of appending, which keeps the path free of near-duplicate points without
   * ever losing the "path[0] is the head" invariant.
   */
  private pushPath(): void {
    const path = this.path;
    const head = path[0];
    if (head === undefined) {
      path.push({ x: this.x, y: this.y });
      return;
    }
    if (distSq(head.x, head.y, this.x, this.y) >= PATH_MIN_STEP * PATH_MIN_STEP) {
      path.unshift({ x: this.x, y: this.y });
      if (path.length > MAX_PATH_POINTS) path.length = MAX_PATH_POINTS;
    } else {
      path[0] = { x: this.x, y: this.y };
    }
  }

  /**
   * Resample `path` into evenly spaced body points and trim the leftovers.
   *
   * Walks the path from the head accumulating arc length; whenever the
   * accumulated distance passes the next multiple of `spacing` a segment is
   * emitted, linearly interpolated between the two surrounding samples. The
   * same walk finds the point past which no future frame can need the history,
   * and truncates there.
   */
  private resolveSegments(): void {
    const path = this.path;
    const out = this.segments; // mutated in place: callers may hold a ref
    out.length = 0;

    const count = Math.trunc(clamp(this.targetLength, MIN_LENGTH, MAX_LENGTH));
    const first = path[0];
    if (first === undefined) {
      for (let i = 0; i < count; i++) out.push({ x: this.x, y: this.y });
      return;
    }

    const spacing = this.spacing;
    const maxArc = count * spacing + this.pathMargin;

    let px = first.x;
    let py = first.y;
    let acc = 0.0; // arc length from the head to (px, py)
    let needed = spacing; // arc length at which the next segment sits
    const n = path.length;
    let cut = n;
    let idx = 1;
    while (idx < n) {
      const q = path[idx];
      if (q === undefined) break;
      const dx = q.x - px;
      const dy = q.y - py;
      const segLen = Math.hypot(dx, dy);
      if (segLen > 1e-9) {
        // One path link can straddle several segment positions when the snake
        // is moving fast, hence the inner loop.
        while (out.length < count && needed <= acc + segLen) {
          const t = (needed - acc) / segLen;
          out.push({ x: px + dx * t, y: py + dy * t });
          needed += spacing;
        }
        acc += segLen;
      }
      if (acc >= maxArc && out.length >= count) {
        cut = idx + 1;
        break;
      }
      px = q.x;
      py = q.y;
      idx += 1;
    }

    if (cut < n) path.length = cut;

    // Not enough history yet (fresh growth, or just after a teleport): the
    // missing segments wait stacked on the oldest recorded point, exactly
    // where a real tail would sit until the head has travelled further.
    if (out.length < count) {
      const last = path[path.length - 1];
      const lx = last === undefined ? this.x : last.x;
      const ly = last === undefined ? this.y : last.y;
      while (out.length < count) out.push({ x: lx, y: ly });
    }
  }
}
