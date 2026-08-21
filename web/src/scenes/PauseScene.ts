/**
 * The pause overlay - a port of `snake/scenes/pause.py`.
 *
 * The one **transparent** scene: the gameplay scene underneath keeps being
 * drawn, frozen, because `blocksUpdate` stops it receiving `update`, and this
 * paints on top of it.
 *
 * The frozen frame is snapshotted **once** on entry and blurred with a
 * downscale/upscale round trip - the hardware filter does the averaging, so a
 * box blur costs nothing. Blurring per frame would buy nothing: the frame
 * behind never changes while we are paused. In Pixi that is
 * `generateTexture` at a fraction of the resolution, drawn back at full size.
 *
 * Every action is reachable with the mouse alone; Esc / P / Space resume,
 * R restarts, M toggles sound, S or O opens settings.
 *
 * Note SETTINGS is a **push**, not a switch, and deliberately does not arm the
 * closing guard: the run underneath has to survive a detour into the options,
 * and re-arming would leave every pause button dead when settings pops back.
 */

import { Container, Rectangle, Sprite, Texture } from "pixi.js";

import type { Game } from "../app/Game";
import { Scene, SCENES, type SceneEnterArgs } from "../app/Scene";
import * as C from "../core/config";
import { clamp, easeOutBack, easeOutCubic, pulse } from "../core/mathx";
import { getLevel } from "../core/level";
import {
  UI_WHITE,
  lerpColor,
  shade,
  themeForLevel,
  toHex,
  type Theme,
} from "../core/palette";
import type { SaveData } from "../core/save";
import type { Audio } from "../audio";
import { canvasTexture, context2d, createCanvas, cssRgb, whiteTexture } from "../gfx/textures";
import { Button } from "../ui/Button";
import { Panel } from "../ui/panel";
import { Label } from "../ui/text";

/** Panel geometry. pause.py:31-39 */
const PANEL_W = 470;
const PANEL_H = 646;
const BTN_H = 54;
const BTN_GAP = 11;
/** How aggressively the frozen frame is blurred: bigger is blurrier and cheaper. */
const BLUR_DOWNSCALE = 7;
/** Seconds the panel takes to fly in. pause.py:45 */
const INTRO_TIME = 0.34;
/** How far the panel drops before settling. pause.py:300 */
const INTRO_RISE = 46;
/** The title block above the first button. pause.py:145 */
const BUTTON_TOP = 168;
/** Divider width at rest, and its row. pause.py:367-369 */
const RULE_W = PANEL_W - 120;
const RULE_Y = 118;

const HINTS = [
  "MOVE   steer with the mouse",
  "BOOST  hold the right mouse button",
  "PAUSE  Esc or P",
] as const;

const SPECS: ReadonlyArray<readonly [string, string, "primary" | "ghost" | "danger"]> = [
  ["resume", "RESUME", "primary"],
  ["restart", "RESTART LEVEL", "ghost"],
  ["sound", "", "ghost"],
  ["settings", "SETTINGS", "ghost"],
  ["levels", "LEVEL SELECT", "ghost"],
  ["menu", "QUIT TO MENU", "danger"],
];

/**
 * The rule under the title: a two-colour gradient that fades out at both ends
 * so it has no hard edges.
 *
 * Baked at full width and scaled, which keeps the alpha profile in the same
 * relative place - the profile is defined in `x / (w - 1)` terms, so a scaled
 * copy is the same curve.
 */
const ruleCache = new Map<string, Texture>();

/** Cache key: the two accents are the only thing the gradient reads. */
function ruleKey(theme: Theme): string {
  return `${toHex(theme.accent)}|${toHex(theme.accent2)}`;
}

function ruleTexture(theme: Theme): Texture {
  // Cached per theme pair: pausing under each of the twelve level themes used
  // to mint (and orphan, undestroyed) a fresh texture every time.
  const key = ruleKey(theme);
  const hit = ruleCache.get(key);
  if (hit) return hit;
  const w = RULE_W;
  const canvas = createCanvas(w, 2);
  const ctx = context2d(canvas);
  ctx.clearRect(0, 0, w, 2);
  for (let x = 0; x < w; x++) {
    const f = x / Math.max(1, w - 1);
    const a = Math.trunc(200 * Math.pow(1 - Math.abs(f - 0.5) * 2, 0.6));
    ctx.fillStyle = cssRgb(lerpColor(theme.accent, theme.accent2, f), a / 255);
    ctx.fillRect(x, 0, 1, 2);
  }
  const tex = canvasTexture(canvas);
  ruleCache.set(key, tex);
  return tex;
}

export class PauseScene extends Scene {
  /** The scene below is still drawn... */
  static override transparent = true;
  /** ...but it does not advance. */
  static override blocksUpdate = true;

  readonly root = new Container();

  private readonly save: SaveData;
  private readonly sound: Audio | null;

  private t = 0;
  private intro = 0;
  private levelIndex = 0;
  private levelName = "";
  private closing = false;

  private readonly blur = new Sprite();
  private readonly scrim = new Sprite(whiteTexture());
  private readonly panel = new Panel();
  private readonly title: Label;
  private readonly rule = new Sprite();
  private readonly levelLabel: Label;
  private readonly caption: Label;
  private readonly hints: Label[] = [];
  private readonly buttons: Button[] = [];
  private readonly baseY: number[] = [];

  private ruleTheme = "";
  private blurTexture: Texture | null = null;

  constructor(game: Game, save: SaveData, sound: Audio | null = null) {
    super(game);
    this.save = save;
    this.sound = sound;

    this.title = new Label(game.fonts, game.fonts.displayAt(74));
    this.levelLabel = new Label(game.fonts, game.fonts.tiny);
    // pause.py:384 asks for ("body", 22), but the shim ignores the size when
    // the name resolves, so this really renders at body's 21 px.
    this.caption = new Label(game.fonts, game.fonts.body);

    this.root.addChild(this.blur, this.scrim, this.panel, this.title, this.rule);
    this.root.addChild(this.levelLabel, this.caption);

    const panelX = (C.WINDOW_W - PANEL_W) * 0.5;
    const panelY = (C.WINDOW_H - PANEL_H) * 0.5;
    const cx = C.WINDOW_W * 0.5;
    SPECS.forEach(([key, label, style], i) => {
      const cy = panelY + BUTTON_TOP + i * (BTN_H + BTN_GAP) + BTN_H * 0.5;
      const btn = new Button(
        game.fonts,
        { x: cx - C.UI_BUTTON_W * 0.5, y: cy - BTN_H * 0.5, w: C.UI_BUTTON_W, h: BTN_H },
        label,
        { style, data: key },
      );
      this.buttons.push(btn);
      this.baseY.push(cy);
      this.root.addChild(btn.root);
    });
    void panelX;

    for (let i = 0; i < HINTS.length; i++) {
      const l = new Label(game.fonts, game.fonts.tiny);
      l.set(HINTS[i]!);
      this.hints.push(l);
      this.root.addChild(l);
    }

    this.blur.position.set(0, 0);
  }

  // -------------------------------------------------------------------
  // lifecycle
  // -------------------------------------------------------------------

  override onEnter(args?: SceneEnterArgs): void {
    // Scenes are cached and reused, so every field is rebuilt here.
    this.t = 0;
    this.intro = 0;
    this.closing = false;

    const override = args?.["levelIndex"];
    this.levelIndex = Math.max(
      0,
      Math.trunc(typeof override === "number" ? override : this.game.levelIndex),
    );
    const nameOverride = args?.["levelName"];
    this.levelName =
      typeof nameOverride === "string" && nameOverride
        ? nameOverride
        : (getLevel(this.levelIndex)?.name ?? themeForLevel(this.levelIndex).name);

    this.snapshot();
    this.syncSoundLabel();
  }

  override onExit(): void {
    // The snapshot is a full-screen texture and is invalid the moment the
    // frame behind us changes.
    this.blurTexture?.destroy(true);
    this.blurTexture = null;
    this.blur.texture = Texture.EMPTY;
    this.closing = false;
  }

  /**
   * Grab the last rendered frame at a fraction of its size.
   *
   * Drawing it back at full size *is* the blur: the GPU's linear filter does
   * the averaging, exactly as pygame's `smoothscale` round trip does.
   */
  private snapshot(): void {
    const renderer = this.game.app?.renderer;
    if (!renderer) return;
    // The reticle lives in the same container and would otherwise be frozen
    // into the blur.
    const cursorRoot = this.game.cursor?.root;
    const wasVisible = cursorRoot?.visible ?? false;
    if (cursorRoot) cursorRoot.visible = false;
    this.root.visible = false;
    try {
      this.blurTexture?.destroy(true);
      this.blurTexture = renderer.generateTexture({
        target: this.game.post.scene,
        resolution: 1 / BLUR_DOWNSCALE,
        frame: new Rectangle(0, 0, C.WINDOW_W, C.WINDOW_H),
      });
      this.blur.texture = this.blurTexture;
      this.blur.width = C.WINDOW_W;
      this.blur.height = C.WINDOW_H;
    } catch (err) {
      // A snapshot is a nicety; the scrim alone still reads as paused.
      console.warn("[pause] could not snapshot the frame", err);
      this.blurTexture = null;
      this.blur.texture = Texture.EMPTY;
    } finally {
      this.root.visible = true;
      if (cursorRoot) cursorRoot.visible = wasVisible;
    }
  }

  // -------------------------------------------------------------------
  // input
  // -------------------------------------------------------------------

  private soundLabel(): string {
    return this.sound?.muted ? "SOUND:  OFF" : "SOUND:  ON";
  }

  private syncSoundLabel(): void {
    for (const b of this.buttons) {
      if (b.data === "sound") b.setLabel(this.soundLabel());
    }
  }

  private cue(name = "click"): void {
    this.sound?.play(name);
  }

  private activate(key: string): void {
    if (this.closing && key !== "sound") return;
    switch (key) {
      case "resume":
        this.closing = true;
        this.cue("click");
        this.game.popScene();
        break;
      case "restart":
        this.closing = true;
        this.cue("start");
        this.game.levelIndex = this.levelIndex;
        this.game.switchScene(SCENES.GAME, { level: this.levelIndex });
        break;
      case "sound":
        this.toggleSound();
        break;
      case "settings":
        // A push, not a switch, and the closing guard is left alone - see the
        // note on the class.
        this.cue("click");
        if (this.game.registeredScenes().includes(SCENES.SETTINGS)) {
          this.game.pushScene(SCENES.SETTINGS, { back: SCENES.PAUSE });
        }
        break;
      case "levels":
        this.closing = true;
        this.cue("click");
        if (this.game.registeredScenes().includes(SCENES.LEVELS)) {
          this.game.switchScene(SCENES.LEVELS);
        }
        break;
      case "menu":
        this.closing = true;
        this.cue("click");
        if (this.game.registeredScenes().includes(SCENES.MENU)) {
          this.game.switchScene(SCENES.MENU);
        }
        break;
      default:
        break;
    }
  }

  private toggleSound(): void {
    const muted = !(this.sound?.muted ?? false);
    this.sound?.setMuted(muted);
    this.save.setMuted(muted);
    this.save.save();
    // Audible confirmation only when there is something to hear.
    if (!muted) this.cue("click");
    this.syncSoundLabel();
  }

  // -------------------------------------------------------------------
  // frame
  // -------------------------------------------------------------------

  override update(dt: number): void {
    const d = clamp(dt, 0, C.MAX_DT);
    this.t += d;
    if (this.intro < 1) this.intro = clamp(this.intro + d / INTRO_TIME, 0, 1);

    // Events before update, so a move can write `hovered` before `justEntered`
    // is derived from it - the same order as the Python's pump.
    let fired: string | null = null;
    for (const ev of this.game.uiEvents) {
      for (const b of this.buttons) {
        if (b.handlePointer(ev) && fired === null) fired = String(b.data);
      }
    }
    for (const ev of this.game.keyEvents) {
      if (ev.type !== "down" || ev.repeat) continue;
      if (ev.key === "Escape" || ev.key === "p" || ev.key === " ") fired ??= "resume";
      else if (ev.key === "r") fired ??= "restart";
      else if (ev.key === "m") fired ??= "sound";
      else if (ev.key === "s" || ev.key === "o") fired ??= "settings";
    }

    // ease_out_back overshoots, so the panel settles with a little bounce.
    // The buttons ride the same offset, which keeps their hit rects exactly
    // where they are drawn.
    const offset = Math.round((1 - easeOutBack(this.intro)) * INTRO_RISE);
    // Settings can be stacked on top of this scene and flip mute while it is
    // there, so the label is re-read rather than only written by our toggle.
    this.syncSoundLabel();

    for (let i = 0; i < this.buttons.length; i++) {
      const b = this.buttons[i]!;
      b.rect.y = this.baseY[i]! + offset - BTN_H * 0.5;
      const was = b.hovered;
      b.update(d, this.game.pointer);
      if (b.hovered && !was) this.cue("hover");
    }

    this.draw(offset);
    if (fired !== null) this.activate(fired);
  }

  private draw(offset: number): void {
    const theme = themeForLevel(this.levelIndex);
    const fade = easeOutCubic(this.intro);

    this.blur.alpha = clamp(fade, 0, 1);
    this.blur.visible = this.blurTexture !== null;

    const over = this.game.viewport.overscan;
    this.scrim.position.set(over.x, over.y);
    this.scrim.width = over.w;
    this.scrim.height = over.h;
    this.scrim.tint = toHex(shade(theme.bgBottom, 0.55));
    this.scrim.alpha = (168 * fade) / 255;

    const px = (C.WINDOW_W - PANEL_W) * 0.5;
    const py = (C.WINDOW_H - PANEL_H) * 0.5 + offset;
    const cx = C.WINDOW_W * 0.5;

    this.panel.setRect(px, py, PANEL_W, PANEL_H);
    this.panel.setStyle(theme.accent, 232 * fade, true, 0.45 + 0.25 * pulse(this.t, 1.8));

    const breathe = 0.6 + 0.4 * pulse(this.t, 2.2);
    this.title.set("PAUSED");
    this.title.setColor(lerpColor(theme.accent, UI_WHITE, 0.25 + 0.35 * breathe));
    this.title.place(cx, py + 30, "center");

    const key = ruleKey(theme);
    if (key !== this.ruleTheme) {
      this.ruleTheme = key;
      this.rule.texture = ruleTexture(theme);
    }
    const lineW = RULE_W * fade;
    this.rule.visible = lineW > 4;
    if (this.rule.visible) {
      this.rule.width = lineW;
      this.rule.height = 2;
      this.rule.position.set(cx - lineW * 0.5, py + RULE_Y);
    }

    this.levelLabel.set(`LEVEL ${String(this.levelIndex + 1).padStart(2, "0")}`);
    this.levelLabel.setColor(theme.textDim);
    this.levelLabel.place(cx, py + 94, "center");

    this.caption.set(this.levelName ? this.levelName.toUpperCase() : "IN PLAY");
    this.caption.setColor(lerpColor(theme.text, theme.accent2, 0.35));
    this.caption.place(cx, py + 128, "center");

    for (const b of this.buttons) b.draw(theme, this.t);

    // Sits under the last button; anchoring to the panel bottom has to leave
    // the three lines room.
    const hy = py + PANEL_H - 76;
    for (let i = 0; i < this.hints.length; i++) {
      const l = this.hints[i]!;
      l.setColor(shade(theme.textDim, 0.95 - 0.12 * i));
      l.place(cx, hy + i * 19, "center");
    }
  }
}
