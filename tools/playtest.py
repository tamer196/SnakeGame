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

    def click_data(self, data: Any, hover_frames: int = 4) -> bool:
        """Click the button carrying `data` - for the label-less v2 tiles."""
        button = find_button_by_data(self.game.scene, data)
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
#: Attributes that hold a plain list of Buttons.
_BUTTON_LISTS = ("_buttons", "buttons")

#: Attributes that hold a list of *records* which each own a ``.button`` -
#: level-select tiles, mode-select cards, difficulty tiles.  ``cards`` is
#: shared by LevelSelectScene (records with ``.button``) and StoryScene
#: (records without one), so the ``hasattr`` filter below is load-bearing.
_BUTTON_RECORD_LISTS = ("cards", "_cards", "_tiles", "diff_tiles", "_diff_tiles")

#: Attributes that hold a single Button.
_BUTTON_SINGLES = ("back", "_back", "_restart", "pause_button",
                   "continue_btn", "skip_btn")


def scene_buttons(scene: Any) -> List[Any]:
    """
    Every clickable Button a scene owns, in a stable order.

    Deliberately explicit rather than a ``__dict__`` walk: a scene holds a
    reference to ``game``, and ``game`` holds the scene cache, so a generic
    walk would wander into every *other* scene's buttons and report a dead
    control as live.
    """
    if scene is None:
        return []
    out: List[Any] = []
    seen: set = set()

    def add(button: Any) -> None:
        if button is None or not hasattr(button, "rect"):
            return
        if id(button) in seen:
            return
        seen.add(id(button))
        out.append(button)

    for attr in _BUTTON_LISTS:
        value = getattr(scene, attr, None)
        if isinstance(value, list):
            for button in value:
                add(button)
    for attr in _BUTTON_RECORD_LISTS:
        value = getattr(scene, attr, None)
        if isinstance(value, list):
            for record in value:
                add(getattr(record, "button", None))
    for attr in _BUTTON_SINGLES:
        add(getattr(scene, attr, None))
    return out


def find_button(scene: Any, label: str) -> Any:
    want = label.upper().replace(" ", "")
    for button in scene_buttons(scene):
        got = str(getattr(button, "label", "")).upper().replace(" ", "")
        if want and want in got:
            return button
    return None


def find_button_by_data(scene: Any, data: Any) -> Any:
    """
    Find a button by its ``data`` payload rather than its label.

    Half the v2 controls (level tiles, mode cards, difficulty tiles) carry an
    empty label on purpose - the scene paints its own art over the button - so
    label matching cannot reach them.
    """
    for button in scene_buttons(scene):
        if getattr(button, "data", None) == data:
            return button
    return None


def button_labels(scene: Any) -> List[str]:
    """Non-empty labels of a scene's buttons, for reporting."""
    return [str(getattr(b, "label", "")) for b in scene_buttons(scene)
            if str(getattr(b, "label", "")).strip()]


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
    # v2: PLAY no longer drops straight into a level.  It opens the mode
    # picker, and FREE PLAY from there reaches the level select.  The old
    # expectation ("PLAY -> GameplayScene") described the v1 flow and was the
    # single check most likely to hide a broken hand-off, so it is replaced by
    # a walk of the whole new route rather than deleted.
    h.context("menu -> play -> mode select")
    r.check(h.click_button("PLAY"), "clicked PLAY")
    h.step(10)
    r.check(scene_is(h, "ModeSelectScene"),
            "PLAY opens the mode picker (got {})".format(h.scene_name()))
    r.check(h.click_data("free"), "clicked the FREE PLAY card")
    h.step(20)
    r.check(scene_is(h, "LevelSelectScene"),
            "FREE PLAY continues into the level select (got {})".format(
                h.scene_name()))
    r.check(game.mode == C.MODE_FREE,
            "FREE PLAY set game.mode to {!r}".format(game.mode))

    return facts


# ==========================================================================
# Part 3: scene reuse
# ==========================================================================
def run_reuse(h: Harness) -> None:
    from snake.core import difficulty as D

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
    # v2: the life count is the difficulty's, not a global constant.  Asserting
    # C.START_LIVES here passed only while NORMAL happened to be selected, so
    # it was a check that measured the test's own leftover state.
    want_lives = D.lives_for(D.get_difficulty(game.difficulty))
    r.check(second.lives == want_lives,
            "lives reset to {} for difficulty {!r} (got {})".format(
                want_lives, game.difficulty, second.lives))
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
    visit(to_menu, "PLAY", "ModeSelectScene")
    visit(to_menu, "LEVELS", "LevelSelectScene")
    visit(to_menu, "HOW TO PLAY", "HelpScene")
    # v2 moved the mute toggle off the title screen and into the settings
    # screen, so the menu's fifth route is SETTINGS rather than SOUND.
    visit(to_menu, "SETTINGS", "SettingsScene")

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
# Part 4b: the v2 flow
# --------------------------------------------------------------------------
# Seven scenes were written in parallel by agents who could not see each
# other's work, against a written contract.  Contracts drift.  Everything
# below drives the *seams* between those scenes - the hand-offs where one
# agent's assumption meets another's implementation - rather than the scenes
# themselves, because that is where a blind parallel build breaks.
# ==========================================================================
def wipe_save(h: Harness) -> None:
    """Put the save back to a fresh-install state between v2 sections."""
    game = h.game
    game.save.reset()
    game.mode = C.DEFAULT_MODE
    game.difficulty = C.DEFAULT_DIFFICULTY
    game.save.set_mode(C.DEFAULT_MODE)
    game.save.set_difficulty(C.DEFAULT_DIFFICULTY)
    game.save.save()


def to_mode_select(h: Harness) -> None:
    """Reach the mode picker the way a player does: menu, then PLAY."""
    h.game.switch_scene(C.SCENE_MENU)
    h.step(16)
    h.click_button("PLAY")
    h.step(16)


def advance_story(h: Harness, limit: int = 10) -> int:
    """
    Click through a StoryScene deck one CONTINUE at a time.

    Each card types itself out before its button does anything useful, so the
    dwell is generous.  Returns the number of cards advanced past.
    """
    seen = 0
    for _ in range(int(limit)):
        if h.scene_name() != "StoryScene":
            break
        h.step(80)                   # let the typewriter finish
        if not (h.click_button("CONTINUE") or h.click_button("BEGIN")):
            break
        seen += 1
        h.step(10)
    return seen


def clear_level(h: Harness, pilot: "Pilot", limit: int = 6000) -> bool:
    """Fly the pilot until the gameplay scene hands over.  True if it won."""
    play_until(h, pilot, limit, lambda: h.scene_name() != "GameplayScene")
    return h.scene_name() == "VictoryScene"


def run_v2_mode_select(h: Harness) -> None:
    """Menu PLAY -> mode select -> each difficulty really lands in the save."""
    from snake.core.save import SaveData

    r = REPORT
    game = h.game
    r.head("PART 2b  mode select and the difficulty picker")

    wipe_save(h)
    h.context("v2: menu -> mode select")
    game.switch_scene(C.SCENE_MENU)
    h.step(20)
    r.check(find_button(game.scene, "PLAY") is not None,
            "the menu still offers PLAY")
    r.check(find_button(game.scene, "SETTINGS") is not None,
            "the menu offers SETTINGS (v2 moved mute off the title screen)")
    r.check(h.click_button("PLAY"), "clicked PLAY")
    h.step(16)
    r.check(scene_is(h, "ModeSelectScene"),
            "PLAY -> ModeSelectScene (got {})".format(h.scene_name()))

    # The two mode cards and the four difficulty tiles carry an empty label on
    # purpose (the scene paints its own art), so they are found by data.
    r.check(find_button_by_data(game.scene, "story") is not None,
            "the mode picker exposes a STORY card")
    r.check(find_button_by_data(game.scene, "free") is not None,
            "the mode picker exposes a FREE PLAY card")

    h.context("v2: difficulty tiles")
    for key in C.DIFFICULTIES:
        tile = find_button_by_data(game.scene, ("diff", key))
        if tile is None:
            r.fail("mode select has no {!r} difficulty tile".format(key))
            continue
        cx, cy = tile.rect.center
        h.click(cx, cy)
        h.step(8)
        game.save.save()
        on_disk = SaveData.load(h.save_path)
        ok = (game.difficulty == key and game.save.difficulty == key
              and on_disk.difficulty == key and scene_is(h, "ModeSelectScene"))
        r.check(ok, "difficulty tile {:<6} -> game={!r} save={!r} on disk={!r}"
                    .format(key, game.difficulty, game.save.difficulty,
                            on_disk.difficulty))

    h.context("v2: mode select BACK")
    r.check(h.click_button("BACK"), "clicked BACK on the mode picker")
    h.step(12)
    r.check(scene_is(h, "MenuScene"), "mode select BACK -> MenuScene")

    # FREE PLAY sets the mode and reaches the level select.
    h.context("v2: FREE PLAY card")
    to_mode_select(h)
    r.check(h.click_data("free"), "clicked the FREE PLAY card")
    h.step(20)
    r.check(scene_is(h, "LevelSelectScene") and game.mode == C.MODE_FREE,
            "FREE PLAY -> LevelSelectScene with game.mode={!r}".format(game.mode))


def run_v2_story(h: Harness) -> None:
    """The whole narrative spine: prologue, a cleared level, the hand-back."""
    from snake.core import story as S
    from snake.core.level import LEVEL_COUNT
    from snake.core.save import SaveData

    r = REPORT
    game = h.game
    pilot = Pilot(h)
    r.head("PART 2c  story mode, end to end")

    wipe_save(h)
    game.difficulty = C.DIFF_EASY        # the pilot clears level 1 reliably
    game.save.set_difficulty(C.DIFF_EASY)

    h.context("v2: story start")
    to_mode_select(h)
    r.check(h.click_data("story"), "clicked the STORY card")
    h.step(40)
    r.check(scene_is(h, "StoryScene"),
            "STORY -> StoryScene (got {})".format(h.scene_name()))
    r.check(game.mode == C.MODE_STORY,
            "game.mode is {!r}".format(game.mode))

    scene = game.scene
    cards = list(getattr(scene, "cards", []))
    r.check(len(cards) >= 2,
            "the story presenter was handed {} cards".format(len(cards)))
    r.check(any(str(getattr(c, "roman", "")) for c in cards),
            "one of them is a chapter plate (romans: {})".format(
                [str(getattr(c, "roman", "")) for c in cards]))
    r.check(getattr(scene, "next_scene", None) == C.SCENE_GAME,
            "the deck hands over to {!r}".format(getattr(scene, "next_scene", None)))
    r.check(dict(getattr(scene, "next_kwargs", {})).get("level_index") == 0,
            "...with level_index 0 ({!r})".format(getattr(scene, "next_kwargs", {})))
    r.check(find_button(scene, "SKIP") is not None,
            "the story presenter offers SKIP")

    # SKIP must jump the whole deck straight into the level.
    h.context("v2: story SKIP")
    h.step(20)
    r.check(h.click_button("SKIP"), "clicked SKIP")
    h.step(16)
    r.check(scene_is(h, "GameplayScene") and game.level_index == 0,
            "SKIP jumps the deck into level 1 (got {} index {})".format(
                h.scene_name(), game.level_index))

    # Now do it properly, card by card.
    h.context("v2: story CONTINUE")
    to_mode_select(h)
    h.click_data("story")
    h.step(40)
    r.check(scene_is(h, "StoryScene"), "back on the story cards")
    shown = advance_story(h)
    r.check(shown >= 2, "clicked CONTINUE through {} cards".format(shown))
    r.check(scene_is(h, "GameplayScene") and game.level_index == 0,
            "the last card leads into level 1 (got {} index {})".format(
                h.scene_name(), game.level_index))
    r.check(game.mode == C.MODE_STORY, "still in story mode inside the level")

    # -- clear it -----------------------------------------------------------
    h.context("v2: clearing story level 1")
    won = clear_level(h, pilot)
    r.check(won, "story level 1 ends in VictoryScene (got {})".format(
        h.scene_name()))
    if not won:
        return
    result = dict(game.last_result)
    r.check(result.get("mode") == C.MODE_STORY and result.get("story") is True,
            "the result is stamped as a story run")
    r.check(int(result.get("next_index", -1)) == 1,
            "the result names next_index 1 (got {})".format(
                result.get("next_index")))
    r.check(game.save.story_progress == 1,
            "save.story_progress advanced to 1 (got {})".format(
                game.save.story_progress))

    h.step(90)                       # star ceremony
    labels = button_labels(game.scene)
    r.check("CONTINUE" in labels,
            "the story victory screen offers CONTINUE (buttons: {})".format(
                labels))
    r.check("NEXT LEVEL" not in labels,
            "...and not the free-play NEXT LEVEL (buttons: {})".format(labels))

    h.context("v2: victory -> story -> level 2")
    r.check(h.click_button("CONTINUE"), "clicked CONTINUE")
    h.step(20)
    r.check(scene_is(h, "StoryScene"),
            "CONTINUE goes back through StoryScene (got {})".format(
                h.scene_name()))
    scene = game.scene
    titles = [str(getattr(c, "title", "")) for c in getattr(scene, "cards", [])]
    beat0, beat1 = S.get_beat(0), S.get_beat(1)
    r.check(beat0.title in titles,
            "the deck carries level 1's outro ({!r} in {})".format(
                beat0.title, titles))
    r.check(beat1.title in titles,
            "the deck carries level 2's intro ({!r} in {})".format(
                beat1.title, titles))
    r.check(dict(getattr(scene, "next_kwargs", {})).get("level_index") == 1,
            "the deck hands over with level_index 1 ({!r})".format(
                getattr(scene, "next_kwargs", {})))
    r.check(game.save.beat_seen(0),
            "beat 0 was marked seen ({})".format(sorted(game.save.seen_beats)))

    advance_story(h)
    r.check(scene_is(h, "GameplayScene") and game.level_index == 1,
            "level 2 starts (got {} index {})".format(
                h.scene_name(), game.level_index))

    game.save.save()
    on_disk = SaveData.load(h.save_path)
    r.check(on_disk.story_progress >= 1,
            "the save file on disk holds story_progress {}".format(
                on_disk.story_progress))
    r.check(0 in on_disk.seen_beats,
            "the save file on disk holds the seen beat ({})".format(
                sorted(on_disk.seen_beats)))

    # -- the final level ----------------------------------------------------
    h.context("v2: the final level")
    last = LEVEL_COUNT - 1
    game.mode = C.MODE_STORY
    game.save.unlock_through(last)
    game.last_result = {
        "score": 1200, "level_index": last, "level_name": "Prism Core",
        "food_eaten": 30, "goal_food": 30, "stars": 3, "new_best": True,
        "won": True, "elapsed": 95.0, "max_combo": 9, "deaths": 0,
        "mode": C.MODE_STORY, "story": True, "next_index": last + 1,
        "final_level": True, "story_complete": True,
        "difficulty": game.difficulty,
    }
    game.switch_scene(C.SCENE_VICTORY)
    h.step(100)
    labels = button_labels(game.scene)
    r.check("CONTINUE" in labels,
            "the final-level victory still offers CONTINUE ({})".format(labels))
    r.check("NEXT LEVEL" not in labels,
            "...and no NEXT LEVEL past the end ({})".format(labels))
    r.check(h.click_button("CONTINUE"), "clicked CONTINUE on the last level")
    h.step(20)
    r.check(scene_is(h, "StoryScene"),
            "the last CONTINUE opens the epilogue deck (got {})".format(
                h.scene_name()))
    scene = game.scene
    titles = [str(getattr(c, "title", "")) for c in getattr(scene, "cards", [])]
    r.check(str(S.EPILOGUE.title) in titles,
            "the epilogue card is in the deck ({!r} in {})".format(
                S.EPILOGUE.title, titles))
    r.check(getattr(scene, "next_scene", None) == C.SCENE_MENU,
            "the epilogue hands back to the menu (got {!r})".format(
                getattr(scene, "next_scene", None)))
    r.check(game.save.story_complete,
            "save.story_complete is set")
    advance_story(h)
    r.check(scene_is(h, "MenuScene"),
            "the epilogue returns to the menu (got {})".format(h.scene_name()))

    game.save.save()
    on_disk = SaveData.load(h.save_path)
    r.check(on_disk.story_complete,
            "the save file on disk records the campaign as complete")

    # An empty deck must not strand the player on a blank screen.
    h.context("v2: empty story deck")
    game.switch_scene(C.SCENE_STORY, cards=[], next_scene=C.SCENE_MENU,
                      next_kwargs={})
    h.step(10)
    r.check(scene_is(h, "MenuScene"),
            "an empty card deck passes straight through (got {})".format(
                h.scene_name()))


def run_v2_free_play(h: Harness) -> None:
    """Free play: the level select header really re-reads per-difficulty."""
    r = REPORT
    game = h.game
    pilot = Pilot(h)
    r.head("PART 2d  free play and the per-difficulty level select")

    wipe_save(h)
    game.save.unlock_through(3)
    # Two different records for the same level under two difficulties: the
    # header switch is only meaningful if the cards actually re-read.
    game.save.record(0, 900, 3, difficulty=C.DIFF_NORMAL)
    game.save.record(0, 120, 1, difficulty=C.DIFF_HARD)
    game.difficulty = C.DIFF_NORMAL
    game.save.set_difficulty(C.DIFF_NORMAL)

    h.context("v2: menu -> levels")
    game.switch_scene(C.SCENE_MENU)
    h.step(16)
    r.check(h.click_button("LEVELS"), "clicked LEVELS")
    h.step(50)
    r.check(scene_is(h, "LevelSelectScene"), "LEVELS -> LevelSelectScene")
    r.check(game.mode == C.MODE_FREE,
            "LEVELS set game.mode to {!r}".format(game.mode))

    def record0() -> Any:
        return getattr(game.scene, "_records", [None])[0]

    before = record0()
    r.check(before is not None and int(getattr(before, "best", 0)) == 900,
            "on NORMAL the level 1 card reads best 900 (got {})".format(
                getattr(before, "best", None)))
    r.check(int(getattr(before, "stars", 0)) == 3,
            "...and 3 stars (got {})".format(getattr(before, "stars", None)))

    h.context("v2: level select difficulty switch")
    for key, want_best, want_stars in ((C.DIFF_HARD, 120, 1),
                                       (C.DIFF_EXPERT, 0, 0),
                                       (C.DIFF_NORMAL, 900, 3)):
        r.check(h.click_data(key), "clicked the {} header tile".format(key))
        h.step(24)
        rec = record0()
        ok = (game.difficulty == key
              and rec is not None
              and int(getattr(rec, "best", -1)) == want_best
              and int(getattr(rec, "stars", -1)) == want_stars)
        r.check(ok, "header {:<6} -> game.difficulty={!r}, card reads "
                    "best={} stars={}".format(
                        key, game.difficulty,
                        getattr(rec, "best", None), getattr(rec, "stars", None)))
        r.check(scene_is(h, "LevelSelectScene"),
                "...and stayed on the level select")

    h.context("v2: free play victory buttons")
    game.difficulty = C.DIFF_EASY
    tile = find_button_by_data(game.scene, 0)
    r.check(tile is not None, "the level select exposes tile 1")
    if tile is not None:
        cx, cy = tile.rect.center
        h.click(cx, cy)
        h.step(24)
    r.check(scene_is(h, "GameplayScene") and game.level_index == 0,
            "tile 1 starts level 1 in free mode (got {})".format(h.scene_name()))
    r.check(game.mode == C.MODE_FREE, "the run is a free-play run")

    won = clear_level(h, pilot)
    r.check(won, "the free-play level clears (got {})".format(h.scene_name()))
    if not won:
        return
    h.step(90)
    labels = button_labels(game.scene)
    for want in ("NEXT LEVEL", "REPLAY", "LEVEL SELECT", "MENU"):
        r.check(want in labels,
                "free victory offers {:<12} (buttons: {})".format(want, labels))
    r.check("CONTINUE" not in labels,
            "free victory does NOT offer the story CONTINUE ({})".format(labels))


def run_v2_settings(h: Harness) -> None:
    """Settings from both entry points, every control, and the reset guard."""
    from snake.core.save import SaveData

    r = REPORT
    game = h.game
    r.head("PART 2e  settings, from the menu and from the pause overlay")

    wipe_save(h)

    # -- from the menu -------------------------------------------------------
    h.context("v2: settings from the menu")
    game.switch_scene(C.SCENE_MENU)
    h.step(16)
    r.check(h.click_button("SETTINGS"), "clicked SETTINGS on the menu")
    h.step(20)
    r.check(scene_is(h, "SettingsScene"),
            "menu SETTINGS -> SettingsScene (got {})".format(h.scene_name()))

    h.context("v2: display mode")
    seen_modes = [game.display_mode]
    for _ in range(len(C.DISPLAY_MODES) + 1):
        if not h.click_data("display_next"):
            r.fail("settings has no display-mode control")
            break
        h.step(8)
        seen_modes.append(game.display_mode)
    r.check(set(seen_modes) == set(C.DISPLAY_MODES),
            "cycling display mode visits every mode ({})".format(
                " -> ".join(seen_modes)))
    r.check(h.click_data("display_prev"), "the display-mode '<' arrow exists")
    h.step(8)
    game.save.save()
    r.check(SaveData.load(h.save_path).display_mode == game.display_mode,
            "the display mode is persisted ({!r})".format(game.display_mode))

    h.context("v2: visual effect toggles")
    fx = game.fx
    flags = (("bloom", "bloom_enabled"), ("scanlines", "scanlines_enabled"),
             ("grain", "grain_enabled"), ("shake", "shake_enabled"))
    for key, attr in flags:
        before = bool(getattr(fx, attr, True))
        if not h.click_data("fx:" + key):
            r.fail("settings has no {!r} toggle".format(key))
            continue
        h.step(8)
        after = bool(getattr(fx, attr, before))
        r.check(after != before,
                "fx toggle {:<10} flipped {} -> {}".format(key, before, after))
        h.click_data("fx:" + key)    # put it back
        h.step(6)
        r.check(bool(getattr(fx, attr, None)) == before,
                "fx toggle {:<10} restores".format(key))

    h.context("v2: sound")
    was = bool(game.audio.muted)
    r.check(h.click_data("sound"), "clicked the SOUND control")
    h.step(8)
    r.check(bool(game.audio.muted) != was,
            "SOUND flips mute {} -> {}".format(was, game.audio.muted))
    game.save.save()
    r.check(SaveData.load(h.save_path).muted == bool(game.audio.muted),
            "mute is persisted")
    h.click_data("sound")
    h.step(6)
    r.check(bool(game.audio.muted) == was, "SOUND flips back")

    h.context("v2: difficulty chips")
    for key in C.DIFFICULTIES:
        if not h.click_data("diff:" + key):
            r.fail("settings has no {!r} chip".format(key))
            continue
        h.step(8)
        r.check(game.difficulty == key and scene_is(h, "SettingsScene"),
                "settings chip {:<6} -> game.difficulty={!r}".format(
                    key, game.difficulty))

    # -- the reset guard -----------------------------------------------------
    h.context("v2: RESET PROGRESS needs its confirm step")
    game.save.unlock_through(6)
    game.save.record(0, 777, 3, difficulty=game.difficulty)
    game.save.save()
    guarded = SaveData.load(h.save_path)
    r.check(guarded.best_for(0, difficulty=game.difficulty) == 777,
            "seeded a best score to wipe ({})".format(
                guarded.best_for(0, difficulty=game.difficulty)))

    r.check(h.click_data("reset"), "clicked RESET PROGRESS")
    h.step(10)
    r.check(game.save.best_for(0, difficulty=game.difficulty) == 777,
            "one click does NOT wipe the save (best still {})".format(
                game.save.best_for(0, difficulty=game.difficulty)))
    r.check(find_button_by_data(game.scene, "reset_confirm") is not None,
            "a CONFIRM button appeared")
    r.check(find_button_by_data(game.scene, "reset_cancel") is not None,
            "a CANCEL button appeared")

    r.check(h.click_data("reset_cancel"), "clicked CANCEL")
    h.step(10)
    r.check(game.save.best_for(0, difficulty=game.difficulty) == 777,
            "CANCEL leaves the save alone")
    r.check(find_button_by_data(game.scene, "reset") is not None,
            "the row went back to RESET PROGRESS")

    h.click_data("reset")
    h.step(10)
    r.check(h.click_data("reset_confirm"), "clicked CONFIRM")
    h.step(10)
    r.check(game.save.best_for(0, difficulty=game.difficulty) == 0,
            "CONFIRM wipes the save (best now {})".format(
                game.save.best_for(0, difficulty=game.difficulty)))
    r.check(not game.save.is_unlocked(6),
            "CONFIRM relocked the levels")

    h.context("v2: settings BACK returns to the menu")
    r.check(h.click_button("BACK"), "clicked BACK")
    h.step(12)
    r.check(scene_is(h, "MenuScene"),
            "settings opened from the menu backs out to the menu (got {})"
            .format(h.scene_name()))

    # -- from the pause overlay ---------------------------------------------
    h.context("v2: settings from the pause overlay")
    game.switch_scene(C.SCENE_GAME, level_index=0)
    h.step(8)
    game.push_scene(C.SCENE_PAUSE)
    h.step(12)
    r.check(scene_is(h, "PauseScene"), "paused a live run")
    r.check(find_button(game.scene, "SETTINGS") is not None,
            "the pause overlay offers SETTINGS (buttons: {})".format(
                button_labels(game.scene)))
    depth = len(game._stack)
    r.check(h.click_button("SETTINGS"), "clicked SETTINGS on the pause overlay")
    h.step(16)
    r.check(scene_is(h, "SettingsScene"),
            "pause SETTINGS -> SettingsScene (got {})".format(h.scene_name()))
    r.check(len(game._stack) == depth + 1,
            "settings is stacked, not switched: depth {} -> {}".format(
                depth, len(game._stack)))
    r.check([type(s).__name__ for s in game._stack]
            == ["GameplayScene", "PauseScene", "SettingsScene"],
            "the live run survives underneath ({})".format(
                [type(s).__name__ for s in game._stack]))

    h.context("v2: settings BACK returns to the pause overlay")
    r.check(h.click_button("BACK"), "clicked BACK")
    h.step(12)
    r.check(scene_is(h, "PauseScene"),
            "settings opened from pause backs out to pause, not the menu "
            "(got {})".format(h.scene_name()))
    r.check([type(s).__name__ for s in game._stack]
            == ["GameplayScene", "PauseScene"],
            "the stack unwound cleanly ({})".format(
                [type(s).__name__ for s in game._stack]))
    r.check(h.click_button("RESUME"), "clicked RESUME")
    h.step(8)
    r.check(scene_is(h, "GameplayScene"),
            "the run resumes after the settings detour (got {})".format(
                h.scene_name()))


def run_v2_difficulty_play(h: Harness) -> None:
    """
    One real level on each difficulty, asserting the settings actually bite.

    A difficulty screen that writes a string nobody reads is exactly the kind
    of defect a seven-way parallel build produces, so this measures the three
    things the player can feel: how many lives they get, how fast the snake
    moves, and whether their own tail kills them.
    """
    from snake.core import difficulty as D

    r = REPORT
    game = h.game
    pilot = Pilot(h)
    r.head("PART 2f  one level on each difficulty (the settings must bite)")

    wipe_save(h)
    game.save.unlock_through(3)
    game.mode = C.MODE_FREE

    r.log("  {:<8} {:>6} {:>10} {:>10} {:>10} {:>7} {:>6}".format(
        "diff", "lives", "speed", "selfkill", "skip", "frames", "eaten"))
    r.log("  " + "-" * 62)

    seen: Dict[str, Dict[str, Any]] = {}
    for key in C.DIFFICULTIES:
        diff = D.get_difficulty(key)
        game.difficulty = key
        game.save.set_difficulty(key)
        h.context("v2: playing level 1 on {}".format(key))
        game.switch_scene(C.SCENE_GAME, level_index=0)
        h.step(6)
        scene = game.scene
        scene.ready_timer = 0.0
        h.step(2)

        # Snapshot what the scene resolved out of the difficulty.
        info = {
            "lives": int(getattr(scene, "lives", -1)),
            "speed": float(getattr(scene.snake, "speed", 0.0)),
            "self_enabled": bool(getattr(scene, "self_enabled", True)),
            "self_skip": getattr(scene, "self_skip", None),
            "diff_key": getattr(getattr(scene, "diff", None), "key", None),
        }
        eaten_before = int(scene.food_eaten)
        play_until(h, pilot, 900, lambda: h.scene_name() != "GameplayScene")
        live = game.scene if h.scene_name() == "GameplayScene" else None
        info["eaten"] = (int(live.food_eaten) - eaten_before) if live is not None \
            else int(game.last_result.get("food_eaten", 0))
        seen[key] = info

        r.log("  {:<8} {:>6} {:>10.1f} {:>10} {:>10} {:>7} {:>6}".format(
            key, info["lives"], info["speed"],
            str(info["self_enabled"]), str(info["self_skip"]), 900,
            info["eaten"]))

        r.check(info["diff_key"] == key,
                "{:<6} the level resolved difficulty {!r}".format(
                    key, info["diff_key"]))
        r.check(info["lives"] == D.lives_for(diff),
                "{:<6} lives = {} (difficulty says {})".format(
                    key, info["lives"], D.lives_for(diff)))
        r.check(info["self_enabled"] == D.self_collision_enabled(diff),
                "{:<6} self-collision enabled = {} (difficulty says {})".format(
                    key, info["self_enabled"], D.self_collision_enabled(diff)))

    # -- and now the differences ------------------------------------------
    lives = [seen[k]["lives"] for k in C.DIFFICULTIES]
    speeds = [seen[k]["speed"] for k in C.DIFFICULTIES]
    kills = [seen[k]["self_enabled"] for k in C.DIFFICULTIES]

    r.check(len(set(lives)) == len(lives),
            "every difficulty grants a different number of lives ({})".format(
                lives))
    r.check(lives == sorted(lives, reverse=True),
            "lives fall as difficulty rises ({})".format(lives))
    r.check(len(set(round(s, 3) for s in speeds)) == len(speeds),
            "every difficulty runs at a different speed ({})".format(
                [round(s, 1) for s in speeds]))
    r.check(speeds == sorted(speeds),
            "speed rises with difficulty ({})".format(
                [round(s, 1) for s in speeds]))
    r.check(kills[0] is False and all(kills[1:]),
            "EASY forgives the tail and the rest do not ({})".format(kills))
    skips = [seen[k]["self_skip"] for k in C.DIFFICULTIES[1:]]
    r.check(len(set(skips)) == len(skips),
            "the lethal difficulties use different forgiveness windows "
            "({})".format(skips))


# ==========================================================================
# Part 4c: every button on every scene
# ==========================================================================
def _fingerprint(h: Harness) -> Tuple[Any, ...]:
    """
    A cheap snapshot of everything a button is allowed to change.

    Used to prove that an *in-place* control (a difficulty chip, an fx toggle,
    the mute button) did something, since it cannot be judged by a scene
    change.  Dead buttons are the signature defect of a parallel build, and
    "the scene did not change" is exactly what a dead button looks like.
    """
    game = h.game
    scene = game.scene
    fx = game.fx
    parts: List[Any] = [
        h.scene_name(), len(game._stack),
        str(game.difficulty), str(game.mode), str(game.display_mode),
        bool(getattr(game.audio, "muted", False)),
        int(getattr(game, "level_index", 0)), bool(game.running),
        tuple(button_labels(scene)),
        tuple(bool(getattr(b, "enabled", True)) for b in scene_buttons(scene)),
    ]
    for attr in ("confirming", "index", "_restart_arm", "focus",
                 "_launching", "back_target", "done"):
        parts.append(repr(getattr(scene, attr, None)))
    for attr in ("bloom_enabled", "scanlines_enabled", "grain_enabled",
                 "shake_enabled"):
        parts.append(repr(getattr(fx, attr, None)))
    try:
        parts.append(repr(sorted(game.save.to_dict().items())))
    except Exception:
        parts.append("save?")
    return tuple(parts)


def run_v2_button_walk(h: Harness) -> None:
    """
    Click *every* button on *every* scene and require an observable effect.

    The existing button walk checks the routes we know about by label.  This
    one is exhaustive and label-blind: it enumerates whatever each scene
    actually owns, so a control that was added but never wired - or one whose
    handler silently swallows its own exception - is caught.
    """
    r = REPORT
    game = h.game
    r.head("PART 4b  every button on every scene leads somewhere")

    wipe_save(h)
    game.save.unlock_through(11)
    game.mode = C.MODE_FREE

    def result(index: int, won: bool, story: bool) -> Dict[str, Any]:
        return {
            "score": 260, "level_index": index, "level_name": "Deep Nebula",
            "food_eaten": 10, "goal_food": 10, "stars": 2, "new_best": True,
            "won": won, "elapsed": 42.0, "max_combo": 5,
            "deaths": 0 if won else 3,
            "mode": C.MODE_STORY if story else C.MODE_FREE, "story": story,
            "next_index": index + 1, "final_level": index >= 11,
            "difficulty": game.difficulty,
        }

    def enter_menu() -> None:
        game.switch_scene(C.SCENE_MENU)

    def enter_mode() -> None:
        # RESTART STORY only exists once there is a campaign to erase, and it
        # is gated in draw *and* in handle_event.  Seed some progress so the
        # walk exercises the live control instead of excusing a hidden one.
        game.save.set_story_progress(4)
        game.switch_scene(C.SCENE_MODE)

    def enter_levels() -> None:
        game.switch_scene(C.SCENE_LEVELS)

    def enter_help() -> None:
        game.switch_scene(C.SCENE_HELP)

    def enter_settings() -> None:
        game.switch_scene(C.SCENE_SETTINGS, back=C.SCENE_MENU)

    def enter_story() -> None:
        from snake.core import story as S
        game.switch_scene(C.SCENE_STORY, cards=[S.get_chapter(0), S.get_beat(0)],
                          next_scene=C.SCENE_GAME, next_kwargs={"level_index": 0})

    def enter_game() -> None:
        game.switch_scene(C.SCENE_GAME, level_index=0)

    def enter_pause() -> None:
        game.switch_scene(C.SCENE_GAME, level_index=1)
        h.step(4)
        game.push_scene(C.SCENE_PAUSE)

    def enter_victory_free() -> None:
        game.mode = C.MODE_FREE
        game.last_result = result(1, True, False)
        game.switch_scene(C.SCENE_VICTORY)

    def enter_victory_story() -> None:
        game.mode = C.MODE_STORY
        game.last_result = result(1, True, True)
        game.switch_scene(C.SCENE_VICTORY)

    def enter_gameover_free() -> None:
        game.mode = C.MODE_FREE
        game.last_result = result(1, False, False)
        game.switch_scene(C.SCENE_GAMEOVER)

    def enter_gameover_story() -> None:
        game.mode = C.MODE_STORY
        game.last_result = result(1, False, True)
        game.switch_scene(C.SCENE_GAMEOVER)

    screens: List[Tuple[str, Callable[[], None], int]] = [
        ("MenuScene", enter_menu, 20),
        ("ModeSelectScene", enter_mode, 30),
        ("LevelSelectScene", enter_levels, 55),
        ("SettingsScene", enter_settings, 20),
        ("StoryScene", enter_story, 60),
        ("HelpScene", enter_help, 30),
        ("PauseScene", enter_pause, 16),
        ("GameplayScene", enter_game, 16),
        ("VictoryScene (free)", enter_victory_free, 95),
        ("VictoryScene (story)", enter_victory_story, 95),
        ("GameOverScene (free)", enter_gameover_free, 85),
        ("GameOverScene (story)", enter_gameover_story, 85),
    ]

    total_buttons = 0
    dead: List[str] = []
    for name, enter, settle in screens:
        h.context("button walk v2: " + name)
        enter()
        h.step(settle)
        buttons = scene_buttons(game.scene)
        count = len(buttons)
        total_buttons += count
        r.check(count > 0, "{:<22} owns {} button(s)".format(name, count))

        for i in range(count):
            enter()
            h.step(settle)
            here = scene_buttons(game.scene)
            if i >= len(here):
                break
            button = here[i]
            label = str(getattr(button, "label", "")) or "<{!r}>".format(
                getattr(button, "data", i))
            if not getattr(button, "enabled", True):
                continue
            before = _fingerprint(h)
            cx, cy = button.rect.center
            h.click(cx, cy)
            h.step(20)
            after = _fingerprint(h)
            if after == before:
                dead.append("{} / {}".format(name, label))
            # QUIT stops the loop rather than switching scene; put it back.
            if not game.running:
                game.running = True

    r.check(not dead,
            "all {} buttons across {} screens did something ({} dead)".format(
                total_buttons, len(screens), len(dead)))
    for line in dead[:20]:
        r.log("         dead: " + line)

    # The inverse of the walk: a control the scene decides *not* to show must
    # not still be sitting there as an invisible click target.  RESTART STORY
    # is the only conditional button in the build, so it is the only one that
    # can get this wrong.
    h.context("button walk v2: hidden controls stay inert")
    wipe_save(h)
    game.switch_scene(C.SCENE_MODE)
    h.step(30)
    scene = game.scene
    r.check(not scene._show_restart(),
            "on a fresh save the mode picker hides RESTART STORY")
    before = _fingerprint(h)
    hidden = find_button(scene, "RESTART STORY")
    if hidden is not None:
        cx, cy = hidden.rect.center
        h.click(cx, cy)
        h.step(16)
    r.check(_fingerprint(h) == before,
            "clicking where the hidden RESTART STORY sits does nothing")
    r.check(scene_is(h, "ModeSelectScene"),
            "...and does not navigate anywhere (got {})".format(h.scene_name()))


# ==========================================================================
# Part 4d: every button survives the CRT bezel
# ==========================================================================
#: Least fraction of a button's drawn brightness that must reach the screen.
#: The finished frame is pushed through `EffectStack.present`, which lays a
#: 0.80 vignette, a 0.62 squircle edge rolloff and an opaque rounded corner cut
#: over everything - so a control can be perfectly correct, perfectly clickable
#: and still invisible to the player.  0.40 is set just under the worst
#: long-standing v1 control (VictoryScene / MENU at 0.47) so the check pins
#: today's layout without demanding a redesign of the result screens.
BEZEL_FLOOR = 0.40


def _mean_luma(surface: pygame.Surface, rect: pygame.Rect) -> float:
    """Mean of the brightest channel over `rect`, on a 1-in-2 subsample."""
    r = rect.clip(pygame.Rect(0, 0, *surface.get_size()))
    if r.w < 2 or r.h < 2:
        return 0.0
    total, count = 0, 0
    for x in range(r.x, r.right, 2):
        for y in range(r.y, r.bottom, 2):
            px = surface.get_at((x, y))
            total += max(px[0], px[1], px[2])
            count += 1
    return total / float(max(1, count))


def run_v2_legibility(h: Harness) -> None:
    """
    Assert every button is still legible *after* the post-processing.

    Every other check in this file reads game state, and game state cannot see
    this class of defect: the button exists, its handler fires, the flow works
    - and the player cannot see it.  Four v2 controls sat in the bezel when
    this check was written (LevelSelect BACK passed 4% of its own light), which
    is exactly the kind of thing seven agents rendering to a canvas they never
    post-process will each get wrong independently.
    """
    r = REPORT
    game = h.game
    r.head("PART 4c  every button survives the CRT bezel")

    wipe_save(h)
    game.save.unlock_through(11)
    game.save.set_story_progress(4)

    def result(index: int, won: bool, story: bool) -> Dict[str, Any]:
        return {
            "score": 260, "level_index": index, "level_name": "Deep Nebula",
            "food_eaten": 10, "goal_food": 10, "stars": 2, "new_best": True,
            "won": won, "elapsed": 42.0, "max_combo": 5,
            "deaths": 0 if won else 3,
            "mode": C.MODE_STORY if story else C.MODE_FREE, "story": story,
            "next_index": index + 1, "final_level": False,
            "difficulty": game.difficulty,
        }

    def story_deck() -> None:
        from snake.core import story as S
        game.switch_scene(C.SCENE_STORY, cards=[S.get_chapter(0), S.get_beat(0)],
                          next_scene=C.SCENE_MENU, next_kwargs={})

    def pause() -> None:
        game.switch_scene(C.SCENE_GAME, level_index=1)
        h.step(4)
        game.push_scene(C.SCENE_PAUSE)

    def victory(story: bool) -> Callable[[], None]:
        def setup() -> None:
            game.mode = C.MODE_STORY if story else C.MODE_FREE
            game.last_result = result(1, True, story)
            game.switch_scene(C.SCENE_VICTORY)
        return setup

    def gameover() -> None:
        game.mode = C.MODE_FREE
        game.last_result = result(1, False, False)
        game.switch_scene(C.SCENE_GAMEOVER)

    screens: List[Tuple[str, Callable[[], None], int]] = [
        ("MenuScene", lambda: game.switch_scene(C.SCENE_MENU), 40),
        ("ModeSelectScene", lambda: game.switch_scene(C.SCENE_MODE), 50),
        ("LevelSelectScene", lambda: game.switch_scene(C.SCENE_LEVELS), 70),
        ("SettingsScene",
         lambda: game.switch_scene(C.SCENE_SETTINGS, back=C.SCENE_MENU), 40),
        ("StoryScene", story_deck, 220),
        ("HelpScene", lambda: game.switch_scene(C.SCENE_HELP), 45),
        ("PauseScene", pause, 45),
        ("GameplayScene", lambda: game.switch_scene(C.SCENE_GAME, level_index=0), 40),
        ("VictoryScene", victory(False), 140),
        ("VictoryScene/story", victory(True), 140),
        ("GameOverScene", gameover, 120),
    ]

    r.log("  {:<20} {:<18} {:>8} {:>8} {:>7}  {}".format(
        "scene", "button", "canvas", "screen", "ratio", "verdict"))
    r.log("  " + "-" * 72)

    dim: List[str] = []
    checked = 0
    for name, enter, settle in screens:
        h.context("legibility: " + name)
        enter()
        # The scene-change wipe is itself a full-screen overlay, so the frame
        # has to be fully settled or every button would read as "dark".
        h.step(settle)
        for button in scene_buttons(game.scene):
            if not getattr(button, "enabled", True):
                continue
            rect = pygame.Rect(button.rect)
            drawn = _mean_luma(game.canvas, rect)
            shown = _mean_luma(game.screen, rect)
            if drawn < 1.0:
                continue          # nothing was drawn there this frame
            ratio = shown / drawn
            checked += 1
            label = (str(getattr(button, "label", ""))
                     or str(getattr(button, "data", "")))[:18]
            if ratio < BEZEL_FLOOR:
                dim.append("{} / {} at {} -> {:.2f}".format(
                    name, label, tuple(rect), ratio))
                r.log("  {:<20} {:<18} {:>8.1f} {:>8.1f} {:>7.2f}  DIM".format(
                    name, label, drawn, shown, ratio))
            elif ratio < 0.55:
                r.log("  {:<20} {:<18} {:>8.1f} {:>8.1f} {:>7.2f}  tight".format(
                    name, label, drawn, shown, ratio))

    r.check(not dim,
            "all {} visible buttons pass {:.0%} of their light through the "
            "bezel ({} too dim)".format(checked, BEZEL_FLOOR, len(dim)))
    for line in dim[:12]:
        r.log("         dim: " + line)


# ==========================================================================
# Part 3b: the v2 scenes are cached too, so they must reset on re-entry
# ==========================================================================
def run_v2_reuse(h: Harness) -> None:
    """Enter every scene twice and assert the second visit starts clean."""
    r = REPORT
    game = h.game
    r.head("PART 3b  scene reuse for the v2 screens")

    wipe_save(h)
    game.save.unlock_through(11)

    def visit_twice(name: str, enter: Callable[[], None], settle: int,
                    dirty: Callable[[], None]) -> Tuple[Any, Any]:
        enter()
        h.step(settle)
        first = game.scene
        dirty()
        h.step(6)
        game.switch_scene(C.SCENE_MENU)
        h.step(8)
        enter()
        h.step(4)
        return first, game.scene

    # -- mode select --------------------------------------------------------
    h.context("reuse: mode select")

    def enter_mode() -> None:
        game.switch_scene(C.SCENE_MODE)

    def dirty_mode() -> None:
        h.click_data(("diff", C.DIFF_EXPERT))
        h.click_button("RESTART STORY")      # arms the two-click confirm

    first, second = visit_twice("mode", enter_mode, 30, dirty_mode)
    r.check(second is first, "the ModeSelectScene instance is reused")
    r.check(abs(float(getattr(second, "_t", 1.0))) < 0.2,
            "mode select clock restarted (_t={:.3f})".format(
                float(getattr(second, "_t", -1.0))))
    r.check(abs(float(getattr(second, "_elapsed", 1.0))) < 0.2,
            "mode select entrance restarted")
    r.check(not getattr(second, "_launching", False),
            "mode select is not mid-launch")
    r.check(float(getattr(second, "_restart_arm", 0.0)) <= 0.0,
            "the RESTART STORY confirm disarmed (got {})".format(
                getattr(second, "_restart_arm", None)))

    # -- settings -----------------------------------------------------------
    h.context("reuse: settings")

    def enter_settings() -> None:
        game.switch_scene(C.SCENE_SETTINGS, back=C.SCENE_MENU)

    def dirty_settings() -> None:
        h.click_data("reset")                 # leaves the row in confirm state

    first, second = visit_twice("settings", enter_settings, 20, dirty_settings)
    r.check(second is first, "the SettingsScene instance is reused")
    r.check(not getattr(second, "confirming", False),
            "the RESET confirm state was cleared on re-entry")
    r.check(find_button_by_data(second, "reset") is not None,
            "the reset row is back to its one-click face")
    r.check(getattr(second, "back_target", None) == C.SCENE_MENU,
            "back_target re-resolved (got {!r})".format(
                getattr(second, "back_target", None)))
    # ...and a different back target on the next visit really takes.
    game.switch_scene(C.SCENE_SETTINGS, back=C.SCENE_LEVELS)
    h.step(10)
    r.check(getattr(game.scene, "back_target", None) == C.SCENE_LEVELS,
            "a second visit with back={!r} re-targets BACK (got {!r})".format(
                C.SCENE_LEVELS, getattr(game.scene, "back_target", None)))
    h.click_button("BACK")
    h.step(12)
    r.check(scene_is(h, "LevelSelectScene"),
            "...and BACK really goes there (got {})".format(h.scene_name()))

    # -- story --------------------------------------------------------------
    h.context("reuse: story")
    from snake.core import story as S

    def enter_story() -> None:
        game.switch_scene(C.SCENE_STORY,
                          cards=[S.get_chapter(0), S.get_beat(0), S.get_beat(1)],
                          next_scene=C.SCENE_MENU, next_kwargs={})

    enter_story()
    h.step(40)
    first = game.scene
    advance_story(h, limit=2)             # move off card 0
    moved = int(getattr(game.scene, "index", 0))
    game.switch_scene(C.SCENE_MENU)
    h.step(8)
    game.switch_scene(C.SCENE_STORY, cards=[S.get_beat(2)],
                      next_scene=C.SCENE_GAME, next_kwargs={"level_index": 2})
    h.step(6)
    second = game.scene
    r.check(second is first, "the StoryScene instance is reused")
    r.check(moved > 0, "the first visit really advanced ({} cards)".format(moved))
    r.check(int(getattr(second, "index", -1)) == 0,
            "the card index reset to 0 (got {})".format(
                getattr(second, "index", None)))
    r.check(len(getattr(second, "cards", [])) == 1,
            "the new deck replaced the old one ({} cards)".format(
                len(getattr(second, "cards", []))))
    r.check(getattr(second, "next_scene", None) == C.SCENE_GAME,
            "the new hand-off replaced the old one (got {!r})".format(
                getattr(second, "next_scene", None)))
    r.check(not getattr(second, "done", False),
            "the finished latch reset")

    # -- level select -------------------------------------------------------
    h.context("reuse: level select")
    game.difficulty = C.DIFF_NORMAL
    game.switch_scene(C.SCENE_LEVELS)
    h.step(55)
    first = game.scene
    h.click_data(C.DIFF_EXPERT)
    h.step(20)
    game.switch_scene(C.SCENE_MENU)
    h.step(8)
    game.switch_scene(C.SCENE_LEVELS)
    h.step(6)
    second = game.scene
    r.check(second is first, "the LevelSelectScene instance is reused")
    r.check(abs(float(getattr(second, "elapsed", 1.0))) < 0.2,
            "level select entrance clock restarted (elapsed={:.3f})".format(
                float(getattr(second, "elapsed", -1.0))))
    r.check(all(float(getattr(c, "appear", 1.0)) < 1.0 for c in second.cards),
            "the tiles replay their entrance rather than starting settled")
    r.check(0 <= int(getattr(second, "focus", -1)) < len(second.cards),
            "the focused tile is a real index (got {})".format(
                getattr(second, "focus", None)))
    r.check(game.difficulty == C.DIFF_EXPERT,
            "the difficulty chosen on the header survived the round trip")
    r.check(all(getattr(c.button, "hovered", False) is False
                for c in second.cards),
            "no tile is stuck in its hovered state from the last visit")

    # -- pause --------------------------------------------------------------
    h.context("reuse: pause")
    game.switch_scene(C.SCENE_GAME, level_index=0)
    h.step(6)
    game.push_scene(C.SCENE_PAUSE)
    h.step(20)
    first = game.scene
    game.pop_scene()
    h.step(6)
    game.push_scene(C.SCENE_PAUSE)
    h.step(3)
    second = game.scene
    r.check(second is first, "the PauseScene instance is reused")
    r.check(float(getattr(second, "intro", 1.0)) < 0.9,
            "the pause panel re-animates in (intro={:.2f})".format(
                float(getattr(second, "intro", -1.0))))
    r.check(not getattr(second, "_closing", True),
            "the pause overlay is not stuck in its closing state")
    game.pop_scene()
    h.step(4)

    # -- result screens ------------------------------------------------------
    h.context("reuse: victory / gameover")
    for name, cls in ((C.SCENE_VICTORY, "VictoryScene"),
                      (C.SCENE_GAMEOVER, "GameOverScene")):
        game.mode = C.MODE_FREE
        game.last_result = {
            "score": 800, "level_index": 2, "level_name": "Emerald Circuit",
            "food_eaten": 12, "goal_food": 12, "stars": 3, "new_best": True,
            "won": name == C.SCENE_VICTORY, "elapsed": 30.0, "max_combo": 7,
            "deaths": 0, "mode": C.MODE_FREE, "story": False,
            "next_index": 3, "final_level": False,
        }
        game.switch_scene(name)
        h.step(120)
        first = game.scene
        shown_first = float(getattr(first, "shown", getattr(first, "t", 0.0)))
        game.switch_scene(C.SCENE_MENU)
        h.step(8)
        game.last_result = dict(game.last_result, score=10, stars=1,
                                new_best=False, level_index=0,
                                level_name="Neon Grid")
        game.switch_scene(name)
        h.step(4)
        second = game.scene
        r.check(second is first, "the {} instance is reused".format(cls))
        r.check(float(getattr(second, "t", 1.0)) < 0.3,
                "{} clock restarted (t={:.3f})".format(
                    cls, float(getattr(second, "t", -1.0))))
        r.check(int(getattr(second, "level_index", -1)) == 0,
                "{} re-read the new result (level_index={})".format(
                    cls, getattr(second, "level_index", None)))
        r.check(shown_first >= 0.0, "{} ran its first visit".format(cls))


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
    * every registry entry builds the class it claims.

    ``PENDING`` used to hold the v2 scene names whose modules had not been
    written yet, and it was the only slack in this check.  All ten scenes now
    exist, so it is **empty** and every entry must build - a scene that fails
    to import is a hard failure with nowhere left to hide.
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

    #: Registered scene names whose module has not landed yet.  Every v2
    #: scene now exists, so this is empty and the check below is fully hard.
    PENDING: set = set()

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
        r.log("  note: {} registered but not yet implemented".format(
            ", ".join(repr(n) for n in sorted(pending_seen))))
    r.check(set(pending_seen) <= PENDING,
            "no scene outside the declared pending set failed to build")
    r.check(not PENDING,
            "the pending-scene set is empty - all {} scenes must build "
            "({} declared)".format(len(expected), len(declared)))
    built = [n for n in expected if n in SCENE_REGISTRY and n not in pending_seen]
    r.check(len(built) == 10,
            "all ten scenes resolved from the registry ({} built)".format(
                len(built)))


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
    parser.add_argument("--only", default="",
                        help="comma-separated section names to run "
                             "(registry, flow, mode, story, free, settings, "
                             "difficulty, reuse, v2reuse, buttons, v2buttons, "
                             "legibility, canaries, sweep); default is all")
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
        sections: List[Tuple[str, Callable[[], None]]] = [
            ("registry", lambda: run_registry(harness)),
            ("flow", lambda: run_flow(harness)),
            ("mode", lambda: run_v2_mode_select(harness)),
            ("story", lambda: run_v2_story(harness)),
            ("free", lambda: run_v2_free_play(harness)),
            ("settings", lambda: run_v2_settings(harness)),
            ("difficulty", lambda: run_v2_difficulty_play(harness)),
            ("reuse", lambda: run_reuse(harness)),
            ("v2reuse", lambda: run_v2_reuse(harness)),
            ("buttons", lambda: run_button_walk(harness)),
            ("v2buttons", lambda: run_v2_button_walk(harness)),
            ("legibility", lambda: run_v2_legibility(harness)),
            ("canaries", lambda: run_detector_canaries(harness, spy)),
            ("sweep", lambda: run_level_sweep(harness, frames, timing)),
        ]
        wanted = {s.strip() for s in args.only.split(",") if s.strip()}
        if wanted:
            unknown = wanted - {name for name, _ in sections}
            if unknown:
                parser.error("unknown section(s): " + ", ".join(sorted(unknown)))
        for name, run in sections:
            if not wanted or name in wanted:
                run()
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
