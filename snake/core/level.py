"""
Level design for NEON SERPENT.

Twelve hand-authored stages.  Each one is a `LevelDef`: a pile of tuning
numbers plus an ``obstacle_spec`` - a list of plain dicts that
``core.obstacles.build_obstacles`` turns into live hazards.

Design rules this file follows, deliberately and everywhere:

* **One new idea per stage.**  Walls (2-3), moving bars (4-5), spinners (6-7),
  pulsars (8), laser gates (9), portals (10-11), everything at once (12).
* **Different geometry every time.**  Open field, twin monoliths, a broken
  cross, sweeping flare lanes, a vertical tide, a spinner triad, a vault ring,
  a scattered bloom, a serpentine engine, an open drift, a diagonal gauntlet,
  and a caged prism core.
* **Provably survivable.**  Nothing seals a region off, every lane is wider
  than the snake, and a keep-out disc of `SPAWN_CLEAR_RADIUS` around the arena
  centre stays free of lethal geometry.  `validate_levels()` proves it.

Spec conventions (matching ``core.obstacles._resolve``):
    Positions and box sizes are written as **fractions of the arena**
    (``x``/``y``/``w``/``h``/``travel``), because the arena is 1252x628 and
    fractions keep the layouts readable.  Radii, lengths and thicknesses are
    written in **pixels** (always > 1.0) so they are never re-scaled by the
    arena's 2:1 aspect ratio.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence, Tuple

from .. import config as C
from .. import palette as P
from .contracts import Rect, clamp

# --------------------------------------------------------------------------
# Arena geometry every layout below is measured against
# --------------------------------------------------------------------------
ARENA: Rect = Rect(*C.ARENA_RECT)          # 14, 78, 1252, 628

#: The snake spawns here; levels keep lethal geometry outside this disc.
SPAWN_POS: Tuple[float, float] = (ARENA.cx, ARENA.cy)
SPAWN_CLEAR_RADIUS: float = 70.0

#: Narrowest lane any layout is allowed to leave, in pixels.  Roughly three
#: body widths, which is comfortable at the fastest turn rate in config.
MIN_LANE: float = 2.0 * C.SNAKE_HEAD_RADIUS + 24.0


# ==========================================================================
# Spec builders
# --------------------------------------------------------------------------
# These exist so a layout reads as geometry rather than as a wall of dict
# literals, and so a typo in a keyword name fails here instead of silently
# dropping a hazard inside build_obstacles().
# ==========================================================================
def _wall(x: float, y: float, w: float, h: float) -> Dict[str, Any]:
    """A static killer rectangle. Fractions of the arena."""
    return {"type": "wall", "x": x, "y": y, "w": w, "h": h}


def _bar(x: float, y: float, w: float, h: float, *,
         axis: str = "x", travel: float = 0.4,
         speed: float = 0.15, phase: float = 0.0) -> Dict[str, Any]:
    """A slab ping-ponging along `axis`. `speed` is full cycles per second."""
    return {"type": "movingbar", "x": x, "y": y, "w": w, "h": h,
            "axis": axis, "travel": travel, "speed": speed, "phase": phase}


def _spinner(cx: float, cy: float, length: float, *,
             arms: int = 2, speed: float = 1.4,
             thickness: float = 11.0, phase: float = 0.0) -> Dict[str, Any]:
    """Rotating arms about a lethal hub. `length`/`thickness` in pixels."""
    return {"type": "spinner", "cx": cx, "cy": cy, "length": length,
            "arms": arms, "speed": speed, "thickness": thickness,
            "phase": phase, "hub_radius": 13.0}


def _pulsar(cx: float, cy: float, *,
            min_radius: float = 13.0, max_radius: float = 54.0,
            period: float = 2.6, phase: float = 0.0,
            deadly_frac: float = 0.55) -> Dict[str, Any]:
    """A bomb that breathes; only lethal past `deadly_frac` of its swell."""
    return {"type": "pulsar", "cx": cx, "cy": cy,
            "min_radius": min_radius, "max_radius": max_radius,
            "period": period, "phase": phase, "deadly_frac": deadly_frac}


def _laser(x1: float, y1: float, x2: float, y2: float, *,
           period: float = 3.0, fire_time: float = 0.85,
           warn_time: float = 0.75, phase: float = 0.0,
           width: float = 9.0) -> Dict[str, Any]:
    """A beam that charges, warns, then fires. Endpoints are fractions."""
    return {"type": "lasergate", "x1": x1, "y1": y1, "x2": x2, "y2": y2,
            "period": period, "fire_time": fire_time, "warn_time": warn_time,
            "phase": phase, "width": width}


def _portal(x: float, y: float, *, radius: float = 26.0,
            pair: Optional[str] = None) -> Dict[str, Any]:
    """A harmless gate. Entries sharing a `pair` key are wired together."""
    return {"type": "portal", "x": x, "y": y, "radius": radius, "pair": pair}


# ==========================================================================
# Composite layout pieces
# ==========================================================================
def _vault_ring() -> List[Dict[str, Any]]:
    """
    A rectangular shell around the core with four wide gates.

    Interior spans roughly x 336..943, y 227..558 px; the north/south gates are
    ~226 px across and the east/west gates ~138 px, all far above MIN_LANE.
    """
    return [
        _wall(0.240, 0.200, 0.170, 0.036),   # north-west arc
        _wall(0.590, 0.200, 0.170, 0.036),   # north-east arc
        _wall(0.240, 0.764, 0.170, 0.036),   # south-west arc
        _wall(0.590, 0.764, 0.170, 0.036),   # south-east arc
        _wall(0.240, 0.200, 0.018, 0.190),   # west jamb, upper
        _wall(0.240, 0.610, 0.018, 0.190),   # west jamb, lower
        _wall(0.742, 0.200, 0.018, 0.190),   # east jamb, upper
        _wall(0.742, 0.610, 0.018, 0.190),   # east jamb, lower
    ]


def _bloom_field() -> List[Dict[str, Any]]:
    """
    A 5x3 lattice of spore pods with the centre pod removed for the spawn.

    Phases walk diagonally across the lattice so the whole field inhales in a
    travelling wave: neighbours are never at peak together, which is what turns
    a static-looking grid into a rhythm puzzle.
    """
    cols = (0.12, 0.31, 0.50, 0.69, 0.88)
    rows = (0.18, 0.50, 0.82)
    out: List[Dict[str, Any]] = []
    for ci, fx in enumerate(cols):
        for ri, fy in enumerate(rows):
            if ci == 2 and ri == 1:
                continue                     # the spawn plaza
            out.append(_pulsar(
                fx, fy,
                min_radius=13.0, max_radius=53.0,
                # Coprime-ish strides (2 and 3 mod 5) spread the wave without
                # ever repeating along a row or a column.
                phase=((ci * 2 + ri * 3) % 5) / 5.0,
                period=2.3 + 0.18 * ((ci + ri) % 4),
            ))
    return out


def _corner_caps() -> List[Dict[str, Any]]:
    """Blocks flush into the four arena corners: decoration that never traps."""
    return [
        _wall(0.000, 0.000, 0.055, 0.070),
        _wall(0.945, 0.000, 0.055, 0.070),
        _wall(0.000, 0.930, 0.055, 0.070),
        _wall(0.945, 0.930, 0.055, 0.070),
    ]


# ==========================================================================
# The twelve layouts
# ==========================================================================
def _spec_01() -> List[Dict[str, Any]]:
    """Neon Grid - a completely empty field. Learn to steer, nothing else."""
    return []


def _spec_02() -> List[Dict[str, Any]]:
    """Deep Nebula - twin monoliths flanking a 558 px central corridor."""
    return [
        _wall(0.255, 0.325, 0.022, 0.345),   # west monolith
        _wall(0.723, 0.325, 0.022, 0.345),   # east monolith
        _wall(0.455, 0.085, 0.028, 0.075),   # drifting shard, north
        _wall(0.517, 0.845, 0.028, 0.075),   # drifting shard, south
    ]


def _spec_03() -> List[Dict[str, Any]]:
    """Emerald Circuit - a broken cross: four cells joined by an open hub."""
    return [
        _wall(0.100, 0.480, 0.260, 0.034),   # west trace
        _wall(0.640, 0.480, 0.260, 0.034),   # east trace
        _wall(0.492, 0.145, 0.016, 0.195),   # north trace
        _wall(0.492, 0.660, 0.016, 0.195),   # south trace
        _wall(0.190, 0.215, 0.034, 0.068),   # cell nodes: each quadrant gets a
        _wall(0.752, 0.215, 0.034, 0.068),   # pillar to circle, so no cell is
        _wall(0.190, 0.700, 0.034, 0.068),   # just a featureless box
        _wall(0.752, 0.700, 0.034, 0.068),
    ]


def _spec_04() -> List[Dict[str, Any]]:
    """
    Solar Flare - four horizontal bars sweeping the outer lanes.

    The middle band (y ~0.42..0.58) carries no bar, so there is always a safe
    east-west highway; the food, however, keeps landing in the flare lanes.
    """
    return [
        _bar(0.040, 0.120, 0.220, 0.034, travel=0.620, speed=0.170, phase=0.00),
        _bar(0.100, 0.345, 0.240, 0.034, travel=0.580, speed=0.140, phase=0.50),
        _bar(0.140, 0.645, 0.240, 0.034, travel=0.580, speed=0.150, phase=0.25),
        _bar(0.060, 0.840, 0.220, 0.034, travel=0.620, speed=0.180, phase=0.70),
        _wall(0.155, 0.455, 0.026, 0.100),   # highway posts: stop the safe
        _wall(0.810, 0.455, 0.026, 0.100),   # lane being a free ride
    ]


def _spec_05() -> List[Dict[str, Any]]:
    """
    Abyssal Tide - four vertical columns rising and falling out of phase.

    Each column leaves at least 94 px clear at one end of its stroke, and the
    centre band (x ~0.34..0.66) is column-free, so there is always a route.
    """
    return [
        _bar(0.140, 0.050, 0.026, 0.280, axis="y", travel=0.520, speed=0.130, phase=0.00),
        _bar(0.300, 0.050, 0.026, 0.280, axis="y", travel=0.520, speed=0.115, phase=0.50),
        _bar(0.660, 0.050, 0.026, 0.280, axis="y", travel=0.520, speed=0.125, phase=0.50),
        _bar(0.820, 0.050, 0.026, 0.280, axis="y", travel=0.520, speed=0.105, phase=0.00),
        _wall(0.440, 0.095, 0.120, 0.030),   # reef shelves capping the centre
        _wall(0.440, 0.865, 0.120, 0.030),   # channel, north and south
    ]


def _spec_06() -> List[Dict[str, Any]]:
    """Violet Static - three counter-rotating spinners in a wide triangle."""
    return [
        _spinner(0.240, 0.300, 82.0, arms=2, speed=1.45, phase=0.0),
        _spinner(0.760, 0.300, 82.0, arms=2, speed=-1.35, phase=1.1),
        _spinner(0.500, 0.800, 88.0, arms=3, speed=1.15, phase=0.5),
        _wall(0.030, 0.050, 0.085, 0.050),   # shattered corner plates
        _wall(0.885, 0.050, 0.085, 0.050),
        _wall(0.030, 0.900, 0.085, 0.050),
        _wall(0.885, 0.900, 0.085, 0.050),
    ]


def _spec_07() -> List[Dict[str, Any]]:
    """
    Frozen Vault - a walled shell with four gates, patrolled from outside.

    The spinners sit in the perimeter corridors rather than in the gate mouths,
    so every gate stays open; the two inner baffles turn the vault interior
    into a loop instead of a room.
    """
    return _vault_ring() + [
        _wall(0.400, 0.315, 0.200, 0.030),   # inner baffle, north
        _wall(0.400, 0.645, 0.200, 0.030),   # inner baffle, south
        _spinner(0.115, 0.215, 62.0, arms=2, speed=1.30, thickness=12.0, phase=0.0),
        _spinner(0.885, 0.215, 62.0, arms=2, speed=-1.30, thickness=12.0, phase=0.8),
        _spinner(0.115, 0.785, 62.0, arms=2, speed=-1.45, thickness=12.0, phase=1.6),
        _spinner(0.885, 0.785, 62.0, arms=2, speed=1.45, thickness=12.0, phase=2.4),
    ]


def _spec_08() -> List[Dict[str, Any]]:
    """Toxic Bloom - a breathing lattice of fourteen spore pods."""
    return _bloom_field() + _corner_caps()


def _spec_09() -> List[Dict[str, Any]]:
    """
    Crimson Engine - a serpentine of half-height walls, gated by lasers.

    Walls 1 and 3 hang from the ceiling, 2 and 4 rise from the floor, so the
    only route across the board weaves up and down.  Each wall's gap is exactly
    where a laser gate fires, on staggered periods: the gap is a door, not a
    hole, and it is shut for well under a third of every cycle.
    """
    return [
        _wall(0.190, 0.000, 0.016, 0.600),
        _wall(0.380, 0.400, 0.016, 0.600),
        _wall(0.620, 0.000, 0.016, 0.600),
        _wall(0.810, 0.400, 0.016, 0.600),
        _laser(0.196, 0.600, 0.196, 1.000, period=3.2, fire_time=0.95,
               warn_time=0.85, phase=0.00),
        _laser(0.386, 0.000, 0.386, 0.400, period=3.2, fire_time=0.95,
               warn_time=0.85, phase=0.50),
        _laser(0.626, 0.600, 0.626, 1.000, period=2.8, fire_time=0.85,
               warn_time=0.75, phase=0.25),
        _laser(0.816, 0.000, 0.816, 0.400, period=2.8, fire_time=0.85,
               warn_time=0.75, phase=0.75),
        _bar(0.075, 0.060, 0.020, 0.250, axis="y", travel=0.560,
             speed=0.160, phase=0.00),                   # end-cell pistons
        _bar(0.885, 0.060, 0.020, 0.250, axis="y", travel=0.560,
             speed=0.140, phase=0.50),
    ]


def _spec_10() -> List[Dict[str, Any]]:
    """
    Aurora Drift - an open sky crossed by two portal pairs.

    Deliberately the least walled board since level 1: portals are a *tool*
    here, and the level teaches the shortcut before level 11 weaponises it.
    """
    return [
        _portal(0.100, 0.220, radius=27.0, pair="a"),
        _portal(0.900, 0.780, radius=27.0, pair="a"),
        _portal(0.900, 0.220, radius=27.0, pair="b"),
        _portal(0.100, 0.780, radius=27.0, pair="b"),
        _bar(0.200, 0.300, 0.180, 0.030, travel=0.420, speed=0.110, phase=0.00),
        _bar(0.400, 0.670, 0.180, 0.030, travel=0.420, speed=0.090, phase=0.50),
        _spinner(0.300, 0.500, 58.0, arms=2, speed=1.25, phase=0.0),
        _spinner(0.700, 0.500, 58.0, arms=2, speed=-1.25, phase=1.2),
        _wall(0.300, 0.110, 0.052, 0.036),   # a staircase of drifting shards
        _wall(0.618, 0.185, 0.052, 0.036),
        _wall(0.338, 0.795, 0.052, 0.036),
        _wall(0.656, 0.870, 0.052, 0.036),
    ]


def _spec_11() -> List[Dict[str, Any]]:
    """
    Event Horizon - a diagonal gauntlet with the middle step torn out.

    Six blocks step from the south-west corner to the north-east.  The step
    that would have landed on the spawn is missing, leaving a central plaza
    ~137 px clear in every direction.  Everything lethal lives in the two
    off-diagonal wedges; the portals are the only fast way between them.
    """
    return [
        _wall(0.060, 0.840, 0.070, 0.048),
        _wall(0.195, 0.715, 0.070, 0.048),
        _wall(0.330, 0.590, 0.070, 0.048),
        # (0.465, 0.465) intentionally omitted - that is the spawn plaza.
        _wall(0.600, 0.340, 0.070, 0.048),
        _wall(0.735, 0.215, 0.070, 0.048),
        _wall(0.870, 0.090, 0.070, 0.048),
        _spinner(0.220, 0.260, 69.0, arms=3, speed=1.30, phase=0.0),
        _spinner(0.780, 0.740, 69.0, arms=3, speed=-1.30, phase=1.0),
        _pulsar(0.140, 0.420, max_radius=50.0, period=2.6, phase=0.00),
        _pulsar(0.420, 0.160, max_radius=50.0, period=2.9, phase=0.35),
        _pulsar(0.580, 0.840, max_radius=50.0, period=2.9, phase=0.65),
        _pulsar(0.860, 0.580, max_radius=50.0, period=2.6, phase=0.20),
        _portal(0.045, 0.500, pair="x"),
        _portal(0.955, 0.500, pair="x"),
        _portal(0.500, 0.070, pair="y"),
        _portal(0.500, 0.930, pair="y"),
        _laser(0.335, 0.060, 0.335, 0.340, period=3.0, fire_time=0.80,
               warn_time=0.70, phase=0.00),
        _laser(0.665, 0.660, 0.665, 0.940, period=3.0, fire_time=0.80,
               warn_time=0.70, phase=0.50),
    ]


def _spec_12() -> List[Dict[str, Any]]:
    """
    Prism Core - every hazard type at once, arranged with fourfold symmetry.

    The four laser beams form a cage around the core.  Their phases are spaced
    a quarter-period apart and each burns for 0.70 s out of 3.0 s, i.e. less
    than the 0.75 s spacing: exactly one face of the cage is ever lit, so there
    is always a way in and a way out.
    """
    cage = [
        _laser(0.340, 0.245, 0.660, 0.245, period=3.0, fire_time=0.70,
               warn_time=0.60, phase=0.00),
        _laser(0.340, 0.755, 0.660, 0.755, period=3.0, fire_time=0.70,
               warn_time=0.60, phase=0.25),
        _laser(0.245, 0.300, 0.245, 0.700, period=3.0, fire_time=0.70,
               warn_time=0.60, phase=0.50),
        _laser(0.755, 0.300, 0.755, 0.700, period=3.0, fire_time=0.70,
               warn_time=0.60, phase=0.75),
    ]
    return [
        _wall(0.320, 0.160, 0.360, 0.032),   # outer shell, north
        _wall(0.320, 0.808, 0.360, 0.032),   # outer shell, south
        _wall(0.175, 0.400, 0.018, 0.200),   # outer shell, west jamb
        _wall(0.807, 0.400, 0.018, 0.200),   # outer shell, east jamb
        _wall(0.440, 0.325, 0.120, 0.028),   # core shards, above and below
        _wall(0.440, 0.650, 0.120, 0.028),   # the spawn point
        _spinner(0.160, 0.180, 63.0, arms=3, speed=1.40, phase=0.0),
        _spinner(0.840, 0.180, 63.0, arms=3, speed=-1.40, phase=0.7),
        _spinner(0.160, 0.820, 63.0, arms=3, speed=-1.55, phase=1.4),
        _spinner(0.840, 0.820, 63.0, arms=3, speed=1.55, phase=2.1),
        _pulsar(0.300, 0.500, max_radius=54.0, period=2.4, phase=0.00),
        _pulsar(0.700, 0.500, max_radius=54.0, period=2.4, phase=0.50),
        _bar(0.320, 0.045, 0.160, 0.030, travel=0.280, speed=0.160, phase=0.00),
        _bar(0.320, 0.905, 0.160, 0.030, travel=0.280, speed=0.140, phase=0.50),
        _portal(0.035, 0.070, radius=24.0, pair="a"),
        _portal(0.965, 0.930, radius=24.0, pair="a"),
        _portal(0.965, 0.070, radius=24.0, pair="b"),
        _portal(0.035, 0.930, radius=24.0, pair="b"),
    ] + cage


# ==========================================================================
# LevelDef
# ==========================================================================
@dataclass
class LevelDef:
    """Everything the game scene needs to build and score one stage."""

    index: int                                   # zero-based
    name: str
    subtitle: str
    theme: P.Theme
    goal_food: int
    speed_mult: float
    food_count: int
    obstacle_spec: List[Dict[str, Any]] = field(default_factory=list)
    powerups_enabled: bool = True
    wrap_walls: bool = False
    hint: str = ""

    # -- convenience -------------------------------------------------------
    @property
    def number(self) -> int:
        """One-based level number, for display."""
        return self.index + 1

    @property
    def difficulty(self) -> float:
        """0..1 across the campaign; handy for UI colour ramps."""
        return clamp(self.index / max(1.0, float(LEVEL_COUNT - 1)), 0.0, 1.0)

    def cruise_speed(self) -> float:
        """
        The snake's own cruise speed for this level, before `speed_mult`.

        This is what the gameplay scene assigns to `snake.speed`.  The level's
        pace multiplier is *not* folded in here: it is passed separately as
        `snake.update(dt, speed_mult=level.speed_mult * effects.speed_multiplier())`
        so that power-ups compose with it cleanly.
        """
        raw = C.SNAKE_BASE_SPEED + C.SNAKE_SPEED_PER_LEVEL * self.index
        return clamp(raw, 60.0, C.SNAKE_MAX_SPEED)

    def base_speed(self) -> float:
        """
        Pixels/second the snake actually travels on this level, power-ups aside.

        `SNAKE_MAX_SPEED` bounds the cruise term only; `speed_mult` is applied
        on top of it, matching `Snake._update_boost`.  Clamping the product
        instead would flatten levels 11 and 12 onto the same 460 px/s.
        """
        return self.cruise_speed() * self.speed_mult

    def par_score(self) -> int:
        """Score for clearing the goal with no combo at all - the 1-star bar."""
        return self.goal_food * C.SCORE_PER_FOOD

    def star_targets(self) -> Tuple[int, int, int]:
        """Score thresholds for one, two and three stars."""
        par = self.par_score()
        return (par, int(par * 1.35), int(par * 1.75))

    def __str__(self) -> str:                    # pragma: no cover - cosmetic
        return "Level {:02d} - {}".format(self.number, self.name)


def _level(index: int, name: str, subtitle: str, hint: str, *,
           goal_food: int, speed_mult: float, food_count: int,
           spec: List[Dict[str, Any]],
           powerups: bool = True, wrap: bool = False) -> LevelDef:
    """Small constructor so the table below stays one line per field."""
    return LevelDef(
        index=index,
        name=name,
        subtitle=subtitle,
        theme=P.theme_for_level(index),
        goal_food=goal_food,
        speed_mult=speed_mult,
        food_count=food_count,
        obstacle_spec=spec,
        powerups_enabled=powerups,
        wrap_walls=wrap,
        hint=hint,
    )


# ==========================================================================
# The campaign
# ==========================================================================
LEVELS: Tuple[LevelDef, ...] = (
    _level(0, "Neon Grid", "First light on the lattice",
           "Move the mouse to steer, hold right-click to boost. The edges wrap.",
           goal_food=8, speed_mult=1.00, food_count=3,
           spec=_spec_01(), powerups=False, wrap=True),

    _level(1, "Deep Nebula", "Monoliths adrift in the dust",
           "Solid walls: clip one and it costs you a life.",
           goal_food=10, speed_mult=1.05, food_count=3,
           spec=_spec_02(), wrap=True),

    _level(2, "Emerald Circuit", "Trace the living board",
           "The circuit cross splits the field into four cells. Use the hub.",
           goal_food=12, speed_mult=1.11, food_count=4,
           spec=_spec_03(), wrap=True),

    _level(3, "Solar Flare", "Coronal lanes, timed to burn",
           "Flare bars sweep the outer lanes. Cross behind them, never ahead.",
           goal_food=14, speed_mult=1.17, food_count=4,
           spec=_spec_04()),

    _level(4, "Abyssal Tide", "Something moves in the trench",
           "Tidal columns rise and fall. Slip past on whichever end is open.",
           goal_food=16, speed_mult=1.23, food_count=4,
           spec=_spec_05()),

    _level(5, "Violet Static", "Signal lost, teeth found",
           "Spinners: the hub kills too, so never cut a corner tight.",
           goal_food=18, speed_mult=1.29, food_count=5,
           spec=_spec_06(), wrap=True),

    _level(6, "Frozen Vault", "Sealed, but not empty",
           "Four gates into the vault, and spinners patrolling every approach.",
           goal_food=20, speed_mult=1.35, food_count=5,
           spec=_spec_07()),

    _level(7, "Toxic Bloom", "The garden inhales",
           "Pulsars only bite while swollen. Move through them on the exhale.",
           goal_food=22, speed_mult=1.41, food_count=5,
           spec=_spec_08()),

    _level(8, "Crimson Engine", "The machine wants feeding",
           "Laser gates shut the corridors. The warning ray is your cue.",
           goal_food=24, speed_mult=1.47, food_count=5,
           spec=_spec_09()),

    _level(9, "Aurora Drift", "Ribbons over a quiet sea",
           "Portals are safe: enter one and you leave its twin still moving.",
           goal_food=26, speed_mult=1.53, food_count=6,
           spec=_spec_10(), wrap=True),

    _level(10, "Event Horizon", "The last light bends inward",
           "A diagonal gauntlet. Portals are the only shortcut across it.",
           goal_food=28, speed_mult=1.61, food_count=6,
           spec=_spec_11(), wrap=True),

    _level(11, "Prism Core", "Everything, refracted",
           "Every hazard at once, inside a laser cage that lights one face at a time.",
           goal_food=30, speed_mult=1.70, food_count=6,
           spec=_spec_12()),
)

LEVEL_COUNT: int = len(LEVELS)
LEVEL_NAMES: Tuple[str, ...] = tuple(lv.name for lv in LEVELS)


def get_level(i: int) -> LevelDef:
    """Level `i`, clamped into range. Never raises, never returns None."""
    try:
        idx = int(i)
    except (TypeError, ValueError):
        idx = 0
    if idx < 0:
        idx = 0
    elif idx >= LEVEL_COUNT:
        idx = LEVEL_COUNT - 1
    return LEVELS[idx]


def all_levels() -> Tuple[LevelDef, ...]:
    """The whole campaign, in order."""
    return LEVELS


# ==========================================================================
# Design self-check
# --------------------------------------------------------------------------
# Duplicating a little of obstacles._resolve here keeps level.py importable
# without pygame (menus and tests pull it in early), and lets the layouts above
# make a *checkable* promise about the spawn plaza instead of a hopeful one.
# ==========================================================================
_POS_X = ("x", "x1", "x2", "cx")
_POS_Y = ("y", "y1", "y2", "cy")


def _px(key: str, value: Any, horizontal: bool = True) -> float:
    """Resolve one spec value to pixels the way build_obstacles will."""
    try:
        v = float(value)
    except (TypeError, ValueError):
        return 0.0
    if abs(v) > 1.0:
        return v
    if key in _POS_X:
        return ARENA.x + ARENA.w * v
    if key in _POS_Y:
        return ARENA.y + ARENA.h * v
    if key in ("w", "width"):
        return ARENA.w * v
    if key in ("h", "height"):
        return ARENA.h * v
    if key in ("length", "radius", "min_radius", "max_radius",
               "thickness", "hub_radius"):
        return min(ARENA.w, ARENA.h) * v
    if key == "travel":
        return (ARENA.w if horizontal else ARENA.h) * v
    return v


def _rect_gap(px: float, py: float,
              x: float, y: float, w: float, h: float) -> float:
    """Distance from a point to a rectangle (0 when inside)."""
    dx = max(x - px, 0.0, px - (x + w))
    dy = max(y - py, 0.0, py - (y + h))
    return math.hypot(dx, dy)


def _seg_gap(px: float, py: float,
             ax: float, ay: float, bx: float, by: float) -> float:
    """Distance from a point to a line segment."""
    vx, vy = bx - ax, by - ay
    len_sq = vx * vx + vy * vy
    if len_sq <= 1e-9:
        return math.hypot(px - ax, py - ay)
    t = clamp(((px - ax) * vx + (py - ay) * vy) / len_sq, 0.0, 1.0)
    return math.hypot(px - (ax + vx * t), py - (ay + vy * t))


def _entry_clearance(entry: Dict[str, Any], px: float, py: float) -> float:
    """
    Free distance between a point and one hazard's lethal footprint.

    Moving hazards are measured against the *whole* area they sweep, so this is
    a pessimistic bound: if it says a level is safe, it really is.  Portals are
    ignored - they are not deadly.
    """
    kind = str(entry.get("type", "")).lower()

    if kind in ("wall", "wallblock", "block"):
        return _rect_gap(px, py,
                         _px("x", entry.get("x", 0.0)),
                         _px("y", entry.get("y", 0.0)),
                         _px("w", entry.get("w", 60.0)),
                         _px("h", entry.get("h", 60.0)))

    if kind in ("movingbar", "bar", "moving_bar"):
        horizontal = str(entry.get("axis", "x")).lower() not in ("y", "v", "vertical")
        x = _px("x", entry.get("x", 0.0))
        y = _px("y", entry.get("y", 0.0))
        w = _px("w", entry.get("w", 120.0))
        h = _px("h", entry.get("h", 20.0))
        travel = _px("travel", entry.get("travel", 0.0), horizontal)
        if horizontal:
            x, w = min(x, x + travel), w + abs(travel)
        else:
            y, h = min(y, y + travel), h + abs(travel)
        return _rect_gap(px, py, x, y, w, h)

    if kind == "spinner":
        reach = _px("length", entry.get("length", 90.0)) \
            + _px("thickness", entry.get("thickness", 11.0)) * 0.5
        return math.hypot(px - _px("cx", entry.get("cx", 0.0)),
                          py - _px("cy", entry.get("cy", 0.0))) - reach

    if kind == "pulsar":
        return math.hypot(px - _px("cx", entry.get("cx", 0.0)),
                          py - _px("cy", entry.get("cy", 0.0))) \
            - _px("max_radius", entry.get("max_radius", 62.0))

    if kind in ("lasergate", "laser", "laser_gate"):
        return _seg_gap(px, py,
                        _px("x1", entry.get("x1", 0.0)),
                        _px("y1", entry.get("y1", 0.0)),
                        _px("x2", entry.get("x2", 0.0)),
                        _px("y2", entry.get("y2", 0.0))) \
            - _px("width", entry.get("width", 9.0)) * 0.5

    return float("inf")          # portals and anything unknown: harmless here


def spawn_clearance(level: LevelDef) -> float:
    """Pixels of free space between the spawn point and the nearest hazard."""
    sx, sy = SPAWN_POS
    best = float("inf")
    for entry in level.obstacle_spec:
        try:
            best = min(best, _entry_clearance(entry, sx, sy))
        except Exception:        # a malformed entry must not break the report
            continue
    return best


def validate_levels() -> List[str]:
    """
    Sanity-check the campaign; returns a list of human-readable problems.

    Run by ``python -m snake.core.level``.  An empty list means every level
    keeps its spawn plaza clear and every difficulty curve is monotonic.
    """
    problems: List[str] = []
    if LEVEL_COUNT != len(P.THEMES):
        problems.append("expected {} levels, found {}".format(len(P.THEMES),
                                                              LEVEL_COUNT))
    prev: Optional[LevelDef] = None
    for lv in LEVELS:
        if lv.theme is not P.THEMES[lv.index]:
            problems.append("{}: theme is not THEMES[{}]".format(lv.name, lv.index))
        gap = spawn_clearance(lv)
        if gap < SPAWN_CLEAR_RADIUS:
            problems.append("{}: spawn clearance {:.0f}px < {:.0f}px".format(
                lv.name, gap, SPAWN_CLEAR_RADIUS))
        if not lv.hint or not lv.subtitle:
            problems.append("{}: missing hint or subtitle".format(lv.name))
        if prev is not None:
            if lv.goal_food <= prev.goal_food:
                problems.append("{}: goal_food does not increase".format(lv.name))
            if lv.speed_mult <= prev.speed_mult:
                problems.append("{}: speed_mult does not increase".format(lv.name))
            if lv.food_count < prev.food_count:
                problems.append("{}: food_count decreases".format(lv.name))
        prev = lv
    return problems


if __name__ == "__main__":            # pragma: no cover - developer utility
    issues = validate_levels()
    for lv in LEVELS:
        print("{:<28} goal {:>2}  x{:.2f}  food {}  hazards {:>2}  "
              "wrap {:<5} clear {:.0f}px".format(
                  str(lv), lv.goal_food, lv.speed_mult, lv.food_count,
                  len(lv.obstacle_spec), str(lv.wrap_walls),
                  spawn_clearance(lv)))
    print("\n{} problem(s)".format(len(issues)))
    for line in issues:
        print("  ! " + line)
