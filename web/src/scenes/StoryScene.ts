/**
 * STORY - the narrative card presenter, a port of
 * `snake/scenes/story_scene.py`.
 *
 * This scene is the campaign's connective tissue and is deliberately
 * *generic*: it knows nothing about levels, chapters or progress - it only
 * knows how to show a stack of cards beautifully and then hand control to
 * whoever asked for it:
 *
 *   game.switchScene("story", { cards, nextScene: "game",
 *                               nextArgs: { level: 0 }, theme });
 *
 * Two scenes drive it (mode select and victory), so the contract is fixed and
 * everything inside is defensive: a card may be a StoryCard, a Chapter, a
 * StoryBeat, a plain object or a bare string, and an empty deck goes straight
 * through to `nextScene` without ever drawing a half-built frame.
 *
 * One card at a time over the level's own animated backdrop, with a parallax
 * star layer, drifting motes, a cinematic scrim and a vignette. The title
 * fades up, then the lines *type on* character by character with a soft tick;
 * punctuation costs extra time, so the rhythm reads like speech. Clicking
 * while text is typing completes the card; clicking once complete advances.
 * CONTINUE appears when the card is fully revealed; SKIP jumps past every
 * remaining card. A card carrying a chapter marker is promoted to a plate:
 * a huge roman numeral, a long rule and a lot more air.
 *
 * This scene reads and writes NO save state - every progression write happens
 * in the producer before it is entered. Do not slip a setStoryProgress in.
 */

import { Container, Graphics, Sprite } from "pixi.js";

import type { Game } from "../app/Game";
import { Scene, SCENES, type SceneEnterArgs } from "../app/Scene";
import * as C from "../core/config";
import { clamp, easeOutCubic, makeRng, pulse } from "../core/mathx";
import {
  THEMES,
  UI_WHITE,
  lerpColor,
  shade,
  themeForLevel,
  toHex,
  type Theme,
} from "../core/palette";
import type { Audio } from "../audio";
import { makeBackground, type Background } from "../gfx/bg";
import { scrimVignetteTexture } from "../gfx/scrim";
import { haloSprite, setHalo } from "../gfx/textures";
import { Button, hits } from "../ui/Button";
import { Label } from "../ui/text";
import { wrapText } from "../ui/wrap";
import { isChapterCard, normaliseCards, type StoryCardView } from "./story/cards";

// --------------------------------------------------------------------------
// Layout (story_scene.py:69-97). Authored against the 1280x720 canvas.
// --------------------------------------------------------------------------
const TEXT_W = 940;
const CENTER_X = C.WINDOW_W / 2;

const CONTINUE_RECT = { x: (C.WINDOW_W - C.UI_BUTTON_W) / 2, y: 614, w: C.UI_BUTTON_W, h: C.UI_BUTTON_H };
// SKIP is lifted well clear of the bottom-right corner: the CRT bezel passes
// only ~13% of the drawn light at the old (1090, 622); at (1020, 556) it
// measures ~0.73 and still sits outside the text column. Authored geometry.
const SKIP_RECT = { x: 1020, y: 556, w: 150, h: 44 };

// Normal card.
const SPEAKER_Y = 122;
const TITLE_Y = 152;
const RULE_Y = 246;
const LINES_Y = 298;
// Chapter plate.
const CH_LABEL_Y = 96;
const CH_ROMAN_Y = 120;
const CH_RULE_Y = 268;
const CH_TITLE_Y = 290;
const CH_LINES_Y = 392;

const LINE_STEP = 46;
const CH_LINE_STEP = 50;
/** The most display lines a card may show after wrapping. story_scene.py:723 */
const MAX_DISPLAY_LINES = 9;

// Typing. Cost is in "character units": one per character plus a surcharge
// after punctuation, so the reveal breathes at a comma and rests at a stop.
const TYPE_CPS = 46.0;
const NEWLINE_COST = 8.0;
const PUNCT_COST: Record<string, number> = {
  ",": 3.0, ";": 3.5, ":": 3.5, "-": 1.5,
  ".": 6.0, "!": 6.5, "?": 6.5,
};

const TITLE_IN = 0.45;
const TYPE_DELAY = 0.25;
const FADE_IN = 0.26;
const FADE_OUT = 0.18;
const TICK_GAP = 0.042;

/** (count, depth 0..1, drift px/s, brightness) - 134 stars in three layers. */
const STAR_LAYERS: ReadonlyArray<readonly [number, number, number, number]> = [
  [64, 0.18, 3.0, 0.42],
  [44, 0.45, 8.0, 0.62],
  [26, 0.85, 17.0, 0.88],
];

interface StarRec {
  x: number;
  y: number;
  /** The baked product `layerDepth * brightness`. */
  depth: number;
  size: number;
  phase: number;
  drift: number;
}

/** One display line, measured once for the typewriter. */
interface LineRec {
  text: string;
  label: Label;
  mask: Graphics;
  x: number;
  y: number;
  height: number;
  /** Pixel width of the first i characters (kerned prefix widths). */
  adv: number[];
  /** Reveal cost after i characters. */
  cum: number[];
  /** This line's offset on the global cost axis. */
  start: number;
  lastShown: number;
}

export class StoryScene extends Scene {
  readonly root = new Container();

  private readonly sound: Audio | null;

  private theme: Theme = THEMES[0]!;
  private t = 0;

  // -- deck -------------------------------------------------------------
  private cards: StoryCardView[] = [];
  private index = 0;
  private nextScene: string = SCENES.MENU;
  private nextArgs: SceneEnterArgs = {};

  // -- per-card state ------------------------------------------------------
  private reveal = 0;
  private total = 0;
  private cardT = 0;
  private done = false;
  private cardAlpha = 0;
  private fadingOut = false;
  private lines: LineRec[] = [];

  // -- run state -------------------------------------------------------------
  private finished = false;
  private pendingFinish = false;
  private armed = false;
  private tickCd = 0;
  private spoken = 0;

  // -- layers, in draw order ---------------------------------------------------
  /** Python's `surface.fill(theme.bg_bottom)` when no backdrop exists
   * (story_scene.py:956-959): shown while `bg` is null, so a stage that fails
   * to build - or the single frame of an empty deck - is themed rather than
   * the renderer's raw clear colour. */
  private readonly bgFallback = new Graphics();
  private readonly bgLayer = new Container();
  private readonly starLayer = new Graphics();
  private readonly scrim: Sprite;
  private readonly cardLayer = new Container();
  private readonly chrome = new Container();

  // -- card content (built once, re-pointed per card) ---------------------------
  private readonly speakerLabel: Label;
  private readonly kickerLabel: Label;
  private readonly titleGlow: Sprite;
  private readonly romanGlow: Sprite;
  private readonly romanLabel: Label;
  private readonly titleLabel: Label;
  private readonly ruleG = new Graphics();
  private readonly ruleGlow: Sprite;
  private readonly lineLabels: Label[] = [];
  private readonly lineMasks: Graphics[] = [];
  private readonly caret = new Graphics();

  // -- chrome -------------------------------------------------------------------
  private readonly counterLabel: Label;
  private readonly pips = new Graphics();
  private readonly hintLabel: Label;
  private readonly continueBtn: Button;
  private readonly skipBtn: Button;

  // -- atmosphere ------------------------------------------------------------------
  private bg: Background | null = null;
  private bgTheme: Theme | null = null;
  private stars: StarRec[] = [];
  private starRect = { x: 0, y: 0, w: C.WINDOW_W, h: C.WINDOW_H };
  private readonly rng = makeRng(1207);
  private entered = false;

  constructor(game: Game, sound: Audio | null = null) {
    super(game);
    this.sound = sound;
    const fonts = game.fonts;

    this.scrim = new Sprite();

    this.speakerLabel = new Label(fonts, fonts.get(15));
    this.kickerLabel = new Label(fonts, fonts.get(16));
    this.kickerLabel.set("C H A P T E R");
    this.titleGlow = haloSprite(100, UI_WHITE, 0);
    this.romanGlow = haloSprite(60, UI_WHITE, 0);
    this.romanLabel = new Label(fonts, fonts.displayAt(112));
    this.titleLabel = new Label(fonts, fonts.displayAt(62));
    this.ruleGlow = haloSprite(66, UI_WHITE, 0);

    for (let i = 0; i < MAX_DISPLAY_LINES; i++) {
      const label = new Label(fonts, fonts.get(27));
      const mask = new Graphics();
      // Assigned permanently: a Graphics serving as a mask is never rendered,
      // and keeping the assignment avoids a branch where a stale mask could
      // paint itself as a white bar.
      label.mask = mask;
      this.lineLabels.push(label);
      this.lineMasks.push(mask);
    }

    this.cardLayer.addChild(
      this.titleGlow,
      this.romanGlow,
      this.ruleGlow,
      this.speakerLabel,
      this.kickerLabel,
      this.romanLabel,
      this.titleLabel,
      this.ruleG,
    );
    for (let i = 0; i < MAX_DISPLAY_LINES; i++) {
      this.cardLayer.addChild(this.lineMasks[i]!, this.lineLabels[i]!);
    }
    this.cardLayer.addChild(this.caret);

    this.counterLabel = new Label(fonts, fonts.get(14));
    this.hintLabel = new Label(fonts, fonts.get(15));
    this.hintLabel.set("CLICK TO REVEAL");
    this.continueBtn = new Button(fonts, CONTINUE_RECT, "CONTINUE", {
      style: "primary",
      font: fonts.get(30, true),
    });
    this.skipBtn = new Button(fonts, SKIP_RECT, "SKIP", {
      style: "ghost",
      font: fonts.get(20),
    });
    this.chrome.addChild(
      this.counterLabel,
      this.pips,
      this.hintLabel,
      this.continueBtn.root,
      this.skipBtn.root,
    );

    // Layer order (story_scene.py draw, :951-982): background, stars,
    // particles (inserted on entry), scrim, card, chrome. The chrome must NOT
    // inherit the card's alpha - counter, pips, hint and both buttons stay at
    // full strength through both fades.
    this.root.addChild(
      this.bgFallback,
      this.bgLayer,
      this.starLayer,
      this.scrim,
      this.cardLayer,
      this.chrome,
    );
  }

  // ------------------------------------------------------------------
  // lifecycle
  // ------------------------------------------------------------------

  override onEnter(args?: SceneEnterArgs): void {
    this.t = 0;
    this.finished = false;
    this.armed = false;
    this.tickCd = 0;

    this.cards = normaliseCards(args?.["cards"]);
    this.index = 0;
    const next = args?.["nextScene"];
    this.nextScene = typeof next === "string" && next ? next : SCENES.MENU;
    const kw = args?.["nextArgs"];
    this.nextArgs = kw && typeof kw === "object" ? { ...(kw as SceneEnterArgs) } : {};

    this.theme = this.resolveTheme(args?.["theme"], args);
    this.pendingFinish = this.cards.length === 0;

    // Python leaves per-card state stale on the empty-deck path; reset it
    // anyway so the invariant is unconditional (scenes.md §10.5).
    this.reveal = 0;
    this.total = 0;
    this.cardT = 0;
    this.done = false;
    this.cardAlpha = 0;
    this.fadingOut = false;
    this.spoken = 0;

    this.paintFallback();
    const show = !this.pendingFinish;
    this.starLayer.visible = show;
    this.scrim.visible = show;
    this.cardLayer.visible = show;
    this.chrome.visible = show;
    // A deck with nothing in it never builds scenery: update() hands straight
    // over on the very next tick, and only the background is ever drawn.
    if (this.pendingFinish) return;

    this.ensureBackground();
    this.paintFallback(); // hides itself if the backdrop built
    this.ensureAtmosphere();
    this.root.addChildAt(this.game.particles.root, this.root.getChildIndex(this.scrim));
    this.beginCard(0);
    this.refresh();
    this.entered = true;
  }

  override onExit(): void {
    this.entered = false;
    if (this.game.particles.root.parent === this.root) {
      this.root.removeChild(this.game.particles.root);
    }
    // Deliberately no particles.clear(): the victory screen's confetti drifts
    // across the transition into the first card. Intentional continuity.
    //
    // The backdrop is a full-screen prerender; unlike the Python (which keeps
    // it for the whole session) drop it - this scene runs at most once per
    // level and the rebuild hides behind the 0.26 s fade-in.
    this.dropBackground();
  }

  override onResize(): void {
    if (!this.entered) return;
    const o = this.game.viewport.overscan;
    if (
      o.x !== this.starRect.x ||
      o.y !== this.starRect.y ||
      o.w !== this.starRect.w ||
      o.h !== this.starRect.h
    ) {
      this.dropBackground();
      this.ensureBackground();
      this.paintFallback();
      this.ensureAtmosphere();
    }
  }

  private resolveTheme(theme: unknown, args?: SceneEnterArgs): Theme {
    try {
      if (
        theme &&
        typeof theme === "object" &&
        typeof (theme as Theme).bgStyle === "string" &&
        Array.isArray((theme as Theme).accent)
      ) {
        return theme as Theme;
      }
      // `typeof` excludes booleans, which Python skips deliberately: bool is a
      // subclass of int there and True would silently mean level 1.
      if (typeof theme === "number" && Number.isFinite(theme)) {
        return themeForLevel(Math.trunc(theme));
      }
      const idx = args?.["levelIndex"] ?? args?.["level"];
      if (typeof idx === "number" && Number.isFinite(idx)) {
        return themeForLevel(Math.trunc(idx));
      }
      return themeForLevel(Math.trunc(this.game.levelIndex || 0));
    } catch {
      return THEMES[0]!;
    }
  }

  /** Keyed on the theme *object*: a style-string key would hand a derived
   * theme the previous theme's art (scenes.md §10.5 item 3). */
  private ensureBackground(): void {
    if (this.bg && this.bgTheme === this.theme) return;
    this.dropBackground();
    const renderer = this.game.app?.renderer;
    if (!renderer) return;
    try {
      this.bg = makeBackground(
        this.theme.bgStyle,
        this.theme,
        { ...this.game.viewport.overscan },
        renderer,
      );
      this.bgTheme = this.theme;
      this.bgLayer.addChild(this.bg.root);
    } catch (err) {
      console.warn("[story] background unavailable", err);
      this.bg = null;
    }
  }

  private dropBackground(): void {
    if (this.bg) {
      this.bgLayer.removeChild(this.bg.root);
      this.bg.destroy();
      this.bg = null;
    }
    this.bgTheme = null;
  }

  /** The themed under-fill, visible only while there is no backdrop. */
  private paintFallback(): void {
    const o = this.game.viewport.overscan;
    this.bgFallback.clear();
    this.bgFallback.rect(o.x, o.y, o.w, o.h).fill(toHex(this.theme.bgBottom));
    this.bgFallback.visible = this.bg === null;
  }

  /** Stars and the scrim both span overscan, not the design box, or a wide
   * phone shows starless, un-darkened columns (scenes.md §10.11). */
  private ensureAtmosphere(): void {
    const o = this.game.viewport.overscan;
    this.starRect = { ...o };
    this.scrim.texture = scrimVignetteTexture(o);
    this.scrim.position.set(o.x, o.y);
    this.scrim.width = o.w;
    this.scrim.height = o.h;

    this.stars = [];
    for (const [count, depth, drift, bright] of STAR_LAYERS) {
      for (let i = 0; i < count; i++) {
        this.stars.push({
          x: o.x + this.rng() * o.w,
          y: o.y + this.rng() * o.h,
          depth: depth * bright,
          size: 1 + Math.trunc(this.rng() * 2),
          phase: this.rng() * 6.28318,
          drift,
        });
      }
    }
  }

  // ------------------------------------------------------------------
  // card setup
  // ------------------------------------------------------------------

  private get card(): StoryCardView | null {
    return this.index >= 0 && this.index < this.cards.length
      ? this.cards[this.index]!
      : null;
  }

  /** SKIP stands down on the last card of a finished single-card deck. */
  private get skipLive(): boolean {
    return this.cards.length > 1 || !this.done;
  }

  private zeroButton(b: Button): void {
    const s = b.state;
    s.hovered = false;
    s.justEntered = false;
    s.hoverT = 0;
    s.pressT = 0;
    s.armed = false;
    s.cool = 0;
    s.flash = 0;
  }

  /** Reset every per-card animation and lay the text out once. */
  private beginCard(index: number): void {
    this.index = Math.trunc(clamp(index, 0, Math.max(0, this.cards.length - 1)));
    this.cardT = 0;
    this.reveal = 0;
    this.done = false;
    this.cardAlpha = 0;
    this.fadingOut = false;
    this.spoken = 0;
    this.armed = false;
    this.buildLayout();

    // The last card promises what it actually leads to, so CONTINUE never
    // lies about there being more story ahead.
    const last = this.index >= this.cards.length - 1;
    this.continueBtn.setLabel(last && this.nextScene === SCENES.GAME ? "BEGIN" : "CONTINUE");
    // Python constructs fresh Buttons per card; zeroing the state is the same.
    this.zeroButton(this.continueBtn);
    this.zeroButton(this.skipBtn);

    // Chrome that only changes per card.
    const total = Math.max(1, this.cards.length);
    const dim = shade(this.theme.textDim, 0.95);
    this.counterLabel.set(`CARD ${this.index + 1} OF ${total}`);
    this.counterLabel.setColor(dim);
    this.counterLabel.place(C.WINDOW_W - 40, 30, "right");
    this.pips.clear();
    const pitch = 12;
    const right = C.WINDOW_W - 40;
    const span = pitch * (total - 1);
    for (let i = 0; i < total; i++) {
      const x = right - span + i * pitch;
      if (i === this.index) {
        this.pips.circle(x, 58, 3).fill(toHex(lerpColor(this.theme.accent, UI_WHITE, 0.4)));
      } else {
        this.pips.circle(x, 58, 2).fill(toHex(shade(dim, i < this.index ? 0.55 : 0.3)));
      }
    }
    this.hintLabel.place(40, 636, "left");
  }

  /** Render, wrap and measure the current card. Runs once per card - the
   * per-frame reveal loop must stay pure arithmetic. */
  private buildLayout(): void {
    this.lines = [];
    this.total = 0;
    for (const label of this.lineLabels) label.visible = false;
    this.titleLabel.visible = false;
    this.romanLabel.visible = false;
    this.speakerLabel.visible = false;
    this.kickerLabel.visible = false;
    this.ruleG.visible = false;
    this.ruleGlow.visible = false;
    this.titleGlow.visible = false;
    this.romanGlow.visible = false;

    const card = this.card;
    if (!card) return;
    const fonts = this.game.fonts;
    const theme = this.theme;
    const chapter = isChapterCard(card);

    // -- title, on the shrink ladder (story_scene.py:694-706) -------------
    if (card.title) {
      const ladder = chapter
        ? [fonts.displayAt(58), fonts.displayAt(50), fonts.displayAt(42), fonts.displayAt(36)]
        : [fonts.displayAt(62), fonts.displayAt(54), fonts.displayAt(46), fonts.displayAt(40)];
      const style = fonts.fit(ladder, card.title, TEXT_W);
      this.titleLabel.set(card.title, style);
      this.titleLabel.setColor(lerpColor(theme.accent, UI_WHITE, 0.55));
      this.titleLabel.visible = true;
    }

    // -- roman numeral, never laddered --------------------------------------
    if (chapter) {
      this.romanLabel.set(card.roman, fonts.displayAt(112));
      this.romanLabel.setColor(lerpColor(theme.accent, UI_WHITE, 0.3));
      this.romanLabel.visible = true;
      this.kickerLabel.visible = true;
    } else if (card.speaker) {
      this.speakerLabel.set(card.speaker.toUpperCase());
      this.speakerLabel.visible = true;
    }

    // -- the rule: chapter plates always carry one, narrative cards only
    // under a title (story_scene.py:1065, :1086) -----------------------------
    const half = chapter ? 300 : 190;
    const ruleY = chapter ? CH_RULE_Y : RULE_Y;
    if (chapter || card.title) {
      this.ruleG.visible = true;
      this.ruleGlow.visible = true;
      this.ruleG.clear();
      const steps = 26;
      const span = half * 2;
      for (let i = 0; i < steps; i++) {
        const f0 = i / steps;
        const f1 = (i + 1) / steps;
        const mid = (f0 + f1) * 0.5;
        // Bright in the middle, gone at the tips; accent -> accent2 across.
        const power = Math.pow(1 - Math.abs(mid - 0.5) * 2, 0.8);
        const col = shade(lerpColor(theme.accent, theme.accent2, mid), power);
        const x0 = CENTER_X - half + span * f0;
        const x1 = CENTER_X - half + span * f1;
        this.ruleG.rect(x0, ruleY, x1 - x0, 2).fill(toHex(col));
      }
      this.ruleGlow.position.set(CENTER_X, ruleY + 1);
    }

    // -- body ------------------------------------------------------------------
    const bodyStyle = fonts.get(chapter ? 25 : 27);
    const colour = lerpColor(theme.text, UI_WHITE, 0.25);
    const step = chapter ? CH_LINE_STEP : LINE_STEP;
    const top = chapter ? CH_LINES_Y : LINES_Y;

    const display: string[] = [];
    for (const raw of card.lines) {
      display.push(...wrapText(fonts, bodyStyle, raw, TEXT_W, { maxLines: MAX_DISPLAY_LINES }));
    }
    const shown = display.slice(0, MAX_DISPLAY_LINES);

    let cursor = 0;
    for (let i = 0; i < shown.length; i++) {
      const text = shown[i]!;
      const label = this.lineLabels[i]!;
      label.set(text, bodyStyle);
      label.setColor(colour);
      const y = top + i * step;
      label.place(CENTER_X, y, "center");

      // Per-character prefix widths (kerned) and cumulative reveal costs.
      const adv: number[] = [0];
      const cum: number[] = [0];
      let cost = 0;
      for (let k = 0; k < text.length; k++) {
        adv.push(fonts.measureWidth(bodyStyle, text.slice(0, k + 1)));
        cost += 1 + (PUNCT_COST[text[k]!] ?? 0);
        cum.push(cost);
      }

      this.lines.push({
        text,
        label,
        mask: this.lineMasks[i]!,
        x: CENTER_X - label.textWidth / 2,
        y,
        height: label.textHeight,
        adv,
        cum,
        start: cursor,
        lastShown: -1,
      });
      cursor += cost + NEWLINE_COST;
    }
    this.total = Math.max(0, cursor - NEWLINE_COST);
  }

  // ------------------------------------------------------------------
  // input and actions
  // ------------------------------------------------------------------

  private overChrome(x: number, y: number): boolean {
    if (this.skipLive && hits(SKIP_RECT, x, y)) return true;
    return this.done && hits(CONTINUE_RECT, x, y);
  }

  /** Click / confirm: complete the typing, or move on if it is complete. */
  private primaryAction(): void {
    if (this.fadingOut) return;
    if (!this.done) this.completeCard();
    else {
      this.click();
      this.advance();
    }
  }

  /** Reveal the rest of the current card instantly. */
  private completeCard(): void {
    this.reveal = this.total;
    this.cardT = Math.max(this.cardT, TITLE_IN + TYPE_DELAY);
    this.cardAlpha = 1;
    this.done = true;
    this.spoken = 1 << 30; // no tick storm on the catch-up
    this.sound?.play("click", 0.5); // deliberately quieter than a real click
  }

  /** Begin the fade to the next card (or off the end of the deck). */
  private advance(): void {
    if (this.fadingOut || this.finished) return;
    this.fadingOut = true;
  }

  /** Hand over to whoever queued these cards. Only ever fires once. */
  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    const target = this.nextScene;
    try {
      if (this.game.registeredScenes().includes(target)) {
        this.game.switchScene(target, { ...this.nextArgs });
        return;
      }
    } catch (err) {
      console.warn("[story] hand-off failed", err);
    }
    if (this.game.registeredScenes().includes(SCENES.MENU)) {
      this.game.switchScene(SCENES.MENU);
    }
  }

  private click(): void {
    this.sound?.play("click");
  }

  // ------------------------------------------------------------------
  // frame
  // ------------------------------------------------------------------

  override update(dt: number): void {
    const d = clamp(dt, 0, C.MAX_DT);
    this.t += d;

    // An empty deck hands over on the first tick, before anything of this
    // scene has had a chance to be seen.
    if (this.pendingFinish) {
      this.pendingFinish = false;
      this.finish();
      return;
    }
    if (this.finished) return;

    // -- input, before the button updates (pump-then-update order) --------
    let action: "skip" | "advance" | "primary" | null = null;
    for (const ev of this.game.uiEvents) {
      if (action !== null) break;
      if (this.skipLive && this.skipBtn.handlePointer(ev)) {
        action = "skip";
        continue;
      }
      if (this.done && this.continueBtn.handlePointer(ev)) {
        action = "advance";
        continue;
      }
      if (ev.button !== 0) continue;
      if (ev.type === "down") {
        // Arm only away from the chrome, so a press that lands on a button
        // can never also count as a "click anywhere".
        this.armed = !this.overChrome(ev.x, ev.y);
      } else if (ev.type === "up") {
        const wasArmed = this.armed;
        this.armed = false;
        if (wasArmed && !this.overChrome(ev.x, ev.y)) action = "primary";
      }
    }
    for (const ev of this.game.keyEvents) {
      if (ev.type !== "down" || ev.repeat) continue;
      const k = ev.key;
      if (k === "Escape" || k === "Tab") action ??= "skip";
      else if (k === "Enter" || k === " " || k === "ArrowRight" || k === "e") {
        action ??= "primary";
      }
    }

    if (action === "skip") {
      this.click();
      this.finish();
      return;
    }
    if (action === "advance") {
      this.click();
      this.advance();
    } else if (action === "primary") {
      this.primaryAction();
    }

    this.updateButtons(d);
    this.bg?.update(d, { x: this.game.pointer.x, y: this.game.pointer.y });
    this.updateStars(d);
    // Slow motes rising through the frame - the room has air in it.
    this.game.particles.ambient(
      { x: 0, y: 40, w: C.WINDOW_W, h: C.WINDOW_H - 40 },
      lerpColor(this.theme.accent2, UI_WHITE, 0.2),
      d,
      { rate: 11.0, turbulence: 0.35, twinkle: 0.3 },
    );
    this.updateCard(d);
    if (this.finished) return;
    this.refresh();
  }

  private updateButtons(dt: number): void {
    const pointer = this.game.pointer;
    const pairs: Array<[Button, boolean]> = [
      [this.skipBtn, this.skipLive],
      [this.continueBtn, this.done],
    ];
    for (const [button, live] of pairs) {
      if (!live) {
        button.state.hovered = false;
        continue;
      }
      button.update(dt, pointer);
      // Fires only when a button arrives under a resting pointer - CONTINUE
      // appearing the frame after `done` flips; a mouse-in was already
      // written by the drained move event, so no edge is seen (§10.10).
      if (button.justEntered) this.sound?.play("hover");
    }
  }

  private updateStars(dt: number): void {
    const o = this.starRect;
    for (const star of this.stars) {
      star.x -= star.drift * dt;
      if (star.x < o.x - 4) {
        star.x += o.w + 8;
        star.y = o.y + this.rng() * o.h;
      }
    }
  }

  private updateCard(dt: number): void {
    const card = this.card;
    if (!card) {
      this.finish();
      return;
    }
    this.cardT += dt;

    if (this.fadingOut) {
      this.cardAlpha = Math.max(0, this.cardAlpha - dt / FADE_OUT);
      if (this.cardAlpha <= 0) {
        if (this.index + 1 >= this.cards.length) this.finish();
        else this.beginCard(this.index + 1);
      }
      return;
    }

    this.cardAlpha = Math.min(1, this.cardAlpha + dt / FADE_IN);

    if (this.done) return;
    // The body cannot start before the title has landed.
    if (this.cardT < TITLE_IN + TYPE_DELAY) return;
    if (this.total <= 0) {
      // A title-only card (a plate with no blurb, or "Act III") completes
      // the instant the gate opens.
      this.done = true;
      return;
    }

    this.reveal = Math.min(this.total, this.reveal + TYPE_CPS * dt);
    this.tickCd = Math.max(0, this.tickCd - dt);
    this.speak();
    if (this.reveal >= this.total) this.done = true;
  }

  /** A soft tick as new characters land, throttled so it stays a texture. */
  private speak(): void {
    let shown = 0;
    for (const line of this.lines) shown += this.charsShown(line);
    if (shown > this.spoken) {
      if (this.tickCd <= 0) {
        this.tickCd = TICK_GAP;
        this.sound?.play("hover", 0.22);
      }
      this.spoken = shown;
    }
  }

  /** How many characters of `line` the reveal counter has uncovered. */
  private charsShown(line: LineRec): number {
    const local = this.reveal - line.start;
    if (local <= 0) return 0;
    const cum = line.cum;
    const len = line.text.length;
    if (local >= cum[len]!) return len;
    // bisect_right(cum, local) - 1: the largest i with cum[i] <= local.
    let n = 0;
    while (n < len && cum[n + 1]! <= local) n++;
    return n;
  }

  // ------------------------------------------------------------------
  // per-frame drawing
  // ------------------------------------------------------------------

  private refresh(): void {
    const theme = this.theme;
    const t = this.t;
    const card = this.card;
    if (!card) return;
    const chapter = isChapterCard(card);

    // -- stars: three depths of pinpricks, nudged against the pointer -----
    const g = this.starLayer;
    g.clear();
    const ox = (this.game.pointer.x - CENTER_X) / CENTER_X;
    const oy = (this.game.pointer.y - C.WINDOW_H * 0.5) / (C.WINDOW_H * 0.5);
    const base = lerpColor(theme.text, theme.accent2, 0.35);
    for (const star of this.stars) {
      const twinkle = 0.55 + 0.45 * Math.sin(t * 1.9 + star.phase);
      const col = shade(base, (0.25 + 0.85 * star.depth) * twinkle);
      g.rect(star.x - ox * star.depth * 18, star.y - oy * star.depth * 11, star.size, star.size)
        .fill(toHex(col));
    }

    // -- title entrance ----------------------------------------------------
    const f = easeOutCubic(clamp(this.cardT / TITLE_IN, 0, 1));
    const alpha = f * this.cardAlpha;
    const lift = (1 - f) * -16;

    if (this.speakerLabel.visible) {
      this.speakerLabel.setColor(
        shade(lerpColor(theme.accent2, UI_WHITE, 0.2), 0.55 + 0.45 * alpha),
      );
      this.speakerLabel.place(CENTER_X, SPEAKER_Y + lift * 0.5, "center");
    }
    if (this.kickerLabel.visible) {
      this.kickerLabel.setColor(shade(theme.textDim, 0.7 + 0.3 * alpha));
      this.kickerLabel.place(CENTER_X, CH_LABEL_Y + lift * 0.4, "center");
    }

    if (this.titleLabel.visible) {
      this.titleLabel.alpha = alpha;
      const y = chapter ? CH_TITLE_Y + lift * 0.6 : TITLE_Y + lift;
      this.titleLabel.place(CENTER_X, y, "center");
      if (!chapter) {
        this.titleGlow.visible = true;
        this.titleGlow.position.set(CENTER_X, TITLE_Y + 34);
        setHalo(this.titleGlow, this.titleLabel.textWidth * 0.42, theme.accent, 0.2 * alpha);
      }
    }
    if (this.romanLabel.visible) {
      this.romanLabel.alpha = alpha;
      this.romanLabel.place(CENTER_X, CH_ROMAN_Y + lift * 1.4, "center");
      const breathe = 0.3 + 0.14 * pulse(t, 1.6);
      this.romanGlow.visible = true;
      this.romanGlow.position.set(CENTER_X, CH_ROMAN_Y + 66);
      setHalo(this.romanGlow, this.romanLabel.textWidth * 0.62, theme.accent, breathe * alpha);
    }
    if (this.ruleG.visible) {
      this.ruleG.alpha = alpha;
      setHalo(this.ruleGlow, (chapter ? 300 : 190) * 0.35, theme.accent, 0.16 * alpha);
    }

    // -- the typewriter body -----------------------------------------------
    let caret: LineRec | null = null;
    let caretWidth = 0;
    const bodyVisible = this.cardAlpha > 2 / 255;
    for (const line of this.lines) {
      const shown = bodyVisible ? this.charsShown(line) : 0;
      if (shown <= 0) {
        line.label.visible = false;
        continue;
      }
      line.label.visible = true;
      line.label.alpha = this.cardAlpha;
      const width = line.adv[Math.min(shown, line.adv.length - 1)]!;
      if (shown !== line.lastShown) {
        line.lastShown = shown;
        line.mask.clear();
        line.mask.rect(line.x, line.y, width, line.height + 2).fill({ color: 0xffffff });
      }
      if (shown < line.text.length) {
        caret = line;
        caretWidth = width;
      }
    }

    this.caret.clear();
    if (caret && !this.done) {
      const col = shade(lerpColor(theme.accent, UI_WHITE, 0.4), 0.55 + 0.45 * pulse(t, 9.0));
      this.caret
        .rect(caret.x + caretWidth + 3, caret.y + 4, 2, Math.max(6, caret.height - 10))
        .fill(toHex(col));
    }

    // -- chrome (never fades with the card) ---------------------------------
    this.hintLabel.visible = !this.done;
    if (!this.done) {
      const dim = shade(theme.textDim, 0.95);
      this.hintLabel.setColor(shade(dim, 0.45 + 0.35 * pulse(t, 2.4)));
    }
    this.continueBtn.root.visible = this.done;
    if (this.done) this.continueBtn.draw(theme, t);
    this.skipBtn.root.visible = this.skipLive;
    if (this.skipLive) this.skipBtn.draw(theme, t);
  }
}
