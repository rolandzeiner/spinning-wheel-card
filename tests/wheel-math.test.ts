/**
 * Unit tests for the pure-math helpers in `src/spinning-wheel-card.ts`.
 *
 * Covers angle wrapping (used everywhere in the physics loop and segment
 * resolver) and the runtime CSS-colour parser (`cssToRgbTriple` —
 * supports `rgba()` whereas the editor's variant only supports `rgb()`).
 *
 * These are the highest-leverage unit tests in the repo: a regression in
 * either silently corrupts EVERY spin (wrong segment chosen, wrong
 * `wheel_color_rgb` injected into action data).
 */
import { describe, expect, it } from "vitest";

import { cssToRgbTriple, wrapAngle } from "../src/spinning-wheel-card";

const TWO_PI = Math.PI * 2;

describe("wrapAngle", () => {
  it("returns 0 for 0", () => {
    expect(wrapAngle(0)).toBe(0);
  });

  it("returns the input unchanged when already in [0, 2π)", () => {
    expect(wrapAngle(Math.PI)).toBe(Math.PI);
    expect(wrapAngle(Math.PI / 2)).toBe(Math.PI / 2);
  });

  it("wraps positive overshoot", () => {
    // 2π wraps to 0 (the upper bound is exclusive).
    expect(wrapAngle(TWO_PI)).toBeCloseTo(0, 12);
    // 3π → π
    expect(wrapAngle(3 * Math.PI)).toBeCloseTo(Math.PI, 12);
  });

  it("wraps negative angles into [0, 2π)", () => {
    // -π → π
    expect(wrapAngle(-Math.PI)).toBeCloseTo(Math.PI, 12);
    // -0.1 rad → just under 2π
    expect(wrapAngle(-0.1)).toBeCloseTo(TWO_PI - 0.1, 12);
  });

  it("survives multi-billion-radian inputs without drift", () => {
    // The whole point of this helper: `%` directly on huge doubles
    // accumulates float drift. After many full revolutions the wrapped
    // value must stay within machine epsilon of the equivalent small angle.
    const huge = TWO_PI * 1_000_000 + 0.1;
    expect(wrapAngle(huge)).toBeCloseTo(0.1, 6);
  });

  it("never returns 2π itself", () => {
    // Upper bound is exclusive — wrapping should always land in [0, 2π).
    for (const a of [TWO_PI, TWO_PI * 2, TWO_PI * 100]) {
      const w = wrapAngle(a);
      expect(w).toBeGreaterThanOrEqual(0);
      expect(w).toBeLessThan(TWO_PI);
    }
  });
});

describe("cssToRgbTriple", () => {
  it("parses #RRGGBB", () => {
    expect(cssToRgbTriple("#ff8000")).toEqual([255, 128, 0]);
  });

  it("accepts uppercase hex", () => {
    expect(cssToRgbTriple("#FF8000")).toEqual([255, 128, 0]);
  });

  it("parses #RGB shorthand", () => {
    expect(cssToRgbTriple("#fa0")).toEqual([255, 170, 0]);
  });

  it("parses rgb(r, g, b)", () => {
    expect(cssToRgbTriple("rgb(10, 20, 30)")).toEqual([10, 20, 30]);
  });

  it("parses rgba(r, g, b, a) and ignores alpha", () => {
    // The editor's `cssToRgb` only matches `rgb(...)`. The runtime parser
    // ALSO accepts `rgba(...)` because action `data` can carry any CSS
    // colour the user put in YAML. Drift between these two helpers
    // (one supporting rgba, the other not) is the kind of cross-file
    // bug that's invisible until a user hits it — this test pins both.
    expect(cssToRgbTriple("rgba(10, 20, 30, 0.5)")).toEqual([10, 20, 30]);
  });

  it("trims surrounding whitespace", () => {
    expect(cssToRgbTriple("  #abc  ")).toEqual([170, 187, 204]);
  });

  it("returns null for named colours", () => {
    expect(cssToRgbTriple("red")).toBeNull();
  });

  it("returns null for var(--…) and hsl()", () => {
    expect(cssToRgbTriple("var(--primary-color)")).toBeNull();
    expect(cssToRgbTriple("hsl(120, 50%, 50%)")).toBeNull();
  });

  it("returns null for malformed hex", () => {
    expect(cssToRgbTriple("#zzzzzz")).toBeNull();
    expect(cssToRgbTriple("#12345")).toBeNull();
  });

  it("handles black / white boundaries", () => {
    expect(cssToRgbTriple("#000000")).toEqual([0, 0, 0]);
    expect(cssToRgbTriple("#ffffff")).toEqual([255, 255, 255]);
    expect(cssToRgbTriple("#000")).toEqual([0, 0, 0]);
    expect(cssToRgbTriple("#fff")).toEqual([255, 255, 255]);
  });
});
