/**
 * The READY card and the GO flourish - `docs/port/integration.md` section 9,
 * from `snake/scenes/gameplay.py::_draw_ready` / `_draw_go`.
 *
 * Both run on **real** dt: the countdown is what gates the simulation starting,
 * so it cannot itself be slowed by anything the simulation does.
 *
 * The one structural oddity, faithfully copied: **the card fades by colour, not
 * by alpha.** Every text colour is blended toward `theme.bgBottom` as `vis`
 * falls, so the rows sink into the backdrop rather than becoming transparent.
 * Using alpha instead would let the arena show through the glyphs, which reads
 * completely differently against a busy background.
 *
 * The countdown digit is anchored by its **top edge**, not its centre - Python
 * blits at that y - and it pops in each second on a curve that starts large and
 * settles, while fading out late in the same second.
 */

import { Container } from "pixi.js";

import * as C from "../../core/config";
import { clamp, easeOutCubic } from "../../core/mathx";
import { UI_GOLD, UI_WHITE, lerpColor, type RGB, type Theme } from "../../core/palette";
import type { FontBook } from "../../gfx/fonts";
import { Panel } from "../panel";
import { Label } from "../text";

/**
 * How long each overlay runs. Duplicated from `GameplayWorld`'s `READY_TIME` /
 * `GO_TIME` rather than imported: the UI layer does not depend on the game
 * layer, and these are the denominators of the eases below, not the timers.
 */
const READY_SECONDS = 3.0;
const GO_SECONDS = 0.65;
/** integration.md S9. The card fades out over the last half second. */
const FADE_OVER = 0.5;
/** ...and swings in over the first 0.35 s. */
const INTRO_OVER = 0.35;
/** Panel geometry and the distance it slides up as it arrives. */
const PANEL_W = 720;
const PANEL_H = 232;
const PANEL_RISE = 40;
/** Body alpha and halo intensity, both scaled by `vis`. */
const PANEL_ALPHA = 226;
const PANEL_GLOW = 0.55;
/** Row offsets from the panel's top-left. */
const ROW_LEVEL = 20;
const ROW_CHAPTER = 24;
const ROW_HEADLINE = 46;
const ROW_STRAP = 122;
const ROW_HINT = 160;
const ROW_GOAL = 188;
/** Side inset for the chapter and difficulty rows. */
const SIDE_INSET = 26;
/** The headline must fit inside the panel less this much. */
const HEADLINE_MARGIN = 56;
/** The countdown digit's top edge sits this far below the panel. */
const COUNT_DROP = 40;
/** GO! grows as it fades. */
const GO_GROW = 0.9;

/** Everything the card shows, gathered by the scene from the world. */
export interface ReadyInfo {
  levelNumber: number;
  levelName: string;
  levelSubtitle: string;
  levelHint: string;
  goalFood: number;
  difficultyLabel: string;
  difficultyColor: RGB;
  storyMode: boolean;
  chapterRoman: string | null;
  chapterTitle: string | null;
  beatTitle: string | null;
}

export class ReadyOverlay {
  readonly root = new Container();

  private readonly panel = new Panel();
  private readonly levelLabel: Label;
  private readonly chapterLabel: Label;
  private readonly diffLabel: Label;
  private readonly headline: Label;
  private readonly strapline: Label;
  private readonly hint: Label;
  private readonly goal: Label;
  private readonly count: Label;
  private readonly go: Label;

  private readonly fonts: FontBook;
  private lastHeadline = "";

  constructor(fonts: FontBook) {
    this.fonts = fonts;
    this.levelLabel = new Label(fonts, fonts.small);
    this.chapterLabel = new Label(fonts, fonts.tiny);
    this.diffLabel = new Label(fonts, fonts.tiny);
    this.headline = new Label(fonts, fonts.title);
    this.strapline = new Label(fonts, fonts.body);
    this.hint = new Label(fonts, fonts.small);
    this.goal = new Label(fonts, fonts.small);
    this.count = new Label(fonts, fonts.huge);
    this.go = new Label(fonts, fonts.huge);

    this.root.addChild(
      this.panel,
      this.levelLabel,
      this.chapterLabel,
      this.diffLabel,
      this.headline,
      this.strapline,
      this.hint,
      this.goal,
      this.count,
      this.go,
    );
    this.root.visible = false;
  }

  /** Both timers count down; only one is ever above zero. */
  update(readyTimer: number, goTimer: number, info: ReadyInfo, theme: Theme): void {
    if (readyTimer > 0) {
      this.go.visible = false;
      this.drawReady(readyTimer, info, theme);
    } else if (goTimer > 0) {
      this.hideCard();
      this.drawGo(goTimer, theme);
    } else {
      this.root.visible = false;
    }
  }

  private hideCard(): void {
    for (const c of [
      this.panel,
      this.levelLabel,
      this.chapterLabel,
      this.diffLabel,
      this.headline,
      this.strapline,
      this.hint,
      this.goal,
      this.count,
    ]) {
      c.visible = false;
    }
  }

  private drawReady(readyTimer: number, info: ReadyInfo, theme: Theme): void {
    const fade = clamp(readyTimer / FADE_OVER, 0, 1);
    const intro = easeOutCubic(clamp((READY_SECONDS - readyTimer) / INTRO_OVER, 0, 1));
    const vis = fade * intro;

    if (vis <= 0.01) {
      this.root.visible = false;
      return;
    }
    this.root.visible = true;
    for (const c of [
      this.panel,
      this.levelLabel,
      this.diffLabel,
      this.headline,
      this.strapline,
      this.hint,
      this.goal,
    ]) {
      c.visible = true;
    }

    // Every colour is blended toward the backdrop as the card fades - Python
    // fades by colour, not by alpha.
    const tint = (col: RGB): RGB => lerpColor(theme.bgBottom, col, vis);

    const cx = C.ARENA_X + C.ARENA_W * 0.5;
    const cy = C.ARENA_Y + C.ARENA_H * 0.5 - PANEL_RISE + (1 - intro) * PANEL_RISE;
    const px = cx - PANEL_W * 0.5;
    const py = cy - PANEL_H * 0.5;

    this.panel.setRect(px, py, PANEL_W, PANEL_H);
    this.panel.setStyle(theme.accent, PANEL_ALPHA * vis, true, PANEL_GLOW * vis);

    this.levelLabel.set(`LEVEL ${String(info.levelNumber).padStart(2, "0")}`);
    this.levelLabel.setColor(tint(theme.accent2));
    this.levelLabel.place(cx, py + ROW_LEVEL, "center");

    const showChapter = info.storyMode && !!info.chapterTitle;
    this.chapterLabel.visible = showChapter;
    if (showChapter) {
      this.chapterLabel.set(`${info.chapterRoman ?? ""}. ${(info.chapterTitle ?? "").toUpperCase()}`);
      this.chapterLabel.setColor(tint(theme.accent2));
      this.chapterLabel.place(px + SIDE_INSET, py + ROW_CHAPTER);
    }

    this.diffLabel.set(info.difficultyLabel);
    this.diffLabel.setColor(tint(info.difficultyColor));
    this.diffLabel.place(px + PANEL_W - SIDE_INSET, py + ROW_CHAPTER, "right");

    // Largest of title / h1 / h2 that fits, falling back to the smallest.
    const headText = (info.storyMode && info.beatTitle ? info.beatTitle : info.levelName).toUpperCase();
    if (headText !== this.lastHeadline) {
      this.lastHeadline = headText;
      const face = this.fonts.fit(
        [this.fonts.title, this.fonts.h1, this.fonts.h2],
        headText,
        PANEL_W - HEADLINE_MARGIN,
      );
      this.headline.set(headText, face);
    }
    this.headline.setColor(tint(theme.text));
    this.headline.place(cx, py + ROW_HEADLINE, "center");

    this.strapline.set(
      info.storyMode ? `${info.levelName}  -  ${info.levelSubtitle}` : info.levelSubtitle,
    );
    this.strapline.setColor(tint(theme.accent));
    this.strapline.place(cx, py + ROW_STRAP, "center");

    this.hint.set(info.levelHint);
    this.hint.setColor(tint(theme.textDim));
    this.hint.place(cx, py + ROW_HINT, "center");

    this.goal.set(`GOAL  ${info.goalFood} ORBS`);
    this.goal.setColor(tint(UI_GOLD));
    this.goal.place(cx, py + ROW_GOAL, "center");

    // The countdown digit: pops in at the start of each second, fades out late
    // in it, and is anchored by its top edge.
    const count = Math.ceil(readyTimer);
    this.count.visible = count > 0;
    if (this.count.visible) {
      const stepT = 1 - (readyTimer - Math.floor(readyTimer));
      this.count.set(String(Math.min(count, 9)));
      this.count.setColor(lerpColor(theme.accent, UI_WHITE, 0.25 + 0.5 * stepT));
      this.count.setScale(1.35 - 0.35 * easeOutCubic(clamp(stepT * 1.6, 0, 1)));
      this.count.setAlpha(vis * clamp(1.4 - stepT, 0, 1));
      this.count.place(cx, py + PANEL_H + COUNT_DROP, "center");
    }
  }

  private drawGo(goTimer: number, theme: Theme): void {
    const u = clamp(goTimer / GO_SECONDS, 0, 1);
    this.root.visible = true;
    this.go.visible = true;

    const scale = 1 + GO_GROW * (1 - u);
    this.go.set("GO!");
    this.go.setColor(lerpColor(theme.accent, UI_WHITE, 0.55));
    this.go.setScale(scale);
    this.go.setAlpha(clamp(u * 1.4, 0, 1));

    const cx = C.ARENA_X + C.ARENA_W * 0.5;
    const cy = C.ARENA_Y + C.ARENA_H * 0.5;
    this.go.place(cx, cy - this.go.textHeight * scale * 0.5, "center");
  }
}
