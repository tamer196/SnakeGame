"""
Global configuration and tuning constants for NEON SERPENT.

This module is the single source of truth for every magic number in the game.
Nothing here imports from the rest of the package, so it is always safe to
`from snake import config as C` from anywhere without circular-import risk.
"""

from __future__ import annotations

import os

# --------------------------------------------------------------------------
# Identity
# --------------------------------------------------------------------------
GAME_TITLE = "NEON SERPENT"
GAME_SUBTITLE = "a mouse-driven arcade odyssey"
VERSION = "1.0.0"

# --------------------------------------------------------------------------
# Display
# --------------------------------------------------------------------------
WINDOW_W = 1280
WINDOW_H = 720
WINDOW_SIZE = (WINDOW_W, WINDOW_H)
FPS = 60

# Fixed-timestep clamp: no matter how badly a frame stalls, physics never
# advances more than this in one step (prevents tunnelling through walls).
MAX_DT = 1.0 / 20.0

# The HUD occupies a strip along the top; the arena is everything below it.
HUD_H = 78
ARENA_MARGIN = 14

ARENA_X = ARENA_MARGIN
ARENA_Y = HUD_H
ARENA_W = WINDOW_W - ARENA_MARGIN * 2
ARENA_H = WINDOW_H - HUD_H - ARENA_MARGIN
ARENA_RECT = (ARENA_X, ARENA_Y, ARENA_W, ARENA_H)

# --------------------------------------------------------------------------
# Snake tuning  (continuous "slither" movement, steered by the mouse)
# --------------------------------------------------------------------------
SNAKE_BASE_SPEED = 210.0        # pixels / second at level 1
SNAKE_SPEED_PER_LEVEL = 9.0     # added per level index
SNAKE_MAX_SPEED = 460.0
SNAKE_BOOST_MULT = 1.85         # while holding the right mouse button
SNAKE_BOOST_DRAIN = 46.0        # stamina units / second while boosting
SNAKE_BOOST_REGEN = 26.0        # stamina units / second while not boosting
SNAKE_BOOST_MAX = 100.0
SNAKE_BOOST_MIN_TO_START = 12.0

SNAKE_TURN_RATE = 5.4           # radians / second of maximum steering
SNAKE_TURN_RATE_SLOW = 8.2      # tighter turning when moving slowly

SNAKE_START_LENGTH = 6          # body segments at spawn
SNAKE_SEGMENT_SPACING = 13.0    # pixels of path arc-length between segments
SNAKE_HEAD_RADIUS = 13.0
SNAKE_BODY_RADIUS = 11.0
SNAKE_TAIL_RADIUS = 5.0
SNAKE_GROW_PER_FOOD = 2         # segments gained per ordinary food

# Self-collision is ignored for the first N segments behind the head, so a
# hard turn does not instantly kill the player.
SELF_COLLISION_SKIP = 8

# --------------------------------------------------------------------------
# Mouse steering
# --------------------------------------------------------------------------
# If the cursor is closer than this to the head, the snake keeps its heading
# instead of jittering around the pointer.
MOUSE_DEADZONE = 18.0
CURSOR_TRAIL_LEN = 14

# --------------------------------------------------------------------------
# Food / scoring
# --------------------------------------------------------------------------
FOOD_RADIUS = 9.0
FOOD_PICKUP_PAD = 6.0           # extra forgiveness on the pickup radius
FOOD_PULSE_SPEED = 3.4

SCORE_PER_FOOD = 10
COMBO_WINDOW = 3.0              # seconds to chain a pickup for +combo
COMBO_MAX = 8
COMBO_STEP_BONUS = 5            # extra points per combo step

# --------------------------------------------------------------------------
# Power-ups
# --------------------------------------------------------------------------
POWERUP_RADIUS = 13.0
POWERUP_SPAWN_MIN = 7.0         # seconds
POWERUP_SPAWN_MAX = 14.0
POWERUP_LIFETIME = 11.0         # seconds before it fades away
POWERUP_DEFAULT_DURATION = 7.0

# --------------------------------------------------------------------------
# Lives / damage
# --------------------------------------------------------------------------
START_LIVES = 3
INVULN_AFTER_HIT = 2.2          # seconds of mercy invulnerability
HIT_LENGTH_PENALTY = 4          # segments lost per non-fatal hit

# --------------------------------------------------------------------------
# Particles / effects budgets
# --------------------------------------------------------------------------
MAX_PARTICLES = 1400
TRAIL_EMIT_RATE = 46.0          # particles / second from the snake head
SHAKE_DECAY = 5.5               # screen-shake falloff per second
FLASH_DECAY = 3.2

# --------------------------------------------------------------------------
# UI
# --------------------------------------------------------------------------
UI_CORNER = 12
UI_BUTTON_W = 300
UI_BUTTON_H = 58
UI_CLICK_COOLDOWN = 0.10
TRANSITION_TIME = 0.55          # seconds for a scene transition

# --------------------------------------------------------------------------
# Paths
# --------------------------------------------------------------------------
PKG_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(PKG_DIR)
ASSET_DIR = os.path.join(PKG_DIR, "assets")
SAVE_PATH = os.path.join(ROOT_DIR, "savegame.json")

# --------------------------------------------------------------------------
# Scene names  (keys accepted by Game.switch_scene)
# --------------------------------------------------------------------------
SCENE_MENU = "menu"
SCENE_LEVELS = "levels"
SCENE_GAME = "game"
SCENE_PAUSE = "pause"
SCENE_GAMEOVER = "gameover"
SCENE_VICTORY = "victory"
SCENE_HELP = "help"

# --------------------------------------------------------------------------
# Debug switches
# --------------------------------------------------------------------------
DEBUG_HITBOXES = False
SHOW_FPS = True
