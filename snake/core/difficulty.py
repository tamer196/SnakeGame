"""
Difficulty tuning table for NEON SERPENT.

Four modes - EASY, NORMAL, HARD, EXPERT - each a frozen :class:`Difficulty`
record of multipliers that the rest of the game reads instead of hard-coding
its own balance.  NORMAL is the identity row: every one of its multipliers is
``1.0`` and its ``lives`` is :data:`~snake.config.START_LIVES`, so a game that
runs on NORMAL plays exactly as it did before this module existed.  That is a
deliberate invariant - :func:`_assert_normal_is_identity` checks it at import
time in a way that can never raise.

The module is pure data plus small pure functions.  It imports nothing but
``config`` - never pygame, never another core module - so it is safe to import
from any layer (scenes, HUD, save, tools) without circular-import or headless
risk.

Reading the table
-----------------
Every ``*_mult`` field is a *scale on the existing constant*, never a
replacement for it, so the level table and ``config`` stay the single source of
truth for absolute numbers::

    snake.update(dt, speed_mult=level.speed_mult * diff.speed_mult * ...,
                     turn_mult=effects.turn_multiplier() * diff.turn_mult)

    invuln   = C.INVULN_AFTER_HIT * diff.invuln_mult
    combo_w  = C.COMBO_WINDOW * diff.combo_window_mult
    points   = base_value * diff.food_value_mult * diff.score_mult

Self-collision
--------------
``self_mode`` is the headline knob and is one of:

``"off"``
    The head can never kill itself.  :func:`self_collision_enabled` returns
    ``False`` and :func:`self_collision_skip` returns :data:`SKIP_NEVER`, a
    sentinel far larger than any reachable body length, so a caller that only
    knows how to pass a skip count still gets the right behaviour.

The three helpers line up one-to-one with the entity's own signature::

    hit = snake.hits_self(skip=self_collision_skip(diff),
                          depth=self_collision_depth(diff),
                          enabled=self_collision_enabled(diff)
                                  and not effects.has("ghost"))
``"forgiving"``
    The shipped NORMAL balance: a wide skip window behind the head plus the
    :data:`~snake.config.SELF_COLLISION_DEPTH` cross-over allowance, so a
    hairpin turn passes over your own neck instead of ending the run.
``"normal"``
    A shorter skip window and a stricter overlap depth.
``"strict"``
    The shortest skip window and the strictest depth - clipping your own coil
    is fatal almost as soon as the circles touch.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, Iterable, List, Optional, Sequence, Tuple, Union

from .. import config as C

__all__ = [
    "Difficulty",
    "DIFFICULTIES",
    "ORDER",
    "SELF_MODES",
    "SKIP_NEVER",
    "DEFAULT",
    "get_difficulty",
    "next_difficulty",
    "prev_difficulty",
    "index_of",
    "is_difficulty_key",
    "self_collision_skip",
    "self_collision_enabled",
    "self_collision_depth",
    "apply_star_targets",
    "lives_for",
    "invuln_seconds",
    "combo_window",
    "powerup_spawn_range",
    "score_for_food",
    "all_difficulties",
    "labels",
]

#: A skip count no snake can ever reach, meaning "self-collision is disabled".
#: Handed to callers that only speak "ignore the first N segments".
SKIP_NEVER: int = 1 << 30

#: The legal values of :attr:`Difficulty.self_mode`, easiest first.
SELF_MODES: Tuple[str, str, str, str] = ("off", "forgiving", "normal", "strict")

#: Multiplier applied to :data:`~snake.config.SELF_COLLISION_DEPTH` per mode.
#: Following the convention documented in ``config``, a *lower* value is
#: stricter and a higher one is more forgiving.  ``"off"`` never consults it.
_SELF_MODE_DEPTH: Dict[str, float] = {
    "off": 1.60,
    "forgiving": 1.00,
    "normal": 0.90,
    "strict": 0.78,
}

#: Anything a public helper will accept in place of a key.
DiffLike = Union[str, "Difficulty", None]


# ==========================================================================
# The record
# ==========================================================================
@dataclass(frozen=True)
class Difficulty:
    """
    One immutable row of the balance table.

    Instances are shared, hashable and never mutated; treat them as constants.
    Fields are grouped below in the order the gameplay scene consumes them.
    """

    # -- identity ----------------------------------------------------------
    key: str
    """Stable id, one of the ``C.DIFF_*`` constants.  Saved to disk."""

    name: str
    """Display name for menus, e.g. ``"Expert"``."""

    blurb: str
    """One short sentence of flavour, shown under the name on the picker."""

    color: Tuple[int, int, int]
    """RGB accent used for this mode's chip, bar and HUD tag."""

    hud_label: str
    """Very short all-caps tag for the in-game HUD, e.g. ``"EXPERT"``."""

    rank: int
    """Position in :data:`ORDER`, 0 (easiest) to 3 (hardest)."""

    # -- survival ----------------------------------------------------------
    lives: int
    """Lives the run starts with; replaces :data:`~snake.config.START_LIVES`."""

    invuln_mult: float
    """Scale on :data:`~snake.config.INVULN_AFTER_HIT` mercy invulnerability."""

    # -- movement ----------------------------------------------------------
    speed_mult: float
    """Extra scale on the snake's speed, composed with ``level.speed_mult``."""

    turn_mult: float
    """Extra scale on the steering rate, composed with power-up turn bonuses."""

    # -- self-collision ----------------------------------------------------
    self_mode: str
    """One of :data:`SELF_MODES`; see the module docstring."""

    self_skip_mult: float
    """Scale on :data:`~snake.config.SELF_COLLISION_SKIP` (ignored when off)."""

    self_depth_mult: float
    """Scale on :data:`~snake.config.SELF_COLLISION_DEPTH` (ignored when off)."""

    # -- hazards / pickups -------------------------------------------------
    hazard_speed_mult: float
    """Scale on how fast moving obstacles patrol, spin and sweep."""

    powerup_rate_mult: float
    """How *often* power-ups appear.  >1 is more often, so spawn intervals are
    divided by it - see :func:`powerup_spawn_range`."""

    # -- scoring -----------------------------------------------------------
    food_value_mult: float
    """Scale on each orb's own point value, before :attr:`score_mult`."""

    score_mult: float
    """Scale on everything banked - the risk premium for the harder modes."""

    combo_window_mult: float
    """Scale on :data:`~snake.config.COMBO_WINDOW`, the chaining grace period."""

    star_target_mult: float
    """Scale on a level's one/two/three-star score thresholds."""

    # -- derived conveniences ---------------------------------------------
    @property
    def label(self) -> str:
        """Upper-case name, handy for buttons that shout."""
        return self.name.upper()

    @property
    def is_default(self) -> bool:
        """True for the reference balance (NORMAL)."""
        return self.key == C.DEFAULT_DIFFICULTY

    @property
    def self_kills(self) -> bool:
        """True when running over your own body can end a life."""
        return self.self_mode != "off"

    def __str__(self) -> str:                    # pragma: no cover - cosmetic
        return "{} ({} lives)".format(self.name, self.lives)


# ==========================================================================
# The table
# ==========================================================================
_EASY = Difficulty(
    key=C.DIFF_EASY,
    name="Easy",
    blurb="Drift, coil and never once die to your own tail.",
    color=(86, 240, 160),
    hud_label="EASY",
    rank=0,
    lives=5,
    invuln_mult=1.90,
    speed_mult=0.82,
    turn_mult=1.30,
    self_mode="off",
    self_skip_mult=2.00,
    self_depth_mult=_SELF_MODE_DEPTH["off"],
    hazard_speed_mult=0.85,
    powerup_rate_mult=1.45,
    food_value_mult=1.15,
    score_mult=0.80,
    combo_window_mult=1.50,
    star_target_mult=0.75,
)

_NORMAL = Difficulty(
    key=C.DIFF_NORMAL,
    name="Normal",
    blurb="The serpent as intended - fair, fast, unforgiving of sloppiness.",
    color=(96, 202, 255),
    hud_label="NORMAL",
    rank=1,
    lives=C.START_LIVES,
    invuln_mult=1.00,
    speed_mult=1.00,
    turn_mult=1.00,
    self_mode="forgiving",
    self_skip_mult=1.00,
    self_depth_mult=_SELF_MODE_DEPTH["forgiving"],
    hazard_speed_mult=1.00,
    powerup_rate_mult=1.00,
    food_value_mult=1.00,
    score_mult=1.00,
    combo_window_mult=1.00,
    star_target_mult=1.00,
)

_HARD = Difficulty(
    key=C.DIFF_HARD,
    name="Hard",
    blurb="Faster hazards, thinner mercy, and your own coil bites back.",
    color=(255, 168, 72),
    hud_label="HARD",
    rank=2,
    lives=2,
    invuln_mult=0.65,
    speed_mult=1.15,
    turn_mult=0.95,
    self_mode="normal",
    self_skip_mult=0.75,
    self_depth_mult=_SELF_MODE_DEPTH["normal"],
    hazard_speed_mult=1.20,
    powerup_rate_mult=0.75,
    food_value_mult=0.95,
    score_mult=1.35,
    combo_window_mult=0.85,
    star_target_mult=1.15,
)

_EXPERT = Difficulty(
    key=C.DIFF_EXPERT,
    name="Expert",
    blurb="One life. No mercy. The grid remembers every mistake.",
    color=(255, 84, 132),
    hud_label="EXPERT",
    rank=3,
    lives=1,
    invuln_mult=0.25,
    speed_mult=1.30,
    turn_mult=0.90,
    self_mode="strict",
    self_skip_mult=0.50,
    self_depth_mult=_SELF_MODE_DEPTH["strict"],
    hazard_speed_mult=1.35,
    powerup_rate_mult=0.50,
    food_value_mult=0.90,
    score_mult=1.80,
    combo_window_mult=0.70,
    star_target_mult=1.30,
)

#: Every mode, keyed by the ``C.DIFF_*`` constant.
DIFFICULTIES: Dict[str, Difficulty] = {
    C.DIFF_EASY: _EASY,
    C.DIFF_NORMAL: _NORMAL,
    C.DIFF_HARD: _HARD,
    C.DIFF_EXPERT: _EXPERT,
}

#: Keys in easy -> expert order; the order menus should present them in.
ORDER: Tuple[str, ...] = (C.DIFF_EASY, C.DIFF_NORMAL, C.DIFF_HARD, C.DIFF_EXPERT)

#: The fallback row.  Anything unknown resolves to this.
DEFAULT: Difficulty = DIFFICULTIES.get(C.DEFAULT_DIFFICULTY, _NORMAL)


# ==========================================================================
# Lookup / cycling
# ==========================================================================
def get_difficulty(key: DiffLike = None) -> Difficulty:
    """
    Resolve `key` to a :class:`Difficulty`.

    Accepts a key string (case- and whitespace-insensitive), a
    :class:`Difficulty` instance (returned unchanged, so the helpers below can
    take either), or ``None``.  Anything unrecognised - a typo, a stale key
    from an older save, a number, an object - falls back to :data:`DEFAULT`.
    This function never raises.
    """
    if isinstance(key, Difficulty):
        return key
    try:
        if key is None:
            return DEFAULT
        k = str(key).strip().lower()
    except Exception:  # pragma: no cover - str() on a hostile object
        return DEFAULT
    return DIFFICULTIES.get(k, DEFAULT)


def is_difficulty_key(key: object) -> bool:
    """True when `key` names a real mode (used to validate save files)."""
    try:
        return str(key).strip().lower() in DIFFICULTIES
    except Exception:  # pragma: no cover - hostile object
        return False


def index_of(key: DiffLike = None) -> int:
    """Position of `key` within :data:`ORDER`, 0..3; unknown keys give NORMAL's."""
    diff = get_difficulty(key)
    try:
        return ORDER.index(diff.key)
    except ValueError:  # pragma: no cover - table and ORDER are kept in step
        return 0


def _step(key: DiffLike, delta: int) -> str:
    """Shared body of :func:`next_difficulty` / :func:`prev_difficulty`."""
    if not ORDER:  # pragma: no cover - defensive
        return C.DEFAULT_DIFFICULTY
    return ORDER[(index_of(key) + delta) % len(ORDER)]


def next_difficulty(key: DiffLike = None) -> str:
    """The next key one step harder, wrapping expert -> easy."""
    return _step(key, 1)


def prev_difficulty(key: DiffLike = None) -> str:
    """The previous key one step easier, wrapping easy -> expert."""
    return _step(key, -1)


def all_difficulties() -> List[Difficulty]:
    """Every mode as a fresh list, easy -> expert (safe for the caller to sort)."""
    return [DIFFICULTIES[k] for k in ORDER if k in DIFFICULTIES]


def labels() -> Tuple[str, ...]:
    """Upper-case display names in :data:`ORDER`, for a row of buttons."""
    return tuple(d.label for d in all_difficulties())


# ==========================================================================
# Self-collision
# ==========================================================================
def self_collision_enabled(diff: DiffLike = None) -> bool:
    """False only on EASY, where the snake simply cannot kill itself."""
    return get_difficulty(diff).self_mode != "off"


def self_collision_skip(diff: DiffLike = None) -> int:
    """
    Segments behind the head that are exempt from self-collision.

    :data:`~snake.config.SELF_COLLISION_SKIP` scaled by
    :attr:`Difficulty.self_skip_mult`, floored at 1 so there is always at least
    the neck to turn through.  When the mode is ``"off"`` this returns
    :data:`SKIP_NEVER` instead - larger than any body the game can grow, so a
    plain ``for i in range(skip, len(segments))`` loop simply never runs.
    """
    d = get_difficulty(diff)
    if d.self_mode == "off":
        return SKIP_NEVER
    try:
        base = float(C.SELF_COLLISION_SKIP)
        value = int(round(base * float(d.self_skip_mult)))
    except (TypeError, ValueError):  # pragma: no cover - config is sane
        return int(C.SELF_COLLISION_SKIP)
    return value if value >= 1 else 1


def self_collision_depth(diff: DiffLike = None) -> float:
    """
    Overlap allowance before a self-touch counts as a hit.

    :data:`~snake.config.SELF_COLLISION_DEPTH` scaled by the mode's
    :attr:`Difficulty.self_depth_mult` and clamped to the 0.05 .. 1.0 band
    :meth:`snake.core.snake.Snake.hits_self` accepts.  Lower is stricter (0.0
    would make a graze lethal), higher is more forgiving, matching both
    ``config`` and the entity.
    """
    d = get_difficulty(diff)
    try:
        value = float(C.SELF_COLLISION_DEPTH) * float(d.self_depth_mult)
    except (TypeError, ValueError):  # pragma: no cover - config is sane
        return float(C.SELF_COLLISION_DEPTH)
    return 0.05 if value < 0.05 else (1.0 if value > 1.0 else value)


# ==========================================================================
# Scoring / pacing helpers
# ==========================================================================
def lives_for(diff: DiffLike = None) -> int:
    """Lives a run on this mode starts with, never below 1."""
    d = get_difficulty(diff)
    try:
        n = int(d.lives)
    except (TypeError, ValueError):  # pragma: no cover - table is sane
        return int(C.START_LIVES)
    return n if n >= 1 else 1


def invuln_seconds(diff: DiffLike = None) -> float:
    """Mercy invulnerability after a non-fatal hit, in seconds."""
    d = get_difficulty(diff)
    try:
        v = float(C.INVULN_AFTER_HIT) * float(d.invuln_mult)
    except (TypeError, ValueError):  # pragma: no cover - table is sane
        return float(C.INVULN_AFTER_HIT)
    return v if v > 0.0 else 0.0


def combo_window(diff: DiffLike = None) -> float:
    """Seconds allowed between pickups to keep a combo alive."""
    d = get_difficulty(diff)
    try:
        v = float(C.COMBO_WINDOW) * float(d.combo_window_mult)
    except (TypeError, ValueError):  # pragma: no cover - table is sane
        return float(C.COMBO_WINDOW)
    return v if v > 0.1 else 0.1


def powerup_spawn_range(diff: DiffLike = None) -> Tuple[float, float]:
    """
    ``(min_seconds, max_seconds)`` between power-up spawns for this mode.

    :attr:`Difficulty.powerup_rate_mult` is a *rate*, so the config intervals
    are divided by it: EASY (1.45x) waits about a third less, EXPERT (0.5x)
    waits twice as long.  The pair is always ordered and strictly positive.
    """
    d = get_difficulty(diff)
    lo, hi = float(C.POWERUP_SPAWN_MIN), float(C.POWERUP_SPAWN_MAX)
    try:
        rate = float(d.powerup_rate_mult)
    except (TypeError, ValueError):  # pragma: no cover - table is sane
        rate = 1.0
    if rate <= 0.01:
        rate = 0.01
    lo, hi = lo / rate, hi / rate
    if hi < lo:
        lo, hi = hi, lo
    return (max(0.5, lo), max(0.5 + 1e-3, hi))


def score_for_food(diff: DiffLike, base_value: float,
                   *, multiplier: float = 1.0) -> int:
    """
    Points banked for one orb worth `base_value` on this mode.

    `multiplier` is whatever the scene already computed - the combo step and
    the ``double`` power-up - so the whole chain lands in one place::

        gained = score_for_food(game.difficulty, food.value,
                                multiplier=effects.score_multiplier() * combo)

    Always returns at least 1 for a positive orb, so no pickup ever feels free.
    """
    d = get_difficulty(diff)
    try:
        raw = (float(base_value) * float(d.food_value_mult)
               * float(d.score_mult) * float(multiplier))
    except (TypeError, ValueError):
        return 0
    if raw != raw or raw in (float("inf"), float("-inf")):  # NaN / inf guard
        return 0
    if raw <= 0.0:
        return 0
    points = int(round(raw))
    return points if points >= 1 else 1


def apply_star_targets(diff: DiffLike,
                       targets: Optional[Iterable[float]] = None
                       ) -> Tuple[int, int, int]:
    """
    Rescale a level's ``star_targets()`` triple for this mode.

    Takes whatever :meth:`snake.core.level.LevelDef.star_targets` returned and
    multiplies each threshold by :attr:`Difficulty.star_target_mult`, then
    forces the result to be three positive, strictly increasing integers so a
    two-star bar can never sit at or below the one-star bar after rounding.

    Garbage in - a short sequence, ``None``, non-numbers - yields a sane
    ``(1, 2, 3)``-style ladder rather than an exception.
    """
    d = get_difficulty(diff)
    try:
        mult = float(d.star_target_mult)
    except (TypeError, ValueError):  # pragma: no cover - table is sane
        mult = 1.0
    if mult <= 0.0:
        mult = 1.0

    values: List[float] = []
    if targets is not None:
        try:
            for v in targets:
                try:
                    fv = float(v)
                except (TypeError, ValueError):
                    continue
                if fv != fv:  # NaN
                    continue
                values.append(fv)
                if len(values) == 3:
                    break
        except TypeError:      # not iterable at all
            values = []

    # Pad a short or empty triple by extrapolating the shipped 1 / 1.35 / 1.75
    # ladder from whatever we did get.
    if not values:
        base = float(C.SCORE_PER_FOOD * 8)
        values = [base, base * 1.35, base * 1.75]
    while len(values) < 3:
        values.append(values[-1] * 1.35)

    out: List[int] = []
    for i, v in enumerate(values[:3]):
        scaled = int(round(v * mult))
        floor = 1 if i == 0 else out[-1] + 1
        out.append(scaled if scaled > floor else floor)
    return (out[0], out[1], out[2])


# ==========================================================================
# Import-time sanity (reports, never raises)
# ==========================================================================
def _assert_normal_is_identity() -> Sequence[str]:
    """
    Verify the table's invariants and return a list of complaints.

    Kept as a function so ``tools/`` can call it, and called once on import so
    a bad edit shows up immediately as a printed warning instead of a subtle
    balance drift.  It catches everything: a broken table must not stop the
    game from starting.
    """
    problems: List[str] = []
    try:
        if tuple(ORDER) != tuple(C.DIFFICULTIES):
            problems.append("ORDER does not match C.DIFFICULTIES")
        if set(DIFFICULTIES) != set(ORDER):
            problems.append("DIFFICULTIES keys do not match ORDER")
        for i, k in enumerate(ORDER):
            d = DIFFICULTIES[k]
            if d.key != k:
                problems.append("{}: key mismatch ({})".format(k, d.key))
            if d.rank != i:
                problems.append("{}: rank {} should be {}".format(k, d.rank, i))
            if d.self_mode not in SELF_MODES:
                problems.append("{}: bad self_mode {!r}".format(k, d.self_mode))
            if len(d.color) != 3 or not all(0 <= c <= 255 for c in d.color):
                problems.append("{}: bad colour {!r}".format(k, d.color))
        n = DIFFICULTIES[C.DIFF_NORMAL]
        identity = ("invuln_mult", "speed_mult", "turn_mult", "self_skip_mult",
                    "self_depth_mult", "hazard_speed_mult", "powerup_rate_mult",
                    "food_value_mult", "score_mult", "combo_window_mult",
                    "star_target_mult")
        for fname in identity:
            if abs(float(getattr(n, fname)) - 1.0) > 1e-9:
                problems.append("normal.{} is not 1.0".format(fname))
        if n.lives != C.START_LIVES:
            problems.append("normal.lives is not C.START_LIVES")
        # Difficulty must actually be monotonic where it claims to be.
        for a, b in zip(ORDER, ORDER[1:]):
            da, db = DIFFICULTIES[a], DIFFICULTIES[b]
            if db.lives > da.lives:
                problems.append("{} has more lives than {}".format(b, a))
            if db.speed_mult < da.speed_mult:
                problems.append("{} is slower than {}".format(b, a))
            if db.score_mult < da.score_mult:
                problems.append("{} scores less than {}".format(b, a))
    except Exception as exc:  # pragma: no cover - must never break an import
        problems.append("difficulty self-check crashed: {!r}".format(exc))
    return problems


_PROBLEMS = _assert_normal_is_identity()
if _PROBLEMS:  # pragma: no cover - only fires on a bad edit
    print("[difficulty] table invariants violated: " + "; ".join(_PROBLEMS))
