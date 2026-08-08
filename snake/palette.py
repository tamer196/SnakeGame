"""
Colour system for NEON SERPENT.

Every level owns a `Theme`: a small, coherent set of colours plus the name of
the background style that should be drawn behind it.  Renderers never invent
colours - they pull them from the active theme so the whole frame reads as one
designed image instead of a pile of unrelated hues.

All colours are plain RGB 3-tuples of ints 0..255.  Helpers below cover the
handful of colour operations the rest of the codebase needs.
"""

from __future__ import annotations

import colorsys
from dataclasses import dataclass, field
from typing import Sequence, Tuple

RGB = Tuple[int, int, int]
RGBA = Tuple[int, int, int, int]


# --------------------------------------------------------------------------
# Colour maths
# --------------------------------------------------------------------------
def clamp8(v: float) -> int:
    """Clamp a number into a valid 0..255 channel value."""
    return 0 if v < 0 else (255 if v > 255 else int(v))


def lerp_color(a: RGB, b: RGB, t: float) -> RGB:
    """Linear blend between two colours; t is clamped to 0..1."""
    t = 0.0 if t < 0.0 else (1.0 if t > 1.0 else t)
    return (
        clamp8(a[0] + (b[0] - a[0]) * t),
        clamp8(a[1] + (b[1] - a[1]) * t),
        clamp8(a[2] + (b[2] - a[2]) * t),
    )


def shade(c: RGB, factor: float) -> RGB:
    """Multiply brightness. factor < 1 darkens, > 1 lightens (saturating)."""
    return (clamp8(c[0] * factor), clamp8(c[1] * factor), clamp8(c[2] * factor))


def with_alpha(c: Sequence[int], a: float) -> RGBA:
    """Attach an alpha channel to an RGB colour."""
    return (int(c[0]), int(c[1]), int(c[2]), clamp8(a))


def hsv(h: float, s: float, v: float) -> RGB:
    """Build an RGB colour from HSV floats in 0..1 (h wraps)."""
    r, g, b = colorsys.hsv_to_rgb(h % 1.0, max(0.0, min(1.0, s)), max(0.0, min(1.0, v)))
    return (clamp8(r * 255), clamp8(g * 255), clamp8(b * 255))


def hue_shift(c: RGB, delta: float) -> RGB:
    """Rotate a colour's hue by `delta` turns (0..1), keeping S and V."""
    h, s, v = colorsys.rgb_to_hsv(c[0] / 255.0, c[1] / 255.0, c[2] / 255.0)
    return hsv(h + delta, s, v)


def rainbow(t: float, sat: float = 0.85, val: float = 1.0) -> RGB:
    """A point on a smooth rainbow; `t` is a free-running time value."""
    return hsv(t, sat, val)


# --------------------------------------------------------------------------
# Theme
# --------------------------------------------------------------------------
@dataclass(frozen=True)
class Theme:
    """The complete colour identity of one level."""

    name: str
    bg_style: str                 # key understood by gfx.background.draw_background
    bg_top: RGB                   # gradient sky colour, top of the arena
    bg_bottom: RGB                # gradient colour at the bottom
    grid: RGB                     # arena grid / lattice lines
    accent: RGB                   # primary neon: borders, highlights, UI focus
    accent2: RGB                  # secondary neon: contrast pairings
    snake_head: RGB
    snake_a: RGB                  # body gradient start
    snake_b: RGB                  # body gradient end
    food: RGB
    hazard: RGB                   # walls, spikes, anything that hurts
    text: RGB = (238, 244, 255)
    text_dim: RGB = (148, 162, 190)

    def body_at(self, t: float) -> RGB:
        """Colour of a body segment, t=0 at the head, t=1 at the tail tip."""
        return lerp_color(self.snake_a, self.snake_b, t)


# --------------------------------------------------------------------------
# The twelve level themes, ordered to match LEVELS in core.level
# --------------------------------------------------------------------------
THEMES: Tuple[Theme, ...] = (
    Theme(
        name="Neon Grid",
        bg_style="grid",
        bg_top=(9, 12, 30), bg_bottom=(4, 6, 16),
        grid=(30, 52, 96),
        accent=(0, 236, 255), accent2=(255, 60, 190),
        snake_head=(180, 255, 255), snake_a=(0, 245, 210), snake_b=(0, 120, 255),
        food=(255, 214, 64), hazard=(255, 66, 110),
    ),
    Theme(
        name="Deep Nebula",
        bg_style="nebula",
        bg_top=(20, 8, 44), bg_bottom=(6, 3, 20),
        grid=(58, 34, 104),
        accent=(186, 122, 255), accent2=(88, 232, 255),
        snake_head=(240, 220, 255), snake_a=(196, 128, 255), snake_b=(72, 96, 255),
        food=(120, 255, 214), hazard=(255, 92, 148),
    ),
    Theme(
        name="Emerald Circuit",
        bg_style="circuit",
        bg_top=(4, 26, 22), bg_bottom=(2, 12, 12),
        grid=(20, 78, 62),
        accent=(64, 255, 170), accent2=(226, 255, 96),
        snake_head=(226, 255, 236), snake_a=(80, 255, 168), snake_b=(16, 176, 128),
        food=(255, 236, 120), hazard=(255, 108, 84),
    ),
    Theme(
        name="Solar Flare",
        bg_style="lava",
        bg_top=(46, 12, 6), bg_bottom=(16, 4, 4),
        grid=(112, 40, 18),
        accent=(255, 158, 44), accent2=(255, 72, 60),
        snake_head=(255, 240, 210), snake_a=(255, 196, 72), snake_b=(226, 62, 40),
        food=(120, 226, 255), hazard=(255, 48, 32),
    ),
    Theme(
        name="Abyssal Tide",
        bg_style="ocean",
        bg_top=(4, 22, 48), bg_bottom=(1, 8, 22),
        grid=(20, 66, 110),
        accent=(72, 200, 255), accent2=(140, 255, 226),
        snake_head=(224, 250, 255), snake_a=(96, 224, 255), snake_b=(28, 92, 200),
        food=(255, 168, 92), hazard=(255, 84, 132),
    ),
    Theme(
        name="Violet Static",
        bg_style="static",
        bg_top=(24, 6, 36), bg_bottom=(8, 2, 16),
        grid=(74, 26, 104),
        accent=(255, 88, 226), accent2=(120, 108, 255),
        snake_head=(255, 226, 250), snake_a=(255, 108, 230), snake_b=(128, 64, 255),
        food=(180, 255, 120), hazard=(255, 62, 96),
    ),
    Theme(
        name="Frozen Vault",
        bg_style="ice",
        bg_top=(12, 30, 52), bg_bottom=(4, 12, 24),
        grid=(46, 92, 132),
        accent=(160, 236, 255), accent2=(226, 246, 255),
        snake_head=(255, 255, 255), snake_a=(178, 240, 255), snake_b=(70, 150, 226),
        food=(255, 176, 200), hazard=(120, 200, 255),
    ),
    Theme(
        name="Toxic Bloom",
        bg_style="spores",
        bg_top=(14, 28, 8), bg_bottom=(4, 10, 4),
        grid=(56, 96, 24),
        accent=(178, 255, 42), accent2=(255, 214, 0),
        snake_head=(238, 255, 200), snake_a=(196, 255, 64), snake_b=(64, 156, 32),
        food=(255, 120, 230), hazard=(140, 255, 60),
    ),
    Theme(
        name="Crimson Engine",
        bg_style="machine",
        bg_top=(32, 8, 14), bg_bottom=(12, 3, 6),
        grid=(92, 28, 40),
        accent=(255, 62, 96), accent2=(255, 176, 60),
        snake_head=(255, 226, 226), snake_a=(255, 92, 112), snake_b=(160, 20, 60),
        food=(96, 255, 220), hazard=(255, 40, 64),
    ),
    Theme(
        name="Aurora Drift",
        bg_style="aurora",
        bg_top=(6, 20, 34), bg_bottom=(2, 6, 16),
        grid=(28, 74, 88),
        accent=(96, 255, 196), accent2=(190, 130, 255),
        snake_head=(232, 255, 246), snake_a=(120, 255, 208), snake_b=(120, 110, 255),
        food=(255, 226, 128), hazard=(255, 96, 140),
    ),
    Theme(
        name="Event Horizon",
        bg_style="voidwarp",
        bg_top=(10, 6, 22), bg_bottom=(2, 1, 6),
        grid=(48, 40, 88),
        accent=(255, 246, 210), accent2=(140, 108, 255),
        snake_head=(255, 255, 240), snake_a=(255, 226, 150), snake_b=(150, 96, 255),
        food=(120, 240, 255), hazard=(226, 60, 255),
    ),
    Theme(
        name="Prism Core",
        bg_style="prism",
        bg_top=(16, 16, 34), bg_bottom=(5, 5, 14),
        grid=(64, 62, 118),
        accent=(255, 255, 255), accent2=(255, 92, 208),
        snake_head=(255, 255, 255), snake_a=(255, 120, 220), snake_b=(96, 220, 255),
        food=(255, 250, 140), hazard=(255, 70, 70),
    ),
)


# --------------------------------------------------------------------------
# Shared, theme-independent colours
# --------------------------------------------------------------------------
UI_PANEL = (16, 19, 34)
UI_PANEL_LIGHT = (28, 33, 56)
UI_SHADOW = (0, 0, 0)
UI_WHITE = (240, 246, 255)
UI_DIM = (132, 146, 176)
UI_GOOD = (86, 240, 160)
UI_WARN = (255, 196, 72)
UI_BAD = (255, 84, 108)
UI_GOLD = (255, 208, 84)


def theme_for_level(index: int) -> Theme:
    """Theme for a zero-based level index; wraps for levels beyond the list."""
    if not THEMES:
        raise RuntimeError("no themes defined")
    return THEMES[index % len(THEMES)]
