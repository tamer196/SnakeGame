/**
 * A temporary scene that proves the pipeline end to end.
 *
 * It draws the design-space bounds, the arena rect, the overscan area and a
 * pointer-following marker, so the viewport maths, the scaling, the safe-area
 * insets and the input mapping are all visible and checkable on a real device
 * before any real scene exists. It is replaced as the ported scenes land.
 */

import { Container, Graphics, Text } from "pixi.js";

import * as C from "../core/config";
import { Scene } from "../app/Scene";
import type { Game } from "../app/Game";

export class BootScene extends Scene {
  readonly root = new Container();

  private overscan = new Graphics();
  private frame = new Graphics();
  private arena = new Graphics();
  private marker = new Graphics();
  private title: Text;
  private info: Text;
  private t = 0;

  constructor(game: Game) {
    super(game);

    this.root.addChild(this.overscan, this.frame, this.arena, this.marker);

    this.title = new Text({
      text: C.GAME_TITLE,
      style: {
        fontFamily: "system-ui, sans-serif",
        fontSize: 64,
        fontWeight: "800",
        fill: 0x00ecff,
        letterSpacing: 8,
      },
    });
    this.title.anchor.set(0.5);
    this.title.position.set(C.WINDOW_W / 2, C.WINDOW_H / 2 - 40);

    this.info = new Text({
      text: "",
      style: {
        fontFamily: "ui-monospace, monospace",
        fontSize: 16,
        fill: 0x8494b8,
        align: "center",
      },
    });
    this.info.anchor.set(0.5);
    this.info.position.set(C.WINDOW_W / 2, C.WINDOW_H / 2 + 46);

    this.root.addChild(this.title, this.info);
  }

  override onEnter(): void {
    this.t = 0;
    this.redraw();
  }

  override onResize(): void {
    this.redraw();
  }

  private redraw(): void {
    const vp = this.game.viewport;
    const os = vp.overscan;

    // The full screen in design units: anything drawn here fills the device.
    this.overscan.clear();
    this.overscan.rect(os.x, os.y, os.w, os.h).fill({ color: 0x080b16 });

    // The 1280x720 design box.
    this.frame.clear();
    this.frame
      .rect(0, 0, C.WINDOW_W, C.WINDOW_H)
      .stroke({ color: 0x1e3460, width: 2 });

    // The play area, exactly as the levels are authored against it.
    this.arena.clear();
    this.arena
      .rect(C.ARENA_X, C.ARENA_Y, C.ARENA_W, C.ARENA_H)
      .stroke({ color: 0x00ecff, width: 2, alpha: 0.55 });

    const dev = vp.isTabletOrLarger ? "tablet+" : "phone";
    this.info.text =
      `${vp.screenW}x${vp.screenH} css @${vp.dpr.toFixed(2)}x  scale ${vp.scale.toFixed(3)}\n` +
      `overscan ${os.w.toFixed(0)}x${os.h.toFixed(0)} design  ${dev}\n` +
      `safe t${vp.safe.top.toFixed(0)} r${vp.safe.right.toFixed(0)} ` +
      `b${vp.safe.bottom.toFixed(0)} l${vp.safe.left.toFixed(0)}`;
  }

  override update(dt: number): void {
    this.t += dt;

    const p = this.game.pointer;
    const pulse = 18 + Math.sin(this.t * 4) * 4;

    this.marker.clear();
    this.marker.circle(p.x, p.y, pulse).stroke({
      color: p.boost ? 0xff5cc0 : 0x00ecff,
      width: 3,
    });
    this.marker.circle(p.x, p.y, 3).fill({ color: 0xffffff });

    // The comet trail, thinning toward the oldest sample.
    const trail = this.game.pointerTrail;
    for (let i = 0; i < trail.length; i++) {
      const pt = trail[i]!;
      const a = (i + 1) / trail.length;
      this.marker.circle(pt.x, pt.y, 2 + a * 3).fill({
        color: 0x00ecff,
        alpha: a * 0.35,
      });
    }

    this.title.alpha = 0.75 + Math.sin(this.t * 2) * 0.25;
  }
}
