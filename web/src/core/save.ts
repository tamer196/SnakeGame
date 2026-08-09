/**
 * Persistent player progress for NEON SERPENT (web port of `snake/core/save.py`).
 *
 * A single small JSON document in `localStorage` holds everything that must
 * survive a reload: the all-time high score, how far the player has unlocked,
 * the best score and star rating per level, the settings and the story state.
 *
 * Two properties matter more than anything else here:
 *
 * *   **Loading never raises.** A missing key, a `localStorage` that throws on
 *     access (private browsing, disabled storage, a sandboxed iframe),
 *     truncated JSON, JSON that is an array instead of an object, a string
 *     where a number belongs - every one of those cases yields a perfectly
 *     usable {@link SaveData} full of defaults. A corrupt save must never stop
 *     somebody from playing.
 *
 * *   **Saving never raises.** The Python version got its safety from an
 *     atomic `os.replace`; `localStorage.setItem` is already atomic per key, so
 *     the web hazard is different: it can throw `QuotaExceededError`, or throw
 *     merely for being touched. Every write is therefore mirrored into an
 *     in-memory document first, so that a failed write degrades to
 *     "this session remembers, the next one does not" instead of an exception.
 *     {@link SaveData.save} reports success with a boolean callers may ignore.
 *
 * Every value read from storage is coerced and clamped on the way in, and
 * unknown keys are dropped, so the rest of the game can treat the fields as
 * trustworthy plain numbers/booleans/records without re-validating.
 *
 * Schema 2 adds the settings and story-mode state: the display mode, the chosen
 * difficulty and game mode, story progress, the narrative beats already seen and
 * a *per-difficulty* copy of the best-score / star tables, so that a three-star
 * clear on easy can never overwrite a two-star clear on expert. A schema 1
 * document is migrated forward on load (its legacy tables are adopted as the
 * default difficulty's records) rather than discarded.
 */

import * as C from "./config";
import { clamp } from "./mathx";
import { THEME_COUNT } from "./palette";

// ---------------------------------------------------------------------------
// Limits used while validating a loaded document
// ---------------------------------------------------------------------------

/** Version stamped into every document this module writes. */
export const SCHEMA_VERSION = 2;

/**
 * How many levels the game has.
 *
 * `core/level` owns the authoritative count, but importing it from here would
 * drag the level table into the save layer for one integer. The themes list is
 * defined to be exactly parallel to the levels, so its length is the same
 * number and `palette` is guaranteed dependency-free.
 */
export const LEVEL_COUNT: number = THEME_COUNT || 1;

/** Highest star rating a single level can award. */
export const MAX_STARS = 3;

/** Default `localStorage` key; the Python counterpart is `config.SAVE_PATH`. */
export const DEFAULT_SAVE_KEY = "neon-serpent-save";

const MAX_SCORE = 99_999_999; // sanity ceiling: keeps a doctored document sane
const MAX_COUNTER = 999_999_999;
const MAX_LEVEL_KEY = 255; // bounds the size of the per-level records
const MAX_BEAT_KEY = 255; // bounds the size of the seen-beats list

function uniqueStrings(values: readonly unknown[], fallback: readonly string[]): string[] {
  const out: string[] = [];
  for (const v of values) {
    if (typeof v === "string" && v.length > 0 && !out.includes(v)) out.push(v);
  }
  return out.length > 0 ? out : [...fallback];
}

/**
 * Known difficulty keys, in menu order. Validated against config, with a
 * hard-coded fallback so a stripped or future export can never make the save
 * layer explode.
 */
export const DIFFICULTIES: readonly string[] = uniqueStrings(
  [C.DIFF_EASY, C.DIFF_NORMAL, C.DIFF_HARD, C.DIFF_EXPERT],
  ["easy", "normal", "hard", "expert"],
);

/** The difficulty a fresh profile starts on. */
export const DEFAULT_DIFFICULTY: string = DIFFICULTIES.includes(C.DEFAULT_DIFFICULTY)
  ? C.DEFAULT_DIFFICULTY
  : (DIFFICULTIES[0] as string);

/**
 * Display modes the settings screen may store. The web export carries no
 * display-mode constants (there is no windowed/fullscreen distinction in a
 * browser), so this is the Python fallback tuple verbatim; the field exists so
 * a saved document round-trips between the two builds.
 */
export const DISPLAY_MODES: readonly string[] = ["windowed", "borderless", "fullscreen"];

/** The display mode a fresh profile starts on. */
export const DEFAULT_DISPLAY_MODE: string = DISPLAY_MODES[0] as string;

/** Known game modes, in menu order. */
export const GAME_MODES: readonly string[] = uniqueStrings(
  [C.MODE_STORY, C.MODE_FREE],
  ["story", "free"],
);

/** The game mode a fresh profile starts in. */
export const DEFAULT_MODE: string = GAME_MODES.includes(C.DEFAULT_MODE)
  ? C.DEFAULT_MODE
  : (GAME_MODES[0] as string);

const TRUE_STRINGS = new Set(["1", "true", "yes", "on", "y", "t"]);
const FALSE_STRINGS = new Set(["0", "false", "no", "off", "n", "f", ""]);

/** A `{levelKey: value}` table. Keys are `String(levelIndex)`. */
export type LevelTable = Record<string, number>;

/** A `{difficulty: {levelKey: value}}` table. */
export type DifficultyTable = Record<string, LevelTable>;

/** The plain JSON document {@link SaveData.toDict} produces. */
export interface SaveDocument {
  schema: number;
  highscore: number;
  unlocked: number;
  best: LevelTable;
  stars: LevelTable;
  muted: boolean;
  totalFood: number;
  totalDeaths: number;
  displayMode: string;
  difficulty: string;
  mode: string;
  storyProgress: number;
  storyComplete: boolean;
  seenBeats: number[];
  bestByDifficulty: DifficultyTable;
  starsByDifficulty: DifficultyTable;
}

// ---------------------------------------------------------------------------
// Coercion helpers - each one takes anything at all and returns a valid value
// ---------------------------------------------------------------------------

/** Best-effort conversion of an arbitrary JSON value to an integer. */
function asInt(value: unknown, dflt = 0): number {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") {
    // NaN and the infinities cannot be turned into an integer.
    if (!Number.isFinite(value)) return dflt;
    return Math.trunc(value);
  }
  if (typeof value === "string") {
    const text = value.trim();
    if (text === "") return dflt;
    const num = Number(text);
    if (!Number.isFinite(num)) return dflt;
    return Math.trunc(num);
  }
  return dflt;
}

/** Best-effort conversion of an arbitrary JSON value to a boolean. */
function asBool(value: unknown, dflt = false): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (Number.isNaN(value)) return dflt;
    return value !== 0;
  }
  if (typeof value === "string") {
    const text = value.trim().toLowerCase();
    if (TRUE_STRINGS.has(text)) return true;
    if (FALSE_STRINGS.has(text)) return false;
  }
  return dflt;
}

/** Integer clamp (`mathx.clamp` is float-typed, so re-truncate the result). */
function clampInt(value: number, lo: number, hi: number): number {
  if (!Number.isFinite(value)) return lo;
  return Math.trunc(clamp(value, lo, hi));
}

/** True for a plain (non-array, non-null) object - JSON's idea of a mapping. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Normalise a per-level table key.
 *
 * JSON object keys are always strings, but a hand-edited document might hold
 * `"3"`, `3`, `" 3 "` or `"three"`. Anything that resolves to a plausible level
 * index becomes the canonical `String(int)`; anything else returns null so the
 * caller can drop the entry.
 */
function levelKey(levelIndex: unknown): string | null {
  if (typeof levelIndex === "boolean") return null;
  const idx = asInt(levelIndex, -1);
  if (idx < 0 || idx > MAX_LEVEL_KEY) return null;
  return String(idx);
}

/**
 * Coerce a JSON object into a clean `{levelKey: number}` table.
 *
 * Non-objects become empty tables; entries with unusable keys or values are
 * dropped rather than defaulted, because an invented "best score" is worse than
 * no record at all. Duplicate keys after normalisation (e.g. `"3"` and `" 3 "`)
 * keep the larger value.
 */
function asIntTable(raw: unknown, lo: number, hi: number): LevelTable {
  const out: LevelTable = {};
  if (!isRecord(raw)) return out;
  for (const [key, value] of Object.entries(raw)) {
    const norm = levelKey(key);
    if (norm === null) continue;
    const t = typeof value;
    if (t !== "number" && t !== "string" && t !== "boolean") continue;
    const num = clampInt(asInt(value, 0), lo, hi);
    const previous = out[norm];
    out[norm] = previous === undefined ? num : Math.max(previous, num);
  }
  return out;
}

/** Return `value` when it names one of `choices` (case/space-insensitive). */
function asChoice(value: unknown, choices: readonly string[], dflt: string): string {
  if (typeof value === "string") {
    const text = value.trim().toLowerCase();
    for (const option of choices) {
      if (text === option.toLowerCase()) return option;
    }
  }
  return dflt;
}

/**
 * Normalise a difficulty name, or return `dflt` (null by default) when it is
 * not one of the known difficulties.
 */
function difficultyKey(value: unknown, dflt: string | null = null): string | null {
  if (typeof value === "string") {
    const text = value.trim().toLowerCase();
    for (const option of DIFFICULTIES) {
      if (text === option.toLowerCase()) return option;
    }
  }
  return dflt;
}

/** A fresh `{difficulty: {}}` table with every known difficulty present. */
function emptyDifficultyTable(): DifficultyTable {
  const out: DifficultyTable = {};
  for (const name of DIFFICULTIES) out[name] = {};
  return out;
}

/**
 * Coerce a JSON object into `{difficulty: {levelKey: number}}`.
 *
 * Every known difficulty is always present in the result (empty when the
 * document said nothing about it) and unknown difficulty names are dropped, so
 * callers can index the outer record without a lookup dance.
 */
function asDifficultyTable(raw: unknown, lo: number, hi: number): DifficultyTable {
  const out = emptyDifficultyTable();
  if (!isRecord(raw)) return out;
  for (const [key, value] of Object.entries(raw)) {
    const name = difficultyKey(key);
    if (name === null) continue;
    const inner = asIntTable(value, lo, hi);
    const merged = out[name] ?? {};
    for (const [lvl, num] of Object.entries(inner)) {
      const previous = merged[lvl];
      merged[lvl] = previous === undefined ? num : Math.max(previous, num);
    }
    out[name] = merged;
  }
  return out;
}

/**
 * Coerce a JSON array into a sorted, de-duplicated list of clamped integers.
 *
 * Non-arrays become an empty list; unusable entries are dropped rather than
 * defaulted.
 */
function asIntList(raw: unknown, lo: number, hi: number): number[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<number>();
  for (const value of raw) {
    if (typeof value === "boolean") continue;
    if (typeof value !== "number" && typeof value !== "string") continue;
    const num = asInt(value, -1);
    if (num < lo || num > hi) continue;
    seen.add(num);
  }
  return [...seen].sort((a, b) => a - b);
}

/** Sort a level table's keys numerically, for a stable serialised document. */
function sortedLevelTable(table: LevelTable): LevelTable {
  const out: LevelTable = {};
  const keys = Object.keys(table).sort((a, b) => Number(a) - Number(b));
  for (const key of keys) {
    const value = table[key];
    if (value !== undefined) out[key] = Math.trunc(value);
  }
  return out;
}

/**
 * Serialise a per-difficulty table back to plain JSON-safe records.
 *
 * Re-validates on the way out as well as on the way in, so a caller that poked
 * a bad value straight into the field cannot produce a document this module
 * would then refuse to read.
 */
function dumpDifficultyTable(table: unknown, lo: number, hi: number): DifficultyTable {
  const validated = asDifficultyTable(table, lo, hi);
  const out: DifficultyTable = {};
  for (const name of Object.keys(validated).sort()) {
    out[name] = sortedLevelTable(validated[name] ?? {});
  }
  return out;
}

// ---------------------------------------------------------------------------
// Storage - localStorage where it works, an in-memory map where it does not
// ---------------------------------------------------------------------------

/** The slice of the Web Storage API this module needs. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Documents held for this session only, when a real write is impossible. */
const memoryStore = new Map<string, string>();

/**
 * The best available backing store, or null when there is none.
 *
 * Merely *touching* `localStorage` throws in some sandboxed iframes and in
 * Safari's private mode, so the access itself is guarded.
 */
function getStorage(): StorageLike | null {
  try {
    const store = (globalThis as { localStorage?: StorageLike }).localStorage;
    if (store && typeof store.getItem === "function" && typeof store.setItem === "function") {
      return store;
    }
  } catch {
    // Storage access denied - fall through to the in-memory document.
  }
  return null;
}

function readRaw(key: string): string | null {
  const store = getStorage();
  if (store !== null) {
    try {
      const text = store.getItem(key);
      if (typeof text === "string") return text;
    } catch {
      // Unreadable - fall through to whatever this session has in memory.
    }
  }
  return memoryStore.get(key) ?? null;
}

function writeRaw(key: string, text: string): boolean {
  // Always mirror in memory first, so a quota failure still keeps the session
  // consistent with what the game believes it saved.
  memoryStore.set(key, text);
  const store = getStorage();
  if (store === null) return false;
  try {
    store.setItem(key, text);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// SaveData
// ---------------------------------------------------------------------------

/**
 * The player's persistent profile.
 *
 * `key` is the `localStorage` key this profile lives under; it is deliberately
 * *not* part of the serialised document, so a save can be copied or relocated
 * without carrying a stale key around inside it.
 *
 * `best` and `stars` are keyed by `String(levelIndex)` because JSON object keys
 * must be strings - use {@link SaveData.bestFor} / {@link SaveData.starsFor}
 * rather than indexing them directly.
 *
 * `bestByDifficulty` / `starsByDifficulty` are the same tables one level
 * deeper: `{difficulty: {levelKey: value}}`, with every difficulty in
 * {@link DIFFICULTIES} always present. The flat `best` / `stars` remain the
 * difficulty-agnostic "best ever, however you played it" view that the older UI
 * code reads, and both are kept in step by {@link SaveData.record}.
 */
export class SaveData {
  /** The `localStorage` key this profile is stored under. */
  key: string;

  /** All-time best score across every level and difficulty. */
  highscore = 0;

  /** Number of levels selectable, always at least 1. */
  unlocked = 1;

  /** Difficulty-agnostic best score per level. */
  best: LevelTable = {};

  /** Difficulty-agnostic best star rating per level. */
  stars: LevelTable = {};

  /** Audio mute preference. */
  muted = false;

  /** Lifetime food eaten. */
  totalFood = 0;

  /** Lifetime deaths. */
  totalDeaths = 0;

  // --- schema 2: settings --------------------------------------------------

  /** Windowed / borderless / fullscreen preference (desktop build). */
  displayMode: string = DEFAULT_DISPLAY_MODE;

  /** Currently selected difficulty key. */
  difficulty: string = DEFAULT_DIFFICULTY;

  /** Currently selected game mode (story or free play). */
  mode: string = DEFAULT_MODE;

  // --- schema 2: story mode ------------------------------------------------

  /** Highest story level reached, zero-based. */
  storyProgress = 0;

  /** True once the campaign has been finished. */
  storyComplete = false;

  /** Sorted indices of the narrative beats already shown. */
  seenBeats: number[] = [];

  // --- schema 2: per-difficulty records ------------------------------------

  /** Best score per level, per difficulty. */
  bestByDifficulty: DifficultyTable = emptyDifficultyTable();

  /** Best star rating per level, per difficulty. */
  starsByDifficulty: DifficultyTable = emptyDifficultyTable();

  /** Set by every mutating helper; {@link flush} uses it to skip pointless writes. */
  private _dirty = false;

  /**
   * A profile full of defaults, bound to a storage key.
   *
   * @param key - the `localStorage` key; defaults to {@link DEFAULT_SAVE_KEY}.
   */
  constructor(key: string = DEFAULT_SAVE_KEY) {
    this.key = typeof key === "string" ? key : DEFAULT_SAVE_KEY;
  }

  // ------------------------------------------------------------------
  // Loading
  // ------------------------------------------------------------------

  /**
   * Read the profile stored under `key`, falling back to defaults for anything
   * storage cannot supply. Guaranteed not to throw, for any input at all.
   */
  static load(key: string = DEFAULT_SAVE_KEY): SaveData {
    const data = new SaveData(typeof key === "string" ? key : DEFAULT_SAVE_KEY);

    let raw: unknown = null;
    try {
      const text = readRaw(data.key);
      if (text === null) return data; // never saved, or storage unavailable
      raw = JSON.parse(text);
    } catch {
      // Malformed JSON, an exotic storage error, or a pathological document.
      // A fresh profile is always better than an exception at boot.
      return data;
    }

    let migrated = false;
    try {
      migrated = data.apply(raw);
    } catch {
      return new SaveData(data.key);
    }
    // An older document that was migrated forward stays dirty, so the next
    // flush() rewrites it in the current schema instead of re-migrating on
    // every launch.
    data._dirty = migrated;
    return data;
  }

  /**
   * Overwrite this profile from a decoded JSON document.
   *
   * Every field is coerced and clamped; keys that are not part of the schema
   * are ignored entirely. Safe to call with literally any value.
   *
   * @returns true when the document came from an older schema and had to be
   *          migrated forward (so it is worth rewriting to storage).
   */
  apply(raw: unknown): boolean {
    if (!isRecord(raw)) return false;
    const version = clampInt(asInt(raw["schema"], 0), 0, 9_999);
    try {
      this.highscore = clampInt(asInt(raw["highscore"], 0), 0, MAX_SCORE);
      this.unlocked = clampInt(asInt(raw["unlocked"], 1), 1, LEVEL_COUNT);
      this.best = asIntTable(raw["best"], 0, MAX_SCORE);
      this.stars = asIntTable(raw["stars"], 0, MAX_STARS);
      this.muted = asBool(raw["muted"], false);
      this.totalFood = clampInt(asInt(pick(raw, "totalFood", "total_food"), 0), 0, MAX_COUNTER);
      this.totalDeaths = clampInt(
        asInt(pick(raw, "totalDeaths", "total_deaths"), 0),
        0,
        MAX_COUNTER,
      );

      this.displayMode = asChoice(
        pick(raw, "displayMode", "display_mode"),
        DISPLAY_MODES,
        DEFAULT_DISPLAY_MODE,
      );
      this.difficulty = asChoice(raw["difficulty"], DIFFICULTIES, DEFAULT_DIFFICULTY);
      this.mode = asChoice(raw["mode"], GAME_MODES, DEFAULT_MODE);

      this.storyProgress = clampInt(
        asInt(pick(raw, "storyProgress", "story_progress"), 0),
        0,
        LEVEL_COUNT - 1,
      );
      this.storyComplete = asBool(pick(raw, "storyComplete", "story_complete"), false);
      this.seenBeats = asIntList(pick(raw, "seenBeats", "seen_beats"), 0, MAX_BEAT_KEY);

      this.bestByDifficulty = asDifficultyTable(
        pick(raw, "bestByDifficulty", "best_by_difficulty"),
        0,
        MAX_SCORE,
      );
      this.starsByDifficulty = asDifficultyTable(
        pick(raw, "starsByDifficulty", "stars_by_difficulty"),
        0,
        MAX_STARS,
      );
    } catch {
      return false;
    }

    const migrated = version < SCHEMA_VERSION;

    // Migration: a schema 1 document predates per-difficulty records, so its
    // flat tables are adopted as the default difficulty's history rather than
    // being thrown away. Only ever fills gaps - a partially upgraded document
    // keeps whatever it already recorded.
    if (migrated) this.seedDifficultyTables(DEFAULT_DIFFICULTY);

    // Cross-field repair: a stored high score can never be lower than the best
    // single-level score, and a level with a recorded score must be unlocked.
    // Hand-edited documents routinely break both invariants.
    for (const [key, value] of this.allBestEntries()) {
      if (value > this.highscore) this.highscore = value;
      const idx = asInt(key, 0);
      if (idx + 1 > this.unlocked) this.unlocked = clampInt(idx + 1, 1, LEVEL_COUNT);
    }
    this._dirty = true;
    return migrated;
  }

  /** Every `[levelKey, score]` pair from the flat and per-difficulty tables. */
  private allBestEntries(): Array<[string, number]> {
    const out: Array<[string, number]> = Object.entries(this.best);
    for (const table of Object.values(this.bestByDifficulty)) {
      out.push(...Object.entries(table));
    }
    return out;
  }

  /** Copy the flat legacy tables into one difficulty, without overwriting. */
  private seedDifficultyTables(difficulty: string): void {
    const bestTable = (this.bestByDifficulty[difficulty] ??= {});
    for (const [key, value] of Object.entries(this.best)) {
      if (value > (bestTable[key] ?? -1)) bestTable[key] = value;
    }
    const starTable = (this.starsByDifficulty[difficulty] ??= {});
    for (const [key, value] of Object.entries(this.stars)) {
      if (value > (starTable[key] ?? -1)) starTable[key] = value;
    }
  }

  // ------------------------------------------------------------------
  // Serialising
  // ------------------------------------------------------------------

  /** The exact document that gets written to storage (no `key` inside). */
  toDict(): SaveDocument {
    return {
      schema: SCHEMA_VERSION,
      highscore: Math.trunc(this.highscore),
      unlocked: Math.trunc(this.unlocked),
      best: sortedLevelTable(asIntTable(this.best, 0, MAX_SCORE)),
      stars: sortedLevelTable(asIntTable(this.stars, 0, MAX_STARS)),
      muted: Boolean(this.muted),
      totalFood: Math.trunc(this.totalFood),
      totalDeaths: Math.trunc(this.totalDeaths),
      displayMode: asChoice(this.displayMode, DISPLAY_MODES, DEFAULT_DISPLAY_MODE),
      difficulty: asChoice(this.difficulty, DIFFICULTIES, DEFAULT_DIFFICULTY),
      mode: asChoice(this.mode, GAME_MODES, DEFAULT_MODE),
      storyProgress: clampInt(asInt(this.storyProgress, 0), 0, LEVEL_COUNT - 1),
      storyComplete: Boolean(this.storyComplete),
      seenBeats: asIntList(this.seenBeats, 0, MAX_BEAT_KEY),
      bestByDifficulty: dumpDifficultyTable(this.bestByDifficulty, 0, MAX_SCORE),
      starsByDifficulty: dumpDifficultyTable(this.starsByDifficulty, 0, MAX_STARS),
    };
  }

  /**
   * Write the profile to `localStorage`. Returns true when it really landed in
   * persistent storage, false when it only made it into this session's memory
   * (quota exceeded, private browsing, storage disabled). Never throws.
   */
  save(): boolean {
    let payload: string;
    try {
      payload = JSON.stringify(this.toDict());
    } catch {
      return false;
    }
    const ok = writeRaw(this.key, payload);
    // The document is consistent either way, so a memory-only write still
    // clears the dirty flag; retrying would only fail identically.
    this._dirty = false;
    return ok;
  }

  /** Save only if something changed since the last write. */
  flush(): boolean {
    if (!this._dirty) return true;
    return this.save();
  }

  /** True when there are unsaved changes. */
  get dirty(): boolean {
    return this._dirty;
  }

  // ------------------------------------------------------------------
  // Progress queries
  // ------------------------------------------------------------------

  /**
   * Best score recorded on a level, 0 if it has never been finished.
   *
   * With no `difficulty` this is the difficulty-agnostic best. Pass a
   * difficulty name to ask about that difficulty alone; an unknown name reads
   * as "never played".
   */
  bestFor(levelIndex: number, difficulty: string | null = null): number {
    const key = levelKey(levelIndex);
    if (key === null) return 0;
    const table = tableFor(this.best, this.bestByDifficulty, difficulty);
    if (table === null) return 0;
    return Math.trunc(table[key] ?? 0);
  }

  /**
   * Best star rating (0..{@link MAX_STARS}) earned on a level.
   *
   * `difficulty` behaves exactly as in {@link bestFor}.
   */
  starsFor(levelIndex: number, difficulty: string | null = null): number {
    const key = levelKey(levelIndex);
    if (key === null) return 0;
    const table = tableFor(this.stars, this.starsByDifficulty, difficulty);
    if (table === null) return 0;
    return Math.trunc(table[key] ?? 0);
  }

  /**
   * Sum of every level's best star rating.
   *
   * With no `difficulty` this counts the difficulty-agnostic bests, which is
   * what the menus have always shown.
   */
  totalStars(difficulty: string | null = null): number {
    if (difficulty === null || difficulty === undefined) {
      let sum = 0;
      for (const v of Object.values(this.stars)) sum += Math.trunc(v);
      return sum;
    }
    const name = difficultyKey(difficulty);
    if (name === null) return 0;
    let sum = 0;
    for (const v of Object.values(this.starsByDifficulty[name] ?? {})) sum += Math.trunc(v);
    return sum;
  }

  /** How many stars exist in the whole game. */
  maxStars(): number {
    return LEVEL_COUNT * MAX_STARS;
  }

  /** True when the player may select this zero-based level index. */
  isUnlocked(levelIndex: number): boolean {
    const idx = asInt(levelIndex, -1);
    return idx >= 0 && idx < this.unlocked;
  }

  /** True when a score has ever been recorded for this level. */
  completed(levelIndex: number): boolean {
    const key = levelKey(levelIndex);
    return key !== null && Object.prototype.hasOwnProperty.call(this.best, key);
  }

  /** Sorted indices of every level with a recorded score. */
  clearedLevels(): number[] {
    const out: number[] = [];
    for (const key of Object.keys(this.best)) {
      const idx = asInt(key, -1);
      if (idx >= 0) out.push(idx);
    }
    out.sort((a, b) => a - b);
    return out;
  }

  /** `[levels cleared, total levels]` - handy for a menu completion bar. */
  progress(): [number, number] {
    return [Object.keys(this.best).length, LEVEL_COUNT];
  }

  // ------------------------------------------------------------------
  // Progress mutation
  // ------------------------------------------------------------------

  /**
   * Make every level up to *and including* `levelIndex` selectable.
   *
   * @returns true when this actually unlocked something new.
   */
  unlockThrough(levelIndex: number): boolean {
    const idx = asInt(levelIndex, -1);
    if (idx < 0) return false;
    const target = clampInt(idx + 1, 1, LEVEL_COUNT);
    if (target <= this.unlocked) return false;
    this.unlocked = target;
    this._dirty = true;
    return true;
  }

  /**
   * Store the outcome of a finished level.
   *
   * @returns true when `score` beats the stored best for that level on the
   *          flat, difficulty-agnostic table (a first-ever result always counts
   *          as a personal best).
   *
   * Stars only ever go up: a sloppy replay cannot take away a three-star
   * rating. The global high score and the unlock frontier are updated as a side
   * effect, so callers only need this one call after a win.
   *
   * The result is also filed under a difficulty - `difficulty` when given,
   * otherwise the profile's currently selected {@link SaveData.difficulty} - so
   * that a three-star easy clear never overwrites a two-star expert clear.
   */
  record(
    levelIndex: number,
    score: number,
    stars: number,
    difficulty: string | null = null,
  ): boolean {
    const key = levelKey(levelIndex);
    const scoreI = clampInt(asInt(score, 0), 0, MAX_SCORE);
    const starsI = clampInt(asInt(stars, 0), 0, MAX_STARS);

    if (scoreI > this.highscore) {
      this.highscore = scoreI;
      this._dirty = true;
    }

    if (key === null) return false;

    const previous = this.best[key];
    const improved = previous === undefined || scoreI > previous;
    if (improved) {
      this.best[key] = scoreI;
      this._dirty = true;
    }

    if (starsI > (this.stars[key] ?? 0)) {
      this.stars[key] = starsI;
      this._dirty = true;
    }

    // Per-difficulty history, independent of the flat tables above.
    const name = difficultyKey(difficulty, difficultyKey(this.difficulty, DEFAULT_DIFFICULTY));
    if (name !== null) {
      const bestTable = (this.bestByDifficulty[name] ??= {});
      if (scoreI > (bestTable[key] ?? -1)) {
        bestTable[key] = scoreI;
        this._dirty = true;
      }
      const starTable = (this.starsByDifficulty[name] ??= {});
      if (starsI > (starTable[key] ?? 0)) {
        starTable[key] = starsI;
        this._dirty = true;
      }
    }

    // Finishing a level opens the next one.
    this.unlockThrough(asInt(levelIndex, 0) + 1);
    return improved;
  }

  /** Bump the lifetime food counter. */
  addFood(count = 1): void {
    const n = asInt(count, 0);
    if (n <= 0) return;
    this.totalFood = clampInt(this.totalFood + n, 0, MAX_COUNTER);
    this._dirty = true;
  }

  /** Bump the lifetime death counter. */
  addDeath(count = 1): void {
    const n = asInt(count, 0);
    if (n <= 0) return;
    this.totalDeaths = clampInt(this.totalDeaths + n, 0, MAX_COUNTER);
    this._dirty = true;
  }

  /** Persist the audio mute preference. */
  setMuted(value: boolean): void {
    const flag = asBool(value, false);
    if (flag !== this.muted) {
      this.muted = flag;
      this._dirty = true;
    }
  }

  // ------------------------------------------------------------------
  // Settings (schema 2)
  // ------------------------------------------------------------------

  /** Persist the windowed / borderless / fullscreen preference. */
  setDisplayMode(value: string): void {
    const chosen = asChoice(value, DISPLAY_MODES, this.displayMode);
    if (chosen !== this.displayMode) {
      this.displayMode = chosen;
      this._dirty = true;
    }
  }

  /** Persist the selected difficulty; an unknown name is ignored. */
  setDifficulty(value: string): void {
    const chosen = asChoice(value, DIFFICULTIES, this.difficulty);
    if (chosen !== this.difficulty) {
      this.difficulty = chosen;
      this._dirty = true;
    }
  }

  /** Persist the selected game mode (story or free play). */
  setMode(value: string): void {
    const chosen = asChoice(value, GAME_MODES, this.mode);
    if (chosen !== this.mode) {
      this.mode = chosen;
      this._dirty = true;
    }
  }

  // ------------------------------------------------------------------
  // Story mode (schema 2)
  // ------------------------------------------------------------------

  /**
   * Remember how far the story has got, as a zero-based level index.
   *
   * Progress only ever moves forward, so replaying chapter one does not rewind
   * the campaign. Finishing the final level is a separate thing - call
   * {@link setStoryComplete} for that.
   *
   * @returns true when the stored progress actually advanced.
   */
  setStoryProgress(levelIndex: number): boolean {
    const idx = clampInt(asInt(levelIndex, -1), -1, LEVEL_COUNT - 1);
    if (idx < 0) return false;
    if (idx <= this.storyProgress) return false;
    this.storyProgress = idx;
    this._dirty = true;
    return true;
  }

  /** Flag the campaign as finished (or un-finish it, for a fresh run). */
  setStoryComplete(value: boolean = true): void {
    const flag = asBool(value, false);
    if (flag !== this.storyComplete) {
      this.storyComplete = flag;
      this._dirty = true;
    }
  }

  /** True when this narrative beat has already been shown to the player. */
  beatSeen(beatIndex: number): boolean {
    const idx = asInt(beatIndex, -1);
    return idx >= 0 && this.seenBeats.includes(idx);
  }

  /**
   * Remember that a narrative beat has been shown, so a replay can skip it.
   *
   * @returns true the first time a given beat is marked, false afterwards.
   */
  markBeatSeen(beatIndex: number): boolean {
    const idx = asInt(beatIndex, -1);
    if (idx < 0 || idx > MAX_BEAT_KEY || this.seenBeats.includes(idx)) return false;
    this.seenBeats.push(idx);
    this.seenBeats.sort((a, b) => a - b);
    this._dirty = true;
    return true;
  }

  /**
   * Wipe all progress, keeping the storage key and the mute preference.
   *
   * Everything schema 2 added is cleared as well: the story is un-played, no
   * beats have been seen, the per-difficulty tables are emptied and the
   * display / difficulty / mode selections go back to their defaults.
   */
  reset(): void {
    this.highscore = 0;
    this.unlocked = 1;
    this.best = {};
    this.stars = {};
    this.totalFood = 0;
    this.totalDeaths = 0;
    this.displayMode = DEFAULT_DISPLAY_MODE;
    this.difficulty = DEFAULT_DIFFICULTY;
    this.mode = DEFAULT_MODE;
    this.storyProgress = 0;
    this.storyComplete = false;
    this.seenBeats = [];
    this.bestByDifficulty = emptyDifficultyTable();
    this.starsByDifficulty = emptyDifficultyTable();
    this._dirty = true;
  }
}

/**
 * Read a field under its camelCase name, falling back to the Python
 * snake_case spelling so a document written by the desktop build still loads.
 */
function pick(raw: Record<string, unknown>, camel: string, snake: string): unknown {
  const v = raw[camel];
  return v === undefined ? raw[snake] : v;
}

/**
 * Pick the level table to read.
 *
 * null `difficulty` means "the flat, difficulty-agnostic table"; a valid
 * difficulty name means that difficulty's table; anything else means there is
 * no such table and the caller should report a zero.
 */
function tableFor(
  flat: LevelTable,
  byDifficulty: DifficultyTable,
  difficulty: string | null,
): LevelTable | null {
  if (difficulty === null || difficulty === undefined) return flat;
  const name = difficultyKey(difficulty);
  if (name === null) return null;
  return byDifficulty[name] ?? {};
}
