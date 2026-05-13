/**
 * Unit tests for the friction module.
 *
 * Pins the slider-anchor values the card has tuned around (slider 5 ==
 * old "medium" feel, etc.) and the pre-v1.2 string→level migration so
 * old YAML keeps working. Also pins the v1.2.4+ Coulomb deceleration
 * curve introduced for finite-time stop.
 */
import { describe, expect, it } from "vitest";

import {
  coulombDecel,
  frictionMultiplier,
  normalizeFriction,
} from "../src/friction";

describe("normalizeFriction", () => {
  it("passes valid integer levels through", () => {
    expect(normalizeFriction(1)).toBe(1);
    expect(normalizeFriction(5)).toBe(5);
    expect(normalizeFriction(10)).toBe(10);
  });

  it("clamps out-of-range integers", () => {
    expect(normalizeFriction(0)).toBe(1);
    expect(normalizeFriction(-3)).toBe(1);
    expect(normalizeFriction(11)).toBe(10);
    expect(normalizeFriction(99)).toBe(10);
  });

  it("falls back to 5 for non-integer numbers", () => {
    // Defensive: only integer levels are valid; floats fall to default.
    expect(normalizeFriction(3.5)).toBe(5);
    expect(normalizeFriction(NaN)).toBe(5);
  });

  it("maps pre-v1.2 string presets", () => {
    // Saved YAML from old versions must keep its feel: medium → 5.
    expect(normalizeFriction("low")).toBe(3);
    expect(normalizeFriction("medium")).toBe(5);
    expect(normalizeFriction("high")).toBe(7);
  });

  it("falls back to 5 for unknown strings", () => {
    expect(normalizeFriction("ultra")).toBe(5);
    expect(normalizeFriction("")).toBe(5);
  });

  it("falls back to 5 for non-string non-number shapes", () => {
    expect(normalizeFriction(null)).toBe(5);
    expect(normalizeFriction(undefined)).toBe(5);
    expect(normalizeFriction({})).toBe(5);
    expect(normalizeFriction([])).toBe(5);
  });
});

describe("frictionMultiplier", () => {
  // Slider anchor values are documented in the JSDoc; if any of these
  // drift, every dashboard that touches the friction slider gets a
  // different feel without a version bump.
  it("anchors slider 1 at 0.998 (long lazy spin)", () => {
    expect(frictionMultiplier(1)).toBeCloseTo(0.998, 6);
  });

  it("anchors slider 5 at 0.99 (= old medium preset)", () => {
    expect(frictionMultiplier(5)).toBeCloseTo(0.99, 6);
  });

  it("anchors slider 10 at 0.97 (stops quickly)", () => {
    expect(frictionMultiplier(10)).toBeCloseTo(0.97, 6);
  });

  it("is monotonically decreasing with level", () => {
    let prev = Infinity;
    for (let level = 1; level <= 10; level++) {
      const f = frictionMultiplier(level);
      expect(f).toBeLessThan(prev);
      prev = f;
    }
  });

  it("intermediate values land at expected piecewise points", () => {
    expect(frictionMultiplier(3)).toBeCloseTo(0.994, 6); // ≈ old "low"
    expect(frictionMultiplier(7)).toBeCloseTo(0.982, 6); // ≈ old "high"
  });

  it("stays inside (0, 1) — required for the exponential decay form", () => {
    for (let level = 1; level <= 10; level++) {
      const f = frictionMultiplier(level);
      expect(f).toBeGreaterThan(0);
      expect(f).toBeLessThan(1);
    }
  });
});

describe("coulombDecel", () => {
  it("anchors slider 5 at the calibrated 0.3 rad/s²", () => {
    expect(coulombDecel(5)).toBeCloseTo(0.3, 6);
  });

  it("scales linearly with slider level (level 10 = 2× level 5)", () => {
    expect(coulombDecel(10)).toBeCloseTo(0.6, 6);
    expect(coulombDecel(1)).toBeCloseTo(0.06, 6);
  });

  it("is monotonically increasing with level — heavier friction stops harder", () => {
    let prev = -Infinity;
    for (let level = 1; level <= 10; level++) {
      const d = coulombDecel(level);
      expect(d).toBeGreaterThan(prev);
      prev = d;
    }
  });

  it("stays strictly positive across the slider range", () => {
    // Coulomb is a magnitude — sign comes from sign(ω) at the call site.
    // A zero or negative return would break finite-time stop.
    for (let level = 1; level <= 10; level++) {
      expect(coulombDecel(level)).toBeGreaterThan(0);
    }
  });
});
