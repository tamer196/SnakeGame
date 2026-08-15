/**
 * The HUD's animation memory - a port of `_HudAnim` and the bookkeeping block
 * at the top of `_draw_hud_impl` (`snake/gfx/ui.py:693-710, 1020-1040`).
 *
 * Python caches this on the game object through a weak map, because `draw_hud`
 * is a free function with nowhere else to put it. The port hangs it off the HUD
 * view instead; do not monkey-patch `Game`.
 *
 * It owns no display objects, so the arithmetic - which is the part a
 * regression would hide - is testable on its own.
 *
 * Two things here are easy to get wrong:
 *
 * - **The clock is real time.** `draw_hud` is called with the unscaled
 *   `game.time` and differences it to get its own dt, clamped at 0.1 s (not
 *   `MAX_DT`). Slow motion must not reach the score roll-up or the combo pop:
 *   that split is the whole point of hit-stop with a live UI.
 * - **The score chase is a true exponential**, `1 - exp(-11 dt)`, not the
 *   `min(1, dt * k)` approximation used for the snake's bank. It is frame-rate
 *   independent and must not be "simplified".
 */

/** ui.py:1022-1023. Heat builds while the counter chases a gain. */
const SCORE_HIT_RISE = 4.0;
/** ui.py:1028. ...and cools every frame regardless. */
const SCORE_HIT_DECAY = 2.2;
/** ui.py:1025. The exponential chase rate. */
const SCORE_CHASE = 11.0;
/** ui.py:1026. Below this the counter snaps home. */
const SCORE_SNAP = 0.6;
/** ui.py:1022. The counter is "chasing" once it is this far behind. */
const SCORE_CHASING = 0.5;
/** Linear pop decays. ui.py:1032, 1036, 1040 */
const COMBO_POP_DECAY = 3.0;
const FOOD_POP_DECAY = 2.6;
const LIFE_POP_DECAY = 2.4;
/** ui.py:996. The HUD's own dt clamp. */
const DT_CLAMP = 0.1;
/** ui.py:803. Odometer digit roll decay. */
const ROLL_DECAY = 4.2;

export class HudAnim {
  /** The displayed score, chasing the real one. */
  scoreDisp = 0;
  /** 0..1 heat while points are landing. */
  scoreHit = 0;
  /** The digit string last shown, for spotting which digits changed. */
  digits = "";
  /** Per-digit roll weight, 1 when a digit has just changed. */
  rolls: number[] = [];

  comboPop = 0;
  prevCombo = 0;
  foodPop = 0;
  prevFood = 0;
  lifePop = 0;
  /** -1 so the first frame does not pop. */
  prevLives = -1;

  lastT = 0;

  /**
   * Advance to absolute time `t` (the unscaled `game.time`) and fold in this
   * frame's values. Returns the derived dt, which the odometer also needs.
   */
  step(t: number, score: number, combo: number, eaten: number, lives: number): number {
    const dt = Math.max(0, Math.min(DT_CLAMP, t - this.lastT));
    this.lastT = t;

    if (score > this.scoreDisp + SCORE_CHASING) {
      this.scoreHit = Math.min(1, this.scoreHit + dt * SCORE_HIT_RISE);
    }
    this.scoreDisp += (score - this.scoreDisp) * (1 - Math.exp(-SCORE_CHASE * dt));
    if (Math.abs(score - this.scoreDisp) < SCORE_SNAP) this.scoreDisp = score;
    this.scoreHit = Math.max(0, this.scoreHit - dt * SCORE_HIT_DECAY);

    if (combo > this.prevCombo) this.comboPop = 1;
    this.prevCombo = combo;
    this.comboPop = Math.max(0, this.comboPop - dt * COMBO_POP_DECAY);

    if (eaten > this.prevFood) this.foodPop = 1;
    this.prevFood = eaten;
    this.foodPop = Math.max(0, this.foodPop - dt * FOOD_POP_DECAY);

    // `!=`, not `<`: gaining a life pops the row exactly as losing one does.
    if (this.prevLives >= 0 && lives !== this.prevLives) this.lifePop = 1;
    this.prevLives = lives;
    this.lifePop = Math.max(0, this.lifePop - dt * LIFE_POP_DECAY);

    return dt;
  }

  /**
   * Fold a new digit string into the roll state - `_draw_odometer`'s first half
   * (ui.py:789-798), split out because it is pure.
   *
   * A change in *length* resets the whole row rather than trying to align the
   * old digits with the new, so crossing 999 -> 1,000 rolls everything.
   */
  syncDigits(text: string, dt: number): number[] {
    if (text.length !== this.digits.length) {
      this.rolls = new Array(text.length).fill(0);
      this.digits = " ".repeat(text.length);
    }
    while (this.rolls.length < text.length) this.rolls.push(0);

    for (let i = 0; i < text.length; i++) {
      if (i < this.digits.length && this.digits[i] !== text[i]) this.rolls[i] = 1;
    }
    this.digits = text;

    for (let i = 0; i < this.rolls.length; i++) {
      this.rolls[i] = Math.max(0, (this.rolls[i] ?? 0) - dt * ROLL_DECAY);
    }
    return this.rolls;
  }

  /** Back to the state a fresh HUD starts in. */
  reset(): void {
    this.scoreDisp = 0;
    this.scoreHit = 0;
    this.digits = "";
    this.rolls = [];
    this.comboPop = 0;
    this.prevCombo = 0;
    this.foodPop = 0;
    this.prevFood = 0;
    this.lifePop = 0;
    this.prevLives = -1;
    this.lastT = 0;
  }
}
