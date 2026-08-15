/**
 * The cursor reticle - a port of `snake/gfx/ui.py:590-660` (`draw_cursor`).
 *
 * A comet trail, a rotating three-tick ring, four crosshair spurs and a bright
 * centre dot. Drawn by the shell above every scene and inside the post chain,
 * so it picks up the bloom and the CRT curve like everything else.
 *
 * Four details worth not "fixing":
 *
 * - **A resting pointer stacks the whole trail on one point.** The shell
 *   appends a sample every frame unconditionally, so when the mouse stops the
 *   fourteen samples collapse together, the twelve line segments become
 *   zero-length, and the additive dabs pile up into a bright core. That
 *   accumulation is most of what a resting reticle looks like.
 * - **The oldest segment is always skipped** (`f < 0.08` drops exactly the
 *   first one at fourteen samples) - deliberate anti-flicker while the buffer
 *   fills.
 * - **The halo and the core do not breathe, the ring does.** `base_r` carries
 *   the pulse; the 22 px outer glow and the 7 px core are fixed radii.
 * - **`held` is the LEFT button, not boost.** The Python reads mouse button 1;
 *   boost is button 3 and is read separately by the HUD. Map it to
 *   `pointer.down`, never `pointer.boost`.
 *
 * Two angle conventions collide inside one function, and both are reproduced:
 * `pygame.draw.arc` measures angles in a y-up frame, so its arcs sweep
 * anticlockwise on screen, while the spurs feed `cos`/`sin` straight into
 * y-down screen space and sweep clockwise. Canvas and Pixi are y-down, so the
 * arcs negate their angles and the spurs do not.
 */

import { Container, Graphics, Sprite } from "pixi.js";

import * as C from "../core/config";
import { pulse } from "../core/mathx";
import {
  UI_WHITE,
  lerpColor,
  shade,
  themeForLevel,
  toHex,
  type RGB,
  type Theme,
} from "../core/palette";
import { arcPath, uiGlowSprite, setUiGlow } from "./glow";

/** Trail samples below this fraction are skipped. ui.py:608 */
const TRAIL_MIN_F = 0.08;
/** Outer halo radius and its intensity scale. ui.py:627 */
const HALO_RADIUS = 22;
const HALO_INTENSITY = 0.45;
/** Core glow radius, mix toward white, and intensity scale. ui.py:657 */
const CORE_RADIUS = 7;
const CORE_MIX = 0.7;
const CORE_INTENSITY = 1.1;
/** Resting ring radius, the shrink while held, and the breathing amplitude. ui.py:624 */
const RING_BASE = 15.0;
const RING_HELD_SHRINK = 3.5;
const RING_PULSE = 1.2;
const RING_PULSE_SPEED = 3.0;
/** Brightness when the button is up. ui.py:625 */
const DIM = 0.72;
/** Ring spin rate, and the three ticks' arc length. ui.py:630, 637 */
const SPIN_RATE = 1.35;
const TICK_SWEEP = 0.85;
/** Spur geometry. ui.py:652 */
const SPUR_NEAR = 3.0;
const SPUR_FAR = 8.0;
/** Centre dot radius. ui.py:658 */
const DOT_RADIUS = 2;

/** What the cursor needs from the shell each frame. */
export interface CursorInput {
  readonly time: number;
  readonly levelIndex: number;
  readonly pointer: { x: number; y: number; down: boolean; touch: boolean };
  readonly trail: ReadonlyArray<{ x: number; y: number }>;
}

export class Cursor {
  readonly root = new Container();

  private readonly trailStrokes = new Graphics();
  private readonly dabs: Sprite[] = [];
  private readonly dabLayer = new Container();
  private readonly halo: Sprite;
  private readonly reticle = new Graphics();
  private readonly coreLo: Sprite;
  private readonly coreHi: Sprite;
  private readonly dot = new Graphics();

  constructor() {
    this.halo = uiGlowSprite(HALO_RADIUS, UI_WHITE, 0);
    this.coreLo = uiGlowSprite(CORE_RADIUS, UI_WHITE, 0);
    this.coreHi = uiGlowSprite(CORE_RADIUS, UI_WHITE, 0);

    // Exactly the Python's paint order.
    this.root.addChild(
      this.trailStrokes,
      this.dabLayer,
      this.halo,
      this.reticle,
      this.coreLo,
      this.coreHi,
      this.dot,
    );
    // Pooled to the trail cap, so no allocation happens on a draw path.
    for (let i = 0; i < C.CURSOR_TRAIL_LEN; i++) {
      const s = uiGlowSprite(4, UI_WHITE, 0);
      s.visible = false;
      this.dabs.push(s);
      this.dabLayer.addChild(s);
    }
  }

  draw(input: CursorInput): void {
    const { pointer } = input;
    // A touch device has no cursor to draw; the finger is the cursor.
    if (pointer.touch) {
      this.root.visible = false;
      return;
    }
    this.root.visible = true;

    const t = input.time;
    const theme: Theme = themeForLevel(input.levelIndex);
    const accent = theme.accent;
    const accent2 = theme.accent2;
    const mx = pointer.x;
    const my = pointer.y;

    this.drawTrail(input.trail, accent, accent2);

    // `held` is the left button. Boost is a different button entirely.
    const held = pointer.down;
    const baseR = RING_BASE - (held ? RING_HELD_SHRINK : 0) + RING_PULSE * pulse(t, RING_PULSE_SPEED);
    const bright = held ? 1.0 : DIM;

    this.halo.position.set(mx, my);
    setUiGlow(this.halo, HALO_RADIUS, accent, HALO_INTENSITY * bright);

    this.drawReticle(mx, my, baseR, t, bright, accent, accent2);

    // The core reaches intensity 1.1 while held; additive blending is linear,
    // so a second plate carries whatever runs past 1.
    const coreCol = lerpColor(accent, UI_WHITE, CORE_MIX);
    const power = CORE_INTENSITY * bright;
    for (const s of [this.coreLo, this.coreHi]) s.position.set(mx, my);
    setUiGlow(this.coreLo, CORE_RADIUS, coreCol, Math.min(1, power));
    if (power > 1) {
      setUiGlow(this.coreHi, CORE_RADIUS, coreCol, power - 1);
    } else {
      this.coreHi.visible = false;
    }

    this.dot
      .clear()
      .circle(mx, my, DOT_RADIUS)
      .fill({ color: toHex(UI_WHITE) });
  }

  private drawTrail(
    trail: ReadonlyArray<{ x: number; y: number }>,
    accent: RGB,
    accent2: RGB,
  ): void {
    const g = this.trailStrokes.clear();
    for (const s of this.dabs) s.visible = false;

    const n = trail.length;
    if (n < 2) return;

    let dab = 0;
    for (let i = 0; i < n - 1; i++) {
      const f = (i + 1) / (n - 1); // 0 at the oldest point
      if (f < TRAIL_MIN_F) continue;
      const a = trail[i]!;
      const b = trail[i + 1]!;
      const col = lerpColor(accent2, accent, f);

      g.moveTo(a.x, a.y)
        .lineTo(b.x, b.y)
        .stroke({
          color: toHex(shade(col, 0.25 + 0.65 * f * f)),
          width: Math.max(1, Math.trunc(1 + 4 * f)),
        });

      // Additive dabs thicken and brighten the streak toward the head.
      const s = this.dabs[dab++];
      if (s) {
        s.position.set(b.x, b.y);
        setUiGlow(s, 4 + 9 * f, col, 0.18 + 0.5 * f * f);
      }
    }
  }

  private drawReticle(
    mx: number,
    my: number,
    baseR: number,
    t: number,
    bright: number,
    accent: RGB,
    accent2: RGB,
  ): void {
    const g = this.reticle.clear();
    const spin = t * SPIN_RATE;

    // Three ticks sweeping around the outside. pygame's arc is y-up, so the
    // angles are negated and the endpoints swapped to sweep the same way.
    const tickCol = toHex(lerpColor(accent, UI_WHITE, 0.25 * bright));
    for (let k = 0; k < 3; k++) {
      const a0 = spin + (k * Math.PI * 2) / 3;
      const a1 = a0 + TICK_SWEEP;
      arcPath(g, mx, my, baseR, -a1, -a0).stroke({ color: tickCol, width: 2 });
    }

    // A faint near-complete inner ring, spinning the other way. Note the rect
    // Python builds is `base_r * 1.1` across, so this radius is base_r * 0.55 -
    // barely half the tick ring, not 1.1x it.
    const innerR = baseR * 0.55;
    const s0 = -spin * 0.7;
    arcPath(g, mx, my, innerR, -(s0 + Math.PI * 2 * 0.999), -s0).stroke({
      color: toHex(shade(accent2, 0.6)),
      width: 1,
    });

    // Four crosshair spurs. These feed cos/sin straight into screen space, so
    // unlike the arcs they are already in the y-down convention.
    const spurCol = toHex(shade(accent, 0.75));
    for (let k = 0; k < 4; k++) {
      const ang = spin * -0.5 + k * (Math.PI * 0.5);
      const ca = Math.cos(ang);
      const sa = Math.sin(ang);
      const r0 = baseR + SPUR_NEAR;
      const r1 = baseR + SPUR_FAR;
      g.moveTo(mx + ca * r0, my + sa * r0)
        .lineTo(mx + ca * r1, my + sa * r1)
        .stroke({ color: spurCol, width: 1 });
    }
  }

  destroy(): void {
    this.root.destroy({ children: true });
  }
}
