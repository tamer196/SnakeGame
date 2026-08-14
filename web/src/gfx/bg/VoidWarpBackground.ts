/**
 * Stage 11 - Event Horizon (`voidwarp`).
 *
 * The last light bends inward.
 *
 * Ported from `snake/gfx/background.py::VoidWarpBackground`; the layer-by-layer
 * specification is in `docs/port/background-9-12.md`.
 *
 * Four depths around a drifting singularity: a gravitationally lensed starfield
 * (0.20), warped rings (0.55), infalling matter streaks and the core (0.90).
 *
 * The signature is the lensing. Every star keeps its *rest* polar coordinate
 * and is drawn at `r = r0 - K/(r0 + 60)`, so the field crowds into a bright
 * ring at the lensing radius and relaxes to a plain starfield at the corners.
 * That radius is constant per star, which is worth exploiting: `r`, the crowd
 * factor, the halo-or-point decision and the base colour are all resolved once
 * at build time, leaving one sine and two trig calls per star per frame.
 */

import { Graphics, Sprite } from "pixi.js";

import { clamp, TAU } from "../../core/mathx";
import { clamp8, toHex, type RGB } from "../../core/palette";
import { whiteTexture } from "../textures";
import { Background } from "./Background";

const RINGS = 17;
const POINTS = 40;
const STREAKS = 80;
const STARS = 190;

interface Star {
  readonly a0: number;
  /** Lensed radius - constant, because the lens depends only on `r0`. */
  readonly r: number;
  readonly b: number;
  readonly phase: number;
  /** Differential rotation rate: inner images sweep faster. */
  readonly spin: number;
  /** `0.55 + 0.95 * crowd`, folded in at build time. */
  readonly crowdGain: number;
  readonly cr: number;
  readonly cg: number;
  readonly cb: number;
  readonly sprite: Sprite;
}

interface Streak {
  a: number;
  r: number;
  speed: number;
}

export class VoidWarpBackground extends Background {
  private maxR = 0;
  /** Ring cycle position, 0..1. */
  private phase = 0;
  /** Global star rotation. */
  private swirl = 0;

  private readonly stars: Star[] = [];
  private readonly streaks: Streak[] = [];
  private gfx!: Graphics;
  private coreGfx!: Graphics;
  private coreA!: Sprite;
  private coreB!: Sprite;

  private ringFar: RGB = [0, 0, 0];
  private ringNear: RGB = [0, 0, 0];
  private streakCol: RGB = [0, 0, 0];
  private coreRing = 0;

  protected override build(): void {
    const th = this.theme;
    const w = this.w;
    const h = this.h;
    this.maxR = Math.hypot(w, h) * 0.62;

    for (let i = 0; i < STREAKS; i++) {
      const r01 = this.rng.uniform(0.15, 1.0);
      this.streaks.push({
        a: this.rng.uniform(0, TAU),
        r: r01 * this.maxR,
        speed: this.rng.uniform(0.35, 1.0),
      });
    }

    this.ringFar = th.accent2;
    this.ringNear = th.accent;
    this.streakCol = this.mix(th.text, th.accent, 0.4);

    const starCol = this.mix(th.text, th.accent2, 0.3);
    const haloCol = this.mix(th.accent, th.text, 0.45);
    const lensK = (h * 0.2) ** 2; // lensing strength, px^2
    const lensR = h * 0.24; // where the crowding peaks

    for (let i = 0; i < STARS; i++) {
      // sqrt of a uniform gives a field that is uniform over the disc.
      const r0 = this.maxR * Math.sqrt(this.rng.uniform(0.02, 1.0));
      const a0 = this.rng.uniform(0, TAU);
      const b = this.rng.uniform(0.35, 1.0);
      const phase = this.rng.uniform(0, TAU);
      const r = r0 - lensK / (r0 + 60.0);
      if (r < 8.0) continue; // swallowed by the lens; Python skips it every frame
      const crowd = clamp(1.0 - Math.abs(r - lensR) / (lensR * 1.6), 0, 1);
      // Close to the lensing radius an image smears into a short arc.
      const halo = crowd > 0.55;
      const col = halo ? haloCol : starCol;
      const sprite = new Sprite(whiteTexture());
      sprite.width = halo ? 3 : 1;
      sprite.height = 1;
      this.addSprite(sprite);
      this.stars.push({
        a0,
        r,
        b,
        phase,
        spin: (900.0 / (r0 + 90.0)) * 0.02,
        crowdGain: 0.55 + 0.95 * crowd,
        cr: col[0],
        cg: col[1],
        cb: col[2],
        sprite,
      });
    }

    // Rings and streaks are consecutive normal-blend primitives in the Python
    // paint order, so one Graphics carries both.
    this.gfx = this.addGraphics();

    this.coreA = new Sprite(this.glowTexture(Math.trunc(h * 0.16)));
    this.coreA.anchor.set(0.5);
    this.coreA.blendMode = "add";
    this.coreA.width = Math.trunc(h * 0.16) * 2;
    this.coreA.height = this.coreA.width;
    this.coreA.tint = toHex(th.accent);
    this.coreA.alpha = 0.75;
    this.addSprite(this.coreA);

    this.coreB = new Sprite(this.glowTexture(Math.trunc(h * 0.07)));
    this.coreB.anchor.set(0.5);
    this.coreB.blendMode = "add";
    this.coreB.width = Math.trunc(h * 0.07) * 2;
    this.coreB.height = this.coreB.width;
    this.coreB.tint = toHex(th.text);
    this.coreB.alpha = 0.95;
    this.addSprite(this.coreB);

    this.coreRing = toHex(this.mix(th.accent, th.text, 0.6));
    this.coreGfx = this.addGraphics();
  }

  protected override animate(dt: number): void {
    const t = this.t;
    const h = this.h;
    const maxR = this.maxR;

    this.phase = (this.phase + dt * 0.22) % 1.0;
    this.swirl += dt * 0.05;
    for (const s of this.streaks) {
      // Gravity-ish: the pull grows sharply as the radius shrinks and the
      // angular sweep grows with it, which produces the in-spiral.
      const pull = 40.0 + 26000.0 / Math.max(60.0, s.r);
      s.r -= pull * dt * s.speed;
      s.a += (110.0 / Math.max(50.0, s.r)) * dt;
      if (s.r < 14.0) {
        // Respawned in place at the rim rather than reallocated - Python
        // rebinds the list contents for the same reason.
        s.a = this.rng.uniform(0, TAU);
        s.r = maxR;
        s.speed = this.rng.uniform(0.35, 1.0);
      }
    }

    // The singularity drifts so the field never looks pinned.
    const cx = this.w * 0.5 + Math.sin(t * 0.21) * this.w * 0.05;
    const cy = this.h * 0.5 + Math.cos(t * 0.17) * this.h * 0.05;

    // -- lensed starfield, depth 0.20 ---------------------------------
    const [spx, spy] = this.par(0.2);
    const sx = cx + spx;
    const sy = cy + spy;
    const tt = t * 2.0;
    const swirl = this.swirl;
    for (const s of this.stars) {
      const a = s.a0 + swirl + s.spin * t;
      // Truncated, as pygame's `surface.fill((int(x), int(y), 1, 1))` is. On a
      // one-pixel star the position *is* the whole visual, so the snap from
      // pixel to pixel as the field turns is the shipped look, not an artefact.
      s.sprite.position.set(
        Math.trunc(sx + Math.cos(a) * s.r * 1.12),
        Math.trunc(sy + Math.sin(a) * s.r * 0.88),
      );
      // k can exceed 1; pygame's shade clamps per channel, which whitens a
      // saturated colour rather than simply brightening it. Pre-shading the
      // tint reproduces that exactly - alpha modulation could not.
      const k = s.b * (0.45 + 0.55 * Math.sin(tt + s.phase)) * s.crowdGain;
      s.sprite.tint =
        (clamp8(s.cr * k) << 16) | (clamp8(s.cg * k) << 8) | clamp8(s.cb * k);
    }

    const g = this.gfx;
    g.clear();

    // -- warped rings, depth 0.55 -------------------------------------
    const [rpx, rpy] = this.par(0.55);
    const rx = cx + rpx;
    const ry = cy + rpy;
    const bgT = clamp(cy / h, 0, 1);
    const bgR = clamp8(this.theme.bgTop[0] + (this.theme.bgBottom[0] - this.theme.bgTop[0]) * bgT);
    const bgG = clamp8(this.theme.bgTop[1] + (this.theme.bgBottom[1] - this.theme.bgTop[1]) * bgT);
    const bgB = clamp8(this.theme.bgTop[2] + (this.theme.bgBottom[2] - this.theme.bgTop[2]) * bgT);
    for (let k = 0; k < RINGS; k++) {
      // r grows with p, so rings are born at the core and expand outward,
      // accelerating - the class comment in the Python says "inward"; the
      // maths says outward, and the shipped game expands. Port the maths.
      const p = ((k + this.phase) / RINGS) % 1.0;
      const r = maxR * Math.pow(p, 1.8);
      if (r < 8.0) continue;
      const f = 1.0 - p;
      const q = clamp(0.25 + 0.75 * f, 0, 1);
      const fr = clamp8(this.ringFar[0] + (this.ringNear[0] - this.ringFar[0]) * f);
      const fg = clamp8(this.ringFar[1] + (this.ringNear[1] - this.ringFar[1]) * f);
      const fb = clamp8(this.ringFar[2] + (this.ringNear[2] - this.ringFar[2]) * f);
      const colr =
        (clamp8(bgR + (fr - bgR) * q) << 16) |
        (clamp8(bgG + (fg - bgG) * q) << 8) |
        clamp8(bgB + (fb - bgB) * q);
      let fx = 0;
      let fy = 0;
      for (let i = 0; i < POINTS; i++) {
        const a = (TAU * i) / POINTS;
        // Radial wobble plus a tangential shear: the "warped" silhouette.
        const wob =
          1.0 +
          0.1 * Math.sin(a * 3.0 + t * 1.1 + k * 0.5) +
          0.06 * Math.sin(a * 5.0 - t * 0.7);
        const rr = r * wob;
        const x = rx + Math.cos(a) * rr * 1.12;
        const y = ry + Math.sin(a) * rr * 0.88;
        if (i === 0) {
          fx = x;
          fy = y;
          g.moveTo(x, y);
        } else {
          g.lineTo(x, y);
        }
      }
      // The closing segment is drawn explicitly rather than with closePath, so
      // the ring is one plain polyline - pygame's draw.lines(closed=True).
      g.lineTo(fx, fy);
      g.stroke({ width: f > 0.45 ? 2 : 1, color: colr });
    }

    // -- infalling matter, depth 0.90 ---------------------------------
    const [tpx, tpy] = this.par(0.9);
    const stx = cx + tpx;
    const sty = cy + tpy;
    const sc = this.streakCol;
    for (const s of this.streaks) {
      const k = clamp(1.0 - s.r / maxR, 0.05, 1.0);
      const tail = s.r + 78.0 * k;
      // No 1.12/0.88 squash here: the streak field is circular, unlike the
      // stars and the rings.
      g.moveTo(stx + Math.cos(s.a) * s.r, sty + Math.sin(s.a) * s.r);
      g.lineTo(stx + Math.cos(s.a - 0.05) * tail, sty + Math.sin(s.a - 0.05) * tail);
      const f = 0.25 + 0.75 * k;
      g.stroke({
        width: 1,
        color: (clamp8(sc[0] * f) << 16) | (clamp8(sc[1] * f) << 8) | clamp8(sc[2] * f),
      });
    }

    // -- core ----------------------------------------------------------
    this.coreA.position.set(stx, sty);
    this.coreB.position.set(stx, sty);
    const beat = 0.85 + 0.15 * Math.sin(t * 3.1);
    this.coreGfx.clear();
    this.coreGfx
      .circle(stx, sty, Math.trunc(h * 0.055 * beat))
      .stroke({ width: 2, color: this.coreRing });
  }
}
