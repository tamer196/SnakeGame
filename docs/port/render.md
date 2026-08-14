# Port spec — `snake/gfx/render.py` → TypeScript + PixiJS v8

**Ground truth:** `E:/SnakeGame/snake/gfx/render.py` (1476 lines). Read it alongside this spec; line
references below point into that file. The Python game must not be modified.

**Suggested TS home:** `web/src/gfx/render.ts` (primitives + arena + food orb) and
`web/src/gfx/snakeRenderer.ts` (the snake, which is stateful enough to deserve its own module /
class owning a Pixi `Container`). Module boundaries are proposed in §10.

---

## 0. Scope — what is and is NOT in this file

`render.py` contains exactly four public drawing subsystems plus the glow-primitive layer they all
share:

1. **Glow primitives** — `glow_surface`, `disc_surface`, `_flare_surface`, `draw_glow_circle`,
   and their caches (lines 65–444). These are the shared vocabulary of the whole game: scenes,
   power-ups, food and obstacles all call `draw_glow_circle`.
2. **The snake** — `draw_snake` and its helpers (lines 448–1175). The signature feature (cross-over
   overpass) lives here; see §4.6.
3. **The arena frame** — `draw_arena` (lines 1178–1338).
4. **Food orbs** — `draw_food_orb` (lines 1341–1467).

**NOT in this file** (do not spec-drift, but do not silently drop either — flag to the orchestrator):

| Thing | Where it actually lives | Relationship to render.py |
|---|---|---|
| Obstacles/hazards (WallBlock, MovingBar "sweeper", Spinner, Pulsar, LaserGate, Portal) | `snake/core/obstacles.py` — each class has its own `draw(surface, theme, t)`; `draw_obstacles` (obstacles.py:1077) draws **portals first, then everything else** so hazards read on top | They consume `render.draw_glow_circle` indirectly; their visuals need their **own spec pass** over obstacles.py |
| Power-up runes | `snake/core/powerups.py` — draws itself, lazily resolving `render.draw_glow_circle` (powerups.py:695–716) | Same: needs its own spec pass |
| Food manager (bob, pop-in, wither, TTL blink) | `snake/core/food.py` — computes `draw_pos(t)`, `draw_radius(t)`, colour, kind, then delegates to `render.draw_food_orb` (food.py:95–111) | The orb *painting* is fully specced here (§6); the *animation of position/radius* is food.py's |
| Particles, background, screen-space FX | `snake/gfx/particles.py`, `background.py`, `effects.py` | Separate assignments |
| HUD text, pause button, popups, READY/GO | `snake/gfx/ui.py` + `scenes/gameplay.py` | **Later scenes phase** |

### 0.1 Draw-order contract (from `scenes/gameplay.py::_draw`, lines 1174–1225)

Per frame, in this order (all in 1280×720 design space):

1. `background.draw(surface)`
2. `draw_arena(surface, self.arena, theme, t)` — `t` is the scene clock `clock_t`
3. `draw_obstacles(surface, obstacles, theme, self.hazard_t)` — note **separate hazard clock**
4. `food.draw(surface, t)` → many `draw_food_orb` calls
5. `runes.draw(surface, t)` (power-ups)
6. **Clip to arena rect**, then: `draw_snake(surface, snake, theme, t, ghost=effects.has("ghost"),
   shield=effects.has("shield"))` — but only if `_snake_visible(snake)`; then
   `game.particles.draw(surface)`. Clip restored.
7. Popups, HUD (self-clipping strip at top), pause button, READY/GO overlays. *(scenes phase)*

**Invulnerability flicker is NOT in render.py.** `gameplay._snake_visible` (gameplay.py:1227) hides
the whole snake on frames where `sin(snake.invuln * TAU * 7.0) <= -0.25` (`BLINK_HZ = 7.0`,
gameplay.py:117). Duty cycle ≈ 54% visible. In Pixi: toggle the snake container's `visible`.

**Clipping.** pygame `surface.set_clip(rect)` around snake + particles keeps neither from spilling
outside the arena. Pixi equivalent: a shared `Container` for snake+particles with a rectangular
mask (Graphics mask or `cullArea` won't clip — use a mask, or `boundsArea` + a `Graphics` rect
mask; a mask is the faithful choice).

### 0.2 Coordinate spaces

- Everything is authored in **design pixels**, 1280×720 (`C.WINDOW_W/H`). The web shell
  (`web/src/app/Viewport.ts`) scales/centres a world root; render code never needs to know.
- The **arena rect** is `C.ARENA_RECT = (ARENA_X, ARENA_Y=HUD_H=78, ARENA_W, ARENA_H)`
  (config.py:63–70, ported in `web/src/core/config.ts`). Gameplay passes its own `self.arena`
  (same rect) into `draw_arena`.
- Angles: radians, `0 = +x`, **y grows downward**, so positive angles turn clockwise on screen.
  A "left normal" of tangent `(tx,ty)` is `(-ty, tx)` — visually to the left of travel.
- Overscan: irrelevant here; arena drawing self-clips (see §5.4) and the snake is clipped by
  gameplay.

---

## 1. The additive-glow convention (must be understood before anything else)

Module docstring, lines 1–44. Every glow sprite bakes its radial falloff into **RGB**, not alpha:
`colour_at(u) = base_colour * falloff(u)`, with untouched pixels at RGB (0,0,0). This is because
`pygame.BLEND_RGB_ADD` sums source RGB into the destination and ignores source alpha. Alpha is
*also* written into the sprite (same falloff) so the sprite composites sanely in normal mode and so
`BLEND_RGBA_ADD` (ghost path) accumulates alpha.

**PixiJS v8 mapping.** Standard `blendMode = "add"` on a Sprite does `src*srcAlpha + dst` (premultiplied
pipeline). Two workable ports:

- **(recommended)** Bake each glow into a texture exactly as Python does (Canvas 2D offscreen:
  concentric `arc()` fills, or a tiny fragment-shader-generated `RenderTexture`), storing the
  falloff in RGB with alpha = falloff too. With premultiplied-alpha textures and `"add"` the result
  matches pygame when the sprite's own colour channels already carry the falloff — generate the
  canvas with `globalCompositeOperation = "source-over"` painting rgba(c*f, 255*f) rings, which is
  precisely `_build_glow`. Upload with `Texture.from(canvas)`.
- Alternatively one **white** radial texture per falloff shape, tinted via `sprite.tint` and scaled —
  cheaper cache, but Python's per-colour bucketing (§1.3) means the two are equivalent only if the
  falloff curve is colour-independent, which it is. **Tint+scale a shared white texture is the
  better Pixi design**: one texture per (falloff-shape), `tint = toHex(color)`,
  `alpha`/`tint`-multiply for intensity, `scale` for radius. Fidelity note: Python quantises radius
  into 2.5 px buckets and rebuilds; tint+scale is *smoother* than the original. Acceptable — flag in
  the verifier that glows are allowed sub-bucket smoothness. (Open question Q1.)

`BLEND_RGB_SUB` (contact shadow, §4.6) — pygame subtracts source RGB from dest, leaving dest alpha
alone. Pixi v8: `"subtract"` blend mode exists but is an **advanced** mode
(`import "pixi.js/advanced-blend-modes"` + `useBackBuffer: true` at init; filter-based, expensive —
see `web/node_modules/pixi.js/skills/pixijs-blend-modes/SKILL.md`). Cheaper faithful option: a custom
blend mode using the GL `funcReverseSubtract` blend equation (Pixi v8 lets you register blend modes
with custom `BLEND_MODES`/BlendModeFilter, or use `"multiply"` with an inverted shadow sprite).
Recommendation: try advanced `"subtract"` first (only 1–3 sprites/frame use it); if the
back-buffer cost is unacceptable, approximate with a `"multiply"` sprite whose texture is
`1 - falloff*shadowStrength` — visually equivalent for darkening. (Open question Q2.)

### 1.1 `_build_glow(radius, color, intensity)` — lines 277–307

Sprite size `2r × 2r`, centre `(r, r)`.

- `steps = clamp(radius * 1.35, 10, 60)` concentric filled circles, drawn **outside-in**.
- For `i in 0..steps-1`: `u = i/steps` (0 at rim → 1 at core); ring radius `rr = radius*(1-u)`,
  stop when `rr < 1`.
- Brightness `f = u² · (0.35 + 0.65u) · intensity` (between squared and cubed falloff — soft halo,
  hot core). Skip if `f ≤ 0` (the outermost ring is always skipped since u=0).
- Ring colour `(clamp8(r₀f), clamp8(g₀f), clamp8(b₀f), clamp8(255f))`.
- Finally a solid core disc: radius `max(1, radius*0.12)`, colour `c*intensity`, alpha
  `255*min(1,intensity)` — keeps tiny glows from vanishing.

### 1.2 `disc_surface(radius, color, intensity)` — lines 365–409

Soft-edged **flat disc** (for the contact shadow): full strength out to 55% of radius, feathered
beyond. Radius clamped to ≤160, quantised `rb = ceil(r/3)`, actual `R = rb*3`; intensity clamped
0.02..2.0, quantised to tenths. `steps = clamp(R*0.9, 8, 34)` circles outside-in; per ring
`f = clamp(u/0.45, 0, 1) * intensity` (u as above — so the outer 45% of the radius is the feather,
everything inside is flat). Same RGB-baked convention; usable with ADD or SUB.

### 1.3 Caches & quantisation — lines 65–94, 310–345

- `glow_surface`: radius clamped to (0, 340], bucketed `rb = ceil(r/2.5)` (sprite built at
  `rb*2.5`); intensity clamped 0.02..3.0, bucketed to eighths (`ib = round(i*8)`, built at `ib/8`);
  colour bucketed to 4 bits/channel (12-bit key, representative colour `nibble*17`). Cache limit
  1600 entries, FIFO eviction (insertion order).
- `_FLARE_CACHE` limit 120, `_FRAME_CACHE` limit 8, `_DISC_CACHE` limit 160.
- `clear_caches()` drops everything (call on theme change / context loss).
- **Pixi:** a `Map<key, Texture>` with the same bucketing if you bake per-colour; or per-shape white
  textures + tint (then only radius/intensity shape matter — a handful of textures total).
  Destroy textures on clear.

### 1.4 `draw_glow_circle(surface, x, y, radius, color, intensity, blend=BLEND_RGB_ADD)` — line 355

Stamps the cached sprite **centred** on (x, y) (`_add_blit`, line 348: top-left = centre − width/2,
int-truncated). This is the API obstacles/power-ups/scenes call. Port signature suggestion:
`stampGlow(container, x, y, radius, rgb, intensity, blend = "add")` returning a pooled Sprite, since
Pixi is retained-mode (§9).

### 1.5 `_flare_surface(radius, color, arms=4)` — lines 412–444

Star sparkle. `R = ceil(r/3)*3`, size `2R`. For each arm `a`: angle `a·TAU/arms` (arm 0 points
+x, i.e. right; 4 arms = +, not ×), endpoint at `R-1` from centre. Each arm drawn 3× with
`(width, brightness)` = (5, 0.22), (3, 0.45), (1, 0.95) — fakes a taper. Alpha 255 on the strokes.
Then a `glow_surface(R*0.42, col, 0.85)` is ADD-blitted at the centre. Cached per
(radius-bucket, colour-bucket, arms).

---

## 2. Small helpers the port needs (lines 166–271)

- `_ip(p)` — `Math.trunc` both coords. pygame draws on integer pixels; Pixi doesn't need this, but
  keeping the truncation makes screenshot-diffing against Python easier. Recommend keeping the
  floats in Pixi (crisper) — verifier tolerance, not equality. (Open question Q3.)
- `_c(col, alpha)` — attaches an alpha to a draw colour when painting into the ghost layer.
  pygame.draw *writes* RGBA (no blending among strokes), giving uniform translucency across
  overlapping strokes. **Pixi equivalent: `AlphaFilter`** on the flattened snake container (or a
  RenderTexture), *not* per-object alpha — per-object alpha would double up where strokes overlap.
- `_body_color(theme, u)` = `theme.body_at(u)` = `lerp_color(theme.snake_a, theme.snake_b, u)` →
  `bodyAt(theme, u)` in `web/src/core/palette.ts:175`.
- Every public entry point is wrapped in try/except and **must never throw** (a throwing renderer
  kills the frame). Port: keep defensive guards on non-finite inputs (`_fnum`), but let TS types do
  most of the work; wrap top-level scene draw in try/catch.

---

## 3. Snake — geometry pipeline (lines 448–604)

`draw_snake(surface, snake, theme, t, *, ghost=False, shield=False, crossing=None)` — line 1094.

### 3.1 `_snake_geometry` → `(pts, radii)`, index 0 = head (line 450)

- `pts[0] = snake.head_pos()`; then append every `snake.segments[i]`, **skipping segments[0] if it
  is within 1 px of the head** (dedup).
- `radii[i] = snake.radius_at(i)` (TS: `Snake.radiusAt(i)`, `web/src/core/snake.ts:346`). Fallback
  taper (only if radius_at is broken — TS port can assert instead): with `u = i/(n-1)`:
  `u < 0.25 → lerp(SNAKE_HEAD_RADIUS=13, SNAKE_BODY_RADIUS=11, min(1, 4u))`, else
  `lerp(11, SNAKE_TAIL_RADIUS=5, (u-0.25)/0.75)`. Clamp every radius to ≥ 1.5.

### 3.2 `_frames` → per-point left normal + signed curvature (line 492)

- Tangent at i = normalize(`pts[i-1] − pts[i+1]`) — i.e. **forward along travel** (endpoint
  clamped indices; if degenerate, copy previous tangent; index 0 default = `(cos heading, sin heading)`).
- Normal = `(-ty, tx)` (left of travel).
- Curvature `curv[i] = cross(tan[i+1], tan[i-1]) = ax·by − ay·bx`, clamped −1..1 (this is
  sin(turn angle) — free of extra sqrt). Endpoints copy their neighbour.

### 3.3 `_bank_points` — the banking lean (line 531)

For each point: `ramp = clamp(i / BANK_RAMP=4, 0, 1)` (head never moves);
`k = curv[i] * 3.4`; **for i < 8**, `k = lerp(turnInput, k, i/8)` (steering leads the geometry near
the neck); clamp k to −1..1; store as `lean[i]`; offset the point by
`normal * k * ramp * radii[i] * BANK_STRENGTH=0.34`. `turnInput` = `snake.turn_input`
(TS `Snake.turnInput`, raw −1..1; fallback `bank`).

All later painting, **including cross-over detection**, uses the banked points.

### 3.4 `_find_crossings` — overpass detection (line 560)

Inputs: banked `pts`, `radii`, `skip = max(2, C.SELF_COLLISION_SKIP = 16)`.

- Front samples: indices `f ∈ {0, 2, 4, 6}` with `f < skip`.
- Rear scan: `j` from `skip` to n−1 **stepping by 2**.
- Cheap AABB reject: `|dx| ≤ rr` then `|dy| ≤ rr` where `rr = radii[f] + radii[j]`.
- Hit if `d² < rr²`; `depth = 1 − d/rr` (0..1 overlap). Keep the **deepest** hit per front sample
  as `(f, crossed_x, crossed_y, depth)`.
- At most `MAX_CROSSINGS = 3` results.

Separately, `punch` (0 or 1) comes from the **simulation's** `snake.crossing_self()`
(TS `Snake.crossingSelf()`), overridable via the `crossing` kwarg. `punch` amplifies the crossing
decoration (§4.6) on frames where the sim itself says a pass-over is happening.

---

## 4. Snake — painting (lines 610–1175)

### 4.0 Context (`_Ctx`, line 610) — resolved once per snake per frame

- `cols[i] = bodyAt(theme, i/(n−1))` — the head-to-tail gradient. Colour sources (per level theme,
  from `themes.json` / `palette.ts Theme`): `snake_a → snakeA`, `snake_b → snakeB`,
  `snake_head → snakeHead`, `accent`, `accent2`. **Never hard-code the hex values.**
- `rims[i] = lerpColor(cols[i], WHITE, 0.52)` (+ghost alpha), `body[i] = cols[i]` (+ghost alpha).
- `head_col = theme.snakeHead`; `accent`, `accent2` from theme.
- `hot = lerpColor(lerpColor(EXHAUST_COLOR=(255,196,96), accent2, 0.16), WHITE, 0.22)` — boost
  exhaust colour.
- `speed = clamp((snake.currentSpeed − SNAKE_BASE_SPEED=210) / (SNAKE_MAX_SPEED=460 ·
  SNAKE_BOOST_MULT=1.85 − 210), 0, 1)` (line 1084).
- `boosting = snake.boosting`.
- `plate_step = max(2, floor(n / SCALE_PLATE_TARGET=26) + 1)`.
- Normal path: `alpha=255, gi=1.0, blend=BLEND_RGB_ADD`. Ghost path: `alpha=116 (GHOST_ALPHA)`,
  `gi=116/255`, `blend=BLEND_RGBA_ADD` (§4.9).

### 4.1 Master layer order (`_paint_snake`, line 1017) — back to front

1. **Aura** (two glows per sampled point)
2. **Tail tip flick**
3. **Rear body**: `_paint_range(n−1 … split+1)` where `split = min(FRONT_SPAN=9, n−1)`
4. **Cross-over decoration** (`_draw_crossings`) — stamped on top of the rear body
5. **Front body (neck + head end)**: `_paint_range(split … 0)` — paints OVER the decoration
6. **Head** (skull/jaw/eyes/streaks/exhaust)
7. **Shield ring** (if `shield`)

This split is **the** overpass mechanism: rear first, shadow+rim, then the front tube repainted at
true width on top, leaving only the halo's edges visible around the head end.

### 4.2 Aura (lines 1026–1038)

Subsampled: `step = 1 if n ≤ 24 else max(1, n // 24)`; iterate `i` from n−1 down by `step`.
`beat = pulse(t, 3.1)` (`pulse(t,s) = 0.5 + 0.5·sin(t·s)`, contracts.py:214 / `mathx.ts pulse`).
Per point, two ADD glows in `cols[i]`:
- wide bloom: radius `r·3.6`, intensity `(0.30 + 0.10·beat)·gi`
- tight sheath: radius `r·1.7`, intensity `(0.46 + 0.14·beat)·gi`

### 4.3 `_paint_range(i_from, i_to)` — the tube, painted tail-most first (line 639)

Guard: returns if `i_from < i_to`. Four sub-passes, each its own full loop over the range
(descending index = tail→head):

**(a) Rim shell** — colour `rims[i]`. For each i: if i>0, a line `pts[i]→pts[i-1]` of width
`max(1, floor(min(rᵢ, rᵢ₋₁) · 2))`; then a filled circle radius `floor(rᵢ)` at `pts[i]`. (pygame
thick lines are butt-ended quads; the circles are the joints/caps. In Pixi Graphics: stroke with
`cap:"butt"`, or draw the same quad+circle union. Keep the circles — they are the silhouette.)

**(b) Gradient interior** — colour `body[i]`, inset inside the rim. `rim_w = clamp(r·0.22, 1.4, 3.0)`;
`inner = r − rim_w`; skip point if `inner < 1`. Line width `floor(min(inner, rᵢ₋₁ − rim_w) · 2)`,
circle radius `floor(inner)`.

**(c) Hot spine seam** — skip if `r < 3`. `s = 0.5 + 0.5·sin(i·0.52 − t·7.0)` (bright band drifts
tailward). `bright = lerpColor(cols[i], head_col, 0.30 + 0.45s)`;
`core = lerpColor(bright, WHITE, 0.30s)` (+alpha). Line width `max(1, floor(r·0.46))`, circle radius
`max(1, floor(r·0.36))`. Additionally, when `s > 0.72` **and i is even**: ADD glow radius `r·2.1`,
colour `accent`, intensity `0.60·s·gi` at the point.

**(d) Scale plates** — chevrons pointing head-ward every `plate_step` points. Start
`i = i_from − (i_from mod step)`, walk down by `step`; skip `i < 1` or `i ≥ n−1`.

> ⚠️ **Faithful quirk:** inside this pass the variable `r` is **stale** — it still holds the last
> value assigned in pass (c), i.e. `radii[i_to]` (the head-most point of the range). So the plate
> gates `if r < 7.0: skip`, the half-width `e = r·0.60` and the stroke width
> `pw = (r < 8 ? 1 : 2)` all use `radii[i_to]` for **every plate in the range**, not the plate's own
> radius. For the rear range that's `radii[FRONT_SPAN+1]` (≈ body radius), for the front range
> `radii[0]` (head radius). Consequences: plates never actually taper off toward the tail via this
> check, and `e` is constant per range. **Replicate as-is for pixel fidelity** (see Q4).

Plate geometry at index i: `p = pts[i]`, `nrm = normals[i]`, `a = pts[i-1]` (head-ward neighbour);
apex `m = p + (a − p)·0.42`; wing tips `left/right = p ± nrm·e`. Brightness split from the lean:
`k = lean[i]`; `lb = 0.26 − 0.20k`, `rb = 0.26 + 0.20k`, both clamped 0.04..0.62 (outside of the
turn catches the light). Two lines (width `pw`), colours `lerpColor(cols[i], WHITE, lb)` for
left→m and `…rb` for right→m (+alpha).

### 4.4 Tail flick (`_draw_tail`, line 951) — drawn between aura and body

Needs `n ≥ 3`. `d` = unit vector from `pts[n−2]` to `pts[n−1]` (outward); `nrm` = its left normal.
`reach = max(6, SNAKE_SEGMENT_SPACING=13 · 0.9) = 11.7`; `flick = sin(t·8.4)·reach·0.42`;
`r = radii[n−1]`. `mid = end + d·reach·0.5 + nrm·flick·0.5`; `tip = end + d·reach + nrm·flick`.
Draw: line `end→mid` colour `rims[n−1]` width `max(1, floor(r·1.4))`; line `mid→tip` colour
`lerpColor(cols[n−1], WHITE, 0.55)` (+alpha) width `max(1, floor(r·0.7))`; ADD glow at tip radius
`r·3.0`, colour `accent`, intensity `(0.35 + 0.25·pulse(t, 6.0))·gi`.

### 4.5 The head (`_draw_head`, line 814) — skull, jaw, eyes, streaks, exhaust

Inputs: `(hx,hy) = pts[0]`, `hr = radii[0]`, `heading`, `lean = lean[0]`. Bases:
`(ca,sa) = (cos, sin)(heading)` forward; `(px,py) = (−sa, ca)` left.

- `fill = lerpColor(cols[0], head_col, 0.28)`; `rim = lerpColor(head_col, WHITE, 0.5)`.
- `hood = hr·1.06`; `su = hood·(1 + 0.26·speed)` (stretch along heading);
  `sv = hood·(1 − 0.10·speed)`; `shear = clamp(lean, −1, 1)·0.26`.
- Local→world (`_xform`, line 806): a unit point `(u, v)` (u forward, v left) maps to
  `v' = v + shear·(0.6 − u)`, world = `(hx + ca·u·su + px·v'·sv, hy + sa·u·su + py·v'·sv)`.

Draw order within the head:

1. **Motion streaks** (only if `speed > 0.30`): `k = (speed−0.30)/0.70`;
   `streak = lerpColor(cols[0], WHITE, 0.45)`. For `j = 1..3`: `f = 1 − j/4`;
   distance `d = hood·(0.75 + 1.15j)·(0.65 + 0.55k)`; ADD glow radius `hood·(1.5 − 0.22j)`,
   intensity `(0.16 + 0.34k)·f·gi`, at `head − forward·d`.
2. **Boost exhaust** (if `boosting` and n > 2): for `i = 1..min(6,n)−1`: `f = 1 − (i−1)/5`;
   ADD glow at `pts[i]`, radius `radii[i]·(1.45 + 0.75f)`, colour `hot`, intensity
   `(0.18 + 0.42f)·gi`.
3. **Head halo**: ADD glow radius `hood·3.0`, colour `head_col`, intensity
   `(0.44 + 0.16·pulse(t, 4.2))·gi`.
4. **Jaw**: filled polygon of `_JAW` (7 unit points, line 146) through `_xform` with origin nudged
   forward by `hood·0.06`, scales `su·1.02, sv·0.94`, same shear. Colour
   `shade(lerpColor(cols[0], head_col, 0.10), 0.62)` (+alpha).
5. **Skull**: filled polygon of `_SKULL` (12 unit points, line 130; nose at (1.30, 0)) in `rim`
   (+alpha); then an **inner** skull polygon at scales `max(1, su−2.4), max(1, sv−2.4)` in `fill`
   (+alpha) — a uniform ~2.4 px rim. Fallback if the polygon degenerates (spawn-length snake): two
   discs radius `hood` / `hood − 2.4`.
6. **Mouth crease**: line from `_xform((0.30,0))` to `_xform((1.30,0))` in the jaw colour, width
   `max(1, floor(hood·0.16))`.
7. **Specular sweep**: ADD glow radius `hood·0.66`, WHITE, intensity `0.34·gi`, at
   `head − forward·hood·0.16 + left·hood·0.42`.
8. **Eyes** (both sides `side = ±1`):
   - `open_f = _blink(t)` (line 794): period 3.7 s, first 5% of it is the blink; within it
     `u = phase/0.05`, openness = `|2u − 1|` (snap shut, snap open); otherwise 1.0.
   - `eye_r = max(1.8, hood·0.27)`; `eye_d = hood·0.62`; angular spread `±0.74 rad` off heading;
     `pupil_r = max(1, eye_r·0.50)`; `dark = shade(cols[0], 0.22)`.
   - Eye centre: `head + dir(heading + side·0.74)·eye_d + left·shear·hood·0.4`.
   - Per eye, in order: ADD glow radius `eye_r·2.4`, colour `accent2`, intensity `0.34·gi`; sclera
     disc `UI_WHITE` (+alpha) radius `eye_r`; pupil disc `dark` radius `pupil_r` at
     `centre + forward·eye_r·0.40` (looks where it's going); socket ring `dark`, radius
     `eye_r + 1`, width 1; catchlight WHITE disc radius `max(1, eye_r·0.30)` at
     `centre − forward·eye_r·0.32 + left·eye_r·0.34`.
   - **Lids** (if `open_f < 0.999`): `drop = eye_r·(1 − open_f)`; for `s = ±1`:
     `oy = s·(eye_r − drop·0.5)`; a quad in the skull `fill` colour spanning
     `centre ± forward·eye_r·1.25` horizontally and from left-offset `oy + s·drop·0.5` to
     `oy − s·drop·0.5` — i.e. two skull-coloured shutters closing from above and below.

### 4.6 ★ THE CROSS-OVER OVERPASS (`_draw_crossings`, line 736) — signature feature

**How Python makes the head read as passing OVER its own body:**

1. **Ordering** (§4.1): body indices > `FRONT_SPAN=9` (rear) are painted first; the decoration is
   stamped on the rear; then indices ≤ 9 (neck+head end) are painted **on top**, then the head.
2. **Detection** (§3.4) runs on the *banked/drawn* polyline so the marks land exactly where the
   tubes visually overlap, independent of the sim's collision test.
3. **Per crossing** `(f, bx, by, depth)` with `r = radii[f]`, `d = clamp(depth, 0, 1)`,
   front point `(fx,fy) = pts[f]`, contact midpoint `m = ((fx+bx)/2, (fy+by)/2)`:

   **(a) Contact shadow (subtractive).** Colour `shadow_col = lerpColor(SHADOW_COLOR=(104,116,146),
   cols[n//2], 0.60)` — the neutral grey is pulled toward the body's own mid-gradient hue so
   subtraction removes brightness instead of leaving a complementary tint. Stamp
   `disc_surface(r·(2.1 + 0.5d), shadow_col, (0.52 + 0.30d)·(0.72 + 0.28·punch))` with
   **`BLEND_RGB_SUB`** at `m + (r·0.36, r·0.42)` — offset down-right so it reads as a *cast*
   shadow, not a smudge. Uses the flat-centred disc (not the peaked glow) so the visible ring
   around the head is still dark (§1.2).

   **(b) Contact rim.** `rim_c = lerpColor(accent, WHITE, 0.18 + 0.24·punch)` (+alpha).
   Over segment indices `lo = max(0, f−1)` to `hi = min(n−1, f+3)`: draw the front tube
   **over-wide** — lines of width `floor((min(rᵢ, rᵢ₋₁) + halo)·2)` with `halo = 2.2 + 1.4·punch`,
   for `i` from hi down to lo+1, plus end-cap circles radius `max(2, floor(rᵢ + halo))` at
   indices `lo` and `hi` only. Because `_paint_range(split…0)` immediately repaints the front tube
   at its true width on top, what survives is a ~2–4 px bright *outline* hugging the head-end
   exactly where it crosses — the bridge-deck edge-light.

   **(c) Crossing glow.** ADD glow at the front point: radius `r·2.4`, colour `accent`, intensity
   `(0.20 + 0.30d + 0.26·punch)·gi`.

`punch` is 1.0 on frames where the simulation reports `crossingSelf()`, else 0.0 — it widens the
halo, brightens rim/shadow/glow. (No smoothing — it is binary per frame.)

**Pixi note:** the rim relies on paint-order overdraw within one container; keep the exact child
order: rearBody → shadow(SUB) → rimStrokes → crossGlow(ADD) → frontBody → head.

### 4.7 Shield (`_draw_shield`, line 980) — if gameplay's ActiveEffects has `"shield"`

Around `pts[0]`, radius base `hr = radii[0]`:
- `breathe = 1 + 0.055·sin(t·4.4)`; `R = hr·2.45·breathe`; `rot = t·1.15`;
  `bright = 0.55 + 0.45·pulse(t, 5.0)`.
- Containment bubble: ADD glow radius `R·1.05`, colour `accent2`, intensity `(0.20·bright + 0.08)·gi`.
- Outer hexagon: vertices at angles `rot + k·TAU/6`, radius `R`; closed polyline width 2, colour
  `lerpColor(accent, WHITE, 0.30·bright)` (+alpha).
- Inner hexagon: counter-rotating, angles `−rot·0.65 + k·TAU/6`, radius `0.70R`; width 2, colour
  `lerpColor(accent2, WHITE, 0.45 − 0.35·bright)` (out of phase with the outer).
- Vertex sparks on the outer hex: per vertex `i`, `k = 0.45 + 0.55·pulse(t·6.0 + i·1.05)`
  (note: `pulse(x)` with default speed 1 = `0.5+0.5·sin(x)`), ADD glow radius `hr·0.52`, colour
  `accent`, intensity `0.60·k·gi`.

### 4.8 Ghost (phase power-up) rendering — lines 1150–1173

When `ghost=True` the whole snake is drawn at uniform ~45% opacity (`GHOST_ALPHA = 116`):

- Python: paints the full snake into a persistent full-window SRCALPHA scratch layer (cleared only
  inside the snake's bbox: pad = `max(radii)·3.6 + 14`), with `alpha=116` baked into every stroke
  colour (`_c`) and glows blitted `BLEND_RGBA_ADD` (so alpha accumulates and the halo survives
  compositing); then blits the bbox region back normally.
- Effect: **uniform translucency** — overlapping strokes do NOT stack up opacity; glows still add.
- **Pixi:** put the whole snake in one `Container` and apply `new AlphaFilter({ alpha: 116/255 })`
  (filters flatten the subtree exactly like the scratch layer). Do **not** just set
  `container.alpha` (v8 container alpha multiplies per-leaf and overlaps double up). Also scale all
  glow intensities by `gi = 116/255` as Python does (glow energy dims *and* the layer is faded).
- `shield` and `crossing` decoration render inside the ghost layer too.

### 4.9 Per-frame vs cached (snake)

Everything geometric is **per-frame immediate mode** in Python (one big Graphics rebuild per frame
is the honest Pixi mapping — see §9). Only the glow/disc/flare sprites are cached.

---

## 5. Arena frame (`draw_arena`, lines 1178–1338)

Called every frame with the arena rect, theme, scene time. Colours: `theme.accent`, `theme.accent2`.

### 5.1 Cached frame sprite (`_arena_frame`, line 1181) — built once per (w, h, colour buckets)

Surface `(w+52) × (h+52)`, arena rect at offset (26, 26). Two ring stacks, ADD-ready (alpha 255,
brightness in RGB):

- **Inner gradient** (lit from within): `depth = 40`; for `i = 40 → 1`:
  `f = (1 − i/40)^2.2`; colour `shade(lerpColor(accent2, accent, f), 0.34·f)`; a 2-px rect outline
  at `base.inflate(−2i, −2i)` (i.e. inset by i on each side), corner radius
  `max(2, UI_CORNER=12 − floor(i/4))`. Skip degenerate rects.
- **Outer bloom**: `pad = 26`; for `i = 26 → 1`: `f = (1 − i/26)^2.6`; colour
  `shade(lerpColor(accent2, accent, f), 0.55·f)`; 2-px outline at `base.inflate(2i, 2i)`, corner
  radius `12 + i`.

Blitted at `(rect.x − 26, rect.y − 26)` with `BLEND_RGB_ADD`.
**Pixi:** bake once into a `RenderTexture` (or draw the ~66 rounded-rect strokes into one cached
`Graphics`) per theme; a Sprite with `blendMode:"add"`. Cache limit 8 keys.

### 5.2 Live border (per frame)

`beat = pulse(t, 1.9)`.
- Edge: 2-px rounded-rect stroke of `rect`, radius 12, colour `lerpColor(accent, WHITE, 0.10 + 0.22·beat)`.
- Inner hairline: 1-px stroke of `rect.inflate(−8, −8)`, radius `max(2, 8)`, colour `shade(accent, 0.45)`.

### 5.3 Border energy (per frame)

- **Dash train**: 10 dashes marching clockwise. Per `k`: `u0 = (t·0.062 + k/10) mod 1`;
  `f = 0.35 + 0.65·(0.5 + 0.5·sin(t·2.4 + k·0.9))`; `col = lerpColor(accent2, accent, f)`;
  `dot = lerpColor(col, WHITE, 0.25·f)`. Perimeter mapping `_perimeter_point(rect, u)` (line 1222):
  u∈[0,1) clockwise from top-left, distance `u·2(w+h)` walked top → right → bottom (leftward) → left
  (upward). Each dash = two 2-px dots at `u0` and `u0 + 0.009`; **odd k only**: ADD glow radius 11,
  colour `col`, intensity `0.30 + 0.35·f` at the second dot.
- **Corner brackets**: `br = rect.inflate(−9, −9)`; `arm = clamp(min(br.w, br.h)·0.045, 16, 30)
  + floor(3·beat)`; `beat2 = pulse(t, 3.2)`; `arm2 = floor(arm·(0.52 + 0.22·beat2))`; inset 8.
  `bcol = lerpColor(accent2, WHITE, 0.22 + 0.22·beat)`;
  `bcol2 = lerpColor(accent, WHITE, 0.10 + 0.30·beat2)`. At each of the 4 corners: two 4-px lines
  (horizontal + vertical, length `arm`, pointing inward), then two 2-px lines at the 8-px inset,
  length `arm2`; plus ADD glow radius 20, colour `accent2`, intensity `0.55 + 0.25·beat`.
- **Runners**: 2 bright chasers, `u = (t·0.085 + 0.5k) mod 1`; ADD glow radius 22, `accent`,
  intensity 0.85; 3-px dot `lerpColor(accent, WHITE, 0.7)`.

### 5.4 Arena clip (lines 1249–1265)

`draw_arena` clips itself to `(rect.x − 32, rect.y, rect.w + 64, rect.h + 32)` — spill is allowed
left/right/below (intended neon bleed into the window margin) but **never above the arena top**,
because the translucent HUD strip sits there (`ARENA_Y == HUD_H == 78`). Pixi: a rect mask on the
arena-frame container with those bounds (design-space).

---

## 6. Food orbs (`draw_food_orb`, lines 1341–1467)

Called by `core/food.py` per orb with `(x, y)` = bobbing `draw_pos(t)`, `r` = animated
`draw_radius(t)` (pop-in/breathe/wither — food.py's spec), per-orb `color`, and
`kind ∈ {"normal","bonus","mega"}`. Kind tables (lines 1344–1351):

| | scale | glow gi | dots | halo (arcs, sweep, spin) | facets |
|---|---|---|---|---|---|
| normal | 1.0 | 0.70 | 4 | (2, 0.42, 0.9) | 0 |
| bonus | 1.16 | 0.95 | 6 | (3, 0.50, −1.15) | 4 |
| mega | 1.38 | 1.25 | 8 | (4, 0.58, 1.45) | 6 |

`p = pulse(t, FOOD_PULSE_SPEED = 3.4)`; `rr = max(2, r · scale · (0.94 + 0.10p))`. Draw order:

1. **Halo**: ADD glow radius `rr·(2.9 + 0.6p)`, colour `col`, intensity `gi·(0.55 + 0.35p)`.
2. **Rotating arc ring** (`_halo_arcs`, line 1354): ring radius `rr·(1.62 + 0.10p)` (skip if < 3 px),
   colour `lerpColor(col, WHITE, 0.30 + 0.25p)`, stroke width 2 (normal) / 3 (bonus, mega).
   `count` arcs; gap `TAU/count`; each spans `gap·sweep` starting at `t·spin + k·gap`.
   ⚠️ **pygame `draw.arc` angles are mathematical (y-up): increasing angle sweeps
   counter-clockwise on screen.** Canvas/Pixi `arc()` with y-down sweeps clockwise for increasing
   angle. **Negate angles** (or pass anticlockwise) so spin signs (0.9 / −1.15 / 1.45) keep their
   on-screen direction. Arcs are inscribed in the square box `(x−ri, y−ri, 2ri, 2ri)`.
3. **Orbital dots**: rings of `(orbitScale, spin, weight)` —
   mega: `(2.10, 1.25, 1.0)` and `(2.70, −0.80, 0.72)`; bonus: `(2.10, 1.10, 1.0)`;
   normal: `(1.95, 0.85, 1.0)`. Per ring, `dots` dots at `ang = t·spin + i·TAU/dots`, position
   `centre + dir(ang)·rr·orbit`, dot radius `max(1, floor(rr·0.17·weight))`; **non-normal kinds**
   add an ADD glow per dot (radius `rr·0.75·weight`, colour `col`, intensity 0.55); dot disc colour
   `lerpColor(col, WHITE, 0.45)`.
4. **Core sphere** (integer centre): disc `shade(col, 0.50)` radius `rr`; disc `col` radius
   `0.80rr`; disc `lerpColor(col, WHITE, 0.55)` radius `0.44rr`; ring `lerpColor(col, WHITE, 0.35)`
   radius `rr` width 2.
5. **Facet cage** (bonus/mega, only if `rr ≥ 5`): closed polyline, `facets` vertices at radius
   `0.94rr`, rotation `t·0.9` (bonus) / `t·0.62` (mega), width 2, colour `lerpColor(col, WHITE, 0.60)`.
   **Mega adds** a counter-rotating triangle: rotation `−t·1.05`, radius `0.52rr`, width 1, colour
   `lerpColor(col, WHITE, 0.80)`.
6. **Catchlight + refraction**: highlight at `h = (x − 0.30rr, y − 0.32rr)`: WHITE disc radius
   `max(1, floor(rr·0.20))`; ADD-blit `_flare_surface(rr·(0.85 + 0.15p), WHITE, 4)` centred on h.
   If `rr ≥ 6`: two chromatic fringe dots radius `max(1, floor(rr·0.10))` —
   `hueShift(col, +0.08)` at `(hx + 0.26rr, hy + 0.10rr)` and `hueShift(col, −0.08)` at
   `(hx − 0.18rr, hy + 0.22rr)`.
7. **Kind flare** (bonus/mega): ADD-blit `_flare_surface(rr·(2.4 + 0.5p),
   lerpColor(col, WHITE, 0.35), arms)` centred on the orb — 4 arms bonus, 6 mega.

---

## 7. pygame idiom → PixiJS v8 mapping table

| pygame idiom | Where used | PixiJS v8 equivalent |
|---|---|---|
| Cached SRCALPHA glow sprite, falloff baked in RGB, `BLEND_RGB_ADD` blit | all glows | Shared radial textures (offscreen canvas or RenderTexture, generated once per falloff shape) + pooled `Sprite` with `blendMode:"add"`, `tint`, `scale`. See `pixijs-textures`, `pixijs-blend-modes` skills |
| `BLEND_RGB_SUB` disc (contact shadow) | §4.6(a) | Advanced `"subtract"` blend (`import "pixi.js/advanced-blend-modes"`, `useBackBuffer:true`) or a custom reverse-subtract blend mode; fallback: `"multiply"` sprite of `1 − falloff·k` (Q2) |
| `BLEND_RGBA_ADD` into scratch layer + normal blit (ghost) | §4.8 | One snake `Container` + `AlphaFilter(alpha=116/255)`; glows keep `"add"` inside it |
| `pygame.draw.line(width)` + joint circles | body tube | `Graphics.moveTo/lineTo.stroke({width, cap:"butt", join:"miter"})` + `circle().fill()`; rebuild the Graphics each frame |
| `pygame.draw.polygon` filled | skull, jaw, lids | `Graphics.poly().fill()` |
| `pygame.draw.circle(width=k)` (stroke inside radius) | eye socket, orb ring | `Graphics.circle().stroke({width:k, alignment:1})` — pygame strokes **inward** from the radius |
| `pygame.draw.rect(width=2, border_radius)` outlines | arena frame | `Graphics.roundRect().stroke({width:2, alignment:1})`; bake the 66-ring frame into a `RenderTexture` once |
| `pygame.draw.arc` | orb halo arcs | `Graphics.arc(cx, cy, r, −a1, −a0)` — **negate angles** (y-down flip, §6.2); pygame arcs are 1-px-ish strokes at `width` — use `stroke({width})` |
| `surface.set_clip(rect)` | arena spill guard; gameplay snake clip | Rect mask (Graphics) on the corresponding container |
| Colour with alpha *written* by draw (uniform translucency) | ghost strokes | `AlphaFilter` on the flattened container — **not** per-child alpha |
| Insertion-order dict caches with FIFO trim | all sprite caches | `Map<string, Texture>` + trim; `Texture.destroy(true)` on evict/clear |
| Int truncation of coords (`_ip`) | everywhere | Optional; keep floats but allow tolerance in visual diffs (Q3) |

**Batching note** (`pixijs-performance` skill): interleaved normal-blend Graphics and add-blend
Sprites break batches. The snake is ~40–80 draw objects/frame if done naively as retained children.
Prefer: one `Graphics` per snake rebuilt each frame for all normal-blend geometry (passes a,b,c
strokes, plates, head, eyes) — order inside a single Graphics is the path order, which matches the
Python paint order exactly — plus a pooled Sprite list for the glows, interleaved as separate
containers only where z-order demands (aura below, spine sparkles + crossing glow between the two
Graphics halves, head glows above). Concretely, the snake container's children:
`auraSprites` → `tailGraphics` → `rearGraphics` → `shadowSprite(s)(SUB)` → `rimGraphics` →
`crossGlowSprites` → `frontGraphics` → `headGlowSprites` (streaks/exhaust/halo interleave — see Q5)
→ `headGraphics` → `eyeGlowSprites` → `eyeGraphics` → `shieldGlow/Graphics`.

---

## 8. TS mapping notes — where every input comes from

| Python reads | TS source |
|---|---|
| `theme.accent/accent2/snake_head/snake_a/snake_b`, `theme.body_at(u)` | `web/src/core/palette.ts` — `Theme.accent/accent2/snakeHead/snakeA/snakeB` (RGB triples), `bodyAt(theme,u)`; themes built from `web/src/data/themes.json`; `themeForLevel(index)` |
| `P.lerp_color / shade / hue_shift / clamp8 / UI_WHITE` | `palette.ts` — `lerpColor / shade / hueShift / clamp8 / UI_WHITE`; `toHex(rgb)` for Pixi tints |
| `contracts.clamp / lerp / dist / pulse / TAU` | `web/src/core/mathx.ts` — same names, `pulse(t, speed=1) = 0.5+0.5·sin(t·speed)`, `TAU` |
| `C.SNAKE_HEAD_RADIUS=13, SNAKE_BODY_RADIUS=11, SNAKE_TAIL_RADIUS=5, SNAKE_SEGMENT_SPACING=13` | `web/src/core/config.ts` (same names; values loaded from `web/src/data/config.json`) |
| `C.SNAKE_BASE_SPEED=210, SNAKE_MAX_SPEED=460, SNAKE_BOOST_MULT=1.85` | `config.ts` |
| `C.SELF_COLLISION_SKIP=16, FOOD_PULSE_SPEED=3.4, UI_CORNER=12, ARENA_RECT, HUD_H=78` | `config.ts` |
| `snake.head_pos()/segments/radius_at(i)/heading/turn_input/boosting/current_speed/crossing_self()/invuln` | `web/src/core/snake.ts` — `headPos(): Vec2 {x,y}`, `segments: Vec2[]`, `radiusAt(i)`, `heading`, `turnInput`, `boosting`, `currentSpeed`, `crossingSelf()`, `invuln`. **Note `Vec2` is `{x,y}` objects, not tuples** |
| `t` (animation clock) | gameplay scene clock (`clock_t`); hazards use a separate `hazard_t` — both owned by the scene port |
| `ghost` / `shield` flags | gameplay's ActiveEffects port (`core/powerups.ts` when it lands): `effects.has("ghost"|"shield")` |
| Pixi API refs | `web/node_modules/pixi.js/skills/` — `pixijs-scene-graphics`, `pixijs-blend-modes`, `pixijs-filters`, `pixijs-textures`, `pixijs-performance` |

Duck-typing fallbacks in the Python (`_attr`, `_body_color` fallback, `_crossing_flag` handling
method-vs-property, the radius taper fallback) exist because Python entities are duck-typed. The TS
port has real types — **drop the fallbacks, keep asserts** (§9).

---

## 9. Invariants & performance notes

Assert (dev builds):
- `pts.length === radii.length === n ≥ 1`; all radii ≥ 1.5 and finite.
- `pts[0]` equals `snake.headPos()` exactly (banking must never move index 0 — `ramp(0) = 0`).
- Crossing list length ≤ 3; every `f < SELF_COLLISION_SKIP` and even; `0 < depth ≤ 1`.
- `bodyAt(theme, 0) === theme.snakeA`, `bodyAt(theme, 1) === theme.snakeB`.
- Glow texture cache size stays ≤ limits; no texture is created after the first few seconds on an
  unchanging theme (Python's stated goal: ~400 glow blits/frame, zero allocations).

Performance-critical (things Python caches because they are expensive):
- **Glow/disc/flare sprites** — never rebuild per frame. In Pixi, textures + pooled sprites; reuse
  sprite instances across frames (retained mode), update `position/scale/tint/alpha/visible`.
- **Arena frame** (66 rounded-rect strokes) — bake per theme into a RenderTexture.
- Snake geometry arrays (`pts/normals/curv/lean/cols/rims`) — reuse preallocated arrays; n can be
  ~100–400 segments (`SCALE_PLATE_TARGET` and aura subsampling exist precisely to keep per-frame
  cost flat in n; keep the `step = n//24` aura subsample and `plate_step`).
- One `Graphics` rebuild per frame per snake is fine in v8 (`pixijs-scene-graphics` skill:
  clear+redraw beats many small Graphics); avoid per-segment display objects.
- `cols[i]` per frame calls `bodyAt` n times — cheap, but can be cached per (theme, n).

---

## 10. Proposed module boundaries

- `web/src/gfx/glow.ts` — texture factory + cache (`glowTexture`, `discTexture`, `flareTexture`),
  bucketing identical to Python (§1.3), `clearCaches()`, plus a `GlowPool` of add-blend sprites
  with `stamp(container, x, y, radius, rgb, intensity, blend)`.
- `web/src/gfx/render.ts` — `drawArena(container, rect, theme, t)` (owns the cached frame texture),
  `drawFoodOrb(g, glows, x, y, r, color, t, kind)`.
- `web/src/gfx/snakeRenderer.ts` — `class SnakeRenderer { container; draw(snake, theme, t, opts:
  {ghost, shield, crossing?}) }` owning the child stack of §7 and the AlphaFilter toggle.
- Exported constants mirroring Python's `__all__`: `GHOST_ALPHA=116, BANK_STRENGTH=0.34,
  BANK_RAMP=4, FRONT_SPAN=9, MAX_CROSSINGS=3, SCALE_PLATE_TARGET=26,
  SHADOW_COLOR=[104,116,146], EXHAUST_COLOR=[255,196,96]`.

---

## 11. Open questions (do not guess silently)

- **Q1 — Glow bucket quantisation vs smooth tint/scale.** Python quantises radius (2.5 px),
  intensity (eighths) and colour (4 bits/channel) into cache buckets, so animated glows step
  slightly. A tinted/scaled shared texture animates smoothly. Is "smoother than Python" acceptable,
  or must the verifier see bucket-identical output?
- **Q2 — Subtractive contact shadow.** Advanced `"subtract"` needs `useBackBuffer: true` on the
  whole renderer (cost applies to every frame, not just crossing frames). Accept that, register a
  custom reverse-subtract GPU blend mode, or approximate with multiply? Needs a decision +
  screenshot comparison on a crossing.
- **Q3 — Integer truncation.** pygame truncates all draw coords/widths to ints (`_ip`, `int()` on
  widths/radii). Match exactly (for pixel-diff testing) or keep float-precision rendering (nicer at
  DPR > 1)? Recommend floats + perceptual diff.
- **Q4 — The stale-`r` plate quirk** (§4.3d): plate size/width/visibility gates use `radii[i_to]`
  (the range's head-most radius), not the per-plate radius — almost certainly an unintended capture,
  but it is what ships and it subtly changes plate appearance near the tail. Port as-is, or fix and
  accept the visual delta? Default: port as-is.
- **Q5 — Glow/geometry interleave granularity.** Within `_draw_head`, glows (halo, specular, eye
  glows) interleave with fills at fine granularity (halo under skull, specular over skull, eye glow
  under sclera). A faithful port needs either many tiny containers (batch-breaking) or accepting
  approximate z-order (e.g. all head glows under all head geometry except the specular). Propose:
  three head layers (glows-under, geometry, glows-over{specular}) and verify by screenshot.
- **Q6 — `pulse` in the shield vertex flicker** uses `pulse(t*6 + i*1.05)` (speed defaulted to 1) —
  i.e. phase-offset, not frequency-offset. Confirm the TS `pulse(t, speed=1)` default matches
  (it does in `mathx.ts:74`); just don't "fix" it to `pulse(t, 6)`.
- **Q7 — Scope gap flagged to the orchestrator:** the hazard visuals named in this assignment
  (walls, sweepers/MovingBar, tidal columns, spinners, pulsars, laser gates, portals) are drawn by
  their classes in `snake/core/obstacles.py` (draw methods per class; `draw_obstacles` at line 1077
  orders portals below other hazards), not by `render.py`. They need their own spec pass of the
  same depth. Likewise power-up runes (`snake/core/powerups.py`) and the food manager's
  position/radius animation (`snake/core/food.py`).
