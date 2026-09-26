/**
 * One table of defaults, shared by the card and its editor.
 *
 * ha-form knows nothing about a card's defaults. Given a config without a
 * key, it draws a boolean as OFF, a dropdown as blank and a slider at its
 * minimum, so the editor has to be shown them. This card used to keep two
 * copies: the editor's own prefill table, and the card's inline fallbacks
 * (`?? 8`, `?? true`, `=== true`, `=== false`) spread across the renderer.
 * Nothing kept them equal.
 *
 * The rule: every optional field's default lives in DEFAULTS and nowhere
 * else. The card stores normaliseConfig(config) and reads plain values. The
 * editor shows normaliseConfig(config) and saves tidyConfig(next).
 * Verification gate (-a: the card source holds a literal NUL sentinel,
 * and without it rg stops reading there):
 *   rg -an 'config\.\w+ (!== false|\?\? (true|false|-?[0-9]))' src/
 * should find nothing.
 *
 * Not in the table, because their defaults depend on something only known
 * at run time: `name` and `hub_text` (localised), `language` (HA's),
 * `text_orientation` (see textOrientationDefault below). Unset list and
 * entity fields — `labels`, `weights`, `colors`, `actions`, `todo_entity`,
 * `result_entity`, the TTS and light-sync fields — already mean "off".
 */
import type { SpinningWheelCardConfig, TextOrientation } from "./types";

export const DEFAULTS = {
  segments: 8,
  friction: 5,
  label_auto_fit: false,
  label_font_scale: 100,
  label_radius_offset: 0,
  label_flip: false,
  sound: true,
  theme: "default",
  hub_color: "theme",
  show_status: true,
  disable_confirm_actions: false,
  disable_boost: false,
  half_circle: false,
  selector_mode: false,
  segment_borders: true,
  pegs: false,
  peg_density: 1,
  wheel_context: false,
} as const satisfies Partial<SpinningWheelCardConfig>;

/** The config as the card reads it: every DEFAULTS key is present. */
export type NormalisedConfig = SpinningWheelCardConfig &
  Required<Pick<SpinningWheelCardConfig, keyof typeof DEFAULTS>>;

/** Long todo summaries read better along the spoke than wrapped on the
 *  rim, so a todo-filled wheel defaults to radial. A dynamic default can't
 *  sit in DEFAULTS: normalising would pin "tangent" and todo mode would
 *  never see radial. The editor only offers the field outside todo mode. */
export const textOrientationDefault = (todoMode: boolean): TextOrientation =>
  todoMode ? "radial" : "tangent";

/** `hub_text: ""` is a real value — "no hub label" — unlike an unset
 *  hub_text, which shows the localised default. */
const EMPTY_IS_A_VALUE: ReadonlySet<string> = new Set(["hub_text"]);

/** "" is what a cleared text field or dropdown hands back. */
const isUnset = (key: string, value: unknown): boolean =>
  value === undefined ||
  value === null ||
  (value === "" && !EMPTY_IS_A_VALUE.has(key));

/** The config with every default filled in: what the card renders and what
 *  the editor shows. Unset values (undefined, null, "") fall back to the
 *  default instead of blanking it out. The user's keys keep their order and
 *  the defaults follow them, so a save doesn't reshuffle the YAML. */
export function normaliseConfig(
  config: SpinningWheelCardConfig,
): NormalisedConfig {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (!isUnset(key, value)) out[key] = value;
  }
  for (const [key, value] of Object.entries(DEFAULTS)) {
    if (!(key in out)) out[key] = value;
  }
  return out as NormalisedConfig;
}

/** The config as the editor saves it: only what differs from DEFAULTS,
 *  cleared fields dropped, `type` first. A default saved into the config is
 *  pinned — a later change to DEFAULTS would never reach that card. */
export function tidyConfig(
  config: SpinningWheelCardConfig,
): SpinningWheelCardConfig {
  const defaults: Record<string, unknown> = DEFAULTS;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (isUnset(key, value)) continue;
    if (key in defaults && defaults[key] === value) continue;
    out[key] = value;
  }
  const { type, ...rest } = out;
  return { type, ...rest } as SpinningWheelCardConfig;
}
