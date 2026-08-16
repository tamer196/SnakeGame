/**
 * Everything the two result screens have in common - a port of `_ResultScene`
 * (`snake/scenes/gameover.py:222-699`).
 *
 * Subclasses supply a palette, a button row and a body; the base owns result
 * parsing, the count-up clock, the button plumbing and the scene-switch
 * actions. Every key of `game.lastResult` is optional: a missing or empty
 * result degrades to a zeroed summary rather than an exception, because a
 * crash on the results screen would throw away the run the player just
 * finished. Note the producer (`GameplayWorld.finish`) writes **camelCase**
 * keys - `levelIndex`, `foodEaten`, `newBest` - not the Python's snake_case;
 * reading the wrong spelling would silently zero the whole screen
 * (scenes.md §6.9.4).
 *
 * Two latent Python bugs are ported as fixes (scenes.md §6.4): subclass state
 * resets at the *top* of `onEnter` (never in `onReady`, which a sibling
 * failure could skip), and the previous entry's buttons are destroyed before
 * anything that can fail, so the fallback MENU button can never be shadowed
 * by a stale row.
 */

import { Container, Graphics } from "pixi.js";

import type { Game } from "../../app/Game";
import { Scene, SCENES, type SceneEnterArgs } from "../../app/Scene";
import * as C from "../../core/config";
import { getDifficulty, applyStarTargets, type Difficulty } from "../../core/difficulty";
import { getLevel, LEVEL_COUNT } from "../../core/level";
import { clamp, easeOutCubic } from "../../core/mathx";
import {
  THEMES,
  UI_GOOD,
  UI_WARN,
  lerpColor,
  shade,
  toHex,
  type RGB,
  type Theme,
} from "../../core/palette";
import { GAME_MODES, type SaveData } from "../../core/save";
import { getChapter } from "../../core/story";
import type { Audio } from "../../audio";
import { makeBackground, type Background } from "../../gfx/bg";
import { Button, type ButtonStyle } from "../../ui/Button";
import { grouped } from "../../ui/format";
import { mute } from "../../ui/muteTheme";
import type { Label } from "../../ui/text";
import type { Badge } from "./decor";
import { fmtDelta } from "./format";

// --------------------------------------------------------------------------
// Timing (gameover.py:84-91). Presentation, not simulation - deliberately not
// in config.json.
// --------------------------------------------------------------------------
/** Seconds the summary numbers take to roll from zero to their real value. */
export const COUNT_TIME = 1.05;
/** Delay before the count-up starts, so the heading lands first. */
export const COUNT_DELAY = 0.3;
/** When the first star pops, and the gap between the ones after it. */
export const STAR_FIRST = 0.85;
export const STAR_GAP = 0.55;
/** How long one star's pop animation runs. */
export const STAR_POP = 0.55;

/** Beat indices 0..11 are the twelve level beats; the prologue's own "seen"
 * flag is parked far above them by mode select, so the two never collide. */
const MAX_BEAT = Math.max(0, LEVEL_COUNT - 1);

export type ButtonSpec = readonly [label: string, style: ButtonStyle, action: string];

export abstract class ResultScene extends Scene {
  readonly root = new Container();

  protected readonly save: SaveData;
  protected readonly sound: Audio | null;

  /** Ambient veil strength over the backdrop, 0-255. Subclasses override. */
  protected readonly veilAlpha: number = 120;

  // -- layer order, back to front (gameover.py:598-610) --------------------
  private readonly bgLayer = new Container();
  private readonly veil = new Graphics();
  /** The shell's particle layer is inserted between veil and body on entry. */
  protected readonly bodyLayer = new Container();
  private readonly buttonLayer = new Container();

  protected theme: Theme = THEMES[0]!;
  protected buttons: Button[] = [];
  protected result: Record<string, unknown> = {};

  // -- parsed result fields (always present, always the right type) --------
  protected levelIndex = 0;
  protected levelName = "";
  protected score = 0;
  protected foodEaten = 0;
  protected goalFood = 1;
  protected stars = 0;
  protected newBest = false;
  protected maxCombo = 0;
  protected deaths = 0;
  protected elapsed = 0;

  protected mode: string = C.MODE_FREE;
  protected diff: Difficulty = getDifficulty(null);
  protected starTargets: readonly [number, number, number] = [1, 2, 3];
  protected par = 1;
  protected final = false;
  protected nextIndex = 0;
  /** The level the result's `starTargets` belong to (pre-kwarg override). */
  private resultLevel = -1;

  /** Seconds since onEnter; real dt, clamped. Drives the entire reveal. */
  protected t = 0;

  // Cached backdrop art, invalidated only by a style/theme/viewport change -
  // deliberately NOT reset per entry, so a retry of the same level reuses it.
  private bg: Background | null = null;
  private bgStyle = "";
  private bgThemeName = "";
  private bgRect = { x: 0, y: 0, w: 0, h: 0 };

  constructor(game: Game, save: SaveData, sound: Audio | null = null) {
    super(game);
    this.save = save;
    this.sound = sound;
    this.root.addChild(this.bgLayer, this.veil, this.bodyLayer, this.buttonLayer);
  }

  // ------------------------------------------------------------------
  // hooks for subclasses
  // ------------------------------------------------------------------

  /** Reset every field the subclass owns. Runs FIRST in onEnter. */
  protected abstract resetSceneState(): void;
  /** The level theme; GameOverScene overrides with the muted copy. */
  protected buildTheme(): Theme {
    return getLevel(this.levelIndex).theme;
  }
  protected buildButtons(): Button[] {
    return [];
  }
  /** Point every retained label/panel at this entry's values. */
  protected applyStaticContent(): void {}
  /** The entry sting only - state resets live in resetSceneState. */
  protected onReady(): void {}
  /** Per-frame visual updates: count-up text, breathing glows, stars. */
  protected refresh(): void {}
  /** Per-frame particle emission. */
  protected emit(_dt: number): void {}

  // ------------------------------------------------------------------
  // result parsing (gameover.py:267-364)
  // ------------------------------------------------------------------

  private num(key: string, fallback = 0): number {
    const v = this.result[key];
    if (v === null || v === undefined) return fallback;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  private readResult(): void {
    const raw = this.game.lastResult;
    this.result = raw && typeof raw === "object" ? { ...raw } : {};

    const fallbackIndex = Math.trunc(this.game.levelIndex || 0);
    this.levelIndex = Math.trunc(
      clamp(this.num("levelIndex", fallbackIndex), 0, LEVEL_COUNT - 1),
    );
    this.resultLevel = this.levelIndex;
    const level = getLevel(this.levelIndex);

    const name = this.result["levelName"];
    this.levelName = typeof name === "string" && name ? name : level.name;
    this.score = Math.max(0, Math.trunc(this.num("score")));
    this.goalFood = Math.max(1, Math.trunc(this.num("goalFood", level.goalFood)));
    this.foodEaten = Math.max(0, Math.trunc(this.num("foodEaten")));
    this.stars = Math.trunc(clamp(this.num("stars"), 0, 3));
    this.maxCombo = Math.max(0, Math.trunc(this.num("maxCombo")));
    this.deaths = Math.max(0, Math.trunc(this.num("deaths")));
    this.elapsed = Math.max(0, this.num("elapsed"));
    this.newBest = !!this.result["newBest"];

    this.mode = this.readMode();
    const dv = this.result["difficulty"];
    this.diff = getDifficulty(typeof dv === "string" ? dv : this.game.difficulty);
    this.derive();
  }

  /**
   * Which mode the finished run belonged to (gameover.py:301-328).
   *
   * The result is authoritative because the run wrote it. A dict that carries
   * neither `mode` nor `story` is not a campaign result, so it reads as free
   * play - the harmless reading, since free play never routes into narrative.
   * `game.mode` is consulted only on a cold entry with no result at all.
   */
  private readMode(): string {
    const raw = this.result["mode"];
    if (typeof raw === "string") {
      const key = raw.trim().toLowerCase();
      if (GAME_MODES.includes(key)) return key;
    }
    const flag = this.result["story"];
    if (typeof flag === "boolean") return flag ? C.MODE_STORY : C.MODE_FREE;
    if (Object.keys(this.result).length > 0) return C.MODE_FREE;
    const live = String(this.game.mode ?? "").trim().toLowerCase();
    return GAME_MODES.includes(live) ? live : C.MODE_FREE;
  }

  /** Recompute everything that follows from the level index. */
  private derive(): void {
    const level = getLevel(this.levelIndex);
    this.final = this.levelIndex >= LEVEL_COUNT - 1;
    this.nextIndex = this.final ? this.levelIndex : this.levelIndex + 1;
    this.starTargets = this.readTargets(level);
    this.par = Math.max(1, Math.trunc(this.starTargets[0]));
  }

  /**
   * The difficulty-adjusted star thresholds: the run's own when they belong to
   * the level on screen, else rebuilt so a hand-built result still gets an
   * honest par.
   */
  private readTargets(level: ReturnType<typeof getLevel>): readonly [number, number, number] {
    if (this.resultLevel === this.levelIndex) {
      const raw = this.result["starTargets"];
      if (Array.isArray(raw)) {
        const vals = raw.slice(0, 3).map((v) => Math.trunc(Number(v)));
        if (
          vals.length === 3 &&
          vals.every(Number.isFinite) &&
          vals[0]! > 0 &&
          vals[0]! <= vals[1]! &&
          vals[1]! <= vals[2]!
        ) {
          return [vals[0]!, vals[1]!, vals[2]!];
        }
      }
    }
    return applyStarTargets(this.diff, level.starTargets);
  }

  // ------------------------------------------------------------------
  // mode / story helpers (gameover.py:366-396)
  // ------------------------------------------------------------------

  protected get isStory(): boolean {
    return this.mode === C.MODE_STORY;
  }

  protected beatSeen(index: number): boolean {
    return !!this.save.beatSeen(Math.trunc(index));
  }

  /** Remember that a level's narrative has been shown. Refuses 12+, so the
   * hand-off can never stamp mode select's prologue flag as read. */
  protected markBeat(index: number): void {
    const idx = Math.trunc(index);
    if (Number.isFinite(idx) && idx >= 0 && idx <= MAX_BEAT) {
      this.save.markBeatSeen(idx);
    }
  }

  /** Persist the profile; `flush` is a no-op when nothing is dirty. */
  protected flushSave(): void {
    try {
      this.save.flush();
    } catch {
      // A results screen must never fail because the profile could not be
      // written.
    }
  }

  // ------------------------------------------------------------------
  // lifecycle
  // ------------------------------------------------------------------

  override onEnter(args?: SceneEnterArgs): void {
    // Subclass state resets unconditionally, before anything that can fail -
    // a stale `_stars_shown` would silently eat every chime (scenes.md §7.2).
    this.resetSceneState();
    // Destroy the previous entry's row now: in Pixi the orphaned buttons would
    // stay parented and keep drawing under the new ones.
    for (const b of this.buttons) {
      this.buttonLayer.removeChild(b.root);
      b.destroy();
    }
    this.buttons = [];

    try {
      this.readResult();
      // A kwarg wins over the handoff dict, if a caller bothers to pass one.
      const kw = args?.["levelIndex"];
      if (typeof kw === "number" && Number.isFinite(kw)) {
        this.levelIndex = Math.trunc(clamp(kw, 0, LEVEL_COUNT - 1));
        this.derive();
      }
      // Session state written on the way IN, so any scene reached without an
      // explicit level still sees the level that was just played.
      this.game.levelIndex = this.levelIndex;

      this.t = 0;
      this.theme = this.buildTheme();
      // The next transition wipe is tinted by THIS theme - muted for game
      // over. That is the shipped Python behaviour (scenes.md §6.17 Q4).
      this.game.post.fx.setTheme(this.theme);
      this.ensureBackground();
      this.layoutVeil();
      this.buttons = this.buildButtons();
      for (const b of this.buttons) this.buttonLayer.addChild(b.root);
      // Clear BEFORE onReady: victory's entry firework is emitted there, and
      // reversing these two lines deletes it (scenes.md §8.3).
      this.game.particles.clear();
      this.root.addChildAt(
        this.game.particles.root,
        this.root.getChildIndex(this.bodyLayer),
      );
      this.applyStaticContent();
      this.onReady();
      // The zero state - counters at 0, stars as outlines - must be on screen
      // for the first drawn frame, which gets no update (scenes.md §6.5).
      this.refresh();
      for (const b of this.buttons) b.draw(this.theme, this.game.time);
    } catch (err) {
      // A results screen that fails to build still has to be escapable.
      console.warn("[result] onEnter failed", err);
      if (this.buttons.length === 0) {
        const fallback = new Button(
          this.game.fonts,
          [490, 620, 300, C.UI_BUTTON_H],
          "MENU",
          { style: "ghost", data: "menu" },
        );
        this.buttons.push(fallback);
        this.buttonLayer.addChild(fallback.root);
        fallback.draw(this.theme, this.game.time);
      }
    }
  }

  override onExit(): void {
    this.game.particles.clear();
    if (this.game.particles.root.parent === this.root) {
      this.root.removeChild(this.game.particles.root);
    }
  }

  override onResize(): void {
    // The backdrop and veil fill overscan, not the design box - a veil sized
    // 1280x720 would leave undimmed bands either side on a 19.5:9 phone.
    const o = this.game.viewport.overscan;
    if (
      this.bg &&
      (o.x !== this.bgRect.x ||
        o.y !== this.bgRect.y ||
        o.w !== this.bgRect.w ||
        o.h !== this.bgRect.h)
    ) {
      this.dropBackground();
      this.ensureBackground();
    }
    this.layoutVeil();
  }

  // ------------------------------------------------------------------
  // backdrop
  // ------------------------------------------------------------------

  /**
   * Build (or reuse) the scrolling backdrop. Pre-rendering is expensive, so it
   * is rebuilt only when the style or theme actually changed - a new level,
   * not a retry of the same one. GameOverScene always passes the muted theme,
   * so its cache can never hand back a full-strength backdrop (the two result
   * scenes are separate cached instances with separate caches).
   */
  private ensureBackground(): void {
    const style = this.theme.bgStyle;
    const key = this.theme.name;
    if (this.bg && style === this.bgStyle && key === this.bgThemeName) return;
    this.dropBackground();
    const renderer = this.game.app?.renderer;
    if (!renderer) return;
    try {
      const rect = { ...this.game.viewport.overscan };
      this.bg = makeBackground(style, this.theme, rect, renderer);
      this.bgRect = rect;
      this.bgStyle = style;
      this.bgThemeName = key;
      this.bgLayer.addChild(this.bg.root);
    } catch (err) {
      console.warn("[result] background unavailable", err);
      this.bg = null;
    }
  }

  private dropBackground(): void {
    if (this.bg) {
      this.bgLayer.removeChild(this.bg.root);
      this.bg.destroy();
      this.bg = null;
    }
    this.bgStyle = "";
    this.bgThemeName = "";
  }

  /** A flat wash that pushes the backdrop behind the summary text. */
  private layoutVeil(): void {
    this.veil.clear();
    if (this.veilAlpha <= 0) return;
    const o = this.game.viewport.overscan;
    this.veil
      .rect(o.x, o.y, o.w, o.h)
      .fill({
        color: toHex(shade(this.theme.bgBottom, 0.6)),
        alpha: clamp(this.veilAlpha, 0, 255) / 255,
      });
  }

  // ------------------------------------------------------------------
  // count-up (gameover.py:485-491)
  // ------------------------------------------------------------------

  /** 0..1 easing weight driving every rolling number on the screen. */
  protected countFrac(): number {
    return easeOutCubic(clamp((this.t - COUNT_DELAY) / COUNT_TIME, 0, 1));
  }

  /** `value` scaled by the count-up weight, floored like an odometer. */
  protected counted(value: number): number {
    return Math.trunc(value * this.countFrac() + 0.0001);
  }

  // ------------------------------------------------------------------
  // button rows (gameover.py:452-461)
  // ------------------------------------------------------------------

  /** Lay a horizontal row of buttons out, centred on the canvas. */
  protected row(specs: readonly ButtonSpec[], y: number, width: number, gap = 24): Button[] {
    if (!specs.length) return [];
    const total = width * specs.length + gap * (specs.length - 1);
    const x0 = (C.WINDOW_W - total) * 0.5;
    return specs.map(
      ([label, style, action], i) =>
        new Button(
          this.game.fonts,
          [x0 + i * (width + gap), y, width, C.UI_BUTTON_H],
          label,
          { style, data: action },
        ),
    );
  }

  // ------------------------------------------------------------------
  // actions (gameover.py:494-544)
  // ------------------------------------------------------------------

  protected go(key: string, args?: SceneEnterArgs): void {
    if (!this.game.registeredScenes().includes(key)) return;
    this.game.switchScene(key, args);
  }

  /** Run the action attached to a button's `data`. */
  protected act(action: unknown): void {
    if (typeof action === "function") {
      (action as () => void)();
      return;
    }
    const key = String(action);
    if (key === "retry") {
      this.game.levelIndex = this.levelIndex;
      this.go(SCENES.GAME, { level: this.levelIndex });
    } else if (key === "next") {
      const nxt = Math.trunc(clamp(this.nextIndex, 0, LEVEL_COUNT - 1));
      this.game.levelIndex = nxt;
      this.go(SCENES.GAME, { level: nxt });
    } else if (key === "story") {
      this.storyContinue();
    } else if (key === "levels") {
      this.go(SCENES.LEVELS);
    } else if (key === "menu") {
      this.go(SCENES.MENU);
    }
  }

  /** Overridden by VictoryScene; a safe escape everywhere else. */
  protected storyContinue(): void {
    this.go(SCENES.MENU);
  }

  /** Every action currently reachable by mouse - keys mirror these only. */
  private actions(): Set<string> {
    const out = new Set<string>();
    for (const b of this.buttons) {
      if (b.enabled && typeof b.data === "string") out.add(b.data);
    }
    return out;
  }

  // ------------------------------------------------------------------
  // per-frame (gameover.py:547-596)
  // ------------------------------------------------------------------

  override update(dt: number): void {
    const d = clamp(dt, 0, C.MAX_DT);

    // Events before the update, matching Python's pump-then-update order: a
    // move must write `hovered` before `justEntered` is computed, and a tap
    // can press and release inside one frame.
    let fired: unknown = null;
    for (const ev of this.game.uiEvents) {
      for (const b of this.buttons) {
        if (b.handlePointer(ev) && fired === null) fired = b.data;
      }
    }
    if (fired === null) fired = this.keyAction();

    // Real dt throughout: this is a shell-level screen, and a slow-mo left
    // over from the killing blow must not stretch the count-up.
    this.t += d;
    this.bg?.update(d);
    for (const b of this.buttons) {
      b.update(d, this.game.pointer);
      if (b.justEntered) this.sound?.play("hover", 0.6);
      b.draw(this.theme, this.game.time);
    }
    this.emit(d);
    this.refresh();

    if (fired !== null) {
      this.sound?.play("click");
      this.act(fired);
    }
  }

  /** Keyboard shortcuts - strictly a mirror of what is on screen, except the
   * Enter branch, which fires the first enabled button whatever its data. */
  private keyAction(): unknown {
    const available = this.actions();
    for (const ev of this.game.keyEvents) {
      if (ev.type !== "down" || ev.repeat) continue;
      if (ev.key === "Escape" && available.has("menu")) return "menu";
      if (ev.key === "l" && available.has("levels")) return "levels";
      if (ev.key === "r" && available.has("retry")) return "retry";
      if (ev.key === "Enter" || ev.key === " ") {
        for (const b of this.buttons) if (b.enabled) return b.data;
      }
    }
    return null;
  }

  // ------------------------------------------------------------------
  // shared drawing helpers (gameover.py:637-699)
  // ------------------------------------------------------------------

  /** The badge colour: the run's own, falling back to the table's. */
  protected diffColor(): RGB {
    const raw = this.result["difficultyColor"];
    if (Array.isArray(raw) && raw.length >= 3) {
      const r = Number(raw[0]);
      const g = Number(raw[1]);
      const b = Number(raw[2]);
      if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
        return [Math.trunc(r) & 0xff, Math.trunc(g) & 0xff, Math.trunc(b) & 0xff];
      }
    }
    return this.diff.color as RGB;
  }

  /** The badge text, e.g. `EXPERT`. */
  protected diffLabel(): string {
    const raw = this.result["difficultyLabel"] ?? this.result["difficultyName"];
    if (typeof raw === "string" && raw.trim()) return raw.trim().toUpperCase();
    return String(this.diff.hudLabel).toUpperCase();
  }

  /** Configure the coloured difficulty chip both screens carry. */
  protected setBadge(badge: Badge, muted = false): void {
    let color = this.diffColor();
    if (muted) color = mute(color, 0.3, 0.9);
    badge.set(this.diffLabel(), color, muted ? 0.16 : 0.34);
  }

  /**
   * `NORMAL PAR 140   (+165)` - the score against the adjusted par. Three
   * spaces before the parenthesis. Does NOT count up: it shows the final
   * delta from t = 0 while the score above it is still rolling.
   */
  protected setParLine(label: Label): void {
    const delta = this.score - this.par;
    label.set(`${this.diffLabel()} PAR ${grouped(this.par)}   (${fmtDelta(delta)})`);
    label.setColor(
      delta >= 0 ? UI_GOOD : lerpColor(this.theme.textDim, UI_WARN, 0.45),
    );
  }

  /** `CHAPTER II   -   LEVEL 05` in story mode, `LEVEL 05` otherwise. */
  protected chapterLine(): string {
    const base = `LEVEL ${String(this.levelIndex + 1).padStart(2, "0")}`;
    if (!this.isStory) return base;
    const raw = this.result["chapterRoman"];
    let roman = typeof raw === "string" ? raw.trim() : "";
    if (!roman) roman = getChapter(this.levelIndex).roman();
    return `CHAPTER ${roman}   -   ${base}`;
  }
}
