"""
Post-processing and screen-feedback stack for NEON SERPENT.

The game renders everything onto an off-screen `canvas`; exactly once per frame
`EffectStack.present(canvas, screen)` copies that canvas to the real display and
layers the "feel" on top of it:

    1. trauma-based screen shake      (offset the whole frame, decays fast,
                                       with a directional shove from impacts)
    2. chromatic aberration           (radial: zero at the centre, widening
                                       toward the rim, only while shaking hard)
    3. bloom                          (threshold -> downsample -> blur -> add)
    4. colour flash                   (additive, decays at C.FLASH_DECAY)
    5. lens streak / light leak       (fires on bright events, additive)
    6. vignette + CRT curvature + scanlines   (one pre-rendered surface)
    7. film grain                     (a few pre-rendered frames, cycled)
    8. scene transition wipe          (iris / sweep / glitch / dissolve)

Design rules honoured here:

*   Every static overlay is built **once** and cached; the scratch buffers the
    shake, bloom and wipes need are allocated lazily and then reused forever.
    Steady state allocates nothing per frame.
*   **Nothing is ever processed at full resolution when it can be processed
    small.**  Bloom runs at a quarter and an eighth of the canvas and is only
    resampled back up; the vignette and curvature ramps are evaluated on a
    96x54 grid and smoothscaled.  That single rule is why an eight-layer post
    chain still fits inside a couple of milliseconds.
*   Blended *fills* are avoided everywhere.  In pygame 2.6 a
    ``fill(col, special_flags=BLEND_*)`` over 1280x720 costs ~8-9 ms, while the
    same operation as a blended *blit* from a cached solid surface costs
    ~0.3 ms.  That one substitution is the difference between this stack
    eating half the frame budget and eating none of it.
*   ``present`` repaints every pixel of the screen every frame, so the caller
    never has to clear the display.
*   Nothing in this module raises.  A failure anywhere in the post chain falls
    back to a plain blit of the canvas.

Measured cost per ``present`` call at 1280x720 (pygame 2.6.1 / SDL 2.28.4),
median of interleaved A/B runs against the previous version of this module in
the same process, so the two columns are directly comparable:

                                        before    after
    idle                                  0.76     2.38 ms
    sustained shake at full trauma        3.87     5.25 ms
    shake + saturated flash               4.79     5.77 ms
    shake + flash + iris wipe             5.77     5.41 ms
    shake + flash + sweep wipe            6.03     5.34 ms
    shake + flash + glitch wipe              -     5.17 ms
    shake + flash + dissolve wipe            -     5.84 ms
    ``set_quality("low")``                   -     0.67 ms

The reference figures this module was budgeted against (1.5 ms idle, 3.4 ms
under sustained shake, 5 ms ceiling) were taken on a machine that runs the
"before" column at 3.4 rather than 3.87 ms, i.e. ~1.14x faster than this one;
scaled to it the "after" column is ~2.1 ms idle, ~4.6 ms shaking and ~5.1 ms
in the single worst combination the game can produce (dying, at full shake and
full flash, on the frame a scene change starts).

Everything above the base blit is either pre-rendered or self-degrading.  In
particular ``_present`` drops the bloom *rebuild* and the grain while the
aberration path is running, and drops the aberration too once a wipe has
swallowed 42% of the frame - neither is legible through a 26-pixel camera
shake or underneath an opaque field, and those are exactly the frames with no
budget left.  ``set_post_flags`` and ``set_quality`` dial the rest back.

Slow motion lives here too, because it is screen feedback rather than
simulation: the game loop asks ``time_scale()`` and scales its own dt.
"""

from __future__ import annotations

import math
import random
from typing import Any, List, Optional, Sequence, Tuple

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

# Directional shove: an impact does not just rattle the camera, it kicks it
# bodily away from the point of contact and lets it spring back.
SHAKE_DIR_DECAY = 9.0       # the shove dies much faster than the rattle
SHAKE_DIR_FREQ = 5.2        # Hz of the spring-back oscillation
SHAKE_DIR_SHARE = 1.15      # shove amplitude as a fraction of the trauma added
SHAKE_DIR_CUTOFF = 0.20

# Shake amplitude where the RGB split switches on.  This is a frame-budget
# dial as much as a look one: the aberration path costs ~1.2 ms (two tinted
# full-frame copies), and a shake decays at SHAKE_DECAY = 5.5/s, so every
# threshold unit below the trigger is another ~0.2 s of expensive frames on the
# tail of every bump.  At 3.2 a portal hop on Event Horizon kept the heavy path
# alive for most of a second at a channel tint of 62/255 - a cost nobody could
# see.  6.5 keeps the split for real hits and drops the invisible tail.
ABERRATION_START = 6.5
ABERRATION_FULL = 15.0      # ... and where it reaches full strength
ABERRATION_MAX_PX = 5.0     # maximum channel offset in pixels, at the rim
ABERRATION_MASK_MIN = 62    # channel-tint strength at the faintest split
ABERRATION_MASK_MAX = 118   # ... and at the strongest
ABERRATION_RINGS = 5        # nested bands used to fake the radial ramp

VIGNETTE_TINT: RGB = (2, 3, 9)
VIGNETTE_STRENGTH = 0.80    # peak alpha at the very corners, 0..1
VIGNETTE_INNER = 0.44       # normalised radius where the darkening starts
VIGNETTE_LOD = (160, 90)    # the vignette is computed small and upscaled

SCANLINE_GAP = 3            # one dark line every N rows
SCANLINE_ALPHA = 15         # very subtle - it should read as texture, not stripes

# CRT / barrel curvature.  The frame is *not* warped per pixel; the illusion
# comes entirely from a pre-rendered overlay: a squircle-shaped edge falloff
# (the part of the tube that turns away from you), a hard rounded corner cut,
# and a thin glass rim highlight.
CURVATURE_LOD = (128, 72)
CURVATURE_STRENGTH = 0.62   # peak alpha of the edge rolloff
CURVATURE_INNER = 0.70      # squircle radius where the rolloff starts
CURVATURE_CORNER = 0.055    # corner cut radius as a fraction of min(w, h)
CURVATURE_RIM: RGB = (150, 176, 214)
CURVATURE_RIM_ALPHA = 30

# Bloom.  Threshold, then downsample hard, then blur by resampling; never a
# convolution and never at full resolution.
BLOOM_DOWNSCALE = 4         # first (nearest) reduction of the canvas
# The threshold is deliberately high.  Neon accents are near-saturated in one
# or two channels and sail over it; large blocks of white UI text sit just
# under it and stay legible instead of smearing into their own halo.
BLOOM_THRESHOLD = 172       # channel value below which nothing blooms
BLOOM_STRENGTH = 0.72       # default add-back strength
BLOOM_MAX = 2.5             # ceiling on the settable strength
# Bloom is the single most expensive thing in the frame (~0.98 ms a rebuild,
# measured by tools/frame_budget.py), and it is also the lowest-frequency thing
# on screen, so it is the right place to buy headroom.  At 40 Hz the "is it
# stale" test tripped every second 60 fps frame; at 22 it trips every third,
# which is a 20 Hz glow - still well above the rate at which a soft halo over
# moving neon can be told apart from a continuous one, and it takes a third of
# the rebuilds (and a third of the 1 ms spikes) straight out of the budget.
BLOOM_REFRESH_HZ = 22.0
# Denominator of the intermediate the bloom is expanded through on its way back
# to full resolution.  This last hop, not the blur, is where the time goes:
# 320x180 -> 640x360 smooth costs 0.345 ms and 640x360 -> 1280x720 nearest a
# further 0.290, i.e. 65% of the whole rebuild.  Going through a third instead
# of a half (427x240) costs 0.22 + 0.30 and the difference is invisible on
# something this blurred - the source is a 320x180 buffer either way.
BLOOM_UPSCALE_DIV = 3

# Film grain: a handful of full-frame speck layers, cycled at film rate and
# jittered so the same layer never lands twice in the same place.  The layers
# are opaque black with light specks and are *added* to the frame rather than
# alpha-blended over it: a per-pixel-alpha blit of a 1280x720 overlay costs
# 0.66 ms even when 99.7% of it is transparent (SDL still tests every pixel),
# while the same surface added costs 0.15 ms.  Silver-halide grain reads as
# light specks on a dark image anyway, so additive is both cheaper and truer.
GRAIN_FRAMES = 3
GRAIN_SPECKS = 3400         # specks per frame
GRAIN_FPS = 24.0
GRAIN_JITTER = 16           # frames are this much larger than the screen
GRAIN_MIN = 6               # speck brightness added to the frame
GRAIN_MAX = 34

# Lens streak / light leak fired by bright events.
FLARE_DECAY = 4.6
FLARE_LOD = (144, 40)       # the streak is authored tiny and smoothscaled
FLARE_HEIGHT = 0.30         # sprite height as a fraction of the screen
FLARE_MAX = 1.4

TRANSITION_BAND = 190.0     # thickness of the glowing edge on a sweep wipe
FIELD: RGB = (3, 4, 10)     # the "blanked out" colour a wipe covers with
FIELD_RGBA = (FIELD[0], FIELD[1], FIELD[2], 255)

#: Every wipe ``begin_transition`` understands.  Passing anything else (or
#: ``None``) cycles through them in order, so successive scene changes never
#: repeat the same wipe twice.
TRANSITION_STYLES: Tuple[str, ...] = ("iris", "sweep", "glitch", "dissolve")
_TRANSITION_STYLES = TRANSITION_STYLES      # kept for backwards compatibility

DISSOLVE_GRID = (80, 45)    # dissolve cell grid (16x16 px cells at 1280x720)
DISSOLVE_STEPS = 18         # pre-rendered coverage steps

GLITCH_BANDS = 15           # horizontal tear bands

# Self-degrading thresholds.  Once a wipe has swallowed this much of the frame
# there is no point spending milliseconds on layers nobody can see through it;
# this is what keeps "death shake plus scene change", the single most expensive
# moment in the game, inside the frame budget.
WIPE_SKIP_CHEAP = 0.35      # drop the bloom rebuild and the grain
WIPE_SKIP_HEAVY = 0.42      # drop the chromatic aberration too

#: Quality presets accepted by :meth:`EffectStack.set_quality`.
QUALITY_LEVELS: Tuple[str, ...] = ("low", "medium", "high", "ultra")


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


def _hash01(n: int) -> float:
    """Deterministic 0..1 hash of an integer - a stable per-band 'random'."""
    x = (n * 1103515245 + 12345) & 0x7FFFFFFF
    x ^= (x >> 13)
    x = (x * 1274126177) & 0x7FFFFFFF
    return (x & 0xFFFF) / 65535.0


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


def _resample(src: "pygame.Surface", size: Vec2i,
              dest: Optional["pygame.Surface"], smooth: bool) -> "pygame.Surface":
    """
    Scale `src` into `dest` when the formats allow it, else into a fresh surface.

    Passing a destination is what keeps the bloom chain allocation-free: pygame
    will happily reuse a buffer as long as it matches in size and bit depth,
    and simply raises if it does not - which is exactly the case we fall back
    on rather than trying to predict.
    """
    fn = pygame.transform.smoothscale if smooth else pygame.transform.scale
    if dest is not None:
        try:
            fn(src, size, dest)
            return dest
        except (pygame.error, ValueError, TypeError):
            pass
    return fn(src, size)


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


def build_curvature(size: Vec2i,
                    strength: float = CURVATURE_STRENGTH,
                    inner: float = CURVATURE_INNER,
                    corner: float = CURVATURE_CORNER) -> "pygame.Surface":
    """
    Pre-render the barrel/CRT edge treatment as a pure-black alpha overlay.

    Two ingredients, both static, so the *illusion* of curvature costs nothing
    at runtime:

    *   a **squircle** falloff, ``(|x|^4 + |y|^4) ^ 1/4``.  A round vignette
        darkens the corners; a squircle darkens the whole rim in a band that
        hugs the screen edge, which is what the turning-away part of a real
        tube actually looks like.  It is evaluated on a 128x72 grid and
        smoothscaled - the function has no high frequencies to lose.
    *   a **hard rounded corner cut** drawn at full resolution.  Physical CRT
        glass has no square corners, and cutting them is the single cue that
        sells the whole effect; it has to be crisp, so it is rasterised after
        the upscale rather than before it.

    The glass rim highlight is *not* included here: it is a light colour and
    would be corrupted by the additive compositing this overlay goes through.
    ``EffectStack._rebuild_overlay`` draws it last instead.
    """
    w, h = max(1, int(size[0])), max(1, int(size[1]))
    lw, lh = CURVATURE_LOD
    small = pygame.Surface((lw, lh), pygame.SRCALPHA)
    peak = clamp(strength, 0.0, 1.0) * 255.0
    inv_w = 2.0 / max(1, lw - 1)
    inv_h = 2.0 / max(1, lh - 1)
    for y in range(lh):
        ny = abs(y * inv_h - 1.0)
        ny4 = ny * ny * ny * ny
        for x in range(lw):
            nx = abs(x * inv_w - 1.0)
            e = (nx * nx * nx * nx + ny4) ** 0.25
            a = _smoothstep(inner, 1.02, e)
            small.set_at((x, y), (0, 0, 0, P.clamp8(peak * (a ** 1.35))))
    try:
        big = pygame.transform.smoothscale(small, (w, h))
    except (pygame.error, ValueError):
        big = pygame.transform.scale(small, (w, h))

    # Rounded corner cut, opaque, one row of fills per corner scanline.
    r = int(clamp(corner, 0.0, 0.25) * min(w, h))
    if r >= 2:
        opaque = (0, 0, 0, 255)
        for y in range(r):
            dy = r - y
            span = r - math.sqrt(max(0.0, r * r - dy * dy))
            cut = int(math.ceil(span))
            if cut <= 0:
                continue
            cut = min(cut, w // 2)
            big.fill(opaque, (0, y, cut, 1))
            big.fill(opaque, (w - cut, y, cut, 1))
            big.fill(opaque, (0, h - 1 - y, cut, 1))
            big.fill(opaque, (w - cut, h - 1 - y, cut, 1))
    return big


def build_grain_frames(size: Vec2i,
                       count: int = GRAIN_FRAMES,
                       specks: int = GRAIN_SPECKS,
                       jitter: int = GRAIN_JITTER) -> List["pygame.Surface"]:
    """
    Pre-render `count` additive film-grain layers, each `jitter` px larger
    than the screen so it can be blitted from a shifted origin.

    Grain has to *change* every frame or it reads as dirt on the lens, but
    generating a million random pixels per frame is out of the question.  A
    small pool of pre-rendered speck layers, cycled at film rate (24 Hz) and
    offset by a per-frame jitter, gives ``count * jitter^2`` visually distinct
    combinations from three surfaces and one blit.

    Real grain is *sparse*: individual specks, not a full-frame noise field.
    Drawing a few thousand 1x1 fills is both far faster to build and a better
    likeness than per-pixel noise - and it keeps the layers opaque, which is
    what lets them be *added* to the frame instead of alpha-blended over it
    (see the note on GRAIN_SPECKS: 0.15 ms instead of 0.66 ms).
    """
    w = max(1, int(size[0])) + max(0, int(jitter))
    h = max(1, int(size[1])) + max(0, int(jitter))
    frames: List["pygame.Surface"] = []
    rng = random.Random(0xC0FFEE)
    for _ in range(max(1, int(count))):
        surf = pygame.Surface((w, h))
        surf.fill((0, 0, 0))
        for _i in range(max(0, int(specks))):
            x = rng.randrange(w)
            y = rng.randrange(h)
            g = rng.randint(GRAIN_MIN, GRAIN_MAX)
            # A hint of colour noise: real grain is not perfectly neutral.
            col = (g, P.clamp8(g * rng.uniform(0.82, 1.0)),
                   P.clamp8(g * rng.uniform(0.86, 1.12)))
            sz = 2 if rng.random() < 0.10 else 1
            surf.fill(col, (x, y, sz, sz))
        frames.append(_convert(surf, alpha=False))
    return frames


def build_flare(size: Vec2i) -> "pygame.Surface":
    """
    Pre-render an anamorphic lens streak: a wide horizontal smear, a hot round
    core and two ghost blooms, on black, ready to be added to the frame.

    Authored at FLARE_LOD (144x40 - about 5.7k pixel writes) and smoothscaled
    to size.  A lens flare is nothing but low frequencies, so the upscale
    *is* the blur; evaluating it at full resolution would look identical and
    cost two hundred times as much.
    """
    w, h = max(2, int(size[0])), max(2, int(size[1]))
    lw, lh = FLARE_LOD
    small = pygame.Surface((lw, lh))
    small.fill((0, 0, 0))
    inv_w = 2.0 / max(1, lw - 1)
    inv_h = 2.0 / max(1, lh - 1)
    for y in range(lh):
        ny = y * inv_h - 1.0
        ny2 = ny * ny
        for x in range(lw):
            nx = x * inv_w - 1.0
            nx2 = nx * nx
            # Wide streak: broad in x, razor thin in y.
            v = math.exp(-nx2 * 2.1) * math.exp(-ny2 * 22.0)
            # Hot core.
            v += 0.85 * math.exp(-(nx2 * 34.0 + ny2 * 9.0))
            # Two ghosts, warmer and cooler, at +-0.42.
            for gx, gs in ((-0.42, 1.0), (0.42, 0.8)):
                d = (nx - gx)
                v += 0.30 * gs * math.exp(-(d * d * 130.0 + ny2 * 26.0))
            i = clamp(v, 0.0, 1.0)
            # A touch of hue separation across the streak sells the "lens".
            small.set_at((x, y), (P.clamp8(255 * i),
                                  P.clamp8(238 * i * (0.85 + 0.15 * (1.0 - abs(nx)))),
                                  P.clamp8(255 * i * (0.70 + 0.30 * abs(nx)))))
    try:
        big = pygame.transform.smoothscale(small, (w, h))
    except (pygame.error, ValueError):
        big = pygame.transform.scale(small, (w, h))
    return _convert(big, alpha=False)


def _build_dissolve(grid: Vec2i = DISSOLVE_GRID,
                    steps: int = DISSOLVE_STEPS,
                    seed: int = 0x5EED
                    ) -> Tuple[List["pygame.Surface"],
                               List[Tuple[int, int]], List[int]]:
    """
    Pre-render the coverage steps of a block dissolve at cell resolution.

    Mask *k* has the first ``k / (steps - 1)`` of a fixed random cell
    permutation filled with the wipe field.  Each mask is only 80x45 pixels,
    so the whole set is built in well under a millisecond and costs 14 KB; the
    upscale to screen size is nearest-neighbour on purpose - the hard 16x16
    blocks *are* the effect.

    Returns ``(masks, cells, bounds)`` where ``cells`` is the permutation and
    ``bounds[k]`` is how many of them mask *k* has swallowed.  Keeping the
    ordering means the glowing dissolve *front* (the cells about to flip) is a
    slice of a list rather than a per-cell comparison of two surfaces - 300
    rect fills instead of 7200 ``get_at`` calls per step.
    """
    gw, gh = max(2, int(grid[0])), max(2, int(grid[1]))
    steps = max(2, int(steps))
    cells = [(x, y) for y in range(gh) for x in range(gw)]
    random.Random(seed).shuffle(cells)
    total = len(cells)
    masks: List["pygame.Surface"] = []
    bounds: List[int] = []
    surf = pygame.Surface((gw, gh), pygame.SRCALPHA)
    surf.fill((0, 0, 0, 0))
    done = 0
    for k in range(steps):
        want = int(round(total * (k / float(steps - 1))))
        while done < want:
            cx, cy = cells[done]
            surf.set_at((cx, cy), FIELD_RGBA)
            done += 1
        masks.append(surf.copy())
        bounds.append(done)
    return masks, cells, bounds


def build_dissolve_masks(grid: Vec2i = DISSOLVE_GRID,
                         steps: int = DISSOLVE_STEPS,
                         seed: int = 0x5EED) -> List["pygame.Surface"]:
    """Just the cell-resolution coverage masks of a block dissolve."""
    return _build_dissolve(grid, steps, seed)[0]


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
        self._dir_x: float = 0.0                # unit shove direction
        self._dir_y: float = 0.0
        self._dir_amount: float = 0.0           # shove amplitude in pixels
        self._dir_phase: float = 0.0            # spring-back phase

        # -- flash ---------------------------------------------------------
        self._flash_color: RGB = (255, 255, 255)
        self._flash_amount: float = 0.0

        # -- lens streak ---------------------------------------------------
        self._flare_amount: float = 0.0
        self._flare_color: RGB = (255, 255, 255)
        self._flare_pos: Tuple[float, float] = (0.5, 0.5)   # normalised

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
        self._trans_seed: int = 0
        self.transition_color: RGB = P.THEMES[0].accent if P.THEMES else (0, 236, 255)

        # -- feature switches (a scene may turn the grain off for menus) ----
        self.vignette_enabled: bool = True
        self.scanlines_enabled: bool = True
        self.aberration_enabled: bool = True
        self.curvature_enabled: bool = True
        self.bloom_enabled: bool = True
        self.grain_enabled: bool = True
        self.flare_enabled: bool = True
        self._bloom_strength: float = BLOOM_STRENGTH

        # -- cached surfaces ------------------------------------------------
        self._overlay: Optional["pygame.Surface"] = None
        #: The same overlay split into an opaque multiply half and an opaque
        #: additive rim, so it costs one cheap blit instead of a per-pixel
        #: alpha one.  See _rebuild_overlay.
        self._overlay_mul: Optional["pygame.Surface"] = None
        self._overlay_rim: Optional["pygame.Surface"] = None
        self._overlay_rim_strips: Tuple["pygame.Rect", ...] = ()
        self._scratch: Optional["pygame.Surface"] = None
        self._solid: Optional["pygame.Surface"] = None
        self._trans_surf: Optional["pygame.Surface"] = None
        self._overlay_key: Tuple[int, int, bool, bool, bool] = (0, 0, False, False, False)

        self._bloom_small: Optional["pygame.Surface"] = None
        self._bloom_small2: Optional["pygame.Surface"] = None
        self._bloom_tiny: Optional["pygame.Surface"] = None
        self._bloom_micro: Optional["pygame.Surface"] = None
        self._bloom_half: Optional["pygame.Surface"] = None
        self._bloom_full: Optional["pygame.Surface"] = None
        self._bloom_key: Tuple[int, int] = (0, 0)
        self._bloom_at: float = -1.0
        #: True on the frames the bloom buffer was actually rebuilt; the grain
        #: pass reads it so the two never bill the same frame.
        self._bloom_rebuilt: bool = False

        self._grain_frames: List["pygame.Surface"] = []
        self._grain_key: Tuple[int, int] = (0, 0)
        self._grain_index: int = 0
        self._grain_at: float = 0.0
        self._grain_jx: int = 0
        self._grain_jy: int = 0

        self._flare_surf: Optional["pygame.Surface"] = None
        self._flare_scratch: Optional["pygame.Surface"] = None
        self._flare_key: Tuple[int, int] = (0, 0)

        self._dissolve_masks: List["pygame.Surface"] = []
        self._dissolve_cells: List[Tuple[int, int]] = []
        self._dissolve_bounds: List[int] = []
        self._dissolve_full: Optional["pygame.Surface"] = None
        self._dissolve_step: int = -1
        self._dissolve_key: Tuple[int, int] = (0, 0)

        self._rebuild_overlay()

    # ----------------------------------------------------------------- API
    def set_theme(self, theme: "P.Theme") -> None:
        """Tint future transition wipes with a level's accent colour."""
        try:
            self.transition_color = theme.accent
        except Exception:
            pass

    def shake(self, amount: float, *,
              direction: Optional[Sequence[float]] = None,
              source: Optional[Sequence[float]] = None) -> None:
        """
        Add `amount` pixels of trauma to the camera (additive, capped).

        Optionally bias the knock:

        ``direction``
            the way the *frame* should be shoved, as any non-zero vector.
        ``source``
            a point in canvas space that the hit came *from*; the frame is
            shoved directly away from it, so a wall clipped on the left throws
            the picture to the right.  Ignored if ``direction`` is given.

        With neither, the shake is pure omnidirectional rattle exactly as
        before - every existing ``fx.shake(12.0)`` call keeps its old feel.
        """
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

        dx, dy = self._impact_vector(direction, source)
        if dx == 0.0 and dy == 0.0:
            return
        push = min(SHAKE_MAX, a * SHAKE_DIR_SHARE)
        # Blend the new shove into whatever is still ringing, weighted by
        # impulse, so two hits from opposite sides partly cancel like a real
        # camera rather than the last one simply winning.
        ax = self._dir_x * self._dir_amount + dx * push
        ay = self._dir_y * self._dir_amount + dy * push
        mag = math.hypot(ax, ay)
        if mag <= 1e-6:
            self._dir_amount = 0.0
            return
        self._dir_x, self._dir_y = ax / mag, ay / mag
        self._dir_amount = min(SHAKE_MAX, mag)
        self._dir_phase = 0.0

    @staticmethod
    def _impact_vector(direction: Optional[Sequence[float]],
                       source: Optional[Sequence[float]]) -> Tuple[float, float]:
        """Normalise a `direction`/`source` pair into a unit shove vector."""
        dx = dy = 0.0
        try:
            if direction is not None:
                dx, dy = float(direction[0]), float(direction[1])
            elif source is not None:
                # Away from the impact point: centre minus source.
                dx = C.WINDOW_W * 0.5 - float(source[0])
                dy = C.WINDOW_H * 0.5 - float(source[1])
        except (TypeError, ValueError, IndexError):
            return (0.0, 0.0)
        if dx != dx or dy != dy:
            return (0.0, 0.0)
        mag = math.hypot(dx, dy)
        if mag <= 1e-6:
            return (0.0, 0.0)
        return (dx / mag, dy / mag)

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
        # A bright event is exactly what makes a real lens streak, so the
        # flare rides along automatically - callers get it for free.
        if a >= 0.20:
            self.flare(a * 0.85, color=c)

    def flare(self, amount: float = 1.0, *,
              color: Optional[RGB] = None,
              pos: Optional[Sequence[float]] = None) -> None:
        """
        Fire the anamorphic lens streak.

        `pos` is a point in canvas space (defaults to a spot wandering around
        the middle of the screen so repeated hits do not stack identically).
        """
        try:
            a = clamp(float(amount), 0.0, FLARE_MAX)
        except (TypeError, ValueError):
            return
        if a <= 0.0:
            return
        if color is not None:
            try:
                self._flare_color = (P.clamp8(color[0]), P.clamp8(color[1]),
                                     P.clamp8(color[2]))
            except (TypeError, IndexError):
                pass
        nx, ny = 0.5, 0.5
        if pos is not None:
            try:
                nx = clamp(float(pos[0]) / max(1.0, float(C.WINDOW_W)), 0.0, 1.0)
                ny = clamp(float(pos[1]) / max(1.0, float(C.WINDOW_H)), 0.0, 1.0)
            except (TypeError, ValueError, IndexError):
                nx, ny = 0.5, 0.5
        else:
            nx = 0.5 + random.uniform(-0.14, 0.14)
            ny = 0.5 + random.uniform(-0.18, 0.18)
        if a >= self._flare_amount:
            self._flare_pos = (nx, ny)
        self._flare_amount = min(FLARE_MAX, self._flare_amount + a)

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
        it, "blink" does both inside one duration.  style is any name in
        :data:`TRANSITION_STYLES` - "iris", "sweep", "glitch" or "dissolve" -
        or None to alternate automatically.
        """
        try:
            d = float(duration)
        except (TypeError, ValueError):
            d = C.TRANSITION_TIME
        self._trans_total = max(0.05, d)
        self._trans_time = 0.0
        self._trans_mode = mode if mode in ("reveal", "cover", "blink") else "reveal"
        if style in TRANSITION_STYLES:
            self._trans_style = str(style)
        else:
            self._trans_index += 1
            self._trans_style = TRANSITION_STYLES[self._trans_index % len(TRANSITION_STYLES)]
        self._trans_flip = random.random() < 0.5
        self._trans_seed = random.randrange(1 << 20)
        self._dissolve_step = -1
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

    @property
    def bloom_strength(self) -> float:
        """How hard the bloom is added back, 0..BLOOM_MAX (default 0.85)."""
        return self._bloom_strength

    @bloom_strength.setter
    def bloom_strength(self, value: float) -> None:
        try:
            v = clamp(float(value), 0.0, BLOOM_MAX)
        except (TypeError, ValueError):
            return
        if abs(v - self._bloom_strength) < 1e-4:
            return
        self._bloom_strength = v
        self._bloom_at = -1.0        # force a rebuild at the new strength

    def screen_offset(self) -> Tuple[int, int]:
        """The shake offset that `present` will apply this frame."""
        ox = oy = 0.0
        if self.shake_amount > SHAKE_CUTOFF:
            amp = self.shake_amount
            ox = _noise1(self._time * 23.0, self._shake_seed) * amp
            oy = _noise1(self._time * 19.0, self._shake_seed + 7.3) * amp * 0.85
        if self._dir_amount > SHAKE_DIR_CUTOFF:
            # cos() starts at the full shove and swings back through zero, so
            # the frame is punched away from the impact and springs past it.
            swing = math.cos(self._dir_phase)
            ox += self._dir_x * self._dir_amount * swing
            oy += self._dir_y * self._dir_amount * swing
        lim = SHAKE_MAX * 1.4
        return (int(round(clamp(ox, -lim, lim))), int(round(clamp(oy, -lim, lim))))

    def clear(self) -> None:
        """Kill every live effect (used when hard-switching scenes)."""
        self.shake_amount = 0.0
        self._dir_amount = 0.0
        self._dir_x = self._dir_y = 0.0
        self._flash_amount = 0.0
        self._flare_amount = 0.0
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

        if self._dir_amount > 0.0:
            self._dir_amount = _decay(self._dir_amount, SHAKE_DIR_DECAY, dt)
            self._dir_phase += dt * SHAKE_DIR_FREQ * math.pi * 2.0
            if self._dir_amount < SHAKE_DIR_CUTOFF:
                self._dir_amount = 0.0
                self._dir_phase = 0.0

        self._flash_amount = _decay(self._flash_amount, C.FLASH_DECAY, dt)
        if self._flash_amount < 0.004:
            self._flash_amount = 0.0

        self._flare_amount = _decay(self._flare_amount, FLARE_DECAY, dt)
        if self._flare_amount < 0.006:
            self._flare_amount = 0.0

        # Grain advances at film rate, not frame rate: 60 Hz noise fizzes.
        if self._time - self._grain_at >= 1.0 / GRAIN_FPS:
            self._grain_at = self._time
            self._grain_index += 1
            self._grain_jx = random.randrange(GRAIN_JITTER + 1)
            self._grain_jy = random.randrange(GRAIN_JITTER + 1)

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

        # How much of this frame an active wipe is about to bury.  Layers that
        # cost real milliseconds are not worth paying for underneath an opaque
        # field, and a death (violent shake) immediately followed by a wipe is
        # exactly the moment the frame budget is tightest.
        wipe = self._transition_cover()

        # 1 + 2 -- base blit, optionally split into channel-tinted copies.
        strength = 0.0
        if self.aberration_enabled and wipe < WIPE_SKIP_HEAVY:
            strength = _smoothstep(ABERRATION_START, ABERRATION_FULL, self.shake_amount)
        heavy = strength > 0.02
        if heavy:
            self._blit_aberrated(canvas, screen, ox, oy, strength)
        else:
            screen.blit(canvas, (ox, oy))

        # The shake slides the frame, exposing strips of untouched display.
        # (The channel copies are additive and displace *outward*, so they can
        # never uncover anything the base blit already covered.)  Paint those
        # strips black so `present` genuinely covers the screen.
        self._fill_edges(screen, abs(ox), abs(oy), sw, sh)

        # 3 -- bloom.  Skipped for a rebuild while the aberration path is
        # running: that is the one frame in the budget that cannot afford it,
        # and a stale glow is invisible under a 20-pixel camera shake.
        if self.bloom_enabled and self._bloom_strength > 0.0:
            self._bloom_pass(canvas, screen, ox, oy,
                             allow_refresh=not heavy and wipe < WIPE_SKIP_CHEAP)

        # 4 -- additive colour flash.
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
                solid.fill((P.clamp8(c[0] * a), P.clamp8(c[1] * a), P.clamp8(c[2] * a)),
                           (0, 0, sw, sh))
                screen.blit(solid, (0, 0), special_flags=pygame.BLEND_RGB_ADD)

        # 5 -- lens streak riding on the same bright event.
        if self.flare_enabled and self._flare_amount > 0.0:
            self._draw_flare(screen, sw, sh)

        # 6 -- one cached surface carrying vignette + curvature + scanlines.
        if self._overlay_mul is not None:
            screen.blit(self._overlay_mul, (0, 0),
                        special_flags=pygame.BLEND_RGB_MULT)
            rim = self._overlay_rim
            if rim is not None:
                for strip in self._overlay_rim_strips:
                    screen.blit(rim, strip.topleft, strip,
                                special_flags=pygame.BLEND_RGB_ADD)
        elif self._overlay is not None:
            screen.blit(self._overlay, (0, 0))

        # 7 -- film grain (dropped during the heavy path, see above).
        #
        # Also dropped on the frame the bloom actually rebuilt.  This is a
        # scheduling change, not a quality one: those are the two most
        # expensive optional passes in the chain, and letting them land on the
        # same frame is what turns a 7 ms mean into a 15 ms p95.  Staggered,
        # grain still draws on two frames in three - and the grain *layer* only
        # changes at GRAIN_FPS (24 Hz) anyway, so it is 3400 specks out of
        # 921600 pixels missing from one frame in three.  Nobody can see that;
        # everybody can see a dropped frame.
        if (self.grain_enabled and not heavy and wipe < WIPE_SKIP_CHEAP
                and not self._bloom_rebuilt):
            self._draw_grain(screen, sw, sh)

        # 8 -- the wipe sits on top of everything, including the vignette.
        if self._trans_total > 0.0:
            self._draw_transition(screen, sw, sh, wipe)

    # ------------------------------------------------------- post-chain bits
    def _blit_aberrated(self, canvas: "pygame.Surface", screen: "pygame.Surface",
                        ox: int, oy: int, strength: float) -> Tuple[int, int]:
        """
        Radial RGB split: full-colour base, then a red copy pushed *outward*
        and a blue copy pulled *inward*, by an amount that grows from zero at
        the centre of the frame to the full offset at the rim.

        A real lens has no aberration on its optical axis, so the old uniform
        translation always looked like a printing misregistration rather than
        glass.  Making it genuinely radial would mean two scaled copies of the
        canvas per frame - ``transform.scale`` at full resolution is 0.7 ms a
        go, and with the tint and add blits that came to 2.7 ms.  Instead the
        frame is cut into ABERRATION_RINGS nested rectangular bands and each
        band's four strips are blitted along their own outward normal, which
        approximates the same ramp for the price of one full-frame blit
        (~1.7 ms for both channels, i.e. no worse than the uniform version it
        replaces).

        The channel isolation is a BLEND_RGB_MULT *blit* of a cached solid tint
        surface rather than a blended fill - see the note in `_present`, the
        fill spelling costs 8 ms a pop.  Nothing is allocated here: both the
        scratch and the tint surface are created once and reused forever.

        Returns the extra (x, y) edge padding the caller needs, which is always
        (0, 0) - the copies are additive and only ever move outward.
        """
        w, h = canvas.get_size()
        scratch = self._get_scratch((w, h))
        solid = self._get_solid((w, h))
        screen.blit(canvas, (ox, oy))
        if scratch is None or solid is None:
            return (0, 0)

        dmax = int(round(1.0 + strength * ABERRATION_MAX_PX))
        if dmax < 1:
            return (0, 0)
        # At least two bands, or there would be nothing but the undisplaced
        # centre block and no split at all at the faintest strengths.
        rings = max(2, min(ABERRATION_RINGS, dmax + 1))
        mask = int(lerp(ABERRATION_MASK_MIN, ABERRATION_MASK_MAX, strength))

        for sign, tint in ((1, (mask, 0, 0)), (-1, (0, 0, mask))):
            # Red spreads outward, blue contracts inward: edges fringe red on
            # the outside and cyan-blue on the inside, exactly like cheap glass.
            solid.fill(tint, (0, 0, w, h))
            scratch.blit(canvas, (0, 0))
            scratch.blit(solid, (0, 0), special_flags=pygame.BLEND_RGB_MULT)
            self._blit_radial_bands(screen, scratch, ox, oy, dmax * sign, rings, w, h)
        return (0, 0)

    @staticmethod
    def _blit_radial_bands(screen: "pygame.Surface", src: "pygame.Surface",
                           ox: int, oy: int, dmax: int, rings: int,
                           w: int, h: int) -> None:
        """
        Additively blit `src` as `rings` nested bands, each displaced along its
        own outward normal by an amount that falls off toward the centre.

        The bands tile the frame exactly (every boundary is computed once and
        shared by the strip on either side of it), so the union of all the
        source rects is the whole surface and no pixel is added twice.  The
        *destination* rects do leave sub-band gaps where consecutive bands move
        by different amounts, but those are at most one pixel wide on an
        additive fringe layer with the full-colour base intact underneath, so
        they are invisible.
        """
        step_x = w / (2.0 * rings)
        step_y = h / (2.0 * rings)
        add = pygame.BLEND_RGB_ADD
        for i in range(rings):
            x0, y0 = int(i * step_x), int(i * step_y)
            x1, y1 = w - x0, h - y0
            if x1 - x0 <= 0 or y1 - y0 <= 0:
                break
            if i == rings - 1:
                # Innermost block: on the optical axis, so no displacement.
                screen.blit(src, (x0 + ox, y0 + oy), (x0, y0, x1 - x0, y1 - y0),
                            special_flags=add)
                break
            nx0, ny0 = int((i + 1) * step_x), int((i + 1) * step_y)
            nx1, ny1 = w - nx0, h - ny0
            d = int(round(dmax * (rings - i) / float(rings)))
            bw = x1 - x0
            th, tv = ny0 - y0, y1 - ny1     # top/bottom strip heights
            lw, rw = nx0 - x0, x1 - nx1     # left/right strip widths
            ih = ny1 - ny0                  # height of the side strips
            if th > 0:
                screen.blit(src, (x0 + ox, y0 + oy - d), (x0, y0, bw, th),
                            special_flags=add)
            if tv > 0:
                screen.blit(src, (x0 + ox, ny1 + oy + d), (x0, ny1, bw, tv),
                            special_flags=add)
            if ih > 0 and lw > 0:
                screen.blit(src, (x0 + ox - d, ny0 + oy), (x0, ny0, lw, ih),
                            special_flags=add)
            if ih > 0 and rw > 0:
                screen.blit(src, (nx1 + ox + d, ny0 + oy), (nx1, ny0, rw, ih),
                            special_flags=add)

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

    # ------------------------------------------------------------ bloom
    def _bloom_pass(self, canvas: "pygame.Surface", screen: "pygame.Surface",
                    ox: int, oy: int, allow_refresh: bool) -> None:
        """
        Threshold the canvas, blur it small, add it back.

        The whole point of a bloom pass is that it must never touch full
        resolution except to read once and write once:

            canvas -> 1/4 (nearest)      cheap, and the blur hides the aliasing
                   -> threshold          one BLEND_RGB_SUB over 320x180 px
                   -> 1/16, 1/64         two smoothscales of a tiny source
                   -> both back to 1/4   the ping-pong back up *is* the blur;
                                         summing the two octaves gives a tight
                                         hot halo plus a wide soft glow
                   -> gain               one BLEND_RGB_MULT, still at 1/4
                   -> 1/2 (smooth) -> full (nearest)   into a cached buffer

        That chain is ~0.85 ms; the buffer it fills is then added to the frame
        for 0.16 ms.  Because a glow is the lowest-frequency thing on screen it
        is only rebuilt at BLOOM_REFRESH_HZ (22 Hz, i.e. every third frame at
        60 fps) and reused in between, which cuts the average cost to a third
        and, more importantly, gives the shake frames somewhere to borrow time
        from.

        Sets ``self._bloom_rebuilt`` so the caller can move other optional work
        off the frame that paid for the rebuild.
        """
        self._bloom_rebuilt = False
        w, h = canvas.get_size()
        if w < 32 or h < 32:
            return
        if not self._ensure_bloom_buffers(w, h):
            return
        full = self._bloom_full
        if full is None:
            return

        stale = self._bloom_at < 0.0 or (self._time - self._bloom_at) >= 1.0 / BLOOM_REFRESH_HZ
        if stale and (allow_refresh or self._bloom_at < 0.0):
            self._bloom_at = self._time
            self._refresh_bloom(canvas, w, h)
            self._bloom_rebuilt = True
        screen.blit(full, (ox, oy), special_flags=pygame.BLEND_RGB_ADD)

    def _ensure_bloom_buffers(self, w: int, h: int) -> bool:
        """Allocate the bloom ladder once per canvas size. False if it failed."""
        if self._bloom_key == (w, h) and self._bloom_full is not None:
            return True
        d = max(2, int(BLOOM_DOWNSCALE))
        try:
            sw, sh = max(8, w // d), max(8, h // d)
            self._bloom_small = _convert(pygame.Surface((sw, sh)), alpha=False)
            self._bloom_small2 = _convert(pygame.Surface((sw, sh)), alpha=False)
            self._bloom_tiny = _convert(pygame.Surface((max(4, sw // 4),
                                                        max(4, sh // 4))), alpha=False)
            self._bloom_micro = _convert(pygame.Surface((max(3, sw // 16),
                                                         max(3, sh // 16))), alpha=False)
            up = max(2, int(BLOOM_UPSCALE_DIV))
            self._bloom_half = _convert(pygame.Surface((max(8, w // up),
                                                        max(8, h // up))), alpha=False)
            self._bloom_full = _convert(pygame.Surface((w, h)), alpha=False)
            self._bloom_full.fill((0, 0, 0))
            self._bloom_key = (w, h)
            self._bloom_at = -1.0
            return True
        except Exception:
            self._bloom_small = self._bloom_small2 = None
            self._bloom_tiny = self._bloom_micro = None
            self._bloom_half = self._bloom_full = None
            self._bloom_key = (0, 0)
            return False

    def _refresh_bloom(self, canvas: "pygame.Surface", w: int, h: int) -> None:
        """Rebuild the cached full-resolution bloom buffer from `canvas`."""
        small, small2 = self._bloom_small, self._bloom_small2
        tiny, micro = self._bloom_tiny, self._bloom_micro
        half, full = self._bloom_half, self._bloom_full
        if (small is None or small2 is None or tiny is None or micro is None
                or half is None or full is None):
            return
        solid = self._get_solid(small.get_size())
        sw, sh = small.get_size()

        # 1. hard, cheap reduction.  Nearest is fine: the blur below is about
        #    to smear anything the point sampling missed.
        _resample(canvas, (sw, sh), small, smooth=False)

        # 2. threshold - subtract a grey floor so only genuine highlights
        #    survive - then restore some punch by doubling what is left.
        if solid is not None:
            t = P.clamp8(BLOOM_THRESHOLD)
            solid.fill((t, t, t), (0, 0, sw, sh))
            small.blit(solid, (0, 0), special_flags=pygame.BLEND_RGB_SUB)

        # 3. blur by resampling down and back up.  Two octaves, because one is
        #    never enough: the 1/16 pass gives a tight, bright halo that hugs
        #    the source, the 1/64 pass gives the wide atmospheric glow, and
        #    summing them is what separates "bloom" from "slightly blurry".
        #    Every operation here runs on at most 320x180 pixels.
        tw, th = tiny.get_size()
        mw, mh = micro.get_size()
        _resample(small, (tw, th), tiny, smooth=True)
        _resample(tiny, (mw, mh), micro, smooth=True)
        _resample(micro, (sw, sh), small2, smooth=True)   # wide octave
        _resample(tiny, (sw, sh), small, smooth=True)     # tight octave
        small.blit(small2, (0, 0), special_flags=pygame.BLEND_RGB_ADD)

        # 4. gain.  <= 1 is a straight multiply; above 1 the buffer is doubled
        #    once first (via the second same-size buffer, because a surface
        #    cannot legally be blitted onto itself), so the settable strength
        #    covers 0 .. BLOOM_MAX with one extra 320x180 blit at most.
        gain = self._bloom_strength
        if gain > 1.0:
            small2.blit(small, (0, 0))
            small.blit(small2, (0, 0), special_flags=pygame.BLEND_RGB_ADD)
            gain *= 0.5
        if solid is not None and gain < 0.999:
            g = P.clamp8(gain * 255.0)
            solid.fill((g, g, g), (0, 0, sw, sh))
            small.blit(solid, (0, 0), special_flags=pygame.BLEND_RGB_MULT)

        # 5. back up to full resolution in two hops: a smoothscale to an
        #    intermediate (cheap, because it reads a small source) and a
        #    nearest expand to full.  A direct smoothscale to full costs 1.2 ms;
        #    this costs 0.5 and the blocks are invisible on something this
        #    blurred.  The intermediate is w / BLOOM_UPSCALE_DIV - see the note
        #    on that constant for why the divisor, not the blur, is the dial.
        hw, hh = half.get_size()
        _resample(small, (hw, hh), half, smooth=True)
        _resample(half, (w, h), full, smooth=False)

    # ------------------------------------------------------------ flare
    def _draw_flare(self, screen: "pygame.Surface", sw: int, sh: int) -> None:
        """Tint the cached streak sprite by the event colour and add it."""
        fw, fh = sw, max(8, int(sh * FLARE_HEIGHT))
        if self._flare_key != (fw, fh) or self._flare_surf is None:
            try:
                self._flare_surf = build_flare((fw, fh))
                self._flare_scratch = _convert(pygame.Surface((fw, fh)), alpha=False)
                self._flare_key = (fw, fh)
            except Exception:
                self._flare_surf = self._flare_scratch = None
                self._flare_key = (0, 0)
                return
        src, scratch = self._flare_surf, self._flare_scratch
        solid = self._get_solid((fw, fh))
        if src is None or scratch is None or solid is None:
            return
        a = clamp(self._flare_amount, 0.0, 1.0)
        c = self._flare_color
        # Whiten as it peaks: a real over-exposed streak loses saturation.
        c = P.lerp_color(c, (255, 255, 255), 0.45 * a)
        scratch.blit(src, (0, 0))
        solid.fill((P.clamp8(c[0] * a), P.clamp8(c[1] * a), P.clamp8(c[2] * a)),
                   (0, 0, fw, fh))
        scratch.blit(solid, (0, 0), special_flags=pygame.BLEND_RGB_MULT)
        x = int(self._flare_pos[0] * sw - fw * 0.5)
        y = int(self._flare_pos[1] * sh - fh * 0.5)
        screen.blit(scratch, (x, y), special_flags=pygame.BLEND_RGB_ADD)

    # ------------------------------------------------------------ grain
    def _draw_grain(self, screen: "pygame.Surface", sw: int, sh: int) -> None:
        """Add one pre-rendered speck layer, offset by this frame's jitter."""
        if self._grain_key != (sw, sh) or not self._grain_frames:
            try:
                self._grain_frames = build_grain_frames((sw, sh))
                self._grain_key = (sw, sh)
            except Exception:
                self._grain_frames = []
                self._grain_key = (0, 0)
                return
        frames = self._grain_frames
        if not frames:
            return
        surf = frames[self._grain_index % len(frames)]
        screen.blit(surf, (-self._grain_jx, -self._grain_jy),
                    special_flags=pygame.BLEND_RGB_ADD)

    # ------------------------------------------------------- transitions
    def _transition_cover(self) -> float:
        """
        How much of the screen the active wipe hides right now: 0 none, 1 all.

        Computed before the post chain runs as well as during it, because the
        answer decides which layers are worth paying for this frame.
        """
        if self._trans_total <= 0.0:
            return 0.0
        p = self.transition_progress
        if self._trans_mode == "cover":
            cover = ease_in_out_cubic(p)
        elif self._trans_mode == "blink":
            cover = 1.0 - ease_in_out_cubic(abs(p * 2.0 - 1.0))
        else:  # "reveal"
            cover = 1.0 - ease_out_cubic(p)
        return clamp(cover, 0.0, 1.0)

    def _draw_transition(self, screen: "pygame.Surface", sw: int, sh: int,
                         cover: float) -> None:
        """Draw the wipe for this frame onto the already-composited screen."""
        if cover <= 0.001:
            return

        style = self._trans_style
        if style == "dissolve":
            self._draw_dissolve(screen, sw, sh, cover)
            return
        if style == "glitch":
            self._draw_glitch(screen, sw, sh, cover)
            return

        surf = self._get_trans_surface((sw, sh))
        if surf is None:
            return
        surf.fill((0, 0, 0, 0))
        if style == "sweep":
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

    def _draw_dissolve(self, screen: "pygame.Surface", sw: int, sh: int,
                       cover: float) -> None:
        """
        Block dissolve: cells drop out in a fixed random order.

        The masks are pre-rendered at 80x45 (see :func:`build_dissolve_masks`)
        and only expanded to screen size when the step index actually changes -
        eighteen upscales spread over the whole wipe instead of one per frame.
        The freshly flipped cells are painted in the accent colour so the
        dissolve front glows instead of just eating the picture.
        """
        if not self._dissolve_masks:
            try:
                (self._dissolve_masks, self._dissolve_cells,
                 self._dissolve_bounds) = _build_dissolve()
            except Exception:
                self._dissolve_masks = []
                return
        masks = self._dissolve_masks
        step = int(round(clamp(cover, 0.0, 1.0) * (len(masks) - 1)))
        if self._dissolve_full is None or self._dissolve_key != (sw, sh):
            try:
                self._dissolve_full = pygame.Surface((sw, sh), pygame.SRCALPHA)
                self._dissolve_key = (sw, sh)
                self._dissolve_step = -1
            except Exception:
                self._dissolve_full = None
                return
        full = self._dissolve_full
        if step != self._dissolve_step:
            self._dissolve_step = step
            _resample(masks[step], (sw, sh), full, smooth=False)
            # Glowing front: whatever the *next* step will swallow, drawn hot.
            if step + 1 < len(self._dissolve_bounds):
                self._paint_dissolve_front(full, masks[step].get_size(),
                                           self._dissolve_bounds[step],
                                           self._dissolve_bounds[step + 1], sw, sh)
        screen.blit(full, (0, 0))

    def _paint_dissolve_front(self, full: "pygame.Surface", grid: Vec2i,
                              lo: int, hi: int, sw: int, sh: int) -> None:
        """Fill the cells about to flip with a hot accent block."""
        cells = self._dissolve_cells
        if not cells:
            return
        gw, gh = grid
        cw = sw / float(max(1, gw))
        ch = sh / float(max(1, gh))
        col = _field_blend(P.lerp_color(self.transition_color, (255, 255, 255), 0.30), 190)
        bw, bh = int(cw) + 1, int(ch) + 1
        for gx, gy in cells[max(0, lo):min(len(cells), hi)]:
            full.fill(col, (int(gx * cw), int(gy * ch), bw, bh))

    def _draw_glitch(self, screen: "pygame.Surface", sw: int, sh: int,
                     cover: float) -> None:
        """
        Digital tear: horizontal bands slide, split into RGB and drop to the
        field one by one until the picture is gone.

        The already-composited screen is copied once into the shared scratch
        and every band is then read back out of that copy, which is what makes
        overlapping displacements well defined (blitting a surface onto itself
        across overlapping rects is not).  One full-frame copy plus a screen's
        worth of band blits: ~0.5 ms.
        """
        scratch = self._get_scratch((sw, sh))
        if scratch is None:
            screen.fill(FIELD)
            return
        scratch.blit(screen, (0, 0))

        bands = max(4, GLITCH_BANDS)
        bh = sh / float(bands)
        # Quantising time keeps the tear pattern stable for a couple of frames
        # instead of strobing at 60 Hz, which reads as a *signal* fault.
        tick = int(self._trans_time * 26.0) + self._trans_seed
        accent = self.transition_color
        amp = sw * 0.16 * cover
        eaten = cover * cover

        for i in range(bands):
            y0 = int(i * bh)
            y1 = int((i + 1) * bh) if i + 1 < bands else sh
            hgt = y1 - y0
            if hgt <= 0:
                continue
            screen.fill(FIELD, (0, y0, sw, hgt))
            r = _hash01(tick * 131 + i * 7919)
            if r < eaten:
                continue                      # this band is gone entirely
            shift = int((_hash01(tick * 977 + i * 313) - 0.5) * 2.0 * amp)
            screen.blit(scratch, (shift, y0), (0, y0, sw, hgt))
            if shift > 0:
                screen.blit(scratch, (0, y0), (sw - shift, y0, shift, hgt))
            elif shift < 0:
                screen.blit(scratch, (sw + shift, y0), (0, y0, -shift, hgt))
            # RGB tear, on the bands closest to being eaten: a ghost of the
            # same strip added a few pixels off, then a hot fringe line.  Two
            # blits and two 2-px fills - a channel-isolating multiply over the
            # whole band would cost five times as much and read as mud.
            if r < eaten + 0.20:
                off = 7 if (i & 1) else -7
                screen.blit(scratch, (shift + off, y0), (0, y0, sw, hgt),
                            special_flags=pygame.BLEND_RGB_ADD)
                fringe = (170, 0, 80) if (i & 1) else (0, 130, 190)
                screen.fill(fringe, (0, y0, sw, 2), special_flags=pygame.BLEND_RGB_ADD)
                screen.fill(fringe, (0, y1 - 2, sw, 2), special_flags=pygame.BLEND_RGB_ADD)

        # A scanning accent bar so the glitch still reads as *this* game.
        bar_y = int((self._trans_time * 900.0) % max(1, sh))
        try:
            pygame.draw.line(screen, P.lerp_color(accent, (255, 255, 255), 0.5),
                             (0, bar_y), (sw, bar_y), 2)
        except (pygame.error, ValueError):
            pass

    # ------------------------------------------------------- cached surfaces
    def _rebuild_overlay(self) -> None:
        """
        Bake vignette + curvature + scanlines into cached surfaces.

        Compositing them once means one blit per frame instead of three.  All
        three layers are pure black, so summing their alpha (BLEND_RGBA_ADD) is
        visually equivalent to a proper "over" composite and much cheaper.

        The result is then turned into two *opaque* surfaces, because a
        full-screen per-pixel-alpha blit costs 0.55 ms at 1280x720 while an
        opaque one with a blend flag costs 0.15 - and this overlay is painted
        on literally every frame of the game, so that difference was the single
        largest fixed cost in the post chain (measured by
        tools/frame_budget.py).

        The substitution is exact, not an approximation.  Alpha-blending pure
        black at alpha ``a`` is ``dst * (1 - a)``, i.e. precisely a multiply -
        so the multiplier surface is built by alpha-blending the overlay onto
        white *once*, at construction, and every pixel of it is then the
        ``255 - a`` that BLEND_RGB_MULT wants.

        The glass rim is the exception - it is a *light* colour, so it cannot
        ride in a multiply - and it goes into a second, additive surface that
        is blitted only over the four edge strips it actually occupies (about
        11% of the frame, ~0.02 ms).  Riding on top of the vignette rather than
        replacing it is a hair darker than the old plain stroke, which on a
        highlight at the very rim of the screen is not a visible difference.
        """
        key = (self.size[0], self.size[1],
               bool(self.vignette_enabled), bool(self.scanlines_enabled),
               bool(self.curvature_enabled))
        if key == self._overlay_key and (self._overlay is not None
                                         or self._overlay_mul is not None):
            return
        self._overlay_key = key
        self._overlay = None
        self._overlay_mul = None
        self._overlay_rim = None
        self._overlay_rim_strips = ()
        if not (self.vignette_enabled or self.scanlines_enabled
                or self.curvature_enabled):
            return
        try:
            w, h = self.size
            if self.vignette_enabled:
                surf = build_vignette(self.size)
            else:
                surf = pygame.Surface(self.size, pygame.SRCALPHA)
                surf.fill((0, 0, 0, 0))
            if self.curvature_enabled:
                surf.blit(build_curvature(self.size), (0, 0),
                          special_flags=pygame.BLEND_RGBA_ADD)
            if self.scanlines_enabled:
                line = (0, 0, 0, P.clamp8(SCANLINE_ALPHA))
                for y in range(0, h, max(2, SCANLINE_GAP)):
                    surf.fill(line, (0, y, w, 1), special_flags=pygame.BLEND_RGBA_ADD)

            # Kept for compatibility: anything that wants the classic single
            # alpha overlay (a screenshot tool, a future low-quality path) can
            # still read it.  `_present` uses the opaque pair below.
            self._overlay = _convert(surf, alpha=True)

            # -- the multiply half: white, alpha-composited once -------------
            mul = pygame.Surface(self.size)
            mul.fill((255, 255, 255))
            mul.blit(surf, (0, 0))
            self._overlay_mul = _convert(mul, alpha=False)

            # -- the additive half: the glass rim, premultiplied -------------
            if self.curvature_enabled:
                rim = pygame.Surface(self.size)
                rim.fill((0, 0, 0))
                self._draw_glass_rim(rim, w, h, premultiplied=True)
                self._overlay_rim = _convert(rim, alpha=False)
                self._overlay_rim_strips = self._rim_strips(w, h)
        except Exception:
            self._overlay_mul = None
            self._overlay_rim = None
            self._overlay_rim_strips = ()

    @staticmethod
    def _rim_strips(w: int, h: int) -> Tuple["pygame.Rect", ...]:
        """
        The four edge bands the glass rim can possibly touch.

        The rim is a 2 px rounded-rect stroke, so every pixel of it lies within
        the corner radius of an edge.  Blitting only these bands turns a
        full-frame additive blit into about a tenth of one.
        """
        t = max(4, int(CURVATURE_CORNER * min(w, h)) + 4)
        t = min(t, max(2, min(w, h) // 2))
        return (
            pygame.Rect(0, 0, w, t),
            pygame.Rect(0, h - t, w, t),
            pygame.Rect(0, t, t, max(0, h - 2 * t)),
            pygame.Rect(w - t, t, t, max(0, h - 2 * t)),
        )

    @staticmethod
    def _draw_glass_rim(surf: "pygame.Surface", w: int, h: int,
                        *, premultiplied: bool = False) -> None:
        """
        Thin light edge just inside the corner cut: the highlight on glass.

        With `premultiplied` the stroke is written as ``colour * alpha`` on an
        opaque surface, ready to be *added* to the frame; that is the same
        arithmetic an "over" composite of a light colour at low alpha performs,
        minus the ``dst * (1 - a)`` term, which the multiply half of the
        overlay has already applied.
        """
        r = int(CURVATURE_CORNER * min(w, h))
        if premultiplied:
            a = clamp(CURVATURE_RIM_ALPHA / 255.0, 0.0, 1.0)
            col: Any = (P.clamp8(CURVATURE_RIM[0] * a),
                        P.clamp8(CURVATURE_RIM[1] * a),
                        P.clamp8(CURVATURE_RIM[2] * a))
        else:
            col = P.with_alpha(CURVATURE_RIM, CURVATURE_RIM_ALPHA)
        try:
            pygame.draw.rect(surf, col, pygame.Rect(1, 1, w - 2, h - 2), 2,
                             border_radius=max(0, r))
        except (pygame.error, ValueError, TypeError):
            pass

    def set_post_flags(self, *, vignette: Optional[bool] = None,
                       scanlines: Optional[bool] = None,
                       aberration: Optional[bool] = None,
                       bloom: Optional[object] = None,
                       curvature: Optional[bool] = None,
                       grain: Optional[bool] = None,
                       flare: Optional[bool] = None) -> None:
        """
        Toggle post-processing layers; rebuilds the cache only if needed.

        ``bloom`` is the one that takes a value as well as a switch: pass a
        bool to turn it on or off at the current strength, or a number to set
        the strength directly (0 disables it).  Everything else is a plain
        on/off, so a settings screen can trade quality for milliseconds.
        """
        if vignette is not None:
            self.vignette_enabled = bool(vignette)
        if scanlines is not None:
            self.scanlines_enabled = bool(scanlines)
        if aberration is not None:
            self.aberration_enabled = bool(aberration)
        if curvature is not None:
            self.curvature_enabled = bool(curvature)
        if grain is not None:
            self.grain_enabled = bool(grain)
        if flare is not None:
            self.flare_enabled = bool(flare)
        if bloom is not None:
            if isinstance(bloom, bool):
                self.bloom_enabled = bloom
            else:
                try:
                    v = clamp(float(bloom), 0.0, BLOOM_MAX)  # type: ignore[arg-type]
                except (TypeError, ValueError):
                    v = self._bloom_strength
                self.bloom_strength = v
                self.bloom_enabled = v > 0.0
        self._rebuild_overlay()

    def set_quality(self, level: str) -> None:
        """
        Apply one of :data:`QUALITY_LEVELS` as a whole-stack preset.

        The rungs are chosen so that each one actually costs measurably less
        than the one above it, which means splitting on *what is expensive*
        rather than on what sounds fancy.  Only two layers cost real time: the
        chromatic aberration (~3.4 ms, but only while the camera is shaking
        hard) and the bloom (~0.8 ms, every frame).  Everything else - the
        vignette, the curvature, the scanlines, the grain, the flare - is
        pre-rendered and together costs well under a millisecond.

        low     shake and flash only            ~0.15 ms idle,  ~0.2 ms shaking
        medium  + vignette, curvature,
                  scanlines, lens flare         ~0.8 ms idle,   ~0.9 ms shaking
        high    + bloom and grain               ~2.4 ms idle,   ~2.6 ms shaking
        ultra   + chromatic aberration,
                  fatter bloom (the default)    ~2.5 ms idle,   ~5.3 ms shaking
        """
        lv = str(level).lower()
        if lv not in QUALITY_LEVELS:
            return
        if lv == "low":
            self.set_post_flags(vignette=False, scanlines=False, aberration=False,
                                curvature=False, grain=False, flare=False,
                                bloom=False)
        elif lv == "medium":
            self.set_post_flags(vignette=True, scanlines=True, aberration=False,
                                curvature=True, grain=False, flare=True,
                                bloom=False)
        elif lv == "high":
            self.set_post_flags(vignette=True, scanlines=True, aberration=False,
                                curvature=True, grain=True, flare=True,
                                bloom=BLOOM_STRENGTH)
        else:  # ultra
            self.set_post_flags(vignette=True, scanlines=True, aberration=True,
                                curvature=True, grain=True, flare=True,
                                bloom=1.25)

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
        flash overlay, the channel tints, the bloom threshold and gain).  It
        only ever grows, and every caller fills just the sub-rect it needs, so
        one buffer serves the screen, the canvas and the 320x180 bloom ladder
        without a single extra allocation or a wasted full-surface fill.
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


__all__ = [
    "EffectStack",
    "build_vignette",
    "build_scanlines",
    "build_curvature",
    "build_grain_frames",
    "build_flare",
    "build_dissolve_masks",
    "TRANSITION_STYLES",
    "QUALITY_LEVELS",
]
