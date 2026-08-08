"""
Additive particle system for NEON SERPENT.

This is the visual backbone of the game: the snake's slither trail, pickup
bursts, death explosions, portal shockwaves, drifting ambient motes and stray
sparks are all emitted from here.

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
    ``shard`` triangles, ``ring`` shockwaves) are drawn into one reusable
    full-size scratch layer which is composited once with ``BLEND_RGB_ADD``.
    That keeps the additive look without a surface allocation per particle.

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

# The five renderable particle kinds.
KINDS: Tuple[str, ...] = ("dot", "spark", "ember", "shard", "ring")

# Kinds that need vector drawing on the scratch layer rather than a glow blit.
_GEOMETRY_KINDS = frozenset(("spark", "shard", "ring"))

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


def _quantise(color: Sequence[int], f: float) -> Tuple[int, int, int]:
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


def glow_sprite(radius: float, color: Sequence[int], fade: float = 1.0) -> Optional[pygame.Surface]:
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


# --------------------------------------------------------------------------
# Particle record
# --------------------------------------------------------------------------
class Particle:
    """One live particle.  Deliberately a slots class, not a dataclass."""

    __slots__ = ("x", "y", "vx", "vy", "radius", "r0", "color", "life",
                 "max_life", "drag", "gravity", "glow", "shrink", "spin",
                 "angle", "grow", "kind", "seed")

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

    def reset(self, x: float, y: float, vx: float, vy: float, radius: float,
              color: RGB, life: float, drag: float, gravity: float,
              glow: bool, shrink: bool, spin: float, kind: str,
              grow: float = 0.0) -> None:
        self.x = x
        self.y = y
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
              kind: str = "dot", grow: float = 0.0) -> Optional[Particle]:
        """Add a single particle.  Never raises; returns the record or None."""
        try:
            # Reject NaN / inf up front.  A single non-finite particle would
            # otherwise throw inside the draw loop every frame it lives for,
            # taking the whole frame's particles with it.  Summing first means
            # one isfinite() call covers every field (NaN and inf propagate).
            if not math.isfinite(x + y + vx + vy + radius + life + drag
                                 + gravity + spin + grow):
                return None
            p = self._acquire()
            if p is None:
                return None
            if kind not in KINDS:
                kind = "dot"
            p.reset(float(x), float(y), float(vx), float(vy),
                    max(0.5, float(radius)), _as_rgb(color),
                    max(0.01, float(life)), float(drag), float(gravity),
                    bool(glow), bool(shrink), float(spin), kind, float(grow))
            self._items.append(p)
            return p
        except Exception:
            return None

    def burst(self, x: float, y: float, color: Sequence[int], count: int = 18,
              speed: Ranged = (40.0, 190.0), life: Ranged = (0.35, 0.9),
              radius: Ranged = (2.0, 5.0), spread: Optional[float] = None,
              direction: Optional[float] = None, glow: bool = True) -> None:
        """
        Explode `count` particles out of a point.

        `direction` is the centre angle in radians (None = all directions);
        `spread` is the total cone width in radians.
        """
        try:
            rgb = _as_rgb(color)
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
                self.spawn(x, y,
                           vx=math.cos(ang) * sp, vy=math.sin(ang) * sp,
                           radius=r, color=rgb, life=_rng_range(life, 0.6),
                           drag=random.uniform(1.4, 2.6), glow=glow,
                           spin=random.uniform(-7.0, 7.0),
                           kind="spark" if (glow and i % 4 == 0) else "dot")
        except Exception:
            pass

    def trail(self, x: float, y: float, color: Sequence[int], dt: float,
              rate: float = C.TRAIL_EMIT_RATE, spread: float = 0.9,
              speed: Ranged = (8.0, 44.0), life: Ranged = (0.25, 0.6),
              radius: Ranged = (2.0, 5.0)) -> None:
        """Continuous emission from a moving point (the snake head)."""
        try:
            rgb = _as_rgb(color)
            for _ in range(_emit_count(rate, dt)):
                ang = random.uniform(0.0, TAU)
                sp = _rng_range(speed, 24.0)
                # Jitter the origin a touch so the trail has body, not a wire.
                jx = x + math.cos(ang) * spread * 3.0
                jy = y + math.sin(ang) * spread * 3.0
                self.spawn(jx, jy,
                           vx=math.cos(ang) * sp, vy=math.sin(ang) * sp,
                           radius=_rng_range(radius, 3.0), color=rgb,
                           life=_rng_range(life, 0.4), drag=2.2,
                           kind="ember" if random.random() < 0.22 else "dot")
        except Exception:
            pass

    def ring(self, x: float, y: float, color: Sequence[int], radius: float = 40.0,
             count: int = 26, life: float = 0.6, speed: float = 120.0) -> None:
        """A shockwave: one expanding hollow circle plus a ring of outriders."""
        try:
            rgb = _as_rgb(color)
            life = max(0.05, float(life))
            # The hollow circle grows from a point to `radius` over its life.
            self.spawn(x, y, radius=max(2.0, radius * 0.12), color=rgb,
                       life=life, drag=0.0, shrink=False, kind="ring",
                       grow=max(0.0, radius) / life)
            n = int(clamp(count, 0, 200))
            for i in range(n):
                ang = (i / n) * TAU
                ca, sa = math.cos(ang), math.sin(ang)
                r0 = radius * 0.18
                self.spawn(x + ca * r0, y + sa * r0,
                           vx=ca * speed, vy=sa * speed,
                           radius=random.uniform(2.0, 4.0), color=rgb,
                           life=life * random.uniform(0.6, 1.1), drag=2.4)
        except Exception:
            pass

    def spark_line(self, x1: float, y1: float, x2: float, y2: float,
                   color: Sequence[int], count: int = 12, life: float = 0.4) -> None:
        """Scatter sparks along a segment (laser gates, self-collision flashes)."""
        try:
            rgb = _as_rgb(color)
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
                           drag=3.0, kind="spark")
        except Exception:
            pass

    def ambient(self, rect: object, color: Sequence[int], dt: float,
                rate: float = 6.0) -> None:
        """Slow drifting motes inside `rect`, for atmosphere behind the action."""
        try:
            x, y, w, h = _rect_bounds(rect)
            if w <= 1.0 or h <= 1.0:
                return
            rgb = _as_rgb(color)
            for _ in range(_emit_count(rate, dt)):
                self.spawn(x + random.random() * w, y + random.random() * h,
                           vx=random.uniform(-14.0, 14.0),
                           vy=random.uniform(-22.0, -4.0),
                           radius=random.uniform(1.6, 3.6), color=rgb,
                           life=random.uniform(2.0, 5.0), drag=0.25,
                           shrink=False,
                           kind="shard" if random.random() < 0.08 else "dot",
                           spin=random.uniform(-1.6, 1.6))
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

            alive: List[Particle] = []
            append = alive.append
            pool = self._pool
            pool_cap = self._pool_cap
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
                p.x += p.vx * dt
                p.y += p.vy * dt
                if p.spin:
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
                    if kind != "ring":
                        # A soft core under the streak/shard sells the glow.
                        spr = glow_sprite(r * 0.9, p.color, fade * 0.55)
                        if spr is not None:
                            hw = spr.get_width() * 0.5
                            blit(spr, (int(x - hw), int(y - hw)), None, add)
                    continue

                bright = fade
                if kind == "ember":
                    # Embers twinkle: a cheap per-particle phase-shifted sine.
                    bright *= 0.62 + 0.38 * math.sin(t * 11.0 + p.seed)
                if not p.glow:
                    # No halo requested: pick a tighter sprite so the same
                    # cached art reads as a hard point instead of a bloom.
                    r *= 0.58
                    if r < 0.5:
                        continue

                # Inlined cache lookup: this is the hottest loop in the game,
                # so the common (cache hit) path avoids two function calls.
                # `bright` and the colour channels are always >= 0 here.
                col = p.color
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
        """Draw streaks, shards and rings on the scratch layer, then add it."""
        layer = self._get_layer(size)
        if layer is None:
            return
        try:
            # Only the bounding box of the vector particles is cleared and
            # composited.  Clearing all of 1280x720 for a couple of sparks
            # costs more than every other particle in the frame put together.
            sw, sh = size
            x0 = y0 = 1.0e9
            x1 = y1 = -1.0e9
            for p in geometry:
                pad = p.radius * 2.2 + 30.0     # streak / shard / ring reach
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
                col = P.shade(p.color, fade)
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

                else:  # "ring"
                    rr = int(r)
                    if rr < 2:
                        continue
                    # Hollow, thinning as it expands - a classic shockwave.
                    width = max(1, int(rr * 0.10 * (0.4 + 0.6 * fade)))
                    circle(layer, col, (int(x), int(y)), rr, min(width, rr - 1))
            layer.set_clip(None)
            surface.blit(layer, dirty.topleft, dirty, add)
        except Exception:
            try:
                layer.set_clip(None)
            except Exception:
                pass
