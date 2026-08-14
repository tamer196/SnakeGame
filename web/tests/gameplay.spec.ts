/**
 * The rules of a level, driven headlessly.
 *
 * `GameplayWorld` deliberately imports no renderer, so the whole gameplay
 * pipeline can be played here at speed: clocks, pickups, scoring, damage and
 * end-of-run bookkeeping, with a recording presenter standing in for the
 * particles and sound. This is the web counterpart of what `tools/playtest.py`
 * does to the Python build.
 *
 * The cases below are chosen for the mistakes that are silent: a clock wired to
 * the wrong source, a difficulty snapshot read late, slow motion leaking into
 * the interface, a loss quietly unlocking the next level.
 */

import { beforeEach, describe, expect, it } from "vitest";

import * as C from "../src/core/config";
import { GameplayWorld, HEAD_HIT_R, READY_TIME } from "../src/game/GameplayWorld";
import { RecordingPresenter } from "../src/game/presenter";
import { SaveData } from "../src/core/save";
import { getLevel } from "../src/core/level";
import {
  comboWindow,
  getDifficulty,
  livesFor,
  powerupSpawnRange,
} from "../src/core/difficulty";

/** A world on a given level, already past the countdown unless asked otherwise. */
function makeWorld(
  levelIndex = 0,
  difficulty = "normal",
  mode: string = C.MODE_FREE,
): { world: GameplayWorld; fx: RecordingPresenter; save: SaveData } {
  const save = new SaveData("test-profile");
  const fx = new RecordingPresenter();
  const world = new GameplayWorld({ save, presenter: fx, seed: 0x1234 });
  world.enter({ levelIndex, difficulty, mode });
  return { world, fx, save };
}

/** Run the countdown out so the snake starts moving. */
function skipReady(world: GameplayWorld, fx: RecordingPresenter): void {
  const pointer = { x: 640, y: 392, boost: false };
  let guard = 0;
  while (world.readyTimer > 0 && guard++ < 500) world.update(1 / 60, pointer);
  fx.reset();
}

const POINTER = { x: 640, y: 392, boost: false };

describe("GameplayWorld: construction", () => {
  it("starts in the countdown with a full complement of lives", () => {
    const { world } = makeWorld(0, "hard");
    expect(world.readyTimer).toBeCloseTo(READY_TIME, 6);
    expect(world.lives).toBe(livesFor(getDifficulty("hard")));
    expect(world.score).toBe(0);
    expect(world.finished).toBe(false);
    expect(world.snake.alive).toBe(true);
  });

  it("spawns the snake at the arena centre facing somewhere it can actually go", () => {
    // Level 12 is the busiest; a naive fixed heading spawns into geometry.
    const { world } = makeWorld(11);
    expect(world.snake.x).toBeCloseTo(C.ARENA_X + C.ARENA_W / 2, 6);
    expect(world.snake.y).toBeCloseTo(C.ARENA_Y + C.ARENA_H / 2, 6);
    expect(Number.isFinite(world.snake.heading)).toBe(true);
  });

  it("carries cruise x difficulty in snake.speed and leaves the pace multiplier out", () => {
    // Folding level.speedMult in here would flatten the campaign's ramp, and
    // nothing else would complain.
    const { world } = makeWorld(9, "hard");
    const level = getLevel(9);
    expect(world.snake.speed).toBeCloseTo(level.cruiseSpeed * getDifficulty("hard").speedMult, 6);
    expect(level.speedMult).toBeGreaterThan(1);
  });

  it("applies the difficulty's power-up cadence to the rune field", () => {
    for (const key of ["easy", "expert"]) {
      const { world } = makeWorld(3, key);
      expect(world.runes.spawnRange()).toEqual(powerupSpawnRange(getDifficulty(key)));
    }
    // Easy really is more generous than Expert, not just differently seeded.
    const easy = powerupSpawnRange(getDifficulty("easy"));
    const expert = powerupSpawnRange(getDifficulty("expert"));
    expect(easy[0]).toBeLessThan(expert[0]);
  });

  it("fully resets when the same instance re-enters a level", () => {
    const { world, fx } = makeWorld(0);
    skipReady(world, fx);
    world.score = 999;
    world.foodEaten = 7;
    world.combo = 5;
    world.popups.push({
      x: 0, y: 0, vy: 0, life: 1, maxLife: 1, text: "stale", color: [255, 255, 255], big: false,
    });

    world.enter({ levelIndex: 0, difficulty: "normal", mode: C.MODE_FREE });
    expect(world.score).toBe(0);
    expect(world.foodEaten).toBe(0);
    expect(world.combo).toBe(0);
    expect(world.popups).toHaveLength(0);
    expect(world.readyTimer).toBeCloseTo(READY_TIME, 6);
  });
});

describe("GameplayWorld: the four clocks", () => {
  it("freezes the snake during the countdown but keeps the world breathing", () => {
    const { world } = makeWorld(0);
    const before = { x: world.snake.x, y: world.snake.y };
    for (let i = 0; i < 30; i++) world.update(1 / 60, POINTER);
    expect(world.readyTimer).toBeGreaterThan(0);
    expect(world.snake.x).toBeCloseTo(before.x, 6);
    expect(world.snake.y).toBeCloseTo(before.y, 6);
    // Food and hazards still animate, so the level does not look frozen.
    expect(world.clockT).toBeGreaterThan(0);
    expect(world.elapsed).toBe(0);
  });

  it("plays the start cue exactly once, when the countdown lands", () => {
    const { world, fx } = makeWorld(0);
    let guard = 0;
    while (world.readyTimer > 0 && guard++ < 500) world.update(1 / 60, POINTER);
    expect(fx.cues().filter((c) => c === "start")).toHaveLength(1);
    expect(world.goTimer).toBeGreaterThan(0);
  });

  it("runs the hazard clock at its own rate, not the food clock's", () => {
    // Crossing these two is silent and looks almost right.
    const { world, fx } = makeWorld(5, "expert");
    skipReady(world, fx);
    const mult = Math.max(0.05, getDifficulty("expert").hazardSpeedMult);
    const c0 = world.clockT;
    const h0 = world.hazardT;
    for (let i = 0; i < 60; i++) world.update(1 / 60, POINTER);
    const dc = world.clockT - c0;
    const dh = world.hazardT - h0;
    expect(dc).toBeGreaterThan(0);
    expect(dh / dc).toBeCloseTo(mult, 5);
    if (mult !== 1) expect(world.hazardT).not.toBeCloseTo(world.clockT, 3);
  });

  it("slows the simulation but never the interface", () => {
    const { world, fx } = makeWorld(0);
    skipReady(world, fx);
    fx.setTimeScale(0.25);

    const c0 = world.clockT;
    const e0 = world.elapsed;
    const steps = 30;
    for (let i = 0; i < steps; i++) world.update(1 / 60, POINTER);

    // Sim clocks advance at a quarter rate...
    expect(world.clockT - c0).toBeCloseTo((steps / 60) * 0.25, 4);
    expect(world.elapsed - e0).toBeCloseTo((steps / 60) * 0.25, 4);

    // ...while a popup, which lives on real time, does not.
    fx.setTimeScale(1);
    world.enter({ levelIndex: 0, difficulty: "normal", mode: C.MODE_FREE });
    skipReady(world, fx);
    fx.setTimeScale(0.25);
    world.popups.push({
      x: 0, y: 0, vy: 0, life: 1.0, maxLife: 1.0, text: "t", color: [255, 255, 255], big: false,
    });
    for (let i = 0; i < steps; i++) world.update(1 / 60, POINTER);
    const p = world.popups[0];
    expect(p).toBeDefined();
    expect(p!.life).toBeCloseTo(1.0 - steps / 60, 4);
  });

  it("clamps a long stall rather than catching up", () => {
    const { world, fx } = makeWorld(0);
    skipReady(world, fx);
    const c0 = world.clockT;
    world.update(5.0, POINTER); // a five second hitch
    expect(world.clockT - c0).toBeCloseTo(C.MAX_DT, 6);
  });
});

describe("GameplayWorld: scoring", () => {
  /** Drop an orb right on the snake's nose and let the pickup pass find it. */
  function feed(world: GameplayWorld, kind: "normal" | "bonus" = "normal"): void {
    const orb = world.food.spawn(kind);
    if (!orb) throw new Error("could not place a test orb");
    orb.x = world.snake.x;
    orb.y = world.snake.y;
  }

  let world: GameplayWorld;
  let fx: RecordingPresenter;
  let save: SaveData;

  beforeEach(() => {
    ({ world, fx, save } = makeWorld(0));
    skipReady(world, fx);
  });

  it("scores an orb, grows the snake and announces it", () => {
    const lengthBefore = world.snake.targetLength;
    feed(world);
    world.update(1 / 60, POINTER);

    expect(world.foodEaten).toBe(1);
    expect(world.score).toBeGreaterThan(0);
    expect(world.combo).toBe(1);
    expect(world.snake.targetLength).toBeGreaterThan(lengthBefore);
    expect(fx.cues()).toContain("eat");
    expect(fx.of("burst")).toHaveLength(1);
    expect(world.popups).toHaveLength(1);
    expect(world.popups[0]!.text).toMatch(/^\+\d+/);
    expect(save.totalFood).toBe(1);
  });

  it("escalates the combo while pickups stay inside the window, and caps it", () => {
    for (let i = 0; i < C.COMBO_MAX + 3; i++) {
      feed(world);
      world.update(1 / 60, POINTER);
    }
    expect(world.combo).toBe(C.COMBO_MAX);
    expect(world.maxCombo).toBe(C.COMBO_MAX);
  });

  it("pays more for a combo than for the same orbs eaten cold", () => {
    feed(world);
    world.update(1 / 60, POINTER);
    const first = world.score;
    feed(world);
    world.update(1 / 60, POINTER);
    const second = world.score - first;
    expect(second).toBeGreaterThan(first);
  });

  it("drops the combo once the window lapses", () => {
    feed(world);
    world.update(1 / 60, POINTER);
    expect(world.combo).toBe(1);
    const steps = Math.ceil((comboWindow(getDifficulty("normal")) + 0.5) / C.MAX_DT);
    for (let i = 0; i < steps; i++) world.update(C.MAX_DT, POINTER);
    expect(world.combo).toBe(0);
  });

  it("treats a special orb as an event, not just more points", () => {
    feed(world, "bonus");
    world.update(1 / 60, POINTER);
    expect(fx.cues()).toContain("bonus");
    expect(fx.of("flash").length).toBeGreaterThan(0);
    expect(fx.of("shake").length).toBeGreaterThan(0);
  });
});

describe("GameplayWorld: damage and the end of a run", () => {
  /**
   * The first level whose arena boundary is lethal.
   *
   * The first three stages all wrap: the campaign's "solid walls" on stage 2
   * are monolith obstacles inside the arena, not the edge of it.
   */
  const SOLID = 3;

  /** Shove the head through the arena wall. */
  function drive(world: GameplayWorld, into: "wall"): void {
    void into;
    world.snake.teleport(C.ARENA_X - HEAD_HIT_R - 4, C.ARENA_Y + C.ARENA_H / 2);
  }

  it("spends a life, shrinks the snake and rescues the head from the wall", () => {
    const { world, fx } = makeWorld(SOLID);
    skipReady(world, fx);
    const lives = world.lives;
    const length = world.snake.targetLength;

    drive(world, "wall");
    world.update(1 / 60, POINTER);

    expect(world.lives).toBe(lives - 1);
    expect(world.snake.targetLength).toBeLessThan(length);
    expect(world.snake.invuln).toBeGreaterThan(0);
    expect(fx.cues()).toContain("hit");
    // The head must not be left inside the wall, or mercy expires straight
    // back into the same collision and eats every remaining life.
    expect(world.snake.x).toBeGreaterThanOrEqual(C.ARENA_X);
  });

  it("wraps instead of hurting on the wrap-walls level", () => {
    const { world, fx } = makeWorld(0);
    skipReady(world, fx);
    expect(getLevel(0).wrapWalls).toBe(true);
    const lives = world.lives;

    world.snake.teleport(C.ARENA_X - HEAD_HIT_R - 4, C.ARENA_Y + C.ARENA_H / 2);
    world.update(1 / 60, POINTER);

    expect(world.lives).toBe(lives);
    expect(world.snake.x).toBeGreaterThan(C.ARENA_X + C.ARENA_W / 2);
  });

  it("spends a shield instead of a life, and only once", () => {
    const { world, fx } = makeWorld(SOLID);
    skipReady(world, fx);
    world.effects.add("shield");
    const lives = world.lives;

    drive(world, "wall");
    world.update(1 / 60, POINTER);

    expect(world.lives).toBe(lives);
    expect(world.effects.has("shield")).toBe(false);
    expect(world.popups.some((p) => p.text.includes("SHIELD"))).toBe(true);
  });

  it("ends the run when the last life goes, and does not unlock anything", () => {
    const { world, fx, save } = makeWorld(SOLID, "expert"); // one life
    skipReady(world, fx);
    expect(world.lives).toBe(1);
    const unlocked = save.unlocked;

    drive(world, "wall");
    world.update(1 / 60, POINTER);

    expect(world.finished).toBe(true);
    expect(world.won).toBe(false);
    expect(world.snake.alive).toBe(false);
    expect(fx.cues()).toContain("die");
    expect(world.result?.stars).toBe(0);
    expect(save.unlocked).toBe(unlocked);
  });

  it("stops simulating once finished but keeps the popups moving", () => {
    const { world, fx } = makeWorld(SOLID, "expert");
    skipReady(world, fx);
    drive(world, "wall");
    world.update(1 / 60, POINTER);
    expect(world.finished).toBe(true);

    const c0 = world.clockT;
    const before = world.popups.map((p) => p.life);
    for (let i = 0; i < 10; i++) world.update(1 / 60, POINTER);
    expect(world.clockT).toBeGreaterThan(c0); // clocks still tick
    if (before.length) {
      expect(world.popups[0]!.life).toBeLessThan(before[0]!);
    }
  });

  it("records the win, unlocks the next level and rates the clear", () => {
    const { world, fx, save } = makeWorld(0);
    skipReady(world, fx);
    const goal = getLevel(0).goalFood;

    for (let i = 0; i < goal; i++) {
      const orb = world.food.spawn("normal");
      if (!orb) break;
      orb.x = world.snake.x;
      orb.y = world.snake.y;
      world.update(1 / 60, POINTER);
    }

    expect(world.finished).toBe(true);
    expect(world.won).toBe(true);
    expect(world.foodEaten).toBeGreaterThanOrEqual(goal);
    expect(world.result?.stars).toBeGreaterThanOrEqual(1);
    expect(world.result?.stars).toBeLessThanOrEqual(3);
    expect(save.unlocked).toBeGreaterThanOrEqual(2);
    expect(fx.cues().some((c) => c === "levelup" || c === "win")).toBe(true);
  });

  it("reports everything the victory scene needs", () => {
    const { world, fx } = makeWorld(0, "hard", C.MODE_STORY);
    skipReady(world, fx);
    const goal = getLevel(0).goalFood;
    for (let i = 0; i < goal; i++) {
      const orb = world.food.spawn("normal");
      if (!orb) break;
      orb.x = world.snake.x;
      orb.y = world.snake.y;
      world.update(1 / 60, POINTER);
    }
    const r = world.result;
    expect(r).not.toBeNull();
    expect(r!.levelName).toBe(getLevel(0).name);
    expect(r!.difficulty).toBe("hard");
    expect(r!.mode).toBe(C.MODE_STORY);
    expect(r!.story).toBe(true);
    expect(typeof r!.chapterTitle).toBe("string");
    expect(r!.starTargets).toHaveLength(3);
    expect(r!.nextIndex).toBe(1);
    expect(r!.finalLevel).toBe(false);
  });
});

describe("GameplayWorld: it survives being played", () => {
  it("runs every level for a few seconds without throwing or going non-finite", () => {
    for (let lv = 0; lv < 12; lv++) {
      const { world, fx } = makeWorld(lv);
      skipReady(world, fx);
      for (let i = 0; i < 240; i++) {
        // Steer in a slow circle so the snake actually meets its own body.
        const a = (i / 240) * Math.PI * 2;
        world.update(1 / 60, {
          x: 640 + Math.cos(a) * 260,
          y: 392 + Math.sin(a) * 180,
          boost: i % 90 < 20,
        });
        expect(Number.isFinite(world.snake.x)).toBe(true);
        expect(Number.isFinite(world.snake.y)).toBe(true);
      }
      expect(Number.isFinite(world.score)).toBe(true);
      expect(world.popups.length).toBeLessThanOrEqual(24);
    }
  });
});
