/**
 * A development scene for looking at one background on its own.
 *
 * The renderer is being ported stage by stage, and the only honest way to check
 * a stage is to look at it next to the Python screenshot in `captures/`. This
 * scene builds the background for a level, fills the whole screen with it, and
 * gets out of the way.
 *
 * It is driven from the screenshot harness:
 *
 *   node tools/shot.mjs --eval "game.switchScene('preview', {level: 3})" \
 *       --wait 2500 --out lvl4.png
 *
 * Nothing in the shipped game routes here; it is registered alongside the real
 * scenes and only reachable by name.
 */

import { Container, Text } from "pixi.js";

import type { Game } from "../app/Game";
import { Scene, type SceneEnterArgs } from "../app/Scene";
import { themeForLevel } from "../core/palette";
import { Background, makeBackground } from "../gfx/bg";

export class PreviewScene extends Scene {
  readonly root = new Container();

  private background: Background | null = null;
  private levelIndex = 0;
  private label: Text;
  /** When false the background is frozen, so a screenshot is reproducible. */
  private animating = true;

  constructor(game: Game) {
    super(game);
    this.label = new Text({
      text: "",
      style: {
        fontFamily: "ui-monospace, monospace",
        fontSize: 14,
        fill: 0xdfe8ff,
        align: "left",
      },
    });
    this.label.position.set(18, 14);
    this.label.alpha = 0.75;
  }

  override onEnter(args?: SceneEnterArgs): void {
    const raw = args?.["level"];
    this.levelIndex = typeof raw === "number" && Number.isFinite(raw) ? Math.trunc(raw) : 0;
    const anim = args?.["animate"];
    this.animating = anim === undefined ? true : !!anim;
    this.rebuild();
  }

  override onExit(): void {
    this.background?.destroy();
    this.background = null;
  }

  override onResize(): void {
    // Layers are pre-rendered at a fixed size, so a new viewport means a new
    // background. The seed is derived from style and theme, so it comes back
    // with the layout it had before.
    this.rebuild();
  }

  /** Swap to another level without leaving the scene. */
  showLevel(index: number): void {
    this.levelIndex = Math.trunc(index);
    this.rebuild();
  }

  /** Advance the background by a fixed step, for deterministic captures. */
  seek(seconds: number, step = 1 / 60): void {
    if (!this.background) return;
    let left = seconds;
    while (left > 0) {
      const dt = Math.min(step, left);
      this.background.update(dt);
      left -= dt;
    }
  }

  private rebuild(): void {
    this.background?.destroy();
    this.root.removeChildren();

    const theme = themeForLevel(this.levelIndex);
    // Fill the device, not just the design box: on a phone the letterbox bars
    // would otherwise be dead black either side of the art.
    const rect = { ...this.game.viewport.overscan };
    this.background = makeBackground(theme.bgStyle, theme, rect, this.game.app.renderer);
    this.root.addChild(this.background.root);

    this.label.text =
      `level ${this.levelIndex + 1}  ${theme.name}  [${theme.bgStyle}]\n` +
      `rect ${Math.round(rect.w)}x${Math.round(rect.h)} @ ` +
      `${Math.round(rect.x)},${Math.round(rect.y)}`;
    this.root.addChild(this.label);
    this.label.position.set(rect.x + 18, rect.y + 14);
  }

  override update(dt: number): void {
    if (!this.animating) return;
    this.background?.update(dt, this.game.pointer);
  }
}
