/**
 * Stage 9 - Crimson Engine (`machine`).
 *
 * The machine wants feeding.
 *
 * Ported from `snake/gfx/background.py::MachineBackground`; the layer-by-layer
 * specification is in `docs/port/background-9-12.md`.
 *
 * Three depths: a dim gear wall far behind (0.15), riveted plates (0.45), and
 * the live machinery - meshed gear trains, sliding pistons and pulsing lamps -
 * at 0.90. The signature is that the gears genuinely mesh: a driven gear sits
 * one pitch-radius sum from its driver, spins at the tooth ratio with the sign
 * flipped, and starts at the phase that puts a driver tooth opposite a driven
 * gap. Because the ratio is exact, the relation holds for the rest of the run.
 *
 * Retained-mode shape: one texture per gear spec, one atlas texture for all six
 * plates, five static piston bodies and ten lamp sprites, all built once. Every
 * frame only writes positions, rotations and alphas.
 */

import { Graphics, Sprite, Texture } from "pixi.js";

import { TAU } from "../../core/mathx";
import { toHex, type RGB } from "../../core/palette";
import { canvasTexture, context2d, createCanvas, cssRgb } from "../textures";
import { Background, MARGIN } from "./Background";

/** Tip radius and tooth count of the three gear sizes. */
const SPECS: ReadonlyArray<readonly [number, number]> = [
  [44, 9],
  [70, 12],
  [104, 16],
];

/** Pitch radius as a fraction of the tip radius - sets the centre distance. */
const PITCH = 0.9;

const BLACK: RGB = [0, 0, 0];

interface Gear {
  readonly x: number;
  readonly y: number;
  readonly spec: number;
  phase: number;
  readonly omega: number;
  readonly sprite: Sprite;
}

interface Piston {
  readonly x: number;
  readonly y: number;
  /** Peak-to-peak travel of the rod, Python's `throw`. */
  readonly travel: number;
  readonly rate: number;
  readonly phase: number;
  readonly vertical: boolean;
  readonly gfx: Graphics;
}

interface Lamp {
  readonly x: number;
  readonly y: number;
  readonly phase: number;
  readonly sprite: Sprite;
}

export class MachineBackground extends Background {
  private readonly gears: Gear[] = [];
  private readonly pistons: Piston[] = [];
  private readonly lamps: Lamp[] = [];
  private plates: Sprite | null = null;

  /** Tooth counts and tip radii, indexed by spec, for the mesh solver. */
  private readonly teeth: number[] = [];
  private readonly radii: number[] = [];
  private readonly gearTextures: Texture[] = [];

  protected override build(): void {
    const th = this.theme;
    const w = this.w;
    const h = this.h;

    const body = cssRgb(this.mix(th.bgBottom, BLACK, 0.45), 238 / 255);
    const rim = cssRgb(this.mix(th.grid, th.accent, 0.55));

    for (const spec of SPECS) {
      const radius = spec[0];
      const teeth = spec[1];
      this.gearTextures.push(this.own(this.gearTexture(radius, teeth, body, rim)));
      this.teeth.push(teeth);
      this.radii.push(radius);
    }

    this.buildFarWorks();
    this.buildPlates();

    // Build order is draw order from here down: gears, then pistons over them,
    // then lamps over both - exactly the sequence the Python paints.
    for (let i = 0; i < 4; i++) this.train();

    const pistonBody = toHex(this.mix(th.bgBottom, BLACK, 0.5));
    const pistonRim = toHex(this.mix(th.grid, th.accent, 0.45));
    for (let i = 0; i < 5; i++) {
      const vertical = this.rng.random() < 0.5;
      const x = this.rng.uniform(w * 0.08, w * 0.92);
      const y = this.rng.uniform(h * 0.08, h * 0.92);
      const travel = this.rng.uniform(60, 150);
      const rate = this.rng.uniform(0.5, 1.4);
      const phase = this.rng.uniform(0, TAU);
      this.pistons.push({
        x,
        y,
        travel,
        rate,
        phase,
        vertical,
        gfx: this.pistonGraphics(travel, vertical, pistonBody, pistonRim),
      });
    }

    const lampTint = toHex(th.accent);
    for (let i = 0; i < 10; i++) {
      const x = this.rng.uniform(0, w);
      const y = this.rng.uniform(0, h);
      const phase = this.rng.uniform(0, TAU);
      const sprite = new Sprite(this.glowTexture(13));
      sprite.anchor.set(0.5);
      sprite.blendMode = "add";
      sprite.width = 26;
      sprite.height = 26;
      sprite.tint = lampTint;
      this.addSprite(sprite);
      this.lamps.push({ x, y, phase, sprite });
    }
  }

  protected override animate(dt: number): void {
    const t = this.t;

    const plates = this.plates;
    if (plates) {
      const [ppx, ppy] = this.par(0.45);
      plates.position.set(-MARGIN + ppx, -MARGIN + ppy);
    }

    // Pistons and lamps deliberately reuse the gears' parallax: the Python loop
    // never recomputes `_par` after the gear pass, so all three sit at 0.90.
    const [px, py] = this.par(0.9);

    for (const g of this.gears) {
      g.phase += g.omega * dt;
      g.sprite.position.set(g.x + px, g.y + py);
      // Continuous rotation where Python quantises to 12 steps per tooth pitch.
      // That bank of pre-rotated frames was a CPU-blit cost dodge; the spec
      // (docs/port/background-9-12.md §6) signs off the smooth version.
      g.sprite.rotation = g.phase;
    }

    for (const p of this.pistons) {
      const s = Math.sin(t * p.rate + p.phase) * p.travel * 0.5;
      if (p.vertical) {
        p.gfx.position.set(p.x + px - 9, p.y + py - p.travel * 0.5 + s);
      } else {
        p.gfx.position.set(p.x + px - p.travel * 0.5 + s, p.y + py - 9);
      }
    }

    for (const l of this.lamps) {
      const k = 0.5 + 0.5 * Math.sin(t * 2.4 + l.phase);
      l.sprite.position.set(l.x + px, l.y + py);
      l.sprite.alpha = 0.2 + 0.4 * k;
    }
  }

  // -------------------------------------------------------------------
  // build helpers
  // -------------------------------------------------------------------

  /**
   * One gear, drawn flat with a tooth tip at angle 0 so the sprite's rotation
   * *is* the gear's phase and the mesh solver needs no offset.
   */
  private gearTexture(radius: number, teeth: number, body: string, rim: string): Texture {
    const d = radius * 2 + 8;
    const canvas = createCanvas(d, d);
    const ctx = context2d(canvas);
    const c = d * 0.5;
    const n = teeth * 2;

    ctx.globalCompositeOperation = "source-over";
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const a = (TAU * i) / n;
      const rr = i % 2 === 0 ? radius : radius * 0.8;
      const x = c + Math.cos(a) * rr;
      const y = c + Math.sin(a) * rr;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fillStyle = body;
    ctx.fill();
    ctx.strokeStyle = rim;
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(c, c, Math.trunc(radius * 0.3), 0, TAU);
    ctx.stroke();

    ctx.lineWidth = 4;
    for (let i = 0; i < 5; i++) {
      const a = (TAU * i) / 5;
      ctx.beginPath();
      ctx.moveTo(c + Math.cos(a) * radius * 0.32, c + Math.sin(a) * radius * 0.32);
      ctx.lineTo(c + Math.cos(a) * radius * 0.7, c + Math.sin(a) * radius * 0.7);
      ctx.stroke();
    }
    return canvasTexture(canvas);
  }

  /** Fourteen unlit gear outlines on the far wall - static, additive, depth 0.15. */
  private buildFarWorks(): void {
    const { canvas, ctx, m } = this.newLayerCanvas();
    const dim = this.mix(this.theme.grid, BLACK, 0.45);
    // pygame's draw.polygon overwrites; so does a source-over stroke on black.
    ctx.globalCompositeOperation = "source-over";
    ctx.strokeStyle = cssRgb(this.shade(dim, 0.55));
    ctx.lineWidth = 2;
    for (let g = 0; g < 14; g++) {
      const r = this.rng.randint(20, 46);
      const n = this.rng.randint(8, 13);
      const cx = m + this.rng.uniform(0, this.w);
      const cy = m + this.rng.uniform(0, this.h);
      ctx.beginPath();
      const count = n * 2;
      for (let i = 0; i < count; i++) {
        const a = (TAU * i) / count;
        // Root factor 0.78 here, 0.80 on the live gears - a Python quirk kept.
        const rr = i % 2 === 0 ? r : r * 0.78;
        const x = cx + Math.cos(a) * rr;
        const y = cy + Math.sin(a) * rr;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.stroke();
    }
    this.addLayer(canvas, 0.15);
  }

  /**
   * The six riveted plates, baked into one margined atlas.
   *
   * These are the one thing in this module that alpha-blends rather than adds -
   * they are darker than the sky and are meant to sit *over* it - so the atlas
   * keeps per-pixel alpha and the sprite stays on the normal blend. That also
   * means it cannot go through `addLayer`, hence the manual parallax in
   * {@link animate}.
   */
  private buildPlates(): void {
    const th = this.theme;
    const canvas = createCanvas(this.w + MARGIN * 2, this.h + MARGIN * 2);
    const ctx = context2d(canvas);
    ctx.globalCompositeOperation = "source-over";

    const fill = cssRgb(this.mix(th.bgBottom, BLACK, 0.3), 150 / 255);
    const border = cssRgb(th.grid, 90 / 255);
    const rivet = cssRgb(th.grid, 120 / 255);

    ctx.lineWidth = 2;
    for (let i = 0; i < 6; i++) {
      const pw = Math.trunc(this.rng.uniform(160, 420));
      const ph = Math.trunc(this.rng.uniform(120, 320));
      const ox = MARGIN + this.rng.uniform(-40, this.w - 120);
      const oy = MARGIN + this.rng.uniform(-40, this.h - 100);

      ctx.globalCompositeOperation = "source-over";
      ctx.beginPath();
      ctx.roundRect(ox, oy, pw, ph, 8);
      ctx.fillStyle = fill;
      ctx.fill();

      // pygame's draw calls *write* RGBA onto an SRCALPHA surface - they do not
      // alpha-blend - so the border sits at exactly alpha 90 over a body at
      // 150, not at the 190-ish a source-over stroke would give. Punching the
      // body out first and drawing into the hole reproduces the write.
      // Inset by one so the 2 px stroke lands inside the rect, as pygame's
      // rect outline does rather than straddling the edge.
      ctx.beginPath();
      ctx.roundRect(ox + 1, oy + 1, pw - 2, ph - 2, 7);
      ctx.globalCompositeOperation = "destination-out";
      ctx.strokeStyle = "#fff";
      ctx.stroke();
      ctx.globalCompositeOperation = "source-over";
      ctx.strokeStyle = border;
      ctx.stroke();

      ctx.beginPath();
      for (let bx = 12; bx < pw - 6; bx += 34) {
        ctx.moveTo(ox + bx + 3, oy + 12);
        ctx.arc(ox + bx, oy + 12, 3, 0, TAU);
        ctx.moveTo(ox + bx + 3, oy + ph - 12);
        ctx.arc(ox + bx, oy + ph - 12, 3, 0, TAU);
      }
      ctx.globalCompositeOperation = "destination-out";
      ctx.fillStyle = "#fff";
      ctx.fill();
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = rivet;
      ctx.fill();
    }
    ctx.globalCompositeOperation = "source-over";

    const sprite = new Sprite(this.own(canvasTexture(canvas)));
    this.plates = this.addSprite(sprite);
  }

  /**
   * Lay down a driver gear and one or two gears meshed onto it.
   *
   * `phase_b = theta + pi - pi/nb + (na/nb)(theta - phase_a)` puts a driver
   * tooth opposite a driven gap along the line of centres; `omega_b` is the
   * exact tooth ratio, so the pair never drifts out of mesh.
   */
  private train(): void {
    let gi = this.rng.randrange(SPECS.length);
    let x = this.rng.uniform(this.w * 0.05, this.w * 0.95);
    let y = this.rng.uniform(this.h * 0.05, this.h * 0.95);
    let phase = this.rng.uniform(0, TAU);
    let omega = this.rng.uniform(0.3, 0.95) * this.rng.choice([-1, 1]);
    this.addGear(x, y, gi, phase, omega);

    const links = this.rng.randint(1, 2);
    for (let i = 0; i < links; i++) {
      const gj = this.rng.randrange(SPECS.length);
      const na = this.teeth[gi] ?? 1;
      const nb = this.teeth[gj] ?? 1;
      const gap = ((this.radii[gi] ?? 0) + (this.radii[gj] ?? 0)) * PITCH;
      const theta = this.rng.uniform(0, TAU);
      const nx = x + Math.cos(theta) * gap;
      const ny = y + Math.sin(theta) * gap;
      const phaseB = theta + Math.PI - Math.PI / nb + (na / nb) * (theta - phase);
      const omegaB = (-omega * na) / nb;
      this.addGear(nx, ny, gj, phaseB, omegaB);
      x = nx;
      y = ny;
      gi = gj;
      phase = phaseB;
      omega = omegaB;
    }
  }

  private addGear(x: number, y: number, spec: number, phase: number, omega: number): void {
    const tex = this.gearTextures[spec];
    if (!tex) return;
    const sprite = new Sprite(tex);
    sprite.anchor.set(0.5);
    this.addSprite(sprite);
    this.gears.push({ x, y, spec, phase, omega, sprite });
  }

  /**
   * A piston rod: its length never changes, only where it slides to, so the
   * rounded rect is drawn once and only the position moves.
   */
  private pistonGraphics(
    travel: number,
    vertical: boolean,
    body: number,
    rim: number,
  ): Graphics {
    const len = Math.trunc(travel * 0.5 + 30);
    const rw = vertical ? 18 : len;
    const rh = vertical ? len : 18;
    const g = this.addGraphics();
    g.roundRect(0, 0, rw, rh, 5).fill({ color: body });
    // alignment 1 keeps the stroke inside the rect, matching pygame's outline.
    g.roundRect(0, 0, rw, rh, 5).stroke({ width: 2, color: rim, alignment: 1 });
    return g;
  }
}
