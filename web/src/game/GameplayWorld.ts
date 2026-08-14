/**
 * The rules of a level, with nothing you can see.
 *
 * This is `snake/scenes/gameplay.py` minus the drawing: level construction,
 * the four clocks, steering, collisions, pickups, the damage pipeline, scoring
 * and the end-of-run bookkeeping. Presentation leaves through a
 * {@link GameplayPresenter}; the scene supplies one that fires particles and
 * sounds, and tests supply one that just records what was asked for.
 *
 * Two things here are easy to get wrong and expensive to debug, so they are
 * called out where they happen:
 *
 * **The four clocks.** `dt` is real time and drives the UI. `sdt` is `dt`
 * scaled by slow motion and drives the simulation. `clockT` accumulates `sdt`
 * and times food, runes and the combo window. `hazardT` accumulates
 * `sdt * hazardMult` and times the hazards - they are simulated *and* drawn
 * from it, so passing `clockT` to a hazard looks almost right and drifts.
 *
 * **Speed composition.** `snake.speed` carries cruise x difficulty only. The
 * level's pace multiplier rides in `update`'s `speedMult` alongside the
 * power-up multipliers. Folding it into `snake.speed` flattens the campaign's
 * ramp from levels 1 to 12, and nothing fails loudly when it happens.
 *
 * Nothing in `update` may throw. The Python wraps every call site; the ported
 * core already swallows internally, and the same posture is kept here - a bad
 * frame degrades, it never takes the run down.
 */

import * as C from "../core/config";
import {
  applyStarTargets,
  comboWindow,
  getDifficulty,
  invulnSeconds,
  livesFor,
  powerupSpawnRange,
  scoreForFood,
  selfCollisionDepth,
  selfCollisionEnabled,
  selfCollisionSkip,
  type Difficulty,
} from "../core/difficulty";
import { FoodField, foodColor, type Food } from "../core/food";
import { getLevel, LEVEL_COUNT, type LevelDef } from "../core/level";
import { angleTo, clamp, TAU } from "../core/mathx";
import {
  buildObstacles,
  obstacleAvoidList,
  Portal,
  updateObstacles,
  type Obstacle,
} from "../core/obstacles";
import { lerpColor, UI_BAD, UI_WHITE, type RGB, type Theme } from "../core/palette";
import {
  ActiveEffects,
  MAGNET_STRENGTH,
  powerupColor,
  powerupInfo,
  PowerUpField,
  type PowerUp,
} from "../core/powerups";
import type { SaveData } from "../core/save";
import { Snake } from "../core/snake";
import * as story from "../core/story";
import { SilentPresenter, type GameplayPresenter } from "./presenter";

// ---------------------------------------------------------------------------
// Scene-local tuning. These belong to the scene, not to config.ts - the Python
// keeps them as class constants on GameplayScene for the same reason.
// ---------------------------------------------------------------------------

export const READY_TIME = 3.0;
export const GO_TIME = 0.65;
/** Scene-side portal guard, on top of the Portal's own cooldown. */
export const PORTAL_LOCKOUT = 0.55;
/** Head radius for lethal contact - smaller than the drawn head, deliberately. */
export const HEAD_HIT_R: number = C.SNAKE_HEAD_RADIUS * 0.62;
/** Head radius for pickups - larger, so collecting feels generous. */
export const PICKUP_R: number = C.SNAKE_HEAD_RADIUS * 0.9;
export const TRAIL_RATE: number = C.TRAIL_EMIT_RATE;
export const TRAIL_RATE_BOOST: number = C.TRAIL_EMIT_RATE * 2.3;
export const AMBIENT_RATE = 3.0;
export const SOFT_AVOID_SCALE = 0.5;
export const SOFT_AVOID_MAX = 92.0;
export const POPUP_LIMIT = 24;
export const POPUP_LIFE = 1.05;
export const POPUP_RISE = -64;
export const BLINK_HZ = 7.0;
export const CROSS_SOUND_COOLDOWN = 0.55;
export const CROSS_WASH_RATE = 62;
/** One-time teaching moment the first time you cross over in a level. */
export const CROSS_TEACH_SCALE = 0.55;
export const CROSS_TEACH_TIME = 0.24;

export type AvoidCircle = readonly [number, number, number];

/** A floating score number. The scene owns how it looks; the world owns its life. */
export interface Popup {
  x: number;
  y: number;
  vy: number;
  life: number;
  maxLife: number;
  text: string;
  color: RGB;
  big: boolean;
}

/** What the HUD is allowed to know. Unknown keys are ignored by the drawer. */
export interface HudState {
  score: number;
  highscore: number;
  levelName: string;
  levelIndex: number;
  goalFood: number;
  foodEaten: number;
  lives: number;
  combo: number;
  boost: number;
  boostMax: number;
  effects: Array<[string, number]>;
  difficulty: string;
  difficultyLabel: string;
  difficultyColor: RGB;
  mode: string;
  chapter: number;
  chapterTitle: string;
  beatTitle: string;
}

/** The contract with the victory and game-over scenes. */
export interface RunResult {
  score: number;
  levelIndex: number;
  levelName: string;
  foodEaten: number;
  goalFood: number;
  stars: number;
  newBest: boolean;
  won: boolean;
  elapsed: number;
  maxCombo: number;
  deaths: number;
  difficulty: string;
  difficultyName: string;
  difficultyLabel: string;
  difficultyColor: RGB;
  starTargets: readonly [number, number, number];
  crossings: number;
  mode: string;
  story: boolean;
  nextIndex: number;
  finalLevel: boolean;
  // Story mode only.
  beatTitle?: string;
  beatSpeaker?: string;
  chapterEnd?: boolean;
  chapter?: number;
  chapterTitle?: string;
  chapterRoman?: string;
  storyComplete?: boolean;
}

export interface GameplayWorldOptions {
  save: SaveData;
  presenter?: GameplayPresenter;
  /** Varies the orb layout per run; tests pass a fixed value. */
  seed?: number;
}

export interface EnterArgs {
  levelIndex: number;
  difficulty: string;
  mode: string;
}

/** Where the steering target is, in design space. */
export interface Pointer {
  x: number;
  y: number;
  boost: boolean;
}

export class GameplayWorld {
  // -- wiring ------------------------------------------------------------
  private readonly save: SaveData;
  private readonly seedBase: number;
  presenter: GameplayPresenter;

  // -- level -------------------------------------------------------------
  level!: LevelDef;
  theme!: Theme;
  diff!: Difficulty;
  readonly arena = { x: C.ARENA_X, y: C.ARENA_Y, w: C.ARENA_W, h: C.ARENA_H };

  snake!: Snake;
  food!: FoodField;
  runes!: PowerUpField;
  effects = new ActiveEffects();
  obstacles: Obstacle[] = [];

  // -- difficulty snapshot, taken once so a mid-run settings change cannot
  //    half-apply
  private selfEnabled = true;
  private selfSkip: number = C.SELF_COLLISION_SKIP;
  private selfDepth: number = C.SELF_COLLISION_DEPTH;
  private invulnTime: number = C.INVULN_AFTER_HIT;
  private comboWin: number = C.COMBO_WINDOW;
  private hazardMult = 1;
  starTargets: readonly [number, number, number] = [0, 0, 0];

  // -- story snapshot ----------------------------------------------------
  storyMode = false;
  beat: story.StoryBeat | null = null;
  chapter: story.Chapter | null = null;
  mode: string = C.DEFAULT_MODE;

  // -- run state (every field reset in enter()) --------------------------
  score = 0;
  foodEaten = 0;
  lives = 3;
  deaths = 0;
  combo = 0;
  maxCombo = 0;
  lastPickupT = -1e9;
  elapsed = 0;
  clockT = 0;
  hazardT = 0;
  readyTimer = READY_TIME;
  goTimer = 0;
  portalLock = 0;
  finished = false;
  won = false;
  readonly popups: Popup[] = [];
  result: RunResult | null = null;

  private wasBoosting = false;
  keyBoost = false;
  private wasCrossing = false;
  private crossCool = 0;
  private crossTaught = false;
  private crossCount = 0;

  private avoid: AvoidCircle[] = [];
  private avoidSoft: AvoidCircle[] = [];
  private vetted = new Set<Food>();

  constructor(opts: GameplayWorldOptions) {
    this.save = opts.save;
    this.presenter = opts.presenter ?? new SilentPresenter();
    this.seedBase = opts.seed ?? 0;
  }

  // =====================================================================
  // level construction
  // =====================================================================

  /**
   * Build a level from scratch.
   *
   * Scene instances are cached and reused, so this must reset *everything* the
   * world owns. A field left over from the previous run shows up as a level
   * that starts with the last one's score still on the HUD.
   */
  enter(args: EnterArgs): void {
    const idx = clamp(Math.trunc(args.levelIndex) || 0, 0, LEVEL_COUNT - 1);
    this.level = getLevel(idx);
    this.theme = this.level.theme;
    this.mode = args.mode;

    // Snapshot the difficulty once - see the class docstring.
    this.diff = getDifficulty(args.difficulty);
    this.selfEnabled = selfCollisionEnabled(this.diff);
    this.selfSkip = selfCollisionSkip(this.diff);
    this.selfDepth = selfCollisionDepth(this.diff);
    this.invulnTime = invulnSeconds(this.diff);
    this.comboWin = comboWindow(this.diff);
    this.hazardMult = Math.max(0.05, this.diff.hazardSpeedMult);
    this.starTargets = applyStarTargets(this.diff, this.level.starTargets);

    this.storyMode = args.mode === C.MODE_STORY;
    this.beat = this.storyMode ? story.getBeat(this.level.index) : null;
    this.chapter = this.storyMode ? story.getChapter(this.level.index) : null;

    this.presenter.setTheme(this.theme.accent);

    this.obstacles = buildObstacles(this.level.obstacleSpec, this.arena);
    this.hazardT = 0;
    // Settle the moving parts before reading their geometry, or the keep-out
    // list is computed from hazards that have not taken their pose yet.
    updateObstacles(this.obstacles, 0, 0);
    this.avoid = obstacleAvoidList(this.obstacles);
    this.avoidSoft = this.avoid.map(
      (c) => [c[0], c[1], Math.min(SOFT_AVOID_MAX, c[2] * SOFT_AVOID_SCALE)] as AvoidCircle,
    );

    const heading = this.safeHeading();
    const [sx, sy] = [this.arena.x + this.arena.w / 2, this.arena.y + this.arena.h / 2];
    this.snake = new Snake(sx, sy, heading, C.SNAKE_START_LENGTH);
    // Cruise x difficulty only. The level's pace multiplier rides in update().
    this.snake.speed = this.level.cruiseSpeed * this.diff.speedMult;

    this.food = new FoodField(this.arena, this.theme, this.seedBase || undefined);
    this.food.avoid = [...this.avoidSoft];
    this.vetted = new Set();
    this.restock();

    this.runes = new PowerUpField(
      this.arena,
      this.theme,
      this.seedBase ? this.seedBase ^ 0x9e3779b9 : undefined,
    );
    this.runes.enabled = this.level.powerupsEnabled;
    const [lo, hi] = powerupSpawnRange(this.diff);
    this.runes.setSpawnRange(lo, hi);

    this.effects = new ActiveEffects();

    this.score = 0;
    this.foodEaten = 0;
    this.lives = livesFor(this.diff);
    this.deaths = 0;
    this.combo = 0;
    this.maxCombo = 0;
    this.lastPickupT = -1e9;
    this.elapsed = 0;
    this.clockT = 0;
    this.readyTimer = READY_TIME;
    this.goTimer = 0;
    this.portalLock = 0;
    this.finished = false;
    this.won = false;
    this.result = null;
    this.popups.length = 0;
    this.wasBoosting = false;
    this.keyBoost = false;
    this.wasCrossing = false;
    this.crossCool = 0;
    this.crossTaught = false;
    this.crossCount = 0;

    this.presenter.clearParticles();
  }

  exit(): void {
    this.presenter.clearParticles();
  }

  /**
   * Pick an opening heading with room to run.
   *
   * Twelve candidates, each probed outward from the spawn point; the one that
   * gets furthest before leaving the arena or meeting something lethal wins.
   * Without this the snake can spawn nose-first into a wall on the denser
   * levels and lose a life before the countdown finishes.
   */
  private safeHeading(): number {
    const cx = this.arena.x + this.arena.w / 2;
    const cy = this.arena.y + this.arena.h / 2;
    const probes = [45, 90, 140, 200, 270];
    const clearR = C.SNAKE_HEAD_RADIUS * 1.5;

    let best = 0;
    let bestReach = -1;
    for (let k = 0; k < 12; k++) {
      const ang = (k * TAU) / 12;
      const dx = Math.cos(ang);
      const dy = Math.sin(ang);
      let reach = 0;
      for (const d of probes) {
        const px = cx + dx * d;
        const py = cy + dy * d;
        if (!this.insideArena(px, py)) break;
        if (this.blockedAt(px, py, clearR)) break;
        reach = d;
      }
      if (reach > bestReach) {
        bestReach = reach;
        best = ang;
      }
    }
    return best;
  }

  /** pygame's `Rect.collidepoint`: truncates, and excludes the far edges. */
  private insideArena(x: number, y: number): boolean {
    const px = Math.trunc(x);
    const py = Math.trunc(y);
    return (
      px >= this.arena.x &&
      px < this.arena.x + this.arena.w &&
      py >= this.arena.y &&
      py < this.arena.y + this.arena.h
    );
  }

  /** True when a circle here touches anything lethal. */
  private blockedAt(x: number, y: number, r: number): boolean {
    for (const ob of this.obstacles) {
      try {
        if (ob.deadly && ob.collides(x, y, r)) return true;
      } catch {
        // A hazard that cannot answer is treated as clear; the Python does the
        // same rather than letting one bad shape block level construction.
      }
    }
    return false;
  }

  // =====================================================================
  // the frame
  // =====================================================================

  update(rawDt: number, pointer: Pointer): void {
    const dt = clamp(rawDt, 0, C.MAX_DT);
    try {
      this.step(dt, pointer);
    } catch (err) {
      console.warn("[gameplay] frame failed", err);
    }
  }

  private step(dt: number, pointer: Pointer): void {
    // The simulation clock. Slow motion scales this and nothing else, which is
    // what lets a hit freeze the world while the HUD keeps breathing.
    const sdt = clamp(dt * clamp(this.presenter.timeScale(), 0.05, 1), 0, C.MAX_DT);
    this.clockT += sdt;
    const hdt = sdt * this.hazardMult;
    this.hazardT += hdt;

    for (const p of this.popups) {
      p.y += p.vy * dt;
      p.vy *= 1 / (1 + 2.6 * dt);
      p.life -= dt;
    }
    if (this.popups.some((p) => p.life <= 0)) {
      const alive = this.popups.filter((p) => p.life > 0);
      this.popups.length = 0;
      this.popups.push(...alive);
    }

    // After a clear or a death the world stops, but the background and the
    // popups keep going until the scene switch lands.
    if (this.finished) return;

    if (this.readyTimer > 0) {
      this.readyTimer -= dt;
      this.snake.setTarget(pointer.x, pointer.y);
      updateObstacles(this.obstacles, hdt, this.hazardT);
      this.food.update(sdt, this.clockT);
      this.runes.update(sdt, this.clockT);
      if (this.readyTimer <= 0) {
        this.readyTimer = 0;
        this.goTimer = GO_TIME;
        this.presenter.audio("start");
      }
      return;
    }

    this.goTimer = Math.max(0, this.goTimer - dt);
    this.elapsed += sdt;
    this.portalLock = Math.max(0, this.portalLock - sdt);

    this.snake.setTarget(pointer.x, pointer.y);
    const boost = this.keyBoost || pointer.boost;
    this.snake.update(sdt, {
      boost,
      speedMult: this.level.speedMult * this.effects.speedMultiplier(),
      turnMult: this.effects.turnMultiplier() * this.diff.turnMult,
    });

    if (this.snake.boosting && !this.wasBoosting) this.presenter.audio("boost", 0.7);
    this.wasBoosting = this.snake.boosting;

    this.effects.update(sdt);
    updateObstacles(this.obstacles, hdt, this.hazardT);
    this.food.update(sdt, this.clockT);
    this.runes.update(sdt, this.clockT);
    this.spawnRune(sdt);
    this.restock();

    const magnet = this.effects.magnetRadius();
    if (magnet > 0) {
      this.food.attract(this.snake.x, this.snake.y, sdt, magnet, MAGNET_STRENGTH);
    }

    this.emitTrail(sdt);
    this.collect();
    if (!this.finished) this.collide();
    this.crossFeedback(dt);

    if (this.combo > 0 && this.clockT - this.lastPickupT > this.comboWin) this.combo = 0;
  }

  // -- wake and ambience --------------------------------------------------

  private emitTrail(sdt: number): void {
    const v = this.snake.headingVector();
    // The wake leaves from behind the head, not from the head itself.
    const bx = this.snake.x - v.x * (C.SNAKE_HEAD_RADIUS * 0.6);
    const by = this.snake.y - v.y * (C.SNAKE_HEAD_RADIUS * 0.6);
    if (this.snake.boosting) {
      this.presenter.trail(
        bx,
        by,
        lerpColor(this.theme.accent2, [255, 255, 255], 0.3),
        sdt,
        { rate: TRAIL_RATE_BOOST, speed: [30, 110] },
      );
    } else {
      this.presenter.trail(bx, by, this.theme.snakeA, sdt, {
        rate: TRAIL_RATE,
        speed: [8, 44],
      });
    }
    this.presenter.ambient(this.theme.grid, sdt, AMBIENT_RATE);
  }

  // -- stocking -----------------------------------------------------------

  /**
   * Top the field up, then vet new orbs against the real hazard shapes.
   *
   * The field places against the *softened* keep-out list, because a bounding
   * circle around a long thin wall covers most of the arena and would starve
   * the level. That means an orb can legally land inside a wall, so each one is
   * tested once, against the true geometry, and dropped if it is buried.
   * Testing every frame instead would let a moving hazard delete food that was
   * placed perfectly well.
   */
  private restock(): void {
    const want = this.level.foodCount + this.effects.extraFood();
    const have = this.food.count("normal");
    for (let i = have; i < want; i++) {
      // One attempt each: a crowded arena stays briefly under-stocked rather
      // than spinning here.
      this.food.spawn("normal");
    }

    if (this.obstacles.length === 0) return;
    const survivors = new Set<Food>();
    for (const orb of [...this.food.items]) {
      if (this.vetted.has(orb)) {
        survivors.add(orb);
        continue;
      }
      if (this.blockedAt(orb.x, orb.y, orb.radius)) {
        const i = this.food.items.indexOf(orb);
        if (i >= 0) this.food.items.splice(i, 1);
        continue;
      }
      survivors.add(orb);
    }
    this.vetted = survivors;
  }

  private spawnRune(sdt: number): void {
    const rune = this.runes.maybeSpawn(sdt, this.avoidSoft);
    if (!rune) return;
    if (this.blockedAt(rune.x, rune.y, rune.radius)) {
      const i = this.runes.items.indexOf(rune);
      if (i >= 0) this.runes.items.splice(i, 1);
    }
  }

  // -- pickups ------------------------------------------------------------

  private collect(): void {
    const hx = this.snake.x;
    const hy = this.snake.y;

    for (const orb of this.food.collectAt(hx, hy, PICKUP_R)) {
      this.eat(orb);
      if (this.finished) return;
    }
    for (const rune of this.runes.collectAt(hx, hy, PICKUP_R)) {
      this.takeRune(rune);
    }
  }

  private eat(orb: Food): void {
    if (this.combo > 0 && this.clockT - this.lastPickupT <= this.comboWin) {
      this.combo = Math.min(C.COMBO_MAX, this.combo + 1);
    } else {
      this.combo = 1;
    }
    this.lastPickupT = this.clockT;
    this.maxCombo = Math.max(this.maxCombo, this.combo);

    const base = orb.value + C.COMBO_STEP_BONUS * Math.max(0, this.combo - 1);
    const gain = scoreForFood(this.diff, base, this.effects.scoreMultiplier());
    this.score += gain;

    this.foodEaten += 1;
    this.save.addFood(1);
    this.snake.grow(orb.grow);

    const special = orb.kind !== "normal";
    const col = foodColor(orb.kind, this.theme, this.clockT);
    this.presenter.burst(orb.x, orb.y, col, {
      count: special ? 34 : 20,
      speed: special ? [60, 300] : [40, 190],
      life: [0.35, 1.0],
    });
    this.presenter.ring(orb.x, orb.y, col, {
      radius: special ? 76 : 46,
      count: special ? 24 : 16,
      life: special ? 0.55 : 0.42,
    });
    if (special) {
      this.presenter.flash(col, 0.24);
      this.presenter.shake(2.5);
    }
    this.presenter.audio(special ? "bonus" : "eat");

    const text = this.combo > 1 ? `+${gain}  x${this.combo}` : `+${gain}`;
    this.addPopup(text, orb.x, orb.y - 12, lerpColor(col, UI_WHITE, 0.35), special);

    if (this.foodEaten >= this.level.goalFood) this.finish(true);
  }

  private takeRune(rune: PowerUp): void {
    const col = powerupColor(rune.kind);
    this.effects.add(rune.kind);
    this.presenter.burst(rune.x, rune.y, col, {
      count: 30,
      speed: [70, 260],
      life: [0.4, 1.0],
    });
    this.presenter.ring(rune.x, rune.y, col, { radius: 74, count: 26, life: 0.55 });
    this.addPopup(powerupInfo(rune.kind).name.toUpperCase(), rune.x, rune.y - 18, col, true);
    this.presenter.flash(col, 0.28);
    this.presenter.audio("powerup");
  }

  // -- collisions ---------------------------------------------------------

  private collide(): void {
    const hx = this.snake.x;
    const hy = this.snake.y;
    const a = this.arena;

    // Walls first, and a wrap ends the frame's collision work entirely.
    if (this.level.wrapWalls) {
      if (this.wrap(hx, hy)) return;
    } else {
      const out =
        hx - HEAD_HIT_R < a.x ||
        hx + HEAD_HIT_R > a.x + a.w ||
        hy - HEAD_HIT_R < a.y ||
        hy + HEAD_HIT_R > a.y + a.h;
      if (out) {
        if (this.snake.invuln > 0) this.recover("wall");
        else this.hit("wall");
        return;
      }
    }

    // Mercy invulnerability skips self and hazards, but never the walls above.
    if (this.snake.invuln > 0) return;

    // Called unconditionally even when self-collision is off: the sweep warms
    // the cache that crossingSelf() reads a few lines later, with this
    // difficulty's parameters.
    const selfHit = this.snake.hitsSelf({
      skip: this.selfSkip,
      depth: this.selfDepth,
      enabled: this.selfEnabled && !this.effects.has("ghost"),
    });
    if (selfHit) {
      this.hit("self");
      return;
    }

    for (const ob of this.obstacles) {
      let touching = false;
      try {
        touching = ob.collides(hx, hy, HEAD_HIT_R);
      } catch {
        touching = false;
      }
      if (!touching) continue;

      if (ob instanceof Portal) {
        if (this.portalLock <= 0) this.takePortal(ob, hx, hy);
        return;
      }
      if (ob.deadly) {
        this.hit("hazard");
        return;
      }
    }
  }

  private wrap(hx: number, hy: number): boolean {
    const a = this.arena;
    let nx = hx;
    let ny = hy;
    let wrapped = false;
    if (hx - HEAD_HIT_R < a.x) {
      nx = a.x + a.w - 2;
      wrapped = true;
    } else if (hx + HEAD_HIT_R > a.x + a.w) {
      nx = a.x + 2;
      wrapped = true;
    }
    if (hy - HEAD_HIT_R < a.y) {
      ny = a.y + a.h - 2;
      wrapped = true;
    } else if (hy + HEAD_HIT_R > a.y + a.h) {
      ny = a.y + 2;
      wrapped = true;
    }
    if (!wrapped) return false;

    this.presenter.burst(hx, hy, this.theme.accent, {
      count: 14,
      speed: [50, 170],
      life: [0.2, 0.5],
    });
    this.presenter.ring(nx, ny, this.theme.accent, { radius: 42, count: 14, life: 0.35 });
    this.snake.teleport(nx, ny);
    return true;
  }

  private takePortal(portal: Portal, hx: number, hy: number): void {
    const [ex, ey] = portal.teleport(hx, hy);
    if (!Number.isFinite(ex) || !Number.isFinite(ey)) return;

    this.presenter.ring(hx, hy, this.theme.accent2, { radius: 70, count: 22, life: 0.5 });
    this.presenter.ring(ex, ey, this.theme.accent, { radius: 86, count: 26, life: 0.55 });
    this.presenter.burst(ex, ey, this.theme.accent2, {
      count: 22,
      speed: [60, 240],
      life: [0.3, 0.8],
    });
    this.presenter.flash(this.theme.accent2, 0.22);
    this.snake.teleport(ex, ey);
    this.portalLock = PORTAL_LOCKOUT;
    this.presenter.audio("portal");
  }

  // -- cross-over ---------------------------------------------------------

  /**
   * Feedback for passing over your own body.
   *
   * Runs after the collision pass so it reuses the sweep that pass already
   * paid for. On Easy - or under ghost - self-collision is disabled, so
   * `crossingSelf` never reports; there the *default-rules* verdict is asked
   * for separately, purely as a cue, so the player still sees that something
   * forgiving just happened.
   */
  private crossFeedback(dt: number): void {
    this.crossCool = Math.max(0, this.crossCool - dt);

    let crossing = false;
    try {
      crossing = this.snake.alive && this.snake.crossingSelf();
      if (!crossing && this.forgivesEverything()) {
        crossing =
          this.snake.alive &&
          this.snake.hitsSelf({
            skip: C.SELF_COLLISION_SKIP,
            depth: C.SELF_COLLISION_DEPTH,
            enabled: true,
          });
      }
    } catch {
      crossing = false;
    }

    if (crossing) {
      const col = lerpColor(this.theme.accent2, UI_WHITE, 0.42);
      // At the head, not behind it: this wash marks the overlap itself.
      this.presenter.trail(this.snake.x, this.snake.y, col, dt, {
        rate: CROSS_WASH_RATE,
        spread: TAU * 0.5,
        speed: [14, 78],
        life: [0.16, 0.4],
        radius: [2.0, 4.5],
      });

      if (!this.wasCrossing && this.crossCool <= 0) {
        this.crossCool = CROSS_SOUND_COOLDOWN;
        this.crossCount += 1;
        this.presenter.audio("boost", 0.24);
        this.presenter.ring(this.snake.x, this.snake.y, col, {
          radius: 38,
          count: 12,
          life: 0.3,
          speed: 95,
        });
        if (!this.crossTaught) {
          this.crossTaught = true;
          this.presenter.slowmo(CROSS_TEACH_SCALE, CROSS_TEACH_TIME);
          this.presenter.flash(col, 0.16);
          this.addPopup("CROSS-OVER", this.snake.x, this.snake.y - 30, col, false);
        }
      }
    }
    this.wasCrossing = crossing;
  }

  private forgivesEverything(): boolean {
    return !this.selfEnabled || this.effects.has("ghost");
  }

  // -- damage -------------------------------------------------------------

  private hit(kind: string): void {
    const hx = this.snake.x;
    const hy = this.snake.y;

    if (this.effects.consume("shield")) {
      const col = powerupColor("shield");
      this.presenter.ring(hx, hy, col, { radius: 140, count: 40, life: 0.7, speed: 190 });
      this.presenter.burst(hx, hy, col, { count: 26, speed: [80, 300], life: [0.3, 0.8] });
      this.presenter.flash(col, 0.55);
      this.presenter.shake(9.0);
      this.presenter.audio("powerup");
      this.addPopup("SHIELD!", hx, hy - 26, col, true);
      this.snake.invuln = Math.max(this.snake.invuln, 1.0);
      this.recover(kind);
      return;
    }

    this.lives -= 1;
    this.deaths += 1;
    this.combo = 0;
    this.snake.shrink(C.HIT_LENGTH_PENALTY);
    this.snake.invuln = this.invulnTime;
    this.save.addDeath(1);

    const col = this.theme.hazard;
    this.presenter.burst(hx, hy, col, {
      count: 46,
      speed: [90, 380],
      life: [0.35, 1.1],
      radius: [2.0, 6.0],
    });
    this.presenter.ring(hx, hy, col, { radius: 120, count: 30, life: 0.6 });
    this.presenter.shake(19.0);
    this.presenter.flash(UI_BAD, 0.85);
    this.presenter.slowmo(0.35, 0.45);
    this.addPopup("-1 LIFE", hx, hy - 26, UI_BAD, true);

    if (this.lives <= 0) {
      this.lives = 0;
      this.snake.kill();
      this.presenter.burst(hx, hy, this.theme.snakeA, {
        count: 70,
        speed: [60, 430],
        life: [0.5, 1.4],
        radius: [2.0, 7.0],
      });
      this.presenter.shake(24.0);
      this.presenter.audio("die");
      this.finish(false);
      return;
    }

    this.presenter.audio("hit");
    this.recover(kind);
  }

  /**
   * Put the head somewhere survivable after a non-self hit.
   *
   * Without this a wall hit leaves the head inside the geometry, and the mercy
   * timer expires straight back into the same collision until every life is
   * gone. Self hits need no rescue - the body is not lethal terrain.
   */
  private recover(kind: string): void {
    if (kind === "self") return;
    const a = this.arena;
    const pad = C.SNAKE_HEAD_RADIUS + 4;
    const nx = clamp(this.snake.x, a.x + pad, a.x + a.w - pad);
    const ny = clamp(this.snake.y, a.y + pad, a.y + a.h - pad);
    if (nx !== this.snake.x || ny !== this.snake.y) this.snake.teleport(nx, ny);
    this.snake.heading = angleTo(nx, ny, a.x + a.w / 2, a.y + a.h / 2);
  }

  // -- end of run ---------------------------------------------------------

  private finish(won: boolean): void {
    if (this.finished) return;
    this.finished = true;
    this.won = won;

    const [t1, t2, t3] = this.starTargets;
    const stars = won ? (this.score >= t3 ? 3 : this.score >= t2 ? 2 : 1) : 0;
    void t1;

    const idx = this.level.index;
    const final = idx >= LEVEL_COUNT - 1;
    let newBest = false;

    try {
      if (won) {
        newBest = this.save.record(idx, this.score, stars, this.diff.key);
        this.save.unlockThrough(idx + 1);
        if (this.storyMode) {
          this.save.setStoryProgress(Math.min(idx + 1, LEVEL_COUNT - 1));
          if (final) this.save.setStoryComplete(true);
        }
      } else if (this.score > this.save.highscore) {
        // A loss must never unlock anything, so `record` is off limits here -
        // only the running highscore may move.
        this.save.highscore = this.score;
      }
      this.save.save();
    } catch (err) {
      console.warn("[gameplay] save failed", err);
    }

    if (won) {
      this.presenter.flash(this.theme.accent, 0.7);
      this.presenter.audio(final ? "win" : "levelup");
    }

    this.result = {
      score: this.score,
      levelIndex: idx,
      levelName: this.level.name,
      foodEaten: this.foodEaten,
      goalFood: this.level.goalFood,
      stars,
      newBest,
      won,
      elapsed: this.elapsed,
      maxCombo: this.maxCombo,
      deaths: this.deaths,
      difficulty: this.diff.key,
      difficultyName: this.diff.name,
      difficultyLabel: this.diff.hudLabel,
      difficultyColor: this.diff.color as RGB,
      starTargets: this.starTargets,
      crossings: this.crossCount,
      mode: this.mode,
      story: this.storyMode,
      nextIndex: Math.min(idx + 1, LEVEL_COUNT - 1),
      finalLevel: final,
      ...(this.storyMode && this.beat
        ? {
            beatTitle: this.beat.title,
            beatSpeaker: this.beat.speaker,
            chapterEnd: story.chapterEnd(this.beat.levelIndex),
            chapter: this.chapter?.number ?? 0,
            chapterTitle: this.chapter?.title ?? "",
            chapterRoman: this.chapter?.roman() ?? "",
            storyComplete: final,
          }
        : {}),
    };
  }

  // -- odds and ends ------------------------------------------------------

  private addPopup(text: string, x: number, y: number, color: RGB, big: boolean): void {
    if (this.popups.length >= POPUP_LIMIT) this.popups.shift();
    const maxLife = POPUP_LIFE * (big ? 1.3 : 1);
    this.popups.push({
      x,
      y,
      vy: POPUP_RISE * (big ? 1.25 : 1),
      life: maxLife,
      maxLife,
      text,
      color,
      big,
    });
  }

  /** Pause, from the HUD button or the keyboard. */
  requestPause(): void {
    this.presenter.audio("click");
  }

  /**
   * False on the frames the snake blinks out during mercy invulnerability.
   * The scene skips drawing it entirely rather than fading it.
   */
  snakeVisible(): boolean {
    return this.snake.invuln <= 0 || Math.sin(this.snake.invuln * TAU * BLINK_HZ) > -0.25;
  }

  hudState(gameTime: number): HudState {
    void gameTime;
    return {
      score: this.score,
      highscore: this.save.highscore,
      levelName: this.level.name,
      levelIndex: this.level.index,
      goalFood: this.level.goalFood,
      foodEaten: this.foodEaten,
      lives: this.lives,
      combo: this.combo,
      boost: this.snake.boost,
      boostMax: C.SNAKE_BOOST_MAX,
      effects: this.effects.items(),
      difficulty: this.diff.key,
      difficultyLabel: this.diff.hudLabel,
      difficultyColor: this.diff.color as RGB,
      mode: this.mode,
      chapter: this.chapter?.number ?? 0,
      chapterTitle: this.chapter?.title ?? "",
      beatTitle: this.beat?.title ?? "",
    };
  }
}
