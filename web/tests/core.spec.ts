/**
 * NEON SERPENT - acceptance spec for the TypeScript port of the simulation.
 *
 * This is the web build's counterpart to `tools/turn_test.py` (the 112-check
 * numerical verification) with the parts of `tools/smoke_modules.py` and
 * `tools/playtest.py` that pin down behaviour rather than presentation. Nothing
 * here is a smoke test: every number in a test name was *measured* on the Python
 * game first, and the port has to reproduce it.
 *
 * Where a figure is quoted, the comment says which Python run it came from:
 *
 *   [turn_test S1]  section 1, the U-turn corridor measurements
 *   [turn_test S2]  section 2, hairpin survival and the lethal band probe
 *   [turn_test S3]  section 3, the difficulty table
 *   [turn_test S4]  section 4, save round-trip and schema-1 migration
 *   [turn_test S5]  section 5, story beats and chapters
 *   [smoke]         tools/smoke_modules.py, the entity-level invariants
 *   [export]        data/*.json, i.e. the authored content itself
 *
 * Section 6 of `turn_test.py` (the pygame letterbox display layer) has no
 * counterpart here: the web build maps design space to screen in
 * `src/app/Viewport.ts`, which is not part of the simulation this file guards.
 *
 * The whole file is headless - no pixi, no DOM, no rendering - so it runs under
 * `vitest run` with the default node environment.
 */

import { afterEach, describe, expect, it } from "vitest";

import * as C from "../src/core/config";
import * as D from "../src/core/difficulty";
import * as S from "../src/core/story";
import { clamp } from "../src/core/mathx";
import { Snake, type HitsSelfOptions, type Vec2 } from "../src/core/snake";
import { LEVELS, LEVEL_COUNT, getLevel } from "../src/core/level";
import {
  Obstacle,
  Portal,
  buildObstacles,
  obstacleAvoidList,
  updateObstacles,
} from "../src/core/obstacles";
import {
  DEFAULT_SAVE_KEY,
  SCHEMA_VERSION,
  SaveData,
  type StorageLike,
} from "../src/core/save";
import { FoodField, type AvoidCircle, type Food } from "../src/core/food";
import {
  ActiveEffects,
  POWERUP_KINDS,
  POWERUP_TYPES,
  PowerUpField,
} from "../src/core/powerups";

// ==========================================================================
// Shared rig
// ==========================================================================

/** The fixed simulation step the whole game runs at (60 fps). */
const DT: number = 1.0 / C.FPS;

/**
 * The manoeuvre has to fit inside this many pixels of arena at every speed and
 * on every difficulty. [turn_test S1] `WIDTH_BUDGET`; the pre-v2 model swept
 * ~194 px on level 12.
 */
const WIDTH_BUDGET = 80.0;

/** The arena every field and hazard is measured against. */
const ARENA = { x: C.ARENA_X, y: C.ARENA_Y, w: C.ARENA_W, h: C.ARENA_H } as const;

/** Result of one measured reversal. */
interface UTurn {
  /** Lateral corridor the reversal swept, in pixels. */
  width: number;
  /** The width's implied turn radius. */
  radius: number;
  /** Frames the reversal took. */
  frames: number;
}

/** Per-frame modifiers `measureUTurn` drives the snake with. */
interface DriveOpts {
  speedMult?: number;
  turnMult?: number;
  boost?: boolean;
}

/**
 * Drive a full 180 degree reversal and measure the corridor it sweeps.
 *
 * A direct port of `turn_test.measure_uturn`. The snake is settled onto a
 * straight heading, then handed a target far back down its own line - nudged one
 * pixel to the side, because a target exactly astern is a perfect `pi`
 * ambiguity. From the instant the reversal is commanded until the heading has
 * accumulated `pi` radians of rotation, the head's offset *perpendicular to the
 * original heading* is tracked; the width of that band is the U-turn width.
 */
function measureUTurn(cruise: number, opts: DriveOpts = {}): UTurn {
  const snake = new Snake(300.0, 400.0, 0.0, 30);
  snake.speed = cruise;

  snake.setTarget(6000.0, 400.0);
  for (let i = 0; i < 40; i++) snake.update(DT, opts);

  const x0 = snake.x;
  const y0 = snake.y;
  const h0 = snake.heading;
  snake.setTarget(snake.x - 8000.0, snake.y + 1.0);

  let lo = 0.0;
  let hi = 0.0;
  let turned = 0.0;
  let previous = snake.heading;
  let frames = 0;
  while (turned < Math.PI && frames < 4000) {
    snake.update(DT, opts);
    // Shortest signed rotation since the last frame, in -pi..pi.
    const raw = snake.heading - previous + Math.PI;
    const delta = raw - Math.PI * 2.0 * Math.floor(raw / (Math.PI * 2.0)) - Math.PI;
    turned += Math.abs(delta);
    previous = snake.heading;
    const lateral =
      -Math.sin(h0) * (snake.x - x0) + Math.cos(h0) * (snake.y - y0);
    if (lateral < lo) lo = lateral;
    if (lateral > hi) hi = lateral;
    frames += 1;
  }

  const width = hi - lo;
  return { width, radius: width * 0.5, frames };
}

/**
 * The steering rate the port must derive, straight from the model in the brief:
 * `omega = clamp(speed / SNAKE_MIN_TURN_RADIUS, SNAKE_TURN_RATE,
 * SNAKE_TURN_RATE_CAP) * turnMult`.
 */
function turnRateFor(speed: number, turnMult = 1.0): number {
  return (
    clamp(speed / C.SNAKE_MIN_TURN_RADIUS, C.SNAKE_TURN_RATE, C.SNAKE_TURN_RATE_CAP)
    * turnMult
  );
}

/** The corridor a perfect reversal at `speed` would sweep: `2 * speed / omega`. */
function idealUTurnWidth(speed: number, turnMult = 1.0): number {
  return (2.0 * speed) / turnRateFor(speed, turnMult);
}

/**
 * The pre-v2 steering model, reconstructed for the before/after comparison.
 *
 * [turn_test S1] `_legacy_turn_rate`: the old `Snake._turn_rate` interpolated a
 * fixed *angular* rate between `SNAKE_TURN_RATE_SLOW` (crawling) and
 * `SNAKE_TURN_RATE` (flat out) on `speed / SNAKE_MAX_SPEED`. At level 12's
 * 525 px/s it yields 5.4 rad/s, a 97.2 px turn radius and therefore a 194.5 px
 * U-turn - the number the original bug report quoted.
 */
function legacyUTurnWidth(speed: number): number {
  const t = clamp(speed / C.SNAKE_MAX_SPEED, 0.0, 1.0);
  const omega =
    C.SNAKE_TURN_RATE_SLOW + (C.SNAKE_TURN_RATE - C.SNAKE_TURN_RATE_SLOW) * t;
  return (2.0 * speed) / omega;
}

/** The exact keyword set the gameplay scene passes to `hitsSelf`. */
function collideOpts(key: string | null): HitsSelfOptions {
  return {
    skip: D.selfCollisionSkip(key),
    depth: D.selfCollisionDepth(key),
    enabled: D.selfCollisionEnabled(key),
  };
}

/** Outcome of one driven hairpin. */
interface HairpinResult {
  lethal: number;
  crossing: number;
  alive: boolean;
}

/**
 * Straight run, then a full reversal, then keep going.
 *
 * Port of `turn_test.drive_hairpin`.
 */
function driveHairpin(
  key: string | null,
  o: { cruise?: number; speedMult?: number; length?: number } = {},
): HairpinResult {
  const cruise = o.cruise ?? 210.0;
  const speedMult = o.speedMult ?? 1.0;
  const length = o.length ?? 40;

  const snake = new Snake(300.0, 420.0, 0.0, length);
  snake.speed = cruise;
  snake.setTarget(6000.0, 420.0);
  for (let i = 0; i < 140; i++) snake.update(DT, { speedMult });

  snake.setTarget(snake.x - 8000.0, snake.y + 1.0);
  const kw = collideOpts(key);

  let lethal = 0;
  let crossing = 0;
  for (let i = 0; i < 300; i++) {
    snake.update(DT, { speedMult });
    if (snake.hitsSelf(kw)) lethal += 1;
    if (snake.crossingSelf()) crossing += 1;
  }
  return { lethal, crossing, alive: snake.alive };
}

/**
 * Lay a long straight body, then steer the head back into the middle of it.
 *
 * Port of `turn_test.drive_into_own_body`. The head runs 700 px along y = 560,
 * then is handed a *fixed world point* 450 px back down that line - a point its
 * own body is sitting on, about 35 segments behind the head: well past any skip
 * window, and squarely in the middle of the rope rather than a graze.
 */
function driveIntoOwnBody(
  key: string | null,
  o: { cruise?: number; length?: number } = {},
): { lethal: number; first: number | null } {
  const cruise = o.cruise ?? 210.0;
  const length = o.length ?? 90;

  const snake = new Snake(200.0, 560.0, 0.0, length);
  snake.speed = cruise;
  snake.setTarget(6000.0, 560.0);
  for (let i = 0; i < 200; i++) snake.update(DT);

  const kw = collideOpts(key);
  let lethal = 0;
  let first: number | null = null;
  for (let frame = 0; frame < 400; frame++) {
    snake.setTarget(450.0, 560.0);
    snake.update(DT);
    if (snake.hitsSelf(kw)) {
      lethal += 1;
      if (first === null) first = frame;
    }
  }
  return { lethal, first };
}

/**
 * The largest lateral miss distance that still counts as a self-hit.
 *
 * Port of `turn_test.probe_lethal_radius`. Lays a straight body, then walks the
 * head sideways away from a segment far behind it, one tenth of a pixel at a
 * time, and reports where the verdict flips. This is the geometric meaning of
 * `SELF_COLLISION_DEPTH` per difficulty; `null` means the head never registers
 * at all (easy).
 */
function probeLethalRadius(key: string | null): number | null {
  const snake = new Snake(200.0, 300.0, 0.0, 60);
  snake.speed = 210.0;
  snake.setTarget(6000.0, 300.0);
  for (let i = 0; i < 200; i++) snake.update(DT);

  const targetIndex = 30;
  const seg: Vec2 | undefined = snake.segments[targetIndex];
  if (seg === undefined) return null;
  const sx = seg.x;
  const sy = seg.y;
  const kw = collideOpts(key);

  let found: number | null = null;
  for (let step = 0; step < 400; step++) {
    const offset = step * 0.1;
    snake.x = sx;
    snake.y = sy + offset;
    // dt == 0 advances the collision cache tick without moving anything.
    snake.update(0.0);
    if (snake.hitsSelf(kw)) {
      found = offset;
    } else if (found !== null) {
      break;
    }
  }
  return found;
}

/**
 * Steer the head at a point just behind itself and count the lethal frames.
 *
 * Port of `turn_test.coil_self_hits`. This is the worst thing a player can do on
 * purpose: it winds the snake into a spiral at its minimum turn radius until the
 * head meets a part of the body past the skip window.
 */
function coilSelfHits(key: string | null, frames = 600): number {
  return coilSelfHitsWith(collideOpts(key), frames);
}

/** {@link coilSelfHits} with the collision rule spelled out rather than looked up. */
function coilSelfHitsWith(kw: HitsSelfOptions, frames = 600): number {
  const snake = new Snake(640.0, 400.0, 0.0, 60);
  snake.speed = 210.0;
  let lethal = 0;
  for (let i = 0; i < frames; i++) {
    const back = snake.heading + Math.PI * 0.82;
    snake.setTarget(
      snake.x + Math.cos(back) * 60.0,
      snake.y + Math.sin(back) * 60.0,
    );
    snake.update(DT);
    if (snake.hitsSelf(kw)) lethal += 1;
  }
  return lethal;
}

/** Euclidean gaps between consecutive body segments. */
function segmentGaps(snake: Snake): number[] {
  const gaps: number[] = [];
  for (let i = 0; i + 1 < snake.segments.length; i++) {
    const a = snake.segments[i];
    const b = snake.segments[i + 1];
    if (a === undefined || b === undefined) continue;
    gaps.push(Math.hypot(b.x - a.x, b.y - a.y));
  }
  return gaps;
}

/** Worst absolute deviation from `C.SNAKE_SEGMENT_SPACING`, in pixels. */
function worstSpacingDeviation(snake: Snake): number {
  let worst = 0.0;
  for (const g of segmentGaps(snake)) {
    const dev = Math.abs(g - C.SNAKE_SEGMENT_SPACING);
    if (dev > worst) worst = dev;
  }
  return worst;
}

/**
 * The shortest straight-line gap two consecutive segments may legally show.
 *
 * Segments sit at exact *arc length* multiples along the recorded path, so on a
 * curve the straight-line gap is the chord, not the arc. The tightest arc the
 * snake can draw is `SNAKE_MIN_TURN_RADIUS`, which turns 13.0 px of arc into
 * `2 * 20 * sin(13 / 40)` = 12.77 px of chord. Nothing may ever fall below that
 * - a shorter gap means the resample lost arc length somewhere.
 */
const MIN_SEGMENT_CHORD: number =
  2.0 * C.SNAKE_MIN_TURN_RADIUS
  * Math.sin(C.SNAKE_SEGMENT_SPACING / (2.0 * C.SNAKE_MIN_TURN_RADIUS));

// ==========================================================================
// SECTION 1  turning: how much arena does doubling back cost?
// ==========================================================================

describe("steering: a U-turn costs the same arena at every speed", () => {
  // [export] levels.json: level 1 cruises at 210 px/s with speedMult 1.00,
  // level 6 at 255 x 1.29 = 329 px/s, level 12 at 309 x 1.70 = 525 px/s.
  const headline: ReadonlyArray<{ index: number; speed: number; want: number }> = [
    { index: 0, speed: 210, want: 40.0 }, // [turn_test S1] L01 measured 40.0 px
    { index: 5, speed: 329, want: 40.0 }, // [turn_test S1] L06 measured 40.0 px
    { index: 11, speed: 525, want: 52.5 }, // [turn_test S1] L12 measured 52.5 px
  ];

  for (const row of headline) {
    const level = getLevel(row.index);
    it(
      `L${String(level.number).padStart(2, "0")} ${level.name}: `
      + `${Math.round(level.baseSpeed)} px/s reverses inside ${row.want.toFixed(1)} px`,
      () => {
        // The level really does run at the speed this test is named for.
        expect(level.baseSpeed).toBeCloseTo(row.speed, 0);

        const turn = measureUTurn(level.cruiseSpeed, { speedMult: level.speedMult });
        expect(Math.abs(turn.width - row.want)).toBeLessThan(1.5);
        // ...and the measurement agrees with the closed-form 2 * v / omega, so a
        // regression shows up as a model change rather than as measurement drift.
        expect(Math.abs(turn.width - idealUTurnWidth(level.baseSpeed))).toBeLessThan(1.5);
        expect(turn.radius).toBeGreaterThan(0);
        expect(turn.frames).toBeGreaterThan(0);
        expect(turn.frames).toBeLessThan(4000);
      },
    );
  }

  it("holds a constant 20.0 px turn radius until the rate cap bites above ~400 px/s", () => {
    // radius = speed / omega; omega = clamp(speed / 20, 5.4, 20).
    for (const speed of [120, 180, 210, 260, 329, 380]) {
      expect(speed / turnRateFor(speed)).toBeCloseTo(C.SNAKE_MIN_TURN_RADIUS, 6);
    }
    // Past the cap the radius grows again - that is the whole reason level 12
    // sweeps 52.5 px instead of 40.0.
    expect(525.3 / turnRateFor(525.3)).toBeCloseTo(525.3 / C.SNAKE_TURN_RATE_CAP, 6);
    expect(525.3 / turnRateFor(525.3)).toBeGreaterThan(C.SNAKE_MIN_TURN_RADIUS);
  });

  it("publishes that same omega on Snake.turnRate after an update", () => {
    const snake = new Snake(400.0, 400.0, 0.0, 20);
    snake.speed = 210.0;
    snake.setTarget(6000.0, 400.0);
    snake.update(DT);
    // clamp(210 / 20, 5.4, 20) = 10.5 rad/s
    expect(snake.turnRate).toBeCloseTo(10.5, 6);
    expect(snake.currentSpeed).toBeCloseTo(210.0, 6);

    snake.speed = 525.3;
    snake.update(DT);
    // clamp(525.3 / 20 = 26.3, 5.4, 20) -> the 20 rad/s cap
    expect(snake.turnRate).toBeCloseTo(C.SNAKE_TURN_RATE_CAP, 6);
  });

  it("is 3.7x tighter than the pre-v2 fixed-rate model at level 12 (194.5 px -> 52.5 px)", () => {
    const level = getLevel(LEVEL_COUNT - 1);
    const before = legacyUTurnWidth(level.baseSpeed);
    // [turn_test S1] the reconstructed pre-v2 model reproduces the reported
    // ~194 px level-12 U-turn.
    expect(before).toBeGreaterThan(190.0);
    expect(before).toBeLessThan(199.0);

    const after = measureUTurn(level.cruiseSpeed, { speedMult: level.speedMult }).width;
    expect(after).toBeLessThan(before);
    expect(before / after).toBeGreaterThan(3.0);
  });

  it(`keeps every level x difficulty reversal inside the ${WIDTH_BUDGET} px budget`, () => {
    let worst = 0.0;
    let worstWhere = "-";
    for (let index = 0; index < LEVEL_COUNT; index++) {
      const level = getLevel(index);
      for (const key of D.ORDER) {
        const diff = D.getDifficulty(key);
        const turn = measureUTurn(level.cruiseSpeed, {
          speedMult: level.speedMult * diff.speedMult,
          turnMult: diff.turnMult,
        });
        expect(Number.isFinite(turn.width)).toBe(true);
        if (turn.width > worst) {
          worst = turn.width;
          worstWhere = `L${index + 1} ${key}`;
        }
      }
    }
    // [turn_test S1b] the worst cell is expert L12 (682.9 px/s, turnMult 0.90):
    // omega caps at 20 x 0.90 = 18 rad/s, so the radius is 37.9 px -> 75.9 px.
    expect(worst, `worst U-turn was ${worst.toFixed(1)} px on ${worstWhere}`)
      .toBeLessThan(WIDTH_BUDGET);
    expect(worst).toBeGreaterThan(40.0);
  });

  it("keeps even a boosted expert level-12 reversal under 200 px", () => {
    // [turn_test S1b] boost deliberately trades agility for speed; it is not
    // held to the 80 px budget, but it must not blow out either.
    const level = getLevel(LEVEL_COUNT - 1);
    const diff = D.getDifficulty(C.DIFF_EXPERT);
    const turn = measureUTurn(level.cruiseSpeed, {
      speedMult: level.speedMult * diff.speedMult,
      turnMult: diff.turnMult,
      boost: true,
    });
    expect(turn.width).toBeLessThan(200.0);
    expect(turn.width).toBeGreaterThan(WIDTH_BUDGET);
  });
});

// ==========================================================================
// The rope: sub-stepped integration and arc-length resampling
// ==========================================================================

describe("body: the path resamples to a fixed arc-length spacing", () => {
  it(`holds ${C.SNAKE_SEGMENT_SPACING} px exactly down a straight run`, () => {
    const snake = new Snake(200.0, 400.0, 0.0, 40);
    snake.speed = 300.0;
    snake.setTarget(9000.0, 400.0);
    for (let i = 0; i < 400; i++) snake.update(DT);
    expect(snake.segments).toHaveLength(40);
    expect(worstSpacingDeviation(snake)).toBeLessThan(1e-6);
  });

  it("mean deviation stays under 0.1 px over a 900-frame steered run with growth and boost", () => {
    // [smoke] the lissajous drive `tools/smoke_modules.py` uses, at the same
    // 210 px/s and extended to 900 frames. Measured here: mean deviation
    // 0.02 px, worst 0.238 px - and that worst is the minimum-radius chord
    // below, not drift. (`tools/smoke_modules.py` allows a much looser
    // worst < 4.0 px; the port is two orders of magnitude inside it.)
    const snake = new Snake(ARENA.x + ARENA.w * 0.5, ARENA.y + ARENA.h * 0.5, 0.0, 24);
    snake.speed = 210.0;
    let worst = 0.0;
    let sum = 0.0;
    let n = 0;
    for (let i = 0; i < 900; i++) {
      const ang = i * 0.017;
      snake.setTarget(
        ARENA.x + ARENA.w * 0.5 + Math.cos(ang) * 260.0,
        ARENA.y + ARENA.h * 0.5 + Math.sin(ang * 1.3) * 190.0,
      );
      snake.update(DT, { boost: i % 90 < 20 });
      if (i % 60 === 59) snake.grow(1);
      if (i <= 60) continue;
      worst = Math.max(worst, worstSpacingDeviation(snake));
      for (const g of segmentGaps(snake)) {
        sum += Math.abs(g - C.SNAKE_SEGMENT_SPACING);
        n += 1;
      }
    }
    const mean = n > 0 ? sum / n : 0;
    expect(snake.alive).toBe(true);
    expect(Math.abs(snake.segments.length - snake.targetLength)).toBeLessThanOrEqual(1);
    expect(mean, `mean spacing deviation ${mean.toFixed(4)} px`).toBeLessThan(0.1);
    expect(worst, `worst spacing deviation ${worst.toFixed(4)} px`)
      .toBeLessThan(C.SNAKE_SEGMENT_SPACING - MIN_SEGMENT_CHORD + 0.02);
  });

  it("never falls below the 12.77 px minimum-radius chord, even through hairpins", () => {
    // The exact invariant: a gap can never exceed the 13.0 px arc-length
    // spacing, and can never be shorter than the chord that spacing subtends on
    // the tightest arc the snake can draw. A coil holds the head at the 20 px
    // minimum radius for 600 straight frames, which is the worst case there is.
    expect(MIN_SEGMENT_CHORD).toBeCloseTo(12.7724, 3);
    const snake = new Snake(640.0, 400.0, 0.0, 60);
    snake.speed = 210.0;
    let worst = 0.0;
    let shortest = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 600; i++) {
      const back = snake.heading + Math.PI * 0.82;
      snake.setTarget(snake.x + Math.cos(back) * 60.0, snake.y + Math.sin(back) * 60.0);
      snake.update(DT);
      if (i <= 60) continue;
      worst = Math.max(worst, worstSpacingDeviation(snake));
      for (const g of segmentGaps(snake)) {
        shortest = Math.min(shortest, g);
        expect(g).toBeLessThanOrEqual(C.SNAKE_SEGMENT_SPACING + 1e-6);
        expect(g).toBeGreaterThanOrEqual(MIN_SEGMENT_CHORD - 1e-2);
      }
    }
    expect(worst, `worst spacing deviation ${worst.toFixed(4)} px`).toBeLessThan(0.3);
    // The chord shortfall really is what is being measured, not an artefact.
    expect(shortest).toBeLessThan(C.SNAKE_SEGMENT_SPACING - 0.15);
  });

  it("keeps the head about one spacing ahead of segment 0, and tapers head -> tail", () => {
    const snake = new Snake(200.0, 400.0, 0.0, 30);
    snake.speed = 240.0;
    snake.setTarget(9000.0, 400.0);
    for (let i = 0; i < 300; i++) snake.update(DT);

    const first = snake.segments[0];
    expect(first).toBeDefined();
    if (first !== undefined) {
      const gap = Math.hypot(first.x - snake.x, first.y - snake.y);
      expect(gap).toBeLessThanOrEqual(C.SNAKE_SEGMENT_SPACING + 2.0);
    }

    const radii = snake.segments.map((_s, i) => snake.radiusAt(i));
    expect(radii.every((r) => Number.isFinite(r) && r > 0)).toBe(true);
    const head = radii[0];
    const tail = radii[radii.length - 1];
    expect(head).toBeDefined();
    expect(tail).toBeDefined();
    if (head !== undefined && tail !== undefined) expect(head).toBeGreaterThan(tail);
    expect(snake.radiusAt(-1)).toBeCloseTo(C.SNAKE_HEAD_RADIUS, 6);
  });

  it("teleport() slides the whole rope, so the body keeps its spacing", () => {
    // [smoke] wrap walls and portals both go through this path.
    const snake = new Snake(200.0, 300.0, 0.0, 30);
    snake.speed = 240.0;
    for (let i = 0; i < 120; i++) {
      snake.setTarget(900.0, 300.0);
      snake.update(DT);
    }
    const before = segmentGaps(snake);
    snake.teleport(snake.x + 500.0, snake.y);
    const after = segmentGaps(snake);
    expect(after).toHaveLength(before.length);
    for (let i = 0; i < after.length; i++) {
      expect(after[i] ?? 0).toBeCloseTo(before[i] ?? 0, 9);
    }
  });

  it("survives a NaN target, a negative dt and an absurd dt without moving to NaN", () => {
    // [smoke] hostile input must never raise.
    const snake = new Snake(0.0, 0.0, 0.0, 8);
    snake.setTarget(Number.NaN, Number.POSITIVE_INFINITY);
    snake.update(0.0);
    snake.update(-1.0);
    snake.update(9999.0, { speedMult: 0.0, turnMult: 0.0 });
    expect(Number.isFinite(snake.x)).toBe(true);
    expect(Number.isFinite(snake.y)).toBe(true);
    expect(Number.isFinite(snake.heading)).toBe(true);
    expect(typeof snake.hitsSelf()).toBe("boolean");
  });

  it("grow() and shrink() move targetLength and clamp at the ends", () => {
    const snake = new Snake(300.0, 300.0, 0.0, 20);
    snake.grow(5);
    expect(snake.targetLength).toBe(25);
    snake.shrink(3);
    expect(snake.targetLength).toBe(22);
    snake.shrink(10_000);
    expect(snake.targetLength).toBeGreaterThanOrEqual(4);
    snake.grow(10_000);
    expect(snake.targetLength).toBeLessThanOrEqual(400);
    snake.kill();
    expect(snake.alive).toBe(false);
    expect(snake.hitsSelf()).toBe(false);
  });
});

// ==========================================================================
// SECTION 2  self-collision: hairpin survives, ramming does not
// ==========================================================================

describe("self-collision: a hairpin must not kill, ramming must", () => {
  for (const key of D.ORDER) {
    it(`${key}: a 180 degree hairpin scores zero lethal frames`, () => {
      // [turn_test S2] every mode records 0 lethal frames on this manoeuvre.
      const out = driveHairpin(key);
      expect(out.lethal).toBe(0);
      expect(out.alive).toBe(true);
      expect(out.crossing).toBeGreaterThanOrEqual(0);
    });
  }

  it("normal: a hairpin at level-12 speed (525 px/s) with a 60 segment body is not lethal", () => {
    // [turn_test S2] the fastest level is where the corridor is widest.
    const top = getLevel(LEVEL_COUNT - 1);
    const out = driveHairpin(C.DIFF_NORMAL, {
      cruise: top.cruiseSpeed,
      speedMult: top.speedMult,
      length: 60,
    });
    expect(out.lethal).toBe(0);
    expect(out.alive).toBe(true);
  });

  it("survives the hairpin even under the pre-v2 rule (skip 8, depth 0.0)", () => {
    // [turn_test S2] logs this same run as a note: "the same hairpin scored N
    // lethal frames under the pre-v2 rule". N is zero, and that is the point -
    // the constant-radius *turning* is what saves the hairpin, not the
    // forgiveness. A 62.8 px arc is under five segments long, so the head never
    // even reaches the eighth one.
    const strict: HitsSelfOptions = { skip: 8, depth: 0.0, enabled: true };
    const snake = new Snake(300.0, 420.0, 0.0, 40);
    snake.speed = 210.0;
    snake.setTarget(6000.0, 420.0);
    for (let i = 0; i < 140; i++) snake.update(DT);
    snake.setTarget(snake.x - 8000.0, snake.y + 1.0);
    let lethal = 0;
    for (let i = 0; i < 300; i++) {
      snake.update(DT);
      if (snake.hitsSelf(strict)) lethal += 1;
    }
    expect(lethal).toBe(0);
  });

  it("the depth allowance still carries its weight: a coil is deadlier at depth 0.0", () => {
    // The other half of the forgiveness. A deliberate coil *does* bring the head
    // onto post-skip body, and there the zero-depth rule bites where the shipped
    // 0.62 allowance lets the head slide over its own line.
    const shipped = coilSelfHitsWith(collideOpts(C.DIFF_NORMAL));
    const zeroDepth = coilSelfHitsWith({
      skip: C.SELF_COLLISION_SKIP, depth: 0.0, enabled: true,
    });
    expect(zeroDepth).toBeGreaterThan(shipped);
  });

  for (const key of D.ORDER) {
    const lethalExpected = key !== C.DIFF_EASY;
    it(
      `${key}: driving into the middle of a long body ${lethalExpected ? "IS" : "is NOT"} lethal`,
      () => {
        const out = driveIntoOwnBody(key);
        if (lethalExpected) {
          expect(out.lethal).toBeGreaterThan(0);
          expect(out.first).not.toBeNull();
        } else {
          // [turn_test S2] easy has self-collision switched off outright.
          expect(out.lethal).toBe(0);
          expect(out.first).toBeNull();
        }
      },
    );
  }

  it("measures the lethal band: easy never, normal 6.3, hard 7.4, expert 8.6 px", () => {
    // [turn_test S2] "lethal miss distance (head centre to body centre)".
    // The head hit circle is 13 x 0.72 = 9.36 px and body segment 30 of 60 is
    // 9.47 x 0.78 = 7.38 px, so the combined reach is 16.74 px; the band is that
    // reach x (1 - depth).
    const bands: Record<string, number | null> = {};
    for (const key of D.ORDER) bands[key] = probeLethalRadius(key);

    expect(bands[C.DIFF_EASY]).toBeNull();

    const normal = bands[C.DIFF_NORMAL];
    const hard = bands[C.DIFF_HARD];
    const expert = bands[C.DIFF_EXPERT];
    expect(normal).not.toBeNull();
    expect(hard).not.toBeNull();
    expect(expert).not.toBeNull();
    if (normal === null || normal === undefined) return;
    if (hard === null || hard === undefined) return;
    if (expert === null || expert === undefined) return;

    expect(Math.abs(normal - 6.3)).toBeLessThanOrEqual(0.2);
    expect(Math.abs(hard - 7.4)).toBeLessThanOrEqual(0.2);
    expect(Math.abs(expert - 8.6)).toBeLessThanOrEqual(0.2);
    expect(normal).toBeLessThan(hard);
    expect(hard).toBeLessThan(expert);

    // Even expert's band is narrower than the 13 px segment spacing, so the head
    // can still pass over its own line.
    expect(expert).toBeLessThan(C.SNAKE_SEGMENT_SPACING);
  });

  it("a deliberate 600-frame coil kills on expert and normal, never on easy", () => {
    // [turn_test S3] "600-frame deliberate coil (steer at a point 60 px behind
    // the head, forever)".
    const coil: Record<string, number> = {};
    for (const key of D.ORDER) coil[key] = coilSelfHits(key);

    expect(coil[C.DIFF_EASY]).toBe(0);
    expect(coil[C.DIFF_EXPERT] ?? 0).toBeGreaterThan(0);
    expect(coil[C.DIFF_NORMAL] ?? 0).toBeGreaterThan(0);
    expect(coil[C.DIFF_EXPERT] ?? 0).toBeGreaterThanOrEqual(coil[C.DIFF_NORMAL] ?? 0);
  });

  it("crossingSelf() still reports the pass-over on easy, where collision is off", () => {
    // The renderer draws the cross-over and the scene cues a whoosh from this,
    // so it must survive a skip window larger than the whole body.
    const snake = new Snake(640.0, 400.0, 0.0, 60);
    snake.speed = 210.0;
    const kw = collideOpts(C.DIFF_EASY);
    let crossings = 0;
    for (let i = 0; i < 600; i++) {
      const back = snake.heading + Math.PI * 0.82;
      snake.setTarget(snake.x + Math.cos(back) * 60.0, snake.y + Math.sin(back) * 60.0);
      snake.update(DT);
      expect(snake.hitsSelf(kw)).toBe(false);
      if (snake.crossingSelf()) crossings += 1;
    }
    expect(crossings).toBeGreaterThan(0);
  });
});

// ==========================================================================
// Levels: the campaign's speed ramp
// ==========================================================================

describe("levels: twelve stages on a monotonic speed ramp", () => {
  it("has exactly 12 levels, index-aligned and themed one-to-one", () => {
    expect(LEVEL_COUNT).toBe(12);
    expect(LEVELS).toHaveLength(12);
    LEVELS.forEach((lv, i) => {
      expect(lv.index).toBe(i);
      expect(lv.number).toBe(i + 1);
      expect(lv.name.length).toBeGreaterThan(0);
      expect(lv.theme).toBeDefined();
      expect(lv.goalFood).toBeGreaterThan(0);
    });
  });

  it("ramps the real travelling speed strictly from 210 to 525 px/s", () => {
    // [export] levels.json baseSpeed = cruiseSpeed x speedMult.
    const speeds = LEVELS.map((lv) => lv.baseSpeed);
    expect(speeds[0]).toBeCloseTo(210.0, 3);
    expect(speeds[speeds.length - 1]).toBeCloseTo(525.3, 3);
    for (let i = 0; i + 1 < speeds.length; i++) {
      expect(speeds[i + 1] ?? 0).toBeGreaterThan(speeds[i] ?? 0);
    }
  });

  it("ramps the cruise speed strictly too, and never past SNAKE_MAX_SPEED", () => {
    const cruise = LEVELS.map((lv) => lv.cruiseSpeed);
    for (let i = 0; i + 1 < cruise.length; i++) {
      expect(cruise[i + 1] ?? 0).toBeGreaterThan(cruise[i] ?? 0);
      expect(cruise[i] ?? 0).toBeLessThanOrEqual(C.SNAKE_MAX_SPEED);
    }
    // The cap bounds the cruise term only; speedMult applies on top, which is
    // what stops levels 11 and 12 both flattening onto 460 px/s.
    expect(LEVELS[LEVEL_COUNT - 1]?.baseSpeed ?? 0).toBeGreaterThan(C.SNAKE_MAX_SPEED);
  });

  it("gives every level three strictly increasing star bars", () => {
    for (const lv of LEVELS) {
      const [one, two, three] = lv.starTargets;
      expect(one).toBe(lv.parScore);
      expect(one).toBeLessThan(two);
      expect(two).toBeLessThan(three);
    }
  });

  it("getLevel() is total: junk indices clamp to the ends", () => {
    const junk = [-1, -999, LEVEL_COUNT, 1e9, 1.5, Number.NaN, Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY];
    for (const v of junk) {
      const lv = getLevel(v);
      expect(lv.index).toBeGreaterThanOrEqual(0);
      expect(lv.index).toBeLessThan(LEVEL_COUNT);
    }
    expect(getLevel(-5).index).toBe(0);
    expect(getLevel(999).index).toBe(LEVEL_COUNT - 1);
  });
});

// ==========================================================================
// Obstacles: the whole campaign's hazard layout
// ==========================================================================

describe("obstacles: 125 hazards and 12 portals across the campaign", () => {
  /** Every level's hazards, built once. */
  const built: Obstacle[][] = LEVELS.map((lv) => buildObstacles(lv.obstacleSpec, ARENA));

  it("builds exactly one hazard per spec entry - 125 in total", () => {
    // [export] levels.json: 0+4+8+6+6+7+14+18+10+12+18+22 = 125 spec entries,
    // and buildObstacles must not silently drop any of them.
    const total = built.reduce((sum, list) => sum + list.length, 0);
    const specTotal = LEVELS.reduce((sum, lv) => sum + lv.obstacleSpec.length, 0);
    expect(specTotal).toBe(125);
    expect(total).toBe(125);
    for (let i = 0; i < LEVEL_COUNT; i++) {
      expect(built[i]?.length ?? -1).toBe(LEVELS[i]?.obstacleSpec.length ?? -2);
    }
    expect(built[0]).toHaveLength(0); // level 1 is a clean arena
  });

  it("builds 12 portals, all linked into two-way pairs", () => {
    const portals = built.flat().filter((ob): ob is Portal => ob instanceof Portal);
    expect(portals).toHaveLength(12);
    for (const p of portals) {
      expect(p.linked).not.toBeNull();
      expect(p.kind).toBe("portal");
      expect(p.deadly).toBe(false);
      const other = p.linked;
      if (other !== null && other !== p) {
        // A two-way pair: following the link twice comes home again.
        expect(other.linked).toBe(p);
      }
    }
  });

  it("ejects a traveller inside the arena, then sleeps on a cooldown", () => {
    const portals = built.flat().filter((ob): ob is Portal => ob instanceof Portal);
    for (const p of portals) {
      const [ex, ey] = p.teleport(p.x + 5.0, p.y + 5.0);
      expect(Number.isFinite(ex)).toBe(true);
      expect(Number.isFinite(ey)).toBe(true);
      expect(ex).toBeGreaterThanOrEqual(ARENA.x);
      expect(ex).toBeLessThanOrEqual(ARENA.x + ARENA.w);
      expect(ey).toBeGreaterThanOrEqual(ARENA.y);
      expect(ey).toBeLessThanOrEqual(ARENA.y + ARENA.h);
      expect(p.cooldown).toBeGreaterThan(0);
      expect(p.collides(p.x, p.y, 0)).toBe(false); // asleep
    }
  });

  it("updates and answers collides() over 4 simulated seconds without throwing", () => {
    let probes = 0;
    for (const list of built) {
      let t = 0.0;
      for (let frame = 0; frame < 240; frame++) {
        t += DT;
        expect(() => updateObstacles(list, DT, t)).not.toThrow();
      }
      for (const ob of list) {
        expect(Number.isFinite(ob.t)).toBe(true);
        const b = ob.bounds();
        expect(Number.isFinite(b.x) && Number.isFinite(b.y)).toBe(true);
        expect(Number.isFinite(b.w) && Number.isFinite(b.h)).toBe(true);
        for (let gx = 0; gx <= 8; gx++) {
          for (let gy = 0; gy <= 4; gy++) {
            const x = ARENA.x + (ARENA.w * gx) / 8;
            const y = ARENA.y + (ARENA.h * gy) / 4;
            expect(typeof ob.collides(x, y, C.SNAKE_HEAD_RADIUS)).toBe("boolean");
            probes += 1;
          }
        }
        // Nonsense probes must answer false, not throw.
        expect(ob.collides(Number.NaN, Number.NaN, Number.NaN)).toBe(false);
        expect(typeof ob.collides(1e12, -1e12)).toBe("boolean");
      }
    }
    expect(probes).toBe(125 * 45);
  });

  it("hands the spawners a keep-out circle for every hazard", () => {
    for (const list of built) {
      const circles = obstacleAvoidList(list);
      expect(circles).toHaveLength(list.length);
      for (const [x, y, r] of circles) {
        expect(Number.isFinite(x)).toBe(true);
        expect(Number.isFinite(y)).toBe(true);
        expect(r).toBeGreaterThan(0);
      }
    }
  });

  it("buildObstacles is total: junk specs cost a hazard, never the level", () => {
    expect(buildObstacles(null, ARENA)).toHaveLength(0);
    expect(buildObstacles(undefined, ARENA)).toHaveLength(0);
    expect(buildObstacles([], ARENA)).toHaveLength(0);
    const junk = [
      null,
      42,
      "wall",
      [],
      { type: "no-such-hazard" },
      { type: "" },
      { noType: true },
      { type: "wall", w: Number.NaN },
    ];
    const out = buildObstacles(junk, ARENA);
    // Only the last entry names a real type; everything else is skipped.
    expect(out.length).toBeLessThanOrEqual(1);
    expect(() => updateObstacles(out, DT, 1.0)).not.toThrow();
    // A degenerate arena must not throw either.
    expect(() => buildObstacles(LEVELS[11]?.obstacleSpec ?? [], [0, 0, 0, 0])).not.toThrow();
  });
});

// ==========================================================================
// SECTION 3  difficulty: four modes that genuinely differ
// ==========================================================================

describe("difficulty: four modes that genuinely differ", () => {
  it("orders easy -> expert and reports no table problems", () => {
    expect(D.ORDER).toEqual([C.DIFF_EASY, C.DIFF_NORMAL, C.DIFF_HARD, C.DIFF_EXPERT]);
    // The module cross-checks its own helpers against the exported `derived`
    // block at load; an empty list means the port reproduces Python's numbers.
    expect(D.checkDifficultyTable()).toEqual([]);
    expect(D.TABLE_PROBLEMS).toEqual([]);
  });

  it("gives 5 / 3 / 2 / 1 lives, falling easy -> expert", () => {
    // [turn_test S3] lives are all different and fall easy -> expert.
    const lives = D.ORDER.map((k) => D.livesFor(k));
    expect(lives).toEqual([5, 3, 2, 1]);
    expect(new Set(lives).size).toBe(lives.length);
  });

  it("gives distinct, strictly rising speed multipliers", () => {
    const speeds = D.ORDER.map((k) => D.getDifficulty(k).speedMult);
    expect(speeds).toEqual([0.82, 1.0, 1.15, 1.3]);
    for (let i = 0; i + 1 < speeds.length; i++) {
      expect(speeds[i + 1] ?? 0).toBeGreaterThan(speeds[i] ?? 0);
    }
    // ...which really does move the snake: level 1 runs 210 px/s on normal.
    const level = getLevel(0);
    for (const k of D.ORDER) {
      const snake = new Snake(400.0, 400.0, 0.0, 10);
      snake.speed = level.cruiseSpeed;
      snake.setTarget(9000.0, 400.0);
      snake.update(DT, { speedMult: level.speedMult * D.getDifficulty(k).speedMult });
      expect(snake.currentSpeed).toBeCloseTo(210.0 * D.getDifficulty(k).speedMult, 6);
    }
  });

  it("shrinks the self-collision skip window and tightens the depth easy -> expert", () => {
    const skips = D.ORDER.map((k) => D.selfCollisionSkip(k));
    // [export] difficulty.json derived: easy is the SKIP_NEVER sentinel.
    expect(skips[0]).toBe(D.SKIP_NEVER);
    expect(skips.slice(1)).toEqual([16, 12, 8]);
    for (let i = 0; i + 1 < skips.length; i++) {
      expect(skips[i + 1] ?? 0).toBeLessThan(skips[i] ?? 0);
    }

    expect(D.selfCollisionEnabled(C.DIFF_EASY)).toBe(false);
    for (const k of D.ORDER.slice(1)) expect(D.selfCollisionEnabled(k)).toBe(true);

    const depths = D.ORDER.slice(1).map((k) => D.selfCollisionDepth(k));
    for (let i = 0; i + 1 < depths.length; i++) {
      expect(depths[i + 1] ?? 0).toBeLessThan(depths[i] ?? 0);
    }
    expect(depths[0]).toBeCloseTo(C.SELF_COLLISION_DEPTH, 9);
  });

  it("NORMAL is the identity row - the pre-v2 balance is untouched", () => {
    // [turn_test S3] every multiplier is 1.0 and the derived values equal the
    // raw config constants.
    const n = D.getDifficulty(C.DIFF_NORMAL);
    const identity: ReadonlyArray<number> = [
      n.invulnMult, n.speedMult, n.turnMult, n.selfSkipMult, n.selfDepthMult,
      n.hazardSpeedMult, n.powerupRateMult, n.foodValueMult, n.scoreMult,
      n.comboWindowMult, n.starTargetMult,
    ];
    for (const v of identity) expect(v).toBeCloseTo(1.0, 9);
    expect(n.lives).toBe(C.START_LIVES);
    expect(D.selfCollisionSkip(C.DIFF_NORMAL)).toBe(C.SELF_COLLISION_SKIP);
    expect(D.selfCollisionDepth(C.DIFF_NORMAL)).toBeCloseTo(C.SELF_COLLISION_DEPTH, 9);
    expect(D.invulnSeconds(C.DIFF_NORMAL)).toBeCloseTo(C.INVULN_AFTER_HIT, 9);
    expect(D.comboWindow(C.DIFF_NORMAL)).toBeCloseTo(C.COMBO_WINDOW, 9);
    expect(D.powerupSpawnRange(C.DIFF_NORMAL)).toEqual([
      C.POWERUP_SPAWN_MIN, C.POWERUP_SPAWN_MAX,
    ]);
    expect(D.isDefault(C.DIFF_NORMAL)).toBe(true);
  });

  it("makes power-ups rarer and orbs worth more as the modes harden", () => {
    // [turn_test S3] derived helpers.
    const windows = D.ORDER.map((k) => D.powerupSpawnRange(k));
    for (let i = 0; i + 1 < windows.length; i++) {
      expect(windows[i + 1]?.[0] ?? 0).toBeGreaterThan(windows[i]?.[0] ?? 0);
      expect(windows[i]?.[1] ?? 0).toBeGreaterThan(windows[i]?.[0] ?? 0);
    }

    const orb = D.ORDER.map((k) => D.scoreForFood(k, C.SCORE_PER_FOOD));
    expect(new Set(orb).size).toBe(orb.length);
    for (let i = 0; i + 1 < orb.length; i++) {
      expect(orb[i + 1] ?? 0).toBeGreaterThan(orb[i] ?? 0);
    }

    const stars = D.ORDER.map((k) => D.applyStarTargets(k, getLevel(0).starTargets));
    for (const t of stars) {
      expect(t).toHaveLength(3);
      expect(t[0]).toBeGreaterThan(0);
      expect(t[0]).toBeLessThan(t[1]);
      expect(t[1]).toBeLessThan(t[2]);
    }
    expect(stars[0]?.[0] ?? 0).toBeLessThan(stars[3]?.[0] ?? 0);

    const invuln = D.ORDER.map((k) => D.invulnSeconds(k));
    for (let i = 0; i + 1 < invuln.length; i++) {
      expect(invuln[i + 1] ?? 0).toBeLessThan(invuln[i] ?? 0);
    }
  });

  it("every lookup is total over junk input, and keys are case/whitespace tolerant", () => {
    // [turn_test S3] 13 junk inputs x 4 accessors, none of which may throw.
    const junk: unknown[] = [
      null, undefined, "", "  NORMAL  ", "nope", 3, 3.5, -1, 999,
      Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, [], {},
    ];
    for (const value of junk) {
      const v = value as D.DiffLike;
      expect(() => {
        D.getDifficulty(v);
        D.selfCollisionSkip(v);
        D.selfCollisionDepth(v);
        D.selfCollisionEnabled(v);
        D.livesFor(v);
        D.invulnSeconds(v);
        D.comboWindow(v);
        D.powerupSpawnRange(v);
        D.scoreForFood(v, 10);
        D.applyStarTargets(v, null);
        D.indexOf(v);
        D.nextDifficulty(v);
        D.prevDifficulty(v);
        D.label(v);
      }).not.toThrow();
      expect(D.livesFor(v)).toBeGreaterThanOrEqual(1);
      expect(D.selfCollisionSkip(v)).toBeGreaterThanOrEqual(1);
    }
    expect(D.getDifficulty("  NORMAL  ").key).toBe(C.DIFF_NORMAL);
    expect(D.getDifficulty("nope").key).toBe(C.DEFAULT_DIFFICULTY);
    expect(D.isDifficultyKey("EXPERT")).toBe(true);
    expect(D.isDifficultyKey("wizard")).toBe(false);
    // Cycling wraps in both directions and visits all four.
    let key = C.DIFF_EASY;
    const visited: string[] = [];
    for (let i = 0; i < D.ORDER.length; i++) {
      visited.push(key);
      key = D.nextDifficulty(key);
    }
    expect(new Set(visited).size).toBe(4);
    expect(key).toBe(C.DIFF_EASY);
    expect(D.prevDifficulty(C.DIFF_EASY)).toBe(C.DIFF_EXPERT);
  });
});

// ==========================================================================
// SECTION 5  story: twelve beats, four chapters, total accessors
// ==========================================================================

describe("story: twelve beats, four chapters, total accessors", () => {
  it("has one beat per level, index-aligned with the campaign", () => {
    expect(S.BEAT_COUNT).toBe(LEVEL_COUNT);
    expect(S.BEATS).toHaveLength(12);
    expect(S.BEATS.map((b) => b.levelIndex)).toEqual(
      Array.from({ length: LEVEL_COUNT }, (_v, i) => i),
    );
    for (const beat of S.BEATS) {
      expect(beat.title.length).toBeGreaterThan(0);
      expect(beat.intro.length).toBeGreaterThanOrEqual(1);
      expect(beat.intro.length).toBeLessThanOrEqual(6);
      expect(beat.outro.length).toBeGreaterThanOrEqual(1);
      expect(beat.outro.length).toBeLessThanOrEqual(6);
    }
  });

  it("has four chapters that partition levels 0..11 exactly once", () => {
    expect(S.CHAPTER_COUNT).toBe(4);
    const covered: number[] = [];
    for (const chapter of S.CHAPTERS) covered.push(...chapter.levelIndices());
    covered.sort((a, b) => a - b);
    expect(covered).toEqual(Array.from({ length: LEVEL_COUNT }, (_v, i) => i));
  });

  it("keeps the chapters contiguous from 0 to 11", () => {
    for (let i = 0; i + 1 < S.CHAPTERS.length; i++) {
      const a = S.CHAPTERS[i];
      const b = S.CHAPTERS[i + 1];
      expect(a).toBeDefined();
      expect(b).toBeDefined();
      if (a === undefined || b === undefined) continue;
      expect(a.lastIndex + 1).toBe(b.firstIndex);
      expect(a.roman().length).toBeGreaterThan(0);
      expect(a.levelRange()).toEqual([a.firstIndex, a.lastIndex]);
    }
    expect(S.CHAPTERS[0]?.firstIndex).toBe(0);
    expect(S.CHAPTERS[S.CHAPTER_COUNT - 1]?.lastIndex).toBe(LEVEL_COUNT - 1);
  });

  it("fires chapterStart / chapterEnd exactly on the chapter boundaries", () => {
    const starts: number[] = [];
    const ends: number[] = [];
    for (let i = 0; i < LEVEL_COUNT; i++) {
      if (S.chapterStart(i)) starts.push(i);
      if (S.chapterEnd(i)) ends.push(i);
    }
    expect(starts).toEqual(S.CHAPTERS.map((c) => c.firstIndex));
    expect(ends).toEqual(S.CHAPTERS.map((c) => c.lastIndex));
    // [turn_test S5] get_chapter agrees with the chapter table on every level.
    for (let i = 0; i < LEVEL_COUNT; i++) {
      expect(S.getChapter(i)).toBe(S.CHAPTERS[Math.floor(i / S.CHAPTER_SIZE)]);
      expect(S.getChapter(i).contains(i)).toBe(true);
      expect(S.getBeat(i).chapterTitle).toBe(S.getChapter(i).title);
    }
    for (let n = 1; n <= S.CHAPTER_COUNT; n++) {
      expect(S.beatsInChapter(n)).toHaveLength(S.CHAPTER_SIZE);
    }
  });

  it("every accessor is total over junk input and clamps to the ends", () => {
    // [turn_test S5] the Python original had a real bug here:
    // `int(float("inf"))` raised OverflowError straight out of every accessor.
    const junk: unknown[] = [
      Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY,
      -1, -999, 999, LEVEL_COUNT, 1.5, 3.7, 1e9, null, undefined, "x", true, [], {},
    ];
    for (const value of junk) {
      const v = value as number;
      expect(() => {
        S.getBeat(v);
        S.getChapter(v);
        S.chapterStart(v);
        S.chapterEnd(v);
        S.beatsInChapter(v);
      }).not.toThrow();
      expect(S.getBeat(v)).toBeDefined();
      expect(S.getChapter(v)).toBeDefined();
      expect(typeof S.chapterStart(v)).toBe("boolean");
      expect(Array.isArray(S.beatsInChapter(v))).toBe(true);
    }
    expect(S.getBeat(-5)).toBe(S.BEATS[0]);
    expect(S.getBeat(999)).toBe(S.BEATS[S.BEAT_COUNT - 1]);
    expect(S.getBeat(Number.POSITIVE_INFINITY)).toBe(S.BEATS[S.BEAT_COUNT - 1]);
    expect(S.getBeat(Number.NEGATIVE_INFINITY)).toBe(S.BEATS[0]);
    expect(S.getBeat(Number.NaN)).toBe(S.BEATS[0]);
  });

  it("validates clean, and the prologue and epilogue have content", () => {
    expect(S.validateStory()).toEqual([]);
    expect(S.PROLOGUE.lines.length).toBeGreaterThan(0);
    expect(S.EPILOGUE.lines.length).toBeGreaterThan(0);
    expect(S.allBeats()).toHaveLength(LEVEL_COUNT);
  });
});

// ==========================================================================
// SECTION 4  save: round trip, schema-1 migration, hostile storage
// ==========================================================================

/** A `localStorage` stand-in backed by a Map. */
class MemoryStorage implements StorageLike {
  private readonly data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
  /** Seed a raw document, as if a previous build had written it. */
  seed(key: string, text: string): void {
    this.data.set(key, text);
  }
}

/** A `localStorage` stand-in where every operation fails. */
class HostileStorage implements StorageLike {
  getItem(): string | null {
    throw new Error("SecurityError: storage is blocked");
  }
  setItem(): void {
    throw new Error("QuotaExceededError");
  }
  removeItem(): void {
    throw new Error("QuotaExceededError");
  }
}

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

/** Swap `globalThis.localStorage` for the duration of one test. */
function installStorage(store: StorageLike | null): void {
  Object.defineProperty(globalThis, "localStorage", {
    value: store,
    configurable: true,
    writable: true,
  });
}

/** Put `globalThis.localStorage` back exactly as it was. */
function restoreStorage(): void {
  if (originalStorage === undefined) {
    Reflect.deleteProperty(globalThis, "localStorage");
  } else {
    Object.defineProperty(globalThis, "localStorage", originalStorage);
  }
}

describe("save: schema-2 round trip and schema-1 migration", () => {
  afterEach(() => {
    restoreStorage();
  });

  it("round-trips every field of a fully populated profile", () => {
    const store = new MemoryStorage();
    installStorage(store);

    const key = "neon-serpent-test-roundtrip";
    const save = new SaveData(key);
    save.setDisplayMode("borderless");
    save.setDifficulty(C.DIFF_EXPERT);
    save.setMode(C.MODE_FREE);
    save.setStoryProgress(7);
    save.setStoryComplete(true);
    for (const beat of [0, 3, 3, 7, 11]) save.markBeatSeen(beat);
    save.addFood(42);
    save.addDeath(5);
    save.setMuted(true);
    save.unlockThrough(9);

    // [turn_test S4] per-difficulty records: an easy three-star clear must not
    // stomp on the expert two-star clear of the same level.
    save.record(2, 900, 3, C.DIFF_EASY);
    save.record(2, 400, 2, C.DIFF_EXPERT);
    save.record(5, 1500, 3, C.DIFF_HARD);
    save.record(11, 2500, 1, C.DIFF_NORMAL);

    expect(save.dirty).toBe(true);
    expect(save.save()).toBe(true);
    expect(save.dirty).toBe(false);
    expect(store.getItem(key)).not.toBeNull();

    const back = SaveData.load(key);
    expect(back.displayMode).toBe("borderless");
    expect(back.difficulty).toBe(C.DIFF_EXPERT);
    expect(back.mode).toBe(C.MODE_FREE);
    expect(back.storyProgress).toBe(7);
    expect(back.storyComplete).toBe(true);
    expect(back.muted).toBe(true);
    expect(back.totalFood).toBe(42);
    expect(back.totalDeaths).toBe(5);
    expect(back.unlocked).toBe(save.unlocked);

    // seenBeats is de-duplicated and sorted.
    expect(back.seenBeats).toEqual([0, 3, 7, 11]);
    expect(back.beatSeen(3)).toBe(true);
    expect(back.beatSeen(4)).toBe(false);

    // Per-difficulty bests and stars are isolated.
    expect(back.bestFor(2, C.DIFF_EASY)).toBe(900);
    expect(back.bestFor(2, C.DIFF_EXPERT)).toBe(400);
    expect(back.starsFor(2, C.DIFF_EASY)).toBe(3);
    expect(back.starsFor(2, C.DIFF_EXPERT)).toBe(2);
    // ...while the flat table keeps the best-ever score.
    expect(back.bestFor(2)).toBe(900);
    expect(back.highscore).toBe(2500);
    expect(back.totalStars(C.DIFF_HARD)).toBe(3);
    expect(back.totalStars()).toBeGreaterThanOrEqual(3);
    expect(back.maxStars()).toBe(LEVEL_COUNT * 3);
    expect(back.clearedLevels()).toEqual([2, 5, 11]);
    expect(back.progress()).toEqual([3, LEVEL_COUNT]);
    expect(back.completed(2)).toBe(true);
    expect(back.completed(3)).toBe(false);
    expect(back.isUnlocked(0)).toBe(true);

    // Every difficulty key is present in the per-difficulty table.
    expect(Object.keys(back.bestByDifficulty).sort()).toEqual([...D.ORDER].sort());

    // The written document declares the current schema.
    const doc = back.toDict();
    expect(doc.schema).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(2);
  });

  it("migrates a schema-1 document forward without losing anything", () => {
    // [turn_test S4] a hand-written schema-1 profile, in the Python spelling.
    const store = new MemoryStorage();
    installStorage(store);
    const key = "neon-serpent-test-legacy";
    const legacy = {
      schema: 1,
      highscore: 1234,
      unlocked: 6,
      best: { "0": 300, "1": 640, "4": 1234 },
      stars: { "0": 3, "1": 2, "4": 1 },
      muted: true,
      total_food: 88,
      total_deaths: 13,
    };
    store.seed(key, JSON.stringify(legacy));

    const old = SaveData.load(key);
    expect(old.highscore).toBe(1234);
    expect(old.unlocked).toBe(6);
    expect(old.muted).toBe(true);
    expect(old.totalFood).toBe(88);
    expect(old.totalDeaths).toBe(13);
    for (const [k, v] of Object.entries(legacy.best)) {
      expect(old.bestFor(Number(k))).toBe(v);
      // The legacy history is adopted as the default difficulty's history.
      expect(old.bestFor(Number(k), C.DEFAULT_DIFFICULTY)).toBe(v);
    }
    for (const [k, v] of Object.entries(legacy.stars)) {
      expect(old.starsFor(Number(k))).toBe(v);
      expect(old.starsFor(Number(k), C.DEFAULT_DIFFICULTY)).toBe(v);
    }
    // New schema-2 fields default sanely on a legacy document.
    expect(old.difficulty).toBe(C.DEFAULT_DIFFICULTY);
    expect(old.mode).toBe(C.DEFAULT_MODE);
    expect(old.storyProgress).toBe(0);
    expect(old.storyComplete).toBe(false);
    expect(old.seenBeats).toEqual([]);
    // ...and it stays dirty, so the next flush rewrites it in schema 2.
    expect(old.dirty).toBe(true);

    const migratedKey = "neon-serpent-test-migrated";
    old.key = migratedKey;
    expect(old.flush()).toBe(true);
    const again = SaveData.load(migratedKey);
    expect(again.bestFor(4)).toBe(1234);
    expect(again.starsFor(0)).toBe(3);
    expect(again.bestFor(1, C.DEFAULT_DIFFICULTY)).toBe(640);
    const rewritten = JSON.parse(store.getItem(migratedKey) ?? "{}") as { schema?: number };
    expect(rewritten.schema ?? 0).toBeGreaterThanOrEqual(2);
    expect(again.dirty).toBe(false);
  });

  it("repairs a document whose highscore and unlock frontier contradict its table", () => {
    const store = new MemoryStorage();
    installStorage(store);
    const key = "neon-serpent-test-repair";
    store.seed(key, JSON.stringify({
      schema: SCHEMA_VERSION, highscore: 0, unlocked: 1, best: { "7": 4321 },
    }));
    const data = SaveData.load(key);
    expect(data.highscore).toBe(4321);
    expect(data.unlocked).toBeGreaterThanOrEqual(8);
  });

  it("falls back to defaults for corrupt, hostile and non-finite documents", () => {
    const store = new MemoryStorage();
    installStorage(store);
    const cases: ReadonlyArray<[string, string]> = [
      ["corrupt", "{not json at all"],
      ["truncated", '{"schema": 2, "highscore":'],
      ["not-a-dict", "[1, 2, 3]"],
      ["a-string", '"hello"'],
      ["null", "null"],
      ["empty", ""],
      // JSON.parse turns 1e999 into Infinity, so a hand-edited document really
      // can carry non-finite numbers. [turn_test S4] "non-finite".
      ["non-finite", '{"schema": 1e999, "highscore": 1e999, "unlocked": -1e999,'
        + ' "storyProgress": 1e999, "best": {"0": 1e999}, "stars": {"3": 1e999},'
        + ' "seenBeats": [1e999, 2], "totalFood": -1e999}'],
      ["garbage", '{"highscore": "NaN", "best": [1,2,3], "stars": null,'
        + ' "seenBeats": "nope", "difficulty": "impossible", "bestByDifficulty": 5}'],
    ];
    for (const [name, text] of cases) {
      const key = `neon-serpent-test-bad-${name}`;
      store.seed(key, text);
      let data: SaveData | null = null;
      expect(() => {
        data = SaveData.load(key);
      }, `loading the ${name} document threw`).not.toThrow();
      expect(data).not.toBeNull();
      if (data === null) continue;
      const d: SaveData = data;
      expect(Number.isFinite(d.highscore)).toBe(true);
      expect(d.highscore).toBeGreaterThanOrEqual(0);
      expect(d.unlocked).toBeGreaterThanOrEqual(1);
      expect(d.unlocked).toBeLessThanOrEqual(LEVEL_COUNT);
      expect(Number.isFinite(d.storyProgress)).toBe(true);
      expect(D.isDifficultyKey(d.difficulty)).toBe(true);
      expect(d.seenBeats.every((n) => Number.isFinite(n))).toBe(true);
      expect(() => d.save()).not.toThrow();
      // ...and the rewritten document is well-formed JSON in the current schema.
      const doc = JSON.parse(store.getItem(key) ?? "{}") as { schema?: number };
      expect(doc.schema).toBe(SCHEMA_VERSION);
    }
  });

  it("survives a localStorage that throws on every call", () => {
    installStorage(new HostileStorage());
    const key = "neon-serpent-test-hostile";
    let data: SaveData | null = null;
    expect(() => {
      data = SaveData.load(key);
    }).not.toThrow();
    expect(data).not.toBeNull();
    if (data === null) return;
    const d: SaveData = data;
    expect(d.highscore).toBe(0);
    expect(d.unlocked).toBe(1);
    d.record(0, 500, 2);
    // The write cannot land in persistent storage, so it reports false - but it
    // must not throw, and the session must stay consistent.
    expect(() => d.save()).not.toThrow();
    expect(d.save()).toBe(false);
    expect(d.bestFor(0)).toBe(500);
    expect(SaveData.load(key).bestFor(0)).toBe(500); // served from the memory mirror
  });

  it("survives a localStorage that throws merely on property access", () => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get(): StorageLike {
        throw new Error("SecurityError: access denied");
      },
    });
    expect(() => SaveData.load("neon-serpent-test-denied")).not.toThrow();
    const d = SaveData.load("neon-serpent-test-denied");
    expect(d.key).toBe("neon-serpent-test-denied");
    expect(() => d.save()).not.toThrow();
  });

  it("has a sane default key, and reset() clears progress but keeps the key", () => {
    installStorage(new MemoryStorage());
    expect(new SaveData().key).toBe(DEFAULT_SAVE_KEY);
    const d = new SaveData("neon-serpent-test-reset");
    d.record(3, 800, 3);
    d.setMuted(true);
    d.markBeatSeen(2);
    d.reset();
    expect(d.key).toBe("neon-serpent-test-reset");
    expect(d.highscore).toBe(0);
    expect(d.unlocked).toBe(1);
    expect(d.best).toEqual({});
    expect(d.seenBeats).toEqual([]);
    expect(d.muted).toBe(true); // the mute preference deliberately survives
  });
});

// ==========================================================================
// Food: spawning, avoidance and collection
// ==========================================================================

describe("food: spawning respects the avoid list, collectAt removes what it returns", () => {
  const theme = getLevel(0).theme;

  it("stocks the field with ensure(n) and keeps every orb inside the arena", () => {
    const field = new FoodField(ARENA, theme, 1234);
    field.ensure(8);
    expect(field.count("normal")).toBe(8);
    expect(field.spawnedTotal).toBe(8);
    for (const f of field.items) {
      expect(f.x).toBeGreaterThan(ARENA.x);
      expect(f.x).toBeLessThan(ARENA.x + ARENA.w);
      expect(f.y).toBeGreaterThan(ARENA.y);
      expect(f.y).toBeLessThan(ARENA.y + ARENA.h);
      expect(f.value).toBe(C.SCORE_PER_FOOD);
      expect(f.dead).toBe(false);
    }
  });

  it("keeps new orbs clear of every circle in the avoid list", () => {
    const field = new FoodField(ARENA, theme, 99);
    const cx = ARENA.x + ARENA.w * 0.5;
    const cy = ARENA.y + ARENA.h * 0.5;
    const avoid: AvoidCircle[] = [
      [cx, cy, 180.0],
      [ARENA.x + 120.0, ARENA.y + 120.0, 90.0],
    ];
    field.ensure(10, avoid);
    expect(field.count("normal")).toBeGreaterThan(0);
    for (const f of field.items) {
      for (const [ax, ay, ar] of avoid) {
        expect(Math.hypot(f.x - ax, f.y - ay)).toBeGreaterThan(ar + f.radius);
      }
    }
  });

  it("keeps orbs clear of the level's real hazards", () => {
    // The end-to-end shape: level 12's hazards become the spawner's avoid list.
    const level = getLevel(LEVEL_COUNT - 1);
    const hazards = buildObstacles(level.obstacleSpec, ARENA);
    const avoid = obstacleAvoidList(hazards);
    const field = new FoodField(ARENA, level.theme, 7);
    field.avoid = [...avoid];
    field.ensure(level.foodCount);
    expect(field.items.length).toBeGreaterThan(0);
    for (const f of field.items) {
      for (const [ax, ay, ar] of avoid) {
        expect(Math.hypot(f.x - ax, f.y - ay)).toBeGreaterThan(ar + f.radius);
      }
    }
  });

  it("collectAt() returns exactly the orbs it removed", () => {
    const field = new FoodField(ARENA, theme, 4242);
    field.ensure(6);
    const before = field.count();
    const target: Food | undefined = field.items[0];
    expect(target).toBeDefined();
    if (target === undefined) return;

    const taken = field.collectAt(target.x, target.y, C.SNAKE_HEAD_RADIUS);
    expect(taken.length).toBeGreaterThanOrEqual(1);
    expect(taken).toContain(target);
    expect(field.count()).toBe(before - taken.length);
    for (const f of taken) {
      expect(f.dead).toBe(true);
      expect(field.items).not.toContain(f);
    }
    // A second sweep of the same spot finds nothing left.
    expect(field.collectAt(target.x, target.y, C.SNAKE_HEAD_RADIUS)).toHaveLength(0);
  });

  it("retires perishable orbs and is reproducible from its seed", () => {
    const a = new FoodField(ARENA, theme, 2024);
    const b = new FoodField(ARENA, theme, 2024);
    a.ensure(5);
    b.ensure(5);
    expect(a.items.map((f) => [f.x, f.y])).toEqual(b.items.map((f) => [f.x, f.y]));

    const field = new FoodField(ARENA, theme, 11);
    field.autoSpecial = false;
    const bonus = field.spawn("bonus");
    expect(bonus).not.toBeNull();
    if (bonus === null) return;
    expect(bonus.ttl).toBeGreaterThan(0);
    field.update(0.0, bonus.ttl + 0.1);
    expect(field.items).not.toContain(bonus);
    expect(field.expiredTotal).toBeGreaterThan(0);
    // Normal orbs are immortal.
    const orb = field.spawn("normal");
    expect(orb?.ttl).toBe(0);
  });
});

// ==========================================================================
// Power-ups: field, avoidance and the effect book
// ==========================================================================

describe("power-ups: the field spawns legally and the effect book is one-shot", () => {
  const theme = getLevel(0).theme;

  it("describes six kinds, each with a positive duration", () => {
    expect(POWERUP_KINDS).toHaveLength(6);
    for (const kind of POWERUP_KINDS) {
      const info = POWERUP_TYPES[kind];
      expect(info.name.length).toBeGreaterThan(0);
      expect(info.duration).toBeGreaterThan(0);
      expect(info.color).toHaveLength(3);
    }
  });

  it("keeps a spawned rune clear of the avoid list and inside the arena", () => {
    const field = new PowerUpField(ARENA, theme, 31337);
    const avoid = obstacleAvoidList(
      buildObstacles(getLevel(6).obstacleSpec, ARENA),
    );
    const rune = field.spawn(undefined, avoid);
    expect(rune).not.toBeNull();
    if (rune === null) return;
    expect(rune.x).toBeGreaterThan(ARENA.x);
    expect(rune.x).toBeLessThan(ARENA.x + ARENA.w);
    expect(rune.y).toBeGreaterThan(ARENA.y);
    expect(rune.y).toBeLessThan(ARENA.y + ARENA.h);
    for (const [ax, ay, ar] of avoid) {
      expect(Math.hypot(rune.x - ax, rune.y - ay))
        .toBeGreaterThan(ar + C.POWERUP_RADIUS);
    }
  });

  it("never keeps more than two runes on the field, and ages them out", () => {
    const field = new PowerUpField(ARENA, theme, 5);
    for (let i = 0; i < 6; i++) field.spawn();
    expect(field.count()).toBeLessThanOrEqual(2);
    field.update(C.POWERUP_LIFETIME + 1.0, 0);
    expect(field.count()).toBe(0);
    // A disabled field never spawns on its own.
    field.enabled = false;
    for (let i = 0; i < 200; i++) field.maybeSpawn(0.5);
    expect(field.count()).toBe(0);
  });

  it("collectAt() returns exactly the runes it removed", () => {
    const field = new PowerUpField(ARENA, theme, 77);
    const rune = field.spawn("shield");
    expect(rune).not.toBeNull();
    if (rune === null) return;
    const taken = field.collectAt(rune.x, rune.y, C.SNAKE_HEAD_RADIUS);
    expect(taken).toEqual([rune]);
    expect(field.count()).toBe(0);
    expect(field.collectAt(rune.x, rune.y, C.SNAKE_HEAD_RADIUS)).toHaveLength(0);
  });

  it("ActiveEffects.consume() is a one-shot: a shield absorbs exactly one hit", () => {
    const fx = new ActiveEffects();
    expect(fx.consume("shield")).toBe(false); // nothing to spend yet
    fx.add("shield");
    expect(fx.has("shield")).toBe(true);
    expect(fx.remaining("shield")).toBeCloseTo(POWERUP_TYPES.shield.duration, 6);
    expect(fx.consume("shield")).toBe(true);
    expect(fx.has("shield")).toBe(false);
    expect(fx.consume("shield")).toBe(false);
    expect(fx.size).toBe(0);
  });

  it("refreshes rather than stacks, counts down, and reports what expired", () => {
    const fx = new ActiveEffects();
    fx.add("double");
    fx.update(4.0);
    fx.add("double"); // a refresh, not a second copy
    expect(fx.size).toBe(1);
    expect(fx.remaining("double")).toBeCloseTo(POWERUP_TYPES.double.duration, 6);
    expect(fx.scoreMultiplier()).toBe(2);

    fx.add("slow");
    expect(fx.speedMultiplier()).toBeLessThan(1.0);
    expect(fx.turnMultiplier()).toBeGreaterThan(1.0);
    fx.add("frenzy");
    expect(fx.extraFood()).toBeGreaterThan(0);
    fx.add("magnet");
    expect(fx.magnetRadius()).toBeGreaterThan(0);
    expect(fx.items().length).toBe(fx.size);

    const done = fx.update(100.0);
    expect(new Set(done)).toEqual(new Set(["double", "slow", "frenzy", "magnet"]));
    expect(fx.size).toBe(0);
    expect(fx.scoreMultiplier()).toBe(1);
    expect(fx.speedMultiplier()).toBe(1.0);
    expect(fx.magnetRadius()).toBe(0);
    expect(fx.fraction("double")).toBe(0);
  });
});
