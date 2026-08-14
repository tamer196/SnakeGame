/// <reference types="vite/client" />
/**
 * Sample-for-sample parity for the ported sound engine, plus the engine
 * behaviour that can be checked without a browser.
 *
 * The reference is not hand-derived. A throwaway script imported the *running*
 * Python game's `snake.core.audio`, ran all twelve `_mk_*` recipes at 44100 Hz,
 * and dumped what came out to `tests/fixtures/audio_parity.json`: the buffer
 * length, ~200 decimated samples per channel, peak, RMS and the sum of
 * magnitudes over the whole buffer, plus probes of the pieces the port could
 * plausibly get subtly wrong on its own - CPython's Mersenne Twister, the sine
 * wavetable, the equal-tempered note frequencies and the envelope
 * coefficients. `_Sig` and `_mk_*` are pure array maths, so no mixer and no
 * display were involved.
 *
 * To regenerate after a deliberate change to the Python game, re-run that
 * dump: it needs only `sys.path` pointing at the repo root and
 * `from snake.core import audio`.
 *
 * ## Tolerances
 *
 * Both languages evaluate the same IEEE-754 double operations in the same
 * order, so most quantities agree bit for bit. Two do not, and neither is the
 * port's fault:
 *
 * *   `Math.sin` and `Math.pow` are separately-rounded implementations of the
 *     same functions in V8 and in CPython's libm. One wavetable entry differs
 *     by 1 ulp, and `2 ** (10/12)` (the note G5) by about 1.1e-13 Hz.
 * *   That frequency error rides through the phase accumulator, which is why
 *     the *measured* worst-case disagreement over every decimated sample of
 *     every cue is 1.1e-16 - roughly two ulp at half scale.
 *
 * {@link SAMPLE_EPS} is set at 1e-12: four orders of magnitude above that
 * measured drift, so a different libm cannot make the suite flaky, and four
 * orders *below* the float32 quantum the samples are eventually rounded to
 * (~6e-8), so it is still far tighter than anything audible. Every mistake this
 * test is meant to catch - a mistyped constant, a dropped voice, an off-by-one
 * envelope, the wrong PRNG - moves samples by 1e-3 or more.
 *
 * The Mersenne Twister is asserted *exactly equal*, with no tolerance at all:
 * it is integer arithmetic, so any difference at all is a bug.
 */

import { afterEach, describe, expect, it } from "vitest";

import audioData from "../src/data/audio.json";
import {
  Audio,
  installUnlockGesture,
  minInterval,
  soundGain,
  voiceGain,
  type AudioContextLike,
  type GestureTarget,
} from "../src/audio/Audio";
import { MersenneTwister, SINE, Sig, semitone } from "../src/audio/dsp";
import { SOUND_NAMES, buildSig, isSoundName, renderSound } from "../src/audio/recipes";

import fixture from "./fixtures/audio_parity.json";
// The port's own source, read back so the constants in it can be checked
// against the Python they were transcribed from. `?raw` rather than `node:fs`
// because this project carries no `@types/node`.
import recipesSource from "../src/audio/recipes.ts?raw";

// ==========================================================================
// fixture typing
// ==========================================================================

interface ChannelStats {
  peak: number;
  rms: number;
  absSum: number;
}

interface SoundFixture {
  name: string;
  n: number;
  rate: number;
  rawPeak: number;
  stride: number;
  index: number[];
  left: number[];
  right: number[];
  statsLeft: ChannelStats;
  statsRight: ChannelStats;
  tailLeft: number;
  tailRight: number;
}

interface RngFixture {
  seed: number;
  first: number[];
  at2000: number[];
}

interface EnvFixture {
  args: number[];
  aN: number;
  hN: number;
  dec: number;
  relN: number;
  aInc: number;
  rInc: number;
}

interface AudioFixture {
  python: string;
  rate: number;
  names: string[];
  gain: Record<string, number>;
  minInterval: Record<string, number>;
  defaultInterval: number;
  masterVolume: number;
  tau: number;
  notes: Record<string, number>;
  sineTable: { len: number; index: number[]; value: number[] };
  rng: RngFixture[];
  envParams: EnvFixture[];
  sounds: SoundFixture[];
}

const FX = fixture as unknown as AudioFixture;

/** See the tolerance note in the file docstring. */
const SAMPLE_EPS = 1e-12;

/**
 * Sums run over up to 75000 samples, so they carry ~10^4 of magnitude and the
 * same relative error shows up three orders larger in absolute terms.
 */
const SUM_EPS = 1e-9;

/** Assert `actual` matches the Python `expected` to within `tol`. */
function near(actual: number, expected: number, tol: number, what: string): void {
  const delta = Math.abs(actual - expected);
  if (delta > tol) {
    throw new Error(
      `${what}: TypeScript ${actual} vs Python ${expected} (delta ${delta}, tol ${tol})`,
    );
  }
  expect(delta).toBeLessThanOrEqual(tol);
}

/** Pull a required number out of a fixture record. */
function fixNum(rec: Record<string, number>, key: string): number {
  const v = rec[key];
  if (v === undefined) throw new Error(`fixture is missing ${key}`);
  return v;
}

/** The same left-to-right accumulation the Python dump used. */
function channelStats(xs: Float64Array): ChannelStats {
  let peak = 0.0;
  let acc = 0.0;
  let absAcc = 0.0;
  for (let i = 0; i < xs.length; i++) {
    const v = xs[i]!;
    const a = v < 0.0 ? -v : v;
    if (a > peak) peak = a;
    acc += v * v;
    absAcc += a;
  }
  return { peak, rms: Math.sqrt(acc / xs.length), absSum: absAcc };
}

/** Build and normalise a cue exactly as `Audio._bake` does in Python. */
function bakeSig(name: string): Sig {
  if (!isSoundName(name)) throw new Error(`unknown cue ${name}`);
  const sig = buildSig(name, FX.rate);
  sig.normalise();
  return sig;
}

// ==========================================================================
// 1. the catalogue
// ==========================================================================
describe("audio: catalogue", () => {
  it("the exported data really is complete", () => {
    expect(audioData.missingRecipes).toEqual([]);
    expect(audioData.names.length).toBe(12);
    expect(Object.keys(audioData.recipes).sort()).toEqual([...audioData.names].sort());
  });

  it("SOUND_NAMES is exactly what the recipe table can build, in Python's order", () => {
    expect([...SOUND_NAMES]).toEqual(audioData.names);
    expect([...SOUND_NAMES]).toEqual(FX.names);
    // The cast in recipes.ts is only sound if every exported name really is a
    // key of the recipe table.
    for (const name of audioData.names) {
      expect(isSoundName(name), `${name} is buildable`).toBe(true);
    }
    expect(isSoundName("nope")).toBe(false);
    expect(isSoundName("toString")).toBe(false);
  });

  it("mix levels match audio.py", () => {
    for (const [name, want] of Object.entries(FX.gain)) {
      near(soundGain(name), want, 0, `_GAIN[${name}]`);
    }
    for (const name of SOUND_NAMES) {
      near(minInterval(name), FX.minInterval[name] ?? FX.defaultInterval, 0,
        `_MIN_INTERVAL[${name}]`);
    }
    near(minInterval("unknown"), FX.defaultInterval, 0, "_DEFAULT_INTERVAL");
    near(soundGain("unknown"), 0.5, 0, "_GAIN default");
    near(new Audio({ headless: true }).master, FX.masterVolume, 0, "_MASTER_VOLUME");
  });
});

// ==========================================================================
// 2. the pieces the DSP is built from
// ==========================================================================
describe("audio: primitives vs CPython", () => {
  it("the Mersenne Twister reproduces random.Random(seed) exactly", () => {
    expect(FX.rng.length).toBe(12);
    for (const want of FX.rng) {
      const mt = new MersenneTwister(want.seed);
      const drawn: number[] = [];
      for (let i = 0; i < 2004; i++) drawn.push(mt.next());
      // Integer arithmetic: no tolerance is warranted and none is given.
      expect(drawn.slice(0, 16), `seed ${want.seed} first 16`).toEqual(want.first);
      // Past 2000 draws the generator has reloaded its 624-word state three
      // times, which is where a wrong twist would show up.
      expect(drawn.slice(2000, 2004), `seed ${want.seed} at 2000`).toEqual(want.at2000);
    }
  });

  it("the sine wavetable matches math.sin", () => {
    expect(SINE.length).toBe(FX.sineTable.len);
    near(Math.PI * 2, FX.tau, 0, "TAU");
    FX.sineTable.index.forEach((i, j) => {
      near(SINE[i]!, FX.sineTable.value[j]!, 1e-15, `_SINE[${i}]`);
    });
  });

  it("the equal-tempered note frequencies match", () => {
    const C5 = semitone(440.0, 3);
    const E5 = semitone(440.0, 7);
    const G5 = semitone(440.0, 10);
    const tol = 1e-9;
    near(C5, fixNum(FX.notes, "C5"), tol, "_C5");
    near(E5, fixNum(FX.notes, "E5"), tol, "_E5");
    near(G5, fixNum(FX.notes, "G5"), tol, "_G5");
    near(C5 * 2.0, fixNum(FX.notes, "C6"), tol, "_C6");
    near(E5 * 2.0, fixNum(FX.notes, "E6"), tol, "_E6");
    near(G5 * 2.0, fixNum(FX.notes, "G6"), tol, "_G6");
    near(C5 * 0.5, fixNum(FX.notes, "C4"), tol, "_C4");
    near(G5 * 0.25, fixNum(FX.notes, "G3"), tol, "_G3");
    near(880.0, fixNum(FX.notes, "A5"), 0, "_A5");
    near(semitone(G5, 7), fixNum(FX.notes, "semitone_G5_7"), tol, "_semitone(_G5, 7)");
    near(semitone(G5, 12), fixNum(FX.notes, "semitone_G5_12"), tol, "_semitone(_G5, 12)");
  });

  it("the envelope coefficients match _env_params", () => {
    const sig = new Sig(1.0, FX.rate, 1);
    expect(FX.envParams.length).toBeGreaterThan(5);
    for (const want of FX.envParams) {
      const [n, attack, hold, release, decayTo] = want.args as [
        number, number, number, number, number,
      ];
      const got = sig.envParams(n, attack, hold, release, decayTo);
      const tag = `_env_params(${want.args.join(", ")})`;
      // Sample counts are integers; any drift here is a real bug.
      expect(got.aN, `${tag} a_n`).toBe(want.aN);
      expect(got.hN, `${tag} h_n`).toBe(want.hN);
      expect(got.relN, `${tag} rel_n`).toBe(want.relN);
      near(got.aInc, want.aInc, 0, `${tag} a_inc`);
      near(got.rInc, want.rInc, 0, `${tag} r_inc`);
      // `dec` is the one `Math.pow` result the whole decay shape rides on.
      near(got.dec, want.dec, 1e-15, `${tag} dec`);
    }
  });

  it("the envelope degenerate cases behave like Python's", () => {
    const sig = new Sig(1.0, FX.rate, 1);
    // tail <= 0 means there is no decay phase at all.
    const none = sig.envParams(4, 1.0, 1.0, 1.0, 0.5);
    expect(none.dec).toBe(0.0);
    // decay_to is clamped into 1e-4 .. 0.999 before the pow.
    const lo = sig.envParams(1000, 0.0, 0.0, 0.0, -5);
    const clampedLo = sig.envParams(1000, 0.0, 0.0, 0.0, 1e-4);
    expect(lo.dec).toBe(clampedLo.dec);
    const hi = sig.envParams(1000, 0.0, 0.0, 0.0, 5);
    const clampedHi = sig.envParams(1000, 0.0, 0.0, 0.0, 0.999);
    expect(hi.dec).toBe(clampedHi.dec);
    // attack and release never round down to nothing.
    expect(sig.envParams(1000, 0.0, 0.0, 0.0, 0.5).aN).toBe(1);
    expect(sig.envParams(1000, 0.0, 0.0, 0.0, 0.5).relN).toBe(2);
  });
});

// ==========================================================================
// 3. the twelve cues, sample for sample
// ==========================================================================
describe("audio: recipe parity vs Python-generated PCM", () => {
  it("the fixture is the real thing, at the rate the game asks for", () => {
    expect(FX.python.startsWith("3.")).toBe(true);
    expect(FX.rate).toBe(44100);
    expect(FX.sounds.length).toBe(12);
    // ...and it is a real signal, not a buffer of zeros.
    for (const s of FX.sounds) {
      expect(s.statsLeft.rms, `${s.name} rms`).toBeGreaterThan(0.04);
      expect(s.index.length, `${s.name} probe count`).toBeGreaterThan(150);
    }
  });

  it("every buffer is the length Python made it", () => {
    for (const want of FX.sounds) {
      expect(bakeSig(want.name).n, `${want.name} length`).toBe(want.n);
    }
  });

  it("every decimated sample matches Python on both channels", () => {
    let worst = 0;
    let worstWhere = "-";
    for (const want of FX.sounds) {
      const sig = bakeSig(want.name);
      want.index.forEach((i, j) => {
        const gotL = sig.left[i]!;
        const gotR = sig.right[i]!;
        near(gotL, want.left[j]!, SAMPLE_EPS, `${want.name} left[${i}]`);
        near(gotR, want.right[j]!, SAMPLE_EPS, `${want.name} right[${i}]`);
        const d = Math.max(Math.abs(gotL - want.left[j]!), Math.abs(gotR - want.right[j]!));
        if (d > worst) {
          worst = d;
          worstWhere = `${want.name}[${i}]`;
        }
      });
    }
    // Recorded so a regression shows up as a jump in the number, not only as a
    // threshold breach. Measured at 1.1102230246251565e-16.
    expect(worst, `worst sample delta ${worst} at ${worstWhere}`).toBeLessThan(1e-14);
  });

  it("peak, RMS and total magnitude match over the whole buffer", () => {
    for (const want of FX.sounds) {
      const sig = bakeSig(want.name);
      const gotL = channelStats(sig.left);
      const gotR = channelStats(sig.right);
      near(gotL.peak, want.statsLeft.peak, SAMPLE_EPS, `${want.name} left peak`);
      near(gotR.peak, want.statsRight.peak, SAMPLE_EPS, `${want.name} right peak`);
      near(gotL.rms, want.statsLeft.rms, SAMPLE_EPS, `${want.name} left rms`);
      near(gotR.rms, want.statsRight.rms, SAMPLE_EPS, `${want.name} right rms`);
      // Every sample contributes to this one, so it catches drift the
      // decimated probes step over.
      near(gotL.absSum, want.statsLeft.absSum, SUM_EPS, `${want.name} left absSum`);
      near(gotR.absSum, want.statsRight.absSum, SUM_EPS, `${want.name} right absSum`);
      near(sig.left[sig.n - 1]!, want.tailLeft, SAMPLE_EPS, `${want.name} last left`);
      near(sig.right[sig.n - 1]!, want.tailRight, SAMPLE_EPS, `${want.name} last right`);
    }
  });

  it("normalise fires on exactly the cues that clipped, and only those", () => {
    const clipped: string[] = [];
    for (const want of FX.sounds) {
      if (!isSoundName(want.name)) throw new Error(`unknown cue ${want.name}`);
      const raw = buildSig(want.name, FX.rate);
      const rawPeak = Math.max(channelStats(raw.left).peak, channelStats(raw.right).peak);
      near(rawPeak, want.rawPeak, SAMPLE_EPS, `${want.name} pre-normalise peak`);
      raw.normalise();
      const peak = Math.max(channelStats(raw.left).peak, channelStats(raw.right).peak);
      if (rawPeak > 0.95) {
        clipped.push(want.name);
        near(peak, 0.95, 1e-15, `${want.name} normalised peak`);
      } else {
        // A quiet cue must come through untouched, not scaled up.
        near(peak, rawPeak, 0, `${want.name} left alone by normalise`);
      }
    }
    expect(clipped).toEqual(["hit", "win"]);
  });

  it("no buffer starts or ends on a step, so nothing clicks", () => {
    // The Python design note in audio.py: every voice gets an attack ramp and
    // a release taper so a buffer never starts or ends on a non-zero sample -
    // that is what removes the speaker-popping tick at the edges.
    for (const want of FX.sounds) {
      const sig = bakeSig(want.name);
      const peak = Math.max(channelStats(sig.left).peak, channelStats(sig.right).peak);
      // The release taper lands exactly on silence.
      expect(sig.left[sig.n - 1]!, `${want.name} last left`).toBe(0);
      expect(sig.right[sig.n - 1]!, `${want.name} last right`).toBe(0);
      // The first sample is one step up the shortest attack ramp in the cue -
      // 1/44 of a noise burst in `hit`, the worst case at 0.6% of peak.
      const first = Math.max(Math.abs(sig.left[0]!), Math.abs(sig.right[0]!));
      expect(first / peak, `${want.name} first sample vs peak`).toBeLessThan(0.01);
    }
  });

  it("baking twice gives the identical buffer", () => {
    // The PRNG is per-cue and re-seeded, so there is no hidden global state to
    // make the second bake of a session differ from the first.
    for (const name of SOUND_NAMES) {
      const a = bakeSig(name);
      const b = bakeSig(name);
      expect(Array.from(a.left), `${name} left`).toEqual(Array.from(b.left));
      expect(Array.from(a.right), `${name} right`).toEqual(Array.from(b.right));
    }
  });

  it("renderSound narrows to float32 without losing anything audible", () => {
    for (const want of FX.sounds) {
      if (!isSoundName(want.name)) continue;
      const pcm = renderSound(want.name, FX.rate);
      const sig = bakeSig(want.name);
      expect(pcm.length, `${want.name} length`).toBe(want.n);
      expect(pcm.rate).toBe(FX.rate);
      expect(pcm.left.length).toBe(want.n);
      expect(pcm.right.length).toBe(want.n);
      let worst = 0;
      for (let i = 0; i < pcm.length; i++) {
        worst = Math.max(worst, Math.abs(pcm.left[i]! - sig.left[i]!));
        worst = Math.max(worst, Math.abs(pcm.right[i]! - sig.right[i]!));
      }
      // One float32 rounding step at unit scale and no more.
      expect(worst, `${want.name} float32 error`).toBeLessThan(6e-8);
    }
  });

  it("the recipes are rate-parametric, as the Python's are", () => {
    // Nothing may be hard-wired to 44100: a phone's context runs at 48000.
    const at48 = renderSound("eat", 48000);
    expect(at48.length).toBe(Math.trunc(0.15 * 48000));
    expect(at48.rate).toBe(48000);
    const peak = at48.left.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    // Same cue, same rough loudness, just more samples of it.
    expect(peak).toBeGreaterThan(0.5);
    expect(peak).toBeLessThan(0.8);
  });
});

// ==========================================================================
// 4. no constant was retyped wrongly
// ==========================================================================
describe("audio: recipe constants vs the exported Python source", () => {
  const source: string = recipesSource;

  /** Numeric literals, ignoring digits that are part of an identifier. */
  const NUMBER = /(?<![\w.])-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?(?![\w.])/g;

  function literals(text: string): Set<number> {
    const out = new Set<number>();
    for (const m of text.matchAll(NUMBER)) out.add(Number(m[0]));
    return out;
  }

  /** Python source with its docstring and comments removed. */
  function pythonBody(src: string): string {
    return src.replace(/"""[\s\S]*?"""/g, "").replace(/#[^\n]*/g, "");
  }

  /** The TypeScript builder for `name`, sliced out of recipes.ts. */
  function tsBody(name: string): string {
    const fn = `mk${name.charAt(0).toUpperCase()}${name.slice(1)}`;
    const start = source.indexOf(`function ${fn}(rate: number): Sig {`);
    if (start < 0) throw new Error(`recipes.ts has no ${fn}`);
    const end = source.indexOf("\n}", start);
    if (end < 0) throw new Error(`${fn} is not closed`);
    return source.slice(start, end);
  }

  it("every number in every Python recipe survives into the port", () => {
    const recipes = audioData.recipes as Record<string, string>;
    const missing: string[] = [];
    for (const name of audioData.names) {
      const py = recipes[name];
      if (py === undefined) throw new Error(`audio.json has no recipe for ${name}`);
      const wanted = literals(pythonBody(py));
      // A recipe with no constants would make this test vacuous.
      expect(wanted.size, `${name} constant count`).toBeGreaterThan(10);
      const got = literals(tsBody(name));
      for (const v of wanted) {
        if (!got.has(v)) missing.push(`${name}: ${v}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("the slicing actually found the twelve builders", () => {
    for (const name of audioData.names) {
      expect(tsBody(name).length, `${name} builder`).toBeGreaterThan(120);
    }
  });
});

// ==========================================================================
// 5. the engine, with no browser at all
// ==========================================================================
describe("audio: engine without Web Audio", () => {
  it("gain arithmetic matches Python's clamp(gain * volume * master)", () => {
    near(voiceGain("eat", 1.0, 1.0), fixNum(FX.gain, "eat"), 0, "eat at full");
    near(voiceGain("hover", 1.0, FX.masterVolume),
      fixNum(FX.gain, "hover") * FX.masterVolume, 0, "hover at master");
    near(voiceGain("eat", 0.5, 0.5), fixNum(FX.gain, "eat") * 0.25, 0, "eat halved twice");
    // clamped, exactly as `clamp(..., 0.0, 1.0)` does
    near(voiceGain("win", 10.0, 1.0), 1.0, 0, "over unity");
    near(voiceGain("win", -3.0, 1.0), 0.0, 0, "below zero");
    near(voiceGain("unknown", 1.0, 1.0), 0.5, 0, "unknown cue default");
  });

  it("a machine with no AudioContext plays the game silently", () => {
    const audio = new Audio({ createContext: () => null });
    expect(audio.available).toBe(false);
    expect(audio.sampleRate).toBe(0);
    // None of this may throw, and none of it may make a sound.
    expect(() => audio.play("eat")).not.toThrow();
    expect(() => audio.play("nonsense")).not.toThrow();
    expect(() => audio.stopAll()).not.toThrow();
    expect(() => audio.shutdown()).not.toThrow();
  });

  it("play() before unlock is a no-op, not a queue", async () => {
    const ctx = new StubContext();
    const audio = new Audio({ createContext: () => ctx as unknown as AudioContextLike });
    for (let i = 0; i < 50; i++) audio.play("click");
    expect(ctx.sources.length).toBe(0);
    expect(audio.available).toBe(false);

    await audio.unlock();
    expect(audio.available).toBe(true);
    // The fifty suppressed clicks must not arrive now.
    expect(ctx.sources.length).toBe(0);
    audio.shutdown();
  });

  it("a context factory that throws leaves the engine silent", async () => {
    const audio = new Audio({
      createContext: () => {
        throw new Error("no device");
      },
    });
    await expect(audio.unlock()).resolves.toBe(false);
    expect(audio.available).toBe(false);
    expect(() => audio.play("eat")).not.toThrow();
    audio.shutdown();
  });

  it("headless never touches the browser, exactly like Python's headless=True", async () => {
    let built = 0;
    const audio = new Audio({
      headless: true,
      createContext: () => {
        built += 1;
        return new StubContext() as unknown as AudioContextLike;
      },
    });
    await expect(audio.unlock()).resolves.toBe(false);
    expect(built).toBe(0);
    expect(audio.available).toBe(false);
    audio.play("win");
    expect(audio.headless).toBe(true);
  });

  it("introspection works before there is any audio at all", () => {
    const audio = new Audio({ headless: true });
    expect([...audio.soundNames()]).toEqual(audioData.names);
    expect(audio.has("eat")).toBe(true);
    expect(audio.has("nonsense")).toBe(false);
    expect(audio.isBaked("eat")).toBe(false);
  });

  it("mute and master volume behave like the Python facade", () => {
    const audio = new Audio({ headless: true });
    expect(audio.muted).toBe(false);
    expect(audio.toggleMute()).toBe(true);
    expect(audio.muted).toBe(true);
    expect(audio.toggleMute()).toBe(false);
    audio.setMuted(true);
    expect(audio.muted).toBe(true);
    audio.setMuted(false);

    near(audio.master, FX.masterVolume, 0, "default master");
    audio.setMasterVolume(0.25);
    near(audio.master, 0.25, 0, "master set");
    audio.setMasterVolume(4.0);
    near(audio.master, 1.0, 0, "master clamped high");
    audio.setMasterVolume(-1.0);
    near(audio.master, 0.0, 0, "master clamped low");
    expect(new Audio({ muted: true, headless: true }).muted).toBe(true);
  });
});

// ==========================================================================
// 6. the engine, against a stub context
// ==========================================================================

/**
 * A hand-rolled `AudioContext`.
 *
 * Node has no Web Audio, and a full mock library would only test itself. This
 * records what the engine asked for, which is the thing worth asserting: how
 * many buffers were baked, at what gain each voice played, and whether stopAll
 * really reached every live source.
 */
class StubNode {
  readonly connections: unknown[] = [];
  disconnects = 0;
  connect(destination: unknown): unknown {
    this.connections.push(destination);
    return destination;
  }
  disconnect(): void {
    this.disconnects += 1;
  }
}

class StubGain extends StubNode {
  readonly gain = { value: 1.0 };
}

class StubBuffer {
  readonly data: Float32Array[];
  constructor(
    readonly channels: number,
    readonly length: number,
    readonly rate: number,
  ) {
    this.data = [];
    for (let c = 0; c < channels; c++) this.data.push(new Float32Array(length));
  }
  get duration(): number {
    return this.length / this.rate;
  }
  getChannelData(channel: number): Float32Array {
    const d = this.data[channel];
    if (d === undefined) throw new Error(`no channel ${channel}`);
    return d;
  }
}

class StubSource extends StubNode {
  buffer: StubBuffer | null = null;
  starts = 0;
  stops = 0;
  start(): void {
    this.starts += 1;
  }
  stop(): void {
    this.stops += 1;
  }
}

class StubContext {
  state = "suspended";
  currentTime = 0.0;
  sampleRate = 44100;
  readonly destination = new StubNode();
  readonly sources: StubSource[] = [];
  readonly gains: StubGain[] = [];
  readonly buffers: StubBuffer[] = [];
  resumes = 0;
  closed = false;
  failCreateBuffer = false;

  async resume(): Promise<void> {
    this.resumes += 1;
    this.state = "running";
  }
  async close(): Promise<void> {
    this.closed = true;
    this.state = "closed";
  }
  createBuffer(channels: number, length: number, rate: number): StubBuffer {
    if (this.failCreateBuffer) throw new Error("out of memory");
    const b = new StubBuffer(channels, length, rate);
    this.buffers.push(b);
    return b;
  }
  createBufferSource(): StubSource {
    const s = new StubSource();
    this.sources.push(s);
    return s;
  }
  createGain(): StubGain {
    const g = new StubGain();
    this.gains.push(g);
    return g;
  }
}

describe("audio: engine against a stub context", () => {
  const engines: Audio[] = [];

  /** Build an unlocked engine; shutdown is automatic so no bake timer leaks. */
  async function unlocked(ctx: StubContext): Promise<Audio> {
    const audio = new Audio({ createContext: () => ctx as unknown as AudioContextLike });
    engines.push(audio);
    await audio.unlock();
    return audio;
  }

  afterEach(() => {
    while (engines.length > 0) engines.pop()?.shutdown();
  });

  it("unlock resumes once and is idempotent under concurrent calls", async () => {
    const ctx = new StubContext();
    const audio = new Audio({ createContext: () => ctx as unknown as AudioContextLike });
    engines.push(audio);
    const [a, b, c] = await Promise.all([audio.unlock(), audio.unlock(), audio.resume()]);
    expect([a, b, c]).toEqual([true, true, true]);
    expect(ctx.resumes).toBe(1);
    // The master gain is built once and wired straight to the destination.
    expect(ctx.gains.length).toBe(1);
    expect(ctx.gains[0]!.connections).toEqual([ctx.destination]);
    await expect(audio.unlock()).resolves.toBe(true);
    expect(ctx.resumes).toBe(1);
  });

  it("a context that will not start leaves play() silent and retryable", async () => {
    const ctx = new StubContext();
    // A browser that ignores resume(), which is what a blocked autoplay
    // policy looks like from here.
    ctx.resume = async (): Promise<void> => {
      ctx.resumes += 1;
    };
    const audio = new Audio({ createContext: () => ctx as unknown as AudioContextLike });
    engines.push(audio);
    await expect(audio.unlock()).resolves.toBe(false);
    audio.play("eat");
    expect(ctx.sources.length).toBe(0);
    // A failed attempt is forgotten, so the next gesture gets a fresh try.
    await expect(audio.unlock()).resolves.toBe(false);
    expect(ctx.resumes).toBe(2);
  });

  it("plays a cue through source -> voice gain -> master gain", async () => {
    const ctx = new StubContext();
    const audio = await unlocked(ctx);
    audio.play("eat");

    expect(ctx.sources.length).toBe(1);
    const src = ctx.sources[0]!;
    expect(src.starts).toBe(1);
    expect(src.buffer).not.toBeNull();
    expect(src.buffer!.channels).toBe(2);
    expect(src.buffer!.length).toBe(6615);
    expect(src.buffer!.rate).toBe(44100);

    // gains[0] is the master; gains[1] is this voice.
    const voice = ctx.gains[1]!;
    near(voice.gain.value, voiceGain("eat", 1.0, FX.masterVolume), 0, "voice gain");
    expect(src.connections).toEqual([voice]);
    expect(voice.connections).toEqual([ctx.gains[0]!]);
  });

  it("the baked buffer holds exactly the samples renderSound produced", async () => {
    const ctx = new StubContext();
    const audio = await unlocked(ctx);
    audio.play("portal");
    const buf = ctx.sources[0]!.buffer!;
    const pcm = renderSound("portal", 44100);
    expect(Array.from(buf.getChannelData(0))).toEqual(Array.from(pcm.left));
    expect(Array.from(buf.getChannelData(1))).toEqual(Array.from(pcm.right));
  });

  it("bakes each cue once and reuses it", async () => {
    const ctx = new StubContext();
    const audio = await unlocked(ctx);
    expect(audio.isBaked("eat")).toBe(false);
    audio.play("eat");
    expect(audio.isBaked("eat")).toBe(true);
    const baked = ctx.buffers.length;
    for (let i = 0; i < 5; i++) {
      ctx.currentTime += 1.0;
      audio.play("eat");
    }
    expect(ctx.buffers.length).toBe(baked);
    expect(ctx.sources.length).toBe(6);
  });

  it("the background bake fills the whole bank without being asked", async () => {
    const ctx = new StubContext();
    const audio = await unlocked(ctx);
    // One cue per task, so give the queue time to drain.
    await new Promise((r) => setTimeout(r, 250));
    for (const name of SOUND_NAMES) {
      expect(audio.isBaked(name), `${name} baked`).toBe(true);
    }
    expect(ctx.buffers.length).toBe(12);
  });

  it("throttles retriggers with audio.py's per-cue intervals", async () => {
    const ctx = new StubContext();
    const audio = await unlocked(ctx);
    // Ten "eat"s inside one frame, as a magnet pickup would fire them.
    for (let i = 0; i < 10; i++) audio.play("eat");
    expect(ctx.sources.length).toBe(1);

    ctx.currentTime += minInterval("eat") * 0.5;
    audio.play("eat");
    expect(ctx.sources.length).toBe(1);

    ctx.currentTime += minInterval("eat");
    audio.play("eat");
    expect(ctx.sources.length).toBe(2);

    // The gate is per cue, not global.
    audio.play("hover");
    expect(ctx.sources.length).toBe(3);
  });

  it("unknown names are ignored in silence", async () => {
    const ctx = new StubContext();
    const audio = await unlocked(ctx);
    expect(() => audio.play("explode")).not.toThrow();
    expect(() => audio.play("")).not.toThrow();
    expect(() => audio.play("constructor")).not.toThrow();
    expect(ctx.sources.length).toBe(0);
  });

  it("muting silences new cues and cuts the ones already sounding", async () => {
    const ctx = new StubContext();
    const audio = await unlocked(ctx);
    audio.play("win");
    const src = ctx.sources[0]!;
    expect(src.stops).toBe(0);

    audio.setMuted(true);
    expect(src.stops).toBe(1);
    audio.play("eat");
    expect(ctx.sources.length).toBe(1);

    audio.setMuted(false);
    ctx.currentTime += 1.0;
    audio.play("eat");
    expect(ctx.sources.length).toBe(2);
  });

  it("stopAll reaches every live voice and disconnects it", async () => {
    const ctx = new StubContext();
    const audio = await unlocked(ctx);
    audio.play("win");
    audio.play("die");
    audio.play("boost");
    expect(ctx.sources.length).toBe(3);
    audio.stopAll();
    for (const s of ctx.sources) {
      expect(s.stops).toBe(1);
      expect(s.disconnects).toBe(1);
    }
    // Stopping twice must not stop a voice twice.
    audio.stopAll();
    for (const s of ctx.sources) expect(s.stops).toBe(1);
  });

  it("voices that have finished are forgotten rather than stopped later", async () => {
    const ctx = new StubContext();
    const audio = await unlocked(ctx);
    audio.play("eat"); // 0.15 s long
    const first = ctx.sources[0]!;
    ctx.currentTime += 1.0;
    audio.play("eat");
    audio.stopAll();
    expect(first.stops).toBe(0);
    expect(ctx.sources[1]!.stops).toBe(1);
  });

  it("the master volume scales every subsequent voice", async () => {
    const ctx = new StubContext();
    const audio = await unlocked(ctx);
    audio.setMasterVolume(0.5);
    audio.play("hit", 0.8);
    near(ctx.gains[1]!.gain.value, voiceGain("hit", 0.8, 0.5), 0, "scaled voice");
    audio.setMasterVolume(0.0);
    ctx.currentTime += 1.0;
    audio.play("hit");
    near(ctx.gains[2]!.gain.value, 0.0, 0, "silent voice");
  });

  it("a device that fails mid-bake drops the cue instead of throwing", async () => {
    const ctx = new StubContext();
    const audio = await unlocked(ctx);
    ctx.failCreateBuffer = true;
    expect(() => audio.play("die")).not.toThrow();
    expect(ctx.sources.length).toBe(0);
    expect(audio.isBaked("die")).toBe(false);
    // ...and recovers once the device does.
    ctx.failCreateBuffer = false;
    ctx.currentTime += 1.0;
    audio.play("die");
    expect(ctx.sources.length).toBe(1);
  });

  it("shutdown closes the context and stays safe when called twice", async () => {
    const ctx = new StubContext();
    const audio = await unlocked(ctx);
    audio.play("levelup");
    audio.shutdown();
    expect(ctx.closed).toBe(true);
    expect(audio.available).toBe(false);
    expect(audio.isBaked("levelup")).toBe(false);
    expect(() => audio.shutdown()).not.toThrow();
    expect(() => audio.play("levelup")).not.toThrow();
    await expect(audio.unlock()).resolves.toBe(false);
  });

  it("the gesture helper unlocks once and then unhooks itself", async () => {
    const ctx = new StubContext();
    const audio = new Audio({ createContext: () => ctx as unknown as AudioContextLike });
    engines.push(audio);

    const handlers = new Map<string, (() => void)[]>();
    const target: GestureTarget = {
      addEventListener(type, handler) {
        const list = handlers.get(type) ?? [];
        list.push(handler);
        handlers.set(type, list);
      },
      removeEventListener(type, handler) {
        const list = handlers.get(type) ?? [];
        handlers.set(type, list.filter((h) => h !== handler));
      },
    };

    const dispose = installUnlockGesture(audio, target);
    expect(handlers.get("pointerdown")?.length).toBe(1);
    expect(handlers.get("keydown")?.length).toBe(1);

    handlers.get("pointerdown")?.[0]?.();
    await audio.unlock();
    // The listener retires only after the context is genuinely running.
    await new Promise((r) => setTimeout(r, 0));
    expect(audio.available).toBe(true);
    expect(handlers.get("pointerdown")?.length).toBe(0);
    expect(handlers.get("touchend")?.length).toBe(0);
    expect(() => dispose()).not.toThrow();
  });
});
