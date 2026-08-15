/**
 * Application shell: renderer, scene stack, main loop, input plumbing.
 *
 * The counterpart of `snake/main.py::Game`. The structure is deliberately the
 * same so the ported scenes read like their Python originals, but the render
 * path is different in one important way: instead of scenes painting into an
 * offscreen surface which is then composited, each scene owns a Pixi
 * `Container` under a scaled world root, and post-processing is a filter chain
 * on that root. That is what moves the expensive work onto the GPU.
 */

import { Application, Container, Ticker } from "pixi.js";

import * as C from "../core/config";
import { FontBook, fontsReady } from "../gfx/fonts";
import { Cursor } from "../ui/Cursor";
import { ParticleSystem } from "../gfx/particles";
import { PostChain } from "../gfx/post";
import type { InputManager } from "../input/Input";
import { Scene, type SceneEnterArgs, type SceneKey } from "./Scene";
import { readSafeInsets, Viewport } from "./Viewport";

export type SceneFactory = (game: Game) => Scene;

/** What the simulation reads each frame, in design-space coordinates. */
export interface PointerState {
  /** The steering target the snake chases. */
  x: number;
  y: number;
  /** A pointer is down (mouse button or any touch). */
  down: boolean;
  /** Boost is requested (right mouse button, or a second touch). */
  boost: boolean;
  /** True when the input source is touch, so scenes can drop hover states. */
  touch: boolean;
}

/**
 * One pointer edge, in design space, for the UI kit.
 *
 * `game.pointer` carries the *level* - where the pointer is and whether it is
 * down - which is all the simulation needs. Buttons need the edges: a tap can
 * press and release inside one frame, and the hover cue depends on a move being
 * applied before that frame's update. Python gets both from its event pump; on
 * the web the level is polled, so the edges are queued alongside it.
 */
export interface UiPointerEvent {
  type: "move" | "down" | "up";
  x: number;
  y: number;
  /** Mouse button index; synthesised as 0 for touch. */
  button: number;
}

/**
 * One key edge. `key` is the `KeyboardEvent.key` value, lower-cased for
 * printable characters so "P" and "p" are the same binding.
 */
export interface UiKeyEvent {
  type: "down" | "up";
  key: string;
  repeat: boolean;
}

export interface GameOptions {
  /** Mount point. Defaults to #app. */
  container?: HTMLElement;
  /** Skip the renderer entirely, for tests. */
  headless?: boolean;
}

export class Game {
  app!: Application;
  readonly viewport = new Viewport();

  /** Scaled and centred; the design space lives under here. */
  readonly world = new Container();
  /** Above the world, unscaled: used by post-processing and debug. */
  readonly overlay = new Container();

  /**
   * Particles and screen feedback are owned by the shell, not by a scene.
   *
   * That is what makes them survive a scene change and what keeps them on real
   * time: slow motion scales the simulation, but a shake or a spark shower
   * finishes at its own pace, exactly as in the Python.
   */
  readonly particles = new ParticleSystem();
  readonly post = new PostChain();

  /**
   * The named font ladder, mirroring `main.py:98`.
   *
   * Owned by the shell rather than threaded through every draw call as the
   * Python does, because in Pixi a style is set once when a `Text` is built
   * rather than passed at paint time.
   */
  readonly fonts = new FontBook();

  /**
   * The reticle, drawn by the shell above every scene.
   *
   * It lives inside the post chain rather than over it, so it picks up the
   * bloom and the CRT curve with everything else - which is what the Python
   * does by painting it onto the canvas before the frame is composited.
   */
  cursor: Cursor | null = null;

  readonly pointer: PointerState = {
    x: C.WINDOW_W * 0.5,
    y: C.WINDOW_H * 0.5,
    down: false,
    boost: false,
    touch: false,
  };
  /** Recent pointer positions, for the cursor comet trail. */
  readonly pointerTrail: Array<{ x: number; y: number }> = [];
  /**
   * Pointer edges since the last frame, drained by scenes before they update
   * their buttons and cleared at the end of the tick.
   */
  readonly uiEvents: UiPointerEvent[] = [];
  /** Key edges since the last frame, drained and cleared like {@link uiEvents}. */
  readonly keyEvents: UiKeyEvent[] = [];
  /** Keys currently held, for anything that wants a level rather than an edge. */
  readonly keysDown = new Set<string>();
  /** Set by attachInput(); absent in headless tests. */
  input?: InputManager;

  time = 0;
  frame = 0;
  fps = 0;
  running = false;
  headless = false;

  /**
   * Windowed or fullscreen.
   *
   * The Python cycles windowed / borderless / fullscreen; a browser has only
   * the Fullscreen API, and only from a user gesture, so borderless collapses
   * into fullscreen here. The field is the *intent* - {@link syncDisplayMode}
   * keeps it honest when the user leaves fullscreen with Escape, which fires no
   * click for us to hang off.
   */
  displayMode: "windowed" | "fullscreen" = "windowed";

  /** Session state shared between scenes. */
  levelIndex = 0;
  mode: string = C.DEFAULT_MODE;
  difficulty: string = C.DEFAULT_DIFFICULTY;
  lastResult: Record<string, unknown> = {};

  private factories = new Map<string, SceneFactory>();
  private cache = new Map<string, Scene>();
  private stack: Scene[] = [];
  private resizeQueued = false;

  // -------------------------------------------------------------------
  // boot
  // -------------------------------------------------------------------
  async init(opts: GameOptions = {}): Promise<void> {
    this.headless = !!opts.headless;
    C.assertConfig();

    if (this.headless) {
      this.viewport.resize(C.WINDOW_W, C.WINDOW_H, 1);
      return;
    }

    const mount = opts.container ?? document.getElementById("app");
    if (!mount) throw new Error("Game.init: mount element not found");

    this.app = new Application();
    await this.app.init({
      background: 0x05070f,
      antialias: false, // the look is neon glow, not smooth edges; saves fill rate
      resolution: Math.min(window.devicePixelRatio || 1, 3),
      autoDensity: true,
      resizeTo: window,
      powerPreference: "high-performance",
      preference: "webgl",
      // The snake's cross-over contact shadow is drawn with the "subtract"
      // blend mode, which is filter-based and reads the back buffer. On WebGL
      // that silently falls back to normal blending unless this is on, and the
      // overpass then reads as a flat overlap instead of a shadow.
      useBackBuffer: true,
    });
    mount.appendChild(this.app.canvas);

    // A Text built before its face has resolved measures against a fallback,
    // and Pixi caches that measurement with the raster - so a mis-tiered
    // headline stays wrong until its string changes. Resolves immediately when
    // there is nothing to load.
    await fontsReady();

    this.app.stage.addChild(this.world);
    this.app.stage.addChild(this.overlay);
    // Scenes live inside the post chain, so every filter and the shake offset
    // apply to the whole frame rather than per scene.
    this.world.addChild(this.post.view);

    this.cursor = new Cursor();
    this.post.scene.addChild(this.cursor.root);

    this.applyResize();
    window.addEventListener("resize", this.queueResize, { passive: true });
    window.addEventListener("orientationchange", this.queueResize, { passive: true });
    // Escape leaves fullscreen without a click, so the only way to keep the
    // settings label truthful is to listen for the change itself.
    document.addEventListener("fullscreenchange", this.syncDisplayMode);

    this.app.ticker.maxFPS = C.FPS;
    this.app.ticker.add(this.tick);
  }

  /**
   * Ask the browser to enter or leave fullscreen.
   *
   * Must be called from a user gesture or the request is rejected - which is
   * why this is driven by a button and never restored automatically on boot.
   * The promise is deliberately swallowed: a refusal is a normal outcome (an
   * iframe without the permission, or a browser that simply declines), and the
   * `fullscreenchange` listener will correct the label either way.
   */
  setDisplayMode(mode: "windowed" | "fullscreen"): void {
    this.displayMode = mode;
    if (typeof document === "undefined") return;
    try {
      if (mode === "fullscreen" && !document.fullscreenElement) {
        void document.documentElement.requestFullscreen?.().catch(() => this.syncDisplayMode());
      } else if (mode === "windowed" && document.fullscreenElement) {
        void document.exitFullscreen?.().catch(() => this.syncDisplayMode());
      }
    } catch {
      this.syncDisplayMode();
    }
  }

  /** Re-read the browser's actual state, so the label cannot lie. */
  private syncDisplayMode = (): void => {
    if (typeof document === "undefined") return;
    this.displayMode = document.fullscreenElement ? "fullscreen" : "windowed";
  };

  private queueResize = (): void => {
    // Mobile browsers fire resize repeatedly while the URL bar animates;
    // coalesce into one layout pass per frame.
    this.resizeQueued = true;
  };

  private applyResize(): void {
    this.resizeQueued = false;
    const w = window.innerWidth;
    const h = window.innerHeight;
    const dpr = window.devicePixelRatio || 1;
    this.viewport.resize(w, h, dpr, readSafeInsets());

    this.world.scale.set(this.viewport.scale);
    this.world.position.set(this.viewport.offsetX, this.viewport.offsetY);

    // Text rasterises in design pixels and is then magnified by the world
    // transform, so on a large window it needs to be built at more than 1:1 or
    // every label goes soft. Scenes copy this onto each `Text.resolution`.
    this.fonts.setResolution(this.viewport.scale * (this.app.renderer?.resolution ?? 1));

    // The post chain frames the whole screen in design units, not just the
    // 1280x720 box: on a wide phone the bars either side are part of the
    // picture, and a CRT curve that stopped at the design edge would look cut.
    this.post.setFrame(this.viewport.overscan);

    // A rotation can move a device between the phone and tablet schemes.
    this.input?.refreshScheme();
    for (const scene of this.stack) scene.onResize();
  }

  // -------------------------------------------------------------------
  // scenes
  // -------------------------------------------------------------------
  registerScene(key: SceneKey | string, factory: SceneFactory): void {
    this.factories.set(key, factory);
  }

  private makeScene(key: string): Scene {
    const cached = this.cache.get(key);
    if (cached) return cached;
    const factory = this.factories.get(key);
    if (!factory) throw new Error(`unknown scene ${JSON.stringify(key)}`);
    const scene = factory(this);
    this.cache.set(key, scene);
    return scene;
  }

  get scene(): Scene | undefined {
    return this.stack[this.stack.length - 1];
  }

  /**
   * How deep the scene stack is.
   *
   * Settings needs it: opened from the menu it is the only scene and BACK must
   * *switch*, but opened from the pause overlay it sits on top of a live run
   * and BACK must *pop*, or switching would destroy the run underneath.
   */
  get stackDepth(): number {
    return this.stack.length;
  }

  switchScene(key: SceneKey | string, args?: SceneEnterArgs): void {
    while (this.stack.length) {
      const s = this.stack.pop()!;
      s.onExit();
      this.post.scene.removeChild(s.root);
    }
    const scene = this.makeScene(key);
    this.stack.push(scene);
    this.post.scene.addChild(scene.root);
    // Re-adding moves it back to the end, so the reticle stays above the scene.
    if (this.cursor) this.post.scene.addChild(this.cursor.root);
    scene.onEnter(args);
    scene.onResize();
    // A full scene change wipes; pushing an overlay (pause) does not.
    this.post.fx.beginTransition();
  }

  pushScene(key: SceneKey | string, args?: SceneEnterArgs): void {
    const scene = this.makeScene(key);
    if (this.stack.includes(scene)) return;
    this.stack.push(scene);
    this.post.scene.addChild(scene.root);
    // Re-adding moves it back to the end, so the reticle stays above the scene.
    if (this.cursor) this.post.scene.addChild(this.cursor.root);
    scene.onEnter(args);
    scene.onResize();
  }

  popScene(): void {
    if (this.stack.length <= 1) return;
    const s = this.stack.pop()!;
    s.onExit();
    // Scene roots live under the post chain, not directly under the world -
    // removing from the wrong parent silently leaves the overlay on screen.
    this.post.scene.removeChild(s.root);
  }

  /** Scene keys that have been registered; used by tests. */
  registeredScenes(): string[] {
    return [...this.factories.keys()];
  }

  // -------------------------------------------------------------------
  // loop
  // -------------------------------------------------------------------
  private tick = (ticker: Ticker): void => {
    if (this.resizeQueued) this.applyResize();
    const dt = Math.min(ticker.deltaMS / 1000, C.MAX_DT);
    this.fps = ticker.FPS;
    this.step(dt);
  };

  /** One simulation step. Split out so headless tests can drive it directly. */
  step(dt: number): void {
    this.time += dt;
    this.frame++;
    this.input?.update(dt);

    this.pointerTrail.push({ x: this.pointer.x, y: this.pointer.y });
    while (this.pointerTrail.length > C.CURSOR_TRAIL_LEN) this.pointerTrail.shift();

    // Walk the stack top-down, stopping at the first scene that blocks.
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const scene = this.stack[i]!;
      scene.update(dt);
      if (scene.blocksUpdate) break;
    }

    // Overlay scenes are drawn over the one below; hide everything under an
    // opaque scene so we are not paying to render an invisible level.
    let firstVisible = this.stack.length - 1;
    while (firstVisible > 0 && this.stack[firstVisible]!.transparent) firstVisible--;
    for (let i = 0; i < this.stack.length; i++) {
      this.stack[i]!.root.visible = i >= firstVisible;
    }

    // Both take real dt, after the scenes. Slow motion is a property of the
    // simulation; a spark shower and a screen shake are not, and running them
    // on the scaled clock would stretch every impact into treacle.
    //
    // The order also matters for a subtler reason: particles emitted by a scene
    // this frame get no update before their first draw, so they appear exactly
    // where they were born. That is the Python's behaviour and it reads as a
    // sharper impact than starting them a frame along.
    this.particles.update(dt);
    this.post.update(dt);

    this.cursor?.draw({
      time: this.time,
      levelIndex: this.levelIndex,
      pointer: this.pointer,
      trail: this.pointerTrail,
    });

    // Drained by whichever scenes wanted them; anything left is stale.
    this.uiEvents.length = 0;
    this.keyEvents.length = 0;
  }

  start(startScene: SceneKey | string = "menu"): void {
    this.running = true;
    this.switchScene(startScene);
  }

  destroy(): void {
    this.running = false;
    window.removeEventListener("resize", this.queueResize);
    window.removeEventListener("orientationchange", this.queueResize);
    document.removeEventListener("fullscreenchange", this.syncDisplayMode);
    this.particles.destroy();
    this.post.destroy();
    if (this.app) {
      this.app.ticker.remove(this.tick);
      this.app.destroy(true, { children: true });
    }
  }
}
