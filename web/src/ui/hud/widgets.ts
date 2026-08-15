/**
 * HUD widgets - a port of `snake/gfx/ui.py:732-957`.
 *
 * The backdrop strip, the four-segment life snake, the six power-up glyphs,
 * their countdown chips, and the combo badge.
 *
 * Everything here is drawn as vectors rather than baked to a texture, with one
 * exception: the backdrop, which is a full 1280 x 78 composite of a gradient,
 * three separators and a ten-row bloom, is identical every frame and is baked.
 * The rest are small, change shape every frame (rings deplete, badges pop,
 * segments undulate) and would need a texture per state.
 */

import { Container, Graphics, Sprite, type Texture } from "pixi.js";

import * as C from "../../core/config";
import { easeOutBack, pulse } from "../../core/mathx";
import {
  UI_DIM,
  UI_GOLD,
  UI_PANEL,
  UI_PANEL_LIGHT,
  UI_WHITE,
  bodyAt,
  lerpColor,
  rainbow,
  shade,
  toHex,
  type RGB,
  type Theme,
} from "../../core/palette";
import { POWERUP_TYPES, type PowerUpKind } from "../../core/powerups";
import { canvasTexture, context2d, createCanvas, cssRgb } from "../../gfx/textures";
import type { FontBook } from "../../gfx/fonts";
import { setUiGlow, uiGlowSprite } from "../glow";
import { Label } from "../text";

// ---------------------------------------------------------------------------
// The backdrop strip
// ---------------------------------------------------------------------------

const backdropCache = new Map<string, Texture>();

/** Column separators, baked in so they cost nothing per frame. ui.py:747 */
const SEPARATORS = [256, 618, 880];

/**
 * The translucent strip behind the HUD, with its glowing bottom edge.
 *
 * Spans the design width, not the overscan: on an ultra-wide phone the bars
 * either side stay dark, which is what the Python does and what the arena frame
 * below it already assumes.
 */
export function hudBackdropTexture(theme: Theme): Texture {
  const w = C.WINDOW_W;
  const h = C.HUD_H;
  const key = `${toHex(theme.accent)}|${toHex(theme.accent2)}|${toHex(theme.grid)}`;
  const hit = backdropCache.get(key);
  if (hit) return hit;

  const canvas = createCanvas(w, h);
  const ctx = context2d(canvas);
  ctx.clearRect(0, 0, w, h);
  ctx.globalCompositeOperation = "source-over";

  // Gradient, with its own exponent (0.6) and a top-to-bottom alpha ramp -
  // note this is NOT the panel's 0.75 law.
  const last = Math.max(1, h - 1);
  for (let y = 0; y < h; y++) {
    const f = y / last;
    const c = lerpColor(UI_PANEL_LIGHT, UI_PANEL, Math.pow(f, 0.6));
    ctx.fillStyle = cssRgb(c, Math.trunc(236 - 40 * f) / 255);
    ctx.fillRect(0, y, w, 1);
  }

  for (const x of SEPARATORS) {
    ctx.fillStyle = cssRgb(theme.grid, 120 / 255);
    ctx.fillRect(x, 16, 1, h - 32);
  }

  // Bottom edge: an accent line with nine rows of pre-baked bloom above it.
  for (let i = 0; i < 9; i++) {
    const a = Math.trunc(120 * Math.pow(1 - i / 9, 2));
    const c = lerpColor(theme.accent, theme.accent2, i / 9);
    ctx.fillStyle = cssRgb(c, a / 255);
    ctx.fillRect(0, h - 3 - i, w, 1);
  }
  ctx.fillStyle = cssRgb(lerpColor(theme.accent, UI_WHITE, 0.3), 235 / 255);
  ctx.fillRect(0, h - 3, w, 2);

  const tex = canvasTexture(canvas);
  backdropCache.set(key, tex);
  return tex;
}

// ---------------------------------------------------------------------------
// Life icons
// ---------------------------------------------------------------------------

/**
 * A four-segment mini snake; spent lives are dim ghosts.
 *
 * The segments undulate on the absolute clock with a per-icon phase, so a row
 * of them ripples rather than pulsing in unison.
 */
export class LifeIcon {
  readonly root = new Container();
  private readonly glow: Sprite;
  private readonly body = new Graphics();

  constructor() {
    this.glow = uiGlowSprite(8, UI_WHITE, 0);
    this.root.addChild(this.glow, this.body);
  }

  draw(
    cx: number,
    cy: number,
    theme: Theme,
    alive: boolean,
    t: number,
    phase: number,
    pop: number,
  ): void {
    const s = 1 + 0.35 * pop;
    const g = this.body.clear();
    this.glow.visible = false;

    for (let i = 0; i < 4; i++) {
      const f = i / 3;
      const px = cx + (1.5 - i) * 5.6 * s;
      const py = cy + Math.sin(t * 3.4 + phase - i * 0.8) * 2.2 * s;
      const rad = (5.2 - 2.4 * f) * s;
      let col: RGB = i === 0 ? theme.snakeHead : bodyAt(theme, f);
      if (!alive) {
        col = shade(lerpColor(col, UI_DIM, 0.8), 0.3);
      } else if (i === 0) {
        this.glow.position.set(px, py);
        setUiGlow(this.glow, rad * 2.6, col, 0.35 + 0.3 * pop);
      }
      g.circle(px, py, Math.max(1, Math.trunc(rad))).fill({ color: toHex(col) });
    }

    if (alive) {
      // Eye dot, so the head reads as a head at 10 px.
      g.circle(cx + 6.4 * s, cy - 1, 1).fill({ color: toHex(UI_PANEL) });
    }
  }
}

// ---------------------------------------------------------------------------
// Power-up glyphs
// ---------------------------------------------------------------------------

/**
 * The six tiny vector glyphs - no font dependency, so nothing can go missing.
 *
 * `double` is the exception: it is the string "x2", drawn with the tiny face.
 * Callers pass a `Label` for it.
 */
export function drawEffectGlyph(
  g: Graphics,
  kind: string,
  cx: number,
  cy: number,
  r: number,
  col: RGB,
): boolean {
  const c = toHex(col);
  const poly = (pts: Array<[number, number]>, close: boolean, width: number): void => {
    const first = pts[0];
    if (!first) return;
    g.moveTo(cx + first[0], cy + first[1]);
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i]!;
      g.lineTo(cx + p[0], cy + p[1]);
    }
    if (close) g.closePath();
    g.stroke({ color: c, width });
  };

  switch (kind) {
    case "shield":
      poly(
        [
          [0, -r],
          [r * 0.92, -r * 0.42],
          [r * 0.6, r * 0.85],
          [0, r],
          [-r * 0.6, r * 0.85],
          [-r * 0.92, -r * 0.42],
        ],
        true,
        2,
      );
      return true;
    case "magnet": {
      // A horseshoe: a half-arc with two legs hanging off its ends. pygame's
      // arc is y-up, so 0..pi there is the *lower* half on screen.
      const width = Math.max(2, Math.trunc(r * 0.4));
      const boxCy = cy + r * 0.3;
      g.arc(cx, boxCy, r, Math.PI, Math.PI * 2).stroke({ color: c, width });
      for (const sx of [-1, 1]) {
        const x0 = cx + sx * r * 0.78;
        g.moveTo(x0, boxCy)
          .lineTo(x0, cy + r * 0.95)
          .stroke({ color: c, width });
      }
      return true;
    }
    case "slow":
      g.circle(cx, cy, r).stroke({ color: c, width: 2 });
      g.moveTo(cx, cy)
        .lineTo(cx, cy - r * 0.62)
        .stroke({ color: c, width: 2 });
      g.moveTo(cx, cy)
        .lineTo(cx + r * 0.5, cy)
        .stroke({ color: c, width: 2 });
      return true;
    case "ghost":
      g.circle(cx, cy - r * 0.15, r * 0.8).stroke({ color: c, width: 2 });
      poly(
        [
          [-r * 0.8, 0],
          [-r * 0.8, r * 0.6],
          [-r * 0.35, r * 0.25],
          [0, r * 0.6],
          [r * 0.35, r * 0.25],
          [r * 0.8, r * 0.6],
          [r * 0.8, 0],
        ],
        false,
        2,
      );
      return true;
    case "frenzy": {
      // A filled lightning bolt - the one glyph that is solid, not stroked.
      const pts: Array<[number, number]> = [
        [r * 0.25, -r],
        [-r * 0.55, r * 0.15],
        [-r * 0.05, r * 0.15],
        [-r * 0.3, r],
        [r * 0.6, -r * 0.2],
        [r * 0.05, -r * 0.2],
      ];
      const first = pts[0]!;
      g.moveTo(cx + first[0], cy + first[1]);
      for (let i = 1; i < pts.length; i++) {
        const p = pts[i]!;
        g.lineTo(cx + p[0], cy + p[1]);
      }
      g.closePath().fill({ color: c });
      return true;
    }
    case "double":
      // Drawn as text by the caller.
      return false;
    default:
      g.circle(cx, cy, Math.max(2, Math.trunc(r * 0.6))).stroke({ color: c, width: 2 });
      return true;
  }
}

// ---------------------------------------------------------------------------
// Effect chips
// ---------------------------------------------------------------------------

/** Chip side length. ui.py:902 */
const CHIP_SIZE = 26;
/** Dots in the countdown ring. ui.py:912 */
const CHIP_SEGS = 24;
/** Below this many seconds left the chip strobes. ui.py:900 */
const CHIP_URGENT_AT = 2.0;

/** A power-up's HUD colour, falling back to the theme's second accent. */
function effectColor(kind: string, theme: Theme): RGB {
  const info = POWERUP_TYPES[kind as PowerUpKind];
  return info ? info.color : theme.accent2;
}

function effectDuration(kind: string): number {
  const info = POWERUP_TYPES[kind as PowerUpKind];
  const d = info ? info.duration : C.POWERUP_DEFAULT_DURATION;
  return d || 1;
}

/**
 * One active power-up: a rounded chip, its glyph, and a ring of dots counting
 * the remaining time down clockwise from twelve o'clock.
 */
export class EffectChip {
  readonly root = new Container();
  private readonly glow: Sprite;
  private readonly shape = new Graphics();
  private readonly glyph = new Graphics();
  private readonly ring = new Graphics();
  private readonly tipGlow: Sprite;
  private readonly x2: Label;

  constructor(fonts: FontBook) {
    this.glow = uiGlowSprite(CHIP_SIZE, UI_WHITE, 0);
    this.tipGlow = uiGlowSprite(7, UI_WHITE, 0);
    this.x2 = new Label(fonts, fonts.tiny);
    this.root.addChild(this.glow, this.shape, this.glyph, this.ring, this.tipGlow, this.x2);
  }

  draw(cx: number, cy: number, kind: string, remaining: number, theme: Theme, t: number): void {
    const col = effectColor(kind, theme);
    const frac = Math.max(0, Math.min(1, remaining / effectDuration(kind)));

    // Under two seconds the chip strobes so the loss never feels arbitrary.
    const urgent = remaining <= CHIP_URGENT_AT;
    const beat = urgent ? 0.5 + 0.5 * pulse(t, 16.0) : 1.0;

    this.glow.position.set(cx, cy);
    setUiGlow(this.glow, CHIP_SIZE, col, (0.3 + 0.3 * pulse(t, 2.4)) * beat);

    const half = CHIP_SIZE * 0.5;
    this.shape
      .clear()
      .roundRect(cx - half, cy - half, CHIP_SIZE, CHIP_SIZE, 8)
      .fill({ color: toHex(UI_PANEL), alpha: 225 / 255 })
      .roundRect(cx - half, cy - half, CHIP_SIZE, CHIP_SIZE, 8)
      .stroke({ color: toHex(col), width: 1, alpha: 150 / 255 });

    const glyphCol = lerpColor(col, UI_WHITE, 0.35 * beat);
    const g = this.glyph.clear();
    const drawn = drawEffectGlyph(g, kind, cx, cy, CHIP_SIZE * 0.3, glyphCol);
    if (drawn) {
      this.x2.visible = false;
    } else {
      // "double" is the one glyph that is a string.
      this.x2.visible = true;
      this.x2.set("x2");
      this.x2.setColor(glyphCol);
      this.x2.setShadow(false);
      this.x2.place(cx, cy - CHIP_SIZE * 0.3 * 0.95, "center");
    }

    // Countdown ring. Screen y is down, so increasing the angle already runs
    // clockwise - no negation here, unlike the cursor's arcs.
    const ringR = half + 4;
    const lit = Math.round(CHIP_SEGS * frac);
    const r = this.ring.clear();
    const litCol = toHex(lerpColor(col, UI_WHITE, 0.25 * beat));
    const dimCol = toHex(shade(col, 0.22));
    for (let i = 0; i < CHIP_SEGS; i++) {
      const ang = -Math.PI * 0.5 + Math.PI * 2 * (i / CHIP_SEGS);
      const px = cx + Math.cos(ang) * ringR;
      const py = cy + Math.sin(ang) * ringR;
      if (i < lit) r.circle(px, py, 2).fill({ color: litCol });
      else r.circle(px, py, 1).fill({ color: dimCol });
    }

    if (lit) {
      const ang = -Math.PI * 0.5 + Math.PI * 2 * (lit / CHIP_SEGS);
      this.tipGlow.position.set(cx + Math.cos(ang) * ringR, cy + Math.sin(ang) * ringR);
      setUiGlow(this.tipGlow, 7, col, 0.8 * beat);
    } else {
      this.tipGlow.visible = false;
    }
  }
}

// ---------------------------------------------------------------------------
// Combo badge
// ---------------------------------------------------------------------------

/**
 * The badge that physically pops each time the chain extends.
 *
 * `easeOutBack` overshoots, which is exactly the snap a combo wants. At the
 * maximum chain the colour leaves the theme entirely and cycles a rainbow.
 */
export class ComboBadge {
  readonly root = new Container();
  private readonly glow: Sprite;
  private readonly shape = new Graphics();
  private readonly pips = new Graphics();
  private readonly label: Label;

  constructor(fonts: FontBook) {
    this.glow = uiGlowSprite(26, UI_WHITE, 0);
    // ui.py:950 asks for ("h2", 26, True) but the shim ignores the size when
    // the name resolves, so this really renders at h2's 30 px. Ported as-is.
    this.label = new Label(fonts, fonts.h2);
    this.root.addChild(this.glow, this.shape, this.pips, this.label);
  }

  draw(cx: number, cy: number, combo: number, comboPop: number, theme: Theme, t: number): void {
    const steps = Math.max(1, Math.trunc(C.COMBO_MAX));
    const heat = Math.max(0, Math.min(1, combo / steps));
    const col: RGB =
      combo >= steps ? rainbow(t * 0.6) : lerpColor(theme.accent, UI_GOLD, heat);
    const pop = Math.max(0, Math.min(1, comboPop));
    const scale = 1 + 0.45 * easeOutBack(pop);

    this.glow.position.set(cx, cy);
    setUiGlow(this.glow, 26 * scale, col, 0.35 + 0.55 * heat + 0.5 * pop);

    const r = Math.trunc(17 * scale);
    this.shape
      .clear()
      .circle(cx, cy, r)
      .fill({ color: toHex(UI_PANEL) })
      .circle(cx, cy, r)
      .stroke({ color: toHex(col), width: 2 });

    // Pips around the badge count the chain toward COMBO_MAX.
    const p = this.pips.clear();
    const onCol = toHex(col);
    const offCol = toHex(shade(col, 0.2));
    for (let i = 0; i < steps; i++) {
      const ang = -Math.PI * 0.5 + Math.PI * 2 * (i / steps);
      const px = cx + Math.cos(ang) * 24;
      const py = cy + Math.sin(ang) * 24;
      const on = i < combo;
      p.circle(px, py, on ? 2 : 1).fill({ color: on ? onCol : offCol });
    }

    this.label.set(`x${combo}`);
    this.label.setColor(lerpColor(col, UI_WHITE, 0.45));
    // rotozoom is a plain scale of already-rendered glyphs, not a re-render.
    const s = Math.abs(scale - 1) > 0.02 ? scale : 1;
    this.label.setScale(s);
    this.label.place(cx, cy - this.label.textHeight * s * 0.5, "center");
  }
}

// ---------------------------------------------------------------------------
// Housekeeping
// ---------------------------------------------------------------------------

/** Drop the cached backdrop strips. Tests and hot-reload only. */
export function clearHudTextureCache(): void {
  for (const t of backdropCache.values()) t.destroy(true);
  backdropCache.clear();
}
