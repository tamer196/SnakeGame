/**
 * The UI kit's own radial bloom - a port of `snake/gfx/ui.py:144-177`
 * (`_glow_add`, `_blit_glow`).
 *
 * This is **not** the same primitive as `gfx/textures.ts::radialTexture`, and
 * the two must not be merged. `render.py`'s radial spaces its bands by
 * `sqrt(1 - i/n)` and ramps brightness linearly; this one spaces them linearly
 * and ramps brightness by `(1 - f) ** 2.4`, which the Python's own comment
 * describes as mimicking an optical bloom. Substituting one for the other
 * changes the shape of every glow in the HUD and behind every panel.
 *
 * Band count is tied to the radius (`clamp(radius, 5, 26)`), so the texture is
 * baked per radius rather than scaled from one master. That is affordable here
 * because the whole game asks for about eight distinct radii.
 *
 * As everywhere else in this port, the baked texture is white and the colour
 * arrives as the sprite's tint. Brightness is linear in `intensity`, so
 * intensity becomes the sprite's alpha - which also makes it continuous, where
 * Python's cache key snapped it to 0.1.
 */

import { Sprite, type Graphics, type Texture } from "pixi.js";

import { toHex, type RGB } from "../core/palette";
import { canvasTexture, clearToBlack, context2d, createCanvas } from "../gfx/textures";

/** Falloff exponent. ui.py:165 */
export const UI_GLOW_GAMMA = 2.4;
/** Radius clamp, applied before anything else. ui.py:152 */
export const UI_GLOW_MIN_RADIUS = 2;
export const UI_GLOW_MAX_RADIUS = 260;
/** Band-count clamp; the count is the radius, bounded. ui.py:161 */
export const UI_GLOW_MIN_STEPS = 5;
export const UI_GLOW_MAX_STEPS = 26;
/** Below this, `_blit_glow` draws nothing at all. ui.py:173 */
export const UI_GLOW_EPSILON = 0.01;

/**
 * Start an arc as its own sub-path.
 *
 * `Graphics.arc` *continues* the current path, so without an explicit `moveTo`
 * it draws a leader line from wherever the pen happens to be - usually the
 * origin - to the arc's first point. That shows up as a stray diagonal across
 * the whole screen, which is exactly what it did the first time the help
 * screen's magnet glyph was drawn.
 *
 * Angles are screen-space (y down, clockwise). Callers porting a
 * `pygame.draw.arc` must negate theirs first: pygame measures in a y-up frame.
 */
export function arcPath(
  g: Graphics,
  cx: number,
  cy: number,
  r: number,
  a0: number,
  a1: number,
): Graphics {
  g.moveTo(cx + Math.cos(a0) * r, cy + Math.sin(a0) * r);
  return g.arc(cx, cy, r, a0, a1);
}

const cache = new Map<number, Texture>();

/**
 * A cached **white** bloom, `2r` square, centre at the middle.
 *
 * The bands are drawn outside-in and *overwrite* each other, so the finished
 * surface is the falloff itself rather than the sum of the series - the same
 * discipline `textures.ts::paintRadial` documents, and the same bug if it is
 * got wrong (a glow several times too bright).
 */
export function uiGlowTexture(radius: number): Texture {
  const r = Math.round(
    Math.max(UI_GLOW_MIN_RADIUS, Math.min(UI_GLOW_MAX_RADIUS, radius)),
  );
  const hit = cache.get(r);
  if (hit) return hit;

  const size = r * 2;
  const canvas = createCanvas(size, size);
  const ctx = context2d(canvas);
  // Opaque black backing: additive blending ignores alpha, so black is the
  // identity and the falloff has to live in the RGB channels.
  clearToBlack(ctx, size, size);
  ctx.globalCompositeOperation = "source-over";

  const steps = Math.round(Math.max(UI_GLOW_MIN_STEPS, Math.min(UI_GLOW_MAX_STEPS, r)));
  for (let i = steps; i >= 1; i--) {
    const f = i / steps; // 1 at the rim, ~0 at the core
    const b = Math.pow(1 - f, UI_GLOW_GAMMA);
    const v = Math.max(0, Math.min(255, Math.trunc(255 * b)));
    ctx.fillStyle = `rgb(${v},${v},${v})`;
    ctx.beginPath();
    ctx.arc(r, r, Math.max(1, Math.trunc(r * f)), 0, Math.PI * 2);
    ctx.fill();
  }

  const tex = canvasTexture(canvas);
  cache.set(r, tex);
  return tex;
}

/** An additive UI bloom sprite, centred on its position. */
export function uiGlowSprite(radius: number, color: RGB, intensity = 1): Sprite {
  const sprite = new Sprite(uiGlowTexture(radius));
  sprite.anchor.set(0.5);
  sprite.blendMode = "add";
  setUiGlow(sprite, radius, color, intensity);
  return sprite;
}

/**
 * Re-point an existing UI bloom. Swaps the texture only when the radius really
 * changes, so a breathing glow costs two property writes.
 */
export function setUiGlow(
  sprite: Sprite,
  radius: number,
  color: RGB,
  intensity = 1,
): void {
  // `_blit_glow` returns early below this, drawing nothing.
  if (intensity <= UI_GLOW_EPSILON) {
    sprite.visible = false;
    return;
  }
  sprite.visible = true;
  const tex = uiGlowTexture(radius);
  if (sprite.texture !== tex) sprite.texture = tex;
  sprite.tint = toHex(color);
  sprite.alpha = Math.max(0, Math.min(1, intensity));
}

/** Drop every cached bloom. Tests and hot-reload only. */
export function clearUiGlowCache(): void {
  for (const t of cache.values()) t.destroy(true);
  cache.clear();
}

/** Cache occupancy, for the debug overlay and tests. */
export function uiGlowCacheSize(): number {
  return cache.size;
}
