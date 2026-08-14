# Port spec — Animated backgrounds, stages 5–8

**Source of truth:** `snake/gfx/background.py` (classes `OceanBackground`, `StaticBackground`,
`IceBackground`, `SporeBackground`). The Python file must not be modified.

**Scope of this document:** the four styles used by levels 5–8 (1-based):

| Stage | Level name    | `bg_style` | Python class       | Theme index (0-based) |
|-------|---------------|------------|--------------------|-----------------------|
| 5     | Abyssal Tide  | `ocean`    | `OceanBackground`  | 4                     |
| 6     | Violet Static | `static`   | `StaticBackground` | 5                     |
| 7     | Frozen Vault  | `ice`      | `IceBackground`    | 6                     |
| 8     | Toxic Bloom   | `spores`   | `SporeBackground`  | 7                     |

The shared `Background` framework (base gradient + centre lift, focus parallax, the
~84 s colour-drift vignette, glow-sprite cache, seamless tile builder, layer/strip
helpers, `update`/`draw` contract, error-swallowing) is **another agent's spec**
(`docs/port/background-framework.md` or equivalent). This document only restates the
exact framework formulas each stage *consumes*, so the numbers below are self-contained,
and otherwise references it as "the framework".

---

## 0. Framework facts these four styles depend on

All coordinates are in **design pixels** of the fixed 1280×720 canvas. The background
paints the **arena rect** `(ARENA_X, ARENA_Y, ARENA_W, ARENA_H) = (14, 78, 1252, 628)`
(`web/src/core/config.ts`). Inside a style, `w = 1252`, `h = 628`, `ox = 14`, `oy = 78`.
Painting is clipped to the arena rect (pygame `set_clip`; in Pixi use a rectangular
mask / scissor on the background container). Overscan beyond 1280×720 is the
Viewport's problem, not the background's.

- **Margin.** Pre-rendered layers carry `_MARGIN = 36` px of slack on every side so
  focus parallax never drags an empty edge into view. Arena-local (0,0) sits at layer
  pixel (36,36) for `_new_layer` layers, and at (0,36) for `_new_strip` strips.
- **Focus parallax.** `_par(depth) = (-fx·22·depth, -fy·22·depth·0.62)` where
  `fx, fy` are the smoothed focus offsets in [-1, 1] (time constant `FOCUS_TAU = 1.4 s`,
  exponential: `f += (target - f) · clamp(dt/1.4, 0, 1)` per frame). Depth 0 = infinitely
  far, 1 = right behind the snake.
- **Layer blits.**
  - `_blit_layer(surface, layer, depth, dx, dy)`: additive blit at
    `(ox - 36 + px + dx, oy - 36 + py + dy)`, ints.
  - `_wrap_add(surface, strip, dx, dy, depth)`: horizontally wrapping additive blit of a
    strip with period `lw = strip.width`: `x = ox + ((dx + px) mod lw) - lw`,
    `y = oy - 36 + dy + py`, blitted twice at `x` and `x + lw`.
    **`mod` must be Python-style (always non-negative)** — JS `%` returns negatives.
- **Blend modes.** `BLEND_RGB_ADD` on black-backed opaque surfaces → Pixi
  `blendMode: 'add'`. `BLEND_RGB_MULT` → `blendMode: 'multiply'`. Layers built with
  `SRCALPHA` and blitted without flags (only the ice crystals here) → `'normal'`.
- **Glow sprites.** `_glow_sprite(radius, color, intensity, steps=14)` is a black-backed
  radial with brightness profile `pixel(d) = color × intensity × (1 − (d/R)²)`,
  quantised into `steps` concentric discs (overwritten outside-in, not summed), stamped
  centred with ADD. The framework spec covers the cache; in Pixi the natural equivalent
  is **one white radial-gradient texture** whose alpha ramp follows `1 − x²`
  (x = d/R), used by additive Sprites with `tint = color`, `alpha = intensity`,
  `scale = R / textureR`. Every intensity used by stages 5–8 is ≤ 1.0, so no
  over-unity handling is needed. Radius/intensity quantisation in Python is purely a
  cache-thrash guard, not a look; the smooth texture is the correct port.
- **Seamless tiles.** `_seamless_layer(w, h, tile_px, cells, fn)` samples `fn(u,v)`
  (unit square, wrapping) on a `(cells+1)²` grid, bilinearly upscales to
  `tile_px × tile_px` (with the duplicated row/column giving real data across the
  seam), then tiles it over a `(w+tile_px) × (h+tile_px)` surface so **one blit at any
  offset in [0, tile_px)** covers the arena. Pixi equivalent: build the tile once into
  a Canvas/ImageData texture (sampled at `(cells+1)²`, drawn scaled with
  `imageSmoothingEnabled` = true, cropped to `tile_px`), set `wrapMode: 'repeat'`,
  display via a **TilingSprite** sized `(w, h)` at `(ox, oy)` with
  `tilePosition = (offsetX, offsetY)` and `blendMode: 'add'`. This replaces the whole
  oversized-surface trick.
- **Soft (quarter-scale) layers.** `_soft_layer(4)` / `_soft_strip(4)` stamp glows into
  a quarter-resolution scratch and upscale once with `smoothscale` (bilinear ≈ cheap
  blur). Pixi equivalent: render the blobs once into a quarter-size **RenderTexture**
  and display it as a Sprite scaled ×4 with linear filtering — or simply render the
  glow sprites at full size into the RenderTexture, since the build is one-time; the
  quarter-scale pass exists for CPU cost, and the slight extra blur it adds is part of
  the look, so prefer replicating it.
- **Per-style RNG.** `random.Random(abs(hash((style, theme.name))) & 0xFFFFFFFF)`.
  Python's `hash()` of strings is salted per process (`PYTHONHASHSEED`), so **the exact
  layout is not reproducible even between two runs of the Python game** — only the
  distributions matter. The TS port should use the shared seeded PRNG from the core
  port with any fixed per-(style, theme) seed. All `uniform / randint / randrange /
  choice` calls below are on this per-style RNG. Note `randint(a,b)` is inclusive of
  both ends.
- **Draw pipeline per frame** (framework): blit base gradient (with baked centre lift)
  at `(ox, oy)` → clip to arena → `_paint()` (everything below) → multiply the drift
  vignette over the arena. Update clamps `dt` to `MAX_DT = 1/20` and advances `t`.

Colour helpers: `shade(c, f)` = per-channel multiply, clamped 0..255, truncating;
`_mix(a, b, t)` = `lerpColor`; `with_alpha(c, a)` = RGBA. All exist in
`web/src/core/palette.ts` as `shade`, `lerpColor`, `withAlpha` (plus `clamp8`, `toHex`).
`_bg_at(y)` = `lerpColor(theme.bgTop, theme.bgBottom, clamp(y/h, 0, 1))`.

Theme keys are named per element below; **never copy hex values** — they come from
`web/src/data/themes.json` via `THEMES[index]` / `themeForLevel(index)`
(`web/src/core/palette.ts`).

---

## 1. Stage 5 — `ocean` (Abyssal Tide, theme index 4)

Class `OceanBackground`, lines 1189–1303. Five depths, painted in this order:

| # | Layer          | Depth | Kind                          | Blend |
|---|----------------|-------|-------------------------------|-------|
| 1 | Deep bloom     | 0.10  | Pre-rendered soft layer       | add   |
| 2 | Swell sheet    | 0.35  | Seamless tile, scrolling      | add   |
| 3 | Caustic sheet  | 0.70  | Seamless tile, scrolling      | add   |
| 4 | God rays (×5)  | 0.55  | Pre-rendered wedges, swaying  | add   |
| 5 | Bubbles (×42)  | 0.95  | Glow sprite + stroked circle  | add + normal stroke |

Build-time constant: `tile = 384`; `light = lerpColor(accent, accent2, 0.5)`.

### 1.1 Deep bloom (build once)

Quarter-scale soft layer (`div = 4`). One radial sprite: radius `h·0.42/div`, colour
`shade(accent2, 0.07)`, intensity 1.0, **steps 8**. Stamped 7 times, additively, at

```
x = (36 + w·(i + 0.5)/7) / div          for i in 0..6
y = (36 + rng.uniform(-h·0.1, h·0.5)) / div
```

then upscaled to the full `(w+72) × (h+72)` layer. Painted per frame with
`_blit_layer(depth = 0.10)`.

### 1.2 Swell (`caustic_b`) — seamless tile, period 256, cells 24

```
swell(u, v):  k = (0.5 + 0.5·sin((u·1 + v·2)·TAU))²
              colour = shade(theme.grid, 0.16·k)
```

Offsets `cb = [x, y]` animated: `cb[0] -= 5·dt (mod 256)`, `cb[1] += 3·dt (mod 256)`
(Python mod: keep in [0, 256)). Painted at parallax depth **0.35**:
pygame blits the oversized layer at
`(ox - 256 + (cb[0]+px) mod 256, oy - 256 + (cb[1]+py) mod 256)`; in Pixi this is a
TilingSprite covering the arena with `tilePosition.x = cb[0] + px`,
`tilePosition.y = cb[1] + py` (sign convention: pygame moves the layer *right/down* as
the offset grows; TilingSprite's `tilePosition` matches — verify once against Python
with a marked tile).

### 1.3 Caustics (`caustic_a`) — seamless tile, period 384, cells 48

```
caustic(u, v):
  s = sin((u·3 + v·2)·TAU + 0.7) + sin((u·2 − v·5)·TAU + 2.1) + sin((u·5 + v·3)·TAU + 4.3)
  k = (1 − clamp(|s|/3, 0, 1))^14
  colour = shade(light, 0.34·k)
```

Three co-prime sine gratings; the `^14` lights only the zero-crossing filaments —
this *is* the water-caustic look; get the phases (0.7, 2.1, 4.3) and frequency pairs
exactly right. Offsets `ca`: `ca[0] += 13·dt (mod 384)`, `ca[1] += 7·dt (mod 384)`.
Painted at parallax depth **0.70**, same tiling scheme as 1.2.

### 1.4 God rays (build 5, sway per frame)

Per ray at build:

- `rw = rng.uniform(w·0.06, w·0.14)` (int) — half-width of the wedge sprite.
- Built at quarter height `rh = max(8, h // 4)` into a black `(rw·2) × rh` surface,
  rows stamped every 2 px:
  `f = (1 − yy/rh)^1.6`, `half = rw·(0.35 + 0.65·yy/rh)`,
  `fill(shade(accent2, 0.09·f), rect(rw − half, yy, half·2, 2))`
  — i.e. a wedge that is **narrow and bright at the top, wide and dim at the bottom**.
- `smoothscale` to `(rw·2, h)` (×~4 vertical stretch = vertical blur).
- Stored with `x0 = rng.uniform(0, w)`, `speed = rng.uniform(0.12, 0.3)`,
  `ph = rng.uniform(0, TAU)`.

Per frame (parallax depth **0.55**, x-component only; the ray is blitted at `y = oy`,
no vertical parallax):

```
x = x0 + sin(t·speed + ph) · w·0.06 + px
blit centred horizontally: (ox + x − rayWidth/2, oy), blend add
```

Pixi: one texture per ray (or one shared texture scaled per ray — widths differ but the
profile is identical in normalized coords; per-ray texture is the literal port,
a shared texture with `scale.x = rw/refW` is visually identical and cheaper).

### 1.5 Bubbles (42, per frame)

State per bubble `[x, y, riseSpeed, r, ph]`; spawn (`_new_bubble`):
`x = uniform(0, w)`, `y = h + 10` (respawn) or `uniform(0, h)` (initial),
`riseSpeed = uniform(14, 46)`, `r = uniform(2, 7)`, `ph = uniform(0, TAU)`.

Animate: `y -= riseSpeed·dt`; `ph += 1.3·dt`; `x += sin(ph)·12·dt`;
respawn when `y < −12`.

Paint at parallax depth **0.95** (`sx = ox + x + px`, `sy = oy + y + py`):

1. Glow: `_glow_sprite(int(r·2), accent2, 0.34)` added at (sx, sy).
2. Meniscus: a 1-px stroked circle, radius `int(r)`, colour
   `rimCols[clamp(int(y·8/h), 0, 7)]` where the 8 pre-computed depth bands are
   `rimCols[i] = lerpColor(_bg_at(h·(i+0.5)/8), accent2, 0.55)` — the ring darkens
   toward the bottom of the arena because it borrows the gradient behind it.
   Drawn **normal blend** (pygame `draw.circle` overwrites).

Pixi: pool of 42 (glow Sprite + Graphics/circle-texture Sprite) pairs, repositioned
per frame. The 8-band rim colours can be pre-tinted circle textures (8 variants) so no
per-frame Graphics rebuild is needed.

---

## 2. Stage 6 — `static` (Violet Static, theme index 5)

Class `StaticBackground`, lines 1309–1453. Class constants: `STREAKS = 24`,
`SCAN_PERIOD = 4`, `NOISE = 192`. Paint order (all screen-space, no margin except the
signal layers' tiling):

| # | Layer                 | Depth / motion                          | Blend    |
|---|-----------------------|------------------------------------------|----------|
| 1 | Signal bands ×3       | parallax 0.20 / 0.55 / 0.90; scroll down | add      |
| 2 | Streaks ×24           | fully random every frame                 | add      |
| 3 | Snow (grain tiles)    | random origin every frame                | add      |
| 4 | Interference tears    | spawned bursts, ≤ 20 alive               | add + 2 normal lines |
| 5 | Signal bar            | scrolls down, period h+120               | add      |
| 6 | Scanlines             | scrolls down 24 px/s, period 4           | **multiply** |

Build-time colours:

- `speckCols = [shade(accent, 0.75), shade(accent2, 0.70), shade(text, 0.55), shade(grid, 1.4)]`
- `streakCol = shade(accent2, 0.30)`
- `bandCol = lerpColor(grid, accent2, 0.4)`

### 2.1 Signal bands (3 seamless tiles, period `sig_period = 256`, cells 32)

For `k = 0, 1, 2` with `(freq, amp) = (2.0, 0.30), (3.0, 0.20), (5.0, 0.13)`:

```
band_k(u, v): s = 0.5 + 0.5·sin(v·TAU·freq + sin(u·TAU)·0.6 + k)
              colour = shade(bandCol, amp·s³)
```

(The `sin(u·TAU)·0.6` term bends the bands horizontally; `+k` de-phases the layers.)

Animate: `sigY[k] += sigSpeed[k]·dt (mod 256)` with `sigSpeed = (16, 38, 74)` px/s —
bands drift **downward**. Horizontal *jitter* per layer, updated once per `_animate`:

```
jitter[k] = rng.uniform(-14, 14)·(k+1)   with probability 0.28
          = jitter[k] · 0.5              otherwise (decay)
```

Paint layer `k` at parallax depth `0.2 + 0.35·k` (→ 0.20, 0.55, 0.90):
tile offset x = `px + jitter[k]`, y = `sigY[k] + py` (Python-mod 256; TilingSprite).
Note: **x never scrolls** — only parallax + jitter; y scrolls continuously.

### 2.2 Streaks (torn signal chunks, per frame)

A pre-rendered `260 × 3` solid strip of `streakCol`. Per frame, 24 additive blits at
`(ox + rng.randrange(w), oy + rng.randrange(h))` with source sub-rect
`(0, 0, rng.randint(30, 260), rng.randint(1, 3))` — random length 30..260, random
thickness 1..3. Pixi: pool of 24 Sprites over a 1×1 white texture, tinted `streakCol`,
`blendMode 'add'`, `scale = (len, thick)`, repositioned per frame. Uses the style RNG
**inside paint** — per-frame random is intentional (it's TV snow); no need to
preserve the stream.

### 2.3 Snow — pre-rendered grain tiles

Build: `_noise_tiles(192, 6, 170, speckCols, rng)` → **6 black tiles of 192×192**, each
with 170 specks: `fill(speckCols[rng.randrange(4)], (rng.randrange(192),
rng.randrange(192), rng.randint(1, 4), 1))` — 1-px-tall dashes 1..4 px wide.

Per frame: pick `idx = rng.randrange(6)`, random origin
`x0 = ox − rng.randrange(192)`, `y0 = oy − rng.randrange(192)`, then stamp a grid
covering the arena (`for yy in range(y0, oy+h, 192): for xx in range(x0, ox+w, 192)`),
**cycling `idx++ (mod 6)` per stamp**, blend add. That's ~40 blits ≈ 6800 specks.
Pixi: 6 textures built once; a pre-allocated grid pool of ~(8×5)=40 Sprites whose
`texture` and position are reassigned per frame. (A TilingSprite cannot cycle tiles;
keep the sprite grid.)

### 2.4 Interference tears

Spawning (in `_animate`): `tearCd -= dt`; when ≤ 0, reset to
`rng.uniform(0.03, 0.28)` and spawn `rng.randint(2, 5)` tears, each
`[y = uniform(0, h), bh = uniform(5, 42), shift = uniform(-90, 90),
life = uniform(0.06, 0.32)]`. Each frame `life -= dt`; drop dead ones and keep only the
**last 20**.

Paint per live tear (no parallax):

1. `tearImg` — a pre-rendered `w × 48` solid fill of `shade(accent2, 0.24)` — blitted
   additively at `(ox + shift, oy + y)`, source height `min(bh, 48)`.
2. Top edge: 1-px line, `lerpColor(accent, text, 0.4)`, from `(r.x, r.y)` to
   `(r.x + w, r.y)` (normal blend).
3. Bottom edge: 1-px line, `theme.hazard`, from `(r.x − 6, r.bottom)` to
   `(r.x + w − 6, r.bottom)` — the −6 px offset **is** the chromatic-fringe effect.

Note the tear rect is `w` wide but starts at `ox + shift`, so it hangs off one side;
the arena clip crops it. In Pixi, let the container mask do the cropping.

### 2.5 Signal bar

Build: `w × 90` black surface; per row `f = sin(π·yy/90)²`, fill row with
`shade(accent, 0.10·f)` → a soft horizontal band. Animate:
`barY += h·0.28·dt (mod (h + 120))`. Paint: additive blit at `(ox, oy + barY − 120)` —
it enters above the top edge and exits past the bottom.

### 2.6 Scanlines (multiply, painted last)

Build: `w × (h + 4)` surface filled `(255,255,255)`; every `SCAN_PERIOD = 4` rows, a
2-px-tall row of `(150,150,150)`. Animate: `scanOff += 24·dt (mod 4)`. Paint:
`blendMode 'multiply'` at `(ox, oy − 4 + scanOff)`. Pixi: a TilingSprite over a
1×4 texture (rows: 150,150,255,255), multiply blend, `tilePosition.y = scanOff`.
This must render **above** every other background layer but below the drift vignette.

Frame-rate caveat (applies to jitter 2.1, streak/snow randomness 2.2/2.3, tear spawn
cadence 2.4): probabilities and re-rolls are **per `_animate`/`_paint` call**, tuned at
60 fps. See Open questions.

---

## 3. Stage 7 — `ice` (Frozen Vault, theme index 6)

Class `IceBackground`, lines 1459–1605. Paint order:

| # | Layer               | Depth            | Kind                             | Blend  |
|---|---------------------|------------------|----------------------------------|--------|
| 1 | Cold haze           | 0.12             | Pre-rendered soft layer          | add    |
| 2 | Ice sheet (cracks)  | 0.35             | Wrapping strip, scrolls left     | add    |
| 3 | Cold rim light      | 0.50             | Pre-rendered concentric rects    | add    |
| 4 | Frost creep         | 0.60             | Per-frame line list (bounded)    | normal |
| 5 | Crystals ×26        | 0.70/0.90/1.15   | Pre-rotated alpha sprites + glow | normal + add glow |

### 3.1 Cold haze (build once)

Quarter-scale soft layer (`div = 4`); 9 radials, each radius
`h·rng.uniform(0.22, 0.45)/div`, colour `shade(accent, 0.055)`, intensity 1.0,
steps 8, at `((36 + uniform(0, w))/div, (36 + uniform(0, h))/div)`. Upscaled to
full layer; painted `_blit_layer(depth = 0.12)`.

### 3.2 Ice sheet — hairline cracks (build once, scrolls)

A `_new_strip(w)` (size `w × (h + 72)`, wraps horizontally with period `w`).
Crack colour: `shade(lerpColor(accent, text, 0.3), 0.22)`. 30 polylines:

```
start: x = uniform(0, w), y = uniform(0, h);  ang = uniform(0, TAU)
3..6 segments (randint):  ang += uniform(-0.7, 0.7);  d = uniform(30, 90)
                          x += cos(ang)·d;  y += sin(ang)·d
1-px lines; y is offset +36 (strip margin)
```

Cracks are **not** duplicated across the wrap seam — a crack running past x = w is
clipped and the seam can show a discontinuity every `w` px. Faithful port keeps this
(it scrolls at 6 px/s; the seam passes once every ~3.5 min and is invisible in
practice). Animate: `sheetX -= 6·dt`. Paint: `_wrap_add(depth = 0.35)`.

### 3.3 Cold rim light (build once)

`_new_layer`; 9 concentric stroked rects: for `i = 0..8`, `f = (i+1)/9`, colour
`shade(accent, 0.05·f)`, rect `(36 + 4i, 36 + 4i, w − 8i, h − 8i)`, stroke width 4 —
brightest innermost. Painted `_blit_layer(depth = 0.5)`.

### 3.4 Frost creep (the signature)

Build: 52 seeds, each on a random wall (`side = randrange(4)`):

```
side 0: (uniform(0,w), 0),  ang = +π/2      (top, growing down)
side 1: (uniform(0,w), h),  ang = −π/2      (bottom, growing up)
side 2: (0, uniform(0,h)),  ang = 0         (left, growing right)
side 3: (w, uniform(0,h)),  ang = π         (right, growing left)
```

Each seed recursively grows (`_grow(x, y, ang, len = uniform(28, 62), depth = 3)`):
append segment `((x,y) → (x + cos(ang)·len, y + sin(ang)·len))`, then two children
from the endpoint with `ang ± uniform(0.4, 0.9)` (independent draws per child) and
`len · uniform(0.5, 0.72)`, stopping at `depth ≤ 0` or `len < 5` — up to 7 segments
per seed (1+2+4), ≤ 364 segments total. After building, **sort all segments by
`min(rootX, w − rootX, rootY, h − rootY)`** (distance of the segment's *start* point
from the nearest wall). Showing the first N of the sorted list = frost that has crept
N px inward from every wall at once.

`frostCol = lerpColor(accent, text, 0.5)`.

Per frame (parallax depth **0.60**):

```
grow  = 0.5 + 0.5·sin(t·0.24)                     # one breath ≈ 26.2 s
shown = int(len(branches) · (0.35 + 0.65·grow))    # 35%..100% of segments
col   = shade(frostCol, 0.30 + 0.35·grow)          # brightens as it advances
draw segments[0..shown) as 1-px lines (normal blend) at (ox+px+ax, oy+py+ay)
```

Pixi: one `Graphics` rebuilt per frame (≤ 364 line segments — cheap), or a pre-built
Mesh/Graphics per "growth bucket" with only the newest bucket redrawn. A single
per-frame Graphics is the simplest faithful port; the colour changes every frame so
caching by `shown` alone is not enough (colour can be a tint on a white-drawn
Graphics: draw lines white once per `shown` change, tint by `col`).

### 3.5 Crystals (26 falling hexagons)

Build three sprite banks, sizes `size ∈ (7, 11, 16)`:

- Proto: `(size·4)²` **per-pixel-alpha** surface, centre `c = size·2`.
- Hexagon: vertices `c + (cos, sin)(TAU·i/6)·size`, i = 0..5.
  - Fill: `withAlpha(lerpColor(accent, bgTop, 0.55), 110)`.
  - Outline: `withAlpha(accent2, 225)`, stroke width 2.
  - 3 internal facet lines (i = 0..2, `a = TAU·i/6`): from `c − (cos a, sin a)·0.9·size`
    to `c + (cos a, sin a)·0.9·size`, colour `withAlpha(text, 130)`, 1 px.
- 24 pre-rotated frames: `rotate(proto, −360·i/24)` for i = 0..23.

Depth per size index: `(0.7, 0.9, 1.15)` — note the largest crystals use depth
**1.15 > 1**, i.e. more parallax than the near plane.

State per crystal `[x, y, vx, vy, ang, spin, sizeIdx]`:
`sizeIdx = randrange(3)`; `x, y = uniform(0,w), uniform(0,h)`;
`vx = uniform(-22, 22)·(1 + 0.4·sizeIdx)`; `vy = uniform(8, 30)·(1 + 0.4·sizeIdx)`
(bigger falls faster — depth cue); `ang = uniform(0, TAU)`;
`spin = uniform(-1.1, 1.1)` rad/s.

Animate: `x += vx·dt; y += vy·dt; ang += spin·dt`; wrap: `y > h+40 → y = −40,
x = uniform(0, w)`; `x < −40 → x = w+30`; `x > w+40 → x = −30`.

Paint per crystal: frame index `int(ang/TAU·24) mod 24` — Python `int()` truncates
toward zero and `%` then yields a non-negative index; in TS use
`((Math.trunc(ang/TAU*24) % 24) + 24) % 24`. Blit the frame **normal blend**, centred
at `(ox + x + px, oy + y + py)` with `_par(depth[sizeIdx])`, then add
`_glow_sprite(14, accent, 0.20)` at the same centre.

Pixi note: the 24-frame quantisation is a pygame cost trick (rotation was expensive);
a Pixi Sprite rotates for free. **Keep the 24-step quantisation** for fidelity — at
|spin| ≤ 1.1 rad/s the stepping (≈ 4 steps/s) is a visible part of the Python look —
by setting `sprite.rotation = Math.trunc(frameIdx) * TAU/24`. One hexagon texture per
size suffices; no frame bank needed.

---

## 4. Stage 8 — `spores` (Toxic Bloom, theme index 7)

Class `SporeBackground`, lines 1611–1723. Class constants: `COUNT = 52` spores,
`CLUSTERS = 8`. Paint order:

| # | Layer            | Depth | Kind                              | Blend |
|---|------------------|-------|-----------------------------------|-------|
| 1 | Far mist         | 0.15  | Wrapping soft strip, drifts right | add   |
| 2 | Near mist        | 0.40  | Wrapping soft strip, drifts right | add   |
| 3 | Pod bed outlines | 0.55  | Pre-rendered layer                | add   |
| 4 | Pod glows ×13    | 0.55  | Pulsing glow sprites              | add   |
| 5 | Spores ×52       | 1.00  | Pre-rendered blob sprites         | add   |

### 4.1 Mist banks (build once each)

`_mist(count, rmin, rmax, amp)`: quarter-scale soft strip (`div = 4`, size
`(w/4) × ((h+72)/4)`, wraps with period `w`). For each of `count` blobs:

- radius `r = uniform(rmin, rmax)/div`
- colour `shade(theme.grid, uniform(amp·0.5, amp))`, radial intensity 1.0, steps 8
- `x = uniform(0, stripW)`, `y = (36 + uniform(h·0.2, h·1.05))/div` (lower half bias)
- duplicated across the wrap seam when `x < r` (also at `x + stripW`) or
  `x > stripW − r` (also at `x − stripW`)

then upscaled ×4. Two banks: far = `_mist(10, h·0.24, h·0.48, 0.10)`,
near = `_mist(14, h·0.10, h·0.26, 0.22)`.

Animate: `mistFarX += 2.0·dt`, `mistNearX += 6.5·dt` (both drift the strip to the
right via `_wrap_add`). Paint at depths **0.15** and **0.40**.

### 4.2 Pod bed (build once) + pulsing glows (per frame)

13 pods: `x = uniform(0, w)`, `y = h − uniform(0, h·0.12)` (bottom 12% band),
`r = uniform(10, 26)`, `ph = uniform(0, TAU)`. Build layer: stroked circle per pod,
colour `shade(grid, 0.9)`, radius `int(r)`, width 2, at `(36+x, 36+y)`; painted
`_blit_layer(depth = 0.55)`.

Per frame, same parallax (depth 0.55):

```
k = 0.45 + 0.55·(0.5 + 0.5·sin(t·1.1 + ph))
add _glow_sprite(int(r·2.2), accent2, 0.22·k) at (ox + x + px, oy + y + py)
```

### 4.3 Blob sprites (5 pre-rendered, build once)

For `r ∈ (5, 8, 12, 17, 23)`, on a black `d × d` surface with `d = 4r`:

1. Soft core: `_radial(r·1.9, shade(accent, 0.24), 1.0, steps 10)` added at centre.
2. Membrane ring: stroked circle, `shade(accent2, 0.38)`, radius `r`, width 2.
3. Highlight: filled circle `shade(accent, 0.55)`, centre `(0.44·d, 0.42·d)`
   (up-left of centre), radius `max(1, r // 4)`.

Blitted with ADD at draw time, so the whole sprite is additive (black backing). Pixi:
five small RenderTextures (or canvas textures) built once, drawn by pooled additive
Sprites.

### 4.4 Colony clustering (the signature)

8 cluster centres `[x, y, vx, vy, ph]`: `x = uniform(0, w)`, `y = uniform(0, h)`,
`vx = uniform(-7, 7)`, `vy = uniform(-26, -9)` (all rise), `ph = uniform(0, TAU)`.

Animate: `ph += 0.4·dt`; `x += (vx + sin(ph)·9)·dt`; `y += vy·dt`;
wrap: `y < −70 → y = h + 70, x = uniform(0, w)`; `x < −80 → x = w + 70`;
`x > w + 80 → x = −70`.

52 spores `[colonyIdx, ang, orb, rate, spriteIdx, bob]`:
`colonyIdx = randrange(8)`, `ang = uniform(0, TAU)`, `orb = uniform(8, 74)`,
`rate = uniform(-0.9, 0.9)` rad/s, `spriteIdx = randrange(5)`,
`bob = uniform(0, TAU)`.

Animate: `ang += rate·dt`; `bob += 1.1·dt`. (Spores carry **no** position of their
own — they ride their colony.)

Paint at parallax depth **1.0**:

```
x = clusterX + cos(ang)·orb
y = clusterY + sin(ang)·orb·0.7 + sin(bob)·7     # squashed ellipse + 7 px bob
add blobs[spriteIdx] at (ox + x + px, oy + y + py)
```

---

## 5. TS mapping notes

| Python input | TS source |
|---|---|
| `theme` (accent, accent2, grid, text, hazard, bg_top, bg_bottom) | `THEMES[i]` / `themeForLevel(i)` in `web/src/core/palette.ts`, data from `web/src/data/themes.json` (keys `accent`, `accent2`, `grid`, `text`, `hazard`, `bgTop`, `bgBottom`; packed mirrors in `theme.hex`) |
| `C.ARENA_RECT`, `C.MAX_DT` | `ARENA_X/ARENA_Y/ARENA_W/ARENA_H`, `MAX_DT` in `web/src/core/config.ts` (backed by `web/src/data/config.json`) |
| `P.shade / lerp_color / with_alpha / clamp8` | `shade / lerpColor / withAlpha / clamp8` in `web/src/core/palette.ts` (already truncation-exact) |
| `TAU, clamp, lerp` (`core/contracts`) | `TAU, clamp, lerp` in `web/src/core/mathx.ts` |
| `random.Random(...)` per style | the port's seeded PRNG; seed from (styleName, themeName) any deterministic way — Python itself is not run-to-run stable here |
| Level → style binding | `bgStyle` field on the theme; levels.json / level.ts pick the theme index |

pygame → PixiJS v8 idiom table for these stages:

| pygame idiom | PixiJS v8 equivalent |
|---|---|
| Black-backed surface + `BLEND_RGB_ADD` | `blendMode: 'add'` Sprite/Graphics/TilingSprite (docs: `web/node_modules/pixi.js/skills/`) |
| `BLEND_RGB_MULT` (scanlines, framework vignette) | `blendMode: 'multiply'` |
| `_glow_sprite` cache | one white radial texture with `1 − x²` alpha ramp; per-use tint/alpha/scale; no cache needed |
| `_seamless_layer` + oversized blit at mod offset | small canvas texture, `wrapMode 'repeat'`, `TilingSprite` with `tilePosition` |
| `_soft_layer` quarter-scale build + `smoothscale` up | quarter-size `RenderTexture`, sprite scaled ×4, linear filtering |
| `SRCALPHA` proto + `pygame.transform.rotate` frames (crystals) | one texture per size, `sprite.rotation` quantised to 24 steps |
| per-frame `rng` blits (streaks, snow) | pre-allocated sprite pools, reposition/re-source per frame; never allocate per frame |
| `surface.set_clip(arena)` | rectangular mask (or scissor) on the background container |
| `surface.fill(col, (x, y, w, 1))` speck/star | 1×1 white texture sprite, tint + scale (only used inside pre-built noise tiles here) |

Suggested module boundary: `web/src/gfx/bg/` with `ocean.ts`, `static.ts`, `ice.ts`,
`spores.ts`, each exporting a class extending the shared `BackgroundBase` (framework
spec) with `build(container)`, `animate(dt)`, `paint()` mirroring
`_build/_animate/_paint`. In Pixi, "paint order" becomes child order of the style's
Container: keep one child per table row above, in the listed order; per-frame work is
only transforms, tilePositions, tints, alphas and one small Graphics (frost).

## 6. Invariants worth asserting

- Counts are fixed for the life of a background: 42 bubbles, 5 rays; 3 signal layers,
  6 noise tiles, ≤ 20 live tears; 52 frost seeds (≤ 364 segments, sorted
  wall-distance-ascending), 26 crystals, 3 crystal sizes × 24 rotation steps;
  8 clusters, 52 spores, 13 pods, 5 blob sprites.
- All glow intensities in these four styles are in (0, 1]; the radial profile is
  `1 − (d/R)²` peaking at exactly `color × intensity`.
- Every additive layer is black where empty (nothing may add a grey floor).
- Tile scroll offsets stay in `[0, period)` via Python-style mod (assert non-negative).
- Depth values used: ocean {0.10, 0.35, 0.55, 0.70, 0.95}; static {0.20, 0.55, 0.90};
  ice {0.12, 0.35, 0.5, 0.6, 0.7, 0.9, 1.15}; spores {0.15, 0.40, 0.55, 1.0}.
- Scanlines multiply layer values are only 150 or 255; drift vignette (framework)
  multiplies *after* everything, including the scanlines.
- `dt` reaching `_animate` is already clamped to `MAX_DT = 0.05` by the framework.

Performance-critical (things Python pre-renders because they are expensive —
do the same, at build time only): caustic/swell/signal seamless tiles, ray wedges,
mist/haze/deep soft layers, crack strip, rim rects, pod bed, blob sprites, noise
tiles, scanline strip, bar, streak/tear strips, crystal hexagons. Per frame the
budget is: tilePosition updates, ≤ ~150 pooled sprite transforms, one ≤ 364-segment
Graphics (frost), and (static only) ~40 snow-tile + 24 streak sprite updates.

## 7. Open questions

1. **Frame-rate-dependent randomness (static).** Jitter re-roll (28%/call), streak and
   snow re-randomisation (per paint), and tear-spawn cadence are per-frame at an
   assumed 60 fps. On a 120/144 Hz browser display the effect roughly doubles in
   frequency. Options: (a) run these on a fixed 60 Hz accumulator, (b) convert to
   per-second rates. Recommend (a) for fidelity; needs a decision that also matches
   whatever the framework spec decides for its own per-frame randomness.
2. **Crystal rotation quantisation (ice).** Keep the visible 24-step rotation (faithful)
   or rotate smoothly (nicer, trivially cheaper in Pixi)? Spec above recommends keeping
   it; confirm with the owner of the overall look.
3. **Ice-sheet seam.** Cracks are clipped at the strip's wrap seam in Python (§3.2).
   Reproduce as-is, or duplicate seam-crossing cracks? Recommend as-is.
4. **pygame 1-px `draw.line` vs Pixi line rendering.** Hairline aesthetics (frost,
   cracks, tear fringes, bubble meniscus) depend on non-antialiased 1-px lines. Pixi
   Graphics antialiases by default; decide whether to set `pixelLine`-style rendering /
   round coordinates to keep the crisp retro look, ideally as a framework-wide rule.
5. **TilingSprite offset sign.** The spec assumes `tilePosition = (+off)` reproduces
   pygame's "blit layer at `origin + off mod period`" direction. Verify once with a
   marked test tile; if inverted, negate all offsets uniformly.
6. **Additive clamp differences.** pygame ADD saturates per channel at 255 in 8-bit;
   WebGL additive blending also clamps at 1.0 per channel in an 8-bit target, but if
   the post-processing chain renders the scene into a float RenderTexture the stacked
   glows (e.g. spore colonies overlapping) will not clamp until tonemap. Confirm the
   background renders into an 8-bit target or accept slightly brighter overlaps.
