/**
 * The panel - a port of `snake/gfx/ui.py:201-246` (`_panel_surface`, `draw_panel`).
 *
 * The most-used widget in the game: fifteen call sites across eight scenes, and
 * every non-gameplay scene draws at least one. Four layers, no more - a
 * vertical gradient body, a rounded mask, a neon rim, and a one-pixel highlight
 * just inside the rim's top edge.
 *
 * Three things drive the shape of this port, all from `docs/port/ui.md` S2:
 *
 * 1. **The rim does not fade with the body.** Python applies the `alpha`
 *    argument to the gradient fill only; the rim stays at 120/255 and the
 *    highlight at 90/255 whatever happens. So a panel fading out ends as a
 *    full-strength neon outline around almost nothing - visible on the READY
 *    card, the pause intro and the settings intro. The obvious Pixi port (one
 *    sprite, `sprite.alpha = alpha/255`) would fade the rim too, which is why
 *    the layers are separate sprites and `container.alpha` is left at 1.
 *
 * 2. **`pygame.draw.*` writes RGBA, it does not blend.** The rim and highlight
 *    *replace* the body pixels under them rather than compositing over them, so
 *    they read as `accent` over the scene behind the panel, not over the panel
 *    fill. Reproduced by punching the rim band out of the body texture, leaving
 *    the rim sprite as the only thing in that band.
 *
 * 3. **The halo is a lit slab, not a rim glow.** `_rrect_glow` has no `i = 0`
 *    band, so its innermost band is a filled rounded rect at 0.76 intensity
 *    covering the whole footprint. Since the body is translucent, that plateau
 *    lifts the card's interior. Turning it into a ring would flatten every
 *    panel in the game.
 *
 * All sixteen panel sizes in the game are static constants, so the geometry is
 * baked once and nine-sliced: sixteen body strips plus two shared textures,
 * against 9.85 MiB if each size were baked whole.
 */

import { Container, NineSliceSprite, Sprite, type Texture } from "pixi.js";

import * as C from "../core/config";
import {
  UI_PANEL,
  UI_PANEL_LIGHT,
  UI_WHITE,
  lerpColor,
  toHex,
  type RGB,
} from "../core/palette";
import {
  canvasTexture,
  clearToBlack,
  context2d,
  createCanvas,
  cssRgb,
  whiteTexture,
} from "../gfx/textures";

// ---------------------------------------------------------------------------
// Constants, each a literal inside ui.py that config.py never exported
// ---------------------------------------------------------------------------

/** `draw_panel`'s default body alpha, 0-255. ui.py:233 */
export const PANEL_ALPHA_DEFAULT = 210;
/** Neon rim alpha, 0-255. Does **not** scale with the body alpha. ui.py:225 */
export const PANEL_RIM_ALPHA = 120;
/** Neon rim stroke width, strokes inward. ui.py:225 */
export const PANEL_RIM_WIDTH = 2;
/** Inner top highlight alpha, 0-255. Also independent of the body alpha. ui.py:227 */
export const PANEL_HILITE_ALPHA = 90;
/** How far the highlight is blended from `accent` toward white. ui.py:227 */
export const PANEL_HILITE_MIX = 0.55;
/** Gradient exponent: front-loads the darkening into the top ~10%. ui.py:215 */
export const PANEL_GRADIENT_GAMMA = 0.75;
/** Halo spread in px, hard-coded at both the build and the blit. ui.py:241 */
export const PANEL_GLOW_SPREAD = 18;
/** Upper clamp on the glow intensity argument. ui.py:241 */
export const PANEL_GLOW_MAX = 2.0;
/** Falloff exponent across the halo's bands. ui.py:194 */
export const PANEL_GLOW_BANDS_GAMMA = 2.2;
/** Overall halo brightness scale. ui.py:194 */
export const PANEL_GLOW_SCALE = 0.85;

// ---------------------------------------------------------------------------
// Textures
// ---------------------------------------------------------------------------

const bodyCache = new Map<string, Texture>();
const rimCache = new Map<string, Texture>();
const glowCache = new Map<string, Texture>();

/**
 * The gradient body, `(2*corner + 2)` wide by `h` tall.
 *
 * Nine-sliced horizontally only: the gradient varies per row, but the texture
 * height *is* the panel height, so the vertical scale is 1 and every row draws
 * 1:1. Columns beyond the corner radius are fully opaque at every y, so the
 * middle column stretches cleanly to any width.
 */
export function panelBodyTexture(
  h: number,
  corner: number = C.UI_CORNER,
  border = true,
): Texture {
  const height = Math.max(2, Math.round(h));
  const r = Math.max(0, Math.round(corner));
  const w = r * 2 + 2;
  const key = `${height}|${r}|${border ? 1 : 0}`;
  const hit = bodyCache.get(key);
  if (hit) return hit;

  const canvas = createCanvas(w, height);
  const ctx = context2d(canvas);
  ctx.clearRect(0, 0, w, height);

  // Layer 1: the vertical gradient, one row at a time. The exponent cannot be
  // expressed as a CSS gradient - the browser interpolates linearly in sRGB and
  // would ignore it - so the rows are drawn individually, as in the Python.
  const last = Math.max(1, height - 1);
  ctx.globalCompositeOperation = "source-over";
  for (let y = 0; y < height; y++) {
    const f = Math.pow(y / last, PANEL_GRADIENT_GAMMA);
    ctx.fillStyle = cssRgb(lerpColor(UI_PANEL_LIGHT, UI_PANEL, f));
    ctx.fillRect(0, y, w, 1);
  }

  // Layer 2: the rounded corner mask. Python multiplies by an RGBA mask that is
  // only ever fully opaque or fully transparent, which is exactly this.
  ctx.globalCompositeOperation = "destination-in";
  ctx.fillStyle = "#fff";
  ctx.beginPath();
  ctx.roundRect(0, 0, w, height, r);
  ctx.fill();

  // Punch out the band the rim will occupy, so the rim sprite replaces those
  // pixels rather than compositing over them - pygame's draw calls overwrite
  // alpha, and the difference is a rim that reads noticeably heavier.
  if (border) {
    ctx.globalCompositeOperation = "destination-out";
    ctx.lineWidth = PANEL_RIM_WIDTH;
    ctx.strokeStyle = "#fff";
    ctx.beginPath();
    // Inset by half the stroke width so the band sits inside the rect, which is
    // where pygame's inward stroke puts it.
    ctx.roundRect(
      PANEL_RIM_WIDTH / 2,
      PANEL_RIM_WIDTH / 2,
      w - PANEL_RIM_WIDTH,
      height - PANEL_RIM_WIDTH,
      Math.max(0, r - PANEL_RIM_WIDTH / 2),
    );
    ctx.stroke();
  }
  ctx.globalCompositeOperation = "source-over";

  const tex = canvasTexture(canvas);
  bodyCache.set(key, tex);
  return tex;
}

/**
 * The neon rim: a white rounded-rect stroke, tinted per panel.
 *
 * The middle-top slice has row 1 cleared, which is where the highlight sprite
 * shows through. The hairline starts at exactly `x = corner`, which is the
 * slice boundary, so the hole lands in one slice and stretches with it.
 */
export function panelRimTexture(
  corner: number = C.UI_CORNER,
  width: number = PANEL_RIM_WIDTH,
): Texture {
  const r = Math.max(0, Math.round(corner));
  const lw = Math.max(1, Math.round(width));
  const size = r * 2 + 2;
  const key = `${r}|${lw}`;
  const hit = rimCache.get(key);
  if (hit) return hit;

  const canvas = createCanvas(size, size);
  const ctx = context2d(canvas);
  ctx.clearRect(0, 0, size, size);
  ctx.globalCompositeOperation = "source-over";
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = lw;
  ctx.beginPath();
  ctx.roundRect(lw / 2, lw / 2, size - lw, size - lw, Math.max(0, r - lw / 2));
  ctx.stroke();

  // The highlight overwrites the rim's second row along the top edge, between
  // the corners. Clearing it here lets the highlight sprite own those pixels.
  ctx.globalCompositeOperation = "destination-out";
  ctx.fillStyle = "#fff";
  ctx.fillRect(r, 1, size - r * 2, 1);
  ctx.globalCompositeOperation = "source-over";

  const tex = canvasTexture(canvas);
  rimCache.set(key, tex);
  return tex;
}

/**
 * The additive halo: eighteen filled rounded rects, dimmest and largest first,
 * each *overwriting* the last.
 *
 * Overwriting is the whole trick. Adding the bands instead sums the series and
 * comes out several times too bright - the same rule `textures.ts::paintRadial`
 * documents. Intensity is baked at 1 and applied as the sprite's alpha, which
 * is linear in Python too, so the port's continuous fade is simply smoother
 * than the original's 0.1-snapped cache key.
 */
export function panelGlowTexture(
  corner: number = C.UI_CORNER,
  spread: number = PANEL_GLOW_SPREAD,
): Texture {
  const r = Math.max(0, Math.round(corner));
  const s = Math.max(1, Math.round(spread));
  const base = r * 2 + 2;
  const size = base + s * 2;
  const key = `${r}|${s}`;
  const hit = glowCache.get(key);
  if (hit) return hit;

  const canvas = createCanvas(size, size);
  const ctx = context2d(canvas);
  clearToBlack(ctx, size, size);
  ctx.globalCompositeOperation = "source-over";

  for (let i = s; i >= 1; i--) {
    const b = Math.pow(1 - i / s, PANEL_GLOW_BANDS_GAMMA) * PANEL_GLOW_SCALE;
    const v = Math.max(0, Math.min(255, Math.trunc(255 * b)));
    ctx.fillStyle = `rgb(${v},${v},${v})`;
    ctx.beginPath();
    ctx.roundRect(s - i, s - i, base + i * 2, base + i * 2, r + i);
    ctx.fill();
  }

  const tex = canvasTexture(canvas);
  glowCache.set(key, tex);
  return tex;
}

// ---------------------------------------------------------------------------
// The widget
// ---------------------------------------------------------------------------

/**
 * A retained-mode panel: build it once in a scene's `enter`, then touch only
 * position, tint and alpha per frame.
 *
 * Keep `this.alpha` at 1. Fading the container would drag the additive halo and
 * the neon rim down with the body, which is precisely the behaviour the Python
 * does not have.
 */
export class Panel extends Container {
  private readonly halo: NineSliceSprite;
  private readonly body: NineSliceSprite;
  private readonly rim: NineSliceSprite;
  private readonly hilite: Sprite;

  private readonly corner: number;
  private w = 0;
  private h = 0;
  private hasBorder = true;

  constructor(corner: number = C.UI_CORNER) {
    super();
    this.corner = Math.max(0, Math.round(corner));
    const edge = this.corner + PANEL_GLOW_SPREAD;

    this.halo = new NineSliceSprite({
      texture: panelGlowTexture(this.corner),
      leftWidth: edge,
      rightWidth: edge,
      topHeight: edge,
      bottomHeight: edge,
    });
    this.halo.blendMode = "add";

    this.body = new NineSliceSprite({
      texture: panelBodyTexture(2, this.corner, true),
      leftWidth: this.corner,
      rightWidth: this.corner,
      // The texture height always equals the panel height, so these rows draw
      // 1:1 whatever they are; 1 avoids asking what a zero-height slice means.
      topHeight: 1,
      bottomHeight: 1,
    });

    this.rim = new NineSliceSprite({
      texture: panelRimTexture(this.corner),
      leftWidth: this.corner,
      rightWidth: this.corner,
      topHeight: this.corner,
      bottomHeight: this.corner,
    });
    this.rim.alpha = PANEL_RIM_ALPHA / 255;

    this.hilite = new Sprite(whiteTexture());
    this.hilite.alpha = PANEL_HILITE_ALPHA / 255;
    this.hilite.height = 1;

    this.addChild(this.halo, this.body, this.rim, this.hilite);
  }

  /** Position and size, in design pixels. Floats are kept; Python truncates. */
  setRect(x: number, y: number, w: number, h: number): void {
    this.position.set(x, y);
    if (w === this.w && h === this.h) return;
    this.w = w;
    this.h = h;

    // The additive footprint is the rect inflated by the spread on all sides.
    this.halo.position.set(-PANEL_GLOW_SPREAD, -PANEL_GLOW_SPREAD);
    this.halo.width = w + PANEL_GLOW_SPREAD * 2;
    this.halo.height = h + PANEL_GLOW_SPREAD * 2;

    this.body.texture = panelBodyTexture(h, this.corner, this.hasBorder);
    this.body.width = w;
    this.body.height = h;

    this.rim.width = w;
    this.rim.height = h;

    this.hilite.position.set(this.corner, 1);
    this.hilite.width = Math.max(0, w - this.corner * 2 + 1);
  }

  /**
   * `alpha255` is Python's 0-255 body alpha; `glow` is its 0-2 halo intensity.
   * Neither touches the rim or the highlight - see the note on the class.
   */
  setStyle(accent: RGB, alpha255 = PANEL_ALPHA_DEFAULT, border = true, glow = 0): void {
    const a = Math.max(0, Math.min(255, alpha255));
    this.body.alpha = a / 255;

    if (border !== this.hasBorder) {
      this.hasBorder = border;
      if (this.h >= 2) this.body.texture = panelBodyTexture(this.h, this.corner, border);
    }
    this.rim.visible = border;
    this.hilite.visible = border;

    const tint = toHex(accent);
    this.rim.tint = tint;
    this.halo.tint = tint;
    this.hilite.tint = toHex(lerpColor(accent, UI_WHITE, PANEL_HILITE_MIX));

    const g = Math.max(0, Math.min(PANEL_GLOW_MAX, glow));
    this.halo.visible = g > 0.01;
    this.halo.alpha = g;
  }
}

// ---------------------------------------------------------------------------
// Housekeeping
// ---------------------------------------------------------------------------

/** Drop every cached panel texture. Tests and hot-reload only. */
export function clearPanelTextureCache(): void {
  for (const t of bodyCache.values()) t.destroy(true);
  for (const t of rimCache.values()) t.destroy(true);
  for (const t of glowCache.values()) t.destroy(true);
  bodyCache.clear();
  rimCache.clear();
  glowCache.clear();
}

/** Cache occupancy, for the debug overlay and tests. */
export function panelTextureCacheSizes(): { body: number; rim: number; glow: number } {
  return { body: bodyCache.size, rim: rimCache.size, glow: glowCache.size };
}
