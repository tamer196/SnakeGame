/**
 * The hazard glow primitives - and why they are not the ones in `textures.ts`.
 *
 * `snake/core/obstacles.py` carries its own glow cache, separate from
 * `snake/gfx/render.py`'s, and the two are not the same shape. render.py bakes
 * its radial falloff into **RGB**, which is what `BLEND_RGB_ADD` reads, so its
 * glows are soft. obstacles.py bakes the identical ramp into **alpha** and
 * leaves RGB at full colour - and `BLEND_RGB_ADD` ignores source alpha
 * entirely. Every `_add_glow` in the hazard layer therefore paints a flat,
 * hard-edged, full-brightness additive disc. There is no gradient anywhere in
 * this file, and that is not an oversight: it is the entire look of the hazard
 * layer, verified pixel-by-pixel against pygame 2.6.1 (a wall interior reads as
 * exactly `background + theme.hazard`, clamped).
 *
 * What survives of `intensity` is the `if a <= 0: continue` gate, which culls
 * the outer rings whose alpha truncates to zero. So intensity picks the disc
 * **radius**, at unchanging brightness:
 *
 * ```
 * r     = int(clamp(radius, 2, 260))
 * steps = int(clamp(r * 0.6, 6, 20))
 * i_max = largest i in 1..steps with int(255 * intensity * (1 - i/steps)**1.9) >= 1
 * R_eff = max(1, int(r * i_max / steps))            (no qualifying i -> nothing)
 * ```
 *
 * Every call site in the shipped game, resolved (radius -> R_eff), so that the
 * next reader can see the animation really is this coarse and does not "fix" it:
 *
 * | call site                       | radius | intensity | R_eff |
 * |---------------------------------|--------|-----------|-------|
 * | spinner arm blob                | 16.5   | 0.24      | 12    |
 * | spinner tip node                | 24.2   | 0.60      | 22    |
 * | spinner hub, trough -> peak     | 33.8   | 0.30/0.44 | 29/29 |
 * | pulsar body, safe / live        | 57/95  | 0.34/0.68 | 51/85 |
 * | laser fire blob                 | 21.6   | 0.42      | 17    |
 * | laser charge blob, warn 0.5 / 1 | 10.8   | 0.09/0.18 | 6/8   |
 * | laser emitter, warn 0 -> 1      | 31.4   | 0.34/0.74 | 27/27 |
 * | portal halo, ready / cooldown   | 54.6   | 0.42/0.168| 48/45 |
 * | portal spark, ready / cooldown  | 7.0    | 0.50/0.20 | 5/5   |
 *
 * Only the laser's charge blob and the portal's cooldown dim move at all; the
 * rest are inert at the shipped numbers. The expressions are ported anyway -
 * they document intent and come alive if a level changes a radius - but nothing
 * here fakes an alpha pulse to make them visible.
 *
 * Pixi mapping: no texture at all. A hard-edged filled circle on a `Graphics`
 * with `blendMode = "add"` and alpha 1 composites as `src + dst`, which is
 * exactly what pygame's ADD blit did, and overlapping fills inside one Graphics
 * accumulate in path order - so `_glow_line`'s beading and saturation come out
 * for free. Positions stay float: the design space is scaled up on device, and
 * pygame's blit-corner truncation would show as multi-pixel jitter there. The
 * integer maths *inside* R_eff is a different thing and is kept exactly.
 */

import type { Graphics } from "pixi.js";

import { clamp } from "../../core/mathx";
import { clamp8, lerpColor, shade, toHex, type RGB } from "../../core/palette";

/** Pure white, as `obstacles.py` spells it. Not `UI_WHITE`, which is bluish. */
const WHITE: RGB = [255, 255, 255];

/** Spacing of glow blobs along a glowing line (`obstacles.GLOW_STEP_PX`). */
export const GLOW_STEP_PX = 9.0;

/**
 * `R_eff`: the radius of the flat additive disc `_add_glow` actually paints.
 *
 * Returns 0 when every ring's alpha truncates to zero, i.e. when pygame would
 * have drawn nothing at all.
 */
export function glowDiscRadius(radius: number, intensity: number): number {
  const r = Math.trunc(clamp(radius, 2.0, 260.0));
  const inten = clamp(intensity, 0.0, 2.0);
  const steps = Math.trunc(clamp(r * 0.6, 6, 20));
  for (let i = steps; i >= 1; i--) {
    const f = i / steps;
    if (clamp8(255.0 * inten * Math.pow(1.0 - f, 1.9)) <= 0) continue;
    return Math.max(1, Math.trunc(r * f));
  }
  return 0;
}

/**
 * `_add_glow` - one flat additive disc centred on (x, y).
 *
 * `g` must already have `blendMode = "add"`.
 */
export function addGlow(
  g: Graphics,
  x: number,
  y: number,
  radius: number,
  color: RGB,
  intensity = 1.0,
): void {
  const r = glowDiscRadius(radius, intensity);
  if (r <= 0) return;
  g.circle(x, y, r).fill({ color: toHex(color), alpha: 1 });
}

/**
 * `_glow_line` - `n + 1` discs stamped along a segment, both ends inclusive.
 *
 * The discs overlap and accumulate, which is the point: the result is a
 * saturating band of half-width `R_eff`, faintly beaded where the 9 px spacing
 * and the disc radius are close. Drawing one stroked capsule instead would
 * flatten exactly the texture this is here for.
 */
export function addGlowLine(
  g: Graphics,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  color: RGB,
  radius: number,
  intensity = 1.0,
  maxBlobs = 18,
): void {
  const r = glowDiscRadius(radius, intensity);
  if (r <= 0) return;
  const length = Math.hypot(bx - ax, by - ay);
  const n = Math.trunc(clamp(length / GLOW_STEP_PX, 1, maxBlobs)) + 1;
  const col = toHex(color);
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    g.circle(ax + (bx - ax) * f, ay + (by - ay) * f, r).fill({ color: col, alpha: 1 });
  }
}

/** The stadium `_slab_glow` paints, as an offset from the slab's top-left. */
export interface SlabGlowShape {
  /** Offset of the halo's left edge from the slab's left edge (negative). */
  readonly dx: number;
  /** Offset of the halo's top edge from the slab's top edge (negative). */
  readonly dy: number;
  readonly w: number;
  readonly h: number;
  /**
   * The ring the halo stopped at. Constant across a whole intensity bucket,
   * so a renderer can use it to decide whether a rebuild is needed at all.
   */
  readonly pad: number;
}

/**
 * The rectangular sibling of {@link glowDiscRadius}.
 *
 * The falloff distance is driven by the slab's **short** side, which is the
 * design intent worth keeping: a radial glow sized from the long side of a
 * 27 x 217 px wall becomes a 240 px disc that swallows the arena, whereas this
 * makes a long wall glow like a strip light. The border radius is half the
 * short side, so the halo is a stadium, not a rounded rect.
 */
export function slabGlowShape(
  w: number,
  h: number,
  intensity: number,
): SlabGlowShape | null {
  const iw = Math.max(2, Math.trunc(w));
  const ih = Math.max(2, Math.trunc(h));
  const radius = Math.trunc(clamp(Math.min(iw, ih) * 0.75 + 12.0, 14.0, 64.0));
  const inten = clamp(intensity, 0.0, 2.0);
  const steps = Math.trunc(clamp(radius * 0.6, 6, 18));
  for (let i = steps; i >= 1; i--) {
    const f = i / steps;
    if (clamp8(255.0 * inten * Math.pow(1.0 - f, 1.9)) <= 0) continue;
    const pad = radius * f;
    // The sprite is `radius` px larger than the slab on every side and the
    // stadium sits at `int(radius - pad)` inside it; both truncations are
    // pygame's, and they make the halo very slightly asymmetric.
    const off = Math.trunc(radius - pad) - radius;
    return {
      dx: off,
      dy: off,
      w: Math.trunc(iw + pad * 2),
      h: Math.trunc(ih + pad * 2),
      pad,
    };
  }
  return null;
}

/**
 * `_slab_glow` - one flat additive stadium around the slab at (x, y, w, h).
 *
 * `g` must already have `blendMode = "add"`.
 */
export function addSlabGlow(
  g: Graphics,
  x: number,
  y: number,
  w: number,
  h: number,
  color: RGB,
  intensity = 1.0,
): void {
  const s = slabGlowShape(w, h, intensity);
  if (s === null) return;
  g.roundRect(x + s.dx, y + s.dy, s.w, s.h, Math.trunc(Math.min(s.w, s.h) * 0.5))
    .fill({ color: toHex(color), alpha: 1 });
}

/**
 * `_neon_line` - three opaque strokes, dim and wide through hot and narrow.
 *
 * These are normal-blend and they overwrite, so a neon line **erases** any
 * additive glow already under it. Draw order against the glow layers is
 * load-bearing wherever this is used.
 *
 * `g` must be a normal-blend Graphics. Each stroke is its own subpath because
 * `pygame.draw.line` lays down a butt-ended quad with no caps or joins.
 */
export function neonLine(
  g: Graphics,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  color: RGB,
  width: number,
  core = 0.7,
): void {
  const w = Math.max(1, Math.trunc(width));
  g.moveTo(ax, ay).lineTo(bx, by).stroke({
    color: toHex(shade(color, 0.55)),
    width: w + 3,
    cap: "butt",
    alpha: 1,
  });
  g.moveTo(ax, ay).lineTo(bx, by).stroke({
    color: toHex(color),
    width: w,
    cap: "butt",
    alpha: 1,
  });
  if (w >= 3) {
    g.moveTo(ax, ay).lineTo(bx, by).stroke({
      color: toHex(lerpColor(color, WHITE, core)),
      width: Math.max(1, Math.floor(w / 3)),
      cap: "butt",
      alpha: 1,
    });
  }
}
