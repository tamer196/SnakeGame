"""
The pause overlay for NEON SERPENT.

`PauseScene` is a *transparent* scene: the gameplay scene underneath keeps
being drawn (frozen, because `blocks_update` stops it receiving `update`) and
this scene paints on top of it.

The frozen frame is snapshotted **once** in `on_enter`, cheaply blurred with a
downscale/upscale round trip and then blitted every frame under a translucent
scrim.  Doing the blur per frame would cost a full-screen smoothscale pair on
every tick for no visible benefit - the frame behind never changes while we are
paused.

Every action is reachable with the mouse alone; Esc / P / Space are shortcuts.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

import pygame

from .. import config as C
from .. import palette as P
from ..core.contracts import Scene, clamp, ease_out_back, ease_out_cubic, pulse
from ..gfx.ui import Button, draw_panel, draw_text

__all__ = ["PauseScene"]

# Panel geometry -----------------------------------------------------------
_PANEL_W = 470
# 168 px of title block + six 54 px buttons on an 11 px pitch (379 px) + the
# three-line control reminder (76 px) + padding.  At the old 528 the reminder
# was printed straight through the QUIT TO MENU button; v2 added a sixth
# button (SETTINGS) which is why this grew again.
_PANEL_H = 646
_BTN_W = C.UI_BUTTON_W
_BTN_H = 54
_BTN_GAP = 11

#: How aggressively the frozen frame is blurred (bigger = blurrier + cheaper).
_BLUR_DOWNSCALE = 7

#: Seconds the panel takes to fly in.
_INTRO_TIME = 0.34

_HINTS: Tuple[str, ...] = (
    "MOVE   steer with the mouse",
    "BOOST  hold the right mouse button",
    "PAUSE  Esc or P",
)


class PauseScene(Scene):
    """Modal overlay stacked on top of the (frozen) gameplay scene."""

    transparent: bool = True     # the scene below is still drawn
    blocks_update: bool = True   # ...but it does not advance

    def __init__(self, game: Any) -> None:
        super().__init__(game)
        self.t: float = 0.0                       # local clock, for animation
        self.intro: float = 0.0                   # 0..1 fly-in weight
        self.level_index: int = 0
        self.level_name: str = ""
        self.buttons: List[Button] = []
        self._base_y: Dict[int, int] = {}         # id(button) -> resting centery
        self._blur: Optional[pygame.Surface] = None
        self._closing: bool = False               # guards double activation

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------
    def on_enter(self, **kwargs: Any) -> None:
        """Scenes are cached and reused, so every field is rebuilt here."""
        self.t = 0.0
        self.intro = 0.0
        self._closing = False
        self.level_index = self._resolve_level_index(kwargs.get("level_index"))
        self.level_name = self._resolve_level_name(kwargs.get("level_name"))
        self._blur = self._snapshot_blur()
        self._build_buttons()

    def on_exit(self) -> None:
        # Drop the snapshot: it is a full-screen surface and is invalid the
        # moment the frame behind us changes.
        self._blur = None
        self._closing = False

    # -- helpers used by on_enter ---------------------------------------
    def _resolve_level_index(self, override: Any) -> int:
        try:
            if override is not None:
                return max(0, int(override))
            return max(0, int(getattr(self.game, "level_index", 0)))
        except Exception:
            return 0

    def _resolve_level_name(self, override: Any) -> str:
        if override:
            return str(override)
        try:
            from ..core.level import get_level
            return str(get_level(self.level_index).name)
        except Exception:
            try:
                return str(P.theme_for_level(self.level_index).name)
            except Exception:
                return ""

    def _snapshot_blur(self) -> Optional[pygame.Surface]:
        """
        Grab the last rendered frame and blur it once.

        `smoothscale` down then back up is a box blur for free - the hardware
        filter does the averaging.  Two scales of a 1280x720 surface is well
        under a millisecond, and we only ever pay it on entry.
        """
        try:
            canvas = getattr(self.game, "canvas", None)
            if canvas is None:
                return None
            w, h = canvas.get_size()
            if w < 8 or h < 8:
                return None
            small = pygame.transform.smoothscale(
                canvas, (max(2, w // _BLUR_DOWNSCALE), max(2, h // _BLUR_DOWNSCALE)))
            # A second down/up pass widens the kernel without extra cost.
            blurred = pygame.transform.smoothscale(small, (w, h))
            return blurred.convert() if blurred.get_alpha() is None else blurred
        except Exception:
            return None

    # ------------------------------------------------------------------
    # Buttons
    # ------------------------------------------------------------------
    def _panel_rect(self) -> pygame.Rect:
        r = pygame.Rect(0, 0, _PANEL_W, _PANEL_H)
        r.center = (C.WINDOW_W // 2, C.WINDOW_H // 2)
        return r

    def _build_buttons(self) -> None:
        panel = self._panel_rect()
        cx = panel.centerx
        top = panel.y + 168          # below the title block

        specs: List[Tuple[str, str, str]] = [
            ("resume", "RESUME", "primary"),
            ("restart", "RESTART LEVEL", "ghost"),
            ("sound", self._sound_label(), "ghost"),
            ("settings", "SETTINGS", "ghost"),
            ("levels", "LEVEL SELECT", "ghost"),
            ("menu", "QUIT TO MENU", "danger"),
        ]

        self.buttons = []
        self._base_y = {}
        for i, (key, label, style) in enumerate(specs):
            rect = pygame.Rect(0, 0, _BTN_W, _BTN_H)
            rect.center = (cx, top + i * (_BTN_H + _BTN_GAP) + _BTN_H // 2)
            btn = Button(rect, label, style=style, data=key)
            self.buttons.append(btn)
            self._base_y[id(btn)] = rect.centery

    def _sound_label(self) -> str:
        return "SOUND:  OFF" if self._muted() else "SOUND:  ON"

    def _muted(self) -> bool:
        try:
            return bool(getattr(self.game.audio, "muted", False))
        except Exception:
            return False

    # ------------------------------------------------------------------
    # Actions
    # ------------------------------------------------------------------
    def _click(self, name: str = "click") -> None:
        try:
            self.game.audio.play(name)
        except Exception:
            pass

    def _activate(self, key: str) -> None:
        """Run the action behind a button (or a keyboard shortcut)."""
        if self._closing and key != "sound":
            return
        try:
            if key == "resume":
                self._closing = True
                self._click("click")
                self.game.pop_scene()
            elif key == "restart":
                self._closing = True
                self._click("start")
                self._restart()
            elif key == "sound":
                self._toggle_sound()
            elif key == "settings":
                self._open_settings()
            elif key == "levels":
                self._closing = True
                self._click("click")
                self.game.switch_scene(C.SCENE_LEVELS)
            elif key == "menu":
                self._closing = True
                self._click("click")
                self.game.switch_scene(C.SCENE_MENU)
        except Exception:
            # An overlay must never take the game down with it.
            self._closing = False

    def _restart(self) -> None:
        """Re-enter gameplay on the same level."""
        idx = self.level_index
        try:
            self.game.level_index = idx
        except Exception:
            pass
        try:
            self.game.switch_scene(C.SCENE_GAME, level_index=idx)
        except TypeError:
            # GameplayScene.on_enter may not take the kwarg; game.level_index
            # was already set above, so a bare switch restarts the same level.
            self.game.switch_scene(C.SCENE_GAME)

    def _open_settings(self) -> None:
        """
        Stack the settings screen on top of the pause overlay.

        Deliberately a *push*, not a switch: the run underneath must survive a
        detour into the options, and `SettingsScene` pops itself when it is the
        top of a stack deeper than one.  `_closing` is left alone for the same
        reason - this overlay is not going away, so re-arming it would leave
        every pause button dead when settings pops back.
        """
        self._click("click")
        try:
            self.game.push_scene(C.SCENE_SETTINGS, back=C.SCENE_PAUSE)
        except TypeError:
            # A settings scene that does not accept the kwarg still opens.
            self.game.push_scene(C.SCENE_SETTINGS)

    def _sync_sound_label(self) -> None:
        """Re-read the mute state into the SOUND button's label."""
        for btn in self.buttons:
            if btn.data == "sound":
                btn.label = self._sound_label()

    def _toggle_sound(self) -> None:
        """Flip mute, persist the preference and relabel the button."""
        muted = False
        try:
            muted = bool(self.game.audio.toggle_mute())
        except Exception:
            pass
        try:
            self.game.save.set_muted(muted)
            self.game.save.save()
        except Exception:
            pass
        if not muted:
            self._click("click")     # audible confirmation only when unmuted
        self._sync_sound_label()

    # ------------------------------------------------------------------
    # Input
    # ------------------------------------------------------------------
    def handle_event(self, event: "pygame.event.Event") -> None:
        try:
            for btn in self.buttons:
                if btn.handle_event(event):
                    self._activate(str(btn.data))
                    return
            if event.type == pygame.KEYDOWN:
                key = getattr(event, "key", None)
                if key in (pygame.K_ESCAPE, pygame.K_p, pygame.K_SPACE):
                    self._activate("resume")
                elif key == pygame.K_r:
                    self._activate("restart")
                elif key == pygame.K_m:
                    self._activate("sound")
                elif key in (pygame.K_s, pygame.K_o):
                    self._activate("settings")
        except Exception:
            pass

    # ------------------------------------------------------------------
    # Update
    # ------------------------------------------------------------------
    def update(self, dt: float) -> None:
        try:
            dt = clamp(float(dt), 0.0, C.MAX_DT)
            self.t += dt
            if self.intro < 1.0:
                self.intro = clamp(self.intro + dt / _INTRO_TIME, 0.0, 1.0)

            # ease_out_back overshoots slightly, so the panel settles with a
            # little bounce.  Buttons ride the same offset, which keeps their
            # hit rects exactly where they are drawn.
            offset = int(round((1.0 - ease_out_back(self.intro)) * 46.0))
            # The settings screen can be stacked on top of this one and flip
            # mute while it is there, so the label is re-read rather than only
            # written by our own toggle.
            self._sync_sound_label()
            mouse = getattr(self.game, "mouse_pos", (0.0, 0.0))
            for btn in self.buttons:
                base = self._base_y.get(id(btn), btn.rect.centery)
                btn.rect.centery = base + offset
                was_hovered = btn.hovered
                btn.update(dt, mouse)
                if btn.hovered and not was_hovered:
                    self._click("hover")
        except Exception:
            pass

    # ------------------------------------------------------------------
    # Draw
    # ------------------------------------------------------------------
    def draw(self, surface: "pygame.Surface") -> None:
        prev_clip = None
        try:
            prev_clip = surface.get_clip()
            surface.set_clip(None)
            self._draw_impl(surface)
        except Exception:
            pass
        finally:
            try:
                surface.set_clip(prev_clip)
            except Exception:
                pass

    def _draw_impl(self, surface: "pygame.Surface") -> None:
        theme = self._theme()
        fonts = getattr(self.game, "fonts", None)
        fade = ease_out_cubic(self.intro)

        # ---- frozen frame: blurred copy, then a darkening scrim -----------
        if self._blur is not None:
            self._blur.set_alpha(int(255 * clamp(fade, 0.0, 1.0)))
            surface.blit(self._blur, (0, 0))
            self._blur.set_alpha(255)
        scrim = pygame.Surface(surface.get_size(), pygame.SRCALPHA)
        scrim.fill(P.with_alpha(P.shade(theme.bg_bottom, 0.55), int(168 * fade)))
        surface.blit(scrim, (0, 0))

        panel = self._panel_rect()
        offset = int(round((1.0 - ease_out_back(self.intro)) * 46.0))
        panel.y += offset

        # ---- panel --------------------------------------------------------
        draw_panel(surface, panel, theme, alpha=int(232 * fade),
                   glow=0.45 + 0.25 * pulse(self.t, 1.8))

        cx = panel.centerx
        accent = theme.accent
        accent2 = theme.accent2

        # ---- title --------------------------------------------------------
        title_font = self._font(fonts, "display", 74)
        breathe = 0.6 + 0.4 * pulse(self.t, 2.2)
        draw_text(surface, "PAUSED", title_font,
                  P.lerp_color(accent, P.UI_WHITE, 0.25 + 0.35 * breathe),
                  (cx, panel.y + 30), align="center")

        # Divider under the title, widening as the panel lands.
        line_w = int((_PANEL_W - 120) * fade)
        if line_w > 4:
            ly = panel.y + 118
            bar = pygame.Surface((line_w, 2), pygame.SRCALPHA)
            for x in range(line_w):
                f = x / max(1, line_w - 1)
                # Fade out at both ends so the rule has no hard edges.
                a = int(200 * (1.0 - abs(f - 0.5) * 2.0) ** 0.6)
                bar.fill(P.with_alpha(P.lerp_color(accent, accent2, f), a),
                         pygame.Rect(x, 0, 1, 2))
            surface.blit(bar, (cx - line_w // 2, ly))

        # ---- level caption -------------------------------------------------
        caption = self.level_name.upper() if self.level_name else "IN PLAY"
        draw_text(surface, f"LEVEL {self.level_index + 1:02d}",
                  self._font(fonts, "tiny", 14), theme.text_dim,
                  (cx, panel.y + 94), align="center")
        draw_text(surface, caption, self._font(fonts, "body", 22),
                  P.lerp_color(theme.text, accent2, 0.35),
                  (cx, panel.y + 128), align="center")

        # ---- buttons -------------------------------------------------------
        for btn in self.buttons:
            btn.draw(surface, theme, fonts, self.t)

        # ---- control reminder ---------------------------------------------
        hint_font = self._font(fonts, "tiny", 14)
        # Sits under the last button: 168 + 5*54 + 4*11 = 482 px of content, so
        # anchoring to the panel bottom has to leave the three lines room.
        hy = panel.bottom - 76
        for i, line in enumerate(_HINTS):
            draw_text(surface, line, hint_font,
                      P.shade(theme.text_dim, 0.95 - 0.12 * i),
                      (cx, hy + i * 19), align="center")

    # ------------------------------------------------------------------
    # Small utilities
    # ------------------------------------------------------------------
    def _theme(self) -> P.Theme:
        try:
            return P.theme_for_level(self.level_index)
        except Exception:
            return P.THEMES[0]

    def _font(self, fonts: Any, name: str, size: int) -> Optional[pygame.font.Font]:
        """Fetch a FontBook face, degrading gracefully if it is missing."""
        try:
            if name == "display":
                return fonts.display_at(size)
            got = getattr(fonts, name, None)
            if isinstance(got, pygame.font.Font):
                return got
            return fonts.get(size)
        except Exception:
            return None
