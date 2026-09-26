/**
 * The editor shows the card's real defaults and saves only what changed.
 *
 * ha-form draws a missing boolean as off and a missing dropdown as blank,
 * so an editor fed the raw config lies about every default-on option. The
 * portfolio shipped that five times (ha-lovelace-card skill, gotcha "Editor
 * shows default-on toggles off"), each time in an editor that passed `_config`
 * straight to ha-form. These tests pin the fix in config.ts: the display
 * side fills every default in, the save side takes them back out.
 *
 * Pure node — no DOM. Needs vitest and a "test": "vitest run" script.
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULTS,
  normaliseConfig,
  textOrientationDefault,
  tidyConfig,
} from "../src/config";

const TYPE = "custom:spinning-wheel-card";

describe("editor defaults", () => {
  it("shows every default, so a default-on toggle is drawn on", () => {
    const shown = normaliseConfig({ type: TYPE }) as Record<string, unknown>;
    for (const [key, value] of Object.entries(DEFAULTS)) {
      expect(shown[key], key).toBe(value);
    }
  });

  it("keeps what the user set over the defaults", () => {
    const flipped = Object.fromEntries(
      Object.entries(DEFAULTS)
        .filter(([, value]) => typeof value === "boolean")
        .map(([key, value]) => [key, !value]),
    );
    expect(normaliseConfig({ type: TYPE, ...flipped })).toMatchObject(flipped);
  });

  it("treats cleared values as unset rather than blanking the default", () => {
    const cleared = Object.fromEntries(Object.keys(DEFAULTS).map((key) => [key, ""]));
    expect(normaliseConfig({ type: TYPE, ...cleared })).toMatchObject(DEFAULTS);
  });

  it("saves only what differs from the defaults, with type first", () => {
    const [key, value] = Object.entries(DEFAULTS).find(([, v]) => typeof v === "boolean")!;
    const saved = tidyConfig({ ...normaliseConfig({ type: TYPE }), [key]: !value });
    expect(saved).toEqual({ type: TYPE, [key]: !value });
    expect(Object.keys(saved)[0]).toBe("type");
  });

  it("round-trips an untouched config unchanged", () => {
    const config = { type: TYPE, labels: ["Pizza", "Sushi"] };
    expect(tidyConfig(normaliseConfig(config))).toEqual(config);
  });

  it("keeps an empty hub_text, which means no hub label", () => {
    // Unset hub_text shows the localised default; "" is the user asking
    // for none. Treating "" as cleared would bring the default back.
    const config = { type: TYPE, hub_text: "" };
    expect(normaliseConfig(config).hub_text).toBe("");
    expect(tidyConfig(normaliseConfig(config))).toEqual(config);
  });

  it("leaves text_orientation out of DEFAULTS, because todo mode flips it", () => {
    // Pinning "tangent" by normalising would stop a todo wheel going radial.
    expect("text_orientation" in DEFAULTS).toBe(false);
    expect(normaliseConfig({ type: TYPE }).text_orientation).toBeUndefined();
    expect(textOrientationDefault(false)).toBe("tangent");
    expect(textOrientationDefault(true)).toBe("radial");
  });
});
