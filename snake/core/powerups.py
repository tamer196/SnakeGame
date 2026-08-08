"""
Power-ups: the six temporary boons that drop into the arena.

    magnet   drags nearby food toward the head
    shield   absorbs exactly one hit
    slow     slows the snake down so tight lanes become steerable
    double   doubles every point scored while it lasts
    ghost    lets the head pass straight through its own body
    frenzy   extra food spawns plus a speed kick

Three pieces live here:

    POWERUP_TYPES   the static table (name / colour / icon / duration / desc)
    PowerUpField    spawning, lifetime, blinking, pickup and drawing
    ActiveEffects   the per-run countdown bookkeeping

Runes are drawn as a stack of cheap, cached layers - an additive halo, two
counter-rotating rune triangles, an orbiting node ring, a breathing core and a
vector glyph - so a frame with the maximum two runes on screen costs a couple
of dozen draw calls and zero surface allocations.

Nothing in this module may raise from an update or a draw path.
"""

from __future__ import annotations

import math
import random
from dataclasses import dataclass, field as dc_field
from typing import TYPE_CHECKING, Any, Dict, List, Optional, Sequence, Tuple

import pygame

from .. import config as C
from .. import palette as P
from .contracts import TAU, clamp, ease_out_back, lerp, pulse

if TYPE_CHECKING:  # pragma: no cover - typing only
    from ..palette import RGB, Theme


# ==========================================================================
# The type table
# ==========================================================================
# Colours are deliberately theme-independent: a player must be able to read a
# power-up at a glance on every one of the twelve level palettes, so each kind
# owns a fixed, well-separated hue (crimson / cyan / indigo / gold / pale /
# magenta).  `icon` is the short ASCII label the HUD may print next to a timer;
# the arena itself draws a vector glyph instead (see `_paint_glyph`).
POWERUP_TYPES: Dict[str, Dict[str, Any]] = {
    "magnet": {
        "name": "Magnet",
        "color": (255, 92, 96),
        "icon": "M",
        "duration": 8.0,
        "desc": "Food is pulled toward your head.",
    },
    "shield": {
        "name": "Shield",
        "color": (86, 220, 255),
        "icon": "S",
        "duration": 12.0,
        "desc": "Absorbs the next hit you take.",
    },
    "slow": {
        "name": "Slow-Mo",
        "color": (144, 124, 255),
        "icon": "T",
        "duration": 6.5,
        "desc": "Slows you down for surgical steering.",
    },
    "double": {
        "name": "Double",
        "color": (255, 208, 84),
        "icon": "2x",
        "duration": 10.0,
        "desc": "Every pickup is worth double points.",
    },
    "ghost": {
        "name": "Ghost",
        "color": (214, 228, 255),
        "icon": "G",
        "duration": 6.0,
        "desc": "Pass straight through your own body.",
    },
    "frenzy": {
        "name": "Frenzy",
        "color": (255, 74, 190),
        "icon": "F",
        "duration": 8.0,
        "desc": "Extra food, and you move faster.",
    },
}

POWERUP_KINDS: Tuple[str, ...] = tuple(POWERUP_TYPES.keys())

# Relative roll chance.  The defensive kinds show up a little more often than
# the score kinds, which keeps late levels survivable without making them easy.
SPAWN_WEIGHTS: Dict[str, float] = {
    "magnet": 1.15,
    "shield": 1.10,
    "slow": 0.95,
    "double": 1.00,
    "ghost": 0.85,
    "frenzy": 0.75,
}

# --------------------------------------------------------------------------
# Behaviour numbers other systems may read instead of inventing their own
# --------------------------------------------------------------------------
MAGNET_RADIUS: float = 210.0        # pixels of pull range around the head
MAGNET_STRENGTH: float = 340.0      # pixels / second of pull at point-blank
SLOW_SPEED_MULT: float = 0.62       # snake speed multiplier while "slow"
SLOW_TURN_MULT: float = 1.35        # ...and the tighter turning that pairs with it
FRENZY_SPEED_MULT: float = 1.22
FRENZY_EXTRA_FOOD: int = 3          # extra orbs the field keeps stocked
DOUBLE_SCORE_MULT: int = 2

# --------------------------------------------------------------------------
# Field / presentation tuning
# --------------------------------------------------------------------------
MAX_ACTIVE: int = 2                 # never more than ~two runes on screen
SPAWN_MARGIN: float = C.POWERUP_RADIUS * 2.6    # keep the halo off the border
SPAWN_TRIES: int = 48               # hard cap: placement never loops forever
MIN_SEPARATION: float = C.POWERUP_RADIUS * 5.0  # runes never touch each other
RETRY_DELAY: Tuple[float, float] = (1.5, 2.5)   # re-roll wait when at capacity

POP_IN_TIME: float = 0.42           # scale-up on arrival, seconds
BLINK_LEAD: float = 2.4             # start blinking this long before expiry
SPIN_SPEED: float = 0.85            # radians / second of rune rotation
ORBIT_SPEED: float = 1.7            # radians / second of the node ring
ORBIT_NODES: int = 5
CORE_PULSE_SPEED: float = 4.6

_GLOW_SCALE: float = 2.7            # halo radius as a multiple of the rune radius
_BOX_SCALE: float = 2.05            # scratch half-size as a multiple of the radius


# ==========================================================================
# Small shared helpers
# ==========================================================================
def powerup_info(kind: str) -> Dict[str, Any]:
    """Table row for `kind`, or a neutral stand-in for an unknown kind."""
    row = POWERUP_TYPES.get(kind)
    if row is None:
        return {"name": str(kind).title() or "Boon", "color": P.UI_WHITE,
                "icon": "?", "duration": C.POWERUP_DEFAULT_DURATION, "desc": ""}
    return row


def powerup_color(kind: str) -> "RGB":
    """Signature colour of a power-up kind."""
    col = powerup_info(kind).get("color", P.UI_WHITE)
    try:
        return (int(col[0]), int(col[1]), int(col[2]))
    except Exception:
        return P.UI_WHITE


def powerup_duration(kind: str) -> float:
    """How long `kind` lasts once collected, in seconds."""
    try:
        d = float(powerup_info(kind).get("duration", C.POWERUP_DEFAULT_DURATION))
    except Exception:
        d = C.POWERUP_DEFAULT_DURATION
    return d if d > 0.0 else C.POWERUP_DEFAULT_DURATION


def _add(col: Sequence[int], f: float) -> Tuple[int, int, int, int]:
    """
    Colour for an additive draw, pre-multiplied by brightness `f`.

    Everything in a rune is blitted with BLEND_RGB_ADD, which ignores the alpha
    channel entirely - so a fade has to be baked into the RGB values instead.
    """
    f = clamp(f, 0.0, 1.0)
    return (P.clamp8(col[0] * f), P.clamp8(col[1] * f), P.clamp8(col[2] * f), 255)


_SCRATCH: Dict[Tuple[int, int], pygame.Surface] = {}


def _scratch(size: int) -> pygame.Surface:
    """A reusable transparent scratch surface, cached per size bucket."""
    size = max(8, int(size))
    key = (size, size)
    surf = _SCRATCH.get(key)
    if surf is None:
        surf = pygame.Surface(key, pygame.SRCALPHA)
        _SCRATCH[key] = surf
        if len(_SCRATCH) > 24:          # bounded: a handful of sizes ever occur
            _SCRATCH.pop(next(iter(_SCRATCH)))
    surf.fill((0, 0, 0, 0))
    return surf


# ==========================================================================
# Vector glyphs
# ==========================================================================
# Each glyph is authored in a normalised -1..1 box and scaled at build time.
def _pts(norm: Sequence[Tuple[float, float]], cx: float, cy: float,
         s: float) -> List[Tuple[int, int]]:
    return [(int(cx + px * s), int(cy + py * s)) for px, py in norm]


def _arc_pts(r: float, a0: float, a1: float, steps: int = 10
             ) -> List[Tuple[float, float]]:
    """Normalised points along an arc; screen y grows downward, hence -sin."""
    out: List[Tuple[float, float]] = []
    for i in range(steps + 1):
        a = a0 + (a1 - a0) * (i / float(steps))
        out.append((math.cos(a) * r, -math.sin(a) * r))
    return out


_SHIELD = ((-0.80, -0.72), (0.80, -0.72), (0.80, 0.06),
           (0.00, 0.94), (-0.80, 0.06))
_HOURGLASS = ((-0.72, -0.88), (0.72, -0.88), (0.12, 0.0),
              (0.72, 0.88), (-0.72, 0.88), (-0.12, 0.0))
_BOLT = ((0.16, -0.96), (-0.66, 0.14), (-0.10, 0.14),
         (-0.30, 0.96), (0.62, -0.18), (0.06, -0.18))
_GHOST_TAIL = ((0.74, 0.42), (0.44, 0.92), (0.15, 0.46),
               (-0.15, 0.92), (-0.44, 0.46), (-0.74, 0.92))


def _paint_glyph(surf: pygame.Surface, kind: str, col: Tuple[int, int, int, int],
                 cx: float, cy: float, s: float) -> None:
    """Stroke one kind's emblem into `surf`, centred on (cx, cy), radius `s`."""
    w = max(2, int(s * 0.22))
    if kind == "magnet":
        # Horseshoe: a half-ring with two prongs dropping from its ends.  It is
        # drawn wide so the gap between the poles survives the core glow behind
        # it - that gap is the whole silhouette.
        ring = _pts(_arc_pts(0.92, 0.0, math.pi, 14), cx, cy - 0.10 * s, s)
        pygame.draw.lines(surf, col, False, ring, w)
        for sx in (-0.92, 0.92):
            pygame.draw.line(surf, col,
                             (int(cx + sx * s), int(cy - 0.10 * s)),
                             (int(cx + sx * s), int(cy + 0.74 * s)), w)
        # Polarity caps: short cross-bars, so the poles read as magnet tips.
        for sx in (-0.92, 0.92):
            pygame.draw.line(surf, col,
                             (int(cx + sx * s * 1.30), int(cy + 0.74 * s)),
                             (int(cx + sx * s * 0.55), int(cy + 0.74 * s)),
                             max(2, int(w * 0.9)))
    elif kind == "shield":
        pygame.draw.polygon(surf, col, _pts(_SHIELD, cx, cy, s), w)
        pygame.draw.line(surf, col, (int(cx), int(cy - 0.36 * s)),
                         (int(cx), int(cy + 0.46 * s)), max(1, w - 1))
    elif kind == "slow":
        pygame.draw.polygon(surf, col, _pts(_HOURGLASS, cx, cy, s), w)
        # The falling grain: a small solid dot in the lower bulb.
        pygame.draw.circle(surf, col, (int(cx), int(cy + 0.52 * s)),
                           max(2, int(s * 0.14)))
    elif kind == "double":
        # Two nested diamonds: one shape, doubled - the "x2" read without text.
        for scale in (0.94, 0.48):
            dia = ((0.0, -scale), (scale, 0.0), (0.0, scale), (-scale, 0.0))
            pygame.draw.polygon(surf, col, _pts(dia, cx, cy, s), w)
    elif kind == "ghost":
        # Dome runs right -> left over the top; the wavy hem runs back left ->
        # right, so the closed outline never crosses itself.
        dome = _arc_pts(0.74, 0.0, math.pi, 12)
        outline = _pts(list(dome) + list(reversed(_GHOST_TAIL)), cx, cy, s)
        pygame.draw.lines(surf, col, True, outline, w)
        for sx in (-0.30, 0.30):
            pygame.draw.circle(surf, col,
                               (int(cx + sx * s), int(cy - 0.16 * s)),
                               max(2, int(s * 0.13)))
    elif kind == "frenzy":
        pygame.draw.polygon(surf, col, _pts(_BOLT, cx, cy, s))
    else:
        pygame.draw.circle(surf, col, (int(cx), int(cy)), max(2, int(s * 0.7)), w)


_GLYPH_CACHE: Dict[Tuple[str, int, int], pygame.Surface] = {}
_GLYPH_BRIGHT_STEPS: int = 6


def _glyph_sprite(kind: str, size: float, bright: float) -> pygame.Surface:
    """
    A cached, additive-ready emblem sprite.

    Size is bucketed to 2 px and brightness to `_GLYPH_BRIGHT_STEPS` levels, so
    the pop-in scale and the expiry blink both animate straight out of cache.
    """
    sb = max(4, (int(size) // 2) * 2)
    bb = max(1, int(clamp(bright, 0.0, 1.0) * _GLYPH_BRIGHT_STEPS + 0.5))
    key = (kind, sb, bb)
    surf = _GLYPH_CACHE.get(key)
    if surf is None:
        box = sb * 2 + 6
        surf = pygame.Surface((box, box), pygame.SRCALPHA)
        # Emblems are drawn much whiter than the halo so they stay legible
        # against the core glow they sit on top of.
        col = _add(P.lerp_color(powerup_color(kind), (255, 255, 255), 0.55),
                   bb / float(_GLYPH_BRIGHT_STEPS))
        try:
            _paint_glyph(surf, kind, col, box * 0.5, box * 0.5, sb * 0.5)
        except Exception:
            pass
        _GLYPH_CACHE[key] = surf
        if len(_GLYPH_CACHE) > 160:
            _GLYPH_CACHE.pop(next(iter(_GLYPH_CACHE)))
    return surf


def clear_caches() -> None:
    """Drop every cached surface (used when the display mode changes)."""
    _GLYPH_CACHE.clear()
    _SCRATCH.clear()


# ==========================================================================
# PowerUp
# ==========================================================================
@dataclass
class PowerUp:
    """One rune sitting in the arena, waiting to be swallowed."""

    x: float
    y: float
    kind: str = "shield"
    born: float = 0.0                       # field clock stamp at spawn
    ttl: float = C.POWERUP_LIFETIME

    # -- private presentation state ---------------------------------------
    radius: float = C.POWERUP_RADIUS
    _age: float = dc_field(default=0.0, repr=False)
    _phase: float = dc_field(default=0.0, repr=False)   # per-item spin offset
    _spin: float = dc_field(default=1.0, repr=False)    # +1 / -1 rotation sense

    # -- lifetime ----------------------------------------------------------
    def age(self, t: Optional[float] = None) -> float:
        """Seconds since spawn. Pass the field clock, or nothing for internal."""
        if t is None:
            return self._age
        return max(0.0, float(t) - self.born)

    def remaining(self, t: Optional[float] = None) -> float:
        """Seconds of life left before this rune fades out."""
        return max(0.0, self.ttl - self.age(t))

    def expired(self, t: Optional[float] = None) -> bool:
        return self.age(t) >= self.ttl

    @property
    def color(self) -> "RGB":
        return powerup_color(self.kind)

    @property
    def info(self) -> Dict[str, Any]:
        return powerup_info(self.kind)

    @property
    def duration(self) -> float:
        """How long the effect lasts once this rune is collected."""
        return powerup_duration(self.kind)

    # -- presentation ------------------------------------------------------
    def brightness(self) -> float:
        """
        0..1 visibility.

        Full brightness for most of the life, then a blink that accelerates as
        the rune runs out - slow warning pulses turning into a frantic strobe.
        """
        left = self.remaining()
        if left >= BLINK_LEAD:
            return 1.0
        u = clamp(left / BLINK_LEAD, 0.0, 1.0)      # 1 -> 0 as it dies
        freq = lerp(22.0, 6.0, u)                   # faster blink when lower
        blink = 0.5 + 0.5 * math.sin(self._age * freq)
        # Never fully invisible, and the floor lifts with the time left.
        return clamp(0.30 + 0.70 * u * u + 0.34 * blink * (1.0 - u), 0.0, 1.0)

    def draw_radius(self) -> float:
        """Base radius with the spawn pop-in and a gentle breathing pulse."""
        r = self.radius
        if self._age < POP_IN_TIME:
            r *= clamp(ease_out_back(self._age / POP_IN_TIME), 0.0, 1.4)
        r *= 0.94 + 0.06 * pulse(self._age * CORE_PULSE_SPEED + self._phase)
        return max(2.0, r)

    # -- collision ---------------------------------------------------------
    def pickup_radius(self) -> float:
        return self.radius + C.FOOD_PICKUP_PAD

    def overlaps(self, x: float, y: float, r: float) -> bool:
        dx, dy = x - self.x, y - self.y
        rr = self.pickup_radius() + max(0.0, r)
        return dx * dx + dy * dy <= rr * rr


# ==========================================================================
# PowerUpField
# ==========================================================================
class PowerUpField:
    """Spawns, ages, draws and hands out the runes for one level."""

    def __init__(self, rect: "pygame.Rect", theme: "Theme") -> None:
        self.rect: pygame.Rect = self._as_rect(rect)
        self.theme = theme
        self.items: List[PowerUp] = []
        self.enabled: bool = True
        self.rng = random.Random()
        self._clock: float = 0.0
        self._timer: float = self._roll_interval() * self.rng.uniform(0.55, 1.0)
        self._last_kind: str = ""

    # -- setup -------------------------------------------------------------
    @staticmethod
    def _as_rect(rect: Any) -> pygame.Rect:
        """Accept a pygame.Rect, a contracts.Rect or a 4-tuple; never raise."""
        try:
            if isinstance(rect, pygame.Rect):
                return rect.copy()
            if hasattr(rect, "x") and hasattr(rect, "w"):
                return pygame.Rect(int(rect.x), int(rect.y),
                                   int(rect.w), int(rect.h))
            return pygame.Rect(int(rect[0]), int(rect[1]),
                               int(rect[2]), int(rect[3]))
        except Exception:
            return pygame.Rect(*C.ARENA_RECT)

    def set_rect(self, rect: Any) -> None:
        self.rect = self._as_rect(rect)

    def clear(self) -> None:
        self.items.clear()

    def count(self) -> int:
        return len(self.items)

    def _roll_interval(self) -> float:
        lo = min(C.POWERUP_SPAWN_MIN, C.POWERUP_SPAWN_MAX)
        hi = max(C.POWERUP_SPAWN_MIN, C.POWERUP_SPAWN_MAX)
        return self.rng.uniform(lo, hi)

    # -- placement ---------------------------------------------------------
    def _pick_kind(self) -> str:
        """Weighted roll that avoids repeats and anything already on screen."""
        on_screen = {p.kind for p in self.items}
        pool = [k for k in POWERUP_KINDS if k not in on_screen and k != self._last_kind]
        if not pool:
            pool = [k for k in POWERUP_KINDS if k not in on_screen] or list(POWERUP_KINDS)
        weights = [max(0.01, SPAWN_WEIGHTS.get(k, 1.0)) for k in pool]
        total = sum(weights)
        roll = self.rng.uniform(0.0, total)
        for kind, w in zip(pool, weights):
            roll -= w
            if roll <= 0.0:
                return kind
        return pool[-1]

    def _blocked(self, x: float, y: float,
                 avoid: Optional[Sequence[Tuple[float, float, float]]]) -> bool:
        """True when (x, y) is too close to another rune or an avoided spot."""
        for p in self.items:
            dx, dy = x - p.x, y - p.y
            if dx * dx + dy * dy < MIN_SEPARATION * MIN_SEPARATION:
                return True
        if avoid:
            for spot in avoid:
                try:
                    ax, ay, ar = float(spot[0]), float(spot[1]), float(spot[2])
                except Exception:
                    continue
                rr = ar + C.POWERUP_RADIUS + C.FOOD_PICKUP_PAD
                dx, dy = x - ax, y - ay
                if dx * dx + dy * dy < rr * rr:
                    return True
        return False

    def _pick_spot(self, avoid: Optional[Sequence[Tuple[float, float, float]]]
                   ) -> Optional[Tuple[float, float]]:
        r = self.rect
        x0, x1 = r.left + SPAWN_MARGIN, r.right - SPAWN_MARGIN
        y0, y1 = r.top + SPAWN_MARGIN, r.bottom - SPAWN_MARGIN
        if x1 <= x0 or y1 <= y0:                    # arena smaller than the margin
            return (r.centerx * 1.0, r.centery * 1.0)
        best: Optional[Tuple[float, float]] = None
        for _ in range(SPAWN_TRIES):
            x = self.rng.uniform(x0, x1)
            y = self.rng.uniform(y0, y1)
            if best is None:
                best = (x, y)                       # fallback if nothing is clear
            if not self._blocked(x, y, avoid):
                return (x, y)
        return best

    # -- spawning ----------------------------------------------------------
    def spawn(self, kind: Optional[str] = None,
              avoid: Optional[Sequence[Tuple[float, float, float]]] = None
              ) -> Optional[PowerUp]:
        """Place one rune now. Returns it, or None if there was nowhere to go."""
        try:
            spot = self._pick_spot(avoid)
            if spot is None:
                return None
            k = kind if kind in POWERUP_TYPES else self._pick_kind()
            pu = PowerUp(
                x=spot[0], y=spot[1], kind=k,
                born=self._clock, ttl=max(1.0, C.POWERUP_LIFETIME),
                radius=C.POWERUP_RADIUS,
                _phase=self.rng.uniform(0.0, TAU),
                _spin=1.0 if self.rng.random() < 0.5 else -1.0,
            )
            self.items.append(pu)
            self._last_kind = k
            # Hard cap, in case a caller force-spawns past the limit.
            while len(self.items) > MAX_ACTIVE:
                self.items.pop(0)
            return pu
        except Exception:
            return None

    def maybe_spawn(self, dt: float,
                    avoid: Optional[Sequence[Tuple[float, float, float]]] = None
                    ) -> Optional[PowerUp]:
        """Tick the spawn timer; drop a rune when it comes due and there is room."""
        try:
            if not self.enabled:
                return None
            self._timer -= max(0.0, float(dt))
            if self._timer > 0.0:
                return None
            if len(self.items) >= MAX_ACTIVE:
                # At capacity: check again shortly instead of banking a spawn.
                self._timer = self.rng.uniform(*RETRY_DELAY)
                return None
            self._timer = self._roll_interval()
            return self.spawn(avoid=avoid)
        except Exception:
            return None

    # -- per-frame ---------------------------------------------------------
    def update(self, dt: float = 0.0, t: float = 0.0) -> None:
        """Age every rune and retire the ones that timed out."""
        try:
            step = float(dt)
        except Exception:
            step = 0.0
        if step < 0.0 or step != step:              # NaN-safe
            step = 0.0
        # Track the caller's clock when it supplies one, so `born` stamps stay
        # comparable with any external time value; otherwise integrate dt.
        try:
            tt = float(t)
        except Exception:
            tt = 0.0
        self._clock = tt if tt > 0.0 else self._clock + step

        if not self.items:
            return
        alive: List[PowerUp] = []
        for p in self.items:
            p._age += step
            if p._age < p.ttl:
                alive.append(p)
        if len(alive) != len(self.items):
            self.items = alive

    def collect_at(self, x: float, y: float, r: float) -> List[PowerUp]:
        """Remove and return every rune touching the circle (x, y, r)."""
        if not self.items:
            return []
        taken: List[PowerUp] = []
        try:
            keep: List[PowerUp] = []
            for p in self.items:
                if p.overlaps(x, y, r):
                    taken.append(p)
                else:
                    keep.append(p)
            if taken:
                self.items = keep
        except Exception:
            return taken
        return taken

    # -- drawing -----------------------------------------------------------
    def draw(self, surface: "pygame.Surface", t: float = 0.0) -> None:
        if not self.items:
            return
        # Like food orbs, a rune's additive halo reaches well past its radius,
        # and the arena's top edge is the bottom of the HUD strip with no gap
        # between them.  Clip to the field's rect so a rune near the edge can
        # never bloom over the HUD (or out past the arena border).
        prev_clip = None
        clipped = False
        try:
            prev_clip = surface.get_clip()
            area = pygame.Rect(self.rect)
            if prev_clip is not None:
                area = area.clip(prev_clip)
            surface.set_clip(area)
            clipped = True
        except Exception:
            clipped = False

        for p in self.items:
            try:
                self._draw_rune(surface, p, t)
            except Exception:
                continue

        if clipped:
            try:
                surface.set_clip(prev_clip)
            except Exception:
                pass

    def _draw_rune(self, surface: "pygame.Surface", p: PowerUp, t: float) -> None:
        bright = p.brightness()
        if bright <= 0.02:
            return
        r = p.draw_radius()
        col = p.color
        # A hair of the level accent bleeds into the orbit ring so the rune
        # still belongs to the scene it is sitting in.
        accent = getattr(self.theme, "accent", col)
        ring_col = P.lerp_color(col, accent, 0.28)

        # 1) additive halo, straight out of the renderer's glow cache
        breathe = 0.72 + 0.28 * pulse(p._age * CORE_PULSE_SPEED * 0.6 + p._phase)
        _glow(surface, p.x, p.y, r * _GLOW_SCALE, col, 0.55 * bright * breathe)

        # 2) everything else onto one reused scratch, blitted additively
        box = int(r * _BOX_SCALE * 2.0) + 8
        buf = _scratch(box)
        cx = cy = box * 0.5
        # Prefer the caller's clock so every rune turns in sync; fall back to
        # the item's own age when the scene passes no time value.
        try:
            tt = float(t)
        except Exception:
            tt = 0.0
        if tt <= 0.0:
            tt = p._age
        spin = tt * SPIN_SPEED * p._spin + p._phase

        # counter-rotating rune triangles -> a slowly shearing hexagram
        tri_r = r * 1.46
        lw = max(1, int(r * 0.13))
        for sense in (1.0, -1.0):
            a0 = spin * sense + (0.0 if sense > 0 else math.pi / 3.0)
            pts = [(int(cx + math.cos(a0 + k * TAU / 3.0) * tri_r),
                    int(cy + math.sin(a0 + k * TAU / 3.0) * tri_r)) for k in range(3)]
            pygame.draw.polygon(buf, _add(ring_col, 0.42 * bright), pts, lw)

        # orbiting node ring
        ring_r = int(r * 1.80)
        if ring_r > 2:
            pygame.draw.circle(buf, _add(ring_col, 0.30 * bright),
                               (int(cx), int(cy)), ring_r, max(1, lw - 1))
        # Nodes orbit against the runes' rotation for a geared, mechanical read.
        orbit = -tt * ORBIT_SPEED * p._spin + p._phase
        node_r = max(2, int(r * 0.19))
        for k in range(ORBIT_NODES):
            a = orbit + k * TAU / ORBIT_NODES
            nx = cx + math.cos(a) * ring_r
            ny = cy + math.sin(a) * ring_r
            # Nodes on the far side of the orbit read dimmer: fake depth.
            depth = 0.55 + 0.45 * (0.5 + 0.5 * math.sin(a))
            pygame.draw.circle(buf, _add(ring_col, bright * depth),
                               (int(nx), int(ny)), node_r)

        # breathing core, kept small and soft: the emblem is drawn on top of it
        # and has to stay legible, so the core is a backlight, not a headlight.
        core = r * (0.50 + 0.06 * pulse(p._age * CORE_PULSE_SPEED + p._phase))
        pygame.draw.circle(buf, _add(col, 0.30 * bright),
                           (int(cx), int(cy)), max(2, int(core)))
        pygame.draw.circle(buf, _add(P.lerp_color(col, (255, 255, 255), 0.5),
                                     0.42 * bright),
                           (int(cx), int(cy)), max(1, int(core * 0.45)))

        # 3) the emblem, cached per kind / size / brightness bucket
        glyph = _glyph_sprite(p.kind, r * 1.55, bright)
        gw = glyph.get_width()
        buf.blit(glyph, (int(cx - gw * 0.5), int(cy - gw * 0.5)),
                 special_flags=pygame.BLEND_RGB_ADD)

        surface.blit(buf, (int(p.x - cx), int(p.y - cy)),
                     special_flags=pygame.BLEND_RGB_ADD)


# --------------------------------------------------------------------------
# Lazy hook into the renderer's glow cache
# --------------------------------------------------------------------------
_GLOW_FN: Any = None
_GLOW_LOOKED_UP: bool = False


def _glow(surface: "pygame.Surface", x: float, y: float, radius: float,
          color: Sequence[int], intensity: float) -> None:
    """
    Additive halo via `gfx.render.draw_glow_circle`, resolved on first use.

    Imported lazily rather than at module scope so `core` never hard-depends on
    the graphics layer's import order; a missing renderer just costs the halo.
    """
    global _GLOW_FN, _GLOW_LOOKED_UP
    if not _GLOW_LOOKED_UP:
        _GLOW_LOOKED_UP = True
        try:
            from ..gfx.render import draw_glow_circle  # local: see docstring
            _GLOW_FN = draw_glow_circle
        except Exception:
            _GLOW_FN = None
    if _GLOW_FN is None:
        return
    try:
        _GLOW_FN(surface, x, y, radius, color, intensity)
    except Exception:
        pass


# ==========================================================================
# ActiveEffects
# ==========================================================================
class ActiveEffects:
    """
    The countdown book for one run.

    Picking up a kind that is already running refreshes its timer rather than
    stacking a second copy, so the HUD only ever shows one row per kind.
    """

    def __init__(self) -> None:
        self._timers: Dict[str, float] = {}
        self._totals: Dict[str, float] = {}     # full duration, for HUD bars

    # -- mutation ----------------------------------------------------------
    def add(self, kind: str, duration: Optional[float] = None) -> float:
        """Start or refresh `kind`. Returns the seconds now on its clock."""
        try:
            dur = powerup_duration(kind) if duration is None else float(duration)
        except Exception:
            dur = C.POWERUP_DEFAULT_DURATION
        if dur <= 0.0:
            dur = C.POWERUP_DEFAULT_DURATION
        # `max` so a refresh never shortens an unusually long running effect.
        left = max(self._timers.get(kind, 0.0), dur)
        self._timers[kind] = left
        self._totals[kind] = max(self._totals.get(kind, 0.0), dur)
        return left

    def remove(self, kind: str) -> None:
        self._timers.pop(kind, None)
        self._totals.pop(kind, None)

    def consume(self, kind: str) -> bool:
        """Spend a one-shot effect (the shield). True if it was active."""
        if kind in self._timers:
            self.remove(kind)
            return True
        return False

    def clear(self) -> None:
        self._timers.clear()
        self._totals.clear()

    # -- per-frame ---------------------------------------------------------
    def update(self, dt: float) -> List[str]:
        """Tick every clock; returns the kinds that ran out on this frame."""
        if not self._timers:
            return []
        try:
            step = float(dt)
        except Exception:
            return []
        if step <= 0.0 or step != step:             # NaN-safe
            return []
        done: List[str] = []
        for kind in list(self._timers.keys()):
            left = self._timers[kind] - step
            if left <= 0.0:
                self._timers.pop(kind, None)
                self._totals.pop(kind, None)
                done.append(kind)
            else:
                self._timers[kind] = left
        return done

    # -- queries -----------------------------------------------------------
    def has(self, kind: str) -> bool:
        return self._timers.get(kind, 0.0) > 0.0

    def remaining(self, kind: str) -> float:
        return max(0.0, self._timers.get(kind, 0.0))

    def fraction(self, kind: str) -> float:
        """0..1 of the original duration still left - handy for HUD bars."""
        total = self._totals.get(kind, 0.0)
        if total <= 0.0:
            return 0.0
        return clamp(self._timers.get(kind, 0.0) / total, 0.0, 1.0)

    def items(self) -> List[Tuple[str, float]]:
        """(kind, seconds_left) sorted by urgency - what the HUD renders."""
        return sorted(self._timers.items(), key=lambda kv: kv[1])

    def kinds(self) -> List[str]:
        return list(self._timers.keys())

    def __len__(self) -> int:
        return len(self._timers)

    def __contains__(self, kind: object) -> bool:
        return isinstance(kind, str) and self.has(kind)

    # -- derived gameplay modifiers ---------------------------------------
    def score_multiplier(self) -> int:
        return DOUBLE_SCORE_MULT if self.has("double") else 1

    def speed_multiplier(self) -> float:
        """Combined speed scale from `slow` and `frenzy` (they can overlap)."""
        m = 1.0
        if self.has("slow"):
            m *= SLOW_SPEED_MULT
        if self.has("frenzy"):
            m *= FRENZY_SPEED_MULT
        return m

    def turn_multiplier(self) -> float:
        return SLOW_TURN_MULT if self.has("slow") else 1.0

    def magnet_radius(self) -> float:
        return MAGNET_RADIUS if self.has("magnet") else 0.0

    def extra_food(self) -> int:
        return FRENZY_EXTRA_FOOD if self.has("frenzy") else 0
