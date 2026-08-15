/**
 * The desaturated theme the result screens wear - a port of `_mute` and
 * `_mute_theme` (`snake/scenes/gameover.py:103-132`).
 *
 * A colour is drained toward its own luminance and then darkened, which keeps
 * the hue relationships of the level's palette while taking the life out of
 * them. Every field gets its own pair of factors: the backdrop is drained hard,
 * the accent much less, and hazards barely at all, so the thing that killed you
 * stays legible.
 *
 * `text` is the one exception - it is blended toward `UI_DIM` rather than
 * muted, because running it through the luminance drain would turn near-white
 * text grey and make the panel copy unreadable.
 */

import { UI_DIM, lerpColor, shade, toHex, type RGB, type Theme } from "../core/palette";

/** Fallback when a colour cannot be read at all. gameover.py:108 */
const FALLBACK: RGB = [90, 96, 110];

/**
 * Drain a colour toward its own luminance, then darken it.
 *
 * The luminance weights are the standard perceptual ones, and the result is
 * truncated per channel exactly as the Python's is.
 */
export function mute(color: RGB, grey = 0.62, dark = 0.7): RGB {
  const r = color[0];
  const g = color[1];
  const b = color[2];
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return FALLBACK;
  const lum = Math.trunc(0.299 * r + 0.587 * g + 0.114 * b);
  return shade(lerpColor([r, g, b], [lum, lum, lum], grey), dark);
}

/**
 * A desaturated copy of a theme, used for the whole game-over palette.
 *
 * The `hex` mirror is rebuilt too. Forgetting that is a silent bug: every Pixi
 * tint in the renderer reads from `theme.hex`, so a muted theme with a stale
 * mirror would desaturate the text and leave the graphics at full colour.
 */
export function muteTheme(theme: Theme): Theme {
  const bgTop = mute(theme.bgTop, 0.75, 0.62);
  const bgBottom = mute(theme.bgBottom, 0.75, 0.62);
  const grid = mute(theme.grid, 0.8, 0.6);
  const accent = mute(theme.accent, 0.55, 0.78);
  const accent2 = mute(theme.accent2, 0.6, 0.72);
  const snakeHead = mute(theme.snakeHead);
  const snakeA = mute(theme.snakeA);
  const snakeB = mute(theme.snakeB);
  const food = mute(theme.food);
  const hazard = mute(theme.hazard, 0.35, 0.85);
  const text = lerpColor(theme.text, UI_DIM, 0.35);
  const textDim = mute(theme.textDim, 0.5, 0.9);

  return {
    name: theme.name,
    bgStyle: theme.bgStyle,
    bgTop,
    bgBottom,
    grid,
    accent,
    accent2,
    snakeHead,
    snakeA,
    snakeB,
    food,
    hazard,
    text,
    textDim,
    hex: {
      bgTop: toHex(bgTop),
      bgBottom: toHex(bgBottom),
      grid: toHex(grid),
      accent: toHex(accent),
      accent2: toHex(accent2),
      snakeHead: toHex(snakeHead),
      snakeA: toHex(snakeA),
      snakeB: toHex(snakeB),
      food: toHex(food),
      hazard: toHex(hazard),
      text: toHex(text),
      textDim: toHex(textDim),
    },
  };
}
