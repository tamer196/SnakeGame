/**
 * Retained-mode decorations for the result screens - ports of `_star_points`,
 * `_draw_star` and `_draw_badge` (`snake/scenes/gameover.py:153-216`).
 *
 * Python redraws these per frame; here each is a small display object built
 * once, and the animation is a transform plus a couple of alpha writes. The
 * glow primitive is `gfx/textures.ts::haloSprite` - `render.py::_build_glow`'s
 * `u^2(0.35 + 0.65u)` falloff - because gameover.py imports `draw_glow_circle`
 * from `gfx.render`. Neither the backgrounds' radial (`radialTexture`) nor the
 * UI kit's `_glow_add` curve (`ui/glow.ts`) is the same shape; substituting
 * either reads several times too hot behind the headings.
 */

import { Container, Graphics, type Sprite } from "pixi.js";

import { TAU } from "../../core/mathx";
import { UI_GOLD, UI_WHITE, lerpColor, shade, toHex, type RGB } from "../../core/palette";
import type { FontBook } from "../../gfx/fonts";
import { haloSprite, setHalo } from "../../gfx/textures";
import { Label } from "../../ui/text";

/** The earned star's radius; the outline draws at 0.86 of it. gameover.py:1169 */
export const STAR_RADIUS = 40.0;

/**
 * The ten vertices of a five-pointed star, outer point up at `rot = 0`,
 * flattened for `Graphics.poly`. Float coordinates: the Python truncates each
 * vertex to int, but a truncated tip wobbles visibly during the pop once the
 * design space is scaled up on device (settled in gfx-port-decisions).
 */
export function starPoints(cx: number, cy: number, radius: number, rot = 0): number[] {
  const inner = radius * 0.44;
  const pts: number[] = [];
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? radius : inner;
    const ang = -Math.PI * 0.5 + rot + i * (TAU / 10);
    pts.push(cx + Math.cos(ang) * r, cy + Math.sin(ang) * r);
  }
  return pts;
}

/**
 * One rating slot on the victory screen: a dim outline until the star pops,
 * then a gold fill whose pop is `scale`/`rotation` on a container built once.
 *
 * The glow sprites live *inside* the scaled container, so their radius tracks
 * the star exactly as Python's `radius * 1.9` does. The rim stroke scales too,
 * a continuous line where Python's `max(1, int(r*0.10))` is a staircase - the
 * accepted divergence recorded in scenes.md §6.2.8.
 */
export class StarSlot extends Container {
  private readonly outline = new Graphics();
  private readonly earned = new Container();
  private readonly glowLo: Sprite;
  private readonly glowHi: Sprite;

  constructor() {
    super();
    // Outline geometry never changes; the colour is a per-entry tint.
    const oPts = starPoints(0, 0, STAR_RADIUS * 0.86, 0);
    this.outline.poly(oPts).stroke({ width: 3, color: 0xffffff });

    // Two stacked additive glows: the pop's opening flash peaks at 1.43, which
    // is more than one clamped sprite can say (scenes.md §6.2.6).
    this.glowLo = haloSprite(STAR_RADIUS * 1.9, UI_GOLD, 0);
    this.glowHi = haloSprite(STAR_RADIUS * 1.9, UI_GOLD, 0);

    const fill = new Graphics();
    const pts = starPoints(0, 0, STAR_RADIUS, 0);
    fill
      .poly(pts)
      .fill(toHex(UI_GOLD))
      .poly(pts)
      .stroke({ width: 4, color: toHex(lerpColor(UI_GOLD, UI_WHITE, 0.55)) });

    this.earned.addChild(this.glowLo, this.glowHi, fill);
    this.addChild(this.outline, this.earned);
    this.showOutline();
  }

  /** Python draws the empty slot in `shade(theme.text_dim, 0.85)`. */
  setOutlineColor(color: RGB): void {
    this.outline.tint = toHex(shade(color, 0.85));
  }

  showOutline(): void {
    this.outline.visible = true;
    this.earned.visible = false;
  }

  showEarned(scale: number, spin: number, glow: number): void {
    this.outline.visible = false;
    this.earned.visible = true;
    this.earned.scale.set(scale);
    this.earned.rotation = spin;
    this.glowLo.alpha = Math.max(0, Math.min(1, glow));
    this.glowLo.visible = glow > 0.01;
    this.glowHi.alpha = Math.max(0, Math.min(1, glow - 1));
    this.glowHi.visible = glow > 1;
  }
}

/**
 * The difficulty chip both result screens carry under their title - a rounded
 * capsule, not a `Panel` (whose corner is the fixed `UI_CORNER`; this radius
 * is `h // 2`). Centre it with `position.set(cx, cy)`.
 *
 * The geometry depends on the measured label - `w = trunc(textW) + 40`,
 * `h = trunc(textH) + 12`, text top at `-h/2 + 6` - so it is rebuilt per entry
 * by `set()`, never per frame (the glow is 0.16 or 0.34, never animated).
 */
export class Badge extends Container {
  private readonly glow: Sprite;
  private readonly chip = new Graphics();
  private readonly caption: Label;

  constructor(fonts: FontBook) {
    super();
    this.glow = haloSprite(30, UI_WHITE, 0);
    this.caption = new Label(fonts, fonts.small);
    this.caption.setShadow(false);
    this.addChild(this.glow, this.chip, this.caption);
  }

  set(text: string, color: RGB, glow = 0.3): void {
    const upper = String(text).toUpperCase();
    this.caption.set(upper);
    this.caption.setColor(lerpColor(color, UI_WHITE, 0.6));
    this.caption.setShadow(false);

    const w = Math.trunc(this.caption.textWidth) + 40;
    const h = Math.trunc(this.caption.textHeight) + 12;
    const radius = Math.trunc(h / 2);

    if (glow > 0.01) {
      this.glow.visible = true;
      setHalo(this.glow, w * 0.52, color, glow);
    } else {
      this.glow.visible = false;
    }

    this.chip.clear();
    this.chip
      .roundRect(-w * 0.5, -h * 0.5, w, h, radius)
      .fill({ color: toHex(shade(color, 0.26)), alpha: 214 / 255 })
      .roundRect(-w * 0.5, -h * 0.5, w, h, radius)
      .stroke({ width: 2, color: toHex(color), alpha: 235 / 255 });

    this.caption.place(0, -h * 0.5 + 6, "center");
  }
}
