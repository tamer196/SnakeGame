/**
 * Development only: every UI-kit widget on one screen.
 *
 * Reachable by name from the screenshot harness, never linked to from the game:
 *
 *   node tools/shot.mjs --eval "game.switchScene('uikit')" --out uikit.png
 *
 * The point is perceptual verification. Panels, bars and text are checked by
 * eye against the Python captures - `captures/09-pause.png` for a strong panel
 * glow, `captures/08-gameplay-ready.png` for the two bar geometries - because
 * no unit test can tell you a halo is twice as bright as it should be. That is
 * not hypothetical: the same class of bug (adding falloff bands instead of
 * overwriting them) shipped once in this port already and was caught by looking.
 */

import { Container } from "pixi.js";

import { Scene } from "../app/Scene";
import {
  UI_GOLD,
  UI_GOOD,
  UI_WARN,
  UI_WHITE,
  themeForLevel,
  type Theme,
} from "../core/palette";
import { Bar } from "../ui/bar";
import { Button, type ButtonStyle } from "../ui/Button";
import { Cursor } from "../ui/Cursor";
import { Panel } from "../ui/panel";
import { Label } from "../ui/text";

export class UiKitScene extends Scene {
  readonly root = new Container();

  private readonly theme: Theme = themeForLevel(0);
  private readonly panels: Panel[] = [];
  private readonly bars: Array<{ bar: Bar; frac: number; color: readonly [number, number, number] }> =
    [];
  private readonly buttons: Button[] = [];
  private readonly cursors: Array<{ cursor: Cursor; x: number; y: number; held: boolean }> = [];
  private built = false;

  override onEnter(): void {
    if (this.built) return;
    this.built = true;

    const fonts = this.game.fonts;
    const t = this.theme;

    // Three panels at real shipped geometries and their real alpha/glow pairs.
    const specs: Array<[number, number, number, number, number, number, string]> = [
      [40, 40, 470, 330, 232, 0.45, "PAUSE  470 x 646  a232  g0.45"],
      [560, 40, 680, 216, 214, 0.25, "HELP  680 x 216  a214  g0.25"],
      [560, 288, 680, 112, 214, 0.22, "SETTINGS ROW  800 x 112  a214  g0.22"],
    ];
    for (const [x, y, w, h, alpha, glow, caption] of specs) {
      const p = new Panel();
      p.setRect(x, y, w, h);
      p.setStyle(t.accent, alpha, true, glow);
      this.root.addChild(p);
      this.panels.push(p);

      const cap = new Label(fonts, fonts.tiny);
      cap.set(caption);
      cap.setColor(t.textDim);
      cap.place(x + 16, y + 14);
      this.root.addChild(cap);
    }

    // The font ladder, so every role can be compared against the captures.
    const ladder: Array<[string, ReturnType<typeof fonts.get>]> = [
      ["huge 96", fonts.huge],
      ["title 64", fonts.title],
      ["h1 42", fonts.h1],
      ["h2 30 bold", fonts.h2],
      ["body 21", fonts.body],
      ["small 17", fonts.small],
      ["tiny 14", fonts.tiny],
    ];
    let y = 78;
    for (const [name, style] of ladder) {
      const label = new Label(fonts, style);
      label.set(name === "huge 96" ? "NEON SERPENT" : `${name}  NEON SERPENT`, style);
      label.setColor(name === "huge 96" ? t.accent : t.text);
      label.place(64, y);
      this.root.addChild(label);
      y += label.textHeight + 6;
    }

    // Alignment check: the same string anchored three ways on one x.
    for (const [align, dy] of [
      ["left", 0],
      ["center", 22],
      ["right", 44],
    ] as const) {
      const l = new Label(fonts, fonts.small);
      l.set(`anchored ${align} on x=900`);
      l.setColor(UI_WHITE);
      l.place(900, 470 + dy, align);
      this.root.addChild(l);
    }

    // Both shipped bar geometries, plus a full one to show the rounded cap that
    // only appears at frac === 1.
    const barSpecs: Array<[number, number, number, number, number, readonly [number, number, number]]> =
      [
        [64, 470, 250, 9, 0.62, UI_GOOD],
        [64, 500, 222, 12, 0.35, UI_WARN],
        [64, 532, 220, 9, 1.0, UI_GOLD],
        [64, 562, 250, 9, 0.0, UI_GOOD],
      ];
    for (const [x, by, w, h, frac, color] of barSpecs) {
      const bar = new Bar();
      bar.setRect(x, by, w, h);
      this.root.addChild(bar);
      this.bars.push({ bar, frac, color });
    }

    const note = new Label(fonts, fonts.tiny);
    note.set("bars: 0.62 / 0.35 / 1.00 (rounded cap) / 0.00 (no fill, no tip glow)");
    note.setColor(t.textDim);
    note.place(64, 590);
    this.root.addChild(note);

    // The quirk most likely to be got wrong: Python applies `alpha` to the
    // gradient body only, so a fading panel ends as a full-strength neon
    // outline around almost nothing. All four of these must show an identical
    // rim; only the fill may fade.
    const fades: Array<[number, number]> = [
      [232, 0],
      [150, 1],
      [80, 2],
      [20, 3],
    ];
    for (const [alpha, i] of fades) {
      const p = new Panel();
      p.setRect(560 + i * 172, 470, 160, 96);
      p.setStyle(t.accent, alpha, true, 0.3);
      this.root.addChild(p);
      this.panels.push(p);

      const cap = new Label(fonts, fonts.tiny);
      cap.set(`alpha ${alpha}`);
      cap.setColor(UI_WHITE);
      cap.place(560 + i * 172 + 80, 578, "center");
      this.root.addChild(cap);
    }

    // The reticle is only ~15 px across at 1:1, which is too small to check by
    // eye, so it is magnified here: three ticks sweeping one way, a faint inner
    // ring sweeping the other, four spurs, and a white centre dot.
    for (const [cx, held] of [
      [760, false],
      [1040, true],
    ] as const) {
      const cursor = new Cursor();
      cursor.root.scale.set(5);
      // The container scales about its origin, so place it by counter-offset.
      cursor.root.position.set(cx - 0 * 5, 0);
      this.cursors.push({ cursor, x: 0, y: 30, held });
      this.root.addChild(cursor.root);

      const cap = new Label(fonts, fonts.tiny);
      cap.set(held ? "reticle x5, held" : "reticle x5, idle");
      cap.setColor(t.textDim);
      cap.place(cx, 220, "center");
      this.root.addChild(cap);
    }

    // One button per style, plus a forced-hover and a disabled variant, so the
    // cold/hot cross-fade and the disabled transform can both be seen at once.
    const buttonSpecs: Array<[string, ButtonStyle, number, boolean]> = [
      ["PRIMARY", "primary", 0, true],
      ["PRIMARY", "primary", 1, true],
      ["GHOST", "ghost", 0, true],
      ["DANGER", "danger", 1, true],
      ["TILE", "tile", 0, true],
      ["DISABLED", "primary", 0, false],
    ];
    buttonSpecs.forEach(([label, style, hover, on], i) => {
      this.makeButton(40 + i * 200, 620, style, label, hover, on);
    });
  }

  private makeButton(
    x: number,
    y: number,
    style: ButtonStyle,
    label: string,
    hover: number,
    enabled: boolean,
  ): void {
    const b = new Button(this.game.fonts, { x, y, w: 180, h: 56 }, label, { style, enabled });
    // Driven directly rather than through update(), so the screenshot can show
    // a hovered button without a pointer.
    b.hoverT = hover;
    this.root.addChild(b.root);
    this.buttons.push(b);
  }

  override update(): void {
    // The tip bloom breathes on the wall clock, never the scene clock.
    const now = performance.now();
    for (const { bar, frac, color } of this.bars) bar.set(frac, color, now);
    for (const b of this.buttons) b.draw(this.theme, this.game.time);
    for (const { cursor, x, y, held } of this.cursors) {
      cursor.draw({
        time: this.game.time,
        levelIndex: 0,
        pointer: { x, y, down: held, touch: false },
        trail: [],
      });
    }
  }
}
