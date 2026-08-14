/**
 * The twelve cue recipes - a port of the `_mk_*` builders in
 * `snake/core/audio.py`.
 *
 * Each builder is a transcription of its Python original, call for call and
 * constant for constant. That literalness is deliberate and is checked: the
 * parity spec pulls the Python source of every recipe out of
 * `data/audio.json` (which `tools/export_data.py` exports verbatim), strips
 * its comments, and asserts that every numeric literal Python uses also
 * appears in the corresponding function below. A transposed digit therefore
 * fails a test rather than quietly changing how the game sounds.
 *
 * Two things worth knowing when reading them:
 *
 * *   **Voice order matters.** A {@link Sig} owns one seeded PRNG shared by all
 *     its noise bursts, so `hit`'s second burst continues the stream its first
 *     one left off. Reordering the calls in a recipe changes the noise even
 *     though every argument is untouched.
 *
 * *   **`rate` is a parameter, not a constant.** Python bakes at whatever rate
 *     the mixer actually opened; the web build bakes at the `AudioContext`'s
 *     rate, which on most phones is 48000 rather than 44100. The recipes are
 *     written in seconds and hertz so both land on the same sound. Parity is
 *     measured at 44100, the rate the Python asks for.
 */

import audioData from "../data/audio.json";

import { Sig, semitone } from "./dsp";

// Note frequencies used by the musical cues (A4 = 440).
const C5 = semitone(440.0, 3);
const E5 = semitone(440.0, 7);
const G5 = semitone(440.0, 10);
const A5 = 880.0;
const C6 = C5 * 2.0;
const E6 = E5 * 2.0;
const G6 = G5 * 2.0;
const C4 = C5 * 0.5;
const G3 = G5 * 0.25;

// ==========================================================================
// The twelve recipes
// ==========================================================================

/** Short rising blip with a glassy second partial. */
function mkEat(rate: number): Sig {
  const s = new Sig(0.15, rate, 11);
  s.tone(0.0, 0.12, 620.0, 990.0, { amp: 0.55, shape: "sine", attack: 0.004, release: 0.03 });
  s.tone(0.0, 0.10, 1240.0, 1980.0, { amp: 0.16, shape: "sine", attack: 0.003, release: 0.03 });
  s.tone(0.0, 0.05, 300.0, 240.0, { amp: 0.18, shape: "tri", attack: 0.002, release: 0.02 });
  return s;
}

/** Two-note arpeggio, brighter than `eat`, with a shimmer tail. */
function mkBonus(rate: number): Sig {
  const s = new Sig(0.40, rate, 22);
  s.tone(0.000, 0.16, G5, G5, {
    amp: 0.42, shape: "fm", fmRatio: 2.0, fmIndex: 1.1,
    attack: 0.004, hold: 0.02, release: 0.05, pan: -0.25,
  });
  s.tone(0.085, 0.24, semitone(G5, 7), null, {
    amp: 0.42, shape: "fm", fmRatio: 2.0,
    fmIndex: 1.3, attack: 0.004, hold: 0.03, release: 0.06, pan: 0.25,
  });
  s.tone(0.150, 0.20, semitone(G5, 12), null, {
    amp: 0.18, shape: "sine", attack: 0.006, release: 0.08,
  });
  return s;
}

/** Shimmering upward sweep: detuned pair + fast-vibrato sparkle + ring. */
function mkPowerup(rate: number): Sig {
  const s = new Sig(0.66, rate, 33);
  s.tone(0.0, 0.50, 300.0, 1500.0, {
    amp: 0.30, shape: "sine", attack: 0.02, release: 0.10, decayTo: 0.30, pan: -0.30,
  });
  s.tone(0.0, 0.50, 303.0, 1512.0, {
    amp: 0.28, shape: "tri", attack: 0.02, release: 0.10, decayTo: 0.30, pan: 0.30,
  });
  // The sparkle rides a 7 Hz vibrato so the sweep glitters instead of whining.
  s.tone(0.06, 0.52, 900.0, 2600.0, {
    amp: 0.14, shape: "sine", attack: 0.05, release: 0.14, vibRate: 7.0, vibDepth: 0.02,
  });
  s.tone(0.42, 0.22, 1760.0, 1760.0, {
    amp: 0.20, shape: "fm", fmRatio: 3.0, fmIndex: 1.4, attack: 0.005, release: 0.12,
  });
  return s;
}

/** Harsh bright noise burst stacked on a low body thump. */
function mkHit(rate: number): Sig {
  const s = new Sig(0.30, rate, 44);
  s.noise(0.0, 0.16, { amp: 0.55, attack: 0.001, release: 0.05, lp0: 0.85, lp1: 0.20, hp: 0.45 });
  s.tone(0.0, 0.26, 150.0, 46.0, { amp: 0.65, shape: "sine", attack: 0.002, release: 0.06 });
  s.tone(0.0, 0.09, 210.0, 90.0, { amp: 0.22, shape: "square", attack: 0.001, release: 0.03 });
  s.noise(0.02, 0.22, { amp: 0.18, attack: 0.004, release: 0.08, lp0: 0.10, lp1: 0.03 });
  return s;
}

/** Long descending detuned tone - the two voices beat against each other. */
function mkDie(rate: number): Sig {
  const s = new Sig(1.05, rate, 55);
  s.tone(0.0, 0.95, 440.0, 104.0, {
    amp: 0.40, shape: "saw", attack: 0.010, release: 0.22, decayTo: 0.05, pan: -0.35,
  });
  s.tone(0.0, 0.95, 446.0, 106.0, {
    amp: 0.36, shape: "tri", attack: 0.012, release: 0.22, decayTo: 0.05, pan: 0.35,
  }); // +6 Hz detune -> slow beating
  s.tone(0.0, 0.98, 110.0, 42.0, {
    amp: 0.32, shape: "sine", attack: 0.014, release: 0.26, decayTo: 0.04,
  });
  s.noise(0.0, 0.30, { amp: 0.13, attack: 0.004, release: 0.14, lp0: 0.28, lp1: 0.05 });
  return s;
}

/** Soft UI tick: tiny noise transient plus a falling sine pip. */
function mkClick(rate: number): Sig {
  const s = new Sig(0.09, rate, 66);
  s.tone(0.0, 0.060, 920.0, 660.0, { amp: 0.45, shape: "sine", attack: 0.002, release: 0.02 });
  s.noise(0.0, 0.018, { amp: 0.16, attack: 0.001, release: 0.008, lp0: 0.55, lp1: 0.20, hp: 0.30 });
  return s;
}

/** Very quiet, very high tick for cursor roll-over. */
function mkHover(rate: number): Sig {
  const s = new Sig(0.06, rate, 77);
  s.tone(0.0, 0.042, 1900.0, 2150.0, { amp: 0.26, shape: "sine", attack: 0.002, release: 0.02 });
  s.tone(0.0, 0.030, 2850.0, null, { amp: 0.08, shape: "sine", attack: 0.002, release: 0.015 });
  return s;
}

/** Confident rising major triad, capped with the octave. */
function mkStart(rate: number): Sig {
  const s = new Sig(0.72, rate, 88);
  const triad: readonly (readonly [number, number])[] = [[C5, -0.30], [E5, 0.0], [G5, 0.30]];
  triad.forEach(([f, pan], i) => {
    s.tone(i * 0.085, 0.42 - i * 0.03, f, null, {
      amp: 0.34, shape: "fm", fmRatio: 2.0, fmIndex: 0.9, attack: 0.008, hold: 0.05,
      release: 0.12, decayTo: 0.12, pan,
    });
  });
  s.tone(0.255, 0.42, C6, null, {
    amp: 0.32, shape: "sine", attack: 0.008, hold: 0.06, release: 0.16, decayTo: 0.08,
  });
  s.tone(0.0, 0.55, C4, null, {
    amp: 0.16, shape: "tri", attack: 0.02, release: 0.20, decayTo: 0.06,
  });
  return s;
}

/** Four-note ascending fanfare with a shimmering tail. */
function mkLevelup(rate: number): Sig {
  const s = new Sig(0.90, rate, 99);
  const notes: readonly number[] = [C5, E5, G5, C6];
  notes.forEach((f, i) => {
    const pan = -0.25 + 0.5 * (i / 3.0);
    s.tone(i * 0.105, 0.34, f, null, {
      amp: 0.34, shape: "fm", fmRatio: 3.0, fmIndex: 1.0 + 0.15 * i, attack: 0.006, hold: 0.04,
      release: 0.12, decayTo: 0.10, pan,
    });
  });
  s.tone(0.315, 0.50, E6, null, {
    amp: 0.16, shape: "sine", attack: 0.02, release: 0.22, decayTo: 0.05,
    vibRate: 6.0, vibDepth: 0.006,
  });
  s.noise(0.30, 0.34, { amp: 0.07, attack: 0.03, release: 0.18, lp0: 0.90, lp1: 0.55, hp: 0.6 });
  return s;
}

/** Longer major fanfare: a rising run into a held, wide triad. */
function mkWin(rate: number): Sig {
  const s = new Sig(1.70, rate, 101);
  const run: readonly (readonly [number, number])[] = [
    [C5, 0.00], [E5, 0.10], [G5, 0.20], [C6, 0.30], [E6, 0.40],
  ];
  for (const [f, t] of run) {
    s.tone(t, 0.30, f, null, {
      amp: 0.28, shape: "fm", fmRatio: 2.0, fmIndex: 1.1,
      attack: 0.006, hold: 0.05, release: 0.10, decayTo: 0.10,
    });
  }
  // Held chord: each voice panned differently so the ending sounds wide.
  const chord: readonly (readonly [number, number])[] = [[C6, -0.40], [E6, 0.0], [G6, 0.40]];
  for (const [f, pan] of chord) {
    s.tone(0.52, 1.12, f, null, {
      amp: 0.26, shape: "fm", fmRatio: 2.0, fmIndex: 0.8,
      attack: 0.020, hold: 0.35, release: 0.40, decayTo: 0.06, pan,
    });
  }
  s.tone(0.52, 1.10, C4, null, {
    amp: 0.20, shape: "tri", attack: 0.030, hold: 0.30, release: 0.40, decayTo: 0.05,
  });
  s.tone(0.52, 1.05, G3, null, {
    amp: 0.13, shape: "sine", attack: 0.040, hold: 0.25, release: 0.40, decayTo: 0.05,
  });
  s.tone(0.60, 0.90, A5 * 2.0, null, {
    amp: 0.07, shape: "sine", attack: 0.10, release: 0.40, decayTo: 0.05,
    vibRate: 5.5, vibDepth: 0.005,
  });
  return s;
}

/** Filtered whoosh - the low-pass cutoff opens then slams shut. */
function mkBoost(rate: number): Sig {
  const s = new Sig(0.58, rate, 112);
  s.noise(0.00, 0.26, {
    amp: 0.42, attack: 0.05, release: 0.10, decayTo: 0.55, lp0: 0.02, lp1: 0.45, pan: -0.20,
  });
  s.noise(0.22, 0.34, {
    amp: 0.40, attack: 0.02, release: 0.16, decayTo: 0.02, lp0: 0.45, lp1: 0.04, pan: 0.20,
  });
  s.tone(0.00, 0.42, 90.0, 260.0, {
    amp: 0.22, shape: "sine", attack: 0.04, release: 0.16, decayTo: 0.12,
  });
  return s;
}

/** Warbling ring: deep vibrato plus ring modulation on a bell-ish FM tone. */
function mkPortal(rate: number): Sig {
  const s = new Sig(0.78, rate, 123);
  s.tone(0.0, 0.72, 660.0, 690.0, {
    amp: 0.34, shape: "fm", fmRatio: 1.5, fmIndex: 1.6,
    attack: 0.012, release: 0.20, decayTo: 0.12,
    vibRate: 11.0, vibDepth: 0.085, pan: -0.35,
  });
  // Same idea an octave up, warbling at a slightly different rate so the two
  // sides of the stereo field drift in and out of phase.
  s.tone(0.03, 0.66, 990.0, 950.0, {
    amp: 0.24, shape: "sine",
    attack: 0.015, release: 0.22, decayTo: 0.10,
    vibRate: 8.5, vibDepth: 0.070, amRate: 6.0, amDepth: 0.45, pan: 0.35,
  });
  s.tone(0.0, 0.55, 165.0, 210.0, {
    amp: 0.18, shape: "tri", attack: 0.03, release: 0.20, decayTo: 0.06,
  });
  return s;
}

// ==========================================================================
// Catalogue
// ==========================================================================

/** Builds one cue's unnormalised stereo buffer at the given sample rate. */
export type Recipe = (rate: number) => Sig;

const RECIPES = {
  eat: mkEat,
  bonus: mkBonus,
  powerup: mkPowerup,
  hit: mkHit,
  die: mkDie,
  click: mkClick,
  hover: mkHover,
  start: mkStart,
  levelup: mkLevelup,
  win: mkWin,
  boost: mkBoost,
  portal: mkPortal,
} satisfies Record<string, Recipe>;

/** The name of a cue the game can play. */
export type SoundName = keyof typeof RECIPES;

/**
 * The complete vocabulary, taken from the exported catalogue rather than
 * retyped. The cast is safe because the spec asserts these names are exactly
 * the keys of {@link RECIPES}; if `export_data.py` ever adds a cue, that test
 * fails before anything can ask for a sound that does not exist.
 */
export const SOUND_NAMES: readonly SoundName[] = audioData.names as SoundName[];

/** Is `name` a cue this build knows how to synthesise? */
export function isSoundName(name: string): name is SoundName {
  return Object.prototype.hasOwnProperty.call(RECIPES, name);
}

/** Build one cue, unnormalised, exactly as the Python recipe does. */
export function buildSig(name: SoundName, rate: number): Sig {
  return RECIPES[name](rate);
}

/** A baked cue: normalised stereo samples ready for an `AudioBuffer`. */
export interface StereoPcm {
  readonly rate: number;
  readonly length: number;
  readonly left: Float32Array;
  readonly right: Float32Array;
}

/**
 * Bake a cue to float32.
 *
 * The mix is accumulated and normalised in double precision (see `dsp.ts`) and
 * narrowed here, once, because that is the only precision Web Audio accepts.
 */
export function renderSound(name: SoundName, rate: number): StereoPcm {
  const sig = buildSig(name, rate);
  sig.normalise();
  return {
    rate,
    length: sig.n,
    left: Float32Array.from(sig.left),
    right: Float32Array.from(sig.right),
  };
}
