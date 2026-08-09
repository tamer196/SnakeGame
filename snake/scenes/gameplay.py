"""
The gameplay scene: NEON SERPENT's actual game.

This is where every subsystem meets.  One level is built here from a `LevelDef`
(background, hazards, food, runes), the mouse-steered `Snake` is simulated
against it, and the outcome is handed to the victory / game-over screens
through ``game.last_result``.

Structure of a frame
--------------------
``update``  scales dt by ``game.fx.time_scale()`` (so a hit's slow-motion slows
            the *simulation* only), steers the snake at the cursor, advances the
            hazards, resolves pickups, then resolves collisions.
``draw``    background -> arena frame -> hazards -> food -> runes -> a *clipped*
            block containing the snake and the particles -> score popups -> HUD
            -> the READY overlay.

Three invariants are load-bearing and easy to break:

*   ``draw_snake`` and ``ParticleSystem.draw`` take no rect, so they are wrapped
    in ``surface.set_clip(arena)`` (restored in a ``finally``).  Everything else
    that draws into the arena clips itself.
*   ``snake.speed`` carries the level's cruise speed (base + per-level step)
    scaled by the difficulty's ``speed_mult`` and nothing else.
    ``level.speed_mult`` is a *separate* factor and is passed to
    ``snake.update`` alongside the power-up multipliers; that is what
    ``LevelDef.base_speed()`` documents and what ``Snake._update_boost``'s
    ``speed_mult`` parameter exists for.  Dropping it would leave the campaign's
    1.00 -> 1.70 pace ramp as dead data.
*   Hazards run on their own clock (``hazard_t``), which advances at
    ``diff.hazard_speed_mult`` times the simulation clock.  Obstacles animate
    from the absolute time value they are handed, so scaling only ``dt`` would
    change nothing at all.

Difficulty
----------
``core.difficulty`` owns every balance number this screen used to hard-code:
lives, speed, steering, self-collision, mercy invulnerability, the combo
window, the power-up spawn cadence, food scoring and the star ladder.  The row
is resolved once in :meth:`GameplayScene.on_enter` and cached on the scene, so
a mid-run difficulty change in the settings screen cannot half-apply.  NORMAL
is the identity row, so a normal run plays exactly as it did in v1.

Story mode
----------
When ``game.mode`` is ``C.MODE_STORY`` the READY card shows the level's story
beat instead of the level's own name, and clearing the level pushes
``save.set_story_progress``.  The scene never routes the story itself: it
always hands off to ``C.SCENE_VICTORY`` on a clear and ``C.SCENE_GAMEOVER`` on
a death, and leaves the narrative hand-off to ``VictoryScene`` - which reads
the chapter / beat keys this scene writes into ``game.last_result``.

Nothing in ``update`` or ``draw`` may raise.
"""

from __future__ import annotations

import math
from typing import TYPE_CHECKING, Any, Dict, List, Optional, Tuple

import pygame

from .. import config as C
from .. import palette as P
from ..core import difficulty as diffmod
from ..core import story as storymod
from ..core.contracts import Scene, TAU, angle_to, clamp, ease_out_cubic
from ..core.difficulty import Difficulty
from ..core.food import Food, FoodField, food_color
from ..core.level import LEVEL_COUNT, LevelDef, get_level
from ..core.obstacles import (Obstacle, Portal, build_obstacles, draw_obstacles,
                              obstacle_avoid_list, update_obstacles)
from ..core.powerups import (MAGNET_STRENGTH, ActiveEffects, PowerUpField,
                             powerup_color, powerup_info)
from ..core.snake import Snake
from ..gfx.background import make_background
from ..gfx.render import draw_arena, draw_snake
from ..gfx.ui import Button, draw_hud, draw_panel, draw_text

if TYPE_CHECKING:  # pragma: no cover - typing only
    from ..main import Game

__all__ = ["GameplayScene"]


# --------------------------------------------------------------------------
# Scene tuning (gameplay balance lives in config.py / level.py; these numbers
# are presentation timings that belong to this screen alone)
# --------------------------------------------------------------------------
READY_TIME: float = 3.0             # seconds of "get set" before the snake moves
GO_TIME: float = 0.65               # how long the "GO!" flourish lingers
PORTAL_LOCKOUT: float = 0.55        # our own guard against portal ping-pong

#: The head is tested slightly smaller than it is drawn, so grazes feel fair.
HEAD_HIT_R: float = C.SNAKE_HEAD_RADIUS * 0.62
#: ...and slightly larger for pickups, so food never feels like it was missed.
PICKUP_R: float = C.SNAKE_HEAD_RADIUS * 0.90

TRAIL_RATE: float = C.TRAIL_EMIT_RATE
TRAIL_RATE_BOOST: float = C.TRAIL_EMIT_RATE * 2.3
AMBIENT_RATE: float = 3.0

#: ``obstacle_avoid_list`` returns each hazard's *bounding* circle, which is
#: wildly conservative for long thin geometry - Crimson Engine's four 20x377
#: walls alone claim four 390 px discs and between them they cover the entire
#: arena, so a spawner handed that list can never place anything.  The fields
#: therefore get a softened copy (enough to keep orbs off the middle of a
#: hazard) and every spawn is then checked against the *real* collision shape
#: by ``_restock`` / ``_spawn_rune``.
SOFT_AVOID_SCALE: float = 0.50
SOFT_AVOID_MAX: float = 92.0

POPUP_LIMIT: int = 24
POPUP_LIFE: float = 1.05
POPUP_RISE: float = -64.0           # pixels / second, upward

BLINK_HZ: float = 7.0               # invulnerability blink frequency

# --------------------------------------------------------------------------
# Cross-over feedback
# --------------------------------------------------------------------------
# The snake can now hairpin over its own neck and survive it (see
# ``Snake.crossing_self``).  That is a *mechanic*, not a near-miss, so it gets
# real feedback: a soft whoosh, a wash of sparks under the head for as long as
# the overlap lasts, and - the first time it happens in a level - a short
# slow-motion tick plus a label, so the player is told once and then trusted.
CROSS_SOUND_COOLDOWN: float = 0.55  # seconds between two whooshes
CROSS_WASH_RATE: float = 62.0       # particles / second while crossing
CROSS_TEACH_SLOWMO: Tuple[float, float] = (0.55, 0.24)   # (time scale, seconds)

#: Pause button, parked in the empty slot of the HUD strip between the combo
#: badge (x ~840) and the boost bar (x 958).
PAUSE_RECT: Tuple[int, int, int, int] = (886, 32, 70, 38)


# ==========================================================================
# Floating score popups
# ==========================================================================
class _Popup:
    """One rising, fading label - "+30", "SHIELD", "-1 LIFE"."""

    __slots__ = ("x", "y", "vy", "life", "max_life", "text", "color", "big")

    def __init__(self, x: float, y: float, text: str,
                 color: Tuple[int, int, int], big: bool = False) -> None:
        self.x = float(x)
        self.y = float(y)
        self.vy = POPUP_RISE * (1.25 if big else 1.0)
        self.life = POPUP_LIFE * (1.3 if big else 1.0)
        self.max_life = self.life
        self.text = str(text)
        self.color = color
        self.big = bool(big)

    def update(self, dt: float) -> None:
        self.y += self.vy * dt
        # Ease the rise to a stop so the label settles instead of flying off.
        self.vy *= 1.0 / (1.0 + 2.6 * dt)
        self.life -= dt

    @property
    def fade(self) -> float:
        return clamp(self.life / self.max_life, 0.0, 1.0)


# ==========================================================================
# GameplayScene
# ==========================================================================
class GameplayScene(Scene):
    """One playable level, start to finish."""

    transparent = False
    blocks_update = True

    def __init__(self, game: "Game") -> None:
        super().__init__(game)

        self.arena: pygame.Rect = pygame.Rect(*C.ARENA_RECT)

        # -- difficulty / mode (re-resolved by every on_enter) --------------
        self.diff: Difficulty = diffmod.get_difficulty(None)
        self.story_mode: bool = False
        self.beat: Optional[storymod.StoryBeat] = None
        self.chapter: Optional[storymod.Chapter] = None
        #: Cached difficulty-derived numbers, so the hot loop never re-derives.
        self.self_enabled: bool = True
        self.self_skip: int = int(C.SELF_COLLISION_SKIP)
        self.self_depth: float = float(C.SELF_COLLISION_DEPTH)
        self.invuln_time: float = float(C.INVULN_AFTER_HIT)
        self.combo_window: float = float(C.COMBO_WINDOW)
        self.hazard_mult: float = 1.0
        self.star_targets: Tuple[int, int, int] = (1, 2, 3)

        # -- level ---------------------------------------------------------
        self.level: LevelDef = get_level(0)
        self.theme: P.Theme = self.level.theme
        self.background: Any = None
        self.obstacles: List[Obstacle] = []
        self.avoid: List[Tuple[float, float, float]] = []
        self.avoid_soft: List[Tuple[float, float, float]] = []
        #: ids of the orbs already checked against the real hazard shapes
        self._vetted: set = set()

        # -- entities ------------------------------------------------------
        self.snake: Optional[Snake] = None
        self.food: Optional[FoodField] = None
        self.runes: Optional[PowerUpField] = None
        self.effects: ActiveEffects = ActiveEffects()

        # -- run state -----------------------------------------------------
        self.score: int = 0
        self.food_eaten: int = 0
        self.lives: int = C.START_LIVES
        self.deaths: int = 0
        self.combo: int = 0
        self.max_combo: int = 0
        self.last_pickup_t: float = -999.0
        self.elapsed: float = 0.0
        self.clock_t: float = 0.0           # simulation clock (slow-mo aware)
        self.hazard_t: float = 0.0          # hazard clock (difficulty-scaled)
        self.ready_timer: float = READY_TIME
        self.go_timer: float = 0.0
        self.portal_lock: float = 0.0
        self.finished: bool = False
        self.popups: List[_Popup] = []
        self._was_boosting: bool = False
        self._key_boost: bool = False

        # -- cross-over feedback -------------------------------------------
        self._was_crossing: bool = False
        self._cross_cool: float = 0.0
        self._cross_taught: bool = False
        self._cross_count: int = 0

        self.pause_button: Button = self._make_pause_button()

    # ------------------------------------------------------------------
    # Construction helpers
    # ------------------------------------------------------------------
    def _make_pause_button(self) -> Button:
        font = None
        try:
            font = self.game.fonts.tiny
        except Exception:
            font = None
        return Button(pygame.Rect(*PAUSE_RECT), "PAUSE", font=font, style="ghost")

    def _resolve_difficulty(self) -> None:
        """
        Pull the whole balance table onto the scene, once per run.

        Every one of these helpers is total - a missing, stale or garbage
        ``game.difficulty`` resolves to NORMAL rather than raising - so the
        block needs no guard of its own beyond the one on the attribute read.
        """
        key = getattr(self.game, "difficulty", None)
        self.diff = diffmod.get_difficulty(key)
        self.self_enabled = diffmod.self_collision_enabled(self.diff)
        self.self_skip = diffmod.self_collision_skip(self.diff)
        self.self_depth = diffmod.self_collision_depth(self.diff)
        self.invuln_time = diffmod.invuln_seconds(self.diff)
        self.combo_window = diffmod.combo_window(self.diff)
        try:
            self.hazard_mult = max(0.05, float(self.diff.hazard_speed_mult))
        except (TypeError, ValueError):     # pragma: no cover - table is sane
            self.hazard_mult = 1.0
        self.star_targets = diffmod.apply_star_targets(self.diff,
                                                       self.level.star_targets())

    def _resolve_story(self) -> None:
        """Cache this level's narrative beat when the run is a story run."""
        self.story_mode = (getattr(self.game, "mode", C.MODE_FREE)
                           == C.MODE_STORY)
        self.beat = None
        self.chapter = None
        if not self.story_mode:
            return
        try:
            self.beat = storymod.get_beat(self.level.index)
            self.chapter = storymod.get_chapter(self.level.index)
        except Exception:       # pragma: no cover - story accessors are total
            self.beat = None
            self.chapter = None

    def _apply_powerup_rate(self) -> None:
        """
        Bend the rune field's spawn cadence to the difficulty.

        ``PowerUpField`` rolls its own intervals straight out of ``config``, so
        the only way to make EASY generous and EXPERT stingy without editing a
        file this scene does not own is to swap the roller on the *instance*
        (an instance attribute shadows the class method, and ``maybe_spawn``
        calls it through ``self``).  The pending timer is re-rolled with it, so
        the very first rune already respects the new cadence.
        """
        field = self.runes
        if field is None:
            return
        lo, hi = diffmod.powerup_spawn_range(self.diff)
        rng = field.rng

        def roll_interval() -> float:
            return rng.uniform(lo, hi)

        try:
            field._roll_interval = roll_interval       # type: ignore[assignment]
            field._timer = roll_interval() * rng.uniform(0.55, 1.0)
        except Exception:       # pragma: no cover - defensive only
            pass

    def _blocked_at(self, x: float, y: float, r: float) -> bool:
        """True when a circle at (x, y) touches anything lethal."""
        for ob in self.obstacles:
            try:
                if ob.deadly and ob.collides(x, y, r):
                    return True
            except Exception:
                continue
        return False

    def _restock(self) -> None:
        """
        Keep the arena stocked, and never leave an orb inside solid geometry.

        The field places orbs against the *softened* keep-out list, which can
        drop one inside a long thin wall, so every orb is tested against the
        real hazard shapes as well.  That test runs **once per orb**, the frame
        it first appears: re-testing an established orb every frame would let a
        sweeping bar or a swelling pulsar quietly delete food that was placed
        perfectly legally - and dodging hazards to reach that food is the whole
        point of half the campaign.  The pass also covers the bonus / mega orbs
        `FoodField` spawns on its own timers, since `auto_special` is on.
        """
        field = self.food
        if field is None:
            return
        want = int(self.level.food_count + self.effects.extra_food())
        for _ in range(max(0, want - field.count("normal"))):
            # One attempt per missing orb: a crowded arena stays under-stocked
            # for a frame rather than stalling the game loop.
            if field.spawn("normal") is None:
                break

        if not self.obstacles:
            self._vetted.clear()
            return
        keep: List[Food] = []
        seen: set = set()
        for orb in field.items:
            key = id(orb)
            if key in self._vetted or not self._blocked_at(orb.x, orb.y, orb.radius):
                keep.append(orb)
                seen.add(key)
        if len(keep) != len(field.items):
            field.items = keep
        # Rebuilt (not accumulated) so the set can never outgrow the field.
        self._vetted = seen

    def _spawn_rune(self, dt: float) -> None:
        """Tick the rune spawner, discarding any rune that landed in a hazard."""
        field = self.runes
        if field is None:
            return
        rune = field.maybe_spawn(dt, self.avoid_soft)
        if rune is None:
            return
        if self._blocked_at(rune.x, rune.y, rune.radius):
            field.items = [p for p in field.items if p is not rune]

    def _safe_heading(self) -> float:
        """
        Pick a spawn heading with room in front of it.

        Twelve candidate directions are walked outward from the spawn point; the
        one that stays clear of lethal geometry (and inside the arena) for the
        longest wins.  Levels guarantee a clear disc around the spawn, so this
        only has to choose *which* way out of it is roomiest.
        """
        cx, cy = float(self.arena.centerx), float(self.arena.centery)
        best_ang, best_clear = 0.0, -1.0
        for k in range(12):
            ang = k * TAU / 12.0
            ca, sa = math.cos(ang), math.sin(ang)
            clear = 0.0
            for d in (45.0, 90.0, 140.0, 200.0, 270.0):
                px, py = cx + ca * d, cy + sa * d
                if not self.arena.collidepoint(int(px), int(py)):
                    break
                if self._blocked_at(px, py, C.SNAKE_HEAD_RADIUS * 1.5):
                    break
                clear = d
            if clear > best_clear:
                best_clear, best_ang = clear, ang
        return best_ang

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------
    def on_enter(self, level_index: Optional[int] = None, **kwargs: Any) -> None:
        """Build the level from scratch.  Scene instances are reused, so this
        must leave *no* state from the previous run behind."""
        game = self.game

        idx = game.level_index if level_index is None else level_index
        try:
            idx = int(idx)
        except (TypeError, ValueError):
            idx = 0
        idx = int(clamp(idx, 0, LEVEL_COUNT - 1))
        game.level_index = idx

        self.level = get_level(idx)
        self.theme = self.level.theme
        self.arena = pygame.Rect(*C.ARENA_RECT)

        # -- difficulty + mode ---------------------------------------------
        # Resolved before anything that reads them is built, and re-resolved on
        # every entry so a change made in the settings screen lands on the very
        # next run rather than the one after it.
        self._resolve_difficulty()
        self._resolve_story()

        # -- world ---------------------------------------------------------
        try:
            game.fx.set_theme(self.theme)
        except Exception:
            pass
        try:
            self.background = make_background(self.theme.bg_style, self.theme, self.arena)
        except Exception:
            self.background = None

        self.obstacles = build_obstacles(self.level.obstacle_spec, self.arena)
        self.hazard_t = 0.0
        update_obstacles(self.obstacles, 0.0, 0.0)      # settle moving parts
        self.avoid = obstacle_avoid_list(self.obstacles)
        self.avoid_soft = [(x, y, min(SOFT_AVOID_MAX, r * SOFT_AVOID_SCALE))
                           for (x, y, r) in self.avoid]

        # -- entities ------------------------------------------------------
        heading = self._safe_heading()
        self.snake = Snake(float(self.arena.centerx), float(self.arena.centery),
                           heading=heading, length=C.SNAKE_START_LENGTH)
        # cruise_speed() is base + per-level step only; the level's pace
        # multiplier rides on snake.update's speed_mult (see _update).  The
        # difficulty's own scale belongs to the snake itself, so the constant
        # turn *radius* the entity derives from its speed is the one the
        # player will actually be steering with.
        self.snake.speed = self.level.cruise_speed() * float(self.diff.speed_mult)
        self.snake.set_target(*game.mouse_pos)

        self.food = FoodField(self.arena, self.theme)
        # Standing keep-out list, so the field's own bonus/mega timers place
        # their orbs legally too (auto_special is on by default).
        self.food.avoid = list(self.avoid_soft)
        self._vetted = set()
        self._restock()

        self.runes = PowerUpField(self.arena, self.theme)
        self.runes.enabled = bool(self.level.powerups_enabled)
        self._apply_powerup_rate()

        self.effects = ActiveEffects()

        # -- run state -----------------------------------------------------
        self.score = 0
        self.food_eaten = 0
        self.lives = diffmod.lives_for(self.diff)
        self.deaths = 0
        self.combo = 0
        self.max_combo = 0
        self.last_pickup_t = -999.0
        self.elapsed = 0.0
        self.clock_t = 0.0
        self.ready_timer = READY_TIME
        self.go_timer = 0.0
        self.portal_lock = 0.0
        self.finished = False
        self.popups = []
        self._was_boosting = False
        self._key_boost = False

        self._was_crossing = False
        self._cross_cool = 0.0
        self._cross_taught = False
        self._cross_count = 0

        self.pause_button = self._make_pause_button()

        try:
            game.particles.clear()
        except Exception:
            pass

    def on_exit(self) -> None:
        try:
            self.game.particles.clear()
        except Exception:
            pass

    # ------------------------------------------------------------------
    # Input
    # ------------------------------------------------------------------
    def handle_event(self, event: pygame.event.Event) -> None:
        try:
            if self.pause_button.handle_event(event):
                self._pause()
                return

            if event.type == pygame.KEYDOWN:
                key = getattr(event, "key", None)
                if key in (pygame.K_ESCAPE, pygame.K_p):
                    self._pause()
                elif key in (pygame.K_SPACE, pygame.K_LSHIFT, pygame.K_RSHIFT):
                    self._key_boost = True      # keyboard boost is a bonus route
            elif event.type == pygame.KEYUP:
                key = getattr(event, "key", None)
                if key in (pygame.K_SPACE, pygame.K_LSHIFT, pygame.K_RSHIFT):
                    self._key_boost = False
        except Exception:
            pass

    def _pause(self) -> None:
        try:
            self.game.audio.play("click")
        except Exception:
            pass
        try:
            self.game.push_scene(C.SCENE_PAUSE)
        except Exception:
            pass

    # ------------------------------------------------------------------
    # Update
    # ------------------------------------------------------------------
    def update(self, dt: float) -> None:
        try:
            self._update(dt)
        except Exception:
            # A bad frame must never take the game down.
            pass

    def _update(self, dt: float) -> None:
        game = self.game
        snake = self.snake
        if snake is None or self.food is None or self.runes is None:
            return

        dt = clamp(float(dt), 0.0, C.MAX_DT)

        # The pause button lives in real time, whatever the simulation does.
        self.pause_button.update(dt, game.mouse_pos)
        if self.pause_button.just_entered:
            try:
                game.audio.play("hover")
            except Exception:
                pass

        # Slow motion is screen feedback: it scales the simulation, not the UI.
        try:
            scale = float(game.fx.time_scale())
        except Exception:
            scale = 1.0
        sdt = clamp(dt * clamp(scale, 0.05, 1.0), 0.0, C.MAX_DT)
        self.clock_t += sdt
        # Hazards animate from an absolute time value, so their pace lives in
        # their own clock rather than in the dt they are handed.
        hdt = sdt * self.hazard_mult
        self.hazard_t += hdt

        if self.background is not None:
            self.background.update(sdt)

        for pop in self.popups:
            pop.update(dt)
        if self.popups:
            self.popups = [p for p in self.popups if p.life > 0.0]

        if self.finished:
            return

        # ---- the READY countdown: the world animates, the snake does not ---
        if self.ready_timer > 0.0:
            self.ready_timer -= dt
            snake.set_target(*game.mouse_pos)
            update_obstacles(self.obstacles, hdt, self.hazard_t)
            self.food.update(sdt, self.clock_t)
            self.runes.update(sdt, self.clock_t)
            if self.ready_timer <= 0.0:
                self.ready_timer = 0.0
                self.go_timer = GO_TIME
                try:
                    game.audio.play("start")
                except Exception:
                    pass
            return

        if self.go_timer > 0.0:
            self.go_timer = max(0.0, self.go_timer - dt)

        self.elapsed += sdt
        if self.portal_lock > 0.0:
            self.portal_lock = max(0.0, self.portal_lock - sdt)

        # ---- steering + movement ------------------------------------------
        snake.set_target(*game.mouse_pos)
        boost = self._key_boost
        try:
            boost = boost or bool(game.mouse_buttons.get(3))
        except Exception:
            pass

        # `snake.speed` carries the level's *cruise* speed (base + per-level
        # step) times the difficulty's speed scale.  The level's pace
        # multiplier is a separate factor that is NOT folded into
        # cruise_speed(), so it rides on speed_mult next to the power-up
        # multipliers - exactly what LevelDef.base_speed() reports and what
        # Snake._update_boost documents speed_mult to be for.  Dropping it here
        # would leave level.speed_mult (1.00 -> 1.70) as dead data and flatten
        # the whole campaign's pace curve.
        snake.update(sdt, boost=boost,
                     speed_mult=self.level.speed_mult * self.effects.speed_multiplier(),
                     turn_mult=self.effects.turn_multiplier() * self.diff.turn_mult)

        if snake.boosting and not self._was_boosting:
            try:
                game.audio.play("boost", 0.7)
            except Exception:
                pass
        self._was_boosting = bool(snake.boosting)

        # ---- world ---------------------------------------------------------
        self.effects.update(sdt)
        update_obstacles(self.obstacles, hdt, self.hazard_t)
        self.food.update(sdt, self.clock_t)
        self.runes.update(sdt, self.clock_t)
        self._spawn_rune(sdt)
        self._restock()

        hx, hy = snake.x, snake.y

        # Magnet: drag loose orbs toward the head.
        radius = self.effects.magnet_radius()
        if radius > 0.0:
            self.food.attract(hx, hy, sdt, radius=radius, strength=MAGNET_STRENGTH)

        self._emit_trail(sdt, snake)
        self._collect(hx, hy)

        if not self.finished:
            self._collide(hx, hy)

        # Cross-over feedback runs after the collision pass, so it reads the
        # sweep that pass already paid for (see Snake.crossing_self).
        self._cross_feedback(dt, snake)

        # Combo lapses when nothing has been eaten inside the window.
        if self.combo > 0 and (self.clock_t - self.last_pickup_t) > self.combo_window:
            self.combo = 0

    # ------------------------------------------------------------------
    # Particles
    # ------------------------------------------------------------------
    def _emit_trail(self, dt: float, snake: Snake) -> None:
        """A constant slither trail behind the head, hotter while boosting."""
        game = self.game
        try:
            if snake.boosting:
                col = P.lerp_color(self.theme.accent2, (255, 255, 255), 0.30)
                rate, speed = TRAIL_RATE_BOOST, (30.0, 110.0)
            else:
                col = self.theme.snake_a
                rate, speed = TRAIL_RATE, (8.0, 44.0)
            # Emit from just behind the head so the trail reads as a wake.
            bx = snake.x - math.cos(snake.heading) * C.SNAKE_HEAD_RADIUS * 0.6
            by = snake.y - math.sin(snake.heading) * C.SNAKE_HEAD_RADIUS * 0.6
            game.particles.trail(bx, by, col, dt, rate=rate, speed=speed)
            game.particles.ambient(self.arena, self.theme.grid, dt, rate=AMBIENT_RATE)
        except Exception:
            pass

    def _forgives_everything(self) -> bool:
        """True when nothing about touching your own body can cost a life."""
        return (not self.self_enabled) or self.effects.has("ghost")

    def _cross_feedback(self, dt: float, snake: Snake) -> None:
        """
        Sell the cross-over: the head is *allowed* to pass over its own body.

        The tight turn radius means a hairpin routinely puts the head on its
        own neck, and ``Snake.hits_self`` forgives it.  Without feedback that
        reads as "I should have died there and the game let me off", which is
        exactly the wrong lesson.  So an overlap gets a whoosh on the leading
        edge, a wash of sparks under the head for as long as it lasts, and -
        once per level - a slow-motion tick and a label, teaching the mechanic
        without nagging about it afterwards.
        """
        game = self.game
        try:
            crossing = bool(snake.alive) and bool(snake.crossing_self())
            if not crossing and snake.alive and self._forgives_everything():
                # ``crossing_self`` reports an overlap the *default* rules
                # forgave, so it goes quiet exactly where the cue matters most:
                # on EASY (and under ghost) the head sinks straight through its
                # own coil, which those rules would have called a real hit.  Ask
                # for that verdict directly and treat it as the cross-over.  The
                # collision pass has already run this frame, so re-querying
                # cannot change what the run does - only what it looks like.
                crossing = bool(snake.hits_self(skip=C.SELF_COLLISION_SKIP,
                                                depth=C.SELF_COLLISION_DEPTH,
                                                enabled=True))
        except Exception:       # pragma: no cover - the query is total
            crossing = False

        self._cross_cool = max(0.0, self._cross_cool - dt)
        if not crossing:
            self._was_crossing = False
            return

        col = P.lerp_color(self.theme.accent2, P.UI_WHITE, 0.42)
        try:
            # A wash *under* the head: emitted at the head itself (not behind
            # it, like the wake) so it reads as the body sliding underneath.
            game.particles.trail(snake.x, snake.y, col, dt,
                                 rate=CROSS_WASH_RATE, spread=TAU * 0.5,
                                 speed=(14.0, 78.0), life=(0.16, 0.40),
                                 radius=(2.0, 4.5))
        except Exception:
            pass

        if not self._was_crossing and self._cross_cool <= 0.0:
            self._cross_cool = CROSS_SOUND_COOLDOWN
            self._cross_count += 1
            try:
                # No dedicated "whoosh" cue exists; the boost swoosh at a low
                # volume is the right shape and stays out of the way.
                game.audio.play("boost", 0.24)
                game.particles.ring(snake.x, snake.y, col, radius=38.0,
                                    count=12, life=0.30, speed=95.0)
            except Exception:
                pass
            if not self._cross_taught:
                self._cross_taught = True
                try:
                    game.fx.slowmo(*CROSS_TEACH_SLOWMO)
                    game.fx.flash(col, 0.16)
                except Exception:
                    pass
                self._popup(snake.x, snake.y - 30.0, "CROSS-OVER", col)

        self._was_crossing = True

    def _popup(self, x: float, y: float, text: str,
               color: Tuple[int, int, int], big: bool = False) -> None:
        if len(self.popups) >= POPUP_LIMIT:
            del self.popups[0]
        self.popups.append(_Popup(x, y, text, color, big))

    # ------------------------------------------------------------------
    # Pickups
    # ------------------------------------------------------------------
    def _collect(self, hx: float, hy: float) -> None:
        game = self.game
        snake = self.snake
        if snake is None or self.food is None or self.runes is None:
            return

        # ---- food ----------------------------------------------------------
        for orb in self.food.collect_at(hx, hy, PICKUP_R):
            self._eat(orb)
            if self.finished:
                return

        # ---- power-up runes ------------------------------------------------
        for rune in self.runes.collect_at(hx, hy, PICKUP_R):
            try:
                kind = str(rune.kind)
                self.effects.add(kind)
                col = powerup_color(kind)
                name = str(powerup_info(kind).get("name", kind)).upper()
                game.particles.burst(rune.x, rune.y, col, count=30,
                                     speed=(70.0, 260.0), life=(0.4, 1.0))
                game.particles.ring(rune.x, rune.y, col, radius=74.0, count=26, life=0.55)
                self._popup(rune.x, rune.y - 18.0, name, col, big=True)
                game.fx.flash(col, 0.28)
                game.audio.play("powerup")
            except Exception:
                continue

    def _eat(self, orb: Food) -> None:
        """Score one orb, grow, and throw the confetti."""
        game = self.game
        snake = self.snake
        if snake is None:
            return

        # ---- combo ---------------------------------------------------------
        if self.combo > 0 and (self.clock_t - self.last_pickup_t) <= self.combo_window:
            self.combo = min(int(C.COMBO_MAX), self.combo + 1)
        else:
            self.combo = 1
        self.last_pickup_t = self.clock_t
        self.max_combo = max(self.max_combo, self.combo)

        # ---- score ---------------------------------------------------------
        # The combo step is a bonus on the orb's *value*, so it goes into the
        # base rather than into the multiplier; the power-up multiplier is what
        # score_for_food's `multiplier` is for.  On NORMAL (food_value_mult and
        # score_mult both 1.0) this is arithmetically identical to the v1 line
        # it replaces.
        value = int(getattr(orb, "value", C.SCORE_PER_FOOD))
        mult = int(self.effects.score_multiplier())
        base = value + C.COMBO_STEP_BONUS * max(0, self.combo - 1)
        gain = diffmod.score_for_food(self.diff, base, multiplier=mult)
        self.score += int(gain)

        self.food_eaten += 1
        try:
            game.save.add_food(1)
        except Exception:
            pass

        snake.grow(int(getattr(orb, "grow", C.SNAKE_GROW_PER_FOOD)))

        # ---- feedback ------------------------------------------------------
        kind = str(getattr(orb, "kind", "normal"))
        try:
            col = food_color(kind, self.theme, self.clock_t)
        except Exception:
            col = self.theme.food
        special = kind != "normal"
        try:
            game.particles.burst(orb.x, orb.y, col,
                                 count=34 if special else 20,
                                 speed=(60.0, 300.0) if special else (40.0, 190.0),
                                 life=(0.35, 1.0))
            game.particles.ring(orb.x, orb.y, col,
                                radius=76.0 if special else 46.0,
                                count=24 if special else 16,
                                life=0.55 if special else 0.42)
            if special:
                game.fx.flash(col, 0.24)
                game.fx.shake(2.5)
        except Exception:
            pass
        try:
            game.audio.play("bonus" if special else "eat")
        except Exception:
            pass

        label = "+{}".format(int(gain))
        if self.combo > 1:
            label += "  x{}".format(self.combo)
        self._popup(orb.x, orb.y - 12.0, label,
                    P.lerp_color(col, P.UI_WHITE, 0.35), big=special)

        if self.food_eaten >= self.level.goal_food:
            self._finish(won=True)

    # ------------------------------------------------------------------
    # Collisions
    # ------------------------------------------------------------------
    def _collide(self, hx: float, hy: float) -> None:
        snake = self.snake
        if snake is None or not snake.alive:
            return

        # ---- walls / wrap ---------------------------------------------------
        if self.level.wrap_walls:
            if self._wrap(snake):
                return
        elif self._out_of_bounds(hx, hy):
            if snake.invuln > 0.0:
                # Mercy timer running: shepherd the head back inside instead of
                # charging for a hit it is not allowed to take.
                self._recover("wall")
            else:
                self._hit("wall")
            return

        # Mercy invulnerability: everything below is skipped while it runs.
        if snake.invuln > 0.0:
            return

        # ---- self ------------------------------------------------------------
        # hits_self is called unconditionally (with `enabled` doing the work
        # the old short-circuit did) so that its sweep - and therefore
        # crossing_self's cache - is always the one the difficulty asked for.
        if snake.hits_self(skip=self.self_skip, depth=self.self_depth,
                           enabled=self.self_enabled
                                   and not self.effects.has("ghost")):
            self._hit("self")
            return

        # ---- hazards and portals ---------------------------------------------
        for ob in self.obstacles:
            try:
                if not ob.collides(hx, hy, HEAD_HIT_R):
                    continue
            except Exception:
                continue
            if isinstance(ob, Portal):
                if self.portal_lock <= 0.0:
                    self._through_portal(ob, snake)
                return
            if getattr(ob, "deadly", False):
                self._hit("hazard")
                return

    def _out_of_bounds(self, hx: float, hy: float) -> bool:
        a = self.arena
        r = HEAD_HIT_R
        return (hx - r < a.left or hx + r > a.right
                or hy - r < a.top or hy + r > a.bottom)

    def _wrap(self, snake: Snake) -> bool:
        """Teleport a head that left the arena to the opposite edge."""
        a = self.arena
        nx, ny = snake.x, snake.y
        wrapped = False
        if snake.x < a.left:
            nx, wrapped = a.right - 2.0, True
        elif snake.x > a.right:
            nx, wrapped = a.left + 2.0, True
        if snake.y < a.top:
            ny, wrapped = a.bottom - 2.0, True
        elif snake.y > a.bottom:
            ny, wrapped = a.top + 2.0, True
        if not wrapped:
            return False

        col = self.theme.accent
        try:
            self.game.particles.burst(snake.x, snake.y, col, count=14,
                                      speed=(50.0, 170.0), life=(0.2, 0.5))
            self.game.particles.ring(nx, ny, col, radius=42.0, count=14, life=0.35)
        except Exception:
            pass
        snake.teleport(nx, ny)
        return True

    def _through_portal(self, portal: Portal, snake: Snake) -> None:
        game = self.game
        try:
            ex, ey = portal.teleport(snake.x, snake.y)
        except Exception:
            return
        col = self.theme.accent2
        try:
            game.particles.ring(snake.x, snake.y, col, radius=70.0, count=22, life=0.5)
            game.particles.ring(ex, ey, self.theme.accent, radius=86.0, count=26, life=0.55)
            game.particles.burst(ex, ey, col, count=22, speed=(60.0, 240.0),
                                 life=(0.3, 0.8))
            game.fx.flash(col, 0.22)
        except Exception:
            pass
        snake.teleport(ex, ey)
        self.portal_lock = PORTAL_LOCKOUT
        try:
            game.audio.play("portal")
        except Exception:
            pass

    def _hit(self, kind: str) -> None:
        """Absorb, or take, one hit."""
        game = self.game
        snake = self.snake
        if snake is None or self.finished:
            return
        hx, hy = snake.x, snake.y

        # ---- shield: one free hit -------------------------------------------
        if self.effects.consume("shield"):
            col = powerup_color("shield")
            try:
                game.particles.ring(hx, hy, col, radius=140.0, count=40, life=0.7,
                                    speed=190.0)
                game.particles.burst(hx, hy, col, count=26, speed=(80.0, 300.0),
                                     life=(0.3, 0.8))
                game.fx.flash(col, 0.55)
                game.fx.shake(9.0)
                game.audio.play("powerup")
            except Exception:
                pass
            self._popup(hx, hy - 26.0, "SHIELD!", col, big=True)
            snake.invuln = max(snake.invuln, 1.0)
            self._recover(kind)
            return

        # ---- a real hit -------------------------------------------------------
        self.lives -= 1
        self.deaths += 1
        self.combo = 0
        snake.shrink(int(C.HIT_LENGTH_PENALTY))
        snake.invuln = float(self.invuln_time)
        try:
            game.save.add_death(1)
        except Exception:
            pass

        col = self.theme.hazard
        try:
            game.particles.burst(hx, hy, col, count=46, speed=(90.0, 380.0),
                                 life=(0.35, 1.1), radius=(2.0, 6.0))
            game.particles.ring(hx, hy, col, radius=120.0, count=30, life=0.6)
            game.fx.shake(19.0)
            game.fx.flash(P.UI_BAD, 0.85)
            game.fx.slowmo(0.35, 0.45)
        except Exception:
            pass
        self._popup(hx, hy - 26.0, "-1 LIFE", P.UI_BAD, big=True)

        if self.lives <= 0:
            self.lives = 0
            try:
                snake.kill()
                game.particles.burst(hx, hy, self.theme.snake_a, count=70,
                                     speed=(60.0, 430.0), life=(0.5, 1.4),
                                     radius=(2.0, 7.0))
                game.fx.shake(24.0)
                game.audio.play("die")
            except Exception:
                pass
            self._finish(won=False)
            return

        try:
            game.audio.play("hit")
        except Exception:
            pass
        self._recover(kind)

    def _recover(self, kind: str) -> None:
        """
        Get the head out of whatever it just hit.

        Without this a wall hit leaves the head parked *inside* the geometry:
        the mercy timer runs out while it is still overlapping and the player
        loses every life in a couple of seconds.  Walls and hazards therefore
        bounce the snake back toward the middle of the arena; a self-collision
        needs no nudge, the body clears itself as the head keeps moving.
        """
        snake = self.snake
        if snake is None or kind == "self":
            return
        a = self.arena
        pad = C.SNAKE_HEAD_RADIUS + 4.0
        nx = clamp(snake.x, a.left + pad, a.right - pad)
        ny = clamp(snake.y, a.top + pad, a.bottom - pad)
        if nx != snake.x or ny != snake.y:
            snake.teleport(nx, ny)
        snake.heading = angle_to(snake.x, snake.y, float(a.centerx), float(a.centery))

    # ------------------------------------------------------------------
    # End of run
    # ------------------------------------------------------------------
    def _stars(self) -> int:
        """
        0..3 stars for the score just achieved (a clear is always worth 1).

        The ladder is the level's own triple rescaled by the difficulty, so a
        three-star run costs more on EXPERT and less on EASY - and the per
        difficulty save tables keep the two results from overwriting each other.
        """
        try:
            one, two, three = self.star_targets
        except Exception:       # pragma: no cover - the triple is pre-built
            return 1
        if self.score >= three:
            return 3
        if self.score >= two:
            return 2
        return 1

    def _finish(self, won: bool) -> None:
        if self.finished:
            return
        self.finished = True
        game = self.game
        idx = int(self.level.index)

        stars = self._stars() if won else 0
        new_best = False
        final = idx >= LEVEL_COUNT - 1
        next_index = idx if final else idx + 1

        try:
            if won:
                # record() also lifts the global high score and opens the next
                # level; unlock_through is called explicitly for clarity.  The
                # difficulty is passed so a three-star easy clear cannot
                # overwrite a two-star expert one.
                new_best = bool(game.save.record(idx, int(self.score), stars,
                                                 difficulty=self.diff.key))
                game.save.unlock_through(idx + 1)
                if self.story_mode:
                    # Story progress only ever moves forward; the scene that
                    # owns the narrative hand-off (VictoryScene) reads it back.
                    game.save.set_story_progress(next_index)
                    if final:
                        game.save.set_story_complete(True)
            else:
                # A loss must not unlock anything, so record() is off limits -
                # only the global high score is worth keeping.
                if int(self.score) > int(game.save.highscore):
                    game.save.highscore = int(self.score)
                    new_best = True
            game.save.save()
        except Exception:
            pass

        # Everything the result screens need, including the story hand-off they
        # own: the keys below are additive, so a scene that only knows the v1
        # set keeps working untouched.
        result: Dict[str, Any] = {
            "score": int(self.score),
            "level_index": idx,
            "level_name": str(self.level.name),
            "food_eaten": int(self.food_eaten),
            "goal_food": int(self.level.goal_food),
            "stars": int(stars),
            "new_best": bool(new_best),
            "won": bool(won),
            "elapsed": float(self.elapsed),
            "max_combo": int(self.max_combo),
            "deaths": int(self.deaths),
            # -- v2: difficulty ---------------------------------------------
            "difficulty": str(self.diff.key),
            "difficulty_name": str(self.diff.name),
            "difficulty_label": str(self.diff.hud_label),
            "difficulty_color": tuple(self.diff.color),
            "star_targets": tuple(self.star_targets),
            "crossings": int(self._cross_count),
            # -- v2: mode ----------------------------------------------------
            "mode": str(getattr(game, "mode", C.MODE_FREE)),
            "story": bool(self.story_mode),
            "next_index": int(next_index),
            "final_level": bool(final),
        }
        if self.story_mode:
            beat, chapter = self.beat, self.chapter
            if beat is not None:
                result["beat_title"] = str(beat.title)
                result["beat_speaker"] = str(beat.speaker)
                result["chapter_end"] = bool(beat.is_chapter_end)
            if chapter is not None:
                result["chapter"] = int(chapter.number)
                result["chapter_title"] = str(chapter.title)
                result["chapter_roman"] = str(chapter.roman)
            result["story_complete"] = bool(won and final)
        game.last_result = result

        try:
            if won:
                game.fx.flash(self.theme.accent, 0.7)
                game.audio.play("win" if idx >= LEVEL_COUNT - 1 else "levelup")
        except Exception:
            pass

        try:
            game.switch_scene(C.SCENE_VICTORY if won else C.SCENE_GAMEOVER)
        except Exception:
            pass

    # ------------------------------------------------------------------
    # Draw
    # ------------------------------------------------------------------
    def draw(self, surface: pygame.Surface) -> None:
        try:
            self._draw(surface)
        except Exception:
            pass

    def _draw(self, surface: pygame.Surface) -> None:
        game = self.game
        t = self.clock_t
        theme = self.theme

        # ---- world ---------------------------------------------------------
        if self.background is not None:
            self.background.draw(surface)
        draw_arena(surface, self.arena, theme, t)
        # Hazards are drawn from the same clock they are simulated on, so a
        # difficulty that speeds them up speeds up their animation with them.
        draw_obstacles(surface, self.obstacles, theme, self.hazard_t)
        if self.food is not None:
            self.food.draw(surface, t)
        if self.runes is not None:
            self.runes.draw(surface, t)

        # ---- snake + particles: neither of these clips itself ---------------
        prev_clip = None
        try:
            prev_clip = surface.get_clip()
            area = pygame.Rect(self.arena)
            if prev_clip is not None:
                area = area.clip(prev_clip)
            surface.set_clip(area)
            snake = self.snake
            if snake is not None and self._snake_visible(snake):
                draw_snake(surface, snake, theme, t,
                           ghost=self.effects.has("ghost"),
                           shield=self.effects.has("shield"))
            game.particles.draw(surface)
        finally:
            try:
                surface.set_clip(prev_clip)
            except Exception:
                pass

        # ---- overlays -------------------------------------------------------
        self._draw_popups(surface)

        # The HUD strip clips itself, so it can safely go on top of everything.
        try:
            draw_hud(surface, game, self._hud_state(), theme, float(game.time))
        except Exception:
            pass

        self._draw_pause_button(surface)

        if self.ready_timer > 0.0:
            self._draw_ready(surface)
        elif self.go_timer > 0.0:
            self._draw_go(surface)

    def _snake_visible(self, snake: Snake) -> bool:
        """Blink while the mercy timer runs, so invulnerability is legible."""
        if snake.invuln <= 0.0:
            return True
        return math.sin(snake.invuln * TAU * BLINK_HZ) > -0.25

    def _hud_state(self) -> Dict[str, Any]:
        snake = self.snake
        try:
            highscore = int(self.game.save.highscore)
        except Exception:
            highscore = 0
        return {
            "score": int(self.score),
            "highscore": highscore,
            "level_name": str(self.level.name),
            "level_index": int(self.level.index),
            "goal_food": int(self.level.goal_food),
            "food_eaten": int(self.food_eaten),
            "lives": int(self.lives),
            "combo": int(self.combo),
            "boost": float(snake.boost) if snake is not None else 0.0,
            "boost_max": float(C.SNAKE_BOOST_MAX),
            "effects": list(self.effects.items()),
            # v2 additions.  draw_hud ignores keys it does not know, so this is
            # safe against either version of the HUD.
            "difficulty": str(self.diff.key),
            "difficulty_label": str(self.diff.hud_label),
            "difficulty_color": tuple(self.diff.color),
            "mode": str(getattr(self.game, "mode", C.MODE_FREE)),
            "chapter": int(self.chapter.number) if self.chapter is not None else 0,
            "chapter_title": str(self.chapter.title) if self.chapter is not None else "",
            "beat_title": str(self.beat.title) if self.beat is not None else "",
        }

    def _draw_pause_button(self, surface: pygame.Surface) -> None:
        """The button lives in the HUD strip; its glow is clipped to it."""
        prev_clip = None
        try:
            prev_clip = surface.get_clip()
            strip = pygame.Rect(0, 0, C.WINDOW_W, C.HUD_H)
            if prev_clip is not None:
                strip = strip.clip(prev_clip)
            surface.set_clip(strip)
            self.pause_button.draw(surface, self.theme, self.game.fonts, float(self.game.time))
        except Exception:
            pass
        finally:
            try:
                surface.set_clip(prev_clip)
            except Exception:
                pass

    def _draw_popups(self, surface: pygame.Surface) -> None:
        if not self.popups:
            return
        fonts = self.game.fonts
        prev_clip = None
        try:
            prev_clip = surface.get_clip()
            area = pygame.Rect(self.arena)
            if prev_clip is not None:
                area = area.clip(prev_clip)
            surface.set_clip(area)
            for pop in self.popups:
                try:
                    font = fonts.h2 if pop.big else fonts.small
                    fade = pop.fade
                    # Hold full opacity for the first third, then fade out.
                    alpha = int(255 * clamp(fade * 1.5, 0.0, 1.0))
                    body = font.render(pop.text, True, pop.color)
                    body.set_alpha(alpha)
                    surface.blit(body, (int(pop.x - body.get_width() * 0.5),
                                        int(pop.y - body.get_height() * 0.5)))
                except Exception:
                    continue
        except Exception:
            pass
        finally:
            try:
                surface.set_clip(prev_clip)
            except Exception:
                pass

    # ------------------------------------------------------------------
    # READY overlay
    # ------------------------------------------------------------------
    @staticmethod
    def _fit_font(text: str, fonts: Any, width: int) -> Any:
        """
        Largest of the display faces that fits `text` into `width` pixels.

        Level names all fit the title face comfortably; story beat titles do
        not ("The Machine Wants Feeding" is half again as wide as the card), so
        the headline steps down a size or two rather than spilling out of the
        panel.  Never raises - a font book that cannot measure just gets the
        title face back.
        """
        try:
            for name in ("title", "h1", "h2"):
                font = getattr(fonts, name, None)
                if font is None:
                    continue
                if font.size(str(text))[0] <= max(40, int(width)):
                    return font
            return getattr(fonts, "h2", None) or fonts.title
        except Exception:
            return getattr(fonts, "title", None)

    def _draw_ready(self, surface: pygame.Surface) -> None:
        game = self.game
        fonts = game.fonts
        theme = self.theme
        a = self.arena

        # Fade the whole card out over the last half second of the countdown.
        fade = clamp(self.ready_timer / 0.5, 0.0, 1.0)
        # ...and swing it in over the first quarter second.
        intro = ease_out_cubic(clamp((READY_TIME - self.ready_timer) / 0.35, 0.0, 1.0))
        vis = fade * intro
        if vis <= 0.01:
            return

        def tint(col: Any) -> Tuple[int, int, int]:
            """Blend a colour toward the backdrop as the card fades."""
            return P.lerp_color(theme.bg_bottom, col, vis)

        w, h = 720, 232
        panel = pygame.Rect(0, 0, w, h)
        panel.center = (a.centerx, a.centery - 40 + int((1.0 - intro) * 40))
        draw_panel(surface, panel, theme, alpha=int(226 * vis), border=True,
                   glow=0.55 * vis)

        cx = panel.centerx
        beat, chapter = self.beat, self.chapter
        story = self.story_mode and beat is not None

        # Header row: the chapter on the left (story runs only), the level
        # number in the middle, the difficulty on the right - so the player can
        # always see what they picked without leaving the level.
        draw_text(surface, "LEVEL {:02d}".format(self.level.number), fonts.small,
                  tint(theme.accent2), (cx, panel.y + 20), align="center")
        if story and chapter is not None:
            draw_text(surface, "{}. {}".format(chapter.roman, chapter.title.upper()),
                      fonts.tiny, tint(theme.accent2),
                      (panel.x + 26, panel.y + 24))
        draw_text(surface, self.diff.hud_label, fonts.tiny,
                  tint(self.diff.color), (panel.right - 26, panel.y + 24),
                  align="right")

        # In a story run the beat's title is the headline and the level's own
        # name becomes the strapline; in free play the level is the headline.
        title = beat.title.upper() if story else self.level.name.upper()
        strap = ("{}  -  {}".format(self.level.name, self.level.subtitle)
                 if story else self.level.subtitle)
        draw_text(surface, title,
                  self._fit_font(title, fonts, panel.w - 56),
                  tint(theme.text), (cx, panel.y + 46), align="center")
        draw_text(surface, strap, fonts.body,
                  tint(theme.accent), (cx, panel.y + 122), align="center")
        draw_text(surface, self.level.hint, fonts.small,
                  tint(theme.text_dim), (cx, panel.y + 160), align="center")
        draw_text(surface, "GOAL  {} ORBS".format(self.level.goal_food), fonts.small,
                  tint(P.UI_GOLD), (cx, panel.y + 188), align="center")

        # Countdown digit, well below the card so it never crowds the text.
        count = int(math.ceil(self.ready_timer))
        if count > 0:
            # `step` is 0 at the start of each second and 1 at its end, which
            # drives a pop-in scale and the digit's own fade.
            step = 1.0 - (self.ready_timer - math.floor(self.ready_timer))
            digit = fonts.huge.render(str(min(9, count)), True,
                                      P.lerp_color(theme.accent, P.UI_WHITE,
                                                   0.25 + 0.5 * step))
            try:
                scale = 1.35 - 0.35 * ease_out_cubic(clamp(step * 1.6, 0.0, 1.0))
                digit = pygame.transform.rotozoom(digit, 0.0, scale)
            except Exception:
                pass
            digit.set_alpha(int(255 * vis * clamp(1.4 - step, 0.0, 1.0)))
            surface.blit(digit, (int(cx - digit.get_width() * 0.5),
                                 int(panel.bottom + 40)))

    def _draw_go(self, surface: pygame.Surface) -> None:
        """A short "GO!" flourish once the countdown clears."""
        try:
            fonts = self.game.fonts
            u = clamp(self.go_timer / GO_TIME, 0.0, 1.0)
            body = fonts.huge.render("GO!", True,
                                     P.lerp_color(self.theme.accent, P.UI_WHITE, 0.55))
            scale = 1.0 + 0.9 * (1.0 - u)
            try:
                body = pygame.transform.rotozoom(body, 0.0, scale)
            except Exception:
                pass
            body.set_alpha(int(255 * clamp(u * 1.4, 0.0, 1.0)))
            surface.blit(body, (int(self.arena.centerx - body.get_width() * 0.5),
                                int(self.arena.centery - body.get_height() * 0.5)))
        except Exception:
            pass
