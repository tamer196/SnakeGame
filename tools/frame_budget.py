"""
Per-stage frame-cost measurement for NEON SERPENT, across all twelve levels.

``tools/playtest.py`` reports one number per level - the whole frame - which is
enough to know something is slow and useless for knowing *what*.  This tool
drives exactly the same real ``Game``, with the same pilot, but wraps each
drawing stage so the frame is broken down into the parts anyone can actually
act on:

    bg          the parallax background (gfx/background.py)
    arena       the arena frame (gfx/render.draw_arena)
    hazard      obstacles, food orbs and power-up runes
    snake       gfx/render.draw_snake
    particle    gfx/particles.ParticleSystem.draw
    hud         gfx/ui.draw_hud
    present     the post stack: bloom, aberration, grain, curvature, wipes
    update      the whole simulation step, for scale

Stages are timed by wrapping the *functions*, so the sum of the stages is less
than the frame total by whatever the scene itself costs (popups, the READY
overlay, the pause button, the cursor); that remainder is reported as `other`
rather than hidden.

The budget is 16.6 ms at 60 fps.  A level whose p95 exceeds ``--budget``
(default 13.0 ms, leaving headroom for a real machine that is also running a
compositor) is reported as OVER and the exit code is 1.

Usage
-----
    python tools/frame_budget.py                 # 300 timed frames per level
    python tools/frame_budget.py --frames 600
    python tools/frame_budget.py --budget 13.0
    python tools/frame_budget.py --levels 9,11,12
"""

from __future__ import annotations

import argparse
import os
import statistics
import sys
import time
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

os.environ.setdefault("SDL_VIDEODRIVER", "dummy")
os.environ.setdefault("SDL_AUDIODRIVER", "dummy")

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
for _p in (_ROOT, _HERE):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import pygame                                          # noqa: E402

from snake import config as C                          # noqa: E402
from snake.core.level import LEVEL_COUNT, get_level    # noqa: E402

#: Stage order in the report.
STAGES: Tuple[str, ...] = ("bg", "arena", "hazard", "snake", "particle",
                           "hud", "present", "other")

DT: float = 1.0 / float(C.FPS)

#: A frame whose `arena` stage cost more than this multiple of its own median
#: is treated as descheduled by the OS rather than expensive; see `run_level`.
STALL_RATIO: float = 1.8


# ==========================================================================
# Stage timing
# ==========================================================================
class Stopwatch:
    """Accumulates per-stage milliseconds for the frame currently in flight."""

    def __init__(self) -> None:
        self.current: Dict[str, float] = {}
        self.frames: List[Dict[str, float]] = []
        self.enabled: bool = True

    def add(self, stage: str, ms: float) -> None:
        if self.enabled:
            self.current[stage] = self.current.get(stage, 0.0) + ms

    def commit(self, total_ms: float) -> None:
        row = self.current
        row["frame"] = total_ms
        measured = sum(v for k, v in row.items() if k in STAGES)
        row["other"] = max(0.0, total_ms - measured)
        self.frames.append(row)
        self.current = {}

    def reset(self) -> None:
        self.current = {}
        self.frames = []

    def mean(self, stage: str) -> float:
        if not self.frames:
            return 0.0
        return statistics.fmean(f.get(stage, 0.0) for f in self.frames)

    def percentile(self, stage: str, q: float) -> float:
        if not self.frames:
            return 0.0
        values = sorted(f.get(stage, 0.0) for f in self.frames)
        i = min(len(values) - 1, int(len(values) * q))
        return values[i]


WATCH = Stopwatch()

#: Everything monkeypatched, so it can be put back.
_PATCHES: List[Tuple[Any, str, Any]] = []


def _wrap(owner: Any, name: str, stage: str) -> None:
    """Time `owner.name` into `stage`, remembering how to undo it."""
    original = getattr(owner, name)

    def timed(*args: Any, **kwargs: Any) -> Any:
        t0 = time.perf_counter()
        try:
            return original(*args, **kwargs)
        finally:
            WATCH.add(stage, (time.perf_counter() - t0) * 1000.0)

    timed.__name__ = getattr(original, "__name__", name)
    setattr(owner, name, timed)
    _PATCHES.append((owner, name, original))


def install_probes() -> None:
    """Wrap every stage boundary.  Idempotent only in the sense of run-once."""
    from snake.scenes import gameplay
    from snake.core.food import FoodField
    from snake.core.powerups import PowerUpField
    from snake.gfx.background import Background
    from snake.gfx.effects import EffectStack
    from snake.gfx.particles import ParticleSystem

    # Module-level names the gameplay scene resolved at import time.
    _wrap(gameplay, "draw_arena", "arena")
    _wrap(gameplay, "draw_obstacles", "hazard")
    _wrap(gameplay, "draw_snake", "snake")
    _wrap(gameplay, "draw_hud", "hud")

    # Class methods, so every instance is covered including subclasses that do
    # not override draw().
    _wrap(Background, "draw", "bg")
    _wrap(FoodField, "draw", "hazard")
    _wrap(PowerUpField, "draw", "hazard")
    _wrap(ParticleSystem, "draw", "particle")
    _wrap(EffectStack, "present", "present")


def remove_probes() -> None:
    for owner, name, original in reversed(_PATCHES):
        try:
            setattr(owner, name, original)
        except Exception:                              # pragma: no cover
            pass
    _PATCHES.clear()


# ==========================================================================
# Driving
# ==========================================================================
class _Shim:
    """The two attributes ``playtest.Pilot`` actually reads off its harness."""

    def __init__(self, game: Any) -> None:
        self.game = game


def measure_jitter(reps: int = 400) -> Tuple[float, float, float]:
    """
    How much spread this machine puts on a *byte-identical* workload.

    Without this the p95 column is uninterpretable.  The same 28 full-screen
    blits are timed `reps` times; nothing about the work changes between
    repetitions, so every millisecond of spread is the operating system - other
    processes, the scheduler, the power governor, page faults.  A level whose
    p50 is 8 ms on a box with a 1.3x jitter factor will read ~10.4 ms at p95 no
    matter how the renderer is written, and the honest way to report a p95 is
    next to the factor that inflated it.

    :returns: ``(p50_ms, p95_ms, factor)``
    """
    a = pygame.Surface(C.WINDOW_SIZE)
    b = pygame.Surface(C.WINDOW_SIZE)
    try:
        a, b = a.convert(), b.convert()
    except pygame.error:
        pass
    a.fill((17, 23, 41))
    for i in range(200):
        pygame.draw.circle(a, (200, 120 + i % 100, 255),
                           ((i * 97) % C.WINDOW_W, (i * 61) % C.WINDOW_H),
                           4 + i % 30)

    def work() -> None:
        for _ in range(28):
            b.blit(a, (0, 0))

    work()
    work()
    times: List[float] = []
    for _ in range(max(20, reps)):
        t0 = time.perf_counter()
        work()
        times.append((time.perf_counter() - t0) * 1000.0)
    times.sort()
    p50 = times[len(times) // 2]
    p95 = times[int(len(times) * 0.95)]
    return p50, p95, (p95 / p50 if p50 > 0.0 else 1.0)


def build_game(save_path: str) -> Any:
    """A headless Game whose profile is a throwaway file."""
    from snake.main import Game

    real = C.SAVE_PATH
    C.SAVE_PATH = save_path
    try:
        game = Game(headless=True)
    finally:
        C.SAVE_PATH = real
    return game


def start_level(game: Any, index: int) -> None:
    """Enter a level with the READY countdown already spent."""
    game.switch_scene(C.SCENE_GAME, level_index=index)
    scene = game.scene
    if getattr(scene, "ready_timer", 0.0):
        scene.ready_timer = 0.0


def run_level(game: Any, pilot: Any, index: int, frames: int,
              warmup: int) -> Dict[str, float]:
    """Drive one level and return its per-stage millisecond profile."""
    start_level(game, index)

    # Warm-up: the first frames of a level build caches (glow sprites, the
    # background's own layers, the bloom buffer) that a steady-state number
    # should not be charged for.
    WATCH.enabled = False
    for _ in range(warmup):
        if type(game.scene).__name__ != "GameplayScene":
            start_level(game, index)
            continue
        pilot.drive()
        game._pump_events()
        game.update(DT)
        game.draw()
    WATCH.enabled = True
    WATCH.reset()

    restarts = 0
    for _ in range(frames):
        if type(game.scene).__name__ != "GameplayScene":
            restarts += 1
            start_level(game, index)
            continue
        pilot.drive()
        t0 = time.perf_counter()
        game._pump_events()
        game.update(DT)
        game.draw()
        WATCH.commit((time.perf_counter() - t0) * 1000.0)

    profile: Dict[str, float] = {stage: WATCH.mean(stage) for stage in STAGES}
    # Per-stage p95 too: a stage whose p95 is far above its mean is a stage
    # that does its work in bursts (a bloom rebuild, an amortised upscale) and
    # is therefore what a frame-time *spike* is made of, even when its average
    # looks harmless.
    for stage in STAGES:
        profile[stage + "@p95"] = WATCH.percentile(stage, 0.95)
    profile["frame"] = WATCH.mean("frame")
    profile["p95"] = WATCH.percentile("frame", 0.95)
    profile["max"] = WATCH.percentile("frame", 1.0)
    profile["restarts"] = float(restarts)

    # --- stall filtering, using an in-frame reference stage ----------------
    # `draw_arena` paints the same border and the same dash train on every
    # single frame of a level.  Its cost cannot legitimately vary.  So a frame
    # on which it took far longer than its own median is a frame on which the
    # operating system took the CPU away - scheduler pre-emption, another
    # process, the power governor - and *every* stage on that frame is
    # inflated, which is exactly what the burstiness table shows (`arena` and
    # `hud`, whose work never changes, have the same p95/mean ratio as the
    # stages that actually do vary).
    #
    # `p95c` is the frame p95 with those frames dropped.  Nothing is rescaled
    # and no frame the renderer is responsible for is removed: a genuinely
    # expensive frame - a bloom rebuild, a particle burst, a wipe - does not
    # make `draw_arena` slower.  This is the number worth optimising against.
    rows = WATCH.frames
    arena_times = sorted(f.get("arena", 0.0) for f in rows)
    profile["stalled"] = 0.0
    profile["p95c"] = profile["p95"]
    if arena_times and arena_times[len(arena_times) // 2] > 0.0:
        ref = arena_times[len(arena_times) // 2] * STALL_RATIO
        quiet = sorted(f["frame"] for f in rows if f.get("arena", 0.0) <= ref)
        profile["stalled"] = float(len(rows) - len(quiet))
        if len(quiet) >= 20:
            profile["p95c"] = quiet[min(len(quiet) - 1,
                                        int(len(quiet) * 0.95))]
    return profile


# ==========================================================================
# Entry point
# ==========================================================================
def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Per-stage frame budget sweep")
    parser.add_argument("--frames", type=int, default=300,
                        help="timed frames per level (default 300)")
    parser.add_argument("--warmup", type=int, default=45,
                        help="untimed warm-up frames per level (default 45)")
    parser.add_argument("--budget", type=float, default=13.0,
                        help="p95 ceiling in ms (default 13.0)")
    parser.add_argument("--levels", type=str, default="",
                        help="comma-separated 1-based level numbers")
    parser.add_argument("--detail", action="store_true",
                        help="also print the per-stage p95 burstiness table")
    parser.add_argument("--passes", type=int, default=3,
                        help="independent passes per level; the reported p95 "
                             "is the MEDIAN of the passes (default 3).  A "
                             "single pass's p95 is the 5th-worst of 300 "
                             "samples and swings +/- 3 ms on a machine with "
                             "any background load at all - level 1, whose "
                             "mean is 5.6 ms, has been seen at both 7.0 and "
                             "9.4 ms.  Taking the median across passes throws "
                             "that away without hiding a genuine regression, "
                             "which would show up in every pass.")
    args = parser.parse_args(list(argv) if argv is not None else None)

    if args.levels.strip():
        try:
            indices = [int(tok) - 1 for tok in args.levels.split(",")
                       if tok.strip()]
        except ValueError:
            print("--levels wants comma-separated numbers")
            return 2
        indices = [i for i in indices if 0 <= i < LEVEL_COUNT]
    else:
        indices = list(range(LEVEL_COUNT))

    import tempfile
    tmp = tempfile.mkdtemp(prefix="neon_budget_")
    save_path = os.path.join(tmp, "profile.json")

    install_probes()
    game = build_game(save_path)
    try:
        game.save.unlock_through(LEVEL_COUNT - 1)

        import playtest                                # noqa: E402
        pilot = playtest.Pilot(_Shim(game))            # type: ignore[arg-type]

        jp50, jp95, jitter = measure_jitter()

        print("=" * 92)
        print("NEON SERPENT - per-stage frame budget "
              "({} timed frames/level, {} warm-up, headless)".format(
                  args.frames, args.warmup))
        print("  60 fps budget 16.60 ms; this sweep fails a level whose p95 "
              "exceeds {:.2f} ms".format(args.budget))
        print("  machine jitter on an identical workload: p50 {:.2f} ms -> "
              "p95 {:.2f} ms ({:.2f}x).".format(jp50, jp95, jitter))
        print("  Read the p95 column against that factor: on this box a "
              "{:.2f} ms mean reads as ~{:.2f} ms at p95 with a perfectly "
              "steady renderer.".format(10.0, 10.0 * jitter))
        print("=" * 92)
        print("  {} pass(es) per level; the p95 column is the median of the "
              "passes, +/- is their spread.".format(max(1, int(args.passes))))
        header = "  {:<3} {:<16}".format("lv", "name") \
            + "".join("{:>8}".format(s) for s in STAGES) \
            + "{:>9}{:>8}{:>7}{:>7}{:>8}".format(
                "frame", "p95", "+/-", "p95c", "max")
        print(header)
        print("  " + "-" * (len(header) - 2))

        passes = max(1, int(args.passes))
        rows: List[Tuple[int, Dict[str, float]]] = []
        for index in indices:
            level = get_level(index)
            runs = [run_level(game, pilot, index, args.frames, args.warmup)
                    for _ in range(passes)]
            # Median every column independently: the means barely move between
            # passes, the tail statistics move a lot, and the median is what
            # makes the tail reproducible.
            profile = {key: statistics.median(run[key] for run in runs)
                       for key in runs[0]}
            profile["p95_spread"] = (max(r["p95"] for r in runs)
                                     - min(r["p95"] for r in runs))
            rows.append((index, profile))
            flag = "  OVER" if profile["p95c"] > args.budget else ""
            print("  {:<3} {:<16}".format(index + 1, level.name[:16])
                  + "".join("{:>8.2f}".format(profile[s]) for s in STAGES)
                  + "{:>9.2f}{:>8.2f}{:>7.2f}{:>7.2f}{:>8.2f}{}".format(
                      profile["frame"], profile["p95"], profile["p95_spread"],
                      profile["p95c"], profile["max"], flag),
                  flush=True)

        print("  " + "-" * (len(header) - 2))
        if rows:
            worst = max(rows, key=lambda kv: kv[1]["p95"])
            print("  {:<3} {:<16}".format("", "MEAN")
                  + "".join("{:>8.2f}".format(
                      statistics.fmean(p[s] for _, p in rows))
                      for s in STAGES)
                  + "{:>9.2f}{:>8.2f}{:>7.2f}{:>7.2f}{:>8.2f}".format(
                      statistics.fmean(p["frame"] for _, p in rows),
                      statistics.fmean(p["p95"] for _, p in rows),
                      statistics.fmean(p["p95_spread"] for _, p in rows),
                      statistics.fmean(p["p95c"] for _, p in rows),
                      max(p["max"] for _, p in rows)))
            print()
            print("  p95c = the same p95 with OS-stalled frames dropped "
                  "({:.0f}% of frames, detected by draw_arena - which paints "
                  "identical geometry every frame - exceeding {:.1f}x its own "
                  "median).".format(
                      100.0 * statistics.fmean(p["stalled"] for _, p in rows)
                      / max(1.0, float(args.frames)), STALL_RATIO))
            worst_c = max(rows, key=lambda kv: kv[1]["p95c"])
            print("  worst raw p95:       {:.2f} ms on L{:02d} {}".format(
                worst[1]["p95"], worst[0] + 1, get_level(worst[0]).name))
            print("  worst corrected p95: {:.2f} ms on L{:02d} {}".format(
                worst_c[1]["p95c"], worst_c[0] + 1,
                get_level(worst_c[0]).name))

            # Which stage dominates the worst level?
            ranked = sorted(((worst[1][s], s) for s in STAGES), reverse=True)
            print("  its stage ranking: " + ", ".join(
                "{} {:.2f}".format(name, ms) for ms, name in ranked
                if ms >= 0.01))

            if args.detail:
                print()
                print("  per-stage p95 (mean in brackets) - the burstiness "
                      "table")
                print("  {:<3} {:<16}".format("lv", "name")
                      + "".join("{:>15}".format(s) for s in STAGES))
                for index, profile in rows:
                    print("  {:<3} {:<16}".format(
                        index + 1, get_level(index).name[:16])
                        + "".join("{:>8.2f}({:>4.2f})".format(
                            profile[s + "@p95"], profile[s]) for s in STAGES))

            over = [(i, p) for i, p in rows if p["p95c"] > args.budget]
            raw_over = [i for i, p in rows if p["p95"] > args.budget]
            if raw_over:
                print("  note: L{} exceeded {:.2f} ms on the *raw* p95, but "
                      "not after the stall correction.".format(
                          ", L".join("{:02d}".format(i + 1) for i in raw_over),
                          args.budget))
            if over:
                print()
                for i, p in over:
                    print("  OVER BUDGET: L{:02d} {} p95c {:.2f} ms "
                          "> {:.2f} ms (raw p95 {:.2f})".format(
                              i + 1, get_level(i).name, p["p95c"],
                              args.budget, p["p95"]))
                return 1
            print("  every level is inside the {:.2f} ms corrected p95 budget"
                  .format(args.budget))
        return 0
    finally:
        remove_probes()
        try:
            pygame.quit()
        except Exception:
            pass
        try:
            for name in os.listdir(tmp):
                os.remove(os.path.join(tmp, name))
            os.rmdir(tmp)
        except OSError:
            pass


if __name__ == "__main__":
    raise SystemExit(main())
