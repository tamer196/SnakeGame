# Port spec - hazards, power-up runes and food animation

**Ground truth (do not modify):**

| File | Lines | What it draws |
|---|---|---|
| `E:/SnakeGame/snake/core/obstacles.py` | 1093 | WallBlock, MovingBar, Spinner, Pulsar, LaserGate, Portal - each with its own `_draw` |
| `E:/SnakeGame/snake/core/powerups.py` | 834 | The six power-up runes (magnet / shield / slow / double / ghost / frenzy) |
| `E:/SnakeGame/snake/core/food.py` | 555 | Orb bob / pop-in / breathe / wither / blink; delegates painting to `render.draw_food_orb` |

**Companion spec:** `E:/SnakeGame/docs/port/render.md` covers `snake/gfx/render.py` - the shared
glow/disc/flare primitive layer (`glow_surface`, `disc_surface`, `_flare_surface`,
`draw_glow_circle`), the snake, the arena frame and the food-orb *painter*. This document reuses its
vocabulary (`stampGlow`, "glow texture cache", "the additive-glow convention") and does **not**
redefine them. Read render.md sections 0, 1 and 6 first.

**Suggested TS homes:**

- `web/src/gfx/hazards.ts` - the six hazard renderers + the obstacles-local primitive layer (S1).
- `web/src/gfx/runes.ts` - power-up rune renderer + the vector-glyph texture factory.
- Food needs no new module: `render.ts::drawFoodOrb` already exists per render.md S10; food.py's
  contribution is the *animation state* (S11 here), which the ported sim already computes.

Coordinate space throughout: **1280x720 design pixels**; arena rect
`ARENA_X, ARENA_Y, ARENA_W, ARENA_H = 14, 78, 1252, 628` (`web/src/core/config.ts`).
Angles are radians, `0 = +x`, **y grows downward**, so increasing angle in direct
`cos/sin` trig is **clockwise on screen**. (The single exception is `pygame.draw.arc`, which uses the
mathematical y-up convention - see S1.9.)

---

## 0. Scope map and the one class that does not exist

### 0.1 What is here

| Entity | Python | Deadly? | Animated by |
|---|---|---|---|
| WallBlock ("wall") | obstacles.py:326-371 | yes | draw-time `t` only (no `_update`) |
| MovingBar ("movingbar", the "sweeper") | obstacles.py:377-483 | yes | `_update(dt, t)` from `t` |
| Spinner | obstacles.py:489-570 | yes | `_update` from `t` |
| Pulsar | obstacles.py:576-671 | **only while inflated** | `_update` from `t` |
| LaserGate | obstacles.py:677-776 | **only while firing** | `_update` from `t` |
| Portal | obstacles.py:782-892 | no (teleports) | `_update` from `t` **and** `dt` (cooldown) |
| Power-up rune (6 kinds) | powerups.py:614-685 | n/a | item `_age` (integrated dt) + field clock `t` |
| Food orb states | food.py:164-204 | n/a | scene clock `t` and per-orb `born` |

### 0.2 "Tidal columns" do not exist

The assignment lists "tidal columns" as a hazard. **There is no such class.** `_TYPE_MAP`
(obstacles.py:898-911) accepts exactly: `wall|wallblock|block`, `movingbar|bar|moving_bar`,
`spinner`, `pulsar`, `lasergate|laser|laser_gate`, `portal`. A grep for `tidal` across
`*.py`, `*.json`, `*.ts` in the repo returns nothing. The closest thing is a **vertical MovingBar**
(`axis: "y"`), which reads as a rising/falling column. Treat "tidal column" as a level-design
nickname for that, and do **not** invent a seventh hazard.

Actual usage across the 12 shipped levels (`web/src/data/levels.json`, key `obstacleSpec`):
54 walls, 20 pulsars, 15 spinners, 14 moving bars, 12 portals, 10 laser gates. Every `movingbar`
entry in the shipped levels uses `axis: "x"`.

### 0.3 Draw order and clocks (from `scenes/gameplay.py::_draw`, lines 1174-1225)

```
background
draw_arena(surface, arena, theme, clock_t)
draw_obstacles(surface, obstacles, theme, hazard_t)   <-- SEPARATE CLOCK
food.draw(surface, clock_t)
runes.draw(surface, clock_t)
[clip to arena] snake + particles [unclip]
popups, HUD, pause button, READY/GO
```

Two clocks:

- `clock_t` += `sdt` where `sdt = clamp(dt * fx.time_scale(), 0, MAX_DT)` (gameplay.py:564-565).
  Food, runes, arena and snake use this.
- `hazard_t` += `sdt * self.hazard_mult` (gameplay.py:567-569). Hazards are **simulated and drawn**
  from `hazard_t`, so a difficulty that speeds hazards up speeds their animation up with them.
  A hazard renderer must never be handed `clock_t`.

`draw_obstacles` (obstacles.py:1077-1085) makes **two passes over the list**: every `Portal` first,
then every non-Portal. Within each pass, list order (= spec declaration order). So portals always
sit *under* every other hazard, including under a wall that overlaps them.

### 0.4 Clipping

Three independent clip regions, all identical in practice:

- `Obstacle.draw` (obstacles.py:276-304) sets `surface.set_clip(self.arena)` **per hazard**, then
  restores. Rationale in the source comment: additive halos are generous (a laser pads its glow by
  `width+8`, a wall by up to 38 px) and `ARENA_Y == HUD_H == 78`, so there is no gap above the arena
  to absorb bloom.
- `PowerUpField.draw` (powerups.py:583-612) clips to `self.rect`.
- `FoodField.draw` (food.py:515-554) clips to `self.rect`.

All three rects are the arena rect. **Pixi:** one rectangular mask on a shared world container that
holds hazards + food + runes (+ snake + particles, which gameplay clips to the same rect). Do not
put a mask on each hazard - Pixi masks are stencil ops and 20 of them per frame is a real cost, and
the result is provably identical because the rects are equal.

---

## 1. The obstacles.py primitive layer - and its critical divergence from render.py

`obstacles.py` does **not** use `render.py`'s glow cache. It has its own, at lines 82-237, with
different maths. Understanding the difference is the single most important thing in this document,
because a "sensible" port produces a completely different-looking game.

### 1.1 THE CRITICAL FINDING: these glows have no falloff on screen

`_glow_sprite` (obstacles.py:85-115) bakes its radial ramp into **ALPHA** and leaves **RGB at full
colour**:

```python
for i in range(steps, 0, -1):          # outside-in
    f = i / steps
    a = P.clamp8(255.0 * inten * (1.0 - f) ** 1.9)
    if a <= 0: continue
    pygame.draw.circle(surf, (col[0], col[1], col[2], a), (r, r), max(1, int(r * f)))
```

`pygame.draw.*` **writes** RGBA directly (it does not blend), so every drawn pixel ends up with
`RGB == col` and a varying alpha. `_add_glow` then blits with `pygame.BLEND_RGB_ADD`, which does
`dst.rgb = min(255, dst.rgb + src.rgb)` and **ignores source alpha entirely**.

Verified empirically against pygame 2.6.1 / SDL 2.28.4 in this repo:

```
sprite pixel at centre : (200, 100, 50, 60)
dest (10,10,10) after BLEND_RGB_ADD : (210, 110, 60)   <- alpha 60 had no effect
dest (10,10,10) after normal blit   : ( 55,  31, 19)
```

and probing a built sprite along +x:

```
r=30 inten=0.24 -> RGB constant (200,60,60) from centre to the rim, alpha 54 -> 2
```

**Therefore: every `_add_glow` in obstacles.py paints a FLAT, HARD-EDGED, FULL-BRIGHTNESS additive
disc of the given colour.** There is no gradient. `intensity` does not dim it.

This is not a description of a subtle artefact - it is the entire look of the hazard layer. A wall
is not a grey slab with a soft rim; it is a solid block of `theme.hazard` added over a ~38 px halo
of the same colour at full value. Ported with a soft radial texture, hazards would look washed out,
thin and unreadable against the background, and the gameplay telegraphs would lose most of their
punch.

**Contrast with render.py:** `render.glow_surface` bakes the falloff into RGB (see render.md S1.1),
which is why *its* glows are soft. The two systems are genuinely different and both must be ported
as-is. Power-up runes use render.py's soft glow for their halo (powerups.py:695-716); hazards use
this hard one.

### 1.2 What `intensity` actually controls: the disc RADIUS

`intensity` survives only through the `if a <= 0: continue` gate, which culls the outer rings whose
alpha truncates to 0. So a lower intensity draws a **smaller** disc, at the same full brightness.

Exact formula (all integer truncation is Python `int()`, i.e. toward zero;
`P.clamp8` returns `0 if v<0 else (255 if v>255 else int(v))`):

```
r     = int(clamp(radius, 2.0, 260.0))
steps = int(clamp(r * 0.6, 6, 20))
i_max = max{ i in 1..steps : int(255 * clamp(intensity,0,2) * (1 - i/steps) ** 1.9) >= 1 }
R_eff = int(r * i_max / steps)          (0 -> nothing is drawn at all)
```

Closed form for `i_max` (before integer flooring to a step):
`i_max = floor( steps * (1 - (1 / (255*intensity)) ** (1/1.9)) )`.

Rasterisation note: pygame's filled circle of radius `R` lights pixels out to `R-1` from the centre,
so the observed outer edge is `R_eff - 1`.

**Every radial-glow call site in obstacles.py, resolved:**

| Call site | radius arg | intensity | r | steps | i_max | R_eff | R_eff / radius |
|---|---|---|---|---|---|---|---|
| Spinner arm blob (`_glow_line`) | `thickness*1.5` = 16.5 | 0.24 | 16 | 9 | 7 | 12 | 0.727 |
| Spinner tip node | `thickness*2.2` = 24.2 | 0.60 | 24 | 14 | 13 | 22 | 0.909 |
| Spinner hub (trough) | `hub_radius*2.6` = 33.8 | 0.30 | 33 | 19 | 17 | 29 | 0.858 |
| Spinner hub (peak) | 33.8 | 0.44 | 33 | 19 | 17 | 29 | 0.858 |
| Pulsar body, safe, radius 30 | 57.0 | 0.34 | 57 | 20 | 18 | 51 | 0.895 |
| Pulsar body, live, radius 50 | 95.0 | 0.68 | 95 | 20 | 18 | 85 | 0.895 |
| Laser fire blob, width 9 | `w*2.4` = 21.6 | 0.42 | 21 | 12 | 10 | 17 | 0.787 |
| Laser charge blob, warn=1 | `width*1.2` = 10.8 | 0.18 | 10 | 6 | 5 | 8 | 0.741 |
| Laser charge blob, warn=0.5 | 10.8 | 0.09 | 10 | 6 | 4 | 6 | 0.556 |
| Laser emitter, warn=0 | `er*2.4` = 31.4 | 0.34 | 31 | 18 | 16 | 27 | 0.859 |
| Laser emitter, warn=1 | 31.4 | 0.74 | 31 | 18 | 16 | 27 | 0.859 |
| Portal halo, r=26, ready | `r*2.1` = 54.6 | 0.42 | 54 | 20 | 18 | 48 | 0.879 |
| Portal halo, on cooldown | 54.6 | 0.168 | 54 | 20 | 17 | 45 | 0.824 |
| Portal spark, ready | 7.0 | 0.50 | 7 | 6 | 5 | 5 | 0.714 |
| Portal spark, cooldown | 7.0 | 0.20 | 7 | 6 | 5 | 5 | 0.714 |

Read the last column: for most call sites the intensity animation moves `R_eff` by **zero pixels**
(hub 0.30 -> 0.44 and emitter 0.34 -> 0.74 both land on the same `i_max`). Two exceptions actually
animate: the laser charge blob (its size *is* the warning ramp) and the portal cooldown dim.

**Port recommendation (S1.8):** do not build a texture at all. Draw a hard-edged filled circle in a
`Graphics` with `blendMode = "add"`, alpha 1, radius `R_eff`. It is exact, cheaper, and it composites
identically because Pixi's premultiplied `"add"` with source alpha 1 is `src + dst`.

### 1.3 `_add_glow(surface, x, y, radius, color, intensity=1.0)` - obstacles.py:118-123

Blits the cached sprite centred on `(int(x - R), int(y - R))` where `R = sprite_width * 0.5 = r`
(the *unquantised-by-i_max* sprite radius). Truncation of the top-left corner introduces up to 1 px
of position bias toward the origin; keep floats in Pixi and allow tolerance (render.md Q3).

### 1.4 `_glow_line(surface, ax, ay, bx, by, color, radius, intensity=1.0, max_blobs=18)` - obstacles.py:126-140

```
length = hypot(bx-ax, by-ay)
n      = int(clamp(length / GLOW_STEP_PX(=9.0), 1, max_blobs)) + 1
for i in 0..n:  f = i/n;  _add_glow(a + (b-a)*f, radius, color, intensity)
```

So **n+1 blobs**, inclusive of both endpoints, evenly spaced by `length/n`.

Because the blobs are flat additive discs, **they accumulate**. Verified on a live spinner arm
(theme "Neon Grid", `hazard = (255,66,110)`, background `(8,8,16)`):

```
perpendicular offset 10 px from the arm axis, mid-arm -> (140, 36, 236)
                                = 8 + 66 + 66  and  16 + 110 + 110   -> exactly two overlapping discs
perpendicular offset 12 px                              -> (8,8,16)  -> background: band half-width 12 = R_eff
```

The visual is a **saturating additive band** of half-width `R_eff`, brightest along the axis (where
the most discs overlap) and, because spacing (9 px) and radius (12 px) are close, faintly *beaded*
along its length. That beading is part of the look. Reproduce it by stamping the same discs at the
same spacing, not by drawing one smooth capsule.

Concrete blob counts for shipped content:

| Use | length | max_blobs | n | blobs | spacing |
|---|---|---|---|---|---|
| Spinner arm, `length=82` | 82 | 12 | 10 | 11 | 8.2 px |
| Spinner arm, `length=62` | 62 | 12 | 7 | 8 | 8.86 px |
| Laser beam, `0.4 * ARENA_H = 251` | 251 | 26 | 27 | 28 | 9.30 px |

### 1.5 `_slab_glow_sprite` / `_slab_glow` - obstacles.py:143-197

The rectangular equivalent, same alpha-ramp-that-does-nothing structure, therefore also a **flat
additive shape** - specifically a **stadium** (fully rounded rect), because the border radius is
`int(min(rect.w, rect.h) * 0.5)`.

```
iw, ih  = max(2, int(w)), max(2, int(h))
radius  = int(clamp(min(iw, ih) * 0.75 + 12.0, 14.0, 64.0))     # falloff distance from the SHORT side
steps   = int(clamp(radius * 0.6, 6, 18))
for i in steps..1:
    f = i/steps
    a = clamp8(255 * inten * (1-f) ** 1.9);  if a <= 0: continue
    pad  = radius * f
    rect = Rect(int(radius-pad), int(radius-pad), int(iw + pad*2), int(ih + pad*2))
    draw.rect(surf, (col, a), rect, border_radius=int(min(rect.w, rect.h) * 0.5))
sprite size = (iw + radius*2, ih + radius*2), blitted at (int(x) - radius, int(y) - radius), ADD
```

The docstring explains the design intent, and it is worth honouring in the port: a single radial glow
sized from a slab's *longest* side is catastrophic for a 27 x 217 px wall (it becomes a 240 px disc
that swallows the arena); driving the falloff from the *short* side makes a long wall glow like a
strip light.

`pad_eff` (how far the flat halo extends past the slab on every side) at the real call sites:

| Call site | slab | intensity | radius | steps | pad_eff |
|---|---|---|---|---|---|
| WallBlock 60x40, trough | 60x40 | 0.20 | 42 | 18 | 35 |
| WallBlock 60x40, peak | 60x40 | 0.36 | 42 | 18 | 38 |
| WallBlock 27x217 (shipped `w:0.022,h:0.345`) | 27x217 | 0.20 | 32 | 18 | 26 |
| WallBlock 27x217, peak | 27x217 | 0.36 | 32 | 18 | 29 |
| MovingBar smear i=3 | 120x20 | 0.0333 | 27 | 16 | 17 |
| MovingBar smear i=2 | 120x20 | 0.05 | 27 | 16 | 19 |
| MovingBar smear i=1 | 120x20 | 0.10 | 27 | 16 | 22 |
| MovingBar body halo | 120x20 | 0.22 | 27 | 16 | 24 |

Verified end-to-end on a live 60x40 WallBlock at `t=0` over background `(8,8,16)`:
pixels 0..30 px right of the wall's right edge read `(255, 74, 126)` = `(8,8,16) + (255,66,110)`
clamped - one full-strength add of `theme.hazard` - and 40 px out reads background.

### 1.6 `_neon_line(surface, ax, ay, bx, by, color, width, *, core=0.7)` - obstacles.py:200-211

Three **opaque, normal-blend** strokes on integer-truncated endpoints:

1. `shade(color, 0.55)` at width `w + 3`
2. `color` at width `w`
3. if `w >= 3`: `lerp_color(color, WHITE, core)` at width `max(1, w // 3)`

where `w = max(1, int(width))`. Because these overwrite, a neon line **erases** any additive glow
already under it. Order therefore matters (S5, S7).

`pygame.draw.line` with a width draws a butt-ended quad - no caps, no joins. `pygame.draw.lines`
draws each segment as an independent quad, so polylines have notched corners. Reproduce with
`stroke({ width, cap: "butt", join: "miter" })` on a `Graphics`; for exactness on sharp chevrons,
emit each segment as its own `moveTo/lineTo` pair.

### 1.7 `_hazard_slab(w, h, base, edge, hatched=True)` - obstacles.py:214-237

The **only** pre-baked raster in obstacles.py. Built once per obstacle per theme
(`WallBlock._slab_for`, obstacles.py:349-354, cached on `theme.name`; MovingBar inlines the same
check at obstacles.py:440-443).

```
w, h = max(2,int(w)), max(2,int(h));  surface = SRCALPHA(w, h)
top = shade(base, 0.42);  bot = shade(base, 0.16)
for yy in 0..h-1:                                       # 1px-row vertical gradient
    c = lerp_color(top, bot, yy / max(1, h-1))
    draw.line(surf, with_alpha(c, 238), (0, yy), (w, yy))
if hatched:                                             # 45-degree warning stripes
    hatch = with_alpha(shade(base, 0.85), 42)
    for k in range(-h, w + h, 14):
        draw.line(surf, hatch, (k, 0), (k + h, h), 3)
draw.rect(surf, with_alpha(shade(edge, 1.15), 235), Rect(0, 0, w, h), 2)          # outer keyline
draw.rect(surf, with_alpha(shade(edge, 0.45), 160), Rect(2, 2, w-4, h-4), 1)      # inner keyline
```

**Faithful quirk - the hatch is a hole, not a highlight.** `pygame.draw` overwrites RGBA, so the
hatch stripes *replace* alpha-238 body pixels with alpha-42 pixels. On screen (the slab is blitted
with a normal alpha blit) a stripe therefore reads as a **more transparent, darker** diagonal band -
you see the background through it. Painting the hatch with `source-over` at 16% alpha in Canvas 2D
would *lighten* the slab instead and is wrong.

Measured alpha histogram for a 60x40 slab: 1440 px at 238 (body), 396 px at 42 (hatch),
384 px at 235 (outer keyline), 180 px at 160 (inner keyline).

Stripe geometry: lines run from `(k, 0)` to `(k + h, h)` - exactly 45 degrees down-right - with a
horizontal step of 14 px, so the perpendicular spacing is `14 / sqrt(2) = 9.90 px` and the stroke is
3 px wide (perpendicular thickness `3 / sqrt(2) = 2.12 px`). The loop starts at `k = -h` so stripes
cover the whole slab including the bottom-left corner.

**Pixi:** generate per (w, h, base, edge) into a `Texture` **via `ImageData` pixel writes**, not via
Canvas 2D compositing - Canvas has no "overwrite RGBA" mode for arbitrary shapes, and the hatch's
alpha-replacement semantics are load-bearing. A 60x40 slab is 2400 px; a 27x217 wall is 5859 px;
levels have <= ~10 walls. Cost is negligible and it happens once per level. Cache key
`${w}x${h}:${baseHex}:${edgeHex}`; drop the cache on theme change.

### 1.8 Pixi mapping of the obstacles primitive layer

| Python | Pixi v8 |
|---|---|
| `_add_glow(x, y, radius, col, inten)` | `g.circle(x, y, R_eff(radius, inten)).fill({ color: toHex(col), alpha: 1 })` on a `Graphics` whose `blendMode = "add"` |
| `_glow_line(a, b, col, radius, inten, maxBlobs)` | loop `n+1` times, one `g.circle(...)` per blob, same `Graphics` |
| `_slab_glow(x, y, w, h, col, inten)` | `g.roundRect(x - pad, y - pad, w + 2*pad, h + 2*pad, min(w + 2*pad, h + 2*pad) * 0.5).fill({ color, alpha: 1 })`, add-blend |
| `_neon_line(...)` | three `moveTo/lineTo` + `stroke({ width, cap: "butt" })` on a normal-blend `Graphics`, in order |
| `_hazard_slab(...)` | `Texture` from `ImageData` (see S1.7) -> `Sprite`, normal blend |
| `_GLOW_CACHE` / `_SLAB_GLOW_CACHE` (512 entries, **full clear** on overflow, not FIFO) | not needed - nothing is cached because nothing is a texture |

Overlapping fills **inside one additive `Graphics` do accumulate**: WebGL blends each fragment
against the framebuffer in primitive order within a draw call. That is exactly what pygame's
repeated ADD blits do, so `_glow_line`'s beading and saturation come out for free. Do not merge the
blobs into a single stroked capsule - that would flatten the accumulation.

### 1.9 pygame drawing semantics cheat-sheet (used by every section below)

| pygame call | Meaning | Pixi v8 |
|---|---|---|
| `draw.rect(s, c, r, width=k)` | outline stroked **inward** from the rect bounds | `roundRect/rect(...).stroke({ width: k, alignment: 1 })` |
| `draw.circle(s, c, p, r)` | filled disc, lights pixels to `r-1` | `circle(...).fill()` |
| `draw.circle(s, c, p, r, w)` | ring stroked **inward** from `r` | `circle(...).stroke({ width: w, alignment: 1 })` |
| `draw.line(s, c, a, b, w)` | butt-ended quad, no caps | `moveTo/lineTo.stroke({ width: w, cap: "butt" })` |
| `draw.lines(s, c, closed, pts, w)` | independent quads per segment, notched joins | one `moveTo/lineTo` pair per segment |
| `draw.polygon(s, c, pts)` | filled | `poly(pts).fill()` |
| `draw.polygon(s, c, pts, w)` | outline, notched joins | `poly(pts, true).stroke({ width: w })` (accept mitred joins, or emit segments) |
| `draw.arc(s, c, box, a0, a1, w)` | **mathematical convention, y-up: increasing angle sweeps counter-clockwise on screen** | `arc(cx, cy, r, -a1, -a0)` i.e. **negate both angles** |
| any `draw.*` with an RGBA colour on SRCALPHA | writes RGBA directly, **no blending** | see S1.7 note |
| `blit(spr, pos, BLEND_RGB_ADD)` | `dst.rgb += src.rgb`, **source alpha ignored** | `blendMode = "add"` with source alpha 1 |

---

## 2. WallBlock - obstacles.py:326-371

Static rectangle at `(x, y, w, h)`, `w, h >= 2`. No `_update`; all animation is a function of the
draw-time clock and the wall's own `x`.

### 2.1 The breathing scalar

```
glow = 0.35 + 0.35 * pulse(t + self.x * 0.013, 1.7)          # 0.35 .. 0.70
```

`pulse(a, s) = 0.5 + 0.5*sin(a*s)`, so the argument is `(t + x*0.013) * 1.7`:

- temporal frequency `1.7 rad/s` -> period **3.696 s**
- **spatial phase gradient** `0.013 * 1.7 = 0.0221 rad/px` -> a full cycle every **284 px** of x.
  A row of walls therefore shimmers as a travelling wave left-to-right. This is deliberate and very
  visible on the levels with wall grids; do not drop the `x` term.

### 2.2 Layer order (back to front)

1. **Slab sprite** - `blit(_hazard_slab(int(w), int(h), theme.hazard, theme.hazard), (int(x), int(y)))`,
   normal alpha blit. Note `base == edge == theme.hazard` for walls.
2. **Breathing edge highlight** - `draw.rect(surface, edge_col, bounds(), 2)` where
   `edge_col = lerp_color(theme.hazard, WHITE, glow * 0.45)` (so it whitens between 15.75% and
   31.5%). Stroked inward, 2 px, on the integer `bounds()` rect.
3. **Corner brackets** - `c = int(clamp(min(w, h) * 0.28, 5.0, 18.0))`. At each of the four corners
   `(x0,y0,+1,+1), (x1,y0,-1,+1), (x0,y1,+1,-1), (x1,y1,-1,-1)` with
   `x1 = int(x + w), y1 = int(y + h)`: two 2 px lines in **`theme.accent2`**, one horizontal of
   length `c` and one vertical of length `c`, both pointing inward. Static (no animation).
4. **Slab halo** - `_slab_glow(x, y, w, h, theme.hazard, 0.20 + glow * 0.16)`, i.e. intensity
   **0.256 .. 0.312** in practice (glow is 0.35..0.70). Flat additive stadium, `pad_eff` per S1.5.
   Because it is drawn **last**, it washes over the slab, the edge highlight and the brackets: a wall
   interior measured at `(255, 83, 140)` on the "Neon Grid" theme is
   `gradient(72,18,31) blended at alpha 238 over bg -> (67,17,30)` **plus** `theme.hazard` added.

Colours by theme key: `theme.hazard` (slab base, edge lerp target, halo), `theme.accent2` (brackets).
Nothing else. No hex literals except `WHITE = (255,255,255)`.

### 2.3 Cached vs per-frame

| Cached | Per frame |
|---|---|
| the slab sprite (per instance, keyed on `theme.name`) | edge rect, 8 bracket lines, slab halo |
| the slab-glow sprite (module cache, keyed on `(w, h, radius, colour, int(inten*8))`) | - |

Note the slab-glow cache key quantises intensity to eighths: `int(clamp(inten,0,2)*8)`. With
intensity swinging 0.256..0.312 that is bucket 2 the whole time, so the wall's halo is in practice
**one cached sprite** and never changes size. Do not implement an animated halo radius here.

### 2.4 Pixi

`Container { slabSprite (normal), liveGraphics (normal, rebuilt per frame: edge rect + 8 bracket
lines), haloGraphics (add, built once) }`. Only `liveGraphics` needs a per-frame `clear()` + redraw,
and only its edge colour changes - if this ever matters, tint a static edge `Graphics` instead.

---

## 3. MovingBar (the sweeper) - obstacles.py:377-483

### 3.1 Motion (needed by the renderer for the chevrons and smear)

```
u   = (t * speed + phase) % 1.0             # speed = full out-and-back cycles / second
tri = u * 2.0 if u < 0.5 else 2.0 - 2.0*u   # triangle 0 -> 1 -> 0
off = travel * ease_in_out_cubic(tri)
dir = +1.0 if u < 0.5 else -1.0             # outbound / returning
(x, y) = (x0 + off, y0)  if axis == "x"  else  (x0, y0 + off)
```

`ease_in_out_cubic(t) = 4t^3` for `t < 0.5`, else `0.5*(2t-2)^3 + 1` (contracts.py:199-204). The bar
decelerates into both ends, which is the whole readability argument: it hangs at the extremes long
enough to be dodged.

Shipped bars: `speed` 0.14..0.18 cycles/s -> a full out-and-back takes **5.6..7.1 s**;
`travel` 0.58..0.62 of `ARENA_W` = 726..776 px; `w` 0.22..0.24 of `ARENA_W` = 275..300 px;
`h = 0.034 * ARENA_H = 21 px`.

`span()` is the whole swept corridor:
`Rect(min(x0, x0+tx), min(y0, y0+ty), w + |tx|, h + |ty|)` with `tx = travel` on the x axis (0 on y),
integer-truncated. `centerx/centery` are pygame's **integer floor** midpoints
(`r.x + r.w // 2`), which the TS port already mirrors (`centerX/centerY` in obstacles.ts:121-128).

### 3.2 Layer order (back to front)

1. **Rail** - a dim line down the middle of `span()` showing the whole sweep, so the motion is
   predictable before the bar gets there. Colour `shade(theme.grid, 1.25)`, width 2.
   - axis x: `(span.left, span.centery) -> (span.right, span.centery)`
   - axis y: `(span.centerx, span.top) -> (span.centerx, span.bottom)`
2. **Motion smear** - three fading ghosts *behind* the bar. `back = -dir`. For `i in (3, 2, 1)`:
   offset the slab by `back * i * 7.0` along the axis and call
   `_slab_glow(gx, gy, w, h, theme.accent2, 0.10 / i)`. Intensities 0.0333, 0.05, 0.10 ->
   `pad_eff` 17, 19, 22 for a 120x20 bar (S1.5). Because these are flat adds, the smear reads as
   **three nested stadium halos in accent2** stepping back 7, 14, 21 px, each larger than the last.
   Drawn far-to-near, so the largest (weakest-intensity) one is furthest back **and** furthest out.
3. **Slab sprite** - `_hazard_slab(int(w), int(h), theme.hazard, theme.accent2)` blitted at
   `(int(x), int(y))`. Note: base `hazard`, **edge `accent2`** (unlike WallBlock).
4. **Border** - `draw.rect(surface, lerp_color(theme.accent2, WHITE, 0.25 + 0.3*pulse(t, 3.1)),
   bounds(), 2)`. Whitening swings 25%..55% at 3.1 rad/s (period 2.027 s).
5. **Direction chevrons** - two, pointing the way the bar is currently travelling.
   `cx, cy = x + w*0.5, y + h*0.5`; `k = clamp(min(w, h) * 0.30, 4.0, 10.0)`
   (shipped bars: `min(w,h) = 21` -> `k = 6.3`); colour `shade(theme.accent2, 1.2)`, width 2.
   - axis x, for `i in (-1, 1)`: `ox = cx + i*k*1.6`, `tipx = ox + dir*k`, polyline
     `[(ox, cy-k), (tipx, cy), (ox, cy+k)]` (open).
   - axis y, for `i in (-1, 1)`: `oy = cy + i*k*1.6`, `tipy = oy + dir*k`, polyline
     `[(cx-k, oy), (cx, tipy), (cx+k, oy)]` (open).

   The chevrons **flip instantly** when `dir` flips at `u = 0.5`, i.e. at the far end of the run,
   exactly when the eased motion is momentarily stationary. That is the readability moment.
6. **Body halo** - `_slab_glow(x, y, w, h, theme.hazard, 0.22)`, drawn last, washing everything.
   Constant intensity -> one cached sprite for the level.

Colours by theme key: `theme.grid` (rail, x1.25), `theme.accent2` (smear, slab edge, border lerp
base, chevrons x1.2), `theme.hazard` (slab base, body halo).

### 3.3 Cached vs per-frame

Cached: the slab sprite (per instance, on `theme.name`); the four slab-glow sprites (module cache -
three smear intensities + the body one; the smear is symmetric so the same three serve both
directions). Per frame: rail, border rect, chevrons, and the *positions* of everything.

### 3.4 Pixi

`Container { railGraphics (normal, static per level), smearGraphics (add, 3 stadiums, position
updated per frame), slabSprite (normal, position per frame), borderGraphics (normal, per frame),
chevronGraphics (normal, rebuilt only when `dir` flips), haloGraphics (add, position per frame) }`.
Everything except the border colour and the chevron direction is a pure translation - update
`.x/.y`, do not rebuild geometry.

---

## 4. Spinner - obstacles.py:489-570

`angle = phase + t * speed` (radians; shipped speeds -1.35 .. +1.45 rad/s, so both senses occur).
Arm tips: `tip_i = (cx + cos(angle + i*TAU/arms) * length, cy + sin(...) * length)` for
`i in 0..arms-1`. Shipped: `arms` 2 or 3, `length` 62..88, `thickness` 11..12, `hub_radius` 13.

### 4.1 Layer order (exactly as coded - two separate loops)

```
for each tip:  _glow_line(cx, cy, tx, ty, theme.hazard, thickness*1.5, 0.24, max_blobs=12)
for each tip:
    _neon_line(cx, cy, tx, ty, theme.hazard, thickness, core=0.55)
    _add_glow(tx, ty, thickness*2.2, theme.accent2, 0.6)
    draw.circle(surface, lerp_color(theme.hazard, WHITE, 0.4), (int(tx), int(ty)), int(thickness*0.72))
hub:
    draw.circle(surface, shade(theme.hazard, 0.4), (icx, icy), int(hub_radius))          # filled
    draw.circle(surface, theme.accent,            (icx, icy), int(hub_radius), 2)        # ring, inward
    draw.polygon(surface, theme.accent2, inner_triangle)                                  # filled
    _add_glow(cx, cy, hub_radius*2.6, theme.accent, 0.30 + 0.14*pulse(t, 4.0))
```

Note the ordering consequence: **all** arm auras are laid down first, then arm `j`'s opaque neon line
overwrites arm `i<j`'s aura where they cross, and the hub disc overwrites all arm roots.

### 4.2 Geometry details

- **Arm aura**: flat additive band in `theme.hazard`, half-width `R_eff = 12` for `thickness = 11`
  (`R_eff = 13` for `thickness = 12`). 8-11 blobs per arm at ~8.2-8.9 px spacing (S1.4).
- **Arm body**: `_neon_line` with `w = int(thickness) = 11`, so three strokes at widths
  14 / 11 / 3 in `shade(hazard, 0.55)` / `hazard` / `lerp(hazard, WHITE, 0.55)`.
- **Tip node glow**: `theme.accent2`, `R_eff = 22` for `thickness = 11`. This is called out in the
  source as "the part that actually catches players out" - it is the readability marker for the
  lethal tip, and it is a *different hue* (accent2) from the arm (hazard) on purpose.
- **Tip disc**: filled, radius `int(thickness*0.72) = 7`, colour `lerp_color(theme.hazard, WHITE, 0.4)`.
- **Hub**: filled disc `shade(theme.hazard, 0.4)` radius `int(hub_radius) = 13`; ring `theme.accent`
  width 2 stroked inward from 13.
- **Counter-rotating inner triangle** - this is the spin-direction tell:
  `a_k = -angle * 1.7 + k * TAU/3`, vertices at radius `hub_radius * 0.55 = 7.15`, filled
  `theme.accent2`. It rotates **backwards at 1.7x** the arm speed, so at `speed = 1.45` the triangle
  spins at `-2.465 rad/s` - fast, opposite, unmistakable.
- **Hub glow**: `theme.accent`, `R_eff = 29` for `hub_radius = 13`, intensity
  `0.30 + 0.14*pulse(t, 4.0)` (period 1.571 s) - which, per the S1.2 table, does **not** change
  `R_eff`. The pulse is therefore invisible in the shipped configuration. Port it anyway (it becomes
  visible if `hub_radius` changes), but do not "fix" it into an alpha pulse.

Collision, for reference when checking readability: lethal is the hub disc (`hub_radius + r`) **or**
any point within `thickness*0.5 + r` of an arm segment. The tip glow (22 px) is nearly 4x the lethal
arm half-width (5.5 px) - the glow is generous, the hitbox is not.

### 4.3 Cached vs per-frame

Cached: the radial glow sprites (arm blob, tip node, hub) - three sprites per theme, all reused every
frame. Per frame: everything geometric.

### 4.4 Pixi and a safe reordering

Faithful child order needs glows interleaved between opaque strokes. A 3-child approximation is safe
here:

```
armGlow      Graphics(add)     arm blob chains + tip node glows
solid        Graphics(normal)  neon lines, tip discs, hub disc, hub ring, inner triangle
hubGlow      Graphics(add)     hub glow
```

This hoists all tip glows above all neon lines (Python interleaves them per arm). It is
**visually identical iff** no arm's neon line passes within a tip glow of another arm's tip, i.e.

```
tipGlowR_eff  <  2 * length * sin(pi / arms)          (the tip-to-tip chord)
```

For the shipped content: `arms=2` -> chord 164, `arms=3` -> chord 142-152, glow 22-24. Comfortably
satisfied. Assert it in dev builds; if a future level violates it, fall back to per-arm containers.

---

## 5. Pulsar - obstacles.py:576-671

The breathing bomb. **Deadly only while inflated past a threshold**, so its telegraph is
gameplay-critical.

### 5.1 State

```
u      = (t / period + phase) % 1.0
s      = 0.5 - 0.5 * cos(u * TAU)                       # 0 -> 1 -> 0, no corner at the peak
radius = lerp(min_radius, max_radius, s)
charge = clamp(s / deadly_frac, 0.0, 1.0)               # hits exactly 1.0 as it arms
deadly = armed and radius >= threshold
threshold = lerp(min_radius, max_radius, deadly_frac)
```

Shipped: `min_radius 13`, `max_radius 53`, `period 2.3..2.66 s`, `deadly_frac 0.55`,
so `threshold = 13 + 40*0.55 = 35 px`.

**Timing of the danger window.** With `u(s) = acos(1 - 2s) / TAU`:

| Event | condition | u | fraction of period | seconds at period 2.6 |
|---|---|---|---|---|
| shockwave telegraph starts | `charge > 0.55` -> `s > 0.3025` | 0.1853 | - | - |
| **arms (lethal)** | `s >= 0.55` | 0.2660 | - | - |
| telegraph duration | | 0.0807 | 8.07% | **0.210 s** |
| lethal window | `u in [0.266, 0.734]` | 0.4680 | 46.8% | **1.217 s** |
| outbound shockwave | mirror, `u in [0.734, 0.8147]` | 0.0807 | 8.07% | 0.210 s |

So the fair-warning window is ~0.21 s and the shockwave must travel its full distance in exactly
that time. Getting this ring's timing wrong makes the level unfair; it is the tightest telegraph in
the game.

`live = self.deadly`. Because `deadly <=> charge == 1.0` (when armed), the branch
`if not live and self.charge > 0.55` fires on **both** the inflate and the deflate: inbound
(shrinking ring) before arming, outbound (growing ring) after disarming. A *disarmed* pulsar
(`armed = False`) shows the ring pinned at `warn = 1.0` -> `wr = threshold` throughout its lethal-
equivalent window, and never turns red.

### 5.2 Colour

```
col  = lerp_color(theme.accent, theme.hazard, charge)     # safe -> deadly, continuous
ring = theme.hazard if live else shade(theme.hazard, 0.7)
core = lerp_color(col, WHITE, 0.55 if live else 0.25)
```

The body colour is a *continuous* accent->hazard blend driven by `charge`; the threshold ring is a
*binary* full-hazard vs 70%-hazard flip at the arming instant. Both signals matter.

### 5.3 Layer order (back to front)

1. **Threshold ring** (always visible, drawn first so the body can cover it when inflated past it).
   A dashed circle at radius `threshold`. 22 slots, only even `i` drawn -> **11 dashes**.
   Each dash is a straight **chord** (not an arc): from `angle a0 = i*TAU/22 + t*0.5` to
   `a1 = a0 + (TAU/22)*0.9`, width 2, colour `ring`. Chord length `2*th*sin(0.9*TAU/44) = 0.2564*th`
   = 8.97 px at `th = 35`. The dash train **rotates at 0.5 rad/s**.
2. **Charging shockwave** (only when `not live and charge > 0.55`):
   `warn = (charge - 0.55)/0.45`; `wr = lerp(threshold*1.9, threshold, warn)`;
   `draw.circle(surface, lerp_color(theme.accent, theme.hazard, warn), (icx, icy), int(max(2, wr)), 2)`.
   A 2 px ring that closes from `1.9 * threshold` (66.5 px) onto `threshold` (35 px) and lands
   **exactly** at the arming instant, reddening as it goes.
3. **Body halo** - `_add_glow(cx, cy, radius*1.9, col, 0.34 + (0.34 if live else 0.0))`. Flat
   additive disc, `R_eff = 0.895 * 1.9 * radius = 1.70 * radius`. The intensity doubling when live
   moves `R_eff` by **0 px** (S1.2 table) - the visible arming cue is the *colour* (`col` has reached
   full `theme.hazard`) plus items 6-7, not the halo size.
4. **Body disc** - filled `shade(col, 0.45)`, radius `int(radius)`. Opaque; it **overwrites** the
   centre of the halo, so what remains visible of the halo is an annulus from `radius` to
   `1.70*radius`.
5. **Body ring** - `col`, radius `int(radius)`, width 3, stroked inward.
6. **Core** - filled `core`, radius `int(max(2.0, radius * (0.30 + 0.12*pulse(t, 7.0))))`. Fast
   heartbeat: 7 rad/s = 1.114 Hz, radius fraction swinging 0.30..0.42.
7. **Angry spikes** (only when `live`): 8 spikes at `a = t*2.2 + i*TAU/8`, each a 2 px line from
   `radius*0.92` to `radius*1.28`, colour `theme.hazard`, rotating at 2.2 rad/s. These appear and
   disappear **instantly** with `deadly` - the crispest of the three arming signals.

Colours by theme key: `theme.accent` (safe end of the charge lerp, shockwave start), `theme.hazard`
(deadly end, threshold ring, spikes).

### 5.4 Cached vs per-frame

Cached: one radial glow sprite per `(int(radius*1.9), col, int(inten*8))` bucket. Because `radius`
sweeps continuously and `col` sweeps continuously, this is the **worst cache citizen in the game**:
it churns new sprites constantly (colour is bucketed only to whole channel values here, not to
4 bits like render.py). `GLOW_CACHE_LIMIT = 512` and overflow does a **full `.clear()`**. In Pixi
this all vanishes - a `Graphics` circle costs nothing.

Per frame: everything.

### 5.5 Pixi

```
telegraphGraphics  normal  dashes (11 chords) + shockwave ring
bodyGlow           add     one circle
bodyGraphics       normal  disc, ring, core, spikes
```

Rebuild both `Graphics` per frame (radius changes continuously). ~25 primitives per pulsar; levels
have up to ~6 pulsars, so ~150 primitives - fine in one or two batched Graphics.

---

## 6. LaserGate - obstacles.py:677-776

### 6.1 State and the timing contract

```
cycle      = (t + phase * period) % period          # NOTE: phase is in PERIODS, not seconds
charge_len = period - fire_time
firing     = cycle >= charge_len
warn       = 1.0                                             if firing
           = clamp((cycle - (charge_len - warn_time)) / warn_time, 0, 1)   if warn_time > 0
           = 0.0                                             otherwise
deadly     = armed and firing
```

Shipped: `period 2.8..3.2`, `fire_time 0.85..0.95`, `warn_time 0.75..0.85`, `width 9`,
`phase` 0 / 0.25 / 0.5 / 0.75. Beams are axis-aligned and 0.4 of `ARENA_H` long (251 px).

For `period=3.2, fire=0.95, warn=0.85`: `charge_len = 2.25`; the targeting ray is idle for
`cycle in [0, 1.40)`, ramps `warn` 0->1 over `[1.40, 2.25)`, and the beam is out over `[2.25, 3.2)`.
**The full warning is 0.85 s and the shot lasts 0.95 s** - much more generous than the pulsar, which
is right because a laser spans the arena.

### 6.2 Charging state (`not firing`) - the targeting ray

```
col   = lerp_color(shade(theme.accent, 0.8), theme.hazard, warn)
width = 1 + int(warn * 2.0)                              # 1, 2, or 3 (3 only at warn == 1.0)
n     = 26
for i in 0..25:
    if (i + int(t * 12.0)) % 2:  continue                # parity flips 12x/second
    f0, f1 = i/26, (i + 0.72)/26
    draw.line(surface, col, lerp(P1, P2, f0), lerp(P1, P2, f1), width)
if warn > 0.01:
    _glow_line(P1, P2, theme.hazard, width_attr*1.2, 0.18 * warn, max_blobs=16)
```

Three simultaneous cues, all reading "this is about to fire":

- **colour** slides from `shade(accent, 0.8)` (a cold, dimmed primary neon) to full `theme.hazard`;
- **thickness** steps 1 -> 2 at `warn = 0.5` and 2 -> 3 only when the shot lands;
- **dash strobe**: the drawn parity alternates 12 times per second, so the dash train appears to
  jump one slot back and forth at 12 Hz - a nervous flicker, not a march. Each dash covers 72% of a
  1/26 slot; with the parity gate, 13 dashes are on at any instant.
- **aura**: only once `warn > 0.01`, a `_glow_line` in `theme.hazard`. Its `R_eff` grows with warn
  (S1.2: 6 px at warn 0.5, 8 px at warn 1.0) - one of the two places in the whole hazard layer where
  the intensity animation is actually visible. 17 blobs across a 251 px beam.

### 6.3 Firing state

```
flick = 0.86 + 0.14 * sin(t * 57.0)                      # ~9.07 Hz, 86%..100%
w     = width * flick                                    # 7.74 .. 9.0 for width 9
_glow_line(P1, P2, theme.hazard, w * 2.4, 0.42, max_blobs=26)
_neon_line(P1, P2, theme.hazard, w, core=0.85)
draw.line(surface, WHITE, iP1, iP2, max(1, int(w * 0.25)))    # 2 px hot core
```

- The aura is a flat additive band in `theme.hazard`, `R_eff` 16-17 px, 28 blobs at 9.3 px spacing -
  so it beads slightly along the beam. Half-width ~17 px versus the lethal half-width of 4.5 px.
- `_neon_line` gives three opaque strokes at `int(w)+3` / `int(w)` / `int(w)//3` in
  `shade(hazard,0.55)` / `hazard` / `lerp(hazard, WHITE, 0.85)`.
- **Faithful quirk:** `flick` modulates only the *drawn* width. `_collides` always uses the full
  `self.width * 0.5`, so at the flicker trough the beam looks 14% narrower than it kills. Do not
  "fix" this by driving collision from the drawn width.

### 6.4 Emitters (both states, drawn last so they cap the beam)

```
er = width * 0.9 + 5.0                                   # 13.1 for width 9
for (ex, ey) in ((x1,y1), (x2,y2)):
    _add_glow(ex, ey, er*2.4, theme.hazard if firing else theme.accent, 0.34 + 0.4*warn)
    draw.circle(surface, shade(theme.hazard, 0.35), (iex, iey), int(er))            # dark housing
    draw.circle(surface, theme.accent if not firing else theme.hazard, (iex,iey), int(er), 2)
    draw.circle(surface, lerp_color(theme.accent, WHITE, warn), (iex, iey),
                int(max(1.0, er * (0.25 + 0.45*warn))))                              # the IRIS
```

The **iris** is the clearest countdown in the game: a filled disc that opens from `0.25*er` (3 px) to
`0.70*er` (9 px) as `warn` runs 0->1, whitening from `theme.accent` to pure white as it goes. It
snaps back closed the instant the cycle restarts. The halo colour also flips accent -> hazard on
the shot.

Colours by theme key: `theme.accent` (cold/charging), `theme.hazard` (hot/firing, aura, housing at
35%). Both emitters and both states.

### 6.5 Cached vs per-frame / Pixi

Cached: the glow sprites (a handful of buckets - `int(w*2.4)` moves with the flicker, so the firing
aura churns ~4 buckets). Per frame: everything.

```
beamGlow      add      _glow_line blobs (charge aura or fire aura)
beamGraphics  normal   dashes (charging) OR neon strokes + white core (firing)
emitterGlow   add      two circles
emitterGfx    normal   housing / ring / iris x2
```

---

## 7. Portal - obstacles.py:782-892

The only non-deadly hazard, and the only one drawn **below** the others (S0.3).

### 7.1 State

```
spin     = t * 1.6                       # set in _update, radians
cooldown = max(0, cooldown - dt)         # the ONLY hazard that consumes dt
ready    = cooldown <= 0.0
dim      = 1.0 if ready else 0.4
base     = theme.accent2 if self.secondary else theme.accent
```

`PORTAL_COOLDOWN = 0.55 s` is applied to **both** ends on a jump. Shipped portals: `radius = 27`,
paired by an explicit `pair` key ("a"/"b"), 12 across the levels (6 pairs).

`secondary` is assigned by `_link_portals` as `bool(i % 2)` within each group, so the A end uses
`theme.accent` and the B end `theme.accent2`. That is the player's only cue for which end they will
come out of - it must not be dropped.

### 7.2 Layer order (back to front)

1. **Halo** - `_add_glow(x, y, radius*2.1, base, 0.42 * dim)`. Flat additive disc,
   `R_eff = 48` (ready) or `45` (cooldown) at `radius = 26`. This is one of the two places where the
   intensity animation is visible: a portal on cooldown has a **measurably smaller** halo. Combined
   with item 5's `shade(..., dim)` it reads as "asleep".
2. **Throat** - `draw.circle(surface, shade(theme.bg_bottom, 0.6), (ix, iy), int(radius*0.9))`,
   filled and opaque. It punches a dark hole through the halo so the gate reads as an opening rather
   than a disc. **`theme.bg_bottom` is the only use of that key outside the background renderer** -
   it makes the throat match the darkest part of the sky.
3. **Vortex arcs** - three, i = 0..2:
   ```
   f   = 0.95 - i*0.20              -> 0.95, 0.75, 0.55
   rr  = int(radius * f)
   box = Rect(ix-rr, iy-rr, 2rr, 2rr)
   a0  = spin * (1.0 + i*0.55) + i*1.1      -> angular rates 1.60, 2.48, 3.36 rad/s
   col = lerp_color(base, theme.food, i / 3.0)      -> mix 0.0, 0.333, 0.667
   draw.arc(surface, shade(col, dim), box, a0, a0 + TAU*0.62, max(2, int(radius*0.12)))
   ```
   Sweep is 223.2 degrees each; stroke width `max(2, int(radius*0.12))` = 3 at radius 27.
   **Faithful quirk:** the docstring says "counter-rotating", but all three `a0` terms are
   `+spin * positive`, so all three rotate the **same** way, differing only in rate (1.60 / 2.48 /
   3.36 rad/s). The differential rates are what sells the vortex. Port as-is.
   **Angle convention:** `pygame.draw.arc` is y-up, so these sweep **counter-clockwise on screen**.
   In Pixi, `g.arc(cx, cy, rr, -(a0 + TAU*0.62), -a0)`.
4. **Rim** - `draw.circle(surface, shade(base, 1.1 * dim), (ix, iy), int(radius), 3)`. Note the
   `1.1 * dim` compound factor: 1.1x brighter than `base` when ready, 0.44x when sleeping.
5. **Orbiting sparks** - six, `a = -spin*2.0 + i*TAU/6`, position
   `(x + cos(a)*radius*0.72, y + sin(a)*radius*0.72)`,
   `_add_glow(px, py, 7.0, theme.food, 0.5 * dim)` -> flat additive discs of `R_eff = 5` in
   `theme.food`. Because `a` *decreases* at 3.2 rad/s and these are direct `cos/sin` in y-down
   space, the sparks run **counter-clockwise on screen**, i.e. against the arcs. That contrast is the
   only genuine counter-rotation in the portal.
   Radius 7.0 is a **fixed pixel value**, not scaled by `radius`.
6. **Core** - `core = lerp_color(base, WHITE, 0.35 + 0.3*pulse(t, 3.4))`, filled disc
   `shade(core, dim)`, radius `int(max(2.0, radius*0.18))` = 4 at radius 27. Whitening breathes
   35%..65% at 3.4 rad/s (period 1.848 s - the same rate as the food orb breathe, deliberately).

Colours by theme key: `theme.accent` / `theme.accent2` (A vs B end), `theme.bg_bottom` (throat at
60%), `theme.food` (arc gradient target and the sparks). Note the portal is the only hazard that
touches `theme.food` - it makes the gate feel like a *collectible* rather than a threat.

### 7.3 Cached vs per-frame / Pixi

Cached: the halo sprite (2 buckets: ready / cooldown) and the spark sprite (2 buckets). Per frame:
everything else.

```
haloGlow    add     one circle
throat      normal  one filled circle          (static; only `dim` changes nothing here)
arcs        normal  three stroked arcs         (rebuilt per frame)
rim         normal  one stroked circle
sparkGlow   add     six circles                (rebuilt per frame)
core        normal  one filled circle
```

Portals go in their own container, ordered before the hazard container (S0.3).

---

## 8. Power-up runes - powerups.py:614-685

Six kinds, one draw path, kind-specific only in the glyph and the base colour.

### 8.1 The colours are deliberately theme-INDEPENDENT

`POWERUP_TYPES` (powerups.py:50-93) hard-codes one fixed hue per kind, and the module comment says
why: a player must read a power-up at a glance on **every one of the twelve palettes**, so each kind
owns a fixed, well-separated hue.

| kind | colour | icon | duration |
|---|---|---|---|
| magnet | `(255, 92, 96)` crimson | `M` | 8.0 s |
| shield | `(86, 220, 255)` cyan | `S` | 12.0 s |
| slow | `(144, 124, 255)` indigo | `T` | 6.5 s |
| double | `(255, 208, 84)` gold | `2x` | 10.0 s |
| ghost | `(214, 228, 255)` pale | `G` | 6.0 s |
| frenzy | `(255, 74, 190)` magenta | `F` | 8.0 s |

These are the **only** literal colours in this document that must be copied verbatim - they are data,
not theme. In TS they already exist as `POWERUP_TYPES[kind].color` (`web/src/core/powerups.ts:74`).
The single theme colour used is `theme.accent`, and only as a 28% bleed into the ring:

```
ring_col = lerp_color(powerup_color(kind), theme.accent, 0.28)
```

### 8.2 Lifetime, brightness, radius

```
ttl        = max(1.0, C.POWERUP_LIFETIME) = 11.0 s
BLINK_LEAD = 2.4 s
POP_IN_TIME= 0.42 s
radius     = C.POWERUP_RADIUS = 13.0
```

**brightness()** (powerups.py:361-375) - drives every layer's intensity:

```
left = remaining()                       # ttl - _age, floored at 0
if left >= 2.4: return 1.0
u     = clamp(left / 2.4, 0, 1)          # 1 -> 0 as it dies
freq  = lerp(22.0, 6.0, u)               # SLOWER frequency when there is more time left
blink = 0.5 + 0.5 * sin(_age * freq)
return clamp(0.30 + 0.70*u*u + 0.34*blink*(1 - u), 0, 1)
```

Two things to get right:

- The strobe rate is `d/dt [ _age * freq(_age) ] = freq + 6.667*_age` (because
  `dfreq/d_age = +16/2.4`). With `ttl = 11`: at the start of the blink (`_age = 8.6`) the
  instantaneous rate is `6 + 57.3 = 63.3 rad/s` = **10.1 Hz**, rising to
  `22 + 73.3 = 95.3 rad/s` = **15.2 Hz** at expiry. It is a fast strobe throughout, accelerating.
  A naive port that reads `freq` as the rate gets 1 Hz -> 3.5 Hz and looks completely different.
- Continuity: at `u = 1` the expression is `0.30 + 0.70 = 1.0`, matching the early-out exactly.
  The floor is `0.30` at `u = 0`, so `bright` is never below 0.30 and the
  `if bright <= 0.02: return` guard at powerups.py:616 is **dead code**. A rune never fully
  disappears; it just strobes between 0.30 and 0.64 in its last moment and then is removed.

**draw_radius()** (powerups.py:377-383):

```
r = 13.0
if _age < 0.42:  r *= clamp(ease_out_back(_age / 0.42), 0.0, 1.4)
r *= 0.94 + 0.06 * pulse(_age * 4.6 + _phase)          # CORE_PULSE_SPEED = 4.6
return max(2.0, r)
```

`ease_out_back` (contracts.py:207-211) with `c1 = 1.70158, c3 = 2.70158` peaks at
**1.10005 at t = 0.5801**, i.e. at `_age = 0.2436 s`, and settles to 1.0 at `_age = 0.42 s`. The
`clamp(..., 0, 1.4)` never bites. Breathe range 0.94..1.00, period `TAU/4.6 = 1.366 s`, phased per
item by `_phase in [0, TAU)`.

Note the breathe uses `_age`, **not** the shared clock, so two runes on screen breathe out of sync by
both `_phase` and their birth times. But the **spin** uses the shared clock (below), so they rotate
in lockstep. That mix is intentional ("so every rune turns in sync").

### 8.3 Layer stack (powerups.py:614-685)

Two compositing stages:

**Stage A - the halo, straight onto the target surface, using render.py's SOFT glow:**

```
breathe = 0.72 + 0.28 * pulse(_age * 4.6 * 0.6 + _phase)          # 0.72..1.00, period 2.277 s
render.draw_glow_circle(surface, x, y, r * 2.7, color, 0.55 * bright * breathe)
```

`_GLOW_SCALE = 2.7`. This is `gfx.render.draw_glow_circle` (resolved lazily at powerups.py:695-716),
i.e. the **soft, RGB-baked, properly-falling-off** primitive documented in render.md S1.1/S1.4 -
*not* the hard obstacles one. Intensity range `0.396 .. 0.55` for a healthy rune. In Pixi this is
`stampGlow(container, x, y, r*2.7, color, 0.55*bright*breathe)` from the shared `glow.ts`.

**Stage B - everything else onto one reused scratch surface, then ADD-blitted:**

```
box = int(r * _BOX_SCALE(=2.05) * 2.0) + 8              # 61 px at r = 13
buf = _scratch(box)                                     # cached per size, cleared to (0,0,0,0)
cx = cy = box * 0.5
tt   = t if t > 0 else _age                             # the field/scene clock
spin = tt * SPIN_SPEED(=0.85) * _spin + _phase          # _spin = +1 or -1, per item
```

All colours inside the scratch go through
`_add(col, f) = (clamp8(col.r*f), clamp8(col.g*f), clamp8(col.b*f), 255)` - i.e. the rune module
**does** premultiply brightness into RGB (the correct convention for `BLEND_RGB_ADD`, unlike
obstacles.py). Draw order inside the scratch:

1. **Two counter-rotating triangles** -> a slowly shearing hexagram.
   `tri_r = r * 1.46`; `lw = max(1, int(r * 0.13))` = 1 at r = 13.
   For `sense in (+1, -1)`: `a0 = spin*sense + (0 if sense > 0 else pi/3)`;
   vertices at `a0 + k*TAU/3`, k = 0..2; `draw.polygon(buf, _add(ring_col, 0.42*bright), pts, lw)`
   (outline). The `pi/3` offset makes the two triangles form a Star of David when `spin = 0`.
   Rotation +/- 0.85 rad/s (sense flipped per item by `_spin`).
2. **Orbit ring** - `ring_r = int(r * 1.80)` = 23; if `> 2`:
   `draw.circle(buf, _add(ring_col, 0.30*bright), (cx, cy), ring_r, max(1, lw - 1))` (a 1 px ring,
   stroked inward).
3. **Orbiting nodes** - `ORBIT_NODES = 5`, `orbit = -tt * ORBIT_SPEED(=1.7) * _spin + _phase`
   (note the minus: nodes orbit **against** the triangles, "a geared, mechanical read").
   `node_r = max(2, int(r * 0.19))` = 2. For k = 0..4: `a = orbit + k*TAU/5`, centre
   `(cx + cos(a)*ring_r, cy + sin(a)*ring_r)` - i.e. exactly on the ring - and
   `depth = 0.55 + 0.45*(0.5 + 0.5*sin(a))` -> **0.55..1.00**, brightest at `a = +pi/2`, which in
   y-down space is the **bottom** of the orbit. Filled, colour `_add(ring_col, bright * depth)`.
   Nodes are the brightest element of the ring assembly (no extra 0.3/0.42 factor).
4. **Breathing core** - `core = r * (0.50 + 0.06*pulse(_age * 4.6 + _phase))` (note: `_age`, and the
   *same* phase as the radius breathe, so radius and core pulse together):
   - filled disc `_add(color, 0.30*bright)`, radius `max(2, int(core))`
   - filled disc `_add(lerp_color(color, WHITE, 0.5), 0.42*bright)`, radius `max(1, int(core*0.45))`

   Deliberately dim - the source calls it "a backlight, not a headlight" - because the emblem sits on
   top and has to stay legible.
5. **Emblem** - `glyph = _glyph_sprite(kind, r*1.55, bright)`, blitted onto the scratch with
   `BLEND_RGB_ADD` centred (`(cx - gw/2, cy - gw/2)`).

Then `surface.blit(buf, (int(x - cx), int(y - cy)), BLEND_RGB_ADD)`.

**Compositing semantics to preserve:** inside the scratch, layers 1-4 **overwrite** each other
(pygame draw semantics), so the core disc erases node/triangle pixels beneath it. Only the glyph
*adds*. Then the whole scratch adds to the frame.

**Pixi mapping.** The scratch buffer's "overwrite inside, add outside" is exactly what you get from a
**`RenderTexture`**: render layers 1-4 into a per-rune `RenderTexture` of size `box` with normal
blending, render the glyph into it with `"add"`, then draw the RenderTexture as a `Sprite` with
`blendMode = "add"`. With at most `MAX_ACTIVE = 2` runes on screen, two small (61x61) RenderTextures
is nothing.

Cheaper alternative that is *almost* right: put layers 1-4 in one normal-blend `Graphics` inside a
container with `blendMode = "add"` - but Pixi applies blend per display object, not per container, so
overlapping strokes inside that Graphics would still overwrite (good) while the whole thing adds
(good). This actually works, because a single `Graphics` renders its own primitives in order against
the framebuffer with the container's blend mode... which makes overlaps *add* rather than overwrite.
That is the one difference. Where does it show? The core disc over the ring/nodes - visible only if a
node passes under the core, and `ring_r (23) > core (6.5..7.3)`, so **never**. Verdict: the flat
`Graphics(add)` approach is safe for the shipped geometry; assert `ring_r - node_r > core * 1.05`.

### 8.4 Vector glyphs - `_paint_glyph` (powerups.py:226-273)

All glyphs are authored in a normalised -1..1 box and scaled by `s` at build time. Stroke width
`w = max(2, int(s * 0.22))`. Helper:

```
_pts(norm, cx, cy, s)      = [(int(cx + px*s), int(cy + py*s)) for px, py in norm]
_arc_pts(r, a0, a1, steps) = [(cos(a)*r, -sin(a)*r) for a in linspace(a0, a1, steps+1)]
```

`_arc_pts` negates sin, i.e. the arcs are authored **y-up** and then consumed directly in the y-down
box - so `_arc_pts(rr, 0, pi, n)` traces from `(+rr, 0)` over the **top** to `(-rr, 0)`.

**magnet** - a horseshoe. Drawn wide on purpose: "that gap [between the poles] is the whole
silhouette", and it has to survive the core glow behind it.
```
ring  = _arc_pts(0.92, 0, pi, 14)                       # 15 points
draw.lines(surf, col, False, _pts(ring, cx, cy - 0.10*s, s), w)     # NOTE the -0.10*s y offset
for sx in (-0.92, +0.92):                               # prongs
    draw.line(surf, col, (cx + sx*s, cy - 0.10*s), (cx + sx*s, cy + 0.74*s), w)
for sx in (-0.92, +0.92):                               # polarity caps
    draw.line(surf, col, (cx + sx*s*1.30, cy + 0.74*s), (cx + sx*s*0.55, cy + 0.74*s),
              max(2, int(w * 0.9)))
```

**shield**
```
_SHIELD = ((-0.80,-0.72), (0.80,-0.72), (0.80,0.06), (0.00,0.94), (-0.80,0.06))
draw.polygon(surf, col, _pts(_SHIELD, cx, cy, s), w)                       # outline
draw.line(surf, col, (cx, cy - 0.36*s), (cx, cy + 0.46*s), max(1, w - 1))  # centre rib
```

**slow** (hourglass)
```
_HOURGLASS = ((-0.72,-0.88), (0.72,-0.88), (0.12,0.0), (0.72,0.88), (-0.72,0.88), (-0.12,0.0))
draw.polygon(surf, col, _pts(_HOURGLASS, cx, cy, s), w)
draw.circle(surf, col, (cx, cy + 0.52*s), max(2, int(s * 0.14)))   # the falling grain, filled
```
Note the waist is asymmetric (`+0.12` then `-0.12`), which is what makes the two bulbs read as
mirrored trapezia rather than a bowtie.

**double** - two nested diamonds, "one shape, doubled - the 2x read without text":
```
for scale in (0.94, 0.48):
    dia = ((0,-scale), (scale,0), (0,scale), (-scale,0))
    draw.polygon(surf, col, _pts(dia, cx, cy, s), w)
```

**ghost** - a single closed outline, dome over the top then the wavy hem back:
```
dome        = _arc_pts(0.74, 0, pi, 12)                  # 13 points, right -> left over the top
_GHOST_TAIL = ((0.74,0.42), (0.44,0.92), (0.15,0.46), (-0.15,0.92), (-0.44,0.46), (-0.74,0.92))
outline     = _pts(list(dome) + list(reversed(_GHOST_TAIL)), cx, cy, s)
draw.lines(surf, col, True, outline, w)                  # closed
for sx in (-0.30, +0.30):                                # eyes, filled
    draw.circle(surf, col, (cx + sx*s, cy - 0.16*s), max(2, int(s * 0.13)))
```
The tail is reversed so the hem runs left -> right and the closed outline never self-intersects.

**frenzy** - a **filled** lightning bolt (the only filled glyph):
```
_BOLT = ((0.16,-0.96), (-0.66,0.14), (-0.10,0.14), (-0.30,0.96), (0.62,-0.18), (0.06,-0.18))
draw.polygon(surf, col, _pts(_BOLT, cx, cy, s))          # no width -> filled
```

**unknown kind** - `draw.circle(surf, col, (cx, cy), max(2, int(s*0.7)), w)`.

### 8.5 Glyph sprite cache - `_glyph_sprite` (powerups.py:280-305)

```
sb  = max(4, (int(size) // 2) * 2)                       # size bucketed DOWN to even px
bb  = max(1, int(clamp(bright, 0, 1) * 6 + 0.5))         # brightness -> 6 buckets, rounded
box = sb * 2 + 6
col = _add(lerp_color(powerup_color(kind), WHITE, 0.55), bb / 6.0)
_paint_glyph(surf, kind, col, box*0.5, box*0.5, sb*0.5)
cache key (kind, sb, bb), FIFO trim at 160 entries
```

Called with `size = r * 1.55`, so at `r = 13`: `sb = 20`, glyph radius `s = 10`, `box = 46`, drawn
into a 46x46 sprite and blitted centred on the 61x61 scratch (fits: the magnet's polarity caps reach
`1.30*s = 13 < 23`).

Emblems are **drawn much whiter than everything else** - `lerp_color(kind_colour, WHITE, 0.55)` -
"so they stay legible against the core glow they sit on top of". Keep the 0.55.

Brightness bucketing to 6 levels means the strobe quantises the emblem to 6 steps. That is a cache
artefact; in Pixi, generate **one white glyph texture per (kind, size-bucket)** and drive brightness
with `sprite.tint` + `alpha` continuously. Note this in the verifier as an allowed smoothness
(same class as render.md Q1).

`clear_caches()` (powerups.py:308-311) drops `_GLYPH_CACHE` and `_SCRATCH`. Wire an equivalent to
theme change / GL context loss.

### 8.6 Field-level draw

`PowerUpField.draw` (powerups.py:583-612) clips to `self.rect`, then draws items in list order
(oldest first), each wrapped in try/except. `MAX_ACTIVE = 2`.

### 8.7 Cached vs per-frame

| Cached | Per frame |
|---|---|
| glyph sprites (kind x size-bucket x 6 brightness buckets) | triangles, ring, nodes, core |
| the scratch surface (per size bucket, <= 24 sizes) | the halo (a render.py glow-cache hit) |

---

## 9. Food - animation states (food.py:164-204)

The orb *painter* is fully specced in render.md S6. This section covers what food.py contributes:
position, radius, visibility and colour - the four values it hands to `draw_food_orb`.

### 9.1 The call

`FoodField.draw` (food.py:515-554) clips to `self.rect`, then per item:

```
if not f.visible(t): continue
px, py = f.draw_pos(t)
pr     = f.draw_radius(t)
col    = f.color if f.kind == "mega" else food_color(f.kind, self.theme, t)
draw_food_orb(surface, px, py, pr, col, t, kind=f.kind)
```

`t` is the scene `clock_t`. Note the mega branch: mega orbs use the colour cached during
`update()` (refreshed every frame from `self._t`, food.py:443-445), everything else recomputes at
draw time. Both end up with the same clock value.

### 9.2 Constants

```
BOB_SPEED = 1.9 rad/s      BOB_AMOUNT = 3.2 px       PULSE_AMOUNT = 0.10
POP_IN_TIME = 0.34 s       BLINK_LEAD = 1.0 s        C.FOOD_PULSE_SPEED = 3.4
FOOD_RADIUS = 9.0          bonus radius = 9*1.28 = 11.52    mega radius = 9*1.65 = 14.85
bonus ttl = 8.0 s          mega ttl = 4.5 s          normal ttl = 0 (immortal)
```

### 9.3 State 1 - BOB (always)

```
bob_offset(t) = sin(t * 1.9 + _phase) * 3.2
draw_pos(t)   = (x, y + bob_offset(t))
```

Vertical only. Period `TAU/1.9 = 3.307 s`, +/- 3.2 px. `_phase` is `uniform(0, TAU)` per orb, so
neighbours de-sync. Driven by the **absolute clock**, not age - an orb spawning mid-cycle joins the
wave already in progress.

### 9.4 State 2 - POP-IN (age < 0.34 s)

`scale *= ease_out_back(age / 0.34)`. Same curve as the rune: 0 at age 0, **peak 1.10005 at
`t_norm = 0.5801`, i.e. age = 0.1972 s**, settling to 1.0 at 0.34 s. Combined with the breathe this
peaks at ~1.21x the base radius. There is no clamp here (the rune has one), but the curve never
leaves [0, 1.1] anyway.

### 9.5 State 3 - BREATHE (always)

```
scale *= 1.0 + 0.10 * sin(t * 3.4 + _phase)
```

Absolute clock again, same `_phase` as the bob - so an orb's bob and breathe are locked to each
other, at incommensurate rates (1.9 vs 3.4 rad/s), giving a slow beat with period
`TAU/|3.4-1.9| = 4.19 s`. Range 0.90..1.10 of base.

Note this is the same `FOOD_PULSE_SPEED = 3.4` that render.md S6 uses for `p = pulse(t, 3.4)` inside
the painter - so the orb's *radius* breathe and the painter's *halo/arc* breathe are in phase except
for `_phase`. Keep them on one constant.

### 9.6 State 4 - WITHER (perishable orbs, last 1.0 s)

```
left = remaining(t)
if left != inf and left < 1.0:
    scale *= lerp(0.72, 1.0, clamp(left / 1.0, 0, 1))
```

A linear shrink to **72%** of base over the final second. Only bonus and mega ever wither.

Final: `draw_radius = max(1.0, radius * scale)`.

### 9.7 State 5 - BLINK (perishable orbs, last 1.0 s) - `visible(t)`

```
left = remaining(t)
if left == inf or left >= 1.0: return True
if left <= 0.0:                return False
phase = 34.0 * (left ** 0.6)
return sin(phase) > -0.30
```

The renderer **skips the orb entirely** on an "off" frame - there is no fade.

- Exponent 0.6 < 1 means `dphase/dt = -20.4 * left^-0.4` grows without bound as `left -> 0`:
  **3.25 Hz at left = 1.0, 5.65 Hz at left = 0.25, 12.4 Hz at left = 0.05.** Visibly accelerating.
- Total flashes in the final second: `34 / TAU = 5.41` cycles.
- Duty cycle: off when `sin(phase) <= -0.30`, i.e. over `2.532 rad` of each `TAU` -> **59.7% on**.

### 9.8 Colour - `food_color(kind, theme, t)` (food.py:239-262)

```
base = theme.food     alt = theme.accent2         (UI_GOLD / UI_WHITE when theme is None)
normal: base
bonus : lerp_color(alt, hue_shift(base, 0.08), 0.5 + 0.5*sin(t * 1.7))
mega  : lerp_color(rainbow(t * 0.22, 0.72, 1.0), UI_WHITE, 0.22)
```

- **bonus** ping-pongs between `theme.accent2` and `theme.food` hue-shifted by **+0.08 turns**
  (+28.8 degrees) at 1.7 rad/s (period 3.696 s) - "different but related", never sitting on one hue.
- **mega** runs a full HSV rainbow at `sat 0.72, val 1.0`, hue advancing `0.22 turns/s` -> a complete
  cycle every **4.545 s** - washed 22% toward `UI_WHITE` to sell the rarity without going neon-sick.
  Note the mega orb only lives 4.5 s, so it traverses almost exactly one full hue rotation in its
  lifetime.
- `theme.food` and `theme.accent2` are the only theme keys food uses; `hue_shift` and `rainbow` are
  `palette.ts`'s `hueShift` / `rainbow` (verified 1:1 against `snake/palette.py` by the existing
  parity spec).

### 9.9 Cached vs per-frame

Nothing in food.py is cached. All the caching lives in render.py's glow/flare textures (render.md
S1.3). `_spin` is generated per orb and **never read by any draw path** in either language - see
S10.4.

---

## 10. TS mapping notes

Everything below was verified by reading `web/src/core/obstacles.ts`, `powerups.ts`, `food.ts`,
`palette.ts`, `mathx.ts`, `config.ts`.

### 10.1 Shared helpers

| Python | TypeScript |
|---|---|
| `contracts.TAU / clamp / lerp / pulse / ease_in_out_cubic / ease_out_back / dist_sq` | `core/mathx.ts` - `TAU, clamp, lerp, pulse(t, speed=1), easeInOutCubic, easeOutBack, distSq` (all verified identical, including `pulse`'s default speed of 1) |
| `palette.lerp_color / shade / with_alpha / hue_shift / rainbow / clamp8 / UI_WHITE / UI_GOLD` | `core/palette.ts` - `lerpColor, shade, withAlpha, hueShift, rainbow, clamp8, UI_WHITE, UI_GOLD`; `toHex(rgb)` for Pixi tints. **`clamp8` truncates** in both. |
| `theme.hazard/accent/accent2/grid/food/bg_bottom/name` | `Theme.hazard/accent/accent2/grid/food/bgTop/bgBottom/name` (`RGB` triples) plus `theme.hex.*` pre-packed `0xRRGGBB`. Get the theme from `themeForLevel(level.themeIndex)`. |
| `C.ARENA_RECT, POWERUP_RADIUS, POWERUP_LIFETIME, FOOD_RADIUS, FOOD_PICKUP_PAD, FOOD_PULSE_SPEED, MAX_DT, DEBUG_HITBOXES` | `core/config.ts` - `ARENA_X/Y/W/H`, `POWERUP_RADIUS=13`, `POWERUP_LIFETIME=11`, `FOOD_RADIUS=9`, `FOOD_PICKUP_PAD=6`, `FOOD_PULSE_SPEED=3.4`, `MAX_DT`, `DEBUG_HITBOXES` |
| `render.draw_glow_circle` | `gfx/glow.ts::stampGlow` per render.md S10 (used **only** by the rune halo) |

### 10.2 Hazards - `web/src/core/obstacles.ts`

| Renderer needs | TS property | Notes |
|---|---|---|
| dispatch | `Obstacle.kind: ObstacleKind` | `"wall" \| "movingbar" \| "spinner" \| "pulsar" \| "lasergate" \| "portal"` - note WallBlock's kind is `"wall"`, not `"wallblock"` |
| clip rect | `Obstacle.arena: RectLike \| null` | set by `buildObstacles` |
| debug boxes | `Obstacle.bounds(): RectLike` | integer-truncated, matches `pygame.Rect(int(...))` |
| WallBlock | `x, y, w, h` | `w, h >= 2` enforced in the ctor |
| MovingBar | `x, y` (live corner), `x0, y0`, `w, h`, `axis: "x"\|"y"`, `travel`, `speed`, `phase`, **`dir`**, `span(): RectLike` | `dir` is already documented in the port as "Renderers use it for chevrons and smear" |
| Spinner | `cx, cy, length, arms, speed, thickness, phase, hubRadius, angle, tips(): Vec2[]` | **`hub_radius` -> `hubRadius`**; `tips()` is public and returns `[x, y]` tuples (not `{x,y}`) |
| Pulsar | `cx, cy, minRadius, maxRadius, period, phase, deadlyFrac, armed, radius, charge, deadly`, `get threshold` | **`min_radius/max_radius/deadly_frac` -> `minRadius/maxRadius/deadlyFrac`** |
| LaserGate | `x1, y1, x2, y2, period, fireTime, warnTime, phase, width, armed, firing, warn, deadly` | **`fire_time/warn_time` -> `fireTime/warnTime`** |
| Portal | `x, y, radius, pair, linked, cooldown, secondary, spin` | all public |
| clock | - | **not exposed**; the scene must own `hazardT` (see S10.5 gap 1) |

`Vec2` in obstacles.ts is `readonly [x, y]` (a tuple), unlike snake.ts's `{x, y}` objects. Do not mix
them up.

### 10.3 Power-ups - `web/src/core/powerups.ts`

| Renderer needs | TS |
|---|---|
| the type table | `POWERUP_TYPES[kind].color/name/icon/duration/desc`, `powerupColor(kind)` |
| per-item state | `PowerUp { x, y, kind, born, ttl, radius, age, phase, spin }` - Python's `_age/_phase/_spin` are public `age/phase/spin` |
| brightness | `powerUpBrightness(p)` - exact port including the `freq` semantics |
| radius | `powerUpDrawRadius(p)` - exact port including the `clamp(easeOutBack(...), 0, 1.4)` |
| tuning | `POP_IN_TIME, BLINK_LEAD, SPIN_SPEED, ORBIT_SPEED, ORBIT_NODES, CORE_PULSE_SPEED, GLOW_SCALE, MAX_ACTIVE` |
| the list | `PowerUpField.items: PowerUp[]`, `field.rect` |
| the accent bleed | `field.theme.accent` (typed `PowerUpFieldTheme { accent?: readonly number[] }`) |

**`_BOX_SCALE = 2.05` is not exported.** It only sizes the Python scratch surface, which a Pixi port
replaces; if the RenderTexture route is taken, re-derive `box = trunc(r * 4.1) + 8` in the renderer.

### 10.4 Food - `web/src/core/food.ts`

| Renderer needs | TS |
|---|---|
| the list | `FoodField.items: Food[]`, `field.rect` |
| position | `drawPos(f, t): {x, y}` (also `field.drawPos(f, t)`) |
| radius | `drawRadius(f, t)` |
| blink gate | `visible(f, t)` |
| colour | `field.colorFor(f, t)` - already implements the `mega ? f.color : foodColor(...)` branch |
| kind | `f.kind: "normal" \| "bonus" \| "mega"` -> render.md S6's kind table |
| constants | `BOB_SPEED, BOB_AMOUNT, PULSE_AMOUNT, POP_IN_TIME, BLINK_LEAD, FOOD_KINDS` |

`Food.spin` exists (`randRange(rng, 0, TAU)`) and, exactly as in Python, **is never read by any draw
path** - `draw_food_orb` derives all its rotations from `t` alone. Leave it alone (removing it would
desync the RNG stream and change every subsequent spawn position); just do not look for a use.

### 10.5 Gaps - state the renderer needs that the TS port does not expose

1. **No `drawObstacles` ordering helper.** `obstacles.ts` exports `updateObstacles` and
   `obstacleAvoidList` but not the portals-first draw pass (Python: obstacles.py:1077-1085). The
   renderer must implement it: iterate `Portal` instances first, then the rest, both in list order.
   Recommend adding `hazardLayerOrder(obstacles): Obstacle[]` to the *renderer*, not to the sim
   module (which is deliberately pygame-free).
2. **No hazard clock.** `hazard_t` / `hazard_mult` live in `scenes/gameplay.py` and there is no
   `gameplay.ts` yet. The gameplay scene port must expose `hazardT` and pass it to the hazard
   renderer, and `clockT` to food/runes/arena/snake. Getting these crossed is silent and looks
   almost right - assert `hazardT !== clockT` whenever `hazardMult !== 1`.
3. **`PowerUpFieldTheme` is too narrow.** It declares only `accent?: readonly number[]`, so
   `field.theme` cannot supply anything else. Harmless today (the rune draw path reads only
   `theme.accent`), but the renderer should take the full `Theme` from the scene rather than from
   `field.theme`, and coerce `accent` to an `RGB` triple.
4. **`FoodTheme` is likewise narrow** (`food`, `accent2` only). Same remedy: the orb painter needs
   only the per-orb colour, which `colorFor` already produces, so this is a non-issue as long as the
   renderer does not try to read `field.theme.accent`.
5. **No theme-change hook.** Python has `powerups.clear_caches()` and render.py's `clear_caches()`.
   The TS side needs an equivalent that destroys glyph textures, slab textures and glow textures on
   level change / context loss.
6. **`Obstacle.t`** is set by `update()` but no draw path reads it (both languages take `t` as a draw
   argument). Do not read `ob.t` in the renderer - it is the *last update* time, which can differ
   from the draw time by a frame.

Nothing else is missing: every geometry, phase and telegraph value the six hazards need is public,
correctly named and already verified bit-identical.

---

## 11. PixiJS v8 representation summary

**All textures are generated procedurally at runtime. The game ships no image assets.** The only
things that deserve to be textures are the hazard slab (S1.7) and the rune glyphs (S8.5); everything
else is `Graphics` or a shared glow texture from `gfx/glow.ts`.

| Entity | Representation | Cache | Pooling |
|---|---|---|---|
| WallBlock | `Sprite`(slab texture) + `Graphics`(normal, edge+brackets) + `Graphics`(add, halo) | slab `Texture` per `(w,h,base,edge)`; halo geometry static | one Container per wall, built at level load; up to ~10 per level |
| MovingBar | `Graphics`(rail, static) + `Graphics`(add, 3 smear stadiums) + `Sprite`(slab) + `Graphics`(border) + `Graphics`(chevrons) + `Graphics`(add, halo) | slab `Texture`; chevron geometry rebuilt only on `dir` flip | one Container per bar; translate, do not rebuild |
| Spinner | `Graphics`(add, arm blobs + tip glows) + `Graphics`(normal, arms/tips/hub) + `Graphics`(add, hub glow) | none | one Container per spinner; both Graphics rebuilt per frame |
| Pulsar | `Graphics`(normal, dashes+shockwave) + `Graphics`(add, body glow) + `Graphics`(normal, body) | none | rebuilt per frame (radius is continuous) |
| LaserGate | `Graphics`(add, beam aura) + `Graphics`(normal, dashes or beam) + `Graphics`(add, emitters) + `Graphics`(normal, emitter housings/iris) | none | rebuilt per frame; endpoints are static so only widths/colours change |
| Portal | `Graphics`(add, halo) + `Graphics`(normal, throat/arcs/rim/core) + `Graphics`(add, sparks) | none | in the **portal layer**, below the hazard layer |
| Power-up rune | `stampGlow` sprite (soft halo) + `Graphics`(add, hexagram/ring/nodes/core) + `Sprite`(glyph texture, add) | glyph `Texture` per `(kind, sizeBucket)`, white, tinted | at most 2; pool both |
| Food orb | per render.md S6 | render.md's glow/flare texture caches | pool the orb `Graphics` + glow sprites; up to `foodCount + 2` orbs |

### 11.1 Scene graph and blend batching

```
worldRoot (rect mask = ARENA_RECT)
  portalLayer         (Portal containers, in list order)
  hazardLayer         (all non-Portal hazards, in list order)
  foodLayer
  runeLayer
  snakeLayer + particleLayer      (render.md S7)
```

Interleaved normal-blend `Graphics` and add-blend `Graphics` break batches (the `pixijs-performance`
skill). Each hazard is 2-4 display objects, and a busy level has ~15 hazards -> ~45 objects, which is
fine. Do **not** try to merge all hazards' add-layers into one global additive Graphics: the paint
order within a hazard (opaque strokes over earlier glows, S4.1/S5.3/S7.2) is load-bearing.

### 11.2 Procedural texture generation

- **Slab** - `ImageData` pixel writes (S1.7), `new Texture({ source: new ImageSource({ resource:
  canvas }) })` or `Texture.from(canvas)` after `ctx.putImageData`. Nearest/linear does not matter -
  the sprite is drawn 1:1.
- **Glyph** - draw the glyph paths in **white** into an offscreen canvas at `box = sb*2+6`, then
  `Texture.from(canvas)`; tint per kind and set `alpha`/`tint` from `bright` (S8.5).
- **Glow / disc / flare** - already owned by `gfx/glow.ts` (render.md S10). Hazards need **none** of
  these.

---

## 12. Invariants to assert in dev builds

- `hazardLayerOrder(obstacles)` returns every obstacle exactly once, all Portals before all
  non-Portals.
- Every hazard's drawn geometry is inside `ob.bounds()` inflated by its halo:
  wall `pad_eff`, spinner `thickness*2.2`, laser `width+8` (that is exactly what `LaserGate.bounds()`
  pads by), portal `radius*2.1`, pulsar `maxRadius*1.9`.
- `Pulsar.charge === 1.0` exactly when `Pulsar.deadly` (given `armed`); the shockwave ring radius
  `wr` equals `threshold` at that instant to within 1e-6.
- `LaserGate.warn === 1.0` whenever `firing`; `warn` is monotonically non-decreasing across the
  warning window.
- `Spinner`: `tipGlowR_eff < 2 * length * sin(PI / arms)` (justifies the S4.4 reordering).
- Rune: `powerUpBrightness(p) >= 0.30` always; `ring_r - node_r > core * 1.05` (justifies the S8.3
  flat-Graphics shortcut).
- Food: `drawRadius(f, t) >= 1.0`; `visible(f, t) === true` for every `normal` orb.
- No texture is created after level load + ~1 s on a stable theme (slab and glyph textures only).

---

## 13. Open questions

- **Q8 - Hard hazard glows.** S1.1 proves the hazard glow is a flat, hard-edged, full-brightness
  additive disc, not a soft halo (verified against pygame 2.6.1 in this repo). This is almost
  certainly an accident in the original (`_glow_sprite`'s comment says "alpha rises steeply toward
  the centre"), but it is what ships and it defines the entire look and readability of the hazard
  layer. **Port as-is** is the recommendation. Confirm the orchestrator agrees before anyone
  "improves" it into a gradient - a screenshot comparison on a spinner and a wall should settle it.
- **Q9 - `intensity` as radius.** Following from Q8, `intensity` animations are mostly invisible
  (S1.2 table: the spinner hub pulse and the laser emitter warn pulse both move `R_eff` by 0 px).
  Port the dead animation faithfully, or drop the dead code? Recommend: keep the expressions (they
  document intent and become live if a level changes `hub_radius`), but do not add an alpha pulse to
  "make them work".
- **Q10 - Hatch alpha semantics.** The 45-degree hatch *replaces* alpha-238 body pixels with
  alpha-42 pixels, so it reads as a see-through stripe (S1.7). Confirm this is intended before
  choosing the `ImageData` route (which is more code than a Canvas `source-over` pass but is the only
  faithful one).
- **Q11 - Rune scratch compositing.** S8.3 argues a flat `Graphics(add)` is safe because the core
  disc never overlaps the ring or nodes at the shipped `POWERUP_RADIUS = 13`. If `POWERUP_RADIUS`
  ever becomes level-dependent, the RenderTexture route is required. Pick one now: RenderTexture
  (always correct, 2 small textures) or flat Graphics (cheaper, guarded by an assert)?
- **Q12 - Glyph brightness quantisation.** Python buckets the emblem brightness into 6 levels; a
  tinted white texture animates smoothly. Same class as render.md Q1 - is "smoother than Python"
  acceptable to the verifier?
- **Q13 - `flick` vs hitbox on the laser.** The drawn beam is up to 14% narrower than the lethal
  width (S6.3). Faithful, but it is a fairness bug. Port as-is, or widen the *drawn* minimum to
  `width`? Default: port as-is.
- **Q14 - Portal arcs "counter-rotating".** All three arcs rotate the same way despite the docstring
  (S7.2, item 3). Port as-is (default), or honour the docstring? Port as-is changes nothing about
  gameplay, and "fixing" it would be visible.
- **Q15 - "Tidal columns".** Confirmed not to exist (S0.2). Confirm with the orchestrator that the
  vertical `MovingBar` was what was meant, and that no seventh hazard is expected.
