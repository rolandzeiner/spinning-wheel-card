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
  /** Modern HA exposes the user's locale here; older versions only had
   *  top-level `language`. Read both with `??` fallback. */
  locale?: { language?: string } & Record<string, unknown>;
  language?: string;
  themes?: { darkMode?: boolean } & Record<string, unknown>;
  config?: { time_zone?: string } & Record<string, unknown>;
  localize?: (key: string, ...args: unknown[]) => string;
  callWS?<T = unknown>(msg: { type: string; [key: string]: unknown }): Promise<T>;
  callService?<T = unknown>(
    domain: string,
    service: string,
    serviceData?: Record<string, unknown>,
    target?: HassServiceTarget,
  ): Promise<T>;
  /** Active HA user. Only `is_admin` is read — admin-only WS calls
   *  (e.g. `input_text/create`) must be gated client-side so non-admins
   *  don't see a button that's going to fail. */
  user?: { is_admin?: boolean; is_owner?: boolean; name?: string };
}

/** Mirrors `home-assistant-js-websocket`'s `HassServiceTarget`. */
export interface HassServiceTarget {
  entity_id?: string | ReadonlyArray<string>;
  device_id?: string | ReadonlyArray<string>;
  area_id?: string | ReadonlyArray<string>;
  floor_id?: string | ReadonlyArray<string>;
  label_id?: string | ReadonlyArray<string>;
}

/** Confirmation envelope per HA's standard ActionConfig. `true` prompts
 *  with a generic message; an object supplies custom `text`. `false`
 *  opts a single action out when the card-level default is on. */
export type ConfirmationConfig =
  | boolean
  | { text?: string; exemptions?: ReadonlyArray<{ user: string }> };

/** Lovelace ActionConfig — re-declared locally (avoids the
 *  `custom-card-helpers` runtime dep). 2024.8+ HA prefers
 *  `perform-action` / `perform_action`; both keys accepted at runtime. */
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

// Subset of HA selector keys; canonical list lives in HA frontend
// src/data/selector.ts. Widen as needed.
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
  /** REQUIRED for flat config shapes (the common case). Without it,
   *  ha-form nests inner field values under `data[name]` and the card
   *  silently misses them — the `<ha-form>` expandable footgun. */
  flatten?: boolean;
  schema: ReadonlyArray<HaFormSchema>;
}
export type HaFormSchema =
  | HaFormSelectorSchema
  | HaFormGridSchema
  | HaFormExpandableSchema;

/** Pre-v1.2 string presets — still accepted in saved YAML, silently
 *  coerced to the new 1–10 integer scale (low → 3, medium → 5,
 *  high → 7). Kept exported for the migration helper. */
export type FrictionPreset = "low" | "medium" | "high";

/** v1.2+ wheel-dampening shape: integer 1–10. Drives BOTH the
 *  continuous per-frame velocity decay AND the per-peg brake bump
 *  when `pegs: true`. 1 = long lazy spin, 5 = classic (old "medium"),
 *  10 = stops quickly. Pre-v1.2 string presets are still accepted. */
export type Friction = number | FrictionPreset;

/** Built-in palette presets. Custom `colors` always wins over `theme`. */
export type Theme = "default" | "pastel" | "pride" | "neon";

/** Hub + indicator fill mode. `theme` uses HA's `--primary-color`;
 *  `black` / `white` are solid with auto-contrast hub text. */
export type HubColor = "theme" | "black" | "white";

/** Subset of HA `todo.*` item shape — only fields the wheel touches. */
export interface TodoItem {
  summary: string;
  status?: "needs_action" | "completed";
  uid?: string;
}

export interface SpinningWheelCardConfig extends LovelaceCardConfig {
  type: string;
  name?: string;
  /** HA `todo.*` entity_id. When set, segments are filled with open
   *  (needs_action) item summaries from `todo/item/list`; `segments` is
   *  auto-derived (clamped 4..24); the static `labels` array is ignored.
   *  Refetch fires when the entity's open-count changes. */
  todo_entity?: string;
  /** Per-card override for the display language (ISO-639-1). Unset =
   *  follow `hass.locale.language` → `hass.language` → `navigator.language`
   *  → "en". Unsupported codes fall through to English. */
  language?: string;
  /** Segment count (4–24). Default 8. */
  segments?: number;
  /** Deceleration preset. Default "medium". */
  friction?: Friction;
  /** Per-segment labels (1..segments). Shorter arrays cycle around the
   *  wheel. Defaults to "1".."N". */
  labels?: ReadonlyArray<string>;
  /** Per-segment relative weights (1..segments). Cycles like `labels`;
   *  values normalised — only ratios matter. Default: all equal. */
  weights?: ReadonlyArray<number>;
  /** Fallback palette preset, used when `colors` is unset. */
  theme?: Theme;
  /** Per-unique-label fill colours (any CSS colour string). Mapped to
   *  UNIQUE LABELS in order of first appearance, so segments sharing a
   *  label always share a colour. Length 1..segments. `null` entries
   *  (or empty strings in CSV) fall through to the active `theme`
   *  palette at that position — set explicit colours where you care
   *  and leave the rest themed so a `theme:` change still updates them. */
  colors?: ReadonlyArray<string | null>;
  /** Per-unique-label text colours. Same `null`-falls-through rule
   *  as `colors`. Default: dark grey for every label. */
  label_colors?: ReadonlyArray<string | null>;
  /** Centre hub text. Empty string hides it. */
  hub_text?: string;
  /** Centre-hub + pointer fill mode. */
  hub_color?: HubColor;
  /** Play a peg-click sound on each segment crossing. Default true. */
  sound?: boolean;
  /** Show the status line beneath the wheel. Default true. */
  show_status?: boolean;
  /** Label orientation. `tangent` wraps along the rim; `radial` reads
   *  along the spoke from rim toward centre. */
  text_orientation?: TextOrientation;
  /** When true, BOTH the static-labels path and the todo path run the
   *  measure-and-shrink loop down to `minPx = 7` so long labels fit
   *  their slice. When false, the static path uses today's fixed font
   *  + char-count truncation; todo mode still auto-fits (arbitrary
   *  summaries can't sensibly char-truncate). Default false — existing
   *  wheels render unchanged. */
  label_auto_fit?: boolean;
  /** Scale of the base label font in percent (70..150, integer).
   *  Default 100 (no change). Acts as the *starting / max* font size:
   *  with `label_auto_fit: true` the measure-shrink loop shrinks from
   *  here down to the minimum. Also scales the MDI icon glyph
   *  (`iconPx = labelFontPx * 1.5`) so icons stay proportional. */
  label_font_scale?: number;
  /** Radial position offset for labels in percent of wheel radius
   *  (-20..+20, integer). Default 0. Added to the per-mode base
   *  fraction (0.66 for most, 0.55 for todo+radial). Clamped at draw
   *  time so the label never paints inside the hub or off the disc. */
  label_radius_offset?: number;
  /** Per-segment action fired when the segment wins. Entries are either
   *  a `script.<name>` shorthand (expanded to `perform-action` at
   *  runtime), a full Lovelace `ActionConfig`, or `null`. Same cycling +
   *  same-label-same-action mapping rule as `colors`. */
  actions?: ReadonlyArray<string | ActionConfig | null>;
  /** Skip the "Run action for X?" prompt that fires before a winning
   *  segment's action runs. Per-action `confirmation: false` opts a
   *  single action out without disabling globally. Default false. */
  disable_confirm_actions?: boolean;
  /** Ignore clicks / Space / Enter while the wheel is spinning instead
   *  of adding a fresh impulse. Useful for kid-friendly dashboards.
   *  Drag-to-throw is unaffected. Default false. */
  disable_boost?: boolean;
  /** `input_text.*` entity_id to write the winning label into after
   *  every spin. The editor's Create button can auto-provision a helper
   *  (admin only — `input_text/create` is admin-gated upstream). */
  result_entity?: string;
  /** Render only the upper half of the disc (pointer top, hub on the
   *  cut line). Physics are unchanged; only the painted geometry
   *  differs. Default false. */
  half_circle?: boolean;
  /** Manual picker mode — disables click-to-spin and the momentum loop;
   *  hides the hub text (the centre prompt no longer matches the drag-
   *  to-pick gesture). Drag rotates 1:1; on release the segment under
   *  the indicator snaps to centre and its action fires. Space / Enter
   *  re-fires the current selection. Default false. */
  selector_mode?: boolean;
  /** Show a thin white separator line between adjacent segments.
   *  Default true. Set false for a flatter look without the rib. */
  segment_borders?: boolean;
  /** Render small pegs at every segment boundary (rotating with the
   *  wheel) AND apply a tiny static velocity decrement on each peg
   *  crossing — the "real prize wheel" feel. The peg-click sound is
   *  controlled separately via `sound`. Default false. */
  pegs?: boolean;
  /** Number of EXTRA pegs to drop inside each segment, on top of the
   *  always-present boundary peg. 0 = boundary pegs only (N pegs);
   *  1 = boundary + 1 mid (2N pegs, default); 4 = boundary + 4 mids
   *  (5N pegs). Each peg fires its own click + brake bump. Ignored
   *  when `pegs: false`. Default 1. */
  peg_density?: number;
  /** When true, every fired action (perform-action / call-service)
   *  gets the winning segment's data merged into its `data` payload:
   *  `wheel_index`, `wheel_label`, `wheel_color`, `wheel_color_rgb`,
   *  `wheel_label_color`, `wheel_label_color_rgb`. A single generic
   *  script reading those fields can then handle every segment.
   *  User-supplied `data` keys override the auto-injected ones.
   *  Default false. */
  wheel_context?: boolean;
}

export type TextOrientation = "tangent" | "radial";
