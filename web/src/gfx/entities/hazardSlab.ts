/**
 * The hazard slab: the one pre-baked raster in the whole hazard layer.
 *
 * `_hazard_slab` (obstacles.py) paints a vertical gradient body, 45-degree
 * warning stripes and two keylines into an `SRCALPHA` surface, and every one of
 * those passes goes through `pygame.draw`, which **writes** RGBA rather than
 * blending it. That is why this is built through `ImageData` and not with
 * Canvas 2D compositing: the hatch *replaces* alpha-238 body pixels with
 * alpha-42 pixels, so on screen a stripe is a see-through, darker band that you
 * look through to the background. A `source-over` pass at 16% alpha would
 * lighten the slab instead, which is the opposite of what ships.
 *
 * The stripe rasterisation is copied from a pixel dump of pygame 2.6.1: a
 * 3 px-wide horizontal run centred on `x = k + row` for every row, with `k`
 * stepping 14 px from `-h`. A 60x40 slab built this way has exactly the
 * measured histogram - 1440 px at alpha 238, 396 at 42, 384 at 235, 180 at 160.
 *
 * Built once per obstacle per theme and cached on size + colours; a level has
 * at most a dozen walls and bars, so the whole cost lands at level load.
 */

import type { Texture } from "pixi.js";

import { lerpColor, shade, type RGB } from "../../core/palette";
import { canvasTexture, context2d, createCanvas } from "../textures";

const cache = new Map<string, Texture>();

function key(w: number, h: number, base: RGB, edge: RGB, hatched: boolean): string {
  return `${w}x${h}:${base[0]},${base[1]},${base[2]}:${edge[0]},${edge[1]},${edge[2]}:${hatched ? 1 : 0}`;
}

/** Write one RGBA pixel, overwriting whatever was there - `pygame.draw`'s rule. */
function put(
  d: Uint8ClampedArray,
  w: number,
  h: number,
  x: number,
  y: number,
  c: RGB,
  a: number,
): void {
  if (x < 0 || y < 0 || x >= w || y >= h) return;
  const o = (y * w + x) * 4;
  d[o] = c[0];
  d[o + 1] = c[1];
  d[o + 2] = c[2];
  d[o + 3] = a;
}

/**
 * Bake one hazard slab.
 *
 * `base` colours the body and the hatch, `edge` the two keylines - walls pass
 * `theme.hazard` for both, moving bars pass `theme.accent2` as the edge.
 */
export function hazardSlabTexture(
  w: number,
  h: number,
  base: RGB,
  edge: RGB,
  hatched = true,
): Texture {
  const iw = Math.max(2, Math.trunc(w));
  const ih = Math.max(2, Math.trunc(h));
  const k = key(iw, ih, base, edge, hatched);
  const hit = cache.get(k);
  if (hit) return hit;

  const canvas = createCanvas(iw, ih);
  const ctx = context2d(canvas);
  const img = ctx.createImageData(iw, ih);
  const d = img.data;

  const top = shade(base, 0.42);
  const bot = shade(base, 0.16);
  const last = Math.max(1, ih - 1);
  for (let y = 0; y < ih; y++) {
    const c = lerpColor(top, bot, y / last);
    for (let x = 0; x < iw; x++) put(d, iw, ih, x, y, c, 238);
  }

  if (hatched) {
    const hatch = shade(base, 0.85);
    for (let k0 = -ih; k0 < iw + ih; k0 += 14) {
      for (let y = 0; y < ih; y++) {
        const cx = k0 + y;
        for (let dx = -1; dx <= 1; dx++) put(d, iw, ih, cx + dx, y, hatch, 42);
      }
    }
  }

  // Both keylines are `pygame.draw.rect(..., width)`, which strokes inward from
  // the rect bounds - so they eat into the body rather than sitting outside it.
  const outer = shade(edge, 1.15);
  for (let y = 0; y < ih; y++) {
    for (let x = 0; x < iw; x++) {
      if (x < 2 || y < 2 || x >= iw - 2 || y >= ih - 2) put(d, iw, ih, x, y, outer, 235);
    }
  }
  const inner = shade(edge, 0.45);
  const ix1 = iw - 3;
  const iy1 = ih - 3;
  if (ix1 >= 2 && iy1 >= 2) {
    for (let x = 2; x <= ix1; x++) {
      put(d, iw, ih, x, 2, inner, 160);
      put(d, iw, ih, x, iy1, inner, 160);
    }
    for (let y = 2; y <= iy1; y++) {
      put(d, iw, ih, 2, y, inner, 160);
      put(d, iw, ih, ix1, y, inner, 160);
    }
  }

  ctx.putImageData(img, 0, 0);
  const tex = canvasTexture(canvas);
  cache.set(k, tex);
  return tex;
}

/** Occupancy, for the debug overlay and tests. */
export function hazardSlabCacheSize(): number {
  return cache.size;
}

/**
 * Drop every baked slab. Wire this to a theme change or a lost GL context -
 * the slabs are keyed on their colours, so a stale cache is a leak, not a bug.
 */
export function clearHazardSlabCache(): void {
  for (const t of cache.values()) t.destroy(true);
  cache.clear();
}
