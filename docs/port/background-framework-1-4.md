# Port spec — Background framework + stages 1–4 (Grid, Nebula, Circuit, Lava)

Source of truth: `E:/SnakeGame/snake/gfx/background.py` (2331 lines; this spec covers
lines 1–1183 plus the registry at the end). Colours: `snake/palette.py` /
`web/src/core/palette.ts`. Nothing in the Python may be changed; where this spec and
the Python disagree, the Python wins.

Target: TypeScript + PixiJS v8 (WebGL), under the existing shell
(`web/src/app/Game.ts`, `Viewport.ts`, `Scene.ts`). Pixi API docs live at
`web/node_modules/pixi.js/skills/` (`pixijs-graphics`, `pixijs-filters`,
`pixijs-textures`, `pixijs-rendering`).

This document has three parts:

1. **Framework** — the `Background` base class, its helpers, the vignette/drift
   system, and the exact TS interface every stage implementation must satisfy
   (shared by the agents porting stages 5–12).
2. **Stages 1–4** — every layer and signature element with exact math.
3. **TS mapping notes, invariants, open questions.**

---

## 0. Coordinate spaces and the rect contract

- Everything is authored in **design pixels** (1280×720, `WINDOW_W`/`WINDOW_H` in
  `web/src/core/config.ts`).
- A `Background` is built for one **rect** `(x, y, w, h)` in design space:
  - Gameplay: `ARENA_RECT = (ARENA_X, ARENA_Y, ARENA_W, ARENA_H)` =
    `(14, 78, 1252, 628)` (all four exported by `web/src/core/config.ts`).
  - Menu / mode-select / level-select / settings / help / story / gameover in Python
    pass the full window `(0, 0, 1280, 720)`.
  - Web addition: menu-family scenes may instead pass `viewport.overscan` (a
    `DesignRect`, possibly wider than 1280 or taller than 720) so the background
    fills the letterbox area. See Open Questions §Q1.
- Rect is clamped to a minimum of 2×2. `w`, `h`, `ox = rect.x`, `oy = rect.y` are the
  four numbers every formula below refers to. **All stage math is arena-local**
  (0..w, 0..h); Python adds `ox/oy` at blit time. In TS put the whole background
  under a root `Container` positioned at `(rect.x, rect.y)` and keep children
  arena-local.
- `_MARGIN = 36`: every pre-rendered full-arena layer carries a 36 px black margin
  on all four sides (texture size `(w+72, h+72)`, arena-local (0,0) at texture
  (36,36)). This is slack for focus parallax (max ±22 px) plus scroll nudges, so a
  shifted layer never drags an empty edge into view.
- Python clips `_paint` to the rect (`surface.set_clip`). In Pixi: rectangle-mask the
  stage-layers container to `(0, 0, w, h)` (a shared `Graphics` rect mask; overshoot
  is then free, same as pygame). The base gradient does not need the mask (it is
  exactly rect-sized); the vignette sits on top and is also exactly rect-sized.

## 1. Framework architecture (base class + module utilities)

### 1.1 Factory and registry

```
STYLES = ("grid","nebula","circuit","lava","ocean","static",
          "ice","spores","machine","aurora","voidwarp","prism")
```

`make_background(style, theme, rect)`:

- Normalises the style key (`str(style or "").strip().lower()`).
- Unknown key → `GridBackground`.
- If the concrete class throws during construction → fall back to the plain base
  `Background` (gradient + vignette only). If *that* throws → base `Background`
  with `THEMES[0]` and `ARENA_RECT`.
- **Nothing in this module may raise.** `update()` and `draw()` swallow their own
  exceptions in Python. TS equivalent: wrap `build()`, `update()` in try/catch at
  the base-class boundary; log via `console.warn` in dev instead of dying.

### 1.2 `Background` base class — state and constants

Class constants (overridable, never overridden today):

| Constant | Value | Meaning |
|---|---|---|
| `PARALLAX` | `22.0` | max focus-parallax in px for a depth-1.0 layer |
| `FOCUS_TAU` | `1.4` | time constant (s) of the focus low-pass |
| `DRIFT_RATE` | `0.075` | rad/s of the global colour drift (≈84 s cycle) |
| `DEPTH` | `true` | opt-in flag for the multiply vignette (always true) |

Constructor (`__init__` + `_build`):

1. `style` (lower-cased string), `theme` (a `Theme`), `rect` (clamped ≥2×2);
   `w`, `h`, `ox`, `oy` derived. `t = 0`.
2. **RNG**: `random.Random(abs(hash((style, theme.name))) & 0xFFFFFFFF)`. Python's
   string hash is salted per process, so the Python layout is *already different
   every run* — bit-parity with Python randomness is neither possible nor required.
   TS: a seeded PRNG (e.g. mulberry32/sfc32) seeded from a stable FNV-1a hash of
   `` `${style}|${theme.name}` `` (deterministic across runs — an allowed
   improvement). Required API surface, matching Python semantics:
   `uniform(a,b)` (float in [a,b]), `randint(a,b)` (int, **inclusive** both ends),
   `randrange(n)` (int in [0,n)), `choice(arr)`.
3. Focus parallax state: smoothed `fx, fy = 0` and targets `tfx, tfy = 0`.
4. Drift: `driftPhase = rng.uniform(0, TAU)`, `drift = 0`, `depthIdx = -1`.
5. `base` = pre-rendered vertical gradient `w×h` from `theme.bg_top` (top) →
   `theme.bg_bottom` (bottom), then `_lift_centre()` bakes a soft centre glow into
   it (see §1.5).
6. Calls `_build()` (stage pre-render), exceptions swallowed.

### 1.3 `update(dt, focus?)` — exact behaviour

```
dt = clamp(dt, 0, MAX_DT)            # MAX_DT = 1/20 (config.ts MAX_DT)
t += dt
if focus given and both coords finite:      # non-finite samples are DROPPED, not clamped
    tfx = clamp((focus.x - rect.centerX) / (w * 0.5), -1, 1)
    tfy = clamp((focus.y - rect.centerY) / (h * 0.5), -1, 1)
k = clamp(dt / FOCUS_TAU, 0, 1)
fx += (tfx - fx) * k
fy += (tfy - fy) * k
drift = 0.5 + 0.5 * sin(t * DRIFT_RATE + driftPhase)
depthIdx = int(drift * (_DEPTH_STEPS - 1))       # _DEPTH_STEPS = 48
_animate(dt)                                     # stage hook
```

Callers: gameplay calls `update(sdt)` with a time-scaled dt and **no focus**;
`story_scene` passes the mouse position as focus; menu-family scenes call
`update(dt)` with no focus. `focus` is in the same design-space coords as `rect`.

Focus parallax offset for a layer at `depth` (`_par`):

```
px = -fx * PARALLAX * depth
py = -fy * PARALLAX * depth * 0.62
```

Depth semantics: 0 = infinitely far (never moves), 1 = right behind the snake.
Depth feeds only (a) `_par` and (b) the scroll rates each stage hard-codes.

### 1.4 `draw(surface)` — frame composition order

Python, per frame:

1. Blit `base` (gradient+lift) at `(ox, oy)` — plain overwrite blend.
2. Set clip to rect.
3. `_paint(surface)` — stage layers (mix of additive blits and normal-blend
   primitives; exact per-stage order below).
4. If `DEPTH`: blit the drift-tinted vignette `w×h` at `(ox, oy)` with
   `BLEND_RGB_MULT`.
5. Restore clip.

Pixi retained-mode equivalent — the root tree of every background:

```
root (Container @ rect.x, rect.y)
├── frame (Container)                 ← lava's heat-haze filter goes HERE (§5.6)
│   ├── baseSprite  (w×h, normal blend: gradient + baked centre lift)
│   └── layers      (Container, rect-masked to 0,0,w,h; stage children live here)
└── vignetteSprite  (w×h, blendMode 'multiply', tint animated per frame)
```

There is no per-frame `_paint` call: stages mutate their display objects (positions,
tilePositions, tints, alphas, and one or two per-frame `Graphics` rebuilds) inside
`animate(dt)`, and Pixi renders the tree.

### 1.5 Base gradient and centre lift (pre-rendered once)

- Gradient: Python builds a 1×h strip, `set_at(y) = lerp_color(bg_top, bg_bottom,
  y / max(1, h-1))`, then `smoothscale` to `(w,h)`. TS: 1×h canvas (or `h` px tall,
  1 wide) filled per-pixel with `lerpColor`, uploaded as a texture with linear
  sampling, sprite scaled to `w×h`. (A Pixi `FillGradient` is also acceptable —
  the ramp is linear either way.)
- Centre lift (`_lift_centre`), baked **into** the gradient texture:
  - `tint = mix(mix(bg_top, bg_bottom, 0.5), accent, 0.22)`
  - Build a 128×76 black canvas; additively stamp `_radial(74, tint, 0.20, steps=12)`
    centred at (64, 40) (the disc is clipped by the 128×76 bounds — keep that);
  - stretch the 128×76 canvas to `(w,h)` (bilinear) and **add** it onto the gradient.
  - Net effect: an elliptical brightening of the arena centre, slightly below-centre
    weighted, ~20% intensity. Do all of this once on a canvas and upload one
    `baseSprite` texture.
- Helper `_bg_at(yLocal) = lerp_color(bg_top, bg_bottom, clamp(yLocal/h, 0, 1))` —
  used per-frame by grid rungs and ocean; must be available to stages.

### 1.6 Radial glow sprites (`_radial`, `_glow_sprite`, `_add`)

`_radial(radius, color, intensity=1, steps=14)` — the single most used primitive.
Algorithm (replicate exactly, on a 2D canvas):

- `r = max(1, int(radius))`; surface is `2r × 2r`, black.
- If `r >= 128`, build at quarter scale (`rs = max(4, r // 4)`) and bilinear-upscale
  to `2r×2r` at the end; else build at full size (`rs = r`).
- For `i in 0..steps-1`: disc radius `rr = rs * sqrt(1 - i/steps)`; skip if
  `rr < 0.6`; fill colour `shade(color, intensity * (i+1)/steps)` — **overwrite**
  (each smaller disc paints over the larger). Result: stepped quadratic falloff
  `≈ color * intensity * (1 - (d/r)^2)`.
- Meant to be composited with `BLEND_RGB_ADD` (black backing, no alpha).

`_glow_sprite(radius, color, intensity, steps=14)` — cached variant, safe to call
per frame with animated brightness. Quantisation before the cache key:

- `r >= 64` → floor to multiple of 8; `8 <= r < 64` → floor to multiple of 2;
  else unchanged.
- `q = int(clamp(intensity, 0, 4) * 16 + 0.5)` (1/16 steps, so a pulsing glow
  lands in ≤16 buckets). Key `(r, rgb, q, steps)`; cache cleared wholesale past
  900 entries.

**Pixi mapping (important):** do **not** bake one texture per colour×intensity —
that is a CPU-blit-era workaround. Instead:

- Cache **greyscale/white** radial textures keyed on `(rQuantised, steps)` only:
  the disc algorithm above run with `color = (255,255,255)`, `intensity = 1`.
- Render each glow as a `Sprite` with `blendMode: 'add'`, `tint = colour`,
  `alpha = intensity`. With ADD blend this composes to
  `dst + white(d) * tint * alpha = dst + colour * intensity * (1-(d/r)²)` — exactly
  the pygame result **as long as `intensity ≤ 1`**, which holds for every call in
  stages 1–4 (max is 1.0). Intensity quantisation becomes unnecessary (alpha is
  free); keeping it is also fine.
- ⚠️ Shared-interface caveat for the stage 5–12 agents: `shade(col, f)` with `f > 1`
  saturates **per channel** (hue skews toward white). Tint×alpha cannot express
  `f > 1`. Any stage that passes `intensity > 1` must either bake a coloured
  texture for that case or accept the clamp. Flag it in their specs.

`_add(surface, sprite, cx, cy)` = additive blit centred on `(cx, cy)`, positions
truncated to int. TS: sprite `anchor = 0.5`, position `(cx, cy)` (int-truncate for
parity; see §7).

### 1.7 Layer scratch helpers (pre-render only)

All of these produce black-backed textures later composited with ADD:

- `_new_layer(extraW=0, extraH=0)` → `(w+72+extraW) × (h+72+extraH)` black canvas;
  arena-local (0,0) at (36,36).
- `_new_strip(width, extraH=0)` → `width × (h+72+extraH)` black canvas that tiles
  **horizontally** with period `width`; arena-local (0,0) at (0,36).
- `_soft_layer(div=4)` / `_soft_finish` → build soft-blob layers at 1/div scale
  (coords and radii divided by `div`), then bilinear-upscale to `(w+72)×(h+72)`.
  The upscale is the cheap blur. `_soft_strip(div)` / `_soft_strip_finish` — same
  for a `w`-wide strip → `w × (h+72)`.
- `_seamless_layer(w, h, tile_px, cells, fn)` → a perfectly wrapping tile:
  - `tile_px` floored to a multiple of `cells`; `step = tile_px / cells`.
  - Sample `fn(u, v)` (u,v in [0,1), wrapping: index `% cells / cells`) on a
    `(cells+1)²` pixel grid — the extra row/col repeats the first so bilinear
    interpolation crosses the seam correctly.
  - Bilinear-upscale the small grid to `(tile_px+step)²`, crop to `tile_px²`.
  - Python then tiles it over a `(w+tile_px) × (h+tile_px)` surface so one blit at
    any offset in `[0, tile_px)` covers the arena.
  - **Pixi:** stop at the `tile_px²` texture and use a **`TilingSprite`** sized
    `w×h` with `tilePosition` set per frame (add blend). The manual `-tile + mod`
    blit machinery disappears.
- `_noise_tiles(size, count, density, cols, rng)` (not used by stages 1–4; used by
  `static`): `count` black `size²` tiles, each with `density` horizontal streaks —
  `fill(cols[rng.randrange(len)], (rng.randrange(size), rng.randrange(size),
  rng.randint(1,4), 1))`. TS: canvas → texture bank.

**Composite ops inside a layer build** (this matters — pygame primitives are
overwrite, radial stamps are additive, and layers bake both):

| Element | Canvas op |
|---|---|
| `_add(...)` radial stamps | `globalCompositeOperation = 'lighter'` |
| `draw.line / lines / polygon / circle / rect / fill` | `'source-over'` (overwrite) |

'lighter' on an opaque canvas = per-channel saturating add = `BLEND_RGB_ADD`.

### 1.8 Per-frame layer placement (`_blit_layer`, `_wrap_add`)

- `_blit_layer(surface, layer, depth, dx=0, dy=0)`: additive blit at
  `(ox - 36 + px + dx, oy - 36 + py + dy)` with `(px,py) = _par(depth)`, positions
  int-truncated. TS: the layer is a `Sprite` (add blend) at arena-local
  `(-36 + px + dx, -36 + py + dy)`; update position in `animate()`.
- `_wrap_add(surface, strip, dx, dy=0, depth)`: horizontal wrap with period
  `lw = strip.width`:
  `x = ox + ((dx + px) mod lw) - lw` (Python mod → always ≥0), blit twice at `x`
  and `x+lw`; `y = oy - 36 + dy + py`. TS: a `TilingSprite` of the strip texture,
  size `w × (h+72)`, position `(0, -36 + dy + py)`, `tilePosition.x = dx + px`,
  add blend. (Wrap is exact because the strip texture's period is its width.)

### 1.9 Low-res additive buffer (`_lo_surface` / `_blit_lo`)

Not used by stages 1–4 (used by ice/machine/aurora/etc.), but part of the shared
base: a persistent `w/div × h/div` scratch the stage paints hard-edged polygons
into per frame; `_blit_lo(surface, blur, every)` upscales it to `w×h`
(optionally via an extra half-res downscale when `blur=true` — box-average
antialiases the edges) and adds it over the arena; `every=n` reuses the cached
upscale for n−1 frames. **Pixi:** a `RenderTexture` at 1/div resolution the stage
renders a small `Graphics` into, displayed by a `w×h` sprite (linear sampling is
the free blur), add blend; `blur=true` ≈ one extra half-res `RenderTexture` hop or
a cheap `BlurFilter`; the `every` throttle is unnecessary on GPU but harmless.
Include in the base class so stage agents 5–12 have it.

### 1.10 Depth vignette + global colour drift

Module-level constants:

```
_DEPTH_STEPS = 48      # drift quantisation steps
_DEPTH_EDGE  = 0.34    # fraction of brightness removed at the far corners
_DEPTH_TINT  = 13.0    # peak per-channel swing of the drift, 0..255
_DEPTH_TW, _DEPTH_TH = 128, 76      # template size
```

Template (built once, greyscale, 128×76 — replicate per-pixel):

```
dx = (i + 0.5)/128 * 2 - 1;  dy = (j + 0.5)/76 * 2 - 1
d  = clamp(hypot(dx, dy) / 1.34, 0, 1)
v  = int(255 * (1 - 0.34 * d^1.7))          # same v in r,g,b
```

Per drift step `idx` (0..47), Python multiplies the template by the solid colour

```
s = clamp(idx / 47, 0, 1)
tint = (255 - int(13*s), 255 - int(13*0.45), 255 - int(13*(1-s)))
     = (255 - int(13*s), 250, 255 - int(13*(1-s)))
```

then upscales to `(w,h)` and blits it over the finished frame with
`BLEND_RGB_MULT` (per-channel `a*b/255`). The elaborate Python cache
(`_DEPTH_SLOTS = 3` tinted copies per size, ≤2 sizes, rebuild ~1/s when the
quantised index moves — three slots because the menu cross-fades two backgrounds
on different drift phases) exists only because CPU tinting is expensive.

**Pixi mapping — the whole cache collapses:** one shared greyscale 128×76 vignette
texture (linear sampling), one `w×h` sprite per background with
`blendMode 'multiply'`, and set `sprite.tint = tint` per frame. Multiply blend of a
texture already multiplied by tint gives exactly `frame * (v * tint/255)/255` —
identical math, zero rebuilds. Keep the 48-step quantisation of `s` (from
`depthIdx`) for exact parity, or use continuous `s = drift` (visually
indistinguishable — note as an accepted micro-deviation if taken).

### 1.11 What is pre-rendered vs per-frame (framework summary)

Pre-rendered once in `build()`: gradient+lift, every `_new_layer`/`_new_strip`
texture, seamless tiles, glow textures (cached lazily), the vignette template.
Per frame: position/tilePosition updates, sprite tint/alpha updates, a bounded
number of normal-blend primitives (one `Graphics.clear()`+redraw per stage that
needs it), and the vignette tint. Nothing allocates per particle per frame.

---

## 2. The TS interface (shared contract for all stage agents)

Proposed files (new): `web/src/gfx/bg/` — `utils.ts` (RNG, colour coercion, radial
texture cache, gradient/seamless/noise builders), `Background.ts` (base class,
vignette), one file per stage (`GridBackground.ts`, …), `index.ts` (registry +
`makeBackground`). Suggested code shape — **this exact contract is what stages
5–12 must also implement**:

```ts
import { Container, Renderer, Texture } from "pixi.js";
import type { Theme, RGB } from "../../core/palette";
import type { DesignRect } from "../../app/Viewport";

/** Seeded PRNG with Python-shaped helpers. */
export interface Rng {
  random(): number;                    // [0,1)
  uniform(a: number, b: number): number;
  randint(a: number, b: number): number;   // inclusive both ends
  randrange(n: number): number;             // [0,n)
  choice<T>(arr: readonly T[]): T;
}

export class Background {
  static readonly PARALLAX = 22.0;
  static readonly FOCUS_TAU = 1.4;
  static readonly DRIFT_RATE = 0.075;

  readonly style: string;
  readonly theme: Theme;
  readonly rect: Readonly<DesignRect>;   // min 2x2, frozen copy
  readonly w: number; readonly h: number;

  /** Add this to the scene; positioned at (rect.x, rect.y). */
  readonly root: Container;
  /** Gradient + stage layers; the target for whole-frame effects (lava haze). */
  protected readonly frame: Container;
  /** Rect-masked container the stage's display objects live in. */
  protected readonly layers: Container;

  protected t = 0;
  protected fx = 0; protected fy = 0;    // smoothed focus, -1..1
  protected drift = 0;                    // 0..1
  protected readonly rng: Rng;

  constructor(style: string, theme: Theme, rect: DesignRect, renderer: Renderer);

  /** Advance; focus is a design-space point (snake head / mouse) or absent. */
  update(dt: number, focus?: { x: number; y: number } | null): void;
  // clamps dt to [0, MAX_DT], advances t / focus low-pass / drift,
  // updates vignette tint, then calls this.animate(dt) inside try/catch.

  destroy(): void;   // destroys root subtree; shared cached textures survive

  // ---- overridables -----------------------------------------------------
  /** Pre-render every static layer; called once from the constructor. */
  protected build(): void;
  /** Advance stage state AND push it into the display objects. */
  protected animate(dt: number): void;

  // ---- helpers available to every stage ----------------------------------
  protected par(depth: number): readonly [number, number];   // §1.3 formula
  protected bgAt(yLocal: number): RGB;                        // §1.5
  protected glowTexture(radius: number, steps?: number): Texture; // §1.6 cache
  // plus: margined-layer canvas builders (§1.7), wrap-strip TilingSprite helper
  // (§1.8), lo-res RenderTexture buffer (§1.9)
}

export function makeBackground(
  style: string, theme: Theme, rect: DesignRect, renderer: Renderer,
): Background;   // registry + fallbacks per §1.1
```

Contract details the implementers must honour:

- **Constructor inputs**: `style` (registry key), `theme` (from
  `palette.ts THEMES` / `themeForLevel`), `rect` (design px), `renderer` (needed
  for `RenderTexture`/`generateTexture`; canvas-built textures don't need it but
  the lo-res buffer does).
- **`update(dt, focus?)`** is the only per-frame entry point; there is no separate
  draw. It must never throw. `dt` may be 0 (paused frames); state must not NaN.
- **Resize/overscan**: a `Background` is immutable w.r.t. its rect (pre-rendered
  textures are rect-sized, exactly as in Python). When a scene's desired rect
  changes (rotation changes the overscan), the scene **disposes and rebuilds**
  with the same seed inputs so the layout is stable. Do not implement in-place
  resize.
- **Determinism**: all randomness through `this.rng`; no `Math.random()`.
- **Blend modes**: additive layers/sprites use `blendMode: 'add'`; primitives that
  pygame draws directly onto the frame (grid rungs, nebula stars, lightning
  strokes) use **normal** blend and must sit *above* the additive layers in child
  order — they genuinely overwrite/darken what is under them, and that is part of
  the look.
- **Child order = Python paint order.** Enumerated per stage below.

---

## 3. Stage 1 — GRID (`GridBackground`, theme "Neon Grid", `bg_style: "grid"`)

Constants: `ROWS = 22`, `SCROLL = 0.62` (rows/s).
Derived in build: `horizon = h * 0.32`, `span = h - horizon`,
`line_hot = mix(theme.grid, theme.accent, 0.55)`.

Layer stack (child order in `layers`):

1. **Sky** — pre-rendered margined layer, ADD, depth **0.12**.
2. **Far ridge** — wrap strip, ADD, depth **0.30**, scroll `x -= 5.0*dt`.
3. **Near ridge** — wrap strip, ADD, depth **0.55**, scroll `x -= 17.0*dt`.
4. **Ground fan** — pre-rendered margined layer, ADD, depth **0.85**.
5. **Rungs + horizon line** — per-frame `Graphics`, **normal blend**.

### 3.1 Sky (pre-rendered, `(w+72)×(h+72)` black, m = 36)

- Radial glow A: `_radial(w*0.42, shade(accent, 0.42), intensity 0.85, steps 12)`
  additively stamped at `(m + w/2, m + horizon)`.
- Radial glow B: `_radial(h*0.20, shade(accent2, 0.55), 0.7, 12)` at
  `(m + w/2, m + horizon - h*0.06)`.
- **Retro sun slats** — 7 horizontal lines, i = 0..6, overwrite:
  - `y = m + horizon - h*0.055 - i*(h*0.017)`
  - half-width `= sqrt(1 - (i/7)²) * h*0.15` (centred on `m + w/2`)
  - colour `shade(accent2, 0.9 - 0.09*i)`, thickness 3.
- **150 static stars** — 1×1 px overwrite fills:
  `sx = U(0,w)`, `sy = U(0, horizon-4)`,
  `f = U(0.25,1.0) * (1 - sy/horizon)^0.5`, colour `shade(theme.text, 0.55*f)`.
  (These overwrite glow pixels beneath them — keep 'source-over' in the bake.)

### 3.2 Ridges (`_ridge(band, col, seg, glow)` — wrap strips `w × (h+72)`)

- `seg` y-samples `ys[i] = U(band*0.25, band)`, with `ys[last] = ys[0]` so the
  strip wraps; points `pts[i] = (w * i/(seg-1), 36 + horizon - ys[i])`, int-cast.
- Filled polygon: pts + `(w, 36+horizon+4)` + `(0, 36+horizon+4)`, colour
  `shade(col, glow*0.16)` (the lit slope).
- Polyline over the top: colour `shade(col, glow)`, width 2 (the hot edge).
- Far: `band = h*0.16`, `col = mix(grid, accent2, 0.45)`, `seg 26`, `glow 0.55`.
- Near: `band = h*0.10`, `col = mix(grid, accent, 0.60)`, `seg 17`, `glow 0.95`.
- Animate: `ridge_far_x -= 5.0*dt`, `ridge_near_x -= 17.0*dt` (px/s; the 1:3.4
  speed ratio against depths 0.30/0.55 is the parallax cue). TS: TilingSprite
  `tilePosition.x = ridge_x + par(depth).x`, `position.y = -36 + par(depth).y`.

### 3.3 Ground fan (pre-rendered margined layer, depth 0.85)

53 lines, `k = -26..26`, from apex `(m + w/2, m + horizon)` to
`(m + w/2 + k*(w/13), m + h)` (bottoms overshoot the arena widely — the mask eats
it): `f = clamp(1 - |k|/26, 0.10, 1)`, colour `shade(grid, 0.55 + 1.05*f)`
(note: factor up to 1.6 → saturating shade), width 2 if `|k| ≤ 7` else 1.

### 3.4 Per-frame rungs (the signature — true perspective scroll)

State: `sweep = (sweep + 0.21*dt) % 1`. Per frame (normal-blend Graphics,
arena-local, after adding `par(0.85)` **y only** as `py`; the Python ignores the
x parallax for rungs):

```
phase = (t * 0.62) % 1
hot   = sweep * 22
for i in 1..22:
    z = i - phase
    if z <= 0.08: continue
    y = horizon + span / z + py           # perspective: rungs rush the viewer
    if y > h + 6: continue
    f = clamp(1 / (0.5 + z*0.44), 0, 1)
    f = clamp(f + 0.5 * max(0, 1 - |z - hot| * 0.9), 0, 1)   # travelling swell
    col = mix(bgAt(y), line_hot, f)       # bgAt = gradient colour at y
    horizontal line (0,y)-(w,y), width 2 if f > 0.55 else 1
```

### 3.5 Horizon sliver (per frame, same Graphics)

`beat = 0.55 + 0.45*sin(t*1.7)`; y = `horizon + par(0.30).y`; full-width line,
colour `mix(accent, theme.text, 0.35*beat)`, width 2, normal blend.

---

## 4. Stage 2 — NEBULA (`NebulaBackground`, theme "Deep Nebula", `bg_style: "nebula"`)

Constants: `LAYER_SPEEDS = (6, 14, 30)` px/s, `LAYER_DEPTHS = (0.20, 0.45, 0.80)`,
`MOTES = 54`. Cloud tints: `(accent, accent2, grid, mix(accent, accent2, 0.5))`.

Child order in `layers`:

1. **Far clouds** — wrap strip, ADD, painted depth **0.15**, scroll `+2.5*dt`.
2. **Near clouds** — wrap strip, ADD, depth **0.35**, scroll `+7.0*dt`.
3. **Light shafts** — margined layer, ADD, depth **0.5**, swayed
   `dx = sin(t*0.13) * w*0.02`.
4. **Stars ×3 layers** — per-frame rect fills, **normal blend** (overwrite!).
5. **Bright stars** — 9 additive glow sprites.
6. **Motes** — 54 additive glow sprites (the signature).

### 4.1 Cloud banks (`_clouds(count, rmin, rmax, tints, amp)`)

Built at **quarter resolution** (`_soft_strip(4)`: canvas `w/4 × (h+72)/4`), then
bilinear-upscaled to `w × (h+72)`:

- `count` blobs: radius `U(rmin, rmax)/4`; colour
  `shade(tints[rng.randrange(4)], U(amp*0.5, amp))`; radial stamped with
  `_radial(r, col, 1.0, steps 10)`, additive ('lighter').
- `x = U(0, stripW)`, `y = (36 + U(-0.1h, 1.1h))/4`.
- Seam handling: if `x < r` also stamp at `x + stripW`; if `x > stripW - r` also
  at `x - stripW`.
- Far bank: `_clouds(16, h*0.26, h*0.55, tints, 0.10)`.
- Near bank: `_clouds(20, h*0.10, h*0.30, tints, 0.15)`.
- Animate: `far_x += 2.5*dt`, `near_x += 7.0*dt` (drift rightward — positive dx
  in `_wrap_add` scrolls the pattern left-to-right? Follow the formula: the strip
  is blitted at `((dx+px) mod lw) - lw`, i.e. increasing dx moves the texture
  **right**; TilingSprite `tilePosition.x = dx + px` matches exactly).

### 4.2 Light shafts (pre-rendered margined layer, depth 0.5)

Two vertical wedges at `shaft_x = (0.32*w, 0.71*w)`. For each shaft, filled rows
every 3 px over the full margined height `yy = 0, 3, ... < h+72` (overwrite):

```
v    = clamp((yy - 36)/h, 0, 1)
f    = (1 - v)^1.5                        # brightest at the top, fading down
half = w * (0.035 + 0.075*v)              # widening downward
rect (36 + sx - half, yy, 2*half, 3), colour shade(accent2, 0.055*f)
```

Per frame the whole layer sways: `dx = sin(t*0.13) * w*0.02`, plus `par(0.5)`.

### 4.3 Star layers (per frame, normal blend)

Three layers `li = 0,1,2` with `96 - 16*li` stars (96/80/64). Star record:
`[x U(0,w), y U(0,h), size = 1+li, phase U(0,TAU), amp U(0.45,1.0)]`.
`star_col = mix(theme.text, accent2, 0.25)`.

- Animate: `x -= LAYER_SPEEDS[li]*dt`; on `x < 0`: `x += w`, `y = U(0,h)` re-rolled.
- Paint: parallax `par(LAYER_DEPTHS[li])` int-truncated; twinkle
  `tw = 0.55 + 0.45*sin(t*2.3 + phase)`; colour `shade(star_col, amp*tw)`;
  a `size × size` px **overwrite** rect at `(int(x)+ix, int(y)+iy)`.
- ⚠️ Overwrite is deliberate: a star at twinkle-minimum paints a *dark* square over
  the cloud layers. Use normal blend, not add. (Rects can be one `Graphics` cleared
  per frame, or 240 tinted 1px-texture sprites — either is fine.)

### 4.4 Bright stars (9, additive)

`(x U(0,w), y U(0,h), r U(5,11), ph U(0,TAU))`; static positions; parallax
`par(0.55)`. Per frame: `k = 0.6 + 0.4*sin(t*1.3 + ph)`; glow sprite radius
`int(r)`, colour `accent2`, intensity `0.55*k + 0.25` (≤ 0.8) → sprite alpha.

### 4.5 Dust motes (54, additive — the signature)

Record: `[x U(0,w), y U(0,h), vx U(-9,9), vy U(-16,-4), ph U(0,TAU),
rate U(0.5,1.6), r = randint(2,5)]`. `mote_col = mix(theme.text, accent, 0.35)`.

- Animate: `x += vx*dt + sin(ph)*9*dt`; `y += vy*dt` (rising); `ph += rate*dt`;
  wraps: `y < -20 → y = h+20, x = U(0,w)`; `x < -20 → x = w+18`;
  `x > w+20 → x = -18`.
- Paint at `par(0.95)`, with `sway` = the shaft sway of §4.2:
  ```
  s0 = 0.32w + sway;  s1 = 0.71w + sway;  reach = 0.13*w
  lit = clamp(1 - min(|x-s0|, |x-s1|) / reach, 0, 1)
  k   = (0.16 + 0.62*lit) * (0.6 + 0.4*sin(t*2.6 + ph))
  ```
  glow sprite radius `r` (2..5 px core → texture 4..10 px), colour `mote_col`,
  intensity `k` (≤ 0.78). Only motes inside a shaft actually sparkle.

---

## 5. Stage 3 — CIRCUIT (`CircuitBackground`, theme "Emerald Circuit", `bg_style: "circuit"`)

Constant: `ARCS = 3` (max live bolts).

Child order in `layers`:

1. **Substrate mesh** — seamless tile 128 px, ADD (TilingSprite), depth **0.10**.
2. **Traces + pads** — margined layer, ADD, depth **0.45**.
3. **Chips** — margined layer, ADD, depth **0.90**.
4. **Pulses** — 28 × (tail glow + head glow) additive sprites, at `par(0.45)`.
5. **Lightning arcs** — up to 3 slots, each = normal-blend polyline passes +
   2 additive endpoint flashes (the signature). Keep per-arc ordering:
   lines of arc n, then its flashes, then arc n+1.

### 5.1 Substrate (depth 0.10)

`fine = mix(theme.grid, theme.bg_bottom, 0.35)`; seamless tile
`tile_px = 128`, `cells = 32`, sampler:

```
k = (0.5 + 0.5*cos(u*TAU*4)) * (0.5 + 0.5*cos(v*TAU*4))
mesh(u,v) = shade(fine, 0.24 * k²)
```

Scroll: `off.x += 3.5*dt`, `off.y += 2.0*dt`, both `mod 128`. Painted additively
at `tilePosition = (off.x + par(0.10).x, off.y + par(0.10).y)` (Python does the
equivalent `-tile + mod` blit of a pre-tiled `(w+128)×(h+128)` surface).

### 5.2 Traces (depth 0.45) + node list

Manhattan routing on a 34 px lattice; colours `dim = shade(grid, 1.15)`,
`pad = mix(grid, accent, 0.4)`. 30 attempts:

- Start `x = round(U(0,w)/34)*34`, same for y. Alternate horizontal/vertical
  (first axis: 50/50). `randint(4,8)` runs; each run
  `34 * randint(2,7) * choice(-1, +1)` along the current axis, position clamped to
  `[-20, w+20]` / `[-20, h+20]`; axis flips each run.
- Compute cumulative segment lengths; discard the path if total `< 60`.
- Kept paths: draw polyline `dim`, width 2 (overwrite in the bake); at **every**
  vertex a circle **outline** radius 4, stroke width 1, colour `pad`.
- Keep `paths: (pts, cum)[]` and `nodes` = all vertices of all kept paths (data
  for pulses and arcs).

### 5.3 Chips (depth 0.90)

20 rounded rects: `cw = randint(26,64)`, `ch = randint(20,40)`, position
`(36 + U(0, w-cw), 36 + U(0, h-ch))` int-cast:

- outline width 1, corner radius 3, colour `shade(grid, 0.9)`;
- pin-1 dot: filled circle radius 2, colour `pad`, at `(x+6, y+6)`;
- leg pins: 3×3 px fills, colour `shade(grid, 0.7)`, at
  `bx = x+5, x+13, ... < right-3` along both the bottom edge (`y = rect.bottom`)
  and the top edge (`y = rect.y - 3`).

### 5.4 Data pulses (28)

Record `[pathIndex = i % numPaths, s = U(0,1), speed = U(90, 210)]` (px/s along
arc length). Colours: `pulse_col = mix(accent, theme.text, 0.25)`; tail uses
`accent2`.

- Animate: `s += speed*dt / max(1, pathLength)`; on `s > 1`: `s -= 1`,
  `pathIndex = randrange(numPaths)` (re-deals to a random path).
- `pointAt(pi, s)`: arc-length interpolation over the cumulative table
  (binary search the segment, then lerp) — port as written.
- Paint at `par(0.45)`, per pulse: tail glow radius **7**, colour `accent2`,
  intensity **0.42**, at `pointAt(pi, s - 0.045)` (pointAt clamps s to ≥0);
  head glow radius **11**, colour `pulse_col`, intensity
  `beat = 0.75 + 0.25*sin(t*2)` (shared across all pulses). Tail drawn before
  head per pulse (additive, so inter-pulse order is immaterial).

### 5.5 Lightning arcs (the signature)

Spawning: cooldown starts `U(0.2, 1.0)`; each expiry resets it to `U(0.35, 1.5)`
and, if fewer than 3 arcs live, tries to spawn:

- Pick node `a` at random; up to 8 attempts to find node `b` with distance
  `70 < d < 280`; give up silently otherwise.
- Perpendicular `n = ((b.y-a.y)/d, -(b.x-a.x)/d)`. 10 points (`steps = 9`):
  `f = i/9`, wobble `= 0` at the endpoints else `U(-1,1) * d * 0.10`;
  `pt = lerp(a,b,f) + n * wobble`, int-cast. Life `U(0.14, 0.30)` s, age 0.

Animate: `age += dt`; remove when `age >= life`.

Paint (at the same `par(0.45)` offset as the pulses, int-truncated):

```
f = (1 - clamp(age/life, 0, 1)) * (0.55 + 0.45*sin(age * 90))   # crackle flicker
if f <= 0.02: skip
polyline pass 1: colour shade(accent2, 0.18*f), width 7   # arc_cool = accent2
polyline pass 2: colour shade(accent2, 0.55*f), width 3
polyline pass 3: colour shade(arc_hot,  f),     width 1   # arc_hot = mix(accent2, text, 0.55)
endpoint flashes: glow radius 16, arc_hot, intensity 0.7*f, additive, at pts[0] and pts[-1]
```

The three wide→narrow **normal-blend** passes fake a bloom; the dim wide pass will
*darken* bright trace pixels under it — keep normal blend. Implement as ≤3 arc
slots, each owning a `Graphics` (cleared per frame) and two flash sprites
(visible only while its arc lives).

---

## 6. Stage 4 — LAVA (`LavaBackground`, theme "Solar Flare", `bg_style: "lava"`)

Constants: `EMBERS = 78`, `HAZE_H = 132`.

Child order in `layers`:

1. **Molten floor glow** ("deep") — soft margined layer, ADD, depth **0.12**.
2. **Heat shimmer** — seamless tile 256, ADD (TilingSprite), depth **0.35**.
3. **Cracks** — margined layer, ADD, depth **0.55**.
4. **Crack sweep** — one large additive glow sprite, animated x.
5. **Embers** — 78 additive glow sprites, at `par(0.95)`.
6. **Heat haze** — a refraction pass over everything above (the signature);
   in Pixi a custom filter on the `frame` container (§6.6).

### 6.1 Molten floor ("deep", depth 0.12)

Quarter-res soft layer (`_soft_layer(4)`), upscaled to `(w+72)×(h+72)`:
one radial sprite `_radial(h*0.38/4, shade(accent, 0.16), 1.0, steps 8)`, stamped
additively 8 times at
`x = (36 + w*(i+0.5)/8 + U(-40, 40)) / 4`, `y = (36 + h + 0.06h) / 4`
(i.e. centres sit *below* the arena bottom; only the top halves show).

### 6.2 Cracks (depth 0.55)

Margined layer, 24 jagged polylines (overwrite passes on black):

- Start `x = U(0,w)`, `y = U(0.30h, 1.02h)`; heading `ang = U(0, TAU)`.
- `randint(5,11)` segments: `ang += U(-1.1, 1.1)`; `step = U(24, 62)`;
  `x += cos(ang)*step`; `y += sin(ang)*step*0.55` (flattened vertically).
- `depth = clamp(y₀/h, 0, 1)` (start y); base colour
  `glow = shade(mix(theme.hazard, accent, 0.40), 0.40 + 0.6*depth)` — lower
  cracks run hotter.
- Three passes wide→narrow (the free bloom): width 17 `shade(glow, 0.14)`;
  width 8 `shade(glow, 0.38)`; width 3 `mix(glow, theme.text, 0.35)`.

### 6.3 Heat shimmer (depth 0.35)

`hot = mix(accent, theme.hazard, 0.4)`; seamless tile `tile_px = 256`,
`cells = 32`, sampler ignores u:

```
k = (0.5 + 0.5*sin(v*TAU*3))³
band(u,v) = shade(hot, 0.10 * k)
```

Animate: `shimmer_y = (shimmer_y + 26*dt) % 256`. Paint: TilingSprite,
`tilePosition = (par(0.35).x, shimmer_y + par(0.35).y)`. ⚠️ The build-time comment
says the bands "scroll upward", but the blit formula
(`oy - tile + (shimmer_y + py) % tile`) moves the pattern **downward** as
`shimmer_y` grows. Follow the formula, not the comment (see Q3).

### 6.4 Crack sweep (per frame)

`wave = (t * 0.35) % 1`; one additive glow: radius `int(w*0.22)` (glow-cache
quantised to a multiple of 8), colour `accent`, intensity `0.30`, centred at
`(wave * w, 0.86*h)` — a slow brightness swell riding along the crack field. No
parallax offset (drawn between the 0.55 layer and the embers).

### 6.5 Embers (78, additive, depth 0.95)

Record `[x U(0,w), y (build: U(0,h); respawn: h+8), rise U(22,74) px/s,
r U(2.5,6.5), ph U(0,TAU), colourIdx randrange(3)]`.
Colours `ember_cols = (accent, mix(accent, hazard, 0.6), hazard)`.

- Animate: `y -= rise*dt`; `ph += 1.7*dt`; `x += sin(ph)*16*dt`; when `y < -10`
  re-roll the whole record (respawn at the bottom).
- Paint: `k = 0.55 + 0.45*sin(ph*2)`; glow radius `int(r*3)` (7..19, cache-
  quantised to even), colour `ember_cols[colourIdx]`, intensity `0.70*k` → alpha.
  One persistent sprite per ember; texture fixed at spawn (radius doesn't
  animate), only position and alpha change per frame — re-tint/re-texture on
  respawn.

### 6.6 Heat haze (the signature — real refraction)

Python: a `w × haze_h` scratch buffer; per frame it copies the band
`(ox, oy+top, w, hgt)` of the **already-composited frame** (base + all lava
layers — the haze is the last thing `_paint` does) and re-blits it in 4-px-tall
slices with a sinusoidal x offset:

```
haze_h = min(132, max(24, 0.24*h))              # 132 for the 628-tall arena
haze_y starts at h; haze_y -= 34*dt; when haze_y < -haze_h: haze_y = h
top = max(0, haze_y); bot = min(h, haze_y + haze_h); hgt = bot - top
if hgt < 12: skip
for i = 0, 4, 8, ... < hgt:
    f  = sin(π * (i + top - haze_y) / haze_h)   # envelope over the band
    dx = sin(t*3.1 + i*0.13) * 7 * max(0, f)
    blit slice (0, i, w, 4) of the copied band to (dx, top + i)
```

Note the band refracts only what the *background* has painted (the background
draws before the snake), and the vignette multiplies **after** the haze.

**Pixi mapping:** a small custom `Filter` (GLSL) applied to the `frame` container
(gradient + layers, *not* the vignette):

- Uniforms: `uHazeY` (= top-of-band in arena px), `uHazeH`, `uTime`, plus the
  input-size/texel uniforms Pixi v8 filters get for free.
- Fragment: for pixels with `y` in `[hazeY, hazeY+hazeH)`, quantise the row
  `i = floor((y - max(0, hazeY)) / 4) * 4`, compute `f`/`dx` per the formulas
  above, and sample the input at `x - dx` (Python *writes* the slice shifted by
  `+dx`, which reads back as sampling at `-dx`); clamp the sample x to the arena.
  Elsewhere pass through.
- Set the filter only on the lava background's `frame`; it must respect the
  arena bounds (`filterArea`/mask interplay — verify against
  `pixijs-filters` docs). A fallback implementation (identical to Python): render
  `frame` into a `RenderTexture` and draw `hgt/4` strip sprites with per-strip x
  offsets — correct but clunkier; the filter is preferred.

---

## 7. TS mapping notes — where every input comes from

| Python reads | TS source |
|---|---|
| `C.ARENA_RECT`, `C.MAX_DT`, `C.WINDOW_W/H` | `web/src/core/config.ts` (`ARENA_X/Y/W/H`, `MAX_DT`, `WINDOW_W/H`) |
| `P.Theme` fields `bg_top, bg_bottom, grid, accent, accent2, hazard, text` | `web/src/core/palette.ts` `Theme` (`bgTop, bgBottom, grid, accent, accent2, hazard, text`) — loaded from `web/src/data/themes.json`; **never** hard-code hex; keep RGB triples through the math and pack with `toHex` only at the sprite/Graphics boundary |
| `P.clamp8, lerp_color, shade` | `palette.ts` `clamp8, lerpColor, shade` (already bit-matched, incl. truncation) |
| `contracts.TAU, clamp, lerp` | `web/src/core/mathx.ts` `TAU, clamp, lerp` |
| `P.THEMES`, `theme_for_level` | `palette.ts` `THEMES`, `themeForLevel` |
| pygame `Surface` pre-renders | Canvas2D-built `Texture`s (upload once) or `RenderTexture` |
| `BLEND_RGB_ADD` blits | `blendMode: 'add'` sprites / Graphics |
| `BLEND_RGB_MULT` vignette | `blendMode: 'multiply'` sprite + per-frame `tint` |
| `Surface.set_clip(rect)` | rectangle mask (`Graphics`) on the `layers` container |
| `smoothscale` up | linear-filtered texture sampling / `drawImage` upscale |
| wrap blits (`_wrap_add`, seamless) | `TilingSprite` + `tilePosition` |
| per-frame `pygame.draw.*` | one `Graphics` per stage, `clear()` + redraw per frame |
| glow sprite cache | module cache of **white** radial textures keyed `(rQuantised, steps)`; colour via `tint`, intensity via `alpha` (valid for intensity ≤ 1 — all of stages 1–4) |

- Levels data (`levels.json`) is **not** needed by backgrounds; only the theme and
  rect are.
- Int truncation: pygame blits at `int(x)` (truncate toward zero). For parity,
  truncate sprite/Graphics positions that Python truncates (layer blits, star
  rects, arc points, glow stamps). It is cheap and eliminates subpixel drift
  differences.
- pygame thick `draw.lines` has butt caps and no joint filling (visible notches on
  sharp bends). Pixi strokes with round/miter joins will look slightly *cleaner*
  on cracks/arcs/ridges — accepted deviation; use `cap: 'butt', join: 'miter'`
  to stay closest.

## 8. Invariants worth asserting (dev builds)

- `rect.w >= 2 && rect.h >= 2`; all four rect fields finite.
- `fx, fy ∈ [-1, 1]`; never NaN (assert after the low-pass).
- `_MARGIN (36) > PARALLAX (22)` — parallax can never expose a layer edge.
- Glow texture cache size bounded (< ~64 white radials; the Python cap of 900
  coloured surfaces becomes irrelevant).
- Every stage's `animate` runs with `dt ∈ [0, MAX_DT]`.
- Circuit: `paths.length >= 1` after build (Python early-returns from `_paint`
  when 0 — keep that guard: 30 attempts each ≥60 px long virtually guarantees
  paths, but the guard costs nothing). `pulses[i].pathIndex < paths.length`
  always. `arcs.length <= 3`.
- Nebula star counts 96/80/64; motes 54; embers 78 — fixed pools, no per-frame
  allocation.
- All textures built in `build()`; steady-state frames allocate nothing.

Performance notes (what pygame caches because it's expensive, and what that
becomes):

- The glow cache, quarter-res soft layers, the `every`-frame smoothscale
  throttle, and the 3-slot vignette cache are all **CPU-blit workarounds**; on
  GPU they collapse to texture reuse + tint/alpha. Keep the *textures-built-once*
  discipline; drop the frame throttles.
- Per-frame budgets (all trivial for WebGL): grid ≈ 23 line draws; nebula ≈ 240
  rects + 63 sprites; circuit ≈ 56 sprites + ≤3×3 polylines + ≤6 flashes; lava ≈
  79 sprites + 1 filter pass. The only genuinely new GPU cost is the lava haze
  filter — one extra pass over the background container, fine.
- Menu cross-fades run **two** backgrounds at once (each with its own drift
  phase) — the design must tolerate two live instances.

## 9. Open questions (do not guess — resolve with the user/orchestrator)

1. **Menu rect vs overscan.** Python menu-family scenes build backgrounds at
   `(0,0,1280,720)`. The web shell exposes `viewport.overscan` explicitly so
   backgrounds can fill the letterbox. Should the ported menu scenes pass the
   overscan rect (rebuild on resize/rotation, same seed) or stay at the design
   box? The framework as specced supports either; gameplay always uses
   `ARENA_RECT`.
2. **RNG parity.** Python's layout RNG is seeded from a per-process-salted
   `hash()`, so layouts already differ run to run. Confirm that a stable TS seed
   (per style+theme) is acceptable — it is strictly more deterministic, and it
   makes rotated/rebuilt overscan backgrounds keep their layout.
3. **Lava shimmer direction.** Docstring says the bands scroll *upward*; the blit
   arithmetic moves the pattern *downward* (~26 px/s). Spec says follow the code;
   confirm nobody wants the docstring behaviour instead.
4. **Vignette drift quantisation.** Keep the 48-step quantisation of the tint
   (exact parity) or use the continuous drift value (smoother, visually
   indistinguishable)? Default in this spec: keep quantisation.
5. **Haze filter scope.** The Python haze refracts only the background (it draws
   before the snake). If a future combined post-processing chain reorders
   rendering, the haze filter must stay pinned to the background `frame`
   container only — flag if the renderer architecture wants it elsewhere.
6. **`antialias: false`** is set on the Pixi app. Pygame's `draw.line/polygon`
   are hard-edged too, so this matches; but Graphics strokes at width 1 may look
   more ragged than pygame's. If stage 1 rungs shimmer objectionably, per-object
   AA decisions are a fidelity call to make on-screen, not in this spec.
