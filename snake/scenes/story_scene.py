"""
STORY - the narrative card presenter.

This scene is the campaign's connective tissue.  It is deliberately *generic*:
it knows nothing about levels, chapters or progress, it only knows how to show
a stack of cards beautifully and then hand control to whoever asked for it::

    game.switch_scene(C.SCENE_STORY,
                      cards=[story.PROLOGUE, intro_card],
                      next_scene=C.SCENE_GAME,
                      next_kwargs={"level_index": 0},
                      theme=P.theme_for_level(0))

Four other scenes drive it (mode select, victory, game over and the menu), so
the contract above is fixed and everything inside is defensive: a card may be a
:class:`~snake.core.story.StoryCard`, a :class:`~snake.core.story.Chapter`, a
:class:`~snake.core.story.StoryBeat`, a plain dict, or a bare string, and an
empty stack goes straight through to ``next_scene`` without ever drawing a
half-built frame.

Presentation
------------
One card at a time over the level's own animated backdrop, with a parallax
star layer, drifting motes, a cinematic scrim and a vignette so the eye lands
on the text and nothing else.  The title fades up, then the lines *type on*
character by character with a soft tick; punctuation costs extra time, so the
rhythm reads like speech rather than a ticker tape.

*   Clicking while text is still typing completes the card instantly.
*   Clicking once the card is complete advances to the next one.
*   CONTINUE appears when the card is fully revealed; SKIP is always there and
    jumps past every remaining card.

A card whose title carries a chapter marker ("Chapter II - ...", "II. ...", or
anything with a ``roman`` attribute) is promoted to a chapter plate: a huge
roman numeral, a horizontal rule and a lot more air.

Nothing in here may raise: ``update`` and ``draw`` swallow their own failures.
"""

from __future__ import annotations

import bisect
import math
import random
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Dict, List, Optional, Sequence, Tuple

import pygame

from .. import config as C
from .. import palette as P
from ..core.contracts import Scene, clamp, ease_out_cubic, pulse
from ..gfx.background import make_background
from ..gfx.render import draw_glow_circle
from ..gfx.ui import Button, draw_text

if TYPE_CHECKING:  # pragma: no cover - typing only
    from ..main import Game

RGB = Tuple[int, int, int]

__all__ = ["StoryScene"]


# --------------------------------------------------------------------------
# Layout.  Authored against the fixed 1280x720 canvas, in one place.
# --------------------------------------------------------------------------
_TEXT_W = 940                                   # widest a line may render
_CENTER_X = C.WINDOW_W // 2

_SCRIM = pygame.Rect(0, 58, C.WINDOW_W, 546)    # cinematic darkening band

_CONTINUE_RECT = pygame.Rect((C.WINDOW_W - C.UI_BUTTON_W) // 2, 614,
                             C.UI_BUTTON_W, C.UI_BUTTON_H)
# SKIP is lifted well clear of the bottom-right corner.  The finished frame is
# pushed through the CRT bezel in `gfx/effects.py`, which passes only ~13% of
# the drawn light at the old (1090, 622) - a ghost-styled button down there was
# effectively invisible.  At (1020, 556) it measures ~0.73, and it still sits
# outside the card's text column, so nothing else had to move.
_SKIP_RECT = pygame.Rect(1020, 556, 150, 44)

# Normal card
_SPEAKER_Y = 122
_TITLE_Y = 152
_RULE_Y = 246
_LINES_Y = 298

# Chapter plate
_CH_LABEL_Y = 96
_CH_ROMAN_Y = 120
_CH_RULE_Y = 268
_CH_TITLE_Y = 290
_CH_LINES_Y = 392

_LINE_STEP = 46
_CH_LINE_STEP = 50

# --------------------------------------------------------------------------
# Typing.  Cost is measured in "character units": one unit per character, plus
# a surcharge after punctuation, so the reveal breathes at a comma and rests at
# a full stop instead of clattering through at a constant rate.
# --------------------------------------------------------------------------
_TYPE_CPS = 46.0                                # character units per second
_NEWLINE_COST = 8.0                             # pause between display lines
_PUNCT_COST: Dict[str, float] = {
    ",": 3.0, ";": 3.5, ":": 3.5, "-": 1.5,
    ".": 6.0, "!": 6.5, "?": 6.5,
}

_TITLE_IN = 0.45                                # seconds for the title to land
_TYPE_DELAY = 0.25                              # ... before the lines start
_FADE_IN = 0.26                                 # card cross-fade, seconds
_FADE_OUT = 0.18
_TICK_GAP = 0.042                               # min seconds between ticks

_STAR_LAYERS: Tuple[Tuple[int, float, float, float], ...] = (
    # (count, depth 0..1, drift px/s, brightness)
    (64, 0.18, 3.0, 0.42),
    (44, 0.45, 8.0, 0.62),
    (26, 0.85, 17.0, 0.88),
)


# ==========================================================================
# Card normalisation - accept anything card-shaped
# ==========================================================================
@dataclass
class _Card:
    """One normalised narrative card, whatever shape it arrived in."""

    title: str = ""
    lines: Tuple[str, ...] = ()
    speaker: str = ""
    roman: str = ""                             # non-empty => chapter plate

    @property
    def is_chapter(self) -> bool:
        return bool(self.roman)


#: Roman numerals we can both read and write, I..XII plus a little headroom.
_ROMAN_VALUES: Tuple[Tuple[int, str], ...] = (
    (1000, "M"), (900, "CM"), (500, "D"), (400, "CD"), (100, "C"), (90, "XC"),
    (50, "L"), (40, "XL"), (10, "X"), (9, "IX"), (5, "V"), (4, "IV"), (1, "I"),
)
_ROMAN_CHARS = set("IVXLCDM")
_CHAPTER_WORDS = ("chapter", "chapters", "chap", "ch", "act", "part", "book")
_SEPARATORS = "-–—:.·|"


def _to_roman(n: int) -> str:
    """Arabic to roman, clamped to something a numeral can express."""
    n = int(clamp(float(n), 1.0, 3999.0))
    out: List[str] = []
    for value, glyph in _ROMAN_VALUES:
        while n >= value:
            out.append(glyph)
            n -= value
    return "".join(out)


def _split_marker(title: str) -> Tuple[str, str]:
    """
    Pull a chapter marker off the front of `title`.

    Returns ``(roman, remainder)``; an empty roman means this is an ordinary
    card.  Understood forms: "Chapter II - Name", "CHAPTER 2: Name", "Act III",
    "II. Name" and the bare roman "IV".
    """
    try:
        raw = str(title or "").strip()
    except Exception:
        return ("", "")
    if not raw:
        return ("", "")

    head, _, tail = raw.partition(" ")
    word = head.strip(_SEPARATORS).lower()
    number = ""
    rest = raw

    if word in _CHAPTER_WORDS:
        # "Chapter II - Cold Boot" -> number token is the next word.
        token, _, remainder = tail.strip().partition(" ")
        number = token.strip(_SEPARATORS)
        rest = remainder
        if not number:
            return ("", raw)
    else:
        # "II. Cold Boot" / "IV" -> the first token is the numeral itself.
        token = head.strip(_SEPARATORS)
        if not token or not set(token.upper()) <= _ROMAN_CHARS:
            return ("", raw)
        # A bare roman only counts when it was punctuated or stands alone;
        # otherwise a title beginning "I ..." or "Mill ..." would be eaten.
        if tail and head == token:
            return ("", raw)
        number = token
        rest = tail

    number = number.strip()
    if not number:
        return ("", raw)
    if number.isdigit():
        roman = _to_roman(int(number))
    elif set(number.upper()) <= _ROMAN_CHARS:
        roman = number.upper()
    else:
        return ("", raw)
    return (roman, rest.strip().lstrip(_SEPARATORS).strip())


def _as_lines(value: Any) -> Tuple[str, ...]:
    """Coerce a lines-ish value into a tuple of clean, non-empty strings."""
    if value is None:
        return ()
    if isinstance(value, str):
        parts: Sequence[str] = value.splitlines()
    elif isinstance(value, (list, tuple)):
        parts = [str(v) for v in value]
    else:
        try:
            parts = [str(v) for v in list(value)]
        except Exception:
            parts = [str(value)]
    out: List[str] = []
    for part in parts:
        text = str(part).replace("\t", " ").rstrip()
        if text.strip():
            out.append(text.strip())
    return tuple(out[:8])                       # a card is never a wall of text


def _pick(source: Any, *names: str) -> Any:
    """First present, non-empty attribute or key named in `names`."""
    for name in names:
        value: Any = None
        if isinstance(source, dict):
            value = source.get(name)
        else:
            value = getattr(source, name, None)
        if value:
            return value
    return None


def _normalise_card(raw: Any) -> Optional[_Card]:
    """
    Turn anything card-shaped into a `_Card`, or None if it holds no text.

    Accepts StoryCard, StoryBeat (its ``intro``), Chapter (its ``blurb`` and
    ``roman``), dicts, ``(title, lines)`` pairs and bare strings.
    """
    if raw is None:
        return None
    try:
        if isinstance(raw, str):
            lines = _as_lines(raw)
            if not lines:
                return None
            # A lone line carrying a chapter marker is a plate, not prose -
            # "Chapter II - Cold Boot" is obviously a heading.
            if len(lines) == 1:
                roman, rest = _split_marker(lines[0])
                if roman:
                    return _Card(title=rest, lines=(), roman=roman)
            return _Card(title="", lines=lines)

        if isinstance(raw, (list, tuple)):
            # A (title, lines) pair, or just a bundle of lines.
            if len(raw) == 2 and isinstance(raw[0], str) and \
                    not isinstance(raw[1], str):
                return _Card(title=str(raw[0]).strip(), lines=_as_lines(raw[1]))
            lines = _as_lines(raw)
            return _Card(lines=lines) if lines else None

        title = _pick(raw, "title", "name", "heading") or ""
        lines = _as_lines(_pick(raw, "lines", "text", "body", "blurb",
                                "intro", "outro"))
        speaker = _pick(raw, "speaker", "voice", "attribution") or ""

        roman = ""
        explicit = _pick(raw, "roman")
        if isinstance(explicit, str) and set(explicit.upper()) <= _ROMAN_CHARS:
            roman = explicit.upper()
        else:
            number = _pick(raw, "chapter_number")
            if isinstance(number, int):
                roman = _to_roman(number)

        title = str(title).strip()
        if not roman:
            roman, title = _split_marker(title)
        if not title and not lines:
            return None
        return _Card(title=title, lines=lines, speaker=str(speaker).strip(),
                     roman=roman)
    except Exception:
        return None


def _normalise_cards(raw: Any) -> List[_Card]:
    """Normalise a whole card list; a single card is accepted on its own."""
    if raw is None:
        return []
    items: Sequence[Any]
    if isinstance(raw, (list, tuple)):
        items = raw
    elif isinstance(raw, (str, dict)):
        items = [raw]
    else:
        try:
            items = list(raw)
        except Exception:
            items = [raw]
    out: List[_Card] = []
    for item in items[:24]:
        card = _normalise_card(item)
        if card is not None:
            out.append(card)
    return out


# ==========================================================================
# Cached atmosphere surfaces
# ==========================================================================
_OVERLAY_CACHE: Dict[Tuple[int, int], pygame.Surface] = {}
_OVERLAY_TINT: RGB = (4, 6, 14)
_SCRIM_PEAK = 168.0                             # alpha under the text band
_VIGNETTE_PEAK = 190.0                          # alpha in the far corners


def _overlay_surface(w: int, h: int) -> pygame.Surface:
    """
    Scrim band and corner vignette, composited into one surface.

    Two jobs, one blit.  The band is what makes text legible over twelve very
    different backdrops without a hard-edged dialog box - its alpha ramps in
    over the top of the band and out over the bottom, so it never announces
    itself - and the vignette pulls the eye to the middle of the frame.

    Both are pure low-frequency ramps, so the whole thing is authored on a
    128x72 template and stretched: full-size per-pixel work would cost tens of
    milliseconds, while this is built exactly once per size and costs one
    ordinary alpha blit per frame afterwards.
    """
    key = (max(2, int(w)), max(2, int(h)))
    cached = _OVERLAY_CACHE.get(key)
    if cached is not None:
        return cached

    tw, th = 128, 72
    small = pygame.Surface((tw, th), pygame.SRCALPHA)
    band_top = _SCRIM.top / float(max(1, key[1]))
    band_bot = _SCRIM.bottom / float(max(1, key[1]))
    band_span = max(1e-3, band_bot - band_top)
    for j in range(th):
        vy = (j + 0.5) / th
        if band_top <= vy <= band_bot:
            f = (vy - band_top) / band_span
            if f < 0.14:
                scrim = _SCRIM_PEAK * (f / 0.14) ** 1.5
            elif f > 0.72:
                scrim = _SCRIM_PEAK * (1.0 - (f - 0.72) / 0.28) ** 1.6
            else:
                scrim = _SCRIM_PEAK
        else:
            scrim = 0.0
        s = clamp(scrim, 0.0, 255.0) / 255.0
        dy = vy * 2.0 - 1.0
        for i in range(tw):
            dx = (i + 0.5) / tw * 2.0 - 1.0
            d = clamp(math.hypot(dx * 0.94, dy) / 1.30, 0.0, 1.0)
            v = clamp(_VIGNETTE_PEAK * (d ** 2.3), 0.0, 255.0) / 255.0
            # Two translucent layers stacked: 1 - (1-a)(1-b).
            small.set_at((i, j), _OVERLAY_TINT + (int(255.0 * (1.0 - (1.0 - s) * (1.0 - v))),))
    try:
        surf = pygame.transform.smoothscale(small, key)
    except Exception:
        surf = small
    if len(_OVERLAY_CACHE) > 4:
        _OVERLAY_CACHE.clear()
    _OVERLAY_CACHE[key] = surf
    return surf


# ==========================================================================
# Fonts
# ==========================================================================
_FALLBACK_FONTS: Dict[Tuple[int, bool], pygame.font.Font] = {}


def _fallback_font(size: int, bold: bool) -> pygame.font.Font:
    key = (int(size), bool(bold))
    font = _FALLBACK_FONTS.get(key)
    if font is None:
        if not pygame.font.get_init():
            pygame.font.init()
        font = pygame.font.Font(None, int(size * 1.15))
        try:
            font.set_bold(bold)
        except Exception:
            pass
        _FALLBACK_FONTS[key] = font
    return font


def _font(fonts: Any, size: int, *, display: bool = False,
          bold: bool = False) -> pygame.font.Font:
    """A font of `size` from the game's FontBook, with a hard fallback."""
    try:
        if display:
            return fonts.display_at(int(size))
        return fonts.get(int(size), bold)
    except Exception:
        return _fallback_font(size, bold or display)


# ==========================================================================
# Laid-out text
# ==========================================================================
@dataclass
class _Line:
    """One display line, pre-rendered and pre-measured for the typewriter."""

    text: str
    body: pygame.Surface
    shadow: pygame.Surface
    x: int
    y: int
    adv: List[int] = field(default_factory=list)    # px after i characters
    cum: List[float] = field(default_factory=list)  # cost after i characters
    start: float = 0.0                              # global reveal offset


def _render_pair(text: str, font: pygame.font.Font,
                 color: Sequence[int]) -> Tuple[pygame.Surface, pygame.Surface]:
    """Render `text` and a black silhouette of it, for a cheap drop shadow."""
    body = font.render(text, True, (int(color[0]), int(color[1]), int(color[2])))
    shadow = body.copy()
    shadow.fill((0, 0, 0, 255), special_flags=pygame.BLEND_RGBA_MULT)
    return body, shadow


def _wrap(text: str, font: pygame.font.Font, max_w: int) -> List[str]:
    """Greedy word wrap. Story lines rarely need it; long ones must not clip."""
    try:
        if font.size(text)[0] <= max_w:
            return [text]
    except Exception:
        return [text]
    words = text.split(" ")
    out: List[str] = []
    current = ""
    for word in words:
        candidate = word if not current else current + " " + word
        try:
            too_wide = font.size(candidate)[0] > max_w
        except Exception:
            too_wide = False
        if too_wide and current:
            out.append(current)
            current = word
        else:
            current = candidate
    if current:
        out.append(current)
    return out or [text]


def _measure(text: str, font: pygame.font.Font) -> Tuple[List[int], List[float]]:
    """Per-character x advances and cumulative reveal costs for one line."""
    adv: List[int] = [0]
    cum: List[float] = [0.0]
    width = 0
    cost = 0.0
    for i, ch in enumerate(text):
        try:
            width = font.size(text[:i + 1])[0]
        except Exception:
            width += 10
        adv.append(int(width))
        cost += 1.0 + _PUNCT_COST.get(ch, 0.0)
        cum.append(cost)
    return adv, cum


# ==========================================================================
# The scene
# ==========================================================================
class StoryScene(Scene):
    """
    A generic narrative card presenter.

    ``on_enter(cards=..., next_scene=..., next_kwargs=..., theme=...)`` is the
    whole contract.  The scene never decides *what* comes next; it only decides
    how good the words look on the way there.
    """

    transparent = False
    blocks_update = True

    def __init__(self, game: "Game") -> None:
        super().__init__(game)
        self.theme: P.Theme = P.theme_for_level(0)
        self.t: float = 0.0

        # -- deck ----------------------------------------------------------
        self.cards: List[_Card] = []
        self.index: int = 0
        self.next_scene: str = C.SCENE_MENU
        self.next_kwargs: Dict[str, Any] = {}

        # -- per-card state -------------------------------------------------
        self.reveal: float = 0.0
        self.total: float = 0.0
        self.card_t: float = 0.0
        self.done: bool = False
        self.alpha: float = 0.0
        self._fading_out: bool = False
        self._layout: List[_Line] = []
        self._title: Optional[Tuple[pygame.Surface, pygame.Surface]] = None
        self._roman: Optional[Tuple[pygame.Surface, pygame.Surface]] = None

        # -- run state ------------------------------------------------------
        self._finished: bool = False
        self._pending_finish: bool = False
        self._armed: bool = False
        self._tick_cd: float = 0.0
        self._spoken: int = 0                   # characters already ticked

        # -- chrome ----------------------------------------------------------
        self.continue_btn: Button = Button(_CONTINUE_RECT, "CONTINUE", style="primary")
        self.skip_btn: Button = Button(_SKIP_RECT, "SKIP", style="ghost")

        # -- atmosphere ------------------------------------------------------
        self.background: Any = None
        self._bg_style: str = ""
        self._stars: List[List[float]] = []
        self._rng = random.Random(1207)
        self._build_stars()

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------
    def on_enter(self, cards: Any = None, next_scene: str = C.SCENE_MENU,
                 next_kwargs: Optional[Dict[str, Any]] = None,
                 theme: Any = None, **extra: Any) -> None:
        """
        Full reset - scene instances are cached and reused by the Game.

        Everything is coerced rather than trusted: a bad card list degrades to
        an empty deck, which passes straight through to `next_scene`.
        """
        try:
            self.t = 0.0
            self._finished = False
            self._armed = False
            self._tick_cd = 0.0

            self.cards = _normalise_cards(cards)
            self.index = 0
            self.next_scene = str(next_scene or C.SCENE_MENU)
            self.next_kwargs = dict(next_kwargs) if isinstance(next_kwargs, dict) else {}

            self.theme = self._resolve_theme(theme, extra)
            self._pending_finish = not self.cards

            # A deck with nothing in it never builds scenery: `update` hands
            # straight over on the very next tick.
            if self._pending_finish:
                self._layout = []
                self._title = None
                self._roman = None
                self.alpha = 0.0
                return

            self._ensure_background()
            self._begin_card(0)
        except Exception:
            # Never strand the player on a broken narrative screen.
            self._pending_finish = True

    def on_exit(self) -> None:
        self._layout = []
        self._title = None
        self._roman = None

    def _resolve_theme(self, theme: Any, extra: Dict[str, Any]) -> P.Theme:
        """Accept a Theme, a level index, or nothing at all."""
        try:
            if isinstance(theme, P.Theme):
                return theme
            if isinstance(theme, bool):
                pass
            elif isinstance(theme, (int, float)):
                return P.theme_for_level(int(theme))
            index = extra.get("level_index")
            if isinstance(index, (int, float)) and not isinstance(index, bool):
                return P.theme_for_level(int(index))
            return P.theme_for_level(int(getattr(self.game, "level_index", 0)))
        except Exception:
            return P.THEMES[0]

    def _ensure_background(self) -> None:
        """(Re)build the animated backdrop when the active theme changed."""
        style = str(getattr(self.theme, "bg_style", "grid"))
        if self.background is not None and style == self._bg_style:
            return
        try:
            self.background = make_background(
                style, self.theme, pygame.Rect(0, 0, C.WINDOW_W, C.WINDOW_H))
            self._bg_style = style
        except Exception:
            self.background = None

    def _build_stars(self) -> None:
        """
        Three parallax layers of drifting pinpricks.

        Each entry is ``[x, y, depth, size, phase, drift]`` - the drift rate is
        baked in at build time so the per-frame loop is pure arithmetic.
        """
        self._stars = []
        for count, depth, drift, bright in _STAR_LAYERS:
            for _ in range(count):
                self._stars.append([
                    self._rng.uniform(0.0, float(C.WINDOW_W)),
                    self._rng.uniform(0.0, float(C.WINDOW_H)),
                    depth * bright,
                    float(self._rng.randint(1, 2)),
                    self._rng.uniform(0.0, 6.28318),
                    drift,
                ])

    # ------------------------------------------------------------------
    # Card setup
    # ------------------------------------------------------------------
    @property
    def skip_live(self) -> bool:
        """
        Whether SKIP is currently interactive.

        It stands down on the last card of a finished single-card deck: there
        is nothing left to skip past, and CONTINUE has just taken its place.
        """
        return len(self.cards) > 1 or not self.done

    @property
    def card(self) -> Optional[_Card]:
        """The card currently on screen, if any."""
        if 0 <= self.index < len(self.cards):
            return self.cards[self.index]
        return None

    def _begin_card(self, index: int) -> None:
        """Reset every per-card animation and lay the text out once."""
        self.index = int(clamp(float(index), 0.0, float(max(0, len(self.cards) - 1))))
        self.card_t = 0.0
        self.reveal = 0.0
        self.done = False
        self.alpha = 0.0
        self._fading_out = False
        self._spoken = 0
        self._armed = False
        self._build_layout()

        # The last card promises what it actually leads to, so CONTINUE never
        # lies about there being more story ahead.
        last = self.index >= len(self.cards) - 1
        label = "BEGIN" if (last and self.next_scene == C.SCENE_GAME) else "CONTINUE"
        fonts = getattr(self.game, "fonts", None)
        self.continue_btn = Button(_CONTINUE_RECT, label, style="primary",
                                   font=_font(fonts, 30, bold=True))
        self.skip_btn = Button(_SKIP_RECT, "SKIP", style="ghost",
                               font=_font(fonts, 20))

    def _build_layout(self) -> None:
        """Render, wrap and measure the current card. Runs once per card."""
        self._layout = []
        self._title = None
        self._roman = None
        self.total = 0.0

        card = self.card
        if card is None:
            return
        fonts = getattr(self.game, "fonts", None)
        theme = self.theme
        chapter = card.is_chapter

        # -- title ---------------------------------------------------------
        if card.title:
            size = 58 if chapter else 62
            title_font = _font(fonts, size, display=True)
            for trial in (size, size - 8, size - 16, size - 22):
                title_font = _font(fonts, max(24, trial), display=True)
                try:
                    if title_font.size(card.title)[0] <= _TEXT_W:
                        break
                except Exception:
                    break
            self._title = _render_pair(
                card.title, title_font,
                P.lerp_color(theme.accent, P.UI_WHITE, 0.55))

        # -- roman numeral --------------------------------------------------
        if chapter:
            self._roman = _render_pair(
                card.roman, _font(fonts, 112, display=True),
                P.lerp_color(theme.accent, P.UI_WHITE, 0.30))

        # -- body ------------------------------------------------------------
        body_font = _font(fonts, 27 if not chapter else 25)
        colour = P.lerp_color(theme.text, P.UI_WHITE, 0.25)
        step = _CH_LINE_STEP if chapter else _LINE_STEP
        top = _CH_LINES_Y if chapter else _LINES_Y

        display: List[str] = []
        for raw in card.lines:
            display.extend(_wrap(raw, body_font, _TEXT_W))
        display = display[:9]

        cursor = 0.0
        for i, text in enumerate(display):
            body, shadow = _render_pair(text, body_font, colour)
            adv, cum = _measure(text, body_font)
            line = _Line(text=text, body=body, shadow=shadow,
                         x=_CENTER_X - body.get_width() // 2,
                         y=top + i * step, adv=adv, cum=cum, start=cursor)
            self._layout.append(line)
            cursor += (cum[-1] if cum else 0.0) + _NEWLINE_COST
        self.total = max(0.0, cursor - _NEWLINE_COST)

    # ------------------------------------------------------------------
    # Input
    # ------------------------------------------------------------------
    def handle_event(self, event: pygame.event.Event) -> None:
        try:
            if self._finished or self._pending_finish:
                return

            if self.skip_live and self.skip_btn.handle_event(event):
                self._click()
                self._finish()
                return
            if self.done and self.continue_btn.handle_event(event):
                self._click()
                self._advance()
                return

            etype = getattr(event, "type", None)
            if etype == pygame.MOUSEBUTTONDOWN and getattr(event, "button", 0) == 1:
                # Arm only away from the chrome, so a press that lands on a
                # button can never also count as a "click anywhere".
                self._armed = not self._over_chrome(getattr(event, "pos", (0, 0)))
                return
            if etype == pygame.MOUSEBUTTONUP and getattr(event, "button", 0) == 1:
                armed, self._armed = self._armed, False
                if armed and not self._over_chrome(getattr(event, "pos", (0, 0))):
                    self._primary_action()
                return
            if etype == pygame.KEYDOWN:
                key = getattr(event, "key", 0)
                if key in (pygame.K_ESCAPE, pygame.K_TAB):
                    self._click()
                    self._finish()
                elif key in (pygame.K_RETURN, pygame.K_KP_ENTER, pygame.K_SPACE,
                             pygame.K_RIGHT, pygame.K_e):
                    self._primary_action()
        except Exception:
            pass

    def _over_chrome(self, pos: Any) -> bool:
        """True when `pos` sits on a button that is currently interactive."""
        try:
            point = (int(pos[0]), int(pos[1]))
        except Exception:
            return False
        if self.skip_live and _SKIP_RECT.collidepoint(point):
            return True
        return bool(self.done and _CONTINUE_RECT.collidepoint(point))

    def _primary_action(self) -> None:
        """Click / confirm: complete the typing, or move on if it is complete."""
        if self._fading_out:
            return
        if not self.done:
            self._complete_card()
        else:
            self._click()
            self._advance()

    def _complete_card(self) -> None:
        """Reveal the rest of the current card instantly."""
        self.reveal = self.total
        self.card_t = max(self.card_t, _TITLE_IN + _TYPE_DELAY)
        self.alpha = 1.0
        self.done = True
        self._spoken = 1 << 30                  # no tick storm on the catch-up
        self._play("click", 0.5)

    def _advance(self) -> None:
        """Begin the fade to the next card (or off the end of the deck)."""
        if self._fading_out or self._finished:
            return
        self._fading_out = True

    def _finish(self) -> None:
        """Hand over to whoever queued these cards. Only ever fires once."""
        if self._finished:
            return
        self._finished = True
        try:
            self.game.switch_scene(self.next_scene, **dict(self.next_kwargs))
        except Exception:
            try:
                self.game.switch_scene(C.SCENE_MENU)
            except Exception:
                pass

    def _play(self, name: str, volume: float = 1.0) -> None:
        try:
            self.game.audio.play(name, volume)
        except Exception:
            pass

    def _click(self) -> None:
        self._play("click")

    # ------------------------------------------------------------------
    # Update
    # ------------------------------------------------------------------
    def update(self, dt: float) -> None:
        try:
            dt = clamp(float(dt), 0.0, C.MAX_DT)
            self.t += dt

            # An empty deck hands over on the first tick, before anything of
            # this scene has had a chance to be seen.
            if self._pending_finish:
                self._pending_finish = False
                self._finish()
                return
            if self._finished:
                return

            self._update_buttons(dt)
            if self.background is not None:
                self.background.update(dt, focus=getattr(self.game, "mouse_pos", None))
            self._update_stars(dt)
            self._emit_particles(dt)
            self._update_card(dt)
        except Exception:
            pass

    def _update_buttons(self, dt: float) -> None:
        mouse = getattr(self.game, "mouse_pos", (0.0, 0.0))
        for button, live in ((self.skip_btn, self.skip_live),
                             (self.continue_btn, self.done)):
            if not live:
                button.hovered = False
                continue
            was = button.hovered
            button.update(dt, mouse)
            if button.hovered and not was:
                self._play("hover")

    def _update_stars(self, dt: float) -> None:
        for star in self._stars:
            star[0] -= star[5] * dt
            if star[0] < -4.0:
                star[0] += C.WINDOW_W + 8.0
                star[1] = self._rng.uniform(0.0, float(C.WINDOW_H))

    def _emit_particles(self, dt: float) -> None:
        """Slow motes rising through the frame - the room has air in it."""
        try:
            particles = getattr(self.game, "particles", None)
            if particles is None:
                return
            particles.ambient(pygame.Rect(0, 40, C.WINDOW_W, C.WINDOW_H - 40),
                              P.lerp_color(self.theme.accent2, P.UI_WHITE, 0.2),
                              dt, rate=11.0, turbulence=0.35, twinkle=0.30)
        except Exception:
            pass

    def _update_card(self, dt: float) -> None:
        card = self.card
        if card is None:
            self._finish()
            return

        self.card_t += dt

        if self._fading_out:
            self.alpha = max(0.0, self.alpha - dt / _FADE_OUT)
            if self.alpha <= 0.0:
                if self.index + 1 >= len(self.cards):
                    self._finish()
                else:
                    self._begin_card(self.index + 1)
            return

        self.alpha = min(1.0, self.alpha + dt / _FADE_IN)

        if self.done:
            return
        if self.card_t < _TITLE_IN + _TYPE_DELAY:
            return
        if self.total <= 0.0:
            self.done = True
            return

        self.reveal = min(self.total, self.reveal + _TYPE_CPS * dt)
        self._tick_cd = max(0.0, self._tick_cd - dt)
        self._speak()
        if self.reveal >= self.total:
            self.done = True

    def _speak(self) -> None:
        """A soft tick as new characters land, throttled so it stays a texture."""
        try:
            shown = 0
            for line in self._layout:
                shown += self._chars_shown(line)
            if shown > self._spoken:
                if self._tick_cd <= 0.0:
                    self._tick_cd = _TICK_GAP
                    self._play("hover", 0.22)
                self._spoken = shown
        except Exception:
            pass

    def _chars_shown(self, line: _Line) -> int:
        """How many characters of `line` the reveal counter has uncovered."""
        local = self.reveal - line.start
        if local <= 0.0:
            return 0
        if not line.cum:
            return 0
        if local >= line.cum[-1]:
            return len(line.text)
        n = bisect.bisect_right(line.cum, local) - 1
        return int(clamp(float(n), 0.0, float(len(line.text))))

    # ------------------------------------------------------------------
    # Draw
    # ------------------------------------------------------------------
    def draw(self, surface: pygame.Surface) -> None:
        try:
            theme = self.theme
            fonts = getattr(self.game, "fonts", None)

            if self.background is not None:
                self.background.draw(surface)
            else:
                surface.fill(getattr(theme, "bg_bottom", (4, 6, 16)))

            if self._pending_finish or self._finished:
                return

            self._draw_stars(surface, theme)
            try:
                self.game.particles.draw(surface)
            except Exception:
                pass

            surface.blit(_overlay_surface(C.WINDOW_W, C.WINDOW_H), (0, 0))

            card = self.card
            if card is None:
                return
            if card.is_chapter:
                self._draw_chapter(surface, card, theme, fonts)
            else:
                self._draw_card(surface, card, theme, fonts)

            self._draw_chrome(surface, theme, fonts)
        except Exception:
            pass

    # -- atmosphere ------------------------------------------------------
    def _draw_stars(self, surface: pygame.Surface, theme: P.Theme) -> None:
        """Three depths of pinpricks, nudged against the pointer for parallax."""
        try:
            mx, my = getattr(self.game, "mouse_pos", (_CENTER_X, C.WINDOW_H * 0.5))
            ox = (float(mx) - _CENTER_X) / _CENTER_X
            oy = (float(my) - C.WINDOW_H * 0.5) / (C.WINDOW_H * 0.5)
            base = P.lerp_color(theme.text, theme.accent2, 0.35)
            t = self.t
            for x, y, depth, size, phase, _drift in self._stars:
                twinkle = 0.55 + 0.45 * math.sin(t * 1.9 + phase)
                col = P.shade(base, (0.25 + 0.85 * depth) * twinkle)
                px = int(x - ox * depth * 18.0)
                py = int(y - oy * depth * 11.0)
                surface.fill(col, (px, py, int(size), int(size)))
        except Exception:
            pass

    # -- card bodies -----------------------------------------------------
    def _rule(self, surface: pygame.Surface, y: int, half: int, theme: P.Theme,
              alpha: float) -> None:
        """A horizontal hairline that fades out toward both ends."""
        try:
            steps = 26
            span = half * 2
            for i in range(steps):
                # Both edges of the segment come off the same denominator, or
                # the run would be drawn with gaps in it.
                f0 = i / float(steps)
                f1 = (i + 1) / float(steps)
                mid = (f0 + f1) * 0.5
                # Bright in the middle, gone at the tips.
                power = (1.0 - abs(mid - 0.5) * 2.0) ** 0.8
                col = P.shade(P.lerp_color(theme.accent, theme.accent2, mid),
                              power * alpha)
                x0 = _CENTER_X - half + int(span * f0)
                x1 = _CENTER_X - half + int(span * f1)
                if x1 > x0:
                    surface.fill(col, (x0, y, x1 - x0, 2))
            draw_glow_circle(surface, _CENTER_X, y + 1, half * 0.35,
                             theme.accent, 0.16 * alpha)
        except Exception:
            pass

    def _blit_fading(self, surface: pygame.Surface,
                     pair: Tuple[pygame.Surface, pygame.Surface],
                     cx: int, y: int, alpha: float, lift: float = 0.0) -> None:
        """Blit a (body, shadow) pair centred on `cx`, at `alpha`, lifted."""
        body, shadow = pair
        a = int(clamp(alpha, 0.0, 1.0) * 255)
        if a <= 2:
            return
        x = int(cx - body.get_width() * 0.5)
        top = int(y + lift)
        shadow.set_alpha(int(a * 0.55))
        surface.blit(shadow, (x + 3, top + 3))
        body.set_alpha(a)
        surface.blit(body, (x, top))
        body.set_alpha(255)
        shadow.set_alpha(255)

    def _title_alpha(self) -> Tuple[float, float]:
        """(alpha, lift) for the title's entrance."""
        f = ease_out_cubic(clamp(self.card_t / _TITLE_IN, 0.0, 1.0))
        return (f * self.alpha, (1.0 - f) * -16.0)

    def _draw_card(self, surface: pygame.Surface, card: _Card, theme: P.Theme,
                   fonts: Any) -> None:
        alpha, lift = self._title_alpha()

        if card.speaker:
            draw_text(surface, card.speaker.upper(), _font(fonts, 15),
                      P.shade(P.lerp_color(theme.accent2, P.UI_WHITE, 0.2),
                              0.55 + 0.45 * alpha),
                      (_CENTER_X, _SPEAKER_Y + lift * 0.5), align="center")

        if self._title is not None:
            draw_glow_circle(surface, _CENTER_X, _TITLE_Y + 34,
                             self._title[0].get_width() * 0.42,
                             theme.accent, 0.20 * alpha)
            self._blit_fading(surface, self._title, _CENTER_X, _TITLE_Y, alpha, lift)
            self._rule(surface, _RULE_Y, 190, theme, alpha)

        self._draw_lines(surface, theme)

    def _draw_chapter(self, surface: pygame.Surface, card: _Card, theme: P.Theme,
                      fonts: Any) -> None:
        """The grander plate: a huge numeral, a long rule and more air."""
        alpha, lift = self._title_alpha()

        draw_text(surface, "C H A P T E R", _font(fonts, 16),
                  P.shade(theme.text_dim, 0.7 + 0.3 * alpha),
                  (_CENTER_X, _CH_LABEL_Y + lift * 0.4), align="center")

        if self._roman is not None:
            breathe = 0.30 + 0.14 * pulse(self.t, 1.6)
            draw_glow_circle(surface, _CENTER_X, _CH_ROMAN_Y + 66,
                             self._roman[0].get_width() * 0.62,
                             theme.accent, breathe * alpha)
            self._blit_fading(surface, self._roman, _CENTER_X, _CH_ROMAN_Y,
                              alpha, lift * 1.4)

        self._rule(surface, _CH_RULE_Y, 300, theme, alpha)

        if self._title is not None:
            self._blit_fading(surface, self._title, _CENTER_X, _CH_TITLE_Y,
                              alpha, lift * 0.6)

        self._draw_lines(surface, theme)

    def _draw_lines(self, surface: pygame.Surface, theme: P.Theme) -> None:
        """The typewriter: each line blitted clipped to its revealed width."""
        a = int(clamp(self.alpha, 0.0, 1.0) * 255)
        if a <= 2:
            return
        caret: Optional[Tuple[int, int, int]] = None
        for line in self._layout:
            shown = self._chars_shown(line)
            if shown <= 0:
                continue
            width = line.adv[min(shown, len(line.adv) - 1)]
            if width <= 0:
                continue
            height = line.body.get_height()
            area = pygame.Rect(0, 0, width, height)
            line.shadow.set_alpha(int(a * 0.5))
            surface.blit(line.shadow, (line.x + 2, line.y + 2), area=area)
            line.body.set_alpha(a)
            surface.blit(line.body, (line.x, line.y), area=area)
            line.body.set_alpha(255)
            line.shadow.set_alpha(255)
            if shown < len(line.text):
                caret = (line.x + width, line.y, height)

        if caret is not None and not self.done:
            cx, cy, ch = caret
            col = P.lerp_color(theme.accent, P.UI_WHITE, 0.4)
            surface.fill(P.shade(col, 0.55 + 0.45 * pulse(self.t, 9.0)),
                         (cx + 3, cy + 4, 2, max(6, ch - 10)))

    # -- chrome ------------------------------------------------------------
    def _draw_chrome(self, surface: pygame.Surface, theme: P.Theme,
                     fonts: Any) -> None:
        total = max(1, len(self.cards))
        dim = P.shade(theme.text_dim, 0.95)

        # Card counter, top right, with a row of pips under it.
        draw_text(surface, "CARD {} OF {}".format(self.index + 1, total),
                  _font(fonts, 14), dim, (C.WINDOW_W - 40, 30), align="right")
        pitch = 12
        span = pitch * (total - 1)
        right = C.WINDOW_W - 40
        for i in range(total):
            x = right - span + i * pitch
            if i == self.index:
                col = P.lerp_color(theme.accent, P.UI_WHITE, 0.4)
                pygame.draw.circle(surface, col, (int(x), 58), 3)
            else:
                pygame.draw.circle(surface, P.shade(dim, 0.55 if i < self.index else 0.3),
                                   (int(x), 58), 2)

        # The affordance while text is still landing.
        if not self.done:
            fade = 0.45 + 0.35 * pulse(self.t, 2.4)
            draw_text(surface, "CLICK TO REVEAL", _font(fonts, 15),
                      P.shade(dim, fade), (40, 636))

        t = self.t
        if self.done:
            self.continue_btn.draw(surface, theme, fonts, t)
        if self.skip_live:
            self.skip_btn.draw(surface, theme, fonts, t)
