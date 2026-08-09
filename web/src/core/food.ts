/**
 * Food entities and the field that manages them.
 *
 * A direct port of `snake/core/food.py` (simulation only - no rendering).
 *
 * Three kinds of pickup live in the arena:
 *
 *     normal  worth C.SCORE_PER_FOOD, never expires, the staple of every level
 *     bonus   worth ~3x, slightly larger, evaporates after ~8 seconds
 *     mega    worth ~8x, rare, largest, evaporates fast and grows the snake a lot
 *
 * Every orb bobs on a sine wave and breathes (radius pulse) so the arena never
 * looks static, and anything with a finite time-to-live blinks urgently in its
 * final second. The presentation helpers (`drawPos`, `drawRadius`, `visible`)
 * are exposed here so the renderer can stay a thin consumer, exactly as in the
 * Python original where `gfx.render.draw_food_orb` only consumed them.
 */

import * as C from "./config";
import {
  TAU,
  clamp,
  distSq,
  easeOutBack,
  lerp,
  makeRng,
  randRange,
  type RectLike,
} from "./mathx";
// The colour maths lives in exactly one place. This module used to carry a
// private copy of it, which silently drifted: its `clamp8` rounded where
// Python's `int()` truncates, so `foodColor("bonus", ...)` came out one unit
// bright on two channels. Importing the shared port removes the whole class of
// drift - `palette.ts` is verified against `snake/palette.py` in parity.spec.
import {
  UI_GOLD,
  UI_WHITE,
  clamp8,
  hueShift,
  lerpColor,
  rainbow,
  type RGB as PaletteRGB,
} from "./palette";

// --------------------------------------------------------------------------
// Colour helpers (all of them re-exported from `palette`, which is this
// package's single port of `snake/palette.py`)
// --------------------------------------------------------------------------

/** An 8-bit RGB triple. Re-exported so consumers need not import `palette`. */
export type RGB = PaletteRGB;

/**
 * The part of a level `Theme` that food cares about.
 *
 * Structural on purpose: both the raw entries of `data/themes.json` (whose
 * colours are `number[]`) and a richer typed Theme satisfy it.
 */
export interface FoodTheme {
  readonly food: readonly number[];
  readonly accent2: readonly number[];
}

/**
 * Coerce a loose colour array into an RGB triple.
 *
 * `FoodTheme` is deliberately structural, so a theme's colours arrive as a
 * plain `readonly number[]` (that is what `data/themes.json` decodes to). This
 * narrows one to the triple the palette helpers want.
 */
function toRgb(c: readonly number[] | undefined | null): RGB {
  if (!c) return [255, 255, 255];
  return [clamp8(c[0] ?? 0), clamp8(c[1] ?? 0), clamp8(c[2] ?? 0)];
}

// --------------------------------------------------------------------------
// Kind table
// --------------------------------------------------------------------------

/** The three collectable kinds. */
export type FoodKind = "normal" | "bonus" | "mega";

/** Static description of one food kind. */
export interface FoodSpec {
  /** Display name used by HUD pop-ups. */
  readonly name: string;
  /** Score awarded on pickup. */
  readonly value: number;
  /** Base drawing / collision radius. */
  readonly radius: number;
  /** Seconds of life; `<= 0` means "never expires". */
  readonly ttl: number;
  /** Body segments the snake gains. */
  readonly grow: number;
  /** Relative chance of a random special roll. */
  readonly weight: number;
}

/**
 * The kind table, keyed exactly as in Python.
 *
 * `ttl <= 0` means "never expires". `grow` is how many body segments the
 * snake gains, `weight` is the relative chance of a random special roll.
 */
export const FOOD_KINDS: Readonly<Record<FoodKind, FoodSpec>> = {
  normal: {
    name: "Orb",
    value: C.SCORE_PER_FOOD,
    radius: C.FOOD_RADIUS,
    ttl: 0.0,
    grow: C.SNAKE_GROW_PER_FOOD,
    weight: 0.0,
  },
  bonus: {
    name: "Bonus",
    value: C.SCORE_PER_FOOD * 3,
    radius: C.FOOD_RADIUS * 1.28,
    ttl: 8.0,
    grow: C.SNAKE_GROW_PER_FOOD * 2,
    weight: 0.78,
  },
  mega: {
    name: "Mega",
    value: C.SCORE_PER_FOOD * 8,
    radius: C.FOOD_RADIUS * 1.65,
    ttl: 4.5,
    grow: C.SNAKE_GROW_PER_FOOD * 4,
    weight: 0.22,
  },
};

/** The kinds that spawn on their own timers. */
export const SPECIAL_KINDS: readonly FoodKind[] = ["bonus", "mega"];

/** True when `kind` names a real entry in {@link FOOD_KINDS}. */
export function isFoodKind(kind: string): kind is FoodKind {
  return kind === "normal" || kind === "bonus" || kind === "mega";
}

// Placement: keep orbs off the arena edge by roughly one orb diameter so the
// glow halo never bleeds through the neon border.
/** Edge padding applied when placing an orb. */
export const SPAWN_MARGIN: number = C.FOOD_RADIUS * 2.0 + C.FOOD_PICKUP_PAD;
/** Hard cap on placement attempts - never loop forever. */
export const SPAWN_TRIES = 64;
/** Minimum centre-to-centre gap between two orbs. */
export const MIN_FOOD_SEPARATION: number = C.FOOD_RADIUS * 3.4;

// Motion / presentation
/** Radians per second of vertical bob. */
export const BOB_SPEED = 1.9;
/** Pixels of vertical bob travel. */
export const BOB_AMOUNT = 3.2;
/** +/- fraction of the base radius for the breathing pulse. */
export const PULSE_AMOUNT = 0.1;
/** Spawn scale-up duration, seconds. */
export const POP_IN_TIME = 0.34;
/** Orbs blink during their last `BLINK_LEAD` seconds. */
export const BLINK_LEAD = 1.0;

/** Random seconds between auto bonus spawns. */
export const BONUS_INTERVAL: readonly [number, number] = [9.0, 17.0];
/** Random seconds between auto mega spawns. */
export const MEGA_INTERVAL: readonly [number, number] = [24.0, 40.0];

/** A circle the spawner must keep clear of: `[x, y, radius]`. */
export type AvoidCircle = readonly [number, number, number];

// ==========================================================================
// Food
// ==========================================================================

/** One collectable orb sitting in the arena. */
export interface Food {
  x: number;
  y: number;
  kind: FoodKind;
  /** Score awarded on pickup. */
  value: number;
  /** Base radius (before bob / pulse / wither). */
  radius: number;
  /** Simulation time the orb appeared. */
  born: number;
  /** Seconds of life; `<= 0` means immortal. */
  ttl: number;
  /** Body segments the snake gains on pickup. */
  grow: number;
  /** Cached colour; refreshed each frame for mega orbs. */
  color: RGB;
  /** Per-orb bob offset so neighbours de-sync. */
  phase: number;
  /** Per-orb spin offset for the renderer. */
  spin: number;
  /** Collected or expired. */
  dead: boolean;
}

/** Seconds since this orb appeared (never negative). */
export function age(f: Food, t: number): number {
  return t > f.born ? t - f.born : 0.0;
}

/** Seconds of life left; `Infinity` for orbs that never expire. */
export function remaining(f: Food, t: number): number {
  if (f.ttl <= 0.0) return Infinity;
  return f.ttl - age(f, t);
}

/** True once a perishable orb has run out its time-to-live. */
export function expired(f: Food, t: number): boolean {
  return f.ttl > 0.0 && age(f, t) >= f.ttl;
}

/** True when the orb has a finite lifetime. */
export function perishable(f: Food): boolean {
  return f.ttl > 0.0;
}

/** Vertical hover offset in pixels; the phase de-syncs neighbours. */
export function bobOffset(f: Food, t: number): number {
  return Math.sin(t * BOB_SPEED + f.phase) * BOB_AMOUNT;
}

/** Where the orb should be drawn at time `t` (centre plus the bob). */
export function drawPos(f: Food, t: number): { x: number; y: number } {
  return { x: f.x, y: f.y + bobOffset(f, t) };
}

/**
 * Base radius modulated by three effects, multiplied together:
 *
 *   - pop-in  - easeOutBack overshoot for the first POP_IN_TIME seconds
 *   - breathe - a slow sine pulse at C.FOOD_PULSE_SPEED
 *   - wither  - perishable orbs shrink slightly as they run out of time
 */
export function drawRadius(f: Food, t: number): number {
  const a = age(f, t);
  let scale = 1.0;
  if (a < POP_IN_TIME) scale *= easeOutBack(a / POP_IN_TIME);
  scale *= 1.0 + PULSE_AMOUNT * Math.sin(t * C.FOOD_PULSE_SPEED + f.phase);
  const left = remaining(f, t);
  if (left !== Infinity && left < BLINK_LEAD) {
    scale *= lerp(0.72, 1.0, clamp(left / BLINK_LEAD, 0.0, 1.0));
  }
  return Math.max(1.0, f.radius * scale);
}

/**
 * False on the "off" half of the end-of-life blink.
 *
 * The blink phase is `k * remaining ** 0.6`; because the exponent is below 1
 * its rate of change grows as `remaining` approaches zero, so the flashing
 * visibly accelerates instead of ticking at a constant rate.
 */
export function visible(f: Food, t: number): boolean {
  const left = remaining(f, t);
  if (left === Infinity || left >= BLINK_LEAD) return true;
  if (left <= 0.0) return false;
  const phase = 34.0 * Math.pow(left, 0.6);
  return Math.sin(phase) > -0.3;
}

/** The forgiving radius used for pickup tests. */
export function pickupRadius(f: Food): number {
  return f.radius + C.FOOD_PICKUP_PAD;
}

/** Circle overlap against the (forgiving) pickup radius. */
export function overlaps(f: Food, x: number, y: number, r: number): boolean {
  const reach = pickupRadius(f) + Math.max(0.0, r);
  return distSq(f.x, f.y, x, y) <= reach * reach;
}

/**
 * Theme-derived colour for a kind.
 *
 * normal follows `theme.food`, bonus leans on the secondary neon so it reads
 * as "different but related", and mega cycles a slow rainbow washed toward
 * white to sell its rarity.
 */
export function foodColor(
  kind: FoodKind | string,
  theme: FoodTheme | null | undefined,
  t: number,
): RGB {
  const base: RGB = theme ? toRgb(theme.food) : UI_GOLD;
  const alt: RGB = theme ? toRgb(theme.accent2) : UI_WHITE;
  if (kind === "bonus") {
    // Drift between the two neons so the orb never sits on one hue.
    const mix = 0.5 + 0.5 * Math.sin(t * 1.7);
    return lerpColor(alt, hueShift(base, 0.08), mix);
  }
  if (kind === "mega") {
    return lerpColor(rainbow(t * 0.22, 0.72, 1.0), UI_WHITE, 0.22);
  }
  return base;
}

/** Build a Food of `kind` (unknown kinds degrade to "normal"). */
export function makeFood(
  x: number,
  y: number,
  kind: FoodKind | string,
  t: number,
  theme?: FoodTheme | null,
  rng?: () => number,
): Food {
  const k: FoodKind = isFoodKind(kind) ? kind : "normal";
  const spec = FOOD_KINDS[k];
  const r = rng ?? Math.random;
  return {
    x,
    y,
    kind: k,
    value: Math.trunc(spec.value),
    radius: spec.radius,
    born: t,
    ttl: spec.ttl,
    grow: Math.trunc(spec.grow),
    color: foodColor(k, theme ?? null, t),
    phase: randRange(r, 0.0, TAU),
    spin: randRange(r, 0.0, TAU),
    dead: false,
  };
}

// ==========================================================================
// FoodField
// ==========================================================================

/** A rect accepted by the field: `RectLike` or a plain `[x, y, w, h]`. */
export type RectSpec = RectLike | readonly [number, number, number, number];

/**
 * Owns every Food in one arena: spawning, ageing and collection.
 *
 * The caller drives it with `ensure(n, avoid)` each frame to keep the arena
 * stocked; specials appear on their own timers unless `autoSpecial` is
 * switched off. Set `.avoid` to the level's static obstacle circles so the
 * internal timers place their spawns legally too.
 */
export class FoodField {
  /** The arena the orbs live in. */
  public rect: RectLike;
  /** Theme used to colour new and shimmering orbs. */
  public theme: FoodTheme | null;
  /** Every live orb, oldest first. */
  public items: Food[] = [];
  /** Standing circles the spawner keeps clear of: `[x, y, radius]`. */
  public avoid: AvoidCircle[] = [];
  /** When false the bonus / mega timers stop firing. */
  public autoSpecial = true;
  /** Deterministic source of randomness for placement and timers. */
  public readonly rng: () => number;
  /** Total orbs ever spawned (HUD / end screen stat). */
  public spawnedTotal = 0;
  /** Total orbs that died of old age (HUD / end screen stat). */
  public expiredTotal = 0;

  private t = 0.0;
  private nextBonus: number;
  private nextMega: number;

  /**
   * @param rect  arena bounds the orbs are confined to
   * @param theme colour identity for the level (null is tolerated)
   * @param seed  RNG seed; the same seed always produces the same layout
   */
  constructor(rect: RectSpec, theme?: FoodTheme | null, seed = 0x5eed) {
    this.rect = FoodField.asRect(rect);
    this.theme = theme ?? null;
    this.rng = makeRng(seed);
    this.nextBonus = randRange(this.rng, BONUS_INTERVAL[0], BONUS_INTERVAL[1]);
    this.nextMega = randRange(this.rng, MEGA_INTERVAL[0], MEGA_INTERVAL[1]);
  }

  // -- geometry ----------------------------------------------------------

  /** Accept a RectLike or a 4-tuple; anything degenerate falls back to the arena. */
  private static asRect(rect: RectSpec): RectLike {
    const fallback: RectLike = {
      x: C.ARENA_X,
      y: C.ARENA_Y,
      w: C.ARENA_W,
      h: C.ARENA_H,
    };
    if (!rect) return fallback;
    let out: RectLike;
    if (Array.isArray(rect)) {
      const a = rect as readonly number[];
      out = { x: a[0] ?? 0, y: a[1] ?? 0, w: a[2] ?? 0, h: a[3] ?? 0 };
    } else {
      const r = rect as RectLike;
      out = { x: r.x, y: r.y, w: r.w, h: r.h };
    }
    if (
      !Number.isFinite(out.x) ||
      !Number.isFinite(out.y) ||
      !Number.isFinite(out.w) ||
      !Number.isFinite(out.h)
    ) {
      return fallback;
    }
    return out;
  }

  /** Retarget the field at a new arena (used when a level changes). */
  public setRect(rect: RectSpec): void {
    this.rect = FoodField.asRect(rect);
  }

  private get left(): number {
    return this.rect.x;
  }
  private get top(): number {
    return this.rect.y;
  }
  private get right(): number {
    return this.rect.x + this.rect.w;
  }
  private get bottom(): number {
    return this.rect.y + this.rect.h;
  }

  // -- queries -----------------------------------------------------------

  /** Number of orbs, optionally of one kind only. */
  public count(kind?: FoodKind): number {
    if (kind === undefined) return this.items.length;
    let n = 0;
    for (const f of this.items) if (f.kind === kind) n += 1;
    return n;
  }

  /** True when at least one orb of `kind` is on the field. */
  public has(kind: FoodKind): boolean {
    for (const f of this.items) if (f.kind === kind) return true;
    return false;
  }

  /** Closest orb to a point, or null when the field is empty. */
  public nearest(x: number, y: number): Food | null {
    let best: Food | null = null;
    let bestD = Infinity;
    for (const f of this.items) {
      const d = distSq(f.x, f.y, x, y);
      if (d < bestD) {
        bestD = d;
        best = f;
      }
    }
    return best;
  }

  /** Remove every orb. */
  public clear(): void {
    this.items.length = 0;
  }

  // -- spawning ----------------------------------------------------------

  /**
   * Signed clearance at (x, y): positive means legal, and larger is better.
   *
   * Returns the smallest gap to any avoid circle or existing orb.
   */
  private blocked(
    x: number,
    y: number,
    r: number,
    avoid: readonly AvoidCircle[] | null,
  ): number {
    let best = Infinity;
    if (avoid) {
      for (const entry of avoid) {
        const ax = entry[0];
        const ay = entry[1];
        const ar = entry[2];
        if (!Number.isFinite(ax) || !Number.isFinite(ay) || !Number.isFinite(ar)) {
          continue; // malformed entry: ignore rather than crash
        }
        const gap = Math.hypot(x - ax, y - ay) - (ar + r);
        if (gap < best) best = gap;
      }
    }
    for (const f of this.items) {
      const gap = Math.hypot(x - f.x, y - f.y) - MIN_FOOD_SEPARATION;
      if (gap < best) best = gap;
    }
    return best;
  }

  /**
   * Rejection-sample a legal position inside the arena.
   *
   * Bounded to SPAWN_TRIES attempts; if every candidate is blocked we give up
   * and return null rather than spinning forever on a level whose free space
   * has been swallowed by obstacles and snake.
   */
  private pickSpot(
    r: number,
    avoid: readonly AvoidCircle[] | null,
  ): { x: number; y: number } | null {
    const pad = SPAWN_MARGIN + r;
    const x0 = this.left + pad;
    const x1 = this.right - pad;
    const y0 = this.top + pad;
    const y1 = this.bottom - pad;
    if (x1 <= x0 || y1 <= y0) {
      // degenerate arena - fall back to the centre
      return { x: (this.left + this.right) * 0.5, y: (this.top + this.bottom) * 0.5 };
    }
    for (let i = 0; i < SPAWN_TRIES; i += 1) {
      const x = randRange(this.rng, x0, x1);
      const y = randRange(this.rng, y0, y1);
      if (this.blocked(x, y, r, avoid) > 0.0) return { x, y };
    }
    return null;
  }

  /** Combine the caller's avoid list with the field's standing one. */
  private mergedAvoid(avoid?: readonly AvoidCircle[] | null): AvoidCircle[] {
    const merged: AvoidCircle[] = [];
    if (this.avoid.length) merged.push(...this.avoid);
    if (avoid && avoid.length) merged.push(...avoid);
    return merged;
  }

  /**
   * Place one orb of `kind`.
   *
   * Returns the new Food, or null when no legal spot was found within the
   * retry budget (the field is simply left as it was).
   */
  public spawn(
    kind: FoodKind = "normal",
    avoid?: readonly AvoidCircle[] | null,
  ): Food | null {
    const k: FoodKind = isFoodKind(kind) ? kind : "normal";
    const spec = FOOD_KINDS[k];
    const spot = this.pickSpot(spec.radius, this.mergedAvoid(avoid));
    if (spot === null) return null;
    const f = makeFood(spot.x, spot.y, k, this.t, this.theme, this.rng);
    this.items.push(f);
    this.spawnedTotal += 1;
    return f;
  }

  /** Top the field back up to `n` *normal* orbs (specials don't count). */
  public ensure(n: number, avoid?: readonly AvoidCircle[] | null): void {
    const need = Math.trunc(n) - this.count("normal");
    // One spawn attempt per missing orb, and no more: a crowded arena simply
    // stays under-stocked for a frame instead of stalling.
    for (let i = 0; i < Math.max(0, need); i += 1) {
      if (this.spawn("normal", avoid) === null) break;
    }
  }

  // -- per-frame ---------------------------------------------------------

  /** Age the field: retire expired orbs, refresh shimmer, roll specials. */
  public update(dt = 0.0, t = 0.0): void {
    this.t = t;
    const step = clamp(dt, 0.0, C.MAX_DT);

    if (this.items.length) {
      const survivors: Food[] = [];
      for (const f of this.items) {
        if (f.dead || expired(f, this.t)) {
          this.expiredTotal += 1;
          continue;
        }
        if (f.kind === "mega") {
          // Mega orbs shimmer, so their cached colour is live.
          f.color = foodColor("mega", this.theme, this.t);
        }
        survivors.push(f);
      }
      if (survivors.length !== this.items.length) this.items = survivors;
    }

    if (this.autoSpecial) this.tickSpecials(step);
  }

  /** Countdown timers that sprinkle bonus / mega orbs into the arena. */
  private tickSpecials(dt: number): void {
    this.nextBonus -= dt;
    if (this.nextBonus <= 0.0) {
      this.nextBonus = randRange(this.rng, BONUS_INTERVAL[0], BONUS_INTERVAL[1]);
      if (!this.has("bonus")) this.spawn("bonus");
    }
    this.nextMega -= dt;
    if (this.nextMega <= 0.0) {
      this.nextMega = randRange(this.rng, MEGA_INTERVAL[0], MEGA_INTERVAL[1]);
      if (!this.has("mega")) this.spawn("mega");
    }
  }

  /** Remove and return every orb overlapping the circle (x, y, r). */
  public collectAt(x: number, y: number, r: number): Food[] {
    const taken: Food[] = [];
    if (!this.items.length) return taken;
    const kept: Food[] = [];
    for (const f of this.items) {
      if (overlaps(f, x, y, r)) {
        f.dead = true;
        taken.push(f);
      } else {
        kept.push(f);
      }
    }
    if (taken.length) this.items = kept;
    return taken;
  }

  /**
   * Drag nearby orbs toward (x, y) - the magnet power-up.
   *
   * Pull falls off linearly with distance so far orbs barely stir while close
   * ones snap in. Positions stay clamped inside the arena.
   */
  public attract(
    x: number,
    y: number,
    dt: number,
    radius = 260.0,
    strength = 340.0,
  ): void {
    if (radius <= 0.0 || !this.items.length) return;
    const step = clamp(dt, 0.0, C.MAX_DT);
    const r2 = radius * radius;
    for (const f of this.items) {
      const dx = x - f.x;
      const dy = y - f.y;
      const d2 = dx * dx + dy * dy;
      if (d2 <= 1.0 || d2 > r2) continue;
      const d = Math.sqrt(d2);
      const pull = strength * (1.0 - d / radius) * step;
      f.x += (dx / d) * pull;
      f.y += (dy / d) * pull;
      f.x = clamp(f.x, this.left + f.radius, this.right - f.radius);
      f.y = clamp(f.y, this.top + f.radius, this.bottom - f.radius);
    }
  }

  // -- per-item presentation helpers (thin wrappers the renderer uses) ----

  /** Draw position of `f` at time `t`, bob included. */
  public drawPos(f: Food, t: number): { x: number; y: number } {
    return drawPos(f, t);
  }

  /** Draw radius of `f` at time `t`, pop-in / breathe / wither included. */
  public drawRadius(f: Food, t: number): number {
    return drawRadius(f, t);
  }

  /** Whether `f` is on the "on" half of its end-of-life blink. */
  public visible(f: Food, t: number): boolean {
    return visible(f, t);
  }

  /** Whether `f` has run out its time-to-live. */
  public expired(f: Food, t: number): boolean {
    return expired(f, t);
  }

  /** The forgiving pickup radius of `f`. */
  public pickupRadius(f: Food): number {
    return pickupRadius(f);
  }

  /** Live colour for `f` at time `t`. */
  public colorFor(f: Food, t: number): RGB {
    return f.kind === "mega" ? f.color : foodColor(f.kind, this.theme, t);
  }
}
