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

Schema 2 adds the settings and story-mode state: the display mode, the chosen
difficulty and game mode, story progress, the narrative beats already seen and
a *per-difficulty* copy of the best-score / star tables, so that a three-star
clear on easy can never overwrite a two-star clear on expert.  A schema 1 file
is migrated forward on load (its legacy tables are adopted as the default
difficulty's records) rather than discarded.
"""

from __future__ import annotations

import json
import os
import tempfile
from dataclasses import dataclass, field
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

from .. import config as C
from .. import palette as P
from .contracts import clamp

__all__ = ["SaveData", "SCHEMA_VERSION", "LEVEL_COUNT", "MAX_STARS"]


# --------------------------------------------------------------------------
# Limits used while validating a loaded document
# --------------------------------------------------------------------------
SCHEMA_VERSION = 2

# `core.level` owns the authoritative LEVEL_COUNT, but importing it from here
# would drag the level table into the save layer for one integer.  The themes
# tuple is defined to be exactly parallel to LEVELS, so its length is the same
# number and `palette` is guaranteed dependency-free.
LEVEL_COUNT = len(P.THEMES) or 1

MAX_STARS = 3
_MAX_SCORE = 99_999_999          # sanity ceiling: keeps a doctored file sane
_MAX_COUNTER = 999_999_999
_MAX_LEVEL_KEY = 255             # bounds the size of the per-level dicts
_MAX_BEAT_KEY = 255              # bounds the size of the seen-beats list

# Difficulty keys are validated against config, with a hard-coded fallback so
# that a stripped or future config can never make the save layer explode.
_DIFFICULTIES: Tuple[str, ...] = tuple(
    str(d) for d in getattr(C, "DIFFICULTIES", ()) if isinstance(d, str)
) or ("easy", "normal", "hard", "expert")
_DEFAULT_DIFFICULTY: str = (
    str(getattr(C, "DEFAULT_DIFFICULTY", ""))
    if str(getattr(C, "DEFAULT_DIFFICULTY", "")) in _DIFFICULTIES
    else _DIFFICULTIES[0]
)

_DISPLAY_MODES: Tuple[str, ...] = tuple(
    str(m) for m in getattr(C, "DISPLAY_MODES", ()) if isinstance(m, str)
) or ("windowed", "borderless", "fullscreen")
_DEFAULT_DISPLAY_MODE: str = (
    str(getattr(C, "DEFAULT_DISPLAY_MODE", ""))
    if str(getattr(C, "DEFAULT_DISPLAY_MODE", "")) in _DISPLAY_MODES
    else _DISPLAY_MODES[0]
)

_GAME_MODES: Tuple[str, ...] = tuple(
    str(m) for m in getattr(C, "GAME_MODES", ()) if isinstance(m, str)
) or ("story", "free")
_DEFAULT_MODE: str = (
    str(getattr(C, "DEFAULT_MODE", ""))
    if str(getattr(C, "DEFAULT_MODE", "")) in _GAME_MODES
    else _GAME_MODES[0]
)

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


def _as_choice(value: Any, choices: Sequence[str], default: str) -> str:
    """Return `value` if it names one of `choices` (case/space-insensitive)."""
    if isinstance(value, str):
        text = value.strip().lower()
        for option in choices:
            if text == option.lower():
                return option
    return default


def _difficulty_key(value: Any, default: Optional[str] = None) -> Optional[str]:
    """
    Normalise a difficulty name, or return `default` (None by default) when it
    is not one of the known difficulties.
    """
    if isinstance(value, str):
        text = value.strip().lower()
        for option in _DIFFICULTIES:
            if text == option.lower():
                return option
    return default


def _empty_difficulty_table() -> Dict[str, Dict[str, int]]:
    """A fresh `{difficulty: {}}` table with every known difficulty present."""
    return {name: {} for name in _DIFFICULTIES}


def _as_difficulty_table(raw: Any, lo: int, hi: int) -> Dict[str, Dict[str, int]]:
    """
    Coerce a JSON object into `{difficulty: {level_key: int}}`.

    Every known difficulty is always present in the result (empty if the file
    said nothing about it), and unknown difficulty names are dropped, so
    callers can index the outer dict without a `.get` dance.
    """
    out = _empty_difficulty_table()
    if not isinstance(raw, Mapping):
        return out
    for key, value in raw.items():
        name = _difficulty_key(key)
        if name is None:
            continue
        inner = _as_int_dict(value, lo, hi)
        merged = out[name]
        for level_key, num in inner.items():
            previous = merged.get(level_key)
            merged[level_key] = num if previous is None else max(previous, num)
    return out


def _as_int_list(raw: Any, lo: int, hi: int) -> List[int]:
    """
    Coerce a JSON array into a sorted, de-duplicated list of clamped ints.

    Non-sequences (and strings, which are sequences of characters) become an
    empty list; unusable entries are dropped rather than defaulted.
    """
    if isinstance(raw, (str, bytes, Mapping)) or not isinstance(raw, (list, tuple)):
        return []
    seen: Dict[int, None] = {}
    for value in raw:
        if isinstance(value, bool) or not isinstance(value, (int, float, str)):
            continue
        num = _as_int(value, -1)
        if num < lo or num > hi:
            continue
        seen[num] = None
    return sorted(seen)


def _dump_difficulty_table(
    table: Any, lo: int, hi: int
) -> Dict[str, Dict[str, int]]:
    """
    Serialise a per-difficulty table back to plain JSON-safe dicts.

    Re-validates on the way out as well as on the way in, so a caller that
    poked a bad value straight into the field cannot produce a save file this
    module would then refuse to read.
    """
    validated = _as_difficulty_table(table, lo, hi)
    return {
        name: {k: int(v) for k, v in sorted(inner.items())}
        for name, inner in sorted(validated.items())
    }


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

    `best_by_difficulty` / `stars_by_difficulty` are the same tables one level
    deeper: ``{difficulty: {level_key: value}}``, with every difficulty in
    `config.DIFFICULTIES` always present.  The flat `best` / `stars` remain the
    difficulty-agnostic "best ever, however you played it" view that the older
    UI code reads, and both are kept in step by :meth:`record`.
    """

    path: str
    highscore: int = 0
    unlocked: int = 1
    best: Dict[str, int] = field(default_factory=dict)
    stars: Dict[str, int] = field(default_factory=dict)
    muted: bool = False
    total_food: int = 0
    total_deaths: int = 0

    # --- schema 2: settings ------------------------------------------------
    display_mode: str = _DEFAULT_DISPLAY_MODE
    difficulty: str = _DEFAULT_DIFFICULTY
    mode: str = _DEFAULT_MODE

    # --- schema 2: story mode ---------------------------------------------
    story_progress: int = 0          # highest story level reached, 0-based
    story_complete: bool = False
    seen_beats: List[int] = field(default_factory=list)

    # --- schema 2: per-difficulty records ----------------------------------
    best_by_difficulty: Dict[str, Dict[str, int]] = field(
        default_factory=_empty_difficulty_table)
    stars_by_difficulty: Dict[str, Dict[str, int]] = field(
        default_factory=_empty_difficulty_table)

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

        migrated = data.apply(raw)
        # An older document that was migrated forward stays dirty, so the next
        # flush() rewrites it in the current schema instead of re-migrating on
        # every launch.
        data._dirty = bool(migrated)
        return data

    def apply(self, raw: Any) -> bool:
        """
        Overwrite this profile from a decoded JSON document.

        Every field is coerced and clamped; keys that are not part of the
        schema are ignored entirely.  Safe to call with literally any object.

        Returns True when the document came from an older schema and had to be
        migrated forward (so it is worth rewriting to disk).
        """
        if not isinstance(raw, Mapping):
            return False
        try:
            version = _clamp_int(_as_int(raw.get("schema"), 0), 0, 9_999)
        except Exception:
            version = 0
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

            self.display_mode = _as_choice(
                raw.get("display_mode"), _DISPLAY_MODES, _DEFAULT_DISPLAY_MODE)
            self.difficulty = _as_choice(
                raw.get("difficulty"), _DIFFICULTIES, _DEFAULT_DIFFICULTY)
            self.mode = _as_choice(raw.get("mode"), _GAME_MODES, _DEFAULT_MODE)

            self.story_progress = _clamp_int(
                _as_int(raw.get("story_progress"), 0), 0, LEVEL_COUNT - 1)
            self.story_complete = _as_bool(raw.get("story_complete"), False)
            self.seen_beats = _as_int_list(raw.get("seen_beats"), 0, _MAX_BEAT_KEY)

            self.best_by_difficulty = _as_difficulty_table(
                raw.get("best_by_difficulty"), 0, _MAX_SCORE)
            self.stars_by_difficulty = _as_difficulty_table(
                raw.get("stars_by_difficulty"), 0, MAX_STARS)
        except Exception:
            return False

        migrated = version < SCHEMA_VERSION

        # Migration: a schema 1 file predates per-difficulty records, so its
        # flat tables are adopted as the default difficulty's history rather
        # than being thrown away.  Only ever fills gaps - a partially upgraded
        # file keeps whatever it already recorded.
        if migrated:
            self._seed_difficulty_tables(_DEFAULT_DIFFICULTY)

        # Cross-field repair: a stored high score can never be lower than the
        # best single-level score, and a level with a recorded score must be
        # unlocked.  Files edited by hand routinely break both invariants.
        for key, value in self._all_best_entries():
            if value > self.highscore:
                self.highscore = value
            idx = _as_int(key, 0)
            if idx + 1 > self.unlocked:
                self.unlocked = _clamp_int(idx + 1, 1, LEVEL_COUNT)
        self._dirty = True
        return migrated

    def _all_best_entries(self) -> List[Tuple[str, int]]:
        """Every (level_key, score) pair from the flat and per-difficulty tables."""
        out: List[Tuple[str, int]] = list(self.best.items())
        for table in self.best_by_difficulty.values():
            out.extend(table.items())
        return out

    def _seed_difficulty_tables(self, difficulty: str) -> None:
        """Copy the flat legacy tables into one difficulty, without overwriting."""
        best_table = self.best_by_difficulty.setdefault(difficulty, {})
        for key, value in self.best.items():
            if value > best_table.get(key, -1):
                best_table[key] = value
        star_table = self.stars_by_difficulty.setdefault(difficulty, {})
        for key, value in self.stars.items():
            if value > star_table.get(key, -1):
                star_table[key] = value

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
            "display_mode": _as_choice(
                self.display_mode, _DISPLAY_MODES, _DEFAULT_DISPLAY_MODE),
            "difficulty": _as_choice(
                self.difficulty, _DIFFICULTIES, _DEFAULT_DIFFICULTY),
            "mode": _as_choice(self.mode, _GAME_MODES, _DEFAULT_MODE),
            "story_progress": _clamp_int(
                _as_int(self.story_progress, 0), 0, LEVEL_COUNT - 1),
            "story_complete": bool(self.story_complete),
            "seen_beats": _as_int_list(self.seen_beats, 0, _MAX_BEAT_KEY),
            "best_by_difficulty": _dump_difficulty_table(
                self.best_by_difficulty, 0, _MAX_SCORE),
            "stars_by_difficulty": _dump_difficulty_table(
                self.stars_by_difficulty, 0, MAX_STARS),
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
    def best_for(self, level_index: int, difficulty: Optional[str] = None) -> int:
        """
        Best score recorded on a level, 0 if it has never been finished.

        With no `difficulty` this is the difficulty-agnostic best - exactly
        what it always returned.  Pass a difficulty name to ask about that
        difficulty alone; an unknown name reads as "never played".
        """
        key = _level_key(level_index)
        if key is None:
            return 0
        table = self._table_for(self.best, self.best_by_difficulty, difficulty)
        if table is None:
            return 0
        return int(table.get(key, 0))

    def stars_for(self, level_index: int, difficulty: Optional[str] = None) -> int:
        """
        Best star rating (0..MAX_STARS) earned on a level.

        `difficulty` behaves exactly as in :meth:`best_for`.
        """
        key = _level_key(level_index)
        if key is None:
            return 0
        table = self._table_for(self.stars, self.stars_by_difficulty, difficulty)
        if table is None:
            return 0
        return int(table.get(key, 0))

    @staticmethod
    def _table_for(
        flat: Dict[str, int],
        by_difficulty: Dict[str, Dict[str, int]],
        difficulty: Optional[str],
    ) -> Optional[Dict[str, int]]:
        """
        Pick the level table to read.

        None means "the flat, difficulty-agnostic table"; a valid difficulty
        name means that difficulty's table; anything else means there is no
        such table and the caller should report a zero.
        """
        if difficulty is None:
            return flat
        name = _difficulty_key(difficulty)
        if name is None:
            return None
        table = by_difficulty.get(name)
        return table if isinstance(table, dict) else {}

    def total_stars(self, difficulty: Optional[str] = None) -> int:
        """
        Sum of every level's best star rating.

        With no `difficulty` this counts the difficulty-agnostic bests, which
        is what the menus have always shown.
        """
        if difficulty is None:
            return sum(int(v) for v in self.stars.values())
        name = _difficulty_key(difficulty)
        if name is None:
            return 0
        return sum(int(v) for v in self.stars_by_difficulty.get(name, {}).values())

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

    def record(
        self,
        level_index: int,
        score: int,
        stars: int,
        difficulty: Optional[str] = None,
    ) -> bool:
        """
        Store the outcome of a finished level.

        Returns True when `score` beats the stored best for that level on the
        flat, difficulty-agnostic table (a first-ever result always counts as a
        personal best).  Stars only ever go up: a sloppy replay cannot take
        away a three-star rating.  The global high score and the unlock
        frontier are updated as a side effect, so callers only need this one
        call after a win.

        The result is also filed under a difficulty - `difficulty` when given,
        otherwise the profile's currently selected :attr:`difficulty` - so that
        a three-star easy clear never overwrites a two-star expert clear.  The
        three-argument call from before schema 2 still behaves identically as
        far as the legacy fields are concerned.
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

        # Per-difficulty history, independent of the flat tables above.
        name = _difficulty_key(
            difficulty, _difficulty_key(self.difficulty, _DEFAULT_DIFFICULTY))
        if name is not None:
            best_table = self.best_by_difficulty.setdefault(name, {})
            if score_i > best_table.get(key, -1):
                best_table[key] = score_i
                self._dirty = True
            star_table = self.stars_by_difficulty.setdefault(name, {})
            if stars_i > star_table.get(key, 0):
                star_table[key] = stars_i
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

    # ------------------------------------------------------------------
    # Settings (schema 2)
    # ------------------------------------------------------------------
    def set_display_mode(self, value: str) -> None:
        """Persist the windowed / borderless / fullscreen preference."""
        chosen = _as_choice(value, _DISPLAY_MODES, self.display_mode)
        if chosen != self.display_mode:
            self.display_mode = chosen
            self._dirty = True

    def set_difficulty(self, value: str) -> None:
        """Persist the selected difficulty; an unknown name is ignored."""
        chosen = _as_choice(value, _DIFFICULTIES, self.difficulty)
        if chosen != self.difficulty:
            self.difficulty = chosen
            self._dirty = True

    def set_mode(self, value: str) -> None:
        """Persist the selected game mode (story or free play)."""
        chosen = _as_choice(value, _GAME_MODES, self.mode)
        if chosen != self.mode:
            self.mode = chosen
            self._dirty = True

    # ------------------------------------------------------------------
    # Story mode (schema 2)
    # ------------------------------------------------------------------
    def set_story_progress(self, level_index: int) -> bool:
        """
        Remember how far the story has got, as a zero-based level index.

        Progress only ever moves forward, so replaying chapter one does not
        rewind the campaign.  Finishing the final level is a separate thing -
        call :meth:`set_story_complete` for that.  Returns True when the stored
        progress actually advanced.
        """
        idx = _clamp_int(_as_int(level_index, -1), -1, LEVEL_COUNT - 1)
        if idx < 0:
            return False
        if idx <= self.story_progress:
            return False
        self.story_progress = idx
        self._dirty = True
        return True

    def set_story_complete(self, value: bool = True) -> None:
        """Flag the campaign as finished (or un-finish it, for a fresh run)."""
        flag = _as_bool(value, False)
        if flag != self.story_complete:
            self.story_complete = flag
            self._dirty = True

    def beat_seen(self, beat_index: int) -> bool:
        """True when this narrative beat has already been shown to the player."""
        idx = _as_int(beat_index, -1)
        return idx >= 0 and idx in self.seen_beats

    def mark_beat_seen(self, beat_index: int) -> bool:
        """
        Remember that a narrative beat has been shown, so a replay can skip it.

        Returns True the first time a given beat is marked, False afterwards.
        """
        idx = _as_int(beat_index, -1)
        if idx < 0 or idx > _MAX_BEAT_KEY or idx in self.seen_beats:
            return False
        self.seen_beats.append(idx)
        self.seen_beats.sort()
        self._dirty = True
        return True

    def reset(self) -> None:
        """
        Wipe all progress, keeping the file location and the mute preference.

        Everything schema 2 added is cleared as well: the story is un-played,
        no beats have been seen, the per-difficulty tables are emptied and the
        display / difficulty / mode selections go back to their defaults.
        """
        self.highscore = 0
        self.unlocked = 1
        self.best = {}
        self.stars = {}
        self.total_food = 0
        self.total_deaths = 0
        self.display_mode = _DEFAULT_DISPLAY_MODE
        self.difficulty = _DEFAULT_DIFFICULTY
        self.mode = _DEFAULT_MODE
        self.story_progress = 0
        self.story_complete = False
        self.seen_beats = []
        self.best_by_difficulty = _empty_difficulty_table()
        self.stars_by_difficulty = _empty_difficulty_table()
        self._dirty = True
