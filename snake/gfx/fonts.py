"""
Font loading with graceful fallback.

The game ships no font files, so we pick the best-looking face that the host
system actually has and fall back through a preference list.  Every lookup is
cached: building a `pygame.font.Font` is expensive and we do it from render
code paths.
"""

from __future__ import annotations

from typing import Dict, Optional, Sequence, Tuple

import pygame

# Preference lists, best first.  `SysFont` matches loosely, so these cover
# Windows, macOS and most Linux desktops between them.
DISPLAY_FACES: Sequence[str] = (
    "bahnschrift", "impact", "franklingothicheavy", "arialblack",
    "helveticaneue", "dejavusans", "verdana", "arial",
)
UI_FACES: Sequence[str] = (
    "segoeui", "selawik", "helveticaneue", "roboto",
    "dejavusans", "verdana", "arial",
)
MONO_FACES: Sequence[str] = (
    "consolas", "cascadiamono", "menlo", "dejavusansmono",
    "liberationmono", "couriernew", "monospace",
)


def _pick(faces: Sequence[str]) -> Optional[str]:
    """Return the first face in `faces` that this system actually has."""
    try:
        available = set(pygame.font.get_fonts())
    except Exception:
        return None
    for face in faces:
        if face in available:
            return face
    return None


class FontBook:
    """
    Named font sizes for the whole game.

    Access the common ones as attributes (`fonts.title`, `fonts.body`, ...) or
    ask for an arbitrary size with `fonts.get(28)` / `fonts.mono_at(15)`.
    """

    def __init__(self) -> None:
        if not pygame.font.get_init():
            pygame.font.init()

        self._display_face = _pick(DISPLAY_FACES)
        self._ui_face = _pick(UI_FACES)
        self._mono_face = _pick(MONO_FACES)

        self._cache: Dict[Tuple[str, int, bool], pygame.font.Font] = {}

        # The named ladder used across menus and the HUD.
        self.huge = self.display_at(96)
        self.title = self.display_at(64)
        self.h1 = self.display_at(42)
        self.h2 = self.get(30, bold=True)
        self.body = self.get(21)
        self.small = self.get(17)
        self.tiny = self.get(14)
        self.mono = self.mono_at(16)
        self.mono_small = self.mono_at(13)

    # -- builders ----------------------------------------------------------
    def _build(self, face: Optional[str], size: int, bold: bool) -> pygame.font.Font:
        key = (face or "", size, bold)
        cached = self._cache.get(key)
        if cached is not None:
            return cached

        font: Optional[pygame.font.Font] = None
        if face:
            try:
                font = pygame.font.SysFont(face, size, bold=bold)
            except Exception:
                font = None
        if font is None:
            # pygame's bundled default always works.
            font = pygame.font.Font(None, int(size * 1.15))
            if bold:
                try:
                    font.set_bold(True)
                except Exception:
                    pass

        self._cache[key] = font
        return font

    def get(self, size: int, bold: bool = False) -> pygame.font.Font:
        """A UI-face font at an arbitrary size."""
        return self._build(self._ui_face, size, bold)

    def display_at(self, size: int) -> pygame.font.Font:
        """A heavy display-face font, for titles and big numbers."""
        return self._build(self._display_face, size, True)

    def mono_at(self, size: int, bold: bool = False) -> pygame.font.Font:
        """A monospaced font, for stats and debug readouts."""
        return self._build(self._mono_face, size, bold)

    # -- convenience -------------------------------------------------------
    def measure(self, font: pygame.font.Font, text: str) -> Tuple[int, int]:
        try:
            return font.size(text)
        except Exception:
            return (0, 0)
