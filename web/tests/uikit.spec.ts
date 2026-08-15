/**
 * Contract tests for the shared scene helpers.
 *
 * Both of these exist because the Python has several near-copies of each, and
 * the port collapses them. A collapse that quietly changes behaviour is the
 * risk, so the differences the copies actually had - the line cap and the
 * ellipsis - are pinned down here.
 */

import { describe, expect, it } from "vitest";
import type { TextStyleOptions } from "pixi.js";

import type { FontBook } from "../src/gfx/fonts";
import { THEMES, UI_DIM, lerpColor, shade } from "../src/core/palette";
import { formatFixed } from "../src/core/mathx";
import { mute, muteTheme } from "../src/ui/muteTheme";
import { clearWrapCache, wrapCacheSize, wrapText } from "../src/ui/wrap";

/**
 * A FontBook stand-in that measures one "px" per character, so the wrap points
 * are arithmetic rather than dependent on a real font.
 */
const fakeFonts = {
  measureWidth: (_style: unknown, text: string) => text.length,
} as unknown as FontBook;

const style: TextStyleOptions = { fontFamily: "test", fontSize: 10, fontWeight: "400" };

describe("wrapText", () => {
  it("wraps greedily at the width", () => {
    clearWrapCache();
    const out = wrapText(fakeFonts, style, "aaa bbb ccc ddd", 7, { maxLines: 9 });
    expect(out).toEqual(["aaa bbb", "ccc ddd"]);
  });

  it("never breaks a word that is longer than the width", () => {
    clearWrapCache();
    const out = wrapText(fakeFonts, style, "supercalifragilistic", 5, { maxLines: 9 });
    expect(out).toEqual(["supercalifragilistic"]);
  });

  it("caps at maxLines and drops the rest", () => {
    clearWrapCache();
    const out = wrapText(fakeFonts, style, "aaa bbb ccc ddd eee fff", 7, { maxLines: 2 });
    expect(out).toEqual(["aaa bbb", "ccc ddd"]);
  });

  it("ellipsises the last line only when words were actually dropped", () => {
    clearWrapCache();
    const cut = wrapText(fakeFonts, style, "aaa bbb ccc ddd eee", 7, {
      maxLines: 2,
      ellipsis: true,
    });
    expect(cut).toEqual(["aaa bbb", "ccc ddd..."]);

    const whole = wrapText(fakeFonts, style, "aaa bbb", 7, { maxLines: 2, ellipsis: true });
    expect(whole).toEqual(["aaa bbb"]);
  });

  it("strips trailing punctuation before the ellipsis", () => {
    clearWrapCache();
    const out = wrapText(fakeFonts, style, "aaa bbb, ccc ddd", 8, {
      maxLines: 1,
      ellipsis: true,
    });
    expect(out).toEqual(["aaa bbb..."]);
  });

  it("collapses runs of whitespace and survives an empty string", () => {
    clearWrapCache();
    expect(wrapText(fakeFonts, style, "  aaa   bbb  ", 7, { maxLines: 9 })).toEqual(["aaa bbb"]);
    expect(wrapText(fakeFonts, style, "", 7)).toEqual([]);
    expect(wrapText(fakeFonts, style, "   ", 7)).toEqual([]);
  });

  it("caches on text, geometry and style together", () => {
    clearWrapCache();
    const a = wrapText(fakeFonts, style, "aaa bbb", 7, { maxLines: 2 });
    const b = wrapText(fakeFonts, style, "aaa bbb", 7, { maxLines: 2 });
    expect(b).toBe(a);
    expect(wrapCacheSize()).toBe(1);

    // A different cap is a different answer and must not be served the cache.
    wrapText(fakeFonts, style, "aaa bbb", 7, { maxLines: 1 });
    expect(wrapCacheSize()).toBe(2);
  });
});

describe("muteTheme", () => {
  it("drains a colour toward its luminance and darkens it", () => {
    // Pure red: luminance 76, so a 0.62 drain lands most of the way there.
    const out = mute([255, 0, 0]);
    const lum = Math.trunc(0.299 * 255);
    expect(out).toEqual(shade(lerpColor([255, 0, 0], [lum, lum, lum], 0.62), 0.7));
  });

  it("leaves a grey unchanged apart from the darkening", () => {
    const out = mute([100, 100, 100], 0.62, 0.7);
    expect(out).toEqual([70, 70, 70]);
  });

  it("mutes every theme field and keeps the hex mirror in step", () => {
    // A stale mirror is a silent bug: the renderer tints from theme.hex, so it
    // would desaturate the text and leave the graphics at full colour.
    for (const theme of THEMES) {
      const m = muteTheme(theme);
      expect(m.hex.accent).toBe((m.accent[0] << 16) | (m.accent[1] << 8) | m.accent[2]);
      expect(m.hex.bgTop).toBe((m.bgTop[0] << 16) | (m.bgTop[1] << 8) | m.bgTop[2]);
      expect(m.hex.text).toBe((m.text[0] << 16) | (m.text[1] << 8) | m.text[2]);
    }
  });

  it("blends text toward UI_DIM rather than muting it", () => {
    // Draining near-white text through the luminance path would turn it grey
    // and make the panel copy unreadable.
    const theme = THEMES[0]!;
    expect(muteTheme(theme).text).toEqual(lerpColor(theme.text, UI_DIM, 0.35));
  });

  it("mutes hazards least, so what killed you stays legible", () => {
    const theme = THEMES[0]!;
    const m = muteTheme(theme);
    const drop = (a: readonly number[], b: readonly number[]) =>
      Math.abs(a[0]! - b[0]!) + Math.abs(a[1]! - b[1]!) + Math.abs(a[2]! - b[2]!);
    expect(drop(theme.hazard, m.hazard)).toBeLessThan(drop(theme.bgTop, m.bgTop) + 400);
  });

  it("keeps the name and background style", () => {
    const theme = THEMES[3]!;
    const m = muteTheme(theme);
    expect(m.name).toBe(theme.name);
    expect(m.bgStyle).toBe(theme.bgStyle);
  });
});

describe("formatFixed", () => {
  it("rounds a tie to even, as Python's :.Nf does", () => {
    // The power-up table stores `slow` at 6.5 s. Python prints "6"; toFixed
    // prints "7", and the help screen showed exactly that discrepancy.
    expect(formatFixed(6.5, 0)).toBe("6");
    expect(formatFixed(7.5, 0)).toBe("8");
    expect(formatFixed(0.5, 0)).toBe("0");
    expect(formatFixed(1.5, 0)).toBe("2");
    expect(formatFixed(-0.5, 0)).toBe("-0");
  });

  it("agrees with toFixed everywhere else", () => {
    for (const v of [0, 1, 6.4, 6.6, 12, 8.0, 10.25, 99.999]) {
      expect(formatFixed(v, 0)).toBe(v.toFixed(0));
    }
  });

  it("handles more decimals and non-finite input", () => {
    expect(formatFixed(1.25, 1)).toBe("1.2");
    expect(formatFixed(1.35, 1)).toBe("1.4");
    expect(formatFixed(Number.NaN, 0)).toBe("NaN");
  });
});
