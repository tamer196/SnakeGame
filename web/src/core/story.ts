/**
 * Story mode narrative for NEON SERPENT - a port of `snake/core/story.py`.
 *
 * The campaign is a descent. A lone data-serpent wakes on the outer lattice of a
 * dying machine and eats its way inward, layer by layer, until it reaches the
 * core that dreamed the whole thing. Twelve levels, four chapters of three, one
 * beat per level.
 *
 * This module is **pure data**: no rendering, no state, no I/O. It knows nothing
 * about scenes; it only hands out text. Every accessor clamps its input and is
 * total - it never throws and never returns `undefined` - so a scene can call
 * `getBeat(game.levelIndex)` unguarded. NaN, the infinities and non-integers
 * each have an explicit arm: the Python original had a real bug where
 * `int(float("inf"))` raised `OverflowError` straight out of every accessor
 * built on `_clamp_index`, so the clamping here saturates instead.
 *
 * The text itself lives in `data/story.json`, exported from the Python module.
 */

import rawStory from "../data/story.json";
import rawLevels from "../data/levels.json";

// ==========================================================================
// Shapes
// ==========================================================================

/** Levels per chapter. Twelve levels / four chapters. */
export const CHAPTER_SIZE: number = 3;

/**
 * One level's worth of narrative.
 */
export interface StoryBeat {
  /** Zero-based level this beat belongs to (matches `LEVELS[levelIndex]`). */
  readonly levelIndex: number;
  /** One-based chapter number, 1..4. */
  readonly chapter: number;
  /**
   * Title of the chapter this beat sits in, repeated here so a caller with only
   * a beat never has to look the chapter up.
   */
  readonly chapterTitle: string;
  /** The beat's own title, shown on the card above the lines. */
  readonly title: string;
  /** Short lines shown *before* the level is played. */
  readonly intro: readonly string[];
  /** Short lines shown *after* the level is cleared. */
  readonly outro: readonly string[];
  /** Flavour label for who or what is talking; `""` means unattributed. */
  readonly speaker: string;
}

/**
 * A standalone narrative card that belongs to no single level.
 *
 * Used for the prologue (once, when a new story run starts) and the epilogue
 * (after Prism Core falls). Same shape as a beat's text block so a scene can
 * render all three with one routine.
 */
export interface StoryCard {
  /** Card title, shown large. */
  readonly title: string;
  /** The card's lines, in order. */
  readonly lines: readonly string[];
  /** Flavour label for the speaker; `""` means unattributed. */
  readonly speaker: string;
}

/**
 * One act of the descent: three consecutive levels sharing a mood.
 */
export interface Chapter {
  /** One-based chapter number, 1..4. */
  readonly number: number;
  /** Chapter title, shown large on the chapter card. */
  readonly title: string;
  /** One or two lines setting the mood for the whole act. */
  readonly blurb: readonly string[];
  /** Zero-based index of the chapter's first level. */
  readonly firstIndex: number;
  /** Zero-based index of the chapter's last level (inclusive). */
  readonly lastIndex: number;
  /** The chapter number as a roman numeral, for the card header. */
  roman(): string;
  /** `[firstIndex, lastIndex]`, both zero-based and inclusive. */
  levelRange(): [number, number];
  /** Every zero-based level index in this chapter, in order. */
  levelIndices(): number[];
  /** True when `levelIndex` falls inside this chapter. Never throws. */
  contains(levelIndex: number): boolean;
}

const ROMAN: readonly string[] = ["", "I", "II", "III", "IV", "V", "VI"];

/** Concrete {@link Chapter}, so the derived views stay methods and not stored data. */
class ChapterRecord implements Chapter {
  constructor(
    readonly number: number,
    readonly title: string,
    readonly blurb: readonly string[],
    readonly firstIndex: number,
    readonly lastIndex: number,
  ) {}

  roman(): string {
    if (Number.isInteger(this.number) && this.number > 0 && this.number < ROMAN.length) {
      return ROMAN[this.number] ?? String(this.number);
    }
    return String(this.number);
  }

  levelRange(): [number, number] {
    return [this.firstIndex, this.lastIndex];
  }

  levelIndices(): number[] {
    const out: number[] = [];
    if (!Number.isFinite(this.firstIndex) || !Number.isFinite(this.lastIndex)) return out;
    for (let i = Math.trunc(this.firstIndex); i <= Math.trunc(this.lastIndex); i++) {
      out.push(i);
    }
    return out;
  }

  contains(levelIndex: number): boolean {
    const idx = typeof levelIndex === "number" ? levelIndex : Number(levelIndex);
    if (!Number.isFinite(idx)) return false;
    const i = Math.trunc(idx);
    return this.firstIndex <= i && i <= this.lastIndex;
  }
}

// ==========================================================================
// Loading the exported narrative
// ==========================================================================

interface RawBeat {
  readonly level_index?: unknown;
  readonly chapter?: unknown;
  readonly chapter_title?: unknown;
  readonly title?: unknown;
  readonly intro?: unknown;
  readonly outro?: unknown;
  readonly speaker?: unknown;
}

interface RawChapter {
  readonly number?: unknown;
  readonly title?: unknown;
  readonly blurb?: unknown;
  readonly first_index?: unknown;
  readonly last_index?: unknown;
}

interface RawCard {
  readonly title?: unknown;
  readonly lines?: unknown;
  readonly speaker?: unknown;
}

const RAW = rawStory as unknown as {
  beats?: readonly RawBeat[];
  chapters?: readonly RawChapter[];
  prologue?: RawCard;
  epilogue?: RawCard;
};

function intOf(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function textOf(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function linesOf(v: unknown): readonly string[] {
  if (!Array.isArray(v)) return [];
  return (v as unknown[]).filter((s): s is string => typeof s === "string");
}

function cardOf(v: RawCard | undefined): StoryCard {
  return {
    title: textOf(v?.title),
    lines: linesOf(v?.lines),
    speaker: textOf(v?.speaker),
  };
}

/** The twelve beats, in level order. */
export const BEATS: readonly StoryBeat[] = (RAW.beats ?? []).map((b, i) => ({
  levelIndex: intOf(b.level_index, i),
  chapter: intOf(b.chapter, Math.floor(i / CHAPTER_SIZE) + 1),
  chapterTitle: textOf(b.chapter_title),
  title: textOf(b.title),
  intro: linesOf(b.intro),
  outro: linesOf(b.outro),
  speaker: textOf(b.speaker),
}));

/** How many beats the campaign has. */
export const BEAT_COUNT: number = BEATS.length;

/** The four chapters, in order. */
export const CHAPTERS: readonly Chapter[] = (RAW.chapters ?? []).map(
  (c, i) =>
    new ChapterRecord(
      intOf(c.number, i + 1),
      textOf(c.title),
      linesOf(c.blurb),
      intOf(c.first_index, i * CHAPTER_SIZE),
      intOf(c.last_index, i * CHAPTER_SIZE + CHAPTER_SIZE - 1),
    ),
);

/** How many chapters the campaign has. */
export const CHAPTER_COUNT: number = CHAPTERS.length;

/** Shown once, when a new story run starts. */
export const PROLOGUE: StoryCard = cardOf(RAW.prologue);

/** Shown after Prism Core falls. */
export const EPILOGUE: StoryCard = cardOf(RAW.epilogue);

/** The beat handed back when the table is empty; keeps every accessor total. */
const EMPTY_BEAT: StoryBeat = {
  levelIndex: 0,
  chapter: 1,
  chapterTitle: "",
  title: "",
  intro: [],
  outro: [],
  speaker: "",
};

/** The chapter handed back when the table is empty; keeps every accessor total. */
const EMPTY_CHAPTER: Chapter = new ChapterRecord(1, "", [], 0, 0);

// ==========================================================================
// Accessors - all clamped, none of them throw
// ==========================================================================

/**
 * Coerce anything at all to a valid `0..hi` index. Never throws.
 *
 * `+Infinity` saturates at `hi`; `-Infinity`, `NaN` and anything uncoercible
 * land at `0`. Non-integers truncate toward zero, matching Python's `int()`.
 */
function clampIndex(levelIndex: number, hi: number): number {
  const raw = typeof levelIndex === "number" ? levelIndex : Number(levelIndex);
  if (Number.isNaN(raw)) return 0;
  const top = hi > 0 ? hi : 0;
  if (raw === Number.POSITIVE_INFINITY) return top;
  if (raw === Number.NEGATIVE_INFINITY) return 0;
  if (!Number.isFinite(raw)) return 0;
  const idx = Math.trunc(raw);
  if (idx < 0) return 0;
  if (idx > top) return top;
  return idx;
}

/**
 * The beat for level `levelIndex`, clamped into range.
 *
 * Never throws and never returns `undefined`: out-of-range or nonsense input
 * yields the first or last beat, so a scene can call this unguarded.
 */
export function getBeat(levelIndex: number): StoryBeat {
  if (BEAT_COUNT === 0) return EMPTY_BEAT;
  return BEATS[clampIndex(levelIndex, BEAT_COUNT - 1)] ?? EMPTY_BEAT;
}

/**
 * The chapter that owns level `levelIndex`, clamped into range.
 *
 * Never throws. Derived from the beat rather than from arithmetic so the
 * chapter grouping stays defined in exactly one place: the beat table.
 */
export function getChapter(levelIndex: number): Chapter {
  if (CHAPTER_COUNT === 0) return EMPTY_CHAPTER;
  const number = getBeat(levelIndex).chapter;
  for (const ch of CHAPTERS) {
    if (ch.number === number) return ch;
  }
  return CHAPTERS[clampIndex(number - 1, CHAPTER_COUNT - 1)] ?? EMPTY_CHAPTER;
}

/**
 * Every beat in chapter `chapterNumber` (1-based), in order.
 *
 * Never throws; NaN, the infinities and anything uncoercible give an empty
 * array, and a non-integer truncates toward zero before matching.
 */
export function beatsInChapter(chapterNumber: number): StoryBeat[] {
  const raw = typeof chapterNumber === "number" ? chapterNumber : Number(chapterNumber);
  if (!Number.isFinite(raw)) return [];
  const num = Math.trunc(raw);
  return BEATS.filter((b) => b.chapter === num);
}

/**
 * True when `levelIndex` is the first level of a chapter.
 *
 * This is the cue for the scene to show a chapter card before the level's own
 * intro. Clamped, so nonsense input answers for the nearest real level.
 */
export function chapterStart(levelIndex: number): boolean {
  if (BEAT_COUNT === 0) return false;
  return getChapter(levelIndex).firstIndex === clampIndex(levelIndex, BEAT_COUNT - 1);
}

/** True when clearing `levelIndex` closes out its chapter. */
export function chapterEnd(levelIndex: number): boolean {
  if (BEAT_COUNT === 0) return false;
  return getChapter(levelIndex).lastIndex === clampIndex(levelIndex, BEAT_COUNT - 1);
}

/** The whole campaign narrative, in order. */
export function allBeats(): readonly StoryBeat[] {
  return BEATS;
}

// ==========================================================================
// Self-check
// ==========================================================================

/** The level names the narrative was written against, in order. */
const EXPECTED_LEVEL_NAMES: readonly string[] = [
  "Neon Grid", "Deep Nebula", "Emerald Circuit", "Solar Flare",
  "Abyssal Tide", "Violet Static", "Frozen Vault", "Toxic Bloom",
  "Crimson Engine", "Aurora Drift", "Event Horizon", "Prism Core",
];

/**
 * Cross-check the narrative against the level table and itself.
 *
 * Returns a list of human-readable problems; empty means consistent. The level
 * cross-check reads `data/levels.json` directly rather than `core/level.ts`, so
 * this module stays free of every other dependency in the package.
 */
export function validateStory(): string[] {
  const problems: string[] = [];

  if (BEAT_COUNT !== CHAPTER_COUNT * CHAPTER_SIZE) {
    problems.push(
      `${BEAT_COUNT} beats does not fill ${CHAPTER_COUNT} chapters of ${CHAPTER_SIZE}`,
    );
  }

  for (let i = 0; i < BEAT_COUNT; i++) {
    const beat = BEATS[i];
    if (!beat) continue;
    if (beat.levelIndex !== i) problems.push(`beat ${i}: levelIndex is ${beat.levelIndex}`);
    if (beat.intro.length === 0 || beat.outro.length === 0) {
      problems.push(`${beat.title}: empty intro or outro`);
    }
    if (beat.intro.length > 4 || beat.outro.length > 4) {
      problems.push(`${beat.title}: more than four lines in a block`);
    }
    const ch = getChapter(i);
    if (beat.chapterTitle !== ch.title) {
      problems.push(`${beat.title}: chapterTitle '${beat.chapterTitle}' != '${ch.title}'`);
    }
    if (!ch.contains(i)) {
      problems.push(`${beat.title}: outside chapter ${ch.number} range`);
    }
  }

  const covered: number[] = [];
  for (const ch of CHAPTERS) {
    if (ch.lastIndex < ch.firstIndex) {
      problems.push(`chapter ${ch.number}: inverted level range`);
    }
    if (ch.blurb.length === 0) problems.push(`chapter ${ch.number}: empty blurb`);
    covered.push(...ch.levelIndices());
  }
  covered.sort((a, b) => a - b);
  const expectedCover = Array.from({ length: BEAT_COUNT }, (_, i) => i);
  if (covered.length !== expectedCover.length
      || covered.some((v, i) => v !== expectedCover[i])) {
    problems.push("chapters do not cover every level exactly once");
  }

  const starts: number[] = [];
  for (let i = 0; i < BEAT_COUNT; i++) if (chapterStart(i)) starts.push(i);
  const firsts = CHAPTERS.map((ch) => ch.firstIndex);
  if (starts.length !== firsts.length || starts.some((v, i) => v !== firsts[i])) {
    problems.push(`chapterStart() disagrees with the chapter table: ${starts.join(",")}`);
  }

  if (PROLOGUE.lines.length === 0 || EPILOGUE.lines.length === 0) {
    problems.push("prologue or epilogue has no lines");
  }

  // -- agreement with the actual campaign ----------------------------------
  const levels = (rawLevels as unknown as { levels?: readonly { name?: unknown }[] }).levels;
  if (!Array.isArray(levels)) {
    problems.push("could not read data/levels.json");
    return problems;
  }
  if (levels.length !== BEAT_COUNT) {
    problems.push(`${levels.length} levels but ${BEAT_COUNT} beats`);
  }
  const n = Math.min(levels.length, EXPECTED_LEVEL_NAMES.length);
  for (let i = 0; i < n; i++) {
    const got = textOf(levels[i]?.name);
    const want = EXPECTED_LEVEL_NAMES[i];
    if (got !== want) {
      problems.push(`level ${i + 1} is '${got}', story was written for '${want}'`);
    }
  }
  return problems;
}
