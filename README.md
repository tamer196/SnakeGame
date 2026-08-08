# NEON SERPENT

A mouse-driven arcade snake game built with Python and pygame.

Forget the four arrow keys. Your snake chases the cursor through twelve
hand-tuned neon worlds — steering is analogue, movement is continuous, and the
whole screen glows.

![The title screen](docs/media/menu.png)

<p align="center">
  <img src="docs/media/abyssal-tide.png" width="49%" alt="Abyssal Tide" />
  <img src="docs/media/prism-core.png" width="49%" alt="Prism Core" />
  <img src="docs/media/level-select.png" width="49%" alt="Level select" />
</p>

---

## Play

```bash
pip install -r requirements.txt
python run_game.py
```

Requires Python 3.9+ and pygame 2.5+.

---

## Controls

The entire game is playable with the mouse alone.

| Input | Action |
| --- | --- |
| **Move mouse** | Steer the snake — the head turns toward the cursor |
| **Hold right button** | Boost (burns stamina, regenerates when released) |
| **Left click** | Menus, buttons, level select, confirmations |
| **`Esc` / `P`** | Pause (keyboard shortcut only; pause is also a HUD button) |

Steering is rate-limited, so the snake banks into turns instead of snapping.
Park the cursor on the head and it holds its line.

---

## Levels

Twelve stages, each with its own palette, animated background, hazard set and
clear condition. Difficulty ramps through speed, arena geometry and the kind of
thing trying to kill you.

| # | Stage | Orbs | What it teaches you |
| --- | --- | --- | --- |
| 1 | **Neon Grid** — *First light on the lattice* | 8 | Steering and boost. The edges wrap, so nothing can kill you yet |
| 2 | **Deep Nebula** — *Monoliths adrift in the dust* | 10 | Solid walls: clip one and it costs a life |
| 3 | **Emerald Circuit** — *Trace the living board* | 12 | A cross splits the field into four cells. Use the hub |
| 4 | **Solar Flare** — *Coronal lanes, timed to burn* | 14 | Sweeping bars. Cross behind them, never ahead |
| 5 | **Abyssal Tide** — *Something moves in the trench* | 16 | Tidal columns rise and fall; slip past the open end |
| 6 | **Violet Static** — *Signal lost, teeth found* | 18 | Spinners — the hub kills too, so never cut a corner tight |
| 7 | **Frozen Vault** — *Sealed, but not empty* | 20 | Four gates in, spinners patrolling every approach |
| 8 | **Toxic Bloom** — *The garden inhales* | 22 | Pulsars only bite while swollen. Move on the exhale |
| 9 | **Crimson Engine** — *The machine wants feeding* | 24 | Laser gates. The warning ray is your cue |
| 10 | **Aurora Drift** — *Ribbons over a quiet sea* | 26 | Portals are safe: enter one, leave its twin still moving |
| 11 | **Event Horizon** — *The last light bends inward* | 28 | A diagonal gauntlet; portals are the only shortcut |
| 12 | **Prism Core** — *Everything, refracted* | 30 | Every hazard at once, inside a laser cage |

Each stage introduces exactly one new threat and gives you a hint naming it.
Cruise speed ramps from 210 to 525 px/s across the campaign.

Clearing a level awards up to three stars on score, unlocks the next one, and
saves to `savegame.json` beside the launcher.

---

## Features

- **Continuous slither movement** — a path-following body, not a grid of squares
- **Neon rendering** — additive glow, gradient bodies, bloom and vignette
- **Particle systems** — head trails, pickup bursts, ambient motes, death sprays
- **Animated backgrounds** — a distinct procedural style per stage
- **Screen feedback** — shake, flash, chromatic aberration on impact
- **Power-ups** — magnet, shield, slow-motion, score multiplier and more
- **Combo scoring** — chain pickups inside the combo window for escalating bonuses
- **Stamina-gated boost** — speed costs something
- **No external assets** — every visual and sound is generated procedurally at runtime

---

## Project layout

```
run_game.py           launcher
snake/
  config.py           all tuning constants
  palette.py          colour system and the twelve level themes
  main.py             window, main loop, scene manager
  core/               snake, food, power-ups, obstacles, levels, audio, save
  gfx/                particles, backgrounds, post effects, renderer, UI
  scenes/             menu, level select, gameplay, pause, game over, victory
tools/                headless test and capture scripts
```

Scenes never touch the display surface. They draw onto an offscreen canvas that
the effect stack composites onto the screen, applying shake, chromatic
aberration, flash, vignette and transitions in one pass — which is what makes
those effects global rather than per-scene.

---

## Development

Everything runs without a display, so the game is testable in CI.

```bash
python tools/smoke_modules.py   # ~150 assertions across every module
python tools/playtest.py        # drives the game like a player, 101 checks
python tools/screenshot.py      # renders every scene and level to captures/
```

`playtest.py` is the interesting one: it clicks through the menus, pilots the
snake at the nearest orb until level 1 is cleared, verifies stars and unlocks
reached the save file, forces a death, and sweeps all twelve levels. It also
watches four invariants — non-finite positions, leaked clip rects, anything
painting over the HUD, and exceptions swallowed by a scene's frame guard — and
proves each detector works by deliberately breaking it for one frame.

Frame budget at 1280×720 is 16.6 ms; the worst level measures ~9 ms p95.

---

## License

MIT
