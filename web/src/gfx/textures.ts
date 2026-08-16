/**
 * Procedurally generated textures.
 *
 * NEON SERPENT ships no image assets - in the Python original every glow, disc
 * and gradient is drawn onto a pygame `Surface` at load time and blitted with
 * `BLEND_RGB_ADD`. This module is the web counterpart: it builds the same
 * shapes on a 2D canvas, uploads them once as GPU textures, and hands out
 * additive sprites that reuse them.
 *
 * Two things change in the translation, both deliberate:
 *
 * 1. **Colour moves off the texture.** Python bakes a colour and an intensity
 *    into every cached surface, so a pulsing glow needs a quantised cache
 *    (radius to 2.5 px, intensity to 1/16) to avoid rebuilding surfaces every
 *    frame. Here the cached texture is always *white*, and colour arrives as
 *    the sprite's `tint` with intensity as its `alpha`. Under additive blending
 *    that composites to `dst + white(d) * tint * alpha`, which is the same
 *    arithmetic the CPU path produced - but tint and alpha are free, so the
 *    pulse is smooth instead of stepped and the cache collapses to a handful of
 *    radii.
 *
 *    The one case that does not survive is `shade(colour, f)` with `f > 1`,
 *    which saturates per channel and skews the hue toward white. Tint times
 *    alpha cannot express it. {@link paintRadial} (the build-time path) does
 *    reproduce it faithfully; callers needing it at runtime must bake.
 *
 * 2. **Big radii build small.** Python builds radii >= 128 px at quarter scale
 *    and upsamples. The same trick applies here for a better reason: the
 *    texture is a smooth falloff, so a 256 px one scaled up by the sprite is
 *    indistinguishable from a 1050 px one and costs 1/16 of the memory.
 *
 * The stepped falloff is kept. It is visible as faint banding in the largest
 * glows, it is what the original looks like, and smoothing it out would be a
 * change of art direction rather than a port.
 */

import { CanvasSource, Sprite, Texture, type TextureSourceOptions } from "pixi.js";

import { clamp8, shade, toHex, type RGB } from "../core/palette";

/** Anything we can get a 2D context from. */
export type Canvas2D = HTMLCanvasElement | OffscreenCanvas;

/**
 * Largest radius actually rasterised. Bigger glows reuse this and scale up;
 * the falloff is smooth enough that nobody can tell.
 */
const MAX_BUILD_RADIUS = 128;

/** Python's `_radial` default. Fewer steps means chunkier banding. */
export const DEFAULT_GLOW_STEPS = 14;

// ---------------------------------------------------------------------------
// Canvas plumbing
// ---------------------------------------------------------------------------

/** Allocate a drawing canvas, preferring the DOM one so devtools can show it. */
export function createCanvas(w: number, h: number): Canvas2D {
  const width = Math.max(1, Math.ceil(w));
  const height = Math.max(1, Math.ceil(h));
  if (typeof document !== "undefined" && typeof document.createElement === "function") {
    const c = document.createElement("canvas");
    c.width = width;
    c.height = height;
    return c;
  }
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(width, height);
  throw new Error(
    "gfx/textures: no canvas implementation available - the graphics layer " +
      "needs a browser (or a DOM shim) and must not be imported by headless tests.",
  );
}

/** Get a 2D context, or explain why we cannot. */
export function context2d(canvas: Canvas2D): CanvasRenderingContext2D {
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D | null;
  if (!ctx) throw new Error("gfx/textures: could not acquire a 2D context");
  return ctx;
}

/** Fill a canvas with opaque black - the backing every additive layer starts from. */
export function clearToBlack(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, w, h);
}

/** Upload a canvas as a texture. The canvas may be discarded afterwards. */
export function canvasTexture(
  canvas: Canvas2D,
  options?: Partial<TextureSourceOptions>,
): Texture {
  const source = new CanvasSource({
    resource: canvas as HTMLCanvasElement,
    // The design space is scaled by the viewport, so a texture pixel is a
    // design pixel; letting Pixi apply devicePixelRatio here would double-scale.
    resolution: 1,
    ...options,
  });
  return new Texture({ source });
}

/** A texture built for `TilingSprite`, so sampling wraps instead of clamping. */
export function tilingTexture(canvas: Canvas2D): Texture {
  return canvasTexture(canvas, { addressMode: "repeat" });
}

/** `rgb(r, g, b)` / `rgba(...)` for canvas fills. */
export function cssRgb(c: RGB, alpha = 1): string {
  const r = clamp8(c[0]);
  const g = clamp8(c[1]);
  const b = clamp8(c[2]);
  return alpha >= 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${alpha})`;
}

// ---------------------------------------------------------------------------
// The radial falloff, the primitive everything else is made of
// ---------------------------------------------------------------------------

/**
 * Draw the falloff discs straight into `ctx`, assuming it is a dedicated
 * surface being overwritten.
 *
 * `steps` concentric discs go down largest-and-dimmest first, each *replacing*
 * the last, which lands at `colour * intensity * (1 - (d/radius)^2)` in `steps`
 * bands. The overwrite matters: adding the discs instead would sum the whole
 * series and come out several times too bright.
 */
function drawRadialDiscs(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radius: number,
  color: RGB,
  intensity: number,
  steps: number,
): void {
  const r = Math.max(1, Math.floor(radius));
  const n = Math.max(1, Math.floor(steps));
  ctx.globalCompositeOperation = "source-over";
  for (let i = 0; i < n; i++) {
    const rr = r * Math.sqrt(1 - i / n);
    if (rr < 0.6) continue;
    ctx.fillStyle = cssRgb(shade(color, (intensity * (i + 1)) / n));
    ctx.beginPath();
    ctx.arc(cx, cy, rr, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** Scratch surface for {@link paintRadial}, grown to the largest stamp so far. */
let scratchCanvas: Canvas2D | null = null;

function scratchOfSize(size: number): { canvas: Canvas2D; ctx: CanvasRenderingContext2D } {
  if (!scratchCanvas || scratchCanvas.width < size || scratchCanvas.height < size) {
    scratchCanvas = createCanvas(size, size);
  }
  return { canvas: scratchCanvas, ctx: context2d(scratchCanvas) };
}

/**
 * Additively stamp a radial glow onto a layer being built - Python's
 * `_add(surface, _radial(...), cx, cy)` as one call.
 *
 * The two halves have to stay separate: the falloff is built by *overwriting*
 * discs on a scratch surface, and only the finished glow is *added* to the
 * layer. Doing both on the layer at once sums every band and blows the glow
 * out. Callers do not need to touch `globalCompositeOperation`; this restores
 * whatever was set.
 */
export function paintRadial(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radius: number,
  color: RGB,
  intensity = 1,
  steps = DEFAULT_GLOW_STEPS,
): void {
  const r = Math.max(1, Math.floor(radius));
  const size = r * 2;
  const { canvas, ctx: sctx } = scratchOfSize(size);

  sctx.globalCompositeOperation = "source-over";
  sctx.clearRect(0, 0, size, size);
  drawRadialDiscs(sctx, r, r, r, color, intensity, steps);

  const prev = ctx.globalCompositeOperation;
  // "lighter" is per-channel saturating add: pygame's BLEND_RGB_ADD. The
  // cleared area of the scratch is transparent and so contributes nothing,
  // exactly as the black backing of a pygame surface does.
  ctx.globalCompositeOperation = "lighter";
  ctx.drawImage(
    canvas as CanvasImageSource,
    0,
    0,
    size,
    size,
    Math.floor(cx) - r,
    Math.floor(cy) - r,
    size,
    size,
  );
  ctx.globalCompositeOperation = prev;
}

/**
 * Quantise a radius to keep the texture cache small.
 *
 * Same ladder as Python's glow cache: coarse when large (where a few pixels of
 * radius are invisible), exact when tiny (where they are not).
 */
export function quantiseRadius(radius: number): number {
  const r = Math.max(1, Math.floor(radius));
  if (r >= 64) return r - (r % 8);
  if (r >= 8) return r - (r % 2);
  return r;
}

const radialCache = new Map<string, Texture>();

/**
 * A cached **white** radial falloff, `2r` square with the centre at the middle.
 *
 * Tint it and set its alpha at the sprite; do not ask for one texture per
 * colour. The returned texture's size is capped at {@link MAX_BUILD_RADIUS},
 * so scale the sprite to the radius you actually want -
 * {@link glowSprite} handles that for you.
 */
export function radialTexture(radius: number, steps = DEFAULT_GLOW_STEPS): Texture {
  const q = quantiseRadius(radius);
  const n = Math.max(1, Math.floor(steps));
  const key = `${q}|${n}`;
  const hit = radialCache.get(key);
  if (hit) return hit;

  const build = Math.min(q, MAX_BUILD_RADIUS);
  const size = build * 2;
  const canvas = createCanvas(size, size);
  const ctx = context2d(canvas);
  clearToBlack(ctx, size, size);
  drawRadialDiscs(ctx, build, build, build, [255, 255, 255], 1, n);

  const tex = canvasTexture(canvas);
  radialCache.set(key, tex);
  return tex;
}

/**
 * An additive glow, ready to add to a container.
 *
 * `radius` is in design pixels and is what the sprite is sized to, whatever
 * resolution the underlying texture happens to be.
 */
export function glowSprite(
  radius: number,
  color: RGB,
  intensity = 1,
  steps = DEFAULT_GLOW_STEPS,
): Sprite {
  const sprite = new Sprite(radialTexture(radius, steps));
  sprite.anchor.set(0.5);
  sprite.blendMode = "add";
  setGlow(sprite, radius, color, intensity, steps);
  return sprite;
}

/**
 * Re-point an existing glow sprite. Swaps the texture only when the quantised
 * radius actually changes, so a pulsing glow costs two property writes.
 */
export function setGlow(
  sprite: Sprite,
  radius: number,
  color: RGB,
  intensity = 1,
  steps = DEFAULT_GLOW_STEPS,
): void {
  const r = Math.max(0.5, radius);
  const tex = radialTexture(r, steps);
  if (sprite.texture !== tex) sprite.texture = tex;
  sprite.width = r * 2;
  sprite.height = r * 2;
  sprite.tint = toHex(color);
  sprite.alpha = intensity < 0 ? 0 : intensity > 1 ? 1 : intensity;
}

// ---------------------------------------------------------------------------
// The render.py halo - a different falloff from the backgrounds' radial
// ---------------------------------------------------------------------------

const haloCache = new Map<number, Texture>();

/**
 * A cached **white** halo with `render.py::_build_glow`'s falloff
 * (render.py:277-307): brightness `u^2 * (0.35 + 0.65u)` where `u` runs 0 at
 * the rim to 1 at the core, plus a small solid core at `0.12r`.
 *
 * This is the curve behind `draw_glow_circle` - the headline glows, the star
 * pops and the badge halos of the result screens. It is much steeper than
 * {@link radialTexture}'s `1 - (d/r)^2` (the backgrounds' `_radial`): at half
 * radius this one carries ~17% where the radial carries 75%. Substituting one
 * for the other makes every heading halo read several times too hot - caught
 * by screenshot against `captures/10-gameover.png`, not by any test.
 */
export function haloTexture(radius: number): Texture {
  const q = quantiseRadius(radius);
  const hit = haloCache.get(q);
  if (hit) return hit;

  const r = Math.min(q, MAX_BUILD_RADIUS);
  const size = Math.max(2, r * 2);
  const canvas = createCanvas(size, size);
  const ctx = context2d(canvas);
  clearToBlack(ctx, size, size);
  ctx.globalCompositeOperation = "source-over";

  // Concentric discs from the rim in, each overwriting the last - adding them
  // would sum the series and blow the halo out.
  const steps = Math.trunc(Math.max(10, Math.min(60, r * 1.35)));
  for (let i = 0; i < steps; i++) {
    const u = i / steps; // 0 at the rim, -> 1 at the core
    const rr = r * (1 - u);
    if (rr < 1) break;
    const f = u * u * (0.35 + 0.65 * u);
    if (f <= 0) continue;
    const v = clamp8(255 * f);
    ctx.fillStyle = `rgb(${v},${v},${v})`;
    ctx.beginPath();
    ctx.arc(r, r, Math.trunc(rr), 0, Math.PI * 2);
    ctx.fill();
  }
  // A tiny solid core keeps very small halos from vanishing entirely.
  ctx.fillStyle = "rgb(255,255,255)";
  ctx.beginPath();
  ctx.arc(r, r, Math.max(1, Math.trunc(r * 0.12)), 0, Math.PI * 2);
  ctx.fill();

  const tex = canvasTexture(canvas);
  haloCache.set(q, tex);
  return tex;
}

/** An additive `draw_glow_circle` stamp, centred on its position. */
export function haloSprite(radius: number, color: RGB, intensity = 1): Sprite {
  const sprite = new Sprite(haloTexture(radius));
  sprite.anchor.set(0.5);
  sprite.blendMode = "add";
  setHalo(sprite, radius, color, intensity);
  return sprite;
}

/**
 * Re-point an existing halo sprite. Intensity above 1 must be carried by a
 * second stacked sprite - alpha clamps at 1, exactly as {@link setGlow}.
 */
export function setHalo(sprite: Sprite, radius: number, color: RGB, intensity = 1): void {
  const r = Math.max(0.5, radius);
  const tex = haloTexture(r);
  if (sprite.texture !== tex) sprite.texture = tex;
  sprite.width = r * 2;
  sprite.height = r * 2;
  sprite.tint = toHex(color);
  sprite.alpha = intensity < 0 ? 0 : intensity > 1 ? 1 : intensity;
}

// ---------------------------------------------------------------------------
// Other stamps
// ---------------------------------------------------------------------------

const discCache = new Map<number, Texture>();

/**
 * A soft disc that stays at full strength across its middle and falls off only
 * at the rim - Python's `disc_surface`. The snake's cross-over contact shadow
 * is made of these: a plain radial would fade out exactly where the shadow
 * needs to be darkest.
 */
export function discTexture(radius: number): Texture {
  const q = quantiseRadius(radius);
  const hit = discCache.get(q);
  if (hit) return hit;

  const build = Math.min(q, MAX_BUILD_RADIUS);
  const size = build * 2;
  const canvas = createCanvas(size, size);
  const ctx = context2d(canvas);
  clearToBlack(ctx, size, size);

  // Full strength across the middle, then a linear fade over the outer 45%.
  // Opaque overwrites, largest first - same discipline as the radial.
  const steps = 14;
  const solid = build * 0.55;
  for (let i = 0; i < steps; i++) {
    const rr = build - (build - solid) * (i / steps);
    const v = clamp8((255 * (i + 1)) / steps);
    ctx.fillStyle = `rgb(${v},${v},${v})`;
    ctx.beginPath();
    ctx.arc(build, build, rr, 0, Math.PI * 2);
    ctx.fill();
  }

  const tex = canvasTexture(canvas);
  discCache.set(q, tex);
  return tex;
}

const flareCache = new Map<string, Texture>();

/**
 * The star sparkle stamped on orbs and pickups - Python's `_flare_surface`.
 *
 * Each arm is three overlapping strokes, wide and dim through narrow and hot,
 * which is how the original fakes a bloomed highlight without a blur pass.
 */
export function flareTexture(radius: number, arms = 4): Texture {
  const q = quantiseRadius(radius);
  const n = arms === 6 ? 6 : 4;
  const key = `${q}|${n}`;
  const hit = flareCache.get(key);
  if (hit) return hit;

  const build = Math.min(q, MAX_BUILD_RADIUS);
  const size = build * 2;
  const canvas = createCanvas(size, size);
  const ctx = context2d(canvas);
  clearToBlack(ctx, size, size);
  // Strokes overwrite, as pygame's draw.line does: the narrow hot pass replaces
  // the middle of the wide dim one instead of piling onto it.
  ctx.globalCompositeOperation = "source-over";
  ctx.lineCap = "butt";

  const passes: Array<[number, number]> = [
    [5, 0.22],
    [3, 0.45],
    [1, 0.95],
  ];
  for (let a = 0; a < n; a++) {
    const ang = (Math.PI * 2 * a) / n;
    const dx = Math.cos(ang) * build;
    const dy = Math.sin(ang) * build;
    for (const [width, level] of passes) {
      const v = clamp8(255 * level);
      ctx.strokeStyle = `rgb(${v},${v},${v})`;
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.moveTo(build, build);
      ctx.lineTo(build + dx, build + dy);
      ctx.stroke();
    }
  }
  // A core so the arms meet in something bright rather than a seam.
  paintRadial(ctx, build, build, Math.max(2, build * 0.28), [255, 255, 255], 0.9, 10);

  const tex = canvasTexture(canvas);
  flareCache.set(key, tex);
  return tex;
}

let whiteTex: Texture | null = null;

/** A 1x1 opaque white texture: the cheap way to draw a tinted rectangle. */
export function whiteTexture(): Texture {
  if (whiteTex) return whiteTex;
  const canvas = createCanvas(1, 1);
  const ctx = context2d(canvas);
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, 1, 1);
  whiteTex = canvasTexture(canvas);
  return whiteTex;
}

// ---------------------------------------------------------------------------
// Full-area builders
// ---------------------------------------------------------------------------

/**
 * A vertical two-stop gradient, built one pixel tall per row and stretched.
 *
 * Returns a 1 x `h` texture: scale the sprite to the width you need. Sampling
 * is linear across the strip, so the ramp is smooth however far it is stretched.
 */
export function gradientTexture(h: number, top: RGB, bottom: RGB): Texture {
  const height = Math.max(2, Math.ceil(h));
  const canvas = createCanvas(1, height);
  const ctx = context2d(canvas);
  const img = ctx.createImageData(1, height);
  const d = img.data;
  const last = Math.max(1, height - 1);
  for (let y = 0; y < height; y++) {
    const t = y / last;
    d[y * 4] = clamp8(top[0] + (bottom[0] - top[0]) * t);
    d[y * 4 + 1] = clamp8(top[1] + (bottom[1] - top[1]) * t);
    d[y * 4 + 2] = clamp8(top[2] + (bottom[2] - top[2]) * t);
    d[y * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return canvasTexture(canvas);
}

/**
 * A tile that repeats without a visible seam, sampled from `fn(u, v)`.
 *
 * `fn` is evaluated on a `(cells + 1)` square grid whose last row and column
 * repeat the first, so bilinear interpolation carries across the wrap; the grid
 * is then upscaled to `tilePx`. Pair the result with a `TilingSprite` and the
 * wrap is exact for any offset.
 */
export function seamlessTexture(
  tilePx: number,
  cells: number,
  fn: (u: number, v: number) => RGB,
): Texture {
  const n = Math.max(2, Math.floor(cells));
  const tile = Math.max(n, Math.floor(tilePx) - (Math.floor(tilePx) % n));
  const step = tile / n;
  const gridN = n + 1;

  const small = createCanvas(gridN, gridN);
  const sctx = context2d(small);
  const img = sctx.createImageData(gridN, gridN);
  const d = img.data;
  for (let j = 0; j < gridN; j++) {
    const v = (j % n) / n;
    for (let i = 0; i < gridN; i++) {
      const u = (i % n) / n;
      const c = fn(u, v);
      const o = (j * gridN + i) * 4;
      d[o] = clamp8(c[0]);
      d[o + 1] = clamp8(c[1]);
      d[o + 2] = clamp8(c[2]);
      d[o + 3] = 255;
    }
  }
  sctx.putImageData(img, 0, 0);

  // Upscale so each grid sample spans `step` px, then crop off the repeated
  // edge - what remains tiles against itself exactly.
  const big = createCanvas(tile, tile);
  const bctx = context2d(big);
  bctx.imageSmoothingEnabled = true;
  bctx.imageSmoothingQuality = "high";
  bctx.drawImage(
    small as CanvasImageSource,
    -step * 0.5,
    -step * 0.5,
    gridN * step,
    gridN * step,
  );
  return tilingTexture(big);
}

/**
 * The depth vignette: a greyscale bowl, darkest at the corners.
 *
 * One shared 128x76 template serves every background. It is stretched to the
 * arena by its sprite and multiplied over the finished frame, and the slow
 * colour drift is applied as the sprite's tint - so the elaborate per-size,
 * per-tint surface cache the CPU version needs disappears entirely.
 */
let vignetteTex: Texture | null = null;

export function vignetteTexture(): Texture {
  if (vignetteTex) return vignetteTex;
  const W = 128;
  const H = 76;
  const EDGE = 0.34; // brightness removed at the far corners
  const canvas = createCanvas(W, H);
  const ctx = context2d(canvas);
  const img = ctx.createImageData(W, H);
  const d = img.data;
  for (let j = 0; j < H; j++) {
    const dy = ((j + 0.5) / H) * 2 - 1;
    for (let i = 0; i < W; i++) {
      const dx = ((i + 0.5) / W) * 2 - 1;
      const dd = Math.min(1, Math.hypot(dx, dy) / 1.34);
      const v = Math.trunc(255 * (1 - EDGE * Math.pow(dd, 1.7)));
      const o = (j * W + i) * 4;
      d[o] = v;
      d[o + 1] = v;
      d[o + 2] = v;
      d[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  vignetteTex = canvasTexture(canvas);
  return vignetteTex;
}

/** How many drift steps the vignette tint is quantised to, as in Python. */
export const DEPTH_STEPS = 48;
/** Peak per-channel swing of the drift tint, 0..255. */
export const DEPTH_TINT = 13.0;

/**
 * The vignette tint for a drift step, as a packed colour.
 *
 * The drift walks a slow warm-to-cool cycle across roughly 84 seconds; keeping
 * Python's 48-step quantisation costs nothing and keeps the two builds honest.
 */
export function vignetteTint(depthIdx: number): number {
  const s = Math.min(1, Math.max(0, depthIdx / (DEPTH_STEPS - 1)));
  return toHex([
    255 - Math.trunc(DEPTH_TINT * s),
    255 - Math.trunc(DEPTH_TINT * 0.45),
    255 - Math.trunc(DEPTH_TINT * (1 - s)),
  ]);
}

/**
 * A bank of black tiles scratched with short horizontal streaks - the source of
 * the Violet Static stage's interference. Returns `count` textures to cycle.
 */
export function noiseTileTextures(
  size: number,
  count: number,
  density: number,
  cols: readonly RGB[],
  rng: { randrange(n: number): number; randint(a: number, b: number): number },
): Texture[] {
  const s = Math.max(2, Math.floor(size));
  const out: Texture[] = [];
  for (let k = 0; k < count; k++) {
    const canvas = createCanvas(s, s);
    const ctx = context2d(canvas);
    clearToBlack(ctx, s, s);
    for (let i = 0; i < density; i++) {
      const c = cols[rng.randrange(cols.length)] ?? [255, 255, 255];
      ctx.fillStyle = cssRgb(c);
      ctx.fillRect(rng.randrange(s), rng.randrange(s), rng.randint(1, 4), 1);
    }
    out.push(canvasTexture(canvas));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Housekeeping
// ---------------------------------------------------------------------------

/**
 * Drop every cached texture. Only for tests and hot-reload; the caches are
 * bounded by construction (a few dozen radii) and are meant to live for the
 * session.
 */
export function disposeGeneratedTextures(): void {
  for (const t of radialCache.values()) t.destroy(true);
  for (const t of discCache.values()) t.destroy(true);
  for (const t of flareCache.values()) t.destroy(true);
  radialCache.clear();
  discCache.clear();
  flareCache.clear();
  whiteTex?.destroy(true);
  whiteTex = null;
  vignetteTex?.destroy(true);
  vignetteTex = null;
}

/** Cache occupancy, for the debug overlay and tests. */
export function generatedTextureStats(): {
  radial: number;
  disc: number;
  flare: number;
} {
  return { radial: radialCache.size, disc: discCache.size, flare: flareCache.size };
}
