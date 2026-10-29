/**
 * @vitest-environment happy-dom
 *
 * The card fills its sections-view grid cell instead of painting over the
 * card below it -- and only there, so the add-card picker preview keeps its
 * own height.
 *
 * A sections view gives the card a fixed-height cell whenever rows is
 * numeric, and a stored grid_options (written the moment the user drags a
 * resize handle) overrides whatever getGridOptions() returns. Only the pair
 * of rules below makes the card take that height. The pair is gated on the
 * layout attribute HA sets, because the add-card picker sets none and an
 * ungated 100% stretches the preview to the tallest tile in its row.
 *
 * happy-dom does no layout, so the guard is on the CSS text.
 */
import { describe, expect, it } from "vite-plus/test";

import "./fakes";
import { SpinningWheelCard } from "../src/spinning-wheel-card";

const css = (SpinningWheelCard.styles as { cssText: string }).cssText;

/** The declarations of the first rule whose selector list starts a line with
 *  `selector`, up to its closing brace. Anchoring on the line keeps "ha-card"
 *  from matching the tail of `:host([layout="panel"]) ha-card`. */
const rule = (selector: string): string => {
  const start = css.indexOf(`\n    ${selector} {`);
  return start < 0 ? "" : css.slice(start, css.indexOf("}", start));
};

describe("the grid cell", () => {
  it("is a block on the host", () => {
    expect(rule(":host")).toMatch(/display:\s*block/);
  });

  it("takes the cell's height on the host in grid and panel layouts", () => {
    expect(rule(':host([layout="grid"]),\n    :host([layout="panel"])')).toMatch(/height:\s*100%/);
  });

  it("resolves ha-card against it there, and clips inside the card", () => {
    expect(rule(':host([layout="grid"]) ha-card,\n    :host([layout="panel"]) ha-card')).toMatch(
      /height:\s*100%/,
    );
    expect(rule("ha-card")).toMatch(/overflow:\s*hidden/);
  });

  it("never fills ungated, so the picker preview keeps its own height", () => {
    expect(rule(":host")).not.toMatch(/block-size|height:\s*100%/);
    expect(rule("ha-card")).not.toMatch(/block-size|height:\s*100%/);
  });

  it("reflects the layout HA sets, which the selectors read", () => {
    expect(SpinningWheelCard.getPropertyOptions("layout").reflect).toBe(true);
  });
});
