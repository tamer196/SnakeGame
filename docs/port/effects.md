# Port spec — `snake/gfx/effects.py` → PixiJS v8 post-processing stack

Ground truth: `E:/SnakeGame/snake/gfx/effects.py` (1859 lines, class `EffectStack` +
cached overlay builders). This module is the **entire** screen-feedback layer of the
game: screen shake, chromatic aberration, bloom, colour flash, lens flare, the
CRT overlay (vignette + curvature + scanlines + bezel rim), film grain, the four
scene-transition wipes, and slow motion (a time-scale query, not a visual).

Everything below cites exact constants from the Python. Where a number comes from a
theme it is named by palette key instead. Line references are into `effects.py`
unless stated.

---

## 0. How the stack is driven (contract with the rest of the game)

From `snake/main.py`:

* One `EffectStack` instance lives on the app as `game.fx` (main.py:102).
* `fx.update(dt)` is called once per frame with **real, unscaled** dt
  (main.py:414). Internally dt is clamped to `MAX_DT * 3` = 0.15 s (effects.py:904).
* `fx.present(canvas, present_buf)` composites the finished 1280×720 canvas into a
  1280×720 present buffer (main.py:432); that buffer is then scaled once into the
  window (`_blit_to_window`). **The whole post chain runs at design resolution
  (1280×720), before viewport scaling.**
* `game.switch_scene(...)` calls `fx.begin_transition()` with all defaults
  (main.py:314) — every full scene change gets an auto-cycled wipe.
* Gameplay scenes scale their own dt by `fx.time_scale()` (gameplay.py:561); the
  particles/fx themselves always run at real time.

Runtime pokes from scenes (every call site in the repo):

| Caller | Call |
|---|---|
| gameplay.py:745–746 | `fx.slowmo(*CROSS_TEACH_SLOWMO)`, `fx.flash(col, 0.16)` (self-cross teach moment) |
| gameplay.py:785 | `fx.flash(col, 0.28)` (food eaten) |
| gameplay.py:842–843 | `fx.flash(col, 0.24)`, `fx.shake(2.5)` (power-up pickup) |
| gameplay.py:954 | `fx.flash(col, 0.22)` |
| gameplay.py:980–981 | `fx.flash(col, 0.55)`, `fx.shake(9.0)` (shield save) |
| gameplay.py:1006–1008 | `fx.shake(19.0)`, `fx.flash(P.UI_BAD, 0.85)`, `fx.slowmo(0.35, 0.45)` (death) |
| gameplay.py:1020 | `fx.shake(24.0)` (death, harder variant) |
| gameplay.py:1155 | `fx.flash(theme.accent, 0.7)` (level clear) |
| gameplay.py:425, gameover.py:415 | `fx.set_theme(theme)` (tints future wipes with `theme.accent`) |
| gameover.py:740–741 | `fx.flash(P.shade(theme.hazard, 0.7), 0.35)`, `fx.shake(5.0)` |
| gameover.py:926 | `fx.flash(theme.accent, 0.45)` |
| gameover.py:1042 | `fx.shake(2.0 + 1.5 * idx)` (score tally ticks) |
| level_select.py:520,543 | `fx.flash(diff.color, 0.18)`, `fx.flash(theme.accent, 0.35)` |
| mode_select.py:492 | `fx.flash(theme.accent, 0.30)` |
| settings.py:631–638 | `fx.set_post_flags(bloom=v / scanlines=v / grain=v)`; installs a **shake guard** (see §12) |

Notably: **no caller currently passes `direction=`/`source=` to `shake()`** and no
scene calls `set_quality()` — but both are public API and must be ported (the
settings screen may grow a quality rung; the directional shove is fully implemented
and tested behaviour).

`fx.clear()` kills all live effects (used for hard scene switches).
`fx.screen_offset()` is public (returns this frame's shake offset) though only
`present` uses it internally today.

Failure policy: `present` never raises — any exception falls back to a plain blit of
the canvas (effects.py:947–956). TS equivalent: wrap the filter-chain enable in
try/catch and degrade to the raw scene sprite.

---

## 1. Composition order (the single most important table)

`_present` (effects.py:958–1048) composites in this exact order. "ADD"/"MULT" are
pygame `BLEND_RGB_ADD`/`BLEND_RGB_MULT` = classic additive / multiply blending on
RGB (no alpha participation).

| # | Pass | Blend | Shaken (offset by ox,oy)? | Skip conditions |
|---|---|---|---|---|
| 1 | Base canvas blit at `(ox, oy)` — or the aberrated 3-copy blit | normal (+ADD for the two channel copies) | yes | aberration only when `aberration_enabled && wipe < 0.42 && strength > 0.02` |
| 2 | Black edge strips covering the pixels the shake uncovered | fill | n/a | skipped when `ox == oy == 0` |
| 3 | Bloom buffer added at `(ox, oy)` | ADD | **yes** (blitted at the same shake offset) | `bloom_enabled && strength > 0`; the *rebuild* is skipped while aberrated or `wipe ≥ 0.35` (stale buffer still added) |
| 4 | Colour flash: full-screen `color * min(flash, 1)` | ADD | no | `flash_amount > 0` |
| 5 | Lens flare/streak sprite | ADD | no | `flare_enabled && flare_amount > 0` |
| 6 | CRT overlay: multiply half (vignette+curvature+scanlines), then glass-rim strips | MULT, then ADD | no | any of vignette/scanlines/curvature enabled |
| 7 | Film grain layer at `(-jx, -jy)` | ADD | no | `grain_enabled && !aberrated && wipe < 0.35 && !bloomRebuiltThisFrame` |
| 8 | Transition wipe (iris / sweep / glitch / dissolve) | mixed (see §10) | no | `transition_active` |

`wipe = _transition_cover()` ∈ [0,1] is computed **before** the chain and gates the
self-degrading skips:

```
WIPE_SKIP_CHEAP = 0.35   # drop bloom REBUILD and grain
WIPE_SKIP_HEAVY = 0.42   # drop chromatic aberration too
```

Always-on vs event-driven:

* **Always-on** (when enabled): bloom, CRT overlay, grain, scanlines, vignette.
* **Event-driven**: shake (+directional shove), aberration (a function of shake),
  flash, flare, slow motion, wipes.

---

## 2. Screen shake

Constants (effects.py:90–99, config.py:168):

```
SHAKE_MAX       = 26.0   px, hard cap on amplitude
SHAKE_CUTOFF    = 0.15   px, snap-to-zero threshold
C.SHAKE_DECAY   = 5.5    /s  (exported: web/src/core/config.ts SHAKE_DECAY)
SHAKE_DIR_DECAY = 9.0    /s
SHAKE_DIR_FREQ  = 5.2    Hz
SHAKE_DIR_SHARE = 1.15   shove amplitude as fraction of trauma added
SHAKE_DIR_CUTOFF= 0.20
```

### 2.1 State & API

`shake(amount, *, direction=None, source=None)`:

* `amount ≤ 0` or NaN → ignored.
* If `amount ≥ shake_amount * 0.6` the noise seed is re-randomised
  (`random() * 100`) so consecutive hits do not continue the same wobble.
* `shake_amount = min(26, shake_amount + amount)` — **additive with cap**.
* Directional shove: unit vector from `direction`, or `(center - source)`
  normalised (source is in canvas space, centre is `(WINDOW_W/2, WINDOW_H/2)`).
  New shove is vector-blended into the ringing one weighted by impulse:
  `a = dir * dir_amount + newDir * min(26, amount * 1.15)`; new
  `dir = normalize(a)`, `dir_amount = min(26, |a|)`, `dir_phase = 0`.

### 2.2 Per-frame decay (`update`)

```
shake_amount *= exp(-5.5 * dt);        if < 0.15 → 0
dir_amount   *= exp(-9.0 * dt);        if < 0.20 → { 0, phase = 0 }
dir_phase    += dt * 5.2 * 2π
```

All decays in this module use framerate-independent exponential decay
`v * exp(-rate * dt)` (`_decay`, effects.py:262) — never linear subtraction.

### 2.3 Offset computation (`screen_offset`, effects.py:866)

Smooth pseudo-noise `_noise1(t, seed)` (effects.py:214), range −1..1, weights sum
to 1:

```
noise1(t, s) = sin(t + s)*0.55 + sin(t*2.370 + s*1.7)*0.30 + sin(t*4.110 + s*3.1)*0.15
```

```
ox = noise1(time * 23.0, seed)        * shake_amount        (if amount > 0.15)
oy = noise1(time * 19.0, seed + 7.3)  * shake_amount * 0.85
if dir_amount > 0.20:
    swing = cos(dir_phase)            # starts at full shove, springs back through 0
    ox += dir_x * dir_amount * swing
    oy += dir_y * dir_amount * swing
clamp both to ±(26 * 1.4) = ±36.4, then round to int
```

The offset is **integer-snapped in design pixels**. TS: apply to the composited
scene sprite / base-pass uniform, keep `Math.round`.

Because the frame slides, `_fill_edges` paints black rects `|ox|` wide on left+right
and `|oy|` tall on top+bottom (effects.py:1150–1164) so the screen is always fully
painted. In Pixi the equivalent is either a black backdrop behind the shaken scene
sprite, or clamp-to-black sampling in the base filter (`texture(uv - offset)` with
out-of-range → black).

---

## 3. Chromatic aberration (shake-driven, radial)

Constants (effects.py:108–113):

```
ABERRATION_START    = 6.5    shake px where the split switches on
ABERRATION_FULL     = 15.0   shake px where it reaches full strength
ABERRATION_MAX_PX   = 5.0    max channel offset at the rim
ABERRATION_MASK_MIN = 62     channel tint at faintest (out of 255)
ABERRATION_MASK_MAX = 118    channel tint at strongest
ABERRATION_RINGS    = 5      nested rectangular bands faking the radial ramp
```

Strength: `strength = smoothstep(6.5, 15.0, shake_amount)` (classic Hermite
`t²(3−2t)`, effects.py:254). Path is taken only when `strength > 0.02`.

**What the Python draws** (`_blit_aberrated`, effects.py:1051):

1. Base canvas blitted normally at `(ox, oy)`.
2. Two extra copies of the canvas, each channel-isolated by a MULT with a solid
   tint (`(mask,0,0)` for red, `(0,0,mask)` for blue,
   `mask = round(lerp(62, 118, strength))`), then **ADD**-blitted as displaced
   nested bands:
   * `dmax = round(1.0 + strength * 5.0)` px; `rings = max(2, min(5, dmax + 1))`.
   * The frame is cut into `rings` nested rectangular bands:
     band *i* is between `rect_i = (i·w/(2·rings), i·h/(2·rings))` inset and
     `rect_{i+1}` inset. The innermost block (i = rings−1) is **not displaced**
     ("no aberration on the optical axis").
   * Band *i* displacement magnitude: `d = round(dmax * (rings − i) / rings)`
     (outermost band moves the most; linear falloff to the centre).
   * Direction is per-strip along the outward normal: top strip moves **up** by d,
     bottom strip down, left strip left, right strip right. Red uses `+dmax`
     (spreads outward), blue uses `−dmax` (contracts inward) — edges fringe red on
     the outside, cyan-blue on the inside.
   * Note the horizontal strips span the full band width (corners belong to
     top/bottom strips) — the ramp metric is effectively Chebyshev
     (`max(|nx|,|ny|)`), not Euclidean.

**GLSL translation** (single custom Filter over the base scene texture, replacing
passes 1+2):

Uniforms: `uStrength` (0..1), `uOffset` (shake ox,oy in texels), `uTexelSize`.

```glsl
// nx, ny in -1..1 across the frame
float m      = max(abs(nx), abs(ny));                 // Chebyshev radius
float dmax   = floor(1.0 + uStrength * 5.0 + 0.5);    // px
float rings  = clamp(dmax + 1.0, 2.0, 5.0);
// faithful: quantised band falloff. i = band index from the rim inward:
float band   = min(floor((1.0 - m) * rings), rings - 1.0);  // 0 = outermost
float d      = (band == rings - 1.0) ? 0.0
             : floor(dmax * (rings - band) / rings + 0.5);
vec2  axisDir = (abs(ny) >= abs(nx)) ? vec2(0.0, sign(ny)) : vec2(sign(nx), 0.0);
float mask   = mix(62.0, 118.0, uStrength) / 255.0;
vec3 base = texture(uTex, uv).rgb;
vec3 red  = texture(uTex, uv - axisDir * d * uTexelSize).rgb;  // sample pulled back = copy pushed out
vec3 blue = texture(uTex, uv + axisDir * d * uTexelSize).rgb;
color = base + vec3(red.r * mask, 0.0, blue.b * mask);
```

(The corner ownership rule — horizontal strips win the corners — is captured by the
`abs(ny) >= abs(nx)` axis pick; exact tie behaviour at the diagonal is a sub-pixel
nicety.) A continuous variant (`d = dmax * m`) looks *better* than the CPU band
hack; see Open questions.

The CPU cost notes (tint-blit trick, band tiling) are irrelevant on GPU — one
full-screen filter pass replaces the whole dance.

---

## 4. Bloom

Constants (effects.py:142–163):

```
BLOOM_DOWNSCALE   = 4      first reduction (nearest) → 320×180
BLOOM_THRESHOLD   = 172    per-channel subtractive floor (0..255)
BLOOM_STRENGTH    = 0.72   default add-back gain
BLOOM_MAX         = 2.5    cap on settable gain
BLOOM_REFRESH_HZ  = 22.0   rebuild rate (temporal reuse between rebuilds)
BLOOM_UPSCALE_DIV = 3      intermediate upscale size = full / 3 (426×240)
```

The threshold is **subtractive**, not a step: `c' = max(0, c − 172)` per channel
(pygame `BLEND_RGB_SUB` of a solid (172,172,172), effects.py:1256–1259). This is
deliberate — near-saturated neon sails over it, big blocks of ~white UI text at
value just under 172 produce almost nothing and stay legible.

### 4.1 The ladder (`_refresh_bloom`, effects.py:1239–1296)

All sizes for a 1280×720 canvas; buffers allocated once per canvas size
(`_ensure_bloom_buffers`):

```
canvas (1280×720)
  → small  320×180   nearest downscale
  → subtract 172 grey floor (threshold)
  → tiny    80×45    smooth (bilinear) downscale of small
  → micro   20×11    smooth downscale of tiny            (sizes: small/4, small/16, floors 4 and 3)
  → small2  320×180  smooth upscale of micro   = WIDE octave (atmospheric glow)
  → small   320×180  smooth upscale of tiny    = TIGHT octave (hot halo)
  → small  += small2  (ADD)                    two octaves summed
  → gain:  if g > 1: small += small (double), g *= 0.5
           if g < 0.999: small *= g   (MULT by solid grey g·255)
  → half   426×240   smooth upscale of small   (w/BLOOM_UPSCALE_DIV)
  → full   1280×720  NEAREST upscale of half   (blockiness invisible on this much blur)
full is ADD-blitted onto the screen at the shake offset (ox, oy).
```

The "blur" is purely resample-down-then-up (bilinear); there is no convolution
anywhere. Two octaves at 1/16 and 1/64 of the canvas: tight halo + wide glow.

### 4.2 Temporal reuse & scheduling

* Rebuild only when `time − lastBuild ≥ 1/22 s` **and** refresh is allowed
  (`allow_refresh = !aberrating && wipe < 0.35`), or on the very first frame
  (`_bloom_at < 0` forces it, also set when `bloom_strength` changes).
* Between rebuilds the cached full-res buffer is re-added every frame (so the glow
  is up to ~45 ms stale — invisible on a soft halo).
* `_bloom_rebuilt` is set on rebuild frames; **grain is skipped that frame** so the
  two most expensive optional passes never bill the same frame (effects.py:1032–1043).

### 4.3 PixiJS mapping

Faithful implementation = RenderTexture ladder:

1. Render scene RT → 320×180 RT with a threshold filter
   (`c = max(vec3(0), c - 172.0/255.0)`); use `scaleMode: 'nearest'` on this first
   hop for exactness (or accept linear — see Open questions).
2. Bilinear-sample down to 80×45 and 20×11 RTs (just render a sprite of the larger
   RT into the smaller; Pixi's default linear sampling = pygame smoothscale for 2×+
   steps approximately — pygame's smoothscale is a box/area average, bilinear is
   close at these ratios).
3. Upsample both back to 320×180, sum with an ADD-blend sprite, apply gain
   (sprite `tint`/shader multiply covering the 0..2.5 range; the double-then-halve
   dance is a pygame limitation — one multiply suffices on GPU).
4. Upsample to full and draw as an ADD-blend sprite at `(ox, oy)`.

Keep the 22 Hz refresh and the skip flags if bit-comparable pacing matters; on GPU
the whole ladder is < 0.1 ms so per-frame rebuild is affordable (Open question 3).

---

## 5. Colour flash

Constants: `FLASH_MAX = 1.25` (effects.py:92), `C.FLASH_DECAY = 3.2`/s
(config.ts `FLASH_DECAY`).

* `flash(color, amount)`: amount clamped to [0, 1.25]; if current flash ≤ 0.01 the
  new colour replaces the old, otherwise hue is blended
  `flash_color = lerpColor(old, new, a / (a + current))` — a red hit over a fading
  white flash goes orange. Amount accumulates, capped at 1.25.
* **Auto-flare**: any flash with `amount ≥ 0.20` also fires
  `flare(amount * 0.85, color)` (effects.py:742–743).
* Decay: `flash *= exp(-3.2 dt)`, snap to 0 below 0.004.
* Draw: additive full-screen `rgb = color * clamp(flash, 0, 1)` — the visual
  saturates at 1.0; the 1.25 headroom only extends the time spent at full white.

Pixi: full-screen white-texture Sprite, `tint = rgb(color·a)` (or tint=color,
alpha=a — with `blendMode:'add'` and premultiplied alpha both yield `color·a`
added). One sprite, zero cost.

Pygame perf note (blended `fill` vs blended blit of a cached solid, ~9 ms vs
0.3 ms — effects.py:1002–1014) is CPU-only trivia; no GPU equivalent needed.

---

## 6. Lens flare / anamorphic streak

Constants (effects.py:179–183):

```
FLARE_DECAY  = 4.6 /s
FLARE_LOD    = (144, 40)   authored tiny, smoothscaled up ("the upscale IS the blur")
FLARE_HEIGHT = 0.30        sprite height as fraction of screen → 1280×216
FLARE_MAX    = 1.4         amount cap
```

### 6.1 The sprite (`build_flare`, effects.py:460, built once per size)

Evaluated on the 144×40 grid, `nx, ny ∈ [−1, 1]`:

```
v  = exp(-nx²·2.1) · exp(-ny²·22.0)                        # wide horizontal streak
v += 0.85 · exp(-(nx²·34.0 + ny²·9.0))                     # hot round core
v += 0.30 · 1.0 · exp(-((nx+0.42)²·130 + ny²·26))          # ghost, left
v += 0.30 · 0.8 · exp(-((nx−0.42)²·130 + ny²·26))          # ghost, right
i  = clamp(v, 0, 1)
R = 255·i
G = 238·i·(0.85 + 0.15·(1−|nx|))       # slightly greener in the middle
B = 255·i·(0.70 + 0.30·|nx|)           # bluer at the ends — hue separation
```

On black, opaque; then bilinear-upscaled to (screenW, 0.30·screenH).

### 6.2 Runtime

* `flare(amount, color?, pos?)`: amount clamped [0, 1.4], accumulates capped.
  `pos` in canvas px → normalised; default wander:
  `nx = 0.5 ± U(0.14)`, `ny = 0.5 ± U(0.18)`. Position is only replaced if the new
  amount ≥ current amount (a stronger event re-aims the streak).
  Colour replaces `flare_color` when given.
* Decay `exp(-4.6 dt)`, snap 0 below 0.006.
* Draw (`_draw_flare`, effects.py:1299): `a = clamp(amount, 0, 1)`;
  tint colour whitens as it peaks: `c = lerpColor(flare_color, white, 0.45·a)`;
  sprite pixels multiplied by `c·a` then **ADD**ed, centred at
  `(nx·sw − fw/2, ny·sh − fh/2)`.

Pixi: bake the 144×40 field into a texture once (CPU `ImageData` loop or offline),
one Sprite scaled to 1280×216, `blendMode:'add'`, `tint = rgb(c·a)`.

---

## 7. CRT overlay (vignette + curvature + scanlines + glass rim)

Built **once** per (size, flags) into cached surfaces (`_rebuild_overlay`,
effects.py:1603). All three dark layers are pure black, so their alphas are summed
(`BLEND_RGBA_ADD`) into one RGBA overlay; alpha-blending pure black at alpha *a* is
exactly `dst · (1 − a)`, so pygame pre-bakes a **multiply** surface
(white alpha-composited once → every pixel is `255 − a`) and MULT-blits it.
The light-coloured glass rim can't ride in a multiply, so it is a second surface,
**ADD**ed, and only over the four edge strips it occupies.

**Pixi mapping:** none of that opaque-split machinery is needed. Bake one RGBA
texture (black with the summed alpha) and draw it as a normal-blend Sprite —
mathematically identical — plus a Graphics rounded-rect stroke for the rim with
`blendMode:'add'`. Or do vignette+curvature analytically in the final composite
filter (formulas below are trivially GLSL-able) and keep scanlines in it too.

### 7.1 Vignette (`build_vignette`, effects.py:310)

```
VIGNETTE_TINT     = (2, 3, 9)     (constant, not themed)
VIGNETTE_STRENGTH = 0.42          peak alpha at corners
VIGNETTE_INNER    = 0.55          normalised radius where darkening starts
VIGNETTE_LOD      = (160, 90)     evaluated small, bilinear-upscaled
```

Per pixel, `nx, ny ∈ [−1, 1]`:

```
r = sqrt(nx² + ny²) / √2          # corners at r = 1
a = smoothstep(0.55, 1.0, r) ^ 1.6
alpha = 0.42 · 255 · a            # colour (2,3,9)
```

The `^1.6` keeps the centre perfectly clean and bites at the rim. Tuning note in
source: vignette × curvature × corner-cut compound; corners must keep **>40%
transmission** (a playtest tool enforces `BEZEL_FLOOR`) — do not "improve" the
curves.

### 7.2 Curvature / bezel (`build_curvature`, effects.py:359)

```
CURVATURE_LOD      = (128, 72)
CURVATURE_STRENGTH = 0.28    peak alpha of edge rolloff
CURVATURE_INNER    = 0.80    squircle radius where rolloff starts
CURVATURE_CORNER   = 0.030   corner-cut radius, fraction of min(w,h)  → 21 px at 720
CURVATURE_RIM      = (150, 176, 214)
CURVATURE_RIM_ALPHA= 30
```

There is **no per-pixel warp** — the "curvature" is entirely an overlay illusion:

1. **Squircle rolloff** (evaluated at 128×72, upscaled):
   `e = (|nx|⁴ + |ny|⁴)^0.25; a = smoothstep(0.80, 1.02, e) ^ 1.35;
   alpha = 0.28·255·a`, pure black. A band hugging the whole rim, not just corners.
2. **Hard rounded corner cut** at full resolution (must be crisp — rasterised
   *after* upscale): radius `r = 0.030 · min(w,h)`; each corner scanline y<r fills
   `ceil(r − sqrt(r² − (r−y)²))` opaque black pixels from the edge.
3. **Glass rim highlight**: a 2 px rounded-rect stroke inset 1 px
   (`Rect(1,1,w−2,h−2)`, border_radius = r), colour (150,176,214) at alpha 30 —
   stored premultiplied (`colour · 30/255` on black) and **ADD**ed. The Python only
   adds it over 4 edge strips of thickness `max(4, r+4)` px as a CPU optimisation;
   in Pixi just draw the stroke.

### 7.3 Scanlines

```
SCANLINE_GAP   = 3    one dark line every 3 rows
SCANLINE_ALPHA = 15   black at alpha 15/255 — texture, not stripes
```

1-px black rows at y = 0, 3, 6, … in design space. GLSL:
`if (mod(designY, 3.0) < 1.0) rgb *= 1.0 - 15.0/255.0;` (equivalent to the alpha-15
black over composite).

Flags: `vignette_enabled`, `curvature_enabled`, `scanlines_enabled` each gate their
layer; the overlay is rebuilt only when a flag or size changes (`_overlay_key`).

---

## 8. Film grain

Constants (effects.py:172–177):

```
GRAIN_FRAMES = 3       pre-rendered layers
GRAIN_SPECKS = 3400    specks per layer
GRAIN_FPS    = 24.0    layer advance rate (film rate, not frame rate)
GRAIN_JITTER = 16      layers are 16 px larger than screen (1296×736)
GRAIN_MIN    = 6       speck brightness
GRAIN_MAX    = 34
```

`build_grain_frames` (effects.py:420), seeded `random.Random(0xC0FFEE)`:
each layer is opaque black with 3400 specks at random positions; per speck
`g = randint(6, 34)`, colour `(g, clamp8(g·U(0.82,1.0)), clamp8(g·U(0.86,1.12)))`
(slight colour noise — real grain isn't neutral); 10% of specks are 2×2 px, the
rest 1×1.

Runtime (in `update`, effects.py:927): every `1/24 s` advance
`grain_index += 1`, pick fresh jitter `jx, jy = randrange(0..16)` each. Draw = ADD
blit of `frames[index % 3]` at `(−jx, −jy)`. 3 layers × 17² jitters = enough
distinct combinations that it never reads as a static dirt layer.

Skips (scheduling, not look): dropped while aberrating, while `wipe ≥ 0.35`, and on
any frame the bloom rebuilt (effects.py:1042).

Pixi: generate the 3 oversized textures once via `ImageData`/`Texture.from` (specks
are sparse; a canvas loop at init is fine), one ADD-blend Sprite whose texture and
position swap at 24 Hz. Exact RNG replication is impossible (Python Mersenne
`randrange` sequences) — visual equivalence is the target (Open question 4).

---

## 9. Slow motion (`slowmo` / `time_scale`)

Not visual, but it lives here (effects.py:780–803):

* `slowmo(factor, duration)`: factor clamped [0.05, 1.0); **strongest slowdown
  wins** (`min`), **longest request sets the timer** (`max`).
* `time_scale()`: with `frac = slow_left / slow_total`:
  * `frac ≥ 0.35` → returns `factor` (snaps in instantly — impact!)
  * `frac < 0.35` → `lerp(1.0, factor, easeInOutCubic(frac / 0.35))` — eases back
    to real time over the last 35% of the window.
* `update` ticks `slow_left` down by real dt; on expiry factor resets to 1.

Gameplay multiplies its own dt by this; `fx.update` itself always gets real dt.
TS: same numbers, `easeInOutCubic` from `web/src/core/mathx.ts`.

---

## 10. Scene transitions (wipes)

Shared state (effects.py:185–205, 582–590, 805–848):

```
TRANSITION_STYLES = ("iris", "sweep", "glitch", "dissolve")
C.TRANSITION_TIME = 0.55 s (default duration; min clamp 0.05)
TRANSITION_BAND   = 190.0  glowing-edge thickness term of the sweep
FIELD             = (3, 4, 10)   the opaque "blanked" colour every wipe covers with
DISSOLVE_GRID     = (80, 45); DISSOLVE_STEPS = 18   (16×16 px cells)
GLITCH_BANDS      = 15
transition_color  = theme.accent  (set via set_theme; default THEMES[0].accent = (0,236,255))
```

`begin_transition(duration=0.55, style=None, mode="reveal", color=None)`:

* style: named, or **auto-cycled** — `index += 1; style = STYLES[index % 4]`, so
  successive scene changes never repeat (first-ever auto wipe is "sweep" because
  the index starts at 0 and pre-increments).
* mode: `"reveal"` (uncovers the fresh scene — the default used by
  `switch_scene`), `"cover"`, `"blink"` (cover then reveal in one duration).
* `_trans_flip = random() < 0.5` (mirrors the sweep direction);
  `_trans_seed = randrange(2^20)` (glitch pattern).
* `color` overrides `transition_color` for this and future wipes.

Progress & coverage (`_transition_cover`, effects.py:1346):

```
p = time / total  (clamped 0..1; returns 1.0 when inactive)
cover = mode == "cover"  ? easeInOutCubic(p)
      : mode == "blink"  ? 1 − easeInOutCubic(|2p − 1|)
      :                    1 − easeOutCubic(p)          # "reveal"
```

`cover` ∈ [0,1] = fraction of screen hidden; also drives the §1 skip thresholds.
Transition ends when `time ≥ total` (active flag drops, progress reports 1.0).

**Key pygame trick to port:** `_field_blend(color, alpha) =
opaque lerpColor(FIELD, color, alpha/255)` (effects.py:239). pygame's draw
primitives *write* RGBA instead of compositing, so any glow stroke that sits on the
opaque field is pre-blended against FIELD and drawn opaque — a translucent stroke
would punch a see-through hole in the wipe. In Pixi, Graphics **does** composite
alpha correctly, so you may either draw translucent strokes over the field
(visually identical) or keep the pre-blended opaque colours (bit-identical). Prefer
pre-blended for fidelity.

### 10.1 Iris (`_draw_iris`, effects.py:1388)

Drawn into a transparent full-screen scratch, then normal-blitted.

* `max_r = hypot(sw, sh)/2 + 8` (the +8 keeps corners covered);
  hole radius `r = (1 − cover) · max_r`.
* Dark field: opaque FIELD annulus from `r` out to `max_r`. (pygame draws it as a
  thick circle of width `rad − inner + 2` — the +2 closes int-truncation seams; at
  `inner ≤ 1` it's a filled circle.) Pixi: `Graphics` circle with hole, or a ring.
* Neon rim, centred on the hole edge — four strokes, soft-to-hot
  (grow px added to radius, stroke width, alpha, colour):

  | grow | width | alpha | colour |
  |---|---|---|---|
  | 14 | 16 | 34  | accent |
  | 7  | 9  | 78  | accent |
  | 2  | 4  | 165 | accent |
  | 0  | 2  | 255 | `lerpColor(accent, white, 0.35)` |

  All strokes sit at radius ≥ r (inside the field) → `_field_blend`ed opaque.

### 10.2 Sweep (`_draw_sweep`, effects.py:1431)

Half-plane travelling along the main diagonal.

* `span = (sw + sh) + 190`; boundary line is `x + y = edge`,
  `edge = (1 − cover) · span`. Covered half-plane: `x + y > edge`.
  If `_trans_flip`, mirror x (`x → sw − x`), i.e. the line becomes `y − x = edge − sw`.
* Field: the covered half-plane filled opaque FIELD (polygon in pygame; a
  half-plane test in GLSL or a rotated quad in Pixi).
* Glow strokes parallel to the boundary (normal = (1,1)/√2 into the covered side),
  offset along that normal:

  | offset (px along normal) | width | colour | notes |
  |---|---|---|---|
  | −7.0 | 8 | accent at **true alpha 46** | on the *revealed* side — genuine alpha over the scene |
  | +width/2+1 = 14 | 26 | field-blend(accent, 30) | opaque |
  | +7  | 12 | field-blend(accent, 90) | opaque |
  | +3.5 | 5 | field-blend(accent, 180) | opaque |
  | +2  | 2 | field-blend(lerpColor(accent, white, 0.45), 255) | hot core |

  (Covered-side strokes are each pushed clear of the boundary by half their own
  width + 1 so they never bleed onto the revealed scene.)

### 10.3 Glitch (`_draw_glitch`, effects.py:1539)

Operates on **the already-composited screen** (it re-reads the frame): pygame
copies the screen into a scratch once, then rebuilds each band from that copy.
Pixi options: a custom Filter applied to the final composite (natural fit — the
whole effect is a per-band UV shift, easy in GLSL), or RenderTexture snapshot +
band sprites. Recommend the filter.

Per frame:

* `bands = 15`, band height `sh/15`.
* `tick = floor(trans_time · 26) + seed` — time is quantised so the tear pattern
  holds for ~2 frames (strobing at 60 Hz reads as noise, not signal fault).
* `amp = sw · 0.16 · cover` (max horizontal shift); `eaten = cover²`.
* Deterministic per-band hash `_hash01(n)` (effects.py:231):

  ```
  x = (n · 1103515245 + 12345) & 0x7FFFFFFF
  x ^= x >> 13
  x = (x · 1274126177) & 0x7FFFFFFF
  return (x & 0xFFFF) / 65535
  ```

  (Beware: the multiplies must be done with 32-bit/wrapping semantics —
  in JS use `Math.imul` + `>>> 0` masking; exact reproduction matters because the
  pattern is seeded per-transition.)
* Per band i: fill the band FIELD; `r = hash01(tick·131 + i·7919)`;
  `r < eaten` → band stays blank (swallowed).
  Else `shift = int((hash01(tick·977 + i·313) − 0.5) · 2 · amp)`; band re-drawn
  shifted with **horizontal wraparound**.
* Bands with `r < eaten + 0.20` (about to die) additionally get:
  ghost copy **ADD**ed at `shift ± 7` (+7 on odd bands, −7 on even), and two 2-px
  fringe rows ADDed across the band top and bottom: `(170, 0, 80)` on odd bands,
  `(0, 130, 190)` on even.
* A scanning accent bar: 2-px line at `y = (trans_time · 900) mod sh`, colour
  `lerpColor(accent, white, 0.5)` (normal blend).

### 10.4 Dissolve (`_draw_dissolve`, effects.py:1486; `_build_dissolve`, 502)

* 80×45 cell grid (16×16 px cells at 1280×720), a fixed random permutation of all
  3600 cells (`random.Random(0x5EED).shuffle`), 18 pre-rendered coverage masks:
  mask k has the first `round(3600 · k/17)` cells filled opaque FIELD.
* `step = round(cover · 17)`; masks are upscaled **nearest** (the hard 16×16 blocks
  *are* the effect) and only when the step index changes.
* Glowing dissolve front: the cells the *next* step will swallow
  (`cells[bounds[step] .. bounds[step+1]]`) are filled with
  `field_blend(lerpColor(accent, white, 0.30), 190)`, block size
  `(floor(cw)+1, floor(ch)+1)` at `(floor(gx·cw), floor(gy·ch))`.
* Blitted normal (opaque cells over the scene).

Pixi recommendation: one 80×45 R-channel **rank texture** (rank = cell's position
in the permutation / 3599, nearest sampling) + a tiny fragment shader:
`covered = rank < uCover; front = rank < uCover + uFrontWidth;` — replaces 18 masks
and the front-painting loop with two uniforms. Faithful alternative: pre-render the
18 masks exactly. Either way the permutation seed/order must be fixed per build,
not per transition (it is a module-level constant in Python).

---

## 11. Quality presets & flags

`set_post_flags(vignette=, scanlines=, aberration=, bloom=, curvature=, grain=, flare=)`
(effects.py:1727): plain booleans, except `bloom` which accepts a bool (toggle at
current strength) **or** a number (sets `bloom_strength`, 0 disables). Rebuilds the
overlay cache only when needed.

`bloom_strength` property: clamped [0, 2.5]; setting it forces a bloom rebuild next
frame.

`set_quality(level)` presets (effects.py:1766):

| level | vignette | scanlines | curvature | flare | grain | bloom | aberration |
|---|---|---|---|---|---|---|---|
| low    | ✗ | ✗ | ✗ | ✗ | ✗ | off | ✗ |
| medium | ✓ | ✓ | ✓ | ✓ | ✗ | off | ✗ |
| high   | ✓ | ✓ | ✓ | ✓ | ✓ | 0.72 | ✗ |
| ultra  | ✓ | ✓ | ✓ | ✓ | ✓ | **1.25** | ✓ |

(Default-constructed stack ≙ ultra except bloom strength starts at 0.72.)
The settings scene currently exposes only bloom / scanlines / grain / shake
toggles (settings.py:622–643).

## 12. The shake guard (settings.py:174–196)

Settings installs `fx.shake_enabled` by monkeypatching: it wraps `fx.shake` in a
guard that no-ops when `fx.shake_enabled` is false. **Port this as a first-class
boolean on the TS EffectStack** (`shakeEnabled`, default true, checked at the top
of `shake()`); replicate the flag name the settings scene reads/writes.

---

## 13. Coordinate spaces

* All effect maths is in **design pixels** (1280×720, `C.WINDOW_SIZE`); the Python
  post chain runs on the 1280×720 canvas *before* the single scale-to-window blit.
* `shake(source=...)` takes canvas-space points; centre = (640, 360).
* `flare(pos=...)` takes canvas-space, normalised by (1280, 720).
* Normalised-coordinate conventions inside builders: `nx, ny ∈ [−1, 1]` across the
  surface; vignette divides Euclidean r by √2 so corners land at 1; curvature uses
  the 4-norm squircle; aberration uses nested rects (≈ Chebyshev).
* **Web divergence to resolve:** the web `Viewport` exposes an *overscan* rect that
  fills the whole screen beyond 1280×720 (no letterbox), while Python letterboxes.
  The CRT bezel/vignette/corner-cut is authored as a frame around the **design
  rect**. See Open question 1.

Suggested Pixi architecture: render the scene stack into a 1280×720
RenderTexture; the effect stack owns (a) the base sprite (shaken, aberration
filter), (b) bloom ladder RTs + ADD sprite, (c) flash/flare/grain ADD sprites,
(d) the overlay sprite or a composite filter, (e) the wipe layer (Graphics +
glitch filter). Alternatively a small number of custom Filters on `Game.overlay`
— but bloom's multi-resolution ladder and the wipes' vector shapes fit the
RT+sprite model better than one mega-shader.

---

## 14. TS mapping notes (data & API sources)

| Python input | TS source |
|---|---|
| `C.WINDOW_W/H/SIZE` (1280×720) | `web/src/core/config.ts` `WINDOW_W`, `WINDOW_H` |
| `C.SHAKE_DECAY` = 5.5 | `config.ts` `SHAKE_DECAY` |
| `C.FLASH_DECAY` = 3.2 | `config.ts` `FLASH_DECAY` |
| `C.TRANSITION_TIME` = 0.55 | `config.ts` `TRANSITION_TIME` |
| `C.MAX_DT` = 1/20 | `config.ts` `MAX_DT` |
| `P.clamp8 / lerp_color / with_alpha / shade` | `web/src/core/palette.ts` `clamp8`, `lerpColor`, `withAlpha`, `shade` |
| `P.THEMES[i].accent` (wipe tint) | `web/src/core/palette.ts` `THEMES` / `web/src/data/themes.json` `accent` |
| `theme.hazard`, `P.UI_BAD` (callers' flash colours) | `palette.ts` theme fields / UI constants |
| `clamp, lerp, ease_in_out_cubic, ease_out_cubic` | `web/src/core/mathx.ts` (`easeInOutCubic`, `easeOutCubic`) |
| Module-local constants (SHAKE_MAX … GLITCH_BANDS) | not exported anywhere — **copy them into the TS effects module verbatim** (they are post-chain-only tuning; config.json does not carry them) |
| `FIELD`, `VIGNETTE_TINT`, `CURVATURE_RIM` | literal constants in effects.py (not themed) — copy |
| Viewport / scaling | `web/src/app/Viewport.ts` (`scale`, `offsetX/Y`, `overscan`) |
| Scene render target | `web/src/app/Game.ts` `world` container (scenes) + `overlay` container (post/debug) |

PixiJS v8 references: `web/node_modules/pixi.js/skills/` — `pixijs-filters` (custom
Filter + GlProgram, uniform groups), `pixijs-graphics` (wipe shapes),
`pixijs-textures` (RenderTexture ladder, scaleMode nearest/linear, generating
textures from canvases).

pygame-idiom → Pixi cheat sheet for this file:

| pygame trick | Pixi v8 equivalent |
|---|---|
| `BLEND_RGB_ADD` blit | Sprite/Graphics `blendMode: 'add'` |
| `BLEND_RGB_MULT` blit (overlay) | not needed — normal alpha blend of the black RGBA overlay is exact; or `'multiply'` blendMode |
| `BLEND_RGB_SUB` threshold | threshold filter: `max(c - t, 0)` in GLSL |
| solid-fill + blended blit (perf hack) | plain tinted sprite |
| smoothscale down/up ladder (bloom blur) | RenderTexture ping-pong with linear sampling |
| nearest upscale (bloom final, dissolve) | `scaleMode: 'nearest'` texture / sprite scale |
| pre-rendered LOD surfaces (vignette/curvature/flare at 96–160 px wide) | either bake same-size textures once, or evaluate analytically in a filter (they're closed-form) |
| per-pixel `set_at` loops at init | one-time `ImageData` → `Texture.from(canvas)` |
| screen self-read (glitch) | custom Filter over the composited frame (filters receive the rendered input texture) |
| `pygame.draw.circle` width-N annulus / polygon / line strokes | `Graphics` stroke/fill (v8: `.circle().stroke({width, color, alpha})`) |
| monkeypatched `fx.shake` guard | first-class `shakeEnabled` flag |

---

## 15. Invariants worth asserting

1. `0 ≤ shake_amount ≤ 26`; `|screen_offset| ≤ 36.4` and integer.
2. `_noise1` ∈ [−1, 1] (weights 0.55+0.30+0.15 = 1).
3. `0 ≤ flash ≤ 1.25`, `0 ≤ flare ≤ 1.4`, `0 ≤ bloom_strength ≤ 2.5`.
4. `transition_progress == 1.0` whenever no wipe is active; `cover` ∈ [0,1].
5. Every pixel of the output is painted every frame (base + edge fills + wipes) —
   the caller never clears.
6. All decays are `exp(-rate·dt)` with real (unscaled) dt, dt clamped ≤ 0.15 s,
   NaN/≤0 dt ignored.
7. Steady state allocates nothing per frame: textures/RTs are keyed on size and
   rebuilt only when size or flags change (`_overlay_key`, `_bloom_key`,
   `_grain_key`, `_flare_key`, `_dissolve_key` all follow this pattern).
8. `update` and `present` are safe to call in any state; `present` never throws
   (falls back to the raw scene).
9. Wipe field colour is exactly FIELD (3,4,10) — glow strokes on the covered side
   never introduce transparency holes.
10. Grain layer changes at exactly 24 Hz regardless of frame rate; bloom rebuild at
    ≤ 22 Hz (if the temporal reuse is kept).

Performance-critical things Python caches (port the *caching intent*, not the CPU
workarounds): the CRT overlay (rebuilt only on size/flag change), bloom ladder
buffers, the 3 grain textures, the flare texture, dissolve masks/rank data, the
per-size scratch/solid buffers (GPU: RTs). The scheduling hacks (22 Hz bloom,
grain/bloom staggering, WIPE_SKIP thresholds, aberration heavy-path gating) exist
purely for CPU budget — see Open question 3 for whether to keep them.

---

## 16. Filter/uniform sketches (GLSL-ready)

All filters sample the composited-so-far frame unless noted. `uTexel = 1/vec2(1280,720)`.

**BaseShakeAberration** (replaces passes 1–2; can also just move the sprite and
keep aberration separate):
uniforms `uOffsetPx: vec2`, `uStrength: float (0..1)`. Formula in §3. Out-of-range
samples → black (matches `_fill_edges`).

**BloomThreshold**: `uThreshold = 172/255` → `max(rgb - uThreshold, 0.0)`.
**BloomCombine**: `uGain (0..2.5)` → `frame + gain * (tight + wide)` via ADD sprite
with tint/shader multiply.

**Flash**: no shader needed — ADD sprite, `tint = color`, `alpha = min(flash, 1)`.

**CRTComposite** (optional single filter replacing the baked overlay):
uniforms none (all constants). Per design-space pixel p, `n = 2p/size − 1`:
```glsl
float vig  = pow(smoothstep(0.55, 1.0, length(n) * 0.70710678), 1.6) * 0.42;
float crv  = pow(smoothstep(0.80, 1.02, pow(dot(n*n, n*n), 0.25)), 1.35) * 0.28; // (nx^4+ny^4)^(1/4)
vec3 tint  = vec3(2.0, 3.0, 9.0) / 255.0;
rgb = mix(rgb, tint, vig);           // alpha-over of tinted black
rgb *= 1.0 - crv;                    // pure black rolloff
if (mod(designY, 3.0) < 1.0) rgb *= 1.0 - 15.0/255.0;   // scanlines
// corner cut: distance to rounded-rect(r = 0.030*min(w,h)) > 0 → rgb = 0
// rim: 2px rounded-rect ring at inset 1 → rgb += vec3(150,176,214)/255 * (30/255)
```

**Grain**: keep as ADD sprite of pre-baked speck textures (see §8) — a hash-noise
shader would change the look (sparse specks vs full-field noise).

**GlitchWipe** filter: uniforms `uCover`, `uTick (float, pre-hashed on CPU or hash
in-shader with imul-compatible ops)`, `uAccent: vec3`, `uTime`. Per §10.3.

**Dissolve** filter: uniforms `uCover`, `uFrontColor`, plus the 80×45 rank texture
(nearest). Field FIELD; front where `uCover ≤ rank < nextStepBound` if the 18-step
quantisation is kept (`step = round(cover·17)`, bounds from the permutation counts).

Iris and sweep are best drawn as Graphics geometry (they are strokes and fills, not
per-pixel functions).

---

## 17. Open questions (do not guess — decide with the user/lead)

1. **Overscan vs letterbox.** Python letterboxes; the web `Viewport` fills the
   whole screen (overscan). Should the CRT bezel/vignette/corner-cut frame the
   1280×720 design rect (leaving overscan showing background beyond the bezel), or
   stretch to the physical screen edge? The corner cut + rim read as a physical
   tube — framing the design rect seems intended (the web shell already "softened
   the CRT bezel" per commit 19513eb), but confirm.
2. **Aberration fidelity.** Replicate the 5-ring quantised Chebyshev displacement
   exactly (a CPU-cost artefact), or use the continuous radial ramp
   (`d = dmax·max(|nx|,|ny|)`) the rings were approximating? GPU makes the honest
   version free and it looks strictly better; but "bit-identical port" argues for
   the rings.
3. **CPU-budget scheduling.** Keep the 22 Hz bloom refresh, bloom/grain frame
   staggering, and WIPE_SKIP layer drops (behaviour-identical), or run everything
   per-frame on GPU (visually smoother, diverges from ground truth)? These are
   observable (a 22 Hz glow shimmer vs continuous).
4. **RNG parity.** Grain speck layout, flare wander, wipe flip/seed, shake seed all
   use Python's Mersenne `random` — not reproducible in JS. Assume visual
   equivalence with any decent PRNG is acceptable? (The glitch `_hash01` IS exactly
   reproducible and should be, since it shapes the whole effect.)
5. **Bloom resampling kernel.** pygame `smoothscale` is an area-average (box)
   filter; GPU bilinear differs slightly on the >2× hops (e.g. 320×180 → 80×45).
   Accept bilinear, or do 2-tap-chained halvings for closer parity?
6. **Nearest hops in bloom.** The initial /4 nearest downsample and the final
   nearest upscale were perf hacks with visible-but-hidden blockiness. Keep nearest
   (faithful) or use linear (cleaner)? Recommend faithful first, then A/B.
7. **`present_buf` intermediate.** Python composites into a 1280×720 buffer then
   scales once to the window (integer-scale → nearest, else smooth). Should the web
   replicate this pixel pipeline (render all post at 720p then scale the final RT),
   or run filters at device resolution? 720p-then-scale is the faithful option and
   cheaper; device-res looks sharper. Related to Q1.
