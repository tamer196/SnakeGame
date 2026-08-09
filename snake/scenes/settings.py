"""
SETTINGS - the options screen for NEON SERPENT.

Five labelled rows down the left, a live preview strip down the right:

``DISPLAY MODE``
    windowed / borderless / fullscreen, cycled with the two arrow buttons or by
    clicking the value itself.  Applied through :meth:`Game.set_display_mode`,
    which also remembers the windowed size, and persisted with
    ``save.set_display_mode``.
``DIFFICULTY``
    the four :class:`~snake.core.difficulty.Difficulty` rows as coloured chips,
    with the selected one's blurb and its lives / speed / self-collision stakes
    spelled out underneath.  Writes ``game.difficulty`` and
    ``save.set_difficulty``.
``SOUND``
    one on/off toggle driving ``game.audio`` and ``save.set_muted``.
``VISUAL EFFECTS``
    bloom, scanlines and grain go straight to
    :meth:`~snake.gfx.effects.EffectStack.set_post_flags` - those three are
    exactly the flag names it accepts that a player would recognise.  Screen
    shake is *not* a post-processing layer, so it is switched by a small guard
    installed over ``fx.shake`` plus a ``fx.shake_enabled`` flag; the guard is
    idempotent, defaults to "on" and is a pure pass-through while enabled.
``RESET PROGRESS``
    a danger button behind a confirm step that swaps the row for ARE YOU SURE?
    with CONFIRM / CANCEL, and only then calls ``save.reset()``.

The preview strip on the right runs a real :class:`~snake.core.snake.Snake`
through a miniature of the post chain - a cheap down/up-scale bloom, the
scanline lattice, animated grain and a periodic camera knock - so every toggle
has a visible consequence before the player commits to it.

Persistence: display mode, difficulty and mute all have savefile setters and
are flushed as they change.  The visual-effect switches have no field in the
save schema, so they live on the :class:`~snake.gfx.effects.EffectStack` for
the session; the moment ``SaveData`` grows setters for them this scene will
pick them up (see :meth:`SettingsScene._persist_flag`).

Nothing here may raise: ``update`` and ``draw`` swallow their own failures, and
any clip rect that is set is restored in a ``finally``.
"""

from __future__ import annotations

import math
import random
from typing import TYPE_CHECKING, Any, List, Optional, Sequence, Tuple

import pygame

from .. import config as C
from .. import palette as P
from ..core.contracts import Scene, clamp, ease_out_cubic, pulse
from ..core.difficulty import (Difficulty, all_difficulties, get_difficulty,
                               lives_for)
from ..core.snake import Snake
from ..gfx.background import make_background
from ..gfx.render import draw_snake
from ..gfx.ui import Button, draw_panel, draw_text

if TYPE_CHECKING:  # pragma: no cover - typing only
    from ..main import Game

__all__ = ["SettingsScene"]

RGB = Tuple[int, int, int]

# --------------------------------------------------------------------------
# Layout.  Authored once against the fixed 1280x720 canvas so no two blocks
# can drift into each other.
# --------------------------------------------------------------------------
_PAD = 40
_COL_W = 800                                   # the settings column
_PREVIEW_X = 872
_PREVIEW_W = C.WINDOW_W - _PREVIEW_X - _PAD    # 368

_ROW_DISPLAY = pygame.Rect(_PAD, 96, _COL_W, 100)
_ROW_DIFF = pygame.Rect(_PAD, 204, _COL_W, 172)
_ROW_SOUND = pygame.Rect(_PAD, 384, _COL_W, 80)
_ROW_FX = pygame.Rect(_PAD, 472, _COL_W, 112)
_ROW_RESET = pygame.Rect(_PAD, 592, _COL_W, 96)

_PREVIEW_PANEL = pygame.Rect(_PREVIEW_X, 96, _PREVIEW_W, 524)
_WELL = pygame.Rect(_PREVIEW_X + 16, 140, _PREVIEW_W - 32, 300)
# Nudged up and left out of the bottom-right corner: the CRT bezel in
# `gfx/effects.py` passed only ~29% of the drawn light at the panel-centred
# (906, 636), and this is the screen's only mouse exit.  ~0.52 here, which is
# the best available while still clearing the reset row (it ends at x=840) and
# the preview panel above (it ends at y=620).
_BACK_RECT = pygame.Rect(850, 622, C.UI_BUTTON_W, C.UI_BUTTON_H)

# Control geometry shared by the single-control rows.
_ARROW_W = 44
_VALUE_W = 166

# --------------------------------------------------------------------------
# Copy
# --------------------------------------------------------------------------
_DISPLAY_DESC = ("How the game fills your screen.  "
                 "F11 toggles fullscreen anywhere in the game.")
_DIFF_DESC = "Lives, pace and how cruel your own coil is."
_SOUND_DESC = "Menu clicks, pickups, explosions and the win fanfare."
_FX_DESC = "Post-processing on the finished frame.  Turn these off if the frame rate dips."
_RESET_DESC = "Erases every unlock, star and best score.  Your settings are kept."
_RESET_WARN = "Every star, unlock and best score, on every difficulty."

#: (action key, short name, one-line description shown in the preview panel).
_FX_TOGGLES: Tuple[Tuple[str, str, str], ...] = (
    ("bloom", "BLOOM", "Soft light bleeding out of every neon edge."),
    ("scanlines", "SCANLINES", "Faint CRT lines laid over the whole frame."),
    ("grain", "GRAIN", "Fine animated film noise, sold at low light."),
    ("shake", "SHAKE", "The camera kicks when you crash or clear a level."),
)

_PREVIEW_HINT = "Hover a switch to see what it does - the strip above shows it live."

#: Seconds the panels take to wash in on entry.
_INTRO_TIME = 0.32

# --------------------------------------------------------------------------
# Preview tuning
# --------------------------------------------------------------------------
_PREVIEW_SPEED = 132.0          # px/s - slow enough to read at this size
_PREVIEW_LENGTH = 11
_BLOOM_DOWNSCALE = 6
_BLOOM_STRENGTH = 150           # 0..255 multiply applied before the additive blit
#: The blur is rebuilt every N frames and re-used in between.  At 60 fps the
#: reuse is invisible (it reads as bloom persistence) and it halves the cost of
#: the most expensive thing on this screen.
_BLOOM_EVERY = 2
_GRAIN_FRAMES = 4
_SHAKE_PERIOD = 2.3             # seconds between demo camera knocks
_SHAKE_TRAUMA = 1.0
_SHAKE_DECAY = 2.4
_SHAKE_PIXELS = 7.0


# ==========================================================================
# Small local helpers
# ==========================================================================
def _mix(a: Sequence[int], b: Sequence[int], t: float) -> RGB:
    """Blend two colours, tolerating any 3-sequence."""
    return P.lerp_color((int(a[0]), int(a[1]), int(a[2])),
                        (int(b[0]), int(b[1]), int(b[2])), t)


def _wrap(text: str, font: Optional[pygame.font.Font], max_w: int) -> List[str]:
    """Greedy word wrap; falls back to one line if the font cannot measure."""
    words = str(text).split()
    if not words:
        return []
    if font is None:
        return [" ".join(words)]
    lines: List[str] = []
    current = words[0]
    for word in words[1:]:
        candidate = current + " " + word
        try:
            width = font.size(candidate)[0]
        except Exception:
            return [" ".join(words)]
        if width <= max_w:
            current = candidate
        else:
            lines.append(current)
            current = word
    lines.append(current)
    return lines


def _install_shake_guard(fx: Any) -> None:
    """
    Make ``fx.shake_enabled`` actually mean something.

    ``EffectStack.set_post_flags`` has no switch for the camera shake - shake
    is simulation feedback, not a post-processing layer - so this wraps the
    stack's own ``shake`` in a guard that drops the call while the flag is
    False.  The wrapper is installed at most once per stack, defaults to
    enabled and forwards every argument unchanged, so with the setting on the
    behaviour is bit-for-bit what it was before.
    """
    try:
        if getattr(fx, "_settings_shake_guard", False):
            return
        original = fx.shake

        def guarded(amount: float, **kwargs: Any) -> None:
            if not getattr(fx, "shake_enabled", True):
                return
            original(amount, **kwargs)

        fx.shake = guarded                     # instance attribute shadows the method
        fx._settings_shake_guard = True
        if not hasattr(fx, "shake_enabled"):
            fx.shake_enabled = True
    except Exception:
        pass


# ==========================================================================
# Scene
# ==========================================================================
class SettingsScene(Scene):
    """Display, difficulty, sound, visual effects and the progress reset."""

    transparent: bool = False
    blocks_update: bool = True

    def __init__(self, game: "Game") -> None:
        super().__init__(game)
        self.t: float = 0.0
        self.intro: float = 0.0
        self.theme: P.Theme = P.THEMES[0]
        self.background: Any = None
        self._bg_style: str = ""

        #: Where BACK goes.  Set by :meth:`on_enter`.
        self.back_target: str = C.SCENE_MENU

        self.buttons: List[Button] = []
        self.confirming: bool = False          # reset-progress confirm step
        self._leaving: bool = False            # guards a double switch_scene
        self.fx_hint: str = ""                 # description of the hovered switch
        self.flash: float = 0.0                # 0..1 "setting applied" pulse
        self.reset_flash: float = 0.0          # 0..1 "progress erased" pulse

        # -- preview ------------------------------------------------------
        self._buf: Optional[pygame.Surface] = None
        self._snake: Optional[Snake] = None
        self._orbit: float = 0.0
        self._shake: float = 0.0
        self._shake_next: float = _SHAKE_PERIOD
        self._scanlines: Optional[pygame.Surface] = None
        self._bloom_small: Optional[pygame.Surface] = None
        self._bloom_full: Optional[pygame.Surface] = None
        self._bloom_tick: int = 0
        self._grain: List[pygame.Surface] = []
        self._grain_index: int = 0
        self._grain_at: float = 0.0
        self._rng = random.Random(0x5E77)

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------
    def on_enter(self, **kwargs: Any) -> None:
        """
        Full reset - scene instances are cached and reused by the Game.

        ``back`` names the scene BACK returns to (default the main menu), so
        the pause overlay and the menu can share this screen.
        """
        try:
            self.t = 0.0
            self.intro = 0.0
            self.confirming = False
            self._leaving = False
            self.flash = 0.0
            self.reset_flash = 0.0
            self.fx_hint = ""
            self.back_target = self._resolve_back(kwargs.get("back"))

            self.theme = self._resolve_theme()
            self._ensure_background()

            # The shake switch needs its guard before the first toggle.
            fx = getattr(self.game, "fx", None)
            if fx is not None:
                _install_shake_guard(fx)

            self._build_buttons()
            self._reset_preview()
        except Exception:
            pass

    def on_exit(self) -> None:
        """Drop the preview so a re-entry always starts from a clean pose."""
        self._snake = None
        self._buf = None
        self.confirming = False
        self._leaving = False

    # -- on_enter helpers ------------------------------------------------
    def _resolve_back(self, value: Any) -> str:
        """Validate the caller's back target, defaulting to the main menu."""
        known = (C.SCENE_MENU, C.SCENE_LEVELS, C.SCENE_GAME, C.SCENE_PAUSE,
                 C.SCENE_GAMEOVER, C.SCENE_VICTORY, C.SCENE_HELP,
                 C.SCENE_MODE, C.SCENE_STORY)
        try:
            name = str(value or "").strip().lower()
        except Exception:
            return C.SCENE_MENU
        return name if name in known else C.SCENE_MENU

    def _resolve_theme(self) -> P.Theme:
        try:
            return P.theme_for_level(int(getattr(self.game, "level_index", 0)))
        except Exception:
            return P.THEMES[0]

    def _ensure_background(self) -> None:
        """(Re)build the scrolling backdrop when the active theme changed."""
        style = str(getattr(self.theme, "bg_style", "grid"))
        if self.background is not None and style == self._bg_style:
            return
        try:
            self.background = make_background(
                style, self.theme, pygame.Rect(0, 0, C.WINDOW_W, C.WINDOW_H))
            self._bg_style = style
        except Exception:
            self.background = None

    # ------------------------------------------------------------------
    # Current values
    # ------------------------------------------------------------------
    def _display_mode(self) -> str:
        mode = getattr(self.game, "display_mode", C.DEFAULT_DISPLAY_MODE)
        return mode if mode in C.DISPLAY_MODES else C.DEFAULT_DISPLAY_MODE

    def _display_label(self) -> str:
        return str(C.DISPLAY_MODE_LABELS.get(self._display_mode(), "WINDOWED"))

    def _difficulty(self) -> Difficulty:
        return get_difficulty(getattr(self.game, "difficulty", None))

    def _muted(self) -> bool:
        try:
            return bool(getattr(self.game.audio, "muted", False))
        except Exception:
            return False

    def _fx_flag(self, key: str) -> bool:
        """Read one visual-effect switch off the effect stack."""
        fx = getattr(self.game, "fx", None)
        if fx is None:
            return False
        attr = {"bloom": "bloom_enabled", "scanlines": "scanlines_enabled",
                "grain": "grain_enabled", "shake": "shake_enabled"}.get(key)
        if not attr:
            return False
        try:
            return bool(getattr(fx, attr, True))
        except Exception:
            return False

    # ------------------------------------------------------------------
    # Buttons
    # ------------------------------------------------------------------
    def _build_buttons(self) -> None:
        """
        Rebuild every control from the current values.

        Called on entry and whenever the reset row flips between its normal and
        its confirm state, so the button list always matches what is drawn.
        """
        self.buttons = []
        add = self.buttons.append

        # ---- display mode ------------------------------------------------
        row = _ROW_DISPLAY
        cy = row.y + 50
        left = pygame.Rect(0, 0, _ARROW_W, 44)
        left.center = (row.right - 20 - _ARROW_W * 2 - _VALUE_W - 8, cy)
        add(Button(left, "<", style="ghost", data="display_prev",
                   font=self._font("ui", 24, True)))

        value = pygame.Rect(0, 0, _VALUE_W, 44)
        value.center = (left.centerx + _ARROW_W // 2 + 4 + _VALUE_W // 2, cy)
        add(Button(value, self._display_label(), style="primary",
                   data="display_next", font=self._font("ui", 20, True)))

        right = pygame.Rect(0, 0, _ARROW_W, 44)
        right.center = (value.centerx + _VALUE_W // 2 + 4 + _ARROW_W // 2, cy)
        add(Button(right, ">", style="ghost", data="display_next",
                   font=self._font("ui", 24, True)))

        # ---- difficulty ---------------------------------------------------
        row = _ROW_DIFF
        chips = all_difficulties()
        count = max(1, len(chips))
        gap = 12
        width = (row.w - 36 - gap * (count - 1)) // count
        selected = self._difficulty().key
        for i, diff in enumerate(chips):
            rect = pygame.Rect(row.x + 18 + i * (width + gap), row.y + 64, width, 50)
            add(Button(rect, diff.label,
                       style=("primary" if diff.key == selected else "ghost"),
                       data="diff:" + diff.key, font=self._font("ui", 21, True)))

        # ---- sound ---------------------------------------------------------
        row = _ROW_SOUND
        rect = pygame.Rect(0, 0, _VALUE_W, 44)
        rect.center = (row.right - 20 - _VALUE_W // 2, row.y + 42)
        add(Button(rect, self._sound_label(), style=("ghost" if self._muted() else "primary"),
                   data="sound", font=self._font("ui", 20, True)))

        # ---- visual effects -------------------------------------------------
        row = _ROW_FX
        count = max(1, len(_FX_TOGGLES))
        gap = 12
        width = (row.w - 36 - gap * (count - 1)) // count
        for i, (key, name, _desc) in enumerate(_FX_TOGGLES):
            rect = pygame.Rect(row.x + 18 + i * (width + gap), row.y + 62, width, 42)
            on = self._fx_flag(key)
            add(Button(rect, self._toggle_label(name, on),
                       style=("primary" if on else "ghost"),
                       data="fx:" + key, font=self._font("ui", 18, True)))

        # ---- reset progress --------------------------------------------------
        row = _ROW_RESET
        if self.confirming:
            confirm = pygame.Rect(0, 0, 168, 46)
            confirm.center = (row.right - 20 - 168 // 2, row.y + 62)
            add(Button(confirm, "CONFIRM", style="danger", data="reset_confirm",
                       font=self._font("ui", 20, True)))
            cancel = pygame.Rect(0, 0, 150, 46)
            cancel.center = (confirm.left - 12 - 150 // 2, row.y + 62)
            add(Button(cancel, "CANCEL", style="ghost", data="reset_cancel",
                       font=self._font("ui", 20, True)))
        else:
            rect = pygame.Rect(0, 0, 230, 46)
            rect.center = (row.right - 20 - 230 // 2, row.y + 54)
            add(Button(rect, "RESET PROGRESS", style="danger", data="reset",
                       font=self._font("ui", 19, True)))

        # ---- back ------------------------------------------------------------
        add(Button(_BACK_RECT, "BACK", style="primary", data="back",
                   font=self._font("h2", 30, True)))

    def _sound_label(self) -> str:
        return "SOUND  OFF" if self._muted() else "SOUND  ON"

    @staticmethod
    def _toggle_label(name: str, on: bool) -> str:
        return "{}  {}".format(name, "ON" if on else "OFF")

    def _refresh_labels(self) -> None:
        """Re-sync every control's label and style with the live values."""
        selected = self._difficulty().key
        for btn in self.buttons:
            key = str(getattr(btn, "data", "") or "")
            try:
                if key == "display_next" and btn.rect.w == _VALUE_W:
                    btn.label = self._display_label()
                elif key.startswith("diff:"):
                    btn.style = "primary" if key[5:] == selected else "ghost"
                elif key == "sound":
                    btn.label = self._sound_label()
                    btn.style = "ghost" if self._muted() else "primary"
                elif key.startswith("fx:"):
                    flag = key[3:]
                    on = self._fx_flag(flag)
                    name = next((n for k, n, _d in _FX_TOGGLES if k == flag), flag.upper())
                    btn.label = self._toggle_label(name, on)
                    btn.style = "primary" if on else "ghost"
            except Exception:
                continue

    # ------------------------------------------------------------------
    # Input
    # ------------------------------------------------------------------
    def handle_event(self, event: "pygame.event.Event") -> None:
        try:
            for btn in list(self.buttons):
                if btn.handle_event(event):
                    self._activate(str(getattr(btn, "data", "") or ""))
                    return
            if getattr(event, "type", None) != pygame.KEYDOWN:
                return
            key = getattr(event, "key", None)
            if key in (pygame.K_ESCAPE, pygame.K_BACKSPACE):
                self._activate("reset_cancel" if self.confirming else "back")
            elif key in (pygame.K_LEFT, pygame.K_a):
                self._activate("display_prev")
            elif key in (pygame.K_RIGHT, pygame.K_d):
                self._activate("display_next")
            elif key == pygame.K_m:
                self._activate("sound")
        except Exception:
            pass

    def _activate(self, key: str) -> None:
        """Run the action behind a control (button click or shortcut)."""
        if not key:
            return
        try:
            if key == "back":
                self._go_back()
            elif key == "display_prev":
                self._cycle_display(-1)
            elif key == "display_next":
                self._cycle_display(1)
            elif key.startswith("diff:"):
                self._set_difficulty(key[5:])
            elif key == "sound":
                self._toggle_sound()
            elif key.startswith("fx:"):
                self._toggle_fx(key[3:])
            elif key == "reset":
                self._click("click")
                self.confirming = True
                self._build_buttons()
            elif key == "reset_cancel":
                if self.confirming:
                    self._click("click")
                    self.confirming = False
                    self._build_buttons()
            elif key == "reset_confirm":
                self._do_reset()
        except Exception:
            # A settings screen must never take the game down with it.
            pass

    def _click(self, name: str = "click") -> None:
        try:
            self.game.audio.play(name)
        except Exception:
            pass

    def _go_back(self) -> None:
        """
        Leave for wherever this screen was opened from.

        If we were *pushed* on top of a live stack - the pause overlay is the
        obvious caller - the honest way home is to pop, which uncovers exactly
        the screen that opened us.  ``back`` is the fallback for the normal
        case where we are the only scene on the stack.
        """
        if self._leaving:
            return
        self._leaving = True
        self._click("click")
        self._flush_save()

        stack = getattr(self.game, "_stack", None)
        try:
            if isinstance(stack, list) and len(stack) > 1 and stack[-1] is self:
                self.game.pop_scene()
                return
        except Exception:
            pass

        target = self.back_target
        try:
            if target == C.SCENE_GAME:
                self.game.switch_scene(target,
                                       level_index=int(getattr(self.game, "level_index", 0)))
            else:
                self.game.switch_scene(target)
        except Exception:
            self._leaving = False
            try:
                self.game.switch_scene(C.SCENE_MENU)
            except Exception:
                pass

    def _flush_save(self) -> None:
        try:
            self.game.save.save()
        except Exception:
            pass

    # -- individual settings ----------------------------------------------
    def _cycle_display(self, delta: int) -> None:
        """Step the display mode and apply it immediately."""
        modes = list(C.DISPLAY_MODES) or [C.DISPLAY_WINDOWED]
        try:
            index = modes.index(self._display_mode())
        except ValueError:
            index = 0
        chosen = modes[(index + int(delta)) % len(modes)]
        self._click("click")
        try:
            self.game.set_display_mode(chosen)
        except Exception:
            pass
        try:
            self.game.save.set_display_mode(getattr(self.game, "display_mode", chosen))
        except Exception:
            pass
        self._flush_save()
        self.flash = 1.0
        self._refresh_labels()

    def _set_difficulty(self, key: str) -> None:
        """Select a difficulty; a no-op click on the current one still confirms."""
        diff = get_difficulty(key)
        self._click("click")
        try:
            self.game.difficulty = diff.key
        except Exception:
            pass
        try:
            self.game.save.set_difficulty(diff.key)
        except Exception:
            pass
        self._flush_save()
        self.flash = 1.0
        self._refresh_labels()

    def _toggle_sound(self) -> None:
        """Flip mute, persist it and relabel the control."""
        muted = self._muted()
        try:
            muted = bool(self.game.audio.toggle_mute())
        except Exception:
            muted = not muted
            try:
                self.game.audio.muted = muted
            except Exception:
                pass
        try:
            self.game.save.set_muted(muted)
        except Exception:
            pass
        self._flush_save()
        if not muted:
            self._click("click")        # audible confirmation only when unmuted
        self.flash = 1.0
        self._refresh_labels()

    def _toggle_fx(self, flag: str) -> None:
        """Flip one visual-effect switch and push it into the effect stack."""
        fx = getattr(self.game, "fx", None)
        if fx is None:
            return
        value = not self._fx_flag(flag)
        self._click("click")
        try:
            if flag == "bloom":
                fx.set_post_flags(bloom=value)
            elif flag == "scanlines":
                fx.set_post_flags(scanlines=value)
            elif flag == "grain":
                fx.set_post_flags(grain=value)
            elif flag == "shake":
                _install_shake_guard(fx)
                fx.shake_enabled = value
        except Exception:
            pass
        self._persist_flag(flag, value)
        self.flash = 1.0
        self._refresh_labels()

    def _persist_flag(self, flag: str, value: bool) -> None:
        """
        Persist a visual-effect switch *if* the save file grows a setter.

        The current schema has no field for these, so this is deliberately a
        duck-typed probe rather than a hard call: nothing breaks today and the
        setting starts persisting the moment ``SaveData.set_effect`` (or a
        per-flag setter) exists.
        """
        save = getattr(self.game, "save", None)
        if save is None:
            return
        setter = getattr(save, "set_" + flag, None) or getattr(save, "set_effect", None)
        if not callable(setter):
            return
        try:
            if getattr(save, "set_" + flag, None) is setter:
                setter(bool(value))
            else:
                setter(flag, bool(value))
        except Exception:
            return
        self._flush_save()

    def _do_reset(self) -> None:
        """
        Wipe the *progress* and rebuild the row.

        ``SaveData.reset()`` clears the whole document, preferences included,
        but this button is labelled RESET PROGRESS - so the four settings this
        screen owns are read first and written straight back afterwards.  The
        live session is left exactly as it was apart from the level index,
        which now has nowhere above level one to point at.
        """
        self._click("die")
        display = self._display_mode()
        difficulty = self._difficulty().key
        muted = self._muted()
        mode = getattr(self.game, "mode", None)

        try:
            self.game.save.reset()
        except Exception:
            pass

        save = getattr(self.game, "save", None)
        for setter, value in (("set_display_mode", display),
                              ("set_difficulty", difficulty),
                              ("set_muted", muted),
                              ("set_mode", mode if mode in C.GAME_MODES else None)):
            if value is None:
                continue
            try:
                getattr(save, setter)(value)
            except Exception:
                continue
        self._flush_save()

        try:
            self.game.level_index = 0
        except Exception:
            pass

        self.confirming = False
        self.reset_flash = 1.0
        self.flash = 1.0
        self._build_buttons()
        # No particle burst: this scene does not draw `game.particles`, so
        # spawning into it would only leak emitters into the next screen.  The
        # feedback is `reset_flash`, which lights the summary line instead.

    # ------------------------------------------------------------------
    # Update
    # ------------------------------------------------------------------
    def update(self, dt: float) -> None:
        try:
            dt = clamp(float(dt), 0.0, C.MAX_DT)
            self.t += dt
            if self.intro < 1.0:
                self.intro = clamp(self.intro + dt / _INTRO_TIME, 0.0, 1.0)
            self.flash = max(0.0, self.flash - dt * 2.0)
            self.reset_flash = max(0.0, self.reset_flash - dt * 0.7)

            if self.background is not None:
                self.background.update(dt)

            mouse = getattr(self.game, "mouse_pos", (0.0, 0.0))
            hint = ""
            for btn in self.buttons:
                was = btn.hovered
                btn.update(dt, mouse)
                if btn.hovered and not was:
                    self._click("hover")
                if btn.hovered:
                    key = str(getattr(btn, "data", "") or "")
                    if key.startswith("fx:"):
                        hint = next((d for k, _n, d in _FX_TOGGLES if k == key[3:]), "")
            self.fx_hint = hint

            self._update_preview(dt)
        except Exception:
            pass

    # -- preview ----------------------------------------------------------
    def _reset_preview(self) -> None:
        """Rebuild the preview snake and its cached overlays."""
        self._orbit = 0.0
        self._shake = 0.0
        self._shake_next = _SHAKE_PERIOD
        self._grain_index = 0
        self._grain_at = 0.0
        self._bloom_tick = 0
        try:
            if self._buf is None or self._buf.get_size() != _WELL.size:
                self._buf = pygame.Surface(_WELL.size)
                self._scanlines = None
                self._bloom_small = None
                self._bloom_full = None
                self._grain = []
        except Exception:
            self._buf = None
        try:
            self._snake = Snake(_WELL.w * 0.5, _WELL.h * 0.5, 0.0,
                                length=_PREVIEW_LENGTH)
            self._snake.speed = _PREVIEW_SPEED
        except Exception:
            self._snake = None

    def _orbit_target(self, phase: float) -> Tuple[float, float]:
        """A lazy figure-of-eight well inside the preview box."""
        rx = _WELL.w * 0.5 - 72.0
        ry = _WELL.h * 0.5 - 64.0
        return (_WELL.w * 0.5 + math.cos(phase * 0.85) * rx,
                _WELL.h * 0.5 + math.sin(phase * 1.31) * ry)

    def _update_preview(self, dt: float) -> None:
        """Advance the demo snake and the demo camera knock."""
        snake = self._snake
        if snake is None:
            return
        self._orbit += dt
        tx, ty = self._orbit_target(self._orbit)
        snake.set_target(tx, ty)
        snake.update(dt)

        # If the head ever escapes the box (a stall, a huge dt), put it back
        # rather than let the preview quietly drift off screen.
        hx, hy = snake.head_pos()
        if not (-40.0 < hx < _WELL.w + 40.0 and -40.0 < hy < _WELL.h + 40.0):
            try:
                snake.reset(_WELL.w * 0.5, _WELL.h * 0.5, 0.0)
            except Exception:
                self._snake = None
                return

        # Demo shake: a periodic knock so the switch has something to show.
        if self._fx_flag("shake"):
            self._shake_next -= dt
            if self._shake_next <= 0.0:
                self._shake_next = _SHAKE_PERIOD
                self._shake = _SHAKE_TRAUMA
        self._shake = max(0.0, self._shake - dt * _SHAKE_DECAY)

        self._grain_at += dt
        if self._grain_at >= 1.0 / 18.0:
            self._grain_at = 0.0
            if self._grain:
                self._grain_index = (self._grain_index + 1) % len(self._grain)

    # ------------------------------------------------------------------
    # Draw
    # ------------------------------------------------------------------
    def draw(self, surface: "pygame.Surface") -> None:
        prev_clip: Any = None
        try:
            prev_clip = surface.get_clip()
            self._draw_impl(surface)
        except Exception:
            pass
        finally:
            try:
                surface.set_clip(prev_clip)
            except Exception:
                pass

    def _draw_impl(self, surface: "pygame.Surface") -> None:
        theme = self.theme
        fonts = getattr(self.game, "fonts", None)
        t = self.t

        if self.background is not None:
            self.background.draw(surface)
        else:
            surface.fill(getattr(theme, "bg_bottom", (6, 8, 18)))

        self._draw_header(surface, theme, t)
        self._draw_display_row(surface, theme, t)
        self._draw_difficulty_row(surface, theme, t)
        self._draw_sound_row(surface, theme, t)
        self._draw_fx_row(surface, theme, t)
        self._draw_reset_row(surface, theme, t)
        self._draw_preview(surface, theme, t)

        for btn in self.buttons:
            btn.draw(surface, theme, fonts, t)

    # -- header -------------------------------------------------------------
    def _draw_header(self, surface: "pygame.Surface", theme: P.Theme, t: float) -> None:
        accent = getattr(theme, "accent", P.UI_WHITE)
        draw_text(surface, "SETTINGS", self._font("h1", 42),
                  _mix(accent, P.UI_WHITE, 0.3 + 0.2 * pulse(t, 1.6)), (_PAD, 18))
        draw_text(surface, "everything here is saved the moment you change it",
                  self._font("small", 17), getattr(theme, "text_dim", P.UI_DIM),
                  (_PAD + 4, 64))
        where = "BACK RETURNS TO {}".format(self.back_target.upper())
        draw_text(surface, where, self._font("tiny", 14),
                  P.shade(getattr(theme, "text_dim", P.UI_DIM), 0.8),
                  (C.WINDOW_W - _PAD, 30), align="right")

    # -- shared row furniture ------------------------------------------------
    def _panel_alpha(self, full: int) -> int:
        """
        Panel opacity for the entry fade.

        The panels wash in over `_INTRO_TIME`; they never start fully
        transparent, so the layout is readable on the very first frame and the
        buttons (which animate themselves) are never floating over nothing.
        """
        fade = ease_out_cubic(clamp(self.intro, 0.0, 1.0))
        return int(clamp(full * (0.45 + 0.55 * fade), 0.0, 255.0))

    def _row_panel(self, surface: "pygame.Surface", rect: pygame.Rect, title: str,
                   desc: str, theme: P.Theme, *, glow: float = 0.22,
                   danger: bool = False) -> None:
        """Panel, caption and description shared by every settings row."""
        draw_panel(surface, rect, theme, alpha=self._panel_alpha(214), glow=glow)
        accent = P.UI_BAD if danger else getattr(theme, "accent2", P.UI_WHITE)
        draw_text(surface, title, self._font("ui", 18, True),
                  _mix(accent, P.UI_WHITE, 0.3), (rect.x + 20, rect.y + 12))
        draw_text(surface, desc, self._font("tiny", 14),
                  getattr(theme, "text_dim", P.UI_DIM), (rect.x + 20, rect.y + 36))

    # -- rows ----------------------------------------------------------------
    def _draw_display_row(self, surface: "pygame.Surface", theme: P.Theme,
                          t: float) -> None:
        self._row_panel(surface, _ROW_DISPLAY, "DISPLAY MODE", _DISPLAY_DESC, theme)
        draw_text(surface, "F11  FULLSCREEN", self._font("tiny", 14),
                  _mix(getattr(theme, "accent", P.UI_WHITE), P.UI_WHITE, 0.2),
                  (_ROW_DISPLAY.x + 20, _ROW_DISPLAY.y + 64))

    def _draw_difficulty_row(self, surface: "pygame.Surface", theme: P.Theme,
                             t: float) -> None:
        row = _ROW_DIFF
        self._row_panel(surface, row, "DIFFICULTY", _DIFF_DESC, theme)

        # A colour bar under each chip: the mode's identity colour, lit for the
        # selected one so the choice reads without depending on the label.
        selected = self._difficulty()
        for btn in self.buttons:
            key = str(getattr(btn, "data", "") or "")
            if not key.startswith("diff:"):
                continue
            diff = get_difficulty(key[5:])
            on = diff.key == selected.key
            bar = pygame.Rect(btn.rect.x + 8, btn.rect.bottom + 5, btn.rect.w - 16, 3)
            col = diff.color if on else P.shade(diff.color, 0.35)
            pygame.draw.rect(surface, col, bar, border_radius=2)

        stakes = "{} LIVES   {:.2f}x SPEED   {}".format(
            lives_for(selected), float(selected.speed_mult),
            "SELF-COLLISION OFF" if not selected.self_kills
            else "SELF-COLLISION {}".format(str(selected.self_mode).upper()))
        draw_text(surface, selected.blurb, self._font("small", 17),
                  _mix(getattr(theme, "text", P.UI_WHITE), selected.color, 0.45),
                  (row.x + 20, row.y + 126))
        draw_text(surface, stakes, self._font("tiny", 14),
                  P.shade(selected.color, 0.9), (row.x + 20, row.y + 149))
        draw_text(surface, "x{:.2f} SCORE".format(float(selected.score_mult)),
                  self._font("tiny", 14), P.UI_GOLD,
                  (row.right - 20, row.y + 149), align="right")

    def _draw_sound_row(self, surface: "pygame.Surface", theme: P.Theme,
                        t: float) -> None:
        row = _ROW_SOUND
        self._row_panel(surface, row, "SOUND", _SOUND_DESC, theme)
        muted = self._muted()
        # A tiny bouncing level meter, flat when muted.
        base_x = row.x + 470
        for i in range(9):
            h = 3.0 if muted else 3.0 + 14.0 * pulse(t * 5.0 + i * 0.7, 1.0)
            col = P.shade(getattr(theme, "text_dim", P.UI_DIM), 0.7) if muted else \
                _mix(getattr(theme, "accent", P.UI_WHITE), P.UI_GOOD, i / 8.0)
            pygame.draw.rect(surface, col,
                             pygame.Rect(int(base_x + i * 9), int(row.y + 54 - h),
                                         5, int(h)), border_radius=2)

    def _draw_fx_row(self, surface: "pygame.Surface", theme: P.Theme,
                     t: float) -> None:
        self._row_panel(surface, _ROW_FX, "VISUAL EFFECTS", _FX_DESC, theme)

    def _draw_reset_row(self, surface: "pygame.Surface", theme: P.Theme,
                        t: float) -> None:
        row = _ROW_RESET
        if self.confirming:
            self._row_panel(surface, row, "ARE YOU SURE?", _RESET_WARN, theme,
                            glow=0.35 + 0.25 * pulse(t, 4.0), danger=True)
            draw_text(surface, "CONFIRM ERASES EVERYTHING", self._font("tiny", 14),
                      _mix(P.UI_BAD, P.UI_WHITE, 0.35 + 0.35 * pulse(t, 6.0)),
                      (row.x + 20, row.y + 62))
            return

        self._row_panel(surface, row, "RESET PROGRESS", _RESET_DESC, theme,
                        danger=True)
        try:
            save = self.game.save
            cleared, total = save.progress()
            stars, max_stars = save.total_stars(), save.max_stars()
            summary = "{} / {} LEVELS CLEARED   {} / {} STARS   BEST {:,}".format(
                int(cleared), int(total), int(stars), int(max_stars),
                int(getattr(save, "highscore", 0)))
        except Exception:
            summary = ""
        if summary:
            col = _mix(getattr(theme, "text_dim", P.UI_DIM), P.UI_GOOD,
                       0.2 + 0.6 * self.reset_flash)
            draw_text(surface, summary, self._font("tiny", 14), col,
                      (row.x + 20, row.y + 62))

    # -- preview -------------------------------------------------------------
    def _draw_preview(self, surface: "pygame.Surface", theme: P.Theme,
                      t: float) -> None:
        panel = _PREVIEW_PANEL
        draw_panel(surface, panel, theme, alpha=self._panel_alpha(216), glow=0.3)
        draw_text(surface, "PREVIEW", self._font("ui", 18, True),
                  _mix(getattr(theme, "accent2", P.UI_WHITE), P.UI_WHITE, 0.3),
                  (panel.x + 20, panel.y + 14))

        self._draw_well(surface, theme, t)

        # Hint line: the hovered switch, or a nudge to hover one.
        text = self.fx_hint or _PREVIEW_HINT
        col = _mix(getattr(theme, "text", P.UI_WHITE),
                   getattr(theme, "accent", P.UI_WHITE), 0.4) if self.fx_hint \
            else getattr(theme, "text_dim", P.UI_DIM)
        font = self._font("tiny", 14)
        y = _WELL.bottom + 14
        for line in _wrap(text, font, panel.w - 40)[:3]:
            draw_text(surface, line, font, col, (panel.x + 20, y))
            y += 18

        # Live summary of everything this screen owns.
        y = _WELL.bottom + 78
        diff = self._difficulty()
        rows: Tuple[Tuple[str, str, Sequence[int]], ...] = (
            ("DISPLAY", self._display_label(), getattr(theme, "accent", P.UI_WHITE)),
            ("DIFFICULTY", diff.label, diff.color),
            ("SOUND", "OFF" if self._muted() else "ON",
             P.UI_BAD if self._muted() else P.UI_GOOD),
            ("EFFECTS", self._effects_summary(),
             getattr(theme, "accent2", P.UI_WHITE)),
        )
        for label, value, colour in rows:
            draw_text(surface, label, self._font("tiny", 14),
                      getattr(theme, "text_dim", P.UI_DIM), (panel.x + 20, y))
            draw_text(surface, value, self._font("ui", 17, True),
                      _mix(colour, P.UI_WHITE, 0.25 + 0.35 * self.flash),
                      (panel.right - 20, y - 2), align="right")
            y += 26

    def _effects_summary(self) -> str:
        """e.g. ``"3 / 4 ON"`` - a one-glance state for the four switches."""
        on = sum(1 for key, _n, _d in _FX_TOGGLES if self._fx_flag(key))
        return "{} / {} ON".format(on, len(_FX_TOGGLES))

    def _draw_well(self, surface: "pygame.Surface", theme: P.Theme, t: float) -> None:
        """
        Render the looping snake through a miniature of the post chain.

        The demo is composed on its own opaque buffer so the bloom, scanlines
        and grain can be applied to *just* the preview - the real chain runs on
        the finished frame, which a scene must never touch.
        """
        buf = self._buf
        # The well itself is always drawn, even if the buffer went missing.
        pygame.draw.rect(surface, P.shade(getattr(theme, "bg_bottom", (6, 8, 18)), 0.9),
                         _WELL, border_radius=8)
        if buf is None or self._snake is None:
            pygame.draw.rect(surface, P.shade(getattr(theme, "grid", P.UI_DIM), 1.0),
                             _WELL, 1, border_radius=8)
            return

        # ---- content ------------------------------------------------------
        buf.fill(P.shade(getattr(theme, "bg_bottom", (6, 8, 18)), 1.05))
        grid = getattr(theme, "grid", P.UI_DIM)
        for gx in range(0, _WELL.w, 30):
            pygame.draw.line(buf, P.shade(grid, 0.55), (gx, 0), (gx, _WELL.h))
        for gy in range(0, _WELL.h, 30):
            pygame.draw.line(buf, P.shade(grid, 0.55), (0, gy), (_WELL.w, gy))
        try:
            draw_snake(buf, self._snake, theme, t)
        except Exception:
            pass

        # ---- miniature post chain -----------------------------------------
        if self._fx_flag("bloom"):
            self._apply_bloom(buf)
        if self._fx_flag("scanlines"):
            overlay = self._scanline_surface()
            if overlay is not None:
                buf.blit(overlay, (0, 0))
        if self._fx_flag("grain"):
            frames = self._grain_surfaces()
            if frames:
                buf.blit(frames[self._grain_index % len(frames)], (0, 0))

        # ---- present, with the demo camera knock --------------------------
        ox = oy = 0
        if self._shake > 0.01:
            amp = _SHAKE_PIXELS * self._shake * self._shake
            ox = int(math.sin(t * 47.0) * amp)
            oy = int(math.cos(t * 39.0) * amp * 0.8)

        prev_clip = surface.get_clip()
        try:
            area = pygame.Rect(_WELL)
            if prev_clip is not None:
                area = area.clip(prev_clip)
            surface.set_clip(area)
            surface.blit(buf, (_WELL.x + ox, _WELL.y + oy))
        except Exception:
            pass
        finally:
            try:
                surface.set_clip(prev_clip)
            except Exception:
                pass

        pygame.draw.rect(surface, P.shade(getattr(theme, "grid", P.UI_DIM), 1.2),
                         _WELL, 1, border_radius=8)

    def _apply_bloom(self, buf: "pygame.Surface") -> None:
        """
        Down/up-scale blur added back on top - the cheap bloom of the demo.

        Both scratch buffers are allocated once and re-used, the brightness
        multiply happens on the *small* copy (1/36th of the pixels) and the
        blur itself is only rebuilt every :data:`_BLOOM_EVERY` frames.
        """
        try:
            w, h = buf.get_size()
            sw = max(2, w // _BLOOM_DOWNSCALE)
            sh = max(2, h // _BLOOM_DOWNSCALE)
            if self._bloom_small is None or self._bloom_small.get_size() != (sw, sh):
                self._bloom_small = pygame.Surface((sw, sh))
                self._bloom_full = None
            if self._bloom_full is None or self._bloom_full.get_size() != (w, h):
                self._bloom_full = pygame.Surface((w, h))
                self._bloom_tick = 0        # force a rebuild on this frame

            stale = (self._bloom_tick % _BLOOM_EVERY) == 0
            self._bloom_tick += 1
            if stale:
                self._scale_into(buf, self._bloom_small)
                self._bloom_small.fill((_BLOOM_STRENGTH,) * 3,
                                       special_flags=pygame.BLEND_RGB_MULT)
                self._scale_into(self._bloom_small, self._bloom_full)
            buf.blit(self._bloom_full, (0, 0), special_flags=pygame.BLEND_RGB_ADD)
        except Exception:
            pass

    @staticmethod
    def _scale_into(src: "pygame.Surface", dst: "pygame.Surface") -> None:
        """``smoothscale`` into a pre-allocated destination, with a fallback."""
        try:
            pygame.transform.smoothscale(src, dst.get_size(), dst)
        except (TypeError, ValueError, pygame.error):
            dst.blit(pygame.transform.smoothscale(src, dst.get_size()), (0, 0))

    def _scanline_surface(self) -> Optional[pygame.Surface]:
        """Cached CRT lattice sized to the preview well."""
        if self._scanlines is not None:
            return self._scanlines
        try:
            surf = pygame.Surface(_WELL.size, pygame.SRCALPHA)
            for y in range(0, _WELL.h, 3):
                pygame.draw.line(surf, (0, 0, 0, 70), (0, y), (_WELL.w, y))
            self._scanlines = surf
        except Exception:
            self._scanlines = None
        return self._scanlines

    def _grain_surfaces(self) -> List[pygame.Surface]:
        """A handful of pre-rendered noise frames, cycled by :meth:`update`."""
        if self._grain:
            return self._grain
        frames: List[pygame.Surface] = []
        try:
            sw, sh = max(2, _WELL.w // 3), max(2, _WELL.h // 3)
            dots = max(16, (sw * sh) // 7)
            for _ in range(_GRAIN_FRAMES):
                small = pygame.Surface((sw, sh), pygame.SRCALPHA)
                for _i in range(dots):
                    x = self._rng.randrange(sw)
                    y = self._rng.randrange(sh)
                    v = self._rng.randint(90, 190)
                    small.set_at((x, y), (v, v, v, self._rng.randint(18, 46)))
                frames.append(pygame.transform.scale(small, _WELL.size))
        except Exception:
            frames = []
        self._grain = frames
        return self._grain

    # ------------------------------------------------------------------
    # Fonts
    # ------------------------------------------------------------------
    def _font(self, name: str, size: int = 18,
              bold: bool = False) -> Optional[pygame.font.Font]:
        """Fetch a FontBook face by name or size, degrading to None (ui falls back)."""
        fonts = getattr(self.game, "fonts", None)
        if fonts is None:
            return None
        try:
            if name == "display":
                return fonts.display_at(size)
            if name == "ui":
                return fonts.get(size, bold)
            got = getattr(fonts, name, None)
            if isinstance(got, pygame.font.Font):
                return got
            return fonts.get(size, bold)
        except Exception:
            return None
