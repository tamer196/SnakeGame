"""
Headless integration smoke test for NEON SERPENT.

Exercises the real code paths of every module written by the twelve parallel
agents, checks the pinned cross-module contract, and asserts that the Snake
entity actually behaves (moves, tracks target_length, keeps segment spacing).

Run from the repo root::

    python tools/smoke_modules.py

Exits 0 when everything passes, 1 on the first hard failure.  Every section is
wrapped so that a failure is reported with a full traceback and the run keeps
going, giving one complete picture instead of one error at a time.
"""

from __future__ import annotations

import math
import os
import random
import sys
import tempfile
import traceback
from typing import Any, Callable, List, Tuple

# --------------------------------------------------------------------------
# Bootstrap: headless video/audio before pygame is imported.
# --------------------------------------------------------------------------
os.environ.setdefault("SDL_VIDEODRIVER", "dummy")
os.environ.setdefault("SDL_AUDIODRIVER", "dummy")

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

import pygame  # noqa: E402

pygame.init()
pygame.display.set_mode((64, 48))

from snake import config as C  # noqa: E402
from snake import palette as P  # noqa: E402
from snake.core import audio as audio_mod  # noqa: E402
from snake.core import food as food_mod  # noqa: E402
from snake.core import level as level_mod  # noqa: E402
from snake.core import obstacles as obs_mod  # noqa: E402
from snake.core import powerups as pw_mod  # noqa: E402
from snake.core import save as save_mod  # noqa: E402
from snake.core import snake as snake_mod  # noqa: E402
from snake.gfx import background as bg_mod  # noqa: E402
from snake.gfx import effects as fx_mod  # noqa: E402
from snake.gfx import particles as part_mod  # noqa: E402
from snake.gfx import render as render_mod  # noqa: E402
from snake.gfx import ui as ui_mod  # noqa: E402
from snake.gfx.fonts import FontBook  # noqa: E402

DT = 1.0 / C.FPS
ARENA = pygame.Rect(*C.ARENA_RECT)


def clampf(v: float, lo: float, hi: float) -> float:
    return lo if v < lo else (hi if v > hi else v)

_failures: List[str] = []
_notes: List[str] = []


def check(label: str, condition: bool, detail: str = "") -> None:
    """Assert-with-reporting: records the failure instead of aborting."""
    if condition:
        print(f"    ok   {label}")
    else:
        msg = f"{label}{(' - ' + detail) if detail else ''}"
        print(f"    FAIL {msg}")
        _failures.append(msg)


def section(name: str, fn: Callable[[], None]) -> None:
    print(f"\n[{name}]")
    try:
        fn()
    except Exception:  # pragma: no cover - the whole point of a smoke test
        print(f"    FAIL {name} raised:")
        traceback.print_exc()
        _failures.append(f"{name} raised an exception")


def canvas() -> pygame.Surface:
    surf = pygame.Surface(C.WINDOW_SIZE).convert()
    surf.fill((0, 0, 0))
    return surf


# ==========================================================================
# 1. Snake behaviour
# ==========================================================================
def test_snake() -> None:
    S = snake_mod.Snake
    sn = S(ARENA.centerx, ARENA.centery, heading=0.0)

    check("start length honours SNAKE_START_LENGTH",
          sn.target_length == C.SNAKE_START_LENGTH,
          f"target_length={sn.target_length}")

    start = sn.head_pos()
    # Drive the head with a mouse target that orbits the arena, so steering,
    # sub-stepping and the path buffer all get a real workout.
    for i in range(600):
        ang = i * 0.017
        tx = ARENA.centerx + math.cos(ang) * 260.0
        ty = ARENA.centery + math.sin(ang * 1.3) * 190.0
        sn.set_target(tx, ty)
        sn.update(DT, boost=(i % 90 < 20))
        if i % 60 == 59:
            sn.grow(1)

    moved = math.hypot(sn.head_pos()[0] - start[0], sn.head_pos()[1] - start[1])
    check("snake moved away from spawn", moved > 50.0, f"moved={moved:.1f}px")
    check("head position is finite",
          all(math.isfinite(v) for v in sn.head_pos()))
    check("snake still alive after clean run", sn.alive)
    check("heading is finite and bounded",
          math.isfinite(sn.heading) and abs(sn.heading) <= math.tau + 1e-6,
          f"heading={sn.heading}")

    # segments must track target_length
    check("segments count tracks target_length",
          abs(len(sn.segments) - sn.target_length) <= 1,
          f"segments={len(sn.segments)} target_length={sn.target_length}")

    # spacing between consecutive segments ~= C.SNAKE_SEGMENT_SPACING
    gaps = [math.hypot(sn.segments[i + 1][0] - sn.segments[i][0],
                       sn.segments[i + 1][1] - sn.segments[i][1])
            for i in range(len(sn.segments) - 1)]
    if gaps:
        avg = sum(gaps) / len(gaps)
        worst = max(abs(g - C.SNAKE_SEGMENT_SPACING) for g in gaps)
        check("mean segment spacing ~ SNAKE_SEGMENT_SPACING",
              abs(avg - C.SNAKE_SEGMENT_SPACING) < 1.5,
              f"avg={avg:.2f} want={C.SNAKE_SEGMENT_SPACING}")
        check("no segment gap deviates wildly", worst < 4.0,
              f"worst deviation={worst:.2f}px")
        _notes.append(f"segment spacing avg={avg:.2f} worst-dev={worst:.2f}")

    # head-to-first-segment distance should also be about one spacing
    hx, hy = sn.head_pos()
    d0 = math.hypot(sn.segments[0][0] - hx, sn.segments[0][1] - hy)
    check("head-to-first-segment gap is sane", d0 <= C.SNAKE_SEGMENT_SPACING + 2.0,
          f"gap={d0:.2f}")

    # radius taper
    radii = [sn.radius_at(i) for i in range(len(sn.segments))]
    check("radius_at returns positive finite radii",
          all(math.isfinite(r) and r > 0 for r in radii))
    check("radius tapers head -> tail", radii[0] >= radii[-1],
          f"head={radii[0]:.1f} tail={radii[-1]:.1f}")

    # grow / shrink / kill / hits_self
    before = sn.target_length
    sn.grow(5)
    check("grow() raises target_length", sn.target_length == before + 5)
    sn.shrink(3)
    check("shrink() lowers target_length", sn.target_length == before + 2)
    check("hits_self() returns a bool", isinstance(sn.hits_self(), bool))

    # A tight circle at max turn rate must eventually self-intersect.
    coil = S(ARENA.centerx, ARENA.centery, length=60)
    for _ in range(400):
        coil.set_target(coil.x + math.cos(coil.heading + 1.6) * 30.0,
                        coil.y + math.sin(coil.heading + 1.6) * 30.0)
        coil.update(DT)
    _notes.append(f"tight-coil hits_self()={coil.hits_self()}")

    sn.kill()
    check("kill() clears alive", sn.alive is False)

    # hostile input must never raise
    bad = S(0.0, 0.0)
    bad.set_target(float("nan"), float("inf"))
    bad.update(0.0)
    bad.update(-1.0)
    bad.update(9999.0, speed_mult=0.0, turn_mult=0.0)
    check("survives NaN target and absurd dt",
          math.isfinite(bad.x) and math.isfinite(bad.y))

    # teleport keeps the rope intact (used by wrap walls and portals)
    tp = S(200.0, 300.0)
    for _ in range(120):
        tp.set_target(900.0, 300.0)
        tp.update(DT)
    tp.teleport(tp.x + 500.0, tp.y)
    tgaps = [math.hypot(tp.segments[i + 1][0] - tp.segments[i][0],
                        tp.segments[i + 1][1] - tp.segments[i][1])
             for i in range(len(tp.segments) - 1)]
    check("teleport() preserves body spacing",
          not tgaps or max(tgaps) < C.SNAKE_SEGMENT_SPACING * 2.0,
          f"max gap after teleport={max(tgaps) if tgaps else 0:.1f}")


# ==========================================================================
# 2. Food
# ==========================================================================
def test_food() -> None:
    theme = P.THEMES[0]
    field = food_mod.FoodField(ARENA, theme)
    field.ensure(6)
    check("ensure(6) fills the field", len(field.items) >= 6,
          f"items={len(field.items)}")

    f = field.spawn("bonus")
    check("spawn('bonus') returns a Food or None",
          f is None or isinstance(f, food_mod.Food))
    field.spawn("mega")
    check("all spawned items land inside the arena",
          all(ARENA.collidepoint(int(i.x), int(i.y)) for i in field.items))

    surf = canvas()
    t = 0.0
    for _ in range(120):
        t += DT
        field.update(DT, t)
        field.draw(surf, t)

    # collect at a known orb
    target = field.items[0]
    got = field.collect_at(target.x, target.y, C.SNAKE_HEAD_RADIUS)
    check("collect_at() returns the overlapping food", len(got) >= 1)
    check("collect_at() removes what it returned",
          all(g not in field.items for g in got))
    check("collected Food exposes value/grow/color",
          all(isinstance(g.value, int) and isinstance(g.grow, int)
              and len(g.color) == 3 for g in got))

    # collect where there is nothing
    check("collect_at() on empty space returns []",
          field.collect_at(-500.0, -500.0, 5.0) == [])

    # avoid list must be honoured
    keep = (ARENA.centerx, ARENA.centery, 200.0)
    field.clear()
    for _ in range(12):
        field.spawn("normal", avoid=[keep])
    far = all(math.hypot(i.x - keep[0], i.y - keep[1]) > keep[2] - 1.0
              for i in field.items)
    check("spawn(avoid=...) keeps clear of the keep-out circle", far)

    # magnet path used by the powerup: radius must cover the whole arena so the
    # result does not depend on where the random spawn happened to land.
    if field.items:
        it = field.items[0]
        reach = float(ARENA.w + ARENA.h)
        d_before = math.hypot(it.x - ARENA.centerx, it.y - ARENA.centery)
        for _ in range(30):
            field.attract(ARENA.centerx, ARENA.centery, DT,
                          radius=reach, strength=pw_mod.MAGNET_STRENGTH)
        d_after = math.hypot(it.x - ARENA.centerx, it.y - ARENA.centery)
        check("attract() pulls food toward the head", d_after < d_before,
              f"{d_before:.1f} -> {d_after:.1f}")
        check("attracted food stays inside the arena",
              ARENA.collidepoint(int(it.x), int(it.y)))

    # hostile input
    food_mod.FoodField((0, 0, 0, 0), theme).ensure(3)
    field.update(0.0, 0.0)
    field.draw(surf, 0.0)
    check("degenerate arena + zero dt survive", True)


# ==========================================================================
# 3. Power-ups
# ==========================================================================
def test_powerups() -> None:
    theme = P.THEMES[3]
    pf = pw_mod.PowerUpField(ARENA, theme)
    surf = canvas()

    check("POWERUP_TYPES has the six pinned kinds",
          set(pw_mod.POWERUP_TYPES) == {"magnet", "shield", "slow",
                                        "double", "ghost", "frenzy"})
    check("every POWERUP_TYPES entry has name/color/icon/duration/desc",
          all({"name", "color", "icon", "duration", "desc"} <= set(v)
              for v in pw_mod.POWERUP_TYPES.values()))

    t = 0.0
    spawned = 0
    for i in range(2400):  # 40 simulated seconds
        t += DT
        pf.update(DT, t)
        got = pf.maybe_spawn(DT, avoid=[(ARENA.centerx, ARENA.centery, 90.0)])
        if got is not None:
            spawned += 1
        if i % 8 == 0:
            pf.draw(surf, t)
    check("maybe_spawn() actually spawns over 40s", spawned > 0,
          f"spawned={spawned}")
    check("power-up count respects the on-screen cap", len(pf.items) <= 4,
          f"items={len(pf.items)}")

    pf.clear()
    for kind in pw_mod.POWERUP_TYPES:
        pf.spawn(kind)
    pf.draw(surf, t)
    check("every kind spawns and draws", True)

    if pf.items:
        it = pf.items[0]
        taken = pf.collect_at(it.x, it.y, C.SNAKE_HEAD_RADIUS)
        check("collect_at() picks up a power-up", len(taken) >= 1)

    eff = pw_mod.ActiveEffects()
    for kind in pw_mod.POWERUP_TYPES:
        eff.add(kind)
    check("has() is True right after add()",
          all(eff.has(k) for k in pw_mod.POWERUP_TYPES))
    check("remaining() is positive",
          all(eff.remaining(k) > 0.0 for k in pw_mod.POWERUP_TYPES))
    pairs = eff.items()
    check("items() yields (kind, seconds) pairs",
          all(isinstance(k, str) and isinstance(s, float) for k, s in pairs),
          f"{pairs[:2]}")
    check("unknown kind is not 'has'", not eff.has("nope"))
    check("remaining() of an unknown kind is 0.0", eff.remaining("nope") == 0.0)

    for _ in range(2000):
        eff.update(DT)
    check("effects expire after their duration", len(eff.items()) == 0)
    eff.add("shield")
    eff.clear()
    check("clear() empties the stack", not eff.has("shield"))

    # multipliers the gameplay scene will read
    eff.add("slow")
    eff.add("double")
    check("speed/turn/score multipliers are finite",
          all(math.isfinite(v) for v in (eff.speed_multiplier(),
                                         eff.turn_multiplier(),
                                         eff.score_multiplier())))


# ==========================================================================
# 4. Levels + obstacles
# ==========================================================================
def test_levels_and_obstacles() -> None:
    check("exactly 12 levels", len(level_mod.LEVELS) == 12)
    check("LEVEL_COUNT matches", level_mod.LEVEL_COUNT == 12)
    names = [L.name for L in level_mod.LEVELS]
    expect = ["Neon Grid", "Deep Nebula", "Emerald Circuit", "Solar Flare",
              "Abyssal Tide", "Violet Static", "Frozen Vault", "Toxic Bloom",
              "Crimson Engine", "Aurora Drift", "Event Horizon", "Prism Core"]
    check("level names match the brief in order", names == expect, f"{names}")
    check("each level uses P.THEMES[index]",
          all(L.theme is P.THEMES[L.index] for L in level_mod.LEVELS))
    check("goal_food ramps 8 -> 30",
          level_mod.LEVELS[0].goal_food == 8 and level_mod.LEVELS[-1].goal_food == 30)
    check("speed_mult ramps 1.0 -> 1.7",
          abs(level_mod.LEVELS[0].speed_mult - 1.0) < 1e-6
          and abs(level_mod.LEVELS[-1].speed_mult - 1.7) < 1e-6)
    check("level 1 is gentle: wrap walls, no obstacles",
          level_mod.LEVELS[0].wrap_walls and not level_mod.LEVELS[0].obstacle_spec)
    check("get_level() clamps out-of-range indices",
          level_mod.get_level(-5).index == 0 and level_mod.get_level(99).index == 11)

    # The felt pace must actually increase every level.  SNAKE_MAX_SPEED caps
    # the cruise term only; if it capped the product, the top of the curve
    # would flatten and the last levels would play identically.
    speeds = []
    for L in level_mod.LEVELS:
        probe = snake_mod.Snake(0.0, 0.0)
        probe.speed = L.cruise_speed()
        speeds.append(probe._update_boost(DT, False, L.speed_mult))
    flat = [i for i in range(1, len(speeds)) if speeds[i] <= speeds[i - 1] + 1.0]
    check("effective snake speed rises on every level", not flat,
          "no faster than the previous level at: "
          + ", ".join(f"L{i + 1} ({speeds[i]:.0f} px/s)" for i in flat))
    _notes.append("level speed ramp: "
                  + " -> ".join(f"{s:.0f}" for s in speeds) + " px/s")

    surf = canvas()
    total = 0
    portals = 0
    for L in level_mod.LEVELS:
        built = obs_mod.build_obstacles(L.obstacle_spec, ARENA)
        check(f"L{L.index + 1:02d} {L.name}: {len(built)}/{len(L.obstacle_spec)}"
              f" obstacles built",
              len(built) == len(L.obstacle_spec),
              "some spec entries were silently dropped")
        total += len(built)
        t = 0.0
        for _ in range(90):
            t += DT
            for ob in built:
                ob.update(DT, t)
                ob.collides(ARENA.centerx, ARENA.centery, C.SNAKE_HEAD_RADIUS)
            for ob in built:
                ob.draw(surf, L.theme, t)
        for ob in built:
            b = ob.bounds()
            check_silent = ARENA.inflate(80, 80).contains(b)
            if not check_silent:
                _failures.append(f"L{L.index + 1} obstacle {ob.kind} out of arena")
            # avoid() feeds FoodField/PowerUpField, which want (x, y, radius)
            av = ob.avoid()
            if not (isinstance(av, tuple) and len(av) == 3
                    and all(isinstance(v, (int, float)) and math.isfinite(v)
                            for v in av)):
                _failures.append(f"L{L.index + 1} {ob.kind}.avoid() bad shape: {av!r}")
            if not isinstance(ob.deadly, bool):
                _failures.append(f"L{L.index + 1} {ob.kind}.deadly is not a bool")
            if isinstance(ob, obs_mod.Portal):
                portals += 1
                check_link = ob.linked is not None
                if not check_link:
                    _failures.append(f"L{L.index + 1} portal has no link")
                ex, ey = ob.teleport(ob.x, ob.y)
                if not (math.isfinite(ex) and math.isfinite(ey)):
                    _failures.append(f"L{L.index + 1} portal teleport not finite")
    check("all obstacles stayed inside the arena and portals are linked", True)
    _notes.append(f"{total} obstacles across 12 levels, {portals} portals")

    # -- portal traversal: drive a snake through and check the far side ----
    lvl = level_mod.LEVELS[9]
    obs = obs_mod.build_obstacles(lvl.obstacle_spec, ARENA)
    ports = [o for o in obs if isinstance(o, obs_mod.Portal)]
    check("Aurora Drift has paired, non-deadly portals",
          len(ports) >= 2 and all(p.linked is not None and not p.deadly
                                  for p in ports))
    p0 = ports[0]
    sn = snake_mod.Snake(p0.x - 220.0, p0.y, heading=0.0, length=20)
    sn.speed = lvl.cruise_speed()
    hops: List[Tuple[float, float]] = []
    t = 0.0
    for _ in range(600):
        t += DT
        sn.set_target(sn.x + math.cos(sn.heading) * 200.0,
                      sn.y + math.sin(sn.heading) * 200.0)
        sn.update(DT, speed_mult=lvl.speed_mult)
        for o in obs:
            o.update(DT, t)
        hx, hy = sn.head_pos()
        for o in obs:
            if isinstance(o, obs_mod.Portal) and o.collides(hx, hy,
                                                            C.SNAKE_HEAD_RADIUS):
                nx, ny = o.teleport(hx, hy)
                sn.teleport(nx, ny)
                hops.append((nx, ny))
                break
        if not ARENA.collidepoint(int(sn.x), int(sn.y)):
            sn.teleport(clampf(sn.x, ARENA.left + 5, ARENA.right - 5),
                        clampf(sn.y, ARENA.top + 5, ARENA.bottom - 5))
            sn.heading += math.pi
    check("the snake actually traverses a portal", len(hops) > 0,
          f"hops={len(hops)}")
    check("the cooldown stops portal ping-pong", len(hops) < 120,
          f"{len(hops)} teleports in 10 s")
    check("every portal exit lands inside the arena",
          all(ARENA.collidepoint(int(x), int(y)) for x, y in hops))
    gaps = [math.hypot(sn.segments[i + 1][0] - sn.segments[i][0],
                       sn.segments[i + 1][1] - sn.segments[i][1])
            for i in range(len(sn.segments) - 1)]
    check("the body does not smear across the arena after a portal hop",
          not gaps or max(gaps) < C.SNAKE_SEGMENT_SPACING * 1.5,
          f"max gap={max(gaps) if gaps else 0:.2f}")

    # unknown/garbage spec entries must be skipped, never raise
    junk = obs_mod.build_obstacles(
        [{"type": "nonsense"}, {}, None, 42, {"type": "wall", "bogus": 1},
         {"type": "portal"}], ARENA)
    check("garbage spec entries are skipped without raising",
          isinstance(junk, list), f"built={len(junk)}")


# ==========================================================================
# 5. Backgrounds
# ==========================================================================
def test_backgrounds() -> None:
    surf = canvas()
    styles = ("grid", "nebula", "circuit", "lava", "ocean", "static",
              "ice", "spores", "machine", "aurora", "voidwarp", "prism")
    check("STYLES exposes the twelve pinned keys",
          tuple(bg_mod.STYLES) == styles, f"{bg_mod.STYLES}")
    for i, style in enumerate(styles):
        bg = bg_mod.make_background(style, P.THEMES[i], ARENA)
        for _ in range(30):
            bg.update(DT)
            bg.draw(surf)
        print(f"    ok   background '{style}' -> {type(bg).__name__}")
    # every theme's declared bg_style must resolve to a real background
    for i, th in enumerate(P.THEMES):
        bg = bg_mod.make_background(th.bg_style, th, ARENA)
        bg.update(DT)
        bg.draw(surf)
    check("every theme.bg_style resolves and draws", True)
    fb = bg_mod.make_background("no-such-style", P.THEMES[0], ARENA)
    fb.update(DT)
    fb.draw(surf)
    check("unknown style falls back to grid",
          isinstance(fb, bg_mod.GridBackground), f"{type(fb).__name__}")


# ==========================================================================
# 6. Particles
# ==========================================================================
def test_particles() -> None:
    ps = part_mod.ParticleSystem(C.MAX_PARTICLES)
    surf = canvas()
    theme = P.THEMES[5]
    rng = random.Random(7)

    for i in range(300):
        x = ARENA.centerx + math.cos(i * 0.05) * 200.0
        y = ARENA.centery + math.sin(i * 0.07) * 140.0
        ps.trail(x, y, theme.snake_a, DT, rate=C.TRAIL_EMIT_RATE)
        ps.ambient(ARENA, theme.accent2, DT, rate=8.0)
        if i % 30 == 0:
            ps.burst(x, y, theme.food, count=24)
            ps.ring(x, y, theme.accent, radius=52.0)
            ps.spark_line(x, y, x + 90.0, y - 60.0, theme.hazard)
        ps.spawn(x, y, vx=rng.uniform(-60, 60), vy=rng.uniform(-60, 60),
                 color=theme.snake_b, kind=rng.choice(list(part_mod.KINDS)))
        ps.update(DT)
        ps.draw(surf)

    check("particle count stays under the cap", ps.count() <= C.MAX_PARTICLES,
          f"count={ps.count()}")
    check("particles are actually alive", ps.count() > 0)
    _notes.append(f"particles live after 300 frames: {ps.count()}")

    # hard saturation: cap must hold
    for _ in range(60):
        ps.burst(640, 400, (255, 255, 255), count=200)
    check("cap holds under a 12000-particle flood",
          ps.count() <= C.MAX_PARTICLES, f"count={ps.count()}")
    ps.draw(surf)

    ps.clear()
    check("clear() empties the pool", ps.count() == 0)

    # hostile input
    ps.spawn(float("nan"), 0.0, color=(999, -5, 3), radius=-2.0, life=0.0)
    ps.burst(0, 0, None, count=-4)
    ps.trail(0, 0, (255, 0, 0), -1.0)
    ps.ambient((0, 0, 0, 0), (0, 255, 0), DT)
    ps.ambient(None, (0, 255, 0), DT)
    ps.ring(0, 0, (1, 2, 3), radius=0.0, count=0)
    ps.update(float("nan"))
    ps.draw(surf)
    check("hostile particle input never raises", True)


# ==========================================================================
# 7. Effects
# ==========================================================================
def test_effects() -> None:
    fx = fx_mod.EffectStack()
    screen = pygame.Surface(C.WINDOW_SIZE).convert()
    cv = canvas()
    cv.fill((30, 40, 60))

    check("shake_amount starts at zero", fx.shake_amount == 0.0)
    check("time_scale() idles at 1.0", abs(fx.time_scale() - 1.0) < 1e-6)
    check("transition_active is False when idle", fx.transition_active is False)

    fx.slowmo(0.45, 0.6)
    fx.update(DT)
    check("slowmo() drops time_scale below 1", fx.time_scale() < 1.0,
          f"time_scale={fx.time_scale():.3f}")

    fx.shake(14.0)
    fx.flash(P.THEMES[0].accent, 0.9)
    fx.begin_transition(C.TRANSITION_TIME)
    check("transition_active is True after begin_transition",
          fx.transition_active is True)

    for _ in range(180):
        fx.update(DT)
        fx.present(cv, screen)
    check("shake decays back to ~0", fx.shake_amount < 0.5,
          f"shake_amount={fx.shake_amount:.3f}")
    check("time_scale returns to 1.0 after slowmo",
          abs(fx.time_scale() - 1.0) < 1e-6)
    check("transition finishes", fx.transition_active is False)

    # present must fully cover the screen: no untouched pixels anywhere
    screen.fill((255, 0, 255))
    fx.shake(26.0)
    fx.update(DT)
    fx.present(cv, screen)
    probes = [(2, 2), (C.WINDOW_W - 3, 2), (2, C.WINDOW_H - 3),
              (C.WINDOW_W - 3, C.WINDOW_H - 3), (C.WINDOW_W // 2, 1),
              (1, C.WINDOW_H // 2), (C.WINDOW_W - 2, C.WINDOW_H // 2)]
    magenta = [p for p in probes if screen.get_at(p)[:3] == (255, 0, 255)]
    check("present() repaints every edge pixel at max shake",
          not magenta, f"unpainted probes: {magenta}")

    for mode in ("reveal", "cover", "blink"):
        for style in ("iris", "sweep"):
            fx.begin_transition(0.3, style=style, mode=mode)
            for _ in range(24):
                fx.update(DT)
                fx.present(cv, screen)
    check("all transition style/mode combos present cleanly", True)

    fx.update(float("nan"))
    fx.shake(float("inf"))
    fx.flash(None, 5.0)
    fx.slowmo(0.0, -1.0)
    fx.present(cv, screen)
    check("hostile effect input never raises", True)
    fx.clear()


# ==========================================================================
# 8. Render
# ==========================================================================
def test_render() -> None:
    surf = canvas()
    theme = P.THEMES[9]
    t = 3.25

    g = render_mod.glow_surface(24.0, theme.accent, 1.0)
    check("glow_surface() returns a Surface", isinstance(g, pygame.Surface))
    check("glow_surface() is cached (same object twice)",
          render_mod.glow_surface(24.0, theme.accent, 1.0) is g)
    render_mod.draw_glow_circle(surf, 400.0, 400.0, 30.0, theme.food, 1.2)

    render_mod.draw_arena(surf, ARENA, theme, t)
    render_mod.draw_arena(surf, C.ARENA_RECT, theme, t)

    for kind in ("normal", "bonus", "mega", "unknown-kind"):
        render_mod.draw_food_orb(surf, 300.0, 300.0, C.FOOD_RADIUS,
                                 theme.food, t, kind=kind)

    sn = snake_mod.Snake(ARENA.centerx, ARENA.centery, length=40)
    for i in range(240):
        sn.set_target(ARENA.centerx + math.cos(i * 0.04) * 300.0,
                      ARENA.centery + math.sin(i * 0.06) * 200.0)
        sn.update(DT)
    for ghost, shield in ((False, False), (True, False),
                          (False, True), (True, True)):
        render_mod.draw_snake(surf, sn, theme, t, ghost=ghost, shield=shield)
    check("draw_snake renders in all ghost/shield combinations", True)

    # The head must be drawn at head radius, not a body radius: verify the
    # renderer and the entity agree about what radius_at(0) means.
    check("radius_at(0) is the head radius",
          abs(sn.radius_at(0) - C.SNAKE_HEAD_RADIUS) < 1.5,
          f"radius_at(0)={sn.radius_at(0):.2f} SNAKE_HEAD_RADIUS={C.SNAKE_HEAD_RADIUS}")

    # a one-segment / dead / empty snake must not blow up the renderer
    tiny = snake_mod.Snake(100.0, 100.0, length=1)
    render_mod.draw_snake(surf, tiny, theme, t)
    tiny.kill()
    render_mod.draw_snake(surf, tiny, theme, t, shield=True)
    render_mod.draw_snake(surf, None, theme, t)
    render_mod.draw_arena(surf, None, theme, t)
    render_mod.draw_food_orb(surf, float("nan"), 0.0, -3.0, None, t)
    check("hostile render input never raises", True)


# ==========================================================================
# 9. UI
# ==========================================================================
def test_ui() -> None:
    surf = canvas()
    fonts = FontBook()
    theme = P.THEMES[2]

    buttons = [
        ui_mod.Button(pygame.Rect(60, 200, C.UI_BUTTON_W, C.UI_BUTTON_H),
                      "PLAY", style="primary", data="play"),
        ui_mod.Button(pygame.Rect(60, 270, C.UI_BUTTON_W, C.UI_BUTTON_H),
                      "OPTIONS", style="ghost", data="opt"),
        ui_mod.Button(pygame.Rect(60, 340, C.UI_BUTTON_W, C.UI_BUTTON_H),
                      "QUIT", style="danger", data="quit"),
        ui_mod.Button(pygame.Rect(60, 410, 120, 120), "01",
                      style="tile", enabled=False, data=0),
    ]
    for i in range(90):
        mp = (60 + i * 3.0, 215.0)
        for b in buttons:
            b.update(DT, mp)
            b.draw(surf, theme, fonts, i * DT)
    check("a Button reports hovered when the cursor is over it",
          buttons[0].hovered is True)
    check("Button keeps its pinned attributes",
          all(hasattr(b, a) for b in buttons
              for a in ("rect", "label", "hovered", "enabled", "data")))

    down = pygame.event.Event(pygame.MOUSEBUTTONDOWN,
                              {"pos": (100, 215), "button": 1})
    up = pygame.event.Event(pygame.MOUSEBUTTONUP,
                            {"pos": (100, 215), "button": 1})
    check("MOUSEBUTTONDOWN alone is not a click",
          buttons[0].handle_event(down) is False)
    check("press+release inside the rect is a click",
          buttons[0].handle_event(up) is True)
    buttons[3].handle_event(down)
    check("a disabled Button never clicks",
          buttons[3].handle_event(up) is False)

    ui_mod.draw_panel(surf, pygame.Rect(700, 160, 480, 300), theme,
                      alpha=200, border=True, glow=0.6)
    r = ui_mod.draw_text(surf, "NEON SERPENT", fonts.title, theme.text,
                         (940, 190), align="center")
    check("draw_text returns a Rect", isinstance(r, pygame.Rect))
    for align in ("left", "center", "right", "bogus"):
        ui_mod.draw_text(surf, "align", fonts.body, P.UI_WHITE,
                         (940, 240), align=align)
    for frac in (-1.0, 0.0, 0.37, 1.0, 2.0, float("nan")):
        ui_mod.draw_bar(surf, pygame.Rect(720, 300, 300, 18), frac,
                        theme.accent, bg=P.UI_PANEL)

    class _FakeGame:
        """Minimal stand-in for Game: only what ui.draw_* actually reads."""
        def __init__(self) -> None:
            self.mouse_pos = (640.0, 400.0)
            self.mouse_buttons = {1: True, 2: False, 3: False}
            self.cursor_trail = [(600.0 + i * 3.0, 380.0 + i * 1.5)
                                 for i in range(C.CURSOR_TRAIL_LEN)]
            self.level_index = 4
            self.time = 12.5
            self.fonts = fonts
            self.particles = part_mod.ParticleSystem(64)
            self.save = None

    game = _FakeGame()
    ui_mod.draw_cursor(surf, game)

    state = {
        "score": 13480,
        "highscore": 41200,
        "level_name": "Abyssal Tide",
        "level_index": 4,
        "goal_food": 16,
        "food_eaten": 9,
        "lives": 3,
        "combo": 5,
        "boost": 61.0,
        "boost_max": C.SNAKE_BOOST_MAX,
        "effects": [("shield", 4.2), ("magnet", 2.0), ("double", 6.8),
                    ("ghost", 1.1), ("slow", 3.3), ("frenzy", 0.4)],
    }
    for i in range(60):
        ui_mod.draw_hud(surf, game, state, theme, i * DT)
    check("draw_hud renders a fully populated state", True)

    ui_mod.draw_hud(surf, game, {}, theme, 0.0)
    ui_mod.draw_hud(surf, game, {k: None for k in state}, theme, 0.0)
    ui_mod.draw_hud(surf, game, {"score": "x", "lives": -3, "boost": float("nan"),
                                 "effects": [("nope", None), 7, None]},
                    theme, 0.0)
    game.cursor_trail = []
    ui_mod.draw_cursor(surf, game)
    check("HUD/cursor survive missing and garbage state", True)


# ==========================================================================
# 10. Audio
# ==========================================================================
def test_audio() -> None:
    # numpy must never be imported anywhere in the package (it is not
    # installed).  A prose mention in a docstring is fine; an import is not.
    offenders: List[str] = []
    for root, _dirs, files in os.walk(os.path.join(_ROOT, "snake")):
        for fn in files:
            if not fn.endswith(".py"):
                continue
            path = os.path.join(root, fn)
            with open(path, "r", encoding="utf-8") as fh:
                for lineno, line in enumerate(fh, 1):
                    code = line.split("#", 1)[0]
                    if "numpy" in code and ("import" in code or "__import__" in code):
                        offenders.append(f"{path}:{lineno}")
    check("no module imports numpy anywhere in the package",
          not offenders, f"{offenders}")
    check("numpy is not loaded by importing the game",
          "numpy" not in sys.modules)
    check("pygame.surfarray/sndarray are never used",
          not any("surfarray" in open(os.path.join(r, f), encoding="utf-8").read()
                  or "sndarray" in open(os.path.join(r, f), encoding="utf-8").read()
                  for r, _d, fs in os.walk(os.path.join(_ROOT, "snake"))
                  for f in fs if f.endswith(".py")))

    a = audio_mod.Audio(muted=False, headless=False)
    check("SOUND_NAMES has the twelve pinned cues",
          set(audio_mod.SOUND_NAMES) == {"eat", "bonus", "powerup", "hit", "die",
                                         "click", "hover", "start", "levelup",
                                         "win", "boost", "portal"})
    for name in audio_mod.SOUND_NAMES:
        a.play(name)
        a.play(name, volume=0.4)
        print(f"    ok   played '{name}' (available={a.has(name)})")
    a.play("no-such-sound")
    check("unknown sound name is a silent no-op", True)
    check("toggle_mute() flips and reports", a.toggle_mute() is True)
    a.set_muted(False)
    check("set_muted(False) clears mute", a.muted is False)
    a.play("eat")
    a.stop_all()

    silent = audio_mod.Audio(muted=True, headless=True)
    for name in audio_mod.SOUND_NAMES:
        silent.play(name)
    check("headless Audio is a safe no-op", True)


# ==========================================================================
# 11. Save
# ==========================================================================
def test_save() -> None:
    tmp = os.path.join(tempfile.mkdtemp(prefix="neon-smoke-"), "savegame.json")
    sd = save_mod.SaveData.load(tmp)
    check("missing file loads defaults",
          sd.highscore == 0 and sd.unlocked == 1 and sd.muted is False)

    check("record() on a fresh level is a personal best",
          sd.record(0, 1200, 3) is True)
    check("record() unlocked the next level", sd.unlocked >= 2,
          f"unlocked={sd.unlocked}")
    check("record() of a worse score is not a best",
          sd.record(0, 900, 1) is False)
    check("stars are never downgraded", sd.stars_for(0) == 3)
    sd.unlock_through(4)
    check("unlock_through(4) unlocks through index 4", sd.unlocked >= 5)
    sd.muted = True
    sd.add_food(9)
    sd.add_death(2)
    check("save() writes without raising", sd.save() is True)

    again = save_mod.SaveData.load(tmp)
    check("round-trip preserves highscore", again.highscore == 1200)
    check("round-trip preserves stars", again.stars_for(0) == 3)
    check("round-trip preserves muted", again.muted is True)
    check("round-trip preserves counters",
          again.total_food == 9 and again.total_deaths == 2)

    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write("{not json at all")
    corrupt = save_mod.SaveData.load(tmp)
    check("corrupt file falls back to defaults", corrupt.highscore == 0)
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write('[1, 2, 3]')
    check("wrong-shape JSON falls back to defaults",
          save_mod.SaveData.load(tmp).unlocked == 1)
    bad = save_mod.SaveData.load(os.path.join(tmp, "nope", "deep", "x.json"))
    bad.save()
    check("unwritable path never raises", True)


# ==========================================================================
# 12. Full frame: everything composited together, the way a scene will do it
# ==========================================================================
def _play_level(lvl: Any, frames: int, fonts: FontBook,
                cv: pygame.Surface, screen: pygame.Surface) -> Tuple[Any, ...]:
    """Run one level exactly the way the gameplay scene is about to.

    This is the real integration path: every module updated and drawn in the
    order a scene will use, with the snake steered by a synthetic mouse.
    """
    theme = lvl.theme

    bg = bg_mod.make_background(theme.bg_style, theme, ARENA)
    sn = snake_mod.Snake(ARENA.centerx, ARENA.centery, length=24)
    ff = food_mod.FoodField(ARENA, theme)
    pf = pw_mod.PowerUpField(ARENA, theme)
    eff = pw_mod.ActiveEffects()
    obstacles = obs_mod.build_obstacles(lvl.obstacle_spec, ARENA)
    ps = part_mod.ParticleSystem(C.MAX_PARTICLES)
    fx = fx_mod.EffectStack()
    a = audio_mod.Audio(headless=True)

    # Static hazard footprints keep food and power-ups out of the walls.  The
    # standing list also covers the auto-spawned bonus/mega orbs, which are
    # rolled inside FoodField.update() with no caller-supplied avoid list.
    static_avoid = [ob.avoid() for ob in obstacles]
    ff.avoid = list(static_avoid)
    ff.ensure(lvl.food_count)

    class _FakeGame:
        pass
    game = _FakeGame()
    game.mouse_pos = (640.0, 400.0)
    game.mouse_buttons = {1: False, 2: False, 3: False}
    game.cursor_trail = []
    game.level_index = lvl.index
    game.fonts = fonts
    game.time = 0.0

    t = 0.0
    eaten = 0
    score = 0
    starved = 0
    for frame in range(frames):
        scale = fx.time_scale()
        gdt = DT * scale
        t += gdt
        game.time = t
        game.mouse_pos = (ARENA.centerx + math.cos(t * 0.9) * 320.0,
                          ARENA.centery + math.sin(t * 1.3) * 220.0)
        game.cursor_trail.append(game.mouse_pos)
        if len(game.cursor_trail) > C.CURSOR_TRAIL_LEN:
            game.cursor_trail.pop(0)

        # --- update ---
        sn.set_target(*game.mouse_pos)
        sn.update(gdt, boost=(frame % 120 < 25),
                  speed_mult=lvl.speed_mult * eff.speed_multiplier(),
                  turn_mult=eff.turn_multiplier())
        hx, hy = sn.head_pos()

        avoid = [ob.avoid() for ob in obstacles]
        bg.update(gdt)
        ff.update(gdt, t)
        pf.update(gdt, t)
        pf.maybe_spawn(gdt, avoid=avoid)
        eff.update(gdt)
        for ob in obstacles:
            ob.update(gdt, t)

        if eff.has("magnet"):
            ff.attract(hx, hy, gdt, radius=eff.magnet_radius(),
                       strength=pw_mod.MAGNET_STRENGTH)

        for f in ff.collect_at(hx, hy, C.SNAKE_HEAD_RADIUS):
            eaten += 1
            score += int(f.value * eff.score_multiplier())
            sn.grow(f.grow)
            ps.burst(f.x, f.y, f.color, count=20)
            a.play("bonus" if f.kind != "normal" else "eat")
        ff.ensure(lvl.food_count, avoid=avoid)

        for pu in pf.collect_at(hx, hy, C.SNAKE_HEAD_RADIUS):
            eff.add(pu.kind)
            ps.ring(pu.x, pu.y, pu.color)
            fx.flash(pu.color, 0.5)
            a.play("powerup")

        for ob in obstacles:
            if ob.collides(hx, hy, C.SNAKE_HEAD_RADIUS * 0.7):
                if ob.deadly and sn.invuln <= 0.0 and not eff.has("ghost"):
                    sn.invuln = C.INVULN_AFTER_HIT
                    sn.shrink(C.HIT_LENGTH_PENALTY)
                    fx.shake(12.0)
                    fx.slowmo(0.5, 0.35)
                    ps.burst(hx, hy, theme.hazard, count=30)
                    a.play("hit")
                elif isinstance(ob, obs_mod.Portal):
                    nx, ny = ob.teleport(hx, hy)
                    sn.teleport(nx, ny)
                    a.play("portal")

        if lvl.wrap_walls:
            nx, ny = sn.x, sn.y
            if nx < ARENA.left:
                nx = ARENA.right
            elif nx > ARENA.right:
                nx = ARENA.left
            if ny < ARENA.top:
                ny = ARENA.bottom
            elif ny > ARENA.bottom:
                ny = ARENA.top
            if (nx, ny) != (sn.x, sn.y):
                sn.teleport(nx, ny)

        if ff.count("normal") < lvl.food_count:
            starved += 1

        ps.trail(hx, hy, theme.snake_a, gdt, rate=C.TRAIL_EMIT_RATE)
        ps.ambient(ARENA, theme.accent2, gdt, rate=6.0)
        ps.update(gdt)
        fx.update(DT)  # effects get real, unscaled dt

        # --- draw ---
        # Draw order and clipping exactly as the gameplay scene should do it:
        # background -> arena border -> hazards -> pickups -> snake ->
        # particles -> HUD -> cursor.  draw_snake and ParticleSystem.draw take
        # no rect of their own, so the scene clips them to the arena; every
        # other drawer here confines itself.
        cv.fill((0, 0, 0))
        bg.draw(cv)
        render_mod.draw_arena(cv, ARENA, theme, t)
        obs_mod.draw_obstacles(cv, obstacles, theme, t)
        ff.draw(cv, t)
        pf.draw(cv, t)
        cv.set_clip(ARENA)
        render_mod.draw_snake(cv, sn, theme, t,
                              ghost=eff.has("ghost"), shield=eff.has("shield"))
        ps.draw(cv)
        cv.set_clip(None)
        ui_mod.draw_hud(cv, game, {
            "score": score, "highscore": 41200, "level_name": lvl.name,
            "level_index": lvl.index, "goal_food": lvl.goal_food,
            "food_eaten": eaten, "lives": 3, "combo": 2,
            "boost": sn.boost, "boost_max": C.SNAKE_BOOST_MAX,
            "effects": eff.items(),
        }, theme, t)
        ui_mod.draw_cursor(cv, game)
        fx.present(cv, screen)

    return (sn, ff, pf, eff, ps, obstacles, eaten, score, starved)


def test_full_frame() -> None:
    import time

    fonts = FontBook()
    cv = canvas()
    screen = pygame.Surface(C.WINDOW_SIZE).convert()

    total_eaten = 0
    for lvl in level_mod.LEVELS:
        t0 = time.perf_counter()
        (sn, ff, pf, eff, ps, obstacles,
         eaten, score, starved) = _play_level(lvl, 180, fonts, cv, screen)
        ms = (time.perf_counter() - t0) * 1000.0 / 180.0
        total_eaten += eaten

        ok = True
        detail = []
        if not (math.isfinite(sn.x) and math.isfinite(sn.y)):
            ok, _ = False, detail.append("head not finite")
        if not ARENA.inflate(60, 60).collidepoint(int(sn.x), int(sn.y)):
            ok = False
            detail.append(f"head escaped arena at ({sn.x:.0f},{sn.y:.0f})")
        if ps.count() > C.MAX_PARTICLES:
            ok = False
            detail.append(f"particle cap breached ({ps.count()})")
        # A crowded arena may miss a restock for a frame or two, but a level
        # that is starved most of the time cannot be finished.
        if starved > 90:
            ok = False
            detail.append(f"food under-stocked on {starved}/180 frames")
        check(f"L{lvl.index + 1:02d} {lvl.name:<16} 180 frames, "
              f"{len(obstacles):2d} hazards, {ms:5.2f} ms/frame, ate {eaten}",
              ok, "; ".join(detail))
        if ms > 16.67:
            _notes.append(f"L{lvl.index + 1} frame cost {ms:.2f} ms "
                          f"exceeds the 16.67 ms budget")

    check("food was eaten somewhere across the campaign", total_eaten > 0,
          f"total={total_eaten}")

    # One long run on the hardest level, the way a real session looks.
    t0 = time.perf_counter()
    (sn, ff, pf, eff, ps, obstacles,
     eaten, score, starved) = _play_level(level_mod.LEVELS[11], 600,
                                          fonts, cv, screen)
    ms = (time.perf_counter() - t0) * 1000.0 / 600.0
    check("600-frame run on Prism Core ran clean", True)
    check("score accumulated", score >= 0)
    check("snake survived / stayed finite",
          math.isfinite(sn.x) and math.isfinite(sn.y))
    _notes.append(f"Prism Core 600 frames: {ms:.2f} ms/frame headless, "
                  f"ate {eaten}, scored {score}, "
                  f"length {len(sn.segments)}, particles {ps.count()}")


# ==========================================================================
# 13. Layout contract: the HUD strip and the arena must stay disjoint
# ==========================================================================
#
# ARENA_Y == HUD_H, so the arena's top edge *is* the bottom of the HUD strip -
# there is no gap to absorb an additive halo.  Anything that blooms across that
# line shows up as a bright band through the translucent HUD panel, whichever
# order the two are drawn in.  Every arena-owned drawer therefore clips itself.
# ==========================================================================
BGP = (7, 9, 11)


def _painted_outside(surf: pygame.Surface, region: pygame.Rect,
                     step: int = 2) -> List[Tuple[int, int]]:
    return [(x, y)
            for y in range(0, C.WINDOW_H, step)
            for x in range(0, C.WINDOW_W, step)
            if not region.collidepoint(x, y) and surf.get_at((x, y))[:3] != BGP]


def test_layout_contract() -> None:
    fonts = FontBook()
    theme = P.THEMES[0]
    strip = pygame.Rect(0, 0, C.WINDOW_W, C.HUD_H)
    check("the arena starts exactly where the HUD strip ends",
          C.ARENA_Y == C.HUD_H, f"ARENA_Y={C.ARENA_Y} HUD_H={C.HUD_H}")

    class _FakeGame:
        pass
    g = _FakeGame()
    g.mouse_pos = (640.0, 400.0)
    g.mouse_buttons = {1: False, 2: False, 3: False}
    g.cursor_trail = []
    g.level_index = 0
    g.fonts = fonts
    g.time = 1.0
    state = {"score": 13480, "highscore": 41200, "level_name": "Neon Grid",
             "level_index": 0, "goal_food": 16, "food_eaten": 9, "lives": 3,
             "combo": 5, "boost": 61.0, "boost_max": C.SNAKE_BOOST_MAX,
             "effects": [("shield", 4.2), ("magnet", 2.0), ("double", 6.8)]}

    # -- draw_hud stays in the strip --------------------------------------
    s = canvas()
    s.fill(BGP)
    ui_mod.draw_hud(s, g, state, theme, 1.0)
    out = _painted_outside(s, strip)
    check("draw_hud paints nothing below the HUD strip", not out,
          f"{len(out)} px, lowest y={max((y for _, y in out), default=0)}")

    # -- draw_arena stays out of the strip --------------------------------
    s.fill(BGP)
    render_mod.draw_arena(s, ARENA, theme, 1.0)
    into = [(x, y) for x, y in _painted_outside(s, ARENA) if y < C.HUD_H]
    check("draw_arena paints nothing inside the HUD strip", not into,
          f"{len(into)} px, highest y={min((y for _, y in into), default=0)}")

    # -- HUD over arena must be identical to HUD alone ---------------------
    a = canvas()
    a.fill(BGP)
    ui_mod.draw_hud(a, g, state, theme, 1.0)
    b = canvas()
    b.fill(BGP)
    render_mod.draw_arena(b, ARENA, theme, 1.0)
    ui_mod.draw_hud(b, g, state, theme, 1.0)
    worst = 0
    for y in range(0, C.HUD_H, 2):
        for x in range(0, C.WINDOW_W, 2):
            pa, pb = a.get_at((x, y))[:3], b.get_at((x, y))[:3]
            worst = max(worst, max(abs(pa[i] - pb[i]) for i in range(3)))
    check("the arena never bleeds through the HUD panel", worst == 0,
          f"worst channel delta={worst}")

    # -- backgrounds, obstacles, food and power-ups stay in the arena ------
    for i, th in enumerate(P.THEMES):
        s.fill(BGP)
        bg = bg_mod.make_background(th.bg_style, th, ARENA)
        for _ in range(20):
            bg.update(DT)
        bg.draw(s)
        if _painted_outside(s, ARENA, 3):
            _failures.append(f"background '{th.bg_style}' paints outside the arena")
    check("all 12 backgrounds stay inside the arena", True)

    for L in level_mod.LEVELS:
        obs = obs_mod.build_obstacles(L.obstacle_spec, ARENA)
        if any(o.arena is None for o in obs):
            _failures.append(f"L{L.index + 1}: build_obstacles left .arena unset")
        s.fill(BGP)
        t = 0.0
        for _ in range(120):
            t += DT
            for o in obs:
                o.update(DT, t)
            obs_mod.draw_obstacles(s, obs, L.theme, t)
        bad = _painted_outside(s, ARENA)
        if bad:
            _failures.append(f"L{L.index + 1}: {len(bad)} obstacle px outside the arena")
    check("all hazards on all 12 levels stay inside the arena", True)

    # Orbs and runes jammed hard against the arena edge, where their halos
    # would otherwise reach ~60 px into the HUD.
    s.fill(BGP)
    ff = food_mod.FoodField(ARENA, theme)
    ff.items = [food_mod.make_food(ARENA.left + 2, ARENA.top + 2, "mega", 0.0, theme),
                food_mod.make_food(ARENA.centerx, ARENA.top + 1, "bonus", 0.0, theme),
                food_mod.make_food(ARENA.right - 2, ARENA.bottom - 2, "mega", 0.0, theme)]
    ff.draw(s, 1.0)
    check("food orbs on the arena edge stay inside it",
          not _painted_outside(s, ARENA))

    s.fill(BGP)
    pf = pw_mod.PowerUpField(ARENA, theme)
    pf.items = [pw_mod.PowerUp(ARENA.centerx, ARENA.top + 2, "shield", 0.0, 11.0),
                pw_mod.PowerUp(ARENA.left + 2, ARENA.bottom - 2, "frenzy", 0.0, 11.0)]
    for _ in range(30):
        pf.update(DT, 1.0)
    pf.draw(s, 1.0)
    check("power-up runes on the arena edge stay inside it",
          not _painted_outside(s, ARENA))

    # -- every drawer must hand the caller's clip rect back untouched ------
    # main.py does `canvas.fill((0,0,0))` each frame; a leaked clip would make
    # that fill a no-op for the rest of the run.
    sn = snake_mod.Snake(ARENA.centerx, ARENA.centery, length=12)
    for _ in range(60):
        sn.set_target(ARENA.centerx + 200.0, ARENA.centery)
        sn.update(DT)
    obs = obs_mod.build_obstacles(level_mod.LEVELS[11].obstacle_spec, ARENA)
    bg = bg_mod.make_background(theme.bg_style, theme, ARENA)
    ps = part_mod.ParticleSystem(200)
    ps.burst(640, 400, theme.food, count=30)
    sentinel = pygame.Rect(11, 13, 501, 307)
    drawers = [
        ("background.draw", lambda: bg.draw(s)),
        ("draw_arena", lambda: render_mod.draw_arena(s, ARENA, theme, 1.0)),
        ("draw_obstacles", lambda: obs_mod.draw_obstacles(s, obs, theme, 1.0)),
        ("FoodField.draw", lambda: ff.draw(s, 1.0)),
        ("PowerUpField.draw", lambda: pf.draw(s, 1.0)),
        ("draw_snake", lambda: render_mod.draw_snake(s, sn, theme, 1.0)),
        ("particles.draw", lambda: ps.draw(s)),
        ("draw_hud", lambda: ui_mod.draw_hud(s, g, state, theme, 1.0)),
        ("draw_cursor", lambda: ui_mod.draw_cursor(s, g)),
    ]
    for name, fn in drawers:
        s.set_clip(sentinel)
        fn()
        if s.get_clip() != sentinel:
            _failures.append(f"{name} did not restore the caller's clip rect "
                             f"({s.get_clip()} != {sentinel})")
    s.set_clip(None)
    check("every drawer restores the caller's clip rect", True)

    # -- and every drawer must honour a clip the caller sets ---------------
    # This is the pattern the gameplay scene needs for the two drawers that
    # take no rect of their own: draw_snake and ParticleSystem.draw.
    s.fill(BGP)
    s.set_clip(ARENA)
    edge = snake_mod.Snake(ARENA.centerx, ARENA.top + 4, heading=0.0, length=30)
    for _ in range(80):
        edge.set_target(ARENA.centerx + 400.0, ARENA.top + 4)
        edge.update(DT)
    render_mod.draw_snake(s, edge, theme, 1.0, shield=True)
    ps.clear()
    for _ in range(40):
        ps.burst(ARENA.centerx, ARENA.top + 3, theme.snake_a, count=20)
        ps.update(DT)
    ps.draw(s)
    s.set_clip(None)
    leaked = _painted_outside(s, ARENA)
    check("snake + particles obey a scene-set arena clip", not leaked,
          f"{len(leaked)} px escaped")


# ==========================================================================
# Driver
# ==========================================================================
def main() -> int:
    print("=" * 68)
    print("NEON SERPENT - headless module smoke test")
    print(f"pygame {pygame.version.ver}  python {sys.version.split()[0]}")
    print("=" * 68)

    section("snake entity", test_snake)
    section("food", test_food)
    section("power-ups", test_powerups)
    section("levels + obstacles", test_levels_and_obstacles)
    section("backgrounds", test_backgrounds)
    section("particles", test_particles)
    section("effects", test_effects)
    section("render", test_render)
    section("ui", test_ui)
    section("audio", test_audio)
    section("save", test_save)
    section("layout contract (HUD strip vs arena)", test_layout_contract)
    section("full integrated frame", test_full_frame)

    print("\n" + "=" * 68)
    for n in _notes:
        print(f"  note: {n}")
    if _failures:
        print(f"\n{len(_failures)} FAILURE(S):")
        for f in _failures:
            print(f"  - {f}")
        print("=" * 68)
        return 1
    print("\nALL SMOKE TESTS PASSED")
    print("=" * 68)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
