/**
 * Stage 5 - Abyssal Tide (`ocean`).
 *
 * The trench: something moves down there.
 *
 * Ported from `snake/gfx/background.py::OceanBackground`; the layer-by-layer
 * specification is in `docs/port/background-5-8.md`.
 *
 * Five depths, far to near: a deep bloom, the slow swell, the caustic sheet,
 * five swaying god rays and the bubble column. Both sheets are seamless tiles
 * on `TilingSprite`s, which retires Python's "build a layer one tile bigger
 * than the arena, blit it at a modulo offset" machinery - the wrap is now the
 * sampler's job.
 *
 * The bubbles are the signature: they rise, wobble on their own phase, and
 * carry a meniscus ring whose colour is borrowed from the water behind them,
 * so they read as surfaces rather than dots.
 */

import { Sprite, type Texture } from "pixi.js";

import { clamp, TAU } from "../../core/mathx";
import { toHex } from "../../core/palette";
import {
  canvasTexture,
  clearToBlack,
  context2d,
  createCanvas,
  cssRgb,
  glowSprite,
  paintRadial,
  seamlessTexture,
  setGlow,
  type Canvas2D,
} from "../textures";
import { Background, MARGIN, type ParallaxLayer } from "./Background";

const BUBBLES = 42;
const RAYS = 5;

/** Caustic tile period. 384 is a whole multiple of its 48 cells. */
const CAUSTIC_TILE = 384;
/**
 * Swell scroll period. Note the tile builder floors the period to a multiple
 * of the cell count, so the *texture* actually repeats every 240 px while the
 * offset below wraps at 256 - exactly as in Python, where the layer is built
 * from 240 px tiles and blitted at `offset % 256`. The 16 px hop each time the
 * offset wraps is therefore ported, not introduced.
 */
const SWELL_TILE = 256;

/** How many depth bands the meniscus colour is quantised into. */
const RIM_BANDS = 8;

interface Bubble {
  x: number;
  y: number;
  /** Rise speed, px/s. */
  rise: number;
  r: number;
  /** Wobble phase. */
  ph: number;
  readonly glow: Sprite;
  readonly ring: Sprite;
}

interface Ray {
  readonly sprite: Sprite;
  readonly x0: number;
  readonly speed: number;
  readonly ph: number;
}

/** Python's `%`: the result carries the sign of the divisor, never negative. */
function pmod(v: number, period: number): number {
  const m = v % period;
  return m < 0 ? m + period : m;
}

export class OceanBackground extends Background {
  // Every field is `declare`d and assigned in `build`. The base class calls
  // `build()` from its constructor, and JS class fields are defined *after*
  // `super()` returns - so a plain initialiser here would silently wipe
  // whatever the build had already produced.
  private declare swell: ParallaxLayer;
  private declare caustic: ParallaxLayer;
  private declare ca0: number;
  private declare ca1: number;
  private declare cb0: number;
  private declare cb1: number;

  private declare rays: Ray[];
  private declare bubbles: Bubble[];
  /** Meniscus colours, one per depth band, packed for `tint`. */
  private declare rimHex: number[];
  private declare rings: Map<number, Texture>;

  protected override build(): void {
    const { h, theme } = this;
    const light = this.mix(theme.accent, theme.accent2, 0.5);
    this.ca0 = 0;
    this.ca1 = 0;
    this.cb0 = 0;
    this.cb1 = 0;
    this.rays = [];
    this.bubbles = [];
    this.rimHex = [];
    this.rings = new Map<number, Texture>();

    this.buildDeepBloom();

    // The swell is a single low-frequency grating; the caustics are three
    // co-prime gratings whose zero crossings are lit by the ^14, which is what
    // turns a sum of sines into wandering filaments of light.
    const grid = theme.grid;
    this.swell = this.addTile(
      seamlessTexture(SWELL_TILE, 24, (u, v) => {
        const s = 0.5 + 0.5 * Math.sin((u * 1.0 + v * 2.0) * TAU);
        return this.shade(grid, 0.16 * (s * s));
      }),
      0.35,
    );
    this.caustic = this.addTile(
      seamlessTexture(CAUSTIC_TILE, 48, (u, v) => {
        const s =
          Math.sin((u * 3.0 + v * 2.0) * TAU + 0.7) +
          Math.sin((u * 2.0 - v * 5.0) * TAU + 2.1) +
          Math.sin((u * 5.0 + v * 3.0) * TAU + 4.3);
        const k = Math.pow(1.0 - clamp(Math.abs(s) / 3.0, 0.0, 1.0), 14);
        return this.shade(light, 0.34 * k);
      }),
      0.7,
    );

    this.buildRays();

    for (let i = 0; i < BUBBLES; i++) {
      const glow = glowSprite(1, theme.accent2, 0.34);
      const ring = new Sprite();
      ring.anchor.set(0.5);
      const b: Bubble = { x: 0, y: 0, rise: 0, r: 0, ph: 0, glow, ring };
      // Python passes the initial y as an argument, so it is drawn from the
      // stream before `_new_bubble` draws x.
      const y0 = this.rng.uniform(0, h);
      this.respawn(b);
      b.y = y0;
      this.bubbles.push(b);
      this.addSprite(glow);
      this.addSprite(ring);
    }

    for (let i = 0; i < RIM_BANDS; i++) {
      const water = this.bgAt((h * (i + 0.5)) / RIM_BANDS);
      this.rimHex.push(toHex(this.mix(water, theme.accent2, 0.55)));
    }
  }

  protected override animate(dt: number): void {
    const { w, h } = this;

    this.ca0 = pmod(this.ca0 + 13.0 * dt, CAUSTIC_TILE);
    this.ca1 = pmod(this.ca1 + 7.0 * dt, CAUSTIC_TILE);
    this.cb0 = pmod(this.cb0 - 5.0 * dt, SWELL_TILE);
    this.cb1 = pmod(this.cb1 + 3.0 * dt, SWELL_TILE);
    this.caustic.dx = this.ca0;
    this.caustic.dy = this.ca1;
    this.swell.dx = this.cb0;
    this.swell.dy = this.cb1;

    // Rays take the horizontal parallax only; Python pins them to the arena
    // top and lets the wedge run off the bottom.
    const rayPx = this.par(0.55)[0];
    for (const ray of this.rays) {
      ray.sprite.position.x =
        ray.x0 + Math.sin(this.t * ray.speed + ray.ph) * w * 0.06 + rayPx;
    }

    const [px, py] = this.par(0.95);
    const band = RIM_BANDS / h;
    for (const b of this.bubbles) {
      b.y -= b.rise * dt;
      b.ph += dt * 1.3;
      b.x += Math.sin(b.ph) * 12.0 * dt;
      if (b.y < -12.0) this.respawn(b);
      const sx = b.x + px;
      const sy = b.y + py;
      b.glow.position.set(sx, sy);
      b.ring.position.set(sx, sy);
      b.ring.tint = this.rimHex[Math.trunc(clamp(b.y * band, 0, RIM_BANDS - 1))]!;
    }
  }

  // -------------------------------------------------------------------
  // build helpers
  // -------------------------------------------------------------------

  /** Seven overlapping blooms across the floor of the trench. */
  private buildDeepBloom(): void {
    const { w, h } = this;
    const div = 4;
    const colour = this.shade(this.theme.accent2, 0.07);
    const canvas = this.softLayer(div, (ctx) => {
      for (let i = 0; i < 7; i++) {
        paintRadial(
          ctx,
          (MARGIN + (w * (i + 0.5)) / 7.0) / div,
          (MARGIN + this.rng.uniform(-h * 0.1, h * 0.5)) / div,
          (h * 0.42) / div,
          colour,
          1.0,
          8,
        );
      }
    });
    this.addLayer(canvas, 0.1);
  }

  /**
   * Five light shafts. Each is built at quarter height and stretched, so the
   * vertical smear is free; the wedge is narrow and bright at the top, wide
   * and dim at the bottom.
   */
  private buildRays(): void {
    const { w, h } = this;
    const rh = Math.max(8, Math.floor(h / 4));
    for (let i = 0; i < RAYS; i++) {
      const rw = Math.trunc(this.rng.uniform(w * 0.06, w * 0.14));
      const small = createCanvas(rw * 2, rh);
      const sctx = context2d(small);
      clearToBlack(sctx, small.width, small.height);
      sctx.globalCompositeOperation = "source-over";
      for (let yy = 0; yy < rh; yy += 2) {
        const f = Math.pow(1.0 - yy / rh, 1.6);
        const half = rw * (0.35 + (0.65 * yy) / rh);
        sctx.fillStyle = cssRgb(this.shade(this.theme.accent2, 0.09 * f));
        sctx.fillRect(Math.trunc(rw - half), yy, Math.trunc(half * 2), 2);
      }

      const big = createCanvas(rw * 2, h);
      const bctx = context2d(big);
      clearToBlack(bctx, big.width, big.height);
      bctx.imageSmoothingEnabled = true;
      bctx.imageSmoothingQuality = "high";
      bctx.drawImage(small as CanvasImageSource, 0, 0, rw * 2, h);

      const sprite = new Sprite(this.own(canvasTexture(big)));
      sprite.anchor.set(0.5, 0);
      sprite.blendMode = "add";
      sprite.position.set(0, 0);
      this.addSprite(sprite);
      this.rays.push({
        sprite,
        x0: this.rng.uniform(0, w),
        speed: this.rng.uniform(0.12, 0.3),
        ph: this.rng.uniform(0, TAU),
      });
    }
  }

  /**
   * Python's `_soft_layer` / `_soft_finish`: stamp into a quarter-size scratch
   * and blow it back up, so the bilinear upscale does the blurring for free.
   */
  private softLayer(div: number, paint: (ctx: CanvasRenderingContext2D) => void): Canvas2D {
    const small = createCanvas(
      Math.max(4, Math.floor((this.w + MARGIN * 2) / div)),
      Math.max(4, Math.floor((this.h + MARGIN * 2) / div)),
    );
    const sctx = context2d(small);
    clearToBlack(sctx, small.width, small.height);
    paint(sctx);

    const { canvas, ctx } = this.newLayerCanvas();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(small as CanvasImageSource, 0, 0, canvas.width, canvas.height);
    return canvas;
  }

  /** A 1 px white ring to tint - pygame's `draw.circle(..., width=1)`. */
  private ringTexture(radius: number): Texture {
    const r = Math.max(1, Math.trunc(radius));
    const hit = this.rings.get(r);
    if (hit) return hit;
    const size = r * 2 + 4;
    const canvas = createCanvas(size, size);
    const ctx = context2d(canvas);
    // Transparent backing, not black: the ring is drawn with normal blend and
    // must only touch its own pixels, as pygame's circle outline does.
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, Math.max(0.5, r - 0.5), 0, TAU);
    ctx.stroke();
    const tex = this.own(canvasTexture(canvas));
    this.rings.set(r, tex);
    return tex;
  }

  private respawn(b: Bubble): void {
    b.x = this.rng.uniform(0, this.w);
    b.y = this.h + 10.0;
    b.rise = this.rng.uniform(14, 46);
    b.r = this.rng.uniform(2.0, 7.0);
    b.ph = this.rng.uniform(0, TAU);
    setGlow(b.glow, Math.trunc(b.r * 2.0), this.theme.accent2, 0.34);
    const tex = this.ringTexture(b.r);
    if (b.ring.texture !== tex) b.ring.texture = tex;
  }
}
