/**
 * What the card refuses, and what it says when it does.
 *
 * setConfig throws on a config it can't use, and Home Assistant shows the
 * message in the card's place — so the message is UI, and which mistake is
 * reported first is part of the contract. Pure node — no DOM.
 */
import { describe, expect, it } from "vitest";

import en from "../src/localize/languages/en.json";
import type { SpinningWheelCardConfig } from "../src/types";
import { validateConfig } from "../src/validate";

const TYPE = "custom:spinning-wheel-card";

/** The message `config` is rejected with, or null when it is accepted. */
const problem = (config: Record<string, unknown>, lang = "en"): string | null => {
  try {
    validateConfig({ type: TYPE, ...config } as SpinningWheelCardConfig, lang);
    return null;
  } catch (err) {
    return (err as Error).message;
  }
};

const nine = <T>(value: T): T[] => Array<T>(9).fill(value);

describe("validateConfig", () => {
  it("accepts an empty config and a fully set one", () => {
    expect(problem({})).toBeNull();
    expect(
      problem({
        name: "Wheel",
        language: "de",
        segments: 6,
        friction: 7,
        labels: ["a", "b"],
        weights: [1, 2.5],
        colors: ["#ff0000", null],
        label_colors: [null, "white"],
        hub_text: "",
        sound: false,
        text_orientation: "radial",
        theme: "neon",
        hub_color: "white",
        show_status: false,
        todo_entity: "todo.shopping_list",
        actions: ["script.a", null, "", { action: "none" }],
        pegs: true,
        peg_density: 4,
        label_font_scale: 150,
        label_radius_offset: -20,
        result_entity: "input_text.result",
        light_sync_entities: ["light.a"],
        tts_engine: "tts.piper",
        tts_announce_entities: ["media_player.kitchen"],
      }),
    ).toBeNull();
  });

  it("rejects something that isn't a config object", () => {
    for (const config of [null, undefined, 5, "wheel"]) {
      expect(() =>
        validateConfig(config as unknown as SpinningWheelCardConfig, "en"),
      ).toThrow(en.errors.invalid_config);
    }
  });

  it.each([
    ["name", 5, en.errors.name_type],
    ["language", 5, en.errors.language_type],
    ["hub_text", 5, en.errors.hub_text_type],
    ["sound", "yes", en.errors.sound_type],
    ["show_status", 1, en.errors.show_status_type],
    ["pegs", "on", en.errors.pegs_type],
    ["half_circle", null, en.errors.half_circle_type],
    ["wheel_context", "x", en.errors.wheel_context_type],
    ["text_orientation", "diagonal", en.errors.text_orientation_value],
    ["theme", "dark", en.errors.theme_value],
    ["hub_color", "red", en.errors.hub_color_value],
  ])("rejects %s: %j", (option, value, message) => {
    expect(problem({ [option]: value })).toBe(message);
  });

  it.each([
    ["segments", 4, 24, en.errors.segments_range],
    ["peg_density", 0, 4, en.errors.peg_density_range],
    ["label_font_scale", 70, 150, en.errors.label_font_scale_range],
    ["label_radius_offset", -20, 20, en.errors.label_radius_offset_range],
  ])("keeps %s a whole number from %i to %i", (option, min, max, message) => {
    expect(problem({ [option]: min })).toBeNull();
    expect(problem({ [option]: max })).toBeNull();
    for (const value of [min - 1, max + 1, min + 0.5, String(min), NaN]) {
      expect(problem({ [option]: value }), String(value)).toBe(message);
    }
  });

  it("takes friction as 1–10 or one of the pre-v1.2 presets", () => {
    for (const value of [1, 10, "low", "medium", "high"]) {
      expect(problem({ friction: value }), String(value)).toBeNull();
    }
    for (const value of [0, 11, 2.5, "heavy", true]) {
      expect(problem({ friction: value }), String(value)).toBe(
        en.errors.friction_range,
      );
    }
  });

  it("measures every list against the segment count", () => {
    expect(problem({ labels: nine("x") })).toBe(
      "labels length (9) must not exceed segments (8)",
    );
    expect(problem({ segments: 9, labels: nine("x") })).toBeNull();
    expect(problem({ segments: 4, weights: [1, 1, 1, 1, 1] })).toBe(
      "weights length (5) must not exceed segments (4)",
    );
    expect(problem({ colors: nine("red") })).toContain("colors length (9)");
    expect(problem({ label_colors: nine("red") })).toContain("length (9)");
    expect(problem({ actions: nine(null) })).toContain("actions length (9)");
  });

  it("checks what a list holds", () => {
    expect(problem({ labels: "a" })).toBe(en.errors.labels_type);
    expect(problem({ labels: ["a", 2] })).toBe(en.errors.labels_type);
    expect(problem({ weights: [1, 0] })).toBe(en.errors.weights_type);
    expect(problem({ weights: [Infinity] })).toBe(en.errors.weights_type);
    expect(problem({ colors: ["red", ""] })).toBe(en.errors.colors_type);
    expect(problem({ label_colors: [5] })).toBe(en.errors.label_colors_type);
  });

  it("lets labels be empty, but not weights or colours", () => {
    expect(problem({ labels: [] })).toBeNull();
    expect(problem({ weights: [] })).toBe(en.errors.weights_empty);
    expect(problem({ colors: [] })).toBe(en.errors.colors_empty);
    expect(problem({ label_colors: [] })).toBe(en.errors.label_colors_empty);
  });

  it("takes an entity of the right domain, or a cleared picker's \"\"", () => {
    expect(problem({ todo_entity: "" })).toBeNull();
    expect(problem({ todo_entity: 5 })).toBe(en.errors.todo_entity_type);
    expect(problem({ todo_entity: "light.x" })).toBe(
      en.errors.todo_entity_invalid,
    );
    expect(problem({ todo_entity: "todo.Shopping" })).toBe(
      en.errors.todo_entity_invalid,
    );
    expect(problem({ result_entity: "sensor.x" })).toBe(
      en.errors.result_entity_invalid,
    );
    expect(problem({ tts_engine: "media_player.x" })).toBe(
      en.errors.tts_engine_invalid,
    );
    expect(problem({ tts_engine: 5 })).toBe(en.errors.tts_engine_type);
  });

  it("names the entry that is wrong in an entity list", () => {
    expect(problem({ light_sync_entities: "light.a" })).toBe(
      en.errors.light_sync_entities_type,
    );
    expect(problem({ light_sync_entities: ["light.a", "switch.b"] })).toBe(
      "light_sync_entities entry must be a light.* entity_id (got: switch.b)",
    );
    expect(problem({ tts_announce_entities: [null] })).toContain("(got: null)");
    expect(problem({ light_sync_entities: [] })).toBeNull();
  });

  it("takes actions as scripts, action objects or blanks", () => {
    expect(problem({ actions: "script.a" })).toBe(en.errors.actions_type);
    expect(problem({ actions: ["light.toggle"] })).toBe(
      "actions string entries must be a script.* entity_id (got: light.toggle)",
    );
    expect(problem({ actions: [5] })).toBe(en.errors.actions_type);
    expect(problem({ actions: [{ service: "x" }] })).toBe(
      en.errors.actions_type,
    );
  });

  it("reports the first mistake, in the order the options are checked", () => {
    expect(problem({ pegs: "x", segments: 99, name: 5 })).toBe(
      en.errors.name_type,
    );
    expect(problem({ pegs: "x", segments: 99 })).toBe(en.errors.segments_range);
  });

  it("speaks the language it is given, English when it has no such one", () => {
    expect(problem({ segments: 1 }, "de")).not.toBe(en.errors.segments_range);
    expect(problem({ segments: 1 }, "de-AT")).toBe(problem({ segments: 1 }, "de"));
    expect(problem({ segments: 1 }, "xx")).toBe(en.errors.segments_range);
  });

  it("has a real message for every way an option can be wrong", () => {
    // A rule's answer is glued into the message key; a typo there would
    // surface as the raw key instead of a sentence.
    const wrong: Array<Record<string, unknown>> = [
      { name: 1 },
      { language: 1 },
      { segments: 1 },
      { friction: 0 },
      { labels: 1 },
      { labels: nine("x") },
      { weights: 1 },
      { weights: [] },
      { weights: nine(1) },
      { colors: 1 },
      { colors: [] },
      { colors: nine("red") },
      { label_colors: 1 },
      { label_colors: [] },
      { label_colors: nine("red") },
      { hub_text: 1 },
      { sound: 1 },
      { text_orientation: 1 },
      { theme: 1 },
      { hub_color: 1 },
      { show_status: 1 },
      { todo_entity: 1 },
      { todo_entity: "x" },
      { actions: 1 },
      { actions: nine(null) },
      { actions: ["x"] },
      { disable_confirm_actions: 1 },
      { disable_boost: 1 },
      { half_circle: 1 },
      { selector_mode: 1 },
      { segment_borders: 1 },
      { pegs: 1 },
      { peg_density: 9 },
      { label_auto_fit: 1 },
      { label_font_scale: 1 },
      { label_radius_offset: 99 },
      { label_flip: 1 },
      { wheel_context: 1 },
      { result_entity: 1 },
      { result_entity: "x" },
      { light_sync_entities: 1 },
      { light_sync_entities: ["x"] },
      { tts_engine: 1 },
      { tts_engine: "x" },
      { tts_announce_entities: 1 },
      { tts_announce_entities: ["x"] },
    ];
    const messages = wrong.map((config) => problem(config));
    for (const message of messages) {
      expect(message).not.toBeNull();
      expect(message).not.toMatch(/^errors\./);
    }
    // … and every string in the language file is one a rule can produce.
    const reachable = new Set(messages.map((m) => m!.replace(/\d+/g, "#")));
    const unused = Object.entries(en.errors).filter(
      ([key, text]) =>
        key !== "invalid_config" &&
        !reachable.has(
          text
            .replace("{len}", "#")
            .replace("{segments}", "#")
            .replace("{value}", "x")
            .replace(/\d+/g, "#"),
        ),
    );
    expect(unused).toEqual([]);
  });
});
