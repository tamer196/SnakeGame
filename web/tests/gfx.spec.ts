/**
 * Contract tests for the graphics layer's shared pieces.
 *
 * These cover only what can be checked without a GPU or a DOM: the seeded RNG
 * every background layout is built from, and the pure colour maths the stages
 * lean on. The textures and the twelve stages themselves are verified visually,
 * by capturing them in a real browser and comparing against the Python
 * screenshots in `captures/` - a unit test cannot tell you a nebula looks wrong.
 *
 * The RNG contract matters more than it looks. Twelve stage implementations
 * were written against Python's `random.Random` semantics, where `randint` is
 * inclusive at *both* ends. JavaScript's usual idiom is not, and an off-by-one
 * here would quietly change element counts in every stage at once.
 */

import { describe, expect, it } from "vitest";

import { hashSeed, makeSeededRng } from "../src/gfx/rng";
import { clamp8, lerpColor, shade, toHex } from "../src/core/palette";

describe("gfx rng: Python-shaped seeded randomness", () => {
  it("is deterministic for a given seed and independent across seeds", () => {
    const a = makeSeededRng("grid|Neon Grid");
    const b = makeSeededRng("grid|Neon Grid");
    const c = makeSeededRng("nebula|Deep Nebula");

    const seqA = Array.from({ length: 32 }, () => a.random());
    const seqB = Array.from({ length: 32 }, () => b.random());
    const seqC = Array.from({ length: 32 }, () => c.random());

    expect(seqA).toEqual(seqB);
    expect(seqA).not.toEqual(seqC);
  });

  it("accepts a numeric seed as well as a string key", () => {
    const viaNumber = makeSeededRng(12345);
    const viaHash = makeSeededRng(hashSeed("grid|Neon Grid"));
    expect(Number.isFinite(viaNumber.random())).toBe(true);
    expect(Number.isFinite(viaHash.random())).toBe(true);
  });

  it("hashes stably, which is the whole point of not using Python's salted hash", () => {
    expect(hashSeed("grid|Neon Grid")).toBe(hashSeed("grid|Neon Grid"));
    expect(hashSeed("grid|Neon Grid")).not.toBe(hashSeed("grid|Neon Gris"));
    // Must stay a uint32 so it can seed mulberry32 without precision loss.
    for (const k of ["", "a", "prism|Prism Core", "é—😀"]) {
      const h = hashSeed(k);
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(0xffffffff);
    }
  });

  it("random() stays in [0, 1)", () => {
    const r = makeSeededRng(7);
    for (let i = 0; i < 5000; i++) {
      const v = r.random();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("uniform(a, b) stays within its bounds, including a reversed pair", () => {
    const r = makeSeededRng("uniform");
    for (let i = 0; i < 2000; i++) {
      const v = r.uniform(-3.5, 8.25);
      expect(v).toBeGreaterThanOrEqual(-3.5);
      expect(v).toBeLessThanOrEqual(8.25);
    }
    // Python's uniform(b, a) simply interpolates the other way; it does not throw.
    for (let i = 0; i < 200; i++) {
      const v = r.uniform(5, 1);
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(5);
    }
  });

  it("randint is INCLUSIVE at both ends, as Python's is", () => {
    const r = makeSeededRng("randint");
    const seen = new Set<number>();
    for (let i = 0; i < 20000; i++) {
      const v = r.randint(2, 7);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(2);
      expect(v).toBeLessThanOrEqual(7);
      seen.add(v);
    }
    // Both endpoints must actually occur, or a stage's element count is short.
    expect([...seen].sort((x, y) => x - y)).toEqual([2, 3, 4, 5, 6, 7]);
  });

  it("randint(n, n) is exactly n, and an inverted range does not hang", () => {
    const r = makeSeededRng("degenerate");
    for (let i = 0; i < 50; i++) expect(r.randint(4, 4)).toBe(4);
    for (let i = 0; i < 50; i++) expect(r.randint(9, 3)).toBe(9);
  });

  it("randrange is [0, n) and never returns n", () => {
    const r = makeSeededRng("randrange");
    const seen = new Set<number>();
    for (let i = 0; i < 20000; i++) {
      const v = r.randrange(5);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(5);
      seen.add(v);
    }
    expect([...seen].sort((x, y) => x - y)).toEqual([0, 1, 2, 3, 4]);
    expect(r.randrange(0)).toBe(0);
    expect(r.randrange(-3)).toBe(0);
  });

  it("choice returns a real element and covers the whole list", () => {
    const r = makeSeededRng("choice");
    const items = ["a", "b", "c", "d"] as const;
    const seen = new Set<string>();
    for (let i = 0; i < 5000; i++) {
      const v = r.choice(items);
      expect(items).toContain(v);
      seen.add(v);
    }
    expect(seen.size).toBe(items.length);
    expect(() => r.choice([])).toThrow();
  });

  it("shuffle permutes in place without losing or duplicating anything", () => {
    const r = makeSeededRng("shuffle");
    const arr = Array.from({ length: 64 }, (_, i) => i);
    const copy = [...arr];
    r.shuffle(arr);
    expect(arr).toHaveLength(64);
    expect([...arr].sort((a, b) => a - b)).toEqual(copy);
    expect(arr).not.toEqual(copy);
  });
});

describe("gfx colour maths used by every stage", () => {
  it("clamp8 truncates and saturates like the Python", () => {
    expect(clamp8(-5)).toBe(0);
    expect(clamp8(300)).toBe(255);
    expect(clamp8(12.9)).toBe(12);
    expect(clamp8(Number.NaN)).toBe(0);
  });

  it("shade above 1 saturates per channel, which is why tint x alpha cannot express it", () => {
    // This is the documented limitation of moving colour onto the sprite: the
    // hue skews toward white as channels clip, and alpha cannot reproduce that.
    const c = shade([200, 100, 50], 1.6);
    expect(c[0]).toBe(255);
    expect(c[1]).toBe(160);
    expect(c[2]).toBe(80);
  });

  it("lerpColor clamps t rather than extrapolating", () => {
    const a: [number, number, number] = [0, 0, 0];
    const b: [number, number, number] = [255, 255, 255];
    expect(lerpColor(a, b, -1)).toEqual([0, 0, 0]);
    expect(lerpColor(a, b, 2)).toEqual([255, 255, 255]);
    expect(lerpColor(a, b, 0.5)).toEqual([127, 127, 127]);
  });

  it("toHex packs to the 0xRRGGBB Pixi wants", () => {
    expect(toHex([0, 0, 0])).toBe(0x000000);
    expect(toHex([255, 255, 255])).toBe(0xffffff);
    expect(toHex([0, 236, 255])).toBe(0x00ecff);
  });
});
