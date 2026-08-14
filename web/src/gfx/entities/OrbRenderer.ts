/**
 * Food orbs: `render.py::draw_food_orb` plus the animation states `food.py`
 * hands it.
 *
 * The three kinds share one anatomy - additive halo, a rotating ring of arc
 * segments, orbiting dots, a shaded spherical core, a catchlight and a
 * refraction sparkle - and are then pulled apart so they are tellable at a
 * glance: `normal` stays a smooth sphere, `bonus` gains a four-sided facet cage
 * and a 4-arm flare, `mega` a six-sided cage, a counter-rotating inner
 * triangle, a second orbit ring and a 6-arm flare.
 *
 * Everything positional comes out of the simulation, which already computes it:
 * the bob, the `easeOutBack` pop-in, the breathe, the last-second wither and
 * the accelerating end-of-life blink. The blink is a hard skip, not a fade -
 * an orb on an "off" frame is simply not drawn.
 *
 * Unlike the hazards, these glows are the **soft** ones from `textures.ts`,
 * because `draw_food_orb` calls render.py's glow cache. One deviation follows
 * from that: a mega orb's halo asks for intensity 1.125 at the top of its
 * pulse, and a tinted white texture can only reach 1.0, so the mega halo is up
 * to ~11% dimmer than Python's at the peak of the breath. Python got there by
 * saturating the baked RGB, which tint-times-alpha cannot express.
 */

import { Container, Graphics, Sprite } from "pixi.js";

import * as C from "../../core/config";
import { TAU, pulse } from "../../core/mathx";
import { hueShift, lerpColor, shade, toHex, type RGB } from "../../core/palette";
import { bobOffset, drawRadius, visible, type Food, type FoodField } from "../../core/food";
import { flareTexture, glowSprite, setGlow } from "../textures";
import type { FrameClocks } from "./clocks";

/** Pure white, as `render.py` spells it. Not `UI_WHITE`, which is bluish. */
const WHITE: RGB = [255, 255, 255];

type Kind = "normal" | "bonus" | "mega";

interface KindSpec {
  readonly scale: number;
  readonly glow: number;
  readonly dots: number;
  /** Arc count, sweep as a fraction of the gap, and spin rate. */
  readonly halo: readonly [number, number, number];
  /** Sides of the faceted overlay; 0 leaves a smooth sphere. */
  readonly facets: number;
  /** Orbit rings: radius multiple, spin rate, size weight. */
  readonly rings: ReadonlyArray<readonly [number, number, number]>;
  /** Arms on the kind flare; 0 means the orb has none. */
  readonly flareArms: number;
  /** Facet cage rotation rate. */
  readonly facetSpin: number;
}

const KINDS: Readonly<Record<Kind, KindSpec>> = {
  normal: {
    scale: 1.0,
    glow: 0.7,
    dots: 4,
    halo: [2, 0.42, 0.9],
    facets: 0,
    rings: [[1.95, 0.85, 1.0]],
    flareArms: 0,
    facetSpin: 0.0,
  },
  bonus: {
    scale: 1.16,
    glow: 0.95,
    dots: 6,
    halo: [3, 0.5, -1.15],
    facets: 4,
    rings: [[2.1, 1.1, 1.0]],
    flareArms: 4,
    facetSpin: 0.9,
  },
  mega: {
    scale: 1.38,
    glow: 1.25,
    dots: 8,
    halo: [4, 0.58, 1.45],
    facets: 6,
    rings: [
      [2.1, 1.25, 1.0],
      [2.7, -0.8, 0.72],
    ],
    flareArms: 6,
    facetSpin: 0.62,
  },
};

/** One orb's display objects, reused across orbs and across levels. */
class OrbView {
  readonly container = new Container();
  readonly halo: Sprite;
  readonly arcs = new Graphics();
  readonly dotGlowLayer = new Container();
  readonly body = new Graphics();
  readonly catchFlare: Sprite;
  readonly fringe = new Graphics();
  readonly kindFlare: Sprite;

  private readonly dotGlows: Sprite[] = [];

  constructor() {
    this.halo = glowSprite(1, WHITE, 0);
    this.catchFlare = new Sprite();
    this.catchFlare.anchor.set(0.5);
    this.catchFlare.blendMode = "add";
    this.kindFlare = new Sprite();
    this.kindFlare.anchor.set(0.5);
    this.kindFlare.blendMode = "add";
    this.container.addChild(
      this.halo,
      this.arcs,
      this.dotGlowLayer,
      this.body,
      this.catchFlare,
      this.fringe,
      this.kindFlare,
    );
  }

  /** A pooled additive dot glow; `finishDotGlows` hides the leftovers. */
  dotGlow(index: number): Sprite {
    let s = this.dotGlows[index];
    if (s === undefined) {
      s = glowSprite(1, WHITE, 0);
      this.dotGlows.push(s);
      this.dotGlowLayer.addChild(s);
    }
    s.visible = true;
    return s;
  }

  finishDotGlows(used: number): void {
    for (let i = used; i < this.dotGlows.length; i++) {
      const s = this.dotGlows[i];
      if (s !== undefined) s.visible = false;
    }
  }

  destroy(): void {
    this.container.destroy({ children: true });
  }
}

/**
 * Draws the orbs on the field.
 *
 * Add {@link OrbRenderer.container} to the masked world container, below the
 * runes. The pool grows to the busiest frame and is then reused.
 */
export class OrbRenderer {
  readonly container = new Container();

  private readonly views: OrbView[] = [];

  /** Repaint from the scene clock. Orbs are not on the hazard clock. */
  draw(field: FoodField, clocks: FrameClocks): void {
    const t = clocks.t;
    // A non-finite clock poisons vertices instead of throwing; hold the frame.
    if (!Number.isFinite(t)) return;
    const items = field.items;
    while (this.views.length < items.length) {
      const view = new OrbView();
      this.views.push(view);
      this.container.addChild(view.container);
    }
    for (let i = 0; i < this.views.length; i++) {
      const view = this.views[i];
      if (view === undefined) continue;
      const f = items[i];
      if (f === undefined || !visible(f, t)) {
        view.container.visible = false;
        continue;
      }
      view.container.visible = true;
      this.drawOrb(view, f, field.colorFor(f, t), t);
    }
  }

  /** Drop the pool. Shared glow and flare textures survive. */
  destroy(): void {
    for (const view of this.views) view.destroy();
    this.views.length = 0;
    this.container.destroy({ children: true });
  }

  private drawOrb(view: OrbView, f: Food, col: RGB, t: number): void {
    const spec = KINDS[f.kind];
    // `drawPos` would allocate a point per orb per frame; the bob is vertical
    // only, so the two components are read straight off the simulation.
    const x = f.x;
    const y = f.y + bobOffset(f, t);
    const p = pulse(t, C.FOOD_PULSE_SPEED);
    const rr = Math.max(2.0, drawRadius(f, t) * spec.scale * (0.94 + 0.1 * p));

    setGlow(view.halo, rr * (2.9 + 0.6 * p), col, spec.glow * (0.55 + 0.35 * p));
    view.halo.position.set(x, y);

    // Rotating arc ring, just outside the core. `pygame.draw.arc` is y-up, so
    // both angles are negated to keep the spin signs pointing the same way on
    // screen; the radius is pulled in by half the stroke because pygame strokes
    // an arc inward from its bounding box.
    const arcs = view.arcs;
    arcs.clear();
    const ri = Math.trunc(rr * (1.62 + 0.1 * p));
    if (ri >= 3) {
      const count = spec.halo[0];
      const sweep = spec.halo[1];
      const spin = spec.halo[2];
      const w = f.kind === "normal" ? 2 : 3;
      const ar = Math.max(0.5, ri - w * 0.5);
      const ringCol = toHex(lerpColor(col, WHITE, 0.3 + 0.25 * p));
      const gap = TAU / count;
      const span = gap * sweep;
      for (let k = 0; k < count; k++) {
        const a0 = t * spin + k * gap;
        const sa = -(a0 + span);
        arcs
          .moveTo(x + Math.cos(sa) * ar, y + Math.sin(sa) * ar)
          .arc(x, y, ar, sa, -a0)
          .stroke({ color: ringCol, width: w, cap: "butt" });
      }
    }

    const body = view.body;
    body.clear();

    // Orbital dots. Their glows are hoisted above the arcs and below every
    // disc; Python interleaves glow and disc per dot, but the discs are 2-3 px
    // and never sit inside a neighbour's glow in a way that reads.
    const dotCol = toHex(lerpColor(col, WHITE, 0.45));
    let glowIdx = 0;
    for (const ring of spec.rings) {
      const orbit = ring[0];
      const dspin = ring[1];
      const weight = ring[2];
      const dr = Math.max(1, Math.trunc(rr * 0.17 * weight));
      for (let i = 0; i < spec.dots; i++) {
        const ang = t * dspin + (i * TAU) / spec.dots;
        const dx = x + Math.cos(ang) * rr * orbit;
        const dy = y + Math.sin(ang) * rr * orbit;
        if (f.kind !== "normal") {
          const g = view.dotGlow(glowIdx++);
          setGlow(g, rr * 0.75 * weight, col, 0.55);
          g.position.set(dx, dy);
        }
        body.circle(dx, dy, dr).fill({ color: dotCol, alpha: 1 });
      }
    }
    view.finishDotGlows(glowIdx);

    // Core: dark rim -> body colour -> hot centre, then a bright keyline.
    body.circle(x, y, Math.max(1, Math.trunc(rr))).fill({
      color: toHex(shade(col, 0.5)),
      alpha: 1,
    });
    body.circle(x, y, Math.max(1, Math.trunc(rr * 0.8))).fill({
      color: toHex(col),
      alpha: 1,
    });
    body.circle(x, y, Math.max(1, Math.trunc(rr * 0.44))).fill({
      color: toHex(lerpColor(col, WHITE, 0.55)),
      alpha: 1,
    });
    body.circle(x, y, Math.max(1, Math.trunc(rr))).stroke({
      color: toHex(lerpColor(col, WHITE, 0.35)),
      width: 2,
      alignment: 1,
    });

    // The facet cage is what makes bonus and mega read as cut gems.
    if (spec.facets >= 3 && rr >= 5.0) {
      const rot = t * spec.facetSpin;
      const poly: number[] = [];
      for (let i = 0; i < spec.facets; i++) {
        const a = rot + (i * TAU) / spec.facets;
        poly.push(x + Math.cos(a) * rr * 0.94, y + Math.sin(a) * rr * 0.94);
      }
      body.poly(poly, true).stroke({
        color: toHex(lerpColor(col, WHITE, 0.6)),
        width: 2,
      });
      if (f.kind === "mega") {
        const rot2 = -t * 1.05;
        const tri: number[] = [];
        for (let i = 0; i < 3; i++) {
          const a = rot2 + (i * TAU) / 3.0;
          tri.push(x + Math.cos(a) * rr * 0.52, y + Math.sin(a) * rr * 0.52);
        }
        body.poly(tri, true).stroke({
          color: toHex(lerpColor(col, WHITE, 0.8)),
          width: 1,
        });
      }
    }

    // An off-centre catchlight sells the orb as a sphere; the star flare and
    // the cool/warm fringe pair riding on it sell it as glass.
    const hx = x - rr * 0.3;
    const hy = y - rr * 0.32;
    body.circle(hx, hy, Math.max(1, Math.trunc(rr * 0.2))).fill({
      color: 0xffffff,
      alpha: 1,
    });

    const catchR = rr * (0.85 + 0.15 * p);
    const catchTex = flareTexture(catchR, 4);
    if (view.catchFlare.texture !== catchTex) view.catchFlare.texture = catchTex;
    view.catchFlare.width = catchR * 2;
    view.catchFlare.height = catchR * 2;
    view.catchFlare.tint = 0xffffff;
    view.catchFlare.position.set(hx, hy);

    const fringe = view.fringe;
    fringe.clear();
    if (rr >= 6.0) {
      const fr = Math.max(1, Math.trunc(rr * 0.1));
      fringe.circle(hx + rr * 0.26, hy + rr * 0.1, fr).fill({
        color: toHex(hueShift(col, 0.08)),
        alpha: 1,
      });
      fringe.circle(hx - rr * 0.18, hy + rr * 0.22, fr).fill({
        color: toHex(hueShift(col, -0.08)),
        alpha: 1,
      });
    }

    if (spec.flareArms > 0) {
      const kr = rr * (2.4 + 0.5 * p);
      const tex = flareTexture(kr, spec.flareArms);
      if (view.kindFlare.texture !== tex) view.kindFlare.texture = tex;
      view.kindFlare.width = kr * 2;
      view.kindFlare.height = kr * 2;
      view.kindFlare.tint = toHex(lerpColor(col, WHITE, 0.35));
      view.kindFlare.position.set(x, y);
      view.kindFlare.visible = true;
    } else {
      view.kindFlare.visible = false;
    }
  }
}
