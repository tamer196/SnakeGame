/**
 * Power-up runes, drawn from `snake/core/powerups.py`.
 *
 * One draw path for all six kinds; only the emblem and the base colour differ.
 * The colours are deliberately theme-independent - a player has to read a
 * power-up at a glance on all twelve palettes, so each kind owns a fixed,
 * well-separated hue and the level theme gets a single 28% bleed into the
 * orbit ring. Do not "harmonise" them with the theme.
 *
 * Compositing. Python paints the halo straight onto the frame with render.py's
 * **soft** glow (not the hard hazard one - the two systems are different and
 * both ship), then paints the hexagram, ring, nodes and core onto a scratch
 * surface where they *overwrite* each other, and adds the whole scratch to the
 * frame. Here they are one additive `Graphics`, so overlaps add instead of
 * overwriting. The only place that could show is the core disc over a node or
 * the ring, and it cannot happen: `ring_r` is 23 px while the core tops out
 * near 7. The invariant is asserted below so a future `POWERUP_RADIUS` change
 * cannot make it wrong silently.
 *
 * Timing to get right: the expiry strobe's instantaneous rate is
 * `freq + 6.667 * age`, not `freq` - about 10 Hz rising to 15 Hz. Reading
 * `freq` as the rate gives a lazy 1 Hz blink that looks nothing like the
 * original. That maths lives in `powerUpBrightness`, which is already ported;
 * this file just must not second-guess it.
 */

import { Container, Graphics, Sprite } from "pixi.js";

import { TAU, clamp, pulse } from "../../core/mathx";
import { lerpColor, shade, toHex, type RGB, type Theme } from "../../core/palette";
import {
  CORE_PULSE_SPEED,
  GLOW_SCALE,
  ORBIT_NODES,
  ORBIT_SPEED,
  SPIN_SPEED,
  powerUpBrightness,
  powerUpDrawRadius,
  powerupColor,
  type PowerUp,
} from "../../core/powerups";
import { glowSprite, setGlow } from "../textures";
import type { FrameClocks } from "./clocks";
import { runeGlyphTexture } from "./runeGlyphs";

/** Pure white, as `powerups.py` spells it. Not `UI_WHITE`, which is bluish. */
const WHITE: RGB = [255, 255, 255];

let overlapWarned = false;

/** One rune's display objects, reused across runes and across levels. */
class RuneView {
  readonly container = new Container();
  readonly halo: Sprite;
  readonly ring = new Graphics();
  readonly glyph = new Sprite();

  constructor() {
    this.halo = glowSprite(1, WHITE, 0);
    this.ring.blendMode = "add";
    this.glyph.anchor.set(0.5);
    this.glyph.blendMode = "add";
    this.container.addChild(this.halo, this.ring, this.glyph);
  }

  destroy(): void {
    this.container.destroy({ children: true });
  }
}

/**
 * Draws the runes on the field.
 *
 * Add {@link RuneRenderer.container} to the masked world container, above food
 * and below the snake. At most `MAX_ACTIVE` runes exist at once, so the pool
 * never grows past a couple of entries.
 */
export class RuneRenderer {
  readonly container = new Container();

  private readonly views: RuneView[] = [];
  private accent: RGB = [255, 255, 255];

  /**
   * The level theme. Only `accent` is read, but the whole theme is taken from
   * the caller: `PowerUpField.theme` is a one-key slice and cannot carry a
   * palette.
   */
  setTheme(theme: Theme): void {
    this.accent = theme.accent;
  }

  /** Repaint from the scene clock. Runes are not on the hazard clock. */
  draw(items: readonly PowerUp[], clocks: FrameClocks): void {
    // A non-finite clock poisons vertices instead of throwing; hold the frame.
    if (!Number.isFinite(clocks.t)) return;
    while (this.views.length < items.length) {
      const view = new RuneView();
      this.views.push(view);
      this.container.addChild(view.container);
    }
    for (let i = 0; i < this.views.length; i++) {
      const view = this.views[i];
      if (view === undefined) continue;
      const item = items[i];
      if (item === undefined) {
        view.container.visible = false;
        continue;
      }
      view.container.visible = true;
      this.drawRune(view, item, clocks.t);
    }
  }

  /** Drop the pool. Baked emblem textures survive - see the barrel. */
  destroy(): void {
    for (const view of this.views) view.destroy();
    this.views.length = 0;
    this.container.destroy({ children: true });
  }

  private drawRune(view: RuneView, p: PowerUp, t: number): void {
    // `brightness()` never drops below 0.30, so Python's `bright <= 0.02`
    // early-out is dead code and is not ported: a rune strobes to the end and
    // then is removed outright.
    const bright = powerUpBrightness(p);
    const r = powerUpDrawRadius(p);
    const col = powerupColor(p.kind);
    const ringCol = lerpColor(col, this.accent, 0.28);

    view.container.position.set(p.x, p.y);

    // The halo breathes on the item's own age, so two runes drift apart...
    const breathe = 0.72 + 0.28 * pulse(p.age * CORE_PULSE_SPEED * 0.6 + p.phase);
    setGlow(view.halo, r * GLOW_SCALE, col, 0.55 * bright * breathe);

    // ...while the spin runs on the shared clock, so every rune turns in sync.
    const tt = t > 0 ? t : p.age;
    const spin = tt * SPIN_SPEED * p.spin + p.phase;

    const g = view.ring;
    g.clear();

    // Two counter-rotating triangles: a Star of David at spin 0, shearing
    // slowly apart from there.
    const triR = r * 1.46;
    const lw = Math.max(1, Math.trunc(r * 0.13));
    const triCol = toHex(shade(ringCol, 0.42 * bright));
    for (let sense = 1; sense >= -1; sense -= 2) {
      const a0 = spin * sense + (sense > 0 ? 0.0 : Math.PI / 3.0);
      const pts: number[] = [];
      for (let k = 0; k < 3; k++) {
        const a = a0 + (k * TAU) / 3.0;
        pts.push(Math.cos(a) * triR, Math.sin(a) * triR);
      }
      g.poly(pts, true).stroke({ color: triCol, width: lw, alpha: 1 });
    }

    const ringR = Math.trunc(r * 1.8);
    if (ringR > 2) {
      g.circle(0, 0, ringR).stroke({
        color: toHex(shade(ringCol, 0.3 * bright)),
        width: Math.max(1, lw - 1),
        alignment: 1,
      });
    }

    // Nodes orbit against the triangles for a geared, mechanical read, and the
    // depth term brightens the ones at the bottom of the orbit.
    const orbit = -tt * ORBIT_SPEED * p.spin + p.phase;
    const nodeR = Math.max(2, Math.trunc(r * 0.19));
    for (let k = 0; k < ORBIT_NODES; k++) {
      const a = orbit + (k * TAU) / ORBIT_NODES;
      const depth = 0.55 + 0.45 * (0.5 + 0.5 * Math.sin(a));
      g.circle(Math.cos(a) * ringR, Math.sin(a) * ringR, nodeR).fill({
        color: toHex(shade(ringCol, bright * depth)),
        alpha: 1,
      });
    }

    // A backlight, not a headlight: the emblem sits on top of this and has to
    // stay legible.
    const core = r * (0.5 + 0.06 * pulse(p.age * CORE_PULSE_SPEED + p.phase));
    g.circle(0, 0, Math.max(2, Math.trunc(core))).fill({
      color: toHex(shade(col, 0.3 * bright)),
      alpha: 1,
    });
    g.circle(0, 0, Math.max(1, Math.trunc(core * 0.45))).fill({
      color: toHex(shade(lerpColor(col, WHITE, 0.5), 0.42 * bright)),
      alpha: 1,
    });

    if (!overlapWarned && ringR - nodeR <= core * 1.05) {
      overlapWarned = true;
      console.warn(
        "gfx/entities: rune core now reaches the orbit ring; the flat additive " +
          "Graphics no longer matches Python's overwriting scratch surface. " +
          "Split the ring assembly and the core into a RenderTexture.",
      );
    }

    const tex = runeGlyphTexture(p.kind, r * 1.55);
    if (view.glyph.texture !== tex) view.glyph.texture = tex;
    view.glyph.width = tex.width;
    view.glyph.height = tex.height;
    view.glyph.tint = toHex(lerpColor(col, WHITE, 0.55));
    view.glyph.alpha = clamp(bright, 0, 1);
  }
}
