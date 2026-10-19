/**
 * Unit tests for the pure colour parser in `src/editor.ts`.
 *
 * `cssToRgb` turns a saved colour into what the swatch's colour input
 * can show. Anything it can't parse (named colours, `var(--…)`, hsl())
 * keeps working in YAML and draws a grey swatch, so a regression here is
 * a silent mismatch between the swatch and the wheel.
 */
import { describe, expect, it } from "vite-plus/test";

import { cssToRgb } from "../src/editor";

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
