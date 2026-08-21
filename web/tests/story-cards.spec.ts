/**
 * The story presenter's card normaliser - `scenes/story/cards.ts`, the port
 * of `_normalise_card(s)` / `_split_marker` / `_to_roman`
 * (`snake/scenes/story_scene.py:128-322`).
 *
 * The single highest-risk case is the Chapter duck-type: TS's
 * `Chapter.roman` is a *method* where Python's is a property, and a literal
 * transcription silently demotes every chapter plate to an ordinary card -
 * no numeral, no long rule (scenes.md §10.3.4). That regression throws
 * nothing, so it lives or dies by these tests.
 */

import { describe, expect, it } from "vitest";

import { EPILOGUE, getBeat, getChapter, PROLOGUE } from "../src/core/story";
import {
  isChapterCard,
  normaliseCard,
  normaliseCards,
  splitMarker,
  toRoman,
} from "../src/scenes/story/cards";

describe("toRoman", () => {
  it("covers the campaign's numerals and clamps garbage", () => {
    expect(toRoman(1)).toBe("I");
    expect(toRoman(2)).toBe("II");
    expect(toRoman(4)).toBe("IV");
    expect(toRoman(12)).toBe("XII");
    expect(toRoman(0)).toBe("I"); // clamped up
    expect(toRoman(Number.NaN)).toBe("I");
  });
});

describe("splitMarker", () => {
  it("understands every documented marker form", () => {
    expect(splitMarker("Chapter II - Cold Boot")).toEqual(["II", "Cold Boot"]);
    expect(splitMarker("CHAPTER 2: Name")).toEqual(["II", "Name"]);
    expect(splitMarker("Act III")).toEqual(["III", ""]);
    expect(splitMarker("II. Cold Boot")).toEqual(["II", "Cold Boot"]);
    expect(splitMarker("IV")).toEqual(["IV", ""]);
  });

  it("does not eat titles that merely start with roman letters", () => {
    expect(splitMarker("I am here")).toEqual(["", "I am here"]);
    expect(splitMarker("Mill Road")).toEqual(["", "Mill Road"]);
  });

  it("keeps the Python's known false positive, verbatim", () => {
    // A "fix" would change which cards become plates - ported as shipped.
    expect(splitMarker("Mill. Road")).toEqual(["MILL", "Road"]);
  });

  it("strips separators off the FRONT of the remainder only", () => {
    // Python is rest.strip().lstrip(_SEPARATORS).strip(), so trailing
    // punctuation survives; stripping both ends ate it.
    expect(splitMarker("II. R.U.R.")).toEqual(["II", "R.U.R."]);
    expect(splitMarker("Chapter V - The End...")).toEqual(["V", "The End..."]);
  });
});

describe("normaliseCard", () => {
  it("promotes a real TS Chapter to a plate via its roman() method", () => {
    const chapter = getChapter(3); // chapter II
    const card = normaliseCard(chapter)!;
    expect(card).not.toBeNull();
    expect(card.roman).toBe("II");
    expect(isChapterCard(card)).toBe(true);
    expect(card.title).toBe(chapter.title);
    expect(card.lines).toEqual([...chapter.blurb]);
  });

  it("renders a StoryBeat's intro, never its outro, and never as a plate", () => {
    const beat = getBeat(3);
    const card = normaliseCard(beat)!;
    expect(card.lines).toEqual([...beat.intro]);
    expect(card.speaker).toBe(beat.speaker);
    expect(isChapterCard(card)).toBe(false);
  });

  it("accepts the prologue and epilogue StoryCards as ordinary cards", () => {
    for (const source of [PROLOGUE, EPILOGUE]) {
      const card = normaliseCard(source)!;
      expect(card.title).toBe(source.title);
      expect(card.lines).toEqual([...source.lines]);
      expect(isChapterCard(card)).toBe(false);
    }
  });

  it("accepts dicts, pairs and bare strings", () => {
    expect(normaliseCard({ title: "T", lines: ["a", "b"], speaker: "v" })).toEqual({
      title: "T",
      lines: ["a", "b"],
      speaker: "v",
      roman: "",
    });
    expect(normaliseCard(["T", ["a"]])).toMatchObject({ title: "T", lines: ["a"] });
    expect(normaliseCard("just a line")).toMatchObject({ lines: ["just a line"] });
    // A lone line carrying a marker is a plate, not prose.
    expect(normaliseCard("Chapter II - Cold Boot")).toMatchObject({
      title: "Cold Boot",
      roman: "II",
    });
  });

  it("skips an empty early alias like Python's falsy-sequence test", () => {
    // `[]` is truthy in JS but falsy in Python, so `if value:` there falls
    // through to the next name. Taking the empty array dropped the card.
    expect(normaliseCard({ lines: [], text: "The board is listening." })!.lines).toEqual([
      "The board is listening.",
    ]);
    // A beat-shaped object with no intro must fall through to its outro.
    expect(normaliseCard({ title: "T", intro: [], outro: ["after"] })!.lines).toEqual([
      "after",
    ]);
    // A blank string alias is skipped the same way.
    expect(normaliseCard({ title: "   ", name: "Real" })!.title).toBe("Real");
  });

  it("returns null for anything holding no text", () => {
    expect(normaliseCard(null)).toBeNull();
    expect(normaliseCard("")).toBeNull();
    expect(normaliseCard({ title: "", lines: [] })).toBeNull();
    expect(normaliseCard([])).toBeNull();
  });

  it("caps a card at 8 lines", () => {
    const lines = Array.from({ length: 12 }, (_, i) => `line ${i}`);
    expect(normaliseCard({ lines })!.lines).toHaveLength(8);
  });
});

describe("normaliseCards", () => {
  it("builds the exact deck the victory hand-off produces", () => {
    const beat = getBeat(3);
    const deck = normaliseCards([
      { title: beat.title, lines: [...beat.outro], speaker: beat.speaker },
      getChapter(4),
      { title: getBeat(4).title, lines: [...getBeat(4).intro], speaker: getBeat(4).speaker },
    ]);
    expect(deck).toHaveLength(3);
    expect(isChapterCard(deck[0]!)).toBe(false);
    expect(deck[0]!.lines).toEqual([...beat.outro]);
    expect(isChapterCard(deck[1]!)).toBe(true);
    expect(isChapterCard(deck[2]!)).toBe(false);
  });

  it("drops unusable entries and caps the deck at 24", () => {
    const deck = normaliseCards([null, "", "ok", ...Array(40).fill("pad")]);
    expect(deck.length).toBeLessThanOrEqual(24);
    expect(deck[0]!.lines).toEqual(["ok"]);
  });

  it("degrades garbage to an empty deck", () => {
    expect(normaliseCards(null)).toEqual([]);
    expect(normaliseCards(undefined)).toEqual([]);
  });
});
