#!/usr/bin/env python3
"""
NEON SERPENT launcher.

    python run_game.py

Keeping the entry point at the repository root means the `snake` package is
importable without installing anything.
"""

from __future__ import annotations

import os
import sys

# Make sure the repo root is importable even when launched from elsewhere.
_ROOT = os.path.dirname(os.path.abspath(__file__))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

# Centre the window and quieten pygame's banner before it is imported.
os.environ.setdefault("PYGAME_HIDE_SUPPORT_PROMPT", "1")
os.environ.setdefault("SDL_VIDEO_CENTERED", "1")


def _check_pygame() -> bool:
    try:
        import pygame  # noqa: F401
    except ImportError:
        sys.stderr.write(
            "\n  pygame is not installed.\n\n"
            "  Install the dependencies first:\n\n"
            "      pip install -r requirements.txt\n\n"
        )
        return False
    return True


if __name__ == "__main__":
    if not _check_pygame():
        raise SystemExit(2)
    from snake.main import main

    raise SystemExit(main())
