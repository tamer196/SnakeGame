/**
 * Mapping between the fixed design space and the real screen.
 *
 * Every scene, level layout and HUD position in this game is authored against
 * a 1280x720 design space, exactly as the Python original was. Real devices
 * range from a 4:3 iPad to a 21:9 monitor to a 19.5:9 phone in landscape, so
 * the design space is scaled uniformly to fit and centred.
 *
 * Uniform scale is a deliberate choice, not laziness: obstacle positions in
 * the twelve levels are authored as fractions of the arena, so a non-uniform
 * fit would silently distort every hand-tuned layout. Landscape-only play
 * means the aspect never strays far enough for the bars to be wasteful.
 *
 * Two rectangles matter:
 *
 *   core     - the 1280x720 design box. Gameplay, the arena and the HUD live
 *              here, and nothing gameplay-critical may sit outside it.
 *   overscan - the whole screen expressed in design units. On a 19.5:9 phone
 *              this is wider than 1280, and backgrounds and touch affordances
 *              are free to fill it so the letterbox bars are not dead space.
 */

import { WINDOW_H, WINDOW_W } from "../core/config";

export interface SafeInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface DesignRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export class Viewport {
  /** Physical CSS pixels. */
  screenW = 1;
  screenH = 1;
  /** Device pixel ratio actually used for rendering. */
  dpr = 1;
  /** design px -> css px */
  scale = 1;
  /** Top-left of the design box, in CSS px. */
  offsetX = 0;
  offsetY = 0;
  /** The whole screen, expressed in design units. */
  overscan: DesignRect = { x: 0, y: 0, w: WINDOW_W, h: WINDOW_H };
  /** Safe-area insets in design units (notch, home indicator, rounded corners). */
  safe: SafeInsets = { top: 0, right: 0, bottom: 0, left: 0 };

  /** Recompute from a screen size. Returns true if anything changed. */
  resize(screenW: number, screenH: number, dpr: number, insets?: SafeInsets): boolean {
    const w = Math.max(1, Math.floor(screenW));
    const h = Math.max(1, Math.floor(screenH));
    // Reported, not spent: the renderer keeps its own cap (Game.ts), and this
    // value only reaches the boot diagnostic readout. Clamped to the same 3 so
    // the two never disagree on screen.
    const ratio = Math.max(1, Math.min(dpr || 1, 3));

    // The design box is fitted inside the SAFE area, not the raw screen, and
    // this is load-bearing rather than tidy. Going edge-to-edge on Android puts
    // the window under the display cutout and the navigation bar; on a 19.5:9
    // phone the pillarbox bars happen to be wide enough to swallow both, but on
    // a 16:9 one the fit is height-limited, there are no bars, and a cutout
    // would land squarely on the HUD. Fitting to the safe rect is the only
    // version that holds for every aspect.
    //
    // `overscan` is deliberately still the WHOLE screen: backgrounds and the
    // post chain fill to the glass, including under the cutout. Only the
    // 1280x720 box of gameplay and HUD is inset.
    const ins = insets ?? { top: 0, right: 0, bottom: 0, left: 0 };
    const availW = Math.max(1, w - ins.left - ins.right);
    const availH = Math.max(1, h - ins.top - ins.bottom);

    const scale = Math.min(availW / WINDOW_W, availH / WINDOW_H);
    const offsetX = ins.left + (availW - WINDOW_W * scale) * 0.5;
    const offsetY = ins.top + (availH - WINDOW_H * scale) * 0.5;

    const changed =
      w !== this.screenW ||
      h !== this.screenH ||
      ratio !== this.dpr ||
      scale !== this.scale ||
      // Insets can move the box without changing its size - a phone rotated so
      // the cutout swaps sides is exactly that - and the scene tree has to be
      // told, or it keeps drawing at the old offset.
      offsetX !== this.offsetX ||
      offsetY !== this.offsetY;

    this.screenW = w;
    this.screenH = h;
    this.dpr = ratio;
    this.scale = scale;
    this.offsetX = offsetX;
    this.offsetY = offsetY;

    // The full screen in design units, centred on the design box.
    this.overscan = {
      x: -offsetX / scale,
      y: -offsetY / scale,
      w: w / scale,
      h: h / scale,
    };

    if (insets) {
      this.safe = {
        top: insets.top / scale,
        right: insets.right / scale,
        bottom: insets.bottom / scale,
        left: insets.left / scale,
      };
    }

    return changed;
  }

  /** Screen (CSS px) -> design space. May fall outside the 1280x720 box. */
  toDesign(sx: number, sy: number): { x: number; y: number } {
    const s = this.scale || 1;
    return { x: (sx - this.offsetX) / s, y: (sy - this.offsetY) / s };
  }

  /** Screen -> design space, clamped into the design box. */
  toDesignClamped(sx: number, sy: number): { x: number; y: number } {
    const p = this.toDesign(sx, sy);
    return {
      x: p.x < 0 ? 0 : p.x > WINDOW_W ? WINDOW_W : p.x,
      y: p.y < 0 ? 0 : p.y > WINDOW_H ? WINDOW_H : p.y,
    };
  }

  /** Design space -> screen (CSS px). */
  toScreen(dx: number, dy: number): { x: number; y: number } {
    return { x: dx * this.scale + this.offsetX, y: dy * this.scale + this.offsetY };
  }

  /** A length in CSS px expressed in design units (for touch thresholds). */
  cssToDesign(px: number): number {
    return px / (this.scale || 1);
  }

  /** Is this screen tablet-sized or larger? Drives the control scheme. */
  get isTabletOrLarger(): boolean {
    return Math.min(this.screenW, this.screenH) >= 600;
  }

  /** True when the design box does not fill the screen horizontally. */
  get hasPillarbox(): boolean {
    return this.offsetX > 0.5;
  }

  /** True when the design box does not fill the screen vertically. */
  get hasLetterbox(): boolean {
    return this.offsetY > 0.5;
  }
}

/** Read the CSS env(safe-area-inset-*) values the page exposes as variables. */
export function readSafeInsets(): SafeInsets {
  if (typeof window === "undefined") {
    return { top: 0, right: 0, bottom: 0, left: 0 };
  }
  const style = getComputedStyle(document.documentElement);
  const read = (name: string): number => {
    const v = parseFloat(style.getPropertyValue(name));
    return Number.isFinite(v) ? v : 0;
  };
  return {
    top: read("--safe-top"),
    right: read("--safe-right"),
    bottom: read("--safe-bottom"),
    left: read("--safe-left"),
  };
}
