/**
 * Stage 3 - Emerald Circuit (`circuit`).
 *
 * A Manhattan-routed board: data pulses run the traces at arc-length speed and
 * short-lived lightning arcs jump between pads.
 *
 * Ported from `snake/gfx/background.py::CircuitBackground`; the layer-by-layer
 * specification is in `docs/port/background-framework-1-4.md (section 5)`.
 *
 * The signature is the lightning. Every so often two pads within arcing
 * distance are joined by a jagged bolt drawn in three passes, wide and dim
 * through narrow and hot, so it blooms without a blur filter. Those passes are
 * *normal* blend, which means the wide dim pass genuinely darkens the traces
 * it crosses - that is the look, not a bug.
 */

import type { Graphics, Sprite } from "pixi.js";

import { clamp, lerp, TAU } from "../../core/mathx";
import { toHex, type RGB } from "../../core/palette";
import { cssRgb, glowSprite, seamlessTexture } from "../textures";
import { Background, MARGIN, type ParallaxLayer } from "./Background";

/** A routed trace, pre-measured so pulses can travel it at constant speed. */
interface TracePath {
  xs: number[];
  ys: number[];
  /** Cumulative length at each vertex; `cum[last]` is the total. */
  cum: number[];
}

interface Pulse {
  path: number;
  /** Position along the path, 0..1 of its arc length. */
  s: number;
  speed: number;
}

/** One of the three bolt slots, display objects and all. */
interface ArcSlot {
  gfx: Graphics;
  flashA: Sprite;
  flashB: Sprite;
  live: boolean;
  xs: number[];
  ys: number[];
  life: number;
  age: number;
}

const SIGNS = [-1, 1] as const;
/** Points per bolt: the Python walks `range(steps + 1)` with `steps = 9`. */
const ARC_STEPS = 9;

export class CircuitBackground extends Background {
  /** How many bolts may be alive at once. */
  private static readonly ARCS = 3;
  /** Period of the substrate mesh, px. */
  private static readonly SUB_TILE = 128;

  private substrate!: ParallaxLayer;
  private readonly paths: TracePath[] = [];
  private readonly nodeX: number[] = [];
  private readonly nodeY: number[] = [];

  private readonly pulses: Pulse[] = [];
  private readonly tailSprites: Sprite[] = [];
  private readonly headSprites: Sprite[] = [];
  private pulseCol: RGB = [255, 255, 255];

  private readonly arcs: ArcSlot[] = [];
  private arcCd = 0;
  private arcHot: RGB = [255, 255, 255];
  private arcCool: RGB = [255, 255, 255];

  /** Scratch for {@link pointAt}, so a steady-state frame allocates nothing. */
  private readonly at = { x: 0, y: 0 };

  protected override build(): void {
    const th = this.theme;
    const w = this.w;
    const h = this.h;
    const m = MARGIN;

    // -- substrate (depth 0.10) ------------------------------------------
    const fine = this.mix(th.grid, th.bgBottom, 0.35);
    const mesh = (u: number, v: number): RGB => {
      const k =
        (0.5 + 0.5 * Math.cos(u * TAU * 4.0)) * (0.5 + 0.5 * Math.cos(v * TAU * 4.0));
      return this.shade(fine, 0.24 * (k * k));
    };
    this.substrate = this.addTile(
      seamlessTexture(CircuitBackground.SUB_TILE, 32, mesh),
      0.1,
    );

    // -- traces (depth 0.45) ---------------------------------------------
    const traces = this.newLayerCanvas();
    const ctx = traces.ctx;
    ctx.globalCompositeOperation = "source-over";
    ctx.lineCap = "butt";
    ctx.lineJoin = "miter";
    const dim = cssRgb(this.shade(th.grid, 1.15));
    const pad = cssRgb(this.mix(th.grid, th.accent, 0.4));

    const gridStep = 34.0;
    for (let attempt = 0; attempt < 30; attempt++) {
      // Manhattan routing on a coarse lattice: alternate horizontal and
      // vertical runs so the result reads as a printed circuit board.
      let x = Math.round(this.rng.uniform(0, w) / gridStep) * gridStep;
      let y = Math.round(this.rng.uniform(0, h) / gridStep) * gridStep;
      const xs = [x];
      const ys = [y];
      let horiz = this.rng.random() < 0.5;
      const runs = this.rng.randint(4, 8);
      for (let i = 0; i < runs; i++) {
        const run = gridStep * this.rng.randint(2, 7) * this.rng.choice(SIGNS);
        if (horiz) x = clamp(x + run, -20.0, w + 20.0);
        else y = clamp(y + run, -20.0, h + 20.0);
        horiz = !horiz;
        xs.push(x);
        ys.push(y);
      }

      const cum = [0];
      for (let i = 1; i < xs.length; i++) {
        cum.push(cum[i - 1]! + Math.hypot(xs[i]! - xs[i - 1]!, ys[i]! - ys[i - 1]!));
      }
      // A stub too short to carry a pulse is thrown away rather than drawn.
      if (cum[cum.length - 1]! < 60.0) continue;

      this.paths.push({ xs, ys, cum });
      for (let i = 0; i < xs.length; i++) {
        this.nodeX.push(xs[i]!);
        this.nodeY.push(ys[i]!);
      }

      ctx.strokeStyle = dim;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(Math.trunc(xs[0]! + m), Math.trunc(ys[0]! + m));
      for (let i = 1; i < xs.length; i++) {
        ctx.lineTo(Math.trunc(xs[i]! + m), Math.trunc(ys[i]! + m));
      }
      ctx.stroke();

      // Solder pads at every corner - the anchors the lightning jumps between.
      ctx.strokeStyle = pad;
      ctx.lineWidth = 1;
      for (let i = 0; i < xs.length; i++) {
        ctx.beginPath();
        ctx.arc(Math.trunc(xs[i]! + m), Math.trunc(ys[i]! + m), 4, 0, TAU);
        ctx.stroke();
      }
    }
    this.addLayer(traces.canvas, 0.45);

    // -- chips (depth 0.90) ----------------------------------------------
    const chips = this.newLayerCanvas();
    const cctx = chips.ctx;
    cctx.globalCompositeOperation = "source-over";
    const chipEdge = cssRgb(this.shade(th.grid, 0.9));
    const chipPin = cssRgb(this.shade(th.grid, 0.7));
    for (let i = 0; i < 20; i++) {
      const cw = this.rng.randint(26, 64);
      const ch = this.rng.randint(20, 40);
      const rx = Math.trunc(m + this.rng.uniform(0, w - cw));
      const ry = Math.trunc(m + this.rng.uniform(0, h - ch));

      // Half-pixel inset keeps the 1 px stroke inside the rect, which is where
      // pygame's `draw.rect(..., 1)` puts it.
      cctx.strokeStyle = chipEdge;
      cctx.lineWidth = 1;
      roundRectPath(cctx, rx + 0.5, ry + 0.5, cw - 1, ch - 1, 3);
      cctx.stroke();

      cctx.fillStyle = pad;
      cctx.beginPath();
      cctx.arc(rx + 6, ry + 6, 2, 0, TAU);
      cctx.fill();

      cctx.fillStyle = chipPin;
      for (let bx = rx + 5; bx < rx + cw - 3; bx += 8) {
        cctx.fillRect(bx, ry + ch, 3, 3);
        cctx.fillRect(bx, ry - 3, 3, 3);
      }
    }
    this.addLayer(chips.canvas, 0.9);

    // -- data pulses (28) -------------------------------------------------
    const pathCount = Math.max(1, this.paths.length);
    for (let i = 0; i < 28; i++) {
      this.pulses.push({
        path: i % pathCount,
        s: this.rng.uniform(0.0, 1.0),
        speed: this.rng.uniform(90.0, 210.0),
      });
    }
    this.pulseCol = this.mix(th.accent, th.text, 0.25);
    for (let i = 0; i < this.pulses.length; i++) {
      // Tail then head, matching the Python's per-pulse paint order.
      this.tailSprites.push(this.addSprite(glowSprite(7, th.accent2, 0.42)));
      this.headSprites.push(this.addSprite(glowSprite(11, this.pulseCol, 1.0)));
    }

    // -- lightning (<= 3 slots) -------------------------------------------
    this.arcCd = this.rng.uniform(0.2, 1.0);
    this.arcHot = this.mix(th.accent2, th.text, 0.55);
    this.arcCool = th.accent2;
    for (let i = 0; i < CircuitBackground.ARCS; i++) {
      const slot: ArcSlot = {
        gfx: this.addGraphics(),
        flashA: this.addSprite(glowSprite(16, this.arcHot, 0)),
        flashB: this.addSprite(glowSprite(16, this.arcHot, 0)),
        live: false,
        xs: new Array<number>(ARC_STEPS + 1).fill(0),
        ys: new Array<number>(ARC_STEPS + 1).fill(0),
        life: 1,
        age: 0,
      };
      slot.flashA.visible = false;
      slot.flashB.visible = false;
      this.arcs.push(slot);
    }

    // The Python's `_paint` bails out entirely when no path survived routing.
    // Thirty attempts of >= 60 px make that essentially impossible, but the
    // guard is free and the pulse indices depend on it.
    if (this.paths.length === 0) this.layers.visible = false;
  }

  /** Interpolate a position `s` (0..1) along pre-measured polyline `pi`. */
  private pointAt(pi: number, s: number): { x: number; y: number } {
    const p = this.paths[pi]!;
    const cum = p.cum;
    const target = clamp(s, 0, 1) * cum[cum.length - 1]!;
    let lo = 0;
    let hi = cum.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (cum[mid]! <= target) lo = mid;
      else hi = mid;
    }
    const seg = Math.max(1e-6, cum[lo + 1]! - cum[lo]!);
    const f = (target - cum[lo]!) / seg;
    this.at.x = lerp(p.xs[lo]!, p.xs[lo + 1]!, f);
    this.at.y = lerp(p.ys[lo]!, p.ys[lo + 1]!, f);
    return this.at;
  }

  /** Join two pads that are close enough to arc with a jagged bolt. */
  private spawnArc(slot: ArcSlot): void {
    const n = this.nodeX.length;
    if (n < 2) return;
    const i = this.rng.randrange(n);
    const ax = this.nodeX[i]!;
    const ay = this.nodeY[i]!;

    let bx = 0;
    let by = 0;
    let d = 0;
    for (let k = 0; k < 8; k++) {
      const j = this.rng.randrange(n);
      const cx = this.nodeX[j]!;
      const cy = this.nodeY[j]!;
      const dd = Math.hypot(cx - ax, cy - ay);
      if (dd > 70.0 && dd < 280.0) {
        bx = cx;
        by = cy;
        d = dd;
        break;
      }
    }
    if (d === 0) return; // eight tries, no pad in range - give up silently

    const nx = (by - ay) / d;
    const ny = -(bx - ax) / d;
    for (let s = 0; s <= ARC_STEPS; s++) {
      const f = s / ARC_STEPS;
      // Endpoints stay pinned to their pads; only the middle wobbles.
      const wob = s === 0 || s === ARC_STEPS ? 0 : this.rng.uniform(-1.0, 1.0) * d * 0.1;
      slot.xs[s] = Math.trunc(lerp(ax, bx, f) + nx * wob);
      slot.ys[s] = Math.trunc(lerp(ay, by, f) + ny * wob);
    }
    slot.life = this.rng.uniform(0.14, 0.3);
    slot.age = 0;
    slot.live = true;
  }

  protected override animate(dt: number): void {
    if (this.paths.length === 0) return;

    for (const p of this.pulses) {
      const cum = this.paths[p.path]!.cum;
      p.s += (p.speed * dt) / Math.max(1.0, cum[cum.length - 1]!);
      if (p.s > 1.0) {
        p.s -= 1.0;
        p.path = this.rng.randrange(this.paths.length);
      }
    }

    this.substrate.dx = (this.substrate.dx + 3.5 * dt) % CircuitBackground.SUB_TILE;
    this.substrate.dy = (this.substrate.dy + 2.0 * dt) % CircuitBackground.SUB_TILE;

    this.arcCd -= dt;
    if (this.arcCd <= 0) {
      this.arcCd = this.rng.uniform(0.35, 1.5);
      const free = this.arcs.find((a) => !a.live);
      if (free) this.spawnArc(free);
    }
    for (const arc of this.arcs) {
      if (arc.live) {
        arc.age += dt;
        if (arc.age >= arc.life) arc.live = false;
      }
    }

    // -- pulses ------------------------------------------------------------
    const beat = 0.75 + 0.25 * Math.sin(this.t * 2.0);
    const [px, py] = this.par(0.45);
    for (let i = 0; i < this.pulses.length; i++) {
      const p = this.pulses[i]!;
      // `s - 0.045` is clamped to 0 inside pointAt, so a pulse just off the
      // start of its path drags its tail on the first vertex.
      const tail = this.pointAt(p.path, p.s - 0.045);
      this.tailSprites[i]!.position.set(Math.trunc(tail.x + px), Math.trunc(tail.y + py));
      const head = this.pointAt(p.path, p.s);
      const hs = this.headSprites[i]!;
      hs.position.set(Math.trunc(head.x + px), Math.trunc(head.y + py));
      hs.alpha = beat;
    }

    // -- lightning ---------------------------------------------------------
    const ix = Math.trunc(px);
    const iy = Math.trunc(py);
    for (const arc of this.arcs) {
      const g = arc.gfx;
      g.clear();
      if (!arc.live) {
        arc.flashA.visible = false;
        arc.flashB.visible = false;
        continue;
      }
      const f =
        (1 - clamp(arc.age / Math.max(1e-3, arc.life), 0, 1)) *
        (0.55 + 0.45 * Math.sin(arc.age * 90.0)); // crackle
      if (f <= 0.02) {
        arc.flashA.visible = false;
        arc.flashB.visible = false;
        continue;
      }
      g.position.set(ix, iy);
      this.strokeArc(g, arc, this.shade(this.arcCool, 0.18 * f), 7);
      this.strokeArc(g, arc, this.shade(this.arcCool, 0.55 * f), 3);
      this.strokeArc(g, arc, this.shade(this.arcHot, f), 1);

      // Radius and colour are fixed, so a flash costs two property writes.
      arc.flashA.visible = true;
      arc.flashB.visible = true;
      arc.flashA.alpha = 0.7 * f;
      arc.flashB.alpha = 0.7 * f;
      arc.flashA.position.set(arc.xs[0]! + ix, arc.ys[0]! + iy);
      arc.flashB.position.set(arc.xs[ARC_STEPS]! + ix, arc.ys[ARC_STEPS]! + iy);
    }
  }

  /** One wide-to-narrow bloom pass along a bolt. */
  private strokeArc(g: Graphics, arc: ArcSlot, col: RGB, width: number): void {
    g.moveTo(arc.xs[0]!, arc.ys[0]!);
    for (let i = 1; i <= ARC_STEPS; i++) g.lineTo(arc.xs[i]!, arc.ys[i]!);
    g.stroke({ color: toHex(col), width, cap: "butt", join: "miter" });
  }
}

/** A rounded-rect path, spelled out because `roundRect` is not everywhere yet. */
function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rad = Math.min(r, w * 0.5, h * 0.5);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.lineTo(x + w - rad, y);
  ctx.arcTo(x + w, y, x + w, y + rad, rad);
  ctx.lineTo(x + w, y + h - rad);
  ctx.arcTo(x + w, y + h, x + w - rad, y + h, rad);
  ctx.lineTo(x + rad, y + h);
  ctx.arcTo(x, y + h, x, y + h - rad, rad);
  ctx.lineTo(x, y + rad);
  ctx.arcTo(x, y, x + rad, y, rad);
  ctx.closePath();
}
