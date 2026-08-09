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

v2: mode and difficulty
-----------------------
Both screens now show the difficulty the run was played on as a coloured badge
and compare the score against that difficulty's *adjusted* par (the one-star
threshold from :func:`snake.core.difficulty.apply_star_targets`), not the raw
level par - beating par on expert is a different sentence to beating it on easy
and the screen has to say so.

:class:`VictoryScene` additionally owns the **story hand-off**, which is the
only piece of campaign routing that does not live in ``mode_select``.  In story
mode the primary button becomes CONTINUE and it assembles the card stack for
:data:`~snake.config.SCENE_STORY` itself:

*   the outro of the level just cleared,
*   the chapter plate, when the next level opens a new chapter,
*   the intro of the next level (skipped when the save says it has been read),

then hands over with ``next_scene=C.SCENE_GAME`` and
``next_kwargs={"level_index": next_index}``.  After the final level it flags the
campaign complete, shows the epilogue and returns to the menu.

:class:`GameOverScene` in story mode does not pretend the campaign continues:
it offers RETRY LEVEL and ABANDON RUN instead of a level browser.

Scene instances are cached and reused by the scene manager, so *all* mutable
state is rebuilt in ``on_enter`` - nothing may survive from a previous run.
"""

from __future__ import annotations

import dataclasses
import math
import random
from typing import TYPE_CHECKING, Any, Dict, List, Optional, Sequence, Set, Tuple

import pygame

from .. import config as C
from .. import palette as P
from ..core import difficulty as D
from ..core import story as S
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

#: Beat indices 0..11 are the twelve level beats; ``mode_select`` parks the
#: prologue's own "seen" flag far above them, so the two never collide.
_MAX_BEAT = max(0, LEVEL_COUNT - 1)


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


def _fmt_delta(delta: int) -> str:
    """A signed, thousands-separated delta: ``+1,240`` / ``-90`` / ``+0``."""
    try:
        n = int(delta)
    except (TypeError, ValueError):
        n = 0
    return "{}{:,}".format("+" if n >= 0 else "-", abs(n))


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


def _draw_badge(surface: pygame.Surface, cx: float, cy: float, label: str,
                color: Sequence[int], font: Optional[pygame.font.Font], *,
                glow: float = 0.30) -> pygame.Rect:
    """
    A rounded chip in `color` centred on ``(cx, cy)`` - the difficulty tag.

    Built per frame rather than cached because it is one rounded rect and two
    blits; the text underneath is already cached by `draw_text`.
    """
    try:
        text = str(label).upper()
        if font is None:
            return pygame.Rect(0, 0, 0, 0)
        tw, th = font.size(text)
        w, h = int(tw) + 40, int(th) + 12
        rect = pygame.Rect(0, 0, w, h)
        rect.center = (int(cx), int(cy))

        if glow > 0.01:
            draw_glow_circle(surface, cx, cy, w * 0.52, color, glow)
        chip = pygame.Surface((w, h), pygame.SRCALPHA)
        radius = h // 2
        pygame.draw.rect(chip, P.with_alpha(P.shade(color, 0.26), 214),
                         (0, 0, w, h), border_radius=radius)
        pygame.draw.rect(chip, P.with_alpha(color, 235), (0, 0, w, h), 2,
                         border_radius=radius)
        surface.blit(chip, rect.topleft)
        draw_text(surface, text, font, P.lerp_color(color, P.UI_WHITE, 0.60),
                  (rect.centerx, rect.y + 6), align="center", shadow=False)
        return rect
    except Exception:
        return pygame.Rect(0, 0, 0, 0)


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

        # v2: mode / difficulty / campaign position.
        self.mode: str = C.MODE_FREE
        self.diff: D.Difficulty = D.get_difficulty(None)
        self.star_targets: Tuple[int, int, int] = (1, 2, 3)
        self.par: int = 1
        self.final: bool = False
        self.next_index: int = 0
        self._result_level: int = -1

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
        self._result_level = self.level_index
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

        self.mode = self._read_mode()
        self.diff = D.get_difficulty(
            self.result.get("difficulty", getattr(self.game, "difficulty", None)))
        self._derive()

    def _read_mode(self) -> str:
        """
        Which mode the finished run belonged to.

        The result dict is authoritative, because it was written by the run
        itself: `GameplayScene` always stamps ``mode`` and ``story`` into it.
        A dict that carries neither is therefore *not* a campaign result - it
        is a legacy or hand-built one - and it resolves to free play, which is
        the harmless reading: free play never routes anybody into narrative or
        touches the story bookkeeping.  ``game.mode`` is consulted only when
        there is no result dict at all, i.e. when this screen was entered
        cold and has nothing else to go on.
        """
        try:
            raw = self.result.get("mode")
            if isinstance(raw, str):
                key = raw.strip().lower()
                if key in C.GAME_MODES:
                    return key
            flag = self.result.get("story")
            if isinstance(flag, bool):
                return C.MODE_STORY if flag else C.MODE_FREE
            if self.result:
                return C.MODE_FREE
            live = str(getattr(self.game, "mode", C.MODE_FREE) or "").strip().lower()
            return live if live in C.GAME_MODES else C.MODE_FREE
        except Exception:
            return C.MODE_FREE

    def _derive(self) -> None:
        """Recompute everything that follows from the level index."""
        try:
            level = get_level(self.level_index)
            self.final = self.level_index >= LEVEL_COUNT - 1
            self.next_index = self.level_index if self.final else self.level_index + 1
            self.star_targets = self._read_targets(level)
            self.par = max(1, int(self.star_targets[0]))
        except Exception:
            self.final = False
            self.next_index = self.level_index
            self.star_targets = (1, 2, 3)
            self.par = 1

    def _read_targets(self, level: Any) -> Tuple[int, int, int]:
        """
        The difficulty-adjusted one/two/three-star thresholds.

        `GameplayScene` already computed these for the run, so they are used
        verbatim when they belong to the level on screen; otherwise they are
        rebuilt from the level table through :func:`difficulty.apply_star_targets`
        so a hand-built result dict still gets an honest par.
        """
        if self._result_level == self.level_index:
            raw = self.result.get("star_targets")
            try:
                vals = [int(v) for v in list(raw)[:3]]  # type: ignore[arg-type]
                if len(vals) == 3 and vals[0] > 0 and vals[0] <= vals[1] <= vals[2]:
                    return (vals[0], vals[1], vals[2])
            except Exception:
                pass
        try:
            return D.apply_star_targets(self.diff, level.star_targets())
        except Exception:
            return (1, 2, 3)

    # -- mode / story helpers ----------------------------------------------
    @property
    def is_story(self) -> bool:
        """True when the finished run was part of the campaign."""
        return self.mode == C.MODE_STORY

    def _beat_seen(self, index: int) -> bool:
        """Has this level's narrative already been read?  False on any doubt."""
        try:
            return bool(self.game.save.beat_seen(int(index)))
        except Exception:
            return False

    def _mark_beat(self, index: int) -> None:
        """Remember that a level's narrative has been shown.  Never raises."""
        try:
            idx = int(index)
        except (TypeError, ValueError):
            return
        if 0 <= idx <= _MAX_BEAT:
            try:
                self.game.save.mark_beat_seen(idx)
            except Exception:
                pass

    def _flush_save(self) -> None:
        """Persist the profile, tolerating a read-only or missing save file."""
        try:
            self.game.save.flush()
        except Exception:
            pass

    # -- lifecycle ---------------------------------------------------------
    def on_enter(self, **kwargs: Any) -> None:
        try:
            self._read_result()
            # A kwarg wins over the handoff dict, if a caller bothers to pass one.
            if "level_index" in kwargs:
                try:
                    self.level_index = int(clamp(float(kwargs["level_index"]),
                                                 0, LEVEL_COUNT - 1))
                    self._derive()
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

    # -- button rows -------------------------------------------------------
    def _row(self, specs: Sequence[Tuple[str, str, str]], y: float,
             width: int, gap: int = 24) -> List[Button]:
        """Lay a horizontal row of buttons out, centred on the canvas."""
        if not specs:
            return []
        total = width * len(specs) + gap * (len(specs) - 1)
        x = (C.WINDOW_W - total) * 0.5
        return [Button((x + i * (width + gap), y, width, BUTTON_H),
                       label, style=style, data=action)
                for i, (label, style, action) in enumerate(specs)]

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
                nxt = int(clamp(self.next_index, 0, LEVEL_COUNT - 1))
                self.game.level_index = nxt
                self._go(C.SCENE_GAME, level_index=nxt)
            elif key == "story":
                self._story_continue()
            elif key == "levels":
                self._go(C.SCENE_LEVELS)
            elif key == "menu":
                self._go(C.SCENE_MENU)
        except Exception:
            pass

    def _story_continue(self) -> None:
        """Overridden by :class:`VictoryScene`; a no-op everywhere else."""
        self._go(C.SCENE_MENU)

    def _actions(self) -> Set[str]:
        """Every action currently reachable by mouse - keys mirror these only."""
        out: Set[str] = set()
        for button in self.buttons:
            if button.enabled and isinstance(button.data, str):
                out.add(button.data)
        return out

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
        available = self._actions()

        def fire(action: str) -> None:
            if action in available:
                self.game.audio.play("click")
                self._act(action)

        if key in (pygame.K_ESCAPE,):
            fire("menu")
        elif key in (pygame.K_l,):
            fire("levels")
        elif key in (pygame.K_r,):
            fire("retry")
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

    def _diff_color(self) -> RGB:
        """The badge colour: the run's own, falling back to the table's."""
        raw = self.result.get("difficulty_color")
        try:
            if raw is not None:
                return (int(raw[0]) & 0xFF, int(raw[1]) & 0xFF, int(raw[2]) & 0xFF)
        except Exception:
            pass
        try:
            c = self.diff.color
            return (int(c[0]), int(c[1]), int(c[2]))
        except Exception:
            return P.UI_WHITE

    def _diff_label(self) -> str:
        """The badge text, e.g. ``EXPERT``."""
        raw = self.result.get("difficulty_label") or self.result.get("difficulty_name")
        if isinstance(raw, str) and raw.strip():
            return raw.strip().upper()
        try:
            return str(self.diff.hud_label).upper()
        except Exception:
            return "NORMAL"

    def _draw_difficulty_badge(self, surface: pygame.Surface, cx: float, cy: float,
                               *, muted: bool = False) -> None:
        """The coloured difficulty chip both screens carry under the title."""
        color = self._diff_color()
        if muted:
            color = _mute(color, 0.30, 0.90)
        try:
            font = self.game.fonts.small
        except Exception:
            font = None
        _draw_badge(surface, cx, cy, self._diff_label(), color, font,
                    glow=0.16 if muted else 0.34)

    def _draw_par_line(self, surface: pygame.Surface, cx: float, y: float) -> None:
        """``PAR 140  (+320)`` - the score measured against the adjusted par."""
        try:
            delta = int(self.score) - int(self.par)
            good = delta >= 0
            col = P.UI_GOOD if good else P.lerp_color(self.theme.text_dim,
                                                      P.UI_WARN, 0.45)
            label = "{} PAR {:,}   ({})".format(
                self._diff_label(), int(self.par), _fmt_delta(delta))
            draw_text(surface, label, self.game.fonts.small, col, (cx, y),
                      align="center")
        except Exception:
            pass

    def _chapter_line(self) -> str:
        """``CHAPTER II  -  LEVEL 05`` in story mode, ``LEVEL 05`` otherwise."""
        base = "LEVEL {:02d}".format(self.level_index + 1)
        if not self.is_story:
            return base
        try:
            roman = str(self.result.get("chapter_roman") or "").strip()
            if not roman:
                roman = str(S.get_chapter(self.level_index).roman)
            return "CHAPTER {}   -   {}".format(roman, base)
        except Exception:
            return base


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
        """
        Story mode gets two honest choices, free play keeps the browser.

        A campaign death is not a menu of levels - offering LEVEL SELECT there
        would quietly drop the player out of the run they are in the middle of,
        so the only ways on are "again" and "give up".
        """
        if self.is_story:
            return self._row((("RETRY LEVEL", "primary", "retry"),
                              ("ABANDON RUN", "ghost", "menu")),
                             604, width=300, gap=36)
        return self._row((("RETRY", "primary", "retry"),
                          ("LEVEL SELECT", "ghost", "levels"),
                          ("MENU", "ghost", "menu")),
                         604, width=268, gap=26)

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

        draw_panel(surface, (300, 88, 680, 480), theme, alpha=196, glow=0.20)

        # ---- heading -----------------------------------------------------
        # Two stacked glows (wide + tight) give the words real weight without
        # the cost of a blurred text surface.
        head_y = 106.0
        breathe = 0.35 + 0.20 * pulse(t, 1.4)
        draw_glow_circle(surface, cx, head_y + 46, 250.0,
                         P.shade(theme.hazard, 0.85), breathe)
        draw_glow_circle(surface, cx, head_y + 46, 120.0, theme.hazard, breathe * 0.9)
        draw_text(surface, "GAME OVER", fonts.huge,
                  P.lerp_color(P.UI_WHITE, theme.hazard, 0.35), (cx, head_y),
                  align="center")

        draw_text(surface, self._chapter_line(), fonts.tiny,
                  P.shade(theme.accent2, 1.0), (cx, head_y + 100), align="center")
        draw_text(surface, self.level_name.upper(), fonts.body,
                  theme.text_dim, (cx, head_y + 118), align="center")

        # The difficulty stays legible but joins the drained palette - this
        # screen is desaturated on purpose and a hot chip would fight it.
        self._draw_difficulty_badge(surface, cx, 272.0, muted=True)

        # ---- summary -----------------------------------------------------
        x_label, x_value = 372.0, 908.0
        y = 294.0
        pitch = 44.0
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
        rule_y = y + pitch * 4 + 6
        pygame.draw.line(surface, P.with_alpha(theme.grid, 200),
                         (372, rule_y), (908, rule_y))

        self._draw_par_line(surface, cx, rule_y + 12.0)

        if self.new_best:
            self._draw_new_best(surface, cx, rule_y + 44.0)
        else:
            best = 0
            try:
                best = int(self.game.save.best_for(self.level_index,
                                                   self.diff.key))
            except Exception:
                best = 0
            draw_text(surface, "LEVEL BEST  {:,}".format(max(best, self.score)),
                      fonts.small, theme.text_dim, (cx, rule_y + 46.0),
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
    """
    The run ended well: confetti, a star ceremony and a rolling score.

    In story mode this scene is also the campaign's switchboard: CONTINUE
    builds the narrative card stack for the transition and hands it to
    :data:`~snake.config.SCENE_STORY` along with the level that follows it.
    """

    veil_alpha = 112

    def __init__(self, game: "Game") -> None:
        super().__init__(game)
        self._stars_shown: int = 0          # how many have popped so far
        self._confetti: float = 0.0         # seconds of shower left
        self._confetti_acc: float = 0.0
        self._star_x: List[float] = []
        self._star_y: float = 292.0

    # -- setup -------------------------------------------------------------
    def _build_buttons(self) -> List[Button]:
        """
        Story mode leads with CONTINUE; free play keeps the browser row.

        REPLAY and MENU survive in both because every action on this screen has
        to be reachable with the mouse alone, and a campaign player still needs
        a way to grind a level for stars or stop for the night.
        """
        if self.is_story:
            if self.final:
                return self._row((("CONTINUE", "primary", "story"),
                                  ("MENU", "ghost", "menu")),
                                 618, width=300, gap=36)
            return self._row((("CONTINUE", "primary", "story"),
                              ("REPLAY", "ghost", "retry"),
                              ("MENU", "ghost", "menu")),
                             618, width=268, gap=26)

        specs: List[Tuple[str, str, str]] = []
        if not self.final:
            specs.append(("NEXT LEVEL", "primary", "next"))
        specs.append(("REPLAY", "ghost" if not self.final else "primary", "retry"))
        specs.append(("LEVEL SELECT", "ghost", "levels"))
        specs.append(("MENU", "ghost", "menu"))
        return self._row(specs, 618, width=248 if len(specs) == 4 else 268, gap=22)

    # `final` and `mode` decide the button row, and both are resolved by
    # `_read_result` / `_derive` before the base class calls `_build_buttons`,
    # so this scene needs no `on_enter` of its own.

    def _on_ready(self) -> None:
        self._stars_shown = 0
        self._confetti = 2.6
        self._confetti_acc = 0.0
        self._star_y = 292.0
        centre = C.WINDOW_W * 0.5
        self._star_x = [centre - 118.0, centre, centre + 118.0]
        try:
            self.game.audio.play("win")
            self.game.fx.flash(self.theme.accent, 0.45)
            self._firework(centre, 250.0, 1.15)
        except Exception:
            pass

    # -- story hand-off ----------------------------------------------------
    def _story_cards(self) -> List[Any]:
        """
        The cards CONTINUE shows before the next level starts.

        Outro of the level just cleared, the chapter plate when the next level
        opens a chapter, then the next level's intro - unless the save says it
        has already been read, so a replay of an old chapter does not re-tell a
        story the player has seen.  Every step is independently guarded: a card
        that cannot be built simply drops out of the stack.
        """
        cards: List[Any] = []
        try:
            beat = S.get_beat(self.level_index)
            cards.append(S.StoryCard(title=beat.title, lines=tuple(beat.outro),
                                     speaker=beat.speaker))
        except Exception:
            pass
        self._mark_beat(self.level_index)

        if self.final:
            try:
                cards.append(S.EPILOGUE)
            except Exception:
                pass
            return cards

        nxt = self.next_index
        try:
            if S.chapter_start(nxt):
                cards.append(S.get_chapter(nxt))
        except Exception:
            pass
        if not self._beat_seen(nxt):
            try:
                beat = S.get_beat(nxt)
                cards.append(S.StoryCard(title=beat.title, lines=tuple(beat.intro),
                                         speaker=beat.speaker))
            except Exception:
                pass
        self._mark_beat(nxt)
        return cards

    def _story_continue(self) -> None:
        """CONTINUE: narrate the transition, then hand over to the next level."""
        cards = self._story_cards()

        if self.final:
            try:
                self.game.save.set_story_complete(True)
            except Exception:
                pass
            self._flush_save()
            self._go(C.SCENE_STORY, cards=cards, next_scene=C.SCENE_MENU,
                     next_kwargs={}, theme=self.theme)
            return

        nxt = int(clamp(self.next_index, 0, LEVEL_COUNT - 1))
        try:
            self.game.save.set_story_progress(nxt)
        except Exception:
            pass
        self._flush_save()
        try:
            self.game.level_index = nxt
        except Exception:
            pass
        self._go(C.SCENE_STORY, cards=cards, next_scene=C.SCENE_GAME,
                 next_kwargs={"level_index": nxt},
                 theme=P.theme_for_level(nxt))

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

        draw_panel(surface, (272, 66, 736, 520), theme, alpha=190, glow=0.42)

        # ---- heading -----------------------------------------------------
        head_y = 88.0
        glow = 0.55 + 0.30 * pulse(t, 2.0)
        draw_glow_circle(surface, cx, head_y + 40, 260.0, theme.accent, glow * 0.8)
        draw_glow_circle(surface, cx, head_y + 40, 130.0, theme.accent2, glow * 0.7)
        if self.final:
            draw_text(surface, "CAMPAIGN COMPLETE", fonts.title,
                      P.lerp_color(P.UI_WHITE, theme.accent, 0.20),
                      (cx, head_y), align="center")
            sub_y = head_y + 84.0
        else:
            draw_text(surface, "LEVEL CLEAR", fonts.huge,
                      P.lerp_color(P.UI_WHITE, theme.accent, 0.25),
                      (cx, head_y), align="center")
            sub_y = head_y + 100.0

        draw_text(surface, "{}  -  {}".format(self._chapter_line(),
                                              self.level_name.upper()),
                  fonts.body, theme.text_dim, (cx, sub_y), align="center")

        self._draw_difficulty_badge(surface, cx, sub_y + 48.0)

        # ---- stars --------------------------------------------------------
        self._star_y = 292.0
        self._draw_stars(surface)

        # ---- score --------------------------------------------------------
        score_y = self._star_y + 60.0
        shown = self.counted(self.score)
        heat = self.count_frac()
        draw_glow_circle(surface, cx, score_y + 30, 170.0, P.UI_GOLD,
                         0.20 + 0.35 * heat)
        draw_text(surface, "{:,}".format(shown), fonts.display_at(58),
                  P.lerp_color(P.UI_WHITE, P.UI_GOLD, 0.5), (cx, score_y),
                  align="center")

        self._draw_par_line(surface, cx, score_y + 68.0)

        # ---- footer stats --------------------------------------------------
        foot_y = score_y + 98.0
        if self.final:
            self._draw_total_stars(surface, cx, foot_y, t)
        else:
            bits = [
                "FOOD {} / {}".format(self.counted(self.food_eaten), self.goal_food),
                "COMBO x{}".format(max(1, self.max_combo)),
                "TIME {}".format(_fmt_time(self.elapsed)),
            ]
            if self.deaths:
                bits.append("LIVES LOST {}".format(self.deaths))
            draw_text(surface, "     ".join(bits), fonts.small,
                      theme.text_dim, (cx, foot_y + 4), align="center")

        if self.new_best:
            draw_text(surface, "NEW BEST", fonts.h2,
                      P.lerp_color(P.UI_GOLD, P.UI_WHITE, 0.3 + 0.3 * pulse(t, 6.0)),
                      (cx, foot_y + 32.0), align="center")

    def _draw_total_stars(self, surface: pygame.Surface, cx: float, y: float,
                          t: float) -> None:
        """
        The campaign tally under CAMPAIGN COMPLETE.

        A story run is counted on the difficulty it was actually played on, so
        finishing on expert reports the expert tally rather than the
        difficulty-agnostic "best ever, however you played it" number the free
        play screens show.
        """
        try:
            save = self.game.save
            if self.is_story:
                total = int(save.total_stars(self.diff.key))
                label = "{} STARS".format(self._diff_label())
            else:
                total = int(save.total_stars())
                label = "TOTAL STARS"
            cap = int(save.max_stars())
        except Exception:
            total, cap, label = self.stars, LEVEL_COUNT * 3, "TOTAL STARS"
        draw_text(surface, "{}  {} / {}".format(label, self.counted(total), cap),
                  self.game.fonts.h2,
                  P.lerp_color(P.UI_GOLD, P.UI_WHITE, 0.25 + 0.2 * pulse(t, 3.0)),
                  (cx, y), align="center")

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
