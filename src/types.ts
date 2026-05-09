// Local mirror of HA / Lovelace types this card uses.

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

/** Minimal HA shape — only the fields this card touches. */
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
  /** Standard HA hass-shape — `home-assistant-js-websocket` exposes
   *  `callService(domain, service, serviceData?, target?)`. Optional
   *  here because this interface is intentionally a minimal subset; the
   *  per-segment-action dispatcher guards the call. */
  callService?<T = unknown>(
    domain: string,
    service: string,
    serviceData?: Record<string, unknown>,
    target?: HassServiceTarget,
  ): Promise<T>;
}

/** Standard HA service-call target. Mirrors `home-assistant-js-websocket`'s
 *  `HassServiceTarget`. Any one (or several) of the id fields can be set;
 *  HA resolves device/area/floor/label IDs server-side. */
export interface HassServiceTarget {
  entity_id?: string | ReadonlyArray<string>;
  device_id?: string | ReadonlyArray<string>;
  area_id?: string | ReadonlyArray<string>;
  floor_id?: string | ReadonlyArray<string>;
  label_id?: string | ReadonlyArray<string>;
}

/** Confirmation envelope per HA's standard ActionConfig. `true` prompts
 *  with a generic message; an object lets the user supply their own
 *  `text`. `false` opts a single action out of confirmation when the
 *  card-level default is on. */
export type ConfirmationConfig =
  | boolean
  | { text?: string; exemptions?: ReadonlyArray<{ user: string }> };

/** Lovelace ActionConfig — discriminated union mirroring HA's standard
 *  tap_action / hold_action / double_tap_action shape. We re-declare it
 *  locally instead of pulling in `custom-card-helpers` (the portfolio
 *  dropped that runtime dep for supply-chain hygiene). 2024.8+ HA prefers
 *  `perform-action` / `perform_action` over `call-service` / `service`;
 *  both are accepted at runtime so existing YAML keeps working. */
export type ActionConfig =
  | { action: "none" }
  | { action: "toggle"; entity?: string; confirmation?: ConfirmationConfig }
  | { action: "more-info"; entity?: string; confirmation?: ConfirmationConfig }
  | {
      action: "call-service";
      service: string;
      service_data?: Record<string, unknown>;
      data?: Record<string, unknown>;
      target?: HassServiceTarget;
      confirmation?: ConfirmationConfig;
    }
  | {
      action: "perform-action";
      perform_action: string;
      data?: Record<string, unknown>;
      target?: HassServiceTarget;
      confirmation?: ConfirmationConfig;
    }
  | {
      action: "navigate";
      navigation_path: string;
      navigation_replace?: boolean;
      confirmation?: ConfirmationConfig;
    }
  | { action: "url"; url_path: string; confirmation?: ConfirmationConfig }
  | {
      action: "assist";
      pipeline_id?: string;
      start_listening?: boolean;
      confirmation?: ConfirmationConfig;
    }
  | { action: "fire-dom-event"; [key: string]: unknown };

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

/** Single item in a HA `todo.*` entity's list. The fields below are the
 *  ones the wheel touches; the WS reply carries more (uid, due, etc.)
 *  that we deliberately ignore. */
export interface TodoItem {
  /** Free-text label the user typed in HA. Becomes a wheel segment label. */
  summary: string;
  /** "needs_action" = open / "completed" = done. Wheel only renders open. */
  status?: "needs_action" | "completed";
  /** UID is opaque-string in HA's todo schema — we don't read it but
   *  declaring the field keeps strict-mode `noUncheckedIndexedAccess`
   *  happy when the WS reply is destructured. */
  uid?: string;
}

export interface SpinningWheelCardConfig extends LovelaceCardConfig {
  type: string;
  name?: string;
  /** Optional HA `todo.*` entity_id. When set, the wheel's segments are
   *  filled with the entity's *open* (needs_action) item summaries
   *  fetched via `todo/item/list`, and `segments` is auto-derived from
   *  the item count (clamped 4..24). The static `labels` array is
   *  ignored while a todo_entity is active — todo wins. Refetch fires
   *  whenever the entity's `state` (open-count) changes. */
  todo_entity?: string;
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
  /** Optional per-segment action fired when the segment wins. Each entry
   *  is one of:
   *    - a `script.<name>` entity_id (string shorthand → expanded to
   *      `{ action: "perform-action", perform_action: "script.<name>" }`
   *      at runtime — each script in HA is registered as its own service);
   *    - a full Lovelace `ActionConfig` (`perform-action` / `call-service` /
   *      `navigate` / `url` / `more-info` / `toggle` / `assist` /
   *      `fire-dom-event`);
   *    - `null` to fire nothing for that segment.
   *  Same length / cycling rule as `labels`: 1..segments, cycled around
   *  with **same-label-same-action mapping** (segments sharing a label
   *  always fire the same action, mirroring the `colors` rule). */
  actions?: ReadonlyArray<string | ActionConfig | null>;
  /** Skip the "Run action for X?" confirmation prompt that fires by
   *  default before a winning segment's action runs. Default `false`
   *  (= confirm, safer). Per-action `confirmation: false` opts a single
   *  action out without disabling confirmation globally. */
  disable_confirm_actions?: boolean;
  /** Disable the click-to-boost behaviour: when `true`, clicks (or
   *  Space/Enter keystrokes) while the wheel is spinning are ignored
   *  instead of adding a fresh impulse. Useful for kid-friendly
   *  dashboards where rapid clicking would otherwise keep the wheel
   *  in motion indefinitely. Default `false` (boost-on-click enabled,
   *  matches the original click-to-spin/click-to-boost UX). Drag-to-
   *  throw is unaffected. */
  disable_boost?: boolean;
}

export type TextOrientation = "tangent" | "radial";
