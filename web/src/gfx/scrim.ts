/**
 * The story scene's cinematic scrim band and corner vignette, composited into
 * one texture - a port of `_overlay_surface`
 * (`snake/scenes/story_scene.py:328-385`).
 *
 * Two jobs, one sprite. The band is what makes text legible over twelve very
 * different backdrops without a hard-edged dialog box - its alpha ramps in
 * over the top of the band and out over the bottom, so it never announces
 * itself - and the vignette pulls the eye to the middle of the frame.
 *
 * Both are pure low-frequency ramps, so the whole thing is authored on a
 * 128x72 template and stretched by the sprite; the GPU's linear sampling is
 * the Python's `smoothscale`. The band is pinned to DESIGN y (58..604) even
 * when the texture covers overscan, because the band's job is to sit behind
 * the text, which lives in the design box; the vignette spans whatever rect
 * it is given so a wide phone's edges still darken (scenes.md §10.11).
 */

import { Texture } from "pixi.js";

import { clamp } from "../core/mathx";
import { canvasTexture, context2d, createCanvas } from "./textures";

/** The darkening band's design-space extent. story_scene.py:72 */
const SCRIM_TOP = 58;
const SCRIM_BOTTOM = 604;
/** Peak alphas. story_scene.py:330-331 */
const SCRIM_PEAK = 168;
const VIGNETTE_PEAK = 190;
/** The scrim/vignette tint. story_scene.py:329 */
const TINT: readonly [number, number, number] = [4, 6, 14];

const TEMPLATE_W = 128;
const TEMPLATE_H = 72;

const cache = new Map<string, Texture>();

export interface RectLike {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The composited overlay for a target rect (usually `viewport.overscan`).
 * Cached per rect; the cache clears itself past a handful of sizes.
 */
export function scrimVignetteTexture(rect: RectLike): Texture {
  const key = [
    Math.round(rect.x),
    Math.round(rect.y),
    Math.max(2, Math.round(rect.w)),
    Math.max(2, Math.round(rect.h)),
  ].join("|");
  const hit = cache.get(key);
  if (hit) return hit;

  const h = Math.max(1, rect.h);
  const bandTop = (SCRIM_TOP - rect.y) / h;
  const bandBot = (SCRIM_BOTTOM - rect.y) / h;
  const bandSpan = Math.max(1e-3, bandBot - bandTop);

  const canvas = createCanvas(TEMPLATE_W, TEMPLATE_H);
  const ctx = context2d(canvas);
  const img = ctx.createImageData(TEMPLATE_W, TEMPLATE_H);
  const data = img.data;

  for (let j = 0; j < TEMPLATE_H; j++) {
    const vy = (j + 0.5) / TEMPLATE_H;
    let scrim = 0;
    if (bandTop <= vy && vy <= bandBot) {
      const f = (vy - bandTop) / bandSpan;
      if (f < 0.14) scrim = SCRIM_PEAK * Math.pow(f / 0.14, 1.5);
      else if (f > 0.72) scrim = SCRIM_PEAK * Math.pow(1 - (f - 0.72) / 0.28, 1.6);
      else scrim = SCRIM_PEAK;
    }
    const s = clamp(scrim, 0, 255) / 255;
    const dy = vy * 2 - 1;
    for (let i = 0; i < TEMPLATE_W; i++) {
      const dx = ((i + 0.5) / TEMPLATE_W) * 2 - 1;
      const d = clamp(Math.hypot(dx * 0.94, dy) / 1.3, 0, 1);
      const v = clamp(VIGNETTE_PEAK * Math.pow(d, 2.3), 0, 255) / 255;
      // Two translucent layers stacked: 1 - (1-a)(1-b).
      const alpha = Math.trunc(255 * (1 - (1 - s) * (1 - v)));
      const k = (j * TEMPLATE_W + i) * 4;
      data[k] = TINT[0];
      data[k + 1] = TINT[1];
      data[k + 2] = TINT[2];
      data[k + 3] = alpha;
    }
  }
  ctx.putImageData(img, 0, 0);

  if (cache.size > 4) clearScrimCache();
  const tex = canvasTexture(canvas);
  cache.set(key, tex);
  return tex;
}

/** Drop every cached overlay. Resize and tests. */
export function clearScrimCache(): void {
  for (const t of cache.values()) t.destroy(true);
  cache.clear();
}
