/**
 * The neon play-field border - a port of `draw_arena` in `snake/gfx/render.py`.
 *
 * Two halves with very different costs. The **frame** is 66 nested rounded-rect
 * outlines - an inner gradient marching outward from deep inside the play field
 * so its edge looks lit from within, and an outer bloom fading away from the
 * border - which never change, so they are rasterised once per (size, theme)
 * onto a canvas and shown as a single additive sprite. The **energy** on top of
 * it is live: a dash train marching clockwise, breathing corner brackets and two
 * bright runners chasing each other around the perimeter.
 *
 * The whole thing is clipped to `(x - 32, y, w + 64, h + 32)`. Spill to the
 * sides and below is intended - it bleeds into the window margin and is part of
 * the look - but directly above the arena sits the translucent HUD strip
 * (`ARENA_Y == HUD_H`), and a 30 px band of bloom shows straight through it
 * whichever is drawn first. The bright 2 px border line sits exactly on the cut,
 * so the clipped edge is invisible.
 *
 * As in the Python, brightness is baked into the frame sprite's RGB and it is
 * composited additively: untouched pixels are black and add nothing.
 */

import { Container, Graphics, Sprite, Texture } from "pixi.js";

import * as C from "../core/config";
import { clamp, pulse } from "../core/mathx";
import { lerpColor, shade, toHex, type RGB, type Theme } from "../core/palette";
import type { DesignRect } from "../app/Viewport";
import { mixHex, rgbOf, shadeHex } from "./SnakeRenderer";
import {
  canvasTexture,
  clearToBlack,
  context2d,
  createCanvas,
  cssRgb,
  setGlow,
} from "./textures";

const WHITE_HEX = 0xffffff;

/** How far outside the arena rect the bloom reaches, in design px. */
const FRAME_PAD = 26;
/** How far the whole routine is allowed to spill sideways / below. */
const BLEED = 32;

/** Dashes in the marching train, and the perimeter gap between a dash's dots. */
const DASHES = 10;
const DASH_SPAN = 0.009;

// One texture per (size, theme) pair. Python keeps eight; so do we. Evicted
// entries are dropped from the map but not destroyed - a live ArenaFrame may
// still be showing one, and the working set is a dozen textures at worst.
const frameCache = new Map<string, Texture>();
const FRAME_CACHE_LIMIT = 8;

/**
 * pygame's `Rect.inflate`, including its C truncation toward zero: the size
 * changes by `amount` and the centre is held, so a negative odd amount shifts
 * the left edge by `amount / 2` rounded *up*.
 */
function inflate(r: DesignRect, amount: number, out: DesignRect): DesignRect {
  out.x = r.x - Math.trunc(amount / 2);
  out.y = r.y - Math.trunc(amount / 2);
  out.w = r.w + amount;
  out.h = r.h + amount;
  return out;
}

/**
 * A rounded-rect outline drawn the way `pygame.draw.rect(width=2)` does it:
 * *inside* the rect, not centred on its edge. Hence the half-width inset.
 */
function strokeRoundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
  col: RGB,
): void {
  ctx.strokeStyle = cssRgb(col);
  ctx.beginPath();
  ctx.roundRect(x + 1, y + 1, w - 2, h - 2, Math.max(0, radius - 1));
  ctx.stroke();
}

function buildFrameTexture(w: number, h: number, accent: RGB, accent2: RGB): Texture {
  const size = { w: w + FRAME_PAD * 2, h: h + FRAME_PAD * 2 };
  const canvas = createCanvas(size.w, size.h);
  const ctx = context2d(canvas);
  clearToBlack(ctx, size.w, size.h);
  ctx.lineWidth = 2;
  ctx.lineJoin = "round";

  // Inner gradient: nested outlines marching from deep inside out to the
  // border, getting brighter, so the play field edge is lit from within.
  const depth = 40;
  for (let i = depth; i >= 1; i--) {
    const f = Math.pow(1.0 - i / depth, 2.2);
    const rw = w - 2 * i;
    const rh = h - 2 * i;
    if (rw <= 2 || rh <= 2) continue;
    strokeRoundRect(
      ctx,
      FRAME_PAD + i,
      FRAME_PAD + i,
      rw,
      rh,
      Math.max(2, C.UI_CORNER - Math.floor(i / 4)),
      shade(lerpColor(accent2, accent, f), 0.34 * f),
    );
  }

  // Outer bloom: expanding outlines fading away from the border.
  for (let i = FRAME_PAD; i >= 1; i--) {
    const f = Math.pow(1.0 - i / FRAME_PAD, 2.6);
    strokeRoundRect(
      ctx,
      FRAME_PAD - i,
      FRAME_PAD - i,
      w + 2 * i,
      h + 2 * i,
      C.UI_CORNER + i,
      shade(lerpColor(accent2, accent, f), 0.55 * f),
    );
  }

  return canvasTexture(canvas);
}

function frameTexture(w: number, h: number, accent: RGB, accent2: RGB): Texture {
  const key = `${w}|${h}|${toHex(accent)}|${toHex(accent2)}`;
  const hit = frameCache.get(key);
  if (hit) return hit;
  const tex = buildFrameTexture(w, h, accent, accent2);
  frameCache.set(key, tex);
  while (frameCache.size > FRAME_CACHE_LIMIT) {
    const oldest = frameCache.keys().next();
    if (oldest.done === true) break;
    frameCache.delete(oldest.value);
  }
  return tex;
}

export class ArenaFrame {
  /** Add this to the gameplay scene, behind the obstacles and the snake. */
  readonly container = new Container();

  private readonly rect: DesignRect;
  private theme: Theme;

  private readonly content = new Container();
  private readonly maskG = new Graphics();
  private readonly frameSprite = new Sprite();
  private readonly borderG = new Graphics();
  private readonly glowLayer = new Container();
  /** Runner dots ride on top of their own glows, so they need a layer above. */
  private readonly topG = new Graphics();

  // Fixed sprite counts: five dash halos (every other dash), four corner
  // brackets, two runners. Built once, moved and re-tinted per frame.
  private readonly dashGlows: Sprite[] = [];
  private readonly cornerGlows: Sprite[] = [];
  private readonly runnerGlows: Sprite[] = [];

  private accentHex = 0;
  private accent2Hex = 0;
  private hairlineHex = 0;

  // Scratch, so a frame allocates nothing.
  private readonly inner: DesignRect = { x: 0, y: 0, w: 0, h: 0 };
  private readonly bracket: DesignRect = { x: 0, y: 0, w: 0, h: 0 };
  private ppx = 0;
  private ppy = 0;

  private destroyed = false;
  private warned = false;

  constructor(rect: DesignRect, theme: Theme) {
    this.rect = {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      w: Math.max(8, Math.round(rect.w)),
      h: Math.max(8, Math.round(rect.h)),
    };
    this.theme = theme;

    this.frameSprite.blendMode = "add";
    this.frameSprite.position.set(this.rect.x - FRAME_PAD, this.rect.y - FRAME_PAD);

    for (let i = 0; i < DASHES >> 1; i++) this.dashGlows.push(this.newGlow());
    for (let i = 0; i < 4; i++) this.cornerGlows.push(this.newGlow());
    for (let i = 0; i < 2; i++) this.runnerGlows.push(this.newGlow());

    this.maskG
      .rect(this.rect.x - BLEED, this.rect.y, this.rect.w + BLEED * 2, this.rect.h + BLEED)
      .fill({ color: 0xffffff });
    this.container.addChild(this.maskG, this.content);
    this.content.mask = this.maskG;
    this.content.addChild(this.frameSprite, this.borderG, this.glowLayer, this.topG);

    this.applyTheme();
  }

  /** Swap the level theme; rebuilds (or reuses) the cached frame sprite. */
  setTheme(theme: Theme): void {
    if (this.destroyed || theme === this.theme) return;
    this.theme = theme;
    this.applyTheme();
  }

  /**
   * Repaint the live border. `t` is the scene clock in seconds, not a delta.
   * Like the Python original this must never throw.
   */
  update(t: number): void {
    if (this.destroyed) return;
    try {
      this.paint(Number.isFinite(t) ? t : 0);
    } catch (err) {
      if (!this.warned) {
        this.warned = true;
        console.warn("[ArenaFrame] update failed", err);
      }
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.content.mask = null;
    // The frame texture is shared through the cache; only the display objects
    // belong to this instance.
    this.container.destroy({ children: true });
  }

  // -------------------------------------------------------------------

  private newGlow(): Sprite {
    const s = new Sprite();
    s.anchor.set(0.5);
    s.blendMode = "add";
    this.glowLayer.addChild(s);
    return s;
  }

  private applyTheme(): void {
    const theme = this.theme;
    this.accentHex = theme.hex.accent;
    this.accent2Hex = theme.hex.accent2;
    this.hairlineHex = shadeHex(this.accentHex, 0.45);
    this.frameSprite.texture = frameTexture(
      this.rect.w,
      this.rect.h,
      theme.accent,
      theme.accent2,
    );
  }

  /** Point at fraction `u` (0..1) clockwise around the rect's perimeter. */
  private perimeter(u: number): void {
    const r = this.rect;
    const uu = ((u % 1.0) + 1.0) % 1.0;
    let d = uu * (2.0 * (r.w + r.h));
    if (d < r.w) {
      this.ppx = r.x + d;
      this.ppy = r.y;
      return;
    }
    d -= r.w;
    if (d < r.h) {
      this.ppx = r.x + r.w;
      this.ppy = r.y + d;
      return;
    }
    d -= r.h;
    if (d < r.w) {
      this.ppx = r.x + r.w - d;
      this.ppy = r.y + r.h;
      return;
    }
    d -= r.w;
    this.ppx = r.x;
    this.ppy = r.y + r.h - Math.min(d, r.h);
  }

  private paint(t: number): void {
    const r = this.rect;
    const g = this.borderG;
    const top = this.topG;
    g.clear();
    top.clear();

    const beat = pulse(t, 1.9);

    // ---- the two static-ish border lines ------------------------------
    // pygame strokes inside the rect, so both use `alignment: 1`.
    g.roundRect(r.x, r.y, r.w, r.h, C.UI_CORNER);
    g.stroke({
      width: 2,
      color: mixHex(this.accentHex, WHITE_HEX, 0.1 + 0.22 * beat),
      alignment: 1,
    });
    const inner = inflate(r, -8, this.inner);
    g.roundRect(inner.x, inner.y, inner.w, inner.h, Math.max(2, C.UI_CORNER - 4));
    g.stroke({ width: 1, color: this.hairlineHex, alignment: 1 });

    // ---- energy running along the border ------------------------------
    // A train of short dashes marching clockwise, each a pair of stamped dots
    // rather than a line so it never cuts a corner. Brightness oscillates along
    // the train, which gives the whole border a direction. The soft halo only
    // goes on every other dash - two thirds of the cost of this effect was in
    // those blits and the eye cannot tell.
    for (let k = 0; k < DASHES; k++) {
      const u0 = (t * 0.062 + k / DASHES) % 1.0;
      const f = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t * 2.4 + k * 0.9));
      const col = mixHex(this.accent2Hex, this.accentHex, f);
      const dot = mixHex(col, WHITE_HEX, 0.25 * f);
      this.perimeter(u0);
      g.circle(this.ppx, this.ppy, 2);
      this.perimeter(u0 + DASH_SPAN);
      g.circle(this.ppx, this.ppy, 2);
      g.fill(dot);
      if (k & 1) {
        const s = this.dashGlows[k >> 1]!;
        setGlow(s, 11.0, rgbOf(col), 0.3 + 0.35 * f);
        s.position.set(this.ppx, this.ppy);
      }
    }

    // ---- corner brackets ----------------------------------------------
    // Short thick arms hugging the border, so they read as accents on the frame
    // rather than as a second inner rectangle. A thinner second bracket sits
    // inside them and breathes out of phase.
    const br = inflate(r, -9, this.bracket);
    const arm =
      Math.trunc(clamp(Math.min(br.w, br.h) * 0.045, 16.0, 30.0)) + Math.trunc(3 * beat);
    const beat2 = pulse(t, 1.9 + 1.3);
    const arm2 = Math.trunc(arm * (0.52 + 0.22 * beat2));
    const inset = 8;
    const bcol = mixHex(this.accent2Hex, WHITE_HEX, 0.22 + 0.22 * beat);
    const bcol2 = mixHex(this.accentHex, WHITE_HEX, 0.1 + 0.3 * beat2);
    const left = br.x;
    const right = br.x + br.w;
    const topY = br.y;
    const bottom = br.y + br.h;

    for (let c = 0; c < 4; c++) {
      const sx = c === 1 || c === 3 ? -1 : 1;
      const sy = c >= 2 ? -1 : 1;
      const ox = c === 1 || c === 3 ? right : left;
      const oy = c >= 2 ? bottom : topY;
      // pygame's thick lines are butt-ended rectangles centred on the segment.
      g.rect(sx > 0 ? ox : ox - arm, oy - 2, arm, 4);
      g.rect(ox - 2, sy > 0 ? oy : oy - arm, 4, arm);
      g.fill(bcol);
      const ix = ox + sx * inset;
      const iy = oy + sy * inset;
      g.rect(sx > 0 ? ix : ix - arm2, iy - 1, arm2, 2);
      g.rect(ix - 1, sy > 0 ? iy : iy - arm2, 2, arm2);
      g.fill(bcol2);

      const s = this.cornerGlows[c]!;
      setGlow(s, 20.0, rgbOf(this.accent2Hex), 0.55 + 0.25 * beat);
      s.position.set(ox, oy);
    }

    // ---- two bright runners chasing each other around the border -------
    const runnerDot = mixHex(this.accentHex, WHITE_HEX, 0.7);
    for (let k = 0; k < 2; k++) {
      const u = (t * 0.085 + k * 0.5) % 1.0;
      this.perimeter(u);
      const s = this.runnerGlows[k]!;
      setGlow(s, 22.0, rgbOf(this.accentHex), 0.85);
      s.position.set(this.ppx, this.ppy);
      top.circle(this.ppx, this.ppy, 3);
    }
    top.fill(runnerDot);
  }
}
