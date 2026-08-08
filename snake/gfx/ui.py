"""
Mouse-driven UI toolkit for NEON SERPENT.

Everything the player actually touches lives here: the animated `Button`, the
frosted panels behind menus, text with a drop shadow, progress / stamina bars,
the custom glowing cursor and the whole in-game HUD strip.

Two rendering rules shape this module:

*   ``pygame.draw.*`` does **not** alpha-blend onto an opaque destination - it
    writes the colour straight in.  Anything translucent is therefore composed
    onto an ``SRCALPHA`` scratch surface first and blitted afterwards.
*   Additive glows are blitted with ``BLEND_RGB_ADD``, which *ignores* the
    source alpha.  Glow surfaces consequently bake their falloff into the RGB
    channels and live on plain black surfaces (black adds nothing, so the
    square corners are invisible).

Both kinds of surface are expensive to build, so every one of them is cached by
shape + colour.  Nothing in this module ever raises: a UI that explodes mid
frame would take the whole game down with it.
"""

from __future__ import annotations

import math
import weakref
from typing import TYPE_CHECKING, Any, Dict, List, Optional, Sequence, Tuple

import pygame

from .. import config as C
from .. import palette as P
from ..core.contracts import TAU, clamp, ease_out_back, pulse

if TYPE_CHECKING:  # pragma: no cover - typing only
    from ..main import Game

__all__ = [
    "Button",
    "draw_panel",
    "draw_text",
    "draw_bar",
    "draw_cursor",
    "draw_hud",
]

RGB = Tuple[int, int, int]

# --------------------------------------------------------------------------
# Caches.  Keys always contain the shape *and* the colour, so a theme change
# simply starts populating new entries instead of showing stale art.
# --------------------------------------------------------------------------
_CACHE_LIMIT = 384
_GLOW_CACHE: Dict[Any, pygame.Surface] = {}
_RGLOW_CACHE: Dict[Any, pygame.Surface] = {}
_PANEL_CACHE: Dict[Any, pygame.Surface] = {}
_TEXT_CACHE: Dict[Any, Tuple[pygame.Surface, pygame.Surface]] = {}
_BAR_CACHE: Dict[Any, pygame.Surface] = {}
_MISC_CACHE: Dict[Any, pygame.Surface] = {}
_FONT_CACHE: Dict[Tuple[int, bool], pygame.font.Font] = {}


def _store(cache: Dict[Any, Any], key: Any, value: Any, limit: int = _CACHE_LIMIT) -> Any:
    """Insert into a cache, wiping it wholesale if it has grown too large."""
    if len(cache) >= limit:
        cache.clear()
    cache[key] = value
    return value


def _q(c: Sequence[int]) -> RGB:
    """Quantise a colour into a hashable, cache-friendly key."""
    return (int(c[0]) & 0xFF, int(c[1]) & 0xFF, int(c[2]) & 0xFF)


def _q8(c: Sequence[int]) -> RGB:
    """
    Snap a colour to a 32-level-per-channel grid.

    Text is cached per colour, and HUD colours are animated (score heat, combo
    rainbow, pulsing warnings), so an exact key would mint a fresh render every
    single frame.  A step of 8 is invisible on screen and lets the cache settle.
    """
    return (min(255, (int(c[0]) + 4) // 8 * 8),
            min(255, (int(c[1]) + 4) // 8 * 8),
            min(255, (int(c[2]) + 4) // 8 * 8))


def _step(v: float, steps: int = 6) -> float:
    """
    Snap a 0..1 blend weight onto `steps` levels.

    Used for colours that ride a continuous animation: the *shape* of the
    animation (bar width, glow size) stays smooth while the colour settles on
    a handful of values, which keeps the surface caches from churning.
    """
    return round(clamp(v, 0.0, 1.0) * steps) / steps


def _rect(r: Any) -> pygame.Rect:
    """Accept a pygame.Rect, a contracts.Rect or a 4-tuple."""
    if isinstance(r, pygame.Rect):
        return r.copy()
    try:
        return pygame.Rect(int(r[0]), int(r[1]), int(r[2]), int(r[3]))
    except (TypeError, IndexError, ValueError):
        return pygame.Rect(int(r.x), int(r.y), int(r.w), int(r.h))


def _sys_font(size: int, bold: bool = False) -> pygame.font.Font:
    """Last-ditch font when no FontBook is available."""
    key = (int(size), bool(bold))
    font = _FONT_CACHE.get(key)
    if font is None:
        if not pygame.font.get_init():
            pygame.font.init()
        font = pygame.font.Font(None, int(size * 1.15))
        try:
            font.set_bold(bold)
        except Exception:
            pass
        _FONT_CACHE[key] = font
    return font


def _font(fonts: Any, name: str, size: int = 18, bold: bool = False) -> pygame.font.Font:
    """Fetch `fonts.<name>` (or a sized face) with a hard fallback."""
    try:
        if name == "display":
            return fonts.display_at(size)
        if name == "ui":
            return fonts.get(size, bold)
        got = getattr(fonts, name)
        if isinstance(got, pygame.font.Font):
            return got
    except Exception:
        pass
    return _sys_font(size, bold)


# --------------------------------------------------------------------------
# Glow primitives (additive)
# --------------------------------------------------------------------------
def _glow_add(radius: int, color: Sequence[int], intensity: float = 1.0) -> pygame.Surface:
    """
    A radial bloom on black, meant for ``BLEND_RGB_ADD``.

    The falloff lives in the RGB channels because additive blitting discards
    alpha entirely.  Concentric circles are painted outside-in so the brighter
    inner ones overwrite the dimmer outer ones.
    """
    radius = int(clamp(radius, 2, 260))
    col = _q8(color)
    key = (radius, col, round(clamp(intensity, 0.0, 3.0), 1))
    surf = _GLOW_CACHE.get(key)
    if surf is not None:
        return surf

    size = radius * 2
    surf = pygame.Surface((size, size))
    steps = int(clamp(radius, 5, 26))
    for i in range(steps, 0, -1):
        f = i / steps                      # 1.0 at the rim, ~0 at the core
        # (1 - f) ** 2.4 mimics an optical bloom far better than a linear ramp.
        b = ((1.0 - f) ** 2.4) * clamp(intensity, 0.0, 3.0)
        pygame.draw.circle(surf, P.shade(col, b), (radius, radius), max(1, int(radius * f)))
    return _store(_GLOW_CACHE, key, surf, 512)


def _blit_glow(surface: pygame.Surface, x: float, y: float, radius: float,
               color: Sequence[int], intensity: float = 1.0) -> None:
    """Additively stamp a cached bloom centred on (x, y)."""
    if intensity <= 0.01:
        return
    g = _glow_add(int(radius), color, intensity)
    surface.blit(g, (int(x - g.get_width() * 0.5), int(y - g.get_height() * 0.5)),
                 special_flags=pygame.BLEND_RGB_ADD)


def _rrect_glow(w: int, h: int, corner: int, color: Sequence[int],
                spread: int, intensity: float) -> pygame.Surface:
    """Rounded-rectangle halo on black, for ``BLEND_RGB_ADD``."""
    w, h = max(2, int(w)), max(2, int(h))
    spread = int(clamp(spread, 2, 34))
    col = _q8(color)
    key = (w, h, int(corner), col, spread, round(clamp(intensity, 0.0, 2.0), 1))
    surf = _RGLOW_CACHE.get(key)
    if surf is not None:
        return surf

    surf = pygame.Surface((w + spread * 2, h + spread * 2))
    for i in range(spread, 0, -1):
        f = i / spread
        b = ((1.0 - f) ** 2.2) * clamp(intensity, 0.0, 2.0) * 0.85
        pygame.draw.rect(surf, P.shade(col, b),
                         pygame.Rect(spread - i, spread - i, w + i * 2, h + i * 2),
                         border_radius=int(corner) + i)
    return _store(_RGLOW_CACHE, key, surf)


# --------------------------------------------------------------------------
# Panels
# --------------------------------------------------------------------------
def _panel_surface(w: int, h: int, alpha: int, border: bool, accent: RGB,
                   corner: int) -> pygame.Surface:
    """Cached frosted panel: vertical gradient, rounded mask, neon rim."""
    w, h = max(2, int(w)), max(2, int(h))
    key = (w, h, int(alpha), bool(border), accent, int(corner))
    surf = _PANEL_CACHE.get(key)
    if surf is not None:
        return surf

    surf = pygame.Surface((w, h), pygame.SRCALPHA)
    for y in range(h):
        f = (y / max(1, h - 1)) ** 0.75
        c = P.lerp_color(P.UI_PANEL_LIGHT, P.UI_PANEL, f)
        pygame.draw.line(surf, P.with_alpha(c, alpha), (0, y), (w, y))

    # Multiply by a rounded white mask so the corners become transparent.
    mask = pygame.Surface((w, h), pygame.SRCALPHA)
    pygame.draw.rect(mask, (255, 255, 255, 255), (0, 0, w, h), border_radius=corner)
    surf.blit(mask, (0, 0), special_flags=pygame.BLEND_RGBA_MULT)

    if border:
        pygame.draw.rect(surf, P.with_alpha(accent, 120), (0, 0, w, h), 2, border_radius=corner)
        # A brighter hairline along the top edge reads as a lit bevel.
        pygame.draw.line(surf, P.with_alpha(P.lerp_color(accent, P.UI_WHITE, 0.55), 90),
                         (corner, 1), (w - corner, 1))
    return _store(_PANEL_CACHE, key, surf)


def draw_panel(surface: pygame.Surface, rect: Any, theme: P.Theme, *,
               alpha: int = 210, border: bool = True, glow: float = 0.0) -> None:
    """Frosted card used as the backing for menus, dialogs and HUD blocks."""
    try:
        r = _rect(rect)
        if r.w < 2 or r.h < 2:
            return
        accent = _q(getattr(theme, "accent", P.UI_WHITE))
        if glow > 0.01:
            g = _rrect_glow(r.w, r.h, C.UI_CORNER, accent, 18, clamp(glow, 0.0, 2.0))
            surface.blit(g, (r.x - 18, r.y - 18), special_flags=pygame.BLEND_RGB_ADD)
        surface.blit(_panel_surface(r.w, r.h, int(clamp(alpha, 0, 255)), border, accent,
                                    C.UI_CORNER), r.topleft)
    except Exception:
        pass


# --------------------------------------------------------------------------
# Text
# --------------------------------------------------------------------------
def _text_pair(text: str, font: pygame.font.Font,
               color: Sequence[int]) -> Tuple[pygame.Surface, pygame.Surface]:
    """Cached (glyphs, black silhouette) pair - the silhouette is the shadow."""
    col = _q8(color)
    key = (text, id(font), col)
    pair = _TEXT_CACHE.get(key)
    if pair is not None:
        return pair
    body = font.render(text, True, col)
    shadow = body.copy()
    # Zero the RGB channels while keeping the coverage alpha -> a soft shadow.
    shadow.fill((0, 0, 0, 255), special_flags=pygame.BLEND_RGBA_MULT)
    shadow.set_alpha(150)
    return _store(_TEXT_CACHE, key, (body, shadow), 900)


def draw_text(surface: pygame.Surface, text: str, font: Optional[pygame.font.Font],
              color: Sequence[int], pos: Tuple[float, float], *,
              align: str = "left", shadow: bool = True) -> pygame.Rect:
    """
    Blit `text` anchored at `pos`.

    `pos[1]` is always the **top** edge; `pos[0]` is the left, centre or right
    edge according to `align`.  Returns the rect that was drawn (an empty rect
    if anything went wrong).
    """
    try:
        f = font if isinstance(font, pygame.font.Font) else _sys_font(18)
        body, sil = _text_pair(str(text), f, color)
        x, y = int(pos[0]), int(pos[1])
        if align == "center":
            x -= body.get_width() // 2
        elif align == "right":
            x -= body.get_width()
        if shadow:
            surface.blit(sil, (x + 2, y + 2))
        surface.blit(body, (x, y))
        return pygame.Rect(x, y, body.get_width(), body.get_height())
    except Exception:
        return pygame.Rect(0, 0, 0, 0)


# --------------------------------------------------------------------------
# Bars
# --------------------------------------------------------------------------
def _bar_track(w: int, h: int, bg: RGB, border: bool, edge: RGB) -> pygame.Surface:
    key = ("track", w, h, bg, border, edge)
    surf = _BAR_CACHE.get(key)
    if surf is not None:
        return surf
    r = h // 2
    surf = pygame.Surface((w, h), pygame.SRCALPHA)
    pygame.draw.rect(surf, P.with_alpha(bg, 190), (0, 0, w, h), border_radius=r)
    if border:
        pygame.draw.rect(surf, P.with_alpha(edge, 90), (0, 0, w, h), 1, border_radius=r)
    return _store(_BAR_CACHE, key, surf)


def _bar_fill(w: int, h: int, color: RGB) -> pygame.Surface:
    """Full-width gradient fill; partial progress is a clipped blit of it."""
    key = ("fill", w, h, color)
    surf = _BAR_CACHE.get(key)
    if surf is not None:
        return surf
    r = h // 2
    surf = pygame.Surface((w, h), pygame.SRCALPHA)
    hot = P.lerp_color(color, P.UI_WHITE, 0.45)
    for y in range(h):
        f = y / max(1, h - 1)
        # Bright core in the middle of the bar, darker at both edges.
        c = P.lerp_color(hot, P.shade(color, 0.62), abs(f - 0.35) * 1.6)
        pygame.draw.line(surf, P.with_alpha(c, 255), (0, y), (w, y))
    mask = pygame.Surface((w, h), pygame.SRCALPHA)
    pygame.draw.rect(mask, (255, 255, 255, 255), (0, 0, w, h), border_radius=r)
    surf.blit(mask, (0, 0), special_flags=pygame.BLEND_RGBA_MULT)
    return _store(_BAR_CACHE, key, surf)


def draw_bar(surface: pygame.Surface, rect: Any, frac: float, color: Sequence[int], *,
             bg: Optional[Sequence[int]] = None, border: bool = True) -> None:
    """A rounded progress / stamina bar with a glowing leading edge."""
    try:
        r = _rect(rect)
        if r.w < 3 or r.h < 2:
            return
        # Bar colours are animated (heat, warnings); quantise so the cached
        # gradient surfaces converge instead of being rebuilt every frame.
        col = _q8(color)
        frac = clamp(float(frac), 0.0, 1.0)
        surface.blit(_bar_track(r.w, r.h, _q8(bg) if bg else _q(P.UI_PANEL), border, col),
                     r.topleft)
        fill_w = int(r.w * frac)
        if fill_w <= 0:
            return
        fill = _bar_fill(r.w, r.h, col)
        surface.blit(fill, r.topleft, area=pygame.Rect(0, 0, fill_w, r.h))
        # Leading edge: a soft bloom that breathes, so the bar never looks dead.
        breathe = 0.55 + 0.25 * pulse(pygame.time.get_ticks() * 0.004, 2.2)
        _blit_glow(surface, r.x + fill_w, r.centery, r.h * 1.5, col, breathe)
    except Exception:
        pass


# --------------------------------------------------------------------------
# Button
# --------------------------------------------------------------------------
_STYLES = ("primary", "ghost", "danger", "tile")


def _button_palette(style: str, theme: P.Theme, hot: bool,
                    enabled: bool) -> Tuple[RGB, RGB, int, int]:
    """-> (edge colour, text colour, body alpha, border width)."""
    accent = _q(getattr(theme, "accent", P.UI_WHITE))
    accent2 = _q(getattr(theme, "accent2", P.UI_WHITE))
    text = _q(getattr(theme, "text", P.UI_WHITE))
    dim = _q(getattr(theme, "text_dim", P.UI_DIM))

    if style == "danger":
        edge, txt, alpha = P.UI_BAD, (P.UI_WHITE if hot else P.lerp_color(P.UI_BAD, P.UI_WHITE, 0.5)), 220
    elif style == "ghost":
        edge, txt, alpha = (accent if hot else dim), (text if hot else dim), 120
    elif style == "tile":
        edge, txt, alpha = (accent if hot else accent2), (text if hot else P.lerp_color(text, dim, 0.5)), 225
    else:  # primary
        edge, txt, alpha = (P.lerp_color(accent, P.UI_WHITE, 0.35) if hot else accent), text, 215

    if not enabled:
        edge = P.shade(edge, 0.35)
        txt = P.shade(txt, 0.45)
        alpha = int(alpha * 0.7)
    return _q(edge), _q(txt), alpha, (3 if hot else 2)


def _button_body(w: int, h: int, style: str, theme: P.Theme, hot: bool,
                 enabled: bool) -> pygame.Surface:
    """Cached body art.  Hover is a cross-fade between the cold and hot copy."""
    key = ("btn", w, h, style, hot, enabled,
           _q(theme.accent), _q(theme.accent2), _q(theme.text))
    surf = _MISC_CACHE.get(key)
    if surf is not None:
        return surf

    edge, _txt, alpha, bw = _button_palette(style, theme, hot, enabled)
    corner = C.UI_CORNER + (6 if style == "tile" else 0)
    surf = _panel_surface(w, h, alpha, False, edge, corner).copy()
    pygame.draw.rect(surf, P.with_alpha(edge, 235 if hot else 150),
                     (0, 0, w, h), bw, border_radius=corner)

    if style == "tile":
        # A thick accent shoulder along the top of the card.
        bar = pygame.Surface((w, 6), pygame.SRCALPHA)
        for x in range(w):
            f = x / max(1, w - 1)
            pygame.draw.line(bar, P.with_alpha(P.lerp_color(edge, _q(theme.accent2), f),
                                               230 if hot else 130), (x, 0), (x, 6))
        surf.blit(bar, (0, 2), area=pygame.Rect(int(corner * 0.5), 0, w - corner, 6))
    if hot:
        # Inner rim light: sells the "lifted off the page" feel.
        pygame.draw.rect(surf, P.with_alpha(P.lerp_color(edge, P.UI_WHITE, 0.6), 70),
                         (bw + 1, bw + 1, w - bw * 2 - 2, h - bw * 2 - 2), 1,
                         border_radius=max(2, corner - bw))
    return _store(_MISC_CACHE, key, surf)


class Button:
    """
    A mouse-driven button that feels alive.

    Hover lifts the card a few pixels and swells its glow; pressing scales it
    in.  A click is only reported when the press *and* the release both land
    inside the rect, so dragging off a button safely cancels it.
    """

    def __init__(self, rect: Any, label: str, *, font: Optional[pygame.font.Font] = None,
                 icon: Any = None, style: str = "primary", enabled: bool = True,
                 data: Any = None) -> None:
        self.rect: pygame.Rect = _rect(rect)
        self.label: str = str(label)
        self.font = font
        self.icon = icon
        self.style: str = style if style in _STYLES else "primary"
        self.enabled: bool = bool(enabled)
        self.data: Any = data

        self.hovered: bool = False
        self.just_entered: bool = False     # true for one frame - hook up "hover" sfx
        self._hover_t: float = 0.0          # 0..1 animation weight
        self._press_t: float = 0.0
        self._armed: bool = False           # mouse went down inside us
        self._cool: float = 0.0             # C.UI_CLICK_COOLDOWN debounce
        self._flash: float = 0.0

    # -- state -------------------------------------------------------------
    def set_enabled(self, value: bool) -> None:
        self.enabled = bool(value)
        if not self.enabled:
            self._armed = False
            self.hovered = False

    def update(self, dt: float, mouse_pos: Tuple[float, float]) -> None:
        try:
            dt = clamp(float(dt), 0.0, 0.1)
            was = self.hovered
            inside = self.rect.collidepoint(int(mouse_pos[0]), int(mouse_pos[1]))
            self.hovered = bool(inside and self.enabled)
            self.just_entered = self.hovered and not was

            # Exponential approach: frame-rate independent and never overshoots.
            k_hover = 1.0 - math.exp(-13.0 * dt)
            self._hover_t += ((1.0 if self.hovered else 0.0) - self._hover_t) * k_hover
            target_press = 1.0 if (self._armed and self.hovered) else 0.0
            self._press_t += (target_press - self._press_t) * (1.0 - math.exp(-22.0 * dt))
            self._flash = max(0.0, self._flash - dt * 3.2)
            self._cool = max(0.0, self._cool - dt)
        except Exception:
            pass

    def handle_event(self, event: Any) -> bool:
        """Returns True exactly once per completed click."""
        try:
            etype = getattr(event, "type", None)
            if etype == pygame.MOUSEMOTION:
                self.hovered = self.enabled and self.rect.collidepoint(event.pos)
                return False
            if etype == pygame.MOUSEBUTTONDOWN and getattr(event, "button", 0) == 1:
                if self.enabled and self.rect.collidepoint(event.pos):
                    self._armed = True
                    self.hovered = True
                return False
            if etype == pygame.MOUSEBUTTONUP and getattr(event, "button", 0) == 1:
                armed, self._armed = self._armed, False
                if armed and self.enabled and self.rect.collidepoint(event.pos) \
                        and self._cool <= 0.0:
                    self._cool = C.UI_CLICK_COOLDOWN
                    self._flash = 1.0
                    return True
        except Exception:
            self._armed = False
        return False

    # -- drawing -----------------------------------------------------------
    def _label_font(self, fonts: Any) -> pygame.font.Font:
        if isinstance(self.font, pygame.font.Font):
            return self.font
        if self.style == "tile":
            return _font(fonts, "small", 17)
        if self.style == "ghost":
            return _font(fonts, "body", 21)
        return _font(fonts, "h2", 30, True)

    def draw(self, surface: pygame.Surface, theme: P.Theme, fonts: Any, t: float) -> None:
        try:
            hov = clamp(self._hover_t, 0.0, 1.0)
            press = clamp(self._press_t, 0.0, 1.0)
            # Hover lifts and grows; the press squashes it back in.
            scale = 1.0 + 0.035 * hov - 0.055 * press
            lift = -3.0 * hov + 2.0 * press

            w, h = self.rect.w, self.rect.h
            dw, dh = max(4, int(w * scale)), max(4, int(h * scale))
            cx, cy = self.rect.centerx, self.rect.centery + lift
            dst = pygame.Rect(0, 0, dw, dh)
            dst.center = (int(cx), int(cy))

            accent = _q(getattr(theme, "accent", P.UI_WHITE))
            glow_col = P.UI_BAD if self.style == "danger" else accent
            if self.enabled:
                # Idle shimmer keeps even unhovered buttons breathing.
                idle = 0.10 + 0.05 * pulse(t * 1.6 + self.rect.x * 0.01)
                power = idle + 0.85 * hov + 0.5 * self._flash
                g = _rrect_glow(w, h, C.UI_CORNER, glow_col, 18, round(power, 1))
                surface.blit(g, (dst.x - 18, dst.y - 18), special_flags=pygame.BLEND_RGB_ADD)

            cold = _button_body(w, h, self.style, theme, False, self.enabled)
            hot = _button_body(w, h, self.style, theme, True, self.enabled)
            if abs(scale - 1.0) > 0.015:
                cold = pygame.transform.smoothscale(cold, (dw, dh))
                hot = pygame.transform.smoothscale(hot, (dw, dh))
            surface.blit(cold, dst.topleft)
            if hov > 0.01:
                hot.set_alpha(int(255 * hov))
                surface.blit(hot, dst.topleft)
                hot.set_alpha(255)

            self._draw_content(surface, dst, theme, fonts, hov, scale, t)
        except Exception:
            pass

    def _draw_content(self, surface: pygame.Surface, dst: pygame.Rect, theme: P.Theme,
                      fonts: Any, hov: float, scale: float, t: float) -> None:
        font = self._label_font(fonts)
        _e, cold_col, _a, _b = _button_palette(self.style, theme, False, self.enabled)
        _e, hot_col, _a, _b = _button_palette(self.style, theme, True, self.enabled)

        label_y = dst.centery
        if self.style == "tile":
            # Icon lives in the middle of the card, label along the bottom.
            label_y = dst.bottom - 26
            self._draw_icon(surface, dst.centerx, dst.centery - 8, theme, fonts, hov, t)
        elif self.icon is not None:
            self._draw_icon(surface, dst.x + 26, dst.centery, theme, fonts, hov, t)

        cold_txt, cold_sh = _text_pair(self.label, font, cold_col)
        hot_txt, _hot_sh = _text_pair(self.label, font, hot_col)
        if abs(scale - 1.0) > 0.015:
            try:
                cold_txt = pygame.transform.rotozoom(cold_txt, 0.0, scale)
                cold_sh = pygame.transform.rotozoom(cold_sh, 0.0, scale)
                hot_txt = pygame.transform.rotozoom(hot_txt, 0.0, scale)
            except Exception:
                pass
        tx = dst.centerx - cold_txt.get_width() // 2
        ty = int(label_y - cold_txt.get_height() * 0.5)
        cold_sh.set_alpha(150)
        surface.blit(cold_sh, (tx + 2, ty + 2))
        surface.blit(cold_txt, (tx, ty))
        if hov > 0.01:
            hot_txt.set_alpha(int(255 * hov))
            surface.blit(hot_txt, (tx, ty))
            hot_txt.set_alpha(255)

    def _draw_icon(self, surface: pygame.Surface, cx: float, cy: float, theme: P.Theme,
                   fonts: Any, hov: float, t: float) -> None:
        icon = self.icon
        if icon is None:
            return
        if isinstance(icon, pygame.Surface):
            r = icon.get_rect(center=(int(cx), int(cy)))
            surface.blit(icon, r.topleft)
            return
        col = _q(theme.accent) if self.enabled else P.shade(_q(theme.accent), 0.4)
        if self.enabled:
            _blit_glow(surface, cx, cy, 26, col, 0.25 + 0.45 * hov)
        big = _font(fonts, "h1", 42) if self.style == "tile" else _font(fonts, "h2", 30, True)
        draw_text(surface, str(icon), big, P.lerp_color(col, P.UI_WHITE, 0.35 + 0.4 * hov),
                  (cx, cy - big.get_height() * 0.5), align="center")


# --------------------------------------------------------------------------
# Cursor
# --------------------------------------------------------------------------
def draw_cursor(surface: pygame.Surface, game: "Game") -> None:
    """Glowing reticle: comet trail, rotating outer ring, bright centre dot."""
    try:
        t = float(getattr(game, "time", 0.0))
        theme = P.theme_for_level(int(getattr(game, "level_index", 0)))
        accent = _q(theme.accent)
        accent2 = _q(theme.accent2)
        mx, my = getattr(game, "mouse_pos", (C.WINDOW_W * 0.5, C.WINDOW_H * 0.5))

        # ---- comet trail (oldest first in game.cursor_trail) --------------
        trail: List[Tuple[float, float]] = list(getattr(game, "cursor_trail", ()) or ())
        n = len(trail)
        if n >= 2:
            for i in range(n - 1):
                f = (i + 1) / (n - 1)            # 0 at the oldest point
                if f < 0.08:
                    continue
                a, b = trail[i], trail[i + 1]
                col = P.lerp_color(accent2, accent, f)
                pygame.draw.line(surface, P.shade(col, 0.25 + 0.65 * f * f),
                                 (int(a[0]), int(a[1])), (int(b[0]), int(b[1])),
                                 max(1, int(1 + 4 * f)))
                # Additive dabs make the streak thicken and brighten toward the head.
                _blit_glow(surface, b[0], b[1], 4 + 9 * f, col, 0.18 + 0.5 * f * f)

        # ---- reticle -------------------------------------------------------
        held = False
        try:
            held = bool(getattr(game, "mouse_buttons", {}).get(1))
        except Exception:
            held = False
        base_r = 15.0 - (3.5 if held else 0.0) + 1.2 * pulse(t, 3.0)
        bright = 1.0 if held else 0.72

        _blit_glow(surface, mx, my, 22, accent, 0.45 * bright)

        # Three ticks sweeping around the outside, plus a faint full ring.
        spin = t * 1.35
        ring = pygame.Rect(0, 0, int(base_r * 2), int(base_r * 2))
        ring.center = (int(mx), int(my))
        for k in range(3):
            a0 = spin + k * (TAU / 3.0)
            try:
                pygame.draw.arc(surface, P.lerp_color(accent, P.UI_WHITE, 0.25 * bright),
                                ring, a0, a0 + 0.85, 2)
            except Exception:
                break
        inner = pygame.Rect(0, 0, int(base_r * 1.1), int(base_r * 1.1))
        inner.center = (int(mx), int(my))
        try:
            pygame.draw.arc(surface, P.shade(accent2, 0.6), inner, -spin * 0.7,
                            -spin * 0.7 + TAU * 0.999, 1)
        except Exception:
            pass

        # Four crosshair spurs along the axes.
        for k in range(4):
            ang = spin * -0.5 + k * (math.pi * 0.5)
            ca, sa = math.cos(ang), math.sin(ang)
            r0, r1 = base_r + 3.0, base_r + 8.0
            pygame.draw.line(surface, P.shade(accent, 0.75),
                             (int(mx + ca * r0), int(my + sa * r0)),
                             (int(mx + ca * r1), int(my + sa * r1)), 1)

        _blit_glow(surface, mx, my, 7, P.lerp_color(accent, P.UI_WHITE, 0.7), 1.1 * bright)
        pygame.draw.circle(surface, P.UI_WHITE, (int(mx), int(my)), 2)
    except Exception:
        pass


# --------------------------------------------------------------------------
# HUD
# --------------------------------------------------------------------------
# Power-up presentation.  The real table lives in core.powerups, but the HUD
# must never hard-depend on it, so we merge over a local fallback.
_PU_FALLBACK: Dict[str, Dict[str, Any]] = {
    "magnet": {"name": "MAGNET", "color": (120, 200, 255), "duration": C.POWERUP_DEFAULT_DURATION},
    "shield": {"name": "SHIELD", "color": (96, 240, 255), "duration": C.POWERUP_DEFAULT_DURATION},
    "slow":   {"name": "SLOW",   "color": (170, 150, 255), "duration": C.POWERUP_DEFAULT_DURATION},
    "double": {"name": "DOUBLE", "color": P.UI_GOLD,       "duration": C.POWERUP_DEFAULT_DURATION},
    "ghost":  {"name": "GHOST",  "color": (210, 220, 255), "duration": C.POWERUP_DEFAULT_DURATION},
    "frenzy": {"name": "FRENZY", "color": (255, 120, 90),  "duration": C.POWERUP_DEFAULT_DURATION},
}
_PU_TYPES: Optional[Dict[str, Dict[str, Any]]] = None


def _powerup_types() -> Dict[str, Dict[str, Any]]:
    global _PU_TYPES
    if _PU_TYPES is None:
        merged = {k: dict(v) for k, v in _PU_FALLBACK.items()}
        try:
            from ..core.powerups import POWERUP_TYPES  # local import: avoids a hard dep
            for k, v in POWERUP_TYPES.items():
                merged.setdefault(k, {}).update(dict(v))
        except Exception:
            pass
        _PU_TYPES = merged
    return _PU_TYPES


class _HudAnim:
    """Per-Game animation memory for the HUD (odometer, pops, flashes)."""

    __slots__ = ("score_disp", "digits", "rolls", "combo_pop", "prev_combo",
                 "food_pop", "prev_food", "life_pop", "prev_lives", "last_t", "score_hit")

    def __init__(self) -> None:
        self.score_disp: float = 0.0
        self.digits: str = ""
        self.rolls: List[float] = []
        self.combo_pop: float = 0.0
        self.prev_combo: int = 0
        self.food_pop: float = 0.0
        self.prev_food: int = 0
        self.life_pop: float = 0.0
        self.prev_lives: int = -1
        self.last_t: float = 0.0
        self.score_hit: float = 0.0


_HUD_ANIM: "weakref.WeakKeyDictionary[Any, _HudAnim]" = weakref.WeakKeyDictionary()
_HUD_ANIM_FALLBACK: Dict[int, _HudAnim] = {}


def _hud_anim(game: Any) -> _HudAnim:
    try:
        anim = _HUD_ANIM.get(game)
        if anim is None:
            anim = _HudAnim()
            _HUD_ANIM[game] = anim
        return anim
    except TypeError:                     # unhashable / no weakref support
        anim = _HUD_ANIM_FALLBACK.get(id(game))
        if anim is None:
            anim = _HudAnim()
            _HUD_ANIM_FALLBACK[id(game)] = anim
        return anim


def _hud_backdrop(theme: P.Theme) -> pygame.Surface:
    """The translucent strip behind the HUD, with its glowing bottom edge."""
    w, h = C.WINDOW_W, C.HUD_H
    key = ("hud", w, h, _q(theme.accent), _q(theme.accent2))
    surf = _MISC_CACHE.get(key)
    if surf is not None:
        return surf

    surf = pygame.Surface((w, h), pygame.SRCALPHA)
    for y in range(h):
        f = y / max(1, h - 1)
        c = P.lerp_color(P.UI_PANEL_LIGHT, P.UI_PANEL, f ** 0.6)
        pygame.draw.line(surf, P.with_alpha(c, int(236 - 40 * f)), (0, y), (w, y))

    # Column separators, baked in so they cost nothing per frame.
    for x in (256, 618, 880):
        pygame.draw.line(surf, P.with_alpha(theme.grid, 120), (x, 16), (x, h - 16))

    # Bottom edge: an accent line with a few rows of pre-baked bloom above it.
    for i in range(9):
        a = int(120 * (1.0 - i / 9.0) ** 2.0)
        c = P.lerp_color(_q(theme.accent), _q(theme.accent2), i / 9.0)
        pygame.draw.line(surf, P.with_alpha(c, a), (0, h - 3 - i), (w, h - 3 - i))
    pygame.draw.line(surf, P.with_alpha(P.lerp_color(theme.accent, P.UI_WHITE, 0.3), 235),
                     (0, h - 2), (w, h - 2), 2)
    return _store(_MISC_CACHE, key, surf)


_ADVANCE_CACHE: Dict[int, int] = {}


def _digit_advance(font: pygame.font.Font) -> int:
    """Widest digit, so a changing score never makes the layout jitter."""
    key = id(font)
    cached = _ADVANCE_CACHE.get(key)
    if cached is not None:
        return cached
    adv = 18
    try:
        adv = max(font.size(d)[0] for d in "0123456789")
    except Exception:
        pass
    adv = max(4, int(adv))
    if len(_ADVANCE_CACHE) >= _CACHE_LIMIT:
        _ADVANCE_CACHE.clear()
    _ADVANCE_CACHE[key] = adv
    return adv


def _draw_odometer(surface: pygame.Surface, x: int, y: int, value: int, anim: _HudAnim,
                   font: pygame.font.Font, color: Sequence[int], dt: float) -> int:
    """
    Score readout with mechanical-counter feel.

    Each character that changed slides down into place and fades in, and the
    whole number carries a bloom that spikes when points land.
    """
    text = f"{value:,}"
    if len(text) != len(anim.digits):
        anim.rolls = [0.0] * len(text)
        anim.digits = " " * len(text)
    while len(anim.rolls) < len(text):
        anim.rolls.append(0.0)
    for i, ch in enumerate(text):
        if i < len(anim.digits) and anim.digits[i] != ch:
            anim.rolls[i] = 1.0
    anim.digits = text
    adv = _digit_advance(font)

    cx = x
    for i, ch in enumerate(text):
        roll = anim.rolls[i] = max(0.0, anim.rolls[i] - dt * 4.2)
        step = adv if ch.isdigit() else max(4, adv // 2)
        body, sil = _text_pair(ch, font, color)
        # Slide in from above.  The travel is deliberately short: any further
        # and a rolling digit would climb into the "SCORE" caption above it.
        oy = int(-roll * font.get_height() * 0.22)
        px = cx + (step - body.get_width()) // 2
        sil.set_alpha(int(150 * (1.0 - roll * 0.7)))
        surface.blit(sil, (px + 2, y + oy + 2))
        body.set_alpha(int(255 * (1.0 - roll * 0.55)))
        surface.blit(body, (px, y + oy))
        # Cached surfaces are shared, so hand them back at their resting alpha.
        body.set_alpha(255)
        sil.set_alpha(150)
        cx += step
    return cx - x


def _draw_life_icon(surface: pygame.Surface, cx: float, cy: float, theme: P.Theme,
                    alive: bool, t: float, phase: float, pop: float) -> None:
    """A four-segment mini snake; spent lives are drawn as dim ghosts."""
    s = 1.0 + 0.35 * pop
    for i in range(4):
        f = i / 3.0
        px = cx + (1.5 - i) * 5.6 * s
        py = cy + math.sin(t * 3.4 + phase - i * 0.8) * 2.2 * s
        rad = (5.2 - 2.4 * f) * s
        col = _q(theme.snake_head) if i == 0 else theme.body_at(f)
        if not alive:
            col = P.shade(P.lerp_color(col, P.UI_DIM, 0.8), 0.30)
        elif i == 0:
            _blit_glow(surface, px, py, rad * 2.6, col, 0.35 + 0.3 * pop)
        pygame.draw.circle(surface, col, (int(px), int(py)), max(1, int(rad)))
    if alive:
        # Eye dot, so the head reads as a head at 10 px.
        pygame.draw.circle(surface, P.UI_PANEL, (int(cx + 6.4 * s), int(cy - 1)), 1)


def _draw_effect_icon(surface: pygame.Surface, kind: str, cx: float, cy: float,
                      r: float, col: RGB, fonts: Any, t: float) -> None:
    """Tiny vector glyphs - no font dependency, so nothing can go missing."""
    ix, iy = int(cx), int(cy)
    try:
        if kind == "shield":
            pts = [(0, -r), (r * 0.92, -r * 0.42), (r * 0.6, r * 0.85),
                   (0, r), (-r * 0.6, r * 0.85), (-r * 0.92, -r * 0.42)]
            pygame.draw.polygon(surface, col, [(ix + px, iy + py) for px, py in pts], 2)
        elif kind == "magnet":
            box = pygame.Rect(0, 0, int(r * 2), int(r * 2))
            box.center = (ix, iy + int(r * 0.3))
            pygame.draw.arc(surface, col, box, 0.0, math.pi, max(2, int(r * 0.4)))
            for sx in (-1, 1):
                x0 = ix + int(sx * r * 0.78)
                pygame.draw.line(surface, col, (x0, iy + int(r * 0.3)),
                                 (x0, iy + int(r * 0.95)), max(2, int(r * 0.4)))
        elif kind == "slow":
            pygame.draw.circle(surface, col, (ix, iy), int(r), 2)
            pygame.draw.line(surface, col, (ix, iy), (ix, iy - int(r * 0.62)), 2)
            pygame.draw.line(surface, col, (ix, iy), (ix + int(r * 0.5), iy), 2)
        elif kind == "double":
            draw_text(surface, "x2", _font(fonts, "tiny", 14), col,
                      (ix, iy - r * 0.95), align="center", shadow=False)
        elif kind == "ghost":
            pygame.draw.circle(surface, col, (ix, iy - int(r * 0.15)), int(r * 0.8), 2)
            pts = [(-r * 0.8, 0), (-r * 0.8, r * 0.6), (-r * 0.35, r * 0.25),
                   (0, r * 0.6), (r * 0.35, r * 0.25), (r * 0.8, r * 0.6), (r * 0.8, 0)]
            pygame.draw.lines(surface, col, False,
                              [(ix + px, iy + py) for px, py in pts], 2)
        elif kind == "frenzy":
            pts = [(r * 0.25, -r), (-r * 0.55, r * 0.15), (-r * 0.05, r * 0.15),
                   (-r * 0.3, r), (r * 0.6, -r * 0.2), (r * 0.05, -r * 0.2)]
            pygame.draw.polygon(surface, col, [(ix + px, iy + py) for px, py in pts])
        else:
            pygame.draw.circle(surface, col, (ix, iy), max(2, int(r * 0.6)), 2)
    except Exception:
        pass


def _chip_bg(size: int, col: RGB) -> pygame.Surface:
    key = ("chip", size, col)
    surf = _MISC_CACHE.get(key)
    if surf is not None:
        return surf
    surf = pygame.Surface((size, size), pygame.SRCALPHA)
    pygame.draw.rect(surf, P.with_alpha(P.UI_PANEL, 225), (0, 0, size, size), border_radius=8)
    pygame.draw.rect(surf, P.with_alpha(col, 150), (0, 0, size, size), 1, border_radius=8)
    return _store(_MISC_CACHE, key, surf)


def _draw_effect_chip(surface: pygame.Surface, cx: float, cy: float, kind: str,
                      remaining: float, theme: P.Theme, fonts: Any, t: float) -> None:
    info = _powerup_types().get(kind, {})
    col = _q(info.get("color") or theme.accent2)
    dur = float(info.get("duration") or C.POWERUP_DEFAULT_DURATION) or 1.0
    frac = clamp(remaining / dur, 0.0, 1.0)

    # Under two seconds the chip strobes so the loss never feels arbitrary.
    urgent = remaining <= 2.0
    beat = (0.5 + 0.5 * pulse(t, 16.0)) if urgent else 1.0
    size = 26
    _blit_glow(surface, cx, cy, size, col, (0.30 + 0.30 * pulse(t, 2.4)) * beat)
    bg = _chip_bg(size, col)
    surface.blit(bg, (int(cx - size * 0.5), int(cy - size * 0.5)))
    _draw_effect_icon(surface, kind, cx, cy, size * 0.30,
                      P.lerp_color(col, P.UI_WHITE, 0.35 * beat), fonts, t)

    # Countdown ring: dots stepping clockwise from 12 o'clock (screen y is down,
    # so increasing the angle already runs clockwise).
    ring_r = size * 0.5 + 4.0
    segs = 24
    lit = int(round(segs * frac))
    for i in range(segs):
        ang = -math.pi * 0.5 + TAU * (i / segs)
        px, py = cx + math.cos(ang) * ring_r, cy + math.sin(ang) * ring_r
        if i < lit:
            pygame.draw.circle(surface, P.lerp_color(col, P.UI_WHITE, 0.25 * beat),
                               (int(px), int(py)), 2)
        else:
            pygame.draw.circle(surface, P.shade(col, 0.22), (int(px), int(py)), 1)
    if lit:
        ang = -math.pi * 0.5 + TAU * (lit / segs)
        _blit_glow(surface, cx + math.cos(ang) * ring_r, cy + math.sin(ang) * ring_r,
                   7, col, 0.8 * beat)


def _draw_combo(surface: pygame.Surface, cx: float, cy: float, combo: int,
                anim: _HudAnim, theme: P.Theme, fonts: Any, t: float) -> None:
    """Badge that physically pops each time the chain extends."""
    steps = max(1, int(C.COMBO_MAX))
    heat = clamp(combo / steps, 0.0, 1.0)
    col = P.rainbow(t * 0.6) if combo >= steps else P.lerp_color(_q(theme.accent), P.UI_GOLD, heat)
    pop = clamp(anim.combo_pop, 0.0, 1.0)
    # ease_out_back overshoots, which is exactly the "snap" a combo wants.
    scale = 1.0 + 0.45 * ease_out_back(pop)

    _blit_glow(surface, cx, cy, 26 * scale, col, 0.35 + 0.55 * heat + 0.5 * pop)
    pygame.draw.circle(surface, P.UI_PANEL, (int(cx), int(cy)), int(17 * scale))
    pygame.draw.circle(surface, col, (int(cx), int(cy)), int(17 * scale), 2)

    # Pips around the badge count the chain toward COMBO_MAX.
    for i in range(steps):
        ang = -math.pi * 0.5 + TAU * (i / steps)
        px, py = cx + math.cos(ang) * 24.0, cy + math.sin(ang) * 24.0
        on = i < combo
        pygame.draw.circle(surface, col if on else P.shade(col, 0.20),
                           (int(px), int(py)), 2 if on else 1)

    body, _sil = _text_pair(f"x{combo}", _font(fonts, "h2", 26, True),
                            P.lerp_color(col, P.UI_WHITE, 0.45))
    if abs(scale - 1.0) > 0.02:
        try:
            body = pygame.transform.rotozoom(body, 0.0, scale)
        except Exception:
            pass
    surface.blit(body, (int(cx - body.get_width() * 0.5), int(cy - body.get_height() * 0.5)))


def draw_hud(surface: pygame.Surface, game: "Game", state: Dict[str, Any],
             theme: P.Theme, t: float) -> None:
    """
    Draw the top strip: score odometer, level, goal progress, lives, combo,
    boost stamina and the active power-up chips.

    `state` keys: score, highscore, level_name, level_index, goal_food,
    food_eaten, lives, combo, boost, boost_max, effects.

    Everything is confined to the strip `(0, 0, C.WINDOW_W, C.HUD_H)`.  The
    bloom under the strip and the chip halos are additive and would otherwise
    reach ~100 px down into the play field, brightening the top of the arena;
    a clip rect keeps the HUD and the arena strictly disjoint so the two can be
    drawn in either order.
    """
    prev_clip = None
    try:
        prev_clip = surface.get_clip()
        strip = pygame.Rect(0, 0, C.WINDOW_W, C.HUD_H)
        if prev_clip is not None:
            strip = strip.clip(prev_clip)
        surface.set_clip(strip)
        _draw_hud_impl(surface, game, state or {}, theme, t)
    except Exception:
        pass
    finally:
        try:
            surface.set_clip(prev_clip)
        except Exception:
            pass


def _draw_hud_impl(surface: pygame.Surface, game: Any, state: Dict[str, Any],
                   theme: P.Theme, t: float) -> None:
    fonts = getattr(game, "fonts", None)
    anim = _hud_anim(game)
    dt = clamp(t - anim.last_t, 0.0, 0.1)
    anim.last_t = t

    def num(key: str, default: float = 0.0) -> float:
        try:
            v = state.get(key, default)
            return float(v) if v is not None else float(default)
        except Exception:
            return float(default)

    score = int(num("score"))
    highscore = int(num("highscore"))
    goal = max(1, int(num("goal_food", 1)))
    eaten = int(num("food_eaten"))
    lives = int(num("lives", C.START_LIVES))
    combo = int(num("combo"))
    boost = num("boost")
    boost_max = max(1.0, num("boost_max", C.SNAKE_BOOST_MAX))
    level_index = int(num("level_index"))
    level_name = str(state.get("level_name", getattr(theme, "name", "")) or "")
    accent = _q(theme.accent)
    accent2 = _q(theme.accent2)
    dim = _q(theme.text_dim)

    # ---- animation bookkeeping ------------------------------------------
    # "Heat" builds while the counter is chasing a gain and cools afterwards.
    if score > anim.score_disp + 0.5:
        anim.score_hit = min(1.0, anim.score_hit + dt * 4.0)
    # Exponential chase gives the counter its spin-up / settle behaviour.
    anim.score_disp += (score - anim.score_disp) * (1.0 - math.exp(-11.0 * dt))
    if abs(score - anim.score_disp) < 0.6:
        anim.score_disp = float(score)
    anim.score_hit = max(0.0, anim.score_hit - dt * 2.2)
    if combo > anim.prev_combo:
        anim.combo_pop = 1.0
    anim.prev_combo = combo
    anim.combo_pop = max(0.0, anim.combo_pop - dt * 3.0)
    if eaten > anim.prev_food:
        anim.food_pop = 1.0
    anim.prev_food = eaten
    anim.food_pop = max(0.0, anim.food_pop - dt * 2.6)
    if anim.prev_lives >= 0 and lives != anim.prev_lives:
        anim.life_pop = 1.0
    anim.prev_lives = lives
    anim.life_pop = max(0.0, anim.life_pop - dt * 2.4)

    surface.blit(_hud_backdrop(theme), (0, 0))

    f_tiny = _font(fonts, "tiny", 14)

    # ---- score ------------------------------------------------------------
    # Caption row and personal best share the top line; the odometer owns the
    # row below it, so a rolling digit can never collide with either.
    draw_text(surface, "SCORE", f_tiny, dim, (20, 6))
    draw_text(surface, f"BEST {max(highscore, score):,}", f_tiny, P.shade(dim, 0.85),
              (250, 6), align="right")
    big = _font(fonts, "display", 34)
    shown = int(anim.score_disp + 0.5)
    if anim.score_hit > 0.01:
        _blit_glow(surface, 96, 46, 62, P.UI_GOLD, 0.20 + 0.5 * anim.score_hit)
    _draw_odometer(surface, 20, 28, shown, anim, big,
                   P.lerp_color(P.UI_WHITE, P.UI_GOLD,
                                _step(0.35 + 0.5 * anim.score_hit, 5)), dt)

    # ---- level + goal ------------------------------------------------------
    draw_text(surface, f"LVL {level_index + 1:02d}", f_tiny, accent2, (272, 5))
    draw_text(surface, level_name.upper(), _font(fonts, "ui", 24, True), _q(theme.text),
              (272, 22))
    bar = pygame.Rect(272, 58, 250, 9)
    goal_col = P.lerp_color(accent, P.UI_GOOD, _step(eaten / goal, 8))
    if anim.food_pop > 0.01:
        goal_col = P.lerp_color(goal_col, P.UI_WHITE, _step(anim.food_pop * 0.8, 4))
    draw_bar(surface, bar, eaten / goal, goal_col)
    draw_text(surface, f"{min(eaten, goal)} / {goal}", f_tiny,
              P.lerp_color(dim, P.UI_WHITE, _step(0.35 + 0.5 * anim.food_pop, 4)), (532, 53))

    # ---- lives -------------------------------------------------------------
    draw_text(surface, "LIVES", f_tiny, dim, (636, 5))
    shown_lives = max(lives, 0)
    slots = max(C.START_LIVES, shown_lives)
    # The icon row has to stay clear of the combo badge at x=812, so it packs
    # tighter as lives are gained and spills into a "+n" once it runs out.
    max_icons = 6
    icons = min(slots, max_icons)
    span = 140.0
    pitch = min(34.0, span / max(1, icons))
    for i in range(icons):
        alive = i < shown_lives
        pop = anim.life_pop if i == shown_lives else 0.0
        _draw_life_icon(surface, 654 + i * pitch, 44, theme, alive, t, i * 1.7, pop)
    if slots > max_icons:
        draw_text(surface, f"+{slots - max_icons}", f_tiny, dim,
                  (658 + icons * pitch, 37))

    # ---- combo -------------------------------------------------------------
    if combo > 1:
        _draw_combo(surface, 812, 40, combo, anim, theme, fonts, t)
    else:
        draw_text(surface, "COMBO", f_tiny, P.shade(dim, 0.7), (812, 33), align="center")

    # ---- boost stamina -----------------------------------------------------
    frac = clamp(boost / boost_max, 0.0, 1.0)
    low = frac < (C.SNAKE_BOOST_MIN_TO_START / boost_max)
    boost_col = P.UI_BAD if low else P.lerp_color(P.UI_WARN, accent2, _step(frac, 6))
    label_col = P.lerp_color(dim, boost_col,
                             _step(0.5 + 0.5 * pulse(t, 6.0), 4) if low else 0.4)
    draw_text(surface, "BOOST", f_tiny, label_col, (900, 7))
    draw_bar(surface, pygame.Rect(958, 12, 222, 12), frac, boost_col)
    try:
        boosting = bool(getattr(game, "mouse_buttons", {}).get(3)) and frac > 0.0
    except Exception:
        boosting = False
    if boosting:
        _blit_glow(surface, 1069, 18, 90, boost_col, 0.35)

    # ---- power-up chips (right aligned, newest on the right) ---------------
    effects = state.get("effects") or ()
    try:
        eff_list = [(str(k), float(v)) for k, v in list(effects)[:6]]
    except Exception:
        eff_list = []
    if eff_list:
        pitch = 38
        right = C.WINDOW_W - 20
        start = right - pitch * len(eff_list) + pitch * 0.5
        for i, (kind, remaining) in enumerate(eff_list):
            _draw_effect_chip(surface, start + i * pitch, 50, kind, remaining, theme, fonts, t)
    else:
        draw_text(surface, "NO ACTIVE POWER-UPS", f_tiny, P.shade(dim, 0.6),
                  (C.WINDOW_W - 20, 45), align="right")

    # A thin bloom under the whole strip ties it to the arena border below.
    _blit_glow(surface, C.WINDOW_W * 0.5, C.HUD_H - 2, 150, accent, 0.10)
