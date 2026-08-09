/**
 * Numeric parity against the Python original.
 *
 * `tools/port_parity.py` drives the *real* pygame game objects through a fixed,
 * fully recorded script and dumps everything it observes to
 * `tests/fixtures/port_parity.json`. This spec replays the identical script
 * against the TypeScript port and asserts the two traces agree.
 *
 * Nothing here regenerates the script: the per-frame dt, steering target, boost
 * flag and multipliers are read out of the fixture, so the two runs cannot
 * drift apart through a differing input generator. That makes a failure here
 * unambiguous - it is the port that moved, not the harness.
 *
 * To regenerate the fixture after a deliberate change to the Python game:
 *
 *     python tools/port_parity.py
 */

import { describe, expect, it } from "vitest";

import * as C from "../src/core/config";
import * as D from "../src/core/difficulty";
import {
  LaserGate,
  MovingBar,
  Obstacle,
  Portal,
  Pulsar,
  Spinner,
  WallBlock,
  buildObstacles,
  obstacleAvoidList,
  updateObstacles,
} from "../src/core/obstacles";
import { LEVELS, getLevel } from "../src/core/level";
import { MAX_LENGTH, MIN_LENGTH, Snake } from "../src/core/snake";
import * as palette from "../src/core/palette";
import * as food from "../src/core/food";
import * as powerups from "../src/core/powerups";
import * as story from "../src/core/story";

import fixture from "./fixtures/port_parity.json";

// ==========================================================================
// fixture typing
// ==========================================================================

/** One recorded frame of input for the snake trace. */
interface ScriptFrame {
  dt: number;
  tx: number | null;
  ty: number | null;
  boost: boolean;
  speedMult: number;
  turnMult: number;
  grow: number;
}

/** One recorded frame of observed snake state. */
interface TraceFrame {
  x: number;
  y: number;
  heading: number;
  currentSpeed: number;
  turnRate: number;
  turnInput: number;
  bank: number;
  boost: number;
  boosting: boolean;
  distanceTravelled: number;
  targetLength: number;
  segments: number;
  path: number;
  minGap: number;
  maxGap: number;
  hitsSelf: boolean;
  crossingSelf: boolean;
}

interface UTurnCase {
  case?: string;
  cruise: number;
  speedMult: number;
  turnMult: number;
  boost: boolean;
  effectiveSpeed: number;
  width: number;
  radius: number;
  frames: number;
}

interface LethalBand {
  difficulty: string;
  skip: number;
  depth: number;
  enabled: boolean;
  lives: number;
  invuln: number;
  comboWindow: number | null;
  powerupSpawnRange: [number, number] | null;
  firstNonLethal: number | null;
  lethalProbes: number;
}

interface HairpinCase {
  difficulty: string;
  speed: number;
  lethalFrames: number;
  crossingFrames: number;
}

interface ObstacleSnapshot {
  kind: string;
  deadly: boolean;
  bounds: [number, number, number, number];
  avoid: [number, number, number];
  state: Record<string, unknown>;
  probes: string;
}

interface ObstacleLevel {
  index: number;
  specCount: number;
  count: number;
  kinds: string[];
  portalCount: number;
  portalLinks: boolean[];
  avoidList: [number, number, number][];
  t: number;
  atT0: ObstacleSnapshot[];
  atT1: ObstacleSnapshot[];
}

/** An `[input, expectedRgb]` sample of a pure colour function. */
type ColourSample = [number, [number, number, number]];

interface PaletteFixture {
  clamp8: [number, number][];
  lerpColor: ColourSample[];
  shade: ColourSample[];
  withAlpha: [number, [number, number, number, number]][];
  hsv: ColourSample[];
  hueShift: ColourSample[];
  rainbow: ColourSample[];
  themes: { name: string; bodyAt: ColourSample[] }[];
  ui: Record<string, [number, number, number]>;
}

interface FoodFixture {
  times: number[];
  kinds: Record<string, { value: number; radius: number; ttl: number; grow: number }>;
  constants: Record<string, number>;
  orbs: {
    kind: string;
    phase: number;
    spin: number;
    born: number;
    value: number;
    radius: number;
    ttl: number;
    grow: number;
    perishable: boolean;
    pickupRadius: number;
    overlaps: boolean[];
    frames: {
      t: number;
      age: number;
      remaining: number | null;
      expired: boolean;
      bobOffset: number;
      drawPos: [number, number];
      drawRadius: number;
      visible: boolean;
    }[];
  }[];
  colours: {
    level: number | null;
    normal: [number, number, number][];
    bonus: [number, number, number][];
    mega: [number, number, number][];
  }[];
}

interface PowerupFixture {
  kinds: string[];
  types: Record<
    string,
    { name: string; duration: number; color: [number, number, number] }
  >;
  constants: Record<string, number>;
  runes: {
    kind: string;
    phase: number;
    spin: number;
    ttl: number;
    radius: number;
    colour: [number, number, number];
    duration: number;
    pickupRadius: number;
    overlaps: boolean[];
    frames: {
      age: number;
      remaining: number;
      expired: boolean;
      brightness: number;
      drawRadius: number;
    }[];
  }[];
  effects: {
    f: number;
    expired: string[];
    size: number;
    items: [string, number][];
    scoreMult: number;
    speedMult: number;
    turnMult: number;
    magnetRadius: number;
    extraFood: number;
    fractions: Record<string, number>;
  }[];
}

interface Fixture {
  python: string;
  dt: number;
  config: Record<string, number>;
  snakeTrace: {
    init: { x: number; y: number; heading: number; length: number; speed: number };
    script: ScriptFrame[];
    frames: TraceFrame[];
    segmentSamples: { frame: number; segs: [number, number][] }[];
  };
  uturn: UTurnCase[];
  uturnMatrix: { index: number; baseSpeed: number; widths: Record<string, number> }[];
  speedRamp: {
    index: number;
    name: string;
    speedMult: number;
    cruiseSpeed: number;
    baseSpeed: number;
    goalFood: number;
    foodCount: number;
    parScore: number;
    starTargets: [number, number, number];
    wrapWalls: boolean;
    powerupsEnabled: boolean;
    measuredTravel: number;
    uturnWidth: number;
  }[];
  lethalBands: LethalBand[];
  hairpin: HairpinCase[];
  obstacles: ObstacleLevel[];
  palette: PaletteFixture;
  food: FoodFixture;
  powerups: PowerupFixture;
  story: StoryFixture;
  difficultyTable: DifficultyTableFixture;
}

interface StoryFixture {
  chapterSize: number;
  beatCount: number;
  chapterCount: number;
  prologue: { title: string; lines: string[]; speaker: string };
  epilogue: { title: string; lines: string[]; speaker: string };
  beats: {
    levelIndex: number;
    number: number;
    chapter: number;
    chapterTitle: string;
    title: string;
    intro: string[];
    outro: string[];
    speaker: string;
    isChapterStart: boolean;
    isChapterEnd: boolean;
  }[];
  chapters: {
    number: number;
    title: string;
    roman: string;
    blurb: string[];
    firstIndex: number;
    lastIndex: number;
    levelRange: [number, number];
    levelIndices: number[];
    contains: boolean[];
  }[];
  probes: number[];
  getBeat: number[];
  getChapter: number[];
  beatsInChapter: number[][];
  chapterStart: boolean[];
  chapterEnd: boolean[];
  validateProblems: string[];
}

interface DifficultyTableFixture {
  order: string[];
  default: string;
  skipNever: number;
  selfModes: string[];
  problems: string[];
  modes: {
    key: string;
    name: string;
    blurb: string;
    hud_label: string;
    rank: number;
    lives: number;
    color: [number, number, number];
    label: string;
    isDefault: boolean;
    self_mode: string;
    invuln_mult: number;
    speed_mult: number;
    turn_mult: number;
    self_skip_mult: number;
    self_depth_mult: number;
    hazard_speed_mult: number;
    powerup_rate_mult: number;
    food_value_mult: number;
    score_mult: number;
    combo_window_mult: number;
    star_target_mult: number;
    scoreForFood: number[];
    applyStarTargets: [number, number, number];
  }[];
}

const FX = fixture as unknown as Fixture;
const DT = FX.dt;

/**
 * Tolerance for a value accumulated over hundreds of floating point frames.
 *
 * Both languages use IEEE-754 doubles and the same operation order, so the
 * only legitimate source of drift is `Math.hypot` vs `math.hypot`, which are
 * separately-rounded implementations of the same function. 1e-9 is roughly a
 * thousand times looser than the observed drift and a billion times tighter
 * than any behavioural difference would be.
 */
const EPS = 1e-9;

/**
 * Structural comparison that is tolerant on numbers and exact on everything
 * else, so a nested `[x, y]` tip position is compared as two floats rather
 * than as a string (`0.1 + 0.2` prints differently in the two languages while
 * being the same double, and JSON.stringify would call that a failure).
 */
function deepNear(actual: unknown, expected: unknown, what: string, tol = 1e-9): void {
  if (typeof expected === "number") {
    if (typeof actual !== "number") {
      throw new Error(`${what}: expected a number, got ${JSON.stringify(actual)}`);
    }
    near(actual, expected, tol, what);
    return;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      throw new Error(`${what}: expected an array, got ${JSON.stringify(actual)}`);
    }
    expect(actual.length, `${what} length`).toBe(expected.length);
    expected.forEach((v, i) => deepNear(actual[i], v, `${what}[${i}]`, tol));
    return;
  }
  expect(actual, what).toEqual(expected);
}

/**
 * Pull a required number out of a fixture record.
 *
 * `noUncheckedIndexedAccess` types every record lookup as `number | undefined`,
 * and a missing constant should fail loudly as a broken fixture rather than
 * silently compare against `undefined`.
 */
function fixNum(rec: Record<string, number>, key: string): number {
  const v = rec[key];
  if (v === undefined) throw new Error(`fixture is missing the constant ${key}`);
  return v;
}

/** Assert `actual` matches the Python `expected` to within `tol`. */
function near(actual: number, expected: number, tol = EPS, what = ""): void {
  const delta = Math.abs(actual - expected);
  if (delta > tol) {
    throw new Error(
      `${what}: TypeScript ${actual} vs Python ${expected} (delta ${delta}, tol ${tol})`,
    );
  }
  expect(delta).toBeLessThanOrEqual(tol);
}

// ==========================================================================
// 1. config
// ==========================================================================
describe("parity: config constants", () => {
  it("every simulation constant matches snake/config.py exactly", () => {
    const cfg = FX.config as Record<string, number>;
    const mine: Record<string, number> = {
      ...(C as unknown as Record<string, number>),
      MIN_LENGTH,
      MAX_LENGTH,
    };
    const missing: string[] = [];
    const wrong: string[] = [];
    for (const [key, expected] of Object.entries(cfg)) {
      const got = mine[key];
      if (got === undefined) {
        missing.push(key);
      } else if (got !== expected) {
        wrong.push(`${key}: ts=${got} py=${expected}`);
      }
    }
    expect(missing).toEqual([]);
    expect(wrong).toEqual([]);
  });
});

// ==========================================================================
// 2. the snake trace
// ==========================================================================
describe("parity: snake trace, 600 scripted frames", () => {
  /** Replay the recorded script against the TypeScript snake. */
  function replay(): { snake: Snake; frames: TraceFrame[]; segs: Map<number, [number, number][]> } {
    const init = FX.snakeTrace.init;
    const s = new Snake(init.x, init.y, init.heading, init.length);
    s.speed = init.speed;

    const frames: TraceFrame[] = [];
    const segs = new Map<number, [number, number][]>();
    const wanted = new Set(FX.snakeTrace.segmentSamples.map((r) => r.frame));

    FX.snakeTrace.script.forEach((cmd, f) => {
      if (cmd.grow) s.grow(cmd.grow);
      if (cmd.tx === null || cmd.ty === null) s.clearTarget();
      else s.setTarget(cmd.tx, cmd.ty);
      s.update(cmd.dt, {
        boost: cmd.boost,
        speedMult: cmd.speedMult,
        turnMult: cmd.turnMult,
      });

      let lo = 0;
      let hi = 0;
      if (s.segments.length >= 2) {
        lo = Infinity;
        hi = 0;
        for (let i = 0; i < s.segments.length - 1; i++) {
          const a = s.segments[i];
          const b = s.segments[i + 1];
          if (a === undefined || b === undefined) continue;
          const g = Math.hypot(b.x - a.x, b.y - a.y);
          if (g < lo) lo = g;
          if (g > hi) hi = g;
        }
      }
      frames.push({
        x: s.x,
        y: s.y,
        heading: s.heading,
        currentSpeed: s.currentSpeed,
        turnRate: s.turnRate,
        turnInput: s.turnInput,
        bank: s.bank,
        boost: s.boost,
        boosting: s.boosting,
        distanceTravelled: s.distanceTravelled,
        targetLength: s.targetLength,
        segments: s.segments.length,
        path: s.path.length,
        minGap: lo,
        maxGap: hi,
        hitsSelf: s.hitsSelf(),
        crossingSelf: s.crossingSelf(),
      });
      if (wanted.has(f)) {
        segs.set(f, s.segments.map((p) => [p.x, p.y] as [number, number]));
      }
    });
    return { snake: s, frames, segs };
  }

  const run = replay();

  it("the fixture really is 600 frames of varied input", () => {
    expect(FX.snakeTrace.script.length).toBe(600);
    expect(FX.snakeTrace.frames.length).toBe(600);
    // the script must actually exercise the interesting paths
    expect(FX.snakeTrace.script.some((c) => c.dt > 0.04)).toBe(true);
    expect(FX.snakeTrace.script.some((c) => c.tx === null)).toBe(true);
    expect(FX.snakeTrace.script.some((c) => c.boost)).toBe(true);
    expect(FX.snakeTrace.script.some((c) => c.turnMult !== 1)).toBe(true);
  });

  it("head position and heading track Python every frame", () => {
    FX.snakeTrace.frames.forEach((want, f) => {
      const got = run.frames[f];
      expect(got).toBeDefined();
      if (got === undefined) return;
      near(got.x, want.x, 1e-8, `frame ${f} x`);
      near(got.y, want.y, 1e-8, `frame ${f} y`);
      near(got.heading, want.heading, 1e-9, `frame ${f} heading`);
    });
  });

  it("the boost economy and speed track Python every frame", () => {
    FX.snakeTrace.frames.forEach((want, f) => {
      const got = run.frames[f];
      if (got === undefined) return;
      near(got.currentSpeed, want.currentSpeed, 1e-9, `frame ${f} currentSpeed`);
      near(got.boost, want.boost, 1e-9, `frame ${f} boost`);
      expect(`${f}:${got.boosting}`).toBe(`${f}:${want.boosting}`);
    });
  });

  it("the steering signals (turnRate, turnInput, bank) track Python", () => {
    FX.snakeTrace.frames.forEach((want, f) => {
      const got = run.frames[f];
      if (got === undefined) return;
      near(got.turnRate, want.turnRate, 1e-9, `frame ${f} turnRate`);
      near(got.turnInput, want.turnInput, 1e-9, `frame ${f} turnInput`);
      near(got.bank, want.bank, 1e-9, `frame ${f} bank`);
    });
  });

  it("body length, path length and arc spacing track Python", () => {
    FX.snakeTrace.frames.forEach((want, f) => {
      const got = run.frames[f];
      if (got === undefined) return;
      expect(`${f}:${got.targetLength}`).toBe(`${f}:${want.targetLength}`);
      expect(`${f}:${got.segments}`).toBe(`${f}:${want.segments}`);
      expect(`${f}:${got.path}`).toBe(`${f}:${want.path}`);
      near(got.minGap, want.minGap, 1e-7, `frame ${f} minGap`);
      near(got.maxGap, want.maxGap, 1e-7, `frame ${f} maxGap`);
      near(
        got.distanceTravelled,
        want.distanceTravelled,
        1e-7,
        `frame ${f} distanceTravelled`,
      );
    });
  });

  it("hitsSelf and crossingSelf agree with Python on every frame", () => {
    const mismatches: string[] = [];
    FX.snakeTrace.frames.forEach((want, f) => {
      const got = run.frames[f];
      if (got === undefined) return;
      if (got.hitsSelf !== want.hitsSelf) {
        mismatches.push(`frame ${f} hitsSelf ts=${got.hitsSelf} py=${want.hitsSelf}`);
      }
      if (got.crossingSelf !== want.crossingSelf) {
        mismatches.push(
          `frame ${f} crossingSelf ts=${got.crossingSelf} py=${want.crossingSelf}`,
        );
      }
    });
    expect(mismatches).toEqual([]);
  });

  it("every sampled body segment sits where Python put it", () => {
    for (const sample of FX.snakeTrace.segmentSamples) {
      const got = run.segs.get(sample.frame);
      expect(got).toBeDefined();
      if (got === undefined) continue;
      expect(got.length).toBe(sample.segs.length);
      sample.segs.forEach((want, i) => {
        const p = got[i];
        if (p === undefined) throw new Error(`frame ${sample.frame} seg ${i} missing`);
        near(p[0], want[0], 1e-8, `frame ${sample.frame} seg ${i} x`);
        near(p[1], want[1], 1e-8, `frame ${sample.frame} seg ${i} y`);
      });
    }
  });
});

// ==========================================================================
// 3. U-turn width - the constant-radius steering claim
// ==========================================================================

/**
 * `tools/turn_test.py:measure_uturn`, ported.
 *
 * Settle onto a straight heading, then hand the snake a target 8000 px back
 * down its own line (nudged 1 px to the side so the reversal has an
 * unambiguous rotation direction) and track the head's offset perpendicular to
 * the original heading until the heading has accumulated pi radians of turn.
 */
function measureUTurn(
  cruise: number,
  speedMult = 1.0,
  turnMult = 1.0,
  boost = false,
): { width: number; radius: number; frames: number } {
  const s = new Snake(300.0, 400.0, 0.0, 30);
  s.speed = cruise;
  const opts = { boost, speedMult, turnMult };

  s.setTarget(6000.0, 400.0);
  for (let i = 0; i < 40; i++) s.update(DT, opts);

  const x0 = s.x;
  const y0 = s.y;
  const h0 = s.heading;
  s.setTarget(s.x - 8000.0, s.y + 1.0);

  let lo = 0;
  let hi = 0;
  let turned = 0;
  let previous = s.heading;
  let frames = 0;
  while (turned < Math.PI && frames < 4000) {
    s.update(DT, opts);
    // Python's `%` on a float is always non-negative for a positive divisor;
    // JavaScript's keeps the dividend's sign, so fold it the same way.
    const raw = (s.heading - previous + Math.PI) % (Math.PI * 2.0);
    const delta = (raw < 0 ? raw + Math.PI * 2.0 : raw) - Math.PI;
    turned += Math.abs(delta);
    previous = s.heading;
    const lateral = -Math.sin(h0) * (s.x - x0) + Math.cos(h0) * (s.y - y0);
    lo = Math.min(lo, lateral);
    hi = Math.max(hi, lateral);
    frames += 1;
  }
  const width = hi - lo;
  return { width, radius: width * 0.5, frames };
}

describe("parity: U-turn width vs speed", () => {
  it("reproduces every recorded U-turn case", () => {
    for (const want of FX.uturn) {
      const got = measureUTurn(want.cruise, want.speedMult, want.turnMult, want.boost);
      near(got.width, want.width, 1e-6, `${want.case} width`);
      near(got.radius, want.radius, 1e-6, `${want.case} radius`);
      expect(`${want.case}:${got.frames}`).toBe(`${want.case}:${want.frames}`);
    }
  });

  it("reproduces the headline constant-radius numbers", () => {
    // The three figures the port was commissioned to reproduce, measured the
    // way the game reaches them: a level cruise speed times its pace mult.
    const l1 = getLevel(0);
    const l6 = getLevel(5);
    const l12 = getLevel(11);
    near(measureUTurn(l1.cruiseSpeed, l1.speedMult).width, 40.0, 0.05, "L01 U-turn");
    near(measureUTurn(l6.cruiseSpeed, l6.speedMult).width, 40.0, 0.05, "L06 U-turn");
    near(measureUTurn(l12.cruiseSpeed, l12.speedMult).width, 52.5, 0.05, "L12 U-turn");
    // ...and the point of the rework: 525 px/s used to sweep ~194 px.
    expect(measureUTurn(l12.cruiseSpeed, l12.speedMult).width).toBeLessThan(194.5 / 3);
  });

  it("reproduces the whole level x difficulty matrix", () => {
    let worst = 0;
    let worstWhere = "-";
    for (const row of FX.uturnMatrix) {
      const lv = getLevel(row.index);
      near(lv.baseSpeed, row.baseSpeed, 1e-9, `L${row.index + 1} baseSpeed`);
      for (const key of D.ORDER) {
        const want = row.widths[key];
        expect(want).toBeDefined();
        if (want === undefined) continue;
        const diff = D.getDifficulty(key);
        const got = measureUTurn(
          lv.cruiseSpeed,
          lv.speedMult * diff.speedMult,
          diff.turnMult,
        ).width;
        near(got, want, 1e-6, `L${row.index + 1} ${key} U-turn`);
        if (got > worst) {
          worst = got;
          worstWhere = `L${row.index + 1} ${key}`;
        }
      }
    }
    // turn_test.py's WIDTH_BUDGET. Recorded here so a regression in the port
    // fails on the design budget as well as on parity.
    expect(worst, `worst U-turn ${worst.toFixed(1)} px at ${worstWhere}`).toBeLessThan(80);
  });
});

// ==========================================================================
// 4. level speed ramp
// ==========================================================================
describe("parity: level speed ramp", () => {
  it("cruise, pace and base speed match Python for all 12 levels", () => {
    expect(LEVELS.length).toBe(FX.speedRamp.length);
    FX.speedRamp.forEach((want) => {
      const lv = getLevel(want.index);
      expect(lv.name).toBe(want.name);
      near(lv.speedMult, want.speedMult, 1e-12, `L${want.index + 1} speedMult`);
      near(lv.cruiseSpeed, want.cruiseSpeed, 1e-12, `L${want.index + 1} cruiseSpeed`);
      near(lv.baseSpeed, want.baseSpeed, 1e-12, `L${want.index + 1} baseSpeed`);
      expect(lv.goalFood).toBe(want.goalFood);
      expect(lv.foodCount).toBe(want.foodCount);
      expect(lv.parScore).toBe(want.parScore);
      expect([...lv.starTargets]).toEqual(want.starTargets);
      expect(lv.wrapWalls).toBe(want.wrapWalls);
      expect(lv.powerupsEnabled).toBe(want.powerupsEnabled);
    });
  });

  it("a snake really travels the recorded distance in one simulated second", () => {
    FX.speedRamp.forEach((want) => {
      const lv = getLevel(want.index);
      const s = new Snake(600.0, 400.0, 0.0, 10);
      s.speed = lv.cruiseSpeed;
      s.clearTarget();
      for (let i = 0; i < 60; i++) s.update(DT, { speedMult: lv.speedMult });
      near(
        s.distanceTravelled,
        want.measuredTravel,
        1e-7,
        `L${want.index + 1} measured travel`,
      );
    });
  });

  it("the ramp is strictly monotonic, 210 -> 525.3 px/s", () => {
    const speeds = LEVELS.map((lv) => lv.baseSpeed);
    for (let i = 1; i < speeds.length; i++) {
      const a = speeds[i - 1];
      const b = speeds[i];
      if (a === undefined || b === undefined) continue;
      expect(b).toBeGreaterThan(a);
    }
    near(speeds[0] ?? 0, 210.0, 1e-9, "L01 base speed");
    near(speeds[speeds.length - 1] ?? 0, 525.3, 1e-9, "L12 base speed");
  });
});

// ==========================================================================
// 5. self-collision lethal bands
// ==========================================================================

/** A snake driven dead straight, so its body is a known ruler. */
function straightSnake(length = 40, speed = 240.0): Snake {
  const s = new Snake(300.0, 400.0, 0.0, length);
  s.speed = speed;
  s.clearTarget();
  for (let i = 0; i < 240; i++) s.update(DT);
  return s;
}

/**
 * Walk the head away from body segment `probeIndex` and find the offset at
 * which the hit stops being lethal.
 *
 * `update(0)` between probes bumps the internal scan tick - which is what
 * invalidates the memoised sweep - without moving anything, in both languages.
 */
function probeLethal(
  skip: number | undefined,
  depth: number | undefined,
  enabled: boolean,
  probeIndex = 20,
): { firstNonLethal: number | null; lethalProbes: number } {
  const s = straightSnake();
  const seg = s.segments[probeIndex];
  if (seg === undefined) throw new Error("probe segment missing");
  const sx = seg.x;
  const sy = seg.y;
  let lethalProbes = 0;
  let firstNonLethal: number | null = null;
  for (let i = 0; i < 400; i++) {
    const off = i * 0.05;
    s.x = sx;
    s.y = sy + off;
    s.update(0.0);
    const hit = s.hitsSelf({ skip, depth, enabled });
    if (hit) {
      lethalProbes += 1;
    } else {
      firstNonLethal = off;
      break;
    }
  }
  return { firstNonLethal, lethalProbes };
}

describe("parity: self-collision lethal bands", () => {
  it("difficulty knobs match Python exactly", () => {
    for (const want of FX.lethalBands) {
      if (want.difficulty === "_config_default") continue;
      const key = want.difficulty;
      expect(D.selfCollisionSkip(key)).toBe(want.skip);
      near(D.selfCollisionDepth(key), want.depth, 1e-12, `${key} depth`);
      expect(D.selfCollisionEnabled(key)).toBe(want.enabled);
      expect(D.livesFor(key)).toBe(want.lives);
      near(D.invulnSeconds(key), want.invuln, 1e-12, `${key} invuln`);
      if (want.comboWindow !== null) {
        near(D.comboWindow(key), want.comboWindow, 1e-12, `${key} comboWindow`);
      }
      if (want.powerupSpawnRange !== null) {
        const got = D.powerupSpawnRange(key);
        near(got[0], want.powerupSpawnRange[0], 1e-12, `${key} spawn lo`);
        near(got[1], want.powerupSpawnRange[1], 1e-12, `${key} spawn hi`);
      }
    }
  });

  it("the measured lethal radius matches Python for every mode", () => {
    for (const want of FX.lethalBands) {
      const isDefault = want.difficulty === "_config_default";
      const got = probeLethal(
        isDefault ? undefined : want.skip,
        isDefault ? undefined : want.depth,
        want.enabled,
      );
      expect(`${want.difficulty}:${got.lethalProbes}`).toBe(
        `${want.difficulty}:${want.lethalProbes}`,
      );
      if (want.firstNonLethal === null) {
        expect(got.firstNonLethal).toBeNull();
      } else {
        near(
          got.firstNonLethal ?? -1,
          want.firstNonLethal,
          1e-9,
          `${want.difficulty} first non-lethal offset`,
        );
      }
    }
  });

  it("easy mode is never lethal; the band widens with difficulty", () => {
    const byKey = new Map(FX.lethalBands.map((b) => [b.difficulty, b]));
    expect(byKey.get("easy")?.lethalProbes).toBe(0);
    const normal = byKey.get("normal")?.firstNonLethal ?? 0;
    const hard = byKey.get("hard")?.firstNonLethal ?? 0;
    const expert = byKey.get("expert")?.firstNonLethal ?? 0;
    expect(hard).toBeGreaterThan(normal);
    expect(expert).toBeGreaterThan(hard);
    // ...and all of them stay well inside the 13 px segment spacing, or a
    // straight body would kill itself.
    expect(expert).toBeLessThan(C.SNAKE_SEGMENT_SPACING);
  });
});

// ==========================================================================
// 6. hairpin: a legitimate 180 must stay survivable
// ==========================================================================
describe("parity: hairpin self-collision", () => {
  it("lethal and crossing frame counts match Python for every mode and speed", () => {
    for (const want of FX.hairpin) {
      const isDefault = want.difficulty === "_config_default";
      const skip = isDefault ? undefined : D.selfCollisionSkip(want.difficulty);
      const depth = isDefault ? undefined : D.selfCollisionDepth(want.difficulty);
      const enabled = isDefault ? true : D.selfCollisionEnabled(want.difficulty);

      const s = new Snake(600.0, 400.0, 0.0, 60);
      s.speed = Math.min(want.speed, C.SNAKE_MAX_SPEED);
      const mult = want.speed / s.speed;
      s.setTarget(600.0 - 900.0, 400.0 - 1.0);
      let lethal = 0;
      let crossing = 0;
      for (let i = 0; i < 360; i++) {
        s.update(DT, { speedMult: mult });
        if (s.hitsSelf({ skip, depth, enabled })) lethal += 1;
        if (s.crossingSelf()) crossing += 1;
      }
      const tag = `${want.difficulty}@${want.speed}`;
      expect(`${tag} lethal=${lethal}`).toBe(`${tag} lethal=${want.lethalFrames}`);
      expect(`${tag} crossing=${crossing}`).toBe(
        `${tag} crossing=${want.crossingFrames}`,
      );
    }
  });

  it("easy mode never dies to a hairpin but still reports the cross-over", () => {
    const easy = FX.hairpin.filter((h) => h.difficulty === "easy");
    expect(easy.length).toBeGreaterThan(0);
    for (const h of easy) {
      expect(h.lethalFrames).toBe(0);
      expect(h.crossingFrames).toBeGreaterThan(0);
    }
  });
});

// ==========================================================================
// 7. obstacles for all 12 levels
// ==========================================================================

/** Mirror of `port_parity.py:_state_of` - the animation state per hazard kind. */
function stateOf(ob: Obstacle): Record<string, unknown> {
  if (ob instanceof MovingBar) {
    const sp = ob.span();
    return {
      x: ob.x,
      y: ob.y,
      dir: ob.dir,
      axis: ob.axis,
      span: [sp.x, sp.y, sp.w, sp.h],
    };
  }
  if (ob instanceof Spinner) {
    return { angle: ob.angle, arms: ob.arms, tips: ob.tips().map((t) => [t[0], t[1]]) };
  }
  if (ob instanceof Pulsar) {
    return {
      radius: ob.radius,
      charge: ob.charge,
      threshold: ob.threshold,
      armed: ob.armed,
    };
  }
  if (ob instanceof LaserGate) {
    return { firing: ob.firing, warn: ob.warn, armed: ob.armed };
  }
  if (ob instanceof Portal) {
    return {
      spin: ob.spin,
      cooldown: ob.cooldown,
      secondary: ob.secondary,
      linked: ob.linked !== null,
      radius: ob.radius,
    };
  }
  if (ob instanceof WallBlock) {
    return { x: ob.x, y: ob.y, w: ob.w, h: ob.h };
  }
  return {};
}

/** Mirror of `port_parity.py:_probe_grid` - a compact collision fingerprint. */
function probeGrid(ob: Obstacle): string {
  const b = ob.bounds();
  const x0 = b.x - 30.0;
  const y0 = b.y - 30.0;
  const w = b.w + 60.0;
  const h = b.h + 60.0;
  const bits: string[] = [];
  for (const rad of [0.0, C.SNAKE_HEAD_RADIUS]) {
    for (let iy = 0; iy < 11; iy++) {
      for (let ix = 0; ix < 11; ix++) {
        const px = x0 + w * (ix / 10.0);
        const py = y0 + h * (iy / 10.0);
        bits.push(ob.collides(px, py, rad) ? "1" : "0");
      }
    }
  }
  return bits.join("");
}

/** Compare one hazard against its recorded Python snapshot. */
function compareSnapshot(ob: Obstacle, want: ObstacleSnapshot, tag: string): void {
  expect(`${tag} kind`).toBe(`${tag} kind`);
  expect(ob.kind, `${tag} kind`).toBe(want.kind);
  expect(ob.deadly, `${tag} deadly`).toBe(want.deadly);
  const b = ob.bounds();
  expect([b.x, b.y, b.w, b.h], `${tag} bounds`).toEqual(want.bounds);
  const a = ob.avoid();
  near(a[0], want.avoid[0], 1e-9, `${tag} avoid x`);
  near(a[1], want.avoid[1], 1e-9, `${tag} avoid y`);
  near(a[2], want.avoid[2], 1e-9, `${tag} avoid r`);

  const st = stateOf(ob);
  for (const [key, expected] of Object.entries(want.state)) {
    deepNear(st[key], expected, `${tag} state.${key}`);
  }
  expect(probeGrid(ob), `${tag} collision probes`).toBe(want.probes);
}

describe("parity: buildObstacles for all 12 levels", () => {
  const arena = { x: C.ARENA_X, y: C.ARENA_Y, w: C.ARENA_W, h: C.ARENA_H };

  it("builds the same hazards, in the same order, from the same specs", () => {
    for (const want of FX.obstacles) {
      const lv = getLevel(want.index);
      expect(lv.obstacleSpec.length, `L${want.index + 1} spec count`).toBe(
        want.specCount,
      );
      const obs = buildObstacles(lv.obstacleSpec, arena);
      expect(obs.length, `L${want.index + 1} obstacle count`).toBe(want.count);
      expect(obs.map((o) => o.kind), `L${want.index + 1} kinds`).toEqual(want.kinds);
    }
  });

  it("bounds, avoid circles, state and collisions match at t = 0", () => {
    for (const want of FX.obstacles) {
      const obs = buildObstacles(getLevel(want.index).obstacleSpec, arena);
      want.atT0.forEach((snap, i) => {
        const ob = obs[i];
        if (ob === undefined) throw new Error(`L${want.index + 1} hazard ${i} missing`);
        compareSnapshot(ob, snap, `L${want.index + 1}#${i}`);
      });
    }
  });

  it("animation state and collisions still match after 222 frames", () => {
    for (const want of FX.obstacles) {
      const obs = buildObstacles(getLevel(want.index).obstacleSpec, arena);
      let t = 0;
      for (let i = 0; i < 222; i++) {
        t += DT;
        updateObstacles(obs, DT, t);
      }
      near(t, want.t, 1e-12, `L${want.index + 1} elapsed t`);
      want.atT1.forEach((snap, i) => {
        const ob = obs[i];
        if (ob === undefined) throw new Error(`L${want.index + 1} hazard ${i} missing`);
        compareSnapshot(ob, snap, `L${want.index + 1}#${i}@t`);
      });
    }
  });

  it("portals are paired and linked exactly as Python pairs them", () => {
    for (const want of FX.obstacles) {
      const obs = buildObstacles(getLevel(want.index).obstacleSpec, arena);
      const portals = obs.filter((o): o is Portal => o instanceof Portal);
      expect(portals.length, `L${want.index + 1} portal count`).toBe(want.portalCount);
      expect(
        portals.map((p) => p.linked !== null),
        `L${want.index + 1} portal links`,
      ).toEqual(want.portalLinks);
    }
  });

  it("obstacleAvoidList matches the Python keep-out circles", () => {
    for (const want of FX.obstacles) {
      const obs = buildObstacles(getLevel(want.index).obstacleSpec, arena);
      const got = obstacleAvoidList(obs);
      expect(got.length).toBe(want.avoidList.length);
      got.forEach((a, i) => {
        const w = want.avoidList[i];
        if (w === undefined) return;
        near(a[0], w[0], 1e-9, `L${want.index + 1} avoid ${i} x`);
        near(a[1], w[1], 1e-9, `L${want.index + 1} avoid ${i} y`);
        near(a[2], w[2], 1e-9, `L${want.index + 1} avoid ${i} r`);
      });
    }
  });

  it("the campaign really contains 125 hazards and 12 portals", () => {
    const total = FX.obstacles.reduce((n, o) => n + o.count, 0);
    const portals = FX.obstacles.reduce((n, o) => n + o.portalCount, 0);
    expect(total).toBe(125);
    expect(portals).toBe(12);
    // ...and the port agrees, level by level
    let builtTotal = 0;
    for (const lv of LEVELS) builtTotal += buildObstacles(lv.obstacleSpec, arena).length;
    expect(builtTotal).toBe(total);
  });
});

// ==========================================================================
// 8. palette colour maths
// ==========================================================================
describe("parity: palette colour maths", () => {
  const P = FX.palette;

  it("clamp8 truncates exactly like Python's int()", () => {
    for (const [v, want] of P.clamp8) {
      expect(`clamp8(${v})=${palette.clamp8(v)}`).toBe(`clamp8(${v})=${want}`);
    }
  });

  it("lerpColor, shade and withAlpha match to the integer", () => {
    const a: palette.RGB = [12, 200, 90];
    const b: palette.RGB = [255, 30, 140];
    for (const [t, want] of P.lerpColor) {
      expect([...palette.lerpColor(a, b, t)], `lerpColor @${t}`).toEqual(want);
    }
    for (const [f, want] of P.shade) {
      expect([...palette.shade(a, f)], `shade @${f}`).toEqual(want);
    }
    for (const [al, want] of P.withAlpha) {
      expect([...palette.withAlpha(a, al)], `withAlpha @${al}`).toEqual(want);
    }
  });

  it("hsv, hueShift and rainbow match Python's colorsys to the integer", () => {
    for (const [h, want] of P.hsv) {
      expect([...palette.hsv(h, 0.8, 0.9)], `hsv @${h}`).toEqual(want);
    }
    const b: palette.RGB = [255, 30, 140];
    for (const [d, want] of P.hueShift) {
      expect([...palette.hueShift(b, d)], `hueShift @${d}`).toEqual(want);
    }
    for (const [t, want] of P.rainbow) {
      expect([...palette.rainbow(t, 0.72, 1.0)], `rainbow @${t}`).toEqual(want);
    }
  });

  it("every theme's body gradient matches Python at every stop", () => {
    expect(P.themes.length).toBe(LEVELS.length);
    P.themes.forEach((want, i) => {
      const th = getLevel(i).theme;
      expect(th.name, `theme ${i} name`).toBe(want.name);
      for (const [t, rgb] of want.bodyAt) {
        expect([...palette.bodyAt(th, t)], `theme ${i} bodyAt(${t})`).toEqual(rgb);
      }
    });
  });

  it("the UI palette matches palette.py", () => {
    expect([...palette.UI_WHITE]).toEqual(P.ui.UI_WHITE);
    expect([...palette.UI_GOLD]).toEqual(P.ui.UI_GOLD);
    expect([...palette.UI_DIM]).toEqual(P.ui.UI_DIM);
    expect([...palette.UI_GOOD]).toEqual(P.ui.UI_GOOD);
    expect([...palette.UI_WARN]).toEqual(P.ui.UI_WARN);
    expect([...palette.UI_BAD]).toEqual(P.ui.UI_BAD);
    expect([...palette.UI_PANEL]).toEqual(P.ui.UI_PANEL);
    expect([...palette.UI_PANEL_LIGHT]).toEqual(P.ui.UI_PANEL_LIGHT);
  });
});

// ==========================================================================
// 9. food - the RNG-free half
// ==========================================================================
describe("parity: food", () => {
  const FD = FX.food;

  it("the kind table and tuning constants match food.py", () => {
    for (const [kind, spec] of Object.entries(FD.kinds)) {
      const got = food.FOOD_KINDS[kind as food.FoodKind];
      expect(got, `FOOD_KINDS.${kind}`).toBeDefined();
      if (got === undefined) continue;
      near(got.value, spec.value, 0, `${kind} value`);
      near(got.radius, spec.radius, 1e-12, `${kind} radius`);
      near(got.ttl, spec.ttl, 1e-12, `${kind} ttl`);
      near(got.grow, spec.grow, 0, `${kind} grow`);
    }
    const k = FD.constants;
    near(food.BOB_SPEED, fixNum(k, "BOB_SPEED"), 0, "BOB_SPEED");
    near(food.BOB_AMOUNT, fixNum(k, "BOB_AMOUNT"), 0, "BOB_AMOUNT");
    near(food.PULSE_AMOUNT, fixNum(k, "PULSE_AMOUNT"), 0, "PULSE_AMOUNT");
    near(food.POP_IN_TIME, fixNum(k, "POP_IN_TIME"), 0, "POP_IN_TIME");
    near(food.BLINK_LEAD, fixNum(k, "BLINK_LEAD"), 0, "BLINK_LEAD");
    near(food.SPAWN_MARGIN, fixNum(k, "SPAWN_MARGIN"), 1e-12, "SPAWN_MARGIN");
    near(food.MIN_FOOD_SEPARATION, fixNum(k, "MIN_FOOD_SEPARATION"), 1e-12, "MIN_FOOD_SEPARATION");
    expect(food.SPAWN_TRIES).toBe(fixNum(k, "SPAWN_TRIES"));
  });

  it("every derived orb quantity matches Python on the whole time grid", () => {
    for (const want of FD.orbs) {
      const orb: food.Food = {
        x: 400.0,
        y: 300.0,
        kind: want.kind as food.FoodKind,
        value: want.value,
        radius: want.radius,
        born: want.born,
        ttl: want.ttl,
        grow: want.grow,
        color: [255, 255, 255],
        phase: want.phase,
        spin: want.spin,
        dead: false,
      };
      const tag = `${want.kind}/phase${want.phase}`;
      expect(food.perishable(orb), `${tag} perishable`).toBe(want.perishable);
      near(food.pickupRadius(orb), want.pickupRadius, 1e-12, `${tag} pickupRadius`);

      const probes: [number, number, number][] = [
        [400.0, 300.0, 0.0],
        [410.0, 300.0, 0.0],
        [420.0, 300.0, 0.0],
        [400.0, 330.0, 13.0],
        [440.0, 340.0, 13.0],
      ];
      probes.forEach((p, i) => {
        expect(food.overlaps(orb, p[0], p[1], p[2]), `${tag} overlaps[${i}]`).toBe(
          want.overlaps[i],
        );
      });

      for (const fr of want.frames) {
        const at = `${tag} @t=${fr.t}`;
        near(food.age(orb, fr.t), fr.age, 1e-12, `${at} age`);
        const left = food.remaining(orb, fr.t);
        if (fr.remaining === null) {
          expect(left, `${at} remaining is infinite`).toBe(Infinity);
        } else {
          near(left, fr.remaining, 1e-12, `${at} remaining`);
        }
        expect(food.expired(orb, fr.t), `${at} expired`).toBe(fr.expired);
        near(food.bobOffset(orb, fr.t), fr.bobOffset, 1e-12, `${at} bobOffset`);
        const dp = food.drawPos(orb, fr.t);
        near(dp.x, fr.drawPos[0], 1e-12, `${at} drawPos.x`);
        near(dp.y, fr.drawPos[1], 1e-12, `${at} drawPos.y`);
        near(food.drawRadius(orb, fr.t), fr.drawRadius, 1e-12, `${at} drawRadius`);
        expect(food.visible(orb, fr.t), `${at} visible`).toBe(fr.visible);
      }
    }
  });

  it("foodColor matches Python for every theme, kind and time", () => {
    for (const want of FD.colours) {
      const theme = want.level === null ? null : getLevel(want.level).theme;
      const tag = want.level === null ? "no-theme" : `L${want.level + 1}`;
      FD.times.forEach((t, i) => {
        expect([...food.foodColor("normal", theme, t)], `${tag} normal @${t}`)
          .toEqual(want.normal[i]);
        expect([...food.foodColor("bonus", theme, t)], `${tag} bonus @${t}`)
          .toEqual(want.bonus[i]);
        expect([...food.foodColor("mega", theme, t)], `${tag} mega @${t}`)
          .toEqual(want.mega[i]);
      });
    }
  });
});

// ==========================================================================
// 10. power-ups - the RNG-free half
// ==========================================================================
describe("parity: power-ups", () => {
  const PW = FX.powerups;

  it("the type table and tuning constants match powerups.py", () => {
    expect(Object.keys(powerups.POWERUP_TYPES)).toEqual(PW.kinds);
    for (const kind of PW.kinds) {
      const info = powerups.powerupInfo(kind);
      const want = PW.types[kind];
      if (want === undefined) continue;
      expect(info.name, `${kind} name`).toBe(want.name);
      near(powerups.powerupDuration(kind), want.duration, 1e-12, `${kind} duration`);
      expect([...powerups.powerupColor(kind)], `${kind} colour`).toEqual(want.color);
    }
    const k = PW.constants;
    near(powerups.MAGNET_RADIUS, fixNum(k, "MAGNET_RADIUS"), 0, "MAGNET_RADIUS");
    near(powerups.MAGNET_STRENGTH, fixNum(k, "MAGNET_STRENGTH"), 0, "MAGNET_STRENGTH");
    near(powerups.SLOW_SPEED_MULT, fixNum(k, "SLOW_SPEED_MULT"), 0, "SLOW_SPEED_MULT");
    near(powerups.SLOW_TURN_MULT, fixNum(k, "SLOW_TURN_MULT"), 0, "SLOW_TURN_MULT");
    near(powerups.FRENZY_SPEED_MULT, fixNum(k, "FRENZY_SPEED_MULT"), 0, "FRENZY_SPEED_MULT");
    expect(powerups.FRENZY_EXTRA_FOOD).toBe(fixNum(k, "FRENZY_EXTRA_FOOD"));
    expect(powerups.DOUBLE_SCORE_MULT).toBe(fixNum(k, "DOUBLE_SCORE_MULT"));
    expect(powerups.MAX_ACTIVE).toBe(fixNum(k, "MAX_ACTIVE"));
    near(powerups.POP_IN_TIME, fixNum(k, "POP_IN_TIME"), 0, "POP_IN_TIME");
    near(powerups.BLINK_LEAD, fixNum(k, "BLINK_LEAD"), 0, "BLINK_LEAD");
    near(powerups.CORE_PULSE_SPEED, fixNum(k, "CORE_PULSE_SPEED"), 0, "CORE_PULSE_SPEED");
  });

  it("rune brightness, radius and pickup maths match Python", () => {
    for (const want of PW.runes) {
      const p: powerups.PowerUp = {
        x: 500.0,
        y: 350.0,
        kind: want.kind,
        born: 0.0,
        ttl: want.ttl,
        radius: want.radius,
        age: 0.0,
        phase: want.phase,
        spin: want.spin,
      };
      const tag = `${want.kind}/phase${want.phase}`;
      expect([...powerups.powerupColor(p.kind)], `${tag} colour`).toEqual(want.colour);
      near(powerups.powerUpDuration(p), want.duration, 1e-12, `${tag} duration`);
      near(powerups.powerUpPickupRadius(p), want.pickupRadius, 1e-12,
        `${tag} pickupRadius`);
      const probes: [number, number, number][] = [
        [500.0, 350.0, 0.0],
        [515.0, 350.0, 0.0],
        [530.0, 350.0, 0.0],
        [500.0, 380.0, 13.0],
      ];
      probes.forEach((q, i) => {
        expect(powerups.powerUpOverlaps(p, q[0], q[1], q[2]), `${tag} overlaps[${i}]`)
          .toBe(want.overlaps[i]);
      });
      for (const fr of want.frames) {
        p.age = fr.age;
        const at = `${tag} @age=${fr.age}`;
        near(powerups.powerUpAge(p), fr.age, 1e-12, `${at} age`);
        near(powerups.powerUpRemaining(p), fr.remaining, 1e-12, `${at} remaining`);
        expect(powerups.powerUpExpired(p), `${at} expired`).toBe(fr.expired);
        near(powerups.powerUpBrightness(p), fr.brightness, 1e-12, `${at} brightness`);
        near(powerups.powerUpDrawRadius(p), fr.drawRadius, 1e-12, `${at} drawRadius`);
      }
    }
  });

  it("a 420-frame ActiveEffects session matches Python frame for frame", () => {
    const eff = new powerups.ActiveEffects();
    const plan: [number, string, string, number | null][] = [
      [0, "add", "slow", null],
      [0, "add", "double", null],
      [12, "add", "frenzy", null],
      [20, "add", "magnet", null],
      [30, "add", "shield", null],
      [44, "add", "slow", null],
      [60, "consume", "shield", null],
      [75, "add", "ghost", 2.5],
      [110, "remove", "double", null],
    ];
    PW.effects.forEach((want, f) => {
      for (const [at, op, kind, dur] of plan) {
        if (at !== f) continue;
        if (op === "add") eff.add(kind, dur === null ? undefined : dur);
        else if (op === "remove") eff.remove(kind);
        else if (op === "consume") eff.consume(kind);
      }
      const expired = eff.update(DT);
      expect(expired, `frame ${f} expired`).toEqual(want.expired);
      expect(eff.size, `frame ${f} size`).toBe(want.size);
      const items = eff.items();
      expect(items.length, `frame ${f} item count`).toBe(want.items.length);
      items.forEach((kv, i) => {
        const w = want.items[i];
        if (w === undefined) return;
        expect(kv[0], `frame ${f} item ${i} kind`).toBe(w[0]);
        near(kv[1], w[1], 1e-9, `frame ${f} item ${i} seconds`);
      });
      expect(eff.scoreMultiplier(), `frame ${f} scoreMult`).toBe(want.scoreMult);
      near(eff.speedMultiplier(), want.speedMult, 1e-12, `frame ${f} speedMult`);
      near(eff.turnMultiplier(), want.turnMult, 1e-12, `frame ${f} turnMult`);
      near(eff.magnetRadius(), want.magnetRadius, 1e-12, `frame ${f} magnetRadius`);
      expect(eff.extraFood(), `frame ${f} extraFood`).toBe(want.extraFood);
      for (const kind of PW.kinds) {
        const w = want.fractions[kind];
        if (w === undefined) continue;
        near(eff.fraction(kind), w, 1e-9, `frame ${f} fraction(${kind})`);
      }
    });
  });

  it("the scripted session really exercises overlapping effects", () => {
    expect(PW.effects.some((rec) => rec.size >= 3)).toBe(true);
    expect(PW.effects.some((rec) => rec.expired.length > 0)).toBe(true);
    expect(PW.effects.some((rec) => rec.scoreMult > 1)).toBe(true);
    expect(PW.effects.some((rec) => rec.speedMult < 1)).toBe(true);
    expect(PW.effects.some((rec) => rec.magnetRadius > 0)).toBe(true);
  });
});

// ==========================================================================
// 11. story
// ==========================================================================
describe("parity: story", () => {
  const ST = FX.story;

  it("the beat and chapter tables match story.py entry for entry", () => {
    expect(story.CHAPTER_SIZE).toBe(ST.chapterSize);
    expect(story.BEAT_COUNT).toBe(ST.beatCount);
    expect(story.CHAPTER_COUNT).toBe(ST.chapterCount);

    const beats = story.allBeats();
    expect(beats.length).toBe(ST.beats.length);
    ST.beats.forEach((want, i) => {
      const got = beats[i];
      if (got === undefined) throw new Error(`beat ${i} missing`);
      expect(got.levelIndex, `beat ${i} levelIndex`).toBe(want.levelIndex);
      expect(got.chapter, `beat ${i} chapter`).toBe(want.chapter);
      expect(got.chapterTitle, `beat ${i} chapterTitle`).toBe(want.chapterTitle);
      expect(got.title, `beat ${i} title`).toBe(want.title);
      expect([...got.intro], `beat ${i} intro`).toEqual(want.intro);
      expect([...got.outro], `beat ${i} outro`).toEqual(want.outro);
      expect(got.speaker, `beat ${i} speaker`).toBe(want.speaker);
    });

    expect(story.CHAPTERS.length).toBe(ST.chapters.length);
    ST.chapters.forEach((want, i) => {
      const got = story.CHAPTERS[i];
      if (got === undefined) throw new Error(`chapter ${i} missing`);
      expect(got.number, `chapter ${i} number`).toBe(want.number);
      expect(got.title, `chapter ${i} title`).toBe(want.title);
      expect([...got.blurb], `chapter ${i} blurb`).toEqual(want.blurb);
      expect(got.firstIndex, `chapter ${i} firstIndex`).toBe(want.firstIndex);
      expect(got.lastIndex, `chapter ${i} lastIndex`).toBe(want.lastIndex);
      expect(got.roman(), `chapter ${i} roman`).toBe(want.roman);
      expect([...got.levelRange()], `chapter ${i} levelRange`).toEqual(want.levelRange);
      expect([...got.levelIndices()], `chapter ${i} levelIndices`)
        .toEqual(want.levelIndices);
      ST.probes.forEach((p, j) => {
        expect(got.contains(p), `chapter ${i} contains(${p})`).toBe(want.contains[j]);
      });
    });
  });

  it("the prologue and epilogue cards match", () => {
    expect(story.PROLOGUE.title).toBe(ST.prologue.title);
    expect([...story.PROLOGUE.lines]).toEqual(ST.prologue.lines);
    expect(story.PROLOGUE.speaker).toBe(ST.prologue.speaker);
    expect(story.EPILOGUE.title).toBe(ST.epilogue.title);
    expect([...story.EPILOGUE.lines]).toEqual(ST.epilogue.lines);
    expect(story.EPILOGUE.speaker).toBe(ST.epilogue.speaker);
  });

  it("every lookup is total and agrees with Python far outside the valid range", () => {
    ST.probes.forEach((p, i) => {
      expect(story.getBeat(p).levelIndex, `getBeat(${p})`).toBe(ST.getBeat[i]);
      expect(story.getChapter(p).number, `getChapter(${p})`).toBe(ST.getChapter[i]);
      expect(
        story.beatsInChapter(p).map((b) => b.levelIndex),
        `beatsInChapter(${p})`,
      ).toEqual(ST.beatsInChapter[i]);
      expect(story.chapterStart(p), `chapterStart(${p})`).toBe(ST.chapterStart[i]);
      expect(story.chapterEnd(p), `chapterEnd(${p})`).toBe(ST.chapterEnd[i]);
    });
  });

  it("validateStory reports exactly what Python reports", () => {
    expect(story.validateStory()).toEqual(ST.validateProblems);
  });
});

// ==========================================================================
// 12. the full difficulty table
// ==========================================================================
describe("parity: difficulty table", () => {
  const DT_ = FX.difficultyTable;

  it("order, defaults and self-mode vocabulary match difficulty.py", () => {
    expect([...D.ORDER]).toEqual(DT_.order);
    expect(D.DEFAULT.key).toBe(DT_.default);
    expect(D.SKIP_NEVER).toBe(DT_.skipNever);
    expect([...D.SELF_MODES]).toEqual(DT_.selfModes);
  });

  it("every field of every mode matches Python", () => {
    DT_.modes.forEach((want) => {
      const d = D.getDifficulty(want.key);
      const at = (f: string) => `${want.key}.${f}`;
      expect(d.key, at("key")).toBe(want.key);
      expect(d.name, at("name")).toBe(want.name);
      expect(d.blurb, at("blurb")).toBe(want.blurb);
      expect(d.hudLabel, at("hudLabel")).toBe(want.hud_label);
      expect(d.rank, at("rank")).toBe(want.rank);
      expect(d.lives, at("lives")).toBe(want.lives);
      expect([...d.color], at("color")).toEqual(want.color);
      expect(d.selfMode, at("selfMode")).toBe(want.self_mode);
      near(d.invulnMult, want.invuln_mult, 1e-12, at("invulnMult"));
      near(d.speedMult, want.speed_mult, 1e-12, at("speedMult"));
      near(d.turnMult, want.turn_mult, 1e-12, at("turnMult"));
      near(d.selfSkipMult, want.self_skip_mult, 1e-12, at("selfSkipMult"));
      near(d.selfDepthMult, want.self_depth_mult, 1e-12, at("selfDepthMult"));
      near(d.hazardSpeedMult, want.hazard_speed_mult, 1e-12, at("hazardSpeedMult"));
      near(d.powerupRateMult, want.powerup_rate_mult, 1e-12, at("powerupRateMult"));
      near(d.foodValueMult, want.food_value_mult, 1e-12, at("foodValueMult"));
      near(d.scoreMult, want.score_mult, 1e-12, at("scoreMult"));
      near(d.comboWindowMult, want.combo_window_mult, 1e-12, at("comboWindowMult"));
      near(d.starTargetMult, want.star_target_mult, 1e-12, at("starTargetMult"));
      expect(D.label(want.key), at("label")).toBe(want.label);
      expect(D.isDefault(want.key), at("isDefault")).toBe(want.isDefault);
    });
  });

  it("scoreForFood and applyStarTargets match Python across a grid", () => {
    DT_.modes.forEach((want) => {
      const got: number[] = [];
      for (const base of [0, 1, 10, 25, 100]) {
        for (const mult of [0.0, 1.0, 2.5]) {
          got.push(D.scoreForFood(want.key, base, mult));
        }
      }
      expect(got, `${want.key} scoreForFood grid`).toEqual(want.scoreForFood);
      expect(
        [...D.applyStarTargets(want.key, [100, 135, 175])],
        `${want.key} applyStarTargets`,
      ).toEqual(want.applyStarTargets);
    });
  });

  it("the table self-check reports exactly what Python reports", () => {
    expect(D.checkDifficultyTable()).toEqual(DT_.problems);
    expect([...D.TABLE_PROBLEMS]).toEqual(DT_.problems);
  });
});
