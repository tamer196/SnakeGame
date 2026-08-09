/**
 * Unified pointer input: mouse, touch and pen.
 *
 * The control scheme is chosen per device class, and the reason is physical.
 * At the shipping uniform scale, the snake is about 2.3 mm wide on a phone and
 * a hand resting on the glass covers roughly 72% of the arena's height; on a
 * tablet the same hand covers about 36%. So a scheme where the finger sits on
 * the destination is fine on a tablet and unusable on a phone.
 *
 *   mouse   desktop. The cursor IS the target, exactly as the Python game.
 *           Right button boosts.
 *   drag    phone. Floating relative drag: touch anywhere, and the *angle*
 *           from the anchor to the finger steers. Magnitude is ignored,
 *           because the snake has no throttle - only heading matters. The
 *           hand never has to cover the destination.
 *   offset  tablet. The aim point leads the finger by ~85 design px in the
 *           direction of travel, so the reticle stays visible past the
 *           fingertip. Falls back to direct touch near the arena edges, where
 *           an offset would push the target off-screen.
 *
 * Boost is a real resource (2.17 s of drain, 3.85 s to refill), so it stays a
 * deliberate act: a second simultaneous touch, which costs no screen space and
 * needs no aiming. A visible button is drawn by the HUD to teach it.
 */

import * as C from "../core/config";
import { clamp, TAU } from "../core/mathx";
import type { Game } from "../app/Game";

export type ControlScheme = "mouse" | "drag" | "offset";

interface TouchRec {
  id: number;
  /** Anchor in design space, where the drag began. */
  ax: number;
  ay: number;
  /** Current position in design space. */
  x: number;
  y: number;
  /** Last movement direction, for the tablet lead offset. */
  vx: number;
  vy: number;
  startedAt: number;
}

export class InputManager {
  scheme: ControlScheme = "mouse";
  /** Player is actively steering this frame. */
  steerActive = false;
  /** Boost requested. */
  boost = false;
  /** Set when the player has ever used touch, so hover states can be dropped. */
  usedTouch = false;
  /** Steering side for the phone scheme; flipped in settings for left-handers. */
  steerSide: "left" | "right" | "any" = "any";

  private game: Game;
  private el: HTMLElement;
  private touches = new Map<number, TouchRec>();
  private steerId: number | null = null;
  private mouseButtons = new Set<number>();
  private lastAngle = 0;
  private hasAngle = false;
  private detachers: Array<() => void> = [];

  constructor(game: Game, el: HTMLElement) {
    this.game = game;
    this.el = el;
    this.scheme = this.pickScheme();
    this.attach();
  }

  private pickScheme(): ControlScheme {
    if (typeof window === "undefined") return "mouse";
    const coarse = window.matchMedia?.("(pointer: coarse)")?.matches ?? false;
    if (!coarse) return "mouse";
    return this.game.viewport.isTabletOrLarger ? "offset" : "drag";
  }

  /** Re-evaluate after a resize: a rotated phone is still a phone. */
  refreshScheme(): void {
    if (this.usedTouch) this.scheme = this.pickScheme();
  }

  // -------------------------------------------------------------------
  // event plumbing
  // -------------------------------------------------------------------
  private attach(): void {
    const el = this.el;
    const opts: AddEventListenerOptions = { passive: false };

    const down = (e: PointerEvent) => this.onDown(e);
    const move = (e: PointerEvent) => this.onMove(e);
    const up = (e: PointerEvent) => this.onUp(e);
    const cancel = (e: PointerEvent) => this.onUp(e);
    const menu = (e: Event) => e.preventDefault();
    const blur = () => this.reset();

    el.addEventListener("pointerdown", down, opts);
    window.addEventListener("pointermove", move, opts);
    window.addEventListener("pointerup", up, opts);
    window.addEventListener("pointercancel", cancel, opts);
    // Right-click boosts, so the context menu must never appear.
    el.addEventListener("contextmenu", menu);
    window.addEventListener("blur", blur);

    this.detachers = [
      () => el.removeEventListener("pointerdown", down),
      () => window.removeEventListener("pointermove", move),
      () => window.removeEventListener("pointerup", up),
      () => window.removeEventListener("pointercancel", cancel),
      () => el.removeEventListener("contextmenu", menu),
      () => window.removeEventListener("blur", blur),
    ];
  }

  detach(): void {
    for (const fn of this.detachers) fn();
    this.detachers = [];
  }

  private toDesign(e: PointerEvent): { x: number; y: number } {
    return this.game.viewport.toDesign(e.clientX, e.clientY);
  }

  private onDown(e: PointerEvent): void {
    e.preventDefault();

    if (e.pointerType === "mouse") {
      this.mouseButtons.add(e.button);
      const p = this.toDesign(e);
      this.setPointer(p.x, p.y, false);
      this.game.pointer.down = this.mouseButtons.has(0);
      return;
    }

    this.usedTouch = true;
    this.game.pointer.touch = true;
    if (this.scheme === "mouse") this.scheme = this.pickScheme();

    const p = this.toDesign(e);
    const rec: TouchRec = {
      id: e.pointerId,
      ax: p.x,
      ay: p.y,
      x: p.x,
      y: p.y,
      vx: 0,
      vy: 0,
      startedAt: performance.now(),
    };
    this.touches.set(e.pointerId, rec);

    if (this.steerId === null && this.acceptsSteer(p.x)) {
      this.steerId = e.pointerId;
      this.setPointer(p.x, p.y, true);
    }
    this.game.pointer.down = true;
    this.updateBoost();
  }

  private onMove(e: PointerEvent): void {
    if (e.pointerType === "mouse") {
      const p = this.toDesign(e);
      this.setPointer(p.x, p.y, false);
      return;
    }
    const rec = this.touches.get(e.pointerId);
    if (!rec) return;
    e.preventDefault();

    const p = this.toDesign(e);
    rec.vx = p.x - rec.x;
    rec.vy = p.y - rec.y;
    rec.x = p.x;
    rec.y = p.y;

    if (e.pointerId === this.steerId) this.setPointer(p.x, p.y, true);
  }

  private onUp(e: PointerEvent): void {
    if (e.pointerType === "mouse") {
      this.mouseButtons.delete(e.button);
      this.game.pointer.down = this.mouseButtons.has(0);
      this.updateBoost();
      return;
    }
    this.touches.delete(e.pointerId);
    if (this.steerId === e.pointerId) {
      this.steerId = null;
      this.steerActive = false;
      // Promote another live touch to steering, so lifting the boost finger
      // and the steer finger in the wrong order does not drop control.
      for (const rec of this.touches.values()) {
        if (this.acceptsSteer(rec.ax)) {
          this.steerId = rec.id;
          this.setPointer(rec.x, rec.y, true);
          break;
        }
      }
    }
    this.game.pointer.down = this.touches.size > 0;
    this.updateBoost();
  }

  private acceptsSteer(designX: number): boolean {
    if (this.steerSide === "any") return true;
    const mid = C.WINDOW_W * 0.5;
    return this.steerSide === "left" ? designX < mid : designX >= mid;
  }

  private updateBoost(): void {
    // Mouse: right button. Touch: any second simultaneous finger.
    this.boost =
      this.mouseButtons.has(2) || (this.touches.size >= 2 && this.steerId !== null);
    this.game.pointer.boost = this.boost;
  }

  private setPointer(x: number, y: number, steering: boolean): void {
    this.game.pointer.x = x;
    this.game.pointer.y = y;
    if (steering) this.steerActive = true;
  }

  reset(): void {
    this.touches.clear();
    this.mouseButtons.clear();
    this.steerId = null;
    this.steerActive = false;
    this.boost = false;
    this.game.pointer.down = false;
    this.game.pointer.boost = false;
  }

  // -------------------------------------------------------------------
  // steering
  // -------------------------------------------------------------------
  /**
   * The point the snake should chase, given where its head currently is.
   *
   * Returns null to mean "hold the current heading" - the deadzone case, and
   * the case where no finger is down on a touch device. The gameplay scene
   * calls this once per frame; UI scenes ignore it and use pointer.x/y.
   */
  getSteerTarget(headX: number, headY: number): { x: number; y: number } | null {
    switch (this.scheme) {
      case "mouse":
        return { x: this.game.pointer.x, y: this.game.pointer.y };

      case "drag": {
        const rec = this.steerId !== null ? this.touches.get(this.steerId) : undefined;
        if (!rec) return this.holdHeading(headX, headY);

        const dz = this.game.viewport.cssToDesign(C.TOUCH_STEER_DEADZONE_PX);
        const dx = rec.x - rec.ax;
        const dy = rec.y - rec.ay;
        if (Math.hypot(dx, dy) < dz) return this.holdHeading(headX, headY);

        // Angle only: the snake has no throttle, so distance is meaningless.
        const a = Math.atan2(dy, dx);
        this.lastAngle = a;
        this.hasAngle = true;
        return {
          x: headX + Math.cos(a) * C.TOUCH_AIM_DISTANCE,
          y: headY + Math.sin(a) * C.TOUCH_AIM_DISTANCE,
        };
      }

      case "offset": {
        const rec = this.steerId !== null ? this.touches.get(this.steerId) : undefined;
        if (!rec) return this.holdHeading(headX, headY);

        // Lead the finger in the direction of travel so the aim point clears
        // the fingertip; fall back to "toward the top" when static.
        let ox = rec.vx;
        let oy = rec.vy;
        const mag = Math.hypot(ox, oy);
        if (mag < 0.5) {
          ox = 0;
          oy = -1;
        } else {
          ox /= mag;
          oy /= mag;
        }

        // Decay the lead near the arena edge, or the target leaves the board.
        const edge = this.edgeFalloff(rec.x, rec.y);
        const lead = C.TOUCH_TABLET_OFFSET * edge;
        return { x: rec.x + ox * lead, y: rec.y + oy * lead };
      }
    }
  }

  /** 1 in the middle of the arena, falling to 0 at its edges. */
  private edgeFalloff(x: number, y: number): number {
    const pad = C.TOUCH_TABLET_OFFSET * 1.5;
    const fx = clamp(
      Math.min(x - C.ARENA_X, C.ARENA_X + C.ARENA_W - x) / pad,
      0,
      1,
    );
    const fy = clamp(
      Math.min(y - C.ARENA_Y, C.ARENA_Y + C.ARENA_H - y) / pad,
      0,
      1,
    );
    return Math.min(fx, fy);
  }

  /** Keep flying the last commanded heading when the finger lifts. */
  private holdHeading(headX: number, headY: number): { x: number; y: number } | null {
    this.steerActive = false;
    if (!this.hasAngle) return null;
    return {
      x: headX + Math.cos(this.lastAngle) * C.TOUCH_AIM_DISTANCE,
      y: headY + Math.sin(this.lastAngle) * C.TOUCH_AIM_DISTANCE,
    };
  }

  /** Per-frame housekeeping: slowly recentre the drag anchor. */
  update(dt: number): void {
    if (this.scheme !== "drag" || this.steerId === null) return;
    const rec = this.touches.get(this.steerId);
    if (!rec) return;

    // Drift the anchor toward the finger so a long drag never runs out of
    // thumb travel. Slow enough that it does not fight deliberate steering.
    const rate = this.game.viewport.cssToDesign(C.TOUCH_ANCHOR_RECENTRE) * dt;
    const dx = rec.x - rec.ax;
    const dy = rec.y - rec.ay;
    const d = Math.hypot(dx, dy);
    if (d > 1e-3) {
      const step = Math.min(rate, d);
      rec.ax += (dx / d) * step;
      rec.ay += (dy / d) * step;
    }
  }

  /** Current steering angle, for drawing the on-screen stick. */
  get anchorInfo(): { ax: number; ay: number; x: number; y: number } | null {
    if (this.steerId === null) return null;
    const rec = this.touches.get(this.steerId);
    if (!rec) return null;
    return { ax: rec.ax, ay: rec.ay, x: rec.x, y: rec.y };
  }
}

export function attachInput(game: Game, el: HTMLElement): InputManager {
  const mgr = new InputManager(game, el);
  game.input = mgr;
  return mgr;
}

export { TAU };
