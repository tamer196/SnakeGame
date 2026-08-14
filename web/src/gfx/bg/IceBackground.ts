/**
 * Stage 7 - Frozen Vault (`ice`).
 *
 * Cold enough that the air has stopped moving.
 *
 * Ported from `snake/gfx/background.py::IceBackground`; the layer-by-layer
 * specification is in `docs/port/background-5-8.md`.
 *
 * Five passes: a cold haze, a scrolling sheet of hairline cracks, a rim light
 * built from concentric rectangles, the frost, and twenty-six tumbling
 * crystals at three depths.
 *
 * The frost is the signature and the trick is that it is not a simulation.
 * Every branch is grown once at build time and the whole list is sorted by how
 * far its root sits from the nearest wall, so drawing the first N segments *is*
 * frost that has crept N pixels inward from all four edges at once. Here each
 * segment is its own hairline sprite: revealing more of them costs a `visible`
 * flag, and the breathing colour is one tint on their shared parent.
 */

import { Container, Sprite, type Texture } from "pixi.js";

import { TAU } from "../../core/mathx";
import { clamp8, type RGB } from "../../core/palette";
import {
  canvasTexture,
  clearToBlack,
  context2d,
  createCanvas,
  cssRgb,
  glowSprite,
  paintRadial,
  whiteTexture,
  type Canvas2D,
} from "../textures";
import { Background, MARGIN, type ParallaxLayer } from "./Background";

const CRACKS = 30;
const FROST_SEEDS = 52;
const CRYSTALS = 26;
/** Hexagon radii, smallest (furthest) first. */
const CRYSTAL_SIZES = [7, 11, 16] as const;
/** Note the largest crystals sit at depth > 1: nearer than the near plane. */
const CRYSTAL_DEPTH = [0.7, 0.9, 1.15] as const;
/** Rotation steps a crystal snaps to - a pygame cost trick, kept for the look. */
const SPIN_STEPS = 24;

interface Segment {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  /** Distance of the start point from the nearest wall - the sort key. */
  wall: number;
}

export class IceBackground extends Background {
  // Every field is `declare`d and assigned in `build`. The base class calls
  // `build()` from its constructor, and JS class fields are defined *after*
  // `super()` returns - so a plain initialiser here would silently wipe
  // whatever the build had already produced.
  private declare sheet: ParallaxLayer;
  private declare sheetX: number;

  private declare frost: Container;
  private declare frostSprites: Sprite[];
  private declare frostCol: RGB;
  private declare frostShown: number;

  private declare crystals: Sprite[];
  private declare crystalGlows: Sprite[];
  private declare cx: Float64Array;
  private declare cy: Float64Array;
  private declare cvx: Float64Array;
  private declare cvy: Float64Array;
  private declare cang: Float64Array;
  private declare cspin: Float64Array;
  private declare csize: Int32Array;

  protected override build(): void {
    const { w, h, theme } = this;
    this.sheetX = 0;
    this.frost = new Container();
    this.frostSprites = [];
    this.frostCol = [255, 255, 255];
    this.frostShown = 0;
    this.crystals = [];
    this.crystalGlows = [];
    this.cx = new Float64Array(CRYSTALS);
    this.cy = new Float64Array(CRYSTALS);
    this.cvx = new Float64Array(CRYSTALS);
    this.cvy = new Float64Array(CRYSTALS);
    this.cang = new Float64Array(CRYSTALS);
    this.cspin = new Float64Array(CRYSTALS);
    this.csize = new Int32Array(CRYSTALS);

    this.buildHaze();
    this.buildSheet();
    this.buildRim();

    // -- frost -------------------------------------------------------
    const segments: Segment[] = [];
    for (let i = 0; i < FROST_SEEDS; i++) {
      const side = this.rng.randrange(4);
      if (side === 0) this.grow(segments, this.rng.uniform(0, w), 0, Math.PI * 0.5);
      else if (side === 1) this.grow(segments, this.rng.uniform(0, w), h, -Math.PI * 0.5);
      else if (side === 2) this.grow(segments, 0, this.rng.uniform(0, h), 0);
      else this.grow(segments, w, this.rng.uniform(0, h), Math.PI);
    }
    segments.sort((a, b) => a.wall - b.wall);

    this.frostCol = this.mix(theme.accent, theme.text, 0.5);
    this.layers.addChild(this.frost);
    for (const s of segments) {
      // A unit sprite stretched along the segment: pygame's 1 px `draw.line`,
      // and cheap enough that the reveal is a visibility flag per segment.
      const sprite = new Sprite(whiteTexture());
      sprite.anchor.set(0, 0.5);
      sprite.width = Math.hypot(s.bx - s.ax, s.by - s.ay);
      sprite.height = 1;
      sprite.rotation = Math.atan2(s.by - s.ay, s.bx - s.ax);
      sprite.position.set(s.ax, s.ay);
      sprite.visible = false;
      this.frost.addChild(sprite);
      this.frostSprites.push(sprite);
    }

    this.buildCrystals();
  }

  protected override animate(dt: number): void {
    const { w, h } = this;

    this.sheetX -= 6.0 * dt;
    this.sheet.dx = this.sheetX;

    // One slow breath (~26 s) decides how deep the frost has reached, and the
    // same breath brightens it as it advances.
    const grow = 0.5 + 0.5 * Math.sin(this.t * 0.24);
    const shown = Math.trunc(this.frostSprites.length * (0.35 + 0.65 * grow));
    if (shown > this.frostShown) {
      for (let i = this.frostShown; i < shown; i++) this.frostSprites[i]!.visible = true;
    } else if (shown < this.frostShown) {
      for (let i = shown; i < this.frostShown; i++) this.frostSprites[i]!.visible = false;
    }
    this.frostShown = shown;
    const f = 0.3 + 0.35 * grow;
    // shade() on a white sprite is exactly a tint; packed inline so a frame
    // that only breathes allocates nothing.
    this.frost.tint =
      (clamp8(this.frostCol[0] * f) << 16) |
      (clamp8(this.frostCol[1] * f) << 8) |
      clamp8(this.frostCol[2] * f);
    const [fpx, fpy] = this.par(0.6);
    this.frost.position.set(fpx, fpy);

    const par0 = this.par(CRYSTAL_DEPTH[0]);
    const par1 = this.par(CRYSTAL_DEPTH[1]);
    const par2 = this.par(CRYSTAL_DEPTH[2]);
    for (let i = 0; i < CRYSTALS; i++) {
      let x = this.cx[i]! + this.cvx[i]! * dt;
      let y = this.cy[i]! + this.cvy[i]! * dt;
      const ang = this.cang[i]! + this.cspin[i]! * dt;
      if (y > h + 40) {
        y = -40.0;
        x = this.rng.uniform(0, w);
      }
      if (x < -40) x = w + 30.0;
      else if (x > w + 40) x = -30.0;
      this.cx[i] = x;
      this.cy[i] = y;
      this.cang[i] = ang;

      const si = this.csize[i]!;
      const par = si === 0 ? par0 : si === 1 ? par1 : par2;
      const sx = x + par[0];
      const sy = y + par[1];
      const sprite = this.crystals[i]!;
      sprite.position.set(sx, sy);
      // Python truncates toward zero and then takes a Python modulo, which is
      // never negative; JS needs both halves spelled out.
      const step = ((Math.trunc((ang / TAU) * SPIN_STEPS) % SPIN_STEPS) + SPIN_STEPS) % SPIN_STEPS;
      sprite.rotation = (step * TAU) / SPIN_STEPS;
      this.crystalGlows[i]!.position.set(sx, sy);
    }
  }

  // -------------------------------------------------------------------
  // build helpers
  // -------------------------------------------------------------------

  /** Nine wide, very faint blooms - the air itself, lit. */
  private buildHaze(): void {
    const { w, h } = this;
    const div = 4;
    const colour = this.shade(this.theme.accent, 0.055);
    const canvas = this.softLayer(div, (ctx) => {
      for (let i = 0; i < 9; i++) {
        paintRadial(
          ctx,
          (MARGIN + this.rng.uniform(0, w)) / div,
          (MARGIN + this.rng.uniform(0, h)) / div,
          (h * this.rng.uniform(0.22, 0.45)) / div,
          colour,
          1.0,
          8,
        );
      }
    });
    this.addLayer(canvas, 0.12);
  }

  /**
   * Hairline cracks on a strip that wraps at the arena width. A crack running
   * past the right edge is clipped rather than wrapped, so the seam can show a
   * discontinuity - it scrolls past once every ~3.5 minutes, and Python has the
   * same break.
   */
  private buildSheet(): void {
    const { w, h } = this;
    const { canvas, ctx, m } = this.newStripCanvas(w);
    ctx.globalCompositeOperation = "source-over";
    ctx.strokeStyle = cssRgb(this.shade(this.mix(this.theme.accent, this.theme.text, 0.3), 0.22));
    ctx.lineWidth = 1;
    for (let i = 0; i < CRACKS; i++) {
      let x = this.rng.uniform(0, w);
      let y = this.rng.uniform(0, h);
      let ang = this.rng.uniform(0, TAU);
      ctx.beginPath();
      // Half-pixel centres keep a 1 px stroke on one row of pixels instead of
      // spreading it across two, which is what pygame's aliased line does.
      ctx.moveTo(Math.trunc(x) + 0.5, Math.trunc(y + m) + 0.5);
      const steps = this.rng.randint(3, 6);
      for (let k = 0; k < steps; k++) {
        ang += this.rng.uniform(-0.7, 0.7);
        const d = this.rng.uniform(30, 90);
        x += Math.cos(ang) * d;
        y += Math.sin(ang) * d;
        ctx.lineTo(Math.trunc(x) + 0.5, Math.trunc(y + m) + 0.5);
      }
      ctx.stroke();
    }
    this.sheet = this.addStrip(canvas, 0.35);
  }

  /** Nine concentric rectangles, brightest innermost: the vault's cold edge. */
  private buildRim(): void {
    const { w, h } = this;
    const { canvas, ctx, m } = this.newLayerCanvas();
    ctx.globalCompositeOperation = "source-over";
    ctx.lineWidth = 4;
    for (let i = 0; i < 9; i++) {
      const f = (i + 1) / 9.0;
      ctx.strokeStyle = cssRgb(this.shade(this.theme.accent, 0.05 * f));
      // pygame strokes a rect *inside* its bounds; canvas centres the stroke,
      // hence the half-width inset.
      ctx.strokeRect(m + i * 4 + 2, m + i * 4 + 2, w - i * 8 - 4, h - i * 8 - 4);
    }
    this.addLayer(canvas, 0.5);
  }

  /** One frost twig plus two children - classic recursive branching. */
  private grow(out: Segment[], x: number, y: number, ang: number): void {
    this.growAt(out, x, y, ang, this.rng.uniform(28, 62), 3);
  }

  private growAt(
    out: Segment[],
    x: number,
    y: number,
    ang: number,
    length: number,
    depth: number,
  ): void {
    if (depth <= 0 || length < 5.0) return;
    const ex = x + Math.cos(ang) * length;
    const ey = y + Math.sin(ang) * length;
    out.push({
      ax: x,
      ay: y,
      bx: ex,
      by: ey,
      wall: Math.min(x, this.w - x, y, this.h - y),
    });
    for (const sign of [-1.0, 1.0]) {
      this.growAt(
        out,
        ex,
        ey,
        ang + sign * this.rng.uniform(0.4, 0.9),
        length * this.rng.uniform(0.5, 0.72),
        depth - 1,
      );
    }
  }

  private buildCrystals(): void {
    const { w, h, theme } = this;
    const textures = CRYSTAL_SIZES.map((size) => this.own(this.buildHexagon(size)));

    for (let i = 0; i < CRYSTALS; i++) {
      const si = this.rng.randrange(3);
      this.cx[i] = this.rng.uniform(0, w);
      this.cy[i] = this.rng.uniform(0, h);
      // Bigger crystals move faster: the depth cue that sells the fall.
      this.cvx[i] = this.rng.uniform(-22, 22) * (1.0 + si * 0.4);
      this.cvy[i] = this.rng.uniform(8, 30) * (1.0 + si * 0.4);
      this.cang[i] = this.rng.uniform(0, TAU);
      this.cspin[i] = this.rng.uniform(-1.1, 1.1);
      this.csize[i] = si;

      const sprite = new Sprite(textures[si]!);
      sprite.anchor.set(0.5);
      this.crystals.push(sprite);
      this.addSprite(sprite);

      const glow = glowSprite(14, theme.accent, 0.2);
      this.crystalGlows.push(glow);
      this.addSprite(glow);
    }
  }

  /**
   * One hexagon with a translucent fill, a hot outline and three facet lines.
   *
   * pygame's draw primitives *replace* the pixels they touch, alpha included;
   * canvas blends them. The outline and facets therefore sit slightly brighter
   * over the fill here than in Python - there is no non-blending stroke to
   * reach for, and the difference is a few percent on a 16 px sprite.
   */
  private buildHexagon(size: number): Texture {
    const th = this.theme;
    const d = size * 4;
    const c = size * 2;
    const canvas = createCanvas(d, d);
    const ctx = context2d(canvas);
    ctx.globalCompositeOperation = "source-over";

    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const px = c + Math.cos((TAU * i) / 6) * size;
      const py = c + Math.sin((TAU * i) / 6) * size;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fillStyle = cssRgb(this.mix(th.accent, th.bgTop, 0.55), 110 / 255);
    ctx.fill();
    ctx.strokeStyle = cssRgb(th.accent2, 225 / 255);
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.strokeStyle = cssRgb(th.text, 130 / 255);
    ctx.lineWidth = 1;
    for (let i = 0; i < 3; i++) {
      const a = (TAU * i) / 6;
      ctx.beginPath();
      ctx.moveTo(c - Math.cos(a) * size * 0.9, c - Math.sin(a) * size * 0.9);
      ctx.lineTo(c + Math.cos(a) * size * 0.9, c + Math.sin(a) * size * 0.9);
      ctx.stroke();
    }
    return canvasTexture(canvas);
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
}
