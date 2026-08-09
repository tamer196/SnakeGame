#!/usr/bin/env python3
"""
Export every piece of authored game data from the Python game to JSON.

The TypeScript port is a translation, not a re-invention: the level layouts,
difficulty tuning, story text, colour themes and audio recipes are the
expensive, hand-tuned parts of NEON SERPENT, and they should cross over as
*data* rather than being retyped and quietly drifting.

This is the single source of truth for that transfer.  Re-run it whenever the
Python game's data changes and the web build picks the change up:

    python tools/export_data.py

Output lands in web/src/data/.  Everything is deterministic - running it twice
produces byte-identical files - so the diff is meaningful in review.
"""

from __future__ import annotations

import json
import os
import sys
from dataclasses import fields, is_dataclass
from typing import Any, Dict, List

# Make the package importable and keep pygame headless: importing the game
# pulls in modules that build surfaces at import time.
_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)
os.environ.setdefault("SDL_VIDEODRIVER", "dummy")
os.environ.setdefault("SDL_AUDIODRIVER", "dummy")
os.environ.setdefault("PYGAME_HIDE_SUPPORT_PROMPT", "1")

OUT_DIR = os.path.join(_ROOT, "web", "src", "data")


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------
def _plain(value: Any) -> Any:
    """Convert dataclasses, tuples and nested containers into JSON-safe data."""
    if is_dataclass(value) and not isinstance(value, type):
        return {f.name: _plain(getattr(value, f.name)) for f in fields(value)}
    if isinstance(value, dict):
        return {str(k): _plain(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_plain(v) for v in value]
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return str(value)


def _write(name: str, payload: Any, note: str) -> str:
    os.makedirs(OUT_DIR, exist_ok=True)
    path = os.path.join(OUT_DIR, name)
    body = {"_generated": "tools/export_data.py", "_note": note, **payload}
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(body, fh, indent=2, ensure_ascii=False, sort_keys=False)
        fh.write("\n")
    return path


# --------------------------------------------------------------------------
# exporters
# --------------------------------------------------------------------------
def export_config() -> str:
    """Every tuning constant, so the port cannot drift from the balance."""
    from snake import config as C

    skip = {"PKG_DIR", "ROOT_DIR", "ASSET_DIR", "SAVE_PATH"}
    out: Dict[str, Any] = {}
    for key in dir(C):
        if key.startswith("_") or key in skip:
            continue
        val = getattr(C, key)
        if isinstance(val, (str, int, float, bool, tuple, list, dict)):
            out[key] = _plain(val)
    return _write("config.json", {"config": out},
                  "every tuning constant from snake/config.py")


def export_themes() -> str:
    from snake import palette as P

    themes = [_plain(t) for t in P.THEMES]
    shared = {
        "UI_PANEL": P.UI_PANEL, "UI_PANEL_LIGHT": P.UI_PANEL_LIGHT,
        "UI_WHITE": P.UI_WHITE, "UI_DIM": P.UI_DIM, "UI_GOOD": P.UI_GOOD,
        "UI_WARN": P.UI_WARN, "UI_BAD": P.UI_BAD, "UI_GOLD": P.UI_GOLD,
    }
    return _write("themes.json", {"themes": themes, "ui": _plain(shared)},
                  "the 12 level colour themes and shared UI colours")


def export_levels() -> str:
    from snake.core import level as L

    levels: List[Dict[str, Any]] = []
    for lv in L.LEVELS:
        entry = {
            "index": lv.index,
            "name": lv.name,
            "subtitle": lv.subtitle,
            "themeIndex": lv.index,
            "goalFood": lv.goal_food,
            "speedMult": lv.speed_mult,
            "foodCount": lv.food_count,
            "obstacleSpec": _plain(lv.obstacle_spec),
            "powerupsEnabled": bool(lv.powerups_enabled),
            "wrapWalls": bool(lv.wrap_walls),
            "hint": lv.hint,
        }
        # Derived values are exported too: the port must reproduce them
        # exactly, so they double as test fixtures.
        for attr, key in (("cruise_speed", "cruiseSpeed"),
                          ("base_speed", "baseSpeed"),
                          ("par_score", "parScore"),
                          ("star_targets", "starTargets")):
            fn = getattr(lv, attr, None)
            if callable(fn):
                try:
                    entry[key] = _plain(fn())
                except Exception:
                    pass
        for attr, key in (("number", "number"), ("difficulty", "difficultyRating")):
            val = getattr(lv, attr, None)
            if not callable(val):
                entry[key] = _plain(val)
        levels.append(entry)

    return _write("levels.json", {"levels": levels},
                  "the 12 hand-tuned level layouts, goals and obstacle specs")


def export_difficulty() -> str:
    from snake.core import difficulty as D

    modes = [_plain(D.get_difficulty(k)) for k in D.ORDER] \
        if hasattr(D, "ORDER") else [_plain(d) for d in D.all_difficulties()]

    derived = {}
    for mode in modes:
        key = mode.get("key")
        if not key:
            continue
        d = D.get_difficulty(key)
        derived[key] = {
            "lives": D.lives_for(d),
            "selfCollisionEnabled": D.self_collision_enabled(d),
            "selfCollisionSkip": D.self_collision_skip(d),
            "selfCollisionDepth": D.self_collision_depth(d),
            "invulnSeconds": D.invuln_seconds(d),
            "comboWindow": D.combo_window(d),
            "powerupSpawnRange": _plain(D.powerup_spawn_range(d)),
        }

    return _write("difficulty.json", {"modes": modes, "derived": derived},
                  "the four difficulty modes and their derived values")


def export_story() -> str:
    from snake.core import story as S

    beats = [_plain(b) for b in S.all_beats()]
    chapters = [_plain(c) for c in getattr(S, "CHAPTERS", ())]
    extra: Dict[str, Any] = {}
    for name in ("PROLOGUE", "EPILOGUE"):
        if hasattr(S, name):
            extra[name.lower()] = _plain(getattr(S, name))

    return _write("story.json",
                  {"beats": beats, "chapters": chapters, **extra},
                  "the four-chapter narrative: 12 beats plus prologue/epilogue")


def export_audio() -> str:
    """
    Audio is synthesised, so what crosses over is the *recipe*, not samples.

    core/audio.py builds each sound from an internal signal DSL.  We cannot
    mechanically extract that, so we export the catalogue plus the source of
    each builder, and the port reimplements them with the Web Audio API.
    """
    import inspect

    from snake.core import audio as A

    names: List[str] = []
    try:
        probe = A.Audio(muted=True, headless=True)
        names = list(probe.sound_names())
        probe.shutdown()
    except Exception:
        names = ["eat", "bonus", "powerup", "hit", "die", "click",
                 "hover", "start", "levelup", "win", "boost", "portal"]

    # Each sound is built by a module-level _mk_<name> factory returning a
    # _Sig, which it fills using the tone()/noise() primitives.  Export the
    # factories *and* those primitives, since a recipe is meaningless without
    # the envelope and oscillator semantics it calls into.
    recipes: Dict[str, str] = {}
    for key, fn in vars(A).items():
        if key.startswith("_mk_") and callable(fn):
            try:
                recipes[key[4:]] = inspect.getsource(fn)
            except Exception:
                pass

    primitives: Dict[str, str] = {}
    sig_cls = getattr(A, "_Sig", None)
    if sig_cls is not None:
        for meth in ("tone", "noise", "normalise", "_env_params"):
            fn = getattr(sig_cls, meth, None)
            if callable(fn):
                try:
                    primitives[meth] = inspect.getsource(fn)
                except Exception:
                    pass

    missing = [n for n in names if n not in recipes]
    return _write("audio.json",
                  {"names": names, "recipes": recipes,
                   "primitives": primitives, "missingRecipes": missing},
                  "sound catalogue, the 12 synthesis recipes and the "
                  "tone/noise primitives they are built from")


# --------------------------------------------------------------------------
def main() -> int:
    exporters = (
        ("config", export_config),
        ("themes", export_themes),
        ("levels", export_levels),
        ("difficulty", export_difficulty),
        ("story", export_story),
        ("audio", export_audio),
    )

    failed = 0
    print(f"exporting to {OUT_DIR}")
    for name, fn in exporters:
        try:
            path = fn()
            size = os.path.getsize(path)
            print(f"  ok   {name:<11} {os.path.basename(path):<18} {size:>8,} bytes")
        except Exception as exc:  # keep going; report at the end
            failed += 1
            print(f"  FAIL {name:<11} {type(exc).__name__}: {exc}")

    if failed:
        print(f"\n{failed} exporter(s) failed")
        return 1
    print("\nall data exported")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
