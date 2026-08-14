/**
 * The sound engine - a port of the `Audio` facade in `snake/core/audio.py`.
 *
 * Everything audible is synthesised by `recipes.ts`; this file is only the part
 * that has to talk to the browser. It bakes each cue once into an `AudioBuffer`
 * and plays it through `AudioBufferSourceNode -> per-voice gain -> master gain
 * -> destination`, which is the Web Audio equivalent of pygame's per-channel
 * volume: overlapping copies of the same cue stay independent.
 *
 * Three problems the Python did not have:
 *
 * *   **The context starts suspended.** A browser will not let a page make
 *     noise until the user has touched it, so there is an {@link Audio.unlock}
 *     the app calls from the first pointerdown/touchend/keydown (or via
 *     {@link installUnlockGesture}). Until it succeeds, {@link Audio.play} is a
 *     silent no-op. It deliberately does *not* queue: a queue would replay a
 *     minute of menu clicks in one burst the moment the user finally taps.
 *
 * *   **Baking costs a frame.** All twelve cues take about 24 ms to synthesise
 *     at 48 kHz (measured under Node on this machine; a mid-range phone is
 *     perhaps four times that). Doing it in one go would visibly hitch, so
 *     {@link Audio.unlock} bakes one cue per task and yields in between, and
 *     {@link Audio.play} bakes on demand - about 2 ms - if a cue is asked for
 *     before the queue reaches it.
 *
 * *   **The sample rate is the device's.** Python bakes at whatever the mixer
 *     opened; here that is `AudioContext.sampleRate`, usually 48000. The
 *     recipes are parameterised by rate for exactly this reason, so no
 *     resampling happens and no cue changes pitch.
 *
 * Nothing here may throw. A machine with no audio device, an `AudioContext`
 * constructor that is missing or refuses to start, a browser that rejects
 * `resume()` - all of them leave the game running silently, which is what the
 * Python's headless path does.
 *
 * One deliberate difference from Python: `has(name)` answers "is this a cue the
 * build knows", not "is it baked". Before the first user gesture nothing is
 * baked at all, so the Python meaning would make the method useless to a menu
 * trying to decide whether a cue exists. {@link Audio.isBaked} is the other
 * question.
 */

import { clamp } from "../core/mathx";

import { SOUND_NAMES, isSoundName, renderSound, type SoundName } from "./recipes";

// ==========================================================================
// Mix levels, from audio.py
// ==========================================================================

const MASTER_VOLUME = 0.72;

// Per-sound trim so that a quiet tick and a death sting sit at sane relative
// levels without having to normalise every buffer to the same peak.
const GAIN: Record<string, number> = {
  eat: 0.50, bonus: 0.55, powerup: 0.60, hit: 0.72,
  die: 0.70, click: 0.34, hover: 0.15, start: 0.60,
  levelup: 0.66, win: 0.72, boost: 0.44, portal: 0.52,
};

// Minimum seconds between two plays of the same cue. Gameplay can fire "eat"
// or "hover" many times in a single frame; without this the mixer turns into
// mush and the volume stacks painfully.
const MIN_INTERVAL: Record<string, number> = {
  eat: 0.030, hover: 0.070, click: 0.040, boost: 0.090,
  hit: 0.060, portal: 0.120,
};
const DEFAULT_INTERVAL = 0.020;

/** The cue's own trim, before the caller's volume and the master. */
export function soundGain(name: string): number {
  return GAIN[name] ?? 0.5;
}

/** Seconds this cue must wait before it may retrigger. */
export function minInterval(name: string): number {
  return MIN_INTERVAL[name] ?? DEFAULT_INTERVAL;
}

/**
 * The gain one voice is played at.
 *
 * Split out from the engine because it is the only interesting arithmetic in
 * the playback path and it can then be tested without a browser.
 */
export function voiceGain(name: string, volume: number, master: number): number {
  return clamp(soundGain(name) * volume * master, 0.0, 1.0);
}

// ==========================================================================
// The slice of Web Audio this engine drives
// ==========================================================================

/**
 * Structural views of the four node types used below.
 *
 * These exist so the engine can be exercised against a stub in a Node test.
 * `defaultContext` returns a real `AudioContext` through this type, so the
 * compiler still checks that the shapes describe the actual API.
 */
export interface AudioParamLike {
  value: number;
}

export interface AudioNodeLike {
  connect(destination: AudioNodeLike): unknown;
  disconnect(): void;
}

export interface GainNodeLike extends AudioNodeLike {
  readonly gain: AudioParamLike;
}

export interface AudioBufferLike {
  readonly duration: number;
  getChannelData(channel: number): Float32Array;
}

export interface AudioBufferSourceLike extends AudioNodeLike {
  buffer: AudioBufferLike | null;
  start(when?: number): void;
  stop(when?: number): void;
}

export interface AudioContextLike {
  readonly state: string;
  readonly currentTime: number;
  readonly sampleRate: number;
  readonly destination: AudioNodeLike;
  resume(): Promise<void>;
  close(): Promise<void>;
  createBuffer(channels: number, length: number, sampleRate: number): AudioBufferLike;
  createBufferSource(): AudioBufferSourceLike;
  createGain(): GainNodeLike;
}

/** Construct the platform's context, or null where there is not one. */
function defaultContext(): AudioContextLike | null {
  try {
    const g = globalThis as unknown as {
      AudioContext?: typeof AudioContext;
      webkitAudioContext?: typeof AudioContext;
    };
    const Ctor = g.AudioContext ?? g.webkitAudioContext;
    if (Ctor === undefined) return null;
    return new Ctor();
  } catch {
    // Some embedded WebViews expose the constructor but refuse to build one.
    return null;
  }
}

/** A voice currently sounding, kept only so {@link Audio.stopAll} can cut it. */
interface Voice {
  src: AudioBufferSourceLike;
  gain: GainNodeLike;
  endsAt: number;
}

export interface AudioOptions {
  muted?: boolean;
  /** Never touch the browser at all, mirroring Python's `headless=True`. */
  headless?: boolean;
  /** Supply the context. Tests inject a stub; the app should leave it alone. */
  createContext?: () => AudioContextLike | null;
}

// ==========================================================================
// The engine
// ==========================================================================

export class Audio {
  muted: boolean;
  readonly headless: boolean;
  master: number = MASTER_VOLUME;

  private ctx: AudioContextLike | null = null;
  private masterGain: GainNodeLike | null = null;
  private readonly makeContext: () => AudioContextLike | null;

  private readonly bank = new Map<SoundName, AudioBufferLike>();
  private readonly lastPlay = new Map<string, number>();
  private live: Voice[] = [];

  private unlocking: Promise<boolean> | null = null;
  private bakeQueue: SoundName[] = [];
  private bakeTimer: ReturnType<typeof setTimeout> | null = null;
  private dead = false;

  constructor(opts: AudioOptions = {}) {
    this.muted = Boolean(opts.muted);
    this.headless = Boolean(opts.headless);
    this.makeContext = opts.createContext ?? defaultContext;
  }

  /** True once a context exists and is actually running. */
  get available(): boolean {
    return this.ctx !== null && this.ctx.state === "running";
  }

  /** The rate cues are baked at, or 0 before there is a context. */
  get sampleRate(): number {
    return this.ctx === null ? 0 : this.ctx.sampleRate;
  }

  // -- unlock ------------------------------------------------------------

  /**
   * Bring the context up. Safe and cheap to call on every gesture.
   *
   * Concurrent calls share one attempt. A *failed* attempt is forgotten so a
   * later gesture can try again - iOS occasionally refuses the first one.
   */
  unlock(): Promise<boolean> {
    if (this.dead) return Promise.resolve(false);
    if (this.available) return Promise.resolve(true);
    const inFlight = this.unlocking;
    if (inFlight !== null) return inFlight;
    const attempt = this.openContext().then(
      (ok) => {
        if (!ok) this.unlocking = null;
        return ok;
      },
      () => {
        this.unlocking = null;
        return false;
      },
    );
    this.unlocking = attempt;
    return attempt;
  }

  /** Alias for {@link Audio.unlock}, named after the Web Audio call it makes. */
  resume(): Promise<boolean> {
    return this.unlock();
  }

  private async openContext(): Promise<boolean> {
    if (this.headless) return false;
    if (this.ctx === null) {
      const ctx = this.makeContext();
      if (ctx === null) return false;
      try {
        const gain = ctx.createGain();
        gain.gain.value = 1.0;
        gain.connect(ctx.destination);
        this.ctx = ctx;
        this.masterGain = gain;
      } catch {
        return false;
      }
    }
    if (this.ctx.state !== "running") {
      try {
        await this.ctx.resume();
      } catch {
        // A browser that will not start stays silent; the game plays on.
      }
    }
    if (this.ctx.state !== "running") return false;
    this.scheduleBake();
    return true;
  }

  // -- baking ------------------------------------------------------------

  /**
   * Walk the catalogue one cue per task.
   *
   * `setTimeout` rather than a microtask on purpose: a microtask would run
   * before the browser gets to paint, which is the hitch this is avoiding.
   */
  private scheduleBake(): void {
    if (this.bakeTimer !== null || this.dead) return;
    this.bakeQueue = SOUND_NAMES.filter((n) => !this.bank.has(n));
    if (this.bakeQueue.length === 0) return;
    const step = (): void => {
      this.bakeTimer = null;
      if (this.dead) return;
      const name = this.bakeQueue.shift();
      if (name === undefined) return;
      this.bake(name);
      if (this.bakeQueue.length > 0) this.bakeTimer = setTimeout(step, 0);
    };
    this.bakeTimer = setTimeout(step, 0);
  }

  /** Synthesise one cue. A bad recipe must not take the other eleven with it. */
  private bake(name: SoundName): AudioBufferLike | null {
    const cached = this.bank.get(name);
    if (cached !== undefined) return cached;
    const ctx = this.ctx;
    if (ctx === null) return null;
    try {
      const rate = ctx.sampleRate;
      const pcm = renderSound(name, rate);
      const buf = ctx.createBuffer(2, pcm.length, rate);
      buf.getChannelData(0).set(pcm.left);
      buf.getChannelData(1).set(pcm.right);
      this.bank.set(name, buf);
      return buf;
    } catch {
      return null;
    }
  }

  /** Has this cue been synthesised yet? */
  isBaked(name: string): boolean {
    return isSoundName(name) && this.bank.has(name);
  }

  // -- playback ----------------------------------------------------------

  /**
   * Fire a cue by name. Unknown names, a muted engine and a context that is
   * not running are all ignored in silence.
   */
  play(name: string, volume = 1.0): void {
    if (this.muted || this.dead) return;
    const ctx = this.ctx;
    const master = this.masterGain;
    if (ctx === null || master === null || ctx.state !== "running") return;
    if (!isSoundName(name)) return;

    const now = ctx.currentTime;
    const last = this.lastPlay.get(name);
    if (last !== undefined && now - last < minInterval(name)) return;

    const buf = this.bank.get(name) ?? this.bake(name);
    if (buf === null || buf === undefined) return;
    this.lastPlay.set(name, now);

    try {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const gain = ctx.createGain();
      gain.gain.value = voiceGain(name, volume, this.master);
      src.connect(gain);
      gain.connect(master);
      src.start();
      // Finished voices are dropped here rather than from an `onended`
      // callback: the audio clock already says when a buffer ran out, and one
      // sweep per play is cheaper than a listener per voice.
      this.live = this.live.filter((v) => v.endsAt > now);
      this.live.push({ src, gain, endsAt: now + buf.duration });
    } catch {
      // A device unplugged mid-frame, a node limit hit - drop the cue.
    }
  }

  /** Silence everything currently sounding. */
  stopAll(): void {
    for (const v of this.live) {
      try {
        v.src.stop();
      } catch {
        // Already finished; stopping twice is not an error worth reporting.
      }
      try {
        v.src.disconnect();
        v.gain.disconnect();
      } catch {
        // ignored
      }
    }
    this.live = [];
  }

  // -- mute and volume ---------------------------------------------------

  setMuted(v: boolean): void {
    this.muted = Boolean(v);
    if (this.muted) this.stopAll();
  }

  /** Flip mute and return the new state. */
  toggleMute(): boolean {
    this.setMuted(!this.muted);
    return this.muted;
  }

  setMasterVolume(v: number): void {
    this.master = clamp(Number(v), 0.0, 1.0);
  }

  // -- introspection -----------------------------------------------------

  soundNames(): readonly SoundName[] {
    return SOUND_NAMES;
  }

  /** Is `name` a cue this build knows how to synthesise? */
  has(name: string): boolean {
    return isSoundName(name);
  }

  /** Release the device. Safe to call more than once. */
  shutdown(): void {
    this.stopAll();
    this.dead = true;
    if (this.bakeTimer !== null) {
      clearTimeout(this.bakeTimer);
      this.bakeTimer = null;
    }
    this.bakeQueue = [];
    this.bank.clear();
    this.lastPlay.clear();
    this.unlocking = null;
    const ctx = this.ctx;
    this.ctx = null;
    this.masterGain = null;
    if (ctx === null) return;
    try {
      void ctx.close().catch(() => undefined);
    } catch {
      // ignored
    }
  }
}

// ==========================================================================
// Gesture plumbing
// ==========================================================================

/** Anything the unlock listeners can be hung off; `window` in practice. */
export interface GestureTarget {
  addEventListener(type: string, handler: () => void, options?: unknown): void;
  removeEventListener(type: string, handler: () => void, options?: unknown): void;
}

const UNLOCK_EVENTS = ["pointerdown", "touchend", "keydown", "mousedown"] as const;

/**
 * Call `audio.unlock()` on the first user gesture and then stop listening.
 *
 * Registered on several event types because no single one fires first across
 * iOS Safari, Android Chrome and a desktop keyboard. Returns a disposer for
 * the case where the game is torn down before anyone touches it.
 */
export function installUnlockGesture(audio: Audio, target: GestureTarget): () => void {
  let done = false;
  const off = (): void => {
    if (done) return;
    done = true;
    for (const type of UNLOCK_EVENTS) {
      try {
        target.removeEventListener(type, onGesture, true);
      } catch {
        // ignored
      }
    }
  };
  const onGesture = (): void => {
    void audio.unlock().then((ok) => {
      // Only retire the listeners once a gesture actually got the context
      // running; a refused first tap must leave the next one a chance.
      if (ok) off();
    });
  };
  for (const type of UNLOCK_EVENTS) {
    try {
      target.addEventListener(type, onGesture, true);
    } catch {
      // ignored
    }
  }
  return off;
}
