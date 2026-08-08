"""
Procedural sound engine for NEON SERPENT.

There are no audio assets on disk and numpy is *not* installed, so every effect
in the game is synthesised at start-up into a stdlib :mod:`array` of signed
16-bit samples and handed straight to ``pygame.mixer.Sound(buffer=...)``.

Design notes
------------
*   A 2048-entry wavetable (:data:`_SINE`) replaces ``math.sin`` inside the
    per-sample loops: a list index plus an integer mask is far cheaper than a
    libm call in CPython, which keeps the whole 12-cue bake sub-second.
*   Frequency glides advance by a *multiplicative* per-sample ratio
    ``k = (f1 / f0) ** (1 / n)`` instead of calling ``pow`` every sample.  The
    phase accumulator is driven by the instantaneous frequency, so the glide is
    phase-continuous (no clicks) and log-linear (musical).
*   Every voice gets an attack ramp, an exponential decay and a short linear
    release taper, so a buffer never starts or ends on a non-zero sample -
    that is what removes the speaker-popping "tick" at the edges.
*   Stereo is honoured for real: ``pygame.mixer.get_init()`` is read back and
    the float buffers are interleaved to match the channel count, sample width
    and signedness the device actually gave us.

Nothing here may ever raise.  If the mixer cannot open, or ``headless=True``,
the whole module degrades to a silent no-op and the game runs exactly as
before, just quietly.
"""

from __future__ import annotations

import array
import math
import random
from typing import Callable, Dict, List, Optional, Tuple

try:  # pragma: no cover - pygame is a hard dependency of the game, not of us
    import pygame
except Exception:  # pragma: no cover
    pygame = None  # type: ignore[assignment]

from .. import config as C  # noqa: F401  (kept for constant parity / future use)
from .contracts import TAU, clamp

__all__ = ["Audio", "SOUND_NAMES"]


# ==========================================================================
# Mixer format we *ask* for.  Whatever we actually get is read back later.
# ==========================================================================
_WANT_RATE = 44100
_WANT_SIZE = -16          # signed 16-bit, native endian
_WANT_CHANNELS = 2        # stereo -> interleaved L,R,L,R,...
_WANT_BUFFER = 512        # small buffer: arcade hits need low latency
_NUM_CHANNELS = 24        # simultaneous voices pygame may mix

# Sample widths `_to_buffer` knows how to pack by hand.  Anything else (a
# float32 device, say) means we run silent rather than emit static.
_PACKABLE_SIZES = (8, -8, 16, -16)

_MASTER_VOLUME = 0.72

# The complete vocabulary the rest of the game may pass to Audio.play().
SOUND_NAMES: Tuple[str, ...] = (
    "eat", "bonus", "powerup", "hit", "die", "click",
    "hover", "start", "levelup", "win", "boost", "portal",
)

# Per-sound trim so that a quiet tick and a death sting sit at sane relative
# levels without having to normalise every buffer to the same peak.
_GAIN: Dict[str, float] = {
    "eat": 0.50, "bonus": 0.55, "powerup": 0.60, "hit": 0.72,
    "die": 0.70, "click": 0.34, "hover": 0.15, "start": 0.60,
    "levelup": 0.66, "win": 0.72, "boost": 0.44, "portal": 0.52,
}

# Minimum seconds between two plays of the same cue.  Gameplay can fire "eat"
# or "hover" many times in a single frame; without this the mixer turns into
# mush and the volume stacks painfully.
_MIN_INTERVAL: Dict[str, float] = {
    "eat": 0.030, "hover": 0.070, "click": 0.040, "boost": 0.090,
    "hit": 0.060, "portal": 0.120,
}
_DEFAULT_INTERVAL = 0.020


# ==========================================================================
# Wavetable
# ==========================================================================
_TABLE_BITS = 11
_TABLE_LEN = 1 << _TABLE_BITS          # 2048
_TABLE_MASK = _TABLE_LEN - 1
_HALF_TABLE = _TABLE_LEN >> 1
_QUARTER_TABLE = _TABLE_LEN >> 2
_SINE: List[float] = [math.sin(TAU * i / _TABLE_LEN) for i in range(_TABLE_LEN)]
# Radians -> table units, used to express FM modulation depth musically.
_RAD_TO_IDX = _TABLE_LEN / TAU

# Shape codes (ints so the inner loop compares small ints, not strings).
_SH_SINE, _SH_SAW, _SH_SQUARE, _SH_TRI, _SH_FM = 0, 1, 2, 3, 4
_SHAPES: Dict[str, int] = {
    "sine": _SH_SINE, "saw": _SH_SAW, "square": _SH_SQUARE,
    "tri": _SH_TRI, "fm": _SH_FM,
}


def _semitone(base: float, steps: float) -> float:
    """Frequency `steps` equal-tempered semitones above `base`."""
    return base * (2.0 ** (steps / 12.0))


# Note frequencies used by the musical cues (A4 = 440).
_C5 = _semitone(440.0, 3)      # 523.25
_E5 = _semitone(440.0, 7)      # 659.26
_G5 = _semitone(440.0, 10)     # 783.99
_A5 = 880.0
_C6 = _C5 * 2.0
_E6 = _E5 * 2.0
_G6 = _G5 * 2.0
_C4 = _C5 * 0.5
_G3 = _G5 * 0.25


# ==========================================================================
# Signal buffer
# ==========================================================================
class _Sig:
    """A short stereo scratch buffer of floats, rendered voice by voice."""

    __slots__ = ("rate", "n", "left", "right", "_rng")

    def __init__(self, duration: float, rate: int, seed: int = 1) -> None:
        self.rate = rate
        self.n = max(1, int(duration * rate))
        self.left: List[float] = [0.0] * self.n
        self.right: List[float] = [0.0] * self.n
        self._rng = random.Random(seed)

    # -- envelope helper ---------------------------------------------------
    def _env_params(
        self, n: int, attack: float, hold: float, release: float, decay_to: float
    ) -> Tuple[int, int, float, int, float, float]:
        """Pre-compute the cheap per-sample envelope coefficients."""
        rate = self.rate
        a_n = max(1, min(n, int(attack * rate)))
        h_n = max(0, min(n - a_n, int(hold * rate)))
        tail = n - a_n - h_n
        floor = max(1e-4, min(0.999, decay_to))
        # Multiplying by `dec` once per sample gives an exponential decay that
        # lands exactly on `floor` at the end of the note.
        dec = floor ** (1.0 / tail) if tail > 0 else 0.0
        rel_n = max(2, min(n, int(release * rate)))
        return a_n, h_n, dec, rel_n, 1.0 / a_n, 1.0 / rel_n

    # -- oscillator voice --------------------------------------------------
    def tone(
        self, start: float, dur: float, f0: float, f1: Optional[float] = None, *,
        amp: float = 0.5, shape: str = "sine",
        attack: float = 0.006, hold: float = 0.0, release: float = 0.020,
        decay_to: float = 0.0015,
        vib_rate: float = 0.0, vib_depth: float = 0.0,
        fm_ratio: float = 2.0, fm_index: float = 0.0,
        am_rate: float = 0.0, am_depth: float = 0.0, pan: float = 0.0,
    ) -> None:
        """Mix one enveloped oscillator into the buffer.

        `f1` is the frequency at the end of the note (glide); `vib_depth` and
        `am_depth` are fractions of 1; `fm_index` is in radians of phase
        deviation.  `pan` runs -1 (left) .. +1 (right).
        """
        rate = self.rate
        i0 = max(0, int(start * rate))
        n = min(int(dur * rate), self.n - i0)
        if n <= 2 or amp <= 0.0 or f0 <= 0.0:
            return

        code = _SHAPES.get(shape, _SH_SINE)
        f1 = f0 if f1 is None else max(1.0, f1)
        # Per-sample multiplicative pitch ratio -> exponential (musical) glide.
        k = (f1 / f0) ** (1.0 / n)

        a_n, h_n, dec, rel_n, a_inc, r_inc = self._env_params(
            n, attack, hold, release, decay_to
        )
        hold_end = a_n + h_n
        rel_start = n - rel_n

        # Equal-ish pan law kept deliberately simple: centre is unity on both
        # sides, hard pan silences the opposite channel.
        gl = amp * (1.0 - max(0.0, pan))
        gr = amp * (1.0 + min(0.0, pan))

        left, right, table = self.left, self.right, _SINE
        step = _TABLE_LEN / rate            # Hz -> table units per sample
        phase = 0.0
        vib_phase = 0.0
        am_phase = 0.0
        vib_step = vib_rate * step
        am_step = am_rate * step
        freq = f0
        env = 0.0
        fm_amt = fm_index * _RAD_TO_IDX

        for i in range(n):
            # --- envelope -------------------------------------------------
            if i < a_n:
                env = (i + 1) * a_inc
            elif i < hold_end:
                env = 1.0
            else:
                env *= dec
            e = env
            if i >= rel_start:
                e *= (n - i) * r_inc

            # --- oscillator ----------------------------------------------
            idx = int(phase)
            if code == _SH_SINE:
                v = table[idx & _TABLE_MASK]
            elif code == _SH_FM:
                mod = table[int(phase * fm_ratio) & _TABLE_MASK]
                v = table[int(phase + fm_amt * mod) & _TABLE_MASK]
            elif code == _SH_SAW:
                # Offset half a cycle so the ramp crosses zero at phase 0,
                # exactly like the sine table - keeps note onsets click-free.
                v = (((idx + _HALF_TABLE) & _TABLE_MASK) * (2.0 / _TABLE_LEN)) - 1.0
            elif code == _SH_SQUARE:
                v = 1.0 if (idx & _HALF_TABLE) else -1.0
            else:  # triangle, likewise shifted a quarter cycle to start at 0
                p = ((idx + _QUARTER_TABLE) & _TABLE_MASK) * (1.0 / _TABLE_LEN)
                v = 4.0 * (p if p < 0.5 else 1.0 - p) - 1.0

            if am_depth:
                v *= 1.0 - am_depth + am_depth * table[int(am_phase) & _TABLE_MASK]
                am_phase += am_step

            # --- advance phase -------------------------------------------
            if vib_depth:
                inst = freq * (1.0 + vib_depth * table[int(vib_phase) & _TABLE_MASK])
                vib_phase += vib_step
            else:
                inst = freq
            phase += inst * step
            freq *= k

            v *= e
            j = i0 + i
            left[j] += v * gl
            right[j] += v * gr

    # -- noise voice -------------------------------------------------------
    def noise(
        self, start: float, dur: float, *,
        amp: float = 0.5, attack: float = 0.002, hold: float = 0.0,
        release: float = 0.020, decay_to: float = 0.002,
        lp0: float = 0.30, lp1: Optional[float] = None,
        hp: float = 0.0, pan: float = 0.0,
    ) -> None:
        """Mix a burst of one-pole-filtered white noise.

        `lp0`/`lp1` are the filter coefficient at the start and end of the
        burst (0 = very dark, 1 = unfiltered), so sweeping them produces the
        classic "whoosh".  `hp` blends in the high-pass residual (x - y) for
        bright, hissy transients.
        """
        rate = self.rate
        i0 = max(0, int(start * rate))
        n = min(int(dur * rate), self.n - i0)
        if n <= 2 or amp <= 0.0:
            return

        lp1 = lp0 if lp1 is None else lp1
        d_lp = (lp1 - lp0) / n
        a_n, h_n, dec, rel_n, a_inc, r_inc = self._env_params(
            n, attack, hold, release, decay_to
        )
        hold_end = a_n + h_n
        rel_start = n - rel_n

        gl = amp * (1.0 - max(0.0, pan))
        gr = amp * (1.0 + min(0.0, pan))
        lo_mix = 1.0 - hp

        left, right = self.left, self.right
        rnd = self._rng.random
        y = 0.0
        a = lp0
        env = 0.0

        for i in range(n):
            if i < a_n:
                env = (i + 1) * a_inc
            elif i < hold_end:
                env = 1.0
            else:
                env *= dec
            e = env
            if i >= rel_start:
                e *= (n - i) * r_inc

            x = rnd() * 2.0 - 1.0
            y += a * (x - y)            # one-pole low-pass
            v = (y * lo_mix + (x - y) * hp) * e
            a += d_lp

            j = i0 + i
            left[j] += v * gl
            right[j] += v * gr

    # -- finishing ---------------------------------------------------------
    def normalise(self, ceiling: float = 0.95) -> None:
        """Scale down only if the mix clipped; quiet cues stay quiet."""
        peak = max(max(self.left), -min(self.left),
                   max(self.right), -min(self.right), 0.0)
        if peak > ceiling:
            g = ceiling / peak
            self.left = [v * g for v in self.left]
            self.right = [v * g for v in self.right]


# ==========================================================================
# Interleaving to the mixer's real format
# ==========================================================================
def _to_buffer(sig: _Sig, channels: int, size: int) -> "array.array":
    """Interleave the float buffers into the sample format the mixer wants."""
    signed = size < 0
    bits = abs(size)
    if bits <= 8:
        typecode, peak, offset = ("b" if signed else "B"), 127, (0 if signed else 128)
    else:
        typecode, peak, offset = ("h" if signed else "H"), 32767, (0 if signed else 32768)

    out = array.array(typecode)
    left, right, n = sig.left, sig.right, sig.n
    # Absolute clamp window in the target integer domain.
    hi = peak + offset
    lo = offset - peak

    if channels <= 1:
        frames = [0] * n
        for i in range(n):
            v = int((left[i] + right[i]) * 0.5 * peak) + offset
            frames[i] = hi if v > hi else (lo if v < lo else v)
        out.fromlist(frames)
        return out

    # Surround layouts are rare but must not corrupt the frame stride, so any
    # channel past L/R gets the mono downmix.
    extra = max(0, channels - 2)
    frames = [0] * (n * channels)
    w = 0
    for i in range(n):
        lv = int(left[i] * peak) + offset
        rv = int(right[i] * peak) + offset
        lv = hi if lv > hi else (lo if lv < lo else lv)
        rv = hi if rv > hi else (lo if rv < lo else rv)
        frames[w] = lv
        frames[w + 1] = rv
        if extra:
            mid = (lv + rv) >> 1
            for c in range(2, channels):
                frames[w + c] = mid
        w += channels
    out.fromlist(frames)
    return out


# ==========================================================================
# The twelve recipes
# ==========================================================================
def _mk_eat(rate: int) -> _Sig:
    """Short rising blip with a glassy second partial."""
    s = _Sig(0.15, rate, seed=11)
    s.tone(0.0, 0.12, 620.0, 990.0, amp=0.55, shape="sine", attack=0.004, release=0.03)
    s.tone(0.0, 0.10, 1240.0, 1980.0, amp=0.16, shape="sine", attack=0.003, release=0.03)
    s.tone(0.0, 0.05, 300.0, 240.0, amp=0.18, shape="tri", attack=0.002, release=0.02)
    return s


def _mk_bonus(rate: int) -> _Sig:
    """Two-note arpeggio, brighter than `eat`, with a shimmer tail."""
    s = _Sig(0.40, rate, seed=22)
    s.tone(0.000, 0.16, _G5, _G5, amp=0.42, shape="fm", fm_ratio=2.0, fm_index=1.1,
           attack=0.004, hold=0.02, release=0.05, pan=-0.25)
    s.tone(0.085, 0.24, _semitone(_G5, 7), None, amp=0.42, shape="fm", fm_ratio=2.0,
           fm_index=1.3, attack=0.004, hold=0.03, release=0.06, pan=0.25)
    s.tone(0.150, 0.20, _semitone(_G5, 12), None, amp=0.18, shape="sine",
           attack=0.006, release=0.08)
    return s


def _mk_powerup(rate: int) -> _Sig:
    """Shimmering upward sweep: detuned pair + fast-vibrato sparkle + ring."""
    s = _Sig(0.66, rate, seed=33)
    s.tone(0.0, 0.50, 300.0, 1500.0, amp=0.30, shape="sine", attack=0.02,
           release=0.10, decay_to=0.30, pan=-0.30)
    s.tone(0.0, 0.50, 303.0, 1512.0, amp=0.28, shape="tri", attack=0.02,
           release=0.10, decay_to=0.30, pan=0.30)
    # The sparkle rides a 7 Hz vibrato so the sweep glitters instead of whining.
    s.tone(0.06, 0.52, 900.0, 2600.0, amp=0.14, shape="sine", attack=0.05,
           release=0.14, vib_rate=7.0, vib_depth=0.02)
    s.tone(0.42, 0.22, 1760.0, 1760.0, amp=0.20, shape="fm", fm_ratio=3.0,
           fm_index=1.4, attack=0.005, release=0.12)
    return s


def _mk_hit(rate: int) -> _Sig:
    """Harsh bright noise burst stacked on a low body thump."""
    s = _Sig(0.30, rate, seed=44)
    s.noise(0.0, 0.16, amp=0.55, attack=0.001, release=0.05, lp0=0.85, lp1=0.20, hp=0.45)
    s.tone(0.0, 0.26, 150.0, 46.0, amp=0.65, shape="sine", attack=0.002, release=0.06)
    s.tone(0.0, 0.09, 210.0, 90.0, amp=0.22, shape="square", attack=0.001, release=0.03)
    s.noise(0.02, 0.22, amp=0.18, attack=0.004, release=0.08, lp0=0.10, lp1=0.03)
    return s


def _mk_die(rate: int) -> _Sig:
    """Long descending detuned tone - the two voices beat against each other."""
    s = _Sig(1.05, rate, seed=55)
    s.tone(0.0, 0.95, 440.0, 104.0, amp=0.40, shape="saw", attack=0.010,
           release=0.22, decay_to=0.05, pan=-0.35)
    s.tone(0.0, 0.95, 446.0, 106.0, amp=0.36, shape="tri", attack=0.012,
           release=0.22, decay_to=0.05, pan=0.35)   # +6 Hz detune -> slow beating
    s.tone(0.0, 0.98, 110.0, 42.0, amp=0.32, shape="sine", attack=0.014,
           release=0.26, decay_to=0.04)
    s.noise(0.0, 0.30, amp=0.13, attack=0.004, release=0.14, lp0=0.28, lp1=0.05)
    return s


def _mk_click(rate: int) -> _Sig:
    """Soft UI tick: tiny noise transient plus a falling sine pip."""
    s = _Sig(0.09, rate, seed=66)
    s.tone(0.0, 0.060, 920.0, 660.0, amp=0.45, shape="sine", attack=0.002, release=0.02)
    s.noise(0.0, 0.018, amp=0.16, attack=0.001, release=0.008, lp0=0.55, lp1=0.20, hp=0.30)
    return s


def _mk_hover(rate: int) -> _Sig:
    """Very quiet, very high tick for cursor roll-over."""
    s = _Sig(0.06, rate, seed=77)
    s.tone(0.0, 0.042, 1900.0, 2150.0, amp=0.26, shape="sine", attack=0.002, release=0.02)
    s.tone(0.0, 0.030, 2850.0, None, amp=0.08, shape="sine", attack=0.002, release=0.015)
    return s


def _mk_start(rate: int) -> _Sig:
    """Confident rising major triad, capped with the octave."""
    s = _Sig(0.72, rate, seed=88)
    for i, (f, pan) in enumerate(((_C5, -0.30), (_E5, 0.0), (_G5, 0.30))):
        s.tone(i * 0.085, 0.42 - i * 0.03, f, None, amp=0.34, shape="fm",
               fm_ratio=2.0, fm_index=0.9, attack=0.008, hold=0.05,
               release=0.12, decay_to=0.12, pan=pan)
    s.tone(0.255, 0.42, _C6, None, amp=0.32, shape="sine", attack=0.008,
           hold=0.06, release=0.16, decay_to=0.08)
    s.tone(0.0, 0.55, _C4, None, amp=0.16, shape="tri", attack=0.02,
           release=0.20, decay_to=0.06)
    return s


def _mk_levelup(rate: int) -> _Sig:
    """Four-note ascending fanfare with a shimmering tail."""
    s = _Sig(0.90, rate, seed=99)
    notes = (_C5, _E5, _G5, _C6)
    for i, f in enumerate(notes):
        pan = -0.25 + 0.5 * (i / 3.0)
        s.tone(i * 0.105, 0.34, f, None, amp=0.34, shape="fm", fm_ratio=3.0,
               fm_index=1.0 + 0.15 * i, attack=0.006, hold=0.04,
               release=0.12, decay_to=0.10, pan=pan)
    s.tone(0.315, 0.50, _E6, None, amp=0.16, shape="sine", attack=0.02,
           release=0.22, decay_to=0.05, vib_rate=6.0, vib_depth=0.006)
    s.noise(0.30, 0.34, amp=0.07, attack=0.03, release=0.18, lp0=0.90, lp1=0.55, hp=0.6)
    return s


def _mk_win(rate: int) -> _Sig:
    """Longer major fanfare: a rising run into a held, wide triad."""
    s = _Sig(1.70, rate, seed=101)
    run = ((_C5, 0.00), (_E5, 0.10), (_G5, 0.20), (_C6, 0.30), (_E6, 0.40))
    for f, t in run:
        s.tone(t, 0.30, f, None, amp=0.28, shape="fm", fm_ratio=2.0, fm_index=1.1,
               attack=0.006, hold=0.05, release=0.10, decay_to=0.10)
    # Held chord: each voice panned differently so the ending sounds wide.
    for f, pan in ((_C6, -0.40), (_E6, 0.0), (_G6, 0.40)):
        s.tone(0.52, 1.12, f, None, amp=0.26, shape="fm", fm_ratio=2.0, fm_index=0.8,
               attack=0.020, hold=0.35, release=0.40, decay_to=0.06, pan=pan)
    s.tone(0.52, 1.10, _C4, None, amp=0.20, shape="tri", attack=0.030,
           hold=0.30, release=0.40, decay_to=0.05)
    s.tone(0.52, 1.05, _G3, None, amp=0.13, shape="sine", attack=0.040,
           hold=0.25, release=0.40, decay_to=0.05)
    s.tone(0.60, 0.90, _A5 * 2.0, None, amp=0.07, shape="sine", attack=0.10,
           release=0.40, decay_to=0.05, vib_rate=5.5, vib_depth=0.005)
    return s


def _mk_boost(rate: int) -> _Sig:
    """Filtered whoosh - the low-pass cutoff opens then slams shut."""
    s = _Sig(0.58, rate, seed=112)
    s.noise(0.00, 0.26, amp=0.42, attack=0.05, release=0.10, decay_to=0.55,
            lp0=0.02, lp1=0.45, pan=-0.20)
    s.noise(0.22, 0.34, amp=0.40, attack=0.02, release=0.16, decay_to=0.02,
            lp0=0.45, lp1=0.04, pan=0.20)
    s.tone(0.00, 0.42, 90.0, 260.0, amp=0.22, shape="sine", attack=0.04,
           release=0.16, decay_to=0.12)
    return s


def _mk_portal(rate: int) -> _Sig:
    """Warbling ring: deep vibrato plus ring modulation on a bell-ish FM tone."""
    s = _Sig(0.78, rate, seed=123)
    s.tone(0.0, 0.72, 660.0, 690.0, amp=0.34, shape="fm", fm_ratio=1.5, fm_index=1.6,
           attack=0.012, release=0.20, decay_to=0.12,
           vib_rate=11.0, vib_depth=0.085, pan=-0.35)
    # Same idea an octave up, warbling at a slightly different rate so the two
    # sides of the stereo field drift in and out of phase.
    s.tone(0.03, 0.66, 990.0, 950.0, amp=0.24, shape="sine",
           attack=0.015, release=0.22, decay_to=0.10,
           vib_rate=8.5, vib_depth=0.070, am_rate=6.0, am_depth=0.45, pan=0.35)
    s.tone(0.0, 0.55, 165.0, 210.0, amp=0.18, shape="tri", attack=0.03,
           release=0.20, decay_to=0.06)
    return s


_RECIPES: Dict[str, Callable[[int], _Sig]] = {
    "eat": _mk_eat, "bonus": _mk_bonus, "powerup": _mk_powerup, "hit": _mk_hit,
    "die": _mk_die, "click": _mk_click, "hover": _mk_hover, "start": _mk_start,
    "levelup": _mk_levelup, "win": _mk_win, "boost": _mk_boost, "portal": _mk_portal,
}


# ==========================================================================
# Audio facade
# ==========================================================================
class Audio:
    """Owns the mixer and the baked sound bank.  Never raises, ever."""

    def __init__(self, muted: bool = False, headless: bool = False) -> None:
        self.muted: bool = bool(muted)
        self.headless: bool = bool(headless)
        self.available: bool = False
        self.master: float = _MASTER_VOLUME

        self._sounds: Dict[str, "pygame.mixer.Sound"] = {}
        self._last_play: Dict[str, int] = {}
        self._rate = _WANT_RATE
        self._size = _WANT_SIZE
        self._channels = _WANT_CHANNELS

        if headless or pygame is None:
            return
        if self._open_mixer():
            self._bake()
            self.available = bool(self._sounds)

    # -- setup -------------------------------------------------------------
    def _open_mixer(self) -> bool:
        """Get the mixer running in a format we know, then read back reality."""
        try:
            info = pygame.mixer.get_init()
            # pygame.init() may already have opened a format we did not ask
            # for.  Re-open at our preferred one whenever the rate differs or
            # the sample width is not one we know how to pack.
            if info is not None and (info[0] != _WANT_RATE
                                     or int(info[1]) not in _PACKABLE_SIZES):
                try:
                    pygame.mixer.quit()
                    info = None
                except Exception:
                    pass
            if info is None:
                try:
                    pygame.mixer.pre_init(_WANT_RATE, _WANT_SIZE,
                                          _WANT_CHANNELS, _WANT_BUFFER)
                except Exception:
                    pass
                pygame.mixer.init(frequency=_WANT_RATE, size=_WANT_SIZE,
                                  channels=_WANT_CHANNELS, buffer=_WANT_BUFFER)
                info = pygame.mixer.get_init()
            if info is None:
                return False

            self._rate = int(info[0]) or _WANT_RATE
            self._size = int(info[1])
            self._channels = max(1, int(info[2]))
            if self._size not in _PACKABLE_SIZES:
                # A float32 (or otherwise exotic) device we cannot fill by
                # hand.  Better silent than screaming static.
                pygame.mixer.quit()
                return False
            try:
                pygame.mixer.set_num_channels(_NUM_CHANNELS)
            except Exception:
                pass
            return True
        except Exception:
            # No device, no permission, dummy driver failure - all the same
            # to us: run silent.
            try:
                pygame.mixer.quit()
            except Exception:
                pass
            return False

    def _bake(self) -> None:
        """Synthesise every cue.  One bad recipe must not kill the rest."""
        for name, recipe in _RECIPES.items():
            try:
                sig = recipe(self._rate)
                sig.normalise()
                buf = _to_buffer(sig, self._channels, self._size)
                try:
                    snd = pygame.mixer.Sound(buffer=buf)
                except Exception:
                    snd = pygame.mixer.Sound(buffer=buf.tobytes())
                snd.set_volume(clamp(_GAIN.get(name, 0.5), 0.0, 1.0))
                self._sounds[name] = snd
            except Exception:
                continue

    # -- playback ----------------------------------------------------------
    def play(self, name: str, volume: float = 1.0) -> None:
        """Fire a cue by name.  Unknown names and dead mixers are ignored."""
        if self.muted or not self.available:
            return
        snd = self._sounds.get(name)
        if snd is None:
            return
        try:
            now = pygame.time.get_ticks()
            gap = _MIN_INTERVAL.get(name, _DEFAULT_INTERVAL)
            last = self._last_play.get(name)
            if last is not None and (now - last) < gap * 1000.0:
                return
            self._last_play[name] = now

            vol = clamp(_GAIN.get(name, 0.5) * float(volume) * self.master, 0.0, 1.0)
            ch = pygame.mixer.find_channel(True)
            if ch is not None:
                # Per-channel volume keeps overlapping copies independent.
                ch.set_volume(vol)
                ch.play(snd)
            else:
                snd.set_volume(vol)
                snd.play()
        except Exception:
            pass

    def stop_all(self) -> None:
        """Silence everything currently sounding."""
        if not self.available:
            return
        try:
            pygame.mixer.stop()
        except Exception:
            pass

    # -- mute --------------------------------------------------------------
    def set_muted(self, v: bool) -> None:
        self.muted = bool(v)
        if self.muted:
            self.stop_all()

    def toggle_mute(self) -> bool:
        """Flip mute and return the new state."""
        self.set_muted(not self.muted)
        return self.muted

    def set_master_volume(self, v: float) -> None:
        self.master = clamp(float(v), 0.0, 1.0)

    # -- introspection -----------------------------------------------------
    def sound_names(self) -> Tuple[str, ...]:
        return SOUND_NAMES

    def has(self, name: str) -> bool:
        return name in self._sounds

    def shutdown(self) -> None:
        """Release the device.  Safe to call more than once."""
        self.stop_all()
        self._sounds.clear()
        self.available = False
        if pygame is None:
            return
        try:
            pygame.mixer.quit()
        except Exception:
            pass

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        state = "silent" if not self.available else f"{self._rate}Hz x{self._channels}"
        return f"<Audio {state} muted={self.muted} cues={len(self._sounds)}>"
