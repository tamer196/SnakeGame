"""
Animated arena backgrounds for NEON SERPENT.

Every level owns a `Theme` whose ``bg_style`` names one of twelve worlds.  This
module turns that name into a `Background` object that paints the arena behind
everything else, one style per class:

    grid      a horizon that scrolls with perspective over parallax ridges
    nebula    parallax starfields, drifting colour clouds and lit dust motes
    circuit   etched traces, data pulses and lightning arcing between pads
    lava      rising embers, glowing cracks and a rolling heat-haze band
    ocean     caustic light, god rays and slow bubbles
    static    scanline noise, drifting signal bands and interference tearing
    ice       drifting crystals and frost creeping in from the edges
    spores    clumping, bobbing spore blobs over damp parallax mist
    machine   meshing gear trains and sliding pistons
    aurora    vertical ribbon curtains that undulate and fold
    voidwarp  a starfield lensed and swirled toward a bright singularity
    prism     rotating refraction wedges cycling through the spectrum

Depth
-----
Every style paints at least three layers that move at different rates, so the
world reads as a box rather than a poster.  Layers accept a *depth* value: 0 is
infinitely far away and never moves, 1 is right behind the snake.  Depth feeds
two things - the scroll rate the style picks, and the shared focus parallax,
which nudges near layers against the snake's position when a caller passes
``update(dt, focus=(x, y))``.

A pre-rendered vignette is multiplied over the finished frame so the arena
centre reads brighter than its edges, and that same layer carries a very slow
colour drift (a ~84 s cycle) so a level never looks completely static.

Performance contract
--------------------
Everything static is pre-rendered once in ``__init__``: gradients, grid fans,
circuit traces, cloud banks, caustic tiles, noise tiles, gear rotations and so
on.  Per frame we only scroll, blit and draw a bounded number of cheap
primitives.  Glow sprites live in a module-level cache keyed on *quantised*
radius and intensity, so an animated brightness can never thrash it, and no
surface is ever allocated per particle per frame.  Additive glow is done by
blitting *black-backed* surfaces with ``BLEND_RGB_ADD`` - the fastest blend path
pygame offers, because it needs no per-pixel alpha.

Two measured rules shape the code:

* ``Surface.fill`` with a blend flag is **not** accelerated - a full-arena
  blended fill costs ~6.5 ms.  Full-arena modulation is always a *blit* of a
  pre-rendered surface (~0.18 ms).
* ``smoothscale`` to full arena size costs ~1.6 ms, so it is either done once at
  build time or throttled to every other frame.

Nothing in this module may raise: `update` and `draw` swallow their own errors
so a cosmetic bug can never take the game down.
"""

from __future__ import annotations

import math
import random
from typing import Callable, Dict, List, Optional, Sequence, Tuple

import pygame

from .. import config as C
from .. import palette as P
from ..core.contracts import TAU, clamp, lerp

RGB = Tuple[int, int, int]

#: Every style name this module knows how to draw.
STYLES: Tuple[str, ...] = (
    "grid", "nebula", "circuit", "lava", "ocean", "static",
    "ice", "spores", "machine", "aurora", "voidwarp", "prism",
)

#: Slack pre-rendered layers carry on every side so focus parallax can shift
#: them without dragging an empty edge into the arena.
_MARGIN = 36


# ==========================================================================
# Small surface utilities
# ==========================================================================
def _rgb(c: Sequence[int]) -> RGB:
    """Coerce anything colour-ish into a clean RGB int triple."""
    return (P.clamp8(c[0]), P.clamp8(c[1]), P.clamp8(c[2]))


def _conv(surf: pygame.Surface, alpha: bool = False) -> pygame.Surface:
    """Convert to the display format when a display exists; else pass through."""
    try:
        return surf.convert_alpha() if alpha else surf.convert()
    except Exception:
        return surf


def _mix(a: RGB, b: RGB, t: float) -> RGB:
    return P.lerp_color(_rgb(a), _rgb(b), t)


def _vgradient(w: int, h: int, top: RGB, bottom: RGB) -> pygame.Surface:
    """A vertical gradient, built one pixel tall then stretched (cheap + smooth)."""
    w = max(1, int(w))
    h = max(1, int(h))
    strip = pygame.Surface((1, h))
    for y in range(h):
        strip.set_at((0, y), _mix(top, bottom, y / max(1.0, h - 1.0)))
    return _conv(pygame.transform.smoothscale(strip, (w, h)))


_SPRITES: Dict[Tuple, pygame.Surface] = {}


def _radial(radius: float, color: Sequence[int],
            intensity: float = 1.0, steps: int = 14) -> pygame.Surface:
    """
    An uncached radial glow on a black backing, meant for ``BLEND_RGB_ADD``.

    Concentric filled discs of increasing brightness are stamped from the
    outside in.  Choosing radius_i = R * sqrt(1 - i/steps) makes the number of
    discs covering a pixel proportional to ``1 - (d/R)**2``, i.e. a smooth
    quadratic falloff, without touching a single pixel from Python.
    """
    r = max(1, int(radius))
    col = _rgb(color)
    # A big glow is nothing but low-frequency ramp, so past a certain size it is
    # far cheaper to fill a quarter-scale disc and stretch it: a 525 px glow is
    # a 1050 x 1050 surface, and painting fourteen discs into that costs 9 ms.
    div = 4 if r >= 128 else 1
    rs = max(4, r // div)
    surf = pygame.Surface((rs * 2, rs * 2))
    surf.fill((0, 0, 0))
    for i in range(steps):
        rr = rs * math.sqrt(max(0.0, 1.0 - i / float(steps)))
        if rr < 0.6:
            continue
        f = intensity * (i + 1) / float(steps)
        pygame.draw.circle(surf, P.shade(col, f), (rs, rs), int(rr))
    if div > 1:
        surf = pygame.transform.smoothscale(surf, (r * 2, r * 2))
    return _conv(surf)


def _glow_sprite(radius: float, color: Sequence[int],
                 intensity: float = 1.0, steps: int = 14) -> pygame.Surface:
    """
    A cached radial glow, safe to call every frame with animated brightness.

    Radius and intensity are *quantised* before they reach the cache key.  A
    caller that pulses a glow from 0.2 to 0.9 therefore lands in one of sixteen
    buckets instead of minting a fresh surface per frame - the single biggest
    win in this module, and the reason the lava embers stopped costing 2 ms.
    """
    r = max(1, int(radius))
    if r >= 64:
        r = (r // 8) * 8
    elif r >= 8:
        r = (r // 2) * 2
    col = _rgb(color)
    q = int(clamp(intensity, 0.0, 4.0) * 16.0 + 0.5)
    key = (r, col, q, steps)
    cached = _SPRITES.get(key)
    if cached is not None:
        return cached
    # The cap has to sit *above* the working set of the busiest style or the
    # cache thrashes: 78 lava embers alone span ~200 (radius, colour, pulse)
    # buckets, and clearing them mid-flight costs more than never caching.
    if len(_SPRITES) > 900:
        _SPRITES.clear()
    surf = _radial(r, col, q / 16.0, steps)
    _SPRITES[key] = surf
    return surf


def _add(surface: pygame.Surface, sprite: pygame.Surface, cx: float, cy: float) -> None:
    """Additively stamp a cached sprite centred on (cx, cy)."""
    surface.blit(sprite, (int(cx - sprite.get_width() * 0.5),
                          int(cy - sprite.get_height() * 0.5)),
                 special_flags=pygame.BLEND_RGB_ADD)


def _seamless_layer(w: int, h: int, tile_px: int, cells: int,
                    fn: Callable[[float, float], RGB]) -> pygame.Surface:
    """
    Build a scrolling layer that wraps perfectly with period ``tile_px``.

    ``fn(u, v)`` is sampled on a (cells+1) grid of a unit square - the extra row
    and column repeat the first one, so bilinear upscaling has real data to
    interpolate across the tile seam.  The upscaled tile is cropped back to
    ``tile_px`` and stamped over a surface one tile larger than the arena, so a
    single blit at any offset in [0, tile_px) covers the whole arena.
    """
    w = max(1, int(w))
    h = max(1, int(h))
    cells = max(4, int(cells))
    tile_px = max(cells, int(tile_px) // cells * cells)
    step = tile_px // cells

    small = pygame.Surface((cells + 1, cells + 1))
    for j in range(cells + 1):
        v = (j % cells) / float(cells)
        for i in range(cells + 1):
            small.set_at((i, j), _rgb(fn((i % cells) / float(cells), v)))
    big = pygame.transform.smoothscale(small, (tile_px + step, tile_px + step))
    tile = pygame.Surface((tile_px, tile_px))
    tile.blit(big, (0, 0))

    layer = pygame.Surface((w + tile_px, h + tile_px))
    for y in range(0, h + tile_px, tile_px):
        for x in range(0, w + tile_px, tile_px):
            layer.blit(tile, (x, y))
    return _conv(layer)


def _noise_tiles(size: int, count: int, density: int,
                 cols: Sequence[RGB], rng: random.Random) -> List[pygame.Surface]:
    """A small bank of black-backed grain tiles for additive film noise."""
    tiles: List[pygame.Surface] = []
    n = max(1, len(cols))
    for _ in range(max(1, count)):
        tile = pygame.Surface((size, size))
        tile.fill((0, 0, 0))
        for _ in range(density):
            tile.fill(cols[rng.randrange(n)],
                      (rng.randrange(size), rng.randrange(size),
                       rng.randint(1, 4), 1))
        tiles.append(_conv(tile))
    return tiles


# ==========================================================================
# Shared depth vignette + global colour drift
# ==========================================================================
# One multiply layer does two jobs: it darkens the arena edges so the centre
# reads as the near, lit part of the world, and it carries a very slow colour
# drift.  Both are baked into a tiny template and upscaled, so the per-frame
# cost is a single ~0.18 ms blit; the ~1.6 ms upscale only reruns when the drift
# crosses one of _DEPTH_STEPS quantisation steps, i.e. roughly once a second.
_DEPTH_STEPS = 48
_DEPTH_EDGE = 0.34            # how dark the corners go (fraction removed)
_DEPTH_TINT = 13.0            # peak channel swing of the colour drift, 0..255
_DEPTH_TW, _DEPTH_TH = 128, 76

#: Tinted vignettes kept per size.  Three is not arbitrary: the menu cross-fades
#: two backgrounds at once, each on its own drift phase, so a single slot per
#: size would rebuild twice a frame for the length of every transition.
_DEPTH_SLOTS = 3

_depth_master: Optional[pygame.Surface] = None
_depth_solid: Optional[pygame.Surface] = None
#: (w, h) -> {drift index: full-size surface}, insertion-ordered for recycling
_depth_cache: Dict[Tuple[int, int], Dict[int, pygame.Surface]] = {}


def _depth_template() -> pygame.Surface:
    """The greyscale vignette, built once at thumbnail size."""
    global _depth_master
    if _depth_master is not None:
        return _depth_master
    surf = pygame.Surface((_DEPTH_TW, _DEPTH_TH))
    for j in range(_DEPTH_TH):
        dy = (j + 0.5) / _DEPTH_TH * 2.0 - 1.0
        for i in range(_DEPTH_TW):
            dx = (i + 0.5) / _DEPTH_TW * 2.0 - 1.0
            d = clamp(math.hypot(dx, dy) / 1.34, 0.0, 1.0)
            v = int(255.0 * (1.0 - _DEPTH_EDGE * (d ** 1.7)))
            surf.set_at((i, j), (v, v, v))
    _depth_master = _conv(surf)
    return _depth_master


def _depth_layer(w: int, h: int, idx: int) -> Optional[pygame.Surface]:
    """
    The full-size vignette tinted for drift step ``idx``.

    Cached per size, and rebuilt only when the drift index moves - which is what
    keeps a full-frame colour grade down to one blit a frame.  Evicted slots
    hand their surface to the incoming one, so a level that runs for an hour
    allocates exactly three of these and never a fourth.
    """
    global _depth_solid
    w = max(2, int(w))
    h = max(2, int(h))
    key = (w, h)
    slots = _depth_cache.get(key)
    if slots is not None:
        hit = slots.get(idx)
        if hit is not None:
            return hit
    try:
        master = _depth_template()
        if _depth_solid is None:
            _depth_solid = _conv(pygame.Surface((_DEPTH_TW, _DEPTH_TH)))
        s = clamp(idx / float(_DEPTH_STEPS - 1), 0.0, 1.0)
        _depth_solid.fill((255 - int(_DEPTH_TINT * s),
                           255 - int(_DEPTH_TINT * 0.45),
                           255 - int(_DEPTH_TINT * (1.0 - s))))
        small = master.copy()
        small.blit(_depth_solid, (0, 0), special_flags=pygame.BLEND_RGB_MULT)

        if slots is None:
            if len(_depth_cache) >= 2:      # arena size + full-window size
                _depth_cache.clear()
            slots = {}
            _depth_cache[key] = slots
        if len(slots) >= _DEPTH_SLOTS:
            dst = slots.pop(next(iter(slots)))          # recycle the oldest
        else:
            dst = _conv(pygame.Surface((w, h)))
        try:
            pygame.transform.smoothscale(small, (w, h), dst)
        except (TypeError, ValueError):
            dst = _conv(pygame.transform.smoothscale(small, (w, h)))
        slots[idx] = dst
        return dst
    except Exception:
        return None


# ==========================================================================
# Base class
# ==========================================================================
class Background:
    """
    Base background: a pre-rendered vertical gradient and nothing else.

    Subclasses override ``_build`` (once, at construction), ``_animate(dt)`` and
    ``_paint(surface)``.  ``_paint`` draws in *screen* coordinates - add
    ``self.ox`` / ``self.oy`` to arena-local values - and runs with the surface
    clipped to the arena, so overshooting geometry is free.
    """

    #: Maximum focus parallax, in pixels, for a layer at depth 1.0.
    PARALLAX = 22.0
    #: Seconds-ish time constant for the focus follow.  Deliberately sluggish:
    #: the background should breathe with the snake, not track it.
    FOCUS_TAU = 1.4
    #: Radians per second of the global colour drift (a ~84 s round trip).
    DRIFT_RATE = 0.075
    #: Set False to opt out of the shared vignette (nothing does, today).
    DEPTH = True

    def __init__(self, style: str, theme: "P.Theme", rect) -> None:
        self.style: str = str(style or "grid").strip().lower()
        self.theme: "P.Theme" = theme
        try:
            if hasattr(rect, "as_tuple"):
                rect = rect.as_tuple()
            self.rect = pygame.Rect(rect)
        except Exception:
            self.rect = pygame.Rect(C.ARENA_RECT)
        self.rect.w = max(2, self.rect.w)
        self.rect.h = max(2, self.rect.h)
        self.w: int = self.rect.w
        self.h: int = self.rect.h
        self.ox: int = self.rect.x
        self.oy: int = self.rect.y
        self.t: float = 0.0
        self.rng = random.Random(abs(hash((self.style, getattr(theme, "name", "?")))) & 0xFFFFFFFF)

        # Focus parallax state: smoothed, and clamped to -1..1 of the arena.
        self.fx: float = 0.0
        self.fy: float = 0.0
        self._tfx: float = 0.0
        self._tfy: float = 0.0

        # Global colour drift, quantised into _DEPTH_STEPS so the vignette is
        # only ever rebuilt about once a second.
        self.drift_phase: float = self.rng.uniform(0.0, TAU)
        self.drift: float = 0.0
        self._depth_idx: int = -1

        self.base: pygame.Surface = _vgradient(self.w, self.h,
                                               _rgb(theme.bg_top), _rgb(theme.bg_bottom))
        self._lift_centre()

        self._lo: Optional[pygame.Surface] = None
        self._lo_half: Optional[pygame.Surface] = None
        self._lo_big: Optional[pygame.Surface] = None
        self._lo_tick: int = 0
        try:
            self._build()
        except Exception:
            pass

    # -- construction helpers ---------------------------------------------
    def _lift_centre(self) -> None:
        """
        Bake a soft centre lift into the gradient - free depth at draw time.

        Built at thumbnail size and stretched, not at full size: a 726 px radial
        is a 1452 x 1452 surface and cost 17 ms of every level load, while the
        stretched thumbnail is visually identical for about 2 ms.  The stretch
        also turns the disc into an ellipse that matches the arena, which is
        what we wanted anyway.
        """
        try:
            th = self.theme
            tint = _mix(_mix(th.bg_top, th.bg_bottom, 0.5), th.accent, 0.22)
            small = pygame.Surface((128, 76))
            small.fill((0, 0, 0))
            _add(small, _radial(74, tint, 0.20, 12), 64, 40)
            self.base.blit(pygame.transform.smoothscale(small, (self.w, self.h)),
                           (0, 0), special_flags=pygame.BLEND_RGB_ADD)
        except Exception:
            pass

    def _new_layer(self, extra_w: int = 0, extra_h: int = 0) -> pygame.Surface:
        """
        A black scratch layer with a parallax margin on every side.

        Arena-local (0, 0) lives at pixel (_MARGIN, _MARGIN), so a style can
        draw in arena coordinates and let `_blit_layer` place it.
        """
        surf = pygame.Surface((self.w + 2 * _MARGIN + extra_w,
                               self.h + 2 * _MARGIN + extra_h))
        surf.fill((0, 0, 0))
        return surf

    def _soft_layer(self, div: int = 4) -> Tuple[pygame.Surface, float]:
        """
        A quarter-scale scratch for layers made only of soft blobs.

        Returns the small surface and the divisor to scale coordinates and radii
        by.  Stamping a cloud bank at quarter size touches a sixteenth of the
        pixels; `_soft_finish` blows it back up in one ~2 ms smoothscale, which
        is what turns a 50 ms level load back into a 15 ms one.
        """
        div = max(1, int(div))
        surf = pygame.Surface((max(4, (self.w + 2 * _MARGIN) // div),
                               max(4, (self.h + 2 * _MARGIN) // div)))
        surf.fill((0, 0, 0))
        return surf, float(div)

    def _soft_finish(self, small: pygame.Surface) -> pygame.Surface:
        """Blow a `_soft_layer` scratch back up to full `_new_layer` size."""
        return _conv(pygame.transform.smoothscale(
            small, (self.w + 2 * _MARGIN, self.h + 2 * _MARGIN)))

    def _soft_strip(self, div: int = 4) -> Tuple[pygame.Surface, float]:
        """`_soft_layer` for a horizontally tiling strip of width ``self.w``."""
        div = max(1, int(div))
        surf = pygame.Surface((max(4, self.w // div),
                               max(4, (self.h + 2 * _MARGIN) // div)))
        surf.fill((0, 0, 0))
        return surf, float(div)

    def _soft_strip_finish(self, small: pygame.Surface) -> pygame.Surface:
        """Blow a `_soft_strip` scratch back up to full `_new_strip` size."""
        return _conv(pygame.transform.smoothscale(
            small, (self.w, self.h + 2 * _MARGIN)))

    def _new_strip(self, width: int, extra_h: int = 0) -> pygame.Surface:
        """
        A black layer that tiles horizontally with period ``width``.

        Vertical margin only: arena-local (0, 0) is pixel (0, _MARGIN).
        """
        surf = pygame.Surface((max(2, int(width)), self.h + 2 * _MARGIN + extra_h))
        surf.fill((0, 0, 0))
        return surf

    # -- helpers available to every style ---------------------------------
    def _bg_at(self, y_local: float) -> RGB:
        """The pre-rendered gradient colour at an arena-local y (for blending)."""
        return _mix(self.theme.bg_top, self.theme.bg_bottom,
                    clamp(y_local / float(self.h), 0.0, 1.0))

    def _par(self, depth: float) -> Tuple[float, float]:
        """Focus parallax offset in pixels for a layer at ``depth``."""
        k = self.PARALLAX * depth
        return (-self.fx * k, -self.fy * k * 0.62)

    def _blit_layer(self, surface: pygame.Surface, layer: pygame.Surface,
                    depth: float = 0.0, dx: float = 0.0, dy: float = 0.0) -> None:
        """Additively blit a margined layer built by `_new_layer`."""
        px, py = self._par(depth)
        surface.blit(layer, (int(self.ox - _MARGIN + px + dx),
                             int(self.oy - _MARGIN + py + dy)),
                     special_flags=pygame.BLEND_RGB_ADD)

    def _wrap_add(self, surface: pygame.Surface, layer: pygame.Surface,
                  dx: float, dy: float = 0.0, depth: float = 0.0) -> None:
        """Additively blit a `_new_strip` layer that scrolls and wraps in x."""
        lw = layer.get_width()
        px, py = self._par(depth)
        x = self.ox + ((dx + px) % lw) - lw
        y = int(self.oy - _MARGIN + dy + py)
        surface.blit(layer, (int(x), y), special_flags=pygame.BLEND_RGB_ADD)
        surface.blit(layer, (int(x + lw), y), special_flags=pygame.BLEND_RGB_ADD)

    def _lo_surface(self, div: int = 4) -> pygame.Surface:
        """A persistent low-resolution scratch buffer for soft, blurry light."""
        if self._lo is None:
            self._lo = pygame.Surface((max(2, self.w // div), max(2, self.h // div)))
        return self._lo

    def _blit_lo(self, surface: pygame.Surface, blur: bool = False,
                 every: int = 1) -> None:
        """
        Upscale the low-resolution buffer (bilinear = free blur) and add it in.

        With ``blur`` the buffer is halved first.  The downscale *averages*
        neighbouring pixels, so hard polygon edges come back antialiased; blow
        that up and you get a soft light ramp instead of a visible staircase.

        ``every`` throttles the expensive full-size ``smoothscale``: the cached
        upscale is reused on the frames in between, which is invisible on a
        layer that turns a sixth of a degree per frame and halves its cost.
        """
        if self._lo is None:
            return
        try:
            self._lo_tick += 1
            fresh = (every <= 1) or (self._lo_big is None) \
                or (self._lo_tick % int(every) == 0)
            if fresh:
                src = self._lo
                if blur:
                    if self._lo_half is None:
                        self._lo_half = pygame.Surface((max(2, src.get_width() // 2),
                                                        max(2, src.get_height() // 2)))
                    try:
                        pygame.transform.smoothscale(src, self._lo_half.get_size(),
                                                     self._lo_half)
                    except (TypeError, ValueError):
                        self._lo_half = pygame.transform.smoothscale(
                            src, self._lo_half.get_size())
                    src = self._lo_half
                if self._lo_big is None:
                    self._lo_big = pygame.Surface((self.w, self.h))
                try:
                    pygame.transform.smoothscale(src, (self.w, self.h), self._lo_big)
                except (TypeError, ValueError):
                    self._lo_big = pygame.transform.smoothscale(src, (self.w, self.h))
            surface.blit(self._lo_big, (self.ox, self.oy),
                         special_flags=pygame.BLEND_RGB_ADD)
        except Exception:
            pass

    # -- overridables ------------------------------------------------------
    def _build(self) -> None:
        """Pre-render every static layer. Runs once."""

    def _animate(self, dt: float) -> None:
        """Advance style-specific state."""

    def _paint(self, surface: pygame.Surface) -> None:
        """Draw the animated layers over the gradient."""

    # -- public API --------------------------------------------------------
    def update(self, dt: float, focus: Optional[Sequence[float]] = None) -> None:
        """
        Advance the background.

        ``focus`` is an optional point in the caller's own coordinate space
        (normally the snake's head).  Near layers drift very slowly against it,
        which reads as the arena having depth.  Callers that pass nothing keep
        exactly the old behaviour.
        """
        try:
            dt = clamp(float(dt), 0.0, C.MAX_DT)
            self.t += dt

            if focus is not None:
                try:
                    fx, fy = float(focus[0]), float(focus[1])
                    # A non-finite focus would poison the smoothed offset for
                    # good - every later frame would blit at int(nan) and die
                    # in the guard - so a bad sample is dropped, not clamped.
                    if math.isfinite(fx) and math.isfinite(fy):
                        self._tfx = clamp((fx - self.rect.centerx)
                                          / (self.w * 0.5), -1.0, 1.0)
                        self._tfy = clamp((fy - self.rect.centery)
                                          / (self.h * 0.5), -1.0, 1.0)
                except Exception:
                    pass
            k = clamp(dt / self.FOCUS_TAU, 0.0, 1.0)
            self.fx += (self._tfx - self.fx) * k
            self.fy += (self._tfy - self.fy) * k

            self.drift = 0.5 + 0.5 * math.sin(self.t * self.DRIFT_RATE + self.drift_phase)
            self._depth_idx = int(self.drift * (_DEPTH_STEPS - 1))

            self._animate(dt)
        except Exception:
            pass

    def draw(self, surface: pygame.Surface) -> None:
        old_clip = None
        try:
            old_clip = surface.get_clip()
            surface.blit(self.base, (self.ox, self.oy))
            surface.set_clip(self.rect)
            self._paint(surface)
            if self.DEPTH:
                layer = _depth_layer(self.w, self.h, max(0, self._depth_idx))
                if layer is not None:
                    surface.blit(layer, (self.ox, self.oy),
                                 special_flags=pygame.BLEND_RGB_MULT)
        except Exception:
            pass
        finally:
            try:
                surface.set_clip(old_clip)
            except Exception:
                pass


# ==========================================================================
# 1. GRID - a horizon that scrolls with perspective
# ==========================================================================
class GridBackground(Background):
    """
    Three depths: a still sky, two neon ridge lines scrolling at different
    lateral rates, and a ground fan whose rungs rush the viewer.

    Signature: the horizon genuinely scrolls.  Rung ``y = horizon + span / z``
    with z marching toward zero is true perspective, and the two ridges sliding
    past each other at 1:3 speeds is what tells the eye how far away they are.
    """

    ROWS = 22
    SCROLL = 0.62          # rows per second

    def _build(self) -> None:
        th, w, h = self.theme, self.w, self.h
        self.horizon = h * 0.32
        self.span = h - self.horizon
        self.line_hot = _mix(th.grid, th.accent, 0.55)
        m = _MARGIN

        # -- sky (depth 0.12) ---------------------------------------------
        sky = self._new_layer()
        _add(sky, _radial(w * 0.42, P.shade(th.accent, 0.42), 0.85, 12),
             m + w * 0.5, m + self.horizon)
        _add(sky, _radial(h * 0.20, P.shade(th.accent2, 0.55), 0.7, 12),
             m + w * 0.5, m + self.horizon - h * 0.06)
        for i in range(7):                                  # retro sun slats
            y = m + self.horizon - h * 0.055 - i * (h * 0.017)
            half = math.sqrt(max(0.0, 1.0 - (i / 7.0) ** 2)) * h * 0.15
            pygame.draw.line(sky, P.shade(th.accent2, 0.9 - i * 0.09),
                             (m + w * 0.5 - half, y), (m + w * 0.5 + half, y), 3)
        for _ in range(150):
            sx = self.rng.uniform(0, w)
            sy = self.rng.uniform(0, self.horizon - 4)
            f = self.rng.uniform(0.25, 1.0) * (1.0 - sy / max(1.0, self.horizon)) ** 0.5
            sky.fill(P.shade(th.text, 0.55 * f), (int(m + sx), int(m + sy), 1, 1))
        self.sky = _conv(sky)

        # -- ridges (depth 0.30 / 0.55) -----------------------------------
        self.ridge_far = self._ridge(h * 0.16, _mix(th.grid, th.accent2, 0.45), 26, 0.55)
        self.ridge_near = self._ridge(h * 0.10, _mix(th.grid, th.accent, 0.60), 17, 0.95)
        self.ridge_far_x = 0.0
        self.ridge_near_x = 0.0

        # -- ground fan (depth 0.85) --------------------------------------
        fan = self._new_layer()
        cx = m + w * 0.5
        for k in range(-26, 27):
            bx = cx + k * (w / 13.0)
            f = clamp(1.0 - abs(k) / 26.0, 0.10, 1.0)
            pygame.draw.line(fan, P.shade(th.grid, 0.55 + 1.05 * f),
                             (cx, m + self.horizon), (bx, m + h), 2 if abs(k) <= 7 else 1)
        self.fan = _conv(fan)
        self.sweep = 0.0

    def _ridge(self, band: float, col: RGB, seg: int, glow: float) -> pygame.Surface:
        """One wrapping ridge line, drawn as a lit slope plus a hot edge."""
        strip = self._new_strip(self.w)
        seg = max(4, int(seg))
        ys = [self.rng.uniform(band * 0.25, band) for _ in range(seg)]
        ys[-1] = ys[0]
        pts = [(self.w * i / float(seg - 1),
                _MARGIN + self.horizon - ys[i]) for i in range(seg)]
        ipts = [(int(a), int(b)) for a, b in pts]
        poly = ipts + [(int(self.w), int(_MARGIN + self.horizon + 4)),
                       (0, int(_MARGIN + self.horizon + 4))]
        try:
            pygame.draw.polygon(strip, P.shade(col, glow * 0.16), poly)
            pygame.draw.lines(strip, P.shade(col, glow), False, ipts, 2)
        except Exception:
            pass
        return _conv(strip)

    def _animate(self, dt: float) -> None:
        self.ridge_far_x -= 5.0 * dt
        self.ridge_near_x -= 17.0 * dt
        self.sweep = (self.sweep + dt * 0.21) % 1.0

    def _paint(self, surface: pygame.Surface) -> None:
        th = self.theme
        self._blit_layer(surface, self.sky, 0.12)
        self._wrap_add(surface, self.ridge_far, self.ridge_far_x, depth=0.30)
        self._wrap_add(surface, self.ridge_near, self.ridge_near_x, depth=0.55)
        self._blit_layer(surface, self.fan, 0.85)

        # Horizontal rungs: y = horizon + span / z with z marching toward 0, so
        # spacing stretches as a rung approaches the viewer - true perspective.
        _px, py = self._par(0.85)
        phase = (self.t * self.SCROLL) % 1.0
        hot = self.sweep * self.ROWS
        for i in range(1, self.ROWS + 1):
            z = i - phase
            if z <= 0.08:
                continue
            y = self.horizon + self.span / z + py
            if y > self.h + 6:
                continue
            f = clamp(1.0 / (0.5 + z * 0.44), 0.0, 1.0)
            # One rung at a time rides a travelling swell of light.
            f = clamp(f + 0.5 * max(0.0, 1.0 - abs(z - hot) * 0.9), 0.0, 1.0)
            col = _mix(self._bg_at(y), self.line_hot, f)
            pygame.draw.line(surface, col, (self.ox, self.oy + y),
                             (self.ox + self.w, self.oy + y), 2 if f > 0.55 else 1)

        # A breathing sliver of light exactly on the horizon.
        beat = 0.55 + 0.45 * math.sin(self.t * 1.7)
        hy = self.oy + self.horizon + self._par(0.30)[1]
        pygame.draw.line(surface, _mix(th.accent, th.text, 0.35 * beat),
                         (self.ox, hy), (self.ox + self.w, hy), 2)


# ==========================================================================
# 2. NEBULA - parallax stars, colour clouds and lit dust
# ==========================================================================
class NebulaBackground(Background):
    """
    Five depths: two cloud banks, three star layers and dust motes.

    Signature: the motes.  Each is a cached glow whose brightness is scaled by
    how close it is to one of two light shafts, so the dust only sparkles where
    the light actually falls.
    """

    LAYER_SPEEDS = (6.0, 14.0, 30.0)
    LAYER_DEPTHS = (0.20, 0.45, 0.80)
    MOTES = 54

    def _build(self) -> None:
        th, w, h = self.theme, self.w, self.h
        tints = (th.accent, th.accent2, th.grid, _mix(th.accent, th.accent2, 0.5))
        self.cloud_far = self._clouds(16, h * 0.26, h * 0.55, tints, 0.10)
        self.cloud_near = self._clouds(20, h * 0.10, h * 0.30, tints, 0.15)
        self.far_x = 0.0
        self.near_x = 0.0

        # Two soft shafts of light, pre-rendered once and swayed as a unit.
        shafts = self._new_layer()
        self.shaft_x = (w * 0.32, w * 0.71)
        for sx in self.shaft_x:
            for yy in range(0, h + 2 * _MARGIN, 3):
                v = clamp((yy - _MARGIN) / float(h), 0.0, 1.0)
                f = (1.0 - v) ** 1.5
                half = w * (0.035 + 0.075 * v)
                shafts.fill(P.shade(th.accent2, 0.055 * f),
                            (int(_MARGIN + sx - half), yy, int(half * 2), 3))
        self.shafts = _conv(shafts)

        # Three star layers kept as plain data so they can twinkle for free.
        self.stars: List[List[List[float]]] = []
        for li in range(3):
            layer: List[List[float]] = []
            for _ in range(96 - li * 16):
                layer.append([self.rng.uniform(0, w), self.rng.uniform(0, h),
                              1.0 + li, self.rng.uniform(0.0, TAU),
                              self.rng.uniform(0.45, 1.0)])
            self.stars.append(layer)
        self.star_col = _mix(th.text, th.accent2, 0.25)
        self.bright = [(self.rng.uniform(0, w), self.rng.uniform(0, h),
                        self.rng.uniform(5, 11), self.rng.uniform(0, TAU))
                       for _ in range(9)]

        self.motes: List[List[float]] = []
        for _ in range(self.MOTES):
            self.motes.append([self.rng.uniform(0, w), self.rng.uniform(0, h),
                               self.rng.uniform(-9.0, 9.0),
                               self.rng.uniform(-16.0, -4.0),
                               self.rng.uniform(0, TAU), self.rng.uniform(0.5, 1.6),
                               float(self.rng.randint(2, 5))])
        self.mote_col = _mix(th.text, th.accent, 0.35)

    def _clouds(self, count: int, rmin: float, rmax: float,
                tints: Sequence[RGB], amp: float) -> pygame.Surface:
        """A cloud bank that tiles horizontally, so it can drift forever."""
        strip, div = self._soft_strip(4)
        sw = strip.get_width()
        for _ in range(count):
            r = self.rng.uniform(rmin, rmax) / div
            col = P.shade(tints[self.rng.randrange(len(tints))],
                          self.rng.uniform(amp * 0.5, amp))
            spr = _radial(r, col, 1.0, 10)
            x = self.rng.uniform(0.0, float(sw))
            y = (_MARGIN + self.rng.uniform(-self.h * 0.1, self.h * 1.1)) / div
            _add(strip, spr, x, y)
            if x < r:                       # duplicate across the seam
                _add(strip, spr, x + sw, y)
            elif x > sw - r:
                _add(strip, spr, x - sw, y)
        return self._soft_strip_finish(strip)

    def _animate(self, dt: float) -> None:
        self.far_x += 2.5 * dt
        self.near_x += 7.0 * dt
        for li, layer in enumerate(self.stars):
            vx = self.LAYER_SPEEDS[li] * dt
            for s in layer:
                s[0] -= vx
                if s[0] < 0.0:
                    s[0] += self.w
                    s[1] = self.rng.uniform(0, self.h)
        for m in self.motes:
            m[0] += m[2] * dt + math.sin(m[4]) * 9.0 * dt
            m[1] += m[3] * dt
            m[4] += m[5] * dt
            if m[1] < -20.0:
                m[1] = self.h + 20.0
                m[0] = self.rng.uniform(0, self.w)
            if m[0] < -20.0:
                m[0] = self.w + 18.0
            elif m[0] > self.w + 20.0:
                m[0] = -18.0

    def _paint(self, surface: pygame.Surface) -> None:
        self._wrap_add(surface, self.cloud_far, self.far_x, depth=0.15)
        self._wrap_add(surface, self.cloud_near, self.near_x, depth=0.35)
        sway = math.sin(self.t * 0.13) * self.w * 0.02
        self._blit_layer(surface, self.shafts, 0.5, dx=sway)

        base = self.star_col
        for li, layer in enumerate(self.stars):
            px, py = self._par(self.LAYER_DEPTHS[li])
            ix, iy = int(px), int(py)
            for x, y, sz, ph, amp in layer:
                tw = 0.55 + 0.45 * math.sin(self.t * 2.3 + ph)
                surface.fill(P.shade(base, amp * tw),
                             (self.ox + int(x) + ix, self.oy + int(y) + iy,
                              int(sz), int(sz)))
        px, py = self._par(0.55)
        for x, y, r, ph in self.bright:
            k = 0.6 + 0.4 * math.sin(self.t * 1.3 + ph)
            _add(surface, _glow_sprite(int(r), self.theme.accent2, 0.55 * k + 0.25),
                 self.ox + x + px, self.oy + y + py)

        # Dust: only the motes standing in a shaft actually catch the light.
        px, py = self._par(0.95)
        col = self.mote_col
        s0, s1 = self.shaft_x[0] + sway, self.shaft_x[1] + sway
        reach = self.w * 0.13
        for x, y, _vx, _vy, ph, _rate, r in self.motes:
            lit = clamp(1.0 - min(abs(x - s0), abs(x - s1)) / reach, 0.0, 1.0)
            k = (0.16 + 0.62 * lit) * (0.6 + 0.4 * math.sin(self.t * 2.6 + ph))
            _add(surface, _glow_sprite(int(r), col, k),
                 self.ox + x + px, self.oy + y + py)


# ==========================================================================
# 3. CIRCUIT - traces, data pulses and arcing lightning
# ==========================================================================
class CircuitBackground(Background):
    """
    Three depths: a fine substrate mesh, the etched traces, and the chip layer.

    Signature: lightning.  Every so often two pads within arcing distance are
    joined by a jagged bolt drawn wide-to-narrow in three passes, so it blooms
    without a blur filter, and both ends flash.
    """

    ARCS = 3

    def _build(self) -> None:
        th, w, h = self.theme, self.w, self.h
        m = _MARGIN

        # -- substrate (depth 0.10) ---------------------------------------
        self.sub_tile = 128
        fine = _mix(th.grid, th.bg_bottom, 0.35)

        def mesh(u: float, v: float) -> RGB:
            k = (0.5 + 0.5 * math.cos(u * TAU * 4.0)) * (0.5 + 0.5 * math.cos(v * TAU * 4.0))
            return P.shade(fine, 0.24 * (k ** 2))

        self.substrate = _seamless_layer(w, h, self.sub_tile, 32, mesh)
        self.sub_off = [0.0, 0.0]

        # -- traces (depth 0.45) ------------------------------------------
        self.paths: List[Tuple[List[Tuple[float, float]], List[float]]] = []
        self.nodes: List[Tuple[float, float]] = []
        layer = self._new_layer()
        dim = P.shade(th.grid, 1.15)
        pad = _mix(th.grid, th.accent, 0.4)

        grid_step = 34.0
        for _ in range(30):
            # Manhattan routing on a coarse lattice: alternate horizontal and
            # vertical runs so the result reads as a printed circuit board.
            x = round(self.rng.uniform(0, w) / grid_step) * grid_step
            y = round(self.rng.uniform(0, h) / grid_step) * grid_step
            pts: List[Tuple[float, float]] = [(x, y)]
            horiz = self.rng.random() < 0.5
            for _ in range(self.rng.randint(4, 8)):
                run = grid_step * self.rng.randint(2, 7) * self.rng.choice((-1, 1))
                if horiz:
                    x = clamp(x + run, -20.0, w + 20.0)
                else:
                    y = clamp(y + run, -20.0, h + 20.0)
                horiz = not horiz
                pts.append((x, y))
            if len(pts) < 2:
                continue
            cum = [0.0]
            for i in range(1, len(pts)):
                cum.append(cum[-1] + math.dist(pts[i - 1], pts[i]))
            if cum[-1] < 60.0:
                continue
            self.paths.append((pts, cum))
            self.nodes.extend(pts)
            pygame.draw.lines(layer, dim, False,
                              [(int(px + m), int(py + m)) for px, py in pts], 2)
            for px, py in pts:                        # solder pads at the corners
                pygame.draw.circle(layer, pad, (int(px + m), int(py + m)), 4, 1)
        self.traces = _conv(layer)

        # -- chips (depth 0.90) -------------------------------------------
        chips = self._new_layer()
        for _ in range(20):
            cw = self.rng.randint(26, 64)
            ch = self.rng.randint(20, 40)
            r = pygame.Rect(int(m + self.rng.uniform(0, w - cw)),
                            int(m + self.rng.uniform(0, h - ch)), cw, ch)
            pygame.draw.rect(chips, P.shade(th.grid, 0.9), r, 1, border_radius=3)
            pygame.draw.circle(chips, pad, (r.x + 6, r.y + 6), 2)
            for bx in range(r.x + 5, r.right - 3, 8):    # leg pins
                chips.fill(P.shade(th.grid, 0.7), (bx, r.bottom, 3, 3))
                chips.fill(P.shade(th.grid, 0.7), (bx, r.y - 3, 3, 3))
        self.chips = _conv(chips)

        self.pulses: List[List[float]] = []
        for i in range(28):
            pi = i % max(1, len(self.paths))
            self.pulses.append([float(pi), self.rng.uniform(0.0, 1.0),
                                self.rng.uniform(90.0, 210.0)])
        self.pulse_col = _mix(th.accent, th.text, 0.25)

        self.arcs: List[List] = []
        self.arc_cd = self.rng.uniform(0.2, 1.0)
        self.arc_hot = _mix(th.accent2, th.text, 0.55)
        self.arc_cool = th.accent2

    def _point_at(self, pi: int, s: float) -> Tuple[float, float]:
        """Interpolate a position `s` (0..1) along pre-measured polyline `pi`."""
        pts, cum = self.paths[pi]
        target = clamp(s, 0.0, 1.0) * cum[-1]
        lo, hi = 0, len(cum) - 1
        while lo < hi - 1:                            # binary search the segment
            mid = (lo + hi) // 2
            if cum[mid] <= target:
                lo = mid
            else:
                hi = mid
        seg = max(1e-6, cum[lo + 1] - cum[lo])
        f = (target - cum[lo]) / seg
        ax, ay = pts[lo]
        bx, by = pts[lo + 1]
        return (lerp(ax, bx, f), lerp(ay, by, f))

    def _spawn_arc(self) -> None:
        """Join two pads that are close enough to arc with a jagged bolt."""
        if len(self.nodes) < 2:
            return
        a = self.nodes[self.rng.randrange(len(self.nodes))]
        found = None
        for _ in range(8):
            b = self.nodes[self.rng.randrange(len(self.nodes))]
            d = math.dist(a, b)
            if 70.0 < d < 280.0:
                found = (b, d)
                break
        if found is None:
            return
        b, d = found
        nx, ny = (b[1] - a[1]) / d, -(b[0] - a[0]) / d
        steps = 9
        pts = []
        for i in range(steps + 1):
            f = i / float(steps)
            wob = 0.0 if i in (0, steps) else self.rng.uniform(-1.0, 1.0) * d * 0.10
            pts.append((int(lerp(a[0], b[0], f) + nx * wob),
                        int(lerp(a[1], b[1], f) + ny * wob)))
        self.arcs.append([pts, self.rng.uniform(0.14, 0.30), 0.0])

    def _animate(self, dt: float) -> None:
        for p in self.pulses:
            _pts, cum = self.paths[int(p[0])]
            p[1] += p[2] * dt / max(1.0, cum[-1])
            if p[1] > 1.0:
                p[1] -= 1.0
                p[0] = float(self.rng.randrange(len(self.paths)))
        self.sub_off[0] = (self.sub_off[0] + 3.5 * dt) % self.sub_tile
        self.sub_off[1] = (self.sub_off[1] + 2.0 * dt) % self.sub_tile

        self.arc_cd -= dt
        if self.arc_cd <= 0.0:
            self.arc_cd = self.rng.uniform(0.35, 1.5)
            if len(self.arcs) < self.ARCS:
                self._spawn_arc()
        for arc in self.arcs:
            arc[2] += dt
        self.arcs = [a for a in self.arcs if a[2] < a[1]]

    def _paint(self, surface: pygame.Surface) -> None:
        if not self.paths:
            return
        px, py = self._par(0.10)
        tp = self.sub_tile
        surface.blit(self.substrate,
                     (int(self.ox - tp + (self.sub_off[0] + px) % tp),
                      int(self.oy - tp + (self.sub_off[1] + py) % tp)),
                     special_flags=pygame.BLEND_RGB_ADD)
        self._blit_layer(surface, self.traces, 0.45)
        self._blit_layer(surface, self.chips, 0.90)

        beat = 0.75 + 0.25 * math.sin(self.t * 2.0)
        head = _glow_sprite(11, self.pulse_col, beat)
        tail = _glow_sprite(7, self.theme.accent2, 0.42)
        px, py = self._par(0.45)
        for pi, s, _spd in self.pulses:
            ipi = int(pi)
            hx, hy = self._point_at(ipi, s)
            tx, ty = self._point_at(ipi, s - 0.045)
            _add(surface, tail, self.ox + tx + px, self.oy + ty + py)
            _add(surface, head, self.ox + hx + px, self.oy + hy + py)

        # Lightning: three passes wide -> narrow fake a bloom for free.
        ix, iy = int(self.ox + px), int(self.oy + py)
        for pts, life, age in self.arcs:
            f = (1.0 - clamp(age / max(1e-3, life), 0.0, 1.0)) \
                * (0.55 + 0.45 * math.sin(age * 90.0))      # crackle
            if f <= 0.02:
                continue
            spts = [(x + ix, y + iy) for x, y in pts]
            try:
                pygame.draw.lines(surface, P.shade(self.arc_cool, 0.18 * f), False, spts, 7)
                pygame.draw.lines(surface, P.shade(self.arc_cool, 0.55 * f), False, spts, 3)
                pygame.draw.lines(surface, P.shade(self.arc_hot, f), False, spts, 1)
            except Exception:
                continue
            flash = _glow_sprite(16, self.arc_hot, 0.7 * f)
            _add(surface, flash, spts[0][0], spts[0][1])
            _add(surface, flash, spts[-1][0], spts[-1][1])


# ==========================================================================
# 4. LAVA - embers, cracks and a rolling heat haze
# ==========================================================================
class LavaBackground(Background):
    """
    Four depths: the molten floor glow, a shimmer tile, the crack field and the
    embers.

    Signature: the heat haze.  A band of the finished frame is copied out and
    re-blitted row by row with a sinusoidal horizontal offset, so it refracts
    whatever is behind it for real instead of tinting over the top of it.
    """

    EMBERS = 78
    HAZE_H = 132

    def _build(self) -> None:
        th, w, h = self.theme, self.w, self.h
        m = _MARGIN

        # A molten floor: broad heat glow along the bottom of the arena.
        deep, div = self._soft_layer(4)
        spr = _radial(h * 0.38 / div, P.shade(th.accent, 0.16), 1.0, 8)
        for i in range(8):
            _add(deep, spr,
                 (m + w * (i + 0.5) / 8.0 + self.rng.uniform(-40, 40)) / div,
                 (m + h + h * 0.06) / div)
        self.deep = self._soft_finish(deep)

        # Cracks: jagged rivers of light, wider and hotter lower in the frame.
        layer = self._new_layer()
        for _ in range(24):
            x = self.rng.uniform(0, w)
            y = self.rng.uniform(h * 0.30, h * 1.02)
            pts = [(x, y)]
            ang = self.rng.uniform(0, TAU)
            for _ in range(self.rng.randint(5, 11)):
                ang += self.rng.uniform(-1.1, 1.1)
                step = self.rng.uniform(24, 62)
                x += math.cos(ang) * step
                y += math.sin(ang) * step * 0.55
                pts.append((x, y))
            ipts = [(int(a + m), int(b + m)) for a, b in pts]
            depth = clamp(pts[0][1] / h, 0.0, 1.0)
            glow = P.shade(_mix(th.hazard, th.accent, 0.40), 0.40 + 0.6 * depth)
            # Three passes wide->narrow fake a bloom without a blur filter.
            pygame.draw.lines(layer, P.shade(glow, 0.14), False, ipts, 17)
            pygame.draw.lines(layer, P.shade(glow, 0.38), False, ipts, 8)
            pygame.draw.lines(layer, _mix(glow, th.text, 0.35), False, ipts, 3)
        self.cracks = _conv(layer)

        # Heat shimmer: horizontal bands that scroll upward forever.
        hot = _mix(th.accent, th.hazard, 0.4)

        def band(_u: float, v: float) -> RGB:
            k = (0.5 + 0.5 * math.sin(v * TAU * 3.0)) ** 3
            return P.shade(hot, 0.10 * k)

        self.tile = 256
        self.shimmer = _seamless_layer(w, h, self.tile, 32, band)
        self.shimmer_y = 0.0

        self.embers: List[List[float]] = []
        for _ in range(self.EMBERS):
            self.embers.append(self._new_ember(self.rng.uniform(0, h)))
        self.ember_cols = (th.accent, _mix(th.accent, th.hazard, 0.6), th.hazard)

        self.haze_h = int(min(self.HAZE_H, max(24, h * 0.24)))
        self.haze_buf = _conv(pygame.Surface((w, self.haze_h)))
        self.haze_y = float(h)

    def _new_ember(self, y: Optional[float] = None) -> List[float]:
        return [self.rng.uniform(0, self.w),
                self.h + 8.0 if y is None else y,
                self.rng.uniform(22, 74),               # rise speed
                self.rng.uniform(2.5, 6.5),             # radius
                self.rng.uniform(0, TAU),               # sway phase
                float(self.rng.randrange(3))]           # colour index

    def _animate(self, dt: float) -> None:
        self.shimmer_y = (self.shimmer_y + 26.0 * dt) % self.tile
        self.haze_y -= 34.0 * dt
        if self.haze_y < -self.haze_h:
            self.haze_y = float(self.h)
        for e in self.embers:
            e[1] -= e[2] * dt
            e[4] += dt * 1.7
            e[0] += math.sin(e[4]) * 16.0 * dt
            if e[1] < -10.0:
                e[:] = self._new_ember()

    def _paint(self, surface: pygame.Surface) -> None:
        self._blit_layer(surface, self.deep, 0.12)
        px, py = self._par(0.35)
        tp = self.tile
        surface.blit(self.shimmer,
                     (int(self.ox - tp + px % tp),
                      int(self.oy - tp + (self.shimmer_y + py) % tp)),
                     special_flags=pygame.BLEND_RGB_ADD)
        self._blit_layer(surface, self.cracks, 0.55)

        # A wave of brightness sweeping the cracks.
        wave = (self.t * 0.35) % 1.0
        _add(surface, _glow_sprite(int(self.w * 0.22), self.theme.accent, 0.30),
             self.ox + wave * self.w, self.oy + self.h * 0.86)

        px, py = self._par(0.95)
        for x, y, _sp, r, ph, ci in self.embers:
            k = 0.55 + 0.45 * math.sin(ph * 2.0)
            _add(surface, _glow_sprite(int(r * 3.0), self.ember_cols[int(ci)], 0.70 * k),
                 self.ox + x + px, self.oy + y + py)

        self._heat_haze(surface)

    def _heat_haze(self, surface: pygame.Surface) -> None:
        """Refract a horizontal band of whatever has been painted so far."""
        top = int(max(0.0, self.haze_y))
        bot = int(min(float(self.h), self.haze_y + self.haze_h))
        hgt = bot - top
        if hgt < 12:
            return
        try:
            self.haze_buf.blit(surface, (0, 0), (self.ox, self.oy + top, self.w, hgt))
            for i in range(0, hgt, 4):
                f = math.sin(math.pi * (i + top - self.haze_y) / self.haze_h)
                dx = math.sin(self.t * 3.1 + i * 0.13) * 7.0 * max(0.0, f)
                surface.blit(self.haze_buf, (int(self.ox + dx), self.oy + top + i),
                             (0, i, self.w, 4))
        except Exception:
            pass


# ==========================================================================
# 5. OCEAN - caustics, god rays and slow bubbles
# ==========================================================================
class OceanBackground(Background):
    """
    Five depths: a deep-water bloom, a slow swell, the caustic sheet, the god
    rays and the bubbles.

    Signature: rays and bubbles.  The rays are pre-rendered wedges swayed on
    their own phases; the bubbles rise, wobble, and carry a bright meniscus arc
    so they read as surfaces rather than dots.
    """

    def _build(self) -> None:
        th, w, h = self.theme, self.w, self.h
        m = _MARGIN
        self.tile = 384
        light = _mix(th.accent, th.accent2, 0.5)

        # -- deep bloom (depth 0.10) --------------------------------------
        deep, div = self._soft_layer(4)
        spr = _radial(h * 0.42 / div, P.shade(th.accent2, 0.07), 1.0, 8)
        for i in range(7):
            _add(deep, spr, (m + w * (i + 0.5) / 7.0) / div,
                 (m + self.rng.uniform(-h * 0.1, h * 0.5)) / div)
        self.deep = self._soft_finish(deep)

        def caustic(u: float, v: float) -> RGB:
            # Three sine gratings at co-prime frequencies beat against each
            # other; the zero-crossings of their sum are thin wandering curves,
            # and (1 - |sum|)**14 lights exactly those - a water caustic.
            s = (math.sin((u * 3.0 + v * 2.0) * TAU + 0.7)
                 + math.sin((u * 2.0 - v * 5.0) * TAU + 2.1)
                 + math.sin((u * 5.0 + v * 3.0) * TAU + 4.3))
            k = (1.0 - clamp(abs(s) / 3.0, 0.0, 1.0)) ** 14
            return P.shade(light, 0.34 * k)

        def swell(u: float, v: float) -> RGB:
            k = (0.5 + 0.5 * math.sin((u * 1.0 + v * 2.0) * TAU)) ** 2
            return P.shade(th.grid, 0.16 * k)

        self.caustic_a = _seamless_layer(w, h, self.tile, 48, caustic)
        self.caustic_b = _seamless_layer(w, h, 256, 24, swell)
        self.ca = [0.0, 0.0]
        self.cb = [0.0, 0.0]

        # God rays: soft wedges pre-rendered once, then swayed horizontally.
        self.rays: List[Tuple[pygame.Surface, float, float, float]] = []
        rh = max(8, h // 4)                  # built quarter height, then stretched
        for _ in range(5):
            rw = int(self.rng.uniform(w * 0.06, w * 0.14))
            small = pygame.Surface((rw * 2, rh))
            small.fill((0, 0, 0))
            for yy in range(0, rh, 2):
                f = (1.0 - yy / float(rh)) ** 1.6
                half = rw * (0.35 + 0.65 * yy / float(rh))
                small.fill(P.shade(th.accent2, 0.09 * f),
                           (int(rw - half), yy, int(half * 2), 2))
            surf = pygame.transform.smoothscale(small, (rw * 2, h))
            self.rays.append((_conv(surf), self.rng.uniform(0, w),
                              self.rng.uniform(0.12, 0.3), self.rng.uniform(0, TAU)))

        self.bubbles: List[List[float]] = [self._new_bubble(self.rng.uniform(0, h))
                                           for _ in range(42)]
        # A bubble's meniscus takes its colour from the water behind it.  Eight
        # depth bands are indistinguishable from a per-pixel blend and save two
        # colour blends per bubble per frame.
        self.rim_cols = [_mix(self._bg_at(h * (i + 0.5) / 8.0), th.accent2, 0.55)
                         for i in range(8)]

    def _new_bubble(self, y: Optional[float] = None) -> List[float]:
        return [self.rng.uniform(0, self.w),
                self.h + 10.0 if y is None else y,
                self.rng.uniform(14, 46),
                self.rng.uniform(2.0, 7.0),
                self.rng.uniform(0, TAU)]

    def _animate(self, dt: float) -> None:
        self.ca[0] = (self.ca[0] + 13.0 * dt) % self.tile
        self.ca[1] = (self.ca[1] + 7.0 * dt) % self.tile
        self.cb[0] = (self.cb[0] - 5.0 * dt) % 256.0
        self.cb[1] = (self.cb[1] + 3.0 * dt) % 256.0
        for b in self.bubbles:
            b[1] -= b[2] * dt
            b[4] += dt * 1.3
            b[0] += math.sin(b[4]) * 12.0 * dt
            if b[1] < -12.0:
                b[:] = self._new_bubble()

    def _paint(self, surface: pygame.Surface) -> None:
        self._blit_layer(surface, self.deep, 0.10)

        px, py = self._par(0.35)
        surface.blit(self.caustic_b,
                     (int(self.ox - 256 + (self.cb[0] + px) % 256.0),
                      int(self.oy - 256 + (self.cb[1] + py) % 256.0)),
                     special_flags=pygame.BLEND_RGB_ADD)
        px, py = self._par(0.70)
        t_ = self.tile
        surface.blit(self.caustic_a,
                     (int(self.ox - t_ + (self.ca[0] + px) % t_),
                      int(self.oy - t_ + (self.ca[1] + py) % t_)),
                     special_flags=pygame.BLEND_RGB_ADD)

        px, _py = self._par(0.55)
        for surf, x0, speed, ph in self.rays:
            x = x0 + math.sin(self.t * speed + ph) * self.w * 0.06 + px
            surface.blit(surf, (int(self.ox + x - surf.get_width() * 0.5), self.oy),
                         special_flags=pygame.BLEND_RGB_ADD)

        px, py = self._par(0.95)
        rim = self.rim_cols
        band = 8.0 / float(self.h)
        for x, y, _sp, r, _ph in self.bubbles:
            sx, sy = self.ox + x + px, self.oy + y + py
            _add(surface, _glow_sprite(int(r * 2.0), self.theme.accent2, 0.34), sx, sy)
            pygame.draw.circle(surface, rim[int(clamp(y * band, 0.0, 7.0))],
                               (int(sx), int(sy)), int(r), 1)


# ==========================================================================
# 6. STATIC - drifting signal bands and interference tearing
# ==========================================================================
class StaticBackground(Background):
    """
    Four depths: three signal bands drifting at different rates, plus grain.

    Signature: the tearing.  Every layer gets its own random horizontal jitter
    each frame - the whole picture shears, not just a band - and displaced tear
    strips with a chromatic fringe punch through on top.

    The snow is eight pre-rendered grain tiles stamped in a grid from a random
    origin, which is both denser and cheaper than the per-frame speck fills it
    replaces.
    """

    STREAKS = 24
    SCAN_PERIOD = 4
    NOISE = 192

    def _build(self) -> None:
        th, w, h = self.theme, self.w, self.h
        self.speck_cols = (P.shade(th.accent, 0.75), P.shade(th.accent2, 0.70),
                           P.shade(th.text, 0.55), P.shade(th.grid, 1.4))
        self.streak_col = P.shade(th.accent2, 0.30)
        self.tears: List[List[float]] = []
        self.tear_cd = 0.0
        self.bar_y = 0.0
        self.scan_off = 0.0
        self.jitter = [0.0, 0.0, 0.0]

        # Dead-channel signal: three bands of grain that drift at their own
        # rates, so even between tears the frame has depth.
        self.sig_period = 256
        band_col = _mix(th.grid, th.accent2, 0.4)
        self.signals: List[pygame.Surface] = []
        for k, (freq, amp) in enumerate(((2.0, 0.30), (3.0, 0.20), (5.0, 0.13))):
            def band(u: float, v: float, _f=freq, _a=amp, _k=k) -> RGB:
                s = (0.5 + 0.5 * math.sin(v * TAU * _f + math.sin(u * TAU) * 0.6 + _k))
                return P.shade(band_col, _a * (s ** 3))
            self.signals.append(_seamless_layer(w, h, self.sig_period, 32, band))
        self.sig_y = [0.0, 0.0, 0.0]
        self.sig_speed = (16.0, 38.0, 74.0)

        # Six tiles at 170 specks each: forty tile blits a frame put ~6800
        # specks on screen, an order of magnitude denser than the per-frame
        # fills this replaced, and the whole bank builds in about 9 ms.
        self.noise = _noise_tiles(self.NOISE, 6, 170, self.speck_cols, self.rng)

        # Scanlines are baked into one multiply-blend layer: 150 darkens, 255
        # leaves the pixel alone.  One blit beats ~160 per-row fills by 6x.
        scan = pygame.Surface((self.w, self.h + self.SCAN_PERIOD))
        scan.fill((255, 255, 255))
        for y in range(0, scan.get_height(), self.SCAN_PERIOD):
            scan.fill((150, 150, 150), (0, y, self.w, 2))
        self.scanlines = _conv(scan)

        bar = pygame.Surface((self.w, 90))
        bar.fill((0, 0, 0))
        for yy in range(90):
            f = math.sin(math.pi * yy / 90.0) ** 2
            bar.fill(P.shade(th.accent, 0.10 * f), (0, yy, self.w, 1))
        self.bar = _conv(bar)

        # Streaks and tears used to be blended ``fill`` calls.  A blended fill
        # is not accelerated - it costs about 8 ns a pixel *plus* ~25 us of
        # call overhead - so forty of them a frame was costing more than every
        # other layer put together.  Both are now sub-rect blits of a
        # pre-rendered strip, which is the same picture for a twentieth of the
        # time.
        streak = pygame.Surface((260, 3))
        streak.fill(self.streak_col)
        self.streak_img = _conv(streak)
        self.tear_h = 48
        tear = pygame.Surface((self.w, self.tear_h))
        tear.fill(P.shade(th.accent2, 0.24))
        self.tear_img = _conv(tear)

    def _animate(self, dt: float) -> None:
        self.bar_y = (self.bar_y + self.h * 0.28 * dt) % (self.h + 120.0)
        self.scan_off = (self.scan_off + 24.0 * dt) % float(self.SCAN_PERIOD)
        for i in range(3):
            self.sig_y[i] = (self.sig_y[i] + self.sig_speed[i] * dt) % self.sig_period
            # A layer usually sits still and occasionally shears sideways.
            self.jitter[i] = (self.rng.uniform(-14.0, 14.0) * (i + 1)
                              if self.rng.random() < 0.28 else self.jitter[i] * 0.5)
        self.tear_cd -= dt
        if self.tear_cd <= 0.0:
            self.tear_cd = self.rng.uniform(0.03, 0.28)
            for _ in range(self.rng.randint(2, 5)):
                self.tears.append([self.rng.uniform(0, self.h),          # y
                                   self.rng.uniform(5, 42),              # height
                                   self.rng.uniform(-90, 90),            # x shift
                                   self.rng.uniform(0.06, 0.32)])        # life
        for tr in self.tears:
            tr[3] -= dt
        self.tears = [tr for tr in self.tears if tr[3] > 0.0][-20:]

    def _paint(self, surface: pygame.Surface) -> None:
        th = self.theme
        rng = self.rng
        ox, oy, w, h = self.ox, self.oy, self.w, self.h
        sp = self.sig_period

        for i, layer in enumerate(self.signals):
            px, py = self._par(0.2 + 0.35 * i)
            surface.blit(layer,
                         (int(ox - sp + (px + self.jitter[i]) % sp),
                          int(oy - sp + (self.sig_y[i] + py) % sp)),
                         special_flags=pygame.BLEND_RGB_ADD)

        # Torn horizontal streaks: the smeared chunks of a lost signal.
        img = self.streak_img
        for _ in range(self.STREAKS):
            surface.blit(img, (ox + rng.randrange(w), oy + rng.randrange(h)),
                         (0, 0, rng.randint(30, 260), rng.randint(1, 3)),
                         special_flags=pygame.BLEND_RGB_ADD)

        # Snow: eight pre-rendered grain tiles stamped from a random origin, so
        # the pattern never repeats visibly between frames.
        step = self.NOISE
        tiles = self.noise
        n = len(tiles)
        idx = rng.randrange(n)
        x0 = ox - rng.randrange(step)
        y0 = oy - rng.randrange(step)
        for yy in range(y0, oy + h, step):
            for xx in range(x0, ox + w, step):
                surface.blit(tiles[idx % n], (xx, yy), special_flags=pygame.BLEND_RGB_ADD)
                idx += 1

        # Interference tears: displaced bands with a chromatic fringe.
        for y, bh, shift, _life in self.tears:
            r = pygame.Rect(int(ox + shift), int(oy + y), w, int(bh))
            surface.blit(self.tear_img, r.topleft,
                         (0, 0, w, min(int(bh), self.tear_h)),
                         special_flags=pygame.BLEND_RGB_ADD)
            pygame.draw.line(surface, _mix(th.accent, th.text, 0.4),
                             (r.x, r.y), (r.x + w, r.y), 1)
            pygame.draw.line(surface, th.hazard,
                             (r.x - 6, r.bottom), (r.x + w - 6, r.bottom), 1)

        surface.blit(self.bar, (ox, int(oy + self.bar_y - 120)),
                     special_flags=pygame.BLEND_RGB_ADD)

        # Scanlines last: a multiply blend keeps them subtle over everything.
        surface.blit(self.scanlines, (ox, int(oy - self.SCAN_PERIOD + self.scan_off)),
                     special_flags=pygame.BLEND_RGB_MULT)


# ==========================================================================
# 7. ICE - drifting crystals and creeping frost
# ==========================================================================
class IceBackground(Background):
    """
    Four depths: a cold haze, a scrolling sheet of hairline cracks, the frost
    rim and the crystal fall.

    Signature: the frost creeps.  Branches are pre-grown once and sorted by how
    far their root is from the nearest wall, so raising a single count makes the
    frost advance inward from every edge at once - the growth is a sort order,
    not a simulation.
    """

    def _build(self) -> None:
        th, w, h = self.theme, self.w, self.h
        m = _MARGIN

        # -- cold haze (depth 0.12) ---------------------------------------
        haze, div = self._soft_layer(4)
        for _ in range(9):
            _add(haze, _radial(h * self.rng.uniform(0.22, 0.45) / div,
                               P.shade(th.accent, 0.055), 1.0, 8),
                 (m + self.rng.uniform(0, w)) / div, (m + self.rng.uniform(0, h)) / div)
        self.haze = self._soft_finish(haze)

        # -- ice sheet (depth 0.35): hairline cracks that scroll -----------
        sheet = self._new_strip(w)
        crack = P.shade(_mix(th.accent, th.text, 0.3), 0.22)
        for _ in range(30):
            x = self.rng.uniform(0, w)
            y = self.rng.uniform(0, h)
            pts = [(x, y + m)]
            ang = self.rng.uniform(0, TAU)
            for _ in range(self.rng.randint(3, 6)):
                ang += self.rng.uniform(-0.7, 0.7)
                d = self.rng.uniform(30, 90)
                x += math.cos(ang) * d
                y += math.sin(ang) * d
                pts.append((x, y + m))
            try:
                pygame.draw.lines(sheet, crack, False,
                                  [(int(a), int(b)) for a, b in pts], 1)
            except Exception:
                pass
        self.sheet = _conv(sheet)
        self.sheet_x = 0.0

        # -- frost rim (depth 0.6) ----------------------------------------
        self.branches: List[Tuple[Tuple[float, float], Tuple[float, float]]] = []
        for _ in range(52):
            side = self.rng.randrange(4)
            if side == 0:
                x, y, ang = self.rng.uniform(0, w), 0.0, math.pi * 0.5
            elif side == 1:
                x, y, ang = self.rng.uniform(0, w), float(h), -math.pi * 0.5
            elif side == 2:
                x, y, ang = 0.0, self.rng.uniform(0, h), 0.0
            else:
                x, y, ang = float(w), self.rng.uniform(0, h), math.pi
            self._grow(x, y, ang, self.rng.uniform(28, 62), 3)
        # Sorting by distance from the nearest wall turns "show the first N"
        # into "the frost has crept N pixels inward".
        self.branches.sort(key=lambda b: min(b[0][0], w - b[0][0],
                                             b[0][1], h - b[0][1]))
        self.frost_col = _mix(th.accent, th.text, 0.5)

        # -- crystals (depth 0.7 / 0.9 / 1.1) ------------------------------
        self.crystal_frames: List[List[pygame.Surface]] = []
        for size in (7, 11, 16):
            proto = pygame.Surface((size * 4, size * 4), pygame.SRCALPHA)
            cx = cy = size * 2
            pts = [(cx + math.cos(TAU * i / 6) * size, cy + math.sin(TAU * i / 6) * size)
                   for i in range(6)]
            pygame.draw.polygon(proto, P.with_alpha(_mix(th.accent, th.bg_top, 0.55), 110), pts)
            pygame.draw.polygon(proto, P.with_alpha(th.accent2, 225), pts, 2)
            for i in range(3):                        # internal facets
                a = TAU * i / 6
                pygame.draw.line(proto, P.with_alpha(th.text, 130),
                                 (cx - math.cos(a) * size * 0.9, cy - math.sin(a) * size * 0.9),
                                 (cx + math.cos(a) * size * 0.9, cy + math.sin(a) * size * 0.9), 1)
            self.crystal_frames.append(
                [_conv(pygame.transform.rotate(proto, -360.0 * i / 24.0), True)
                 for i in range(24)])
        self.crystal_depth = (0.7, 0.9, 1.15)

        self.crystals: List[List[float]] = []
        for _ in range(26):
            si = self.rng.randrange(3)
            self.crystals.append([self.rng.uniform(0, w), self.rng.uniform(0, h),
                                  self.rng.uniform(-22, 22) * (1.0 + si * 0.4),
                                  self.rng.uniform(8, 30) * (1.0 + si * 0.4),
                                  self.rng.uniform(0, TAU), self.rng.uniform(-1.1, 1.1),
                                  float(si)])

        vign = self._new_layer()
        for i in range(9):                              # cold rim light
            f = (i + 1) / 9.0
            pygame.draw.rect(vign, P.shade(th.accent, 0.05 * f),
                             (m + i * 4, m + i * 4, w - i * 8, h - i * 8), 4)
        self.rim = _conv(vign)

    def _grow(self, x: float, y: float, ang: float, length: float, depth: int) -> None:
        """One frost twig plus two children - classic recursive branching."""
        if depth <= 0 or length < 5.0:
            return
        ex = x + math.cos(ang) * length
        ey = y + math.sin(ang) * length
        self.branches.append(((x, y), (ex, ey)))
        for sign in (-1.0, 1.0):
            self._grow(ex, ey, ang + sign * self.rng.uniform(0.4, 0.9),
                       length * self.rng.uniform(0.5, 0.72), depth - 1)

    def _animate(self, dt: float) -> None:
        self.sheet_x -= 6.0 * dt
        for c in self.crystals:
            c[0] += c[2] * dt
            c[1] += c[3] * dt
            c[4] += c[5] * dt
            if c[1] > self.h + 40:
                c[1] = -40.0
                c[0] = self.rng.uniform(0, self.w)
            if c[0] < -40:
                c[0] = self.w + 30.0
            elif c[0] > self.w + 40:
                c[0] = -30.0

    def _paint(self, surface: pygame.Surface) -> None:
        self._blit_layer(surface, self.haze, 0.12)
        self._wrap_add(surface, self.sheet, self.sheet_x, depth=0.35)
        self._blit_layer(surface, self.rim, 0.5)

        # Frost "creeps": one slow breath decides how deep it has reached.
        px, py = self._par(0.6)
        grow = 0.5 + 0.5 * math.sin(self.t * 0.24)
        shown = int(len(self.branches) * (0.35 + 0.65 * grow))
        col = P.shade(self.frost_col, 0.30 + 0.35 * grow)
        ix, iy = self.ox + px, self.oy + py
        for i in range(shown):
            (ax, ay), (bx, by) = self.branches[i]
            pygame.draw.line(surface, col, (ix + ax, iy + ay), (ix + bx, iy + by), 1)

        for x, y, _vx, _vy, ang, _sp, si in self.crystals:
            idx = int(si)
            px, py = self._par(self.crystal_depth[idx])
            frames = self.crystal_frames[idx]
            img = frames[int(ang / TAU * 24.0) % 24]
            cx, cy = int(self.ox + x + px), int(self.oy + y + py)
            surface.blit(img, img.get_rect(center=(cx, cy)))
            _add(surface, _glow_sprite(14, self.theme.accent, 0.20), cx, cy)


# ==========================================================================
# 8. SPORES - clumping, bobbing blobs over damp mist
# ==========================================================================
class SporeBackground(Background):
    """
    Four depths: two mist banks, a bed of glowing pods, and the spore swarm.

    Signature: the clumping.  Spores do not fly solo - each belongs to a drifting
    colony centre and orbits it, so the swarm gathers, thins and gathers again
    without a single distance check at run time.
    """

    COUNT = 52
    CLUSTERS = 8

    def _build(self) -> None:
        th, w, h = self.theme, self.w, self.h
        self.mist_far = self._mist(10, h * 0.24, h * 0.48, 0.10)
        self.mist_near = self._mist(14, h * 0.10, h * 0.26, 0.22)
        self.mist_far_x = 0.0
        self.mist_near_x = 0.0

        # A bed of half-buried pods pulsing along the arena floor.
        bed = self._new_layer()
        m = _MARGIN
        self.pods = [(self.rng.uniform(0, w), h - self.rng.uniform(0, h * 0.12),
                      self.rng.uniform(10, 26), self.rng.uniform(0, TAU))
                     for _ in range(13)]
        for x, y, r, _ph in self.pods:
            pygame.draw.circle(bed, P.shade(th.grid, 0.9),
                               (int(m + x), int(m + y)), int(r), 2)
        self.bed = _conv(bed)

        # Blob sprites: a soft core with a brighter membrane ring.
        self.blobs: List[pygame.Surface] = []
        for r in (5, 8, 12, 17, 23):
            d = r * 4
            s = pygame.Surface((d, d))
            s.fill((0, 0, 0))
            _add(s, _radial(r * 1.9, P.shade(th.accent, 0.24), 1.0, 10), d * 0.5, d * 0.5)
            pygame.draw.circle(s, P.shade(th.accent2, 0.38), (d // 2, d // 2), r, 2)
            pygame.draw.circle(s, P.shade(th.accent, 0.55), (int(d * 0.44), int(d * 0.42)),
                               max(1, r // 4))
            self.blobs.append(_conv(s))

        # Colony centres: the spores hang off these, so they clump.
        self.clusters: List[List[float]] = []
        for _ in range(self.CLUSTERS):
            self.clusters.append([self.rng.uniform(0, w), self.rng.uniform(0, h),
                                  self.rng.uniform(-7.0, 7.0),
                                  self.rng.uniform(-26.0, -9.0),
                                  self.rng.uniform(0, TAU)])
        self.spores: List[List[float]] = [self._new_spore() for _ in range(self.COUNT)]

    def _mist(self, count: int, rmin: float, rmax: float, amp: float) -> pygame.Surface:
        """A mist bank that tiles horizontally so it can drift forever."""
        strip, div = self._soft_strip(4)
        sw = strip.get_width()
        for _ in range(count):
            r = self.rng.uniform(rmin, rmax) / div
            spr = _radial(r, P.shade(self.theme.grid, self.rng.uniform(amp * 0.5, amp)),
                          1.0, 8)
            x = self.rng.uniform(0, float(sw))
            y = (_MARGIN + self.rng.uniform(self.h * 0.2, self.h * 1.05)) / div
            _add(strip, spr, x, y)
            if x < r:
                _add(strip, spr, x + sw, y)
            elif x > sw - r:
                _add(strip, spr, x - sw, y)
        return self._soft_strip_finish(strip)

    def _new_spore(self) -> List[float]:
        return [float(self.rng.randrange(self.CLUSTERS)),   # colony
                self.rng.uniform(0, TAU),                   # orbit angle
                self.rng.uniform(8.0, 74.0),                # orbit radius
                self.rng.uniform(-0.9, 0.9),                # orbit rate
                float(self.rng.randrange(5)),               # sprite index
                self.rng.uniform(0, TAU)]                   # bob phase

    def _animate(self, dt: float) -> None:
        self.mist_far_x += 2.0 * dt
        self.mist_near_x += 6.5 * dt
        for c in self.clusters:
            c[4] += dt * 0.4
            c[0] += (c[2] + math.sin(c[4]) * 9.0) * dt
            c[1] += c[3] * dt
            if c[1] < -70.0:
                c[1] = self.h + 70.0
                c[0] = self.rng.uniform(0, self.w)
            if c[0] < -80.0:
                c[0] = self.w + 70.0
            elif c[0] > self.w + 80.0:
                c[0] = -70.0
        for s in self.spores:
            s[1] += s[3] * dt
            s[5] += dt * 1.1

    def _paint(self, surface: pygame.Surface) -> None:
        self._wrap_add(surface, self.mist_far, self.mist_far_x, depth=0.15)
        self._wrap_add(surface, self.mist_near, self.mist_near_x, depth=0.40)
        self._blit_layer(surface, self.bed, 0.55)

        px, py = self._par(0.55)
        for x, y, r, ph in self.pods:
            k = 0.45 + 0.55 * (0.5 + 0.5 * math.sin(self.t * 1.1 + ph))
            _add(surface, _glow_sprite(int(r * 2.2), self.theme.accent2, 0.22 * k),
                 self.ox + x + px, self.oy + y + py)

        px, py = self._par(1.0)
        blobs = self.blobs
        clusters = self.clusters
        for ci, ang, orb, _rate, si, bob in self.spores:
            cx, cy, _vx, _vy, _cp = clusters[int(ci)]
            x = cx + math.cos(ang) * orb
            y = cy + math.sin(ang) * orb * 0.7 + math.sin(bob) * 7.0
            _add(surface, blobs[int(si)], self.ox + x + px, self.oy + y + py)


# ==========================================================================
# 9. MACHINE - meshing gear trains and sliding pistons
# ==========================================================================
class MachineBackground(Background):
    """
    Three depths: a dim gear works far behind, riveted plates, and the live
    machinery.

    Signature: the gears actually mesh.  A driven gear is placed exactly one
    pitch-radius sum away from its driver, its speed is the tooth ratio with the
    sign flipped, and its phase is solved so a tooth of the driver always faces a
    gap of the driven one:

        phi_b = theta + pi - pi/n_b + (n_a/n_b) * (theta - phi_a)

    Because the tooth counts fix the speed ratio exactly, that relation holds for
    the rest of the run - the train never drifts out of mesh.
    """

    ROT_STEPS = 12
    SPECS = ((44, 9), (70, 12), (104, 16))
    PITCH = 0.90               # pitch radius as a fraction of the tip radius

    def _build(self) -> None:
        th, w, h = self.theme, self.w, self.h
        m = _MARGIN
        body = P.with_alpha(_mix(th.bg_bottom, (0, 0, 0), 0.45), 238)
        rim = P.with_alpha(_mix(th.grid, th.accent, 0.55), 255)

        self.gear_sets: List[List[pygame.Surface]] = []
        self.gear_teeth: List[int] = []
        self.gear_radius: List[int] = []
        for radius, teeth in self.SPECS:
            self.gear_sets.append(self._gear_frames(radius, teeth, body, rim))
            self.gear_teeth.append(teeth)
            self.gear_radius.append(radius)

        # -- far works (depth 0.15): the same gears, tiny and unlit ---------
        deep = self._new_layer()
        dim = _mix(th.grid, (0, 0, 0), 0.45)
        for _ in range(14):
            r = self.rng.randint(20, 46)
            n = self.rng.randint(8, 13)
            cx = m + self.rng.uniform(0, w)
            cy = m + self.rng.uniform(0, h)
            pts = []
            for i in range(n * 2):
                a = TAU * i / (n * 2)
                rr = r if (i % 2 == 0) else r * 0.78
                pts.append((cx + math.cos(a) * rr, cy + math.sin(a) * rr))
            try:
                pygame.draw.polygon(deep, P.shade(dim, 0.55), pts, 2)
            except Exception:
                pass
        self.deep = _conv(deep)

        # -- riveted plates (depth 0.45), one sprite each ------------------
        self.plates: List[Tuple[pygame.Surface, float, float]] = []
        for _ in range(6):
            pw = int(self.rng.uniform(160, 420))
            ph = int(self.rng.uniform(120, 320))
            plate = pygame.Surface((pw, ph), pygame.SRCALPHA)
            r = pygame.Rect(0, 0, pw, ph)
            pygame.draw.rect(plate, P.with_alpha(_mix(th.bg_bottom, (0, 0, 0), 0.30), 150),
                             r, border_radius=8)
            pygame.draw.rect(plate, P.with_alpha(th.grid, 90), r, 2, border_radius=8)
            for bx in range(12, pw - 6, 34):
                pygame.draw.circle(plate, P.with_alpha(th.grid, 120), (bx, 12), 3)
                pygame.draw.circle(plate, P.with_alpha(th.grid, 120), (bx, ph - 12), 3)
            self.plates.append((_conv(plate, True),
                                self.rng.uniform(-40, w - 120),
                                self.rng.uniform(-40, h - 100)))

        # -- gear trains (depth 0.90) --------------------------------------
        self.gears: List[List[float]] = []
        for _ in range(4):
            self._train()

        self.pistons: List[List[float]] = []
        for _ in range(5):
            vertical = self.rng.random() < 0.5
            self.pistons.append([self.rng.uniform(w * 0.08, w * 0.92),
                                 self.rng.uniform(h * 0.08, h * 0.92),
                                 self.rng.uniform(60, 150),          # throw
                                 self.rng.uniform(0.5, 1.4),         # rate
                                 self.rng.uniform(0, TAU),
                                 1.0 if vertical else 0.0])
        self.piston_body = _mix(th.bg_bottom, (0, 0, 0), 0.5)
        self.piston_rim = _mix(th.grid, th.accent, 0.45)
        self.lamps = [(self.rng.uniform(0, w), self.rng.uniform(0, h),
                       self.rng.uniform(0, TAU)) for _ in range(10)]

    def _train(self) -> None:
        """Lay down a driver gear and one or two gears meshed onto it."""
        gi = self.rng.randrange(len(self.SPECS))
        x = self.rng.uniform(self.w * 0.05, self.w * 0.95)
        y = self.rng.uniform(self.h * 0.05, self.h * 0.95)
        phase = self.rng.uniform(0, TAU)
        omega = self.rng.uniform(0.30, 0.95) * self.rng.choice((-1.0, 1.0))
        self.gears.append([x, y, float(gi), phase, omega])

        for _ in range(self.rng.randint(1, 2)):
            gj = self.rng.randrange(len(self.SPECS))
            na = self.gear_teeth[gi]
            nb = self.gear_teeth[gj]
            gap = (self.gear_radius[gi] + self.gear_radius[gj]) * self.PITCH
            theta = self.rng.uniform(0, TAU)
            nx = x + math.cos(theta) * gap
            ny = y + math.sin(theta) * gap
            phase_b = theta + math.pi - math.pi / nb + (na / float(nb)) * (theta - phase)
            omega_b = -omega * na / float(nb)
            self.gears.append([nx, ny, float(gj), phase_b, omega_b])
            x, y, gi, phase, omega = nx, ny, gj, phase_b, omega_b

    def _gear_frames(self, radius: int, teeth: int, body, rim) -> List[pygame.Surface]:
        """
        Pre-rotate a gear over one tooth pitch - the rest is rotational symmetry.

        Every frame is cropped back to the same d x d box.  Rotation about the
        centre never leaves the circumscribed circle, so the crop is lossless and
        the frames stay small enough to keep the whole bank around 4 MB.
        """
        d = radius * 2 + 8
        proto = pygame.Surface((d, d), pygame.SRCALPHA)
        c = d * 0.5
        n = teeth * 2
        pts = []
        for i in range(n):
            a = TAU * i / n
            rr = radius if (i % 2 == 0) else radius * 0.80
            pts.append((c + math.cos(a) * rr, c + math.sin(a) * rr))
        pygame.draw.polygon(proto, body, pts)
        pygame.draw.polygon(proto, rim, pts, 2)
        pygame.draw.circle(proto, rim, (int(c), int(c)), int(radius * 0.30), 2)
        for i in range(5):
            a = TAU * i / 5
            pygame.draw.line(proto, rim,
                             (c + math.cos(a) * radius * 0.32, c + math.sin(a) * radius * 0.32),
                             (c + math.cos(a) * radius * 0.70, c + math.sin(a) * radius * 0.70), 4)
        pitch = 360.0 / teeth
        frames: List[pygame.Surface] = []
        for i in range(self.ROT_STEPS):
            rot = pygame.transform.rotate(proto, -pitch * i / self.ROT_STEPS)
            frame = pygame.Surface((d, d), pygame.SRCALPHA)
            frame.blit(rot, rot.get_rect(center=(d // 2, d // 2)))
            frames.append(_conv(frame, True))
        return frames

    def _animate(self, dt: float) -> None:
        for g in self.gears:
            g[3] += g[4] * dt

    def _paint(self, surface: pygame.Surface) -> None:
        self._blit_layer(surface, self.deep, 0.15)

        px, py = self._par(0.45)
        for plate, x, y in self.plates:
            surface.blit(plate, (int(self.ox + x + px), int(self.oy + y + py)))

        px, py = self._par(0.90)
        for x, y, gi, ang, _sp in self.gears:
            idx = int(gi)
            frames = self.gear_sets[idx]
            pitch = TAU / self.gear_teeth[idx]
            k = int((ang % pitch) / pitch * self.ROT_STEPS) % self.ROT_STEPS
            img = frames[k]
            surface.blit(img, img.get_rect(center=(int(self.ox + x + px),
                                                   int(self.oy + y + py))))

        for x, y, throw, rate, ph, vertical in self.pistons:
            s = math.sin(self.t * rate + ph) * throw * 0.5
            if vertical > 0.5:
                rod = pygame.Rect(int(self.ox + x + px - 9),
                                  int(self.oy + y + py - throw * 0.5 + s), 18,
                                  int(throw * 0.5 + 30))
            else:
                rod = pygame.Rect(int(self.ox + x + px - throw * 0.5 + s),
                                  int(self.oy + y + py - 9),
                                  int(throw * 0.5 + 30), 18)
            pygame.draw.rect(surface, self.piston_body, rod, border_radius=5)
            pygame.draw.rect(surface, self.piston_rim, rod, 2, border_radius=5)

        for x, y, ph in self.lamps:
            k = 0.5 + 0.5 * math.sin(self.t * 2.4 + ph)
            _add(surface, _glow_sprite(13, self.theme.accent, 0.20 + 0.4 * k),
                 self.ox + x + px, self.oy + y + py)


# ==========================================================================
# 10. AURORA - undulating vertical ribbon curtains
# ==========================================================================
class AuroraBackground(Background):
    """
    Three depths of curtain over a starfield and a ground haze.

    Signature: the ribbons really undulate.  Each curtain is blitted a column at
    a time, and every column gets both a vertical displacement (two out-of-step
    sines) and a *source* displacement, which slides the ray structure sideways
    inside the ribbon.  The second one is what turns a wobbling rectangle into a
    sheet folding through itself.
    """

    #: Column width per depth band, near to far.  Wider slices for distant
    #: curtains: the per-column blits are this style's entire cost.
    SLICES = (18, 12, 8)

    def _build(self) -> None:
        th, w, h = self.theme, self.w, self.h
        self.ribbon_w = int(clamp(w * 0.18, 90.0, 260.0))

        # One curtain, built small and smooth-scaled up.  The lit band covers
        # only the middle ~48% of the strip's height, which is what makes the
        # per-column vertical displacement read as an undulating fold rather
        # than a solid rectangle sliding about.
        self.strips: List[pygame.Surface] = []
        for tint in (th.accent, th.accent2, _mix(th.accent, th.accent2, 0.5)):
            cols, rows = 30, 60
            small = pygame.Surface((cols, rows))
            for j in range(rows):
                v = j / float(rows - 1)
                g = clamp((v - 0.20) / 0.48, 0.0, 1.0)
                vert = math.sin(math.pi * g) ** 1.5
                for i in range(cols):
                    u = i / float(cols - 1)
                    # Vertical striations: the ray structure inside a curtain.
                    ray = 0.62 + 0.38 * (0.5 + 0.5 * math.sin(u * TAU * 3.5))
                    horiz = math.sin(math.pi * u) ** 1.4
                    small.set_at((i, j), P.shade(tint, 0.62 * vert * horiz * ray))
            self.strips.append(_conv(pygame.transform.smoothscale(small, (self.ribbon_w, h))))

        # Depth per ribbon: far curtains drift slowly and fold gently.
        self.ribbons: List[List[float]] = []
        for i in range(6):
            depth = (0.25, 0.55, 0.95)[i % 3]
            self.ribbons.append([self.rng.uniform(-0.1, 1.1) * w,      # x
                                 self.rng.uniform(4.0, 10.0) * (0.5 + depth),
                                 self.rng.uniform(0, TAU),             # wave phase
                                 self.rng.uniform(0.35, 0.8),          # wave rate
                                 self.rng.uniform(0.012, 0.030),       # wave frequency
                                 float(i % 3),                         # tint index
                                 depth,
                                 # Slice width: a distant curtain does not need
                                 # its fold resolved to eight pixels, and the
                                 # column blits are this style's whole cost.
                                 float(self.SLICES[i % 3])])
        self.stars = [(self.rng.uniform(0, w), self.rng.uniform(0, h * 0.7),
                       self.rng.uniform(0.3, 1.0), self.rng.uniform(0, TAU))
                      for _ in range(110)]
        self.star_col = th.text

        haze = self._new_layer()
        for i in range(0, h // 3, 2):
            f = (i / float(max(1, h // 3))) ** 2
            haze.fill(P.shade(th.accent, 0.05 * f), (0, _MARGIN + h - 1 - i,
                                                     w + 2 * _MARGIN, 2))
        self.haze = _conv(haze)

    def _animate(self, dt: float) -> None:
        for r in self.ribbons:
            r[0] += r[1] * dt
            if r[0] > self.w + self.ribbon_w:
                r[0] = -self.ribbon_w
            r[2] += r[3] * dt

    def _paint(self, surface: pygame.Surface) -> None:
        px, py = self._par(0.10)
        ix, iy = int(px), int(py)
        for x, y, amp, ph in self.stars:
            tw = 0.5 + 0.5 * math.sin(self.t * 1.8 + ph)
            surface.fill(P.shade(self.star_col, 0.55 * amp * tw),
                         (self.ox + int(x) + ix, self.oy + int(y) + iy, 1, 1))
        self._blit_layer(surface, self.haze, 0.35)

        rw = self.ribbon_w
        for x, _sp, ph, _rate, freq, ti, depth, slice_w in self.ribbons:
            strip = self.strips[int(ti)]
            px, py = self._par(depth)
            amp_v = self.h * (0.09 + 0.09 * depth)
            step = int(slice_w)
            limit = rw - step
            for sx in range(0, rw, step):
                # Two out-of-step sines per column give the curtain its lazy,
                # non-repeating fold instead of a single rigid wobble.
                col_x = x + sx
                dy = (math.sin(col_x * freq + ph) * amp_v
                      + math.sin(col_x * freq * 2.3 - ph * 1.7) * amp_v * 0.55)
                # ...and sliding the *source* column shears the ray structure,
                # which is what sells the sheet as three-dimensional.
                src = int(clamp(sx + math.sin(col_x * freq * 1.7 + ph * 0.8) * 9.0,
                                0.0, float(limit)))
                surface.blit(strip, (int(self.ox + col_x + px), int(self.oy + dy + py)),
                             (src, 0, step, self.h), pygame.BLEND_RGB_ADD)


# ==========================================================================
# 11. VOIDWARP - a starfield lensed toward a singularity
# ==========================================================================
class VoidWarpBackground(Background):
    """
    Four depths: the lensed starfield, the warped rings, the infalling streaks
    and the core.

    Signature: gravitational lensing.  Every star keeps its *rest* polar
    coordinate and is drawn at ``r - K/(r + s)`` with an extra swirl of
    ``S/(r + s)``, so the field crowds and shears toward the singularity, packs
    into a bright ring at the lensing radius, and relaxes back to a plain
    starfield at the corners.  It costs one divide per star.
    """

    RINGS = 17
    POINTS = 40
    STREAKS = 80
    STARS = 190

    def _build(self) -> None:
        th, w, h = self.theme, self.w, self.h
        self.max_r = math.hypot(w, h) * 0.62
        self.phase = 0.0
        self.swirl = 0.0
        self.streaks: List[List[float]] = [self._new_streak(self.rng.uniform(0.15, 1.0))
                                           for _ in range(self.STREAKS)]
        self.core_a = _glow_sprite(int(h * 0.16), th.accent, 0.75)
        self.core_b = _glow_sprite(int(h * 0.07), th.text, 0.95)
        self.ring_far = th.accent2
        self.ring_near = th.accent

        # Rest positions of the starfield, sampled uniformly over the disc.
        self.stars: List[List[float]] = []
        for _ in range(self.STARS):
            r = self.max_r * math.sqrt(self.rng.uniform(0.02, 1.0))
            self.stars.append([self.rng.uniform(0, TAU), r,
                               self.rng.uniform(0.35, 1.0), self.rng.uniform(0, TAU)])
        self.star_col = _mix(th.text, th.accent2, 0.30)
        self.lens_k = (h * 0.20) ** 2       # lensing strength, in px^2
        self.lens_r = h * 0.24              # where the crowding peaks
        self.halo_col = _mix(th.accent, th.text, 0.45)

    def _centre(self) -> Tuple[float, float]:
        """The singularity drifts a little so the field never looks pinned."""
        return (self.w * 0.5 + math.sin(self.t * 0.21) * self.w * 0.05,
                self.h * 0.5 + math.cos(self.t * 0.17) * self.h * 0.05)

    def _new_streak(self, r01: float = 1.0) -> List[float]:
        return [self.rng.uniform(0, TAU), r01 * self.max_r,
                self.rng.uniform(0.35, 1.0)]

    def _animate(self, dt: float) -> None:
        self.phase = (self.phase + dt * 0.22) % 1.0
        self.swirl += dt * 0.05
        for s in self.streaks:
            # Gravity-ish: the pull grows sharply as radius shrinks, and the
            # angular sweep grows with it, producing an in-spiral.
            pull = 40.0 + 26000.0 / max(60.0, s[1])
            s[1] -= pull * dt * s[2]
            s[0] += (110.0 / max(50.0, s[1])) * dt
            if s[1] < 14.0:
                s[:] = self._new_streak(1.0)

    def _paint(self, surface: pygame.Surface) -> None:
        cx, cy = self._centre()
        px, py = self._par(0.20)
        sx, sy = self.ox + cx + px, self.oy + cy + py

        # -- the lensed starfield ------------------------------------------
        col = self.star_col
        halo = self.halo_col
        K = self.lens_k
        swirl = self.swirl
        lens_r = self.lens_r
        tt = self.t * 2.0
        for a0, r0, b, ph in self.stars:
            a = a0 + swirl + 900.0 / (r0 + 90.0) * 0.02 * self.t
            r = r0 - K / (r0 + 60.0)
            if r < 8.0:
                continue
            x = sx + math.cos(a) * r * 1.12
            y = sy + math.sin(a) * r * 0.88
            crowd = clamp(1.0 - abs(r - lens_r) / (lens_r * 1.6), 0.0, 1.0)
            k = b * (0.45 + 0.55 * math.sin(tt + ph)) * (0.55 + 0.95 * crowd)
            if crowd > 0.55:
                # Close to the lensing radius an image smears into an arc.
                surface.fill(P.shade(halo, k), (int(x), int(y), 3, 1))
            else:
                surface.fill(P.shade(col, k), (int(x), int(y), 1, 1))

        # -- warped rings ---------------------------------------------------
        px, py = self._par(0.55)
        rx, ry = self.ox + cx + px, self.oy + cy + py
        for k in range(self.RINGS):
            # Rings accelerate inward: r ~ p**1.8 bunches them near the core.
            p = ((k + self.phase) / self.RINGS) % 1.0
            r = self.max_r * (p ** 1.8)
            if r < 8.0:
                continue
            f = 1.0 - p
            colr = _mix(self._bg_at(cy), _mix(self.ring_far, self.ring_near, f),
                        clamp(0.25 + 0.75 * f, 0.0, 1.0))
            pts = []
            for i in range(self.POINTS):
                a = TAU * i / self.POINTS
                # Radial wobble + a tangential shear = the "warped" silhouette.
                wob = 1.0 + 0.10 * math.sin(a * 3.0 + self.t * 1.1 + k * 0.5) \
                          + 0.06 * math.sin(a * 5.0 - self.t * 0.7)
                rr = r * wob
                pts.append((rx + math.cos(a) * rr * 1.12, ry + math.sin(a) * rr * 0.88))
            try:
                pygame.draw.lines(surface, colr, True, pts, 2 if f > 0.45 else 1)
            except Exception:
                pass

        # -- infalling matter -----------------------------------------------
        px, py = self._par(0.90)
        stx, sty = self.ox + cx + px, self.oy + cy + py
        streak_col = _mix(self.theme.text, self.theme.accent, 0.4)
        for a, r, _spd in self.streaks:
            k = clamp(1.0 - r / self.max_r, 0.05, 1.0)
            tail = r + 78.0 * k
            x1, y1 = stx + math.cos(a) * r, sty + math.sin(a) * r
            x2, y2 = stx + math.cos(a - 0.05) * tail, sty + math.sin(a - 0.05) * tail
            pygame.draw.line(surface, P.shade(streak_col, 0.25 + 0.75 * k),
                             (int(x1), int(y1)), (int(x2), int(y2)), 1)

        beat = 0.85 + 0.15 * math.sin(self.t * 3.1)
        _add(surface, self.core_a, stx, sty)
        _add(surface, self.core_b, stx, sty)
        pygame.draw.circle(surface, _mix(self.theme.accent, self.theme.text, 0.6),
                           (int(stx), int(sty)), int(self.h * 0.055 * beat), 2)


# ==========================================================================
# 12. PRISM - rotating refraction wedges
# ==========================================================================
class PrismBackground(Background):
    """
    Three depths: the refraction lattice, the wedge fan, and free shards.

    Signature: the wedges.  The fan is drawn into a quarter-resolution buffer,
    multiplied by a radial falloff and blurred up, and every wedge is drawn
    twice - once for the body, once for a thin edge offset a few degrees in a
    shifted hue, which is what reads as chromatic dispersion.

    The full-size upscale is the single most expensive operation in this module
    (~1.6 ms), so it runs on one frame in three; at a sixth of a degree of spin
    per frame nobody can tell.  Prism Core is the worst level in the game for
    frame time (22 hazards on top of the busiest background), so this is where
    the background budget gets spent - see tools/frame_budget.py.
    """

    WEDGES = 12
    # Low-res divisor for the soft light buffer.  4 rather than 3: the buffer
    # only ever holds twelve big soft wedges and is smoothscaled up through
    # `blur=True` regardless, so a quarter-scale source is indistinguishable
    # from a third-scale one - and it takes 0.16 ms off the mean and 0.47 off
    # the p95 of the most expensive background in the game.
    DIV = 4
    # Deliberately 4 and not 3: the bloom in gfx/effects.py rebuilds on a
    # 3-frame period, and two amortised 1 ms jobs on the same period will
    # eventually phase-lock onto the same frame and stay there.  Co-prime
    # periods put them together one frame in twelve instead of one in three,
    # which is worth more to the p95 than either saving alone.
    UPSCALE_EVERY = 4

    def _build(self) -> None:
        th, w, h = self.theme, self.w, self.h
        m = _MARGIN
        self.spin = 0.0
        self.hue = 0.0
        lo = self._lo_surface(self.DIV)
        self.lw, self.lh = lo.get_width(), lo.get_height()
        self.reach = math.hypot(self.lw, self.lh)

        # A static lattice of faint refraction arcs sits under the beams.
        lat = self._new_layer()
        cx, cy = m + w // 2, m + h // 2
        for i in range(9):
            r = int(h * (0.16 + i * 0.11))
            pygame.draw.circle(lat, P.shade(th.grid, 0.55), (cx, cy), r, 1)
        for i in range(12):
            a = TAU * i / 12
            pygame.draw.line(lat, P.shade(th.grid, 0.35), (cx, cy),
                             (cx + math.cos(a) * w, cy + math.sin(a) * w), 1)
        self.lattice = _conv(lat)
        self.core = _glow_sprite(int(h * 0.28), th.text, 0.30)

        # Radial falloff, multiplied over the wedges so the beams blaze at the
        # refraction point and dissolve toward the edges instead of reading as
        # a flat pie chart.
        # Sized from the buffer *height*, not its diagonal: on a 2:1 arena a
        # diagonal-sized radius would still be near-white at the left and right
        # edges, and the beams would never fade.
        fall = pygame.Surface((self.lw, self.lh))
        fall.fill((16, 16, 16))
        _add(fall, _radial(self.lh * 0.62, (238, 238, 238), 1.0, 18),
             self.lw * 0.5, self.lh * 0.5)
        self.falloff = _conv(fall)
        self.shards = [(self.rng.uniform(0, TAU), self.rng.uniform(h * 0.22, h * 0.48),
                        self.rng.uniform(0.10, 0.35), self.rng.uniform(16, 42))
                       for _ in range(7)]
        self.sparks = [(self.rng.uniform(0, TAU), self.rng.uniform(h * 0.10, h * 0.55),
                        self.rng.uniform(-0.5, 0.5), self.rng.uniform(0, TAU))
                       for _ in range(18)]
        # Sparks cycle hue *and* brightness.  Feeding a fresh colour into the
        # shared glow cache every frame would miss on every lookup and evict
        # everyone else's sprites, so their whole (hue, brightness) space is
        # pre-rendered here into a fixed 16 x 5 bank.
        self.spark_bank: List[List[pygame.Surface]] = [
            [_radial(5, P.rainbow(hi / 16.0, 0.5, 1.0), 0.2 + 0.2 * ki, 8)
             for ki in range(5)] for hi in range(16)]

    def _animate(self, dt: float) -> None:
        self.spin += dt * 0.16
        self.hue += dt * 0.045

    def _paint(self, surface: pygame.Surface) -> None:
        lo = self._lo
        if lo is None:
            return
        lo.fill((0, 0, 0))
        cx, cy = self.lw * 0.5, self.lh * 0.5
        span = TAU / self.WEDGES
        reach = self.reach
        for i in range(self.WEDGES):
            a0 = self.spin + span * i
            # Each wedge breathes independently so the fan never looks rigid.
            width = span * (0.26 + 0.28 * (0.5 + 0.5 * math.sin(self.t * 0.8 + i)))
            hue = self.hue + i / float(self.WEDGES)
            col = P.shade(P.rainbow(hue, 0.85, 1.0), 0.55)
            pygame.draw.polygon(lo, col, [
                (cx, cy),
                (cx + math.cos(a0) * reach, cy + math.sin(a0) * reach),
                (cx + math.cos(a0 + width) * reach, cy + math.sin(a0 + width) * reach),
            ])
            # Dispersion: a thin fringe of a shifted hue along the leading edge.
            edge = width * 0.18
            pygame.draw.polygon(lo, P.shade(P.rainbow(hue + 0.10, 0.9, 1.0), 0.45), [
                (cx, cy),
                (cx + math.cos(a0 - edge) * reach, cy + math.sin(a0 - edge) * reach),
                (cx + math.cos(a0 + edge) * reach, cy + math.sin(a0 + edge) * reach),
            ])
        lo.blit(self.falloff, (0, 0), special_flags=pygame.BLEND_RGB_MULT)
        self._blit_lo(surface, blur=True, every=self.UPSCALE_EVERY)

        self._blit_layer(surface, self.lattice, 0.20)
        px, py = self._par(0.45)
        _add(surface, self.core, self.ox + self.w * 0.5 + px, self.oy + self.h * 0.5 + py)

        # Free-floating shards catching the light on their edges.
        px, py = self._par(0.95)
        scx, scy = self.ox + self.w * 0.5 + px, self.oy + self.h * 0.5 + py
        for a0, orb, rate, size in self.shards:
            a = a0 + self.t * rate
            x, y = scx + math.cos(a) * orb, scy + math.sin(a) * orb * 0.8
            spin = self.t * (0.6 + rate)
            pts = [(x + math.cos(spin + TAU * k / 3) * size,
                    y + math.sin(spin + TAU * k / 3) * size) for k in range(3)]
            pygame.draw.polygon(surface, P.shade(P.rainbow(self.hue + a0, 0.7, 0.95), 0.6),
                                pts, 2)
        bank = self.spark_bank
        for a0, orb, rate, ph in self.sparks:
            a = a0 + self.t * rate * 0.4
            hi = int((self.hue + a0 * 0.3) * 16.0) % 16
            ki = int(clamp(0.5 + 0.5 * math.sin(self.t * 2.2 + ph), 0.0, 0.999) * 5.0)
            _add(surface, bank[hi][ki],
                 scx + math.cos(a) * orb, scy + math.sin(a) * orb * 0.8)


# ==========================================================================
# Factory
# ==========================================================================
_REGISTRY: Dict[str, type] = {
    "grid": GridBackground,
    "nebula": NebulaBackground,
    "circuit": CircuitBackground,
    "lava": LavaBackground,
    "ocean": OceanBackground,
    "static": StaticBackground,
    "ice": IceBackground,
    "spores": SporeBackground,
    "machine": MachineBackground,
    "aurora": AuroraBackground,
    "voidwarp": VoidWarpBackground,
    "prism": PrismBackground,
}


def make_background(style: str, theme: "P.Theme", rect) -> Background:
    """
    Build the `Background` for a style name.

    Unknown or unusable styles fall back to the perspective grid, and any
    failure during construction degrades to the plain pre-rendered gradient -
    a level must never fail to load because of scenery.
    """
    try:
        key = str(style or "").strip().lower()
    except Exception:
        key = ""
    cls = _REGISTRY.get(key, GridBackground)
    try:
        return cls(key or "grid", theme, rect)
    except Exception:
        try:
            return Background(key or "grid", theme, rect)
        except Exception:
            return Background("grid", P.THEMES[0], C.ARENA_RECT)
