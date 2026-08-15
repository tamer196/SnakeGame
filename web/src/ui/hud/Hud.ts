/**
 * The HUD strip - a port of `draw_hud` / `_draw_hud_impl`
 * (`snake/gfx/ui.py:960-1128`), specced in `docs/port/ui.md` section 9.
 *
 * Score odometer, level and goal progress, lives, combo, boost stamina and the
 * active power-up chips, all inside `(0, 0, 1280, 78)`.
 *
 * The clip is not decoration. The backdrop's bloom and every chip halo are
 * additive and would otherwise reach about a hundred pixels down into the play
 * field, brightening the top of the arena. Clipping makes the HUD and the arena
 * strictly disjoint, so they can be drawn in either order.
 *
 * The strip runs on **real time**: `draw_hud` receives the unscaled `game.time`
 * and differences it for its own dt. Slow motion stretches the simulation, not
 * the score roll-up.
 *
 * One deliberate non-port: Python wraps the whole body in a bare
 * `except Exception: pass`, so any error silently draws nothing at all. The
 * missing-key tolerance is kept - `draw_hud` ignores unknown state keys and
 * survives absent ones - but a silent blank HUD is a bug that hides bugs, so
 * errors are left to surface.
 */

import { Container, Graphics, Sprite } from "pixi.js";

import * as C from "../../core/config";
import { pulse } from "../../core/mathx";
import {
  UI_BAD,
  UI_GOLD,
  UI_GOOD,
  UI_WARN,
  UI_WHITE,
  lerpColor,
  shade,
  toHex,
  type RGB,
  type Theme,
} from "../../core/palette";
import type { FontBook } from "../../gfx/fonts";
import { Bar } from "../bar";
import { setUiGlow, uiGlowSprite } from "../glow";
import { Label } from "../text";
import { HudAnim } from "./HudAnim";
import { ComboBadge, EffectChip, LifeIcon, hudBackdropTexture } from "./widgets";

/**
 * The only channel gameplay feeds the HUD. See integration.md S8.1.
 *
 * Every field is optional and every unknown key is ignored, which is the
 * tolerance the Python has and the port keeps. `GameplayWorld.hudState()`
 * satisfies this structurally without the UI layer having to import it.
 */
export interface HudViewState {
  score?: number;
  highscore?: number;
  levelName?: string;
  levelIndex?: number;
  goalFood?: number;
  foodEaten?: number;
  lives?: number;
  combo?: number;
  /** Raw stamina, not a fraction. */
  boost?: number;
  boostMax?: number;
  /** Urgency-sorted on the producing side, and capped at six here. */
  effects?: ReadonlyArray<readonly [string, number]>;
  /** True while the boost button is held; drives the bar's end glow. */
  boosting?: boolean;
}

/** Life icons drawn before the row spills into a "+n". ui.py:1078 */
const MAX_ICONS = 6;
/** Width the icon row packs into. ui.py:1080 */
const LIFE_SPAN = 140;
/** Widest an icon pitch may be. ui.py:1081 */
const LIFE_PITCH_MAX = 34;
/** Chips are capped at six and the rest silently dropped. ui.py:1114 */
const MAX_CHIPS = 6;
/** Chip pitch and the right margin the row is anchored to. ui.py:1118-1120 */
const CHIP_PITCH = 38;
const CHIP_MARGIN = 20;

/**
 * `_step(v, steps)` - ui.py:89.
 *
 * Applied to colour *blend factors*, where it produces visible banding: the
 * score colour steps through five levels as heat builds, the goal bar eight as
 * it fills. That stepping is part of the look, so unlike the cache-key
 * quantisers elsewhere in the port it is kept.
 */
function step(v: number, steps = 6): number {
  const n = Math.max(1, Math.trunc(steps));
  const c = Math.max(0, Math.min(1, v));
  return Math.round(c * n) / n;
}

/** `f"{value:,}"` - the thousands separator the score is shown with. */
function grouped(value: number): string {
  return Math.trunc(value).toLocaleString("en-US");
}

export class Hud {
  readonly root = new Container();
  readonly anim = new HudAnim();

  private readonly mask = new Graphics();
  private readonly backdrop = new Sprite();

  private readonly scoreCaption: Label;
  private readonly bestLabel: Label;
  private readonly scoreGlow: Sprite;
  private readonly digits: Label[] = [];
  private readonly digitLayer = new Container();

  private readonly lvlLabel: Label;
  private readonly levelName: Label;
  private readonly goalBar = new Bar();
  private readonly goalLabel: Label;

  private readonly livesLabel: Label;
  private readonly lifeIcons: LifeIcon[] = [];
  private readonly overflowLabel: Label;

  private readonly combo: ComboBadge;
  private readonly comboLabel: Label;

  private readonly boostLabel: Label;
  private readonly boostBar = new Bar();
  private readonly boostGlow: Sprite;

  private readonly chips: EffectChip[] = [];
  private readonly noChipsLabel: Label;

  private readonly stripBloom: Sprite;

  private readonly fonts: FontBook;
  private themeKey = "";
  private digitAdvance = 0;

  constructor(fonts: FontBook) {
    this.fonts = fonts;

    this.mask.rect(0, 0, C.WINDOW_W, C.HUD_H).fill({ color: 0xffffff });
    this.root.addChild(this.mask);
    this.root.mask = this.mask;

    this.scoreCaption = new Label(fonts, fonts.tiny);
    this.bestLabel = new Label(fonts, fonts.tiny);
    this.scoreGlow = uiGlowSprite(62, UI_GOLD, 0);

    this.lvlLabel = new Label(fonts, fonts.tiny);
    this.levelName = new Label(fonts, fonts.get(24, true));
    this.goalLabel = new Label(fonts, fonts.tiny);

    this.livesLabel = new Label(fonts, fonts.tiny);
    this.overflowLabel = new Label(fonts, fonts.tiny);

    this.combo = new ComboBadge(fonts);
    this.comboLabel = new Label(fonts, fonts.tiny);

    this.boostLabel = new Label(fonts, fonts.tiny);
    this.boostGlow = uiGlowSprite(90, UI_WHITE, 0);

    this.noChipsLabel = new Label(fonts, fonts.tiny);
    this.stripBloom = uiGlowSprite(150, UI_WHITE, 0);

    for (let i = 0; i < MAX_ICONS; i++) {
      const icon = new LifeIcon();
      this.lifeIcons.push(icon);
    }
    for (let i = 0; i < MAX_CHIPS; i++) {
      this.chips.push(new EffectChip(fonts));
    }

    // Paint order is the contract; this is ui.py's, top to bottom.
    this.root.addChild(
      this.backdrop,
      this.scoreCaption,
      this.bestLabel,
      this.scoreGlow,
      this.digitLayer,
      this.lvlLabel,
      this.levelName,
      this.goalBar,
      this.goalLabel,
      this.livesLabel,
      ...this.lifeIcons.map((i) => i.root),
      this.overflowLabel,
      this.combo.root,
      this.comboLabel,
      this.boostLabel,
      this.boostBar,
      this.boostGlow,
      ...this.chips.map((c) => c.root),
      this.noChipsLabel,
      this.stripBloom,
    );

    this.scoreCaption.set("SCORE");
    this.livesLabel.set("LIVES");
    this.boostLabel.set("BOOST");
    this.comboLabel.set("COMBO");
    this.noChipsLabel.set("NO ACTIVE POWER-UPS");

    this.goalBar.setRect(272, 58, 250, 9);
    this.boostBar.setRect(958, 12, 222, 12);

    this.scoreCaption.place(20, 6);
    this.bestLabel.place(250, 6, "right");
    this.lvlLabel.place(272, 5);
    this.levelName.place(272, 22);
    this.goalLabel.place(532, 53);
    this.livesLabel.place(636, 5);
    this.boostLabel.place(900, 7);
    this.comboLabel.place(812, 33, "center");
    this.noChipsLabel.place(C.WINDOW_W - CHIP_MARGIN, 45, "right");
    this.scoreGlow.position.set(96, 46);
    this.stripBloom.position.set(C.WINDOW_W * 0.5, C.HUD_H - 2);
  }

  /** Fresh run: the odometer must not roll up from the last level's score. */
  reset(): void {
    this.anim.reset();
  }

  /**
   * `t` is the unscaled `game.time`; the HUD derives its own dt from it.
   * `nowMs` is a wall clock for the bars' tip bloom, which ignores everything.
   */
  update(state: HudViewState, theme: Theme, t: number, nowMs: number): void {
    const score = Math.trunc(state.score ?? 0);
    const highscore = Math.trunc(state.highscore ?? 0);
    const goal = Math.max(1, Math.trunc(state.goalFood ?? 1));
    const eaten = Math.trunc(state.foodEaten ?? 0);
    const lives = Math.trunc(state.lives ?? C.START_LIVES);
    const combo = Math.trunc(state.combo ?? 0);
    const boost = state.boost ?? 0;
    const boostMax = Math.max(1, state.boostMax ?? C.SNAKE_BOOST_MAX);
    const levelIndex = Math.trunc(state.levelIndex ?? 0);
    const levelName = String(state.levelName ?? theme.name ?? "");

    const dt = this.anim.step(t, score, combo, eaten, lives);

    const accent = theme.accent;
    const accent2 = theme.accent2;
    const dim = theme.textDim;

    // Backdrop, rebuilt only when the theme changes.
    const key = `${toHex(accent)}|${toHex(accent2)}|${toHex(theme.grid)}`;
    if (key !== this.themeKey) {
      this.themeKey = key;
      this.backdrop.texture = hudBackdropTexture(theme);
    }

    // ---- score --------------------------------------------------------
    this.scoreCaption.setColor(dim);
    this.bestLabel.set(`BEST ${grouped(Math.max(highscore, score))}`);
    this.bestLabel.setColor(shade(dim, 0.85));

    const hit = this.anim.scoreHit;
    this.scoreGlow.visible = hit > 0.01;
    if (this.scoreGlow.visible) {
      setUiGlow(this.scoreGlow, 62, UI_GOLD, 0.2 + 0.5 * hit);
    }
    this.drawOdometer(
      20,
      28,
      Math.trunc(this.anim.scoreDisp + 0.5),
      lerpColor(UI_WHITE, UI_GOLD, step(0.35 + 0.5 * hit, 5)),
      dt,
    );

    // ---- level + goal --------------------------------------------------
    this.lvlLabel.set(`LVL ${String(levelIndex + 1).padStart(2, "0")}`);
    this.lvlLabel.setColor(accent2);
    this.levelName.set(levelName.toUpperCase());
    this.levelName.setColor(theme.text);

    let goalCol = lerpColor(accent, UI_GOOD, step(eaten / goal, 8));
    if (this.anim.foodPop > 0.01) {
      goalCol = lerpColor(goalCol, UI_WHITE, step(this.anim.foodPop * 0.8, 4));
    }
    // The fraction is deliberately unclamped here; the bar clamps it.
    this.goalBar.set(eaten / goal, goalCol, nowMs);
    this.goalLabel.set(`${Math.min(eaten, goal)} / ${goal}`);
    this.goalLabel.setColor(
      lerpColor(dim, UI_WHITE, step(0.35 + 0.5 * this.anim.foodPop, 4)),
    );

    // ---- lives ---------------------------------------------------------
    this.livesLabel.setColor(dim);
    const shownLives = Math.max(lives, 0);
    const slots = Math.max(C.START_LIVES, shownLives);
    const icons = Math.min(slots, MAX_ICONS);
    // The row packs tighter as lives are gained rather than growing, because it
    // has to stay clear of the combo badge at x = 812.
    const pitch = Math.min(LIFE_PITCH_MAX, LIFE_SPAN / Math.max(1, icons));
    for (let i = 0; i < this.lifeIcons.length; i++) {
      const icon = this.lifeIcons[i]!;
      icon.root.visible = i < icons;
      if (i >= icons) continue;
      // The pop lands on the one slot that just emptied - or just filled.
      const pop = i === shownLives ? this.anim.lifePop : 0;
      icon.draw(654 + i * pitch, 44, theme, i < shownLives, t, i * 1.7, pop);
    }
    this.overflowLabel.visible = slots > MAX_ICONS;
    if (this.overflowLabel.visible) {
      this.overflowLabel.set(`+${slots - MAX_ICONS}`);
      this.overflowLabel.setColor(dim);
      this.overflowLabel.place(658 + icons * pitch, 37);
    }

    // ---- combo ---------------------------------------------------------
    const hasCombo = combo > 1;
    this.combo.root.visible = hasCombo;
    this.comboLabel.visible = !hasCombo;
    if (hasCombo) {
      this.combo.draw(812, 40, combo, this.anim.comboPop, theme, t);
    } else {
      this.comboLabel.setColor(shade(dim, 0.7));
    }

    // ---- boost ---------------------------------------------------------
    const frac = Math.max(0, Math.min(1, boost / boostMax));
    // "Cannot start a boost", not "empty".
    const low = frac < C.SNAKE_BOOST_MIN_TO_START / boostMax;
    const boostCol: RGB = low ? UI_BAD : lerpColor(UI_WARN, accent2, step(frac, 6));
    this.boostLabel.setColor(
      lerpColor(dim, boostCol, low ? step(0.5 + 0.5 * pulse(t, 6.0), 4) : 0.4),
    );
    this.boostBar.set(frac, boostCol, nowMs);

    const boosting = !!state.boosting && frac > 0;
    this.boostGlow.visible = boosting;
    if (boosting) {
      this.boostGlow.position.set(1069, 18);
      setUiGlow(this.boostGlow, 90, boostCol, 0.35);
    }

    // ---- power-up chips ------------------------------------------------
    const effects = (state.effects ?? []).slice(0, MAX_CHIPS);
    const n = effects.length;
    this.noChipsLabel.visible = n === 0;
    if (n === 0) {
      this.noChipsLabel.setColor(shade(dim, 0.6));
    }
    // Right-aligned block, newest on the right; the half-pitch turns the right
    // edge into the centre of the last chip.
    const start = C.WINDOW_W - CHIP_MARGIN - CHIP_PITCH * n + CHIP_PITCH * 0.5;
    for (let i = 0; i < this.chips.length; i++) {
      const chip = this.chips[i]!;
      chip.root.visible = i < n;
      if (i >= n) continue;
      const entry = effects[i]!;
      chip.draw(start + i * CHIP_PITCH, 50, entry[0], entry[1], theme, t);
    }

    // A thin bloom under the whole strip, tying it to the arena border below.
    setUiGlow(this.stripBloom, 150, accent, 0.1);
  }

  /**
   * `_draw_odometer` - ui.py:781-818.
   *
   * Each character that changed slides down into place and fades in. The travel
   * is deliberately short: any further and a rolling digit would climb into the
   * "SCORE" caption above it.
   */
  private drawOdometer(x: number, y: number, value: number, color: RGB, dt: number): void {
    const text = grouped(value);
    const rolls = this.anim.syncDigits(text, dt);

    // The widest digit, so a changing score never makes the layout jitter.
    if (this.digitAdvance === 0) {
      let adv = 4;
      for (const d of "0123456789") {
        adv = Math.max(adv, this.fonts.measureWidth(this.fonts.displayAt(34), d));
      }
      this.digitAdvance = Math.max(4, Math.trunc(adv));
    }
    const adv = this.digitAdvance;
    const face = this.fonts.faceMetrics(this.fonts.displayAt(34));

    let cx = x;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i]!;
      let slot = this.digits[i];
      if (!slot) {
        slot = new Label(this.fonts, this.fonts.displayAt(34));
        this.digitLayer.addChild(slot);
        this.digits.push(slot);
      }
      slot.visible = true;
      slot.set(ch);
      slot.setColor(color);

      const roll = rolls[i] ?? 0;
      const isDigit = ch >= "0" && ch <= "9";
      const stepW = isDigit ? adv : Math.max(4, Math.trunc(adv / 2));
      const oy = Math.trunc(-roll * face.height * 0.22);
      const px = cx + (stepW - slot.textWidth) * 0.5;

      slot.place(px, y + oy);
      slot.setAlpha(1 - roll * 0.55);
      cx += stepW;
    }
    for (let i = text.length; i < this.digits.length; i++) {
      this.digits[i]!.visible = false;
    }
  }
}
