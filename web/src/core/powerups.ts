/**
 * Power-ups: the six temporary boons that drop into the arena.
 *
 *     magnet   drags nearby food toward the head
 *     shield   absorbs exactly one hit
 *     slow     slows the snake down so tight lanes become steerable
 *     double   doubles every point scored while it lasts
 *     ghost    lets the head pass straight through its own body
 *     frenzy   extra food spawns plus a speed kick
 *
 * A direct port of `snake/core/powerups.py`, simulation only. Three pieces
 * live here:
 *
 *     POWERUP_TYPES   the static table (name / colour / icon / duration / desc)
 *     PowerUpField    spawning, lifetime, blinking and pickup
 *     ActiveEffects   the per-run countdown bookkeeping
 *
 * Everything the Python module did with pygame surfaces (the rune sprite
 * stack, the glyph cache, the additive halo) is the renderer's job in the web
 * build, so it is absent here. The *presentation maths* the renderer needs -
 * `powerUpBrightness`, `powerUpDrawRadius`, the per-item spin phase - is
 * ported, because it is part of how a rune reads and it is pure arithmetic.
 */

import themeData from "../data/themes.json";
import * as C from "./config";
import { TAU, clamp, easeOutBack, lerp, pulse, makeRng, randRange } from "./mathx";
import type { RectLike } from "./mathx";

/** An 8-bit RGB triple, matching `snake/palette.py`. */
export type RGB = readonly [number, number, number];

/** The six power-up kinds. Anything else is an "unknown kind" fallback. */
export type PowerUpKind =
  | "magnet"
  | "shield"
  | "slow"
  | "double"
  | "ghost"
  | "frenzy";

/** One row of the static power-up table. */
export interface PowerUpInfo {
  /** Display name, as the HUD and the help screen print it. */
  readonly name: string;
  /** Signature colour, deliberately theme-independent. */
  readonly color: RGB;
  /** Short ASCII label the HUD may print next to a timer. */
  readonly icon: string;
  /** Seconds the effect lasts once collected. */
  readonly duration: number;
  /** One-line description for the help screen. */
  readonly desc: string;
}

const UI_WHITE: RGB = ((): RGB => {
  const ui = (themeData as { ui?: Record<string, number[] | undefined> }).ui;
  const c = ui?.["UI_WHITE"];
  if (c && c.length >= 3) {
    const [r, g, b] = c;
    if (r !== undefined && g !== undefined && b !== undefined) return [r, g, b];
  }
  return [240, 246, 255];
})();

// ==========================================================================
// The type table
// ==========================================================================
// Colours are deliberately theme-independent: a player must be able to read a
// power-up at a glance on every one of the twelve level palettes, so each kind
// owns a fixed, well-separated hue (crimson / cyan / indigo / gold / pale /
// magenta).
/** The static table of the six kinds, keyed exactly as the Python dict was. */
export const POWERUP_TYPES: Readonly<Record<PowerUpKind, PowerUpInfo>> = {
  magnet: {
    name: "Magnet",
    color: [255, 92, 96],
    icon: "M",
    duration: 8.0,
    desc: "Food is pulled toward your head.",
  },
  shield: {
    name: "Shield",
    color: [86, 220, 255],
    icon: "S",
    duration: 12.0,
    desc: "Absorbs the next hit you take.",
  },
  slow: {
    name: "Slow-Mo",
    color: [144, 124, 255],
    icon: "T",
    duration: 6.5,
    desc: "Slows you down for surgical steering.",
  },
  double: {
    name: "Double",
    color: [255, 208, 84],
    icon: "2x",
    duration: 10.0,
    desc: "Every pickup is worth double points.",
  },
  ghost: {
    name: "Ghost",
    color: [214, 228, 255],
    icon: "G",
    duration: 6.0,
    desc: "Pass straight through your own body.",
  },
  frenzy: {
    name: "Frenzy",
    color: [255, 74, 190],
    icon: "F",
    duration: 8.0,
    desc: "Extra food, and you move faster.",
  },
};

/** The six kinds in table order. */
export const POWERUP_KINDS: readonly PowerUpKind[] = [
  "magnet",
  "shield",
  "slow",
  "double",
  "ghost",
  "frenzy",
];

/**
 * Relative roll chance. The defensive kinds show up a little more often than
 * the score kinds, which keeps late levels survivable without making them easy.
 */
export const SPAWN_WEIGHTS: Readonly<Record<PowerUpKind, number>> = {
  magnet: 1.15,
  shield: 1.1,
  slow: 0.95,
  double: 1.0,
  ghost: 0.85,
  frenzy: 0.75,
};

// --------------------------------------------------------------------------
// Behaviour numbers other systems may read instead of inventing their own
// --------------------------------------------------------------------------
/** Pixels of pull range around the head while `magnet` runs. */
export const MAGNET_RADIUS = 210.0;
/** Pixels / second of pull at point-blank range. */
export const MAGNET_STRENGTH = 340.0;
/** Snake speed multiplier while `slow` runs. */
export const SLOW_SPEED_MULT = 0.62;
/** The tighter turning that pairs with `slow`. */
export const SLOW_TURN_MULT = 1.35;
/** Snake speed multiplier while `frenzy` runs. */
export const FRENZY_SPEED_MULT = 1.22;
/** Extra orbs the food field keeps stocked while `frenzy` runs. */
export const FRENZY_EXTRA_FOOD = 3;
/** Score multiplier while `double` runs. */
export const DOUBLE_SCORE_MULT = 2;

// --------------------------------------------------------------------------
// Field / presentation tuning
// --------------------------------------------------------------------------
/** Never more than ~two runes on screen. */
export const MAX_ACTIVE = 2;
/** Keeps the halo off the arena border. */
export const SPAWN_MARGIN = C.POWERUP_RADIUS * 2.6;
/** Hard cap: placement never loops forever. */
export const SPAWN_TRIES = 48;
/** Runes never touch each other. */
export const MIN_SEPARATION = C.POWERUP_RADIUS * 5.0;
/** Re-roll wait, in seconds, when the field is already at capacity. */
export const RETRY_DELAY: readonly [number, number] = [1.5, 2.5];

/** Scale-up on arrival, seconds. */
export const POP_IN_TIME = 0.42;
/** Start blinking this long before expiry. */
export const BLINK_LEAD = 2.4;
/** Radians / second of rune rotation. */
export const SPIN_SPEED = 0.85;
/** Radians / second of the orbiting node ring. */
export const ORBIT_SPEED = 1.7;
/** Nodes in the orbit ring. */
export const ORBIT_NODES = 5;
/** Radians / second of the breathing core. */
export const CORE_PULSE_SPEED = 4.6;
/** Halo radius as a multiple of the rune radius. */
export const GLOW_SCALE = 2.7;

// ==========================================================================
// Small shared helpers
// ==========================================================================

/** Title-case a bare kind string, matching Python's `str.title()`. */
function titleCase(s: string): string {
  return s.replace(/\w+/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

function isKind(kind: string): kind is PowerUpKind {
  return Object.prototype.hasOwnProperty.call(POWERUP_TYPES, kind);
}

/** Table row for `kind`, or a neutral stand-in for an unknown kind. */
export function powerupInfo(kind: string): PowerUpInfo {
  if (isKind(kind)) return POWERUP_TYPES[kind];
  return {
    name: titleCase(String(kind)) || "Boon",
    color: UI_WHITE,
    icon: "?",
    duration: C.POWERUP_DEFAULT_DURATION,
    desc: "",
  };
}

/** Signature colour of a power-up kind. */
export function powerupColor(kind: string): RGB {
  const col = powerupInfo(kind).color;
  const [r, g, b] = col;
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return UI_WHITE;
  return [Math.trunc(r), Math.trunc(g), Math.trunc(b)];
}

/** How long `kind` lasts once collected, in seconds. */
export function powerupDuration(kind: string): number {
  const d = powerupInfo(kind).duration;
  if (!Number.isFinite(d) || d <= 0) return C.POWERUP_DEFAULT_DURATION;
  return d;
}

// ==========================================================================
// PowerUp
// ==========================================================================

/** One rune sitting in the arena, waiting to be swallowed. */
export interface PowerUp {
  x: number;
  y: number;
  kind: string;
  /** Field clock stamp at spawn. */
  born: number;
  /** Seconds of life before this rune fades out. */
  ttl: number;
  radius: number;
  /** Integrated age in seconds (Python's `_age`). */
  age: number;
  /** Per-item spin offset in radians (Python's `_phase`). */
  phase: number;
  /** Rotation sense, +1 or -1 (Python's `_spin`). */
  spin: number;
}

/**
 * Seconds since spawn. Pass the field clock for an absolute answer, or
 * nothing to use the rune's own integrated age.
 */
export function powerUpAge(p: PowerUp, t?: number): number {
  if (t === undefined) return p.age;
  return Math.max(0, t - p.born);
}

/** Seconds of life left before this rune fades out. */
export function powerUpRemaining(p: PowerUp, t?: number): number {
  return Math.max(0, p.ttl - powerUpAge(p, t));
}

/** True once the rune has outlived its ttl. */
export function powerUpExpired(p: PowerUp, t?: number): boolean {
  return powerUpAge(p, t) >= p.ttl;
}

/** How long this rune's effect lasts once collected. */
export function powerUpDuration(p: PowerUp): number {
  return powerupDuration(p.kind);
}

/**
 * 0..1 visibility.
 *
 * Full brightness for most of the life, then a blink that accelerates as the
 * rune runs out - slow warning pulses turning into a frantic strobe.
 */
export function powerUpBrightness(p: PowerUp): number {
  const left = powerUpRemaining(p);
  if (left >= BLINK_LEAD) return 1.0;
  const u = clamp(left / BLINK_LEAD, 0, 1); // 1 -> 0 as it dies
  const freq = lerp(22.0, 6.0, u); // faster blink when lower
  const blink = 0.5 + 0.5 * Math.sin(p.age * freq);
  // Never fully invisible, and the floor lifts with the time left.
  return clamp(0.3 + 0.7 * u * u + 0.34 * blink * (1.0 - u), 0, 1);
}

/** Base radius with the spawn pop-in and a gentle breathing pulse. */
export function powerUpDrawRadius(p: PowerUp): number {
  let r = p.radius;
  if (p.age < POP_IN_TIME) {
    r *= clamp(easeOutBack(p.age / POP_IN_TIME), 0, 1.4);
  }
  r *= 0.94 + 0.06 * pulse(p.age * CORE_PULSE_SPEED + p.phase);
  return Math.max(2.0, r);
}

/** Collision radius, padded so a near miss still counts as a pickup. */
export function powerUpPickupRadius(p: PowerUp): number {
  return p.radius + C.FOOD_PICKUP_PAD;
}

/** True when the circle (x, y, r) touches this rune. */
export function powerUpOverlaps(p: PowerUp, x: number, y: number, r: number): boolean {
  const dx = x - p.x;
  const dy = y - p.y;
  const rr = powerUpPickupRadius(p) + Math.max(0, r);
  return dx * dx + dy * dy <= rr * rr;
}

// ==========================================================================
// PowerUpField
// ==========================================================================

/** A circle the field must not spawn on top of: `[x, y, radius]`. */
export type AvoidSpot = readonly [number, number, number];

/**
 * The slice of a level theme the field cares about. Only the accent colour is
 * read (the renderer bleeds it into the orbit ring), and it is optional.
 */
export interface PowerUpFieldTheme {
  readonly accent?: readonly number[] | undefined;
}

/** Anything the field will accept as an arena rectangle. */
export type RectInput = RectLike | readonly [number, number, number, number];

function asRect(rect: RectInput | null | undefined): RectLike {
  try {
    if (rect && typeof rect === "object" && !Array.isArray(rect)) {
      const r = rect as RectLike;
      if (typeof r.x === "number" && typeof r.w === "number") {
        return {
          x: Math.trunc(r.x),
          y: Math.trunc(r.y),
          w: Math.trunc(r.w),
          h: Math.trunc(r.h),
        };
      }
    }
    if (Array.isArray(rect)) {
      const [x, y, w, h] = rect as readonly number[];
      if (x !== undefined && y !== undefined && w !== undefined && h !== undefined) {
        return { x: Math.trunc(x), y: Math.trunc(y), w: Math.trunc(w), h: Math.trunc(h) };
      }
    }
  } catch {
    /* fall through to the arena default */
  }
  return { x: C.ARENA_X, y: C.ARENA_Y, w: C.ARENA_W, h: C.ARENA_H };
}

/** Spawns, ages and hands out the runes for one level. */
export class PowerUpField {
  /** The arena rectangle runes may spawn inside. */
  public rect: RectLike;
  /** The level theme, kept for the renderer. */
  public theme: PowerUpFieldTheme;
  /** Every rune currently on the field, oldest first. */
  public items: PowerUp[] = [];
  /** When false, `maybeSpawn` is a no-op (levels with power-ups disabled). */
  public enabled = true;
  /** Deterministic 0..1 source; seeded so tests and replays reproduce. */
  public rng: () => number;

  private clock = 0;
  private timer: number;
  private lastKind = "";

  /**
   * @param rect  arena rectangle (a RectLike or an `[x, y, w, h]` tuple)
   * @param theme level theme, read only for its accent colour
   * @param seed  RNG seed; the same seed always plays the same spawns
   */
  public constructor(rect: RectInput, theme: PowerUpFieldTheme, seed = 0x50575546) {
    this.rect = asRect(rect);
    this.theme = theme;
    this.rng = makeRng(seed);
    this.timer = this.rollInterval() * randRange(this.rng, 0.55, 1.0);
  }

  // -- setup ---------------------------------------------------------------

  /** Re-point the field at a new arena rectangle. */
  public setRect(rect: RectInput): void {
    this.rect = asRect(rect);
  }

  /** Reseed the RNG and restart the spawn timer, for deterministic replays. */
  public setSeed(seed: number): void {
    this.rng = makeRng(seed);
    this.timer = this.rollInterval() * randRange(this.rng, 0.55, 1.0);
  }

  /** Drop every rune on the field. */
  public clear(): void {
    this.items.length = 0;
  }

  /** How many runes are on the field right now. */
  public count(): number {
    return this.items.length;
  }

  /**
   * Seconds between rune spawns. Difficulty overrides this through
   * {@link setSpawnRange}; unset, it is the config pair.
   */
  private spawnLo = Math.min(C.POWERUP_SPAWN_MIN, C.POWERUP_SPAWN_MAX);
  private spawnHi = Math.max(C.POWERUP_SPAWN_MIN, C.POWERUP_SPAWN_MAX);

  /**
   * Override the spawn cadence, as the difficulty modes do.
   *
   * The pending timer is re-rolled with the new range, so the *first* rune
   * already respects it - without that, every run would open on the default
   * cadence no matter the mode, which is a difference you feel in the first
   * thirty seconds and cannot see in a diff.
   *
   * Python reaches the same end by swapping the roller on the instance
   * (`gameplay.py::_apply_powerup_cadence`); an explicit setter is the same two
   * RNG draws in the same order, which is what keeps the spawn stream matching.
   */
  public setSpawnRange(lo: number, hi: number): void {
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return;
    const a = Math.max(0.05, Math.min(lo, hi));
    const b = Math.max(a + 1e-3, Math.max(lo, hi));
    this.spawnLo = a;
    this.spawnHi = b;
    this.timer = this.rollInterval() * randRange(this.rng, 0.55, 1.0);
  }

  /** The cadence currently in force, for tests and the debug overlay. */
  public spawnRange(): [number, number] {
    return [this.spawnLo, this.spawnHi];
  }

  private rollInterval(): number {
    return randRange(this.rng, this.spawnLo, this.spawnHi);
  }

  // -- placement -----------------------------------------------------------

  /** Weighted roll that avoids repeats and anything already on screen. */
  private pickKind(): PowerUpKind {
    const onScreen = new Set(this.items.map((p) => p.kind));
    let pool = POWERUP_KINDS.filter((k) => !onScreen.has(k) && k !== this.lastKind);
    if (pool.length === 0) {
      pool = POWERUP_KINDS.filter((k) => !onScreen.has(k));
      if (pool.length === 0) pool = [...POWERUP_KINDS];
    }
    const weights = pool.map((k) => Math.max(0.01, SPAWN_WEIGHTS[k]));
    const total = weights.reduce((a, b) => a + b, 0);
    let roll = randRange(this.rng, 0, total);
    for (let i = 0; i < pool.length; i++) {
      const kind = pool[i];
      const w = weights[i];
      if (kind === undefined || w === undefined) continue;
      roll -= w;
      if (roll <= 0) return kind;
    }
    return pool[pool.length - 1] ?? "shield";
  }

  /** True when (x, y) is too close to another rune or an avoided spot. */
  private blocked(x: number, y: number, avoid?: readonly AvoidSpot[]): boolean {
    for (const p of this.items) {
      const dx = x - p.x;
      const dy = y - p.y;
      if (dx * dx + dy * dy < MIN_SEPARATION * MIN_SEPARATION) return true;
    }
    if (avoid) {
      for (const spot of avoid) {
        const ax = spot[0];
        const ay = spot[1];
        const ar = spot[2];
        if (!Number.isFinite(ax) || !Number.isFinite(ay) || !Number.isFinite(ar)) continue;
        const rr = ar + C.POWERUP_RADIUS + C.FOOD_PICKUP_PAD;
        const dx = x - ax;
        const dy = y - ay;
        if (dx * dx + dy * dy < rr * rr) return true;
      }
    }
    return false;
  }

  private pickSpot(avoid?: readonly AvoidSpot[]): [number, number] | null {
    const r = this.rect;
    const x0 = r.x + SPAWN_MARGIN;
    const x1 = r.x + r.w - SPAWN_MARGIN;
    const y0 = r.y + SPAWN_MARGIN;
    const y1 = r.y + r.h - SPAWN_MARGIN;
    if (x1 <= x0 || y1 <= y0) {
      // Arena smaller than the margin: park it in the middle.
      return [r.x + r.w / 2, r.y + r.h / 2];
    }
    let best: [number, number] | null = null;
    for (let i = 0; i < SPAWN_TRIES; i++) {
      const x = randRange(this.rng, x0, x1);
      const y = randRange(this.rng, y0, y1);
      if (best === null) best = [x, y]; // fallback if nothing is clear
      if (!this.blocked(x, y, avoid)) return [x, y];
    }
    return best;
  }

  // -- spawning ------------------------------------------------------------

  /**
   * Place one rune now.
   *
   * @param kind  force a kind, or leave undefined for the weighted roll
   * @param avoid circles the rune must not land on (food, the snake, walls)
   * @returns the new rune, or null if there was nowhere to go
   */
  public spawn(kind?: string, avoid?: readonly AvoidSpot[]): PowerUp | null {
    const spot = this.pickSpot(avoid);
    if (spot === null) return null;
    const k: string = kind !== undefined && isKind(kind) ? kind : this.pickKind();
    const pu: PowerUp = {
      x: spot[0],
      y: spot[1],
      kind: k,
      born: this.clock,
      ttl: Math.max(1.0, C.POWERUP_LIFETIME),
      radius: C.POWERUP_RADIUS,
      age: 0,
      phase: randRange(this.rng, 0, TAU),
      spin: this.rng() < 0.5 ? 1.0 : -1.0,
    };
    this.items.push(pu);
    this.lastKind = k;
    // Hard cap, in case a caller force-spawns past the limit.
    while (this.items.length > MAX_ACTIVE) this.items.shift();
    return pu;
  }

  /** Tick the spawn timer; drop a rune when it comes due and there is room. */
  public maybeSpawn(dt: number, avoid?: readonly AvoidSpot[]): PowerUp | null {
    if (!this.enabled) return null;
    const step = Number.isFinite(dt) ? Math.max(0, dt) : 0;
    this.timer -= step;
    if (this.timer > 0) return null;
    if (this.items.length >= MAX_ACTIVE) {
      // At capacity: check again shortly instead of banking a spawn.
      this.timer = randRange(this.rng, RETRY_DELAY[0], RETRY_DELAY[1]);
      return null;
    }
    this.timer = this.rollInterval();
    return this.spawn(undefined, avoid);
  }

  // -- per-frame -----------------------------------------------------------

  /**
   * Age every rune and retire the ones that timed out.
   *
   * @param dt seconds since the last frame
   * @param t  the caller's clock; when positive it is adopted verbatim so
   *           `born` stamps stay comparable with external time values,
   *           otherwise `dt` is integrated.
   */
  public update(dt = 0, t = 0): void {
    let step = Number.isFinite(dt) ? dt : 0;
    if (step < 0) step = 0;
    const tt = Number.isFinite(t) ? t : 0;
    this.clock = tt > 0 ? tt : this.clock + step;

    if (this.items.length === 0) return;
    const alive: PowerUp[] = [];
    for (const p of this.items) {
      p.age += step;
      if (p.age < p.ttl) alive.push(p);
    }
    if (alive.length !== this.items.length) this.items = alive;
  }

  /** Remove and return every rune touching the circle (x, y, r). */
  public collectAt(x: number, y: number, r: number): PowerUp[] {
    if (this.items.length === 0) return [];
    const taken: PowerUp[] = [];
    const keep: PowerUp[] = [];
    for (const p of this.items) {
      if (powerUpOverlaps(p, x, y, r)) taken.push(p);
      else keep.push(p);
    }
    if (taken.length > 0) this.items = keep;
    return taken;
  }
}

// ==========================================================================
// ActiveEffects
// ==========================================================================

/**
 * The countdown book for one run.
 *
 * Picking up a kind that is already running refreshes its timer rather than
 * stacking a second copy, so the HUD only ever shows one row per kind.
 */
export class ActiveEffects {
  private timers = new Map<string, number>();
  /** Full duration per kind, for HUD bars. */
  private totals = new Map<string, number>();

  // -- mutation ------------------------------------------------------------

  /**
   * Start or refresh `kind`.
   *
   * @returns the seconds now on its clock
   */
  public add(kind: string, duration?: number): number {
    let dur =
      duration === undefined || !Number.isFinite(duration)
        ? powerupDuration(kind)
        : duration;
    if (dur <= 0) dur = C.POWERUP_DEFAULT_DURATION;
    // `max` so a refresh never shortens an unusually long running effect.
    const left = Math.max(this.timers.get(kind) ?? 0, dur);
    this.timers.set(kind, left);
    this.totals.set(kind, Math.max(this.totals.get(kind) ?? 0, dur));
    return left;
  }

  /** Cancel `kind` outright. */
  public remove(kind: string): void {
    this.timers.delete(kind);
    this.totals.delete(kind);
  }

  /**
   * Spend a one-shot effect - this is how a shield absorbs a hit.
   *
   * @returns true if the effect was active (and has now been spent)
   */
  public consume(kind: string): boolean {
    if (this.timers.has(kind)) {
      this.remove(kind);
      return true;
    }
    return false;
  }

  /** Cancel every running effect. */
  public clear(): void {
    this.timers.clear();
    this.totals.clear();
  }

  // -- per-frame -----------------------------------------------------------

  /**
   * Tick every clock.
   *
   * @returns the kinds that ran out on this frame
   */
  public update(dt: number): string[] {
    if (this.timers.size === 0) return [];
    const step = dt;
    if (!Number.isFinite(step) || step <= 0) return [];
    const done: string[] = [];
    for (const kind of [...this.timers.keys()]) {
      const left = (this.timers.get(kind) ?? 0) - step;
      if (left <= 0) {
        this.timers.delete(kind);
        this.totals.delete(kind);
        done.push(kind);
      } else {
        this.timers.set(kind, left);
      }
    }
    return done;
  }

  // -- queries -------------------------------------------------------------

  /** Is `kind` running right now? */
  public has(kind: string): boolean {
    return (this.timers.get(kind) ?? 0) > 0;
  }

  /** Seconds left on `kind`, or 0. */
  public remaining(kind: string): number {
    return Math.max(0, this.timers.get(kind) ?? 0);
  }

  /** 0..1 of the original duration still left - handy for HUD bars. */
  public fraction(kind: string): number {
    const total = this.totals.get(kind) ?? 0;
    if (total <= 0) return 0;
    return clamp((this.timers.get(kind) ?? 0) / total, 0, 1);
  }

  /** `[kind, secondsLeft]` sorted by urgency - what the HUD renders. */
  public items(): Array<[string, number]> {
    return [...this.timers.entries()].sort((a, b) => a[1] - b[1]);
  }

  /** Every running kind, in insertion order. */
  public kinds(): string[] {
    return [...this.timers.keys()];
  }

  /** How many effects are running (Python's `__len__`). */
  public get size(): number {
    return this.timers.size;
  }

  // -- derived gameplay modifiers ------------------------------------------

  /** Points multiplier: 2 while `double` runs, else 1. */
  public scoreMultiplier(): number {
    return this.has("double") ? DOUBLE_SCORE_MULT : 1;
  }

  /** Combined speed scale from `slow` and `frenzy` (they can overlap). */
  public speedMultiplier(): number {
    let m = 1.0;
    if (this.has("slow")) m *= SLOW_SPEED_MULT;
    if (this.has("frenzy")) m *= FRENZY_SPEED_MULT;
    return m;
  }

  /** Turn-rate scale: tighter steering while `slow` runs. */
  public turnMultiplier(): number {
    return this.has("slow") ? SLOW_TURN_MULT : 1.0;
  }

  /** Pull range around the head, 0 when `magnet` is not running. */
  public magnetRadius(): number {
    return this.has("magnet") ? MAGNET_RADIUS : 0.0;
  }

  /** Extra orbs the food field should stock while `frenzy` runs. */
  public extraFood(): number {
    return this.has("frenzy") ? FRENZY_EXTRA_FOOD : 0;
  }
}
