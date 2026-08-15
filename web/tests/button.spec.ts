/**
 * Contract tests for the button's input semantics and palette.
 *
 * The click rules are the part of this widget a regression would break
 * silently: a button that fires on press instead of release, or that survives a
 * drag-off, still looks perfect in a screenshot. So the input and animation
 * state is split into `ButtonState`, which owns no display objects and can be
 * driven here without a GPU.
 *
 * The hover-edge test is the subtle one. In the Python, every scene forwards
 * move events to its buttons before calling update, so `hovered` is already
 * true by the time `just_entered` is computed and the hover cue does *not*
 * play when the cursor moves onto a button. A port that derived hover purely
 * from the polled pointer would chirp on every hover-in - five extra sounds
 * crossing the main menu, and nothing visual to catch it.
 */

import { describe, expect, it } from "vitest";

import { ButtonState, buttonFace, hits } from "../src/ui/Button";
import * as C from "../src/core/config";
import { THEMES, UI_BAD, UI_WHITE, lerpColor, shade } from "../src/core/palette";

const RECT = { x: 100, y: 100, w: 200, h: 50 };
const theme = THEMES[0]!;

const move = (x: number, y: number) => ({ type: "move" as const, x, y, button: 0 });
const down = (x: number, y: number, button = 0) => ({ type: "down" as const, x, y, button });
const up = (x: number, y: number, button = 0) => ({ type: "up" as const, x, y, button });

describe("Button: the hit test", () => {
  it("is half-open, so abutting buttons never share an edge", () => {
    // pygame's collidepoint is [left, right); mathx.rectContains is closed and
    // would let both of two touching buttons claim the boundary pixel.
    expect(hits(RECT, 100, 100)).toBe(true);
    expect(hits(RECT, 299.9, 149.9)).toBe(true);
    expect(hits(RECT, 300, 125)).toBe(false);
    expect(hits(RECT, 125, 150)).toBe(false);
    expect(hits(RECT, 99.9, 125)).toBe(false);
  });
});

describe("Button: click semantics", () => {
  it("fires once, on release, when press and release are both inside", () => {
    const b = new ButtonState({ ...RECT });
    expect(b.handlePointer(down(150, 120))).toBe(false);
    expect(b.handlePointer(up(150, 120))).toBe(true);
  });

  it("does not fire when the press was outside", () => {
    const b = new ButtonState({ ...RECT });
    expect(b.handlePointer(down(10, 10))).toBe(false);
    expect(b.handlePointer(up(150, 120))).toBe(false);
  });

  it("cancels when the pointer is dragged off before release", () => {
    const b = new ButtonState({ ...RECT });
    b.handlePointer(down(150, 120));
    expect(b.handlePointer(up(10, 10))).toBe(false);
    // ...and the arming did not survive for a later release inside.
    expect(b.handlePointer(up(150, 120))).toBe(false);
  });

  it("ignores the right button, which is boost during play", () => {
    const b = new ButtonState({ ...RECT });
    expect(b.handlePointer(down(150, 120, 2))).toBe(false);
    expect(b.handlePointer(up(150, 120, 2))).toBe(false);
  });

  it("debounces a second click until the cooldown expires", () => {
    const b = new ButtonState({ ...RECT });
    b.handlePointer(down(150, 120));
    expect(b.handlePointer(up(150, 120))).toBe(true);
    expect(b.cool).toBeCloseTo(C.UI_CLICK_COOLDOWN, 6);

    b.handlePointer(down(150, 120));
    expect(b.handlePointer(up(150, 120))).toBe(false);

    // Run the cooldown out and it fires again.
    for (let i = 0; i < 10; i++) b.update(0.02, { x: 150, y: 120 });
    b.handlePointer(down(150, 120));
    expect(b.handlePointer(up(150, 120))).toBe(true);
  });

  it("never fires while disabled", () => {
    const b = new ButtonState({ ...RECT }, false);
    b.handlePointer(down(150, 120));
    expect(b.handlePointer(up(150, 120))).toBe(false);
  });

  it("sets a click flash that decays over 0.3125 s", () => {
    const b = new ButtonState({ ...RECT });
    b.handlePointer(down(150, 120));
    b.handlePointer(up(150, 120));
    expect(b.flash).toBe(1);
    for (let i = 0; i < 31; i++) b.update(0.01, { x: 150, y: 120 });
    expect(b.flash).toBeGreaterThan(0);
    b.update(0.01, { x: 150, y: 120 });
    expect(b.flash).toBe(0);
  });
});

describe("Button: hover", () => {
  it("suppresses justEntered when a move event arrived first", () => {
    // This is the shipped behaviour: the hover cue does NOT play when the
    // cursor moves onto a button.
    const b = new ButtonState({ ...RECT });
    b.handlePointer(move(150, 120));
    b.update(0.016, { x: 150, y: 120 });
    expect(b.hovered).toBe(true);
    expect(b.justEntered).toBe(false);
  });

  it("reports justEntered when the rect moves under a resting pointer", () => {
    // The menu's entrance slide and the pause panel's bounce do exactly this,
    // and those are the cases where the cue is meant to fire.
    const b = new ButtonState({ x: 400, y: 100, w: 200, h: 50 });
    b.update(0.016, { x: 150, y: 120 });
    expect(b.hovered).toBe(false);

    b.rect.x = 100;
    b.update(0.016, { x: 150, y: 120 });
    expect(b.hovered).toBe(true);
    expect(b.justEntered).toBe(true);

    b.update(0.016, { x: 150, y: 120 });
    expect(b.justEntered).toBe(false);
  });

  it("drops hover on touch unless the button is armed", () => {
    // With no cursor, the last touch point lingers and a tapped button would
    // stay lit forever. No Python counterpart - it always has a mouse.
    const b = new ButtonState({ ...RECT });
    b.update(0.016, { x: 150, y: 120, touch: true });
    expect(b.hovered).toBe(false);

    b.handlePointer(down(150, 120));
    b.update(0.016, { x: 150, y: 120, touch: true });
    expect(b.hovered).toBe(true);
  });

  it("approaches hoverT at 13/s and pressT at 22/s", () => {
    const b = new ButtonState({ ...RECT });
    b.hovered = true;
    // 95% of the way in 0.230 s.
    let t = 0;
    while (t < 0.23) {
      b.update(0.01, { x: 150, y: 120 });
      t += 0.01;
    }
    expect(b.hoverT).toBeGreaterThan(0.94);
    expect(b.hoverT).toBeLessThan(0.97);
  });

  it("clamps its own dt at 0.1, not at MAX_DT", () => {
    const a = new ButtonState({ ...RECT });
    const b = new ButtonState({ ...RECT });
    a.hovered = true;
    b.hovered = true;
    a.update(0.1, { x: 150, y: 120 });
    b.update(5.0, { x: 150, y: 120 });
    expect(b.hoverT).toBeCloseTo(a.hoverT, 12);
  });

  it("keeps hoverT decaying when disabled mid-hover", () => {
    // That is why a disabled+hot body variant exists at all.
    const b = new ButtonState({ ...RECT });
    b.hovered = true;
    for (let i = 0; i < 30; i++) b.update(0.01, { x: 150, y: 120 });
    const before = b.hoverT;
    expect(before).toBeGreaterThan(0.5);

    b.setEnabled(false);
    expect(b.hovered).toBe(false);
    expect(b.armed).toBe(false);
    expect(b.hoverT).toBe(before);
  });
});

describe("Button: the palette", () => {
  it("matches _button_palette for every style, cold and hot", () => {
    const f = (style: Parameters<typeof buttonFace>[0], hot: boolean) =>
      buttonFace(style, theme, hot, true);

    expect(f("primary", false)).toEqual({
      edge: theme.accent,
      text: theme.text,
      alpha: 215,
      border: 2,
    });
    expect(f("primary", true)).toEqual({
      edge: lerpColor(theme.accent, UI_WHITE, 0.35),
      text: theme.text,
      alpha: 215,
      border: 3,
    });
    expect(f("ghost", false)).toEqual({
      edge: theme.textDim,
      text: theme.textDim,
      alpha: 120,
      border: 2,
    });
    expect(f("ghost", true)).toEqual({
      edge: theme.accent,
      text: theme.text,
      alpha: 120,
      border: 3,
    });
    expect(f("danger", false)).toEqual({
      edge: UI_BAD,
      text: lerpColor(UI_BAD, UI_WHITE, 0.5),
      alpha: 220,
      border: 2,
    });
    expect(f("danger", true)).toEqual({
      edge: UI_BAD,
      text: UI_WHITE,
      alpha: 220,
      border: 3,
    });
    expect(f("tile", false)).toEqual({
      edge: theme.accent2,
      text: lerpColor(theme.text, theme.textDim, 0.5),
      alpha: 225,
      border: 2,
    });
    expect(f("tile", true)).toEqual({
      edge: theme.accent,
      text: theme.text,
      alpha: 225,
      border: 3,
    });
  });

  it("applies the disabled transform after picking the row", () => {
    const on = buttonFace("primary", theme, false, true);
    const off = buttonFace("primary", theme, false, false);
    expect(off.edge).toEqual(shade(on.edge, 0.35));
    expect(off.text).toEqual(shade(on.text, 0.45));
    expect(off.alpha).toBe(Math.trunc(215 * 0.7));
    // Border width is untouched by the disabled transform.
    expect(off.border).toBe(on.border);
  });

  it("keeps the border width tied to hot, even when disabled", () => {
    expect(buttonFace("ghost", theme, true, false).border).toBe(3);
    expect(buttonFace("ghost", theme, false, false).border).toBe(2);
  });

  it("gives danger the same red edge in every theme", () => {
    for (const th of THEMES) {
      expect(buttonFace("danger", th, false, true).edge).toEqual(UI_BAD);
    }
  });
});
