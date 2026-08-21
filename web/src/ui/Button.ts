/**
 * The button - a port of `snake/gfx/ui.py:355-587`.
 *
 * Every scene's interaction goes through this widget, and it is smaller than it
 * looks. It owns no callback, no sound and no keyboard focus: `handlePointer`
 * returning `true` exactly once per completed click is the entire API, and the
 * scenes keep their own focus layer and play their own cues. There are only two
 * body variants, cold and hot, cross-faded by a hover weight - no held state,
 * no selected state, and no disabled veil.
 *
 * Things that look wrong and are not:
 *
 * - **The click is edge-triggered on release, and both ends must land inside.**
 *   Dragging off a button cancels it.
 * - **Hovering makes the card more solid, not just brighter.** Both bodies are
 *   translucent and the hot one is composited *over* the cold one, so a primary
 *   button goes from 84% to 97% effective opacity. Swapping one sprite's
 *   texture would lose that; two stacked sprites reproduce it exactly.
 * - **The halo is a solid additive plate under the whole card**, not a ring -
 *   `_rrect_glow` has no `i = 0` band - and it shows through the translucent
 *   body. A ring reads as a flat card.
 * - **The halo is built unscaled and anchored to the scaled top-left**, so at
 *   peak hover it drifts a few pixels left and up relative to the body. Copied:
 *   the glow sprite is deliberately not parented to the scaled node.
 * - **Idle buttons do not breathe.** The Python computes an idle shimmer and
 *   then quantises it away with `round(power, 1)`, which maps every reachable
 *   idle value to 0.1. A continuous alpha would add a 3.9 s pulse to every menu
 *   button that the captures do not have, so the rounding is kept.
 * - **The hover cue does not fire when the cursor moves onto a button.** The
 *   move event sets `hovered` before the same frame's `update` runs, so
 *   `justEntered` is already false by the time it is computed. It fires only
 *   when the rect moves under a resting cursor, or on the first update after a
 *   scene entry. Getting this wrong is five extra chirps crossing the main menu
 *   and no screenshot would show it.
 *
 * See `docs/port/ui.md` section 5 for the full derivation and the call-site
 * census.
 */

import { Container, NineSliceSprite, Sprite, type Texture } from "pixi.js";

import type { UiPointerEvent } from "../app/Game";
import * as C from "../core/config";
import {
  UI_BAD,
  UI_PANEL,
  UI_PANEL_LIGHT,
  UI_WHITE,
  lerpColor,
  shade,
  toHex,
  type RGB,
  type Theme,
} from "../core/palette";
import { pulse } from "../core/mathx";
import type { FontBook } from "../gfx/fonts";
import { canvasTexture, context2d, createCanvas, cssRgb } from "../gfx/textures";
import { PANEL_GLOW_SPREAD, PANEL_GRADIENT_GAMMA, panelGlowTexture } from "./panel";
import { uiGlowSprite, setUiGlow } from "./glow";
import { Label } from "./text";

// ---------------------------------------------------------------------------
// Constants. All are literals inside ui.py with no entry in config.json.
// ---------------------------------------------------------------------------

/** Button's own dt clamp, unrelated to C.MAX_DT. ui.py:453 */
const DT_CLAMP = 0.1;
/** Hover cross-fade rate: 95% in 0.230 s. ui.py:460 */
const HOVER_RATE = 13.0;
/** Press cross-fade rate: 95% in 0.136 s. ui.py:463 */
const PRESS_RATE = 22.0;
/** Click-flash decay, linear: a flash lasts 0.3125 s. ui.py:464 */
const FLASH_DECAY = 3.2;
/** Hover grows the card 3.5%; a full press shrinks it 5.5%. ui.py:507 */
const HOVER_SCALE = 0.035;
const PRESS_SCALE = 0.055;
/** Hover lifts 3 px; a press pushes 2 px back down. ui.py:508 */
const HOVER_LIFT = -3.0;
const PRESS_LIFT = 2.0;
/** Below this the body is drawn unscaled, so growth snaps in. ui.py:527, 556 */
const SCALE_DEADBAND = 0.015;
/** Idle glow, quantised out of existence by the 0.1 rounding. ui.py:520 */
const GLOW_IDLE_BASE = 0.1;
const GLOW_IDLE_AMP = 0.05;
const GLOW_IDLE_SPEED = 1.6;
const GLOW_PHASE_PER_PX = 0.01;
/** Hover and post-click contributions to the glow. ui.py:521 */
const GLOW_HOVER = 0.85;
const GLOW_FLASH = 0.5;
/** Outline alpha, hot and cold. ui.py:397 */
const BORDER_ALPHA_HOT = 235;
const BORDER_ALPHA_COLD = 150;
/** Inner rim light, hot only. ui.py:410 */
const RIM_ALPHA = 70;
const RIM_MIX = 0.6;
/** The tile shoulder. ui.py:402-407 */
const SHOULDER_H = 6;
const SHOULDER_Y = 2;
const SHOULDER_ALPHA_HOT = 230;
const SHOULDER_ALPHA_COLD = 130;
/** Tile cards get a 6 px larger corner. ui.py:395 */
const TILE_CORNER_BONUS = 6;
/** Tile labels sit this far above the bottom edge. ui.py:549 */
const TILE_LABEL_INSET = 26;
/** Tile icons sit this far above centre. ui.py:550 */
const TILE_ICON_RISE = 8;
/** Non-tile icons sit this far in from the left edge. ui.py:552 */
const ICON_LEFT_INSET = 26;
/** Icon glow radius, and its intensity ramp. ui.py:584 */
const ICON_GLOW_RADIUS = 26;
/** Disabled transform. ui.py:379-381 */
const DISABLED_EDGE = 0.35;
const DISABLED_TEXT = 0.45;
const DISABLED_ALPHA = 0.7;

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

export type ButtonStyle = "primary" | "ghost" | "danger" | "tile";

/** ui.py:358. An unknown style is coerced to "primary" by the constructor. */
export const BUTTON_STYLES: readonly ButtonStyle[] = ["primary", "ghost", "danger", "tile"];

export interface ButtonFace {
  readonly edge: RGB;
  readonly text: RGB;
  /** Body alpha, 0-255. */
  readonly alpha: number;
  /** Outline width: 3 when hot, 2 when cold. */
  readonly border: number;
}

/**
 * `_button_palette` - ui.py:361-382.
 *
 * Note there is no per-style *fill* colour: the fill is always the
 * theme-independent `UI_PANEL_LIGHT -> UI_PANEL` gradient, and the style
 * chooses only its alpha.
 */
export function buttonFace(
  style: ButtonStyle,
  theme: Theme,
  hot: boolean,
  enabled: boolean,
): ButtonFace {
  let edge: RGB;
  let text: RGB;
  let alpha: number;

  if (style === "danger") {
    edge = UI_BAD;
    text = hot ? UI_WHITE : lerpColor(UI_BAD, UI_WHITE, 0.5);
    alpha = 220;
  } else if (style === "ghost") {
    edge = hot ? theme.accent : theme.textDim;
    text = hot ? theme.text : theme.textDim;
    alpha = 120;
  } else if (style === "tile") {
    edge = hot ? theme.accent : theme.accent2;
    text = hot ? theme.text : lerpColor(theme.text, theme.textDim, 0.5);
    alpha = 225;
  } else {
    edge = hot ? lerpColor(theme.accent, UI_WHITE, 0.35) : theme.accent;
    text = theme.text;
    alpha = 215;
  }

  if (!enabled) {
    edge = shade(edge, DISABLED_EDGE);
    text = shade(text, DISABLED_TEXT);
    alpha = Math.trunc(alpha * DISABLED_ALPHA);
  }
  return { edge, text, alpha, border: hot ? 3 : 2 };
}

// ---------------------------------------------------------------------------
// Body texture
// ---------------------------------------------------------------------------

const bodyCache = new Map<string, Texture>();
const BODY_CACHE_LIMIT = 96;

/**
 * The composed body: gradient, outline, tile shoulder, inner rim light.
 *
 * Baked rather than tinted because it holds two things tint x alpha cannot
 * express - strokes that *replace* RGBA instead of blending, and a two-colour
 * horizontal gradient on the tile shoulder.
 *
 * The alpha is baked in too, which differs from the panel; there are only eight
 * reachable values and keeping them in the texture avoids a second sprite.
 */
export function buttonBodyTexture(
  w: number,
  h: number,
  style: ButtonStyle,
  face: ButtonFace,
  accent2: RGB,
  hot: boolean,
): Texture {
  const width = Math.max(4, Math.round(w));
  const height = Math.max(4, Math.round(h));
  const corner = C.UI_CORNER + (style === "tile" ? TILE_CORNER_BONUS : 0);
  const edgeHex = toHex(face.edge);
  // Keying on the resolved edge (rather than on the theme fields, as Python
  // does) incidentally fixes its missing-text_dim key without changing a pixel.
  const key = `${width}|${height}|${style}|${hot ? 1 : 0}|${edgeHex}|${face.alpha}|${toHex(accent2)}`;
  const hit = bodyCache.get(key);
  if (hit) return hit;

  const canvas = createCanvas(width, height);
  const ctx = context2d(canvas);
  ctx.clearRect(0, 0, width, height);

  // 1. The frosted body: the panel gradient with border=False, so none of the
  //    panel's own rim or bevel.
  const last = Math.max(1, height - 1);
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = face.alpha / 255;
  for (let y = 0; y < height; y++) {
    const f = Math.pow(y / last, PANEL_GRADIENT_GAMMA);
    ctx.fillStyle = cssRgb(lerpColor(UI_PANEL_LIGHT, UI_PANEL, f));
    ctx.fillRect(0, y, width, 1);
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "destination-in";
  ctx.fillStyle = "#fff";
  ctx.beginPath();
  ctx.roundRect(0, 0, width, height, corner);
  ctx.fill();

  // 2. The outline. pygame's draw replaces RGBA rather than blending, so the
  //    cold rim ends up *more* transparent than the body it overwrites - the
  //    see-through rim is deliberate art. Erase first, then paint.
  const bw = face.border;
  const strokePath = (): void => {
    ctx.beginPath();
    ctx.roundRect(bw / 2, bw / 2, width - bw, height - bw, Math.max(0, corner - bw / 2));
  };
  ctx.lineWidth = bw;
  ctx.globalCompositeOperation = "destination-out";
  ctx.strokeStyle = "#fff";
  strokePath();
  ctx.stroke();
  ctx.globalCompositeOperation = "source-over";
  ctx.strokeStyle = cssRgb(face.edge, (hot ? BORDER_ALPHA_HOT : BORDER_ALPHA_COLD) / 255);
  strokePath();
  ctx.stroke();

  // 3. The tile shoulder, with its two shipped geometry quirks: the source
  //    sub-rect is offset from the destination, so the gradient is sampled 9 px
  //    to the right of where it lands and the strip stops a whole corner short
  //    of the right edge; and it is blitted (blending) with no corner clip, so
  //    a small nub sits outside the rounded top-left corner.
  if (style === "tile") {
    const shoulderAlpha = (hot ? SHOULDER_ALPHA_HOT : SHOULDER_ALPHA_COLD) / 255;
    const half = Math.trunc(corner * 0.5);
    const span = width - corner;
    for (let i = 0; i < span; i++) {
      const u = (i + half) / Math.max(1, width - 1);
      ctx.fillStyle = cssRgb(lerpColor(face.edge, accent2, u), shoulderAlpha);
      ctx.fillRect(i, SHOULDER_Y, 1, SHOULDER_H);
    }
  }

  // 4. The inner rim light, hot only - also a replacing draw.
  if (hot) {
    const inset = bw + 1;
    const iw = width - bw * 2 - 2;
    const ih = height - bw * 2 - 2;
    const ir = Math.max(2, corner - bw);
    if (iw > 0 && ih > 0) {
      const innerPath = (): void => {
        ctx.beginPath();
        ctx.roundRect(inset + 0.5, inset + 0.5, iw - 1, ih - 1, Math.max(0, ir - 0.5));
      };
      ctx.lineWidth = 1;
      ctx.globalCompositeOperation = "destination-out";
      ctx.strokeStyle = "#fff";
      innerPath();
      ctx.stroke();
      ctx.globalCompositeOperation = "source-over";
      ctx.strokeStyle = cssRgb(lerpColor(face.edge, UI_WHITE, RIM_MIX), RIM_ALPHA / 255);
      innerPath();
      ctx.stroke();
    }
  }

  // Dropping the oldest entry bounds the cache; it must NOT destroy the
  // texture. `draw` re-fetches only when its own `bodyKey` changes, so a
  // parked button in another cached scene would keep drawing a destroyed
  // texture forever - and the menu's theme carousel mints ~48 bodies per
  // 11 s period, so the 96-entry cache turns over in about half a minute of
  // idling. Pixi's TextureGCSystem reclaims what nothing draws any more.
  if (bodyCache.size >= BODY_CACHE_LIMIT) {
    const oldest = bodyCache.keys().next();
    if (!oldest.done) bodyCache.delete(oldest.value);
  }
  const tex = canvasTexture(canvas);
  bodyCache.set(key, tex);
  return tex;
}

// ---------------------------------------------------------------------------
// The widget
// ---------------------------------------------------------------------------

export interface RectLike {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ButtonOptions {
  /** Overrides the per-style default face. */
  font?: import("pixi.js").TextStyleOptions | null;
  /** A glyph. No scene in the shipped game passes one. */
  icon?: string | null;
  style?: ButtonStyle;
  enabled?: boolean;
  /** The scene's action payload: a string, a tuple, an index - anything. */
  data?: unknown;
}

/**
 * Half-open, exactly like `pygame.Rect.collidepoint`.
 *
 * Deliberately not `mathx.rectContains`, which is closed at both ends: that
 * widens every button by a pixel and lets two abutting buttons both claim the
 * edge between them.
 */
export function hits(r: RectLike, px: number, py: number): boolean {
  return px >= r.x && px < r.x + r.w && py >= r.y && py < r.y + r.h;
}

/**
 * A button's input and animation state, with no display objects attached.
 *
 * Split out so the click semantics - which are the fiddly part, and the part a
 * regression would be silent - can be tested without a GPU or a DOM. {@link
 * Button} owns one of these and does nothing else with input.
 */
export class ButtonState {
  readonly rect: RectLike;
  enabled: boolean;

  hovered = false;
  justEntered = false;
  hoverT = 0;
  pressT = 0;
  armed = false;
  cool = 0;
  flash = 0;

  constructor(rect: RectLike, enabled = true) {
    this.rect = rect;
    this.enabled = enabled;
  }

  /** ui.py:445-449. `hoverT` is deliberately *not* reset, so a button disabled
   * under the cursor cross-fades its disabled+hot body in over ~0.23 s. */
  setEnabled(value: boolean): void {
    this.enabled = !!value;
    if (!this.enabled) {
      this.armed = false;
      this.hovered = false;
    }
  }

  /**
   * `handle_event` - ui.py:469-490. Returns true exactly once per completed
   * click: press and release must both land inside, and a release anywhere
   * disarms so arming cannot leak across frames.
   */
  handlePointer(ev: UiPointerEvent): boolean {
    if (ev.type === "move") {
      this.hovered = this.enabled && hits(this.rect, ev.x, ev.y);
      return false;
    }
    if (ev.button !== 0) return false; // right button is boost, never a click

    if (ev.type === "down") {
      if (this.enabled && hits(this.rect, ev.x, ev.y)) {
        this.armed = true;
        // A touch tap has no preceding move, so this is what makes it animate.
        this.hovered = true;
      }
      return false;
    }

    const wasArmed = this.armed;
    this.armed = false;
    if (wasArmed && this.enabled && hits(this.rect, ev.x, ev.y) && this.cool <= 0) {
      this.cool = C.UI_CLICK_COOLDOWN;
      this.flash = 1;
      return true;
    }
    return false;
  }

  /**
   * `update` - ui.py:451-467. `dt` is always **real** frame time: slow motion
   * scales the simulation, never the chrome.
   */
  update(dt: number, pointer: { x: number; y: number; touch?: boolean }): void {
    const d = Math.max(0, Math.min(DT_CLAMP, Number.isFinite(dt) ? dt : 0));
    const was = this.hovered;

    const inside = hits(this.rect, pointer.x, pointer.y);
    this.hovered = inside && this.enabled;
    // Web-only: with no cursor the last touch point lingers, so a tapped button
    // would stay lit forever. Python always has a mouse and needs no such rule.
    if (pointer.touch && !this.armed) this.hovered = false;

    this.justEntered = this.hovered && !was;

    this.hoverT += ((this.hovered ? 1 : 0) - this.hoverT) * (1 - Math.exp(-HOVER_RATE * d));
    const targetPress = this.armed && this.hovered ? 1 : 0;
    this.pressT += (targetPress - this.pressT) * (1 - Math.exp(-PRESS_RATE * d));
    this.flash = Math.max(0, this.flash - d * FLASH_DECAY);
    this.cool = Math.max(0, this.cool - d);
  }
}

export class Button {
  readonly root = new Container();
  /** Input and animation, testable on its own. */
  readonly state: ButtonState;
  /** Mutable: menu and pause move their buttons every frame. */
  readonly rect: RectLike;

  style: ButtonStyle;
  data: unknown;
  icon: string | null;

  private labelText: string;
  private fontOverride: import("pixi.js").TextStyleOptions | null;

  private readonly fonts: FontBook;
  private readonly glowLo: NineSliceSprite;
  private readonly glowHi: NineSliceSprite;
  private readonly cold: Sprite;
  private readonly hot: Sprite;
  private readonly label: Label;
  private readonly iconGlow: Sprite;
  private readonly iconLabel: Label;

  private bodyKey = "";

  constructor(
    fonts: FontBook,
    rect: RectLike | [number, number, number, number],
    label: string,
    opts: ButtonOptions = {},
  ) {
    this.fonts = fonts;
    // Copy: scenes keep their own `home` rect and mutate this one.
    this.rect = Array.isArray(rect)
      ? { x: rect[0], y: rect[1], w: rect[2], h: rect[3] }
      : { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
    this.state = new ButtonState(this.rect, opts.enabled ?? true);
    this.labelText = String(label);
    this.style = BUTTON_STYLES.includes(opts.style as ButtonStyle)
      ? (opts.style as ButtonStyle)
      : "primary";
    this.data = opts.data ?? null;
    this.icon = opts.icon ?? null;
    this.fontOverride = opts.font ?? null;

    const edge = C.UI_CORNER + PANEL_GLOW_SPREAD;
    const glow = (): NineSliceSprite => {
      const s = new NineSliceSprite({
        // The same texture the panels use: the halo is a perfect nine-slice, so
        // one 62x62 build serves every button and panel in the game.
        texture: panelGlowTexture(C.UI_CORNER, PANEL_GLOW_SPREAD),
        leftWidth: edge,
        rightWidth: edge,
        topHeight: edge,
        bottomHeight: edge,
      });
      s.blendMode = "add";
      return s;
    };
    // Two stacked additive plates: the reachable glow power runs to 1.5
    // (hovered and freshly clicked) and additive blending is linear, so the
    // second sprite carries whatever is above 1.
    this.glowLo = glow();
    this.glowHi = glow();

    this.cold = new Sprite();
    this.hot = new Sprite();

    this.label = new Label(fonts, this.labelFont());
    this.iconLabel = new Label(fonts, fonts.h2);
    this.iconGlow = uiGlowSprite(ICON_GLOW_RADIUS, UI_WHITE, 0);

    this.root.addChild(
      this.glowLo,
      this.glowHi,
      this.cold,
      this.hot,
      this.iconGlow,
      this.iconLabel,
      this.label,
    );
    this.label.set(this.labelText);
  }

  // -- configuration -----------------------------------------------------

  /** `_label_font` - ui.py:493-500. Tile 17, ghost 21, primary/danger 30 bold. */
  private labelFont(): import("pixi.js").TextStyleOptions {
    if (this.fontOverride) return this.fontOverride;
    if (this.style === "tile") return this.fonts.small;
    if (this.style === "ghost") return this.fonts.body;
    return this.fonts.h2;
  }

  setLabel(text: string): void {
    const s = String(text);
    if (s === this.labelText) return;
    this.labelText = s;
    this.label.set(s, this.labelFont());
  }

  getLabel(): string {
    return this.labelText;
  }

  setFont(style: import("pixi.js").TextStyleOptions | null): void {
    this.fontOverride = style;
    this.label.set(this.labelText, this.labelFont());
  }

  // -- input (delegated to `state`) --------------------------------------

  get enabled(): boolean {
    return this.state.enabled;
  }
  get hovered(): boolean {
    return this.state.hovered;
  }
  get justEntered(): boolean {
    return this.state.justEntered;
  }
  /** Exposed because level-select and mode-select ride their art on them. */
  get hoverT(): number {
    return this.state.hoverT;
  }
  set hoverT(v: number) {
    this.state.hoverT = v;
  }
  get pressT(): number {
    return this.state.pressT;
  }

  setEnabled(value: boolean): void {
    this.state.setEnabled(value);
  }

  handlePointer(ev: UiPointerEvent): boolean {
    return this.state.handlePointer(ev);
  }

  update(dt: number, pointer: { x: number; y: number; touch?: boolean }): void {
    this.state.update(dt, pointer);
  }

  // -- paint -------------------------------------------------------------

  /** `draw` - ui.py:502-538. The theme is per-call: level select draws each
   * card with that level's own theme. */
  draw(theme: Theme, t: number): void {
    const hov = Math.max(0, Math.min(1, this.hoverT));
    const press = Math.max(0, Math.min(1, this.pressT));

    const scale = 1 + HOVER_SCALE * hov - PRESS_SCALE * press;
    const lift = HOVER_LIFT * hov + PRESS_LIFT * press;
    const { x, y, w, h } = this.rect;

    // The deadband makes the growth snap in rather than easing from zero.
    const scaled = Math.abs(scale - 1) > SCALE_DEADBAND;
    const dw = scaled ? Math.max(4, w * scale) : w;
    const dh = scaled ? Math.max(4, h * scale) : h;
    const cx = x + w * 0.5;
    const cy = y + h * 0.5 + lift;
    const dx = cx - dw * 0.5;
    const dy = cy - dh * 0.5;

    // Bodies.
    const coldFace = buttonFace(this.style, theme, false, this.enabled);
    const hotFace = buttonFace(this.style, theme, true, this.enabled);
    const key = `${w}|${h}|${this.style}|${this.enabled ? 1 : 0}|${toHex(theme.accent)}|${toHex(theme.accent2)}|${toHex(theme.text)}|${toHex(theme.textDim)}`;
    if (key !== this.bodyKey) {
      this.bodyKey = key;
      this.cold.texture = buttonBodyTexture(w, h, this.style, coldFace, theme.accent2, false);
      this.hot.texture = buttonBodyTexture(w, h, this.style, hotFace, theme.accent2, true);
    }
    for (const s of [this.cold, this.hot]) {
      s.position.set(dx, dy);
      s.width = dw;
      s.height = dh;
    }
    // Stacking the translucent hot body over the cold one is what makes a
    // hovered card more solid, not merely brighter.
    this.hot.visible = hov > 0.01;
    this.hot.alpha = hov;

    // Halo: built from the UNSCALED size but anchored to the SCALED top-left,
    // so it drifts a few pixels at peak hover. That is the shipped look.
    const idle = GLOW_IDLE_BASE + GLOW_IDLE_AMP * pulse(t * GLOW_IDLE_SPEED + x * GLOW_PHASE_PER_PX);
    const power = idle + GLOW_HOVER * hov + GLOW_FLASH * this.state.flash;
    // Quantised, which is what stops idle buttons breathing.
    const q = Math.round(power * 10) / 10;
    for (const g of [this.glowLo, this.glowHi]) {
      g.visible = this.enabled;
      g.position.set(dx - PANEL_GLOW_SPREAD, dy - PANEL_GLOW_SPREAD);
      g.width = w + PANEL_GLOW_SPREAD * 2;
      g.height = h + PANEL_GLOW_SPREAD * 2;
      g.tint = toHex(this.style === "danger" ? UI_BAD : theme.accent);
    }
    this.glowLo.alpha = Math.min(1, q);
    this.glowHi.visible = this.enabled && q > 1;
    this.glowHi.alpha = Math.max(0, q - 1);

    // Content.
    let labelY = cy;
    if (this.style === "tile") {
      labelY = dy + dh - TILE_LABEL_INSET;
      this.drawIcon(cx, cy - TILE_ICON_RISE, theme, hov);
    } else if (this.icon !== null) {
      this.drawIcon(dx + ICON_LEFT_INSET, cy, theme, hov);
    } else {
      this.iconGlow.visible = false;
      this.iconLabel.visible = false;
    }

    // One tinted Text rather than two cross-faded copies: inside the glyphs the
    // two-layer composite is exactly this lerp, and it halves the rasterising.
    this.label.setColor(lerpColor(coldFace.text, hotFace.text, hov));
    this.label.setScale(scaled ? scale : 1);
    this.label.place(cx, labelY - this.label.textHeight * (scaled ? scale : 1) * 0.5, "center");
  }

  /** `_draw_icon` - ui.py:573-587. Glyph only; no shipped scene passes one. */
  private drawIcon(cx: number, cy: number, theme: Theme, hov: number): void {
    if (this.icon === null) {
      this.iconGlow.visible = false;
      this.iconLabel.visible = false;
      return;
    }
    const col = this.enabled ? theme.accent : shade(theme.accent, 0.4);
    this.iconGlow.position.set(cx, cy);
    if (this.enabled) {
      setUiGlow(this.iconGlow, ICON_GLOW_RADIUS, col, 0.25 + 0.45 * hov);
    } else {
      this.iconGlow.visible = false;
    }

    const style = this.style === "tile" ? this.fonts.h1 : this.fonts.h2;
    this.iconLabel.visible = true;
    this.iconLabel.set(this.icon, style);
    this.iconLabel.setColor(lerpColor(col, UI_WHITE, 0.35 + 0.4 * hov));
    this.iconLabel.place(cx, cy - this.iconLabel.textHeight * 0.5, "center");
  }

  /** Destroys this button's own text objects, never the shared textures. */
  destroy(): void {
    this.root.destroy({ children: true });
  }
}

// ---------------------------------------------------------------------------
// Housekeeping
// ---------------------------------------------------------------------------

/** Drop every cached button body. Tests and hot-reload only. */
export function clearButtonTextureCache(): void {
  for (const t of bodyCache.values()) t.destroy(true);
  bodyCache.clear();
}

/** Cache occupancy, for the debug overlay and tests. */
export function buttonTextureCacheSize(): number {
  return bodyCache.size;
}
