// Local mirror of the HA / Lovelace types this card actually uses.
// We only depend on a handful of fields, so pinning a local shape is
// cheaper than carrying a transitive npm dep that drifts behind
// HA-internal types.

/** Single entity in `hass.states`. The attributes bag is open-ended —
 *  the integration's coordinator emits the keys this card reads. Add
 *  the named keys your card pulls (`departures`, `slots`, …) below so
 *  call sites get autocomplete; everything else falls through the
 *  `Record<string, unknown>` mixin. */
export interface HassEntity {
  state: string;
  attributes: Record<string, unknown> & {
    friendly_name?: string;
    attribution?: string;
  };
  last_changed?: string;
  last_updated?: string;
  entity_id?: string;
}

/** Minimal HA shape — only the fields this card touches. `language` is
 *  the user-profile locale; `callWS` powers the card-version probe;
 *  `localize` is HA's own UI translation lookup (the editor reuses it
 *  for built-in field names so we don't carry duplicates); `themes.darkMode`
 *  drives adaptive-logo work. Anything beyond these lives untyped and is
 *  read with a cast at the call site. */
export interface HomeAssistant {
  states: Record<string, HassEntity>;
  /** Modern HA exposes the user's locale here. Older versions only had
   *  `language` at the top level — we read both with `??` fallback. */
  locale?: { language?: string } & Record<string, unknown>;
  language?: string;
  themes?: { darkMode?: boolean } & Record<string, unknown>;
  config?: { time_zone?: string } & Record<string, unknown>;
  localize?: (key: string, ...args: unknown[]) => string;
  callWS?<T = unknown>(msg: { type: string; [key: string]: unknown }): Promise<T>;
}

/** Marker every card config extends. */
export interface LovelaceCardConfig {
  type: string;
  [key: string]: unknown;
}

/** Custom-card editor contract — Lovelace expects an HTMLElement that
 *  accepts `setConfig(config)` and reads `hass`. */
export interface LovelaceCardEditor extends HTMLElement {
  hass?: HomeAssistant;
  setConfig(config: LovelaceCardConfig): void;
}

/** `LovelaceCard` is only referenced as the `hui-error-card` tag-map
 *  entry below, so an HTMLElement alias suffices. */
export type LovelaceCard = HTMLElement;

/** `bubbles: true` + `composed: true` are required so the event crosses
 *  the editor's shadow boundary and reaches the dashboard's
 *  card-editor listener. */
export function fireEvent<T>(
  node: HTMLElement,
  type: string,
  detail: T,
): void {
  node.dispatchEvent(
    new CustomEvent(type, { detail, bubbles: true, composed: true }),
  );
}

// Register your editor element + the built-in error card with the global
// HTMLElementTagNameMap so TypeScript autocompletes them in templates.
declare global {
  interface HTMLElementTagNameMap {
    "spinning-wheel-card-editor": LovelaceCardEditor;
    "hui-error-card": LovelaceCard;
    "ha-form": HaFormElement;
    "ha-selector": HaSelectorElement;
  }
}

interface HaFormElement extends HTMLElement {
  hass?: HomeAssistant;
  data?: Record<string, unknown>;
  schema?: ReadonlyArray<HaFormSchema>;
  computeLabel?: (field: { name: string }) => string;
  computeHelper?: (field: { name: string }) => string | undefined;
}

interface HaSelectorElement extends HTMLElement {
  hass?: HomeAssistant;
  selector?: HASelector;
  value?: unknown;
  label?: string;
  required?: boolean;
}

// HASelector union — covers the most common selector keys. Widen as you
// reach for new ones; the canonical, exhaustive list is HA frontend
// src/data/selector.ts. Keys are: entity, area, device, boolean, text,
// number, select, color_rgb, color_temp, icon, time, date, datetime,
// duration, theme, object, constant.
export type HASelector =
  | { entity: { domain?: string | string[]; integration?: string; multiple?: boolean } }
  | { area: { multiple?: boolean } }
  | { device: { integration?: string; multiple?: boolean } }
  | { boolean: Record<string, never> }
  | { text: { type?: "text" | "password" | "url" | "email"; multiline?: boolean } }
  | {
      number: {
        min?: number;
        max?: number;
        step?: number;
        mode?: "box" | "slider";
        unit_of_measurement?: string;
      };
    }
  | {
      select: {
        mode?: "dropdown" | "list";
        multiple?: boolean;
        custom_value?: boolean;
        options: ReadonlyArray<{ value: string; label: string }>;
      };
    }
  | { color_rgb: Record<string, never> }
  | { color_temp: { min_mireds?: number; max_mireds?: number } }
  | { icon: Record<string, never> }
  | { time: Record<string, never> }
  | { date: Record<string, never> }
  | { datetime: Record<string, never> }
  | { object: Record<string, never> }
  | { duration: Record<string, never> }
  | { theme: { include_default?: boolean } }
  | { constant: { value: string | number | boolean; label?: string } };

export interface HaFormBaseSchema {
  name: string;
  required?: boolean;
}
export interface HaFormSelectorSchema extends HaFormBaseSchema {
  selector: HASelector;
}
export interface HaFormGridSchema {
  type: "grid";
  name: "";
  schema: ReadonlyArray<HaFormSchema>;
}
export interface HaFormExpandableSchema {
  type: "expandable";
  name: string;
  title?: string;
  /**
   * REQUIRED for flat config shapes (the common case). Without it,
   * ha-form's value-changed reducer nests the inner fields' values
   * under `data[name]` and the card silently misses them. See the
   * `<ha-form>` `expandable` footgun gotcha in SKILL.md.
   */
  flatten?: boolean;
  schema: ReadonlyArray<HaFormSchema>;
}
export type HaFormSchema =
  | HaFormSelectorSchema
  | HaFormGridSchema
  | HaFormExpandableSchema;

export type Friction = "low" | "medium" | "high";

/** Built-in colour-theme presets. Used as the fallback palette when the
 *  user hasn't supplied a `colors` array. Custom `colors` always wins. */
export type Theme = "default" | "pastel" | "pride" | "neon";

/** Hub + indicator colour mode.
 *  - `theme`: use the active HA `--primary-color` (default).
 *  - `black`: solid black hub + indicator with white hub text.
 *  - `white`: solid white hub + indicator with black hub text. */
export type HubColor = "theme" | "black" | "white";

export interface SpinningWheelCardConfig extends LovelaceCardConfig {
  type: string;
  name?: string;
  /** Override the auto-detected display language for this card (any
   *  ISO-639-1 code). When unset, the card follows
   *  hass.locale.language → hass.language → navigator.language → "en".
   *  Unsupported codes fall through to English just like the auto-detect
   *  path. */
  language?: string;
  /** How many segments the wheel is divided into (4–24). Default 8. */
  segments?: number;
  /** Deceleration preset. Default "medium". */
  friction?: Friction;
  /** Optional per-segment labels. Length 1..segments — when shorter than
   *  `segments`, the labels are cycled around the wheel (e.g. ["A","B"]
   *  on 8 segments → A B A B A B A B). Defaults to "1".."N" when omitted. */
  labels?: ReadonlyArray<string>;
  /** Optional per-segment relative weights (segment widths). Same cycling
   *  rule as labels: [3, 1] on 4 segments → big, small, big, small.
   *  Values are normalised — only their ratio matters. Default: all equal. */
  weights?: ReadonlyArray<number>;
  /** Built-in colour-theme preset. Picks the fallback palette used when
   *  `colors` is not supplied. `colors` (when set) always wins over
   *  `theme`. Default: "default" (built-in 8-colour rainbow). */
  theme?: Theme;
  /** Optional palette. Any CSS colour string (hex / rgb / hsl / named).
   *  Colours are mapped to UNIQUE LABELS in order of first appearance, so
   *  segments with the same label always share a colour. Length 1..segments.
   *  When set, overrides `theme`. Default: the active `theme`'s palette,
   *  or the built-in 8-colour rainbow when `theme` is "default" / unset. */
  colors?: ReadonlyArray<string>;
  /** Optional per-segment label text colour. Same cycling rule as
   *  `colors` — mapped to UNIQUE LABELS in order of first appearance, so
   *  segments sharing a label always share a label colour. Length
   *  1..segments. Default: dark grey for every segment. */
  label_colors?: ReadonlyArray<string>;
  /** Text rendered on the centre hub. Default "SPIN". Empty string to hide. */
  hub_text?: string;
  /** Centre-hub fill + pointer-indicator fill. `theme` (default) uses
   *  HA's `--primary-color`; `black` and `white` use solid colours
   *  with auto-contrast hub text. */
  hub_color?: HubColor;
  /** Play a peg-click sound on each segment crossing (volume scales with
   *  wheel speed). Default true. */
  sound?: boolean;
  /** Show the status line beneath the wheel ("Spinning…" / "Result: X" /
   *  the click-to-spin idle hint). Default true. Set false to hide it
   *  for a more minimal look. */
  show_status?: boolean;
  /** "tangent" (default) — labels wrap around the rim, perpendicular to
   *  the spoke. "radial" — labels rotated 90° CW; reads along the spoke
   *  from rim toward centre. */
  text_orientation?: TextOrientation;
}

export type TextOrientation = "tangent" | "radial";
