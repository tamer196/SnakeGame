"""
Core neon drawing primitives for NEON SERPENT.

Everything that glows in this game goes through :func:`glow_surface`, so that
function is the single hottest path in the renderer.  It is therefore
*aggressively* cached: radius, colour and intensity are quantised into coarse
buckets and each bucket's radial-falloff sprite is built exactly once.  A frame
with 400 glow blits then costs 400 ``Surface.blit`` calls and zero allocations.

Additive blending note: ``pygame.BLEND_RGB_ADD`` ignores the source alpha
channel entirely - only RGB is summed into the destination.  Every cached glow
sprite therefore bakes its falloff into the *colour* (``colour * falloff``)
rather than into alpha, and untouched pixels stay at RGB ``(0, 0, 0)`` so they
add nothing.  Alpha is filled in too, so the sprites still look sane if blitted
normally.  The same property is what makes ``BLEND_RGB_SUB`` usable for the
contact shadow under a cross-over: it subtracts a radial falloff and leaves the
destination alpha alone, which matters on the translucent ghost layer.

Snake rendering in one paragraph
--------------------------------
The body is a polyline from head (index 0) to tail tip.  Per point we derive a
unit tangent, a left normal and a signed curvature; the curvature drives the
*banking* offset (each point slides toward the inside of its own turn) and the
brightness split of the scale plates.  The body is then painted **tail first**
in two chunks - everything behind the neck, then the neck and head - with the
cross-over decoration stamped in between.  That ordering is what makes the head
visibly pass *over* its own body rather than through it: the crossed segment is
already on the canvas, it gets a soft subtractive contact shadow plus a bright
contact rim, and the head-end is painted on top of both.

Public API::

    glow_surface(radius, color, intensity=1.0) -> pygame.Surface
    disc_surface(radius, color, intensity=1.0) -> pygame.Surface
    draw_glow_circle(surface, x, y, radius, color, intensity=1.0)
    draw_snake(surface, snake, theme, t, *, ghost=False, shield=False,
               crossing=None)
    draw_arena(surface, rect, theme, t)
    draw_food_orb(surface, x, y, r, color, t, kind="normal")
    clear_caches()

No function here may raise: a renderer that throws takes the whole frame with
it, so every public entry point swallows and ignores failures.
"""

from __future__ import annotations

import math
from typing import TYPE_CHECKING, Any, Dict, List, Optional, Sequence, Tuple

import pygame

from .. import config as C
from .. import palette as P
from ..core.contracts import TAU, clamp, dist, lerp, pulse

if TYPE_CHECKING:  # pragma: no cover - typing only
    from ..core.snake import Snake

RGB = Tuple[int, int, int]
Vec2 = Tuple[float, float]

WHITE: RGB = (255, 255, 255)

# --------------------------------------------------------------------------
# Cache tuning
# --------------------------------------------------------------------------
_GLOW_RADIUS_STEP = 2.5      # radii are rounded up to a multiple of this
_GLOW_MAX_RADIUS = 340.0     # anything bigger is clamped (keeps memory sane)
_GLOW_INTENSITY_STEPS = 8    # intensity buckets per 1.0 of intensity
_GLOW_MAX_INTENSITY = 3.0
_COLOR_QUANT = 4             # bits dropped per channel -> 16 levels each

# The limit is generous on purpose: a level uses one theme, so the working set
# is a few hundred sprites and eviction should essentially never fire.  When it
# does fire it must not thrash, hence the headroom.
_GLOW_CACHE: Dict[Tuple[int, int, int], pygame.Surface] = {}
_GLOW_CACHE_LIMIT = 1600

_FLARE_CACHE: Dict[Tuple[int, int, int], pygame.Surface] = {}
_FLARE_CACHE_LIMIT = 120

_FRAME_CACHE: Dict[Tuple[int, int, int, int], pygame.Surface] = {}
_FRAME_CACHE_LIMIT = 8

_DISC_CACHE: Dict[Tuple[int, int, int], pygame.Surface] = {}
_DISC_CACHE_LIMIT = 160

# Reusable off-screen layers, keyed by size.  Used for the translucent "ghost"
# snake so we never allocate a full-screen surface inside the draw loop.
_SCRATCH: Dict[Tuple[int, int], pygame.Surface] = {}

GHOST_ALPHA = 116            # 0..255 opacity applied to a phased-out snake

# --------------------------------------------------------------------------
# Snake styling knobs
# --------------------------------------------------------------------------
#: How far a body point slides toward the inside of its own turn, as a
#: fraction of that point's radius.  Small on purpose: the drawn body must stay
#: honest about where the collision circles actually are.
BANK_STRENGTH = 0.34

#: Banking is faded in over this many segments so the head itself is drawn
#: exactly on the simulated head position.
BANK_RAMP = 4.0

#: Segments counted as "the head end" for cross-over layering.  Everything with
#: a higher index is painted first, so the neck and head land on top of it.
FRONT_SPAN = 9

#: At most this many overpasses are decorated per frame.  Two or three is all
#: that is ever visible at once and the cap keeps the scan bounded.
MAX_CROSSINGS = 3

#: Target number of scale plates drawn along the body, whatever its length.
SCALE_PLATE_TARGET = 26

#: Colour subtracted (radially) under a cross-over.  Deliberately neutral so it
#: darkens the crossed segment rather than tinting it.
SHADOW_COLOR: RGB = (104, 116, 146)

#: Hot colour mixed into the neck while boosting.
EXHAUST_COLOR: RGB = (255, 196, 96)

_BLINK_PERIOD = 3.7          # seconds between blinks
_BLINK_WIDTH = 0.05          # fraction of the period the lids are moving

#: Unit skull outline in head-local space: +u is forward along the heading,
#: +v is to the left of it.  Nose first, then clockwise on screen.
_SKULL: Tuple[Vec2, ...] = (
    (1.30, 0.00),
    (1.20, 0.30),
    (0.92, 0.58),
    (0.34, 0.80),
    (-0.30, 0.78),
    (-0.86, 0.46),
    (-1.04, 0.00),
    (-0.86, -0.46),
    (-0.30, -0.78),
    (0.34, -0.80),
    (0.92, -0.58),
    (1.20, -0.30),
)

#: The jaw: a shallow wedge hanging under the front of the skull.
_JAW: Tuple[Vec2, ...] = (
    (1.16, 0.00),
    (0.86, 0.34),
    (0.16, 0.44),
    (-0.24, 0.20),
    (-0.24, -0.20),
    (0.16, -0.44),
    (0.86, -0.34),
)


def clear_caches() -> None:
    """Drop every cached surface (useful on resolution / theme churn)."""
    _GLOW_CACHE.clear()
    _FLARE_CACHE.clear()
    _FRAME_CACHE.clear()
    _DISC_CACHE.clear()
    _SCRATCH.clear()


# ==========================================================================
# Tiny internal helpers
# ==========================================================================
def _ip(p: Sequence[float]) -> Tuple[int, int]:
    """Integer pixel coordinate for a float point."""
    return (int(p[0]), int(p[1]))


def _attr_rgb(c: Sequence[int]) -> RGB:
    """Coerce a colour-ish sequence to a plain int RGB triple."""
    return (int(c[0]), int(c[1]), int(c[2]))


def _cbucket(color: Sequence[int]) -> int:
    """Pack an RGB colour into a coarse 12-bit cache key."""
    try:
        r = P.clamp8(color[0]) >> _COLOR_QUANT
        g = P.clamp8(color[1]) >> _COLOR_QUANT
        b = P.clamp8(color[2]) >> _COLOR_QUANT
    except Exception:
        return 0xFFF
    return (r << 8) | (g << 4) | b


def _unbucket(key: int) -> RGB:
    """Reconstruct a representative colour from a bucket key (0x0..0xF -> 0..255)."""
    r = (key >> 8) & 0xF
    g = (key >> 4) & 0xF
    b = key & 0xF
    return (r * 17, g * 17, b * 17)


def _trim(cache: Dict[Any, Any], limit: int) -> None:
    """Evict oldest entries (dicts keep insertion order) until under `limit`."""
    while len(cache) > limit:
        try:
            cache.pop(next(iter(cache)))
        except StopIteration:  # pragma: no cover - defensive
            break


def _scratch(size: Tuple[int, int]) -> pygame.Surface:
    """A persistent per-pixel-alpha layer of the given size."""
    surf = _SCRATCH.get(size)
    if surf is None:
        surf = pygame.Surface(size, pygame.SRCALPHA)
        _SCRATCH.clear()          # only ever one canvas size in practice
        _SCRATCH[size] = surf
    return surf


def _to_rect(rect: Any) -> pygame.Rect:
    """Accept a pygame.Rect, a contracts.Rect or a 4-tuple."""
    if isinstance(rect, pygame.Rect):
        return rect
    try:
        return pygame.Rect(int(rect.x), int(rect.y), int(rect.w), int(rect.h))
    except Exception:
        pass
    try:
        x, y, w, h = rect  # type: ignore[misc]
        return pygame.Rect(int(x), int(y), int(w), int(h))
    except Exception:
        return pygame.Rect(*C.ARENA_RECT)


def _body_color(theme: Any, u: float) -> RGB:
    """theme.body_at with a defensive fallback for duck-typed themes."""
    try:
        return theme.body_at(u)
    except Exception:
        try:
            return P.lerp_color(theme.snake_a, theme.snake_b, u)
        except Exception:
            return (200, 220, 255)


def _attr(obj: Any, name: str, default: Any) -> Any:
    try:
        value = getattr(obj, name)
    except Exception:
        return default
    return default if value is None else value


def _fnum(value: Any, default: float = 0.0) -> float:
    """float() that never raises and never returns NaN / inf."""
    try:
        f = float(value)
    except Exception:
        return default
    return f if math.isfinite(f) else default


def _c(col: Sequence[int], alpha: int) -> Tuple[int, ...]:
    """
    Attach `alpha` to a draw colour when rendering into an alpha layer.

    ``pygame.draw.*`` *writes* the colour rather than blending it, so an
    explicit alpha here gives uniform translucency across overlapping strokes
    for free - far cheaper than a BLEND_RGBA_MULT pass over the whole box
    (measured at ~3.5 ms for a 1000x500 region versus ~0 ms for this).
    """
    if alpha >= 255:
        return (int(col[0]), int(col[1]), int(col[2]))
    return (int(col[0]), int(col[1]), int(col[2]), alpha)


# ==========================================================================
# Glow primitives
# ==========================================================================
def _build_glow(radius: int, color: RGB, intensity: float) -> pygame.Surface:
    """
    Render one radial glow sprite.

    The falloff is drawn as a stack of concentric filled circles going from the
    outside in, each a little brighter than the last.  `u` runs 0 at the rim to
    1 at the centre; brightness ``u^2 * (0.35 + 0.65u)`` sits between a squared
    and a cubed falloff, which reads as a soft halo with a hot core - the
    classic neon look - without the flat plateau a pure gaussian gives.
    """
    size = max(2, radius * 2)
    surf = pygame.Surface((size, size), pygame.SRCALPHA)
    centre = (radius, radius)
    steps = int(clamp(radius * 1.35, 10.0, 60.0))
    r0, g0, b0 = color
    for i in range(steps):
        u = i / float(steps)                     # 0 at the rim, ->1 at the core
        rr = radius * (1.0 - u)
        if rr < 1.0:
            break
        f = u * u * (0.35 + 0.65 * u) * intensity
        if f <= 0.0:
            continue
        col = (P.clamp8(r0 * f), P.clamp8(g0 * f), P.clamp8(b0 * f), P.clamp8(255.0 * f))
        pygame.draw.circle(surf, col, centre, int(rr))
    # A tiny solid core keeps very small glows from vanishing entirely.
    core = P.clamp8(255.0 * min(1.0, intensity))
    pygame.draw.circle(surf, (P.clamp8(r0 * intensity), P.clamp8(g0 * intensity),
                              P.clamp8(b0 * intensity), core),
                       centre, max(1, int(radius * 0.12)))
    return surf


def glow_surface(radius: float, color: Sequence[int], intensity: float = 1.0) -> pygame.Surface:
    """
    A cached, additive-ready radial glow sprite of diameter ``2*radius``.

    Radius, colour and intensity are quantised into buckets, so a caller that
    animates any of them smoothly still hits the cache almost every frame.
    """
    try:
        r = float(radius)
    except Exception:
        r = 1.0
    if not math.isfinite(r) or r <= 0.0:
        r = 1.0
    r = min(r, _GLOW_MAX_RADIUS)

    try:
        inten = float(intensity)
    except Exception:
        inten = 1.0
    if not math.isfinite(inten):
        inten = 1.0
    inten = clamp(inten, 0.02, _GLOW_MAX_INTENSITY)

    rb = max(1, int(math.ceil(r / _GLOW_RADIUS_STEP)))
    cb = _cbucket(color)
    ib = max(1, int(round(inten * _GLOW_INTENSITY_STEPS)))
    key = (rb, cb, ib)

    surf = _GLOW_CACHE.get(key)
    if surf is None:
        surf = _build_glow(int(rb * _GLOW_RADIUS_STEP),
                           _unbucket(cb),
                           ib / float(_GLOW_INTENSITY_STEPS))
        _GLOW_CACHE[key] = surf
        _trim(_GLOW_CACHE, _GLOW_CACHE_LIMIT)
    return surf


def _add_blit(surface: pygame.Surface, src: pygame.Surface,
              cx: float, cy: float, blend: int) -> None:
    """Blit a square sprite centred on (cx, cy) with the given blend flag."""
    half = src.get_width() * 0.5
    surface.blit(src, (int(cx - half), int(cy - half)), special_flags=blend)


def draw_glow_circle(surface: pygame.Surface, x: float, y: float, radius: float,
                     color: Sequence[int], intensity: float = 1.0,
                     *, blend: int = pygame.BLEND_RGB_ADD) -> None:
    """Stamp a cached additive glow centred on (x, y)."""
    try:
        _add_blit(surface, glow_surface(radius, color, intensity), x, y, blend)
    except Exception:
        pass


def disc_surface(radius: float, color: Sequence[int],
                 intensity: float = 1.0) -> pygame.Surface:
    """
    A cached soft-edged *disc* - flat in the middle, feathered at the rim.

    :func:`glow_surface` concentrates all its energy in the centre, which is
    exactly wrong for a contact shadow: the middle of the shadow is hidden
    under the thing casting it, so all the visible falloff would be the weak
    tail of the curve.  This sprite instead holds full strength out to 55% of
    the radius and feathers from there, so the part that peeks out from under
    the head is still dark.  Same additive convention: strength is baked into
    RGB, so it can be blitted with BLEND_RGB_ADD or BLEND_RGB_SUB.
    """
    r = _fnum(radius, 1.0)
    if r <= 0.0:
        r = 1.0
    r = min(r, 160.0)
    inten = clamp(_fnum(intensity, 1.0), 0.02, 2.0)
    rb = max(2, int(math.ceil(r / 3.0)))
    cb = _cbucket(color)
    ib = max(1, int(round(inten * 10.0)))
    key = (rb, cb, ib)
    surf = _DISC_CACHE.get(key)
    if surf is not None:
        return surf

    R = rb * 3
    inten = ib / 10.0
    surf = pygame.Surface((R * 2, R * 2), pygame.SRCALPHA)
    r0, g0, b0 = _unbucket(cb)
    steps = int(clamp(R * 0.9, 8.0, 34.0))
    for i in range(steps):
        u = i / float(steps)                    # 0 at the rim, ->1 at the core
        rr = R * (1.0 - u)
        if rr < 1.0:
            break
        f = clamp(u / 0.45, 0.0, 1.0) * inten
        if f <= 0.0:
            continue
        surf_col = (P.clamp8(r0 * f), P.clamp8(g0 * f), P.clamp8(b0 * f),
                    P.clamp8(255.0 * f))
        pygame.draw.circle(surf, surf_col, (R, R), int(rr))
    _DISC_CACHE[key] = surf
    _trim(_DISC_CACHE, _DISC_CACHE_LIMIT)
    return surf


def _flare_surface(radius: float, color: Sequence[int], arms: int = 4) -> pygame.Surface:
    """
    A cached star sparkle: `arms` tapered spikes plus a bright core.

    Built additively (brightness baked into RGB) so it can be blitted with
    BLEND_RGB_ADD like every other glow sprite.
    """
    rb = max(2, int(math.ceil(float(radius) / 3.0)))
    cb = _cbucket(color)
    key = (rb, cb, int(arms))
    surf = _FLARE_CACHE.get(key)
    if surf is not None:
        return surf

    R = rb * 3
    size = R * 2
    surf = pygame.Surface((size, size), pygame.SRCALPHA)
    col = _unbucket(cb)
    cx = cy = R
    # Each arm is drawn three times with shrinking width and rising brightness,
    # which fakes a smooth taper far more cheaply than a real gradient polygon.
    for a in range(arms):
        ang = a * (TAU / arms)
        ex = cx + math.cos(ang) * (R - 1)
        ey = cy + math.sin(ang) * (R - 1)
        for width, f in ((5, 0.22), (3, 0.45), (1, 0.95)):
            c = (P.clamp8(col[0] * f), P.clamp8(col[1] * f), P.clamp8(col[2] * f), 255)
            pygame.draw.line(surf, c, (cx, cy), (int(ex), int(ey)), width)
    surf.blit(glow_surface(R * 0.42, col, 0.85), (int(cx - R * 0.42), int(cy - R * 0.42)),
              special_flags=pygame.BLEND_RGB_ADD)
    _FLARE_CACHE[key] = surf
    _trim(_FLARE_CACHE, _FLARE_CACHE_LIMIT)
    return surf


# ==========================================================================
# Snake - geometry
# ==========================================================================
def _snake_geometry(snake: "Snake") -> Tuple[List[Vec2], List[float]]:
    """
    Flatten a Snake into (points, radii), index 0 = head.

    `segments` may or may not repeat the head position as its first entry, so a
    duplicate within a pixel of the head is dropped.  Radii come from
    ``radius_at`` when it cooperates and from a config-driven taper otherwise.
    """
    hx, hy = snake.head_pos()
    pts: List[Vec2] = [(float(hx), float(hy))]
    for seg in _attr(snake, "segments", ()):
        try:
            sx, sy = float(seg[0]), float(seg[1])
        except Exception:
            continue
        if len(pts) == 1 and dist(pts[0][0], pts[0][1], sx, sy) < 1.0:
            continue                      # segments[0] is just the head again
        pts.append((sx, sy))

    n = len(pts)
    denom = float(max(1, n - 1))
    radii: List[float] = []
    radius_at = getattr(snake, "radius_at", None)
    ok = callable(radius_at)
    for i in range(n):
        r = 0.0
        if ok:
            try:
                r = float(radius_at(i))
            except Exception:
                ok = False
                r = 0.0
        if not (math.isfinite(r) and r > 0.5):
            # Fallback taper: head radius -> body radius -> tail radius.
            u = i / denom
            r = (lerp(C.SNAKE_HEAD_RADIUS, C.SNAKE_BODY_RADIUS, min(1.0, u * 4.0))
                 if u < 0.25 else
                 lerp(C.SNAKE_BODY_RADIUS, C.SNAKE_TAIL_RADIUS, (u - 0.25) / 0.75))
        radii.append(max(1.5, r))
    return pts, radii


def _frames(pts: List[Vec2], heading: float) -> Tuple[List[Vec2], List[float]]:
    """
    Per-point unit left-normal and signed curvature for a body polyline.

    The tangent at point *i* is the direction from *i+1* toward *i-1* (i.e.
    forward along travel).  Curvature is the 2-D cross product of the tangents
    on either side of the point, which is ``sin(turn angle)`` - already in
    -1..1, already signed, and it costs no extra square roots because the
    tangents are unit vectors.
    """
    n = len(pts)
    fx, fy = math.cos(heading), math.sin(heading)
    tans: List[Vec2] = [(fx, fy)] * n
    for i in range(n):
        a = pts[i - 1] if i > 0 else pts[0]
        b = pts[i + 1] if i + 1 < n else pts[n - 1]
        dx, dy = a[0] - b[0], a[1] - b[1]
        m = dx * dx + dy * dy
        if m > 1e-8:
            inv = 1.0 / math.sqrt(m)
            tans[i] = (dx * inv, dy * inv)
        elif i > 0:
            tans[i] = tans[i - 1]

    normals: List[Vec2] = [(0.0, 0.0)] * n
    curv: List[float] = [0.0] * n
    for i in range(n):
        tx, ty = tans[i]
        normals[i] = (-ty, tx)                 # 90 degrees to the left
        if 0 < i < n - 1:
            ax, ay = tans[i + 1]
            bx, by = tans[i - 1]
            curv[i] = clamp(ax * by - ay * bx, -1.0, 1.0)
    if n > 2:
        curv[0] = curv[1]
        curv[n - 1] = curv[n - 2]
    return normals, curv


def _bank_points(pts: List[Vec2], radii: List[float], normals: List[Vec2],
                 curv: List[float], turn: float) -> Tuple[List[Vec2], List[float]]:
    """
    Slide every point toward the inside of its own turn.

    The head is never moved (the ramp is zero there) so the drawn head still
    sits exactly on the simulated collision point; the lean fades in over the
    first `BANK_RAMP` segments and is blended with the snake's own steering
    signal near the neck, which is what makes a hairpin look like the creature
    is throwing its weight into the corner instead of tracing a wire.
    """
    n = len(pts)
    out: List[Vec2] = [(0.0, 0.0)] * n
    lean: List[float] = [0.0] * n
    for i in range(n):
        ramp = clamp(i / BANK_RAMP, 0.0, 1.0)
        k = curv[i] * 3.4
        if i < 8:
            # Near the head the polyline has barely bent yet, so the steering
            # input leads the geometry - use it or the lean arrives late.
            k = lerp(turn, k, i / 8.0)
        k = clamp(k, -1.0, 1.0)
        lean[i] = k
        off = k * ramp * radii[i] * BANK_STRENGTH
        nx, ny = normals[i]
        out[i] = (pts[i][0] + nx * off, pts[i][1] + ny * off)
    return out, lean


def _find_crossings(pts: List[Vec2], radii: List[float],
                    skip: int) -> List[Tuple[int, float, float, float]]:
    """
    Locate places where the head end lies on top of a distant body segment.

    Returns ``(front_index, crossed_x, crossed_y, depth)`` tuples, at most
    `MAX_CROSSINGS` of them, where *depth* is the 0..1 overlap of the two
    circles.  The scan samples a handful of front points against every other
    rear segment, with a cheap axis-aligned reject first, so the cost is a few
    hundred float compares even on a 400-segment snake.
    """
    n = len(pts)
    out: List[Tuple[int, float, float, float]] = []
    if n <= skip + 2:
        return out
    for f in (0, 2, 4, 6):
        if f >= skip:
            break
        fx, fy = pts[f]
        rf = radii[f]
        best = 0.0
        bx = by = 0.0
        j = skip
        while j < n:
            sx, sy = pts[j]
            dx = sx - fx
            if dx < 0.0:
                dx = -dx
            rr = rf + radii[j]
            if dx <= rr:
                dy = sy - fy
                if dy < 0.0:
                    dy = -dy
                if dy <= rr:
                    d2 = dx * dx + dy * dy
                    if d2 < rr * rr:
                        depth = 1.0 - math.sqrt(d2) / rr
                        if depth > best:
                            best, bx, by = depth, sx, sy
            j += 2
        if best > 0.0:
            out.append((f, bx, by, best))
            if len(out) >= MAX_CROSSINGS:
                break
    return out


# ==========================================================================
# Snake - painting context
# ==========================================================================
class _Ctx:
    """Everything the per-range painters need, resolved once per snake."""

    __slots__ = ("pts", "radii", "cols", "rims", "body", "normals", "lean",
                 "n", "alpha", "gi", "blend", "t", "accent", "accent2",
                 "head_col", "plate_step", "speed", "boosting", "hot")

    def __init__(self) -> None:
        self.pts: List[Vec2] = []
        self.radii: List[float] = []
        self.cols: List[RGB] = []
        self.rims: List[Tuple[int, ...]] = []
        self.body: List[Tuple[int, ...]] = []
        self.normals: List[Vec2] = []
        self.lean: List[float] = []
        self.n = 0
        self.alpha = 255
        self.gi = 1.0
        self.blend = pygame.BLEND_RGB_ADD
        self.t = 0.0
        self.accent: RGB = (120, 220, 255)
        self.accent2: RGB = (200, 160, 255)
        self.head_col: RGB = WHITE
        self.plate_step = 3
        self.speed = 0.0
        self.boosting = False
        self.hot: RGB = EXHAUST_COLOR


def _paint_range(surface: pygame.Surface, cx: _Ctx, i_from: int, i_to: int) -> None:
    """
    Paint body points `i_from` down to `i_to` (inclusive), tail-most first.

    Four sub-passes: the bright rim shell that defines the silhouette, the
    gradient interior inset inside it, the hot spine seam, and the scale
    plates.  Splitting the body into two ranges and calling this twice is what
    gives the cross-over its depth ordering.
    """
    if i_from < i_to:
        return
    pts, radii, rims, body = cx.pts, cx.radii, cx.rims, cx.body
    alpha, blend, gi, t = cx.alpha, cx.blend, cx.gi, cx.t
    n = cx.n

    # ---- rim shell ------------------------------------------------------
    for i in range(i_from, i_to - 1, -1):
        r = radii[i]
        if i > 0:
            w = max(1, int(min(r, radii[i - 1]) * 2.0))
            pygame.draw.line(surface, rims[i], _ip(pts[i]), _ip(pts[i - 1]), w)
        pygame.draw.circle(surface, rims[i], _ip(pts[i]), max(1, int(r)))

    # ---- gradient interior, inset by the rim width -----------------------
    for i in range(i_from, i_to - 1, -1):
        r = radii[i]
        rim_w = clamp(r * 0.22, 1.4, 3.0)
        inner = r - rim_w
        if inner < 1.0:
            continue
        if i > 0:
            w = max(1, int((min(inner, radii[i - 1] - rim_w)) * 2.0))
            pygame.draw.line(surface, body[i], _ip(pts[i]), _ip(pts[i - 1]), w)
        pygame.draw.circle(surface, body[i], _ip(pts[i]), max(1, int(inner)))

    # ---- hot inner line along the spine ----------------------------------
    # The phase term `i * 0.52 - t * 7` makes the bright band drift toward the
    # tail, which reads as energy being flushed backwards down the body.
    head_col = cx.head_col
    accent = cx.accent
    for i in range(i_from, i_to - 1, -1):
        r = radii[i]
        if r < 3.0:
            continue
        s = 0.5 + 0.5 * math.sin(i * 0.52 - t * 7.0)
        bright = P.lerp_color(cx.cols[i], head_col, 0.30 + 0.45 * s)
        core = _c(P.lerp_color(bright, WHITE, 0.30 * s), alpha)
        if i > 0:
            pygame.draw.line(surface, core, _ip(pts[i]), _ip(pts[i - 1]),
                             max(1, int(r * 0.46)))
        pygame.draw.circle(surface, core, _ip(pts[i]), max(1, int(r * 0.36)))
        if s > 0.72 and (i & 1) == 0:
            _add_blit(surface, glow_surface(r * 2.1, accent, 0.60 * s * gi),
                      pts[i][0], pts[i][1], blend)

    # ---- overlapping scale plates ---------------------------------------
    # A chevron pointing head-ward at every `plate_step`-th point.  Walked
    # tail-first so each plate overlaps the one behind it, and the two halves
    # are drawn separately so the outer edge of a turn can be lit brighter than
    # the inner one - that asymmetry is most of what sells the bank.
    step = cx.plate_step
    i = i_from - (i_from % step)
    while i >= i_to:
        if i < 1 or i >= n - 1:
            i -= step
            continue
        if r < 7.0:
            # Down at tail radius a chevron is only a few pixels wide and reads
            # as a barb rather than a plate, so the taper simply loses them.
            i -= step
            continue
        px, py = pts[i]
        nx, ny = cx.normals[i]
        ax, ay = pts[i - 1]
        # Forward direction taken straight from the neighbour, no sqrt needed
        # beyond the one hidden in the normal we already have.  The chevron is
        # kept well inside the rim: pushed out to the silhouette it stops
        # reading as a plate and starts reading as a thorn.
        mx = px + (ax - px) * 0.42
        my = py + (ay - py) * 0.42
        e = r * 0.60
        left = (px + nx * e, py + ny * e)
        right = (px - nx * e, py - ny * e)
        base = cx.cols[i]
        k = cx.lean[i]
        # k > 0 means the point leaned to the left, so the *right* flank is the
        # outside of the turn and catches the light.
        lb = 0.26 - 0.20 * k
        rb = 0.26 + 0.20 * k
        pw = 1 if r < 8.0 else 2
        pygame.draw.line(surface, _c(P.lerp_color(base, WHITE, clamp(lb, 0.04, 0.62)), alpha),
                         _ip(left), _ip((mx, my)), pw)
        pygame.draw.line(surface, _c(P.lerp_color(base, WHITE, clamp(rb, 0.04, 0.62)), alpha),
                         _ip(right), _ip((mx, my)), pw)
        i -= step


def _draw_crossings(surface: pygame.Surface, cx: _Ctx,
                    crossings: List[Tuple[int, float, float, float]],
                    punch: float) -> None:
    """
    Stamp the overpass decoration onto the already-painted rear body.

    Two marks per crossing.  First a *subtractive* soft disc centred on the
    contact point and nudged away from the light, so the crossed tube goes dark
    in a band wide enough to still be visible either side of the head - that is
    why it uses :func:`disc_surface` and not :func:`glow_surface`, whose energy
    all sits in the middle where the head would hide it.  Then a contact rim:
    an over-wide bright capsule laid along the *front* tube across the crossing
    span.  The front tube is repainted at its true width a moment later, so
    what survives is a couple of pixels of edge-light outlining the head end
    exactly where it sits on top of the body - the same read as a bridge deck
    catching light against the road underneath.
    """
    if not crossings:
        return
    accent = cx.accent
    gi = cx.gi
    n = cx.n
    pts = cx.pts
    # Subtracting a neutral grey from a saturated neon tube leaves an ugly
    # complementary cast, so the shadow is tinted toward the body's own hue -
    # then the subtraction just removes brightness.
    shadow_col = P.lerp_color(SHADOW_COLOR, cx.cols[n // 2], 0.60)
    for f, bx, by, depth in crossings:
        r = cx.radii[f]
        d = clamp(depth, 0.0, 1.0)
        fx, fy = pts[f]
        mx, my = (fx + bx) * 0.5, (fy + by) * 0.5
        # Offset "down-right" of the contact so this is a cast shadow rather
        # than a symmetric smudge.
        _add_blit(surface,
                  disc_surface(r * (2.1 + 0.5 * d), shadow_col,
                               (0.52 + 0.30 * d) * (0.72 + 0.28 * punch)),
                  mx + r * 0.36, my + r * 0.42, pygame.BLEND_RGB_SUB)

        rim_c = _c(P.lerp_color(accent, WHITE, 0.18 + 0.24 * punch), cx.alpha)
        lo = max(0, f - 1)
        hi = min(n - 1, f + 3)
        halo = 2.2 + 1.4 * punch
        for i in range(hi, lo, -1):
            w = int((min(cx.radii[i], cx.radii[i - 1]) + halo) * 2.0)
            pygame.draw.line(surface, rim_c, _ip(pts[i]), _ip(pts[i - 1]),
                             max(1, w))
        for i in (lo, hi):
            pygame.draw.circle(surface, rim_c, _ip(pts[i]),
                               max(2, int(cx.radii[i] + halo)))
        _add_blit(surface, glow_surface(r * 2.4, accent,
                                        (0.20 + 0.30 * d + 0.26 * punch) * gi),
                  fx, fy, cx.blend)


# ==========================================================================
# Snake - head, tail, shield
# ==========================================================================
def _blink(t: float) -> float:
    """Eye openness 0..1; snaps shut and back every `_BLINK_PERIOD` seconds."""
    try:
        ph = math.fmod(t, _BLINK_PERIOD) / _BLINK_PERIOD
    except Exception:
        return 1.0
    if ph >= _BLINK_WIDTH:
        return 1.0
    u = ph / _BLINK_WIDTH
    return clamp(abs(u * 2.0 - 1.0), 0.0, 1.0)


def _xform(pt: Vec2, ox: float, oy: float, fx: float, fy: float,
           lx: float, ly: float, su: float, sv: float, shear: float) -> Vec2:
    """Map a head-local (forward, left) unit point into world space."""
    u, v = pt
    v = v + shear * (0.6 - u)
    return (ox + fx * u * su + lx * v * sv, oy + fy * u * su + ly * v * sv)


def _draw_head(surface: pygame.Surface, cx: _Ctx, heading: float,
               lean: float) -> None:
    """
    Skull, jaw, tracking eyes, speed stretch and boost exhaust.

    The silhouette is a fixed 12-point outline in head-local space so it costs
    two polygon fills; stretching it along the heading at speed and shearing it
    with the lean gives the head its whole range of expression for free.
    """
    hx, hy = cx.pts[0]
    hr = cx.radii[0]
    t = cx.t
    alpha, blend, gi = cx.alpha, cx.blend, cx.gi
    ca, sa = math.cos(heading), math.sin(heading)
    px, py = -sa, ca                       # unit vector 90 degrees to the left

    head_col = cx.head_col
    accent2 = cx.accent2
    # The skull is pulled well toward the body colour: a near-white head would
    # swallow the white eyes and turn into a featureless blob.
    fill = P.lerp_color(cx.cols[0], head_col, 0.28)
    rim = P.lerp_color(head_col, WHITE, 0.5)
    hood = hr * 1.06
    sp = cx.speed
    su = hood * (1.0 + 0.26 * sp)          # stretch along the heading at speed
    sv = hood * (1.0 - 0.10 * sp)
    shear = clamp(lean, -1.0, 1.0) * 0.26

    # ---- motion streaks -------------------------------------------------
    # Stamped glows rather than hard lines: at speed the head should smear,
    # and three rigid strokes trailing off a curved neck read as whiskers.
    if sp > 0.30:
        k = (sp - 0.30) / 0.70
        streak = P.lerp_color(cx.cols[0], WHITE, 0.45)
        for j in range(1, 4):
            f = 1.0 - j / 4.0
            d = hood * (0.75 + 1.15 * j) * (0.65 + 0.55 * k)
            _add_blit(surface,
                      glow_surface(hood * (1.5 - 0.22 * j), streak,
                                   (0.16 + 0.34 * k) * f * gi),
                      hx - ca * d, hy - sa * d, blend)

    # ---- boost exhaust at the neck --------------------------------------
    if cx.boosting and cx.n > 2:
        hot = cx.hot
        for i in range(1, min(6, cx.n)):
            f = 1.0 - (i - 1) / 5.0
            _add_blit(surface,
                      glow_surface(cx.radii[i] * (1.45 + 0.75 * f),
                                   hot, (0.18 + 0.42 * f) * gi),
                      cx.pts[i][0], cx.pts[i][1], blend)

    # Halo first so the crisp geometry sits on top of it.
    _add_blit(surface, glow_surface(hood * 3.0, head_col,
                                    (0.44 + 0.16 * pulse(t, 4.2)) * gi),
              hx, hy, blend)

    # ---- jaw, then skull -------------------------------------------------
    rim_c, fill_c = _c(rim, alpha), _c(fill, alpha)
    jaw_c = _c(P.shade(P.lerp_color(cx.cols[0], head_col, 0.10), 0.62), alpha)
    jaw = [_ip(_xform(p, hx + ca * hood * 0.06, hy + sa * hood * 0.06,
                      ca, sa, px, py, su * 1.02, sv * 0.94, shear)) for p in _JAW]
    try:
        pygame.draw.polygon(surface, jaw_c, jaw)
    except Exception:
        pass

    skull = [_xform(p, hx, hy, ca, sa, px, py, su, sv, shear) for p in _SKULL]
    ipts = [_ip(p) for p in skull]
    try:
        pygame.draw.polygon(surface, rim_c, ipts)
        inner = [_ip(_xform(p, hx, hy, ca, sa, px, py,
                            max(1.0, su - 2.4), max(1.0, sv - 2.4), shear))
                 for p in _SKULL]
        pygame.draw.polygon(surface, fill_c, inner)
    except Exception:
        # Degenerate polygon (a one-segment snake at spawn): fall back to discs.
        pygame.draw.circle(surface, rim_c, _ip((hx, hy)), max(2, int(hood)))
        pygame.draw.circle(surface, fill_c, _ip((hx, hy)), max(1, int(hood - 2.4)))

    # Mouth line: a dark crease from the nose back along the jaw.
    nose = _xform((1.30, 0.0), hx, hy, ca, sa, px, py, su, sv, shear)
    lip = _xform((0.30, 0.0), hx, hy, ca, sa, px, py, su, sv, shear)
    pygame.draw.line(surface, jaw_c, _ip(lip), _ip(nose), max(1, int(hood * 0.16)))

    # Broad specular sweep on the upper-left flank of the skull.
    _add_blit(surface, glow_surface(hood * 0.66, WHITE, 0.34 * gi),
              hx - ca * hood * 0.16 + px * hood * 0.42,
              hy - sa * hood * 0.16 + py * hood * 0.42, blend)

    # ---- eyes ------------------------------------------------------------
    open_f = _blink(t)
    eye_r = max(1.8, hood * 0.27)
    eye_d = hood * 0.62
    eye_spread = 0.74                      # radians either side of the heading
    pupil_r = max(1.0, eye_r * 0.50)
    dark = P.shade(cx.cols[0], 0.22)
    sclera_c = _c(P.UI_WHITE, alpha)
    dark_c = _c(dark, alpha)
    spec_c = _c(WHITE, alpha)
    for side in (-1.0, 1.0):
        ang = heading + side * eye_spread
        ex = hx + math.cos(ang) * eye_d + px * shear * hood * 0.4
        ey = hy + math.sin(ang) * eye_d + py * shear * hood * 0.4
        _add_blit(surface, glow_surface(eye_r * 2.4, accent2, 0.34 * gi), ex, ey, blend)
        pygame.draw.circle(surface, sclera_c, _ip((ex, ey)), int(eye_r))
        # Pupil pushed forward so the snake visibly looks where it is going.
        pygame.draw.circle(surface, dark_c,
                           _ip((ex + ca * eye_r * 0.40, ey + sa * eye_r * 0.40)),
                           int(pupil_r))
        # A hairline socket keeps the eye legible on a pale skull without
        # turning the pair into goggles.
        pygame.draw.circle(surface, dark_c, _ip((ex, ey)), int(eye_r) + 1, 1)
        # Catchlight on the opposite side of the pupil.
        pygame.draw.circle(surface, spec_c,
                           _ip((ex - ca * eye_r * 0.32 + px * eye_r * 0.34,
                                ey - sa * eye_r * 0.32 + py * eye_r * 0.34)),
                           max(1, int(eye_r * 0.30)))
        if open_f < 0.999:
            # Lids: two quads in the skull colour closing over the eyeball.
            drop = eye_r * (1.0 - open_f)
            for s in (1.0, -1.0):
                oy = s * (eye_r - drop * 0.5)
                q = [(ex + px * (oy + s * drop * 0.5) - ca * eye_r * 1.25,
                      ey + py * (oy + s * drop * 0.5) - sa * eye_r * 1.25),
                     (ex + px * (oy + s * drop * 0.5) + ca * eye_r * 1.25,
                      ey + py * (oy + s * drop * 0.5) + sa * eye_r * 1.25),
                     (ex + px * (oy - s * drop * 0.5) + ca * eye_r * 1.25,
                      ey + py * (oy - s * drop * 0.5) + sa * eye_r * 1.25),
                     (ex + px * (oy - s * drop * 0.5) - ca * eye_r * 1.25,
                      ey + py * (oy - s * drop * 0.5) - sa * eye_r * 1.25)]
                try:
                    pygame.draw.polygon(surface, fill_c, [_ip(p) for p in q])
                except Exception:
                    pass


def _draw_tail(surface: pygame.Surface, cx: _Ctx) -> None:
    """Extend the last segment into a fine, luminous, flicking point."""
    n = cx.n
    if n < 3:
        return
    ex, ey = cx.pts[n - 1]
    bx, by = cx.pts[n - 2]
    dx, dy = ex - bx, ey - by
    m = math.hypot(dx, dy)
    if m < 1e-6:
        return
    dx, dy = dx / m, dy / m
    nx, ny = -dy, dx
    reach = max(6.0, float(C.SNAKE_SEGMENT_SPACING) * 0.9)
    flick = math.sin(cx.t * 8.4) * reach * 0.42
    r = cx.radii[n - 1]
    mid = (ex + dx * reach * 0.5 + nx * flick * 0.5,
           ey + dy * reach * 0.5 + ny * flick * 0.5)
    tip = (ex + dx * reach + nx * flick, ey + dy * reach + ny * flick)
    col = cx.cols[n - 1]
    pygame.draw.line(surface, cx.rims[n - 1], _ip((ex, ey)), _ip(mid),
                     max(1, int(r * 1.4)))
    pygame.draw.line(surface, _c(P.lerp_color(col, WHITE, 0.55), cx.alpha),
                     _ip(mid), _ip(tip), max(1, int(r * 0.7)))
    _add_blit(surface, glow_surface(r * 3.0, cx.accent,
                                    (0.35 + 0.25 * pulse(cx.t, 6.0)) * cx.gi),
              tip[0], tip[1], cx.blend)


def _draw_shield(surface: pygame.Surface, pos: Vec2, hr: float, theme: Any,
                 t: float, blend: int, alpha: int, gi: float) -> None:
    """A rotating hexagonal energy ring locked around the head."""
    cx, cy = pos
    accent: RGB = _attr(theme, "accent", (120, 220, 255))
    accent2: RGB = _attr(theme, "accent2", (200, 160, 255))
    breathe = 1.0 + 0.055 * math.sin(t * 4.4)
    R = hr * 2.45 * breathe
    rot = t * 1.15
    bright = 0.55 + 0.45 * pulse(t, 5.0)

    # Soft containment bubble.
    _add_blit(surface, glow_surface(R * 1.05, accent2, (0.20 * bright + 0.08) * gi),
              cx, cy, blend)

    outer = [(cx + math.cos(rot + k * TAU / 6.0) * R,
              cy + math.sin(rot + k * TAU / 6.0) * R) for k in range(6)]
    inner = [(cx + math.cos(-rot * 0.65 + k * TAU / 6.0) * R * 0.70,
              cy + math.sin(-rot * 0.65 + k * TAU / 6.0) * R * 0.70) for k in range(6)]

    pygame.draw.lines(surface, _c(P.lerp_color(accent, WHITE, 0.30 * bright), alpha),
                      True, [_ip(p) for p in outer], 2)
    # The counter-rotating inner ring is tinted with accent2 and pulses out of
    # phase with the outer one, so the two never read as one static shape.
    pygame.draw.lines(surface,
                      _c(P.lerp_color(accent2, WHITE, 0.45 - 0.35 * bright), alpha),
                      True, [_ip(p) for p in inner], 2)
    for i, p in enumerate(outer):
        # Vertices flicker out of phase so the ring feels charged, not static.
        k = 0.45 + 0.55 * pulse(t * 6.0 + i * 1.05)
        _add_blit(surface, glow_surface(hr * 0.52, accent, 0.60 * k * gi),
                  p[0], p[1], blend)


# ==========================================================================
# Snake - top level
# ==========================================================================
def _paint_snake(surface: pygame.Surface, cx: _Ctx, theme: Any, heading: float,
                 shield: bool, crossings: List[Tuple[int, float, float, float]],
                 punch: float, lean_head: float) -> None:
    """Draw the whole snake, back to front, onto `surface`."""
    n = cx.n
    pts, radii, cols = cx.pts, cx.radii, cx.cols
    blend, gi, t = cx.blend, cx.gi, cx.t

    # ---- layer 1: the aura ------------------------------------------------
    # Two radii: a wide soft bloom plus a tight hot sheath right on the body,
    # which is what stops a long snake from reading as a flat plastic tube.
    # Subsampled so the cost stays flat however long the snake gets.
    step = 1 if n <= 24 else max(1, n // 24)
    beat = pulse(t, 3.1)
    wide = (0.30 + 0.10 * beat) * gi
    tight = (0.46 + 0.14 * beat) * gi
    for i in range(n - 1, -1, -step):
        r = radii[i]
        _add_blit(surface, glow_surface(r * 3.6, cols[i], wide),
                  pts[i][0], pts[i][1], blend)
        _add_blit(surface, glow_surface(r * 1.7, cols[i], tight),
                  pts[i][0], pts[i][1], blend)

    # ---- layer 2: the tail tip (behind everything) ------------------------
    _draw_tail(surface, cx)

    # ---- layer 3: the body, split so the head end lands on top -------------
    split = min(FRONT_SPAN, n - 1)
    _paint_range(surface, cx, n - 1, split + 1)
    _draw_crossings(surface, cx, crossings, punch)
    _paint_range(surface, cx, split, 0)

    # ---- layer 4: head + optional shield -----------------------------------
    _draw_head(surface, cx, heading, lean_head)
    if shield:
        _draw_shield(surface, pts[0], radii[0], theme, t, blend, cx.alpha, gi)


def _crossing_flag(snake: Any) -> bool:
    """Read ``snake.crossing_self`` whether it is a method, a property or absent."""
    try:
        value = getattr(snake, "crossing_self", None)
    except Exception:
        return False
    if value is None:
        return False
    if callable(value):
        try:
            return bool(value())
        except Exception:
            return False
    return bool(value)


def _turn_signal(snake: Any) -> float:
    """
    The snake's own steering signal in -1..1.

    Prefers ``turn_input`` (the raw stick position, which leads the geometry)
    and falls back to the smoothed ``bank`` for older builds of the entity.
    """
    raw = getattr(snake, "turn_input", None)
    if raw is None:
        raw = getattr(snake, "bank", 0.0)
    return clamp(_fnum(raw, 0.0), -1.0, 1.0)


def _speed_frac(snake: Any) -> float:
    """Current speed as 0..1 between the base cruise and the boosted ceiling."""
    lo = float(C.SNAKE_BASE_SPEED)
    hi = float(C.SNAKE_MAX_SPEED) * float(C.SNAKE_BOOST_MULT)
    if hi - lo < 1e-6:
        return 0.0
    return clamp((_fnum(_attr(snake, "current_speed", lo), lo) - lo) / (hi - lo),
                 0.0, 1.0)


def draw_snake(surface: pygame.Surface, snake: "Snake", theme: Any, t: float,
               *, ghost: bool = False, shield: bool = False,
               crossing: Optional[bool] = None) -> None:
    """
    Render `snake` with the level `theme` at animation time `t` (seconds).

    `ghost` renders the whole creature through a translucent off-screen layer;
    `shield` adds the rotating hexagonal energy ring around the head.
    `crossing` overrides the auto-detected "the head is currently passing over
    its own body" state - leave it None to use ``snake.crossing_self()``.
    """
    if snake is None:
        return
    try:
        raw_pts, radii = _snake_geometry(snake)
    except Exception:
        return
    if not raw_pts:
        return
    heading = _fnum(_attr(snake, "heading", 0.0), 0.0)

    try:
        n = len(raw_pts)
        normals, curv = _frames(raw_pts, heading)
        turn = _turn_signal(snake)
        pts, lean = _bank_points(raw_pts, radii, normals, curv, turn)

        # Detection runs on the *drawn* (banked) polyline, so the contact rim
        # lands exactly where the two tubes appear to overlap on screen.
        skip = max(2, int(_attr(C, "SELF_COLLISION_SKIP", 8)))
        crossings = _find_crossings(pts, radii, skip)
        punch = 1.0 if (crossing if crossing is not None
                        else _crossing_flag(snake)) else 0.0

        cx = _Ctx()
        cx.pts, cx.radii, cx.normals, cx.lean, cx.n = pts, radii, normals, lean, n
        cx.t = _fnum(t, 0.0)
        cx.accent = _attr_rgb(_attr(theme, "accent", (120, 220, 255)))
        cx.accent2 = _attr_rgb(_attr(theme, "accent2", (200, 160, 255)))
        cx.head_col = _attr_rgb(_attr(theme, "snake_head", WHITE))
        cx.speed = _speed_frac(snake)
        cx.boosting = bool(_attr(snake, "boosting", False))
        cx.hot = P.lerp_color(P.lerp_color(EXHAUST_COLOR, cx.accent2, 0.16),
                              WHITE, 0.22)
        cx.plate_step = max(2, int(n / SCALE_PLATE_TARGET) + 1)

        denom = float(max(1, n - 1))
        cx.cols = [_body_color(theme, i / denom) for i in range(n)]

        if not ghost:
            cx.alpha, cx.gi, cx.blend = 255, 1.0, pygame.BLEND_RGB_ADD
            cx.rims = [_c(P.lerp_color(c, WHITE, 0.52), 255) for c in cx.cols]
            cx.body = [_c(c, 255) for c in cx.cols]
            _paint_snake(surface, cx, theme, heading, shield, crossings,
                         punch, lean[0])
            return

        # Ghost path: paint into a persistent alpha layer with GHOST_ALPHA baked
        # into every draw colour, then blit just the bounding box back.
        cx.alpha = GHOST_ALPHA
        cx.gi = GHOST_ALPHA / 255.0
        # Glows must accumulate alpha too, or the halo would be invisible once
        # the layer is composited back onto the canvas.
        cx.blend = pygame.BLEND_RGBA_ADD
        cx.rims = [_c(P.lerp_color(c, WHITE, 0.52), GHOST_ALPHA) for c in cx.cols]
        cx.body = [_c(c, GHOST_ALPHA) for c in cx.cols]

        pad = int(max(radii) * 3.6) + 14
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        box = pygame.Rect(int(min(xs)) - pad, int(min(ys)) - pad,
                          int(max(xs) - min(xs)) + pad * 2,
                          int(max(ys) - min(ys)) + pad * 2)
        box = box.clip(surface.get_rect())
        if box.w <= 0 or box.h <= 0:
            return
        layer = _scratch(surface.get_size())
        layer.fill((0, 0, 0, 0), box)
        _paint_snake(layer, cx, theme, heading, shield, crossings, punch, lean[0])
        surface.blit(layer, box.topleft, box)
    except Exception:
        pass


# ==========================================================================
# Arena frame
# ==========================================================================
def _arena_frame(w: int, h: int, accent: RGB, accent2: RGB) -> pygame.Surface:
    """
    Cached additive frame sprite: outer neon bloom + soft inner edge gradient.

    Built once per (size, colour-bucket) pair.  Brightness is baked into RGB
    because BLEND_RGB_ADD ignores alpha.
    """
    key = (w, h, _cbucket(accent), _cbucket(accent2))
    surf = _FRAME_CACHE.get(key)
    if surf is not None:
        return surf

    pad = 26
    surf = pygame.Surface((w + pad * 2, h + pad * 2), pygame.SRCALPHA)
    base = pygame.Rect(pad, pad, w, h)

    # Inner gradient: nested outlines marching from deep inside out to the
    # border, getting brighter, so the play field edge is lit from within.
    depth = 40
    for i in range(depth, 0, -1):
        f = (1.0 - i / float(depth)) ** 2.2
        c = P.shade(P.lerp_color(accent2, accent, f), 0.34 * f)
        r = base.inflate(-2 * i, -2 * i)
        if r.w <= 2 or r.h <= 2:
            continue
        pygame.draw.rect(surf, (c[0], c[1], c[2], 255), r, width=2,
                         border_radius=max(2, C.UI_CORNER - i // 4))

    # Outer bloom: expanding outlines fading away from the border.
    for i in range(pad, 0, -1):
        f = (1.0 - i / float(pad)) ** 2.6
        c = P.shade(P.lerp_color(accent2, accent, f), 0.55 * f)
        pygame.draw.rect(surf, (c[0], c[1], c[2], 255),
                         base.inflate(i * 2, i * 2), width=2,
                         border_radius=C.UI_CORNER + i)

    _FRAME_CACHE[key] = surf
    _trim(_FRAME_CACHE, _FRAME_CACHE_LIMIT)
    return surf


def _perimeter_point(r: pygame.Rect, u: float) -> Vec2:
    """Point at fraction `u` (0..1) clockwise around the rect's perimeter."""
    u = u % 1.0
    d = u * (2.0 * (r.w + r.h))
    if d < r.w:
        return (r.x + d, float(r.y))
    d -= r.w
    if d < r.h:
        return (float(r.right), r.y + d)
    d -= r.h
    if d < r.w:
        return (r.right - d, float(r.bottom))
    d -= r.w
    return (float(r.x), r.bottom - min(d, float(r.h)))


def draw_arena(surface: pygame.Surface, rect: Any, theme: Any, t: float) -> None:
    """Neon play-field border: bloom, inner gradient, corner brackets, runners."""
    prev_clip: Any = None
    clipped = False
    try:
        r = _to_rect(rect)
        if r.w < 8 or r.h < 8:
            return
        accent: RGB = _attr_rgb(_attr(theme, "accent", (120, 220, 255)))
        accent2: RGB = _attr_rgb(_attr(theme, "accent2", (200, 160, 255)))

        # The bloom sprite is blitted 26 px outside `rect`, and the corner
        # brackets and perimeter runners stamp 20-22 px glows on the border
        # itself, so this routine naturally spills ~30 px in every direction.
        # Directly above the arena is the HUD strip (ARENA_Y == HUD_H), and the
        # HUD panel is translucent, so that upward spill shows straight through
        # it as a bright band no matter which is drawn first.  Clip to the
        # arena's own top edge: side and bottom spill stays inside the window
        # margin and is part of the intended neon look, but the HUD strip is
        # off limits.  The bright 2 px border line sits exactly on the cut, so
        # the clipped edge is invisible.
        prev_clip = surface.get_clip()
        bleed = 32
        area = pygame.Rect(r.x - bleed, r.y, r.w + bleed * 2, r.h + bleed)
        if prev_clip is not None:
            area = area.clip(prev_clip)
        surface.set_clip(area)
        clipped = True
        _arena_body(surface, r, accent, accent2, _fnum(t, 0.0))
    except Exception:
        pass
    finally:
        if clipped:
            try:
                surface.set_clip(prev_clip)
            except Exception:
                pass


def _arena_body(surface: pygame.Surface, r: pygame.Rect,
                accent: RGB, accent2: RGB, t: float) -> None:
    """The actual arena painting, run inside `draw_arena`'s clip rect."""
    try:
        frame = _arena_frame(r.w, r.h, accent, accent2)
        surface.blit(frame, (r.x - 26, r.y - 26), special_flags=pygame.BLEND_RGB_ADD)

        beat = pulse(t, 1.9)
        edge = P.lerp_color(accent, WHITE, 0.10 + 0.22 * beat)
        pygame.draw.rect(surface, edge, r, width=2, border_radius=C.UI_CORNER)
        pygame.draw.rect(surface, P.shade(accent, 0.45), r.inflate(-8, -8),
                         width=1, border_radius=max(2, C.UI_CORNER - 4))

        # ---- energy running along the border -----------------------------
        # A train of short dashes marching clockwise, each a pair of stamped
        # dots rather than a line so it never cuts a corner.  Brightness
        # oscillates along the train, which gives the whole border a direction.
        # The soft halo only goes on every other dash - two thirds of the cost
        # of this effect was in those blits and the eye cannot tell.
        dashes = 10
        span = 0.009
        for k in range(dashes):
            u0 = (t * 0.062 + k / float(dashes)) % 1.0
            f = 0.35 + 0.65 * (0.5 + 0.5 * math.sin(t * 2.4 + k * 0.9))
            col = P.lerp_color(accent2, accent, f)
            dot = P.lerp_color(col, WHITE, 0.25 * f)
            ax, ay = _perimeter_point(r, u0)
            bx, by = _perimeter_point(r, u0 + span)
            pygame.draw.circle(surface, dot, (int(ax), int(ay)), 2)
            pygame.draw.circle(surface, dot, (int(bx), int(by)), 2)
            if k & 1:
                draw_glow_circle(surface, bx, by, 11.0, col, 0.30 + 0.35 * f)

        # ---- corner brackets ---------------------------------------------
        # Short thick arms hugging the border, so they read as accents on the
        # frame rather than as a second inner rectangle.  A thinner second
        # bracket sits inside them and breathes out of phase.
        br = r.inflate(-9, -9)
        arm = int(clamp(min(br.w, br.h) * 0.045, 16.0, 30.0)) + int(3 * beat)
        beat2 = pulse(t, 1.9 + 1.3)
        arm2 = int(arm * (0.52 + 0.22 * beat2))
        inset = 8
        bcol = P.lerp_color(accent2, WHITE, 0.22 + 0.22 * beat)
        bcol2 = P.lerp_color(accent, WHITE, 0.10 + 0.30 * beat2)
        for sx, sy, ox, oy in ((1, 1, br.left, br.top), (-1, 1, br.right, br.top),
                               (1, -1, br.left, br.bottom), (-1, -1, br.right, br.bottom)):
            pygame.draw.line(surface, bcol, (ox, oy), (ox + sx * arm, oy), 4)
            pygame.draw.line(surface, bcol, (ox, oy), (ox, oy + sy * arm), 4)
            ix, iy = ox + sx * inset, oy + sy * inset
            pygame.draw.line(surface, bcol2, (ix, iy), (ix + sx * arm2, iy), 2)
            pygame.draw.line(surface, bcol2, (ix, iy), (ix, iy + sy * arm2), 2)
            draw_glow_circle(surface, ox, oy, 20.0, accent2, 0.55 + 0.25 * beat)

        # Two bright runners chasing each other around the border.
        for k in range(2):
            u = (t * 0.085 + k * 0.5) % 1.0
            px, py = _perimeter_point(r, u)
            draw_glow_circle(surface, px, py, 22.0, accent, 0.85)
            pygame.draw.circle(surface, P.lerp_color(accent, WHITE, 0.7),
                               (int(px), int(py)), 3)
    except Exception:
        pass


# ==========================================================================
# Food
# ==========================================================================
_KIND_SCALE = {"normal": 1.0, "bonus": 1.16, "mega": 1.38}
_KIND_GLOW = {"normal": 0.70, "bonus": 0.95, "mega": 1.25}
_KIND_DOTS = {"normal": 4, "bonus": 6, "mega": 8}
#: (arc count, sweep fraction of the gap, spin rate) for the rotating halo.
_KIND_HALO = {"normal": (2, 0.42, 0.9), "bonus": (3, 0.50, -1.15),
              "mega": (4, 0.58, 1.45)}
#: Sides of the faceted core overlay; 0 means "leave it a smooth sphere".
_KIND_FACETS = {"normal": 0, "bonus": 4, "mega": 6}


def _halo_arcs(surface: pygame.Surface, x: float, y: float, radius: float,
               col: RGB, count: int, sweep: float, spin: float,
               t: float, width: int) -> None:
    """Draw `count` evenly spaced arc segments on a rotating ring."""
    ri = int(radius)
    if ri < 3:
        return
    box = pygame.Rect(int(x) - ri, int(y) - ri, ri * 2, ri * 2)
    gap = TAU / count
    span = gap * sweep
    for k in range(count):
        a0 = t * spin + k * gap
        try:
            pygame.draw.arc(surface, col, box, a0, a0 + span, width)
        except Exception:
            return


def draw_food_orb(surface: pygame.Surface, x: float, y: float, r: float,
                  color: Sequence[int], t: float, kind: str = "normal") -> None:
    """
    A glowing food pellet.

    Shared anatomy: additive halo, a rotating ring of arc segments, orbiting
    dots, a shaded spherical core and a refraction sparkle.  The three kinds
    are then pulled apart so they are tellable at a glance - "normal" stays a
    smooth sphere, "bonus" gains a spinning four-sided facet cage and a 4-arm
    flare, "mega" a six-sided cage, a counter-rotating inner triangle, a second
    orbit ring and a 6-arm flare.
    """
    try:
        col: RGB = _attr_rgb(color)
        k = kind if kind in _KIND_SCALE else "normal"
        scale = _KIND_SCALE[k]
        gi = _KIND_GLOW[k]
        p = pulse(t, C.FOOD_PULSE_SPEED)
        rr = max(2.0, float(r) * scale * (0.94 + 0.10 * p))

        # Halo.
        draw_glow_circle(surface, x, y, rr * (2.9 + 0.6 * p), col, gi * (0.55 + 0.35 * p))

        # Rotating halo: arc segments on a ring just outside the core.
        arcs, sweep, spin = _KIND_HALO[k]
        ring_col = P.lerp_color(col, WHITE, 0.30 + 0.25 * p)
        _halo_arcs(surface, x, y, rr * (1.62 + 0.10 * p), ring_col,
                   arcs, sweep, spin, t, 2 if k == "normal" else 3)

        # Rotating orbital dots.  Mega gets a second, counter-rotating ring.
        rings: Tuple[Tuple[float, float, float], ...]
        if k == "mega":
            rings = ((2.10, 1.25, 1.0), (2.70, -0.80, 0.72))
        elif k == "bonus":
            rings = ((2.10, 1.10, 1.0),)
        else:
            rings = ((1.95, 0.85, 1.0),)
        dots = _KIND_DOTS[k]
        for orbit, dspin, weight in rings:
            for i in range(dots):
                ang = t * dspin + i * (TAU / dots)
                dx = x + math.cos(ang) * rr * orbit
                dy = y + math.sin(ang) * rr * orbit
                dr = max(1, int(rr * 0.17 * weight))
                if k != "normal":
                    draw_glow_circle(surface, dx, dy, rr * 0.75 * weight, col, 0.55)
                pygame.draw.circle(surface, P.lerp_color(col, WHITE, 0.45),
                                   (int(dx), int(dy)), dr)

        # Core: dark rim -> body colour -> hot centre.
        ix, iy = int(x), int(y)
        pygame.draw.circle(surface, P.shade(col, 0.50), (ix, iy), max(1, int(rr)))
        pygame.draw.circle(surface, col, (ix, iy), max(1, int(rr * 0.80)))
        pygame.draw.circle(surface, P.lerp_color(col, WHITE, 0.55),
                           (ix, iy), max(1, int(rr * 0.44)))
        pygame.draw.circle(surface, P.lerp_color(col, WHITE, 0.35), (ix, iy),
                           max(1, int(rr)), 2)

        # Facet cage: what makes bonus and mega read as cut gems, not pellets.
        facets = _KIND_FACETS[k]
        if facets >= 3 and rr >= 5.0:
            fc = P.lerp_color(col, WHITE, 0.60)
            rot = t * (0.9 if k == "bonus" else 0.62)
            poly = [(x + math.cos(rot + i * TAU / facets) * rr * 0.94,
                     y + math.sin(rot + i * TAU / facets) * rr * 0.94)
                    for i in range(facets)]
            pygame.draw.lines(surface, fc, True, [_ip(q) for q in poly], 2)
            if k == "mega":
                rot2 = -t * 1.05
                tri = [(x + math.cos(rot2 + i * TAU / 3.0) * rr * 0.52,
                        y + math.sin(rot2 + i * TAU / 3.0) * rr * 0.52)
                       for i in range(3)]
                pygame.draw.lines(surface, P.lerp_color(col, WHITE, 0.80), True,
                                  [_ip(q) for q in tri], 1)

        # Off-centre catchlight sells the orb as a sphere, and the refraction
        # sparkle riding on it sells it as glass: a tiny star flare plus a
        # cool/warm fringe pair a pixel either side of the highlight.
        hx, hy = x - rr * 0.30, y - rr * 0.32
        pygame.draw.circle(surface, WHITE, (int(hx), int(hy)), max(1, int(rr * 0.20)))
        _add_blit(surface, _flare_surface(rr * (0.85 + 0.15 * p), WHITE, 4),
                  hx, hy, pygame.BLEND_RGB_ADD)
        if rr >= 6.0:
            fringe = max(1, int(rr * 0.10))
            pygame.draw.circle(surface, P.hue_shift(col, 0.08),
                               (int(hx + rr * 0.26), int(hy + rr * 0.10)), fringe)
            pygame.draw.circle(surface, P.hue_shift(col, -0.08),
                               (int(hx - rr * 0.18), int(hy + rr * 0.22)), fringe)

        if k != "normal":
            arms = 4 if k == "bonus" else 6
            flare = _flare_surface(rr * (2.4 + 0.5 * p),
                                   P.lerp_color(col, WHITE, 0.35), arms)
            _add_blit(surface, flare, x, y, pygame.BLEND_RGB_ADD)
    except Exception:
        pass


__all__ = [
    "glow_surface", "disc_surface", "draw_glow_circle", "draw_snake",
    "draw_arena", "draw_food_orb", "clear_caches", "GHOST_ALPHA",
    "BANK_STRENGTH", "BANK_RAMP", "FRONT_SPAN", "MAX_CROSSINGS",
    "SCALE_PLATE_TARGET", "SHADOW_COLOR", "EXHAUST_COLOR",
]
