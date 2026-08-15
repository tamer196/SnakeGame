/**
 * The named font ladder - a port of `snake/gfx/fonts.py`.
 *
 * The game ships no font files. Python picks the best face the host actually
 * has by walking a preference list; a CSS `font-family` stack has exactly the
 * same first-available semantics, evaluated by the browser instead of by us, so
 * the three lists become three strings and `_pick` disappears entirely.
 *
 * What does *not* survive the translation is what pygame does with a name once
 * it has picked it, and two of those quirks are visible in every reference
 * capture, so they are reproduced here rather than corrected:
 *
 * 1. `pygame.sysfont` strips style words (`Light`, `Narrow`, ...) from a family
 *    name before using it as a key, so sibling families collapse onto one entry
 *    and the last one enumerated wins. On Windows `SysFont("segoeui", n)` is
 *    therefore **Segoe UI Light**, not Regular - a 4% narrower string and a
 *    visibly thinner stroke at 14 px. Hence `fontWeight: "300"` on the non-bold
 *    UI roles, and hence `system-ui` appears nowhere near the front of a stack:
 *    on Windows it resolves to Segoe UI Regular and would quietly undo this.
 * 2. Bahnschrift has no bold file, so pygame's `bold=True` is *synthetic*
 *    emboldening - only +1.3% width at 96 px. A browser asked for weight 700
 *    instantiates the variable font's real 700 cut, which is heavier than the
 *    capture. 700 is still what the design means (four of the eight display
 *    candidates are inherently heavy and have no bold cut at all), so it is what
 *    ships; see docs/port/ui.md S0.8.3 for the step-down path if a headline
 *    reads fatter than `captures/01-menu.png`.
 *
 * This module deliberately has **no runtime dependency on Pixi**: it hands out
 * plain `TextStyleOptions`, which is data, and measures with a 2D context. That
 * keeps it importable - and unit-testable - outside a browser, and keeps the
 * pixi bundle out of the headless test path, where importing it costs 30
 * seconds.
 *
 * See `docs/port/ui.md` section 0 for the full derivation, the per-platform
 * face table and the measured metrics this was checked against.
 */

import type { TextStyleOptions } from "pixi.js";

// ---------------------------------------------------------------------------
// The three face stacks
// ---------------------------------------------------------------------------

/**
 * `DISPLAY_FACES` (fonts.py:18-21), re-expanded to CSS names.
 *
 * Titles and big numbers. The candidates differ wildly in width at the same px
 * size - "NEON SERPENT" at 96 px is 699 px in Bahnschrift and 548 in Impact -
 * which is why every display-face layout in this game centres rather than packs.
 * Treat packing against this stack as a bug.
 */
export const DISPLAY_STACK =
  'Bahnschrift, Impact, "Franklin Gothic Heavy", "Arial Black", ' +
  '"Helvetica Neue", "DejaVu Sans", Verdana, Arial, system-ui, sans-serif';

/** `UI_FACES` (fonts.py:22-25). Body copy, labels, the HUD. */
export const UI_STACK =
  '"Segoe UI", Selawik, "Helvetica Neue", Roboto, "DejaVu Sans", ' +
  "Verdana, Arial, system-ui, sans-serif";

/** `MONO_FACES` (fonts.py:26-29). Stats and the debug readout. */
export const MONO_STACK =
  'Consolas, "Cascadia Mono", Menlo, "DejaVu Sans Mono", ' +
  '"Liberation Mono", "Courier New", monospace';

/** Which family stack a style is built from. */
export type FontRole = "display" | "ui" | "mono";

const STACKS: Record<FontRole, string> = {
  display: DISPLAY_STACK,
  ui: UI_STACK,
  mono: MONO_STACK,
};

/**
 * Weight per (role, bold).
 *
 * `display_at()` always passes `bold=True` (fonts.py:102-104) - there is no
 * non-bold display face anywhere in the game - so the display row ignores the
 * flag. The UI row is where the Segoe UI Light quirk lives.
 */
function weightFor(role: FontRole, bold: boolean): string {
  if (role === "display") return "700";
  if (role === "ui") return bold ? "700" : "300";
  return bold ? "700" : "400";
}

/** What every style carries, so no call site has to remember it. */
const COMMON = {
  // Colour leaves the style, exactly as it leaves the glow textures: the raster
  // is white and the colour arrives as `text.tint`. Python's text cache is keyed
  // on (string, font, colour) and so rebuilds the glyphs for every colour; a
  // white raster plus a tint reuses one raster across every colour and across
  // the per-frame lerp most labels animate through.
  fill: 0xffffff,
  // Every wrap in this game is a hand-written helper with its own line cap and
  // ellipsis rule; Pixi's greedy wrapper reproduces none of them.
  wordWrap: false,
  letterSpacing: 0,
  align: "left",
  fontStyle: "normal",
  padding: 0,
} as const;

/** A measured string, in design pixels: pygame's `font.size(text)`. */
export interface Metrics {
  readonly w: number;
  readonly h: number;
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

let measureCtx: CanvasRenderingContext2D | null = null;

function measurementContext(): CanvasRenderingContext2D {
  if (measureCtx) return measureCtx;
  if (typeof document === "undefined" || typeof document.createElement !== "function") {
    throw new Error(
      "gfx/fonts: measuring text needs a DOM. The style ladder itself is pure " +
        "data and works headlessly; only measure() and measureWidth() do not.",
    );
  }
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("gfx/fonts: could not acquire a 2D context to measure with");
  measureCtx = ctx;
  return ctx;
}

/** The CSS `font` shorthand for a style, which is what a 2D context wants. */
export function cssFont(opts: TextStyleOptions): string {
  return `${opts.fontWeight ?? "400"} ${opts.fontSize as number}px ${opts.fontFamily as string}`;
}

// ---------------------------------------------------------------------------
// FontBook
// ---------------------------------------------------------------------------

/**
 * Named font sizes for the whole game, cached forever.
 *
 * One instance lives on the shell as `game.fonts`, mirroring
 * `main.py:98`. It hands out `TextStyleOptions` - never `Text` objects - just as
 * the Python hands out `Font` objects and never surfaces.
 *
 * The objects returned are **identity-stable**: the same (role, size, bold)
 * always yields the very same frozen object. That is not a micro-optimisation.
 * Several caches downstream in the Python are keyed on `id(font)`
 * (`ui.py:256`, `ui.py:766`, `menu.py:196`, `mode_select.py:122`), and their
 * ports key on the style object; a fresh literal per call would turn every one
 * of them into a per-frame miss.
 */
export class FontBook {
  private readonly cache = new Map<string, TextStyleOptions>();

  /**
   * Raster scale for `Text` objects, which callers copy to `text.resolution`.
   *
   * A `Text` rasterises at `fontSize * resolution` and is then magnified by the
   * world transform, so on a 1920-wide window a 96 px headline drawn in the
   * 1280-wide design space is rasterised at 96 px and blown up 1.5x. Python has
   * no equivalent problem to solve - its canvas *is* the design space, and the
   * finished 1280-wide frame is upscaled once at blit time - but sharper text
   * here is a welcome divergence and blurry text is not.
   */
  resolution = 1;

  // The ladder, fonts.py:63-71. Built eagerly so the first frame pays nothing.
  readonly huge: TextStyleOptions;
  readonly title: TextStyleOptions;
  readonly h1: TextStyleOptions;
  /** The odd one out: UI face bold, not display face. */
  readonly h2: TextStyleOptions;
  readonly body: TextStyleOptions;
  readonly small: TextStyleOptions;
  readonly tiny: TextStyleOptions;
  /** Built by the Python and never used by it; ported for completeness. */
  readonly mono: TextStyleOptions;
  /** Used only by the FPS readout, which is off and draws outside the design space. */
  readonly monoSmall: TextStyleOptions;

  constructor() {
    this.huge = this.displayAt(96);
    this.title = this.displayAt(64);
    this.h1 = this.displayAt(42);
    this.h2 = this.get(30, true);
    this.body = this.get(21);
    this.small = this.get(17);
    this.tiny = this.get(14);
    this.mono = this.monoAt(16);
    this.monoSmall = this.monoAt(13);
  }

  // -- builders ----------------------------------------------------------

  private build(role: FontRole, size: number, bold: boolean): TextStyleOptions {
    const px = Math.max(1, Math.round(size));
    const key = `${role}|${px}|${bold ? 1 : 0}`;
    const hit = this.cache.get(key);
    if (hit) return hit;

    const opts: TextStyleOptions = Object.freeze({
      ...COMMON,
      fontFamily: STACKS[role],
      fontSize: px,
      fontWeight: weightFor(role, bold),
    }) as TextStyleOptions;
    this.cache.set(key, opts);
    return opts;
  }

  /** `fonts.get(size, bold=False)` - the UI face. */
  get(size: number, bold = false): TextStyleOptions {
    return this.build("ui", size, bold);
  }

  /** `fonts.display_at(size)` - the heavy display face, always bold. */
  displayAt(size: number): TextStyleOptions {
    return this.build("display", size, true);
  }

  /** `fonts.mono_at(size, bold=False)`. */
  monoAt(size: number, bold = false): TextStyleOptions {
    return this.build("mono", size, bold);
  }

  // -- measurement -------------------------------------------------------

  /**
   * `font.size(text)` - the width and line height of a rendered string.
   *
   * Height is the font's own box, not the ink box, which is what pygame
   * reports and what every vertical-centring call site here assumes.
   */
  measure(opts: TextStyleOptions, text: string): Metrics {
    if (text === "") return { w: 0, h: this.lineHeight(opts) };
    const ctx = measurementContext();
    ctx.font = cssFont(opts);
    const m = ctx.measureText(text);
    const ascent = m.fontBoundingBoxAscent;
    const descent = m.fontBoundingBoxDescent;
    const h =
      Number.isFinite(ascent) && Number.isFinite(descent) && ascent + descent > 0
        ? ascent + descent
        : this.lineHeight(opts);
    return { w: m.width, h };
  }

  /** Just the width, which is what almost every call site actually wants. */
  measureWidth(opts: TextStyleOptions, text: string): number {
    if (text === "") return 0;
    const ctx = measurementContext();
    ctx.font = cssFont(opts);
    return ctx.measureText(text).width;
  }

  /**
   * A line height without touching the DOM, for headless callers and as the
   * fallback when a browser will not report a font box.
   *
   * The 1.35 factor is Segoe UI Light's measured ratio (17 px -> 23). It is
   * wrong for the display face, whose box equals its px size exactly, so this
   * is a fallback and not a substitute for {@link measure}.
   */
  lineHeight(opts: TextStyleOptions): number {
    const px = (opts.fontSize as number) ?? 0;
    return (opts.fontFamily as string) === DISPLAY_STACK ? px : Math.round(px * 1.35);
  }

  /**
   * The largest font in `ladder` whose rendered `text` fits `maxWidth`.
   *
   * Python's `_fit_font` (used by the READY card headline and several menu
   * titles) walks a fixed list largest-first and falls back to the *last*
   * entry rather than overflowing, so a string that fits nothing still draws.
   */
  fit(ladder: readonly TextStyleOptions[], text: string, maxWidth: number): TextStyleOptions {
    const last = ladder[ladder.length - 1];
    if (!last) throw new Error("gfx/fonts: fit() needs a non-empty ladder");
    for (const opts of ladder) {
      if (this.measureWidth(opts, text) <= maxWidth) return opts;
    }
    return last;
  }

  // -- housekeeping ------------------------------------------------------

  /** Called from `Game.applyResize`; see {@link resolution}. */
  setResolution(r: number): void {
    this.resolution = Math.min(3, Math.max(1, Number.isFinite(r) ? r : 1));
  }

  /** Cache occupancy, for the debug overlay and tests. */
  get size(): number {
    return this.cache.size;
  }
}

/**
 * Wait for the font faces to settle.
 *
 * A `Text` built before the face has resolved measures against a fallback, and
 * Pixi caches that measurement with the raster - so a mis-tiered headline or a
 * mis-sized pill stays wrong until its string changes. Awaiting this once,
 * before the first scene, is enough; it resolves immediately when there is
 * nothing to load, and is a no-op outside a browser.
 */
export async function fontsReady(): Promise<void> {
  const fonts = (globalThis as { document?: { fonts?: { ready?: Promise<unknown> } } }).document
    ?.fonts;
  if (fonts?.ready) await fonts.ready;
}
