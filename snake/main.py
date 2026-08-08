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

        flags = 0
        try:
            self.screen = pygame.display.set_mode(C.WINDOW_SIZE, flags)
        except pygame.error:
            # No video device at all (a locked-down CI box).  Everything still
            # renders, just without the convert() fast path.
            self.screen = pygame.Surface(C.WINDOW_SIZE)

        # Scenes draw here; the effect stack composites it onto `screen`.
        try:
            self.canvas = pygame.Surface(C.WINDOW_SIZE).convert()
        except pygame.error:
            self.canvas = pygame.Surface(C.WINDOW_SIZE)

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

        # --- scene stack --------------------------------------------------
        self._stack: List[Scene] = []
        self._scene_cache: Dict[str, Scene] = {}

        if not headless:
            pygame.mouse.set_visible(False)

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
    def _pump_events(self) -> None:
        for event in pygame.event.get():
            if event.type == pygame.QUIT:
                self.running = False
                return

            if event.type == pygame.MOUSEMOTION:
                self.mouse_pos = (float(event.pos[0]), float(event.pos[1]))
            elif event.type == pygame.MOUSEBUTTONDOWN:
                self.mouse_buttons[event.button] = True
                self.mouse_pos = (float(event.pos[0]), float(event.pos[1]))
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

        self.fx.present(self.canvas, self.screen)

        if C.SHOW_FPS:
            label = self.fonts.mono_small.render(
                f"{self.fps:5.1f} fps", True, P.UI_DIM
            )
            self.screen.blit(label, (C.WINDOW_W - label.get_width() - 8, 6))

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
