/**
 * Stage 10 - Aurora Drift (`aurora`).
 *
 * Ribbons over a quiet sea.
 *
 * Ported from `snake/gfx/background.py::AuroraBackground`; the layer-by-layer
 * specification is in `docs/port/background-9-12.md`.
 *
 * Twinkling stars (0.10), a ground haze (0.35), and six curtains at three
 * depths (0.25 / 0.55 / 0.95). The signature is how a curtain is composited: a
 * column at a time, each column both displaced vertically by two out-of-step
 * sines *and* sampled from a sheared source column. The second displacement is
 * what turns a wobbling rectangle into a sheet folding through itself.
 *
 * pygame blits those columns one by one. Here each curtain is a single `Mesh`
 * of `cols` quads over the strip texture; the per-frame work is writing two
 * float arrays and flagging the buffers, so the whole stage is one draw call
 * per ribbon and allocates nothing.
 */

import { Buffer, Mesh, MeshGeometry, Sprite, Texture } from "pixi.js";

import { clamp, TAU } from "../../core/mathx";
import { clamp8, type RGB } from "../../core/palette";
import { canvasTexture, context2d, createCanvas, cssRgb, whiteTexture } from "../textures";
import { Background } from "./Background";

/**
 * Column width per tint band. Note the pairing: band 2 gets the *narrowest*
 * slice and the *nearest* depth, which is the opposite of what the Python
 * docstring claims - the code is ground truth, so 8 px goes with depth 0.95.
 */
const SLICES: readonly number[] = [18, 12, 8];

const DEPTHS: readonly number[] = [0.25, 0.55, 0.95];

/** The small image every curtain is generated at, then linearly magnified. */
const STRIP_COLS = 30;
const STRIP_ROWS = 60;

interface Ribbon {
  x: number;
  readonly speed: number;
  phase: number;
  readonly rate: number;
  readonly freq: number;
  readonly depth: number;
  readonly step: number;
  readonly cols: number;
  readonly mesh: Mesh;
  readonly pos: Float32Array;
  readonly uv: Float32Array;
  readonly posBuf: Buffer;
  readonly uvBuf: Buffer;
}

interface Star {
  readonly x: number;
  readonly y: number;
  readonly amp: number;
  readonly phase: number;
  readonly sprite: Sprite;
}

export class AuroraBackground extends Background {
  private ribbonW = 0;
  private readonly ribbons: Ribbon[] = [];
  private readonly stars: Star[] = [];
  /** `theme.text`, split out so the per-frame twinkle allocates no triples. */
  private starR = 0;
  private starG = 0;
  private starB = 0;

  protected override build(): void {
    const th = this.theme;
    const w = this.w;
    const h = this.h;
    this.ribbonW = Math.trunc(clamp(w * 0.18, 90, 260));

    const tints: RGB[] = [th.accent, th.accent2, this.mix(th.accent, th.accent2, 0.5)];
    const strips = tints.map((tint) => this.own(this.stripTexture(tint)));

    for (let i = 0; i < 6; i++) {
      const band = i % 3;
      const depth = DEPTHS[band] ?? 0.25;
      const step = SLICES[band] ?? 8;
      const x = this.rng.uniform(-0.1, 1.1) * w;
      const speed = this.rng.uniform(4.0, 10.0) * (0.5 + depth);
      const phase = this.rng.uniform(0, TAU);
      const rate = this.rng.uniform(0.35, 0.8);
      const freq = this.rng.uniform(0.012, 0.03);
      const texture = strips[band];
      if (!texture) continue;
      this.ribbons.push(this.makeRibbon(texture, x, speed, phase, rate, freq, depth, step));
    }

    this.starR = th.text[0];
    this.starG = th.text[1];
    this.starB = th.text[2];
    for (let i = 0; i < 110; i++) {
      const x = this.rng.uniform(0, w);
      const y = this.rng.uniform(0, h * 0.7);
      const amp = this.rng.uniform(0.3, 1.0);
      const phase = this.rng.uniform(0, TAU);
      const sprite = new Sprite(whiteTexture());
      sprite.width = 1;
      sprite.height = 1;
      this.addSprite(sprite);
      this.stars.push({ x, y, amp, phase, sprite });
    }

    this.buildHaze();

    // Ribbon state is built first (it fixes the RNG draw order) but the meshes
    // paint last, after stars and haze. `addSprite` only takes Sprites, so the
    // meshes go straight into the masked layer container.
    for (const r of this.ribbons) this.layers.addChild(r.mesh);
  }

  protected override animate(dt: number): void {
    const t = this.t;

    const [spx, spy] = this.par(0.1);
    // Python truncates the star parallax to whole pixels before adding it.
    const six = Math.trunc(spx);
    const siy = Math.trunc(spy);
    for (const s of this.stars) {
      const tw = 0.5 + 0.5 * Math.sin(t * 1.8 + s.phase);
      const k = 0.55 * s.amp * tw;
      // pygame *overwrites* the pixel with shade(text, k), so the tint carries
      // the brightness and alpha stays at 1 - fading a white sprite instead
      // would let the sky show through and read dimmer at the twinkle floor.
      s.sprite.tint =
        (clamp8(this.starR * k) << 16) |
        (clamp8(this.starG * k) << 8) |
        clamp8(this.starB * k);
      s.sprite.position.set(Math.trunc(s.x) + six, Math.trunc(s.y) + siy);
    }

    const rw = this.ribbonW;
    const h = this.h;
    for (const r of this.ribbons) {
      r.x += r.speed * dt;
      if (r.x > this.w + rw) r.x = -rw;
      r.phase += r.rate * dt;

      const [px, py] = this.par(r.depth);
      const ampV = h * (0.09 + 0.09 * r.depth);
      const limit = rw - r.step;
      const pos = r.pos;
      const uv = r.uv;

      for (let c = 0; c < r.cols; c++) {
        const sx = c * r.step;
        const colX = r.x + sx;
        // Two out-of-step sines give the lazy, non-repeating fold.
        const dy =
          Math.sin(colX * r.freq + r.phase) * ampV +
          Math.sin(colX * r.freq * 2.3 - r.phase * 1.7) * ampV * 0.55;
        // Sliding the *source* column shears the ray structure inside the
        // sheet. The clamp is load-bearing: the 9 px swing exceeds the 8 px
        // slice on the near band, so src would otherwise run past the strip.
        const src = Math.trunc(clamp(sx + Math.sin(colX * r.freq * 1.7 + r.phase * 0.8) * 9.0, 0, limit));

        const x0 = colX + px;
        const x1 = x0 + r.step;
        const y0 = dy + py;
        const y1 = y0 + h;
        const o = c * 8;
        pos[o] = x0;
        pos[o + 1] = y0;
        pos[o + 2] = x1;
        pos[o + 3] = y0;
        pos[o + 4] = x1;
        pos[o + 5] = y1;
        pos[o + 6] = x0;
        pos[o + 7] = y1;

        const u0 = src / rw;
        const u1 = (src + r.step) / rw;
        uv[o] = u0;
        uv[o + 1] = 0;
        uv[o + 2] = u1;
        uv[o + 3] = 0;
        uv[o + 4] = u1;
        uv[o + 5] = 1;
        uv[o + 6] = u0;
        uv[o + 7] = 1;
      }
      r.posBuf.update();
      r.uvBuf.update();
    }
  }

  // -------------------------------------------------------------------
  // build helpers
  // -------------------------------------------------------------------

  /**
   * One curtain, generated at 30 x 60 and left there.
   *
   * Python smoothscales this to `(ribbon_w, h)` and blits pixel subrects out of
   * the result; sampling the small texture with linear filtering at the same
   * normalised u is the same interpolation done on the GPU, so the upscale
   * never has to exist.
   */
  private stripTexture(tint: RGB): Texture {
    const canvas = createCanvas(STRIP_COLS, STRIP_ROWS);
    const ctx = context2d(canvas);
    const img = ctx.createImageData(STRIP_COLS, STRIP_ROWS);
    const d = img.data;
    for (let j = 0; j < STRIP_ROWS; j++) {
      const v = j / (STRIP_ROWS - 1);
      // The lit band covers only the middle ~48% of the height, which is what
      // makes the per-column displacement read as a fold rather than a slab.
      const g = clamp((v - 0.2) / 0.48, 0, 1);
      const vert = Math.pow(Math.sin(Math.PI * g), 1.5);
      for (let i = 0; i < STRIP_COLS; i++) {
        const u = i / (STRIP_COLS - 1);
        // 3.5 vertical striations: the ray structure inside a curtain.
        const ray = 0.62 + 0.38 * (0.5 + 0.5 * Math.sin(u * TAU * 3.5));
        const horiz = Math.pow(Math.sin(Math.PI * u), 1.4);
        const f = 0.62 * vert * horiz * ray;
        const o = (j * STRIP_COLS + i) * 4;
        d[o] = clamp8(tint[0] * f);
        d[o + 1] = clamp8(tint[1] * f);
        d[o + 2] = clamp8(tint[2] * f);
        d[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return canvasTexture(canvas);
  }

  private makeRibbon(
    texture: Texture,
    x: number,
    speed: number,
    phase: number,
    rate: number,
    freq: number,
    depth: number,
    step: number,
  ): Ribbon {
    const cols = Math.ceil(this.ribbonW / step);
    const pos = new Float32Array(cols * 8);
    const uv = new Float32Array(cols * 8);
    const indices = new Uint32Array(cols * 6);
    for (let c = 0; c < cols; c++) {
      const v = c * 4;
      const o = c * 6;
      indices[o] = v;
      indices[o + 1] = v + 1;
      indices[o + 2] = v + 2;
      indices[o + 3] = v;
      indices[o + 4] = v + 2;
      indices[o + 5] = v + 3;
    }
    const geometry = new MeshGeometry({ positions: pos, uvs: uv, indices });
    const mesh = new Mesh({ geometry, texture });
    mesh.blendMode = "add";
    return {
      x,
      speed,
      phase,
      rate,
      freq,
      depth,
      step,
      cols,
      mesh,
      pos,
      uv,
      posBuf: geometry.getBuffer("aPosition"),
      uvBuf: geometry.getBuffer("aUV"),
    };
  }

  /**
   * The ground haze: an additive band over the bottom third, black at the very
   * bottom edge and ramping quadratically up to 5% accent, then cutting off
   * hard. Faithful to the Python - the ramp really does point upward, which is
   * what makes it read as haze hanging *above* the ground rather than on it.
   */
  private buildHaze(): void {
    const { canvas, ctx, m } = this.newLayerCanvas();
    const h = this.h;
    const band = Math.trunc(h / 3);
    const denom = Math.max(1, band);
    ctx.globalCompositeOperation = "source-over";
    for (let i = 0; i < band; i += 2) {
      const f = (i / denom) ** 2;
      ctx.fillStyle = cssRgb(this.shade(this.theme.accent, 0.05 * f));
      ctx.fillRect(0, m + h - 1 - i, this.w + 2 * m, 2);
    }
    this.addLayer(canvas, 0.35);
  }
}
