/**
 * The additive particle system - a port of `snake/gfx/particles.py`.
 *
 * One instance serves the whole game: the slither trail, pickup bursts, portal
 * shockwaves, ambient motes, death explosions, confetti and stray sparks all
 * come out of here. The Python original is owned by `Game`, updated once per
 * frame and *drawn* by whichever scene wants it, so this class owns a
 * {@link Container} that scenes re-parent with {@link attachTo} rather than
 * building one particle layer per scene.
 *
 * Three things carry over from the pygame implementation because they are what
 * the effect actually looks like:
 *
 * 1. **The glow sprite cache.** Every soft particle is one pre-rendered radial
 *    sprite blitted with `BLEND_RGB_ADD`, cached by (radius bucket, colour
 *    quantised to 10 levels per channel) *with the fade already multiplied in* -
 *    additive blending ignores alpha, so dimming a particle means adding a
 *    darker colour. The consequence worth protecting is the hot centre:
 *    `lerp(fadedColour, white, 0.45)`, which keeps a dim particle's core
 *    noticeably whiter than its halo. A single white texture with a tint and an
 *    alpha cannot express that - tinting scales the core down with everything
 *    else - so this module builds its own textures instead of reusing
 *    `radialTexture()` from `./textures`. The 10-level colour steps are visible
 *    by design.
 * 2. **Geometry on top of blobs.** Streaks, shards, rings, ribbons, bolts and
 *    stars are vector-drawn. Python collects them into a scratch layer that is
 *    composited after every blob, so they sit above the soft particles whatever
 *    order they spawned in. Here that is one `Graphics` rebuilt each frame and
 *    parented above the sprite container.
 * 3. **Oldest-first eviction at the cap.** At `MAX_PARTICLES` live records a new
 *    spawn evicts from the *front* of the list, so long-lived ambience dies
 *    before a fresh explosion does.
 *
 * Two structural departures from Python, both forced by retained mode:
 *
 * - `update()` advances the simulation and then syncs the display objects while
 *   the system is attached. Python can skip `draw` and the particles simply do
 *   not appear that frame; sprites left alone would instead freeze on screen.
 * - The live list is a fixed-capacity array with head/tail indices rather than a
 *   Python list that is sliced and rebuilt every frame, so a steady-state frame
 *   allocates nothing.
 *
 * Nothing here may throw at the caller: bad input is validated and clamped at
 * the emitters (a missing particle, never a crash), which is the same contract
 * as the original's blanket try/except without swallowing real bugs.
 */

import { Container, Graphics, Sprite, Texture } from "pixi.js";

import { MAX_DT, MAX_PARTICLES, SNAKE_HEAD_RADIUS, TRAIL_EMIT_RATE, WINDOW_H, WINDOW_W } from "../core/config";
import { clamp, TAU, type RectLike } from "../core/mathx";
import {
  clamp8,
  lerpColor,
  shade,
  UI_GOLD,
  UI_GOOD,
  UI_WHITE,
  type RGB,
  type Theme,
} from "../core/palette";
import { canvasTexture, clearToBlack, context2d, createCanvas, cssRgb } from "./textures";

// ---------------------------------------------------------------------------
// Kinds
// ---------------------------------------------------------------------------

/**
 * Every renderable particle kind.
 *
 * - `dot` soft round blob (the workhorse)
 * - `spark` velocity-aligned streak
 * - `ember` blob that twinkles on a per-particle phase
 * - `shard` spinning irregular triangle
 * - `ring` hollow expanding shockwave
 * - `trail` tapered ribbon stretched between last and current position
 * - `bolt` short jagged lightning segment
 * - `smoke` soft puff that expands and fades away
 * - `star` four-point twinkle
 */
export const KINDS = [
  "dot",
  "spark",
  "ember",
  "shard",
  "ring",
  "trail",
  "bolt",
  "smoke",
  "star",
] as const;

export type ParticleKind = (typeof KINDS)[number];

// Internally a kind is a small integer so the draw loop compares numbers. The
// ordering is chosen so that "is this drawn as geometry?" is one comparison:
// blobs below K_SPARK, vector shapes at or above it.
const K_DOT = 0;
const K_EMBER = 1;
const K_SMOKE = 2;
const K_SPARK = 3;
const K_SHARD = 4;
const K_RING = 5;
const K_TRAIL = 6;
const K_BOLT = 7;
const K_STAR = 8;

const KIND_IDS = new Map<string, number>([
  ["dot", K_DOT],
  ["ember", K_EMBER],
  ["smoke", K_SMOKE],
  ["spark", K_SPARK],
  ["shard", K_SHARD],
  ["ring", K_RING],
  ["trail", K_TRAIL],
  ["bolt", K_BOLT],
  ["star", K_STAR],
]);

/** Unknown kinds degrade to `dot` rather than dropping the particle. */
function kindId(kind: string | undefined): number {
  if (kind === undefined) return K_DOT;
  return KIND_IDS.get(kind) ?? K_DOT;
}

// ---------------------------------------------------------------------------
// Glow sprite cache
// ---------------------------------------------------------------------------

/** Colour levels per channel before a sprite is cached. */
const COLOR_LEVELS = 10;
const COLOR_STEP = 255.0 / (COLOR_LEVELS - 1);

/** Above this many cached textures the whole cache is thrown away. */
const CACHE_LIMIT = 768;

/** Concentric bands used to rasterise one glow sprite. */
const GLOW_BANDS = 12;

/**
 * A glow sprite is much larger than the particle's solid core - the halo *is*
 * the neon look. `spriteRadius = core * GLOW_EXTENT + GLOW_PAD`.
 */
const GLOW_EXTENT = 2.0;
const GLOW_PAD = 2.5;

const WHITE: RGB = [255, 255, 255];
const BLACK: RGB = [0, 0, 0];

const glowCache = new Map<number, Texture>();

/**
 * Textures dropped by a cache flush. They are destroyed at the *start* of the
 * next sync, once every pooled sprite has been re-pointed, because a flush can
 * happen half way through a sync with sprites already holding the old texture.
 */
const retiredTextures: Texture[] = [];

/** Snap a radius onto a coarse ladder so sprites are shared aggressively. */
function bucketRadius(r: number): number {
  if (r <= 2.0) return 2;
  if (r < 16.0) return Math.trunc(r + 0.5);
  if (r < 40.0) return Math.trunc(r * 0.5 + 0.5) * 2;
  const big = Math.trunc(r * 0.25 + 0.5) * 4;
  return big < 120 ? big : 120;
}

/**
 * One channel to its cache level.
 *
 * Used both for the lookup in the draw loop and for the build, so the two can
 * never disagree - a mismatched key would miss the cache forever and rebuild a
 * texture every frame.
 */
function quantiseChannel(v: number): number {
  if (!(v > 0.0)) return 0;
  return Math.trunc((v > 255.0 ? 255.0 : v) / COLOR_STEP + 0.5);
}

/** Turn a quantised level back into a real channel value. */
function levelChannel(q: number): number {
  return clamp8(q * COLOR_STEP);
}

/**
 * Rasterise one radial glow sprite: solid core plus a soft falloff halo.
 *
 * The canvas is opaque black, as the pygame surface is: under additive blending
 * a black pixel adds nothing, so the square corners are invisible and no alpha
 * channel is needed.
 */
function buildGlow(radius: number, color: RGB): Texture {
  const ext = Math.max(2, Math.trunc(radius * GLOW_EXTENT + GLOW_PAD));
  const size = ext * 2;
  const canvas = createCanvas(size, size);
  const ctx = context2d(canvas);
  clearToBlack(ctx, size, size);

  // The fraction of the sprite that is fully lit; outside it the falloff is
  // quadratic to nothing at the rim.
  const core = clamp(radius / ext, 0.05, 0.95);
  // Outer to inner, so each brighter band overwrites the dimmer one. pygame
  // centres these on pixel (ext, ext); the canvas centre (ext, ext) sits on the
  // pixel corner instead, which is the true middle of a 2*ext square and drops
  // pygame's half-pixel bias. Deliberate: the sprite is anchored at 0.5.
  for (let band = GLOW_BANDS; band > 0; band--) {
    const q = band / GLOW_BANDS;
    let inten: number;
    if (q <= core) {
      inten = 1.0;
    } else {
      const fall = (q - core) / (1.0 - core);
      inten = (1.0 - fall) * (1.0 - fall);
    }
    const bandCol = shade(color, inten);
    if (bandCol[0] || bandCol[1] || bandCol[2]) {
      ctx.fillStyle = cssRgb(bandCol);
      ctx.beginPath();
      ctx.arc(ext, ext, Math.max(1, Math.trunc(ext * q)), 0, TAU);
      ctx.fill();
    }
  }

  // A white-hot centre: additive light saturates toward white in reality, and
  // it keeps small particles from reading as flat coloured dots.
  ctx.fillStyle = cssRgb(lerpColor(color, WHITE, 0.45));
  ctx.beginPath();
  ctx.arc(ext, ext, Math.max(1, Math.trunc(radius * 0.45)), 0, TAU);
  ctx.fill();

  return canvasTexture(canvas);
}

/**
 * The cached texture for a radius bucket and a quantised colour.
 *
 * Returns null when the colour quantises to black - that adds no light, so
 * there is nothing to draw and nothing worth caching.
 */
function glowFor(radius: number, r: number, g: number, b: number, fade: number): Texture | null {
  if (!(fade > 0.0)) return null;
  const qr = quantiseChannel(r * fade);
  const qg = quantiseChannel(g * fade);
  const qb = quantiseChannel(b * fade);
  if (!(qr || qg || qb)) return null;
  const rb = bucketRadius(radius);
  // Packed key: radius bucket is at most 120 (7 bits), each level 0..9 (4 bits).
  const key = (rb << 12) | (qr << 8) | (qg << 4) | qb;
  const hit = glowCache.get(key);
  if (hit !== undefined) return hit;
  if (glowCache.size >= CACHE_LIMIT) clearGlowCache();
  const tex = buildGlow(rb, [levelChannel(qr), levelChannel(qg), levelChannel(qb)]);
  glowCache.set(key, tex);
  return tex;
}

/**
 * Cached additive glow texture for a radius/colour/brightness combination -
 * the public face of the cache, for anything outside this module that wants the
 * same look. Null means "pure black, nothing to add".
 */
export function glowTexture(radius: number, color: RGB, fade = 1.0): Texture | null {
  return glowFor(radius, color[0], color[1], color[2], fade);
}

/**
 * Drop every cached sprite (a display-mode change, a context loss, tests).
 *
 * The textures are retired rather than destroyed on the spot: live sprites may
 * still point at them until the next sync re-points every one of them.
 */
export function clearGlowCache(): void {
  for (const tex of glowCache.values()) retiredTextures.push(tex);
  glowCache.clear();
}

/** How many glow textures are cached, for the debug overlay and tests. */
export function glowCacheSize(): number {
  return glowCache.size;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** A scalar, or a `[lo, hi]` pair to draw uniformly from. */
export type Ranged = number | readonly [number, number];

/** Anything rectangle-shaped an emitter will accept. */
export type RectSource = RectLike | readonly [number, number, number, number];

function rngRange(v: Ranged | undefined, def: number): number {
  if (v === undefined || v === null) return def;
  if (typeof v === "number") return Number.isFinite(v) ? v : def;
  const lo = Number(v[0]);
  const hi = Number(v[1]);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return def;
  return hi <= lo ? lo : lo + Math.random() * (hi - lo);
}

/** Read x/y/w/h out of either rectangle shape, without allocating. */
const rectScratch = { x: 0, y: 0, w: 0, h: 0 };

function readRect(rect: RectSource | null | undefined): RectLike {
  const s = rectScratch;
  s.x = s.y = s.w = s.h = 0;
  if (!rect) return s;
  if (Array.isArray(rect)) {
    s.x = Number(rect[0]) || 0;
    s.y = Number(rect[1]) || 0;
    s.w = Number(rect[2]) || 0;
    s.h = Number(rect[3]) || 0;
    return s;
  }
  const r = rect as RectLike;
  s.x = Number(r.x) || 0;
  s.y = Number(r.y) || 0;
  s.w = Number(r.w) || 0;
  s.h = Number(r.h) || 0;
  return s;
}

/**
 * How many particles to emit this frame for a per-second `rate`.
 *
 * The fractional remainder is resolved stochastically, which keeps emission
 * smooth without an accumulator per caller - and gives thin trails their
 * characteristic scatter, so it is not an implementation detail to tidy away.
 */
function emitCount(rate: number, dt: number): number {
  const n = rate * dt;
  if (!(n > 0.0)) return 0;
  let whole = Math.trunc(n);
  if (Math.random() < n - whole) whole += 1;
  return whole < 64 ? whole : 64; // sanity cap on a monster dt
}

/** The "just ignited" version of a colour: pushed toward white. */
export function hotWhite(color: RGB, amount = 0.7): RGB {
  return lerpColor(color, WHITE, clamp(amount, 0.0, 1.0));
}

/** Pack three float channels into `0xRRGGBB` without allocating a tuple. */
function packRgb(r: number, g: number, b: number): number {
  return (clamp8(r) << 16) | (clamp8(g) << 8) | clamp8(b);
}

// ---------------------------------------------------------------------------
// Particle record
// ---------------------------------------------------------------------------

/**
 * One live particle. A plain mutable record, pooled and re-armed on spawn.
 *
 * Colours are kept as loose channels rather than RGB tuples: the draw loop
 * blends them every frame and a tuple per particle per frame is exactly the
 * allocation this system exists to avoid.
 */
export class Particle {
  x = 0.0;
  y = 0.0;
  /** Previous position, used by the `trail` ribbon. */
  px = 0.0;
  py = 0.0;
  vx = 0.0;
  vy = 0.0;
  /** Current draw radius; the draw pass writes the shrink-adjusted value here. */
  radius = 1.0;
  /** Birth radius, the shrink baseline. `grow` overwrites it every frame. */
  r0 = 1.0;
  cr = 255;
  cg = 255;
  cb = 255;
  /** Optional death colour; `hasEnd` false means no ramp and no arithmetic. */
  er = 0;
  eg = 0;
  eb = 0;
  hasEnd = false;
  life = 0.0;
  maxLife = 1.0;
  drag = 0.0;
  gravity = 0.0;
  glow = true;
  shrink = true;
  /** rad/s - except on a `ring`, where it carries the stroke width fraction. */
  spin = 0.0;
  angle = 0.0;
  /** px/s of radius growth (rings, smoke). */
  grow = 0.0;
  kind: number = K_DOT;
  /** Phase for the ember twinkle, the bolt flicker and the turbulence field. */
  seed = 0.0;
  turbulence = 0.0;
}

// ---------------------------------------------------------------------------
// Emitter option shapes
// ---------------------------------------------------------------------------

export interface SpawnOptions {
  vx?: number;
  vy?: number;
  radius?: number;
  color?: RGB;
  life?: number;
  drag?: number;
  gravity?: number;
  glow?: boolean;
  shrink?: boolean;
  spin?: number;
  kind?: ParticleKind | string;
  grow?: number;
  colorEnd?: RGB | null;
  turbulence?: number;
}

export interface BurstOptions {
  count?: number;
  speed?: Ranged;
  life?: Ranged;
  radius?: Ranged;
  /** Total cone width in radians; omitted means "all directions". */
  spread?: number | null;
  /** Centre angle in radians; omitted means "all directions". */
  direction?: number | null;
  glow?: boolean;
  colorEnd?: RGB | null;
  turbulence?: number;
  gravity?: number;
  kind?: ParticleKind | string | null;
}

export interface TrailOptions {
  rate?: number;
  spread?: number;
  speed?: Ranged;
  life?: Ranged;
  radius?: Ranged;
  colorEnd?: RGB | null;
  turbulence?: number;
  /** 0..1 chance that an emitted particle is a stretched ribbon. */
  ribbon?: number;
}

export interface RingOptions {
  radius?: number;
  count?: number;
  life?: number;
  speed?: number;
  colorEnd?: RGB | null;
  /** Stroke width as a fraction of the ring radius. */
  width?: number;
}

export interface SparkLineOptions {
  count?: number;
  life?: number;
  colorEnd?: RGB | null;
  bolts?: number;
}

export interface AmbientOptions {
  rate?: number;
  turbulence?: number;
  /** 0..1 chance a mote is a four-point star. */
  twinkle?: number;
}

export interface ExplosionOptions {
  power?: number;
  smoke?: boolean;
  gravity?: number;
}

export interface ConfettiOptions {
  count?: number;
  life?: Ranged;
  gravity?: number;
  fromTop?: boolean;
}

export interface StreamOptions {
  rate?: number;
  speed?: Ranged;
  spread?: number;
  life?: Ranged;
  radius?: Ranged;
  colorEnd?: RGB | null;
  turbulence?: number;
  drag?: number;
}

export interface ImplodeOptions {
  radius?: number;
  count?: number;
  life?: number;
  swirl?: number;
  colorEnd?: RGB | null;
}

// ---------------------------------------------------------------------------
// Draw constants
// ---------------------------------------------------------------------------

/** Particles further outside the design canvas than this are not drawn. */
const CULL_MARGIN = 140.0;

// Scene call-site constants. These are module constants of
// `snake/scenes/gameplay.py` in the original and are repeated here only for the
// preset emitters at the end of the class.

/** `gameplay.py:100` - the boost wake runs 2.3x the base trail rate. */
const TRAIL_RATE_BOOST = TRAIL_EMIT_RATE * 2.3;
/** `gameplay.py:101` - arena motes per second. */
const ARENA_MOTE_RATE = 3.0;
/** `gameplay.py:128` - cross-over wash, particles per second. */
const CROSS_WASH_RATE = 62.0;

/** Reusable stroke style. Pixi copies it, so one object serves every stroke. */
const strokeScratch: {
  color: number;
  width: number;
  alignment: number;
  cap: "butt";
  join: "miter";
} = { color: 0xffffff, width: 1, alignment: 0.5, cap: "butt", join: "miter" };

// ---------------------------------------------------------------------------
// The system
// ---------------------------------------------------------------------------

export class ParticleSystem {
  /** Hard cap on live particles. */
  readonly max: number;

  /** Attach this to a scene. Holds the blob sprites and the geometry layer. */
  readonly root = new Container();

  private readonly content = new Container();
  private readonly blobs = new Container();
  private readonly geometry = new Graphics();
  private clipMask: Graphics | null = null;

  /**
   * Live records in age order, oldest at `head`. Capacity is twice the cap so a
   * frame's spawns can run past the cap before the next update compacts them;
   * eviction then costs one index bump instead of a list splice.
   */
  private readonly items: (Particle | undefined)[];
  private head = 0;
  private tail = 0;
  private readonly capacity: number;

  /** Free records. `poolCap` matches Python: at most `max` are ever kept. */
  private readonly pool: (Particle | undefined)[];
  private poolCount = 0;
  private readonly poolCap: number;

  /** Geometry particles collected by the blob pass, drawn after it. */
  private readonly geomBuf: (Particle | undefined)[];

  /** Sprite pool. Index order is arbitrary; additive blending is commutative. */
  private readonly sprites: Sprite[] = [];
  private spriteHigh = 0;

  /** System clock, driving the ember twinkle, the bolt flicker, turbulence. */
  private t = 0.0;
  private destroyed = false;

  constructor(maxParticles: number = MAX_PARTICLES) {
    this.max = Math.max(16, Math.trunc(maxParticles));
    this.capacity = this.max * 2;
    this.poolCap = this.max;
    this.items = new Array<Particle | undefined>(this.capacity).fill(undefined);
    this.pool = new Array<Particle | undefined>(this.poolCap).fill(undefined);
    this.geomBuf = new Array<Particle | undefined>(this.max).fill(undefined);

    this.geometry.blendMode = "add";
    this.content.addChild(this.blobs);
    this.content.addChild(this.geometry);
    this.root.addChild(this.content);
  }

  // -- housekeeping ------------------------------------------------------

  /** Number of live particles. */
  get count(): number {
    return this.tail - this.head;
  }

  /** How many more particles fit before the cap starts evicting. */
  headroom(): number {
    const room = this.max - (this.tail - this.head);
    return room > 0 ? room : 0;
  }

  /** How many sprites the pool has grown to, for the debug overlay. */
  get spriteCount(): number {
    return this.sprites.length;
  }

  /** Kill everything instantly (scene changes, restarts). */
  clear(): void {
    const items = this.items;
    for (let i = this.head; i < this.tail; i++) {
      const p = items[i];
      if (p && this.poolCount < this.poolCap) this.pool[this.poolCount++] = p;
      items[i] = undefined;
    }
    this.head = 0;
    this.tail = 0;
  }

  /** Put the particle layer into a scene, optionally at a specific depth. */
  attachTo(parent: Container, index?: number): void {
    if (this.destroyed) return;
    if (index === undefined) parent.addChild(this.root);
    else parent.addChildAt(this.root, index);
  }

  /** Take the layer back out. The particles keep living and moving. */
  detach(): void {
    this.root.parent?.removeChild(this.root);
  }

  /**
   * Confine the particles to a rectangle - gameplay clips them to the arena
   * (`set_clip` in Python). Pass null to unclip; scenes must do that on exit
   * because the system outlives them.
   */
  setClipRect(rect: RectSource | null): void {
    if (this.destroyed) return;
    if (!rect) {
      if (this.clipMask) {
        this.content.mask = null;
        this.root.removeChild(this.clipMask);
        this.clipMask.destroy();
        this.clipMask = null;
      }
      return;
    }
    const r = readRect(rect);
    let g = this.clipMask;
    if (!g) {
      g = new Graphics();
      this.clipMask = g;
      this.root.addChild(g);
      this.content.mask = g;
    }
    g.clear();
    g.rect(r.x, r.y, r.w, r.h).fill(0xffffff);
  }

  /** Release the display objects. The shared glow cache is left alone. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clear();
    this.content.mask = null;
    this.root.destroy({ children: true });
    this.sprites.length = 0;
    this.clipMask = null;
  }

  private acquire(): Particle {
    const items = this.items;
    // Oldest live particles sit at the front, so the cap kills ambience before
    // it kills the explosion that just triggered.
    const over = this.tail - this.head - this.max + 1;
    if (over > 0) {
      for (let i = 0; i < over; i++) {
        const p = items[this.head + i];
        if (p && this.poolCount < this.poolCap) this.pool[this.poolCount++] = p;
        items[this.head + i] = undefined;
      }
      this.head += over;
    }
    if (this.tail >= this.capacity) this.compact();
    const free = this.poolCount > 0 ? this.pool[--this.poolCount] : undefined;
    return free ?? new Particle();
  }

  /** Slide the live range back to index 0. Order is preserved. */
  private compact(): void {
    const items = this.items;
    let n = 0;
    for (let i = this.head; i < this.tail; i++) {
      const p = items[i];
      if (p) items[n++] = p;
    }
    for (let i = n; i < this.tail; i++) items[i] = undefined;
    this.head = 0;
    this.tail = n;
  }

  // -- emission ----------------------------------------------------------

  /**
   * Add a single particle. Never throws; returns the record or null.
   *
   * `colorEnd` makes the particle ramp from `color` at birth to `colorEnd` at
   * death. `turbulence` (px/s^2) adds a smooth curl-like drift so the particle
   * swirls instead of travelling in a straight line.
   */
  spawn(x: number, y: number, o: SpawnOptions = {}): Particle | null {
    if (this.destroyed) return null;
    const vx = o.vx ?? 0.0;
    const vy = o.vy ?? 0.0;
    const radius = o.radius ?? 3.0;
    const life = o.life ?? 0.8;
    const drag = o.drag ?? 1.6;
    const gravity = o.gravity ?? 0.0;
    const spin = o.spin ?? 0.0;
    const grow = o.grow ?? 0.0;
    const turbulence = o.turbulence ?? 0.0;
    // Reject NaN / inf up front. One non-finite particle would otherwise throw
    // inside the draw loop every frame it lived for, taking the whole frame's
    // particles with it. Summing means one check covers every field.
    if (
      !Number.isFinite(
        x + y + vx + vy + radius + life + drag + gravity + spin + grow + turbulence,
      )
    ) {
      return null;
    }

    const p = this.acquire();
    p.x = x;
    p.y = y;
    p.px = x;
    p.py = y;
    p.vx = vx;
    p.vy = vy;
    p.radius = radius > 0.5 ? radius : 0.5;
    p.r0 = p.radius;
    const col = o.color !== undefined && o.color.length >= 3 ? o.color : UI_WHITE;
    p.cr = clamp8(col[0]);
    p.cg = clamp8(col[1]);
    p.cb = clamp8(col[2]);
    const end = o.colorEnd;
    if (end !== undefined && end !== null && end.length >= 3) {
      p.hasEnd = true;
      p.er = clamp8(end[0]);
      p.eg = clamp8(end[1]);
      p.eb = clamp8(end[2]);
    } else {
      p.hasEnd = false;
      p.er = p.eg = p.eb = 0;
    }
    p.life = life > 0.01 ? life : 0.01;
    p.maxLife = p.life > 1e-6 ? p.life : 1e-6;
    p.drag = drag;
    p.gravity = gravity;
    p.glow = o.glow ?? true;
    p.shrink = o.shrink ?? true;
    p.spin = spin;
    p.angle = Math.random() * TAU;
    p.grow = grow;
    p.kind = kindId(o.kind);
    p.seed = Math.random() * TAU;
    p.turbulence = turbulence;

    this.items[this.tail++] = p;
    return p;
  }

  /**
   * Explode `count` particles out of a point.
   *
   * `direction` is the centre angle (null = all directions) and `spread` the
   * total cone width, both in radians.
   */
  burst(x: number, y: number, color: RGB, o: BurstOptions = {}): void {
    const spread = o.spread ?? null;
    const direction = o.direction ?? null;
    const glow = o.glow ?? true;
    const end = o.colorEnd ?? null;
    let base: number;
    let half: number;
    let omni: boolean;
    if (direction === null) {
      base = 0.0;
      half = spread === null ? Math.PI : spread * 0.5;
      omni = spread === null;
    } else {
      base = direction;
      half = (spread === null ? 0.9 : spread) * 0.5;
      omni = false;
    }
    const n = Math.trunc(clamp(o.count ?? 18, 0, 400));
    const kind = o.kind ?? null;
    for (let i = 0; i < n; i++) {
      // Even angular spacing plus jitter avoids clumpy explosions.
      const ang = omni
        ? (i / n) * TAU + (Math.random() * 0.44 - 0.22)
        : base + (Math.random() * 2 - 1) * half;
      let sp = rngRange(o.speed ?? [40.0, 190.0], 90.0);
      const r = rngRange(o.radius ?? [2.0, 5.0], 3.0);
      // Small particles are flung further: reads as a hot core with fast
      // outriders instead of a uniform shell.
      sp *= clamp(1.25 - 0.1 * r, 0.35, 1.25);
      this.spawn(x, y, {
        vx: Math.cos(ang) * sp,
        vy: Math.sin(ang) * sp,
        radius: r,
        color,
        life: rngRange(o.life ?? [0.35, 0.9], 0.6),
        drag: 1.4 + Math.random() * 1.2,
        glow,
        spin: Math.random() * 14.0 - 7.0,
        gravity: o.gravity ?? 0.0,
        colorEnd: end,
        turbulence: o.turbulence ?? 0.0,
        kind: kind !== null ? kind : glow && i % 4 === 0 ? "spark" : "dot",
      });
    }
  }

  /**
   * Continuous emission from a moving point (the snake head).
   *
   * `ribbon` is the chance that an emitted particle is a stretched `trail`
   * rather than a blob, for a silkier wake.
   */
  trail(x: number, y: number, color: RGB, dt: number, o: TrailOptions = {}): void {
    const spread = o.spread ?? 0.9;
    const end = o.colorEnd ?? null;
    const rib = clamp(o.ribbon ?? 0.0, 0.0, 1.0);
    const n = emitCount(o.rate ?? TRAIL_EMIT_RATE, dt);
    for (let i = 0; i < n; i++) {
      const ang = Math.random() * TAU;
      const sp = rngRange(o.speed ?? [8.0, 44.0], 24.0);
      const roll = Math.random();
      this.spawn(
        // Jitter the origin a touch so the trail has body, not a wire.
        x + Math.cos(ang) * spread * 3.0,
        y + Math.sin(ang) * spread * 3.0,
        {
          vx: Math.cos(ang) * sp,
          vy: Math.sin(ang) * sp,
          radius: rngRange(o.radius ?? [2.0, 5.0], 3.0),
          color,
          life: rngRange(o.life ?? [0.25, 0.6], 0.4),
          drag: 2.2,
          colorEnd: end,
          turbulence: o.turbulence ?? 0.0,
          kind: roll < rib ? "trail" : roll < rib + 0.22 ? "ember" : "dot",
        },
      );
    }
  }

  /** A shockwave: one expanding hollow circle plus a ring of outriders. */
  ring(x: number, y: number, color: RGB, o: RingOptions = {}): void {
    const radius = o.radius ?? 40.0;
    const end = o.colorEnd ?? null;
    const speed = o.speed ?? 120.0;
    const life = Math.max(0.05, o.life ?? 0.6);
    // The hollow circle grows from a point to `radius` over its life.
    const wave = this.spawn(x, y, {
      radius: Math.max(2.0, radius * 0.12),
      color,
      life,
      drag: 0.0,
      shrink: false,
      kind: "ring",
      grow: Math.max(0.0, radius) / life,
      colorEnd: end,
    });
    if (wave !== null) {
      // `spin` is unused by rings, so it carries the stroke width fraction
      // instead - no extra field for a one-kind parameter.
      wave.spin = clamp(o.width ?? 0.1, 0.02, 0.5);
    }
    const n = Math.trunc(clamp(o.count ?? 26, 0, 200));
    for (let i = 0; i < n; i++) {
      const ang = (i / n) * TAU;
      const ca = Math.cos(ang);
      const sa = Math.sin(ang);
      const r0 = radius * 0.18;
      this.spawn(x + ca * r0, y + sa * r0, {
        vx: ca * speed,
        vy: sa * speed,
        radius: 2.0 + Math.random() * 2.0,
        color,
        life: life * (0.6 + Math.random() * 0.5),
        drag: 2.4,
        colorEnd: end,
      });
    }
  }

  /**
   * Scatter sparks along a segment (laser gates, self-collision flashes).
   *
   * `bolts` additionally drops that many jagged lightning fragments along the
   * same line.
   */
  sparkLine(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    color: RGB,
    o: SparkLineOptions = {},
  ): void {
    const end = o.colorEnd ?? null;
    const life = Math.max(0.05, o.life ?? 0.4);
    const dx = x2 - x1;
    const dy = y2 - y1;
    const length = Math.hypot(dx, dy);
    // Unit normal to the segment: sparks kick sideways off the line.
    const nx = length < 1e-6 ? 0.0 : -dy / length;
    const ny = length < 1e-6 ? -1.0 : dx / length;
    const n = Math.trunc(clamp(o.count ?? 12, 0, 200));
    for (let i = 0; i < n; i++) {
      const t = (i + Math.random()) / Math.max(1, n);
      const side = Math.random() < 0.5 ? -1.0 : 1.0;
      const sp = 50.0 + Math.random() * 130.0;
      this.spawn(x1 + dx * t, y1 + dy * t, {
        vx: nx * side * sp + (Math.random() * 60.0 - 30.0),
        vy: ny * side * sp + (Math.random() * 60.0 - 30.0),
        radius: 1.8 + Math.random() * 1.6,
        color,
        life: life * (0.6 + Math.random() * 0.6),
        drag: 3.0,
        colorEnd: end,
        kind: "spark",
      });
    }
    const nb = Math.trunc(clamp(o.bolts ?? 0, 0, 40));
    for (let i = 0; i < nb; i++) {
      const t = Math.random();
      this.spawn(x1 + dx * t, y1 + dy * t, {
        radius: 3.0 + Math.random() * 3.0,
        color: hotWhite(color, 0.5),
        colorEnd: end ?? color,
        life: life * (0.4 + Math.random() * 0.4),
        drag: 6.0,
        shrink: false,
        kind: "bolt",
      });
    }
  }

  /**
   * Slow drifting motes inside `rect`, for atmosphere behind the action.
   *
   * `twinkle` is the chance a mote is a four-point star.
   */
  ambient(rect: RectSource, color: RGB, dt: number, o: AmbientOptions = {}): void {
    const r = readRect(rect);
    if (r.w <= 1.0 || r.h <= 1.0) return;
    const tw = clamp(o.twinkle ?? 0.0, 0.0, 1.0);
    const turbulence = o.turbulence ?? 0.0;
    const n = emitCount(o.rate ?? 6.0, dt);
    for (let i = 0; i < n; i++) {
      const roll = Math.random();
      this.spawn(r.x + Math.random() * r.w, r.y + Math.random() * r.h, {
        vx: Math.random() * 28.0 - 14.0,
        vy: -4.0 - Math.random() * 18.0,
        radius: 1.6 + Math.random() * 2.0,
        color,
        life: 2.0 + Math.random() * 3.0,
        drag: 0.25,
        shrink: false,
        kind: roll < tw ? "star" : roll < tw + 0.08 ? "shard" : "dot",
        turbulence,
        spin: Math.random() * 3.2 - 1.6,
      });
    }
  }

  /**
   * A layered detonation: shockwave ring, shards, embers, smoke and bolts.
   *
   * `power` scales both the counts and the reach; 1.0 is a food orb popping,
   * 2.5 is a death. One call so callers do not hand-tune four emitters.
   */
  explosion(x: number, y: number, color: RGB, o: ExplosionOptions = {}): void {
    const pw = clamp(o.power ?? 1.0, 0.15, 4.0);
    const gravity = o.gravity ?? 0.0;
    const hot = hotWhite(color, 0.72);
    const dark = shade(color, 0.06);

    // 1. shockwave: hot at birth, cooling into the base colour.
    this.ring(x, y, hot, {
      radius: 64.0 * pw,
      count: Math.trunc(8 * pw),
      life: 0.34 + 0.16 * pw,
      speed: 150.0 * pw,
      colorEnd: color,
      width: 0.09,
    });

    // 2. shards - the fast, hard-edged debris.
    let n = Math.trunc(clamp(9.0 * pw, 3, 46));
    for (let i = 0; i < n; i++) {
      const ang = (i / n) * TAU + (Math.random() * 0.6 - 0.3);
      const sp = (120.0 + Math.random() * 220.0) * pw;
      this.spawn(x, y, {
        vx: Math.cos(ang) * sp,
        vy: Math.sin(ang) * sp,
        radius: (2.4 + Math.random() * 2.8) * (0.7 + 0.3 * pw),
        color: hot,
        colorEnd: dark,
        life: (0.35 + Math.random() * 0.4) * (0.8 + 0.3 * pw),
        drag: 2.2,
        gravity,
        kind: "shard",
        spin: Math.random() * 20.0 - 10.0,
        turbulence: 40.0,
      });
    }

    // 3. embers - slower, twinkling, swirled by turbulence.
    n = Math.trunc(clamp(15.0 * pw, 6, 70));
    for (let i = 0; i < n; i++) {
      const ang = Math.random() * TAU;
      const sp = (30.0 + Math.random() * 180.0) * pw;
      this.spawn(x, y, {
        vx: Math.cos(ang) * sp,
        vy: Math.sin(ang) * sp,
        radius: 1.8 + Math.random() * 2.4,
        color: hot,
        colorEnd: dark,
        life: 0.5 + Math.random() * 0.8,
        drag: 1.7,
        gravity,
        kind: "ember",
        turbulence: 30.0 + Math.random() * 65.0,
      });
    }

    // 4. smoke - soft expanding puffs that linger after the light dies.
    if (o.smoke ?? true) {
      n = Math.trunc(clamp(6.0 * pw, 2, 26));
      for (let i = 0; i < n; i++) {
        const ang = Math.random() * TAU;
        const sp = (10.0 + Math.random() * 60.0) * pw;
        const r = (7.0 + Math.random() * 8.0) * (0.7 + 0.4 * pw);
        this.spawn(x, y, {
          vx: Math.cos(ang) * sp,
          vy: Math.sin(ang) * sp,
          radius: r,
          color: shade(color, 0.5),
          colorEnd: BLACK,
          life: 0.7 + Math.random() * 0.8,
          drag: 1.1,
          shrink: false,
          grow: r * 1.4,
          kind: "smoke",
          turbulence: 10.0 + Math.random() * 30.0,
        });
      }
    }

    // 5. a couple of lightning fragments for the first instant.
    n = Math.trunc(clamp(2.0 * pw, 1, 8));
    for (let i = 0; i < n; i++) {
      const ang = Math.random() * TAU;
      const sp = (60.0 + Math.random() * 120.0) * pw;
      this.spawn(x, y, {
        vx: Math.cos(ang) * sp,
        vy: Math.sin(ang) * sp,
        radius: (4.0 + Math.random() * 4.0) * pw,
        color: hot,
        colorEnd: color,
        life: 0.1 + Math.random() * 0.12,
        drag: 5.0,
        shrink: false,
        kind: "bolt",
      });
    }
  }

  /**
   * Victory-screen confetti: spinning shards raining through `rect`.
   *
   * With `fromTop` the shards start just above the rect and fall through it;
   * otherwise they are scattered across the whole rect at once.
   */
  confetti(rect: RectSource, colors: readonly RGB[], o: ConfettiOptions = {}): void {
    const r = readRect(rect);
    if (r.w <= 1.0 || r.h <= 1.0) return;
    const pal: readonly RGB[] = colors && colors.length ? colors : [UI_GOLD, UI_WHITE, UI_GOOD];
    const fromTop = o.fromTop ?? true;
    const n = Math.trunc(clamp(o.count ?? 70, 0, 400));
    for (let i = 0; i < n; i++) {
      const col = pal[i % pal.length] ?? UI_GOLD;
      this.spawn(
        r.x + Math.random() * r.w,
        fromTop ? r.y - Math.random() * r.h * 0.45 : r.y + Math.random() * r.h,
        {
          vx: Math.random() * 140.0 - 70.0,
          vy: 20.0 + Math.random() * 110.0,
          radius: 2.6 + Math.random() * 2.8,
          color: col,
          colorEnd: shade(col, 0.25),
          life: rngRange(o.life ?? [1.6, 3.4], 2.2),
          drag: 0.55,
          gravity: o.gravity ?? 240.0,
          shrink: false,
          spin: Math.random() * 18.0 - 9.0,
          turbulence: 20.0 + Math.random() * 50.0,
          kind: i % 5 === 0 ? "star" : "shard",
        },
      );
    }
  }

  /**
   * A directed jet: continuous emission in a narrow cone about `angle`.
   *
   * Boost thrust, portal exhaust, a hazard vent. Rate-based like {@link trail},
   * so pass the frame `dt`.
   */
  stream(
    x: number,
    y: number,
    angle: number,
    color: RGB,
    dt: number,
    o: StreamOptions = {},
  ): void {
    const end = o.colorEnd ?? null;
    const half = Math.max(0.0, o.spread ?? 0.3) * 0.5;
    const n = emitCount(o.rate ?? 90.0, dt);
    for (let i = 0; i < n; i++) {
      const ang = angle + (Math.random() * 2 - 1) * half;
      const sp = rngRange(o.speed ?? [140.0, 300.0], 200.0);
      this.spawn(x, y, {
        vx: Math.cos(ang) * sp,
        vy: Math.sin(ang) * sp,
        radius: rngRange(o.radius ?? [2.0, 4.5], 3.0),
        color,
        colorEnd: end,
        life: rngRange(o.life ?? [0.25, 0.6], 0.4),
        drag: o.drag ?? 1.4,
        turbulence: o.turbulence ?? 0.0,
        kind: Math.random() < 0.3 ? "spark" : "dot",
      });
    }
  }

  /**
   * Particles converging inward onto (x, y) - a portal or pickup "suck".
   *
   * They start on a circle of `radius` with exactly the inward speed that lands
   * them on the centre as they expire (drag is off, so the arrival is dead on),
   * plus a tangential `swirl` component so the collapse spirals.
   */
  implode(x: number, y: number, color: RGB, o: ImplodeOptions = {}): void {
    const end = o.colorEnd ?? hotWhite(color, 0.8);
    const rad = Math.max(4.0, o.radius ?? 90.0);
    const lf = Math.max(0.08, o.life ?? 0.5);
    const swirl = o.swirl ?? 1.1;
    const n = Math.trunc(clamp(o.count ?? 26, 0, 240));
    for (let i = 0; i < n; i++) {
      const ang = (i / Math.max(1, n)) * TAU + (Math.random() * 0.24 - 0.12);
      const ca = Math.cos(ang);
      const sa = Math.sin(ang);
      const r = rad * (0.82 + Math.random() * 0.3);
      const inward = -r / lf;
      const tang = (swirl * r) / lf;
      this.spawn(x + ca * r, y + sa * r, {
        vx: ca * inward - sa * tang,
        vy: sa * inward + ca * tang,
        radius: 2.0 + Math.random() * 2.0,
        color,
        colorEnd: end,
        life: lf * (0.85 + Math.random() * 0.15),
        drag: 0.0,
        shrink: false,
        kind: "trail",
      });
    }
  }

  // -- scene presets -----------------------------------------------------
  //
  // Thin wrappers over the emitters above, carrying the call-site parameters
  // from the Python scenes so they live in one place. Scenes are free to call
  // the generic emitters directly instead; these exist so a gameplay event is
  // one call with no numbers at the call site.

  /**
   * The slither wake behind the head, hotter while boosting
   * (`gameplay.py:_emit_trail`). Emission comes from `0.6 * SNAKE_HEAD_RADIUS`
   * behind the head along its heading, so it reads as a wake and not a halo.
   */
  headTrail(
    x: number,
    y: number,
    heading: number,
    theme: Theme,
    dt: number,
    boosting = false,
  ): void {
    const bx = x - Math.cos(heading) * SNAKE_HEAD_RADIUS * 0.6;
    const by = y - Math.sin(heading) * SNAKE_HEAD_RADIUS * 0.6;
    if (boosting) {
      this.trail(bx, by, lerpColor(theme.accent2, WHITE, 0.3), dt, {
        rate: TRAIL_RATE_BOOST,
        speed: [30.0, 110.0],
      });
    } else {
      this.trail(bx, by, theme.snakeA, dt, {
        rate: TRAIL_EMIT_RATE,
        speed: [8.0, 44.0],
      });
    }
  }

  /** The arena's background motes (`gameplay.py:_emit_trail`). */
  arenaMotes(rect: RectSource, theme: Theme, dt: number): void {
    this.ambient(rect, theme.grid, dt, { rate: ARENA_MOTE_RATE });
  }

  /** The wash under the head while it crosses its own body (`_cross_feedback`). */
  crossWash(x: number, y: number, color: RGB, dt: number): void {
    this.trail(x, y, color, dt, {
      rate: CROSS_WASH_RATE,
      spread: TAU * 0.5,
      speed: [14.0, 78.0],
      life: [0.16, 0.4],
      radius: [2.0, 4.5],
    });
  }

  /** The ping on the frame a cross-over starts (`_cross_feedback`). */
  crossPing(x: number, y: number, color: RGB): void {
    this.ring(x, y, color, { radius: 38.0, count: 12, life: 0.3, speed: 95.0 });
  }

  /** Eating an orb (`gameplay.py:_eat`); `special` is any non-normal food. */
  pickupBurst(x: number, y: number, color: RGB, special = false): void {
    this.burst(x, y, color, {
      count: special ? 34 : 20,
      speed: special ? [60.0, 300.0] : [40.0, 190.0],
      life: [0.35, 1.0],
    });
    this.ring(x, y, color, {
      radius: special ? 76.0 : 46.0,
      count: special ? 24 : 16,
      life: special ? 0.55 : 0.42,
    });
  }

  /** Collecting a power-up rune (`gameplay.py`, rune pickup). */
  runeBurst(x: number, y: number, color: RGB): void {
    this.burst(x, y, color, { count: 30, speed: [70.0, 260.0], life: [0.4, 1.0] });
    this.ring(x, y, color, { radius: 74.0, count: 26, life: 0.55 });
  }

  /** Losing a life (`gameplay.py:_hit`). */
  hitBurst(x: number, y: number, color: RGB): void {
    this.burst(x, y, color, {
      count: 46,
      speed: [90.0, 380.0],
      life: [0.35, 1.1],
      radius: [2.0, 6.0],
    });
    this.ring(x, y, color, { radius: 120.0, count: 30, life: 0.6 });
  }

  /** The last life going (`gameplay.py:_hit`) - fired *after* {@link hitBurst}. */
  deathSpray(x: number, y: number, color: RGB): void {
    this.burst(x, y, color, {
      count: 70,
      speed: [60.0, 430.0],
      life: [0.5, 1.4],
      radius: [2.0, 7.0],
    });
  }

  // -- simulation --------------------------------------------------------

  /**
   * Advance every particle, then sync the display objects if attached.
   *
   * Called once per frame with the *unscaled* wall-clock dt. Gameplay
   * slow-motion scales the dt passed to the emitters, never this one: during
   * slow-mo existing particles keep moving at full speed while emission thins
   * out, which is what makes the effect read as a camera trick.
   */
  update(dt: number): void {
    if (this.destroyed) return;
    if (!(dt > 0.0)) return;
    if (dt > MAX_DT) dt = MAX_DT;
    this.t += dt;
    const t = this.t;

    const items = this.items;
    const pool = this.pool;
    let n = 0;
    for (let i = this.head; i < this.tail; i++) {
      const p = items[i];
      if (!p) continue;
      p.life -= dt;
      if (p.life <= 0.0) {
        if (this.poolCount < this.poolCap) pool[this.poolCount++] = p;
        continue;
      }
      // Exponential-ish drag that stays stable for any dt.
      if (p.drag > 0.0) {
        const f = 1.0 / (1.0 + p.drag * dt);
        p.vx *= f;
        p.vy *= f;
      }
      if (p.gravity) p.vy += p.gravity * dt;
      if (p.turbulence) {
        // A cheap two-trig approximation of a curl-noise field: the
        // acceleration on x depends only on y (and vice versa), which is what
        // makes the flow rotational rather than a uniform push, so bursts
        // braid instead of fanning out.
        const k = p.turbulence * dt;
        p.vx += Math.sin(p.y * 0.017 + t * 1.3 + p.seed) * k;
        p.vy += Math.cos(p.x * 0.017 - t * 1.1 + p.seed) * k;
      }
      p.px = p.x;
      p.py = p.y;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      // `ring` borrows `spin` as its stroke width - never rotate one.
      if (p.spin && p.kind !== K_RING) p.angle += p.spin * dt;
      if (p.grow) {
        p.radius += p.grow * dt;
        p.r0 = p.radius;
      }
      // Survivors compact to the front, oldest first, which is what makes
      // cap-eviction kill the oldest particle.
      items[n++] = p;
    }
    for (let i = n; i < this.tail; i++) items[i] = undefined;
    this.head = 0;
    this.tail = n;

    if (this.root.parent) this.render();
  }

  // -- rendering ---------------------------------------------------------

  /**
   * Push the live particles into the sprite pool and the geometry layer.
   *
   * `update` calls this while the system is attached to a scene; it is public
   * for a scene that wants to control exactly when the sync happens.
   */
  render(): void {
    if (this.destroyed) return;
    // Textures dropped by a cache flush last frame. Safe to free here: every
    // sprite is re-pointed below before anything reaches the GPU again.
    if (retiredTextures.length) {
      for (const tex of retiredTextures) tex.destroy(true);
      retiredTextures.length = 0;
    }

    const g = this.geometry;
    g.clear();

    const items = this.items;
    const geom = this.geomBuf;
    const t = this.t;
    let used = 0;
    let geomN = 0;

    for (let i = this.head; i < this.tail; i++) {
      const p = items[i];
      if (!p) continue;
      const x = p.x;
      const y = p.y;
      if (
        x < -CULL_MARGIN ||
        y < -CULL_MARGIN ||
        x > WINDOW_W + CULL_MARGIN ||
        y > WINDOW_H + CULL_MARGIN
      ) {
        continue;
      }
      let fade = p.life / p.maxLife; // 1 at birth -> 0 at death
      if (fade > 1.0) fade = 1.0;
      let r = p.shrink ? p.r0 * (0.34 + 0.66 * fade) : p.r0;
      if (r < 0.5) continue;
      p.radius = r;

      // The colour ramp is skipped entirely when there is no end colour.
      let cr = p.cr;
      let cg = p.cg;
      let cb = p.cb;
      if (p.hasEnd) {
        const u = 1.0 - fade;
        if (u >= 1.0) {
          cr = p.er;
          cg = p.eg;
          cb = p.eb;
        } else if (u > 0.0) {
          cr += (p.er - cr) * u;
          cg += (p.eg - cg) * u;
          cb += (p.eb - cb) * u;
        }
      }

      const kind = p.kind;
      if (kind >= K_SPARK) {
        geom[geomN++] = p;
        if (kind !== K_RING && kind !== K_TRAIL) {
          // A soft core under the streak/shard sells the glow. Rings are hollow
          // by definition and a ribbon already carries its own body.
          const tex = glowFor(r * 0.9, cr, cg, cb, fade * 0.55);
          if (tex !== null) used = this.place(used, tex, x, y);
        }
        continue;
      }

      let bright = fade;
      if (kind === K_EMBER) {
        // Embers twinkle: a cheap per-particle phase-shifted sine.
        bright *= 0.62 + 0.38 * Math.sin(t * 11.0 + p.seed);
      } else if (kind === K_SMOKE) {
        // Smoke is a dim, quadratically-fading haze: it must never read as a
        // bright blob or the additive blend blows out.
        bright *= fade * 0.34;
        if (bright < 0.012) continue;
      }
      if (!p.glow) {
        // No halo requested: a tighter sprite makes the same cached art read as
        // a hard point instead of a bloom.
        r *= 0.58;
        if (r < 0.5) continue;
      }
      const tex = glowFor(r, cr, cg, cb, bright);
      if (tex !== null) used = this.place(used, tex, x, y);
    }

    if (geomN > 0) this.drawGeometry(g, geom, geomN, t);

    // Park the sprites this frame did not need. Clearing the texture as well
    // keeps a retired one from outliving the next cache flush.
    for (let i = used; i < this.spriteHigh; i++) {
      const s = this.sprites[i];
      if (!s) continue;
      s.visible = false;
      s.texture = Texture.EMPTY;
    }
    this.spriteHigh = used;
    for (let i = geomN; i < geom.length && geom[i] !== undefined; i++) geom[i] = undefined;
  }

  /** Point the next pooled sprite at a texture and a position. */
  private place(used: number, tex: Texture, x: number, y: number): number {
    let s = this.sprites[used];
    if (s === undefined) {
      s = new Sprite(tex);
      s.anchor.set(0.5);
      s.blendMode = "add";
      this.sprites.push(s);
      this.blobs.addChild(s);
    } else if (s.texture !== tex) {
      s.texture = tex;
    }
    // pygame blits at (int(x - w/2), int(y - w/2)); anchoring at the centre and
    // letting the position be fractional is the sub-pixel difference noted in
    // the port spec, well below the perceptual threshold under the CRT chain.
    s.position.set(x, y);
    s.visible = true;
    return used + 1;
  }

  /**
   * Streaks, shards, rings, ribbons, bolts and stars.
   *
   * Python collects these on a scratch layer composited after every blob, so
   * they land on top of the soft particles whatever order they spawned in; here
   * that is this `Graphics` sitting above the sprite container. The dirty-rect
   * bookkeeping around the Python version is a CPU-blit optimisation with no
   * GPU equivalent and is deliberately dropped.
   */
  private drawGeometry(
    g: Graphics,
    geom: (Particle | undefined)[],
    n: number,
    t: number,
  ): void {
    for (let i = 0; i < n; i++) {
      const p = geom[i];
      if (!p) continue;
      let fade = p.life / p.maxLife;
      if (fade > 1.0) fade = 1.0;
      let cr = p.cr;
      let cg = p.cg;
      let cb = p.cb;
      if (p.hasEnd) {
        const u = 1.0 - fade;
        if (u >= 1.0) {
          cr = p.er;
          cg = p.eg;
          cb = p.eb;
        } else if (u > 0.0) {
          cr += (p.er - cr) * u;
          cg += (p.eg - cg) * u;
          cb += (p.eb - cb) * u;
        }
      }
      // The ramp, then multiplied by fade: geometry carries its brightness in
      // the colour, exactly as the additive blit does.
      const col = packRgb(cr * fade, cg * fade, cb * fade);
      if (col === 0) continue;

      const x = p.x;
      const y = p.y;
      const r = p.radius;

      switch (p.kind) {
        case K_SPARK: {
          const sp = Math.hypot(p.vx, p.vy);
          if (sp < 1.0) continue;
          // Streak length tracks speed, so fast sparks smear.
          const tail = clamp(sp * 0.05, 6.0, 34.0) / sp;
          strokeScratch.color = col;
          strokeScratch.width = r < 2.6 ? 1 : 2;
          strokeScratch.alignment = 0.5;
          g.moveTo(x, y).lineTo(x - p.vx * tail, y - p.vy * tail).stroke(strokeScratch);
          break;
        }

        case K_SHARD: {
          // An irregular spinning triangle: three unequal radii around the
          // particle's rotating angle.
          const a = p.angle;
          const s = r * 1.9;
          g.moveTo(x + Math.cos(a) * s, y + Math.sin(a) * s)
            .lineTo(x + Math.cos(a + 2.42) * s * 0.66, y + Math.sin(a + 2.42) * s * 0.66)
            .lineTo(x + Math.cos(a - 2.42) * s * 0.82, y + Math.sin(a - 2.42) * s * 0.82)
            .closePath()
            .fill(col);
          break;
        }

        case K_TRAIL: {
          // A ribbon: a quad wide at the head and pinched at the tail, so a
          // fast particle draws a tapered smear.
          const dx = x - p.px;
          const dy = y - p.py;
          const d = Math.hypot(dx, dy);
          if (d < 0.6) {
            // Barely moved - a dot-sized stub, so the ribbon never vanishes at
            // the top of its arc.
            g.circle(x, y, Math.max(1, Math.trunc(r))).fill(col);
            break;
          }
          // Stretch the tail backwards a little for extra length.
          const ex = p.px - dx * 0.9;
          const ey = p.py - dy * 0.9;
          const nx = -dy / d;
          const ny = dx / d;
          const hw = r * 0.85;
          const tw = r * 0.12;
          g.moveTo(x + nx * hw, y + ny * hw)
            .lineTo(x - nx * hw, y - ny * hw)
            .lineTo(ex - nx * tw, ey - ny * tw)
            .lineTo(ex + nx * tw, ey + ny * tw)
            .closePath()
            .fill(col);
          break;
        }

        case K_BOLT: {
          // Three chained segments with a sine-driven perpendicular kink:
          // deterministic per particle (via `seed`) but flickering in time,
          // which is what sells "electricity".
          const a = p.angle;
          const ln = clamp(r * 4.0, 8.0, 54.0);
          const ca = Math.cos(a);
          const sa = Math.sin(a);
          const nx = -sa;
          const ny = ca;
          strokeScratch.color = col;
          strokeScratch.width = r < 3.4 ? 1 : 2;
          strokeScratch.alignment = 0.5;
          let ax = x;
          let ay = y;
          for (let k = 1; k <= 3; k++) {
            const f = k / 3.0;
            const kink =
              Math.sin(p.seed * 5.7 + k * 2.1 + t * 34.0) * ln * 0.26 * (1.0 - f * 0.5);
            const bx = x + ca * ln * f + nx * kink;
            const by = y + sa * ln * f + ny * kink;
            g.moveTo(ax, ay).lineTo(bx, by).stroke(strokeScratch);
            ax = bx;
            ay = by;
          }
          break;
        }

        case K_STAR: {
          // Four-point twinkle: an eight-vertex polygon alternating a long
          // spike and a short waist.
          const a = p.angle;
          const lo = r * 0.42;
          const hi = r * 2.6;
          for (let k = 0; k < 8; k++) {
            const ang = a + k * 0.7853981633974483; // pi / 4
            const rad = (k & 1) === 0 ? hi : lo;
            const vx = x + Math.cos(ang) * rad;
            const vy = y + Math.sin(ang) * rad;
            if (k === 0) g.moveTo(vx, vy);
            else g.lineTo(vx, vy);
          }
          g.closePath().fill(col);
          break;
        }

        default: {
          // K_RING: hollow, thinning as it expands - a classic shockwave.
          const rr = Math.trunc(r);
          if (rr < 2) continue;
          // `spin` carries the stroke fraction (see `ring`).
          const frac = p.spin >= 0.02 && p.spin <= 0.5 ? p.spin : 0.1;
          let width = Math.max(1, Math.trunc(rr * frac * (0.4 + 0.6 * fade)));
          if (width > rr - 1) width = rr - 1;
          strokeScratch.color = col;
          strokeScratch.width = width;
          // pygame grows a circle's outline inward from the radius; alignment 0
          // is the same thing, so the shockwave's outer edge stays at rr.
          strokeScratch.alignment = 0;
          g.circle(x, y, rr).stroke(strokeScratch);
          break;
        }
      }
    }
  }
}
