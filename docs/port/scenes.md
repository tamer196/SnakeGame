# Port spec - the nine remaining scenes

**Ground truth (do not modify):**

| File | Lines | Scene classes |
|---|---|---|
| `E:/SnakeGame/snake/scenes/menu.py` | 834 | `MenuScene` |
| `E:/SnakeGame/snake/scenes/mode_select.py` | 1013 | `ModeSelectScene` |
| `E:/SnakeGame/snake/scenes/level_select.py` | 1054 | `LevelSelectScene` |
| `E:/SnakeGame/snake/scenes/pause.py` | 421 | `PauseScene` - the one transparent scene |
| `E:/SnakeGame/snake/scenes/help_scene.py` | 660 | `HelpScene` |
| `E:/SnakeGame/snake/scenes/gameover.py` | 1184 | `_ResultScene` base, `GameOverScene`, `VictoryScene` |
| `E:/SnakeGame/snake/scenes/settings.py` | 1176 | `SettingsScene` |
| `E:/SnakeGame/snake/scenes/story_scene.py` | 1155 | `StoryScene` |

**Companion specs:** `docs/port/ui.md` owns the *implementations* of every widget these scenes
call - `draw_panel`, `draw_text`, `draw_bar`, `Button`, `draw_cursor`, `draw_hud`, the font
book. This document records the *call sites*: what each scene asks for, with which arguments,
at which coordinates. That seam is deliberate - do not specify widget internals here.
`docs/port/integration.md` §2.4 gives the scene-stack semantics, §3-§6 the gameplay scene it
hands off to, §6.1 the `last_result` contract the two result screens consume, §10 the real-dt
rule (menu and overlay animation is shell-level and must not be scaled by `fx.time_scale()`),
and §11 the verified Python-to-TS name map.

Coordinate space throughout: **1280x720 design pixels**; `Viewport` uniform-scales and centres
it, and `viewport.overscan` is the whole screen in design units. Backgrounds may fill overscan;
scene chrome stays in the design box.

**The reuse rule that matters most:** scene instances are cached and reused by the shell
(`Game.makeScene`), so `onEnter` MUST fully reset every piece of state the scene owns. Each
section carries an owned-state table with the reset value for exactly this reason; forgetting is
the documented #1 bug source in this design.

---

## Status of this document

| Section | Source | Written | Audited |
|---|---|---|---|
| 1 Menu | menu.py | yes | no |
| 2 Mode select | mode_select.py | yes | no |
| 3 Level select | level_select.py | yes | no |
| 4 Pause / 5 Help | pause.py, help_scene.py | yes | no |
| 6 `_ResultScene` base | gameover.py:1-704 | yes | no |
| 7 Game over / 8 Victory | gameover.py:705-1184 | yes | no |
| **9 Settings** | **settings.py** | **not yet** | - |
| **10 Story** | **story_scene.py** | **not yet** | - |

The adversarial audit pass, and the cross-scene critic that was to assemble the whole navigation
graph and the session-state contract, **did not run** - both were cut off by a spend limit. So:

- Every coordinate here is a first-pass transcription; reread the cited line while implementing
  it, then compare against the capture.
- Nothing has yet checked the scenes against *each other*. The navigation graph, the
  `game.*` / `SaveData` read-write ordering, and the machinery several scenes duplicate (the
  scrolling-list focus idiom, the muted-theme treatment, the staged-reveal helper, keyboard-vs-
  mouse focus arbitration) are **not** consolidated anywhere. Do that before porting the second
  scene, or the port will grow four slightly different versions of each.
- Sections 9 and 10 must be written before those scenes are ported.

Each section did cross-check itself against its reference capture and against the ported TS
core, and reported gaps in that core; those are collected in the appendix.

Verification is perceptual (screenshots vs `E:/SnakeGame/captures/*.png` at 1280x720, which is
exactly the design space), never pixel-diff. The captures, in scene order:
`01-menu`, `02-mode-select`, `03-level-select`, `04-settings`, `05-story-chapter`,
`06-story-card`, `07-help`, `08-gameplay-ready`, `09-pause`, `10-gameover`, `11-victory`,
`12-victory-story`, `13-victory-final`.

---
## 1. The title menu (`MenuScene`)

Ground truth: `E:/SnakeGame/snake/scenes/menu.py`, lines 1-834 (the whole file).
Reference capture: `E:/SnakeGame/captures/01-menu.png`.

Suggested TS home: **`web/src/scenes/MenuScene.ts`** — `export class MenuScene extends Scene`,
constructed like `GameplayScene` is in `web/src/main.ts:54`:
`game.registerScene("menu", (g) => new MenuScene(g, save, sound))`. Two menu-local helpers
deserve their own small modules rather than being inlined:

| Python | Suggested TS |
|---|---|
| `_blend_themes` / `_quantise` (menu.py:99-132) | `web/src/gfx/themeBlend.ts` → `blendThemes(a, b, t)`, `quantise(v, steps)` — the level-select and mode-select scenes carousel too |
| `_TitleArt` / `_additive_copy` (menu.py:138-178) | `web/src/gfx/Wordmark.ts` → `class Wordmark` (a `Container` holding three `Text` objects) |
| `_badge_surface` / `_BADGE_CACHE` (menu.py:186-218) | `web/src/gfx/DifficultyBadge.ts` → `class DifficultyBadge` (a `Container`); reused by mode-select and settings |

`draw_panel`, `draw_text`, `draw_bar`, `Button` and the font book are **owned by
`docs/port/ui.md`**. Every reference below records the call site and its arguments only.

---

### 1.1 Identity and registration

| Property | Value | Source |
|---|---|---|
| Python class | `MenuScene(Scene)` | menu.py:224 |
| File / lines | `snake/scenes/menu.py`, 224-834 (module 1-834) | |
| Registry key | `C.SCENE_MENU` = `"menu"` → `("menu", "MenuScene")` | main.py:34; config.py:191 |
| TS key | `SCENES.MENU` = `"menu"` (`web/src/app/Scene.ts:66`) | |
| `transparent` | `False` | menu.py:227 |
| `blocks_update` | `True` | menu.py:228 |
| Boot entry | `Game.run(start_scene=C.SCENE_MENU)` — this is the first scene the process shows | main.py:479-480 |
| Who else arrives here | `switch_scene(C.SCENE_MENU)` from mode-select / level-select / help / settings / game-over "back" paths, and `SettingsScene` is handed `back=C.SCENE_MENU` by this scene (menu.py:441) | |
| Who this scene leaves to | `SCENE_MODE`, `SCENE_LEVELS`, `SCENE_HELP`, `SCENE_SETTINGS`, `game.quit()` — see §1.15 | menu.py:427-443 |

The menu is **pure routing**: it never constructs a level, never writes `game.level_index`,
and never starts a run (menu.py:16-24).

---

### 1.2 Scene-local tuning constants

All of these live in the module header of `menu.py` and are **not** in `config.json`.
Put them at the top of `MenuScene.ts` as module `const`s; do not add them to `config.ts`
(`export_data.py` does not emit them, so a value in `config.ts` would drift).

| Name | Value | Line | Meaning |
|---|---|---|---|
| `THEME_PERIOD` | `11.0` s | 63 | how long one theme holds the screen |
| `THEME_FADE` | `2.4` s | 65 | cross-fade at the end of each period |
| `THEME_BLEND_STEPS` | `8` | 70 | blend weight quantisation (see §1.6) |
| `BUTTON_TOP` | `336` | 73 | y centre of button 0 |
| `BUTTON_PITCH` | `C.UI_BUTTON_H + 13` = **71** | 74 | `UI_BUTTON_H` = 58 (`config.ts:144`) |
| `BUTTON_ENTRANCE` | `0.52` s | 76 | per-button slide duration |
| `BUTTON_STAGGER` | `0.075` s | 77 | delay added per button index |
| `BUTTON_SLIDE` | `190.0` px | 78 | horizontal travel during the entrance |
| `TITLE_TEXT` | `C.GAME_TITLE` = `"NEON SERPENT"` | 80 | `config.ts:46` |
| `TITLE_MAX_W` | `C.WINDOW_W - 200` = **1080** | 81 | shrink-to-fit ceiling |
| `DEMO_MARGIN` | `96.0` px | 84 | demo-snake safe inset |
| `DEMO_SPEED` | `196.0` px/s | 85 | assigned to `snake.speed` |
| `DEMO_LENGTH` | `30` | 86 | segments |
| `DEMO_HAIRPIN_CHANCE` | `0.55` | 88 | chance a wander leg queues hairpins |
| `DEMO_HAIRPIN_REACH` | `(150.0, 240.0)` px | 90 | how far behind the head a hairpin target sits |
| `RING_PERIOD` | `2.9` s | 93 | base gap between ambient shockwaves |

Constants pulled from elsewhere: `C.WINDOW_W/H` = 1280/720, `C.UI_BUTTON_W/H` = 300/58,
`C.MAX_DT` = 0.05, `C.VERSION` = `"1.0.0"`, `C.MODE_FREE` = `"free"`, `C.GAME_SUBTITLE` =
`"a mouse-driven arcade odyssey"`, `LEVEL_COUNT` = 12.

---

### 1.3 Owned state

`__init__` is menu.py:230-256; `on_enter` is menu.py:261-277.

| Attribute | Type | `__init__` value | `on_enter` resets to | Notes |
|---|---|---|---|---|
| `_t` | float | `0.0` | `0.0` (264) | scene clock, **real dt** |
| `_entered` | float | `0.0` | `0.0` (265) | seconds since entry; drives every entrance |
| `_theme` | `P.Theme` | `P.THEMES[0]` | `P.THEMES[0]` (268) | the *blended* theme, rewritten every frame |
| `_theme_index` | int | `0` | `0` (266) | index into `P.THEMES` |
| `_theme_blend` | float | `0.0` | `0.0` (267) | quantised 0..1 cross-fade weight |
| `_backgrounds` | `Dict[int, Background]` | `{}` | `.clear()` (269) | lazy per-theme background cache, ≤3 kept |
| `_fade_layer` | `Optional[Surface]` | `None` | **not reset** | scratch layer for the cross-fade; cleared in `on_exit` (284) |
| `_title_art` | `Optional[_TitleArt]` | `None` | `None` (270) | cached wordmark surfaces |
| `_title_key` | `Any` | `None` | `None` (271) | `(theme_index, theme_blend)` the cache was built for |
| `_buttons` | `List[Button]` | `[]` | rebuilt by `_build_buttons()` (275) | 5 buttons, fresh instances |
| `_base_rects` | `List[pygame.Rect]` | `[]` | rebuilt by `_build_buttons()` (275) | resting rects; the entrance animates `button.rect` away from these |
| `_demo` | `Optional[Snake]` | `None` | fresh `Snake` via `_spawn_demo()` (274) | |
| `_demo_target` | `(float, float)` | `(640.0, 360.0)` | `_pick_target()` inside `_spawn_demo` (349) | |
| `_demo_timer` | float | `0.0` | `0.0` (351) | counts **down**; `<= 0` picks a new leg |
| `_demo_hairpins` | int | `0` | `0` (352) | queued hairpin legs |
| `_ring_timer` | float | `RING_PERIOD` = 2.9 | `RING_PERIOD` (272) | counts down to the next shockwave |
| `_rng` | `random.Random(0xC0FFEE)` | seeded once | **not reset** | see below |

**Attributes built in `__init__` but not reset in `on_enter`:**

1. `_rng` — **safe, but a deliberate determinism divergence.** The stream is *not* reseeded,
   so the second visit to the menu gets a different demo-snake wander than the first. That is
   cosmetic and arguably desirable (the attract mode does not repeat itself). Port note: seed
   `makeRng(0xC0FFEE)` (`core/mathx.ts:97`) **in the constructor, not in `onEnter`**, to keep
   the same behaviour. Bit-parity with Python is impossible here (Mersenne Twister vs the TS
   LCG) — this is a *visual* parity target only.
2. `_fade_layer` — **safe, and disappears in the port.** It exists only because pygame cannot
   alpha-blend an opaque gradient surface without a scratch copy (menu.py:634-644). In Pixi the
   cross-fade is `nextBackground.root.alpha = themeBlend`; drop the field.

Everything else *is* fully reset, and that matters: `on_enter` is wrapped in a bare
`try/except: pass` (menu.py:262-277), so if `_spawn_demo` or `_build_buttons` throws, the scene
comes up with a **stale button list from the previous visit** and no demo snake. The port should
keep the "never throw" posture but reset the plain fields *before* the two builders, exactly as
Python does, so a builder failure cannot resurrect old geometry.

Module-level state, not per-instance:

| Name | Line | Reset? | Port note |
|---|---|---|---|
| `_BADGE_CACHE: Dict[key, Surface]` | 186 | never; self-evicts when `len > 32` (215-216) | keyed `(label, colour&0xFF per channel, id(font))`. In TS a single `DifficultyBadge` instance per scene, `redraw()`d when the difficulty changes, is simpler and needs no cache. |

---

### 1.4 Construction vs entry

| Built once (`__init__`) | Built on every entry (`on_enter`) | Built lazily, per frame |
|---|---|---|
| the RNG (`0xC0FFEE`) | the five `Button` instances and their `_base_rects` (`_build_buttons`, 321-341) | one `Background` per theme index (`_background`, 509-520), on first use |
| empty containers | the demo `Snake` + its first target/timer (`_spawn_demo`, 343-351) | `_TitleArt` for the current quantised theme (`_title_surfaces`, 646-660) |
| | the theme carousel back to index 0 / blend 0 | the difficulty badge pill (`_badge_surface`, 189-218), cached by label+colour |
| | `_ring_timer` back to 2.9 | |

`on_exit` (menu.py:279-286) drops **only** `_backgrounds` and `_fade_layer`, with the comment
"Backgrounds hold pre-rendered full-screen surfaces; drop them so the menu does not keep a dozen
of them alive while the game is running." The Pixi equivalent must call `background.destroy()`
on each (`gfx/bg/Background.ts:107`) — Pixi textures are not garbage collected.

Two things `on_enter` deliberately does **not** do:

* it does not call `game.particles.clear()`, so motes and ring outriders drift across the
  transition into and out of the menu (contrast `gameplay.on_enter`, which clears);
* it does not touch `game.mode` / `game.difficulty` / `game.level_index`. The badge merely
  *reports* `game.difficulty` (§1.10).

**Port sizing warning.** Python builds each background for the fixed design box
`(0, 0, C.WINDOW_W, C.WINDOW_H)` (menu.py:516). Per the settled convention the port builds
backgrounds at `game.viewport.overscan` instead (as `GameplayScene.rebuildBackground` does,
`web/src/scenes/GameplayScene.ts:173-179`), which means `onResize` must rebuild whichever
backgrounds are cached. Keep Python's ≤3 eviction (menu.py:504-507) — twelve overscan-sized
background stages held live would be the single heaviest thing in the app.

---

### 1.5 The animated title treatment

The wordmark is five layers deep and every one of them moves. There is **no per-letter or
per-glyph animation** anywhere: `TITLE_TEXT` is rendered as one string and the whole block is
animated rigidly. Do not invent a per-glyph stagger in the port.

#### 1.5.1 `_TitleArt` — the three cached surfaces (menu.py:157-178)

Built from `self.game.fonts.huge` (menu.py:652), which is `display_at(96)`
(`snake/gfx/fonts.py:63`).

```
base = font.render(TITLE_TEXT, True, (255, 255, 255))
if base.width > TITLE_MAX_W (1080):
    scale = 1080 / base.width; base = smoothscale(base, (w*scale, h*scale))
```

Measured against the shipped font book: `base` is **699 x 96 px**, so the shrink-to-fit branch
never fires for `"NEON SERPENT"` at 1280 wide. It is a real guard for a substituted face,
though — keep it.

| Surface | Colour expression | Blit mode |
|---|---|---|
| `art.body` | `lerp_color(theme.text, P.UI_WHITE, 0.55)` — theme 0: `(239, 245, 255)` | normal (alpha) |
| `art.left` | `_additive_copy(base, shade(theme.accent, 0.85))` — theme 0: `(0, 200, 216)` | `BLEND_RGB_ADD` |
| `art.right` | `_additive_copy(base, shade(theme.accent2, 0.85))` — theme 0: `(216, 51, 161)` | `BLEND_RGB_ADD` |
| `art.width` / `art.height` | `699` / `96` | |

`_additive_copy` (menu.py:138-154) exists purely to premultiply coverage into RGB against opaque
black, because pygame's additive blit would otherwise add a solid rectangle. **The port does not
need it**: three Pixi `Text` objects with `blendMode = "add"` on two of them, tinted by
`toHex(...)`, are exactly equivalent and cost no extra rasterisation.

Rebuild key (menu.py:648): `(self._theme_index, self._theme_blend)`. Because the blend is
quantised to 8 steps (§1.6) the three tints change at most 9 times per cross-fade, i.e. ~9 tint
writes per 11 s. In Pixi this is a `tint` assignment on three existing `Text` objects — never a
re-render, never a new object.

#### 1.5.2 Paint order of the logo (menu.py:662-694)

Let `cx = 640.0`, `top = 116.0`, `t = self._t`, `entered = self._entered`.

```
k      = ease_out_back(clamp(entered / 0.62, 0, 1))
top   -= (1 - k) * 60.0                       # drops in from y = 56
breathe = pulse(t, 0.9)          = 0.5 + 0.5*sin(t*0.9)        period 6.98 s
glow_y = top + art.height * 0.52 = top + 49.92
split  = 1.5 + 3.5 * pulse(t*0.85, 1.0)                        period 7.39 s, range 1.5..5.0
wob    = sin(t * 1.7) * 1.4                                    period 3.70 s, range -1.4..+1.4
x      = int(cx - art.width * 0.5) = int(290.5) = 290
y      = int(top)                  = 116 at rest
```

| # | Layer | Geometry | Colour | Blend |
|---|---|---|---|---|
| 1 | under-glow, 9 stamps | `draw_glow_circle(surface, gx_i, glow_y, 86.0, col_i, 0.30 + 0.16*breathe)` for `i in 0..8`, `gx_i = cx + (i/8 - 0.5) * art.width * 0.92` | `col_i = lerp_color(theme.accent, theme.accent2, i/8)` | additive |
| 2 | left chromatic fringe | `art.left` at `(int(x - split), int(y + wob))` | `shade(accent, 0.85)` | `BLEND_RGB_ADD` |
| 3 | right chromatic fringe | `art.right` at `(int(x + split), int(y - wob))` | `shade(accent2, 0.85)` | `BLEND_RGB_ADD` |
| 4 | body | `art.body` at `(x, y)` | `lerp(text, UI_WHITE, 0.55)` | normal |
| 5 | tagline | see §1.5.3 | | normal |

The nine glow stamps, resolved for the shipped 699 px wordmark
(`step = 699*0.92/8 = 80.385`, radius `86.0` each, `glow_y = 165.92` at rest):

| i | gx | colour weight (accent→accent2) |
|---|---|---|
| 0 | 318.46 | 0.000 |
| 1 | 398.85 | 0.125 |
| 2 | 479.23 | 0.250 |
| 3 | 559.62 | 0.375 |
| 4 | 640.00 | 0.500 |
| 5 | 720.38 | 0.625 |
| 6 | 800.77 | 0.750 |
| 7 | 881.15 | 0.875 |
| 8 | 961.54 | 1.000 |

Together they read as one soft horizontal bar of light behind the letters, gradient-shifting from
`accent` on the left to `accent2` on the right. TS: nine `Sprite`s from
`glowSprite(86, col, intensity)` (`gfx/textures.ts:255`), created once in the constructor, with
`setGlow(sprite, 86, col_i, 0.30 + 0.16*breathe)` per frame — `setGlow` swaps the texture only
when the quantised radius changes, so this is two property writes per stamp per frame.

`ease_out_back` overshoots (`contracts.py:207-211`, `c3 = 2.70158`): `k` peaks at ≈1.0999
around `t≈0.6`, so `top` dips ≈6 px **below** 116 mid-entrance before settling. Keep it —
that overshoot is the whole character of the drop-in.

#### 1.5.3 Tagline (menu.py:696-702)

```
sub = "{}   -   {}".format(C.GAME_SUBTITLE.upper(), theme.name.upper())
```

Three spaces, hyphen-minus, three spaces. With theme 0 that is
`"A MOUSE-DRIVEN ARCADE ODYSSEY   -   NEON GRID"` (488 x 28 px in `fonts.body`).

| Field | Value |
|---|---|
| position | `(cx, y + art.height + 6)` = `(640, 218)` at rest — note it uses the **int**-truncated `y`, not `top` |
| align | `center` (`draw_text` treats `pos[1]` as the **top** edge) |
| font | `fonts.body` (21 pt → 28 px line box) |
| colour | `lerp_color(theme.text_dim, theme.accent, 0.35 + 0.25*breathe)` — the whole tagline breathes toward the accent on the same 6.98 s clock as the under-glow |
| condition | drawn whenever `_title_surfaces()` returns non-null |

The theme name is live, so the tagline is how the player can read the carousel. **The string
changes every 11 s**, which is the one place in this scene where a Pixi `Text` genuinely has to
re-render; guard it with `if (text.text !== next) text.text = next`.

#### 1.5.4 Version stamp and footer hint (`_draw_footer`, menu.py:824-834)

| Element | Position | Align | Font | Colour |
|---|---|---|---|---|
| `"v{C.VERSION}"` = `"v1.0.0"` | `(C.WINDOW_W - 20, C.WINDOW_H - 26)` = `(1260, 694)` | right | `fonts.tiny` | `shade(theme.text_dim, 0.7)` |
| `"MOUSE STEERS  -  RIGHT-CLICK BOOSTS  -  ENTER PLAYS"` | `(C.WINDOW_W * 0.5, C.WINDOW_H - 26)` = `(640, 694)` | center | `fonts.tiny` | `shade(theme.text_dim, 0.8)` |

Both are unconditional and unanimated (their colour follows the carousel only). Note the
separators here are **two** spaces around the hyphen, not three.

#### 1.5.5 Idle / attract behaviour

There is no timeout, no demo-play handoff and no screen-saver state. "Attract mode" is
continuous and consists of exactly four things, all running from frame one:

1. the twelve-theme carousel with cross-fades (§1.6);
2. the self-steering demo snake with scheduled hairpins (§1.7);
3. drifting motes + a shockwave ring every ~2.9 s (§1.8);
4. the breathing wordmark (§1.5.2).

Nothing escalates and nothing resets after N seconds. The scene will run forever.

---

### 1.6 The theme carousel (`_update_theme`, menu.py:480-520)

```
n          = len(P.THEMES) = 12
cycles     = _t / THEME_PERIOD                 # 11.0
index      = int(cycles) % 12
frac       = cycles - floor(cycles)
fade_start = 1.0 - THEME_FADE / THEME_PERIOD   = 1 - 2.4/11 = 0.7818181818...
raw        = 0.0                       if frac <  fade_start
           = (frac - fade_start) / (1 - fade_start)   otherwise   # /0.21818...
_theme_index = index
_theme_blend = _quantise(raw, 8) = round(clamp(raw, 0, 1) * 8) / 8
_theme       = _blend_themes(THEMES[index], THEMES[(index+1) % 12], _theme_blend)
```

So each theme holds for 8.6 s and cross-fades over the last 2.4 s.

`_blend_themes` (menu.py:99-127): returns `a` when `t <= 0.001`, `b` when `t >= 0.999`,
otherwise a synthetic `Theme` whose **twelve colours are each `lerp_color(a.X, b.X, t)`** and
whose `name` and `bg_style` come from `lead = b if t >= 0.5 else a` (they are not
interpolatable). TS: `blendThemes(a, b, t): Theme` — must also recompute the `hex` mirror
(`core/palette.ts:232-245`), because every Pixi tint reads from it.

`_quantise` (menu.py:130-132) exists **only** because pygame's UI helpers cache surfaces per
colour and a continuously varying colour would mint a new surface every frame (menu.py:66-70).
That reason evaporates in Pixi. **Keep the quantisation anyway** — it is visible: the fade is
stepped in 1/8ths and matches the captures. It also keeps the `_TitleArt` rebuild count at 9
per cross-fade instead of 144.

Background lifecycle inside `_update_theme`:

| Step | Rule |
|---|---|
| current | `_background(index)`, then `.update(dt)` — **real dt** |
| incoming | only if `raw > 0.0`: `_background((index+1) % 12)`, then `.update(dt)` |
| eviction | if `len(_backgrounds) > 3`: keep `{index, (index+1) % 12, (index-1) % 12}` (Python's `%` is non-negative, so index 0 keeps 11), pop the rest |

Note the asymmetry: the incoming background starts *updating* when `raw > 0` but is not
*drawn* until `_theme_blend > 0.001` (menu.py:629), i.e. until `raw` quantises up off zero.

`_background(index)` (509-520) builds `make_background(theme.bg_style, theme, (0,0,1280,720))`
and caches it; on any exception it returns `None` and `_draw_background` falls back to
`surface.fill(self._theme.bg_bottom)` (menu.py:625).

---

### 1.7 The demo snake (`_spawn_demo` / `_pick_target` / `_hairpin_target` / `_next_demo_leg` / `_update_demo`)

#### 1.7.1 Spawn (menu.py:343-351)

```
heading = _rng.uniform(0.0, math.tau)
_demo   = Snake(C.WINDOW_W * 0.5, C.WINDOW_H * 0.62, heading=heading, length=DEMO_LENGTH)
        = Snake(640.0, 446.4, heading, 30)
_demo.speed    = DEMO_SPEED = 196.0
_demo_target   = _pick_target()
_demo_timer    = 0.0
_demo_hairpins = 0
```

TS: `new Snake(640, 446.4, heading, 30)` then `snake.speed = 196`
(both public, `core/snake.ts:233-242`). For the re-spawn path prefer
`snake.reset(640, 446.4, heading, 30)` (`core/snake.ts:551`) so the object is reused.

#### 1.7.2 `_pick_target` (menu.py:353-362) — biased wander point

```
for _ in range(6):
    x = _rng.uniform(96.0, 1184.0)                     # DEMO_MARGIN .. W-DEMO_MARGIN
    y = _rng.uniform(156.0, 624.0)                     # DEMO_MARGIN+60 .. H-DEMO_MARGIN
    if abs(x - 640.0) > 240.0 or y < 300.0:
        return (x, y)
return (640.0, 360.0)                                   # (W*0.5, H*0.5)
```

Accepted region: `x ∈ [96, 400) ∪ (880, 1184]` **or** `y < 300`. That keeps the snake out of
the 480-px-wide button column below y=300, so it weaves around the UI instead of hiding behind
it (menu.py:358-359).

#### 1.7.3 `_hairpin_target` (menu.py:364-380) — a point *behind* the head

```
hx, hy = snake.head_pos()
ang    = snake.heading + math.pi + _rng.uniform(-0.55, 0.55)
reach  = _rng.uniform(150.0, 240.0)
x      = clamp(hx + cos(ang) * reach,  96.0, 1184.0)
y      = clamp(hy + sin(ang) * reach, 156.0,  624.0)
```

Because v2 turning is constant-*radius*, this always resolves into a tight readable loop that
passes over the snake's own neck (menu.py:365-371) — it is the advertisement for the movement
model and the reason the crossing-shadow render path is exercised on the title screen.

#### 1.7.4 `_next_demo_leg` (menu.py:382-392)

```
if _demo_hairpins > 0:
    _demo_hairpins -= 1
    _demo_target = _hairpin_target()
    _demo_timer  = _rng.uniform(1.3, 2.1)
    return
_demo_target = _pick_target()
_demo_timer  = _rng.uniform(2.2, 4.0)
if _rng.random() < DEMO_HAIRPIN_CHANCE (0.55):
    _demo_hairpins = _rng.randint(1, 2)          # inclusive both ends
```

#### 1.7.5 `_update_demo(dt)` — exact order (menu.py:522-568)

| # | Operation |
|---|---|
| 1 | `if snake is None: return` |
| 2 | `_demo_timer -= dt` |
| 3 | `hx, hy = snake.head_pos()` |
| 4 | `outside = not (96 <= hx <= 1184 and 96 <= hy <= 624)` — **note the y lower bound here is 96, not the 156 used by `_pick_target`** |
| 5 | if `outside`: `_demo_target = (640.0, 360.0)`; `_demo_timer = max(_demo_timer, 1.2)`; `_demo_hairpins = 0` |
| 6 | `elif _demo_timer <= 0.0 or dist(hx, hy, *_demo_target) < 70.0`: `_next_demo_leg()` |
| 7 | `snake.set_target(*_demo_target)` |
| 8 | `snake.update(dt)` — no `boost`, no `speed_mult`, no `turn_mult`; TS `snake.update(dt)` |
| 9 | re-read `hx, hy = snake.head_pos()`; if `not (-200 <= hx <= 1480 and -200 <= hy <= 920)`: `_spawn_demo(); return` (**skips the trail and spark emission for that frame**) |
| 10 | `game.particles.trail(hx, hy, theme.snake_a, dt, rate=22.0, speed=(6.0, 30.0), life=(0.3, 0.75), radius=(1.6, 3.6), ribbon=0.3, color_end=theme.snake_b)` |
| 11 | `turn = float(snake.turn_input)` (0.0 on any exception) |
| 12 | if `abs(turn) > 0.65`: `side = snake.heading + (pi*0.5 if turn < 0.0 else -pi*0.5)`; `game.particles.stream(hx, hy, side, theme.accent2, dt, rate=26.0, speed=(50.0, 130.0), spread=0.5, life=(0.18, 0.4), radius=(1.4, 3.0))` |

Step 12 throws sparks off the **outside** of the turn, "so a hairpin actually looks like it
costs something" (menu.py:556-557). `snake.turn_input` is TS `snake.turnInput`
(`core/snake.ts:200`, public).

The demo snake advances on **real dt**: `MenuScene` is shell-level chrome and nothing in this
file reads `fx.time_scale()` (see §1.13).

Drawn by `draw_snake(surface, self._demo, self._theme, self._t)` (menu.py:608) — no `ghost`,
no `shield`, and the time argument is the scene clock `_t`. TS: one `SnakeRenderer` instance
(`gfx/SnakeRenderer.ts:299`), `snakeView.draw(demo, theme, this.t)`.

---

### 1.8 Ambience (`_update_ambience`, menu.py:461-478)

```
mid = lerp_color(theme.accent, theme.accent2, 0.5)
game.particles.ambient((0, 0, C.WINDOW_W, C.WINDOW_H), mid, dt,
                       rate=9.0, turbulence=0.12, twinkle=0.3)

_ring_timer -= dt
if _ring_timer <= 0.0:
    _ring_timer = RING_PERIOD * _rng.uniform(0.8, 1.3)          # 2.32 .. 3.77 s
    side = -1.0 if _rng.random() < 0.5 else 1.0
    x    = C.WINDOW_W * 0.5 + side * _rng.uniform(300.0, 520.0)  # [120,340] ∪ [940,1160]
    y    = _rng.uniform(180.0, C.WINDOW_H - 120.0)               # [180, 600]
    game.particles.ring(x, y, theme.accent2, radius=_rng.uniform(40, 90),
                        count=14, life=1.1, speed=70.0, color_end=theme.accent)
```

Rings are placed **off the button column** deliberately, "so they read as weather, not as UI
feedback" (menu.py:471-472). The ambient rect is the whole **design box**, not the overscan —
in the port, motes must not spawn into the letterbox bars even though the background does fill
them.

First ring fires at `_t = 2.9` s exactly (the initial `_ring_timer`), then every 2.32-3.77 s.

TS: the option objects already match name-for-name —
`particles.ambient(rect, mid, dt, { rate: 9, turbulence: 0.12, twinkle: 0.3 })`,
`particles.ring(x, y, accent2, { radius, count: 14, life: 1.1, speed: 70, colorEnd: accent })`
(`gfx/particles.ts:445-467, 854, 951`).

---

### 1.9 The button stack

#### 1.9.1 Entries, in order (`_build_buttons`, menu.py:321-341)

`cx = C.WINDOW_W // 2 = 640`; rect `i` is `(0, 0, C.UI_BUTTON_W, C.UI_BUTTON_H)` = 300 x 58
with `center = (640, BUTTON_TOP + i * BUTTON_PITCH)`.

| i | `data` key | Label | `style` | `font` | Resting rect (x, y, w, h) | centre | Target |
|---|---|---|---|---|---|---|---|
| 0 | `"play"` | `_play_label()` → `"CONTINUE"` if a story run is part-way, else `"PLAY"` | `primary` | `None` (Button default) | `(490, 307, 300, 58)` | `(640, 336)` | `switch_scene(SCENE_MODE)` |
| 1 | `"levels"` | `"LEVELS"` | `primary` | `None` | `(490, 378, 300, 58)` | `(640, 407)` | `game.mode = MODE_FREE`, then `switch_scene(SCENE_LEVELS)` |
| 2 | `"help"` | `"HOW TO PLAY"` | `ghost` | `fonts.body` | `(490, 449, 300, 58)` | `(640, 478)` | `switch_scene(SCENE_HELP)` |
| 3 | `"settings"` | `"SETTINGS"` | `ghost` | `fonts.body` | `(490, 520, 300, 58)` | `(640, 549)` | `switch_scene(SCENE_SETTINGS, back=SCENE_MENU)` |
| 4 | `"quit"` | `"QUIT"` | `danger` | `None` | `(490, 591, 300, 58)` | `(640, 620)` | `game.quit()` |

Only the two `ghost` buttons are handed an explicit font, and only if `game.fonts` exists
(menu.py:338-339). `_play_label()` (menu.py:315-316) is evaluated **once per entry**, at build
time — a save change while the menu is open would not relabel the button. Safe in practice
(nothing mutates the save while the menu is up), but do not "improve" it into a per-frame
lookup or the label will start flickering during the ui-kit's cached-text path.

#### 1.9.2 Entrance animation (`_update_buttons`, menu.py:570-591; `_button_alpha`, 593-596)

```
local = _entered - i * BUTTON_STAGGER            # 0.075 s per index
if local < BUTTON_ENTRANCE (0.52):
    k    = ease_out_back(clamp(local / 0.52, 0, 1))
    side = -1.0 if (i % 2 == 0) else 1.0         # even indices fly in from the LEFT
    button.rect.centerx = int(base.centerx + side * BUTTON_SLIDE (190) * (1 - k))
else:
    button.rect.centerx = base.centerx
button.rect.centery = base.centery               # unconditional, every frame
```

| i | comes in from | finishes at `_entered =` | first drawn at `_entered >` |
|---|---|---|---|
| 0 | left (`-190`) | 0.520 | 0.000 |
| 1 | right (`+190`) | 0.595 | 0.075 |
| 2 | left | 0.670 | 0.150 |
| 3 | right | 0.745 | 0.225 |
| 4 | left | 0.820 | 0.300 |

`ease_out_back`'s overshoot means `(1 - k)` goes to about `-0.0999`, so each button overshoots
its resting centre by ≈19 px to the opposite side before settling.

**`_button_alpha` is a gate, not an alpha.** `_draw_buttons` (menu.py:719-724) does
`if self._button_alpha(i) <= 0.0: continue` and then draws the button at full opacity — the
returned `clamp(local / (0.52 * 0.6 = 0.312), 0, 1)` weight is **never applied**. So the
visible behaviour is a hard cut-in at `local > 0`, i.e. at `_entered > i * 0.075`, followed by
a slide. Port that exactly (hard cut, then slide); do not "fix" it into a fade, and do not
delete `_button_alpha` — keep it as the gate so the intent stays legible.

Note also that `Button.update` runs for a button that is not yet being drawn, so a button can
become `hovered` (and fire the hover cue, §1.16) one frame *before* it first appears.

#### 1.9.3 Selection highlight — hover only; there is no keyboard index

This is the important design fact and it must not be "improved" in the port:

* **There is no selected-index state.** No `_selected`, no cursor, no focus ring. The only
  highlight is `Button.hovered`, computed inside `Button.update(dt, mouse_pos)` as
  `rect.collidepoint(int(mouse.x), int(mouse.y)) and enabled` (`ui.py:451-457`), and separately
  set by `Button.handle_event` on `MOUSEMOTION` (`ui.py:473-475`).
* **Keyboard keys are direct actions, not navigation.** Every binding in §1.15 calls
  `_activate(...)` immediately. Nothing moves a highlight, so "keyboard index vs mouse hover"
  can never disagree — the question does not arise in this scene.
* The docstring is explicit: "Every action is reachable with the mouse alone; the keyboard
  shortcuts are a convenience layer on top and never the only route" (menu.py:29-30).
* Consequence for touch: hover never happens on a touch device, so the buttons must remain
  fully operable from a tap. `Button.handle_event` requires the press *and* the release to land
  inside the rect (`ui.py:476-484`), which is already tap-compatible; the port's pointer
  plumbing must deliver both.

---

### 1.10 The difficulty badge

#### 1.10.1 `_badge_surface(label, color, font)` (menu.py:189-218)

Menu-local, **not** part of the ui kit, so it is specified here in full.

| Step | Value |
|---|---|
| cache key | `(label, tuple(int(c) & 0xFF for c in color), id(font))`; cache cleared wholesale when `len > 32` |
| text metrics | `text_w, text_h = font.size(label)`, falling back to `(60, 14)` when `font` is not a `pygame.font.Font` or `size()` throws |
| `w` | `int(text_w) + 30` |
| `h` | `max(24, int(text_h) + 12)` |
| surface | `pygame.Surface((w, h), SRCALPHA)` |
| fill | `pygame.draw.rect(surf, with_alpha(P.UI_PANEL, 232), (0, 0, w, h), border_radius=h // 2)` |
| border | `pygame.draw.rect(surf, with_alpha(color, 200), (0, 0, w, h), 2, border_radius=h // 2)` |
| label | `draw_text(surf, label, font, lerp_color(color, P.UI_WHITE, 0.35), (w * 0.5, (h - text_h) * 0.5), align="center", shadow=False)` |

For the shipped `fonts.tiny` (14 pt → 19 px line box) the four difficulties measure:

| difficulty | `hud_label` | `fonts.tiny.size()` | badge `w x h` | `color` |
|---|---|---|---|---|
| easy | `EASY` | (31, 19) | 61 x 31 | `(86, 240, 160)` |
| normal | `NORMAL` | (56, 19) | 86 x 31 | `(96, 202, 255)` |
| hard | `HARD` | (35, 19) | 65 x 31 | `(255, 168, 72)` |
| expert | `EXPERT` | (45, 19) | **75 x 31** | `(255, 84, 132)` |

(`web/src/data/difficulty.json`, key `modes[].hud_label` / `modes[].color`; the metrics are
measured off the shipped desktop `fonts.tiny`. The **height is font-driven, not fixed** —
`h = max(24, text_h + 12)` — so whatever face ui.md lands on will move all four widths and may
move `h`. Re-measure there; only `EXPERT` at 75 x 31 is confirmed against the capture.)

`border_radius = h // 2 = 15`, i.e. a full pill. TS: one `Graphics` rounded rect + one `Text`,
inside a `Container`; rebuild only when `(label, color)` changes.

#### 1.10.2 `_draw_difficulty_badge` (menu.py:734-762)

```
if not _base_rects or _entered < 0.35: return
diff  = get_difficulty(getattr(game, "difficulty", None))
badge = _badge_surface(diff.hud_label, tuple(int(c) for c in diff.color), fonts.tiny)
rect  = _base_rects[0]                                  # (490, 307, 300, 58); right = 790
k     = ease_out_back(clamp((_entered - 0.35) / 0.45, 0, 1))
x     = int(rect.right + 16 + (1 - k) * 40.0)           # 846 -> 806, overshoots to 802
y     = int(rect.centery - badge.height * 0.5)          # int(336 - 15.5) = 320
draw_glow_circle(surface, x + badge.width * 0.5, rect.centery,
                 badge.width * 0.75, diff.color,
                 (0.22 + 0.12 * pulse(_t, 1.1)) * k)
badge.set_alpha(int(255 * clamp(k, 0, 1))); surface.blit(badge, (x, y)); badge.set_alpha(255)
draw_text(surface, "DIFFICULTY", fonts.tiny, shade(theme.text_dim, 0.85),
          (x, rect.centery - badge.height * 0.5 - 17))     # left-aligned
```

Resting values for EXPERT (75 x 31): badge at `(806, 320)`; glow centre `(843.5, 336)`,
radius `56.25`, intensity `0.22 + 0.12*pulse(t, 1.1)` (period 5.71 s); `"DIFFICULTY"` at
`(806, 303)` — `draw_text` truncates, `336 - 15.5 - 17 = 303.5 → 303`.

Two details that matter: the badge sits **outside** the button so it never fights the button's
own hover scale (menu.py:737-738); and `set_alpha(255)` is restored after the blit because the
surface is shared out of `_BADGE_CACHE`. The glow's intensity uses the **unclamped** `k`, so it
briefly reaches `0.34 * 1.0999 ≈ 0.374` during the overshoot, while the badge's own alpha uses
the clamped one.

---

### 1.11 The stats panel (`_draw_stats_panel`, menu.py:764-808; `_story_summary`, 810-822)

```
if game.save is None: return
k     = ease_out_back(clamp((_entered - 0.18) / 0.6, 0, 1))
panel = pygame.Rect(int(34 - (1 - k) * 260.0), C.WINDOW_H - 204, 286, 170)
draw_panel(surface, panel, theme, alpha=206, glow=0.25 + 0.12 * pulse(_t, 1.3))
```

Resting rect: **`(34, 516, 286, 170)`** — `right = 320`, `bottom = 686`. It slides in from
`x = -226` between `_entered` 0.18 and 0.78, overshooting to `x = 60`. `draw_panel` is called
with `border` left at its default (`True`, `ui.py:232-233`). Panel glow period is 4.83 s.

Values read (all inside one `try`, with the fallback
`best, stars, max_stars, cleared, total = 0, 0, 1, 0, LEVEL_COUNT`):

```
best      = int(save.highscore)
stars     = int(save.total_stars())
max_stars = max(1, int(save.max_stars()))            # 12 * 3 = 36
cleared, total = save.progress()
```

| Row | Text | Position (resting) | Align | Font | Colour |
|---|---|---|---|---|---|
| 1 | `"BEST SCORE"` | `(panel.x + 18, panel.y + 12)` = `(52, 528)` | left | `tiny` | `theme.text_dim` |
| 2 | `"{:,}".format(best)` | `(panel.x + 18, panel.y + 30)` = `(52, 546)` | left | `h2` | `lerp_color(P.UI_GOLD, P.UI_WHITE, 0.25)` |
| 3 | `"STORY"` | `(panel.x + 18, panel.y + 72)` = `(52, 588)` | left | `tiny` | `theme.text_dim` |
| 4 | `_story_summary()` | `(panel.right - 18, panel.y + 70)` = `(302, 586)` | **right** | `small` | `lerp_color(theme.text, theme.accent, 0.35)` |
| 5 | `"STARS"` | `(panel.x + 18, panel.y + 98)` = `(52, 614)` | left | `tiny` | `theme.text_dim` |
| 6 | `"{} / {}".format(stars, max_stars)` | `(panel.right - 18, panel.y + 96)` = `(302, 612)` | **right** | `small` | `P.UI_GOLD` |
| 7 | `draw_bar(rect, frac, P.UI_GOLD)` | rect `(panel.x + 18, panel.y + 122, panel.w - 36, 9)` = `(52, 638, 250, 9)` | — | — | `frac = stars / float(max_stars)` |
| 8 | `"LEVELS CLEARED  {} / {}".format(cleared, total)` | `(panel.x + 18, panel.y + 140)` = `(52, 656)` | left | `tiny` | `shade(theme.text_dim, 0.95)` |

Rows 3/4 and 5/6 are label-left / value-right pairs on the same visual line, offset by 2 px
(`+72` vs `+70`, `+98` vs `+96`) because `tiny` and `small` have different line-box heights and
`draw_text` anchors the **top** edge. Reproduce the 2 px offset literally; do not "align" them.

`_story_summary()` (menu.py:810-822):

| Condition | Result |
|---|---|
| `save.story_complete` | `"COMPLETE"` |
| not `_story_in_progress()` | `"NOT STARTED"` |
| otherwise | `"CHAPTER {} OF {}".format(get_chapter(_story_index()).roman, (CHAPTERS[-1] if CHAPTERS else chapter).roman)` — e.g. `"CHAPTER II OF IV"` |

#### 1.11.1 The caption above PLAY (`_play_caption`, menu.py:704-717; drawn 726-732)

```
if self._buttons and self._entered > 0.5:
    rect = self._base_rects[0]                  # note: the *base* rect, not the animated one
    draw_text(surface, self._play_caption(), fonts.small,
              P.shade(self._theme.text_dim, 1.0),
              (rect.centerx, rect.top - 30), align="center")
```

Position `(640, 277)`, centred, `fonts.small`, colour `shade(theme.text_dim, 1.0)` (an identity
shade — the same value as `theme.text_dim`, just re-truncated to ints).

| Condition | Caption |
|---|---|
| `_story_in_progress()` | `"STORY  -  CHAPTER {chapter.roman}  -  {beat.number:02d} {beat.title.upper()}"` |
| else if `save.story_complete` | `"STORY COMPLETE  -  REPLAY OR PICK A LEVEL"` |
| else | `"CHOOSE STORY OR FREE PLAY"` |

Two spaces either side of every hyphen. `beat.number` is `level_index + 1`
(`story.py:71-74`) — see the gap in §1.17.

#### 1.11.2 Save queries (menu.py:291-316)

| Helper | Body | Guard |
|---|---|---|
| `_story_index()` | `clamp(int(save.story_progress), 0, LEVEL_COUNT - 1)` | any exception → `0` |
| `_story_in_progress()` | `False` if no save; `False` if `save.story_complete`; else `int(save.story_progress) > 0` | any exception → `False` |
| `_difficulty()` | `get_difficulty(getattr(game, "difficulty", None))` | total by construction, "never raises, never None" |
| `_play_label()` | `"CONTINUE" if _story_in_progress() else "PLAY"` | |

---

### 1.12 Complete layout table (design pixels, 1280 x 720, resting state)

Everything below is post-entrance (`_entered > 0.82`). Entrance offsets are in §1.5.2,
§1.9.2, §1.10.2, §1.11.

| Element | x | y | size | anchor | font | colour expression | condition |
|---|---|---|---|---|---|---|---|
| background (current theme) | 0 | 0 | 1280 x 720 (port: overscan) | top-left | — | `theme.bg_style` stage | always |
| background (incoming theme) | 0 | 0 | 1280 x 720 | top-left | — | same, at `alpha = 255 * _theme_blend` | `_theme_blend > 0.001` |
| ambient motes | — | — | rect `(0, 0, 1280, 720)` | — | — | `lerp(accent, accent2, 0.5)` | always, 9/s |
| shockwave ring | `640 ± [300, 520]` | `[180, 600]` | radius `[40, 90]` | centre | — | `accent2` → `accent` | every 2.32-3.77 s |
| demo snake | — | — | 30 segments, speed 196 | — | — | theme snake colours | `_demo is not None` |
| wordmark under-glow x9 | `318.46 + 80.385 i` | `165.92` | radius `86.0` | centre | — | `lerp(accent, accent2, i/8)`, `α = 0.30 + 0.16 pulse(t, 0.9)` | always |
| wordmark left fringe | `290 - split` | `116 + wob` | 699 x 96 | top-left | `huge` | `shade(accent, 0.85)`, additive | always |
| wordmark right fringe | `290 + split` | `116 - wob` | 699 x 96 | top-left | `huge` | `shade(accent2, 0.85)`, additive | always |
| wordmark body | `290` | `116` | 699 x 96 | top-left | `huge` | `lerp(theme.text, UI_WHITE, 0.55)` | always |
| tagline | `640` | `218` | 488 x 28 | top-centre | `body` | `lerp(text_dim, accent, 0.35 + 0.25 pulse(t, 0.9))` | always |
| PLAY caption | `640` | `277` | — | top-centre | `small` | `shade(text_dim, 1.0)` | `_entered > 0.5` |
| button 0 `PLAY`/`CONTINUE` | `490` | `307` | 300 x 58 | rect | Button default | `style="primary"` | `_entered > 0` |
| button 1 `LEVELS` | `490` | `378` | 300 x 58 | rect | Button default | `style="primary"` | `_entered > 0.075` |
| button 2 `HOW TO PLAY` | `490` | `449` | 300 x 58 | `fonts.body` | | `style="ghost"` | `_entered > 0.15` |
| button 3 `SETTINGS` | `490` | `520` | 300 x 58 | `fonts.body` | | `style="ghost"` | `_entered > 0.225` |
| button 4 `QUIT` | `490` | `591` | 300 x 58 | Button default | | `style="danger"` | `_entered > 0.30` |
| `"DIFFICULTY"` | `806` | `303` | — | top-left | `tiny` | `shade(text_dim, 0.85)` | `_entered >= 0.35` |
| difficulty badge glow | `843.5` | `336` | radius `56.25` | centre | — | `diff.color`, `α = (0.22 + 0.12 pulse(t, 1.1)) k` | `_entered >= 0.35` |
| difficulty badge pill | `806` | `320` | `75 x 31` (EXPERT) | top-left | `tiny` | fill `with_alpha(UI_PANEL, 232)`, border `with_alpha(diff.color, 200)` w=2 r=15, label `lerp(diff.color, UI_WHITE, 0.35)` | `_entered >= 0.35` |
| stats panel | `34` | `516` | 286 x 170 | rect | — | `draw_panel(alpha=206, glow=0.25 + 0.12 pulse(t, 1.3))` | `game.save is not None` |
| `"BEST SCORE"` | `52` | `528` | — | top-left | `tiny` | `theme.text_dim` | with panel |
| best score | `52` | `546` | — | top-left | `h2` | `lerp(UI_GOLD, UI_WHITE, 0.25)` | with panel |
| `"STORY"` | `52` | `588` | — | top-left | `tiny` | `theme.text_dim` | with panel |
| story summary | `302` | `586` | — | top-**right** | `small` | `lerp(theme.text, accent, 0.35)` | with panel |
| `"STARS"` | `52` | `614` | — | top-left | `tiny` | `theme.text_dim` | with panel |
| stars `n / 36` | `302` | `612` | — | top-**right** | `small` | `UI_GOLD` | with panel |
| star bar | `52` | `638` | 250 x 9 | rect | — | `UI_GOLD`, `frac = stars / max_stars` | with panel |
| `"LEVELS CLEARED n / 12"` | `52` | `656` | — | top-left | `tiny` | `shade(text_dim, 0.95)` | with panel |
| footer hint | `640` | `694` | — | top-centre | `tiny` | `shade(text_dim, 0.8)` | always |
| version `v1.0.0` | `1260` | `694` | — | top-**right** | `tiny` | `shade(text_dim, 0.7)` | always |

---

### 1.13 `update(dt)` — order of operations

`MenuScene.update` (menu.py:448-459), whole body wrapped in `try/except: pass`:

| # | Operation | dt |
|---|---|---|
| 0 | `dt = clamp(float(dt), 0.0, C.MAX_DT)` — a **second** clamp; the shell already clamped to `MAX_DT` (main.py:483) | — |
| 1 | `_t += dt` | real |
| 2 | `_entered += dt` | real |
| 3 | `_update_theme(dt)` — carousel, then `background.update(dt)` on the current (and, if `raw > 0`, the incoming) stage, then eviction | real |
| 4 | `_update_demo(dt)` — §1.7.5, including `snake.update(dt)` and the trail/spark emitters | real |
| 5 | `_update_buttons(dt)` — §1.9.2, including `Button.update(dt, mouse)` and the hover cue | real |
| 6 | `_update_ambience(dt)` — motes, then the ring timer | real |

**Every consumer in this scene takes real dt.** There is no `sdt`, no `fx.time_scale()` read
and no `hazard_t`: the menu is shell-level chrome and per `docs/port/integration.md` §10 menus
run on real time. State that in the port and assert it — a test that drives `step()` with a
fake `timeScale()` of 0.05 must see the menu animate at full speed.

Clock hygiene: `_t` drives everything periodic (`pulse`, `sin`, the carousel, `draw_snake`'s
`t`, `Button.draw`'s `t`); `_entered` drives every entrance. Note that `Button.draw` is handed
**`self._t`**, not `game.time` (menu.py:724) — the gameplay pause button uses `game.time`
instead (`integration.md` §8 row 10). Both are unscaled, but they differ in origin: `_t`
restarts at 0 on every entry.

The order matters in one place: `_update_theme` rewrites `self._theme` before `_update_demo`
and `_update_ambience` read it for their particle colours, so the wake and the motes are always
in the *current* blended palette.

Ordering relative to the shell (main.py:401-414): `_pump_events()` → `Game.update` (which walks
the stack, hitting `MenuScene.update`) → `particles.update(dt)` → `fx.update(dt)`. Particles
emitted by the menu therefore get **no** update before their first draw. Keep that
(`integration.md` §2.2).

---

### 1.14 `draw()` — layer order

`MenuScene.draw` (menu.py:601-620) saves and restores the surface clip in a `finally`, but
never sets one: **nothing in this scene is clipped.** Layers, back to front:

| # | Layer | Call | Extent |
|---|---|---|---|
| 1 | background, current theme | `_draw_background` → `current.draw(surface)`; on `None`, `surface.fill(theme.bg_bottom)` | design box in Python; **overscan** in the port |
| 2 | background, incoming theme | `nxt.draw(layer)`; `layer.set_alpha(int(255 * clamp(_theme_blend, 0, 1)))`; `surface.blit(layer, (0,0))`; `layer.set_alpha(255)` | same; skipped when `_theme_blend <= 0.001` |
| 3 | **particles** | `game.particles.draw(surface)` | full screen, unclipped |
| 4 | demo snake | `draw_snake(surface, _demo, _theme, _t)` | unclipped |
| 5 | wordmark (5 sub-layers) | `_draw_title` — §1.5.2 | unclipped |
| 6 | buttons | `_draw_buttons` — `button.draw(surface, _theme, fonts, _t)` per visible button, then the PLAY caption | unclipped |
| 7 | difficulty badge | `_draw_difficulty_badge` — glow, pill, `"DIFFICULTY"` label | unclipped |
| 8 | stats panel | `_draw_stats_panel` — panel, 6 text rows, 1 bar | unclipped |
| 9 | footer | `_draw_footer` — hint + version | unclipped |
| — | cursor + post-processing | shell (`Game.draw`, main.py:416-441) | above everything |

**Particles are below the snake here (layer 3 vs 4).** In `GameplayScene` they are *above*
(`integration.md` §8, rows 6-7). That inversion is deliberate: on the menu the wake reads as a
comet tail behind a solid snake. The port borrows the shell-owned `game.particles.root`
(`app/Game.ts:59`) into the scene root at index 2 — the same borrow-and-return pattern
`GameplayScene.onEnter`/`onExit` uses (`GameplayScene.ts:141-155`) — and must return it in
`onExit`.

The background cross-fade becomes trivial in Pixi: keep both `Background.root` containers as
children and set `incoming.root.alpha = _theme_blend`. Drop `_fade_layer` entirely.

---

### 1.15 Input and transitions

`handle_event` (menu.py:397-417), whole body in `try/except: pass`. Only the **top** scene
receives events (main.py:391-394), and mouse events arrive already rewritten into design space
(main.py:369-381).

| Order | Source | Binding | Edge or held |
|---|---|---|---|
| 1 | every `Button` in `_buttons`, in index order | `button.handle_event(event)` → truthy exactly once per completed click; then `_activate(str(button.data))` | edge (press **and** release both inside the rect, `ui.py:476-484`) |
| 2 | `KEYDOWN` | `K_RETURN`, `K_KP_ENTER`, `K_SPACE`, `K_p` → `_activate("play")` | edge |
| 3 | `KEYDOWN` | `K_l` → `_activate("levels")` | edge |
| 4 | `KEYDOWN` | `K_h`, `K_F1` → `_activate("help")` | edge |
| 5 | `KEYDOWN` | `K_s`, `K_o` → `_activate("settings")` | edge |
| 6 | `KEYDOWN` | `K_ESCAPE` → `_activate("quit")` | edge |

Nothing is held. There is no boost/steer input on this screen: the pointer position is consumed
only by `Button.update` (menu.py:572) and by the shell's cursor trail.

Two shell-level interceptions to know about (main.py:356-363): `K_F11`, and
`K_RETURN`/`K_KP_ENTER` **with `KMOD_ALT`**, are consumed by the fullscreen toggle and
`continue` before any scene sees them. So Alt+Enter does *not* start a run, while plain Enter
does. Preserve that if the port grows a keyboard facility (`integration.md` Q2).

`MOUSEMOTION` reaches `Button.handle_event`, which sets `hovered` directly (`ui.py:473-475`).
See §1.16 for the consequence.

#### Transition table

`_activate(action)` (menu.py:419-443) always plays `click` **first**, then routes:

| Trigger | verb | Target key | Args | `game.*` written on the way out |
|---|---|---|---|---|
| click button 0 / Enter / KP-Enter / Space / `P` | `switch_scene` | `C.SCENE_MODE` = `"mode"` | — | none — the mode picker owns story-vs-free *and* difficulty (menu.py:428-429) |
| click button 1 / `L` | `switch_scene` | `C.SCENE_LEVELS` = `"levels"` | — | **`game.mode = C.MODE_FREE`** (in its own `try/except`, menu.py:433-436) — "level select is free play by definition" |
| click button 2 / `H` / `F1` | `switch_scene` | `C.SCENE_HELP` = `"help"` | — | none |
| click button 3 / `S` / `O` | `switch_scene` | `C.SCENE_SETTINGS` = `"settings"` | `back=C.SCENE_MENU` | none |
| click button 4 / `Esc` | `game.quit()` | — | — | sets `game.running = False` (main.py:329-330); `Game.shutdown` then mirrors `audio.muted`, `display_mode`, `difficulty`, `mode` into the save and writes it (main.py:495-504) |

No `push_scene` and no `pop_scene`: the menu is always the bottom of the stack.
`game.level_index` and `game.last_result` are never touched. `switch_scene` itself pops-and-exits
the whole stack, enters the new scene, and calls `fx.begin_transition()` (main.py:307-314) — the
transition is the *shell's*, not the menu's.

**Port gap:** `game.quit()` has no TS counterpart. A browser tab cannot close itself. Options
for `QUIT` on the web build: hide the button when `!window.navigator.standalone && !isElectron`,
or repoint it at a "thanks for playing" card. Decide before porting; do not silently no-op it,
because `Game.shutdown`'s save-flush hangs off the same path (the port needs an explicit
`save.flush()` on `visibilitychange`/`pagehide` regardless).

---

### 1.16 Audio cues and fx calls

| Call | Trigger | Line | In `data/audio.json`? |
|---|---|---|---|
| `game.audio.play("click")` | first statement of `_activate`, so **every** action including QUIT | 423 | ✅ `names[5]` |
| `game.audio.play("hover")` | in `_update_buttons`, when `button.hovered` is true this frame and was false last frame | 589 | ✅ `names[6]` |

Both cue names check out against `web/src/data/audio.json` (`names`: eat, bonus, powerup, hit,
die, click, hover, start, levelup, win, boost, portal). No cue is missing and no other cue is
used. Both calls are individually wrapped in `try/except: pass`.

`web/src/audio/Audio.ts` already gates these: `GAIN` = `{click: 0.34, hover: 0.15}` and
`MIN_INTERVAL` = `{hover: 0.070, click: 0.040}` (Audio.ts:55-66), so the port needs no extra
rate limiting.

**`fx` calls: none.** `MenuScene` makes zero `flash`/`shake`/`slowmo`/`set_theme`/
`begin_transition` calls (grep of menu.py for `game.fx` returns nothing). Two consequences:

* the transition wipe out of the menu is the shell's, fired inside `switch_scene`, and it is
  **untinted by this scene** — `fx.set_theme` is never called, so the wipe uses whatever accent
  the previous scene left behind;
* the port must not add a `beginTransition` call in `MenuScene`; `Game.switchScene` already
  does it (`app/Game.ts:196`).

Particle calls, all on the shell-owned system:

| Call | Arguments | Trigger | Line |
|---|---|---|---|
| `particles.ambient` | `((0,0,1280,720), lerp(accent, accent2, 0.5), dt, rate=9.0, turbulence=0.12, twinkle=0.3)` | every frame | 465 |
| `particles.ring` | `(x, y, accent2, radius=uniform(40,90), count=14, life=1.1, speed=70.0, color_end=accent)` | `_ring_timer <= 0` | 476 |
| `particles.trail` | `(hx, hy, snake_a, dt, rate=22.0, speed=(6.0,30.0), life=(0.3,0.75), radius=(1.6,3.6), ribbon=0.3, color_end=snake_b)` | every frame the demo survives step 9 | 551 |
| `particles.stream` | `(hx, hy, side, accent2, dt, rate=26.0, speed=(50.0,130.0), spread=0.5, life=(0.18,0.4), radius=(1.4,3.0))` | `abs(snake.turn_input) > 0.65` | 565 |
| `particles.draw` | `(surface)` | in `draw`, layer 3 | 606 |

`particles.clear()` is **never** called by this scene.

#### The hover-cue quirk — record it, then decide

`_update_buttons` (menu.py:585-591) samples `was = button.hovered` **after** `handle_event` has
already run for this frame's events (main.py:486 `_pump_events` precedes 489 `self.update`). A
`MOUSEMOTION` that carries the cursor into a rect sets `hovered = True` in
`Button.handle_event` (`ui.py:473-475`), so by the time `_update_buttons` runs, `was` is already
`True` and **no `hover` cue is played**. In practice the cue therefore fires only when a button
moves *under* a stationary cursor — during the entrance slide, or when the cursor is parked and
a rect arrives. This is almost certainly not the intent (`Button.just_entered` exists for
exactly this job, `ui.py:437`, and is unused here).

Port guidance: the TS `InputManager` has no per-event scene dispatch for movement
(`integration.md` §2.3), so a TS `Button` will only learn about hover inside `update(dt, pointer)`
— which means the port would fire the cue on **every** genuine hover-enter, i.e. *more often
than the desktop game*. Flag it as a decision: either keep the accidental Python behaviour
(suppress the cue when the pointer moved this frame) or accept the louder web behaviour. This
document records the Python fact; do not port it by accident.

---

### 1.17 Data dependencies

| Source | Python read | TS equivalent | Status |
|---|---|---|---|
| `SaveData` | `save.story_progress` | `save.storyProgress` | ✅ `core/save.ts:450` |
| `SaveData` | `save.story_complete` | `save.storyComplete` | ✅ `core/save.ts:453` |
| `SaveData` | `save.highscore` | `save.highscore` | ✅ `core/save.ts:416` |
| `SaveData` | `save.total_stars()` | `save.totalStars()` | ✅ `core/save.ts:703` |
| `SaveData` | `save.max_stars()` | `save.maxStars()` | ✅ `core/save.ts:717` (returns `LEVEL_COUNT * 3` = 36) |
| `SaveData` | `save.progress()` → `(cleared, total)` | `save.progress(): [number, number]` | ✅ `core/save.ts:745` |
| `core.level` | `LEVEL_COUNT` (= 12) | `LEVEL_COUNT` | ✅ `core/level.ts:265` |
| `core.difficulty` | `get_difficulty(game.difficulty)` | `getDifficulty(...)` | ✅ `core/difficulty.ts`, total |
| | `diff.hud_label`, `diff.color` | `diff.hudLabel`, `diff.color` | ✅ |
| `core.story` | `S.get_beat(i)`, `S.get_chapter(i)`, `S.CHAPTERS` | `getBeat`, `getChapter`, `CHAPTERS` | ✅ `core/story.ts:268, 279, 205` |
| | `chapter.roman` (**property**) | `chapter.roman()` (**method**) | ⚠ naming shim, already flagged in `integration.md` §11 |
| | `beat.title` | `beat.title` | ✅ |
| | **`beat.number`** (`story.py:71-74`, `= level_index + 1`) | — | ⛔ **gap G-M2**: `StoryBeat` in `core/story.ts:33-51` has `levelIndex`, `chapter`, `chapterTitle`, `title`, `intro`, `outro`, `speaker` — **no `number`**. Either add `readonly number` to the interface (built as `levelIndex + 1` in the `BEATS` map, `story.ts:191-199`) or write `beat.levelIndex + 1` at the one call site (`_play_caption`). Prefer adding the field: mode-select and the story card need it too. |
| `palette` | `P.THEMES`, `P.Theme`, `P.lerp_color`, `P.shade`, `P.with_alpha`, `P.UI_PANEL`, `P.UI_WHITE`, `P.UI_GOLD` | `THEMES`, `Theme`, `lerpColor`, `shade`, `withAlpha`, `UI_PANEL`, `UI_WHITE`, `UI_GOLD` | ✅ `core/palette.ts` (+ `toHex`, `theme.hex`, `UI_HEX` for Pixi tints) |
| `config` | `WINDOW_W/H`, `UI_BUTTON_W/H`, `MAX_DT`, `GAME_TITLE`, `GAME_SUBTITLE`, `MODE_FREE` | same names | ✅ `core/config.ts:46-47, 52-56, 143-144, 151` |
| `config` | **`C.VERSION`** | — | ⛔ **gap G-M1**: `"VERSION": "1.0.0"` is in `web/src/data/config.json:124` but `core/config.ts` does not export it. Add `export const VERSION = str("VERSION", "1.0.0");`. Do **not** hard-code `"v1.0.0"` in the scene. |
| `config` | `C.SCENE_MENU/MODE/LEVELS/HELP/SETTINGS` | `SCENES.MENU/MODE/LEVELS/HELP/SETTINGS` | ✅ but they live in `app/Scene.ts:65-76`, not `core/config.ts` (which does not export `SCENE_*` at all, even though `config.json:84-93` carries them). Use `SCENES`. |
| `core.contracts` | `clamp`, `dist`, `ease_out_back`, `pulse` | `clamp`, `dist`, `easeOutBack`, `pulse` | ✅ `core/mathx.ts:12, 20, 65, 74` |
| `core.snake` | `Snake(x, y, heading=, length=)`, `.speed`, `.heading`, `.head_pos()`, `.set_target()`, `.update(dt)`, `.turn_input` | `new Snake(x, y, heading, length)`, `.speed`, `.heading`, `.headPos()` (returns `Vec2`, **not** a tuple), `.setTarget()`, `.update(dt)`, `.turnInput` | ✅ `core/snake.ts:172-242, 299, 200` |
| `gfx.background` | `make_background(style, theme, rect)` | `makeBackground(style, theme, rect, renderer)` | ✅ `gfx/bg/index.ts:81` — **extra 4th argument** `game.app.renderer` |
| `gfx.render` | `draw_glow_circle(surface, x, y, r, col, intensity)` | `glowSprite(r, col, intensity)` / `setGlow(sprite, r, col, intensity)` | ✅ `gfx/textures.ts:255, 272` |
| `gfx.render` | `draw_snake(surface, snake, theme, t)` | `new SnakeRenderer().draw(snake, theme, t)` | ✅ `gfx/SnakeRenderer.ts:299, 423` |
| `gfx.particles` | `ambient/ring/trail/stream/draw` | same names, options objects | ✅ `gfx/particles.ts:951, 854, 825, 1118` — option keys match (`colorEnd` for `color_end`) |
| `gfx.ui` | `Button`, `draw_panel`, `draw_text`, `draw_bar` | — | ⛔ owned by `docs/port/ui.md`; not yet ported |
| shell | `game.fonts.{huge, body, small, tiny, h2}` | — | ⛔ `FontBook` not ported (ui.md). Faces this scene needs: **huge (96), h2 (30 bold), body (21), small (17), tiny (14)** |
| shell | `game.audio.play` | `Audio.play(name, volume?)` | ✅ `audio/Audio.ts:318`, but **not on `Game`** — inject via the scene factory as `GameplayScene` does (`main.ts:54`) |
| shell | `game.save` | `SaveData` | ✅ ported, but **not on `Game`** — inject the same instance `main.ts:41` loads |
| shell | `game.mouse_pos` | `game.pointer.x / .y` | ✅ `app/Game.ts:62-68` |
| shell | `game.mode`, `game.difficulty` | `game.mode`, `game.difficulty` | ✅ `app/Game.ts:82-83` |
| shell | `game.switch_scene(name, **kwargs)` | `game.switchScene(key, args?)` | ✅ `app/Game.ts:184` — `back=C.SCENE_MENU` becomes `{ back: SCENES.MENU }` |
| shell | `game.quit()` | — | ⛔ **gap G-M3**, see §1.15 |
| shell | `game.particles` | `game.particles` | ✅ `app/Game.ts:59` (`ParticleSystem` is fully ported) |
| shell | `game.fx` | `game.post.fx` | ✅ exists (`gfx/post/ScreenFx.ts`), unused by this scene |

`levels.json` is **not** read by this scene. `story.json` is read only via `core/story`
accessors, `difficulty.json` only via `getDifficulty`, `themes.json` via `THEMES`.

---

### 1.18 Capture cross-check — `captures/01-menu.png`

Shot conditions, from `tools/screenshot.py:218-223`: `switch_scene(SCENE_MENU)`, then
`settle(70, mouse=(640.0, 300.0))`, then one more frame in `shoot()` — so the frame is at
**`_t = _entered = 71/60 ≈ 1.183 s`**, well past every entrance (last finishes at 0.82 s) and
past the 0.55 s transition wipe, and before the first shockwave ring (due at `_t = 2.9`).

Everything on screen, accounted for:

| Observed | Explanation | Matches spec? |
|---|---|---|
| Wordmark ink spanning x≈290-989 | `art.width = 699`, `x = int(640 - 349.5) = 290` | ✅ exact |
| Cyan fringe left of the glyphs, magenta fringe right | `art.left = shade(accent, 0.85)` at `x - split`; `art.right = shade(accent2, 0.85)` at `x + split`; theme 0 accent = `(0,236,255)`, accent2 = `(255,60,190)` | ✅ |
| Broad soft glow bar behind the letters, cyan→magenta left to right | the 9 `draw_glow_circle` stamps, `lerp(accent, accent2, i/8)` | ✅ |
| `A MOUSE-DRIVEN ARCADE ODYSSEY   -   NEON GRID`, centred, ≈y 218-246 | tagline at `(640, 218)`, `fonts.body` (28 px box); `theme.name` = `Neon Grid` because `_t = 1.18 < 8.6 s` so the carousel is still on index 0 | ✅ exact |
| `STORY  -  CHAPTER II  -  05 SOMETHING IN THE TRENCH` at ≈y 285 | `_play_caption()` story branch at `(640, 277)`, `fonts.small` (23 px box). The capture-run save has `story_progress = 4` (written by the *mode-select* step of a previous run, then persisted to `captures/screenshot-save.json` by `Game.shutdown`), so `get_chapter(4).roman = "II"` and `get_beat(4).number = 5` | ✅ |
| Button 0 reads `CONTINUE`, not `PLAY` | `_play_label()` → `_story_in_progress()` is true (`story_progress = 4 > 0`, `story_complete` false) | ✅ |
| Five buttons at y 307/378/449/520/591, 300 x 58, all at x = 490 | `BUTTON_TOP = 336`, `BUTTON_PITCH = 71`, entrance over at 0.82 s | ✅ exact |
| `HOW TO PLAY` / `SETTINGS` are dimmer with a thin outline; `QUIT` is red-outlined | `style="ghost"` and `style="danger"` (ui.md owns the styles) | ✅ |
| No button shows a hover state | the harness parks the cursor at `(640, 300)`, which is **7 px above** button 0's rect top (307), so `collidepoint` is false. The shot's own note says "PLAY hovered" — **the note is wrong**, the buttons are all idle | ⚠ note is stale, not the pixels |
| `DIFFICULTY` at ≈(806, 305) and a red-outlined `EXPERT` pill at ≈(806, 321), 75 x 30 | badge at `(806, 320)`, 75 x 31; label at `(806, 303)`. `game.difficulty` was left on `expert` by the previous capture run's settings pass; `expert.color = (255, 84, 132)` | ✅ |
| Bottom-left panel x≈33-320, y≈516-686, with BEST SCORE `4,210`, `CHAPTER II OF IV`, `STARS 17 / 36`, a gold bar, `LEVELS CLEARED 8 / 12` | panel `(34, 516, 286, 170)`; `_seed_save` sets `highscore = 4210` and records levels 0-7 with stars 3,2,1,3,2,1,3,2 = **17** of `12*3 = 36`, so `progress()` = `(8, 12)`; bar `frac = 17/36 = 0.472` of 250 px ≈ 118 px, which matches the fill | ✅ exact |
| `MOUSE STEERS - RIGHT-CLICK BOOSTS - ENTER PLAYS` centred at ≈y 705, `v1.0.0` bottom-right | footer at `(640, 694)` / `(1260, 694)`, `fonts.tiny` (19 px box) | ✅ |
| Bright cyan/white snake from ≈(760, 262) down-left to a tail tip ≈(480, 490), passing **behind** `HOW TO PLAY` and behind the PLAY caption | demo snake, drawn at layer 4 — under the wordmark, buttons, badge and panel | ✅ confirms the layer order in §1.14 |
| A comet-tail haze along the snake, teal at the head fading to blue | `particles.trail(..., snake_a → snake_b, ribbon=0.3)`, drawn at layer 3, i.e. **under** the snake | ✅ confirms the menu's particle/snake inversion vs gameplay |
| Scattered pale blue-white motes and 4-point twinkles across the whole frame | `particles.ambient(rate=9, twinkle=0.3)` in `lerp(accent, accent2, 0.5) = (127, 148, 222)`; plus the grid background's own 150 static stars | ✅ |
| Perspective grid, horizon glow, jagged magenta/cyan ridge lines | `bg_style = "grid"` (`GridBackground`, `background.py:612-720`) — owned by `docs/port/background-framework-1-4.md` | ✅ not this scene's geometry |
| A hard-edged magenta bar, x 584-696, y 116-118 | **the grid background's retro-sun slat, i = 6** (`background.py:640-644`): `y = _MARGIN + h*0.32 - h*0.055 - 6*(h*0.017) = _MARGIN + 117.36`, `half = sqrt(1 - (6/7)²)*720*0.15 = 55.6` → `640 ± 55.6` = 584.4..695.6, width 3, colour `shade(accent2, 0.9 - 0.54)`. Measured pixels agree to the pixel. It *reduces* the green channel, which is why it cannot be the wordmark's additive fringe | ✅ background, not MenuScene |
| `60.0 fps` top-right | shell FPS read-out, `main.py:435-441`, forced to `C.FPS` by `Shooter.shoot` (`screenshot.py:159`) | ✅ shell |
| A small reticle glyph near the top of `CONTINUE` | shell cursor (`Game._draw_cursor`), re-enabled for the shot by `screenshot.py:154-157`, at `mouse_pos = (640, 300)` | ✅ shell |
| Soft vignette + faint CRT bezel at the frame edges | `fx.present` post-chain, `main.py:432` | ✅ shell |

**Nothing in the capture is unaccounted for.** Two things worth carrying forward: the shot's
note string is stale (no button is hovered), and the "unexplained magenta bar" is a background
sun slat, not a title artefact — do not chase it in the wordmark port.

---

### 1.19 `onEnter` reset checklist for the port

The #1 bug source per the web-port conventions, so here it is as a list. `MenuScene.onEnter`
must, in this order:

1. `this.t = 0; this.entered = 0;`
2. `this.themeIndex = 0; this.themeBlend = 0; this.theme = THEMES[0];`
3. destroy and clear every cached `Background` (do **not** reuse across entries — the theme
   index restarts at 0 and `onResize` may have invalidated them);
4. invalidate the wordmark tint cache (`titleKey = null`);
5. `this.ringTimer = RING_PERIOD;`
6. `spawnDemo()` — reset (or rebuild) the `Snake`, pick the first target, `demoTimer = 0`,
   `demoHairpins = 0`;
7. `buildButtons()` — re-evaluate `playLabel()`, rebuild the five `Button`s and their base
   rects, and reset each button's hover/press animation state to 0;
8. borrow `game.particles.root` into the scene root at index 2.

Deliberately **not** reset: the RNG (see §1.3). Deliberately **not** cleared:
`game.particles` — motes carry across the transition, as in Python.

`onExit` must: destroy and clear the backgrounds, and return `game.particles.root` to the shell.

---

### 1.20 Open questions

* **Q-M1 — `QUIT` on the web.** `game.quit()` has no browser equivalent (§1.15). Hide, relabel,
  or route to a farewell card? Whichever, the save flush that `Game.shutdown` performs
  (main.py:495-504) needs a `pagehide`/`visibilitychange` home in the shell regardless.
* **Q-M2 — the hover cue.** Python effectively suppresses it whenever the pointer moves into a
  rect (§1.16). The port's pointer model will fire it every time. Match the desktop quirk, or
  accept the louder behaviour? Pick one and note it in the code.
* **Q-M3 — background memory at overscan.** Twelve stages sized to `viewport.overscan` cannot
  all live at once. Python's ≤3 window is the answer, but `onResize` invalidates the cache mid-
  cross-fade; confirm that rebuilding the *pair* on resize is acceptable (a one-frame hitch on
  rotation) rather than pausing the carousel.
* **Q-M4 — `_quantise` in a GPU renderer.** Kept for visual parity (§1.6), but it is now purely
  aesthetic. Confirm the stepped fade is wanted before anyone "smooths" it.
* **Q-M5 — RNG divergence.** `makeRng(0xC0FFEE)` will not reproduce Python's Mersenne Twister
  stream, so the demo snake's exact path differs. Accepted as visual-only parity, or does the
  attract mode want a scripted (non-random) path so the captures are reproducible?
* **Q-M6 — `_play_label()` is evaluated once per entry** (§1.9.1). Harmless today. If the port
  ever lets the save mutate while the menu is open (cloud sync, another tab), the label goes
  stale. Leave as-is, or recompute on a save-changed event?
## 2. Mode select (`ModeSelectScene`)

**Ground truth:** `E:/SnakeGame/snake/scenes/mode_select.py`, lines 1-1013 (whole file).
**Reference capture:** `E:/SnakeGame/captures/02-mode-select.png`.
**Suggested TS home:** `web/src/scenes/ModeSelectScene.ts` (class `ModeSelectScene extends Scene`).

This is the screen that picks the two axes of a run: **which mode** (story campaign vs free play)
and **how hard** it is. Both choices are written to session state and to disk the instant they are
made - there is no confirm step for difficulty. The mode cards and difficulty tiles are
`snake.gfx.ui.Button` instances with an **empty label** used purely as hit/hover/click targets;
the scene paints all of their content itself on top of the button's body art.

Widgets from the UI kit are named here by their Python signatures only -
`docs/port/ui.md` owns their internals.

---

### 2.1 Identity and registration

| | |
|---|---|
| Python class | `ModeSelectScene(Scene)` — `mode_select.py:208-1013` |
| Module-level helpers | `_wrap` (113-147), `_mult` (150-155), `_SELF_TEXT` (159-164), `_Card` (170-202) |
| Registry key | `C.SCENE_MODE = "mode"` (`config.py:198`), registered `main.py:41` as `("mode_select", "ModeSelectScene")` |
| TS scene key | `SCENES.MODE = "mode"` (`web/src/app/Scene.ts:67`) — **note:** `core/config.ts` exports no `SCENE_*` constants, so the port must import `SCENES` from `app/Scene.ts` |
| `transparent` | `False` (`mode_select.py:211`) — opaque, paints its own background |
| `blocks_update` | `True` (`mode_select.py:212`) |
| Entered from | **only** `MenuScene._activate("play")` → `game.switch_scene(C.SCENE_MODE)` (`menu.py:430`). `PLAY`/`CONTINUE` on the title screen; the menu deliberately starts nothing itself. |
| Also whitelisted as a `back=` target | `settings.py:288` lists `C.SCENE_MODE` in `_resolve_back`'s `known` tuple, but **no shipped call site** opens settings with `back="mode"` (only `back=SCENE_MENU` from menu.py:441 and `back=SCENE_PAUSE` from pause.py:238). Nothing routes *into* mode-select except the menu. |
| Never pushed | Always `switch_scene`, never `push_scene`, so `on_exit` always runs before the next `on_enter`. This matters — see §2.4. |

`PROLOGUE_BEAT: int = 100` (`mode_select.py:66`) is owned by this scene and by nothing else. It
is the `SaveData.seen_beats` slot for the prologue card, filed far above the 0..11 level-beat
range and inside the 0..255 window `core.save` accepts (`_MAX_BEAT_KEY = 255`,
`save.py:66`; TS `MAX_BEAT_KEY = 255`, `save.ts:67` — 100 is legal in both).

---

### 2.2 Scene-local layout and animation constants (verbatim, `mode_select.py:71-104`)

Every one of these is authored against the 1280x720 design canvas. **None of them is in
`config.json`** — they are scene-local presentation constants and belong in the TS scene module,
exactly as `docs/port/integration.md` §3 does for `GameplayScene`.

| Constant | Line | Value | Derived value |
|---|---|---|---|
| `MARGIN` | 71 | `54` | |
| `CARD_W` | 73 | `540` | |
| `CARD_H` | 74 | `250` | |
| `CARD_Y` | 75 | `72` | card bottom = `322` |
| `CARD_L_X` | 76 | `MARGIN` | `54` |
| `CARD_R_X` | 77 | `C.WINDOW_W - MARGIN - CARD_W` | `1280 - 54 - 540 = 686`; right edge `1226` |
| `RESTART_RECT` | 79 | `Rect(CARD_L_X + 2, CARD_Y + CARD_H + 10, 192, 30)` | `(56, 332, 192, 30)`; bottom `362`, centery `347` |
| `DIFF_LABEL_Y` | 81 | `374` | |
| `TILE_Y` | 82 | `398` | |
| `TILE_H` | 83 | `208` | tile bottom = `606` |
| `TILE_GAP` | 84 | `16` | |
| `TILE_W` | 85 | `(C.WINDOW_W - MARGIN*2 - TILE_GAP*3) // 4` | `(1280 - 108 - 48) // 4 = 1124 // 4 = ` **`281`** (integer floor-div; 1124/4 is exact) |
| `BACK_RECT` | 92 | `Rect(240, 612, 210, 52)` | right `450`, bottom `664`, centerx `345`, centery `638` |
| `INTRO_TIME` | 95 | `0.46` s | |
| `INTRO_RISE` | 96 | `62.0` px | |
| `CARD_DELAY` | 97 | `(0.00, 0.09)` s | story card, free card |
| `TILE_DELAY_BASE` | 98 | `0.20` s | |
| `TILE_DELAY_STEP` | 99 | `0.06` s | tile delays `0.20, 0.26, 0.32, 0.38` |
| `HOVER_K` | 103 | `13.0` | same exponent `Button.update` uses internally (`ui.py:460`) |
| `PRESS_K` | 104 | `22.0` | same exponent `Button.update` uses internally (`ui.py:463`) |

`BACK_RECT`'s comment (`mode_select.py:87-91`) is load-bearing for the port: the rect was moved
off the bottom-left corner because the CRT bezel in `gfx/effects.py` passes only ~20% of the drawn
light at `(54, 628)`; at `(240, 612)` it measures ~0.78 against flat grey. It clears the tiles
above (which end at `TILE_Y + TILE_H = 606`) and the hint line to its right. **Do not "centre" it.**

Tile x positions (`mode_select.py:251`, `x = MARGIN + i*(TILE_W + TILE_GAP)`, stride `297`):

| i | key | x | right edge |
|---|---|---|---|
| 0 | easy | `54` | `335` |
| 1 | normal | `351` | `632` |
| 2 | hard | `648` | `929` |
| 3 | expert | `945` | `1226` = `1280 - MARGIN` ✓ |

Constants shared with the rest of the port: `C.WINDOW_W/H = 1280/720`, `C.MAX_DT = 0.05`,
`C.UI_CORNER = 12` (rim radius used here is `UI_CORNER + 6 = 18`), `C.DEFAULT_DIFFICULTY =
"normal"`, `C.MODE_STORY/MODE_FREE` — all present in `web/src/core/config.ts`.
`C.UI_CLICK_COOLDOWN = 0.1` is in `config.json` but **not exported by `config.ts`**; it is the
`Button` click debounce (`ui.py:485`) and is ui.md's business, but it means two clicks inside
100 ms fire once.

---

### 2.3 Owned state

#### 2.3.1 `ModeSelectScene` instance attributes (`__init__`, lines 214-234)

| Attribute | Type | `__init__` value | `on_enter` resets to | Notes |
|---|---|---|---|---|
| `_t` | `float` | `0.0` | `0.0` (269) | scene-local clock, `+= dt` every frame; passed as `t` to every `Button.draw` and to all art. **Not** `game.time`. |
| `_elapsed` | `float` | `0.0` | `0.0` (270) | seconds since entry; drives the header ease and every card's `appear` |
| `_cards` | `List[_Card]` | `[]` then filled by `_build()` | **not rebuilt**; each element `.reset()` + `set_enabled(True)` (276-278) | 2 entries, `"story"` then `"free"` |
| `_tiles` | `List[_Card]` | `[]` then filled by `_build()` | **not rebuilt**; each `.reset()` + `set_enabled(True)` (279-281) | 4 entries in `D.all_difficulties()` order |
| `_back` | `Optional[Button]` | `None` then built | `rect = BACK_RECT.copy()`; `set_enabled(False)` then `(True)` (282-285) | the False→True pair is the documented way to clear `Button._armed` |
| `_restart` | `Optional[Button]` | `None` then built | `rect = RESTART_RECT.copy()`; `label = "RESTART STORY"`; `set_enabled(False)` then `(True)` (286-290) | label reset matters: an armed "ERASE PROGRESS?" must not survive a re-entry |
| `_difficulty` | `str` | `C.DEFAULT_DIFFICULTY` = `"normal"` | `self._current_difficulty()` (275) | the *selected* key; see §2.11 |
| `_restart_arm` | `float` | `0.0` | `0.0` (271) | `> 0` while RESTART awaits its confirming second click; armed to `3.0` s |
| `_launching` | `str` | `""` | `""` (272) | non-empty while the 0.22 s launch flourish plays; swallows all input |
| `_launch_t` | `float` | `0.0` | `0.0` (273) | countdown of the flourish |
| `_bg` | `Optional[Background]` | `None` | via `_ensure_background()` (292) | `on_exit` sets it back to `None` |
| `_bg_style` | `str` | `""` | via `_ensure_background()` (292) | `on_exit` sets it back to `""` |
| `_theme` | `P.Theme` | `P.THEMES[0]` | via `_ensure_background()` (387) | `P.theme_for_level(self._story_index())` — the campaign's *current* level theme |

#### 2.3.2 `_Card` attributes (`mode_select.py:170-202`, `__slots__`)

| Attribute | Type | `__init__` | `reset()` | Notes |
|---|---|---|---|---|
| `key` | `Any` | `"story"` / `"free"` / a difficulty key | untouched | tiles store `diff.key`; the *Button's* `data` is `("diff", diff.key)` (253) while the `_Card.key` is the bare key (255) — the scene reads `card.key`, never `button.data` |
| `button` | `Button` | the widget | `rect = home.copy()`, `set_enabled(False)` | |
| `home` | `Rect` | `home.copy()` | untouched | the settled rect |
| `delay` | `float` | stagger seconds | untouched | |
| `appear` | `float` | `0.0` | `0.0` | 0..1 entrance weight |
| `hover_t` | `float` | `0.0` | `0.0` | scene-side mirror of `Button._hover_t` |
| `press_t` | `float` | `0.0` | `0.0` | scene-side mirror of `Button._press_t` |
| `rect` (property) | `Rect` | — | — | returns `self.button.rect`, i.e. the *animated* rect this frame |

#### 2.3.3 Built in `__init__` but not reset in `on_enter`

| Thing | Safe? | Why |
|---|---|---|
| `_cards` / `_tiles` / `_back` / `_restart` object identity | **safe, intentional** | `_build()`'s docstring (240): "Create every hit target once; `on_enter` only resets them." |
| `_Card.key/home/delay` | safe | immutable by construction |
| `Button._hover_t`, `_press_t`, `_flash`, `_cool` (widget internals) | **latent, cosmetic** | `_Card.reset()` calls `set_enabled(False)`, which clears `_armed` and `hovered` (`ui.py:445-449`) but **not** the three animation weights or the click cooldown. A card hovered at the moment you left keeps its internal glow weight on re-entry while the scene's own `hover_t` starts at `0.0` — the button body art is briefly "hot" under cold scene content. It decays at `1 - exp(-13·dt)` so it is gone in ~4 frames. The port should zero the widget weights in `reset()` and be *more* correct than the Python; note the divergence if it does. |
| `_theme` initial `P.THEMES[0]` | safe | `on_enter` → `_ensure_background()` always overwrites it (387); `THEMES[0]` is only the fallback when `theme_for_level` throws |
| `_ensure_background`'s early return (389-390) | safe **only because pop never re-enters** | it sets `self._theme = theme` *before* checking `if self._bg is not None and style == self._bg_style: return`, so a second `on_enter` without an intervening `on_exit` would keep a background built from the *old* theme while `_theme` names the new one. `Game.pop_scene` (`main.py:324-327`) does **not** re-enter the revealed scene and this scene is only ever reached by `switch_scene` (which exits first, nulling `_bg`), so the stale path is unreachable today. The TS `Game.popScene` behaves the same. Keep `onExit` clearing the background, or drop the early return. |
| `_WRAP_CACHE` (module-level, line 110) | safe | keyed `(text, id(font), int(width), int(max_lines))`, cleared wholesale past 256 entries. `id(font)` is only sound because `FontBook` faces are long-lived; the TS port should key on a font *name*, not an object identity. |

**`on_enter` is a single `try/except: pass` around the whole reset (267-294).** If any step
throws, the rest of the reset is skipped and the cards stay `enabled = False` — a dead screen.
The port should either guard per field or not guard at all; a half-completed `onEnter` is worse
than a thrown one. (`docs/port/web-port` calls incomplete `onEnter` the #1 bug source; this is the
sharpened version of that rule.)

`on_exit` (296-300) does exactly two things: `_bg = None`, `_bg_style = ""`. Rationale in the
comment: a `Background` holds a pre-rendered full-window surface and must not stay resident behind
the whole session. It does **not** call `particles.clear()`, so the ambient motes this scene emits
drift into the next scene. That is shipped behaviour — keep it.

---

### 2.4 Construction vs entry

**Once, in `_build()` (239-261), called from `__init__` only:**

| Built | Call | Notes |
|---|---|---|
| 2 mode cards | `Button(Rect(x, 72, 540, 250), "", style="tile", data=key)` for `key, x` in `(("story", 54), ("free", 686))` | empty label so `Button.draw` stamps no text over the scene's art (comment at 244-245) |
| `_Card` wrappers | `_Card(key, button, home, CARD_DELAY[i])` | |
| 4 difficulty tiles | `Button(Rect(x, 398, 281, 208), "", style="tile", data=("diff", diff.key))` iterating `D.all_difficulties()` | |
| `_Card` wrappers | `_Card(diff.key, button, home, 0.20 + i*0.06)` | |
| BACK | `Button(BACK_RECT, "BACK", style="ghost", data="back")` | ghost style's default face is `body`/21 (`ui.py:498-499`) |
| RESTART | `Button(RESTART_RECT, "RESTART STORY", style="danger", font=self._font("small"), data="restart")` | the `font=` override is deliberate: the default danger face is `h2`/30 bold and "shouts" in a 30 px-tall rect (comment 258-259) |

The difficulty tile *count and order* come from `D.all_difficulties()` at construction time, so a
table with a different number of modes would silently overflow `TILE_W`'s divide-by-4. Four is
asserted by `checkDifficultyTable()` in the TS (`difficulty.ts:513`).

**Per entry (`on_enter`):** the six clock/flag fields, every `_Card.reset()`, both plain buttons'
rects and enabled-latches, `_difficulty` re-resolved from session/save, and the background
(rebuilt because `on_exit` nulled it). **No RNG, no cached surfaces, no layout recomputation** —
the chain and constellation layouts are closed-form functions of `LEVEL_COUNT` and `_t`, not
random (see §2.7.3-4), so they are identical every run.

---

### 2.5 The two mode cards

| | Story card | Free-play card |
|---|---|---|
| `_Card.key` | `"story"` | `"free"` |
| `Button.data` | `"story"` | `"free"` |
| Home rect | `(54, 72, 540, 250)` | `(686, 72, 540, 250)` |
| Stagger delay | `0.00` s | `0.09` s |
| Accent (`_card_accent`, 754-757) | `lerpColor(theme.accent2, UI_WHITE, 0.25·clamp(hover_t,0,1))` | `lerpColor(theme.accent, UI_WHITE, 0.25·clamp(hover_t,0,1))` |
| Title (`display_at(34)`) | `"STORY MODE"` (811) | `"FREE PLAY"` (892) |
| Blurb (`small`) | `"Descend twelve layers in order, one chapter at a time."` (815) | `"Any level you have unlocked, any order, as often as you like."` (896) |
| Art strip | `_draw_chain` — 12 linked nodes stepping down and across, reached ones lit (833-880) | `_draw_constellation` — 12 scattered tiles on a golden-angle spiral (906-952) |
| Footer left | `"CAMPAIGN COMPLETE"` if `_story_complete()` else `"CHAPTER {chapter.roman} OF {CHAPTERS[-1].roman}  -  {chapter.title.upper()}"` (824-828) | `"{_unlocked_count()} OF {LEVEL_COUNT} UNLOCKED"` (901) |
| Footer right | `"LEVEL {index+1} / {LEVEL_COUNT}"` (829) | `"{stars} / {cap} STARS"` (902) |
| Call to action (`body`) | `"CONTINUE >"` if `_story_started()` else `"BEGIN >"` (830) | `"LEVEL SELECT >"` (904) |
| Unlock condition | **none** — both cards are always enabled and always clickable | **none** |
| On click | `_begin_launch("story")` → 0.22 s flourish → `_start_story()` | `_start_free()` immediately |

Separator spelling is exact: **two spaces, a hyphen-minus, two spaces** (`"  -  "`) in the chapter
line, the SELECTED line and the footer hint. No en-dashes anywhere in this file.

`_story_started()` (330-337) is *not* the same predicate as `_show_restart()` (441-443):

| Predicate | Definition | Used for |
|---|---|---|
| `_story_index()` (316-322) | `clamp(int(save.story_progress or 0), 0, LEVEL_COUNT-1)`; `0` on any coercion failure | resume level, chain `reached`, theme, `game.level_index` |
| `_story_complete()` (324-328) | `bool(save.story_complete)`, `False` on throw | "CAMPAIGN COMPLETE", chain `reached = 11` and no "here" node |
| `_story_started()` (330-337) | `_story_index() > 0 or _story_complete() or save.beat_seen(100)` | `CONTINUE >` vs `BEGIN >` |
| `_show_restart()` (441-443) | `_story_complete() or _story_index() > 0` — **no prologue check** | whether RESTART exists at all |

Consequence to preserve: a player who saw the prologue and then died on level 1 gets
`CONTINUE >` but **no** RESTART button.

`_unlocked_count()` (339-343): `clamp(int(save.unlocked), 0, LEVEL_COUNT)`, returns `1` on throw.
`_stars()` (345-350): `(int(save.total_stars()), max(1, int(save.max_stars())))`, returns
`(0, max(1, LEVEL_COUNT*3))` on throw. **`total_stars()` is called with no argument** — the
difficulty-agnostic totals (`save.py:599-611`: "With no `difficulty` this counts the
difficulty-agnostic bests, which is what the menus have always shown"). Do **not** pass
`_difficulty`. `max_stars()` = `LEVEL_COUNT * MAX_STARS` = `12 * 3` = `36`.
`_is_unlocked(i)` (352-356): `bool(save.is_unlocked(i))`, `i == 0` on throw.

---

### 2.6 The four difficulty tiles

Order and contents come **entirely** from `D.all_difficulties()` (`difficulty.py:370-372` →
`ORDER = (easy, normal, hard, expert)`); the scene hard-codes nothing about them except the
self-mode copy table. All four are always selectable — **there is no unlock gating on difficulty.**

| | EASY | NORMAL | HARD | EXPERT |
|---|---|---|---|---|
| `key` | `"easy"` | `"normal"` | `"hard"` | `"expert"` |
| `label` (= `name.upper()`, `difficulty.py:187-190`) | `EASY` | `NORMAL` | `HARD` | `EXPERT` |
| `color` (RGB) | `(86, 240, 160)` | `(96, 202, 255)` | `(255, 168, 72)` | `(255, 84, 132)` |
| `blurb` | `"Drift, coil and never once die to your own tail."` | `"The serpent as intended - fair, fast, unforgiving of sloppiness."` | `"Faster hazards, thinner mercy, and your own coil bites back."` | `"One life. No mercy. The grid remembers every mistake."` |
| `lives` | `5` | `3` (`C.START_LIVES`) | `2` | `1` |
| `speed_mult` | `0.82` | `1.00` | `1.15` | `1.30` |
| `score_mult` | `0.80` | `1.00` | `1.35` | `1.80` |
| `self_mode` | `"off"` | `"forgiving"` | `"normal"` | `"strict"` |
| tile x | `54` | `351` | `648` | `945` |
| stagger delay | `0.20` s | `0.26` s | `0.32` s | `0.38` s |

Source rows: `difficulty.py:209-295`; identical values in `web/src/data/difficulty.json:4-104`
and reachable in TS as `allDifficulties()` (`difficulty.ts:314-321`).

**Which field each displayed number comes from** — this is the part to get right; never copy the
rendered strings:

| On-screen row | Source expression | Formatting |
|---|---|---|
| `LIVES` value | `D.lives_for(diff)` (996) → `difficulty.py:430-437` = `max(1, int(diff.lives))`. **Not** `C.START_LIVES`. TS: `livesFor(diff)` | `"{}".format(lives)` |
| `LIVES` value colour | `UI_GOOD` if `lives >= 3` else `UI_WARN` if `lives >= 2` else `UI_BAD` (998-999) | → easy/normal green, hard amber, expert red |
| `SPEED` value | `_mult(diff.speed_mult)` (1000) | `_mult` (150-155): `"x{:.2f}".format(v).rstrip("0").rstrip(".")` → `x0.82`, `x1`, `x1.15`, `x1.3` |
| `SPEED` value colour | `P.UI_WHITE` (1000) | |
| `SCORE` value | `_mult(diff.score_mult)` (1001) | → `x0.8`, `x1`, `x1.35`, `x1.8` |
| `SCORE` value colour | `P.UI_GOLD` (1001) | |
| self-collision line | `_SELF_TEXT[diff.self_mode]` (1010-1011), default `("YOUR TAIL KILLS", P.UI_WARN)` | see below |
| header "SELECTED" line | `diff.label` + `D.lives_for(diff)` + `"LIFE"`/`"LIVES"` singular-plural on `== 1` (739-744) | |

`_SELF_TEXT` (`mode_select.py:159-164`), verbatim:

| `self_mode` | text | tone colour |
|---|---|---|
| `"off"` | `"YOUR TAIL CANNOT KILL YOU"` | `P.UI_GOOD` |
| `"forgiving"` | `"YOUR TAIL KILLS - FORGIVING"` | `P.UI_WARN` |
| `"normal"` | `"YOUR TAIL KILLS - TIGHT"` | `P.UI_WARN` |
| `"strict"` | `"YOUR TAIL KILLS - INSTANTLY"` | `P.UI_BAD` |
| (fallback) | `"YOUR TAIL KILLS"` | `P.UI_WARN` |

The tiles display **only** `lives`, `speed_mult`, `score_mult` and `self_mode`. The other
thirteen fields of the row (`invuln_mult`, `turn_mult`, `self_skip_mult`, `self_depth_mult`,
`hazard_speed_mult`, `powerup_rate_mult`, `food_value_mult`, `combo_window_mult`,
`star_target_mult`, `rank`, `hud_label`) are **not shown here** and none of the `difficulty.py`
derivation helpers other than `lives_for` is called. Do not "improve" the tile by showing
`powerupSpawnRange` or `invulnSeconds`.

`_mult` formatting must be reproduced exactly, including the double `rstrip`. TS equivalent:
`` `x${v.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}` ``, with a `Number.isFinite` guard
falling back to `"x1"` (the Python `except (TypeError, ValueError)` arm, 154-155).

---

### 2.7 Layout

Design pixels, 1280x720. `draw_text(surface, text, font, color, pos, align=...)` anchors **`pos[1]`
as the TOP edge always**; `pos[0]` is the left, centre or right edge per `align`
(`ui.py:268-291`). All "y" values below are therefore top edges, not baselines and not centres.

Font faces (`gfx/fonts.py:63-71`; the scene reaches them through `_font(name, size)`, 361-373):
`display_at(34)` = display face at 34 px; `h2` = 30 px bold; `body` = 21 px; `small` = 17 px;
`tiny` = 14 px. `_font("display", 34)` → `fonts.display_at(34)`; every other call is a bare
`getattr(fonts, name)`.

Colour expressions use the TS names from `web/src/core/palette.ts`
(`lerpColor`, `shade`, `UI_WHITE`, `UI_DIM`, `UI_GOOD`, `UI_WARN`, `UI_BAD`, `UI_GOLD`) and
`Theme` fields `accent`, `accent2`, `text`, `textDim`, `bgBottom`. `pulse(t, speed) = 0.5 +
0.5·sin(t·speed)` (`contracts.py:214-216`, TS `mathx.pulse`).

#### 2.7.1 Screen furniture (absolute, settled state)

| Element | x | y | Size / font | Anchor | Colour | Condition |
|---|---|---|---|---|---|---|
| Background | 0 | 0 | `1280 x 720` | — | `_bg.draw` for `theme.bg_style`, else flat fill `theme.bg_bottom` (fallback `(8,10,20)`) | always (683-686) |
| `"CHOOSE YOUR DESCENT"` | `640` (`WINDOW_W*0.5`) | `14 - (1-k)·44` where `k = easeOutBack(clamp(_elapsed/0.5, 0, 1))` | `display_at(34)` | top-centre | `lerpColor(theme.text, UI_WHITE, 0.4)` | always (726-731) |
| `"DIFFICULTY"` | `54` | `374` | `small` | top-left | `lerpColor(theme.textDim, UI_WHITE, 0.5)` | always (736-738) |
| `"SELECTED  -  {label}  ({n} LIFE\|LIVES)"` | `1226` (`WINDOW_W - MARGIN`) | `374` | `small` | top-**right** | `lerpColor(diff.color, UI_WHITE, 0.25)` where `diff = getDifficulty(_difficulty)` | always (739-744) |
| Footer hint `"CLICK A CARD TO PLAY  -  CLICK A DIFFICULTY TO CHANGE IT  -  ESC GOES BACK"` | `1226` | `630` (`BACK_RECT.centery - 8`) | `tiny` | top-right | `shade(theme.textDim, 0.85)` | always (746-751) |
| BACK button | `240` | `612` | `210 x 52`, `style="ghost"`, label `"BACK"` (face `body`/21) | rect | widget | always (714-715) |
| RESTART button | `56` | `332` | `192 x 30`, `style="danger"`, `font=small`, label `"RESTART STORY"` / `"ERASE PROGRESS?"` | rect | widget | only while `_show_restart()` (704-705) |

Neither the difficulty header, the footer hint, BACK nor RESTART is animated in — they appear at
full strength on frame 1. Only the title and the six cards/tiles have an entrance.

The header's ease **overshoots**. With `contracts.py:207-211` (`c1 = 1.70158`, `c3 = 2.70158`),
`easeOutBack(t) = 1 + c3·(t-1)³ + c1·(t-1)²` crosses `1.0` at `t = c1/c3 = 0.3701` and peaks at
`≈1.0999` at `t = 1 - 2c1/(3c3) = 0.5801`. With `t = _elapsed / 0.5`, `y = 14 - (1-k)·44`
therefore starts at `14 - 44 = -30`, reaches `14` at `_elapsed ≈ 0.185` s, sinks past it to
`y ≈ 18.4` at `_elapsed ≈ 0.290` s, and settles back to exactly `14` at `_elapsed >= 0.5` s.

#### 2.7.2 Mode card interior (`_draw_card_frame` 759-775, `_draw_card_footer` 777-796)

Written relative to the card's *current* rect (`rect = card.button.rect`, i.e. including the
entrance rise). Absolute columns are the settled positions; **L** = story card (`rect.x = 54`),
**R** = free card (`rect.x = 686`); `rect.y = 72`, `rect.w = 540`, `rect.h = 250`,
`rect.right = rect.x + 540`, `rect.bottom = 322`.

| Element | Rel. position / size | L absolute | R absolute | Style | Colour | Condition |
|---|---|---|---|---|---|---|
| Shoulder bar | `Rect(x+12, y+2, w-24, 5)`, `border_radius=3` | `(66, 74, 516, 5)` | `(698, 74, 516, 5)` | filled rounded rect | `accent` (§2.5) | always (765-767) |
| Hover rim | `rect`, width `2`, `border_radius = C.UI_CORNER + 6 = 18` | `(54,72,540,250)` | `(686,72,540,250)` | stroked | `lerpColor(accent, UI_WHITE, 0.45)` | `hov > 0.01` (768-770) |
| Hover halo | `draw_glow_circle(rect.centerx, rect.y + 4, 150.0, accent, 0.16·hov)` | centre `(324, 76)` | centre `(956, 76)` | additive glow, r = 150 | `accent` | `hov > 0.01` (771-772) |
| Art strip | `Rect(x+22, y+18, w-44, 78)` | `(76, 90, 496, 78)` | `(708, 90, 496, 78)` | see §2.7.3 / §2.7.4 | | `appear > 0` |
| Title | `(x+22, y+104)` | `(76, 176)` | `(708, 176)` | `display_at(34)`, top-left | `lerpColor(theme.text, UI_WHITE, 0.45)` | always (811-813 / 892-894) |
| Blurb | `(x+22, y+152)` | `(76, 224)` | `(708, 224)` | `small`, top-left | `shade(theme.textDim, 1.05)` | always (814-817 / 895-898) |
| Footer rule | line `(x+22, y+178)` → `(rect.right-22, y+178)`, width `1` | `(76,250)-(572,250)` | `(708,250)-(1204,250)` | 1 px line | `shade(accent, 0.35)` | always (784-786) |
| Footer left readout | `(x+22, y+187)` (`line_y + 9`) | `(76, 259)` | `(708, 259)` | `small`, top-left | `lerpColor(UI_DIM, UI_WHITE, 0.45)` | always (788-790) |
| Footer right readout | `(rect.right-22, y+187)` | `(572, 259)` | `(1204, 259)` | `small`, top-**right** | `lerpColor(UI_DIM, UI_WHITE, 0.45)` | always (791-793) |
| Call to action | `(rect.right-22, rect.bottom-34)` | `(572, 288)` | `(1204, 288)` | `body`, top-right | `lerpColor(accent, UI_WHITE, 0.25 + 0.55·hov)` | always (794-796) |

`hov = clamp(card.hover_t, 0, 1)` throughout. Note the **only** hover-reactive pieces are: the
accent's own 25 % whitening, the rim, the halo, and the call-to-action's 0.25→0.80 whitening.

**The scene's content is *not* lifted or scaled on hover.** `Button.draw` (`ui.py:502-536`)
draws its body at `scale = 1 + 0.035·hov - 0.055·press` and `lift = -3·hov + 2·press` about the
rect centre, but the scene paints from the un-transformed `card.rect`. So on hover the body art
grows ~3.5 % and rises 3 px *under* static text. That is the shipped look; do not "fix" it by
transforming the whole card container.

#### 2.7.3 Story chain art (`_draw_chain`, 833-880)

`area = Rect(rect.x + 22, rect.y + 18, rect.w - 44, 78)` = `(76, 90, 496, 78)` settled.
`n = max(2, LEVEL_COUNT) = 12`. `reached = 11` if `complete` else `clamp(index, 0, 11)`.

```
f_i = i / 11
x_i = area.x + 16 + f_i·(area.w - 32)   = 92   + f_i·464
y_i = area.y + 14 + f_i·(area.h - 34)
      + sin(i·1.35 + t·0.7)·4.0         = 104  + f_i·44   + wobble(±4)
```

Settled home positions (wobble excluded), stride `x` = `464/11 = 42.1818`, `y` = `4.0` exactly:

| i | x | y | chapter ring (`i % CHAPTER_SIZE == 0`, `CHAPTER_SIZE = 3`) |
|---|---|---|---|
| 0 | `92.00` | `104` | yes |
| 1 | `134.18` | `108` | |
| 2 | `176.36` | `112` | |
| 3 | `218.55` | `116` | yes |
| 4 | `260.73` | `120` | |
| 5 | `302.91` | `124` | |
| 6 | `345.09` | `128` | yes |
| 7 | `387.27` | `132` | |
| 8 | `429.45` | `136` | |
| 9 | `471.64` | `140` | yes |
| 10 | `513.82` | `144` | |
| 11 | `556.00` | `148` | |

Links, for `i` in `0..10` (852-859), drawn **before** all nodes, endpoints truncated to `int`:

| `lit = i < reached` | colour | width |
|---|---|---|
| true | `lerpColor(accent, UI_WHITE, 0.2)` | `3` |
| false | `shade(theme.textDim, 0.45)` | `1` |

Nodes, for `i` in `0..11` (861-878), with `lit = i <= reached` and `here = (i == reached) and not complete`:

| Piece | Rule |
|---|---|
| colour `col` | `lerpColor(accent, UI_WHITE, 0.35)` if `lit` else `shade(theme.textDim, 0.55)` |
| radius | `7` if `here` else (`5` if `lit` else `4`); if `here` then `+= int(1.6·pulse(t, 2.0))` (so 7 or 8 px, integer) |
| glow | if `lit`: `draw_glow_circle(x, y, 17.0 + (9.0 if here else 0.0), col, 0.30 + (0.35 if here else 0.0))` → r 17 α 0.30 for lit, r 26 α 0.65 for the "here" node |
| disc | `circle(col, (int(x), int(y)), radius)` |
| hollow centre | if **not** `lit`: `circle(shade(theme.bgBottom, 1.0), (int(x), int(y)), max(1, radius - 2))` — i.e. unreached nodes are rings, not dots |
| chapter ring | if `i % 3 == 0`: `circle(shade(col, 0.9), (int(x), int(y)), radius + 5, width=1)` — the four acts, without a word of label |

`shade(c, 1.0)` is the identity; the hollow-centre call is written that way for symmetry.
When `complete` there is no "here" node at all — every node is lit and node 11 stays radius 5.

#### 2.7.4 Free-play constellation art (`_draw_constellation`, 906-952)

Same `area` as the chain, at the right card: `(708, 90, 496, 78)`.
`n = max(1, LEVEL_COUNT) = 12`, `cx = area.centerx = 956`, `cy = area.centery = 129`,
`rx = area.w·0.46 = 228.16`, `ry = area.h·0.40 = 31.2`.

```
ang_i = i·2.39996 + 0.7          // golden angle, deterministic - never jitters
rad_i = sqrt((i + 0.55) / 12)
p_i   = (cx + cos(ang_i)·rad_i·rx,  cy + sin(ang_i)·rad_i·ry)
```

Settled positions (verified numerically against the capture, §2.14):

| i | x | y | | i | x | y |
|---|---|---|---|---|---|---|
| 0 | `993.4` | `133.3` | | 6 | `817.7` | `142.2` |
| 1 | `874.1` | `129.5` | | 7 | `995.7` | `104.9` |
| 2 | `1030.5` | `118.9` | | 8 | `1051.8` | `151.8` |
| 3 | `950.3` | `146.0` | | 9 | `762.1` | `120.5` |
| 4 | `866.0` | `114.3` | | 10 | `1150.2` | `116.7` |
| 5 | `1109.8` | `131.8` | | 11 | `869.7` | `157.2` |

Linking path (931-936): the points are sorted **by x**, not walked in spiral order — the comment
(928-930) explains that the spiral hops across the strip and reads as scribble. The x-sorted
index order is `9, 6, 4, 11, 1, 3, 0, 7, 2, 8, 5, 10`. Polyline of 11 segments, width `1`,
colour `shade(theme.textDim, 0.40)`, endpoints truncated to `int`. Drawn **before** the tiles.

Tiles (938-950), `open_ = _is_unlocked(i)`:

| | unlocked | locked |
|---|---|---|
| size | `13 x 13` | `10 x 10` |
| rect | `Rect(0,0,size,size)` with `center = (int(x), int(y))` | same |
| glow | `draw_glow_circle(x, y, 18.0, col, twinkle)` where `twinkle = 0.28 + 0.20·pulse(t·0.8 + i·0.7, 1.0)` (range 0.28..0.48) | none |
| fill | filled, `border_radius=3`, `col = lerpColor(accent, UI_WHITE, 0.30)` | none |
| stroke | none | width `1`, `border_radius=3`, `shade(theme.textDim, 0.55)` |

#### 2.7.5 Difficulty tile interior (`_draw_difficulty_tile`, 955-1013)

Per tile: `rect = tile.button.rect` (`w = 281`, `h = 208`, settled `y = 398`),
`x = rect.x + 16`, `rect.right = rect.x + 281`, `hov = clamp(tile.hover_t, 0, 1)`,
`chosen = (diff.key == self._difficulty)`, `col = diff.color`,
`bright = lerpColor(col, UI_WHITE, 0.25 + 0.30·hov)`.

Text-column x per tile: **easy 70, normal 367, hard 664, expert 961**.
Right-aligned x (`rect.right - 16`): **easy 319, normal 616, hard 913, expert 1210**.

| Element | Rel. position / size | Absolute y | Style / font | Anchor | Colour | Condition |
|---|---|---|---|---|---|---|
| Shoulder bar | `Rect(rect.x+10, rect.y+2, rect.w-20, 5)`, `border_radius=3` | `400` | filled, `261` wide | — | `bright` | always (966-968) |
| Selected halo | `draw_glow_circle(rect.centerx, rect.y+4, rect.w·0.55, col, 0.14 + 0.05·pulse(t, 1.4))` — r = `154.55`, α `0.14..0.19` | centre y `402` | additive glow | centre | `col` (**not** `bright`) | `chosen` (969-974) |
| Selected border | `rect`, width `3`, `border_radius = 18` | `398` | stroked | — | `bright` | `chosen` (974-975) |
| Hover border | `rect`, width `2`, `border_radius = 18` | `398` | stroked | — | `shade(bright, 0.8)` | `not chosen and hov > 0.01` (976-978) |
| Mode label (`diff.label`) | `(x, rect.y+16)` | `414` | `h2` (30 bold) | top-left | `bright` if (`chosen` or `hov > 0.3`) else `lerpColor(col, UI_WHITE, 0.1)` | always (983-985) |
| `"SELECTED"` | `(rect.right-16, rect.y+24)` | `422` | `tiny` | top-**right** | `lerpColor(col, UI_WHITE, 0.55)` | `chosen` (986-989) |
| Blurb line `i` (0..2) | `(x, rect.y + 56 + i·17)` | `454`, `471`, `488` | `tiny` | top-left | `shade(theme.textDim, 1.0)` | per wrapped line (991-994) |
| Row `i` label | `(x, rect.y + 114 + i·22)` | `512`, `534`, `556` | `tiny` | top-left | `shade(theme.textDim, 0.95)` | always (1003-1006) |
| Row `i` value | `(rect.right-16, rect.y + 114 + i·22 - 2)` | `510`, `532`, `554` | `small` | top-right | per-row (§2.6) | always (1007-1008) |
| Self-collision line | `(x, rect.y+182)` | `580` | `tiny` | top-left | `lerpColor(tone, UI_WHITE, 0.15)` | always (1010-1013) |

Rows, in order (997-1002): `("LIVES", …)`, `("SPEED", …)`, `("SCORE", …)`. The value's y is the
row y **minus 2** — `small` (17 px) is taller than `tiny` (14 px) and the −2 optically re-centres
it against the label. Transcribe the `-2`.

The selected halo is deliberately hung on the shoulder, not the middle: the comment (970-972)
says the tile has to stay legible while selected. Radius `rect.w · 0.55` = `154.55` is wider than
the tile, and it is centred on `(rect.centerx, rect.y + 4)`.

#### 2.7.6 Blurb wrapping (`_wrap`, 113-147)

`_wrap(diff.blurb, fonts.tiny, rect.w - 32 = 249, max_lines=3)`. Greedy, whitespace-split
(`str.split()`, so runs of whitespace collapse), breaks when `font.size(trial)[0] > width` **and**
`current` is non-empty, hard-capped at 3 lines with **no ellipsis** — a longer blurb is silently
truncated. On any exception the whole text becomes one unwrapped line (141-142). Called every
frame for four static strings, so it is memoised (§2.3.3).

With the shipped 14 px face all four blurbs wrap to **two** lines. These are the exact shipped
breaks and are the perceptual acceptance target for the port's own metrics:

| Mode | Line 1 | Line 2 |
|---|---|---|
| EASY | `Drift, coil and never once die to your own` | `tail.` |
| NORMAL | `The serpent as intended - fair, fast,` | `unforgiving of sloppiness.` |
| HARD | `Faster hazards, thinner mercy, and your` | `own coil bites back.` |
| EXPERT | `One life. No mercy. The grid remembers` | `every mistake.` |

The TS port must wrap at run time against its own measured widths — it must **not** hard-code
these strings. If the ported face measures differently and a blurb reaches 3 lines, the third
line lands at `y = 488` and still clears the LIVES row at `512`.

---

### 2.8 `update(dt)` — exact order (600-671)

**This is a shell-level menu scene: every consumer takes *real* dt** (`docs/port/integration.md`
§10). There is no `fx.time_scale()` anywhere in this file, no `sdt`, and no second clock. A
slow-mo left running by a previous scene must not reach this scene's animation.

1. `dt = clamp(float(dt), 0.0, C.MAX_DT)` — clamped to `0.05` s (602).
2. `_t += dt`; `_elapsed += dt` (603-604).
3. **RESTART disarm** (606-611): if `_restart_arm > 0`: `_restart_arm -= dt`; on crossing `<= 0`,
   snap to `0.0` and set `_restart.label = "RESTART STORY"`.
4. Read input once (613-617): `mouse = game.mouse_pos` (default `(0.0, 0.0)`);
   `held = bool(game.mouse_buttons.get(1))` — the **left** button, `False` on any failure.
   TS: `game.pointer.x/.y` and `game.pointer.down`.
5. Smoothing coefficients (619-620), recomputed per frame:
   `k_hover = 1 - exp(-13.0·dt)`, `k_press = 1 - exp(-22.0·dt)`.
6. `for card in self._cards + self._tiles:` — **cards first, then tiles**, list order — run
   `_update_card` (622-623, body 655-671):
   1. `appear = clamp((_elapsed - card.delay) / max(0.001, 0.46), 0.0, 1.0)`
   2. `rise = (1 - easeOutCubic(appear)) · 62.0`
   3. `rect = card.home.copy(); rect.y += int(rise)` — **`int()` truncation**, so the entrance
      lands on whole pixels and the widget's hit rect moves with it. At `appear = 0` the rect sits
      62 px low (`y = 134` for cards, `460` for tiles).
   4. `card.button.rect = rect` (the hit target follows the animation — a click during the
      entrance hits where the card is *drawn*).
   5. `card.button.update(dt, mouse)`; if `card.button.just_entered` → `audio.play("hover", 0.55)`.
   6. `card.hover_t += ((1 if button.hovered else 0) - card.hover_t)·k_hover`
   7. `card.press_t += ((1 if (button.hovered and held) else 0) - card.press_t)·k_press`
7. `for widget in (self._back, self._restart if self._show_restart() else None):` skip `None`;
   `widget.update(dt, mouse)`; if `widget.just_entered` → `audio.play("hover", 0.55)` (627-633).
   RESTART is only fed the mouse while it is on screen (comment 625-626), so it can neither hover
   nor click while hidden.
8. `if self._bg is not None: self._bg.update(dt)` (635-636) — real dt.
9. Ambience (638-644), unconditional, every frame:
   `game.particles.ambient((0, 0, 1280, 720), lerpColor(theme.accent, theme.accent2, 0.5), dt, rate=7.0)`.
   Full design box, not the arena rect; `twinkle` defaults to `0.0` so no `star`-kind motes are
   emitted here (8 % are `shard`, the rest `dot` — `particles.py:608-615`).
10. **Launch hand-off** (646-651): if `_launching`: `_launch_t -= dt`; when `<= 0`,
    `which, self._launching = self._launching, ""` and if `which == "story"` call `_start_story()`
    (which calls `switch_scene`, so this is the last thing this scene does).

Everything is inside one `try/except: pass` (601, 652-653). `Button.update` additionally re-clamps
its own dt to `0..0.1` (`ui.py:453`).

Easing curves used: `ease_out_cubic(t) = 1 - (1-t)³` (card entrance), `ease_out_back`
(header, §2.7.1), `pulse` (chain "here" node, constellation twinkle, selected halo). All three
exist in `web/src/core/mathx.ts` as `easeOutCubic`, `easeOutBack`, `pulse`.

Entrance timeline, from `_elapsed = 0`:

| t (s) | Event |
|---|---|
| `0.00` | story card starts rising from `y = 134`; header starts at `y = -30` |
| `0.09` | free card starts rising |
| `0.20 / 0.26 / 0.32 / 0.38` | tiles 0..3 start rising from `y = 460` |
| `0.46` | story card settled at `y = 72` |
| `0.50` | header settled at `y = 14` (after a 4.4 px overshoot peaking at `_elapsed ≈ 0.29`) |
| `0.55` | free card settled |
| `0.66 / 0.72 / 0.78 / 0.84` | tiles 0..3 settled at `y = 398` |

While `_launching` is set the entrance animation, particles and background keep running — only
`handle_event` is locked out (§2.10).

---

### 2.9 `draw()` — layer order, top of the list painted first (676-723)

The scene saves and restores `surface.get_clip()` in a `try/finally` (677-723) but **never sets a
clip**; it is purely defensive. There is no mask in this scene.

| # | Layer | Detail |
|---|---|---|
| 1 | Background | `_bg.draw(surface)` if built, else `surface.fill(theme.bg_bottom)` (fallback literal `(8,10,20)` if the theme has no `bg_bottom`). Style = `theme.bg_style` for the campaign's current level; built over `(0, 0, 1280, 720)` — the **whole design box**, not the arena. In the port this layer may fill `viewport.overscan` (background spec). |
| 2 | Particles | `game.particles.draw(surface)` (687-690). **Note the position: particles are painted behind every piece of chrome on this screen**, unlike `GameplayScene` where they sit above the snake. |
| 3 | Header | `_draw_header` (692) |
| 4 | Mode cards | `for card in self._cards` (story, then free), skipping `appear <= 0.0`: `card.button.draw(surface, theme, fonts, self._t)` **then** `_draw_story_card` / `_draw_free_card` on top of it (695-702) |
| 5 | RESTART | `self._restart.draw(surface, theme, fonts, self._t)` if `_show_restart()` (704-705) |
| 6 | Difficulty header | `_draw_difficulty_header` (707) |
| 7 | Difficulty tiles | `for tile in self._tiles` (easy..expert), skipping `appear <= 0.0`: `tile.button.draw(...)` then `_draw_difficulty_tile` on top (708-712) |
| 8 | BACK | `self._back.draw(surface, theme, fonts, self._t)` (714-715) |
| 9 | Footer hint | `_draw_footer` (716) |
| — | cursor + CRT/post-processing | shell-level, above every scene (`integration.md` §2.2) |

The `t` handed to every `Button.draw` and to all the art is `self._t` — the scene's own
real-dt-integrated clock, which restarts at `0` on each entry. It is **not** `game.time`. That
matters: `Button.draw`'s idle shimmer is `0.10 + 0.05·pulse(t·1.6 + rect.x·0.01)` (`ui.py:521`),
so the buttons' breathing phase resets on every entry and is spatially offset by `rect.x`.

Cards and tiles with `appear <= 0.0` are skipped in `draw` but their buttons are **already
enabled and being updated** — a click landing in the first 0.20 s on an invisible tile registers.
Preserve or fix deliberately; the practical window is ~12 frames.

Pixi structure suggestion (one child `Container` of `root` per row of the table, created in the
constructor, never per frame): `bgLayer`, then the borrowed particle root, then `headerLayer`,
`cardLayer` (two card sub-containers, each with `shoulder / rim+halo / art / text` children),
`restartLayer`, `diffHeaderLayer`, `tileLayer` (four sub-containers), `backLayer`, `footerLayer`.
Follow the established idiom from `GameplayScene.onEnter` (`web/src/scenes/GameplayScene.ts:141-148`):
borrow `game.particles.root` with `addChildAt(..., 1)` in `onEnter` and `removeChild` it in
`onExit`, with `setClipRect(null)`.

Every string on this screen is either constant for the entry (titles, blurbs, hint, row labels)
or changes only when `_difficulty` / `_restart_arm` changes. **One persistent `Text` per string,
re-set only when the string differs** — nothing here justifies a per-frame rasterisation.

---

### 2.10 Input and transitions

`handle_event` (401-421). All of it inside one `try/except: pass`.

1. `if self._launching: return` — **the flourish owns the last moment** (403-404). Every mouse and
   key event is dropped for 0.22 s after a story launch.
2. `for card in self._cards:` `if card.button.handle_event(event): self._activate(str(card.key))`.
3. `for tile in self._tiles:` `if tile.button.handle_event(event): self._pick_difficulty(str(tile.key))`.
4. `if self._restart is not None and self._show_restart() and self._restart.handle_event(event): self._activate("restart")`.
5. `if self._back is not None and self._back.handle_event(event): self._activate("back")`.
6. `if event.type == pygame.KEYDOWN: self._handle_key(event.key)`.

Every widget is offered the same event; because no two rects overlap (cards end at `y = 322`,
RESTART is `332..362`, tiles are `398..606`, BACK is `612..664`) at most one can fire.
`Button.handle_event` reports a click only when the `MOUSEBUTTONDOWN` **and** the
`MOUSEBUTTONUP` both land inside the rect, and only if its `C.UI_CLICK_COOLDOWN = 0.1` s
debounce has expired (`ui.py:469-490`) — so dragging off a card safely cancels.

Bindings:

| Binding | Kind | Effect |
|---|---|---|
| Left-click a mode card | edge (down+up inside) | `_activate("story" \| "free")` |
| Left-click a difficulty tile | edge | `_pick_difficulty(key)` |
| Left-click RESTART (only when `_show_restart()`) | edge | `_activate("restart")` |
| Left-click BACK | edge | `_activate("back")` |
| Mouse move | continuous | hover weights, `just_entered` → `"hover"` cue |
| Left button **held** | held | feeds `press_t` only (`target_p = hovered and held`); no action |
| `ESC`, `BACKSPACE` | KEYDOWN edge | `_activate("back")` (425-426) |
| `RETURN`, `KP_ENTER`, `SPACE` | KEYDOWN edge | `_activate("story")` (427-428) |
| `F`, `L` | KEYDOWN edge | `_activate("free")` (429-430) |
| `LEFT`, `A` | KEYDOWN edge | `_pick_difficulty(D.prev_difficulty(_difficulty))` — wraps easy→expert (431-432) |
| `RIGHT`, `D` | KEYDOWN edge | `_pick_difficulty(D.next_difficulty(_difficulty))` — wraps expert→easy (433-434) |
| `1`,`2`,`3`,`4` | KEYDOWN edge | `_pick_difficulty(D.all_difficulties()[i].key)`, `i = 0..3`, guarded by `index < len(order)` (435-439) |

Nothing is held-triggered and there is no gamepad path. The keyboard shortcuts are explicitly "a
convenience layer, never the only route" (424) — the whole screen is reachable with the mouse.
`RETURN`/`SPACE` launching **story** (not "the last thing you touched") is deliberate.

`_activate(action)` (464-484):

```
if action == "restart" and _restart_arm <= 0.0:
    _restart_arm = 3.0 ; _restart.label = "ERASE PROGRESS?" ; audio("hit", 0.7) ; return
audio("click")                       # volume 1.0, every other action
action == "back"    -> game.switch_scene(C.SCENE_MENU)
action == "free"    -> _start_free()
action == "story"   -> _begin_launch("story")
action == "restart" -> _restart_arm = 0.0 ; _reset_story() ; _begin_launch("story")
```

Transition table:

| Trigger | Verb | Target | Args passed | Session/save writes on the way out |
|---|---|---|---|---|
| BACK click, `ESC`, `BACKSPACE` | `switch_scene` | `C.SCENE_MENU` = `"menu"` | none | none |
| FREE PLAY card click, `F`, `L` | `switch_scene` | `C.SCENE_LEVELS` = `"levels"` | none | `game.mode = C.MODE_FREE`; `save.set_mode("free")`; `save.flush()` (502-513). **No `level_index` write** — level select owns that. |
| STORY card click / `RETURN` / `SPACE` / confirmed RESTART | `_begin_launch` → 0.22 s later `switch_scene` | `C.SCENE_STORY` = `"story"` | `cards=<list>`, `next_scene=C.SCENE_GAME` (`"game"`), `next_kwargs={"level_index": index}`, `theme=P.theme_for_level(index)` (592-595) | `game.mode = C.MODE_STORY`; `game.level_index = index`; `save.set_mode("story")`; possibly `save.mark_beat_seen(100)`; `save.flush()` |
| RESTART click, 1st | *(no transition)* | — | — | arms only: `_restart_arm = 3.0`, label swap, `audio("hit", 0.7)` |
| RESTART click, 2nd within 3.0 s | `_reset_story()` then the story transition above | `"story"` | as above | `save.set_story_complete(False)`; `save.story_progress = 0`; `save.seen_beats` filtered; `save.save()` — then the story writes |
| Any difficulty tile / `←`/`→`/`A`/`D`/`1..4` | *(no transition)* | — | — | `game.difficulty = diff.key`; `save.set_difficulty(diff.key)`; `save.flush()` — **immediately, on every pick** |

`_begin_launch(which)` (486-500): `_launching = which`; `_launch_t = 0.22`;
`audio.play("start", 0.9)`; `fx.flash(theme.accent, 0.30)`;
`particles.burst(card.rect.centerx, card.rect.centery, theme.accent, count=26)` where
`card = _cards[0]` for `"story"` else `_cards[1]`. Settled burst centre for story is
**`(324, 197)`**. `_launching == "free"` is a **dead branch** — `_start_free()` switches
immediately and never sets `_launching` — but keep the generic shape if you port it verbatim.

`_start_story()` (575-595), in order:
1. `index = _story_index()`
2. `game.mode = C.MODE_STORY`; `game.level_index = index`
3. `save.set_mode(C.MODE_STORY)` (no flush yet)
4. `cards = _story_cards(index)` — **this has the side effect of marking the prologue seen**
5. `save.flush()`
6. `switch_scene(C.SCENE_STORY, …)` as tabulated

`_story_cards(index)` (539-573) builds the card stack the story presenter shows, each element
dropping out silently if it fails to build:

| Slot | Content | Condition |
|---|---|---|
| 1 | `S.PROLOGUE` (a `StoryCard`: title `"Cold Start"`, 4 lines, speaker `"boot log"`) and then `save.mark_beat_seen(PROLOGUE_BEAT)` | only if `not save.beat_seen(100)` — first story run only |
| 2 | `S.get_chapter(index)` — handed over **as a `Chapter`, not flattened** | always |
| 3 | `StoryCard(title=beat.title, lines=tuple(beat.intro), speaker=beat.speaker)` from `S.get_beat(index)` | always |

Slot 2's comment (558-563) is a bug-fix note worth carrying into the port: `StoryScene` promotes
anything exposing `roman` to its full chapter plate (huge numeral, long rule, extra air), and
flattening the `Chapter` into a `StoryCard` first threw the numeral away, so the same beat looked
different depending on whether it was reached from here or from `VictoryScene`. **In TS,
`Chapter.roman` is a *method*** (`story.ts:84`), so the duck-type test is
`typeof (card as Chapter).roman === "function"`, and the list type is
`Array<StoryCard | Chapter>`. That is the story-scene section's contract; recorded here because
this scene is what fills the list.

`_reset_story()` (515-537): `save.set_story_complete(False)`; `save.story_progress = 0`
**by direct field assignment** because `set_story_progress` only ever moves forward
(comment 524-526; `save.py:783-785`, TS `save.ts:904-905`);
`save.seen_beats = [i for i in list(save.seen_beats) if i != PROLOGUE_BEAT]`; `save.save()`.
It does **not** touch `unlocked`, `best` or `stars` — restarting the campaign does not relock
free play or delete scores.

---

### 2.11 What is written to `game.*` and `SaveData`, and when

| Field | Written | When | Line |
|---|---|---|---|
| `game.difficulty` | `diff.key` | **on every pick** (click or key), not on confirm, not on exit | 454 |
| `save.difficulty` (via `set_difficulty`) + `save.flush()` | `diff.key` | same moment | 458-459 |
| `game.mode` | `C.MODE_FREE` | on FREE PLAY activation, before the switch | 505 |
| `save.mode` (via `set_mode`) + `flush()` | `"free"` | same moment | 509-510 |
| `game.mode` | `C.MODE_STORY` | in `_start_story`, i.e. **after** the 0.22 s flourish | 579 |
| `game.level_index` | `_story_index()` | same moment | 580 |
| `save.mode` (via `set_mode`) | `"story"` | same moment (flushed at 589) | 584 |
| `save.seen_beats` += `100` (via `mark_beat_seen`) | prologue slot | inside `_story_cards`, only on the first story run | 554 |
| `save.story_complete = False`, `save.story_progress = 0`, `save.seen_beats` −= `100`, `save.save()` | | on the **confirmed** RESTART only | 515-537 |
| `game.last_result` | — | **never touched by this scene** | |

`_current_difficulty()` (309-314) resolves the *displayed* selection on entry:
`key = game.difficulty`; if `not D.is_difficulty_key(key)` fall back to `save.difficulty`;
return `D.get_difficulty(key).key` (total, never raises, defaults to `"normal"`).
So session state wins over the save file, and a corrupt value in either degrades to NORMAL.

Hover never writes anything. There is no "cancel" — every difficulty click is already persisted,
so leaving via BACK keeps the new difficulty.

---

### 2.12 Audio cues, fx and particle calls

All audio goes through `self._play(name, volume=1.0)` (375-379) → `game.audio.play(name, volume)`,
swallowing exceptions.

| Cue | Volume | Trigger | Line |
|---|---|---|---|
| `"hover"` | `0.55` | any mode card / difficulty tile `just_entered` | 667 |
| `"hover"` | `0.55` | BACK or (visible) RESTART `just_entered` | 633 |
| `"hover"` | `0.5` | `_pick_difficulty` on the **already-selected** mode (`changed == False`) | 462 |
| `"click"` | `0.9` | `_pick_difficulty` when the selection **changed** | 462 |
| `"click"` | `1.0` | `_activate` for `back` / `free` / `story` / confirmed `restart` | 474 |
| `"hit"` | `0.7` | RESTART's **first** click (arming the confirm) | 471 |
| `"start"` | `0.9` | `_begin_launch` | 490 |

Cross-checked against `web/src/data/audio.json` `names`: `eat, bonus, powerup, hit, die, click,
hover, start, levelup, win, boost, portal`. **All four cues this scene uses — `hover`, `click`,
`hit`, `start` — are present.** No unknown names.

Screen effects and particles:

| Call | Args | Trigger | Line |
|---|---|---|---|
| `game.fx.flash` | `(self._theme.accent, 0.30)` | `_begin_launch` | 492 |
| `game.particles.burst` | `(card.rect.centerx, card.rect.centery, self._theme.accent, count=26)` — story card centre, settled `(324, 197)` | `_begin_launch` | 497-499 |
| `game.particles.ambient` | `((0, 0, 1280, 720), lerpColor(theme.accent, theme.accent2, 0.5), dt, rate=7.0)` | every `update` frame | 639-642 |
| `game.particles.draw` | `(surface)` | every `draw`, **layer 2 (behind all chrome)** | 688 |

**No `fx.shake`, no `fx.slowmo`, no `fx.begin_transition` (the shell does that inside
`switch_scene`), no `particles.ring`, no `particles.trail`, no `particles.clear`.**
`fx.set_theme` is *not* called here either — this scene never re-tints the transition wipe, so the
wipe out of mode-select uses whatever theme the previous scene set. Note it; do not add a call.

TS mapping: `game.fx` → `game.post.fx` (`ScreenFx`, `web/src/gfx/post/ScreenFx.ts`) with
`flash(color, amount)` at 332 and `beginTransition()` at 397 — signatures already match.
`particles.burst(x, y, color, {count: 26})` and
`particles.ambient(rect, color, dt, {rate: 7.0})` — options-object form
(`web/src/gfx/particles.ts:773, 951`); `twinkle` defaults to `0.0` in both languages, so leave it out.
`draw_glow_circle(surface, x, y, r, col, intensity)` has no direct TS twin: use
`glowSprite(radius, color, intensity)` / `setGlow(sprite, radius, color, intensity)` from
`web/src/gfx/textures.ts:255,270` (additive-blend sprites, per `docs/port/render.md`).

---

### 2.13 Data dependencies, and what the TS core exposes

| Python read | Value used for | TS equivalent | Status |
|---|---|---|---|
| `game.difficulty` / `game.mode` / `game.level_index` | selection + hand-off | `game.difficulty` / `game.mode` / `game.levelIndex` (`Game.ts:82-83, 81`) | present |
| `game.mouse_pos` | hover / hit tests | `game.pointer.x/.y` | present |
| `game.mouse_buttons.get(1)` | `press_t` | **no button map** — use `game.pointer.down` (`Game.ts:65`) | naming shim |
| `game.switch_scene(name, **kw)` | transitions | `game.switchScene(key, args)` | present |
| `game.save` | everything in §2.11 | **no `SaveData` instance on `Game`** — `core/save.ts` `SaveData` is ported but unwired | **gap** |
| `game.fonts` (`FontBook`) | `display_at(34)`, `h2`, `body`, `small`, `tiny` | not ported | **gap (ui phase)** |
| `game.audio.play(name, vol)` | 4 cues | not ported | **gap (audio phase)** |
| `game.fx.flash` | launch flash | `game.post.fx.flash` | naming shim |
| `game.particles.*` | ambient / burst / draw | `game.particles` (`Game.ts:59`) | present |
| `make_background(style, theme, (0,0,1280,720))` | backdrop | `makeBackground(style, theme, rect, renderer)` (`web/src/gfx/bg/index.ts:81`) — **takes a 4th `renderer` argument** the Python signature does not have | signature difference |
| `P.theme_for_level(i)` | `_theme` | `themeForLevel(i)` (`palette.ts:261`) | present |
| `P.THEMES[0]` | theme fallback | `THEMES[0]` | present |
| `P.lerp_color / shade / UI_WHITE / UI_DIM / UI_GOOD / UI_WARN / UI_BAD / UI_GOLD` | every colour | `lerpColor / shade / UI_*` (`palette.ts`) | present |
| `theme.accent / accent2 / text / text_dim / bg_bottom / bg_style` | colours + bg | `accent / accent2 / text / textDim / bgBottom / bgStyle` | present (camelCase) |
| `D.all_difficulties()` | tile list + `1..4` keys | `allDifficulties()` | present |
| `D.get_difficulty / is_difficulty_key / next_difficulty / prev_difficulty` | picking | `getDifficulty / isDifficultyKey / nextDifficulty / prevDifficulty` | present |
| `D.lives_for(diff)` | LIVES row + header | `livesFor(diff)` | present |
| `diff.key / blurb / color / self_mode / speed_mult / score_mult` | tiles | `key / blurb / color / selfMode / speedMult / scoreMult` | present |
| `diff.label` (**property**) | tile heading + header | **no property on the TS `Difficulty` interface** — module function `label(diff)` (`difficulty.ts:329`) or `diff.name.toUpperCase()` | naming shim |
| `LEVEL_COUNT` | `12`, everywhere | `LEVEL_COUNT` (`core/level.ts:265`) | present |
| `S.get_chapter(i)` → `.roman`, `.title` | story footer left | `getChapter(i)` → **`.roman()` is a method**, `.title` | naming shim |
| `S.CHAPTERS[-1].roman` (fallback literal `"IV"`, lines 820-823) | `"… OF IV"` | `CHAPTERS[CHAPTER_COUNT - 1].roman()` | naming shim |
| `S.CHAPTER_SIZE` | chapter rings on the chain | `CHAPTER_SIZE = 3` (`story.ts:28`) | present |
| `S.get_beat(i)` → `.title`, `.intro`, `.speaker` | story card stack | `getBeat(i)` → `.title`, `.intro`, `.speaker` | present |
| `S.PROLOGUE` | first card | `PROLOGUE` (`story.ts:220`) | present |
| `StoryCard(title=, lines=, speaker=)` | wrapping the beat | `StoryCard` is an **interface** — build `{ title, lines, speaker }` | shape difference |
| `save.story_progress` (read **and written**) | resume level, restart | `save.storyProgress` (public mutable, `save.ts:450`) | present |
| `save.story_complete` / `set_story_complete` | complete state | `storyComplete` / `setStoryComplete` | present |
| `save.beat_seen(100)` / `mark_beat_seen(100)` / `seen_beats` | prologue gating | `beatSeen` / `markBeatSeen` / `seenBeats` | present |
| `save.unlocked` | free-play footer | `unlocked` | present |
| `save.total_stars()` (**no arg**) / `max_stars()` | stars footer | `totalStars()` / `maxStars()` | present |
| `save.is_unlocked(i)` | constellation | `isUnlocked(i)` | present |
| `save.difficulty` / `set_difficulty` / `set_mode` / `flush()` / `save()` | persistence | `difficulty` / `setDifficulty` / `setMode` / `flush()` / `save()` | present |
| `C.SCENE_MENU / SCENE_LEVELS / SCENE_STORY / SCENE_GAME` | targets | **`config.ts` exports no `SCENE_*`** — `SCENES.MENU/LEVELS/STORY/GAME` from `app/Scene.ts` | naming shim |
| `C.MODE_STORY / MODE_FREE / DEFAULT_DIFFICULTY / WINDOW_W / WINDOW_H / MAX_DT / UI_CORNER` | everywhere | same names in `core/config.ts` | present |
| `contracts.clamp / ease_out_cubic / ease_out_back / pulse` | animation | `clamp / easeOutCubic / easeOutBack / pulse` (`core/mathx.ts`) | present |
| `ui.Button`, `ui.draw_text` | widgets | ui phase (`docs/port/ui.md`) | **gap (ui phase)** |
| `_wrap`, `_mult`, `PROLOGUE_BEAT`, `_SELF_TEXT` | scene-local | nothing yet | **new code** |

This scene reads **nothing** from `levels.json` beyond `LEVEL_COUNT`, and nothing from
`config.json` beyond the seven constants above. It never touches `game.last_result`.

---

### 2.14 Capture cross-check (`captures/02-mode-select.png`, 1280x720)

The capture was taken with `save.story_progress = 4`, `story_complete = False`,
`unlocked = 12`, `total_stars() = 17`, `difficulty = "expert"`, and the mouse inside the story
card. Theme = `theme_for_level(4)` = **"Abyssal Tide"**, `bg_style = "ocean"`,
`accent = (72,200,255)`, `accent2 = (140,255,226)`, `bg_bottom = (1,8,22)`
(`web/src/data/themes.json`, theme index 4).

Everything reconciled:

| On screen | Accounted for by |
|---|---|
| `"CHOOSE YOUR DESCENT"` centred at the top | §2.7.1, settled `y = 14` |
| Left card's **full bright rim + top halo**, right card's dim edge | the story card is hovered (`hov ≈ 1`): rim at 768-770, halo at 771-772. The cursor sits at ≈`(320, 190)`, inside `(54,72,540,250)` ✓ |
| `"CONTINUE >"` noticeably brighter than `"LEVEL SELECT >"` | `0.25 + 0.55·hov` vs `0.25 + 0` (795) |
| Story shoulder/rim mint-white, free shoulder/tiles blue | `accent2 (140,255,226)` vs `accent (72,200,255)` (§2.5) |
| Chain: nodes 0-3 filled, node 4 larger + brighter halo, 5-11 hollow rings | `reached = 4`; `here = (i == 4)`; hollow centres at 873-875 |
| Extra thin rings on chain nodes 0, 3, 6, 9 | `i % CHAPTER_SIZE == 0` (876-878) |
| Chain first node ≈`(92,104)`, last ≈`(556,148)` | §2.7.3 table ✓ |
| 12 blue squares scattered right, all filled (none outlined) | `_is_unlocked(i)` true for all 12 (`unlocked = 12`); positions match §2.7.4 exactly, incl. the leftmost at `(762,120)` and the close pair `(866,114)`/`(874,129)` |
| Faint 1 px polyline through the squares, left-to-right | x-sorted chain at 931-936 |
| `"CHAPTER II OF IV  -  THE WORKING LAYERS"` | `get_chapter(4)` = chapter 2 `"The Working Layers"`, `.upper()`; `CHAPTERS[-1].roman = "IV"` |
| `"LEVEL 5 / 12"` | `index + 1 = 5`, `LEVEL_COUNT = 12` |
| `"12 OF 12 UNLOCKED"` / `"17 / 36 STARS"` | `_unlocked_count()`; `total_stars() = 17`, `max_stars() = 12·3 = 36` |
| RESTART STORY pill at `(56,332,192,30)` | `_show_restart()` true (`index = 4 > 0`) |
| `"DIFFICULTY"` left, `"SELECTED  -  EXPERT  (1 LIFE)"` right, both at `y = 374` | 736-744; singular `"LIFE"` because `lives == 1` |
| EXPERT tile with a 3 px border, pink shoulder glow and a `"SELECTED"` tag | `chosen` branch 969-989 |
| Rows `5/x0.82/x0.8`, `3/x1/x1`, `2/x1.15/x1.35`, `1/x1.3/x1.8` | `_mult` on `speed_mult`/`score_mult` §2.6 ✓ |
| LIVES values green, green, amber, red | `UI_GOOD/UI_GOOD/UI_WARN/UI_BAD` thresholds at 998-999 |
| Four self-collision lines, each in its own tone | `_SELF_TEXT` §2.6 ✓ |
| All four blurbs on exactly two lines, breaking as in §2.7.6 | `_wrap(…, tiny, 249, 3)` |
| BACK pill at `(240,612,210,52)`, hint line right-aligned at `y = 630` | §2.7.1 |
| Bright cyan core with a magenta hex ring and four cyan arc arms at ≈`(320,190)`, plus a short comet of dashes | **shell-level custom cursor** (`draw_cursor`, `game.mouse_pos` + `CURSOR_TRAIL_LEN = 14`) — not scene chrome |
| Small pale four-armed glints near `(465,40)` and `(1235,385)`, and a faint ring inside the BACK pill at ≈`(433,630)` | **shell/background level**: `particles.ambient(rate=7.0)` motes (`shard`/`dot` kinds, 8 %/92 % — `twinkle = 0` means no `star` kind, so the crossed shapes are spinning `shard`s and the `ocean` stage's own animated specks) |
| `"60.0 fps"` top-right | shell debug readout |
| Corner vignette, scanlines and the rounded bezel edge at the extreme top-left | CRT post-processing (`gfx/effects.py`, `web/src/gfx/post`) |

**Nothing on screen is unaccounted for.** The only pieces not produced by this scene's `draw` are
the cursor, the ambient motes, the fps readout and the post-processing — all shell-level.

---

### 2.15 Suggested TS home

| Piece | Suggested location | Name |
|---|---|---|
| The scene | `web/src/scenes/ModeSelectScene.ts` | `class ModeSelectScene extends Scene` |
| Layout + animation constants of §2.2 | same file, module scope | `MARGIN`, `CARD_W`, …, `PRESS_K` |
| `PROLOGUE_BEAT` | same file, exported | `export const PROLOGUE_BEAT = 100` |
| `_SELF_TEXT` | same file, module scope | `SELF_TEXT: Record<SelfMode, [string, RGB]>` — key it by the TS `SelfMode` union so a new mode is a compile error, and keep the runtime fallback |
| `_Card` | `web/src/ui/AnimatedCard.ts` | `class AnimatedCard` — `LevelSelectScene` paints its tiles the same way (`mode_select.py:23`), so this wants to be shared rather than duplicated; the two scenes' section owners should agree on one home |
| `_wrap` | `web/src/ui/textWrap.ts` (ui.md's call) | `wrapText(text, measure, width, maxLines)` taking a `(s: string) => number` measurer so it is font-agnostic and cacheable by face *name* |
| `_mult` | `web/src/ui/format.ts` | `formatMult(v: number): string` |
| Chain art | private display class in the scene file | `class ChainArt extends Container` — `setProgress(index, complete)` + `update(t)` |
| Constellation art | private display class in the scene file | `class ConstellationArt extends Container` — `setUnlocked(pred)` + `update(t)` |

---

### 2.16 Open questions for this section

1. **`SaveData` is not wired onto `Game`.** Every one of this scene's readouts is a save query;
   until `game.save` exists the whole screen degrades to "nothing unlocked, level 1, 0 stars"
   (which the Python's defensive fallbacks also produce, so it *renders*, but wrongly). Who
   owns wiring it — the shell or the first scene that needs it?
2. **Widget hover weights are not reset on entry** (§2.3.3). Port the Python's behaviour or fix
   it? Recommendation: fix it (zero `hoverT`/`pressT`/`flash`/`cool` in `AnimatedCard.reset()`)
   and record the divergence, since the visible artefact lasts ~4 frames and nothing tests it.
3. **Cards are clickable before they are drawn** (first 0.20 s for tiles, §2.9). Preserve or gate
   `enabled` on `appear > 0`?
4. **`_launching == "free"` is dead code** (§2.10). Drop the branch or keep the symmetry?
5. **Background `renderer` argument** (§2.13): the TS `makeBackground` needs a `Renderer`, so the
   scene must hold one (`game.app.renderer`) — and `onResize` has to rebuild, as
   `GameplayScene.onResize` does. The Python has no equivalent and no resize hook here.
6. **`fx.set_theme` is never called by this scene**, so the wipe out of mode-select is tinted by
   whatever the *previous* scene set. Faithful, but is it intended? Flagging rather than fixing.
7. **Shell defect noticed while reading** (not this scene's, but it will bite the pause overlay):
   `Game.pushScene` adds `scene.root` to `this.post.scene` (`Game.ts:203`) while
   `Game.popScene` removes it from `this.world` (`Game.ts:212`) — a popped overlay's root is
   never detached. Mode-select never pushes, so it is unaffected.
## 3. Level select (`LevelSelectScene`)

**Ground truth:** `E:/SnakeGame/snake/scenes/level_select.py`, 1054 lines, whole file. Every
`NN` or `NN-MM` below is a line number in **that** file unless another file is named.

**Suggested TS home:** `web/src/scenes/LevelSelectScene.ts`, class `LevelSelectScene extends Scene`
(`web/src/app/Scene.ts:18`), registered under `SCENES.LEVELS = "levels"`
(`web/src/app/Scene.ts:68`). Three module-private helper classes come with it:
`LevelCard` (`_Card`, 204-226), `DiffTile` (`_DiffTile`, 229-236), `LevelRecord` (`_Record`,
106-133). Four free helpers: `starPolygon` (`_star_points`, 139-147), `wrapText` (`_wrap`,
150-182), `tintRect` (`_tint`, 185-201) and the vector padlock (`_draw_padlock`, 943-961) — see
§3.15 for which of those should be hoisted out of the scene module and which must not.

**Companion spec:** `docs/port/ui.md` owns `Button`, `draw_panel`, `draw_text`, `draw_bar` and the
font book. This section records only *what this scene asks them for*.

---

### 3.1 Identity and registration

| Fact | Value | Source |
|---|---|---|
| Python class | `LevelSelectScene(Scene)` | 239-240 |
| File / lines | `snake/scenes/level_select.py`, 1-1054 (class body 239-1054) | — |
| Registry key | `C.SCENE_LEVELS` = `"levels"` → `("level_select", "LevelSelectScene")` | `snake/main.py:35`; `web/src/data/config.json:87` |
| `transparent` | `False` | 242 |
| `blocks_update` | `True` | 243 |
| Entered from | `MenuScene` and `ModeSelectScene` (free-play branch) — both `switch_scene`, not push | outside this file |
| Leaves to | `C.SCENE_MENU` via `switch_scene` (524-529); `C.SCENE_GAME` via `switch_scene(..., level_index=idx)` (557-570) | — |
| Optional enter arg | `level_index: int` — which card to focus (327) | — |

Nothing ever pushes *onto* this scene, and this scene never pushes: both exits are
`switch_scene`, so `on_exit` always runs and the background is always dropped (331-335).

---

### 3.2 Module-level layout constants

Transcribed exactly from 62-103. Column 4 says whether the number is derived or literal — the
module docstring claims "everything derives from the canvas size in config" (59-61) but only
`DIFF_ROW_X`, `DIFF_ROW_W` and `DETAIL_RECT` actually do. **Do not "fix" the literals into
derived expressions.**

| Constant | Line | Value | Derivation |
|---|---|---|---|
| `COLS` | 62 | `3` | literal |
| `ROWS` | 63 | `4` | literal (one chapter per row: `CHAPTER_SIZE = 3`, `web/src/core/story.ts:28`) |
| `BAND_X` | 65 | `36` | literal |
| `BAND_W` | 66 | `168` | literal |
| `GRID_LEFT` | 68 | `216` | literal |
| `GRID_TOP` | 69 | `100` | literal |
| `CARD_W` | 70 | `329` | literal |
| `CARD_H` | 71 | `104` | literal |
| `CARD_GAP_X` | 72 | `20` | literal |
| `CARD_GAP_Y` | 73 | `16` | literal |
| `DETAIL_RECT` | 75 | `(48, 586, 1184, 98)` | `Rect(48, 586, C.WINDOW_W - 96, 98)`, `WINDOW_W = 1280` |
| `BACK_RECT` | 85 | `(216, 48, 148, 42)` | literal; the comment at 77-84 explains why it is **not** at (36, 12) — the CRT bezel passes ~4 % of the light there, ~0.68 here. Keep the position even though the web port's bezel is the ported `PostChain` |
| `DIFF_TILE_W` | 88 | `112` | literal |
| `DIFF_TILE_H` | 89 | `36` | literal |
| `DIFF_TILE_GAP` | 90 | `10` | literal |
| `DIFF_ROW_Y` | 91 | `52` | literal |
| `DIFF_ROW_W` | 92 | `478` | `112 * 4 + 10 * 3` |
| `DIFF_ROW_X` | 93 | `401` | `(1280 - 478) // 2 = 802 // 2` — integer division, so 401 not 401.0 |
| `INTRO_STAGGER` | 96 | `0.05` s | per diagonal step |
| `INTRO_TIME` | 98 | `0.42` s | one card's fly-in |
| `INTRO_RISE` | 100 | `44.0` px | start offset below home |
| `REFRESH_SCALE` | 103 | `0.45` | entrance time-scale after a difficulty change |

Constants borrowed from elsewhere: `C.UI_CORNER = 12` (`web/src/data/config.json:123`),
`C.UI_CLICK_COOLDOWN = 0.1` (`:122`), `C.WINDOW_W/H = 1280/720` (`:130`, `:125`),
`C.DEFAULT_DIFFICULTY = "normal"` (`:26`), `C.MODE_FREE = "free"` (`:76`),
`LEVEL_COUNT = 12` (`web/src/core/level.ts:265`). **All present in `config.json`/`core/*`; no new
constants needed.** The 20 layout numbers above are scene-local presentation constants — they
belong in the TS scene module, not in `config.json` (same rule integration.md §3 applies to
`READY_TIME` and friends).

---

### 3.3 Owned state — every instance attribute

`__init__` 245-261, `on_enter` 304-329. Scene instances are cached and reused
(`snake/main.py:286`; `web/src/app/Scene.ts:35-39`), so the middle column is the one that matters.

| Attribute | Type | `__init__` value | `on_enter` resets to | Notes |
|---|---|---|---|---|
| `cards` | `List[_Card]` | `[]`, then `_build()` fills 12 (247, 261) | **not rebuilt**; each element `card.reset()` at 316-318 | list identity and `card.home` are permanent |
| `diff_tiles` | `List[_DiffTile]` | `[]`, then `_build()` fills 4 (248, 261) | not rebuilt; rect re-wrapped + re-enabled (319-321) | see the no-op note below |
| `back` | `Optional[Button]` | `Button(BACK_RECT, "BACK", style="ghost", data="back")` (249, 289) | `rect = BACK_RECT.copy()`, `set_enabled(True)` (322-324) | rect copy matters: `Button.__init__` stores the *same* Rect object family, and a stale rect would survive otherwise |
| `focus` | `int` | `0` (250) | `kwargs["level_index"]` → `game.level_index` → `0`, then falsified to `_highest_unlocked()` if that index is locked (327-328) | drives theme, background, header accents, detail panel |
| `elapsed` | `float` | `0.0` (251) | `0.0` (306) | the entrance clock |
| `_records` | `Dict[int, _Record]` | `{}` (252) | fully re-read by `_refresh_records()` (314) | 12 entries, keys `0..11` |
| `_diff_key` | `str` | `C.DEFAULT_DIFFICULTY` (253) | `D.get_difficulty(game.difficulty).key` (313) | never trusts `game.difficulty` raw |
| `_diff_hover` | `Optional[str]` | `None` (254) | `None` (308); recomputed every `update` (615-621) | difficulty key under the pointer |
| `_intro_scale` | `float` | `1.0` (255) | `1.0` (310) | `0.45` while refreshing; **never restored to 1.0 within a visit** (514) |
| `_refresh_t` | `float` | `0.0` (256) | `0.0` (309) | **write-only — see the dead-field note** |
| `_bg` | `Background \| None` | `None` (257) | `_ensure_background()` (329); `None` in `on_exit` (333) | large pre-rendered stage |
| `_bg_style` | `str` | `""` (258) | not reset in `on_enter`; `""` in `on_exit` (334) | safe: `_ensure_background` short-circuits on `self._bg is not None and style == self._bg_style` (416), and `_bg` is always `None` after `on_exit` |
| `_launching` | `float` | `0.0` (259) | `0.0` (307) | > 0 ⇒ input dead, countdown to the scene switch |
| `_fonts_bound` | `bool` | `False` (260) | **not reset** — `_bind_fonts` is idempotent by design (291-299) | safe and deliberate: "never retry a broken FontBook per frame" (299) |

`_Card` (204-226, `__slots__` at 207-208):

| Field | Type | Built at | `reset()` (221-226) |
|---|---|---|---|
| `index` | `int` | `_build` | unchanged |
| `level` | `LevelDef` | `get_level(i)` in `_build` (279) | unchanged |
| `button` | `Button` | `Button(home, "", style="tile", data=i)` (276) | `button.rect = home.copy()` |
| `home` | `Rect` | the cell rect (273) | unchanged |
| `delay` | `float` | `(col + row) * INTRO_STAGGER` (278) | unchanged |
| `appear` | `float` | `0.0` | `0.0` |
| `hover_t` | `float` | `0.0` | `0.0` |
| `press_t` | `float` | `0.0` | `0.0` |

`_DiffTile` (229-236): `diff: D.Difficulty`, `button: Button(rect, "", style="ghost", data=diff.key)`.
Both labels are deliberately empty strings so `Button.draw` paints the body art only and the scene
paints its own text over it (274-275, 285).

**Reset audit — three things to carry into the port:**

1. **`_refresh_t` is dead.** Written at 256/309/515 and decremented at 579 (`max(0, _refresh_t -
   dt * 1.6)`), and read **nowhere**. The "difficulty change ripples" effect is carried entirely by
   `_intro_scale` + `card.reset()`. Port it as a comment or drop it; do not invent a use.
2. **`_intro_scale` is one-way within a visit** (514: set to `0.45`, only `on_enter` puts it back
   to `1.0`). Harmless because `card.appear` saturates at 1 and `rise` is then 0, but a *second*
   difficulty change in the same visit also replays at 0.45 — that is the intent.
3. **`Button`'s own animation weights are not reset.** `card.reset()` clears the scene's mirrors
   (`hover_t`, `press_t`) but not `Button._hover_t / _press_t / _armed / _cool / _flash`
   (`snake/gfx/ui.py:436-442`). A card left hovered on exit re-enters with hot *body art* and cold
   *text*, for ~150 ms. **Latent bug, present in Python.** The TS `Button` should grow a
   `reset()` that `onEnter` calls for all 17 buttons; flag it to ui.md rather than working around
   it here.
4. `tile.button.rect = pygame.Rect(tile.button.rect)` (320) is a defensive re-wrap of a rect
   nothing ever moves — a no-op. Do not port it literally; port the `setEnabled(true)` beside it.

---

### 3.4 Construction vs entry

**Once, in `_build()` (266-289), called from `__init__`:**

* 12 `_Card`s — `min(LEVEL_COUNT, COLS * ROWS)` = `min(12, 12)` (269). If `LEVEL_COUNT` ever grew,
  the extra levels would be silently unreachable from this screen; that is the price of "one
  chapter per row" and is a known structural constraint, not a bug to fix here.
* 4 `_DiffTile`s from `D.all_difficulties()` — easy, normal, hard, expert in `ORDER`
  (282; `snake/core/difficulty.py:306`, `web/src/core/difficulty.ts:238`).
* the BACK `Button` (289).

**Once, first `on_enter` (`_bind_fonts`, 291-299):** `self.back.font = game.fonts.get(18, bold=True)`
— an 18 px bold face, because `style="ghost"` would otherwise default to `fonts.body` (21 px),
which does not fit a 148x42 rect (`snake/gfx/ui.py:493-500`).

**Every `on_enter` (304-329), in this order:**

1. `elapsed = 0`, `_launching = 0`, `_diff_hover = None`, `_refresh_t = 0`, `_intro_scale = 1.0` (306-310).
2. `_bind_fonts()` (311).
3. `_diff_key = D.get_difficulty(game.difficulty).key` (313).
4. `_refresh_records()` — 12 × 3 save queries, cached (314, 340-368).
5. Per card: `card.reset()` then `button.set_enabled(record.unlocked)` (316-318).
6. Per diff tile: rect re-wrap (no-op), `set_enabled(True)` (319-321).
7. BACK: `rect = BACK_RECT.copy()`, `set_enabled(True)` (322-324).
8. `focus` (327-328), then `_ensure_background()` (329).

**Every frame:** nothing is allocated except what `Button.draw` and `draw_text` cache internally.
**Never cached by this scene:** any text surface (Python re-renders through `draw_text`'s LRU each
frame). The Pixi port must hold one persistent `Text` per row and re-set `.text` only on change —
the per-frame strings that *do* change are listed in §3.6.

**Background:** `make_background(style, theme, (0, 0, C.WINDOW_W, C.WINDOW_H))` (419), rebuilt only
when `theme.bg_style` of the focused level differs from `_bg_style` (412-423). All 12 themes have
distinct styles (`snake/palette.py:101,110,119,128,137,146,155,164,173,182,191,200`:
grid, nebula, circuit, lava, ocean, static, ice, spores, machine, aurora, voidwarp, prism), so
**every focus change to a different level rebuilds the whole stage.** See §3.16 Q1.

---

### 3.5 The grid — derived geometry, and there is no scrolling

Cell origin (270-273): `x = GRID_LEFT + col * (CARD_W + CARD_GAP_X)`,
`y = GRID_TOP + row * (CARD_H + CARD_GAP_Y)`, with `col = i % 3`, `row = i // 3`.
Pitch is therefore **349 x 120**. Entrance delay (278): `(col + row) * 0.05` — a diagonal wave, not
reading order.

| i | level | col | row | x | y | right | bottom | delay (s) |
|---|---|---|---|---|---|---|---|---|
| 0 | 01 Neon Grid | 0 | 0 | 216 | 100 | 545 | 204 | 0.00 |
| 1 | 02 Deep Nebula | 1 | 0 | 565 | 100 | 894 | 204 | 0.05 |
| 2 | 03 Emerald Circuit | 2 | 0 | 914 | 100 | 1243 | 204 | 0.10 |
| 3 | 04 Solar Flare | 0 | 1 | 216 | 220 | 545 | 324 | 0.05 |
| 4 | 05 Abyssal Tide | 1 | 1 | 565 | 220 | 894 | 324 | 0.10 |
| 5 | 06 Violet Static | 2 | 1 | 914 | 220 | 1243 | 324 | 0.15 |
| 6 | 07 Frozen Vault | 0 | 2 | 216 | 340 | 545 | 444 | 0.10 |
| 7 | 08 Toxic Bloom | 1 | 2 | 565 | 340 | 894 | 444 | 0.15 |
| 8 | 09 Crimson Engine | 2 | 2 | 914 | 340 | 1243 | 444 | 0.20 |
| 9 | 10 Aurora Drift | 0 | 3 | 216 | 460 | 545 | 564 | 0.15 |
| 10 | 11 Event Horizon | 1 | 3 | 565 | 460 | 894 | 564 | 0.20 |
| 11 | 12 Prism Core | 2 | 3 | 914 | 460 | 1243 | 564 | 0.25 |

All cards are `329 x 104`. Grid extents: `216..1243` horizontally (37 px right margin),
`100..564` vertically. Chapter band `36..204`, so there is a 12 px gutter between band and grid,
and a 22 px gutter between the last card row and `DETAIL_RECT.y = 586`.

**There is no scrolling, paging, wrapping or carousel.** All twelve tiles are on screen at once;
`ROWS * COLS == LEVEL_COUNT == 12` by construction (269, and the docstring's whole premise at 4-8).
The only motion in the grid is the per-card entrance of §3.7. Arrow-key focus movement is a
**clamp**, not a wrap (472-477). Do not add a scroll container, a page indicator or an edge-wrap
to the port.

Difficulty row (283-284): tile *i* at `x = 401 + i * 122`, `y = 52`, `112 x 36`.

| tile | key | x | right | centerx | label | colour `diff.color` |
|---|---|---|---|---|---|---|
| 0 | `easy` | 401 | 513 | 457 | `EASY` | `(86, 240, 160)` (`difficulty.py:213`) |
| 1 | `normal` | 523 | 635 | 579 | `NORMAL` | `(96, 202, 255)` (`:236`) |
| 2 | `hard` | 645 | 757 | 701 | `HARD` | `(255, 168, 72)` (`:258`) |
| 3 | `expert` | 767 | 879 | 823 | `EXPERT` | `(255, 84, 132)` (`:280`) |

All four share `y 52..88`, `centery = 70`. `diff.label` is `name.upper()`
(`difficulty.py:188-190`).

---

### 3.6 Layout — the complete coordinate table

Design pixels, 1280x720. `draw_text`'s `pos[1]` is always the **top** edge of the glyph box and
`pos[0]` is the left / centre / right edge per `align` (`snake/gfx/ui.py:268-275`) — so every `y`
below is a top edge, never a baseline and never a centre. Font faces:
`tiny = get(14)`, `small = get(17)`, `body = get(21)`, `h2 = get(30, bold)`,
`display_at(n)` = heavy display face at `n` px (`snake/gfx/fonts.py:63-71, 98-104`).
`theme` unqualified = **the focused level's theme** (`self.theme`, 399-405 =
`get_level(self.focus).theme`, falling back to `P.theme_for_level(0)`). `t = game.time`, unscaled
(653). `pulse(t, k) = 0.5 + 0.5 * sin(t * k)` (`snake/core/contracts.py:214-216`).

#### 3.6.1 Header (`_draw_header`, 678-702)

`total, cap = _star_total()` (377-387); `frac = clamp(total / max(1, cap), 0, 1)` (688);
`right = 1280 - 36 = 1244` (691).

| Element | x | y | size / rect | anchor | font | colour | condition |
|---|---|---|---|---|---|---|---|
| `"SELECT A LEVEL"` | 640 (`1280 * 0.5`) | 10 | — | center | `display_at(30)` | `theme.text` | always |
| `diff.label` | 1244 | 6 | — | right | `tiny` | `diff.color` | always |
| `"{total} / {cap} STARS"` | 1244 | 22 | — | right | `get(19, bold=True)` | `lerp_color(UI_GOLD, UI_WHITE, 0.25 * frac)` | always |
| star bar | 1024 | 48 | `220 x 9` | topleft | — | `draw_bar(rect, frac, UI_GOLD)` — defaults `bg=None` (⇒ `UI_PANEL` track), `border=True` | always |
| trophy star | 1004 | 53 | `r = 9`, filled | centre | vector | `UI_GOLD` if `frac < 1.0` else `rainbow(t * 0.4)`; glow `0.4 + 0.25 * pulse(t, 2.0)` | always |

`cap` is **not** per-difficulty: `save.max_stars()` = `LEVEL_COUNT * MAX_STARS` = 36
(`snake/core/save.py:613-615`; `web/src/core/save.ts:717-719`). `total` **is** per-difficulty
(§3.11). The comment at 699 calls the trophy star "anchored to the end of the bar" but
`right - 240 = 1004` puts it 20 px **left of the bar's left edge**. Numbers win.

#### 3.6.2 One difficulty tile (`_draw_diff_tile`, 704-743)

`r = button.rect`; `selected = diff.key == self._diff_key`; `col = diff.color`;
`hot = selected or button.hovered`.

| Layer | Geometry | Colour / args | Condition |
|---|---|---|---|
| body art | `r` | `button.draw(surface, theme, fonts, t)` — `style="ghost"`, empty label, so no text | always |
| wash | `r`, corner `C.UI_CORNER` = 12 | `_tint(col, alpha=70)` | `selected` |
| border | `r`, width 2, `border_radius=12` | `lerp_color(col, UI_WHITE, 0.35)` | `selected` |
| under-glow | `(r.centerx, r.bottom + 2)` = `(centerx, 90)`, radius 34 | `draw_glow_circle(col, 0.30 + 0.18 * pulse(t, 2.2))` | `selected` |
| label | `(r.centerx, r.centery - font.get_height() * 0.5)` = `(centerx, 70 - h/2)`, center | `get(16, bold=True)`; `text_col = lerp_color(col, UI_WHITE, 0.55 if selected else 0.3 if hovered else 0.0)`, then `shade(text_col, 0.78)` **if not `hot`** | always |
| hairline | `(r.x + 10, r.bottom + 4)` → `(r.right - 10, r.bottom + 4)` = y 92, width 2 | `col` | `selected` |

The label's `y` arithmetic is exact vertical centring: `draw_text` blits a single-line surface whose
height *is* `font.get_height()`, so a Pixi `Text` with `anchor = (0.5, 0.5)` at
`(r.centerx, r.centery)` is pixel-equivalent — use that rather than replicating the subtraction.

#### 3.6.3 Chapter bands (`_draw_chapter_bands`, 746-802)

One per row, for `row in 0..3`; `first = row * 3`; `card = self.cards[first]`;
`appear = clamp(card.appear, 0, 1)`; **skipped entirely when `appear <= 0.01`** (760-761).
`theme` here is **the row's first card's level theme** (766), not the focused theme.
`y = card.button.rect.y` — the *animated* rect, so the band rides up with its row (769).
`band = Rect(36, y, 168, 104)`, `band.right = 204`, `band.bottom = y + 104`.

```
done    = all(_record(i).cleared for i in range(first, first + 3) if i < 12)   # 771-772
perfect = all(_record(i).perfect for i in range(first, first + 3) if i < 12)   # 773-774
accent  = rainbow(t * 0.3 + row * 0.2) if perfect else theme.accent           # 776
```

| Element | x | y | size | anchor | font | colour | condition |
|---|---|---|---|---|---|---|---|
| wash | 36 | `y` | `168 x 104`, corner 12 | topleft | — | `_tint(theme.grid, alpha=int(120 * appear))` | always |
| right rule | 201 (`band.right - 3`) | `y + 6` → `y + 98` | width 3 | vertical line | — | `shade(accent, 0.4 + 0.6 * appear)` | always |
| `"CHAPTER " + chapter.roman` | 50 (`band.x + 14`) | `y + 12` | — | left | `tiny` | `accent` | always |
| `chapter.title.upper()` line *i* | 50 | `y + 32 + i * 20` | wrap width `168 - 28 = 140`, max 2 lines | left | `get(17, bold=True)` | `theme.text` | per wrapped line |
| `"LEVELS {first+1:02d}-{last+1:02d}"` | 50 | `y + 78` (`band.bottom - 26`) | — | left | `tiny` | `shade(theme.text_dim, 0.6 + 0.4 * appear)` | always |
| `"PERFECT"` | 190 (`band.right - 14`) | `y + 78` | — | right | `tiny` | `rainbow(t * 0.3 + row * 0.2)` | `perfect` |
| `"CLEAR"` | 190 | `y + 78` | — | right | `tiny` | `UI_GOOD` = `(86, 240, 160)` | `done and not perfect` |

`chapter = S.get_chapter(first)` (764); the row is skipped on any exception (765). Uppercasing is
applied to the *wrapped* lines, so wrap-then-upper — measuring is done on the mixed-case string
(789-792). The four shipped titles (`web/src/data/story.json`, confirmed by the capture):
`COLD BOOT`, `THE WORKING LAYERS`, `THE DEEP WORKS`, `THE LAST LIGHT`. Only chapter II wraps to
two lines at 140 px.

#### 3.6.4 One unlocked card (`_draw_card`, 805-876)

The card's own theme, not the focused one (806-807). `rec = self._record(card.index)` (809).

```
card.button.draw(surface, theme, fonts, t)        # 813, style="tile", empty label
hov   = clamp(card.hover_t, 0, 1)                 # 816
press = clamp(card.press_t, 0, 1)                 # 817
r     = card.button.rect
cx, cy = r.centerx, r.centery + (-3.0 * hov + 2.0 * press)          # 819
box = Rect(0, 0, r.w, r.h); box.center = (int(cx), int(cy))          # 820-821
```

`box` mirrors `Button.draw`'s hover lift so the scene's text rides with the button's body art.
Because `CARD_W = 329` is odd and pygame's `center` setter uses `w // 2`,
`box.x == r.x` exactly; vertically `box.y = floor(r.y + 52 - 3 * hov + 2 * press) - 52`, i.e.
**up to 3 px up on hover, 2 px down while held** (and the truncation is a floor, positive values
only). All offsets below are from `box`.

```
text_col = lerp_color(theme.text,     UI_WHITE,   0.25 * hov)        # 827
dim_col  = lerp_color(theme.text_dim, theme.text, 0.35 * hov)       # 828
```

| Element | x | y | size | anchor | font | colour | condition |
|---|---|---|---|---|---|---|---|
| perfect rim | — | — | see §3.6.6 | — | — | — | `rec.perfect` (830-831) |
| number glow | `box.x + 38` | `box.y + 32` | radius 34 | centre | — | `draw_glow_circle(theme.accent, 0.25 * hov)` | `hov > 0.02` (836-837) |
| `f"{level.number:02d}"` | `box.x + 14` | `box.y + 8` | — | left | `display_at(32)` | `lerp_color(theme.accent, UI_WHITE, 0.15 + 0.35 * hov)` | always |
| `level.name.upper()` | `box.x + 72` | `box.y + 10` | — | left | `get(19, bold=True)` | `text_col` | always |
| `level.subtitle` | `box.x + 73` | `box.y + 34` | — | left | `tiny` | `dim_col` | always (**+73, not +72** — 845) |
| state tag | — | — | see §3.6.5 | — | — | — | always |
| divider | `box.x + 14` → `box.right - 14` | `box.y + 58` | width 1 | line | — | `shade(theme.grid, 1.4 + 0.6 * hov)` | always |
| star pip *i* ∈ 0..2 | `box.x + 28 + i * 26` | `box.y + 80` | `r = 10` | centre | vector | `got = i < rec.stars`; got → `rainbow(t * 0.35 + i * 0.12)` if `rec.perfect` else `UI_GOLD`; else `shade(theme.text_dim, 0.55)`. Glow `0.35 + 0.3 * hov` if got else `0.0` | always (856-863) |
| `f"{level.goal_food} FOOD"` | `box.x + 118` | `box.y + 72` | — | left | `tiny` | `shade(dim_col, 0.95)` | always |
| `"BEST"` | `box.right - 14` | `box.y + 62` | — | right | `tiny` | `shade(dim_col, 0.8)` | `rec.best > 0` |
| `f"{rec.best:,}"` | `box.right - 14` | `box.y + 76` | — | right | `get(20, bold=True)` | `lerp_color(UI_WHITE, UI_GOLD, 0.35)` | `rec.best > 0` |
| `"UNPLAYED"` | `box.right - 14` | `box.y + 72` | — | right | `tiny` | `shade(dim_col, 0.7)` | `rec.best == 0` |

`{rec.best:,}` is thousands-separated with commas — TS `best.toLocaleString("en-US")` or an explicit
grouping helper; do **not** use the host locale (a German locale would print `1.234`).
`level.goal_food` = `8 + 2 * index` across the shipped table (8, 10 … 30; confirmed in the capture).

Draw order within a card is exactly the table order: body art, rim, glow, number, name, subtitle,
tag, divider, stars, goal, best. Stars are painted **after** the divider and can therefore glow over it.

#### 3.6.5 State tag (`_draw_state_tag`, 878-901)

```
rec.perfect -> label "PERFECT", col rainbow(t * 0.4)     # 883
rec.cleared -> label "CLEARED", col UI_GOOD              # 885
else        -> label "NEW",     col theme.accent2        # 887
w   = fonts.tiny.size(label)[0] + 14    (60 if measuring throws)   # 889-892
tag = Rect(box.right - 14 - w, box.y + 10, w, 17)                  # 893
```

| Layer | Geometry | Colour |
|---|---|---|
| wash | `tag`, corner **6** (not `UI_CORNER`) | `_tint(col, alpha=55)` |
| border | `tag`, width 1, `border_radius=6` | `with_alpha(col, 180)` |
| label | `(tag.centerx, tag.y + 2)`, center, `shadow=False` | `lerp_color(col, UI_WHITE, 0.45)`, `tiny` |

The tag width depends on **measured text**, so the port needs a text-measure call on the 14 px face
(§3.14). `shadow=False` is the only `draw_text` call in this scene that suppresses the drop shadow.

#### 3.6.6 Perfect rim (`_draw_perfect_rim`, 903-922)

```
col  = rainbow(t * 0.3 + index * 0.11)                                   # 907
ring = box.inflate(6, 6)          -> (box.x - 3, box.y - 3, 335, 110)    # 908
draw_glow_circle(box.centerx, box.centery, max(box.w, box.h) * 0.72 = 236.88, col,
                 0.10 + 0.06 * pulse(t, 1.6))                            # 909-911
rect(col, ring, width=2, border_radius=C.UI_CORNER + 8 = 20)             # 912-913
for k in (0, 1):                                                          # 915-920
    ang = t * 1.1 + k * pi + index
    px  = box.centerx + cos(ang) * (box.w * 0.5 + 4 = 168.5)
    py  = box.centery + sin(ang) * (box.h * 0.5 + 4 = 56.0)
    draw_glow_circle(px, py, 12, lerp_color(col, UI_WHITE, 0.5), 0.55)
```

The two sparks trace an **ellipse**, not a circle (168.5 x 56), one at each end of a diameter, at
1.1 rad/s, phase-offset by the card's `index` (radians, deliberately not scaled). Per the
established convention (entities.md §0) y grows downward, so increasing `ang` is clockwise on screen.

#### 3.6.7 Locked card (`_draw_locked`, 924-941) and the padlock (943-961)

Reached from 823-825 — `return`s immediately, so **none** of §3.6.4 is drawn: no name, no subtitle,
no tag, no stars, no divider, no best score. `veil_col = shade(theme.text_dim, 0.55)` (929).

| Element | x | y | size | anchor | font | colour |
|---|---|---|---|---|---|---|
| veil | `box` | `box` | corner `C.UI_CORNER + 6 = 18` | — | — | `_tint(UI_PANEL, alpha=165)` — `UI_PANEL = (16, 19, 34)` |
| `f"{level.number:02d}"` | `box.x + 14` | `box.y + 8` | — | left | `display_at(32)` | `shade(theme.accent, 0.45)` |
| padlock | `box.centerx + 14` | `box.centery - 6` | `size = 16.0` | centre | vector | `veil_col` |
| `"LOCKED"` | `box.centerx + 14` | `box.bottom - 42` | — | center | `get(17, bold=True)` | `veil_col` |
| `f"CLEAR LEVEL {max(1, level.number - 1):02d}"` | `box.centerx + 14` | `box.bottom - 22` | — | center | `tiny` | `shade(veil_col, 0.85)` |

Everything but the number is centred on `box.centerx + 14` = **394 / 743 / 1092** — offset 14 px
right of true centre so the text clears the level number in the top-left corner.

Padlock at `(cx, cy)` with `size = 16.0`:

| Part | Geometry | Stroke |
|---|---|---|
| body | `Rect(0, 0, int(16 * 1.5) = 24, int(16 * 1.15) = 18)` centred on `(int(cx), int(cy + 16 * 0.42))` = `(cx, cy + 6)` | width 2, `border_radius=4` |
| shackle | `Rect(0, 0, int(16 * 0.95) = 15, int(16 * 1.0) = 16)` centred on `(int(cx), int(cy - 16 * 0.28))` = `(cx, cy - 4)` | `arc(rect, 0.0, pi, 2)` |
| left post | `(shackle.left + 1, shackle.centery)` → `(shackle.left + 1, body.top)` | width 2 |
| right post | `(shackle.right - 1, shackle.centery)` → `(shackle.right - 1, body.top)` | width 2 |
| keyhole | `circle((int(cx), body.centery), 2)` | filled |

`pygame.draw.arc` is the one primitive in the codebase using the **mathematical y-up** convention
(entities.md §1.9), so `0 → pi` is the **upper** half-ring on screen. In Pixi draw it as
`arc(cx, shackle.centery, 7.5, pi, 0)` (or `0 → -pi`) — a naive `0 → pi` port draws the shackle
inside the body.

#### 3.6.8 The star pip primitive (`_draw_star` 963-977, `_star_points` 139-147)

```
if glow > 0.01: draw_glow_circle(cx, cy, r * 2.6, color, glow)     # 967-968
pts[i] for i in 0..9:  rad = r if i % 2 == 0 else r * 0.42
                       ang = -pi * 0.5 + i * (pi / 5)
                       (int(cx + cos(ang) * rad), int(cy + sin(ang) * rad))
filled: polygon(color, pts); polygon(lerp_color(color, UI_WHITE, 0.5), pts, 1)
else:   polygon(color, pts, 1)
```

First vertex points straight up; no rotation parameter. Three call sites: card pips
`r = 10.0` (862), header trophy `r = 9.0` (701), detail-panel ladder `r = 8.0` (1020).
**`snake/scenes/gameover.py:153-181` has a near-identical pair with different numbers**
(inner ratio `0.44`, glow `r * 1.9`, outline width `max(1, int(r * 0.10))`, plus a `rot` argument).
A shared TS `starPolygon(cx, cy, r, innerRatio, rot)` is fine; a shared *draw* wrapper is not —
keep this scene's `0.42 / 2.6 / width 1`.

#### 3.6.9 Detail panel (`_draw_detail`, 980-1054)

`level = get_level(self.focus)`, `rec = _record(self.focus)`, `diff = self.diff` (987-989).
`draw_panel(surface, DETAIL_RECT, theme, alpha=224, glow=0.35)` (990) — `border` left at its
default `True`. `DETAIL_RECT = (48, 586, 1184, 98)`, `right = 1232`, `bottom = 684`.
Anchors: `x = 70` (`+22`), `y = 598` (`+12`), `mid_x = 420` (`DETAIL_RECT.x + 372`),
`hint_x = 712` (`DETAIL_RECT.x + 664`), `hint_w = 1232 - 22 - 712 = 498` (1031-1032).

| # | Element | x | y | anchor | font | colour | condition |
|---|---|---|---|---|---|---|---|
| 1 | `"LEVEL {number:02d}   {chapter_title}"` (3 spaces) | 70 | 598 | left | `tiny` | `theme.accent2` | always; `chapter_title = S.get_chapter(focus).title.upper()`, `""` on error (995-1000) |
| 2 | `level.name.upper()` | 70 | 614 | left | `get(26, bold=True)` | `theme.text` | always |
| 3 | `level.subtitle` | 70 | 648 | left | `small` | `theme.text_dim` | always |
| 4 | `"STAR TARGETS - " + diff.label` | 420 | 600 | left | `tiny` | `lerp_color(shade(theme.text_dim, 0.9), diff.color, 0.55)` | always |
| 5 | star pip *i* ∈ 0..2 | `428 + i * 84` (`mid_x + i * 84 + 8`) | 628 (`y + 30`) | centre, `r = 8` | vector | `got = i < rec.stars`; got → `rainbow(t * 0.35 + i * 0.12)` if `rec.perfect` else `UI_GOLD`; else `shade(theme.text_dim, 0.6)`. Glow `0.35` if got else `0.0` | always |
| 6 | `f"{target:,}"` | `442 + i * 84` (`mid_x + i * 84 + 22`) | 621 (`y + 23`) | left | `tiny` | `UI_GOLD` if got else `theme.text_dim` | always |
| 7 | `"BEST {best:,}"` / `"NEVER CLEARED ON " + diff.label` | 420 | 648 | left | `small` | `lerp_color(theme.text_dim, UI_WHITE, 0.4)` | `rec.best` truthy / falsy (1024-1028) |
| 8 | head: `hovered.label` / `"BRIEFING"` / `"LOCKED"` | 712 | 600 | left | `tiny` | `theme.accent2` (all three cases) | always |
| 9 | body line *i* | 712 | `620 + i * 22` (`y + 22 + i * 22`) | left | `get(18)` | see below | wrapped to 498 px, max 2 lines |
| 10 | `"CLICK THE CARD TO PLAY"` | 1210 (`right - 22`) | 662 (`bottom - 22`) | right | `tiny` | `lerp_color(theme.text_dim, theme.accent, 0.55 + 0.45 * pulse(t, 3.0))` | `rec.unlocked` only (1049-1054) |

The right-hand third is a three-way switch (1033-1042), **difficulty hover wins over everything**:

| Condition | head | body | body colour |
|---|---|---|---|
| `self._diff_hover` set | `hovered.label` | `hovered.blurb` | `hovered.color` |
| else `rec.unlocked` | `"BRIEFING"` | `level.hint` | `theme.text` |
| else | `"LOCKED"` | `"Clear level {max(1, number - 1):02d} to open this stage."` | `UI_WARN` = `(255, 196, 72)` |

The four blurbs (`snake/core/difficulty.py:212, 234, 256, 278`; already in
`web/src/data/difficulty.json` via `Difficulty.blurb`):
easy "Drift, coil and never once die to your own tail." / normal "The serpent as intended - fair,
fast, unforgiving of sloppiness." / hard "Faster hazards, thinner mercy, and your own coil bites
back." / expert "One life. No mercy. The grid remembers every mistake."

Star targets (1007-1010): `one, two, three = D.apply_star_targets(diff, level.star_targets())`,
`0, 0, 0` on any exception. This is the **rescaled** ladder for the selected difficulty
(`applyStarTargets`, `web/src/core/difficulty.ts:452`); `level.star_targets()` is
`(par, int(par * 1.35), int(par * 1.75))` (`snake/core/level.py:450-453` → `level.starTargets`,
`web/src/core/level.ts:86`). Note the asymmetry the capture makes obvious: the **pips** come from
the stored star count on this difficulty while the **numbers** come from the rescaled targets —
they are two independent readings and must not be re-derived from each other.

#### 3.6.10 `_wrap` — the exact word-wrap this scene uses (150-182)

Two call sites: chapter titles (`get(17, bold)`, width 140, 2 lines, 789) and the hint/blurb
(`get(18)`, width 498, 2 lines, 1045).

```
words = str(text).split()                       # any whitespace, collapsed
if not words or max_lines < 1: return []
fits(s) = font.size(s)[0] <= width              # on exception: len(s) < 60
lines = []; current = words[0]; index = 1
while index < len(words):
    trial = current + " " + words[index]
    if fits(trial): current = trial; index += 1; continue
    lines.append(current)
    if len(lines) >= max_lines: break           # `current` is DISCARDED here
    current = words[index]; index += 1
else:                                            # loop ran to completion
    lines.append(current)
if index < len(words) and lines:
    lines[-1] = lines[-1].rstrip(" .,") + "..."  # trailing spaces/dots/commas stripped first
return lines[:max_lines]
```

Two behaviours the port must keep: a single word wider than `width` is **never** split (it
overflows its line), and the ellipsis is `"..."`, three ASCII periods, not `…`. Python's
`while/else` is the subtle part — on `break` the in-progress `current` is thrown away and the
already-appended last line takes the ellipsis.

#### 3.6.11 `_tint` — the rounded translucent wash (185-201)

`_tint(surface, rect, color, alpha, corner)`: fill `rect` with
`with_alpha(color, clamp(alpha, 0, 255))` at `border_radius=corner`, composed on an `SRCALPHA`
scratch surface because `pygame.draw` will not alpha-blend onto an opaque canvas. Returns early if
`rect.w < 2 or rect.h < 2`; never raises. Four call sites: selected diff tile `(col, 70, 12)`,
chapter band `(theme.grid, int(120 * appear), 12)`, state tag `(col, 55, 6)`, locked veil
`(UI_PANEL, 165, 18)`. In Pixi this is simply a `Graphics().roundRect(...).fill({color, alpha:
a/255})` — the scratch-surface dance is a pygame workaround with no analogue; do not port it.

---

### 3.7 `update(dt)` — exact order (575-643)

This is a **shell-level menu scene: everything runs on real dt** (integration.md §10). `fx.time_scale()`
is never consulted anywhere in this file. The whole body is inside one `try/except: pass` (576, 636-637).

1. `dt = clamp(dt, 0.0, 0.1)` (577). The shell already clamps to `MAX_DT = 0.05`, so this never
   bites; keep it as cheap insurance.
2. `elapsed += dt` (578).
3. `_refresh_t = max(0, _refresh_t - dt * 1.6)` (579) — dead field, §3.3.
4. `mouse = game.mouse_pos` (580) → `game.pointer.x/.y`.
   `held = bool(game.mouse_buttons.get(1))`, `False` on exception (581-584) → `game.pointer.down`.
5. `k_hover = 1 - exp(-13.0 * dt)`, `k_press = 1 - exp(-22.0 * dt)` (588-589) — **the same
   constants `Button.update` uses internally** (`snake/gfx/ui.py:460-463`), quoted here so the
   scene's text tracks the button's body art. If ui.md changes them, change them here too.
   `scale = max(0.05, _intro_scale)` (590).
6. `hovered_index = -1`; then **per card, in list order** (592-609):
   * `span = max(0.001, INTRO_TIME * scale)` = `0.42 * scale`
   * `card.appear = clamp((elapsed - card.delay * scale) / span, 0, 1)`
   * `rise = (1 - ease_out_cubic(card.appear)) * INTRO_RISE * scale` = `(1 - eoc) * 44 * scale`
   * `card.button.rect = home_offset(card, rise)` = `home.copy()` with `y += int(rise)` (639-643) —
     **`int()`, so the rise is quantised to whole pixels and truncated toward zero.** The animation
     drives the hit box, deliberately (docstring 12-15).
   * `card.button.update(dt, mouse)`; `if just_entered: _play("hover", 0.55)`;
     `if hovered: hovered_index = card.index`
   * `card.hover_t += (target_h - card.hover_t) * k_hover`, `target_h = 1 if hovered else 0`
   * `card.press_t += (target_p - card.press_t) * k_press`, `target_p = 1 if (hovered and held) else 0`
7. `if hovered_index >= 0 and hovered_index != self.focus: focus = hovered_index;
   _ensure_background()` (611-613). **Hover is the navigation, and the focus is sticky:**
   `hovered_index == -1` leaves `focus` alone, so moving off a card keeps its detail panel.
8. `_diff_hover = None`; per diff tile: `update(dt, mouse)`, hover cue on `just_entered`,
   `if hovered: _diff_hover = tile.diff.key` (615-621).
9. `back.update(dt, mouse)` + hover cue (623-626).
10. `_bg.update(dt)` if a background exists (628-629) — real dt.
11. `if _launching > 0: _launching -= dt; if <= 0: _launching = 0; _do_launch()` (631-635).

Easing: `ease_out_cubic(t) = (clamp(t,0,1) - 1)^3 + 1` (`snake/core/contracts.py:193-196` →
`easeOutCubic`, `web/src/core/mathx.ts`). Card *i* is in flight over
`[delay * scale, delay * scale + 0.42 * scale]`; the last card lands at
`0.25 + 0.42 = 0.67 s` on entry and at `0.1125 + 0.189 = 0.3015 s` on a difficulty refresh.
`appear == 0` cards are not drawn at all (663-664) — at `t = 0` only card 0 exists.

Two consequences worth porting knowingly:

* The exponential smoothers are dt-dependent by construction, exactly like the gameplay smoothers
  integration.md §10 warns not to "fix". At a capped 60 fps both ports see the same dt.
* Cards **rise past a stationary pointer** during the entrance, so `Button.just_entered` can fire
  for 1-2 cards at `on_enter` and play unrequested `hover` cues. Present in Python; keep it unless
  the orchestrator says otherwise.

---

### 3.8 `draw()` — layer order (648-675)

One `try/except`, plus a `finally` that restores `surface.get_clip()` (649-651, 671-675). **This
scene never sets a clip**, so the save/restore is vestigial — the Pixi port needs no mask anywhere
on this screen.

| # | Layer | Detail |
|---|---|---|
| 1 | background | `self._bg.draw(surface)` if built, else `surface.fill(theme.bg_bottom)` (655-658). Python builds it for `(0, 0, 1280, 720)` — the **design box** (419) |
| 2 | `_draw_header` | title → 4 difficulty tiles (each: body art, wash, border, under-glow, label, hairline) → `diff.label` → star tally → bar → trophy star (660, 678-702) |
| 3 | `_draw_chapter_bands` | rows 0..3, each skipped while `appear <= 0.01` (661, 746-802) |
| 4 | cards | list order 0..11, `continue` while `card.appear <= 0.0` (662-665). Locked cards take the `_draw_locked` early return |
| 5 | BACK | `self.back.draw(surface, theme, self.game.fonts, t)` (666-667) — **above** the cards, below the panel |
| 6 | `_draw_detail` | panel, then rows 1-10 of §3.6.9 (668) |
| — | cursor + CRT post | drawn by the shell above every scene (integration.md §2.2) |

`t = float(getattr(game, "time", 0.0))` (653) — unscaled wall clock, the only time value any
`draw` here uses. Pixi mapping: six sibling `Container`s under `root` in this order; the card
container holds 12 per-card sub-containers whose `visible` flag is `appear > 0`.

**Overscan:** per the settled convention (background-framework-1-4.md §0 and its Q1) the port may
hand `makeBackground` `viewport.overscan` instead of `(0, 0, 1280, 720)` so the letterbox is
filled. Everything else on this screen stays in the design box. `makeBackground` in TS takes a
fourth argument, the `Renderer` (`web/src/gfx/bg/index.ts:81-86`), and `Background` must be
`dispose()`d when replaced.

---

### 3.9 Input and transitions

`handle_event` (428-447) returns immediately while `_launching > 0.0` — **input is dead during the
launch beat** (430-431). Dispatch order: 4 difficulty tiles → 12 cards → BACK → keyboard
(432-445). Rects do not overlap, so the order only matters for the early `return`.

`Button.handle_event` (`snake/gfx/ui.py:469-490`) is **edge-triggered on release**: `MOUSEBUTTONDOWN`
inside an enabled rect arms it; `MOUSEBUTTONUP` fires exactly once if it is still armed, still
enabled, the release point is inside the rect, and `_cool <= 0` — then `_cool = C.UI_CLICK_COOLDOWN
= 0.1 s`. Dragging off cancels. The only *held* input this scene reads is
`game.mouse_buttons.get(1)` in `update` (582), used solely for `card.press_t`.

Keyboard (`_handle_key`, 449-470) — all **edge-triggered on KEYDOWN**, no repeat handling:

| Keys | Action |
|---|---|
| `ESC`, `BACKSPACE` | `_go_back()` |
| `RETURN`, `KP_ENTER`, `SPACE` | `_choose(card)` for the card whose `index == self.focus` |
| `Q`, `[` | `_set_difficulty(D.prev_difficulty(_diff_key))` — wraps easy → expert |
| `E`, `]`, `TAB` | `_set_difficulty(D.next_difficulty(_diff_key))` — wraps expert → easy |
| `LEFT`, `A` | `_move_focus(-1)` |
| `RIGHT`, `D` | `_move_focus(+1)` |
| `UP`, `W` | `_move_focus(-COLS)` = `-3` |
| `DOWN`, `S` | `_move_focus(+COLS)` = `+3` |

`_move_focus(step)` (472-477): `target = int(clamp(focus + step, 0, len(cards) - 1))`; if it
changed, set `focus`, `_ensure_background()`, `_play("hover", 0.5)`. **No wrap, and no unlocked
check** — LEFT from index 3 lands on index 2 (previous row, last column), and focus can sit on a
locked card. Hover overrides keyboard focus on the next frame it disagrees (611-612).

**Transition table:**

| Trigger | Call | Target | Args | Session state written on the way out |
|---|---|---|---|---|
| Click a difficulty tile / `Q`,`E`,`[`,`]`,`TAB` | `_set_difficulty(key)` (488-522) | — (stays) | — | `game.difficulty = new_key` (504); `game.save.set_difficulty(new_key)` (508) |
| Click BACK / `ESC` / `BACKSPACE` | `_go_back()` → `game.switch_scene(C.SCENE_MENU)` (524-529) | `"menu"` | none | none |
| Click an **unlocked** card / `ENTER`,`SPACE` on an unlocked focus | `_choose(card)` (531-555) then `_do_launch()` after 0.12 s (557-570) | `"game"` | `level_index=index` kwarg, with a `TypeError` fallback to no-kwarg (561-568) | `focus = card.index` (536); `game.mode = C.MODE_FREE` (549); `game.level_index = card.index` (553) |
| Click a locked card | nothing — `Button.enabled` is `False`, `handle_event` returns `False` (317-318, 445-448) | — | — | — |
| `ENTER`/`SPACE` on a **locked** focus | `_choose` guard fails → `_play("hit", 0.5)` and return (533-535) | — | — | — |

`_set_difficulty` short-circuits when the key is unchanged: `_play("click", 0.5)` and return
(498-500). On a real change it plays `click` at full volume, writes `game.difficulty`, persists
through `save.set_difficulty`, re-reads all 12 records, sets `elapsed = 0`,
`_intro_scale = REFRESH_SCALE = 0.45`, `_refresh_t = 1.0`, `card.reset()` + `set_enabled` for every
card, and flashes (501-522). It does **not** touch `game.level_index`, `focus` or `_bg`.

`_choose` sets `_launching = 0.12` — "a beat of dead input before the wipe" (546) — so the burst and
flash are visible for 0.12 s before `switch_scene`. `_do_launch` reads
`int(getattr(game, "level_index", self.focus))`, i.e. the value `_choose` just wrote (559).
Note the scene picks free play unconditionally (`MODE_FREE`, 547-551) and, unlike difficulty,
**does not persist the mode** (no `save.set_mode` call anywhere in this file).

---

### 3.10 Audio cues, fx and particles

`_play(name, volume=1.0)` = `game.audio.play(name, volume)`, swallowing exceptions (479-483).

| Cue | Volume | Trigger | Line |
|---|---|---|---|
| `hover` | 0.55 | any `Button.just_entered` — 12 cards, 4 tiles, BACK | 601-602, 618-619, 625-626 |
| `hover` | 0.5 | `_move_focus` actually changed the focus (keyboard only) | 477 |
| `click` | 0.5 | difficulty tile re-selected (already active) | 499 |
| `click` | 1.0 | difficulty actually changed | 502 |
| `click` | 1.0 | `_go_back()` | 525 |
| `start` | 1.0 | `_choose` on an unlocked card | 537 |
| `hit` | 0.5 | `_choose` rejected (disabled button or locked record) | 534 |

All four names — `hover`, `click`, `start`, `hit` — are in `web/src/data/audio.json` `names`
(lines 5-17). **No missing cues.** The engine exists (`web/src/audio/Audio.ts:318`,
`play(name, volume = 1.0)`), so the signature matches 1:1.

| fx / particles call | Args | Trigger | Line |
|---|---|---|---|
| `game.fx.flash` | `(self.diff.color, 0.18)` — the **new** difficulty's colour | difficulty changed | 520 |
| `game.particles.burst` | `(cx, cy, theme.accent, count=30, speed=(90, 320), life=(0.35, 0.85))` where `cx, cy = card.button.rect.center` (the **animated** rect) and `theme = card.level.theme` | `_choose` accepted | 540-542 |
| `game.fx.flash` | `(theme.accent, 0.35)` — the chosen card's accent | `_choose` accepted | 543 |

No `fx.shake`, no `fx.slowmo`, no `particles.ring/trail/ambient`, no `fx.set_theme` anywhere in this
file. TS shapes: `ScreenFx.flash(color: RGB, amount = 1)`
(`web/src/gfx/post/ScreenFx.ts:332`) — exact match; `ParticleSystem.burst(x, y, color, o)` with
`{count, speed, life}` on `BurstOptions` (`web/src/gfx/particles.ts:773`, `:417-431`) — the Python
kwargs map straight onto the options object, tuples onto `Ranged` pairs.

---

### 3.11 Data dependencies

#### 3.11.1 `SaveData` — the exact predicates

`_refresh_records` (340-368) builds one `_Record` per level `0..LEVEL_COUNT-1`, each field
independently guarded so a broken save degrades instead of crashing:

| Field | Query | Fallback on exception / missing save |
|---|---|---|
| `best` | `save.best_for(i, difficulty=self._diff_key)` (356) | `0` |
| `stars` | `save.stars_for(i, difficulty=self._diff_key)` (360) | `0` |
| `unlocked` | `save.is_unlocked(i)` (364) | `i == 0` (354, 366) |

**Both `best` and `stars` are read per difficulty**, never from the flat tables — that is the whole
reason the switcher re-reads the grid. In `save.py`, `best_for`/`stars_for` with a difficulty name
resolve to `best_by_difficulty[name].get(str(i), 0)` / `stars_by_difficulty[name].get(str(i), 0)`,
and an *unknown* name reads as 0 (`save.py:548-597`). `_diff_key` always comes from
`D.get_difficulty(...)` so it is always a valid key.

Derived predicates (`_Record`, 116-133) — these are the four card states:

| Predicate | Definition | Line |
|---|---|---|
| `unlocked` | `save.is_unlocked(i)` ⇔ `0 <= i < save.unlocked` (`save.py:617-620`; `save.ts:722-725`) | 364 |
| `cleared` | `stars > 0 or best > 0` — **not** `save.completed()` | 117-119 |
| `perfect` | `stars >= 3` | 122-124 |
| `state` | `"locked"` if not unlocked, else `"perfect"` if perfect, else `"cleared"` if cleared, else `"unplayed"` | 127-133 |

Star-count predicates for the pips: pip *i* is filled iff `i < rec.stars`, for `i` in `0..2` (857,
1017) — i.e. **1 star ⇔ `stars == 1`, 2 ⇔ `stars == 2`, 3 ⇔ `stars >= 3`**. The count is whatever
`save.record(...)` stored at the end of a run; this screen never recomputes stars from `best`
against the targets. `MAX_STARS = 3` (`save.py:62`; `save.ts:59`).

Header tally (`_star_total`, 377-387):

```
total = save.total_stars(difficulty=self._diff_key)   # fallback: sum(r.stars for r in _records.values())
cap   = max(1, save.max_stars())                      # fallback: max(1, LEVEL_COUNT * 3) = 36
```

`total_stars(diff)` sums `stars_by_difficulty[diff]` (`save.py:599-611`; `save.ts:703-714`);
`max_stars()` is `LEVEL_COUNT * MAX_STARS = 36` and is **not** per difficulty, so the ratio is
"stars earned on this mode / stars in the whole game".

Written back: `save.set_difficulty(new_key)` (508) — sets the field and the dirty flag only
(`save.py:754-759`; `save.ts:871-877`). **No `flush()`/`save()` call anywhere in this scene**, so
persistence depends on whoever flushes (the shell, on quit). Port that responsibility explicitly:
in a browser there is no reliable quit hook, so the TS scene should call `save.flush()` right after
`setDifficulty` (a `localStorage` write is cheap) — flagged as Q3.

`_highest_unlocked` (389-394): the largest card index with `unlocked`, scanning ascending, default
0 — equivalent to `save.unlocked - 1` clamped to `0..11`, but ported as written.

#### 3.11.2 `levels.json` / `story.json` / `difficulty.json`

| Read | Python | TS | Status |
|---|---|---|---|
| `get_level(i)` | 279, 987 | `getLevel(i)` (`core/level.ts:277`) | ✅ |
| `LEVEL_COUNT` | 269, 351 | `LEVEL_COUNT` = 12 (`core/level.ts:265`) | ✅ |
| `level.number` (1-based) | 838, 933, 939, 999 | `number` (`core/level.ts:63`) | ✅ |
| `level.name / subtitle / hint / theme / goal_food` | 842, 844, 1037, 807, 866 | `name / subtitle / hint / theme / goalFood` | ✅ |
| `level.star_targets()` | 1008 | `level.starTargets` — a **property**, not a method | ✅ (naming shim) |
| `S.get_chapter(i)` | 764, 996 | `getChapter(i)` (`core/story.ts:279`) | ✅ |
| `chapter.roman` | 786 | `chapter.roman()` — a **method** (`core/story.ts:83`, `:106`) | ✅ (naming shim, already noted integration.md §11) |
| `chapter.title / first_index / last_index` | 789, 793-794 | `title / firstIndex / lastIndex` | ✅ |
| `D.all_difficulties()` | 282 | `allDifficulties()` (`core/difficulty.ts:314`) | ✅ |
| `D.get_difficulty(key)` | 313, 410, 498, 1033 | `getDifficulty(key)` (`:258`) | ✅ |
| `D.next_difficulty / prev_difficulty` | 460, 462 | `nextDifficulty / prevDifficulty` (`:304`, `:309`) | ✅ |
| `D.apply_star_targets(diff, targets)` | 1008 | `applyStarTargets(diff, targets)` (`:452`) | ✅ |
| `diff.key / color / blurb` | 434, 716, 1035 | `key / color / blurb` (`:56`, `:62`, `:60`) | ✅ |
| **`diff.label`** | 692, 1012, 1026, 733 | **no field** — `label(diff)` is a free function (`core/difficulty.ts:329`); `Difficulty` has `name` and `hudLabel` but no `label` | ⚠ naming shim: `label(tile.diff)`, *not* `diff.hudLabel` (they coincide for all four shipped rows but are different fields) |
| `P.rainbow / lerp_color / shade / with_alpha` | 700, 695, 731, 896 | `rainbow / lerpColor / shade / withAlpha` (`core/palette.ts:116, 36, 46, 51`) | ✅ |
| `P.UI_GOLD / UI_WHITE / UI_GOOD / UI_WARN / UI_PANEL` | 695, 700, 801, 1042, 931 | same names (`core/palette.ts:281-297`) | ✅ |
| `P.theme_for_level(0)` | 405 | `themeForLevel(0)` (`:261`) | ✅ |
| `theme.text / text_dim / accent / accent2 / grid / bg_bottom / bg_style` | throughout | `text / textDim / accent / accent2 / grid / bgBottom / bgStyle` | ✅ |
| `clamp / ease_out_cubic / pulse` | 197, 597, 702 | `clamp` (`core/mathx.ts:12`), `easeOutCubic` (`:53`), `pulse` (`:74`) | ✅ all three exported |
| `make_background(style, theme, rect)` | 419 | `makeBackground(style, theme, rect, renderer)` — **extra 4th arg**, and `.init()` is already called inside (`gfx/bg/index.ts:81-95`) | ✅ |
| `draw_glow_circle(surface, x, y, r, col, i)` | 724, 836, 909, 919, 968 | `glowSprite(radius, color, intensity)` / `setGlow(sprite, ...)` (`gfx/textures.ts:255`, `:272`). render.md's `stampGlow` is currently **private** to `SnakeRenderer.ts:204` | ⚠ needs a public additive-glow stamp for the menu family (7 call sites here) |

#### 3.11.3 Not yet on `Game` (blocking, not "missing from core")

`web/src/app/Game.ts` exposes `pointer`, `pointerTrail`, `time`, `levelIndex`, `mode`,
`difficulty`, `lastResult`, `particles`, `post.fx`, `viewport`, `switchScene/pushScene/popScene`.
It has **no `save`, no `audio`, no `fonts`**. This scene needs all three:

* `game.save` → wire a `SaveData.load()` instance onto `Game` (the class is fully ported,
  `core/save.ts:411`).
* `game.audio` → wire the ported `Audio` (`web/src/audio/Audio.ts:172`) onto `Game`.
* `game.fonts` → the FontBook (ui.md phase). Faces this scene needs: `tiny (14)`, `small (17)`,
  `get(16 bold)`, `get(17 bold)`, `get(18)`, `get(18 bold)`, `get(19 bold)`, `get(20 bold)`,
  `get(26 bold)`, `display_at(30)`, `display_at(32)`.
* `game.mouse_pos` → `game.pointer.x/.y`; `game.mouse_buttons.get(1)` → `game.pointer.down`.
* Click events: `Button.handle_event` needs press/release *events*, which `InputManager` does not
  dispatch to scenes (integration.md §2.3, Q2). Whatever mechanism ui.md picks must preserve
  arm-on-press / fire-on-release-inside / cancel-on-drag-off / 0.1 s debounce, because
  `_launching`'s dead-input window and the disabled locked cards both lean on it.

---

### 3.12 Card state summary (the four looks, at a glance)

| State | Predicate | Rim | Number | Tag | Stars | Bottom-right | Rest of the card |
|---|---|---|---|---|---|---|---|
| locked | `not unlocked` | none; `UI_PANEL` veil at α165, corner 18 | `shade(accent, 0.45)` | none | none | none | padlock + `LOCKED` + `CLEAR LEVEL NN`, all centred on `box.centerx + 14` |
| unplayed | `unlocked and not cleared` | none | `lerp(accent, white, 0.15+)` | `NEW` in `theme.accent2` | 3 hollow, `shade(text_dim, 0.55)` | `UNPLAYED` | name, subtitle, divider, `NN FOOD` |
| cleared | `stars > 0 or best > 0`, `stars < 3` | none | as above | `CLEARED` in `UI_GOOD` | `stars` gold + rest hollow | `BEST` + `{best:,}` | as above |
| perfect | `stars >= 3` | rainbow ring + ellipse sparks + halo (§3.6.6) | as above | `PERFECT` in `rainbow(t*0.4)` | 3 × `rainbow(t*0.35 + i*0.12)` | `BEST` + `{best:,}` | as above |

`cleared` can be true with `stars == 0` (a finished run that scored below the one-star bar) —
then the tag says `CLEARED`, all three pips are hollow, and `BEST` shows. Do not collapse
`cleared` into `stars > 0`.

---

### 3.13 Capture cross-check — `captures/03-level-select.png`

Read as an image and compared row by row against §3.6. The save in the capture is on **EXPERT**
with `17 / 36` stars and everything unlocked.

Confirmed against the source:

* Title centred at x 640, top ~10-12; `EXPERT` in `(255, 84, 132)` right-aligned at the very top
  right; `17 / 36 STARS` beneath it; gold trophy star at x ≈ 1004 with the 220 px bar starting at
  1024 — i.e. the star really does sit **left** of the bar, as the arithmetic says and the comment
  does not.
* BACK at 216..364 x 48..90; the four tiles at 401 / 523 / 645 / 767, all 112 x 36 at y 52; EXPERT
  is the selected one — tinted fill, brighter 2 px rim, under-glow below its bottom edge and the
  hairline at y 92. The three unselected labels are visibly darkened (`shade(·, 0.78)`).
* 12 cards on the 349 x 120 pitch, 329 x 104 each, exactly at the §3.5 origins; three chapter bands
  visible with `CHAPTER I/II/III/IV`, wrapped titles (`THE WORKING LAYERS` on two lines at
  140 px), `LEVELS 01-03` … `LEVELS 10-12`, and the vertical accent rule at x 201.
* Rows 0 and 1 show `CLEAR` right-aligned in the band (all three cleared, not all perfect); rows 2
  and 3 show nothing (level 09 / 10-12 unplayed) — exactly the `done`/`perfect` predicates.
* Cards 01, 04, 07 carry the perfect rim in three *different* hues (yellow-green, magenta, pink) —
  the `index * 0.11` phase term — and their pips are three different hues each
  (`t * 0.35 + i * 0.12`). Cards 02, 05, 08 (`CLEARED`) use flat `UI_GOLD` pips. Cards 09-12 show
  `NEW` + three hollow pips + `UNPLAYED`.
* `NN FOOD` reads 8, 10, 12 … 30 left-to-right, top-to-bottom, confirming `goal_food = 8 + 2 * index`
  and the `box.x + 118` anchor.
* Detail panel at 48..1232 x 586..684 describing **level 04** with the EXPERT star ladder
  `182 / 246 / 318` (rainbow pips, all earned), `BEST 249`, `BRIEFING` + a two-line wrapped hint,
  and `CLICK THE CARD TO PLAY` bottom-right.
* The whole frame is a lava background (level 04's `bg_style = "lava"`), confirming that the
  backdrop follows the **focused** level and fills the full 1280 x 720.

Two things on screen that are *not* this scene, and one thing that proves a rule:

1. **`60.0 fps` at the top right** — the shell's debug overlay (`main.py`, drawn above every scene
   in `fonts.mono_small`). It partially overlaps the `EXPERT` label, which is why only `EXP…` is
   legible. Not a layout bug.
2. **The soft cyan ring at ≈ (400, 332)** — the shell's `draw_cursor` at the pointer position
   (integration.md §2.2). It sits ~8 px *below* card 04's bottom edge (324) while the detail panel
   still describes level 04: this is the **sticky focus** of §3.7 step 7 caught in the act, and it
   also explains why card 04 shows no hover lift.
3. The darkened top-left corner and the overall vignette are the CRT bezel from the post chain —
   the reason `BACK_RECT` is at (216, 48).

Nothing else on screen is unaccounted for. **Not exercised by this capture:** the locked-card
treatment (§3.6.7) and the `LOCKED` branch of the detail panel — both need a fresh save to verify,
so the port's perceptual check should include one at `unlocked = 1`.

---

### 3.14 Suggested TS home

```
web/src/scenes/LevelSelectScene.ts
  export class LevelSelectScene extends Scene         // root: Container, 6 layer children
  class LevelCard      { index, level, button, home, delay, appear, hoverT, pressT, reset() }
  class DiffTile       { diff, button }
  class LevelRecord    { best, stars, unlocked, get cleared, get perfect, get state }
  const EMPTY_RECORD = new LevelRecord(0, 0, false)
  function tintRect(g: Graphics, rect, color, alpha, corner)   // §3.6.11 - Graphics, not a scratch texture
  function drawPadlock(g: Graphics, cx, cy, size, color)       // §3.6.7 - mind the arc convention
```

Shared, if ui.md wants them (both have a second caller in `gameover.py`, with **different**
numbers — parameterise, do not unify):

```
web/src/gfx/ui/starPip.ts   starPolygon(cx, cy, r, innerRatio = 0.42, rot = 0): number[]
web/src/gfx/ui/wrapText.ts  wrapText(text, measure, width, maxLines = 2): string[]   // §3.6.10 semantics
```

Layer children of `root`, in order: `bgLayer`, `headerLayer`, `bandLayer`, `cardLayer`,
`backLayer`, `detailLayer`. Persistent `Text` objects (re-set `.text` only when the string changes):
15 in the header/detail block, 4 x (up to 4) in the bands, 7 per card = ~100 total — all created in
the constructor, not in `onEnter`. The per-frame *changing* strings are only: the star tally
(on a difficulty change), every band and card string (on a difficulty change), and the detail
panel's ten rows (on a focus change or a difficulty-hover change). Colours and glow intensities
animate every frame; strings do not animate at all.

---

### 3.15 Invariants worth asserting

1. `cards[i].home` equals the §3.5 table for all 12 — a cheap table-driven test that catches a
   mis-transcribed pitch.
2. `onEnter` leaves `elapsed == 0`, every `appear == 0`, every `hoverT == pressT == 0`, and every
   card `button.rect` equal to its `home` — the reused-instance rule.
3. `card.button.enabled === record(card.index).unlocked` after `onEnter` **and** after every
   `setDifficulty` (317-318, 517-518). A card that is enabled while locked is a free-level exploit.
4. `_choose` is unreachable for a locked card by pointer, and by keyboard produces exactly one
   `hit` cue and no scene change.
5. `focus` is always in `0..11` (both `onEnter`'s fallback and `_move_focus`'s clamp guarantee it),
   so `getLevel(focus)` never needs its own guard.
6. Real dt only: driving `update` with a fake `timeScale()` of 0.05 must not change the entrance
   timing (integration.md §10).
7. `_ensure_background` is a no-op when the focused level's `bgStyle` is unchanged — assert the
   constructor count over a hover sweep across cards sharing a style (none do today, but a retheme
   could).
8. Exactly one `switchScene` per user action: the 0.12 s `_launching` window must not allow a
   second `_choose` (it is guarded at 430-431).

### 3.16 Open questions

* **Q1 — background churn.** Every focus change (hover *or* arrow key) rebuilds a full
  pre-rendered stage, because all 12 themes have distinct `bg_style`s. Python gets away with it
  (surface blits, one rebuild per hover); Pixi is re-rendering canvases and uploading textures, and
  a pointer sweeping across the grid triggers up to 12 rebuilds in a second. Proposal: keep the
  *behaviour* (the focused level's stage is what shows) but hold a small LRU of live `Background`
  instances (2-3) keyed by style, disposing the rest, and rebuild lazily. Needs a decision because
  it changes memory profile, not pixels.
* **Q2 — overscan.** Does this scene pass `viewport.overscan` or `(0, 0, 1280, 720)` to
  `makeBackground`? background-framework-1-4.md §9 Q1 leaves it open for the whole menu family;
  answer it once, for all of them, and hook `onResize` if the answer is overscan.
* **Q3 — persistence.** `set_difficulty` marks the save dirty but nothing flushes here. In a
  browser there is no reliable exit hook; recommend `save.flush()` immediately after
  `setDifficulty` (and note that `Game` has no `save` instance yet at all).
* **Q4 — `Button` reset.** §3.3 note 3: the Button's internal hover/press weights survive a scene
  exit. Should ui.md's `Button` grow `reset()` (and this `onEnter` call it for all 17), fixing a
  latent Python bug, or should the port reproduce the flicker? Recommend fixing.
* **Q5 — entrance hover cues.** Cards rising past a stationary pointer fire `hover` on
  `just_entered` during the fly-in. Keep (parity) or suppress while `appear < 1`? Recommend keeping.
## 4. The pause overlay - `PauseScene`

**Ground truth:** `E:/SnakeGame/snake/scenes/pause.py`, lines 1-421 (the whole file).
**Reference capture:** `E:/SnakeGame/captures/09-pause.png` (level index 5, "Violet Static").
**Suggested TS home:** `web/src/scenes/PauseScene.ts`, `class PauseScene extends Scene`.

This is the only `transparent` scene in the game. Section 4.2 is the part that has no Python
analogue in the port (retained-mode Pixi instead of an immediate-mode surface), so read it
before the layout tables.

The UI kit call sites recorded here (`draw_panel`, `draw_text`, `Button`) are specified in
`docs/port/ui.md`; this section records only *what the scene asks for*.

### 4.1 Identity

| Property | Value | Source |
|---|---|---|
| Python class | `PauseScene(Scene)` | pause.py:54 |
| File / lines | `snake/scenes/pause.py`, 1-421 | |
| Registry key | `C.SCENE_PAUSE = "pause"` -> `("pause", "PauseScene")` | config.py:194, main.py:37 |
| TS registry key | `SCENES.PAUSE = "pause"` | `web/src/app/Scene.ts:70` |
| `transparent` | `True` - the scene below is still drawn | pause.py:57 |
| `blocks_update` | `True` - the scene below does not advance | pause.py:58 |
| Pushed by | `GameplayScene._pause()` -> `game.push_scene(C.SCENE_PAUSE)`, **no kwargs** | gameplay.py:523-531 |
| Pushed on | HUD pause button `PAUSE_RECT = (886, 32, 70, 38)` click, or `Esc` / `P` keydown | gameplay.py:506-513 |
| Pushes | `C.SCENE_SETTINGS` with `back=C.SCENE_PAUSE` (a *push*, stack depth 3) | pause.py:238 |
| Switches to | `C.SCENE_GAME` (restart), `C.SCENE_LEVELS`, `C.SCENE_MENU` | pause.py:203-224 |
| Pops itself | on RESUME | pause.py:191 |

It is never pushed from anywhere except gameplay; the whole file has exactly one entry point.

`level_index` / `level_name` kwargs exist (pause.py:79-80) but **no call site passes them** -
both resolve from `game.level_index`. Keep the kwargs in the port for the same reason Python has
them (a future "pause the preview" caller), but the live path is the zero-arg one.

### 4.2 What `transparent` + `blocks_update` mean in this port

Python (`main.py` draw walk, integration.md 2.2 step 6) redraws the gameplay scene every frame
while paused; pygame is immediate-mode, so "still drawn" costs a full repaint of a *stale
simulation*. Pixi is retained-mode, so the equivalent is simpler and cheaper: the gameplay
scene's `root` stays parented and `visible` (`Game.step` only hides scenes below the lowest
opaque one - `PauseScene.transparent === true` keeps gameplay's root visible, Game.ts:248-252),
and because `PauseScene.blocksUpdate === true` the loop `break`s before `GameplayScene.update`
(Game.ts:240-244), so its display objects are never re-synced. The frozen frame is therefore
free: no snapshot, no repaint.

**What is genuinely frozen while paused** (advanced only inside `GameplayScene.update`):
`clock_t`, `hazard_t`, `elapsed`, the snake, food/rune fields, hazard phases, popups,
`ready_timer` / `go_timer` (integration.md Q4 - the countdown effectively stops), the HUD, and
the gameplay pause button's hover animation.

**What keeps moving underneath** (shell-level, real dt, integration.md 2.2 steps 4-5):

| Subsystem | Python | TS | Consequence while paused |
|---|---|---|---|
| `particles.update(dt)` | runs after the scene walk (main.py) and the sparks are *drawn* by gameplay layer 7 | `Game.step` -> `this.particles.update(dt)` (Game.ts:262), and the particle layer is borrowed into `GameplayScene.arenaLayer` | sparks keep flying under the veil in **both** ports. `ParticleSystem.update` syncs its display objects (particles.ts:1280-1287), so this is automatic - do not "fix" it |
| `fx.update(dt)` / `post.update(dt)` | real dt | `this.post.update(dt)` (Game.ts:263) | a slow-mo, shake or flash **expires while paused**. `CROSS_TEACH_SLOWMO` (0.55, 0.24 s) started a frame before pausing is simply gone on resume. Matches Python; keep |
| `game.time` | `+= dt` always | `this.time += dt` (Game.ts:232) | the pause panel's own clock is separate (`self.t`), but any consumer of `game.time` keeps running |
| HUD odometer / gameplay pause button | animate from `game.time` at *draw* time, so they keep animating in Python | frozen in TS (repaint happens in `update`) | **accepted divergence**, invisible after 0.34 s because the veil is opaque by then. Note it in the HUD port (task 3) rather than working around it here |

**Real-dt rule.** `PauseScene.update(dt)` is the top of the stack and receives the shell's real
dt directly. `fx.time_scale()` never touches it - the overlay is not a simulation consumer, and
there is no `sdt` anywhere in pause.py. Assert it: with `timeScale()` pinned at 0.05 the panel
must still fly in over 0.34 s (integration.md 10, invariant 7).

#### 4.2.1 The dimming veil, and the blur that has to be reinterpreted

Python paints two full-screen layers before the panel (pause.py:338-345):

| Layer | Python expression | Value at `fade = 1` (theme 5) |
|---|---|---|
| Blurred snapshot | `self._blur.set_alpha(int(255 * clamp(fade, 0, 1)))`, blitted at `(0, 0)` | opaque 1280x720 copy of the frozen frame |
| Scrim | `pygame.Surface(surface.get_size(), SRCALPHA)` filled with `P.with_alpha(P.shade(theme.bg_bottom, 0.55), int(168 * fade))` | `rgba(4, 1, 8, 168)` (`bg_bottom = (8, 2, 16)`) |

where `fade = ease_out_cubic(self.intro)`.

The snapshot is produced once in `on_enter` by `_snapshot_blur` (pause.py:111-132): take
`game.canvas`, `smoothscale` to `(max(2, 1280 // 7), max(2, 720 // 7)) = (182, 102)`, then
`smoothscale` back to `(1280, 720)`. `_BLUR_DOWNSCALE = 7` (pause.py:42). The result is
`convert()`ed (no alpha channel) so `set_alpha` is a uniform surface alpha.

Since the blurred copy is drawn *over* the still-live frame at `alpha = 255 * fade`, the first
0.34 s is a cross-fade from the sharp (and, per the table above, still-twitching) frame into a
frozen blurred still. After `intro` saturates, the snapshot is opaque and the live frame is
completely hidden.

Two admissible ports, in order of preference:

1. **Literal, and cheap.** In `onEnter`, `renderer.generateTexture({ target: game.post.scene,
   resolution: 1 / 7 })` into a `Sprite` scaled x7 with linear filtering, `sprite.alpha =
   easeOutCubic(intro)`, destroyed in `onExit`. This *is* the Python operation (area-average
   down, bilinear up), one render-texture pass paid on entry only.
2. **Filter.** A `BlurFilter` on the gameplay root. The Python kernel is a 7 px box average
   followed by a 7 px bilinear spread, i.e. sigma = `sqrt((7^2 - 1)/12 + ~2)` ~= 2.4-2.8 design
   px. If you take this route, animate the filter's strength from 0 to ~2.6 on `easeOutCubic`
   and remove the filter in `onExit`. It is *not* equivalent for the particles: a filter blurs
   them live, the snapshot freezes them.

Do not blur per frame with a fresh snapshot: pause.py's docstring (lines 8-13) is explicit that
the frame behind never changes while paused, and the whole design pays the cost once.

**Overscan decision (open question, flagged).** Python's snapshot and scrim are exactly
1280x720 because pygame has no overscan - the letterbox is hard black. In the port,
`background` fills `viewport.overscan`, so a design-box-sized veil leaves an unveiled, full
brightness band of level background either side of the panel on a wide screen.
**Recommendation:** size the scrim to `game.viewport.overscan` (rebuilt in `onResize`) and keep
the snapshot sprite at the design box, since `post.scene` only contains design-space content
scaled by the world root. Confirm against a 21:9 screenshot.

### 4.3 Owned state

Every attribute of `PauseScene`. "Reset in `on_enter`" is the column that matters: instances are
cached (`Game._make_scene` / `Game.makeScene`) and reused.

| Attribute | Type | `__init__` value | `on_enter` (pause.py:74-82) | Note |
|---|---|---|---|---|
| `t` | float | `0.0` | `0.0` | local animation clock, real dt |
| `intro` | float | `0.0` | `0.0` | 0..1 fly-in weight |
| `level_index` | int | `0` | `_resolve_level_index(kwargs["level_index"])` | `max(0, int(game.level_index))`, `0` on any exception |
| `level_name` | str | `""` | `_resolve_level_name(kwargs["level_name"])` | `get_level(idx).name`, else `theme_for_level(idx).name`, else `""` |
| `buttons` | `List[Button]` | `[]` | `_build_buttons()` rebuilds all six | rects depend on nothing but constants; rebuilt anyway |
| `_base_y` | `Dict[int, int]` | `{}` | rebuilt by `_build_buttons` | `id(button) -> resting centery`; in TS store the resting y **on the button view** or in a parallel array - `id()` has no equivalent and a `Map<Button, number>` is the direct translation |
| `_blur` | `Optional[Surface]` | `None` | `_snapshot_blur()` | dropped in `on_exit` (pause.py:87) because it is invalid the moment the frame behind changes |
| `_closing` | bool | `False` | `False` | double-activation guard; also reset in `on_exit` and on an exception inside `_activate` |

**Nothing is built in `__init__` and left unreset.** `on_enter` rebuilds every field including
the button list, so the "#1 bug source" is closed by construction here. The two subtleties to
carry over:

* `_closing` must be reset in **both** `onEnter` and `onExit`. Only `onExit` runs on the
  `switch_scene` paths, and only `onEnter` runs on a fresh push; the belt-and-braces is
  deliberate (a `switch_scene` that throws must not leave the cached instance dead).
* `_open_settings` deliberately does **not** set `_closing` (pause.py:226-241): the overlay
  survives the detour, and arming the guard would leave every button inert when settings pops
  back.

### 4.4 Construction versus entry

| Built | Where | Why |
|---|---|---|
| nothing but zeroed fields | `__init__` (pause.py:60-70) | no fonts, no surfaces, no buttons |
| six `Button`s + their resting `centery` | `on_enter` -> `_build_buttons` (pause.py:142-163) | the SOUND label depends on live mute state |
| blurred snapshot | `on_enter` -> `_snapshot_blur` | one full-screen pair of scales, on entry only |
| theme | *not stored* - `self._theme()` recomputes `P.theme_for_level(self.level_index)` per draw | pure function of `level_index`; in TS cache it in `onEnter` (`themeForLevel`) since Pixi styles want stable objects |

TS: build the six button views, the panel, the title/caption `Text` objects and the divider
sprite **once in the constructor**; `onEnter` re-labels SOUND, retargets the caption strings,
and resets `t` / `intro` / `_closing`. Text objects are persistent and re-rendered only when
their string changes (`LEVEL 06`, the level name and `SOUND: ON|OFF` are the only three strings
that ever change).

### 4.5 Layout (design pixels, 1280x720)

Panel geometry constants (pause.py:31-45):

| Constant | Value | In config.json? |
|---|---|---|
| `_PANEL_W` | `470` | no - scene-local |
| `_PANEL_H` | `646` | no - scene-local. Comment (pause.py:32-36): 168 px title block + six 54 px buttons on an 11 px pitch (379 px) + 76 px reminder + padding |
| `_BTN_W` | `C.UI_BUTTON_W = 300` | **yes** - `C.UI_BUTTON_W` (config.ts:143) |
| `_BTN_H` | `54` | no - scene-local. Note this is **not** `C.UI_BUTTON_H` (58) |
| `_BTN_GAP` | `11` | no |
| `_BLUR_DOWNSCALE` | `7` | no |
| `_INTRO_TIME` | `0.34` s | no |
| corner radius | `C.UI_CORNER = 12` (inside `draw_panel`) | yes (config.ts:142) |

`_panel_rect()` (pause.py:137-140): `Rect(0, 0, 470, 646)` with `center = (1280 // 2, 720 // 2)`
= `(640, 360)`, so the resting rect is **`(405, 37, 470, 646)`**: `centerx = 640`,
`right = 875`, `bottom = 683`. The draw applies `panel.y += offset` (4.6), so every `panel.y`
below is `37 + offset`.

Every element, at rest (`intro = 1`, `offset = 0`, `fade = 1`):

| # | Element | x | y | size | anchor | font | colour expression | drawn when |
|---|---|---|---|---|---|---|---|---|
| 1 | blurred snapshot | 0 | 0 | 1280x720 | top-left | - | frozen frame, `alpha = int(255 * fade)` | `_blur is not None` |
| 2 | scrim | 0 | 0 | surface size | top-left | - | `with_alpha(shade(theme.bg_bottom, 0.55), int(168 * fade))` | always |
| 3 | panel | 405 | 37 | 470x646 | top-left | - | `draw_panel(surface, panel, theme, alpha=int(232*fade), glow=0.45 + 0.25*pulse(t, 1.8))` (`border` defaults `True`) | always |
| 4 | `"PAUSED"` | 640 | `panel.y + 30` = 67 | display@74 | centre / top | `fonts.display_at(74)` | `lerp_color(theme.accent, UI_WHITE, 0.25 + 0.35*breathe)`, `breathe = 0.6 + 0.4*pulse(t, 2.2)` -> factor 0.46..0.60 | always |
| 5 | divider | `640 - line_w // 2` = 465 | `panel.y + 118` = 155 | `line_w x 2`, `line_w = int((470 - 120) * fade)` = 350 | top-left | - | per-column: `with_alpha(lerp_color(accent, accent2, f), int(200 * (1 - abs(f - 0.5)*2) ** 0.6))`, `f = x / max(1, line_w - 1)` | `line_w > 4` |
| 6 | `"LEVEL {level_index + 1:02d}"` | 640 | `panel.y + 94` = 131 | tiny (14) | centre / top | `fonts.tiny` | `theme.text_dim` | always |
| 7 | level caption | 640 | `panel.y + 128` = 165 | body (**21**) | centre / top | `fonts.body` | `lerp_color(theme.text, theme.accent2, 0.35)` | always; text = `level_name.upper()` or `"IN PLAY"` if empty |
| 8 | button 0 RESUME | 490 | 205 | 300x54 | rect | `Button` style `primary` -> `fonts.h2` bold 30 | ui.md | always |
| 9 | button 1 RESTART LEVEL | 490 | 270 | 300x54 | rect | style `ghost` -> `fonts.body` 21 | ui.md | always |
| 10 | button 2 `SOUND:  ON` / `SOUND:  OFF` | 490 | 335 | 300x54 | rect | `ghost` | ui.md | always |
| 11 | button 3 SETTINGS | 490 | 400 | 300x54 | rect | `ghost` | ui.md | always |
| 12 | button 4 LEVEL SELECT | 490 | 465 | 300x54 | rect | `ghost` | ui.md | always |
| 13 | button 5 QUIT TO MENU | 490 | 530 | 300x54 | rect | style `danger` | ui.md | always |
| 14 | hint 0 `"MOVE   steer with the mouse"` | 640 | `panel.bottom - 76` = 607 | tiny (14) | centre / top | `fonts.tiny` | `shade(theme.text_dim, 0.95)` | always |
| 15 | hint 1 `"BOOST  hold the right mouse button"` | 640 | 626 | tiny (14) | centre / top | `fonts.tiny` | `shade(theme.text_dim, 0.83)` | always |
| 16 | hint 2 `"PAUSE  Esc or P"` | 640 | 645 | tiny (14) | centre / top | `fonts.tiny` | `shade(theme.text_dim, 0.71)` | always |

Notes that will otherwise cost pixels:

* `draw_text`'s `pos[1]` is always the **top** edge, `pos[0]` the left/centre/right edge per
  `align` (ui.py:268-291). Row 4 is therefore *not* vertically centred on y=67.
* **Font sizes.** `PauseScene._font(fonts, name, size)` (pause.py:411-421) returns
  `fonts.display_at(size)` for `"display"`, else `getattr(fonts, name)` **if it is a Font** and
  only otherwise `fonts.get(size)`. So `_font(fonts, "body", 22)` yields `fonts.body` = **21
  px**, and the `22` is dead. Same for `("tiny", 14)` -> 14 px (identical by luck).
  `display_at(74)` is a size the FontBook does not preset (huge 96 / title 64 / h1 42), so
  ui.md's font facility must expose an arbitrary `displayAt(size)`.
* Button rows: `top = panel.y + 168 = 205`; `centery = top + i*(54 + 11) + 54//2 = 232 + 65i`
  -> 232, 297, 362, 427, 492, 557; `x = centerx - 300//2 = 490`. Table lists rect tops
  (`centery - 27`).
* Hints: three lines on a 19 px pitch starting 23 px below the last button's bottom (584).
* The literal strings contain **runs of spaces** (`"MOVE   steer..."` = 3 spaces,
  `"BOOST  ..."` / `"PAUSE  ..."` = 2, `"SOUND:  ON"` = 2). Pixi `Text` preserves them; any
  HTML-based text path would collapse them and lose the column alignment.
* Divider: the gradient is normalised to the *current* `line_w` (`f = x / (line_w - 1)`), so it
  **stretches** with the reveal rather than being clipped. Port as one 350x2 gradient texture
  baked once, drawn with `sprite.width = line_w` - bilinear stretch reproduces it exactly.
  Alpha is baked into the texture; the blit is normal alpha, **not** additive.

### 4.6 `update(dt)` - exact order

`PauseScene.update` (pause.py:290-314), all on **real dt**:

1. `dt = clamp(dt, 0.0, C.MAX_DT)` (`MAX_DT = 0.05`). The shell already clamped; the scene
   clamps again.
2. `self.t += dt`.
3. If `intro < 1`: `intro = clamp(intro + dt / 0.34, 0, 1)`. Linear in time; the easing is
   applied at read time, not here.
4. `offset = int(round((1.0 - ease_out_back(intro)) * 46.0))`.
5. `self._sync_sound_label()` - re-reads `game.audio.muted` into button 2's label **every
   frame**, because the stacked settings scene can flip mute while pause is buried (pause.py:301-304).
6. `mouse = game.mouse_pos` -> TS `game.pointer`.
7. For each button, in list order: `btn.rect.centery = _base_y[id(btn)] + offset`, then
   `was_hovered = btn.hovered`, `btn.update(dt, mouse)`, and if `btn.hovered and not
   was_hovered` -> `audio.play("hover")`. The hit rect is moved **before** the hover test, so
   the hit rect and the drawn rect always agree during the fly-in.
8. The whole body is inside `try/except: pass`.

Easing / timing summary:

| Quantity | Formula | Range / timing |
|---|---|---|
| `intro` | `+= dt / 0.34`, clamped 0..1 | saturates 0.34 s after entry |
| `fade` | `ease_out_cubic(intro)` = `1 + (intro - 1)^3` | drives blur alpha, scrim alpha, panel alpha, divider width |
| `offset` | `round((1 - ease_out_back(intro)) * 46)`, `ease_out_back(t) = 1 + 2.70158 f^3 + 1.70158 f^2`, `f = t - 1` | `+46` px at entry -> peak overshoot `ease_out_back = 1.0999` at `intro = 0.5801` (t = 0.197 s) giving `offset = -5` px -> settles at `0` |
| panel glow | `0.45 + 0.25 * pulse(t, 1.8)` | 0.45..0.70, period `2*pi/1.8` = 3.49 s |
| title breathe | `0.6 + 0.4 * pulse(t, 2.2)` | colour lerp factor 0.46..0.60, period 2.86 s |
| button hover / press | `Button.update`: `k = 1 - exp(-13 dt)` hover, `1 - exp(-22 dt)` press, `_flash -= dt*3.2`, `_cool -= dt` | ui.md owns it; note `Button.update` re-clamps dt to 0.1 |

`pulse(t, s) = 0.5 + 0.5*sin(t*s)` (contracts.py:214) -> `pulse` in `core/mathx.ts`.

### 4.7 `draw()` - layer order

`draw` (pause.py:319-331) saves `surface.get_clip()`, sets clip to `None` (the overlay is
explicitly **unclipped** - it paints over the HUD strip and outside the arena), calls
`_draw_impl`, and restores the clip in a `finally`. In Pixi there is no ambient clip to fight:
just do not put a mask on the pause root.

`_draw_impl` order (pause.py:333-400), top of list = painted first:

| # | Layer | Extent |
|---|---|---|
| 1 | blurred frozen frame | design box (port: extend the scrim, not the snapshot, to overscan - 4.2.1) |
| 2 | scrim | `surface.get_size()` = design box in Python; overscan recommended in the port |
| 3 | `draw_panel` | 470x646 at `(405, 37 + offset)` |
| 4 | `"PAUSED"` | |
| 5 | divider gradient bar | |
| 6 | `"LEVEL nn"` | painted *after* the divider even though it sits above it - no overlap, order is immaterial |
| 7 | level caption | |
| 8 | the six buttons, in list order (`btn.draw(surface, theme, fonts, self.t)`) | note the time argument is the scene clock `self.t`, **not** `game.time` (unlike the gameplay pause button) |
| 9 | three hint lines | |

The shell then draws the custom cursor and the post chain over the top (integration.md 2.2).

### 4.8 Input and transitions

`handle_event` (pause.py:268-285): buttons first (`for btn in self.buttons: if
btn.handle_event(event): activate; return`), then `KEYDOWN`.

| Binding | Edge / held | Action key |
|---|---|---|
| left click completing inside a button | edge (press **and** release inside, `Button.handle_event` ui.py:469-490, debounced by `C.UI_CLICK_COOLDOWN = 0.10`) | that button's `data` |
| `Esc`, `P`, `Space` | edge (KEYDOWN) | `resume` |
| `R` | edge | `restart` |
| `M` | edge | `sound` |
| `S`, `O` | edge | `settings` |
| mouse motion | continuous, via `Button.update(dt, mouse_pos)` and `MOUSEMOTION` in `handle_event` | hover only |

Nothing is held; there is no boost/steer input in this scene.

`_activate(key)` guard (pause.py:183-186): `if self._closing and key != "sound": return`. So
after any closing action, only SOUND still responds. On an exception anywhere in `_activate`,
`_closing` is reset to `False` (pause.py:208-210) - the overlay must never brick itself.

Transition table:

| Trigger | Guard sets | Audio | Verb | Target | Args | `game.*` written | Effect on the gameplay scene |
|---|---|---|---|---|---|---|---|
| RESUME / `Esc` / `P` / `Space` | `_closing = True` | `click` | `pop_scene()` | (reveals `game`) | - | none | untouched; resumes updating next frame from exactly the state it froze in. No catch-up (dt is clamped, integration.md 10) |
| RESTART LEVEL / `R` | `_closing = True` | `start` | `switch_scene` | `C.SCENE_GAME` | `level_index=idx` (falls back to a bare switch on `TypeError`) | `game.level_index = idx` **before** the switch | gameplay `on_exit` then a full `on_enter`: new sim, particles cleared, score reset. `switch_scene` pops **both** scenes |
| SOUND / `M` | - (explicitly allowed while `_closing`) | `click` **only when unmuting** | none | - | - | `save.set_muted(muted)` + `save.save()` | none |
| SETTINGS / `S` / `O` | *not* set | `click` | `push_scene` | `C.SCENE_SETTINGS` | `back=C.SCENE_PAUSE` (bare push on `TypeError`) | none | still frozen, now under two overlays. Settings pops itself when the stack is deeper than one |
| LEVEL SELECT | `_closing = True` | `click` | `switch_scene` | `C.SCENE_LEVELS` | - | none | popped and exited; run is lost |
| QUIT TO MENU | `_closing = True` | `click` | `switch_scene` | `C.SCENE_MENU` | - | none | popped and exited; run is lost |

`mode`, `difficulty` and `last_result` are never written by this scene.

**Two port bugs this table exposes, both in code that already exists:**

* **`Game.popScene` never unparents the popped root.** `pushScene` adds to `this.post.scene`
  (Game.ts:203) but `popScene` calls `this.world.removeChild(s.root)` (Game.ts:212). Pixi's
  `removeChild` is a no-op when the child's parent is someone else, so RESUME would leave the
  pause overlay painted on top of a resumed game forever (and out of `stack`, so the
  visibility pass no longer touches it). Fix: `this.post.scene.removeChild(s.root)`.
* **Restart arg name.** Python passes `level_index=idx`; the ported `GameplayScene.onEnter`
  reads `args["level"]` (GameplayScene.ts:121-123). Either rename the arg here or teach
  `GameplayScene` to accept `levelIndex`. Setting `game.levelIndex` first (as Python does)
  makes the mismatch survivable but silently ignores an explicit arg.

### 4.9 Audio cues, fx and particles

| Call | Arguments | Trigger | In `web/src/data/audio.json`? |
|---|---|---|---|
| `game.audio.play("click")` | - | RESUME, LEVEL SELECT, QUIT TO MENU, SETTINGS, and SOUND when the toggle *unmutes* | yes (`names[5]`) |
| `game.audio.play("start")` | - | RESTART LEVEL | yes (`names[7]`) |
| `game.audio.play("hover")` | - | any button's hover rising edge, once per edge | yes (`names[6]`) |
| `game.audio.toggle_mute()` | - | SOUND | n/a (engine call; `Audio.toggleMute()` exists, Audio.ts:377) |

**No `fx.*` and no `particles.*` calls at all.** `PauseScene` never flashes, shakes, slows time
or emits a particle - the entry animation is the panel fly-in and nothing else. The
`fx.begin_transition()` on the way out belongs to `switch_scene`, not to this scene
(integration.md 2.4); `pop_scene` deliberately has no transition.

Cue-name cross-check against `audio.json.names`
(`eat, bonus, powerup, hit, die, click, hover, start, levelup, win, boost, portal`): every name
this scene uses is present. No unknown cues.

Note the cue that is *not* here: the `click` played when the overlay **opens** belongs to
`GameplayScene._pause()` (gameplay.py:523-527), so a port that moves pausing into a shared
input handler must keep that cue on the gameplay side or it will double-play.

### 4.10 Data dependencies

| Reads | From | TS equivalent | Status |
|---|---|---|---|
| `game.level_index` | shell | `game.levelIndex` | present (Game.ts:81) |
| `get_level(idx).name` | `levels.json` via `core/level.py` | `getLevel(i).name` (`core/level.ts`) | present |
| `theme_for_level(idx)` (+ `.name` fallback) | `themes.json` | `themeForLevel(i)` (`core/palette.ts:261`) | present. The fallback is invisible in practice: level names and theme names are identical for every shipped index (both `[Neon Grid, Deep Nebula, Emerald Circuit, Solar Flare, Abyssal Tide, Violet Static, Frozen Vault, Toxic Bloom, ...]`) |
| `theme.accent / accent2 / text / text_dim / bg_bottom` | active `Theme` | same names on `Theme` | present |
| `P.UI_WHITE`, `P.lerp_color`, `P.shade`, `P.with_alpha` | `palette.py` | `UI_WHITE`, `lerpColor`, `shade`, `withAlpha` (`core/palette.ts`) | present |
| `C.WINDOW_W/H`, `C.UI_BUTTON_W`, `C.MAX_DT`, `C.UI_CORNER` | `config.py` | same names in `core/config.ts` | present |
| `game.audio.muted` / `.toggle_mute()` / `.play()` | audio engine | `Audio.muted`, `toggleMute()`, `play(name, volume?)` | present (`web/src/audio/Audio.ts`) |
| `game.save.set_muted(bool)`, `game.save.save()` | `SaveData` | `setMuted(value)` (save.ts:849), `save()` (save.ts:640) | present |
| `game.canvas` | pygame surface | none - superseded by 4.2.1 | n/a by design |
| `game.fonts.display_at / tiny / body / h2` | `FontBook` | not ported | **gap** - ui.md / task 2 |
| `game.mouse_pos` | shell | `game.pointer.x/.y` | present |

**Gaps the TS core does not expose yet** (all blocking, none of them pause-specific):

1. `Game` has **no `audio`, `save` or `fonts` field**. `main.ts` injects `save` and `sound`
   into `GameplayScene`'s constructor (main.ts:54). `PauseScene` needs both, plus SETTINGS
   needs them too - so either put `audio: Audio` and `save: SaveData` on `Game` (matching
   Python's `game.audio` / `game.save` and integration.md 11) or keep constructor injection and
   register `new PauseScene(g, save, sound)`. Pick one before writing the third scene.
2. **No event dispatch to scenes and no keyboard.** `Scene` has no `handleEvent`; `InputManager`
   exposes only the held `pointer.down` / `.boost` and never surfaces press/release **edges**,
   and there are no key listeners at all (integration.md Q2). `Button` needs
   press-inside-then-release-inside, so the port needs either a per-frame
   `pointer.pressed` / `pointer.released` edge pair (loses a sub-frame click, acceptable at a
   60 Hz cap) or a small event queue drained by the top scene. Six keyboard bindings in this
   scene alone (`Esc P Space R M S O`) depend on it.
3. `C.UI_CLICK_COOLDOWN` (0.10) is in `config.json:122` but **not exported** by
   `core/config.ts` - `Button`'s debounce needs it (ui.md).
4. `Game.popScene` bug and the `level` vs `level_index` arg name (4.8).

### 4.11 Capture cross-check - `captures/09-pause.png`

Level index 5 ("Violet Static"): `accent = (255, 88, 226)`, `accent2 = (120, 108, 255)`,
`bg_bottom = (8, 2, 16)`, so the scrim is `rgba(4, 1, 8, 168)`.

| On screen | Accounted for by |
|---|---|
| Panel edge x ~= 405..875, y ~= 37..683 | `_panel_rect()` = `(405, 37, 470, 646)`, `offset = 0` (intro saturated) |
| "PAUSED" glyph top ~= 70, pink-white | row 4: display@74 at y=67, `lerp(accent, UI_WHITE, 0.46..0.60)` |
| "LEVEL 06" ~= y 135 | row 6 at y=131, `{5 + 1:02d}` |
| Divider ~= 465..815 at y ~= 155, pink-to-indigo, soft ends | row 5: `line_w = 350` from x=465, `lerp(accent, accent2, f)`, alpha `(1 - abs(f-0.5)*2)^0.6 * 200` |
| "VIOLET STATIC" ~= y 172 | row 7 at y=165 (body 21), `level_name.upper()` |
| Six buttons, 300 px wide, first at y ~= 205, last at y ~= 530..584 | rows 8-13 |
| RESTART LEVEL brighter with a wide halo | `Button` hover state; the cursor reticle sits on it |
| "QUIT TO MENU" in red | style `danger` (ui.md) |
| Three hint lines ~= y 611/630/650 | rows 14-16 at 607/626/645 (text top vs glyph top) |
| Blurred HUD ("SCORE 45", "BEST 4,210", "LVL 06", "LIVES", "BOOST", "PAUSE", "NO ACTIVE POWER-UPS"), blurred hazards (corner wall slabs, two diagonal spinners, a laser line, drifting runes) | the frozen frame under the snapshot + scrim |
| **Crisp** "60.0 fps" top-right | `main.py`'s shell FPS readout, drawn *after* the scenes -> not in the snapshot. Confirms the blur is a snapshot of the scene layers only |
| Mouse reticle over RESTART LEVEL | shell `draw_cursor` (ui.py:593), above every scene |

Nothing in the capture is unexplained by pause.py plus the shell. In particular there is no
visible "PAUSED" backdrop panel behind the title, no separate close button, and no visible
letterbox band (the capture is exactly 1280x720, which is why the overscan question in 4.2.1 is
still open).

---

## 5. Help - `HelpScene`

**Ground truth:** `E:/SnakeGame/snake/scenes/help_scene.py`, lines 1-660 (the whole file).
**Reference capture:** `E:/SnakeGame/captures/07-help.png` (theme 0, "Neon Grid").
**Suggested TS homes:**

* `web/src/scenes/HelpScene.ts` - `class HelpScene extends Scene` (layout, demo, transitions).
* `web/src/scenes/help/icons.ts` - the scene-local vector art: `mouseIcon`, `keyIcon`,
  `hazardIcon`, `fakeCursor`, `dottedLine`, `helpRune`. These are **not** UI-kit widgets; they
  live with the scene exactly as they do in Python. `draw_panel` / `draw_text` / `Button` /
  `FontBook` remain ui.md's.
* `web/src/scenes/help/DemoSnake.ts` - the autonomous demo (snake + Lissajous cursor + orb).

**No pagination.** The screen is one static 1280x720 board: four panels, a header and a BACK
button. There is no next/prev control, no scroll, no tab strip and no page counter anywhere in
the file. Content is fixed at 4 control rows, 6 power-up cells and 4 hazard rows. Everything
that moves is ambient (the demo, icon animations, the background).

### 5.1 Identity

| Property | Value | Source |
|---|---|---|
| Python class | `HelpScene(Scene)` | help_scene.py:336 |
| File / lines | `snake/scenes/help_scene.py`, 1-660 | |
| Registry key | `C.SCENE_HELP = "help"` -> `("help_scene", "HelpScene")` | config.py:197, main.py:40 |
| TS registry key | `SCENES.HELP = "help"` | `web/src/app/Scene.ts:73` |
| `transparent` | `False` | help_scene.py:339 |
| `blocks_update` | `True` | help_scene.py:340 |
| Entered by | `MenuScene` -> `game.switch_scene(C.SCENE_HELP)` (the "HOW TO PLAY" item) | menu.py:439 |
| Leaves to | `C.SCENE_MENU` via `switch_scene` only | help_scene.py:420 |

Single entrance, single exit; no overlay ever stacks on it.

### 5.2 Owned state

| Attribute | Type | `__init__` (help_scene.py:342-358) | `on_enter` (363-381) | Verdict |
|---|---|---|---|---|
| `theme` | `P.Theme` | `theme_for_level(0)` | `theme_for_level(int(game.level_index))` | reset. The help screen wears the **last played level's palette** |
| `t` | float | `0.0` | `0.0` | reset; drives every icon animation and the demo draw |
| `background` | background object | `None` | via `_ensure_background()` - rebuilt **only if `theme.bg_style` changed** | intentional cache, safe (5.3) |
| `_bg_style` | str | `""` | set by `_ensure_background` | the cache key |
| `back` | `Button` | `Button(_BACK_RECT, "BACK", style="primary")` | **replaced** by `Button(_BACK_RECT, "BACK", style="primary", font=fonts.h2)` | reset by replacement, so hover/press/`_cool` state cannot leak between entries. The `__init__` instance exists only so the attribute is never `None`; `_label_font` would have picked `h2` bold 30 for `primary` anyway, so the two are visually identical |
| `snake` | `Optional[Snake]` | `None` | `Snake(288, 255, 0.0, length=9)` then `snake.speed = 150.0` | reset; `on_exit` sets it back to `None` (help_scene.py:383-385) so a re-entry always starts from a clean pose |
| `cursor` | `(float, float)` | `_DEMO_RECT.center` = `(288, 255)` | `_cursor_target(0.0)` = `(288 + 186, 255 + 0)` = `(474, 255)` | reset |
| `food` | `(float, float)` | `_DEMO_RECT.center` | via `_respawn_food()` | reset |
| `food_pop` | float | `0.0` | `0.0` | reset |
| `food_age` | float | `0.0` | `0.0` via `_respawn_food()` | reset (indirectly - worth a comment in the port) |
| `_rng` | `random.Random(7)` | seeded 7 | **not reset** | *Latent, benign.* The stream continues across entries, so the second visit seeds the orb differently from the first. Nothing depends on it; if you want determinism for tests, re-seed in `onEnter` and say so. In TS use `makeRng(7)` (`core/mathx.ts:97`) - note the two RNGs are different generators, so orb placement will not match Python and does not need to |
| `_lissa_phase` | float | `0.0` | `0.0` | reset |

`on_enter` is wrapped in one `try/except: pass`, so a failure mid-way can leave a partially
reset scene (e.g. `t = 0` but `snake = None`). `_draw_demo` and `_update_demo` both early-return
on `snake is None`, which is what makes that survivable. Keep the same defensive shape.

### 5.3 Construction versus entry

| Built | Where | Notes |
|---|---|---|
| all panel rects, control/hazard copy tables, glyph polygons | module level (help_scene.py:47-90, 262-268) | frozen constants; in TS make them `const` in the module, not fields |
| the BACK button | `__init__` **and** `on_enter` | see 5.2 |
| the background | `_ensure_background` (387-397), called from `on_enter` | `make_background(theme.bg_style, theme, Rect(0, 0, 1280, 720))`. Rebuilt only when the style key changes, so returning to help with the same theme reuses the object *and its scroll phase* - the backdrop does not jump back to its start. Preserve that: cache on `bgStyle` and only rebuild on a mismatch |
| the demo `Snake` | `on_enter` | fresh instance each entry |
| glow / glyph textures | Python: lazily cached inside `draw_glow_circle` / `_glyph_sprite` | TS: `runeGlyphTexture` + `addGlow` caches already exist (`web/src/gfx/entities/`) |

In Pixi, every one of the four panels, all 14 text rows, all 14 icons and the six runes are
static display objects: build them once in the constructor (or on the first `onEnter`) and only
animate the handful of properties listed in 5.11. Only the demo well needs per-frame geometry.

### 5.4 Panels and the coordinate frame

Module constants (help_scene.py:47-59). `_PAD = 40`, `_TOP = 96`.

| Rect | Expression | Resolved `(x, y, w, h)` | `draw_panel` args | Panel title |
|---|---|---|---|---|
| `_DEMO_PANEL` | `Rect(40, 96, 496, 300)` | `(40, 96, 496, 300)`; right 536, bottom 396 | `alpha=214, glow=0.35` | `"THE SNAKE FOLLOWS YOUR POINTER"` |
| `_DEMO_RECT` | `Rect(x+16, y+40, w-32, h-62)` | `(56, 136, 464, 238)`; right 520, bottom 374, centre `(288, 255)` | - (drawn by hand, 5.6) | - |
| `_HAZARD_PANEL` | `Rect(40, 412, 496, 208)` | `(40, 412, 496, 208)`; bottom 620 | `alpha=214, glow=0.25` | `"HAZARDS"` |
| `_CTRL_PANEL` | `Rect(560, 96, 680, 216)` | `(560, 96, 680, 216)`; right 1240, bottom 312 | `alpha=214, glow=0.25` | `"CONTROLS"` |
| `_PU_PANEL` | `Rect(560, 328, 680, 292)` | `(560, 328, 680, 292)`; bottom 620 | `alpha=214, glow=0.25` | `"POWER-UPS"` |
| `_BACK_RECT` | `Rect((1280 - 300)//2, 638, 300, 58)` | `(490, 638, 300, 58)` | `Button(style="primary", font=fonts.h2)` | - |

All four `draw_panel` calls use the default `border=True`; only the demo panel has a stronger
glow (0.35 vs 0.25). Corner radius is `C.UI_CORNER = 12` inside `draw_panel`.

`_panel_title(rect, label)` (help_scene.py:543-549), used by all four panels:

| Element | Geometry | Colour | Font |
|---|---|---|---|
| tick mark | 3 px line from `(rect.x + 16, rect.y + 26)` **up** to `(rect.x + 16, rect.y + 12)` | `theme.accent` | - |
| label | `draw_text(..., (rect.x + 26, rect.y + 11))`, left/top | `lerp_color(theme.accent, UI_WHITE, 0.4)` | `fonts.small` (17) |

Resolved: demo `(56, 122)-(56, 108)` + label at `(66, 107)`; controls `(576, 122)-(576, 108)` +
`(586, 107)`; power-ups `(576, 354)-(576, 340)` + `(586, 339)`; hazards `(56, 438)-(56, 424)` +
`(66, 423)`.

### 5.5 Header (help_scene.py:532-541)

| Element | Text | x | y | anchor | font | colour |
|---|---|---|---|---|---|---|
| title | `"HOW TO PLAY"` | 40 | 18 | left / top | `fonts.h1` (display@42) | `lerp_color(theme.accent, UI_WHITE, 0.35)` |
| strapline | `"steer with the mouse - everything else is a bonus"` | 44 | 64 | left / top | `fonts.small` (17) | `theme.text_dim` |
| wordmark | `C.GAME_TITLE` = `"NEON SERPENT"` | 1240 | 26 | **right** / top | `fonts.small` | `shade(theme.accent2, 0.9)` |
| version | `f"v{C.VERSION}"` = `"v1.0.0"` | 1240 | 50 | **right** / top | `fonts.tiny` (14) | `shade(theme.text_dim, 0.8)` |

`C.VERSION` is present in `web/src/data/config.json:124` but **not exported by
`web/src/core/config.ts`** - add `export const VERSION = str("VERSION", "1.0.0")`. `GAME_TITLE`
is exported (config.ts:46).

### 5.6 The live demo (the animated diagram)

The left panel runs the **real** `Snake` against the **real** simulation, steered only by
`set_target` at a fake cursor on a Lissajous path, with a marching-ants leash drawn between
head and cursor. That relationship is the thing the panel exists to teach (help_scene.py:6-11).

Tuning constants (help_scene.py:64-72):

| Constant | Value | Meaning |
|---|---|---|
| `_DEMO_SPEED` | `150.0` px/s | assigned to `snake.speed`, overriding `C.SNAKE_BASE_SPEED` |
| `_DEMO_LENGTH` | `9` | `Snake(..., length=9)` |
| `_DEMO_MAX_LENGTH` | `15` | growth cap, tested against `snake.target_length` |
| `_LISSA_A` | `1.25` | cursor x frequency |
| `_LISSA_B` | `0.83` | cursor y frequency (the figure-of-eight) |
| `_LISSA_MARGIN` | `46.0` | inset of the path from the well edge |

`_cursor_target(t)` (help_scene.py:447-452), with `rx = 464*0.5 - 46 = 186`,
`ry = 238*0.5 - 46 = 73`:

```
cursor = (288 + cos(t * 1.25) * 186,  255 + sin(t * 0.83) * 73)
```

driven by `self._lissa_phase` (integrated real dt), **not** `self.t` - they are equal in
practice but only one of them is the path parameter. The path is deliberately slightly faster
than the snake so the leash stays visible (help_scene.py:67-69).

`_respawn_food()` (help_scene.py:454-469), `pad = 26.0`:

```
food_age = 0
ahead    = rng.uniform(1.2, 2.4)
(x, y)   = _cursor_target(_lissa_phase + ahead)
x += rng.uniform(-10, 10);  y += rng.uniform(-10, 10)
food = (clamp(x, 82, 494), clamp(y, 162, 348))        # DEMO_RECT inset by 26
```

i.e. the orb is seeded where the reticle is *about to be*, which is what keeps the demo eating
at a steady clip.

Painting, in order (`_draw_demo`, help_scene.py:551-601):

| # | Element | Geometry | Colour / formula |
|---|---|---|---|
| 1 | panel | `_DEMO_PANEL` | `draw_panel(alpha=214, glow=0.35)` |
| 2 | panel title | 5.4 | |
| 3 | well fill | 464x238 surface blitted at `(56, 136)` | `with_alpha(shade(theme.bg_bottom, 1.1), 218)` |
| 4 | lattice | vertical lines at local `gx = 0, 32, ... 448` (15 lines) -> design x `56, 88, ... 504`; horizontal at local `gy = 0, 32, ... 224` (8 lines) -> design y `136, 168, ... 360`; width 1 | `with_alpha(theme.grid, 60)` |
| 5 | well border | 1 px rounded rect on `_DEMO_RECT`, radius 6 | `shade(theme.grid, 1.0)` (= `theme.grid`) |
| 6 | *clip to `_DEMO_RECT`* | intersected with the previous clip; restored in a `finally` | Pixi: a rect mask on the demo container - `drawSnake`, the orb halo and the reticle glow are all unbounded |
| 7 | leash | `_dotted_line(head -> cursor, theme.accent, phase = -t * 34.0, step = 11.0)` | dots every 11 px: radius `1 + int(f * 1.6)` (1..2 px), colour `shade(accent, 0.25 + 0.55 f)`, `f = d / total`; skipped entirely when the gap is `< 4 px` |
| 8 | orb | `draw_food_orb(food.x, food.y, C.FOOD_RADIUS * pop, theme.food, t, "normal")`, `pop = 1 + 0.35 * food_pop`, `C.FOOD_RADIUS = 9` | radius 9..12.15 px |
| 9 | snake | `draw_snake(surface, snake, theme, t)` - no `ghost`, no `shield`, `crossing` left `None` | render.md |
| 10 | reticle | `_fake_cursor(cursor.x, cursor.y, theme, t)` | 5.6.1 |
| 11 | caption | `draw_text("this reticle is your mouse - the head chases it", fonts.tiny, shade(theme.text_dim, 1.05), (288, 376), align="center")` - `(_DEMO_PANEL.centerx, _DEMO_RECT.bottom + 2)`, **outside** the clip | |

`_dotted_line` phase note: `d = phase % step` with `phase = -t*34` relies on **Python's**
modulo returning a non-negative result for a positive divisor. In TS `%` keeps the sign, so
write `((phase % step) + step) % step` or the dashes vanish. The dashes march *toward* the
pointer at 34 px/s.

#### 5.6.1 `_fake_cursor` (help_scene.py:118-146)

A miniature of the real reticle, so the demo reads as "this dot is your mouse" without a
caption. `r = 11.0 + 1.2 * pulse(t, 3.0)` (11.0..12.2 px).

| Part | Geometry | Colour |
|---|---|---|
| halo | `draw_glow_circle(cx, cy, 20.0, theme.accent, 0.5)` | additive |
| 3 arcs | bounding `Rect(0, 0, int(r*2), int(r*2))` centred on `(int cx, int cy)`; `a0 = spin + k*(TAU/3)` for `k in 0..2`, sweep `0.85` rad, width 2, `spin = t * 1.35` | `lerp_color(accent, UI_WHITE, 0.3)` |
| 4 ticks | `ang = -0.5*spin + k*(pi/2)`, `k in 0..3`; line from `r + 3.0` to `r + 8.0` along `ang`, width 1 | `shade(theme.accent2, 0.85)` |
| centre dot | radius 2 | `UI_WHITE` |

`pygame.draw.arc` uses the **y-up** convention (entities.md 1.9): negate both angles to keep the
spin direction on screen, and pull the radius in by half the stroke width (pygame strokes an arc
inward from its bounding box), so the effective arc radius is `r - 1`.

#### 5.6.2 `_update_demo(dt)` (help_scene.py:471-505) - exact order

1. `_lissa_phase += dt`
2. `cursor = _cursor_target(_lissa_phase)`
3. `food_pop = max(0, food_pop - dt * 2.2)` (full decay in 1/2.2 = 0.4545 s)
4. `food_age += dt`
5. `snake.set_target(cursor.x, cursor.y)`
6. `snake.update(dt)` - no boost, no `speed_mult`, no `turn_mult`
7. `hx, hy = snake.head_pos()`
8. if `dist(hx, hy, food.x, food.y) < C.FOOD_RADIUS + 14.0` (= **23.0** px):
   `food_pop = 1.0`; if `snake.target_length < 15` -> `grow(1)` else `shrink(2)`;
   `_respawn_food()`
9. elif `food_age > 5.0` -> `_respawn_food()` (the head cuts corners, so an orb the pointer
   swung past can be stranded)
10. `cx = clamp(hx, 62, 514)`, `cy = clamp(hy, 142, 368)` (`_DEMO_RECT` inset by 6); if either
    changed -> `snake.teleport(cx, cy)`

The cap is tested on `target_length` (the growth goal) because `length` is a read-only property
of the resolved body (help_scene.py:487-489). `shrink(2)` floors at `MIN_LENGTH = 4`
(`web/src/core/snake.ts:86`), so the body oscillates 15 -> 13 -> 14 -> 15 once it saturates.

### 5.7 Controls panel

Copy table `_CONTROLS` (help_scene.py:75-82) - transcribe verbatim:

| i | icon key | caption | body copy |
|---|---|---|---|
| 0 | `move` | `MOVE THE MOUSE` | `The head always turns toward your cursor.` |
| 1 | `right` | `HOLD RIGHT BUTTON` | `Spend stamina for a burst of speed.` |
| 2 | `left` | `LEFT CLICK` | `Every menu and button is mouse-driven.` |
| 3 | `esc` | `ESC` | `Pause the run - or click PAUSE in the HUD.` |

Row 3's copy is deliberate (help_scene.py:79-80): the HUD affordance is a button labelled
PAUSE, not a chevron, so the copy must name what is on screen.

Layout (`_draw_controls`, help_scene.py:603-620): `row_h = 42`, `top = _CTRL_PANEL.y + 44 = 140`,
`ry = top + i * 42`.

| i | icon centre | caption (left/top) | body (left/top) |
|---|---|---|---|
| 0 | `(602, 160)` | `(638, 140)` | `(638, 160)` |
| 1 | `(602, 202)` | `(638, 182)` | `(638, 202)` |
| 2 | `(602, 244)` | `(638, 224)` | `(638, 244)` |
| 3 | `(602, 286)` | `(638, 266)` | `(638, 286)` |

icon x = `_CTRL_PANEL.x + 42`, icon y = `ry + 20`; text x = `_CTRL_PANEL.x + 78`.
Caption: `fonts.small` (17), `lerp_color(theme.accent, UI_WHITE, 0.5)`.
Body: `fonts.tiny` (14), `theme.text_dim`.

#### 5.7.1 `_mouse_icon(cx, cy, theme, lit, t)` (help_scene.py:149-186)

`lit` is `"move"`, `"left"` or `"right"` (the `_CONTROLS` key). Body: `w, h = 22, 32`,
`Rect(0, 0, 22, 32)` centred on `(int cx, int cy)` -> `body.centerx == int(cx)`.

| Part | Condition | Geometry | Colour |
|---|---|---|---|
| lit half glow | `lit in (left, right)` | `draw_glow_circle(half.centerx, half.centery, 16.0, glow_c, 0.55 + 0.35*pulse(t, 3.2))` | `glow_c = UI_WARN` if `right` else `theme.accent` |
| lit half fill | same | `half = Rect(body.x, body.y, 11, 16)`; `half.x = body.centerx` when `right`; `border_top_left_radius = 10` iff `left`, `border_top_right_radius = 10` iff `right` | `lerp_color(glow_c, UI_WHITE, 0.25)` |
| shell outline | always | rect stroke width 2, radius 10 | `lerp_color(shade(theme.text_dim, 0.9), UI_WHITE, 0.35)` |
| centre seam | always | `(centerx, y+2)` -> `(centerx, centery)`, width 2 | `shade(theme.text_dim, 0.9)` |
| waist line | always | `(x+2, centery)` -> `(right-2, centery)`, width 1 | `shade(theme.text_dim, 0.9)` |
| motion arcs | `lit == "move"` | `wobble = 2.0*sin(t*3.4)`; for `side in (-1, +1)`, `k in (0, 1)`: `x = centerx + side*(11 + 6 + 5k) + side*wobble`, arc in `Rect(int(x-6), int(cy-9), 12, 18)`, angles `-0.7..0.7` (side +1) or `pi-0.7..pi+0.7` (side -1), width 2 | `shade(theme.accent, 0.9 - 0.35k)` |

Note that the "left" icon in the capture reads as a plain shell with a cyan-lit top-left
quadrant, and "right" as a **gold** (`UI_WARN = (255, 196, 72)`) top-right quadrant - the only
place in the screen that uses `UI_WARN`.

#### 5.7.2 `_key_icon(cx, cy, theme, label, fonts, t)` (help_scene.py:189-199)

| Part | Geometry | Colour |
|---|---|---|
| glow | `draw_glow_circle(cx, cy, 22.0, theme.accent2, 0.22 + 0.12*pulse(t, 2.2))` | additive |
| cap fill | `Rect(0, 0, 46, 30)` centred, radius 7 | `with_alpha(UI_PANEL_LIGHT, 255)` |
| cap border | same rect, stroke 2, radius 7 | `lerp_color(theme.accent2, UI_WHITE, 0.25)` |
| label | `draw_text(label, fonts.tiny, UI_WHITE, (cap.centerx, cap.centery - 7), align="center", shadow=False)` | the only `shadow=False` text on the screen |

Called only for row 3 with `label = "ESC"`, so the cap is `(579, 271, 46, 30)`.

### 5.8 Power-ups panel

Content comes from `powerup_info(kind)` for `POWERUP_KINDS[:6]` so the legend can never drift
from the game (help_scene.py:13-15, 630-644). Values as shipped
(`snake/core/powerups.py:50-93` == `web/src/core/powerups.ts:70-118`):

| i | kind | `name.upper()` | `desc` | `duration` | printed | `powerup_color` |
|---|---|---|---|---|---|---|
| 0 | `magnet` | `MAGNET` | `Food is pulled toward your head.` | 8.0 | `8s` | `(255, 92, 96)` |
| 1 | `shield` | `SHIELD` | `Absorbs the next hit you take.` | 12.0 | `12s` | `(86, 220, 255)` |
| 2 | `slow` | `SLOW-MO` | `Slows you down for surgical steering.` | 6.5 | **`6s`** | `(144, 124, 255)` |
| 3 | `double` | `DOUBLE` | `Every pickup is worth double points.` | 10.0 | `10s` | `(255, 208, 84)` |
| 4 | `ghost` | `GHOST` | `Pass straight through your own body.` | 6.0 | `6s` | `(214, 228, 255)` |
| 5 | `frenzy` | `FRENZY` | `Extra food, and you move faster.` | 8.0 | `8s` | `(255, 74, 190)` |

**The `6s` is a trap.** The string is `f"{float(secs):.0f}s"`; Python's format uses
round-half-to-even, so `6.5 -> "6"`, and the capture confirms `6s`. JS
`(6.5).toFixed(0) === "7"`. Use a half-even helper (or the `roundHalfEven` the difficulty port
already needed - integration.md 11 notes banker's rounding is ported in
`core/difficulty.ts`). The row is drawn only `if secs:` - truthy, so a kind with
`duration = 0` would print nothing.

Layout (`_draw_powerups`, help_scene.py:622-644): `col_w = (680 - 32) // 2 = 324`,
`row_h = 80`, `top = _PU_PANEL.y + 46 = 374`, `x = 560 + 16 + 324*col`, `y = top + 80*row`,
`col = i % 2`, `row = i // 2` (so the reading order is left-to-right, top-to-bottom).

| i | kind | cell `(x, y)` | rune centre, r | name `(x+62, y+8)` | desc `(x+62, y+30)` | duration `(x+62, y+48)` |
|---|---|---|---|---|---|---|
| 0 | magnet | `(576, 374)` | `(606, 404)`, 17 | `(638, 382)` | `(638, 404)` | `(638, 422)` |
| 1 | shield | `(900, 374)` | `(930, 404)`, 17 | `(962, 382)` | `(962, 404)` | `(962, 422)` |
| 2 | slow | `(576, 454)` | `(606, 484)`, 17 | `(638, 462)` | `(638, 484)` | `(638, 502)` |
| 3 | double | `(900, 454)` | `(930, 484)`, 17 | `(962, 462)` | `(962, 484)` | `(962, 502)` |
| 4 | ghost | `(576, 534)` | `(606, 564)`, 17 | `(638, 542)` | `(638, 564)` | `(638, 582)` |
| 5 | frenzy | `(900, 534)` | `(930, 564)`, 17 | `(962, 542)` | `(962, 564)` | `(962, 582)` |

Fonts / colours: name `fonts.small` (17) in `lerp_color(powerup_color(kind), UI_WHITE, 0.35)`;
desc `fonts.tiny` (14) in `theme.text_dim`; duration `fonts.tiny` in
`shade(theme.text_dim, 0.75)`. All left/top anchored.

#### 5.8.1 `_draw_rune(kind, cx, cy, r=17.0, theme, t)` (help_scene.py:313-330)

"Halo + counter-rotating hexagram + core + emblem: the arena rune, small". With `r = 17`:

| Part | Formula | Value at r=17 | Colour |
|---|---|---|---|
| halo | `draw_glow_circle(cx, cy, r*2.4, col, 0.45 + 0.12*pulse(t, 2.6))` | radius 40.8, intensity 0.45..0.57 | `col = powerup_color(kind)`, **additive** |
| two triangles | `spin = t*0.85`; `tri_r = r*1.34`; for `sense in (+1, -1)`: `a0 = spin*sense + (0 if sense > 0 else pi/3)`; vertices at `a0 + k*TAU/3`; stroke `max(1, int(r*0.13))` | `tri_r = 22.78`, stroke 2 | `shade(lerp_color(col, theme.accent, 0.28), 0.55)` |
| core disc | filled circle `max(2, int(r*0.55))` | radius 9 | `shade(col, 0.30)` |
| emblem | `_glyph(kind, lerp_color(col, UI_WHITE, 0.55), cx, cy, r*0.78)`, stroke `w = max(2, int(s*0.22))` | `s = 13.26`, `w = 2` | `lerp_color(col, UI_WHITE, 0.55)` |

**Everything except the halo is drawn with normal alpha**, not `BLEND_RGB_ADD` - the arena's
rune painter is additive (powerups.py `_add()`), the help legend's re-authored copy is not. Do
not reuse the arena's additive blend here or the runes will blow out against the panel.

The glyph polygons in `help_scene.py:262-268` (`_SHIELD`, `_HOURGLASS`, `_BOLT`, `_GHOST_TAIL`)
and `_glyph`'s construction are **byte-identical** to `snake/core/powerups.py:216-271`
`_paint_glyph`, so the ported texture factory is reusable:
`runeGlyphTexture(kind, r * 1.56)` (`RuneRenderer` calls it as `runeGlyphTexture(p.kind,
r * 1.55)`; help's factor is `2 * 0.78`), which buckets to `sb = 26` -> painted radius 13
against Python's 13.26 - a 0.26 px difference at a 26 px glyph, below the perceptual bar. Tint
the white texture with `lerpColor(powerupColor(kind), UI_WHITE, 0.55)` at full alpha.

Per-glyph geometry, for the record (all in the normalised -1..1 box, scaled by `s`, y down):

| kind | strokes |
|---|---|
| `magnet` | open polyline `_arc_pts(cx, cy - 0.10s, s, 0.92, 0 -> pi, 14)` (y-up arc, so it bulges **up**), width `w`; then for `sx in (-0.92, +0.92)`: leg `(cx + sx*s, cy - 0.10s)` -> `(cx + sx*s, cy + 0.74s)` width `w`, and pole `(cx + sx*s*1.28, cy + 0.74s)` -> `(cx + sx*s*0.56, cy + 0.74s)` width `max(2, int(w*0.9))` |
| `shield` | polygon `_SHIELD` stroke `w`, plus a centre line `(cx, cy - 0.36s)` -> `(cx, cy + 0.46s)` width `max(1, w-1)` |
| `slow` | polygon `_HOURGLASS` stroke `w`, plus a filled dot at `(cx, cy + 0.52s)` radius `max(2, int(s*0.14))` |
| `double` | two concentric diamonds, `scale in (0.94, 0.48)`, vertices `(0,-s'),(s',0),(0,s'),(-s',0)`, stroke `w` |
| `ghost` | closed polyline of a 13-point dome (`a = i*pi/12`, radius 0.74, y negated) followed by `reversed(_GHOST_TAIL)`, stroke `w`; two eyes at `sx in (-0.30, +0.30)`, `(cx + sx*s, cy - 0.16s)`, radius `max(2, int(s*0.13))` |
| `frenzy` | **filled** polygon `_BOLT` (the only filled glyph) |
| fallback | circle radius `max(2, int(s*0.7))`, stroke `w` |

### 5.9 Hazards panel

Copy table `_HAZARDS` (help_scene.py:85-90):

| i | icon key | caption | body copy |
|---|---|---|---|
| 0 | `wall` | `WALLS` | `Solid neon slabs. A touch costs a life.` |
| 1 | `mover` | `MOVERS & SPINNERS` | `Bars that sweep the lane. Time the gap.` |
| 2 | `laser` | `LASER GATES` | `They blink. Cross only while they are dark.` |
| 3 | `portal` | `PORTALS` | `Harmless: dive in, pop out of the twin.` |

Four rows for six hazard classes: `mover` covers both `MovingBar` and `Spinner`, and `Pulsar`
has no row at all (entities.md 0.1 lists all six). That is the shipped copy; do not add a row.

Layout (`_draw_hazards`, help_scene.py:646-660): `row_h = 42`, `top = _HAZARD_PANEL.y + 40 = 452`,
`ry = top + 42i`; icon at `(_HAZARD_PANEL.x + 40, ry + 19)` = `(80, ry + 19)`; text x =
`_HAZARD_PANEL.x + 70` = 110.

| i | icon centre | caption `(110, ry)` | body `(110, ry + 20)` | caption colour |
|---|---|---|---|---|
| 0 wall | `(80, 471)` | `(110, 452)` | `(110, 472)` | `lerp_color(theme.hazard, UI_WHITE, 0.45)` |
| 1 mover | `(80, 513)` | `(110, 494)` | `(110, 514)` | `lerp_color(theme.hazard, UI_WHITE, 0.45)` |
| 2 laser | `(80, 555)` | `(110, 536)` | `(110, 556)` | `lerp_color(theme.hazard, UI_WHITE, 0.45)` |
| 3 portal | `(80, 597)` | `(110, 578)` | `(110, 598)` | `lerp_color(theme.accent2, UI_WHITE, 0.45)` - portals are not hazards |

Caption `fonts.small` (17); body `fonts.tiny` (14) in `theme.text_dim`.

`_hazard_icon(key, cx, cy, theme, t)` (help_scene.py:202-239), `hz = theme.hazard`:

| key | Parts |
|---|---|
| `wall` | `draw_glow_circle(cx, cy, 20.0, hz, 0.35)`; `Rect(0,0,30,16)` centred, filled `shade(hz, 0.55)` radius 4; stroke `lerp_color(hz, UI_WHITE, 0.35)` width 2 radius 4. **Static** |
| `mover` | `ang = t*1.5` (period 4.19 s); glow `(20.0, hz, 0.35)`; line from `(cx - 15cos, cy - 15sin)` to `(cx + 15cos, cy + 15sin)` width 5 in `lerp_color(hz, UI_WHITE, 0.3)`; white centre dot radius 2 |
| `laser` | `on = pulse(t, 4.0) > 0.45` (period 1.571 s; on 53.2 % of it = 0.835 s on / 0.736 s off); `col = lerp_color(hz, UI_WHITE, 0.4)` when on else `shade(hz, 0.25)`; glow `(20.0, hz, 0.55)` **only when on**; two emitter dots at `(cx, cy - 13)` and `(cx, cy + 13)` radius 3 in `shade(hz, 0.8)`; beam segments `step = 4 if on else 8`, for `y in range(-11, 12, step)` a line `(cx, cy+y)` -> `(cx, cy + min(11, y + step - 2))` width 3 - i.e. y = -11,-7,-3,1,5,9 when on, y = -11,-3,5 when off |
| `portal` (else) | `col = theme.accent2`; glow `(20.0, col, 0.40)`; two rings at `ox = -8` (radius 9, colour `lerp_color(col, UI_WHITE, 0.0)` = `col`) and `ox = +8` (radius 7, colour `lerp_color(col, UI_WHITE, 0.3)`), both stroke 2; a link line `(cx-4, cy)` -> `(cx+4, cy)` width 1 in `shade(col, 0.7)`. **Static** |

### 5.10 BACK button

`Button(Rect(490, 638, 300, 58), "BACK", style="primary", font=fonts.h2)`. `C.UI_BUTTON_W = 300`
and `C.UI_BUTTON_H = 58` here (unlike pause's bespoke 54). Drawn **last**, above every panel
(help_scene.py:527), with `self.t` as its animation clock.

### 5.11 `update(dt)` - exact order

`HelpScene.update` (help_scene.py:427-445), **real dt throughout** - this is a shell-level menu
scene; `fx.time_scale()` has no consumer here (integration.md 10):

1. `dt = clamp(dt, 0.0, C.MAX_DT)`
2. `self.t += dt`
3. `was_hovered = back.hovered`; `back.update(dt, game.mouse_pos)`; if `back.hovered and not
   was_hovered` -> `audio.play("hover")`
4. `background.update(dt)` if the background exists
5. `_update_demo(dt)` (5.6.2)
6. entire body inside `try/except: pass`

Per-frame animated quantities, so the port knows exactly what must not be baked into a static
display object:

| Driven by `t` | Formula | Period |
|---|---|---|
| reticle radius | `11.0 + 1.2*pulse(t, 3.0)` | 2.09 s |
| reticle arc spin | `t * 1.35` | 4.65 s / turn |
| reticle tick spin | `-0.675 t` | 9.31 s / turn |
| leash dash march | `phase = -34 t`, `step = 11` | 0.324 s / dash |
| mouse-icon lit glow | `0.55 + 0.35*pulse(t, 3.2)` | 1.96 s |
| mouse-icon motion arcs | `wobble = 2.0*sin(t*3.4)` | 1.85 s |
| keycap glow | `0.22 + 0.12*pulse(t, 2.2)` | 2.86 s |
| rune halo | `0.45 + 0.12*pulse(t, 2.6)` | 2.42 s |
| rune hexagram spin | `t * 0.85` | 7.39 s / turn |
| mover icon | `t * 1.5` | 4.19 s / turn |
| laser icon blink | `pulse(t, 4.0) > 0.45` | 1.571 s |
| orb / snake | `draw_food_orb(..., t, ...)`, `draw_snake(..., t)` | render.md |
| background | `background.update(dt)` | background spec |

Everything else (all 14 text rows, all four panels, the well and its lattice, the wall and
portal icons) is **static** and should be built once.

### 5.12 `draw()` - layer order

`HelpScene.draw` (help_scene.py:510-529), top of list painted first:

| # | Layer | Extent |
|---|---|---|
| 1 | `background.draw(surface)`, or `surface.fill(theme.bg_bottom)` when the background failed to build | Python: `Rect(0, 0, 1280, 720)`. **Port: the background may fill `viewport.overscan`** (settled convention); the fallback fill should too |
| 2 | `_draw_header` | design box |
| 3 | `_draw_demo` (panel, title, well, lattice, border, then the clipped demo, then the caption) | `_DEMO_PANEL`; the demo contents clipped to `_DEMO_RECT` |
| 4 | `_draw_controls` | `_CTRL_PANEL` |
| 5 | `_draw_powerups` | `_PU_PANEL` |
| 6 | `_draw_hazards` | `_HAZARD_PANEL` |
| 7 | `back.draw(surface, theme, fonts, t)` | `_BACK_RECT` |

`_DEMO_RECT` is the only clip in the scene. Nothing else is masked; the panels do not overlap
(gaps: demo bottom 396 -> hazard top 412; controls bottom 312 -> power-ups top 328; power-ups /
hazards bottom 620 -> BACK top 638), so a single flat container in this order is correct.

### 5.13 Input and transitions

`handle_event` (help_scene.py:402-412):

| Binding | Edge / held | Action |
|---|---|---|
| left click completing inside `_BACK_RECT` | edge (`Button.handle_event`) | `_go_back()` |
| `Esc`, `Backspace`, `Return`, `Space`, `H` | edge (KEYDOWN) | `_go_back()` |
| mouse motion | continuous | hover only |

| Trigger | Audio | Verb | Target | Args | `game.*` written |
|---|---|---|---|---|---|
| BACK / `Esc` / `Backspace` / `Return` / `Space` / `H` | `click` | `switch_scene` | `C.SCENE_MENU` | - | **none** |

`_go_back` (help_scene.py:414-422) wraps the cue and the switch in separate `try/except`
blocks, so a dead audio engine still lets you leave. No `level_index`, `mode`, `difficulty` or
`last_result` is ever written; the scene is read-only with respect to session state.

### 5.14 Audio cues, fx and particles

| Call | Trigger | In `audio.json`? |
|---|---|---|
| `game.audio.play("hover")` | `back` hover rising edge | yes |
| `game.audio.play("click")` | `_go_back` | yes |

**No `fx.*` and no `particles.*` calls.** The demo snake eating an orb deliberately emits
nothing - no burst, no flash, no shake, no cue. That is a content decision, not an omission: an
idle help screen that pops and chimes every two seconds is noise. Do not "improve" it by wiring
the gameplay pickup feedback in. `fx.begin_transition()` on the way out belongs to
`switch_scene`.

### 5.15 Data dependencies

| Reads | From | TS equivalent | Status |
|---|---|---|---|
| `game.level_index` | shell | `game.levelIndex` | present |
| `P.theme_for_level(idx)` | `themes.json` | `themeForLevel` | present |
| `theme.accent / accent2 / grid / hazard / food / text_dim / bg_bottom / bg_style` | `Theme` | same names (`bgStyle`) | present |
| `POWERUP_KINDS`, `powerup_info(kind)["name"/"desc"/"duration"]`, `powerup_color(kind)` | `powerups.py` table | `POWERUP_KINDS`, `powerupInfo(kind).name/.desc/.duration`, `powerupColor(kind)` (`core/powerups.ts`) | present - `desc` is exported and documented as "One-line description for the help screen" (powerups.ts:52) |
| `Snake(x, y, heading, length)`, `.speed`, `set_target`, `update(dt)`, `head_pos()`, `target_length`, `grow`, `shrink`, `teleport` | `core/snake.py` | `new Snake(x, y, heading, length)`, `.speed`, `setTarget`, `update(dt, opts?)`, `headPos()`, `targetLength`, `grow`, `shrink`, `teleport` | all present and public (`core/snake.ts`) |
| `C.FOOD_RADIUS` (9), `C.WINDOW_W/H`, `C.UI_BUTTON_W/H`, `C.MAX_DT`, `C.GAME_TITLE` | `config.py` | same names in `core/config.ts` | present |
| `C.VERSION` | `config.py:18` | in `config.json:124`, **not exported** by `core/config.ts` | **gap** |
| `contracts.TAU / clamp / dist / pulse` | `core/contracts.py` | `TAU / clamp / dist / pulse` (`core/mathx.ts`) | present |
| `P.UI_WHITE / UI_WARN / UI_PANEL_LIGHT / lerp_color / shade / with_alpha` | `palette.py` | `UI_WHITE / UI_WARN / UI_PANEL_LIGHT / lerpColor / shade / withAlpha` | present |
| `make_background(style, theme, Rect(0,0,1280,720))` | `gfx/background.py` | `makeBackground(style, theme, rect, renderer)` (`gfx/bg/index.ts:81`) - **note the extra `renderer` argument** | present, signature differs |
| `draw_snake(surface, snake, theme, t)` | `gfx/render.py` | `SnakeRenderer.draw(snake, theme, t, opts?)` (SnakeRenderer.ts:423) | present |
| `draw_food_orb(surface, x, y, r, color, t, kind)` | `gfx/render.py` | **no single-orb entry point** - `OrbRenderer.draw(field, clocks)` requires a whole `FoodField` and `OrbView` is not exported | **gap** |
| `draw_glow_circle(surface, x, y, r, color, intensity)` | `gfx/render.py` | `addGlow(...)` / `glowDiscRadius` (`gfx/entities/hazardGlow.ts`, exported via `gfx/entities/index.ts`) | present under a different name |
| `Button`, `draw_panel`, `draw_text`, `fonts.{h1,small,tiny,h2}` | `gfx/ui.py` | not ported | **gap** - ui.md / task 2 |
| `SaveData`, `levels.json`, `story.json`, `difficulty.json` | - | - | **not read at all** by this scene |

Gaps to raise with the owning specs:

1. **Single-orb painter.** The help demo needs `drawFoodOrb(x, y, r, color, t, kind)` semantics
   with an explicit radius (`C.FOOD_RADIUS * pop`) and an explicit colour (`theme.food`), which
   the `FoodField`-driven `OrbRenderer` cannot express. Ask entities.md to export the per-orb
   view (e.g. `class OrbSprite { paint(x, y, r, col, t, kind) }`) - `OrbRenderer` then becomes a
   pool of them and the help demo instantiates exactly one.
2. `C.VERSION` export in `core/config.ts`.
3. Half-even `.0f` formatting helper for the duration strings (5.8).
4. `makeBackground` needs a `Renderer`; `Game.app.renderer` is only available when not
   `headless`, so `HelpScene._ensureBackground` must tolerate its absence exactly as Python
   tolerates a `make_background` failure (`background = None` -> flat `bg_bottom` fill).
5. The scene-level keyboard / click-edge facility (same gap as 4.10 item 2): six keys here.
6. `Game` needs an `audio` handle (or constructor injection) for the two cues.

### 5.16 Capture cross-check - `captures/07-help.png`

Theme 0 "Neon Grid": `accent = (0, 236, 255)` (cyan), `accent2 = (255, 60, 190)` (magenta),
`food = (255, 214, 64)` (gold), `hazard = (255, 66, 110)`, `grid = (30, 52, 96)`,
`bg_style = "grid"`.

| On screen | Accounted for by |
|---|---|
| "HOW TO PLAY" top-left, cyan-white, ~y 22 | header row 1 at `(40, 18)`, h1 = display@42 |
| "steer with the mouse - everything else is a bonus", ~y 70 | header row 2 at `(44, 64)` |
| "NEON SERPENT" magenta top-right + "v1.0.0" under it | header rows 3-4, right-aligned at x=1240, y=26 / 50 |
| Four panels at the four quadrant positions, each with a cyan tick + small-caps caption | 5.4; tick is the 3 px vertical line at `rect.x + 16` |
| Dark well with a faint 32 px lattice, rounded 1 px border | demo layers 3-5; 15 vertical + 8 horizontal lines |
| Cyan snake mid-turn, gold orb with a bright halo left of the head, a trail of small dots running left to a small ringed reticle | demo layers 7-10; the dots are `_dotted_line` marching toward the reticle |
| "this reticle is your mouse - the head chases it" centred under the well | demo layer 11 at `(288, 376)` |
| Controls: three mouse bodies + one `ESC` keycap; row 1's mouse has cyan side arcs, row 2's has a **gold** top-right quadrant, row 3's a cyan top-left quadrant | 5.7.1 - gold is `UI_WARN`, used nowhere else on screen |
| Power-ups in two columns, reading magnet / shield / slow / double / ghost / frenzy left-to-right then down, with `8s 12s 6s 10s 6s 8s` | 5.8; confirms `col = i % 2` ordering **and** the half-even `6s` for `duration = 6.5` |
| Rune emblems: horseshoe, shield, hourglass, double diamond, ghost with two eyes, filled bolt - each on a dark disc inside a six-pointed star | 5.8.1 (two counter-rotating triangles read as a hexagram) |
| Hazards: red slab, red rotating bar with a white hub, red dashed vertical beam with two end dots, **magenta** double ring | 5.9 - the magenta confirms `theme.accent2` for the portal row |
| BACK button centred at the bottom | 5.10, `(490, 638, 300, 58)` |
| Perspective grid backdrop with a bright horizon band and magenta streaks | `make_background("grid", theme0, ...)` - background spec |
| "60.0 fps" top-right, crisp | shell FPS readout (`main.py`), above every scene |
| Mouse reticle over the BACK button | shell `draw_cursor` |

Nothing on screen is unexplained by help_scene.py plus the shell. Two things worth stating
because their absence is easy to mistake for a missing feature: there is **no** Pulsar row in
the hazard legend, and there is **no** page indicator - the board is complete as drawn.
## 6. The shared result-screen base (`_ResultScene`)

**Ground truth (do not modify):** `E:/SnakeGame/snake/scenes/gameover.py` lines 1-699 — the
module docstring, the four timing constants, seven module helpers and `class _ResultScene`
(222-699). Lines 705-1185 of the same file are `GameOverScene` and `VictoryScene`, owned by
§7 and §8; this section cites them only where the base's machinery is *parameterised* by
them.

**Companion specs.** `docs/port/ui.md` owns the internals of `draw_panel`, `draw_text`,
`Button` and the font book — this section records only what the result screens *ask* those
widgets for. `docs/port/integration.md` §6.1 owns the producing side of `game.last_result`;
§2.4 the scene-stack semantics; §10 the real-dt / scaled-dt split.

**Suggested TS home**

| Python | TS |
|---|---|
| `_ResultScene` | `web/src/scenes/result/ResultScene.ts` → `export abstract class ResultScene extends Scene` |
| `_mute`, `_mute_theme` | `web/src/scenes/result/muteTheme.ts` → `mute(rgb, grey?, dark?)`, `muteTheme(theme)` |
| `_fmt_time`, `_fmt_delta` | `web/src/scenes/result/format.ts` → `fmtTime(s)`, `fmtDelta(n)`, `fmtThousands(n)` |
| `_star_points`, `_draw_star`, `_draw_badge` | `web/src/scenes/result/decor.ts` → `starPoints`, `StarSprite`, `BadgeSprite` (Pixi display objects, not draw calls — see §6.2.8) |
| `GameOverScene` / `VictoryScene` | `web/src/scenes/result/GameOverScene.ts` / `VictoryScene.ts` (§7, §8) |

Constructor signature follows the shipped convention in `web/src/main.ts:54`
(`new GameplayScene(g, save, sound)`): `new GameOverScene(game, save, sound)` — `SaveData`
and `Audio` are injected, they are **not** fields on `Game`.

---

### 6.1 Module timing constants

| Constant | Value | Line | Meaning | In `config.json`? |
|---|---|---|---|---|
| `COUNT_TIME` | `1.05` s | gameover.py:84 | seconds the summary numbers take to roll 0 → real value | no — scene-local, define in `ResultScene.ts` |
| `COUNT_DELAY` | `0.30` s | gameover.py:86 | dead time before the roll starts, so the heading lands first | no |
| `STAR_FIRST` | `0.85` s | gameover.py:88 | when star 0 pops | no |
| `STAR_GAP` | `0.55` s | gameover.py:89 | gap between consecutive star pops | no |
| `STAR_POP` | `0.55` s | gameover.py:91 | duration of one star's pop animation | no |
| `BUTTON_H` | `C.UI_BUTTON_H` = `58` | gameover.py:93 | button height for every row on both screens | **yes** — `C.UI_BUTTON_H` (`config.ts:144`, `config.json:120`) |
| `_MAX_BEAT` | `max(0, LEVEL_COUNT - 1)` = `11` | gameover.py:97 | upper bound for `_mark_beat`'s index guard | derived from `LEVEL_COUNT` (`core/level.ts:265`) |
| `C.WINDOW_W`, `C.WINDOW_H` | `1280`, `720` | config.py:28-29 | used for centring and for the background rect | **yes** (`config.ts:52-53`) |
| `C.MAX_DT` | `1/20` = `0.05` s | config.py:60 | `update` clamps dt to this | **yes** (`config.ts:56`) |

---

### 6.2 The module helpers

#### 6.2.1 `_mute(color, grey=0.62, dark=0.70) -> RGB` (gameover.py:103-110)

Drain a colour toward its own luminance, then darken it.

```
r, g, b = int(color[0]), int(color[1]), int(color[2])      # non-numeric -> return (90, 96, 110)
lum     = int(0.299*r + 0.587*g + 0.114*b)                 # int() TRUNCATES, not rounds
out     = shade( lerp_color((r,g,b), (lum,lum,lum), grey), dark )
```

* `lerp_color` and `shade` are `lerpColor` / `shade` in `core/palette.ts:36,46`; both already
  truncate each channel through `clamp8`, so the TS result is bit-identical provided `lum`
  uses `Math.trunc`.
* Exception fallback `(90, 96, 110)` (gameover.py:108) is not a theme colour and not in
  `palette.ts`; port it as a module-local literal `MUTE_FALLBACK: RGB = [90, 96, 110]` with a
  comment that it is only reachable from a malformed colour.

#### 6.2.2 `_mute_theme(theme) -> Theme` (gameover.py:113-132)

`dataclasses.replace` of the level theme — **`name` and `bg_style` are carried through
unchanged**, all twelve colour fields are replaced:

| Theme field | Expression | grey | dark |
|---|---|---|---|
| `bg_top` | `_mute(theme.bg_top, 0.75, 0.62)` | 0.75 | 0.62 |
| `bg_bottom` | `_mute(theme.bg_bottom, 0.75, 0.62)` | 0.75 | 0.62 |
| `grid` | `_mute(theme.grid, 0.80, 0.60)` | 0.80 | 0.60 |
| `accent` | `_mute(theme.accent, 0.55, 0.78)` | 0.55 | 0.78 |
| `accent2` | `_mute(theme.accent2, 0.60, 0.72)` | 0.60 | 0.72 |
| `snake_head` | `_mute(theme.snake_head)` | 0.62 | 0.70 |
| `snake_a` | `_mute(theme.snake_a)` | 0.62 | 0.70 |
| `snake_b` | `_mute(theme.snake_b)` | 0.62 | 0.70 |
| `food` | `_mute(theme.food)` | 0.62 | 0.70 |
| `hazard` | `_mute(theme.hazard, 0.35, 0.85)` | 0.35 | 0.85 |
| `text` | `lerp_color(theme.text, P.UI_DIM, 0.35)` — **not** `_mute` | — | — |
| `text_dim` | `_mute(theme.text_dim, 0.5, 0.9)` | 0.5 | 0.9 |
| `name`, `bg_style` | unchanged | — | — |

On any exception the *original* theme is returned (gameover.py:131-132), i.e. the screen
silently plays at full saturation rather than crashing.

**TS port note (must not be missed):** `Theme` in `core/palette.ts:146-172` is a readonly
interface carrying a precomputed `hex: ThemeHex` mirror. A muted copy built with object spread
would keep the *unmuted* `hex` block, and every renderer that reads `theme.hex.*` (arena
frame, backgrounds, snake) would paint at full saturation while the vector text painted muted.
`muteTheme` must rebuild `hex` with `toHex` for all twelve fields — the same 12-field
`buildTheme` tail at `palette.ts:232-245`. Cheapest correct shape: extract that tail into a
`withHex(colors): Theme` helper and call it from both `buildTheme` and `muteTheme`.

`_mute_theme` is used by `GameOverScene._build_theme` only (gameover.py:715-716); `VictoryScene`
uses the level theme raw via the base `_build_theme` (gameover.py:436-437).

#### 6.2.3 `_fmt_time(seconds) -> str` (gameover.py:135-141)

```
s = int(clamp(float(seconds), 0.0, 59*60 + 59))      # ceiling 3599 s; int() truncates
return "{:d}:{:02d}".format(s // 60, s % 60)         # "0:00", "1:01", "12:07", max "59:59"
```
Non-numeric input → `s = 0` → `"0:00"`. No hours field ever appears.
TS: `` `${Math.trunc(s/60)}:${String(s%60).padStart(2,"0")}` ``.

#### 6.2.4 `_fmt_delta(delta) -> str` (gameover.py:144-150)

```
n = int(delta)                                       # TypeError/ValueError -> 0
return "{}{:,}".format("+" if n >= 0 else "-", abs(n))
```
Produces `+1,240` / `-90` / `+0`. Note the sign is written explicitly and `abs(n)` is
formatted, so `-0` is impossible.

**Port hazard:** `"{:,}"` is a comma-grouped en-US format. `Number.toLocaleString()` follows
the *browser* locale, so a de-DE device would render `1.240` and an ar-EG device Arabic-Indic
digits. Write one fixed grouper and use it for every `{:,}` in this file (the delta here, the
score rows in §6.9, `PAR {:,}` in §6.7, `LEVEL BEST {:,}`):

```
fmtThousands(n) = Math.trunc(Math.abs(n)).toLocaleString("en-US")   // or a manual /\B(?=(\d{3})+$)/ insert
```

#### 6.2.5 `_star_points(cx, cy, radius, rot=0.0) -> [(int,int)] x 10` (gameover.py:153-162)

```
inner = radius * 0.44
for i in 0..9:
    r   = radius if i % 2 == 0 else inner
    ang = -pi*0.5 + rot + i * (TAU / 10.0)          # TAU/10 = 0.6283185307179586 rad = 36 deg
    pt  = (int(cx + cos(ang)*r), int(cy + sin(ang)*r))
```
Ten vertices, alternating outer/inner, **outer point up** at `rot = 0` (`-pi/2` start).
`i` runs clockwise on screen (y grows downward, per entities.md's convention note).

The `int()` truncation is dropped in the port per the settled "float coordinates, no integer
truncation" decision (gfx-port-decisions) — at `radius = 40` a truncated vertex moves the star
tip by up to 1 design px, which becomes ~2.5 device px on a 1080p phone and visibly wobbles
during the pop animation.

#### 6.2.6 `_draw_star(surface, cx, cy, radius, color, *, filled, glow=0.0, rot=0.0)` (gameover.py:165-182)

| Step | Condition | Exact call |
|---|---|---|
| bail | `radius < 3.0` | return, draw nothing |
| glow | `glow > 0.01` | `draw_glow_circle(surface, cx, cy, radius * 1.9, color, glow)` |
| points | always | `pts = _star_points(cx, cy, radius, rot)` |
| fill | `filled` | `pygame.draw.polygon(surface, color, pts)` |
| rim | `filled` | `polygon(surface, lerp_color(color, UI_WHITE, 0.55), pts, max(1, int(radius * 0.10)))` |
| outline only | `not filled` | `polygon(surface, color, pts, max(1, int(radius * 0.09)))` |

Whole body wrapped in `try/except: pass`.

Concrete widths at the sizes `VictoryScene` uses: earned star `radius = 40.0` → rim width
`max(1, int(4.0)) = 4`; unearned star `radius = 40.0 * 0.86 = 34.4` → outline width
`max(1, int(3.096)) = 3`. During the pop, `radius = 40 * scale` with `scale` starting at
`0.25 + 0.75*easeOutBack(0) = 0.25` → `radius = 10.0` → rim width `max(1, int(1.0)) = 1`; the
`radius < 3.0` bail therefore never triggers for an earned star (min radius 10.0).

`draw_glow_circle` (render.py:355-362) is the additive cached-glow primitive; per
gfx-port-decisions it becomes a white radial sprite with `tint = toHex(color)` and
`alpha = glow`, blend `"add"`, sized `2 * radius * 1.9`.

#### 6.2.7 `_draw_badge(surface, cx, cy, label, color, font, *, glow=0.30) -> Rect` (gameover.py:185-216)

The difficulty chip. Returns the rect it drew (empty rect on any failure, or when `font is
None`).

```
text  = str(label).upper()
tw, th = font.size(text)
w, h  = int(tw) + 40, int(th) + 12
rect  = Rect(0, 0, w, h);  rect.center = (int(cx), int(cy))    # -> rect.x = int(cx) - w//2, rect.y = int(cy) - h//2
if glow > 0.01: draw_glow_circle(surface, cx, cy, w * 0.52, color, glow)
chip  = Surface((w, h), SRCALPHA)
radius = h // 2                                                # fully-rounded ends
rect_fill  : with_alpha(shade(color, 0.26), 214),  (0,0,w,h), border_radius=radius
rect_border: with_alpha(color, 235),               (0,0,w,h), width=2, border_radius=radius
surface.blit(chip, rect.topleft)
draw_text(surface, text, font, lerp_color(color, UI_WHITE, 0.60),
          (rect.centerx, rect.y + 6), align="center", shadow=False)
```

Padding is **40 px horizontal total** (20 per side) and **12 px vertical total**; the label's
top edge sits `rect.y + 6`, i.e. the text is *not* vertically centred by measurement — it is
centred by construction because the 12 px of vertical padding are split 6/6. `rect.centerx =
rect.x + w // 2`.

Measured against `captures/11-victory.png`: `fonts.small` (17 px) rendering `"NORMAL"` gives a
chip ≈ 108 x 32 px centred on (640, 236) → `tw ≈ 68`, `th ≈ 20`, `border_radius = 16`. The
gameover capture shows the same chip at (640, 272).

Python rebuilds this surface every frame (the docstring at 191-193 argues it is one rounded
rect plus two blits). **Pixi must not:** the chip is a `Graphics` + one `Text`, built in
`onEnter` when the label/colour are known, and never touched again — the only per-frame value
is the glow sprite's static alpha, which is also constant (`glow` is 0.16 or 0.34, never
animated).

#### 6.2.8 Summary of the vector-drawing port shape

| Python per-frame draw | Pixi object | Rebuild when |
|---|---|---|
| `_draw_badge` | `Container{ glowSprite, Graphics(chip), Text }` | `onEnter` only (label, colour, muted flag) |
| `_draw_star` unearned | `Graphics` polyline, 10 float points | `onEnter` only |
| `_draw_star` earned | `Container{ glowSprite, Graphics(fill+rim) }`, animated by `container.scale` / `container.rotation` / `glowSprite.alpha` | polygon geometry built **once** at `radius = 40`; the pop is a transform, the breathing is `glowSprite.alpha` |

The one wrinkle: the rim stroke width is `max(1, int(radius*0.10))` of the *animated* radius,
so scaling a `radius = 40` Graphics by 0.25 gives a rim of `4 * 0.25 = 1.0` px where Python
draws `max(1, int(10*0.10)) = 1` px. They agree at 0.25; between them the scaled rim is
continuous where Python's is a staircase. Accepted divergence (perceptual verification,
gfx-port-decisions) — do not rebuild the polygon per frame to chase it.

---

### 6.3 Identity

| Property | Value |
|---|---|
| Python class | `_ResultScene(Scene)`, `snake/scenes/gameover.py:222-699` |
| Registered under | nothing directly — it is abstract. `GameOverScene` → `C.SCENE_GAMEOVER = "gameover"`, `VictoryScene` → `C.SCENE_VICTORY = "victory"` (`config.py:195-196`; registry `main.py:38-39`, both from module `scenes.gameover`) |
| TS scene keys | `SCENES.GAMEOVER = "gameover"`, `SCENES.VICTORY = "victory"` (`web/src/app/Scene.ts:71-72`) — already present |
| `transparent` | `False` (inherited, `contracts.py:48`) — the result screens are opaque, they paint their own background |
| `blocks_update` | `True` (inherited, `contracts.py:49`) |
| `veil_alpha` | class attribute, base `120` (gameover.py:232); overridden `168` by `GameOverScene` (708) and `112` by `VictoryScene` (876) |
| Entered by | `GameplayScene._finish` → `game.switch_scene(C.SCENE_VICTORY if won else C.SCENE_GAMEOVER)` (`gameplay.py:1161`) — **the only real caller**, and it passes **no kwargs** |
| Also reachable | `SettingsScene._resolve_back` accepts `"gameover"`/`"victory"` as a legal back target (`settings.py:287`), so a settings screen opened *over* a result screen would `switch_scene` back into it. Nothing in the shipped game does that (no settings button on either result screen), but the code path exists and would re-run `on_enter` — replaying the entry sting and the whole reveal. |
| Exits to | `C.SCENE_GAME`, `C.SCENE_LEVELS`, `C.SCENE_MENU`, `C.SCENE_STORY` (the last only from `VictoryScene._story_continue`) — see §6.13 |
| Instances | cached and reused by `Game._make_scene` (`main.py:285-300`) — `on_enter` must reset everything |

---

### 6.4 Owned state

Every instance attribute of `_ResultScene`. "Reset in `on_enter`?" is the column that matters:
scene instances are cached, so anything answering "no" carries a previous run's value into the
next entry.

| Attribute | Type | `__init__` value | Line | Reset in `on_enter`? |
|---|---|---|---|---|
| `theme` | `P.Theme` | `P.THEMES[0]` | 236 | **yes** — `self.theme = self._build_theme()` (413) |
| `buttons` | `List[Button]` | `[]` | 237 | **yes** — `self.buttons = self._build_buttons()` (419); see the latent bug below |
| `result` | `Dict[str, Any]` | `{}` | 238 | **yes** — rebuilt in `_read_result` (270) |
| `level_index` | `int` | `0` | 243 | yes (280) then possibly overridden by kwarg (405) |
| `level_name` | `str` | `""` | 244 | yes (286) |
| `score` | `int` | `0` | 245 | yes (287) |
| `food_eaten` | `int` | `0` | 246 | yes (289) |
| `goal_food` | `int` | `1` | 247 | yes (288) |
| `stars` | `int` | `0` | 248 | yes (290) |
| `new_best` | `bool` | `False` | 249 | yes (294) |
| `max_combo` | `int` | `0` | 250 | yes (291) |
| `deaths` | `int` | `0` | 251 | yes (292) |
| `elapsed` | `float` | `0.0` | 252 | yes (293) |
| `mode` | `str` | `C.MODE_FREE` | 253 | yes (296, via `_read_mode`) |
| `diff` | `D.Difficulty` | `D.get_difficulty(None)` | 254 | yes (297-298) |
| `star_targets` | `Tuple[int,int,int]` | `(1, 2, 3)` | 255 | yes (336, via `_derive`) |
| `par` | `int` | `1` | 256 | yes (337) = `max(1, star_targets[0])` |
| `final` | `bool` | `False` | 257 | yes (334) = `level_index >= LEVEL_COUNT - 1` |
| `next_index` | `int` | `0` | 258 | yes (335) |
| `_result_level` | `int` | `-1` | 259 | yes (282) — the level the dict's `star_targets` belong to |
| `t` | `float` | `0.0` | 261 | **yes** — `self.t = 0.0` (412). Drives the entire reveal; the #1 thing to get right |
| `_bg` | `Background \| None` | `None` | 262 | **no, deliberately** — cached art, invalidated only by a style/theme change (`_ensure_background`, 464-482) |
| `_bg_style` | `str` | `""` | 263 | no — cache key |
| `_bg_theme_name` | `str` | `""` | 264 | no — cache key |

Subclass state, for completeness (reset in `_on_ready`, which the base calls last):

| Attribute | Owner | `__init__` | Reset in `_on_ready`? |
|---|---|---|---|
| `_ember_acc` | GameOverScene (712) | `0.0` | yes (736) |
| `_best_ping` | GameOverScene (713) | `False` | yes (737) |
| `_stars_shown` | VictoryScene (880) | `0` | yes (918) |
| `_confetti` | VictoryScene (881) | `0.0` | yes (919) → `2.6` |
| `_confetti_acc` | VictoryScene (882) | `0.0` | yes (920) |
| `_star_x` | VictoryScene (883) | `[]` | yes (923) |
| `_star_y` | VictoryScene (884) | `292.0` | yes (921), and re-set every frame in `_draw_body` (1105) |

#### Two latent bugs to port as *fixes*, not as quirks

1. **Stale buttons on a partial failure.** `on_enter` (399-427) assigns `self.buttons` at line
   419; every step before it can raise. The `except` handler at 422-427 only installs the
   fallback `MENU` button `if not self.buttons` — and `self.buttons` still holds the
   *previous* entry's list, which may belong to a different mode (story `RETRY LEVEL` /
   `ABANDON RUN` on a free-play death) or a different level (`NEXT LEVEL` pointing at the old
   `next_index`, which is fine because `_act` re-reads `self.next_index`, but the *label* lies).
   In TS: clear `this.buttons = []` **before** the try block, so the fallback always fires.
2. **`_on_ready` is inside the try.** It runs last (line 421). If `_ensure_background` or
   `_build_buttons` throws, subclass state is never reset: `VictoryScene._stars_shown` stays
   at its previous value, so `_emit`'s `while self._stars_shown < want` loop never runs and the
   stars never pop; `_star_x` stays `[]` so `_draw_stars` falls back to `C.WINDOW_W * 0.5` for
   all three (they stack on top of each other at x = 640). In TS: reset subclass state at the
   *top* of `onEnter` (a `resetSceneState()` hook called first), and keep `onReady()` for the
   audio/fx sting only.

Neither is reachable in the shipped Python (nothing in the path throws), which is exactly why
they must be written down before the port introduces a throw.

---

### 6.5 Construction versus entry

| Built | When | Where |
|---|---|---|
| the attribute set of §6.4 at defaults | once, first time the scene key is instantiated | `__init__` (234-264) |
| `theme` | every entry | `_build_theme()` (413) — level theme, or `_mute_theme(level.theme)` for game over |
| `buttons` | every entry | `_build_buttons()` (419) — a fresh `Button` list; the row depends on `mode` and `final`, both resolved by `_read_result`/`_derive` **before** this call (the comment at 913-915 relies on that ordering) |
| background | **only when `(bg_style, theme.name)` changed** | `_ensure_background()` (464-482): `make_background(style, self.theme, (0, 0, C.WINDOW_W, C.WINDOW_H))`. Note the rect is the **whole design box**, not the arena rect gameplay passes. |
| parsed result fields | every entry | `_read_result()` (401) |
| particles | cleared every entry | `game.particles.clear()` (420) and again in `on_exit` (431) |
| RNG layouts | none — neither result screen has a randomised layout. `VictoryScene._star_x` is deterministic (`centre ± 118`, 923). Randomness here is emission-time only (embers, confetti, late fireworks). |

`on_enter` order, exactly (399-421):

```
1  _read_result()                                   # 401  -> mode, diff, star_targets, par, final, next_index
2  if "level_index" in kwargs: clamp + _derive()     # 403-409  (kwarg wins; never used by the shipped caller)
3  game.level_index = self.level_index               # 410  <-- session state written on the way IN
4  t = 0.0                                           # 412
5  theme = _build_theme()                            # 413
6  game.fx.set_theme(theme)                          # 414-417 (guarded)
7  _ensure_background()                              # 418
8  buttons = _build_buttons()                         # 419
9  game.particles.clear()                            # 420
10 _on_ready()                                       # 421  -> subclass reset + entry sting
```

`on_exit` (429-433): `game.particles.clear()` and nothing else. `_bg` survives on purpose.

**The first drawn frame is `t = 0`.** `_finish` runs inside `GameplayScene.update`, so
`switch_scene` happens mid-`Game.update`; the shell's stack walk (`main.py:407-411`) has
already fetched the gameplay scene and `break`s on its `blocks_update`, so the freshly entered
result scene gets **no `update()` that frame** but **is drawn** (`main.py:421-425`). Do not
seed `t` with the current frame's dt: the zero state (all counters `0`, all three stars as dim
outlines, no NEW BEST) must be the first thing on screen for one frame.

---

### 6.6 Result parsing

#### `_read_result()` (267-299)

`raw = getattr(game, "last_result", None)`; `self.result = dict(raw) if isinstance(raw, dict)
else {}`. A local `num(key, default)` coerces via `float`, mapping `None` and
`TypeError/ValueError` to `default`.

| Field | Expression | Line |
|---|---|---|
| `level_index` | `int(clamp(num("level_index", int(game.level_index or 0)), 0, LEVEL_COUNT - 1))` | 279-281 |
| `_result_level` | `= level_index` (captured **before** the kwarg override, so a kwarg forces a par rebuild) | 282 |
| `level_name` | `str(result["level_name"])` if truthy else `get_level(level_index).name` | 285-286 |
| `score` | `max(0, int(num("score")))` | 287 |
| `goal_food` | `max(1, int(num("goal_food", level.goal_food)))` | 288 |
| `food_eaten` | `max(0, int(num("food_eaten")))` | 289 |
| `stars` | `int(clamp(num("stars"), 0, 3))` | 290 |
| `max_combo` | `max(0, int(num("max_combo")))` | 291 |
| `deaths` | `max(0, int(num("deaths")))` | 292 |
| `elapsed` | `max(0.0, num("elapsed"))` | 293 |
| `new_best` | `bool(result.get("new_best", False))` | 294 |
| `mode` | `_read_mode()` | 296 |
| `diff` | `D.get_difficulty(result.get("difficulty", game.difficulty))` | 297-298 |
| then | `_derive()` | 299 |

#### `_read_mode()` (301-328) — precedence, in order

1. `result["mode"]` if it is a `str` whose `.strip().lower()` is in `C.GAME_MODES` → that.
2. else `result["story"]` if it is a `bool` → `MODE_STORY` if true else `MODE_FREE`.
3. else **if the dict is non-empty at all** → `MODE_FREE`. (A hand-built or legacy dict is
   never treated as a campaign result — the docstring at 302-313 is explicit that this is the
   harmless reading, because free play never touches story bookkeeping.)
4. else (`result` empty, i.e. entered cold) → `game.mode` if in `GAME_MODES`, else `MODE_FREE`.

`C.GAME_MODES = (MODE_STORY, MODE_FREE) = ("story", "free")` (`config.py:208-210`). TS:
`core/save.ts:104` exports `GAME_MODES`; `config.ts:150-151` exports `MODE_STORY` / `MODE_FREE`.

#### `_derive()` (330-342)

```
level       = get_level(level_index)
final       = level_index >= LEVEL_COUNT - 1          # LEVEL_COUNT = 12 -> final iff index 11
next_index  = level_index if final else level_index + 1
star_targets = _read_targets(level)
par         = max(1, int(star_targets[0]))
```
On exception: `final=False`, `next_index=level_index`, `star_targets=(1,2,3)`, `par=1`.

Note `final` and `next_index` are **recomputed, never read from the dict**, even though
`_finish` writes `final_level` and `next_index` into it (`gameplay.py:1137-1138`). The screen
is authoritative about campaign position; the dict's copies are dead weight here.

#### `_read_targets(level)` (344-364)

1. If `_result_level == level_index` (no kwarg override happened), take `result["star_targets"]`,
   coerce the first three entries with `int()`, and accept them **only if** `len == 3 and
   vals[0] > 0 and vals[0] <= vals[1] <= vals[2]`.
2. Otherwise `D.apply_star_targets(self.diff, level.star_targets())`.
3. Otherwise `(1, 2, 3)`.

TS: `applyStarTargets(diff, targets)` (`core/difficulty.ts:452`) and `level.starTargets`
(a precomputed property, `core/level.ts` — **not** a method; integration.md §11).

#### Mode / story helpers

| Helper | Lines | Behaviour |
|---|---|---|
| `is_story` (property) | 367-370 | `mode == C.MODE_STORY` |
| `_beat_seen(index)` | 372-377 | `bool(game.save.beat_seen(int(index)))`, `False` on any exception. TS `save.beatSeen(i)` (`save.ts:920`) |
| `_mark_beat(index)` | 379-389 | coerce to int; only calls `game.save.mark_beat_seen(idx)` when `0 <= idx <= _MAX_BEAT` (= 11). TS `save.markBeatSeen(i)` (`save.ts:930`) |
| `_flush_save()` | 391-396 | `game.save.flush()`, swallowing a read-only/missing save file. TS `save.flush()` (`save.ts:655`) |

All three are used only by `VictoryScene`'s story hand-off (§8), but they live on the base.

---

### 6.7 Layout the base owns

Coordinates are design pixels in the 1280x720 box. `draw_text`'s `pos[1]` is always the **top**
edge of the glyph box; `pos[0]` is the left / centre / right edge per `align` (ui.py:268-290).

#### 6.7.1 Full-screen layers (base `draw`, 598-610)

| Element | Rect | Notes |
|---|---|---|
| background | `make_background(theme.bg_style, theme, (0, 0, 1280, 720))` | built in `_ensure_background` (477-478); fills the **design box** in Python |
| background fallback | `surface.fill(theme.bg_bottom)` | when `_bg is None` (603) |
| veil | whole surface, `with_alpha(shade(theme.bg_bottom, 0.6), clamp(veil_alpha, 0, 255))` | `_draw_veil` (612-622); alpha 168 game over / 112 victory |
| particles | whole surface | `game.particles.draw` (605) — **below** the body panel, so confetti behind the semi-transparent panel shows through faintly |
| body | subclass `_draw_body` (606) | §7 / §8 |
| buttons | each `button.draw(surface, theme, game.fonts, game.time)` (607-608) | **unscaled `game.time`** |

**Port decision:** background and veil should fill `viewport.overscan`, not the design box
(web-port-conventions: backgrounds fill overscan, gameplay stays in the design box). A veil
sized to 1280x720 would leave un-dimmed background bars on a 19.5:9 phone while the background
itself extended past them. Rebuild both on `onResize`.

#### 6.7.2 Shared drawing helpers — exact geometry

`_draw_stat_row(surface, x_label, x_value, y, label, value, *, value_color=None, dim=None)`
(625-635) — one `LABEL ......... value` line:

| Part | x | y | anchor | font | colour |
|---|---|---|---|---|---|
| label | `x_label` | `y + 4` | left | `fonts.small` (17) | `dim` if given else `theme.text_dim` |
| value | `x_value` | `y - 3` | right | `fonts.h2` (30, bold) | `value_color` if given else `theme.text` |

The label is `label.upper()`. The 7 px stagger (`+4` vs `-3`) is what optically baselines a
17 px label against a 30 px value. Only `GameOverScene` calls it (gameover.py:811-824).

`_draw_difficulty_badge(surface, cx, cy, *, muted=False)` (661-672):

```
color = _diff_color()
if muted: color = _mute(color, 0.30, 0.90)
font  = game.fonts.small            # None on any failure -> _draw_badge returns an empty rect
_draw_badge(surface, cx, cy, _diff_label(), color, font, glow = 0.16 if muted else 0.34)
```

`_diff_color()` (637-649): `result["difficulty_color"]`, each channel `int(...) & 0xFF`; else
`diff.color`; else `P.UI_WHITE`.
`_diff_label()` (651-659): `result["difficulty_label"]` or `result["difficulty_name"]` if a
non-blank `str`, `.strip().upper()`; else `str(diff.hud_label).upper()`; else `"NORMAL"`.

`_draw_par_line(surface, cx, y)` (674-686):

| Part | Value |
|---|---|
| `delta` | `int(self.score) - int(self.par)` |
| text | `"{} PAR {:,}   ({})".format(_diff_label(), int(par), _fmt_delta(delta))` — **three spaces** before the parenthesis, e.g. `NORMAL PAR 140   (+165)` |
| colour | `P.UI_GOOD` when `delta >= 0`, else `lerp_color(theme.text_dim, P.UI_WARN, 0.45)` |
| font / anchor | `fonts.small`, `(cx, y)`, `align="center"` |

Note the par line does **not** count up: it always shows the final score's delta, from t = 0,
while the score row above it is still rolling. Verified in both captures (the par line is
legible in a frame where the score has settled, and the source has no `counted()` call here).

`P.UI_GOOD = (86, 240, 160)` / `P.UI_WARN = (255, 196, 72)` — both exported by
`core/palette.ts:291,293` as `UI_GOOD` / `UI_WARN`. Do not retype the triples.

`_chapter_line()` (688-699):

```
base = "LEVEL {:02d}".format(level_index + 1)        # "LEVEL 01" .. "LEVEL 12"
if not is_story: return base
roman = str(result["chapter_roman"] or "").strip()  or  str(S.get_chapter(level_index).roman)
return "CHAPTER {}   -   {}".format(roman, base)     # three spaces, hyphen, three spaces
```
Exception → `base`. TS: `chapter.roman` is a **method**, `getChapter(i).roman()`
(`core/story.ts:88`; integration.md §11 flags the shim).

#### 6.7.3 `_row(specs, y, width, gap=24)` — the button row layout (452-461)

```
total = width * len(specs) + gap * (len(specs) - 1)
x     = (C.WINDOW_W - total) * 0.5                       # 1280
Button((x + i * (width + gap), y, width, BUTTON_H), label, style=style, data=action)
```
`y` is the row's **top** edge; every button is `BUTTON_H = 58` tall. Empty `specs` → `[]`.

Concrete rows (informative cross-reference — §7 and §8 are authoritative for their own
screens; the arithmetic below is the base's and is what the captures confirm):

| Screen | Condition | specs (label, style, data) | y | width | gap | total | x0 | button x's |
|---|---|---|---|---|---|---|---|---|
| game over | story (727-729) | RETRY LEVEL/primary/retry, ABANDON RUN/ghost/menu | 604 | 300 | 36 | 636 | 322 | 322, 658 |
| game over | free (730-733) | RETRY/primary/retry, LEVEL SELECT/ghost/levels, MENU/ghost/menu | 604 | 268 | 26 | 856 | 212 | 212, 506, 800 |
| victory | story + final (897-899) | CONTINUE/primary/story, MENU/ghost/menu | 618 | 300 | 36 | 636 | 322 | 322, 658 |
| victory | story (900-903) | CONTINUE/primary/story, REPLAY/ghost/retry, MENU/ghost/menu | 618 | 268 | 26 | 856 | 212 | 212, 506, 800 |
| victory | free, not final (905-911) | NEXT LEVEL/primary/next, REPLAY/ghost/retry, LEVEL SELECT/ghost/levels, MENU/ghost/menu | 618 | 248 | 22 | 1058 | 111 | 111, 381, 651, 921 |
| victory | free + final (905-911) | REPLAY/**primary**/retry, LEVEL SELECT/ghost/levels, MENU/ghost/menu | 618 | 268 | 22 | 848 | 216 | 216, 506, 796 |
| any | `on_enter` failed (426-427) | MENU/ghost/menu | 620 | 300 | — | — | **490** (hard-coded rect `(490, 620, 300, 58)`, not `_row`) | 490 |

The width switch in `VictoryScene._build_buttons` is `width=248 if len(specs) == 4 else 268`
(line 911) with `gap=22` in both cases — hence the final-level free-play row at 268/22, which
is *not* the 268/26 the game-over row uses. Transcribe both.

---

### 6.8 The staged reveal — the whole timeline

One clock drives everything: `self.t`, seconds since `on_enter`, advanced by **real dt clamped
to `C.MAX_DT = 0.05`** in `update` (585-586). Nothing on these screens is scaled by
`fx.time_scale()` — they are shell-level screens (integration.md §10) and a slow-mo left over
from the killing blow must not stretch the summary. `game.time` (unscaled, monotonic since
boot) is used *only* for the breathing/shimmer terms, never for the reveal.

#### 6.8.1 The count-up

```
count_frac() = ease_out_cubic( clamp((t - COUNT_DELAY) / COUNT_TIME, 0, 1) )       # 485-487
             = ease_out_cubic( clamp((t - 0.30) / 1.05, 0, 1) )
counted(v)   = int( float(v) * count_frac() + 0.0001 )                              # 489-491
```

`ease_out_cubic(u) = (u-1)^3 + 1` (`contracts.py:193-196`; TS `easeOutCubic`,
`core/mathx.ts:53`). `counted` **truncates** after adding a 1e-4 epsilon — an odometer, not a
rounder: at `count_frac() = 1.0` and `value = 486` it yields exactly 486; at 0.5 it yields 243
(not 243.0 rounded up). Port with `Math.trunc(v * countFrac() + 0.0001)`.

| Moment | `t` | Derivation |
|---|---|---|
| first frame drawn, everything zero | `0.000` | see §6.5 |
| count-up starts | `0.300` | `COUNT_DELAY` |
| count-up 50 % of the *eased* value | `0.517` | `u` s.t. `easeOutCubic(u)=0.5` → `u = 1 - 0.5^(1/3) = 0.20630`; `t = 0.30 + 0.20630*1.05 = 0.51661` |
| count-up 90 % | `0.863` | `u = 1 - 0.1^(1/3) = 0.53584`; `t = 0.30 + 0.53584*1.05 = 0.86263` |
| `count_frac() >= 0.999` (the NEW BEST ping gate) | `1.245` | `(1-u)^3 <= 0.001` → `u >= 0.9` → `t >= 0.30 + 0.9*1.05` |
| count-up complete | `1.350` | `COUNT_DELAY + COUNT_TIME` |

#### 6.8.2 The full reveal schedule

Rows marked *(subclass)* are triggered by `GameOverScene`/`VictoryScene` but timed entirely by
the base's constants and `self.t`.

| # | Stage | Starts at `t` | Duration | Easing / formula | Reveals |
|---|---|---|---|---|---|
| 0 | panel, heading, chapter line, level name, difficulty badge | `0.000` | — | none — full opacity from frame 1 | static chrome |
| 1 | entry sting *(subclass `_on_ready`)* | `0.000` | — | — | game over: `audio("die")`, `fx.flash(shade(hazard, 0.7), 0.35)`, `fx.shake(5.0)` (739-741). victory: `audio("win")`, `fx.flash(accent, 0.45)`, `_firework(640, 250, 1.15)` (925-928) |
| 2 | confetti shower *(victory)* | `0.000` | `2.600` s | `_confetti -= dt`; `_confetti_acc += dt * 90.0`, one particle per whole unit | 90 confetti/s (1047-1064) |
| 3 | ember fall *(game over)* | `0.000` | forever | `_ember_acc += dt * 13.0` | ~13 embers/s (746-766) |
| 4 | count-up hold | `0.000` → `0.300` | `0.300` s | `count_frac() == 0` | every rolling number reads `0` / `0:00` |
| 5 | count-up | `0.300` → `1.350` | `1.050` s | `easeOutCubic` | score, food eaten, best combo, time survived (game over); score, campaign star tally (victory) |
| 6 | star 0 pop *(victory)* | `0.850` | `0.550` s | `scale = 0.25 + 0.75*easeOutBack(pop)`, `rot = (1-pop)*1.4` rad | first earned star; `audio("bonus")`, `fx.shake(2.0)`, ring + burst |
| 7 | star 1 pop *(victory)* | `1.400` | `0.550` s | ditto | second star; `audio("bonus")`, `fx.shake(3.5)` |
| 8 | star 2 pop *(victory)* | `1.950` | `0.550` s | ditto | third star; `audio("levelup")`, `fx.shake(5.0)` |
| 9 | NEW BEST ping *(game over)* | `1.245` | one-shot | gate `new_best and not _best_ping and count_frac() >= 0.999` | `audio("bonus")` + gold ring at `(640, 250)` (767-772) |
| 10 | NEW BEST badge swell *(game over)* | `1.350` → `1.800` | `0.450` s | `pop = clamp((t - 1.35)/0.45, 0, 1)`; `scale = 0.7 + 0.3*easeOutBack(pop)` | gold `NEW BEST` plate (846-861) |
| 11 | late fireworks *(victory)* | `2.600` (when `_confetti` hits 0) → `6.000` | until `t >= 6.0` | per frame, `random() < dt * 1.4` (≈ 2.3 %/frame at 60 fps ⇒ ~1.4 bursts/s) | `_firework(uniform(220, 1060), uniform(140, 420), 0.7)` (1067-1069) |
| 12 | steady state | `2.500` (victory) / `1.800` (game over) | forever | only `game.time`-driven shimmer remains | — |

Everything reachable by input is reachable from `t = 0`: **no button is disabled or delayed**
and no key is gated on the reveal. A player who mashes Enter at `t = 0.1` skips the whole
ceremony, which is deliberate.

`ease_out_back(t)` (`contracts.py:207-211`): `c1 = 1.70158`, `c3 = 2.70158`, `f = t - 1`,
`1 + c3*f^3 + c1*f^2` — overshoots past 1 before settling. TS `easeOutBack`
(`core/mathx.ts:65`). `pulse(t, speed) = 0.5 + 0.5*sin(t*speed)` (`contracts.py:214-216`;
TS `pulse`, `core/mathx.ts:74`).

Star-pop detail (`VictoryScene._draw_stars`, 1166-1184; timed by base constants):

```
for i in 0..2:
    x = _star_x[i]  (else 640.0)
    earned = i < stars
    if not earned or t < STAR_FIRST + i*STAR_GAP:
        _draw_star(x, _star_y, 40.0 * 0.86, shade(theme.text_dim, 0.85), filled=False)
        continue
    age   = t - (STAR_FIRST + i*STAR_GAP)
    pop   = clamp(age / STAR_POP, 0, 1)
    scale = 0.25 + 0.75*ease_out_back(pop)   if pop < 1.0 else 1.0
    spin  = (1.0 - pop) * 1.4                                   # radians, unwinds to 0
    glow  = 0.45 + 0.8*(1.0 - pop) + 0.18*pulse(t*1.0 + i, 2.4)  # note: `t` here is game.time
    _draw_star(x, _star_y, 40.0*scale, P.UI_GOLD, filled=True, glow=glow, rot=spin)
```

The `if pop < 1.0 else 1.0` branch matters: `easeOutBack(1.0) = 1.0` exactly, so the branch is
numerically redundant — port it or drop it, but do not "fix" it into a different curve. The
breathing glow term uses **`game.time`** (`t = self.game.time`, line 1168) offset per star by
`+ i`, so the three stars breathe out of phase and keep breathing forever.

---

### 6.9 The stat rows and the `last_result` contract

#### 6.9.1 Rows drawn on the game-over screen (`_draw_body`, 806-824)

`x_label = 372.0`, `x_value = 908.0`, first `y = 294.0`, `pitch = 44.0`.

| # | y | label (drawn `.upper()`) | value expression | value colour |
|---|---|---|---|---|
| 1 | 294 | `Score` | `"{:,}".format(counted(score))` | `lerp_color(UI_WHITE, UI_GOLD, 0.45)` (810) |
| 2 | 338 | `Food eaten` | `"{} / {}".format(counted(food_eaten), goal_food)` — goal does **not** count up | `theme.text` (default) |
| 3 | 382 | `Best combo` | `"x{}".format(max(1, counted(max_combo)) if max_combo else 1)` | `theme.text` |
| 4 | 426 | `Time survived` | `_fmt_time(elapsed * count_frac())` | `theme.text` |

Every label uses `dim=theme.text_dim` explicitly (811-824). Row 3's conditional binds the
whole `max(1, counted(max_combo))` — i.e. a run with `max_combo == 0` shows `x1` immediately,
and a run with a real combo shows at least `x1` while counting.

Then, still `GameOverScene` but using base helpers:

| Element | Geometry | Source |
|---|---|---|
| hairline rule | `line(with_alpha(theme.grid, 200), (372, rule_y), (908, rule_y))` where `rule_y = 294 + 44*4 + 6 = 476` | 826-829 |
| par line | `_draw_par_line(cx=640, y=488)` (`rule_y + 12.0`) | 831 |
| NEW BEST plate *or* level best | `_draw_new_best(640, 520)` (`rule_y + 44.0`) if `new_best`, else `draw_text("LEVEL BEST  {:,}".format(max(best, score)), fonts.small, theme.text_dim, (640, 522), align="center")` (`rule_y + 46.0`) — note the **two spaces** and the different y | 833-844 |

`best = int(game.save.best_for(level_index, diff.key))`, `0` on failure (836-841). TS
`save.bestFor(levelIndex, diffKey)` (`save.ts:676`).

#### 6.9.2 The victory footer (`_draw_body`, 1120-1138) — for contrast

Not stat rows: one centred `fonts.small` line joined with **five spaces**,
`"     ".join(bits)` (1132), at `(640, foot_y + 4)`:

```
"FOOD {} / {}".format(counted(food_eaten), goal_food)
"COMBO x{}".format(max(1, max_combo))          # NOT counted -- shows final value from t=0
"TIME {}".format(_fmt_time(elapsed))            # NOT counted
+ "LIVES LOST {}".format(deaths)                # appended only when deaths != 0
```

So the same three stats roll up on the game-over screen and appear instantly on the victory
screen. That asymmetry is intentional (the victory screen's rolling number is the big score),
and it is the kind of thing a port "tidies up" by accident.

#### 6.9.3 Every `game.last_result` key this file reads

Producer: `gameplay.py::_finish` (1115-1151) — cross-checked against integration.md §6.1.

| Key | Read at | Used for | Default when absent |
|---|---|---|---|
| `level_index` | 280 | level identity, theme, background, par | `game.level_index`, clamped 0..11 |
| `level_name` | 285-286 | subtitle | `get_level(i).name` |
| `score` | 287 | score row, par delta | `0` |
| `goal_food` | 288 | `food / goal` | `level.goal_food` |
| `food_eaten` | 289 | `food / goal` | `0` |
| `stars` | 290 | the star ceremony | `0` |
| `max_combo` | 291 | best-combo row / footer | `0` |
| `deaths` | 292 | victory footer `LIVES LOST` | `0` |
| `elapsed` | 293 | time row / footer | `0.0` |
| `new_best` | 294 | NEW BEST plate + ping | `False` |
| `mode` | 315-319 | button row, story routing, chapter line | falls through to `story`, then `MODE_FREE` |
| `story` | 320-322 | mode fallback | — |
| `difficulty` | 298 | `diff` lookup (par, save keys, tally) | `game.difficulty` |
| `difficulty_color` | 639 | badge colour | `diff.color` → `UI_WHITE` |
| `difficulty_label` | 653 | badge text, par label | `difficulty_name` → `diff.hud_label` → `"NORMAL"` |
| `difficulty_name` | 653 | ditto (second choice) | — |
| `star_targets` | 355 | par (`star_targets[0]`) | `apply_star_targets(diff, level.star_targets())` |
| `chapter_roman` | 694 | `CHAPTER {roman}` line (story only) | `S.get_chapter(i).roman` |

**Written by `_finish` but never read here:** `won`, `crossings`, `next_index`, `final_level`,
`beat_title`, `beat_speaker`, `chapter_end`, `chapter`, `chapter_title`, `story_complete`.
`won` is encoded by which scene key was switched to; `next_index`/`final_level` are recomputed
(§6.6); the beat/chapter text is re-fetched from `core/story` by `VictoryScene._story_cards`
(932-972) rather than read from the dict. A TS `LastResult` type should still declare them —
the producer writes them and integration.md §6.1 pins them — but the result scenes must not
depend on them.

Every key is optional by construction (module docstring, 14-17): a missing or empty dict
degrades to a zeroed summary, never an exception, "because a crash on the results screen would
throw away the run the player just finished". Keep that property in TS: the parse must be a
total function over `Record<string, unknown>`.

---

### 6.10 The star award — where it is computed, and where it is not

The count is **not** computed here. `GameplayScene._stars()` decides it at `_finish`
(integration.md §6.1: `stars = won ? (score >= t3 ? 3 : score >= t2 ? 2 : 1) : 0` against the
difficulty-scaled `star_targets`), writes it into `last_result["stars"]`, and this file only
clamps it (`int(clamp(num("stars"), 0, 3))`, line 290) and animates it. Consequences:

* `GameOverScene` always receives `stars == 0` (a loss cannot award stars) and draws no stars
  at all — the game-over screen has no star row.
* `par` here is `star_targets[0]`, the **one-star** threshold (337), and it is the number the
  par line compares against. `star_targets[1]`/`[2]` are parsed and stored but never drawn.
* `save.record(...)` was already called by `_finish`; the result screens never award, unlock or
  re-record anything. The only save writes on these screens are the story bookkeeping in
  §6.13.

Per-star ceremony (`VictoryScene._emit`, 1025-1044), timed by the base constants:

```
want = 0
for i in range(stars):
    if t >= STAR_FIRST + i*STAR_GAP: want = i + 1
while _stars_shown < want:
    idx = _stars_shown;  _stars_shown += 1
    x   = _star_x[idx]  (else 640.0)
    col = P.UI_GOLD                                  if idx < 2 else
          lerp_color(P.UI_GOLD, P.UI_WHITE, 0.4)     # the third star's fx are whiter
    particles.ring (x, _star_y, col, radius=90.0, count=22, life=0.6, speed=180.0)
    particles.burst(x, _star_y, col, count=22, speed=(60.0, 240.0), life=(0.4, 0.9))
    audio.play("levelup" if idx >= 2 else "bonus")
    fx.shake(2.0 + 1.5*idx)                          # 2.0, 3.5, 5.0
```

The `while` loop is a catch-up: a frame long enough to cross two thresholds pops both in the
same frame (all their particles and both sounds at once). Keep the loop — an `if` would lose a
star after a stall.

`_star_y = 292.0` and `_star_x = [640 - 118, 640, 640 + 118] = [522.0, 640.0, 758.0]`
(921-923), re-asserted every frame at 1105.

---

### 6.11 `update(dt)` (583-596)

Order of operations, exactly:

```
1  dt = clamp(float(dt), 0.0, C.MAX_DT)              # 585   -> 0.05 s ceiling
2  self.t += dt                                       # 586   REAL dt (see below)
3  if _bg is not None: _bg.update(dt)                 # 587-588  REAL dt
4  mouse = getattr(game, "mouse_pos", (0.0, 0.0))     # 589
5  for button in buttons:                             # 590-593
       button.update(dt, mouse)                       #        REAL dt
       if button.just_entered: audio.play("hover", 0.6)
6  self._emit(dt)                                     # 594   subclass emission, REAL dt
```

The whole body is inside one `try/except: pass` (584, 595-596).

| Consumer | dt | Why |
|---|---|---|
| `self.t` | **real** | The reveal is UI, not simulation. A `fx.slowmo` still running from the killing blow (gameplay's `fx.slowmo(0.35, 0.45)` on the fatal hit, integration.md §E9) must not stretch the count-up. |
| `_bg.update` | **real** | Note the divergence from `GameplayScene`, which feeds the background `sdt` (integration.md §5.3). Here the backdrop scrolls at wall-clock rate. |
| `button.update` | **real** | Hover/press easing is `1 - exp(-13*dt)` / `1 - exp(-22*dt)` (ui.py:507-510); ui.md owns it. Buttons also clamp dt internally to 0.1. |
| `_emit` | **real** | Ember/confetti/firework rates (13/s, 90/s, 1.4/s) and `_confetti -= dt` are all wall-clock. |
| `game.time` | **real**, shell-owned (`main.py:402`) | Every `pulse(t, ...)` shimmer term and `button.draw`'s idle shimmer. |

`self.t` is *not* the same as wall-clock time after a stall: dt is clamped at 0.05, so a 200 ms
hitch advances `t` by 0.05. The reveal slows, it never skips — which is why every stage is
expressed as a function of `t` and not of a deadline.

`game.mouse_pos` → `game.pointer.x/.y` in TS (integration.md §11). `Button.update` wants a
`(x, y)` pair.

---

### 6.12 `draw()` (598-610) — layer order, top of the list painted first

| # | Layer | Extent | Call |
|---|---|---|---|
| 1 | background | design box in Python, **overscan in the port** | `_bg.draw(surface)` (601-602), else `surface.fill(theme.bg_bottom)` (603) |
| 2 | veil | whole surface / overscan | `_draw_veil` (604) — `with_alpha(shade(theme.bg_bottom, 0.6), veil_alpha)`, skipped entirely when `veil_alpha <= 0` (615-616) |
| 3 | particles | whole surface, **unclipped** (no arena mask here, unlike gameplay) | `game.particles.draw(surface)` (605) |
| 4 | body | subclass; both screens open with a `draw_panel` | `_draw_body(surface)` (606) |
| 5 | buttons | below the panel in both screens | `button.draw(surface, theme, game.fonts, game.time)` (607-608) |
| — | cursor + post-processing | shell-level, above every scene | `main.py:427-431` |

Because particles are layer 3 and the panel is layer 4 with `alpha=196` (game over) /
`alpha=190` (victory), confetti and embers behind the panel show through it, dimmed. The
captures confirm this: the background's line traces are clearly visible through both panels.

Pixi layout: one child `Container` per row of that table under `scene.root`, created in the
constructor and never reordered. `game.particles` has `attachTo(parent, index?)`
(`gfx/particles.ts:615`) for slotting the particle layer in at index 2.

Background style used: whatever the theme says — `theme.bg_style` (472), so the game-over
screen reuses the level's own background *style* with the muted palette (`_mute_theme` keeps
`bg_style`). The cache key is `(bg_style, theme.name)` (474), and `_mute_theme` keeps `name`
too, so a muted background is cached under the unmuted level's name; harmless because
`GameOverScene` always mutes and never shares its `_bg` with `VictoryScene` (separate cached
scene instances).

TS: `makeBackground(style, theme, rect, renderer)` (`gfx/bg/index.ts:81`) takes a fourth
`renderer` argument, and `background.update(dt, focus?)` takes an optional focus point that
these screens have no use for. Per gfx-port-decisions, `Background.build()` must never run in
a constructor — `makeBackground` handles `init()`.

---

### 6.13 Input and transitions

#### 6.13.1 Mouse

`handle_event` (547-557), in order:

1. For each button, `button.handle_event(event)`; on the first that returns `True`:
   `audio.play("click")`, `_act(button.data)`, **return** (so a click never also reaches the
   key handler).
2. Else, if `event.type == pygame.KEYDOWN`, `_handle_key(event)`.

`Button.handle_event` (ui.py:469-490) — recorded here only as the trigger contract, ui.md owns
it: `MOUSEMOTION` updates `hovered`; `MOUSEBUTTONDOWN` **button 1** inside the rect arms;
`MOUSEBUTTONUP` **button 1** inside the rect while armed and `_cool <= 0` fires exactly once
and starts a `C.UI_CLICK_COOLDOWN` debounce. Dragging off cancels. Nothing on these screens is
held, and there is no right-button or wheel binding.

Hover sound is emitted from `update`, not from the event (592-593): `audio.play("hover", 0.6)`
when `button.just_entered`.

#### 6.13.2 Keyboard (`_handle_key`, 559-581) — all edge-triggered on KEYDOWN

`available = _actions()` = `{button.data for button in buttons if button.enabled and
isinstance(button.data, str)}` (538-544). `fire(action)` is a no-op when the action is not in
that set, so **every key is strictly a mirror of an on-screen button**.

| Key(s) | Action | Present on |
|---|---|---|
| `K_ESCAPE` | `"menu"` | every row on both screens |
| `K_l` | `"levels"` | free-play game over; free-play victory (final and non-final). **Dead in story mode** — neither story row carries a LEVEL SELECT button |
| `K_r` | `"retry"` | both game-over rows; both non-final victory rows; the free-play final victory row. **Dead on the story + final victory row** (CONTINUE + MENU only, 897-899) |
| `K_RETURN`, `K_KP_ENTER`, `K_SPACE` | the **first `enabled` button in `self.buttons`** — `retry` on both game-over rows, `next` on free-play non-final victory, `retry` on free-play final victory, `story` on both story victory rows | both |

The Enter branch (575-581) does not consult `_actions()`: it walks `self.buttons` and fires the
first `enabled` one whatever its `data` is (including a callable). There is no key for
`"next"` or `"story"` other than Enter/Space.

Not bound anywhere on these screens: `K_p`, arrow keys, `K_TAB`, gamepad. `F11` / `Alt+Enter`
are swallowed by the shell before any scene sees them (`main.py:357-364`) — note that
`Alt+Enter` is consumed by the fullscreen toggle and therefore never reaches the primary-action
branch.

#### 6.13.3 Transition table (`_act`, 511-532)

`_go(name, **kwargs)` (494-509) calls `game.switch_scene(name, **kwargs)` and, on `TypeError`,
retries `game.switch_scene(name)` — a tolerance for scenes whose `on_enter` takes no kwargs.
In TS `onEnter(args?)` always accepts an object, so the retry is dead code: **do not port the
TypeError fallback**, just pass the args.

| Trigger | `data` | Verb | Target | Args | `game.*` written on the way out |
|---|---|---|---|---|---|
| RETRY / RETRY LEVEL / REPLAY button; `R` key; Enter (game over) | `"retry"` | `switch_scene` | `C.SCENE_GAME` | `level_index=self.level_index` | `game.level_index = self.level_index` (519) |
| NEXT LEVEL button; Enter (free-play victory, not final) | `"next"` | `switch_scene` | `C.SCENE_GAME` | `level_index=nxt` where `nxt = int(clamp(next_index, 0, LEVEL_COUNT-1))` | `game.level_index = nxt` (523) |
| CONTINUE button; Enter (story victory) | `"story"` | → `_story_continue()` | see below | — | see below |
| LEVEL SELECT button; `L` key | `"levels"` | `switch_scene` | `C.SCENE_LEVELS` | none | none |
| MENU / ABANDON RUN button; `Esc` key | `"menu"` | `switch_scene` | `C.SCENE_MENU` | none | none |
| any `callable` `data` | — | the callable is invoked; no scene change implied (513-515) | — | — | unused by both subclasses |
| unknown string | — | nothing happens (no `else`) | — | — | — |

`_story_continue` on the **base** (534-536) is `self._go(C.SCENE_MENU)` — a deliberate no-op
fallback so a `"story"` action on any non-victory result screen still escapes. `VictoryScene`
overrides it (974-1000) and is the only place `C.SCENE_STORY` is reached from here; §8 owns the
card stack, but the base-owned session writes on that path are:

| Path | Writes |
|---|---|
| story victory, `final` | `save.set_story_complete(True)`; `_flush_save()`; `switch_scene(SCENE_STORY, cards=..., next_scene=SCENE_MENU, next_kwargs={}, theme=self.theme)` |
| story victory, not final | `save.set_story_progress(nxt)`; `_flush_save()`; `game.level_index = nxt`; `switch_scene(SCENE_STORY, cards=..., next_scene=SCENE_GAME, next_kwargs={"level_index": nxt}, theme=P.theme_for_level(nxt))` |
| both | `_mark_beat(level_index)` and `_mark_beat(next_index)` inside `_story_cards` (949, 971) |

**Never written by either result screen:** `game.mode` and `game.difficulty`. A story run that
dies and takes ABANDON RUN leaves `game.mode == "story"`, so the menu still shows the campaign
as the active mode; that is the shipped behaviour.

`game.level_index` is *also* written on the way **in** (line 410), before anything is drawn, so
any scene later reached without an explicit `level_index` still sees the level that was just
played.

---

### 6.14 Audio cues, fx and particles

Every call the base itself makes, plus the subclass calls it schedules. Cue names cross-checked
against `web/src/data/audio.json` `names[]` — **all present**, nothing to flag.

| Trigger | Call | Line | In audio.json? |
|---|---|---|---|
| button click completed (mouse) | `game.audio.play("click")` | 551 | ✅ |
| any key that fires an available action | `game.audio.play("click")` | 566 | ✅ |
| Enter/Space firing the primary button | `game.audio.play("click")` | 579 | ✅ |
| `button.just_entered` (hover enter), per button, per frame edge | `game.audio.play("hover", 0.6)` — second arg is a volume scale | 593 | ✅ |
| `on_enter` | `game.fx.set_theme(self.theme)` | 415 | — |
| `on_enter` | `game.particles.clear()` | 420 | — |
| `on_exit` | `game.particles.clear()` | 431 | — |
| game over `_on_ready` | `audio.play("die")`; `fx.flash(P.shade(theme.hazard, 0.7), 0.35)`; `fx.shake(5.0)` | 739-741 | ✅ `die` |
| game over embers, ~13/s | `particles.spawn(uniform(-20, 1300), uniform(-40, -4), vx=uniform(-9, 9), vy=uniform(14, 34), radius=uniform(1.8, 3.6), color=shade(lerp_color(hazard, accent, random()*0.6), 0.85), life=uniform(4.5, 8.5), drag=0.12, gravity=5.0, shrink=False, kind="ember" if random() < 0.55 else "dot", spin=uniform(-1.2, 1.2))` | 752-766 | — |
| game over NEW BEST ping, once, at `t >= 1.245` | `audio.play("bonus")`; `particles.ring(640.0, 250.0, P.UI_GOLD, radius=120.0, count=30, life=0.8, speed=190.0)` | 768-772 | ✅ `bonus` |
| victory `_on_ready` | `audio.play("win")`; `fx.flash(theme.accent, 0.45)`; `_firework(640.0, 250.0, 1.15)` | 925-928 | ✅ `win` |
| victory `_firework(x, y, power)` | `particles.ring(x, y, theme.accent, radius=110*power, count=28, life=0.7, speed=200*power)`; then 3x `particles.burst(x, y, cols[(i+1) % 4], count=int(20*power), speed=(90, 320*power), life=(0.5, 1.2), radius=(2.0, 5.0))` where `cols = (accent, accent2, food, UI_GOLD)` | 1007-1021 | — |
| victory star pop, per star | `particles.ring(...radius=90, count=22, life=0.6, speed=180)`; `particles.burst(...count=22, speed=(60, 240), life=(0.4, 0.9))`; `audio.play("levelup" if idx >= 2 else "bonus")`; `fx.shake(2.0 + 1.5*idx)` | 1035-1043 | ✅ `levelup`, `bonus` |
| victory confetti, 90/s for 2.6 s | `particles.spawn(uniform(0, 1280), uniform(-60, -6), vx=uniform(-70, 70), vy=uniform(30, 120), radius=uniform(2.0, 4.6), color=choice(cols), life=uniform(1.6, 3.2), drag=0.5, gravity=95.0, shrink=False, kind="shard" if random() < 0.45 else "dot", spin=uniform(-6.0, 6.0))` | 1053-1064 | — |
| victory late firework, `t < 6.0`, `random() < dt*1.4` | `_firework(uniform(220.0, 1060.0), uniform(140.0, 420.0), 0.7)` | 1067-1069 | — |

Cue-name set for this file: `click`, `hover`, `die`, `bonus`, `win`, `levelup` — a subset of
`audio.json`'s twelve. **No `fx.slowmo` anywhere on these screens** (unlike gameplay), and no
`particles.trail` / `particles.ambient`.

TS shapes: `ScreenFx.setTheme/shake/flash/slowmo/timeScale/beginTransition`
(`gfx/post/ScreenFx.ts:268,281,332,370,382,397`), reached as `game.post.fx.*` (the pattern
`GameplayScene.ts:315-332` already uses). `ParticleSystem.spawn(x, y, SpawnOptions)` /
`ring(x, y, color, RingOptions)` / `burst(x, y, color, BurstOptions)` /
`clear()` (`gfx/particles.ts:705,854,773,603`) — every named argument above exists on those
option interfaces (`vx, vy, radius, color, life, drag, gravity, shrink, spin, kind`;
`radius, count, life, speed`). `Audio.play(name, volume?)` on the injected `Audio` instance.

---

### 6.15 Data dependencies and TS coverage

| Needs | Python | TS today | Status |
|---|---|---|---|
| level record | `get_level(i)`, `LEVEL_COUNT`, `level.name`, `level.goal_food`, `level.theme`, `level.star_targets()` | `getLevel(i)`, `LEVEL_COUNT`, `.name`, `.goalFood`, `.theme`, `.starTargets` (**property, not a method**) | ✅ `core/level.ts` |
| difficulty | `D.get_difficulty(key)`, `D.apply_star_targets(diff, targets)`, `diff.key`, `diff.color`, `diff.hud_label` | `getDifficulty`, `applyStarTargets`, `.key`, `.color`, `.hudLabel` | ✅ `core/difficulty.ts:258,452,53-104` |
| save reads | `save.beat_seen(i)`, `save.best_for(i, diffKey)`, `save.total_stars(diffKey?)`, `save.max_stars()` | `beatSeen`, `bestFor`, `totalStars`, `maxStars` | ✅ `core/save.ts:920,676,703,717` |
| save writes | `save.mark_beat_seen(i)`, `save.set_story_progress(i)`, `save.set_story_complete(True)`, `save.flush()` | `markBeatSeen`, `setStoryProgress`, `setStoryComplete`, `flush` | ✅ `core/save.ts:930,901,911,655` |
| story | `S.get_beat(i)`, `S.get_chapter(i)`, `S.chapter_start(i)`, `S.EPILOGUE`, `S.StoryCard(title=, lines=, speaker=)` | `getBeat`, `getChapter`, `chapterStart`, `EPILOGUE`, `StoryCard` interface (`{title, lines, speaker}`) | ✅ `core/story.ts:268,279,307,223,60`. **Shim:** `chapter.roman` is a property in Python, a **method** `roman()` in TS (`story.ts:88`) |
| colours | `P.THEMES[0]`, `P.UI_WHITE/UI_DIM/UI_GOOD/UI_WARN/UI_GOLD`, `P.lerp_color`, `P.shade`, `P.with_alpha`, `P.theme_for_level(i)` | `THEMES`, `UI_WHITE/UI_DIM/UI_GOOD/UI_WARN/UI_GOLD`, `lerpColor`, `shade`, `withAlpha`, `themeForLevel` | ✅ `core/palette.ts:255,287-297,36,46,51,261` |
| maths | `clamp`, `ease_out_cubic`, `ease_out_back`, `pulse`, `TAU` | `clamp`, `easeOutCubic`, `easeOutBack`, `pulse`, `TAU` | ✅ `core/mathx.ts:12,53,65,74,10` |
| constants | `C.WINDOW_W/H`, `C.MAX_DT`, `C.UI_BUTTON_H`, `C.MODE_STORY/MODE_FREE`, `C.SCENE_*` | `C.WINDOW_W/H`, `C.MAX_DT`, `C.UI_BUTTON_H`, `C.MODE_STORY/MODE_FREE`, `SCENES.*` | ✅ `core/config.ts:52-56,144,150-151`; `app/Scene.ts:65-76` |
| shell | `game.level_index/mode/difficulty/last_result`, `switch_scene`, `game.time`, `game.particles`, `game.fx`, `game.mouse_pos` | `levelIndex/mode/difficulty/lastResult`, `switchScene`, `time`, `particles`, `post.fx`, `pointer` | ✅ `app/Game.ts:74-84,184,59,62` |
| background | `make_background(style, theme, rect)` → `.update(dt)` / `.draw()` | `makeBackground(style, theme, rect, renderer)` → `.update(dt, focus?)`, a display object | ✅ `gfx/bg/index.ts:81` (arity differs) |
| particles | `spawn/ring/burst/clear/draw` | `spawn/ring/burst/clear/attachTo` | ✅ `gfx/particles.ts` |
| fx | `fx.set_theme/flash/shake` | `setTheme/flash/shake` | ✅ `gfx/post/ScreenFx.ts` |
| audio | `game.audio.play(name, vol?)` | `Audio.play` — injected per scene, **not on `Game`** (`main.ts:48,54`) | ✅ (constructor injection) |
| `C.GAME_MODES` | `config.py:210` | `GAME_MODES` lives in **`core/save.ts:104`**, not `config.ts` | ✅ but note the odd home |

#### Not yet in the TS core — flag list

1. **`FontBook` / `game.fonts`.** `_ResultScene` needs `fonts.small` (17) and `fonts.h2` (30
   bold); the two subclasses additionally need `tiny` (14), `body` (21), `huge` (96 display),
   `title` (64 display) and `display_at(n)` for arbitrary sizes (`38*scale` on the NEW BEST
   plate, `58` for the victory score). Owned by `docs/port/ui.md`; nothing exists in `web/src`
   yet. `display_at(max(12, int(38*scale)))` (gameover.py:856) rasterises a *new size every
   frame* during the 0.45 s swell — in Pixi that is one `Text` with `container.scale`, not a
   font lookup.
2. **`muteTheme` must rebuild `theme.hex`** — see §6.2.2. This is the one place the TS `Theme`
   shape actively fights the Python `dataclasses.replace`.
3. **`SaveData` is not on `Game`.** `main.ts:41-54` injects `save` and `sound` into scene
   constructors. The result scenes must follow that, which also means `main.ts` has to
   register them: `game.registerScene("gameover", (g) => new GameOverScene(g, save, sound))`
   and the same for `"victory"`.
4. **No comma-grouping helper exists.** Four call sites need `{:,}` semantics (§6.2.4); the
   naive `toLocaleString()` is locale-dependent. Add `fmtThousands` next to `fmtTime`.
5. **`draw_glow_circle` has no shared TS entry point.** `stampGlow` is a module-private
   function in `gfx/SnakeRenderer.ts:204`. `_draw_star`, `_draw_badge` and both subclass
   headings need it (nine call sites across the file). Either export it from a shared
   `gfx/glow.ts` or accept a duplicated helper — the renderer phase should decide once.
6. **`switch_scene` extra kwargs.** The story hand-off passes `cards`, `next_scene`,
   `next_kwargs`, `theme` (984-1000). `SceneEnterArgs` is `{[key: string]: unknown}`
   (`app/Scene.ts:14-16`), so this types fine, but `StoryScene` must accept exactly those four
   names — the story-scene section owns that contract.

---

### 6.16 Capture cross-check

Read as images: `E:/SnakeGame/captures/10-gameover.png`, `E:/SnakeGame/captures/11-victory.png`
(1280x720 each).

`10-gameover.png` — everything on screen accounted for:

| Measured | Source | ✔ |
|---|---|---|
| panel ≈ x 300..980, y 88..568 | `draw_panel(surface, (300, 88, 680, 480), theme, alpha=196, glow=0.20)` (783) | ✔ |
| `GAME OVER` centred, top ≈ 106, huge display face, pale pink | `fonts.huge`, `lerp_color(UI_WHITE, theme.hazard, 0.35)`, `(640, 106)` (793-795) | ✔ |
| `LEVEL 04` tiny, top ≈ 206 | `head_y + 100 = 206`, `fonts.tiny`, `shade(theme.accent2, 1.0)` (797-798) | ✔ |
| `SOLAR FLARE` body, top ≈ 224 | `head_y + 118 = 224`, `fonts.body`, `theme.text_dim` (799-800) | ✔ |
| `NORMAL` chip centred (640, 272), ≈108x32, cyan-ish outline | `_draw_difficulty_badge(640, 272.0, muted=True)` (804); colour `_mute(diff.color, 0.30, 0.90)` | ✔ |
| four rows, labels left ≈ 372, values right ≈ 908, pitch 44 | `x_label=372, x_value=908, y=294, pitch=44` (807-824) | ✔ |
| `305` gold-ish, `9 / 14`, `x4`, `1:01` | rows 1-4 of §6.9.1, count-up complete | ✔ |
| hairline at y ≈ 477, x 372..908 | `rule_y = 294 + 44*4 + 6 = 476` (827-829) | ✔ |
| `NORMAL PAR 140   (+165)` green, centred, top ≈ 488 | `_draw_par_line(640, 488)`, `UI_GOOD` because delta ≥ 0 (831) | ✔ |
| `LEVEL BEST  305` dim, centred, top ≈ 522 | `rule_y + 46 = 522`, the `not new_best` branch (842-844) | ✔ |
| three buttons, tops ≈ 604, lefts ≈ 212 / 506 / 800, RETRY highlighted | free-play row `_row(..., 604, width=268, gap=26)` (730-733) | ✔ |
| warm sparse motes over a dark, desaturated backdrop with faint line traces | embers (746-766) over `make_background("lava"-family style, muted theme, (0,0,1280,720))` + veil at alpha 168 | ✔ |

`11-victory.png`:

| Measured | Source | ✔ |
|---|---|---|
| panel ≈ x 272..1008, y 66..586, bright orange rim | `draw_panel(surface, (272, 66, 736, 520), theme, alpha=190, glow=0.42)` (1080) | ✔ |
| `LEVEL CLEAR` centred, top ≈ 88, huge, cream | `fonts.huge`, `lerp_color(UI_WHITE, theme.accent, 0.25)`, `(640, 88)` (1093-1095) | ✔ |
| `LEVEL 04  -  SOLAR FLARE` body, top ≈ 188 | `sub_y = head_y + 100 = 188`; `"{}  -  {}"` join (1098-1100) | ✔ |
| `NORMAL` chip centred (640, 236), full-strength colour | `_draw_difficulty_badge(640, 236.0)` — `sub_y + 48`, `muted=False`, `glow=0.34` (1102) | ✔ |
| three filled gold stars, centres ≈ (522, 292), (640, 292), (758, 292), r ≈ 40 | `_star_x = [522, 640, 758]`, `_star_y = 292.0`, `base_r = 40.0` (923, 1105, 1169) | ✔ |
| `486` big cream/gold, top ≈ 352 | `score_y = _star_y + 60 = 352`, `fonts.display_at(58)`, `lerp_color(UI_WHITE, UI_GOLD, 0.5)` (1109-1116) | ✔ |
| `NORMAL PAR 140   (+346)` green, top ≈ 420 | `_draw_par_line(640, score_y + 68 = 420)` (1118) | ✔ |
| `FOOD 14 / 14     COMBO x8     TIME 0:48` dim, top ≈ 454 | `foot_y = score_y + 98 = 450`, drawn at `foot_y + 4 = 454`, five-space join (1121-1133) | ✔ |
| `NEW BEST` gold h2, top ≈ 482 | `foot_y + 32 = 482`, `fonts.h2`, `lerp_color(UI_GOLD, UI_WHITE, 0.3 + 0.3*pulse(game.time, 6.0))` (1135-1138) | ✔ |
| four buttons, tops ≈ 618, lefts ≈ 111 / 381 / 651 / 921 | free-play non-final row `_row(specs, 618, width=248, gap=22)` (911) | ✔ |
| dense multi-coloured confetti (round dots + triangular shards), heavier at the top | `kind="shard"` 45 % / `"dot"` 55 %, colours `(accent, accent2, food, UI_GOLD)`, `gravity=95` (1050-1064) | ✔ |

Unaccounted for on screen (both captures), all shell-level and not this section's business:

* `60.0 fps` top-right — the debug FPS readout drawn by the shell (`fonts.mono_small`,
  `main.py` draw tail), not by any scene.
* The cursor glyph over `RETRY` (10) and `REPLAY` (11) — `ui.draw_cursor(surface, game)`, drawn
  by the shell above every scene (`main.py:427-428`); owned by `docs/port/ui.md`.
* Vignette/grain/bloom and a faint CRT curvature — the shell's post-processing chain
  (`PostChain`), applied after the scene draws.
* The soft warm radial behind each heading is the two stacked `draw_glow_circle` calls in each
  subclass's `_draw_body` (790-792 / 1085-1086), not a background feature.

Nothing on either screen is unexplained by the source.

---

### 6.17 Open questions

1. **Veil extent.** Python fills `surface.get_size()` = the 1280x720 canvas. The port must fill
   `viewport.overscan` or a 19.5:9 phone shows undimmed background bands. Confirm, then make it
   a rule for every menu-style scene (this section assumes overscan).
2. **Background dt.** These screens feed the backdrop **real** dt while `GameplayScene` feeds it
   `sdt`. Intentional (nothing is simulated here) but worth one assertion so a future
   "consistency" refactor does not unify them.
3. **`_draw_badge` glow radius `w * 0.52`** is derived from the *measured text width*, so it
   changes with the label ("EASY" vs "EXPERT") and, in the port, with the web font's metrics.
   If the ported font measures differently from the pygame face, the chip width and its glow
   both shift. ui.md owns the font choice; this section only records the formula.
4. **`switch_scene` transition.** `Game.switchScene` already calls
   `this.post.fx.beginTransition()` (`Game.ts:196`), so the wipe integration.md §2.4 lists as a
   gap is closed. Confirm the result screens want the wipe tinted by the *level* theme
   (`fx.set_theme(self.theme)` at line 415 runs **before** the switch that brought us here has
   finished transitioning, so the incoming wipe is tinted by the muted game-over accent —
   verify against the Python by eye).
5. **Enter and `Alt+Enter`.** The shell consumes `Alt+Enter` for fullscreen, so the primary
   action cannot be fired with Alt held. Harmless in Python; in the browser the fullscreen
   toggle is a different gesture entirely, so decide whether `Alt+Enter` should reach the
   primary button or stay swallowed for symmetry.
## 7. Game over (`GameOverScene`) and 8. Victory (`VictoryScene`)

Both classes live in `snake/scenes/gameover.py` and both subclass `_ResultScene` (same file,
lines 222-699), which **Section 6 specifies in full**: result parsing (`_read_result`,
`_read_mode`, `_derive`, `_read_targets`), the count-up clock (`count_frac` / `counted`), the
button plumbing (`_row`, `_act`, `_actions`, `handle_event`, `_handle_key`), the background
cache (`_ensure_background`), the veil (`_draw_veil`), the shared drawing helpers
(`_draw_stat_row`, `_diff_color`, `_diff_label`, `_draw_difficulty_badge`, `_draw_par_line`,
`_chapter_line`) and the save helpers (`_beat_seen`, `_mark_beat`, `_flush_save`). This section
records **only what the two subclasses override or add**, plus every call site's exact
arguments.

Suggested TS homes:

| Python | TS |
|---|---|
| `_ResultScene` | `web/src/scenes/ResultScene.ts` - `abstract class ResultScene extends Scene` (§6) |
| `GameOverScene` | `web/src/scenes/GameOverScene.ts` - `class GameOverScene extends ResultScene` |
| `VictoryScene` | `web/src/scenes/VictoryScene.ts` - `class VictoryScene extends ResultScene` |
| `_mute` / `_mute_theme` (gameover.py:103-132) | `web/src/scenes/resultTheme.ts` - `mute(rgb, grey, dark)`, `muteTheme(theme)` (needs palette gap **P1**, §7.11) |
| `_star_points` / `_draw_star` (gameover.py:153-182) | `web/src/gfx/ui/ratingStar.ts` - `starPoints(cx, cy, r, rot)`, `class RatingStar` (three persistent `Graphics`, redrawn only when scale/rot/glow change) |

`_fmt_time`, `_fmt_delta`, `_draw_badge` and `_draw_stat_row` are shared by both screens - §6.

### 7.0 Scene-local constants (gameover.py:84-97)

| Constant | Value | Meaning | In `config.json`? |
|---|---|---|---|
| `COUNT_TIME` | `1.05` s | duration of every rolling number | **no** - scene-local |
| `COUNT_DELAY` | `0.30` s | delay before the roll starts | **no** |
| `STAR_FIRST` | `0.85` s | when star 0 pops | **no** |
| `STAR_GAP` | `0.55` s | gap between successive star pops | **no** |
| `STAR_POP` | `0.55` s | one star's pop duration | **no** |
| `BUTTON_H` | `C.UI_BUTTON_H` = `58` | every button's height | **yes** - `config.json:UI_BUTTON_H`, `core/config.ts` `UI_BUTTON_H` |
| `_MAX_BEAT` | `max(0, LEVEL_COUNT - 1)` = `11` | upper bound for `_mark_beat` | derived from `core/level.ts` `LEVEL_COUNT` |
| `C.WINDOW_W` / `C.WINDOW_H` | `1280` / `720` | design box | **yes** - `core/config.ts` |
| `C.MAX_DT` | `0.05` | dt clamp in `update` | **yes** |

`_MAX_BEAT = 11` matters: `mode_select.PROLOGUE_BEAT = 100` (`snake/scenes/mode_select.py:66`)
is parked far above the level beats, and `_ResultScene._mark_beat` (gameover.py:385) refuses
anything outside `0..11`, so the victory hand-off can never stamp the prologue as read.

Declare `COUNT_TIME … STAR_POP` as module constants in `ResultScene.ts` / `VictoryScene.ts`,
exactly as `docs/port/integration.md` §3 does for `READY_TIME`/`GO_TIME`. Do not add them to
`config.json` - they are presentation, not simulation.

---

## 7. Game over - `GameOverScene`

### 7.1 Identity

| | |
|---|---|
| Python class | `GameOverScene(_ResultScene)`, `snake/scenes/gameover.py:705-861` |
| Registered key | `C.SCENE_GAMEOVER = "gameover"` (`snake/config.py:195`); registry entry `C.SCENE_GAMEOVER: ("gameover", "GameOverScene")` (`snake/main.py:38`) |
| `transparent` | `False` (inherited, `snake/core/contracts.py:48`) - opaque, paints its own background |
| `blocks_update` | `True` (inherited, `contracts.py:49`) |
| Entered from | `GameplayScene._finish(won=False)` -> `game.switch_scene(C.SCENE_GAMEOVER)` (`snake/scenes/gameplay.py:1161`). **Nothing else switches or pushes to it.** |
| Can be overlaid by | `SettingsScene`, which accepts `C.SCENE_GAMEOVER` as a legal `back` target (`snake/scenes/settings.py:287`) - but no button on this screen opens settings, so that path is only reachable if a future caller wires it. |
| Exits to | `game` (retry), `levels`, `menu` - always `switch_scene`, never `pop_scene` (§7.7) |

### 7.2 Owned state

Only the fields this subclass adds. Every base field is §6's table.

| Attribute | Type | `__init__` value (line) | `on_enter` reset | Reset by |
|---|---|---|---|---|
| `veil_alpha` | `int` (class attr) | `168` (:708) - overrides base `120` (:232) | n/a (class constant) | - |
| `_ember_acc` | `float` | `0.0` (:712) | `0.0` | `_on_ready` (:736) |
| `_best_ping` | `bool` | `False` (:713) | `False` | `_on_ready` (:737) |

**Everything the subclass owns is reset**, but with one conditional hole inherited from the
base: `_on_ready()` is the *last* statement of `_ResultScene.on_enter` (gameover.py:421) and
sits inside the same `try` as everything before it (:400-422). If `_build_theme()`,
`_build_buttons()` or `game.particles.clear()` raised, `_on_ready` never runs and
`_ember_acc` / `_best_ping` keep the previous run's values. Consequences:

* stale `_best_ping = True` -> the NEW BEST chime and gold ring never fire on the new run;
* the `die` sfx, the hazard flash and the 5 px shake are all skipped.

In practice unreachable (`_build_buttons` here is pure arithmetic and `_build_theme` is
`_mute_theme`, itself fully guarded at :117-132), but **the port must reset these fields in
`onEnter` outside any try/catch**, not in an `onReady` hook that a sibling failure can skip.

### 7.3 Construction vs entry

Built once, in `__init__` (:710-713): `_ember_acc`, `_best_ping` (plus every base field).

Per entry, in base `on_enter` order (:399-428), with the subclass hooks marked:

1. `_read_result()` - parse `game.last_result` (§6).
2. `level_index` kwarg override (never passed by `switch_scene(C.SCENE_GAMEOVER)`; kept for
   cold entry).
3. `game.level_index = self.level_index` - **session state written on entry.**
4. `self.t = 0.0`.
5. `self.theme = self._build_theme()` -> **override**: `_mute_theme(get_level(idx).theme)` (:715-716).
6. `game.fx.set_theme(self.theme)` - the *muted* accent now tints the next transition wipe.
7. `_ensure_background()` - `make_background(theme.bg_style, theme, (0, 0, 1280, 720))`;
   rebuilt only when `theme.bg_style` or `theme.name` changed since the last entry (:464-482).
   **The full design box, not the arena rect** (gameplay passes the arena rect; this scene
   does not).
8. `self.buttons = self._build_buttons()` -> **override** (:718-733). Fresh `Button` objects
   every entry, so hover/press/cooldown state can never leak.
9. `game.particles.clear()`.
10. `_on_ready()` -> **override** (:735-743): resets the two fields, then the entry fx.
    **Order is load-bearing**: `particles.clear()` happens at step 9, so anything `_on_ready`
    emitted would be wiped if a port reordered them. (GameOver emits nothing here, but
    Victory's entry firework depends on this order - §8.3.)

Cached across entries: `_bg` / `_bg_style` / `_bg_theme_name` only.

> **Port hazard (background cache key).** `_mute_theme` is a `dataclasses.replace` (:114-129),
> so the muted theme keeps the *same* `name` and `bg_style` as the level theme (verified:
> level 4's theme is `name="Solar Flare", bg_style="lava"` before and after muting). The cache
> key `(bg_style, theme.name)` is therefore consistent **within** this scene, which always
> mutes - but a port that keys one shared background factory on `theme.name` globally will
> hand the game-over screen the victory screen's full-strength background. Key the results
> background per scene instance, or add the mute flag to the key.

No RNG layout work: ember positions come from the unseeded global `random` module (:754-765).
Cosmetic only - the port may use `Math.random()` or `web/src/gfx/rng.ts`; nothing asserts
determinism (**Q3**).

### 7.4 Layout (design pixels, 1280x720)

`cx = C.WINDOW_W * 0.5 = 640.0` (:781). `t = game.time` - the **unscaled** shell clock (:780).
`draw_text`'s `pos[1]` is always the **top** edge and `align` affects x only
(`snake/gfx/ui.py:268-291`).

Derived anchors: `head_y = 106.0` (:788), `x_label = 372.0`, `x_value = 908.0` (:807),
`y = 294.0`, `pitch = 44.0` (:808-809), `rule_y = y + pitch*4 + 6 = 476.0` (:827).

| # | Element | x | y | size / rect | anchor | font | colour expression | drawn when |
|---|---|---|---|---|---|---|---|---|
| 1 | veil wash | 0 | 0 | full surface | topleft | - | `with_alpha(shade(theme.bg_bottom, 0.6), 168)` | always (:612-622) |
| 2 | panel | 300 | 88 | `680 x 480` (right 980, bottom 568) | topleft | - | `draw_panel(rect, theme, alpha=196, glow=0.20)` (:783) | always |
| 3 | headline glow (wide) | 640 | 152 | `r = 250.0` | centre | - | `draw_glow_circle(cx, head_y+46, 250.0, shade(theme.hazard, 0.85), breathe)` (:790) | always |
| 4 | headline glow (tight) | 640 | 152 | `r = 120.0` | centre | - | `draw_glow_circle(cx, head_y+46, 120.0, theme.hazard, breathe*0.9)` (:792) | always |
| 5 | `"GAME OVER"` | 640 | 106 | - | centre-top | `fonts.huge` (display 96 bold) | `lerp_color(UI_WHITE, theme.hazard, 0.35)` (:793-795) | always |
| 6 | `_chapter_line()` | 640 | 206 | - | centre-top | `fonts.tiny` (14) | `shade(theme.accent2, 1.0)` - identity, `clamp8(c*1.0) == c` (:797-798) | always |
| 7 | `level_name.upper()` | 640 | 224 | - | centre-top | `fonts.body` (21) | `theme.text_dim` (:799-800) | always |
| 8 | difficulty badge | 640 | 272 | chip `w = small.size(label)[0]+40`, `h = small.size(label)[1]+12`, radius `h//2` | **centre** | `fonts.small` (17) | `_draw_difficulty_badge(cx, 272.0, muted=True)` (:804) -> colour `_mute(diff_color, 0.30, 0.90)`, glow `0.16` | always |
| 9 | row 1 label `"SCORE"` | 372 | 298 | - | left-top | `fonts.small` | `theme.text_dim` | always |
| 10 | row 1 value | 908 | 291 | - | **right**-top | `fonts.h2` (30 bold) | `lerp_color(UI_WHITE, UI_GOLD, 0.45)` = `(246, 228, 178)` (:810) | always |
| 11 | row 2 label `"FOOD EATEN"` | 372 | 342 | - | left-top | `fonts.small` | `theme.text_dim` | always |
| 12 | row 2 value | 908 | 335 | - | right-top | `fonts.h2` | `theme.text` (no `value_color`) | always |
| 13 | row 3 label `"BEST COMBO"` | 372 | 386 | - | left-top | `fonts.small` | `theme.text_dim` | always |
| 14 | row 3 value | 908 | 379 | - | right-top | `fonts.h2` | `theme.text` | always |
| 15 | row 4 label `"TIME SURVIVED"` | 372 | 430 | - | left-top | `fonts.small` | `theme.text_dim` | always |
| 16 | row 4 value | 908 | 423 | - | right-top | `fonts.h2` | `theme.text` | always |
| 17 | hairline rule | 372 -> 908 | 476 | 1 px, `pygame.draw.line` default width | - | - | `with_alpha(theme.grid, 200)` (:828-829) | always |
| 18 | par line | 640 | 488 | - | centre-top | `fonts.small` | `_draw_par_line(cx, rule_y+12.0)` -> `UI_GOOD` if `score-par >= 0` else `lerp_color(theme.text_dim, UI_WARN, 0.45)` (:831) | always |
| 19 | NEW BEST glow | 640 | 534 | `r = 150.0 * scale` | centre | - | `draw_glow_circle(cx, cy+14, 150.0*scale, UI_GOLD, glow)` (:855) | `new_best and pop > 0` |
| 20 | `"NEW BEST"` | 640 | 520 | - | centre-top | `fonts.display_at(max(12, int(38*scale)))` -> 26..39 px | `lerp_color(UI_GOLD, UI_WHITE, 0.30 + 0.25*pulse(t, 5.0))` (:857-859) | `new_best and pop > 0` |
| 21 | `"LEVEL BEST  {:,}"` (two spaces) | 640 | 522 | - | centre-top | `fonts.small` | `theme.text_dim` (:842-844) | **not** `new_best` |
| 22 | buttons | see §7.7 | 604 | `w x 58` | topleft | per `Button.style` | `Button.draw(surface, theme, fonts, game.time)` (:608) | always |

Row geometry, expanded from `_draw_stat_row(surface, x_label, x_value, y, label, value, …)`
(:625-635): label at `(x_label, y + 4)` left-aligned in `fonts.small` coloured by the `dim`
argument; value at `(x_value, y - 3)` right-aligned in `fonts.h2` coloured by `value_color`
(falling back to `theme.text`). Every row here passes `dim=theme.text_dim`; only row 1 passes
`value_color`.

Row value strings (`counted(v) = int(v * count_frac() + 0.0001)`, i.e. a floored odometer):

| Row | Label passed | Value expression | Line |
|---|---|---|---|
| 1 | `"Score"` | `"{:,}".format(counted(self.score))` | :811-813 |
| 2 | `"Food eaten"` | `"{} / {}".format(counted(self.food_eaten), self.goal_food)` - goal is **not** counted | :814-817 |
| 3 | `"Best combo"` | `"x{}".format(max(1, counted(self.max_combo)) if self.max_combo else 1)` - reads `x1` while rolling and when `max_combo == 0` | :818-821 |
| 4 | `"Time survived"` | `_fmt_time(self.elapsed * count_frac())` - the *time* is scaled, not the formatted string | :822-824 |

`"LEVEL BEST"` value is `max(best, self.score)` where
`best = int(game.save.best_for(self.level_index, self.diff.key))`, `0` on any exception
(:836-841). It is **not** counted - it appears at full value immediately.

Muted-palette reference values (computed from `snake/palette.py` `THEMES[3]`, "Solar Flare",
`bg_style="lava"`) - use as a port fixture:

| Field | `_mute` args | Full | Muted |
|---|---|---|---|
| `bg_top` | `0.75, 0.62` | `(46, 12, 6)` | `(16, 11, 10)` |
| `bg_bottom` | `0.75, 0.62` | `(16, 4, 4)` | `(5, 3, 3)` |
| `grid` | `0.80, 0.60` | `(112, 40, 18)` | `(41, 33, 30)` |
| `accent` | `0.55, 0.78` | `(255, 158, 44)` | `(163, 129, 89)` |
| `accent2` | `0.60, 0.72` | `(255, 72, 60)` | `(127, 74, 71)` |
| `snake_head` | `0.62, 0.70` (defaults) | `(255, 240, 210)` | `(172, 168, 160)` |
| `snake_a` | defaults | `(255, 196, 72)` | `(154, 137, 105)` |
| `snake_b` | defaults | `(226, 62, 40)` | `(106, 62, 57)` |
| `food` | defaults | `(120, 226, 255)` | `(116, 145, 153)` |
| `hazard` | `0.35, 0.85` | `(255, 48, 32)` | `(172, 58, 49)` |
| `text` | `lerp_color(text, UI_DIM, 0.35)` - **not** `_mute` | `(238, 244, 255)` | `(200, 209, 227)` |
| `text_dim` | `0.5, 0.9` | `(148, 162, 190)` | `(138, 144, 157)` |
| `name`, `bg_style` | untouched by `replace` | `Solar Flare` / `lava` | `Solar Flare` / `lava` |

`_mute(color, grey, dark)` (:103-110):
`lum = int(0.299*r + 0.587*g + 0.114*b)`; return `shade(lerp_color((r,g,b), (lum,lum,lum), grey), dark)`.
Both `int()` and pygame-side channel clamping truncate; TS `clamp8` already truncates
(`web/src/core/palette.ts:30-33`), so use `Math.trunc` for `lum` and the numbers above fall
out bit-identical. On any exception `_mute` returns `(90, 96, 110)` (:108) and `_mute_theme`
returns the theme unchanged (:131-132).

Muted difficulty-badge colours (`_mute(diff.color, 0.30, 0.90)`), all four difficulties:

| Key | `hud_label` | `diff.color` | Muted (game over) |
|---|---|---|---|
| `easy` | EASY | `(86, 240, 160)` | `(103, 200, 150)` |
| `normal` | NORMAL | `(96, 202, 255)` | `(108, 174, 207)` |
| `hard` | HARD | `(255, 168, 72)` | `(209, 154, 94)` |
| `expert` | EXPERT | `(255, 84, 132)` | `(198, 90, 120)` |

### 7.5 `update(dt)`

No override - the base `update` (:583-596) runs verbatim. Order, with the dt each consumer
takes. **This is a shell-level menu scene: every consumer takes real dt.** `fx.time_scale()`
is never read here, so a slow-mo left running by the dying gameplay frame cannot slow the
results screen (`docs/port/integration.md` §10).

1. `dt = clamp(dt, 0.0, C.MAX_DT)` - clamp at `0.05` s (:585).
2. `self.t += dt` - **real dt**. Drives `count_frac`, the NEW BEST pop and the ping gate.
3. `self._bg.update(dt)` if a background exists - **real dt** (:587-588).
4. `mouse = game.mouse_pos`; for each button `button.update(dt, mouse)` - **real dt**; on
   `button.just_entered` -> `audio.play("hover", 0.6)` (:589-593).
5. `self._emit(dt)` -> **override** `GameOverScene._emit` (:746-774), **real dt**.

Timers and curves:

| Quantity | Formula | Line |
|---|---|---|
| `count_frac()` | `ease_out_cubic(clamp((t - 0.30) / 1.05, 0, 1))` | :487 |
| `counted(v)` | `int(v * count_frac() + 0.0001)` | :491 |
| `breathe` (headline glow) | `0.35 + 0.20 * pulse(game.time, 1.4)` -> `0.35..0.55` | :789 |
| NEW BEST `pop` | `clamp((t - 1.35) / 0.45, 0, 1)`, where `1.35 = COUNT_DELAY + COUNT_TIME` | :849 |
| NEW BEST `scale` | `0.7 + 0.3 * ease_out_back(pop)` -> `0.70 .. 1.03` (`ease_out_back` peaks at `1.1001` near `t = 0.58`) | :852 |
| NEW BEST `glow` | `(0.45 + 0.35 * pulse(game.time, 5.0)) * pop` | :854 |
| ember rate | `_ember_acc += dt * 13.0`, one particle per whole unit | :749-752 |
| NEW BEST ping gate | fires once when `new_best and not _best_ping and count_frac() >= 0.999` | :768 |

`count_frac() >= 0.999` resolves to `t >= 0.30 + 0.9*1.05 = 1.245` s (`ease_out_cubic(x) = 0.999`
at `x = 0.9`), so the chime lands **0.105 s before** the badge starts swelling at `t = 1.35`.

`ease_out_cubic`, `ease_out_back`, `pulse`, `clamp`, `TAU` are all in
`web/src/core/mathx.ts` as `easeOutCubic`, `easeOutBack`, `pulse`, `clamp`, `TAU`.

Pixi note: `fonts.display_at(max(12, int(38*scale)))` is a *scaled* headline, not 14 distinct
faces. Render `"NEW BEST"` once into a persistent `Text` at 38 px and set
`text.scale = size / 38` - the Python re-instantiates a font object per frame, which is
exactly the waste the port must not copy.

### 7.6 `draw()`

No override; base `draw` (:598-610). Layer order, back to front - one Pixi child `Container`
each:

| # | Layer | Fills | Notes |
|---|---|---|---|
| 1 | `self._bg.draw(surface)`, else `surface.fill(theme.bg_bottom)` | Python: the whole `1280x720` design box (`make_background(..., (0, 0, C.WINDOW_W, C.WINDOW_H))`, :477-478). Port: **overscan** is allowed and preferred (`viewport.overscan`) - it is pure ambience. Rebuild on `onResize`. | Built from the **muted** theme, which is why the lava backdrop reads brown rather than orange in `captures/10-gameover.png`. |
| 2 | `_draw_veil(surface)` | `surface.get_size()` = the design box. **Decision (Q1):** if layer 1 fills overscan, layer 2 must too, or the un-veiled backdrop shows in the letterbox margin. | flat `with_alpha(shade(theme.bg_bottom, 0.6), 168)`; for the muted level-4 theme that is `(3, 1, 1, 168)`. |
| 3 | `game.particles.draw(surface)` | design box | Embers therefore render **under** the panel and all text. Confirmed by the captures: nothing sits on top of the panel. TS: borrow the shell's layer - `particleLayer.addChild(game.particles.root)` in `onEnter`, remove in `onExit`, exactly as `web/src/scenes/GameplayScene.ts:141-144, 153-155` does. |
| 4 | `_draw_body(surface)` -> override (:777-844) | panel + text, table §7.4 rows 2-21 | |
| 5 | `for button in self.buttons: button.draw(surface, self.theme, self.game.fonts, self.game.time)` | | unclipped - the button glow may bleed past the design box |
| - | cursor, then `fx.present` post-chain | shell (`docs/port/integration.md` §2.2) | not the scene's business |

### 7.7 Input and transitions

No `handle_event` / `_handle_key` override - base only (:547-581). Everything is
**edge-triggered**; this screen has no held input.

| Input | Edge | Path | Result |
|---|---|---|---|
| LMB press+release inside a button (`Button.handle_event`, `snake/gfx/ui.py:469-490`) | up-edge, only if the press armed the same rect and `_cool <= 0` (`C.UI_CLICK_COOLDOWN = 0.1` s) | `audio.play("click")` then `_act(button.data)` (:549-552) | see table below |
| mouse move | per event | `Button.handle_event` sets `hovered` | hover glow |
| `K_ESCAPE` | KEYDOWN | `fire("menu")` (:569-570) | -> `menu` |
| `K_l` | KEYDOWN | `fire("levels")` (:571-572) | -> `levels`; **no-op in story mode** (no LEVEL SELECT button, so `"levels"` is not in `_actions()`) |
| `K_r` | KEYDOWN | `fire("retry")` (:573-574) | -> retry, both modes |
| `K_RETURN`, `K_KP_ENTER`, `K_SPACE` | KEYDOWN | first `enabled` button's `data` (:575-581) | free play -> retry; story -> retry |

`fire(action)` only acts when `action in self._actions()`, and `_actions()` is built from the
enabled buttons' `data` strings (:538-544) - **keyboard is exactly a mirror of what is on
screen**, never a superset. Every key path plays `"click"` first.

Buttons (`_build_buttons`, :718-733), both rows at `y = 604`, `h = 58`:

| Mode | Specs | width | gap | Rects |
|---|---|---|---|---|
| story (`mode == C.MODE_STORY`) | `("RETRY LEVEL","primary","retry")`, `("ABANDON RUN","ghost","menu")` | 300 | 36 | total `636`, `x0 = (1280-636)*0.5 = 322.0` -> `(322,604,300,58)`, `(658,604,300,58)` |
| free play | `("RETRY","primary","retry")`, `("LEVEL SELECT","ghost","levels")`, `("MENU","ghost","menu")` | 268 | 26 | total `856`, `x0 = 212.0` -> `(212,604,268,58)`, `(506,604,268,58)`, `(800,604,268,58)` |
| exception fallback (`on_enter` failed with no buttons) | `Button((490, 620, 300, 58), "MENU", style="ghost", data="menu")` (:426-427) | - | - | single centred ghost at `y = 620` |

Design note transcribed from the docstring (:719-725): a campaign death does **not** offer
LEVEL SELECT, because browsing levels would silently drop the player out of the run.

Transition table:

| Trigger | `_act` key | Verb | Target | Args | `game.*` written |
|---|---|---|---|---|---|
| RETRY / RETRY LEVEL, `R`, `Enter`/`Space` | `"retry"` | `switch_scene` | `C.SCENE_GAME` = `"game"` | `level_index=self.level_index` | `game.level_index = self.level_index` (:519) |
| LEVEL SELECT, `L` (free play only) | `"levels"` | `switch_scene` | `C.SCENE_LEVELS` = `"levels"` | none | none |
| MENU / ABANDON RUN, `Esc` | `"menu"` | `switch_scene` | `C.SCENE_MENU` = `"menu"` | none | none |

`_go` (:494-509) retries the call without kwargs on `TypeError`, so a target whose `on_enter`
takes no arguments still works. Nothing here calls `push_scene` or `pop_scene`.

Session state: `game.level_index` is written on **entry** (`on_enter`, :410) and again on
`"retry"` (:519). `game.mode`, `game.difficulty` and `game.last_result` are **never written**
by this scene. `last_result` is left in place, so a later cold entry re-reads the stale dict -
harmless by design (`_read_mode`, :301-328, degrades a strange dict to free play), but the
port must not assume the dict is consumed.

`on_exit` (:429-433): `game.particles.clear()` only. TS additionally: detach
`game.particles.root`.

### 7.8 Audio cues and fx calls

| Trigger | Call | Args | Line |
|---|---|---|---|
| `_on_ready` (end of every `on_enter`) | `audio.play` | `"die"` | :739 |
| `_on_ready` | `fx.flash` | `shade(theme.hazard, 0.7)` - the **muted** hazard, `(120, 40, 34)` on level 4; amount `0.35` | :740 |
| `_on_ready` | `fx.shake` | `5.0` px | :741 |
| every frame, `13.0` /s | `particles.spawn` | `x = uniform(-20.0, 1300.0)`, `y = uniform(-40.0, -4.0)`, `vx = uniform(-9.0, 9.0)`, `vy = uniform(14.0, 34.0)`, `radius = uniform(1.8, 3.6)`, `color = shade(lerp_color(theme.hazard, theme.accent, random()*0.6), 0.85)`, `life = uniform(4.5, 8.5)`, `drag = 0.12`, `gravity = 5.0`, `shrink = False`, `kind = "ember"` if `random() < 0.55` else `"dot"`, `spin = uniform(-1.2, 1.2)` | :753-766 |
| `new_best and not _best_ping and count_frac() >= 0.999` (once, `t ≈ 1.245` s) | `audio.play` | `"bonus"` | :770 |
| same | `particles.ring` | `x = 640.0` (`C.WINDOW_W*0.5`), `y = 250.0`, `color = UI_GOLD`, `radius = 120.0`, `count = 30`, `life = 0.8`, `speed = 190.0` | :771-772 |
| any button hover enter | `audio.play` | `"hover"`, volume `0.6` | :593 |
| any button click | `audio.play` | `"click"` | :551 |
| any keyboard action | `audio.play` | `"click"` | :567, :578 |

Cue-name cross-check against `web/src/data/audio.json` (`names`: `eat, bonus, powerup, hit,
die, click, hover, start, levelup, win, boost, portal`): `die`, `bonus`, `hover`, `click` all
present, all with recipes; `missingRecipes` is empty. **Nothing to flag.**

TS shapes: `audio.play(name, volume = 1.0)` (`web/src/audio/Audio.ts:318`);
`particles.spawn(x, y, {vx, vy, radius, color, life, drag, gravity, shrink, kind, spin})`
(`web/src/gfx/particles.ts:705`, `SpawnOptions` :400-415 - `"ember"` and `"dot"` are both in
`KINDS`, :81-87); `particles.ring(x, y, color, {radius, count, life, speed})` (:854,
`RingOptions` :445-453); `fx` is `game.post.fx` (`ScreenFx`) with
`flash(color, amount)` (`web/src/gfx/post/ScreenFx.ts:332`), `shake(amount, opts?)` (:281),
`setTheme(theme)` (:268).

There are no `fx.slowmo` and no `particles.burst`/`trail`/`ambient` calls on this screen.

### 7.9 Data dependencies

| Source | Python read | TS equivalent | Status |
|---|---|---|---|
| `game.last_result` | `_read_result` (§6) | `game.lastResult` (`web/src/app/Game.ts:84`) | ✅ |
| `levels.json` | `get_level(idx).theme`, `.name`, `.goal_food`, `.star_targets()` | `getLevel(i).theme` / `.name` / `.goalFood` / `.starTargets` (property, not a method) | ✅ `core/level.ts` |
| `difficulty.json` | `D.get_difficulty(key)`, `diff.key`, `diff.color`, `diff.hud_label`, `D.apply_star_targets(diff, targets)` | `getDifficulty`, `key`, `color`, `hudLabel`, `applyStarTargets` | ✅ `core/difficulty.ts:258, 452` |
| `story.json` | `S.get_chapter(idx).roman` (via `_chapter_line`) | `getChapter(i).roman()` - **a method in TS**, a `@property` in Python (`snake/core/story.py:127-130`) | ⚠ naming shim |
| `SaveData` | `save.best_for(level_index, diff.key)` (:838-839) | `bestFor(levelIndex, difficulty)` (`core/save.ts:676`) | ✅ |
| `config.json` | `C.WINDOW_W/H`, `C.UI_BUTTON_H`, `C.MAX_DT`, `C.UI_CLICK_COOLDOWN` | `WINDOW_W/H`, `UI_BUTTON_H`, `MAX_DT`, `UI_CLICK_COOLDOWN` | ✅ `core/config.ts` |
| `palette` | `UI_WHITE`, `UI_GOLD`, `UI_GOOD`, `UI_WARN`, `UI_DIM`, `lerp_color`, `shade`, `with_alpha` | `UI_WHITE`, `UI_GOLD`, `UI_GOOD`, `UI_WARN`, `UI_DIM`, `lerpColor`, `shade`, `withAlpha` | ✅ `core/palette.ts` |

**This screen writes nothing to `SaveData`** - not `record`, not `unlockThrough`, not
`flush`. Everything was already persisted by `GameplayScene._finish`
(`snake/scenes/gameplay.py:1087-1108`), whose loss branch deliberately skips `record()` and
only lifts `save.highscore` (:1102-1107). A port that "helpfully" calls `record()` here would
unlock the next level on a death.

### 7.10 Capture cross-check - `captures/10-gameover.png`

Measured against §7.4 (free play, level 4 "Solar Flare", NORMAL, score 305, `new_best` false):

| Screen element | Matches spec |
|---|---|
| panel `301..979 x 88..567` | ✅ `(300, 88, 680, 480)` (1 px is the panel border stroke) |
| `GAME OVER`, pale pink-white, red blob visible in the `E`/`O` gap | ✅ `lerp_color(UI_WHITE, hazard, 0.35)` over the 120 px tight glow at `(640, 152)` |
| `LEVEL 04` tiny dim at `y ≈ 212` | ✅ `_chapter_line()` free-play form, top edge 206 |
| `SOLAR FLARE` body at `y ≈ 231` | ✅ top edge 224 |
| NORMAL chip, dimmed cyan, `≈110 x 30`, centred `(640, 273)` | ✅ centre `(640, 272)`; `w = 17px("NORMAL") + 40 ≈ 110`, `h = th + 12 ≈ 30`; rim `(108, 174, 207)` |
| four rows, labels left at `x = 372`, values right-flush at `x = 908` | ✅ rows at `y = 294/338/382/426` |
| `305` gold-cream, `9 / 14`, `x4`, `1:01` white | ✅ row-1 `value_color (246,228,178)`; rows 2-4 `theme.text` muted `(200,209,227)` |
| hairline at `y ≈ 477`, spanning `372..908` | ✅ `rule_y = 476` |
| `NORMAL PAR 140   (+165)` in green | ✅ `_draw_par_line` at 488, `UI_GOOD` because `305 - 140 = +165 >= 0`; three spaces before `(` |
| `LEVEL BEST  305` dim | ✅ `new_best` false branch at `y = 522`, two spaces, value `max(best, score)` |
| RETRY / LEVEL SELECT / MENU at `212 / 506 / 800`, `y ≈ 604` | ✅ free-play row, width 268, gap 26 |
| RETRY drawn brighter and lifted | ✅ `style="primary"` + `Button` hover lift (`_hover_t`), pointer is over it |

Unaccounted for from **this** source, all attributable elsewhere:

* `60.0 fps` top-right - shell debug readout in `snake/main.py` (`fonts.mono_small`), not a scene layer.
* the small orange sunburst over RETRY - the shell's custom cursor (`draw_cursor`, §2.2).
* the brown web of thin polylines and the large soft bokeh discs - the `lava` background style,
  built from the **muted** theme; `docs/port/background-*.md`.
* corner darkening / faint scanlines - the `fx.present` post-chain (vignette, grain, CRT).
* the panel's rounded frosted fill and 12 px corner (`C.UI_CORNER`) - `draw_panel` internals,
  `docs/port/ui.md`.
* the small ember specks - accounted for as the `13/s` spawn stream, drawn beneath the panel.

Nothing on screen is unexplained.

### 7.11 Gaps for the TS port

* **P1 - no way to build a derived `Theme`.** `_mute_theme` is `dataclasses.replace`. The TS
  `Theme` (`core/palette.ts:146-172`) is an interface carrying a **precomputed `hex` mirror**,
  and `buildTheme` is module-private and takes raw snake_case keys. Muting a theme in TS
  therefore needs a new export, e.g.
  `deriveTheme(base: Theme, patch: Partial<Omit<Theme, "hex">>): Theme` that recomputes every
  `hex` field. Without it a port either recomputes `hex` by hand at each call site (and will
  miss one) or renders the muted screen with full-strength packed colours.

---

## 8. Victory - `VictoryScene`

### 8.1 Identity

| | |
|---|---|
| Python class | `VictoryScene(_ResultScene)`, `snake/scenes/gameover.py:867-1184` |
| Registered key | `C.SCENE_VICTORY = "victory"` (`snake/config.py:196`); registry `C.SCENE_VICTORY: ("gameover", "VictoryScene")` (`snake/main.py:39`) - **same module, different class** |
| `transparent` | `False` (inherited) |
| `blocks_update` | `True` (inherited) |
| Entered from | `GameplayScene._finish(won=True)` -> `switch_scene(C.SCENE_VICTORY)` (`gameplay.py:1161`). Nothing else. |
| Exits to | `game`, `levels`, `menu`, **`story`** (the campaign hand-off it owns) |

### 8.2 Owned state

| Attribute | Type | `__init__` value (line) | `on_enter` reset | Reset by |
|---|---|---|---|---|
| `veil_alpha` | `int` (class attr) | `112` (:876) - overrides base `120` | n/a | - |
| `_stars_shown` | `int` | `0` (:880) | `0` | `_on_ready` (:918) |
| `_confetti` | `float` (seconds of shower left) | `0.0` (:881) | `2.6` | `_on_ready` (:919) |
| `_confetti_acc` | `float` | `0.0` (:882) | `0.0` | `_on_ready` (:920) |
| `_star_x` | `List[float]` | `[]` (:883) | `[522.0, 640.0, 758.0]` = `[cx-118, cx, cx+118]` | `_on_ready` (:922-923) |
| `_star_y` | `float` | `292.0` (:884) | `292.0` | `_on_ready` (:921) **and** re-assigned every frame in `_draw_body` (:1105) |

All six are reset. Same conditional hole as §7.2: `_on_ready` is the last statement of the
base `on_enter` try-block, so a failure in `_build_theme`/`_build_buttons`/`particles.clear()`
strands the previous run's `_stars_shown`. The visible symptom is precise and silent: with a
stale `_stars_shown = 3`, `while self._stars_shown < want` (:1030) never runs, so **no star
chime, no shockwave and no shake fire** even though the stars themselves still draw (the draw
path keys off `self.t`, not `_stars_shown`, :1173-1177). Reset in `onEnter` unconditionally.

`self._star_y = 292.0` at :1105 is a redundant duplicate of the `_on_ready` assignment; keep
it out of the port's draw path (nothing reads a different value).

`_draw_stars` and the star-pop emitter both guard `idx < len(self._star_x)` and fall back to
`C.WINDOW_W * 0.5` (:1033, :1171) - defensive only; `_star_x` always has three entries.

`VictoryScene` deliberately has **no `on_enter` override** (comment, :913-915): `final` and
`mode` are resolved by `_read_result`/`_derive` before the base calls `_build_buttons`, so the
button row is already correct.

### 8.3 Construction vs entry

Built once: the six fields above. Per entry, identical to §7.3 except:

* step 5 `_build_theme()` is **not overridden** -> the base returns `get_level(idx).theme`
  **at full strength** (:436-437). This is the whole visual difference in mood.
* step 6 `fx.set_theme(theme)` therefore arms the next transition wipe with the *bright*
  accent.
* step 8 `_build_buttons()` -> §8.7 (four different rows).
* step 10 `_on_ready()` (:917-929) resets the six fields, then plays `"win"`, flashes and
  **emits the entry firework**. `game.particles.clear()` runs at step 9, immediately before -
  reversing those two lines deletes the entry burst. This is the ordering bug the port is most
  likely to introduce.

The confetti/firework/star-pop positions come from the unseeded global `random` module. No
cached surfaces beyond the base's `_bg`.

### 8.4 The three states, and what selects them

Two independent booleans, both resolved in `_read_result`/`_derive` before anything draws:

| Flag | Definition | Line |
|---|---|---|
| `self.final` | `self.level_index >= LEVEL_COUNT - 1`, i.e. `level_index == 11` | :334 |
| `self.is_story` | `self.mode == C.MODE_STORY`, where `mode` comes from `result["mode"]`, else `result["story"]`, else `MODE_FREE` if the dict is non-empty, else `game.mode` | :301-328, :367-370 |
| `self.next_index` | `level_index` if `final` else `level_index + 1` | :335 |

The four combinations, and what each changes:

| State | `final` | `is_story` | Headline | Sub row y | Footer row | Button row | Primary action |
|---|---|---|---|---|---|---|---|
| **A** normal level win (`captures/11-victory.png`) | no | no | `LEVEL CLEAR`, `fonts.huge` | 188 | `FOOD/COMBO/TIME[/LIVES LOST]` | NEXT LEVEL, REPLAY, LEVEL SELECT, MENU | `"next"` |
| **B** story level win (`captures/12-victory-story.png`) | no | yes | `LEVEL CLEAR`, `fonts.huge` | 188 | same as A | CONTINUE, REPLAY, MENU | `"story"` |
| **C** final win, free play (`captures/13-victory-final.png`) | yes | no | `CAMPAIGN COMPLETE`, `fonts.title` | 172 | `TOTAL STARS  {n} / 36` | REPLAY (primary), LEVEL SELECT, MENU | `"retry"` |
| **D** final win, story | yes | yes | `CAMPAIGN COMPLETE`, `fonts.title` | 172 | `{DIFF} STARS  {n} / 36` | CONTINUE, MENU | `"story"` |

`_chapter_line()` (:688-699) adds `CHAPTER {roman}   -   ` (three spaces either side of the
dash) in front of `LEVEL {index+1:02d}` **whenever `is_story`**, using
`result["chapter_roman"]` first and `S.get_chapter(level_index).roman` as fallback. That is
the only sub-row difference between A and B.

State D is the one no capture shows; it is fully determined by the table above plus §8.9.

### 8.5 Layout (design pixels)

`cx = 640.0`, `t = game.time` (unscaled). Derived anchors: `head_y = 88.0` (:1083);
`sub_y = head_y + 84.0 = 172.0` if `final` else `head_y + 100.0 = 188.0` (:1091, :1096);
`_star_y = 292.0` (:1105); `score_y = _star_y + 60.0 = 352.0` (:1109);
`foot_y = score_y + 98.0 = 450.0` (:1121).

| # | Element | x | y | size / rect | anchor | font | colour expression | drawn when |
|---|---|---|---|---|---|---|---|---|
| 1 | veil wash | 0 | 0 | full surface | topleft | - | `with_alpha(shade(theme.bg_bottom, 0.6), 112)` - `(9, 2, 2, 112)` on level 4 | always |
| 2 | panel | 272 | 66 | `736 x 520` (right 1008, bottom 586) | topleft | - | `draw_panel(rect, theme, alpha=190, glow=0.42)` (:1080) | always |
| 3 | headline glow (wide) | 640 | 128 | `r = 260.0` | centre | - | `draw_glow_circle(cx, head_y+40, 260.0, theme.accent, glow*0.8)` (:1085) | always |
| 4 | headline glow (tight) | 640 | 128 | `r = 130.0` | centre | - | `draw_glow_circle(cx, head_y+40, 130.0, theme.accent2, glow*0.7)` (:1086) | always |
| 5 | `"CAMPAIGN COMPLETE"` | 640 | 88 | - | centre-top | `fonts.title` (display 64 bold) | `lerp_color(UI_WHITE, theme.accent, 0.20)` (:1088-1090) | `final` |
| 6 | `"LEVEL CLEAR"` | 640 | 88 | - | centre-top | `fonts.huge` (display 96 bold) | `lerp_color(UI_WHITE, theme.accent, 0.25)` (:1093-1095) | not `final` |
| 7 | sub row `"{_chapter_line()}  -  {level_name.upper()}"` (two spaces each side of the dash) | 640 | `sub_y` (172 / 188) | - | centre-top | `fonts.body` (21) | `theme.text_dim` (:1098-1100) | always |
| 8 | difficulty badge | 640 | `sub_y + 48` (220 / 236) | chip as §7.4 row 8 | centre | `fonts.small` | `_draw_difficulty_badge(cx, sub_y+48.0)` - **`muted=False`**, full `_diff_color()`, glow `0.34` (:1102, :671-672) | always |
| 9 | star slot 0 | 522 | 292 | `r` per §8.6 | centre | - | `UI_GOLD` filled / `shade(theme.text_dim, 0.85)` outline | always |
| 10 | star slot 1 | 640 | 292 | " | centre | - | " | always |
| 11 | star slot 2 | 758 | 292 | " | centre | - | " | always |
| 12 | score glow | 640 | 382 | `r = 170.0` | centre | - | `draw_glow_circle(cx, score_y+30, 170.0, UI_GOLD, 0.20 + 0.35*count_frac())` (:1112-1113) | always |
| 13 | score `"{:,}".format(counted(score))` | 640 | 352 | - | centre-top | `fonts.display_at(58)` | `lerp_color(UI_WHITE, UI_GOLD, 0.5)` = `(247, 227, 169)` (:1114-1116) | always |
| 14 | par line | 640 | 420 | - | centre-top | `fonts.small` | `_draw_par_line(cx, score_y+68.0)`; `UI_GOOD` if `score >= par` else `lerp_color(theme.text_dim, UI_WARN, 0.45)` (:1118) | always |
| 15 | total-stars row | 640 | 450 | - | centre-top | `fonts.h2` (30 bold) | `lerp_color(UI_GOLD, UI_WHITE, 0.25 + 0.2*pulse(t, 3.0))` (:1161-1164) | `final` |
| 16 | footer stats row | 640 | 454 (`foot_y + 4`) | - | centre-top | `fonts.small` | `theme.text_dim` (:1132-1133) | not `final` |
| 17 | `"NEW BEST"` | 640 | 482 (`foot_y + 32`) | - | centre-top | `fonts.h2` | `lerp_color(UI_GOLD, UI_WHITE, 0.3 + 0.3*pulse(t, 6.0))` (:1136-1138) | `new_best` (**in all four states**; on `final` it sits 32 px under row 15) |
| 18 | buttons | §8.7 | 618 | `w x 58` | topleft | per style | `Button.draw(surface, theme, fonts, game.time)` | always |

Footer stats string (:1125-1133), joined by **five spaces**:

```
bits = ["FOOD {} / {}".format(counted(food_eaten), goal_food),
        "COMBO x{}".format(max(1, max_combo)),          # NOT counted - snaps to final value
        "TIME {}".format(_fmt_time(elapsed))]           # NOT counted either
if deaths: bits.append("LIVES LOST {}".format(deaths))  # only when deaths > 0
text = "     ".join(bits)
```

Contrast with §7.4: game over rolls the combo *and* the clock; victory rolls **only** food
and the big score. Do not "unify" them.

Total-stars row (`_draw_total_stars`, :1140-1164), `final` only:

| | `is_story` | free play |
|---|---|---|
| `total` | `int(save.total_stars(self.diff.key))` - the tally **on the difficulty actually played** | `int(save.total_stars())` - the difficulty-agnostic tally |
| `label` | `"{} STARS".format(self._diff_label())` e.g. `NORMAL STARS` | `"TOTAL STARS"` |
| `cap` | `int(save.max_stars())` = `LEVEL_COUNT * 3` = `36` | same |
| exception fallback | `total, cap, label = self.stars, LEVEL_COUNT * 3, "TOTAL STARS"` (:1160) | same |
| string | `"{}  {} / {}".format(label, counted(total), cap)` - **two** spaces after the label; `total` **is** counted | same |

### 8.6 The star ceremony (geometry and schedule)

`_draw_stars` (:1166-1184), `base_r = 40.0`, three slots, `i in 0..2`:

| Condition | Radius | Colour | Fill | Glow | Rotation |
|---|---|---|---|---|---|
| `i >= self.stars` **or** `self.t < STAR_FIRST + i*STAR_GAP` | `base_r * 0.86 = 34.4` | `shade(theme.text_dim, 0.85)` | outline, width `max(1, int(r*0.09))` = `3` | none | `0.0` |
| earned and due | `base_r * scale` | `UI_GOLD` | filled + inner stroke `lerp_color(UI_GOLD, UI_WHITE, 0.55)`, width `max(1, int(r*0.10))` | `draw_glow_circle(x, y, r*1.9, UI_GOLD, glow)` | `spin` |

with `age = self.t - (STAR_FIRST + i*STAR_GAP)`, `pop = clamp(age / STAR_POP, 0, 1)` and

```
scale = 0.25 + 0.75 * ease_out_back(pop)  if pop < 1.0  else 1.0     # :1180
spin  = (1.0 - pop) * 1.4                                           # radians, :1181
glow  = 0.45 + 0.8*(1.0 - pop) + 0.18*pulse(game.time*1.0 + i, 2.4) # :1182
```

Pop times: star 0 at `t = 0.85`, star 1 at `1.40`, star 2 at `1.95`; each pop runs `0.55` s.
An earned-but-not-yet-due star shows as the dim outline, and the outline is **not** drawn
underneath the filled star afterwards. `_draw_star` early-returns when `radius < 3.0` (:171),
which never bites (`0.25 * 40 = 10`).

`_star_points(cx, cy, radius, rot)` (:153-162): ten vertices, `inner = radius * 0.44`,
`r = radius` on even `i`, `inner` on odd; `ang = -pi/2 + rot + i * (TAU/10)`; each point is
`(int(cx + cos(ang)*r), int(cy + sin(ang)*r))` - **truncated to int**, so a Pixi port drawing
in floats will differ by up to 1 px per vertex. Accept it (the settled float-coordinate call
in `docs/port/gfx-port-decisions`) or `Math.trunc` to match exactly; do not blend the two.

Pixi shape: three persistent `Graphics` objects, redrawn only when `scale`, `spin` or the
filled/outline state changes; the breathing `glow` term is a separate additive sprite whose
alpha animates per frame without a redraw.

### 8.7 Buttons

`_build_buttons` (:887-911), all rows at `y = 618`, `h = 58`:

| State | Specs `(label, style, action)` | width | gap | Total | `x0` | Rects |
|---|---|---|---|---|---|---|
| story, `final` (D) | `("CONTINUE","primary","story")`, `("MENU","ghost","menu")` | 300 | 36 | 636 | 322.0 | `(322,618,300,58)`, `(658,618,300,58)` |
| story, not `final` (B) | `("CONTINUE","primary","story")`, `("REPLAY","ghost","retry")`, `("MENU","ghost","menu")` | 268 | 26 | 856 | 212.0 | `(212,…)`, `(506,…)`, `(800,…)` |
| free, not `final` (A) | `("NEXT LEVEL","primary","next")`, `("REPLAY","ghost","retry")`, `("LEVEL SELECT","ghost","levels")`, `("MENU","ghost","menu")` | **248** (4 specs) | 22 | 1058 | 111.0 | `(111,…)`, `(381,…)`, `(651,…)`, `(921,…)` |
| free, `final` (C) | `("REPLAY","primary","retry")`, `("LEVEL SELECT","ghost","levels")`, `("MENU","ghost","menu")` | 268 (3 specs) | 22 | 848 | 216.0 | `(216,…)`, `(506,…)`, `(796,…)` |

Note the width rule (:911): `width = 248 if len(specs) == 4 else 268`, and that REPLAY's style
flips to `"primary"` exactly when `final` (:908) - on the last level there is no NEXT LEVEL to
be the primary, so REPLAY inherits the role. Free-play gap is `22`; the story rows use `26` /
`36`. Transcribe all three gaps; they are not the same number.

### 8.8 `update(dt)`

No override. Base order exactly as §7.5 (real dt throughout, `dt` clamped to `0.05`), with
step 5 dispatching to `VictoryScene._emit` (:1023-1071). `_emit`'s own order:

1. **Star ceremony** (:1026-1044). `want = 0`; for `i in range(self.stars)`: if
   `self.t >= STAR_FIRST + i*STAR_GAP` then `want = i + 1`. Then
   `while self._stars_shown < want:` pop one star (§8.10 for the emissions). The loop can fire
   more than one star in a frame after a stall - keep that (a 0.6 s hitch must not eat a
   chime).
2. **Confetti** (:1047-1064). If `_confetti > 0`: `_confetti = max(0, _confetti - dt)`;
   `_confetti_acc += dt * 90.0`; one particle per whole unit. Runs for the first `2.6` s.
3. **Late fireworks** (:1067-1069, the `elif`, so only once the shower has stopped):
   if `self.t < 6.0 and random.random() < dt * 1.4` -> one `_firework` at
   `x = uniform(220.0, 1060.0)`, `y = uniform(140.0, 420.0)`, `power = 0.7`. Expected rate
   `1.4` /s over `t = 2.6 … 6.0`; after `t = 6.0` the screen emits nothing at all (an
   explicit anti-particle-sink decision, :1065-1066).

Curves used only by this screen:

| Quantity | Formula | Line |
|---|---|---|
| headline glow | `glow = 0.55 + 0.30 * pulse(game.time, 2.0)` -> `0.55..0.85` | :1084 |
| score glow | `0.20 + 0.35 * count_frac()` -> `0.20..0.55` | :1112-1113 |
| `heat` | `= count_frac()` (only feeds the score glow) | :1111 |
| star scale / spin / glow | §8.6 | :1180-1182 |
| total-stars tint | `lerp_color(UI_GOLD, UI_WHITE, 0.25 + 0.2*pulse(game.time, 3.0))` | :1163 |
| NEW BEST tint | `lerp_color(UI_GOLD, UI_WHITE, 0.3 + 0.3*pulse(game.time, 6.0))` | :1137 |

Every `pulse` argument is `game.time`, the never-slowed shell clock, **not** `self.t`. Only
`count_frac`, the star schedule, the confetti window and the `t < 6.0` firework window read
`self.t`.

### 8.9 Input, transitions and the story hand-off

Keyboard is the base's, mirrored to the buttons (§7.7). Per state:

| Key | A (free) | B (story) | C (free final) | D (story final) |
|---|---|---|---|---|
| `Esc` | menu | menu | menu | menu |
| `L` | levels | **no-op** | levels | **no-op** |
| `R` | retry | retry | retry | **no-op** (no REPLAY button) |
| `Enter`/`KP_Enter`/`Space` | `next` | `story` | `retry` | `story` |

Transition table:

| Trigger | `_act` key | Verb | Target | Args | `game.*` written | Line |
|---|---|---|---|---|---|---|
| NEXT LEVEL, `Enter` (A) | `"next"` | `switch_scene` | `"game"` | `level_index = clamp(next_index, 0, 11)` | `game.level_index = nxt` | :521-524 |
| REPLAY, `R` | `"retry"` | `switch_scene` | `"game"` | `level_index = self.level_index` | `game.level_index = self.level_index` | :518-520 |
| LEVEL SELECT, `L` | `"levels"` | `switch_scene` | `"levels"` | none | none | :527-528 |
| MENU, `Esc` | `"menu"` | `switch_scene` | `"menu"` | none | none | :529-530 |
| CONTINUE, `Enter` (B) | `"story"` -> `_story_continue()` | `switch_scene` | `C.SCENE_STORY` = `"story"` | `cards=<stack>`, `next_scene=C.SCENE_GAME`, `next_kwargs={"level_index": nxt}`, `theme=P.theme_for_level(nxt)` | `game.level_index = nxt` (:995) | :974-1000 |
| CONTINUE, `Enter` (D) | `"story"` -> `_story_continue()` | `switch_scene` | `"story"` | `cards=<stack>`, `next_scene=C.SCENE_MENU`, `next_kwargs={}`, `theme=self.theme` (the level-12 theme, **not** `theme_for_level`) | none | :978-986 |

`StoryScene.on_enter(cards=None, next_scene=C.SCENE_MENU, next_kwargs=None, theme=None, **extra)`
(`snake/scenes/story_scene.py:547-549`) is the receiving signature; a bad/empty card list
degrades to an immediate hand-off to `next_scene` (:568-577).

#### The card stack (`_story_cards`, :932-972)

Built **before** any save write, in this exact order. Each step is independently guarded, so a
card that cannot be built simply drops out.

1. `beat = S.get_beat(self.level_index)`; append
   `S.StoryCard(title=beat.title, lines=tuple(beat.outro), speaker=beat.speaker)` - the
   **outro** of the level just cleared (:944-946).
2. `self._mark_beat(self.level_index)` -> `save.mark_beat_seen(level_index)` if
   `0 <= idx <= 11` (:949, :379-389). **Unconditional** - it happens on both the final and
   non-final paths.
3. If `self.final`: append `S.EPILOGUE` (a module-level `StoryCard`,
   `snake/core/story.py:458-466`) and **return** - no chapter plate, no next intro (:951-956).
4. `nxt = self.next_index`. If `S.chapter_start(nxt)` (true when `nxt` is a chapter's
   `first_index`, `story.py:539-547`): append `S.get_chapter(nxt)` - **a `Chapter` object, not
   a `StoryCard`** (:959-962).
5. If `not self._beat_seen(nxt)` (i.e. `save.beat_seen(nxt)` is falsy, and `False` on any
   exception, :372-377): append
   `S.StoryCard(title=beat.title, lines=tuple(beat.intro), speaker=beat.speaker)` for the
   *next* level (:964-970). A replay of an old chapter therefore does not re-tell an intro the
   player has already read.
6. `self._mark_beat(nxt)` - **unconditionally, even when the intro was skipped** (:971).
   Consequence: after one CONTINUE through level *n*, level *n+1*'s intro is marked read, so
   a later replay of level *n* shows only the outro (+ chapter plate). That is intended.

Card-stack sizes: 1 (outro only, intro already seen, mid-chapter), 2 (outro + intro, or outro
+ epilogue on the final), 3 (outro + chapter plate + intro when `nxt` opens a chapter).
`_normalise_cards` caps the deck at 24 (`story_scene.py:318`).

#### Save writes, exact order

The three big ones are **already done** by `GameplayScene._finish` before this scene ever
runs (`snake/scenes/gameplay.py:1087-1108`), and `VictoryScene` never repeats them:

| Order | Call | Args | Where | Condition |
|---|---|---|---|---|
| 1 | `save.record(idx, score, stars, difficulty=diff.key)` | returns `new_best` | `gameplay.py:1093-1094` | win |
| 2 | `save.unlock_through(idx + 1)` | | `gameplay.py:1095` | win |
| 3 | `save.set_story_progress(next_index)` | | `gameplay.py:1099` | win **and** story |
| 4 | `save.set_story_complete(True)` | | `gameplay.py:1101` | win, story, `final` |
| 5 | `save.save()` | | `gameplay.py:1108` | always |

`VictoryScene`'s own writes, and they happen **only when CONTINUE is pressed** - nothing is
written on entry, during the animation, or on REPLAY / NEXT LEVEL / LEVEL SELECT / MENU:

| Order | Call | Args | Line | Condition |
|---|---|---|---|---|
| 1 | `save.mark_beat_seen(level_index)` | current level | :949 (inside `_story_cards`) | always on `"story"` |
| 2 | `save.mark_beat_seen(next_index)` | next level | :971 | only on the **non-final** path (step 3 returns first) |
| 3a | `save.set_story_complete(True)` | | :980 | `final` |
| 3b | `save.set_story_progress(nxt)` | `nxt = clamp(next_index, 0, 11)` | :990 | not `final` |
| 4 | `save.flush()` | via `_flush_save` (:391-396) | :983 / :993 | always on `"story"` - writes only if `dirty` (`snake/core/save.py:534-538`) |
| 5 | `game.level_index = nxt` | | :995 | not `final` |
| 6 | `switch_scene("story", …)` | §8.9 table | :984 / :998 | always |

Three things a port gets wrong silently here:

1. **Cards before saves.** `_story_cards()` is called first (:976) and its step 5 reads
   `_beat_seen(nxt)`; its steps 2/6 then *write* `mark_beat_seen`. Move the writes earlier and
   the next level's intro is suppressed on the very run that should show it.
2. `set_story_progress` is called *again* here even though `_finish` already did it. It is
   idempotent and forward-only (`snake/core/save.py:771`), so keep both calls rather than
   "optimising" one away - `_finish` writes it for the *run*, this writes it for the
   *hand-off*, and cold entries only have the latter.
3. `flush()`, not `save()`. `flush` is a no-op when nothing is dirty and tolerates a
   read-only save file (`_flush_save` swallows) - a results screen must never fail because the
   profile could not be written.

### 8.10 Audio cues and fx calls

`_colors()` (:1003-1005) returns `(theme.accent, theme.accent2, theme.food, UI_GOLD)` - full
strength, since this scene does not mute.

`_firework(x, y, power)` (:1007-1021):

```
particles.ring(x, y, cols[0]=theme.accent, radius=110.0*power, count=28, life=0.7,
               speed=200.0*power)
for i in range(3):
    particles.burst(x, y, cols[(i+1) % 4],           # accent2, food, UI_GOLD
                    count=int(20*power), speed=(90.0, 320.0*power),
                    life=(0.5, 1.2), radius=(2.0, 5.0))
```

Resolved for both powers actually used:

| `power` | ring radius | ring speed | burst count | burst speed |
|---|---|---|---|---|
| `1.15` (entry) | `126.5` | `230.0` | `int(23.0) = 23` | `(90.0, 368.0)` |
| `0.7` (late) | `77.0` | `140.0` | `int(14.0) = 14` | `(90.0, 224.0)` |

Full call table:

| Trigger | Call | Args | Line |
|---|---|---|---|
| `_on_ready` | `audio.play` | `"win"` | :925 |
| `_on_ready` | `fx.flash` | `theme.accent`, amount `0.45` | :926 |
| `_on_ready` | `_firework` | `(640.0, 250.0, 1.15)` - `cx`, `250.0`, power | :927 |
| star `idx` pops (`t >= 0.85 + 0.55*idx`, once each) | `particles.ring` | `x = _star_x[idx]`, `y = _star_y (292.0)`, `color = col`, `radius = 90.0`, `count = 22`, `life = 0.6`, `speed = 180.0` | :1035-1036 |
| same | `particles.burst` | `x, y` as above, `col`, `count = 22`, `speed = (60.0, 240.0)`, `life = (0.4, 0.9)` (radius at emitter default `(2.0, 5.0)`) | :1037-1038 |
| same | `audio.play` | `"levelup"` if `idx >= 2` else `"bonus"` - the third star gets the bigger fanfare | :1040 |
| same | `fx.shake` | `2.0 + 1.5 * idx` -> `2.0`, `3.5`, `5.0` | :1042 |
| confetti, `90.0` /s for the first `2.6` s | `particles.spawn` | `x = uniform(0.0, 1280.0)`, `y = uniform(-60.0, -6.0)`, `vx = uniform(-70.0, 70.0)`, `vy = uniform(30.0, 120.0)`, `radius = uniform(2.0, 4.6)`, `color = random.choice(_colors())`, `life = uniform(1.6, 3.2)`, `drag = 0.5`, `gravity = 95.0`, `shrink = False`, `kind = "shard"` if `random() < 0.45` else `"dot"`, `spin = uniform(-6.0, 6.0)` | :1053-1063 |
| after the shower, while `t < 6.0`, `P(dt*1.4)` per frame | `_firework` | `(uniform(220.0, 1060.0), uniform(140.0, 420.0), 0.7)` | :1067-1069 |
| button hover enter | `audio.play` | `"hover"`, `0.6` | :593 |
| button click / key action | `audio.play` | `"click"` | :551, :567, :578 |

`col` for star `idx` (:1034): `UI_GOLD` when `idx < 2`, else
`lerp_color(UI_GOLD, UI_WHITE, 0.4)` - this affects the **particles only**; the star polygon
itself is always `UI_GOLD` (:1183).

Cue-name cross-check against `web/src/data/audio.json`: `win`, `bonus`, `levelup`, `hover`,
`click` - all five present in `names` and in `recipes`, `missingRecipes` empty. **Nothing to
flag.** There is no `fx.shake` on entry (unlike game over) and no `fx.slowmo` anywhere.

TS shapes: `particles.burst(x, y, color, {count, speed, life, radius})`
(`web/src/gfx/particles.ts:773`, `BurstOptions` :417-431 - `speed`/`life`/`radius` take
`Ranged` tuples exactly as Python does); `"shard"` and `"dot"` are both in `KINDS` (:81-87).

### 8.11 `draw()`

Base `draw` (:598-610), same five layers as §7.6 with `_draw_body` -> `VictoryScene._draw_body`
(:1074-1138) and the veil at `112`. Two consequences worth stating:

* the background is the **full-strength** level theme (`captures/11-victory.png` shows the
  bright lava field, `13-victory-final.png` the prism spokes);
* confetti and fireworks are layer 3, so they draw **behind** the panel (`alpha = 190`, so
  they show through faintly) and behind every text row. Both captures confirm: confetti is
  crisp outside the panel and only ghosted inside it.

### 8.12 Data dependencies

Everything in §7.9, plus:

| Source | Python read | TS equivalent | Status |
|---|---|---|---|
| `story.json` | `S.get_beat(i).title/.intro/.outro/.speaker` | `getBeat(i).title/.intro/.outro/.speaker` (`core/story.ts:268`, `StoryBeat` :33-51) | ✅ |
| `story.json` | `S.StoryCard(title=, lines=, speaker=)` | `StoryCard` is an **`interface`**, not a class (`core/story.ts:60-67`) - build a plain object literal `{ title, lines, speaker }` | ⚠ shape shim |
| `story.json` | `S.chapter_start(nxt)` | `chapterStart(nxt)` (:307) | ✅ |
| `story.json` | `S.get_chapter(nxt)` appended straight into the card list | `getChapter(nxt)` (:279) returns a `ChapterRecord` whose `roman` is a **method** (:105), where Python's is a `@property`. The story scene's normaliser does `_pick(raw, "roman")` (`story_scene.py:284`) and would receive a *function* in TS, silently dropping the chapter numeral from the plate. | ⛔ **gap V1** |
| `story.json` | `S.EPILOGUE` | `EPILOGUE` (`core/story.ts:223`) | ✅ |
| `SaveData` | `save.total_stars(diff.key)` / `save.total_stars()` | `totalStars(difficulty \| null)` (`core/save.ts:703`) | ✅ |
| `SaveData` | `save.max_stars()` | `maxStars()` (:717) = `LEVEL_COUNT * MAX_STARS` = 36 | ✅ |
| `SaveData` | `save.beat_seen(i)` / `save.mark_beat_seen(i)` | `beatSeen(i)` (:920) / `markBeatSeen(i)` (:930) | ✅ |
| `SaveData` | `save.set_story_progress(nxt)` / `set_story_complete(True)` / `flush()` | `setStoryProgress` (:901) / `setStoryComplete` (:911) / `flush()` (:655) | ✅ |
| `palette` | `P.theme_for_level(nxt)` (the theme handed to `StoryScene`) | `themeForLevel(nxt)` (`core/palette.ts:261`) | ✅ |

### 8.13 Capture cross-check

**`captures/11-victory.png`** - state A (free play, level 4, NORMAL, 3 stars, 486, new best):

| Element | Matches spec |
|---|---|
| panel `272..1007 x 66..585` | ✅ `(272, 66, 736, 520)` |
| `LEVEL CLEAR` cream, top `≈ 90` | ✅ `fonts.huge`, `lerp_color(UI_WHITE, accent, 0.25)`, top 88 |
| `LEVEL 04  -  SOLAR FLARE` at `≈ 196` | ✅ `sub_y = 188` (top edge), free-play `_chapter_line()` |
| NORMAL chip centred `≈ (640, 237)` | ✅ `sub_y + 48 = 236`, un-muted `(96, 202, 255)` rim |
| three gold stars centred `≈ 522 / 640 / 758`, `y ≈ 290` | ✅ `_star_x`, `_star_y = 292`, `r = 40` |
| `486` at `≈ 352`, gold-cream | ✅ `display_at(58)`, `(247, 227, 169)` |
| `NORMAL PAR 140   (+346)` green at `≈ 427` | ✅ 420 top, `UI_GOOD` |
| `FOOD 14 / 14     COMBO x8     TIME 0:48` at `≈ 460` | ✅ 454 top, five-space joins, no `LIVES LOST` (deaths == 0) |
| `NEW BEST` gold `fonts.h2` at `≈ 490` | ✅ 482 top |
| 4 buttons at `111 / 381 / 651 / 921`, `y ≈ 620` | ✅ width 248, gap 22, `y = 618` |
| NEXT LEVEL darker-filled, REPLAY ringed | ✅ `primary` vs `ghost`; the pointer sits on REPLAY |

**`captures/12-victory-story.png`** - state B: identical to A except the sub row reads
`CHAPTER II  -  LEVEL 04  -  SOLAR FLARE` (✅ `_chapter_line()` story form concatenated with
`"  -  {name}"`) and the row is CONTINUE / REPLAY / MENU at `212 / 506 / 800` (✅ width 268,
gap 26). Same panel, same stars, same score - confirming that story mode changes *only* the
chapter prefix and the button row.

**`captures/13-victory-final.png`** - state C (free play, level 12 "Prism Core", NORMAL, 980):

| Element | Matches spec |
|---|---|
| `CAMPAIGN COMPLETE`, visibly smaller than `LEVEL CLEAR` | ✅ `fonts.title` (64) not `fonts.huge` (96), `lerp_color(UI_WHITE, accent, 0.20)` |
| `LEVEL 12  -  PRISM CORE` at `≈ 180` | ✅ `sub_y = 172` for `final` |
| chip centred `≈ (640, 221)` | ✅ `sub_y + 48 = 220` |
| stars / score / par unchanged in position | ✅ `292 / 352 / 420` are independent of `final` |
| `TOTAL STARS  17 / 36` in `fonts.h2` gold at `≈ 458` | ✅ `foot_y = 450`, free-play label, two spaces, `cap = 36`; **`TOTAL STARS` (not `NORMAL STARS`) proves `is_story == False`** - so this is state C, and state D is unphotographed |
| `NEW BEST` immediately under it at `≈ 490` | ✅ `foot_y + 32 = 482`; the two h2 rows do coexist |
| REPLAY / LEVEL SELECT / MENU at `216 / 506 / 796` | ✅ 3 specs, width 268, gap 22, `x0 = 216` |
| REPLAY drawn as the bright/filled button | ✅ style flips to `primary` when `final` (:908) |

Unaccounted for in all four captures - all attributable elsewhere: the `60.0 fps` readout
(shell debug), the cursor sprite, the post-chain vignette/bloom/aberration, the background art
itself (`lava` for levels 1-6 region, `prism` for level 12), `draw_panel`'s frosted fill and
rim glow, and `Button`'s hover lift/glow. Nothing on screen is unexplained by this section
plus `ui.md` plus the background specs.

### 8.14 Gaps and open questions

* **V1** - `Chapter.roman` is a method in TS but a property in Python, and `VictoryScene` puts
  a raw `Chapter` into the card stack. Either the story scene's card normaliser must call it,
  or `_story_cards` should hand over `{title: chapter.title, lines: chapter.blurb, roman: chapter.roman()}`.
  Decide in the StoryScene section; flagged here because this scene is the only producer.
* **P1** (§7.11) - `core/palette.ts` cannot build a derived `Theme`; needed by the game-over
  mute. Victory does not need it.
* No `save.record` / `unlockThrough` on either screen - see §8.9. Assert it in review.
