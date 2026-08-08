"""
Post-processing and screen-feedback stack for NEON SERPENT.

The game renders everything onto an off-screen `canvas`; exactly once per frame
`EffectStack.present(canvas, screen)` copies that canvas to the real display and
layers the "feel" on top of it:

    1. trauma-based screen shake      (offset the whole frame, decays fast)
    2. chromatic aberration           (only while the shake is violent)
    3. colour flash                   (additive, decays at C.FLASH_DECAY)
    4. vignette                       (pre-rendered once)
    5. scanlines                      (pre-rendered once, baked into the vignette)
    6. scene transition wipe          (neon iris or diagonal sweep)

Design rules honoured here:

*   Every static overlay is built **once** in ``__init__`` and cached; the
    scratch buffers the shake and wipe need are allocated lazily and then
    reused forever.  Steady state allocates nothing per frame.
*   Blended *fills* are avoided everywhere.  In pygame 2.6 a
    ``fill(col, special_flags=BLEND_*)`` over 1280x720 costs ~8-9 ms, while the
    same operation as a blended *blit* from a cached solid surface costs
    ~0.3 ms.  That one substitution is the difference between this stack
    eating half the frame budget and eating none of it.
*   ``present`` repaints every pixel of the screen every frame, so the caller
    never has to clear the display.
*   Nothing in this module raises.  A failure anywhere in the post chain falls
    back to a plain blit of the canvas.

Slow motion lives here too, because it is screen feedback rather than
simulation: the game loop asks ``time_scale()`` and scales its own dt.
"""

from __future__ import annotations

import math
import random
from typing import List, Optional, Tuple

import pygame

from .. import config as C
from .. import palette as P
from ..core.contracts import clamp, ease_in_out_cubic, ease_out_cubic, lerp

RGB = Tuple[int, int, int]
Vec2i = Tuple[int, int]

# --------------------------------------------------------------------------
# Tuning that belongs to the post chain alone (everything gameplay-facing
# lives in config.py).
# --------------------------------------------------------------------------
SHAKE_MAX = 26.0            # hard ceiling on the shake amplitude, pixels
SHAKE_CUTOFF = 0.15         # sub-pixel: snap to zero so the shake truly ends
FLASH_MAX = 1.25            # ceiling on accumulated flash strength

ABERRATION_START = 3.2      # shake amplitude where the RGB split switches on
ABERRATION_FULL = 15.0      # ... and where it reaches full strength
ABERRATION_MAX_PX = 5.0     # maximum channel offset in pixels
ABERRATION_MASK_MIN = 62    # channel-tint strength at the faintest split
ABERRATION_MASK_MAX = 118   # ... and at the strongest

VIGNETTE_TINT: RGB = (2, 3, 9)
VIGNETTE_STRENGTH = 0.80    # peak alpha at the very corners, 0..1
VIGNETTE_INNER = 0.44       # normalised radius where the darkening starts
VIGNETTE_LOD = (160, 90)    # the vignette is computed small and upscaled

SCANLINE_GAP = 3            # one dark line every N rows
SCANLINE_ALPHA = 15         # very subtle - it should read as texture, not stripes

TRANSITION_BAND = 190.0     # thickness of the glowing edge on a sweep wipe
FIELD: RGB = (3, 4, 10)     # the "blanked out" colour a wipe covers with
FIELD_RGBA = (FIELD[0], FIELD[1], FIELD[2], 255)
_TRANSITION_STYLES = ("iris", "sweep")


# ==========================================================================
# Small maths helpers
# ==========================================================================
def _noise1(t: float, seed: float) -> float:
    """
    Cheap smooth pseudo-noise in -1..1.

    Three sines at incommensurate frequencies sum to something that never
    repeats on a human timescale and, unlike ``random()`` per frame, is
    *continuous* - which is what makes a shake read as a camera being knocked
    rather than as pixel static.  The weights add up to 1.0 so the result is
    guaranteed to stay inside -1..1.
    """
    return (
        math.sin(t * 1.000 + seed) * 0.55
        + math.sin(t * 2.370 + seed * 1.7) * 0.30
        + math.sin(t * 4.110 + seed * 3.1) * 0.15
    )


def _field_blend(color: RGB, alpha: float) -> "P.RGBA":
    """
    Pre-blend `color` at `alpha` against the wipe's dark field, then return it
    fully opaque.

    This exists because `pygame.draw.*` *writes* RGBA into a surface instead of
    compositing it.  Drawing a soft alpha-34 glow stroke over the opaque wipe
    field would therefore not lighten it - it would replace those pixels with
    93%-transparent ones and let the scene underneath show straight through the
    wipe.  Blending by hand and drawing at alpha 255 gives the identical look
    with no hole.
    """
    return P.with_alpha(P.lerp_color(FIELD, color, clamp(alpha, 0.0, 255.0) / 255.0), 255)


def _smoothstep(edge0: float, edge1: float, x: float) -> float:
    """Classic Hermite smoothstep, guarded against a zero-width edge."""
    if edge1 <= edge0:
        return 0.0 if x < edge0 else 1.0
    t = clamp((x - edge0) / (edge1 - edge0), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def _decay(value: float, rate: float, dt: float) -> float:
    """
    Framerate-independent exponential decay.

    ``value * exp(-rate * dt)`` gives the same curve regardless of how the
    frame times fall, which a naive ``value -= rate * dt`` does not.
    """
    if value <= 0.0:
        return 0.0
    try:
        return value * math.exp(-rate * dt)
    except (OverflowError, ValueError):
        return 0.0


def _convert(surf: "pygame.Surface", alpha: bool = True) -> "pygame.Surface":
    """convert()/convert_alpha() when a display exists; identity otherwise."""
    try:
        if pygame.display.get_init() and pygame.display.get_surface() is not None:
            return surf.convert_alpha() if alpha else surf.convert()
    except pygame.error:
        pass
    return surf


# ==========================================================================
# Cached overlay builders (public: the menu/HUD may want the same vignette)
# ==========================================================================
def build_vignette(size: Vec2i,
                   color: RGB = VIGNETTE_TINT,
                   strength: float = VIGNETTE_STRENGTH,
                   inner: float = VIGNETTE_INNER) -> "pygame.Surface":
    """
    Pre-render a radial darkening overlay.

    The alpha ramp is evaluated on a tiny surface (VIGNETTE_LOD) and then
    smoothscaled up: a vignette is an extremely low-frequency function, so the
    upscale is visually identical to a full-resolution evaluation while costing
    a few thousand pixel writes instead of a million.
    """
    w, h = max(1, int(size[0])), max(1, int(size[1]))
    lw, lh = VIGNETTE_LOD
    small = pygame.Surface((lw, lh), pygame.SRCALPHA)
    peak = clamp(strength, 0.0, 1.0) * 255.0
    inv_w = 2.0 / max(1, lw - 1)
    inv_h = 2.0 / max(1, lh - 1)
    for y in range(lh):
        # Normalised -1..1 coordinates; /sqrt(2) puts the corners at r == 1.
        ny = y * inv_h - 1.0
        ny2 = ny * ny
        for x in range(lw):
            nx = x * inv_w - 1.0
            r = math.sqrt(nx * nx + ny2) * 0.70710678
            a = _smoothstep(inner, 1.0, r)
            # ^1.6 keeps the centre perfectly clean and bites hard at the rim.
            small.set_at((x, y), P.with_alpha(color, peak * (a ** 1.6)))
    try:
        big = pygame.transform.smoothscale(small, (w, h))
    except (pygame.error, ValueError):
        big = pygame.transform.scale(small, (w, h))
    return big


def build_scanlines(size: Vec2i,
                    gap: int = SCANLINE_GAP,
                    alpha: int = SCANLINE_ALPHA,
                    color: RGB = (0, 0, 0)) -> "pygame.Surface":
    """Pre-render one dark horizontal line every `gap` rows."""
    w, h = max(1, int(size[0])), max(1, int(size[1]))
    surf = pygame.Surface((w, h), pygame.SRCALPHA)
    gap = max(2, int(gap))
    line = P.with_alpha(color, P.clamp8(alpha))
    for y in range(0, h, gap):
        surf.fill(line, (0, y, w, 1))
    return surf


# ==========================================================================
# EffectStack
# ==========================================================================
class EffectStack:
    """Screen shake, flashes, slow motion, transitions and the post chain."""

    def __init__(self, size: Vec2i = C.WINDOW_SIZE) -> None:
        self.size: Vec2i = (int(size[0]), int(size[1]))

        # -- shake ---------------------------------------------------------
        self.shake_amount: float = 0.0          # current amplitude in pixels
        self._shake_seed: float = random.random() * 100.0
        self._time: float = 0.0

        # -- flash ---------------------------------------------------------
        self._flash_color: RGB = (255, 255, 255)
        self._flash_amount: float = 0.0

        # -- slow motion ---------------------------------------------------
        self._slow_factor: float = 1.0
        self._slow_left: float = 0.0
        self._slow_total: float = 0.0

        # -- transition ----------------------------------------------------
        self._trans_time: float = 0.0
        self._trans_total: float = 0.0
        self._trans_style: str = "iris"
        self._trans_mode: str = "reveal"
        self._trans_flip: bool = False
        self._trans_index: int = 0
        self.transition_color: RGB = P.THEMES[0].accent if P.THEMES else (0, 236, 255)

        # -- feature switches (a scene may turn the grain off for menus) ----
        self.vignette_enabled: bool = True
        self.scanlines_enabled: bool = True
        self.aberration_enabled: bool = True

        # -- cached surfaces ------------------------------------------------
        self._overlay: Optional["pygame.Surface"] = None
        self._scratch: Optional["pygame.Surface"] = None
        self._solid: Optional["pygame.Surface"] = None
        self._trans_surf: Optional["pygame.Surface"] = None
        self._overlay_key: Tuple[int, int, bool, bool] = (0, 0, False, False)
        self._rebuild_overlay()

    # ----------------------------------------------------------------- API
    def set_theme(self, theme: "P.Theme") -> None:
        """Tint future transition wipes with a level's accent colour."""
        try:
            self.transition_color = theme.accent
        except Exception:
            pass

    def shake(self, amount: float) -> None:
        """Add `amount` pixels of trauma to the camera (additive, capped)."""
        try:
            a = float(amount)
        except (TypeError, ValueError):
            return
        if a <= 0.0 or a != a:  # NaN-safe
            return
        # A fresh, strong impact re-seeds the noise so two hits in a row do not
        # continue the exact same wobble.
        if a >= self.shake_amount * 0.6:
            self._shake_seed = random.random() * 100.0
        self.shake_amount = min(SHAKE_MAX, self.shake_amount + a)

    def flash(self, color: RGB, amount: float = 1.0) -> None:
        """Punch a full-screen additive flash of `color`."""
        try:
            a = clamp(float(amount), 0.0, FLASH_MAX)
            c = (P.clamp8(color[0]), P.clamp8(color[1]), P.clamp8(color[2]))
        except (TypeError, ValueError, IndexError):
            return
        if a <= 0.0:
            return
        if self._flash_amount <= 0.01:
            self._flash_color = c
        else:
            # Blend the incoming hue in proportionally to how much light it
            # brings, so a red hit over a fading white flash goes orange.
            w = a / (a + self._flash_amount)
            self._flash_color = P.lerp_color(self._flash_color, c, w)
        self._flash_amount = min(FLASH_MAX, self._flash_amount + a)

    def slowmo(self, factor: float, duration: float) -> None:
        """Drop the simulation to `factor` speed for `duration` seconds."""
        try:
            f = clamp(float(factor), 0.05, 1.0)
            d = float(duration)
        except (TypeError, ValueError):
            return
        if d <= 0.0 or f >= 1.0:
            return
        # Strongest slowdown wins; the longest request sets the timer.
        self._slow_factor = f if self._slow_left <= 0.0 else min(self._slow_factor, f)
        self._slow_left = max(self._slow_left, d)
        self._slow_total = max(self._slow_total, self._slow_left)

    def time_scale(self) -> float:
        """Current simulation multiplier: 1.0 normally, < 1.0 in slow motion."""
        if self._slow_left <= 0.0 or self._slow_total <= 0.0:
            return 1.0
        frac = clamp(self._slow_left / self._slow_total, 0.0, 1.0)
        # Snap in instantly (impact!) but ease back to real time over the last
        # 35% of the window so nothing jolts.
        if frac < 0.35:
            return lerp(1.0, self._slow_factor, ease_in_out_cubic(frac / 0.35))
        return self._slow_factor

    def begin_transition(self, duration: float = C.TRANSITION_TIME, *,
                         style: Optional[str] = None,
                         mode: str = "reveal",
                         color: Optional[RGB] = None) -> None:
        """
        Start a wipe.

        mode "reveal" (default) uncovers the freshly drawn scene, "cover" hides
        it, "blink" does both inside one duration.  style is "iris", "sweep" or
        None to alternate automatically.
        """
        try:
            d = float(duration)
        except (TypeError, ValueError):
            d = C.TRANSITION_TIME
        self._trans_total = max(0.05, d)
        self._trans_time = 0.0
        self._trans_mode = mode if mode in ("reveal", "cover", "blink") else "reveal"
        if style in _TRANSITION_STYLES:
            self._trans_style = style
        else:
            self._trans_index += 1
            self._trans_style = _TRANSITION_STYLES[self._trans_index % len(_TRANSITION_STYLES)]
        self._trans_flip = random.random() < 0.5
        if color is not None:
            try:
                self.transition_color = (P.clamp8(color[0]), P.clamp8(color[1]),
                                         P.clamp8(color[2]))
            except (TypeError, IndexError):
                pass

    @property
    def transition_active(self) -> bool:
        return self._trans_total > 0.0

    @property
    def transition_progress(self) -> float:
        """0..1 through the current wipe (1.0 when none is running)."""
        if self._trans_total <= 0.0:
            return 1.0
        return clamp(self._trans_time / self._trans_total, 0.0, 1.0)

    def screen_offset(self) -> Tuple[int, int]:
        """The shake offset that `present` will apply this frame."""
        if self.shake_amount <= SHAKE_CUTOFF:
            return (0, 0)
        amp = self.shake_amount
        return (
            int(round(_noise1(self._time * 23.0, self._shake_seed) * amp)),
            int(round(_noise1(self._time * 19.0, self._shake_seed + 7.3) * amp * 0.85)),
        )

    def clear(self) -> None:
        """Kill every live effect (used when hard-switching scenes)."""
        self.shake_amount = 0.0
        self._flash_amount = 0.0
        self._slow_left = 0.0
        self._slow_total = 0.0
        self._slow_factor = 1.0
        self._trans_total = 0.0
        self._trans_time = 0.0

    # -------------------------------------------------------------- update
    def update(self, dt: float) -> None:
        """Advance every decay curve. `dt` must be *real* (unscaled) seconds."""
        try:
            dt = float(dt)
        except (TypeError, ValueError):
            return
        if dt != dt or dt <= 0.0:       # NaN or a stalled/rewound clock
            return
        dt = min(dt, C.MAX_DT * 3.0)
        self._time += dt

        self.shake_amount = _decay(self.shake_amount, C.SHAKE_DECAY, dt)
        if self.shake_amount < SHAKE_CUTOFF:
            self.shake_amount = 0.0

        self._flash_amount = _decay(self._flash_amount, C.FLASH_DECAY, dt)
        if self._flash_amount < 0.004:
            self._flash_amount = 0.0

        if self._slow_left > 0.0:
            self._slow_left -= dt
            if self._slow_left <= 0.0:
                self._slow_left = 0.0
                self._slow_total = 0.0
                self._slow_factor = 1.0

        if self._trans_total > 0.0:
            self._trans_time += dt
            if self._trans_time >= self._trans_total:
                self._trans_time = self._trans_total
                self._trans_total = 0.0

    # ------------------------------------------------------------- present
    def present(self, canvas: "pygame.Surface", screen: "pygame.Surface") -> None:
        """Composite `canvas` onto `screen`. Always paints every pixel."""
        try:
            self._present(canvas, screen)
        except Exception:
            # Absolute last resort: the player still gets a picture.
            try:
                screen.blit(canvas, (0, 0))
            except Exception:
                pass

    def _present(self, canvas: "pygame.Surface", screen: "pygame.Surface") -> None:
        sw, sh = screen.get_size()
        if (sw, sh) != self.size:
            self.size = (sw, sh)
            self._rebuild_overlay()

        ox, oy = self.screen_offset()

        # A canvas that does not cover the screen would leave stale pixels
        # behind; one plain fill (~0.1 ms) makes the "always painted" promise
        # unconditional.  Skipped in the normal same-size case.
        if canvas.get_size() != (sw, sh):
            screen.fill((0, 0, 0))

        # 1 + 2 -- base blit, optionally split into channel-tinted copies.
        split_x = split_y = 0
        strength = 0.0
        if self.aberration_enabled:
            strength = _smoothstep(ABERRATION_START, ABERRATION_FULL, self.shake_amount)
        if strength > 0.02:
            split_x, split_y = self._blit_aberrated(canvas, screen, ox, oy, strength)
        else:
            screen.blit(canvas, (ox, oy))

        # The shake slides the frame, exposing strips of untouched display, and
        # the channel copies fringe a few pixels further still.  Paint those
        # strips black so `present` genuinely covers the screen.
        self._fill_edges(screen, abs(ox) + split_x, abs(oy) + split_y, sw, sh)

        # 3 -- additive colour flash.
        # NOTE: `screen.fill(col, special_flags=BLEND_RGB_ADD)` is the obvious
        # spelling and it is a trap - pygame 2.6 runs blended *fills* through a
        # generic per-pixel loop (~9 ms at 1280x720) while a blended *blit*
        # takes the optimised path (~0.3 ms).  So we plain-fill a cached solid
        # surface and blit that instead: same result, ~25x faster.
        if self._flash_amount > 0.0:
            a = clamp(self._flash_amount, 0.0, 1.0)
            c = self._flash_color
            solid = self._get_solid((sw, sh))
            if solid is not None:
                solid.fill((P.clamp8(c[0] * a), P.clamp8(c[1] * a), P.clamp8(c[2] * a)))
                screen.blit(solid, (0, 0), special_flags=pygame.BLEND_RGB_ADD)

        # 4 + 5 -- one cached surface carrying both vignette and scanlines.
        if self._overlay is not None:
            screen.blit(self._overlay, (0, 0))

        # 6 -- the wipe sits on top of everything, including the vignette.
        if self._trans_total > 0.0:
            self._draw_transition(screen, sw, sh)

    # ------------------------------------------------------- post-chain bits
    def _blit_aberrated(self, canvas: "pygame.Surface", screen: "pygame.Surface",
                        ox: int, oy: int, strength: float) -> Tuple[int, int]:
        """
        Cheap RGB split: full-colour base, then a red and a blue copy nudged in
        opposite directions and added back on top.

        The channel isolation is a BLEND_RGB_MULT *blit* of a cached solid tint
        surface rather than a blended fill - see the note in `_present`, the
        fill spelling costs 8 ms a pop.  Nothing is allocated here: both the
        scratch and the tint surface are created once and reused forever.

        Returns the (x, y) channel offset used, so the caller can widen the
        edge fill by exactly as much as the fringes stray.
        """
        size = canvas.get_size()
        scratch = self._get_scratch(size)
        solid = self._get_solid(size)
        screen.blit(canvas, (ox, oy))
        if scratch is None or solid is None:
            return (0, 0)

        dx = int(round(1.0 + strength * ABERRATION_MAX_PX))
        dy = int(round(dx * 0.35))
        mask = int(lerp(ABERRATION_MASK_MIN, ABERRATION_MASK_MAX, strength))

        # Red copy: multiply by (mask,0,0) -> only a dimmed red channel left.
        solid.fill((mask, 0, 0))
        scratch.blit(canvas, (0, 0))
        scratch.blit(solid, (0, 0), special_flags=pygame.BLEND_RGB_MULT)
        screen.blit(scratch, (ox + dx, oy - dy), special_flags=pygame.BLEND_RGB_ADD)

        # Blue copy, displaced the other way, so edges fringe red on one side
        # and cyan-blue on the other exactly like a cheap lens.
        solid.fill((0, 0, mask))
        scratch.blit(canvas, (0, 0))
        scratch.blit(solid, (0, 0), special_flags=pygame.BLEND_RGB_MULT)
        screen.blit(scratch, (ox - dx, oy + dy), special_flags=pygame.BLEND_RGB_ADD)
        return (dx, dy)

    @staticmethod
    def _fill_edges(screen: "pygame.Surface", pad_x: int, pad_y: int,
                    sw: int, sh: int) -> None:
        """Black out the strips the shake offset left uncovered."""
        if pad_x <= 0 and pad_y <= 0:
            return
        black = (0, 0, 0)
        if pad_x > 0:
            pad_x = min(pad_x, sw)
            screen.fill(black, (0, 0, pad_x, sh))
            screen.fill(black, (sw - pad_x, 0, pad_x, sh))
        if pad_y > 0:
            pad_y = min(pad_y, sh)
            screen.fill(black, (0, 0, sw, pad_y))
            screen.fill(black, (0, sh - pad_y, sw, pad_y))

    def _draw_transition(self, screen: "pygame.Surface", sw: int, sh: int) -> None:
        """Draw the wipe for this frame onto the already-composited screen."""
        surf = self._get_trans_surface((sw, sh))
        if surf is None:
            return
        p = self.transition_progress
        # `cover` is how much of the screen the wipe hides: 1 = fully hidden.
        if self._trans_mode == "cover":
            cover = ease_in_out_cubic(p)
        elif self._trans_mode == "blink":
            cover = 1.0 - ease_in_out_cubic(abs(p * 2.0 - 1.0))
        else:  # "reveal"
            cover = 1.0 - ease_out_cubic(p)
        cover = clamp(cover, 0.0, 1.0)
        if cover <= 0.001:
            return

        surf.fill((0, 0, 0, 0))
        if self._trans_style == "sweep":
            self._draw_sweep(surf, sw, sh, cover)
        else:
            self._draw_iris(surf, sw, sh, cover)
        screen.blit(surf, (0, 0))

    def _draw_iris(self, surf: "pygame.Surface", sw: int, sh: int,
                   cover: float) -> None:
        """Dark field with a hole in the middle, ringed in neon."""
        cx, cy = sw // 2, sh // 2
        # +8 keeps the outer edge past the screen corners so they never show
        # a sliver of un-darkened pixels.
        max_r = math.hypot(sw, sh) * 0.5 + 8.0
        r = (1.0 - cover) * max_r
        accent = self.transition_color

        # The dark field is drawn as one annulus from the iris edge out to
        # `max_r`, not as "fill everything then punch a hole".  pygame draws a
        # thick circle inward from `radius`, so the cost tracks the area that
        # is actually still covered - it gets cheaper as the iris opens, which
        # is exactly the wrong way round for the fill-and-punch version.
        rad, inner = int(max_r), int(r)
        if inner <= 1:
            # width == radius does NOT fill in pygame (only width > radius
            # does), which would leave a pinhole of un-wiped scene dead centre
            # at full cover.  Draw it properly filled instead.
            pygame.draw.circle(surf, FIELD_RGBA, (cx, cy), rad)
        else:
            # +2 closes the seam left by truncating both radii to ints; the
            # neon rim is drawn over that overlap anyway.
            pygame.draw.circle(surf, FIELD_RGBA, (cx, cy), rad,
                               min(rad, rad - inner + 2))

        # Neon rim: soft and wide underneath, thin and hot on top.  Every
        # stroke sits at radius >= r, i.e. inside the dark field, so the
        # colours are pre-blended against FIELD and drawn fully opaque - see
        # `_field_blend` for why a translucent stroke would be a bug here.
        glow = P.lerp_color(accent, (255, 255, 255), 0.35)
        for grow, width, alpha, hot in ((14, 16, 34, False), (7, 9, 78, False),
                                        (2, 4, 165, False), (0, 2, 255, True)):
            rr = int(r) + grow
            if rr <= 1:
                continue
            try:
                pygame.draw.circle(surf, _field_blend(glow if hot else accent, alpha),
                                   (cx, cy), rr, width)
            except (pygame.error, ValueError):
                pass

    def _draw_sweep(self, surf: "pygame.Surface", sw: int, sh: int,
                    cover: float) -> None:
        """Half-plane wipe travelling along the screen diagonal."""
        diag = float(sw + sh)
        span = diag + TRANSITION_BAND
        # Everything with (x + y) > edge stays covered; edge marches outward.
        edge = (1.0 - cover) * span

        # Two points on the boundary line, pushed far past the screen so the
        # polygon always covers the whole half-plane.  The line x+y=edge runs
        # along (1,-1)/sqrt(2); its outward normal is (1,1)/sqrt(2).
        half = edge * 0.5
        L = diag * 1.2
        k = 0.70710678 * L
        p1 = (half + k, half - k)
        p2 = (half - k, half + k)
        n = 0.70710678 * diag * 2.0
        p3 = (p2[0] + n, p2[1] + n)
        p4 = (p1[0] + n, p1[1] + n)

        def fx(pt: Tuple[float, float]) -> Tuple[int, int]:
            """Mirror horizontally for the alternate sweep direction."""
            x, y = pt
            return (int(sw - x) if self._trans_flip else int(x), int(y))

        poly: List[Tuple[int, int]] = [fx(p1), fx(p2), fx(p3), fx(p4)]
        try:
            pygame.draw.polygon(surf, FIELD_RGBA, poly)
        except (pygame.error, ValueError):
            surf.fill(FIELD_RGBA)
            return

        accent = self.transition_color
        hot = P.lerp_color(accent, (255, 255, 255), 0.45)
        h = 0.70710678   # unit normal (h, h) points into the covered half

        def stroke(offset: float, width: int, color: "P.RGBA") -> None:
            """One glow line, shifted `offset` px along the boundary normal."""
            a = fx((p1[0] + h * offset, p1[1] + h * offset))
            b = fx((p2[0] + h * offset, p2[1] + h * offset))
            try:
                pygame.draw.line(surf, color, a, b, width)
            except (pygame.error, ValueError):
                pass

        # Light spilling onto the *revealed* side lands on fully transparent
        # pixels, so a genuine alpha here composites correctly over the scene.
        stroke(-7.0, 8, P.with_alpha(accent, 46))
        # Everything on the covered side must be opaque (see `_field_blend`);
        # each stroke is pushed clear of the boundary by half its own width so
        # it never bleeds back over the revealed scene.
        for width, alpha, col in ((26, 30, accent), (12, 90, accent),
                                  (5, 180, accent), (2, 255, hot)):
            stroke(width * 0.5 + 1.0, width, _field_blend(col, alpha))

    # ------------------------------------------------------- cached surfaces
    def _rebuild_overlay(self) -> None:
        """
        Bake vignette + scanlines into a single cached surface.

        Compositing them once means one alpha blit per frame instead of two.
        Both layers are black, so summing their alpha (BLEND_RGBA_ADD) is
        visually equivalent to a proper "over" composite and much cheaper.
        """
        key = (self.size[0], self.size[1],
               bool(self.vignette_enabled), bool(self.scanlines_enabled))
        if key == self._overlay_key and self._overlay is not None:
            return
        self._overlay_key = key
        if not self.vignette_enabled and not self.scanlines_enabled:
            self._overlay = None
            return
        try:
            if self.vignette_enabled:
                surf = build_vignette(self.size)
            else:
                surf = pygame.Surface(self.size, pygame.SRCALPHA)
                surf.fill((0, 0, 0, 0))
            if self.scanlines_enabled:
                w, h = self.size
                line = (0, 0, 0, P.clamp8(SCANLINE_ALPHA))
                for y in range(0, h, max(2, SCANLINE_GAP)):
                    surf.fill(line, (0, y, w, 1), special_flags=pygame.BLEND_RGBA_ADD)
            self._overlay = _convert(surf, alpha=True)
        except Exception:
            self._overlay = None

    def set_post_flags(self, *, vignette: Optional[bool] = None,
                       scanlines: Optional[bool] = None,
                       aberration: Optional[bool] = None) -> None:
        """Toggle post-processing layers; rebuilds the cache only if needed."""
        if vignette is not None:
            self.vignette_enabled = bool(vignette)
        if scanlines is not None:
            self.scanlines_enabled = bool(scanlines)
        if aberration is not None:
            self.aberration_enabled = bool(aberration)
        self._rebuild_overlay()

    def _get_scratch(self, size: Vec2i) -> Optional["pygame.Surface"]:
        """Opaque scratch buffer for the channel split, allocated at most once."""
        if self._scratch is not None and self._scratch.get_size() == size:
            return self._scratch
        try:
            surf = pygame.Surface(size)
            self._scratch = _convert(surf, alpha=False)
        except Exception:
            self._scratch = None
        return self._scratch

    def _get_solid(self, size: Vec2i) -> Optional["pygame.Surface"]:
        """
        A shared opaque surface used as the *source* of blended blits (the
        flash overlay and the two channel tints).  It only ever grows, and a
        source larger than the destination is simply clipped, so one buffer
        serves both the screen and the canvas even if they differ in size.
        """
        need_w, need_h = int(size[0]), int(size[1])
        cur = self._solid
        if cur is not None:
            cw, ch = cur.get_size()
            if cw >= need_w and ch >= need_h:
                return cur
            need_w, need_h = max(cw, need_w), max(ch, need_h)
        try:
            self._solid = _convert(pygame.Surface((need_w, need_h)), alpha=False)
        except Exception:
            self._solid = None
        return self._solid

    def _get_trans_surface(self, size: Vec2i) -> Optional["pygame.Surface"]:
        """Per-pixel-alpha scratch for the wipe, allocated at most once."""
        if self._trans_surf is not None and self._trans_surf.get_size() == size:
            return self._trans_surf
        try:
            self._trans_surf = pygame.Surface(size, pygame.SRCALPHA)
        except Exception:
            self._trans_surf = None
        return self._trans_surf


__all__ = ["EffectStack", "build_vignette", "build_scanlines"]
