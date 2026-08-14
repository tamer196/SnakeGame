/**
 * Stage 8 - Toxic Bloom (`spores`).
 *
 * The air is thick and it is alive.
 *
 * Ported from `snake/gfx/background.py::SporeBackground`; the layer-by-layer
 * specification is in `docs/port/background-5-8.md`.
 *
 * Four depths: two mist banks drifting right at different rates, a bed of
 * pulsing pods along the arena floor, and fifty-two spores.
 *
 * The signature is the clumping. A spore has no position of its own - it
 * orbits one of eight drifting colony centres on a squashed ellipse and bobs
 * on its own phase. The swarm therefore gathers, thins and gathers again
 * without a single distance test at run time.
 */

import { Sprite, type Texture } from "pixi.js";

import { TAU } from "../../core/mathx";
import {
  canvasTexture,
  clearToBlack,
  context2d,
  createCanvas,
  cssRgb,
  glowSprite,
  paintRadial,
  type Canvas2D,
} from "../textures";
import { Background, MARGIN, type ParallaxLayer } from "./Background";

const COUNT = 52;
const CLUSTERS = 8;
const PODS = 13;
/** Blob sprite radii, smallest first. */
const BLOB_RADII = [5, 8, 12, 17, 23] as const;

interface Pod {
  readonly x: number;
  readonly y: number;
  readonly r: number;
  readonly ph: number;
  readonly glow: Sprite;
}

export class SporeBackground extends Background {
  // Every field is `declare`d and assigned in `build`. The base class calls
  // `build()` from its constructor, and JS class fields are defined *after*
  // `super()` returns - so a plain initialiser here would silently wipe
  // whatever the build had already produced.
  private declare mistFar: ParallaxLayer;
  private declare mistNear: ParallaxLayer;
  private declare mistFarX: number;
  private declare mistNearX: number;

  private declare pods: Pod[];

  private declare clusterX: Float64Array;
  private declare clusterY: Float64Array;
  private declare clusterVx: Float64Array;
  private declare clusterVy: Float64Array;
  private declare clusterPh: Float64Array;

  private declare sporeColony: Int32Array;
  private declare sporeAng: Float64Array;
  private declare sporeOrb: Float64Array;
  private declare sporeRate: Float64Array;
  private declare sporeBob: Float64Array;
  private declare spores: Sprite[];

  protected override build(): void {
    const { w, h, theme } = this;
    this.mistFarX = 0;
    this.mistNearX = 0;
    this.pods = [];
    this.clusterX = new Float64Array(CLUSTERS);
    this.clusterY = new Float64Array(CLUSTERS);
    this.clusterVx = new Float64Array(CLUSTERS);
    this.clusterVy = new Float64Array(CLUSTERS);
    this.clusterPh = new Float64Array(CLUSTERS);
    this.sporeColony = new Int32Array(COUNT);
    this.sporeAng = new Float64Array(COUNT);
    this.sporeOrb = new Float64Array(COUNT);
    this.sporeRate = new Float64Array(COUNT);
    this.sporeBob = new Float64Array(COUNT);
    this.spores = [];

    this.mistFar = this.addStrip(this.buildMist(10, h * 0.24, h * 0.48, 0.1), 0.15);
    this.mistNear = this.addStrip(this.buildMist(14, h * 0.1, h * 0.26, 0.22), 0.4);

    // A bed of half-buried pods along the arena floor: the outlines are baked
    // into one layer, the pulse is a glow sprite per pod.
    const { canvas, ctx, m } = this.newLayerCanvas();
    ctx.globalCompositeOperation = "source-over";
    ctx.strokeStyle = cssRgb(this.shade(theme.grid, 0.9));
    ctx.lineWidth = 2;
    const seeds: Array<[number, number, number, number]> = [];
    for (let i = 0; i < PODS; i++) {
      const x = this.rng.uniform(0, w);
      const y = h - this.rng.uniform(0, h * 0.12);
      const r = this.rng.uniform(10, 26);
      const ph = this.rng.uniform(0, TAU);
      seeds.push([x, y, r, ph]);
      ctx.beginPath();
      // pygame's 2 px circle outline sits inside the radius, so the stroke is
      // centred one pixel in.
      ctx.arc(Math.trunc(m + x), Math.trunc(m + y), Math.max(0.5, Math.trunc(r) - 1), 0, TAU);
      ctx.stroke();
    }
    this.addLayer(canvas, 0.55);

    for (const [x, y, r, ph] of seeds) {
      const glow = glowSprite(Math.trunc(r * 2.2), theme.accent2, 0.22);
      this.pods.push({ x, y, r, ph, glow });
      this.addSprite(glow);
    }

    const blobs = BLOB_RADII.map((r) => this.own(this.buildBlob(r)));

    for (let i = 0; i < CLUSTERS; i++) {
      this.clusterX[i] = this.rng.uniform(0, w);
      this.clusterY[i] = this.rng.uniform(0, h);
      this.clusterVx[i] = this.rng.uniform(-7.0, 7.0);
      // Every colony rises; they are replaced from the bottom as they leave.
      this.clusterVy[i] = this.rng.uniform(-26.0, -9.0);
      this.clusterPh[i] = this.rng.uniform(0, TAU);
    }

    for (let i = 0; i < COUNT; i++) {
      this.sporeColony[i] = this.rng.randrange(CLUSTERS);
      this.sporeAng[i] = this.rng.uniform(0, TAU);
      this.sporeOrb[i] = this.rng.uniform(8.0, 74.0);
      this.sporeRate[i] = this.rng.uniform(-0.9, 0.9);
      const si = this.rng.randrange(BLOB_RADII.length);
      this.sporeBob[i] = this.rng.uniform(0, TAU);
      const sprite = new Sprite(blobs[si]!);
      sprite.anchor.set(0.5);
      sprite.blendMode = "add";
      this.spores.push(sprite);
      this.addSprite(sprite);
    }
  }

  protected override animate(dt: number): void {
    const { w, h } = this;

    this.mistFarX += 2.0 * dt;
    this.mistNearX += 6.5 * dt;
    this.mistFar.dx = this.mistFarX;
    this.mistNear.dx = this.mistNearX;

    const [ppx, ppy] = this.par(0.55);
    for (const pod of this.pods) {
      const k = 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(this.t * 1.1 + pod.ph));
      pod.glow.position.set(pod.x + ppx, pod.y + ppy);
      pod.glow.alpha = 0.22 * k;
    }

    for (let i = 0; i < CLUSTERS; i++) {
      const ph = this.clusterPh[i]! + dt * 0.4;
      let x = this.clusterX[i]! + (this.clusterVx[i]! + Math.sin(ph) * 9.0) * dt;
      let y = this.clusterY[i]! + this.clusterVy[i]! * dt;
      if (y < -70.0) {
        y = h + 70.0;
        x = this.rng.uniform(0, w);
      }
      if (x < -80.0) x = w + 70.0;
      else if (x > w + 80.0) x = -70.0;
      this.clusterPh[i] = ph;
      this.clusterX[i] = x;
      this.clusterY[i] = y;
    }

    const [px, py] = this.par(1.0);
    for (let i = 0; i < COUNT; i++) {
      const ang = this.sporeAng[i]! + this.sporeRate[i]! * dt;
      const bob = this.sporeBob[i]! + dt * 1.1;
      this.sporeAng[i] = ang;
      this.sporeBob[i] = bob;
      const c = this.sporeColony[i]!;
      const orb = this.sporeOrb[i]!;
      this.spores[i]!.position.set(
        this.clusterX[c]! + Math.cos(ang) * orb + px,
        this.clusterY[c]! + Math.sin(ang) * orb * 0.7 + Math.sin(bob) * 7.0 + py,
      );
    }
  }

  // -------------------------------------------------------------------
  // build helpers
  // -------------------------------------------------------------------

  /**
   * A mist bank on a strip that tiles at the arena width, so it can drift
   * forever. Blobs near either edge are stamped twice so the seam carries no
   * hole. Built at quarter scale: the upscale is the blur.
   */
  private buildMist(count: number, rmin: number, rmax: number, amp: number): Canvas2D {
    const div = 4;
    const sw = Math.max(4, Math.floor(this.w / div));
    const small = createCanvas(sw, Math.max(4, Math.floor((this.h + MARGIN * 2) / div)));
    const sctx = context2d(small);
    clearToBlack(sctx, small.width, small.height);

    for (let i = 0; i < count; i++) {
      const r = this.rng.uniform(rmin, rmax) / div;
      const colour = this.shade(this.theme.grid, this.rng.uniform(amp * 0.5, amp));
      const x = this.rng.uniform(0, sw);
      // Weighted low: the mist banks up along the floor of the arena.
      const y = (MARGIN + this.rng.uniform(this.h * 0.2, this.h * 1.05)) / div;
      paintRadial(sctx, x, y, r, colour, 1.0, 8);
      if (x < r) paintRadial(sctx, x + sw, y, r, colour, 1.0, 8);
      else if (x > sw - r) paintRadial(sctx, x - sw, y, r, colour, 1.0, 8);
    }

    const { canvas, ctx } = this.newStripCanvas(this.w);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(small as CanvasImageSource, 0, 0, canvas.width, canvas.height);
    return canvas;
  }

  /** A soft core, a brighter membrane ring and one off-centre highlight. */
  private buildBlob(r: number): Texture {
    const th = this.theme;
    const d = r * 4;
    const canvas = createCanvas(d, d);
    const ctx = context2d(canvas);
    clearToBlack(ctx, d, d);

    paintRadial(ctx, d * 0.5, d * 0.5, r * 1.9, this.shade(th.accent, 0.24), 1.0, 10);

    ctx.globalCompositeOperation = "source-over";
    ctx.strokeStyle = cssRgb(this.shade(th.accent2, 0.38));
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(Math.floor(d / 2), Math.floor(d / 2), Math.max(0.5, r - 1), 0, TAU);
    ctx.stroke();

    ctx.fillStyle = cssRgb(this.shade(th.accent, 0.55));
    ctx.beginPath();
    ctx.arc(
      Math.trunc(d * 0.44),
      Math.trunc(d * 0.42),
      Math.max(1, Math.floor(r / 4)),
      0,
      TAU,
    );
    ctx.fill();

    return canvasTexture(canvas);
  }
}
