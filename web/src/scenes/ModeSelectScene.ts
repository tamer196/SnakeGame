/**
 * Mode select - a port of `snake/scenes/mode_select.py`.
 *
 * Two choices on one screen: **story or free play**, and **how hard the game is
 * going to be**. The menu deliberately starts nothing itself, so this is where
 * a run is actually configured.
 *
 * The two mode cards each carry bespoke art that says something the copy does
 * not. Story shows a twelve-node chain stepping down and across with the
 * reached nodes lit and an extra ring at each chapter opening, so the four acts
 * of the descent are visible without a word of label. Free play shows the same
 * twelve levels scattered as a constellation, laid out on a golden-angle spiral
 * so the picture is deterministic but irregular - and linked left-to-right
 * rather than in spiral order, because the spiral hops across the strip and
 * reads as scribble.
 *
 * Every number on a difficulty tile is read from the difficulty table rather
 * than written here, so the screen cannot drift away from the balance.
 *
 * Choosing STORY does not hand over immediately: a short flourish plays first,
 * and the handover happens on the update after it finishes.
 */

import { Container, Graphics, Sprite } from "pixi.js";

import type { Game } from "../app/Game";
import { Scene, SCENES } from "../app/Scene";
import * as C from "../core/config";
import { clamp, easeOutBack, easeOutCubic, formatFixed, pulse } from "../core/mathx";
import * as D from "../core/difficulty";
import { LEVEL_COUNT } from "../core/level";
import {
  THEMES,
  UI_BAD,
  UI_DIM,
  UI_GOLD,
  UI_GOOD,
  UI_WARN,
  UI_WHITE,
  lerpColor,
  shade,
  themeForLevel,
  toHex,
  type RGB,
  type Theme,
} from "../core/palette";
import type { SaveData } from "../core/save";
import { CHAPTERS, CHAPTER_SIZE, PROLOGUE, getBeat, getChapter } from "../core/story";
import type { Audio } from "../audio";
import { makeBackground, type Background } from "../gfx/bg";
import { Button } from "../ui/Button";
import { setUiGlow, uiGlowSprite } from "../ui/glow";
import { Label } from "../ui/text";
import { wrapText } from "../ui/wrap";

/**
 * `seen_beats` files level beats under their zero-based index (0..11). The
 * prologue belongs to no level, so it is filed far above that range - inside
 * the 0..255 window the save accepts, and impossible to collide with a beat
 * even if the campaign grows. mode_select.py:66
 */
const PROLOGUE_BEAT = 100;

/** Layout, against the fixed 1280x720 canvas. mode_select.py:71-92 */
const MARGIN = 54;
const CARD_W = 540;
const CARD_H = 250;
const CARD_Y = 72;
const CARD_L_X = MARGIN;
const CARD_R_X = C.WINDOW_W - MARGIN - CARD_W;
const RESTART_RECT = { x: CARD_L_X + 2, y: CARD_Y + CARD_H + 10, w: 192, h: 30 };
const DIFF_LABEL_Y = 374;
const TILE_Y = 398;
const TILE_H = 208;
const TILE_GAP = 16;
const TILE_W = Math.floor((C.WINDOW_W - MARGIN * 2 - TILE_GAP * 3) / 4);
/**
 * Held off the bottom-left corner on purpose: the finished frame goes through
 * the CRT bezel, which passes only about a fifth of the drawn light at the
 * corner. mode_select.py:87-92
 */
const BACK_RECT = { x: 240, y: 612, w: 210, h: 52 };

/** Entrance animation. mode_select.py:95-99 */
const INTRO_TIME = 0.46;
const INTRO_RISE = 62.0;
const CARD_DELAY = [0.0, 0.09];
const TILE_DELAY_BASE = 0.2;
const TILE_DELAY_STEP = 0.06;

/**
 * The same exponential rates `Button` uses internally, so the content this
 * scene paints tracks the body art the button paints. mode_select.py:103-104
 */
const HOVER_K = 13.0;
const PRESS_K = 22.0;

/** How each `selfMode` reads on the tile, and how alarming it is. mode_select.py:159 */
const SELF_TEXT: Record<string, readonly [string, RGB]> = {
  off: ["YOUR TAIL CANNOT KILL YOU", UI_GOOD],
  forgiving: ["YOUR TAIL KILLS - FORGIVING", UI_WARN],
  normal: ["YOUR TAIL KILLS - TIGHT", UI_WARN],
  strict: ["YOUR TAIL KILLS - INSTANTLY", UI_BAD],
};

/** Format a multiplier the way the tiles show it: `x1.15`. mode_select.py:150 */
function mult(value: number): string {
  return `x${formatFixed(value, 2).replace(/0+$/, "").replace(/\.$/, "")}`;
}

/** One animated hit target: a rect, its button, and its own hover weights. */
class Card {
  appear = 0;
  hoverT = 0;
  pressT = 0;

  constructor(
    readonly key: string,
    readonly button: Button,
    readonly home: { x: number; y: number; w: number; h: number },
    readonly delay: number,
  ) {}

  /**
   * Rewind the entrance - scene instances are cached and reused.
   *
   * Toggling `enabled` off is the supported way to clear the button's internal
   * "the mouse went down inside me" latch, which would otherwise survive a
   * scene switch and fire a phantom click on the next release.
   */
  reset(): void {
    this.appear = 0;
    this.hoverT = 0;
    this.pressT = 0;
    this.button.rect.x = this.home.x;
    this.button.rect.y = this.home.y;
    this.button.setEnabled(false);
    this.button.setEnabled(true);
  }
}

export class ModeSelectScene extends Scene {
  readonly root = new Container();

  private readonly save: SaveData;
  private readonly sound: Audio | null;

  private t = 0;
  private elapsed = 0;

  private readonly cards: Card[] = [];
  private readonly tiles: Card[] = [];
  private readonly back: Button;
  private readonly restart: Button;

  private difficulty: string = C.DEFAULT_DIFFICULTY;
  private restartArm = 0;
  private launching = "";
  private launchT = 0;

  private bg: Background | null = null;
  private bgStyle = "";
  private theme: Theme = THEMES[0]!;

  private readonly bgLayer = new Container();
  private readonly art = new Graphics();
  private readonly cardGlows: Sprite[] = [];
  private readonly chainGlows: Sprite[] = [];
  private readonly starGlows: Sprite[] = [];
  private readonly tileGlows: Sprite[] = [];

  private readonly header: Label;
  private readonly diffLabel: Label;
  private readonly diffSelected: Label;
  private readonly footer: Label;
  /** Five per mode card: title, blurb, footer-left, footer-right, action. */
  private readonly cardLabels: Label[] = [];
  /** Twelve per difficulty tile; see `drawTile`. */
  private readonly tileLabels: Label[] = [];

  constructor(game: Game, save: SaveData, sound: Audio | null = null) {
    super(game);
    this.save = save;
    this.sound = sound;
    const fonts = game.fonts;

    // Every hit target is created once; onEnter only resets them.
    (
      [
        ["story", CARD_L_X],
        ["free", CARD_R_X],
      ] as const
    ).forEach(([key, x], i) => {
      const home = { x, y: CARD_Y, w: CARD_W, h: CARD_H };
      // An empty label keeps Button.draw from stamping text over the art this
      // scene paints on top of it.
      const button = new Button(fonts, home, "", { style: "tile", data: key });
      this.cards.push(new Card(key, button, home, CARD_DELAY[i]!));
    });

    D.allDifficulties().forEach((diff, i) => {
      const home = { x: MARGIN + i * (TILE_W + TILE_GAP), y: TILE_Y, w: TILE_W, h: TILE_H };
      const button = new Button(fonts, home, "", { style: "tile", data: ["diff", diff.key] });
      this.tiles.push(new Card(diff.key, button, home, TILE_DELAY_BASE + i * TILE_DELAY_STEP));
    });

    this.back = new Button(fonts, BACK_RECT, "BACK", { style: "ghost", data: "back" });
    // A small face: this is a destructive footnote to the story card, not a
    // headline action, and the default danger face shouts at h2 size.
    this.restart = new Button(fonts, RESTART_RECT, "RESTART STORY", {
      style: "danger",
      font: fonts.small,
      data: "restart",
    });

    this.header = new Label(fonts, fonts.displayAt(34));
    this.diffLabel = new Label(fonts, fonts.small);
    this.diffSelected = new Label(fonts, fonts.small);
    this.footer = new Label(fonts, fonts.tiny);

    for (let i = 0; i < 2; i++) {
      this.cardLabels.push(
        new Label(fonts, fonts.displayAt(34)),
        new Label(fonts, fonts.small),
        new Label(fonts, fonts.small),
        new Label(fonts, fonts.small),
        new Label(fonts, fonts.body),
      );
      this.cardGlows.push(uiGlowSprite(150, UI_WHITE, 0));
    }
    for (let i = 0; i < 4; i++) {
      this.tileLabels.push(
        new Label(fonts, fonts.h2),
        new Label(fonts, fonts.tiny),
        new Label(fonts, fonts.tiny),
        new Label(fonts, fonts.tiny),
        new Label(fonts, fonts.tiny),
        new Label(fonts, fonts.tiny),
        new Label(fonts, fonts.small),
        new Label(fonts, fonts.tiny),
        new Label(fonts, fonts.small),
        new Label(fonts, fonts.tiny),
        new Label(fonts, fonts.small),
        new Label(fonts, fonts.tiny),
      );
      this.tileGlows.push(uiGlowSprite(160, UI_WHITE, 0));
    }
    for (let i = 0; i < LEVEL_COUNT; i++) {
      this.chainGlows.push(uiGlowSprite(26, UI_WHITE, 0));
      this.starGlows.push(uiGlowSprite(18, UI_WHITE, 0));
    }

    this.root.addChild(this.bgLayer);
    this.root.addChild(this.game.particles.root);
    for (const s of this.cardGlows) this.root.addChild(s);
    for (const s of this.tileGlows) this.root.addChild(s);
    for (const c of this.cards) this.root.addChild(c.button.root);
    for (const c of this.tiles) this.root.addChild(c.button.root);
    for (const s of this.chainGlows) this.root.addChild(s);
    for (const s of this.starGlows) this.root.addChild(s);
    this.root.addChild(this.art);
    this.root.addChild(this.header, this.diffLabel, this.diffSelected, this.footer);
    for (const l of this.cardLabels) this.root.addChild(l);
    for (const l of this.tileLabels) this.root.addChild(l);
    this.root.addChild(this.restart.root, this.back.root);
  }

  // -------------------------------------------------------------------
  // lifecycle
  // -------------------------------------------------------------------

  override onEnter(): void {
    this.t = 0;
    this.elapsed = 0;
    this.restartArm = 0;
    this.launching = "";
    this.launchT = 0;

    this.difficulty = this.currentDifficulty();
    for (const c of this.cards) c.reset();
    for (const c of this.tiles) c.reset();
    this.back.rect.x = BACK_RECT.x;
    this.back.rect.y = BACK_RECT.y;
    this.back.setEnabled(false);
    this.back.setEnabled(true);
    this.restart.rect.x = RESTART_RECT.x;
    this.restart.rect.y = RESTART_RECT.y;
    this.restart.setLabel("RESTART STORY");
    this.restart.setEnabled(false);
    this.restart.setEnabled(true);

    this.ensureBackground();
    this.root.addChildAt(this.game.particles.root, 1);
  }

  override onExit(): void {
    // Backgrounds hold a pre-rendered full-window layer; drop ours so it does
    // not stay resident behind the whole rest of the session.
    this.bg?.destroy();
    this.bg = null;
    this.bgStyle = "";
    if (this.game.particles.root.parent === this.root) {
      this.root.removeChild(this.game.particles.root);
    }
    this.game.particles.clear();
  }

  override onResize(): void {
    this.bg?.destroy();
    this.bg = null;
    this.bgStyle = "";
    this.ensureBackground();
  }

  /** Build the backdrop for the level the campaign is sitting on. */
  private ensureBackground(): void {
    this.theme = themeForLevel(this.storyIndex());
    const style = this.theme.bgStyle;
    if (this.bg && style === this.bgStyle) return;
    const renderer = this.game.app?.renderer;
    if (!renderer) return;
    this.bg?.destroy();
    try {
      this.bg = makeBackground(style, this.theme, { ...this.game.viewport.overscan }, renderer);
      this.bgLayer.addChild(this.bg.root);
      this.bgStyle = style;
    } catch (err) {
      console.warn("[mode] background unavailable", err);
      this.bg = null;
      this.bgStyle = "";
    }
  }

  // -------------------------------------------------------------------
  // save queries
  // -------------------------------------------------------------------

  private currentDifficulty(): string {
    const key = D.isDifficultyKey(this.game.difficulty)
      ? this.game.difficulty
      : this.save.difficulty;
    return D.getDifficulty(key).key;
  }

  private storyIndex(): number {
    return Math.trunc(clamp(this.save.storyProgress, 0, Math.max(0, LEVEL_COUNT - 1)));
  }

  /** True once the player has actually seen any of the campaign. */
  private storyStarted(): boolean {
    if (this.storyIndex() > 0 || this.save.storyComplete) return true;
    return this.save.beatSeen(PROLOGUE_BEAT);
  }

  /** RESTART STORY only exists once there is a campaign to restart. */
  private showRestart(): boolean {
    return this.save.storyComplete || this.storyIndex() > 0;
  }

  private cue(name: string, volume = 1.0): void {
    this.sound?.play(name, volume);
  }

  // -------------------------------------------------------------------
  // actions
  // -------------------------------------------------------------------

  /** Select a difficulty, persist it, and let the player hear it land. */
  private pickDifficulty(key: string): void {
    const diff = D.getDifficulty(key);
    const changed = diff.key !== this.difficulty;
    this.difficulty = diff.key;
    this.game.difficulty = diff.key;
    this.save.setDifficulty(diff.key);
    this.save.flush();
    this.cue(changed ? "click" : "hover", changed ? 0.9 : 0.5);
  }

  private activate(action: string): void {
    if (action === "restart" && this.restartArm <= 0) {
      // Wiping a campaign is worth one extra click.
      this.restartArm = 3.0;
      this.restart.setLabel("ERASE PROGRESS?");
      this.cue("hit", 0.7);
      return;
    }

    this.cue("click");
    if (action === "back") {
      this.go(SCENES.MENU);
    } else if (action === "free") {
      this.startFree();
    } else if (action === "story") {
      this.beginLaunch("story");
    } else if (action === "restart") {
      this.restartArm = 0;
      this.resetStory();
      this.beginLaunch("story");
    }
  }

  /** Kick off a short flourish, then hand over on the next update. */
  private beginLaunch(which: string): void {
    this.launching = which;
    this.launchT = 0.22;
    this.cue("start", 0.9);
    this.game.post.fx.flash(this.theme.accent, 0.3);
    const card = which === "story" ? this.cards[0]! : this.cards[1]!;
    this.game.particles.burst(
      card.button.rect.x + card.button.rect.w * 0.5,
      card.button.rect.y + card.button.rect.h * 0.5,
      this.theme.accent,
      { count: 26 },
    );
  }

  /** FREE PLAY: remember the mode and hand over to the level select. */
  private startFree(): void {
    this.game.mode = C.MODE_FREE;
    this.save.setMode(C.MODE_FREE);
    this.save.flush();
    this.go(SCENES.LEVELS);
  }

  /** Rewind the campaign so RESTART really does start from the first level. */
  private resetStory(): void {
    this.save.setStoryComplete(false);
    // `setStoryProgress` deliberately only moves forward, so a genuine restart
    // has to put the field back itself.
    this.save.storyProgress = 0;
    this.save.seenBeats = this.save.seenBeats.filter((i) => i !== PROLOGUE_BEAT);
    this.save.save();
  }

  /**
   * The card stack the story presenter shows before level `index` starts:
   * prologue (first time only), the chapter card, then the level's intro beat.
   *
   * The chapter is handed over **as itself**. `StoryScene` promotes anything
   * exposing `roman` to its full chapter plate; flattening it into a plain card
   * first throws the numeral away, and the same beat then looks different
   * depending on whether it was reached from here or from a victory.
   */
  private storyCards(index: number): unknown[] {
    const cards: unknown[] = [];
    if (!this.save.beatSeen(PROLOGUE_BEAT)) {
      cards.push(PROLOGUE);
      this.save.markBeatSeen(PROLOGUE_BEAT);
    }
    cards.push(getChapter(index));
    const beat = getBeat(index);
    cards.push({ title: beat.title, lines: [...beat.intro], speaker: beat.speaker });
    return cards;
  }

  /** STORY: set the mode, the level, and hand over to the presenter. */
  private startStory(): void {
    const index = this.storyIndex();
    this.game.mode = C.MODE_STORY;
    this.game.levelIndex = index;
    this.save.setMode(C.MODE_STORY);
    const cards = this.storyCards(index);
    this.save.flush();

    if (this.game.registeredScenes().includes(SCENES.STORY)) {
      this.game.switchScene(SCENES.STORY, {
        cards,
        nextScene: SCENES.GAME,
        nextArgs: { level: index },
      });
    } else {
      // Until the presenter exists, go straight to the level rather than
      // stranding the player on this screen.
      this.go(SCENES.GAME, { level: index });
    }
  }

  private go(key: string, args?: Record<string, unknown>): void {
    if (!this.game.registeredScenes().includes(key)) return;
    this.game.switchScene(key, args);
  }

  // -------------------------------------------------------------------
  // frame
  // -------------------------------------------------------------------

  override update(dt: number): void {
    const d = clamp(dt, 0, C.MAX_DT);
    this.t += d;
    this.elapsed += d;

    if (this.restartArm > 0) {
      this.restartArm -= d;
      if (this.restartArm <= 0) {
        this.restartArm = 0;
        this.restart.setLabel("RESTART STORY");
      }
    }

    // The flourish owns the last moment: no input is taken once it starts.
    let fired: string | null = null;
    if (!this.launching) {
      for (const ev of this.game.uiEvents) {
        for (const c of this.cards) if (c.button.handlePointer(ev)) fired ??= c.key;
        for (const c of this.tiles) {
          if (c.button.handlePointer(ev)) fired ??= `diff:${c.key}`;
        }
        if (this.showRestart() && this.restart.handlePointer(ev)) fired ??= "restart";
        if (this.back.handlePointer(ev)) fired ??= "back";
      }
      for (const ev of this.game.keyEvents) {
        if (ev.type !== "down" || ev.repeat) continue;
        const k = ev.key;
        if (k === "Escape" || k === "Backspace") fired ??= "back";
        else if (k === "Enter" || k === " ") fired ??= "story";
        else if (k === "f" || k === "l") fired ??= "free";
        else if (k === "ArrowLeft" || k === "a") {
          fired ??= `diff:${D.prevDifficulty(this.difficulty)}`;
        } else if (k === "ArrowRight" || k === "d") {
          fired ??= `diff:${D.nextDifficulty(this.difficulty)}`;
        } else if (k >= "1" && k <= "4") {
          const order = D.allDifficulties();
          const entry = order[Number(k) - 1];
          if (entry) fired ??= `diff:${entry.key}`;
        }
      }
    }

    const held = this.game.pointer.down;
    const kHover = 1 - Math.exp(-HOVER_K * d);
    const kPress = 1 - Math.exp(-PRESS_K * d);
    for (const c of [...this.cards, ...this.tiles]) this.updateCard(c, d, held, kHover, kPress);

    for (const w of [this.back, this.showRestart() ? this.restart : null]) {
      if (!w) continue;
      w.update(d, this.game.pointer);
      if (w.justEntered) this.cue("hover", 0.55);
    }

    this.bg?.update(d, { x: C.WINDOW_W * 0.5, y: C.WINDOW_H * 0.5 });
    this.game.particles.ambient(
      { x: 0, y: 0, w: C.WINDOW_W, h: C.WINDOW_H },
      lerpColor(this.theme.accent, this.theme.accent2, 0.5),
      d,
      { rate: 7.0 },
    );

    this.draw();

    if (fired !== null) {
      if (fired.startsWith("diff:")) this.pickDifficulty(fired.slice(5));
      else this.activate(fired);
    }

    if (this.launching) {
      this.launchT -= d;
      if (this.launchT <= 0) {
        const which = this.launching;
        this.launching = "";
        if (which === "story") this.startStory();
      }
    }
  }

  /** Advance one card's entrance, hover weight and button state. */
  private updateCard(card: Card, dt: number, held: boolean, kHover: number, kPress: number): void {
    card.appear = clamp((this.elapsed - card.delay) / Math.max(0.001, INTRO_TIME), 0, 1);
    const rise = (1 - easeOutCubic(card.appear)) * INTRO_RISE;
    card.button.rect.x = card.home.x;
    card.button.rect.y = card.home.y + rise;

    card.button.update(dt, this.game.pointer);
    if (card.button.justEntered) this.cue("hover", 0.55);
    card.hoverT += ((card.button.hovered ? 1 : 0) - card.hoverT) * kHover;
    card.pressT += ((card.button.hovered && held ? 1 : 0) - card.pressT) * kPress;
  }

  // -------------------------------------------------------------------
  // draw
  // -------------------------------------------------------------------

  private draw(): void {
    const theme = this.theme;
    const t = this.t;
    this.art.clear();
    for (const s of [...this.cardGlows, ...this.chainGlows, ...this.starGlows, ...this.tileGlows]) {
      s.visible = false;
    }

    const k = easeOutBack(clamp(this.elapsed / 0.5, 0, 1));
    this.header.set("CHOOSE YOUR DESCENT");
    this.header.setColor(lerpColor(theme.text, UI_WHITE, 0.4));
    this.header.place(C.WINDOW_W * 0.5, 14 - (1 - k) * 44, "center");

    this.cards.forEach((card, i) => {
      const on = card.appear > 0;
      card.button.root.visible = on;
      for (let j = 0; j < 5; j++) this.cardLabels[i * 5 + j]!.visible = on;
      if (!on) return;
      card.button.draw(theme, t);
      if (card.key === "story") this.drawStoryCard(card, i, theme, t);
      else this.drawFreeCard(card, i, theme, t);
    });

    const showRestart = this.showRestart();
    this.restart.root.visible = showRestart;
    if (showRestart) this.restart.draw(theme, t);

    this.drawDifficultyHeader(theme);
    this.tiles.forEach((tile, i) => {
      const on = tile.appear > 0;
      tile.button.root.visible = on;
      for (let j = 0; j < 12; j++) this.tileLabels[i * 12 + j]!.visible = on;
      if (!on) return;
      tile.button.draw(theme, t);
      this.drawTile(tile, i, theme, t);
    });

    this.back.draw(theme, t);
    this.footer.set(
      "CLICK A CARD TO PLAY  -  CLICK A DIFFICULTY TO CHANGE IT  -  ESC GOES BACK",
    );
    this.footer.setColor(shade(theme.textDim, 0.85));
    this.footer.place(C.WINDOW_W - MARGIN, BACK_RECT.y + BACK_RECT.h * 0.5 - 8, "right");
  }

  private drawDifficultyHeader(theme: Theme): void {
    const diff = D.getDifficulty(this.difficulty);
    const lives = D.livesFor(diff);
    this.diffLabel.set("DIFFICULTY");
    this.diffLabel.setColor(lerpColor(theme.textDim, UI_WHITE, 0.5));
    this.diffLabel.place(MARGIN, DIFF_LABEL_Y);

    this.diffSelected.set(
      `SELECTED  -  ${D.label(diff)}  (${lives} ${lives === 1 ? "LIFE" : "LIVES"})`,
    );
    this.diffSelected.setColor(lerpColor(diff.color, UI_WHITE, 0.25));
    this.diffSelected.place(C.WINDOW_W - MARGIN, DIFF_LABEL_Y, "right");
  }

  /** Story leans on accent2, free play on accent, so they read apart. */
  private cardAccent(card: Card, theme: Theme): RGB {
    const base = card.key === "story" ? theme.accent2 : theme.accent;
    return lerpColor(base, UI_WHITE, 0.25 * clamp(card.hoverT, 0, 1));
  }

  /** Shoulder bar, hover halo and hover rim. */
  private drawCardFrame(card: Card, slot: number, accent: RGB): void {
    const r = card.button.rect;
    const hov = clamp(card.hoverT, 0, 1);
    this.art.roundRect(r.x + 12, r.y + 2, r.w - 24, 5, 3).fill({ color: toHex(accent) });
    if (hov > 0.01) {
      this.art
        .roundRect(r.x, r.y, r.w, r.h, C.UI_CORNER + 6)
        .stroke({ color: toHex(lerpColor(accent, UI_WHITE, 0.45)), width: 2 });
      const g = this.cardGlows[slot]!;
      g.position.set(r.x + r.w * 0.5, r.y + 4);
      setUiGlow(g, 150, accent, 0.16 * hov);
    }
  }

  /** The readout strip and the call to action along the bottom. */
  private drawCardFooter(
    card: Card,
    slot: number,
    accent: RGB,
    left: string,
    right: string,
    action: string,
  ): void {
    const r = card.button.rect;
    const hov = clamp(card.hoverT, 0, 1);
    const lineY = r.y + 178;
    this.art
      .moveTo(r.x + 22, lineY)
      .lineTo(r.x + r.w - 22, lineY)
      .stroke({ color: toHex(shade(accent, 0.35)), width: 1 });

    const dim = lerpColor(UI_DIM, UI_WHITE, 0.45);
    const l = this.cardLabels[slot * 5 + 2]!;
    l.set(left);
    l.setColor(dim);
    l.place(r.x + 22, lineY + 9);

    const rl = this.cardLabels[slot * 5 + 3]!;
    rl.set(right);
    rl.setColor(dim);
    rl.place(r.x + r.w - 22, lineY + 9, "right");

    const a = this.cardLabels[slot * 5 + 4]!;
    a.set(action);
    a.setColor(lerpColor(accent, UI_WHITE, 0.25 + 0.55 * hov));
    a.place(r.x + r.w - 22, r.y + r.h - 34, "right");
  }

  private drawStoryCard(card: Card, slot: number, theme: Theme, t: number): void {
    const accent = this.cardAccent(card, theme);
    this.drawCardFrame(card, slot, accent);
    const r = card.button.rect;
    const index = this.storyIndex();
    const complete = this.save.storyComplete;

    this.drawChain(
      { x: r.x + 22, y: r.y + 18, w: r.w - 44, h: 78 },
      index,
      complete,
      accent,
      theme,
      t,
    );

    const title = this.cardLabels[slot * 5]!;
    title.set("STORY MODE");
    title.setColor(lerpColor(theme.text, UI_WHITE, 0.45));
    title.place(r.x + 22, r.y + 104);

    const blurb = this.cardLabels[slot * 5 + 1]!;
    blurb.set("Descend twelve layers in order, one chapter at a time.");
    blurb.setColor(shade(theme.textDim, 1.05));
    blurb.place(r.x + 22, r.y + 152);

    const chapter = getChapter(index);
    const lastRoman = CHAPTERS[CHAPTERS.length - 1]?.roman() ?? "IV";
    const left = complete
      ? "CAMPAIGN COMPLETE"
      : `CHAPTER ${chapter.roman()} OF ${lastRoman}  -  ${chapter.title.toUpperCase()}`;
    this.drawCardFooter(
      card,
      slot,
      accent,
      left,
      `LEVEL ${index + 1} / ${LEVEL_COUNT}`,
      this.storyStarted() ? "CONTINUE >" : "BEGIN >",
    );
  }

  /**
   * Twelve linked nodes stepping down and across, the reached ones lit.
   *
   * Chapter openings carry an extra ring, so the four acts of the descent are
   * visible without a single word of label.
   */
  private drawChain(
    area: { x: number; y: number; w: number; h: number },
    index: number,
    complete: boolean,
    accent: RGB,
    theme: Theme,
    t: number,
  ): void {
    const n = Math.max(2, LEVEL_COUNT);
    const reached = complete ? n - 1 : Math.trunc(clamp(index, 0, n - 1));
    const pts: Array<[number, number]> = [];
    for (let i = 0; i < n; i++) {
      const f = i / (n - 1);
      pts.push([
        area.x + 16 + f * (area.w - 32),
        area.y + 14 + f * (area.h - 34) + Math.sin(i * 1.35 + t * 0.7) * 4,
      ]);
    }

    for (let i = 0; i < n - 1; i++) {
      const lit = i < reached;
      const col = lit ? lerpColor(accent, UI_WHITE, 0.2) : shade(theme.textDim, 0.45);
      this.art
        .moveTo(pts[i]![0], pts[i]![1])
        .lineTo(pts[i + 1]![0], pts[i + 1]![1])
        .stroke({ color: toHex(col), width: lit ? 3 : 1 });
    }

    pts.forEach(([x, y], i) => {
      const lit = i <= reached;
      const here = i === reached && !complete;
      const col = lit ? lerpColor(accent, UI_WHITE, 0.35) : shade(theme.textDim, 0.55);
      let radius = here ? 7 : lit ? 5 : 4;
      if (here) radius += Math.trunc(1.6 * pulse(t, 2.0));
      if (lit) {
        const g = this.chainGlows[i]!;
        g.position.set(x, y);
        setUiGlow(g, 17 + (here ? 9 : 0), col, 0.3 + (here ? 0.35 : 0));
      }
      this.art.circle(x, y, radius).fill({ color: toHex(col) });
      if (!lit) {
        this.art
          .circle(x, y, Math.max(1, radius - 2))
          .fill({ color: toHex(shade(theme.bgBottom, 1.0)) });
      }
      if (i % Math.max(1, CHAPTER_SIZE) === 0) {
        this.art.circle(x, y, radius + 5).stroke({ color: toHex(shade(col, 0.9)), width: 1 });
      }
    });
  }

  private drawFreeCard(card: Card, slot: number, theme: Theme, t: number): void {
    const accent = this.cardAccent(card, theme);
    this.drawCardFrame(card, slot, accent);
    const r = card.button.rect;

    this.drawConstellation(
      { x: r.x + 22, y: r.y + 18, w: r.w - 44, h: 78 },
      accent,
      theme,
      t,
    );

    const title = this.cardLabels[slot * 5]!;
    title.set("FREE PLAY");
    title.setColor(lerpColor(theme.text, UI_WHITE, 0.45));
    title.place(r.x + 22, r.y + 104);

    const blurb = this.cardLabels[slot * 5 + 1]!;
    blurb.set("Any level you have unlocked, any order, as often as you like.");
    blurb.setColor(shade(theme.textDim, 1.05));
    blurb.place(r.x + 22, r.y + 152);

    const stars = this.save.totalStars();
    const cap = Math.max(1, this.save.maxStars());
    const unlocked = Math.trunc(clamp(this.save.unlocked, 0, LEVEL_COUNT));
    this.drawCardFooter(
      card,
      slot,
      accent,
      `${unlocked} OF ${LEVEL_COUNT} UNLOCKED`,
      `${stars} / ${cap} STARS`,
      "LEVEL SELECT >",
    );
  }

  /**
   * The twelve levels scattered as a constellation.
   *
   * Positions come from a golden-angle spiral squashed into the art strip:
   * deterministic, so the picture never jitters between frames or runs, but
   * irregular enough to read as scattered rather than as a grid. The links run
   * left to right rather than in spiral order - the spiral hops across the
   * whole strip and reads as scribble.
   */
  private drawConstellation(
    area: { x: number; y: number; w: number; h: number },
    accent: RGB,
    theme: Theme,
    t: number,
  ): void {
    const n = Math.max(1, LEVEL_COUNT);
    const cx = area.x + area.w * 0.5;
    const cy = area.y + area.h * 0.5;
    const rx = area.w * 0.46;
    const ry = area.h * 0.4;
    const pts: Array<[number, number]> = [];
    for (let i = 0; i < n; i++) {
      const ang = i * 2.39996 + 0.7;
      const rad = Math.sqrt((i + 0.55) / n);
      pts.push([cx + Math.cos(ang) * rad * rx, cy + Math.sin(ang) * rad * ry]);
    }

    const faint = toHex(shade(theme.textDim, 0.4));
    const chain = [...pts].sort((a, b) => a[0] - b[0]);
    for (let i = 0; i < chain.length - 1; i++) {
      this.art
        .moveTo(chain[i]![0], chain[i]![1])
        .lineTo(chain[i + 1]![0], chain[i + 1]![1])
        .stroke({ color: faint, width: 1 });
    }

    pts.forEach(([x, y], i) => {
      const open = this.save.isUnlocked(i);
      const size = open ? 13 : 10;
      if (open) {
        const col = lerpColor(accent, UI_WHITE, 0.3);
        const g = this.starGlows[i]!;
        g.position.set(x, y);
        setUiGlow(g, 18, col, 0.28 + 0.2 * pulse(t * 0.8 + i * 0.7, 1.0));
        this.art
          .roundRect(x - size * 0.5, y - size * 0.5, size, size, 3)
          .fill({ color: toHex(col) });
      } else {
        this.art
          .roundRect(x - size * 0.5, y - size * 0.5, size, size, 3)
          .stroke({ color: toHex(shade(theme.textDim, 0.55)), width: 1 });
      }
    });
  }

  /** Name, colour, blurb and the concrete stakes, at a glance. */
  private drawTile(tile: Card, slot: number, theme: Theme, t: number): void {
    const diff = D.getDifficulty(tile.key);
    const r = tile.button.rect;
    const hov = clamp(tile.hoverT, 0, 1);
    const chosen = diff.key === this.difficulty;
    const col = diff.color;
    const bright = lerpColor(col, UI_WHITE, 0.25 + 0.3 * hov);
    const base = slot * 12;

    this.art.roundRect(r.x + 10, r.y + 2, r.w - 20, 5, 3).fill({ color: toHex(bright) });
    if (chosen) {
      // A halo hugging the shoulder, not a blob in the middle of the text: the
      // tile has to stay legible while it is selected.
      const g = this.tileGlows[slot]!;
      g.position.set(r.x + r.w * 0.5, r.y + 4);
      setUiGlow(g, r.w * 0.55, col, 0.14 + 0.05 * pulse(t, 1.4));
      this.art
        .roundRect(r.x, r.y, r.w, r.h, C.UI_CORNER + 6)
        .stroke({ color: toHex(bright), width: 3 });
    } else if (hov > 0.01) {
      this.art
        .roundRect(r.x, r.y, r.w, r.h, C.UI_CORNER + 6)
        .stroke({ color: toHex(shade(bright, 0.8)), width: 2 });
    }

    const x = r.x + 16;
    const name = this.tileLabels[base]!;
    name.set(D.label(diff));
    name.setColor(chosen || hov > 0.3 ? bright : lerpColor(col, UI_WHITE, 0.1));
    name.place(x, r.y + 16);

    const sel = this.tileLabels[base + 1]!;
    sel.visible = chosen;
    if (chosen) {
      sel.set("SELECTED");
      sel.setColor(lerpColor(col, UI_WHITE, 0.55));
      sel.place(r.x + r.w - 16, r.y + 24, "right");
    }

    const fonts = this.game.fonts;
    const lines = wrapText(fonts, fonts.tiny, diff.blurb, r.w - 32, { maxLines: 3 });
    for (let i = 0; i < 3; i++) {
      const l = this.tileLabels[base + 2 + i]!;
      const text = lines[i];
      l.visible = text !== undefined;
      if (text === undefined) continue;
      l.set(text);
      l.setColor(shade(theme.textDim, 1.0));
      l.place(x, r.y + 56 + i * 17);
    }

    const lives = D.livesFor(diff);
    const rows: Array<[string, string, RGB]> = [
      ["LIVES", `${lives}`, lives >= 3 ? UI_GOOD : lives >= 2 ? UI_WARN : UI_BAD],
      ["SPEED", mult(diff.speedMult), UI_WHITE],
      ["SCORE", mult(diff.scoreMult), UI_GOLD],
    ];
    rows.forEach(([label, value, valueCol], i) => {
      const rowY = r.y + 114 + i * 22;
      const ll = this.tileLabels[base + 5 + i * 2]!;
      ll.set(label);
      ll.setColor(shade(theme.textDim, 0.95));
      ll.place(x, rowY);

      const vl = this.tileLabels[base + 6 + i * 2]!;
      vl.set(value);
      vl.setColor(valueCol);
      vl.place(r.x + r.w - 16, rowY - 2, "right");
    });

    const entry = SELF_TEXT[diff.selfMode] ?? (["YOUR TAIL KILLS", UI_WARN] as const);
    const self = this.tileLabels[base + 11]!;
    self.set(entry[0]);
    self.setColor(lerpColor(entry[1], UI_WHITE, 0.15));
    self.place(x, r.y + 182);
  }
}
