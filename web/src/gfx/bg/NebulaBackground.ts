/**
 * Stage 2 - Deep Nebula (`nebula`).
 *
 * Quarter-resolution cloud banks drifting under three layers of twinkling
 * stars, with 54 dust motes that only catch the light inside the two shafts.
 *
 * Ported from `snake/gfx/background.py::NebulaBackground`; the layer-by-layer
 * specification is in `docs/port/background-framework-1-4.md (section 4)`.
 *
 * The signature is the dust. Each mote's brightness is scaled by how close it
 * stands to one of the two light shafts, so the field only sparkles where the
 * light actually falls - and because the shafts sway, the sparkle sweeps
 * across the field with them.
 */

import type { Graphics, Sprite } from "pixi.js";

import { clamp, TAU } from "../../core/mathx";
import { toHex, type RGB } from "../../core/palette";
import {
  clearToBlack,
  context2d,
  createCanvas,
  cssRgb,
  glowSprite,
  paintRadial,
} from "../textures";
import { Background, MARGIN, type ParallaxLayer } from "./Background";

interface Star {
  x: number;
  y: number;
  /** Side of the square pixel, 1..3 - the layer's index plus one. */
  size: number;
  phase: number;
  amp: number;
}

interface Mote {
  x: number;
  y: number;
  vx: number;
  vy: number;
  phase: number;
  rate: number;
  radius: number;
}

export class NebulaBackground extends Background {
  /** Horizontal drift of each star layer, px/s. */
  private static readonly LAYER_SPEEDS = [6.0, 14.0, 30.0] as const;
  private static readonly LAYER_DEPTHS = [0.2, 0.45, 0.8] as const;
  private static readonly MOTES = 54;

  private cloudFar!: ParallaxLayer;
  private cloudNear!: ParallaxLayer;
  private shaftLayer!: ParallaxLayer;
  private starGfx!: Graphics;

  /** Arena-local x of the two light shafts, before the sway. */
  private shaftX: readonly [number, number] = [0, 0];
  private starCol: RGB = [255, 255, 255];
  private moteCol: RGB = [255, 255, 255];

  private readonly stars: Star[][] = [];
  private readonly brightPhase: number[] = [];
  private readonly brightX: number[] = [];
  private readonly brightY: number[] = [];
  private readonly brightSprites: Sprite[] = [];
  private readonly motes: Mote[] = [];
  private readonly moteSprites: Sprite[] = [];

  protected override build(): void {
    const th = this.theme;
    const w = this.w;
    const h = this.h;

    const tints: readonly RGB[] = [
      th.accent,
      th.accent2,
      th.grid,
      this.mix(th.accent, th.accent2, 0.5),
    ];
    this.cloudFar = this.clouds(16, h * 0.26, h * 0.55, tints, 0.1, 0.15);
    this.cloudNear = this.clouds(20, h * 0.1, h * 0.3, tints, 0.15, 0.35);

    // -- light shafts (depth 0.5) ----------------------------------------
    // Two soft wedges, pre-rendered once and swayed as a unit. Rows are three
    // pixels tall because that is the step pygame's fill loop uses; the shafts
    // never overlap, so overwriting is the same as adding here.
    const shafts = this.newLayerCanvas();
    const shctx = shafts.ctx;
    shctx.globalCompositeOperation = "source-over";
    this.shaftX = [w * 0.32, w * 0.71];
    for (const sx of this.shaftX) {
      for (let yy = 0; yy < h + 2 * MARGIN; yy += 3) {
        const v = clamp((yy - MARGIN) / h, 0, 1);
        const f = (1 - v) ** 1.5;
        const half = w * (0.035 + 0.075 * v);
        shctx.fillStyle = cssRgb(this.shade(th.accent2, 0.055 * f));
        shctx.fillRect(Math.trunc(MARGIN + sx - half), yy, Math.trunc(half * 2), 3);
      }
    }
    this.shaftLayer = this.addLayer(shafts.canvas, 0.5);

    // -- stars (per frame, normal blend) ---------------------------------
    for (let li = 0; li < 3; li++) {
      const layer: Star[] = [];
      for (let i = 0; i < 96 - li * 16; i++) {
        layer.push({
          x: this.rng.uniform(0, w),
          y: this.rng.uniform(0, h),
          size: 1 + li,
          phase: this.rng.uniform(0, TAU),
          amp: this.rng.uniform(0.45, 1.0),
        });
      }
      this.stars.push(layer);
    }
    this.starCol = this.mix(th.text, th.accent2, 0.25);
    this.starGfx = this.addGraphics();

    // -- bright stars (9, additive) --------------------------------------
    for (let i = 0; i < 9; i++) {
      const x = this.rng.uniform(0, w);
      const y = this.rng.uniform(0, h);
      const r = this.rng.uniform(5, 11);
      const ph = this.rng.uniform(0, TAU);
      this.brightX.push(x);
      this.brightY.push(y);
      this.brightPhase.push(ph);
      // Radius never animates, so the texture is picked once and only alpha
      // and position move afterwards.
      this.brightSprites.push(this.addSprite(glowSprite(Math.trunc(r), th.accent2, 0.8)));
    }

    // -- dust motes (54, additive) ---------------------------------------
    for (let i = 0; i < NebulaBackground.MOTES; i++) {
      this.motes.push({
        x: this.rng.uniform(0, w),
        y: this.rng.uniform(0, h),
        vx: this.rng.uniform(-9.0, 9.0),
        vy: this.rng.uniform(-16.0, -4.0),
        phase: this.rng.uniform(0, TAU),
        rate: this.rng.uniform(0.5, 1.6),
        radius: this.rng.randint(2, 5),
      });
    }
    this.moteCol = this.mix(th.text, th.accent, 0.35);
    for (const m of this.motes) {
      this.moteSprites.push(this.addSprite(glowSprite(m.radius, this.moteCol, 0)));
    }
  }

  /** A cloud bank that tiles horizontally, so it can drift forever. */
  private clouds(
    count: number,
    rmin: number,
    rmax: number,
    tints: readonly RGB[],
    amp: number,
    depth: number,
  ): ParallaxLayer {
    // Quarter scale: a sixteenth of the pixels to stamp, and the upscale at the
    // end is the blur that turns a pile of discs into cloud.
    const div = 4;
    const sw = Math.max(4, Math.floor(this.w / div));
    const sh = Math.max(4, Math.floor((this.h + 2 * MARGIN) / div));
    const small = createCanvas(sw, sh);
    const sctx = context2d(small);
    clearToBlack(sctx, sw, sh);

    for (let i = 0; i < count; i++) {
      const r = this.rng.uniform(rmin, rmax) / div;
      const col = this.shade(
        tints[this.rng.randrange(tints.length)]!,
        this.rng.uniform(amp * 0.5, amp),
      );
      const x = this.rng.uniform(0, sw);
      const y = (MARGIN + this.rng.uniform(-this.h * 0.1, this.h * 1.1)) / div;
      paintRadial(sctx, x, y, r, col, 1.0, 10);
      // A blob straddling the wrap has to be stamped on both sides of it.
      if (x < r) paintRadial(sctx, x + sw, y, r, col, 1.0, 10);
      else if (x > sw - r) paintRadial(sctx, x - sw, y, r, col, 1.0, 10);
    }

    const strip = this.newStripCanvas(this.w);
    strip.ctx.globalCompositeOperation = "source-over";
    strip.ctx.imageSmoothingEnabled = true;
    strip.ctx.imageSmoothingQuality = "high";
    strip.ctx.drawImage(small as CanvasImageSource, 0, 0, this.w, this.h + 2 * MARGIN);
    return this.addStrip(strip.canvas, depth);
  }

  protected override animate(dt: number): void {
    const w = this.w;
    const h = this.h;

    this.cloudFar.dx += 2.5 * dt;
    this.cloudNear.dx += 7.0 * dt;

    for (let li = 0; li < 3; li++) {
      const vx = NebulaBackground.LAYER_SPEEDS[li]! * dt;
      for (const s of this.stars[li]!) {
        s.x -= vx;
        if (s.x < 0) {
          s.x += w;
          s.y = this.rng.uniform(0, h);
        }
      }
    }

    for (const m of this.motes) {
      m.x += m.vx * dt + Math.sin(m.phase) * 9.0 * dt;
      m.y += m.vy * dt;
      m.phase += m.rate * dt;
      if (m.y < -20) {
        m.y = h + 20;
        m.x = this.rng.uniform(0, w);
      }
      if (m.x < -20) m.x = w + 18;
      else if (m.x > w + 20) m.x = -18;
    }

    const sway = Math.sin(this.t * 0.13) * w * 0.02;
    this.shaftLayer.dx = sway;

    // Stars: one Graphics rebuilt per frame. These are normal blend on
    // purpose - a star at the bottom of its twinkle paints a *dark* square
    // over the clouds, which is what the pygame `fill` did.
    const g = this.starGfx;
    g.clear();
    for (let li = 0; li < 3; li++) {
      const [px, py] = this.par(NebulaBackground.LAYER_DEPTHS[li]!);
      const ix = Math.trunc(px);
      const iy = Math.trunc(py);
      for (const s of this.stars[li]!) {
        const tw = 0.55 + 0.45 * Math.sin(this.t * 2.3 + s.phase);
        g.rect(Math.trunc(s.x) + ix, Math.trunc(s.y) + iy, s.size, s.size).fill({
          color: toHex(this.shade(this.starCol, s.amp * tw)),
        });
      }
    }

    const [bx, by] = this.par(0.55);
    for (let i = 0; i < this.brightSprites.length; i++) {
      const k = 0.6 + 0.4 * Math.sin(this.t * 1.3 + this.brightPhase[i]!);
      const sprite = this.brightSprites[i]!;
      sprite.position.set(
        Math.trunc(this.brightX[i]! + bx),
        Math.trunc(this.brightY[i]! + by),
      );
      sprite.alpha = 0.55 * k + 0.25;
    }

    // Dust: only the motes standing in a shaft actually catch the light.
    const [mx, my] = this.par(0.95);
    const s0 = this.shaftX[0] + sway;
    const s1 = this.shaftX[1] + sway;
    const reach = w * 0.13;
    for (let i = 0; i < this.motes.length; i++) {
      const m = this.motes[i]!;
      const lit = clamp(1 - Math.min(Math.abs(m.x - s0), Math.abs(m.x - s1)) / reach, 0, 1);
      const k = (0.16 + 0.62 * lit) * (0.6 + 0.4 * Math.sin(this.t * 2.6 + m.phase));
      const sprite = this.moteSprites[i]!;
      sprite.position.set(Math.trunc(m.x + mx), Math.trunc(m.y + my));
      sprite.alpha = k;
    }
  }
}
