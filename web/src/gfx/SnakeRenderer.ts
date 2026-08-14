/**
 * The snake: aura, body tube, cross-over overpass, head, tail and shield.
 *
 * A port of the painting half of `snake/gfx/render.py` (`_paint_snake` and
 * everything it calls). The geometry it paints comes from
 * {@link SnakeGeometry}; this module is only concerned with what goes on the
 * screen and, above all, **in what order**.
 *
 * Draw order is the whole trick
 * -----------------------------
 * The signature effect of the game is the cross-over: when the snake hairpins,
 * its head passes back over its own neck and has to read as going *over* rather
 * than dying. Nothing computes that - it falls out of the paint order:
 *
 *   1. the rear body (every point past `FRONT_SPAN`) is painted first;
 *   2. a soft **subtractive** disc is stamped on the contact point, offset
 *      down-right so it reads as a cast shadow;
 *   3. an **over-wide** bright capsule is laid along the front tube across the
 *      crossing span;
 *   4. the front tube is repainted at its true width on top, which eats all of
 *      that capsule except a two-to-four pixel outline hugging the head end.
 *
 * That surviving outline is the edge-light of a bridge deck against the road
 * underneath. Any "optimisation" that groups children by blend mode to help
 * batching destroys it, so the child order below is a contract, not a
 * suggestion.
 *
 * Retained mode
 * -------------
 * Python redraws immediately into a surface; Pixi keeps a scene graph. The
 * mapping used here is the one the port spec settled on: one `Graphics` per
 * z-band, cleared and rebuilt each frame (path order inside a Graphics *is*
 * paint order, which is exactly what the Python relies on), plus pooled additive
 * sprites for the glows, interleaved as separate containers only where the
 * z-order demands it. Sprites are never allocated in the steady state; they are
 * repositioned, re-tinted and hidden.
 *
 * Two deliberate coarsenings of Python's interleaving, both flagged in the port
 * spec (Q5): the additive spine sparkles are collected into one layer that sits
 * above all of a range's tube strokes rather than being interleaved point by
 * point, and the head's glows are grouped into "under the skull" and "over the
 * skull" layers instead of one container per stamp.
 *
 * The contact shadow uses the advanced `"subtract"` blend mode, which needs
 * `useBackBuffer: true` on the `Application` or it silently falls back to
 * normal. All the shadow discs of a frame live in one container so the whole
 * group costs a single pass.
 */

import "pixi.js/advanced-blend-modes";

import { AlphaFilter, Container, Graphics, Sprite, type Filter } from "pixi.js";

import * as C from "../core/config";
import { clamp, pulse, TAU } from "../core/mathx";
import {
  bodyAt,
  clamp8,
  toHex,
  UI_WHITE,
  type RGB,
  type Theme,
} from "../core/palette";
import type { Snake } from "../core/snake";
import { FRONT_SPAN, SnakeGeometry } from "./snakeGeometry";
import { discTexture, setGlow } from "./textures";

export {
  BANK_RAMP,
  BANK_STRENGTH,
  FRONT_SPAN,
  MAX_CROSSINGS,
  SnakeGeometry,
} from "./snakeGeometry";

/** Opacity a phased-out (ghost) snake is drawn at, 0..255. */
export const GHOST_ALPHA = 116;

/** Target number of scale plates drawn along the body, whatever its length. */
export const SCALE_PLATE_TARGET = 26;

/**
 * Colour subtracted (radially) under a cross-over. Deliberately neutral so it
 * darkens the crossed segment rather than tinting it.
 */
export const SHADOW_COLOR: RGB = [104, 116, 146];

/** Hot colour mixed into the neck while boosting. */
export const EXHAUST_COLOR: RGB = [255, 196, 96];

const WHITE_HEX = 0xffffff;
const SHADOW_HEX = toHex(SHADOW_COLOR);
const EXHAUST_HEX = toHex(EXHAUST_COLOR);
const SCLERA_HEX = toHex(UI_WHITE);

const BLINK_PERIOD = 3.7; // seconds between blinks
const BLINK_WIDTH = 0.05; // fraction of the period the lids are moving

/**
 * Unit skull outline in head-local space: +u is forward along the heading, +v
 * is to the left of it. Nose first, then clockwise on screen.
 */
const SKULL: readonly number[] = [
  1.3, 0.0, 1.2, 0.3, 0.92, 0.58, 0.34, 0.8, -0.3, 0.78, -0.86, 0.46, -1.04,
  0.0, -0.86, -0.46, -0.3, -0.78, 0.34, -0.8, 0.92, -0.58, 1.2, -0.3,
];

/** The jaw: a shallow wedge hanging under the front of the skull. */
const JAW: readonly number[] = [
  1.16, 0.0, 0.86, 0.34, 0.16, 0.44, -0.24, 0.2, -0.24, -0.2, 0.16, -0.44,
  0.86, -0.34,
];

// ---------------------------------------------------------------------------
// Packed-colour maths
// ---------------------------------------------------------------------------
//
// Pixi wants `0xRRGGBB`, and a body point's colours are recomputed several
// times per point per frame. These are `palette.lerpColor` / `palette.shade`
// with the triple never materialised - same arithmetic, including `clamp8`'s
// truncation - so a frame costs no throwaway arrays.

export function mixHex(a: number, b: number, t: number): number {
  const k = t < 0 ? 0 : t > 1 ? 1 : t;
  const ar = (a >> 16) & 0xff;
  const ag = (a >> 8) & 0xff;
  const ab = a & 0xff;
  return (
    (clamp8(ar + (((b >> 16) & 0xff) - ar) * k) << 16) |
    (clamp8(ag + (((b >> 8) & 0xff) - ag) * k) << 8) |
    clamp8(ab + ((b & 0xff) - ab) * k)
  );
}

export function shadeHex(c: number, f: number): number {
  return (
    (clamp8(((c >> 16) & 0xff) * f) << 16) |
    (clamp8(((c >> 8) & 0xff) * f) << 8) |
    clamp8((c & 0xff) * f)
  );
}

/**
 * Scratch triple so {@link setGlow} can be fed a packed colour for free.
 *
 * The returned array is shared and only ever valid until the next call, so it
 * must be consumed immediately - which is the only way it is used. `mixHex`,
 * `shadeHex` and this belong in `core/palette` next to their allocating
 * equivalents; they live here (and are shared with the arena frame) until the
 * orchestrator moves them.
 */
const scratchRgb: [number, number, number] = [0, 0, 0];

export function rgbOf(hex: number): RGB {
  scratchRgb[0] = (hex >> 16) & 0xff;
  scratchRgb[1] = (hex >> 8) & 0xff;
  scratchRgb[2] = hex & 0xff;
  return scratchRgb;
}

// ---------------------------------------------------------------------------
// Pooling
// ---------------------------------------------------------------------------

/**
 * A container of interchangeable sprites handed out in draw order.
 *
 * `begin` / `next` / `end` per frame: unused sprites are hidden rather than
 * removed, so a steady frame allocates nothing and the container's child order
 * stays stable.
 */
class SpritePool {
  readonly layer = new Container();
  private readonly sprites: Sprite[] = [];
  private used = 0;

  constructor(private readonly blend: Sprite["blendMode"]) {}

  begin(): void {
    this.used = 0;
  }

  next(): Sprite {
    let s = this.sprites[this.used];
    if (s === undefined) {
      s = new Sprite();
      s.anchor.set(0.5);
      s.blendMode = this.blend;
      this.sprites.push(s);
      this.layer.addChild(s);
    }
    s.visible = true;
    this.used++;
    return s;
  }

  end(): void {
    for (let i = this.used; i < this.sprites.length; i++) {
      this.sprites[i]!.visible = false;
    }
  }
}

function stampGlow(
  pool: SpritePool,
  x: number,
  y: number,
  radius: number,
  color: number,
  intensity: number,
): void {
  const s = pool.next();
  setGlow(s, radius, rgbOf(color), intensity);
  s.position.set(x, y);
}

/**
 * The flat-centred disc used for the contact shadow. A radial glow puts all its
 * energy in the middle, which is exactly where the head hides it; this one
 * holds full strength across the middle so the part peeking out is still dark.
 */
function stampDisc(
  pool: SpritePool,
  x: number,
  y: number,
  radius: number,
  color: number,
  intensity: number,
): void {
  const s = pool.next();
  const r = Math.max(0.5, radius);
  const tex = discTexture(r);
  if (s.texture !== tex) s.texture = tex;
  s.width = r * 2;
  s.height = r * 2;
  s.tint = color;
  s.alpha = clamp(intensity, 0, 1);
  s.position.set(x, y);
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * A butt-ended thick line, as a quad on the current path.
 *
 * pygame's thick lines are exactly this: a rectangle centred on the segment,
 * with the joints and caps supplied separately by circles. Rebuilding it by
 * hand (rather than stroking) keeps the caps square and lets the quad and its
 * joint circle share one `fill`.
 */
function capsulePath(
  g: Graphics,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  width: number,
): void {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const m = Math.hypot(dx, dy);
  if (m < 1e-9) return;
  const h = width * 0.5;
  const ox = (-dy / m) * h;
  const oy = (dx / m) * h;
  g.moveTo(x0 + ox, y0 + oy);
  g.lineTo(x1 + ox, y1 + oy);
  g.lineTo(x1 - ox, y1 - oy);
  g.lineTo(x0 - ox, y0 - oy);
  g.closePath();
}

/** Eye openness 0..1; snaps shut and back every {@link BLINK_PERIOD} seconds. */
function blink(t: number): number {
  const ph = (t % BLINK_PERIOD) / BLINK_PERIOD;
  if (ph >= BLINK_WIDTH) return 1.0;
  const u = ph / BLINK_WIDTH;
  return clamp(Math.abs(u * 2.0 - 1.0), 0.0, 1.0);
}

// ---------------------------------------------------------------------------
// The renderer
// ---------------------------------------------------------------------------

export interface SnakeDrawOptions {
  /** Phase power-up: draw the whole creature translucent. */
  ghost?: boolean;
  /** Shield power-up: add the rotating hexagonal ring around the head. */
  shield?: boolean;
  /**
   * Override the auto-detected "the head is passing over its own body" state.
   * Leave undefined to use `snake.crossingSelf()`.
   */
  crossing?: boolean;
}

export class SnakeRenderer {
  /** Add this to the gameplay scene, inside the arena clip. */
  readonly container = new Container();

  private readonly geo = new SnakeGeometry();

  // Layers, in paint order. See the module docstring: this order is a contract.
  private readonly aura = new SpritePool("add");
  private readonly tailG = new Graphics();
  private readonly tailGlow = new SpritePool("add");
  private readonly rearTubeG = new Graphics();
  private readonly rearSpine = new SpritePool("add");
  private readonly rearPlateG = new Graphics();
  // One container for every shadow of the frame: the advanced blend mode then
  // costs a single pass instead of one per disc.
  private readonly shadow = new SpritePool("inherit");
  private readonly crossRimG = new Graphics();
  private readonly crossGlow = new SpritePool("add");
  private readonly frontTubeG = new Graphics();
  private readonly frontSpine = new SpritePool("add");
  private readonly frontPlateG = new Graphics();
  private readonly headUnder = new SpritePool("add");
  private readonly headG = new Graphics();
  private readonly headOver = new SpritePool("add");
  private readonly eyeG = new Graphics();
  private readonly shieldUnder = new SpritePool("add");
  private readonly shieldG = new Graphics();
  private readonly shieldOver = new SpritePool("add");

  private readonly pools: SpritePool[];
  private readonly graphics: Graphics[];

  // Uniform translucency for the ghost path. A filter flattens the subtree
  // exactly like Python's scratch layer; per-child alpha would stack up
  // everywhere two strokes overlap.
  private readonly alphaFilter = new AlphaFilter({ alpha: GHOST_ALPHA / 255 });
  private readonly ghostFilters: Filter[];
  private static readonly NO_FILTERS: Filter[] = [];
  private ghostOn = false;

  // Per-point colours, rebuilt only when the theme or the body length changes.
  private colHex = new Uint32Array(0);
  private rimHex = new Uint32Array(0);
  private colsTheme: Theme | null = null;
  private colsN = -1;

  // Per-frame state, kept on the instance so the painters need no long
  // argument lists (and no per-frame context object).
  private n = 0;
  private t = 0;
  private gi = 1;
  private speed = 0;
  private boosting = false;
  private plateStep = 3;
  private accentHex = 0;
  private accent2Hex = 0;
  private headColHex = 0;
  private hotHex = 0;

  // Scratch for the head-local to world transform.
  private ux = 0;
  private uy = 0;

  private warned = false;
  private destroyed = false;

  constructor() {
    this.shadow.layer.blendMode = "subtract";
    this.ghostFilters = [this.alphaFilter];

    this.pools = [
      this.aura,
      this.tailGlow,
      this.rearSpine,
      this.shadow,
      this.crossGlow,
      this.frontSpine,
      this.headUnder,
      this.headOver,
      this.shieldUnder,
      this.shieldOver,
    ];
    this.graphics = [
      this.tailG,
      this.rearTubeG,
      this.rearPlateG,
      this.crossRimG,
      this.frontTubeG,
      this.frontPlateG,
      this.headG,
      this.eyeG,
      this.shieldG,
    ];

    this.container.addChild(
      this.aura.layer,
      this.tailG,
      this.tailGlow.layer,
      this.rearTubeG,
      this.rearSpine.layer,
      this.rearPlateG,
      this.shadow.layer,
      this.crossRimG,
      this.crossGlow.layer,
      this.frontTubeG,
      this.frontSpine.layer,
      this.frontPlateG,
      this.headUnder.layer,
      this.headG,
      this.headOver.layer,
      this.eyeG,
      this.shieldUnder.layer,
      this.shieldG,
      this.shieldOver.layer,
    );
  }

  /**
   * Rebuild the whole snake for one frame.
   *
   * `t` is the scene clock in seconds (animation phase, not a delta). Like the
   * Python original this must never throw: a renderer that dies takes the frame
   * with it.
   */
  draw(snake: Snake, theme: Theme, t: number, opts?: SnakeDrawOptions): void {
    if (this.destroyed) return;
    try {
      this.paint(snake, theme, t, opts);
    } catch (err) {
      if (!this.warned) {
        this.warned = true;
        console.warn("[SnakeRenderer] draw failed", err);
      }
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.container.filters = SnakeRenderer.NO_FILTERS;
    this.container.destroy({ children: true });
    this.alphaFilter.destroy();
    this.pools.length = 0;
    this.graphics.length = 0;
  }

  // -------------------------------------------------------------------
  // frame
  // -------------------------------------------------------------------

  private paint(
    snake: Snake,
    theme: Theme,
    t: number,
    opts: SnakeDrawOptions | undefined,
  ): void {
    const geo = this.geo;
    geo.build(snake);
    const n = geo.n;
    if (n < 1) return;
    geo.findCrossings();

    const ghost = opts?.ghost === true;
    const shield = opts?.shield === true;
    const punch =
      (opts?.crossing === undefined ? snake.crossingSelf() : opts.crossing)
        ? 1.0
        : 0.0;

    this.n = n;
    this.t = Number.isFinite(t) ? t : 0;
    // Python dims every glow on the ghost path *as well as* fading the layer,
    // so the halo does not blow out through the translucency.
    this.gi = ghost ? GHOST_ALPHA / 255 : 1.0;
    this.speed = clamp(
      (snake.currentSpeed - C.SNAKE_BASE_SPEED) /
        (C.SNAKE_MAX_SPEED * C.SNAKE_BOOST_MULT - C.SNAKE_BASE_SPEED),
      0,
      1,
    );
    this.boosting = snake.boosting;
    this.plateStep = Math.max(2, Math.trunc(n / SCALE_PLATE_TARGET) + 1);
    this.accentHex = theme.hex.accent;
    this.accent2Hex = theme.hex.accent2;
    this.headColHex = theme.hex.snakeHead;
    this.hotHex = mixHex(mixHex(EXHAUST_HEX, this.accent2Hex, 0.16), WHITE_HEX, 0.22);
    this.resolveColours(theme, n);

    if (ghost !== this.ghostOn) {
      this.ghostOn = ghost;
      this.container.filters = ghost
        ? this.ghostFilters
        : SnakeRenderer.NO_FILTERS;
    }

    for (let i = 0; i < this.pools.length; i++) this.pools[i]!.begin();
    for (let i = 0; i < this.graphics.length; i++) this.graphics[i]!.clear();

    this.drawAura();
    this.drawTail();

    // The split is the overpass mechanism: rear body, decoration, then the
    // front tube repainted at true width straight over the top of it.
    const split = Math.min(FRONT_SPAN, n - 1);
    this.paintRange(this.rearTubeG, this.rearSpine, this.rearPlateG, n - 1, split + 1);
    this.drawCrossings(punch);
    this.paintRange(this.frontTubeG, this.frontSpine, this.frontPlateG, split, 0);

    this.drawHead(snake.heading, geo.lean[0]!);
    if (shield) this.drawShield();

    for (let i = 0; i < this.pools.length; i++) this.pools[i]!.end();
  }

  /** The head-to-tail gradient and its rim highlight, cached per theme+length. */
  private resolveColours(theme: Theme, n: number): void {
    if (this.colsTheme === theme && this.colsN === n) return;
    this.colsTheme = theme;
    this.colsN = n;
    if (this.colHex.length < n) {
      this.colHex = new Uint32Array(n + 32);
      this.rimHex = new Uint32Array(n + 32);
    }
    const denom = Math.max(1, n - 1);
    for (let i = 0; i < n; i++) {
      const c = toHex(bodyAt(theme, i / denom));
      this.colHex[i] = c;
      this.rimHex[i] = mixHex(c, WHITE_HEX, 0.52);
    }
  }

  // -------------------------------------------------------------------
  // layers
  // -------------------------------------------------------------------

  /**
   * A wide soft bloom plus a tight hot sheath right on the body - the second is
   * what stops a long snake from reading as a flat plastic tube. Subsampled so
   * the cost stays flat however long the snake gets.
   */
  private drawAura(): void {
    const { x, y, radii } = this.geo;
    const n = this.n;
    const step = n <= 24 ? 1 : Math.max(1, Math.trunc(n / 24));
    const beat = pulse(this.t, 3.1);
    const wide = (0.3 + 0.1 * beat) * this.gi;
    const tight = (0.46 + 0.14 * beat) * this.gi;
    for (let i = n - 1; i >= 0; i -= step) {
      const r = radii[i]!;
      const col = this.colHex[i]!;
      stampGlow(this.aura, x[i]!, y[i]!, r * 3.6, col, wide);
      stampGlow(this.aura, x[i]!, y[i]!, r * 1.7, col, tight);
    }
  }

  /** Extend the last segment into a fine, luminous, flicking point. */
  private drawTail(): void {
    const n = this.n;
    if (n < 3) return;
    const { x, y, radii } = this.geo;
    const ex = x[n - 1]!;
    const ey = y[n - 1]!;
    let dx = ex - x[n - 2]!;
    let dy = ey - y[n - 2]!;
    const m = Math.hypot(dx, dy);
    if (m < 1e-6) return;
    dx /= m;
    dy /= m;
    const nx = -dy;
    const ny = dx;
    const reach = Math.max(6.0, C.SNAKE_SEGMENT_SPACING * 0.9);
    const flick = Math.sin(this.t * 8.4) * reach * 0.42;
    const r = radii[n - 1]!;
    const mx = ex + dx * reach * 0.5 + nx * flick * 0.5;
    const my = ey + dy * reach * 0.5 + ny * flick * 0.5;
    const tx = ex + dx * reach + nx * flick;
    const ty = ey + dy * reach + ny * flick;

    const g = this.tailG;
    capsulePath(g, ex, ey, mx, my, Math.max(1, Math.trunc(r * 1.4)));
    g.fill(this.rimHex[n - 1]!);
    capsulePath(g, mx, my, tx, ty, Math.max(1, Math.trunc(r * 0.7)));
    g.fill(mixHex(this.colHex[n - 1]!, WHITE_HEX, 0.55));
    stampGlow(
      this.tailGlow,
      tx,
      ty,
      r * 3.0,
      this.accentHex,
      (0.35 + 0.25 * pulse(this.t, 6.0)) * this.gi,
    );
  }

  /**
   * Paint body points `iFrom` down to `iTo` (inclusive), tail-most first.
   *
   * Four sub-passes: the bright rim shell that defines the silhouette, the
   * gradient interior inset inside it, the hot spine seam, and the scale
   * plates. Splitting the body into two ranges and calling this twice is what
   * gives the cross-over its depth ordering.
   */
  private paintRange(
    gTube: Graphics,
    spine: SpritePool,
    gPlate: Graphics,
    iFrom: number,
    iTo: number,
  ): void {
    if (iFrom < iTo) return;
    const { x, y, radii, nx, ny, lean } = this.geo;
    const n = this.n;
    const t = this.t;
    const gi = this.gi;

    // ---- rim shell ---------------------------------------------------
    for (let i = iFrom; i >= iTo; i--) {
      const r = radii[i]!;
      if (i > 0) {
        capsulePath(
          gTube,
          x[i]!,
          y[i]!,
          x[i - 1]!,
          y[i - 1]!,
          Math.max(1, Math.trunc(Math.min(r, radii[i - 1]!) * 2.0)),
        );
      }
      gTube.circle(x[i]!, y[i]!, Math.max(1, Math.trunc(r)));
      gTube.fill(this.rimHex[i]!);
    }

    // ---- gradient interior, inset by the rim width --------------------
    for (let i = iFrom; i >= iTo; i--) {
      const r = radii[i]!;
      const rimW = clamp(r * 0.22, 1.4, 3.0);
      const inner = r - rimW;
      if (inner < 1.0) continue;
      if (i > 0) {
        capsulePath(
          gTube,
          x[i]!,
          y[i]!,
          x[i - 1]!,
          y[i - 1]!,
          Math.max(1, Math.trunc(Math.min(inner, radii[i - 1]! - rimW) * 2.0)),
        );
      }
      gTube.circle(x[i]!, y[i]!, Math.max(1, Math.trunc(inner)));
      gTube.fill(this.colHex[i]!);
    }

    // ---- hot inner line along the spine -------------------------------
    // The phase term `i * 0.52 - t * 7` makes the bright band drift toward the
    // tail, which reads as energy being flushed backwards down the body.
    for (let i = iFrom; i >= iTo; i--) {
      const r = radii[i]!;
      if (r < 3.0) continue;
      const s = 0.5 + 0.5 * Math.sin(i * 0.52 - t * 7.0);
      const bright = mixHex(this.colHex[i]!, this.headColHex, 0.3 + 0.45 * s);
      const core = mixHex(bright, WHITE_HEX, 0.3 * s);
      if (i > 0) {
        capsulePath(
          gTube,
          x[i]!,
          y[i]!,
          x[i - 1]!,
          y[i - 1]!,
          Math.max(1, Math.trunc(r * 0.46)),
        );
      }
      gTube.circle(x[i]!, y[i]!, Math.max(1, Math.trunc(r * 0.36)));
      gTube.fill(core);
      if (s > 0.72 && (i & 1) === 0) {
        stampGlow(spine, x[i]!, y[i]!, r * 2.1, this.accentHex, 0.6 * s * gi);
      }
    }

    // ---- overlapping scale plates -------------------------------------
    // A chevron pointing head-ward at every `plateStep`-th point, walked
    // tail-first so each plate overlaps the one behind it. The two halves are
    // drawn separately so the outer edge of a turn can be lit brighter than the
    // inner one - that asymmetry is most of what sells the bank.
    //
    // DELIBERATE QUIRK, matching the shipped Python: `staleR` is the radius of
    // the range's *head-most* point, left over in a loop variable from the
    // spine pass. Every plate in the range is therefore gated, sized and
    // stroked as if it sat there. It is almost certainly an accident in the
    // original, but it is what ships: plates never taper off toward the tail
    // and their half-width is constant per range.
    const staleR = radii[iTo]!;
    if (staleR < 7.0) return;
    const e = staleR * 0.6;
    const pw = staleR < 8.0 ? 1 : 2;
    const step = this.plateStep;
    for (let i = iFrom - (iFrom % step); i >= iTo; i -= step) {
      if (i < 1 || i >= n - 1) continue;
      const px = x[i]!;
      const py = y[i]!;
      // Apex pulled 42% of the way toward the head-ward neighbour. Pushed out
      // to the silhouette a chevron stops reading as a plate and starts
      // reading as a thorn, so it is kept well inside the rim.
      const mx = px + (x[i - 1]! - px) * 0.42;
      const my = py + (y[i - 1]! - py) * 0.42;
      const base = this.colHex[i]!;
      // k > 0 means the point leaned to the left, so the *right* flank is the
      // outside of the turn and catches the light.
      const k = lean[i]!;
      capsulePath(gPlate, px + nx[i]! * e, py + ny[i]! * e, mx, my, pw);
      gPlate.fill(mixHex(base, WHITE_HEX, clamp(0.26 - 0.2 * k, 0.04, 0.62)));
      capsulePath(gPlate, px - nx[i]! * e, py - ny[i]! * e, mx, my, pw);
      gPlate.fill(mixHex(base, WHITE_HEX, clamp(0.26 + 0.2 * k, 0.04, 0.62)));
    }
  }

  /**
   * Stamp the overpass decoration onto the already-painted rear body.
   *
   * `punch` is 1 on frames where the simulation itself reports a pass-over; it
   * widens the halo and brightens the shadow, rim and glow. It is binary per
   * frame, deliberately unsmoothed.
   */
  private drawCrossings(punch: number): void {
    const count = this.geo.crossingCount;
    if (count === 0) return;
    const { x, y, radii, crossings } = this.geo;
    const n = this.n;
    const g = this.crossRimG;
    // Subtracting a neutral grey from a saturated neon tube leaves an ugly
    // complementary cast, so the shadow is pulled toward the body's own
    // mid-gradient hue - then the subtraction just removes brightness.
    const shadowCol = mixHex(SHADOW_HEX, this.colHex[n >> 1]!, 0.6);
    const rimC = mixHex(this.accentHex, WHITE_HEX, 0.18 + 0.24 * punch);
    const halo = 2.2 + 1.4 * punch;

    for (let c = 0; c < count; c++) {
      const cross = crossings[c]!;
      const f = cross.f;
      const r = radii[f]!;
      const d = clamp(cross.depth, 0, 1);
      const fx = x[f]!;
      const fy = y[f]!;
      // Offset down-right of the contact so this reads as a cast shadow rather
      // than a symmetric smudge.
      stampDisc(
        this.shadow,
        (fx + cross.x) * 0.5 + r * 0.36,
        (fy + cross.y) * 0.5 + r * 0.42,
        r * (2.1 + 0.5 * d),
        shadowCol,
        (0.52 + 0.3 * d) * (0.72 + 0.28 * punch),
      );

      // The contact rim: an over-wide bright capsule along the *front* tube.
      // `paintRange(split..0)` repaints that tube at its true width a moment
      // later, so all that survives is a couple of pixels of edge light
      // outlining the head end exactly where it sits on top of the body.
      const lo = Math.max(0, f - 1);
      const hi = Math.min(n - 1, f + 3);
      for (let i = hi; i > lo; i--) {
        capsulePath(
          g,
          x[i]!,
          y[i]!,
          x[i - 1]!,
          y[i - 1]!,
          Math.max(1, Math.trunc((Math.min(radii[i]!, radii[i - 1]!) + halo) * 2.0)),
        );
      }
      g.circle(x[lo]!, y[lo]!, Math.max(2, Math.trunc(radii[lo]! + halo)));
      g.circle(x[hi]!, y[hi]!, Math.max(2, Math.trunc(radii[hi]! + halo)));
      g.fill(rimC);

      stampGlow(
        this.crossGlow,
        fx,
        fy,
        r * 2.4,
        this.accentHex,
        (0.2 + 0.3 * d + 0.26 * punch) * this.gi,
      );
    }
  }

  // -------------------------------------------------------------------
  // head
  // -------------------------------------------------------------------

  /** Map a head-local (forward, left) unit point into world space. */
  private xform(
    u: number,
    v: number,
    ox: number,
    oy: number,
    fx: number,
    fy: number,
    lx: number,
    ly: number,
    su: number,
    sv: number,
    shear: number,
  ): void {
    const vv = v + shear * (0.6 - u);
    this.ux = ox + fx * u * su + lx * vv * sv;
    this.uy = oy + fy * u * su + ly * vv * sv;
  }

  private polyPath(
    g: Graphics,
    pts: readonly number[],
    ox: number,
    oy: number,
    fx: number,
    fy: number,
    lx: number,
    ly: number,
    su: number,
    sv: number,
    shear: number,
  ): void {
    for (let i = 0; i < pts.length; i += 2) {
      this.xform(pts[i]!, pts[i + 1]!, ox, oy, fx, fy, lx, ly, su, sv, shear);
      if (i === 0) g.moveTo(this.ux, this.uy);
      else g.lineTo(this.ux, this.uy);
    }
    g.closePath();
  }

  /**
   * Skull, jaw, tracking eyes, speed stretch and boost exhaust.
   *
   * The silhouette is a fixed 12-point outline in head-local space, so it costs
   * two polygon fills; stretching it along the heading at speed and shearing it
   * with the lean gives the head its whole range of expression for free.
   */
  private drawHead(heading: number, leanHead: number): void {
    const { x, y, radii } = this.geo;
    const n = this.n;
    const t = this.t;
    const gi = this.gi;
    const hx = x[0]!;
    const hy = y[0]!;
    const hr = radii[0]!;
    const ca = Math.cos(heading);
    const sa = Math.sin(heading);
    const px = -sa; // unit vector 90 degrees to the left
    const py = ca;

    const headCol = this.headColHex;
    const col0 = this.colHex[0]!;
    // The skull is pulled well toward the body colour: a near-white head would
    // swallow the white eyes and turn into a featureless blob.
    const fill = mixHex(col0, headCol, 0.28);
    const rim = mixHex(headCol, WHITE_HEX, 0.5);
    const hood = hr * 1.06;
    const sp = this.speed;
    const su = hood * (1.0 + 0.26 * sp); // stretch along the heading at speed
    const sv = hood * (1.0 - 0.1 * sp);
    const shear = clamp(leanHead, -1, 1) * 0.26;

    // ---- motion streaks ----------------------------------------------
    // Stamped glows rather than hard lines: at speed the head should smear, and
    // three rigid strokes trailing off a curved neck read as whiskers.
    if (sp > 0.3) {
      const k = (sp - 0.3) / 0.7;
      const streak = mixHex(col0, WHITE_HEX, 0.45);
      for (let j = 1; j < 4; j++) {
        const f = 1.0 - j / 4.0;
        const d = hood * (0.75 + 1.15 * j) * (0.65 + 0.55 * k);
        stampGlow(
          this.headUnder,
          hx - ca * d,
          hy - sa * d,
          hood * (1.5 - 0.22 * j),
          streak,
          (0.16 + 0.34 * k) * f * gi,
        );
      }
    }

    // ---- boost exhaust at the neck ------------------------------------
    if (this.boosting && n > 2) {
      const upto = Math.min(6, n);
      for (let i = 1; i < upto; i++) {
        const f = 1.0 - (i - 1) / 5.0;
        stampGlow(
          this.headUnder,
          x[i]!,
          y[i]!,
          radii[i]! * (1.45 + 0.75 * f),
          this.hotHex,
          (0.18 + 0.42 * f) * gi,
        );
      }
    }

    // Halo first so the crisp geometry sits on top of it.
    stampGlow(
      this.headUnder,
      hx,
      hy,
      hood * 3.0,
      headCol,
      (0.44 + 0.16 * pulse(t, 4.2)) * gi,
    );

    // ---- jaw, then skull ----------------------------------------------
    const g = this.headG;
    const jawCol = shadeHex(mixHex(col0, headCol, 0.1), 0.62);
    this.polyPath(
      g,
      JAW,
      hx + ca * hood * 0.06,
      hy + sa * hood * 0.06,
      ca,
      sa,
      px,
      py,
      su * 1.02,
      sv * 0.94,
      shear,
    );
    g.fill(jawCol);

    // Outer skull in the rim colour, then an inner one 2.4 px smaller in the
    // fill colour - a uniform rim without stroking anything.
    this.polyPath(g, SKULL, hx, hy, ca, sa, px, py, su, sv, shear);
    g.fill(rim);
    this.polyPath(
      g,
      SKULL,
      hx,
      hy,
      ca,
      sa,
      px,
      py,
      Math.max(1.0, su - 2.4),
      Math.max(1.0, sv - 2.4),
      shear,
    );
    g.fill(fill);

    // Mouth line: a dark crease from the nose back along the jaw.
    this.xform(0.3, 0.0, hx, hy, ca, sa, px, py, su, sv, shear);
    const lipX = this.ux;
    const lipY = this.uy;
    this.xform(1.3, 0.0, hx, hy, ca, sa, px, py, su, sv, shear);
    capsulePath(g, lipX, lipY, this.ux, this.uy, Math.max(1, Math.trunc(hood * 0.16)));
    g.fill(jawCol);

    // Broad specular sweep on the upper-left flank of the skull.
    stampGlow(
      this.headOver,
      hx - ca * hood * 0.16 + px * hood * 0.42,
      hy - sa * hood * 0.16 + py * hood * 0.42,
      hood * 0.66,
      WHITE_HEX,
      0.34 * gi,
    );

    // ---- eyes ----------------------------------------------------------
    const openF = blink(t);
    const eyeR = Math.max(1.8, hood * 0.27);
    const eyeD = hood * 0.62;
    const eyeSpread = 0.74; // radians either side of the heading
    const pupilR = Math.max(1.0, eyeR * 0.5);
    const dark = shadeHex(col0, 0.22);
    const eg = this.eyeG;

    for (let s = 0; s < 2; s++) {
      const side = s === 0 ? -1 : 1;
      const ang = heading + side * eyeSpread;
      const ex = hx + Math.cos(ang) * eyeD + px * shear * hood * 0.4;
      const ey = hy + Math.sin(ang) * eyeD + py * shear * hood * 0.4;
      stampGlow(this.headOver, ex, ey, eyeR * 2.4, this.accent2Hex, 0.34 * gi);
      eg.circle(ex, ey, Math.trunc(eyeR));
      eg.fill(SCLERA_HEX);
      // Pupil pushed forward so the snake visibly looks where it is going.
      eg.circle(ex + ca * eyeR * 0.4, ey + sa * eyeR * 0.4, Math.trunc(pupilR));
      eg.fill(dark);
      // A hairline socket keeps the eye legible on a pale skull without turning
      // the pair into goggles. pygame strokes inward from the radius, hence
      // `alignment: 1`.
      eg.circle(ex, ey, Math.trunc(eyeR) + 1);
      eg.stroke({ width: 1, color: dark, alignment: 1 });
      // Catchlight on the opposite side of the pupil.
      eg.circle(
        ex - ca * eyeR * 0.32 + px * eyeR * 0.34,
        ey - sa * eyeR * 0.32 + py * eyeR * 0.34,
        Math.max(1, Math.trunc(eyeR * 0.3)),
      );
      eg.fill(WHITE_HEX);

      if (openF < 0.999) {
        // Lids: two skull-coloured shutters closing over the eyeball.
        const drop = eyeR * (1.0 - openF);
        for (let k = 0; k < 2; k++) {
          const sg = k === 0 ? 1 : -1;
          const oy = sg * (eyeR - drop * 0.5);
          const a = oy + sg * drop * 0.5;
          const b = oy - sg * drop * 0.5;
          const reach = eyeR * 1.25;
          eg.moveTo(ex + px * a - ca * reach, ey + py * a - sa * reach);
          eg.lineTo(ex + px * a + ca * reach, ey + py * a + sa * reach);
          eg.lineTo(ex + px * b + ca * reach, ey + py * b + sa * reach);
          eg.lineTo(ex + px * b - ca * reach, ey + py * b - sa * reach);
          eg.closePath();
          eg.fill(fill);
        }
      }
    }
  }

  /** A rotating hexagonal energy ring locked around the head. */
  private drawShield(): void {
    const { x, y, radii } = this.geo;
    const cx = x[0]!;
    const cy = y[0]!;
    const hr = radii[0]!;
    const t = this.t;
    const gi = this.gi;
    const breathe = 1.0 + 0.055 * Math.sin(t * 4.4);
    const R = hr * 2.45 * breathe;
    const rot = t * 1.15;
    const bright = 0.55 + 0.45 * pulse(t, 5.0);

    // Soft containment bubble.
    stampGlow(
      this.shieldUnder,
      cx,
      cy,
      R * 1.05,
      this.accent2Hex,
      (0.2 * bright + 0.08) * gi,
    );

    const g = this.shieldG;
    for (let k = 0; k < 6; k++) {
      const a = rot + (k * TAU) / 6.0;
      const vx = cx + Math.cos(a) * R;
      const vy = cy + Math.sin(a) * R;
      if (k === 0) g.moveTo(vx, vy);
      else g.lineTo(vx, vy);
    }
    g.closePath();
    g.stroke({ width: 2, color: mixHex(this.accentHex, WHITE_HEX, 0.3 * bright) });

    // The counter-rotating inner ring is tinted with accent2 and pulses out of
    // phase with the outer one, so the two never read as one static shape.
    for (let k = 0; k < 6; k++) {
      const a = -rot * 0.65 + (k * TAU) / 6.0;
      const vx = cx + Math.cos(a) * R * 0.7;
      const vy = cy + Math.sin(a) * R * 0.7;
      if (k === 0) g.moveTo(vx, vy);
      else g.lineTo(vx, vy);
    }
    g.closePath();
    g.stroke({
      width: 2,
      color: mixHex(this.accent2Hex, WHITE_HEX, 0.45 - 0.35 * bright),
    });

    for (let k = 0; k < 6; k++) {
      const a = rot + (k * TAU) / 6.0;
      // Vertices flicker out of phase so the ring feels charged, not static.
      // `pulse` is called at its default speed here: the offset is a phase, not
      // a frequency. Do not "fix" it to pulse(t, 6).
      const flick = 0.45 + 0.55 * pulse(t * 6.0 + k * 1.05);
      stampGlow(
        this.shieldOver,
        cx + Math.cos(a) * R,
        cy + Math.sin(a) * R,
        hr * 0.52,
        this.accentHex,
        0.6 * flick * gi,
      );
    }
  }
}
