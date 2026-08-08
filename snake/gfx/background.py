"""
Animated arena backgrounds for NEON SERPENT.

Every level owns a `Theme` whose ``bg_style`` names one of twelve worlds.  This
module turns that name into a `Background` object that paints the arena behind
everything else, one style per class:

    grid      perspective wireframe rushing toward a glowing horizon
    nebula    parallax starfields over drifting colour clouds
    circuit   etched traces with data pulses running along them
    lava      rising embers, glowing cracks and heat-shimmer bands
    ocean     caustic light ripples, god rays and slow bubbles
    static    scanline noise, interference tearing and a rolling bar
    ice       drifting crystals and frost creeping in from the edges
    spores    bobbing, drifting spore blobs over a damp mist
    machine   silhouetted gears turning and pistons sliding
    aurora    vertical ribbon curtains undulating over a starfield
    voidwarp  concentric warped rings dragged toward a bright singularity
    prism     slow rotating refraction bands cycling through the spectrum

Performance contract
--------------------
Everything static is pre-rendered once in ``__init__``: the base gradient, the
grid fan, circuit traces, cloud banks, caustic tiles, gear rotations and so on.
Per frame we only scroll, blit and draw a bounded number of cheap primitives.
Glow sprites live in a module-level cache, so no surface is ever allocated per
particle per frame.  Additive glow is done by blitting *black-backed* surfaces
with ``BLEND_RGB_ADD`` - the fastest blend path pygame offers, because it needs
no per-pixel alpha.

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


def _glow_sprite(radius: float, color: Sequence[int],
                 intensity: float = 1.0, steps: int = 14) -> pygame.Surface:
    """
    A cached radial glow on a black backing, meant for ``BLEND_RGB_ADD``.

    Concentric filled discs of increasing brightness are stamped from the
    outside in.  Choosing radius_i = R * sqrt(1 - i/steps) makes the number of
    discs covering a pixel proportional to ``1 - (d/R)**2``, i.e. a smooth
    quadratic falloff, without touching a single pixel from Python.
    """
    r = max(1, int(radius))
    col = _rgb(color)
    key = ("glow", r, col, round(float(intensity), 2), steps)
    cached = _SPRITES.get(key)
    if cached is not None:
        return cached
    if len(_SPRITES) > 600:            # keep the cache from growing without bound
        _SPRITES.clear()
    surf = pygame.Surface((r * 2, r * 2))
    surf.fill((0, 0, 0))
    for i in range(steps):
        rr = r * math.sqrt(max(0.0, 1.0 - i / float(steps)))
        if rr < 0.6:
            continue
        f = intensity * (i + 1) / float(steps)
        pygame.draw.circle(surf, P.shade(col, f), (r, r), int(rr))
    surf = _conv(surf)
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

        self.base: pygame.Surface = _vgradient(self.w, self.h,
                                               _rgb(theme.bg_top), _rgb(theme.bg_bottom))
        self._lo: Optional[pygame.Surface] = None
        self._lo_half: Optional[pygame.Surface] = None
        self._lo_big: Optional[pygame.Surface] = None
        try:
            self._build()
        except Exception:
            pass

    # -- helpers available to every style ---------------------------------
    def _bg_at(self, y_local: float) -> RGB:
        """The pre-rendered gradient colour at an arena-local y (for blending)."""
        return _mix(self.theme.bg_top, self.theme.bg_bottom,
                    clamp(y_local / float(self.h), 0.0, 1.0))

    def _lo_surface(self, div: int = 4) -> pygame.Surface:
        """A persistent low-resolution scratch buffer for soft, blurry light."""
        if self._lo is None:
            self._lo = pygame.Surface((max(2, self.w // div), max(2, self.h // div)))
        return self._lo

    def _blit_lo(self, surface: pygame.Surface, blur: bool = False) -> None:
        """
        Upscale the low-res buffer (bilinear = free blur) and add it in.

        With ``blur`` the buffer is halved first.  The downscale *averages*
        neighbouring pixels, so hard polygon edges come back antialiased; blow
        that up and you get a soft light ramp instead of a visible staircase.
        """
        if self._lo is None:
            return
        try:
            src = self._lo
            if blur:
                if self._lo_half is None:
                    self._lo_half = pygame.Surface((max(2, src.get_width() // 2),
                                                    max(2, src.get_height() // 2)))
                try:
                    pygame.transform.smoothscale(src, self._lo_half.get_size(), self._lo_half)
                except (TypeError, ValueError):
                    self._lo_half = pygame.transform.smoothscale(src, self._lo_half.get_size())
                src = self._lo_half
            if self._lo_big is None:
                self._lo_big = pygame.Surface((self.w, self.h))
            try:
                pygame.transform.smoothscale(src, (self.w, self.h), self._lo_big)
            except (TypeError, ValueError):
                self._lo_big = pygame.transform.smoothscale(src, (self.w, self.h))
            surface.blit(self._lo_big, (self.ox, self.oy), special_flags=pygame.BLEND_RGB_ADD)
        except Exception:
            pass

    def _wrap_add(self, surface: pygame.Surface, layer: pygame.Surface,
                  dx: float, dy: float = 0.0) -> None:
        """Additively blit a full-arena layer that scrolls and wraps in x."""
        lw = layer.get_width()
        x = self.ox + (dx % lw) - lw
        surface.blit(layer, (int(x), int(self.oy + dy)), special_flags=pygame.BLEND_RGB_ADD)
        surface.blit(layer, (int(x + lw), int(self.oy + dy)), special_flags=pygame.BLEND_RGB_ADD)

    # -- overridables ------------------------------------------------------
    def _build(self) -> None:
        """Pre-render every static layer. Runs once."""

    def _animate(self, dt: float) -> None:
        """Advance style-specific state."""

    def _paint(self, surface: pygame.Surface) -> None:
        """Draw the animated layers over the gradient."""

    # -- public API --------------------------------------------------------
    def update(self, dt: float) -> None:
        try:
            dt = clamp(float(dt), 0.0, C.MAX_DT)
            self.t += dt
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
        except Exception:
            pass
        finally:
            try:
                surface.set_clip(old_clip)
            except Exception:
                pass


# ==========================================================================
# 1. GRID - perspective wireframe scrolling toward the horizon
# ==========================================================================
class GridBackground(Background):
    ROWS = 22
    SCROLL = 0.62          # rows per second

    def _build(self) -> None:
        th, w, h = self.theme, self.w, self.h
        self.horizon = h * 0.32
        self.span = h - self.horizon
        self.line_hot = _mix(th.grid, th.accent, 0.55)

        layer = pygame.Surface((w, h))
        layer.fill((0, 0, 0))

        # Sky: a fat horizon bloom plus a distant sun and scattered stars.
        _add(layer, _glow_sprite(int(w * 0.42), P.shade(th.accent, 0.42), 0.85),
             w * 0.5, self.horizon)
        _add(layer, _glow_sprite(int(h * 0.20), P.shade(th.accent2, 0.55), 0.7),
             w * 0.5, self.horizon - h * 0.06)
        for i in range(7):                                  # retro sun slats
            y = self.horizon - h * 0.055 - i * (h * 0.017)
            half = math.sqrt(max(0.0, 1.0 - (i / 7.0) ** 2)) * h * 0.15
            pygame.draw.line(layer, P.shade(th.accent2, 0.9 - i * 0.09),
                             (w * 0.5 - half, y), (w * 0.5 + half, y), 3)
        for _ in range(110):
            sx = self.rng.uniform(0, w)
            sy = self.rng.uniform(0, self.horizon - 4)
            f = self.rng.uniform(0.25, 1.0) * (1.0 - sy / max(1.0, self.horizon)) ** 0.5
            layer.fill(P.shade(th.text, 0.55 * f), (int(sx), int(sy), 1, 1))

        # Ground: verticals converging on the vanishing point.
        cx = w * 0.5
        for k in range(-26, 27):
            bx = cx + k * (w / 13.0)
            f = clamp(1.0 - abs(k) / 26.0, 0.10, 1.0)
            pygame.draw.line(layer, P.shade(th.grid, 0.55 + 1.05 * f),
                             (cx, self.horizon), (bx, h), 2 if abs(k) <= 7 else 1)
        self.fan = _conv(layer)

    def _paint(self, surface: pygame.Surface) -> None:
        th = self.theme
        surface.blit(self.fan, (self.ox, self.oy), special_flags=pygame.BLEND_RGB_ADD)

        # Horizontal rungs: y = horizon + span / z with z marching toward 0, so
        # spacing stretches as a rung approaches the viewer - true perspective.
        phase = (self.t * self.SCROLL) % 1.0
        for i in range(1, self.ROWS + 1):
            z = i - phase
            if z <= 0.08:
                continue
            y = self.horizon + self.span / z
            if y > self.h + 6:
                continue
            f = clamp(1.0 / (0.5 + z * 0.44), 0.0, 1.0)
            col = _mix(self._bg_at(y), self.line_hot, f)
            pygame.draw.line(surface, col, (self.ox, self.oy + y),
                             (self.ox + self.w, self.oy + y), 2 if f > 0.55 else 1)

        # A breathing sliver of light exactly on the horizon.
        beat = 0.55 + 0.45 * math.sin(self.t * 1.7)
        pygame.draw.line(surface, _mix(th.accent, th.text, 0.35 * beat),
                         (self.ox, self.oy + self.horizon),
                         (self.ox + self.w, self.oy + self.horizon), 2)


# ==========================================================================
# 2. NEBULA - parallax stars over drifting colour clouds
# ==========================================================================
class NebulaBackground(Background):
    LAYER_SPEEDS = (6.0, 14.0, 30.0)

    def _build(self) -> None:
        th, w, h = self.theme, self.w, self.h
        cloud = pygame.Surface((w, h))
        cloud.fill((0, 0, 0))
        tints = (th.accent, th.accent2, th.grid, _mix(th.accent, th.accent2, 0.5))
        for _ in range(30):
            r = self.rng.uniform(h * 0.14, h * 0.48)
            col = P.shade(self.rng.choice(tints), self.rng.uniform(0.06, 0.15))
            _add(cloud, _glow_sprite(int(r), col, 1.0, steps=10),
                 self.rng.uniform(-w * 0.1, w * 1.1), self.rng.uniform(-h * 0.1, h * 1.1))
        self.cloud = _conv(cloud)
        self.cloud_x = 0.0

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
                        self.rng.uniform(5, 11), self.rng.uniform(0, TAU)) for _ in range(9)]

    def _animate(self, dt: float) -> None:
        self.cloud_x += 5.0 * dt
        for li, layer in enumerate(self.stars):
            vx = self.LAYER_SPEEDS[li] * dt
            for s in layer:
                s[0] -= vx
                if s[0] < 0.0:
                    s[0] += self.w
                    s[1] = self.rng.uniform(0, self.h)

    def _paint(self, surface: pygame.Surface) -> None:
        self._wrap_add(surface, self.cloud, self.cloud_x)
        base = self.star_col
        for layer in self.stars:
            for x, y, sz, ph, amp in layer:
                tw = 0.55 + 0.45 * math.sin(self.t * 2.3 + ph)
                surface.fill(P.shade(base, amp * tw),
                             (self.ox + int(x), self.oy + int(y), int(sz), int(sz)))
        for x, y, r, ph in self.bright:
            k = 0.6 + 0.4 * math.sin(self.t * 1.3 + ph)
            _add(surface, _glow_sprite(int(r), self.theme.accent2, 0.55 * k + 0.25),
                 self.ox + x, self.oy + y)


# ==========================================================================
# 3. CIRCUIT - etched traces with data pulses
# ==========================================================================
class CircuitBackground(Background):
    def _build(self) -> None:
        th, w, h = self.theme, self.w, self.h
        self.paths: List[Tuple[List[Tuple[float, float]], List[float]]] = []
        layer = pygame.Surface((w, h))
        layer.fill((0, 0, 0))
        dim = P.shade(th.grid, 1.15)
        pad = _mix(th.grid, th.accent, 0.4)

        grid_step = 34.0
        for _ in range(26):
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
            pygame.draw.lines(layer, dim, False, [(int(px), int(py)) for px, py in pts], 2)
            for px, py in pts:                        # solder pads at the corners
                pygame.draw.circle(layer, pad, (int(px), int(py)), 4, 1)

        for _ in range(18):                           # chips / vias
            cw = self.rng.randint(26, 64)
            ch = self.rng.randint(20, 40)
            r = pygame.Rect(int(self.rng.uniform(0, w - cw)), int(self.rng.uniform(0, h - ch)), cw, ch)
            pygame.draw.rect(layer, P.shade(th.grid, 0.8), r, 1, border_radius=3)
            pygame.draw.circle(layer, pad, (r.x + 6, r.y + 6), 2)
        self.traces = _conv(layer)

        self.pulses: List[List[float]] = []
        for i in range(28):
            pi = i % max(1, len(self.paths))
            self.pulses.append([float(pi), self.rng.uniform(0.0, 1.0),
                                self.rng.uniform(90.0, 210.0)])
        self.pulse_col = _mix(th.accent, th.text, 0.25)

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

    def _animate(self, dt: float) -> None:
        for p in self.pulses:
            pts, cum = self.paths[int(p[0])]
            p[1] += p[2] * dt / max(1.0, cum[-1])
            if p[1] > 1.0:
                p[1] -= 1.0
                p[0] = float(self.rng.randrange(len(self.paths)))

    def _paint(self, surface: pygame.Surface) -> None:
        if not self.paths:
            return
        beat = 0.75 + 0.25 * math.sin(self.t * 2.0)
        surface.blit(self.traces, (self.ox, self.oy), special_flags=pygame.BLEND_RGB_ADD)
        head = _glow_sprite(11, self.pulse_col, beat)
        tail = _glow_sprite(7, self.theme.accent2, 0.42)
        for pi, s, _spd in self.pulses:
            ipi = int(pi)
            hx, hy = self._point_at(ipi, s)
            tx, ty = self._point_at(ipi, s - 0.045)
            _add(surface, tail, self.ox + tx, self.oy + ty)
            _add(surface, head, self.ox + hx, self.oy + hy)


# ==========================================================================
# 4. LAVA - embers, cracks and heat shimmer
# ==========================================================================
class LavaBackground(Background):
    EMBERS = 78

    def _build(self) -> None:
        th, w, h = self.theme, self.w, self.h

        # A molten floor: broad heat glow along the bottom of the arena.
        layer = pygame.Surface((w, h))
        layer.fill((0, 0, 0))
        for i in range(8):
            _add(layer, _glow_sprite(int(h * 0.38), P.shade(th.accent, 0.16), 1.0, steps=8),
                 w * (i + 0.5) / 8.0 + self.rng.uniform(-40, 40), h + h * 0.06)

        # Cracks: jagged rivers of light, wider and hotter lower in the frame.
        for _ in range(22):
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
            ipts = [(int(a), int(b)) for a, b in pts]
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

    def _new_ember(self, y: Optional[float] = None) -> List[float]:
        return [self.rng.uniform(0, self.w),
                self.h + 8.0 if y is None else y,
                self.rng.uniform(22, 74),               # rise speed
                self.rng.uniform(2.5, 6.5),             # radius
                self.rng.uniform(0, TAU),               # sway phase
                float(self.rng.randrange(3))]           # colour index

    def _animate(self, dt: float) -> None:
        self.shimmer_y = (self.shimmer_y + 26.0 * dt) % self.tile
        for e in self.embers:
            e[1] -= e[2] * dt
            e[4] += dt * 1.7
            e[0] += math.sin(e[4]) * 16.0 * dt
            if e[1] < -10.0:
                e[:] = self._new_ember()

    def _paint(self, surface: pygame.Surface) -> None:
        surface.blit(self.shimmer, (self.ox, self.oy - self.tile + self.shimmer_y),
                     special_flags=pygame.BLEND_RGB_ADD)
        surface.blit(self.cracks, (self.ox, self.oy), special_flags=pygame.BLEND_RGB_ADD)

        # A wave of brightness sweeping the cracks, sold with a few hot streaks.
        wave = (self.t * 0.35) % 1.0
        _add(surface, _glow_sprite(int(self.w * 0.22), self.theme.accent, 0.30),
             self.ox + wave * self.w, self.oy + self.h * 0.86)

        for x, y, _sp, r, ph, ci in self.embers:
            k = 0.55 + 0.45 * math.sin(ph * 2.0)
            _add(surface, _glow_sprite(int(r * 3.0), self.ember_cols[int(ci)], 0.70 * k),
                 self.ox + x, self.oy + y)


# ==========================================================================
# 5. OCEAN - caustics, god rays and slow bubbles
# ==========================================================================
class OceanBackground(Background):
    def _build(self) -> None:
        th, w, h = self.theme, self.w, self.h
        self.tile = 384
        light = _mix(th.accent, th.accent2, 0.5)

        def caustic(u: float, v: float) -> RGB:
            # Three sine gratings at co-prime frequencies beat against each
            # other; the zero-crossings of their sum are thin wandering curves,
            # and (1 - |sum|)**10 lights exactly those - a water caustic.
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
        for i in range(5):
            rw = int(self.rng.uniform(w * 0.06, w * 0.14))
            surf = pygame.Surface((rw * 2, h))
            surf.fill((0, 0, 0))
            for yy in range(0, h, 3):
                f = (1.0 - yy / float(h)) ** 1.6
                half = rw * (0.35 + 0.65 * yy / float(h))
                surf.fill(P.shade(th.accent2, 0.09 * f),
                          (int(rw - half), yy, int(half * 2), 3))
            self.rays.append((_conv(surf), self.rng.uniform(0, w),
                              self.rng.uniform(0.12, 0.3), self.rng.uniform(0, TAU)))

        self.bubbles: List[List[float]] = [self._new_bubble(self.rng.uniform(0, h))
                                           for _ in range(38)]

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
        t_ = self.tile
        surface.blit(self.caustic_b, (self.ox - 256 + self.cb[0], self.oy - 256 + self.cb[1]),
                     special_flags=pygame.BLEND_RGB_ADD)
        surface.blit(self.caustic_a, (self.ox - t_ + self.ca[0], self.oy - t_ + self.ca[1]),
                     special_flags=pygame.BLEND_RGB_ADD)
        for surf, x0, speed, ph in self.rays:
            x = x0 + math.sin(self.t * speed + ph) * self.w * 0.06
            surface.blit(surf, (int(self.ox + x - surf.get_width() * 0.5), self.oy),
                         special_flags=pygame.BLEND_RGB_ADD)
        for x, y, _sp, r, ph in self.bubbles:
            _add(surface, _glow_sprite(int(r * 2.0), self.theme.accent2, 0.34),
                 self.ox + x, self.oy + y)
            pygame.draw.circle(surface, _mix(self._bg_at(y), self.theme.accent2, 0.55),
                               (int(self.ox + x), int(self.oy + y)), int(r), 1)


# ==========================================================================
# 6. STATIC - scanline noise and interference tearing
# ==========================================================================
class StaticBackground(Background):
    SPECKS = 430
    STREAKS = 34
    SCAN_PERIOD = 4

    def _build(self) -> None:
        th, w, h = self.theme, self.w, self.h
        self.speck_cols = [P.shade(th.accent, 0.75), P.shade(th.accent2, 0.70),
                           P.shade(th.text, 0.55), P.shade(th.grid, 1.4)]
        self.streak_col = P.shade(th.accent2, 0.30)
        self.tears: List[List[float]] = []
        self.tear_cd = 0.0
        self.bar_y = 0.0
        self.scan_off = 0.0
        self.sig_y = 0.0

        # Dead-channel signal: broad horizontal bands of grain that drift, so
        # the frame is never empty even between tears.
        self.sig_period = 256
        band_col = _mix(th.grid, th.accent2, 0.4)

        def band(u: float, v: float) -> RGB:
            k = (0.5 + 0.5 * math.sin(v * TAU * 2.0 + math.sin(u * TAU) * 0.6)) ** 3
            return P.shade(band_col, 0.30 * k)

        self.signal = _seamless_layer(w, h, self.sig_period, 32, band)

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

    def _animate(self, dt: float) -> None:
        self.bar_y = (self.bar_y + self.h * 0.28 * dt) % (self.h + 120.0)
        self.scan_off = (self.scan_off + 24.0 * dt) % float(self.SCAN_PERIOD)
        self.sig_y = (self.sig_y + 38.0 * dt) % self.sig_period
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

        surface.blit(self.signal, (ox - self.sig_period, int(oy - self.sig_period + self.sig_y)),
                     special_flags=pygame.BLEND_RGB_ADD)

        # Torn horizontal streaks: the smeared chunks of a lost signal.
        for _ in range(self.STREAKS):
            surface.fill(self.streak_col,
                         (ox + rng.randrange(w), oy + rng.randrange(h),
                          rng.randint(30, 260), rng.randint(1, 3)),
                         special_flags=pygame.BLEND_RGB_ADD)

        # Snow: sparse bright specks, redrawn every frame so it truly crawls.
        for _ in range(self.SPECKS):
            col = self.speck_cols[rng.randrange(4)]
            surface.fill(col, (ox + rng.randrange(w), oy + rng.randrange(h),
                               rng.randint(1, 6), 2))

        # Interference tears: displaced bands with a chromatic fringe.
        for y, bh, shift, life in self.tears:
            r = pygame.Rect(int(ox + shift), int(oy + y), w, int(bh))
            surface.fill(P.shade(th.accent2, 0.24), r, special_flags=pygame.BLEND_RGB_ADD)
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
    def _build(self) -> None:
        th, w, h = self.theme, self.w, self.h

        # Frost branches rooted on the arena edges, grown as recursive forks.
        self.branches: List[List[Tuple[float, float]]] = []
        for _ in range(46):
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
        self.frost_col = _mix(th.accent, th.text, 0.5)

        # Crystal sprites: one hexagonal shard, pre-rotated into 24 steps.
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
                [_conv(pygame.transform.rotate(proto, -360.0 * i / 24.0), True) for i in range(24)])

        self.crystals: List[List[float]] = []
        for _ in range(22):
            self.crystals.append([self.rng.uniform(0, w), self.rng.uniform(0, h),
                                  self.rng.uniform(-22, 22), self.rng.uniform(8, 30),
                                  self.rng.uniform(0, TAU), self.rng.uniform(-1.1, 1.1),
                                  float(self.rng.randrange(3))])

        vign = pygame.Surface((w, h))
        vign.fill((0, 0, 0))
        for i in range(9):                              # cold rim light
            f = (i + 1) / 9.0
            pygame.draw.rect(vign, P.shade(th.accent, 0.05 * f),
                             (i * 4, i * 4, w - i * 8, h - i * 8), 4)
        self.vignette = _conv(vign)

    def _grow(self, x: float, y: float, ang: float, length: float, depth: int) -> None:
        """One frost twig plus two children - classic recursive branching."""
        if depth <= 0 or length < 5.0:
            return
        ex = x + math.cos(ang) * length
        ey = y + math.sin(ang) * length
        self.branches.append([(x, y), (ex, ey)])
        for sign in (-1.0, 1.0):
            self._grow(ex, ey, ang + sign * self.rng.uniform(0.4, 0.9),
                       length * self.rng.uniform(0.5, 0.72), depth - 1)

    def _animate(self, dt: float) -> None:
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
        surface.blit(self.vignette, (self.ox, self.oy), special_flags=pygame.BLEND_RGB_ADD)

        # Frost "creeps": a slow breath decides how many twigs are visible.
        grow = 0.5 + 0.5 * math.sin(self.t * 0.24)
        shown = int(len(self.branches) * (0.35 + 0.65 * grow))
        col = P.shade(self.frost_col, 0.30 + 0.35 * grow)
        for i in range(shown):
            (ax, ay), (bx, by) = self.branches[i]
            pygame.draw.line(surface, col, (self.ox + ax, self.oy + ay),
                             (self.ox + bx, self.oy + by), 1)

        for x, y, _vx, _vy, ang, _sp, si in self.crystals:
            frames = self.crystal_frames[int(si)]
            img = frames[int(ang / TAU * 24.0) % 24]
            surface.blit(img, img.get_rect(center=(int(self.ox + x), int(self.oy + y))))
            _add(surface, _glow_sprite(14, self.theme.accent, 0.20), self.ox + x, self.oy + y)


# ==========================================================================
# 8. SPORES - bobbing drifting blobs over damp mist
# ==========================================================================
class SporeBackground(Background):
    COUNT = 46

    def _build(self) -> None:
        th, w, h = self.theme, self.w, self.h
        mist = pygame.Surface((w, h))
        mist.fill((0, 0, 0))
        for _ in range(18):
            _add(mist, _glow_sprite(int(self.rng.uniform(h * 0.14, h * 0.42)),
                                    P.shade(th.grid, self.rng.uniform(0.14, 0.30)), 1.0, steps=8),
                 self.rng.uniform(0, w), self.rng.uniform(h * 0.25, h * 1.05))
        self.mist = _conv(mist)
        self.mist_x = 0.0

        # Blob sprites: a soft core with a brighter membrane ring.
        self.blobs: List[pygame.Surface] = []
        for r in (5, 8, 12, 17, 23):
            d = r * 4
            s = pygame.Surface((d, d))
            s.fill((0, 0, 0))
            _add(s, _glow_sprite(int(r * 1.9), P.shade(th.accent, 0.24), 1.0, steps=10),
                 d * 0.5, d * 0.5)
            pygame.draw.circle(s, P.shade(th.accent2, 0.38), (d // 2, d // 2), r, 2)
            pygame.draw.circle(s, P.shade(th.accent, 0.55), (int(d * 0.44), int(d * 0.42)),
                               max(1, r // 4))
            self.blobs.append(_conv(s))

        self.spores: List[List[float]] = [self._new_spore(self.rng.uniform(0, h))
                                          for _ in range(self.COUNT)]
        self.pods = [(self.rng.uniform(0, w), h - self.rng.uniform(0, h * 0.12),
                      self.rng.uniform(10, 26), self.rng.uniform(0, TAU)) for _ in range(11)]

    def _new_spore(self, y: Optional[float] = None) -> List[float]:
        return [self.rng.uniform(0, self.w),
                self.h + 30.0 if y is None else y,
                self.rng.uniform(8, 26),                 # rise
                float(self.rng.randrange(5)),            # sprite index
                self.rng.uniform(0, TAU),                # bob phase
                self.rng.uniform(0.4, 1.2)]              # bob rate

    def _animate(self, dt: float) -> None:
        self.mist_x += 4.0 * dt
        for s in self.spores:
            s[1] -= s[2] * dt
            s[4] += s[5] * dt
            s[0] += math.sin(s[4] * 0.7) * 14.0 * dt
            if s[1] < -34.0:
                s[:] = self._new_spore()

    def _paint(self, surface: pygame.Surface) -> None:
        self._wrap_add(surface, self.mist, self.mist_x)
        for x, y, _r, si, ph, _rate in self.spores:
            bob = math.sin(ph) * 7.0                    # vertical bobbing
            _add(surface, self.blobs[int(si)], self.ox + x, self.oy + y + bob)
        for x, y, r, ph in self.pods:
            k = 0.45 + 0.55 * (0.5 + 0.5 * math.sin(self.t * 1.1 + ph))
            _add(surface, _glow_sprite(int(r * 2.2), self.theme.accent2, 0.22 * k),
                 self.ox + x, self.oy + y)


# ==========================================================================
# 9. MACHINE - silhouetted gears and sliding pistons
# ==========================================================================
class MachineBackground(Background):
    ROT_STEPS = 12

    def _build(self) -> None:
        th, w, h = self.theme, self.w, self.h
        body = P.with_alpha(_mix(th.bg_bottom, (0, 0, 0), 0.45), 238)
        rim = P.with_alpha(_mix(th.grid, th.accent, 0.55), 255)

        plate = pygame.Surface((w, h), pygame.SRCALPHA)
        for i in range(6):                               # riveted backing plates
            r = pygame.Rect(int(self.rng.uniform(-40, w - 120)),
                            int(self.rng.uniform(-40, h - 100)),
                            int(self.rng.uniform(160, 420)), int(self.rng.uniform(120, 320)))
            pygame.draw.rect(plate, P.with_alpha(_mix(th.bg_bottom, (0, 0, 0), 0.30), 150),
                             r, border_radius=8)
            pygame.draw.rect(plate, P.with_alpha(th.grid, 90), r, 2, border_radius=8)
            for bx in range(r.x + 12, r.right - 6, 34):
                pygame.draw.circle(plate, P.with_alpha(th.grid, 120), (bx, r.y + 12), 3)
                pygame.draw.circle(plate, P.with_alpha(th.grid, 120), (bx, r.bottom - 12), 3)
        self.plate = _conv(plate, True)

        self.gear_sets: List[List[pygame.Surface]] = []
        self.gear_teeth: List[int] = []
        for radius, teeth in ((58, 10), (92, 12), (128, 14)):
            self.gear_sets.append(self._gear_frames(radius, teeth, body, rim))
            self.gear_teeth.append(teeth)

        self.gears: List[List[float]] = []
        for _ in range(9):
            gi = self.rng.randrange(3)
            self.gears.append([self.rng.uniform(0, w), self.rng.uniform(0, h),
                               float(gi), self.rng.uniform(0, TAU),
                               self.rng.uniform(0.3, 1.0) * self.rng.choice((-1.0, 1.0))])

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

    def _gear_frames(self, radius: int, teeth: int, body, rim) -> List[pygame.Surface]:
        """Pre-rotate a gear over one tooth pitch - the rest is rotational symmetry."""
        d = radius * 2 + 10
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
        return [_conv(pygame.transform.rotate(proto, -pitch * i / self.ROT_STEPS), True)
                for i in range(self.ROT_STEPS)]

    def _animate(self, dt: float) -> None:
        for g in self.gears:
            g[3] += g[4] * dt

    def _paint(self, surface: pygame.Surface) -> None:
        surface.blit(self.plate, (self.ox, self.oy))

        for x, y, gi, ang, _sp in self.gears:
            frames = self.gear_sets[int(gi)]
            pitch = TAU / self.gear_teeth[int(gi)]
            idx = int((ang % pitch) / pitch * self.ROT_STEPS) % self.ROT_STEPS
            img = frames[idx]
            surface.blit(img, img.get_rect(center=(int(self.ox + x), int(self.oy + y))))

        for x, y, throw, rate, ph, vertical in self.pistons:
            s = math.sin(self.t * rate + ph) * throw * 0.5
            if vertical > 0.5:
                rod = pygame.Rect(int(self.ox + x - 9), int(self.oy + y - throw * 0.5 + s), 18,
                                  int(throw * 0.5 + 30))
            else:
                rod = pygame.Rect(int(self.ox + x - throw * 0.5 + s), int(self.oy + y - 9),
                                  int(throw * 0.5 + 30), 18)
            pygame.draw.rect(surface, self.piston_body, rod, border_radius=5)
            pygame.draw.rect(surface, self.piston_rim, rod, 2, border_radius=5)

        for x, y, ph in self.lamps:
            k = 0.5 + 0.5 * math.sin(self.t * 2.4 + ph)
            _add(surface, _glow_sprite(13, self.theme.accent, 0.20 + 0.4 * k),
                 self.ox + x, self.oy + y)


# ==========================================================================
# 10. AURORA - undulating vertical ribbon curtains
# ==========================================================================
class AuroraBackground(Background):
    SLICE = 8

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

        self.ribbons: List[List[float]] = []
        for i in range(6):
            self.ribbons.append([self.rng.uniform(-0.1, 1.1) * w,      # x
                                 self.rng.uniform(6.0, 24.0),          # drift speed
                                 self.rng.uniform(0, TAU),             # wave phase
                                 self.rng.uniform(0.35, 0.8),          # wave rate
                                 self.rng.uniform(0.012, 0.030),       # wave frequency
                                 float(i % 3)])                        # tint index
        self.stars = [(self.rng.uniform(0, w), self.rng.uniform(0, h * 0.7),
                       self.rng.uniform(0.3, 1.0), self.rng.uniform(0, TAU))
                      for _ in range(90)]
        self.star_col = th.text

        haze = pygame.Surface((w, h))
        haze.fill((0, 0, 0))
        for i in range(0, h // 3, 2):
            f = (i / float(max(1, h // 3))) ** 2
            haze.fill(P.shade(th.accent, 0.05 * f), (0, h - 1 - i, w, 2))
        self.haze = _conv(haze)

    def _animate(self, dt: float) -> None:
        for r in self.ribbons:
            r[0] += r[1] * dt
            if r[0] > self.w + self.ribbon_w:
                r[0] = -self.ribbon_w
            r[2] += r[3] * dt

    def _paint(self, surface: pygame.Surface) -> None:
        for x, y, amp, ph in self.stars:
            tw = 0.5 + 0.5 * math.sin(self.t * 1.8 + ph)
            surface.fill(P.shade(self.star_col, 0.55 * amp * tw),
                         (self.ox + int(x), self.oy + int(y), 1, 1))
        surface.blit(self.haze, (self.ox, self.oy), special_flags=pygame.BLEND_RGB_ADD)

        step = self.SLICE
        for x, _sp, ph, _rate, freq, ti in self.ribbons:
            strip = self.strips[int(ti)]
            for sx in range(0, self.ribbon_w, step):
                # Two out-of-step sines per column give the curtain its lazy,
                # non-repeating fold instead of a single rigid wobble.
                col_x = x + sx
                dy = (math.sin(col_x * freq + ph) * self.h * 0.15
                      + math.sin(col_x * freq * 2.3 - ph * 1.7) * self.h * 0.08)
                surface.blit(strip, (int(self.ox + col_x), int(self.oy + dy)),
                             (sx, 0, step, self.h), pygame.BLEND_RGB_ADD)


# ==========================================================================
# 11. VOIDWARP - concentric rings dragged toward a singularity
# ==========================================================================
class VoidWarpBackground(Background):
    RINGS = 17
    POINTS = 40
    STREAKS = 80

    def _build(self) -> None:
        th, w, h = self.theme, self.w, self.h
        self.max_r = math.hypot(w, h) * 0.62
        self.phase = 0.0
        self.streaks: List[List[float]] = [self._new_streak(self.rng.uniform(0.15, 1.0))
                                           for _ in range(self.STREAKS)]
        self.core_a = _glow_sprite(int(h * 0.16), th.accent, 0.75)
        self.core_b = _glow_sprite(int(h * 0.07), th.text, 0.95)
        self.ring_far = th.accent2
        self.ring_near = th.accent

    def _centre(self) -> Tuple[float, float]:
        """The singularity drifts a little so the field never looks pinned."""
        return (self.w * 0.5 + math.sin(self.t * 0.21) * self.w * 0.05,
                self.h * 0.5 + math.cos(self.t * 0.17) * self.h * 0.05)

    def _new_streak(self, r01: float = 1.0) -> List[float]:
        return [self.rng.uniform(0, TAU), r01 * self.max_r,
                self.rng.uniform(0.35, 1.0)]

    def _animate(self, dt: float) -> None:
        self.phase = (self.phase + dt * 0.22) % 1.0
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
        sx, sy = self.ox + cx, self.oy + cy

        for k in range(self.RINGS):
            # Rings accelerate inward: r ~ p**1.8 bunches them near the core.
            p = ((k + self.phase) / self.RINGS) % 1.0
            r = self.max_r * (p ** 1.8)
            if r < 8.0:
                continue
            f = 1.0 - p
            col = _mix(self._bg_at(cy), _mix(self.ring_far, self.ring_near, f),
                       clamp(0.25 + 0.75 * f, 0.0, 1.0))
            pts = []
            for i in range(self.POINTS):
                a = TAU * i / self.POINTS
                # Radial wobble + a tangential shear = the "warped" silhouette.
                wob = 1.0 + 0.10 * math.sin(a * 3.0 + self.t * 1.1 + k * 0.5) \
                          + 0.06 * math.sin(a * 5.0 - self.t * 0.7)
                rr = r * wob
                pts.append((sx + math.cos(a) * rr * 1.12, sy + math.sin(a) * rr * 0.88))
            try:
                pygame.draw.lines(surface, col, True, pts, 2 if f > 0.45 else 1)
            except Exception:
                pass

        streak_col = _mix(self.theme.text, self.theme.accent, 0.4)
        for a, r, spd in self.streaks:
            k = clamp(1.0 - r / self.max_r, 0.05, 1.0)
            tail = r + 26.0 * k * 3.0
            x1, y1 = sx + math.cos(a) * r, sy + math.sin(a) * r
            x2, y2 = sx + math.cos(a - 0.05) * tail, sy + math.sin(a - 0.05) * tail
            pygame.draw.line(surface, P.shade(streak_col, 0.25 + 0.75 * k),
                             (int(x1), int(y1)), (int(x2), int(y2)), 1)

        beat = 0.85 + 0.15 * math.sin(self.t * 3.1)
        _add(surface, self.core_a, sx, sy)
        _add(surface, self.core_b, sx, sy)
        pygame.draw.circle(surface, _mix(self.theme.accent, self.theme.text, 0.6),
                           (int(sx), int(sy)), int(self.h * 0.055 * beat), 2)


# ==========================================================================
# 12. PRISM - rotating refraction bands cycling hue
# ==========================================================================
class PrismBackground(Background):
    WEDGES = 15
    DIV = 3                       # low-res divisor for the soft light buffer

    def _build(self) -> None:
        th, w, h = self.theme, self.w, self.h
        self.spin = 0.0
        self.hue = 0.0
        lo = self._lo_surface(self.DIV)
        self.lw, self.lh = lo.get_width(), lo.get_height()
        self.reach = math.hypot(self.lw, self.lh)

        # A static lattice of faint refraction arcs sits under the beams.
        lat = pygame.Surface((w, h))
        lat.fill((0, 0, 0))
        for i in range(9):
            r = int(h * (0.16 + i * 0.11))
            pygame.draw.circle(lat, P.shade(th.grid, 0.55), (w // 2, h // 2), r, 1)
        for i in range(12):
            a = TAU * i / 12
            pygame.draw.line(lat, P.shade(th.grid, 0.35), (w // 2, h // 2),
                             (w // 2 + math.cos(a) * w, h // 2 + math.sin(a) * w), 1)
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
        _add(fall, _glow_sprite(int(self.lh * 0.62), (238, 238, 238), 1.0, steps=18),
             self.lw * 0.5, self.lh * 0.5)
        self.falloff = _conv(fall)
        self.shards = [(self.rng.uniform(0, TAU), self.rng.uniform(h * 0.22, h * 0.48),
                        self.rng.uniform(0.10, 0.35), self.rng.uniform(16, 42))
                       for _ in range(7)]

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
        for i in range(self.WEDGES):
            a0 = self.spin + span * i
            # Each wedge breathes independently so the fan never looks rigid.
            width = span * (0.26 + 0.28 * (0.5 + 0.5 * math.sin(self.t * 0.8 + i)))
            col = P.shade(P.rainbow(self.hue + i / float(self.WEDGES), 0.85, 1.0), 0.55)
            pygame.draw.polygon(lo, col, [
                (cx, cy),
                (cx + math.cos(a0) * self.reach, cy + math.sin(a0) * self.reach),
                (cx + math.cos(a0 + width) * self.reach, cy + math.sin(a0 + width) * self.reach),
            ])
        lo.blit(self.falloff, (0, 0), special_flags=pygame.BLEND_RGB_MULT)
        self._blit_lo(surface, blur=True)

        surface.blit(self.lattice, (self.ox, self.oy), special_flags=pygame.BLEND_RGB_ADD)
        _add(surface, self.core, self.ox + self.w * 0.5, self.oy + self.h * 0.5)

        # Free-floating shards catching the light on their edges.
        scx, scy = self.ox + self.w * 0.5, self.oy + self.h * 0.5
        for a0, orb, rate, size in self.shards:
            a = a0 + self.t * rate
            x, y = scx + math.cos(a) * orb, scy + math.sin(a) * orb * 0.8
            spin = self.t * (0.6 + rate)
            pts = [(x + math.cos(spin + TAU * k / 3) * size,
                    y + math.sin(spin + TAU * k / 3) * size) for k in range(3)]
            pygame.draw.polygon(surface, P.shade(P.rainbow(self.hue + a0, 0.7, 0.95), 0.6),
                                pts, 2)


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
