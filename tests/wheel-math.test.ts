/**
 * @vitest-environment happy-dom
 *
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

import {
  cssRgbForLuminance,
  cssToRgbTriple,
  ellipsize,
  mapByUniqueLabel,
  pickFontPx,
  toSpokenLabel,
  wrapAngle,
} from "../src/spinning-wheel-card";

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

describe("pickFontPx", () => {
  // Stub: width scales linearly with px (a reasonable proxy for the real
  // canvas measureText — exact glyph widths vary by font/glyph, but the
  // monotonic "smaller font → narrower text" relationship is what the
  // shrink loop relies on).
  const linear = (textWidthAt1Px: number) => (px: number): number =>
    textWidthAt1Px * px;

  it("returns startPx when text already fits", () => {
    // 4 px-wide text, budget 100, start at 14 → fits immediately.
    const out = pickFontPx(linear(4), 14, 7, 100);
    expect(out).toEqual({ px: 14, fits: true });
  });

  it("walks down one step at a time until it fits", () => {
    // 10 px-wide text, budget 90 → fits exactly at px=9 (90/10).
    const out = pickFontPx(linear(10), 14, 7, 90);
    expect(out).toEqual({ px: 9, fits: true });
  });

  it("stops at minPx with fits=false when budget too tight", () => {
    // 10 px-wide text, budget 50, minPx 7 → even at 7 it needs 70 > 50.
    const out = pickFontPx(linear(10), 14, 7, 50);
    expect(out).toEqual({ px: 7, fits: false });
  });

  it("returns minPx with fits=false for non-positive budgets", () => {
    expect(pickFontPx(linear(10), 14, 7, 0)).toEqual({ px: 7, fits: false });
    expect(pickFontPx(linear(10), 14, 7, -5)).toEqual({ px: 7, fits: false });
    expect(pickFontPx(linear(10), 14, 7, NaN)).toEqual({ px: 7, fits: false });
  });

  it("clamps startPx up to at least minPx", () => {
    // startPx below minPx — should still try minPx, fit since 1×5=5 ≤ 100.
    const out = pickFontPx(linear(1), 5, 7, 100);
    expect(out).toEqual({ px: 7, fits: true });
  });

  it("never measures more than (startPx - minPx + 1) times", () => {
    // Stub that counts invocations; budget impossible so it walks fully.
    let calls = 0;
    const counter = (_px: number): number => {
      calls += 1;
      return 1000;
    };
    const out = pickFontPx(counter, 14, 7, 50);
    expect(out.px).toBe(7);
    expect(out.fits).toBe(false);
    // Inclusive walk from 14 to 7 = 8 steps.
    expect(calls).toBe(8);
  });
});

describe("toSpokenLabel", () => {
  it("passes plain text labels through unchanged", () => {
    expect(toSpokenLabel("Pizza")).toBe("Pizza");
    expect(toSpokenLabel("Try Again")).toBe("Try Again");
    expect(toSpokenLabel("42")).toBe("42");
  });

  it("strips the mdi: prefix from icon labels", () => {
    expect(toSpokenLabel("mdi:home")).toBe("home");
  });

  it("strips any namespace prefix, not just mdi:", () => {
    expect(toSpokenLabel("hass:foo-bar")).toBe("foo bar");
  });

  it("reads hyphens as spaces", () => {
    expect(toSpokenLabel("mdi:food-croissant")).toBe("food croissant");
  });

  it("reads underscores as spaces", () => {
    // The icon-ref regex allows underscores in the namespace; the icon
    // name itself is hyphen-only per MDI, but underscores are handled
    // defensively all the same.
    expect(toSpokenLabel("mdi:home")).toBe("home");
    expect(toSpokenLabel("mdi:food-croissant-thing")).toBe(
      "food croissant thing",
    );
  });

  it("collapses runs of separators to a single space", () => {
    // `[-_]+` — consecutive separators don't produce double spaces.
    expect(toSpokenLabel("mdi:a--b")).toBe("a b");
  });

  it("leaves colon-containing strings that aren't icon refs alone", () => {
    // ICON_REF_RE requires `name:name` shape; arbitrary text with a
    // colon (or a trailing colon) is not an icon and passes through.
    expect(toSpokenLabel("Time: 5pm")).toBe("Time: 5pm");
    expect(toSpokenLabel("ratio 3:1")).toBe("ratio 3:1");
  });

  it("returns empty string for empty input", () => {
    expect(toSpokenLabel("")).toBe("");
  });
});

describe("cssRgbForLuminance", () => {
  it("reads opaque colours like cssToRgbTriple", () => {
    expect(cssRgbForLuminance("#102030")).toEqual([16, 32, 48]);
    expect(cssRgbForLuminance(" rgb(1, 2, 3) ")).toEqual([1, 2, 3]);
    expect(cssRgbForLuminance("rgba(1, 2, 3, 1)")).toEqual([1, 2, 3]);
  });

  it("blends a see-through colour onto white", () => {
    // Half-transparent black on a white card is mid-grey, not black —
    // which is what decides between dark and light label text.
    expect(cssRgbForLuminance("rgba(0, 0, 0, 0.5)")).toEqual([128, 128, 128]);
    expect(cssRgbForLuminance("rgba(255, 0, 0, 0)")).toEqual([255, 255, 255]);
    expect(cssRgbForLuminance("rgba(0, 0, 0, 0.25)")).toEqual([191, 191, 191]);
  });

  it("treats an alpha outside 0–1 as its nearest end", () => {
    expect(cssRgbForLuminance("rgba(10, 20, 30, 7)")).toEqual([10, 20, 30]);
  });

  it("returns null for what it can't parse", () => {
    expect(cssRgbForLuminance("navy")).toBeNull();
    expect(cssRgbForLuminance("var(--primary-color)")).toBeNull();
    expect(cssRgbForLuminance("#12")).toBeNull();
  });
});

describe("ellipsize", () => {
  // One unit wide per character.
  const measure = (text: string): number => text.length;

  it("returns text that fits unchanged", () => {
    expect(ellipsize(measure, "Dishes", 6)).toBe("Dishes");
    expect(ellipsize(measure, "", 0)).toBe("");
  });

  it("cuts until the text and its ellipsis fit", () => {
    expect(ellipsize(measure, "Take out the bins", 8)).toBe("Take ou…");
  });

  it("keeps the first character however little room there is", () => {
    expect(ellipsize(measure, "Dishes", 0)).toBe("D…");
  });
});

describe("mapByUniqueLabel", () => {
  it("picks once per label and shares the pick between its segments", () => {
    const picks: Array<[number, number]> = [];
    const out = mapByUniqueLabel(["a", "b", "a", "c", "b"], (slot, index) => {
      picks.push([slot, index]);
      return `colour-${slot}`;
    });
    expect(out).toEqual([
      "colour-0",
      "colour-1",
      "colour-0",
      "colour-2",
      "colour-1",
    ]);
    // Slot numbers count unique labels; the index is the first segment
    // carrying each one.
    expect(picks).toEqual([
      [0, 0],
      [1, 1],
      [2, 3],
    ]);
  });

  it("shares a null pick too, instead of picking again", () => {
    let calls = 0;
    const out = mapByUniqueLabel(["a", "a", "a"], () => {
      calls += 1;
      return null;
    });
    expect(out).toEqual([null, null, null]);
    expect(calls).toBe(1);
  });

  it("returns nothing for no labels", () => {
    expect(mapByUniqueLabel([], () => 1)).toEqual([]);
  });
});
