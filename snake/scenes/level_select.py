"""
Level select for NEON SERPENT.

Twelve cards, four across and three down.  Every card is a `gfx.ui.Button` in
the "tile" style, drawn with *its own* level theme, so the grid reads as a
contact sheet of the whole campaign: you can see at a glance that level 4 burns
orange and level 7 is made of ice.

Three details carry most of the feel:

*   **The cards fly in.**  Each one has a staggered delay and slides up into
    place.  The animation drives `button.rect` itself rather than a separate
    draw offset, so the hit box always agrees with the pixels on screen.
*   **Hover is the navigation.**  Whatever card the pointer is over becomes the
    "focus": it drives the detail panel at the bottom, the header accents and
    the backdrop.  The focus is sticky - moving off a card leaves the last one
    described instead of blanking the panel.
*   **Locked cards are dead.**  `Button.set_enabled(False)` kills the hover
    lift, the glow and the click, and the card is overpainted with a padlock.

Mouse-only operation is guaranteed: every card and the BACK button are real
buttons.  The keyboard shortcuts (ESC / ENTER / arrows) are extra.
"""

from __future__ import annotations

import math
from typing import Any, Dict, List, Optional, Sequence, Tuple

import pygame

from .. import config as C
from .. import palette as P
from ..core.contracts import Scene, clamp, ease_out_cubic, pulse
from ..core.level import LEVEL_COUNT, LevelDef, get_level
from ..gfx.background import make_background
from ..gfx.render import draw_glow_circle
from ..gfx.ui import Button, draw_bar, draw_panel, draw_text

__all__ = ["LevelSelectScene"]

RGB = Tuple[int, int, int]

# --------------------------------------------------------------------------
# Layout.  All of it derives from the window size in config, so the grid stays
# centred if the window constants are ever retuned.
# --------------------------------------------------------------------------
COLS: int = 4
ROWS: int = 3
GRID_MARGIN_X: int = 48
CARD_GAP_X: int = 24
CARD_GAP_Y: int = 18
GRID_TOP: int = 124

CARD_W: int = (C.WINDOW_W - GRID_MARGIN_X * 2 - CARD_GAP_X * (COLS - 1)) // COLS
CARD_H: int = 138

DETAIL_RECT = pygame.Rect(GRID_MARGIN_X, 586,
                          C.WINDOW_W - GRID_MARGIN_X * 2, 98)
BACK_RECT = pygame.Rect(36, 22, 148, 46)

#: Seconds between one card starting its entrance and the next one starting.
INTRO_STAGGER: float = 0.045
#: Seconds one card takes to fly in.
INTRO_TIME: float = 0.42
#: How far below its resting place a card starts.
INTRO_RISE: float = 44.0

#: Short difficulty words, one per level index band.
_DIFFICULTY_WORDS: Tuple[str, ...] = (
    "CALM", "CALM", "STEADY", "STEADY", "BRISK", "BRISK",
    "SHARP", "SHARP", "FIERCE", "FIERCE", "LETHAL", "LETHAL",
)


def _difficulty_word(level: LevelDef) -> str:
    """A one-word difficulty label for a level card."""
    idx = int(getattr(level, "index", 0))
    if 0 <= idx < len(_DIFFICULTY_WORDS):
        return _DIFFICULTY_WORDS[idx]
    return "LETHAL"


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
        self.appear = 0.0
        self.hover_t = 0.0
        self.press_t = 0.0
        self.button.rect = self.home.copy()


class LevelSelectScene(Scene):
    """The campaign map: pick a level, see what it costs and what it pays."""

    transparent = False
    blocks_update = True

    def __init__(self, game: Any) -> None:
        super().__init__(game)
        self.cards: List[_Card] = []
        self.back: Optional[Button] = None
        self.focus: int = 0            # index whose detail panel is showing
        self.elapsed: float = 0.0
        self._bg: Any = None
        self._bg_style: str = ""
        self._launching: float = 0.0   # >0 while the launch flourish plays
        self._build()

    # ------------------------------------------------------------------
    # Construction
    # ------------------------------------------------------------------
    def _build(self) -> None:
        """Create the twelve tiles and the BACK button, once."""
        self.cards = []
        for i in range(min(LEVEL_COUNT, COLS * ROWS)):
            col, row = i % COLS, i // COLS
            x = GRID_MARGIN_X + col * (CARD_W + CARD_GAP_X)
            y = GRID_TOP + row * (CARD_H + CARD_GAP_Y)
            home = pygame.Rect(x, y, CARD_W, CARD_H)
            # The label is drawn by this scene, not by the Button: an empty
            # label keeps Button.draw from stamping text over the card art.
            button = Button(home, "", style="tile", data=i)
            # A diagonal wave reads better than a raw reading-order stagger.
            delay = (col + row) * INTRO_STAGGER
            self.cards.append(_Card(i, get_level(i), button, home, delay))
        self.back = Button(BACK_RECT, "BACK", style="ghost", data="back")

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------
    def on_enter(self, **kwargs: Any) -> None:
        """Full reset: scene instances are cached and reused by the Game."""
        self.elapsed = 0.0
        self._launching = 0.0
        for card in self.cards:
            card.reset()
            card.button.set_enabled(self._unlocked(card.index))
        if self.back is not None:
            self.back.rect = BACK_RECT.copy()
            self.back.set_enabled(True)

        # Focus whatever the player was last playing, if it is reachable.
        want = int(kwargs.get("level_index", getattr(self.game, "level_index", 0)) or 0)
        self.focus = want if self._unlocked(want) else self._highest_unlocked()
        self._ensure_background()

    def on_exit(self) -> None:
        # Backgrounds are large pre-rendered surfaces; drop ours on the way out
        # so a long session does not keep twelve of them alive.
        self._bg = None
        self._bg_style = ""

    # ------------------------------------------------------------------
    # Save-file queries (all defensive: a broken save must not crash the menu)
    # ------------------------------------------------------------------
    def _unlocked(self, index: int) -> bool:
        try:
            return bool(self.game.save.is_unlocked(int(index)))
        except Exception:
            return index == 0

    def _stars(self, index: int) -> int:
        try:
            return int(self.game.save.stars_for(int(index)))
        except Exception:
            return 0

    def _best(self, index: int) -> int:
        try:
            return int(self.game.save.best_for(int(index)))
        except Exception:
            return 0

    def _highest_unlocked(self) -> int:
        best = 0
        for card in self.cards:
            if self._unlocked(card.index):
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
        elif key in (pygame.K_LEFT, pygame.K_a):
            self._move_focus(-1)
        elif key in (pygame.K_RIGHT, pygame.K_d):
            self._move_focus(1)
        elif key in (pygame.K_UP, pygame.K_w):
            self._move_focus(-COLS)
        elif key in (pygame.K_DOWN, pygame.K_s):
            self._move_focus(COLS)

    def _move_focus(self, step: int) -> None:
        target = int(clamp(self.focus + step, 0, len(self.cards) - 1))
        if target != self.focus:
            self.focus = target
            self._ensure_background()
            self._play("hover", 0.5)

    def _play(self, name: str, volume: float = 1.0) -> None:
        try:
            self.game.audio.play(name, volume)
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
        if not card.button.enabled or not self._unlocked(card.index):
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
            mouse = getattr(self.game, "mouse_pos", (0.0, 0.0))
            held = False
            try:
                held = bool(self.game.mouse_buttons.get(1))
            except Exception:
                held = False

            # Same exponential constants Button uses internally, so the content
            # this scene paints tracks the body art the Button paints.
            k_hover = 1.0 - math.exp(-13.0 * dt)
            k_press = 1.0 - math.exp(-22.0 * dt)

            hovered_index = -1
            for card in self.cards:
                span = max(0.001, INTRO_TIME)
                card.appear = clamp((self.elapsed - card.delay) / span, 0.0, 1.0)
                rise = (1.0 - ease_out_cubic(card.appear)) * INTRO_RISE
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
        fonts = self.game.fonts
        draw_text(surface, "SELECT A LEVEL", fonts.display_at(40), theme.text,
                  (C.WINDOW_W * 0.5, 22), align="center")
        draw_text(surface, "twelve stages, three stars each", fonts.tiny,
                  theme.text_dim, (C.WINDOW_W * 0.5, 68), align="center")

        try:
            total = int(self.game.save.total_stars())
            cap = max(1, int(self.game.save.max_stars()))
        except Exception:
            total, cap = 0, max(1, LEVEL_COUNT * 3)
        frac = clamp(total / float(cap), 0.0, 1.0)

        right = C.WINDOW_W - 36
        draw_text(surface, f"{total} / {cap} STARS", fonts.get(20, bold=True),
                  P.lerp_color(P.UI_GOLD, P.UI_WHITE, 0.25 * frac),
                  (right, 24), align="right")
        bar = pygame.Rect(right - 260, 56, 260, 10)
        draw_bar(surface, bar, frac, P.UI_GOLD)
        # A single trophy star, breathing, anchored to the end of the bar.
        star_c = P.UI_GOLD if frac < 1.0 else P.rainbow(t * 0.4)
        self._draw_star(surface, right - 282, 61, 9.0, True, star_c,
                        0.4 + 0.25 * pulse(t, 2.0))

    # -- one card -------------------------------------------------------
    def _draw_card(self, surface: pygame.Surface, card: _Card, t: float) -> None:
        level = card.level
        theme = level.theme
        fonts = self.game.fonts
        unlocked = card.button.enabled

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

        if not unlocked:
            self._draw_locked(surface, box, card, t)
            return

        text_col = P.lerp_color(theme.text, P.UI_WHITE, 0.25 * hov)
        dim_col = P.lerp_color(theme.text_dim, theme.text, 0.35 * hov)

        # ---- number ----------------------------------------------------
        num_col = P.lerp_color(theme.accent, P.UI_WHITE, 0.15 + 0.35 * hov)
        if hov > 0.02:
            draw_glow_circle(surface, box.x + 38, box.y + 32, 34, theme.accent,
                             0.25 * hov)
        draw_text(surface, f"{level.number:02d}", fonts.display_at(36), num_col,
                  (box.x + 16, box.y + 10))

        # ---- name + subtitle -------------------------------------------
        draw_text(surface, level.name.upper(), fonts.get(19, bold=True), text_col,
                  (box.x + 74, box.y + 14))
        draw_text(surface, level.subtitle, fonts.tiny, dim_col,
                  (box.x + 75, box.y + 40))

        # ---- divider ----------------------------------------------------
        line_y = box.y + 62
        pygame.draw.line(surface, P.shade(theme.grid, 1.4 + 0.6 * hov),
                         (box.x + 16, line_y), (box.right - 16, line_y), 1)

        # ---- difficulty + goal ------------------------------------------
        draw_text(surface, _difficulty_word(level), fonts.tiny,
                  P.lerp_color(theme.accent2, P.UI_WHITE, 0.2 * hov),
                  (box.x + 16, box.y + 70))
        draw_text(surface, f"{level.goal_food} FOOD", fonts.tiny,
                  P.shade(dim_col, 0.95), (box.right - 16, box.y + 70),
                  align="right")

        # ---- stars ------------------------------------------------------
        earned = self._stars(card.index)
        for i in range(3):
            got = i < earned
            col = P.UI_GOLD if got else P.shade(theme.text_dim, 0.55)
            self._draw_star(surface, box.x + 26 + i * 26, box.y + 108, 10.0, got,
                            col, (0.35 + 0.3 * hov) if got else 0.0)

        # ---- best score --------------------------------------------------
        best = self._best(card.index)
        if best > 0:
            draw_text(surface, "BEST", fonts.tiny, P.shade(dim_col, 0.8),
                      (box.right - 16, box.y + 90), align="right")
            draw_text(surface, f"{best:,}", fonts.get(20, bold=True),
                      P.lerp_color(P.UI_WHITE, P.UI_GOLD, 0.35),
                      (box.right - 16, box.y + 104), align="right")
        else:
            draw_text(surface, "UNPLAYED", fonts.tiny, P.shade(dim_col, 0.7),
                      (box.right - 16, box.y + 100), align="right")

    def _draw_locked(self, surface: pygame.Surface, box: pygame.Rect,
                     card: _Card, t: float) -> None:
        """A dimmed card: number, padlock and the unlock condition."""
        theme = card.level.theme
        fonts = self.game.fonts
        veil_col = P.shade(theme.text_dim, 0.55)

        # A translucent veil has to be composed off-surface: pygame.draw does
        # not alpha-blend onto the opaque canvas.
        try:
            veil = pygame.Surface((box.w, box.h), pygame.SRCALPHA)
            pygame.draw.rect(veil, P.with_alpha(P.UI_PANEL, 165),
                             (0, 0, box.w, box.h), border_radius=C.UI_CORNER + 6)
            surface.blit(veil, box.topleft)
        except Exception:
            pass

        draw_text(surface, f"{card.level.number:02d}", fonts.display_at(36),
                  P.shade(theme.accent, 0.45), (box.x + 16, box.y + 10))
        self._draw_padlock(surface, box.centerx + 14, box.centery - 2, 17.0,
                           veil_col)
        draw_text(surface, "LOCKED", fonts.get(17, bold=True), veil_col,
                  (box.centerx + 14, box.bottom - 44), align="center")
        draw_text(surface, f"CLEAR LEVEL {max(1, card.level.number - 1):02d}",
                  fonts.tiny, P.shade(veil_col, 0.85),
                  (box.centerx + 14, box.bottom - 24), align="center")

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
        fonts = self.game.fonts
        level = get_level(self.focus)
        unlocked = self._unlocked(self.focus)
        draw_panel(surface, DETAIL_RECT, theme, alpha=224, glow=0.35)

        x = DETAIL_RECT.x + 22
        y = DETAIL_RECT.y + 12

        draw_text(surface, f"LEVEL {level.number:02d}", fonts.tiny, theme.accent2,
                  (x, y))
        draw_text(surface, level.name.upper(), fonts.get(26, bold=True),
                  theme.text, (x, y + 16))
        draw_text(surface, level.subtitle, fonts.small, theme.text_dim,
                  (x, y + 50))

        # Star thresholds: the actual scores the pips on the card cost.
        try:
            one, two, three = level.star_targets()
        except Exception:
            one = two = three = 0
        mid_x = DETAIL_RECT.x + 372
        draw_text(surface, "STAR TARGETS", fonts.tiny, P.shade(theme.text_dim, 0.9),
                  (mid_x, y + 2))
        for i, target in enumerate((one, two, three)):
            sx = mid_x + i * 84
            got = self._best(self.focus) >= target and target > 0
            self._draw_star(surface, sx + 8, y + 30, 8.0, got,
                            P.UI_GOLD if got else P.shade(theme.text_dim, 0.6),
                            0.35 if got else 0.0)
            draw_text(surface, f"{target:,}", fonts.tiny,
                      P.UI_GOLD if got else theme.text_dim, (sx + 22, y + 23))
        best = self._best(self.focus)
        draw_text(surface, ("BEST {:,}".format(best)) if best else "NEVER CLEARED",
                  fonts.small, P.lerp_color(theme.text_dim, P.UI_WHITE, 0.4),
                  (mid_x, y + 50))

        # Hint (or the unlock condition) fills the right half.
        hint_x = DETAIL_RECT.x + 664
        hint_w = DETAIL_RECT.right - 22 - hint_x
        if unlocked:
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
        if unlocked:
            glow = 0.55 + 0.45 * pulse(t, 3.0)
            draw_text(surface, "CLICK THE CARD TO PLAY", fonts.tiny,
                      P.lerp_color(theme.text_dim, theme.accent, glow),
                      (DETAIL_RECT.right - 22, DETAIL_RECT.bottom - 22),
                      align="right")
