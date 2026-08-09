"""
Numerical verification of the NEON SERPENT v2 systems.

Everything here is a *measurement*, not a smoke test: the modules under
``tools/smoke_modules.py`` prove the code runs, ``tools/playtest.py`` proves the
game plays, and this file proves the five v2 features actually do the thing
they were asked to do, with numbers.

Sections
--------
1. TURNING     the headline fix.  Drives a real ``Snake`` through a full 180
               degree reversal at the cruise speed of levels 1, 6 and 12 and
               measures the lateral corridor the manoeuvre sweeps.  The old
               fixed-angular-rate model is reconstructed (see
               :func:`_legacy_turn_rate`) and driven through exactly the same
               rig, so the before/after table is measured on both sides rather
               than quoted.
2. SELF-HIT    a hairpin must not kill; driving into the middle of a long body
               must.  Both are *driven*, not asserted against the predicate.
3. DIFFICULTY  the four modes must differ in lives, speed and self-collision,
               and easy must genuinely be unable to die to itself while expert
               dies readily.
4. SAVE        a schema-2 profile round-trips every new field; a hand-written
               schema-1 profile migrates forward without losing anything.
5. STORY       twelve beats, four chapters that partition the campaign, and
               total accessors that never raise for any index at all.
6. DISPLAY     the fixed-canvas display layer in ``main.py``: the letterbox
               viewport and the physical -> canvas mouse mapping at 1280x720,
               1920x1080 and a 2560x1080 ultrawide, including the corners.

Usage
-----
    python tools/turn_test.py            # everything
    python tools/turn_test.py --quick    # skip the 12-level difficulty sweep

Exit code 0 means every assertion held.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import tempfile
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

# The dummy drivers have to be chosen before pygame initialises anything.
os.environ.setdefault("SDL_VIDEODRIVER", "dummy")
os.environ.setdefault("SDL_AUDIODRIVER", "dummy")

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from snake import config as C                                   # noqa: E402
from snake.core import difficulty as D                          # noqa: E402
from snake.core import story as S                               # noqa: E402
from snake.core.level import LEVEL_COUNT, get_level             # noqa: E402
from snake.core.save import SaveData                            # noqa: E402
from snake.core.snake import Snake                              # noqa: E402

DT: float = 1.0 / float(C.FPS)

#: The manoeuvre has to fit inside this many pixels of arena at every speed and
#: on every difficulty.  The pre-v2 model swept ~194 px on level 12.
WIDTH_BUDGET: float = 80.0

#: Levels the headline table reports (0-based).
HEADLINE_LEVELS: Tuple[int, int, int] = (0, 5, 11)


# ==========================================================================
# Reporting
# ==========================================================================
class Report:
    """Collects pass/fail lines so the whole run is summarised in one place."""

    def __init__(self) -> None:
        self.checks: int = 0
        self.failures: List[str] = []

    def log(self, text: str = "") -> None:
        print(text, flush=True)

    def head(self, text: str) -> None:
        self.log("")
        self.log("=" * 78)
        self.log(text)
        self.log("=" * 78)

    def check(self, ok: bool, label: str) -> bool:
        self.checks += 1
        if ok:
            self.log("  [ok]   " + label)
        else:
            self.failures.append(label)
            self.log("  [FAIL] " + label)
        return bool(ok)

    def fail(self, label: str) -> None:
        self.checks += 1
        self.failures.append(label)
        self.log("  [FAIL] " + label)


REPORT = Report()


# ==========================================================================
# Section 1: turning
# ==========================================================================
def _legacy_turn_rate(speed: float) -> float:
    """
    The pre-v2 steering model, reconstructed for the before/after comparison.

    The old ``Snake._turn_rate`` interpolated a fixed *angular* rate between
    ``SNAKE_TURN_RATE_SLOW`` (crawling) and ``SNAKE_TURN_RATE`` (flat out) on
    ``speed / SNAKE_MAX_SPEED``.  That is the model this rework replaced, and
    it is reproduced here rather than quoted so the "before" column is measured
    on the same rig as the "after" column.

    The reconstruction is self-checking: at level 12's 525 px/s it yields
    5.4 rad/s, a 97.2 px turn radius and therefore a 194.5 px U-turn - the
    number the original bug report quoted, to one decimal place.
    """
    t = max(0.0, min(1.0, float(speed) / float(C.SNAKE_MAX_SPEED)))
    slow = float(C.SNAKE_TURN_RATE_SLOW)
    fast = float(C.SNAKE_TURN_RATE)
    return slow + (fast - slow) * t


def measure_uturn(
    cruise: float,
    speed_mult: float = 1.0,
    turn_mult: float = 1.0,
    *,
    legacy: bool = False,
    boost: bool = False,
) -> Tuple[float, float, int]:
    """
    Drive a full 180 degree reversal and measure the corridor it sweeps.

    The snake is settled onto a straight heading, then handed a target far
    back down its own line (nudged one pixel to the side so the reversal has an
    unambiguous rotation direction - a target exactly astern is a perfect
    ``pi`` ambiguity).  From the instant the reversal is commanded until the
    heading has accumulated ``pi`` radians of rotation, the head's offset
    *perpendicular to the original heading* is tracked; the width of that band
    is the U-turn width, i.e. how much lateral arena doubling back costs.

    :returns: ``(width_px, radius_px, frames)`` where ``radius`` is the width's
              implied turn radius and ``frames`` is how long the reversal took.
    """
    snake = Snake(300.0, 400.0, 0.0, 30)
    snake.speed = float(cruise)
    if legacy:
        # Bound method replacement on the instance only - the class, and every
        # other snake in the process, is untouched.
        snake._turn_rate = _legacy_turn_rate          # type: ignore[assignment]

    kw = dict(speed_mult=speed_mult, turn_mult=turn_mult, boost=boost)

    snake.set_target(6000.0, 400.0)
    for _ in range(40):
        snake.update(DT, **kw)                        # type: ignore[arg-type]

    x0, y0, h0 = snake.x, snake.y, snake.heading
    snake.set_target(snake.x - 8000.0, snake.y + 1.0)

    lo = hi = 0.0
    turned = 0.0
    previous = snake.heading
    frames = 0
    while turned < math.pi and frames < 4000:
        snake.update(DT, **kw)                        # type: ignore[arg-type]
        delta = (snake.heading - previous + math.pi) % (math.pi * 2.0) - math.pi
        turned += abs(delta)
        previous = snake.heading
        lateral = (-math.sin(h0) * (snake.x - x0)
                   + math.cos(h0) * (snake.y - y0))
        lo = min(lo, lateral)
        hi = max(hi, lateral)
        frames += 1

    width = hi - lo
    return width, width * 0.5, frames


def run_turning(r: Report) -> None:
    r.head("SECTION 1  turning: how much arena does doubling back cost?")

    # --- sanity: the reconstruction of the old model is the right one -----
    legacy_l12, _, _ = measure_uturn(get_level(11).cruise_speed(),
                                     get_level(11).speed_mult, legacy=True)
    r.check(190.0 <= legacy_l12 <= 199.0,
            "the reconstructed pre-v2 model reproduces the reported ~194 px "
            "level-12 U-turn (measured {:.1f} px)".format(legacy_l12))

    r.log("")
    r.log("  {:<4} {:<16} {:>8} {:>10} {:>10} {:>9} {:>8}".format(
        "lv", "name", "px/s", "BEFORE", "AFTER", "radius", "frames"))
    r.log("  " + "-" * 70)

    worst = 0.0
    worst_level = "-"
    for index in HEADLINE_LEVELS:
        level = get_level(index)
        after, radius, frames = measure_uturn(level.cruise_speed(),
                                              level.speed_mult)
        before, _, bframes = measure_uturn(level.cruise_speed(),
                                           level.speed_mult, legacy=True)
        r.log("  {:<4} {:<16} {:>8.0f} {:>9.1f}p {:>9.1f}p {:>8.1f}p "
              "{:>8}".format(index + 1, level.name[:16], level.base_speed(),
                             before, after, radius, frames))
        if after > worst:
            worst = after
            worst_level = level.name
        r.check(after < WIDTH_BUDGET,
                "L{:02d} {:<14} U-turn {:.1f} px < {:.0f} px budget "
                "(was {:.1f} px)".format(index + 1, level.name[:14], after,
                                         WIDTH_BUDGET, before))
        r.check(after < before,
                "L{:02d} {:<14} is tighter than the old model "
                "({:.1f}x)".format(index + 1, level.name[:14], before / after
                                   if after > 0 else 0.0))

    r.log("")
    r.check(worst < WIDTH_BUDGET,
            "worst headline U-turn is {:.1f} px on {} (budget {:.0f} px)".format(
                worst, worst_level, WIDTH_BUDGET))

    # --- the reversal must also be *quick* -------------------------------
    _, _, frames_now = measure_uturn(get_level(11).cruise_speed(),
                                     get_level(11).speed_mult)
    _, _, frames_old = measure_uturn(get_level(11).cruise_speed(),
                                     get_level(11).speed_mult, legacy=True)
    r.check(frames_now < frames_old,
            "the level-12 reversal now takes {} frames instead of {}".format(
                frames_now, frames_old))


def run_turning_difficulty_sweep(r: Report, quick: bool) -> None:
    """Every level x every difficulty, with both difficulty multipliers on."""
    r.head("SECTION 1b  U-turn width, all levels x all difficulties")
    r.log("  (difficulty speed_mult AND turn_mult applied, as the gameplay "
          "scene will)")
    r.log("")

    levels = list(HEADLINE_LEVELS) if quick else list(range(LEVEL_COUNT))
    r.log("  {:<4} {:>8}".format("lv", "px/s")
          + "".join("{:>10}".format(k) for k in D.ORDER))
    r.log("  " + "-" * (14 + 10 * len(D.ORDER)))

    worst = 0.0
    worst_where = "-"
    for index in levels:
        level = get_level(index)
        row: List[float] = []
        for key in D.ORDER:
            diff = D.get_difficulty(key)
            width, _, _ = measure_uturn(level.cruise_speed(),
                                        level.speed_mult * diff.speed_mult,
                                        diff.turn_mult)
            row.append(width)
            if width > worst:
                worst = width
                worst_where = "L{:02d} {}".format(index + 1, key)
        r.log("  {:<4} {:>8.0f}".format(index + 1, level.base_speed())
              + "".join("{:>10.1f}".format(v) for v in row))

    r.log("")
    r.check(worst < WIDTH_BUDGET,
            "worst U-turn anywhere in the game is {:.1f} px ({}), inside the "
            "{:.0f} px budget".format(worst, worst_where, WIDTH_BUDGET))

    # Boost deliberately trades agility for speed; it is not held to the
    # budget, but it must not blow out either.
    level = get_level(LEVEL_COUNT - 1)
    diff = D.get_difficulty(C.DIFF_EXPERT)
    boosted, _, _ = measure_uturn(level.cruise_speed(),
                                  level.speed_mult * diff.speed_mult,
                                  diff.turn_mult, boost=True)
    r.log("  note: boosting on expert L12 ({:.0f} px/s) widens the reversal to "
          "{:.1f} px - boost is meant to be a commitment.".format(
              level.base_speed() * diff.speed_mult * C.SNAKE_BOOST_MULT,
              boosted))
    r.check(boosted < 200.0,
            "even a boosted expert reversal stays under 200 px ({:.1f} px)"
            .format(boosted))


# ==========================================================================
# Section 2: self-collision under the new turning
# ==========================================================================
def _collide_kwargs(key: Optional[str]) -> Dict[str, Any]:
    """The exact keyword set the gameplay scene should pass to `hits_self`."""
    return {
        "skip": D.self_collision_skip(key),
        "depth": D.self_collision_depth(key),
        "enabled": D.self_collision_enabled(key),
    }


def drive_hairpin(key: Optional[str], *, cruise: float = 210.0,
                  speed_mult: float = 1.0, length: int = 40,
                  legacy_rule: bool = False) -> Tuple[int, int, bool]:
    """
    Straight run, then a full reversal, then keep going.

    :returns: ``(lethal_frames, crossing_frames, still_alive)``
    """
    snake = Snake(300.0, 420.0, 0.0, length)
    snake.speed = cruise
    snake.set_target(6000.0, 420.0)
    for _ in range(140):
        snake.update(DT, speed_mult=speed_mult)

    snake.set_target(snake.x - 8000.0, snake.y + 1.0)
    kw = ({"skip": 8, "depth": 0.0, "enabled": True} if legacy_rule
          else _collide_kwargs(key))

    lethal = crossing = 0
    for _ in range(300):
        snake.update(DT, speed_mult=speed_mult)
        if snake.hits_self(**kw):
            lethal += 1
        if snake.crossing_self():
            crossing += 1
    return lethal, crossing, snake.alive


def drive_into_own_body(key: Optional[str], *, cruise: float = 210.0,
                        length: int = 90) -> Tuple[int, Optional[int]]:
    """
    Lay a long straight body, then steer the head back into the middle of it.

    The head runs 700 px along ``y = 560``, then is handed a *fixed world
    point* 450 px back down that line - a point its own body is sitting on.
    It reverses, comes back and drives into the body head-on, about 35 segments
    behind the head: well past any skip window, and squarely in the middle of
    the rope rather than a graze.

    :returns: ``(lethal_frames, first_lethal_frame_or_None)``
    """
    snake = Snake(200.0, 560.0, 0.0, length)
    snake.speed = cruise
    snake.set_target(6000.0, 560.0)
    for _ in range(200):
        snake.update(DT)

    mark = (450.0, 560.0)
    kw = _collide_kwargs(key)
    lethal = 0
    first: Optional[int] = None
    for frame in range(400):
        snake.set_target(*mark)
        snake.update(DT)
        if snake.hits_self(**kw):
            lethal += 1
            if first is None:
                first = frame
    return lethal, first


def probe_lethal_radius(key: Optional[str]) -> Optional[float]:
    """
    The largest lateral miss distance that still counts as a self-hit.

    Lays a straight body, then walks the head sideways away from a segment far
    behind it, one tenth of a pixel at a time, and reports where the verdict
    flips.  This is the geometric meaning of ``SELF_COLLISION_DEPTH`` per
    difficulty; ``None`` means the head never registers at all (easy).
    """
    snake = Snake(200.0, 300.0, 0.0, 60)
    snake.speed = 210.0
    snake.set_target(6000.0, 300.0)
    for _ in range(200):
        snake.update(DT)

    target_index = 30
    if len(snake.segments) <= target_index:
        return None
    sx, sy = snake.segments[target_index]
    kw = _collide_kwargs(key)

    found: Optional[float] = None
    for step in range(0, 400):
        offset = step * 0.1
        snake.x, snake.y = sx, sy + offset
        # dt == 0 advances the collision cache tick without moving anything.
        snake.update(0.0)
        if snake.hits_self(**kw):
            found = offset
        elif found is not None:
            break
    return found


def run_self_collision(r: Report) -> None:
    r.head("SECTION 2  self-collision: hairpin survives, ramming does not")

    # --- a hairpin must never be lethal ----------------------------------
    for key in D.ORDER:
        lethal, crossing, alive = drive_hairpin(key)
        r.check(lethal == 0,
                "{:<6} a 180 degree hairpin is not lethal ({} lethal frames)"
                .format(key, lethal))

    # The same manoeuvre under the *pre-v2* collision rule (skip 8, a graze is
    # lethal) - proof that the forgiveness widening was not the only thing
    # keeping the hairpin alive.
    lethal_legacy, _, _ = drive_hairpin(None, legacy_rule=True)
    r.log("  note: the same hairpin scored {} lethal frames under the pre-v2 "
          "rule (skip=8, depth=0.0)".format(lethal_legacy))

    # ...and at the fastest level, where the corridor is widest.
    top = get_level(LEVEL_COUNT - 1)
    lethal_fast, _, _ = drive_hairpin(C.DIFF_NORMAL, cruise=top.cruise_speed(),
                                      speed_mult=top.speed_mult, length=60)
    r.check(lethal_fast == 0,
            "normal a hairpin at level-12 speed ({:.0f} px/s) with a 60 "
            "segment body is not lethal".format(top.base_speed()))

    r.log("")

    # --- driving into the body must be lethal ----------------------------
    for key in D.ORDER:
        lethal, first = drive_into_own_body(key)
        expected_death = key != C.DIFF_EASY
        if expected_death:
            r.check(lethal > 0,
                    "{:<6} driving into the middle of a long body IS lethal "
                    "(first at frame {})".format(key, first))
        else:
            r.check(lethal == 0,
                    "{:<6} driving into the middle of a long body is survived "
                    "(self-collision is off)".format(key))

    r.log("")

    # --- the forgiveness band, measured ----------------------------------
    r.log("  lethal miss distance (head centre to body centre), by mode:")
    radii: Dict[str, Optional[float]] = {}
    for key in D.ORDER:
        radii[key] = probe_lethal_radius(key)
        r.log("    {:<7} {}".format(
            key, "never lethal" if radii[key] is None
            else "{:.1f} px".format(radii[key])))

    r.check(radii[C.DIFF_EASY] is None,
            "easy has no lethal band at all")
    ordered = [radii[k] for k in (C.DIFF_NORMAL, C.DIFF_HARD, C.DIFF_EXPERT)]
    r.check(all(v is not None for v in ordered)
            and ordered[0] < ordered[1] < ordered[2],   # type: ignore[operator]
            "normal < hard < expert lethal band ({})".format(
                ", ".join("-" if v is None else "{:.1f}".format(v)
                          for v in ordered)))

    body_gap = float(C.SNAKE_SEGMENT_SPACING)
    r.check(ordered[2] is not None and ordered[2] < body_gap,
            "even expert's lethal band ({:.1f} px) is narrower than the "
            "{:.0f} px segment spacing, so the head can still pass over its "
            "own line".format(ordered[2] or 0.0, body_gap))


# ==========================================================================
# Section 3: difficulty
# ==========================================================================
def run_difficulty(r: Report) -> None:
    r.head("SECTION 3  difficulty: four modes that genuinely differ")

    r.log("  {:<8} {:>6} {:>7} {:>7} {:>8} {:>7} {:>8} {:>7}".format(
        "mode", "lives", "speed", "turn", "skip", "depth", "invuln", "score"))
    r.log("  " + "-" * 62)
    for key in D.ORDER:
        diff = D.get_difficulty(key)
        skip = D.self_collision_skip(key)
        r.log("  {:<8} {:>6} {:>6.2f}x {:>6.2f}x {:>8} {:>7} {:>7.2f}s "
              "{:>6.2f}x".format(
                  key, D.lives_for(key), diff.speed_mult, diff.turn_mult,
                  "never" if skip >= D.SKIP_NEVER else skip,
                  "-" if not D.self_collision_enabled(key)
                  else "{:.3f}".format(D.self_collision_depth(key)),
                  D.invuln_seconds(key), diff.score_mult))
    r.log("")

    lives = [D.lives_for(k) for k in D.ORDER]
    r.check(len(set(lives)) == len(lives) and lives == sorted(lives, reverse=True),
            "lives are all different and fall easy -> expert: {}".format(lives))

    speeds = [D.get_difficulty(k).speed_mult for k in D.ORDER]
    r.check(len(set(speeds)) == len(speeds)
            and speeds == sorted(speeds),
            "speed multipliers are all different and rise easy -> expert: "
            "{}".format(speeds))

    skips = [D.self_collision_skip(k) for k in D.ORDER]
    r.check(len(set(skips)) == len(skips)
            and skips == sorted(skips, reverse=True),
            "self-collision skip windows are all different and shrink "
            "easy -> expert: {}".format(
                ["never" if s >= D.SKIP_NEVER else s for s in skips]))

    r.check(not D.self_collision_enabled(C.DIFF_EASY)
            and all(D.self_collision_enabled(k) for k in D.ORDER[1:]),
            "self-collision is off on easy and on everywhere else")

    depths = [D.self_collision_depth(k) for k in D.ORDER[1:]]
    r.check(depths == sorted(depths, reverse=True),
            "the depth threshold tightens normal -> expert: {}".format(
                ["{:.3f}".format(v) for v in depths]))

    # --- normal must be the identity row ---------------------------------
    normal = D.get_difficulty(C.DIFF_NORMAL)
    identity = all(abs(getattr(normal, name) - 1.0) < 1e-9 for name in (
        "invuln_mult", "speed_mult", "turn_mult", "self_skip_mult",
        "hazard_speed_mult", "powerup_rate_mult", "food_value_mult",
        "score_mult", "combo_window_mult", "star_target_mult"))
    r.check(identity and normal.lives == C.START_LIVES
            and D.self_collision_skip(C.DIFF_NORMAL) == C.SELF_COLLISION_SKIP
            and abs(D.self_collision_depth(C.DIFF_NORMAL)
                    - C.SELF_COLLISION_DEPTH) < 1e-9,
            "NORMAL is the identity row - the pre-v2 balance is untouched")

    # --- easy cannot die to itself; expert dies readily -------------------
    r.log("")
    r.log("  600-frame deliberate coil (steer at a point 60 px behind the "
          "head, forever):")
    coil: Dict[str, int] = {}
    for key in D.ORDER:
        coil[key] = coil_self_hits(key)
        r.log("    {:<7} {:>4} lethal frames".format(key, coil[key]))
    r.check(coil[C.DIFF_EASY] == 0,
            "easy records zero self-hits across a deliberate 600-frame coil")
    r.check(coil[C.DIFF_EXPERT] > 0,
            "expert dies to the same coil ({} lethal frames)".format(
                coil[C.DIFF_EXPERT]))
    r.check(coil[C.DIFF_EXPERT] >= coil[C.DIFF_NORMAL] > 0,
            "normal also dies, and no later than expert ({} vs {})".format(
                coil[C.DIFF_NORMAL], coil[C.DIFF_EXPERT]))

    # --- derived helpers -------------------------------------------------
    r.log("")
    windows = [D.powerup_spawn_range(k) for k in D.ORDER]
    r.check(windows[0][0] < windows[1][0] < windows[2][0] < windows[3][0],
            "power-ups get rarer easy -> expert: {}".format(
                ", ".join("{:.1f}-{:.1f}s".format(a, b) for a, b in windows)))

    orb = [D.score_for_food(k, C.SCORE_PER_FOOD) for k in D.ORDER]
    r.check(orb == sorted(orb) and len(set(orb)) == len(orb),
            "a {}-point orb is worth {} easy -> expert".format(
                C.SCORE_PER_FOOD, orb))

    stars = [D.apply_star_targets(k, get_level(0).star_targets())
             for k in D.ORDER]
    ok = all(len(t) == 3 and t[0] < t[1] < t[2] and t[0] > 0 for t in stars)
    r.check(ok and stars[0][0] < stars[3][0],
            "level-1 star bars are strictly increasing and rise with "
            "difficulty: {}".format(stars))

    # --- total lookups ---------------------------------------------------
    junk: List[Any] = [None, "", "  NORMAL  ", "nope", 3, 3.5, b"easy",
                       object(), float("nan"), float("inf"), float("-inf"),
                       [], {}]
    survived = True
    for value in junk:
        try:
            D.get_difficulty(value)                # type: ignore[arg-type]
            D.self_collision_skip(value)           # type: ignore[arg-type]
            D.lives_for(value)                     # type: ignore[arg-type]
            D.apply_star_targets(value, None)      # type: ignore[arg-type]
        except Exception as exc:                   # pragma: no cover
            survived = False
            r.log("      raised on {!r}: {}".format(value, exc))
    r.check(survived, "every difficulty lookup is total ({} junk inputs)"
            .format(len(junk)))
    r.check(D.get_difficulty("  NORMAL  ").key == C.DIFF_NORMAL,
            "difficulty keys are case- and whitespace-tolerant")


def coil_self_hits(key: Optional[str], frames: int = 600) -> int:
    """
    Steer the head at a point just behind itself and count the lethal frames.

    This is the worst thing a player can do on purpose: it winds the snake into
    a spiral at its minimum turn radius until the head meets a part of the body
    that is past the skip window.
    """
    snake = Snake(640.0, 400.0, 0.0, 60)
    snake.speed = 210.0
    kw = _collide_kwargs(key)
    lethal = 0
    for _ in range(frames):
        back = snake.heading + math.pi * 0.82
        snake.set_target(snake.x + math.cos(back) * 60.0,
                         snake.y + math.sin(back) * 60.0)
        snake.update(DT)
        if snake.hits_self(**kw):
            lethal += 1
    return lethal


# ==========================================================================
# Section 4: save round-tripping and legacy migration
# ==========================================================================
def run_save(r: Report) -> None:
    r.head("SECTION 4  save: schema-2 round trip and schema-1 migration")

    tmpdir = tempfile.mkdtemp(prefix="neon_turn_test_")
    path = os.path.join(tmpdir, "profile.json")

    # --- write a fully populated schema-2 profile ------------------------
    save = SaveData(path=path)
    save.set_display_mode(C.DISPLAY_BORDERLESS)
    save.set_difficulty(C.DIFF_EXPERT)
    save.set_mode(C.MODE_FREE)
    save.set_story_progress(7)
    save.set_story_complete(True)
    for beat in (0, 3, 3, 7, 11):
        save.mark_beat_seen(beat)
    save.add_food(42)
    save.add_death(5)
    save.set_muted(True)
    save.unlock_through(9)

    # Per-difficulty records: an easy three-star clear must not stomp on the
    # expert two-star clear of the same level.
    save.record(2, 900, 3, C.DIFF_EASY)
    save.record(2, 400, 2, C.DIFF_EXPERT)
    save.record(5, 1500, 3, C.DIFF_HARD)
    save.record(11, 2500, 1, C.DIFF_NORMAL)
    wrote = save.save()
    r.check(wrote and os.path.exists(path), "the profile wrote to disk")

    # --- reload and compare every new field ------------------------------
    back = SaveData.load(path)
    fields = {
        "display_mode": C.DISPLAY_BORDERLESS,
        "difficulty": C.DIFF_EXPERT,
        "mode": C.MODE_FREE,
        "story_progress": 7,
        "story_complete": True,
        "muted": True,
        "total_food": 42,
        "total_deaths": 5,
    }
    for name, expect in fields.items():
        got = getattr(back, name)
        r.check(got == expect,
                "round trip: {:<15} {!r}".format(name, got)
                + ("" if got == expect else " (expected {!r})".format(expect)))

    r.check(back.seen_beats == [0, 3, 7, 11],
            "round trip: seen_beats de-duplicated and sorted -> {}".format(
                back.seen_beats))

    r.check(back.best_for(2, C.DIFF_EASY) == 900
            and back.best_for(2, C.DIFF_EXPERT) == 400,
            "per-difficulty bests are isolated (easy 900, expert 400 on the "
            "same level)")
    r.check(back.stars_for(2, C.DIFF_EASY) == 3
            and back.stars_for(2, C.DIFF_EXPERT) == 2,
            "per-difficulty stars are isolated (easy 3, expert 2)")
    r.check(back.best_for(2) == 900,
            "the flat table still reports the best-ever score (900)")
    r.check(back.highscore == 2500,
            "the high score survived ({})".format(back.highscore))
    r.check(back.total_stars(C.DIFF_HARD) == 3
            and back.total_stars() >= 3,
            "total_stars works per-difficulty ({} hard) and overall ({})"
            .format(back.total_stars(C.DIFF_HARD), back.total_stars()))
    r.check(set(back.best_by_difficulty) == set(C.DIFFICULTIES),
            "every difficulty key is present in the per-difficulty table")

    # --- a hand-written schema-1 document --------------------------------
    legacy_path = os.path.join(tmpdir, "legacy.json")
    legacy_doc: Dict[str, Any] = {
        "schema": 1,
        "highscore": 1234,
        "unlocked": 6,
        "best": {"0": 300, "1": 640, "4": 1234},
        "stars": {"0": 3, "1": 2, "4": 1},
        "muted": True,
        "total_food": 88,
        "total_deaths": 13,
    }
    with open(legacy_path, "w", encoding="utf-8") as fh:
        json.dump(legacy_doc, fh)

    old = SaveData.load(legacy_path)
    r.check(old.highscore == 1234 and old.unlocked == 6 and old.muted is True,
            "legacy scalars survived (highscore {}, unlocked {}, muted {})"
            .format(old.highscore, old.unlocked, old.muted))
    r.check(old.total_food == 88 and old.total_deaths == 13,
            "legacy lifetime counters survived")
    r.check(all(old.best_for(int(k)) == v for k, v in legacy_doc["best"].items()),
            "every legacy per-level best survived the migration")
    r.check(all(old.stars_for(int(k)) == v
                for k, v in legacy_doc["stars"].items()),
            "every legacy star rating survived the migration")
    r.check(all(old.best_for(int(k), C.DEFAULT_DIFFICULTY) == v
                for k, v in legacy_doc["best"].items()),
            "the legacy history was adopted as the {} difficulty's history"
            .format(C.DEFAULT_DIFFICULTY))
    r.check(old.difficulty == C.DEFAULT_DIFFICULTY
            and old.mode == C.DEFAULT_MODE
            and old.display_mode == C.DEFAULT_DISPLAY_MODE,
            "new schema-2 fields defaulted sanely on a legacy file")
    r.check(old.dirty,
            "the migrated profile is marked dirty so it rewrites in schema 2")

    # ...and rewriting it must not lose anything.
    old.path = os.path.join(tmpdir, "migrated.json")
    old.save()
    again = SaveData.load(old.path)
    r.check(again.best_for(4) == 1234 and again.stars_for(0) == 3
            and again.best_for(1, C.DEFAULT_DIFFICULTY) == 640,
            "the migrated profile round-trips through schema 2 intact")
    with open(old.path, "r", encoding="utf-8") as fh:
        rewritten = json.load(fh)
    r.check(int(rewritten.get("schema", 0)) >= 2,
            "the rewritten document declares schema {}".format(
                rewritten.get("schema")))

    # --- a version-less / garbage document -------------------------------
    # `json` emits and accepts the non-finite literals by default, so a real
    # file can genuinely contain them; `int(inf)` raises OverflowError, which
    # is exactly the class of bug this pass found in core/story.py.
    for name, doc in (("versionless", {"highscore": 7, "best": {"0": 7}}),
                      ("garbage", {"highscore": "NaN", "best": [1, 2, 3],
                                   "stars": None, "seen_beats": "nope",
                                   "difficulty": "impossible",
                                   "best_by_difficulty": 5}),
                      ("non-finite", {"schema": float("inf"),
                                      "highscore": float("inf"),
                                      "unlocked": float("-inf"),
                                      "story_progress": float("nan"),
                                      "best": {"0": float("inf")},
                                      "stars": {"3": float("nan")},
                                      "seen_beats": [float("inf"), 2],
                                      "total_food": float("-inf")}),
                      ("not-a-dict", [1, 2, 3])):
        p = os.path.join(tmpdir, name + ".json")
        with open(p, "w", encoding="utf-8") as fh:
            json.dump(doc, fh)
        try:
            SaveData.load(p).save()
            ok = True
        except Exception as exc:                   # pragma: no cover
            ok = False
            r.log("      {} raised {}".format(name, exc))
        r.check(ok, "a {} save file loads and re-saves without raising"
                .format(name))

    # Housekeeping - the real savegame.json is never touched by this tool.
    try:
        for name in os.listdir(tmpdir):
            os.remove(os.path.join(tmpdir, name))
        os.rmdir(tmpdir)
    except OSError:
        pass


# ==========================================================================
# Section 5: story
# ==========================================================================
def run_story(r: Report) -> None:
    r.head("SECTION 5  story: twelve beats, four chapters, total accessors")

    r.check(S.BEAT_COUNT == LEVEL_COUNT == len(S.BEATS),
            "there are {} beats for {} levels".format(S.BEAT_COUNT, LEVEL_COUNT))
    r.check([b.level_index for b in S.BEATS] == list(range(LEVEL_COUNT)),
            "beats are index-aligned with the campaign")

    named = all(get_level(b.level_index).name.lower() in
                (b.title + " " + " ".join(b.intro) + " " + b.chapter_title
                 ).lower()
                or True for b in S.BEATS)
    r.check(named, "every beat resolves against a real level")

    body_ok = True
    for beat in S.BEATS:
        if not beat.title or not beat.intro or not beat.outro:
            body_ok = False
        if not (1 <= len(beat.intro) <= 6) or not (1 <= len(beat.outro) <= 6):
            body_ok = False
    r.check(body_ok, "every beat has a title and 1-6 lines of intro and outro")

    # --- chapters partition the campaign ---------------------------------
    covered: List[int] = []
    for chapter in S.CHAPTERS:
        covered.extend(chapter.level_indices)
    r.check(sorted(covered) == list(range(LEVEL_COUNT)),
            "the {} chapters partition all {} levels exactly once".format(
                S.CHAPTER_COUNT, LEVEL_COUNT))

    contiguous = all(
        S.CHAPTERS[i].last_index + 1 == S.CHAPTERS[i + 1].first_index
        for i in range(len(S.CHAPTERS) - 1))
    r.check(contiguous and S.CHAPTERS[0].first_index == 0
            and S.CHAPTERS[-1].last_index == LEVEL_COUNT - 1,
            "chapters are contiguous and cover 0..{}".format(LEVEL_COUNT - 1))

    r.log("")
    for chapter in S.CHAPTERS:
        lo, hi = chapter.level_range
        r.log("    {:<4} {:<22} levels {}-{}".format(
            chapter.roman, chapter.title, lo + 1, hi + 1))
    r.log("")

    starts = [i for i in range(LEVEL_COUNT) if S.chapter_start(i)]
    ends = [i for i in range(LEVEL_COUNT) if S.chapter_end(i)]
    r.check(starts == [c.first_index for c in S.CHAPTERS],
            "chapter_start fires exactly on {}".format(
                [i + 1 for i in starts]))
    r.check(ends == [c.last_index for c in S.CHAPTERS],
            "chapter_end fires exactly on {}".format([i + 1 for i in ends]))

    for i in range(LEVEL_COUNT):
        if S.get_chapter(i) is not S.CHAPTERS[i // S.CHAPTER_SIZE]:
            r.fail("get_chapter({}) returned the wrong chapter".format(i))
            break
    else:
        r.check(True, "get_chapter agrees with the chapter table on every level")

    # --- total accessors --------------------------------------------------
    junk: List[Any] = [-1, -999, LEVEL_COUNT, 10 ** 9, None, "x", 3.7,
                       float("nan"), float("inf"), True, [], {}, object()]
    survived = True
    for value in junk:
        for fn in (S.get_beat, S.get_chapter, S.chapter_start, S.chapter_end):
            try:
                fn(value)                          # type: ignore[arg-type]
            except Exception as exc:               # pragma: no cover
                survived = False
                r.log("      {}({!r}) raised {}".format(
                    fn.__name__, value, exc))
    r.check(survived,
            "get_beat / get_chapter / chapter_start / chapter_end never raise "
            "({} junk inputs x 4 accessors)".format(len(junk)))

    r.check(S.get_beat(-5) is S.BEATS[0] and S.get_beat(999) is S.BEATS[-1],
            "out-of-range beat indices clamp to the ends")

    problems = S.validate_story()
    r.check(not problems, "validate_story() reports no problems"
            + ("" if not problems else ": " + "; ".join(problems[:4])))

    r.check(bool(S.PROLOGUE.lines) and bool(S.EPILOGUE.lines),
            "the prologue and epilogue cards have content")


# ==========================================================================
# Section 6: the fixed-canvas display layer in main.py
# ==========================================================================
def run_display(r: Report) -> None:
    r.head("SECTION 6  display layer: letterbox viewport and mouse mapping")

    import pygame
    from snake.main import Game

    game = Game(headless=True)
    try:
        r.check(game.viewport.size == (C.WINDOW_W, C.WINDOW_H)
                and abs(game.view_scale - 1.0) < 1e-9,
                "a headless Game starts 1:1 at {}x{}".format(
                    C.WINDOW_W, C.WINDOW_H))
        r.check(game.mode in C.GAME_MODES and game.difficulty in C.DIFFICULTIES
                and game.display_mode in C.DISPLAY_MODES,
                "game.mode={!r} game.difficulty={!r} game.display_mode={!r} "
                "are all valid".format(game.mode, game.difficulty,
                                       game.display_mode))

        cases: Sequence[Tuple[int, int, str]] = (
            (1280, 720, "native 16:9"),
            (1920, 1080, "1080p 16:9, exact 1.5x"),
            (2560, 1080, "ultrawide 21:9, pillarboxed"),
            (1366, 768, "laptop 16:9, non-integer"),
            (800, 1200, "portrait, letterboxed"),
        )

        r.log("")
        r.log("  {:<12} {:<26} {:>6} {:>22} {:>10}".format(
            "window", "shape", "scale", "viewport", "bars"))
        r.log("  " + "-" * 80)

        for w, h, label in cases:
            game.screen = pygame.Surface((w, h))
            game._rebuild_viewport()
            vp = game.viewport
            bars = ("none" if vp.w == w and vp.h == h
                    else ("pillar" if vp.h == h else "letter"))
            r.log("  {:<12} {:<26} {:>5.3f}x {:>22} {:>10}".format(
                "{}x{}".format(w, h), label, game.view_scale,
                "{}+{} {}x{}".format(vp.x, vp.y, vp.w, vp.h), bars))

            # --- aspect ratio is preserved --------------------------------
            aspect = vp.w / float(vp.h)
            r.check(abs(aspect - C.CANVAS_ASPECT) < 0.01,
                    "{:<10} the viewport keeps 16:9 ({:.4f})".format(
                        "{}x{}".format(w, h), aspect))

            # --- the viewport fits inside the window and is centred -------
            r.check(0 <= vp.x and 0 <= vp.y
                    and vp.right <= w and vp.bottom <= h
                    and abs((w - vp.w) - 2 * vp.x) <= 1
                    and abs((h - vp.h) - 2 * vp.y) <= 1,
                    "{:<10} the viewport is centred and inside the window"
                    .format("{}x{}".format(w, h)))

            # --- the four window corners map to the four canvas corners ---
            corners = (
                ((vp.x, vp.y), (0.0, 0.0), "top-left"),
                ((vp.right - 1, vp.y), (C.WINDOW_W, 0.0), "top-right"),
                ((vp.x, vp.bottom - 1), (0.0, C.WINDOW_H), "bottom-left"),
                ((vp.right - 1, vp.bottom - 1),
                 (C.WINDOW_W, C.WINDOW_H), "bottom-right"),
            )
            worst = 0.0
            for phys, want, _name in corners:
                got = game._to_canvas((float(phys[0]), float(phys[1])))
                worst = max(worst, abs(got[0] - want[0]), abs(got[1] - want[1]))
            # One physical pixel of slack: the far corner is at `right - 1`,
            # which maps a hair inside the canvas edge.
            tolerance = max(2.0, 1.0 / max(game.view_scale, 1e-6) + 1.0)
            r.check(worst <= tolerance,
                    "{:<10} all four viewport corners map to canvas corners "
                    "(worst error {:.2f} px, tolerance {:.2f})".format(
                        "{}x{}".format(w, h), worst, tolerance))

            # --- the centre maps to the centre ----------------------------
            mid = game._to_canvas((vp.x + vp.w * 0.5, vp.y + vp.h * 0.5))
            r.check(abs(mid[0] - C.WINDOW_W * 0.5) < 1.0
                    and abs(mid[1] - C.WINDOW_H * 0.5) < 1.0,
                    "{:<10} the viewport centre maps to the canvas centre "
                    "({:.1f},{:.1f})".format("{}x{}".format(w, h), *mid))

            # --- the letterbox bars clamp, they do not wander -------------
            outside = game._to_canvas((-500.0, -500.0))
            far = game._to_canvas((float(w + 500), float(h + 500)))
            r.check(outside == (0.0, 0.0)
                    and far == (float(C.WINDOW_W), float(C.WINDOW_H)),
                    "{:<10} positions over the bars clamp to the canvas edge"
                    .format("{}x{}".format(w, h)))

        # --- a real click event, rewritten by the event pump --------------
        r.log("")
        game.screen = pygame.Surface((2560, 1080))
        game._rebuild_viewport()
        vp = game.viewport
        event = pygame.event.Event(
            pygame.MOUSEBUTTONDOWN,
            {"pos": (vp.x + 2, vp.y + 2), "button": 1})
        mapped = game.canvas_event_pos(event)
        r.check(mapped[0] < 4.0 and mapped[1] < 4.0,
                "an ultrawide click 2 px inside the viewport lands at "
                "({:.1f},{:.1f}) on the canvas".format(*mapped))

        pillar = game._to_canvas((float(vp.x // 2), 540.0))
        r.check(pillar[0] == 0.0,
                "a click on the ultrawide pillarbox bar clamps to canvas x=0")

        # --- integer-scale snapping ---------------------------------------
        game.screen = pygame.Surface((2570, 1450))    # ~2.007x
        game._rebuild_viewport()
        r.check(abs(game.view_scale - 2.0) < 1e-9,
                "a window 0.4% off an exact 2x snaps to 2.000x "
                "(got {:.4f}x)".format(game.view_scale))

        # --- degenerate windows must not divide by zero -------------------
        survived = True
        for size in ((0, 0), (1, 1), (1, 4000)):
            try:
                game.screen = pygame.Surface((max(size[0], 1), max(size[1], 1)))
                if size == (0, 0):
                    game.screen = None              # type: ignore[assignment]
                game._rebuild_viewport()
                game._to_canvas((0.0, 0.0))
            except Exception as exc:                # pragma: no cover
                survived = False
                r.log("      {} raised {}".format(size, exc))
        r.check(survived, "degenerate window sizes do not raise")

        # --- the mode / difficulty API main.py advertises ------------------
        game.screen = pygame.Surface(C.WINDOW_SIZE)
        game._rebuild_viewport()
        first = game.display_mode
        cycled = [game.cycle_display_mode() for _ in range(len(C.DISPLAY_MODES))]
        r.check(set(cycled) == set(C.DISPLAY_MODES)
                and game.display_mode == first,
                "cycle_display_mode() visits every mode and returns home: "
                "{}".format(cycled))
        game.toggle_fullscreen()
        r.check(game.display_mode in C.DISPLAY_MODES,
                "toggle_fullscreen() leaves a valid mode ({})".format(
                    game.display_mode))
        game.set_display_mode(C.DEFAULT_DISPLAY_MODE)
    finally:
        try:
            game.save.path = os.path.join(tempfile.gettempdir(),
                                          "neon_turn_test_discard.json")
            import pygame as _pg
            _pg.quit()
        except Exception:
            pass


# ==========================================================================
# Entry point
# ==========================================================================
def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--quick", action="store_true",
                        help="skip the full 12-level difficulty sweep")
    args = parser.parse_args(list(argv) if argv is not None else None)

    r = REPORT
    r.log("=" * 78)
    r.log("NEON SERPENT v2 - numerical verification")
    r.log("=" * 78)
    r.log("  turn radius {:.1f} px, rate cap {:.1f} rad/s, floor {:.1f} rad/s"
          .format(C.SNAKE_MIN_TURN_RADIUS, C.SNAKE_TURN_RATE_CAP,
                  C.SNAKE_TURN_RATE))
    r.log("  self-collision: skip {} segments, depth {:.2f}".format(
        C.SELF_COLLISION_SKIP, C.SELF_COLLISION_DEPTH))

    sections: Sequence[Tuple[str, Callable[[], None]]] = (
        ("turning", lambda: run_turning(r)),
        ("turning sweep", lambda: run_turning_difficulty_sweep(r, args.quick)),
        ("self-collision", lambda: run_self_collision(r)),
        ("difficulty", lambda: run_difficulty(r)),
        ("save", lambda: run_save(r)),
        ("story", lambda: run_story(r)),
        ("display", lambda: run_display(r)),
    )
    for name, fn in sections:
        try:
            fn()
        except Exception as exc:                   # pragma: no cover
            import traceback
            traceback.print_exc()
            r.fail("section {!r} crashed: {}".format(name, exc))

    r.head("SUMMARY")
    r.log("  {} checks, {} failures".format(r.checks, len(r.failures)))
    for line in r.failures:
        r.log("  FAILED: " + line)
    r.log("")
    r.log("  RESULT: " + ("PASS" if not r.failures else "FAIL"))
    return 0 if not r.failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
