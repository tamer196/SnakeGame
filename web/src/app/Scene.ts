/**
 * The scene contract.
 *
 * A direct counterpart of `snake/core/contracts.py::Scene`, with one change
 * forced by the renderer: a Pixi scene owns a display `Container` rather than
 * painting into a surface handed to it each frame. Everything else - the
 * lifecycle, the transparent-overlay rule, the "instances are reused so
 * onEnter must fully reset" rule - carries over unchanged.
 */

import type { Container } from "pixi.js";
import type { Game } from "./Game";

export interface SceneEnterArgs {
  [key: string]: unknown;
}

export abstract class Scene {
  /** Drawn over the scene below instead of replacing it (the pause overlay). */
  static transparent = false;
  /** Stops the scene below from receiving update(). */
  static blocksUpdate = true;

  readonly game: Game;
  /** Everything this scene draws hangs off here. */
  abstract readonly root: Container;

  constructor(game: Game) {
    this.game = game;
  }

  /**
   * Called when the scene becomes active.
   *
   * Scene instances are cached and reused, so this MUST reset every piece of
   * state the scene owns. Forgetting is the single most common bug in this
   * design, and it shows up as a level that starts with the previous run's
   * score still on the HUD.
   */
  onEnter(_args?: SceneEnterArgs): void {}

  /** Called when the scene is replaced or popped. */
  onExit(): void {}

  /** Advance by dt seconds. */
  update(_dt: number): void {}

  /**
   * Called when the viewport changes: rotation, window resize, or a device
   * whose safe areas shift. Scenes that lay out against the overscan rect
   * rebuild their layout here.
   */
  onResize(): void {}

  get transparent(): boolean {
    return (this.constructor as typeof Scene).transparent;
  }

  get blocksUpdate(): boolean {
    return (this.constructor as typeof Scene).blocksUpdate;
  }
}

/** Scene registry keys, mirroring the Python game's SCENE_* constants. */
export const SCENES = {
  MENU: "menu",
  MODE: "mode",
  LEVELS: "levels",
  GAME: "game",
  PAUSE: "pause",
  GAMEOVER: "gameover",
  VICTORY: "victory",
  HELP: "help",
  SETTINGS: "settings",
  STORY: "story",
} as const;

export type SceneKey = (typeof SCENES)[keyof typeof SCENES];
