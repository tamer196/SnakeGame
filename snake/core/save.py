"""
Persistent player progress for NEON SERPENT.

A single small JSON document on disk holds everything that must survive a
restart: the all-time high score, how far the player has unlocked, the best
score and star rating per level, the mute preference and a couple of lifetime
counters.

Two properties matter more than anything else here:

*   **Loading never raises.**  A missing file, a directory where the file
    should be, a file with no read permission, truncated JSON, JSON that is a
    list instead of an object, a string where an int belongs - every one of
    those cases yields a perfectly usable `SaveData` full of defaults.  A
    corrupt save must never stop somebody from playing.

*   **Saving never corrupts.**  The payload is written to a temporary file in
    the *same directory* as the target and then moved into place with
    `os.replace`, which is atomic on both POSIX and Windows for same-volume
    renames.  A crash mid-write therefore leaves either the old complete file
    or the new complete file, never a half-written one.  `save()` also never
    raises; it reports success with a bool that callers are free to ignore.

Every value read from disk is coerced and clamped on the way in, and unknown
keys are dropped, so the rest of the game can treat the fields as trustworthy
plain ints/bools/dicts without re-validating.
"""

from __future__ import annotations

import json
import os
import tempfile
from dataclasses import dataclass, field
from typing import Any, Dict, List, Mapping, Optional, Tuple

from .. import palette as P
from .contracts import clamp

__all__ = ["SaveData", "SCHEMA_VERSION", "LEVEL_COUNT", "MAX_STARS"]


# --------------------------------------------------------------------------
# Limits used while validating a loaded document
# --------------------------------------------------------------------------
SCHEMA_VERSION = 1

# `core.level` owns the authoritative LEVEL_COUNT, but importing it from here
# would drag the level table into the save layer for one integer.  The themes
# tuple is defined to be exactly parallel to LEVELS, so its length is the same
# number and `palette` is guaranteed dependency-free.
LEVEL_COUNT = len(P.THEMES) or 1

MAX_STARS = 3
_MAX_SCORE = 99_999_999          # sanity ceiling: keeps a doctored file sane
_MAX_COUNTER = 999_999_999
_MAX_LEVEL_KEY = 255             # bounds the size of the per-level dicts

_TRUE_STRINGS = frozenset({"1", "true", "yes", "on", "y", "t"})
_FALSE_STRINGS = frozenset({"0", "false", "no", "off", "n", "f", ""})


# --------------------------------------------------------------------------
# Coercion helpers - each one takes anything at all and returns a valid value
# --------------------------------------------------------------------------
def _as_int(value: Any, default: int = 0) -> int:
    """Best-effort conversion of an arbitrary JSON value to an int."""
    if isinstance(value, bool):
        return 1 if value else 0
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        # NaN and the infinities cannot be turned into an int; NaN is the only
        # float that is not equal to itself, which is the cheapest test there
        # is, and int(inf) raises OverflowError.
        if value != value or value in (float("inf"), float("-inf")):
            return default
        return int(value)
    if isinstance(value, str):
        try:
            return int(float(value.strip()))
        except (TypeError, ValueError):
            return default
    return default


def _as_bool(value: Any, default: bool = False) -> bool:
    """Best-effort conversion of an arbitrary JSON value to a bool."""
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        if value != value:  # NaN
            return default
        return value != 0
    if isinstance(value, str):
        text = value.strip().lower()
        if text in _TRUE_STRINGS:
            return True
        if text in _FALSE_STRINGS:
            return False
    return default


def _clamp_int(value: int, lo: int, hi: int) -> int:
    """Integer clamp (contracts.clamp is float-typed, so re-wrap the result)."""
    return int(clamp(float(value), float(lo), float(hi)))


def _level_key(level_index: Any) -> Optional[str]:
    """
    Normalise a per-level dict key.

    JSON object keys are always strings, but a hand-edited file might hold
    "3", 3, " 3 " or "three".  Anything that resolves to a plausible level
    index becomes the canonical `str(int)`; anything else returns None so the
    caller can drop the entry.
    """
    if isinstance(level_index, bool):
        return None
    idx = _as_int(level_index, -1)
    if idx < 0 or idx > _MAX_LEVEL_KEY:
        return None
    return str(idx)


def _as_int_dict(raw: Any, lo: int, hi: int) -> Dict[str, int]:
    """
    Coerce a JSON object into a clean `{level_key: int}` mapping.

    Non-mappings become empty dicts; entries with unusable keys or values are
    dropped rather than defaulted, because an invented "best score" is worse
    than no record at all.  Duplicate keys after normalisation (e.g. "3" and
    " 3 ") keep the larger value.
    """
    out: Dict[str, int] = {}
    if not isinstance(raw, Mapping):
        return out
    for key, value in raw.items():
        norm = _level_key(key)
        if norm is None:
            continue
        if not isinstance(value, (int, float, str, bool)):
            continue
        num = _clamp_int(_as_int(value, 0), lo, hi)
        previous = out.get(norm)
        out[norm] = num if previous is None else max(previous, num)
    return out


# --------------------------------------------------------------------------
# SaveData
# --------------------------------------------------------------------------
@dataclass
class SaveData:
    """
    The player's persistent profile.

    `path` is where this profile lives on disk; it is deliberately *not* part
    of the serialised document, so a save file can be copied or relocated
    without carrying a stale path around inside it.

    `best` and `stars` are keyed by ``str(level_index)`` because JSON object
    keys must be strings - use :meth:`best_for` / :meth:`stars_for` rather than
    indexing them directly.
    """

    path: str
    highscore: int = 0
    unlocked: int = 1
    best: Dict[str, int] = field(default_factory=dict)
    stars: Dict[str, int] = field(default_factory=dict)
    muted: bool = False
    total_food: int = 0
    total_deaths: int = 0

    # Set by every mutating helper; `flush()` uses it to skip pointless writes.
    _dirty: bool = field(default=False, init=False, repr=False, compare=False)

    # ------------------------------------------------------------------
    # Loading
    # ------------------------------------------------------------------
    @classmethod
    def load(cls, path: str) -> "SaveData":
        """
        Read the profile at `path`, falling back to defaults for anything the
        file cannot supply.  Guaranteed not to raise, for any input at all.
        """
        try:
            path_str = os.fspath(path)
        except Exception:
            path_str = ""

        data = cls(path=path_str)

        raw: Any = None
        try:
            with open(path_str, "r", encoding="utf-8") as fh:
                raw = json.load(fh)
        except (OSError, ValueError, TypeError, UnicodeDecodeError):
            # Missing, unreadable, a directory, or not valid JSON/UTF-8.
            return data
        except Exception:
            # Anything else at all (exotic filesystem errors, recursion limits
            # from pathological JSON, ...) - a fresh profile is always better
            # than a traceback on startup.
            return data

        data.apply(raw)
        data._dirty = False
        return data

    def apply(self, raw: Any) -> None:
        """
        Overwrite this profile from a decoded JSON document.

        Every field is coerced and clamped; keys that are not part of the
        schema are ignored entirely.  Safe to call with literally any object.
        """
        if not isinstance(raw, Mapping):
            return
        try:
            self.highscore = _clamp_int(_as_int(raw.get("highscore"), 0), 0, _MAX_SCORE)
            self.unlocked = _clamp_int(_as_int(raw.get("unlocked"), 1), 1, LEVEL_COUNT)
            self.best = _as_int_dict(raw.get("best"), 0, _MAX_SCORE)
            self.stars = _as_int_dict(raw.get("stars"), 0, MAX_STARS)
            self.muted = _as_bool(raw.get("muted"), False)
            self.total_food = _clamp_int(
                _as_int(raw.get("total_food"), 0), 0, _MAX_COUNTER)
            self.total_deaths = _clamp_int(
                _as_int(raw.get("total_deaths"), 0), 0, _MAX_COUNTER)
        except Exception:
            return

        # Cross-field repair: a stored high score can never be lower than the
        # best single-level score, and a level with a recorded score must be
        # unlocked.  Files edited by hand routinely break both invariants.
        for key, value in self.best.items():
            if value > self.highscore:
                self.highscore = value
            idx = _as_int(key, 0)
            if idx + 1 > self.unlocked:
                self.unlocked = _clamp_int(idx + 1, 1, LEVEL_COUNT)
        self._dirty = True

    # ------------------------------------------------------------------
    # Serialising
    # ------------------------------------------------------------------
    def to_dict(self) -> Dict[str, Any]:
        """The exact document that gets written to disk (no `path` inside)."""
        return {
            "schema": SCHEMA_VERSION,
            "highscore": int(self.highscore),
            "unlocked": int(self.unlocked),
            "best": {k: int(v) for k, v in sorted(self.best.items())},
            "stars": {k: int(v) for k, v in sorted(self.stars.items())},
            "muted": bool(self.muted),
            "total_food": int(self.total_food),
            "total_deaths": int(self.total_deaths),
        }

    def save(self) -> bool:
        """
        Write the profile atomically.  Returns True on success, False on any
        failure; never raises.

        The temporary file lives in the destination directory so that the
        final `os.replace` is a same-volume rename, which the OS performs
        atomically - a cross-device rename would silently degrade to a
        copy-then-delete and lose the guarantee.
        """
        try:
            path_str = os.fspath(self.path)
        except Exception:
            return False
        if not path_str:
            return False

        directory = os.path.dirname(os.path.abspath(path_str)) or "."
        tmp_name = ""
        try:
            os.makedirs(directory, exist_ok=True)
            payload = json.dumps(self.to_dict(), indent=2, sort_keys=True)

            fd, tmp_name = tempfile.mkstemp(
                prefix=".neon-save-", suffix=".tmp", dir=directory)
            try:
                handle = os.fdopen(fd, "w", encoding="utf-8")
            except Exception:
                # fdopen did not take ownership of the descriptor, so it is
                # still ours to close.
                try:
                    os.close(fd)
                except OSError:
                    pass
                raise
            with handle:
                handle.write(payload)
                handle.flush()
                try:
                    os.fsync(handle.fileno())
                except (OSError, ValueError):
                    # fsync is a durability nicety; some filesystems and
                    # sandboxes refuse it.  The replace below is still atomic.
                    pass

            os.replace(tmp_name, path_str)
            tmp_name = ""          # ownership transferred, nothing to clean up
            self._dirty = False
            return True
        except Exception:
            return False
        finally:
            if tmp_name:
                try:
                    os.remove(tmp_name)
                except OSError:
                    pass

    def flush(self) -> bool:
        """Save only if something changed since the last successful write."""
        if not self._dirty:
            return True
        return self.save()

    @property
    def dirty(self) -> bool:
        """True when there are unsaved changes."""
        return self._dirty

    # ------------------------------------------------------------------
    # Progress queries
    # ------------------------------------------------------------------
    def best_for(self, level_index: int) -> int:
        """Best score recorded on a level, 0 if it has never been finished."""
        key = _level_key(level_index)
        return int(self.best.get(key, 0)) if key is not None else 0

    def stars_for(self, level_index: int) -> int:
        """Best star rating (0..MAX_STARS) earned on a level."""
        key = _level_key(level_index)
        return int(self.stars.get(key, 0)) if key is not None else 0

    def total_stars(self) -> int:
        """Sum of every level's best star rating."""
        return sum(int(v) for v in self.stars.values())

    def max_stars(self) -> int:
        """How many stars exist in the whole game."""
        return LEVEL_COUNT * MAX_STARS

    def is_unlocked(self, level_index: int) -> bool:
        """True when the player may select this zero-based level index."""
        idx = _as_int(level_index, -1)
        return 0 <= idx < self.unlocked

    def completed(self, level_index: int) -> bool:
        """True when a score has ever been recorded for this level."""
        key = _level_key(level_index)
        return key is not None and key in self.best

    def cleared_levels(self) -> List[int]:
        """Sorted indices of every level with a recorded score."""
        out: List[int] = []
        for key in self.best:
            idx = _as_int(key, -1)
            if idx >= 0:
                out.append(idx)
        out.sort()
        return out

    def progress(self) -> Tuple[int, int]:
        """(levels cleared, total levels) - handy for a menu completion bar."""
        return (len(self.best), LEVEL_COUNT)

    # ------------------------------------------------------------------
    # Progress mutation
    # ------------------------------------------------------------------
    def unlock_through(self, level_index: int) -> bool:
        """
        Make every level up to *and including* `level_index` selectable.

        Returns True when this actually unlocked something new.
        """
        idx = _as_int(level_index, -1)
        if idx < 0:
            return False
        target = _clamp_int(idx + 1, 1, LEVEL_COUNT)
        if target <= self.unlocked:
            return False
        self.unlocked = target
        self._dirty = True
        return True

    def record(self, level_index: int, score: int, stars: int) -> bool:
        """
        Store the outcome of a finished level.

        Returns True when `score` beats the stored best for that level (a
        first-ever result always counts as a personal best).  Stars only ever
        go up: a sloppy replay cannot take away a three-star rating.  The
        global high score and the unlock frontier are updated as a side
        effect, so callers only need this one call after a win.
        """
        key = _level_key(level_index)
        score_i = _clamp_int(_as_int(score, 0), 0, _MAX_SCORE)
        stars_i = _clamp_int(_as_int(stars, 0), 0, MAX_STARS)

        if score_i > self.highscore:
            self.highscore = score_i
            self._dirty = True

        if key is None:
            return False

        previous = self.best.get(key)
        improved = previous is None or score_i > previous
        if improved:
            self.best[key] = score_i
            self._dirty = True

        if stars_i > self.stars.get(key, 0):
            self.stars[key] = stars_i
            self._dirty = True

        # Finishing a level opens the next one.
        self.unlock_through(_as_int(level_index, 0) + 1)
        return improved

    def add_food(self, count: int = 1) -> None:
        """Bump the lifetime food counter."""
        n = _as_int(count, 0)
        if n <= 0:
            return
        self.total_food = _clamp_int(self.total_food + n, 0, _MAX_COUNTER)
        self._dirty = True

    def add_death(self, count: int = 1) -> None:
        """Bump the lifetime death counter."""
        n = _as_int(count, 0)
        if n <= 0:
            return
        self.total_deaths = _clamp_int(self.total_deaths + n, 0, _MAX_COUNTER)
        self._dirty = True

    def set_muted(self, value: bool) -> None:
        """Persist the audio mute preference."""
        flag = _as_bool(value, False)
        if flag != self.muted:
            self.muted = flag
            self._dirty = True

    def reset(self) -> None:
        """Wipe all progress, keeping the file location and mute preference."""
        self.highscore = 0
        self.unlocked = 1
        self.best = {}
        self.stars = {}
        self.total_food = 0
        self.total_deaths = 0
        self._dirty = True
