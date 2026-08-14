/**
 * The two clocks a gameplay frame runs on, passed around as one value.
 *
 * `scenes/gameplay.py` keeps them apart on purpose: `clock_t` advances by the
 * effect-scaled frame time and drives food, runes, the arena and the snake,
 * while `hazard_t` advances by that same step times the difficulty's
 * `hazard_mult`, so a mode that speeds hazards up speeds their *animation* up
 * with them. Handing a hazard `clock_t` is silent and looks almost right until
 * a hard difficulty runs its sweepers out of sync with their own hitboxes.
 *
 * Passing both as a named pair rather than two bare numbers is the cheapest way
 * to make that mistake impossible at the call site.
 */
export interface FrameClocks {
  /** The scene clock. Food, runes, the arena and the snake animate from this. */
  readonly t: number;
  /** The hazard clock: `t` scaled by the difficulty's hazard multiplier. */
  readonly hazardT: number;
}
