# Port spec — `snake/gfx/particles.py` → TypeScript + PixiJS v8

Ground truth: `E:/SnakeGame/snake/gfx/particles.py` (do not modify).
Target: a new `web/src/gfx/particles.ts` module (name at implementer's discretion,
but keep it a single self-contained module mirroring the Python file).

This module is the additive particle system for the whole game: snake slither
trail, boost trail, pickup bursts, power-up bursts, portal/shockwave rings,
ambient motes, cross-over wash, shield/hit/death explosions, victory
confetti/fireworks/star-ceremony, game-over ember rain, menu weather and the
menu demo-snake wake. Every scene shares **one global `ParticleSystem`
instance** owned by the `Game` object (`snake/main.py:101`), updated once per
frame after the scene stack (`snake/main.py:413`), and *drawn* by whichever
scene calls `game.particles.draw(surface)`.

---

## 1. Coordinate space, ownership, lifecycle

- All positions are **design-space pixels** (1280×720, `C.WINDOW_W`/`C.WINDOW_H`).
  Particles are drawn onto the design-resolution canvas *before* post-processing
  and the final scale-to-window. In the web app this means the particle
  display objects live under the scaled world root (`web/src/app/Game.ts`),
  never in raw screen space. Overscan is irrelevant to particles: culling uses
  the 1280×720 surface size + a 140 px margin (see §7).
- **Single instance**: `Game.__init__` creates `ParticleSystem(C.MAX_PARTICLES)`
  (`MAX_PARTICLES = 1400`, `web/src/core/config.ts` exports it).
- **Update**: `Game.update` calls `particles.update(dt)` once per frame with the
  *wall-clock* dt already clamped to `MAX_DT = 1/20` (`main.py:482–489,413`).
  Note carefully: gameplay slow-motion (`fx.slowmo`) scales the *scene's* dt
  (`sdt`) used for **emission** calls, but particle **physics** always runs on
  unscaled dt. Preserve this: during slow-mo, existing particles keep moving at
  full speed while emission thins out.
- **Draw**: each scene decides when in its own draw order to composite the
  particles (see §9 for per-scene order). A scene that doesn't call `draw`
  simply doesn't show them.
- **Clear**: `particles.clear()` on scene transitions (gameplay `on_enter`
  and restart, game-over/victory `on_enter` and `on_exit`). Clearing recycles
  records into the pool.

Because the instance is shared, the PixiJS port cannot simply parent one
container per scene. Recommended: the `ParticleSystem` owns a single
`Container` (glow sprites) + one `Graphics` (geometry) and exposes
`attachTo(parent: Container)` / `detach()`; the active scene re-parents it at
the right z-position each `on_enter`, and gameplay additionally applies an
arena mask (§9.1).

---

## 2. Architecture summary (what the Python does)

1. A flat array of pooled `Particle` records (`__slots__` class), hard-capped
   at `max_particles` (default 1400, floor 16). When full, the **oldest**
   particles (front of the array) are evicted into the free pool
   (`_acquire`, lines 383–394; eviction count = `len(items) - max + 1`).
   Dead records are recycled; pool capacity = `max_particles`.
2. Soft ("blob") particles are drawn by blitting a **pre-rendered glow
   sprite** with `pygame.BLEND_RGB_ADD`. Sprites are cached by
   `(radiusBucket, qR, qG, qB)` where the colour is quantised to 10 levels per
   channel **with the current fade already multiplied in** — because
   `BLEND_RGB_ADD` ignores alpha, "dimming" a particle means "add a darker
   colour". Nothing is rasterised per-particle per-frame.
3. Geometry particles (`spark`, `shard`, `ring`, `trail`, `bolt`, `star`) are
   vector-drawn into one reusable full-size black scratch surface, clipped to
   the dirty bounding box of just those particles, then composited **once**
   with `BLEND_RGB_ADD`. This makes the geometry pass sit **on top of all
   blob particles** regardless of spawn order (spec-relevant layer rule).
4. Two per-particle animators: `color_end` (linear colour ramp birth→death)
   and `turbulence` (cheap curl-noise drift).
5. Everything is exception-swallowing: a bad value degrades to a missing
   particle, never a crash. Port the *validation* (finite checks, clamps),
   not the blanket try/except.

---

## 3. Particle record (state)

Fields of `Particle` (lines 262–324) — the TS port should use a plain
struct-of-fields class (or SoA arrays, implementer's choice) with identical
semantics:

| field | meaning | set at spawn |
|---|---|---|
| `x, y` | position (design px) | spawn args |
| `px, py` | previous frame position (used by `trail` ribbon) | = x, y at spawn |
| `vx, vy` | velocity px/s | spawn args |
| `radius` | current draw radius | `max(0.5, radius)` |
| `r0` | birth radius (shrink baseline; updated by `grow`) | = radius |
| `color` | birth RGB (ints 0–255) | clamped via `clamp8` |
| `color_end` | optional death RGB (null = no ramp) | optional |
| `life` | seconds remaining | `max(0.01, life)` |
| `max_life` | initial life (fade denominator), min `1e-6` | = life |
| `drag` | drag coefficient (see §5) | spawn arg |
| `gravity` | px/s² added to `vy` | spawn arg |
| `glow` | halo on/off (false ⇒ tighter sprite, §7) | default true |
| `shrink` | radius eases down over life (§7) | default true |
| `spin` | rad/s rotation — **except for `ring`, where it carries the stroke-width fraction** | default 0 |
| `angle` | current rotation, initialised `uniform(0, TAU)` | random |
| `grow` | px/s radius growth (rings, smoke) | default 0 |
| `kind` | one of the 9 kinds below; unknown → `"dot"` | default `"dot"` |
| `seed` | `uniform(0, TAU)` — phase for twinkle/bolt/turbulence | random |
| `turbulence` | curl drift strength px/s² | default 0 |

`spawn()` rejects any non-finite input (sums all numeric args and checks one
`isfinite`) and returns null instead of throwing.

### Kinds

| kind | draw primitive | soft glow core underneath? |
|---|---|---|
| `dot` | glow sprite blit | (is the sprite) |
| `ember` | glow sprite blit, brightness × twinkle sine | (is the sprite) |
| `smoke` | glow sprite blit, quadratic dim (§7) | (is the sprite) |
| `spark` | line streak on geometry layer | yes (`glow_sprite(r*0.9, col, fade*0.55)`) |
| `shard` | spinning irregular triangle | yes (same core rule) |
| `bolt` | 3-segment jagged lightning | yes (same core rule) |
| `star` | 8-vertex four-point twinkle polygon | yes (same core rule) |
| `ring` | hollow stroked circle | **no** (`_NO_CORE_KINDS`) |
| `trail` | tapered ribbon quad between (px,py)→(x,y) | **no** |

---

## 4. Glow sprite cache — exact math

This is the fidelity-critical piece. Python (`_build_glow`, lines 134–168):

- **Radius bucketing** (`_bucket_radius`):
  - `r ≤ 2` → 2
  - `r < 16` → `int(r + 0.5)` (1 px steps)
  - `r < 40` → `int(r*0.5 + 0.5) * 2` (2 px steps)
  - else → `min(120, int(r*0.25 + 0.5) * 4)` (4 px steps, capped 120)
- **Colour quantisation**: 10 levels/channel; `step = 255/9 ≈ 28.3333`;
  `q = round(min(255, v*fade) / step)` per channel (0 if v ≤ 0). A key that
  quantises to (0,0,0) draws **nothing** (adds no light). Cache key =
  `(radiusBucket, qR, qG, qB)`. De-quantised colour = `clamp8(q * step)`.
- **Cache cap**: at 768 entries the whole cache is discarded and rebuilt
  lazily. (In practice a level uses low hundreds.)
- **Sprite build** for `(radius=rb, color=c)`:
  - `ext = max(2, floor(rb * 2.0 + 2.5))` — sprite half-size ( `_GLOW_EXTENT
    = 2.0`, `_GLOW_PAD = 2.5`); texture is `(2*ext)²`, black background,
    **no alpha channel**.
  - `core = clamp(rb / ext, 0.05, 0.95)` — fully-lit fraction.
  - 12 concentric bands (`_GLOW_BANDS`), drawn outer→inner: for band `b` in
    `12..1`, `q = b/12`; intensity `inten = 1` if `q ≤ core` else
    `(1 - (q-core)/(1-core))²`; band colour `shade(c, inten)` (channel × inten,
    clamped); circle radius `max(1, floor(ext*q))`. Skip pure-black bands.
  - Hot centre: colour `lerp_color(c, WHITE, 0.45)`, radius
    `max(1, floor(rb * 0.45))`.
- The **fade is baked into `c` before the build** (colour already multiplied
  by brightness). Consequence worth preserving: the hot centre is
  `lerp(fadedColour, white, 0.45)` — a dim particle *still has a
  noticeably bright whitish core*. This is **not** reproducible with a single
  white radial texture × tint × alpha, because tinting scales the white core
  down with everything else.

### PixiJS v8 mapping (recommended)

Replicate the cache exactly: generate each `(bucket, qR, qG, qB)` sprite
on demand into an **OffscreenCanvas/canvas 2D** (or a `RenderTexture` drawn
with `Graphics`), using the identical band loop, and wrap it in a
`Texture.from(canvas)`. Keep the same `Map<string, Texture>` keyed by
`"${rb},${qr},${qg},${qb}"`, the same 768-entry flush, and a
`clearGlowCache()` for context loss. Sprites then need **no tint and
alpha = 1**; blend mode `'add'`. Texture generation is a one-off per key,
identical cost profile to pygame.

Rejected cheaper alternative (flag if you take it): one white radial texture
+ `tint = quantisedColour` + ADD. This loses the white-hot core behaviour and
the band-quantised falloff; visibly different on dim/large particles.

Sprite placement: pygame blits at `(int(x - w/2), int(y - w/2))` — top-left
integer snap. In Pixi set `anchor 0.5` and position at `(floor(x - w/2) + w/2,
…)` or simply `(x, y)`; the sub-pixel difference is below perceptual
threshold, but note it if bit-comparing screenshots.

---

## 5. `update(dt)` — exact simulation step (lines 799–851)

Guard: `dt ≤ 0` → return; `dt > MAX_DT (1/20)` → clamp. Accumulate internal
clock `_t += dt` (used by turbulence, ember twinkle, bolt flicker).

Per particle, in this order:

1. `life -= dt`; if `life ≤ 0` recycle to pool (if pool below cap) and drop.
2. Drag (dt-stable exponential-ish): if `drag > 0`:
   `f = 1 / (1 + drag*dt)`; `vx *= f; vy *= f`.
3. Gravity: `vy += gravity * dt`.
4. Turbulence (curl-like, rotational): if `turbulence ≠ 0`, with
   `k = turbulence * dt` and system time `t`:
   - `vx += sin(y*0.017 + t*1.30 + seed) * k`
   - `vy += cos(x*0.017 - t*1.10 + seed) * k`
   (x-acceleration depends only on y and vice versa — keep exactly.)
5. `px = x; py = y;` then `x += vx*dt; y += vy*dt`.
6. Spin: if `spin ≠ 0` **and kind ≠ "ring"**: `angle += spin*dt`.
7. Grow: if `grow ≠ 0`: `radius += grow*dt; r0 = radius` (grow overrides the
   shrink baseline every frame).

Survivors are compacted into a fresh array (order preserved — oldest first,
which is what makes cap-eviction "oldest dies first").

---

## 6. Emission helpers

- `_emit_count(rate, dt)`: `n = rate*dt`; emit `floor(n)` plus one more with
  probability `frac(n)`; hard cap **64 per call** (monster-dt guard).
  Stochastic remainder, *no* per-caller accumulator — keep this (it affects
  the statistical look of thin trails).
- `_rng_range(v)`: scalar passes through; `[lo, hi]` → `uniform(lo, hi)`
  (returns `lo` when `hi ≤ lo`).
- `hot_white(color, amount=0.7)` = `lerp_color(color, WHITE, clamp(amount,0,1))`
  — exported helper, used by `explosion`, `spark_line`, `implode`.

---

## 7. `draw()` — blob pass, exact math (lines 869–946)

For every live particle (iteration order = age order, oldest first):

1. **Cull**: skip if outside surface bounds inflated by `margin = 140` px
   (surface = 1280×720 design canvas).
2. `fade = min(1, life / max_life)` (1 at birth → 0 at death).
3. **Shrink**: `r = shrink ? r0 * (0.34 + 0.66*fade) : r0`; skip if
   `r < 0.5`; write `p.radius = r` (geometry pass reads this).
4. If kind is geometry (`spark shard ring trail bolt star`): push to the
   geometry list; if kind not in {`ring`,`trail`}, also blit a **soft core**
   under it: `glow_sprite(r * 0.9, currentColour, fade * 0.55)`. Continue.
5. Blob brightness `bright = fade`, then per kind:
   - `ember`: `bright *= 0.62 + 0.38 * sin(t*11.0 + seed)` (t = system clock;
     range 0.24–1.0).
   - `smoke`: `bright *= fade * 0.34` (i.e. total ∝ fade²·0.34); skip if
     `bright < 0.012`.
6. If `glow == false`: `r *= 0.58` (tighter sprite reads as a hard point);
   skip if `r < 0.5`.
7. Current colour: `color` if no `color_end`, else `_blend_color(p, fade)` =
   linear lerp `color → color_end` by `u = 1 - fade` (floats, no clamp8 until
   quantisation).
8. Sprite = cache lookup with key from §4 using `col * bright`; skip if
   quantised black. Blit centred with ADD blend.

`_blend_color` (lines 327–347): `u ≤ 0` → birth colour; `u ≥ 1` → end colour;
else per-channel `a + (end-a)*u`.

---

## 8. Geometry pass, exact math (`_draw_geometry`, lines 948–1102)

Pygame trick: one full-size black scratch surface, cleared **only inside the
dirty bbox** of this frame's geometry particles, clip-rect set, primitives
drawn opaque, then the dirty rect composited once with `BLEND_RGB_ADD`.

**PixiJS mapping**: one shared `Graphics`, `clear()` per frame, `blendMode =
'add'`, z-order **above** the blob sprite container. The dirty-rect dance is
a pygame CPU optimisation with no GPU equivalent needed — drop it. (The bbox
padding math, lines 963–988, exists only for that optimisation; skip it, but
keep the *culling margin* from the blob pass? No — Python does **not** cull
geometry to bounds beyond the blob-pass margin: geometry particles were
already margin-culled in step 1 of §7 before being listed. Replicate that.)

Per geometry particle:

- `fade = min(1, life/max_life)`; colour
  `col = shade(_blend_color(p, fade), fade)` — i.e. the colour ramp **then**
  multiplied by fade and clamp8'd. Skip if black. `r = p.radius` (already
  shrink-adjusted this frame by the blob pass).
- **`spark`** — velocity streak: `sp = hypot(vx, vy)`; skip if `< 1`;
  `tail = clamp(sp * 0.05, 6, 34) / sp`; line from `(x, y)` to
  `(x - vx*tail, y - vy*tail)`, width `1` if `r < 2.6` else `2`.
- **`shard`** — irregular spinning triangle: `a = angle`, `s = r * 1.9`;
  filled polygon of
  `(x + cos(a)·s, y + sin(a)·s)`,
  `(x + cos(a+2.42)·s·0.66, y + sin(a+2.42)·s·0.66)`,
  `(x + cos(a−2.42)·s·0.82, y + sin(a−2.42)·s·0.82)`.
- **`trail`** — tapered ribbon: `dx = x−px, dy = y−py, d = hypot`;
  if `d < 0.6` draw a filled circle radius `max(1, floor(r))` instead
  (stub so the ribbon never vanishes at an arc apex). Else extend the tail:
  `ex = px − dx*0.9, ey = py − dy*0.9`; unit normal `n = (−dy/d, dx/d)`;
  head half-width `hw = r*0.85`, tail half-width `tw = r*0.12`; filled quad
  `(x±n·hw)` at the head, `(e∓n·tw)` at the tail (vertex order:
  `x+n·hw`, `x−n·hw`, `e−n·tw`, `e+n·tw`).
- **`bolt`** — 3 chained segments: `a = angle`,
  `ln = clamp(r*4, 8, 54)`, direction `(ca, sa)`, normal `(−sa, ca)`,
  width `1` if `r < 3.4` else `2`. From `(x, y)`, for `i = 1..3`:
  `f = i/3`; `kink = sin(seed*5.7 + i*2.1 + t*34.0) * ln * 0.26 * (1 − f*0.5)`
  (t = system clock — this is what makes bolts flicker frame to frame);
  endpoint `(x + ca·ln·f + nx·kink, y + sa·ln·f + ny·kink)`; line segment from
  the previous point.
- **`star`** — four-point twinkle: 8 vertices, `ang = angle + i·π/4`
  for `i = 0..7`, radius `hi = r*2.6` on even i, `lo = r*0.42` on odd i;
  filled polygon.
- **`ring`** — hollow shockwave: `rr = floor(r)`; skip if `< 2`;
  stroke fraction `frac = spin` if `0.02 ≤ spin ≤ 0.5` else `0.10`
  (**`spin` is overloaded as stroke width for rings**); stroke width
  `max(1, floor(rr * frac * (0.4 + 0.6*fade)))`, clamped to `rr − 1`;
  stroked circle radius `rr` centred `(x, y)`. (Ring radius growth comes from
  `grow` in update; the ring *thins* as it fades.)

Pygame primitives are aliased 1–2 px lines/polys; Pixi Graphics will
anti-alias. Accept the difference (it looks better), but keep the width
thresholds exact. Coordinates are `int()`-truncated in Python; do not bother
truncating in Pixi (sub-pixel, imperceptible under the CRT filter chain).

---

## 9. Emitter APIs — exact parameters

All colour args accept RGB tuples; all `Ranged` args accept scalar or
`[lo, hi]`. All counts are clamped as noted. Every method is fire-and-forget.

### 9.1 `spawn(x, y, …)` (lines 397–432)
Defaults: `vx=vy=0, radius=3, color=white, life=0.8, drag=1.6, gravity=0,
glow=true, shrink=true, spin=0, kind="dot", grow=0, color_end=null,
turbulence=0`. Validation per §3.

### 9.2 `burst(x, y, color, …)` (lines 434–482) — pickup/death explosions
Defaults: `count=18, speed=(40,190), life=(0.35,0.9), radius=(2,5),
spread=null, direction=null, glow=true; color_end=null, turbulence=0,
gravity=0, kind=null`.
- Direction logic: `direction==null` → `base=0`, `half = spread==null ? π :
  spread/2`, `omni = (spread==null)`. Else `base=direction`,
  `half = (spread==null ? 0.9 : spread)/2`, `omni=false`.
- `n = clamp(count, 0, 400)`. Angle: omni → `(i/n)·TAU + U(−0.22, 0.22)`
  (even spacing + jitter, no clumps); else `base + U(−half, half)`.
- `sp = ranged(speed)` then `sp *= clamp(1.25 − 0.10*r, 0.35, 1.25)` — small
  particles fly further (hot core + fast outriders).
- Kind: explicit `kind` if given, else `"spark"` when `glow && i % 4 == 0`,
  else `"dot"`.
- Per particle: `drag = U(1.4, 2.6)`, `spin = U(−7, 7)`, life/radius from
  ranges, plus pass-through gravity/color_end/turbulence.

### 9.3 `trail(x, y, color, dt, …)` (lines 484–519) — head wake / cross-wash
Defaults: `rate=TRAIL_EMIT_RATE (46/s), spread=0.9, speed=(8,44),
life=(0.25,0.6), radius=(2,5); color_end=null, turbulence=0, ribbon=0`.
- Emit `_emit_count(rate, dt)` particles. Per particle: `ang = U(0, TAU)`;
  origin jitter `(x + cos(ang)·spread·3, y + sin(ang)·spread·3)`;
  kind roll: `< ribbon` → `"trail"`, `< ribbon + 0.22` → `"ember"`, else
  `"dot"`; velocity along `ang` at `ranged(speed)`; `drag = 2.2`.

### 9.4 `ring(x, y, color, …)` (lines 521–549) — shockwave
Defaults: `radius=40, count=26, life=0.6, speed=120; color_end=null,
width=0.10`. `life = max(0.05, life)`.
- One **wave** particle: `radius = max(2, radius·0.12)`, `drag=0`,
  `shrink=false`, `kind="ring"`, `grow = max(0,radius)/life` (reaches target
  radius exactly at death), then `wave.spin = clamp(width, 0.02, 0.5)`
  (stroke fraction, see §8 ring).
- `n = clamp(count, 0, 200)` **outriders**: evenly spaced `ang = (i/n)·TAU`
  (no jitter), spawned at offset `radius·0.18` along `ang`, velocity
  `ang · speed`, `radius U(2,4)`, `life · U(0.6, 1.1)`, `drag=2.4`,
  default kind `"dot"`.

### 9.5 `spark_line(x1, y1, x2, y2, color, …)` (lines 551–592)
Defaults: `count=12, life=0.4; color_end=null, bolts=0`. **No current
call sites** (kept for laser gates / self-collision flashes) — port it anyway.
- Unit normal `n` of the segment (`(0,−1)` for a degenerate one).
- `n_ = clamp(count, 0, 200)` sparks: `t = (i + rand())/max(1,n_)`; point on
  segment; `side = ±1` (coin flip); `sp = U(50, 180)`; velocity
  `n·side·sp + U(−30,30)` per axis; `radius U(1.8, 3.4)`;
  `life = max(0.05, life) · U(0.6, 1.2)`; `drag = 3`; `kind "spark"`.
- `clamp(bolts, 0, 40)` bolts at random `t` on the line: `radius U(3,6)`,
  colour `hot_white(rgb, 0.5)`, `color_end = end ?? rgb`,
  `life · U(0.4, 0.8)`, `drag = 6`, `shrink=false`, `kind "bolt"`.

### 9.6 `ambient(rect, color, dt, …)` (lines 594–624) — atmosphere motes
Defaults: `rate=6; turbulence=0, twinkle=0`. No-op if rect w or h ≤ 1.
- Per emitted particle: kind roll `< twinkle` → `"star"`,
  `< twinkle + 0.08` → `"shard"`, else `"dot"`; position uniform in rect;
  `vx = U(−14, 14)`, `vy = U(−22, −4)` (rises); `radius U(1.6, 3.6)`;
  `life U(2, 5)`; `drag 0.25`; `shrink=false`; `spin U(−1.6, 1.6)`;
  turbulence pass-through.

### 9.7 `explosion(x, y, color, power=1, smoke=true, gravity=0)` (627–697)
Layered detonation; **no current call sites** — port anyway (it is the
designed one-call bang; scenes may adopt it). `pw = clamp(power, 0.15, 4)`;
`hot = hot_white(rgb, 0.72)`; `dark = shade(rgb, 0.06)`.
1. `ring(x, y, hot, radius=64·pw, count=int(8·pw), life=0.34+0.16·pw,
   speed=150·pw, color_end=rgb, width=0.09)`.
2. Shards `n = clamp(9·pw, 3, 46)`: even angles + `U(−0.3,0.3)`,
   `sp U(120,340)·pw`, `radius U(2.4,5.2)·(0.7+0.3·pw)`, colour hot→dark,
   `life U(0.35,0.75)·(0.8+0.3·pw)`, `drag 2.2`, kind `"shard"`,
   `spin U(−10,10)`, `turbulence 40`.
3. Embers `n = clamp(15·pw, 6, 70)`: random angle, `sp U(30,210)·pw`,
   `radius U(1.8,4.2)`, hot→dark, `life U(0.5,1.3)`, `drag 1.7`,
   kind `"ember"`, `turbulence U(30,95)`.
4. Smoke (if enabled) `n = clamp(6·pw, 2, 26)`: `sp U(10,70)·pw`,
   `r U(7,15)·(0.7+0.4·pw)`, colour `shade(rgb,0.5)` → black,
   `life U(0.7,1.5)`, `drag 1.1`, `shrink=false`, `grow = r·1.4`,
   kind `"smoke"`, `turbulence U(10,40)`.
5. Bolts `int(clamp(2·pw, 1, 8))`: `sp U(60,180)·pw`, `radius U(4,8)·pw`,
   hot→rgb, `life U(0.10,0.22)`, `drag 5`, `shrink=false`, kind `"bolt"`.

### 9.8 `confetti(rect, colors, count=70, life=(1.6,3.4), gravity=240, from_top=true)` (699–733)
**No current call sites** (VictoryScene hand-rolls its shower, §10.6) — port
anyway. Palette fallback `[UI_GOLD, UI_WHITE, UI_GOOD]`; colour cycles
`i % len(pal)`; `n = clamp(count, 0, 400)`; x uniform in rect; y
`rect.y − rand()·h·0.45` if from_top else uniform; `vx U(−70,70)`,
`vy U(20,130)`, `radius U(2.6,5.4)`, `color_end = shade(col, 0.25)`,
`drag 0.55`, gravity arg, `shrink=false`, `spin U(−9,9)`,
`turbulence U(20,70)`, kind `"star"` when `i % 5 == 0` else `"shard"`.

### 9.9 `stream(x, y, angle, color, dt, …)` (735–761) — directed jet
Defaults: `rate=90, speed=(140,300), spread=0.30, life=(0.25,0.6),
radius=(2,4.5), color_end=null, turbulence=0, drag=1.4`.
Rate-based like `trail`. `ang = angle + U(−spread/2, spread/2)`; kind
`"spark"` with probability 0.3 else `"dot"`.

### 9.10 `implode(x, y, color, radius=90, count=26, life=0.5, swirl=1.1, color_end=null)` (763–796)
**No current call sites** — port anyway. `end = color_end ?? hot_white(rgb, 0.8)`;
`rad = max(4, radius)`; `lf = max(0.08, life)`; `n = clamp(count, 0, 240)`.
Per particle: `ang = (i/max(1,n))·TAU + U(−0.12, 0.12)`; `r = rad·U(0.82,1.12)`;
`inward = −r/lf`; `tang = swirl·r/lf`; start at circle point; velocity
`(ca·inward − sa·tang, sa·inward + ca·tang)` — lands dead-centre at expiry
(drag 0); `radius U(2,4)`; `life = lf·U(0.85, 1.0)`; `shrink=false`;
kind `"trail"` (ribbons spiralling in).

---

## 10. Who triggers what (call-site census)

### 10.1 `main.py` (Game)
- Owns the instance; `particles.update(dt)` after all scenes each frame.

### 10.2 `scenes/gameplay.py` — the big one
Draw order (`_draw`, lines 1174–1225): background → arena → obstacles → food
→ runes → **[clip to arena rect: snake → `particles.draw`]** → popups → HUD →
pause button → READY/GO. **Particles are clipped to the arena rectangle**
(intersected with any existing clip). PixiJS: apply a rectangular mask (or
`cullArea`+mask) over the particle container while gameplay owns it.
- `on_enter`/restart: `particles.clear()` (lines 491, 497).
- **Slither trail** (`_emit_trail`, 664–680, every sim frame with scaled sdt):
  - normal: `trail(bx, by, theme.snake_a, dt, rate=46, speed=(8,44))`
  - boosting: colour `lerp_color(theme.accent2, WHITE, 0.30)`,
    `rate = 46·2.3 = 105.8`, `speed=(30,110)`
  - emit point is `0.6·SNAKE_HEAD_RADIUS` *behind* the head along heading.
  - plus `ambient(arenaRect, theme.grid, dt, rate=3.0)` every frame.
- **Cross-over feedback** (`_cross_feedback`, 686–751): while crossing,
  `trail(head, col, dt, rate=62, spread=TAU/2, speed=(14,78),
  life=(0.16,0.40), radius=(2,4.5))` with
  `col = lerp_color(theme.accent2, UI_WHITE, 0.42)`; on crossing onset
  (0.55 s cooldown): `ring(head, col, radius=38, count=12, life=0.30,
  speed=95)`.
- **Rune pickup** (781–783): `burst(rune, powerup_color(kind), count=30,
  speed=(70,260), life=(0.4,1.0))` + `ring(rune, col, radius=74, count=26,
  life=0.55)`.
- **Food eaten** (`_eat`, 833–840): colour from `food_color(kind, theme, t)`
  (fallback `theme.food`); special (non-"normal") vs normal:
  `burst(count=34/20, speed=(60,300)/(40,190), life=(0.35,1.0))`,
  `ring(radius=76/46, count=24/16, life=0.55/0.42)`.
- **Wrap teleport** (`_wrap`, 934–936): `burst(exit, theme.accent, count=14,
  speed=(50,170), life=(0.2,0.5))` + `ring(entry, accent, radius=42,
  count=14, life=0.35)`.
- **Portal** (950–953): `ring(in, theme.accent2, r=70, count=22, life=0.5)`,
  `ring(out, theme.accent, r=86, count=26, life=0.55)`,
  `burst(out, accent2, count=22, speed=(60,240), life=(0.3,0.8))`.
- **Shield absorb** (976–978): `ring(head, powerup_color("shield"), r=140,
  count=40, life=0.7, speed=190)` + `burst(count=26, speed=(80,300),
  life=(0.3,0.8))`.
- **Hit** (1003–1005): `burst(head, theme.hazard, count=46, speed=(90,380),
  life=(0.35,1.1), radius=(2,6))` + `ring(r=120, count=30, life=0.6)`.
- **Death** (1017–1019): additional `burst(head, theme.snake_a, count=70,
  speed=(60,430), life=(0.5,1.4), radius=(2,7))`.

### 10.3 `scenes/menu.py`
Draw: particles drawn after background + demo snake, before UI (line 606).
- Ambience (461–478): `ambient(fullWindow, lerp(accent, accent2, 0.5), dt,
  rate=9, turbulence=0.12, twinkle=0.3)`; plus a "weather" ring every
  `2.9 · U(0.8, 1.3)` s at `x = W/2 ± U(300, 520)`, `y = U(180, H−120)`:
  `ring(theme.accent2, radius=U(40,90), count=14, life=1.1, speed=70,
  color_end=theme.accent)`.
- Demo snake wake (551–554): `trail(head, theme.snake_a, dt, rate=22,
  speed=(6,30), life=(0.3,0.75), radius=(1.6,3.6), ribbon=0.3,
  color_end=theme.snake_b)`.
- Hairpin sparks (563–568): when `|turn_input| > 0.65`,
  `stream(head, heading ± π/2 [outside of turn], theme.accent2, dt, rate=26,
  speed=(50,130), spread=0.5, life=(0.18,0.4), radius=(1.4,3.0))`.

### 10.4 `scenes/mode_select.py`
- Ambient full-window, colour `lerp(accent, accent2, 0.5)`, `rate=7` (639–642).
- Launch flourish: `burst(cardCenter, theme.accent, count=26)` (497–498;
  all other args default).
- Draw: bg → particles → header/cards (688).

### 10.5 `scenes/level_select.py`
- On choosing a level: `burst(cardCenter, level.theme.accent, count=30,
  speed=(90,320), life=(0.35,0.85))` (541–542).

### 10.6 `scenes/gameover.py`
Shared base (`_ResultsScene`): `particles.clear()` on enter and exit; draw:
bg → veil → **particles** → panel/body → buttons (605).
- **GameOverScene ember rain** (`_emit`, 746–774): accumulator at 13/s
  (deterministic accumulator, *not* `_emit_count`): direct `spawn` of falling
  embers across the top: x `U(−20, W+20)`, y `U(−40, −4)`, `vx U(−9,9)`,
  `vy U(14,34)`, radius `U(1.8,3.6)`, colour `shade(lerp(hazard, accent,
  rand·0.6), 0.85)`, life `U(4.5,8.5)`, `drag 0.12`, `gravity 5`,
  `shrink=false`, kind `"ember"` 55% else `"dot"`, `spin U(−1.2,1.2)`.
  NEW BEST ping (once, when count-up ≥ 0.999): `ring(W/2, 250, UI_GOLD,
  radius=120, count=30, life=0.8, speed=190)`.
- **VictoryScene** (`_emit`, 1023–1069):
  - Star ceremony: star i revealed at `t ≥ 0.85 + i·0.55`; per star at
    `(starX[i], 292)`, colour `UI_GOLD` (3rd star `lerp(UI_GOLD, UI_WHITE,
    0.4)`): `ring(radius=90, count=22, life=0.6, speed=180)` +
    `burst(count=22, speed=(60,240), life=(0.4,0.9))`.
  - Confetti shower: for the first 2.6 s, accumulator at 90/s of direct
    `spawn`: x `U(0, W)`, y `U(−60, −6)`, `vx U(−70,70)`, `vy U(30,120)`,
    radius `U(2,4.6)`, colour random from
    `(accent, accent2, food, UI_GOLD)`, life `U(1.6,3.2)`, `drag 0.5`,
    `gravity 95`, `shrink=false`, kind `"shard"` 45% else `"dot"`,
    `spin U(−6,6)`.
  - Late fireworks: after the shower and while `t < 6`, probability
    `dt·1.4` per frame: `_firework(U(220, W−220), U(140, 420), power=0.7)` =
    `ring(cols[0], radius=110·p, count=28, life=0.7, speed=200·p)` + 3×
    `burst(cols[(i+1)%4], count=int(20·p), speed=(90, 320·p),
    life=(0.5,1.2), radius=(2,5))`.

### 10.7 `scenes/story_scene.py`
- `ambient((0, 40, W, H−40), lerp(theme.accent2, UI_WHITE, 0.2), dt,
  rate=11, turbulence=0.35, twinkle=0.30)` (883–885); drawn over the
  backdrop (966).

### 10.8 Not particle-system users
`snake/gfx/render.py` does **not** call this module. `snake/gfx/background.py`
and `snake/core/obstacles.py` have their *own private* `_glow_sprite` caches
(same visual idea, different code) — out of scope here; do not unify without
checking their specs.

---

## 11. Blend modes and layering

- **Everything** this module composites uses `pygame.BLEND_RGB_ADD` →
  PixiJS `blendMode: 'add'` on every sprite and on the geometry Graphics.
- Layer order inside the system: blob sprites in age order (oldest first,
  newest on top — irrelevant under pure ADD, which is commutative; ordering
  only matters vs. non-additive layers), then the geometry layer on top.
  Under ADD the *result* is order-independent, so a ParticleContainer that
  does not guarantee order is fine.
- The system as a whole is one layer inserted at a scene-specific z (§10),
  always **below** UI text/panels and **above** the play-field/background.

---

## 12. Pygame tricks → PixiJS v8 equivalents

| Python trick | Why it exists | PixiJS v8 equivalent |
|---|---|---|
| Pre-rendered glow sprites, cached by (radius bucket, quantised colour·fade) | pygame can't tint or alpha additive blits cheaply | Canvas-generated textures cached identically (§4); sprites need no tint/alpha. Alternative (lower fidelity): one white radial texture + tint + alpha — flagged, not recommended. |
| No-alpha black-background sprites (ADD makes black invisible) | avoids per-pixel alpha cost | Same: generate opaque black-background textures; ADD ignores black. No alpha channel needed. |
| Scratch layer + dirty-rect clear + one composite for geometry | avoids per-particle surface allocs on CPU | Single `Graphics` cleared each frame, `blendMode='add'`, drawn above the sprite layer. Dirty-rect logic is unnecessary on GPU — drop lines 959–988 entirely. |
| `surface.set_clip(arena)` in gameplay | confine particles to the arena | Rect mask (or `Graphics` mask) on the particle root while the gameplay scene owns it; other scenes unmask. |
| Cache flush at 768 entries; `clear_glow_cache()` on display change | memory guard | Same `Map` flush; also destroy GPU textures on flush (`texture.destroy(true)`), and hook context-restore. |
| Quantised colour keys inlined in the hot loop | avoids 2 function calls/particle | In TS, a plain string or packed-int key; keep quantisation identical so visuals match (10 levels/channel means colour steps are *visible by design*). |
| Stochastic `_emit_count` | smooth emission w/o per-caller accumulators | Same math, one `Math.random()` per call. |
| Oldest-first eviction at the 1400 cap | long-lived ambience dies before fresh explosions | Keep a FIFO array (or ring buffer) so index 0 is oldest. |

### Recommended PixiJS representation per subsystem

- **Blob particles (`dot`/`ember`/`smoke` + geometry soft cores)** — a pool of
  1400 + headroom pre-allocated `Sprite`s in one plain `Container` (or
  `ParticleContainer` with `dynamicProperties: {position: true, …}` — but note
  v8 `ParticleContainer` requires a **single base texture**; since the glow
  cache produces many textures, either (a) pack generated glows into one
  dynamic texture atlas and use `ParticleContainer`, or (b) use a plain
  `Container` of `Sprite`s, which at ≤1400 quads with a handful of texture
  swaps is comfortably within budget. **Recommend (b) first**; measure, then
  atlas if draw-call count hurts. See
  `web/node_modules/pixi.js/skills/pixijs-scene-particle-container/`.)
  Hidden sprites: `visible = false` rather than re-parenting.
- **Geometry particles** — one shared `Graphics`, rebuilt per frame
  (`clear()` + fills/strokes), `blendMode 'add'`. ≤ a few hundred primitives
  per frame worst case; Graphics rebuild is fine in v8. Stroke widths 1–2 px
  are design-space px (scaled up by the world root — matches pygame, whose
  1 px lines are design-canvas px scaled to window).
- **Particle records** — keep the Python architecture verbatim: one
  `Particle[]` live array + free pool, same eviction. Do not switch to SoA
  unless profiling demands it; identical semantics matter more.
- The system exposes `update(dt)` (simulation, called once by Game) and a
  render sync step that walks live particles and writes sprite
  position/texture/visibility + rebuilds the Graphics — the direct analogue
  of `draw(surface)`.

---

## 13. TS mapping notes (where each input comes from)

| Python reads | TS source |
|---|---|
| `C.MAX_PARTICLES` (1400) | `web/src/core/config.ts` → `MAX_PARTICLES` |
| `C.TRAIL_EMIT_RATE` (46) | `config.ts` → `TRAIL_EMIT_RATE` |
| `C.MAX_DT` (1/20) | `config.ts` → `MAX_DT` |
| `C.WINDOW_W/H` (1280×720) | `config.ts` (call-site rects) |
| `contracts.TAU`, `contracts.clamp` | `web/src/core/mathx.ts` → `TAU`, `clamp` |
| `P.clamp8`, `P.shade`, `P.lerp_color` | `web/src/core/palette.ts` → `clamp8`, `shade`, `lerpColor` (note `RGB` is a readonly tuple type there) |
| `P.UI_WHITE`, `P.UI_GOLD`, `P.UI_GOOD`, `P.UI_BAD` | `palette.ts` UI constants (sourced from themes.json's ui block — never hard-code hex) |
| Theme colours at call sites (`snake_a`, `snake_b`, `accent`, `accent2`, `grid`, `food`, `hazard`) | `palette.ts` `Theme` objects built from `web/src/data/themes.json` |
| `powerup_color(kind)` | `web/src/core/powerups.ts` |
| `food_color(kind, theme, t)` | food colour helper (gameplay-side; see the food/render spec) |
| `random.uniform/random/choice` | `Math.random()`-based helpers; **no seeded RNG required** — particles are pure cosmetics and share Python's unseeded `random` module, not the sim RNG. Do not route through the deterministic sim RNG or you will perturb bit-identical sim replay. |
| `pygame.BLEND_RGB_ADD` | `blendMode: 'add'` |

Call-site constants that live in scene files (not config): gameplay
`TRAIL_RATE_BOOST = 46·2.3`, `AMBIENT_RATE = 3.0`, `CROSS_WASH_RATE = 62`,
`CROSS_SOUND_COOLDOWN = 0.55`; menu `RING_PERIOD = 2.9`; game-over ember rate
13/s; victory confetti 90/s for 2.6 s, star timing `0.85 + i·0.55`, star row
y = 292. These belong to the scene ports but are listed here so the emitter
contracts are complete.

---

## 14. Invariants worth asserting

1. `items.length ≤ max_particles` after every `spawn` (eviction works).
2. Pool never exceeds `max_particles` entries.
3. `spawn` with any non-finite argument returns null and adds nothing.
4. `radius ≥ 0.5`, `life ≥ 0.01`, `max_life ≥ 1e-6` on every live particle.
5. Unknown `kind` string becomes `"dot"`.
6. A `ring` particle's `angle` never changes (spin is width, never rotated).
7. Glow cache size ≤ 768; a key that quantises to (0,0,0) is never cached and
   never drawn.
8. The quantisation used for cache lookup in the draw hot loop is *bit-identical*
   to the one used when building (`_quantise_channel` inlined at lines
   931–934) — a mismatch = permanent cache miss = texture churn every frame.
9. `update` with `dt ≤ 0` is a no-op; `dt` is clamped to `MAX_DT`.
10. `_emit_count` never returns > 64.
11. `burst` count ≤ 400, `ring` outriders ≤ 200, `spark_line` ≤ 200 (+40
    bolts), `confetti` ≤ 400, `implode` ≤ 240.
12. Nothing in the module throws to the caller (port as narrow input
    validation + clamps, not blanket catch).

Performance-critical (Python caches these because they're expensive):
- Glow texture generation — must stay cached; expect low hundreds of live
  keys per theme. Flush should also free GPU memory.
- The draw loop touches every live particle once; keep per-particle work
  branch-light (the colour-ramp path is skipped when `color_end` is null —
  preserve that early-out).
- Geometry Graphics rebuild is per-frame by design; blob sprites must not
  allocate per frame (pool sprites, reuse).

---

## 15. Open questions

1. **Slow-mo asymmetry** (§1): emission uses gameplay's scaled `sdt`, physics
   uses wall dt. This looks intentional (slow-mo shows crisp, full-speed
   particles) but is worth a confirming glance at `fx.slowmo` during
   integration — the effects/scene specs own that clock.
2. **ParticleContainer vs Container** (§12): v8's single-texture constraint vs
   the multi-texture glow cache. Spec recommends plain `Container` of sprites;
   if profiling on low-end mobile says otherwise, an atlas is the fallback.
   Decision deferred to implementation with a measurement.
3. **Anti-aliasing of geometry**: pygame draws aliased 1–2 px lines/polygons;
   Pixi Graphics anti-aliases. Accepting AA as an improvement — flag if the
   art direction wants the crunchy pygame look (could emulate with
   `roundPixels`/nearest scaling, probably not worth it under the CRT filter).
4. **Integer blit snapping** (§4): pygame snaps sprite blits to whole pixels;
   Pixi will sub-pixel-position. Imperceptible under bloom/CRT; noted for
   anyone diffing screenshots.
5. **Uncalled emitters** (`explosion`, `confetti`, `implode`, `spark_line`):
   ported for API completeness. If the team prefers to drop dead code from
   the web build, that is a product call, not a fidelity one — but they are
   cheap and `explosion` is clearly the intended future upgrade path for
   deaths.
6. **`smoke` under ADD**: smoke can only *add* light (it is a dim grey glow,
   never occluding). If the port ever moves particles off ADD, smoke must be
   revisited; as specced it is faithful.
