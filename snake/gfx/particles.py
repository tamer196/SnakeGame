"""
Additive particle system for NEON SERPENT.

This is the visual backbone of the game: the snake's slither trail, pickup
bursts, death explosions, portal shockwaves, drifting ambient motes, victory
confetti and stray sparks are all emitted from here.

Design notes
------------
*   Particles are lightweight `__slots__` records held in one flat list.  Dead
    records are recycled through a free pool, so a busy frame allocates almost
    nothing.
*   Every "soft" particle is drawn by blitting a **pre-rendered glow sprite**
    with ``BLEND_RGB_ADD``.  Sprites are cached by (radius bucket, quantised
    colour); the fade of a particle is baked into the colour bucket, because
    ``BLEND_RGB_ADD`` ignores per-surface alpha - dimming means "add less
    light", i.e. a darker source pixel.  Nothing is ever rasterised per
    particle per frame.
*   Particles that are *geometry* rather than blobs (``spark`` streaks,
    ``shard`` triangles, ``ring`` shockwaves, ``trail`` ribbons, ``bolt``
    lightning and ``star`` twinkles) are drawn into one reusable full-size
    scratch layer which is composited once with ``BLEND_RGB_ADD``.  That keeps
    the additive look without a surface allocation per particle.
*   Two optional per-particle animators sit on top of that: ``color_end`` fades
    a particle from its birth colour to a second colour over its life (hot
    white -> theme colour -> black is the house style), and ``turbulence``
    applies a smooth, curl-like drift so bursts swirl instead of flying in
    straight lines.  Both are opt-in and cost nothing when unused.

Nothing in this module may raise: update and draw are wrapped so a bad value
degrades into a missing particle instead of a crash.
"""

from __future__ import annotations

import math
import random
from typing import Dict, List, Optional, Sequence, Tuple, Union

import pygame

from .. import config as C
from .. import palette as P
from ..core.contracts import TAU, clamp

RGB = Tuple[int, int, int]
Ranged = Union[float, Tuple[float, float], Sequence[float]]

# Every renderable particle kind.
#   dot    - soft round blob (the workhorse)
#   spark  - velocity-aligned streak
#   ember  - blob that twinkles on a per-particle phase
#   shard  - spinning irregular triangle
#   ring   - hollow expanding shockwave
#   trail  - tapered ribbon stretched between last and current position
#   bolt   - short jagged lightning segment
#   smoke  - soft puff that expands and fades away
#   star   - four-point twinkle
KINDS: Tuple[str, ...] = ("dot", "spark", "ember", "shard", "ring",
                          "trail", "bolt", "smoke", "star")

# Kinds that need vector drawing on the scratch layer rather than a glow blit.
_GEOMETRY_KINDS = frozenset(("spark", "shard", "ring", "trail", "bolt", "star"))

# Geometry kinds that must NOT get a soft glow blob under them: a ring is
# hollow by definition and a ribbon already carries its own body.
_NO_CORE_KINDS = frozenset(("ring", "trail"))

# --------------------------------------------------------------------------
# Glow sprite cache
# --------------------------------------------------------------------------
# Colour channels are quantised to this many levels before a sprite is cached.
# 10 levels x 3 channels is plenty: the eye cannot see a 1/10th step in the
# brightness of a 4-pixel blob, and it keeps the cache in the low hundreds.
_COLOR_LEVELS = 10
_COLOR_STEP = 255.0 / (_COLOR_LEVELS - 1)

# Above this many cached sprites we throw the whole cache away and start over.
# In practice a level uses far fewer; the cap only guards pathological input.
_CACHE_LIMIT = 768

_GLOW_CACHE: Dict[Tuple[int, int, int, int], pygame.Surface] = {}

# Concentric bands used to rasterise one glow sprite.  More bands = smoother
# falloff but a slower (one-off) build.
_GLOW_BANDS = 12

# A glow sprite is much larger than the particle's solid core - the halo *is*
# the neon look.  sprite_radius = core * _GLOW_EXTENT + _GLOW_PAD, so even a
# 2px mote gets a visible bloom around it.
_GLOW_EXTENT = 2.0
_GLOW_PAD = 2.5

_WHITE: RGB = (255, 255, 255)
_BLACK: RGB = (0, 0, 0)


def _bucket_radius(r: float) -> int:
    """Snap a radius onto a coarse ladder so sprites are shared aggressively."""
    if r <= 2.0:
        return 2
    if r < 16.0:
        return int(r + 0.5)
    if r < 40.0:
        return int(r * 0.5 + 0.5) * 2
    return min(120, int(r * 0.25 + 0.5) * 4)


def _quantise_channel(v: float) -> int:
    """One channel -> its cache level.  ParticleSystem.draw inlines this
    exact expression in its hot loop, so the two must stay identical: a
    mismatched key would miss the cache forever and rebuild every frame."""
    if v <= 0.0:
        return 0
    return int((255.0 if v > 255.0 else v) / _COLOR_STEP + 0.5)


def _quantise(color: Sequence[float], f: float) -> Tuple[int, int, int]:
    """Return `color` scaled by brightness `f`, snapped to the cache levels."""
    if f <= 0.0:
        return (0, 0, 0)
    return (_quantise_channel(color[0] * f),
            _quantise_channel(color[1] * f),
            _quantise_channel(color[2] * f))


def _level_color(q: Tuple[int, int, int]) -> RGB:
    """Turn a quantised cache key back into a real RGB colour."""
    return (P.clamp8(q[0] * _COLOR_STEP),
            P.clamp8(q[1] * _COLOR_STEP),
            P.clamp8(q[2] * _COLOR_STEP))


def _build_glow(radius: int, color: RGB) -> pygame.Surface:
    """
    Rasterise one radial glow sprite: solid core + soft falloff halo.

    The surface has no alpha channel: with BLEND_RGB_ADD a black pixel adds
    nothing, so the square corners are invisible and we save the per-pixel
    alpha work entirely.
    """
    ext = max(2, int(radius * _GLOW_EXTENT + _GLOW_PAD))    # sprite radius
    size = ext * 2
    surf = pygame.Surface((size, size))
    surf.fill((0, 0, 0))
    c = int(ext)
    # `core` is the fraction of the sprite that is fully lit; everything
    # outside it falls off quadratically to nothing at the rim.
    core = clamp(radius / float(ext), 0.05, 0.95)
    # Draw outer -> inner so each brighter band overwrites the dimmer one.
    for band in range(_GLOW_BANDS, 0, -1):
        q = band / _GLOW_BANDS                 # 1.0 at the rim, ~0 at the core
        if q <= core:
            inten = 1.0
        else:
            fall = (q - core) / (1.0 - core)   # 0 at the core edge, 1 at rim
            inten = (1.0 - fall) ** 2.0
        band_col = P.shade(color, inten)
        if band_col[0] or band_col[1] or band_col[2]:
            pygame.draw.circle(surf, band_col, (c, c), max(1, int(ext * q)))
    # A white-hot centre: additive light saturates toward white in reality,
    # and it keeps small particles from looking like flat coloured dots.
    hot = P.lerp_color(color, (255, 255, 255), 0.45)
    pygame.draw.circle(surf, hot, (c, c), max(1, int(radius * 0.45)))
    try:
        return surf.convert()
    except Exception:            # no display surface yet (headless / early boot)
        return surf


def glow_sprite(radius: float, color: Sequence[float], fade: float = 1.0) -> Optional[pygame.Surface]:
    """
    Cached additive glow sprite for a radius/colour/brightness combination.

    Returns None when the result would be pure black (nothing to add).
    """
    rb = _bucket_radius(radius)
    q = _quantise(color, fade)
    if not (q[0] or q[1] or q[2]):
        return None
    key = (rb, q[0], q[1], q[2])
    surf = _GLOW_CACHE.get(key)
    if surf is None:
        if len(_GLOW_CACHE) >= _CACHE_LIMIT:
            _GLOW_CACHE.clear()
        surf = _build_glow(rb, _level_color(q))
        _GLOW_CACHE[key] = surf
    return surf


def clear_glow_cache() -> None:
    """Drop every cached sprite (call on a display-mode change)."""
    _GLOW_CACHE.clear()


# --------------------------------------------------------------------------
# Small helpers
# --------------------------------------------------------------------------
def _rng_range(v: Ranged, default: float = 0.0) -> float:
    """Accept either a scalar or a (lo, hi) pair and produce a value."""
    try:
        if isinstance(v, (int, float)):
            return float(v)
        lo = float(v[0])
        hi = float(v[1])
        return lo if hi <= lo else random.uniform(lo, hi)
    except Exception:
        return default


def _as_rgb(color: Sequence[int]) -> RGB:
    """Coerce anything colour-shaped into a plain 3-tuple of ints."""
    try:
        return (P.clamp8(color[0]), P.clamp8(color[1]), P.clamp8(color[2]))
    except Exception:
        return P.UI_WHITE


def _opt_rgb(color: Optional[Sequence[int]]) -> Optional[RGB]:
    """`_as_rgb` that passes None through (for the optional end colour)."""
    if color is None:
        return None
    return _as_rgb(color)


def _rect_bounds(rect: object) -> Tuple[float, float, float, float]:
    """Read x/y/w/h from a pygame.Rect, a contracts.Rect or a 4-tuple."""
    try:
        return (float(getattr(rect, "x")), float(getattr(rect, "y")),
                float(getattr(rect, "w")), float(getattr(rect, "h")))
    except Exception:
        try:
            return (float(rect[0]), float(rect[1]), float(rect[2]), float(rect[3]))  # type: ignore[index]
        except Exception:
            return (0.0, 0.0, 0.0, 0.0)


def _emit_count(rate: float, dt: float) -> int:
    """
    How many particles to emit this frame for a per-second `rate`.

    The fractional remainder is resolved stochastically, which keeps emission
    smooth without an accumulator per caller.
    """
    n = rate * dt
    if n <= 0.0:
        return 0
    whole = int(n)
    if random.random() < (n - whole):
        whole += 1
    return whole if whole < 64 else 64      # sanity cap on a monster dt


def hot_white(color: Sequence[int], amount: float = 0.7) -> RGB:
    """The "just ignited" version of a colour: pushed toward white."""
    return P.lerp_color(_as_rgb(color), _WHITE, clamp(amount, 0.0, 1.0))


# --------------------------------------------------------------------------
# Particle record
# --------------------------------------------------------------------------
class Particle:
    """One live particle.  Deliberately a slots class, not a dataclass."""

    __slots__ = ("x", "y", "vx", "vy", "radius", "r0", "color", "life",
                 "max_life", "drag", "gravity", "glow", "shrink", "spin",
                 "angle", "grow", "kind", "seed", "px", "py", "color_end",
                 "turbulence")

    def __init__(self) -> None:
        self.x = 0.0
        self.y = 0.0
        self.vx = 0.0
        self.vy = 0.0
        self.radius = 1.0
        self.r0 = 1.0
        self.color: RGB = (255, 255, 255)
        self.life = 0.0
        self.max_life = 1.0
        self.drag = 0.0
        self.gravity = 0.0
        self.glow = True
        self.shrink = True
        self.spin = 0.0
        self.angle = 0.0
        self.grow = 0.0
        self.kind = "dot"
        self.seed = 0.0
        # Previous position, used by the ``trail`` ribbon.
        self.px = 0.0
        self.py = 0.0
        # Optional end-of-life colour and curl drift strength.
        self.color_end: Optional[RGB] = None
        self.turbulence = 0.0

    def reset(self, x: float, y: float, vx: float, vy: float, radius: float,
              color: RGB, life: float, drag: float, gravity: float,
              glow: bool, shrink: bool, spin: float, kind: str,
              grow: float = 0.0, color_end: Optional[RGB] = None,
              turbulence: float = 0.0) -> None:
        """Re-arm a pooled record.  Trailing arguments are optional so older
        callers that pass the original thirteen positionally still work."""
        self.x = x
        self.y = y
        self.px = x
        self.py = y
        self.vx = vx
        self.vy = vy
        self.radius = radius
        self.r0 = radius
        self.color = color
        self.life = life
        self.max_life = life if life > 1e-6 else 1e-6
        self.drag = drag
        self.gravity = gravity
        self.glow = glow
        self.shrink = shrink
        self.spin = spin
        self.angle = random.uniform(0.0, TAU)
        self.grow = grow
        self.kind = kind
        self.seed = random.uniform(0.0, TAU)
        self.color_end = color_end
        self.turbulence = turbulence


def _blend_color(p: Particle, fade: float) -> Sequence[float]:
    """
    The particle's colour right now.

    With no ``color_end`` this is just the birth colour (no arithmetic at all).
    Otherwise it is a linear ramp from ``color`` at birth to ``color_end`` at
    death, returned as floats - every consumer either quantises it or hands it
    to ``P.shade``, both of which cope with non-integers.
    """
    end = p.color_end
    if end is None:
        return p.color
    u = 1.0 - fade
    if u <= 0.0:
        return p.color
    if u >= 1.0:
        return end
    a = p.color
    return (a[0] + (end[0] - a[0]) * u,
            a[1] + (end[1] - a[1]) * u,
            a[2] + (end[2] - a[2]) * u)


# --------------------------------------------------------------------------
# The system
# --------------------------------------------------------------------------
class ParticleSystem:
    """A flat, hard-capped pool of additive particles."""

    def __init__(self, max_particles: int = C.MAX_PARTICLES) -> None:
        self.max_particles = int(max(16, max_particles))
        self._items: List[Particle] = []
        self._pool: List[Particle] = []
        self._pool_cap = self.max_particles
        self._t = 0.0
        self._layer: Optional[pygame.Surface] = None
        self._layer_size: Tuple[int, int] = (0, 0)

    # -- housekeeping ------------------------------------------------------
    def count(self) -> int:
        """Number of live particles."""
        return len(self._items)

    def __len__(self) -> int:
        return len(self._items)

    def clear(self) -> None:
        """Kill everything instantly (scene changes, restarts)."""
        if len(self._pool) < self._pool_cap:
            self._pool.extend(self._items[: self._pool_cap - len(self._pool)])
        self._items.clear()

    def headroom(self) -> int:
        """How many more particles fit before the cap starts evicting."""
        return max(0, self.max_particles - len(self._items))

    def _acquire(self) -> Optional[Particle]:
        """Get a free record, evicting the oldest particle when at capacity."""
        items = self._items
        pool = self._pool
        over = len(items) - self.max_particles + 1
        if over > 0:
            # Oldest live particles sit at the front of the list.
            room = self._pool_cap - len(pool)
            if room > 0:
                pool.extend(items[:min(over, room)])
            del items[:over]
        return pool.pop() if pool else Particle()

    # -- emission ----------------------------------------------------------
    def spawn(self, x: float, y: float, *, vx: float = 0.0, vy: float = 0.0,
              radius: float = 3.0, color: Sequence[int] = (255, 255, 255),
              life: float = 0.8, drag: float = 1.6, gravity: float = 0.0,
              glow: bool = True, shrink: bool = True, spin: float = 0.0,
              kind: str = "dot", grow: float = 0.0,
              color_end: Optional[Sequence[int]] = None,
              turbulence: float = 0.0) -> Optional[Particle]:
        """
        Add a single particle.  Never raises; returns the record or None.

        `color_end` (optional) makes the particle ramp from `color` at birth to
        `color_end` at death.  `turbulence` (px/s^2) adds smooth curl-like
        drift so the particle swirls instead of travelling in a straight line.
        """
        try:
            # Reject NaN / inf up front.  A single non-finite particle would
            # otherwise throw inside the draw loop every frame it lives for,
            # taking the whole frame's particles with it.  Summing first means
            # one isfinite() call covers every field (NaN and inf propagate).
            if not math.isfinite(x + y + vx + vy + radius + life + drag
                                 + gravity + spin + grow + turbulence):
                return None
            p = self._acquire()
            if p is None:
                return None
            if kind not in KINDS:
                kind = "dot"
            p.reset(float(x), float(y), float(vx), float(vy),
                    max(0.5, float(radius)), _as_rgb(color),
                    max(0.01, float(life)), float(drag), float(gravity),
                    bool(glow), bool(shrink), float(spin), kind, float(grow),
                    _opt_rgb(color_end), float(turbulence))
            self._items.append(p)
            return p
        except Exception:
            return None

    def burst(self, x: float, y: float, color: Sequence[int], count: int = 18,
              speed: Ranged = (40.0, 190.0), life: Ranged = (0.35, 0.9),
              radius: Ranged = (2.0, 5.0), spread: Optional[float] = None,
              direction: Optional[float] = None, glow: bool = True,
              *, color_end: Optional[Sequence[int]] = None,
              turbulence: float = 0.0, gravity: float = 0.0,
              kind: Optional[str] = None) -> None:
        """
        Explode `count` particles out of a point.

        `direction` is the centre angle in radians (None = all directions);
        `spread` is the total cone width in radians.  The keyword-only extras
        (`color_end`, `turbulence`, `gravity`, `kind`) are new and default to
        the original behaviour.
        """
        try:
            rgb = _as_rgb(color)
            end = _opt_rgb(color_end)
            if direction is None:
                base = 0.0
                half = math.pi if spread is None else float(spread) * 0.5
                omni = spread is None
            else:
                base = float(direction)
                half = (0.9 if spread is None else float(spread)) * 0.5
                omni = False
            n = int(clamp(count, 0, 400))
            for i in range(n):
                if omni:
                    # Even angular spacing plus jitter avoids clumpy explosions.
                    ang = (i / n) * TAU + random.uniform(-0.22, 0.22)
                else:
                    ang = base + random.uniform(-half, half)
                sp = _rng_range(speed, 90.0)
                r = _rng_range(radius, 3.0)
                # Small particles are flung further: reads as a hot core with
                # fast outriders instead of a uniform shell.
                sp *= clamp(1.25 - 0.10 * r, 0.35, 1.25)
                k = kind if kind is not None else \
                    ("spark" if (glow and i % 4 == 0) else "dot")
                self.spawn(x, y,
                           vx=math.cos(ang) * sp, vy=math.sin(ang) * sp,
                           radius=r, color=rgb, life=_rng_range(life, 0.6),
                           drag=random.uniform(1.4, 2.6), glow=glow,
                           spin=random.uniform(-7.0, 7.0),
                           gravity=gravity, color_end=end,
                           turbulence=turbulence, kind=k)
        except Exception:
            pass

    def trail(self, x: float, y: float, color: Sequence[int], dt: float,
              rate: float = C.TRAIL_EMIT_RATE, spread: float = 0.9,
              speed: Ranged = (8.0, 44.0), life: Ranged = (0.25, 0.6),
              radius: Ranged = (2.0, 5.0),
              *, color_end: Optional[Sequence[int]] = None,
              turbulence: float = 0.0, ribbon: float = 0.0) -> None:
        """
        Continuous emission from a moving point (the snake head).

        `ribbon` (0..1, new) is the chance that an emitted particle is a
        stretched ``trail`` ribbon rather than a blob, for a silkier wake.
        """
        try:
            rgb = _as_rgb(color)
            end = _opt_rgb(color_end)
            rib = clamp(ribbon, 0.0, 1.0)
            for _ in range(_emit_count(rate, dt)):
                ang = random.uniform(0.0, TAU)
                sp = _rng_range(speed, 24.0)
                # Jitter the origin a touch so the trail has body, not a wire.
                jx = x + math.cos(ang) * spread * 3.0
                jy = y + math.sin(ang) * spread * 3.0
                roll = random.random()
                if roll < rib:
                    k = "trail"
                elif roll < rib + 0.22:
                    k = "ember"
                else:
                    k = "dot"
                self.spawn(jx, jy,
                           vx=math.cos(ang) * sp, vy=math.sin(ang) * sp,
                           radius=_rng_range(radius, 3.0), color=rgb,
                           life=_rng_range(life, 0.4), drag=2.2,
                           color_end=end, turbulence=turbulence, kind=k)
        except Exception:
            pass

    def ring(self, x: float, y: float, color: Sequence[int], radius: float = 40.0,
             count: int = 26, life: float = 0.6, speed: float = 120.0,
             *, color_end: Optional[Sequence[int]] = None,
             width: float = 0.10) -> None:
        """A shockwave: one expanding hollow circle plus a ring of outriders."""
        try:
            rgb = _as_rgb(color)
            end = _opt_rgb(color_end)
            life = max(0.05, float(life))
            # The hollow circle grows from a point to `radius` over its life.
            wave = self.spawn(x, y, radius=max(2.0, radius * 0.12), color=rgb,
                              life=life, drag=0.0, shrink=False, kind="ring",
                              grow=max(0.0, radius) / life, color_end=end)
            if wave is not None:
                # `spin` is unused by rings, so it carries the stroke width
                # fraction instead - no extra slot for a one-kind parameter.
                wave.spin = clamp(width, 0.02, 0.5)
            n = int(clamp(count, 0, 200))
            for i in range(n):
                ang = (i / n) * TAU
                ca, sa = math.cos(ang), math.sin(ang)
                r0 = radius * 0.18
                self.spawn(x + ca * r0, y + sa * r0,
                           vx=ca * speed, vy=sa * speed,
                           radius=random.uniform(2.0, 4.0), color=rgb,
                           life=life * random.uniform(0.6, 1.1), drag=2.4,
                           color_end=end)
        except Exception:
            pass

    def spark_line(self, x1: float, y1: float, x2: float, y2: float,
                   color: Sequence[int], count: int = 12, life: float = 0.4,
                   *, color_end: Optional[Sequence[int]] = None,
                   bolts: int = 0) -> None:
        """
        Scatter sparks along a segment (laser gates, self-collision flashes).

        `bolts` (new) additionally drops that many jagged lightning fragments
        along the same line.
        """
        try:
            rgb = _as_rgb(color)
            end = _opt_rgb(color_end)
            dx, dy = x2 - x1, y2 - y1
            length = math.hypot(dx, dy)
            if length < 1e-6:
                nx, ny = 0.0, -1.0
            else:
                # Unit normal to the segment: sparks kick sideways off the line.
                nx, ny = -dy / length, dx / length
            n = int(clamp(count, 0, 200))
            for i in range(n):
                t = (i + random.random()) / max(1, n)
                px = x1 + dx * t
                py = y1 + dy * t
                side = random.choice((-1.0, 1.0))
                sp = random.uniform(50.0, 180.0)
                self.spawn(px, py,
                           vx=nx * side * sp + random.uniform(-30.0, 30.0),
                           vy=ny * side * sp + random.uniform(-30.0, 30.0),
                           radius=random.uniform(1.8, 3.4), color=rgb,
                           life=max(0.05, life) * random.uniform(0.6, 1.2),
                           drag=3.0, color_end=end, kind="spark")
            for _ in range(int(clamp(bolts, 0, 40))):
                t = random.random()
                self.spawn(x1 + dx * t, y1 + dy * t,
                           radius=random.uniform(3.0, 6.0),
                           color=hot_white(rgb, 0.5), color_end=end or rgb,
                           life=max(0.05, life) * random.uniform(0.4, 0.8),
                           drag=6.0, shrink=False, kind="bolt")
        except Exception:
            pass

    def ambient(self, rect: object, color: Sequence[int], dt: float,
                rate: float = 6.0, *, turbulence: float = 0.0,
                twinkle: float = 0.0) -> None:
        """
        Slow drifting motes inside `rect`, for atmosphere behind the action.

        `twinkle` (0..1, new) is the chance a mote is a four-point ``star``.
        """
        try:
            x, y, w, h = _rect_bounds(rect)
            if w <= 1.0 or h <= 1.0:
                return
            rgb = _as_rgb(color)
            tw = clamp(twinkle, 0.0, 1.0)
            for _ in range(_emit_count(rate, dt)):
                roll = random.random()
                if roll < tw:
                    k = "star"
                elif roll < tw + 0.08:
                    k = "shard"
                else:
                    k = "dot"
                self.spawn(x + random.random() * w, y + random.random() * h,
                           vx=random.uniform(-14.0, 14.0),
                           vy=random.uniform(-22.0, -4.0),
                           radius=random.uniform(1.6, 3.6), color=rgb,
                           life=random.uniform(2.0, 5.0), drag=0.25,
                           shrink=False, kind=k, turbulence=turbulence,
                           spin=random.uniform(-1.6, 1.6))
        except Exception:
            pass

    # -- new emitters ------------------------------------------------------
    def explosion(self, x: float, y: float, color: Sequence[int],
                  power: float = 1.0, *, smoke: bool = True,
                  gravity: float = 0.0) -> None:
        """
        A layered detonation: shockwave ring, shards, embers, smoke and bolts.

        `power` scales both the particle counts and the reach; 1.0 is a food
        orb popping, 2.5 is a death.  The whole thing is one call so callers
        do not have to hand-tune four emitters to get a good bang.
        """
        try:
            pw = clamp(power, 0.15, 4.0)
            rgb = _as_rgb(color)
            hot = hot_white(rgb, 0.72)
            dark = P.shade(rgb, 0.06)

            # 1. shockwave: hot at birth, cooling into the base colour.
            self.ring(x, y, hot, radius=64.0 * pw, count=int(8 * pw),
                      life=0.34 + 0.16 * pw, speed=150.0 * pw,
                      color_end=rgb, width=0.09)

            # 2. shards - the fast, hard-edged debris.
            n = int(clamp(9.0 * pw, 3, 46))
            for i in range(n):
                ang = (i / n) * TAU + random.uniform(-0.3, 0.3)
                sp = random.uniform(120.0, 340.0) * pw
                self.spawn(x, y, vx=math.cos(ang) * sp, vy=math.sin(ang) * sp,
                           radius=random.uniform(2.4, 5.2) * (0.7 + 0.3 * pw),
                           color=hot, color_end=dark,
                           life=random.uniform(0.35, 0.75) * (0.8 + 0.3 * pw),
                           drag=2.2, gravity=gravity, kind="shard",
                           spin=random.uniform(-10.0, 10.0), turbulence=40.0)

            # 3. embers - slower, twinkling, swirled by turbulence.
            n = int(clamp(15.0 * pw, 6, 70))
            for i in range(n):
                ang = random.uniform(0.0, TAU)
                sp = random.uniform(30.0, 210.0) * pw
                self.spawn(x, y, vx=math.cos(ang) * sp, vy=math.sin(ang) * sp,
                           radius=random.uniform(1.8, 4.2),
                           color=hot, color_end=dark,
                           life=random.uniform(0.5, 1.3),
                           drag=1.7, gravity=gravity, kind="ember",
                           turbulence=random.uniform(30.0, 95.0))

            # 4. smoke - soft expanding puffs that linger after the light dies.
            if smoke:
                n = int(clamp(6.0 * pw, 2, 26))
                for _ in range(n):
                    ang = random.uniform(0.0, TAU)
                    sp = random.uniform(10.0, 70.0) * pw
                    r = random.uniform(7.0, 15.0) * (0.7 + 0.4 * pw)
                    self.spawn(x, y,
                               vx=math.cos(ang) * sp, vy=math.sin(ang) * sp,
                               radius=r, color=P.shade(rgb, 0.5),
                               color_end=_BLACK,
                               life=random.uniform(0.7, 1.5), drag=1.1,
                               shrink=False, grow=r * 1.4, kind="smoke",
                               turbulence=random.uniform(10.0, 40.0))

            # 5. a couple of lightning fragments for the first instant.
            for _ in range(int(clamp(2.0 * pw, 1, 8))):
                ang = random.uniform(0.0, TAU)
                sp = random.uniform(60.0, 180.0) * pw
                self.spawn(x, y, vx=math.cos(ang) * sp, vy=math.sin(ang) * sp,
                           radius=random.uniform(4.0, 8.0) * pw,
                           color=hot, color_end=rgb,
                           life=random.uniform(0.10, 0.22), drag=5.0,
                           shrink=False, kind="bolt")
        except Exception:
            pass

    def confetti(self, rect: object, colors: Sequence[Sequence[int]],
                 count: int = 70, *, life: Ranged = (1.6, 3.4),
                 gravity: float = 240.0, from_top: bool = True) -> None:
        """
        Victory-screen confetti: spinning shards raining through `rect`.

        `colors` is a palette to pick from (empty falls back to gold/white).
        With `from_top` the shards start just above the rect and fall through
        it; otherwise they are scattered across the whole rect at once.
        """
        try:
            x, y, w, h = _rect_bounds(rect)
            if w <= 1.0 or h <= 1.0:
                return
            pal: List[RGB] = [_as_rgb(c) for c in colors] if colors else []
            if not pal:
                pal = [P.UI_GOLD, P.UI_WHITE, P.UI_GOOD]
            n = int(clamp(count, 0, 400))
            for i in range(n):
                col = pal[i % len(pal)]
                cx = x + random.random() * w
                cy = (y - random.random() * h * 0.45) if from_top \
                    else (y + random.random() * h)
                self.spawn(cx, cy,
                           vx=random.uniform(-70.0, 70.0),
                           vy=random.uniform(20.0, 130.0),
                           radius=random.uniform(2.6, 5.4), color=col,
                           color_end=P.shade(col, 0.25),
                           life=_rng_range(life, 2.2), drag=0.55,
                           gravity=gravity, shrink=False,
                           spin=random.uniform(-9.0, 9.0),
                           turbulence=random.uniform(20.0, 70.0),
                           kind="star" if (i % 5 == 0) else "shard")
        except Exception:
            pass

    def stream(self, x: float, y: float, angle: float, color: Sequence[int],
               dt: float, rate: float = 90.0, *, speed: Ranged = (140.0, 300.0),
               spread: float = 0.30, life: Ranged = (0.25, 0.6),
               radius: Ranged = (2.0, 4.5),
               color_end: Optional[Sequence[int]] = None,
               turbulence: float = 0.0, drag: float = 1.4) -> None:
        """
        A directed jet: continuous emission in a narrow cone about `angle`.

        Use for boost thrust, portal exhaust or a hazard vent.  Like `trail`
        this is rate-based, so pass the frame `dt`.
        """
        try:
            rgb = _as_rgb(color)
            end = _opt_rgb(color_end)
            half = max(0.0, float(spread)) * 0.5
            for _ in range(_emit_count(rate, dt)):
                ang = float(angle) + random.uniform(-half, half)
                sp = _rng_range(speed, 200.0)
                self.spawn(x, y,
                           vx=math.cos(ang) * sp, vy=math.sin(ang) * sp,
                           radius=_rng_range(radius, 3.0), color=rgb,
                           color_end=end, life=_rng_range(life, 0.4),
                           drag=drag, turbulence=turbulence,
                           kind="spark" if random.random() < 0.3 else "dot")
        except Exception:
            pass

    def implode(self, x: float, y: float, color: Sequence[int],
                radius: float = 90.0, count: int = 26, life: float = 0.5,
                *, swirl: float = 1.1,
                color_end: Optional[Sequence[int]] = None) -> None:
        """
        Particles converging inward onto (x, y) - a portal or pickup "suck".

        They start on a circle of `radius` and are given exactly the inward
        speed that lands them on the centre as they expire (drag is off, so
        the arrival is dead on), plus a tangential `swirl` component so the
        collapse spirals.
        """
        try:
            rgb = _as_rgb(color)
            end = _opt_rgb(color_end) or hot_white(rgb, 0.8)
            rad = max(4.0, float(radius))
            lf = max(0.08, float(life))
            n = int(clamp(count, 0, 240))
            for i in range(n):
                ang = (i / max(1, n)) * TAU + random.uniform(-0.12, 0.12)
                ca, sa = math.cos(ang), math.sin(ang)
                jitter = random.uniform(0.82, 1.12)
                r = rad * jitter
                inward = -r / lf
                tang = swirl * r / lf
                self.spawn(x + ca * r, y + sa * r,
                           vx=ca * inward - sa * tang,
                           vy=sa * inward + ca * tang,
                           radius=random.uniform(2.0, 4.0), color=rgb,
                           color_end=end,
                           life=lf * random.uniform(0.85, 1.0),
                           drag=0.0, shrink=False, kind="trail")
        except Exception:
            pass

    # -- simulation --------------------------------------------------------
    def update(self, dt: float) -> None:
        """Advance every particle; compact the list and recycle dead records."""
        try:
            dt = float(dt)
            if dt <= 0.0:
                return
            if dt > C.MAX_DT:
                dt = C.MAX_DT
            self._t += dt
            t = self._t

            alive: List[Particle] = []
            append = alive.append
            pool = self._pool
            pool_cap = self._pool_cap
            sin = math.sin
            cos = math.cos
            for p in self._items:
                p.life -= dt
                if p.life <= 0.0:
                    if len(pool) < pool_cap:
                        pool.append(p)
                    continue
                # Exponential-ish drag that stays stable for any dt.
                if p.drag > 0.0:
                    f = 1.0 / (1.0 + p.drag * dt)
                    p.vx *= f
                    p.vy *= f
                if p.gravity:
                    p.vy += p.gravity * dt
                if p.turbulence:
                    # A cheap two-trig approximation of a curl-noise field:
                    # the acceleration on x depends only on y (and vice versa),
                    # which is what makes the flow rotational rather than a
                    # uniform push, so bursts braid instead of fanning out.
                    k = p.turbulence * dt
                    p.vx += sin(p.y * 0.017 + t * 1.30 + p.seed) * k
                    p.vy += cos(p.x * 0.017 - t * 1.10 + p.seed) * k
                p.px = p.x
                p.py = p.y
                p.x += p.vx * dt
                p.y += p.vy * dt
                if p.spin and p.kind != "ring":
                    # `ring` borrows `spin` as its stroke width - never rotate.
                    p.angle += p.spin * dt
                if p.grow:
                    p.radius += p.grow * dt
                    p.r0 = p.radius
                append(p)
            self._items = alive
        except Exception:
            # A broken frame must never take the game down.
            pass

    # -- rendering ---------------------------------------------------------
    def _get_layer(self, size: Tuple[int, int]) -> Optional[pygame.Surface]:
        """The reusable scratch surface used for additive vector geometry."""
        if self._layer is None or self._layer_size != size:
            try:
                surf = pygame.Surface(size)
                try:
                    surf = surf.convert()
                except Exception:
                    pass
                self._layer = surf
                self._layer_size = size
            except Exception:
                self._layer = None
        return self._layer

    def draw(self, surface: pygame.Surface) -> None:
        """Composite every particle onto `surface` additively."""
        if not self._items:
            return
        try:
            add = pygame.BLEND_RGB_ADD
            blit = surface.blit
            sw, sh = surface.get_size()
            margin = 140.0
            t = self._t
            cache = _GLOW_CACHE
            step = _COLOR_STEP

            geometry: List[Particle] = []
            for p in self._items:
                x, y = p.x, p.y
                if x < -margin or y < -margin or x > sw + margin or y > sh + margin:
                    continue
                fade = p.life / p.max_life          # 1 at birth -> 0 at death
                if fade > 1.0:
                    fade = 1.0
                r = p.r0 * (0.34 + 0.66 * fade) if p.shrink else p.r0
                if r < 0.5:
                    continue
                p.radius = r

                kind = p.kind
                if kind in _GEOMETRY_KINDS:
                    geometry.append(p)
                    if kind not in _NO_CORE_KINDS:
                        # A soft core under the streak/shard sells the glow.
                        spr = glow_sprite(r * 0.9, _blend_color(p, fade),
                                          fade * 0.55)
                        if spr is not None:
                            hw = spr.get_width() * 0.5
                            blit(spr, (int(x - hw), int(y - hw)), None, add)
                    continue

                bright = fade
                if kind == "ember":
                    # Embers twinkle: a cheap per-particle phase-shifted sine.
                    bright *= 0.62 + 0.38 * math.sin(t * 11.0 + p.seed)
                elif kind == "smoke":
                    # Smoke is a dim, quadratically-fading haze: it must never
                    # read as a bright blob or the additive blend blows out.
                    bright *= fade * 0.34
                    if bright < 0.012:
                        continue
                if not p.glow:
                    # No halo requested: pick a tighter sprite so the same
                    # cached art reads as a hard point instead of a bloom.
                    r *= 0.58
                    if r < 0.5:
                        continue

                # Inlined cache lookup: this is the hottest loop in the game,
                # so the common (cache hit) path avoids two function calls.
                # `bright` and the colour channels are always >= 0 here.
                col = p.color if p.color_end is None else _blend_color(p, fade)
                cr = col[0] * bright
                cg = col[1] * bright
                cb = col[2] * bright
                key = (_bucket_radius(r),
                       int((255.0 if cr > 255.0 else cr) / step + 0.5),
                       int((255.0 if cg > 255.0 else cg) / step + 0.5),
                       int((255.0 if cb > 255.0 else cb) / step + 0.5))
                spr = cache.get(key)
                if spr is None:
                    spr = glow_sprite(r, col, bright)
                    if spr is None:      # quantised to black: adds nothing
                        continue
                hw = spr.get_width() * 0.5
                blit(spr, (int(x - hw), int(y - hw)), None, add)

            if geometry:
                self._draw_geometry(surface, geometry, (sw, sh), add)
        except Exception:
            pass

    def _draw_geometry(self, surface: pygame.Surface, geometry: List[Particle],
                       size: Tuple[int, int], add: int) -> None:
        """Draw streaks, shards, rings, ribbons, bolts and stars on the
        scratch layer, then composite the dirty box once."""
        layer = self._get_layer(size)
        if layer is None:
            return
        try:
            # Only the bounding box of the vector particles is cleared and
            # composited.  Clearing all of 1280x720 for a couple of sparks
            # costs more than every other particle in the frame put together.
            sw, sh = size
            t = self._t
            x0 = y0 = 1.0e9
            x1 = y1 = -1.0e9
            for p in geometry:
                pad = p.radius * 2.2 + 30.0     # streak / shard / ring reach
                if p.kind == "trail":
                    # A ribbon reaches back to where the particle was: at the
                    # clamped dt and the fastest particle we ship that is well
                    # under 30px, but a teleport must not smear off-box.
                    d = abs(p.x - p.px) + abs(p.y - p.py)
                    if d > pad:
                        pad = d
                elif p.kind == "bolt":
                    pad += p.radius * 4.0
                if p.x - pad < x0:
                    x0 = p.x - pad
                if p.y - pad < y0:
                    y0 = p.y - pad
                if p.x + pad > x1:
                    x1 = p.x + pad
                if p.y + pad > y1:
                    y1 = p.y + pad
            ix0 = int(clamp(x0, 0.0, sw))
            iy0 = int(clamp(y0, 0.0, sh))
            ix1 = int(clamp(x1 + 1.0, 0.0, sw))
            iy1 = int(clamp(y1 + 1.0, 0.0, sh))
            if ix1 <= ix0 or iy1 <= iy0:
                return
            dirty = pygame.Rect(ix0, iy0, ix1 - ix0, iy1 - iy0)

            layer.fill((0, 0, 0), dirty)
            layer.set_clip(dirty)
            line = pygame.draw.line
            polygon = pygame.draw.polygon
            circle = pygame.draw.circle
            for p in geometry:
                fade = p.life / p.max_life
                if fade > 1.0:
                    fade = 1.0
                col = P.shade(_blend_color(p, fade), fade)
                if not (col[0] or col[1] or col[2]):
                    continue
                x, y, r = p.x, p.y, p.radius
                kind = p.kind

                if kind == "spark":
                    sp = math.hypot(p.vx, p.vy)
                    if sp < 1.0:
                        continue
                    # Streak length tracks speed, so fast sparks smear.
                    tail = clamp(sp * 0.05, 6.0, 34.0) / sp
                    line(layer, col, (int(x), int(y)),
                         (int(x - p.vx * tail), int(y - p.vy * tail)),
                         1 if r < 2.6 else 2)

                elif kind == "shard":
                    # An irregular spinning triangle: three unequal radii
                    # around the particle's rotating angle.
                    a = p.angle
                    s = r * 1.9
                    pts = (
                        (x + math.cos(a) * s, y + math.sin(a) * s),
                        (x + math.cos(a + 2.42) * s * 0.66,
                         y + math.sin(a + 2.42) * s * 0.66),
                        (x + math.cos(a - 2.42) * s * 0.82,
                         y + math.sin(a - 2.42) * s * 0.82),
                    )
                    polygon(layer, col, [(int(px), int(py)) for px, py in pts])

                elif kind == "trail":
                    # A ribbon: a quad that is wide at the head and pinched at
                    # the tail, so a fast particle draws a tapered smear.
                    dx = x - p.px
                    dy = y - p.py
                    d = math.hypot(dx, dy)
                    if d < 0.6:
                        # Barely moved - fall back to a dot-sized stub so the
                        # ribbon never vanishes at the top of its arc.
                        circle(layer, col, (int(x), int(y)), max(1, int(r)))
                        continue
                    # Stretch the tail backwards a little for extra length.
                    ex = p.px - dx * 0.9
                    ey = p.py - dy * 0.9
                    nx = -dy / d
                    ny = dx / d
                    hw = r * 0.85
                    tw = r * 0.12
                    polygon(layer, col, [
                        (int(x + nx * hw), int(y + ny * hw)),
                        (int(x - nx * hw), int(y - ny * hw)),
                        (int(ex - nx * tw), int(ey - ny * tw)),
                        (int(ex + nx * tw), int(ey + ny * tw)),
                    ])

                elif kind == "bolt":
                    # Three chained segments with a sine-driven perpendicular
                    # kink: deterministic per particle (via `seed`) but
                    # flickering in time, which is what sells "electricity".
                    a = p.angle
                    ln = clamp(r * 4.0, 8.0, 54.0)
                    ca, sa = math.cos(a), math.sin(a)
                    nx, ny = -sa, ca
                    w = 1 if r < 3.4 else 2
                    ax, ay = x, y
                    for i in (1, 2, 3):
                        f = i / 3.0
                        kink = math.sin(p.seed * 5.7 + i * 2.1 + t * 34.0) \
                            * ln * 0.26 * (1.0 - f * 0.5)
                        bx = x + ca * ln * f + nx * kink
                        by = y + sa * ln * f + ny * kink
                        line(layer, col, (int(ax), int(ay)), (int(bx), int(by)), w)
                        ax, ay = bx, by

                elif kind == "star":
                    # Four-point twinkle: an eight-vertex polygon alternating
                    # a long spike and a short waist.
                    a = p.angle
                    lo = r * 0.42
                    hi = r * 2.6
                    pts = []
                    for i in range(8):
                        ang = a + i * 0.7853981633974483      # pi / 4
                        rad = hi if (i & 1) == 0 else lo
                        pts.append((int(x + math.cos(ang) * rad),
                                    int(y + math.sin(ang) * rad)))
                    polygon(layer, col, pts)

                else:  # "ring"
                    rr = int(r)
                    if rr < 2:
                        continue
                    # Hollow, thinning as it expands - a classic shockwave.
                    # `spin` carries the stroke fraction (see `ring`).
                    frac = p.spin if 0.02 <= p.spin <= 0.5 else 0.10
                    width = max(1, int(rr * frac * (0.4 + 0.6 * fade)))
                    circle(layer, col, (int(x), int(y)), rr, min(width, rr - 1))
            layer.set_clip(None)
            surface.blit(layer, dirty.topleft, dirty, add)
        except Exception:
            try:
                layer.set_clip(None)
            except Exception:
                pass
