/**
 * The run ended well - a port of `VictoryScene`
 * (`snake/scenes/gameover.py:867-1184`).
 *
 * Confetti, a star ceremony and a rolling score. In story mode this scene is
 * also the campaign's switchboard: CONTINUE assembles the narrative card stack
 * for the transition - the cleared level's outro, the chapter plate when the
 * next level opens a chapter, the next level's intro unless the save says it
 * has been read - and hands it to the story presenter along with the level
 * that follows. After the final level it flags the campaign complete, shows
 * the epilogue and returns to the menu.
 *
 * Four states, selected by `final` x `isStory` (scenes.md §8.4): the headline,
 * the footer row and the button row all switch on them.
 */

import type { Sprite } from "pixi.js";

import type { Game } from "../../app/Game";
import { SCENES, type SceneEnterArgs } from "../../app/Scene";
import { LEVEL_COUNT } from "../../core/level";
import { clamp, easeOutBack, pulse } from "../../core/mathx";
import {
  UI_GOLD,
  UI_WHITE,
  lerpColor,
  themeForLevel,
  type RGB,
  type Theme,
} from "../../core/palette";
import type { SaveData } from "../../core/save";
import {
  EPILOGUE,
  chapterStart,
  getBeat,
  getChapter,
  type Chapter,
  type StoryCard,
} from "../../core/story";
import type { Audio } from "../../audio";
import { haloSprite, setHalo } from "../../gfx/textures";
import type { Button } from "../../ui/Button";
import { grouped } from "../../ui/format";
import { Panel } from "../../ui/panel";
import { Label } from "../../ui/text";
import { Badge, StarSlot } from "./decor";
import { fmtTime } from "./format";
import {
  ResultScene,
  STAR_FIRST,
  STAR_GAP,
  STAR_POP,
  type ButtonSpec,
} from "./ResultScene";

/** Layout anchors (gameover.py:1083-1121), in design pixels. */
const CX = 640;
const HEAD_Y = 88;
const STAR_Y = 292;
const SCORE_Y = STAR_Y + 60; // 352
const FOOT_Y = SCORE_Y + 98; // 450

export class VictoryScene extends ResultScene {
  protected override readonly veilAlpha: number = 112;

  private starsShown = 0;
  /** Seconds of confetti shower left. */
  private confetti = 0;
  private confettiAcc = 0;
  private starX: number[] = [];
  private starY = STAR_Y;

  /** The campaign tally, resolved once per entry (save reads are not free). */
  private totalStars = 0;
  private totalCap = LEVEL_COUNT * 3;
  private totalCaption = "TOTAL STARS";

  private readonly panel = new Panel();
  private readonly glowWide: Sprite;
  private readonly glowTight: Sprite;
  private readonly headline: Label;
  private readonly subLabel: Label;
  private readonly badge: Badge;
  private readonly starSlots: StarSlot[] = [];
  private readonly scoreGlow: Sprite;
  private readonly scoreLabel: Label;
  private readonly parLabel: Label;
  private readonly totalLabel: Label;
  private readonly footLabel: Label;
  private readonly newBestLabel: Label;

  constructor(game: Game, save: SaveData, sound: Audio | null = null) {
    super(game, save, sound);
    const fonts = game.fonts;

    this.glowWide = haloSprite(260, UI_WHITE, 0);
    this.glowWide.position.set(CX, HEAD_Y + 40);
    this.glowTight = haloSprite(130, UI_WHITE, 0);
    this.glowTight.position.set(CX, HEAD_Y + 40);

    // One label whose face switches per entry: huge for LEVEL CLEAR, title
    // for CAMPAIGN COMPLETE.
    this.headline = new Label(fonts, fonts.huge);
    this.subLabel = new Label(fonts, fonts.body);
    this.badge = new Badge(fonts);

    for (let i = 0; i < 3; i++) {
      const slot = new StarSlot();
      slot.position.set(CX + (i - 1) * 118, STAR_Y);
      this.starSlots.push(slot);
    }

    this.scoreGlow = haloSprite(170, UI_GOLD, 0);
    this.scoreGlow.position.set(CX, SCORE_Y + 30);
    this.scoreLabel = new Label(fonts, fonts.displayAt(58));
    this.parLabel = new Label(fonts, fonts.small);
    this.totalLabel = new Label(fonts, fonts.h2);
    this.footLabel = new Label(fonts, fonts.small);
    this.newBestLabel = new Label(fonts, fonts.h2);
    this.newBestLabel.set("NEW BEST");

    this.bodyLayer.addChild(
      this.panel,
      this.glowWide,
      this.glowTight,
      this.headline,
      this.subLabel,
      this.badge,
      ...this.starSlots,
      this.scoreGlow,
      this.scoreLabel,
      this.parLabel,
      this.totalLabel,
      this.footLabel,
      this.newBestLabel,
    );
  }

  // ------------------------------------------------------------------
  // entry
  // ------------------------------------------------------------------

  protected override resetSceneState(): void {
    // Reset here, never in onReady: a stale starsShown of 3 silently eats
    // every chime and shockwave while the stars still draw (scenes.md §8.2).
    this.starsShown = 0;
    this.confetti = 2.6;
    this.confettiAcc = 0;
    this.starY = STAR_Y;
    this.starX = [CX - 118, CX, CX + 118];
  }

  protected override buildButtons(): Button[] {
    if (this.isStory) {
      if (this.final) {
        return this.row(
          [
            ["CONTINUE", "primary", "story"],
            ["MENU", "ghost", "menu"],
          ],
          618,
          300,
          36,
        );
      }
      return this.row(
        [
          ["CONTINUE", "primary", "story"],
          ["REPLAY", "ghost", "retry"],
          ["MENU", "ghost", "menu"],
        ],
        618,
        268,
        26,
      );
    }
    const specs: ButtonSpec[] = [];
    if (!this.final) specs.push(["NEXT LEVEL", "primary", "next"]);
    // On the last level there is no NEXT LEVEL to be the primary, so REPLAY
    // inherits the role.
    specs.push(["REPLAY", this.final ? "primary" : "ghost", "retry"]);
    specs.push(["LEVEL SELECT", "ghost", "levels"]);
    specs.push(["MENU", "ghost", "menu"]);
    return this.row(specs, 618, specs.length === 4 ? 248 : 268, 22);
  }

  protected override applyStaticContent(): void {
    const theme = this.theme;
    const fonts = this.game.fonts;

    this.panel.setRect(272, 66, 736, 520);
    this.panel.setStyle(theme.accent, 190, true, 0.42);

    let subY: number;
    if (this.final) {
      this.headline.set("CAMPAIGN COMPLETE", fonts.title);
      this.headline.setColor(lerpColor(UI_WHITE, theme.accent, 0.2));
      subY = HEAD_Y + 84;
    } else {
      this.headline.set("LEVEL CLEAR", fonts.huge);
      this.headline.setColor(lerpColor(UI_WHITE, theme.accent, 0.25));
      subY = HEAD_Y + 100;
    }
    this.headline.place(CX, HEAD_Y, "center");

    this.subLabel.set(`${this.chapterLine()}  -  ${this.levelName.toUpperCase()}`);
    this.subLabel.setColor(theme.textDim);
    this.subLabel.place(CX, subY, "center");

    this.badge.position.set(CX, subY + 48);
    this.setBadge(this.badge, false);

    for (const slot of this.starSlots) slot.setOutlineColor(theme.textDim);

    this.scoreLabel.setColor(lerpColor(UI_WHITE, UI_GOLD, 0.5));

    this.setParLine(this.parLabel);
    this.parLabel.place(CX, SCORE_Y + 68, "center");

    // The campaign tally: a story run is counted on the difficulty it was
    // actually played on; free play shows the difficulty-agnostic best.
    this.totalLabel.visible = this.final;
    if (this.final) {
      try {
        if (this.isStory) {
          this.totalStars = Math.trunc(this.save.totalStars(this.diff.key));
          this.totalCaption = `${this.diffLabel()} STARS`;
        } else {
          this.totalStars = Math.trunc(this.save.totalStars());
          this.totalCaption = "TOTAL STARS";
        }
        this.totalCap = Math.trunc(this.save.maxStars());
      } catch {
        this.totalStars = this.stars;
        this.totalCap = LEVEL_COUNT * 3;
        this.totalCaption = "TOTAL STARS";
      }
    }
    this.footLabel.visible = !this.final;
    this.footLabel.setColor(theme.textDim);
    this.newBestLabel.visible = this.newBest;
  }

  // `final` and `mode` decide the button row, and both are resolved by the
  // base's readResult/derive before buildButtons runs - so this scene needs
  // no onEnter of its own (gameover.py:913-915).

  protected override onReady(): void {
    this.sound?.play("win");
    this.game.post.fx.flash(this.theme.accent, 0.45);
    this.firework(CX, 250, 1.15);
  }

  // ------------------------------------------------------------------
  // story hand-off (gameover.py:932-1000)
  // ------------------------------------------------------------------

  /**
   * The cards CONTINUE shows before the next level starts.
   *
   * A `Chapter` goes into the stack as itself - the story scene discriminates
   * by its `roman()` method, the contract mode select already pinned. The
   * read of `beatSeen(next)` happens BEFORE `markBeat(next)`: hoisting the
   * write above the read would suppress the next level's intro on the very
   * run that should show it (scenes.md §8.9).
   */
  private storyCards(): Array<StoryCard | Chapter> {
    const cards: Array<StoryCard | Chapter> = [];
    const beat = getBeat(this.levelIndex);
    cards.push({ title: beat.title, lines: [...beat.outro], speaker: beat.speaker });
    this.markBeat(this.levelIndex);

    if (this.final) {
      cards.push(EPILOGUE);
      return cards;
    }

    const nxt = this.nextIndex;
    if (chapterStart(nxt)) cards.push(getChapter(nxt));
    if (!this.beatSeen(nxt)) {
      const next = getBeat(nxt);
      cards.push({ title: next.title, lines: [...next.intro], speaker: next.speaker });
    }
    // Unconditional, even when the intro was skipped: after one CONTINUE
    // through level n, a later replay of n shows only the outro. Intended.
    this.markBeat(nxt);
    return cards;
  }

  /** CONTINUE: narrate the transition, then hand over to the next level. */
  protected override storyContinue(): void {
    const cards = this.storyCards();

    if (this.final) {
      this.save.setStoryComplete(true);
      this.flushSave();
      this.goStory(cards, SCENES.MENU, {}, this.theme);
      return;
    }

    const nxt = Math.trunc(clamp(this.nextIndex, 0, LEVEL_COUNT - 1));
    // Idempotent and forward-only; _finish already wrote it for the run, this
    // writes it for the hand-off, and cold entries only have the latter.
    this.save.setStoryProgress(nxt);
    this.flushSave();
    this.game.levelIndex = nxt;
    this.goStory(cards, SCENES.GAME, { level: nxt }, themeForLevel(nxt));
  }

  private goStory(
    cards: Array<StoryCard | Chapter>,
    nextScene: string,
    nextArgs: SceneEnterArgs,
    theme: Theme,
  ): void {
    if (this.game.registeredScenes().includes(SCENES.STORY)) {
      this.game.switchScene(SCENES.STORY, { cards, nextScene, nextArgs, theme });
    } else {
      // Until the presenter is registered, go straight on rather than
      // stranding the player - the same guard mode select uses.
      this.go(nextScene, nextArgs);
    }
  }

  // ------------------------------------------------------------------
  // particles (gameover.py:1003-1071)
  // ------------------------------------------------------------------

  private colors(): readonly [RGB, RGB, RGB, RGB] {
    const theme = this.theme;
    return [theme.accent, theme.accent2, theme.food, UI_GOLD];
  }

  /** One burst plus a shockwave, in the theme's brightest colours. */
  private firework(x: number, y: number, power = 1.0): void {
    const cols = this.colors();
    this.game.particles.ring(x, y, cols[0], {
      radius: 110 * power,
      count: 28,
      life: 0.7,
      speed: 200 * power,
    });
    for (let i = 0; i < 3; i++) {
      this.game.particles.burst(x, y, cols[(i + 1) % 4]!, {
        count: Math.trunc(20 * power),
        speed: [90, 320 * power],
        life: [0.5, 1.2],
        radius: [2.0, 5.0],
      });
    }
  }

  protected override emit(dt: number): void {
    const uniform = (a: number, b: number): number => a + Math.random() * (b - a);

    // ---- star ceremony: a catch-up loop, so a stall cannot eat a chime ---
    let want = 0;
    for (let i = 0; i < this.stars; i++) {
      if (this.t >= STAR_FIRST + i * STAR_GAP) want = i + 1;
    }
    while (this.starsShown < want) {
      const idx = this.starsShown;
      this.starsShown += 1;
      const x = idx < this.starX.length ? this.starX[idx]! : CX;
      // The third star's particles run whiter; the polygon stays pure gold.
      const col = idx < 2 ? UI_GOLD : lerpColor(UI_GOLD, UI_WHITE, 0.4);
      this.game.particles.ring(x, this.starY, col, {
        radius: 90,
        count: 22,
        life: 0.6,
        speed: 180,
      });
      this.game.particles.burst(x, this.starY, col, {
        count: 22,
        speed: [60, 240],
        life: [0.4, 0.9],
      });
      this.sound?.play(idx >= 2 ? "levelup" : "bonus");
      this.game.post.fx.shake(2.0 + 1.5 * idx);
    }

    // ---- confetti shower, 90/s for the first 2.6 s -----------------------
    if (this.confetti > 0) {
      this.confetti = Math.max(0, this.confetti - dt);
      this.confettiAcc += dt * 90;
      const cols = this.colors();
      while (this.confettiAcc >= 1) {
        this.confettiAcc -= 1;
        this.game.particles.spawn(uniform(0, 1280), uniform(-60, -6), {
          vx: uniform(-70, 70),
          vy: uniform(30, 120),
          radius: uniform(2.0, 4.6),
          color: cols[Math.trunc(Math.random() * cols.length)]!,
          life: uniform(1.6, 3.2),
          drag: 0.5,
          gravity: 95,
          shrink: false,
          kind: Math.random() < 0.45 ? "shard" : "dot",
          spin: uniform(-6, 6),
        });
      }
    } else if (this.t < 6.0 && Math.random() < dt * 1.4) {
      // A late firework keeps the screen alive after the shower stops,
      // without ever becoming a permanent particle sink.
      this.firework(uniform(220, 1060), uniform(140, 420), 0.7);
    }
  }

  // ------------------------------------------------------------------
  // per-frame drawing (gameover.py:1074-1184)
  // ------------------------------------------------------------------

  protected override refresh(): void {
    const t = this.game.time; // unscaled shell clock - shimmer only
    const theme = this.theme;

    const glow = 0.55 + 0.3 * pulse(t, 2.0);
    setHalo(this.glowWide, 260, theme.accent, glow * 0.8);
    setHalo(this.glowTight, 130, theme.accent2, glow * 0.7);

    // ---- stars: the reveal keys off self.t, the breathing off game.time --
    for (let i = 0; i < 3; i++) {
      const slot = this.starSlots[i]!;
      const earned = i < this.stars;
      if (!earned || this.t < STAR_FIRST + i * STAR_GAP) {
        slot.showOutline();
        continue;
      }
      const age = this.t - (STAR_FIRST + i * STAR_GAP);
      const pop = clamp(age / STAR_POP, 0, 1);
      // Overshoot on the way in, then settle into a slow breathing glow.
      const scale = pop < 1.0 ? 0.25 + 0.75 * easeOutBack(pop) : 1.0;
      const spin = (1.0 - pop) * 1.4;
      const g = 0.45 + 0.8 * (1.0 - pop) + 0.18 * pulse(t + i, 2.4);
      slot.showEarned(scale, spin, g);
    }

    // ---- score -----------------------------------------------------------
    const heat = this.countFrac();
    setHalo(this.scoreGlow, 170, UI_GOLD, 0.2 + 0.35 * heat);
    this.scoreLabel.set(grouped(this.counted(this.score)));
    this.scoreLabel.place(CX, SCORE_Y, "center");

    // ---- footer ------------------------------------------------------------
    if (this.final) {
      // Two spaces after the caption; the tally counts up with the score.
      this.totalLabel.set(
        `${this.totalCaption}  ${this.counted(this.totalStars)} / ${this.totalCap}`,
      );
      this.totalLabel.setColor(lerpColor(UI_GOLD, UI_WHITE, 0.25 + 0.2 * pulse(t, 3.0)));
      this.totalLabel.place(CX, FOOT_Y, "center");
    } else {
      // Only food rolls; combo and time snap to their final values, unlike
      // the game-over screen. Deliberate asymmetry - do not unify.
      const bits = [
        `FOOD ${this.counted(this.foodEaten)} / ${this.goalFood}`,
        `COMBO x${Math.max(1, this.maxCombo)}`,
        `TIME ${fmtTime(this.elapsed)}`,
      ];
      if (this.deaths) bits.push(`LIVES LOST ${this.deaths}`);
      this.footLabel.set(bits.join("     "));
      this.footLabel.place(CX, FOOT_Y + 4, "center");
    }

    if (this.newBest) {
      this.newBestLabel.setColor(lerpColor(UI_GOLD, UI_WHITE, 0.3 + 0.3 * pulse(t, 6.0)));
      this.newBestLabel.place(CX, FOOT_Y + 32, "center");
    }
  }
}
