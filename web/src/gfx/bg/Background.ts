/**
 * The animated background framework - a port of the base class in
 * `snake/gfx/background.py`.
 *
 * Every level owns one of these. It paints a themed vertical gradient, hands
 * its subclass a set of pre-rendered parallax layers to arrange, and multiplies
 * a slowly drifting vignette over the result so the arena edges sit back and
 * the middle reads as lit.
 *
 * The structural change from Python is retained mode. There is no per-frame
 * `draw`: a stage builds its display objects once in {@link build} and nudges
 * their positions, tints and alphas in {@link animate}. Layers registered with
 * the helpers below get their parallax applied by the base class, so a stage
 * only tracks its own scroll offsets.
 *
 * Two rules the twelve stages all depend on:
 *
 * - **Everything is arena-local.** A background is built for a rect in design
 *   space; `root` is positioned at that rect's corner and all stage maths runs
 *   in 0..w / 0..h. Pre-rendered layers carry a 36 px margin on every side
 *   ({@link MARGIN}) so parallax - which tops out at 22 px - can never drag an
 *   empty edge into view.
 * - **Nothing here may throw.** A broken background must cost you the pretty
 *   picture, not the game. `build` and `animate` are wrapped, and the factory
 *   falls back to a plain gradient.
 */

import {
  Container,
  Graphics,
  RenderTexture,
  Sprite,
  TilingSprite,
  Texture,
  type Renderer,
} from "pixi.js";

import { MAX_DT } from "../../core/config";
import { clamp, TAU } from "../../core/mathx";
import { lerpColor, shade, type RGB, type Theme } from "../../core/palette";
import type { DesignRect } from "../../app/Viewport";
import { makeSeededRng, type Rng } from "../rng";
import {
  canvasTexture,
  clearToBlack,
  context2d,
  createCanvas,
  DEPTH_STEPS,
  gradientTexture,
  paintRadial,
  radialTexture,
  tilingTexture,
  vignetteTexture,
  vignetteTint,
  type Canvas2D,
} from "../textures";

/** Slack baked around every pre-rendered layer, in design px. */
export const MARGIN = 36;

/**
 * A registered layer whose parallax the base class drives.
 *
 * Stages own `dx` / `dy` (their scroll offsets) and leave the rest alone.
 */
export interface ParallaxLayer {
  /** How far forward the layer sits: 0 never moves, 1 rides with the snake. */
  depth: number;
  /** Stage-driven scroll offset, in design px. */
  dx: number;
  dy: number;
  readonly display: Sprite | TilingSprite;
  readonly kind: "layer" | "strip" | "tile";
}

/** A small off-screen buffer a stage paints hard-edged shapes into. */
export class LoResBuffer {
  readonly graphics = new Graphics();
  readonly sprite: Sprite;
  private readonly texture: RenderTexture;
  private readonly renderer: Renderer;

  constructor(renderer: Renderer, w: number, h: number, div = 4) {
    this.renderer = renderer;
    this.texture = RenderTexture.create({
      width: Math.max(1, Math.ceil(w / div)),
      height: Math.max(1, Math.ceil(h / div)),
      // Linear sampling on the way back up is the blur; that is the whole trick.
      scaleMode: "linear",
    });
    this.sprite = new Sprite(this.texture);
    this.sprite.width = w;
    this.sprite.height = h;
    this.sprite.blendMode = "add";
    this.graphics.scale.set(1 / div);
  }

  /** Push whatever is in {@link graphics} into the texture the sprite shows. */
  flush(): void {
    this.renderer.render({
      container: this.graphics,
      target: this.texture,
      clear: true,
    });
  }

  destroy(): void {
    this.graphics.destroy();
    this.sprite.destroy();
    this.texture.destroy(true);
  }
}

export class Background {
  /** Peak focus parallax for a depth-1 layer, in design px. */
  static readonly PARALLAX = 22.0;
  /** Time constant of the focus low-pass, in seconds. */
  static readonly FOCUS_TAU = 1.4;
  /** Radians per second of the global colour drift (~84 s per cycle). */
  static readonly DRIFT_RATE = 0.075;

  readonly style: string;
  readonly theme: Theme;
  readonly rect: Readonly<DesignRect>;
  readonly w: number;
  readonly h: number;

  /** Add this to a scene. Already positioned at the rect's corner. */
  readonly root = new Container();
  /** Gradient plus stage layers - the target for whole-frame effects. */
  protected readonly frame = new Container();
  /** Clipped to the rect; every stage display object belongs in here. */
  protected readonly layers = new Container();

  protected readonly renderer: Renderer;
  protected readonly rng: Rng;

  /** Seconds since this background was built. */
  protected t = 0;
  /** Smoothed focus, -1..1 on each axis. */
  protected fx = 0;
  protected fy = 0;
  private tfx = 0;
  private tfy = 0;
  /** The global colour drift, 0..1. */
  protected drift = 0;
  private driftPhase: number;
  private depthIdx = -1;

  private readonly parallaxLayers: ParallaxLayer[] = [];
  private readonly ownedTextures: Texture[] = [];
  private readonly ownedBuffers: LoResBuffer[] = [];
  private readonly maskGfx = new Graphics();
  private readonly vignette: Sprite;
  private destroyed = false;
  private built = false;

  constructor(style: string, theme: Theme, rect: DesignRect, renderer: Renderer) {
    this.style = String(style ?? "").trim().toLowerCase();
    this.theme = theme;
    this.renderer = renderer;

    const w = Math.max(2, Math.round(rect.w));
    const h = Math.max(2, Math.round(rect.h));
    this.rect = Object.freeze({ x: rect.x, y: rect.y, w, h });
    this.w = w;
    this.h = h;

    this.rng = makeSeededRng(`${this.style}|${theme.name}`);
    this.driftPhase = this.rng.uniform(0, TAU);

    this.root.position.set(rect.x, rect.y);
    this.root.addChild(this.frame);

    // Gradient, then the centre lift added over it. Python bakes the lift into
    // the gradient surface; keeping it as its own additive sprite is the same
    // arithmetic and saves rasterising a full-arena bitmap per background.
    const gradient = gradientTexture(h, theme.bgTop, theme.bgBottom);
    this.ownedTextures.push(gradient);
    const base = new Sprite(gradient);
    base.width = w;
    base.height = h;
    this.frame.addChild(base);

    const lift = this.buildCentreLift();
    this.ownedTextures.push(lift);
    const liftSprite = new Sprite(lift);
    liftSprite.width = w;
    liftSprite.height = h;
    liftSprite.blendMode = "add";
    this.frame.addChild(liftSprite);

    // pygame clips `_paint` to the rect; a rectangle mask is the same thing and
    // makes stage overshoot free rather than something to guard against.
    this.maskGfx.rect(0, 0, w, h).fill({ color: 0xffffff });
    this.frame.addChild(this.maskGfx);
    this.layers.mask = this.maskGfx;
    this.frame.addChild(this.layers);

    this.vignette = new Sprite(vignetteTexture());
    this.vignette.width = w;
    this.vignette.height = h;
    this.vignette.blendMode = "multiply";
    this.root.addChild(this.vignette);
  }

  /**
   * Pre-render the stage. Call once, after construction - `makeBackground`
   * does it for you.
   *
   * This is emphatically **not** called from the constructor, and it cannot be.
   * Class fields are initialised in the subclass *after* `super()` returns, so
   * a `build()` invoked from the base constructor runs first and then has every
   * field it just populated overwritten by the subclass's initialisers - either
   * with their declared value or with `undefined`. The stage would look like it
   * had never been built, with no error anywhere. Splitting construction from
   * building is the only way to let a stage write `private embers: Ember[] = []`
   * and have it survive.
   */
  init(): this {
    if (this.built) return this;
    this.built = true;
    try {
      this.build();
    } catch (err) {
      console.warn(`[bg:${this.style}] build failed, falling back to gradient`, err);
    }
    return this;
  }

  // -------------------------------------------------------------------
  // frame
  // -------------------------------------------------------------------

  /**
   * Advance the background.
   *
   * `focus` is a design-space point - the snake's head, or the cursor in the
   * story scene - that the parallax leans toward. Non-finite samples are
   * dropped rather than clamped, so one bad frame cannot stick the layers.
   */
  update(dt: number, focus?: { x: number; y: number } | null): void {
    if (this.destroyed) return;
    const step = clamp(dt, 0, MAX_DT);
    this.t += step;

    if (focus && Number.isFinite(focus.x) && Number.isFinite(focus.y)) {
      this.tfx = clamp((focus.x - (this.rect.x + this.w * 0.5)) / (this.w * 0.5), -1, 1);
      this.tfy = clamp((focus.y - (this.rect.y + this.h * 0.5)) / (this.h * 0.5), -1, 1);
    }
    const k = clamp(step / Background.FOCUS_TAU, 0, 1);
    this.fx += (this.tfx - this.fx) * k;
    this.fy += (this.tfy - this.fy) * k;

    this.drift = 0.5 + 0.5 * Math.sin(this.t * Background.DRIFT_RATE + this.driftPhase);
    const idx = Math.trunc(this.drift * (DEPTH_STEPS - 1));
    if (idx !== this.depthIdx) {
      this.depthIdx = idx;
      this.vignette.tint = vignetteTint(idx);
    }

    try {
      this.animate(step);
    } catch (err) {
      console.warn(`[bg:${this.style}] animate failed`, err);
    }

    this.applyParallax();
  }

  private applyParallax(): void {
    for (const layer of this.parallaxLayers) {
      const [px, py] = this.par(layer.depth);
      const d = layer.display;
      if (layer.kind === "layer") {
        d.position.set(-MARGIN + px + layer.dx, -MARGIN + py + layer.dy);
      } else if (layer.kind === "strip") {
        d.position.set(0, -MARGIN + layer.dy + py);
        (d as TilingSprite).tilePosition.x = layer.dx + px;
      } else {
        d.position.set(0, 0);
        (d as TilingSprite).tilePosition.set(layer.dx + px, layer.dy + py);
      }
    }
  }

  /** Release everything. Shared cached textures are not touched. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    // A stage may have hung a filter on `frame` (the lava heat haze does).
    // Destroying the container does not dispose those, so clear them here
    // rather than making every such stage remember to override destroy().
    for (const f of this.frame.filters ?? []) f.destroy();
    this.frame.filters = [];
    for (const b of this.ownedBuffers) b.destroy();
    this.root.destroy({ children: true });
    for (const t of this.ownedTextures) t.destroy(true);
    this.ownedTextures.length = 0;
    this.parallaxLayers.length = 0;
  }

  // -------------------------------------------------------------------
  // overridables
  // -------------------------------------------------------------------

  /** Pre-render the stage's layers. Called once, from the constructor. */
  protected build(): void {}

  /**
   * Advance stage state and push it into the display objects.
   *
   * Called with `dt` already clamped to `[0, MAX_DT]`; it can be 0 on a paused
   * frame, so nothing here may divide by it.
   */
  protected animate(_dt: number): void {}

  // -------------------------------------------------------------------
  // helpers for stages
  // -------------------------------------------------------------------

  /** Focus-parallax offset for a layer at `depth`. Vertical lean is softer. */
  protected par(depth: number): readonly [number, number] {
    return [
      -this.fx * Background.PARALLAX * depth,
      -this.fy * Background.PARALLAX * depth * 0.62,
    ];
  }

  /** The gradient colour at an arena-local y - for blending into the sky. */
  protected bgAt(yLocal: number): RGB {
    return lerpColor(this.theme.bgTop, this.theme.bgBottom, clamp(yLocal / this.h, 0, 1));
  }

  /** A cached white radial, to tint and fade at the sprite. */
  protected glowTexture(radius: number, steps?: number): Texture {
    return radialTexture(radius, steps);
  }

  /**
   * A black canvas the size of the arena plus its margin. Arena-local (0, 0)
   * sits at (MARGIN, MARGIN); additive stamps want `"lighter"`.
   */
  protected newLayerCanvas(extraW = 0, extraH = 0): {
    canvas: Canvas2D;
    ctx: CanvasRenderingContext2D;
    m: number;
  } {
    const canvas = createCanvas(this.w + MARGIN * 2 + extraW, this.h + MARGIN * 2 + extraH);
    const ctx = context2d(canvas);
    clearToBlack(ctx, canvas.width, canvas.height);
    return { canvas, ctx, m: MARGIN };
  }

  /**
   * A black canvas that tiles horizontally with period `width`. Arena-local
   * (0, 0) sits at (0, MARGIN).
   */
  protected newStripCanvas(
    width: number,
    extraH = 0,
  ): { canvas: Canvas2D; ctx: CanvasRenderingContext2D; m: number } {
    const canvas = createCanvas(Math.max(2, Math.round(width)), this.h + MARGIN * 2 + extraH);
    const ctx = context2d(canvas);
    clearToBlack(ctx, canvas.width, canvas.height);
    return { canvas, ctx, m: MARGIN };
  }

  /** Register a full-arena additive layer built with {@link newLayerCanvas}. */
  protected addLayer(canvas: Canvas2D, depth: number): ParallaxLayer {
    const tex = canvasTexture(canvas);
    this.ownedTextures.push(tex);
    const sprite = new Sprite(tex);
    sprite.blendMode = "add";
    this.layers.addChild(sprite);
    const layer: ParallaxLayer = { depth, dx: 0, dy: 0, display: sprite, kind: "layer" };
    this.parallaxLayers.push(layer);
    return layer;
  }

  /**
   * Register a horizontally wrapping strip built with {@link newStripCanvas}.
   * Scrolling is `layer.dx`; the wrap is exact because the strip's period is
   * its own width.
   */
  protected addStrip(canvas: Canvas2D, depth: number): ParallaxLayer {
    const tex = tilingTexture(canvas);
    this.ownedTextures.push(tex);
    const sprite = new TilingSprite({
      texture: tex,
      width: this.w,
      height: this.h + MARGIN * 2,
    });
    sprite.blendMode = "add";
    this.layers.addChild(sprite);
    const layer: ParallaxLayer = { depth, dx: 0, dy: 0, display: sprite, kind: "strip" };
    this.parallaxLayers.push(layer);
    return layer;
  }

  /**
   * Register a tile that wraps on both axes - the output of
   * `seamlessTexture`. Covers the arena exactly; scroll with `dx` / `dy`.
   */
  protected addTile(texture: Texture, depth: number, owned = true): ParallaxLayer {
    if (owned) this.ownedTextures.push(texture);
    const sprite = new TilingSprite({ texture, width: this.w, height: this.h });
    sprite.blendMode = "add";
    this.layers.addChild(sprite);
    const layer: ParallaxLayer = { depth, dx: 0, dy: 0, display: sprite, kind: "tile" };
    this.parallaxLayers.push(layer);
    return layer;
  }

  /**
   * A `Graphics` for shapes redrawn every frame.
   *
   * Note the blend mode: pygame draws these straight onto the frame, so they
   * overwrite what is beneath them. A star at the bottom of its twinkle paints
   * a *dark* pixel over the clouds, and that is part of the look - do not
   * "fix" it to additive.
   */
  protected addGraphics(): Graphics {
    const g = new Graphics();
    this.layers.addChild(g);
    return g;
  }

  /** A sprite the stage positions itself, e.g. a lone travelling glow. */
  protected addSprite(sprite: Sprite): Sprite {
    this.layers.addChild(sprite);
    return sprite;
  }

  /** A low-resolution additive scratch buffer, upscaled for a free blur. */
  protected addLoRes(div = 4): LoResBuffer {
    const buf = new LoResBuffer(this.renderer, this.w, this.h, div);
    this.ownedBuffers.push(buf);
    this.layers.addChild(buf.sprite);
    return buf;
  }

  /** Track a texture the stage built itself, so `destroy` frees it. */
  protected own(texture: Texture): Texture {
    this.ownedTextures.push(texture);
    return texture;
  }

  // -------------------------------------------------------------------
  // build-time bits shared with subclasses
  // -------------------------------------------------------------------

  /**
   * The soft elliptical lift baked over the arena centre: a wide, weak accent
   * glow that keeps the middle of the field from reading as flat.
   */
  private buildCentreLift(): Texture {
    const W = 128;
    const H = 76;
    const canvas = createCanvas(W, H);
    const ctx = context2d(canvas);
    clearToBlack(ctx, W, H);
    const mid = lerpColor(this.theme.bgTop, this.theme.bgBottom, 0.5);
    const tint = lerpColor(mid, this.theme.accent, 0.22);
    // Clipped by the canvas bounds on purpose - that is what makes it elliptical.
    paintRadial(ctx, 64, 40, 74, tint, 0.2, 12);
    return canvasTexture(canvas);
  }

  /** Convenience for stages: `shade` without importing the palette module. */
  protected shade(c: RGB, factor: number): RGB {
    return shade(c, factor);
  }

  /** Convenience for stages: `lerpColor` without the import. */
  protected mix(a: RGB, b: RGB, t: number): RGB {
    return lerpColor(a, b, t);
  }
}
