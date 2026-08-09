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
# WINDOW_W/H are the *virtual canvas*: the fixed resolution every scene, HUD
# and level layout is authored against.  The real window can be any size or
# fullscreen; main.py scales the finished canvas to fit and letterboxes the
# remainder, then maps physical mouse coordinates back into canvas space.
# Nothing outside main.py needs to know the window is not 1280x720.
WINDOW_W = 1280
WINDOW_H = 720
WINDOW_SIZE = (WINDOW_W, WINDOW_H)
CANVAS_SIZE = WINDOW_SIZE
CANVAS_ASPECT = WINDOW_W / WINDOW_H
FPS = 60

# Display modes, cycled by the settings screen and by F11 / Alt+Enter.
DISPLAY_WINDOWED = "windowed"
DISPLAY_BORDERLESS = "borderless"
DISPLAY_FULLSCREEN = "fullscreen"
DISPLAY_MODES = (DISPLAY_WINDOWED, DISPLAY_BORDERLESS, DISPLAY_FULLSCREEN)
DISPLAY_MODE_LABELS = {
    DISPLAY_WINDOWED: "WINDOWED",
    DISPLAY_BORDERLESS: "BORDERLESS",
    DISPLAY_FULLSCREEN: "FULLSCREEN",
}
DEFAULT_DISPLAY_MODE = DISPLAY_WINDOWED

# The window is freely resizable; below this it stops scaling down.
MIN_WINDOW_W = 800
MIN_WINDOW_H = 450

# Colour of the letterbox bars when the window aspect differs from 16:9.
LETTERBOX_COLOR = (0, 0, 0)

# Integer-scale snapping: when the window is close to an exact multiple of the
# canvas, snap to it so the pixel grid stays crisp.
INTEGER_SCALE_SNAP = 0.06

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

# Steering.
#
# A fixed angular rate is the wrong model: turn radius is v / omega, so a
# constant omega means the faster you go the wider you turn, and by level 12
# (525 px/s) a U-turn swept a ~194 px circle.  Instead we hold the *radius*
# constant and derive omega from the current speed, so a hairpin feels the
# same at every speed and the snake can double back on its own line.
SNAKE_MIN_TURN_RADIUS = 20.0    # px - the tightest arc the snake can carve
# rad/s ceiling, so a crawling snake does not pivot on the spot.  It also
# decides where the constant-radius model stops holding: above
# CAP * MIN_TURN_RADIUS px/s the radius starts growing again.  At 16.0 that
# knee sat at 320 px/s, which was fine for the normal campaign (level 12
# hairpins at 66 px) but not for EXPERT, whose 1.30x speed and 0.90x turn_mult
# pushed levels 10-12 to 80-95 px - back into "steering a bus" territory, the
# exact problem this rework exists to kill.  20.0 moves the knee to 400 px/s
# and brings the worst case in the game (expert, level 12) to 76 px.
# Measured by tools/turn_test.py; sub-stepping in core/snake.py bounds each
# integration step to 0.10 rad, so 20 rad/s still carves a clean arc at 60 fps.
SNAKE_TURN_RATE_CAP = 20.0
SNAKE_TURN_RATE = 5.4           # legacy floor, still used as a lower bound
SNAKE_TURN_RATE_SLOW = 8.2      # tighter turning when moving slowly

SNAKE_START_LENGTH = 6          # body segments at spawn
SNAKE_SEGMENT_SPACING = 13.0    # pixels of path arc-length between segments
SNAKE_HEAD_RADIUS = 13.0
SNAKE_BODY_RADIUS = 11.0
SNAKE_TAIL_RADIUS = 5.0
SNAKE_GROW_PER_FOOD = 2         # segments gained per ordinary food

# Self-collision is ignored for the first N segments behind the head, so a
# hard turn does not instantly kill the player.  With the tight turn radius
# above, a hairpin brings the head alongside its own neck, so this window has
# to cover the whole arc: at SNAKE_SEGMENT_SPACING px per segment, a U-turn of
# radius SNAKE_MIN_TURN_RADIUS spans pi*r/spacing ~= 5 segments, and we allow
# a healthy margin on top.  Difficulty modes scale it further.
SELF_COLLISION_SKIP = 16

# When the head does overlap its own body it "crosses over" rather than dying:
# the head must overlap a distant segment by this fraction of the combined
# radii before it counts as a real self-hit.  1.0 is touching, lower is
# stricter, higher is more forgiving.
SELF_COLLISION_DEPTH = 0.62

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
SCENE_MODE = "mode"          # story vs free play, plus the difficulty picker
SCENE_SETTINGS = "settings"  # display mode, difficulty, audio
SCENE_STORY = "story"        # narrative card shown between story chapters

# --------------------------------------------------------------------------
# Game modes
# --------------------------------------------------------------------------
# STORY  - play the twelve levels in order, with narrative cards between them
#          and an automatic hand-off from one level to the next.
# FREE   - pick any unlocked level directly and replay it at will.
MODE_STORY = "story"
MODE_FREE = "free"
GAME_MODES = (MODE_STORY, MODE_FREE)
DEFAULT_MODE = MODE_STORY

# --------------------------------------------------------------------------
# Difficulty
# --------------------------------------------------------------------------
# The keys only; the actual tuning table lives in core/difficulty.py so that
# balancing does not require touching this file.
DIFF_EASY = "easy"
DIFF_NORMAL = "normal"
DIFF_HARD = "hard"
DIFF_EXPERT = "expert"
DIFFICULTIES = (DIFF_EASY, DIFF_NORMAL, DIFF_HARD, DIFF_EXPERT)
DEFAULT_DIFFICULTY = DIFF_NORMAL

# --------------------------------------------------------------------------
# Debug switches
# --------------------------------------------------------------------------
DEBUG_HITBOXES = False
# The FPS overlay draws at the window's top-right, which collides with the
# level-select star readout and the difficulty badge.  Off by default; use
# tools/frame_budget.py for real profiling, which measures per stage anyway.
SHOW_FPS = False
