# NEON SERPENT

A mouse-driven arcade snake game built with Python and pygame.

Forget the four arrow keys. Your snake chases the cursor through twelve
hand-tuned neon worlds — steering is analogue, movement is continuous, and the
whole screen glows.

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

| # | Stage | Theme |
| --- | --- | --- |
| 1 | Neon Grid | Wireframe lattice, open arena |
| 2 | Deep Nebula | Drifting starfield |
| 3 | Emerald Circuit | Circuit-trace maze |
| 4 | Solar Flare | Rising heat and embers |
| 5 | Abyssal Tide | Caustic underwater light |
| 6 | Violet Static | Signal noise and interference |
| 7 | Frozen Vault | Ice, drift and low friction |
| 8 | Toxic Bloom | Spreading spores |
| 9 | Crimson Engine | Moving machinery |
| 10 | Aurora Drift | Ribbon curtains of light |
| 11 | Event Horizon | Warped space, portals |
| 12 | Prism Core | Everything at once |

Progress unlocks stage by stage and is saved locally to `savegame.json`.

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
```

---

## License

MIT
