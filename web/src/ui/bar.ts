/**
 * Progress bars - a port of `snake/gfx/ui.py:294-352`
 * (`_bar_track`, `_bar_fill`, `draw_bar`).
 *
 * Four call sites, three sizes, two heights. A rounded track, a vertical
 * gradient fill, a one-pixel stroke, and a breathing bloom at the leading edge.
 * There is no geometric tip highlight, no inset and no rounded leading cap.
 *
 * Four shipped quirks are reproduced deliberately:
 *
 * - **The partial fill has a square right edge.** Python masks the *full-width*
 *   gradient to a rounded rect and only then crops it, so at any fraction below
 *   1 the leading edge is a hard vertical cut and only a full bar shows its
 *   rounded right cap. The breathing tip glow exists to soften exactly that.
 * - **`fillW` truncates**, so a 250 px bar advances in whole pixels and a
 *   fraction of 0.999 still shows that square edge.
 * - **The tip glow pops in.** An empty bar returns before the glow is drawn, so
 *   the bloom appears abruptly at full intensity the moment the fill reaches
 *   one pixel, rather than fading up.
 * - **The tip breathes on the wall clock**, not the scene clock, so it keeps
 *   breathing through slow motion and any scene freeze while the fill beside it
 *   does not. Feeding it the scene time would look right and be wrong.
 *
 * The construction that makes this cheap: `_bar_fill`'s gradient is
 * horizontally uniform - every row is one flat colour across the full width -
 * so "crop to fillW" and "scale x to fillW" produce the same image. The fill is
 * therefore a 2 x h texture stretched to the fill width, sharing the
 * full-width rounded mask with the track: the mask rounds the left cap, the
 * sprite's own right edge gives the hard cut, and at full width the mask rounds
 * the right cap too. Ninety-six bytes instead of nine kilobytes.
 */

import { Container, Graphics, Sprite, type Texture } from "pixi.js";

import {
  UI_PANEL,
  UI_WHITE,
  lerpColor,
  shade,
  toHex,
  type RGB,
} from "../core/palette";
import { canvasTexture, context2d, createCanvas, cssRgb, whiteTexture } from "../gfx/textures";
import { setUiGlow, uiGlowTexture } from "./glow";

/** Track fill alpha, 0-255. ui.py:304 */
export const BAR_TRACK_ALPHA = 190;
/** Track stroke alpha, 0-255. Tinted with the *fill* colour, not a chrome one. ui.py:306 */
export const BAR_EDGE_ALPHA = 90;
/** How far the bright band is blended toward UI_WHITE. ui.py:318 */
export const BAR_HOT_MIX = 0.45;
/** Darkening factor at the gradient's dark end. ui.py:322 */
export const BAR_DARK_SHADE = 0.62;
/** Where the bright band sits, as a fraction of height - above centre. ui.py:322 */
export const BAR_GRAD_PIVOT = 0.35;
/** How fast the gradient falls away from the pivot. ui.py:322 */
export const BAR_GRAD_SLOPE = 1.6;
/** Tip bloom radius as a multiple of the bar height. ui.py:350 */
export const BAR_TIP_RADIUS_K = 1.5;
/** Tip bloom intensity floor and swing: 0.55 .. 0.80. ui.py:349 */
export const BAR_TIP_BASE = 0.55;
export const BAR_TIP_SWING = 0.25;
/** Milliseconds to pulse argument, and the pulse speed. ui.py:349 */
export const BAR_TIP_TIME_K = 0.004;
export const BAR_TIP_SPEED = 2.2;

// ---------------------------------------------------------------------------
// The fill gradient
// ---------------------------------------------------------------------------

const fillCache = new Map<string, Texture>();
const FILL_CACHE_LIMIT = 128;

/** `_q8` - the 32-level-per-channel snap Python quantises bar colours to. */
function q8(c: RGB): RGB {
  const s = (v: number) => Math.min(255, Math.floor((Math.max(0, v) + 4) / 8) * 8);
  return [s(c[0]), s(c[1]), s(c[2])];
}

/**
 * The `2 x h` vertical gradient, colour-quantised as Python quantises it.
 *
 * Two pixels wide rather than one so linear sampling has something to
 * interpolate between horizontally; every row is a flat colour, so the result
 * is identical at any width.
 */
export function barFillTexture(h: number, color: RGB): Texture {
  const height = Math.max(1, Math.round(h));
  const col = q8(color);
  const key = `${height}|${col[0]},${col[1]},${col[2]}`;
  const hit = fillCache.get(key);
  if (hit) return hit;

  const canvas = createCanvas(2, height);
  const ctx = context2d(canvas);
  ctx.clearRect(0, 0, 2, height);

  const hot = lerpColor(col, UI_WHITE, BAR_HOT_MIX);
  const dark = shade(col, BAR_DARK_SHADE);
  const last = Math.max(1, height - 1);
  for (let y = 0; y < height; y++) {
    const f = y / last;
    // Weight is implicitly clamped to 1 by lerpColor, as in the Python.
    const w = Math.abs(f - BAR_GRAD_PIVOT) * BAR_GRAD_SLOPE;
    ctx.fillStyle = cssRgb(lerpColor(hot, dark, w));
    ctx.fillRect(0, y, 2, 1);
  }

  // Non-destructive, for the reason spelled out in `ui/text.ts`: `set`
  // re-fetches only when its quantised colour key changes, so destroying an
  // evicted fill would break a parked Bar whose colour never moves (the
  // menu's gold star bar) once the HUD's two animated bars had cycled the
  // cache - three or four differently-themed levels is enough.
  if (fillCache.size >= FILL_CACHE_LIMIT) {
    const oldest = fillCache.keys().next();
    if (!oldest.done) fillCache.delete(oldest.value);
  }
  const tex = canvasTexture(canvas);
  fillCache.set(key, tex);
  return tex;
}

// ---------------------------------------------------------------------------
// The widget
// ---------------------------------------------------------------------------

/** A retained-mode bar: build once, then set fraction and colour per frame. */
export class Bar extends Container {
  private readonly track: Sprite;
  private readonly fill: Sprite;
  private readonly edge: Graphics;
  private readonly tip: Sprite;
  private readonly shape = new Graphics();

  private w = 0;
  private h = 0;
  private radius = 0;
  private edgeKey = "";
  private border = true;

  constructor() {
    super();

    this.track = new Sprite(whiteTexture());
    this.track.tint = toHex(UI_PANEL);
    this.track.alpha = BAR_TRACK_ALPHA / 255;

    this.fill = new Sprite();

    this.edge = new Graphics();
    this.edge.alpha = BAR_EDGE_ALPHA / 255;

    this.tip = new Sprite(uiGlowTexture(2));
    this.tip.anchor.set(0.5);
    this.tip.blendMode = "add";

    // The track and the fill share the rounded mask; the stroke and the bloom
    // sit outside it, as they do in the Python's blit order.
    const masked = new Container();
    masked.addChild(this.track, this.fill);
    masked.mask = this.shape;

    this.addChild(this.shape, masked, this.edge, this.tip);
  }

  /** Position and size, in design pixels. Rebuilds the mask and the stroke. */
  setRect(x: number, y: number, w: number, h: number): void {
    this.position.set(x, y);
    if (w === this.w && h === this.h) return;
    this.w = w;
    this.h = h;
    // pygame's `h // 2`: h=12 is a true stadium, h=9 half a pixel short.
    this.radius = Math.floor(h / 2);

    this.shape.clear().roundRect(0, 0, w, h, this.radius).fill({ color: 0xffffff });

    this.track.width = w;
    this.track.height = h;
    this.fill.height = h;
    this.edgeKey = "";
  }

  /** Whether the 1-px stroke is drawn. No shipped call site turns it off. */
  setBorder(on: boolean): void {
    this.border = on;
    this.edge.visible = on;
  }

  /**
   * `frac` is clamped here, not by the caller - the HUD's goal bar passes an
   * unclamped `eaten / goal` that can exceed 1.
   *
   * `nowMs` drives the tip's breathing and must be a wall clock
   * (`performance.now()`), never the scene clock.
   */
  set(frac: number, color: RGB, nowMs: number): void {
    if (this.w < 3 || this.h < 2) return;
    const f = Math.max(0, Math.min(1, Number.isFinite(frac) ? frac : 0));
    const col = q8(color);
    const key = `${col[0]},${col[1]},${col[2]}`;

    if (key !== this.edgeKey) {
      this.edgeKey = key;
      this.fill.texture = barFillTexture(this.h, col);
      if (this.border) {
        this.edge
          .clear()
          .roundRect(0.5, 0.5, this.w - 1, this.h - 1, Math.max(0, this.radius - 0.5))
          .stroke({ color: toHex(col), width: 1 });
      }
    }

    // Truncated, as in the Python: the bar advances in whole pixels.
    const fillW = Math.trunc(this.w * f);
    if (fillW <= 0) {
      // No fill and, deliberately, no tip glow.
      this.fill.visible = false;
      this.tip.visible = false;
      return;
    }
    this.fill.visible = true;
    this.fill.width = fillW;

    const breathe =
      BAR_TIP_BASE +
      BAR_TIP_SWING * (0.5 + 0.5 * Math.sin(nowMs * BAR_TIP_TIME_K * BAR_TIP_SPEED));
    this.tip.position.set(fillW, Math.floor(this.h / 2));
    setUiGlow(this.tip, this.h * BAR_TIP_RADIUS_K, col, breathe);
  }
}

// ---------------------------------------------------------------------------
// Housekeeping
// ---------------------------------------------------------------------------

/** Drop every cached fill gradient. Tests and hot-reload only. */
export function clearBarTextureCache(): void {
  for (const t of fillCache.values()) t.destroy(true);
  fillCache.clear();
}

/** Cache occupancy, for the debug overlay and tests. */
export function barTextureCacheSize(): number {
  return fillCache.size;
}
