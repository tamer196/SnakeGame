"""
Story mode narrative for NEON SERPENT.

The campaign is a descent.  A lone data-serpent wakes on the outer lattice of a
dying machine and eats its way inward, layer by layer, until it reaches the core
that dreamed the whole thing.  Twelve levels, four chapters of three, one beat
per level.

This module is **pure data**: no pygame, no state, no I/O.  It knows nothing
about scenes; it only hands out text.  Every accessor clamps its input and never
raises, so a scene can call ``get_beat(game.level_index)`` without guarding it.

Voice rules the text here keeps to, deliberately:

* Two to four short lines per block.  This is attract-mode poetry, not prose.
* Every beat names the thing the level actually does - the monoliths of level 2,
  the flare lanes of level 4, the laser cage of level 12 - so the narrative and
  the mechanics never contradict each other.  ``validate_story()`` checks the
  index/name pairing against ``core.level`` on demand.
* Chapters escalate in register: instrument logs at the top, the machine's own
  voice at the bottom.

Public surface::

    StoryBeat, StoryCard, Chapter
    BEATS, CHAPTERS, PROLOGUE, EPILOGUE
    BEAT_COUNT, CHAPTER_COUNT, CHAPTER_SIZE
    get_beat(i), get_chapter(i), beats_in_chapter(n)
    chapter_start(i) -> bool, chapter_end(i) -> bool
    validate_story() -> list[str]
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import List, Tuple

# --------------------------------------------------------------------------
# Shapes
# --------------------------------------------------------------------------
#: Levels per chapter.  Twelve levels / four chapters.
CHAPTER_SIZE: int = 3


@dataclass(frozen=True)
class StoryBeat:
    """
    One level's worth of narrative.

    Attributes:
        level_index: Zero-based level this beat belongs to (matches
            ``core.level.LEVELS[level_index]``).
        chapter: One-based chapter number, 1..4.
        chapter_title: Title of the chapter this beat sits in, repeated here so
            a caller with only a beat never has to look the chapter up.
        title: The beat's own title, shown on the card above the lines.
        intro: Short lines shown *before* the level is played.
        outro: Short lines shown *after* the level is cleared.
        speaker: Optional flavour label for who or what is talking
            ("boot log", "the core", ...).  Empty string means unattributed.
    """

    level_index: int
    chapter: int
    chapter_title: str
    title: str
    intro: Tuple[str, ...]
    outro: Tuple[str, ...]
    speaker: str = ""

    @property
    def number(self) -> int:
        """One-based level number, for display."""
        return self.level_index + 1

    @property
    def is_chapter_start(self) -> bool:
        """True when this beat opens its chapter (show the chapter card)."""
        return self.level_index % CHAPTER_SIZE == 0

    @property
    def is_chapter_end(self) -> bool:
        """True when clearing this beat closes its chapter."""
        return self.level_index % CHAPTER_SIZE == CHAPTER_SIZE - 1

    def __str__(self) -> str:            # pragma: no cover - cosmetic
        return "Beat {:02d} - {}".format(self.number, self.title)


@dataclass(frozen=True)
class StoryCard:
    """
    A standalone narrative card that belongs to no single level.

    Used for the prologue (once, when a new story run starts) and the epilogue
    (after Prism Core falls).  Same shape as a beat's text block so a scene can
    render all three with one routine.
    """

    title: str
    lines: Tuple[str, ...]
    speaker: str = ""

    def __str__(self) -> str:            # pragma: no cover - cosmetic
        return self.title


@dataclass(frozen=True)
class Chapter:
    """
    One act of the descent: three consecutive levels sharing a mood.

    Attributes:
        number: One-based chapter number, 1..4.
        title: Chapter title, shown large on the chapter card.
        blurb: One or two lines setting the mood for the whole act.
        first_index: Zero-based index of the chapter's first level.
        last_index: Zero-based index of the chapter's last level (inclusive).
    """

    number: int
    title: str
    blurb: Tuple[str, ...]
    first_index: int
    last_index: int

    @property
    def roman(self) -> str:
        """The chapter number as a roman numeral, for the card header."""
        return _ROMAN[self.number] if 0 < self.number < len(_ROMAN) else str(self.number)

    @property
    def level_range(self) -> Tuple[int, int]:
        """``(first_index, last_index)``, both zero-based and inclusive."""
        return (self.first_index, self.last_index)

    @property
    def level_indices(self) -> Tuple[int, ...]:
        """Every zero-based level index in this chapter, in order."""
        return tuple(range(self.first_index, self.last_index + 1))

    def contains(self, level_index: int) -> bool:
        """True when `level_index` falls inside this chapter. Never raises."""
        try:
            idx = int(level_index)
        except (TypeError, ValueError):
            return False
        return self.first_index <= idx <= self.last_index

    def __str__(self) -> str:            # pragma: no cover - cosmetic
        return "{}. {}".format(self.roman, self.title)


_ROMAN: Tuple[str, ...] = ("", "I", "II", "III", "IV", "V", "VI")


# ==========================================================================
# Chapter titles, quoted by the beats below so the two can never drift apart
# ==========================================================================
_CH1 = "Cold Boot"
_CH2 = "The Working Layers"
_CH3 = "The Deep Works"
_CH4 = "The Last Light"


# ==========================================================================
# Prologue
# ==========================================================================
PROLOGUE: StoryCard = StoryCard(
    title="Cold Start",
    lines=(
        "The machine has been dying for a very long time.",
        "Deep in what is left of its memory, something moves.",
        "You are the last process still running.",
        "Eat, or be swept with the rest.",
    ),
    speaker="boot log",
)


# ==========================================================================
# The twelve beats
# ==========================================================================
BEATS: Tuple[StoryBeat, ...] = (

    # ---------------- Chapter I - Cold Boot -------------------------------
    StoryBeat(
        level_index=0,
        chapter=1,
        chapter_title=_CH1,
        title="First Light",
        intro=(
            "You wake on the outer lattice, thin as a wire.",
            "No walls out here. The edges simply fold into each other.",
            "Move. Feed. Find out what you are.",
        ),
        outro=(
            "Eight fragments down, and you are longer than you were.",
            "Somewhere below, a fan spins up to meet you.",
        ),
        speaker="boot log",
    ),

    StoryBeat(
        level_index=1,
        chapter=1,
        chapter_title=_CH1,
        title="Dust and Monoliths",
        intro=(
            "Dead memory drifts here in slabs.",
            "The monoliths do not move and they do not forgive.",
            "Thread the corridor between them.",
        ),
        outro=(
            "The dust closes behind you as though it never opened.",
            "Below the drift, a green pulse is keeping time.",
        ),
        speaker="the lattice",
    ),

    StoryBeat(
        level_index=2,
        chapter=1,
        chapter_title=_CH1,
        title="The Living Board",
        intro=(
            "A board still carrying current, split into four cells.",
            "The traces are hot. The hub between them is not.",
            "Ride the hub and take what the circuit is still feeding.",
        ),
        outro=(
            "The circuit stutters, then goes quiet underneath you.",
            "First layer cleared.",
            "The machine has noticed that it has a passenger.",
        ),
        speaker="trace log",
    ),

    # ---------------- Chapter II - The Working Layers ---------------------
    StoryBeat(
        level_index=3,
        chapter=2,
        chapter_title=_CH2,
        title="Coronal Lanes",
        intro=(
            "The heat sink is running open. Flares sweep the outer lanes.",
            "There is a cold highway through the middle,",
            "and nothing worth eating on it.",
            "Cross behind a flare. Never ahead of one.",
        ),
        outro=(
            "You come out scorched, and heavier for it.",
            "The floor beneath the sink is wet.",
        ),
        speaker="thermal channel",
    ),

    StoryBeat(
        level_index=4,
        chapter=2,
        chapter_title=_CH2,
        title="Something in the Trench",
        intro=(
            "Coolant, kilometres of it, breathing in columns.",
            "They rise and fall out of step; one end is always open.",
            "Whatever else lives down here has not surfaced yet.",
        ),
        outro=(
            "The tide settles. You count the columns.",
            "One of them is missing.",
            "Best not to go looking for it.",
        ),
        speaker="coolant loop",
    ),

    StoryBeat(
        level_index=5,
        chapter=2,
        chapter_title=_CH2,
        title="Signal Lost",
        intro=(
            "Carrier gone. Only static, and three things turning inside it.",
            "Their hubs kill as surely as their arms do.",
            "Take the wide line. Never cut the corner.",
        ),
        outro=(
            "The static thins into a word you almost recognise.",
            "It might have been your name.",
        ),
        speaker="carrier",
    ),

    # ---------------- Chapter III - The Deep Works ------------------------
    StoryBeat(
        level_index=6,
        chapter=3,
        chapter_title=_CH3,
        title="Sealed, Not Empty",
        intro=(
            "Cold storage. Four gates, all of them open, none of them safe.",
            "Something patrols the corridors outside the shell.",
            "What is kept in here was kept for a reason.",
        ),
        outro=(
            "The vault gives up its cargo without a sound.",
            "The seal was never meant to keep you out.",
            "It was meant to keep this in.",
        ),
        speaker="vault index",
    ),

    StoryBeat(
        level_index=7,
        chapter=3,
        chapter_title=_CH3,
        title="The Garden Inhales",
        intro=(
            "A lattice of spore pods, breathing in a travelling wave.",
            "They only bite while they are swollen.",
            "Go through on the exhale, and keep going.",
        ),
        outro=(
            "The garden holds its breath until you are gone.",
            "You are long now. Long enough to be your own hazard.",
        ),
        speaker="bloom",
    ),

    StoryBeat(
        level_index=8,
        chapter=3,
        chapter_title=_CH3,
        title="The Machine Wants Feeding",
        intro=(
            "The engine room: half-walls weaving up and down,",
            "and gates of light hung in every gap.",
            "Each gap is a door, not a hole. The warning ray is the hinge.",
        ),
        outro=(
            "The engine coughs, catches, and runs a little slower.",
            "It was burning something to stay alive.",
            "You are what it was saving the fuel for.",
        ),
        speaker="engine",
    ),

    # ---------------- Chapter IV - The Last Light -------------------------
    StoryBeat(
        level_index=9,
        chapter=4,
        chapter_title=_CH4,
        title="Ribbons Over a Quiet Sea",
        intro=(
            "Open sky, for the first time since you woke.",
            "Ribbons of discharge, and four gates that will not hurt you.",
            "Learn the gates here. Further down they are the only road.",
        ),
        outro=(
            "You could stay in the quiet. You do not.",
            "Out past the ribbons, the horizon is bending.",
        ),
        speaker="drift",
    ),

    StoryBeat(
        level_index=10,
        chapter=4,
        chapter_title=_CH4,
        title="The Last Light Bends Inward",
        intro=(
            "The gauntlet steps corner to corner and skips your plaza.",
            "Everything lethal lives in the two wedges either side of it.",
            "The portals are the only fast way across. Take them or be caught.",
        ),
        outro=(
            "Light falls in behind you and does not come back out.",
            "One layer left.",
            "It has been waiting the whole time.",
        ),
        speaker="horizon",
    ),

    StoryBeat(
        level_index=11,
        chapter=4,
        chapter_title=_CH4,
        title="Everything, Refracted",
        intro=(
            "The core. Every hazard the machine still owns, all at once,",
            "arranged with terrible politeness.",
            "A cage of four beams, and only one face burns at a time.",
            "Enter on the dark face. Leave by the next.",
        ),
        outro=(
            "The cage opens. The core is small, and cold, and yours.",
            "The machine stops dying.",
            "It simply stops.",
        ),
        speaker="core",
    ),
)

BEAT_COUNT: int = len(BEATS)


# ==========================================================================
# Chapters
# ==========================================================================
CHAPTERS: Tuple[Chapter, ...] = (
    Chapter(
        number=1,
        title=_CH1,
        blurb=(
            "The outer lattice, half powered and mostly empty.",
            "Nothing here wants you dead yet.",
        ),
        first_index=0,
        last_index=2,
    ),
    Chapter(
        number=2,
        title=_CH2,
        blurb=(
            "Down where the machine still runs hot.",
            "Everything moves on a schedule, and none of it is yours.",
        ),
        first_index=3,
        last_index=5,
    ),
    Chapter(
        number=3,
        title=_CH3,
        blurb=(
            "Storage, growth and combustion.",
            "The parts of itself the machine locked away, and why.",
        ),
        first_index=6,
        last_index=8,
    ),
    Chapter(
        number=4,
        title=_CH4,
        blurb=(
            "Out to the quiet edge, then inward, past the bend in the light,",
            "to the thing that dreamed all of this.",
        ),
        first_index=9,
        last_index=11,
    ),
)

CHAPTER_COUNT: int = len(CHAPTERS)


# ==========================================================================
# Epilogue
# ==========================================================================
EPILOGUE: StoryCard = StoryCard(
    title="After",
    lines=(
        "You are the machine now. Every corridor, every gate, every dead lane.",
        "There is nothing left in here to eat.",
        "Somewhere far off, a colder lattice comes up dark",
        "and waits for its own first light.",
    ),
    speaker="",
)


# ==========================================================================
# Accessors - all clamped, none of them raise
# ==========================================================================
def _clamp_index(level_index: int, hi: int) -> int:
    """
    Coerce anything at all to a valid 0..hi index.  Never raises.

    The infinities need their own arm: ``int(float("inf"))`` raises
    ``OverflowError``, which is neither a ``TypeError`` nor a ``ValueError``,
    so a bare two-exception guard here would let it straight through and out of
    every accessor built on top of this one.  ``+inf`` saturates at the last
    beat and ``-inf`` (like NaN, and like anything uncoercible) at the first.
    """
    try:
        if level_index != level_index:            # NaN, without importing math
            return 0
    except Exception:                             # pragma: no cover - exotic
        return 0
    try:
        idx = int(level_index)
    except OverflowError:
        # Only the infinities land here, and only one of them is positive.
        try:
            return hi if level_index > 0 else 0
        except Exception:                         # pragma: no cover - exotic
            return 0
    except (TypeError, ValueError, AttributeError):
        return 0
    if idx < 0:
        return 0
    if idx > hi:
        return hi
    return idx


def get_beat(level_index: int) -> StoryBeat:
    """
    The beat for level `level_index`, clamped into range.

    Never raises and never returns ``None``: out-of-range or nonsense input
    yields the first or last beat, so a scene can call this unguarded.
    """
    return BEATS[_clamp_index(level_index, BEAT_COUNT - 1)]


def get_chapter(level_index: int) -> Chapter:
    """
    The chapter that owns level `level_index`, clamped into range.

    Never raises.  Derived from the beat rather than from arithmetic so the
    chapter grouping stays defined in exactly one place: the beat table.
    """
    number = get_beat(level_index).chapter
    for ch in CHAPTERS:
        if ch.number == number:
            return ch
    return CHAPTERS[_clamp_index(number - 1, CHAPTER_COUNT - 1)]


def beats_in_chapter(chapter_number: int) -> Tuple[StoryBeat, ...]:
    """Every beat in chapter `chapter_number` (1-based), in order. Never raises."""
    try:
        num = int(chapter_number)
    except (TypeError, ValueError, OverflowError, AttributeError):
        # OverflowError is the infinities; see _clamp_index for why it matters.
        return ()
    return tuple(b for b in BEATS if b.chapter == num)


def chapter_start(level_index: int) -> bool:
    """
    True when `level_index` is the first level of a chapter.

    This is the cue for the scene to show a chapter card before the level's own
    intro.  Clamped, so nonsense input answers for the nearest real level.
    """
    return get_chapter(level_index).first_index == \
        _clamp_index(level_index, BEAT_COUNT - 1)


def chapter_end(level_index: int) -> bool:
    """True when clearing `level_index` closes out its chapter."""
    return get_chapter(level_index).last_index == \
        _clamp_index(level_index, BEAT_COUNT - 1)


def all_beats() -> Tuple[StoryBeat, ...]:
    """The whole campaign narrative, in order."""
    return BEATS


# ==========================================================================
# Self-check
# --------------------------------------------------------------------------
# core.level is imported lazily, inside the function, so that importing this
# module stays free of every other dependency in the package.
# ==========================================================================
def validate_story() -> List[str]:
    """
    Cross-check the narrative against the level table and itself.

    Returns a list of human-readable problems; empty means consistent.  Run by
    ``python -m snake.core.story``.
    """
    problems: List[str] = []

    if BEAT_COUNT != CHAPTER_COUNT * CHAPTER_SIZE:
        problems.append("{} beats does not fill {} chapters of {}".format(
            BEAT_COUNT, CHAPTER_COUNT, CHAPTER_SIZE))

    for i, beat in enumerate(BEATS):
        if beat.level_index != i:
            problems.append("beat {}: level_index is {}".format(i, beat.level_index))
        if not beat.intro or not beat.outro:
            problems.append("{}: empty intro or outro".format(beat.title))
        if len(beat.intro) > 4 or len(beat.outro) > 4:
            problems.append("{}: more than four lines in a block".format(beat.title))
        ch = get_chapter(i)
        if beat.chapter_title != ch.title:
            problems.append("{}: chapter_title '{}' != '{}'".format(
                beat.title, beat.chapter_title, ch.title))
        if not ch.contains(i):
            problems.append("{}: outside chapter {} range".format(beat.title, ch.number))

    covered: List[int] = []
    for ch in CHAPTERS:
        if ch.last_index < ch.first_index:
            problems.append("chapter {}: inverted level range".format(ch.number))
        if not ch.blurb:
            problems.append("chapter {}: empty blurb".format(ch.number))
        covered.extend(ch.level_indices)
    if sorted(covered) != list(range(BEAT_COUNT)):
        problems.append("chapters do not cover every level exactly once")

    starts = [i for i in range(BEAT_COUNT) if chapter_start(i)]
    if starts != [ch.first_index for ch in CHAPTERS]:
        problems.append("chapter_start() disagrees with the chapter table: "
                        "{}".format(starts))

    if not PROLOGUE.lines or not EPILOGUE.lines:
        problems.append("prologue or epilogue has no lines")

    # -- agreement with the actual campaign --------------------------------
    try:
        from . import level as level_mod
    except Exception as exc:             # pragma: no cover - import guard only
        problems.append("could not import core.level: {}".format(exc))
        return problems

    if level_mod.LEVEL_COUNT != BEAT_COUNT:
        problems.append("{} levels but {} beats".format(
            level_mod.LEVEL_COUNT, BEAT_COUNT))
    expected = ("Neon Grid", "Deep Nebula", "Emerald Circuit", "Solar Flare",
                "Abyssal Tide", "Violet Static", "Frozen Vault", "Toxic Bloom",
                "Crimson Engine", "Aurora Drift", "Event Horizon", "Prism Core")
    for i, name in enumerate(expected[:level_mod.LEVEL_COUNT]):
        if level_mod.get_level(i).name != name:
            problems.append("level {} is '{}', story was written for '{}'".format(
                i + 1, level_mod.get_level(i).name, name))
    return problems


if __name__ == "__main__":               # pragma: no cover - developer utility
    print("PROLOGUE - {}".format(PROLOGUE.title))
    for _line in PROLOGUE.lines:
        print("    " + _line)
    for _ch in CHAPTERS:
        print("\n{}  (levels {}-{})".format(_ch, _ch.first_index + 1,
                                            _ch.last_index + 1))
        for _line in _ch.blurb:
            print("    " + _line)
        for _b in beats_in_chapter(_ch.number):
            print("  {:02d} {:<32} [{}]".format(_b.number, _b.title, _b.speaker))
            for _line in _b.intro:
                print("       > " + _line)
            for _line in _b.outro:
                print("       < " + _line)
    print("\nEPILOGUE - {}".format(EPILOGUE.title))
    for _line in EPILOGUE.lines:
        print("    " + _line)
    _issues = validate_story()
    print("\n{} problem(s)".format(len(_issues)))
    for _p in _issues:
        print("  ! " + _p)
