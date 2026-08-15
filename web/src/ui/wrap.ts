/**
 * Greedy word wrap - the one function five Python helpers collapse into.
 *
 * `mode_select.py:113`, `level_select.py:150`, `settings.py`, `help_scene.py`
 * and `story_scene.py` each carry their own `_wrap`. They differ in exactly two
 * ways: the line cap, and whether an overflowing last line is ellipsised. Both
 * become arguments here rather than four more copies.
 *
 * The behaviour is *greedy*, not optimal: a word is added to the current line
 * if it still fits, otherwise the line is closed and the word starts the next
 * one. A single word longer than the width is never broken - it overflows,
 * exactly as the Python's does.
 *
 * **Caching matters.** These are called every frame for static blurbs, and each
 * call measures every prefix. The cache is keyed on the style's CSS string plus
 * the text and geometry, which is stable across frames because `FontBook` hands
 * out identity-stable style objects.
 *
 * A note on parity: browser and pygame font metrics differ slightly, so a
 * string can wrap one word earlier or later here than in a capture. Layouts
 * that *centre* wrapped text absorb that; layouts that pack against a measured
 * width need a look at the reference image.
 */

import type { TextStyleOptions } from "pixi.js";

import { cssFont, type FontBook } from "../gfx/fonts";

export interface WrapOptions {
  /** Hard cap on the number of lines. Default 3, matching mode_select. */
  maxLines?: number;
  /**
   * Ellipsise the last line when words were dropped, as `level_select` does:
   * trailing spaces, dots and commas are stripped before "..." is appended.
   */
  ellipsis?: boolean;
}

const cache = new Map<string, readonly string[]>();
/** `mode_select.py:143` clears at 256; the same bound, evicting one at a time. */
const CACHE_LIMIT = 256;

export function wrapText(
  fonts: FontBook,
  style: TextStyleOptions,
  text: string,
  width: number,
  opts: WrapOptions = {},
): readonly string[] {
  const maxLines = Math.max(1, Math.trunc(opts.maxLines ?? 3));
  const ellipsis = opts.ellipsis ?? false;
  const key = `${cssFont(style)}|${Math.trunc(width)}|${maxLines}|${ellipsis ? 1 : 0}|${text}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const words = String(text).split(/\s+/).filter(Boolean);
  let out: string[] = [];

  if (words.length > 0) {
    let current = words[0]!;
    let i = 1;
    let truncated = false;
    for (; i < words.length; i++) {
      const trial = `${current} ${words[i]}`;
      if (fonts.measureWidth(style, trial) <= width) {
        current = trial;
        continue;
      }
      out.push(current);
      if (out.length >= maxLines) {
        truncated = true;
        break;
      }
      current = words[i]!;
    }
    if (!truncated && out.length < maxLines) out.push(current);

    if (ellipsis && truncated && out.length > 0) {
      const last = out[out.length - 1]!;
      out[out.length - 1] = `${last.replace(/[ .,]+$/, "")}...`;
    }
    out = out.slice(0, maxLines);
  }

  const frozen = Object.freeze(out);
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, frozen);
  return frozen;
}

/** Drop every cached wrap. Tests and hot-reload only. */
export function clearWrapCache(): void {
  cache.clear();
}

/** Cache occupancy, for tests. */
export function wrapCacheSize(): number {
  return cache.size;
}
