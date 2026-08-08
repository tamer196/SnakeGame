"""
End-of-run scenes for NEON SERPENT.

Two screens live here because they are the same screen wearing two moods:

*   :class:`GameOverScene` - the sombre one.  The level's own theme is drained
    of colour, slow embers fall through a dim field, GAME OVER burns overhead
    and the run summary counts itself up out of zero.
*   :class:`VictoryScene` - the loud one.  Full-strength theme colours, a
    firework shower on entry, LEVEL CLEAR in display type and a three-star
    rating whose stars pop in one at a time, each with its own chime and
    shockwave.

Both read :attr:`Game.last_result`, which `GameplayScene` fills in before it
switches here.  Every key is optional: a missing or empty dict degrades to a
zeroed summary rather than an exception, because a crash on the results screen
would throw away the run the player just finished.

Scene instances are cached and reused by the scene manager, so *all* mutable
state is rebuilt in ``on_enter`` - nothing may survive from a previous run.
"""

from __future__ import annotations

import dataclasses
import math
import random
from typing import TYPE_CHECKING, Any, Callable, Dict, List, Optional, Sequence, Tuple

import pygame

from .. import config as C
from .. import palette as P
from ..core.contracts import (
    TAU,
    Scene,
    clamp,
    ease_out_back,
    ease_out_cubic,
    pulse,
)
from ..core.level import LEVEL_COUNT, get_level
from ..gfx.background import make_background
from ..gfx.render import draw_glow_circle
from ..gfx.ui import Button, draw_panel, draw_text

if TYPE_CHECKING:  # pragma: no cover - typing only
    from ..main import Game

__all__ = ["GameOverScene", "VictoryScene"]

RGB = Tuple[int, int, int]

# --------------------------------------------------------------------------
# Timing
# --------------------------------------------------------------------------
#: Seconds the summary numbers take to roll from zero to their real value.
COUNT_TIME = 1.05
#: Delay before the count-up starts, so the heading lands first.
COUNT_DELAY = 0.30
#: When the first star pops, and the gap between the ones after it.
STAR_FIRST = 0.85
STAR_GAP = 0.55
#: How long one star's pop animation runs.
STAR_POP = 0.55

BUTTON_H = C.UI_BUTTON_H


# --------------------------------------------------------------------------
# Small helpers
# --------------------------------------------------------------------------
def _mute(color: Sequence[int], grey: float = 0.62, dark: float = 0.70) -> RGB:
    """Drain a colour toward its own luminance, then darken it."""
    try:
        r, g, b = int(color[0]), int(color[1]), int(color[2])
    except Exception:
        return (90, 96, 110)
    lum = int(0.299 * r + 0.587 * g + 0.114 * b)
    return P.shade(P.lerp_color((r, g, b), (lum, lum, lum), grey), dark)


def _mute_theme(theme: P.Theme) -> P.Theme:
    """A desaturated copy of a theme, used for the whole game-over palette."""
    try:
        return dataclasses.replace(
            theme,
            bg_top=_mute(theme.bg_top, 0.75, 0.62),
            bg_bottom=_mute(theme.bg_bottom, 0.75, 0.62),
            grid=_mute(theme.grid, 0.80, 0.60),
            accent=_mute(theme.accent, 0.55, 0.78),
            accent2=_mute(theme.accent2, 0.60, 0.72),
            snake_head=_mute(theme.snake_head),
            snake_a=_mute(theme.snake_a),
            snake_b=_mute(theme.snake_b),
            food=_mute(theme.food),
            hazard=_mute(theme.hazard, 0.35, 0.85),
            text=P.lerp_color(theme.text, P.UI_DIM, 0.35),
            text_dim=_mute(theme.text_dim, 0.5, 0.9),
        )
    except Exception:
        return theme


def _fmt_time(seconds: float) -> str:
    """Seconds -> m:ss, clamped to something a scoreboard can print."""
    try:
        s = int(clamp(float(seconds), 0.0, 59 * 60 + 59))
    except Exception:
        s = 0
    return "{:d}:{:02d}".format(s // 60, s % 60)


def _star_points(cx: float, cy: float, radius: float,
                 rot: float = 0.0) -> List[Tuple[int, int]]:
    """The ten vertices of a five-pointed star, outer point up by default."""
    pts: List[Tuple[int, int]] = []
    inner = radius * 0.44
    for i in range(10):
        r = radius if i % 2 == 0 else inner
        ang = -math.pi * 0.5 + rot + i * (TAU / 10.0)
        pts.append((int(cx + math.cos(ang) * r), int(cy + math.sin(ang) * r)))
    return pts


def _draw_star(surface: pygame.Surface, cx: float, cy: float, radius: float,
               color: Sequence[int], *, filled: bool, glow: float = 0.0,
               rot: float = 0.0) -> None:
    """One rating star.  Unearned stars are drawn as a dim outline."""
    try:
        if radius < 3.0:
            return
        if glow > 0.01:
            draw_glow_circle(surface, cx, cy, radius * 1.9, color, glow)
        pts = _star_points(cx, cy, radius, rot)
        if filled:
            pygame.draw.polygon(surface, color, pts)
            pygame.draw.polygon(surface, P.lerp_color(color, P.UI_WHITE, 0.55),
                                pts, max(1, int(radius * 0.10)))
        else:
            pygame.draw.polygon(surface, color, pts, max(1, int(radius * 0.09)))
    except Exception:
        pass


# ==========================================================================
# Shared base
# ==========================================================================
class _ResultScene(Scene):
    """
    Everything the two result screens have in common.

    Subclasses supply a palette, a button row and a body renderer; the base
    owns result parsing, the count-up clock, the button plumbing and the
    scene-switch actions.
    """

    #: Overridden by subclasses; used for the ambient veil over the background.
    veil_alpha: int = 120

    def __init__(self, game: "Game") -> None:
        super().__init__(game)
        self.theme: P.Theme = P.THEMES[0]
        self.buttons: List[Button] = []
        self.result: Dict[str, Any] = {}

        # Parsed result fields (always present, always the right type).
        self.level_index: int = 0
        self.level_name: str = ""
        self.score: int = 0
        self.food_eaten: int = 0
        self.goal_food: int = 1
        self.stars: int = 0
        self.new_best: bool = False
        self.max_combo: int = 0
        self.deaths: int = 0
        self.elapsed: float = 0.0

        self.t: float = 0.0                     # seconds since on_enter
        self._bg: Any = None
        self._bg_style: str = ""
        self._bg_theme_name: str = ""

    # -- result parsing ----------------------------------------------------
    def _read_result(self) -> None:
        """Pull `game.last_result` apart defensively; never raises."""
        raw = getattr(self.game, "last_result", None)
        self.result = dict(raw) if isinstance(raw, dict) else {}

        def num(key: str, default: float = 0.0) -> float:
            try:
                v = self.result.get(key, default)
                return float(default) if v is None else float(v)
            except (TypeError, ValueError):
                return float(default)

        fallback_index = int(getattr(self.game, "level_index", 0) or 0)
        self.level_index = int(clamp(num("level_index", fallback_index),
                                     0, LEVEL_COUNT - 1))
        level = get_level(self.level_index)

        name = self.result.get("level_name")
        self.level_name = str(name) if name else level.name
        self.score = max(0, int(num("score")))
        self.goal_food = max(1, int(num("goal_food", level.goal_food)))
        self.food_eaten = max(0, int(num("food_eaten")))
        self.stars = int(clamp(num("stars"), 0, 3))
        self.max_combo = max(0, int(num("max_combo")))
        self.deaths = max(0, int(num("deaths")))
        self.elapsed = max(0.0, num("elapsed"))
        self.new_best = bool(self.result.get("new_best", False))

    # -- lifecycle ---------------------------------------------------------
    def on_enter(self, **kwargs: Any) -> None:
        try:
            self._read_result()
            # A kwarg wins over the handoff dict, if a caller bothers to pass one.
            if "level_index" in kwargs:
                try:
                    self.level_index = int(clamp(float(kwargs["level_index"]),
                                                 0, LEVEL_COUNT - 1))
                except (TypeError, ValueError):
                    pass
            self.game.level_index = self.level_index

            self.t = 0.0
            self.theme = self._build_theme()
            try:
                self.game.fx.set_theme(self.theme)
            except Exception:
                pass
            self._ensure_background()
            self.buttons = self._build_buttons()
            self.game.particles.clear()
            self._on_ready()
        except Exception:
            # A results screen that fails to build still has to be escapable,
            # so make sure there is at least a way back to the menu.
            if not self.buttons:
                self.buttons = [Button((490, 620, 300, BUTTON_H), "MENU",
                                       style="ghost", data="menu")]

    def on_exit(self) -> None:
        try:
            self.game.particles.clear()
        except Exception:
            pass

    # -- hooks for subclasses ---------------------------------------------
    def _build_theme(self) -> P.Theme:
        return get_level(self.level_index).theme

    def _build_buttons(self) -> List[Button]:
        return []

    def _on_ready(self) -> None:
        """Called at the end of on_enter, once everything else is built."""

    def _draw_body(self, surface: pygame.Surface) -> None:
        """Draw the scene-specific content between veil and buttons."""

    def _emit(self, dt: float) -> None:
        """Per-frame particle emission."""

    # -- background --------------------------------------------------------
    def _ensure_background(self) -> None:
        """
        Build (or reuse) the scrolling backdrop.

        `make_background` pre-renders a lot of art, so it is only rebuilt when
        the style or the theme actually changed - i.e. on a new level, not on
        every retry of the same one.
        """
        style = str(getattr(self.theme, "bg_style", "grid"))
        key = str(getattr(self.theme, "name", ""))
        if self._bg is not None and style == self._bg_style and key == self._bg_theme_name:
            return
        try:
            self._bg = make_background(style, self.theme,
                                       (0, 0, C.WINDOW_W, C.WINDOW_H))
            self._bg_style = style
            self._bg_theme_name = key
        except Exception:
            self._bg = None

    # -- count-up ----------------------------------------------------------
    def count_frac(self) -> float:
        """0..1 easing weight driving every rolling number on the screen."""
        return ease_out_cubic(clamp((self.t - COUNT_DELAY) / COUNT_TIME, 0.0, 1.0))

    def counted(self, value: float) -> int:
        """`value` scaled by the count-up weight, rounded like an odometer."""
        return int(float(value) * self.count_frac() + 0.0001)

    # -- actions -----------------------------------------------------------
    def _go(self, name: str, **kwargs: Any) -> None:
        """
        Switch scenes, tolerating a target whose `on_enter` takes no kwargs.

        The other scenes are owned by other modules; passing `level_index=` is
        a convenience for them, never a requirement.
        """
        try:
            self.game.switch_scene(name, **kwargs)
        except TypeError:
            try:
                self.game.switch_scene(name)
            except Exception:
                pass
        except Exception:
            pass

    def _act(self, action: Any) -> None:
        """Run the action attached to a button's `data`."""
        try:
            if callable(action):
                action()
                return
            key = str(action)
            if key == "retry":
                self.game.level_index = self.level_index
                self._go(C.SCENE_GAME, level_index=self.level_index)
            elif key == "next":
                nxt = int(clamp(self.level_index + 1, 0, LEVEL_COUNT - 1))
                self.game.level_index = nxt
                self._go(C.SCENE_GAME, level_index=nxt)
            elif key == "levels":
                self._go(C.SCENE_LEVELS)
            elif key == "menu":
                self._go(C.SCENE_MENU)
        except Exception:
            pass

    # -- per-frame ---------------------------------------------------------
    def handle_event(self, event: "pygame.event.Event") -> None:
        try:
            for button in self.buttons:
                if button.handle_event(event):
                    self.game.audio.play("click")
                    self._act(button.data)
                    return
            if getattr(event, "type", None) == pygame.KEYDOWN:
                self._handle_key(event)
        except Exception:
            pass

    def _handle_key(self, event: "pygame.event.Event") -> None:
        """Keyboard shortcuts - always a mirror of an on-screen button."""
        key = getattr(event, "key", None)
        if key in (pygame.K_ESCAPE,):
            self.game.audio.play("click")
            self._act("menu")
        elif key in (pygame.K_l,):
            self.game.audio.play("click")
            self._act("levels")
        elif key in (pygame.K_r,):
            self.game.audio.play("click")
            self._act("retry")
        elif key in (pygame.K_RETURN, pygame.K_KP_ENTER, pygame.K_SPACE):
            # Enter takes the first enabled button, which is the primary action.
            for button in self.buttons:
                if button.enabled:
                    self.game.audio.play("click")
                    self._act(button.data)
                    return

    def update(self, dt: float) -> None:
        try:
            dt = clamp(float(dt), 0.0, C.MAX_DT)
            self.t += dt
            if self._bg is not None:
                self._bg.update(dt)
            mouse = getattr(self.game, "mouse_pos", (0.0, 0.0))
            for button in self.buttons:
                button.update(dt, mouse)
                if button.just_entered:
                    self.game.audio.play("hover", 0.6)
            self._emit(dt)
        except Exception:
            pass

    def draw(self, surface: pygame.Surface) -> None:
        try:
            if self._bg is not None:
                self._bg.draw(surface)
            else:
                surface.fill(self.theme.bg_bottom)
            self._draw_veil(surface)
            self.game.particles.draw(surface)
            self._draw_body(surface)
            for button in self.buttons:
                button.draw(surface, self.theme, self.game.fonts, self.game.time)
        except Exception:
            pass

    def _draw_veil(self, surface: pygame.Surface) -> None:
        """A flat wash that pushes the backdrop behind the summary text."""
        try:
            if self.veil_alpha <= 0:
                return
            veil = pygame.Surface(surface.get_size(), pygame.SRCALPHA)
            veil.fill(P.with_alpha(P.shade(self.theme.bg_bottom, 0.6),
                                   int(clamp(self.veil_alpha, 0, 255))))
            surface.blit(veil, (0, 0))
        except Exception:
            pass

    # -- shared drawing ----------------------------------------------------
    def _draw_stat_row(self, surface: pygame.Surface, x_label: float, x_value: float,
                       y: float, label: str, value: str, *,
                       value_color: Optional[Sequence[int]] = None,
                       dim: Optional[Sequence[int]] = None) -> None:
        """One `LABEL .......... value` line of the summary block."""
        fonts = self.game.fonts
        label_col = dim if dim is not None else self.theme.text_dim
        draw_text(surface, label.upper(), fonts.small, label_col, (x_label, y + 4))
        draw_text(surface, value, fonts.h2,
                  value_color if value_color is not None else self.theme.text,
                  (x_value, y - 3), align="right")


# ==========================================================================
# GAME OVER
# ==========================================================================
class GameOverScene(_ResultScene):
    """The run ended badly: drained colour, falling embers, a cold summary."""

    veil_alpha = 168

    def __init__(self, game: "Game") -> None:
        super().__init__(game)
        self._ember_acc: float = 0.0
        self._best_ping: bool = False       # NEW BEST flourish already fired?

    def _build_theme(self) -> P.Theme:
        return _mute_theme(get_level(self.level_index).theme)

    def _build_buttons(self) -> List[Button]:
        labels = (("RETRY", "primary", "retry"),
                  ("LEVEL SELECT", "ghost", "levels"),
                  ("MENU", "ghost", "menu"))
        width, gap = 268, 26
        total = width * len(labels) + gap * (len(labels) - 1)
        x = (C.WINDOW_W - total) * 0.5
        y = 604
        out: List[Button] = []
        for i, (label, style, action) in enumerate(labels):
            out.append(Button((x + i * (width + gap), y, width, BUTTON_H),
                              label, style=style, data=action))
        return out

    def _on_ready(self) -> None:
        self._ember_acc = 0.0
        self._best_ping = False
        try:
            self.game.audio.play("die")
            self.game.fx.flash(P.shade(self.theme.hazard, 0.7), 0.35)
            self.game.fx.shake(5.0)
        except Exception:
            pass

    # -- embers ------------------------------------------------------------
    def _emit(self, dt: float) -> None:
        """A slow, sparse fall of embers - grief, at about 13 particles/sec."""
        try:
            self._ember_acc += dt * 13.0
            hazard = self.theme.hazard
            accent = self.theme.accent
            while self._ember_acc >= 1.0:
                self._ember_acc -= 1.0
                col = P.lerp_color(hazard, accent, random.random() * 0.6)
                self.game.particles.spawn(
                    random.uniform(-20.0, C.WINDOW_W + 20.0),
                    random.uniform(-40.0, -4.0),
                    vx=random.uniform(-9.0, 9.0),
                    vy=random.uniform(14.0, 34.0),
                    radius=random.uniform(1.8, 3.6),
                    color=P.shade(col, 0.85),
                    life=random.uniform(4.5, 8.5),
                    drag=0.12, gravity=5.0, shrink=False,
                    kind="ember" if random.random() < 0.55 else "dot",
                    spin=random.uniform(-1.2, 1.2),
                )
            # The NEW BEST flourish waits for the count-up to finish.
            if self.new_best and not self._best_ping and self.count_frac() >= 0.999:
                self._best_ping = True
                self.game.audio.play("bonus")
                self.game.particles.ring(C.WINDOW_W * 0.5, 250.0, P.UI_GOLD,
                                         radius=120.0, count=30, life=0.8, speed=190.0)
        except Exception:
            pass

    # -- drawing -----------------------------------------------------------
    def _draw_body(self, surface: pygame.Surface) -> None:
        fonts = self.game.fonts
        theme = self.theme
        t = self.game.time
        cx = C.WINDOW_W * 0.5

        draw_panel(surface, (300, 92, 680, 468), theme, alpha=196, glow=0.20)

        # ---- heading -----------------------------------------------------
        # Two stacked glows (wide + tight) give the words real weight without
        # the cost of a blurred text surface.
        head_y = 118.0
        breathe = 0.35 + 0.20 * pulse(t, 1.4)
        draw_glow_circle(surface, cx, head_y + 46, 250.0,
                         P.shade(theme.hazard, 0.85), breathe)
        draw_glow_circle(surface, cx, head_y + 46, 120.0, theme.hazard, breathe * 0.9)
        draw_text(surface, "GAME OVER", fonts.huge,
                  P.lerp_color(P.UI_WHITE, theme.hazard, 0.35), (cx, head_y),
                  align="center")

        draw_text(surface, self.level_name.upper(), fonts.body,
                  theme.text_dim, (cx, head_y + 118), align="center")
        draw_text(surface, "LEVEL {:02d}".format(self.level_index + 1), fonts.tiny,
                  P.shade(theme.accent2, 1.0), (cx, head_y + 100), align="center")

        # ---- summary -----------------------------------------------------
        x_label, x_value = 372.0, 908.0
        y = 300.0
        pitch = 46.0
        score_col = P.lerp_color(P.UI_WHITE, P.UI_GOLD, 0.45)
        self._draw_stat_row(surface, x_label, x_value, y, "Score",
                            "{:,}".format(self.counted(self.score)),
                            value_color=score_col, dim=theme.text_dim)
        self._draw_stat_row(surface, x_label, x_value, y + pitch, "Food eaten",
                            "{} / {}".format(self.counted(self.food_eaten),
                                             self.goal_food),
                            dim=theme.text_dim)
        self._draw_stat_row(surface, x_label, x_value, y + pitch * 2, "Best combo",
                            "x{}".format(max(1, self.counted(self.max_combo))
                                         if self.max_combo else 1),
                            dim=theme.text_dim)
        self._draw_stat_row(surface, x_label, x_value, y + pitch * 3, "Time survived",
                            _fmt_time(self.elapsed * self.count_frac()),
                            dim=theme.text_dim)

        # A hairline under the block ties the rows to the buttons below.
        pygame.draw.line(surface, P.with_alpha(theme.grid, 200),
                         (372, y + pitch * 4 + 6), (908, y + pitch * 4 + 6))

        if self.new_best:
            self._draw_new_best(surface, cx, y + pitch * 4 + 40.0)
        else:
            best = 0
            try:
                best = int(self.game.save.best_for(self.level_index))
            except Exception:
                best = 0
            draw_text(surface, "LEVEL BEST  {:,}".format(max(best, self.score)),
                      fonts.small, theme.text_dim, (cx, y + pitch * 4 + 44.0),
                      align="center")

    def _draw_new_best(self, surface: pygame.Surface, cx: float, cy: float) -> None:
        """Gold badge that swells in once the counters have settled."""
        try:
            pop = clamp((self.t - (COUNT_DELAY + COUNT_TIME)) / 0.45, 0.0, 1.0)
            if pop <= 0.0:
                return
            scale = 0.7 + 0.3 * ease_out_back(pop)
            t = self.game.time
            glow = (0.45 + 0.35 * pulse(t, 5.0)) * pop
            draw_glow_circle(surface, cx, cy + 14, 150.0 * scale, P.UI_GOLD, glow)
            font = self.game.fonts.display_at(max(12, int(38 * scale)))
            draw_text(surface, "NEW BEST", font,
                      P.lerp_color(P.UI_GOLD, P.UI_WHITE, 0.30 + 0.25 * pulse(t, 5.0)),
                      (cx, cy), align="center")
        except Exception:
            pass


# ==========================================================================
# VICTORY
# ==========================================================================
class VictoryScene(_ResultScene):
    """The run ended well: confetti, a star ceremony and a rolling score."""

    veil_alpha = 112

    def __init__(self, game: "Game") -> None:
        super().__init__(game)
        self.final: bool = False            # cleared the last level?
        self._stars_shown: int = 0          # how many have popped so far
        self._confetti: float = 0.0         # seconds of shower left
        self._confetti_acc: float = 0.0
        self._star_x: List[float] = []
        self._star_y: float = 300.0

    # -- setup -------------------------------------------------------------
    def _build_buttons(self) -> List[Button]:
        specs: List[Tuple[str, str, str]] = []
        if not self.final:
            specs.append(("NEXT LEVEL", "primary", "next"))
        specs.append(("REPLAY", "ghost" if not self.final else "primary", "retry"))
        specs.append(("LEVEL SELECT", "ghost", "levels"))
        specs.append(("MENU", "ghost", "menu"))

        width = 248 if len(specs) == 4 else 268
        gap = 22
        total = width * len(specs) + gap * (len(specs) - 1)
        x = (C.WINDOW_W - total) * 0.5
        y = 618
        return [Button((x + i * (width + gap), y, width, BUTTON_H),
                       label, style=style, data=action)
                for i, (label, style, action) in enumerate(specs)]

    def on_enter(self, **kwargs: Any) -> None:
        # `final` decides the button row, so it has to be known before the base
        # class builds it - resolve the level index here first.
        try:
            self._read_result()
            self.final = self.level_index >= LEVEL_COUNT - 1
        except Exception:
            self.final = False
        super().on_enter(**kwargs)
        self.final = self.level_index >= LEVEL_COUNT - 1

    def _on_ready(self) -> None:
        self._stars_shown = 0
        self._confetti = 2.6
        self._confetti_acc = 0.0
        self._star_y = 300.0
        centre = C.WINDOW_W * 0.5
        self._star_x = [centre - 118.0, centre, centre + 118.0]
        try:
            self.game.audio.play("win")
            self.game.fx.flash(self.theme.accent, 0.45)
            self._firework(centre, 250.0, 1.15)
        except Exception:
            pass

    # -- particles ---------------------------------------------------------
    def _colors(self) -> Tuple[RGB, RGB, RGB, RGB]:
        theme = self.theme
        return (theme.accent, theme.accent2, theme.food, P.UI_GOLD)

    def _firework(self, x: float, y: float, power: float = 1.0) -> None:
        """One burst plus a shockwave, in the theme's brightest colours."""
        try:
            cols = self._colors()
            self.game.particles.ring(x, y, cols[0], radius=110.0 * power,
                                     count=28, life=0.7, speed=200.0 * power)
            for i in range(3):
                self.game.particles.burst(
                    x, y, cols[(i + 1) % len(cols)],
                    count=int(20 * power),
                    speed=(90.0, 320.0 * power), life=(0.5, 1.2),
                    radius=(2.0, 5.0),
                )
        except Exception:
            pass

    def _emit(self, dt: float) -> None:
        try:
            # ---- star ceremony -------------------------------------------
            want = 0
            for i in range(self.stars):
                if self.t >= STAR_FIRST + i * STAR_GAP:
                    want = i + 1
            while self._stars_shown < want:
                idx = self._stars_shown
                self._stars_shown += 1
                x = self._star_x[idx] if idx < len(self._star_x) else C.WINDOW_W * 0.5
                col = P.UI_GOLD if idx < 2 else P.lerp_color(P.UI_GOLD, P.UI_WHITE, 0.4)
                self.game.particles.ring(x, self._star_y, col, radius=90.0,
                                         count=22, life=0.6, speed=180.0)
                self.game.particles.burst(x, self._star_y, col, count=22,
                                          speed=(60.0, 240.0), life=(0.4, 0.9))
                # The third star gets the bigger fanfare.
                self.game.audio.play("levelup" if idx >= 2 else "bonus")
                try:
                    self.game.fx.shake(2.0 + 1.5 * idx)
                except Exception:
                    pass

            # ---- confetti shower -----------------------------------------
            if self._confetti > 0.0:
                self._confetti = max(0.0, self._confetti - dt)
                self._confetti_acc += dt * 90.0
                cols = self._colors()
                while self._confetti_acc >= 1.0:
                    self._confetti_acc -= 1.0
                    self.game.particles.spawn(
                        random.uniform(0.0, C.WINDOW_W),
                        random.uniform(-60.0, -6.0),
                        vx=random.uniform(-70.0, 70.0),
                        vy=random.uniform(30.0, 120.0),
                        radius=random.uniform(2.0, 4.6),
                        color=random.choice(cols),
                        life=random.uniform(1.6, 3.2),
                        drag=0.5, gravity=95.0, shrink=False,
                        kind="shard" if random.random() < 0.45 else "dot",
                        spin=random.uniform(-6.0, 6.0),
                    )
            # A late firework at the far corners keeps the screen alive after
            # the shower stops, without ever becoming a permanent particle sink.
            elif self.t < 6.0 and random.random() < dt * 1.4:
                self._firework(random.uniform(220.0, C.WINDOW_W - 220.0),
                               random.uniform(140.0, 420.0), 0.7)
        except Exception:
            pass

    # -- drawing -----------------------------------------------------------
    def _draw_body(self, surface: pygame.Surface) -> None:
        fonts = self.game.fonts
        theme = self.theme
        t = self.game.time
        cx = C.WINDOW_W * 0.5

        draw_panel(surface, (272, 70, 736, 512), theme, alpha=190, glow=0.42)

        # ---- heading -----------------------------------------------------
        head_y = 92.0
        glow = 0.55 + 0.30 * pulse(t, 2.0)
        draw_glow_circle(surface, cx, head_y + 40, 260.0, theme.accent, glow * 0.8)
        draw_glow_circle(surface, cx, head_y + 40, 130.0, theme.accent2, glow * 0.7)
        if self.final:
            draw_text(surface, "CAMPAIGN COMPLETE", fonts.title,
                      P.lerp_color(P.UI_WHITE, theme.accent, 0.20),
                      (cx, head_y + 8), align="center")
        else:
            draw_text(surface, "LEVEL CLEAR", fonts.huge,
                      P.lerp_color(P.UI_WHITE, theme.accent, 0.25),
                      (cx, head_y), align="center")

        sub_y = head_y + (72.0 if self.final else 100.0)
        draw_text(surface, "LEVEL {:02d}  -  {}".format(self.level_index + 1,
                                                        self.level_name.upper()),
                  fonts.body, theme.text_dim, (cx, sub_y), align="center")

        # ---- stars --------------------------------------------------------
        self._star_y = sub_y + 78.0
        self._draw_stars(surface)

        # ---- score --------------------------------------------------------
        score_y = self._star_y + 62.0
        shown = self.counted(self.score)
        heat = self.count_frac()
        draw_glow_circle(surface, cx, score_y + 30, 170.0, P.UI_GOLD,
                         0.20 + 0.35 * heat)
        draw_text(surface, "{:,}".format(shown), fonts.display_at(58),
                  P.lerp_color(P.UI_WHITE, P.UI_GOLD, 0.5), (cx, score_y),
                  align="center")

        par = get_level(self.level_index).par_score()
        delta = self.score - par
        par_col = P.UI_GOOD if delta >= 0 else theme.text_dim
        draw_text(surface,
                  "PAR {:,}   ({}{:,})".format(par, "+" if delta >= 0 else "-",
                                               abs(delta)),
                  self.game.fonts.small, par_col, (cx, score_y + 66.0),
                  align="center")

        # ---- footer stats --------------------------------------------------
        foot_y = score_y + 96.0
        if self.final:
            try:
                total = int(self.game.save.total_stars())
                cap = int(self.game.save.max_stars())
            except Exception:
                total, cap = self.stars, LEVEL_COUNT * 3
            draw_text(surface, "TOTAL STARS  {} / {}".format(self.counted(total), cap),
                      self.game.fonts.h2,
                      P.lerp_color(P.UI_GOLD, P.UI_WHITE, 0.25 + 0.2 * pulse(t, 3.0)),
                      (cx, foot_y), align="center")
        else:
            bits = [
                "FOOD {} / {}".format(self.counted(self.food_eaten), self.goal_food),
                "COMBO x{}".format(max(1, self.max_combo)),
                "TIME {}".format(_fmt_time(self.elapsed)),
            ]
            if self.deaths:
                bits.append("LIVES LOST {}".format(self.deaths))
            draw_text(surface, "     ".join(bits), self.game.fonts.small,
                      theme.text_dim, (cx, foot_y + 4), align="center")

        if self.new_best:
            draw_text(surface, "NEW BEST", self.game.fonts.h2,
                      P.lerp_color(P.UI_GOLD, P.UI_WHITE, 0.3 + 0.3 * pulse(t, 6.0)),
                      (cx, foot_y + 32.0), align="center")

    def _draw_stars(self, surface: pygame.Surface) -> None:
        """Three slots; earned stars pop in on their own schedule."""
        t = self.game.time
        base_r = 40.0
        for i in range(3):
            x = self._star_x[i] if i < len(self._star_x) else C.WINDOW_W * 0.5
            earned = i < self.stars
            if not earned or self.t < STAR_FIRST + i * STAR_GAP:
                _draw_star(surface, x, self._star_y, base_r * 0.86,
                           P.shade(self.theme.text_dim, 0.85), filled=False)
                continue
            age = self.t - (STAR_FIRST + i * STAR_GAP)
            pop = clamp(age / STAR_POP, 0.0, 1.0)
            # Overshoot on the way in, then settle into a slow breathing glow.
            scale = 0.25 + 0.75 * ease_out_back(pop) if pop < 1.0 else 1.0
            spin = (1.0 - pop) * 1.4
            glow = 0.45 + 0.8 * (1.0 - pop) + 0.18 * pulse(t * 1.0 + i, 2.4)
            _draw_star(surface, x, self._star_y, base_r * scale, P.UI_GOLD,
                       filled=True, glow=glow, rot=spin)
