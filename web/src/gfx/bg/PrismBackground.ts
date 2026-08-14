/**
 * Stage 12 - Prism Core (`prism`).
 *
 * Everything, refracted.
 *
 * Ported from `snake/gfx/background.py::PrismBackground`; the layer-by-layer
 * specification is in `docs/port/background-9-12.md`.
 *
 * Three depths: a static refraction lattice (0.20) under a rotating wedge fan
 * rendered through a quarter-resolution buffer (fixed to the arena, no
 * parallax), a core glow (0.45), and free-floating shards plus rainbow sparks
 * (0.95). The signature is that every wedge is drawn twice - a body, then a
 * thin leading-edge fringe in a hue shifted +0.10 turns - which reads as
 * chromatic dispersion.
 *
 * The resolution chain is kept deliberately: the fan is drawn at a quarter
 * scale, minified once more to an eighth, and magnified back to the arena. The
 * softness of the beams comes from those two bilinear steps, so they are a
 * design decision rather than the CPU-era budget trick they sat next to.
 * Python's `UPSCALE_EVERY = 4` frame-skip *was* only a budget trick and is
 * dropped: on the GPU the whole path costs one small draw and two blits.
 *
 * This is the heaviest stage in the game, so nothing here allocates per frame:
 * hue maths runs straight to a packed colour, the shard triangle reuses one
 * scratch array, and the spark bank collapses to a single tinted glow texture.
 */

import { Container, Graphics, RenderTexture, Sprite } from "pixi.js";

import { clamp, TAU } from "../../core/mathx";
import { clamp8, toHex } from "../../core/palette";
import { canvasTexture, context2d, createCanvas, cssRgb, paintRadial } from "../textures";
import { Background } from "./Background";

const WEDGES = 12;
/** Low-res divisor for the soft light buffer. */
const DIV = 4;
/** Sparks quantise hue into this many buckets, brightness into five. */
const HUE_BUCKETS = 16;

interface Shard {
  readonly a0: number;
  readonly orbit: number;
  readonly rate: number;
  readonly size: number;
}

interface Spark {
  readonly a0: number;
  readonly orbit: number;
  readonly rate: number;
  readonly phase: number;
  readonly sprite: Sprite;
}

/**
 * `shade(rainbow(h, s, v), f)` straight to a packed colour.
 *
 * `palette.hsv` allocates a triple, and this runs 31 times a frame in the
 * busiest background in the game. The double truncation is faithful: Python
 * quantises to 0..255 inside `rainbow` and again inside `shade`.
 */
function rainbowShadeHex(h: number, s: number, v: number, f: number): number {
  let hh = h % 1.0;
  if (hh < 0) hh += 1.0;
  const i = Math.floor(hh * 6.0);
  const fr = hh * 6.0 - i;
  const p = v * (1.0 - s);
  const q = v * (1.0 - s * fr);
  const w = v * (1.0 - s * (1.0 - fr));
  let r: number;
  let g: number;
  let b: number;
  switch (((i % 6) + 6) % 6) {
    case 0:
      r = v;
      g = w;
      b = p;
      break;
    case 1:
      r = q;
      g = v;
      b = p;
      break;
    case 2:
      r = p;
      g = v;
      b = w;
      break;
    case 3:
      r = p;
      g = q;
      b = v;
      break;
    case 4:
      r = w;
      g = p;
      b = v;
      break;
    default:
      r = v;
      g = p;
      b = q;
      break;
  }
  return (
    (clamp8(clamp8(r * 255) * f) << 16) |
    (clamp8(clamp8(g * 255) * f) << 8) |
    clamp8(clamp8(b * 255) * f)
  );
}

export class PrismBackground extends Background {
  private spin = 0;
  private hue = 0;

  /** Size of the quarter-res fan buffer, and the wedge tip radius in it. */
  private lw = 2;
  private lh = 2;
  private reach = 0;

  private fanRoot!: Container;
  private softRoot!: Container;
  private wedges!: Graphics;
  private rtFan!: RenderTexture;
  private rtSoft!: RenderTexture;

  private core!: Sprite;
  private shardGfx!: Graphics;
  private readonly shards: Shard[] = [];
  private readonly sparks: Spark[] = [];
  private readonly sparkHues: number[] = [];
  /** Reused by the shard triangles so the per-frame path costs no garbage. */
  private readonly tri = [0, 0, 0, 0, 0, 0];

  protected override build(): void {
    const th = this.theme;
    const w = this.w;
    const h = this.h;

    this.lw = Math.max(2, Math.trunc(w / DIV));
    this.lh = Math.max(2, Math.trunc(h / DIV));
    this.reach = Math.hypot(this.lw, this.lh);

    this.buildFan();

    // A static lattice of faint refraction arcs sits under the beams.
    const { canvas, ctx, m } = this.newLayerCanvas();
    const cx = m + Math.trunc(w / 2);
    const cy = m + Math.trunc(h / 2);
    ctx.globalCompositeOperation = "source-over";
    ctx.lineWidth = 1;
    ctx.strokeStyle = cssRgb(this.shade(th.grid, 0.55));
    for (let i = 0; i < 9; i++) {
      ctx.beginPath();
      ctx.arc(cx, cy, Math.trunc(h * (0.16 + i * 0.11)), 0, TAU);
      ctx.stroke();
    }
    // Drawn after the arcs and dimmer, so a spoke *darkens* every arc it
    // crosses. That is pygame overwriting, and it is part of the look.
    ctx.strokeStyle = cssRgb(this.shade(th.grid, 0.35));
    for (let i = 0; i < 12; i++) {
      const a = (TAU * i) / 12;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(a) * w, cy + Math.sin(a) * w);
      ctx.stroke();
    }
    this.addLayer(canvas, 0.2);

    const coreR = Math.trunc(h * 0.28);
    this.core = new Sprite(this.glowTexture(coreR));
    this.core.anchor.set(0.5);
    this.core.blendMode = "add";
    this.core.width = coreR * 2;
    this.core.height = coreR * 2;
    this.core.tint = toHex(th.text);
    this.core.alpha = 0.3;
    this.addSprite(this.core);

    for (let i = 0; i < 7; i++) {
      this.shards.push({
        a0: this.rng.uniform(0, TAU),
        orbit: this.rng.uniform(h * 0.22, h * 0.48),
        rate: this.rng.uniform(0.1, 0.35),
        size: this.rng.uniform(16, 42),
      });
    }
    this.shardGfx = this.addGraphics();

    for (let hi = 0; hi < HUE_BUCKETS; hi++) {
      // Python bakes a 16 x 5 bank of coloured glows to keep per-frame colours
      // out of the shared sprite cache. Tint times alpha over one white glow is
      // the same composite, so only the sixteen hues survive.
      this.sparkHues.push(rainbowShadeHex(hi / HUE_BUCKETS, 0.5, 1.0, 1.0));
    }
    for (let i = 0; i < 18; i++) {
      const a0 = this.rng.uniform(0, TAU);
      const orbit = this.rng.uniform(h * 0.1, h * 0.55);
      const rate = this.rng.uniform(-0.5, 0.5);
      const phase = this.rng.uniform(0, TAU);
      const sprite = new Sprite(this.glowTexture(5, 8));
      sprite.anchor.set(0.5);
      sprite.blendMode = "add";
      sprite.width = 10;
      sprite.height = 10;
      this.addSprite(sprite);
      this.sparks.push({ a0, orbit, rate, phase, sprite });
    }
  }

  protected override animate(dt: number): void {
    const t = this.t;
    this.spin += dt * 0.16;
    this.hue += dt * 0.045;

    this.drawFan(t);

    const [cpx, cpy] = this.par(0.45);
    this.core.position.set(this.w * 0.5 + cpx, this.h * 0.5 + cpy);

    const [px, py] = this.par(0.95);
    const scx = this.w * 0.5 + px;
    const scy = this.h * 0.5 + py;

    const g = this.shardGfx;
    g.clear();
    const tri = this.tri;
    for (const s of this.shards) {
      const a = s.a0 + t * s.rate;
      const x = scx + Math.cos(a) * s.orbit;
      // Elliptical orbit: 20% squashed vertically.
      const y = scy + Math.sin(a) * s.orbit * 0.8;
      const spin = t * (0.6 + s.rate);
      for (let k = 0; k < 3; k++) {
        const ang = spin + (TAU * k) / 3;
        tri[k * 2] = x + Math.cos(ang) * s.size;
        tri[k * 2 + 1] = y + Math.sin(ang) * s.size;
      }
      g.poly(tri, true).stroke({
        width: 2,
        color: rainbowShadeHex(this.hue + s.a0, 0.7, 0.95, 0.6),
      });
    }

    for (const s of this.sparks) {
      const a = s.a0 + t * s.rate * 0.4;
      let hi = Math.trunc((this.hue + s.a0 * 0.3) * HUE_BUCKETS) % HUE_BUCKETS;
      if (hi < 0) hi += HUE_BUCKETS;
      // The 0.999 clamp is what keeps ki at 4 rather than 5.
      const ki = Math.trunc(clamp(0.5 + 0.5 * Math.sin(t * 2.2 + s.phase), 0, 0.999) * 5.0);
      s.sprite.position.set(scx + Math.cos(a) * s.orbit, scy + Math.sin(a) * s.orbit * 0.8);
      s.sprite.tint = this.sparkHues[hi] ?? 0xffffff;
      s.sprite.alpha = 0.2 + 0.2 * ki;
    }
  }

  override destroy(): void {
    // The fan lives outside the display list, so the base sweep cannot see it.
    this.fanRoot?.destroy({ children: true });
    this.softRoot?.destroy({ children: true });
    super.destroy();
  }

  // -------------------------------------------------------------------
  // the wedge fan
  // -------------------------------------------------------------------

  /**
   * The quarter-res fan buffer, its falloff mask and the eighth-res minify.
   *
   * Two off-display containers do the work: `fanRoot` (wedges, then the falloff
   * multiplied over them) renders into `rtFan`, and `softRoot` (one sprite of
   * `rtFan`, sized down by half) renders into `rtSoft`. Only the sprite showing
   * `rtSoft` is in the scene, magnified to the arena and added - and it carries
   * no parallax, exactly as `_blit_lo` does not.
   */
  private buildFan(): void {
    const lw = this.lw;
    const lh = this.lh;

    this.rtFan = RenderTexture.create({ width: lw, height: lh, scaleMode: "linear" });
    this.rtSoft = RenderTexture.create({
      width: Math.max(2, Math.trunc(lw / 2)),
      height: Math.max(2, Math.trunc(lh / 2)),
      scaleMode: "linear",
    });
    this.own(this.rtFan);
    this.own(this.rtSoft);

    this.wedges = new Graphics();
    this.fanRoot = new Container();
    this.fanRoot.addChild(this.wedges);

    // The falloff makes the beams blaze at the refraction point and dissolve
    // toward the edges instead of reading as a flat pie chart. Sized from the
    // buffer *height*: on a 2:1 arena a diagonal-sized radius would still be
    // near-white at the left and right edges and nothing would ever fade.
    const canvas = createCanvas(lw, lh);
    const ctx = context2d(canvas);
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = "rgb(16,16,16)";
    ctx.fillRect(0, 0, lw, lh);
    paintRadial(ctx, lw * 0.5, lh * 0.5, lh * 0.62, [238, 238, 238], 1.0, 18);
    const falloff = new Sprite(this.own(canvasTexture(canvas)));
    falloff.width = lw;
    falloff.height = lh;
    falloff.blendMode = "multiply";
    this.fanRoot.addChild(falloff);

    const minify = new Sprite(this.rtFan);
    minify.width = this.rtSoft.width;
    minify.height = this.rtSoft.height;
    this.softRoot = new Container();
    this.softRoot.addChild(minify);

    const out = new Sprite(this.rtSoft);
    out.width = this.w;
    out.height = this.h;
    out.blendMode = "add";
    this.addSprite(out);
  }

  private drawFan(t: number): void {
    const cx = this.lw * 0.5;
    const cy = this.lh * 0.5;
    const span = TAU / WEDGES;
    const reach = this.reach;
    const g = this.wedges;
    g.clear();
    for (let i = 0; i < WEDGES; i++) {
      const a0 = this.spin + span * i;
      // Each wedge breathes independently so the fan never looks rigid.
      const width = span * (0.26 + 0.28 * (0.5 + 0.5 * Math.sin(t * 0.8 + i)));
      const hue = this.hue + i / WEDGES;
      g.moveTo(cx, cy);
      g.lineTo(cx + Math.cos(a0) * reach, cy + Math.sin(a0) * reach);
      g.lineTo(cx + Math.cos(a0 + width) * reach, cy + Math.sin(a0 + width) * reach);
      g.fill({ color: rainbowShadeHex(hue, 0.85, 1.0, 0.55) });
      // Dispersion: a thin fringe of a shifted hue straddling the leading edge,
      // drawn after the body so it overwrites it.
      const edge = width * 0.18;
      g.moveTo(cx, cy);
      g.lineTo(cx + Math.cos(a0 - edge) * reach, cy + Math.sin(a0 - edge) * reach);
      g.lineTo(cx + Math.cos(a0 + edge) * reach, cy + Math.sin(a0 + edge) * reach);
      g.fill({ color: rainbowShadeHex(hue + 0.1, 0.9, 1.0, 0.45) });
    }
    this.renderer.render({ container: this.fanRoot, target: this.rtFan, clear: true });
    this.renderer.render({ container: this.softRoot, target: this.rtSoft, clear: true });
  }
}
