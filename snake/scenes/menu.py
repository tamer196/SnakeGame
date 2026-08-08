"""
The title screen for NEON SERPENT.

This is the first thing anybody sees, so nothing on it is allowed to sit still:

*   the twelve level themes cycle on a slow timer, cross-fading a real
    `gfx.background` for each one, so the backdrop keeps re-inventing itself;
*   an idle **demo snake** steers itself around the screen on a wandering
    target, leaving a particle trail - the game shows you what it is before it
    tells you;
*   the wordmark carries an additive bloom plus a chromatic split that breathes;
*   the buttons fly in with a staggered ``ease_out_back`` entrance every time
    the scene is entered (scene instances are cached and reused, so `on_enter`
    rebuilds everything from scratch).

Every action is reachable with the mouse alone; the keyboard shortcuts are a
convenience layer on top and never the only route.
"""

from __future__ import annotations

import math
import random
from typing import TYPE_CHECKING, Any, Dict, List, Optional, Tuple

import pygame

from .. import config as C
from .. import palette as P
from ..core.contracts import Scene, clamp, dist, ease_out_back, pulse
from ..core.level import LEVEL_COUNT, get_level
from ..core.snake import Snake
from ..gfx.background import Background, make_background
from ..gfx.render import draw_glow_circle, draw_snake
from ..gfx.ui import Button, draw_bar, draw_panel, draw_text

if TYPE_CHECKING:  # pragma: no cover - typing only
    from ..main import Game

__all__ = ["MenuScene"]

RGB = Tuple[int, int, int]

# --------------------------------------------------------------------------
# Tuning
# --------------------------------------------------------------------------
#: Seconds one theme holds the screen before the next one takes over.
THEME_PERIOD = 11.0
#: Seconds of cross-fade at the end of each period.
THEME_FADE = 2.4
#: The cross-fade weight is snapped onto this many steps.  The blended theme
#: feeds the UI surface caches (buttons, panels, text are cached per colour), so
#: a continuously varying colour would mint a fresh surface every single frame.
#: Eight steps is invisible on screen and lets the caches settle.
THEME_BLEND_STEPS = 8

#: Button stack geometry.
BUTTON_TOP = 336
BUTTON_PITCH = C.UI_BUTTON_H + 13
#: Entrance animation: each button starts `BUTTON_STAGGER` after the one above.
BUTTON_ENTRANCE = 0.52
BUTTON_STAGGER = 0.075
BUTTON_SLIDE = 190.0            # pixels travelled during the entrance

TITLE_TEXT = C.GAME_TITLE
TITLE_MAX_W = C.WINDOW_W - 200

#: The demo snake stays this far inside the window before it is steered home.
DEMO_MARGIN = 96.0
DEMO_SPEED = 196.0
DEMO_LENGTH = 30


# --------------------------------------------------------------------------
# Theme blending
# --------------------------------------------------------------------------
def _blend_themes(a: P.Theme, b: P.Theme, t: float) -> P.Theme:
    """
    A synthetic theme part-way between two real ones.

    `bg_style` and `name` are taken from whichever side is dominant - they are
    not interpolatable - while every colour is a straight lerp.
    """
    if t <= 0.001:
        return a
    if t >= 0.999:
        return b
    lead = b if t >= 0.5 else a
    mix = P.lerp_color
    return P.Theme(
        name=lead.name,
        bg_style=lead.bg_style,
        bg_top=mix(a.bg_top, b.bg_top, t),
        bg_bottom=mix(a.bg_bottom, b.bg_bottom, t),
        grid=mix(a.grid, b.grid, t),
        accent=mix(a.accent, b.accent, t),
        accent2=mix(a.accent2, b.accent2, t),
        snake_head=mix(a.snake_head, b.snake_head, t),
        snake_a=mix(a.snake_a, b.snake_a, t),
        snake_b=mix(a.snake_b, b.snake_b, t),
        food=mix(a.food, b.food, t),
        hazard=mix(a.hazard, b.hazard, t),
        text=mix(a.text, b.text, t),
        text_dim=mix(a.text_dim, b.text_dim, t),
    )


def _quantise(value: float, steps: int) -> float:
    """Snap a 0..1 weight onto `steps` levels (cache friendliness, see above)."""
    return round(clamp(value, 0.0, 1.0) * steps) / float(steps)


# --------------------------------------------------------------------------
# Title art
# --------------------------------------------------------------------------
def _additive_copy(src: pygame.Surface, color: RGB) -> pygame.Surface:
    """
    A tinted, ``BLEND_RGB_ADD``-ready copy of a text render.

    ``font.render`` returns a per-pixel-alpha surface whose RGB is the text
    colour *everywhere*, including fully transparent pixels - blitting that
    additively would add a solid rectangle.  Compositing it onto opaque black
    premultiplies the coverage into RGB, which is exactly what additive
    blending wants, and leaves the surround at (0, 0, 0) so it adds nothing.
    """
    tinted = src.copy()
    tinted.fill((int(color[0]), int(color[1]), int(color[2]), 255),
                special_flags=pygame.BLEND_RGBA_MULT)
    out = pygame.Surface(src.get_size())
    out.fill((0, 0, 0))
    out.blit(tinted, (0, 0))
    return out


class _TitleArt:
    """Cached wordmark surfaces for one (quantised) theme colouring."""

    __slots__ = ("body", "left", "right", "width", "height")

    def __init__(self, font: pygame.font.Font, text: str, theme: P.Theme) -> None:
        base = font.render(text, True, (255, 255, 255))
        # Shrink to fit if the chosen display face renders wide.
        if base.get_width() > TITLE_MAX_W:
            scale = TITLE_MAX_W / float(base.get_width())
            base = pygame.transform.smoothscale(
                base, (int(base.get_width() * scale), int(base.get_height() * scale)))

        body_col = P.lerp_color(theme.text, P.UI_WHITE, 0.55)
        self.body: pygame.Surface = base.copy()
        self.body.fill((body_col[0], body_col[1], body_col[2], 255),
                       special_flags=pygame.BLEND_RGBA_MULT)
        # The two chromatic fringes: accent to one side, accent2 to the other.
        self.left: pygame.Surface = _additive_copy(base, P.shade(theme.accent, 0.85))
        self.right: pygame.Surface = _additive_copy(base, P.shade(theme.accent2, 0.85))
        self.width: int = base.get_width()
        self.height: int = base.get_height()


# ==========================================================================
# MenuScene
# ==========================================================================
class MenuScene(Scene):
    """The living title screen."""

    transparent = False
    blocks_update = True

    def __init__(self, game: "Game") -> None:
        super().__init__(game)

        self._t: float = 0.0                     # scene-local clock
        self._entered: float = 0.0               # seconds since on_enter

        self._theme: P.Theme = P.THEMES[0]
        self._theme_index: int = 0
        self._theme_blend: float = 0.0

        self._backgrounds: Dict[int, Background] = {}
        self._fade_layer: Optional[pygame.Surface] = None

        self._title_art: Optional[_TitleArt] = None
        self._title_key: Any = None

        self._buttons: List[Button] = []
        self._base_rects: List[pygame.Rect] = []

        self._demo: Optional[Snake] = None
        self._demo_target: Tuple[float, float] = (C.WINDOW_W * 0.5, C.WINDOW_H * 0.5)
        self._demo_timer: float = 0.0

        self._rng = random.Random(0xC0FFEE)

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------
    def on_enter(self, **kwargs: Any) -> None:
        """Full reset - scene instances are cached and reused by the Game."""
        try:
            self._t = 0.0
            self._entered = 0.0
            self._theme_index = 0
            self._theme_blend = 0.0
            self._theme = P.THEMES[0]
            self._backgrounds.clear()
            self._title_art = None
            self._title_key = None

            self._spawn_demo()
            self._build_buttons()
        except Exception:
            pass

    def on_exit(self) -> None:
        # Backgrounds hold pre-rendered full-screen surfaces; drop them so the
        # menu does not keep a dozen of them alive while the game is running.
        try:
            self._backgrounds.clear()
            self._fade_layer = None
        except Exception:
            pass

    # ------------------------------------------------------------------
    # Construction helpers
    # ------------------------------------------------------------------
    def _continue_index(self) -> int:
        """The furthest level the player has unlocked, clamped into range."""
        try:
            idx = int(self.game.save.unlocked) - 1
        except Exception:
            idx = 0
        return int(clamp(idx, 0, LEVEL_COUNT - 1))

    def _sound_label(self) -> str:
        try:
            muted = bool(self.game.audio.muted)
        except Exception:
            muted = False
        return "SOUND: OFF" if muted else "SOUND: ON"

    def _build_buttons(self) -> None:
        """Rebuild the centred stack. Called fresh on every entry."""
        fonts = getattr(self.game, "fonts", None)
        specs: List[Tuple[str, str, str]] = [
            ("play", "PLAY", "primary"),
            ("levels", "LEVELS", "primary"),
            ("help", "HOW TO PLAY", "ghost"),
            ("sound", self._sound_label(), "ghost"),
            ("quit", "QUIT", "danger"),
        ]
        self._buttons = []
        self._base_rects = []
        cx = C.WINDOW_W // 2
        for i, (key, label, style) in enumerate(specs):
            rect = pygame.Rect(0, 0, C.UI_BUTTON_W, C.UI_BUTTON_H)
            rect.center = (cx, BUTTON_TOP + i * BUTTON_PITCH)
            font = None
            if style == "ghost" and fonts is not None:
                font = getattr(fonts, "body", None)
            self._buttons.append(Button(rect, label, style=style, font=font, data=key))
            self._base_rects.append(rect.copy())

    def _spawn_demo(self) -> None:
        """Put the idle snake back in the middle, pointing somewhere sensible."""
        heading = self._rng.uniform(0.0, math.tau)
        self._demo = Snake(C.WINDOW_W * 0.5, C.WINDOW_H * 0.62,
                           heading=heading, length=DEMO_LENGTH)
        self._demo.speed = DEMO_SPEED
        self._demo_target = self._pick_target()
        self._demo_timer = 0.0

    def _pick_target(self) -> Tuple[float, float]:
        """A random wander point, biased away from the button column."""
        for _ in range(6):
            x = self._rng.uniform(DEMO_MARGIN, C.WINDOW_W - DEMO_MARGIN)
            y = self._rng.uniform(DEMO_MARGIN + 60.0, C.WINDOW_H - DEMO_MARGIN)
            # Keep the snake out of the middle column where the buttons live,
            # so it weaves around the UI instead of hiding behind it.
            if abs(x - C.WINDOW_W * 0.5) > 240.0 or y < 300.0:
                return (x, y)
        return (C.WINDOW_W * 0.5, C.WINDOW_H * 0.5)

    # ------------------------------------------------------------------
    # Events
    # ------------------------------------------------------------------
    def handle_event(self, event: "pygame.event.Event") -> None:
        try:
            for button in self._buttons:
                if button.handle_event(event):
                    self._activate(str(button.data))

            if getattr(event, "type", None) == pygame.KEYDOWN:
                key = getattr(event, "key", None)
                if key in (pygame.K_RETURN, pygame.K_KP_ENTER, pygame.K_SPACE):
                    self._activate("play")
                elif key == pygame.K_l:
                    self._activate("levels")
                elif key in (pygame.K_h, pygame.K_F1):
                    self._activate("help")
                elif key == pygame.K_m:
                    self._activate("sound")
                elif key == pygame.K_ESCAPE:
                    self._activate("quit")
        except Exception:
            pass

    def _activate(self, action: str) -> None:
        """Run one menu action. Shared by mouse clicks and keyboard shortcuts."""
        game = self.game
        try:
            game.audio.play("click")
        except Exception:
            pass

        if action == "play":
            index = self._continue_index()
            try:
                game.level_index = index
                game.audio.play("start")
            except Exception:
                pass
            game.switch_scene(C.SCENE_GAME, level_index=index)
        elif action == "levels":
            game.switch_scene(C.SCENE_LEVELS)
        elif action == "help":
            game.switch_scene(C.SCENE_HELP)
        elif action == "sound":
            self._toggle_sound()
        elif action == "quit":
            game.quit()

    def _toggle_sound(self) -> None:
        """Flip the mute flag, persist it, and relabel the button."""
        muted = False
        try:
            muted = bool(self.game.audio.toggle_mute())
        except Exception:
            return
        try:
            self.game.save.set_muted(muted)
            self.game.save.flush()
        except Exception:
            pass
        for button in self._buttons:
            if button.data == "sound":
                button.label = self._sound_label()
        if not muted:
            try:
                self.game.audio.play("hover")
            except Exception:
                pass

    # ------------------------------------------------------------------
    # Update
    # ------------------------------------------------------------------
    def update(self, dt: float) -> None:
        try:
            dt = clamp(float(dt), 0.0, C.MAX_DT)
            self._t += dt
            self._entered += dt

            self._update_theme(dt)
            self._update_demo(dt)
            self._update_buttons(dt)

            # Ambient motes, drifting up the whole window.
            self.game.particles.ambient(
                (0, 0, C.WINDOW_W, C.WINDOW_H),
                P.lerp_color(self._theme.accent, self._theme.accent2, 0.5),
                dt, rate=9.0)
        except Exception:
            pass

    def _update_theme(self, dt: float) -> None:
        """Advance the slow theme carousel and keep the backgrounds alive."""
        n = len(P.THEMES)
        cycles = self._t / THEME_PERIOD
        index = int(cycles) % n
        frac = cycles - math.floor(cycles)

        fade_start = 1.0 - (THEME_FADE / THEME_PERIOD)
        raw = 0.0 if frac < fade_start else (frac - fade_start) / max(1e-6, 1.0 - fade_start)

        self._theme_index = index
        self._theme_blend = _quantise(raw, THEME_BLEND_STEPS)
        self._theme = _blend_themes(P.THEMES[index], P.THEMES[(index + 1) % n],
                                    self._theme_blend)

        current = self._background(index)
        if current is not None:
            current.update(dt)
        if raw > 0.0:
            nxt = self._background((index + 1) % n)
            if nxt is not None:
                nxt.update(dt)

        # Only the current pair (and the one just retired) is worth keeping.
        if len(self._backgrounds) > 3:
            keep = {index, (index + 1) % n, (index - 1) % n}
            for key in [k for k in self._backgrounds if k not in keep]:
                self._backgrounds.pop(key, None)

    def _background(self, index: int) -> Optional[Background]:
        """Lazily build (and cache) the full-window background for a theme."""
        bg = self._backgrounds.get(index)
        if bg is None:
            try:
                theme = P.THEMES[index % len(P.THEMES)]
                bg = make_background(theme.bg_style, theme,
                                     (0, 0, C.WINDOW_W, C.WINDOW_H))
            except Exception:
                return None
            self._backgrounds[index] = bg
        return bg

    def _update_demo(self, dt: float) -> None:
        """Steer the idle snake and drip a trail behind its head."""
        snake = self._demo
        if snake is None:
            return

        self._demo_timer -= dt
        hx, hy = snake.head_pos()

        # Edge guard: outside the safe inset the target is overridden with the
        # screen centre, which is always reachable at this turn rate.
        outside = not (DEMO_MARGIN <= hx <= C.WINDOW_W - DEMO_MARGIN
                       and DEMO_MARGIN <= hy <= C.WINDOW_H - DEMO_MARGIN)
        if outside:
            self._demo_target = (C.WINDOW_W * 0.5, C.WINDOW_H * 0.5)
            self._demo_timer = max(self._demo_timer, 1.2)
        elif self._demo_timer <= 0.0 or dist(hx, hy, *self._demo_target) < 70.0:
            self._demo_target = self._pick_target()
            self._demo_timer = self._rng.uniform(2.2, 4.0)

        snake.set_target(*self._demo_target)
        snake.update(dt)

        # A hard bail-out in case anything ever pushes it off screen entirely.
        hx, hy = snake.head_pos()
        if not (-200.0 <= hx <= C.WINDOW_W + 200.0 and -200.0 <= hy <= C.WINDOW_H + 200.0):
            self._spawn_demo()
            return

        self.game.particles.trail(hx, hy, self._theme.snake_a, dt, rate=22.0,
                                  speed=(6.0, 30.0), life=(0.3, 0.75),
                                  radius=(1.6, 3.6))

    def _update_buttons(self, dt: float) -> None:
        """Run the staggered entrance and feed the buttons the mouse."""
        mouse = getattr(self.game, "mouse_pos", (0.0, 0.0))
        for i, button in enumerate(self._buttons):
            base = self._base_rects[i]
            local = self._entered - i * BUTTON_STAGGER
            if local < BUTTON_ENTRANCE:
                k = ease_out_back(clamp(local / BUTTON_ENTRANCE, 0.0, 1.0))
                # Alternate the side each button flies in from.
                side = -1.0 if (i % 2 == 0) else 1.0
                button.rect.centerx = int(base.centerx + side * BUTTON_SLIDE * (1.0 - k))
            else:
                button.rect.centerx = base.centerx
            button.rect.centery = base.centery

            was = button.hovered
            button.update(dt, mouse)
            if button.hovered and not was:
                try:
                    self.game.audio.play("hover")
                except Exception:
                    pass

    def _button_alpha(self, index: int) -> float:
        """0..1 fade weight for one button's entrance."""
        local = self._entered - index * BUTTON_STAGGER
        return clamp(local / (BUTTON_ENTRANCE * 0.6), 0.0, 1.0)

    # ------------------------------------------------------------------
    # Draw
    # ------------------------------------------------------------------
    def draw(self, surface: pygame.Surface) -> None:
        prev_clip = None
        try:
            prev_clip = surface.get_clip()
            self._draw_background(surface)
            self.game.particles.draw(surface)
            if self._demo is not None:
                draw_snake(surface, self._demo, self._theme, self._t)
            self._draw_title(surface)
            self._draw_buttons(surface)
            self._draw_stats_panel(surface)
            self._draw_footer(surface)
        except Exception:
            pass
        finally:
            try:
                surface.set_clip(prev_clip)
            except Exception:
                pass

    def _draw_background(self, surface: pygame.Surface) -> None:
        current = self._background(self._theme_index)
        if current is None:
            surface.fill(self._theme.bg_bottom)
            return
        current.draw(surface)

        if self._theme_blend <= 0.001:
            return
        nxt = self._background((self._theme_index + 1) % len(P.THEMES))
        if nxt is None:
            return
        # Cross-fade: the incoming background is painted onto an opaque scratch
        # layer, which is then blitted at a partial alpha.  A per-pixel-alpha
        # layer would not work - the backgrounds paint opaque gradients.
        layer = self._fade_layer
        if layer is None or layer.get_size() != surface.get_size():
            layer = pygame.Surface(surface.get_size())
            self._fade_layer = layer
        nxt.draw(layer)
        layer.set_alpha(int(255 * clamp(self._theme_blend, 0.0, 1.0)))
        surface.blit(layer, (0, 0))
        layer.set_alpha(255)

    def _title_surfaces(self) -> Optional[_TitleArt]:
        """Rebuild the wordmark only when the (quantised) theme moves on."""
        key = (self._theme_index, self._theme_blend)
        if self._title_art is not None and key == self._title_key:
            return self._title_art
        try:
            font = self.game.fonts.huge
        except Exception:
            return None
        try:
            self._title_art = _TitleArt(font, TITLE_TEXT, self._theme)
            self._title_key = key
        except Exception:
            return None
        return self._title_art

    def _draw_title(self, surface: pygame.Surface) -> None:
        art = self._title_surfaces()
        if art is None:
            return
        theme = self._theme
        t = self._t
        cx = C.WINDOW_W * 0.5
        top = 116.0

        # Entrance: the wordmark drops in and settles before the buttons start.
        k = ease_out_back(clamp(self._entered / 0.62, 0.0, 1.0))
        top -= (1.0 - k) * 60.0

        breathe = pulse(t, 0.9)
        # Under-glow: a row of additive stamps along the baseline reads as a
        # single soft bar of light behind the letters, for a handful of blits.
        glow_y = top + art.height * 0.52
        stamps = 9
        for i in range(stamps):
            gx = cx + (i / (stamps - 1.0) - 0.5) * art.width * 0.92
            col = P.lerp_color(theme.accent, theme.accent2, i / (stamps - 1.0))
            draw_glow_circle(surface, gx, glow_y, 86.0, col, 0.30 + 0.16 * breathe)

        # Chromatic split, breathing between roughly 1.5 and 5 px.
        split = 1.5 + 3.5 * pulse(t * 0.85, 1.0)
        wob = math.sin(t * 1.7) * 1.4
        x = int(cx - art.width * 0.5)
        y = int(top)
        surface.blit(art.left, (int(x - split), int(y + wob)),
                     special_flags=pygame.BLEND_RGB_ADD)
        surface.blit(art.right, (int(x + split), int(y - wob)),
                     special_flags=pygame.BLEND_RGB_ADD)
        surface.blit(art.body, (x, y))

        # Subtitle, with the live theme name so the carousel is legible.
        fonts = getattr(self.game, "fonts", None)
        sub_font = getattr(fonts, "body", None) if fonts else None
        sub = "{}   -   {}".format(C.GAME_SUBTITLE.upper(), theme.name.upper())
        draw_text(surface, sub, sub_font,
                  P.lerp_color(theme.text_dim, theme.accent, 0.35 + 0.25 * breathe),
                  (cx, y + art.height + 6), align="center")

    def _draw_buttons(self, surface: pygame.Surface) -> None:
        fonts = getattr(self.game, "fonts", None)
        for i, button in enumerate(self._buttons):
            if self._button_alpha(i) <= 0.0:
                continue
            button.draw(surface, self._theme, fonts, self._t)

        # A caption under PLAY telling the player what "continue" means.
        if self._buttons and self._entered > 0.5:
            level = get_level(self._continue_index())
            rect = self._base_rects[0]
            fonts_small = getattr(fonts, "small", None) if fonts else None
            draw_text(surface,
                      "CONTINUE  -  LEVEL {:02d}  {}".format(level.number,
                                                             level.name.upper()),
                      fonts_small, P.shade(self._theme.text_dim, 1.0),
                      (rect.centerx, rect.top - 30), align="center")

    def _draw_stats_panel(self, surface: pygame.Surface) -> None:
        """Best score, campaign progress and stars, bottom-left."""
        save = getattr(self.game, "save", None)
        if save is None:
            return
        theme = self._theme
        fonts = getattr(self.game, "fonts", None)
        f_tiny = getattr(fonts, "tiny", None) if fonts else None
        f_small = getattr(fonts, "small", None) if fonts else None
        f_h2 = getattr(fonts, "h2", None) if fonts else None

        # Slide the panel in from the left, just behind the buttons.
        k = ease_out_back(clamp((self._entered - 0.18) / 0.6, 0.0, 1.0))
        panel = pygame.Rect(int(34 - (1.0 - k) * 260.0), C.WINDOW_H - 178, 286, 144)
        draw_panel(surface, panel, theme, alpha=206, glow=0.25 + 0.12 * pulse(self._t, 1.3))

        try:
            best = int(save.highscore)
            stars = int(save.total_stars())
            max_stars = max(1, int(save.max_stars()))
            cleared, total = save.progress()
        except Exception:
            best, stars, max_stars, cleared, total = 0, 0, 1, 0, LEVEL_COUNT

        draw_text(surface, "BEST SCORE", f_tiny, theme.text_dim,
                  (panel.x + 18, panel.y + 14))
        draw_text(surface, "{:,}".format(best), f_h2,
                  P.lerp_color(P.UI_GOLD, P.UI_WHITE, 0.25),
                  (panel.x + 18, panel.y + 32))

        draw_text(surface, "STARS", f_tiny, theme.text_dim, (panel.x + 18, panel.y + 74))
        draw_text(surface, "{} / {}".format(stars, max_stars), f_small, P.UI_GOLD,
                  (panel.right - 18, panel.y + 72), align="right")
        draw_bar(surface, pygame.Rect(panel.x + 18, panel.y + 96, panel.w - 36, 9),
                 stars / float(max_stars), P.UI_GOLD)

        draw_text(surface, "LEVELS CLEARED  {} / {}".format(cleared, total), f_tiny,
                  P.shade(theme.text_dim, 0.95), (panel.x + 18, panel.y + 114))

    def _draw_footer(self, surface: pygame.Surface) -> None:
        fonts = getattr(self.game, "fonts", None)
        f_tiny = getattr(fonts, "tiny", None) if fonts else None
        theme = self._theme
        draw_text(surface, "v{}".format(C.VERSION), f_tiny,
                  P.shade(theme.text_dim, 0.7), (C.WINDOW_W - 20, C.WINDOW_H - 26),
                  align="right")
        draw_text(surface,
                  "MOUSE STEERS  -  RIGHT-CLICK BOOSTS  -  ENTER PLAYS",
                  f_tiny, P.shade(theme.text_dim, 0.8),
                  (C.WINDOW_W * 0.5, C.WINDOW_H - 26), align="center")
