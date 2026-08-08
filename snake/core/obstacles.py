"""
Arena hazards for NEON SERPENT.

Every obstacle is a small, self-contained actor with three jobs:

    update(dt, t)            advance its animation
    draw(surface, theme, t)  paint itself in the level's colours
    collides(x, y, r)        answer "is this circle touching me?"

`deadly` says whether a collision costs the player a life.  The only hazard
with ``deadly = False`` is :class:`Portal`, which teleports instead of killing.

Design notes
------------
* All geometry is float pixels in arena space - nothing here knows about the
  grid, because the snake moves continuously.
* Collision shapes are deliberately simple (circle-vs-rect, circle-vs-segment)
  so the whole hazard list can be tested every frame without breaking 60 fps.
* Drawing never allocates a Surface per frame: soft glows come from a small
  module-level cache of pre-rendered radial sprites blitted with
  ``BLEND_RGB_ADD``, and static slabs are baked once per theme.
* Nothing in this module may raise.  The public entry points wrap the real
  implementation (``_update`` / ``_draw`` / ``_collides``) in a guard so a bad
  spec degrades into a missing hazard rather than a crash.
"""

from __future__ import annotations

import inspect
import math
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set, Tuple, Type

import pygame

from .. import config as C
from .. import palette as P
from .contracts import TAU, clamp, ease_in_out_cubic, lerp, pulse

Vec2 = Tuple[float, float]

# --------------------------------------------------------------------------
# Local tuning (nothing in config.py covers hazards yet)
# --------------------------------------------------------------------------
PORTAL_COOLDOWN = 0.55      # seconds a portal pair sleeps after a jump
PORTAL_EXIT_PAD = 10.0      # pixels beyond the destination rim to eject at
GLOW_CACHE_LIMIT = 512      # pre-rendered glow sprites kept alive
GLOW_STEP_PX = 9.0          # spacing of glow blobs along a glowing line


# ==========================================================================
# Geometry helpers
# ==========================================================================
def _seg_distance(px: float, py: float,
                  ax: float, ay: float, bx: float, by: float) -> float:
    """
    Shortest distance from point P to the *segment* AB.

    Project P onto the infinite line (dot(w, v) / dot(v, v)), clamp the
    parameter to 0..1 so the nearest point stays on the segment, then measure.
    """
    vx, vy = bx - ax, by - ay
    wx, wy = px - ax, py - ay
    denom = vx * vx + vy * vy
    if denom <= 1e-9:                       # degenerate segment == point
        return math.hypot(wx, wy)
    tt = clamp((wx * vx + wy * vy) / denom, 0.0, 1.0)
    return math.hypot(px - (ax + vx * tt), py - (ay + vy * tt))


def _rect_hits_circle(left: float, top: float, right: float, bottom: float,
                      cx: float, cy: float, r: float) -> bool:
    """Circle vs axis-aligned rect: clamp the centre into the rect, measure."""
    nx = left if cx < left else (right if cx > right else cx)
    ny = top if cy < top else (bottom if cy > bottom else cy)
    dx, dy = cx - nx, cy - ny
    return dx * dx + dy * dy <= r * r


# ==========================================================================
# Cheap cached neon drawing
# ==========================================================================
_GLOW_CACHE: Dict[Tuple[int, int, int, int, int], pygame.Surface] = {}


def _glow_sprite(radius: float, color: Sequence[int],
                 intensity: float = 1.0) -> pygame.Surface:
    """
    A radial additive glow sprite, cached by (radius, colour, intensity).

    Radius is quantised to whole pixels and intensity to 1/8ths so continuous
    animations (a breathing Pulsar) still hit the cache almost every frame.
    """
    r = int(clamp(radius, 2.0, 260.0))
    col = (int(color[0]) & 255, int(color[1]) & 255, int(color[2]) & 255)
    key = (r, col[0], col[1], col[2], int(clamp(intensity, 0.0, 2.0) * 8.0))
    surf = _GLOW_CACHE.get(key)
    if surf is not None:
        return surf
    if len(_GLOW_CACHE) > GLOW_CACHE_LIMIT:
        _GLOW_CACHE.clear()

    inten = clamp(intensity, 0.0, 2.0)
    size = r * 2
    surf = pygame.Surface((size, size), pygame.SRCALPHA)
    steps = int(clamp(r * 0.6, 6, 20))
    # Paint outside-in: alpha rises steeply toward the centre (falloff ~ (1-f)^2)
    for i in range(steps, 0, -1):
        f = i / steps
        a = P.clamp8(255.0 * inten * (1.0 - f) ** 1.9)
        if a <= 0:
            continue
        pygame.draw.circle(surf, (col[0], col[1], col[2], a),
                           (r, r), max(1, int(r * f)))
    _GLOW_CACHE[key] = surf
    return surf


def _add_glow(surface: pygame.Surface, x: float, y: float, radius: float,
              color: Sequence[int], intensity: float = 1.0) -> None:
    """Blit one cached glow sprite additively, centred on (x, y)."""
    spr = _glow_sprite(radius, color, intensity)
    r = spr.get_width() * 0.5
    surface.blit(spr, (int(x - r), int(y - r)), special_flags=pygame.BLEND_RGB_ADD)


def _glow_line(surface: pygame.Surface, ax: float, ay: float,
               bx: float, by: float, color: Sequence[int],
               radius: float, intensity: float = 1.0,
               max_blobs: int = 18) -> None:
    """
    A genuinely additive glow along a segment: stamp cached blobs at a fixed
    arc-length spacing, capped so a very long beam still costs a bounded
    number of blits.
    """
    length = math.hypot(bx - ax, by - ay)
    n = int(clamp(length / GLOW_STEP_PX, 1, max_blobs)) + 1
    for i in range(n + 1):
        f = i / n
        _add_glow(surface, ax + (bx - ax) * f, ay + (by - ay) * f,
                  radius, color, intensity)


def _neon_line(surface: pygame.Surface, ax: float, ay: float,
               bx: float, by: float, color: Sequence[int], width: float,
               *, core: float = 0.7) -> None:
    """Solid neon stroke: coloured body plus a hot near-white centre."""
    w = max(1, int(width))
    a = (int(ax), int(ay))
    b = (int(bx), int(by))
    pygame.draw.line(surface, P.shade(color, 0.55), a, b, w + 3)
    pygame.draw.line(surface, color, a, b, w)
    if w >= 3:
        pygame.draw.line(surface, P.lerp_color(color, (255, 255, 255), core),
                         a, b, max(1, w // 3))


def _hazard_slab(w: int, h: int, base: P.RGB, edge: P.RGB,
                 hatched: bool = True) -> pygame.Surface:
    """
    Bake one static hazard slab: vertical gradient body, diagonal hatching,
    and a bright inner keyline.  Called once per obstacle per theme.
    """
    w = max(2, int(w))
    h = max(2, int(h))
    surf = pygame.Surface((w, h), pygame.SRCALPHA)
    top = P.shade(base, 0.42)
    bot = P.shade(base, 0.16)
    for yy in range(h):                     # cheap 1px-row gradient fill
        c = P.lerp_color(top, bot, yy / max(1, h - 1))
        pygame.draw.line(surf, P.with_alpha(c, 238), (0, yy), (w, yy))
    if hatched:
        hatch = P.with_alpha(P.shade(base, 0.85), 42)
        span = w + h
        for k in range(-h, span, 14):       # 45-degree warning stripes
            pygame.draw.line(surf, hatch, (k, 0), (k + h, h), 3)
    pygame.draw.rect(surf, P.with_alpha(P.shade(edge, 1.15), 235),
                     pygame.Rect(0, 0, w, h), 2)
    pygame.draw.rect(surf, P.with_alpha(P.shade(edge, 0.45), 160),
                     pygame.Rect(2, 2, max(1, w - 4), max(1, h - 4)), 1)
    return surf


# ==========================================================================
# Base class
# ==========================================================================
class Obstacle:
    """
    Common hazard behaviour.

    Subclasses override the underscored hooks; the public methods are thin
    guards so a broken hazard can never take the frame down with it.
    """

    kind: str = "obstacle"

    def __init__(self, *, deadly: bool = True) -> None:
        self.deadly: bool = bool(deadly)
        self.t: float = 0.0
        self.arena: Optional[pygame.Rect] = None   # set by build_obstacles

    # -- hooks -------------------------------------------------------------
    def _update(self, dt: float, t: float) -> None:
        """Advance animation state."""

    def _draw(self, surface: pygame.Surface, theme: "P.Theme", t: float) -> None:
        """Paint the hazard."""

    def _collides(self, x: float, y: float, r: float) -> bool:
        return False

    # -- public API --------------------------------------------------------
    def update(self, dt: float, t: float) -> None:
        try:
            self.t = float(t)
            self._update(float(dt), float(t))
        except Exception:
            pass

    def draw(self, surface: pygame.Surface, theme: "P.Theme", t: float) -> None:
        # A hazard lives in the arena and must never paint outside it.  Its
        # additive halos are generous (a laser beam pads its glow by width+8,
        # a spinner by a full arm length), and a hazard sitting on the arena
        # edge would otherwise spill its bloom into the HUD strip above -
        # ARENA_Y == HUD_H, so there is no gap to absorb it.  Clipping to
        # `self.arena` costs one set_clip per hazard and makes the draw order
        # against the HUD irrelevant.
        prev_clip = None
        clipped = False
        try:
            if self.arena is not None:
                prev_clip = surface.get_clip()
                area = pygame.Rect(self.arena)
                if prev_clip is not None:
                    area = area.clip(prev_clip)
                surface.set_clip(area)
                clipped = True
            self._draw(surface, theme, float(t))
            if C.DEBUG_HITBOXES:
                pygame.draw.rect(surface, (255, 0, 255), self.bounds(), 1)
        except Exception:
            pass
        finally:
            if clipped:
                try:
                    surface.set_clip(prev_clip)
                except Exception:
                    pass

    def collides(self, x: float, y: float, r: float = 0.0) -> bool:
        try:
            return bool(self._collides(float(x), float(y), float(r)))
        except Exception:
            return False

    # -- helpers used by spawners -----------------------------------------
    def bounds(self) -> pygame.Rect:
        """Axis-aligned box covering everything this hazard can occupy."""
        return pygame.Rect(0, 0, 0, 0)

    def avoid(self) -> Tuple[float, float, float]:
        """(x, y, radius) keep-out circle, for FoodField / PowerUpField."""
        b = self.bounds()
        return (b.centerx, b.centery, math.hypot(b.w, b.h) * 0.5 + 6.0)


# ==========================================================================
# WallBlock - a static neon slab
# ==========================================================================
class WallBlock(Obstacle):
    """An immovable rectangle. The bread and butter of level layout."""

    kind = "wall"

    def __init__(self, x: float = 0.0, y: float = 0.0,
                 w: float = 60.0, h: float = 60.0, *,
                 deadly: bool = True) -> None:
        super().__init__(deadly=deadly)
        self.x = float(x)
        self.y = float(y)
        self.w = max(2.0, float(w))
        self.h = max(2.0, float(h))
        self._slab: Optional[pygame.Surface] = None
        self._slab_key: Optional[str] = None

    def bounds(self) -> pygame.Rect:
        return pygame.Rect(int(self.x), int(self.y), int(self.w), int(self.h))

    def _collides(self, x: float, y: float, r: float) -> bool:
        return _rect_hits_circle(self.x, self.y, self.x + self.w, self.y + self.h,
                                 x, y, r)

    def _slab_for(self, theme: "P.Theme") -> pygame.Surface:
        if self._slab is None or self._slab_key != theme.name:
            self._slab = _hazard_slab(int(self.w), int(self.h),
                                      theme.hazard, theme.hazard)
            self._slab_key = theme.name
        return self._slab

    def _draw(self, surface: pygame.Surface, theme: "P.Theme", t: float) -> None:
        surface.blit(self._slab_for(theme), (int(self.x), int(self.y)))
        # Breathing edge highlight: cheap, and it keeps static geometry alive.
        glow = 0.35 + 0.35 * pulse(t + self.x * 0.013, 1.7)
        edge = P.lerp_color(theme.hazard, (255, 255, 255), glow * 0.45)
        pygame.draw.rect(surface, edge, self.bounds(), 2)
        # Corner brackets read as "engineered" rather than "a grey box".
        c = int(clamp(min(self.w, self.h) * 0.28, 5.0, 18.0))
        x0, y0 = int(self.x), int(self.y)
        x1, y1 = int(self.x + self.w), int(self.y + self.h)
        for (px, py, dx, dy) in ((x0, y0, 1, 1), (x1, y0, -1, 1),
                                 (x0, y1, 1, -1), (x1, y1, -1, -1)):
            pygame.draw.line(surface, theme.accent2, (px, py), (px + dx * c, py), 2)
            pygame.draw.line(surface, theme.accent2, (px, py), (px, py + dy * c), 2)
        _add_glow(surface, self.x + self.w * 0.5, self.y + self.h * 0.5,
                  max(self.w, self.h) * 0.62, theme.hazard, 0.20 + glow * 0.16)


# ==========================================================================
# MovingBar - a slab on an eased ping-pong
# ==========================================================================
class MovingBar(Obstacle):
    """
    A slab that slides between its home position and home + travel.

    The path is an eased triangle wave, so it decelerates into each end of the
    run instead of snapping direction - far easier to read and to dodge.
    """

    kind = "movingbar"

    def __init__(self, x: float = 0.0, y: float = 0.0,
                 w: float = 120.0, h: float = 20.0, *,
                 axis: str = "x", travel: float = 160.0,
                 speed: float = 0.35, phase: float = 0.0,
                 deadly: bool = True) -> None:
        super().__init__(deadly=deadly)
        self.x0 = float(x)
        self.y0 = float(y)
        self.w = max(2.0, float(w))
        self.h = max(2.0, float(h))
        self.axis = "y" if str(axis).lower() in ("y", "v", "vertical", "1") else "x"
        self.travel = float(travel)
        self.speed = float(speed)           # full out-and-back cycles / second
        self.phase = float(phase)
        self.x = self.x0
        self.y = self.y0
        self.dir = 1.0                      # +1 outbound, -1 returning
        self._slab: Optional[pygame.Surface] = None
        self._slab_key: Optional[str] = None
        self._update(0.0, 0.0)

    def bounds(self) -> pygame.Rect:
        return pygame.Rect(int(self.x), int(self.y), int(self.w), int(self.h))

    def span(self) -> pygame.Rect:
        """The whole corridor the bar sweeps (used as a keep-out zone)."""
        tx = self.travel if self.axis == "x" else 0.0
        ty = self.travel if self.axis == "y" else 0.0
        left = min(self.x0, self.x0 + tx)
        top = min(self.y0, self.y0 + ty)
        return pygame.Rect(int(left), int(top),
                           int(self.w + abs(tx)), int(self.h + abs(ty)))

    def avoid(self) -> Tuple[float, float, float]:
        b = self.span()
        return (b.centerx, b.centery, math.hypot(b.w, b.h) * 0.5 + 6.0)

    def _update(self, dt: float, t: float) -> None:
        u = (t * self.speed + self.phase) % 1.0
        # Triangle wave 0 -> 1 -> 0, then eased for smooth ends.
        tri = u * 2.0 if u < 0.5 else 2.0 - 2.0 * u
        off = self.travel * ease_in_out_cubic(tri)
        self.dir = 1.0 if u < 0.5 else -1.0
        if self.axis == "x":
            self.x, self.y = self.x0 + off, self.y0
        else:
            self.x, self.y = self.x0, self.y0 + off

    def _collides(self, x: float, y: float, r: float) -> bool:
        return _rect_hits_circle(self.x, self.y, self.x + self.w, self.y + self.h,
                                 x, y, r)

    def _draw(self, surface: pygame.Surface, theme: "P.Theme", t: float) -> None:
        if self._slab is None or self._slab_key != theme.name:
            self._slab = _hazard_slab(int(self.w), int(self.h),
                                      theme.hazard, theme.accent2)
            self._slab_key = theme.name

        # Rail: a dim line showing the full sweep so the motion is predictable.
        sp = self.span()
        if self.axis == "x":
            ry = sp.centery
            pygame.draw.line(surface, P.shade(theme.grid, 1.25),
                             (sp.left, ry), (sp.right, ry), 2)
        else:
            rx = sp.centerx
            pygame.draw.line(surface, P.shade(theme.grid, 1.25),
                             (rx, sp.top), (rx, sp.bottom), 2)

        # Motion smear behind the bar, three fading ghosts.
        back = -self.dir * 1.0
        for i in (3, 2, 1):
            gx = self.x + (back * i * 7.0 if self.axis == "x" else 0.0)
            gy = self.y + (back * i * 7.0 if self.axis == "y" else 0.0)
            _add_glow(surface, gx + self.w * 0.5, gy + self.h * 0.5,
                      max(self.w, self.h) * 0.42, theme.accent2, 0.10 / i)

        surface.blit(self._slab, (int(self.x), int(self.y)))
        pygame.draw.rect(surface, P.lerp_color(theme.accent2, (255, 255, 255),
                                               0.25 + 0.3 * pulse(t, 3.1)),
                         self.bounds(), 2)

        # Chevrons pointing the way it is currently travelling.
        cx, cy = self.x + self.w * 0.5, self.y + self.h * 0.5
        k = clamp(min(self.w, self.h) * 0.30, 4.0, 10.0)
        col = P.shade(theme.accent2, 1.2)
        for i in (-1, 1):
            if self.axis == "x":
                ox = cx + i * k * 1.6
                tipx = ox + self.dir * k
                pygame.draw.lines(surface, col, False,
                                  [(ox, cy - k), (tipx, cy), (ox, cy + k)], 2)
            else:
                oy = cy + i * k * 1.6
                tipy = oy + self.dir * k
                pygame.draw.lines(surface, col, False,
                                  [(cx - k, oy), (cx, tipy), (cx + k, oy)], 2)
        _add_glow(surface, cx, cy, max(self.w, self.h) * 0.55, theme.hazard, 0.22)


# ==========================================================================
# Spinner - rotating arms
# ==========================================================================
class Spinner(Obstacle):
    """
    N arms rotating about a hub.  Each arm is a thick line segment, so
    collision is point-to-segment distance against a radius of thickness / 2.
    """

    kind = "spinner"

    def __init__(self, cx: float = 0.0, cy: float = 0.0,
                 length: float = 90.0, *,
                 arms: int = 2, speed: float = 1.5,
                 thickness: float = 11.0, phase: float = 0.0,
                 hub_radius: float = 13.0, deadly: bool = True) -> None:
        super().__init__(deadly=deadly)
        self.cx = float(cx)
        self.cy = float(cy)
        self.length = max(8.0, float(length))
        self.arms = int(clamp(int(arms), 1, 8))
        self.speed = float(speed)           # radians / second
        self.thickness = max(2.0, float(thickness))
        self.phase = float(phase)
        self.hub_radius = max(4.0, float(hub_radius))
        self.angle = self.phase

    def bounds(self) -> pygame.Rect:
        r = self.length + self.thickness
        return pygame.Rect(int(self.cx - r), int(self.cy - r), int(r * 2), int(r * 2))

    def avoid(self) -> Tuple[float, float, float]:
        return (self.cx, self.cy, self.length + self.thickness * 0.5 + 6.0)

    def _tips(self) -> List[Vec2]:
        out: List[Vec2] = []
        for i in range(self.arms):
            a = self.angle + i * TAU / self.arms
            out.append((self.cx + math.cos(a) * self.length,
                        self.cy + math.sin(a) * self.length))
        return out

    def _update(self, dt: float, t: float) -> None:
        self.angle = self.phase + t * self.speed

    def _collides(self, x: float, y: float, r: float) -> bool:
        reach = self.length + self.thickness * 0.5 + r
        dx, dy = x - self.cx, y - self.cy
        if dx * dx + dy * dy > reach * reach:      # cheap circular reject
            return False
        limit = self.thickness * 0.5 + r
        if dx * dx + dy * dy <= (self.hub_radius + r) ** 2:
            return True
        for tx, ty in self._tips():
            if _seg_distance(x, y, self.cx, self.cy, tx, ty) <= limit:
                return True
        return False

    def _draw(self, surface: pygame.Surface, theme: "P.Theme", t: float) -> None:
        tips = self._tips()
        for tx, ty in tips:
            _glow_line(surface, self.cx, self.cy, tx, ty, theme.hazard,
                       self.thickness * 1.5, 0.24, max_blobs=12)
        for tx, ty in tips:
            _neon_line(surface, self.cx, self.cy, tx, ty,
                       theme.hazard, self.thickness, core=0.55)
            # Heavy tip node - the part that actually catches players out.
            _add_glow(surface, tx, ty, self.thickness * 2.2, theme.accent2, 0.6)
            pygame.draw.circle(surface, P.lerp_color(theme.hazard, (255, 255, 255), 0.4),
                               (int(tx), int(ty)), int(self.thickness * 0.72))

        # Hub: a counter-rotating inner triangle so the spin direction is obvious.
        hr = self.hub_radius
        pygame.draw.circle(surface, P.shade(theme.hazard, 0.4),
                           (int(self.cx), int(self.cy)), int(hr))
        pygame.draw.circle(surface, theme.accent,
                           (int(self.cx), int(self.cy)), int(hr), 2)
        inner = []
        for i in range(3):
            a = -self.angle * 1.7 + i * TAU / 3.0
            inner.append((self.cx + math.cos(a) * hr * 0.55,
                          self.cy + math.sin(a) * hr * 0.55))
        pygame.draw.polygon(surface, theme.accent2, inner)
        _add_glow(surface, self.cx, self.cy, hr * 2.6, theme.accent,
                  0.30 + 0.14 * pulse(t, 4.0))


# ==========================================================================
# Pulsar - breathing bomb, deadly only while inflated
# ==========================================================================
class Pulsar(Obstacle):
    """
    A node that swells and shrinks on a cosine.  It only kills once its radius
    passes ``deadly_frac`` of the way from min to max, and it telegraphs that
    with a dashed threshold ring plus a colour shift from safe to hazard.
    """

    kind = "pulsar"

    def __init__(self, cx: float = 0.0, cy: float = 0.0, *,
                 min_radius: float = 12.0, max_radius: float = 62.0,
                 period: float = 2.6, phase: float = 0.0,
                 deadly_frac: float = 0.55, deadly: bool = True) -> None:
        super().__init__(deadly=False)
        self.cx = float(cx)
        self.cy = float(cy)
        self.min_radius = max(2.0, float(min_radius))
        self.max_radius = max(self.min_radius + 4.0, float(max_radius))
        self.period = max(0.25, float(period))
        self.phase = float(phase)
        self.deadly_frac = clamp(float(deadly_frac), 0.05, 0.95)
        self.armed = bool(deadly)           # a disarmed pulsar is decoration
        self.radius = self.min_radius
        self.charge = 0.0                   # 0..1, how close to arming
        self._update(0.0, 0.0)

    @property
    def threshold(self) -> float:
        """Radius at which the pulsar becomes lethal."""
        return lerp(self.min_radius, self.max_radius, self.deadly_frac)

    def bounds(self) -> pygame.Rect:
        r = self.max_radius
        return pygame.Rect(int(self.cx - r), int(self.cy - r), int(r * 2), int(r * 2))

    def avoid(self) -> Tuple[float, float, float]:
        return (self.cx, self.cy, self.max_radius + 8.0)

    def _update(self, dt: float, t: float) -> None:
        # 0.5 - 0.5*cos gives a smooth 0 -> 1 -> 0 with no corner at the peak.
        u = (t / self.period + self.phase) % 1.0
        s = 0.5 - 0.5 * math.cos(u * TAU)
        self.radius = lerp(self.min_radius, self.max_radius, s)
        self.charge = clamp(s / self.deadly_frac, 0.0, 1.0)
        self.deadly = self.armed and self.radius >= self.threshold

    def _collides(self, x: float, y: float, r: float) -> bool:
        if not self.deadly:
            return False
        dx, dy = x - self.cx, y - self.cy
        rr = self.radius + r
        return dx * dx + dy * dy <= rr * rr

    def _draw(self, surface: pygame.Surface, theme: "P.Theme", t: float) -> None:
        live = self.deadly
        col = P.lerp_color(theme.accent, theme.hazard, self.charge)
        ix, iy = int(self.cx), int(self.cy)

        # Threshold ring: a dashed circle at the arming radius, always visible.
        th = self.threshold
        ring = theme.hazard if live else P.shade(theme.hazard, 0.7)
        dashes = 22
        for i in range(dashes):
            if i % 2:
                continue
            a0 = i * TAU / dashes + t * 0.5
            a1 = a0 + TAU / dashes * 0.9
            pygame.draw.line(
                surface, ring,
                (self.cx + math.cos(a0) * th, self.cy + math.sin(a0) * th),
                (self.cx + math.cos(a1) * th, self.cy + math.sin(a1) * th), 2)

        # Charging tell: an inbound shockwave that lands exactly when it arms.
        if not live and self.charge > 0.55:
            warn = (self.charge - 0.55) / 0.45
            wr = lerp(th * 1.9, th, warn)
            pygame.draw.circle(surface, P.lerp_color(theme.accent, theme.hazard, warn),
                               (ix, iy), int(max(2.0, wr)), 2)

        # Body.
        _add_glow(surface, self.cx, self.cy, self.radius * 1.9, col,
                  0.34 + (0.34 if live else 0.0))
        pygame.draw.circle(surface, P.shade(col, 0.45), (ix, iy), int(self.radius))
        pygame.draw.circle(surface, col, (ix, iy), int(self.radius), 3)
        core = P.lerp_color(col, (255, 255, 255), 0.55 if live else 0.25)
        pygame.draw.circle(surface, core, (ix, iy),
                           int(max(2.0, self.radius * (0.30 + 0.12 * pulse(t, 7.0)))))
        if live:
            # Angry spikes while lethal - unmistakable at a glance.
            for i in range(8):
                a = t * 2.2 + i * TAU / 8.0
                r0, r1 = self.radius * 0.92, self.radius * 1.28
                pygame.draw.line(
                    surface, theme.hazard,
                    (self.cx + math.cos(a) * r0, self.cy + math.sin(a) * r0),
                    (self.cx + math.cos(a) * r1, self.cy + math.sin(a) * r1), 2)


# ==========================================================================
# LaserGate - charges, then fires
# ==========================================================================
class LaserGate(Obstacle):
    """
    A beam between two emitters that cycles charge -> fire -> charge.

    While charging it paints a hairline targeting ray (harmless); while firing
    it paints a thick, flickering beam that kills.  ``warn_time`` seconds
    before the shot the targeting ray brightens and thickens as a fair warning.
    """

    kind = "lasergate"

    def __init__(self, x1: float = 0.0, y1: float = 0.0,
                 x2: float = 0.0, y2: float = 0.0, *,
                 period: float = 3.0, fire_time: float = 0.9,
                 warn_time: float = 0.7, phase: float = 0.0,
                 width: float = 9.0, deadly: bool = True) -> None:
        super().__init__(deadly=False)
        self.x1, self.y1 = float(x1), float(y1)
        self.x2, self.y2 = float(x2), float(y2)
        self.period = max(0.4, float(period))
        self.fire_time = clamp(float(fire_time), 0.05, self.period * 0.9)
        self.warn_time = clamp(float(warn_time), 0.0, self.period - self.fire_time)
        self.phase = float(phase)
        self.width = max(2.0, float(width))
        self.armed = bool(deadly)
        self.firing = False
        self.warn = 0.0                     # 0..1 ramp just before firing
        self._update(0.0, 0.0)

    def bounds(self) -> pygame.Rect:
        pad = int(self.width + 8)
        left, right = min(self.x1, self.x2), max(self.x1, self.x2)
        top, bottom = min(self.y1, self.y2), max(self.y1, self.y2)
        return pygame.Rect(int(left) - pad, int(top) - pad,
                           int(right - left) + pad * 2, int(bottom - top) + pad * 2)

    def _update(self, dt: float, t: float) -> None:
        cycle = (t + self.phase * self.period) % self.period
        charge_len = self.period - self.fire_time
        self.firing = cycle >= charge_len
        if self.firing:
            self.warn = 1.0
        elif self.warn_time > 0.0:
            self.warn = clamp((cycle - (charge_len - self.warn_time)) / self.warn_time,
                              0.0, 1.0)
        else:
            self.warn = 0.0
        self.deadly = self.armed and self.firing

    def _collides(self, x: float, y: float, r: float) -> bool:
        if not self.deadly:
            return False
        return _seg_distance(x, y, self.x1, self.y1, self.x2, self.y2) \
            <= self.width * 0.5 + r

    def _draw(self, surface: pygame.Surface, theme: "P.Theme", t: float) -> None:
        hot = theme.hazard
        cold = theme.accent

        if self.firing:
            # 60 Hz-ish flicker keeps the beam from looking like a painted bar.
            flick = 0.86 + 0.14 * math.sin(t * 57.0)
            w = self.width * flick
            _glow_line(surface, self.x1, self.y1, self.x2, self.y2,
                       hot, w * 2.4, 0.42, max_blobs=26)
            _neon_line(surface, self.x1, self.y1, self.x2, self.y2, hot, w, core=0.85)
            pygame.draw.line(surface, (255, 255, 255),
                             (int(self.x1), int(self.y1)), (int(self.x2), int(self.y2)),
                             max(1, int(w * 0.25)))
        else:
            # Targeting ray: dashed, thin, brightening into the shot.
            col = P.lerp_color(P.shade(cold, 0.8), hot, self.warn)
            width = 1 + int(self.warn * 2.0)
            n = 26
            for i in range(n):
                if (i + int(t * 12.0)) % 2:
                    continue
                f0, f1 = i / n, (i + 0.72) / n
                pygame.draw.line(
                    surface, col,
                    (self.x1 + (self.x2 - self.x1) * f0,
                     self.y1 + (self.y2 - self.y1) * f0),
                    (self.x1 + (self.x2 - self.x1) * f1,
                     self.y1 + (self.y2 - self.y1) * f1), width)
            if self.warn > 0.01:
                _glow_line(surface, self.x1, self.y1, self.x2, self.y2,
                           hot, self.width * 1.2, 0.18 * self.warn, max_blobs=16)

        # Emitters at both ends, iris opening as the shot approaches.
        er = self.width * 0.9 + 5.0
        for (ex, ey) in ((self.x1, self.y1), (self.x2, self.y2)):
            _add_glow(surface, ex, ey, er * 2.4, hot if self.firing else cold,
                      0.34 + 0.4 * self.warn)
            pygame.draw.circle(surface, P.shade(theme.hazard, 0.35),
                               (int(ex), int(ey)), int(er))
            pygame.draw.circle(surface, cold if not self.firing else hot,
                               (int(ex), int(ey)), int(er), 2)
            pygame.draw.circle(surface, P.lerp_color(cold, (255, 255, 255), self.warn),
                               (int(ex), int(ey)),
                               int(max(1.0, er * (0.25 + 0.45 * self.warn))))


# ==========================================================================
# Portal - the only non-deadly obstacle
# ==========================================================================
class Portal(Obstacle):
    """
    A swirling gate. Entering one ejects the snake just outside its partner,
    preserving the direction of travel so momentum feels continuous.

    A short shared cooldown after each jump stops the pair from ping-ponging
    the head back and forth on consecutive frames.
    """

    kind = "portal"

    def __init__(self, x: float = 0.0, y: float = 0.0, *,
                 radius: float = 26.0, pair: Any = None) -> None:
        super().__init__(deadly=False)
        self.x = float(x)
        self.y = float(y)
        self.radius = max(8.0, float(radius))
        self.pair = pair                    # spec-level grouping key, if any
        self.linked: Optional["Portal"] = None
        self.cooldown: float = 0.0
        self.secondary: bool = False        # flips the colour of the B end
        self.spin: float = 0.0

    # -- linking -----------------------------------------------------------
    def link(self, other: "Portal") -> None:
        """Make this portal's exit `other` (and mark `other` as the B end)."""
        self.linked = other
        if other is not self:
            other.secondary = not self.secondary

    def bounds(self) -> pygame.Rect:
        r = self.radius
        return pygame.Rect(int(self.x - r), int(self.y - r), int(r * 2), int(r * 2))

    def avoid(self) -> Tuple[float, float, float]:
        return (self.x, self.y, self.radius + 14.0)

    def _update(self, dt: float, t: float) -> None:
        if self.cooldown > 0.0:
            self.cooldown = max(0.0, self.cooldown - dt)
        self.spin = t * 1.6

    def _collides(self, x: float, y: float, r: float) -> bool:
        if self.cooldown > 0.0:
            return False
        dx, dy = x - self.x, y - self.y
        # Slightly generous mouth so a fast head cannot skim the rim.
        rr = self.radius * 0.85 + r
        return dx * dx + dy * dy <= rr * rr

    # -- the actual trick --------------------------------------------------
    def teleport(self, x: float, y: float) -> Tuple[float, float]:
        """
        Return the exit position for something that entered here at (x, y).

        The offset from this portal's centre is reused as the exit direction,
        so a head that came in travelling right leaves travelling right.
        """
        try:
            dst = self.linked if self.linked is not None else self
            dx, dy = x - self.x, y - self.y
            d = math.hypot(dx, dy)
            if d < 1e-5:
                ux, uy = 1.0, 0.0
            else:
                ux, uy = dx / d, dy / d
            pad = dst.radius + PORTAL_EXIT_PAD
            ex, ey = dst.x + ux * pad, dst.y + uy * pad
            arena = dst.arena or self.arena
            if arena is not None:
                ex = clamp(ex, arena.left + 4.0, arena.right - 4.0)
                ey = clamp(ey, arena.top + 4.0, arena.bottom - 4.0)
            self.cooldown = PORTAL_COOLDOWN
            dst.cooldown = PORTAL_COOLDOWN
            return (ex, ey)
        except Exception:
            return (x, y)

    def _draw(self, surface: pygame.Surface, theme: "P.Theme", t: float) -> None:
        base = theme.accent2 if self.secondary else theme.accent
        r = self.radius
        ix, iy = int(self.x), int(self.y)
        ready = self.cooldown <= 0.0
        dim = 1.0 if ready else 0.4

        _add_glow(surface, self.x, self.y, r * 2.1, base, 0.42 * dim)
        # Dark throat so the gate reads as a hole, not a disc.
        pygame.draw.circle(surface, P.shade(theme.bg_bottom, 0.6), (ix, iy), int(r * 0.9))

        # Three counter-rotating arcs = vortex, for the price of three draws.
        for i in range(3):
            f = 0.95 - i * 0.20
            rr = int(r * f)
            box = pygame.Rect(ix - rr, iy - rr, rr * 2, rr * 2)
            a0 = self.spin * (1.0 + i * 0.55) + i * 1.1
            col = P.lerp_color(base, theme.food, i / 3.0)
            try:
                pygame.draw.arc(surface, P.shade(col, dim), box,
                                a0, a0 + TAU * 0.62, max(2, int(r * 0.12)))
            except Exception:
                pass

        pygame.draw.circle(surface, P.shade(base, 1.1 * dim), (ix, iy), int(r), 3)
        # Orbiting sparks along the rim.
        for i in range(6):
            a = -self.spin * 2.0 + i * TAU / 6.0
            px, py = self.x + math.cos(a) * r * 0.72, self.y + math.sin(a) * r * 0.72
            _add_glow(surface, px, py, 7.0, theme.food, 0.5 * dim)
        core = P.lerp_color(base, (255, 255, 255), 0.35 + 0.3 * pulse(t, 3.4))
        pygame.draw.circle(surface, P.shade(core, dim), (ix, iy),
                           int(max(2.0, r * 0.18)))


# ==========================================================================
# Spec-driven factory
# ==========================================================================
_TYPE_MAP: Dict[str, Type[Obstacle]] = {
    "wall": WallBlock,
    "wallblock": WallBlock,
    "block": WallBlock,
    "movingbar": MovingBar,
    "bar": MovingBar,
    "moving_bar": MovingBar,
    "spinner": Spinner,
    "pulsar": Pulsar,
    "lasergate": LaserGate,
    "laser": LaserGate,
    "laser_gate": LaserGate,
    "portal": Portal,
}

# Which keys are fractions of what.  Positions are offset from the arena
# origin; sizes are pure scalings.
_POS_X: Set[str] = {"x", "x1", "x2", "cx"}
_POS_Y: Set[str] = {"y", "y1", "y2", "cy"}
_SIZE_X: Set[str] = {"w", "width"}
_SIZE_Y: Set[str] = {"h", "height"}
_SIZE_MIN: Set[str] = {"length", "radius", "min_radius", "max_radius",
                       "thickness", "hub_radius"}
_SIZE_AXIS: Set[str] = {"travel", "distance", "amplitude"}

_SIG_CACHE: Dict[Type[Obstacle], Set[str]] = {}


def _params_of(cls: Type[Obstacle]) -> Set[str]:
    """Accepted constructor keyword names for `cls` (cached)."""
    names = _SIG_CACHE.get(cls)
    if names is None:
        try:
            names = {p for p in inspect.signature(cls.__init__).parameters
                     if p != "self"}
        except (TypeError, ValueError):     # pragma: no cover - exotic classes
            names = set()
        _SIG_CACHE[cls] = names
    return names


def _as_rect(rect: Any) -> pygame.Rect:
    """Accept a pygame.Rect, a contracts.Rect, or a 4-sequence."""
    for attr in ("x", "y", "w", "h"):
        if not hasattr(rect, attr):
            break
    else:
        return pygame.Rect(int(rect.x), int(rect.y), int(rect.w), int(rect.h))
    try:
        x, y, w, h = rect            # type: ignore[misc]
        return pygame.Rect(int(x), int(y), int(w), int(h))
    except Exception:
        return pygame.Rect(*C.ARENA_RECT)


def _resolve(key: str, value: Any, rect: pygame.Rect, horizontal: bool) -> Any:
    """
    Turn a fractional spec value into arena pixels.

    Any numeric position or size with ``abs(value) <= 1.0`` is read as a
    fraction of the arena; anything larger is already in pixels.  Non-geometry
    keys (speed, period, phase, arms, ...) are passed through untouched.
    """
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return value
    v = float(value)
    if abs(v) > 1.0:
        return v
    if key in _POS_X:
        return rect.x + rect.w * v
    if key in _POS_Y:
        return rect.y + rect.h * v
    if key in _SIZE_X:
        return rect.w * v
    if key in _SIZE_Y:
        return rect.h * v
    if key in _SIZE_MIN:
        return min(rect.w, rect.h) * v
    if key in _SIZE_AXIS:
        return (rect.w if horizontal else rect.h) * v
    return v


def _link_portals(portals: List[Portal]) -> None:
    """
    Wire portals into two-way pairs.

    Entries carrying an explicit ``pair`` key group by that key; the rest are
    chunked in declaration order.  Groups larger than two become a ring, and a
    lonely portal links to itself (harmless: it just spits you back out).
    """
    groups: Dict[Any, List[Portal]] = {}
    loose: List[Portal] = []
    for p in portals:
        if p.pair is None:
            loose.append(p)
        else:
            groups.setdefault(p.pair, []).append(p)
    for i in range(0, len(loose), 2):
        groups[("_auto", i)] = loose[i:i + 2]

    for members in groups.values():
        n = len(members)
        if n == 1:
            members[0].linked = members[0]
            continue
        for i, p in enumerate(members):
            p.secondary = bool(i % 2)
            p.linked = members[(i + 1) % n]


def build_obstacles(spec: Optional[Iterable[Any]], rect: Any) -> List[Obstacle]:
    """
    Build a hazard list from plain dicts.

    Each entry needs a ``"type"`` key naming a class in lowercase; the rest of
    the dict becomes constructor keywords, with fractional geometry resolved
    against `rect`.  Unknown types, malformed entries and constructor errors
    are skipped silently - a level with a typo loses one hazard, not the game.
    """
    out: List[Obstacle] = []
    arena = _as_rect(rect)
    if not spec:
        return out

    portals: List[Portal] = []
    try:
        entries = list(spec)
    except Exception:
        return out

    for raw in entries:
        try:
            if not isinstance(raw, dict):
                continue
            name = str(raw.get("type", "")).strip().lower().replace("-", "_")
            cls = _TYPE_MAP.get(name)
            if cls is None:
                continue

            axis = str(raw.get("axis", "x")).strip().lower()
            horizontal = axis not in ("y", "v", "vertical", "1")

            accepted = _params_of(cls)
            kwargs: Dict[str, Any] = {}
            for key, value in raw.items():
                if key == "type" or key not in accepted:
                    continue
                kwargs[key] = _resolve(key, value, arena, horizontal)

            ob = cls(**kwargs)
            ob.arena = arena
            out.append(ob)
            if isinstance(ob, Portal):
                portals.append(ob)
        except Exception:
            continue

    _link_portals(portals)
    return out


def obstacle_avoid_list(obstacles: Iterable[Obstacle]) -> List[Tuple[float, float, float]]:
    """Keep-out circles for every hazard, ready to hand to a spawner's `avoid`."""
    out: List[Tuple[float, float, float]] = []
    for ob in obstacles:
        try:
            out.append(ob.avoid())
        except Exception:
            continue
    return out


def update_obstacles(obstacles: Iterable[Obstacle], dt: float, t: float) -> None:
    """Convenience: advance a whole list."""
    for ob in obstacles:
        ob.update(dt, t)


def draw_obstacles(surface: pygame.Surface, obstacles: Iterable[Obstacle],
                   theme: "P.Theme", t: float) -> None:
    """Convenience: draw a whole list, portals first so hazards read on top."""
    for ob in obstacles:
        if isinstance(ob, Portal):
            ob.draw(surface, theme, t)
    for ob in obstacles:
        if not isinstance(ob, Portal):
            ob.draw(surface, theme, t)


__all__ = [
    "Obstacle", "WallBlock", "MovingBar", "Spinner", "Pulsar", "LaserGate",
    "Portal", "build_obstacles", "obstacle_avoid_list", "update_obstacles",
    "draw_obstacles",
]
