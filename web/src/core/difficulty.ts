/**
 * Difficulty tuning table for NEON SERPENT - a port of `snake/core/difficulty.py`.
 *
 * Four modes - EASY, NORMAL, HARD, EXPERT - each an immutable {@link Difficulty}
 * record of multipliers that the rest of the game reads instead of hard-coding
 * its own balance. NORMAL is the identity row: every one of its multipliers is
 * `1.0` and its `lives` is {@link C.START_LIVES}, so a game that runs on NORMAL
 * plays exactly as it did before this module existed. That is a deliberate
 * invariant - {@link checkDifficultyTable} verifies it at load in a way that can
 * never throw.
 *
 * The module is pure data plus small pure functions. It imports nothing but
 * `config` and the exported JSON - never a rendering module, never another core
 * entity - so it is safe to import from any layer.
 *
 * Reading the table: every `*Mult` field is a *scale on the existing constant*,
 * never a replacement for it, so `config` and the level table stay the single
 * source of truth for absolute numbers.
 *
 * Self-collision: `selfMode` is the headline knob.
 * - `"off"` - the head can never kill itself. {@link selfCollisionEnabled}
 *   returns `false` and {@link selfCollisionSkip} returns {@link SKIP_NEVER}, a
 *   sentinel far larger than any reachable body length.
 * - `"forgiving"` - the shipped NORMAL balance: a wide skip window plus the full
 *   {@link C.SELF_COLLISION_DEPTH} cross-over allowance, so a hairpin passes
 *   over your own neck instead of ending the run.
 * - `"normal"` - a shorter skip window and a stricter overlap depth.
 * - `"strict"` - the shortest window and the strictest depth.
 */

import * as C from "./config";
import rawDifficulty from "../data/difficulty.json";

// ==========================================================================
// Shapes
// ==========================================================================

/** The legal values of {@link Difficulty.selfMode}, easiest first. */
export type SelfMode = "off" | "forgiving" | "normal" | "strict";

/** RGB accent colour, 0..255 per channel. */
export type Rgb = readonly [number, number, number];

/** Anything a public helper will accept in place of a key. */
export type DiffLike = string | Difficulty | null | undefined;

/**
 * One immutable row of the balance table.
 *
 * Instances are shared and never mutated; treat them as constants. Fields are
 * grouped in the order the gameplay scene consumes them.
 */
export interface Difficulty {
  // -- identity ------------------------------------------------------------
  /** Stable id, one of the `C.DIFF_*` constants. Saved to disk. */
  readonly key: string;
  /** Display name for menus, e.g. `"Expert"`. */
  readonly name: string;
  /** One short sentence of flavour, shown under the name on the picker. */
  readonly blurb: string;
  /** RGB accent used for this mode's chip, bar and HUD tag. */
  readonly color: Rgb;
  /** Very short all-caps tag for the in-game HUD, e.g. `"EXPERT"`. */
  readonly hudLabel: string;
  /** Position in {@link ORDER}, 0 (easiest) to 3 (hardest). */
  readonly rank: number;

  // -- survival ------------------------------------------------------------
  /** Lives the run starts with; replaces {@link C.START_LIVES}. */
  readonly lives: number;
  /** Scale on {@link C.INVULN_AFTER_HIT} mercy invulnerability. */
  readonly invulnMult: number;

  // -- movement ------------------------------------------------------------
  /** Extra scale on the snake's speed, composed with `level.speedMult`. */
  readonly speedMult: number;
  /** Extra scale on the steering rate, composed with power-up turn bonuses. */
  readonly turnMult: number;

  // -- self-collision ------------------------------------------------------
  /** One of {@link SELF_MODES}; see the module docs. */
  readonly selfMode: SelfMode;
  /** Scale on {@link C.SELF_COLLISION_SKIP} (ignored when off). */
  readonly selfSkipMult: number;
  /** Scale on {@link C.SELF_COLLISION_DEPTH} (ignored when off). */
  readonly selfDepthMult: number;

  // -- hazards / pickups ---------------------------------------------------
  /** Scale on how fast moving obstacles patrol, spin and sweep. */
  readonly hazardSpeedMult: number;
  /**
   * How *often* power-ups appear. Greater than 1 is more often, so spawn
   * intervals are divided by it - see {@link powerupSpawnRange}.
   */
  readonly powerupRateMult: number;

  // -- scoring -------------------------------------------------------------
  /** Scale on each orb's own point value, before {@link Difficulty.scoreMult}. */
  readonly foodValueMult: number;
  /** Scale on everything banked - the risk premium for the harder modes. */
  readonly scoreMult: number;
  /** Scale on {@link C.COMBO_WINDOW}, the chaining grace period. */
  readonly comboWindowMult: number;
  /** Scale on a level's one/two/three-star score thresholds. */
  readonly starTargetMult: number;
}

/** A skip count no snake can ever reach, meaning "self-collision is disabled". */
export const SKIP_NEVER: number = 1 << 30;

/**
 * Python's `round()`: round half to *even*, not half away from zero.
 *
 * `Math.round(2.5)` is 3 but Python's `round(2.5)` is 2, and this module
 * mirrors three `int(round(...))` call sites from `difficulty.py`
 * ({@link selfCollisionSkip}, {@link scoreForFood}, {@link applyStarTargets}).
 * A combo multiplier lands on an exact `.5` often enough that using the wrong
 * rule silently pays the player a point more than the desktop game does - the
 * kind of divergence that never crashes and never gets noticed.
 *
 * Only exact halves are treated specially; everything else rounds normally, so
 * a value like 2.675 (which is really 2.67499...) rounds down in both
 * languages for the same floating-point reason.
 */
function roundHalfEven(v: number): number {
  if (!Number.isFinite(v)) return v;
  const floor = Math.floor(v);
  const frac = v - floor;
  if (frac > 0.5) return floor + 1;
  if (frac < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** The legal `selfMode` values, easiest first. */
export const SELF_MODES: readonly SelfMode[] = ["off", "forgiving", "normal", "strict"];

// ==========================================================================
// Loading the exported table
// ==========================================================================

interface RawMode {
  readonly key?: unknown;
  readonly name?: unknown;
  readonly blurb?: unknown;
  readonly color?: unknown;
  readonly hud_label?: unknown;
  readonly rank?: unknown;
  readonly lives?: unknown;
  readonly invuln_mult?: unknown;
  readonly speed_mult?: unknown;
  readonly turn_mult?: unknown;
  readonly self_mode?: unknown;
  readonly self_skip_mult?: unknown;
  readonly self_depth_mult?: unknown;
  readonly hazard_speed_mult?: unknown;
  readonly powerup_rate_mult?: unknown;
  readonly food_value_mult?: unknown;
  readonly score_mult?: unknown;
  readonly combo_window_mult?: unknown;
  readonly star_target_mult?: unknown;
}

interface RawDerived {
  readonly lives?: unknown;
  readonly selfCollisionEnabled?: unknown;
  readonly selfCollisionSkip?: unknown;
  readonly selfCollisionDepth?: unknown;
  readonly invulnSeconds?: unknown;
  readonly comboWindow?: unknown;
  readonly powerupSpawnRange?: unknown;
}

const RAW = rawDifficulty as unknown as {
  modes?: readonly RawMode[];
  derived?: Record<string, RawDerived | undefined>;
};

/** Coerce anything to a finite number, falling back when it is not one. */
function numOf(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Coerce anything to a string, falling back when it is not one. */
function strOf(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}

/** Coerce anything to one of {@link SELF_MODES}, falling back to `"forgiving"`. */
function selfModeOf(v: unknown): SelfMode {
  return SELF_MODES.includes(v as SelfMode) ? (v as SelfMode) : "forgiving";
}

/** Coerce anything to an RGB triple with channels clamped to 0..255. */
function colorOf(v: unknown): Rgb {
  const arr = Array.isArray(v) ? (v as unknown[]) : [];
  const chan = (i: number): number => {
    const n = Math.round(numOf(arr[i], 255));
    return n < 0 ? 0 : n > 255 ? 255 : n;
  };
  return [chan(0), chan(1), chan(2)] as const;
}

function parseMode(raw: RawMode, index: number): Difficulty {
  return {
    key: strOf(raw.key, C.DEFAULT_DIFFICULTY),
    name: strOf(raw.name, "Normal"),
    blurb: strOf(raw.blurb, ""),
    color: colorOf(raw.color),
    hudLabel: strOf(raw.hud_label, strOf(raw.name, "NORMAL").toUpperCase()),
    rank: Math.round(numOf(raw.rank, index)),
    lives: Math.round(numOf(raw.lives, C.START_LIVES)),
    invulnMult: numOf(raw.invuln_mult, 1),
    speedMult: numOf(raw.speed_mult, 1),
    turnMult: numOf(raw.turn_mult, 1),
    selfMode: selfModeOf(raw.self_mode),
    selfSkipMult: numOf(raw.self_skip_mult, 1),
    selfDepthMult: numOf(raw.self_depth_mult, 1),
    hazardSpeedMult: numOf(raw.hazard_speed_mult, 1),
    powerupRateMult: numOf(raw.powerup_rate_mult, 1),
    foodValueMult: numOf(raw.food_value_mult, 1),
    scoreMult: numOf(raw.score_mult, 1),
    comboWindowMult: numOf(raw.combo_window_mult, 1),
    starTargetMult: numOf(raw.star_target_mult, 1),
  };
}

const PARSED: readonly Difficulty[] = (RAW.modes ?? []).map(parseMode);

/** Every mode, keyed by its `C.DIFF_*` key. */
export const DIFFICULTIES: Readonly<Record<string, Difficulty>> = (() => {
  const out: Record<string, Difficulty> = {};
  for (const d of PARSED) out[d.key] = d;
  return out;
})();

/** Keys in easy -> expert order; the order menus should present them in. */
export const ORDER: readonly string[] = PARSED.map((d) => d.key);

/** The fallback row. Anything unknown resolves to this. */
export const DEFAULT: Difficulty =
  DIFFICULTIES[C.DEFAULT_DIFFICULTY] ??
  PARSED[0] ??
  parseMode({ key: C.DEFAULT_DIFFICULTY, name: "Normal" }, 0);

// ==========================================================================
// Lookup / cycling
// ==========================================================================

/**
 * Resolve `key` to a {@link Difficulty}.
 *
 * Accepts a key string (case- and whitespace-insensitive), a {@link Difficulty}
 * (returned unchanged, so the helpers below take either), or `null`/`undefined`.
 * Anything unrecognised - a typo, a stale key from an older save, a number, an
 * object - falls back to {@link DEFAULT}. This function never throws.
 */
export function getDifficulty(key: DiffLike = null): Difficulty {
  if (key !== null && typeof key === "object") {
    // A Difficulty record round-trips unchanged, like the Python isinstance arm.
    const maybe = key as Difficulty;
    if (typeof maybe.key === "string" && typeof maybe.selfMode === "string") return maybe;
    return DEFAULT;
  }
  if (key === null || key === undefined) return DEFAULT;
  let k: string;
  try {
    k = String(key).trim().toLowerCase();
  } catch {
    return DEFAULT;
  }
  return DIFFICULTIES[k] ?? DEFAULT;
}

/** True when `key` names a real mode (used to validate save files). */
export function isDifficultyKey(key: unknown): boolean {
  if (key === null || key === undefined) return false;
  try {
    return Object.prototype.hasOwnProperty.call(
      DIFFICULTIES,
      String(key).trim().toLowerCase(),
    );
  } catch {
    return false;
  }
}

/** Position of `key` within {@link ORDER}, 0..3; unknown keys give the default's. */
export function indexOf(key: DiffLike = null): number {
  const diff = getDifficulty(key);
  const i = ORDER.indexOf(diff.key);
  return i >= 0 ? i : 0;
}

/** Shared body of {@link nextDifficulty} / {@link prevDifficulty}. */
function step(key: DiffLike, delta: number): string {
  const n = ORDER.length;
  if (n === 0) return C.DEFAULT_DIFFICULTY;
  const i = (((indexOf(key) + delta) % n) + n) % n;
  return ORDER[i] ?? C.DEFAULT_DIFFICULTY;
}

/** The next key one step harder, wrapping expert -> easy. */
export function nextDifficulty(key: DiffLike = null): string {
  return step(key, 1);
}

/** The previous key one step easier, wrapping easy -> expert. */
export function prevDifficulty(key: DiffLike = null): string {
  return step(key, -1);
}

/** Every mode as a fresh array, easy -> expert (safe for the caller to sort). */
export function allDifficulties(): Difficulty[] {
  const out: Difficulty[] = [];
  for (const k of ORDER) {
    const d = DIFFICULTIES[k];
    if (d) out.push(d);
  }
  return out;
}

/** Upper-case display names in {@link ORDER}, for a row of buttons. */
export function labels(): string[] {
  return allDifficulties().map((d) => d.name.toUpperCase());
}

/** Upper-case name of one mode, handy for buttons that shout. */
export function label(diff: DiffLike = null): string {
  return getDifficulty(diff).name.toUpperCase();
}

/** True for the reference balance (NORMAL). */
export function isDefault(diff: DiffLike = null): boolean {
  return getDifficulty(diff).key === C.DEFAULT_DIFFICULTY;
}

// ==========================================================================
// Self-collision
// ==========================================================================

/** False only on EASY, where the snake simply cannot kill itself. */
export function selfCollisionEnabled(diff: DiffLike = null): boolean {
  return getDifficulty(diff).selfMode !== "off";
}

/**
 * Segments behind the head that are exempt from self-collision.
 *
 * {@link C.SELF_COLLISION_SKIP} scaled by `selfSkipMult`, floored at 1 so there
 * is always at least the neck to turn through. When the mode is `"off"` this
 * returns {@link SKIP_NEVER} instead - larger than any body the game can grow,
 * so a plain `for (let i = skip; i < segments.length; i++)` loop never runs.
 */
export function selfCollisionSkip(diff: DiffLike = null): number {
  const d = getDifficulty(diff);
  if (d.selfMode === "off") return SKIP_NEVER;
  const value = roundHalfEven(C.SELF_COLLISION_SKIP * d.selfSkipMult);
  if (!Number.isFinite(value)) return roundHalfEven(C.SELF_COLLISION_SKIP);
  return value >= 1 ? value : 1;
}

/**
 * Overlap allowance before a self-touch counts as a hit.
 *
 * {@link C.SELF_COLLISION_DEPTH} scaled by the mode's `selfDepthMult` and
 * clamped to the 0.05 .. 1.0 band `Snake.hitsSelf` accepts. Lower is stricter
 * (0.0 would make a graze lethal), higher is more forgiving.
 */
export function selfCollisionDepth(diff: DiffLike = null): number {
  const d = getDifficulty(diff);
  const value = C.SELF_COLLISION_DEPTH * d.selfDepthMult;
  if (!Number.isFinite(value)) return C.SELF_COLLISION_DEPTH;
  return value < 0.05 ? 0.05 : value > 1.0 ? 1.0 : value;
}

// ==========================================================================
// Scoring / pacing helpers
// ==========================================================================

/** Lives a run on this mode starts with, never below 1. */
export function livesFor(diff: DiffLike = null): number {
  const d = getDifficulty(diff);
  const n = Math.trunc(d.lives);
  if (!Number.isFinite(n)) return Math.round(C.START_LIVES);
  return n >= 1 ? n : 1;
}

/** Mercy invulnerability after a non-fatal hit, in seconds. */
export function invulnSeconds(diff: DiffLike = null): number {
  const d = getDifficulty(diff);
  const v = C.INVULN_AFTER_HIT * d.invulnMult;
  if (!Number.isFinite(v)) return C.INVULN_AFTER_HIT;
  return v > 0 ? v : 0;
}

/** Seconds allowed between pickups to keep a combo alive. */
export function comboWindow(diff: DiffLike = null): number {
  const d = getDifficulty(diff);
  const v = C.COMBO_WINDOW * d.comboWindowMult;
  if (!Number.isFinite(v)) return C.COMBO_WINDOW;
  return v > 0.1 ? v : 0.1;
}

/**
 * `[minSeconds, maxSeconds]` between power-up spawns for this mode.
 *
 * `powerupRateMult` is a *rate*, so the config intervals are divided by it:
 * EASY (1.45x) waits about a third less, EXPERT (0.5x) waits twice as long.
 * The pair is always ordered and strictly positive.
 */
export function powerupSpawnRange(diff: DiffLike = null): [number, number] {
  const d = getDifficulty(diff);
  let rate = Number.isFinite(d.powerupRateMult) ? d.powerupRateMult : 1.0;
  if (rate <= 0.01) rate = 0.01;
  let lo = C.POWERUP_SPAWN_MIN / rate;
  let hi = C.POWERUP_SPAWN_MAX / rate;
  if (hi < lo) {
    const t = lo;
    lo = hi;
    hi = t;
  }
  return [Math.max(0.5, lo), Math.max(0.5 + 1e-3, hi)];
}

/**
 * Points banked for one orb worth `baseValue` on this mode.
 *
 * `multiplier` is whatever the scene already computed - the combo step and the
 * `double` power-up - so the whole chain lands in one place. Always returns at
 * least 1 for a positive orb, so no pickup ever feels free; nonsense input
 * (NaN, infinities, non-positive totals) yields 0 rather than throwing.
 */
export function scoreForFood(diff: DiffLike, baseValue: number, multiplier = 1.0): number {
  const d = getDifficulty(diff);
  const raw = Number(baseValue) * d.foodValueMult * d.scoreMult * Number(multiplier);
  if (!Number.isFinite(raw)) return 0;
  if (raw <= 0) return 0;
  const points = roundHalfEven(raw);
  return points >= 1 ? points : 1;
}

/**
 * Rescale a level's star-target triple for this mode.
 *
 * Takes whatever `LevelDef.starTargets()` returned and multiplies each
 * threshold by `starTargetMult`, then forces the result to be three positive,
 * strictly increasing integers so a two-star bar can never sit at or below the
 * one-star bar after rounding. Garbage in - a short array, `null`, non-numbers -
 * yields a sane ladder rather than an exception.
 */
export function applyStarTargets(
  diff: DiffLike,
  targets?: Iterable<number> | null,
): [number, number, number] {
  const d = getDifficulty(diff);
  let mult = Number.isFinite(d.starTargetMult) ? d.starTargetMult : 1.0;
  if (mult <= 0) mult = 1.0;

  const values: number[] = [];
  if (targets !== null && targets !== undefined) {
    try {
      for (const v of targets) {
        const fv = typeof v === "number" ? v : Number(v);
        if (!Number.isFinite(fv)) continue;
        values.push(fv);
        if (values.length === 3) break;
      }
    } catch {
      values.length = 0;
    }
  }

  // Pad a short or empty triple by extrapolating the shipped 1 / 1.35 / 1.75
  // ladder from whatever we did get.
  if (values.length === 0) {
    const base = C.SCORE_PER_FOOD * 8;
    values.push(base, base * 1.35, base * 1.75);
  }
  while (values.length < 3) {
    values.push((values[values.length - 1] ?? 1) * 1.35);
  }

  const out: number[] = [];
  for (let i = 0; i < 3; i++) {
    const scaled = roundHalfEven((values[i] ?? 1) * mult);
    const floor = i === 0 ? 1 : (out[i - 1] ?? 0) + 1;
    out.push(scaled > floor ? scaled : floor);
  }
  return [out[0] ?? 1, out[1] ?? 2, out[2] ?? 3];
}

// ==========================================================================
// Load-time sanity (reports, never throws)
// ==========================================================================

function nearly(a: number, b: number, tol = 1e-6): boolean {
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol;
}

/**
 * Verify the table's invariants *and* that the helpers above still reproduce
 * the `derived` block Python exported, returning a list of complaints.
 *
 * Empty means the port agrees with the shipped balance. Kept as a function so
 * tests can call it, and called once at load so a bad edit shows up immediately
 * as a warning instead of a subtle balance drift. It catches everything: a
 * broken table must not stop the game from starting.
 */
export function checkDifficultyTable(): string[] {
  const problems: string[] = [];
  try {
    if (ORDER.length !== 4) problems.push(`ORDER has ${ORDER.length} modes, expected 4`);
    if (Object.keys(DIFFICULTIES).length !== ORDER.length) {
      problems.push("DIFFICULTIES keys do not match ORDER");
    }
    for (let i = 0; i < ORDER.length; i++) {
      const k = ORDER[i] ?? "";
      const d = DIFFICULTIES[k];
      if (!d) {
        problems.push(`${k}: missing from DIFFICULTIES`);
        continue;
      }
      if (d.key !== k) problems.push(`${k}: key mismatch (${d.key})`);
      if (d.rank !== i) problems.push(`${k}: rank ${d.rank} should be ${i}`);
      if (!SELF_MODES.includes(d.selfMode)) {
        problems.push(`${k}: bad selfMode ${String(d.selfMode)}`);
      }
      if (d.color.length !== 3 || !d.color.every((c) => c >= 0 && c <= 255)) {
        problems.push(`${k}: bad colour ${JSON.stringify(d.color)}`);
      }
    }

    // NORMAL is the identity row.
    const n = DIFFICULTIES[C.DIFF_NORMAL];
    if (!n) {
      problems.push("normal is missing from the table");
    } else {
      const identity: ReadonlyArray<[string, number]> = [
        ["invulnMult", n.invulnMult],
        ["speedMult", n.speedMult],
        ["turnMult", n.turnMult],
        ["selfSkipMult", n.selfSkipMult],
        ["selfDepthMult", n.selfDepthMult],
        ["hazardSpeedMult", n.hazardSpeedMult],
        ["powerupRateMult", n.powerupRateMult],
        ["foodValueMult", n.foodValueMult],
        ["scoreMult", n.scoreMult],
        ["comboWindowMult", n.comboWindowMult],
        ["starTargetMult", n.starTargetMult],
      ];
      for (const [fname, value] of identity) {
        if (!nearly(value, 1.0, 1e-9)) problems.push(`normal.${fname} is not 1.0`);
      }
      if (n.lives !== Math.round(C.START_LIVES)) {
        problems.push("normal.lives is not C.START_LIVES");
      }
    }

    // Difficulty must actually be monotonic where it claims to be.
    for (let i = 0; i + 1 < ORDER.length; i++) {
      const da = DIFFICULTIES[ORDER[i] ?? ""];
      const db = DIFFICULTIES[ORDER[i + 1] ?? ""];
      if (!da || !db) continue;
      if (db.lives > da.lives) problems.push(`${db.key} has more lives than ${da.key}`);
      if (db.speedMult < da.speedMult) problems.push(`${db.key} is slower than ${da.key}`);
      if (db.scoreMult < da.scoreMult) problems.push(`${db.key} scores less than ${da.key}`);
    }

    // The exported `derived` block is the acceptance spec for the helpers.
    const derived = RAW.derived ?? {};
    for (const k of ORDER) {
      const exp = derived[k];
      if (!exp) {
        problems.push(`${k}: no derived block to check against`);
        continue;
      }
      const check = (field: string, got: number, want: unknown): void => {
        if (typeof want !== "number") return;
        if (!nearly(got, want)) {
          problems.push(`${k}.${field}: port gives ${got}, export says ${want}`);
        }
      };
      check("lives", livesFor(k), exp.lives);
      if (typeof exp.selfCollisionEnabled === "boolean"
          && selfCollisionEnabled(k) !== exp.selfCollisionEnabled) {
        problems.push(
          `${k}.selfCollisionEnabled: port gives ${selfCollisionEnabled(k)}, `
          + `export says ${exp.selfCollisionEnabled}`,
        );
      }
      check("selfCollisionSkip", selfCollisionSkip(k), exp.selfCollisionSkip);
      check("selfCollisionDepth", selfCollisionDepth(k), exp.selfCollisionDepth);
      check("invulnSeconds", invulnSeconds(k), exp.invulnSeconds);
      check("comboWindow", comboWindow(k), exp.comboWindow);
      const range = exp.powerupSpawnRange;
      if (Array.isArray(range)) {
        const got = powerupSpawnRange(k);
        check("powerupSpawnRange[0]", got[0], range[0]);
        check("powerupSpawnRange[1]", got[1], range[1]);
      }
    }
  } catch (exc) {
    problems.push(`difficulty self-check crashed: ${String(exc)}`);
  }
  return problems;
}

/** Problems found at load time; empty on a healthy table. */
export const TABLE_PROBLEMS: readonly string[] = checkDifficultyTable();

if (TABLE_PROBLEMS.length > 0) {
  console.warn("[difficulty] table invariants violated: " + TABLE_PROBLEMS.join("; "));
}
