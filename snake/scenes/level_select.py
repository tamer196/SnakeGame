"""
Level select for NEON SERPENT - the free-play campaign map.

Twelve cards, three across and four down, so that **each row is exactly one
story chapter**.  The left gutter of every row carries that chapter's band: a
roman numeral, the title straight out of :func:`snake.core.story.get_chapter`
and the level range it covers.  Reading the screen top to bottom therefore
reads the descent in the same order the story tells it.

Four things carry the feel:

*   **The cards fly in.**  Each one has a staggered delay and slides up into
    place.  The animation drives `button.rect` itself rather than a separate
    draw offset, so the hit box always agrees with the pixels on screen.
*   **Difficulty is a first-class switch.**  Four small tiles along the top
    pick the mode.  Changing it writes `game.difficulty`, persists it through
    `save.set_difficulty`, re-reads every record - best scores and stars are
    stored per difficulty - and replays the entrance so the refresh is visible.
*   **Hover is the navigation.**  Whatever card the pointer is over becomes the
    "focus": it drives the detail panel at the bottom, the header accents and
    the backdrop.  The focus is sticky - moving off a card leaves the last one
    described instead of blanking the panel.
*   **Four card states read at a glance.**  Locked (veiled, padlocked), unlocked
    but unplayed (hollow stars, "UNPLAYED"), cleared (gold stars and a best
    score) and *perfect* - a three-star clear gets a rainbow rim, a PERFECT tag
    and rainbow pips, so a completed row is unmistakable from across the room.

Mouse-only operation is guaranteed: every card, every difficulty tile and the
BACK button are real `gfx.ui.Button` instances.  The keyboard shortcuts
(ESC / ENTER / arrows / Q,E) are extra.

Clicking an unlocked card sets ``game.mode = C.MODE_FREE`` and launches that
level; BACK returns to the menu.
"""

from __future__ import annotations

import math
from typing import Any, Dict, List, Optional, Sequence, Tuple

import pygame

from .. import config as C
from .. import palette as P
from ..core import difficulty as D
from ..core import story as S
from ..core.contracts import Scene, clamp, ease_out_cubic, pulse
from ..core.level import LEVEL_COUNT, LevelDef, get_level
from ..gfx.background import make_background
from ..gfx.render import draw_glow_circle
from ..gfx.ui import Button, draw_bar, draw_panel, draw_text

__all__ = ["LevelSelectScene"]

RGB = Tuple[int, int, int]

# --------------------------------------------------------------------------
# Layout.  Three columns by four rows: one chapter per row, with the chapter
# band living in the left gutter.  Everything derives from the canvas size in
# config so the grid stays centred if those constants are ever retuned.
# --------------------------------------------------------------------------
COLS: int = 3
ROWS: int = 4

BAND_X: int = 36
BAND_W: int = 168

GRID_LEFT: int = 216
GRID_TOP: int = 100
CARD_W: int = 329
CARD_H: int = 104
CARD_GAP_X: int = 20
CARD_GAP_Y: int = 16

DETAIL_RECT = pygame.Rect(48, 586, C.WINDOW_W - 96, 98)

# BACK is deliberately *not* in the top-left corner.  The finished frame goes
# through the CRT bezel in `gfx/effects.py` - a 0.80 vignette, a 0.62 squircle
# edge rolloff and an opaque rounded corner cut - which between them pass only
# ~4% of the light at (36, 12).  Measured with a flat grey canvas pushed
# through `EffectStack.present`, the old rect rendered at 0.04 of the drawn
# brightness: the only mouse route off this screen was invisible.  Sitting the
# button on the grid's left edge and on the difficulty row's baseline puts it
# at ~0.68 and lines it up with two things that were already there.
BACK_RECT = pygame.Rect(216, 48, 148, 42)

#: The difficulty switcher: four tiles, centred under the title.
DIFF_TILE_W: int = 112
DIFF_TILE_H: int = 36
DIFF_TILE_GAP: int = 10
DIFF_ROW_Y: int = 52
DIFF_ROW_W: int = DIFF_TILE_W * 4 + DIFF_TILE_GAP * 3
DIFF_ROW_X: int = (C.WINDOW_W - DIFF_ROW_W) // 2

#: Seconds between one card starting its entrance and the next one starting.
INTRO_STAGGER: float = 0.05
#: Seconds one card takes to fly in.
INTRO_TIME: float = 0.42
#: How far below its resting place a card starts.
INTRO_RISE: float = 44.0
#: Entrance timings are multiplied by this when the grid is merely *refreshing*
#: after a difficulty change, so the re-read reads as a ripple, not a reload.
REFRESH_SCALE: float = 0.45


class _Record:
    """The one difficulty's worth of save data a single card displays."""

    __slots__ = ("best", "stars", "unlocked")

    def __init__(self, best: int, stars: int, unlocked: bool) -> None:
        self.best: int = int(best)
        self.stars: int = int(stars)
        self.unlocked: bool = bool(unlocked)

    @property
    def cleared(self) -> bool:
        """True once the level has ever been finished on this difficulty."""
        return self.stars > 0 or self.best > 0

    @property
    def perfect(self) -> bool:
        """True for a full three-star clear - the celebratory state."""
        return self.stars >= 3

    @property
    def state(self) -> str:
        """One of ``"locked"``, ``"unplayed"``, ``"cleared"``, ``"perfect"``."""
        if not self.unlocked:
            return "locked"
        if self.perfect:
            return "perfect"
        return "cleared" if self.cleared else "unplayed"


_EMPTY_RECORD = _Record(0, 0, False)


def _star_points(cx: float, cy: float, r: float) -> List[Tuple[int, int]]:
    """The ten vertices of a five-pointed star centred on (cx, cy)."""
    pts: List[Tuple[int, int]] = []
    for i in range(10):
        # Alternate between the outer points and the inner waist of the star.
        rad = r if i % 2 == 0 else r * 0.42
        ang = -math.pi * 0.5 + i * (math.pi / 5.0)
        pts.append((int(cx + math.cos(ang) * rad), int(cy + math.sin(ang) * rad)))
    return pts


def _wrap(text: str, font: pygame.font.Font, width: int, max_lines: int = 2) -> List[str]:
    """Greedy word wrap; the last line is ellipsised if the text overflows."""
    words = str(text).split()
    if not words or max_lines < 1:
        return []

    def fits(s: str) -> bool:
        try:
            return font.size(s)[0] <= width
        except Exception:
            return len(s) < 60

    lines: List[str] = []
    current = words[0]
    index = 1
    while index < len(words):
        trial = current + " " + words[index]
        if fits(trial):
            current = trial
            index += 1
            continue
        lines.append(current)
        if len(lines) >= max_lines:
            break
        current = words[index]
        index += 1
    else:
        lines.append(current)

    # Words left over means the text was truncated - say so.
    if index < len(words) and lines:
        lines[-1] = lines[-1].rstrip(" .,") + "..."
    return lines[:max_lines]


def _tint(surface: pygame.Surface, rect: pygame.Rect, color: Sequence[int],
          alpha: int, corner: int) -> None:
    """
    Fill `rect` with a translucent rounded wash.

    ``pygame.draw`` does not alpha-blend onto an opaque canvas, so the wash has
    to be composed on an SRCALPHA scratch surface and blitted.  Never raises.
    """
    try:
        if rect.w < 2 or rect.h < 2:
            return
        scratch = pygame.Surface((rect.w, rect.h), pygame.SRCALPHA)
        pygame.draw.rect(scratch, P.with_alpha(color, int(clamp(alpha, 0, 255))),
                         (0, 0, rect.w, rect.h), border_radius=int(corner))
        surface.blit(scratch, rect.topleft)
    except Exception:
        pass


class _Card:
    """One level tile: its button, its resting place and its entrance timer."""

    __slots__ = ("index", "level", "button", "home", "delay", "appear",
                 "hover_t", "press_t")

    def __init__(self, index: int, level: LevelDef, button: Button,
                 home: pygame.Rect, delay: float) -> None:
        self.index: int = index
        self.level: LevelDef = level
        self.button: Button = button
        self.home: pygame.Rect = home
        self.delay: float = delay
        self.appear: float = 0.0     # 0..1 entrance progress
        self.hover_t: float = 0.0    # mirrors Button's private hover weight
        self.press_t: float = 0.0

    def reset(self) -> None:
        """Send the card back to the start of its entrance."""
        self.appear = 0.0
        self.hover_t = 0.0
        self.press_t = 0.0
        self.button.rect = self.home.copy()


class _DiffTile:
    """One difficulty in the top switcher: a button plus its table row."""

    __slots__ = ("diff", "button")

    def __init__(self, diff: D.Difficulty, button: Button) -> None:
        self.diff: D.Difficulty = diff
        self.button: Button = button


class LevelSelectScene(Scene):
    """The campaign map: pick a difficulty, pick a level, see what it pays."""

    transparent = False
    blocks_update = True

    def __init__(self, game: Any) -> None:
        super().__init__(game)
        self.cards: List[_Card] = []
        self.diff_tiles: List[_DiffTile] = []
        self.back: Optional[Button] = None
        self.focus: int = 0            # index whose detail panel is showing
        self.elapsed: float = 0.0
        self._records: Dict[int, _Record] = {}
        self._diff_key: str = C.DEFAULT_DIFFICULTY
        self._diff_hover: Optional[str] = None
        self._intro_scale: float = 1.0
        self._refresh_t: float = 0.0   # >0 briefly after a difficulty change
        self._bg: Any = None
        self._bg_style: str = ""
        self._launching: float = 0.0   # >0 while the launch flourish plays
        self._fonts_bound: bool = False
        self._build()

    # ------------------------------------------------------------------
    # Construction
    # ------------------------------------------------------------------
    def _build(self) -> None:
        """Create the twelve tiles, the four difficulty tiles and BACK, once."""
        self.cards = []
        for i in range(min(LEVEL_COUNT, COLS * ROWS)):
            col, row = i % COLS, i // COLS
            x = GRID_LEFT + col * (CARD_W + CARD_GAP_X)
            y = GRID_TOP + row * (CARD_H + CARD_GAP_Y)
            home = pygame.Rect(x, y, CARD_W, CARD_H)
            # The label is drawn by this scene, not by the Button: an empty
            # label keeps Button.draw from stamping text over the card art.
            button = Button(home, "", style="tile", data=i)
            # A diagonal wave reads better than a raw reading-order stagger.
            delay = (col + row) * INTRO_STAGGER
            self.cards.append(_Card(i, get_level(i), button, home, delay))

        self.diff_tiles = []
        for i, diff in enumerate(D.all_difficulties()):
            rect = pygame.Rect(DIFF_ROW_X + i * (DIFF_TILE_W + DIFF_TILE_GAP),
                               DIFF_ROW_Y, DIFF_TILE_W, DIFF_TILE_H)
            # Empty label again: the tile paints its own name in its own colour.
            self.diff_tiles.append(
                _DiffTile(diff, Button(rect, "", style="ghost", data=diff.key)))

        self.back = Button(BACK_RECT, "BACK", style="ghost", data="back")

    def _bind_fonts(self) -> None:
        """Give BACK a size that fits its small rect (fonts exist by now)."""
        if self._fonts_bound or self.back is None:
            return
        try:
            self.back.font = self.game.fonts.get(18, bold=True)
            self._fonts_bound = True
        except Exception:
            self._fonts_bound = True   # never retry a broken FontBook per frame

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------
    def on_enter(self, **kwargs: Any) -> None:
        """Full reset: scene instances are cached and reused by the Game."""
        self.elapsed = 0.0
        self._launching = 0.0
        self._diff_hover = None
        self._refresh_t = 0.0
        self._intro_scale = 1.0
        self._bind_fonts()

        self._diff_key = D.get_difficulty(getattr(self.game, "difficulty", None)).key
        self._refresh_records()

        for card in self.cards:
            card.reset()
            card.button.set_enabled(self._record(card.index).unlocked)
        for tile in self.diff_tiles:
            tile.button.rect = pygame.Rect(tile.button.rect)
            tile.button.set_enabled(True)
        if self.back is not None:
            self.back.rect = BACK_RECT.copy()
            self.back.set_enabled(True)

        # Focus whatever the player was last playing, if it is reachable.
        want = int(kwargs.get("level_index", getattr(self.game, "level_index", 0)) or 0)
        self.focus = want if self._record(want).unlocked else self._highest_unlocked()
        self._ensure_background()

    def on_exit(self) -> None:
        # Backgrounds are large pre-rendered surfaces; drop ours on the way out
        # so a long session does not keep twelve of them alive.
        self._bg = None
        self._bg_style = ""

    # ------------------------------------------------------------------
    # Save-file queries (all defensive: a broken save must not crash the menu)
    # ------------------------------------------------------------------
    def _refresh_records(self) -> None:
        """
        Re-read every card's best score and star count for `self._diff_key`.

        Records are per difficulty, so this runs on entry and again every time
        the switcher moves.  Cached rather than queried per frame: twelve cards
        times two lookups times sixty frames is work with no reason to exist.
        """
        save = getattr(self.game, "save", None)
        key = self._diff_key
        records: Dict[int, _Record] = {}
        for i in range(LEVEL_COUNT):
            best = stars = 0
            unlocked = (i == 0)
            if save is not None:
                try:
                    best = int(save.best_for(i, difficulty=key))
                except Exception:
                    best = 0
                try:
                    stars = int(save.stars_for(i, difficulty=key))
                except Exception:
                    stars = 0
                try:
                    unlocked = bool(save.is_unlocked(i))
                except Exception:
                    unlocked = (i == 0)
            records[i] = _Record(best, stars, unlocked)
        self._records = records

    def _record(self, index: int) -> _Record:
        """The cached record for `index`, or a locked blank for a bad index."""
        try:
            return self._records.get(int(index), _EMPTY_RECORD)
        except Exception:
            return _EMPTY_RECORD

    def _star_total(self) -> Tuple[int, int]:
        """``(stars earned on this difficulty, stars available)``."""
        try:
            total = int(self.game.save.total_stars(difficulty=self._diff_key))
        except Exception:
            total = sum(r.stars for r in self._records.values())
        try:
            cap = max(1, int(self.game.save.max_stars()))
        except Exception:
            cap = max(1, LEVEL_COUNT * 3)
        return total, cap

    def _highest_unlocked(self) -> int:
        best = 0
        for card in self.cards:
            if self._record(card.index).unlocked:
                best = card.index
        return best

    # ------------------------------------------------------------------
    # Theme / backdrop
    # ------------------------------------------------------------------
    @property
    def theme(self) -> P.Theme:
        """The focused level's theme drives every accent on this screen."""
        try:
            return get_level(self.focus).theme
        except Exception:
            return P.theme_for_level(0)

    @property
    def diff(self) -> D.Difficulty:
        """The difficulty row the grid is currently reporting."""
        return D.get_difficulty(self._diff_key)

    def _ensure_background(self) -> None:
        """Rebuild the backdrop only when the focused style actually changes."""
        theme = self.theme
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
    # Input
    # ------------------------------------------------------------------
    def handle_event(self, event: Any) -> None:
        try:
            if self._launching > 0.0:
                return                       # input is dead during the wipe
            for tile in self.diff_tiles:
                if tile.button.handle_event(event):
                    self._set_difficulty(tile.diff.key)
                    return
            for card in self.cards:
                if card.button.handle_event(event):
                    self._choose(card)
                    return
            if self.back is not None and self.back.handle_event(event):
                self._go_back()
                return

            if getattr(event, "type", None) == pygame.KEYDOWN:
                self._handle_key(event)
        except Exception:
            pass

    def _handle_key(self, event: Any) -> None:
        """Keyboard shortcuts - a convenience layered over the mouse UI."""
        key = getattr(event, "key", None)
        if key in (pygame.K_ESCAPE, pygame.K_BACKSPACE):
            self._go_back()
        elif key in (pygame.K_RETURN, pygame.K_KP_ENTER, pygame.K_SPACE):
            for card in self.cards:
                if card.index == self.focus:
                    self._choose(card)
                    break
        elif key in (pygame.K_q, pygame.K_LEFTBRACKET):
            self._set_difficulty(D.prev_difficulty(self._diff_key))
        elif key in (pygame.K_e, pygame.K_RIGHTBRACKET, pygame.K_TAB):
            self._set_difficulty(D.next_difficulty(self._diff_key))
        elif key in (pygame.K_LEFT, pygame.K_a):
            self._move_focus(-1)
        elif key in (pygame.K_RIGHT, pygame.K_d):
            self._move_focus(1)
        elif key in (pygame.K_UP, pygame.K_w):
            self._move_focus(-COLS)
        elif key in (pygame.K_DOWN, pygame.K_s):
            self._move_focus(COLS)

    def _move_focus(self, step: int) -> None:
        target = int(clamp(self.focus + step, 0, max(0, len(self.cards) - 1)))
        if target != self.focus:
            self.focus = target
            self._ensure_background()
            self._play("hover", 0.5)

    def _play(self, name: str, volume: float = 1.0) -> None:
        try:
            self.game.audio.play(name, volume)
        except Exception:
            pass

    # ------------------------------------------------------------------
    # Actions
    # ------------------------------------------------------------------
    def _set_difficulty(self, key: str) -> None:
        """
        Adopt `key` as the active difficulty and re-read the whole grid.

        Persists through the save file immediately, because a player who picks
        EXPERT here and then quits from the menu should still be on EXPERT next
        launch.  Re-plays the entrance at :data:`REFRESH_SCALE` speed so the
        change of numbers is visibly a *re-read*, not a silent swap.
        """
        new_key = D.get_difficulty(key).key
        if new_key == self._diff_key:
            self._play("click", 0.5)
            return
        self._diff_key = new_key
        self._play("click")
        try:
            self.game.difficulty = new_key
        except Exception:
            pass
        try:
            self.game.save.set_difficulty(new_key)
        except Exception:
            pass

        self._refresh_records()
        self.elapsed = 0.0
        self._intro_scale = REFRESH_SCALE
        self._refresh_t = 1.0
        for card in self.cards:
            card.reset()
            card.button.set_enabled(self._record(card.index).unlocked)
        try:
            self.game.fx.flash(self.diff.color, 0.18)
        except Exception:
            pass

    def _go_back(self) -> None:
        self._play("click")
        try:
            self.game.switch_scene(C.SCENE_MENU)
        except Exception:
            pass

    def _choose(self, card: _Card) -> None:
        """Launch a level.  Locked cards never reach here (button disabled)."""
        if not card.button.enabled or not self._record(card.index).unlocked:
            self._play("hit", 0.5)
            return
        self.focus = card.index
        self._play("start")
        theme = card.level.theme
        try:
            cx, cy = card.button.rect.center
            self.game.particles.burst(cx, cy, theme.accent, count=30,
                                      speed=(90, 320), life=(0.35, 0.85))
            self.game.fx.flash(theme.accent, 0.35)
        except Exception:
            pass
        self._launching = 0.12           # a beat of dead input before the wipe
        # Picking a level from this screen is free play by definition.
        try:
            self.game.mode = C.MODE_FREE
        except Exception:
            pass
        try:
            self.game.level_index = card.index
        except Exception:
            pass

    def _do_launch(self) -> None:
        """Perform the actual scene switch once the flourish has played."""
        index = int(getattr(self.game, "level_index", self.focus))
        try:
            self.game.switch_scene(C.SCENE_GAME, level_index=index)
        except TypeError:
            # A gameplay scene that does not take the kwarg still gets the
            # level through game.level_index, which was set above.
            try:
                self.game.switch_scene(C.SCENE_GAME)
            except Exception:
                pass
        except Exception:
            pass

    # ------------------------------------------------------------------
    # Update
    # ------------------------------------------------------------------
    def update(self, dt: float) -> None:
        try:
            dt = clamp(float(dt), 0.0, 0.1)
            self.elapsed += dt
            self._refresh_t = max(0.0, self._refresh_t - dt * 1.6)
            mouse = getattr(self.game, "mouse_pos", (0.0, 0.0))
            try:
                held = bool(self.game.mouse_buttons.get(1))
            except Exception:
                held = False

            # Same exponential constants Button uses internally, so the content
            # this scene paints tracks the body art the Button paints.
            k_hover = 1.0 - math.exp(-13.0 * dt)
            k_press = 1.0 - math.exp(-22.0 * dt)
            scale = max(0.05, self._intro_scale)

            hovered_index = -1
            for card in self.cards:
                span = max(0.001, INTRO_TIME * scale)
                card.appear = clamp((self.elapsed - card.delay * scale) / span,
                                    0.0, 1.0)
                rise = (1.0 - ease_out_cubic(card.appear)) * INTRO_RISE * scale
                card.button.rect = self.home_offset(card, rise)

                card.button.update(dt, mouse)
                if card.button.just_entered:
                    self._play("hover", 0.55)
                if card.button.hovered:
                    hovered_index = card.index

                target_h = 1.0 if card.button.hovered else 0.0
                card.hover_t += (target_h - card.hover_t) * k_hover
                target_p = 1.0 if (card.button.hovered and held) else 0.0
                card.press_t += (target_p - card.press_t) * k_press

            if hovered_index >= 0 and hovered_index != self.focus:
                self.focus = hovered_index
                self._ensure_background()

            self._diff_hover = None
            for tile in self.diff_tiles:
                tile.button.update(dt, mouse)
                if tile.button.just_entered:
                    self._play("hover", 0.55)
                if tile.button.hovered:
                    self._diff_hover = tile.diff.key

            if self.back is not None:
                self.back.update(dt, mouse)
                if self.back.just_entered:
                    self._play("hover", 0.55)

            if self._bg is not None:
                self._bg.update(dt)

            if self._launching > 0.0:
                self._launching -= dt
                if self._launching <= 0.0:
                    self._launching = 0.0
                    self._do_launch()
        except Exception:
            pass

    def home_offset(self, card: _Card, rise: float) -> pygame.Rect:
        """The card's rect for this frame: its home, pushed down by `rise`."""
        r = card.home.copy()
        r.y += int(rise)
        return r

    # ------------------------------------------------------------------
    # Draw
    # ------------------------------------------------------------------
    def draw(self, surface: pygame.Surface) -> None:
        prev_clip = None
        try:
            prev_clip = surface.get_clip()
            theme = self.theme
            t = float(getattr(self.game, "time", 0.0))

            if self._bg is not None:
                self._bg.draw(surface)
            else:
                surface.fill(theme.bg_bottom)

            self._draw_header(surface, theme, t)
            self._draw_chapter_bands(surface, t)
            for card in self.cards:
                if card.appear <= 0.0:
                    continue            # not born yet
                self._draw_card(surface, card, t)
            if self.back is not None:
                self.back.draw(surface, theme, self.game.fonts, t)
            self._draw_detail(surface, theme, t)
        except Exception:
            pass
        finally:
            try:
                surface.set_clip(prev_clip)
            except Exception:
                pass

    # -- header ---------------------------------------------------------
    def _draw_header(self, surface: pygame.Surface, theme: P.Theme, t: float) -> None:
        """Title, the difficulty switcher and the star tally for that mode."""
        fonts = self.game.fonts
        draw_text(surface, "SELECT A LEVEL", fonts.display_at(30), theme.text,
                  (C.WINDOW_W * 0.5, 10), align="center")

        for tile in self.diff_tiles:
            self._draw_diff_tile(surface, tile, theme, t)

        total, cap = self._star_total()
        frac = clamp(total / float(max(1, cap)), 0.0, 1.0)
        diff = self.diff

        right = C.WINDOW_W - 36
        draw_text(surface, diff.label, fonts.tiny, diff.color, (right, 6),
                  align="right")
        draw_text(surface, f"{total} / {cap} STARS", fonts.get(19, bold=True),
                  P.lerp_color(P.UI_GOLD, P.UI_WHITE, 0.25 * frac),
                  (right, 22), align="right")
        bar = pygame.Rect(right - 220, 48, 220, 9)
        draw_bar(surface, bar, frac, P.UI_GOLD)
        # A single trophy star, breathing, anchored to the end of the bar.
        star_c = P.UI_GOLD if frac < 1.0 else P.rainbow(t * 0.4)
        self._draw_star(surface, right - 240, 53, 9.0, True, star_c,
                        0.4 + 0.25 * pulse(t, 2.0))

    def _draw_diff_tile(self, surface: pygame.Surface, tile: _DiffTile,
                        theme: P.Theme, t: float) -> None:
        """One switcher tile, painted in its own mode colour."""
        button = tile.button
        diff = tile.diff
        selected = diff.key == self._diff_key
        r = button.rect
        try:
            button.draw(surface, theme, self.game.fonts, t)
        except Exception:
            pass

        col = diff.color
        if selected:
            _tint(surface, r, col, 70, C.UI_CORNER)
            try:
                pygame.draw.rect(surface, P.lerp_color(col, P.UI_WHITE, 0.35),
                                 r, 2, border_radius=C.UI_CORNER)
            except Exception:
                pass
            draw_glow_circle(surface, r.centerx, r.bottom + 2, 34, col,
                             0.30 + 0.18 * pulse(t, 2.2))

        hot = selected or button.hovered
        text_col = P.lerp_color(col, P.UI_WHITE, 0.55 if selected else
                                (0.3 if button.hovered else 0.0))
        if not hot:
            text_col = P.shade(text_col, 0.78)
        font = self.game.fonts.get(16, bold=True)
        draw_text(surface, diff.label, font, text_col,
                  (r.centerx, r.centery - font.get_height() * 0.5),
                  align="center")

        # A hairline under the selected tile ties the row to the grid below.
        if selected:
            try:
                pygame.draw.line(surface, col, (r.x + 10, r.bottom + 4),
                                 (r.right - 10, r.bottom + 4), 2)
            except Exception:
                pass

    # -- chapter bands ---------------------------------------------------
    def _draw_chapter_bands(self, surface: pygame.Surface, t: float) -> None:
        """
        Label each row with the chapter that owns it.

        Rows are chapters by construction (three columns, four rows, twelve
        levels), so the band for row *n* is the chapter of level ``n * COLS``.
        """
        fonts = self.game.fonts
        for row in range(ROWS):
            first = row * COLS
            if first >= len(self.cards):
                break
            card = self.cards[first]
            # Fade the band in with the first card of its row.
            appear = clamp(card.appear, 0.0, 1.0)
            if appear <= 0.01:
                continue
            try:
                chapter = S.get_chapter(first)
            except Exception:
                continue

            theme = card.level.theme
            y = card.button.rect.y
            band = pygame.Rect(BAND_X, y, BAND_W, CARD_H)
            done = all(self._record(i).cleared for i in range(first, first + COLS)
                       if i < LEVEL_COUNT)
            perfect = all(self._record(i).perfect for i in range(first, first + COLS)
                          if i < LEVEL_COUNT)

            accent = P.rainbow(t * 0.3 + row * 0.2) if perfect else theme.accent
            _tint(surface, band, theme.grid, int(120 * appear), C.UI_CORNER)
            try:
                pygame.draw.line(surface, P.shade(accent, 0.4 + 0.6 * appear),
                                 (band.right - 3, band.y + 6),
                                 (band.right - 3, band.bottom - 6), 3)
            except Exception:
                pass

            dim = P.shade(theme.text_dim, 0.6 + 0.4 * appear)
            draw_text(surface, "CHAPTER " + chapter.roman, fonts.tiny, accent,
                      (band.x + 14, band.y + 12))
            title_font = fonts.get(17, bold=True)
            for i, line in enumerate(_wrap(chapter.title, title_font,
                                           BAND_W - 28, 2)):
                draw_text(surface, line.upper(), title_font, theme.text,
                          (band.x + 14, band.y + 32 + i * 20))
            draw_text(surface, "LEVELS {:02d}-{:02d}".format(
                chapter.first_index + 1, chapter.last_index + 1),
                fonts.tiny, dim, (band.x + 14, band.bottom - 26))
            if perfect:
                draw_text(surface, "PERFECT", fonts.tiny,
                          P.rainbow(t * 0.3 + row * 0.2),
                          (band.right - 14, band.bottom - 26), align="right")
            elif done:
                draw_text(surface, "CLEAR", fonts.tiny, P.UI_GOOD,
                          (band.right - 14, band.bottom - 26), align="right")

    # -- one card -------------------------------------------------------
    def _draw_card(self, surface: pygame.Surface, card: _Card, t: float) -> None:
        level = card.level
        theme = level.theme
        fonts = self.game.fonts
        rec = self._record(card.index)

        # Draw the tile body with the *level's own* theme, so each card is a
        # swatch of the stage it launches.
        card.button.draw(surface, theme, fonts, t)

        # Mirror Button.draw's hover lift so the text rides with the art.
        hov = clamp(card.hover_t, 0.0, 1.0)
        press = clamp(card.press_t, 0.0, 1.0)
        r = card.button.rect
        cx, cy = r.centerx, r.centery + (-3.0 * hov + 2.0 * press)
        box = pygame.Rect(0, 0, r.w, r.h)
        box.center = (int(cx), int(cy))

        if not rec.unlocked:
            self._draw_locked(surface, box, card, t)
            return

        text_col = P.lerp_color(theme.text, P.UI_WHITE, 0.25 * hov)
        dim_col = P.lerp_color(theme.text_dim, theme.text, 0.35 * hov)

        if rec.perfect:
            self._draw_perfect_rim(surface, box, card.index, t)

        # ---- number ----------------------------------------------------
        num_col = P.lerp_color(theme.accent, P.UI_WHITE, 0.15 + 0.35 * hov)
        if hov > 0.02:
            draw_glow_circle(surface, box.x + 38, box.y + 32, 34, theme.accent,
                             0.25 * hov)
        draw_text(surface, f"{level.number:02d}", fonts.display_at(32), num_col,
                  (box.x + 14, box.y + 8))

        # ---- name + subtitle -------------------------------------------
        draw_text(surface, level.name.upper(), fonts.get(19, bold=True), text_col,
                  (box.x + 72, box.y + 10))
        draw_text(surface, level.subtitle, fonts.tiny, dim_col,
                  (box.x + 73, box.y + 34))

        # ---- state tag, top right ---------------------------------------
        self._draw_state_tag(surface, box, rec, theme, t)

        # ---- divider ----------------------------------------------------
        line_y = box.y + 58
        pygame.draw.line(surface, P.shade(theme.grid, 1.4 + 0.6 * hov),
                         (box.x + 14, line_y), (box.right - 14, line_y), 1)

        # ---- stars ------------------------------------------------------
        for i in range(3):
            got = i < rec.stars
            if got:
                col = P.rainbow(t * 0.35 + i * 0.12) if rec.perfect else P.UI_GOLD
            else:
                col = P.shade(theme.text_dim, 0.55)
            self._draw_star(surface, box.x + 28 + i * 26, box.y + 80, 10.0, got,
                            col, (0.35 + 0.3 * hov) if got else 0.0)

        # ---- goal + best score ------------------------------------------
        draw_text(surface, f"{level.goal_food} FOOD", fonts.tiny,
                  P.shade(dim_col, 0.95), (box.x + 118, box.y + 72))
        if rec.best > 0:
            draw_text(surface, "BEST", fonts.tiny, P.shade(dim_col, 0.8),
                      (box.right - 14, box.y + 62), align="right")
            draw_text(surface, f"{rec.best:,}", fonts.get(20, bold=True),
                      P.lerp_color(P.UI_WHITE, P.UI_GOLD, 0.35),
                      (box.right - 14, box.y + 76), align="right")
        else:
            draw_text(surface, "UNPLAYED", fonts.tiny, P.shade(dim_col, 0.7),
                      (box.right - 14, box.y + 72), align="right")

    def _draw_state_tag(self, surface: pygame.Surface, box: pygame.Rect,
                        rec: _Record, theme: P.Theme, t: float) -> None:
        """The little top-right badge that names the card's state."""
        fonts = self.game.fonts
        if rec.perfect:
            label, col = "PERFECT", P.rainbow(t * 0.4)
        elif rec.cleared:
            label, col = "CLEARED", P.UI_GOOD
        else:
            label, col = "NEW", theme.accent2
        try:
            font = fonts.tiny
            w = font.size(label)[0] + 14
        except Exception:
            font, w = fonts.tiny, 60
        tag = pygame.Rect(box.right - 14 - w, box.y + 10, w, 17)
        _tint(surface, tag, col, 55, 6)
        try:
            pygame.draw.rect(surface, P.with_alpha(col, 180), tag, 1,
                             border_radius=6)
        except Exception:
            pass
        draw_text(surface, label, font, P.lerp_color(col, P.UI_WHITE, 0.45),
                  (tag.centerx, tag.y + 2), align="center", shadow=False)

    def _draw_perfect_rim(self, surface: pygame.Surface, box: pygame.Rect,
                          index: int, t: float) -> None:
        """The celebratory treatment for a full three-star clear."""
        try:
            col = P.rainbow(t * 0.3 + index * 0.11)
            ring = box.inflate(6, 6)
            draw_glow_circle(surface, box.centerx, box.centery,
                             max(box.w, box.h) * 0.72, col,
                             0.10 + 0.06 * pulse(t, 1.6))
            pygame.draw.rect(surface, col, ring, 2,
                             border_radius=C.UI_CORNER + 8)
            # Two sparks orbiting the rim: cheap, and it makes the card sing.
            for k in range(2):
                ang = t * 1.1 + k * math.pi + index
                px = box.centerx + math.cos(ang) * (box.w * 0.5 + 4)
                py = box.centery + math.sin(ang) * (box.h * 0.5 + 4)
                draw_glow_circle(surface, px, py, 12,
                                 P.lerp_color(col, P.UI_WHITE, 0.5), 0.55)
        except Exception:
            pass

    def _draw_locked(self, surface: pygame.Surface, box: pygame.Rect,
                     card: _Card, t: float) -> None:
        """A dimmed card: number, padlock and the unlock condition."""
        theme = card.level.theme
        fonts = self.game.fonts
        veil_col = P.shade(theme.text_dim, 0.55)

        _tint(surface, box, P.UI_PANEL, 165, C.UI_CORNER + 6)

        draw_text(surface, f"{card.level.number:02d}", fonts.display_at(32),
                  P.shade(theme.accent, 0.45), (box.x + 14, box.y + 8))
        self._draw_padlock(surface, box.centerx + 14, box.centery - 6, 16.0,
                           veil_col)
        draw_text(surface, "LOCKED", fonts.get(17, bold=True), veil_col,
                  (box.centerx + 14, box.bottom - 42), align="center")
        draw_text(surface, f"CLEAR LEVEL {max(1, card.level.number - 1):02d}",
                  fonts.tiny, P.shade(veil_col, 0.85),
                  (box.centerx + 14, box.bottom - 22), align="center")

    def _draw_padlock(self, surface: pygame.Surface, cx: float, cy: float,
                      size: float, color: Sequence[int]) -> None:
        """A vector padlock - no font glyph to go missing on some system."""
        try:
            body = pygame.Rect(0, 0, int(size * 1.5), int(size * 1.15))
            body.center = (int(cx), int(cy + size * 0.42))
            pygame.draw.rect(surface, color, body, 2, border_radius=4)
            shackle = pygame.Rect(0, 0, int(size * 0.95), int(size * 1.0))
            shackle.center = (int(cx), int(cy - size * 0.28))
            pygame.draw.arc(surface, color, shackle, 0.0, math.pi, 2)
            pygame.draw.line(surface, color,
                             (shackle.left + 1, shackle.centery),
                             (shackle.left + 1, body.top), 2)
            pygame.draw.line(surface, color,
                             (shackle.right - 1, shackle.centery),
                             (shackle.right - 1, body.top), 2)
            pygame.draw.circle(surface, color, (int(cx), body.centery), 2)
        except Exception:
            pass

    def _draw_star(self, surface: pygame.Surface, cx: float, cy: float, r: float,
                   filled: bool, color: Sequence[int], glow: float = 0.0) -> None:
        """One star pip: solid when earned, a thin outline when not."""
        try:
            if glow > 0.01:
                draw_glow_circle(surface, cx, cy, r * 2.6, color, glow)
            pts = _star_points(cx, cy, r)
            if filled:
                pygame.draw.polygon(surface, color, pts)
                pygame.draw.polygon(surface, P.lerp_color(color, P.UI_WHITE, 0.5),
                                    pts, 1)
            else:
                pygame.draw.polygon(surface, color, pts, 1)
        except Exception:
            pass

    # -- detail panel ---------------------------------------------------
    def _draw_detail(self, surface: pygame.Surface, theme: P.Theme, t: float) -> None:
        """
        The bottom strip: the focused level, its star ladder on the *current*
        difficulty, and either its briefing or - while a switcher tile is
        hovered - that difficulty's blurb.
        """
        fonts = self.game.fonts
        level = get_level(self.focus)
        rec = self._record(self.focus)
        diff = self.diff
        draw_panel(surface, DETAIL_RECT, theme, alpha=224, glow=0.35)

        x = DETAIL_RECT.x + 22
        y = DETAIL_RECT.y + 12

        try:
            chapter_title = S.get_chapter(self.focus).title.upper()
        except Exception:
            chapter_title = ""
        draw_text(surface, "LEVEL {:02d}   {}".format(level.number, chapter_title),
                  fonts.tiny, theme.accent2, (x, y))
        draw_text(surface, level.name.upper(), fonts.get(26, bold=True),
                  theme.text, (x, y + 16))
        draw_text(surface, level.subtitle, fonts.small, theme.text_dim,
                  (x, y + 50))

        # Star thresholds, rescaled for the selected difficulty.
        try:
            one, two, three = D.apply_star_targets(diff, level.star_targets())
        except Exception:
            one = two = three = 0
        mid_x = DETAIL_RECT.x + 372
        draw_text(surface, "STAR TARGETS - " + diff.label, fonts.tiny,
                  P.lerp_color(P.shade(theme.text_dim, 0.9), diff.color, 0.55),
                  (mid_x, y + 2))
        for i, target in enumerate((one, two, three)):
            sx = mid_x + i * 84
            got = i < rec.stars
            col = (P.rainbow(t * 0.35 + i * 0.12) if rec.perfect else P.UI_GOLD) \
                if got else P.shade(theme.text_dim, 0.6)
            self._draw_star(surface, sx + 8, y + 30, 8.0, got, col,
                            0.35 if got else 0.0)
            draw_text(surface, f"{target:,}", fonts.tiny,
                      P.UI_GOLD if got else theme.text_dim, (sx + 22, y + 23))
        draw_text(surface,
                  ("BEST {:,}".format(rec.best)) if rec.best
                  else "NEVER CLEARED ON " + diff.label,
                  fonts.small, P.lerp_color(theme.text_dim, P.UI_WHITE, 0.4),
                  (mid_x, y + 50))

        # Right half: the briefing, the unlock condition, or a difficulty blurb.
        hint_x = DETAIL_RECT.x + 664
        hint_w = DETAIL_RECT.right - 22 - hint_x
        hovered = D.get_difficulty(self._diff_hover) if self._diff_hover else None
        if hovered is not None:
            head, body_text, col = hovered.label, hovered.blurb, hovered.color
        elif rec.unlocked:
            head, body_text, col = "BRIEFING", level.hint, theme.text
        else:
            head = "LOCKED"
            body_text = "Clear level {:02d} to open this stage.".format(
                max(1, level.number - 1))
            col = P.UI_WARN
        draw_text(surface, head, fonts.tiny, theme.accent2, (hint_x, y + 2))
        font_hint = fonts.get(18)
        for i, line in enumerate(_wrap(body_text, font_hint, hint_w, 2)):
            draw_text(surface, line, font_hint, col, (hint_x, y + 22 + i * 22))

        # Call to action, pinned bottom-right, pulsing gently.
        if rec.unlocked:
            glow = 0.55 + 0.45 * pulse(t, 3.0)
            draw_text(surface, "CLICK THE CARD TO PLAY", fonts.tiny,
                      P.lerp_color(theme.text_dim, theme.accent, glow),
                      (DETAIL_RECT.right - 22, DETAIL_RECT.bottom - 22),
                      align="right")
