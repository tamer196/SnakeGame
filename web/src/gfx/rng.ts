/**
 * Seeded randomness for the renderer.
 *
 * Every generated layout in the graphics layer - star fields, cloud banks,
 * circuit traces, ember spawns - is driven by one of these instead of
 * `Math.random()`, so a background rebuilt after a rotation comes back with the
 * same layout it had before.
 *
 * The Python original seeds from `hash((style, theme.name))`, and CPython salts
 * string hashing per process, so the pygame game already draws a *different*
 * layout every launch. Bit-parity with that is neither possible nor desirable;
 * a stable seed is strictly better here, because the web build rebuilds
 * backgrounds when the viewport changes and a reshuffle mid-session would be
 * visible. The API below mirrors Python's `random.Random` method-for-method so
 * ported code reads the same as its source.
 */

import { makeRng } from "../core/mathx";

/** The subset of `random.Random` the graphics layer uses. */
export interface Rng {
  /** Uniform float in [0, 1). */
  random(): number;
  /** Uniform float in [a, b]. */
  uniform(a: number, b: number): number;
  /** Uniform integer in [a, b] - **inclusive at both ends**, as in Python. */
  randint(a: number, b: number): number;
  /** Uniform integer in [0, n). */
  randrange(n: number): number;
  /** A uniformly chosen element. Throws on an empty list, like Python. */
  choice<T>(arr: readonly T[]): T;
  /** Fisher-Yates, in place, like `random.shuffle`. */
  shuffle<T>(arr: T[]): void;
}

/**
 * FNV-1a over UTF-16 code units. Small, fast, and - unlike CPython's `hash()` -
 * stable across processes, which is the entire point.
 */
export function hashSeed(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    // h *= 16777619, kept in 32 bits.
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Build an {@link Rng} from a numeric seed or any string key. */
export function makeSeededRng(seed: number | string): Rng {
  const s = typeof seed === "string" ? hashSeed(seed) : seed >>> 0;
  // mulberry32, shared with the simulation so there is one PRNG in the codebase.
  const next = makeRng(s);

  return {
    random: next,
    uniform(a: number, b: number): number {
      return a + (b - a) * next();
    },
    randint(a: number, b: number): number {
      const lo = Math.ceil(a);
      const hi = Math.floor(b);
      if (hi < lo) return lo;
      return lo + Math.floor(next() * (hi - lo + 1));
    },
    randrange(n: number): number {
      const hi = Math.floor(n);
      if (hi <= 0) return 0;
      return Math.floor(next() * hi);
    },
    choice<T>(arr: readonly T[]): T {
      if (arr.length === 0) throw new Error("choice() on an empty sequence");
      const v = arr[Math.floor(next() * arr.length)];
      // Only reachable if next() returned exactly 1, which mulberry32 cannot.
      return v === undefined ? arr[arr.length - 1]! : v;
    },
    shuffle<T>(arr: T[]): void {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        const a = arr[i]!;
        arr[i] = arr[j]!;
        arr[j] = a;
      }
    },
  };
}
