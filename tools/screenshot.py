"""
Render one frame of every screen in NEON SERPENT to a PNG.

Runs headless (dummy SDL drivers) and writes to ``captures/`` so the whole game
can be eyeballed without a display: the five menu-ish scenes, the pause overlay,
both result screens, and all twelve levels mid-play.

Each capture is also measured, because a headless renderer that quietly draws
nothing still produces a perfectly valid PNG.  For every image we report the
per-channel standard deviation, the number of distinct colours and the fraction
of near-black pixels; a capture only counts as "non-trivial" if it has real
contrast *and* real colour variety.  Statistics are taken on a 1-in-4 pixel
subsample, which is plenty for spotting a blank frame and keeps the whole run
under a couple of seconds per image.

Usage
-----
    python tools/screenshot.py
    python tools/screenshot.py --out somewhere/else
Exit code 0 means every capture passed the non-triviality test.
"""

from __future__ import annotations

import argparse
import os
import sys
from collections import Counter
from typing import Any, Callable, Dict, List, Optional, Tuple

os.environ.setdefault("SDL_VIDEODRIVER", "dummy")
os.environ.setdefault("SDL_AUDIODRIVER", "dummy")

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

import pygame  # noqa: E402

from snake import config as C  # noqa: E402
from snake.core.level import LEVEL_COUNT, get_level  # noqa: E402

DT = 1.0 / float(C.FPS)

#: A capture must beat all three of these to count as showing something.
MIN_STDDEV = 8.0            # per-channel contrast
MIN_COLOURS = 64            # distinct RGB triples in the subsample
MAX_DARK_FRACTION = 0.98    # share of pixels that may be near-black

SUBSAMPLE = 4               # every Nth pixel, for the statistics only


# ==========================================================================
# Measurement
# ==========================================================================
class Stats:
    """Cheap contrast / variety measurements for one rendered frame."""

    __slots__ = ("std", "mean", "colours", "dark", "ok")

    def __init__(self, std: Tuple[float, float, float],
                 mean: Tuple[float, float, float],
                 colours: int, dark: float) -> None:
        self.std = std
        self.mean = mean
        self.colours = colours
        self.dark = dark
        self.ok = (max(std) >= MIN_STDDEV
                   and colours >= MIN_COLOURS
                   and dark <= MAX_DARK_FRACTION)

    @property
    def worst_std(self) -> float:
        return min(self.std)

    @property
    def best_std(self) -> float:
        return max(self.std)


def measure(surface: pygame.Surface) -> Stats:
    """Per-channel mean/stddev, distinct-colour count and dark fraction."""
    raw = pygame.image.tostring(surface, "RGB")
    reds = raw[0::3][::SUBSAMPLE]
    greens = raw[1::3][::SUBSAMPLE]
    blues = raw[2::3][::SUBSAMPLE]
    n = max(1, len(reds))

    means: List[float] = []
    stds: List[float] = []
    for channel in (reds, greens, blues):
        hist = Counter(channel)
        total = float(sum(hist.values())) or 1.0
        mean = sum(v * c for v, c in hist.items()) / total
        var = sum(c * (v - mean) ** 2 for v, c in hist.items()) / total
        means.append(mean)
        stds.append(var ** 0.5)

    triples = set(zip(reds, greens, blues))
    dark = sum(1 for r, g, b in zip(reds, greens, blues)
               if r + g + b < 24) / float(n)

    return Stats((stds[0], stds[1], stds[2]),
                 (means[0], means[1], means[2]),
                 len(triples), dark)


# ==========================================================================
# Driver
# ==========================================================================
class Shooter:
    """Boots one Game and renders scenes into it on demand."""

    def __init__(self, out_dir: str) -> None:
        self.out_dir = out_dir
        os.makedirs(out_dir, exist_ok=True)

        # Keep the player's real progress out of it, but hand the capture run a
        # save file that has everything unlocked so the level grid looks alive.
        self._real_save = C.SAVE_PATH
        C.SAVE_PATH = os.path.join(out_dir, "screenshot-save.json")
        from snake.main import Game
        self.game = Game(headless=True)
        C.SAVE_PATH = self._real_save

        self._seed_save()
        self.results: List[Tuple[str, Stats, str]] = []

    def _seed_save(self) -> None:
        """Plausible progress, so stars and best scores are not all blank."""
        save = self.game.save
        save.unlock_through(LEVEL_COUNT - 1)
        for i in range(LEVEL_COUNT):
            level = get_level(i)
            one, two, three = level.star_targets()
            if i < 8:
                stars = 3 if i % 3 == 0 else (2 if i % 3 == 1 else 1)
                score = (three, two, one)[3 - stars]
                save.record(i, int(score * 1.02), stars)
        save.highscore = 4210

    # -- frame plumbing --------------------------------------------------
    def step(self, n: int = 1, mouse: Optional[Tuple[float, float]] = None,
             pilot: Optional[Callable[[], None]] = None) -> None:
        for _ in range(int(n)):
            if mouse is not None:
                self.game.mouse_pos = mouse
            if pilot is not None:
                pilot()
            self.game.update(DT)
            self.game.draw()

    def shoot(self, name: str, note: str = "") -> None:
        """Render one more frame *with* the cursor and write it out."""
        game = self.game
        # `Game.draw` skips the reticle in headless mode; the reticle is a real
        # part of the look of a mouse-driven game, so put it back for the shot.
        game.headless = False
        # Nothing ever called clock.tick() here, so the corner read-out would
        # say "0.0 fps"; the captures are meant to look like the running game.
        game.fps = float(C.FPS)
        try:
            game.update(DT)
            game.draw()
        finally:
            game.headless = True

        path = os.path.join(self.out_dir, name + ".png")
        pygame.image.save(game.screen, path)
        stats = measure(game.screen)
        self.results.append((name, stats, note))
        print("  {:<26} std {:>6.2f}/{:>6.2f}/{:>6.2f}  colours {:>6}  "
              "dark {:>5.1%}  {}".format(
                  name + ".png", stats.std[0], stats.std[1], stats.std[2],
                  stats.colours, stats.dark, "ok" if stats.ok else "TRIVIAL"),
              flush=True)

    def settle(self, frames: int = 40,
               mouse: Optional[Tuple[float, float]] = None) -> None:
        """Run past the scene transition wipe so the shot is not half-wiped."""
        self.step(frames, mouse=mouse)


# ==========================================================================
# A tiny pilot, so the level shots have a snake that has actually moved
# ==========================================================================
def make_pilot(game: Any) -> Callable[[], None]:
    import math

    def drive() -> None:
        scene = game.scene
        snake = getattr(scene, "snake", None)
        field = getattr(scene, "food", None)
        if snake is None or field is None:
            return
        orb = field.nearest(snake.x, snake.y)
        if orb is None:
            tx, ty = scene.arena.centerx, scene.arena.centery
        else:
            tx, ty = orb.x, orb.y
        ang = math.atan2(ty - snake.y, tx - snake.x)
        game.mouse_pos = (snake.x + math.cos(ang) * 200.0,
                          snake.y + math.sin(ang) * 200.0)

    return drive


# ==========================================================================
# The capture script
# ==========================================================================
def capture_all(shot: Shooter) -> None:
    game = shot.game
    pilot = make_pilot(game)

    print("\nscenes")
    print("-" * 78)

    from snake.core import story as S

    # -- menu ---------------------------------------------------------------
    game.switch_scene(C.SCENE_MENU)
    shot.settle(70, mouse=(640.0, 300.0))
    shot.shoot("01-menu", "title screen, PLAY hovered")

    # -- mode select (v2) ---------------------------------------------------
    # Seeded progress so the screen shows its resume caption and the
    # RESTART STORY footnote rather than its blank first-run face.
    game.save.set_story_progress(4)
    game.mode = C.MODE_STORY
    game.switch_scene(C.SCENE_MODE)
    shot.settle(80, mouse=(320.0, 190.0))
    shot.shoot("02-mode-select", "story vs free play, STORY card hovered")

    # -- level select -------------------------------------------------------
    game.switch_scene(C.SCENE_LEVELS)
    shot.settle(90, mouse=(430.0, 330.0))
    shot.shoot("03-level-select", "campaign grid, tile 6 hovered")

    # -- settings (v2) ------------------------------------------------------
    # Pin the difficulty first: the row prints the *selected* chip's briefing,
    # so a capture that inherits whatever the last run left behind reads as if
    # the wrong chip were lit.  Hover the selected chip for the same reason.
    game.difficulty = C.DIFF_NORMAL
    game.save.set_difficulty(C.DIFF_NORMAL)
    game.switch_scene(C.SCENE_SETTINGS, back=C.SCENE_MENU)
    shot.settle(200, mouse=(343.0, 293.0))
    shot.shoot("04-settings", "display / difficulty / sound / effects")

    # -- story cards (v2) ---------------------------------------------------
    # Two shots, because the presenter has two quite different faces: the
    # chapter plate (huge roman numeral) and an ordinary narrative beat.
    game.switch_scene(C.SCENE_STORY, cards=[S.get_chapter(3), S.get_beat(3)],
                      next_scene=C.SCENE_GAME, next_kwargs={"level_index": 3})
    # CONTINUE is only drawn once the card is fully revealed, so the capture
    # waits for the typewriter instead of guessing a frame count - otherwise
    # the shot shows a screen with no visible primary action.
    wait_for_story(shot, mouse=(640.0, 643.0))
    shot.shoot("05-story-chapter", "chapter plate, roman numeral")
    # Advance to the beat card.  The first click only completes the reveal,
    # so a settled card needs two.
    for _ in range(2):
        click(shot, 640.0, 643.0)
        shot.settle(10, mouse=(640.0, 643.0))
    wait_for_story(shot, mouse=(640.0, 643.0))
    shot.shoot("06-story-card", "narrative beat, typewriter settled")

    # -- help ---------------------------------------------------------------
    game.switch_scene(C.SCENE_HELP)
    shot.settle(120, mouse=(640.0, 660.0))
    shot.shoot("07-help", "how to play, live demo snake")

    # -- gameplay: the READY card ------------------------------------------
    game.switch_scene(C.SCENE_GAME, level_index=0)
    shot.settle(30, mouse=(700.0, 420.0))
    shot.shoot("08-gameplay-ready", "level 1 countdown card")

    # -- pause overlay ------------------------------------------------------
    game.switch_scene(C.SCENE_GAME, level_index=5)
    game.scene.ready_timer = 0.0
    shot.step(150, pilot=pilot)
    game.push_scene(C.SCENE_PAUSE)
    shot.settle(40, mouse=(640.0, 300.0))
    shot.shoot("09-pause", "pause overlay over a live level 6")

    # -- results ------------------------------------------------------------
    game.last_result = {
        "score": 305, "level_index": 3, "level_name": "Solar Flare",
        "food_eaten": 9, "goal_food": 14, "stars": 0, "new_best": False,
        "won": False, "elapsed": 61.4, "max_combo": 4, "deaths": 3,
        "mode": C.MODE_FREE, "story": False, "next_index": 4,
        "final_level": False, "difficulty": C.DIFF_NORMAL,
    }
    game.switch_scene(C.SCENE_GAMEOVER)
    shot.settle(120, mouse=(430.0, 630.0))
    shot.shoot("10-gameover", "game over, counters settled")

    game.last_result = {
        "score": 486, "level_index": 3, "level_name": "Solar Flare",
        "food_eaten": 14, "goal_food": 14, "stars": 3, "new_best": True,
        "won": True, "elapsed": 48.9, "max_combo": 8, "deaths": 0,
        "mode": C.MODE_FREE, "story": False, "next_index": 4,
        "final_level": False, "difficulty": C.DIFF_NORMAL,
    }
    game.switch_scene(C.SCENE_VICTORY)
    shot.settle(160, mouse=(390.0, 644.0))
    shot.shoot("11-victory", "free-play victory, all three stars popped")

    # The story victory is a different screen (CONTINUE instead of NEXT LEVEL,
    # plus the chapter line), so it earns its own capture.
    game.mode = C.MODE_STORY
    game.last_result = dict(game.last_result, mode=C.MODE_STORY, story=True,
                            beat_title=S.get_beat(3).title,
                            chapter=S.get_chapter(3).number,
                            chapter_title=S.get_chapter(3).title,
                            chapter_roman=S.get_chapter(3).roman)
    game.switch_scene(C.SCENE_VICTORY)
    shot.settle(160, mouse=(346.0, 644.0))
    shot.shoot("12-victory-story", "story victory, CONTINUE offered")

    game.mode = C.MODE_FREE
    game.last_result = dict(game.last_result,
                            mode=C.MODE_FREE, story=False,
                            level_index=LEVEL_COUNT - 1,
                            level_name=get_level(LEVEL_COUNT - 1).name,
                            score=980, goal_food=30, food_eaten=30,
                            next_index=LEVEL_COUNT, final_level=True)
    game.switch_scene(C.SCENE_VICTORY)
    shot.settle(160, mouse=(640.0, 644.0))
    shot.shoot("13-victory-final", "campaign complete screen")

    # -- one level per difficulty (v2) --------------------------------------
    # The difficulty is meant to change how a level *looks* in play as well as
    # how it feels: a different life count in the HUD, a different snake speed
    # and, on EASY, a body that may cross itself.
    print("\ndifficulties")
    print("-" * 78)
    game.mode = C.MODE_FREE
    for key, index in ((C.DIFF_EASY, 0), (C.DIFF_NORMAL, 3),
                       (C.DIFF_HARD, 7), (C.DIFF_EXPERT, LEVEL_COUNT - 1)):
        game.difficulty = key
        game.save.set_difficulty(key)
        level = get_level(index)
        play_level(shot, pilot, index, frames=170)
        shot.shoot("diff-{}-level-{:02d}".format(key, index + 1),
                   "{} on {}".format(level.name, key.upper()))
    game.difficulty = C.DEFAULT_DIFFICULTY
    game.save.set_difficulty(C.DEFAULT_DIFFICULTY)

    # -- the twelve levels --------------------------------------------------
    print("\nlevels")
    print("-" * 78)
    for index in range(LEVEL_COUNT):
        level = get_level(index)
        # ~2.5 s of piloted play: enough for the snake to have grown a little,
        # the hazards to be mid-cycle and some particles to be alive.
        play_level(shot, pilot, index, frames=150)
        slug = "".join(ch.lower() if ch.isalnum() else "-" for ch in level.name)
        shot.shoot("level-{:02d}-{}".format(index + 1, slug.strip("-")),
                   level.subtitle)


def click(shot: Shooter, x: float, y: float) -> None:
    """
    Post a full press/release at (x, y) and let the scene consume it.

    ``Shooter.step`` deliberately does not pump the event queue - every other
    capture is driven by setting ``mouse_pos`` directly - so the pump has to
    happen here or the posted events would sit in the queue unread.
    """
    game = shot.game
    game.mouse_pos = (x, y)
    for kind in (pygame.MOUSEBUTTONDOWN, pygame.MOUSEBUTTONUP):
        pygame.event.post(pygame.event.Event(
            kind, {"pos": (int(x), int(y)), "button": 1}))
        game._pump_events()
        shot.step(2, mouse=(x, y))


def wait_for_story(shot: Shooter, mouse: Tuple[float, float],
                   limit: int = 900) -> bool:
    """Step until the story card has finished typing itself out."""
    for _ in range(int(limit)):
        if getattr(shot.game.scene, "done", False):
            shot.step(12, mouse=mouse)     # let CONTINUE fade in
            return True
        shot.step(1, mouse=mouse)
    return False


def play_level(shot: Shooter, pilot: Callable[[], None], index: int,
               frames: int) -> None:
    """Enter a level, spend the countdown and fly it for `frames` frames."""
    game = shot.game
    game.switch_scene(C.SCENE_GAME, level_index=index)
    game.scene.ready_timer = 0.0
    shot.step(frames, pilot=pilot)
    if type(game.scene).__name__ != "GameplayScene":
        # The pilot cleared it (or died); drop back in for the shot.
        game.switch_scene(C.SCENE_GAME, level_index=index)
        game.scene.ready_timer = 0.0
        shot.step(40, pilot=pilot)
    pilot()


def prune(out_dir: str) -> List[str]:
    """
    Delete PNGs this tool wrote under a previous numbering.

    v2 inserted three screens into the middle of the sequence, so every shot
    after the menu was renumbered.  Without this the capture directory would
    keep both layouts side by side and it would be impossible to tell which
    PNG came from the current build.  Only this tool's own namespace is
    touched: ``NN-*.png``, ``level-*.png`` and ``diff-*.png``.
    """
    removed: List[str] = []
    try:
        names = sorted(os.listdir(out_dir))
    except OSError:
        return removed
    for name in names:
        if not name.lower().endswith(".png"):
            continue
        stem = name[:-4]
        ours = (stem[:2].isdigit() and stem[2:3] == "-") \
            or stem.startswith("level-") or stem.startswith("diff-")
        if not ours:
            continue
        try:
            os.remove(os.path.join(out_dir, name))
            removed.append(name)
        except OSError:
            pass
    return removed


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Render every screen to PNG")
    parser.add_argument("--out", default=os.path.join(_ROOT, "captures"),
                        help="output directory")
    args = parser.parse_args(argv)

    shot = Shooter(args.out)
    print("writing to {}".format(args.out))
    stale = prune(args.out)
    if stale:
        print("  removed {} capture(s) from a previous layout: {}".format(
            len(stale), ", ".join(stale[:6]) + ("..." if len(stale) > 6 else "")))
    capture_all(shot)

    print("\n" + "=" * 78)
    print("VARIANCE TABLE  (statistics on a 1-in-{} pixel subsample)".format(
        SUBSAMPLE))
    print("=" * 78)
    print("  {:<28} {:>7} {:>7} {:>7} {:>8} {:>7}  {}".format(
        "capture", "std R", "std G", "std B", "colours", "dark", "verdict"))
    print("  " + "-" * 74)
    trivial: List[str] = []
    for name, stats, _note in shot.results:
        print("  {:<28} {:>7.2f} {:>7.2f} {:>7.2f} {:>8} {:>6.1%}  {}".format(
            name, stats.std[0], stats.std[1], stats.std[2],
            stats.colours, stats.dark, "ok" if stats.ok else "TRIVIAL"))
        if not stats.ok:
            trivial.append(name)

    print("")
    print("  {} captures, {} trivial".format(len(shot.results), len(trivial)))
    print("  thresholds: best-channel std >= {}, colours >= {}, "
          "dark <= {:.0%}".format(MIN_STDDEV, MIN_COLOURS, MAX_DARK_FRACTION))
    print("  RESULT: " + ("PASS" if not trivial else
                          "FAIL - " + ", ".join(trivial)))

    pygame.quit()
    return 0 if not trivial else 1


if __name__ == "__main__":
    raise SystemExit(main())
