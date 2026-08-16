/**
 * SETTINGS - a port of `snake/scenes/settings.py`.
 *
 * Five labelled rows down the left, a live preview strip down the right:
 * display mode, difficulty, sound, the four visual-effect switches, and the
 * reset-progress row with its confirm step. The preview runs a real `Snake`
 * through a miniature of the post chain so every toggle has a visible
 * consequence before the player commits to it.
 *
 * Deliberate divergences from the Python, all settled decisions:
 *
 * - **Display mode is two states, not three.** A browser has only the
 *   Fullscreen API, so `borderless` collapses into `fullscreen`. The row
 *   cycles `windowed / fullscreen` through `game.setDisplayMode`, and the
 *   label re-reads `game.displayMode` every frame because the user can leave
 *   fullscreen with the browser's own Escape - the shell's `fullscreenchange`
 *   listener is the source of truth, never this scene.
 * - **The four visual-effect switches persist**, via `SaveData.setEffect` /
 *   `effectEnabled`. The Python left the hook in place (`_persist_flag`'s
 *   duck-typed probe) precisely so the schema could grow into it; on mobile,
 *   bloom-off is the biggest frame-rate lever the player has and losing it on
 *   every reload would be a real regression. Absent keys read as ON, so a
 *   Python-written save loads as everything enabled.
 * - **The shake guard is not ported.** `ScreenFx.shake` already checks
 *   `shakeEnabled` as its first statement; the monkey-patch exists only
 *   because pygame's EffectStack had no such flag.
 *
 * BACK pops when this scene was pushed over a live stack (the pause overlay)
 * and switches when it is the only scene - `game.stackDepth` exists for
 * exactly this. Switching in the first case would destroy the run underneath.
 */

import { Container, Graphics, Sprite, Texture } from "pixi.js";

import type { Game } from "../app/Game";
import { Scene, SCENES, type SceneEnterArgs } from "../app/Scene";
import * as C from "../core/config";
import {
  allDifficulties,
  getDifficulty,
  label as difficultyLabel,
  livesFor,
  selfCollisionEnabled,
  type Difficulty,
} from "../core/difficulty";
import { clamp, easeOutCubic, pulse } from "../core/mathx";
import {
  THEMES,
  UI_BAD,
  UI_GOLD,
  UI_GOOD,
  UI_WHITE,
  lerpColor,
  shade,
  themeForLevel,
  toHex,
  type RGB,
  type Theme,
} from "../core/palette";
import { GAME_MODES, type SaveData } from "../core/save";
import { Snake } from "../core/snake";
import type { Audio } from "../audio";
import { makeBackground, type Background } from "../gfx/bg";
import { BloomFilter } from "../gfx/post/BloomFilter";
import { SnakeRenderer } from "../gfx/SnakeRenderer";
import { canvasTexture, context2d, createCanvas } from "../gfx/textures";
import { Button } from "../ui/Button";
import { grouped } from "../ui/format";
import { Panel } from "../ui/panel";
import { Label } from "../ui/text";
import { wrapText } from "../ui/wrap";

// --------------------------------------------------------------------------
// Layout (settings.py:73-95). Authored once against the 1280x720 canvas.
// --------------------------------------------------------------------------
const PAD = 40;
const PREVIEW_X = 872;
const PREVIEW_W = C.WINDOW_W - PREVIEW_X - PAD; // 368

const ROW_DISPLAY = { x: PAD, y: 96, w: 800, h: 100 };
const ROW_DIFF = { x: PAD, y: 204, w: 800, h: 172 };
const ROW_SOUND = { x: PAD, y: 384, w: 800, h: 80 };
const ROW_FX = { x: PAD, y: 472, w: 800, h: 112 };
const ROW_RESET = { x: PAD, y: 592, w: 800, h: 96 };

const PREVIEW_PANEL = { x: PREVIEW_X, y: 96, w: PREVIEW_W, h: 524 };
const WELL = { x: PREVIEW_X + 16, y: 140, w: PREVIEW_W - 32, h: 300 };
// Nudged up and left out of the bottom-right corner: the CRT bezel passed only
// ~29% of the drawn light at the panel-centred spot, and this is the screen's
// only mouse exit. Authored geometry now - do not re-centre it.
const BACK_RECT = { x: 850, y: 622, w: C.UI_BUTTON_W, h: C.UI_BUTTON_H };

const VALUE_W = 166;

// --------------------------------------------------------------------------
// Copy (settings.py:100-116). Runs of 2-3 spaces are load-bearing.
// --------------------------------------------------------------------------
const DISPLAY_DESC =
  "How the game fills your screen.  F11 toggles fullscreen anywhere in the game.";
const DIFF_DESC = "Lives, pace and how cruel your own coil is.";
const SOUND_DESC = "Menu clicks, pickups, explosions and the win fanfare.";
const FX_DESC =
  "Post-processing on the finished frame.  Turn these off if the frame rate dips.";
const RESET_DESC = "Erases every unlock, star and best score.  Your settings are kept.";
const RESET_WARN = "Every star, unlock and best score, on every difficulty.";
const PREVIEW_HINT = "Hover a switch to see what it does - the strip above shows it live.";

/** (action key, button name, hover description), in draw order. */
const FX_TOGGLES: ReadonlyArray<readonly [string, string, string]> = [
  ["bloom", "BLOOM", "Soft light bleeding out of every neon edge."],
  ["scanlines", "SCANLINES", "Faint CRT lines laid over the whole frame."],
  ["grain", "GRAIN", "Fine animated film noise, sold at low light."],
  ["shake", "SHAKE", "The camera kicks when you crash or clear a level."],
];

/** The web's display row: two honest states (settled - see the header). */
const DISPLAY_MODES: ReadonlyArray<"windowed" | "fullscreen"> = ["windowed", "fullscreen"];

/** Seconds the panels take to wash in on entry. */
const INTRO_TIME = 0.32;

// Preview tuning (settings.py:124-136).
const PREVIEW_SPEED = 132.0;
const PREVIEW_LENGTH = 11;
// The Python multiplies its single-octave blur by 150/255 = 0.588 before the
// additive blit. BloomFilter sums TWO blur octaves, so the same gain reads
// roughly twice as hot and buries the snake's body - halved, verified by eye
// against captures/04-settings.png.
const BLOOM_STRENGTH = 0.3;
const GRAIN_FRAMES = 4;
const SHAKE_PERIOD = 2.3;
const SHAKE_TRAUMA = 1.0;
const SHAKE_DECAY = 2.4;
const SHAKE_PIXELS = 7.0;

/** BACK's legal destinations (settings.py:284-293). */
const BACK_WHITELIST: readonly string[] = [
  SCENES.MENU,
  SCENES.LEVELS,
  SCENES.GAME,
  SCENES.PAUSE,
  SCENES.GAMEOVER,
  SCENES.VICTORY,
  SCENES.HELP,
  SCENES.MODE,
  SCENES.STORY,
];

// --------------------------------------------------------------------------
// Baked preview overlays - process-lifetime caches, not per-entry
// --------------------------------------------------------------------------

let scanlineTexture: Texture | null = null;

/** The CRT lattice: a 1 px black line at alpha 70/255 every 3 px. */
function scanlines(): Texture {
  if (scanlineTexture) return scanlineTexture;
  const canvas = createCanvas(WELL.w, WELL.h);
  const ctx = context2d(canvas);
  ctx.clearRect(0, 0, WELL.w, WELL.h);
  ctx.fillStyle = "rgba(0,0,0,0.2745)"; // 70/255
  for (let y = 0; y < WELL.h; y += 3) ctx.fillRect(0, y, WELL.w, 1);
  scanlineTexture = canvasTexture(canvas);
  return scanlineTexture;
}

let grainTextures: Texture[] | null = null;

/**
 * Four 112x100 noise frames scaled 3x with nearest sampling, so the noise is
 * blocky exactly as Python's `pygame.transform.scale` makes it. The Mersenne
 * stream is not reproducible here and does not matter - the Python itself
 * re-rolls the frames on every entry.
 */
function grainFrames(): Texture[] {
  if (grainTextures) return grainTextures;
  const frames: Texture[] = [];
  const sw = Math.max(2, Math.trunc(WELL.w / 3));
  const sh = Math.max(2, Math.trunc(WELL.h / 3));
  const dots = Math.max(16, Math.trunc((sw * sh) / 7));
  for (let f = 0; f < GRAIN_FRAMES; f++) {
    const canvas = createCanvas(sw, sh);
    const ctx = context2d(canvas);
    ctx.clearRect(0, 0, sw, sh);
    for (let i = 0; i < dots; i++) {
      const x = Math.trunc(Math.random() * sw);
      const y = Math.trunc(Math.random() * sh);
      const v = 90 + Math.trunc(Math.random() * 101);
      const a = (18 + Math.trunc(Math.random() * 29)) / 255;
      ctx.fillStyle = `rgba(${v},${v},${v},${a})`;
      ctx.fillRect(x, y, 1, 1);
    }
    frames.push(canvasTexture(canvas, { scaleMode: "nearest" }));
  }
  grainTextures = frames;
  return grainTextures;
}

// ==========================================================================
// Scene
// ==========================================================================
export class SettingsScene extends Scene {
  readonly root = new Container();

  private readonly save: SaveData;
  private readonly sound: Audio | null;

  private t = 0;
  private intro = 0;
  private theme: Theme = THEMES[0]!;
  private backTarget: string = SCENES.MENU;
  private confirming = false;
  private leaving = false;
  private fxHint = "";
  private flash = 0;
  private resetFlash = 0;
  private entered = false;

  // -- backdrop -------------------------------------------------------
  private readonly bgLayer = new Container();
  private bg: Background | null = null;
  private bgTheme: Theme | null = null;
  private bgRect = { x: 0, y: 0, w: 0, h: 0 };

  // -- header ---------------------------------------------------------
  private readonly headerTitle: Label;
  private readonly headerSub: Label;
  private readonly headerBack: Label;

  // -- row furniture: five rows + the preview panel ---------------------
  private readonly panels: Panel[] = [];
  private readonly rowTitles: Label[] = [];
  private readonly rowDescs: Label[] = [];
  private readonly f11Hint: Label;
  private readonly diffBars = new Graphics();
  private readonly diffBlurb: Label;
  private readonly diffStakes: Label;
  private readonly diffScore: Label;
  private readonly soundMeter = new Graphics();
  private readonly resetLine: Label;

  // -- preview panel ----------------------------------------------------
  private readonly previewTitle: Label;
  private readonly hintLines: Label[] = [];
  private readonly summaryCaptions: Label[] = [];
  private readonly summaryValues: Label[] = [];

  // -- the well ---------------------------------------------------------
  private readonly wellStatic = new Graphics();
  private readonly wellClip = new Container();
  private readonly wellMask = new Graphics();
  private readonly wellShift = new Container();
  private readonly wellFill = new Graphics();
  private readonly wellGrid = new Graphics();
  private readonly snakeView = new SnakeRenderer();
  private readonly scanSprite: Sprite;
  private readonly grainSprite: Sprite;
  private readonly wellEdge = new Graphics();
  private readonly bloom = new BloomFilter();

  private snake: Snake | null = null;
  private orbit = 0;
  private wellShake = 0;
  private shakeNext = SHAKE_PERIOD;
  private grainIndex = 0;
  private grainAt = 0;

  // -- buttons ------------------------------------------------------------
  private readonly dispPrev: Button;
  private readonly dispValue: Button;
  private readonly dispNext: Button;
  private readonly diffChips: Button[] = [];
  private readonly soundButton: Button;
  private readonly fxButtons: Button[] = [];
  private readonly resetButton: Button;
  private readonly cancelButton: Button;
  private readonly confirmButton: Button;
  private readonly backButton: Button;

  constructor(game: Game, save: SaveData, sound: Audio | null = null) {
    super(game);
    this.save = save;
    this.sound = sound;
    const fonts = game.fonts;

    this.headerTitle = new Label(fonts, fonts.h1);
    this.headerTitle.set("SETTINGS");
    this.headerSub = new Label(fonts, fonts.small);
    this.headerSub.set("everything here is saved the moment you change it");
    this.headerBack = new Label(fonts, fonts.tiny);

    // Five rows plus the preview panel share the same furniture.
    const rows: Array<[{ x: number; y: number; w: number; h: number }, string, string]> = [
      [ROW_DISPLAY, "DISPLAY MODE", DISPLAY_DESC],
      [ROW_DIFF, "DIFFICULTY", DIFF_DESC],
      [ROW_SOUND, "SOUND", SOUND_DESC],
      [ROW_FX, "VISUAL EFFECTS", FX_DESC],
      [ROW_RESET, "RESET PROGRESS", RESET_DESC],
    ];
    for (const [rect, title, desc] of rows) {
      const panel = new Panel();
      panel.setRect(rect.x, rect.y, rect.w, rect.h);
      this.panels.push(panel);
      const titleLabel = new Label(fonts, fonts.get(18, true));
      titleLabel.set(title);
      titleLabel.place(rect.x + 20, rect.y + 12, "left");
      this.rowTitles.push(titleLabel);
      const descLabel = new Label(fonts, fonts.tiny);
      descLabel.set(desc);
      descLabel.place(rect.x + 20, rect.y + 36, "left");
      this.rowDescs.push(descLabel);
    }

    this.f11Hint = new Label(fonts, fonts.tiny);
    this.f11Hint.set("F11  FULLSCREEN");
    this.f11Hint.place(ROW_DISPLAY.x + 20, ROW_DISPLAY.y + 64, "left");

    this.diffBlurb = new Label(fonts, fonts.small);
    this.diffBlurb.place(ROW_DIFF.x + 20, ROW_DIFF.y + 126, "left");
    this.diffStakes = new Label(fonts, fonts.tiny);
    this.diffStakes.place(ROW_DIFF.x + 20, ROW_DIFF.y + 149, "left");
    this.diffScore = new Label(fonts, fonts.tiny);
    this.diffScore.place(ROW_DIFF.x + ROW_DIFF.w - 20, ROW_DIFF.y + 149, "right");
    this.diffScore.setColor(UI_GOLD);

    this.resetLine = new Label(fonts, fonts.tiny);
    this.resetLine.place(ROW_RESET.x + 20, ROW_RESET.y + 62, "left");

    // -- preview panel ----------------------------------------------------
    const preview = new Panel();
    preview.setRect(PREVIEW_PANEL.x, PREVIEW_PANEL.y, PREVIEW_PANEL.w, PREVIEW_PANEL.h);
    this.panels.push(preview);
    this.previewTitle = new Label(fonts, fonts.get(18, true));
    this.previewTitle.set("PREVIEW");
    this.previewTitle.place(PREVIEW_PANEL.x + 20, PREVIEW_PANEL.y + 14, "left");

    for (let i = 0; i < 3; i++) {
      const line = new Label(fonts, fonts.tiny);
      line.place(PREVIEW_PANEL.x + 20, WELL.y + WELL.h + 14 + i * 18, "left");
      this.hintLines.push(line);
    }
    const captions = ["DISPLAY", "DIFFICULTY", "SOUND", "EFFECTS"];
    for (let i = 0; i < 4; i++) {
      const y = WELL.y + WELL.h + 78 + i * 26;
      const caption = new Label(fonts, fonts.tiny);
      caption.set(captions[i]!);
      caption.place(PREVIEW_PANEL.x + 20, y, "left");
      this.summaryCaptions.push(caption);
      const value = new Label(fonts, fonts.get(17, true));
      value.place(PREVIEW_PANEL.x + PREVIEW_PANEL.w - 20, y - 2, "right");
      this.summaryValues.push(value);
    }

    // -- the well -----------------------------------------------------------
    // wellStatic sits OUTSIDE the shifted container: Python blits an opaque
    // buffer at an offset inside a clip, so the strip the knock uncovers shows
    // this fill, not the panel behind.
    this.wellMask.roundRect(WELL.x, WELL.y, WELL.w, WELL.h, 8).fill({ color: 0xffffff });
    this.wellClip.mask = this.wellMask;
    this.scanSprite = new Sprite(scanlines());
    this.grainSprite = new Sprite();
    this.grainSprite.width = WELL.w;
    this.grainSprite.height = WELL.h;
    this.bloom.gain = BLOOM_STRENGTH;
    this.wellShift.filters = [this.bloom];
    this.wellShift.addChild(
      this.wellFill,
      this.wellGrid,
      this.snakeView.container,
      this.scanSprite,
      this.grainSprite,
    );
    this.wellClip.addChild(this.wellShift);

    // -- buttons -------------------------------------------------------------
    // Derived rects (settings.py:359-428): pygame's rect.center arithmetic,
    // resolved to top-left form in the port spec (§9.5).
    this.dispPrev = new Button(fonts, { x: 536, y: 124, w: 44, h: 44 }, "<", {
      style: "ghost",
      data: "display_prev",
      font: fonts.get(24, true),
    });
    this.dispValue = new Button(fonts, { x: 584, y: 124, w: VALUE_W, h: 44 }, "WINDOWED", {
      style: "primary",
      data: "display_next",
      font: fonts.get(20, true),
    });
    this.dispNext = new Button(fonts, { x: 754, y: 124, w: 44, h: 44 }, ">", {
      style: "ghost",
      data: "display_next",
      font: fonts.get(24, true),
    });

    allDifficulties().forEach((diff, i) => {
      const chip = new Button(
        fonts,
        { x: 58 + i * 194, y: 268, w: 182, h: 50 },
        difficultyLabel(diff),
        { style: "ghost", data: `diff:${diff.key}`, font: fonts.get(21, true) },
      );
      this.diffChips.push(chip);
    });

    this.soundButton = new Button(fonts, { x: 654, y: 404, w: VALUE_W, h: 44 }, "SOUND  ON", {
      style: "primary",
      data: "sound",
      font: fonts.get(20, true),
    });

    FX_TOGGLES.forEach(([key, name], i) => {
      const toggle = new Button(
        fonts,
        { x: 58 + i * 194, y: 534, w: 182, h: 42 },
        `${name}  ON`,
        { style: "primary", data: `fx:${key}`, font: fonts.get(18, true) },
      );
      this.fxButtons.push(toggle);
    });

    this.resetButton = new Button(fonts, { x: 590, y: 623, w: 230, h: 46 }, "RESET PROGRESS", {
      style: "danger",
      data: "reset",
      font: fonts.get(19, true),
    });
    this.cancelButton = new Button(fonts, { x: 490, y: 631, w: 150, h: 46 }, "CANCEL", {
      style: "ghost",
      data: "reset_cancel",
      font: fonts.get(20, true),
    });
    this.confirmButton = new Button(fonts, { x: 652, y: 631, w: 168, h: 46 }, "CONFIRM", {
      style: "danger",
      data: "reset_confirm",
      font: fonts.get(20, true),
    });
    this.backButton = new Button(fonts, BACK_RECT, "BACK", {
      style: "primary",
      data: "back",
      font: fonts.h2,
    });

    // -- assembly, in draw order ---------------------------------------------
    this.root.addChild(this.bgLayer);
    this.root.addChild(this.headerTitle, this.headerSub, this.headerBack);
    for (const p of this.panels) this.root.addChild(p);
    for (const l of this.rowTitles) this.root.addChild(l);
    for (const l of this.rowDescs) this.root.addChild(l);
    this.root.addChild(
      this.f11Hint,
      this.diffBars,
      this.diffBlurb,
      this.diffStakes,
      this.diffScore,
      this.soundMeter,
      this.resetLine,
      this.previewTitle,
    );
    this.root.addChild(this.wellStatic, this.wellMask, this.wellClip, this.wellEdge);
    for (const l of this.hintLines) this.root.addChild(l);
    for (const l of this.summaryCaptions) this.root.addChild(l);
    for (const l of this.summaryValues) this.root.addChild(l);
    // Buttons paint last, over everything - including the colour bars.
    for (const b of this.allButtons()) this.root.addChild(b.root);
  }

  private allButtons(): Button[] {
    return [
      this.dispPrev,
      this.dispValue,
      this.dispNext,
      ...this.diffChips,
      this.soundButton,
      ...this.fxButtons,
      this.resetButton,
      this.cancelButton,
      this.confirmButton,
      this.backButton,
    ];
  }

  /** The buttons currently on screen - the reset trio swaps with `confirming`. */
  private activeButtons(): Button[] {
    return this.allButtons().filter((b) => b.root.visible);
  }

  // ------------------------------------------------------------------
  // lifecycle
  // ------------------------------------------------------------------

  override onEnter(args?: SceneEnterArgs): void {
    this.t = 0;
    this.intro = 0;
    this.confirming = false;
    this.leaving = false;
    this.flash = 0;
    this.resetFlash = 0;
    this.fxHint = "";
    this.backTarget = this.resolveBack(args?.["back"]);

    this.theme = this.resolveTheme();
    this.ensureBackground();

    // The Python throws the whole button list away on entry, so no button can
    // carry a hover or an arm across a re-entry - zero every state instead.
    for (const b of this.allButtons()) this.zeroButton(b);
    this.syncResetRow();
    this.refreshLabels();
    this.applyTheme();

    this.resetPreview();
    this.entered = true;
    this.refresh();
  }

  override onExit(): void {
    this.confirming = false;
    this.leaving = false;
    this.entered = false;
  }

  override onResize(): void {
    if (!this.entered) return;
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

  private resolveBack(value: unknown): string {
    const name = String(value ?? "").trim().toLowerCase();
    return BACK_WHITELIST.includes(name) ? name : SCENES.MENU;
  }

  private resolveTheme(): Theme {
    try {
      return themeForLevel(Math.trunc(this.game.levelIndex || 0));
    } catch {
      return THEMES[0]!;
    }
  }

  /** Cache keyed on the theme *object*, not the style string (§9.3 note 1). */
  private ensureBackground(): void {
    if (this.bg && this.bgTheme === this.theme) return;
    this.dropBackground();
    const renderer = this.game.app?.renderer;
    if (!renderer) return;
    try {
      const rect = { ...this.game.viewport.overscan };
      this.bg = makeBackground(this.theme.bgStyle, this.theme, rect, renderer);
      this.bgTheme = this.theme;
      this.bgRect = rect;
      this.bgLayer.addChild(this.bg.root);
    } catch (err) {
      console.warn("[settings] background unavailable", err);
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

  /** Re-tint everything that depends on the entry theme. */
  private applyTheme(): void {
    const theme = this.theme;
    this.headerSub.setColor(theme.textDim);
    this.headerBack.set(`BACK RETURNS TO ${this.backTarget.toUpperCase()}`);
    this.headerBack.setColor(shade(theme.textDim, 0.8));
    this.headerBack.place(C.WINDOW_W - PAD, 30, "right");

    for (let i = 0; i < this.rowTitles.length; i++) {
      // The reset row (index 4) is the danger row; its title runs warm.
      const accent = i === 4 ? UI_BAD : theme.accent2;
      this.rowTitles[i]!.setColor(lerpColor(accent, UI_WHITE, 0.3));
      this.rowDescs[i]!.setColor(theme.textDim);
    }
    this.previewTitle.setColor(lerpColor(theme.accent2, UI_WHITE, 0.3));
    this.f11Hint.setColor(lerpColor(theme.accent, UI_WHITE, 0.2));
    for (const caption of this.summaryCaptions) caption.setColor(theme.textDim);

    // Well statics.
    this.wellStatic.clear();
    this.wellStatic
      .roundRect(WELL.x, WELL.y, WELL.w, WELL.h, 8)
      .fill(toHex(shade(theme.bgBottom, 0.9)));
    this.wellEdge.clear();
    this.wellEdge
      .roundRect(WELL.x, WELL.y, WELL.w, WELL.h, 8)
      .stroke({ width: 1, color: toHex(shade(theme.grid, 1.2)) });
    this.wellFill.clear();
    this.wellFill.rect(0, 0, WELL.w, WELL.h).fill(toHex(shade(theme.bgBottom, 1.05)));
    this.wellGrid.clear();
    const gridCol = toHex(shade(theme.grid, 0.55));
    for (let gx = 0; gx < WELL.w; gx += 30) {
      this.wellGrid.moveTo(gx, 0).lineTo(gx, WELL.h);
    }
    for (let gy = 0; gy < WELL.h; gy += 30) {
      this.wellGrid.moveTo(0, gy).lineTo(WELL.w, gy);
    }
    this.wellGrid.stroke({ width: 1, color: gridCol });
  }

  private resetPreview(): void {
    this.orbit = 0;
    this.wellShake = 0;
    this.shakeNext = SHAKE_PERIOD;
    this.grainIndex = 0;
    this.grainAt = 0;
    this.grainSprite.texture = grainFrames()[0]!;
    this.grainSprite.width = WELL.w;
    this.grainSprite.height = WELL.h;
    this.snake = new Snake(WELL.w * 0.5, WELL.h * 0.5, 0, PREVIEW_LENGTH);
    this.snake.speed = PREVIEW_SPEED;
  }

  // ------------------------------------------------------------------
  // current values
  // ------------------------------------------------------------------

  private displayMode(): string {
    const mode = this.game.displayMode;
    return (DISPLAY_MODES as readonly string[]).includes(mode) ? mode : "windowed";
  }

  private displayLabel(): string {
    return this.displayMode().toUpperCase();
  }

  private difficulty(): Difficulty {
    return getDifficulty(this.game.difficulty);
  }

  private muted(): boolean {
    return !!this.sound?.muted;
  }

  private fxFlag(key: string): boolean {
    const fx = this.game.post.fx;
    switch (key) {
      case "bloom":
        return fx.bloomEnabled;
      case "scanlines":
        return fx.scanlinesEnabled;
      case "grain":
        return fx.grainEnabled;
      case "shake":
        return fx.shakeEnabled;
      default:
        return false;
    }
  }

  private effectsSummary(): string {
    let on = 0;
    for (const [key] of FX_TOGGLES) if (this.fxFlag(key)) on++;
    return `${on} / ${FX_TOGGLES.length} ON`;
  }

  // ------------------------------------------------------------------
  // labels and the confirm swap
  // ------------------------------------------------------------------

  /** Re-sync every control's label and style with the live values. */
  private refreshLabels(): void {
    this.dispValue.setLabel(this.displayLabel());

    const selected = this.difficulty();
    for (const chip of this.diffChips) {
      const key = String(chip.data).slice(5);
      chip.style = key === selected.key ? "primary" : "ghost";
    }

    const muted = this.muted();
    this.soundButton.setLabel(muted ? "SOUND  OFF" : "SOUND  ON");
    this.soundButton.style = muted ? "ghost" : "primary";

    for (let i = 0; i < this.fxButtons.length; i++) {
      const [key, name] = FX_TOGGLES[i]!;
      const on = this.fxFlag(key);
      this.fxButtons[i]!.setLabel(`${name}  ${on ? "ON" : "OFF"}`);
      this.fxButtons[i]!.style = on ? "primary" : "ghost";
    }

    // Difficulty row furniture follows the selection.
    this.diffBars.clear();
    for (let i = 0; i < this.diffChips.length; i++) {
      const chip = this.diffChips[i]!;
      const diff = getDifficulty(String(chip.data).slice(5));
      const on = diff.key === selected.key;
      const col = on ? diff.color : shade(diff.color, 0.35);
      this.diffBars
        .roundRect(chip.rect.x + 8, chip.rect.y + chip.rect.h + 5, chip.rect.w - 16, 3, 2)
        .fill(toHex(col));
    }
    this.diffBlurb.set(selected.blurb);
    this.diffBlurb.setColor(lerpColor(this.theme.text, selected.color, 0.45));
    const tail = selfCollisionEnabled(selected)
      ? `SELF-COLLISION ${String(selected.selfMode).toUpperCase()}`
      : "SELF-COLLISION OFF";
    this.diffStakes.set(
      `${livesFor(selected)} LIVES   ${selected.speedMult.toFixed(2)}x SPEED   ${tail}`,
    );
    this.diffStakes.setColor(shade(selected.color, 0.9));
    this.diffScore.set(`x${selected.scoreMult.toFixed(2)} SCORE`);
  }

  /** Swap the reset row between its normal and confirm layouts. */
  private syncResetRow(): void {
    const confirming = this.confirming;
    this.resetButton.root.visible = !confirming;
    this.cancelButton.root.visible = confirming;
    this.confirmButton.root.visible = confirming;
    // The Python rebuilds the whole list here, which zeroes animation state
    // and lets the hover cue fire for a button appearing under a stationary
    // cursor. Zero the swapped-in pair to reproduce both effects.
    for (const b of confirming
      ? [this.cancelButton, this.confirmButton]
      : [this.resetButton]) {
      this.zeroButton(b);
    }

    this.rowTitles[4]!.set(confirming ? "ARE YOU SURE?" : "RESET PROGRESS");
    this.rowDescs[4]!.set(confirming ? RESET_WARN : RESET_DESC);
    if (confirming) {
      this.resetLine.set("CONFIRM ERASES EVERYTHING");
    } else {
      this.resetLine.set(this.progressSummary());
    }
  }

  private progressSummary(): string {
    try {
      const [cleared, total] = this.save.progress();
      const stars = this.save.totalStars();
      const maxStars = this.save.maxStars();
      return (
        `${Math.trunc(cleared)} / ${Math.trunc(total)} LEVELS CLEARED   ` +
        `${Math.trunc(stars)} / ${Math.trunc(maxStars)} STARS   ` +
        `BEST ${grouped(this.save.highscore)}`
      );
    } catch {
      return "";
    }
  }

  // ------------------------------------------------------------------
  // actions
  // ------------------------------------------------------------------

  private click(name = "click"): void {
    this.sound?.play(name);
  }

  private flushSave(): void {
    // `save()`, not `flush()`: the Python writes unconditionally, so a click
    // on the already-selected chip still rewrites the file.
    try {
      this.save.save();
    } catch {
      // A settings screen must never take the game down with it.
    }
  }

  private activate(key: string): void {
    if (!key) return;
    if (key === "back") this.goBack();
    else if (key === "display_prev") this.cycleDisplay(-1);
    else if (key === "display_next") this.cycleDisplay(1);
    else if (key.startsWith("diff:")) this.setDifficulty(key.slice(5));
    else if (key === "sound") this.toggleSound();
    else if (key.startsWith("fx:")) this.toggleFx(key.slice(3));
    else if (key === "reset") {
      this.click();
      this.confirming = true;
      this.syncResetRow();
    } else if (key === "reset_cancel") {
      if (this.confirming) {
        this.click();
        this.confirming = false;
        this.syncResetRow();
      }
    } else if (key === "reset_confirm") {
      this.doReset();
    }
  }

  /**
   * Leave for wherever this screen was opened from. Pushed over a live stack
   * (the pause overlay), the honest way home is to pop, which uncovers exactly
   * the screen that opened us; `backTarget` is the fallback for the normal
   * case where we are the only scene.
   */
  private goBack(): void {
    if (this.leaving) return;
    this.leaving = true;
    this.click();
    this.flushSave();

    if (this.game.stackDepth > 1 && this.game.scene === this) {
      this.game.popScene();
      return;
    }

    const target = this.backTarget;
    if (!this.game.registeredScenes().includes(target)) {
      this.leaving = false;
      if (this.game.registeredScenes().includes(SCENES.MENU)) {
        this.game.switchScene(SCENES.MENU);
      }
      return;
    }
    if (target === SCENES.GAME) {
      this.game.switchScene(target, { level: Math.trunc(this.game.levelIndex || 0) });
    } else {
      this.game.switchScene(target);
    }
  }

  /** Step the display mode and apply it immediately. */
  private cycleDisplay(delta: number): void {
    const modes = DISPLAY_MODES;
    let index = (modes as readonly string[]).indexOf(this.displayMode());
    if (index < 0) index = 0;
    const steps = Math.trunc(delta) % modes.length;
    const chosen = modes[(index + steps + modes.length) % modes.length] ?? "windowed";
    this.click();
    this.game.setDisplayMode(chosen);
    // Persist what the shell actually holds, not what was requested - if the
    // fullscreen request is refused the fullscreenchange listener corrects
    // `game.displayMode` and the label follows it on the next frame.
    this.save.setDisplayMode(this.game.displayMode);
    this.flushSave();
    this.flash = 1.0;
    this.refreshLabels();
  }

  /** Select a difficulty; a no-op click on the current one still confirms. */
  private setDifficulty(key: string): void {
    const diff = getDifficulty(key);
    this.click();
    this.game.difficulty = diff.key;
    this.save.setDifficulty(diff.key);
    this.flushSave();
    this.flash = 1.0;
    this.refreshLabels();
  }

  /** Flip mute, persist it and relabel the control. */
  private toggleSound(): void {
    let muted = this.muted();
    if (this.sound) {
      muted = this.sound.toggleMute();
    } else {
      muted = !muted;
    }
    this.save.setMuted(muted);
    this.flushSave();
    // Audible confirmation only when unmuting - muting is silent.
    if (!muted) this.click();
    this.flash = 1.0;
    this.refreshLabels();
  }

  /** Flip one visual-effect switch, push it to the stack and persist it. */
  private toggleFx(flag: string): void {
    const fx = this.game.post.fx;
    const value = !this.fxFlag(flag);
    this.click();
    if (flag === "bloom") fx.setPostFlags({ bloom: value });
    else if (flag === "scanlines") fx.setPostFlags({ scanlines: value });
    else if (flag === "grain") fx.setPostFlags({ grain: value });
    else if (flag === "shake") fx.shakeEnabled = value;
    else return;
    // The Python probes for a setter the schema never grew; this schema did.
    this.save.setEffect(flag, value);
    this.flushSave();
    this.flash = 1.0;
    this.refreshLabels();
  }

  /**
   * Wipe the *progress* and rebuild the row. `SaveData.reset()` clears the
   * whole document, preferences included, but the button says RESET PROGRESS -
   * so the settings this screen owns are read first and written straight back.
   */
  private doReset(): void {
    this.click("die");
    const display = this.displayMode();
    const difficulty = this.difficulty().key;
    const muted = this.muted();
    const mode = this.game.mode;

    try {
      this.save.reset();
    } catch {
      // tolerated, as everywhere on this screen
    }
    this.save.setDisplayMode(display);
    this.save.setDifficulty(difficulty);
    this.save.setMuted(muted);
    if (GAME_MODES.includes(mode)) this.save.setMode(mode);
    this.flushSave();

    this.game.levelIndex = 0;

    this.confirming = false;
    this.resetFlash = 1.0;
    this.flash = 1.0;
    this.syncResetRow();
    // No particle burst: this scene does not draw `game.particles`, so
    // spawning into it would only leak emitters into the next screen.
  }

  // ------------------------------------------------------------------
  // frame
  // ------------------------------------------------------------------

  override update(dt: number): void {
    const d = clamp(dt, 0, C.MAX_DT);

    // Events before the update, so a move writes `hovered` before
    // `justEntered` is computed and a tap lands inside one frame.
    let fired: string | null = null;
    const active = this.activeButtons();
    for (const ev of this.game.uiEvents) {
      for (const b of active) {
        if (b.handlePointer(ev) && fired === null) fired = String(b.data);
      }
    }
    for (const ev of this.game.keyEvents) {
      if (ev.type !== "down" || ev.repeat) continue;
      const k = ev.key.toLowerCase();
      if (k === "escape" || k === "backspace") {
        fired ??= this.confirming ? "reset_cancel" : "back";
      } else if (k === "arrowleft" || k === "a") fired ??= "display_prev";
      else if (k === "arrowright" || k === "d") fired ??= "display_next";
      else if (k === "m") fired ??= "sound";
    }

    this.t += d;
    if (this.intro < 1) this.intro = clamp(this.intro + d / INTRO_TIME, 0, 1);
    this.flash = Math.max(0, this.flash - d * 2.0);
    this.resetFlash = Math.max(0, this.resetFlash - d * 0.7);

    this.bg?.update(d);

    let hint = "";
    for (const b of active) {
      b.update(d, this.game.pointer);
      if (b.justEntered) this.click("hover");
      if (b.hovered) {
        const key = String(b.data);
        if (key.startsWith("fx:")) {
          hint = FX_TOGGLES.find(([k]) => k === key.slice(3))?.[2] ?? "";
        }
      }
    }
    this.fxHint = hint;

    this.updatePreview(d);
    this.refresh();

    if (fired !== null) this.activate(fired);
  }

  /** Advance the demo snake and the demo camera knock. */
  private updatePreview(dt: number): void {
    const snake = this.snake;
    if (!snake) return;
    this.orbit += dt;
    // A lazy figure-of-eight well inside the preview box; 0.85 : 1.31 never
    // exactly repeats.
    const rx = WELL.w * 0.5 - 72.0;
    const ry = WELL.h * 0.5 - 64.0;
    snake.setTarget(
      WELL.w * 0.5 + Math.cos(this.orbit * 0.85) * rx,
      WELL.h * 0.5 + Math.sin(this.orbit * 1.31) * ry,
    );
    snake.update(dt);

    // If the head ever escapes the box (a stall, a huge dt), put it back.
    const head = snake.headPos();
    if (!(-40 < head.x && head.x < WELL.w + 40 && -40 < head.y && head.y < WELL.h + 40)) {
      snake.reset(WELL.w * 0.5, WELL.h * 0.5, 0);
    }

    // Demo shake: a periodic knock so the switch has something to show. The
    // decay runs outside the flag test, so a knock in flight still dies after
    // the switch is turned off.
    if (this.fxFlag("shake")) {
      this.shakeNext -= dt;
      if (this.shakeNext <= 0) {
        this.shakeNext = SHAKE_PERIOD;
        this.wellShake = SHAKE_TRAUMA;
      }
    }
    this.wellShake = Math.max(0, this.wellShake - dt * SHAKE_DECAY);

    this.grainAt += dt;
    if (this.grainAt >= 1 / 18) {
      this.grainAt = 0;
      this.grainIndex = (this.grainIndex + 1) % GRAIN_FRAMES;
    }
  }

  /** Panel opacity for the entry fade - never starts fully transparent. */
  private panelAlpha(full: number): number {
    const fade = easeOutCubic(clamp(this.intro, 0, 1));
    return Math.trunc(clamp(full * (0.45 + 0.55 * fade), 0, 255));
  }

  /** Per-frame visual refresh - Pixi retains everything, so this only writes
   * animated properties. */
  private refresh(): void {
    const theme = this.theme;
    const t = this.t;

    this.headerTitle.setColor(
      lerpColor(theme.accent, UI_WHITE, 0.3 + 0.2 * pulse(t, 1.6)),
    );
    this.headerTitle.place(PAD, 18, "left");
    this.headerSub.place(PAD + 4, 64, "left");

    // Row panels wash in; the confirm row's glow pulses.
    for (let i = 0; i < 5; i++) {
      const glow = i === 4 && this.confirming ? 0.35 + 0.25 * pulse(t, 4.0) : 0.22;
      this.panels[i]!.setStyle(theme.accent, this.panelAlpha(214), true, glow);
    }
    this.panels[5]!.setStyle(theme.accent, this.panelAlpha(216), true, 0.3);

    // The display label re-reads the shell every frame, so it cannot lie when
    // the user leaves fullscreen with the browser's own Escape.
    this.dispValue.setLabel(this.displayLabel());

    // Sound meter: nine bars growing upward from a fixed baseline.
    const muted = this.muted();
    this.soundMeter.clear();
    const baseX = ROW_SOUND.x + 470;
    const baseY = ROW_SOUND.y + 54;
    for (let i = 0; i < 9; i++) {
      const h = muted ? 3 : 3 + 14 * pulse(t * 5 + i * 0.7, 1.0);
      const col = muted
        ? shade(theme.textDim, 0.7)
        : lerpColor(theme.accent, UI_GOOD, i / 8);
      this.soundMeter.roundRect(baseX + i * 9, baseY - h, 5, h, 2).fill(toHex(col));
    }

    // Reset row third line.
    if (this.confirming) {
      this.resetLine.setColor(lerpColor(UI_BAD, UI_WHITE, 0.35 + 0.35 * pulse(t, 6.0)));
    } else {
      this.resetLine.setColor(
        lerpColor(theme.textDim, UI_GOOD, 0.2 + 0.6 * this.resetFlash),
      );
    }

    // Preview hint: the hovered switch's description, or the nudge.
    const hintColor = this.fxHint
      ? lerpColor(theme.text, theme.accent, 0.4)
      : theme.textDim;
    const lines = wrapText(
      this.game.fonts,
      this.game.fonts.tiny,
      this.fxHint || PREVIEW_HINT,
      PREVIEW_PANEL.w - 40,
      { maxLines: 3 },
    );
    for (let i = 0; i < 3; i++) {
      const line = this.hintLines[i]!;
      line.set(lines[i] ?? "");
      line.setColor(hintColor);
    }

    // Live summary of everything this screen owns.
    const diff = this.difficulty();
    const mix = 0.25 + 0.35 * this.flash;
    const values: Array<[string, RGB]> = [
      [this.displayLabel(), theme.accent],
      [difficultyLabel(diff), diff.color],
      [muted ? "OFF" : "ON", muted ? UI_BAD : UI_GOOD],
      [this.effectsSummary(), theme.accent2],
    ];
    for (let i = 0; i < 4; i++) {
      const [text, colour] = values[i]!;
      this.summaryValues[i]!.set(text);
      this.summaryValues[i]!.setColor(lerpColor(colour, UI_WHITE, mix));
    }

    this.drawWell();

    for (const b of this.activeButtons()) b.draw(theme, t);
  }

  /** The miniature post chain over the demo snake. */
  private drawWell(): void {
    const snake = this.snake;
    const hasSnake = snake !== null;
    this.wellShift.visible = hasSnake;
    if (!hasSnake) return;

    this.snakeView.draw(snake, this.theme, this.t, {});

    this.bloom.enabled = this.fxFlag("bloom");
    this.scanSprite.visible = this.fxFlag("scanlines");
    const grain = this.fxFlag("grain");
    this.grainSprite.visible = grain;
    if (grain) {
      const frames = grainFrames();
      this.grainSprite.texture = frames[this.grainIndex % frames.length]!;
      this.grainSprite.width = WELL.w;
      this.grainSprite.height = WELL.h;
    }

    // The camera knock: truncation toward zero, matching Python's int().
    let ox = 0;
    let oy = 0;
    if (this.wellShake > 0.01) {
      const amp = SHAKE_PIXELS * this.wellShake * this.wellShake;
      ox = Math.trunc(Math.sin(this.t * 47.0) * amp);
      oy = Math.trunc(Math.cos(this.t * 39.0) * amp * 0.8);
    }
    this.wellShift.position.set(WELL.x + ox, WELL.y + oy);
  }
}

/** Reset the module-level texture caches. Tests and hot-reload only. */
export function clearSettingsTextureCache(): void {
  scanlineTexture?.destroy(true);
  scanlineTexture = null;
  if (grainTextures) for (const t of grainTextures) t.destroy(true);
  grainTextures = null;
}
