/**
 * The synthesis kit behind the NEON SERPENT sound bank - a port of the DSP half
 * of `snake/core/audio.py`.
 *
 * There are no audio assets. Every cue in the game is built from arithmetic at
 * load time, so this module is where the sounds actually come from: a stereo
 * scratch buffer ({@link Sig}) with two voices, {@link Sig.tone} and
 * {@link Sig.noise}, that recipes layer on top of each other.
 *
 * Nothing here knows what Web Audio is. That is the whole point of the split:
 * the maths runs unchanged under Node, so `tests/audio.spec.ts` can compare it
 * against PCM dumped from the running Python game rather than against a
 * screenshot of a waveform. `Audio.ts` is a thin shell that hands the resulting
 * samples to an `AudioBuffer`.
 *
 * Three decisions are load-bearing for that parity:
 *
 * 1. **Samples accumulate in `Float64Array`, not `Float32Array`.** Python mixes
 *    into lists of doubles. Rounding each partial sum to float32 would diverge
 *    from it by a few parts in 10^7 - inaudible, but it would destroy the tight
 *    tolerance that makes the test able to catch a real mistake. Conversion to
 *    float32 happens once, at the Web Audio boundary, in `recipes.ts`.
 *
 * 2. **Python's Mersenne Twister is ported, not approximated.** `_Sig` seeds a
 *    `random.Random(seed)` per cue and the noise bursts are drawn from it, so
 *    the hiss in `hit` and the whoosh in `boost` are a specific, reproducible
 *    sequence of numbers. `core/mathx.ts`'s mulberry32 would give a different
 *    (equally valid, but different) noise, and every noise-bearing cue would
 *    fail parity. {@link MersenneTwister} below follows CPython's
 *    `_randommodule.c` including its `init_by_array` seeding.
 *
 * 3. **The 2048-entry wavetable stays.** In Python it replaced `math.sin` for
 *    speed, but it is not merely an optimisation any more: the index is
 *    truncated, so the table quantises phase and gives the oscillators a faint
 *    aliasing colour that is part of how the game sounds. Calling `Math.sin`
 *    directly here would be a cleaner-sounding *different* instrument.
 *
 * The per-sample loops use `!` on typed-array reads. The indices are either
 * masked into range or bounded by the loop, and this is the one place in the
 * codebase where the branch cost is paid a million times over.
 */

import { TAU } from "../core/mathx";

// ==========================================================================
// Wavetable
// ==========================================================================

const TABLE_BITS = 11;
const TABLE_LEN = 1 << TABLE_BITS;
const TABLE_MASK = TABLE_LEN - 1;
const HALF_TABLE = TABLE_LEN >> 1;
const QUARTER_TABLE = TABLE_LEN >> 2;

/** One cycle of a sine, sampled 2048 times. Exported for the parity test. */
export const SINE: Float64Array = (() => {
  const t = new Float64Array(TABLE_LEN);
  for (let i = 0; i < TABLE_LEN; i++) t[i] = Math.sin((TAU * i) / TABLE_LEN);
  return t;
})();

/** Radians of FM deviation expressed in table units. */
const RAD_TO_IDX = TABLE_LEN / TAU;

const SH_SINE = 0;
const SH_SAW = 1;
const SH_SQUARE = 2;
const SH_TRI = 3;
const SH_FM = 4;

/** The oscillator shapes `tone` understands. */
export type Shape = "sine" | "saw" | "square" | "tri" | "fm";

const SHAPES: Record<string, number> = {
  sine: SH_SINE,
  saw: SH_SAW,
  square: SH_SQUARE,
  tri: SH_TRI,
  fm: SH_FM,
};

/** Frequency `steps` equal-tempered semitones above `base`. */
export function semitone(base: number, steps: number): number {
  return base * Math.pow(2.0, steps / 12.0);
}

// ==========================================================================
// CPython's Mersenne Twister
// ==========================================================================

const MT_N = 624;
const MT_M = 397;
const MATRIX_A = 0x9908b0df;
const UPPER_MASK = 0x80000000;
const LOWER_MASK = 0x7fffffff;

/**
 * Split a seed the way `random_seed()` does: the absolute value, as 32-bit
 * words from the right, and a single zero word when the seed is zero.
 */
function seedKey(seed: number): number[] {
  let n = Math.abs(Math.trunc(seed));
  if (!Number.isFinite(n) || n === 0) return [0];
  const key: number[] = [];
  while (n > 0) {
    key.push(n >>> 0);
    n = Math.floor(n / 4294967296);
  }
  return key;
}

/**
 * MT19937 as CPython exposes it through `random.Random`.
 *
 * `Math.imul` is what makes this exact: a plain `*` on two 32-bit operands
 * needs 64 bits of mantissa and a double has 53, so the low word would be
 * wrong and the streams would part company within a few draws.
 */
export class MersenneTwister {
  private readonly mt = new Uint32Array(MT_N);
  private index = MT_N;

  constructor(seed: number) {
    this.initByArray(seedKey(seed));
  }

  private initGenrand(s: number): void {
    const mt = this.mt;
    mt[0] = s >>> 0;
    for (let i = 1; i < MT_N; i++) {
      const prev = mt[i - 1]!;
      mt[i] = (Math.imul(1812433253, prev ^ (prev >>> 30)) + i) >>> 0;
    }
    this.index = MT_N;
  }

  private initByArray(key: number[]): void {
    const mt = this.mt;
    this.initGenrand(19650218);
    let i = 1;
    let j = 0;
    for (let k = Math.max(MT_N, key.length); k > 0; k--) {
      const prev = mt[i - 1]!;
      mt[i] =
        (((mt[i]! ^ Math.imul(prev ^ (prev >>> 30), 1664525)) >>> 0) + key[j]! + j) >>> 0;
      i++;
      j++;
      if (i >= MT_N) {
        mt[0] = mt[MT_N - 1]!;
        i = 1;
      }
      if (j >= key.length) j = 0;
    }
    for (let k = MT_N - 1; k > 0; k--) {
      const prev = mt[i - 1]!;
      mt[i] = (((mt[i]! ^ Math.imul(prev ^ (prev >>> 30), 1566083941)) >>> 0) - i) >>> 0;
      i++;
      if (i >= MT_N) {
        mt[0] = mt[MT_N - 1]!;
        i = 1;
      }
    }
    // MSB set, which is what guarantees a non-zero initial array.
    mt[0] = 0x80000000;
  }

  private genrand(): number {
    const mt = this.mt;
    if (this.index >= MT_N) {
      let y = 0;
      let kk = 0;
      for (; kk < MT_N - MT_M; kk++) {
        y = ((mt[kk]! & UPPER_MASK) | (mt[kk + 1]! & LOWER_MASK)) >>> 0;
        mt[kk] = mt[kk + MT_M]! ^ (y >>> 1) ^ (y & 1 ? MATRIX_A : 0);
      }
      for (; kk < MT_N - 1; kk++) {
        y = ((mt[kk]! & UPPER_MASK) | (mt[kk + 1]! & LOWER_MASK)) >>> 0;
        mt[kk] = mt[kk + (MT_M - MT_N)]! ^ (y >>> 1) ^ (y & 1 ? MATRIX_A : 0);
      }
      y = ((mt[MT_N - 1]! & UPPER_MASK) | (mt[0]! & LOWER_MASK)) >>> 0;
      mt[MT_N - 1] = mt[MT_M - 1]! ^ (y >>> 1) ^ (y & 1 ? MATRIX_A : 0);
      this.index = 0;
    }
    let y = mt[this.index++]!;
    y ^= y >>> 11;
    y = (y ^ ((y << 7) & 0x9d2c5680)) >>> 0;
    y = (y ^ ((y << 15) & 0xefc60000)) >>> 0;
    y ^= y >>> 18;
    return y >>> 0;
  }

  /** `random.random()`: 53 bits of mantissa from two 32-bit draws. */
  next(): number {
    const a = this.genrand() >>> 5;
    const b = this.genrand() >>> 6;
    return (a * 67108864.0 + b) * (1.0 / 9007199254740992.0);
  }
}

// ==========================================================================
// Signal buffer
// ==========================================================================

/** The pre-computed per-sample envelope coefficients. */
export interface EnvParams {
  aN: number;
  hN: number;
  dec: number;
  relN: number;
  aInc: number;
  rInc: number;
}

/** Keyword arguments of `_Sig.tone`, with Python's defaults. */
export interface ToneOptions {
  amp?: number;
  shape?: Shape;
  attack?: number;
  hold?: number;
  release?: number;
  decayTo?: number;
  vibRate?: number;
  vibDepth?: number;
  fmRatio?: number;
  fmIndex?: number;
  amRate?: number;
  amDepth?: number;
  pan?: number;
}

/** Keyword arguments of `_Sig.noise`, with Python's defaults. */
export interface NoiseOptions {
  amp?: number;
  attack?: number;
  hold?: number;
  release?: number;
  decayTo?: number;
  lp0?: number;
  lp1?: number | null;
  hp?: number;
  pan?: number;
}

/** A short stereo scratch buffer of doubles, rendered voice by voice. */
export class Sig {
  readonly rate: number;
  readonly n: number;
  left: Float64Array;
  right: Float64Array;
  private readonly rng: MersenneTwister;

  constructor(duration: number, rate: number, seed = 1) {
    this.rate = rate;
    this.n = Math.max(1, Math.trunc(duration * rate));
    this.left = new Float64Array(this.n);
    this.right = new Float64Array(this.n);
    this.rng = new MersenneTwister(seed);
  }

  /**
   * Python's `_env_params`. Public here only because it isolates the two
   * `Math.pow` calls the whole port's phase accuracy hangs on, and the test
   * probes them directly against values dumped from CPython.
   */
  envParams(
    n: number,
    attack: number,
    hold: number,
    release: number,
    decayTo: number,
  ): EnvParams {
    const rate = this.rate;
    const aN = Math.max(1, Math.min(n, Math.trunc(attack * rate)));
    const hN = Math.max(0, Math.min(n - aN, Math.trunc(hold * rate)));
    const tail = n - aN - hN;
    const floor = Math.max(1e-4, Math.min(0.999, decayTo));
    // One multiply per sample lands the decay exactly on `floor` at the end.
    const dec = tail > 0 ? Math.pow(floor, 1.0 / tail) : 0.0;
    const relN = Math.max(2, Math.min(n, Math.trunc(release * rate)));
    return { aN, hN, dec, relN, aInc: 1.0 / aN, rInc: 1.0 / relN };
  }

  /**
   * Mix one enveloped oscillator into the buffer.
   *
   * `f1` is the frequency at the end of the note (glide); `vibDepth` and
   * `amDepth` are fractions of 1; `fmIndex` is in radians of phase deviation.
   * `pan` runs -1 (left) .. +1 (right).
   */
  tone(
    start: number,
    dur: number,
    f0: number,
    f1: number | null = null,
    opts: ToneOptions = {},
  ): void {
    const rate = this.rate;
    const i0 = Math.max(0, Math.trunc(start * rate));
    const n = Math.min(Math.trunc(dur * rate), this.n - i0);
    const amp = opts.amp ?? 0.5;
    if (n <= 2 || amp <= 0.0 || f0 <= 0.0) return;

    const code = SHAPES[opts.shape ?? "sine"] ?? SH_SINE;
    const fEnd = f1 === null ? f0 : Math.max(1.0, f1);
    // Per-sample multiplicative pitch ratio -> exponential (musical) glide.
    const k = Math.pow(fEnd / f0, 1.0 / n);

    const pan = opts.pan ?? 0.0;
    const vibRate = opts.vibRate ?? 0.0;
    const vibDepth = opts.vibDepth ?? 0.0;
    const fmRatio = opts.fmRatio ?? 2.0;
    const amRate = opts.amRate ?? 0.0;
    const amDepth = opts.amDepth ?? 0.0;

    const { aN, hN, dec, relN, aInc, rInc } = this.envParams(
      n,
      opts.attack ?? 0.006,
      opts.hold ?? 0.0,
      opts.release ?? 0.02,
      opts.decayTo ?? 0.0015,
    );
    const holdEnd = aN + hN;
    const relStart = n - relN;

    // Equal-ish pan law kept deliberately simple: centre is unity on both
    // sides, hard pan silences the opposite channel.
    const gl = amp * (1.0 - Math.max(0.0, pan));
    const gr = amp * (1.0 + Math.min(0.0, pan));

    const left = this.left;
    const right = this.right;
    const table = SINE;
    const step = TABLE_LEN / rate;
    let phase = 0.0;
    let vibPhase = 0.0;
    let amPhase = 0.0;
    const vibStep = vibRate * step;
    const amStep = amRate * step;
    let freq = f0;
    let env = 0.0;
    const fmAmt = (opts.fmIndex ?? 0.0) * RAD_TO_IDX;

    for (let i = 0; i < n; i++) {
      if (i < aN) env = (i + 1) * aInc;
      else if (i < holdEnd) env = 1.0;
      else env *= dec;
      let e = env;
      if (i >= relStart) e *= (n - i) * rInc;

      const idx = Math.trunc(phase);
      let v: number;
      if (code === SH_SINE) {
        v = table[idx & TABLE_MASK]!;
      } else if (code === SH_FM) {
        const mod = table[Math.trunc(phase * fmRatio) & TABLE_MASK]!;
        v = table[Math.trunc(phase + fmAmt * mod) & TABLE_MASK]!;
      } else if (code === SH_SAW) {
        // Offset half a cycle so the ramp crosses zero at phase 0, exactly
        // like the sine table - keeps note onsets click-free.
        v = ((idx + HALF_TABLE) & TABLE_MASK) * (2.0 / TABLE_LEN) - 1.0;
      } else if (code === SH_SQUARE) {
        v = idx & HALF_TABLE ? 1.0 : -1.0;
      } else {
        const p = ((idx + QUARTER_TABLE) & TABLE_MASK) * (1.0 / TABLE_LEN);
        v = 4.0 * (p < 0.5 ? p : 1.0 - p) - 1.0;
      }

      if (amDepth) {
        v *= 1.0 - amDepth + amDepth * table[Math.trunc(amPhase) & TABLE_MASK]!;
        amPhase += amStep;
      }

      let inst: number;
      if (vibDepth) {
        inst = freq * (1.0 + vibDepth * table[Math.trunc(vibPhase) & TABLE_MASK]!);
        vibPhase += vibStep;
      } else {
        inst = freq;
      }
      phase += inst * step;
      freq *= k;

      v *= e;
      const j = i0 + i;
      left[j] = left[j]! + v * gl;
      right[j] = right[j]! + v * gr;
    }
  }

  /**
   * Mix a burst of one-pole-filtered white noise.
   *
   * `lp0`/`lp1` are the filter coefficient at the start and end of the burst
   * (0 = very dark, 1 = unfiltered), so sweeping them produces the classic
   * "whoosh". `hp` blends in the high-pass residual (x - y) for bright, hissy
   * transients.
   */
  noise(start: number, dur: number, opts: NoiseOptions = {}): void {
    const rate = this.rate;
    const i0 = Math.max(0, Math.trunc(start * rate));
    const n = Math.min(Math.trunc(dur * rate), this.n - i0);
    const amp = opts.amp ?? 0.5;
    if (n <= 2 || amp <= 0.0) return;

    const lp0 = opts.lp0 ?? 0.3;
    const lp1raw = opts.lp1;
    const lp1 = lp1raw === undefined || lp1raw === null ? lp0 : lp1raw;
    const hp = opts.hp ?? 0.0;
    const pan = opts.pan ?? 0.0;
    const dLp = (lp1 - lp0) / n;

    const { aN, hN, dec, relN, aInc, rInc } = this.envParams(
      n,
      opts.attack ?? 0.002,
      opts.hold ?? 0.0,
      opts.release ?? 0.02,
      opts.decayTo ?? 0.002,
    );
    const holdEnd = aN + hN;
    const relStart = n - relN;

    const gl = amp * (1.0 - Math.max(0.0, pan));
    const gr = amp * (1.0 + Math.min(0.0, pan));
    const loMix = 1.0 - hp;

    const left = this.left;
    const right = this.right;
    const rng = this.rng;
    let y = 0.0;
    let a = lp0;
    let env = 0.0;

    for (let i = 0; i < n; i++) {
      if (i < aN) env = (i + 1) * aInc;
      else if (i < holdEnd) env = 1.0;
      else env *= dec;
      let e = env;
      if (i >= relStart) e *= (n - i) * rInc;

      const x = rng.next() * 2.0 - 1.0;
      y += a * (x - y);
      const v = (y * loMix + (x - y) * hp) * e;
      a += dLp;

      const j = i0 + i;
      left[j] = left[j]! + v * gl;
      right[j] = right[j]! + v * gr;
    }
  }

  /** Scale down only if the mix clipped; quiet cues stay quiet. */
  normalise(ceiling = 0.95): void {
    const left = this.left;
    const right = this.right;
    const n = this.n;
    let lMax = -Infinity;
    let lMin = Infinity;
    let rMax = -Infinity;
    let rMin = Infinity;
    for (let i = 0; i < n; i++) {
      const a = left[i]!;
      const b = right[i]!;
      if (a > lMax) lMax = a;
      if (a < lMin) lMin = a;
      if (b > rMax) rMax = b;
      if (b < rMin) rMin = b;
    }
    let peak = 0.0;
    if (lMax > peak) peak = lMax;
    if (-lMin > peak) peak = -lMin;
    if (rMax > peak) peak = rMax;
    if (-rMin > peak) peak = -rMin;
    if (peak > ceiling) {
      const g = ceiling / peak;
      for (let i = 0; i < n; i++) {
        left[i] = left[i]! * g;
        right[i] = right[i]! * g;
      }
    }
  }
}
