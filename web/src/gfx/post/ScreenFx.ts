/**
 * The runtime state of the screen-feedback layer: shake, flash, lens streak,
 * slow motion and the scene wipes.
 *
 * This is the half of `snake/gfx/effects.py::EffectStack` that gameplay pokes -
 * every cap, cutoff and decay curve, and none of the drawing. {@link PostChain}
 * reads it once per frame and pushes it into filter uniforms, sprite tints and
 * the shake transform; the wipe renderer reads the transition fields.
 *
 * Three things are load-bearing and must not be "tidied":
 *
 * - **Every decay is `v * exp(-rate * dt)`**, never a linear subtraction, so the
 *   curve is identical at 30, 60 and 144 fps. `dt` is always *real* time, even
 *   while {@link ScreenFx.timeScale} is slowing the simulation down.
 * - **The tuning constants below live nowhere else.** `config.json` carries only
 *   `SHAKE_DECAY`, `FLASH_DECAY` and `TRANSITION_TIME`; the rest are post-chain
 *   private in the Python and are copied here verbatim (spec §14).
 * - **`hash01` is bit-exact with Python.** It shapes the whole glitch wipe from
 *   a per-transition seed, so it is reproduced with `Math.imul` and 32-bit
 *   masking rather than approximated.
 *
 * Randomness elsewhere (shake re-seed, flare wander, wipe flip/seed, grain
 * jitter) came from Python's Mersenne generator and cannot be reproduced; a
 * seeded {@link Rng} stands in, which also makes the web build repeatable.
 */

import { FLASH_DECAY, MAX_DT, SHAKE_DECAY, TRANSITION_TIME, WINDOW_H, WINDOW_W } from "../../core/config";
import { clamp, easeInOutCubic, easeOutCubic, lerp, TAU } from "../../core/mathx";
import { clamp8, lerpColor, THEMES, type RGB, type Theme } from "../../core/palette";
import { makeSeededRng, type Rng } from "../rng";

// ---------------------------------------------------------------------------
// Tuning that belongs to the post chain alone (effects.py:90-208)
// ---------------------------------------------------------------------------

/** Hard ceiling on the shake amplitude, design px. */
export const SHAKE_MAX = 26.0;
/** Sub-pixel floor: snap to zero so the shake truly ends. */
export const SHAKE_CUTOFF = 0.15;
/** The directional shove dies much faster than the rattle. */
export const SHAKE_DIR_DECAY = 9.0;
/** Hz of the spring-back oscillation. */
export const SHAKE_DIR_FREQ = 5.2;
/** Shove amplitude as a fraction of the trauma added. */
export const SHAKE_DIR_SHARE = 1.15;
export const SHAKE_DIR_CUTOFF = 0.2;

/** Ceiling on accumulated flash strength. Above 1.0 it only buys time at full white. */
export const FLASH_MAX = 1.25;

/** Shake amplitude where the RGB split switches on ... */
export const ABERRATION_START = 6.5;
/** ... and where it reaches full strength. */
export const ABERRATION_FULL = 15.0;

export const FLARE_DECAY = 4.6;
/** Sprite height as a fraction of the frame. */
export const FLARE_HEIGHT = 0.3;
export const FLARE_MAX = 1.4;

export const GRAIN_FRAMES = 3;
export const GRAIN_FPS = 24.0;
/** Grain layers are this many px larger than the frame, so they can be shifted. */
export const GRAIN_JITTER = 16;

/** Default add-back strength of the bloom. */
export const BLOOM_STRENGTH = 0.72;
/** Ceiling on the settable strength. */
export const BLOOM_MAX = 2.5;

/** Once a wipe has swallowed this much of the frame, drop the grain. */
export const WIPE_SKIP_CHEAP = 0.35;
/** ... and this much, drop the chromatic aberration too. */
export const WIPE_SKIP_HEAVY = 0.42;

export const TRANSITION_STYLES = ["iris", "sweep", "glitch", "dissolve"] as const;
export type TransitionStyle = (typeof TRANSITION_STYLES)[number];

export const TRANSITION_MODES = ["reveal", "cover", "blink"] as const;
export type TransitionMode = (typeof TRANSITION_MODES)[number];

export const QUALITY_LEVELS = ["low", "medium", "high", "ultra"] as const;
export type QualityLevel = (typeof QUALITY_LEVELS)[number];

/** The "blanked out" colour every wipe covers with (effects.py:186). */
export const FIELD: RGB = [3, 4, 10];
/** Thickness of the glowing edge on a sweep wipe. */
export const TRANSITION_BAND = 190.0;
/** Dissolve cell grid - 16x16 px cells at 1280x720. */
export const DISSOLVE_GRID: readonly [number, number] = [80, 45];
/** Pre-rendered coverage steps of the dissolve. */
export const DISSOLVE_STEPS = 18;
/** Horizontal tear bands of the glitch wipe. */
export const GLITCH_BANDS = 15;

const WHITE: RGB = [255, 255, 255];

// ---------------------------------------------------------------------------
// Small maths helpers, ported verbatim
// ---------------------------------------------------------------------------

/**
 * Cheap smooth pseudo-noise in -1..1 (effects.py:214).
 *
 * Three sines at incommensurate frequencies, weights summing to exactly 1 so
 * the result cannot leave -1..1. Continuity is the point: per-frame `random()`
 * reads as pixel static, this reads as a camera being knocked.
 */
export function noise1(t: number, seed: number): number {
  return (
    Math.sin(t * 1.0 + seed) * 0.55 +
    Math.sin(t * 2.37 + seed * 1.7) * 0.3 +
    Math.sin(t * 4.11 + seed * 3.1) * 0.15
  );
}

/**
 * Deterministic 0..1 hash of an integer - the stable per-band "random" of the
 * glitch wipe (effects.py:231).
 *
 * Python does this in arbitrary precision and masks to 31 bits; `Math.imul`
 * gives the exact low 32 bits of each multiply, and the mask only ever reads
 * the low 31, so this reproduces the Python sequence exactly. That matters:
 * the tear pattern is seeded per transition and any drift changes the effect.
 */
export function hash01(n: number): number {
  let x = ((Math.imul(n | 0, 1103515245) + 12345) >>> 0) & 0x7fffffff;
  x ^= x >>> 13;
  x = (Math.imul(x, 1274126177) >>> 0) & 0x7fffffff;
  return (x & 0xffff) / 65535;
}

/** Classic Hermite smoothstep, guarded against a zero-width edge. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge1 <= edge0) return x < edge0 ? 0 : 1;
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Framerate-independent exponential decay. */
function decay(value: number, rate: number, dt: number): number {
  if (value <= 0) return 0;
  const out = value * Math.exp(-rate * dt);
  return Number.isFinite(out) ? out : 0;
}

/**
 * Pre-blend `color` at `alpha` (0..255) against the wipe field, opaque.
 *
 * pygame's draw primitives *write* RGBA instead of compositing, so a
 * translucent glow stroke over the opaque field would punch a see-through hole
 * in the wipe; Python blends by hand and draws at alpha 255. Pixi's Graphics
 * composites correctly, so this is only needed to stay bit-identical - which is
 * what the wipe renderer should do (spec §10).
 */
export function fieldBlend(color: RGB, alpha: number): RGB {
  return lerpColor(FIELD, color, clamp(alpha, 0, 255) / 255);
}

/** A direction or impact point handed to {@link ScreenFx.shake}. */
export interface ShakeOptions {
  /** The way the frame should be shoved, as any non-zero vector. */
  direction?: { x: number; y: number } | null;
  /** A point in design space the hit came *from*; the frame is shoved away from it. */
  source?: { x: number; y: number } | null;
}

export interface FlareOptions {
  color?: RGB | null;
  /** A point in design space; defaults to a spot wandering around the middle. */
  pos?: { x: number; y: number } | null;
}

export interface TransitionOptions {
  style?: TransitionStyle | null;
  mode?: TransitionMode;
  color?: RGB | null;
}

/** The layer switches a settings screen or a quality preset flips. */
export interface PostFlags {
  vignette?: boolean;
  scanlines?: boolean;
  aberration?: boolean;
  curvature?: boolean;
  grain?: boolean;
  flare?: boolean;
  /** A bool toggles at the current strength; a number sets it (0 disables). */
  bloom?: boolean | number;
}

export class ScreenFx {
  /** Seconds of real time since construction; drives every oscillator. */
  time = 0;

  // -- shake ---------------------------------------------------------------
  /** Current rattle amplitude in design px, 0..SHAKE_MAX. */
  shakeAmount = 0;
  /**
   * The settings screen's shake toggle. Python monkeypatches a guard around
   * `fx.shake`; here it is a first-class flag checked at the top of
   * {@link shake} (spec §12).
   */
  shakeEnabled = true;
  /** This frame's shake offset in design px, integer-snapped. Shared - do not retain. */
  readonly offset = { x: 0, y: 0 };

  private shakeSeed: number;
  private dirX = 0;
  private dirY = 0;
  private dirAmount = 0;
  private dirPhase = 0;

  // -- flash / flare -------------------------------------------------------
  flashColor: RGB = WHITE;
  flashAmount = 0;
  flareColor: RGB = WHITE;
  flareAmount = 0;
  /** Normalised centre of the streak, 0..1 across the frame. */
  readonly flarePos = { x: 0.5, y: 0.5 };

  // -- grain ---------------------------------------------------------------
  /** Which pre-rendered speck layer is showing; advances at GRAIN_FPS. */
  grainIndex = 0;
  grainJitterX = 0;
  grainJitterY = 0;
  private grainAt = 0;

  // -- slow motion ---------------------------------------------------------
  private slowFactor = 1;
  private slowLeft = 0;
  private slowTotal = 0;

  // -- transition ----------------------------------------------------------
  /** Seconds into the running wipe. The glitch wipe quantises it. */
  transTime = 0;
  transTotal = 0;
  transStyle: TransitionStyle = "iris";
  transMode: TransitionMode = "reveal";
  /** Mirrors the sweep direction. */
  transFlip = false;
  /** Seeds the glitch tear pattern. */
  transSeed = 0;
  transitionColor: RGB;
  private transIndex = 0;

  // -- feature switches (a scene may turn the grain off for menus) ----------
  vignetteEnabled = true;
  scanlinesEnabled = true;
  aberrationEnabled = true;
  curvatureEnabled = true;
  bloomEnabled = true;
  grainEnabled = true;
  flareEnabled = true;
  private bloomGain = BLOOM_STRENGTH;

  private readonly rng: Rng;

  constructor(rng?: Rng) {
    this.rng = rng ?? makeSeededRng("fx|screen");
    this.shakeSeed = this.rng.random() * 100;
    this.transitionColor = THEMES[0]?.accent ?? [0, 236, 255];
  }

  // ------------------------------------------------------------------- API

  /** Tint future transition wipes with a level's accent colour. */
  setTheme(theme: Theme): void {
    this.transitionColor = theme.accent;
  }

  /**
   * Add `amount` px of trauma to the camera - additive, capped at SHAKE_MAX.
   *
   * With neither `direction` nor `source` this is pure omnidirectional rattle.
   * With one of them the frame is also shoved bodily away from the impact and
   * springs back; two hits from opposite sides partly cancel, because the new
   * shove is vector-blended into whatever is still ringing rather than simply
   * replacing it.
   */
  shake(amount: number, opts?: ShakeOptions): void {
    if (!this.shakeEnabled) return;
    const a = Number(amount);
    if (!Number.isFinite(a) || a <= 0) return;

    // A fresh, strong impact re-seeds the noise so two hits in a row do not
    // continue the exact same wobble.
    if (a >= this.shakeAmount * 0.6) this.shakeSeed = this.rng.random() * 100;
    this.shakeAmount = Math.min(SHAKE_MAX, this.shakeAmount + a);

    const dir = this.impactVector(opts);
    if (dir === null) return;
    const push = Math.min(SHAKE_MAX, a * SHAKE_DIR_SHARE);
    const ax = this.dirX * this.dirAmount + dir.x * push;
    const ay = this.dirY * this.dirAmount + dir.y * push;
    const mag = Math.hypot(ax, ay);
    if (mag <= 1e-6) {
      this.dirAmount = 0;
      return;
    }
    this.dirX = ax / mag;
    this.dirY = ay / mag;
    this.dirAmount = Math.min(SHAKE_MAX, mag);
    this.dirPhase = 0;
  }

  /** Normalise a direction/source pair into a unit shove vector. */
  private impactVector(opts?: ShakeOptions): { x: number; y: number } | null {
    let dx = 0;
    let dy = 0;
    if (opts?.direction) {
      dx = opts.direction.x;
      dy = opts.direction.y;
    } else if (opts?.source) {
      // Away from the impact point: design centre minus source.
      dx = WINDOW_W * 0.5 - opts.source.x;
      dy = WINDOW_H * 0.5 - opts.source.y;
    }
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;
    const mag = Math.hypot(dx, dy);
    if (mag <= 1e-6) return null;
    return { x: dx / mag, y: dy / mag };
  }

  /**
   * Punch a full-screen additive flash of `color`.
   *
   * An incoming hue is blended in proportionally to how much light it brings,
   * so a red hit over a fading white flash goes orange. Anything at 0.20 or
   * above also fires the lens streak - a bright event is exactly what makes one.
   */
  flash(color: RGB, amount = 1): void {
    const a = clamp(Number(amount), 0, FLASH_MAX);
    if (!Number.isFinite(a) || a <= 0) return;
    const c: RGB = [clamp8(color[0]), clamp8(color[1]), clamp8(color[2])];
    if (this.flashAmount <= 0.01) {
      this.flashColor = c;
    } else {
      this.flashColor = lerpColor(this.flashColor, c, a / (a + this.flashAmount));
    }
    this.flashAmount = Math.min(FLASH_MAX, this.flashAmount + a);
    if (a >= 0.2) this.flare(a * 0.85, { color: c });
  }

  /** Fire the anamorphic lens streak. */
  flare(amount = 1, opts?: FlareOptions): void {
    const a = clamp(Number(amount), 0, FLARE_MAX);
    if (!Number.isFinite(a) || a <= 0) return;
    if (opts?.color) {
      this.flareColor = [clamp8(opts.color[0]), clamp8(opts.color[1]), clamp8(opts.color[2])];
    }
    let nx = 0.5;
    let ny = 0.5;
    if (opts?.pos) {
      nx = clamp(opts.pos.x / WINDOW_W, 0, 1);
      ny = clamp(opts.pos.y / WINDOW_H, 0, 1);
    } else {
      nx = 0.5 + this.rng.uniform(-0.14, 0.14);
      ny = 0.5 + this.rng.uniform(-0.18, 0.18);
    }
    // Only a stronger event re-aims the streak.
    if (a >= this.flareAmount) {
      this.flarePos.x = nx;
      this.flarePos.y = ny;
    }
    this.flareAmount = Math.min(FLARE_MAX, this.flareAmount + a);
  }

  /** Drop the simulation to `factor` speed for `duration` seconds. */
  slowmo(factor: number, duration: number): void {
    const f = clamp(Number(factor), 0.05, 1);
    const d = Number(duration);
    if (!Number.isFinite(f) || !Number.isFinite(d)) return;
    if (d <= 0 || f >= 1) return;
    // Strongest slowdown wins; the longest request sets the timer.
    this.slowFactor = this.slowLeft <= 0 ? f : Math.min(this.slowFactor, f);
    this.slowLeft = Math.max(this.slowLeft, d);
    this.slowTotal = Math.max(this.slowTotal, this.slowLeft);
  }

  /** Current simulation multiplier: 1.0 normally, < 1.0 in slow motion. */
  timeScale(): number {
    if (this.slowLeft <= 0 || this.slowTotal <= 0) return 1;
    const frac = clamp(this.slowLeft / this.slowTotal, 0, 1);
    // Snap in instantly (impact!) but ease back to real time over the last 35%.
    if (frac < 0.35) return lerp(1, this.slowFactor, easeInOutCubic(frac / 0.35));
    return this.slowFactor;
  }

  /**
   * Start a wipe.
   *
   * `style` omitted auto-cycles, so successive scene changes never repeat -
   * and because the index pre-increments from 0, the first automatic wipe of a
   * session is always "sweep".
   */
  beginTransition(duration: number = TRANSITION_TIME, opts?: TransitionOptions): void {
    const d = Number(duration);
    this.transTotal = Math.max(0.05, Number.isFinite(d) ? d : TRANSITION_TIME);
    this.transTime = 0;
    const mode = opts?.mode;
    this.transMode = mode && TRANSITION_MODES.includes(mode) ? mode : "reveal";
    const style = opts?.style;
    if (style && TRANSITION_STYLES.includes(style)) {
      this.transStyle = style;
    } else {
      this.transIndex += 1;
      this.transStyle =
        TRANSITION_STYLES[this.transIndex % TRANSITION_STYLES.length] ?? "sweep";
    }
    this.transFlip = this.rng.random() < 0.5;
    this.transSeed = this.rng.randrange(1 << 20);
    if (opts?.color) {
      this.transitionColor = [
        clamp8(opts.color[0]),
        clamp8(opts.color[1]),
        clamp8(opts.color[2]),
      ];
    }
  }

  get transitionActive(): boolean {
    return this.transTotal > 0;
  }

  /** 0..1 through the current wipe; 1.0 when none is running. */
  get transitionProgress(): number {
    if (this.transTotal <= 0) return 1;
    return clamp(this.transTime / this.transTotal, 0, 1);
  }

  /**
   * How much of the frame the active wipe hides right now: 0 none, 1 all.
   *
   * Read before the chain composites as well as while it does, because the
   * answer decides which layers are worth paying for this frame.
   */
  transitionCover(): number {
    if (this.transTotal <= 0) return 0;
    const p = this.transitionProgress;
    let cover: number;
    if (this.transMode === "cover") cover = easeInOutCubic(p);
    else if (this.transMode === "blink") cover = 1 - easeInOutCubic(Math.abs(p * 2 - 1));
    else cover = 1 - easeOutCubic(p);
    return clamp(cover, 0, 1);
  }

  /** How hard the bloom is added back, 0..BLOOM_MAX. */
  get bloomStrength(): number {
    return this.bloomGain;
  }

  set bloomStrength(value: number) {
    const v = clamp(Number(value), 0, BLOOM_MAX);
    if (!Number.isFinite(v)) return;
    this.bloomGain = v;
  }

  /** 0..1 strength of the shake-driven RGB split; 0 below ABERRATION_START. */
  aberrationStrength(): number {
    if (!this.aberrationEnabled) return 0;
    if (this.transitionCover() >= WIPE_SKIP_HEAVY) return 0;
    return smoothstep(ABERRATION_START, ABERRATION_FULL, this.shakeAmount);
  }

  /** The shake offset this frame will be drawn at. Shared object - copy to keep. */
  screenOffset(): Readonly<{ x: number; y: number }> {
    return this.offset;
  }

  /** Kill every live effect (used when hard-switching scenes). */
  clear(): void {
    this.shakeAmount = 0;
    this.dirAmount = 0;
    this.dirX = 0;
    this.dirY = 0;
    this.dirPhase = 0;
    this.flashAmount = 0;
    this.flareAmount = 0;
    this.slowLeft = 0;
    this.slowTotal = 0;
    this.slowFactor = 1;
    this.transTotal = 0;
    this.transTime = 0;
    this.offset.x = 0;
    this.offset.y = 0;
  }

  // ---------------------------------------------------------------- update

  /** Advance every decay curve. `dt` must be *real* (unscaled) seconds. */
  update(dt: number): void {
    const step = Number(dt);
    if (!Number.isFinite(step) || step <= 0) return; // NaN, or a stalled/rewound clock
    const d = Math.min(step, MAX_DT * 3);
    this.time += d;

    this.shakeAmount = decay(this.shakeAmount, SHAKE_DECAY, d);
    if (this.shakeAmount < SHAKE_CUTOFF) this.shakeAmount = 0;

    if (this.dirAmount > 0) {
      this.dirAmount = decay(this.dirAmount, SHAKE_DIR_DECAY, d);
      this.dirPhase += d * SHAKE_DIR_FREQ * TAU;
      if (this.dirAmount < SHAKE_DIR_CUTOFF) {
        this.dirAmount = 0;
        this.dirPhase = 0;
      }
    }

    this.flashAmount = decay(this.flashAmount, FLASH_DECAY, d);
    if (this.flashAmount < 0.004) this.flashAmount = 0;

    this.flareAmount = decay(this.flareAmount, FLARE_DECAY, d);
    if (this.flareAmount < 0.006) this.flareAmount = 0;

    // Grain advances at film rate, not frame rate: 60 Hz noise fizzes.
    if (this.time - this.grainAt >= 1 / GRAIN_FPS) {
      this.grainAt = this.time;
      this.grainIndex += 1;
      this.grainJitterX = this.rng.randrange(GRAIN_JITTER + 1);
      this.grainJitterY = this.rng.randrange(GRAIN_JITTER + 1);
    }

    if (this.slowLeft > 0) {
      this.slowLeft -= d;
      if (this.slowLeft <= 0) {
        this.slowLeft = 0;
        this.slowTotal = 0;
        this.slowFactor = 1;
      }
    }

    if (this.transTotal > 0) {
      this.transTime += d;
      if (this.transTime >= this.transTotal) {
        this.transTime = this.transTotal;
        this.transTotal = 0;
      }
    }

    this.updateOffset();
  }

  /**
   * Recompute {@link offset} from the rattle and the shove.
   *
   * The offset is integer-snapped in design px, exactly as the Python rounds it
   * before blitting: a sub-pixel camera shake on a 1280x720 frame reads as a
   * soft smear rather than a knock.
   */
  private updateOffset(): void {
    let ox = 0;
    let oy = 0;
    if (this.shakeAmount > SHAKE_CUTOFF) {
      const amp = this.shakeAmount;
      ox = noise1(this.time * 23.0, this.shakeSeed) * amp;
      oy = noise1(this.time * 19.0, this.shakeSeed + 7.3) * amp * 0.85;
    }
    if (this.dirAmount > SHAKE_DIR_CUTOFF) {
      // cos() starts at the full shove and swings back through zero, so the
      // frame is punched away from the impact and springs past it.
      const swing = Math.cos(this.dirPhase);
      ox += this.dirX * this.dirAmount * swing;
      oy += this.dirY * this.dirAmount * swing;
    }
    const lim = SHAKE_MAX * 1.4;
    this.offset.x = Math.round(clamp(ox, -lim, lim));
    this.offset.y = Math.round(clamp(oy, -lim, lim));
  }

  // ----------------------------------------------------------------- flags

  /**
   * Toggle post-processing layers.
   *
   * `bloom` is the one that takes a value as well as a switch: a bool turns it
   * on or off at the current strength, a number sets the strength (0 disables).
   */
  setPostFlags(flags: PostFlags): void {
    if (flags.vignette !== undefined) this.vignetteEnabled = !!flags.vignette;
    if (flags.scanlines !== undefined) this.scanlinesEnabled = !!flags.scanlines;
    if (flags.aberration !== undefined) this.aberrationEnabled = !!flags.aberration;
    if (flags.curvature !== undefined) this.curvatureEnabled = !!flags.curvature;
    if (flags.grain !== undefined) this.grainEnabled = !!flags.grain;
    if (flags.flare !== undefined) this.flareEnabled = !!flags.flare;
    if (flags.bloom !== undefined) {
      if (typeof flags.bloom === "boolean") {
        this.bloomEnabled = flags.bloom;
      } else {
        this.bloomStrength = flags.bloom;
        this.bloomEnabled = this.bloomGain > 0;
      }
    }
  }

  /**
   * Apply one of {@link QUALITY_LEVELS} as a whole-stack preset.
   *
   * The rungs split on what is expensive rather than on what sounds fancy: on
   * the GPU that is the bloom ladder and the aberration's extra taps, so those
   * are the two rungs at the top. Everything else is one full-screen pass.
   */
  setQuality(level: QualityLevel): void {
    if (level === "low") {
      this.setPostFlags({
        vignette: false,
        scanlines: false,
        aberration: false,
        curvature: false,
        grain: false,
        flare: false,
        bloom: false,
      });
    } else if (level === "medium") {
      this.setPostFlags({
        vignette: true,
        scanlines: true,
        aberration: false,
        curvature: true,
        grain: false,
        flare: true,
        bloom: false,
      });
    } else if (level === "high") {
      this.setPostFlags({
        vignette: true,
        scanlines: true,
        aberration: false,
        curvature: true,
        grain: true,
        flare: true,
        bloom: BLOOM_STRENGTH,
      });
    } else {
      this.setPostFlags({
        vignette: true,
        scanlines: true,
        aberration: true,
        curvature: true,
        grain: true,
        flare: true,
        bloom: 1.25,
      });
    }
  }
}
