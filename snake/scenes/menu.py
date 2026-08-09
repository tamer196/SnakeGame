"""
The title screen for NEON SERPENT.

This is the first thing anybody sees, so nothing on it is allowed to sit still:

*   the twelve level themes cycle on a slow timer, cross-fading a real
    `gfx.background` for each one, so the backdrop keeps re-inventing itself;
*   an idle **demo snake** steers itself around the screen, and now deliberately
    doubles back on its own body every few seconds so the v2 constant-radius
    hairpin is the first thing the player sees the game do;
*   the wordmark carries an additive bloom plus a chromatic split that breathes;
*   the buttons fly in with a staggered ``ease_out_back`` entrance every time
    the scene is entered (scene instances are cached and reused, so `on_enter`
    rebuilds everything from scratch).

The menu is the top of the v2 flow and only routes - it never starts a run
itself::

    PLAY / CONTINUE  ->  C.SCENE_MODE      (story vs free, plus difficulty)
    LEVELS           ->  C.SCENE_LEVELS    (after forcing game.mode = free)
    HOW TO PLAY      ->  C.SCENE_HELP
    SETTINGS         ->  C.SCENE_SETTINGS  (back=C.SCENE_MENU)
    QUIT             ->  game.quit()

The old SOUND toggle now lives in settings.  A small coloured badge beside the
PLAY button always names the difficulty the next run will use, and the stats
panel reports how far into the four-chapter story the player has reached.

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
from ..core.difficulty import Difficulty, get_difficulty
from ..core.level import LEVEL_COUNT
from ..core.snake import Snake
from ..core import story as S
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
#: Chance that finishing a wander leg queues one or two hairpins.
DEMO_HAIRPIN_CHANCE = 0.55
#: How far behind the head a hairpin target is planted.
DEMO_HAIRPIN_REACH = (150.0, 240.0)

#: Seconds between the ambient shockwave rings that drift across the backdrop.
RING_PERIOD = 2.9


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


# --------------------------------------------------------------------------
# Difficulty badge
# --------------------------------------------------------------------------
#: Cached pill surfaces, keyed by (label, colour, size).  The badge is redrawn
#: every frame but only ever built once per difficulty.
_BADGE_CACHE: Dict[Any, pygame.Surface] = {}


def _badge_surface(label: str, color: RGB, font: Optional[pygame.font.Font]) -> pygame.Surface:
    """
    A small dark pill carrying `label` in `color`.

    Built on an ``SRCALPHA`` scratch surface because ``pygame.draw`` writes
    straight through alpha onto an opaque destination.
    """
    key = (label, tuple(int(c) & 0xFF for c in color), id(font))
    cached = _BADGE_CACHE.get(key)
    if cached is not None:
        return cached

    text_w, text_h = 60, 14
    if isinstance(font, pygame.font.Font):
        try:
            text_w, text_h = font.size(label)
        except Exception:
            pass
    w = int(text_w) + 30
    h = max(24, int(text_h) + 12)
    surf = pygame.Surface((w, h), pygame.SRCALPHA)
    pygame.draw.rect(surf, P.with_alpha(P.UI_PANEL, 232), (0, 0, w, h), border_radius=h // 2)
    pygame.draw.rect(surf, P.with_alpha(color, 200), (0, 0, w, h), 2, border_radius=h // 2)
    draw_text(surf, label, font, P.lerp_color(color, P.UI_WHITE, 0.35),
              (w * 0.5, (h - text_h) * 0.5), align="center", shadow=False)

    if len(_BADGE_CACHE) > 32:
        _BADGE_CACHE.clear()
    _BADGE_CACHE[key] = surf
    return surf


# ==========================================================================
# MenuScene
# ==========================================================================
class MenuScene(Scene):
    """The living title screen, and the root of the v2 scene flow."""

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
        self._demo_hairpins: int = 0

        self._ring_timer: float = RING_PERIOD

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
            self._ring_timer = RING_PERIOD

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
    # Save-file queries (all guarded: a broken save must not break the menu)
    # ------------------------------------------------------------------
    def _story_index(self) -> int:
        """The story level the campaign would resume on, clamped into range."""
        try:
            idx = int(self.game.save.story_progress)
        except Exception:
            idx = 0
        return int(clamp(idx, 0, LEVEL_COUNT - 1))

    def _story_in_progress(self) -> bool:
        """True when a story run is part-way through and PLAY means CONTINUE."""
        save = getattr(self.game, "save", None)
        if save is None:
            return False
        try:
            if bool(save.story_complete):
                return False
            return int(save.story_progress) > 0
        except Exception:
            return False

    def _difficulty(self) -> Difficulty:
        """The mode the next run will start on (never raises, never None)."""
        return get_difficulty(getattr(self.game, "difficulty", None))

    def _play_label(self) -> str:
        return "CONTINUE" if self._story_in_progress() else "PLAY"

    # ------------------------------------------------------------------
    # Construction helpers
    # ------------------------------------------------------------------
    def _build_buttons(self) -> None:
        """Rebuild the centred stack. Called fresh on every entry."""
        fonts = getattr(self.game, "fonts", None)
        specs: List[Tuple[str, str, str]] = [
            ("play", self._play_label(), "primary"),
            ("levels", "LEVELS", "primary"),
            ("help", "HOW TO PLAY", "ghost"),
            ("settings", "SETTINGS", "ghost"),
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
        self._demo_hairpins = 0

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

    def _hairpin_target(self) -> Tuple[float, float]:
        """
        A point *behind* the head, so the demo has to turn all the way round.

        Turning is constant-radius in v2, which means this always resolves into
        a tight, readable loop that passes right over the snake's own neck -
        the single best advertisement the movement model has.
        """
        snake = self._demo
        if snake is None:
            return self._pick_target()
        hx, hy = snake.head_pos()
        ang = float(snake.heading) + math.pi + self._rng.uniform(-0.55, 0.55)
        reach = self._rng.uniform(*DEMO_HAIRPIN_REACH)
        x = clamp(hx + math.cos(ang) * reach, DEMO_MARGIN, C.WINDOW_W - DEMO_MARGIN)
        y = clamp(hy + math.sin(ang) * reach, DEMO_MARGIN + 60.0, C.WINDOW_H - DEMO_MARGIN)
        return (float(x), float(y))

    def _next_demo_leg(self) -> None:
        """Choose the demo snake's next target: a wander, or a queued hairpin."""
        if self._demo_hairpins > 0:
            self._demo_hairpins -= 1
            self._demo_target = self._hairpin_target()
            self._demo_timer = self._rng.uniform(1.3, 2.1)
            return
        self._demo_target = self._pick_target()
        self._demo_timer = self._rng.uniform(2.2, 4.0)
        if self._rng.random() < DEMO_HAIRPIN_CHANCE:
            self._demo_hairpins = self._rng.randint(1, 2)

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
                if key in (pygame.K_RETURN, pygame.K_KP_ENTER, pygame.K_SPACE,
                           pygame.K_p):
                    self._activate("play")
                elif key == pygame.K_l:
                    self._activate("levels")
                elif key in (pygame.K_h, pygame.K_F1):
                    self._activate("help")
                elif key in (pygame.K_s, pygame.K_o):
                    self._activate("settings")
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
            # The mode picker owns story-vs-free and the difficulty choice; the
            # menu deliberately starts nothing itself.
            game.switch_scene(C.SCENE_MODE)
        elif action == "levels":
            # Level select is free play by definition.
            try:
                game.mode = C.MODE_FREE
            except Exception:
                pass
            game.switch_scene(C.SCENE_LEVELS)
        elif action == "help":
            game.switch_scene(C.SCENE_HELP)
        elif action == "settings":
            game.switch_scene(C.SCENE_SETTINGS, back=C.SCENE_MENU)
        elif action == "quit":
            game.quit()

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
            self._update_ambience(dt)
        except Exception:
            pass

    def _update_ambience(self, dt: float) -> None:
        """Drifting motes plus a slow shockwave that keeps the backdrop alive."""
        theme = self._theme
        mid = P.lerp_color(theme.accent, theme.accent2, 0.5)
        self.game.particles.ambient((0, 0, C.WINDOW_W, C.WINDOW_H), mid, dt,
                                    rate=9.0, turbulence=0.12, twinkle=0.3)

        self._ring_timer -= dt
        if self._ring_timer <= 0.0:
            self._ring_timer = RING_PERIOD * self._rng.uniform(0.8, 1.3)
            # Rings are placed off the button column so they read as weather,
            # not as UI feedback.
            side = -1.0 if self._rng.random() < 0.5 else 1.0
            x = C.WINDOW_W * 0.5 + side * self._rng.uniform(300.0, 520.0)
            y = self._rng.uniform(180.0, C.WINDOW_H - 120.0)
            self.game.particles.ring(x, y, theme.accent2, radius=self._rng.uniform(40, 90),
                                     count=14, life=1.1, speed=70.0,
                                     color_end=theme.accent)

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
            self._demo_hairpins = 0
        elif self._demo_timer <= 0.0 or dist(hx, hy, *self._demo_target) < 70.0:
            self._next_demo_leg()

        snake.set_target(*self._demo_target)
        snake.update(dt)

        # A hard bail-out in case anything ever pushes it off screen entirely.
        hx, hy = snake.head_pos()
        if not (-200.0 <= hx <= C.WINDOW_W + 200.0 and -200.0 <= hy <= C.WINDOW_H + 200.0):
            self._spawn_demo()
            return

        self.game.particles.trail(hx, hy, self._theme.snake_a, dt, rate=22.0,
                                  speed=(6.0, 30.0), life=(0.3, 0.75),
                                  radius=(1.6, 3.6), ribbon=0.3,
                                  color_end=self._theme.snake_b)

        # Hard steering throws sparks off the outside of the turn, so a hairpin
        # actually looks like it costs something.
        turn = 0.0
        try:
            turn = float(snake.turn_input)
        except Exception:
            turn = 0.0
        if abs(turn) > 0.65:
            side = snake.heading + (math.pi * 0.5 if turn < 0.0 else -math.pi * 0.5)
            self.game.particles.stream(hx, hy, side, self._theme.accent2, dt,
                                       rate=26.0, speed=(50.0, 130.0),
                                       spread=0.5, life=(0.18, 0.4),
                                       radius=(1.4, 3.0))

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
            self._draw_difficulty_badge(surface)
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

    def _play_caption(self) -> str:
        """The line above PLAY, telling the player exactly what it will do."""
        if self._story_in_progress():
            idx = self._story_index()
            beat = S.get_beat(idx)
            chapter = S.get_chapter(idx)
            return "STORY  -  CHAPTER {}  -  {:02d} {}".format(
                chapter.roman, beat.number, beat.title.upper())
        try:
            if bool(self.game.save.story_complete):
                return "STORY COMPLETE  -  REPLAY OR PICK A LEVEL"
        except Exception:
            pass
        return "CHOOSE STORY OR FREE PLAY"

    def _draw_buttons(self, surface: pygame.Surface) -> None:
        fonts = getattr(self.game, "fonts", None)
        for i, button in enumerate(self._buttons):
            if self._button_alpha(i) <= 0.0:
                continue
            button.draw(surface, self._theme, fonts, self._t)

        # A caption above PLAY telling the player what it leads into.
        if self._buttons and self._entered > 0.5:
            rect = self._base_rects[0]
            fonts_small = getattr(fonts, "small", None) if fonts else None
            draw_text(surface, self._play_caption(), fonts_small,
                      P.shade(self._theme.text_dim, 1.0),
                      (rect.centerx, rect.top - 30), align="center")

    def _draw_difficulty_badge(self, surface: pygame.Surface) -> None:
        """
        The coloured pill beside PLAY naming the difficulty of the next run.

        It sits *outside* the button so it never fights the button's own hover
        animation, and fades in with the stack.
        """
        if not self._base_rects or self._entered < 0.35:
            return
        diff = self._difficulty()
        fonts = getattr(self.game, "fonts", None)
        f_tiny = getattr(fonts, "tiny", None) if fonts else None

        badge = _badge_surface(diff.hud_label, tuple(int(c) for c in diff.color), f_tiny)
        rect = self._base_rects[0]
        k = ease_out_back(clamp((self._entered - 0.35) / 0.45, 0.0, 1.0))
        x = int(rect.right + 16 + (1.0 - k) * 40.0)
        y = int(rect.centery - badge.get_height() * 0.5)

        # A soft halo in the mode's own colour, so EXPERT reads red at a glance.
        draw_glow_circle(surface, x + badge.get_width() * 0.5, rect.centery,
                         badge.get_width() * 0.75, diff.color,
                         (0.22 + 0.12 * pulse(self._t, 1.1)) * k)
        badge.set_alpha(int(255 * clamp(k, 0.0, 1.0)))
        surface.blit(badge, (x, y))
        badge.set_alpha(255)

        draw_text(surface, "DIFFICULTY", f_tiny, P.shade(self._theme.text_dim, 0.85),
                  (x, rect.centery - badge.get_height() * 0.5 - 17))

    def _draw_stats_panel(self, surface: pygame.Surface) -> None:
        """Best score, story chapter, campaign progress and stars, bottom-left."""
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
        panel = pygame.Rect(int(34 - (1.0 - k) * 260.0), C.WINDOW_H - 204, 286, 170)
        draw_panel(surface, panel, theme, alpha=206, glow=0.25 + 0.12 * pulse(self._t, 1.3))

        try:
            best = int(save.highscore)
            stars = int(save.total_stars())
            max_stars = max(1, int(save.max_stars()))
            cleared, total = save.progress()
        except Exception:
            best, stars, max_stars, cleared, total = 0, 0, 1, 0, LEVEL_COUNT

        draw_text(surface, "BEST SCORE", f_tiny, theme.text_dim,
                  (panel.x + 18, panel.y + 12))
        draw_text(surface, "{:,}".format(best), f_h2,
                  P.lerp_color(P.UI_GOLD, P.UI_WHITE, 0.25),
                  (panel.x + 18, panel.y + 30))

        # ---- story progress ------------------------------------------------
        draw_text(surface, "STORY", f_tiny, theme.text_dim, (panel.x + 18, panel.y + 72))
        draw_text(surface, self._story_summary(), f_small,
                  P.lerp_color(theme.text, theme.accent, 0.35),
                  (panel.right - 18, panel.y + 70), align="right")

        # ---- stars ---------------------------------------------------------
        draw_text(surface, "STARS", f_tiny, theme.text_dim, (panel.x + 18, panel.y + 98))
        draw_text(surface, "{} / {}".format(stars, max_stars), f_small, P.UI_GOLD,
                  (panel.right - 18, panel.y + 96), align="right")
        draw_bar(surface, pygame.Rect(panel.x + 18, panel.y + 122, panel.w - 36, 9),
                 stars / float(max_stars), P.UI_GOLD)

        draw_text(surface, "LEVELS CLEARED  {} / {}".format(cleared, total), f_tiny,
                  P.shade(theme.text_dim, 0.95), (panel.x + 18, panel.y + 140))

    def _story_summary(self) -> str:
        """``CHAPTER II OF IV`` - or the end-states either side of it."""
        save = getattr(self.game, "save", None)
        try:
            if save is not None and bool(save.story_complete):
                return "COMPLETE"
        except Exception:
            pass
        if not self._story_in_progress():
            return "NOT STARTED"
        chapter = S.get_chapter(self._story_index())
        last = S.CHAPTERS[-1] if S.CHAPTERS else chapter
        return "CHAPTER {} OF {}".format(chapter.roman, last.roman)

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
