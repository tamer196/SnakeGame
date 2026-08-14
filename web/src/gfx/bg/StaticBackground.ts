/**
 * Stage 6 - Violet Static (`static`).
 *
 * A dead channel. Nothing is listening.
 *
 * Ported from `snake/gfx/background.py::StaticBackground`; the layer-by-layer
 * specification is in `docs/port/background-5-8.md`.
 *
 * Six passes: three signal bands drifting at their own rates, torn streaks,
 * grain, interference tears with a chromatic fringe, a soft signal bar and the
 * scanlines. Everything above the scanlines is additive; the scanlines
 * themselves multiply, so they darken the whole stack without touching its
 * colour - and they are a sprite, not a filter, because that is one blend, not
 * a render-target round trip.
 *
 * The stage is deliberately noisy: streaks, grain and band jitter are
 * re-randomised on a timer rather than held, and that randomness is the look.
 */

import { Sprite, type Texture } from "pixi.js";

import { TAU } from "../../core/mathx";
import { toHex } from "../../core/palette";
import {
  canvasTexture,
  clearToBlack,
  context2d,
  createCanvas,
  cssRgb,
  noiseTileTextures,
  seamlessTexture,
  whiteTexture,
} from "../textures";
import { Background, type ParallaxLayer } from "./Background";

const STREAKS = 24;
const SCAN_PERIOD = 4;
/** Grain tile edge, in px. */
const NOISE = 192;
const NOISE_TILES = 6;
const NOISE_SPECKS = 170;
/** Longest streak the pre-rendered strip can supply. */
const STREAK_MAX = 260;

const SIG_PERIOD = 256;
const SIG_CELLS = 32;
const SIG_SPEED = [16.0, 38.0, 74.0] as const;
const SIG_SHAPE = [
  [2.0, 0.3],
  [3.0, 0.2],
  [5.0, 0.13],
] as const;

const MAX_TEARS = 20;
/** Height of the pre-rendered tear strip; a tear is cropped to it. */
const TEAR_H = 48;
const BAR_H = 90;

/**
 * Python re-rolls the jitter, streaks and grain once per `_animate` / `_paint`
 * pair, tuned at 60 fps. Driving them off a fixed 60 Hz tick instead of the
 * display's refresh keeps the noise at the authored rate on a 120 Hz panel.
 */
const TICK = 1 / 60;

/** Python's `%`: never negative. */
function pmod(v: number, period: number): number {
  const m = v % period;
  return m < 0 ? m + period : m;
}

export class StaticBackground extends Background {
  // Every field is `declare`d and assigned in `build`. The base class calls
  // `build()` from its constructor, and JS class fields are defined *after*
  // `super()` returns - so a plain initialiser here would silently wipe
  // whatever the build had already produced.
  private declare signals: ParallaxLayer[];
  private declare sigY: number[];
  private declare jitter: number[];

  private declare streaks: Sprite[];
  private declare snow: Sprite[];
  private declare noise: Texture[];

  private declare tearBand: Sprite[];
  private declare tearTop: Sprite[];
  private declare tearBottom: Sprite[];
  private declare tearY: Float64Array;
  private declare tearH: Float64Array;
  private declare tearX: Float64Array;
  private declare tearLife: Float64Array;
  private declare tearCount: number;
  private declare tearCd: number;

  private declare bar: Sprite;
  private declare barY: number;
  private declare scan: ParallaxLayer;
  private declare scanOff: number;

  private declare tick: number;

  protected override build(): void {
    const { w, h, theme } = this;
    this.signals = [];
    this.sigY = [0, 0, 0];
    this.jitter = [0, 0, 0];
    this.streaks = [];
    this.snow = [];
    this.noise = [];
    this.tearBand = [];
    this.tearTop = [];
    this.tearBottom = [];
    this.tearY = new Float64Array(MAX_TEARS);
    this.tearH = new Float64Array(MAX_TEARS);
    this.tearX = new Float64Array(MAX_TEARS);
    this.tearLife = new Float64Array(MAX_TEARS);
    this.tearCount = 0;
    this.tearCd = 0;
    this.barY = 0;
    this.scanOff = 0;
    this.tick = 0;

    const speckCols = [
      this.shade(theme.accent, 0.75),
      this.shade(theme.accent2, 0.7),
      this.shade(theme.text, 0.55),
      this.shade(theme.grid, 1.4),
    ];

    // Dead-channel signal: three grain bands drifting at their own rates, so
    // the frame has depth even between tears.
    const bandCol = this.mix(theme.grid, theme.accent2, 0.4);
    for (let k = 0; k < SIG_SHAPE.length; k++) {
      const [freq, amp] = SIG_SHAPE[k]!;
      const tex = seamlessTexture(SIG_PERIOD, SIG_CELLS, (u, v) => {
        // The `sin(u·TAU)·0.6` term bends the bands; `+k` de-phases the layers.
        const s = 0.5 + 0.5 * Math.sin(v * TAU * freq + Math.sin(u * TAU) * 0.6 + k);
        return this.shade(bandCol, amp * (s * s * s));
      });
      this.signals.push(this.addTile(tex, 0.2 + 0.35 * k));
    }

    // Torn signal chunks. Python blits sub-rects of a 260x3 strip; a tinted
    // unit sprite is the same rectangle for none of the fill cost.
    const streakHex = toHex(this.shade(theme.accent2, 0.3));
    for (let i = 0; i < STREAKS; i++) {
      const s = new Sprite(whiteTexture());
      s.blendMode = "add";
      s.tint = streakHex;
      this.streaks.push(s);
      this.addSprite(s);
    }

    // Six tiles at 170 specks each: a full grid of them puts ~6800 specks on
    // screen for forty sprite moves.
    this.noise = noiseTileTextures(NOISE, NOISE_TILES, NOISE_SPECKS, speckCols, this.rng);
    for (const t of this.noise) this.own(t);
    // One spare row and column: the grid is stamped from an origin up to a
    // tile above and to the left of the arena.
    const snowCells = (Math.ceil(w / NOISE) + 1) * (Math.ceil(h / NOISE) + 1);
    for (let i = 0; i < snowCells; i++) {
      const s = new Sprite(this.noise[0]!);
      s.blendMode = "add";
      this.snow.push(s);
      this.addSprite(s);
    }

    // Interference tears: a displaced band, a hot top edge and a hazard-
    // coloured bottom edge offset 6 px sideways - that offset *is* the
    // chromatic fringe.
    const tearHex = toHex(this.shade(theme.accent2, 0.24));
    const topHex = toHex(this.mix(theme.accent, theme.text, 0.4));
    const bottomHex = toHex(theme.hazard);
    for (let i = 0; i < MAX_TEARS; i++) {
      const band = new Sprite(whiteTexture());
      band.blendMode = "add";
      band.tint = tearHex;
      band.visible = false;
      const top = new Sprite(whiteTexture());
      top.tint = topHex;
      top.height = 1;
      top.width = w;
      top.visible = false;
      const bottom = new Sprite(whiteTexture());
      bottom.tint = bottomHex;
      bottom.height = 1;
      bottom.width = w;
      bottom.visible = false;
      this.tearBand.push(band);
      this.tearTop.push(top);
      this.tearBottom.push(bottom);
      this.addSprite(band);
      this.addSprite(top);
      this.addSprite(bottom);
    }

    this.bar = new Sprite(this.own(this.buildBar()));
    this.bar.blendMode = "add";
    this.addSprite(this.bar);

    // Scanlines last, and multiply rather than add: 150 darkens a row pair,
    // 255 leaves it alone. Registered at depth 0 so it never takes parallax -
    // it is screen furniture, not part of the world.
    this.scan = this.addTile(this.buildScanlines(), 0);
    this.scan.display.blendMode = "multiply";

    // Python randomises both of these inside `_paint`, so they are never seen
    // in their default state; seed them here for the same reason.
    this.rollStreaks(w, h);
    this.rollSnow();
  }

  protected override animate(dt: number): void {
    const { w, h } = this;

    this.barY = pmod(this.barY + h * 0.28 * dt, h + 120.0);
    this.bar.position.set(0, this.barY - 120);
    this.scanOff = pmod(this.scanOff + 24.0 * dt, SCAN_PERIOD);
    this.scan.dy = this.scanOff;

    this.tick += dt;
    const rolled = this.tick >= TICK;
    if (rolled) this.tick = 0;

    for (let i = 0; i < 3; i++) {
      this.sigY[i] = pmod(this.sigY[i]! + SIG_SPEED[i]! * dt, SIG_PERIOD);
      if (rolled) {
        // A layer usually sits still and occasionally shears sideways.
        this.jitter[i] =
          this.rng.random() < 0.28
            ? this.rng.uniform(-14.0, 14.0) * (i + 1)
            : this.jitter[i]! * 0.5;
      }
      const layer = this.signals[i]!;
      layer.dx = this.jitter[i]!;
      layer.dy = this.sigY[i]!;
    }

    this.tearCd -= dt;
    if (this.tearCd <= 0.0) {
      this.tearCd = this.rng.uniform(0.03, 0.28);
      const burst = this.rng.randint(2, 5);
      for (let i = 0; i < burst; i++) this.spawnTear();
    }
    this.expireTears(dt);
    this.placeTears();

    if (rolled) {
      this.rollStreaks(w, h);
      this.rollSnow();
    }
  }

  // -------------------------------------------------------------------
  // per-frame noise
  // -------------------------------------------------------------------

  private rollStreaks(w: number, h: number): void {
    for (const s of this.streaks) {
      s.position.set(this.rng.randrange(w), this.rng.randrange(h));
      s.width = this.rng.randint(30, STREAK_MAX);
      s.height = this.rng.randint(1, 3);
    }
  }

  /** A grain grid stamped from a random origin, cycling tiles as it goes. */
  private rollSnow(): void {
    let idx = this.rng.randrange(NOISE_TILES);
    const x0 = -this.rng.randrange(NOISE);
    const y0 = -this.rng.randrange(NOISE);
    const pool = this.snow.length;
    let n = 0;
    for (let yy = y0; yy < this.h && n < pool; yy += NOISE) {
      for (let xx = x0; xx < this.w && n < pool; xx += NOISE) {
        const s = this.snow[n]!;
        s.texture = this.noise[idx % NOISE_TILES]!;
        s.position.set(xx, yy);
        s.visible = true;
        idx++;
        n++;
      }
    }
    for (let i = n; i < this.snow.length; i++) this.snow[i]!.visible = false;
  }

  // -------------------------------------------------------------------
  // tears
  // -------------------------------------------------------------------

  private spawnTear(): void {
    const y = this.rng.uniform(0, this.h);
    const bh = this.rng.uniform(5, 42);
    const shift = this.rng.uniform(-90, 90);
    const life = this.rng.uniform(0.06, 0.32);

    let i = this.tearCount;
    if (i >= MAX_TEARS) {
      // Python appends without limit and keeps the last twenty, so an overflow
      // costs the oldest tear.
      for (let k = 1; k < MAX_TEARS; k++) {
        this.tearY[k - 1] = this.tearY[k]!;
        this.tearH[k - 1] = this.tearH[k]!;
        this.tearX[k - 1] = this.tearX[k]!;
        this.tearLife[k - 1] = this.tearLife[k]!;
      }
      i = MAX_TEARS - 1;
    } else {
      this.tearCount++;
    }
    this.tearY[i] = y;
    this.tearH[i] = bh;
    this.tearX[i] = shift;
    this.tearLife[i] = life;
  }

  private expireTears(dt: number): void {
    let n = 0;
    for (let i = 0; i < this.tearCount; i++) {
      const life = this.tearLife[i]! - dt;
      if (life <= 0) continue;
      this.tearY[n] = this.tearY[i]!;
      this.tearH[n] = this.tearH[i]!;
      this.tearX[n] = this.tearX[i]!;
      this.tearLife[n] = life;
      n++;
    }
    this.tearCount = n;
  }

  private placeTears(): void {
    const w = this.w;
    for (let i = 0; i < MAX_TEARS; i++) {
      const band = this.tearBand[i]!;
      const top = this.tearTop[i]!;
      const bottom = this.tearBottom[i]!;
      if (i >= this.tearCount) {
        band.visible = false;
        top.visible = false;
        bottom.visible = false;
        continue;
      }
      const x = Math.trunc(this.tearX[i]!);
      const y = Math.trunc(this.tearY[i]!);
      const bh = Math.min(Math.trunc(this.tearH[i]!), TEAR_H);
      band.position.set(x, y);
      band.width = w;
      band.height = bh;
      band.visible = true;
      top.position.set(x, y);
      top.visible = true;
      // The band is `w` wide but starts at `shift`, so it hangs off one side;
      // the arena mask crops it, exactly as pygame's clip did.
      bottom.position.set(x - 6, y + bh);
      bottom.visible = true;
    }
  }

  // -------------------------------------------------------------------
  // build helpers
  // -------------------------------------------------------------------

  /** A soft horizontal band that sweeps down the arena. */
  private buildBar(): Texture {
    const canvas = createCanvas(this.w, BAR_H);
    const ctx = context2d(canvas);
    clearToBlack(ctx, canvas.width, canvas.height);
    ctx.globalCompositeOperation = "source-over";
    for (let yy = 0; yy < BAR_H; yy++) {
      const s = Math.sin((Math.PI * yy) / BAR_H);
      ctx.fillStyle = cssRgb(this.shade(this.theme.accent, 0.1 * (s * s)));
      ctx.fillRect(0, yy, this.w, 1);
    }
    return canvasTexture(canvas);
  }

  /**
   * One period of the scanline comb: two dark rows, two clear ones. Sampling
   * is nearest so the rows stay hard edges rather than a smeared ramp.
   */
  private buildScanlines(): Texture {
    const canvas = createCanvas(1, SCAN_PERIOD);
    const ctx = context2d(canvas);
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = "rgb(255,255,255)";
    ctx.fillRect(0, 0, 1, SCAN_PERIOD);
    ctx.fillStyle = "rgb(150,150,150)";
    ctx.fillRect(0, 0, 1, 2);
    return canvasTexture(canvas, { addressMode: "repeat", scaleMode: "nearest" });
  }
}
