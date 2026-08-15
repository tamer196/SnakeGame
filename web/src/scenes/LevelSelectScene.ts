/**
 * The campaign map - a port of `snake/scenes/level_select.py`.
 *
 * Pick a difficulty, pick a level, see what it pays. Three columns by four
 * rows, one chapter per row, with the chapter band living in the left gutter.
 *
 * Each card is drawn with **that level's own theme**, so the grid reads as
 * twelve swatches of twelve different stages rather than twelve copies of one
 * card. The focused card's theme drives every other accent on the screen,
 * including the backdrop.
 *
 * Records are per difficulty and are cached rather than queried per frame -
 * twelve cards times two lookups times sixty frames is work with no reason to
 * exist. Changing the switcher re-reads the whole grid and replays the
 * entrance at a fraction of its speed, so the change of numbers reads as a
 * re-read rather than a silent swap.
 *
 * BACK is deliberately not in the top-left corner: the finished frame goes
 * through the CRT bezel, which passes only about 4% of the light there, and
 * the only mouse route off this screen was effectively invisible.
 */

import { Container, Graphics, Sprite } from "pixi.js";

import type { Game } from "../app/Game";
import { Scene, SCENES } from "../app/Scene";
import * as C from "../core/config";
import { clamp, easeOutCubic, pulse } from "../core/mathx";
import * as D from "../core/difficulty";
import { LEVEL_COUNT, getLevel, type LevelDef } from "../core/level";
import {
  UI_GOLD,
  UI_GOOD,
  UI_PANEL,
  UI_WARN,
  UI_WHITE,
  lerpColor,
  rainbow,
  shade,
  themeForLevel,
  toHex,
  type RGB,
  type Theme,
} from "../core/palette";
import type { SaveData } from "../core/save";
import { getChapter } from "../core/story";
import type { Audio } from "../audio";
import { makeBackground, type Background } from "../gfx/bg";
import { Bar } from "../ui/bar";
import { Button } from "../ui/Button";
import { arcPath, setUiGlow, uiGlowSprite } from "../ui/glow";
import { Panel } from "../ui/panel";
import { Label } from "../ui/text";
import { wrapText } from "../ui/wrap";

/** Grid geometry. level_select.py:57-73 */
const COLS = 3;
const ROWS = 4;
const BAND_X = 36;
const BAND_W = 168;
const GRID_LEFT = 216;
const GRID_TOP = 100;
const CARD_W = 329;
const CARD_H = 104;
const CARD_GAP_X = 20;
const CARD_GAP_Y = 16;
const DETAIL_RECT = { x: 48, y: 586, w: C.WINDOW_W - 96, h: 98 };
/** Sat on the grid's left edge, clear of the bezel's corner cut. level_select.py:76-84 */
const BACK_RECT = { x: 216, y: 48, w: 148, h: 42 };

/** The difficulty switcher. level_select.py:87-93 */
const DIFF_TILE_W = 112;
const DIFF_TILE_H = 36;
const DIFF_TILE_GAP = 10;
const DIFF_ROW_Y = 52;
const DIFF_ROW_W = DIFF_TILE_W * 4 + DIFF_TILE_GAP * 3;
const DIFF_ROW_X = Math.floor((C.WINDOW_W - DIFF_ROW_W) / 2);

/** Entrance. level_select.py:96-103 */
const INTRO_STAGGER = 0.05;
const INTRO_TIME = 0.42;
const INTRO_RISE = 44.0;
/** Entrance timings scale by this when the grid is merely refreshing. */
const REFRESH_SCALE = 0.45;

/** Per-card labels: number, name, subtitle, tag, goal, best-caption, best, locked-caption, locked-hint. */
const CARD_LABELS = 9;
/** Per-band labels: chapter, two title lines, level range, status. */
const BAND_LABELS = 5;

/** One difficulty's worth of save data for a single card. */
class LevelRecord {
  constructor(
    readonly best: number,
    readonly stars: number,
    readonly unlocked: boolean,
  ) {}

  /** True once the level has ever been finished on this difficulty. */
  get cleared(): boolean {
    return this.stars > 0 || this.best > 0;
  }

  /** True for a full three-star clear - the celebratory state. */
  get perfect(): boolean {
    return this.stars >= 3;
  }
}

const EMPTY_RECORD = new LevelRecord(0, 0, false);

/** The ten vertices of a five-pointed star centred on (cx, cy). */
function starPoints(cx: number, cy: number, r: number): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < 10; i++) {
    // Alternate between the outer points and the inner waist.
    const rad = i % 2 === 0 ? r : r * 0.42;
    const ang = -Math.PI * 0.5 + i * (Math.PI / 5);
    pts.push([cx + Math.cos(ang) * rad, cy + Math.sin(ang) * rad]);
  }
  return pts;
}

/** One level tile: its button, its resting place and its entrance timer. */
class Card {
  appear = 0;
  hoverT = 0;
  pressT = 0;

  constructor(
    readonly index: number,
    readonly level: LevelDef,
    readonly button: Button,
    readonly home: { x: number; y: number; w: number; h: number },
    readonly delay: number,
  ) {}

  reset(): void {
    this.appear = 0;
    this.hoverT = 0;
    this.pressT = 0;
    this.button.rect.x = this.home.x;
    this.button.rect.y = this.home.y;
  }
}

export class LevelSelectScene extends Scene {
  readonly root = new Container();

  private readonly save: SaveData;
  private readonly sound: Audio | null;

  private readonly cards: Card[] = [];
  private readonly diffTiles: Array<{ diff: D.Difficulty; button: Button }> = [];
  private readonly back: Button;

  private focus = 0;
  private elapsed = 0;
  private records = new Map<number, LevelRecord>();
  private diffKey: string = C.DEFAULT_DIFFICULTY;
  private diffHover: string | null = null;
  private introScale = 1;
  private refreshT = 0;
  private launching = 0;

  private bg: Background | null = null;
  private bgStyle = "";
  private readonly bgLayer = new Container();
  private readonly art = new Graphics();

  private readonly starBar = new Bar();
  private readonly detail = new Panel();

  private readonly headerLabels: Label[] = [];
  private readonly diffLabels: Label[] = [];
  private readonly bandLabels: Label[] = [];
  private readonly cardLabels: Label[] = [];
  private readonly detailLabels: Label[] = [];

  private readonly numberGlows: Sprite[] = [];
  private readonly perfectGlows: Sprite[] = [];
  private readonly sparkGlows: Sprite[] = [];
  private readonly cardStarGlows: Sprite[] = [];
  private readonly diffGlows: Sprite[] = [];
  private readonly detailStarGlows: Sprite[] = [];
  private readonly headerStarGlow: Sprite;

  constructor(game: Game, save: SaveData, sound: Audio | null = null) {
    super(game);
    this.save = save;
    this.sound = sound;
    const fonts = game.fonts;

    for (let i = 0; i < Math.min(LEVEL_COUNT, COLS * ROWS); i++) {
      const col = i % COLS;
      const row = Math.floor(i / COLS);
      const home = {
        x: GRID_LEFT + col * (CARD_W + CARD_GAP_X),
        y: GRID_TOP + row * (CARD_H + CARD_GAP_Y),
        w: CARD_W,
        h: CARD_H,
      };
      // The label is drawn by this scene, not by the Button: an empty label
      // keeps Button.draw from stamping text over the card art.
      const button = new Button(fonts, home, "", { style: "tile", data: i });
      // A diagonal wave reads better than a raw reading-order stagger.
      this.cards.push(new Card(i, getLevel(i), button, home, (col + row) * INTRO_STAGGER));
    }

    D.allDifficulties().forEach((diff, i) => {
      const rect = {
        x: DIFF_ROW_X + i * (DIFF_TILE_W + DIFF_TILE_GAP),
        y: DIFF_ROW_Y,
        w: DIFF_TILE_W,
        h: DIFF_TILE_H,
      };
      // Empty label again: the tile paints its own name in its own colour.
      this.diffTiles.push({
        diff,
        button: new Button(fonts, rect, "", { style: "ghost", data: diff.key }),
      });
    });

    // A size that fits BACK's small rect.
    this.back = new Button(fonts, BACK_RECT, "BACK", {
      style: "ghost",
      data: "back",
      font: fonts.get(18, true),
    });

    this.headerLabels.push(
      new Label(fonts, fonts.displayAt(30)),
      new Label(fonts, fonts.tiny),
      new Label(fonts, fonts.get(19, true)),
    );
    for (let i = 0; i < 4; i++) {
      this.diffLabels.push(new Label(fonts, fonts.get(16, true)));
      this.diffGlows.push(uiGlowSprite(34, UI_WHITE, 0));
    }
    for (let r = 0; r < ROWS; r++) {
      this.bandLabels.push(
        new Label(fonts, fonts.tiny),
        new Label(fonts, fonts.get(17, true)),
        new Label(fonts, fonts.get(17, true)),
        new Label(fonts, fonts.tiny),
        new Label(fonts, fonts.tiny),
      );
    }
    for (let i = 0; i < this.cards.length; i++) {
      this.cardLabels.push(
        new Label(fonts, fonts.displayAt(32)),
        new Label(fonts, fonts.get(19, true)),
        new Label(fonts, fonts.tiny),
        new Label(fonts, fonts.tiny),
        new Label(fonts, fonts.tiny),
        new Label(fonts, fonts.tiny),
        new Label(fonts, fonts.get(20, true)),
        new Label(fonts, fonts.get(17, true)),
        new Label(fonts, fonts.tiny),
      );
      this.numberGlows.push(uiGlowSprite(34, UI_WHITE, 0));
      this.perfectGlows.push(uiGlowSprite(120, UI_WHITE, 0));
      this.sparkGlows.push(uiGlowSprite(12, UI_WHITE, 0), uiGlowSprite(12, UI_WHITE, 0));
      for (let s = 0; s < 3; s++) this.cardStarGlows.push(uiGlowSprite(26, UI_WHITE, 0));
    }
    this.detailLabels.push(
      new Label(fonts, fonts.tiny),
      new Label(fonts, fonts.get(26, true)),
      new Label(fonts, fonts.small),
      new Label(fonts, fonts.tiny),
      new Label(fonts, fonts.tiny),
      new Label(fonts, fonts.tiny),
      new Label(fonts, fonts.tiny),
      new Label(fonts, fonts.small),
      new Label(fonts, fonts.tiny),
      new Label(fonts, fonts.get(18)),
      new Label(fonts, fonts.get(18)),
      new Label(fonts, fonts.tiny),
    );
    for (let i = 0; i < 3; i++) this.detailStarGlows.push(uiGlowSprite(22, UI_WHITE, 0));
    this.headerStarGlow = uiGlowSprite(24, UI_WHITE, 0);

    this.root.addChild(this.bgLayer);
    for (const s of this.perfectGlows) this.root.addChild(s);
    for (const c of this.cards) this.root.addChild(c.button.root);
    for (const d of this.diffTiles) this.root.addChild(d.button.root);
    for (const s of [
      ...this.numberGlows,
      ...this.sparkGlows,
      ...this.cardStarGlows,
      ...this.diffGlows,
      ...this.detailStarGlows,
      this.headerStarGlow,
    ]) {
      this.root.addChild(s);
    }
    this.root.addChild(this.art, this.starBar, this.back.root, this.detail);
    for (const l of [
      ...this.headerLabels,
      ...this.diffLabels,
      ...this.bandLabels,
      ...this.cardLabels,
      ...this.detailLabels,
    ]) {
      this.root.addChild(l);
    }
    this.starBar.setRect(C.WINDOW_W - 36 - 220, 48, 220, 9);
    this.detail.setRect(DETAIL_RECT.x, DETAIL_RECT.y, DETAIL_RECT.w, DETAIL_RECT.h);
  }

  // -------------------------------------------------------------------
  // lifecycle
  // -------------------------------------------------------------------

  override onEnter(args?: Record<string, unknown>): void {
    this.elapsed = 0;
    this.launching = 0;
    this.diffHover = null;
    this.refreshT = 0;
    this.introScale = 1;

    this.diffKey = D.getDifficulty(this.game.difficulty).key;
    this.refreshRecords();

    for (const card of this.cards) {
      card.reset();
      card.button.setEnabled(this.record(card.index).unlocked);
    }
    for (const tile of this.diffTiles) {
      tile.button.setEnabled(false);
      tile.button.setEnabled(true);
    }
    this.back.rect.x = BACK_RECT.x;
    this.back.rect.y = BACK_RECT.y;
    this.back.setEnabled(false);
    this.back.setEnabled(true);

    // Focus whatever the player was last playing, if it is reachable.
    const wantRaw = args?.["levelIndex"];
    const want = Math.trunc(typeof wantRaw === "number" ? wantRaw : this.game.levelIndex);
    this.focus = this.record(want).unlocked ? want : this.highestUnlocked();
    this.ensureBackground();
  }

  override onExit(): void {
    // Backgrounds are large pre-rendered layers; drop ours on the way out so a
    // long session does not keep twelve alive.
    this.bg?.destroy();
    this.bg = null;
    this.bgStyle = "";
  }

  override onResize(): void {
    this.bg?.destroy();
    this.bg = null;
    this.bgStyle = "";
    this.ensureBackground();
  }

  /** The focused level's theme drives every accent on this screen. */
  private get theme(): Theme {
    return getLevel(this.focus)?.theme ?? themeForLevel(0);
  }

  private get diff(): D.Difficulty {
    return D.getDifficulty(this.diffKey);
  }

  /** Rebuild the backdrop only when the focused style actually changes. */
  private ensureBackground(): void {
    const theme = this.theme;
    const style = theme.bgStyle;
    if (this.bg && style === this.bgStyle) return;
    const renderer = this.game.app?.renderer;
    if (!renderer) return;
    this.bg?.destroy();
    try {
      this.bg = makeBackground(style, theme, { ...this.game.viewport.overscan }, renderer);
      this.bgLayer.addChild(this.bg.root);
      this.bgStyle = style;
    } catch (err) {
      console.warn("[levels] background unavailable", err);
      this.bg = null;
      this.bgStyle = "";
    }
  }

  // -------------------------------------------------------------------
  // records
  // -------------------------------------------------------------------

  /**
   * Re-read every card's best score and star count for the active difficulty.
   *
   * Runs on entry and again whenever the switcher moves. Cached rather than
   * queried per frame.
   */
  private refreshRecords(): void {
    const key = this.diffKey;
    const records = new Map<number, LevelRecord>();
    for (let i = 0; i < LEVEL_COUNT; i++) {
      records.set(
        i,
        new LevelRecord(this.save.bestFor(i, key), this.save.starsFor(i, key), this.save.isUnlocked(i)),
      );
    }
    this.records = records;
  }

  private record(index: number): LevelRecord {
    return this.records.get(Math.trunc(index)) ?? EMPTY_RECORD;
  }

  private highestUnlocked(): number {
    let best = 0;
    for (const card of this.cards) if (this.record(card.index).unlocked) best = card.index;
    return best;
  }

  private cue(name: string, volume = 1.0): void {
    this.sound?.play(name, volume);
  }

  // -------------------------------------------------------------------
  // actions
  // -------------------------------------------------------------------

  /**
   * Adopt a difficulty and re-read the whole grid.
   *
   * Persisted immediately, because a player who picks EXPERT here and quits
   * from the menu should still be on EXPERT next launch.
   */
  private setDifficulty(key: string): void {
    const newKey = D.getDifficulty(key).key;
    if (newKey === this.diffKey) {
      this.cue("click", 0.5);
      return;
    }
    this.diffKey = newKey;
    this.cue("click");
    this.game.difficulty = newKey;
    this.save.setDifficulty(newKey);

    this.refreshRecords();
    this.elapsed = 0;
    this.introScale = REFRESH_SCALE;
    this.refreshT = 1;
    for (const card of this.cards) {
      card.reset();
      card.button.setEnabled(this.record(card.index).unlocked);
    }
    this.game.post.fx.flash(this.diff.color, 0.18);
  }

  private moveFocus(step: number): void {
    const target = Math.trunc(clamp(this.focus + step, 0, Math.max(0, this.cards.length - 1)));
    if (target === this.focus) return;
    this.focus = target;
    this.ensureBackground();
    this.cue("hover", 0.5);
  }

  private goBack(): void {
    this.cue("click");
    if (this.game.registeredScenes().includes(SCENES.MENU)) {
      this.game.switchScene(SCENES.MENU);
    }
  }

  /** Launch a level. Locked cards never reach here - their button is disabled. */
  private choose(card: Card): void {
    if (!card.button.enabled || !this.record(card.index).unlocked) {
      this.cue("hit", 0.5);
      return;
    }
    this.focus = card.index;
    this.cue("start");
    const theme = card.level.theme;
    const r = card.button.rect;
    this.game.particles.burst(r.x + r.w * 0.5, r.y + r.h * 0.5, theme.accent, {
      count: 30,
      speed: [90, 320],
      life: [0.35, 0.85],
    });
    this.game.post.fx.flash(theme.accent, 0.35);
    this.launching = 0.12; // a beat of dead input before the wipe
    // Picking a level from this screen is free play by definition.
    this.game.mode = C.MODE_FREE;
    this.game.levelIndex = card.index;
  }

  // -------------------------------------------------------------------
  // frame
  // -------------------------------------------------------------------

  override update(dt: number): void {
    const d = clamp(dt, 0, 0.1);
    this.elapsed += d;
    this.refreshT = Math.max(0, this.refreshT - d * 1.6);

    // Input is dead during the launch wipe.
    if (this.launching <= 0) {
      for (const ev of this.game.uiEvents) {
        for (const tile of this.diffTiles) {
          if (tile.button.handlePointer(ev)) this.setDifficulty(tile.diff.key);
        }
        for (const card of this.cards) {
          if (card.button.handlePointer(ev)) this.choose(card);
        }
        if (this.back.handlePointer(ev)) this.goBack();
      }
      for (const ev of this.game.keyEvents) {
        if (ev.type !== "down" || ev.repeat) continue;
        const k = ev.key;
        if (k === "Escape" || k === "Backspace") this.goBack();
        else if (k === "Enter" || k === " ") {
          const card = this.cards.find((c) => c.index === this.focus);
          if (card) this.choose(card);
        } else if (k === "q" || k === "[") this.setDifficulty(D.prevDifficulty(this.diffKey));
        else if (k === "e" || k === "]" || k === "Tab") {
          this.setDifficulty(D.nextDifficulty(this.diffKey));
        } else if (k === "ArrowLeft" || k === "a") this.moveFocus(-1);
        else if (k === "ArrowRight" || k === "d") this.moveFocus(1);
        else if (k === "ArrowUp" || k === "w") this.moveFocus(-COLS);
        else if (k === "ArrowDown" || k === "s") this.moveFocus(COLS);
      }
    }

    const held = this.game.pointer.down;
    // The same exponential rates Button uses, so painted content tracks the
    // body art the button paints.
    const kHover = 1 - Math.exp(-13.0 * d);
    const kPress = 1 - Math.exp(-22.0 * d);
    const scale = Math.max(0.05, this.introScale);

    let hoveredIndex = -1;
    for (const card of this.cards) {
      const span = Math.max(0.001, INTRO_TIME * scale);
      card.appear = clamp((this.elapsed - card.delay * scale) / span, 0, 1);
      const rise = (1 - easeOutCubic(card.appear)) * INTRO_RISE * scale;
      card.button.rect.x = card.home.x;
      card.button.rect.y = card.home.y + rise;

      card.button.update(d, this.game.pointer);
      if (card.button.justEntered) this.cue("hover", 0.55);
      if (card.button.hovered) hoveredIndex = card.index;

      card.hoverT += ((card.button.hovered ? 1 : 0) - card.hoverT) * kHover;
      card.pressT += ((card.button.hovered && held ? 1 : 0) - card.pressT) * kPress;
    }

    if (hoveredIndex >= 0 && hoveredIndex !== this.focus) {
      this.focus = hoveredIndex;
      this.ensureBackground();
    }

    this.diffHover = null;
    for (const tile of this.diffTiles) {
      tile.button.update(d, this.game.pointer);
      if (tile.button.justEntered) this.cue("hover", 0.55);
      if (tile.button.hovered) this.diffHover = tile.diff.key;
    }

    this.back.update(d, this.game.pointer);
    if (this.back.justEntered) this.cue("hover", 0.55);

    this.bg?.update(d, { x: C.WINDOW_W * 0.5, y: C.WINDOW_H * 0.5 });
    this.draw();

    if (this.launching > 0) {
      this.launching -= d;
      if (this.launching <= 0) {
        this.launching = 0;
        if (this.game.registeredScenes().includes(SCENES.GAME)) {
          this.game.switchScene(SCENES.GAME, { level: this.game.levelIndex });
        }
      }
    }
  }

  // -------------------------------------------------------------------
  // draw
  // -------------------------------------------------------------------

  private draw(): void {
    const theme = this.theme;
    const t = this.game.time;
    this.art.clear();
    for (const s of [
      ...this.numberGlows,
      ...this.perfectGlows,
      ...this.sparkGlows,
      ...this.cardStarGlows,
      ...this.diffGlows,
      ...this.detailStarGlows,
      this.headerStarGlow,
    ]) {
      s.visible = false;
    }

    this.drawHeader(theme, t);
    this.drawChapterBands(t);
    for (const card of this.cards) {
      const on = card.appear > 0;
      card.button.root.visible = on;
      for (let j = 0; j < CARD_LABELS; j++) {
        this.cardLabels[card.index * CARD_LABELS + j]!.visible = on;
      }
      if (on) this.drawCard(card, t);
    }
    this.back.draw(theme, t);
    this.drawDetail(theme, t);
  }

  /** A translucent rounded wash - the Python composes it on a scratch surface
   * because `pygame.draw` will not alpha-blend onto an opaque canvas. */
  private tint(
    x: number,
    y: number,
    w: number,
    h: number,
    color: RGB,
    alpha: number,
    corner: number,
  ): void {
    if (w < 2 || h < 2) return;
    this.art
      .roundRect(x, y, w, h, corner)
      .fill({ color: toHex(color), alpha: clamp(alpha, 0, 255) / 255 });
  }

  private drawStar(
    cx: number,
    cy: number,
    r: number,
    filled: boolean,
    color: RGB,
    glow: number,
    glowSprite: Sprite | null,
  ): void {
    if (glow > 0.01 && glowSprite) {
      glowSprite.position.set(cx, cy);
      setUiGlow(glowSprite, r * 2.6, color, glow);
    }
    const pts = starPoints(cx, cy, r);
    this.art.moveTo(pts[0]![0], pts[0]![1]);
    for (let i = 1; i < pts.length; i++) this.art.lineTo(pts[i]![0], pts[i]![1]);
    this.art.closePath();
    if (filled) {
      this.art.fill({ color: toHex(color) });
      this.art.moveTo(pts[0]![0], pts[0]![1]);
      for (let i = 1; i < pts.length; i++) this.art.lineTo(pts[i]![0], pts[i]![1]);
      this.art
        .closePath()
        .stroke({ color: toHex(lerpColor(color, UI_WHITE, 0.5)), width: 1 });
    } else {
      this.art.stroke({ color: toHex(color), width: 1 });
    }
  }

  private drawHeader(theme: Theme, t: number): void {
    const title = this.headerLabels[0]!;
    title.set("SELECT A LEVEL");
    title.setColor(theme.text);
    title.place(C.WINDOW_W * 0.5, 10, "center");

    this.diffTiles.forEach((tile, i) => this.drawDiffTile(tile, i, theme, t));

    const total = this.save.totalStars(this.diffKey);
    const cap = Math.max(1, this.save.maxStars());
    const frac = clamp(total / cap, 0, 1);
    const diff = this.diff;
    const right = C.WINDOW_W - 36;

    const dl = this.headerLabels[1]!;
    dl.set(D.label(diff));
    dl.setColor(diff.color);
    dl.place(right, 6, "right");

    const sl = this.headerLabels[2]!;
    sl.set(`${total} / ${cap} STARS`);
    sl.setColor(lerpColor(UI_GOLD, UI_WHITE, 0.25 * frac));
    sl.place(right, 22, "right");

    this.starBar.set(frac, UI_GOLD, performance.now());
    // A single trophy star, breathing, anchored to the end of the bar.
    const starC = frac < 1 ? UI_GOLD : rainbow(t * 0.4);
    this.drawStar(right - 240, 53, 9, true, starC, 0.4 + 0.25 * pulse(t, 2.0), this.headerStarGlow);
  }

  private drawDiffTile(
    tile: { diff: D.Difficulty; button: Button },
    slot: number,
    theme: Theme,
    t: number,
  ): void {
    const { button, diff } = tile;
    const selected = diff.key === this.diffKey;
    const r = button.rect;
    button.draw(theme, t);

    const col = diff.color;
    if (selected) {
      this.tint(r.x, r.y, r.w, r.h, col, 70, C.UI_CORNER);
      this.art
        .roundRect(r.x, r.y, r.w, r.h, C.UI_CORNER)
        .stroke({ color: toHex(lerpColor(col, UI_WHITE, 0.35)), width: 2 });
      const g = this.diffGlows[slot]!;
      g.position.set(r.x + r.w * 0.5, r.y + r.h + 2);
      setUiGlow(g, 34, col, 0.3 + 0.18 * pulse(t, 2.2));
      // A hairline under the selected tile ties the row to the grid below.
      this.art
        .moveTo(r.x + 10, r.y + r.h + 4)
        .lineTo(r.x + r.w - 10, r.y + r.h + 4)
        .stroke({ color: toHex(col), width: 2 });
    }

    const hot = selected || button.hovered;
    let textCol = lerpColor(col, UI_WHITE, selected ? 0.55 : button.hovered ? 0.3 : 0);
    if (!hot) textCol = shade(textCol, 0.78);
    const l = this.diffLabels[slot]!;
    l.set(D.label(diff));
    l.setColor(textCol);
    l.place(r.x + r.w * 0.5, r.y + r.h * 0.5 - l.textHeight * 0.5, "center");
  }

  /**
   * Label each row with the chapter that owns it. Rows are chapters by
   * construction - three columns, four rows, twelve levels - so the band for
   * row n is the chapter of level n * COLS.
   */
  private drawChapterBands(t: number): void {
    for (let row = 0; row < ROWS; row++) {
      const first = row * COLS;
      const card = this.cards[first];
      const base = row * BAND_LABELS;
      const appear = card ? clamp(card.appear, 0, 1) : 0;
      const on = !!card && appear > 0.01;
      for (let j = 0; j < BAND_LABELS; j++) this.bandLabels[base + j]!.visible = on;
      if (!card || !on) continue;

      const chapter = getChapter(first);
      const theme = card.level.theme;
      const y = card.button.rect.y;
      const bandRight = BAND_X + BAND_W;

      let done = true;
      let perfect = true;
      for (let i = first; i < first + COLS && i < LEVEL_COUNT; i++) {
        if (!this.record(i).cleared) done = false;
        if (!this.record(i).perfect) perfect = false;
      }
      const accent = perfect ? rainbow(t * 0.3 + row * 0.2) : theme.accent;

      this.tint(BAND_X, y, BAND_W, CARD_H, theme.grid, 120 * appear, C.UI_CORNER);
      this.art
        .moveTo(bandRight - 3, y + 6)
        .lineTo(bandRight - 3, y + CARD_H - 6)
        .stroke({ color: toHex(shade(accent, 0.4 + 0.6 * appear)), width: 3 });

      const dim = shade(theme.textDim, 0.6 + 0.4 * appear);
      const ch = this.bandLabels[base]!;
      ch.set(`CHAPTER ${chapter.roman()}`);
      ch.setColor(accent);
      ch.place(BAND_X + 14, y + 12);

      const fonts = this.game.fonts;
      const lines = wrapText(fonts, fonts.get(17, true), chapter.title, BAND_W - 28, {
        maxLines: 2,
      });
      for (let i = 0; i < 2; i++) {
        const l = this.bandLabels[base + 1 + i]!;
        const text = lines[i];
        l.visible = text !== undefined;
        if (text === undefined) continue;
        l.set(text.toUpperCase());
        l.setColor(theme.text);
        l.place(BAND_X + 14, y + 32 + i * 20);
      }

      const range = this.bandLabels[base + 3]!;
      range.set(
        `LEVELS ${String(chapter.firstIndex + 1).padStart(2, "0")}-${String(
          chapter.lastIndex + 1,
        ).padStart(2, "0")}`,
      );
      range.setColor(dim);
      range.place(BAND_X + 14, y + CARD_H - 26);

      const status = this.bandLabels[base + 4]!;
      status.visible = perfect || done;
      if (perfect) {
        status.set("PERFECT");
        status.setColor(rainbow(t * 0.3 + row * 0.2));
        status.place(bandRight - 14, y + CARD_H - 26, "right");
      } else if (done) {
        status.set("CLEAR");
        status.setColor(UI_GOOD);
        status.place(bandRight - 14, y + CARD_H - 26, "right");
      }
    }
  }

  private drawCard(card: Card, t: number): void {
    const level = card.level;
    const theme = level.theme;
    const rec = this.record(card.index);
    const base = card.index * CARD_LABELS;

    // The tile body is drawn with the *level's own* theme, so each card is a
    // swatch of the stage it launches.
    card.button.draw(theme, t);

    // Mirror Button.draw's hover lift so the text rides with the art.
    const hov = clamp(card.hoverT, 0, 1);
    const press = clamp(card.pressT, 0, 1);
    const r = card.button.rect;
    const bx = r.x;
    const by = r.y + (-3 * hov + 2 * press);
    const right = bx + r.w;

    // Which labels this state uses; the rest are hidden.
    const locked = !rec.unlocked;
    for (let j = 0; j < CARD_LABELS; j++) {
      this.cardLabels[base + j]!.visible = locked ? j === 0 || j === 7 || j === 8 : j !== 7 && j !== 8;
    }

    if (locked) {
      this.tint(bx, by, r.w, r.h, UI_PANEL, 165, C.UI_CORNER + 6);
      const veil = shade(theme.textDim, 0.55);

      const num = this.cardLabels[base]!;
      num.set(String(level.number).padStart(2, "0"));
      num.setColor(shade(theme.accent, 0.45));
      num.place(bx + 14, by + 8);

      this.drawPadlock(bx + r.w * 0.5 + 14, by + r.h * 0.5 - 6, 16, veil);

      const lockLabel = this.cardLabels[base + 7]!;
      lockLabel.set("LOCKED");
      lockLabel.setColor(veil);
      lockLabel.place(bx + r.w * 0.5 + 14, by + r.h - 42, "center");

      const hint = this.cardLabels[base + 8]!;
      hint.set(`CLEAR LEVEL ${String(Math.max(1, level.number - 1)).padStart(2, "0")}`);
      hint.setColor(shade(veil, 0.85));
      hint.place(bx + r.w * 0.5 + 14, by + r.h - 22, "center");
      return;
    }

    const textCol = lerpColor(theme.text, UI_WHITE, 0.25 * hov);
    const dimCol = lerpColor(theme.textDim, theme.text, 0.35 * hov);

    if (rec.perfect) this.drawPerfectRim(bx, by, r.w, r.h, card.index, t);

    const numCol = lerpColor(theme.accent, UI_WHITE, 0.15 + 0.35 * hov);
    if (hov > 0.02) {
      const g = this.numberGlows[card.index]!;
      g.position.set(bx + 38, by + 32);
      setUiGlow(g, 34, theme.accent, 0.25 * hov);
    }
    const num = this.cardLabels[base]!;
    num.set(String(level.number).padStart(2, "0"));
    num.setColor(numCol);
    num.place(bx + 14, by + 8);

    const name = this.cardLabels[base + 1]!;
    name.set(level.name.toUpperCase());
    name.setColor(textCol);
    name.place(bx + 72, by + 10);

    const sub = this.cardLabels[base + 2]!;
    sub.set(level.subtitle);
    sub.setColor(dimCol);
    sub.place(bx + 73, by + 34);

    this.drawStateTag(bx, by, r.w, rec, theme, t, base);

    const lineY = by + 58;
    this.art
      .moveTo(bx + 14, lineY)
      .lineTo(right - 14, lineY)
      .stroke({ color: toHex(shade(theme.grid, 1.4 + 0.6 * hov)), width: 1 });

    for (let i = 0; i < 3; i++) {
      const got = i < rec.stars;
      const col = got
        ? rec.perfect
          ? rainbow(t * 0.35 + i * 0.12)
          : UI_GOLD
        : shade(theme.textDim, 0.55);
      this.drawStar(
        bx + 28 + i * 26,
        by + 80,
        10,
        got,
        col,
        got ? 0.35 + 0.3 * hov : 0,
        this.cardStarGlows[card.index * 3 + i]!,
      );
    }

    const goal = this.cardLabels[base + 4]!;
    goal.set(`${level.goalFood} FOOD`);
    goal.setColor(shade(dimCol, 0.95));
    goal.place(bx + 118, by + 72);

    const bestCap = this.cardLabels[base + 5]!;
    const bestVal = this.cardLabels[base + 6]!;
    if (rec.best > 0) {
      bestCap.visible = true;
      bestVal.visible = true;
      bestCap.set("BEST");
      bestCap.setColor(shade(dimCol, 0.8));
      bestCap.place(right - 14, by + 62, "right");
      bestVal.set(rec.best.toLocaleString("en-US"));
      bestVal.setColor(lerpColor(UI_WHITE, UI_GOLD, 0.35));
      bestVal.place(right - 14, by + 76, "right");
    } else {
      bestCap.visible = true;
      bestVal.visible = false;
      bestCap.set("UNPLAYED");
      bestCap.setColor(shade(dimCol, 0.7));
      bestCap.place(right - 14, by + 72, "right");
    }
  }

  /** The little top-right badge that names the card's state. */
  private drawStateTag(
    bx: number,
    by: number,
    w: number,
    rec: LevelRecord,
    theme: Theme,
    t: number,
    base: number,
  ): void {
    let label: string;
    let col: RGB;
    if (rec.perfect) {
      label = "PERFECT";
      col = rainbow(t * 0.4);
    } else if (rec.cleared) {
      label = "CLEARED";
      col = UI_GOOD;
    } else {
      label = "NEW";
      col = theme.accent2;
    }
    const fonts = this.game.fonts;
    const tagW = fonts.measureWidth(fonts.tiny, label) + 14;
    const tagX = bx + w - 14 - tagW;
    const tagY = by + 10;
    this.tint(tagX, tagY, tagW, 17, col, 55, 6);
    this.art
      .roundRect(tagX, tagY, tagW, 17, 6)
      .stroke({ color: toHex(col), width: 1, alpha: 180 / 255 });

    const l = this.cardLabels[base + 3]!;
    l.set(label);
    l.setColor(lerpColor(col, UI_WHITE, 0.45));
    l.setShadow(false);
    l.place(tagX + tagW * 0.5, tagY + 2, "center");
  }

  /** The celebratory treatment for a full three-star clear. */
  private drawPerfectRim(
    bx: number,
    by: number,
    w: number,
    h: number,
    index: number,
    t: number,
  ): void {
    const col = rainbow(t * 0.3 + index * 0.11);
    const cx = bx + w * 0.5;
    const cy = by + h * 0.5;
    const g = this.perfectGlows[index]!;
    g.position.set(cx, cy);
    setUiGlow(g, Math.max(w, h) * 0.72, col, 0.1 + 0.06 * pulse(t, 1.6));

    this.art
      .roundRect(bx - 3, by - 3, w + 6, h + 6, C.UI_CORNER + 8)
      .stroke({ color: toHex(col), width: 2 });

    // Two sparks orbiting the rim: cheap, and it makes the card sing.
    for (let k = 0; k < 2; k++) {
      const ang = t * 1.1 + k * Math.PI + index;
      const s = this.sparkGlows[index * 2 + k]!;
      s.position.set(cx + Math.cos(ang) * (w * 0.5 + 4), cy + Math.sin(ang) * (h * 0.5 + 4));
      setUiGlow(s, 12, lerpColor(col, UI_WHITE, 0.5), 0.55);
    }
  }

  /** A vector padlock - no font glyph to go missing on some system. */
  private drawPadlock(cx: number, cy: number, size: number, color: RGB): void {
    const c = toHex(color);
    const bw = size * 1.5;
    const bh = size * 1.15;
    const bodyY = cy + size * 0.42 - bh * 0.5;
    this.art.roundRect(cx - bw * 0.5, bodyY, bw, bh, 4).stroke({ color: c, width: 2 });

    const sw = size * 0.95;
    const shackleCy = cy - size * 0.28;
    // pygame's arc is y-up, so 0..pi there is the upper half on screen.
    arcPath(this.art, cx, shackleCy, sw * 0.5, Math.PI, Math.PI * 2).stroke({
      color: c,
      width: 2,
    });
    for (const sx of [-1, 1]) {
      const x = cx + sx * (sw * 0.5) - sx * 1;
      this.art.moveTo(x, shackleCy).lineTo(x, bodyY).stroke({ color: c, width: 2 });
    }
    this.art.circle(cx, bodyY + bh * 0.5, 2).fill({ color: c });
  }

  /**
   * The bottom strip: the focused level, its star ladder on the current
   * difficulty, and either its briefing or - while a switcher tile is hovered -
   * that difficulty's blurb.
   */
  private drawDetail(theme: Theme, t: number): void {
    const fonts = this.game.fonts;
    const level = getLevel(this.focus);
    const rec = this.record(this.focus);
    const diff = this.diff;
    this.detail.setStyle(theme.accent, 224, true, 0.35);

    const x = DETAIL_RECT.x + 22;
    const y = DETAIL_RECT.y + 12;

    const head = this.detailLabels[0]!;
    head.set(`LEVEL ${String(level.number).padStart(2, "0")}   ${getChapter(this.focus).title.toUpperCase()}`);
    head.setColor(theme.accent2);
    head.place(x, y);

    const name = this.detailLabels[1]!;
    name.set(level.name.toUpperCase());
    name.setColor(theme.text);
    name.place(x, y + 16);

    const sub = this.detailLabels[2]!;
    sub.set(level.subtitle);
    sub.setColor(theme.textDim);
    sub.place(x, y + 50);

    // Star thresholds, rescaled for the selected difficulty.
    const targets = D.applyStarTargets(diff, level.starTargets);
    const midX = DETAIL_RECT.x + 372;

    const th = this.detailLabels[3]!;
    th.set(`STAR TARGETS - ${D.label(diff)}`);
    th.setColor(lerpColor(shade(theme.textDim, 0.9), diff.color, 0.55));
    th.place(midX, y + 2);

    targets.forEach((target, i) => {
      const sx = midX + i * 84;
      const got = i < rec.stars;
      const col = got
        ? rec.perfect
          ? rainbow(t * 0.35 + i * 0.12)
          : UI_GOLD
        : shade(theme.textDim, 0.6);
      this.drawStar(sx + 8, y + 30, 8, got, col, got ? 0.35 : 0, this.detailStarGlows[i]!);
      const l = this.detailLabels[4 + i]!;
      l.set(target.toLocaleString("en-US"));
      l.setColor(got ? UI_GOLD : theme.textDim);
      l.place(sx + 22, y + 23);
    });

    const bestLine = this.detailLabels[7]!;
    bestLine.set(
      rec.best ? `BEST ${rec.best.toLocaleString("en-US")}` : `NEVER CLEARED ON ${D.label(diff)}`,
    );
    bestLine.setColor(lerpColor(theme.textDim, UI_WHITE, 0.4));
    bestLine.place(midX, y + 50);

    // Right half: the briefing, the unlock condition, or a difficulty blurb.
    const hintX = DETAIL_RECT.x + 664;
    const hintW = DETAIL_RECT.x + DETAIL_RECT.w - 22 - hintX;
    const hovered = this.diffHover ? D.getDifficulty(this.diffHover) : null;
    let headText: string;
    let bodyText: string;
    let col: RGB;
    if (hovered) {
      headText = D.label(hovered);
      bodyText = hovered.blurb;
      col = hovered.color;
    } else if (rec.unlocked) {
      headText = "BRIEFING";
      bodyText = level.hint;
      col = theme.text;
    } else {
      headText = "LOCKED";
      bodyText = `Clear level ${String(Math.max(1, level.number - 1)).padStart(2, "0")} to open this stage.`;
      col = UI_WARN;
    }

    const hh = this.detailLabels[8]!;
    hh.set(headText);
    hh.setColor(theme.accent2);
    hh.place(hintX, y + 2);

    const lines = wrapText(fonts, fonts.get(18), bodyText, hintW, { maxLines: 2 });
    for (let i = 0; i < 2; i++) {
      const l = this.detailLabels[9 + i]!;
      const text = lines[i];
      l.visible = text !== undefined;
      if (text === undefined) continue;
      l.set(text);
      l.setColor(col);
      l.place(hintX, y + 22 + i * 22);
    }

    const cta = this.detailLabels[11]!;
    cta.visible = rec.unlocked;
    if (rec.unlocked) {
      cta.set("CLICK THE CARD TO PLAY");
      cta.setColor(lerpColor(theme.textDim, theme.accent, 0.55 + 0.45 * pulse(t, 3.0)));
      cta.place(
        DETAIL_RECT.x + DETAIL_RECT.w - 22,
        DETAIL_RECT.y + DETAIL_RECT.h - 22,
        "right",
      );
    }
  }
}
