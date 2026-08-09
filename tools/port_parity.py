"""
Port parity harness: dump a numeric trace of the PYTHON simulation.

The TypeScript port in ``web/`` is a translation of ``snake/core``, and the
only honest proof that a translation is faithful is that both programs produce
the same numbers from the same inputs.  This script drives the *real* Python
game objects through a fixed, fully recorded script and writes everything it
observes to::

    web/tests/fixtures/port_parity.json

``web/tests/parity.spec.ts`` then replays the *identical* script against the
TypeScript objects and asserts the traces agree.  Nothing in the fixture is
computed on the TypeScript side: the script itself (per-frame dt, steering
target, boost flag, multipliers) is recorded here so the two runs cannot drift
through a differing input generator.

Sections written:

    config        every simulation constant the port depends on
    snakeTrace    600 frames of steering / boost / multiplier changes
    uturn         U-turn width vs speed - the constant-radius steering claim
    speedRamp     per-level cruise / base speed and measured travel
    lethalBands   self-collision lethal radius per difficulty
    hairpin       lethal frames through a 180 degree hairpin, per difficulty
    obstacles     build_obstacles output for all 12 levels, at two times

Run with::

    python tools/port_parity.py

It imports pygame (obstacles use ``pygame.Rect``) but never opens a window.
"""

from __future__ import annotations

import json
import math
import os
import sys
from typing import Any, Dict, List, Optional, Tuple

# pygame is imported transitively by core.obstacles; keep it headless.
os.environ.setdefault("SDL_VIDEODRIVER", "dummy")
os.environ.setdefault("PYGAME_HIDE_SUPPORT_PROMPT", "1")

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from snake import config as C                                    # noqa: E402
from snake.core import difficulty as D                           # noqa: E402
from snake.core import level as L                                # noqa: E402
from snake.core import obstacles as OB                           # noqa: E402
from snake.core.snake import MAX_LENGTH, MIN_LENGTH, Snake       # noqa: E402

OUT_PATH = os.path.join(_ROOT, "web", "tests", "fixtures", "port_parity.json")

DT = 1.0 / 60.0


# ==========================================================================
# helpers
# ==========================================================================
def r(v: float, nd: int = 10) -> float:
    """
    Coerce to a float for JSON.

    Deliberately *not* rounded.  ``json.dump`` writes ``repr(float)``, which
    round-trips a double exactly, so the TypeScript side reads back bit-for-bit
    the same value Python computed.  Rounding here would put a floor under the
    achievable tolerance (a 10-decimal fixture cannot be compared tighter than
    ~5e-11) and, worse, would feed the two simulations subtly different inputs
    wherever a recorded value is also a script input.  ``nd`` is accepted and
    ignored so the call sites can stay documentary about their precision.
    """
    del nd
    return float(v)


def rect_tuple(b: Any) -> List[int]:
    return [int(b.x), int(b.y), int(b.w), int(b.h)]


# ==========================================================================
# 1. config - the constants both simulations must agree on
# ==========================================================================
def dump_config() -> Dict[str, Any]:
    keys = [
        "MAX_DT",
        "ARENA_X", "ARENA_Y", "ARENA_W", "ARENA_H",
        "SNAKE_BASE_SPEED", "SNAKE_SPEED_PER_LEVEL", "SNAKE_MAX_SPEED",
        "SNAKE_BOOST_MULT", "SNAKE_BOOST_DRAIN", "SNAKE_BOOST_REGEN",
        "SNAKE_BOOST_MAX", "SNAKE_BOOST_MIN_TO_START",
        "SNAKE_MIN_TURN_RADIUS", "SNAKE_TURN_RATE", "SNAKE_TURN_RATE_CAP",
        "SNAKE_START_LENGTH", "SNAKE_SEGMENT_SPACING",
        "SNAKE_HEAD_RADIUS", "SNAKE_BODY_RADIUS", "SNAKE_TAIL_RADIUS",
        "SNAKE_GROW_PER_FOOD",
        "SELF_COLLISION_SKIP", "SELF_COLLISION_DEPTH",
        "MOUSE_DEADZONE", "SCORE_PER_FOOD",
        "START_LIVES", "INVULN_AFTER_HIT",
    ]
    out: Dict[str, Any] = {}
    for k in keys:
        out[k] = getattr(C, k)
    out["MIN_LENGTH"] = MIN_LENGTH
    out["MAX_LENGTH"] = MAX_LENGTH
    return out


# ==========================================================================
# 2. snake trace - one long, varied, fully recorded drive
# ==========================================================================
def build_script(frames: int) -> List[Dict[str, Any]]:
    """
    Deterministic per-frame input script.

    Recorded into the fixture verbatim, so the TypeScript replay uses exactly
    these numbers rather than regenerating them (a regenerator that disagreed
    by one ulp would make the whole trace comparison meaningless).

    Phases: straight run, orbiting target, hairpin reversal, lissajous chase.
    Every 97th frame is a long frame (45 ms) to exercise the sub-step bound,
    and every 151st frame drops the target entirely to exercise "hold heading".
    """
    cx, cy = 600.0, 400.0
    out: List[Dict[str, Any]] = []
    for f in range(frames):
        dt = 0.045 if f % 97 == 0 and f > 0 else DT

        if f < 120:                                   # straight
            tx, ty = cx + 900.0, cy
        elif f < 300:                                 # orbit
            a = (f - 120) * 0.035
            tx, ty = cx + math.cos(a) * 260.0, cy + math.sin(a) * 180.0
        elif f < 420:                                 # hairpin: aim behind
            tx, ty = cx - 900.0, cy - 1.0
        else:                                         # lissajous chase
            a = (f - 420) * 0.021
            tx = cx + math.sin(a * 3.0) * 300.0
            ty = cy + math.sin(a * 2.0) * 200.0

        has_target = (f % 151) != 150

        boost = ((f // 37) % 3) == 0
        speed_mult = 1.0 + 0.5 * math.sin(f / 50.0)
        turn_mult = 0.6 if f >= 500 else 1.0

        out.append({
            "dt": r(dt, 12),
            "tx": r(tx, 10) if has_target else None,
            "ty": r(ty, 10) if has_target else None,
            "boost": bool(boost),
            "speedMult": r(speed_mult, 12),
            "turnMult": r(turn_mult, 12),
            # grow on a slow cadence so the resampler is exercised while the
            # body length changes underneath it
            "grow": 1 if (f % 45 == 44) else 0,
        })
    return out


def segment_gaps(segs: List[Tuple[float, float]]) -> Tuple[float, float]:
    if len(segs) < 2:
        return (0.0, 0.0)
    gaps = [math.hypot(segs[i + 1][0] - segs[i][0], segs[i + 1][1] - segs[i][1])
            for i in range(len(segs) - 1)]
    return (min(gaps), max(gaps))


def dump_snake_trace() -> Dict[str, Any]:
    frames = 600
    script = build_script(frames)

    # A long body from the start: with fewer than ~20 segments the default
    # SELF_COLLISION_SKIP of 16 means the sweep has almost nothing to test, and
    # the trace would silently never exercise hits_self / crossing_self.
    init = {"x": 600.0, "y": 400.0, "heading": 0.0, "length": 40, "speed": 300.0}
    s = Snake(init["x"], init["y"], init["heading"], init["length"])
    s.speed = init["speed"]

    rows: List[Dict[str, Any]] = []
    samples: List[Dict[str, Any]] = []

    for f, cmd in enumerate(script):
        if cmd["grow"]:
            s.grow(cmd["grow"])
        if cmd["tx"] is None:
            s.clear_target()
        else:
            s.set_target(cmd["tx"], cmd["ty"])
        s.update(cmd["dt"], boost=cmd["boost"],
                 speed_mult=cmd["speedMult"], turn_mult=cmd["turnMult"])

        lo, hi = segment_gaps(s.segments)
        rows.append({
            "x": r(s.x), "y": r(s.y), "heading": r(s.heading),
            "currentSpeed": r(s.current_speed), "turnRate": r(s.turn_rate),
            "turnInput": r(s.turn_input), "bank": r(s.bank),
            "boost": r(s.boost), "boosting": bool(s.boosting),
            "distanceTravelled": r(s.distance_travelled),
            "targetLength": int(s.target_length),
            "segments": len(s.segments), "path": len(s.path),
            "minGap": r(lo, 8), "maxGap": r(hi, 8),
            "hitsSelf": bool(s.hits_self()),
            "crossingSelf": bool(s.crossing_self()),
        })
        if f % 25 == 0:
            samples.append({
                "frame": f,
                "segs": [[r(px), r(py)] for px, py in s.segments],
            })

    return {"init": init, "script": script, "frames": rows,
            "segmentSamples": samples}


# ==========================================================================
# 3. U-turn width vs speed
# ==========================================================================
def measure_uturn(cruise: float, speed_mult: float = 1.0,
                  turn_mult: float = 1.0, boost: bool = False) -> Dict[str, Any]:
    """
    Drive a full 180 degree reversal and measure the corridor it sweeps.

    This is ``tools/turn_test.py:measure_uturn`` reproduced verbatim - that
    function is the acceptance spec for the steering rework, so the port has to
    be measured on the same rig or the headline numbers mean nothing.

    The snake is settled onto a straight heading, then handed a target far back
    down its own line (nudged one pixel to the side so the reversal has an
    unambiguous rotation direction - a target exactly astern is a perfect ``pi``
    ambiguity).  The target sits 8000 px away so its bearing barely moves while
    the turn happens; a nearby target would make the snake orbit it instead of
    reversing.  From the instant the reversal is commanded until the heading has
    accumulated ``pi`` radians of rotation, the head's offset *perpendicular to
    the original heading* is tracked; the width of that band is the U-turn
    width.
    """
    s = Snake(300.0, 400.0, 0.0, 30)
    s.speed = float(cruise)

    s.set_target(6000.0, 400.0)
    for _ in range(40):
        s.update(DT, boost=boost, speed_mult=speed_mult, turn_mult=turn_mult)

    x0, y0, h0 = s.x, s.y, s.heading
    s.set_target(s.x - 8000.0, s.y + 1.0)

    lo = hi = 0.0
    turned = 0.0
    previous = s.heading
    frames = 0
    while turned < math.pi and frames < 4000:
        s.update(DT, boost=boost, speed_mult=speed_mult, turn_mult=turn_mult)
        delta = (s.heading - previous + math.pi) % (math.pi * 2.0) - math.pi
        turned += abs(delta)
        previous = s.heading
        lateral = -math.sin(h0) * (s.x - x0) + math.cos(h0) * (s.y - y0)
        lo = min(lo, lateral)
        hi = max(hi, lateral)
        frames += 1

    width = hi - lo
    return {"cruise": r(cruise, 6), "speedMult": r(speed_mult, 6),
            "turnMult": r(turn_mult, 6), "boost": boost,
            "effectiveSpeed": r(min(cruise, float(C.SNAKE_MAX_SPEED))
                                * speed_mult
                                * (float(C.SNAKE_BOOST_MULT) if boost else 1.0), 6),
            "width": r(width, 6), "radius": r(width * 0.5, 6), "frames": frames}


def dump_uturn() -> List[Dict[str, Any]]:
    """The headline cases plus the multiplier extremes."""
    out: List[Dict[str, Any]] = []
    # The three quoted headline speeds, reached the way the game reaches them:
    # a level cruise speed times that level's pace multiplier.
    for idx in (0, 5, 11):
        lv = L.get_level(idx)
        out.append({"case": "level{:02d}".format(idx + 1),
                    **measure_uturn(lv.cruise_speed(), lv.speed_mult)})
    out.append({"case": "cruise460", **measure_uturn(460.0)})
    out.append({"case": "slowTurn", **measure_uturn(210.0, 1.0, 0.6)})
    out.append({"case": "fastTurn", **measure_uturn(309.0, 1.70, 1.4)})
    out.append({"case": "boostedL12",
                **measure_uturn(309.0, 1.70, 1.0, True)})
    out.append({"case": "crawl", **measure_uturn(60.0)})
    return out


# ==========================================================================
# 4. level speed ramp
# ==========================================================================
def dump_speed_ramp() -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for lv in L.LEVELS:
        # measured: how far the head actually travels in one simulated second
        s = Snake(600.0, 400.0, 0.0, 10)
        s.speed = lv.cruise_speed()
        s.clear_target()
        for _ in range(60):
            s.update(DT, speed_mult=lv.speed_mult)
        out.append({
            "index": lv.index,
            "name": lv.name,
            "speedMult": r(lv.speed_mult, 10),
            "cruiseSpeed": r(lv.cruise_speed(), 10),
            "baseSpeed": r(lv.base_speed(), 10),
            "goalFood": lv.goal_food,
            "foodCount": lv.food_count,
            "parScore": lv.par_score(),
            "starTargets": list(lv.star_targets()),
            "wrapWalls": bool(lv.wrap_walls),
            "powerupsEnabled": bool(lv.powerups_enabled),
            "measuredTravel": r(s.distance_travelled, 8),
            "uturnWidth": measure_uturn(lv.cruise_speed(),
                                        lv.speed_mult)["width"],
        })
    return out


def dump_uturn_matrix() -> List[Dict[str, Any]]:
    """
    Every level x every difficulty, with both multipliers applied exactly the
    way the gameplay scene applies them (``turn_test.py`` section 1b).
    """
    out: List[Dict[str, Any]] = []
    for lv in L.LEVELS:
        row: Dict[str, Any] = {"index": lv.index,
                               "baseSpeed": r(lv.base_speed(), 8)}
        widths: Dict[str, float] = {}
        for key in D.ORDER:
            diff = D.get_difficulty(key)
            widths[key] = measure_uturn(lv.cruise_speed(),
                                        lv.speed_mult * diff.speed_mult,
                                        diff.turn_mult)["width"]
        row["widths"] = widths
        out.append(row)
    return out


# ==========================================================================
# 5. self-collision lethal bands
# ==========================================================================
def _straight_snake(length: int = 40, speed: float = 240.0) -> Snake:
    """A snake driven dead straight, so its body is a known ruler."""
    s = Snake(300.0, 400.0, 0.0, length)
    s.speed = speed
    s.clear_target()
    for _ in range(240):
        s.update(DT)
    return s


def probe_lethal(skip: Optional[int], depth: Optional[float],
                 enabled: bool, probe_index: int = 20) -> Dict[str, Any]:
    """
    Walk the head away from body segment `probe_index` and find the offset at
    which the hit stops being lethal.  ``update(0.0)`` between probes bumps the
    scan tick, which is what invalidates the memoised sweep.
    """
    s = _straight_snake()
    seg = s.segments[probe_index]
    lethal_hits = 0
    first_free: Optional[float] = None
    steps = 400
    for i in range(steps):
        off = i * 0.05
        s.x, s.y = seg[0], seg[1] + off
        s.update(0.0)                     # bump the scan tick, move nothing
        hit = s.hits_self(skip=skip, depth=depth, enabled=enabled)
        if hit:
            lethal_hits += 1
        elif first_free is None and i > 0:
            first_free = off
            break
        elif first_free is None and i == 0 and not hit:
            first_free = 0.0
            break
    return {
        "firstNonLethal": None if first_free is None else r(first_free, 6),
        "lethalProbes": lethal_hits,
    }


def dump_lethal_bands() -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for key in D.ORDER:
        res = probe_lethal(D.self_collision_skip(key),
                           D.self_collision_depth(key),
                           D.self_collision_enabled(key))
        out.append({
            "difficulty": key,
            "skip": D.self_collision_skip(key),
            "depth": r(D.self_collision_depth(key), 10),
            "enabled": D.self_collision_enabled(key),
            "lives": D.lives_for(key),
            "invuln": r(D.invuln_seconds(key), 10),
            "comboWindow": r(D.combo_window(key), 10),
            "powerupSpawnRange": [r(v, 10) for v in D.powerup_spawn_range(key)],
            **res,
        })
    # ...and the raw config default, independent of the difficulty table
    out.append({"difficulty": "_config_default", "skip": C.SELF_COLLISION_SKIP,
                "depth": r(C.SELF_COLLISION_DEPTH, 10), "enabled": True,
                "lives": C.START_LIVES, "invuln": r(C.INVULN_AFTER_HIT, 10),
                "comboWindow": None, "powerupSpawnRange": None,
                **probe_lethal(None, None, True)})
    return out


# ==========================================================================
# 6. hairpin - a legitimate 180 must never be lethal
# ==========================================================================
def dump_hairpin() -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for key in list(D.ORDER) + ["_config_default"]:
        if key == "_config_default":
            skip, depth, enabled = None, None, True
        else:
            skip = D.self_collision_skip(key)
            depth = D.self_collision_depth(key)
            enabled = D.self_collision_enabled(key)
        for speed in (210.0, 525.0):
            s = Snake(600.0, 400.0, 0.0, 60)
            s.speed = min(speed, float(C.SNAKE_MAX_SPEED))
            mult = speed / s.speed
            s.set_target(600.0 - 900.0, 400.0 - 1.0)
            lethal = 0
            crossing = 0
            for _ in range(360):
                s.update(DT, speed_mult=mult)
                if s.hits_self(skip=skip, depth=depth, enabled=enabled):
                    lethal += 1
                if s.crossing_self():
                    crossing += 1
            out.append({"difficulty": key, "speed": r(speed, 6),
                        "lethalFrames": lethal, "crossingFrames": crossing})
    return out


# ==========================================================================
# 7. obstacles for all 12 levels
# ==========================================================================
def _state_of(ob: OB.Obstacle) -> Dict[str, Any]:
    st: Dict[str, Any] = {}
    if isinstance(ob, OB.MovingBar):
        st = {"x": r(ob.x), "y": r(ob.y), "dir": r(ob.dir, 6),
              "axis": ob.axis, "span": rect_tuple(ob.span())}
    elif isinstance(ob, OB.Spinner):
        st = {"angle": r(ob.angle), "arms": ob.arms,
              "tips": [[r(a), r(b)] for a, b in ob._tips()]}
    elif isinstance(ob, OB.Pulsar):
        st = {"radius": r(ob.radius), "charge": r(ob.charge),
              "threshold": r(ob.threshold), "armed": bool(ob.armed)}
    elif isinstance(ob, OB.LaserGate):
        st = {"firing": bool(ob.firing), "warn": r(ob.warn),
              "armed": bool(ob.armed)}
    elif isinstance(ob, OB.Portal):
        st = {"spin": r(ob.spin), "cooldown": r(ob.cooldown),
              "secondary": bool(ob.secondary), "linked": ob.linked is not None,
              "radius": r(ob.radius)}
    elif isinstance(ob, OB.WallBlock):
        st = {"x": r(ob.x), "y": r(ob.y), "w": r(ob.w), "h": r(ob.h)}
    return st


def _probe_grid(ob: OB.Obstacle) -> str:
    """
    A compact collision fingerprint: an 11x11 grid over the hazard's bounds
    inflated by 30 px, sampled at r=0 and at the head radius.
    """
    b = ob.bounds()
    x0, y0 = b.x - 30.0, b.y - 30.0
    w, h = b.w + 60.0, b.h + 60.0
    bits: List[str] = []
    for rad in (0.0, float(C.SNAKE_HEAD_RADIUS)):
        for iy in range(11):
            for ix in range(11):
                px = x0 + w * (ix / 10.0)
                py = y0 + h * (iy / 10.0)
                bits.append("1" if ob.collides(px, py, rad) else "0")
    return "".join(bits)


def _snapshot(obs: List[OB.Obstacle]) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for ob in obs:
        out.append({
            "kind": ob.kind,
            "deadly": bool(ob.deadly),
            "bounds": rect_tuple(ob.bounds()),
            "avoid": [r(v) for v in ob.avoid()],
            "state": _state_of(ob),
            "probes": _probe_grid(ob),
        })
    return out


def dump_obstacles() -> List[Dict[str, Any]]:
    arena = list(L.ARENA.as_tuple())
    out: List[Dict[str, Any]] = []
    for lv in L.LEVELS:
        obs = OB.build_obstacles(lv.obstacle_spec, arena)
        at0 = _snapshot(obs)
        t = 0.0
        for _ in range(222):
            t += DT
            for ob in obs:
                ob.update(DT, t)
        at1 = _snapshot(obs)
        portals = [o for o in obs if isinstance(o, OB.Portal)]
        out.append({
            "index": lv.index,
            "specCount": len(lv.obstacle_spec),
            "count": len(obs),
            "kinds": [o.kind for o in obs],
            "portalCount": len(portals),
            "portalLinks": [bool(p.linked is not None) for p in portals],
            "avoidList": [[r(v) for v in a]
                          for a in OB.obstacle_avoid_list(obs)],
            "t": r(t, 12),
            "atT0": at0,
            "atT1": at1,
        })
    return out


# ==========================================================================
# 8. palette colour maths
# ==========================================================================
def dump_palette() -> Dict[str, Any]:
    """
    The colour helpers are pure functions of floats, so they must agree to the
    integer.  ``clamp8`` truncates rather than rounds, which is easy to get
    wrong in a port (``Math.round`` vs ``Math.trunc``), so it is sampled hard.
    """
    from snake import palette as P

    clamp8 = [[r(v, 6), P.clamp8(v)] for v in
              (-500.0, -1.0, -0.4, 0.0, 0.5, 1.5, 127.5, 200.9, 254.9,
               255.0, 255.4, 999.0)]

    samples: List[float] = [0.0, 0.13, 0.25, 0.5, 0.77, 1.0]
    a: Tuple[int, int, int] = (12, 200, 90)
    b: Tuple[int, int, int] = (255, 30, 140)

    return {
        "clamp8": clamp8,
        "lerpColor": [[r(t, 6), list(P.lerp_color(a, b, t))] for t in samples],
        "shade": [[r(f, 6), list(P.shade(a, f))]
                  for f in (0.0, 0.25, 0.5, 1.0, 1.7, 3.0)],
        "withAlpha": [[r(al, 6), list(P.with_alpha(a, al))]
                      for al in (0.0, 0.33, 1.0)],
        "hsv": [[r(h, 6), list(P.hsv(h, 0.8, 0.9))]
                for h in (0.0, 0.1, 0.25, 0.5, 0.75, 0.999, 1.0)],
        "hueShift": [[r(d, 6), list(P.hue_shift(b, d))]
                     for d in (-0.3, -0.08, 0.0, 0.08, 0.5, 0.97)],
        "rainbow": [[r(t, 6), list(P.rainbow(t, 0.72, 1.0))]
                    for t in (0.0, 0.17, 0.44, 1.3, 5.5, 12.75)],
        "themes": [
            {
                "name": th.name,
                "bodyAt": [[r(t, 6), list(th.body_at(t))] for t in
                           (-0.5, 0.0, 0.2, 0.4, 0.5, 0.6, 0.8, 1.0, 1.4)],
            }
            for th in [L.get_level(i).theme for i in range(len(L.LEVELS))]
        ],
        "ui": {
            "UI_WHITE": list(P.UI_WHITE), "UI_GOLD": list(P.UI_GOLD),
            "UI_DIM": list(P.UI_DIM), "UI_GOOD": list(P.UI_GOOD),
            "UI_WARN": list(P.UI_WARN), "UI_BAD": list(P.UI_BAD),
            "UI_PANEL": list(P.UI_PANEL),
            "UI_PANEL_LIGHT": list(P.UI_PANEL_LIGHT),
        },
    }


# ==========================================================================
# 9. food - the RNG-free half
# ==========================================================================
def dump_food() -> Dict[str, Any]:
    """
    Spawn *placement* is RNG driven and deliberately not comparable (the two
    languages seed different generators).  Everything else about an orb is a
    pure function of its fields and the clock, and that is what is dumped here:
    construct orbs with explicit phase / spin and evaluate every derived
    quantity on a time grid.
    """
    from snake.core import food as F

    times = [0.0, 0.05, 0.34, 0.5, 1.0, 2.5, 5.0, 7.9, 8.5, 9.0, 12.0]

    orbs: List[Dict[str, Any]] = []
    for kind in ("normal", "bonus", "mega"):
        spec = F.FOOD_KINDS[kind]
        for phase, spin, born in ((0.0, 0.0, 0.0), (1.234, 5.6, 2.0)):
            orb = F.Food(
                x=400.0, y=300.0, kind=kind,
                value=int(spec["value"]), radius=float(spec["radius"]),
                born=float(born), ttl=float(spec["ttl"]),
                grow=int(spec["grow"]), color=(255, 255, 255),
                _phase=phase, _spin=spin,
            )
            rows = []
            for t in times:
                left = orb.remaining(t)
                rows.append({
                    "t": r(t, 8),
                    "age": r(orb.age(t), 12),
                    "remaining": None if math.isinf(left) else r(left, 12),
                    "expired": bool(orb.expired(t)),
                    "bobOffset": r(orb.bob_offset(t), 12),
                    "drawPos": [r(v, 12) for v in orb.draw_pos(t)],
                    "drawRadius": r(orb.draw_radius(t), 12),
                    "visible": bool(orb.visible(t)),
                })
            orbs.append({
                "kind": kind, "phase": r(phase, 8), "spin": r(spin, 8),
                "born": r(born, 8), "value": int(spec["value"]),
                "radius": r(float(spec["radius"]), 8),
                "ttl": r(float(spec["ttl"]), 8), "grow": int(spec["grow"]),
                "perishable": bool(orb.perishable),
                "pickupRadius": r(orb.pickup_radius(), 12),
                "overlaps": [
                    bool(orb.overlaps(px, py, pr))
                    for px, py, pr in ((400.0, 300.0, 0.0), (410.0, 300.0, 0.0),
                                       (420.0, 300.0, 0.0), (400.0, 330.0, 13.0),
                                       (440.0, 340.0, 13.0))
                ],
                "frames": rows,
            })

    # theme-driven colours, per level theme, on a time grid
    colours: List[Dict[str, Any]] = []
    for i in range(len(L.LEVELS)):
        th = L.get_level(i).theme
        colours.append({
            "level": i,
            "normal": [list(F.food_color("normal", th, t)) for t in times],
            "bonus": [list(F.food_color("bonus", th, t)) for t in times],
            "mega": [list(F.food_color("mega", th, t)) for t in times],
        })
    colours.append({
        "level": None,   # theme=None fallback path
        "normal": [list(F.food_color("normal", None, t)) for t in times],
        "bonus": [list(F.food_color("bonus", None, t)) for t in times],
        "mega": [list(F.food_color("mega", None, t)) for t in times],
    })

    return {
        "times": [r(t, 8) for t in times],
        "kinds": {k: {kk: (r(vv, 8) if isinstance(vv, float) else vv)
                      for kk, vv in v.items()}
                  for k, v in F.FOOD_KINDS.items()},
        "constants": {
            "BOB_SPEED": r(F.BOB_SPEED, 8), "BOB_AMOUNT": r(F.BOB_AMOUNT, 8),
            "PULSE_AMOUNT": r(F.PULSE_AMOUNT, 8),
            "POP_IN_TIME": r(F.POP_IN_TIME, 8),
            "BLINK_LEAD": r(F.BLINK_LEAD, 8),
            "SPAWN_MARGIN": r(F.SPAWN_MARGIN, 8),
            "SPAWN_TRIES": F.SPAWN_TRIES,
            "MIN_FOOD_SEPARATION": r(F.MIN_FOOD_SEPARATION, 8),
        },
        "orbs": orbs,
        "colours": colours,
    }


# ==========================================================================
# 10. power-ups - the RNG-free half
# ==========================================================================
def dump_powerups() -> Dict[str, Any]:
    from snake.core import powerups as PU

    kinds = list(PU.POWERUP_TYPES.keys())

    runes: List[Dict[str, Any]] = []
    for kind in kinds:
        for phase, spin in ((0.0, 1.0), (2.1, -1.0)):
            p = PU.PowerUp(x=500.0, y=350.0, kind=kind, born=0.0,
                           _phase=phase, _spin=spin)
            rows = []
            for age in (0.0, 0.1, 0.34, 1.0, 3.0, 6.0,
                        max(0.0, p.ttl - 1.5), max(0.0, p.ttl - 0.4), p.ttl):
                p._age = float(age)
                rows.append({
                    "age": r(age, 12),
                    "remaining": r(p.remaining(), 12),
                    "expired": bool(p.expired()),
                    "brightness": r(p.brightness(), 12),
                    "drawRadius": r(p.draw_radius(), 12),
                })
            runes.append({
                "kind": kind, "phase": r(phase, 8), "spin": r(spin, 8),
                "ttl": r(p.ttl, 8), "radius": r(p.radius, 8),
                "colour": list(p.color), "duration": r(p.duration, 8),
                "pickupRadius": r(p.pickup_radius(), 12),
                "overlaps": [
                    bool(p.overlaps(px, py, pr))
                    for px, py, pr in ((500.0, 350.0, 0.0), (515.0, 350.0, 0.0),
                                       (530.0, 350.0, 0.0), (500.0, 380.0, 13.0))
                ],
                "frames": rows,
            })

    # A scripted ActiveEffects session: overlapping adds, refreshes, a consume
    # and a long tail of ticks, sampling every derived modifier each frame.
    eff = PU.ActiveEffects()
    script: List[Dict[str, Any]] = []
    plan = [
        (0, "add", "slow", None), (0, "add", "double", None),
        (12, "add", "frenzy", None), (20, "add", "magnet", None),
        (30, "add", "shield", None), (44, "add", "slow", None),
        (60, "consume", "shield", None), (75, "add", "ghost", 2.5),
        (110, "remove", "double", None),
    ]
    by_frame: Dict[int, List[Tuple[str, str, Optional[float]]]] = {}
    for f, op, kind, dur in plan:
        by_frame.setdefault(f, []).append((op, kind, dur))

    rows: List[Dict[str, Any]] = []
    for f in range(420):
        for op, kind, dur in by_frame.get(f, []):
            if op == "add":
                eff.add(kind, dur)
            elif op == "remove":
                eff.remove(kind)
            elif op == "consume":
                eff.consume(kind)
        expired = eff.update(DT)
        rows.append({
            "f": f,
            "expired": list(expired),
            "size": len(eff),
            "items": [[k, r(v, 12)] for k, v in eff.items()],
            "scoreMult": eff.score_multiplier(),
            "speedMult": r(eff.speed_multiplier(), 12),
            "turnMult": r(eff.turn_multiplier(), 12),
            "magnetRadius": r(eff.magnet_radius(), 12),
            "extraFood": eff.extra_food(),
            "fractions": {k: r(eff.fraction(k), 12) for k in kinds},
        })
    script = rows

    return {
        "kinds": kinds,
        "types": {k: {kk: (r(vv, 8) if isinstance(vv, float) else
                           (list(vv) if isinstance(vv, tuple) else vv))
                      for kk, vv in v.items()}
                  for k, v in PU.POWERUP_TYPES.items()},
        "constants": {
            "MAGNET_RADIUS": r(PU.MAGNET_RADIUS, 8),
            "MAGNET_STRENGTH": r(PU.MAGNET_STRENGTH, 8),
            "SLOW_SPEED_MULT": r(PU.SLOW_SPEED_MULT, 8),
            "SLOW_TURN_MULT": r(PU.SLOW_TURN_MULT, 8),
            "FRENZY_SPEED_MULT": r(PU.FRENZY_SPEED_MULT, 8),
            "FRENZY_EXTRA_FOOD": PU.FRENZY_EXTRA_FOOD,
            "DOUBLE_SCORE_MULT": PU.DOUBLE_SCORE_MULT,
            "MAX_ACTIVE": PU.MAX_ACTIVE,
            "POP_IN_TIME": r(PU.POP_IN_TIME, 8),
            "BLINK_LEAD": r(PU.BLINK_LEAD, 8),
            "CORE_PULSE_SPEED": r(PU.CORE_PULSE_SPEED, 8),
        },
        "runes": runes,
        "effects": script,
    }


# ==========================================================================
# 11. story and the full difficulty table
# ==========================================================================
def dump_story() -> Dict[str, Any]:
    from snake.core import story as S

    # Probe the lookups well outside the valid range: totality is the whole
    # point of _clamp_index, and an off-by-one there is invisible until a
    # player finishes the campaign.
    probes = [-99, -1, 0, 1, 2, 3, 5, 8, 11, 12, 50]

    return {
        "chapterSize": S.CHAPTER_SIZE,
        "beatCount": S.BEAT_COUNT,
        "chapterCount": S.CHAPTER_COUNT,
        "prologue": {"title": S.PROLOGUE.title, "lines": list(S.PROLOGUE.lines),
                     "speaker": S.PROLOGUE.speaker},
        "epilogue": {"title": S.EPILOGUE.title, "lines": list(S.EPILOGUE.lines),
                     "speaker": S.EPILOGUE.speaker},
        "beats": [
            {
                "levelIndex": b.level_index, "number": b.number,
                "chapter": b.chapter, "chapterTitle": b.chapter_title,
                "title": b.title, "intro": list(b.intro),
                "outro": list(b.outro), "speaker": b.speaker,
                "isChapterStart": bool(b.is_chapter_start),
                "isChapterEnd": bool(b.is_chapter_end),
            }
            for b in S.all_beats()
        ],
        "chapters": [
            {
                "number": c.number, "title": c.title, "roman": c.roman,
                "blurb": list(c.blurb),
                "firstIndex": c.first_index, "lastIndex": c.last_index,
                "levelRange": list(c.level_range),
                "levelIndices": list(c.level_indices),
                "contains": [bool(c.contains(i)) for i in probes],
            }
            for c in S.CHAPTERS
        ],
        "probes": probes,
        "getBeat": [S.get_beat(i).level_index for i in probes],
        "getChapter": [S.get_chapter(i).number for i in probes],
        "beatsInChapter": [[b.level_index for b in S.beats_in_chapter(n)]
                           for n in probes],
        "chapterStart": [bool(S.chapter_start(i)) for i in probes],
        "chapterEnd": [bool(S.chapter_end(i)) for i in probes],
        "validateProblems": list(S.validate_story()),
    }


def dump_difficulty_table() -> Dict[str, Any]:
    """Every field of every difficulty, not just the ones the bands exercise."""
    fields = [
        "key", "name", "blurb", "hud_label", "rank", "lives", "invuln_mult",
        "speed_mult", "turn_mult", "self_mode", "self_skip_mult",
        "self_depth_mult", "hazard_speed_mult", "powerup_rate_mult",
        "food_value_mult", "score_mult", "combo_window_mult",
        "star_target_mult",
    ]
    out: Dict[str, Any] = {"order": list(D.ORDER),
                           "default": D.DEFAULT.key,
                           "skipNever": D.SKIP_NEVER,
                           "selfModes": list(D.SELF_MODES),
                           "problems": list(D._assert_normal_is_identity()),
                           "modes": []}
    for key in D.ORDER:
        d = D.get_difficulty(key)
        row: Dict[str, Any] = {}
        for f in fields:
            v = getattr(d, f)
            row[f] = r(v, 12) if isinstance(v, float) else v
        row["color"] = list(d.color)
        row["label"] = d.label
        row["isDefault"] = bool(d.is_default)
        # scoring helper across a grid of inputs
        row["scoreForFood"] = [
            D.score_for_food(key, base, multiplier=mult)
            for base in (0, 1, 10, 25, 100)
            for mult in (0.0, 1.0, 2.5)
        ]
        row["applyStarTargets"] = list(D.apply_star_targets(key, (100, 135, 175)))
        out["modes"].append(row)
    return out


# ==========================================================================
# main
# ==========================================================================
def main() -> int:
    doc: Dict[str, Any] = {
        "_comment": ("Generated by tools/port_parity.py from the Python game. "
                     "Do not hand-edit; regenerate instead."),
        "python": sys.version.split()[0],
        "dt": DT,
        "config": dump_config(),
        "snakeTrace": dump_snake_trace(),
        "uturn": dump_uturn(),
        "uturnMatrix": dump_uturn_matrix(),
        "speedRamp": dump_speed_ramp(),
        "lethalBands": dump_lethal_bands(),
        "hairpin": dump_hairpin(),
        "obstacles": dump_obstacles(),
        "palette": dump_palette(),
        "food": dump_food(),
        "powerups": dump_powerups(),
        "story": dump_story(),
        "difficultyTable": dump_difficulty_table(),
    }
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, separators=(",", ":"))
    size = os.path.getsize(OUT_PATH)
    print("wrote {} ({:.1f} KiB)".format(OUT_PATH, size / 1024.0))
    print("  snake frames  :", len(doc["snakeTrace"]["frames"]))
    print("  uturn cases   :", len(doc["uturn"]))
    print("  levels        :", len(doc["speedRamp"]))
    print("  lethal bands  :", len(doc["lethalBands"]))
    print("  obstacle sets :", len(doc["obstacles"]),
          "total", sum(o["count"] for o in doc["obstacles"]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
