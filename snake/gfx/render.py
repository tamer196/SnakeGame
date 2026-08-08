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
normally.

Public API::

    glow_surface(radius, color, intensity=1.0) -> pygame.Surface
    draw_glow_circle(surface, x, y, radius, color, intensity=1.0)
    draw_snake(surface, snake, theme, t, *, ghost=False, shield=False)
    draw_arena(surface, rect, theme, t)
    draw_food_orb(surface, x, y, r, color, t, kind="normal")
    clear_caches()

No function here may raise: a renderer that throws takes the whole frame with
it, so every public entry point swallows and ignores failures.
"""

from __future__ import annotations

import math
from typing import TYPE_CHECKING, Any, Dict, List, Sequence, Tuple

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

# Reusable off-screen layers, keyed by size.  Used for the translucent "ghost"
# snake so we never allocate a full-screen surface inside the draw loop.
_SCRATCH: Dict[Tuple[int, int], pygame.Surface] = {}

GHOST_ALPHA = 116            # 0..255 opacity applied to a phased-out snake


def clear_caches() -> None:
    """Drop every cached surface (useful on resolution / theme churn)."""
    _GLOW_CACHE.clear()
    _FLARE_CACHE.clear()
    _FRAME_CACHE.clear()
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
# Snake
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


def _draw_head(surface: pygame.Surface, pos: Vec2, hr: float, heading: float,
               theme: Any, t: float, blend: int, alpha: int, gi: float) -> None:
    """Head capsule, eyes with pupils that track `heading`, and speculars."""
    hx, hy = pos
    ca, sa = math.cos(heading), math.sin(heading)
    px, py = -sa, ca                       # unit vector 90 degrees to the left

    head_col: RGB = _attr(theme, "snake_head", (230, 250, 255))
    accent2: RGB = _attr(theme, "accent2", (140, 200, 255))
    # The skull is pulled well toward the body colour: a near-white head would
    # swallow the white eyes and turn into a featureless blob.
    fill = P.lerp_color(_body_color(theme, 0.0), head_col, 0.28)
    rim = P.lerp_color(head_col, WHITE, 0.5)
    hood = hr * 1.14                       # head reads bigger than the neck

    # Halo first so the crisp geometry sits on top of it.
    _add_blit(surface, glow_surface(hood * 3.2, head_col,
                                    (0.55 + 0.20 * pulse(t, 4.2)) * gi),
              hx, hy, blend)

    # Snout: a second, smaller disc pushed forward along the heading turns the
    # round head into an elongated wedge that visibly points somewhere.
    sx, sy = hx + ca * hood * 0.40, hy + sa * hood * 0.40
    rim_c, fill_c = _c(rim, alpha), _c(fill, alpha)
    pygame.draw.circle(surface, rim_c, _ip((hx, hy)), max(2, int(hood)))
    pygame.draw.circle(surface, rim_c, _ip((sx, sy)), max(2, int(hood * 0.84)))
    pygame.draw.circle(surface, fill_c, _ip((hx, hy)), max(1, int(hood - 2.6)))
    pygame.draw.circle(surface, fill_c, _ip((sx, sy)), max(1, int(hood * 0.84 - 2.6)))

    # Broad specular sweep on the upper-left flank of the skull.
    _add_blit(surface, glow_surface(hood * 0.66, WHITE, 0.34 * gi),
              hx - ca * hood * 0.16 + px * hood * 0.42,
              hy - sa * hood * 0.16 + py * hood * 0.42, blend)

    eye_r = max(1.8, hood * 0.26)
    eye_d = hood * 0.60
    eye_spread = 0.76                      # radians either side of the heading
    pupil_r = max(1.0, eye_r * 0.50)
    dark = P.shade(_attr(theme, "bg_bottom", (6, 8, 18)), 0.55)
    sclera_c = _c(P.UI_WHITE, alpha)
    dark_c = _c(dark, alpha)
    spec_c = _c(WHITE, alpha)
    for side in (-1.0, 1.0):
        ang = heading + side * eye_spread
        ex = hx + math.cos(ang) * eye_d
        ey = hy + math.sin(ang) * eye_d
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


def _paint_snake(surface: pygame.Surface, pts: List[Vec2], radii: List[float],
                 theme: Any, t: float, heading: float, shield: bool,
                 blend: int, alpha: int = 255) -> None:
    """Draw the whole snake, tail first, onto `surface`."""
    n = len(pts)
    denom = float(max(1, n - 1))
    cols: List[RGB] = [_body_color(theme, i / denom) for i in range(n)]
    rims: List[Tuple[int, ...]] = [_c(P.lerp_color(c, WHITE, 0.52), alpha) for c in cols]
    body: List[Tuple[int, ...]] = [_c(c, alpha) for c in cols]
    accent: RGB = _attr(theme, "accent", (120, 220, 255))
    # Additive light is dimmed alongside the body when phasing out, otherwise
    # a ghost snake would keep a fully opaque halo.
    gi = alpha / 255.0

    # ---- pass 1: outer additive glow, subsampled so the cost stays flat ----
    # Two radii: a wide soft bloom plus a tight hot sheath right on the body,
    # which is what stops a long snake from reading as a flat plastic tube.
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

    # ---- pass 2: bright rim shell (whole body, so only the silhouette shows)
    for i in range(n - 1, -1, -1):
        r = radii[i]
        if i > 0:
            w = max(1, int(min(r, radii[i - 1]) * 2.0))
            pygame.draw.line(surface, rims[i], _ip(pts[i]), _ip(pts[i - 1]), w)
        pygame.draw.circle(surface, rims[i], _ip(pts[i]), max(1, int(r)))

    # ---- pass 3: gradient interior, inset by the rim width -----------------
    for i in range(n - 1, -1, -1):
        r = radii[i]
        rim_w = clamp(r * 0.22, 1.4, 3.0)
        inner = r - rim_w
        if inner < 1.0:
            continue
        if i > 0:
            w = max(1, int((min(inner, radii[i - 1] - rim_w)) * 2.0))
            pygame.draw.line(surface, body[i], _ip(pts[i]), _ip(pts[i - 1]), w)
        pygame.draw.circle(surface, body[i], _ip(pts[i]), max(1, int(inner)))

    # ---- pass 4: pulsing energy seam running down the spine -----------------
    # The phase term `i * 0.52 - t * 7` makes the bright band travel head-ward,
    # which reads as energy being pumped along the body.
    head_col: RGB = _attr(theme, "snake_head", WHITE)
    for i in range(n - 1, -1, -1):
        r = radii[i]
        if r < 3.0:
            continue
        s = 0.5 + 0.5 * math.sin(i * 0.52 - t * 7.0)
        bright = P.lerp_color(cols[i], head_col, 0.30 + 0.45 * s)
        core = _c(P.lerp_color(bright, WHITE, 0.30 * s), alpha)
        if i > 0:
            pygame.draw.line(surface, core, _ip(pts[i]), _ip(pts[i - 1]),
                             max(1, int(r * 0.46)))
        pygame.draw.circle(surface, core, _ip(pts[i]), max(1, int(r * 0.36)))
        if s > 0.72 and (i & 1) == 0:
            _add_blit(surface, glow_surface(r * 2.1, accent, 0.60 * s * gi),
                      pts[i][0], pts[i][1], blend)

    # ---- pass 5: head + optional shield ------------------------------------
    _draw_head(surface, pts[0], radii[0], heading, theme, t, blend, alpha, gi)
    if shield:
        _draw_shield(surface, pts[0], radii[0], theme, t, blend, alpha, gi)


def draw_snake(surface: pygame.Surface, snake: "Snake", theme: Any, t: float,
               *, ghost: bool = False, shield: bool = False) -> None:
    """
    Render `snake` with the level `theme` at animation time `t` (seconds).

    `ghost` renders the whole creature through a translucent off-screen layer;
    `shield` adds the rotating hexagonal energy ring around the head.
    """
    if snake is None:
        return
    try:
        pts, radii = _snake_geometry(snake)
    except Exception:
        return
    if not pts:
        return
    try:
        heading = float(_attr(snake, "heading", 0.0))
        if not math.isfinite(heading):
            heading = 0.0
    except Exception:
        heading = 0.0

    try:
        if not ghost:
            _paint_snake(surface, pts, radii, theme, t, heading, shield,
                         pygame.BLEND_RGB_ADD)
            return

        # Ghost path: paint into a persistent alpha layer with GHOST_ALPHA baked
        # into every draw colour, then blit just the bounding box back.
        pad = int(max(radii) * 3.4) + 8
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
        # Glows must accumulate alpha too, or the halo would be invisible once
        # the layer is composited back onto the canvas.
        _paint_snake(layer, pts, radii, theme, t, heading, shield,
                     pygame.BLEND_RGBA_ADD, GHOST_ALPHA)
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
        try:
            _arena_body(surface, r, accent, accent2, t)
        finally:
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

        # Corner brackets: short thick arms hugging the border, so they read as
        # accents on the frame rather than as a second inner rectangle.
        br = r.inflate(-9, -9)
        arm = int(clamp(min(br.w, br.h) * 0.045, 16.0, 30.0)) + int(3 * beat)
        bcol = P.lerp_color(accent2, WHITE, 0.22 + 0.22 * beat)
        for sx, sy, ox, oy in ((1, 1, br.left, br.top), (-1, 1, br.right, br.top),
                               (1, -1, br.left, br.bottom), (-1, -1, br.right, br.bottom)):
            pygame.draw.line(surface, bcol, (ox, oy), (ox + sx * arm, oy), 4)
            pygame.draw.line(surface, bcol, (ox, oy), (ox, oy + sy * arm), 4)
            draw_glow_circle(surface, ox, oy, 20.0, accent2, 0.55 + 0.25 * beat)

        # Two energy runners chasing each other around the border.
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


def draw_food_orb(surface: pygame.Surface, x: float, y: float, r: float,
                  color: Sequence[int], t: float, kind: str = "normal") -> None:
    """
    A glowing food pellet: additive halo, shaded core, rotating orbital halo,
    plus a star sparkle for the "bonus" and "mega" kinds.
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

        # Rotating orbital dots.  Mega gets a second, counter-rotating ring.
        rings: Tuple[Tuple[float, float, float], ...]
        if k == "mega":
            rings = ((1.95, 1.25, 1.0), (2.55, -0.80, 0.72))
        elif k == "bonus":
            rings = ((1.95, 1.10, 1.0),)
        else:
            rings = ((1.80, 0.85, 1.0),)
        dots = _KIND_DOTS[k]
        for orbit, spin, weight in rings:
            for i in range(dots):
                ang = t * spin + i * (TAU / dots)
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
        # Off-centre catchlight sells the orb as a sphere.
        pygame.draw.circle(surface, WHITE,
                           (int(x - rr * 0.30), int(y - rr * 0.32)),
                           max(1, int(rr * 0.20)))

        if k != "normal":
            arms = 4 if k == "bonus" else 6
            flare = _flare_surface(rr * (2.4 + 0.5 * p),
                                   P.lerp_color(col, WHITE, 0.35), arms)
            _add_blit(surface, flare, x, y, pygame.BLEND_RGB_ADD)
    except Exception:
        pass
