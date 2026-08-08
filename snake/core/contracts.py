"""
Shared interfaces and small value types.

Everything in the package agrees on the definitions in this module, so it must
stay dependency-light: it may import `config` and `palette`, and nothing else
from the package.  That keeps it importable from any module without creating a
cycle.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Dict, List, Optional, Tuple

if TYPE_CHECKING:  # pragma: no cover - typing only
    import pygame

    from ..main import Game


Vec2 = Tuple[float, float]


# ==========================================================================
# Scene
# ==========================================================================
class Scene:
    """
    One screen of the game.

    The scene manager owns the lifecycle:

        on_enter(**kwargs)  ->  once, when the scene becomes active
        handle_event(event) ->  for every pygame event, every frame
        update(dt)          ->  once per frame, dt in seconds
        draw(surface)       ->  once per frame, after update
        on_exit()           ->  once, when the scene stops being active

    A scene that sets `transparent = True` is drawn *over* the scene below it
    on the stack (the one beneath is updated with dt=0 but still drawn).  That
    is how the pause overlay works.

    A scene that sets `blocks_update = True` (the default for transparent
    scenes) stops the scene below from receiving update() calls.
    """

    transparent: bool = False
    blocks_update: bool = True

    def __init__(self, game: "Game") -> None:
        self.game = game

    # -- lifecycle ---------------------------------------------------------
    def on_enter(self, **kwargs: Any) -> None:
        """Called when this scene becomes the active one."""

    def on_exit(self) -> None:
        """Called when this scene is replaced or popped."""

    # -- per-frame ---------------------------------------------------------
    def handle_event(self, event: "pygame.event.Event") -> None:
        """Handle one pygame event."""

    def update(self, dt: float) -> None:
        """Advance the scene by `dt` seconds."""

    def draw(self, surface: "pygame.Surface") -> None:
        """Render the scene onto `surface`."""


# ==========================================================================
# Small value types shared across layers
# ==========================================================================
@dataclass
class Rect:
    """A plain axis-aligned rectangle (kept free of pygame for easy testing)."""

    x: float
    y: float
    w: float
    h: float

    @property
    def left(self) -> float:
        return self.x

    @property
    def right(self) -> float:
        return self.x + self.w

    @property
    def top(self) -> float:
        return self.y

    @property
    def bottom(self) -> float:
        return self.y + self.h

    @property
    def cx(self) -> float:
        return self.x + self.w * 0.5

    @property
    def cy(self) -> float:
        return self.y + self.h * 0.5

    @property
    def center(self) -> Vec2:
        return (self.cx, self.cy)

    def contains(self, px: float, py: float) -> bool:
        return self.x <= px <= self.right and self.y <= py <= self.bottom

    def inflate(self, amount: float) -> "Rect":
        return Rect(self.x - amount, self.y - amount,
                    self.w + amount * 2, self.h + amount * 2)

    def overlaps_circle(self, cx: float, cy: float, r: float) -> bool:
        nx = max(self.x, min(cx, self.right))
        ny = max(self.y, min(cy, self.bottom))
        dx, dy = cx - nx, cy - ny
        return dx * dx + dy * dy <= r * r

    def as_tuple(self) -> Tuple[int, int, int, int]:
        return (int(self.x), int(self.y), int(self.w), int(self.h))


class HitKind:
    """What the snake just ran into. Returned by collision checks."""

    NONE = "none"
    WALL = "wall"
    SELF = "self"
    HAZARD = "hazard"


@dataclass
class PickupResult:
    """What happened during one update's pickup pass."""

    food_eaten: int = 0
    score_gained: int = 0
    powerups: List[str] = field(default_factory=list)


# ==========================================================================
# Geometry helpers used by more than one module
# ==========================================================================
TAU = math.pi * 2.0


def clamp(v: float, lo: float, hi: float) -> float:
    return lo if v < lo else (hi if v > hi else v)


def lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def dist(ax: float, ay: float, bx: float, by: float) -> float:
    return math.hypot(bx - ax, by - ay)


def dist_sq(ax: float, ay: float, bx: float, by: float) -> float:
    dx, dy = bx - ax, by - ay
    return dx * dx + dy * dy


def angle_to(ax: float, ay: float, bx: float, by: float) -> float:
    """Angle in radians of the vector a -> b."""
    return math.atan2(by - ay, bx - ax)


def wrap_angle(a: float) -> float:
    """Fold an angle into -pi .. +pi."""
    a = (a + math.pi) % TAU
    if a < 0:
        a += TAU
    return a - math.pi


def approach_angle(current: float, target: float, max_step: float) -> float:
    """Rotate `current` toward `target` by at most `max_step` radians."""
    diff = wrap_angle(target - current)
    if diff > max_step:
        diff = max_step
    elif diff < -max_step:
        diff = -max_step
    return wrap_angle(current + diff)


def ease_out_cubic(t: float) -> float:
    t = clamp(t, 0.0, 1.0)
    f = t - 1.0
    return f * f * f + 1.0


def ease_in_out_cubic(t: float) -> float:
    t = clamp(t, 0.0, 1.0)
    if t < 0.5:
        return 4.0 * t * t * t
    f = 2.0 * t - 2.0
    return 0.5 * f * f * f + 1.0


def ease_out_back(t: float) -> float:
    t = clamp(t, 0.0, 1.0)
    c1, c3 = 1.70158, 2.70158
    f = t - 1.0
    return 1.0 + c3 * f * f * f + c1 * f * f


def pulse(t: float, speed: float = 1.0) -> float:
    """A 0..1 sine oscillation, handy for glow and scale throbbing."""
    return 0.5 + 0.5 * math.sin(t * speed)
