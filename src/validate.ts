/**
 * Config validation: one rule per option, checked in the order below, so a
 * config with several mistakes always reports the same one first.
 *
 * A rule answers with the suffix of the message to show — `range` on
 * `segments` is `errors.segments_range` — so a new option is one line in
 * RULES plus its `errors.<option>_*` strings in the language files.
 */
import { DEFAULTS } from "./config";
import { localize } from "./localize/localize";
import type { SpinningWheelCardConfig } from "./types";

/** Why a value was rejected: the message suffix and its placeholders. */
type Problem = readonly [
  suffix: string,
  vars?: Record<string, string | number>,
];
type Rule = (value: unknown, segments: number) => Problem | null;

const text: Rule = (v) => (typeof v === "string" ? null : ["type"]);
const flag: Rule = (v) => (typeof v === "boolean" ? null : ["type"]);

const oneOf =
  (...allowed: string[]): Rule =>
  (v) =>
    allowed.includes(v as string) ? null : ["value"];

const integer =
  (min: number, max: number): Rule =>
  (v) =>
    typeof v === "number" && Number.isInteger(v) && v >= min && v <= max
      ? null
      : ["range"];

/** 1–10, or one of the pre-v1.2 presets. */
const friction: Rule = (v, segments) =>
  ["low", "medium", "high"].includes(v as string)
    ? null
    : integer(1, 10)(v, segments);

const entityId = (domain: string): RegExp =>
  new RegExp(`^${domain}\\.[a-z0-9_]+$`);

/** One entity of `domain`. "" is what a cleared picker saves: unset. */
const entity = (domain: string): Rule => {
  const id = entityId(domain);
  return (v) => {
    if (typeof v !== "string") return ["type"];
    return v === "" || id.test(v) ? null : ["invalid"];
  };
};

const entities = (domain: string): Rule => {
  const id = entityId(domain);
  return (v) => {
    if (!Array.isArray(v)) return ["type"];
    for (const e of v) {
      if (typeof e !== "string" || !id.test(e)) {
        return ["invalid", { value: String(e) }];
      }
    }
    return null;
  };
};

/** A list with at most one entry per segment. */
const list =
  (entryOk: (entry: unknown) => boolean, mayBeEmpty = false): Rule =>
  (v, segments) => {
    if (!Array.isArray(v) || !v.every(entryOk)) return ["type"];
    if (v.length === 0 && !mayBeEmpty) return ["empty"];
    if (v.length > segments) return ["length", { len: v.length, segments }];
    return null;
  };

const isLabel = (e: unknown): boolean => typeof e === "string";
const isWeight = (e: unknown): boolean =>
  typeof e === "number" && Number.isFinite(e) && e > 0;
/** `null` leaves that slot to the theme palette. */
const isColour = (e: unknown): boolean =>
  e === null || (typeof e === "string" && e.length > 0);

const SCRIPT_ID = entityId("script");

/** `script.<name>` shorthands, action objects, or `null` / "" for none. */
const actions: Rule = (v, segments) => {
  if (!Array.isArray(v)) return ["type"];
  if (v.length > segments) return ["length", { len: v.length, segments }];
  for (const a of v) {
    if (a === null || a === "") continue;
    if (typeof a === "string") {
      if (!SCRIPT_ID.test(a)) return ["string", { value: a }];
      continue;
    }
    if (
      typeof a !== "object" ||
      typeof (a as { action?: unknown }).action !== "string"
    ) {
      return ["type"];
    }
  }
  return null;
};

const RULES: ReadonlyArray<readonly [option: string, rule: Rule]> = [
  ["name", text],
  ["language", text],
  ["segments", integer(4, 24)],
  ["friction", friction],
  ["labels", list(isLabel, true)],
  ["weights", list(isWeight)],
  ["colors", list(isColour)],
  ["label_colors", list(isColour)],
  ["hub_text", text],
  ["sound", flag],
  ["text_orientation", oneOf("tangent", "radial")],
  ["theme", oneOf("default", "pastel", "pride", "neon")],
  ["hub_color", oneOf("theme", "black", "white")],
  ["show_status", flag],
  ["todo_entity", entity("todo")],
  ["actions", actions],
  ["disable_confirm_actions", flag],
  ["disable_boost", flag],
  ["half_circle", flag],
  ["selector_mode", flag],
  ["segment_borders", flag],
  ["pegs", flag],
  ["peg_density", integer(0, 4)],
  ["label_auto_fit", flag],
  ["label_font_scale", integer(70, 150)],
  ["label_radius_offset", integer(-20, 20)],
  ["label_flip", flag],
  ["wheel_context", flag],
  ["result_entity", entity("input_text")],
  ["light_sync_entities", entities("light")],
  ["tts_engine", entity("tts")],
  ["tts_announce_entities", entities("media_player")],
];

/** Throw a localised error for the first option that is set to something
 *  the card can't use. Unset options are fine — they take their default. */
export function validateConfig(
  config: SpinningWheelCardConfig,
  lang: string,
): void {
  if (!config || typeof config !== "object") {
    throw new Error(localize("errors.invalid_config", lang));
  }
  // Lists are measured against the segment count the card will draw.
  const segments =
    typeof config.segments === "number" ? config.segments : DEFAULTS.segments;
  for (const [option, rule] of RULES) {
    const value = config[option];
    if (value === undefined) continue;
    const problem = rule(value, segments);
    if (problem) {
      throw new Error(
        localize(`errors.${option}_${problem[0]}`, lang, problem[1]),
      );
    }
  }
}
