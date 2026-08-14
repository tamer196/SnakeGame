# Integration contract: simulation ⇄ renderer ⇄ scene

**Ground truth:** `snake/scenes/gameplay.py` (the per-frame conductor) and `snake/main.py`
(the application loop that hosts it).
**Port targets:** the gameplay scene of the web app (`web/src/scenes/…`, to be written),
against the already-complete, bit-identical simulation in `web/src/core/*.ts` and the
shell in `web/src/app/Game.ts` / `Viewport.ts` / `Scene.ts`.

This document is the *map of the frame*: what runs in which order, what the renderer
reads from every sim object, and every event hook (pickup → burst, hit → shake, clear →
transition). It deliberately does **not** re-specify how a snake / orb / rune / hazard /
background / HUD *looks* — those are the render/ui/effects specs. It specifies where
each of those drawing routines is *called from*, with what arguments, in what order, and
under which clip.

Rule of thumb carried over from Python and worth keeping: **nothing in `update` or
`draw` may throw.** Every Python call site is wrapped in `try/except`; the TS core
already swallows internally, and the scene should keep the same posture (a bad frame
degrades, it never takes the game down).

---

## 1. Coordinate spaces and geometry

| Concept | Value | Source |
|---|---|---|
| Design canvas | 1280 × 720 fixed | `C.WINDOW_W/H` (`web/src/core/config.ts`) |
| HUD strip | `(0, 0, 1280, 78)` | `C.HUD_H` |
| Arena rect | `(x=14, y=78, w=1252, h=628)` | `C.ARENA_X/Y/W/H` (Python `C.ARENA_RECT`) |
| Arena centre (spawn) | `(14 + 1252/2, 78 + 628/2) = (640, 392)` | `pygame.Rect.centerx/y` on this rect is exactly `(640, 392)` — even w/h, so int floor-div == float midpoint |
| Overscan | whole screen in design units, may exceed the 1280×720 box | `game.viewport.overscan` (`web/src/app/Viewport.ts`) |

Everything gameplay does — sim, particles, popups, HUD, READY card — lives in **design
pixels** under the scaled world root (`game.world`). Only backgrounds / ambience are
allowed to paint into the overscan rect; nothing gameplay-critical may leave the design
box. Pointer input arrives already in design space via
`Viewport.toDesignClamped` — the Python `Game._to_canvas` also clamped positions over
the letterbox bars to the canvas edge, and the snake's steering relies on that clamp
(steering target must never be off-canvas).

pygame footnotes that matter when re-deriving arena maths:

* `arena.right = x + w`, `arena.bottom = y + h` (used by `_out_of_bounds` and `_wrap`).
* `arena.collidepoint(int(px), int(py))` (used by `_safe_heading`) is **exclusive** of
  the right/bottom edge and truncates to int first. Equivalent TS:
  `px >= a.x && px < a.x + a.w && py >= a.y && py < a.y + a.h` after `Math.trunc`.

---

## 2. The application shell (`main.py` ⇄ `web/src/app/Game.ts`)

### 2.1 Loop and timestep

| | Python (`Game.run`) | Web (`Game.tick`) |
|---|---|---|
| Pacing | `clock.tick(C.FPS)` (60) busy-waits | Pixi `Ticker`, `maxFPS = C.FPS` (60), rAF-driven |
| dt | `min(raw_dt, C.MAX_DT)` | `Math.min(ticker.deltaMS / 1000, C.MAX_DT)` |
| `MAX_DT` | `1/20 = 0.05 s` | same constant from `config.json` |

Both loops are **variable-dt clamped**, not fixed-timestep. There is no accumulator and
no interpolation: a frame slower than 50 ms slows the *game* down rather than stepping
twice. That is the shipped feel and must be preserved. See §10 for animation-parity
implications.

### 2.2 Per-frame order at the shell level

Python `Game.update(dt)` / `Game.draw()` establish this global order **around** the
scene:

1. `game.time += dt`, `frame += 1` — `game.time` is **wall-clock-ish, never slowed**
   by slow-mo. The HUD and the pause button animate from it.
2. Cursor trail: append `mouse_pos`, cap at `C.CURSOR_TRAIL_LEN` (14).
   (TS: `pointerTrail` in `Game.step`, already implemented.)
3. Scene stack walked **top-down**; stop after the first scene with
   `blocks_update = True`. (TS: implemented identically in `Game.step`.)
4. `game.particles.update(dt)` — **real dt**, after scenes. Particles are *not*
   slowed by slow motion; slow-mo scales the simulation only.
5. `game.fx.update(dt)` — **real dt**. Shake/flash/slow-mo timers run in real time.
6. Draw: clear to black → draw scenes from the lowest non-transparent one upward →
   draw the custom cursor over everything → `fx.present(canvas, present_buf)`
   (post-processing: shake offset, aberration, bloom, vignette, flash, transition) →
   scale into the letterboxed window.

**Gap in the TS shell (renderer phase must fill):** `Game.step` currently ends after the
scene walk. The ported `ParticleSystem.update(dt)` and `EffectStack.update(dt)`
equivalents must be inserted at exactly steps 4–5 (after scenes, real dt), and the
post-processing filter chain plays the role of `fx.present`. The Python order
scene-update → particles-update means particles emitted this frame get **no** update
before their first draw (they draw at their birth position); keep that.

Scene visibility culling (`root.visible` from the lowest opaque scene) is the TS
equivalent of Python's "walk down through transparent overlays" draw rule and is
already implemented.

### 2.3 Input mapping

| Python | TS | Notes |
|---|---|---|
| `game.mouse_pos` (canvas space, clamped) | `game.pointer.x / .y` (`PointerState`, design space) | fed by `InputManager` via `Viewport.toDesignClamped` |
| `game.mouse_buttons.get(3)` (right button) | `game.pointer.boost` | TS also ORs in "second simultaneous touch" — intended superset for touch |
| `MOUSEMOTION`/`BUTTONDOWN` rewritten into canvas space before scenes see them | `InputManager` translates pointer events; scenes read `game.pointer` | no per-event scene dispatch for movement |
| Keyboard: `K_ESCAPE`/`K_p` pause; `K_SPACE`/`K_LSHIFT`/`K_RSHIFT` hold-to-boost (`_key_boost`) | **not in `InputManager`** — the gameplay scene must attach its own `keydown`/`keyup` listeners (or the shell should grow a keyboard facility) | boost is *held*, edge-triggered set/unset; pause is edge-triggered |
| F11 / Alt+Enter fullscreen toggle | browser fullscreen API, shell-level | out of scope for gameplay |
| `game.canvas_event_pos(event)` | `viewport.toDesignClamped(e.clientX, e.clientY)` | |

### 2.4 Scene stack semantics (identical, both sides)

* `switch_scene(name)` — pop-and-exit all, enter fresh, `fx.begin_transition()`.
  **TS gap:** `Game.switchScene` does not yet call the transition; when the effects
  port lands, a `beginTransition()` hook belongs there, tinted by
  `fx.set_theme(theme)` = the level's `theme.accent`.
* `push_scene("pause")` — overlay; `blocks_update` on the pause scene freezes
  gameplay updates while gameplay keeps *drawing* underneath (pause is transparent).
* Scene instances are cached and reused ⇒ `onEnter` must reset **everything**
  (`gameplay.on_enter` rebuilds every field; the port must too).

---

## 3. GameplayScene — state it owns

Scene-local presentation constants (these belong to the scene, not `config`):

| Constant | Value | Meaning |
|---|---|---|
| `READY_TIME` | 3.0 s | "get set" countdown; snake frozen |
| `GO_TIME` | 0.65 s | "GO!" flourish |
| `PORTAL_LOCKOUT` | 0.55 s | scene-side portal re-entry guard (in *addition* to `Portal`'s own `PORTAL_COOLDOWN = 0.55`) |
| `HEAD_HIT_R` | `C.SNAKE_HEAD_RADIUS * 0.62` = 8.06 px | lethal-collision head radius |
| `PICKUP_R` | `C.SNAKE_HEAD_RADIUS * 0.90` = 11.7 px | pickup head radius |
| `TRAIL_RATE` | `C.TRAIL_EMIT_RATE` = 46 /s | wake emission |
| `TRAIL_RATE_BOOST` | `46 × 2.3` = 105.8 /s | wake while boosting |
| `AMBIENT_RATE` | 3.0 /s | drifting motes in the arena |
| `SOFT_AVOID_SCALE` / `SOFT_AVOID_MAX` | 0.50 / 92.0 px | softened keep-out list (§5.2) |
| `POPUP_LIMIT` / `POPUP_LIFE` / `POPUP_RISE` | 24 / 1.05 s / −64 px/s | score popups (§7) |
| `BLINK_HZ` | 7.0 | invulnerability blink |
| `CROSS_SOUND_COOLDOWN` | 0.55 s | min gap between cross-over whooshes |
| `CROSS_WASH_RATE` | 62 /s | sparks under the head while crossing |
| `CROSS_TEACH_SLOWMO` | (0.55, 0.24) | (time-scale, seconds) one-time teach |
| `PAUSE_RECT` | `(886, 32, 70, 38)` | pause button in the HUD strip |

Run state: `score, food_eaten, lives, deaths, combo, max_combo, last_pickup_t, elapsed,
clock_t, hazard_t, ready_timer, go_timer, portal_lock, finished, popups[],
_was_boosting, _key_boost, _was_crossing, _cross_cool, _cross_taught, _cross_count,
_vetted` — every one reset in `on_enter`.

### 3.1 Clocks — there are four, and confusing them breaks parity

| Clock | Advance rule | Drives |
|---|---|---|
| `dt` (real) | frame dt clamped to `MAX_DT` | pause button, popups, cross-over cooldown, ready/go timers |
| `sdt` | `clamp(dt * clamp(fx.time_scale(), 0.05, 1), 0, MAX_DT)` | snake, effects, food, runes, magnet, trail emission, `elapsed`, `portal_lock`, background |
| `clock_t` | `+= sdt` | food/rune bob & TTL clocks (`update(sdt, clock_t)`), combo window, `food_color(kind, theme, t)`, all "t" passed to entity draw calls |
| `hazard_t` | `+= sdt * hazard_mult` where `hazard_mult = max(0.05, diff.hazardSpeedMult)` | `updateObstacles(obs, hdt, hazard_t)` **and** `draw_obstacles(..., hazard_t)` — hazards are animated and drawn from the same clock they are simulated on |

`game.time` (never scaled) is passed only to `draw_hud` and `pause_button.draw`.

---

## 4. `on_enter` (level construction) — exact order

1. Resolve `idx` (argument > `game.level_index`, coerced, clamped to `0..LEVEL_COUNT-1`),
   write back `game.level_index = idx`.
2. `level = getLevel(idx)`, `theme = level.theme`, `arena = ARENA_RECT`.
3. **Difficulty snapshot** (once per run — a mid-run settings change must not
   half-apply): `diff = getDifficulty(game.difficulty)` and cache
   `selfCollisionEnabled/Skip/Depth(diff)`, `invulnSeconds(diff)`, `comboWindow(diff)`,
   `hazard_mult = max(0.05, diff.hazardSpeedMult)`,
   `star_targets = applyStarTargets(diff, level.starTargets)`.
4. **Story snapshot:** `story_mode = (game.mode === C.MODE_STORY)`; if so
   `beat = story.getBeat(level.index)`, `chapter = story.getChapter(level.index)`.
5. `fx.set_theme(theme)` (tints future transitions with `theme.accent`).
6. `background = make_background(theme.bg_style, theme, arena)` (background spec).
7. `obstacles = buildObstacles(level.obstacleSpec, arena)`;
   `hazard_t = 0`; `updateObstacles(obstacles, 0, 0)` — **settle moving parts** so the
   avoid list is computed from posed geometry;
   `avoid = obstacleAvoidList(obstacles)`;
   `avoid_soft = avoid.map(([x,y,r]) => [x, y, min(92, r * 0.5)])`.
8. `heading = _safeHeading()` — 12 candidate angles `k·TAU/12`; walk each outward at
   distances 45/90/140/200/270 px from the arena centre; stop at the first probe
   outside the arena (`collidepoint` semantics, §1) or blocked by lethal geometry at
   radius `SNAKE_HEAD_RADIUS * 1.5`; keep the farthest-reaching angle.
9. `snake = new Snake(640, 392, heading, C.SNAKE_START_LENGTH)`;
   `snake.speed = level.cruiseSpeed * diff.speedMult` — **level pace multiplier is NOT
   folded in here** (invariant; it rides on `speedMult` in `update`, §5.1);
   `snake.setTarget(pointer.x, pointer.y)`.
10. `food = new FoodField(arena, theme)`; `food.avoid = [...avoid_soft]` (standing
    list so the field's own bonus/mega timers also place legally); `_vetted = new
    Set()`; `_restock()` (§5.2).
11. `runes = new PowerUpField(arena, theme)`;
    `runes.enabled = level.powerupsEnabled`;
    **apply difficulty cadence** `powerupSpawnRange(diff)` (see gap G1, §11).
12. `effects = new ActiveEffects()`.
13. Reset all run state; `lives = livesFor(diff)`; `ready_timer = READY_TIME`;
    `pause button` rebuilt; `game.particles.clear()`.

`on_exit`: `game.particles.clear()` only.

---

## 5. `update(dt)` — exact order

Everything below is wrapped so it cannot raise. `dt = clamp(dt, 0, MAX_DT)` first.

1. `pause_button.update(dt, pointer)` — **real dt**; on `just_entered` play
   `audio("hover")`.
2. Compute `sdt`, advance `clock_t`, compute `hdt = sdt * hazard_mult`, advance
   `hazard_t` (§3.1).
3. `background.update(sdt)`.
4. Popups: `pop.update(dt)` for all (**real dt**), then filter `life > 0`.
5. `if finished: return` — after a clear/death the world stops but background and
   popups keep animating until the scene switch lands.
6. **READY branch** — while `ready_timer > 0`:
   `ready_timer -= dt` (real); `snake.setTarget(pointer)`;
   `updateObstacles(obstacles, hdt, hazard_t)`; `food.update(sdt, clock_t)`;
   `runes.update(sdt, clock_t)`; when the timer crosses 0: `ready_timer = 0`,
   `go_timer = GO_TIME`, `audio("start")`. **Return.**
   (Note: no `effects.update`, no restock, no rune spawn, no collisions, no trail,
   `elapsed` frozen. The world breathes; the snake does not move.)
7. `go_timer = max(0, go_timer - dt)` (real dt; purely cosmetic).
8. `elapsed += sdt`; `portal_lock = max(0, portal_lock - sdt)`.
9. **Steering + movement:**
   `snake.setTarget(pointer.x, pointer.y)`;
   `boost = _key_boost || pointer.boost`;
   ```
   snake.update(sdt, {
     boost,
     speedMult: level.speedMult * effects.speedMultiplier(),
     turnMult:  effects.turnMultiplier() * diff.turnMult,
   })
   ```
   Load-bearing invariant (documented at length in the Python): `snake.speed` carries
   cruise × difficulty only; `level.speedMult` (1.00 → 1.70 across the campaign)
   composes with the power-up multipliers in `speedMult`. Dropping either flattens the
   campaign's pace ramp.
10. Boost edge: if `snake.boosting && !_was_boosting` → `audio("boost", 0.7)`;
    `_was_boosting = snake.boosting`.
11. **World:** `effects.update(sdt)`; `updateObstacles(obstacles, hdt, hazard_t)`;
    `food.update(sdt, clock_t)`; `runes.update(sdt, clock_t)`;
    `_spawnRune(sdt)` (§5.3); `_restock()` (§5.2).
12. **Magnet:** `r = effects.magnetRadius()`; if `> 0`:
    `food.attract(snake.x, snake.y, sdt, r, MAGNET_STRENGTH)`
    (`MAGNET_STRENGTH = 340`, exported from `core/powerups.ts`).
13. **Trail + ambience** (`_emit_trail`, uses `sdt`): see hook table E1/E2.
14. **Pickups** (`_collect`): food orbs via `food.collectAt(hx, hy, PICKUP_R)` → `_eat`
    each (§6, hook E3); if a pickup finished the level, stop. Then runes via
    `runes.collectAt(hx, hy, PICKUP_R)` → hook E4.
15. **Collisions** (`_collide`, skipped if `finished`), in this exact order:
    a. walls: if `level.wrapWalls` → `_wrap` (hook E5) and *return if wrapped*;
       else if out of bounds (`hx ± HEAD_HIT_R` vs arena edges) → if `snake.invuln > 0`
       recover (shepherd back in, no charge) else `_hit("wall")`; return.
    b. if `snake.invuln > 0` → return (mercy skips self + hazards).
    c. self: `snake.hitsSelf({skip: self_skip, depth: self_depth, enabled:
       self_enabled && !effects.has("ghost")})` — **called unconditionally** (the
       `enabled` flag does the disabling) so its sweep warms `crossingSelf`'s cache
       with the difficulty's parameters; on true → `_hit("self")`, return.
    d. hazards & portals: first obstacle with `ob.collides(hx, hy, HEAD_HIT_R)`;
       `Portal` → if `portal_lock <= 0` teleport (hook E6), return either way;
       `ob.deadly` → `_hit("hazard")`, return.
16. **Cross-over feedback** (`_cross_feedback(dt, snake)` — real dt; hook E7). Runs
    *after* the collision pass so it reuses the sweep that pass already paid for.
17. **Combo lapse:** if `combo > 0 && clock_t - last_pickup_t > combo_window` →
    `combo = 0`.

### 5.1 `_hit(kind)` / `_recover(kind)` — damage pipeline

`_hit` (hooks E8–E10):

1. **Shield:** `effects.consume("shield")` → absorb (hook E8), then
   `snake.invuln = max(snake.invuln, 1.0)`, `_recover(kind)`, done.
2. Real hit: `lives -= 1; deaths += 1; combo = 0;
   snake.shrink(C.HIT_LENGTH_PENALTY /*4*/); snake.invuln = invuln_time;
   save.addDeath(1)`; feedback hook E9.
3. If `lives <= 0`: `lives = 0; snake.kill()`; death feedback (hook E10);
   `_finish(false)`.
4. Else `audio("hit")`; `_recover(kind)`.

`_recover`: no-op for `kind === "self"`. Otherwise clamp the head into the arena with
pad `C.SNAKE_HEAD_RADIUS + 4` (via `snake.teleport` if it moved) and point
`snake.heading` at the arena centre (`angleTo`). Without this a wall hit leaves the head
inside the geometry and the mercy timer drains every life.

### 5.2 `_restock` — food topping + hazard vetting

* Want `level.foodCount + effects.extraFood()` normal orbs; for each missing one, a
  **single** `food.spawn("normal")` attempt (a crowded arena stays under-stocked one
  frame rather than looping).
* Then, only if there are obstacles: every orb not yet vetted is tested **once**
  against the *real* hazard shapes (`_blockedAt(orb.x, orb.y, orb.radius)` = any
  `ob.deadly && ob.collides(...)`); blocked orbs are dropped. The vetted set is rebuilt
  from survivors each pass (never accumulates). Python keys the set on `id(orb)`;
  TS: `Set<Food>` of object references (survivors keep identity through
  `FoodField.update`, so this works).
* Rationale (from the Python doc): the field places against the *softened* avoid list
  (`avoid_soft`, §4 step 7 — bounding circles are wildly conservative for long thin
  walls), so a fresh orb can land inside a wall; the vet catches it. Re-testing every
  frame would let *moving* hazards delete legally-placed food — hence once per orb.

### 5.3 `_spawnRune`

`rune = runes.maybeSpawn(sdt, avoid_soft)`; if it landed inside a real hazard
(`_blockedAt(rune.x, rune.y, rune.radius)`) remove it from `runes.items`.

---

## 6. `_eat(orb)` — scoring pipeline (exact arithmetic)

1. Combo: if `combo > 0 && clock_t - last_pickup_t <= combo_window` →
   `combo = min(C.COMBO_MAX /*8*/, combo + 1)` else `combo = 1`;
   `last_pickup_t = clock_t`; `max_combo = max(max_combo, combo)`.
2. Score:
   ```
   value = orb.value                       // int, from FOOD_KINDS
   mult  = effects.scoreMultiplier()       // 2 while double, else 1 (int)
   base  = value + C.COMBO_STEP_BONUS /*5*/ * max(0, combo - 1)
   gain  = scoreForFood(diff, base, mult)  // banker's rounding inside
   score += gain
   ```
3. `food_eaten += 1`; `save.addFood(1)`; `snake.grow(orb.grow)`.
4. Feedback (hook E3) with `col = foodColor(orb.kind, theme, clock_t)`,
   `special = orb.kind !== "normal"`.
5. Popup: text `"+{gain}"` plus `"  x{combo}"` when `combo > 1`, at
   `(orb.x, orb.y − 12)`, colour `lerpColor(col, UI_WHITE, 0.35)`, `big = special`.
6. If `food_eaten >= level.goalFood` → `_finish(true)`.

### 6.1 `_finish(won)` — end of run

Guarded by `finished` (idempotent). `stars = won ? (score >= t3 ? 3 : score >= t2 ? 2 :
1) : 0` from the difficulty-scaled `star_targets`.

Save side effects: on win `new_best = save.record(idx, score, stars, diff.key)`;
`save.unlockThrough(idx + 1)`; story mode additionally `save.setStoryProgress(next)`
and, on the final level, `save.setStoryComplete(true)`. On loss: **`record` is off
limits** (must not unlock) — only lift `save.highscore` if beaten. Then `save.save()`.

`game.last_result` — the contract with the victory/game-over scenes — carries exactly:
`score, level_index, level_name, food_eaten, goal_food, stars, new_best, won, elapsed,
max_combo, deaths, difficulty (key), difficulty_name, difficulty_label (hudLabel),
difficulty_color, star_targets, crossings (_cross_count), mode, story, next_index,
final_level`, plus in story mode `beat_title, beat_speaker, chapter_end, chapter,
chapter_title, chapter_roman, story_complete`. TS note: `beat.is_chapter_end` has no
field on the TS `StoryBeat` — use `story.chapterEnd(beat.levelIndex)`;
`chapter.roman` is a method `chapter.roman()` in TS.

Win flourish: `fx.flash(theme.accent, 0.7)`; `audio(final ? "win" : "levelup")`.
Finally `switch_scene(won ? "victory" : "gameover")` (which starts a transition wipe).

---

## E. Event-hook catalogue (every particles / fx / audio / popup call)

Colour names refer to the active `Theme` (`web/src/core/palette.ts`; values from
`data/themes.json`) or the shared `UI_*` constants; `pcol(k) = powerupColor(k)`.
Particle emitter semantics (`trail/burst/ring/ambient` parameter meanings) are the
particle spec's job; the arguments below are this scene's exact inputs.

| # | Trigger | Calls (exact args) |
|---|---|---|
| **E1** | every sim frame, wake (`_emit_trail`, sdt) | boosting: `particles.trail(bx, by, lerpColor(theme.accent2, [255,255,255], 0.30), sdt, rate=105.8, speed=(30,110))`; else `particles.trail(bx, by, theme.snake_a, sdt, rate=46, speed=(8,44))` where `(bx,by) = head − heading·(SNAKE_HEAD_RADIUS·0.6)` (wake emits *behind* the head). Other trail params at emitter defaults. |
| **E2** | every sim frame, ambience | `particles.ambient(arena, theme.grid, sdt, rate=3.0)` |
| **E3** | food eaten (`special = kind !== "normal"`, `col = foodColor(kind, theme, clock_t)`) | `burst(orb.x, orb.y, col, count=special?34:20, speed=special?(60,300):(40,190), life=(0.35,1.0))`; `ring(orb.x, orb.y, col, radius=special?76:46, count=special?24:16, life=special?0.55:0.42)`; if special: `fx.flash(col, 0.24)`, `fx.shake(2.5)`; `audio(special?"bonus":"eat")`; popup §6.5 |
| **E4** | rune collected (`col = pcol(kind)`, `name = powerupInfo(kind).name.toUpperCase()`) | `effects.add(kind)`; `burst(rune.x, rune.y, col, count=30, speed=(70,260), life=(0.4,1.0))`; `ring(rune.x, rune.y, col, radius=74, count=26, life=0.55)`; popup `name` big at `(x, y−18)`; `fx.flash(col, 0.28)`; `audio("powerup")` |
| **E5** | wrap-around (wrap walls): old pos `(x,y)`, new pos `(nx,ny)` = opposite edge ±2 px | `burst(x, y, theme.accent, count=14, speed=(50,170), life=(0.2,0.5))`; `ring(nx, ny, theme.accent, radius=42, count=14, life=0.35)`; `snake.teleport(nx, ny)` |
| **E6** | portal (`(ex,ey) = portal.teleport(x, y)`) | `ring(x, y, theme.accent2, radius=70, count=22, life=0.5)`; `ring(ex, ey, theme.accent, radius=86, count=26, life=0.55)`; `burst(ex, ey, theme.accent2, count=22, speed=(60,240), life=(0.3,0.8))`; `fx.flash(theme.accent2, 0.22)`; `snake.teleport(ex, ey)`; `portal_lock = 0.55`; `audio("portal")` |
| **E7** | cross-over (`col = lerpColor(theme.accent2, UI_WHITE, 0.42)`) | *while crossing, every frame (real dt):* `trail(head.x, head.y, col, dt, rate=62, spread=TAU·0.5, speed=(14,78), life=(0.16,0.40), radius=(2.0,4.5))` — at the head, not behind it. *Leading edge* (`!_was_crossing && _cross_cool<=0`): `_cross_cool=0.55; _cross_count+=1; audio("boost", 0.24); ring(head, col, radius=38, count=12, life=0.30, speed=95)`. *First time per level:* `fx.slowmo(0.55, 0.24); fx.flash(col, 0.16);` popup `"CROSS-OVER"` at `(x, y−30)`. Crossing predicate: `snake.alive && snake.crossingSelf()`, **plus** when that is false and `_forgivesEverything()` (`!self_enabled || effects.has("ghost")`), re-ask `snake.hitsSelf({skip: C.SELF_COLLISION_SKIP, depth: C.SELF_COLLISION_DEPTH, enabled: true})` — on EASY/ghost the default-rules verdict *is* the cross-over cue. |
| **E8** | shield absorbs a hit (`col = pcol("shield")`) | `ring(hx, hy, col, radius=140, count=40, life=0.7, speed=190)`; `burst(hx, hy, col, count=26, speed=(80,300), life=(0.3,0.8))`; `fx.flash(col, 0.55)`; `fx.shake(9.0)`; `audio("powerup")`; popup `"SHIELD!"` big at `(hx, hy−26)`; `snake.invuln = max(snake.invuln, 1.0)`; recover |
| **E9** | real hit (life lost, `col = theme.hazard`) | `burst(hx, hy, col, count=46, speed=(90,380), life=(0.35,1.1), radius=(2.0,6.0))`; `ring(hx, hy, col, radius=120, count=30, life=0.6)`; `fx.shake(19.0)`; `fx.flash(UI_BAD, 0.85)`; `fx.slowmo(0.35, 0.45)`; popup `"-1 LIFE"` in `UI_BAD`, big, at `(hx, hy−26)`; then (survived) `audio("hit")` |
| **E10** | death (lives hit 0) | `snake.kill()`; `burst(hx, hy, theme.snake_a, count=70, speed=(60,430), life=(0.5,1.4), radius=(2.0,7.0))`; `fx.shake(24.0)`; `audio("die")`; `_finish(false)` |
| **E11** | level clear | `fx.flash(theme.accent, 0.7)`; `audio(final ? "win" : "levelup")`; `_finish(true)` |
| **E12** | countdown ends | `audio("start")`; `go_timer = 0.65` |
| **E13** | boost engages (edge) | `audio("boost", 0.7)` |
| **E14** | pause (button or Esc/P) | `audio("click")`; `push_scene("pause")` |
| **E15** | pause button hover enter | `audio("hover")` |

Audio cue names used by this scene (contract for the audio phase): `click, hover,
start, boost, powerup, eat, bonus, portal, hit, die, win, levelup`. Second argument
where present is a volume scale.

---

## 7. Score popups (`_Popup`)

* Cap 24 (oldest evicted). Fields: `x, y, vy, life, max_life, text, color, big`.
* Birth: `vy = −64 · (big ? 1.25 : 1)`; `life = max_life = 1.05 · (big ? 1.3 : 1)`.
* Update (**real dt**): `y += vy·dt`; `vy *= 1 / (1 + 2.6·dt)` (eases the rise to a
  stop); `life −= dt`.
* Draw: font = `fonts.h2` if big else `fonts.small`; `fade = clamp(life/max_life,0,1)`;
  `alpha = 255 · clamp(fade · 1.5, 0, 1)` — i.e. fully opaque for the first third of
  life, then linear fade. Text centred on `(x, y)` in its colour. **Clipped to the
  arena rect.**
* Pixi mapping: one `Text` (or BitmapText) object per popup created at spawn and reused
  until death — the Python re-renders the glyphs every frame, which is exactly the
  waste Pixi should not copy. Layer: above particles, below HUD (§8), inside the arena
  mask.

---

## 8. `draw()` — layer order and clipping

Python paints in this exact order onto one surface; the Pixi scene should hold one
child `Container` per layer, in this order:

| # | Layer | Clip | Notes |
|---|---|---|---|
| 1 | `background.draw` | none (may fill overscan in the port) | background spec |
| 2 | `draw_arena(surface, arena, theme, clock_t)` | draws itself | arena frame/glow — render spec |
| 3 | `draw_obstacles(surface, obstacles, theme, hazard_t)` | hazards clip themselves | **time argument is `hazard_t`**, not `clock_t` |
| 4 | `food.draw(surface, clock_t)` | self-clipped | TS `FoodField` has no draw: renderer iterates `field.items` using `drawPos/drawRadius/visible/colorFor` (all ported on the field) |
| 5 | `runes.draw(surface, clock_t)` | self-clipped | ditto via `powerUpDrawRadius/powerUpBrightness`, `p.age/phase/spin` |
| 6 | `draw_snake(surface, snake, theme, clock_t, ghost=effects.has("ghost"), shield=effects.has("shield"))` — **skipped entirely on the blink-off frames**: visible iff `snake.invuln <= 0 \|\| sin(snake.invuln · TAU · 7.0) > −0.25` | **arena clip** | neither `draw_snake` nor the particles clip themselves; Python wraps 6–7 in `surface.set_clip(arena)` restored in a `finally`. Pixi: a shared rectangular mask (or `cullArea`+mask) on a container holding snake + particle layers |
| 7 | `game.particles.draw` | **same arena clip** | particles render above the snake |
| 8 | popups (§7) | arena clip (own block) | |
| 9 | `draw_hud(surface, game, hud_state, theme, game.time)` | clips itself to the HUD strip | state dict in §8.1; **unscaled `game.time`** |
| 10 | pause button | clipped to HUD strip `(0,0,1280,78)` (its glow must not bleed into the arena) | `Button.draw(surface, theme, fonts, game.time)` |
| 11 | READY card (`ready_timer > 0`) else GO flourish (`go_timer > 0`) | none | §9 |
| — | cursor + post-processing | — | drawn by the shell above every scene (§2.2) |

### 8.1 HUD state contract (`_hud_state()` → `draw_hud`)

The HUD is a later phase; this dict is the *only* channel gameplay feeds it:

```
score:int, highscore:int (save.highscore), level_name:str, level_index:int,
goal_food:int, food_eaten:int, lives:int, combo:int,
boost:float (snake.boost, raw stamina), boost_max:float (C.SNAKE_BOOST_MAX),
effects: Array<[kind, secondsLeft]>  (effects.items(), urgency-sorted),
difficulty:str (diff.key), difficulty_label:str (diff.hudLabel),
difficulty_color:RGB (diff.color), mode:str,
chapter:int (chapter?.number ?? 0), chapter_title:str, beat_title:str
```

`draw_hud` ignores unknown keys — keep that tolerance in the port.

---

## 9. READY / GO overlays (exact math)

**READY** (`ready_timer` counts 3.0 → 0, real dt):

* `fade = clamp(ready_timer / 0.5, 0, 1)` — card fades out over the last 0.5 s.
* `intro = easeOutCubic(clamp((3.0 − ready_timer) / 0.35, 0, 1))` — swings in over the
  first 0.35 s.
* `vis = fade · intro`; skip everything if `vis <= 0.01`.
* `tint(col) = lerpColor(theme.bg_bottom, col, vis)` — every text colour is blended
  toward the backdrop as the card fades (Python fades by colour, not alpha).
* Panel: 720 × 232, centred at `(arena.centerx, arena.centery − 40 + (1 − intro)·40)`
  (slides up 40 px as it swings in). Drawn with `draw_panel(alpha = 226·vis,
  border = true, glow = 0.55·vis)` — ui-kit spec.
* Text rows (all positions relative to the panel rect, `cx` = panel centre x):
  * `"LEVEL {number:02d}"` — `fonts.small`, `tint(theme.accent2)`, centred at
    `(cx, y+20)`.
  * Story runs only: `"{chapter.roman()}. {chapter.title.upper()}"` — `fonts.tiny`,
    `tint(theme.accent2)`, left-aligned at `(x+26, y+24)`.
  * `diff.hudLabel` — `fonts.tiny`, `tint(diff.color)`, right-aligned at
    `(right−26, y+24)`.
  * Headline: story → `beat.title.upper()`, else `level.name.upper()` — largest of
    `fonts.title / h1 / h2` that fits `panel.w − 56` px (`_fit_font`; falls back to
    `h2` then `title`), `tint(theme.text)`, centred at `(cx, y+46)`.
  * Strapline: story → `"{level.name}  -  {level.subtitle}"`, else `level.subtitle` —
    `fonts.body`, `tint(theme.accent)`, centred at `(cx, y+122)`.
  * `level.hint` — `fonts.small`, `tint(theme.text_dim)`, centred at `(cx, y+160)`.
  * `"GOAL  {goalFood} ORBS"` — `fonts.small`, `tint(UI_GOLD)`, centred at
    `(cx, y+188)`.
* Countdown digit (`count = ceil(ready_timer)`, shown if > 0, capped display at 9):
  `step = 1 − frac(ready_timer)` (0 at each second's start → 1 at its end);
  colour `lerpColor(theme.accent, UI_WHITE, 0.25 + 0.5·step)`; rendered in
  `fonts.huge`, then scaled by `1.35 − 0.35·easeOutCubic(clamp(step·1.6, 0, 1))`
  (pop-in); alpha `255 · vis · clamp(1.4 − step, 0, 1)` (fades late in each second);
  centred horizontally on `cx`, **top edge** at `panel.bottom + 40` (Python blits at
  that y — not centre-anchored vertically).

**GO** (`go_timer` counts 0.65 → 0): `u = clamp(go_timer / 0.65, 0, 1)`; `"GO!"` in
`fonts.huge`, colour `lerpColor(theme.accent, UI_WHITE, 0.55)`; scale
`1 + 0.9·(1 − u)` (grows as it fades); alpha `255·clamp(u·1.4, 0, 1)`; centred on the
arena centre.

Pixi note: `pygame.transform.rotozoom` here is just a smooth uniform scale of rendered
text → `Text.scale` + `alpha`, no re-render.

---

## 10. Timing / animation parity (Python loop vs web loop)

* Identical contract: variable dt, clamped at `MAX_DT = 0.05 s`, nominal 60 fps.
  The web ticker's `maxFPS = 60` also stops 120 Hz displays from doubling emission
  randomness or halving dt-dependent smoothing (see below). Keep it.
* All *positional* animation is either integrated (`clock_t`, `hazard_t`, popup
  physics) or absolute-time driven (food bob `sin(t·1.9 + phase)`, hazard phases,
  blink `sin(invuln·TAU·7)`), so parity holds at any frame rate within the clamp.
* dt-dependent smoothing exists and is *intentionally* frame-rate-sensitive within
  tolerance: popup damping `vy *= 1/(1+2.6·dt)`, snake `bank += (raw−bank)·min(1, dt·10)`.
  At a capped 60 fps both ports see the same dt distribution; do not "fix" these into
  exponential form unless both sides change together.
* Stochastic emission (`_emit_count(rate, dt)` = `floor(rate·dt)` + probabilistic
  remainder) is time-scale-correct by construction; pass **sdt** for gameplay wake,
  **real dt** for the cross-over wash (matches Python: `_emit_trail(sdt)` vs
  `_cross_feedback(dt)`).
* Slow-motion (`fx.time_scale()`, 0.05..1) scales **only** `sdt` and its derivatives.
  Real-dt consumers: pause button, popups, ready/go timers, cross-over cooldown,
  particles (shell-level), fx timers (shell-level), `game.time`. This split is the
  whole point of the effect (hit-stop with live UI) — assert it in review.
* A stall > 50 ms slows the game (no catch-up). `Snake.update` sub-steps internally
  (≤ 7 px / ≤ 0.1 rad per sub-step) so path fidelity is dt-independent — the port need
  do nothing extra.
* Divergence to accept or resolve: Python snaps the window blit to integer upscales
  within `INTEGER_SCALE_SNAP` and uses nearest-neighbour for exact multiples;
  `Viewport` scales continuously. On GPU with antialiased vector drawing this is the
  right call — flagged as a decision, not silently dropped (see Q5).

---

## 11. Python attribute/method → TS equivalent (verified against the TS sources)

### Shell (`game.*` as seen from the gameplay scene)

| Python | TS | Status |
|---|---|---|
| `game.mouse_pos` | `game.pointer.x/.y` | ✅ |
| `game.mouse_buttons.get(3)` | `game.pointer.boost` | ✅ (superset: touch boost) |
| `game.time` | `game.time` | ✅ |
| `game.level_index / mode / difficulty / last_result` | `levelIndex / mode / difficulty / lastResult` | ✅ |
| `game.push_scene / switch_scene / pop_scene` | `pushScene / switchScene / popScene` | ✅ |
| `game.save` (`SaveData`) | `core/save.ts` `SaveData` — `record(idx, score, stars, diffKey)`, `unlockThrough`, `setStoryProgress`, `setStoryComplete`, `addFood`, `addDeath`, `highscore`, `save()` | ✅ ported (wire an instance onto `Game`) |
| `game.fx` (`EffectStack`) | **not yet ported** — required surface for this scene: `timeScale()`, `setTheme(theme)`, `flash(rgb, amount)`, `shake(px)`, `slowmo(factor, seconds)`, `beginTransition()` | ⛔ renderer/effects phase |
| `game.particles` (`ParticleSystem`) | **not yet ported** — required: `trail`, `ambient`, `burst`, `ring`, `clear`, `update`, draw layer | ⛔ renderer phase |
| `game.fonts` (`FontBook`) | **not yet ported** — faces used here: `tiny, small, body, h2, h1, title, huge` (+ `mono_small` shell-side FPS) | ⛔ ui phase |
| `game.audio` | **not yet ported** (task: audio engine) — cue list in §E | ⛔ |
| `make_background(style, theme, arena)` | **not yet ported** — needs `.update(sdt)` and a display object | ⛔ background phase |

### Simulation core

| Python | TS (`web/src/core/…`) | Notes |
|---|---|---|
| `Snake(x, y, heading=, length=)` | `new Snake(x, y, heading, length)` | positional |
| `snake.x/.y/.heading/.speed/.alive/.boost/.boosting/.invuln` | same names, public | `invuln`/`speed` are assignable, as the scene requires |
| `snake.segments` / `snake.path` | `segments` / `path` (`Vec2[]`, newest-first path) | renderer-facing |
| `snake.current_speed / bank / turn_input / turn_rate` | `currentSpeed / bank / turnInput / turnRate` | read by `draw_snake` |
| `snake.set_target(x, y)` | `setTarget(x, y)` | |
| `snake.update(dt, boost=, speed_mult=, turn_mult=)` | `update(dt, {boost, speedMult, turnMult})` | options object |
| `snake.hits_self(skip=, depth=, enabled=)` | `hitsSelf({skip, depth, enabled})` | same memoised-sweep semantics |
| `snake.crossing_self()` | `crossingSelf()` | reuses the frame's sweep |
| `snake.grow(n) / shrink(n) / kill() / teleport(x, y)` | same names | |
| `snake.boost_frac()` | `boostFrac()` | HUD |
| `FoodField(arena, theme)` | `new FoodField(rect, theme, seed?)` | ⚠ seeding — Q1 |
| `field.update(sdt, clock_t)` / `.count("normal")` / `.items` / `.avoid` / `.spawn("normal")` / `.collect_at(x, y, r)` / `.attract(x, y, dt, radius=, strength=)` | `update(dt, t)` / `count("normal")` / `items` / `avoid` / `spawn("normal")` / `collectAt` / `attract(x, y, dt, radius, strength)` | all public |
| `orb.x/.y/.kind/.value/.radius/.grow` | same fields on `Food` | |
| `food_color(kind, theme, t)` | `foodColor(kind, theme, t)` (`core/food.ts`) | |
| `PowerUpField(arena, theme)` | `new PowerUpField(rect, theme, seed?)` | ⚠ Q1 |
| `field.enabled` / `.maybe_spawn(dt, avoid)` / `.collect_at` / `.items` / `.rng` | `enabled` / `maybeSpawn(dt, avoid)` / `collectAt` / `items` / `rng` | |
| `field._roll_interval` / `field._timer` monkey-patch (difficulty cadence) | **no equivalent** — `rollInterval()` and `timer` are `private` and read `C.POWERUP_SPAWN_MIN/MAX` directly | ⛔ **gap G1** |
| `powerup_color(kind)` / `powerup_info(kind)["name"]` | `powerupColor(kind)` / `powerupInfo(kind).name` | |
| `MAGNET_STRENGTH` | `MAGNET_STRENGTH` (340) | exported |
| `ActiveEffects()` — `add/has/consume/update/items/score_multiplier/speed_multiplier/turn_multiplier/magnet_radius/extra_food` | `add/has/consume/update/items()/scoreMultiplier()/speedMultiplier()/turnMultiplier()/magnetRadius()/extraFood()` | `items()` returns `[kind, left][]` urgency-sorted |
| `build_obstacles(spec, arena)` / `update_obstacles(obs, dt, t)` / `obstacle_avoid_list(obs)` | `buildObstacles(spec, rect)` / `updateObstacles(obs, dt, t)` / `obstacleAvoidList(obs)` | |
| `ob.deadly` / `ob.collides(x, y, r)` / `isinstance(ob, Portal)` | `ob.deadly` / `ob.collides(x, y, r)` / `ob instanceof Portal` (or `ob.kind === "portal"`) | `deadly` may flip per frame (lasers, pulsars) |
| `portal.teleport(x, y) -> (ex, ey)` | `portal.teleport(x, y): Vec2` (tuple) | sets both ends' cooldowns itself |
| `get_level(i)` / `LEVEL_COUNT` | `getLevel(i)` / `LEVEL_COUNT` (`core/level.ts`) | |
| `level.name/subtitle/hint/index/number/theme` | same names | |
| `level.goal_food / food_count / speed_mult / powerups_enabled / wrap_walls / obstacle_spec` | `goalFood / foodCount / speedMult / powerupsEnabled / wrapWalls / obstacleSpec` | |
| `level.cruise_speed()` / `star_targets()` | `level.cruiseSpeed` / `level.starTargets` (properties, precomputed) | |
| `diffmod.get_difficulty(key)` | `getDifficulty(key)` (`core/difficulty.ts`) | total, never throws |
| `self_collision_enabled/skip/depth`, `invuln_seconds`, `combo_window`, `lives_for`, `powerup_spawn_range`, `score_for_food`, `apply_star_targets` | `selfCollisionEnabled/Skip/Depth`, `invulnSeconds`, `comboWindow`, `livesFor`, `powerupSpawnRange`, `scoreForFood`, `applyStarTargets` | banker's rounding ported |
| `diff.key/name/hud_label/color/speed_mult/turn_mult/hazard_speed_mult` | `key/name/hudLabel/color/speedMult/turnMult/hazardSpeedMult` | |
| `storymod.get_beat(i)` / `get_chapter(i)` | `getBeat(i)` / `getChapter(i)` (`core/story.ts`) | |
| `beat.title/.speaker` | `beat.title/.speaker` | |
| `beat.is_chapter_end` | **no field** — `chapterEnd(beat.levelIndex)` | naming shim |
| `chapter.number/.title/.roman` | `number/.title/.roman()` | `roman` is a method |
| `P.lerp_color / P.UI_WHITE / P.UI_BAD / P.UI_GOLD / theme.*` | `lerpColor / UI_WHITE / UI_BAD / UI_GOLD / Theme` (`core/palette.ts`); packed mirrors in `theme.hex` / `UI_HEX` | never copy hex literals; name the theme key |
| `contracts.TAU / clamp / angle_to / ease_out_cubic` | `TAU / clamp / angleTo / easeOutCubic` (`core/mathx.ts`) | |
| `C.*` constants | same names, `core/config.ts` (values from `data/config.json`) | |

**Verdict on sim coverage:** everything the renderer/scene reads exists in the TS core
except gap **G1** (power-up spawn-cadence override) and the two naming shims noted
above.

### gfx/ui helpers the *gameplay* layer depends on (inventory for the renderer phase)

From `snake/gfx/render.py`: `draw_arena(surface, rect, theme, t)`,
`draw_snake(surface, snake, theme, t, ghost=, shield=)`. From `snake/gfx/background.py`:
`make_background(style, theme, rect)` → object with `update(dt)` / `draw`.
From `snake/gfx/particles.py`: `ParticleSystem.trail/ambient/burst/ring/clear/update/draw`.
From `snake/gfx/effects.py`: the `EffectStack` surface listed in §11 shell table.
From `snake/gfx/ui.py` the gameplay scene itself needs only:

* `Button` (pause button: rect, label, `style="ghost"`, `update(dt, pos)`,
  `just_entered`, `handle_event` → click, `draw(surface, theme, fonts, t)`).
* `draw_panel(surface, rect, theme, alpha=, border=, glow=)` (READY card).
* `draw_text(surface, text, font, color, pos, align="center"/"right"/left)` — i.e. a
  neon-text helper with alignment; the popups additionally need plain centred text
  with per-object alpha.
* `draw_hud(surface, game, state, theme, t)` — consumed via the §8.1 dict.
* (shell) `draw_cursor` — reads `game.pointer` + `pointerTrail`.

So the renderer phase must bring **a text/font facility** (FontBook equivalent: tiny
14 → huge display sizes) *before* the gameplay scene can render popups and the READY
card; the full UI kit (bars, chips, odometer HUD) can follow in the UI phase.

---

## 12. Invariants worth asserting (cheap, high-yield)

1. `snake.speed === level.cruiseSpeed * diff.speedMult` after `onEnter` (and is never
   touched again during a run); `level.speedMult` appears **only** inside the
   `speedMult` argument of `snake.update`.
2. `hazard_t` advances at `hazard_mult ×` the sim clock, and the same `hazard_t` value
   is passed to *both* `updateObstacles` and the hazard renderer within one frame.
3. Snake + particles render inside an arena-rect mask; popups inside the same mask;
   the pause button inside the HUD-strip mask.
4. `hitsSelf` is called exactly once per sim frame from the collision pass with the
   difficulty's `{skip, depth, enabled}` (never short-circuited away), before
   `crossingSelf` is consulted.
5. Order within a frame: collect → collide → cross-feedback → combo-lapse; restock
   never runs during READY; effects.update never runs during READY.
6. `_finish` is idempotent (`finished` latch) and a loss never calls `save.record`.
7. Real-dt vs sdt split of §3.1 / §10 (a test can drive `step()` with a fake
   `timeScale()` of 0.05 and assert popups/pause-button animate at full speed).
8. `pointer` fed to `setTarget` is always inside the design box (clamped).
9. On `onEnter`, the previous run's particles are cleared and no popup survives.
10. Load-time asserts already in the core (keep them wired): `assertConfig()`,
    `checkDifficultyTable()` / `TABLE_PROBLEMS`, levels-vs-themes count, derived level
    fields recomputed-and-compared.

Performance notes (what Python caches because it is expensive — the Pixi analogues):

* Popup text: pre-render per popup, not per frame (§7).
* READY card: the panel + static text rows change only via `vis`; build once per
  `onEnter`, animate alpha/position/tint per frame. (Python re-renders text every
  frame but its `draw_panel`/glow surfaces are cached; Pixi should cache the whole
  card subtree.)
* The arena mask, HUD mask and the layer containers are created once, not per frame.
* `avoid` / `avoid_soft` are computed once per `onEnter` (hazard bounding circles are
  static by construction — bounds cover the full travel of moving hazards).
* `_restock`'s vet runs once per orb (the `_vetted` set) — do not "simplify" into a
  per-frame test (§5.2 explains why that deletes legal food).

---

## 13. Open questions / gaps

* **G1 (code change needed in `core/powerups.ts`):** the difficulty's power-up cadence
  (`powerupSpawnRange(diff)`, e.g. EASY ÷1.45, EXPERT ÷0.5) has no way in. Python
  swaps `field._roll_interval` on the instance and re-rolls the pending timer
  (`timer = roll() * uniform(0.55, 1.0)`). Proposal: add a public
  `setSpawnRange(lo, hi)` (or a `spawnRange` field consulted by `rollInterval`) that
  also re-rolls `timer` with the same `× uniform(0.55, 1.0)` shape so the very first
  rune respects the cadence. Until it exists, EASY/EXPERT rune pacing silently plays
  as NORMAL.
* **Q1 — field RNG seeding:** Python's `FoodField`/`PowerUpField` use a fresh,
  time-seeded `random.Random()` per construction; the TS classes default to *fixed*
  seeds (`0x5eed`, `0x50575546`) for test determinism. If the gameplay scene
  constructs them with defaults, every run of a level has identical orb layouts and
  rune timing. The scene should pass a varying seed (e.g. from `Math.random()` /
  `Date.now()`), keeping fixed seeds for tests. Decide and document.
* **Q2 — keyboard:** `InputManager` is pointer-only. Where do Esc/P (pause) and
  Space/Shift (boost) live — scene-level listeners or a shell keyboard facility?
  (Spec assumes the scene owns them; either is fine, but exactly one place.)
* **Q3 — `Game.step` ordering slots** for `particles.update` / `fx.update` and a
  `beginTransition()` call inside `switchScene` are reserved by this spec (§2.2, §2.4)
  but the hooks do not exist yet; the effects/particles specs should land them.
* **Q4 — pause during READY:** allowed in Python (button + Esc work during the
  countdown; `ready_timer` is real-dt but gameplay's `update` is blocked by the pause
  overlay, so the countdown effectively freezes). Port the same behaviour.
* **Q5 — integer-scale snap:** Python snaps near-integer window scales
  (`INTEGER_SCALE_SNAP`) and uses nearest-neighbour there; `Viewport` scales
  continuously. Accepted divergence for a vector/GPU renderer — confirm and close.
* **Q6 — `fonts.huge.render` cap:** the countdown digit clamps its display to
  `min(9, count)`; with `READY_TIME = 3` this can never exceed 3. Kept for fidelity;
  no decision needed (noted so nobody "fixes" it into a bug).
