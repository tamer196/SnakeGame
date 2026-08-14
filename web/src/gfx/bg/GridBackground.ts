/**
 * Stage 1 - Neon Grid (`grid`).
 *
 * A retro sun behind a scrolling perspective lattice: rungs rush out of the
 * horizon glow, two ridge lines parallax past, and a fan of ground lines
 * converges on the vanishing point.
 *
 * Ported from `snake/gfx/background.py::GridBackground`; the layer-by-layer
 * specification is in `docs/port/background-framework-1-4.md (section 3)`.
 *
 * The signature is that the horizon genuinely scrolls. A rung sits at
 * `y = horizon + span / z` with `z` marching toward zero, which is real
 * perspective rather than an eased spacing table: the gaps stretch as a rung
 * approaches, and the two ridges sliding past each other at 1:3.4 is what
 * tells the eye how far away they are.
 */

import type { Graphics } from "pixi.js";

import { clamp } from "../../core/mathx";
import { toHex, type RGB } from "../../core/palette";
import { cssRgb, paintRadial } from "../textures";
import { Background, MARGIN, type ParallaxLayer } from "./Background";

export class GridBackground extends Background {
  /** Rungs in one perspective cycle. */
  private static readonly ROWS = 22;
  /** Rows per second the lattice marches toward the viewer. */
  private static readonly SCROLL = 0.62;

  private horizon = 0;
  private span = 0;
  private lineHot: RGB = [255, 255, 255];

  private ridgeFar!: ParallaxLayer;
  private ridgeNear!: ParallaxLayer;
  private rungs!: Graphics;
  /** Phase of the swell that rides one rung at a time, 0..1. */
  private sweep = 0;

  protected override build(): void {
    const th = this.theme;
    const w = this.w;
    const h = this.h;
    const m = MARGIN;

    this.horizon = h * 0.32;
    this.span = h - this.horizon;
    this.lineHot = this.mix(th.grid, th.accent, 0.55);

    // -- sky (depth 0.12) ------------------------------------------------
    const sky = this.newLayerCanvas();
    const sctx = sky.ctx;
    paintRadial(
      sctx,
      m + w * 0.5,
      m + this.horizon,
      w * 0.42,
      this.shade(th.accent, 0.42),
      0.85,
      12,
    );
    paintRadial(
      sctx,
      m + w * 0.5,
      m + this.horizon - h * 0.06,
      h * 0.2,
      this.shade(th.accent2, 0.55),
      0.7,
      12,
    );

    // Retro sun slats. pygame's thick horizontal line is exactly a rect, and
    // painting it as one keeps the band on three crisp rows instead of letting
    // canvas antialiasing smear a half-pixel edge across four.
    sctx.globalCompositeOperation = "source-over";
    for (let i = 0; i < 7; i++) {
      const y = m + this.horizon - h * 0.055 - i * (h * 0.017);
      const half = Math.sqrt(Math.max(0, 1 - (i / 7) ** 2)) * h * 0.15;
      sctx.fillStyle = cssRgb(this.shade(th.accent2, 0.9 - i * 0.09));
      sctx.fillRect(m + w * 0.5 - half, y - 1, half * 2, 3);
    }

    // 150 static stars. These overwrite the glow beneath them - pygame's
    // `fill` is not additive - so a dim star darkens the sun it sits on.
    for (let i = 0; i < 150; i++) {
      const sx = this.rng.uniform(0, w);
      const sy = this.rng.uniform(0, this.horizon - 4);
      const f = this.rng.uniform(0.25, 1) * Math.sqrt(1 - sy / Math.max(1, this.horizon));
      sctx.fillStyle = cssRgb(this.shade(th.text, 0.55 * f));
      sctx.fillRect(Math.trunc(m + sx), Math.trunc(m + sy), 1, 1);
    }
    this.addLayer(sky.canvas, 0.12);

    // -- ridges (depth 0.30 / 0.55) --------------------------------------
    this.ridgeFar = this.ridge(h * 0.16, this.mix(th.grid, th.accent2, 0.45), 26, 0.55, 0.3);
    this.ridgeNear = this.ridge(h * 0.1, this.mix(th.grid, th.accent, 0.6), 17, 0.95, 0.55);

    // -- ground fan (depth 0.85) -----------------------------------------
    const fan = this.newLayerCanvas();
    const fctx = fan.ctx;
    fctx.globalCompositeOperation = "source-over";
    fctx.lineCap = "butt";
    fctx.lineJoin = "miter";
    const cx = m + w * 0.5;
    for (let k = -26; k <= 26; k++) {
      // The outer spokes land two arena widths off the edge; the rect mask eats
      // them, exactly as pygame's surface bounds did.
      const bx = cx + k * (w / 13);
      const f = clamp(1 - Math.abs(k) / 26, 0.1, 1);
      // 0.55 + 1.05 * f runs past 1, so `shade` saturates the middle spokes
      // toward white on purpose.
      fctx.strokeStyle = cssRgb(this.shade(th.grid, 0.55 + 1.05 * f));
      fctx.lineWidth = Math.abs(k) <= 7 ? 2 : 1;
      fctx.beginPath();
      fctx.moveTo(cx, m + this.horizon);
      fctx.lineTo(bx, m + h);
      fctx.stroke();
    }
    this.addLayer(fan.canvas, 0.85);

    // -- rungs + horizon sliver (per frame, normal blend) ----------------
    this.rungs = this.addGraphics();
  }

  /** One wrapping ridge line: a lit slope with a hot edge along the top. */
  private ridge(
    band: number,
    col: RGB,
    seg: number,
    glow: number,
    depth: number,
  ): ParallaxLayer {
    const { canvas, ctx } = this.newStripCanvas(this.w);
    const n = Math.max(4, Math.trunc(seg));

    const ys: number[] = [];
    for (let i = 0; i < n; i++) ys.push(this.rng.uniform(band * 0.25, band));
    // Last sample repeats the first so the strip meets itself at the wrap.
    ys[n - 1] = ys[0]!;

    const px: number[] = [];
    const py: number[] = [];
    for (let i = 0; i < n; i++) {
      px.push(Math.trunc((this.w * i) / (n - 1)));
      py.push(Math.trunc(MARGIN + this.horizon - ys[i]!));
    }
    const foot = Math.trunc(MARGIN + this.horizon + 4);

    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = cssRgb(this.shade(col, glow * 0.16));
    ctx.beginPath();
    ctx.moveTo(px[0]!, py[0]!);
    for (let i = 1; i < n; i++) ctx.lineTo(px[i]!, py[i]!);
    ctx.lineTo(this.w, foot);
    ctx.lineTo(0, foot);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = cssRgb(this.shade(col, glow));
    ctx.lineWidth = 2;
    ctx.lineCap = "butt";
    ctx.lineJoin = "miter";
    ctx.beginPath();
    ctx.moveTo(px[0]!, py[0]!);
    for (let i = 1; i < n; i++) ctx.lineTo(px[i]!, py[i]!);
    ctx.stroke();

    return this.addStrip(canvas, depth);
  }

  protected override animate(dt: number): void {
    this.ridgeFar.dx -= 5.0 * dt;
    this.ridgeNear.dx -= 17.0 * dt;
    this.sweep = (this.sweep + dt * 0.21) % 1.0;

    const g = this.rungs;
    g.clear();

    // Only the vertical half of the parallax reaches the rungs; the Python
    // discards the horizontal component, and a rung spans the arena anyway.
    const py = this.par(0.85)[1];
    const phase = (this.t * GridBackground.SCROLL) % 1.0;
    const hot = this.sweep * GridBackground.ROWS;
    for (let i = 1; i <= GridBackground.ROWS; i++) {
      const z = i - phase;
      if (z <= 0.08) continue;
      const y = this.horizon + this.span / z + py;
      if (y > this.h + 6) continue;
      let f = clamp(1.0 / (0.5 + z * 0.44), 0, 1);
      f = clamp(f + 0.5 * Math.max(0, 1 - Math.abs(z - hot) * 0.9), 0, 1);
      const width = f > 0.55 ? 2 : 1;
      g.rect(0, y - width * 0.5, this.w, width).fill({
        color: toHex(this.mix(this.bgAt(y), this.lineHot, f)),
      });
    }

    // A breathing sliver of light sitting exactly on the horizon.
    const beat = 0.55 + 0.45 * Math.sin(this.t * 1.7);
    const hy = this.horizon + this.par(0.3)[1];
    g.rect(0, hy - 1, this.w, 2).fill({
      color: toHex(this.mix(this.theme.accent, this.theme.text, 0.35 * beat)),
    });
  }
}
