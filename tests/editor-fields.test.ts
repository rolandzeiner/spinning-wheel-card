/**
 * The editor's field table, read without a DOM.
 *
 * The guard first: an option with a default and no field is an option the
 * visual editor can't reach. Then the list arithmetic the segment rows
 * rely on, which has to agree with how the card reads its lists — colours
 * and actions by label, weights by position, every list cycled.
 */
import { describe, expect, it } from "vite-plus/test";

import { DEFAULTS, normaliseConfig } from "../src/config";
import {
  ALL_FIELDS,
  expandCycle,
  type FieldContext,
  fieldHelper,
  groupSummary,
  remapLists,
  setSlot,
  setWeight,
  slotsOf,
} from "../src/editor-fields";
import { localize } from "../src/localize/localize";
import type { SpinningWheelCardConfig } from "../src/types";

const ctx = (config: Partial<SpinningWheelCardConfig> = {}, over: Partial<FieldContext> = {}) => {
  const full = { type: "custom:spinning-wheel-card", ...config };
  return {
    config: full,
    shown: normaliseConfig(full),
    source: "list",
    todo: Boolean(full.todo_entity),
    segmentCount: normaliseConfig(full).segments,
    labelCount: full.labels?.length ?? 0,
    hubTextOn: full.hub_text !== "",
    hubDefault: "SPIN",
    haLanguage: "English",
    lang: "en",
    t: (key: string, vars?: Record<string, string | number>) => localize(key, "en", vars),
    ...over,
  } satisfies FieldContext;
};

describe("the field table", () => {
  it("has a field for every option with a default", () => {
    const reached = new Set(ALL_FIELDS.map((field) => field.key ?? field.name));
    expect(Object.keys(DEFAULTS).filter((key) => !reached.has(key))).toEqual([]);
  });

  it("names every field once", () => {
    const names = ALL_FIELDS.map((field) => field.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("slots and cycles", () => {
  it("number the distinct labels in order of first appearance", () => {
    expect([...slotsOf(["a", "b", "a", "c"]).entries()]).toEqual([
      ["a", 0],
      ["b", 1],
      ["c", 2],
    ]);
  });

  it("write a cycled list out, and fill an empty one", () => {
    expect(expandCycle(["x", "y"], 5, null)).toEqual(["x", "y", "x", "y", "x"]);
    expect(expandCycle(undefined, 3, 1)).toEqual([1, 1, 1]);
  });

  it("set one slot, and drop the list once nothing is left in it", () => {
    expect(setSlot(undefined, 3, 1, "#fff")).toEqual([null, "#fff", null]);
    expect(setSlot(["#a"], 3, 2, "#b")).toEqual(["#a", "#a", "#b"]);
    expect(setSlot([null, "#fff", null], 3, 1, null)).toBeUndefined();
  });

  it("set one weight, and drop the list once every weight is 1", () => {
    expect(setWeight(undefined, 3, 0, 2)).toEqual([2, 1, 1]);
    expect(setWeight([2, 1, 1], 3, 0, 1)).toBeUndefined();
  });
});

describe("remapLists", () => {
  const config = {
    type: "custom:spinning-wheel-card",
    weights: [1, 2, 3],
    colors: ["#1", "#2", "#3"],
    actions: ["script.a", null, "script.c"],
  };

  it("moves every setting with its row", () => {
    expect(remapLists(config, ["a", "b", "c"], ["c", "a", "b"], [2, 0, 1])).toEqual({
      labels: ["c", "a", "b"],
      weights: [3, 1, 2],
      colors: ["#3", "#1", "#2"],
      actions: ["script.c", "script.a", null],
    });
  });

  it("gives a new row nothing of its own", () => {
    expect(remapLists(config, ["a", "b", "c"], ["a", "b", "c", "d"], [0, 1, 2, -1])).toEqual({
      labels: ["a", "b", "c", "d"],
      weights: [1, 2, 3, 1],
      colors: ["#1", "#2", "#3", null],
      actions: ["script.a", null, "script.c", null],
    });
  });

  it("leaves unset lists unset and drops the labels with the last row", () => {
    expect(remapLists({ type: "x" }, ["a"], [], [])).toEqual({ labels: undefined });
  });

  it("keeps a setting through a rename that merges two labels", () => {
    // Renaming c to a: the two now share a's slot, so c's colour goes.
    expect(remapLists(config, ["a", "b", "c"], ["a", "b", "a"], [0, 1, 2])).toMatchObject({
      colors: ["#1", "#2"],
      weights: [1, 2, 3],
    });
  });
});

describe("helpers", () => {
  it("say how the labels fill the segments", () => {
    expect(fieldHelper("segments", ctx())).toBe("The segments are numbered 1 to 8.");
    expect(fieldHelper("segments", ctx({ labels: ["a"] }))).toBe(
      "Your label repeats across 8 segments.",
    );
    expect(fieldHelper("segments", ctx({ labels: ["a", "b"], segments: 6 }))).toBe(
      "Your 2 labels repeat across 6 segments.",
    );
    expect(fieldHelper("segments", ctx({ labels: ["a", "b", "c", "d"], segments: 4 }))).toBe(
      "Every segment has its own label.",
    );
  });

  it("count the pegs around the whole rim", () => {
    expect(fieldHelper("peg_count", ctx({ pegs: true, peg_density: 2 }))).toBe(
      "24 pegs around the rim.",
    );
  });

  it("follow the orientation under the reading-direction switch", () => {
    expect(fieldHelper("label_flip", ctx())).toBe(
      localize("editor.label_flip_helper_tangent", "en"),
    );
    expect(fieldHelper("label_flip", ctx({ text_orientation: "radial" }))).toBe(
      localize("editor.label_flip_helper_radial", "en"),
    );
  });

  it("are left out where a field has none", () => {
    expect(fieldHelper("mode", ctx())).toBeUndefined();
  });
});

describe("group summaries", () => {
  it("say what each group is set to", () => {
    const c = ctx({
      theme: "neon",
      half_circle: true,
      label_font_scale: 120,
      pegs: true,
      friction: 7,
      sound: false,
      result_entity: "input_text.x",
      light_sync_entities: ["light.a", "light.b"],
    });
    expect(groupSummary("look", c)).toBe("Neon · Half circle");
    expect(groupSummary("labels", c)).toBe("Around the rim · 120 %");
    expect(groupSummary("hub", c)).toBe("“SPIN” · Primary colour");
    expect(groupSummary("lines", c)).toBe("Dividers · 2 pegs per segment");
    expect(groupSummary("spin", c)).toBe("Spin · Friction 7");
    expect(groupSummary("sound", c)).toBe("Off");
    expect(groupSummary("after", c)).toBe("Asks first · Result helper · 2 lights");
  });

  it("say what is switched off", () => {
    const c = ctx({
      show_status: false,
      segment_borders: false,
      hub_text: "",
      selector_mode: true,
      disable_confirm_actions: true,
    });
    expect(groupSummary("look", c)).toBe("Default · Full circle · No status line");
    expect(groupSummary("lines", c)).toBe("No dividers · No pegs");
    expect(groupSummary("hub", c)).toBe("No text · Primary colour");
    expect(groupSummary("spin", c)).toBe("Pick");
    expect(groupSummary("sound", c)).toBe("Classic");
    expect(groupSummary("sound", ctx({ click_sound: "wood" }))).toBe("Wood block");
    expect(groupSummary("after", c)).toBe("No confirmation");
  });

  it("show the to-do list's own rules for the labels", () => {
    expect(groupSummary("labels", ctx({ todo_entity: "todo.x" }))).toBe(
      "Along the spokes · 100 % · Auto size",
    );
  });
});
