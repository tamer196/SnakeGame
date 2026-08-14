/**
 * The six arena hazards, drawn from `snake/core/obstacles.py`.
 *
 * Every hazard owns a `Container` built once at level load. What happens per
 * frame is deliberately uneven, because the originals are: a wall only changes
 * the colour of one rectangle, a moving bar is a pure translation, and a
 * spinner, pulsar, laser or portal has continuous geometry and rebuilds its
 * `Graphics`. Anything that can be a tint or an `.x/.y` write is one.
 *
 * Three things about this layer are load-bearing and easy to lose:
 *
 * 1. **The glows are flat.** See `hazardGlow.ts`. Nothing here uses the soft
 *    radial texture from `textures.ts`; hazards and runes genuinely do use two
 *    different glow systems, and both ship.
 * 2. **Portals go under everything.** `draw_obstacles` makes two passes over
 *    the list, portals first, so a wall that overlaps a portal covers it.
 *    {@link hazardLayerOrder} is that pass, and the renderer keeps two child
 *    containers so the ordering survives per-hazard rebuilds.
 * 3. **The clock is `hazardT`, never the scene clock.** Difficulty scales the
 *    hazard clock, and a hazard's animation has to stay welded to its motion.
 *    `Obstacle.t` is the *last update* time and is never read here.
 *
 * Clipping is not done per hazard. Python sets a clip rect around each one, but
 * all three clip rects in gameplay are the arena rect, so one mask on the
 * shared world container is provably identical and costs one stencil op
 * instead of twenty.
 */

import { Container, Graphics, Sprite } from "pixi.js";

import {
  LaserGate,
  MovingBar,
  Portal,
  Pulsar,
  Spinner,
  WallBlock,
  type Obstacle,
} from "../../core/obstacles";
import { TAU, clamp, lerp, pulse } from "../../core/mathx";
import { lerpColor, shade, toHex, type RGB, type Theme } from "../../core/palette";
import type { FrameClocks } from "./clocks";
import {
  addGlow,
  addGlowLine,
  addSlabGlow,
  glowDiscRadius,
  neonLine,
  slabGlowShape,
} from "./hazardGlow";
import { hazardSlabTexture } from "./hazardSlab";

/** Pure white, as `obstacles.py` spells it. Not `UI_WHITE`, which is bluish. */
const WHITE: RGB = [255, 255, 255];

/** One warning per session is enough; see {@link SpinnerView}. */
let spinnerOrderWarned = false;

/**
 * Every obstacle exactly once, portals first - the port of `draw_obstacles`'s
 * two passes. Within each pass the declaration order is kept.
 */
export function hazardLayerOrder(obstacles: readonly Obstacle[]): Obstacle[] {
  const out: Obstacle[] = [];
  for (const ob of obstacles) if (ob instanceof Portal) out.push(ob);
  for (const ob of obstacles) if (!(ob instanceof Portal)) out.push(ob);
  return out;
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

abstract class HazardView {
  readonly container = new Container();

  /** Repaint for the hazard clock. Never called with the scene clock. */
  abstract draw(hazardT: number): void;

  destroy(): void {
    this.container.destroy({ children: true });
  }
}

// -- WallBlock ---------------------------------------------------------------

class WallView extends HazardView {
  private readonly ob: WallBlock;
  private readonly theme: Theme;
  private readonly edge = new Graphics();
  private readonly halo = new Graphics();
  private haloPad = -1;

  constructor(ob: WallBlock, theme: Theme) {
    super();
    this.ob = ob;
    this.theme = theme;

    const bx = Math.trunc(ob.x);
    const by = Math.trunc(ob.y);
    const bw = Math.trunc(ob.w);
    const bh = Math.trunc(ob.h);

    const slab = new Sprite(hazardSlabTexture(bw, bh, theme.hazard, theme.hazard));
    slab.position.set(ob.x, ob.y);

    // The edge rect is stroked white and tinted per frame. Tint multiplies, so
    // white * tint is the colour exactly - a rebuild would buy nothing.
    this.edge.rect(bx, by, bw, bh).stroke({ color: 0xffffff, width: 2, alignment: 1 });

    // Corner brackets: static, and the reason a wall reads as engineered
    // rather than as a grey box.
    const brackets = new Graphics();
    const c = Math.trunc(clamp(Math.min(ob.w, ob.h) * 0.28, 5.0, 18.0));
    const x1 = Math.trunc(ob.x + ob.w);
    const y1 = Math.trunc(ob.y + ob.h);
    const accent2 = toHex(theme.accent2);
    for (let i = 0; i < 4; i++) {
      const px = i === 1 || i === 3 ? x1 : bx;
      const py = i >= 2 ? y1 : by;
      const dx = i === 1 || i === 3 ? -c : c;
      const dy = i >= 2 ? -c : c;
      brackets
        .moveTo(px, py)
        .lineTo(px + dx, py)
        .stroke({ color: accent2, width: 2, cap: "butt" });
      brackets
        .moveTo(px, py)
        .lineTo(px, py + dy)
        .stroke({ color: accent2, width: 2, cap: "butt" });
    }

    this.halo.blendMode = "add";
    this.container.addChild(slab, this.edge, brackets, this.halo);
  }

  override draw(hazardT: number): void {
    const ob = this.ob;
    // The spatial term is not decoration: 0.013 * 1.7 rad/px puts a full cycle
    // every 284 px, so a row of walls shimmers as a wave travelling right.
    const glow = 0.35 + 0.35 * pulse(hazardT + ob.x * 0.013, 1.7);
    this.edge.tint = toHex(lerpColor(this.theme.hazard, WHITE, glow * 0.45));

    const inten = 0.2 + glow * 0.16;
    const shape = slabGlowShape(ob.w, ob.h, inten);
    const pad = shape === null ? -1 : shape.pad;
    // Over the shipped 0.256..0.312 intensity swing this never changes, which
    // matches Python: its slab-glow cache buckets intensity to eighths, so the
    // wall's halo is one sprite for the whole level.
    if (pad !== this.haloPad) {
      this.haloPad = pad;
      this.halo.clear();
      addSlabGlow(this.halo, ob.x, ob.y, ob.w, ob.h, this.theme.hazard, inten);
    }
  }
}

// -- MovingBar ---------------------------------------------------------------

class BarView extends HazardView {
  private readonly ob: MovingBar;
  private readonly theme: Theme;
  private readonly body = new Container();
  private readonly smear = new Graphics();
  private readonly border = new Graphics();
  private readonly chevrons = new Graphics();
  private lastDir = 0;

  constructor(ob: MovingBar, theme: Theme) {
    super();
    this.ob = ob;
    this.theme = theme;

    // Rail: the whole corridor, in world space, so the sweep is readable
    // before the bar arrives.
    const rail = new Graphics();
    const sp = ob.span();
    const railCol = toHex(shade(theme.grid, 1.25));
    if (ob.axis === "x") {
      const ry = sp.y + Math.floor(sp.h / 2);
      rail.moveTo(sp.x, ry).lineTo(sp.x + sp.w, ry);
    } else {
      const rx = sp.x + Math.floor(sp.w / 2);
      rail.moveTo(rx, sp.y).lineTo(rx, sp.y + sp.h);
    }
    rail.stroke({ color: railCol, width: 2, cap: "butt" });

    const bw = Math.trunc(ob.w);
    const bh = Math.trunc(ob.h);
    // Note the edge colour: bars key their slab to accent2, walls to hazard.
    const slab = new Sprite(hazardSlabTexture(bw, bh, theme.hazard, theme.accent2));

    this.smear.blendMode = "add";
    this.border.rect(0, 0, bw, bh).stroke({ color: 0xffffff, width: 2, alignment: 1 });

    const halo = new Graphics();
    halo.blendMode = "add";
    addSlabGlow(halo, 0, 0, ob.w, ob.h, theme.hazard, 0.22);

    this.body.addChild(this.smear, slab, this.border, this.chevrons, halo);
    this.container.addChild(rail, this.body);
  }

  override draw(hazardT: number): void {
    const ob = this.ob;
    this.body.position.set(ob.x, ob.y);
    this.border.tint = toHex(
      lerpColor(this.theme.accent2, WHITE, 0.25 + 0.3 * pulse(hazardT, 3.1)),
    );
    // Everything else is a function of the travel direction, which only flips
    // at the far end of a run - the moment the eased motion is stationary and
    // the player is looking for the tell.
    if (ob.dir !== this.lastDir) {
      this.lastDir = ob.dir;
      this.rebuildDirectional();
    }
  }

  private rebuildDirectional(): void {
    const ob = this.ob;
    const back = -ob.dir;
    const horizontal = ob.axis === "x";

    // Three nested stadium halos stepping back 7, 14, 21 px, each one larger
    // and weaker than the last: far-to-near, so the faintest is furthest out.
    this.smear.clear();
    for (let i = 3; i >= 1; i--) {
      const off = back * i * 7.0;
      addSlabGlow(
        this.smear,
        horizontal ? off : 0,
        horizontal ? 0 : off,
        ob.w,
        ob.h,
        this.theme.accent2,
        0.1 / i,
      );
    }

    this.chevrons.clear();
    const cx = ob.w * 0.5;
    const cy = ob.h * 0.5;
    const k = clamp(Math.min(ob.w, ob.h) * 0.3, 4.0, 10.0);
    const col = toHex(shade(this.theme.accent2, 1.2));
    for (let s = -1; s <= 1; s += 2) {
      // `draw.lines` lays each segment down as its own quad, so the apex is
      // notched rather than mitred; emitting two subpaths keeps that.
      if (horizontal) {
        const ox = cx + s * k * 1.6;
        const tipx = ox + ob.dir * k;
        this.chevrons.moveTo(ox, cy - k).lineTo(tipx, cy);
        this.chevrons.moveTo(tipx, cy).lineTo(ox, cy + k);
      } else {
        const oy = cy + s * k * 1.6;
        const tipy = oy + ob.dir * k;
        this.chevrons.moveTo(cx - k, oy).lineTo(cx, tipy);
        this.chevrons.moveTo(cx, tipy).lineTo(cx + k, oy);
      }
      this.chevrons.stroke({ color: col, width: 2, cap: "butt" });
    }
  }
}

// -- Spinner -----------------------------------------------------------------

class SpinnerView extends HazardView {
  private readonly ob: Spinner;
  private readonly theme: Theme;
  private readonly chainGlow = new Graphics();
  private readonly solid = new Graphics();
  private readonly overGlow = new Graphics();

  constructor(ob: Spinner, theme: Theme) {
    super();
    this.ob = ob;
    this.theme = theme;
    this.chainGlow.blendMode = "add";
    this.overGlow.blendMode = "add";
    // Python interleaves per arm: line, tip glow, tip disc, next line. Tip
    // glows sit *above* their own arm's neon line and that is most of what
    // makes a tip look hot, so they are hoisted above all the opaque geometry
    // rather than below it. The only pairs that then differ are a tip glow
    // over another arm's line - impossible while
    // `tipGlowR_eff < 2 * length * sin(pi / arms)`, which the shipped content
    // clears by a factor of six - and a tip glow over its own 7 px tip disc.
    this.container.addChild(this.chainGlow, this.solid, this.overGlow);

    if (!spinnerOrderWarned && ob.arms >= 2) {
      const chord = 2 * ob.length * Math.sin(Math.PI / ob.arms);
      if (glowDiscRadius(ob.thickness * 2.2, 0.6) >= chord) {
        spinnerOrderWarned = true;
        console.warn(
          "gfx/entities: a spinner's tip glow now reaches a neighbouring arm, " +
            "so hoisting the tip glows above the neon lines is no longer " +
            "equivalent. Give each arm its own glow/solid pair.",
        );
      }
    }
  }

  override draw(hazardT: number): void {
    const ob = this.ob;
    const theme = this.theme;
    const chain = this.chainGlow;
    const solid = this.solid;
    const over = this.overGlow;
    chain.clear();
    solid.clear();
    over.clear();

    const tipCol = toHex(lerpColor(theme.hazard, WHITE, 0.4));
    const tipR = Math.trunc(ob.thickness * 0.72);

    // Tips are recomputed rather than taken from `ob.tips()`, which allocates
    // an array of tuples every frame for every spinner.
    for (let i = 0; i < ob.arms; i++) {
      const a = ob.angle + (i * TAU) / ob.arms;
      const tx = ob.cx + Math.cos(a) * ob.length;
      const ty = ob.cy + Math.sin(a) * ob.length;
      addGlowLine(chain, ob.cx, ob.cy, tx, ty, theme.hazard, ob.thickness * 1.5, 0.24, 12);
      neonLine(solid, ob.cx, ob.cy, tx, ty, theme.hazard, ob.thickness, 0.55);
      solid.circle(tx, ty, tipR).fill({ color: tipCol, alpha: 1 });
      addGlow(over, tx, ty, ob.thickness * 2.2, theme.accent2, 0.6);
    }

    const hr = ob.hubRadius;
    solid
      .circle(ob.cx, ob.cy, Math.trunc(hr))
      .fill({ color: toHex(shade(theme.hazard, 0.4)), alpha: 1 });
    solid
      .circle(ob.cx, ob.cy, Math.trunc(hr))
      .stroke({ color: toHex(theme.accent), width: 2, alignment: 1 });

    // The inner triangle turns backwards at 1.7x the arms: the spin-direction
    // tell, and unmistakable even when the arms are near-symmetric.
    const tri: number[] = [];
    for (let i = 0; i < 3; i++) {
      const a = -ob.angle * 1.7 + (i * TAU) / 3.0;
      tri.push(ob.cx + Math.cos(a) * hr * 0.55, ob.cy + Math.sin(a) * hr * 0.55);
    }
    solid.poly(tri, true).fill({ color: toHex(theme.accent2), alpha: 1 });

    addGlow(over, ob.cx, ob.cy, hr * 2.6, theme.accent, 0.3 + 0.14 * pulse(hazardT, 4.0));
  }
}

// -- Pulsar ------------------------------------------------------------------

/** Slots on the threshold ring; only the even ones are drawn, so 11 dashes. */
const PULSAR_DASHES = 22;

class PulsarView extends HazardView {
  private readonly ob: Pulsar;
  private readonly theme: Theme;
  private readonly telegraph = new Graphics();
  private readonly bodyGlow = new Graphics();
  private readonly body = new Graphics();

  constructor(ob: Pulsar, theme: Theme) {
    super();
    this.ob = ob;
    this.theme = theme;
    this.bodyGlow.blendMode = "add";
    this.container.addChild(this.telegraph, this.bodyGlow, this.body);
  }

  override draw(hazardT: number): void {
    const ob = this.ob;
    const theme = this.theme;
    const tel = this.telegraph;
    const body = this.body;
    tel.clear();
    this.bodyGlow.clear();
    body.clear();

    const live = ob.deadly;
    // Two independent signals: the body colour slides accent -> hazard with
    // charge, the threshold ring flips at the arming instant.
    const col = lerpColor(theme.accent, theme.hazard, ob.charge);
    const th = ob.threshold;
    const ring = toHex(live ? theme.hazard : shade(theme.hazard, 0.7));

    // Dashes are straight chords, not arcs, and the train rotates at 0.5 rad/s.
    for (let i = 0; i < PULSAR_DASHES; i++) {
      if (i % 2) continue;
      const a0 = (i * TAU) / PULSAR_DASHES + hazardT * 0.5;
      const a1 = a0 + ((TAU / PULSAR_DASHES) * 0.9);
      tel
        .moveTo(ob.cx + Math.cos(a0) * th, ob.cy + Math.sin(a0) * th)
        .lineTo(ob.cx + Math.cos(a1) * th, ob.cy + Math.sin(a1) * th)
        .stroke({ color: ring, width: 2, cap: "butt" });
    }

    // The fair-warning window is ~0.21 s at the shipped periods, and this ring
    // has to close over exactly that time: it lands on the threshold at the
    // instant the pulsar arms. It fires on the way out too, as the mirror.
    if (!live && ob.charge > 0.55) {
      const warn = (ob.charge - 0.55) / 0.45;
      const wr = lerp(th * 1.9, th, warn);
      tel
        .circle(ob.cx, ob.cy, Math.trunc(Math.max(2.0, wr)))
        .stroke({
          color: toHex(lerpColor(theme.accent, theme.hazard, warn)),
          width: 2,
          alignment: 1,
        });
    }

    addGlow(this.bodyGlow, ob.cx, ob.cy, ob.radius * 1.9, col, 0.34 + (live ? 0.34 : 0.0));

    const r = Math.trunc(ob.radius);
    body.circle(ob.cx, ob.cy, r).fill({ color: toHex(shade(col, 0.45)), alpha: 1 });
    body.circle(ob.cx, ob.cy, r).stroke({ color: toHex(col), width: 3, alignment: 1 });
    const core = lerpColor(col, WHITE, live ? 0.55 : 0.25);
    body
      .circle(
        ob.cx,
        ob.cy,
        Math.trunc(Math.max(2.0, ob.radius * (0.3 + 0.12 * pulse(hazardT, 7.0)))),
      )
      .fill({ color: toHex(core), alpha: 1 });

    if (live) {
      // Spikes appear and vanish instantly with `deadly` - the crispest of the
      // three arming signals.
      const hot = toHex(theme.hazard);
      for (let i = 0; i < 8; i++) {
        const a = hazardT * 2.2 + (i * TAU) / 8.0;
        const c = Math.cos(a);
        const s = Math.sin(a);
        body
          .moveTo(ob.cx + c * ob.radius * 0.92, ob.cy + s * ob.radius * 0.92)
          .lineTo(ob.cx + c * ob.radius * 1.28, ob.cy + s * ob.radius * 1.28)
          .stroke({ color: hot, width: 2, cap: "butt" });
      }
    }
  }
}

// -- LaserGate ---------------------------------------------------------------

/** Dash slots along a charging beam. Each dash covers 72% of its slot. */
const LASER_DASHES = 26;

class LaserView extends HazardView {
  private readonly ob: LaserGate;
  private readonly theme: Theme;
  private readonly beamGlow = new Graphics();
  private readonly beam = new Graphics();
  private readonly emitterGlow = new Graphics();
  private readonly emitters = new Graphics();

  constructor(ob: LaserGate, theme: Theme) {
    super();
    this.ob = ob;
    this.theme = theme;
    this.beamGlow.blendMode = "add";
    this.emitterGlow.blendMode = "add";
    this.container.addChild(this.beamGlow, this.beam, this.emitterGlow, this.emitters);
  }

  override draw(hazardT: number): void {
    const ob = this.ob;
    const theme = this.theme;
    const glow = this.beamGlow;
    const beam = this.beam;
    glow.clear();
    beam.clear();
    this.emitterGlow.clear();
    this.emitters.clear();

    const hot = theme.hazard;
    const cold = theme.accent;

    if (ob.firing) {
      const flick = 0.86 + 0.14 * Math.sin(hazardT * 57.0);
      // `flick` modulates only the drawn width. `collides` always uses the
      // full `width * 0.5`, so at the trough the beam looks up to 14%
      // narrower than it kills. Faithful, and not to be "fixed" here - the
      // fix belongs in the simulation or nowhere.
      const w = ob.width * flick;
      addGlowLine(glow, ob.x1, ob.y1, ob.x2, ob.y2, hot, w * 2.4, 0.42, 26);
      neonLine(beam, ob.x1, ob.y1, ob.x2, ob.y2, hot, w, 0.85);
      beam
        .moveTo(ob.x1, ob.y1)
        .lineTo(ob.x2, ob.y2)
        .stroke({ color: 0xffffff, width: Math.max(1, Math.trunc(w * 0.25)), cap: "butt" });
    } else {
      const col = toHex(lerpColor(shade(cold, 0.8), hot, ob.warn));
      const width = 1 + Math.trunc(ob.warn * 2.0);
      const dx = ob.x2 - ob.x1;
      const dy = ob.y2 - ob.y1;
      // The parity flips 12 times a second, so the dash train appears to jump
      // one slot back and forth: a nervous flicker, not a march.
      const parity = Math.trunc(hazardT * 12.0);
      for (let i = 0; i < LASER_DASHES; i++) {
        if ((i + parity) % 2) continue;
        const f0 = i / LASER_DASHES;
        const f1 = (i + 0.72) / LASER_DASHES;
        beam
          .moveTo(ob.x1 + dx * f0, ob.y1 + dy * f0)
          .lineTo(ob.x1 + dx * f1, ob.y1 + dy * f1)
          .stroke({ color: col, width, cap: "butt" });
      }
      if (ob.warn > 0.01) {
        // One of only two places in the hazard layer where the intensity
        // animation is visible: this aura really does grow with the warning.
        addGlowLine(glow, ob.x1, ob.y1, ob.x2, ob.y2, hot, ob.width * 1.2, 0.18 * ob.warn, 16);
      }
    }

    const er = ob.width * 0.9 + 5.0;
    const housing = toHex(shade(theme.hazard, 0.35));
    const rim = toHex(ob.firing ? hot : cold);
    const iris = toHex(lerpColor(cold, WHITE, ob.warn));
    const irisR = Math.trunc(Math.max(1.0, er * (0.25 + 0.45 * ob.warn)));
    for (let e = 0; e < 2; e++) {
      const ex = e === 0 ? ob.x1 : ob.x2;
      const ey = e === 0 ? ob.y1 : ob.y2;
      addGlow(this.emitterGlow, ex, ey, er * 2.4, ob.firing ? hot : cold, 0.34 + 0.4 * ob.warn);
      this.emitters.circle(ex, ey, Math.trunc(er)).fill({ color: housing, alpha: 1 });
      this.emitters
        .circle(ex, ey, Math.trunc(er))
        .stroke({ color: rim, width: 2, alignment: 1 });
      // The iris is the clearest countdown in the game: it opens from 0.25 to
      // 0.70 of the housing and whitens as it goes, then snaps shut.
      this.emitters.circle(ex, ey, irisR).fill({ color: iris, alpha: 1 });
    }
  }
}

// -- Portal ------------------------------------------------------------------

class PortalView extends HazardView {
  private readonly ob: Portal;
  private readonly theme: Theme;
  private readonly halo = new Graphics();
  private readonly back = new Graphics();
  private readonly sparks = new Graphics();
  private readonly core = new Graphics();

  constructor(ob: Portal, theme: Theme) {
    super();
    this.ob = ob;
    this.theme = theme;
    this.halo.blendMode = "add";
    this.sparks.blendMode = "add";
    this.container.addChild(this.halo, this.back, this.sparks, this.core);
  }

  override draw(hazardT: number): void {
    const ob = this.ob;
    const theme = this.theme;
    this.halo.clear();
    this.back.clear();
    this.sparks.clear();
    this.core.clear();

    // The A end wears `accent`, the B end `accent2`: the player's only cue for
    // which mouth they will come out of.
    const base = ob.secondary ? theme.accent2 : theme.accent;
    const r = ob.radius;
    const dim = ob.cooldown <= 0.0 ? 1.0 : 0.4;

    // The other visible intensity animation: a sleeping portal's halo is
    // measurably smaller, which together with the dimmed rim reads as "asleep".
    addGlow(this.halo, ob.x, ob.y, r * 2.1, base, 0.42 * dim);

    // `bg_bottom` appears nowhere else outside the background renderer: the
    // throat is meant to match the darkest part of the sky so the gate reads
    // as an opening punched through the halo rather than a disc.
    this.back
      .circle(ob.x, ob.y, Math.trunc(r * 0.9))
      .fill({ color: toHex(shade(theme.bgBottom, 0.6)), alpha: 1 });

    const lw = Math.max(2, Math.trunc(r * 0.12));
    for (let i = 0; i < 3; i++) {
      const f = 0.95 - i * 0.2;
      const rr = Math.trunc(r * f);
      const a0 = ob.spin * (1.0 + i * 0.55) + i * 1.1;
      const col = lerpColor(base, theme.food, i / 3.0);
      // The docstring says "counter-rotating", but all three terms are
      // `+spin * positive`: they turn the same way at 1.60 / 2.48 / 3.36 rad/s
      // and it is the differential rate that sells the vortex. Ported as-is.
      // `pygame.draw.arc` is y-up, so both angles are negated; the stroke is
      // pulled in by half its width because pygame strokes an arc inward from
      // the bounding box. The `moveTo` is required: an `arc` on its own would
      // be joined to the previous subpath's last point by a straight line.
      const ar = Math.max(0.5, rr - lw * 0.5);
      const sa = -(a0 + TAU * 0.62);
      this.back
        .moveTo(ob.x + Math.cos(sa) * ar, ob.y + Math.sin(sa) * ar)
        .arc(ob.x, ob.y, ar, sa, -a0)
        .stroke({ color: toHex(shade(col, dim)), width: lw, cap: "butt" });
    }

    this.back
      .circle(ob.x, ob.y, Math.trunc(r))
      .stroke({ color: toHex(shade(base, 1.1 * dim)), width: 3, alignment: 1 });

    // The sparks' angle *decreases*, so in y-down space they run
    // counter-clockwise - against the arcs. That contrast is the portal's only
    // genuine counter-rotation. Radius 7 is a fixed pixel value, not a
    // fraction of the mouth.
    for (let i = 0; i < 6; i++) {
      const a = -ob.spin * 2.0 + (i * TAU) / 6.0;
      addGlow(
        this.sparks,
        ob.x + Math.cos(a) * r * 0.72,
        ob.y + Math.sin(a) * r * 0.72,
        7.0,
        theme.food,
        0.5 * dim,
      );
    }

    const core = lerpColor(base, WHITE, 0.35 + 0.3 * pulse(hazardT, 3.4));
    this.core
      .circle(ob.x, ob.y, Math.trunc(Math.max(2.0, r * 0.18)))
      .fill({ color: toHex(shade(core, dim)), alpha: 1 });
  }
}

// ---------------------------------------------------------------------------
// The renderer
// ---------------------------------------------------------------------------

function makeView(ob: Obstacle, theme: Theme): HazardView | null {
  if (ob instanceof WallBlock) return new WallView(ob, theme);
  if (ob instanceof MovingBar) return new BarView(ob, theme);
  if (ob instanceof Spinner) return new SpinnerView(ob, theme);
  if (ob instanceof Pulsar) return new PulsarView(ob, theme);
  if (ob instanceof LaserGate) return new LaserView(ob, theme);
  if (ob instanceof Portal) return new PortalView(ob, theme);
  return null; // a bare Obstacle has no body to draw
}

/**
 * Draws one level's hazards.
 *
 * Add {@link HazardRenderer.container} to the masked world container, below
 * food and runes. Rebuild the views with {@link setLevel} whenever the obstacle
 * list or the theme changes; call {@link draw} once per frame.
 */
export class HazardRenderer {
  /** Portals underneath, every other hazard above. */
  readonly container = new Container();

  private readonly portalLayer = new Container();
  private readonly hazardLayer = new Container();
  private views: HazardView[] = [];

  constructor() {
    this.container.addChild(this.portalLayer, this.hazardLayer);
  }

  /**
   * Build a view per hazard. The theme comes from the caller, not from any
   * field's own theme slice, which is too narrow to carry a whole palette.
   */
  setLevel(obstacles: readonly Obstacle[], theme: Theme): void {
    this.clear();
    for (const ob of hazardLayerOrder(obstacles)) {
      const view = makeView(ob, theme);
      if (view === null) continue;
      this.views.push(view);
      (ob instanceof Portal ? this.portalLayer : this.hazardLayer).addChild(view.container);
    }
  }

  /** Repaint every hazard from the hazard clock. */
  draw(clocks: FrameClocks): void {
    const hazardT = clocks.hazardT;
    // A non-finite clock would poison every vertex in the layer rather than
    // throw, which is far harder to spot than a frozen frame.
    if (!Number.isFinite(hazardT)) return;
    for (const view of this.views) view.draw(hazardT);
  }

  /** Drop every view, keeping the container usable for the next level. */
  clear(): void {
    for (const view of this.views) view.destroy();
    this.views = [];
    this.portalLayer.removeChildren();
    this.hazardLayer.removeChildren();
  }

  /** Tear the whole layer down. Baked slab textures survive - see the barrel. */
  destroy(): void {
    this.clear();
    this.container.destroy({ children: true });
  }
}
