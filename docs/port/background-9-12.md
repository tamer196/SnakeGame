# Port spec — `snake/gfx/background.py`, stages 9–12

**Scope:** `MachineBackground` (stage 9 "Crimson Engine"), `AuroraBackground` (stage 10
"Aurora Drift"), `VoidWarpBackground` (stage 11 "Event Horizon"), `PrismBackground`
(stage 12 "Prism Core"). The shared `Background` framework (base gradient, centre lift,
focus parallax, drift vignette, glow-sprite cache, layer helpers, clip/draw contract) is
another agent's spec — it is summarised below only as far as these four classes consume
it. The Python file is ground truth; line numbers refer to `snake/gfx/background.py`.

---

## 0. Framework contract these styles rely on (reference only)

Every stage below assumes the base-class behaviour of `Background`
(lines 324–608). The port of that framework defines the following, which
this spec uses by name:

| Concept | Python | Meaning |
|---|---|---|
| Arena rect | `self.rect`, `self.w/self.h/self.ox/self.oy` | Backgrounds are built for an arbitrary rect in **design space** (1280×720). In-game this is `ARENA_RECT` = (14, 78, 1252, 628) (`web/src/core/config.ts`: `ARENA_X/Y/W/H`); menus may pass other rects (e.g. full window), so **never hard-code the arena size**. `_paint` draws in screen coordinates (`ox + arenaLocalX`, `oy + arenaLocalY`) and runs clipped to `rect`. |
| Margin | `_MARGIN = 36` | Pre-rendered layers built by `_new_layer()` carry a 36 px slack border on every side so focus parallax never drags an empty edge in. Arena-local (0,0) sits at layer pixel (36,36). |
| Focus parallax | `_par(depth)` = `(-fx·22·depth, -fy·22·depth·0.62)` | `fx/fy` are the smoothed, clamped (−1..1) snake-head offset from the arena centre (time constant 1.4 s). Depth 0 = infinitely far (never moves), 1 = right behind the snake. |
| Time | `self.t` | Accumulated dt, clamped per frame to `MAX_DT` (= 1/20 s, `config.ts`). All periodic motion below is a function of `t`. |
| Base + vignette | `draw()` | Base vertical gradient (`theme.bgTop → theme.bgBottom` + additive centre lift) is blitted first; `_paint` runs clipped to the arena; then the shared multiply vignette (edge darkening + ~84 s colour drift) is multiplied over the top. Both are framework, not re-specced here. |
| Glow sprites | `_glow_sprite(r, col, intensity)` | Cached, quantised radial glow: black-backed square of side `2r`, brightness falls off as `1 − (d/r)²` (14 concentric discs at `r·sqrt(1−i/steps)`, disc i filled with `shade(col, intensity·(i+1)/steps)`), always composited with `BLEND_RGB_ADD`. Radius quantised (≥64 → multiple of 8, ≥8 → even), intensity quantised to 1/16 steps in 0..4. `_radial` is the uncached variant. |
| `_add(surface, sprite, cx, cy)` | line 176 | Additive stamp of a glow sprite centred on (cx, cy). |
| Layer blits | `_blit_layer(surface, layer, depth, dx, dy)` | Additive (`BLEND_RGB_ADD`) blit of a margined layer at `(ox − 36 + par.x + dx, oy − 36 + par.y + dy)`. |
| Low-res buffer | `_lo_surface(div)` / `_blit_lo(surface, blur, every)` | A persistent `(w/div, h/div)` scratch. `_blit_lo` bilinearly upscales it to `(w, h)` (optionally through an extra half-size downscale = cheap blur) and adds it over the arena at `(ox, oy)` — **no parallax on this path**. `every=N` recomputes the upscale only every Nth call, reusing the cached big surface in between. |
| RNG | `self.rng = random.Random(hash((style, theme.name)) & 0xFFFFFFFF)` | **Python string hashing is salted per process**, so gear/plate/star layouts already differ between runs of the Python game. The port must reproduce the *distributions* below, not exact positions. Use any decent seeded PRNG; seeding per (style, themeName) is nice for stability but not required for fidelity. |
| Error policy | try/except everywhere | Nothing in the module may throw out of `update`/`draw`. Preserve that contract (wrap per-frame work; degrade to the plain gradient). |

**Colour helpers** (all ported 1:1 in `web/src/core/palette.ts`):
`shade(c, f)` = per-channel multiply with 0..255 clamp; `lerp_color`/`lerpColor`
(the file's `_mix`) = clamped linear blend; `with_alpha`/`withAlpha`;
`rainbow(t, sat, val)` = HSV with wrapping hue; `clamp8`. `TAU`, `clamp`, `lerp`
come from `web/src/core/mathx.ts`.

**Theme keys.** Colours below are named by theme key only. The stage↔theme pairing
(from `themes.json` / `P.THEMES`, indices 8–11):

| Stage | Theme name | `bgStyle` | Keys used by this stage |
|---|---|---|---|
| 9 | Crimson Engine | `machine` | `bgBottom`, `grid`, `accent` |
| 10 | Aurora Drift | `aurora` | `accent`, `accent2`, `text` |
| 11 | Event Horizon | `voidwarp` | `accent`, `accent2`, `text`, `bgTop`, `bgBottom` (via `_bg_at`) |
| 12 | Prism Core | `prism` | `grid`, `text` (+ `rainbow()` spectrum, theme-independent) |

**pygame blend flags → PixiJS v8** (see `web/node_modules/pixi.js/skills/pixijs-blend-modes/`):

| pygame | Pixi v8 |
|---|---|
| `blit(..., BLEND_RGB_ADD)` of a black-backed opaque surface | `blendMode: 'add'` on a Sprite/Graphics whose texture is black where it should not glow (or has real alpha — over black backing they are equivalent) |
| `blit(..., BLEND_RGB_MULT)` | `blendMode: 'multiply'` |
| plain `blit` of an SRCALPHA surface | default `'normal'` blend with a per-pixel-alpha texture |
| plain `surface.fill(col, rect)` (1–3 px star points) | overwrites the destination. In Pixi use a `'normal'`-blended tinted white pixel sprite at alpha 1 — over these near-black arenas the difference from a true overwrite is imperceptible (note in §5). |
| `pygame.draw.polygon/lines/circle/rect` direct to screen | `Graphics` fill()/stroke() (skill: `pixijs-scene-graphics`), `'normal'` blend, redrawn per frame where animated |

---

## 1. Stage 9 — `MachineBackground` ("Crimson Engine", style `machine`, lines 1729–1911)

Industrial gearworks in three depths: a dim far gear-wall (0.15), riveted plates
(0.45), and the live machinery — meshed gear trains, pistons and pulsing lamps —
at 0.90. **Signature:** the gears genuinely mesh (tooth-ratio speeds, solved phases).

Class constants: `ROT_STEPS = 12`, `SPECS = ((44, 9), (70, 12), (104, 16))`
(tip radius px, tooth count), `PITCH = 0.90` (pitch radius / tip radius).

### 1.1 Build-time colours

- `body` = `withAlpha(mix(bgBottom, black, 0.45), 238)` — gear body fill (near-opaque).
- `rim` = `withAlpha(mix(grid, accent, 0.55), 255)` — gear rim/spokes/hub.
- `dim` = `mix(grid, black, 0.45)` — far-works line colour (used at `shade(dim, 0.55)`).
- `piston_body` = `mix(bgBottom, black, 0.5)`; `piston_rim` = `mix(grid, accent, 0.45)`.

### 1.2 Gear sprite frames (`_gear_frames`, lines 1840–1872) — pre-rendered

For each of the three SPECS, 12 pre-rotated frames spanning **one tooth pitch**
(rotational symmetry covers the rest):

- Canvas: `d × d` with `d = radius·2 + 8`, per-pixel alpha, centre `c = d/2`.
- Silhouette: `n = teeth·2` vertices; vertex i at angle `TAU·i/n`, radius
  `radius` for even i (tooth tip), `radius·0.80` for odd i (root). Filled with
  `body`, outlined with `rim` at width 2.
- Hub: circle outline, radius `radius·0.30`, width 2, `rim`.
- Spokes: 5 lines at `TAU·i/5`, from `radius·0.32` to `radius·0.70` of centre,
  width 4, `rim`.
- Frame i = prototype rotated by `−(360/teeth)·i/12` degrees, re-cropped to the
  same `d × d` box centred (lossless: rotation never leaves the circumscribed circle).

**Pixi mapping:** draw the prototype once into a `Graphics` → `renderer.generateTexture`
(or draw to a `RenderTexture`), then simply set `sprite.rotation` per frame.
The 12-step quantisation was a CPU-blit optimisation; see §6 for the
fidelity choice (quantised vs continuous rotation).

### 1.3 Far works — depth 0.15, static, ADD

`_new_layer()` (black, margined, blitted with `BLEND_RGB_ADD` via `_blit_layer(…, 0.15)`).
14 gear outlines, positions uniform over the arena (margin-offset):

- `r = randint(20, 46)`, `n = randint(8, 13)` teeth.
- Polygon of `n·2` points alternating radius `r` / `r·0.78` (same vertex rule as §1.2,
  root factor 0.78 not 0.80), **outline only, width 2**, colour `shade(dim, 0.55)`.

Pixi: one static `Graphics` (or baked texture), container `blendMode 'add'`,
positioned by `_blit_layer` semantics at depth 0.15.

### 1.4 Riveted plates — depth 0.45, static, NORMAL alpha blend

6 plate sprites, each pre-rendered once with per-pixel alpha (`SRCALPHA`), and —
unlike almost everything else in this module — composited with a **plain alpha
blit, not additive**:

- Size: `pw = int(U(160, 420))`, `ph = int(U(120, 320))`.
- Body: rounded rect (radius 8) filling the sprite, colour
  `withAlpha(mix(bgBottom, black, 0.30), 150)`.
- Border: same rounded rect, width 2, `withAlpha(grid, 90)`.
- Rivets: filled circles radius 3, `withAlpha(grid, 120)`, at
  `x = 12, 46, 80, … (< pw − 6, step 34)`, two rows `y = 12` and `y = ph − 12`.
- Position: `x = U(−40, w − 120)`, `y = U(−40, h − 100)` (arena-local; can hang
  off the edges — the arena clip handles it).
- Draw: `surface.blit(plate, (ox + x + px, oy + y + py))` with `(px, py) = _par(0.45)`.

Pixi: 6 Sprites (one shared generation per plate since sizes differ) in a
depth-0.45 container, `'normal'` blend.

### 1.5 Gear trains — depth 0.90, animated, NORMAL alpha blend

4 trains built at construction (`_train`, lines 1818–1838). Gear state is
`[x, y, specIndex, phase, omega]` (phase/omega in radians / rad·s⁻¹):

- **Driver:** spec index `randrange(3)`; `x = U(0.05w, 0.95w)`, `y = U(0.05h, 0.95h)`;
  `phase = U(0, TAU)`; `omega = U(0.30, 0.95) · choice(−1, +1)`.
- **1–2 driven gears** chained off it (`randint(1, 2)`), each becoming the new
  driver for the next link. For driver (spec i, teeth `na`, tip radius `ra`,
  phase φₐ, speed ωₐ) and driven spec j (`nb`, `rb`):
  - Centre distance `gap = (ra + rb) · 0.90` along a random direction
    `theta = U(0, TAU)`: `nx = x + cos(theta)·gap`, `ny = y + sin(theta)·gap`.
  - **Mesh phase:** `phase_b = theta + π − π/nb + (na/nb)·(theta − phase_a)`
    (a driver tooth always faces a driven gap along the line of centres).
  - **Speed:** `omega_b = −omega_a · na/nb`.
- Total gear count: 8–12.

Per frame (`_animate`): `phase += omega · dt` for every gear. Because the speed
ratio is exact, the mesh relation holds forever — worth asserting in tests (§5).

Draw (`_paint`), at `(px, py) = _par(0.90)`: frame index
`k = int(((phase mod pitch) / pitch) · 12) mod 12` with `pitch = TAU / teeth`;
blit frame `k` centred on `(ox + x + px, oy + y + py)`, normal alpha blend.

Pixi: one Sprite per gear (texture per spec from §1.2); either quantise
`rotation` to reproduce the 12-step look or rotate continuously (§6).

### 1.6 Pistons — animated, direct opaque draws

5 pistons, state `[x, y, throw, rate, phase, verticalFlag]`:
`x = U(0.08w, 0.92w)`, `y = U(0.08h, 0.92h)`, `throw = U(60, 150)`,
`rate = U(0.5, 1.4)` rad/s, `phase = U(0, TAU)`, vertical with p = 0.5.

Per frame: `s = sin(t·rate + phase) · throw · 0.5`. **Note:** the piston (and lamp)
loop reuses `(px, py)` from the gear loop, i.e. pistons and lamps also sit at
parallax depth **0.90** (the code never recomputes `_par` for them — replicate that).

- Vertical: rect `(ox + x + px − 9,  oy + y + py − throw·0.5 + s,  18,  int(throw·0.5 + 30))`.
- Horizontal: rect `(ox + x + px − throw·0.5 + s,  oy + y + py − 9,  int(throw·0.5 + 30),  18)`.
- Fill `piston_body` + outline width 2 `piston_rim`, both `border_radius = 5`,
  drawn directly on the frame (opaque, normal blend, over the gears).

Pixi: a per-frame `Graphics` (roundRect fill + stroke), or 5 static Graphics
whose position is updated (the rod length is constant per piston; only its
head coordinate slides — a static rounded-rect Graphics translated by `s` along
its axis is exact).

### 1.7 Lamps — animated, ADD

10 lamps at `(U(0, w), U(0, h), phase U(0, TAU))`. Per frame:
`k = 0.5 + 0.5·sin(t·2.4 + phase)`; additive stamp of
`_glow_sprite(13, accent, 0.20 + 0.4·k)` centred at
`(ox + x + px, oy + y + py)` — again with the depth-0.90 `(px, py)`.

Pixi: 10 Sprites sharing one radial-glow texture (radius 13, `accent`),
`blendMode 'add'`, per-frame `alpha` ∝ intensity. Note pygame quantises the
intensity to 1/16 steps via the sprite cache; alpha-modulating one texture is
the natural GPU equivalent (visually identical; the quantisation was purely a
cache-key trick).

### 1.8 Draw order (stage 9)

1. base gradient (framework) → 2. far works (ADD, 0.15) → 3. plates (normal, 0.45)
→ 4. gears (normal, 0.90) → 5. pistons (normal, 0.90-parallax) → 6. lamps (ADD,
0.90-parallax) → 7. vignette multiply (framework).

---

## 2. Stage 10 — `AuroraBackground` ("Aurora Drift", style `aurora`, lines 1917–2017)

Twinkling stars (0.10), a ground haze (0.35), and six undulating ribbon
curtains at three depths (0.25 / 0.55 / 0.95). **Signature:** each curtain is
composited a *column* at a time with both a vertical displacement (two
out-of-phase sines) and a **source-column displacement** that shears the ray
structure sideways — the second one is what sells the fold.

Class constant: `SLICES = (18, 12, 8)` — column (slice) width in px per ribbon
band. Pairing by `i % 3`: band 0 → depth 0.25 / tint `accent` / slice 18;
band 1 → 0.55 / `accent2` / 12; band 2 → 0.95 / `mix(accent, accent2, 0.5)` / 8.
(The docstring says "near to far" but the code pairs the *widest* slice with the
*farthest* depth — follow the code.)

### 2.1 Curtain strip textures — pre-rendered

`ribbon_w = int(clamp(w · 0.18, 90, 260))` (in-game arena: 225 px).
Three strips (one per tint above), each generated at **30 × 60** and bilinearly
upscaled to `(ribbon_w, h)`. Pixel (i, j) of the small image
(`u = i/29`, `v = j/59`):

```
g     = clamp((v − 0.20) / 0.48, 0, 1)          # lit band = middle ~48 % of height
vert  = sin(π·g)^1.5
ray   = 0.62 + 0.38·(0.5 + 0.5·sin(u·TAU·3.5))  # 3.5 vertical striations
horiz = sin(π·u)^1.4                             # fade at strip's left/right edges
col   = shade(tint, 0.62 · vert · horiz · ray)
```

Black-backed (drawn additively at paint time). Pixi: build the 30×60 image on a
canvas (or Uint8 buffer → `Texture.from`), keep `scaleMode: 'linear'` so the GPU
reproduces the smooth upscale.

### 2.2 Ribbon state

6 ribbons, `i = 0..5`, `depth = (0.25, 0.55, 0.95)[i % 3]`:

| Field | Value |
|---|---|
| x | `U(−0.1, 1.1) · w` |
| drift speed | `U(4.0, 10.0) · (0.5 + depth)` px/s (rightward) |
| wave phase | `U(0, TAU)` |
| wave rate | `U(0.35, 0.8)` rad/s |
| wave frequency | `U(0.012, 0.030)` rad/px |
| tint index | `i % 3` |
| slice width | `SLICES[i % 3]` |

`_animate`: `x += speed·dt`; wrap to `x = −ribbon_w` when `x > w + ribbon_w`;
`phase += rate·dt`.

### 2.3 Stars — depth 0.10, per-frame point fills

110 stars: `(x = U(0, w), y = U(0, h·0.7), amp = U(0.3, 1.0), ph = U(0, TAU))`;
colour source `theme.text`. Per frame at `(px, py) = _par(0.10)` (truncated to int):
`tw = 0.5 + 0.5·sin(t·1.8 + ph)`; **overwrite-fill** a 1×1 px rect at
`(ox + int(x) + int(px), oy + int(y) + int(py))` with `shade(text, 0.55·amp·tw)`.

Pixi: 110 one-pixel sprites (shared white texture, `tint = text`,
`alpha = 0.55·amp·tw`, normal blend) — or a `ParticleContainer`
(skill: `pixijs-scene-particle-container`) with per-particle alpha.

### 2.4 Ground haze — depth 0.35, static, ADD

`_new_layer()`; for `i = 0, 2, 4, … < h//3`:
`f = (i / (h//3))²`; fill a full-width (`w + 72`) 2-px-tall row at layer-y
`36 + h − 1 − i` with `shade(accent, 0.05·f)`. I.e. an additive band covering
the bottom third, black at the very bottom edge, ramping quadratically up to
5 %-accent at ⅓ height, then cutting off. Blitted with `_blit_layer(…, 0.35)`.

Pixi: bake once into a gradient texture (or a `Graphics` of 2-px rects),
container `blendMode 'add'`, depth 0.35. (Faithful port keeps the *upward*
brightness ramp and the hard top edge — it reads as haze hanging above the ground.)

### 2.5 Ribbon compositing — per frame, ADD

Ribbons draw in creation order (bands interleaved 0.25, 0.55, 0.95, 0.25, …) —
**not** sorted far-to-near; ADD blending makes order irrelevant to the result, but
keep the structure simple. For each ribbon (with its `depth`, `(px, py) = _par(depth)`):

```
amp_v = h · (0.09 + 0.09·depth)
step  = slice width; limit = ribbon_w − step
for sx in 0, step, 2·step, … < ribbon_w:
    col_x = x + sx
    dy  = sin(col_x·freq + ph) · amp_v
        + sin(col_x·freq·2.3 − ph·1.7) · amp_v · 0.55
    src = int(clamp(sx + sin(col_x·freq·1.7 + ph·0.8) · 9.0, 0, limit))
    blit strip subrect (src, 0, step, h)                      # full strip height
         at (ox + col_x + px, oy + dy + py), BLEND_RGB_ADD
```

Column counts: 225/18 = 13, 225/12 = 19, 225/8 = 29 → ~122 quads per frame total.

**Pixi mapping (the interesting one):** one `MeshSimple`/`Mesh` per ribbon
(skill: `pixijs-scene-mesh`) over the strip texture, `blendMode 'add'` —
one quad per column, positions `(col_x + px, dy + py)`→`(+step, +h)`, UVs
`u0 = src/ribbon_w`, `u1 = (src + step)/ribbon_w`, `v ∈ [0, 1]`; update the
vertex/UV buffers per frame. (A fallback of `step`-wide sprites with per-frame
`texture.frame` changes also works but defeats batching.) Note pygame blits at
integer pixel positions — decide whether to round (pixel-faithful) or keep
float positions (smoother); see §6.

### 2.6 Draw order (stage 10)

1. base gradient → 2. stars (overwrite points, 0.10) → 3. haze (ADD, 0.35) →
4. six ribbons, creation order (ADD, per-ribbon depth) → 5. vignette multiply.

---

## 3. Stage 11 — `VoidWarpBackground` ("Event Horizon", style `voidwarp`, lines 2023–2152)

Four depths: a gravitationally-lensed starfield (0.20), warped expanding rings
(0.55), in-spiralling matter streaks + the pulsing core (0.90). **Signature:**
lensing — every star keeps a *rest* polar coordinate `(a0, r0)` and is drawn at
`r = r0 − K/(r0 + 60)` with a swirl that grows toward the centre, so the field
crowds into a bright ring at the lensing radius and relaxes to a plain starfield
at the corners. Everything orbits a **drifting singularity**.

Class constants: `RINGS = 17`, `POINTS = 40`, `STREAKS = 80`, `STARS = 190`.

### 3.1 Build-time state

- `max_r = hypot(w, h) · 0.62`.
- `phase = 0` (ring cycle), `swirl = 0` (global star rotation).
- **Streaks:** 80 × `[a = U(0, TAU), r = U(0.15, 1.0)·max_r, speed = U(0.35, 1.0)]`.
- **Core glows (pre-rendered):** `core_a = _glow_sprite(int(h·0.16), accent, 0.75)`;
  `core_b = _glow_sprite(int(h·0.07), text, 0.95)`.
- `ring_far = accent2`, `ring_near = accent`.
- **Stars:** 190 × `[a0 = U(0, TAU), r0 = max_r·sqrt(U(0.02, 1.0))` (uniform over
  the disc)`, b = U(0.35, 1.0), ph = U(0, TAU)]`; `star_col = mix(text, accent2, 0.30)`.
- Lens parameters: `lens_k = (h·0.20)²` px², `lens_r = h·0.24`,
  `halo_col = mix(accent, text, 0.45)`.
- `streak_col = mix(text, accent, 0.4)` (computed in `_paint`, constant).

### 3.2 The drifting centre

`cx = w·0.5 + sin(t·0.21)·w·0.05`, `cy = h·0.5 + cos(t·0.17)·h·0.05`
(arena-local; Lissajous with periods ~29.9 s and ~37.0 s).

### 3.3 `_animate`

- `phase = (phase + dt·0.22) mod 1` — one full ring cycle every ≈ 4.55 s.
- `swirl += dt·0.05`.
- Streak physics (in-spiral): `pull = 40 + 26000 / max(60, r)`;
  `r −= pull·dt·speed`; `a += (110 / max(50, r))·dt`;
  when `r < 14`, respawn as `[U(0, TAU), max_r, U(0.35, 1.0)]`.

### 3.4 Lensed starfield — depth 0.20, per-frame point fills

Screen centre `(sx, sy) = (ox + cx, oy + cy) + _par(0.20)`. Per star:

```
a = a0 + swirl + (900 / (r0 + 90)) · 0.02 · t     # differential rotation: inner faster
r = r0 − lens_k / (r0 + 60);   skip if r < 8       # lens pulls images inward
x = sx + cos(a)·r·1.12;  y = sy + sin(a)·r·0.88    # elliptical (12 % wide, 12 % squashed)
crowd = clamp(1 − |r − lens_r| / (lens_r·1.6), 0, 1)
k = b · (0.45 + 0.55·sin(2t + ph)) · (0.55 + 0.95·crowd)   # can exceed 1 → shade clamps
if crowd > 0.55: overwrite-fill 3×1 px rect, shade(halo_col, k)   # smeared arc
else:            overwrite-fill 1×1 px rect, shade(star_col, k)
```

Pixi: pool of 190 sprites — shared 1×1 and 3×1 white textures, swap texture (or
scale.x = 3) on the crowd threshold, `tint` = halo/star colour, `alpha = min(k, ~1.5→1)`
(pygame's `shade` saturates channels; tint·alpha on white saturates the same way
only up to alpha 1 — pre-shade the tint instead: set tint = `shade(col, k)` via
`toHex`, alpha 1, normal blend, to match exactly). A `ParticleContainer` also
works if per-particle tint is enabled.

### 3.5 Warped rings — depth 0.55, per-frame polylines

Ring centre `(rx, ry) = (ox + cx, oy + cy) + _par(0.55)`. For `k = 0..16`:

```
p = ((k + phase) / 17) mod 1
r = max_r · p^1.8            # r grows with p → rings are born at the core and
                             # expand outward, accelerating; bunched near the core
skip if r < 8
f = 1 − p                    # 1 at birth, 0 at max_r
colr = mix(_bg_at(cy), mix(ring_far, ring_near, f), clamp(0.25 + 0.75·f, 0, 1))
       # _bg_at(cy) = mix(bgTop, bgBottom, cy/h): the gradient colour under the centre
40 vertices, i = 0..39, a = TAU·i/40:
    wob = 1 + 0.10·sin(3a + 1.1·t + 0.5·k) + 0.06·sin(5a − 0.7·t)
    pt  = (rx + cos(a)·r·wob·1.12,  ry + sin(a)·r·wob·0.88)
closed polyline, width 2 if f > 0.45 else 1, colour colr, normal blend
```

(The class comment says rings "accelerate inward"; the math above — `p`
increasing with `phase` — moves them **outward**. Port the math, not the comment.)

Pixi: one `Graphics`, cleared and re-stroked per frame (17 × 40 line segments —
trivial). Round `width` exactly as above.

### 3.6 Infalling streaks — depth 0.90, per-frame lines

`(stx, sty) = (ox + cx, oy + cy) + _par(0.90)`. Per streak:

```
k    = clamp(1 − r/max_r, 0.05, 1)          # 0 at rim → 1 at core
tail = r + 78·k                              # tail extends outward, longer near core
p1   = (stx + cos(a)·r,          sty + sin(a)·r)            # head (NB: not squashed)
p2   = (stx + cos(a − 0.05)·tail, sty + sin(a − 0.05)·tail) # tail swept back 0.05 rad
1-px line, colour shade(streak_col, 0.25 + 0.75·k), normal blend
```

Note the streaks are **not** given the 1.12/0.88 elliptical squash — circular
field, unlike stars and rings. Pixi: same per-frame `Graphics` as the rings
(80 segments).

### 3.7 Core — same (0.90) parallax as streaks

```
beat = 0.85 + 0.15·sin(t·3.1)
additive stamp core_a at (stx, sty)          # h·0.16 accent glow, intensity 0.75
additive stamp core_b at (stx, sty)          # h·0.07 text glow, intensity 0.95
circle outline: colour mix(accent, text, 0.6), radius int(h·0.055·beat),
                width 2, centre (stx, sty), normal blend
```

Pixi: two ADD-blend Sprites (glow textures generated once) + a per-frame
`Graphics` circle stroke (or a static circle Graphics with `scale = beat`).

### 3.8 Draw order (stage 11)

1. base gradient → 2. lensed stars (overwrite points, 0.20) → 3. warped rings
(stroked polylines, 0.55) → 4. streaks (lines, 0.90) → 5. core glows (ADD) +
ring outline → 6. vignette multiply.

---

## 4. Stage 12 — `PrismBackground` ("Prism Core", style `prism`, lines 2158–2289)

Three depths: a static refraction lattice (0.20) under a rotating **wedge fan**
rendered through a quarter-res soft-light buffer (no parallax), a core glow
(0.45), and free-floating shards + rainbow sparks (0.95). **Signature:** every
wedge is drawn twice — body plus a thin leading-edge fringe in a hue shifted
+0.10 turns — which reads as chromatic dispersion. This is the most expensive
background in the Python game; its budget tricks are documented so the port can
decide what to keep (§6).

Class constants: `WEDGES = 12`, `DIV = 4` (low-res divisor), `UPSCALE_EVERY = 4`
(full-size upscale runs one frame in four; deliberately co-prime with the bloom
in `gfx/effects.py`, which rebuilds on a 3-frame period, so the two amortised
jobs coincide only one frame in twelve).

### 4.1 Build-time state

- `spin = 0`, `hue = 0` (free-running).
- Low-res buffer `lo` = `_lo_surface(4)` → `(w//4, h//4)`; `lw, lh` its size;
  `reach = hypot(lw, lh)` (wedge tip radius — always past the buffer corners).
- **Lattice** (static, margined ADD layer): centre `(36 + w//2, 36 + h//2)`;
  9 circle outlines radius `int(h·(0.16 + 0.11·i))`, i = 0..8, width 1,
  `shade(grid, 0.55)`; 12 radial lines at `TAU·i/12` from the centre to
  centre + (cos, sin)·w, width 1, `shade(grid, 0.35)`.
- **Core glow:** `_glow_sprite(int(h·0.28), text, 0.30)`.
- **Falloff mask** (multiplied over the fan so beams blaze at the centre and
  dissolve at the edges): an `(lw, lh)` surface filled `(16, 16, 16)` with
  `_radial(lh·0.62, (238, 238, 238), 1.0, steps=18)` added at its centre.
  Sized from the buffer **height**, not diagonal (on the 2:1 arena a
  diagonal-sized radius would never fade at the left/right edges).
- **Shards:** 7 × `(a0 = U(0, TAU), orbit = U(0.22h, 0.48h), rate = U(0.10, 0.35),
  size = U(16, 42))`.
- **Sparks:** 18 × `(a0 = U(0, TAU), orbit = U(0.10h, 0.55h), rate = U(−0.5, 0.5),
  ph = U(0, TAU))`.
- **Spark sprite bank** (pre-rendered 16 × 5): `bank[hi][ki] =
  _radial(5, rainbow(hi/16, 0.5, 1.0), 0.2 + 0.2·ki, steps=8)` — the whole
  (hue, brightness) space baked up front so per-frame colours never touch the
  shared glow cache.

### 4.2 `_animate`

`spin += 0.16·dt` rad/s (full fan turn ≈ 39.3 s); `hue += 0.045·dt` turns/s
(spectrum cycle ≈ 22.2 s).

### 4.3 Wedge fan — per frame into the low-res buffer, then ADD (no parallax)

Each frame, clear `lo` to black, then with `c = (lw/2, lh/2)`, `span = TAU/12`,
for `i = 0..11`:

```
a0    = spin + span·i
width = span · (0.26 + 0.28·(0.5 + 0.5·sin(0.8·t + i)))   # each wedge breathes
hue_i = hue + i/12
body:   filled triangle (c, c + dir(a0)·reach, c + dir(a0 + width)·reach)
        colour shade(rainbow(hue_i, 0.85, 1.0), 0.55)
fringe: edge = width·0.18
        filled triangle (c, c + dir(a0 − edge)·reach, c + dir(a0 + edge)·reach)
        colour shade(rainbow(hue_i + 0.10, 0.90, 1.0), 0.45)
        # drawn AFTER the body, straddling the leading edge a0 → overwrites it
```

Then `lo *= falloff` (BLEND_RGB_MULT), and `_blit_lo(surface, blur=True, every=4)`:
downscale `lo` to half size (bilinear average → antialias), upscale that to
`(w, h)` (bilinear → soft light ramp), additive blit at `(ox, oy)` —
**fixed to the arena, no focus parallax on this layer**. The full upscale is
recomputed one frame in four; the cached big surface is reused in between
(invisible at 0.16 rad/s ≈ a sixth of a degree per frame).

**Pixi mapping:** render the 24 triangles with a `Graphics` into a
`RenderTexture` of size `(w/4, h/4)` (skill: `pixijs-scene-graphics`; RTs in
`pixijs-custom-rendering`/`pixijs-performance`). Multiply the falloff over it by
also rendering a falloff Sprite (`blendMode 'multiply'`) into the same RT after
the triangles. Reproduce the blur by minifying once more: render that RT into an
`(w/8, h/8)` RT (linear filtering ≈ the pygame half-downscale), then display it
as a full-arena Sprite with linear mag filtering and `blendMode 'add'`. The
`every=4` throttle and the DIV=4-not-3 reasoning are CPU-era amortisations — on
GPU this whole path is cheap and can legitimately run every frame (§6); what
must be preserved is the *resolution chain* (¼ → ⅛ → full), because the visible
softness of the beams comes from those two bilinear steps.

The falloff mask itself: bake once to a texture — either draw the concentric-disc
`_radial` construction, or (equivalent and simpler on GPU) a radial gradient with
brightness `16/255 + (238/255)·(1 − (d/R)²)` clamped, `R = lh·0.62`, centred.

### 4.4 Lattice + core

- Lattice layer: `_blit_layer(…, depth 0.20)` — additive, margined, static.
- Core glow: additive stamp at `(ox + w·0.5, oy + h·0.5) + _par(0.45)`.

### 4.5 Shards — depth 0.95, per-frame triangle outlines

Centre `(scx, scy) = (ox + w·0.5, oy + h·0.5) + _par(0.95)`. Per shard:

```
a    = a0 + t·rate                       # orbital angle
pos  = (scx + cos(a)·orbit, scy + sin(a)·orbit·0.8)   # elliptical orbit
spin = t·(0.6 + rate)                    # own rotation
pts  = pos + dir(spin + TAU·k/3)·size, k = 0..2       # equilateral triangle
outline width 2, colour shade(rainbow(hue + a0, 0.7, 0.95), 0.6), normal blend
```

Pixi: per-frame `Graphics` strokes (7 triangles), or 7 small triangle Graphics
with `rotation`/`position`/`tint` updated (tint changes every frame with `hue`,
so per-frame stroke colour either way).

### 4.6 Sparks — depth 0.95, ADD, pre-baked bank

Same centre as shards. Per spark:

```
a  = a0 + t·rate·0.4
hi = int((hue + a0·0.3) · 16) mod 16                       # hue bucket
ki = int(clamp(0.5 + 0.5·sin(2.2·t + ph), 0, 0.999) · 5)   # brightness bucket 0..4
additive stamp bank[hi][ki] at (scx + cos(a)·orbit, scy + sin(a)·orbit·0.8)
```

Pixi: 18 ADD-blend sprites over **one** shared white radial-glow texture
(radius 5, quadratic falloff, 8 steps), with `tint = rainbow(hi/16, 0.5, 1.0)`
and `alpha ∝ (0.2 + 0.2·ki)` — tint·alpha of a white glow equals the pre-baked
coloured glow, so the 80-sprite bank collapses to one texture. Keep the hi/ki
quantisation if bucket-faithful stepping matters (§6).

### 4.7 Draw order (stage 12)

1. base gradient → 2. wedge fan via low-res buffer (ADD, no parallax) →
3. lattice (ADD, 0.20) → 4. core glow (ADD, 0.45) → 5. shards (stroked,
normal, 0.95) → 6. sparks (ADD, 0.95) → 7. vignette multiply.

---

## 5. TS mapping notes — data & API sources

| Python input | Web source |
|---|---|
| `C.ARENA_RECT` / `MAX_DT` | `web/src/core/config.ts` (`ARENA_X/Y/W/H`, `MAX_DT`); raw values in `web/src/data/config.json` |
| `P.Theme` fields `bg_top`, `bg_bottom`, `grid`, `accent`, `accent2`, `text` | `web/src/core/palette.ts` `Theme` (`bgTop`, `bgBottom`, `grid`, `accent`, `accent2`, `text` as RGB triples; `theme.hex.*` as packed 0xRRGGBB) loaded from `web/src/data/themes.json` (`THEMES[8..11]` for these stages; select via `themeForLevel(levelIndex)`) |
| `P.shade / lerp_color(_mix) / with_alpha / rainbow / hsv / clamp8` | `palette.ts`: `shade`, `lerpColor`, `withAlpha`, `rainbow`, `hsv`, `clamp8`; `toHex(rgb)` for Pixi tints/fills |
| `TAU`, `clamp`, `lerp` (`core.contracts`) | `web/src/core/mathx.ts` |
| Scene/stage plumbing | `web/src/app/Game.ts` (world root, scale), `web/src/app/Viewport.ts` (design-space transform + overscan), `web/src/app/Scene.ts` |
| Pixi API details | `web/node_modules/pixi.js/skills/`: `pixijs-scene-graphics` (fill/stroke/poly), `pixijs-scene-mesh` (aurora columns), `pixijs-scene-particle-container` / `pixijs-scene-sprite` (stars, sparks, lamps), `pixijs-blend-modes` (`'add'`, `'multiply'`), `pixijs-performance` / `pixijs-custom-rendering` (RenderTexture), `pixijs-color` |

**Coordinate spaces.** All geometry above is in design pixels. A background
instance owns a Container placed at `(ox, oy)` (arena origin) inside the scaled
world root; a rectangular mask (or scissor) over `rect` reproduces pygame's
`set_clip` — geometry deliberately overshoots the arena everywhere (`reach`,
plate positions, `max_r`) and relies on the clip. The overscan area outside
1280×720 is Viewport's job, not the background's; the background never draws
outside `rect`. If menus construct backgrounds with a non-arena rect, all `w`/`h`
-derived sizes above scale with it automatically — keep every formula in terms
of `w`/`h`, never literals.

**Per-frame vs cached — summary table.**

| Cached once (build) | Recomputed per frame |
|---|---|
| 9: gear frame banks, far-works layer, 6 plate sprites, train/piston/lamp state | 9: gear phases, frame pick, piston rects, lamp pulse |
| 10: 3 curtain strips (30×60 → ribbon_w×h), haze layer, star/ribbon state | 10: star twinkles, ribbon x/phase, per-column dy/src |
| 11: star rest coordinates, streak pool, core glow sprites, lens constants | 11: swirl/phase, every star position, 17 rings × 40 pts, 80 streak lines, core beat |
| 12: lattice, core glow, falloff mask, spark bank, shard/spark state | 12: 24 wedge triangles into the ¼-res buffer (+ multiply + upscale every 4th), shard triangles, spark stamps |

---

## 6. Invariants, performance notes, and porting choices

**Invariants worth asserting (tests):**

1. Gear mesh (stage 9): for any driver/driven pair created by `_train`, at all t:
   `phase_b(t) − [theta + π − π/nb + (na/nb)(theta − phase_a(t))]` ≡ 0 (mod TAU)
   — the mesh relation is preserved exactly because `omega_b = −omega_a·na/nb`.
2. Aurora source clamp: `0 ≤ src ≤ ribbon_w − step` always (sine amplitude 9 < step
   for all bands except… actually 9 > 8 for the near band — the clamp is load-bearing).
3. Voidwarp: lensed `r` is monotone in `r0` for `r0 > sqrt(K) − 60` (no image
   crossing); stars with `r < 8` are skipped, streaks respawn strictly at `r < 14`.
4. Prism: `hi ∈ [0, 15]`, `ki ∈ [0, 4]` for all t (the 0.999 clamp is what keeps
   `ki ≤ 4`); wedge fringe `edge < width/2` always (0.18 < 0.5).
5. Framework: `update`/render must never throw (wrap and degrade).

**Performance-critical (why Python caches, what the GPU changes):**

- Everything Python pre-renders (gear frames, strips, haze, lattice, falloff,
  spark bank, glow sprites) should become **textures generated once**; the port
  must not rebuild textures per frame.
- Python's ¼-res + `every=4` + 12-frame gear quantisation + spark bank are
  CPU-blit amortisations. On WebGL the honest equivalents (RenderTexture chain,
  per-frame Graphics, continuous rotation, tinted white glows) are all cheap.
  **Keep the resolution chain of the prism fan** (¼ → ⅛ → full bilinear) — that
  is a visible design decision (soft beams), not just a budget one.
- Per-frame CPU geometry the port keeps: voidwarp is the hot spot
  (190 stars + 680 ring vertices + 80 streaks of trig per frame) — still trivial
  in JS; batch into one Graphics + one sprite pool, avoid per-star allocations.
- pygame blits land on integer pixels (`int(...)` everywhere). Decide once,
  globally: `Math.trunc` positions for pixel-faithfulness (recommended, matches
  the CRT aesthetic and the Python) vs float positions.

**Porting choices / deliberate deviations to sign off (not guesses — flagged):**

- Gear rotation: quantised 12 steps/tooth-pitch (pixel-faithful, ~3.3° steps on
  the 9-tooth gear) vs continuous `sprite.rotation` (strictly smoother).
  Recommendation: continuous; the quantisation is an artefact of CPU rotation cost.
- Glow intensity quantisation (1/16 buckets) exists only for cache keys; smooth
  alpha modulation is the natural GPU port and is visually a superset.
- Prism `UPSCALE_EVERY = 4` frame-skipping: drop it (render every frame) unless
  the team wants bit-identical frame cadence with the Python capture tooling.

---

## 7. Open questions

1. **Ring motion vs docstring (stage 11):** the code moves rings *outward*
   (`r = max_r·((k + phase)/17 mod 1)^1.8`, phase increasing) while the comment
   says "accelerate inward". The spec follows the code; confirm nobody intended
   a sign flip (the shipped Python visual is outward-expanding pulses).
2. **`shade` overbrightness in stage 11:** star brightness `k` can reach ≈ 1.5;
   pygame's `shade` clamps per channel, which whitens saturated colours slightly
   rather than plain-brightening. A tint-based Pixi port must compute
   `toHex(shade(col, k))` per star per frame to match exactly — confirm that
   cost (trivial) vs approximating with alpha (cheaper, slightly dimmer at peaks).
3. **RNG stability:** Python seeds from salted `hash()`, so layouts already vary
   run-to-run. Should the TS port seed deterministically per (style, theme) for
   reproducible screenshots/tests, or mirror the per-run variation?
4. **Integer vs float positioning** (global, see §6): pick one policy across all
   background stages so parallax feels consistent between this spec and stages 1–8.
5. **Aurora star fills are overwrites, not adds** (`surface.fill` with no flag):
   over the near-black gradient a normal-blend sprite is visually identical, but
   if strict compositing fidelity is required the port would need to draw stars
   *before* any additive layer that could overlap them — the Python draw order
   already does this (stars first), so normal blend + existing order is exact
   enough; flagging so the implementer doesn't "fix" stars to additive.
6. **Menu-sized backgrounds:** menus may build these classes with the full-window
   rect (the framework's `_depth_cache` comment implies two sizes live at once).
   Confirm the web shell does the same so texture generation is parameterised by
   rect, not by `ARENA_RECT`.
