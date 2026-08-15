/**
 * Contract tests for the HUD's animation state.
 *
 * The layout is perceptual and is checked against `captures/08-gameplay-ready.png`.
 * What is testable here is the bookkeeping: the score chase, the four pops, and
 * the odometer's digit-roll accounting - all of which run on a clock the HUD
 * derives itself, and all of which would fail silently.
 */

import { describe, expect, it } from "vitest";

import { HudAnim } from "../src/ui/hud/HudAnim";

/** Drive `n` frames of `dt`, holding the inputs steady. */
function run(
  a: HudAnim,
  n: number,
  dt: number,
  score = 0,
  combo = 0,
  eaten = 0,
  lives = 3,
): void {
  for (let i = 0; i < n; i++) a.step(a.lastT + dt, score, combo, eaten, lives);
}

describe("HudAnim: the score counter", () => {
  it("chases the real score and snaps home", () => {
    const a = new HudAnim();
    run(a, 1, 0.016, 1000);
    expect(a.scoreDisp).toBeGreaterThan(0);
    expect(a.scoreDisp).toBeLessThan(1000);

    run(a, 120, 0.016, 1000);
    // The snap means it lands exactly, not asymptotically close.
    expect(a.scoreDisp).toBe(1000);
  });

  it("chases at a frame-rate independent rate", () => {
    // 1 - exp(-11 dt) is a true exponential, not the min(1, dt*k) used for the
    // snake's bank. Ten 10 ms steps must land where one 100 ms step does.
    const fine = new HudAnim();
    const coarse = new HudAnim();
    for (let i = 0; i < 10; i++) fine.step(fine.lastT + 0.01, 10000, 0, 0, 3);
    coarse.step(0.1, 10000, 0, 0, 3);
    expect(fine.scoreDisp).toBeCloseTo(coarse.scoreDisp, 6);
  });

  it("builds heat while chasing and cools afterwards", () => {
    const a = new HudAnim();
    run(a, 5, 0.016, 5000);
    expect(a.scoreHit).toBeGreaterThan(0);

    const peak = a.scoreHit;
    run(a, 200, 0.016, 5000);
    expect(a.scoreHit).toBe(0);
    expect(peak).toBeGreaterThan(0);
  });

  it("clamps its own dt at 0.1, so a stall freezes rather than jumps", () => {
    const a = new HudAnim();
    const b = new HudAnim();
    a.step(0.1, 1000, 0, 0, 3);
    b.step(5.0, 1000, 0, 0, 3);
    expect(b.scoreDisp).toBeCloseTo(a.scoreDisp, 9);
  });
});

describe("HudAnim: the pops", () => {
  it("pops the combo when the chain extends, and decays at 3/s", () => {
    const a = new HudAnim();
    a.step(0.016, 0, 2, 0, 3);
    expect(a.comboPop).toBeCloseTo(1 - 0.016 * 3, 6);

    run(a, 100, 0.016, 0, 2);
    expect(a.comboPop).toBe(0);
  });

  it("pops the food counter only when it rises", () => {
    const a = new HudAnim();
    a.step(0.016, 0, 0, 1, 3);
    expect(a.foodPop).toBeGreaterThan(0.9);

    run(a, 100, 0.016, 0, 0, 1);
    expect(a.foodPop).toBe(0);
    // A level change can lower it; that must not pop.
    a.step(a.lastT + 0.016, 0, 0, 0, 3);
    expect(a.foodPop).toBe(0);
  });

  it("pops the life row when lives change in either direction", () => {
    const a = new HudAnim();
    // The first frame primes prevLives without popping.
    a.step(0.016, 0, 0, 0, 3);
    expect(a.lifePop).toBe(0);

    a.step(0.032, 0, 0, 0, 2);
    expect(a.lifePop).toBeGreaterThan(0.9);

    run(a, 100, 0.016, 0, 0, 0, 2);
    expect(a.lifePop).toBe(0);

    // Gaining one pops too: the Python compares with !=, not <.
    a.step(a.lastT + 0.016, 0, 0, 0, 3);
    expect(a.lifePop).toBeGreaterThan(0.9);
  });
});

describe("HudAnim: the odometer's digits", () => {
  it("rolls only the digits that changed", () => {
    const a = new HudAnim();
    a.syncDigits("1234", 0);
    // First sight of a length rolls everything, since digits start as spaces.
    expect(a.rolls).toEqual([1, 1, 1, 1]);

    a.syncDigits("1234", 1); // decay everything to zero
    expect(a.rolls.every((r) => r === 0)).toBe(true);

    a.syncDigits("1284", 0);
    expect(a.rolls).toEqual([0, 0, 1, 0]);
  });

  it("resets the whole row when the length changes", () => {
    // Crossing 999 -> 1,000 adds a separator and shifts every column, so
    // aligning old digits with new would be wrong.
    const a = new HudAnim();
    a.syncDigits("999", 1);
    a.syncDigits("1,000", 0);
    expect(a.rolls).toHaveLength(5);
    expect(a.rolls).toEqual([1, 1, 1, 1, 1]);
  });

  it("decays rolls at 4.2/s", () => {
    const a = new HudAnim();
    a.syncDigits("7", 0);
    expect(a.rolls[0]).toBe(1);
    a.syncDigits("7", 0.1);
    expect(a.rolls[0]).toBeCloseTo(1 - 0.42, 6);
  });
});

describe("HudAnim: reuse", () => {
  it("resets fully, so a new run does not roll up from the last score", () => {
    // Scene instances are cached and reused; this is the documented #1 bug.
    const a = new HudAnim();
    run(a, 60, 0.016, 9999, 5, 12, 1);
    expect(a.scoreDisp).toBeGreaterThan(0);

    a.reset();
    expect(a.scoreDisp).toBe(0);
    expect(a.scoreHit).toBe(0);
    expect(a.digits).toBe("");
    expect(a.rolls).toEqual([]);
    expect(a.prevCombo).toBe(0);
    expect(a.prevFood).toBe(0);
    expect(a.prevLives).toBe(-1);
    expect(a.lastT).toBe(0);
  });
});
