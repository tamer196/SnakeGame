/**
 * Card normalisation for the story presenter - a port of `_Card`,
 * `_normalise_card(s)`, `_split_marker` and `_to_roman`
 * (`snake/scenes/story_scene.py:128-322`).
 *
 * The presenter's contract is "anything card-shaped": a `StoryCard`, a
 * `StoryBeat` (its intro), a `Chapter` (its blurb and roman), a plain object,
 * a `(title, lines)` pair or a bare string. This module is pure and is the
 * ONLY place the Chapter duck-type lives: TS's `Chapter.roman` is a *method*
 * where Python's is a property, and a literal `_pick` transcription would see
 * a function, fail the string test, and silently demote every chapter plate
 * to an ordinary card - no numeral, no long rule, wrong vertical rhythm
 * (scenes.md §10.3.4). If a third producer is ever added it inherits the fix.
 */

/** One normalised narrative card, whatever shape it arrived in. */
export interface StoryCardView {
  readonly title: string;
  readonly lines: readonly string[];
  readonly speaker: string;
  /** Non-empty promotes the card to a chapter plate. */
  readonly roman: string;
}

export function isChapterCard(card: StoryCardView): boolean {
  return card.roman !== "";
}

/** Roman numerals we can both read and write, I..XII plus headroom. */
const ROMAN_VALUES: ReadonlyArray<readonly [number, string]> = [
  [1000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"], [90, "XC"],
  [50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"],
];
const ROMAN_RE = /^[IVXLCDM]+$/;
const CHAPTER_WORDS = new Set(["chapter", "chapters", "chap", "ch", "act", "part", "book"]);
const SEPARATORS = "-–—:.·|";

function stripSeparators(s: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && SEPARATORS.includes(s[a]!)) a++;
  while (b > a && SEPARATORS.includes(s[b - 1]!)) b--;
  return s.slice(a, b);
}

/** Arabic to roman, clamped to something a numeral can express. */
export function toRoman(n: number): string {
  let v = Math.trunc(Math.max(1, Math.min(3999, Number.isFinite(n) ? n : 1)));
  let out = "";
  for (const [value, glyph] of ROMAN_VALUES) {
    while (v >= value) {
      out += glyph;
      v -= value;
    }
  }
  return out;
}

/**
 * Pull a chapter marker off the front of `title` - `(roman, remainder)`; an
 * empty roman means an ordinary card. Understood: "Chapter II - Name",
 * "CHAPTER 2: Name", "Act III", "II. Name" and the bare roman "IV".
 *
 * Known false positive, ported verbatim: `"Mill. Road"` reads as roman MILL.
 * No shipped title hits it; "fixing" it changes which cards become plates.
 */
export function splitMarker(title: unknown): [string, string] {
  const raw = String(title ?? "").trim();
  if (!raw) return ["", ""];

  const space = raw.indexOf(" ");
  const head = space < 0 ? raw : raw.slice(0, space);
  const tail = space < 0 ? "" : raw.slice(space + 1);
  const word = stripSeparators(head).toLowerCase();

  let number: string;
  let rest: string;
  if (CHAPTER_WORDS.has(word)) {
    // "Chapter II - Cold Boot" -> the number token is the next word.
    const trimmed = tail.trim();
    const s2 = trimmed.indexOf(" ");
    const token = s2 < 0 ? trimmed : trimmed.slice(0, s2);
    number = stripSeparators(token);
    rest = s2 < 0 ? "" : trimmed.slice(s2 + 1);
    if (!number) return ["", raw];
  } else {
    // "II. Cold Boot" / "IV" -> the first token is the numeral itself.
    const token = stripSeparators(head);
    if (!token || !ROMAN_RE.test(token.toUpperCase())) return ["", raw];
    // A bare roman only counts when it was punctuated or stands alone;
    // otherwise a title beginning "I ..." or "Mill ..." would be eaten.
    if (tail && head === token) return ["", raw];
    number = token;
    rest = tail;
  }

  number = number.trim();
  if (!number) return ["", raw];
  let roman: string;
  if (/^\d+$/.test(number)) roman = toRoman(parseInt(number, 10));
  else if (ROMAN_RE.test(number.toUpperCase())) roman = number.toUpperCase();
  else return ["", raw];

  let remainder = rest.trim();
  remainder = stripSeparators(remainder).trim();
  return [roman, remainder];
}

/** Coerce a lines-ish value into clean, non-empty strings. Capped at 8. */
function asLines(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  let parts: string[];
  if (typeof value === "string") {
    parts = value.split(/\r\n|\r|\n/);
  } else if (Array.isArray(value)) {
    parts = value.map((v) => String(v));
  } else if (
    typeof value === "object" &&
    typeof (value as Iterable<unknown>)[Symbol.iterator] === "function"
  ) {
    parts = [...(value as Iterable<unknown>)].map((v) => String(v));
  } else {
    parts = [String(value)];
  }
  const out: string[] = [];
  for (const part of parts) {
    const text = String(part).replace(/\t/g, " ").replace(/\s+$/g, "");
    if (text.trim()) out.push(text.trim());
  }
  return out.slice(0, 8); // a card is never a wall of text
}

/** First present, non-empty (truthy) property named in `names`. */
function pick(source: unknown, ...names: string[]): unknown {
  const record = source as Record<string, unknown>;
  for (const name of names) {
    const value = record[name];
    if (value) return value;
  }
  return null;
}

/**
 * The roman probe - §10.3.4's duck-type. `Chapter.roman` is a method in TS,
 * a property in Python; both shapes (and a plain string) resolve here.
 */
function romanOf(raw: unknown): string {
  const v = (raw as { roman?: unknown }).roman;
  let s = "";
  if (typeof v === "function") {
    try {
      s = String((v as () => string).call(raw));
    } catch {
      s = "";
    }
  } else if (typeof v === "string") {
    s = v;
  }
  return ROMAN_RE.test(s.toUpperCase()) && s !== "" ? s.toUpperCase() : "";
}

/** Turn anything card-shaped into a card, or null if it holds no text. */
export function normaliseCard(raw: unknown): StoryCardView | null {
  if (raw === null || raw === undefined) return null;
  try {
    if (typeof raw === "string") {
      const lines = asLines(raw);
      if (!lines.length) return null;
      // A lone line carrying a chapter marker is a plate, not prose.
      if (lines.length === 1) {
        const [roman, rest] = splitMarker(lines[0]!);
        if (roman) return { title: rest, lines: [], speaker: "", roman };
      }
      return { title: "", lines, speaker: "", roman: "" };
    }

    if (Array.isArray(raw)) {
      // A (title, lines) pair, or just a bundle of lines.
      if (raw.length === 2 && typeof raw[0] === "string" && typeof raw[1] !== "string") {
        return {
          title: String(raw[0]).trim(),
          lines: asLines(raw[1]),
          speaker: "",
          roman: "",
        };
      }
      const lines = asLines(raw);
      return lines.length ? { title: "", lines, speaker: "", roman: "" } : null;
    }

    let title = String(pick(raw, "title", "name", "heading") ?? "").trim();
    const lines = asLines(pick(raw, "lines", "text", "body", "blurb", "intro", "outro"));
    const speaker = String(pick(raw, "speaker", "voice", "attribution") ?? "").trim();

    let roman = romanOf(raw);
    if (!roman) {
      const number = pick(raw, "chapter_number");
      if (typeof number === "number" && Number.isInteger(number)) {
        roman = toRoman(number);
      }
    }
    if (!roman) {
      const [marker, rest] = splitMarker(title);
      roman = marker;
      title = rest;
    }
    if (!title && !lines.length) return null;
    return { title, lines, speaker, roman };
  } catch {
    return null;
  }
}

/** Normalise a whole card list; a single card is accepted on its own. Capped at 24. */
export function normaliseCards(raw: unknown): StoryCardView[] {
  if (raw === null || raw === undefined) return [];
  let items: unknown[];
  if (Array.isArray(raw)) items = raw;
  else items = [raw];
  const out: StoryCardView[] = [];
  for (const item of items.slice(0, 24)) {
    const card = normaliseCard(item);
    if (card) out.push(card);
  }
  return out;
}
