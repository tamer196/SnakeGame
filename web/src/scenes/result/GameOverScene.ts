/**
 * The run ended badly - a port of `GameOverScene`
 * (`snake/scenes/gameover.py:705-861`).
 *
 * The level's own theme is drained of colour, slow embers fall through a dim
 * field, GAME OVER burns overhead and the run summary counts itself up out of
 * zero. Story mode gets two honest choices - RETRY LEVEL and ABANDON RUN -
 * because a campaign death is not a menu of levels: offering LEVEL SELECT
 * there would quietly drop the player out of the run they are in the middle
 * of.
 */

import { Graphics, type Sprite } from "pixi.js";

import type { Game } from "../../app/Game";
import { getLevel } from "../../core/level";
import { clamp, easeOutBack, pulse } from "../../core/mathx";
import {
  UI_GOLD,
  UI_WHITE,
  lerpColor,
  shade,
  toHex,
  type Theme,
} from "../../core/palette";
import type { SaveData } from "../../core/save";
import type { Audio } from "../../audio";
import { haloSprite, setHalo } from "../../gfx/textures";
import type { Button } from "../../ui/Button";
import { grouped } from "../../ui/format";
import { muteTheme } from "../../ui/muteTheme";
import { Panel } from "../../ui/panel";
import { Label } from "../../ui/text";
import { Badge } from "./decor";
import { fmtTime } from "./format";
import { COUNT_DELAY, COUNT_TIME, ResultScene } from "./ResultScene";

/** Layout anchors (gameover.py:781-831), in design pixels. */
const CX = 640;
const HEAD_Y = 106;
const X_LABEL = 372;
const X_VALUE = 908;
const ROW_Y = 294;
const ROW_PITCH = 44;
const RULE_Y = ROW_Y + ROW_PITCH * 4 + 6; // 476

const ROW_CAPTIONS = ["SCORE", "FOOD EATEN", "BEST COMBO", "TIME SURVIVED"] as const;

export class GameOverScene extends ResultScene {
  protected override readonly veilAlpha: number = 168;

  private emberAcc = 0;
  /** The NEW BEST flourish already fired this entry? */
  private bestPing = false;

  private readonly panel = new Panel();
  private readonly glowWide: Sprite;
  private readonly glowTight: Sprite;
  private readonly title: Label;
  private readonly chapterLabel: Label;
  private readonly nameLabel: Label;
  private readonly badge: Badge;
  private readonly rowCaptions: Label[] = [];
  private readonly rowValues: Label[] = [];
  private readonly rule = new Graphics();
  private readonly parLabel: Label;
  private readonly bestGlow: Sprite;
  private readonly bestLabel: Label;
  private readonly levelBestLabel: Label;

  constructor(game: Game, save: SaveData, sound: Audio | null = null) {
    super(game, save, sound);
    const fonts = game.fonts;

    // Two stacked glows (wide + tight) give the heading real weight without
    // the cost of a blurred text surface. gameover.py:788-792.
    this.glowWide = haloSprite(250, UI_WHITE, 0);
    this.glowWide.position.set(CX, HEAD_Y + 46);
    this.glowTight = haloSprite(120, UI_WHITE, 0);
    this.glowTight.position.set(CX, HEAD_Y + 46);

    this.title = new Label(fonts, fonts.huge);
    this.title.set("GAME OVER");
    this.chapterLabel = new Label(fonts, fonts.tiny);
    this.nameLabel = new Label(fonts, fonts.body);
    this.badge = new Badge(fonts);
    this.badge.position.set(CX, 272);

    for (let i = 0; i < 4; i++) {
      const caption = new Label(fonts, fonts.small);
      caption.set(ROW_CAPTIONS[i]!);
      caption.place(X_LABEL, ROW_Y + i * ROW_PITCH + 4, "left");
      this.rowCaptions.push(caption);
      const value = new Label(fonts, fonts.h2);
      this.rowValues.push(value);
    }

    this.parLabel = new Label(fonts, fonts.small);

    // The gold plate swells in once the counters have settled. The Python
    // rasterises a new font size per frame (`display_at(max(12, int(38*s)))`);
    // here it is one 38 px raster driven by setScale - same staircase, one
    // texture (scenes.md §7.5).
    this.bestGlow = haloSprite(150, UI_GOLD, 0);
    this.bestGlow.position.set(CX, RULE_Y + 44 + 14);
    this.bestLabel = new Label(fonts, fonts.displayAt(38));
    this.bestLabel.set("NEW BEST");
    this.levelBestLabel = new Label(fonts, fonts.small);

    this.bodyLayer.addChild(
      this.panel,
      this.glowWide,
      this.glowTight,
      this.title,
      this.chapterLabel,
      this.nameLabel,
      this.badge,
      ...this.rowCaptions,
      ...this.rowValues,
      this.rule,
      this.parLabel,
      this.bestGlow,
      this.bestLabel,
      this.levelBestLabel,
    );
  }

  // ------------------------------------------------------------------
  // entry
  // ------------------------------------------------------------------

  protected override resetSceneState(): void {
    this.emberAcc = 0;
    this.bestPing = false;
  }

  protected override buildTheme(): Theme {
    return muteTheme(getLevel(this.levelIndex).theme);
  }

  protected override buildButtons(): Button[] {
    if (this.isStory) {
      return this.row(
        [
          ["RETRY LEVEL", "primary", "retry"],
          ["ABANDON RUN", "ghost", "menu"],
        ],
        604,
        300,
        36,
      );
    }
    return this.row(
      [
        ["RETRY", "primary", "retry"],
        ["LEVEL SELECT", "ghost", "levels"],
        ["MENU", "ghost", "menu"],
      ],
      604,
      268,
      26,
    );
  }

  protected override applyStaticContent(): void {
    const theme = this.theme;

    this.panel.setRect(300, 88, 680, 480);
    this.panel.setStyle(theme.accent, 196, true, 0.2);

    this.title.setColor(lerpColor(UI_WHITE, theme.hazard, 0.35));
    this.title.place(CX, HEAD_Y, "center");

    this.chapterLabel.set(this.chapterLine());
    this.chapterLabel.setColor(theme.accent2); // shade(accent2, 1.0) is identity
    this.chapterLabel.place(CX, HEAD_Y + 100, "center");

    this.nameLabel.set(this.levelName.toUpperCase());
    this.nameLabel.setColor(theme.textDim);
    this.nameLabel.place(CX, HEAD_Y + 118, "center");

    // The difficulty stays legible but joins the drained palette - this
    // screen is desaturated on purpose and a hot chip would fight it.
    this.setBadge(this.badge, true);

    for (const caption of this.rowCaptions) caption.setColor(theme.textDim);
    this.rowValues[0]!.setColor(lerpColor(UI_WHITE, UI_GOLD, 0.45));
    for (let i = 1; i < 4; i++) this.rowValues[i]!.setColor(theme.text);

    // A hairline under the block ties the rows to the buttons below.
    this.rule.clear();
    this.rule
      .moveTo(X_LABEL, RULE_Y)
      .lineTo(X_VALUE, RULE_Y)
      .stroke({ width: 1, color: toHex(theme.grid), alpha: 200 / 255 });

    this.setParLine(this.parLabel);
    this.parLabel.place(CX, RULE_Y + 12, "center");

    this.levelBestLabel.visible = !this.newBest;
    if (!this.newBest) {
      let best = 0;
      try {
        best = Math.trunc(this.save.bestFor(this.levelIndex, this.diff.key));
      } catch {
        best = 0;
      }
      // Two spaces, per the Python format string.
      this.levelBestLabel.set(`LEVEL BEST  ${grouped(Math.max(best, this.score))}`);
      this.levelBestLabel.setColor(theme.textDim);
      this.levelBestLabel.place(CX, RULE_Y + 46, "center");
    }
    this.bestGlow.visible = false;
    this.bestLabel.visible = false;
  }

  protected override onReady(): void {
    this.sound?.play("die");
    // The muted hazard: the theme was already drained by buildTheme.
    this.game.post.fx.flash(shade(this.theme.hazard, 0.7), 0.35);
    this.game.post.fx.shake(5.0);
  }

  // ------------------------------------------------------------------
  // per-frame
  // ------------------------------------------------------------------

  /** A slow, sparse fall of embers - grief, at about 13 particles/sec. */
  protected override emit(dt: number): void {
    this.emberAcc += dt * 13.0;
    const hazard = this.theme.hazard;
    const accent = this.theme.accent;
    const uniform = (a: number, b: number): number => a + Math.random() * (b - a);
    while (this.emberAcc >= 1.0) {
      this.emberAcc -= 1.0;
      const col = lerpColor(hazard, accent, Math.random() * 0.6);
      this.game.particles.spawn(uniform(-20, 1300), uniform(-40, -4), {
        vx: uniform(-9, 9),
        vy: uniform(14, 34),
        radius: uniform(1.8, 3.6),
        color: shade(col, 0.85),
        life: uniform(4.5, 8.5),
        drag: 0.12,
        gravity: 5.0,
        shrink: false,
        kind: Math.random() < 0.55 ? "ember" : "dot",
        spin: uniform(-1.2, 1.2),
      });
    }
    // The NEW BEST flourish waits for the count-up to finish (t >= 1.245 s).
    if (this.newBest && !this.bestPing && this.countFrac() >= 0.999) {
      this.bestPing = true;
      this.sound?.play("bonus");
      this.game.particles.ring(CX, 250, UI_GOLD, {
        radius: 120,
        count: 30,
        life: 0.8,
        speed: 190,
      });
    }
  }

  protected override refresh(): void {
    const t = this.game.time; // unscaled shell clock - shimmer only
    const theme = this.theme;

    const breathe = 0.35 + 0.2 * pulse(t, 1.4);
    setHalo(this.glowWide, 250, shade(theme.hazard, 0.85), breathe);
    setHalo(this.glowTight, 120, theme.hazard, breathe * 0.9);

    // ---- summary rows, rolling up out of zero ---------------------------
    const values = [
      grouped(this.counted(this.score)),
      `${this.counted(this.foodEaten)} / ${this.goalFood}`,
      `x${this.maxCombo ? Math.max(1, this.counted(this.maxCombo)) : 1}`,
      fmtTime(this.elapsed * this.countFrac()),
    ];
    for (let i = 0; i < 4; i++) {
      const v = this.rowValues[i]!;
      v.set(values[i]!);
      v.place(X_VALUE, ROW_Y + i * ROW_PITCH - 3, "right");
    }

    // ---- NEW BEST plate --------------------------------------------------
    if (this.newBest) {
      const pop = clamp((this.t - (COUNT_DELAY + COUNT_TIME)) / 0.45, 0, 1);
      const show = pop > 0;
      this.bestGlow.visible = show;
      this.bestLabel.visible = show;
      if (show) {
        const scale = 0.7 + 0.3 * easeOutBack(pop);
        const glow = (0.45 + 0.35 * pulse(t, 5.0)) * pop;
        setHalo(this.bestGlow, 150 * scale, UI_GOLD, glow);
        // Python quantises the face size per frame; reproduce the staircase.
        const size = Math.max(12, Math.trunc(38 * scale));
        this.bestLabel.setScale(size / 38);
        this.bestLabel.setColor(
          lerpColor(UI_GOLD, UI_WHITE, 0.3 + 0.25 * pulse(t, 5.0)),
        );
        this.bestLabel.place(CX, RULE_Y + 44, "center");
      }
    }
  }
}
