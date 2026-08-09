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

  readonly pointer: PointerState = {
    x: C.WINDOW_W * 0.5,
    y: C.WINDOW_H * 0.5,
    down: false,
    boost: false,
    touch: false,
  };
  /** Recent pointer positions, for the cursor comet trail. */
  readonly pointerTrail: Array<{ x: number; y: number }> = [];
  /** Set by attachInput(); absent in headless tests. */
  input?: InputManager;

  time = 0;
  frame = 0;
  fps = 0;
  running = false;
  headless = false;

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
    });
    mount.appendChild(this.app.canvas);

    this.app.stage.addChild(this.world);
    this.app.stage.addChild(this.overlay);

    this.applyResize();
    window.addEventListener("resize", this.queueResize, { passive: true });
    window.addEventListener("orientationchange", this.queueResize, { passive: true });

    this.app.ticker.maxFPS = C.FPS;
    this.app.ticker.add(this.tick);
  }

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

  switchScene(key: SceneKey | string, args?: SceneEnterArgs): void {
    while (this.stack.length) {
      const s = this.stack.pop()!;
      s.onExit();
      this.world.removeChild(s.root);
    }
    const scene = this.makeScene(key);
    this.stack.push(scene);
    this.world.addChild(scene.root);
    scene.onEnter(args);
    scene.onResize();
  }

  pushScene(key: SceneKey | string, args?: SceneEnterArgs): void {
    const scene = this.makeScene(key);
    if (this.stack.includes(scene)) return;
    this.stack.push(scene);
    this.world.addChild(scene.root);
    scene.onEnter(args);
    scene.onResize();
  }

  popScene(): void {
    if (this.stack.length <= 1) return;
    const s = this.stack.pop()!;
    s.onExit();
    this.world.removeChild(s.root);
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
  }

  start(startScene: SceneKey | string = "menu"): void {
    this.running = true;
    this.switchScene(startScene);
  }

  destroy(): void {
    this.running = false;
    window.removeEventListener("resize", this.queueResize);
    window.removeEventListener("orientationchange", this.queueResize);
    if (this.app) {
      this.app.ticker.remove(this.tick);
      this.app.destroy(true, { children: true });
    }
  }
}
