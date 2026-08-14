/**
 * Stage 4 - Solar Flare (`lava`).
 *
 * Molten cracks glowing under a field of rising embers, with a heat haze band
 * that climbs the arena refracting everything behind it.
 *
 * Ported from `snake/gfx/background.py::LavaBackground`; the layer-by-layer
 * specification is in `docs/port/background-framework-1-4.md (section 6)`.
 *
 * The signature is the haze. Python copies a band out of the finished frame
 * and re-blits it in four-pixel slices with a sinusoidal offset, so it really
 * does refract the cracks behind it. Here that is a filter on `frame`, which is
 * the gradient plus the stage layers and nothing else - the vignette multiplies
 * after the haze, and the snake is drawn over the top of both.
 */

import { Rectangle, type Sprite } from "pixi.js";

import { clamp, TAU } from "../../core/mathx";
import type { RGB } from "../../core/palette";
import {
  clearToBlack,
  context2d,
  createCanvas,
  cssRgb,
  glowSprite,
  paintRadial,
  seamlessTexture,
  setGlow,
} from "../textures";
import { Background, MARGIN, type ParallaxLayer } from "./Background";
import { HeatHazeFilter } from "./lavaHaze";

interface Ember {
  x: number;
  y: number;
  /** Rise speed, px/s. */
  rise: number;
  radius: number;
  phase: number;
  colour: number;
}

export class LavaBackground extends Background {
  private static readonly EMBERS = 78;
  /** Tallest the haze band is ever allowed to be, px. */
  private static readonly HAZE_H = 132;
  /** Period of the shimmer tile, px. */
  private static readonly TILE = 256;

  private shimmer!: ParallaxLayer;
  private sweep!: Sprite;

  private readonly embers: Ember[] = [];
  private readonly emberSprites: Sprite[] = [];
  private emberCols: readonly RGB[] = [];

  private haze: HeatHazeFilter | null = null;
  private hazeH = 0;
  private hazeY = 0;

  protected override build(): void {
    const th = this.theme;
    const w = this.w;
    const h = this.h;
    const m = MARGIN;

    // -- molten floor ("deep", depth 0.12) --------------------------------
    // Quarter scale: the upscale at the end is the blur, and these blobs are
    // nothing but low-frequency ramp anyway.
    const div = 4;
    const sw = Math.max(4, Math.floor((w + 2 * m) / div));
    const sh = Math.max(4, Math.floor((h + 2 * m) / div));
    const small = createCanvas(sw, sh);
    const sctx = context2d(small);
    clearToBlack(sctx, sw, sh);
    const deepCol = this.shade(th.accent, 0.16);
    for (let i = 0; i < 8; i++) {
      // Centres sit below the arena floor, so only the top of each dome shows.
      const x = (m + (w * (i + 0.5)) / 8.0 + this.rng.uniform(-40, 40)) / div;
      const y = (m + h + h * 0.06) / div;
      paintRadial(sctx, x, y, (h * 0.38) / div, deepCol, 1.0, 8);
    }
    const deep = this.newLayerCanvas();
    deep.ctx.globalCompositeOperation = "source-over";
    deep.ctx.imageSmoothingEnabled = true;
    deep.ctx.imageSmoothingQuality = "high";
    deep.ctx.drawImage(small as CanvasImageSource, 0, 0, w + 2 * m, h + 2 * m);
    this.addLayer(deep.canvas, 0.12);

    // -- cracks (depth 0.55) ----------------------------------------------
    // Built here, added below the shimmer, because the random draws have to
    // happen in the Python's order but the shimmer paints underneath.
    const cracks = this.newLayerCanvas();
    const cctx = cracks.ctx;
    cctx.globalCompositeOperation = "source-over";
    cctx.lineCap = "butt";
    cctx.lineJoin = "miter";
    const xs: number[] = [];
    const ys: number[] = [];
    for (let n = 0; n < 24; n++) {
      let x = this.rng.uniform(0, w);
      let y = this.rng.uniform(h * 0.3, h * 1.02);
      const startY = y;
      xs.length = 0;
      ys.length = 0;
      xs.push(Math.trunc(x + m));
      ys.push(Math.trunc(y + m));
      let ang = this.rng.uniform(0, TAU);
      const segs = this.rng.randint(5, 11);
      for (let s = 0; s < segs; s++) {
        ang += this.rng.uniform(-1.1, 1.1);
        const step = this.rng.uniform(24, 62);
        x += Math.cos(ang) * step;
        // Flattened vertically, so the cracks read as running along a floor.
        y += Math.sin(ang) * step * 0.55;
        xs.push(Math.trunc(x + m));
        ys.push(Math.trunc(y + m));
      }
      const depth = clamp(startY / h, 0, 1);
      const glow = this.shade(this.mix(th.hazard, th.accent, 0.4), 0.4 + 0.6 * depth);
      // Three passes wide -> narrow fake a bloom without a blur filter.
      strokePolyline(cctx, xs, ys, this.shade(glow, 0.14), 17);
      strokePolyline(cctx, xs, ys, this.shade(glow, 0.38), 8);
      strokePolyline(cctx, xs, ys, this.mix(glow, th.text, 0.35), 3);
    }

    // -- heat shimmer (depth 0.35) ----------------------------------------
    const hot = this.mix(th.accent, th.hazard, 0.4);
    const band = (_u: number, v: number): RGB => {
      const k = (0.5 + 0.5 * Math.sin(v * TAU * 3.0)) ** 3;
      return this.shade(hot, 0.1 * k);
    };
    this.shimmer = this.addTile(seamlessTexture(LavaBackground.TILE, 32, band), 0.35);

    this.addLayer(cracks.canvas, 0.55);

    // -- crack sweep -------------------------------------------------------
    // A slow swell of brightness riding along the crack field. No parallax:
    // the Python stamps it at raw arena coordinates.
    this.sweep = this.addSprite(glowSprite(Math.trunc(w * 0.22), th.accent, 0.3));

    // -- embers (78, depth 0.95) ------------------------------------------
    for (let i = 0; i < LavaBackground.EMBERS; i++) {
      const e: Ember = { x: 0, y: 0, rise: 0, radius: 0, phase: 0, colour: 0 };
      this.rollEmber(e, this.rng.uniform(0, h));
      this.embers.push(e);
    }
    this.emberCols = [th.accent, this.mix(th.accent, th.hazard, 0.6), th.hazard];
    for (const e of this.embers) {
      this.emberSprites.push(
        this.addSprite(glowSprite(Math.trunc(e.radius * 3), this.emberCols[e.colour]!, 0)),
      );
    }

    // -- heat haze (the signature) -----------------------------------------
    this.hazeH = Math.trunc(Math.min(LavaBackground.HAZE_H, Math.max(24, h * 0.24)));
    this.hazeY = h;
    this.haze = new HeatHazeFilter(w, h);
    // The shader maps its 0..1 region onto the arena, so the filtered region
    // has to be the arena and nothing more.
    this.frame.filterArea = new Rectangle(0, 0, w, h);
    this.frame.filters = [this.haze];
  }

  /**
   * Drop the haze pass before the tree goes. The base class destroys `frame`
   * but knows nothing about the filter hanging off it, and a background is
   * rebuilt whenever the viewport changes shape.
   */
  override destroy(): void {
    if (this.haze) {
      this.frame.filters = [];
      this.haze.destroy();
      this.haze = null;
    }
    super.destroy();
  }

  /**
   * Re-deal an ember. `y` is the spawn height; omitted means "just below the
   * arena floor", which is where a recycled ember comes back.
   */
  private rollEmber(e: Ember, y?: number): void {
    e.x = this.rng.uniform(0, this.w);
    e.y = y === undefined ? this.h + 8.0 : y;
    e.rise = this.rng.uniform(22, 74);
    e.radius = this.rng.uniform(2.5, 6.5);
    e.phase = this.rng.uniform(0, TAU);
    e.colour = this.rng.randrange(3);
  }

  protected override animate(dt: number): void {
    const h = this.h;

    this.shimmer.dy = (this.shimmer.dy + 26.0 * dt) % LavaBackground.TILE;

    this.hazeY -= 34.0 * dt;
    if (this.hazeY < -this.hazeH) this.hazeY = h;

    for (let i = 0; i < this.embers.length; i++) {
      const e = this.embers[i]!;
      e.y -= e.rise * dt;
      e.phase += dt * 1.7;
      e.x += Math.sin(e.phase) * 16.0 * dt;
      if (e.y < -10) {
        this.rollEmber(e);
        setGlow(
          this.emberSprites[i]!,
          Math.trunc(e.radius * 3),
          this.emberCols[e.colour]!,
          0,
        );
      }
    }

    const wave = (this.t * 0.35) % 1.0;
    this.sweep.position.set(Math.trunc(wave * this.w), Math.trunc(h * 0.86));

    const [px, py] = this.par(0.95);
    for (let i = 0; i < this.embers.length; i++) {
      const e = this.embers[i]!;
      const k = 0.55 + 0.45 * Math.sin(e.phase * 2.0);
      const sprite = this.emberSprites[i]!;
      sprite.position.set(Math.trunc(e.x + px), Math.trunc(e.y + py));
      sprite.alpha = 0.7 * k;
    }

    // Refract a band of everything painted so far. Below twelve rows the
    // Python skips the pass entirely, so the filter switches itself off.
    const haze = this.haze;
    if (haze) {
      const top = Math.trunc(Math.max(0, this.hazeY));
      const bot = Math.trunc(Math.min(h, this.hazeY + this.hazeH));
      if (bot - top < 12) {
        haze.enabled = false;
      } else {
        haze.enabled = true;
        haze.setBand(top, bot, this.hazeY, this.hazeH, this.t);
      }
    }
  }
}

/** A pygame `draw.lines` pass: butt caps, mitred joints, hard overwrite. */
function strokePolyline(
  ctx: CanvasRenderingContext2D,
  xs: readonly number[],
  ys: readonly number[],
  col: RGB,
  width: number,
): void {
  if (xs.length < 2) return;
  ctx.strokeStyle = cssRgb(col);
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(xs[0]!, ys[0]!);
  for (let i = 1; i < xs.length; i++) ctx.lineTo(xs[i]!, ys[i]!);
  ctx.stroke();
}
