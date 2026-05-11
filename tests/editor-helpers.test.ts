/**
 * Unit tests for the pure editor helpers in `src/editor.ts`.
 *
 * These cover the CSV parsers (`parseColorList`, `parseWeights`) and the
 * RGB tuple helpers (`cssToRgb`, `rgbToCss`, `isRgbTuple`) that bridge
 * the editor's text inputs and `ha-form`'s `color_rgb` selector. They are
 * pure with no DOM / Lit dependency, so a regression in any of them is a
 * silent bug between editor preview and saved YAML.
 */
import { describe, expect, it } from "vitest";

import {
  cssToRgb,
  isRgbTuple,
  parseColorList,
  parseWeights,
  rgbToCss,
} from "../src/editor";

describe("parseColorList", () => {
  it("returns empty array for empty input", () => {
    expect(parseColorList("")).toEqual([]);
  });

  it("splits on comma and trims", () => {
    expect(parseColorList("#aaa, #bbb,#ccc")).toEqual(["#aaa", "#bbb", "#ccc"]);
  });

  it("splits on newlines too", () => {
    expect(parseColorList("#aaa\n#bbb\n#ccc")).toEqual([
      "#aaa",
      "#bbb",
      "#ccc",
    ]);
  });

  it("converts empty positions to null sentinels", () => {
    // The mid-list null is the theme-fallthrough signal.
    expect(parseColorList("#a,,#c")).toEqual(["#a", null, "#c"]);
  });

  it("trims trailing nulls (so a trailing comma doesn't add slots)", () => {
    expect(parseColorList("#a, #b, ")).toEqual(["#a", "#b"]);
  });

  it("preserves leading nulls", () => {
    // A leading null IS meaningful — slot 0 should fall through to theme.
    expect(parseColorList(", #b, #c")).toEqual([null, "#b", "#c"]);
  });

  it("handles whitespace-only entries as null", () => {
    expect(parseColorList("#a,   ,#c")).toEqual(["#a", null, "#c"]);
  });
});

describe("parseWeights", () => {
  it("returns empty array for empty input", () => {
    expect(parseWeights("")).toEqual([]);
  });

  it("splits on commas and whitespace", () => {
    expect(parseWeights("1,2 3,4")).toEqual([1, 2, 3, 4]);
  });

  it("accepts decimals", () => {
    expect(parseWeights("1.5, 2.5, 0.25")).toEqual([1.5, 2.5, 0.25]);
  });

  it("silently drops non-numeric tokens", () => {
    expect(parseWeights("1, foo, 2, NaN, 3")).toEqual([1, 2, 3]);
  });

  it("drops zero and negative values (Z2M weights are positive)", () => {
    // The function comment is "positive numbers" — 0 and -1 must both
    // be filtered so a weight CSV of `0, 1, -1` becomes `[1]`.
    expect(parseWeights("0, 1, -1, 2")).toEqual([1, 2]);
  });

  it("drops Infinity / -Infinity (Number.isFinite gate)", () => {
    expect(parseWeights("1, Infinity, 2, -Infinity, 3")).toEqual([1, 2, 3]);
  });
});

describe("cssToRgb", () => {
  it("returns null for undefined / empty", () => {
    expect(cssToRgb(undefined)).toBeNull();
    expect(cssToRgb("")).toBeNull();
  });

  it("parses #RRGGBB", () => {
    expect(cssToRgb("#ff8000")).toEqual([255, 128, 0]);
  });

  it("parses uppercase hex", () => {
    expect(cssToRgb("#FF8000")).toEqual([255, 128, 0]);
  });

  it("parses #RGB shorthand by repeating each digit", () => {
    // #fa0 → #ffaa00 → [255, 170, 0]
    expect(cssToRgb("#fa0")).toEqual([255, 170, 0]);
  });

  it("parses rgb(r, g, b) with whitespace tolerance", () => {
    expect(cssToRgb("rgb(10, 20, 30)")).toEqual([10, 20, 30]);
    expect(cssToRgb("rgb( 10 , 20 , 30 )")).toEqual([10, 20, 30]);
  });

  it("trims surrounding whitespace before matching", () => {
    expect(cssToRgb("  #ff8000  ")).toEqual([255, 128, 0]);
  });

  it("returns null for named colours", () => {
    expect(cssToRgb("red")).toBeNull();
    expect(cssToRgb("rebeccapurple")).toBeNull();
  });

  it("returns null for var(--…)", () => {
    expect(cssToRgb("var(--primary-color)")).toBeNull();
  });

  it("returns null for hsl()", () => {
    expect(cssToRgb("hsl(120, 50%, 50%)")).toBeNull();
  });

  it("returns null for malformed hex", () => {
    expect(cssToRgb("#zzzzzz")).toBeNull();
    expect(cssToRgb("#abcd")).toBeNull(); // 4-digit not supported
    expect(cssToRgb("#12345")).toBeNull(); // 5-digit not supported
  });
});

describe("rgbToCss", () => {
  it("formats as rgb(r, g, b) with comma-space", () => {
    expect(rgbToCss([10, 20, 30])).toBe("rgb(10, 20, 30)");
  });

  it("round-trips with cssToRgb", () => {
    const triple = [128, 64, 200] as const;
    const css = rgbToCss(triple);
    expect(cssToRgb(css)).toEqual(triple);
  });

  it("handles boundary values", () => {
    expect(rgbToCss([0, 0, 0])).toBe("rgb(0, 0, 0)");
    expect(rgbToCss([255, 255, 255])).toBe("rgb(255, 255, 255)");
  });
});

describe("isRgbTuple", () => {
  it("accepts valid 3-element number arrays", () => {
    expect(isRgbTuple([10, 20, 30])).toBe(true);
    expect(isRgbTuple([0, 0, 0])).toBe(true);
  });

  it("rejects wrong length", () => {
    expect(isRgbTuple([10, 20])).toBe(false);
    expect(isRgbTuple([10, 20, 30, 40])).toBe(false);
    expect(isRgbTuple([])).toBe(false);
  });

  it("rejects non-array values", () => {
    expect(isRgbTuple(null)).toBe(false);
    expect(isRgbTuple(undefined)).toBe(false);
    expect(isRgbTuple("rgb(1,2,3)")).toBe(false);
    expect(isRgbTuple({ 0: 1, 1: 2, 2: 3, length: 3 })).toBe(false);
  });

  it("rejects arrays with non-number elements", () => {
    expect(isRgbTuple([10, "20", 30])).toBe(false);
    expect(isRgbTuple([10, null, 30])).toBe(false);
    expect(isRgbTuple([10, undefined, 30])).toBe(false);
  });
});
