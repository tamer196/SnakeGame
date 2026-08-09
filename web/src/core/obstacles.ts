/**
 * Arena hazards for NEON SERPENT.
 *
 * A direct port of `snake/core/obstacles.py`, minus every line that touched
 * pygame. Each obstacle is a small, self-contained actor with three jobs:
 *
 * ```
 * update(dt, t)        advance its animation
 * collides(x, y, r)    answer "is this circle touching me?"
 * avoid()              hand a spawner a keep-out circle
 * ```
 *
 * `deadly` says whether a collision costs the player a life. The only hazard
 * with `deadly === false` is {@link Portal}, which teleports instead.
 *
 * Design notes
 * ------------
 * - All geometry is float pixels in arena space - nothing here knows about a
 *   grid, because the snake moves continuously.
 * - Collision shapes are deliberately simple (circle-vs-rect,
 *   circle-vs-segment) so the whole hazard list can be tested every frame.
 * - Rendering lives in another module. Everything a renderer needs is public
 *   state: positions, angles, current phase and whether the hazard is deadly
 *   *right now*.
 * - Nothing here may throw. The public entry points wrap the real
 *   implementation (`onUpdate` / `onCollides`) in a guard so a bad spec
 *   degrades into a missing hazard rather than a dead frame.
 */

import * as C from "./config";
import {
  TAU,
  clamp,
  easeInOutCubic,
  lerp,
  pointSegmentDist,
  type RectLike,
} from "./mathx";

// --------------------------------------------------------------------------
// Local tuning (nothing in config covers hazards)
// --------------------------------------------------------------------------

/** Seconds a portal pair sleeps after a jump, so it cannot ping-pong a head. */
export const PORTAL_COOLDOWN = 0.55;

/** Pixels beyond the destination rim a teleported entity is ejected at. */
export const PORTAL_EXIT_PAD = 10.0;

// --------------------------------------------------------------------------
// Small shared types
// --------------------------------------------------------------------------

/** A point in arena space. */
export type Vec2 = readonly [x: number, y: number];

/**
 * A keep-out circle `(x, y, radius)` for FoodField / PowerUpField, matching the
 * 3-tuple `Obstacle.avoid()` returns in Python.
 */
export type AvoidCircle = readonly [x: number, y: number, r: number];

/** The canonical hazard names `buildObstacles` understands after aliasing. */
export type ObstacleKind =
  | "obstacle"
  | "wall"
  | "movingbar"
  | "spinner"
  | "pulsar"
  | "lasergate"
  | "portal";

/** Anything `buildObstacles` will accept as the arena rectangle. */
export type RectSource = RectLike | readonly number[] | null | undefined;

/**
 * One raw entry out of `levels.json`'s `obstacleSpec`: a `type` name plus
 * whatever keys that hazard takes. Unknown keys are ignored, never fatal.
 */
export interface ObstacleSpec {
  readonly type?: string;
  readonly [key: string]: unknown;
}

// --------------------------------------------------------------------------
// Geometry helpers
// --------------------------------------------------------------------------

/** Python's `%`: the result always takes the sign of the divisor. */
function pyMod(a: number, b: number): number {
  return ((a % b) + b) % b;
}

/** Circle vs axis-aligned rect: clamp the centre into the rect, then measure. */
function rectHitsCircle(
  left: number,
  top: number,
  right: number,
  bottom: number,
  cx: number,
  cy: number,
  r: number,
): boolean {
  const nx = cx < left ? left : cx > right ? right : cx;
  const ny = cy < top ? top : cy > bottom ? bottom : cy;
  const dx = cx - nx;
  const dy = cy - ny;
  return dx * dx + dy * dy <= r * r;
}

/**
 * A whole-pixel rect, the way `pygame.Rect(int(x), int(y), int(w), int(h))`
 * behaves. `bounds()` is quantised for the same reason Python's was: `avoid()`
 * derives from it, and the two ports must agree to the pixel.
 */
function intRect(x: number, y: number, w: number, h: number): RectLike {
  return { x: Math.trunc(x), y: Math.trunc(y), w: Math.trunc(w), h: Math.trunc(h) };
}

/** `pygame.Rect.centerx` - integer floor division, not a float midpoint. */
function centerX(r: RectLike): number {
  return r.x + Math.floor(r.w / 2);
}

/** `pygame.Rect.centery` - integer floor division, not a float midpoint. */
function centerY(r: RectLike): number {
  return r.y + Math.floor(r.h / 2);
}

// ==========================================================================
// Base class
// ==========================================================================

/**
 * Common hazard behaviour.
 *
 * Subclasses override the `onXxx` hooks; the public methods are thin guards so
 * a broken hazard can never take the frame down with it.
 */
export class Obstacle {
  /** Discriminator matching the spec's `type`, e.g. `"wall"`. */
  readonly kind: ObstacleKind = "obstacle";

  /** True when touching this hazard costs a life. May flip every frame. */
  deadly: boolean;

  /** The simulation time of the last `update`. */
  t = 0;

  /** The arena rect, set by {@link buildObstacles}. */
  arena: RectLike | null = null;

  constructor(deadly = true) {
    this.deadly = Boolean(deadly);
  }

  // -- hooks ---------------------------------------------------------------

  /** Advance animation state. Overridden by moving hazards. */
  protected onUpdate(_dt: number, _t: number): void {
    /* static by default */
  }

  /** The real collision test. Overridden by everything with a body. */
  protected onCollides(_x: number, _y: number, _r: number): boolean {
    return false;
  }

  // -- public API ----------------------------------------------------------

  /** Advance this hazard to absolute time `t`. Never throws. */
  update(dt: number, t: number): void {
    try {
      this.t = t;
      this.onUpdate(dt, t);
    } catch {
      /* a broken hazard must not kill the frame */
    }
  }

  /** Is the circle at `(x, y)` with radius `r` touching this hazard? */
  collides(x: number, y: number, r = 0): boolean {
    try {
      return Boolean(this.onCollides(x, y, r));
    } catch {
      return false;
    }
  }

  /** Axis-aligned box covering everything this hazard can occupy. */
  bounds(): RectLike {
    return { x: 0, y: 0, w: 0, h: 0 };
  }

  /** `(x, y, radius)` keep-out circle, for FoodField / PowerUpField. */
  avoid(): AvoidCircle {
    const b = this.bounds();
    return [centerX(b), centerY(b), Math.hypot(b.w, b.h) * 0.5 + 6.0];
  }
}

// ==========================================================================
// WallBlock - a static neon slab
// ==========================================================================

/** Constructor arguments for {@link WallBlock}; every field has a default. */
export interface WallBlockOptions {
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  deadly?: boolean;
}

/** An immovable rectangle. The bread and butter of level layout. */
export class WallBlock extends Obstacle {
  override readonly kind: ObstacleKind = "wall";

  /** Left edge, arena pixels. */
  x: number;
  /** Top edge, arena pixels. */
  y: number;
  /** Width in pixels, never below 2. */
  w: number;
  /** Height in pixels, never below 2. */
  h: number;

  constructor(opts: WallBlockOptions = {}) {
    super(opts.deadly ?? true);
    this.x = opts.x ?? 0.0;
    this.y = opts.y ?? 0.0;
    this.w = Math.max(2.0, opts.w ?? 60.0);
    this.h = Math.max(2.0, opts.h ?? 60.0);
  }

  override bounds(): RectLike {
    return intRect(this.x, this.y, this.w, this.h);
  }

  protected override onCollides(x: number, y: number, r: number): boolean {
    return rectHitsCircle(this.x, this.y, this.x + this.w, this.y + this.h, x, y, r);
  }
}

// ==========================================================================
// MovingBar - a slab on an eased ping-pong
// ==========================================================================

/** Constructor arguments for {@link MovingBar}; every field has a default. */
export interface MovingBarOptions {
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  axis?: string;
  travel?: number;
  speed?: number;
  phase?: number;
  deadly?: boolean;
}

/**
 * A slab that slides between its home position and home + travel.
 *
 * The path is an eased triangle wave, so it decelerates into each end of the
 * run instead of snapping direction - far easier to read and to dodge.
 */
export class MovingBar extends Obstacle {
  override readonly kind: ObstacleKind = "movingbar";

  /** Home position - the `off === 0` end of the run. */
  x0: number;
  y0: number;
  w: number;
  h: number;
  /** `"x"` or `"y"`; anything vertical-ish in the spec normalises to `"y"`. */
  axis: "x" | "y";
  /** Signed length of the run, in pixels. */
  travel: number;
  /** Full out-and-back cycles per second. */
  speed: number;
  /** 0..1 offset into the cycle. */
  phase: number;

  /** Current top-left corner, updated every frame. */
  x: number;
  y: number;
  /** +1 outbound, -1 returning. Renderers use it for chevrons and smear. */
  dir = 1.0;

  constructor(opts: MovingBarOptions = {}) {
    super(opts.deadly ?? true);
    this.x0 = opts.x ?? 0.0;
    this.y0 = opts.y ?? 0.0;
    this.w = Math.max(2.0, opts.w ?? 120.0);
    this.h = Math.max(2.0, opts.h ?? 20.0);
    this.axis = isVerticalAxis(opts.axis ?? "x") ? "y" : "x";
    this.travel = opts.travel ?? 160.0;
    this.speed = opts.speed ?? 0.35;
    this.phase = opts.phase ?? 0.0;
    this.x = this.x0;
    this.y = this.y0;
    this.onUpdate(0.0, 0.0);
  }

  override bounds(): RectLike {
    return intRect(this.x, this.y, this.w, this.h);
  }

  /** The whole corridor the bar sweeps, used as a keep-out zone. */
  span(): RectLike {
    const tx = this.axis === "x" ? this.travel : 0.0;
    const ty = this.axis === "y" ? this.travel : 0.0;
    const left = Math.min(this.x0, this.x0 + tx);
    const top = Math.min(this.y0, this.y0 + ty);
    return intRect(left, top, this.w + Math.abs(tx), this.h + Math.abs(ty));
  }

  override avoid(): AvoidCircle {
    const b = this.span();
    return [centerX(b), centerY(b), Math.hypot(b.w, b.h) * 0.5 + 6.0];
  }

  protected override onUpdate(_dt: number, t: number): void {
    const u = pyMod(t * this.speed + this.phase, 1.0);
    // Triangle wave 0 -> 1 -> 0, then eased for smooth ends.
    const tri = u < 0.5 ? u * 2.0 : 2.0 - 2.0 * u;
    const off = this.travel * easeInOutCubic(tri);
    this.dir = u < 0.5 ? 1.0 : -1.0;
    if (this.axis === "x") {
      this.x = this.x0 + off;
      this.y = this.y0;
    } else {
      this.x = this.x0;
      this.y = this.y0 + off;
    }
  }

  protected override onCollides(x: number, y: number, r: number): boolean {
    return rectHitsCircle(this.x, this.y, this.x + this.w, this.y + this.h, x, y, r);
  }
}

// ==========================================================================
// Spinner - rotating arms
// ==========================================================================

/** Constructor arguments for {@link Spinner}; every field has a default. */
export interface SpinnerOptions {
  cx?: number;
  cy?: number;
  length?: number;
  arms?: number;
  speed?: number;
  thickness?: number;
  phase?: number;
  hub_radius?: number;
  deadly?: boolean;
}

/**
 * N arms rotating about a hub. Each arm is a thick line segment, so collision
 * is point-to-segment distance against a radius of `thickness / 2`.
 */
export class Spinner extends Obstacle {
  override readonly kind: ObstacleKind = "spinner";

  /** Hub centre. */
  cx: number;
  cy: number;
  /** Arm length from hub to tip. */
  length: number;
  /** Arm count, clamped to 1..8. */
  arms: number;
  /** Radians per second. */
  speed: number;
  /** Arm thickness; collision radius is half this. */
  thickness: number;
  /** Starting angle in radians. */
  phase: number;
  /** Radius of the lethal hub disc. */
  hubRadius: number;
  /** Current rotation in radians - what a renderer draws from. */
  angle: number;

  constructor(opts: SpinnerOptions = {}) {
    super(opts.deadly ?? true);
    this.cx = opts.cx ?? 0.0;
    this.cy = opts.cy ?? 0.0;
    this.length = Math.max(8.0, opts.length ?? 90.0);
    this.arms = clamp(Math.trunc(opts.arms ?? 2), 1, 8);
    this.speed = opts.speed ?? 1.5;
    this.thickness = Math.max(2.0, opts.thickness ?? 11.0);
    this.phase = opts.phase ?? 0.0;
    this.hubRadius = Math.max(4.0, opts.hub_radius ?? 13.0);
    this.angle = this.phase;
  }

  override bounds(): RectLike {
    const r = this.length + this.thickness;
    return intRect(this.cx - r, this.cy - r, r * 2, r * 2);
  }

  override avoid(): AvoidCircle {
    return [this.cx, this.cy, this.length + this.thickness * 0.5 + 6.0];
  }

  /** Current arm tip positions, evenly spaced around the hub. */
  tips(): Vec2[] {
    const out: Vec2[] = [];
    for (let i = 0; i < this.arms; i++) {
      const a = this.angle + (i * TAU) / this.arms;
      out.push([
        this.cx + Math.cos(a) * this.length,
        this.cy + Math.sin(a) * this.length,
      ]);
    }
    return out;
  }

  protected override onUpdate(_dt: number, t: number): void {
    this.angle = this.phase + t * this.speed;
  }

  protected override onCollides(x: number, y: number, r: number): boolean {
    const reach = this.length + this.thickness * 0.5 + r;
    const dx = x - this.cx;
    const dy = y - this.cy;
    const d2 = dx * dx + dy * dy;
    if (d2 > reach * reach) return false; // cheap circular reject
    const limit = this.thickness * 0.5 + r;
    const hub = this.hubRadius + r;
    if (d2 <= hub * hub) return true;
    for (const [tx, ty] of this.tips()) {
      if (pointSegmentDist(x, y, this.cx, this.cy, tx, ty) <= limit) return true;
    }
    return false;
  }
}

// ==========================================================================
// Pulsar - breathing bomb, deadly only while inflated
// ==========================================================================

/** Constructor arguments for {@link Pulsar}; every field has a default. */
export interface PulsarOptions {
  cx?: number;
  cy?: number;
  min_radius?: number;
  max_radius?: number;
  period?: number;
  phase?: number;
  deadly_frac?: number;
  deadly?: boolean;
}

/**
 * A node that swells and shrinks on a cosine. It only kills once its radius
 * passes {@link Pulsar.deadlyFrac} of the way from min to max, and it
 * telegraphs that through {@link Pulsar.charge}, which reaches 1.0 exactly as
 * the hazard arms.
 */
export class Pulsar extends Obstacle {
  override readonly kind: ObstacleKind = "pulsar";

  cx: number;
  cy: number;
  /** Radius at the bottom of the breath. */
  minRadius: number;
  /** Radius at the top of the breath, always at least min + 4. */
  maxRadius: number;
  /** Seconds for one full breath. */
  period: number;
  /** 0..1 offset into the breath. */
  phase: number;
  /** Fraction of the min..max span at which it becomes lethal. */
  deadlyFrac: number;
  /** A disarmed pulsar is pure decoration and never sets `deadly`. */
  armed: boolean;
  /** Current radius. */
  radius: number;
  /** 0..1 charge tell - hits 1.0 the instant the pulsar arms. */
  charge = 0.0;

  constructor(opts: PulsarOptions = {}) {
    super(false);
    this.cx = opts.cx ?? 0.0;
    this.cy = opts.cy ?? 0.0;
    this.minRadius = Math.max(2.0, opts.min_radius ?? 12.0);
    this.maxRadius = Math.max(this.minRadius + 4.0, opts.max_radius ?? 62.0);
    this.period = Math.max(0.25, opts.period ?? 2.6);
    this.phase = opts.phase ?? 0.0;
    this.deadlyFrac = clamp(opts.deadly_frac ?? 0.55, 0.05, 0.95);
    this.armed = Boolean(opts.deadly ?? true);
    this.radius = this.minRadius;
    this.onUpdate(0.0, 0.0);
  }

  /** Radius at which the pulsar becomes lethal. */
  get threshold(): number {
    return lerp(this.minRadius, this.maxRadius, this.deadlyFrac);
  }

  override bounds(): RectLike {
    const r = this.maxRadius;
    return intRect(this.cx - r, this.cy - r, r * 2, r * 2);
  }

  override avoid(): AvoidCircle {
    return [this.cx, this.cy, this.maxRadius + 8.0];
  }

  protected override onUpdate(_dt: number, t: number): void {
    // 0.5 - 0.5*cos gives a smooth 0 -> 1 -> 0 with no corner at the peak.
    const u = pyMod(t / this.period + this.phase, 1.0);
    const s = 0.5 - 0.5 * Math.cos(u * TAU);
    this.radius = lerp(this.minRadius, this.maxRadius, s);
    this.charge = clamp(s / this.deadlyFrac, 0.0, 1.0);
    this.deadly = this.armed && this.radius >= this.threshold;
  }

  protected override onCollides(x: number, y: number, r: number): boolean {
    if (!this.deadly) return false;
    const dx = x - this.cx;
    const dy = y - this.cy;
    const rr = this.radius + r;
    return dx * dx + dy * dy <= rr * rr;
  }
}

// ==========================================================================
// LaserGate - charges, then fires
// ==========================================================================

/** Constructor arguments for {@link LaserGate}; every field has a default. */
export interface LaserGateOptions {
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
  period?: number;
  fire_time?: number;
  warn_time?: number;
  phase?: number;
  width?: number;
  deadly?: boolean;
}

/**
 * A beam between two emitters that cycles charge -> fire -> charge.
 *
 * While charging it is harmless; while firing it kills. {@link LaserGate.warn}
 * ramps 0..1 over the last `warnTime` seconds of the charge so the renderer can
 * give fair warning.
 */
export class LaserGate extends Obstacle {
  override readonly kind: ObstacleKind = "lasergate";

  /** Emitter A. */
  x1: number;
  y1: number;
  /** Emitter B. */
  x2: number;
  y2: number;
  /** Seconds for one charge + fire cycle. */
  period: number;
  /** Seconds of the cycle spent firing. */
  fireTime: number;
  /** Seconds of ramp-up before the shot. */
  warnTime: number;
  /** Cycle offset, expressed in periods (`phase * period` seconds). */
  phase: number;
  /** Beam width; collision radius is half this. */
  width: number;
  /** A disarmed gate is pure decoration and never sets `deadly`. */
  armed: boolean;
  /** True while the beam is out. */
  firing = false;
  /** 0..1 ramp just before firing; pinned at 1 while firing. */
  warn = 0.0;

  constructor(opts: LaserGateOptions = {}) {
    super(false);
    this.x1 = opts.x1 ?? 0.0;
    this.y1 = opts.y1 ?? 0.0;
    this.x2 = opts.x2 ?? 0.0;
    this.y2 = opts.y2 ?? 0.0;
    this.period = Math.max(0.4, opts.period ?? 3.0);
    this.fireTime = clamp(opts.fire_time ?? 0.9, 0.05, this.period * 0.9);
    this.warnTime = clamp(opts.warn_time ?? 0.7, 0.0, this.period - this.fireTime);
    this.phase = opts.phase ?? 0.0;
    this.width = Math.max(2.0, opts.width ?? 9.0);
    this.armed = Boolean(opts.deadly ?? true);
    this.onUpdate(0.0, 0.0);
  }

  override bounds(): RectLike {
    const pad = Math.trunc(this.width + 8);
    const left = Math.min(this.x1, this.x2);
    const right = Math.max(this.x1, this.x2);
    const top = Math.min(this.y1, this.y2);
    const bottom = Math.max(this.y1, this.y2);
    return {
      x: Math.trunc(left) - pad,
      y: Math.trunc(top) - pad,
      w: Math.trunc(right - left) + pad * 2,
      h: Math.trunc(bottom - top) + pad * 2,
    };
  }

  protected override onUpdate(_dt: number, t: number): void {
    const cycle = pyMod(t + this.phase * this.period, this.period);
    const chargeLen = this.period - this.fireTime;
    this.firing = cycle >= chargeLen;
    if (this.firing) {
      this.warn = 1.0;
    } else if (this.warnTime > 0.0) {
      this.warn = clamp((cycle - (chargeLen - this.warnTime)) / this.warnTime, 0.0, 1.0);
    } else {
      this.warn = 0.0;
    }
    this.deadly = this.armed && this.firing;
  }

  protected override onCollides(x: number, y: number, r: number): boolean {
    if (!this.deadly) return false;
    return (
      pointSegmentDist(x, y, this.x1, this.y1, this.x2, this.y2) <=
      this.width * 0.5 + r
    );
  }
}

// ==========================================================================
// Portal - the only non-deadly obstacle
// ==========================================================================

/** Constructor arguments for {@link Portal}; every field has a default. */
export interface PortalOptions {
  x?: number;
  y?: number;
  radius?: number;
  pair?: unknown;
}

/**
 * A swirling gate. Entering one ejects the traveller just outside its partner,
 * preserving the direction of travel so momentum feels continuous.
 *
 * A short shared cooldown after each jump stops the pair from ping-ponging the
 * head back and forth on consecutive frames.
 */
export class Portal extends Obstacle {
  override readonly kind: ObstacleKind = "portal";

  x: number;
  y: number;
  /** Mouth radius; the collision mouth is 85% of it. */
  radius: number;
  /** Spec-level grouping key, if any. */
  pair: unknown;
  /** The exit portal, wired by {@link buildObstacles}. */
  linked: Portal | null = null;
  /** Seconds left before this end will accept another traveller. */
  cooldown = 0.0;
  /** Flips the colour of the B end. */
  secondary = false;
  /** Vortex rotation in radians, for the renderer. */
  spin = 0.0;

  constructor(opts: PortalOptions = {}) {
    super(false);
    this.x = opts.x ?? 0.0;
    this.y = opts.y ?? 0.0;
    this.radius = Math.max(8.0, opts.radius ?? 26.0);
    this.pair = opts.pair ?? null;
  }

  /** Make this portal's exit `other` (and mark `other` as the B end). */
  link(other: Portal): void {
    this.linked = other;
    if (other !== this) other.secondary = !this.secondary;
  }

  override bounds(): RectLike {
    const r = this.radius;
    return intRect(this.x - r, this.y - r, r * 2, r * 2);
  }

  override avoid(): AvoidCircle {
    return [this.x, this.y, this.radius + 14.0];
  }

  protected override onUpdate(dt: number, t: number): void {
    if (this.cooldown > 0.0) this.cooldown = Math.max(0.0, this.cooldown - dt);
    this.spin = t * 1.6;
  }

  protected override onCollides(x: number, y: number, r: number): boolean {
    if (this.cooldown > 0.0) return false;
    const dx = x - this.x;
    const dy = y - this.y;
    // Slightly generous mouth so a fast head cannot skim the rim.
    const rr = this.radius * 0.85 + r;
    return dx * dx + dy * dy <= rr * rr;
  }

  /**
   * Return the exit position for something that entered here at `(x, y)`.
   *
   * The offset from this portal's centre is reused as the exit direction, so a
   * head that came in travelling right leaves travelling right. Both ends of
   * the pair go on cooldown.
   */
  teleport(x: number, y: number): Vec2 {
    try {
      const dst = this.linked ?? this;
      const dx = x - this.x;
      const dy = y - this.y;
      const d = Math.hypot(dx, dy);
      let ux = 1.0;
      let uy = 0.0;
      if (d >= 1e-5) {
        ux = dx / d;
        uy = dy / d;
      }
      const pad = dst.radius + PORTAL_EXIT_PAD;
      let ex = dst.x + ux * pad;
      let ey = dst.y + uy * pad;
      const arena = dst.arena ?? this.arena;
      if (arena !== null) {
        ex = clamp(ex, arena.x + 4.0, arena.x + arena.w - 4.0);
        ey = clamp(ey, arena.y + 4.0, arena.y + arena.h - 4.0);
      }
      this.cooldown = PORTAL_COOLDOWN;
      dst.cooldown = PORTAL_COOLDOWN;
      return [ex, ey];
    } catch {
      return [x, y];
    }
  }
}

// ==========================================================================
// Spec-driven factory
// ==========================================================================

/** Spec aliases -> canonical kind, the port of `_TYPE_MAP`. */
const TYPE_MAP: ReadonlyMap<string, ObstacleKind> = new Map<string, ObstacleKind>([
  ["wall", "wall"],
  ["wallblock", "wall"],
  ["block", "wall"],
  ["movingbar", "movingbar"],
  ["bar", "movingbar"],
  ["moving_bar", "movingbar"],
  ["spinner", "spinner"],
  ["pulsar", "pulsar"],
  ["lasergate", "lasergate"],
  ["laser", "lasergate"],
  ["laser_gate", "lasergate"],
  ["portal", "portal"],
]);

/**
 * The keyword names each kind accepts, standing in for Python's
 * `inspect.signature` lookup. Keys stay in the spec's snake_case.
 */
const ACCEPTED: Readonly<Record<ObstacleKind, ReadonlySet<string>>> = {
  obstacle: new Set(["deadly"]),
  wall: new Set(["x", "y", "w", "h", "deadly"]),
  movingbar: new Set(["x", "y", "w", "h", "axis", "travel", "speed", "phase", "deadly"]),
  spinner: new Set([
    "cx", "cy", "length", "arms", "speed", "thickness", "phase", "hub_radius", "deadly",
  ]),
  pulsar: new Set([
    "cx", "cy", "min_radius", "max_radius", "period", "phase", "deadly_frac", "deadly",
  ]),
  lasergate: new Set([
    "x1", "y1", "x2", "y2", "period", "fire_time", "warn_time", "phase", "width", "deadly",
  ]),
  portal: new Set(["x", "y", "radius", "pair"]),
};

// Which keys are fractions of what. Positions are offset from the arena
// origin; sizes are pure scalings.
const POS_X: ReadonlySet<string> = new Set(["x", "x1", "x2", "cx"]);
const POS_Y: ReadonlySet<string> = new Set(["y", "y1", "y2", "cy"]);
const SIZE_X: ReadonlySet<string> = new Set(["w", "width"]);
const SIZE_Y: ReadonlySet<string> = new Set(["h", "height"]);
const SIZE_MIN: ReadonlySet<string> = new Set([
  "length", "radius", "min_radius", "max_radius", "thickness", "hub_radius",
]);
const SIZE_AXIS: ReadonlySet<string> = new Set(["travel", "distance", "amplitude"]);

/** The spec spellings that mean "this hazard runs vertically". */
function isVerticalAxis(axis: string): boolean {
  const a = String(axis).trim().toLowerCase();
  return a === "y" || a === "v" || a === "vertical" || a === "1";
}

/** Accept a RectLike, a 4-number sequence, or nothing (falls back to ARENA). */
function asRect(rect: RectSource): RectLike {
  if (rect !== null && rect !== undefined) {
    if (Array.isArray(rect)) {
      const [x, y, w, h] = rect as readonly number[];
      if (
        typeof x === "number" && typeof y === "number" &&
        typeof w === "number" && typeof h === "number"
      ) {
        return intRect(x, y, w, h);
      }
    } else {
      const r = rect as Partial<RectLike>;
      if (
        typeof r.x === "number" && typeof r.y === "number" &&
        typeof r.w === "number" && typeof r.h === "number"
      ) {
        return intRect(r.x, r.y, r.w, r.h);
      }
    }
  }
  return intRect(C.ARENA_X, C.ARENA_Y, C.ARENA_W, C.ARENA_H);
}

/**
 * Turn a fractional spec value into arena pixels.
 *
 * Any numeric position or size with `abs(value) <= 1.0` is read as a fraction
 * of the arena; anything larger is already in pixels. Non-geometry keys
 * (speed, period, phase, arms, ...) are passed through untouched.
 */
function resolve(key: string, value: unknown, rect: RectLike, horizontal: boolean): unknown {
  if (typeof value !== "number" || !Number.isFinite(value)) return value;
  const v = value;
  if (Math.abs(v) > 1.0) return v;
  if (POS_X.has(key)) return rect.x + rect.w * v;
  if (POS_Y.has(key)) return rect.y + rect.h * v;
  if (SIZE_X.has(key)) return rect.w * v;
  if (SIZE_Y.has(key)) return rect.h * v;
  if (SIZE_MIN.has(key)) return Math.min(rect.w, rect.h) * v;
  if (SIZE_AXIS.has(key)) return (horizontal ? rect.w : rect.h) * v;
  return v;
}

/** Thrown internally when a spec value cannot be read; the entry is skipped. */
class SpecError extends Error {}

/** Read one numeric keyword, mirroring Python's `float(value)` in a ctor. */
function numArg(kw: Record<string, unknown>, key: string): number | undefined {
  const v = kw[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v.trim());
    if (v.trim() !== "" && Number.isFinite(n)) return n;
  }
  throw new SpecError(`${key} is not a number`);
}

/** Read one boolean keyword with Python's truthiness. */
function boolArg(kw: Record<string, unknown>, key: string): boolean | undefined {
  const v = kw[key];
  if (v === undefined) return undefined;
  return Boolean(v);
}

/** Read one string keyword, mirroring Python's `str(value)`. */
function strArg(kw: Record<string, unknown>, key: string): string | undefined {
  const v = kw[key];
  if (v === undefined || v === null) return undefined;
  return String(v);
}

/** Construct one hazard from already-resolved keyword values. */
function construct(kind: ObstacleKind, kw: Record<string, unknown>): Obstacle | null {
  switch (kind) {
    case "wall":
      return new WallBlock({
        x: numArg(kw, "x"),
        y: numArg(kw, "y"),
        w: numArg(kw, "w"),
        h: numArg(kw, "h"),
        deadly: boolArg(kw, "deadly"),
      });
    case "movingbar":
      return new MovingBar({
        x: numArg(kw, "x"),
        y: numArg(kw, "y"),
        w: numArg(kw, "w"),
        h: numArg(kw, "h"),
        axis: strArg(kw, "axis"),
        travel: numArg(kw, "travel"),
        speed: numArg(kw, "speed"),
        phase: numArg(kw, "phase"),
        deadly: boolArg(kw, "deadly"),
      });
    case "spinner":
      return new Spinner({
        cx: numArg(kw, "cx"),
        cy: numArg(kw, "cy"),
        length: numArg(kw, "length"),
        arms: numArg(kw, "arms"),
        speed: numArg(kw, "speed"),
        thickness: numArg(kw, "thickness"),
        phase: numArg(kw, "phase"),
        hub_radius: numArg(kw, "hub_radius"),
        deadly: boolArg(kw, "deadly"),
      });
    case "pulsar":
      return new Pulsar({
        cx: numArg(kw, "cx"),
        cy: numArg(kw, "cy"),
        min_radius: numArg(kw, "min_radius"),
        max_radius: numArg(kw, "max_radius"),
        period: numArg(kw, "period"),
        phase: numArg(kw, "phase"),
        deadly_frac: numArg(kw, "deadly_frac"),
        deadly: boolArg(kw, "deadly"),
      });
    case "lasergate":
      return new LaserGate({
        x1: numArg(kw, "x1"),
        y1: numArg(kw, "y1"),
        x2: numArg(kw, "x2"),
        y2: numArg(kw, "y2"),
        period: numArg(kw, "period"),
        fire_time: numArg(kw, "fire_time"),
        warn_time: numArg(kw, "warn_time"),
        phase: numArg(kw, "phase"),
        width: numArg(kw, "width"),
        deadly: boolArg(kw, "deadly"),
      });
    case "portal":
      return new Portal({
        x: numArg(kw, "x"),
        y: numArg(kw, "y"),
        radius: numArg(kw, "radius"),
        pair: kw["pair"] ?? null,
      });
    default:
      return null;
  }
}

/**
 * Wire portals into two-way pairs.
 *
 * Entries carrying an explicit `pair` key group by that key; the rest are
 * chunked in declaration order. Groups larger than two become a ring, and a
 * lonely portal links to itself (harmless: it just spits you back out).
 */
function linkPortals(portals: readonly Portal[]): void {
  const groups = new Map<unknown, Portal[]>();
  const loose: Portal[] = [];
  for (const p of portals) {
    if (p.pair === null || p.pair === undefined) {
      loose.push(p);
    } else {
      const bucket = groups.get(p.pair);
      if (bucket === undefined) groups.set(p.pair, [p]);
      else bucket.push(p);
    }
  }
  const ordered: Portal[][] = [...groups.values()];
  for (let i = 0; i < loose.length; i += 2) ordered.push(loose.slice(i, i + 2));

  for (const members of ordered) {
    const n = members.length;
    if (n === 0) continue;
    if (n === 1) {
      const only = members[0];
      if (only !== undefined) only.linked = only;
      continue;
    }
    for (let i = 0; i < n; i++) {
      const p = members[i];
      const next = members[(i + 1) % n];
      if (p === undefined || next === undefined) continue;
      p.secondary = i % 2 === 1;
      p.linked = next;
    }
  }
}

/**
 * Build a hazard list from plain spec dicts, exactly as they appear in
 * `levels.json`.
 *
 * Each entry needs a `type` key naming a kind in lowercase; the rest of the
 * object becomes constructor keywords, with fractional geometry resolved
 * against `rect`. Unknown types, malformed entries and bad values are skipped
 * silently - a level with a typo loses one hazard, not the game.
 */
export function buildObstacles(
  spec: Iterable<unknown> | null | undefined,
  rect: RectSource,
): Obstacle[] {
  const out: Obstacle[] = [];
  const arena = asRect(rect);
  if (spec === null || spec === undefined) return out;

  let entries: unknown[];
  try {
    entries = Array.from(spec);
  } catch {
    return out;
  }

  const portals: Portal[] = [];
  for (const raw of entries) {
    try {
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
      const entry = raw as Record<string, unknown>;
      const rawType = entry["type"];
      const name = String(rawType ?? "").trim().toLowerCase().replace(/-/g, "_");
      const kind = TYPE_MAP.get(name);
      if (kind === undefined) continue;

      const horizontal = !isVerticalAxis(String(entry["axis"] ?? "x"));
      const accepted = ACCEPTED[kind];

      const kw: Record<string, unknown> = {};
      for (const key of Object.keys(entry)) {
        if (key === "type" || !accepted.has(key)) continue;
        kw[key] = resolve(key, entry[key], arena, horizontal);
      }

      const ob = construct(kind, kw);
      if (ob === null) continue;
      ob.arena = arena;
      out.push(ob);
      if (ob instanceof Portal) portals.push(ob);
    } catch {
      continue; // a bad entry costs one hazard, never the level
    }
  }

  linkPortals(portals);
  return out;
}

/** Keep-out circles for every hazard, ready to hand to a spawner's `avoid`. */
export function obstacleAvoidList(obstacles: Iterable<Obstacle>): AvoidCircle[] {
  const out: AvoidCircle[] = [];
  for (const ob of obstacles) {
    try {
      out.push(ob.avoid());
    } catch {
      continue;
    }
  }
  return out;
}

/** Convenience: advance a whole list to absolute time `t`. */
export function updateObstacles(
  obstacles: Iterable<Obstacle>,
  dt: number,
  t: number,
): void {
  for (const ob of obstacles) ob.update(dt, t);
}
