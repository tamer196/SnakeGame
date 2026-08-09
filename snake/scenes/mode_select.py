"""
The mode-and-difficulty screen for NEON SERPENT.

This is what ``PLAY`` on the title screen leads to, and it is the first place
the player meets the two headline features of v2: the twelve-level **story
campaign** and the **difficulty table**.  Everything on it is decided with the
mouse alone; the keyboard shortcuts are a convenience layer on top.

Layout, top to bottom:

*   Two large hoverable cards side by side - STORY MODE and FREE PLAY - each
    with procedural artwork (a descending chain of twelve linked nodes for the
    campaign, a scattered constellation of twelve level tiles for free play), a
    title, a one-line description and a live progress readout.
*   A four-tile difficulty picker fed straight from
    :func:`snake.core.difficulty.all_difficulties`, showing each mode's name,
    accent colour, blurb and - the point of the row - its *concrete stakes*:
    how many lives it grants, how fast it runs, what it pays, and whether your
    own body kills you.
*   A BACK button to the title screen.

The cards and tiles are :class:`snake.gfx.ui.Button` instances with an empty
label used purely as hit / hover / click targets; this scene paints all of
their content itself, exactly as ``level_select`` does, so the artwork can be
richer than a label and an icon.  They fly in with a stagger on every entry.

Nothing here raises: ``update`` and ``draw`` are wrapped, every save-file query
is defensive, and a broken profile degrades to "nothing unlocked" rather than
taking the menu down.
"""

from __future__ import annotations

import math
from typing import TYPE_CHECKING, Any, Dict, List, Optional, Sequence, Tuple

import pygame

from .. import config as C
from .. import palette as P
from ..core import difficulty as D
from ..core import story as S
from ..core.contracts import Scene, clamp, ease_out_back, ease_out_cubic, pulse
from ..core.level import LEVEL_COUNT
from ..core.story import StoryCard
from ..gfx.background import Background, make_background
from ..gfx.render import draw_glow_circle
from ..gfx.ui import Button, draw_text

if TYPE_CHECKING:  # pragma: no cover - typing only
    from ..main import Game

__all__ = ["ModeSelectScene", "PROLOGUE_BEAT"]

RGB = Tuple[int, int, int]

# --------------------------------------------------------------------------
# The prologue's slot in ``SaveData.seen_beats``
# --------------------------------------------------------------------------
#: ``seen_beats`` stores level beats under their own zero-based index (0..11).
#: The prologue belongs to no level, so it is filed far above that range - well
#: inside the 0..255 window ``core.save`` accepts, and impossible to collide
#: with a beat even if the campaign ever grows.  This scene is the only place
#: that decides whether the prologue is shown, so it is also the only place that
#: has to know the number.
PROLOGUE_BEAT: int = 100

# --------------------------------------------------------------------------
# Layout (authored against the fixed 1280x720 canvas)
# --------------------------------------------------------------------------
MARGIN = 54

CARD_W = 540
CARD_H = 250
CARD_Y = 72
CARD_L_X = MARGIN
CARD_R_X = C.WINDOW_W - MARGIN - CARD_W

RESTART_RECT = pygame.Rect(CARD_L_X + 2, CARD_Y + CARD_H + 10, 192, 30)

DIFF_LABEL_Y = 374
TILE_Y = 398
TILE_H = 208
TILE_GAP = 16
TILE_W = (C.WINDOW_W - MARGIN * 2 - TILE_GAP * 3) // 4

# Held off the bottom-left corner on purpose.  The finished frame goes through
# the CRT bezel in `gfx/effects.py`, which passes only ~20% of the drawn light
# at (MARGIN, 628); measured against a flat grey canvas this rect now sits at
# ~0.78.  It still clears the difficulty tiles above it (they end at
# TILE_Y + TILE_H = 606) and the hint line to its right.
BACK_RECT = pygame.Rect(240, 612, 210, 52)

# Entrance animation.
INTRO_TIME = 0.46
INTRO_RISE = 62.0
CARD_DELAY = (0.00, 0.09)
TILE_DELAY_BASE = 0.20
TILE_DELAY_STEP = 0.06

#: Same exponential constants ``Button`` uses internally, so the content this
#: scene paints tracks the body art the button paints.
HOVER_K = 13.0
PRESS_K = 22.0


# --------------------------------------------------------------------------
# Text wrapping
# --------------------------------------------------------------------------
_WRAP_CACHE: Dict[Any, Tuple[str, ...]] = {}


def _wrap(text: str, font: Optional[pygame.font.Font], width: int,
          max_lines: int = 3) -> Tuple[str, ...]:
    """
    Greedy word-wrap `text` to `width` pixels, capped at `max_lines`.

    Cached by (text, font identity, width) because it is called every frame for
    four static blurbs.  Never raises: a font that cannot measure yields a
    single unwrapped line.
    """
    key = (text, id(font), int(width), int(max_lines))
    cached = _WRAP_CACHE.get(key)
    if cached is not None:
        return cached
    lines: List[str] = []
    try:
        words = str(text).split()
        current = ""
        for word in words:
            trial = word if not current else current + " " + word
            if font is not None and font.size(trial)[0] > width and current:
                lines.append(current)
                current = word
                if len(lines) >= max_lines:
                    break
            else:
                current = trial
        if current and len(lines) < max_lines:
            lines.append(current)
    except Exception:
        lines = [str(text)]
    if len(_WRAP_CACHE) > 256:
        _WRAP_CACHE.clear()
    out = tuple(lines[:max_lines])
    _WRAP_CACHE[key] = out
    return out


def _mult(value: float) -> str:
    """Format a multiplier the way the tiles show it: ``x1.15``."""
    try:
        return "x{:.2f}".format(float(value)).rstrip("0").rstrip(".")
    except (TypeError, ValueError):  # pragma: no cover - table is sane
        return "x1"


#: How each ``Difficulty.self_mode`` reads on the tile, and how alarming it is.
_SELF_TEXT: Dict[str, Tuple[str, Tuple[int, int, int]]] = {
    "off": ("YOUR TAIL CANNOT KILL YOU", P.UI_GOOD),
    "forgiving": ("YOUR TAIL KILLS - FORGIVING", P.UI_WARN),
    "normal": ("YOUR TAIL KILLS - TIGHT", P.UI_WARN),
    "strict": ("YOUR TAIL KILLS - INSTANTLY", P.UI_BAD),
}


# ==========================================================================
# Animated card record
# ==========================================================================
class _Card:
    """One animated hit-target: a rect, its button, and its hover weights."""

    __slots__ = ("key", "button", "home", "delay", "appear", "hover_t", "press_t")

    def __init__(self, key: Any, button: Button, home: pygame.Rect,
                 delay: float) -> None:
        self.key: Any = key
        self.button: Button = button
        self.home: pygame.Rect = home.copy()
        self.delay: float = float(delay)
        self.appear: float = 0.0
        self.hover_t: float = 0.0
        self.press_t: float = 0.0

    def reset(self) -> None:
        """
        Rewind the entrance - scene instances are cached and reused.

        Toggling ``enabled`` off is the supported way to clear a button's
        internal "the mouse went down inside me" latch, which would otherwise
        survive a scene switch and fire a phantom click on the next release.
        """
        self.appear = 0.0
        self.hover_t = 0.0
        self.press_t = 0.0
        self.button.rect = self.home.copy()
        self.button.set_enabled(False)

    @property
    def rect(self) -> pygame.Rect:
        """Where the card is drawn this frame (the button follows it)."""
        return self.button.rect


# ==========================================================================
# ModeSelectScene
# ==========================================================================
class ModeSelectScene(Scene):
    """Pick story or free play, and pick how hard the game is going to be."""

    transparent = False
    blocks_update = True

    def __init__(self, game: "Game") -> None:
        super().__init__(game)

        self._t: float = 0.0             # scene-local clock, drives animation
        self._elapsed: float = 0.0       # seconds since on_enter

        self._cards: List[_Card] = []    # the two mode cards
        self._tiles: List[_Card] = []    # the four difficulty tiles
        self._back: Optional[Button] = None
        self._restart: Optional[Button] = None

        self._difficulty: str = C.DEFAULT_DIFFICULTY
        self._restart_arm: float = 0.0   # >0 while RESTART is awaiting a confirm
        self._launching: str = ""        # non-empty while the launch flourish plays
        self._launch_t: float = 0.0

        self._bg: Optional[Background] = None
        self._bg_style: str = ""
        self._theme: P.Theme = P.THEMES[0]

        self._build()

    # ------------------------------------------------------------------
    # Construction
    # ------------------------------------------------------------------
    def _build(self) -> None:
        """Create every hit target once; ``on_enter`` only resets them."""
        self._cards = []
        for i, (key, x) in enumerate((("story", CARD_L_X), ("free", CARD_R_X))):
            home = pygame.Rect(x, CARD_Y, CARD_W, CARD_H)
            # An empty label keeps Button.draw from stamping text over the art
            # this scene paints on top of it.
            button = Button(home, "", style="tile", data=key)
            self._cards.append(_Card(key, button, home, CARD_DELAY[i]))

        self._tiles = []
        for i, diff in enumerate(D.all_difficulties()):
            x = MARGIN + i * (TILE_W + TILE_GAP)
            home = pygame.Rect(x, TILE_Y, TILE_W, TILE_H)
            button = Button(home, "", style="tile", data=("diff", diff.key))
            self._tiles.append(
                _Card(diff.key, button, home, TILE_DELAY_BASE + i * TILE_DELAY_STEP))

        self._back = Button(BACK_RECT, "BACK", style="ghost", data="back")
        # A small face: this is a destructive footnote to the story card, not a
        # headline action, and the default danger face shouts at h2 size.
        self._restart = Button(RESTART_RECT, "RESTART STORY", style="danger",
                               font=self._font("small"), data="restart")

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------
    def on_enter(self, **kwargs: Any) -> None:
        """Full reset. Scene instances are cached and reused by the Game."""
        try:
            self._t = 0.0
            self._elapsed = 0.0
            self._restart_arm = 0.0
            self._launching = ""
            self._launch_t = 0.0

            self._difficulty = self._current_difficulty()
            for card in self._cards:
                card.reset()
                card.button.set_enabled(True)
            for tile in self._tiles:
                tile.reset()
                tile.button.set_enabled(True)
            if self._back is not None:
                self._back.rect = BACK_RECT.copy()
                self._back.set_enabled(False)
                self._back.set_enabled(True)
            if self._restart is not None:
                self._restart.rect = RESTART_RECT.copy()
                self._restart.label = "RESTART STORY"
                self._restart.set_enabled(False)
                self._restart.set_enabled(True)

            self._ensure_background()
        except Exception:
            pass

    def on_exit(self) -> None:
        # Backgrounds hold a pre-rendered full-window surface; drop ours so it
        # does not stay resident behind the whole rest of the session.
        self._bg = None
        self._bg_style = ""

    # ------------------------------------------------------------------
    # Save-file / state queries (all defensive)
    # ------------------------------------------------------------------
    @property
    def _save(self) -> Any:
        return getattr(self.game, "save", None)

    def _current_difficulty(self) -> str:
        """The difficulty the game is currently set to, resolved to a real key."""
        key = getattr(self.game, "difficulty", None)
        if not D.is_difficulty_key(key):
            key = getattr(self._save, "difficulty", None)
        return D.get_difficulty(key).key

    def _story_index(self) -> int:
        """Zero-based level the campaign would resume at."""
        try:
            idx = int(getattr(self._save, "story_progress", 0) or 0)
        except (TypeError, ValueError):
            idx = 0
        return int(clamp(float(idx), 0.0, float(max(0, LEVEL_COUNT - 1))))

    def _story_complete(self) -> bool:
        try:
            return bool(getattr(self._save, "story_complete", False))
        except Exception:
            return False

    def _story_started(self) -> bool:
        """True once the player has actually seen any of the campaign."""
        if self._story_index() > 0 or self._story_complete():
            return True
        try:
            return bool(self._save.beat_seen(PROLOGUE_BEAT))
        except Exception:
            return False

    def _unlocked_count(self) -> int:
        try:
            return int(clamp(float(int(self._save.unlocked)), 0.0, float(LEVEL_COUNT)))
        except Exception:
            return 1

    def _stars(self) -> Tuple[int, int]:
        """(stars earned, stars available)."""
        try:
            return (int(self._save.total_stars()), max(1, int(self._save.max_stars())))
        except Exception:
            return (0, max(1, LEVEL_COUNT * 3))

    def _is_unlocked(self, index: int) -> bool:
        try:
            return bool(self._save.is_unlocked(int(index)))
        except Exception:
            return index == 0

    # ------------------------------------------------------------------
    # Presentation helpers
    # ------------------------------------------------------------------
    def _font(self, name: str, size: int = 0) -> Optional[pygame.font.Font]:
        """A named face from the FontBook, or a sized display face."""
        fonts = getattr(self.game, "fonts", None)
        if fonts is None:
            return None
        try:
            if size > 0 and name == "display":
                return fonts.display_at(size)
            if size > 0 and name == "ui":
                return fonts.get(size, True)
            return getattr(fonts, name, None)
        except Exception:
            return None

    def _play(self, name: str, volume: float = 1.0) -> None:
        try:
            self.game.audio.play(name, volume)
        except Exception:
            pass

    def _ensure_background(self) -> None:
        """Build the backdrop for the level the campaign is sitting on."""
        try:
            theme = P.theme_for_level(self._story_index())
        except Exception:
            theme = P.THEMES[0]
        self._theme = theme
        style = str(getattr(theme, "bg_style", "grid"))
        if self._bg is not None and style == self._bg_style:
            return
        try:
            self._bg = make_background(style, theme, (0, 0, C.WINDOW_W, C.WINDOW_H))
            self._bg_style = style
        except Exception:
            self._bg = None
            self._bg_style = ""

    # ------------------------------------------------------------------
    # Events
    # ------------------------------------------------------------------
    def handle_event(self, event: "pygame.event.Event") -> None:
        try:
            if self._launching:
                return                      # the flourish owns the last moment

            for card in self._cards:
                if card.button.handle_event(event):
                    self._activate(str(card.key))
            for tile in self._tiles:
                if tile.button.handle_event(event):
                    self._pick_difficulty(str(tile.key))
            if self._restart is not None and self._show_restart() \
                    and self._restart.handle_event(event):
                self._activate("restart")
            if self._back is not None and self._back.handle_event(event):
                self._activate("back")

            if getattr(event, "type", None) == pygame.KEYDOWN:
                self._handle_key(getattr(event, "key", None))
        except Exception:
            pass

    def _handle_key(self, key: Any) -> None:
        """Keyboard shortcuts - a convenience layer, never the only route."""
        if key in (pygame.K_ESCAPE, pygame.K_BACKSPACE):
            self._activate("back")
        elif key in (pygame.K_RETURN, pygame.K_KP_ENTER, pygame.K_SPACE):
            self._activate("story")
        elif key in (pygame.K_f, pygame.K_l):
            self._activate("free")
        elif key in (pygame.K_LEFT, pygame.K_a):
            self._pick_difficulty(D.prev_difficulty(self._difficulty))
        elif key in (pygame.K_RIGHT, pygame.K_d):
            self._pick_difficulty(D.next_difficulty(self._difficulty))
        elif key in (pygame.K_1, pygame.K_2, pygame.K_3, pygame.K_4):
            index = (pygame.K_1, pygame.K_2, pygame.K_3, pygame.K_4).index(key)
            order = D.all_difficulties()
            if index < len(order):
                self._pick_difficulty(order[index].key)

    def _show_restart(self) -> bool:
        """RESTART STORY only exists once there is a campaign to restart."""
        return self._story_complete() or self._story_index() > 0

    # ------------------------------------------------------------------
    # Actions
    # ------------------------------------------------------------------
    def _pick_difficulty(self, key: str) -> None:
        """Select a difficulty, persist it, and let the player hear it land."""
        diff = D.get_difficulty(key)
        changed = diff.key != self._difficulty
        self._difficulty = diff.key
        try:
            self.game.difficulty = diff.key
        except Exception:
            pass
        try:
            self._save.set_difficulty(diff.key)
            self._save.flush()
        except Exception:
            pass
        self._play("click" if changed else "hover", 0.9 if changed else 0.5)

    def _activate(self, action: str) -> None:
        """Run one action. Shared by the mouse and the keyboard shortcuts."""
        if action == "restart" and self._restart_arm <= 0.0:
            # Wiping a campaign is worth one extra click.
            self._restart_arm = 3.0
            if self._restart is not None:
                self._restart.label = "ERASE PROGRESS?"
            self._play("hit", 0.7)
            return

        self._play("click")
        if action == "back":
            self.game.switch_scene(C.SCENE_MENU)
        elif action == "free":
            self._start_free()
        elif action == "story":
            self._begin_launch("story")
        elif action == "restart":
            self._restart_arm = 0.0
            self._reset_story()
            self._begin_launch("story")

    def _begin_launch(self, which: str) -> None:
        """Kick off a short flourish, then hand over on the next update."""
        self._launching = which
        self._launch_t = 0.22
        self._play("start", 0.9)
        try:
            self.game.fx.flash(self._theme.accent, 0.30)
        except Exception:
            pass
        try:
            card = self._cards[0] if which == "story" else self._cards[1]
            self.game.particles.burst(card.rect.centerx, card.rect.centery,
                                      self._theme.accent, count=26)
        except Exception:
            pass

    def _start_free(self) -> None:
        """FREE PLAY: remember the mode and hand over to the level select."""
        try:
            self.game.mode = C.MODE_FREE
        except Exception:
            pass
        try:
            self._save.set_mode(C.MODE_FREE)
            self._save.flush()
        except Exception:
            pass
        self.game.switch_scene(C.SCENE_LEVELS)

    def _reset_story(self) -> None:
        """Rewind the campaign so RESTART really does start from Cold Start."""
        save = self._save
        if save is None:
            return
        try:
            save.set_story_complete(False)
        except Exception:
            pass
        try:
            # `set_story_progress` deliberately only moves forward, so a genuine
            # restart has to put the field back itself.
            save.story_progress = 0
        except Exception:
            pass
        try:
            save.seen_beats = [i for i in list(save.seen_beats) if i != PROLOGUE_BEAT]
        except Exception:
            pass
        try:
            save.save()
        except Exception:
            pass

    def _story_cards(self, index: int) -> List[Any]:
        """
        The card stack the story presenter shows before level `index` starts.

        Prologue (first time only), then the chapter card, then the level's own
        intro beat.  Any one of them failing to build simply drops out.
        """
        cards: List[Any] = []
        try:
            seen = bool(self._save.beat_seen(PROLOGUE_BEAT))
        except Exception:
            seen = False
        if not seen:
            try:
                cards.append(S.PROLOGUE)
                self._save.mark_beat_seen(PROLOGUE_BEAT)
            except Exception:
                pass
        try:
            # Hand the Chapter over *as itself*.  StoryScene promotes anything
            # exposing ``roman`` to its full chapter plate (huge numeral, long
            # rule, extra air); flattening it into a StoryCard first threw the
            # numeral away and the chapter opening rendered as an ordinary
            # card - which is not what VictoryScene does at a chapter boundary,
            # so the same beat looked different depending on how it was reached.
            cards.append(S.get_chapter(index))
        except Exception:
            pass
        try:
            beat = S.get_beat(index)
            cards.append(StoryCard(title=beat.title, lines=tuple(beat.intro),
                                   speaker=beat.speaker))
        except Exception:
            pass
        return cards

    def _start_story(self) -> None:
        """STORY: set the mode, the level, and hand over to the presenter."""
        index = self._story_index()
        try:
            self.game.mode = C.MODE_STORY
            self.game.level_index = index
        except Exception:
            pass
        try:
            self._save.set_mode(C.MODE_STORY)
        except Exception:
            pass
        cards = self._story_cards(index)
        try:
            self._save.flush()
        except Exception:
            pass
        self.game.switch_scene(C.SCENE_STORY, cards=cards,
                               next_scene=C.SCENE_GAME,
                               next_kwargs={"level_index": index},
                               theme=P.theme_for_level(index))

    # ------------------------------------------------------------------
    # Update
    # ------------------------------------------------------------------
    def update(self, dt: float) -> None:
        try:
            dt = clamp(float(dt), 0.0, C.MAX_DT)
            self._t += dt
            self._elapsed += dt

            if self._restart_arm > 0.0:
                self._restart_arm -= dt
                if self._restart_arm <= 0.0:
                    self._restart_arm = 0.0
                    if self._restart is not None:
                        self._restart.label = "RESTART STORY"

            mouse = getattr(self.game, "mouse_pos", (0.0, 0.0))
            held = False
            try:
                held = bool(self.game.mouse_buttons.get(1))
            except Exception:
                held = False
            k_hover = 1.0 - math.exp(-HOVER_K * dt)
            k_press = 1.0 - math.exp(-PRESS_K * dt)

            for card in self._cards + self._tiles:
                self._update_card(card, dt, mouse, held, k_hover, k_press)

            # The restart button only exists while there is a campaign to wipe,
            # so it is only fed the mouse while it is on screen.
            for widget in (self._back,
                           self._restart if self._show_restart() else None):
                if widget is None:
                    continue
                widget.update(dt, mouse)
                if widget.just_entered:
                    self._play("hover", 0.55)

            if self._bg is not None:
                self._bg.update(dt)

            try:
                self.game.particles.ambient(
                    (0, 0, C.WINDOW_W, C.WINDOW_H),
                    P.lerp_color(self._theme.accent, self._theme.accent2, 0.5),
                    dt, rate=7.0)
            except Exception:
                pass

            if self._launching:
                self._launch_t -= dt
                if self._launch_t <= 0.0:
                    which, self._launching = self._launching, ""
                    if which == "story":
                        self._start_story()
        except Exception:
            pass

    def _update_card(self, card: _Card, dt: float, mouse: Sequence[float],
                     held: bool, k_hover: float, k_press: float) -> None:
        """Advance one card's entrance, hover weight and button state."""
        card.appear = clamp((self._elapsed - card.delay) / max(0.001, INTRO_TIME),
                            0.0, 1.0)
        rise = (1.0 - ease_out_cubic(card.appear)) * INTRO_RISE
        rect = card.home.copy()
        rect.y += int(rise)
        card.button.rect = rect

        card.button.update(dt, mouse)
        if card.button.just_entered:
            self._play("hover", 0.55)
        target_h = 1.0 if card.button.hovered else 0.0
        card.hover_t += (target_h - card.hover_t) * k_hover
        target_p = 1.0 if (card.button.hovered and held) else 0.0
        card.press_t += (target_p - card.press_t) * k_press

    # ------------------------------------------------------------------
    # Draw
    # ------------------------------------------------------------------
    def draw(self, surface: pygame.Surface) -> None:
        prev_clip = None
        try:
            prev_clip = surface.get_clip()
            theme = self._theme
            t = self._t

            if self._bg is not None:
                self._bg.draw(surface)
            else:
                surface.fill(getattr(theme, "bg_bottom", (8, 10, 20)))
            try:
                self.game.particles.draw(surface)
            except Exception:
                pass

            self._draw_header(surface, theme, t)

            fonts = getattr(self.game, "fonts", None)
            for card in self._cards:
                if card.appear <= 0.0:
                    continue
                card.button.draw(surface, theme, fonts, t)
                if card.key == "story":
                    self._draw_story_card(surface, card, theme, t)
                else:
                    self._draw_free_card(surface, card, theme, t)

            if self._restart is not None and self._show_restart():
                self._restart.draw(surface, theme, fonts, t)

            self._draw_difficulty_header(surface, theme, t)
            for tile in self._tiles:
                if tile.appear <= 0.0:
                    continue
                tile.button.draw(surface, theme, fonts, t)
                self._draw_difficulty_tile(surface, tile, theme, t)

            if self._back is not None:
                self._back.draw(surface, theme, fonts, t)
            self._draw_footer(surface, theme)
        except Exception:
            pass
        finally:
            try:
                surface.set_clip(prev_clip)
            except Exception:
                pass

    # -- header / footer -------------------------------------------------
    def _draw_header(self, surface: pygame.Surface, theme: P.Theme, t: float) -> None:
        k = ease_out_back(clamp(self._elapsed / 0.5, 0.0, 1.0))
        y = 14 - (1.0 - k) * 44.0
        draw_text(surface, "CHOOSE YOUR DESCENT", self._font("display", 34),
                  P.lerp_color(theme.text, P.UI_WHITE, 0.4),
                  (C.WINDOW_W * 0.5, y), align="center")

    def _draw_difficulty_header(self, surface: pygame.Surface, theme: P.Theme,
                                t: float) -> None:
        diff = D.get_difficulty(self._difficulty)
        draw_text(surface, "DIFFICULTY", self._font("small"),
                  P.lerp_color(theme.text_dim, P.UI_WHITE, 0.5),
                  (MARGIN, DIFF_LABEL_Y))
        draw_text(surface,
                  "SELECTED  -  {}  ({} {})".format(
                      diff.label, D.lives_for(diff),
                      "LIFE" if D.lives_for(diff) == 1 else "LIVES"),
                  self._font("small"), P.lerp_color(diff.color, P.UI_WHITE, 0.25),
                  (C.WINDOW_W - MARGIN, DIFF_LABEL_Y), align="right")

    def _draw_footer(self, surface: pygame.Surface, theme: P.Theme) -> None:
        draw_text(surface,
                  "CLICK A CARD TO PLAY  -  CLICK A DIFFICULTY TO CHANGE IT  -  "
                  "ESC GOES BACK",
                  self._font("tiny"), P.shade(theme.text_dim, 0.85),
                  (C.WINDOW_W - MARGIN, BACK_RECT.centery - 8), align="right")

    # -- shared card chrome ----------------------------------------------
    def _card_accent(self, card: _Card, theme: P.Theme) -> RGB:
        """Story leans on accent2, free play on accent, so they read apart."""
        base = theme.accent2 if card.key == "story" else theme.accent
        return P.lerp_color(base, P.UI_WHITE, 0.25 * clamp(card.hover_t, 0.0, 1.0))

    def _draw_card_frame(self, surface: pygame.Surface, card: _Card,
                         accent: RGB, t: float) -> pygame.Rect:
        """Shoulder bar, hover halo and hover rim. Returns the card rect."""
        rect = card.rect
        hov = clamp(card.hover_t, 0.0, 1.0)
        try:
            pygame.draw.rect(surface, accent,
                             pygame.Rect(rect.x + 12, rect.y + 2, rect.w - 24, 5),
                             border_radius=3)
            if hov > 0.01:
                pygame.draw.rect(surface, P.lerp_color(accent, P.UI_WHITE, 0.45),
                                 rect, 2, border_radius=C.UI_CORNER + 6)
                draw_glow_circle(surface, rect.centerx, rect.y + 4, 150.0, accent,
                                 0.16 * hov)
        except Exception:
            pass
        return rect

    def _draw_card_footer(self, surface: pygame.Surface, rect: pygame.Rect,
                          card: _Card, accent: RGB, left: str, right: str,
                          action: str) -> None:
        """The readout strip and the call to action along the bottom."""
        hov = clamp(card.hover_t, 0.0, 1.0)
        line_y = rect.y + 178
        try:
            pygame.draw.line(surface, P.shade(accent, 0.35),
                             (rect.x + 22, line_y), (rect.right - 22, line_y), 1)
        except Exception:
            pass
        draw_text(surface, left, self._font("small"),
                  P.lerp_color(P.UI_DIM, P.UI_WHITE, 0.45),
                  (rect.x + 22, line_y + 9))
        draw_text(surface, right, self._font("small"),
                  P.lerp_color(P.UI_DIM, P.UI_WHITE, 0.45),
                  (rect.right - 22, line_y + 9), align="right")
        draw_text(surface, action, self._font("body"),
                  P.lerp_color(accent, P.UI_WHITE, 0.25 + 0.55 * hov),
                  (rect.right - 22, rect.bottom - 34), align="right")

    # -- story card ------------------------------------------------------
    def _draw_story_card(self, surface: pygame.Surface, card: _Card,
                         theme: P.Theme, t: float) -> None:
        accent = self._card_accent(card, theme)
        rect = self._draw_card_frame(surface, card, accent, t)
        index = self._story_index()
        complete = self._story_complete()
        started = self._story_started()

        self._draw_chain(surface,
                         pygame.Rect(rect.x + 22, rect.y + 18, rect.w - 44, 78),
                         index, complete, accent, theme, t)

        draw_text(surface, "STORY MODE", self._font("display", 34),
                  P.lerp_color(theme.text, P.UI_WHITE, 0.45),
                  (rect.x + 22, rect.y + 104))
        draw_text(surface,
                  "Descend twelve layers in order, one chapter at a time.",
                  self._font("small"), P.shade(theme.text_dim, 1.05),
                  (rect.x + 22, rect.y + 152))

        chapter = S.get_chapter(index)
        try:
            last_roman = S.CHAPTERS[-1].roman
        except Exception:
            last_roman = "IV"
        if complete:
            left = "CAMPAIGN COMPLETE"
        else:
            left = "CHAPTER {} OF {}  -  {}".format(
                chapter.roman, last_roman, chapter.title.upper())
        right = "LEVEL {} / {}".format(index + 1, LEVEL_COUNT)
        action = "CONTINUE >" if started else "BEGIN >"
        self._draw_card_footer(surface, rect, card, accent, left, right, action)

    def _draw_chain(self, surface: pygame.Surface, area: pygame.Rect, index: int,
                    complete: bool, accent: RGB, theme: P.Theme, t: float) -> None:
        """
        Twelve linked nodes stepping down and across, the reached ones lit.

        Chapter openings carry an extra ring, so the four acts of the descent
        are visible without a single word of label.
        """
        n = max(2, LEVEL_COUNT)
        reached = n - 1 if complete else int(clamp(float(index), 0.0, float(n - 1)))
        pts: List[Tuple[float, float]] = []
        try:
            for i in range(n):
                f = i / float(n - 1)
                x = area.x + 16.0 + f * (area.w - 32.0)
                y = (area.y + 14.0 + f * (area.h - 34.0)
                     + math.sin(i * 1.35 + t * 0.7) * 4.0)
                pts.append((x, y))

            for i in range(n - 1):
                lit = i < reached
                col = P.lerp_color(accent, P.UI_WHITE, 0.2) if lit \
                    else P.shade(theme.text_dim, 0.45)
                pygame.draw.line(surface, col,
                                 (int(pts[i][0]), int(pts[i][1])),
                                 (int(pts[i + 1][0]), int(pts[i + 1][1])),
                                 3 if lit else 1)

            for i, (x, y) in enumerate(pts):
                lit = i <= reached
                here = (i == reached) and not complete
                col = P.lerp_color(accent, P.UI_WHITE, 0.35) if lit \
                    else P.shade(theme.text_dim, 0.55)
                radius = 7 if here else (5 if lit else 4)
                if here:
                    radius += int(1.6 * pulse(t, 2.0))
                if lit:
                    draw_glow_circle(surface, x, y, 17.0 + (9.0 if here else 0.0),
                                     col, 0.30 + (0.35 if here else 0.0))
                pygame.draw.circle(surface, col, (int(x), int(y)), radius)
                if not lit:
                    pygame.draw.circle(surface, P.shade(theme.bg_bottom, 1.0),
                                       (int(x), int(y)), max(1, radius - 2))
                if i % max(1, S.CHAPTER_SIZE) == 0:
                    pygame.draw.circle(surface, P.shade(col, 0.9),
                                       (int(x), int(y)), radius + 5, 1)
        except Exception:
            pass

    # -- free play card --------------------------------------------------
    def _draw_free_card(self, surface: pygame.Surface, card: _Card,
                        theme: P.Theme, t: float) -> None:
        accent = self._card_accent(card, theme)
        rect = self._draw_card_frame(surface, card, accent, t)

        self._draw_constellation(
            surface, pygame.Rect(rect.x + 22, rect.y + 18, rect.w - 44, 78),
            accent, theme, t)

        draw_text(surface, "FREE PLAY", self._font("display", 34),
                  P.lerp_color(theme.text, P.UI_WHITE, 0.45),
                  (rect.x + 22, rect.y + 104))
        draw_text(surface,
                  "Any level you have unlocked, any order, as often as you like.",
                  self._font("small"), P.shade(theme.text_dim, 1.05),
                  (rect.x + 22, rect.y + 152))

        stars, cap = self._stars()
        left = "{} OF {} UNLOCKED".format(self._unlocked_count(), LEVEL_COUNT)
        right = "{} / {} STARS".format(stars, cap)
        self._draw_card_footer(surface, rect, card, accent, left, right,
                               "LEVEL SELECT >")

    def _draw_constellation(self, surface: pygame.Surface, area: pygame.Rect,
                            accent: RGB, theme: P.Theme, t: float) -> None:
        """
        The twelve levels scattered as a constellation of tiles.

        Positions come from a golden-angle spiral squashed into the art strip:
        deterministic (so the picture never jitters between frames or runs) but
        irregular enough to read as scattered rather than as a grid.
        """
        n = max(1, LEVEL_COUNT)
        cx = area.centerx
        cy = area.centery
        rx = area.w * 0.46
        ry = area.h * 0.40
        pts: List[Tuple[float, float]] = []
        try:
            for i in range(n):
                ang = i * 2.39996 + 0.7
                rad = math.sqrt((i + 0.55) / float(n))
                pts.append((cx + math.cos(ang) * rad * rx,
                            cy + math.sin(ang) * rad * ry))

            # Link the tiles left to right rather than in spiral order: the
            # spiral hops across the whole strip and reads as scribble, while
            # an x-ordered path reads as a constellation.
            faint = P.shade(theme.text_dim, 0.40)
            chain = sorted(pts, key=lambda p: p[0])
            for i in range(len(chain) - 1):
                pygame.draw.line(surface, faint,
                                 (int(chain[i][0]), int(chain[i][1])),
                                 (int(chain[i + 1][0]), int(chain[i + 1][1])), 1)

            for i, (x, y) in enumerate(pts):
                open_ = self._is_unlocked(i)
                size = 13 if open_ else 10
                tile = pygame.Rect(0, 0, size, size)
                tile.center = (int(x), int(y))
                if open_:
                    twinkle = 0.28 + 0.20 * pulse(t * 0.8 + i * 0.7, 1.0)
                    col = P.lerp_color(accent, P.UI_WHITE, 0.30)
                    draw_glow_circle(surface, x, y, 18.0, col, twinkle)
                    pygame.draw.rect(surface, col, tile, border_radius=3)
                else:
                    pygame.draw.rect(surface, P.shade(theme.text_dim, 0.55), tile,
                                     1, border_radius=3)
        except Exception:
            pass

    # -- difficulty tiles -------------------------------------------------
    def _draw_difficulty_tile(self, surface: pygame.Surface, tile: _Card,
                              theme: P.Theme, t: float) -> None:
        """Name, colour, blurb and the concrete stakes, at a glance."""
        diff = D.get_difficulty(tile.key)
        rect = tile.rect
        hov = clamp(tile.hover_t, 0.0, 1.0)
        chosen = diff.key == self._difficulty
        col = diff.color
        bright = P.lerp_color(col, P.UI_WHITE, 0.25 + 0.30 * hov)

        try:
            pygame.draw.rect(surface, bright,
                             pygame.Rect(rect.x + 10, rect.y + 2, rect.w - 20, 5),
                             border_radius=3)
            if chosen:
                # A halo hugging the shoulder, not a blob in the middle of the
                # text: the tile has to stay legible while it is selected.
                draw_glow_circle(surface, rect.centerx, rect.y + 4,
                                 rect.w * 0.55, col, 0.14 + 0.05 * pulse(t, 1.4))
                pygame.draw.rect(surface, bright, rect, 3,
                                 border_radius=C.UI_CORNER + 6)
            elif hov > 0.01:
                pygame.draw.rect(surface, P.shade(bright, 0.8), rect, 2,
                                 border_radius=C.UI_CORNER + 6)
        except Exception:
            pass

        x = rect.x + 16
        draw_text(surface, diff.label, self._font("h2"),
                  bright if (chosen or hov > 0.3) else P.lerp_color(col, P.UI_WHITE, 0.1),
                  (x, rect.y + 16))
        if chosen:
            draw_text(surface, "SELECTED", self._font("tiny"),
                      P.lerp_color(col, P.UI_WHITE, 0.55),
                      (rect.right - 16, rect.y + 24), align="right")

        f_tiny = self._font("tiny")
        for i, line in enumerate(_wrap(diff.blurb, f_tiny, rect.w - 32, 3)):
            draw_text(surface, line, f_tiny, P.shade(theme.text_dim, 1.0),
                      (x, rect.y + 56 + i * 17))

        lives = D.lives_for(diff)
        rows = (
            ("LIVES", "{}".format(lives), P.UI_GOOD if lives >= 3 else
             (P.UI_WARN if lives >= 2 else P.UI_BAD)),
            ("SPEED", _mult(diff.speed_mult), P.UI_WHITE),
            ("SCORE", _mult(diff.score_mult), P.UI_GOLD),
        )
        for i, (label, value, value_col) in enumerate(rows):
            row_y = rect.y + 114 + i * 22
            draw_text(surface, label, f_tiny, P.shade(theme.text_dim, 0.95),
                      (x, row_y))
            draw_text(surface, value, self._font("small"), value_col,
                      (rect.right - 16, row_y - 2), align="right")

        text, tone = _SELF_TEXT.get(diff.self_mode,
                                    ("YOUR TAIL KILLS", P.UI_WARN))
        draw_text(surface, text, f_tiny, P.lerp_color(tone, P.UI_WHITE, 0.15),
                  (x, rect.y + 182))
