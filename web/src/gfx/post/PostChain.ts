/**
 * The post-processing chain: the eight passes of `effects.py::_present`, wired
 * as two nested filtered containers plus two additive sprites.
 *
 * Python composites on the CPU in one pass over an offscreen surface, in an
 * order that matters (`effects.py:958-1048`). Filters run on whatever their
 * container renders to, so the order is reproduced by *where* things sit:
 *
 *     view                        (mount this where the scenes used to go)
 *      +- root                    filters: CRT, grain            <- passes 6, 7
 *      |   +- sceneWrap           filters: aberration, bloom      <- passes 1, 3
 *      |   |   +- backdrop        black, unshaken                 <- pass 2
 *      |   |   +- scene           the game, offset by the shake   <- pass 1
 *      |   +- flash               additive, full frame            <- pass 4
 *      |   +- flare               additive lens streak            <- pass 5
 *      +- top                     the wipe layer, unfiltered      <- pass 8
 *
 * The shake is a transform, not a shader: `scene.position` carries it, in
 * design px, inside the world container that already carries the viewport's
 * letterbox offsets - so the two never fight. The black backdrop underneath is
 * what `_fill_edges` paints into the strips a shake uncovers.
 *
 * Two consequences of the nesting are worth knowing:
 *
 * - The bloom thresholds the *aberrated* frame, where Python thresholds the
 *   clean canvas and adds a (deliberately stale) glow on top of the aberrated
 *   one. Both only differ while the camera is shaking past 6.5 px, and Python's
 *   own answer there is a glow up to 45 ms out of date.
 * - Everything drawn into {@link PostChain.scene} is clipped to the framed
 *   rect, because that is the filter area. Python letterboxes, so it has the
 *   same clip for free; the web viewport does not, which is why the frame is
 *   settable - see {@link PostChain.setFrame}.
 */

import { Container, Rectangle, Sprite, Texture } from "pixi.js";

import { WINDOW_H, WINDOW_W } from "../../core/config";
import { clamp } from "../../core/mathx";
import { clamp8, lerpColor, toHex, type RGB } from "../../core/palette";
import { canvasTexture, context2d, createCanvas, whiteTexture } from "../textures";
import { AberrationFilter } from "./AberrationFilter";
import { BloomFilter } from "./BloomFilter";
import { CrtFilter } from "./CrtFilter";
import { GrainFilter } from "./GrainFilter";
import { FLARE_HEIGHT, ScreenFx, WIPE_SKIP_CHEAP, type QualityLevel } from "./ScreenFx";

/** The streak is authored tiny and stretched - the upscale *is* the blur. */
const FLARE_LOD: readonly [number, number] = [144, 40];

const WHITE: RGB = [255, 255, 255];

export interface FrameRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Pre-render the anamorphic lens streak: a wide horizontal smear, a hot round
 * core and two ghost blooms, on black, ready to be added to the frame.
 *
 * A lens flare is nothing but low frequencies, so 144x40 pixels stretched to
 * the screen looks the same as a full-resolution evaluation.
 */
export function buildFlareTexture(): Texture {
  const [lw, lh] = FLARE_LOD;
  const canvas = createCanvas(lw, lh);
  const ctx = context2d(canvas);
  const img = ctx.createImageData(lw, lh);
  const d = img.data;
  const invW = 2 / Math.max(1, lw - 1);
  const invH = 2 / Math.max(1, lh - 1);
  for (let y = 0; y < lh; y++) {
    const ny = y * invH - 1;
    const ny2 = ny * ny;
    for (let x = 0; x < lw; x++) {
      const nx = x * invW - 1;
      const nx2 = nx * nx;
      // Wide streak: broad in x, razor thin in y.
      let v = Math.exp(-nx2 * 2.1) * Math.exp(-ny2 * 22.0);
      // Hot core.
      v += 0.85 * Math.exp(-(nx2 * 34.0 + ny2 * 9.0));
      // Two ghosts, warmer and cooler, at +-0.42.
      const gl = nx + 0.42;
      const gr = nx - 0.42;
      v += 0.3 * 1.0 * Math.exp(-(gl * gl * 130.0 + ny2 * 26.0));
      v += 0.3 * 0.8 * Math.exp(-(gr * gr * 130.0 + ny2 * 26.0));
      const i = clamp(v, 0, 1);
      const o = (y * lw + x) * 4;
      // A touch of hue separation across the streak sells the "lens".
      d[o] = clamp8(255 * i);
      d[o + 1] = clamp8(238 * i * (0.85 + 0.15 * (1 - Math.abs(nx))));
      d[o + 2] = clamp8(255 * i * (0.7 + 0.3 * Math.abs(nx)));
      d[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvasTexture(canvas);
}

export class PostChain {
  /** The state the game pokes. Advanced by {@link update}. */
  readonly fx: ScreenFx;

  /** Add this to the scaled world container, in place of the scene roots. */
  readonly view = new Container();
  /** Scene roots go in here. Carries the shake offset. */
  readonly scene = new Container();
  /** Above every filter: the transition wipe layer. */
  readonly top = new Container();

  private readonly root = new Container();
  private readonly sceneWrap = new Container();
  private readonly backdrop: Sprite;
  private readonly flash: Sprite;
  private readonly flare: Sprite;
  private readonly flareTexture: Texture | null;

  private readonly aberration: AberrationFilter | null;
  private readonly bloom: BloomFilter | null;
  private readonly crt: CrtFilter | null;
  private readonly grain: GrainFilter | null;

  private frame: FrameRect = { x: 0, y: 0, w: WINDOW_W, h: WINDOW_H };
  private destroyed = false;

  constructor(fx?: ScreenFx) {
    this.fx = fx ?? new ScreenFx();

    this.backdrop = new Sprite(whiteTexture());
    this.backdrop.tint = 0x000000;
    this.sceneWrap.addChild(this.backdrop);
    this.sceneWrap.addChild(this.scene);

    this.flash = new Sprite(whiteTexture());
    this.flash.blendMode = "add";
    this.flash.visible = false;

    // The streak texture needs a canvas; without one the pass simply never
    // shows, which is the same contract the rest of the chain keeps.
    let flareTex: Texture | null = null;
    try {
      flareTex = buildFlareTexture();
    } catch (err) {
      console.warn("[post] lens streak unavailable", err);
    }
    this.flareTexture = flareTex;
    this.flare = new Sprite(flareTex ?? whiteTexture());
    this.flare.blendMode = "add";
    this.flare.visible = false;

    this.root.addChild(this.sceneWrap);
    this.root.addChild(this.flash);
    this.root.addChild(this.flare);
    this.view.addChild(this.root);
    this.view.addChild(this.top);

    // A failure anywhere in the chain must cost the player the pretty picture,
    // not the game: the scene still renders, just without post.
    let aberration: AberrationFilter | null = null;
    let bloom: BloomFilter | null = null;
    let crt: CrtFilter | null = null;
    let grain: GrainFilter | null = null;
    try {
      aberration = new AberrationFilter();
      bloom = new BloomFilter();
      crt = new CrtFilter();
      grain = new GrainFilter();
      this.sceneWrap.filters = [aberration, bloom];
      this.root.filters = [crt, grain];
    } catch (err) {
      console.warn("[post] filter chain disabled", err);
      this.sceneWrap.filters = [];
      this.root.filters = [];
      aberration = bloom = null;
      crt = null;
      grain = null;
    }
    this.aberration = aberration;
    this.bloom = bloom;
    this.crt = crt;
    this.grain = grain;

    this.setFrame(this.frame);
  }

  /**
   * Re-frame the whole chain.
   *
   * Everything the CRT draws - the vignette, the squircle rolloff, the corner
   * cut, the rim - is authored as a frame around the 1280x720 design rect, and
   * that is the default. Passing the viewport's overscan rect instead stretches
   * the tube to the physical screen edges and stops the filter clipping
   * anything a background paints outside the design box. Which of the two the
   * game wants is spec §17 Q1, still open.
   */
  setFrame(rect: FrameRect): void {
    const w = Math.max(2, rect.w);
    const h = Math.max(2, rect.h);
    this.frame = { x: rect.x, y: rect.y, w, h };

    // One rectangle each: the filter system reads them per container and there
    // is no promise that it will not keep hold of one.
    this.root.filterArea = new Rectangle(rect.x, rect.y, w, h);
    this.sceneWrap.filterArea = new Rectangle(rect.x, rect.y, w, h);

    this.backdrop.position.set(rect.x, rect.y);
    this.backdrop.width = w;
    this.backdrop.height = h;
    this.flash.position.set(rect.x, rect.y);
    this.flash.width = w;
    this.flash.height = h;
    // Python sizes the streak (screenW, 0.30 * screenH).
    this.flare.width = w;
    this.flare.height = Math.max(8, Math.trunc(h * FLARE_HEIGHT));

    this.aberration?.setFrameSize(w, h);
    this.crt?.setFrameSize(w, h);
    this.grain?.setFrameSize(w, h);
  }

  /** Apply one of the quality presets to the whole stack. */
  setQuality(level: QualityLevel): void {
    this.fx.setQuality(level);
  }

  /**
   * Advance the effect state with **real** (unscaled) dt and push it into the
   * display objects. Nothing here allocates in the steady state.
   */
  update(dt: number): void {
    if (this.destroyed) return;
    this.fx.update(dt);
    this.sync();
  }

  private sync(): void {
    const fx = this.fx;
    const cover = fx.transitionCover();

    // Pass 1: the frame slides, and the strips it uncovers show the backdrop.
    this.scene.position.set(fx.offset.x, fx.offset.y);

    if (this.aberration) {
      const strength = fx.aberrationStrength();
      const on = strength > 0.02;
      this.aberration.enabled = on;
      if (on) this.aberration.strength = strength;
    }

    if (this.bloom) {
      this.bloom.enabled = fx.bloomEnabled && fx.bloomStrength > 0;
      this.bloom.gain = fx.bloomStrength;
    }

    // Pass 4: additive colour flash. The visual saturates at 1.0; the 1.25 of
    // headroom above it only extends the time spent at full white.
    const flashAmount = clamp(fx.flashAmount, 0, 1);
    this.flash.visible = flashAmount > 0;
    if (flashAmount > 0) {
      this.flash.tint = toHex(fx.flashColor);
      this.flash.alpha = flashAmount;
    }

    // Pass 5: the streak riding on the same bright event.
    const flareAmount = clamp(fx.flareAmount, 0, 1);
    const showFlare = this.flareTexture !== null && fx.flareEnabled && flareAmount > 0;
    this.flare.visible = showFlare;
    if (showFlare) {
      // Whiten as it peaks: a real over-exposed streak loses saturation.
      this.flare.tint = toHex(lerpColor(fx.flareColor, WHITE, 0.45 * flareAmount));
      this.flare.alpha = flareAmount;
      this.flare.position.set(
        Math.trunc(this.frame.x + fx.flarePos.x * this.frame.w - this.flare.width * 0.5),
        Math.trunc(this.frame.y + fx.flarePos.y * this.frame.h - this.flare.height * 0.5),
      );
    }

    // Pass 6: vignette + curvature + scanlines.
    if (this.crt) {
      this.crt.enabled = fx.vignetteEnabled || fx.curvatureEnabled || fx.scanlinesEnabled;
      this.crt.setLayers(fx.vignetteEnabled, fx.curvatureEnabled, fx.scanlinesEnabled);
    }

    // Pass 7: film grain. Dropped once a wipe has swallowed a third of the
    // frame, as in Python - there is nothing left to see it on.
    if (this.grain) {
      const want = fx.grainEnabled && cover < WIPE_SKIP_CHEAP;
      this.grain.enabled =
        want && this.grain.setLayer(fx.grainIndex, fx.grainJitterX, fx.grainJitterY);
    }
  }

  /** Release the filters and the textures this chain owns. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.sceneWrap.filters = [];
    this.root.filters = [];
    this.aberration?.destroy();
    this.bloom?.destroy();
    this.crt?.destroy();
    this.grain?.destroy();
    this.backdrop.destroy();
    this.flash.destroy();
    this.flare.destroy();
    // The scene roots inside `scene` belong to the game, so nothing here is
    // destroyed recursively.
    this.view.destroy({ children: false });
    this.flareTexture?.destroy(true);
  }
}
