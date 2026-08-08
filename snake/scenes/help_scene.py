"""
HELP - the "How To Play" screen.

This is the one screen in NEON SERPENT that has to be *read*, so it trades
spectacle for clarity.  It teaches by showing:

*   Left, a live autonomous demo.  A real :class:`~snake.core.snake.Snake` runs
    the real simulation while a fake cursor orbits the box on a Lissajous path.
    The snake is steered by ``set_target`` at exactly that cursor, and a dotted
    leash is drawn between the two - so the "the head always turns toward your
    pointer" relationship is visible in one glance instead of one sentence.
*   Right, the four controls, each with a drawn icon rather than a key name.
*   Below that, the six power-ups, drawn as their in-arena runes.  Their names,
    colours and one-line descriptions come from ``powerup_info`` so this legend
    can never drift away from what the game actually does.
*   Finally a short hazard legend, and a BACK button to the menu.

Nothing in here may raise: `update` and `draw` swallow their own failures.
"""

from __future__ import annotations

import math
import random
from typing import TYPE_CHECKING, Any, List, Optional, Sequence, Tuple

import pygame

from .. import config as C
from .. import palette as P
from ..core.contracts import TAU, Scene, clamp, dist, pulse
from ..core.powerups import POWERUP_KINDS, powerup_color, powerup_info
from ..core.snake import Snake
from ..gfx.background import make_background
from ..gfx.render import draw_food_orb, draw_glow_circle, draw_snake
from ..gfx.ui import Button, draw_panel, draw_text

if TYPE_CHECKING:  # pragma: no cover - typing only
    from ..main import Game

RGB = Tuple[int, int, int]

# --------------------------------------------------------------------------
# Layout.  Everything is authored against the fixed 1280x720 canvas, in one
# place, so a tweak to one panel cannot silently overlap its neighbour.
# --------------------------------------------------------------------------
_PAD = 40
_TOP = 96                                   # first row of content

_DEMO_PANEL = pygame.Rect(_PAD, _TOP, 496, 300)
_HAZARD_PANEL = pygame.Rect(_PAD, 412, 496, 208)
_CTRL_PANEL = pygame.Rect(560, _TOP, 680, 216)
_PU_PANEL = pygame.Rect(560, 328, 680, 292)
_BACK_RECT = pygame.Rect((C.WINDOW_W - C.UI_BUTTON_W) // 2, 638,
                         C.UI_BUTTON_W, C.UI_BUTTON_H)

# Inner play area of the demo box (the panel minus its caption strip).
_DEMO_RECT = pygame.Rect(_DEMO_PANEL.x + 16, _DEMO_PANEL.y + 40,
                         _DEMO_PANEL.w - 32, _DEMO_PANEL.h - 62)

# --------------------------------------------------------------------------
# Demo tuning
# --------------------------------------------------------------------------
_DEMO_SPEED = 150.0                         # px/s - slow enough to read
_DEMO_LENGTH = 9                            # body segments
_DEMO_MAX_LENGTH = 15
# The pointer path is deliberately a touch faster than the snake: if the two
# speeds matched, the head would simply sit on the reticle and the leash - the
# thing this demo exists to show - would never be visible.
_LISSA_A = 1.25                             # x frequency of the cursor path
_LISSA_B = 0.83                             # y frequency (the 8-figure)
_LISSA_MARGIN = 46.0                        # keep the path off the frame

# Control rows: (icon key, caption, one-liner).
_CONTROLS: Tuple[Tuple[str, str, str], ...] = (
    ("move", "MOVE THE MOUSE", "The head always turns toward your cursor."),
    ("right", "HOLD RIGHT BUTTON", "Spend stamina for a burst of speed."),
    ("left", "LEFT CLICK", "Every menu and button is mouse-driven."),
    # The gameplay HUD's affordance is a button labelled PAUSE, not a chevron;
    # this copy has to name what is actually on screen.
    ("esc", "ESC", "Pause the run - or click PAUSE in the HUD."),
)

# Hazard rows: (icon key, caption, one-liner).
_HAZARDS: Tuple[Tuple[str, str, str], ...] = (
    ("wall", "WALLS", "Solid neon slabs. A touch costs a life."),
    ("mover", "MOVERS & SPINNERS", "Bars that sweep the lane. Time the gap."),
    ("laser", "LASER GATES", "They blink. Cross only while they are dark."),
    ("portal", "PORTALS", "Harmless: dive in, pop out of the twin."),
)


# ==========================================================================
# Small drawing helpers (all local - nothing here reaches into private API)
# ==========================================================================
def _mix(a: Sequence[int], b: Sequence[int], t: float) -> RGB:
    return P.lerp_color((int(a[0]), int(a[1]), int(a[2])),
                        (int(b[0]), int(b[1]), int(b[2])), t)


def _dotted_line(surface: pygame.Surface, ax: float, ay: float,
                 bx: float, by: float, color: Sequence[int],
                 phase: float = 0.0, step: float = 11.0) -> None:
    """A marching-ants leash. `phase` slides the dashes toward the target."""
    total = dist(ax, ay, bx, by)
    if total < 4.0:
        return
    ux, uy = (bx - ax) / total, (by - ay) / total
    d = (phase % step)
    while d < total:
        f = d / total                       # fade in toward the pointer end
        col = P.shade(color, 0.25 + 0.55 * f)
        pygame.draw.circle(surface, col, (int(ax + ux * d), int(ay + uy * d)),
                           1 + int(f * 1.6))
        d += step


def _fake_cursor(surface: pygame.Surface, cx: float, cy: float,
                 theme: P.Theme, t: float) -> None:
    """
    A miniature of the real reticle from `gfx.ui.draw_cursor`.

    It deliberately echoes the player's actual pointer art so the demo reads as
    "this dot is your mouse" without a caption doing the work.
    """
    accent = theme.accent
    accent2 = theme.accent2
    r = 11.0 + 1.2 * pulse(t, 3.0)
    draw_glow_circle(surface, cx, cy, 20.0, accent, 0.5)

    spin = t * 1.35
    ring = pygame.Rect(0, 0, int(r * 2), int(r * 2))
    ring.center = (int(cx), int(cy))
    for k in range(3):
        a0 = spin + k * (TAU / 3.0)
        try:
            pygame.draw.arc(surface, _mix(accent, P.UI_WHITE, 0.3), ring, a0, a0 + 0.85, 2)
        except Exception:
            break
    for k in range(4):
        ang = spin * -0.5 + k * (math.pi * 0.5)
        ca, sa = math.cos(ang), math.sin(ang)
        pygame.draw.line(surface, P.shade(accent2, 0.85),
                         (int(cx + ca * (r + 3.0)), int(cy + sa * (r + 3.0))),
                         (int(cx + ca * (r + 8.0)), int(cy + sa * (r + 8.0))), 1)
    pygame.draw.circle(surface, P.UI_WHITE, (int(cx), int(cy)), 2)


def _mouse_icon(surface: pygame.Surface, cx: float, cy: float, theme: P.Theme,
                lit: str, t: float) -> None:
    """
    A 26x36-ish mouse body.  `lit` is "", "left", "right" or "move" and picks
    which half of the shell glows (or draws the motion arcs).
    """
    accent = theme.accent
    dim = P.shade(theme.text_dim, 0.9)
    w, h = 22, 32
    body = pygame.Rect(0, 0, w, h)
    body.center = (int(cx), int(cy))

    if lit in ("left", "right"):
        half = pygame.Rect(body.x, body.y, w // 2, h // 2)
        if lit == "right":
            half.x = body.centerx
        glow_c = P.UI_WARN if lit == "right" else accent
        draw_glow_circle(surface, half.centerx, half.centery, 16.0, glow_c,
                         0.55 + 0.35 * pulse(t, 3.2))
        pygame.draw.rect(surface, _mix(glow_c, P.UI_WHITE, 0.25), half,
                         border_top_left_radius=(10 if lit == "left" else 0),
                         border_top_right_radius=(10 if lit == "right" else 0))

    pygame.draw.rect(surface, _mix(dim, P.UI_WHITE, 0.35), body, 2, border_radius=10)
    pygame.draw.line(surface, dim, (body.centerx, body.y + 2), (body.centerx, body.centery), 2)
    pygame.draw.line(surface, dim, (body.x + 2, body.centery),
                     (body.right - 2, body.centery), 1)

    if lit == "move":
        # Two arcs either side, sliding outward: the universal "it moves" cue.
        wobble = 2.0 * math.sin(t * 3.4)
        for side in (-1, 1):
            for k in (0, 1):
                x = body.centerx + side * (w * 0.5 + 6 + k * 5) + side * wobble
                pygame.draw.arc(surface, P.shade(accent, 0.9 - 0.35 * k),
                                pygame.Rect(int(x - 6), int(cy - 9), 12, 18),
                                -0.7 if side > 0 else math.pi - 0.7,
                                0.7 if side > 0 else math.pi + 0.7, 2)


def _key_icon(surface: pygame.Surface, cx: float, cy: float, theme: P.Theme,
              label: str, fonts: Any, t: float) -> None:
    """A little keycap with a label engraved on it."""
    cap = pygame.Rect(0, 0, 46, 30)
    cap.center = (int(cx), int(cy))
    draw_glow_circle(surface, cx, cy, 22.0, theme.accent2, 0.22 + 0.12 * pulse(t, 2.2))
    pygame.draw.rect(surface, P.with_alpha(P.UI_PANEL_LIGHT, 255), cap, border_radius=7)
    pygame.draw.rect(surface, _mix(theme.accent2, P.UI_WHITE, 0.25), cap, 2, border_radius=7)
    font = getattr(fonts, "tiny", None)
    draw_text(surface, label, font, P.UI_WHITE, (cap.centerx, cap.centery - 7),
              align="center", shadow=False)


def _hazard_icon(surface: pygame.Surface, key: str, cx: float, cy: float,
                 theme: P.Theme, t: float) -> None:
    """Tiny vector stand-ins for the four families of obstacle."""
    hz = theme.hazard
    if key == "wall":
        r = pygame.Rect(0, 0, 30, 16)
        r.center = (int(cx), int(cy))
        draw_glow_circle(surface, cx, cy, 20.0, hz, 0.35)
        pygame.draw.rect(surface, P.shade(hz, 0.55), r, border_radius=4)
        pygame.draw.rect(surface, _mix(hz, P.UI_WHITE, 0.35), r, 2, border_radius=4)
    elif key == "mover":
        ang = t * 1.5
        ca, sa = math.cos(ang), math.sin(ang)
        draw_glow_circle(surface, cx, cy, 20.0, hz, 0.35)
        pygame.draw.line(surface, _mix(hz, P.UI_WHITE, 0.3),
                         (int(cx - ca * 15), int(cy - sa * 15)),
                         (int(cx + ca * 15), int(cy + sa * 15)), 5)
        pygame.draw.circle(surface, P.UI_WHITE, (int(cx), int(cy)), 2)
    elif key == "laser":
        on = pulse(t, 4.0) > 0.45
        col = _mix(hz, P.UI_WHITE, 0.4) if on else P.shade(hz, 0.25)
        if on:
            draw_glow_circle(surface, cx, cy, 20.0, hz, 0.55)
        for sy in (-13, 13):
            pygame.draw.circle(surface, P.shade(hz, 0.8), (int(cx), int(cy + sy)), 3)
        step = 4 if on else 8
        for y in range(-11, 12, step):
            pygame.draw.line(surface, col, (int(cx), int(cy + y)),
                             (int(cx), int(cy + min(11, y + step - 2))), 3)
    else:  # portal
        col = theme.accent2
        draw_glow_circle(surface, cx, cy, 20.0, col, 0.40)
        for k, ox in enumerate((-8, 8)):
            rr = 9 - 2 * k
            pygame.draw.circle(surface, _mix(col, P.UI_WHITE, 0.3 * k),
                               (int(cx + ox), int(cy)), rr, 2)
        pygame.draw.line(surface, P.shade(col, 0.7),
                         (int(cx - 4), int(cy)), (int(cx + 4), int(cy)), 1)


# --------------------------------------------------------------------------
# Power-up runes.  These mirror the emblems the arena draws, re-authored here
# because the arena's painter is private.  Colour and copy still come from
# powerup_info, which is the part that must never drift.
# --------------------------------------------------------------------------
def _arc_pts(cx: float, cy: float, s: float, r: float,
             a0: float, a1: float, steps: int = 12) -> List[Tuple[int, int]]:
    """Points along an arc in the normalised -1..1 glyph box (y grows down)."""
    out: List[Tuple[int, int]] = []
    for i in range(steps + 1):
        a = a0 + (a1 - a0) * (i / float(steps))
        out.append((int(cx + math.cos(a) * r * s), int(cy - math.sin(a) * r * s)))
    return out


def _poly(cx: float, cy: float, s: float,
          norm: Sequence[Tuple[float, float]]) -> List[Tuple[int, int]]:
    return [(int(cx + px * s), int(cy + py * s)) for px, py in norm]


_SHIELD = ((-0.80, -0.72), (0.80, -0.72), (0.80, 0.06), (0.00, 0.94), (-0.80, 0.06))
_HOURGLASS = ((-0.72, -0.88), (0.72, -0.88), (0.12, 0.0),
              (0.72, 0.88), (-0.72, 0.88), (-0.12, 0.0))
_BOLT = ((0.16, -0.96), (-0.66, 0.14), (-0.10, 0.14),
         (-0.30, 0.96), (0.62, -0.18), (0.06, -0.18))
_GHOST_TAIL = ((0.74, 0.42), (0.44, 0.92), (0.15, 0.46),
               (-0.15, 0.92), (-0.44, 0.46), (-0.74, 0.92))


def _glyph(surface: pygame.Surface, kind: str, col: RGB,
           cx: float, cy: float, s: float) -> None:
    """Stroke one power-up emblem, centred on (cx, cy) with radius `s`."""
    w = max(2, int(s * 0.22))
    if kind == "magnet":
        pygame.draw.lines(surface, col, False,
                          _arc_pts(cx, cy - 0.10 * s, s, 0.92, 0.0, math.pi, 14), w)
        for sx in (-0.92, 0.92):
            pygame.draw.line(surface, col,
                             (int(cx + sx * s), int(cy - 0.10 * s)),
                             (int(cx + sx * s), int(cy + 0.74 * s)), w)
            pygame.draw.line(surface, col,
                             (int(cx + sx * s * 1.28), int(cy + 0.74 * s)),
                             (int(cx + sx * s * 0.56), int(cy + 0.74 * s)),
                             max(2, int(w * 0.9)))
    elif kind == "shield":
        pygame.draw.polygon(surface, col, _poly(cx, cy, s, _SHIELD), w)
        pygame.draw.line(surface, col, (int(cx), int(cy - 0.36 * s)),
                         (int(cx), int(cy + 0.46 * s)), max(1, w - 1))
    elif kind == "slow":
        pygame.draw.polygon(surface, col, _poly(cx, cy, s, _HOURGLASS), w)
        pygame.draw.circle(surface, col, (int(cx), int(cy + 0.52 * s)),
                           max(2, int(s * 0.14)))
    elif kind == "double":
        for scale in (0.94, 0.48):
            dia = ((0.0, -scale), (scale, 0.0), (0.0, scale), (-scale, 0.0))
            pygame.draw.polygon(surface, col, _poly(cx, cy, s, dia), w)
    elif kind == "ghost":
        dome = [(math.cos(a) * 0.74, -math.sin(a) * 0.74)
                for a in (i * math.pi / 12.0 for i in range(13))]
        outline = _poly(cx, cy, s, list(dome) + list(reversed(_GHOST_TAIL)))
        pygame.draw.lines(surface, col, True, outline, w)
        for sx in (-0.30, 0.30):
            pygame.draw.circle(surface, col,
                               (int(cx + sx * s), int(cy - 0.16 * s)),
                               max(2, int(s * 0.13)))
    elif kind == "frenzy":
        pygame.draw.polygon(surface, col, _poly(cx, cy, s, _BOLT))
    else:
        pygame.draw.circle(surface, col, (int(cx), int(cy)), max(2, int(s * 0.7)), w)


def _draw_rune(surface: pygame.Surface, kind: str, cx: float, cy: float,
               r: float, theme: P.Theme, t: float) -> None:
    """Halo + counter-rotating hexagram + core + emblem: the arena rune, small."""
    col = powerup_color(kind)
    ring_col = _mix(col, theme.accent, 0.28)
    draw_glow_circle(surface, cx, cy, r * 2.4, col, 0.45 + 0.12 * pulse(t, 2.6))

    spin = t * 0.85
    tri_r = r * 1.34
    for sense in (1.0, -1.0):
        a0 = spin * sense + (0.0 if sense > 0 else math.pi / 3.0)
        pts = [(int(cx + math.cos(a0 + k * TAU / 3.0) * tri_r),
                int(cy + math.sin(a0 + k * TAU / 3.0) * tri_r)) for k in range(3)]
        pygame.draw.polygon(surface, P.shade(ring_col, 0.55), pts, max(1, int(r * 0.13)))

    pygame.draw.circle(surface, P.shade(col, 0.30), (int(cx), int(cy)),
                       max(2, int(r * 0.55)))
    _glyph(surface, kind, _mix(col, P.UI_WHITE, 0.55), cx, cy, r * 0.78)


# ==========================================================================
# Scene
# ==========================================================================
class HelpScene(Scene):
    """The How To Play screen: a live demo on the left, the legends on the right."""

    transparent = False
    blocks_update = True

    def __init__(self, game: "Game") -> None:
        super().__init__(game)
        self.theme: P.Theme = P.theme_for_level(0)
        self.t: float = 0.0                       # local clock, reset on entry
        self.background: Any = None
        self._bg_style: str = ""

        self.back: Button = Button(_BACK_RECT, "BACK", style="primary")

        # -- demo state ----------------------------------------------------
        self.snake: Optional[Snake] = None
        self.cursor: Tuple[float, float] = _DEMO_RECT.center
        self.food: Tuple[float, float] = _DEMO_RECT.center
        self.food_pop: float = 0.0                # 0..1 flash after a pickup
        self.food_age: float = 0.0                # seconds since it was placed
        self._rng = random.Random(7)
        self._lissa_phase: float = 0.0

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------
    def on_enter(self, **kwargs: Any) -> None:
        """Full reset: scene instances are cached and reused by the Game."""
        try:
            self.t = 0.0
            self.theme = P.theme_for_level(int(getattr(self.game, "level_index", 0)))
            self._ensure_background()

            self.back = Button(_BACK_RECT, "BACK", style="primary",
                               font=getattr(self.game.fonts, "h2", None))

            self._lissa_phase = 0.0
            self.cursor = self._cursor_target(0.0)
            self.snake = Snake(_DEMO_RECT.centerx, _DEMO_RECT.centery,
                               0.0, length=_DEMO_LENGTH)
            self.snake.speed = _DEMO_SPEED
            self.food_pop = 0.0
            self._respawn_food()
        except Exception:
            pass

    def on_exit(self) -> None:
        # Drop the demo so a re-entry always starts from a clean pose.
        self.snake = None

    def _ensure_background(self) -> None:
        """(Re)build the scrolling backdrop when the active theme changed."""
        style = str(getattr(self.theme, "bg_style", "grid"))
        if self.background is not None and style == self._bg_style:
            return
        try:
            self.background = make_background(
                style, self.theme, pygame.Rect(0, 0, C.WINDOW_W, C.WINDOW_H))
            self._bg_style = style
        except Exception:
            self.background = None

    # ------------------------------------------------------------------
    # Input
    # ------------------------------------------------------------------
    def handle_event(self, event: pygame.event.Event) -> None:
        try:
            if self.back.handle_event(event):
                self._go_back()
                return
            if event.type == pygame.KEYDOWN and event.key in (
                    pygame.K_ESCAPE, pygame.K_BACKSPACE, pygame.K_RETURN,
                    pygame.K_SPACE, pygame.K_h):
                self._go_back()
        except Exception:
            pass

    def _go_back(self) -> None:
        try:
            self.game.audio.play("click")
        except Exception:
            pass
        try:
            self.game.switch_scene(C.SCENE_MENU)
        except Exception:
            pass

    # ------------------------------------------------------------------
    # Update
    # ------------------------------------------------------------------
    def update(self, dt: float) -> None:
        try:
            dt = clamp(float(dt), 0.0, C.MAX_DT)
            self.t += dt

            was_hovered = self.back.hovered
            self.back.update(dt, getattr(self.game, "mouse_pos", (0.0, 0.0)))
            if self.back.hovered and not was_hovered:
                try:
                    self.game.audio.play("hover")
                except Exception:
                    pass

            if self.background is not None:
                self.background.update(dt)

            self._update_demo(dt)
        except Exception:
            pass

    def _cursor_target(self, t: float) -> Tuple[float, float]:
        """Lissajous figure inset from the demo frame - a lazy figure-of-eight."""
        rx = _DEMO_RECT.w * 0.5 - _LISSA_MARGIN
        ry = _DEMO_RECT.h * 0.5 - _LISSA_MARGIN
        return (_DEMO_RECT.centerx + math.cos(t * _LISSA_A) * rx,
                _DEMO_RECT.centery + math.sin(t * _LISSA_B) * ry)

    def _respawn_food(self) -> None:
        """
        Drop the demo orb a couple of seconds ahead on the pointer's own path.

        The snake only ever chases the reticle, so seeding the orb where the
        reticle is *about* to be is what keeps the demo eating at a steady clip
        instead of wandering past a stationary pellet.
        """
        pad = 26.0
        self.food_age = 0.0
        ahead = self._rng.uniform(1.2, 2.4)
        x, y = self._cursor_target(self._lissa_phase + ahead)
        x += self._rng.uniform(-10.0, 10.0)
        y += self._rng.uniform(-10.0, 10.0)
        self.food = (clamp(x, _DEMO_RECT.left + pad, _DEMO_RECT.right - pad),
                     clamp(y, _DEMO_RECT.top + pad, _DEMO_RECT.bottom - pad))

    def _update_demo(self, dt: float) -> None:
        snake = self.snake
        if snake is None:
            return
        self._lissa_phase += dt
        self.cursor = self._cursor_target(self._lissa_phase)
        self.food_pop = max(0.0, self.food_pop - dt * 2.2)
        self.food_age += dt

        # The whole point of the demo: the snake is steered by nothing except
        # "go to the pointer", exactly like the player's snake is.
        snake.set_target(self.cursor[0], self.cursor[1])
        snake.update(dt)

        hx, hy = snake.head_pos()
        if dist(hx, hy, self.food[0], self.food[1]) < C.FOOD_RADIUS + 14.0:
            self.food_pop = 1.0
            # `target_length` is the growth goal; `length` is a read-only
            # property of the resolved body, so the cap is checked on the goal.
            if snake.target_length < _DEMO_MAX_LENGTH:
                snake.grow(1)
            else:
                snake.shrink(2)
            self._respawn_food()
        elif self.food_age > 5.0:
            # The head cuts corners, so an orb the pointer swung past can be
            # left stranded.  Re-seed it rather than let the demo go static.
            self._respawn_food()

        # Safety net: a stall or a resize could leave the head outside the box.
        # Nudging it back keeps the demo on screen without a visible pop.
        cx = clamp(hx, _DEMO_RECT.left + 6.0, _DEMO_RECT.right - 6.0)
        cy = clamp(hy, _DEMO_RECT.top + 6.0, _DEMO_RECT.bottom - 6.0)
        if cx != hx or cy != hy:
            snake.teleport(cx, cy)

    # ------------------------------------------------------------------
    # Draw
    # ------------------------------------------------------------------
    def draw(self, surface: pygame.Surface) -> None:
        try:
            theme = self.theme
            fonts = getattr(self.game, "fonts", None)
            t = self.t

            if self.background is not None:
                self.background.draw(surface)
            else:
                surface.fill(theme.bg_bottom)

            self._draw_header(surface, theme, fonts, t)
            self._draw_demo(surface, theme, fonts, t)
            self._draw_controls(surface, theme, fonts, t)
            self._draw_powerups(surface, theme, fonts, t)
            self._draw_hazards(surface, theme, fonts, t)

            self.back.draw(surface, theme, fonts, t)
        except Exception:
            pass

    # -- pieces --------------------------------------------------------
    def _draw_header(self, surface: pygame.Surface, theme: P.Theme,
                     fonts: Any, t: float) -> None:
        draw_text(surface, "HOW TO PLAY", getattr(fonts, "h1", None),
                  _mix(theme.accent, P.UI_WHITE, 0.35), (_PAD, 18))
        draw_text(surface, "steer with the mouse - everything else is a bonus",
                  getattr(fonts, "small", None), theme.text_dim, (_PAD + 4, 64))
        draw_text(surface, C.GAME_TITLE, getattr(fonts, "small", None),
                  P.shade(theme.accent2, 0.9), (C.WINDOW_W - _PAD, 26), align="right")
        draw_text(surface, f"v{C.VERSION}", getattr(fonts, "tiny", None),
                  P.shade(theme.text_dim, 0.8), (C.WINDOW_W - _PAD, 50), align="right")

    def _panel_title(self, surface: pygame.Surface, rect: pygame.Rect, label: str,
                     theme: P.Theme, fonts: Any) -> None:
        """Caption strip shared by every panel: a tick mark plus small caps."""
        pygame.draw.line(surface, theme.accent,
                         (rect.x + 16, rect.y + 26), (rect.x + 16, rect.y + 12), 3)
        draw_text(surface, label, getattr(fonts, "small", None),
                  _mix(theme.accent, P.UI_WHITE, 0.4), (rect.x + 26, rect.y + 11))

    def _draw_demo(self, surface: pygame.Surface, theme: P.Theme,
                   fonts: Any, t: float) -> None:
        draw_panel(surface, _DEMO_PANEL, theme, alpha=214, glow=0.35)
        self._panel_title(surface, _DEMO_PANEL, "THE SNAKE FOLLOWS YOUR POINTER",
                          theme, fonts)

        # Inner play box: a darker well so the demo pops out of the panel.
        well = pygame.Surface(_DEMO_RECT.size, pygame.SRCALPHA)
        well.fill(P.with_alpha(P.shade(theme.bg_bottom, 1.1), 218))
        # A faint lattice, so the box reads as a scaled-down play field.
        lattice = P.with_alpha(theme.grid, 60)
        for gx in range(0, _DEMO_RECT.w, 32):
            pygame.draw.line(well, lattice, (gx, 0), (gx, _DEMO_RECT.h))
        for gy in range(0, _DEMO_RECT.h, 32):
            pygame.draw.line(well, lattice, (0, gy), (_DEMO_RECT.w, gy))
        surface.blit(well, _DEMO_RECT.topleft)
        pygame.draw.rect(surface, P.shade(theme.grid, 1.0), _DEMO_RECT, 1,
                         border_radius=6)

        snake = self.snake
        if snake is None:
            return
        hx, hy = snake.head_pos()
        cx, cy = self.cursor

        # draw_snake / the orb glow are unbounded, so clip them to the well.
        prev_clip = surface.get_clip()
        try:
            area = pygame.Rect(_DEMO_RECT)
            if prev_clip is not None:
                area = area.clip(prev_clip)
            surface.set_clip(area)

            _dotted_line(surface, hx, hy, cx, cy, theme.accent, phase=-t * 34.0)

            pop = 1.0 + 0.35 * self.food_pop
            draw_food_orb(surface, self.food[0], self.food[1],
                          C.FOOD_RADIUS * pop, theme.food, t, "normal")
            draw_snake(surface, snake, theme, t)
            _fake_cursor(surface, cx, cy, theme, t)
        finally:
            try:
                surface.set_clip(prev_clip)
            except Exception:
                pass

        # Caption under the well, tied to the reticle with an arrow tick.
        label_y = _DEMO_RECT.bottom + 2
        draw_text(surface, "this reticle is your mouse - the head chases it",
                  getattr(fonts, "tiny", None), P.shade(theme.text_dim, 1.05),
                  (_DEMO_PANEL.centerx, label_y), align="center")

    def _draw_controls(self, surface: pygame.Surface, theme: P.Theme,
                       fonts: Any, t: float) -> None:
        draw_panel(surface, _CTRL_PANEL, theme, alpha=214, glow=0.25)
        self._panel_title(surface, _CTRL_PANEL, "CONTROLS", theme, fonts)

        row_h = 42
        top = _CTRL_PANEL.y + 44
        for i, (key, caption, blurb) in enumerate(_CONTROLS):
            ry = top + i * row_h
            icx, icy = _CTRL_PANEL.x + 42, ry + 20
            if key == "esc":
                _key_icon(surface, icx, icy, theme, "ESC", fonts, t)
            else:
                _mouse_icon(surface, icx, icy, theme, key, t)
            draw_text(surface, caption, getattr(fonts, "small", None),
                      _mix(theme.accent, P.UI_WHITE, 0.5), (_CTRL_PANEL.x + 78, ry))
            draw_text(surface, blurb, getattr(fonts, "tiny", None),
                      theme.text_dim, (_CTRL_PANEL.x + 78, ry + 20))

    def _draw_powerups(self, surface: pygame.Surface, theme: P.Theme,
                       fonts: Any, t: float) -> None:
        draw_panel(surface, _PU_PANEL, theme, alpha=214, glow=0.25)
        self._panel_title(surface, _PU_PANEL, "POWER-UPS", theme, fonts)

        col_w = (_PU_PANEL.w - 32) // 2
        row_h = 80
        top = _PU_PANEL.y + 46
        for i, kind in enumerate(POWERUP_KINDS[:6]):
            info = powerup_info(kind)
            col, row = i % 2, i // 2
            x = _PU_PANEL.x + 16 + col * col_w
            y = top + row * row_h
            _draw_rune(surface, kind, x + 30, y + 30, 17.0, theme, t)
            draw_text(surface, str(info.get("name", kind)).upper(),
                      getattr(fonts, "small", None),
                      _mix(powerup_color(kind), P.UI_WHITE, 0.35), (x + 62, y + 8))
            draw_text(surface, str(info.get("desc", "")),
                      getattr(fonts, "tiny", None), theme.text_dim, (x + 62, y + 30))
            secs = info.get("duration")
            if secs:
                draw_text(surface, f"{float(secs):.0f}s", getattr(fonts, "tiny", None),
                          P.shade(theme.text_dim, 0.75), (x + 62, y + 48))

    def _draw_hazards(self, surface: pygame.Surface, theme: P.Theme,
                      fonts: Any, t: float) -> None:
        draw_panel(surface, _HAZARD_PANEL, theme, alpha=214, glow=0.25)
        self._panel_title(surface, _HAZARD_PANEL, "HAZARDS", theme, fonts)

        row_h = 42
        top = _HAZARD_PANEL.y + 40
        for i, (key, caption, blurb) in enumerate(_HAZARDS):
            ry = top + i * row_h
            _hazard_icon(surface, key, _HAZARD_PANEL.x + 40, ry + 19, theme, t)
            col = theme.accent2 if key == "portal" else theme.hazard
            draw_text(surface, caption, getattr(fonts, "small", None),
                      _mix(col, P.UI_WHITE, 0.45), (_HAZARD_PANEL.x + 70, ry))
            draw_text(surface, blurb, getattr(fonts, "tiny", None),
                      theme.text_dim, (_HAZARD_PANEL.x + 70, ry + 20))
