/**
 * The channel between the gameplay simulation and everything you can see or
 * hear.
 *
 * `GameplayWorld` runs the whole level - clocks, collisions, scoring, damage -
 * without importing Pixi, the audio engine or anything else that needs a
 * browser. It reports what happened through this interface, and the gameplay
 * scene implements it by firing particles, shaking the screen and playing
 * sounds.
 *
 * That split is not decoration. It means the rules of the game can be tested
 * in Node, at speed, the same way the simulation underneath them already is:
 * drive a level with a scripted pointer, assert the score, the lives and the
 * star rating. A renderer in the middle of that would make it untestable, and
 * these are exactly the rules that are easy to get subtly wrong.
 *
 * Every method must tolerate being called at any time and must never throw -
 * the world calls them inside its own frame guard, and a presentation failure
 * should cost you a spark, not the run.
 */

import type { RGB } from "../core/palette";

/** A range, as the Python emitters take them. */
export type Range = readonly [number, number];

export interface TrailOptions {
  rate: number;
  speed: Range;
  /** Radians of spread around the emission direction. */
  spread?: number;
  life?: Range;
  radius?: Range;
}

export interface BurstOptions {
  count: number;
  speed: Range;
  life: Range;
  radius?: Range;
}

export interface RingOptions {
  radius: number;
  count: number;
  life: number;
  speed?: number;
}

export interface GameplayPresenter {
  // -- particles ----------------------------------------------------------
  /** A continuous wake. `dt` decides how many particles this frame earns. */
  trail(x: number, y: number, color: RGB, dt: number, opts: TrailOptions): void;
  /** A one-shot spray. */
  burst(x: number, y: number, color: RGB, opts: BurstOptions): void;
  /** A one-shot expanding ring. */
  ring(x: number, y: number, color: RGB, opts: RingOptions): void;
  /** Drifting motes across the arena. */
  ambient(color: RGB, dt: number, rate: number): void;
  /** Drop every live particle - used when a level is (re)entered. */
  clearParticles(): void;

  // -- screen feedback ----------------------------------------------------
  shake(magnitude: number): void;
  flash(color: RGB, strength: number): void;
  /** Hit-stop: run the simulation at `scale` for `seconds` of real time. */
  slowmo(scale: number, seconds: number): void;
  /**
   * The current simulation time scale, 0.05..1. The world multiplies its
   * `dt` by this and by nothing else; the UI keeps running at real time.
   */
  timeScale(): number;
  /** Tint future transitions with the level's accent. */
  setTheme(color: RGB): void;

  // -- audio --------------------------------------------------------------
  /** `volume` is a scale on the cue's own level, 0..1. */
  audio(name: string, volume?: number): void;
}

/**
 * Score popups are deliberately *not* on this interface. The world owns them
 * as plain data on `GameplayWorld.popups`, because their position and lifetime
 * are rules (they rise on real time, they cap at 24) rather than decoration.
 * The scene syncs a pool of text objects to that list each frame. Routing them
 * through here as events as well would give the same fact two owners.
 */

/**
 * A presenter that does nothing, for headless tests and for the brief window
 * during construction before the scene has wired itself up.
 */
export class SilentPresenter implements GameplayPresenter {
  trail(_x: number, _y: number, _color: RGB, _dt: number, _opts: TrailOptions): void {}
  burst(_x: number, _y: number, _color: RGB, _opts: BurstOptions): void {}
  ring(_x: number, _y: number, _color: RGB, _opts: RingOptions): void {}
  ambient(_color: RGB, _dt: number, _rate: number): void {}
  clearParticles(): void {}
  shake(_magnitude: number): void {}
  flash(_color: RGB, _strength: number): void {}
  slowmo(_scale: number, _seconds: number): void {}
  timeScale(): number {
    return 1;
  }
  setTheme(_color: RGB): void {}
  audio(_name: string, _volume?: number): void {}
}

/**
 * A presenter that records every call, so a test can assert that eating a
 * bonus orb really did flash the screen and play the right cue.
 */
export interface RecordedCall {
  readonly kind: string;
  readonly args: readonly unknown[];
}

export class RecordingPresenter extends SilentPresenter {
  readonly calls: RecordedCall[] = [];
  private scale = 1;

  private note(kind: string, ...args: unknown[]): void {
    this.calls.push({ kind, args });
  }

  override trail(x: number, y: number, color: RGB, dt: number, opts: TrailOptions): void {
    this.note("trail", x, y, color, dt, opts);
  }
  override burst(x: number, y: number, color: RGB, opts: BurstOptions): void {
    this.note("burst", x, y, color, opts);
  }
  override ring(x: number, y: number, color: RGB, opts: RingOptions): void {
    this.note("ring", x, y, color, opts);
  }
  override ambient(color: RGB, dt: number, rate: number): void {
    this.note("ambient", color, dt, rate);
  }
  override clearParticles(): void {
    this.note("clearParticles");
  }
  override shake(magnitude: number): void {
    this.note("shake", magnitude);
  }
  override flash(color: RGB, strength: number): void {
    this.note("flash", color, strength);
  }
  override slowmo(scale: number, seconds: number): void {
    this.note("slowmo", scale, seconds);
  }
  override setTheme(color: RGB): void {
    this.note("setTheme", color);
  }
  override audio(name: string, volume?: number): void {
    this.note("audio", name, volume);
  }

  override timeScale(): number {
    return this.scale;
  }

  /** Force a time scale, to test that slow motion only touches the sim clock. */
  setTimeScale(v: number): void {
    this.scale = v;
  }

  /** Every call of one kind, in order. */
  of(kind: string): RecordedCall[] {
    return this.calls.filter((c) => c.kind === kind);
  }

  /** Cue names played so far, in order. */
  cues(): string[] {
    return this.of("audio").map((c) => String(c.args[0]));
  }

  reset(): void {
    this.calls.length = 0;
  }
}
