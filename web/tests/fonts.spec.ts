/**
 * Contract tests for the font ladder.
 *
 * These cover what can be checked without a DOM: the ladder's sizes, families
 * and weights, and the identity stability the downstream caches depend on.
 * How the glyphs actually look is a perceptual question, answered by comparing
 * a capture against `captures/*.png` - a unit test cannot tell you a headline
 * is too heavy.
 *
 * The weights are the interesting assertions. Two of them encode pygame quirks
 * that the reference captures were rendered with (docs/port/ui.md S0.2.1), and
 * a well-meaning "fix" to either is exactly the kind of change that would sail
 * through review.
 */

import { describe, expect, it } from "vitest";

import {
  DISPLAY_STACK,
  FontBook,
  MONO_STACK,
  UI_STACK,
  cssFont,
} from "../src/gfx/fonts";

describe("FontBook: the named ladder", () => {
  it("matches fonts.py:63-71 in size, family and weight", () => {
    const f = new FontBook();
    const row = (o: { fontSize?: unknown; fontFamily?: unknown; fontWeight?: unknown }) => ({
      size: o.fontSize,
      family: o.fontFamily,
      weight: o.fontWeight,
    });

    expect(row(f.huge)).toEqual({ size: 96, family: DISPLAY_STACK, weight: "700" });
    expect(row(f.title)).toEqual({ size: 64, family: DISPLAY_STACK, weight: "700" });
    expect(row(f.h1)).toEqual({ size: 42, family: DISPLAY_STACK, weight: "700" });
    expect(row(f.h2)).toEqual({ size: 30, family: UI_STACK, weight: "700" });
    expect(row(f.body)).toEqual({ size: 21, family: UI_STACK, weight: "300" });
    expect(row(f.small)).toEqual({ size: 17, family: UI_STACK, weight: "300" });
    expect(row(f.tiny)).toEqual({ size: 14, family: UI_STACK, weight: "300" });
    expect(row(f.mono)).toEqual({ size: 16, family: MONO_STACK, weight: "400" });
    expect(row(f.monoSmall)).toEqual({ size: 13, family: MONO_STACK, weight: "400" });
  });

  it("puts h2 on the UI face, not the display face", () => {
    // The one bold entry in the UI column, and the reason displayAt(30) and
    // h2 are different objects even though both are "30, bold".
    const f = new FontBook();
    expect(f.h2.fontFamily).toBe(UI_STACK);
    expect(f.h2).not.toBe(f.displayAt(30));
  });

  it("renders non-bold UI text at weight 300, not 400", () => {
    // pygame's family normaliser strips "Light", so SysFont("segoeui", n)
    // resolves to segoeuil.ttf and every non-bold UI string in every reference
    // capture is Segoe UI Light. Raising this to 400 silently widens every HUD
    // caption by ~4%.
    const f = new FontBook();
    for (const opts of [f.body, f.small, f.tiny, f.get(19), f.get(28)]) {
      expect(opts.fontWeight).toBe("300");
    }
    expect(f.get(19, true).fontWeight).toBe("700");
  });

  it("always makes the display face bold, whatever it is asked", () => {
    // display_at() passes bold=True unconditionally (fonts.py:102-104); there
    // is no non-bold display face anywhere in the game.
    const f = new FontBook();
    for (const size of [26, 34, 42, 64, 96]) {
      expect(f.displayAt(size).fontWeight).toBe("700");
    }
  });

  it("never puts system-ui at the front of a stack", () => {
    // On Windows system-ui is Segoe UI *Regular*, which would overwrite both
    // the display face and the Light weight the captures were made with.
    for (const stack of [DISPLAY_STACK, UI_STACK, MONO_STACK]) {
      expect(stack.startsWith("system-ui")).toBe(false);
    }
    expect(DISPLAY_STACK.split(",")[0]!.trim()).toBe("Bahnschrift");
    expect(UI_STACK.split(",")[0]!.trim()).toBe('"Segoe UI"');
    expect(MONO_STACK.split(",")[0]!.trim()).toBe("Consolas");
  });

  it("ends every stack in a generic that always exists", () => {
    expect(DISPLAY_STACK.endsWith("sans-serif")).toBe(true);
    expect(UI_STACK.endsWith("sans-serif")).toBe(true);
    expect(MONO_STACK.endsWith("monospace")).toBe(true);
  });
});

describe("FontBook: the cache", () => {
  it("returns the identical object for the same request", () => {
    // Python keys several caches on id(font); their ports key on this object.
    // A fresh literal per call turns every one of them into a per-frame miss.
    const f = new FontBook();
    expect(f.get(17)).toBe(f.small);
    expect(f.get(21)).toBe(f.body);
    expect(f.displayAt(96)).toBe(f.huge);
    expect(f.get(33, true)).toBe(f.get(33, true));
    expect(f.monoAt(16)).toBe(f.mono);
  });

  it("keys on role, size and bold independently", () => {
    const f = new FontBook();
    expect(f.get(30, true)).not.toBe(f.get(30, false));
    expect(f.get(30, true)).not.toBe(f.monoAt(30, true));
    expect(f.displayAt(30)).not.toBe(f.get(30, true));

    const before = f.size;
    f.get(30, true);
    f.get(30, true);
    expect(f.size).toBe(before);
  });

  it("starts with exactly the nine ladder entries", () => {
    // huge/title/h1 (display), h2/body/small/tiny (ui), mono/monoSmall (mono).
    expect(new FontBook().size).toBe(9);
  });

  it("rounds and floors requested sizes so the cache cannot be flooded", () => {
    const f = new FontBook();
    expect(f.get(17.4)).toBe(f.get(17));
    expect(f.get(0).fontSize).toBe(1);
    expect(f.get(-5).fontSize).toBe(1);
  });

  it("freezes what it hands out", () => {
    const f = new FontBook();
    expect(Object.isFrozen(f.small)).toBe(true);
  });
});

describe("FontBook: derived values", () => {
  it("builds a CSS font shorthand a 2D context accepts", () => {
    const f = new FontBook();
    expect(cssFont(f.small)).toBe(`300 17px ${UI_STACK}`);
    expect(cssFont(f.huge)).toBe(`700 96px ${DISPLAY_STACK}`);
  });

  it("clamps the raster resolution to 1..3", () => {
    const f = new FontBook();
    f.setResolution(0.4);
    expect(f.resolution).toBe(1);
    f.setResolution(2.5);
    expect(f.resolution).toBe(2.5);
    f.setResolution(9);
    expect(f.resolution).toBe(3);
    f.setResolution(Number.NaN);
    expect(f.resolution).toBe(1);
  });

  it("gives the display face a line height equal to its px size", () => {
    // Bahnschrift's box is exactly the requested size (96 -> 96); Segoe UI
    // Light's is ~1.35x it (17 -> 23). Layouts that centre vertically by height
    // move if this is wrong.
    const f = new FontBook();
    expect(f.lineHeight(f.huge)).toBe(96);
    expect(f.lineHeight(f.small)).toBe(23);
    expect(f.lineHeight(f.body)).toBe(28);
  });

  it("picks the largest font that fits, and the smallest when none does", () => {
    const f = new FontBook();
    const ladder = [f.title, f.h1, f.h2];
    // Stub the measurer: real measurement needs a DOM, and what is under test
    // here is the walk, not the metrics.
    const widths = new Map([
      [f.title, 400],
      [f.h1, 260],
      [f.h2, 190],
    ]);
    f.measureWidth = (opts) => widths.get(opts) ?? 0;

    expect(f.fit(ladder, "x", 500)).toBe(f.title);
    expect(f.fit(ladder, "x", 300)).toBe(f.h1);
    expect(f.fit(ladder, "x", 200)).toBe(f.h2);
    // Fits nothing: draw at the smallest rather than not at all.
    expect(f.fit(ladder, "x", 10)).toBe(f.h2);
  });
});

describe("FontBook: headless behaviour", () => {
  it("explains itself when asked to measure without a DOM", () => {
    const f = new FontBook();
    expect(() => f.measureWidth(f.small, "SCORE")).toThrow(/needs a DOM/);
  });

  it("measures the empty string without touching the DOM", () => {
    const f = new FontBook();
    expect(f.measureWidth(f.small, "")).toBe(0);
    expect(f.measure(f.small, "")).toEqual({ w: 0, h: 23 });
  });
});
