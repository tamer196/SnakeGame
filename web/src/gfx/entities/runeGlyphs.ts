/**
 * The six power-up emblems, baked as white glyph textures.
 *
 * `_paint_glyph` (powerups.py) authors every glyph in a normalised -1..1 box
 * and strokes it at build time, so the shapes here are transcriptions of those
 * point tables. Two conventions carry over and are easy to get wrong:
 *
 * - `_arc_pts` negates sin, i.e. arcs are authored **y-up** and then consumed
 *   in a y-down box, so `arcPts(r, 0, PI)` runs from `(+r, 0)` over the **top**
 *   to `(-r, 0)`. The magnet's horseshoe and the ghost's dome both depend on it.
 * - Stroke width is `max(2, int(s * 0.22))` where `s` is the glyph radius, and
 *   the size bucket is Python's: the requested size truncated down to an even
 *   number of pixels. Keeping the bucketing keeps the texture count at a
 *   handful per kind while the rune breathes.
 *
 * Python bakes `lerp_color(kind_colour, WHITE, 0.55)` times one of six
 * brightness steps into each sprite. Here the texture is white, the colour is
 * the sprite's tint and the brightness is its alpha, so the strobe is
 * continuous rather than quantised to six levels - the same allowed smoothness
 * as every other tinted glow in the port.
 */

import type { Texture } from "pixi.js";

import { canvasTexture, context2d, createCanvas } from "../textures";

/** Normalised glyph outlines, straight from `powerups.py`. */
const SHIELD: ReadonlyArray<readonly [number, number]> = [
  [-0.8, -0.72],
  [0.8, -0.72],
  [0.8, 0.06],
  [0.0, 0.94],
  [-0.8, 0.06],
];
// The waist is asymmetric (+0.12 then -0.12); that is what makes the bulbs
// read as mirrored trapezia instead of a bowtie.
const HOURGLASS: ReadonlyArray<readonly [number, number]> = [
  [-0.72, -0.88],
  [0.72, -0.88],
  [0.12, 0.0],
  [0.72, 0.88],
  [-0.72, 0.88],
  [-0.12, 0.0],
];
const BOLT: ReadonlyArray<readonly [number, number]> = [
  [0.16, -0.96],
  [-0.66, 0.14],
  [-0.1, 0.14],
  [-0.3, 0.96],
  [0.62, -0.18],
  [0.06, -0.18],
];
const GHOST_TAIL: ReadonlyArray<readonly [number, number]> = [
  [0.74, 0.42],
  [0.44, 0.92],
  [0.15, 0.46],
  [-0.15, 0.92],
  [-0.44, 0.46],
  [-0.74, 0.92],
];

type Pt = readonly [number, number];

/** Points along an arc, authored y-up (hence the negated sin). */
function arcPts(r: number, a0: number, a1: number, steps: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = a0 + (a1 - a0) * (i / steps);
    out.push([Math.cos(a) * r, -Math.sin(a) * r]);
  }
  return out;
}

function strokePath(
  ctx: CanvasRenderingContext2D,
  pts: readonly Pt[],
  cx: number,
  cy: number,
  s: number,
  width: number,
  close: boolean,
): void {
  const first = pts[0];
  if (first === undefined) return;
  ctx.beginPath();
  ctx.moveTo(cx + first[0] * s, cy + first[1] * s);
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i];
    if (p === undefined) continue;
    ctx.lineTo(cx + p[0] * s, cy + p[1] * s);
  }
  if (close) ctx.closePath();
  ctx.lineWidth = width;
  ctx.stroke();
}

function fillPath(
  ctx: CanvasRenderingContext2D,
  pts: readonly Pt[],
  cx: number,
  cy: number,
  s: number,
): void {
  const first = pts[0];
  if (first === undefined) return;
  ctx.beginPath();
  ctx.moveTo(cx + first[0] * s, cy + first[1] * s);
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i];
    if (p === undefined) continue;
    ctx.lineTo(cx + p[0] * s, cy + p[1] * s);
  }
  ctx.closePath();
  ctx.fill();
}

function line(
  ctx: CanvasRenderingContext2D,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  width: number,
): void {
  ctx.beginPath();
  ctx.moveTo(ax, ay);
  ctx.lineTo(bx, by);
  ctx.lineWidth = width;
  ctx.stroke();
}

function dot(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

function paintGlyph(
  ctx: CanvasRenderingContext2D,
  kind: string,
  cx: number,
  cy: number,
  s: number,
): void {
  const w = Math.max(2, Math.trunc(s * 0.22));
  switch (kind) {
    case "magnet": {
      // A horseshoe, drawn wide on purpose: the gap between the poles is the
      // whole silhouette and it has to survive the core glow behind it.
      const ring = arcPts(0.92, 0, Math.PI, 14);
      strokePath(ctx, ring, cx, cy - 0.1 * s, s, w, false);
      for (const sx of [-0.92, 0.92]) {
        line(ctx, cx + sx * s, cy - 0.1 * s, cx + sx * s, cy + 0.74 * s, w);
      }
      for (const sx of [-0.92, 0.92]) {
        line(
          ctx,
          cx + sx * s * 1.3,
          cy + 0.74 * s,
          cx + sx * s * 0.55,
          cy + 0.74 * s,
          Math.max(2, Math.trunc(w * 0.9)),
        );
      }
      break;
    }
    case "shield":
      strokePath(ctx, SHIELD, cx, cy, s, w, true);
      line(ctx, cx, cy - 0.36 * s, cx, cy + 0.46 * s, Math.max(1, w - 1));
      break;
    case "slow":
      strokePath(ctx, HOURGLASS, cx, cy, s, w, true);
      dot(ctx, cx, cy + 0.52 * s, Math.max(2, Math.trunc(s * 0.14)));
      break;
    case "double":
      // Two nested diamonds: one shape, doubled - "2x" without text.
      for (const scale of [0.94, 0.48]) {
        const dia: Pt[] = [
          [0.0, -scale],
          [scale, 0.0],
          [0.0, scale],
          [-scale, 0.0],
        ];
        strokePath(ctx, dia, cx, cy, s, w, true);
      }
      break;
    case "ghost": {
      // The hem is reversed so the closed outline never crosses itself.
      const outline = [...arcPts(0.74, 0, Math.PI, 12), ...[...GHOST_TAIL].reverse()];
      strokePath(ctx, outline, cx, cy, s, w, true);
      for (const sx of [-0.3, 0.3]) {
        dot(ctx, cx + sx * s, cy - 0.16 * s, Math.max(2, Math.trunc(s * 0.13)));
      }
      break;
    }
    case "frenzy":
      fillPath(ctx, BOLT, cx, cy, s); // the only filled glyph
      break;
    default:
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(2, Math.trunc(s * 0.7)), 0, Math.PI * 2);
      ctx.lineWidth = w;
      ctx.stroke();
      break;
  }
}

const cache = new Map<string, Texture>();

/** Python's size bucket: truncate to whole pixels, then down to an even count. */
export function glyphSizeBucket(size: number): number {
  return Math.max(4, Math.floor(Math.trunc(size) / 2) * 2);
}

/**
 * A white emblem texture, `sb * 2 + 6` px square with the glyph centred.
 *
 * Tint it with `lerpColor(powerupColor(kind), WHITE, 0.55)` and drive its alpha
 * from the rune's brightness; emblems are drawn far whiter than anything else
 * in the rune so they stay legible against the core glow they sit on.
 */
export function runeGlyphTexture(kind: string, size: number): Texture {
  const sb = glyphSizeBucket(size);
  const key = `${kind}|${sb}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const box = sb * 2 + 6;
  const canvas = createCanvas(box, box);
  const ctx = context2d(canvas);
  ctx.clearRect(0, 0, box, box);
  ctx.strokeStyle = "#fff";
  ctx.fillStyle = "#fff";
  // pygame lays each segment down as an independent quad; a canvas path mitres
  // its joins instead, which fills the notches on a 10 px glyph. Nobody can
  // see the difference and the alternative is one stroke call per segment.
  ctx.lineCap = "butt";
  ctx.lineJoin = "miter";
  paintGlyph(ctx, kind, box * 0.5, box * 0.5, sb * 0.5);

  const tex = canvasTexture(canvas);
  cache.set(key, tex);
  return tex;
}

/** Occupancy, for the debug overlay and tests. */
export function runeGlyphCacheSize(): number {
  return cache.size;
}

/** Drop every baked emblem - the counterpart of `powerups.clear_caches()`. */
export function clearRuneGlyphCache(): void {
  for (const t of cache.values()) t.destroy(true);
  cache.clear();
}
