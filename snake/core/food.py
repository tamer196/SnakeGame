"""
Food entities and the field that manages them.

Three kinds of pickup live in the arena:

    normal  worth C.SCORE_PER_FOOD, never expires, the staple of every level
    bonus   worth ~3x, slightly larger, evaporates after ~8 seconds
    mega    worth ~8x, rare, largest, evaporates fast and grows the snake a lot

Every orb bobs on a sine wave and breathes (radius pulse) so the arena never
looks static, and anything with a finite time-to-live blinks urgently in its
final second.  All drawing is delegated to `gfx.render.draw_food_orb` so the
neon look stays defined in exactly one place; a plain circle fallback keeps the
game playable if that module is unavailable.

Nothing in this module may raise from an update or draw path.
"""

from __future__ import annotations

import math
import random
from dataclasses import dataclass, field as dc_field
from typing import TYPE_CHECKING, Any, Callable, Dict, List, Optional, Sequence, Tuple

import pygame

from .. import config as C
from .. import palette as P
from .contracts import clamp, dist_sq, ease_out_back, lerp

if TYPE_CHECKING:  # pragma: no cover - typing only
    from ..palette import RGB, Theme


# --------------------------------------------------------------------------
# Kind table
# --------------------------------------------------------------------------
# `ttl <= 0` means "never expires".  `grow` is how many body segments the
# snake gains, `weight` is the relative chance of a random special roll.
FOOD_KINDS: Dict[str, Dict[str, Any]] = {
    "normal": {
        "name": "Orb",
        "value": C.SCORE_PER_FOOD,
        "radius": C.FOOD_RADIUS,
        "ttl": 0.0,
        "grow": C.SNAKE_GROW_PER_FOOD,
        "weight": 0.0,
    },
    "bonus": {
        "name": "Bonus",
        "value": C.SCORE_PER_FOOD * 3,
        "radius": C.FOOD_RADIUS * 1.28,
        "ttl": 8.0,
        "grow": C.SNAKE_GROW_PER_FOOD * 2,
        "weight": 0.78,
    },
    "mega": {
        "name": "Mega",
        "value": C.SCORE_PER_FOOD * 8,
        "radius": C.FOOD_RADIUS * 1.65,
        "ttl": 4.5,
        "grow": C.SNAKE_GROW_PER_FOOD * 4,
        "weight": 0.22,
    },
}

SPECIAL_KINDS: Tuple[str, ...] = ("bonus", "mega")

# Placement: keep orbs off the arena edge by roughly one orb diameter so the
# glow halo never bleeds through the neon border.
SPAWN_MARGIN: float = C.FOOD_RADIUS * 2.0 + C.FOOD_PICKUP_PAD
SPAWN_TRIES: int = 64                       # hard cap - never loop forever
MIN_FOOD_SEPARATION: float = C.FOOD_RADIUS * 3.4

# Motion / presentation
BOB_SPEED: float = 1.9                      # radians / second of vertical bob
BOB_AMOUNT: float = 3.2                     # pixels of vertical travel
PULSE_AMOUNT: float = 0.10                  # +/- fraction of the base radius
POP_IN_TIME: float = 0.34                   # spawn scale-up, seconds
BLINK_LEAD: float = 1.0                     # blink during the last second

# Auto-spawned specials (disable with `field.auto_special = False`)
BONUS_INTERVAL: Tuple[float, float] = (9.0, 17.0)
MEGA_INTERVAL: Tuple[float, float] = (24.0, 40.0)


# --------------------------------------------------------------------------
# Lazy hook into the renderer
# --------------------------------------------------------------------------
_ORB_DRAWER: Optional[Callable[..., Any]] = None
_ORB_LOOKED_UP: bool = False


def _orb_drawer() -> Optional[Callable[..., Any]]:
    """
    Resolve `gfx.render.draw_food_orb` once, then cache it.

    Imported lazily rather than at module scope: `gfx.render` pulls in themes
    and surface caches, and resolving it on first draw keeps this module free
    of import-order surprises.  A missing renderer is not fatal.
    """
    global _ORB_DRAWER, _ORB_LOOKED_UP
    if not _ORB_LOOKED_UP:
        _ORB_LOOKED_UP = True
        try:
            from ..gfx.render import draw_food_orb  # local import: see docstring
            _ORB_DRAWER = draw_food_orb
        except Exception:
            _ORB_DRAWER = None
    return _ORB_DRAWER


def _fallback_orb(surface: "pygame.Surface", x: float, y: float, r: float,
                  color: "RGB") -> None:
    """Minimal stand-in used only when gfx.render is unavailable."""
    try:
        pygame.draw.circle(surface, color, (int(x), int(y)), max(1, int(r)))
        pygame.draw.circle(surface, P.shade(color, 1.6), (int(x), int(y)),
                           max(1, int(r * 0.45)))
    except Exception:
        pass


# ==========================================================================
# Food
# ==========================================================================
@dataclass
class Food:
    """One collectable orb sitting in the arena."""

    x: float
    y: float
    kind: str = "normal"
    value: int = C.SCORE_PER_FOOD
    radius: float = C.FOOD_RADIUS
    born: float = 0.0
    ttl: float = 0.0                                   # <= 0 -> immortal
    grow: int = C.SNAKE_GROW_PER_FOOD
    color: Tuple[int, int, int] = (255, 255, 255)
    # -- private presentation state ---------------------------------------
    _phase: float = dc_field(default=0.0, repr=False)  # per-orb bob offset
    _spin: float = dc_field(default=0.0, repr=False)   # per-orb spin offset
    _dead: bool = dc_field(default=False, repr=False)  # collected / expired

    # -- lifetime ----------------------------------------------------------
    def age(self, t: float) -> float:
        """Seconds since this orb appeared (never negative)."""
        return t - self.born if t > self.born else 0.0

    def remaining(self, t: float) -> float:
        """Seconds of life left; math.inf for orbs that never expire."""
        if self.ttl <= 0.0:
            return math.inf
        return self.ttl - self.age(t)

    def expired(self, t: float) -> bool:
        return self.ttl > 0.0 and self.age(t) >= self.ttl

    @property
    def perishable(self) -> bool:
        return self.ttl > 0.0

    # -- presentation ------------------------------------------------------
    def bob_offset(self, t: float) -> float:
        """Vertical hover offset in pixels; the phase de-syncs neighbours."""
        return math.sin(t * BOB_SPEED + self._phase) * BOB_AMOUNT

    def draw_pos(self, t: float) -> Tuple[float, float]:
        return (self.x, self.y + self.bob_offset(t))

    def draw_radius(self, t: float) -> float:
        """
        Base radius modulated by three effects, multiplied together:

          * pop-in  - ease_out_back overshoot for the first POP_IN_TIME seconds
          * breathe - a slow sine pulse at C.FOOD_PULSE_SPEED
          * wither  - perishable orbs shrink slightly as they run out of time
        """
        age = self.age(t)
        scale = 1.0
        if age < POP_IN_TIME:
            scale *= ease_out_back(age / POP_IN_TIME)
        scale *= 1.0 + PULSE_AMOUNT * math.sin(t * C.FOOD_PULSE_SPEED + self._phase)
        left = self.remaining(t)
        if left != math.inf and left < BLINK_LEAD:
            scale *= lerp(0.72, 1.0, clamp(left / BLINK_LEAD, 0.0, 1.0))
        return max(1.0, self.radius * scale)

    def visible(self, t: float) -> bool:
        """
        False on the "off" half of the end-of-life blink.

        The blink phase is `k * remaining ** 0.6`; because the exponent is
        below 1 its rate of change grows as `remaining` approaches zero, so the
        flashing visibly accelerates instead of ticking at a constant rate.
        """
        left = self.remaining(t)
        if left == math.inf or left >= BLINK_LEAD:
            return True
        if left <= 0.0:
            return False
        phase = 34.0 * (left ** 0.6)
        return math.sin(phase) > -0.30

    # -- collision ---------------------------------------------------------
    def pickup_radius(self) -> float:
        return self.radius + C.FOOD_PICKUP_PAD

    def overlaps(self, x: float, y: float, r: float) -> bool:
        """Circle overlap against the (forgiving) pickup radius."""
        reach = self.pickup_radius() + max(0.0, r)
        return dist_sq(self.x, self.y, x, y) <= reach * reach


def make_food(x: float, y: float, kind: str, t: float,
              theme: "Theme | None" = None,
              rng: "random.Random | None" = None) -> Food:
    """Build a Food of `kind` (unknown kinds degrade to "normal")."""
    spec = FOOD_KINDS.get(kind) or FOOD_KINDS["normal"]
    if kind not in FOOD_KINDS:
        kind = "normal"
    r = rng or random
    return Food(
        x=float(x),
        y=float(y),
        kind=kind,
        value=int(spec["value"]),
        radius=float(spec["radius"]),
        born=float(t),
        ttl=float(spec["ttl"]),
        grow=int(spec["grow"]),
        color=food_color(kind, theme, t),
        _phase=r.uniform(0.0, math.tau),
        _spin=r.uniform(0.0, math.tau),
    )


def food_color(kind: str, theme: "Theme | None", t: float) -> Tuple[int, int, int]:
    """
    Theme-derived colour for a kind.

    normal follows `theme.food`, bonus leans on the secondary neon so it reads
    as "different but related", and mega cycles a slow rainbow washed toward
    white to sell its rarity.
    """
    try:
        if theme is None:
            base = P.UI_GOLD
            alt = P.UI_WHITE
        else:
            base = theme.food
            alt = theme.accent2
        if kind == "bonus":
            # Drift between the two neons so the orb never sits on one hue.
            mix = 0.5 + 0.5 * math.sin(t * 1.7)
            return P.lerp_color(alt, P.hue_shift(base, 0.08), mix)
        if kind == "mega":
            return P.lerp_color(P.rainbow(t * 0.22, 0.72, 1.0), P.UI_WHITE, 0.22)
        return base
    except Exception:
        return (255, 255, 255)


# ==========================================================================
# FoodField
# ==========================================================================
class FoodField:
    """
    Owns every Food in one arena: spawning, ageing, collection and drawing.

    The caller drives it with `ensure(n, avoid=...)` each frame to keep the
    arena stocked; specials appear on their own timers unless `auto_special`
    is switched off.  Set `.avoid` to the level's static obstacle circles so
    the internal timers place their spawns legally too.
    """

    def __init__(self, rect: "pygame.Rect", theme: "Theme") -> None:
        self.rect: pygame.Rect = self._as_rect(rect)
        self.theme = theme
        self.items: List[Food] = []
        self.avoid: List[Tuple[float, float, float]] = []
        self.auto_special: bool = True
        self.rng = random.Random()
        self._t: float = 0.0
        self._next_bonus: float = self.rng.uniform(*BONUS_INTERVAL)
        self._next_mega: float = self.rng.uniform(*MEGA_INTERVAL)
        # Stats the HUD / end screen may care about.
        self.spawned_total: int = 0
        self.expired_total: int = 0

    # -- geometry ----------------------------------------------------------
    @staticmethod
    def _as_rect(rect: Any) -> pygame.Rect:
        """Accept a pygame.Rect, a contracts.Rect or a 4-tuple."""
        try:
            if isinstance(rect, pygame.Rect):
                return rect.copy()
            left = getattr(rect, "left", None)
            if left is not None:
                return pygame.Rect(int(rect.left), int(rect.top),
                                   int(rect.right - rect.left),
                                   int(rect.bottom - rect.top))
            x, y, w, h = rect  # type: ignore[misc]
            return pygame.Rect(int(x), int(y), int(w), int(h))
        except Exception:
            return pygame.Rect(*C.ARENA_RECT)

    def set_rect(self, rect: Any) -> None:
        """Retarget the field at a new arena (used when a level changes)."""
        self.rect = self._as_rect(rect)

    # -- queries -----------------------------------------------------------
    def count(self, kind: Optional[str] = None) -> int:
        if kind is None:
            return len(self.items)
        return sum(1 for f in self.items if f.kind == kind)

    def has(self, kind: str) -> bool:
        return any(f.kind == kind for f in self.items)

    def nearest(self, x: float, y: float) -> Optional[Food]:
        """Closest orb to a point, or None when the field is empty."""
        best: Optional[Food] = None
        best_d = math.inf
        for f in self.items:
            d = dist_sq(f.x, f.y, x, y)
            if d < best_d:
                best_d, best = d, f
        return best

    def clear(self) -> None:
        self.items.clear()

    # -- spawning ----------------------------------------------------------
    def _blocked(self, x: float, y: float, r: float,
                 avoid: Optional[Sequence[Tuple[float, float, float]]]) -> float:
        """
        Signed clearance at (x, y): positive means legal, and larger is better.

        Returns the smallest gap to any avoid circle or existing orb, so the
        caller can keep the best of several rejected candidates.
        """
        best = math.inf
        if avoid:
            for entry in avoid:
                try:
                    ax, ay, ar = float(entry[0]), float(entry[1]), float(entry[2])
                except Exception:
                    continue  # malformed entry: ignore rather than crash
                gap = math.hypot(x - ax, y - ay) - (ar + r)
                if gap < best:
                    best = gap
        for f in self.items:
            gap = math.hypot(x - f.x, y - f.y) - MIN_FOOD_SEPARATION
            if gap < best:
                best = gap
        return best

    def _pick_spot(self, r: float,
                   avoid: Optional[Sequence[Tuple[float, float, float]]]
                   ) -> Optional[Tuple[float, float]]:
        """
        Rejection-sample a legal position inside the arena.

        Bounded to SPAWN_TRIES attempts; if every candidate is blocked we give
        up and return None rather than spinning forever on a level whose free
        space has been swallowed by obstacles and snake.
        """
        pad = SPAWN_MARGIN + r
        x0 = self.rect.left + pad
        x1 = self.rect.right - pad
        y0 = self.rect.top + pad
        y1 = self.rect.bottom - pad
        if x1 <= x0 or y1 <= y0:  # degenerate arena - fall back to the centre
            return (float(self.rect.centerx), float(self.rect.centery))
        for _ in range(SPAWN_TRIES):
            x = self.rng.uniform(x0, x1)
            y = self.rng.uniform(y0, y1)
            if self._blocked(x, y, r, avoid) > 0.0:
                return (x, y)
        return None

    def spawn(self, kind: str = "normal",
              avoid: Optional[Sequence[Tuple[float, float, float]]] = None
              ) -> Optional[Food]:
        """
        Place one orb of `kind`.

        Returns the new Food, or None when no legal spot was found within the
        retry budget (the field is simply left as it was - never an exception).
        """
        try:
            spec = FOOD_KINDS.get(kind) or FOOD_KINDS["normal"]
            spot = self._pick_spot(float(spec["radius"]),
                                   self._merged_avoid(avoid))
            if spot is None:
                return None
            f = make_food(spot[0], spot[1], kind, self._t, self.theme, self.rng)
            self.items.append(f)
            self.spawned_total += 1
            return f
        except Exception:
            return None

    def _merged_avoid(self, avoid: Optional[Sequence[Tuple[float, float, float]]]
                      ) -> List[Tuple[float, float, float]]:
        """Combine the caller's avoid list with the field's standing one."""
        merged: List[Tuple[float, float, float]] = []
        if self.avoid:
            merged.extend(self.avoid)
        if avoid:
            merged.extend(avoid)
        return merged

    def ensure(self, n: int,
               avoid: Optional[Sequence[Tuple[float, float, float]]] = None
               ) -> None:
        """Top the field back up to `n` *normal* orbs (specials don't count)."""
        try:
            need = int(n) - self.count("normal")
            # One spawn attempt per missing orb, and no more: a crowded arena
            # simply stays under-stocked for a frame instead of stalling.
            for _ in range(max(0, need)):
                if self.spawn("normal", avoid) is None:
                    break
        except Exception:
            pass

    # -- per-frame ---------------------------------------------------------
    def update(self, dt: float = 0.0, t: float = 0.0) -> None:
        """Age the field: retire expired orbs, refresh shimmer, roll specials."""
        try:
            self._t = float(t)
            dt = clamp(float(dt), 0.0, C.MAX_DT)

            if self.items:
                survivors: List[Food] = []
                for f in self.items:
                    if f._dead or f.expired(self._t):
                        self.expired_total += 1
                        continue
                    if f.kind == "mega":
                        # Mega orbs shimmer, so their cached colour is live.
                        f.color = food_color("mega", self.theme, self._t)
                    survivors.append(f)
                if len(survivors) != len(self.items):
                    self.items = survivors

            if self.auto_special:
                self._tick_specials(dt)
        except Exception:
            pass

    def _tick_specials(self, dt: float) -> None:
        """Countdown timers that sprinkle bonus / mega orbs into the arena."""
        self._next_bonus -= dt
        if self._next_bonus <= 0.0:
            self._next_bonus = self.rng.uniform(*BONUS_INTERVAL)
            if not self.has("bonus"):
                self.spawn("bonus")
        self._next_mega -= dt
        if self._next_mega <= 0.0:
            self._next_mega = self.rng.uniform(*MEGA_INTERVAL)
            if not self.has("mega"):
                self.spawn("mega")

    def collect_at(self, x: float, y: float, r: float) -> List[Food]:
        """Remove and return every orb overlapping the circle (x, y, r)."""
        taken: List[Food] = []
        try:
            if not self.items:
                return taken
            kept: List[Food] = []
            for f in self.items:
                if f.overlaps(x, y, r):
                    f._dead = True
                    taken.append(f)
                else:
                    kept.append(f)
            if taken:
                self.items = kept
        except Exception:
            return taken
        return taken

    def attract(self, x: float, y: float, dt: float,
                radius: float = 260.0, strength: float = 340.0) -> None:
        """
        Drag nearby orbs toward (x, y) - the magnet power-up.

        Pull falls off linearly with distance so far orbs barely stir while
        close ones snap in.  Positions stay clamped inside the arena.
        """
        try:
            if radius <= 0.0 or not self.items:
                return
            dt = clamp(float(dt), 0.0, C.MAX_DT)
            r2 = radius * radius
            for f in self.items:
                dx, dy = x - f.x, y - f.y
                d2 = dx * dx + dy * dy
                if d2 <= 1.0 or d2 > r2:
                    continue
                d = math.sqrt(d2)
                pull = strength * (1.0 - d / radius) * dt
                f.x += dx / d * pull
                f.y += dy / d * pull
                f.x = clamp(f.x, self.rect.left + f.radius, self.rect.right - f.radius)
                f.y = clamp(f.y, self.rect.top + f.radius, self.rect.bottom - f.radius)
        except Exception:
            pass

    # -- drawing -----------------------------------------------------------
    def draw(self, surface: "pygame.Surface", t: float = 0.0) -> None:
        """Draw every orb; expiring ones blink out over their final second."""
        if not self.items:
            return
        # An orb's additive halo reaches ~3x its radius - about 60 px for a
        # bobbing mega orb - so one sitting near the top of the arena would
        # bloom straight into the HUD strip (ARENA_Y == HUD_H, no gap).  Clip
        # to the field's own rect so food can never paint outside the arena.
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

        drawer = _orb_drawer()
        for f in self.items:
            try:
                if not f.visible(t):
                    continue
                px, py = f.draw_pos(t)
                pr = f.draw_radius(t)
                col = f.color if f.kind == "mega" else food_color(f.kind, self.theme, t)
                if drawer is not None:
                    drawer(surface, px, py, pr, col, t, kind=f.kind)
                else:
                    _fallback_orb(surface, px, py, pr, col)
            except Exception:
                continue  # one bad orb must never take down the frame

        if clipped:
            try:
                surface.set_clip(prev_clip)
            except Exception:
                pass
