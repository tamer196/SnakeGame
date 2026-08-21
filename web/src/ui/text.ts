/**
 * Text with a drop shadow - a port of `snake/gfx/ui.py:249-291`
 * (`_text_pair`, `draw_text`). 132 call sites across the game.
 *
 * The Python renders a string once, copies it, multiplies the copy to black to
 * get a silhouette carrying the same glyph coverage, and blits that at
 * `(+2, +2)` under the real one. There is **no outline** and no second offset;
 * the drop shadow is the only decoration text ever gets.
 *
 * Two facts the 132 call sites are calibrated against, both preserved here:
 *
 * - **`y` is always the TOP edge**, never a baseline and never a centre. Every
 *   vertically-centred label in the game subtracts half the font height by
 *   hand, which is why `FontBook.faceMetrics` exists.
 * - **The rendered height is the font's height, whatever the string.** "SCORE"
 *   and "goal" produce identically tall rasters with a common baseline, so a
 *   row of labels lines up without anyone measuring the text.
 *
 * The port shares one texture between the shadow and the body, exactly as
 * `_text_pair` shares one surface. Python then mutates `set_alpha` on those
 * *cached* surfaces and restores a resting value afterwards, which leaves
 * global state one exception away from being permanently wrong; here each
 * sprite owns its own alpha and the problem does not exist.
 */

import { Container, Sprite, type TextStyleOptions, type Texture } from "pixi.js";

import { toHex, type RGB } from "../core/palette";
import type { FontBook } from "../gfx/fonts";
import { cssFont } from "../gfx/fonts";
import { canvasTexture, context2d, createCanvas } from "../gfx/textures";

/** Drop-shadow offset, in design px, on both axes. ui.py:287 */
export const TEXT_SHADOW_OFFSET = 2;
/** Drop-shadow alpha, 0-255, multiplied by the glyph coverage. ui.py:264 */
export const TEXT_SHADOW_ALPHA = 150;
/** Python's `_TEXT_CACHE` limit. ui.py:265 */
export const GLYPH_CACHE_LIMIT = 900;

export type TextAlign = "left" | "center" | "right";

// ---------------------------------------------------------------------------
// The glyph raster
// ---------------------------------------------------------------------------

interface GlyphEntry {
  texture: Texture;
  width: number;
  height: number;
}

const glyphCache = new Map<string, GlyphEntry>();

/**
 * A **white** glyph run on transparent, the face's full height tall.
 *
 * White because colour leaves the texture: the body sprite tints it and the
 * shadow sprite tints the same texture black. Python instead keys its cache on
 * the colour and rebuilds the raster per colour, which is exactly the cost this
 * avoids - most labels in this game animate their colour every frame.
 *
 * No horizontal padding, matching pygame, so an overhanging glyph clips the
 * same way in both.
 */
function glyphEntry(text: string, opts: TextStyleOptions, fonts: FontBook): GlyphEntry {
  const css = cssFont(opts);
  const key = `${css}|${text}`;
  const hit = glyphCache.get(key);
  if (hit) return hit;

  const face = fonts.faceMetrics(opts);
  const w = Math.max(1, Math.ceil(fonts.measureWidth(opts, text)));
  const h = Math.max(1, Math.ceil(face.height));

  const canvas = createCanvas(w, h);
  const ctx = context2d(canvas);
  ctx.clearRect(0, 0, w, h);
  ctx.font = css;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#fff";
  ctx.fillText(text, 0, face.ascent);

  const entry: GlyphEntry = { texture: canvasTexture(canvas), width: w, height: h };

  // Python wipes the whole cache when it fills; dropping the oldest entry is
  // the same bound without the stall.
  //
  // Eviction must NOT destroy the texture. Nothing here knows who is still
  // drawing it, and no holder re-fetches: `set` below early-returns while the
  // string is unchanged, so the oldest entries are precisely the static
  // labels of cached, reused scenes ("SETTINGS", "NEW BEST", the HUD
  // captions). Destroying those left them drawing a dead texture for the rest
  // of the session once ~900 distinct strings had been minted, which one
  // result screen's count-up gets a sixth of the way toward on its own.
  // Dropping the reference is enough: Pixi's TextureGCSystem is on by default
  // and reclaims the GPU resource of a texture nothing has drawn for 60 s.
  if (glyphCache.size >= GLYPH_CACHE_LIMIT) {
    const oldest = glyphCache.keys().next();
    if (!oldest.done) glyphCache.delete(oldest.value);
  }
  glyphCache.set(key, entry);
  return entry;
}

/** The cached raster for a string, for callers building their own sprites. */
export function glyphTexture(text: string, opts: TextStyleOptions, fonts: FontBook): Texture {
  return glyphEntry(text, opts, fonts).texture;
}

// ---------------------------------------------------------------------------
// The widget
// ---------------------------------------------------------------------------

/**
 * `_text_pair` plus `draw_text` as one retained display object.
 *
 * Text positions in this game are static and only colours animate, so a `Label`
 * built once costs two property writes per frame. Re-rasterising glyphs every
 * frame is the one Python cost worth not copying.
 */
export class Label extends Container {
  private readonly shadowSprite: Sprite;
  private readonly bodySprite: Sprite;
  private readonly fonts: FontBook;

  private text = "";
  private style: TextStyleOptions;
  private align: TextAlign = "left";
  private anchorX = 0;
  private anchorY = 0;
  private scale01 = 1;

  /** Rendered width in design px, before any scale. */
  textWidth = 0;
  /** The face's height - the same for every string in this style. */
  textHeight = 0;

  constructor(fonts: FontBook, style: TextStyleOptions) {
    super();
    this.fonts = fonts;
    this.style = style;

    this.shadowSprite = new Sprite();
    this.shadowSprite.tint = 0x000000;
    this.shadowSprite.alpha = TEXT_SHADOW_ALPHA / 255;
    this.shadowSprite.position.set(TEXT_SHADOW_OFFSET, TEXT_SHADOW_OFFSET);

    this.bodySprite = new Sprite();

    this.addChild(this.shadowSprite, this.bodySprite);
  }

  /** Re-point both sprites at a new string, rebuilding the raster if needed. */
  set(text: string, style: TextStyleOptions = this.style): void {
    if (text === this.text && style === this.style) return;
    this.text = text;
    this.style = style;

    if (text === "") {
      this.shadowSprite.visible = false;
      this.bodySprite.visible = false;
      this.textWidth = 0;
      this.textHeight = 0;
      return;
    }

    const entry = glyphEntry(text, style, this.fonts);
    this.shadowSprite.texture = entry.texture;
    this.bodySprite.texture = entry.texture;
    this.shadowSprite.visible = true;
    this.bodySprite.visible = true;
    this.textWidth = entry.width;
    this.textHeight = entry.height;
    this.applyPlacement();
  }

  /** `y` is the TOP edge, as it is everywhere in the Python. */
  place(x: number, y: number, align: TextAlign = this.align): void {
    this.anchorX = x;
    this.anchorY = y;
    this.align = align;
    this.applyPlacement();
  }

  private applyPlacement(): void {
    const w = this.textWidth * this.scale01;
    const dx = this.align === "center" ? -w * 0.5 : this.align === "right" ? -w : 0;
    this.position.set(this.anchorX + dx, this.anchorY);
  }

  /**
   * Body colour. The shadow stays black; only its alpha is ever varied.
   *
   * Not called `tint`: `Container` already defines that as an accessor, and
   * shadowing it with a method breaks every `addChild` this object is passed to.
   */
  setColor(color: RGB): void {
    this.bodySprite.tint = toHex(color);
  }

  /** Body opacity. The shadow keeps its own 150/255, as in the Python. */
  setAlpha(a: number): void {
    this.bodySprite.alpha = Math.max(0, Math.min(1, a));
  }

  setShadow(on: boolean): void {
    this.shadowSprite.visible = on && this.text !== "";
  }

  /**
   * Uniform scale, which several call sites animate (`rotozoom` in the Python
   * is a plain scale of already-rendered text, not a re-render). Re-derives the
   * alignment offset, because a centred label must stay centred as it grows.
   */
  setScale(s: number): void {
    this.scale01 = s;
    this.scale.set(s);
    this.applyPlacement();
  }
}

/**
 * The one-shot form, mirroring `draw_text`'s shape and defaults, for the few
 * call sites that do not want to retain an object.
 */
export function drawText(
  parent: Container,
  text: string,
  style: TextStyleOptions,
  fonts: FontBook,
  color: RGB,
  x: number,
  y: number,
  opts: { align?: TextAlign; shadow?: boolean } = {},
): Label {
  const label = new Label(fonts, style);
  label.set(text, style);
  label.setColor(color);
  label.setShadow(opts.shadow ?? true);
  label.place(x, y, opts.align ?? "left");
  parent.addChild(label);
  return label;
}

// ---------------------------------------------------------------------------
// Housekeeping
// ---------------------------------------------------------------------------

/** Drop every cached glyph raster. Tests and hot-reload only. */
export function clearGlyphCache(): void {
  for (const e of glyphCache.values()) e.texture.destroy(true);
  glyphCache.clear();
}

/** Cache occupancy, for the debug overlay and tests. */
export function glyphCacheSize(): number {
  return glyphCache.size;
}
