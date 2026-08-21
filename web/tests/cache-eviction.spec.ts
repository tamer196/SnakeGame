/**
 * The three shared texture caches must not destroy a texture a live display
 * object is still pointing at.
 *
 * All three (`ui/text.ts` glyphs, `ui/Button.ts` bodies, `ui/bar.ts` fills)
 * are FIFO-bounded, and all three used to call `destroy(true)` on the evicted
 * entry. That is safe only if every holder re-fetches afterwards, and none of
 * them do: `Label.set` early-returns when the string is unchanged, and
 * `Button.draw` / `Bar.set` skip the lookup while their cache key is unchanged.
 * So the *oldest* entries - which are exactly the static labels and parked
 * buttons of cached, reused scenes - would end up as sprites drawing a
 * destroyed texture, permanently, once enough distinct entries had been minted
 * (the result screens' count-ups mint ~150 glyph entries per visit).
 *
 * Eviction is non-destructive now: dropping the map entry is enough, because
 * Pixi v8's `TextureGCSystem` (on by default, 60 s idle) reclaims the GPU
 * resource of a texture nothing draws any more. These tests pin that down -
 * they fail loudly against a `destroy`-on-evict implementation.
 */

import { describe, expect, it, beforeEach } from "vitest";
import type { TextStyleOptions } from "pixi.js";

// `gfx/textures.ts::createCanvas` prefers a DOM canvas and falls back to
// OffscreenCanvas; the node environment has neither. The glyph path only
// rasterises text, so the handful of 2D calls it makes are enough of a shim -
// this test is about the cache's eviction policy, not about pixels.
class StubCanvas {
  constructor(
    public width: number,
    public height: number,
  ) {}
  getContext(): unknown {
    return {
      font: "",
      textAlign: "",
      textBaseline: "",
      fillStyle: "",
      globalCompositeOperation: "",
      clearRect() {},
      fillRect() {},
      fillText() {},
      beginPath() {},
      arc() {},
      fill() {},
      measureText: (t: string) => ({ width: Math.max(1, t.length) }),
    };
  }
}
(globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas ??= StubCanvas;

import type { FontBook } from "../src/gfx/fonts";
import {
  GLYPH_CACHE_LIMIT,
  clearGlyphCache,
  glyphCacheSize,
  glyphTexture,
} from "../src/ui/text";

/** Measures one "px" per character; no DOM, no real font. */
const fakeFonts = {
  measureWidth: (_style: unknown, text: string) => Math.max(1, text.length),
  faceMetrics: () => ({ height: 10, ascent: 8, descent: 2 }),
} as unknown as FontBook;

const style: TextStyleOptions = { fontFamily: "test", fontSize: 10, fontWeight: "400" };

describe("glyph cache eviction", () => {
  beforeEach(() => {
    clearGlyphCache();
  });

  it("evicts to stay inside its bound", () => {
    for (let i = 0; i < GLYPH_CACHE_LIMIT + 50; i++) {
      glyphTexture(`churn ${i}`, style, fakeFonts);
    }
    expect(glyphCacheSize()).toBeLessThanOrEqual(GLYPH_CACHE_LIMIT);
  });

  it("does not destroy an evicted texture a live Label may still hold", () => {
    // Stand in for a cached scene's constructor-era label: minted first, so it
    // is the first thing FIFO eviction reaches, and never re-set afterwards.
    const parked = glyphTexture("SETTINGS", style, fakeFonts);
    expect(parked.destroyed).toBe(false);

    // The result screens' count-up churn: enough distinct strings to cycle the
    // whole cache past the parked entry.
    for (let i = 0; i < GLYPH_CACHE_LIMIT + 50; i++) {
      glyphTexture(`${i}`, style, fakeFonts);
    }

    // The entry is gone from the map (the bound is respected) ...
    expect(glyphCacheSize()).toBeLessThanOrEqual(GLYPH_CACHE_LIMIT);
    // ... but the texture object itself must still be usable, because a
    // Sprite somewhere is still drawing it.
    expect(parked.destroyed).toBe(false);
  });

  it("mints a fresh entry after an eviction rather than reviving a dead one", () => {
    const first = glyphTexture("SETTINGS", style, fakeFonts);
    for (let i = 0; i < GLYPH_CACHE_LIMIT + 50; i++) {
      glyphTexture(`${i}`, style, fakeFonts);
    }
    const again = glyphTexture("SETTINGS", style, fakeFonts);
    expect(again.destroyed).toBe(false);
    expect(first.destroyed).toBe(false);
  });
});
