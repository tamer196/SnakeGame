"""
Headless end-to-end playtest for NEON SERPENT.

This is not a unit test suite - it boots the *real* ``Game`` with the dummy SDL
drivers and drives it the way a player would: synthetic ``MOUSEMOTION`` /
``MOUSEBUTTONDOWN`` / ``MOUSEBUTTONUP`` / ``KEYDOWN`` events posted into the
pygame queue, a scripted mouse path, and an auto-aim pilot that genuinely eats
food and clears levels.

Why it has to be so paranoid
----------------------------
Every scene wraps its whole frame in ``try/except Exception: pass`` - which is
exactly right for shipping (a bad frame must never kill the game) and exactly
wrong for testing, because a scene that throws on every single frame looks
identical to one that works.  So this driver installs a ``sys.settrace`` hook
that watches the scene entry points (``update`` / ``draw`` / ``handle_event`` /
``on_enter`` / ``on_exit`` and their private bodies) and records any exception
that propagates as far as one of those frame-level guards.  Narrow guards deep
inside a scene - the deliberate "this one call may fail" kind - are not
reported, because the exception never reaches the outer frame.

What it checks, per frame
-------------------------
* nothing raised into a scene's frame-level guard (see above)
* the snake's head position stays finite and inside the world
* no scene leaked a clip rect: the canvas clip is full-surface again by the
  time ``EffectStack.present`` is handed the canvas
* the HUD is never painted over: the top ``C.HUD_H`` rows are byte-identical
  between "just after the gameplay scene finished the HUD strip" and "the end
  of the frame"

Usage
-----
    python tools/playtest.py            # full run
    python tools/playtest.py --quick    # shorter level sweep
Exit code 0 means every check passed.
"""

from __future__ import annotations

import argparse
import math
import os
import random
import statistics
import sys
import time
import traceback
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

# The dummy drivers have to be chosen before pygame initialises anything.
os.environ.setdefault("SDL_VIDEODRIVER", "dummy")
os.environ.setdefault("SDL_AUDIODRIVER", "dummy")

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

import pygame  # noqa: E402

from snake import config as C  # noqa: E402
from snake.core.contracts import TAU, clamp, wrap_angle  # noqa: E402

DT = 1.0 / float(C.FPS)

#: Scene-level entry points worth watching for swallowed exceptions.
_WATCHED_NAMES = frozenset({
    "update", "draw", "handle_event", "on_enter", "on_exit",
    "_update", "_draw", "_draw_impl", "_draw_body", "_update_demo",
    "_draw_demo", "_activate", "_act", "_choose", "_do_launch",
    "_restart", "_go", "_finish", "_collide", "_collect", "_eat",
})


# ==========================================================================
# Reporting
# ==========================================================================
class Report:
    """Collects pass/fail lines so the whole run is reported in one place."""

    def __init__(self) -> None:
        self.lines: List[str] = []
        self.failures: List[str] = []
        self.checks = 0

    def log(self, text: str = "") -> None:
        self.lines.append(text)
        print(text, flush=True)

    def head(self, text: str) -> None:
        self.log("")
        self.log("=" * 78)
        self.log(text)
        self.log("=" * 78)

    def ok(self, text: str) -> None:
        self.checks += 1
        self.log("  [ok]   " + text)

    def fail(self, text: str) -> None:
        self.checks += 1
        self.failures.append(text)
        self.log("  [FAIL] " + text)

    def check(self, condition: bool, text: str) -> bool:
        if condition:
            self.ok(text)
        else:
            self.fail(text)
        return bool(condition)


REPORT = Report()


# ==========================================================================
# Swallowed-exception detector
# ==========================================================================
class ExceptionSpy:
    """
    Records exceptions that reach a scene's frame-level ``except``.

    ``sys.settrace``'s global hook only sees *calls*; returning a local tracer
    from it is what makes ``'exception'`` events fire for that frame.  We return
    one only for the small set of scene entry points above, so the line-by-line
    tracing cost is paid by a couple of dozen short functions rather than by
    every particle in the pool.
    """

    def __init__(self, watched_files: Sequence[str]) -> None:
        self.files = frozenset(os.path.normcase(f) for f in watched_files)
        self.hits: List[Tuple[str, str]] = []
        self._seen: set = set()
        self.context = "?"
        self.enabled = False

    # -- trace plumbing ------------------------------------------------
    def _local(self, frame: Any, event: str, arg: Any) -> Any:
        if event == "exception" and arg is not None:
            exc_type, exc_value, exc_tb = arg
            if issubclass(exc_type, (GeneratorExit, StopIteration)):
                return self._local
            where = "{}:{} {}".format(
                os.path.basename(frame.f_code.co_filename),
                frame.f_lineno, frame.f_code.co_name)
            text = "".join(traceback.format_exception(
                exc_type, exc_value, exc_tb)).strip()
            key = (where, str(exc_value), exc_type.__name__)
            if key not in self._seen:
                self._seen.add(key)
                self.hits.append((self.context + " @ " + where, text))
        return self._local

    def _global(self, frame: Any, event: str, arg: Any) -> Any:
        if event != "call":
            return None
        code = frame.f_code
        if code.co_name not in _WATCHED_NAMES:
            return None
        if os.path.normcase(code.co_filename) not in self.files:
            return None
        return self._local

    # -- control -------------------------------------------------------
    def start(self) -> None:
        self.enabled = True
        sys.settrace(self._global)

    def stop(self) -> None:
        self.enabled = False
        sys.settrace(None)

    def drain(self) -> List[Tuple[str, str]]:
        out = list(self.hits)
        self.hits = []
        return out


def _scene_files() -> List[str]:
    from snake import main as main_mod
    from snake.scenes import (gameover, gameplay, help_scene, level_select,
                              menu, pause)
    mods = [gameover, gameplay, help_scene, level_select, menu, pause, main_mod]
    return [m.__file__ for m in mods if getattr(m, "__file__", None)]


# ==========================================================================
# Pixel helpers (no numpy in this environment, so everything goes through
# bytes-level C primitives)
# ==========================================================================
def strip_bytes(surface: pygame.Surface, rect: pygame.Rect) -> bytes:
    """Raw RGB bytes of one rectangle of a surface."""
    return pygame.image.tostring(surface.subsurface(rect), "RGB")


def count_diff_pixels(a: bytes, b: bytes) -> int:
    """How many RGB triples differ between two equal-length buffers."""
    if a == b:
        return 0
    n = 0
    for i in range(0, min(len(a), len(b)), 3):
        if a[i:i + 3] != b[i:i + 3]:
            n += 1
    return n


# ==========================================================================
# Harness
# ==========================================================================
class Harness:
    """One booted ``Game`` plus everything needed to drive and watch it."""

    def __init__(self, save_path: str, spy: Optional[ExceptionSpy] = None) -> None:
        # Redirect the save file so a playtest never touches the player's own
        # progress; Game reads C.SAVE_PATH once, in its constructor.
        self._real_save_path = C.SAVE_PATH
        C.SAVE_PATH = save_path
        self.save_path = save_path

        from snake.main import Game
        self.game = Game(headless=True)
        C.SAVE_PATH = self._real_save_path

        self.spy = spy
        self.frames = 0
        self.frame_times: List[float] = []

        self.hud_rect = pygame.Rect(0, 0, C.WINDOW_W, C.HUD_H)
        self._hud_snapshot: Optional[bytes] = None
        self._hud_frame = -1
        self.hud_violations: List[str] = []
        self.clip_violations: List[str] = []
        self.nan_violations: List[str] = []
        #: When true, scribble over the HUD strip at the end of the frame so
        #: the detector below can be proved to actually detect something.
        self.hud_canary: bool = False

        self._install_hooks()

    # -- instrumentation ------------------------------------------------
    def _install_hooks(self) -> None:
        """
        Two instance-level hooks:

        ``GameplayScene._draw_pause_button`` is the last thing that is *allowed*
        to write into the HUD strip, so the strip is snapshotted straight after
        it returns.  ``EffectStack.present`` is handed the canvas at the very
        end of the frame, which is where the snapshot is compared and where the
        clip rect must be back to full-surface.
        """
        from snake.scenes.gameplay import GameplayScene

        harness = self
        original_pause_btn = GameplayScene._draw_pause_button

        def hooked_pause_button(scene: Any, surface: pygame.Surface) -> None:
            original_pause_btn(scene, surface)
            try:
                if surface is harness.game.canvas:
                    harness._hud_snapshot = strip_bytes(surface, harness.hud_rect)
                    harness._hud_frame = harness.frames
            except Exception:
                harness._hud_snapshot = None

        GameplayScene._draw_pause_button = hooked_pause_button  # type: ignore[assignment]
        self._restore_pause_button = (GameplayScene, original_pause_btn)

        original_present = self.game.fx.present

        def hooked_present(canvas: pygame.Surface, screen: pygame.Surface) -> Any:
            harness._end_of_frame(canvas)
            return original_present(canvas, screen)

        self.game.fx.present = hooked_present  # type: ignore[assignment]

    def _end_of_frame(self, canvas: pygame.Surface) -> None:
        # 1. clip rect must be back to the whole surface
        try:
            clip = canvas.get_clip()
            full = pygame.Rect(0, 0, *canvas.get_size())
            if clip != full:
                self.clip_violations.append(
                    "frame {}: canvas clip left at {} (expected {})".format(
                        self.frames, tuple(clip), tuple(full)))
        except Exception as exc:                       # pragma: no cover
            self.clip_violations.append("frame {}: {}".format(self.frames, exc))

        # 2. the HUD strip must be untouched since draw_hud finished.
        #    A transparent overlay on top of gameplay (the pause screen) is
        #    *supposed* to dim the whole screen, HUD included, so the check
        #    only applies while the gameplay scene is the top of the stack.
        if self.hud_canary:
            try:
                pygame.draw.rect(canvas, (255, 0, 255),
                                 pygame.Rect(400, 12, 80, 24))
            except Exception:
                pass

        top_is_game = type(self.game.scene).__name__ == "GameplayScene"
        if top_is_game and self._hud_snapshot is not None \
                and self._hud_frame == self.frames:
            try:
                now = strip_bytes(canvas, self.hud_rect)
                if now != self._hud_snapshot:
                    n = count_diff_pixels(self._hud_snapshot, now)
                    self.hud_violations.append(
                        "frame {}: {} HUD pixels overpainted after the HUD "
                        "was drawn".format(self.frames, n))
            except Exception as exc:                   # pragma: no cover
                self.hud_violations.append("frame {}: {}".format(self.frames, exc))
        self._hud_snapshot = None

    # -- driving --------------------------------------------------------
    @property
    def scene(self) -> Any:
        return self.game.scene

    def scene_name(self) -> str:
        s = self.game.scene
        return type(s).__name__ if s is not None else "None"

    def context(self, text: str) -> None:
        if self.spy is not None:
            self.spy.context = text

    def frame(self, dt: float = DT) -> None:
        t0 = time.perf_counter()
        self.game._pump_events()
        self.game.update(dt)
        self.game.draw()
        self.frames += 1
        self.frame_times.append((time.perf_counter() - t0) * 1000.0)
        self._check_snake()

    def step(self, n: int = 1, dt: float = DT,
             before: Optional[Callable[[], None]] = None) -> None:
        for _ in range(int(n)):
            if before is not None:
                before()
            self.frame(dt)

    def _check_snake(self) -> None:
        scene = self.game.scene
        snake = getattr(scene, "snake", None)
        if snake is None:
            return
        x, y = getattr(snake, "x", 0.0), getattr(snake, "y", 0.0)
        if not (math.isfinite(x) and math.isfinite(y)):
            self.nan_violations.append(
                "frame {}: non-finite head ({}, {})".format(self.frames, x, y))
        elif not (-400.0 <= x <= C.WINDOW_W + 400.0
                  and -400.0 <= y <= C.WINDOW_H + 400.0):
            self.nan_violations.append(
                "frame {}: head escaped the world at ({:.1f}, {:.1f})".format(
                    self.frames, x, y))

    # -- synthetic input -------------------------------------------------
    def move(self, x: float, y: float) -> None:
        pygame.event.post(pygame.event.Event(
            pygame.MOUSEMOTION, {"pos": (int(x), int(y)), "rel": (0, 0),
                                 "buttons": (0, 0, 0)}))

    def click(self, x: float, y: float, hover_frames: int = 4) -> None:
        """Move, hover, press and release - the whole gesture a player makes."""
        self.move(x, y)
        self.step(hover_frames)
        pygame.event.post(pygame.event.Event(
            pygame.MOUSEBUTTONDOWN, {"pos": (int(x), int(y)), "button": 1}))
        self.step(2)
        pygame.event.post(pygame.event.Event(
            pygame.MOUSEBUTTONUP, {"pos": (int(x), int(y)), "button": 1}))
        self.step(2)

    def key(self, keycode: int) -> None:
        pygame.event.post(pygame.event.Event(
            pygame.KEYDOWN, {"key": keycode, "mod": 0, "unicode": ""}))
        self.step(2)
        pygame.event.post(pygame.event.Event(
            pygame.KEYUP, {"key": keycode, "mod": 0}))
        self.step(1)

    def click_button(self, label: str, hover_frames: int = 4) -> bool:
        """Click the on-screen button whose label contains `label`."""
        button = find_button(self.game.scene, label)
        if button is None:
            return False
        cx, cy = button.rect.center
        self.click(cx, cy, hover_frames=hover_frames)
        return True

    def teardown(self) -> None:
        cls, original = self._restore_pause_button
        cls._draw_pause_button = original  # type: ignore[assignment]


# ==========================================================================
# Button discovery (explicit per scene - safer than walking __dict__, which
# would wander into game -> scene cache -> every other scene's buttons)
# ==========================================================================
def scene_buttons(scene: Any) -> List[Any]:
    if scene is None:
        return []
    out: List[Any] = []
    for attr in ("_buttons", "buttons"):
        value = getattr(scene, attr, None)
        if isinstance(value, list):
            out.extend(value)
    cards = getattr(scene, "cards", None)
    if isinstance(cards, list):
        out.extend(card.button for card in cards if hasattr(card, "button"))
    for attr in ("back", "pause_button"):
        value = getattr(scene, attr, None)
        if value is not None and hasattr(value, "rect"):
            out.append(value)
    return out


def find_button(scene: Any, label: str) -> Any:
    want = label.upper().replace(" ", "")
    for button in scene_buttons(scene):
        got = str(getattr(button, "label", "")).upper().replace(" ", "")
        if want and want in got:
            return button
    return None


# ==========================================================================
# The auto-aim pilot
# ==========================================================================
class Pilot:
    """
    Steers the snake by writing ``game.mouse_pos`` - the only channel a real
    player has.

    Candidate headings are ranked by how far they stay clear of lethal geometry
    (and of the snake's own body) against how well they point at the nearest
    orb.  It is a deliberately dumb greedy pilot: good enough to clear the early
    levels reliably, not good enough to make the late ones look easy.
    """

    RAYS: Tuple[float, ...] = (26.0, 55.0, 95.0, 145.0, 205.0)

    def __init__(self, harness: Harness) -> None:
        self.h = harness
        self.rng = random.Random(0x5EED)

    # -- world queries ---------------------------------------------------
    @staticmethod
    def _deadly_at(scene: Any, x: float, y: float, r: float) -> bool:
        for ob in getattr(scene, "obstacles", ()) or ():
            try:
                if getattr(ob, "deadly", False) and ob.collides(x, y, r):
                    return True
            except Exception:
                continue
        return False

    @staticmethod
    def _body_at(snake: Any, x: float, y: float, r: float) -> bool:
        segs = getattr(snake, "segments", ()) or ()
        for i, seg in enumerate(segs):
            if i < C.SELF_COLLISION_SKIP:
                continue
            dx, dy = seg[0] - x, seg[1] - y
            if dx * dx + dy * dy < (r + C.SNAKE_BODY_RADIUS) ** 2:
                return True
        return False

    def goal(self, scene: Any) -> Tuple[float, float]:
        snake = scene.snake
        field = getattr(scene, "food", None)
        orb = field.nearest(snake.x, snake.y) if field is not None else None
        if orb is not None:
            return (float(orb.x), float(orb.y))
        arena = scene.arena
        return (float(arena.centerx), float(arena.centery))

    def aim(self, scene: Any) -> Tuple[float, float]:
        """Return the mouse position to steer with this frame."""
        snake = scene.snake
        arena = scene.arena
        gx, gy = self.goal(scene)
        goal_ang = math.atan2(gy - snake.y, gx - snake.x)
        wrap = bool(getattr(scene.level, "wrap_walls", False))

        best_ang, best_score = goal_ang, -1e18
        for k in range(24):
            ang = goal_ang + wrap_angle(k * TAU / 24.0)
            turn = abs(wrap_angle(ang - snake.heading))
            # The snake physically cannot turn much more than this in the time
            # it takes to cross one lookahead ray, so wider swings are fiction.
            if turn > 2.2:
                continue
            ca, sa = math.cos(ang), math.sin(ang)
            clear = 0.0
            for d in self.RAYS:
                px, py = snake.x + ca * d, snake.y + sa * d
                if not wrap and not arena.collidepoint(int(px), int(py)):
                    break
                if self._deadly_at(scene, px, py, C.SNAKE_HEAD_RADIUS * 1.4):
                    break
                if self._body_at(snake, px, py, C.SNAKE_HEAD_RADIUS * 0.9):
                    break
                clear = d
            diff = abs(wrap_angle(ang - goal_ang))
            score = clear * 1.6 - diff * 78.0 - turn * 14.0
            if score > best_score:
                best_score, best_ang = score, ang

        # Aim well past the target: inside C.MOUSE_DEADZONE the snake stops
        # steering altogether, which would make it circle its own food.
        reach = 220.0
        return (snake.x + math.cos(best_ang) * reach,
                snake.y + math.sin(best_ang) * reach)

    def drive(self) -> None:
        scene = self.h.game.scene
        if getattr(scene, "snake", None) is None:
            return
        try:
            self.h.game.mouse_pos = self.aim(scene)
        except Exception:
            pass


class Suicide(Pilot):
    """A pilot that hunts the nearest lethal thing instead of the nearest orb."""

    def goal(self, scene: Any) -> Tuple[float, float]:
        snake = scene.snake
        best, best_d = None, 1e18
        for ob in getattr(scene, "obstacles", ()) or ():
            if not getattr(ob, "deadly", False):
                continue
            try:
                bx, by, bw, bh = ob.bounds()
                cx, cy = bx + bw * 0.5, by + bh * 0.5
            except Exception:
                continue
            d = (cx - snake.x) ** 2 + (cy - snake.y) ** 2
            if d < best_d:
                best_d, best = d, (cx, cy)
        if best is not None:
            return best
        arena = scene.arena
        return (float(arena.right + 200.0), float(arena.centery))

    def aim(self, scene: Any) -> Tuple[float, float]:
        # No avoidance at all: point straight at the thing that will kill us.
        snake = scene.snake
        gx, gy = self.goal(scene)
        ang = math.atan2(gy - snake.y, gx - snake.x)
        return (snake.x + math.cos(ang) * 260.0,
                snake.y + math.sin(ang) * 260.0)


# ==========================================================================
# Helpers used by the scripted flow
# ==========================================================================
def play_until(h: Harness, pilot: Pilot, limit: int,
               done: Callable[[], bool]) -> int:
    """Run the pilot for at most `limit` frames, stopping when `done()`."""
    for i in range(limit):
        pilot.drive()
        h.frame()
        if done():
            return i + 1
    return limit


def scene_is(h: Harness, name: str) -> bool:
    return h.scene_name() == name


# ==========================================================================
# Part 2: the scripted flow
# ==========================================================================
def run_flow(h: Harness) -> Dict[str, Any]:
    from snake.core.save import SaveData

    r = REPORT
    game = h.game
    pilot = Pilot(h)
    facts: Dict[str, Any] = {}

    r.head("PART 2  scripted play-through")

    # -- menu ---------------------------------------------------------------
    h.context("boot -> menu")
    game.switch_scene(C.SCENE_MENU)
    h.step(30)
    r.check(scene_is(h, "MenuScene"), "boots into MenuScene")
    r.check(find_button(game.scene, "PLAY") is not None,
            "menu exposes a PLAY button")

    # -- menu -> levels -----------------------------------------------------
    h.context("menu -> levels")
    r.check(h.click_button("LEVELS"), "clicked the LEVELS button")
    h.step(6)
    r.check(scene_is(h, "LevelSelectScene"), "LEVELS opens LevelSelectScene")

    # -- levels -> level 1 --------------------------------------------------
    h.context("levels -> level 1")
    h.step(45)                       # let the card entrance animation settle
    card = game.scene.cards[0]
    r.check(card.button.enabled, "level 1 tile is unlocked on a fresh save")
    cx, cy = card.button.rect.center
    h.click(cx, cy)
    h.step(20)                       # _launching beat + the switch
    r.check(scene_is(h, "GameplayScene"), "clicking tile 1 starts GameplayScene")
    r.check(game.level_index == 0, "game.level_index is 0")

    # -- play it ------------------------------------------------------------
    h.context("playing level 1")
    scene = game.scene
    goal = scene.level.goal_food
    used = play_until(h, pilot, 4000, lambda: not scene_is(h, "GameplayScene"))
    r.log("         cleared in {} frames ({:.1f} s of game time)".format(
        used, used * DT))
    r.check(scene_is(h, "VictoryScene"),
            "level 1 ends in VictoryScene (got {})".format(h.scene_name()))

    result = dict(game.last_result)
    facts["level1_result"] = result
    r.check(bool(result.get("won")), "last_result['won'] is True")
    r.check(int(result.get("food_eaten", 0)) >= goal,
            "ate the goal: {} of {} orbs".format(
                result.get("food_eaten"), goal))
    r.check(int(result.get("stars", 0)) >= 1,
            "stars awarded: {}".format(result.get("stars")))
    r.check(int(result.get("score", 0)) > 0,
            "scored {} points".format(result.get("score")))

    # -- the save file ------------------------------------------------------
    h.context("save file")
    game.save.save()
    on_disk = SaveData.load(h.save_path)
    r.check(on_disk.best_for(0) > 0,
            "save file records a best score for level 1: {}".format(
                on_disk.best_for(0)))
    r.check(on_disk.stars_for(0) >= 1,
            "save file records {} star(s) for level 1".format(
                on_disk.stars_for(0)))
    r.check(on_disk.is_unlocked(1), "save file unlocked level 2")
    r.check(on_disk.highscore >= int(result.get("score", 0)),
            "save file high score is at least the run score")

    # -- next level ---------------------------------------------------------
    h.context("victory -> next level")
    h.step(90)                       # let the star flourish finish
    r.check(h.click_button("NEXT LEVEL"), "clicked NEXT LEVEL")
    h.step(8)
    r.check(scene_is(h, "GameplayScene") and game.level_index == 1,
            "NEXT LEVEL starts level 2 (index {})".format(game.level_index))

    # -- pause: push and pop ------------------------------------------------
    h.context("pause overlay")
    h.step(20)
    depth_before = len(game._stack)
    h.key(pygame.K_ESCAPE)
    h.step(6)
    r.check(scene_is(h, "PauseScene"), "Esc pushes PauseScene")
    r.check(len(game._stack) == depth_before + 1,
            "pause is an overlay: stack depth {} -> {}".format(
                depth_before, len(game._stack)))
    frozen = (game.scene.game.scene is game.scene)
    below = game._stack[-2]
    x_before, y_before = below.snake.x, below.snake.y
    h.step(30)
    r.check(abs(below.snake.x - x_before) < 1e-6
            and abs(below.snake.y - y_before) < 1e-6,
            "the gameplay scene underneath is frozen while paused")
    r.check(h.click_button("RESUME"), "clicked RESUME")
    h.step(4)
    r.check(scene_is(h, "GameplayScene") and len(game._stack) == depth_before,
            "RESUME pops back to the gameplay scene")

    # -- the mouse-only pause route ----------------------------------------
    h.context("pause via the HUD button")
    r.check(h.click_button("PAUSE"), "clicked the HUD PAUSE button")
    h.step(6)
    r.check(scene_is(h, "PauseScene"), "the HUD PAUSE button opens the overlay")
    h.click_button("RESUME")
    h.step(4)

    # -- prove the HUD detector detects things ------------------------------
    h.context("HUD overpaint canary")
    h.step(2)
    baseline = len(h.hud_violations)
    h.hud_canary = True
    h.step(1)
    h.hud_canary = False
    caught = len(h.hud_violations) - baseline
    r.check(caught == 1,
            "the HUD overpaint detector fires on a deliberate scribble "
            "({} caught)".format(caught))
    del h.hud_violations[baseline:]   # the canary was ours, not the game's

    # -- force a death ------------------------------------------------------
    h.context("dying on purpose")
    suicide = Suicide(h)
    scene = game.scene
    used = play_until(h, suicide, 3000, lambda: not scene_is(h, "GameplayScene"))
    r.check(scene_is(h, "GameOverScene"),
            "flying into hazards ends in GameOverScene (got {} after {} "
            "frames)".format(h.scene_name(), used))
    r.check(int(game.last_result.get("deaths", 0)) >= C.START_LIVES,
            "used every life: {} deaths".format(game.last_result.get("deaths")))
    r.check(game.last_result.get("won") is False, "last_result['won'] is False")
    facts["death_result"] = dict(game.last_result)

    # A loss must not unlock anything new.
    r.check(not game.save.is_unlocked(2),
            "losing level 2 did not unlock level 3")

    # -- gameover -> retry --------------------------------------------------
    h.context("gameover -> retry")
    h.step(80)
    r.check(h.click_button("RETRY"), "clicked RETRY")
    h.step(8)
    r.check(scene_is(h, "GameplayScene") and game.level_index == 1,
            "RETRY restarts the same level")

    # -- pause -> quit to menu ---------------------------------------------
    h.context("pause -> menu")
    h.step(15)
    h.key(pygame.K_ESCAPE)
    h.step(6)
    r.check(h.click_button("QUIT TO MENU"), "clicked QUIT TO MENU")
    h.step(8)
    r.check(scene_is(h, "MenuScene"), "QUIT TO MENU returns to the menu")

    # -- help and back ------------------------------------------------------
    h.context("menu -> help -> menu")
    r.check(h.click_button("HOW TO PLAY"), "clicked HOW TO PLAY")
    h.step(8)
    r.check(scene_is(h, "HelpScene"), "HOW TO PLAY opens HelpScene")
    h.step(60)
    r.check(h.click_button("BACK"), "clicked BACK on the help screen")
    h.step(8)
    r.check(scene_is(h, "MenuScene"), "help BACK returns to the menu")

    # -- menu PLAY ----------------------------------------------------------
    h.context("menu -> play")
    r.check(h.click_button("PLAY"), "clicked PLAY")
    h.step(8)
    r.check(scene_is(h, "GameplayScene"),
            "PLAY continues into a level (index {})".format(game.level_index))

    return facts


# ==========================================================================
# Part 3: scene reuse
# ==========================================================================
def run_reuse(h: Harness) -> None:
    r = REPORT
    game = h.game
    pilot = Pilot(h)

    r.head("PART 3  scene reuse (instances are cached, so on_enter must reset)")

    h.context("reuse: first visit")
    game.switch_scene(C.SCENE_GAME, level_index=0)
    first = game.scene
    h.step(int(3.4 / DT))            # past the READY countdown
    play_until(h, pilot, 260, lambda: not scene_is(h, "GameplayScene"))
    if not scene_is(h, "GameplayScene"):
        game.switch_scene(C.SCENE_GAME, level_index=0)
        h.step(int(3.4 / DT))
        play_until(h, pilot, 120, lambda: not scene_is(h, "GameplayScene"))
    dirty = game.scene
    r.log("         after one visit: score {}, eaten {}, len {}, "
          "particles {}".format(dirty.score, dirty.food_eaten,
                                dirty.snake.length, game.particles.count()))
    r.check(dirty.score > 0 or dirty.food_eaten > 0 or game.particles.count() > 0,
            "the first visit actually dirtied the scene")

    h.context("reuse: second visit")
    game.switch_scene(C.SCENE_GAME, level_index=0)
    second = game.scene
    r.check(second is first, "the GameplayScene instance really is reused")
    r.check(second.score == 0, "score reset to 0 (got {})".format(second.score))
    r.check(second.food_eaten == 0,
            "food_eaten reset to 0 (got {})".format(second.food_eaten))
    r.check(second.lives == C.START_LIVES,
            "lives reset to {}".format(C.START_LIVES))
    r.check(second.combo == 0 and second.max_combo == 0, "combo counters reset")
    r.check(second.deaths == 0, "death counter reset")
    r.check(second.finished is False, "finished flag reset")
    r.check(not second.popups, "score popups cleared")
    r.check(second.snake.target_length == C.SNAKE_START_LENGTH,
            "snake back to the starting length ({} segments)".format(
                second.snake.target_length))
    r.check(second.snake.alive, "snake is alive again")
    r.check(abs(second.snake.x - second.arena.centerx) < 1.0
            and abs(second.snake.y - second.arena.centery) < 1.0,
            "snake respawned at the arena centre")
    r.check(game.particles.count() == 0,
            "particle pool empty (got {})".format(game.particles.count()))
    r.check(not second.effects.kinds(),
            "no power-up effects left over (got {})".format(
                second.effects.kinds()))
    r.check(abs(second.elapsed) < 1e-9 and abs(second.clock_t) < 1e-9,
            "clocks reset")
    r.check(second.ready_timer > 0.0, "READY countdown re-armed")

    # The other cached scenes get the same treatment.
    h.context("reuse: menu / levels / help")
    game.switch_scene(C.SCENE_MENU)
    h.step(20)
    menu_a = game.scene
    game.switch_scene(C.SCENE_HELP)
    h.step(20)
    game.switch_scene(C.SCENE_MENU)
    h.step(5)
    r.check(game.scene is menu_a, "the MenuScene instance is reused")
    r.check(abs(getattr(game.scene, "_entered", 1.0)) < 0.1,
            "the menu's entrance animation restarted")


# ==========================================================================
# Part 4: every button leads somewhere
# ==========================================================================
def run_button_walk(h: Harness) -> None:
    r = REPORT
    game = h.game

    r.head("PART 4  button walk (every button must lead somewhere real)")

    # Unlock everything so the level-select tiles are all live.
    game.save.unlock_through(11)

    def visit(setup: Callable[[], None], label: str,
              expect: Optional[str], note: str = "") -> None:
        setup()
        h.step(12)
        before = h.scene_name()
        clicked = h.click_button(label)
        h.step(22)
        after = h.scene_name()
        if not clicked:
            r.fail("{}: no button labelled {!r}".format(before, label))
            return
        if expect is None:
            r.ok("{:>18} / {:<14} -> {} {}".format(before, label, after, note))
            return
        if after == expect:
            r.ok("{:>18} / {:<14} -> {}".format(before, label, after))
        else:
            r.fail("{:>18} / {:<14} -> {} (expected {})".format(
                before, label, after, expect))

    to_menu = lambda: game.switch_scene(C.SCENE_MENU)                # noqa: E731
    to_levels = lambda: game.switch_scene(C.SCENE_LEVELS)            # noqa: E731
    to_help = lambda: game.switch_scene(C.SCENE_HELP)                # noqa: E731

    def to_game(index: int = 0) -> Callable[[], None]:
        return lambda: game.switch_scene(C.SCENE_GAME, level_index=index)

    def to_pause() -> None:
        game.switch_scene(C.SCENE_GAME, level_index=1)
        h.step(4)
        game.push_scene(C.SCENE_PAUSE)

    def to_result(name: str, won: bool, index: int = 1) -> Callable[[], None]:
        def setup() -> None:
            game.last_result = {
                "score": 260, "level_index": index, "level_name": "Deep Nebula",
                "food_eaten": 10, "goal_food": 10, "stars": 2,
                "new_best": True, "won": won, "elapsed": 42.0,
                "max_combo": 5, "deaths": 0 if won else 3,
            }
            game.switch_scene(name)
        return setup

    h.context("button walk: menu")
    visit(to_menu, "PLAY", "GameplayScene")
    visit(to_menu, "LEVELS", "LevelSelectScene")
    visit(to_menu, "HOW TO PLAY", "HelpScene")

    # SOUND toggles in place; verify the state actually flipped.
    to_menu()
    h.step(12)
    was = bool(game.audio.muted)
    h.click_button("SOUND")
    h.step(6)
    r.check(bool(game.audio.muted) != was
            and h.scene_name() == "MenuScene",
            "MenuScene / SOUND toggles mute in place ({} -> {})".format(
                was, game.audio.muted))
    h.click_button("SOUND")          # put it back
    h.step(6)

    # QUIT ends the process loop rather than switching scene.
    to_menu()
    h.step(12)
    h.click_button("QUIT")
    h.step(4)
    r.check(game.running is False, "MenuScene / QUIT stops the main loop")
    game.running = True

    h.context("button walk: level select")
    visit(to_levels, "BACK", "MenuScene")
    for index in (0, 5, 11):
        def setup(i: int = index) -> None:
            game.switch_scene(C.SCENE_LEVELS)
            h.step(50)               # entrance animation, so rects are settled
        setup()
        h.step(50)
        card = game.scene.cards[index]
        cx, cy = card.button.rect.center
        h.click(cx, cy)
        h.step(22)
        r.check(h.scene_name() == "GameplayScene" and game.level_index == index,
                "LevelSelectScene / tile {:>2}    -> GameplayScene(level {})".format(
                    index + 1, game.level_index))

    h.context("button walk: pause")
    visit(to_pause, "RESUME", "GameplayScene")
    visit(to_pause, "RESTART", "GameplayScene")
    visit(to_pause, "LEVEL SELECT", "LevelSelectScene")
    visit(to_pause, "QUIT TO MENU", "MenuScene")
    to_pause()
    h.step(12)
    was = bool(game.audio.muted)
    h.click_button("SOUND")
    h.step(6)
    r.check(bool(game.audio.muted) != was and h.scene_name() == "PauseScene",
            "PauseScene / SOUND toggles mute in place")
    h.click_button("SOUND")
    h.step(6)

    h.context("button walk: gameover")
    visit(to_result(C.SCENE_GAMEOVER, False), "RETRY", "GameplayScene")
    visit(to_result(C.SCENE_GAMEOVER, False), "LEVEL SELECT", "LevelSelectScene")
    visit(to_result(C.SCENE_GAMEOVER, False), "MENU", "MenuScene")

    h.context("button walk: victory")
    visit(to_result(C.SCENE_VICTORY, True), "NEXT LEVEL", "GameplayScene")
    visit(to_result(C.SCENE_VICTORY, True), "REPLAY", "GameplayScene")
    visit(to_result(C.SCENE_VICTORY, True), "LEVEL SELECT", "LevelSelectScene")
    visit(to_result(C.SCENE_VICTORY, True), "MENU", "MenuScene")

    h.context("button walk: victory (final level)")
    setup_final = to_result(C.SCENE_VICTORY, True, index=11)
    setup_final()
    h.step(12)
    labels = [str(b.label) for b in scene_buttons(game.scene)]
    r.check("NEXT LEVEL" not in labels,
            "final-level victory hides NEXT LEVEL (buttons: {})".format(labels))
    visit(setup_final, "REPLAY", "GameplayScene")

    h.context("button walk: help")
    visit(to_help, "BACK", "MenuScene")

    h.context("button walk: gameplay HUD")
    def to_play() -> None:
        game.switch_scene(C.SCENE_GAME, level_index=0)
    to_play()
    h.step(12)
    h.click_button("PAUSE")
    h.step(8)
    r.check(h.scene_name() == "PauseScene",
            "GameplayScene / PAUSE       -> PauseScene")
    h.click_button("RESUME")
    h.step(6)


# ==========================================================================
# Part 6: all twelve levels
# ==========================================================================
def start_level(game: Any, index: int) -> None:
    """
    Enter a level with the READY countdown already spent.

    The countdown is three seconds of animation with the snake parked, which is
    the right feel for a player and a waste of a stress test's frame budget -
    skipping it means all `frames` frames exercise the live simulation.
    """
    game.switch_scene(C.SCENE_GAME, level_index=index)
    scene = game.scene
    if getattr(scene, "ready_timer", 0.0):
        scene.ready_timer = 0.0


def run_level_sweep(h: Harness, frames: int, timing_frames: int) -> None:
    from snake.core.level import LEVEL_COUNT, get_level

    r = REPORT
    game = h.game
    pilot = Pilot(h)

    r.head("PART 6  all {} levels, {} piloted frames each".format(
        LEVEL_COUNT, frames))
    r.log("  {:<3} {:<16} {:>7} {:>7} {:>7} {:>6} {:>6} {:>8} {:>8}".format(
        "lv", "name", "mean", "p95", "max", "eaten", "died", "restarts", "status"))
    r.log("  " + "-" * 76)

    game.save.unlock_through(LEVEL_COUNT - 1)
    all_ok = True
    total_eaten = 0
    slowest: List[float] = []
    slowest_name = "-"

    for index in range(LEVEL_COUNT):
        level = get_level(index)
        h.context("level sweep {:02d} {}".format(index + 1, level.name))

        start_level(game, index)
        eaten, died, restarts = 0, 0, 0
        errors_before = len(h.nan_violations) + len(h.clip_violations) \
            + len(h.hud_violations)

        # --- correctness pass (the exception spy is running) ---------------
        for _ in range(frames):
            scene = game.scene
            if type(scene).__name__ != "GameplayScene":
                # The pilot won or lost; count it and drop straight back in.
                eaten += int(game.last_result.get("food_eaten", 0))
                died += int(game.last_result.get("deaths", 0))
                restarts += 1
                start_level(game, index)
                continue
            pilot.drive()
            h.frame()
        scene = game.scene
        if type(scene).__name__ == "GameplayScene":
            eaten += scene.food_eaten
            died += scene.deaths
        total_eaten += eaten

        # --- timing pass (untraced, so the numbers are honest) -------------
        spy_was_on = h.spy is not None and h.spy.enabled
        if spy_was_on:
            h.spy.stop()
        start_level(game, index)
        h.frame_times = []
        for _ in range(timing_frames):
            if type(game.scene).__name__ != "GameplayScene":
                start_level(game, index)
                continue
            pilot.drive()
            h.frame()
        times = sorted(h.frame_times)
        if spy_was_on:
            h.spy.start()

        mean = statistics.fmean(times) if times else 0.0
        p95 = times[int(len(times) * 0.95)] if times else 0.0
        worst = times[-1] if times else 0.0

        errors_after = len(h.nan_violations) + len(h.clip_violations) \
            + len(h.hud_violations)
        spy_hits = len(h.spy.hits) if h.spy is not None else 0
        clean = (errors_after == errors_before) and spy_hits == 0
        # A frame time far above the 60 fps budget on a *headless* box would
        # mean something is quadratic, not that the machine is slow.
        fast = p95 < 16.6
        all_ok = all_ok and clean
        if not slowest or p95 > max(slowest):
            slowest_name = level.name
        slowest.append(p95)

        r.log("  {:<3} {:<16} {:>6.2f}m {:>6.2f}m {:>6.2f}m {:>6} {:>6} "
              "{:>8} {:>8}".format(
                  index + 1, level.name[:16], mean, p95, worst,
                  eaten, died, restarts,
                  "ok" if clean else "ERRORS"))
        if not fast:
            r.log("        note: p95 {:.2f} ms is over the 16.6 ms frame "
                  "budget".format(p95))

    r.check(all_ok, "all {} levels ran clean".format(LEVEL_COUNT))
    r.check(total_eaten > 0,
            "the pilot ate {} orbs across the sweep".format(total_eaten))
    r.check(all(t < 33.0 for t in slowest),
            "no level's p95 frame time exceeded 33 ms (worst p95 {:.2f} ms on "
            "{})".format(max(slowest) if slowest else 0.0, slowest_name))


# ==========================================================================
# Part 5: detector self-tests
# --------------------------------------------------------------------------
# Every invariant below is only worth reporting if it can fail, and all three
# of them are "absence of evidence" checks.  So break each one on purpose for
# exactly one frame and confirm the detector notices.
# ==========================================================================
def run_detector_canaries(h: Harness, spy: Optional[ExceptionSpy]) -> None:
    r = REPORT
    game = h.game
    r.head("PART 5  detector self-tests")

    game.switch_scene(C.SCENE_GAME, level_index=0)
    h.step(4)
    scene = game.scene

    # -- swallowed exception ------------------------------------------------
    if spy is None:
        r.log("  [skip] the exception detector is disabled")
    else:
        spy.drain()
        spy._seen.clear()
        h.context("spy canary")

        def boom(dt: float) -> None:
            raise RuntimeError("playtest canary")

        scene._update = boom          # instance attr shadows the real method
        h.step(1)
        del scene._update
        hits = spy.drain()
        spy._seen.clear()
        r.check(any("playtest canary" in text for _, text in hits),
                "the swallowed-exception detector sees an exception a scene "
                "guard ate ({} hit(s))".format(len(hits)))

    # -- non-finite head ----------------------------------------------------
    baseline = len(h.nan_violations)
    saved_x = scene.snake.x
    scene.snake.x = float("nan")
    h.step(1)
    scene.snake.x = saved_x
    caught = len(h.nan_violations) - baseline
    r.check(caught >= 1,
            "the NaN detector fires on a non-finite head ({} caught)".format(
                caught))
    del h.nan_violations[baseline:]

    # -- leaked clip rect ---------------------------------------------------
    baseline = len(h.clip_violations)
    game.canvas.set_clip(pygame.Rect(10, 10, 100, 100))
    h.step(1)
    game.canvas.set_clip(None)
    caught = len(h.clip_violations) - baseline
    r.check(caught >= 1,
            "the clip-leak detector fires on a stray clip rect "
            "({} caught)".format(caught))
    del h.clip_violations[baseline:]


# ==========================================================================
# Part 1: registry
# ==========================================================================
def run_registry(h: Harness) -> None:
    """
    Every scene name `config` declares must be registered, and every registered
    scene must build.

    This used to assert the registry held *exactly* seven names, which made the
    check a liability the moment v2 added ``mode`` / ``settings`` / ``story``:
    the assertion failed for the one reason that is not a defect - the feature
    landing.  The contract that actually matters is a two-way one, so that is
    what is checked now:

    * every ``C.SCENE_*`` constant has a registry entry (nothing config
      promises can be missing), and
    * every registry entry either builds the class it claims, or is a declared
      v2 scene whose module has not been written yet.

    The last clause is the only slack, it is enumerated in `PENDING`, and it is
    reported so it cannot rot silently.  Delete a name from `PENDING` the
    moment its scene module exists and the check hardens automatically.
    """
    from snake.main import SCENE_REGISTRY

    r = REPORT
    r.head("PART 1  scene registry")

    expected = {C.SCENE_MENU: "MenuScene", C.SCENE_LEVELS: "LevelSelectScene",
                C.SCENE_GAME: "GameplayScene", C.SCENE_PAUSE: "PauseScene",
                C.SCENE_GAMEOVER: "GameOverScene",
                C.SCENE_VICTORY: "VictoryScene", C.SCENE_HELP: "HelpScene",
                C.SCENE_MODE: "ModeSelectScene",
                C.SCENE_SETTINGS: "SettingsScene",
                C.SCENE_STORY: "StoryScene"}

    #: v2 scene names that are registered but whose module is still being
    #: written.  Empty this list as the scenes land.
    PENDING = {C.SCENE_MODE, C.SCENE_SETTINGS, C.SCENE_STORY}

    declared = {value for name, value in vars(C).items()
                if name.startswith("SCENE_") and isinstance(value, str)}
    missing = sorted(declared - set(SCENE_REGISTRY))
    r.check(not missing,
            "every C.SCENE_* name is registered ({} names{})".format(
                len(declared),
                "" if not missing else ", missing " + ", ".join(missing)))

    unknown = sorted(set(SCENE_REGISTRY) - set(expected))
    r.check(not unknown,
            "the registry holds no undocumented names ({} entries{})".format(
                len(SCENE_REGISTRY),
                "" if not unknown else ", unexpected " + ", ".join(unknown)))

    pending_seen: List[str] = []
    for name, cls_name in expected.items():
        if name not in SCENE_REGISTRY:
            continue
        try:
            scene = h.game._make_scene(name)
        except Exception as exc:
            if name in PENDING:
                pending_seen.append(name)
                continue
            r.fail("{!r} failed to resolve: {}".format(name, exc))
            continue
        r.check(type(scene).__name__ == cls_name,
                "{!r:<10} -> {}".format(name, type(scene).__name__))

    if pending_seen:
        r.log("  note: {} registered but not yet implemented - expected, "
              "these are the next phase's scenes".format(
                  ", ".join(repr(n) for n in sorted(pending_seen))))
    r.check(set(pending_seen) <= PENDING,
            "no scene outside the declared pending set failed to build")


# ==========================================================================
# main
# ==========================================================================
def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Headless NEON SERPENT playtest")
    parser.add_argument("--quick", action="store_true",
                        help="shorter level sweep")
    parser.add_argument("--frames", type=int, default=400,
                        help="piloted frames per level in the sweep")
    parser.add_argument("--no-trace", action="store_true",
                        help="disable the swallowed-exception detector")
    args = parser.parse_args(argv)

    frames = 120 if args.quick else args.frames
    timing = 90 if args.quick else 200

    save_path = os.path.join(_ROOT, "captures", "playtest-save.json")
    os.makedirs(os.path.dirname(save_path), exist_ok=True)
    if os.path.exists(save_path):
        os.remove(save_path)

    spy: Optional[ExceptionSpy] = None
    harness = Harness(save_path)
    if not args.no_trace:
        spy = ExceptionSpy(_scene_files())
        harness.spy = spy
        spy.start()

    started = time.perf_counter()
    try:
        run_registry(harness)
        run_flow(harness)
        run_reuse(harness)
        run_button_walk(harness)
        run_detector_canaries(harness, spy)
        run_level_sweep(harness, frames, timing)
    except Exception:
        if spy is not None:
            spy.stop()
        REPORT.head("DRIVER CRASHED")
        REPORT.log(traceback.format_exc())
        REPORT.failures.append("the playtest driver itself raised")
    finally:
        if spy is not None:
            spy.stop()
        harness.teardown()

    elapsed = time.perf_counter() - started

    # -- invariants collected across the whole run --------------------------
    r = REPORT
    r.head("INVARIANTS")
    r.check(not harness.nan_violations,
            "snake head stayed finite and in the world "
            "({} violations)".format(len(harness.nan_violations)))
    for line in harness.nan_violations[:5]:
        r.log("         " + line)
    r.check(not harness.clip_violations,
            "no scene leaked a clip rect ({} violations)".format(
                len(harness.clip_violations)))
    for line in harness.clip_violations[:5]:
        r.log("         " + line)
    r.check(not harness.hud_violations,
            "the HUD strip was never painted over ({} violations)".format(
                len(harness.hud_violations)))
    for line in harness.hud_violations[:5]:
        r.log("         " + line)

    if spy is not None:
        hits = spy.drain()
        r.check(not hits,
                "no exception reached a scene's frame guard "
                "({} distinct)".format(len(hits)))
        for where, text in hits[:12]:
            r.log("")
            r.log("  --- swallowed in " + where)
            for line in text.splitlines():
                r.log("      " + line)
    else:
        r.log("  [skip] swallowed-exception detector disabled")

    r.head("SUMMARY")
    r.log("  {} checks, {} failures, {} frames driven, {:.1f} s wall clock".format(
        r.checks, len(r.failures), harness.frames, elapsed))
    for line in r.failures:
        r.log("  FAILED: " + line)
    r.log("")
    r.log("  RESULT: " + ("PASS" if not r.failures else "FAIL"))

    pygame.quit()
    return 0 if not r.failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
