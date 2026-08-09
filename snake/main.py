"""
Window, main loop and scene manager.

`Game` owns everything that outlives a single scene: the display, the clock,
fonts, audio, the save file, the particle pool and the post-processing stack.
Scenes are created lazily from a registry so that importing this module never
drags in the whole package.

Render path
-----------
Scenes never draw to the display surface directly.  They draw onto
`game.canvas`, an offscreen surface of the same size, and the effect stack
composites that onto the real screen while applying shake, flash, chromatic
aberration, vignette and scene transitions.  That is what makes the global
effects possible at all.
"""

from __future__ import annotations

import importlib
import os
import sys
import traceback
from typing import Any, Dict, List, Optional, Tuple

import pygame

from . import config as C
from . import palette as P
from .core.contracts import Scene

# name -> (module suffix, class name).  Imported on first use.
SCENE_REGISTRY: Dict[str, Tuple[str, str]] = {
    C.SCENE_MENU: ("menu", "MenuScene"),
    C.SCENE_LEVELS: ("level_select", "LevelSelectScene"),
    C.SCENE_GAME: ("gameplay", "GameplayScene"),
    C.SCENE_PAUSE: ("pause", "PauseScene"),
    C.SCENE_GAMEOVER: ("gameover", "GameOverScene"),
    C.SCENE_VICTORY: ("gameover", "VictoryScene"),
    C.SCENE_HELP: ("help_scene", "HelpScene"),
    C.SCENE_MODE: ("mode_select", "ModeSelectScene"),
    C.SCENE_SETTINGS: ("settings", "SettingsScene"),
    C.SCENE_STORY: ("story_scene", "StoryScene"),
}


class Game:
    """The application object.  One instance per process."""

    def __init__(self, headless: bool = False) -> None:
        self.headless = headless

        # A headless run still needs a *video mode*: SDL refuses to hand out a
        # pixel format for Surface.convert() until one exists, and every glow
        # cache in gfx/ leans on convert()/convert_alpha().  The dummy drivers
        # give us one without a window or a sound device.  These have to be set
        # before pygame.init(), which is why they live here and not in the
        # caller.
        if headless:
            os.environ.setdefault("SDL_VIDEODRIVER", "dummy")
            os.environ.setdefault("SDL_AUDIODRIVER", "dummy")

        pygame.init()
        pygame.display.set_caption(f"{C.GAME_TITLE} - {C.GAME_SUBTITLE}")

        # --- display -----------------------------------------------------
        # The window may be any size, or fullscreen.  Everything else in the
        # game is authored against the fixed CANVAS_SIZE and knows nothing
        # about the real window: draw() scales the finished canvas into a
        # centred, aspect-preserved viewport and _to_canvas() maps physical
        # mouse coordinates back the other way.
        self.display_mode: str = C.DEFAULT_DISPLAY_MODE
        self.windowed_size: Tuple[int, int] = C.WINDOW_SIZE
        self.viewport = pygame.Rect(0, 0, C.WINDOW_W, C.WINDOW_H)
        self.view_scale: float = 1.0
        self.screen = None  # type: ignore[assignment]

        self._apply_display_mode(C.DEFAULT_DISPLAY_MODE, initial=True)

        # Scenes draw here; the effect stack composites it into `present_buf`,
        # which is then scaled to the window.
        self.canvas = self._new_surface(C.CANVAS_SIZE)
        self.present_buf = self._new_surface(C.CANVAS_SIZE)

        self.clock = pygame.time.Clock()
        self.running = True
        self.time = 0.0
        self.frame = 0
        self.fps = 0.0

        # --- long-lived subsystems ---------------------------------------
        from .gfx.fonts import FontBook
        from .core.save import SaveData
        from .core.audio import Audio
        from .gfx.particles import ParticleSystem
        from .gfx.effects import EffectStack

        self.fonts = FontBook()
        self.save = SaveData.load(C.SAVE_PATH)
        self.audio = Audio(muted=self.save.muted, headless=headless)
        self.particles = ParticleSystem(C.MAX_PARTICLES)
        self.fx = EffectStack()

        # --- input state --------------------------------------------------
        self.mouse_pos: Tuple[float, float] = (C.WINDOW_W * 0.5, C.WINDOW_H * 0.5)
        self.mouse_buttons: Dict[int, bool] = {1: False, 2: False, 3: False}
        self.cursor_trail: List[Tuple[float, float]] = []

        # --- session state shared between scenes --------------------------
        self.level_index: int = 0
        self.last_result: Dict[str, Any] = {}
        # Story plays the campaign in order; free play picks any unlocked level.
        self.mode: str = C.DEFAULT_MODE
        self.difficulty: str = C.DEFAULT_DIFFICULTY

        # Restore persisted preferences now that the save file is loaded.
        saved_diff = getattr(self.save, "difficulty", None)
        if saved_diff in C.DIFFICULTIES:
            self.difficulty = saved_diff
        saved_mode = getattr(self.save, "mode", None)
        if saved_mode in C.GAME_MODES:
            self.mode = saved_mode
        saved_display = getattr(self.save, "display_mode", None)
        if saved_display in C.DISPLAY_MODES and saved_display != self.display_mode:
            self._apply_display_mode(saved_display)

        # --- scene stack --------------------------------------------------
        self._stack: List[Scene] = []
        self._scene_cache: Dict[str, Scene] = {}

        if not headless:
            pygame.mouse.set_visible(False)

    # ------------------------------------------------------------------
    # Display: window, fullscreen, letterbox viewport, mouse mapping
    # ------------------------------------------------------------------
    def _new_surface(self, size: Tuple[int, int]) -> pygame.Surface:
        """A drawing surface, converted to the display format when possible."""
        surf = pygame.Surface(size)
        try:
            return surf.convert()
        except pygame.error:
            return surf

    def _desktop_size(self) -> Tuple[int, int]:
        try:
            sizes = pygame.display.get_desktop_sizes()
            if sizes:
                return sizes[0]
        except Exception:
            pass
        try:
            info = pygame.display.Info()
            if info.current_w > 0 and info.current_h > 0:
                return (info.current_w, info.current_h)
        except Exception:
            pass
        return C.WINDOW_SIZE

    def _apply_display_mode(self, mode: str, *, initial: bool = False) -> None:
        """(Re)create the display surface for `mode`, falling back gracefully."""
        if mode not in C.DISPLAY_MODES:
            mode = C.DISPLAY_WINDOWED

        if self.headless:
            # No real window; a plain surface is enough and never fails.
            self.screen = pygame.Surface(C.WINDOW_SIZE)
            self.display_mode = mode
            self._rebuild_viewport()
            return

        # Remember the windowed size so returning from fullscreen restores it.
        if not initial and self.display_mode == C.DISPLAY_WINDOWED and self.screen is not None:
            self.windowed_size = self.screen.get_size()

        if mode == C.DISPLAY_WINDOWED:
            size = self.windowed_size or C.WINDOW_SIZE
            size = (max(size[0], C.MIN_WINDOW_W), max(size[1], C.MIN_WINDOW_H))
            flags = pygame.RESIZABLE
        elif mode == C.DISPLAY_BORDERLESS:
            size = self._desktop_size()
            flags = pygame.NOFRAME
        else:  # DISPLAY_FULLSCREEN
            size = self._desktop_size()
            flags = pygame.FULLSCREEN

        try:
            self.screen = pygame.display.set_mode(size, flags)
            self.display_mode = mode
        except pygame.error:
            # Fall back to a plain window, then to an offscreen surface.
            try:
                self.screen = pygame.display.set_mode(C.WINDOW_SIZE, pygame.RESIZABLE)
                self.display_mode = C.DISPLAY_WINDOWED
            except pygame.error:
                self.screen = pygame.Surface(C.WINDOW_SIZE)
                self.display_mode = C.DISPLAY_WINDOWED

        self._rebuild_viewport()

    def set_display_mode(self, mode: str) -> None:
        """Switch display mode and persist the choice."""
        if mode == self.display_mode:
            return
        self._apply_display_mode(mode)
        try:
            self.save.display_mode = self.display_mode
        except Exception:
            pass

    def cycle_display_mode(self) -> str:
        """Advance to the next display mode; returns the new one."""
        try:
            i = C.DISPLAY_MODES.index(self.display_mode)
        except ValueError:
            i = 0
        self.set_display_mode(C.DISPLAY_MODES[(i + 1) % len(C.DISPLAY_MODES)])
        return self.display_mode

    def toggle_fullscreen(self) -> None:
        """F11 / Alt+Enter: flip between windowed and fullscreen."""
        if self.display_mode == C.DISPLAY_WINDOWED:
            self.set_display_mode(C.DISPLAY_FULLSCREEN)
        else:
            self.set_display_mode(C.DISPLAY_WINDOWED)

    def _rebuild_viewport(self) -> None:
        """Recompute the centred, aspect-preserved target rect for the canvas."""
        if self.screen is None:
            self.viewport = pygame.Rect(0, 0, C.WINDOW_W, C.WINDOW_H)
            self.view_scale = 1.0
            return

        sw, sh = self.screen.get_size()
        if sw <= 0 or sh <= 0:
            self.viewport = pygame.Rect(0, 0, C.WINDOW_W, C.WINDOW_H)
            self.view_scale = 1.0
            return

        scale = min(sw / C.WINDOW_W, sh / C.WINDOW_H)

        # Snap to an exact integer multiple when we are close to one, so the
        # pixel grid stays crisp instead of shimmering at 2.03x.
        if scale > 1.0:
            nearest = round(scale)
            if nearest >= 1 and abs(scale - nearest) <= C.INTEGER_SCALE_SNAP:
                scale = float(nearest)

        vw = max(1, int(C.WINDOW_W * scale))
        vh = max(1, int(C.WINDOW_H * scale))
        self.viewport = pygame.Rect((sw - vw) // 2, (sh - vh) // 2, vw, vh)
        self.view_scale = scale

    def _to_canvas(self, pos: Tuple[float, float]) -> Tuple[float, float]:
        """Map a physical window position into virtual canvas coordinates.

        Positions over the letterbox bars clamp to the canvas edge, so the
        snake still steers sensibly when the cursor leaves the play area.
        """
        vp = self.viewport
        if vp.w <= 0 or vp.h <= 0:
            return (0.0, 0.0)
        cx = (pos[0] - vp.x) * (C.WINDOW_W / vp.w)
        cy = (pos[1] - vp.y) * (C.WINDOW_H / vp.h)
        if cx < 0.0:
            cx = 0.0
        elif cx > C.WINDOW_W:
            cx = float(C.WINDOW_W)
        if cy < 0.0:
            cy = 0.0
        elif cy > C.WINDOW_H:
            cy = float(C.WINDOW_H)
        return (cx, cy)

    def canvas_event_pos(self, event: "pygame.event.Event") -> Tuple[float, float]:
        """Canvas-space position of a mouse event (scenes may use this)."""
        pos = getattr(event, "pos", None)
        if pos is None:
            return self.mouse_pos
        return self._to_canvas((float(pos[0]), float(pos[1])))

    # ------------------------------------------------------------------
    # Scene management
    # ------------------------------------------------------------------
    def _make_scene(self, name: str) -> Scene:
        """Instantiate (and cache) the scene registered under `name`."""
        cached = self._scene_cache.get(name)
        if cached is not None:
            return cached

        try:
            mod_suffix, cls_name = SCENE_REGISTRY[name]
        except KeyError:
            raise KeyError(f"unknown scene {name!r}") from None

        module = importlib.import_module(f"{__package__}.scenes.{mod_suffix}")
        scene_cls = getattr(module, cls_name)
        scene = scene_cls(self)
        self._scene_cache[name] = scene
        return scene

    @property
    def scene(self) -> Optional[Scene]:
        """The scene currently on top of the stack."""
        return self._stack[-1] if self._stack else None

    def switch_scene(self, name: str, **kwargs: Any) -> None:
        """Replace the whole stack with a fresh scene, with a transition wipe."""
        while self._stack:
            self._stack.pop().on_exit()
        scene = self._make_scene(name)
        self._stack.append(scene)
        scene.on_enter(**kwargs)
        self.fx.begin_transition()

    def push_scene(self, name: str, **kwargs: Any) -> None:
        """Put a scene on top of the current one (used for the pause overlay)."""
        scene = self._make_scene(name)
        if scene in self._stack:
            return
        self._stack.append(scene)
        scene.on_enter(**kwargs)

    def pop_scene(self) -> None:
        """Remove the top scene, revealing the one beneath."""
        if len(self._stack) > 1:
            self._stack.pop().on_exit()

    def quit(self) -> None:
        self.running = False

    # ------------------------------------------------------------------
    # Frame steps
    # ------------------------------------------------------------------
    _MOUSE_EVENTS = (
        pygame.MOUSEMOTION,
        pygame.MOUSEBUTTONDOWN,
        pygame.MOUSEBUTTONUP,
    )

    def _pump_events(self) -> None:
        for event in pygame.event.get():
            if event.type == pygame.QUIT:
                self.running = False
                return

            # Window geometry changed: recompute the letterbox viewport.
            if event.type == pygame.VIDEORESIZE:
                if self.display_mode == C.DISPLAY_WINDOWED:
                    self.windowed_size = (event.w, event.h)
                self._rebuild_viewport()
            elif getattr(pygame, "WINDOWSIZECHANGED", None) is not None and \
                    event.type == pygame.WINDOWSIZECHANGED:
                self._rebuild_viewport()

            # F11, or Alt+Enter, toggles fullscreen from anywhere.
            if event.type == pygame.KEYDOWN:
                if event.key == pygame.K_F11 or (
                    event.key in (pygame.K_RETURN, pygame.K_KP_ENTER)
                    and (event.mod & pygame.KMOD_ALT)
                ):
                    self.toggle_fullscreen()
                    continue

            # Rewrite mouse events into canvas space *before* any scene sees
            # them.  Buttons hit-test against canvas-space rects, so without
            # this every click would miss whenever the window is not exactly
            # 1280x720.
            if event.type in self._MOUSE_EVENTS:
                canvas_pos = self._to_canvas(
                    (float(event.pos[0]), float(event.pos[1]))
                )
                attrs = dict(event.__dict__)
                attrs["pos"] = (int(canvas_pos[0]), int(canvas_pos[1]))
                if "rel" in attrs and self.view_scale > 0.0:
                    rel = attrs["rel"]
                    attrs["rel"] = (
                        rel[0] / self.view_scale,
                        rel[1] / self.view_scale,
                    )
                event = pygame.event.Event(event.type, attrs)

                if event.type == pygame.MOUSEMOTION:
                    self.mouse_pos = canvas_pos
                elif event.type == pygame.MOUSEBUTTONDOWN:
                    self.mouse_buttons[event.button] = True
                    self.mouse_pos = canvas_pos
                elif event.type == pygame.MOUSEBUTTONUP:
                    self.mouse_buttons[event.button] = False

            # Only the top scene receives input.
            top = self.scene
            if top is not None:
                top.handle_event(event)

    def _update_cursor_trail(self) -> None:
        self.cursor_trail.append(self.mouse_pos)
        while len(self.cursor_trail) > C.CURSOR_TRAIL_LEN:
            self.cursor_trail.pop(0)

    def update(self, dt: float) -> None:
        self.time += dt
        self.frame += 1
        self._update_cursor_trail()

        # Walk the stack top-down; stop updating once a scene blocks it.
        for i in range(len(self._stack) - 1, -1, -1):
            scene = self._stack[i]
            scene.update(dt)
            if scene.blocks_update:
                break

        self.particles.update(dt)
        self.fx.update(dt)

    def draw(self) -> None:
        self.canvas.fill((0, 0, 0))

        # Find the lowest scene that has to be drawn: walk down through
        # transparent overlays until we hit an opaque one.
        first = len(self._stack) - 1
        while first > 0 and self._stack[first].transparent:
            first -= 1
        for scene in self._stack[first:]:
            scene.draw(self.canvas)

        if not self.headless:
            self._draw_cursor(self.canvas)

        # Post-processing runs at canvas resolution, then the finished frame
        # is scaled once into the window.
        self.fx.present(self.canvas, self.present_buf)
        self._blit_to_window()

        if C.SHOW_FPS:
            label = self.fonts.mono_small.render(
                f"{self.fps:5.1f} fps", True, P.UI_DIM
            )
            self.screen.blit(
                label, (self.screen.get_width() - label.get_width() - 8, 6)
            )

    def _blit_to_window(self) -> None:
        """Scale the presented frame into the letterboxed viewport."""
        vp = self.viewport
        if vp.x == 0 and vp.y == 0 and vp.w == C.WINDOW_W and vp.h == C.WINDOW_H:
            self.screen.blit(self.present_buf, (0, 0))
            return

        self.screen.fill(C.LETTERBOX_COLOR)
        try:
            # An exact integer upscale looks sharper through nearest-neighbour;
            # anything else needs smoothing or the neon lines crawl.
            if self.view_scale >= 1.0 and float(self.view_scale).is_integer():
                scaled = pygame.transform.scale(self.present_buf, (vp.w, vp.h))
            else:
                scaled = pygame.transform.smoothscale(
                    self.present_buf, (vp.w, vp.h)
                )
            self.screen.blit(scaled, (vp.x, vp.y))
        except (pygame.error, ValueError):
            try:
                self.screen.blit(
                    pygame.transform.scale(self.present_buf, (vp.w, vp.h)),
                    (vp.x, vp.y),
                )
            except Exception:
                self.screen.blit(self.present_buf, (vp.x, vp.y))

    def _draw_cursor(self, surface: pygame.Surface) -> None:
        """A glowing reticle with a comet trail, drawn over everything."""
        from .gfx.ui import draw_cursor

        draw_cursor(surface, self)

    # ------------------------------------------------------------------
    # Main loop
    # ------------------------------------------------------------------
    def run(self, start_scene: str = C.SCENE_MENU) -> None:
        self.switch_scene(start_scene)
        while self.running:
            raw_dt = self.clock.tick(C.FPS) / 1000.0
            dt = raw_dt if raw_dt < C.MAX_DT else C.MAX_DT
            self.fps = self.clock.get_fps()

            self._pump_events()
            if not self.running:
                break
            self.update(dt)
            self.draw()
            pygame.display.flip()

        self.shutdown()

    def shutdown(self) -> None:
        try:
            self.save.muted = self.audio.muted
            self.save.display_mode = self.display_mode
            self.save.difficulty = self.difficulty
            self.save.mode = self.mode
            self.save.save()
        except Exception:
            pass
        pygame.quit()


def main(argv: Optional[List[str]] = None) -> int:
    """Entry point.  Returns a process exit code."""
    argv = list(sys.argv[1:] if argv is None else argv)
    try:
        game = Game()
        game.run()
    except Exception:
        traceback.print_exc()
        try:
            pygame.quit()
        except Exception:
            pass
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
