// Spinning Wheel Card — Lovelace custom card.

import { LitElement, html, css, nothing } from "lit";
import type { TemplateResult, PropertyValues, CSSResultGroup } from "lit";
import { customElement, property, state } from "lit/decorators.js";

import type {
  ActionConfig,
  ConfirmationConfig,
  Friction,
  HomeAssistant,
  HubColor,
  LovelaceCardEditor,
  SpinningWheelCardConfig,
  TextOrientation,
  TodoItem,
} from "./types";
import { localize, resolveLang } from "./localize/localize";
import { DEFAULT_LABEL_COLOR, THEME_PALETTES } from "./palettes";

import "./editor";

interface WindowWithCustomCards extends Window {
  customCards: Array<{
    type: string;
    name: string;
    description: string;
    preview?: boolean;
    documentationURL?: string;
  }>;
}
// hass not available at module init — use navigator.language for the picker.
const initialLang =
  typeof navigator !== "undefined" ? navigator.language : "en";

(window as unknown as WindowWithCustomCards).customCards ??= [];
(window as unknown as WindowWithCustomCards).customCards.push({
  type: "spinning-wheel-card",
  name: localize("picker.name", initialLang),
  description: localize("picker.description", initialLang),
  preview: true,
  documentationURL: "https://github.com/rolandzeiner/spinning-wheel-card",
});

// ── Tunables ─────────────────────────────────────────────────────────
const DEFAULT_SIZE = 280;
const MIN_SIZE = 140;
const MAX_SIZE = 600;
// Pointer / hub geometry as fractions of size, calibrated against 280 px.
const HUB_RADIUS_FRAC = 18 / DEFAULT_SIZE;
const POINTER_HALF_WIDTH_FRAC = 12 / DEFAULT_SIZE;
const POINTER_TOP_FRAC = 2 / DEFAULT_SIZE;
const POINTER_TIP_FRAC = 22 / DEFAULT_SIZE;
const RIM_INSET_FRAC = 6 / DEFAULT_SIZE;

// Per-frame velocity multiplier at 60 fps. Lower = faster decay.
const FRICTION: Record<Friction, number> = {
  low: 0.995,    // ~6 s to drop to 10 % of initial ω
  medium: 0.99,  // ~4 s
  high: 0.98,    // ~2 s
};

const STOP_THRESHOLD_RAD_PER_S = 0.05;
const CLICK_IMPULSE_MIN = 8;   // rad/s ≈ 1.3 rev/s
const CLICK_IMPULSE_MAX = 16;  // rad/s ≈ 2.5 rev/s
const VELOCITY_SAMPLE_WINDOW_MS = 100;
const MAX_VELOCITY_RAD_PER_S = 40;

const TWO_PI = Math.PI * 2;

/** Wrap to [0, 2π). Prevents float drift after long sessions —
 *  `%` on a multi-billion-radian double is already lossy. */
const wrapAngle = (a: number): number => ((a % TWO_PI) + TWO_PI) % TWO_PI;

const TICK_RATE_LIMIT_MS = 30;      // ≈33 Hz tick ceiling
const TICK_PEAK_SPEED = 12;         // rad/s where ticks are loudest
const TICK_HIGH_SPEED_FLOOR = 0.3;  // intensity floor at MAX_VELOCITY

/** Drag-vs-click threshold (~3 px on a 280 px wheel). */
const DRAG_COMMIT_RAD = 0.04;

interface VelocitySample {
  t: number;        // performance.now()
  angleDelta: number;
}

@customElement("spinning-wheel-card")
export class SpinningWheelCard extends LitElement {
  public static getConfigElement(): LovelaceCardEditor {
    return document.createElement(
      "spinning-wheel-card-editor",
    ) as LovelaceCardEditor;
  }

  public static getStubConfig(): Record<string, unknown> {
    // Omit `name` — render() falls back to the localized default so the
    // card header tracks the user's HA language without baking a string
    // into the saved YAML.
    return { segments: 8, friction: "medium" };
  }

  @property({ attribute: false }) public hass!: HomeAssistant;

  @state() private config: SpinningWheelCardConfig = {
    type: "spinning-wheel-card",
  };

  @state() private _result: string | null = null;
  @state() private _spinning = false;

  // Wheel rotation in radians. 0 = first segment's leading edge at 12 o'clock
  // (rotated by -π/2 in the draw call so segment 0 is at the top initially).
  private _angle = 0;
  // Angular velocity, rad/s. Positive = clockwise (visually).
  private _omega = 0;

  // Drag tracking.
  private _dragging = false;
  private _dragMoved = false;
  private _dragLastAngle = 0;        // last pointer angle from centre, rad
  private _velocitySamples: VelocitySample[] = [];

  // RAF / timing.
  private _rafId: number | null = null;
  private _lastFrameMs = 0;

  // Live canvas size (CSS px). Updated by ResizeObserver. The canvas's
  // internal pixel dimensions track this × devicePixelRatio inside _draw.
  private _size = DEFAULT_SIZE;
  private _resizeObserver: ResizeObserver | null = null;

  // ── Todo-list integration ──────────────────────────────────────────
  // Cached open items from the configured todo entity. null = not yet
  // fetched (or no todo_entity). Empty array = fetched, list is empty.
  @state() private _todoItems: ReadonlyArray<TodoItem> | null = null;
  // Last seen `state` (count) for the todo entity — refetch when it
  // changes. Storing the raw state string (HA reports counts as
  // numeric strings) avoids a callWS on every hass-property update.
  private _todoLastEntityState: string | null = null;
  // True while a callWS is in flight, prevents duplicate fetches when
  // hass updates burst (e.g. theme + state changing in the same tick).
  private _todoLoading = false;

  public setConfig(config: SpinningWheelCardConfig): void {
    // Prefer the incoming language so an edit that flips language AND
    // introduces an error reports the error in the new language.
    const lang =
      (config?.language as string | undefined) ??
      this.config?.language ??
      resolveLang(this.hass);
    if (!config || typeof config !== "object") {
      throw new Error(localize("errors.invalid_config", lang));
    }
    if (config.name !== undefined && typeof config.name !== "string") {
      throw new Error(localize("errors.name_type", lang));
    }
    if (config.language !== undefined && typeof config.language !== "string") {
      throw new Error(localize("errors.language_type", lang));
    }
    if (config.segments !== undefined) {
      if (
        typeof config.segments !== "number" ||
        config.segments < 4 ||
        config.segments > 24 ||
        !Number.isInteger(config.segments)
      ) {
        throw new Error(localize("errors.segments_range", lang));
      }
    }
    if (
      config.friction !== undefined &&
      !["low", "medium", "high"].includes(config.friction)
    ) {
      throw new Error(localize("errors.friction_value", lang));
    }
    const segments = config.segments ?? 8;
    if (config.labels !== undefined) {
      if (
        !Array.isArray(config.labels) ||
        !config.labels.every((l) => typeof l === "string")
      ) {
        throw new Error(localize("errors.labels_type", lang));
      }
      if (config.labels.length > segments) {
        throw new Error(
          localize("errors.labels_length", lang, {
            len: config.labels.length,
            segments,
          }),
        );
      }
    }
    if (config.weights !== undefined) {
      if (
        !Array.isArray(config.weights) ||
        !config.weights.every(
          (w) => typeof w === "number" && Number.isFinite(w) && w > 0,
        )
      ) {
        throw new Error(localize("errors.weights_type", lang));
      }
      if (config.weights.length === 0) {
        throw new Error(localize("errors.weights_empty", lang));
      }
      if (config.weights.length > segments) {
        throw new Error(
          localize("errors.weights_length", lang, {
            len: config.weights.length,
            segments,
          }),
        );
      }
    }
    if (config.colors !== undefined) {
      if (
        !Array.isArray(config.colors) ||
        !config.colors.every((c) => typeof c === "string" && c.length > 0)
      ) {
        throw new Error(localize("errors.colors_type", lang));
      }
      if (config.colors.length === 0) {
        throw new Error(localize("errors.colors_empty", lang));
      }
      if (config.colors.length > segments) {
        throw new Error(
          localize("errors.colors_length", lang, {
            len: config.colors.length,
            segments,
          }),
        );
      }
    }
    if (config.label_colors !== undefined) {
      if (
        !Array.isArray(config.label_colors) ||
        !config.label_colors.every(
          (c) => typeof c === "string" && c.length > 0,
        )
      ) {
        throw new Error(localize("errors.label_colors_type", lang));
      }
      if (config.label_colors.length === 0) {
        throw new Error(localize("errors.label_colors_empty", lang));
      }
      if (config.label_colors.length > segments) {
        throw new Error(
          localize("errors.label_colors_length", lang, {
            len: config.label_colors.length,
            segments,
          }),
        );
      }
    }
    if (config.hub_text !== undefined && typeof config.hub_text !== "string") {
      throw new Error(localize("errors.hub_text_type", lang));
    }
    if (config.sound !== undefined && typeof config.sound !== "boolean") {
      throw new Error(localize("errors.sound_type", lang));
    }
    if (
      config.text_orientation !== undefined &&
      !["tangent", "radial"].includes(config.text_orientation)
    ) {
      throw new Error(localize("errors.text_orientation_value", lang));
    }
    if (
      config.theme !== undefined &&
      !["default", "pastel", "pride", "neon"].includes(config.theme)
    ) {
      throw new Error(localize("errors.theme_value", lang));
    }
    if (
      config.hub_color !== undefined &&
      !["theme", "black", "white"].includes(config.hub_color)
    ) {
      throw new Error(localize("errors.hub_color_value", lang));
    }
    if (
      config.show_status !== undefined &&
      typeof config.show_status !== "boolean"
    ) {
      throw new Error(localize("errors.show_status_type", lang));
    }
    if (config.todo_entity !== undefined) {
      if (typeof config.todo_entity !== "string") {
        throw new Error(localize("errors.todo_entity_type", lang));
      }
      if (config.todo_entity !== "" && !/^todo\.[a-z0-9_]+$/.test(config.todo_entity)) {
        throw new Error(localize("errors.todo_entity_invalid", lang));
      }
    }
    if (config.actions !== undefined) {
      if (!Array.isArray(config.actions)) {
        throw new Error(localize("errors.actions_type", lang));
      }
      if (config.actions.length > segments) {
        throw new Error(
          localize("errors.actions_length", lang, {
            len: config.actions.length,
            segments,
          }),
        );
      }
      for (const a of config.actions) {
        if (a === null) continue;
        if (typeof a === "string") {
          // Empty strings are tolerated (the editor's CSV parser drops
          // them already; YAML users can write null instead) — anything
          // non-empty must look like a `script.<name>` entity_id.
          if (a !== "" && !/^script\.[a-z0-9_]+$/.test(a)) {
            throw new Error(
              localize("errors.actions_string", lang, { value: a }),
            );
          }
          continue;
        }
        if (
          typeof a === "object" &&
          typeof (a as { action?: unknown }).action === "string"
        ) {
          continue;
        }
        throw new Error(localize("errors.actions_type", lang));
      }
    }
    if (
      config.disable_confirm_actions !== undefined &&
      typeof config.disable_confirm_actions !== "boolean"
    ) {
      throw new Error(localize("errors.disable_confirm_actions_type", lang));
    }
    if (
      config.disable_boost !== undefined &&
      typeof config.disable_boost !== "boolean"
    ) {
      throw new Error(localize("errors.disable_boost_type", lang));
    }
    // Detect a swap (or unset) of the todo_entity so we re-fetch — and
    // drop stale items from the old entity — instead of rendering them
    // briefly until the next state change.
    const prevTodo = this.config.todo_entity ?? null;
    const nextTodo = config.todo_entity ?? null;
    if (prevTodo !== nextTodo) {
      this._todoItems = null;
      this._todoLastEntityState = null;
    }
    this.config = { ...config };
    this._result = null;
  }

  /** Reactive language source. An explicit per-card `language` override
   *  (when set) wins over the HA-wide auto-detect chain so a user can
   *  e.g. run HA in German but render a single card in French. Falls
   *  through to `resolveLang(hass)` when unset. */
  private _lang(): string {
    return this.config?.language ?? resolveLang(this.hass);
  }

  private _hubText(): string {
    return this.config.hub_text ?? localize("hub.default_text", this._lang());
  }
  private _soundEnabled(): boolean {
    return this.config.sound ?? true;
  }
  private _textOrientation(): TextOrientation {
    if (this.config.text_orientation !== undefined) {
      return this.config.text_orientation;
    }
    // Long todo summaries read much better along the spoke than wrapped
    // around the rim. Default radial when filled from a todo list — user
    // can still override by explicitly setting text_orientation.
    if (this._isTodoMode()) return "radial";
    return "tangent";
  }

  /** True when a todo_entity is wired AND the wheel is currently
   *  rendering its open items (≥1). Used by both _textOrientation
   *  (default-radial override) and _draw (auto-fit font sizing). */
  private _isTodoMode(): boolean {
    return this._todoLabels() !== null;
  }

  public getCardSize(): number {
    return 6;
  }

  /** Mirrors HA's `LovelaceGridOptions` shape from
   *  `frontend/src/panels/lovelace/types.ts` (verified on `dev`,
   *  May 2026). All fields are optional in the upstream interface;
   *  we return concrete values so the section-view dashboard knows
   *  what the wheel wants by default. `max_columns` is `number` only
   *  (NOT `"full"` — only `columns` accepts that sentinel). */
  public getGridOptions(): {
    columns?: number | "full";
    rows?: number | "auto";
    min_columns?: number;
    min_rows?: number;
    max_columns?: number;
    max_rows?: number;
  } {
    // Concrete numeric defaults match how hui-clock-card (analog —
    // also a square aspect-ratio renderer) declares its grid. The
    // previous `rows: "auto"` made ha-card collapse to content
    // height, leaving the row-drag handle bound to nothing —
    // reported as "vertical resize doesn't work." Multiples of 3
    // for `columns` (6 here) are HA's documented preference for
    // fluid-aspect cards. No `max_*` caps: the canvas sizes itself
    // via the ResizeObserver in firstUpdated and clamps internally
    // at MAX_SIZE (600 px), so unbounded user drag is safe.
    return {
      columns: 6,
      rows: 6,
      min_columns: 4,
      min_rows: 4,
    };
  }

  /** Effective open-item summaries when a todo_entity is wired AND
   *  fetched at least once with ≥1 open items. Otherwise null — callers
   *  fall through to the static `labels` config / "1..N" default. */
  private _todoLabels(): ReadonlyArray<string> | null {
    if (!this.config.todo_entity) return null;
    if (!this._todoItems || this._todoItems.length === 0) return null;
    return this._todoItems.map((i) => i.summary);
  }

  private _segments(): number {
    const todo = this._todoLabels();
    if (todo) {
      // Auto-derive from open-item count, clamp to the wheel's 4..24
      // window. < 4 items still render on a 4-segment wheel with the
      // existing label-cycling rule covering the gap.
      return Math.max(4, Math.min(24, todo.length));
    }
    return this.config.segments ?? 8;
  }
  private _frictionFactor(): number {
    return FRICTION[this.config.friction ?? "medium"];
  }
  /** Labels expanded to length = segments. Shorter `labels` cycle around;
   *  empty / missing → "1".."N". */
  private _expandedLabels(): ReadonlyArray<string> {
    const n = this._segments();
    // Todo entity wins over the static labels config when both are set.
    const todo = this._todoLabels();
    const src = todo ?? this.config.labels;
    if (!src || src.length === 0) {
      return Array.from({ length: n }, (_, i) => String(i + 1));
    }
    return Array.from({ length: n }, (_, i) => src[i % src.length] ?? "");
  }

  /** Fetch open items from the configured todo entity via the
   *  `todo/item/list` WS endpoint. Filters to `needs_action`, dedups
   *  duplicate summaries (otherwise the same-label-same-colour rule
   *  would collapse the wheel visually) but only emits a console
   *  warning for the dedup so the user can fix the source. Re-runs
   *  whenever the entity's state count changes. */
  private async _fetchTodoItems(): Promise<void> {
    const entity = this.config.todo_entity;
    if (!entity || !this.hass?.callWS) return;
    if (this._todoLoading) return;
    this._todoLoading = true;
    try {
      const reply = (await this.hass.callWS({
        type: "todo/item/list",
        entity_id: entity,
      })) as { items?: ReadonlyArray<TodoItem> } | undefined;
      const all = reply?.items ?? [];
      const open = all.filter((i) => (i.status ?? "needs_action") === "needs_action");
      // Dedup by summary so the same-label-same-colour wheel rule doesn't
      // visually collapse two segments into one. Order-preserving.
      const seen = new Set<string>();
      const unique: TodoItem[] = [];
      for (const item of open) {
        const key = item.summary ?? "";
        if (!key || seen.has(key)) continue;
        seen.add(key);
        unique.push(item);
      }
      this._todoItems = unique;
      this._result = null;
      this._draw();
    } catch (err) {
      console.warn("[spinning-wheel-card] todo/item/list failed:", err);
      this._todoItems = [];
    } finally {
      this._todoLoading = false;
    }
  }
  /** Resolve the active fallback palette: explicit `theme` if set,
   *  otherwise the built-in rainbow. Always overridden by `colors`
   *  when supplied. */
  private _themePalette(): ReadonlyArray<string> {
    return THEME_PALETTES[this.config.theme ?? "default"];
  }

  /** Per-segment fill colour, derived so that any two segments sharing the
   *  same label also share a colour. Walks the labels in order; each new
   *  unique label takes the next colour from the palette. Resolution
   *  order: user-supplied `colors` → `theme` preset → default rainbow.
   *  The palette cycles if there are more unique labels than colours. */
   private _segmentColors(): ReadonlyArray<string> {
     return this._mapPaletteToLabels(this.config.colors, this._themePalette());
   }

  /** Per-segment label-text colour. Same unique-label-mapping rule as
   *  `_segmentColors`. Defaults to a single dark grey when the user
   *  hasn't supplied `label_colors`. */
  private _segmentLabelColors(): ReadonlyArray<string> {
    return this._mapPaletteToLabels(this.config.label_colors, [
      DEFAULT_LABEL_COLOR,
    ]);
  }

  /** Shared mapping for "palette cycled across unique labels in order of
   *  first appearance, fallback to `defaults` when the user-supplied
   *  palette is empty/missing." Used by both segment-fill and
   *  segment-label colour resolution. */
  private _mapPaletteToLabels(
    custom: ReadonlyArray<string> | undefined,
    defaults: ReadonlyArray<string>,
  ): ReadonlyArray<string> {
    const labels = this._expandedLabels();
    const palette: ReadonlyArray<string> =
      custom && custom.length > 0 ? custom : defaults;
    const map = new Map<string, string>();
    let assigned = 0;
    const out: string[] = new Array(labels.length);
    for (let i = 0; i < labels.length; i++) {
      const lbl = labels[i] ?? "";
      let c = map.get(lbl);
      if (c === undefined) {
        c = palette[assigned % palette.length] ?? defaults[0] ?? "#888";
        map.set(lbl, c);
        assigned += 1;
      }
      out[i] = c;
    }
    return out;
  }

  /** Per-segment ActionConfig (or null = no action), aligned to the
   *  expanded labels array. Same-label-same-action mapping mirrors the
   *  `colors` rule: walks labels in order, each new unique label takes
   *  the next entry from `actions`, and segments sharing a label always
   *  fire the same action. The result of a spin is the *label*, not the
   *  index, so this matches the user's mental model. */
  private _segmentActions(): ReadonlyArray<ActionConfig | null> {
    const labels = this._expandedLabels();
    const src = this.config.actions;
    if (!src || src.length === 0) {
      return new Array<ActionConfig | null>(labels.length).fill(null);
    }
    const map = new Map<string, ActionConfig | null>();
    let assigned = 0;
    const out: (ActionConfig | null)[] = new Array(labels.length);
    for (let i = 0; i < labels.length; i++) {
      const lbl = labels[i] ?? "";
      if (!map.has(lbl)) {
        const raw = src[assigned % src.length];
        map.set(lbl, this._normalizeAction(raw));
        assigned += 1;
      }
      out[i] = map.get(lbl) ?? null;
    }
    return out;
  }

  /** Coerce raw config entries to the dispatcher's ActionConfig shape.
   *  String shorthand: `script.<name>` → `perform-action` of that script
   *  service. Any other string (or empty / null) → null (no-op). Object
   *  entries pass through verbatim — setConfig has already validated
   *  they carry an `action` field. */
  private _normalizeAction(
    raw: string | ActionConfig | null | undefined,
  ): ActionConfig | null {
    if (raw == null) return null;
    if (typeof raw === "string") {
      if (!/^script\.[a-z0-9_]+$/.test(raw)) return null;
      return { action: "perform-action", perform_action: raw };
    }
    return raw;
  }

  /** Short, user-readable name for the action's destination — surfaced in
   *  the confirmation prompt alongside the segment label so the user can
   *  see *what* will run when the label itself is opaque (e.g. an MDI
   *  icon name like `mdi:hamburger`). */
  private _actionDisplayName(cfg: ActionConfig): string {
    switch (cfg.action) {
      case "perform-action":
        return cfg.perform_action;
      case "call-service":
        return cfg.service;
      case "navigate":
        return `navigate: ${cfg.navigation_path}`;
      case "url":
        return cfg.url_path;
      case "more-info":
        return `more-info: ${cfg.entity ?? "?"}`;
      case "toggle":
        return `toggle: ${cfg.entity ?? "?"}`;
      case "assist":
        return "assist";
      case "fire-dom-event":
        return "fire-dom-event";
      default:
        return (cfg as { action: string }).action;
    }
  }

  /** Resolve whether an action should run after confirmation. Card-level
   *  `disable_confirm_actions: true` skips the prompt entirely. Per-action
   *  `confirmation: false` opts a single action out (overrides the
   *  card-level default-on). Any other shape (`true` / `{text}` / unset)
   *  falls through to a `window.confirm` prompt — dep-free, OS-native,
   *  blocking. */
  private async _confirmAction(cfg: ActionConfig): Promise<boolean> {
    if (this.config.disable_confirm_actions === true) return true;
    const cfgConfirm: ConfirmationConfig | undefined =
      "confirmation" in cfg
        ? (cfg.confirmation as ConfirmationConfig | undefined)
        : undefined;
    if (cfgConfirm === false) return true;
    const text =
      typeof cfgConfirm === "object" && cfgConfirm?.text
        ? cfgConfirm.text
        : localize("confirm.run_action", this._lang(), {
            action: this._actionDisplayName(cfg),
            value: this._result ?? "",
          });
    return typeof window !== "undefined" && typeof window.confirm === "function"
      ? window.confirm(text)
      : true;
  }

  /** Hand-rolled Lovelace ActionConfig dispatcher. Covers the standard
   *  HA action types without pulling in `custom-card-helpers`. Service
   *  calls accept either the legacy `call-service` / `service` pair or
   *  the modern `perform-action` / `perform_action` pair (renamed in
   *  HA 2024.8 — runtime still accepts both). */
  private async _dispatchAction(cfg: ActionConfig): Promise<void> {
    if (!this.hass) return;
    if (cfg.action === "none") return;
    if (!(await this._confirmAction(cfg))) return;
    switch (cfg.action) {
      case "perform-action":
      case "call-service": {
        const svc =
          cfg.action === "perform-action" ? cfg.perform_action : cfg.service;
        if (typeof svc !== "string") return;
        const dot = svc.indexOf(".");
        if (dot <= 0 || dot === svc.length - 1) return;
        const domain = svc.slice(0, dot);
        const name = svc.slice(dot + 1);
        const data =
          cfg.action === "call-service"
            ? (cfg.data ?? cfg.service_data ?? {})
            : (cfg.data ?? {});
        const target = "target" in cfg ? cfg.target : undefined;
        await this.hass.callService?.(domain, name, data, target);
        return;
      }
      case "navigate": {
        if (typeof cfg.navigation_path !== "string") return;
        if (cfg.navigation_replace) {
          window.history.replaceState(null, "", cfg.navigation_path);
        } else {
          window.history.pushState(null, "", cfg.navigation_path);
        }
        // HA's frontend listens for this on `window` to re-render the
        // active dashboard route — same event hui-* cards dispatch.
        window.dispatchEvent(
          new CustomEvent("location-changed", {
            detail: { replace: cfg.navigation_replace ?? false },
          }),
        );
        return;
      }
      case "url": {
        if (typeof cfg.url_path !== "string") return;
        window.open(cfg.url_path, "_blank", "noopener,noreferrer");
        return;
      }
      case "more-info": {
        if (!cfg.entity) return;
        this.dispatchEvent(
          new CustomEvent("hass-more-info", {
            detail: { entityId: cfg.entity },
            bubbles: true,
            composed: true,
          }),
        );
        return;
      }
      case "toggle": {
        if (!cfg.entity) return;
        await this.hass.callService?.(
          "homeassistant",
          "toggle",
          {},
          { entity_id: cfg.entity },
        );
        return;
      }
      case "assist": {
        // Mirrors how HA's own action handler surfaces Assist —
        // a CustomEvent the dashboard listens for.
        this.dispatchEvent(
          new CustomEvent("hass-assist-show", {
            detail: {
              pipeline_id: cfg.pipeline_id,
              start_listening: cfg.start_listening ?? false,
            },
            bubbles: true,
            composed: true,
          }),
        );
        return;
      }
      case "fire-dom-event": {
        const detail: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(cfg)) {
          if (k !== "action") detail[k] = v;
        }
        this.dispatchEvent(
          new CustomEvent("ll-custom", {
            detail,
            bubbles: true,
            composed: true,
          }),
        );
        return;
      }
    }
  }

  /** Per-segment arc widths in radians, summing to 2π. Honours `weights`
   *  (cycled to length = segments, then normalised). Defaults to equal. */
  private _arcs(): ReadonlyArray<number> {
    const n = this._segments();
    const src = this.config.weights;
    let weights: number[];
    if (!src || src.length === 0) {
      weights = Array<number>(n).fill(1);
    } else {
      weights = Array.from({ length: n }, (_, i) => {
        const v = src[i % src.length];
        return typeof v === "number" && v > 0 ? v : 1;
      });
    }
    const total = weights.reduce((a, b) => a + b, 0);
    if (total <= 0) return Array<number>(n).fill((Math.PI * 2) / n);
    return weights.map((w) => (w / total) * Math.PI * 2);
  }

  protected override firstUpdated(_changed: PropertyValues): void {
    const wrap = this.shadowRoot?.querySelector(".wheel-wrap") as
      | HTMLElement
      | null;
    const c = this.shadowRoot?.getElementById("wheel") as
      | HTMLCanvasElement
      | null;
    if (!wrap || !c) {
      this._draw();
      return;
    }
    // Seed size from layout if it has resolved; the observer's first
    // delivery fixes it within a frame either way.
    const rect = wrap.getBoundingClientRect();
    if (rect.width > 0 || rect.height > 0) {
      this._size = this._clampSize(this._fitDim(rect.width, rect.height));
      this._applyCanvasSize();
    }
    this._resizeObserver = new ResizeObserver((entries) => {
      // Entries are delivered on a microtask; a `disconnect()` that ran
      // moments ago does not unqueue them. Bail when detached rather
      // than mutating state on an unmounted element.
      if (!this.isConnected) return;
      for (const e of entries) {
        const next = this._clampSize(
          this._fitDim(e.contentRect.width, e.contentRect.height),
        );
        // Tolerance avoids redraws on sub-pixel jitter from layout
        // recalcs that don't actually change the rendered size.
        if (Math.abs(next - this._size) >= 1) {
          this._size = next;
          this._applyCanvasSize();
          this._draw();
        }
      }
    });
    // Observe the wrap, not the canvas — the canvas's CSS box is
    // driven by the inline width/height we set ourselves, so observing
    // it would create a no-op feedback loop. The wrap reflects the
    // actual container the wheel can grow into.
    this._resizeObserver.observe(wrap);
    this._draw();
  }

  /** Compute the wheel's effective square size from a container box.
   *  Smaller of width / height in the normal case (cell has both
   *  definite dimensions). Falls back to width-only when the height is
   *  0 / NaN — happens in masonry view, vertical-stack-card, and any
   *  surface that doesn't propagate a definite block-size. Without
   *  this fallback the canvas would snap to MIN_SIZE forever in those
   *  contexts, which manifested as the "width is NaN on default" bug
   *  reported after the container-query layout went in. */
  private _fitDim(w: number, h: number): number {
    const wOk = Number.isFinite(w) && w > 0;
    const hOk = Number.isFinite(h) && h > 0;
    if (wOk && hOk) return Math.min(w, h);
    if (wOk) return w;
    if (hOk) return h;
    return DEFAULT_SIZE;
  }

  /** Apply the current `_size` as inline width/height on the canvas
   *  element. Mirrors the previous CSS-driven sizing path; using inline
   *  style means the next ResizeObserver delivery sees a stable size
   *  and doesn't re-fire spuriously. */
  private _applyCanvasSize(): void {
    const c = this.shadowRoot?.getElementById("wheel") as
      | HTMLCanvasElement
      | null;
    if (!c) return;
    c.style.width = `${this._size}px`;
    c.style.height = `${this._size}px`;
  }

  public override disconnectedCallback(): void {
    super.disconnectedCallback();
    this._stopAnim();
    this._resizeObserver?.disconnect();
    this._resizeObserver = null;
    if (this._audioCtx) {
      void this._audioCtx.close().catch(() => {});
      this._audioCtx = null;
      this._audioReady = false;
    }
    // Reset drag state — without this, a card moved across dashboard tabs
    // mid-drag (so neither pointerup nor pointercancel ever fires) keeps
    // `_dragging` true and the next pointermove on reconnect runs against
    // a stale `_dragLastAngle`.
    this._dragging = false;
    this._dragMoved = false;
    this._dragAccumulated = 0;
    this._velocitySamples = [];
    this._lastTickSeg = -1;
    // Drop the icon cache — HA may re-register icon sources between
    // mounts; the next redraw re-resolves what's needed.
    this._iconCache.clear();
    this._iconLoading.clear();
  }

  private _clampSize(w: number): number {
    return Math.max(MIN_SIZE, Math.min(MAX_SIZE, Math.round(w)));
  }

  // ── Theme-aware colours for pointer + hub ──────────────────────────

  private _resolveTheme(ctx: CanvasRenderingContext2D): {
    indicatorFill: string;
    hubLight: string;
    hubDark: string;
    hubText: string;
    hubStroke: string;
  } {
    const cs = getComputedStyle(this);
    const dividerColor =
      cs.getPropertyValue("--divider-color").trim() ||
      "rgba(0,0,0,0.45)";

    const choice: HubColor = this.config.hub_color ?? "theme";

    if (choice === "black") {
      // Solid black hub + indicator with white hub text. The hub keeps
      // a subtle radial gradient (dark grey highlight → pure black edge)
      // so it still reads as a button rather than a flat disc.
      return {
        indicatorFill: "#000000",
        hubLight: "#3a3a3a",
        hubDark: "#000000",
        hubText: "#ffffff",
        hubStroke: dividerColor,
      };
    }

    if (choice === "white") {
      return {
        indicatorFill: "#ffffff",
        hubLight: "#ffffff",
        hubDark: "#cccccc",
        hubText: "#000000",
        hubStroke: dividerColor,
      };
    }

    // Default: theme accent — both indicator and hub use --primary-color,
    // hub label auto-picks black/white via WCAG luminance.
    const primary =
      cs.getPropertyValue("--primary-color").trim() || "#03a9f4";
    const rgb = this._cssColorToRgb(primary, ctx);
    return {
      indicatorFill: primary,
      hubLight: this._adjustLightness(rgb, 0.18),
      hubDark: this._adjustLightness(rgb, -0.18),
      hubText: this._isLight(rgb) ? "#0a0a0a" : "#ffffff",
      hubStroke: dividerColor,
    };
  }

  /** Canonicalise any CSS colour to [r, g, b] via the canvas fillStyle
   *  round-trip — setting and reading back returns the canonical form. */
  private _cssColorToRgb(
    color: string,
    ctx: CanvasRenderingContext2D,
  ): [number, number, number] {
    const prev = ctx.fillStyle;
    ctx.fillStyle = color;
    const canon = String(ctx.fillStyle);
    ctx.fillStyle = prev;
    if (canon.startsWith("#")) {
      if (canon.length === 7) {
        return [
          parseInt(canon.slice(1, 3), 16),
          parseInt(canon.slice(3, 5), 16),
          parseInt(canon.slice(5, 7), 16),
        ];
      }
      if (canon.length === 4) {
        return [
          parseInt(canon[1]!.repeat(2), 16),
          parseInt(canon[2]!.repeat(2), 16),
          parseInt(canon[3]!.repeat(2), 16),
        ];
      }
    }
    const m = canon.match(/(\d+)\D+(\d+)\D+(\d+)/);
    if (m) return [parseInt(m[1]!, 10), parseInt(m[2]!, 10), parseInt(m[3]!, 10)];
    return [128, 128, 128];
  }

  /** Tint a colour toward white (positive delta) or black (negative). */
  private _adjustLightness(
    [r, g, b]: [number, number, number],
    delta: number,
  ): string {
    const apply = (c: number): number =>
      delta >= 0
        ? Math.round(c + (255 - c) * delta)
        : Math.round(c * (1 + delta));
    return `rgb(${apply(r)}, ${apply(g)}, ${apply(b)})`;
  }

  /** Draw text along an arc of radius R, centred on midAngle. Each glyph
   *  rotated to be locally tangent. Caller owns font/fillStyle/align. */
  private _drawArchedText(
    ctx: CanvasRenderingContext2D,
    text: string,
    midAngle: number,
    radius: number,
  ): void {
    if (!text || radius <= 0) return;
    const chars = Array.from(text);
    const widths = chars.map((c) => ctx.measureText(c).width);
    // Convert each glyph width to the angle it subtends at this radius.
    const angularWidths = widths.map((w) => w / radius);
    const totalAngular = angularWidths.reduce((s, a) => s + a, 0);
    let angle = midAngle - totalAngular / 2;
    for (let i = 0; i < chars.length; i++) {
      const aw = angularWidths[i] ?? 0;
      const charAngle = angle + aw / 2;
      ctx.save();
      ctx.rotate(charAngle);              // +X now points at this glyph's spoke
      ctx.translate(radius, 0);           // … out along that spoke
      ctx.rotate(Math.PI / 2);            // … then turn so +X is tangent (CW)
      ctx.fillText(chars[i] ?? "", 0, 0);
      ctx.restore();
      angle += aw;
    }
  }

  // ── MDI / HA icon support ───────────────────────────────────────────
  // Icon labels (`mdi:foo`, `hass:foo`) borrow their SVG path from a
  // hidden ha-icon at runtime — no @mdi/js bundle, rendered via Path2D.

  /** path | null = looked up but not found | undefined = not yet looked up. */
  private _iconCache = new Map<string, string | null>();
  /** in-flight loads, prevents N redundant DOM queries per redraw. */
  private _iconLoading = new Set<string>();

  /** Matches mdi:foo / hass:foo / any namespaced HA icon reference. */
  private _looksLikeIcon(label: string): boolean {
    return /^[a-z][a-z0-9_-]*:[a-z0-9-]+$/i.test(label);
  }

  /** Path string when ready, null when HA reports missing, undefined
   *  while the load is in flight (kicks off the load on first call). */
  private _getIconPath(name: string): string | null | undefined {
    const cached = this._iconCache.get(name);
    if (cached !== undefined) return cached;
    if (!this._iconLoading.has(name)) {
      this._iconLoading.add(name);
      void this._loadIcon(name);
    }
    return undefined;
  }

  private async _loadIcon(name: string): Promise<void> {
    try {
      const probe = document.createElement("ha-icon") as HTMLElement & {
        icon?: string;
        updateComplete?: Promise<unknown>;
      };
      probe.icon = name;
      probe.style.position = "absolute";
      probe.style.left = "-9999px";
      probe.style.top = "-9999px";
      probe.style.width = "24px";
      probe.style.height = "24px";
      document.body.appendChild(probe);

      // ha-icon resolves async; poll up to ~500 ms (30 frames).
      let path: string | null = null;
      for (let attempt = 0; attempt < 30 && !path; attempt++) {
        if (probe.updateComplete) {
          try {
            await probe.updateComplete;
          } catch {
            /* ignore */
          }
        }
        const svgIcon = probe.shadowRoot?.querySelector("ha-svg-icon") as
          | (HTMLElement & { path?: string })
          | null
          | undefined;
        // Fallback chain: modern ha-svg-icon.path → its shadow <path>
        // → ha-icon's own <path> (legacy iron-icon flow).
        path =
          svgIcon?.path ??
          svgIcon?.shadowRoot?.querySelector("path")?.getAttribute("d") ??
          probe.shadowRoot?.querySelector("path")?.getAttribute("d") ??
          null;
        if (!path) {
          await new Promise<void>((r) => requestAnimationFrame(() => r()));
        }
      }
      probe.remove();
      this._iconCache.set(name, path);
    } catch {
      this._iconCache.set(name, null);
    } finally {
      this._iconLoading.delete(name);
      // Trigger a redraw now that the icon is ready (or known-missing).
      // Skip if the card was disconnected mid-load.
      if (this.isConnected) this._draw();
    }
  }

  /** Draw a 24×24 MDI path centred on the segment, scaled to iconPx,
   *  rotated to match the active orientation (same rule as text). */
  private _drawSegmentIcon(
    ctx: CanvasRenderingContext2D,
    pathStr: string,
    midAngle: number,
    radius: number,
    iconPx: number,
    fillColor: string,
    orientation: TextOrientation,
  ): void {
    ctx.save();
    ctx.rotate(midAngle);
    ctx.translate(radius, 0);
    // Same orientation rule as the text path — π/2 for tangent, π for
    // radial — so icons line up with text labels in mixed-content wheels.
    ctx.rotate(orientation === "radial" ? Math.PI : Math.PI / 2);
    const scale = iconPx / 24;
    ctx.scale(scale, scale);
    ctx.translate(-12, -12);
    ctx.fillStyle = fillColor;
    ctx.fill(new Path2D(pathStr));
    ctx.restore();
  }

  /** Relative luminance per WCAG (sRGB). Used to pick black or white
   *  text for the hub label so it always reads against the chosen
   *  primary-color background. */
  private _isLight([r, g, b]: [number, number, number]): boolean {
    const lin = (c: number): number => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    return L > 0.5;
  }

  // ── Physics loop ────────────────────────────────────────────────────

  private _startAnim(): void {
    if (this._rafId !== null) return;
    // WCAG 2.3.3 — when the user has asked for reduced motion, skip the
    // multi-second decay. Apply 1.5 s of equivalent decay so the result
    // isn't trivially the impulse-application angle, then announce.
    if (
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    ) {
      this._angle = wrapAngle(this._angle + this._omega * 1.5);
      this._omega = 0;
      this._spinning = false;
      this._lastTickSeg = -1;
      this._announceResult();
      this._draw();
      return;
    }
    this._lastFrameMs = performance.now();
    // Establish a baseline so the first frame doesn't tick spuriously.
    this._lastTickSeg = this._segmentIndexUnderPointer();
    const tick = (now: number): void => {
      const dt = Math.min(0.05, (now - this._lastFrameMs) / 1000); // clamp to 50ms
      this._lastFrameMs = now;

      this._angle = wrapAngle(this._angle + this._omega * dt);
      // Frame-rate-independent decay: at 60 fps, dt≈1/60, exponent≈1.
      this._omega *= Math.pow(this._frictionFactor(), 60 * dt);

      // Bell curve: ramp 0 → peak by TICK_PEAK_SPEED, taper to FLOOR
      // by MAX_VELOCITY so dense ticks don't pile into a wash.
      const omegaAbs = Math.abs(this._omega);
      let intensity: number;
      if (omegaAbs <= TICK_PEAK_SPEED) {
        intensity = omegaAbs / TICK_PEAK_SPEED;
      } else {
        const overshoot =
          (omegaAbs - TICK_PEAK_SPEED) /
          (MAX_VELOCITY_RAD_PER_S - TICK_PEAK_SPEED);
        intensity = Math.max(
          TICK_HIGH_SPEED_FLOOR,
          1 - overshoot * (1 - TICK_HIGH_SPEED_FLOOR),
        );
      }
      this._maybeTick(intensity);

      this._draw();

      if (Math.abs(this._omega) < STOP_THRESHOLD_RAD_PER_S) {
        this._omega = 0;
        this._spinning = false;
        this._rafId = null;
        this._lastTickSeg = -1;
        this._announceResult();
        return;
      }
      this._rafId = window.requestAnimationFrame(tick);
    };
    this._rafId = window.requestAnimationFrame(tick);
  }

  private _stopAnim(): void {
    if (this._rafId !== null) {
      window.cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
  }

  /** Index of segment under the 12 o'clock pointer. Segment 0 is centred
   *  there at angle 0 (offset by arcs[0]/2 in local coords); we walk
   *  cumulative arcs until the running sum exceeds the pointer angle. */
  private _segmentIndexUnderPointer(): number {
    const arcs = this._arcs();
    if (arcs.length === 0) return 0;
    const a0 = arcs[0] ?? TWO_PI / arcs.length;
    const target = wrapAngle(-this._angle + a0 / 2);
    let cursor = 0;
    for (let i = 0; i < arcs.length; i++) {
      const next = cursor + (arcs[i] ?? 0);
      if (target < next) return i;
      cursor = next;
    }
    return arcs.length - 1;
  }

  private _announceResult(): void {
    const labels = this._expandedLabels();
    const idx = this._segmentIndexUnderPointer();
    this._result = labels[idx] ?? null;
    // Fire the winning segment's configured action, if any. Same-label-
    // same-action mapping has already happened in _segmentActions; this
    // is purely an indexed lookup. Confirmation (window.confirm) blocks
    // the await, so a held click during the prompt can't double-fire.
    const actions = this._segmentActions();
    const action = actions[idx];
    if (action) void this._dispatchAction(action);
  }

  // ── Audio (peg clicks) ──────────────────────────────────────────────

  private _audioCtx: AudioContext | null = null;
  /** True once `ctx.resume()` has resolved. `_playTick` returns early
   *  while false to avoid scheduling a buffer source against a stale
   *  `currentTime` on a still-suspended context (Safari race). */
  private _audioReady = false;
  /** Last segment index for which we emitted a tick. -1 = "no baseline yet". */
  private _lastTickSeg = -1;
  /** performance.now() of the most recent emitted tick. Drives the rate
   *  limit so a fast spin doesn't queue ticks faster than the ear can
   *  separate them. */
  private _lastTickMs = 0;

  private _ensureAudio(): AudioContext | null {
    if (this._audioCtx) return this._audioCtx;
    if (typeof window.AudioContext === "undefined") return null;
    try {
      this._audioCtx = new AudioContext();
      // Safari (and gesture-less Chromium) returns a pending promise
      // here; flip _audioReady when it resolves so _playTick doesn't
      // schedule against a stale currentTime.
      const ctx = this._audioCtx;
      if (ctx.state === "running") {
        this._audioReady = true;
      } else {
        void ctx
          .resume()
          .then(() => {
            this._audioReady = true;
          })
          .catch(() => {});
      }
    } catch {
      return null;
    }
    return this._audioCtx;
  }

  private _playTick(intensity: number): void {
    if (!this._soundEnabled()) return;
    const ctx = this._ensureAudio();
    if (!ctx) return;
    // Skip rather than schedule against a not-yet-resumed context.
    if (!this._audioReady || ctx.state !== "running") {
      if (ctx.state === "suspended") {
        void ctx
          .resume()
          .then(() => {
            this._audioReady = true;
          })
          .catch(() => {});
      }
      return;
    }
    const t0 = ctx.currentTime;
    // Tick duration follows intensity so high-speed clicks don't blur.
    const I = Math.max(0, Math.min(1, intensity));
    const dur = 0.025 + 0.015 * I; // 25..40 ms

    // Decaying-noise burst with a quadratic (rather than exponential)
    // tail so the back end is rounder, not "spiky".
    const sampleRate = ctx.sampleRate;
    const samples = Math.max(1, Math.floor(sampleRate * dur));
    const buf = ctx.createBuffer(1, samples, sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < samples; i++) {
      const x = i / samples;
      const env = (1 - x) * (1 - x); // quadratic decay
      data[i] = (Math.random() * 2 - 1) * env;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;

    // Bandpass: lower centre + lower Q than before. Less "ping",
    // more "tok".
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 1700;
    bp.Q.value = 3;

    // Low-pass on top to roll off the harshest highs. ~4 kHz keeps the
    // click intelligible but takes the ice-pick edge off.
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 4000;
    lp.Q.value = 0.7;

    // 2 ms attack ramp so the click doesn't start on a sample-zero cliff
    // (that's most of what makes a synthetic click sound "hard").
    const gainNode = ctx.createGain();
    const peak = 0.03 + 0.13 * I;
    gainNode.gain.setValueAtTime(0, t0);
    gainNode.gain.linearRampToValueAtTime(peak, t0 + 0.002);
    gainNode.gain.exponentialRampToValueAtTime(0.001, t0 + dur);

    src.connect(bp).connect(lp).connect(gainNode).connect(ctx.destination);
    src.start(t0);
    src.stop(t0 + dur + 0.01);
  }

  /** Emit a tick when the segment under the pointer changes, capped at
   *  TICK_RATE_LIMIT_MS. The cursor still advances when rate-limited so
   *  we don't fire spuriously after the cooldown. */
  private _maybeTick(intensity: number): void {
    if (!this._soundEnabled()) {
      this._lastTickSeg = -1;
      return;
    }
    const cur = this._segmentIndexUnderPointer();
    if (this._lastTickSeg === -1) {
      this._lastTickSeg = cur;
      return;
    }
    if (cur === this._lastTickSeg) return;
    const now = performance.now();
    if (now - this._lastTickMs >= TICK_RATE_LIMIT_MS) {
      this._playTick(intensity);
      this._lastTickMs = now;
    }
    // Always advance the seg cursor — even when a tick is rate-limited
    // we don't want it to fire spuriously on the next crossing.
    this._lastTickSeg = cur;
  }

  // ── Pointer input ───────────────────────────────────────────────────

  private _wheelRect(): DOMRect | null {
    const c = this.shadowRoot?.getElementById("wheel") as
      | HTMLCanvasElement
      | null;
    return c?.getBoundingClientRect() ?? null;
  }

  // Convert a client-space (x, y) to angle from canvas centre, in
  // radians, with 0 = +X axis, growing CCW (standard math convention).
  // We invert-Y because the canvas's coordinate Y grows downward.
  private _angleFrom(ev: PointerEvent): number | null {
    const rect = this._wheelRect();
    if (!rect) return null;
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    return Math.atan2(ev.clientY - cy, ev.clientX - cx);
  }

  private _dragAccumulated = 0;

  private _onPointerDown = (ev: PointerEvent): void => {
    if (ev.button !== undefined && ev.button !== 0) return; // left only
    const a = this._angleFrom(ev);
    if (a === null) return;
    this._dragging = true;
    this._dragMoved = false;
    this._dragLastAngle = a;
    this._dragAccumulated = 0;
    this._velocitySamples = [];
    // Don't zero omega or stop anim here — we don't yet know if this
    // is a click or a drag. Click-during-spin should boost; only a
    // real drag (after DRAG_COMMIT_RAD in pointermove) commandeers.
    if (this._soundEnabled()) {
      const ctx = this._ensureAudio();
      if (ctx?.state === "suspended") {
        void ctx
          .resume()
          .then(() => {
            this._audioReady = true;
          })
          .catch(() => {});
      }
      // Only seed when RAF isn't running — otherwise the loop owns
      // `_lastTickSeg` and reseeding would race the next tick.
      if (this._rafId === null) {
        this._lastTickSeg = this._segmentIndexUnderPointer();
      }
    }
    (ev.currentTarget as Element).setPointerCapture?.(ev.pointerId);
    ev.preventDefault();
  };

  private _onPointerMove = (ev: PointerEvent): void => {
    if (!this._dragging) return;
    const a = this._angleFrom(ev);
    if (a === null) return;
    let delta = a - this._dragLastAngle;
    // Normalise to (-π, π] to handle the atan2 wrap.
    if (delta > Math.PI) delta -= Math.PI * 2;
    else if (delta < -Math.PI) delta += Math.PI * 2;

    // Track total movement so a sub-threshold wobble during a click
    // doesn't take the wheel over.
    this._dragAccumulated += Math.abs(delta);
    if (!this._dragMoved && this._dragAccumulated > DRAG_COMMIT_RAD) {
      this._dragMoved = true;
      this._omega = 0;
      this._stopAnim();
      this._result = null;
    }
    this._dragLastAngle = a;

    if (!this._dragMoved) {
      // Sub-threshold — don't move the wheel yet. lastAngle is updated
      // above so the next delta starts from the current position.
      return;
    }

    this._angle = wrapAngle(this._angle + delta);

    const t = ev.timeStamp || performance.now();
    this._velocitySamples.push({ t, angleDelta: delta });
    const cutoff = t - VELOCITY_SAMPLE_WINDOW_MS;
    while (
      this._velocitySamples.length > 0 &&
      this._velocitySamples[0]!.t < cutoff
    ) {
      this._velocitySamples.shift();
    }

    this._maybeTick(Math.min(1, Math.abs(delta) * 6));
    this._draw();
  };

  private _onPointerUp = (ev: PointerEvent): void => {
    if (!this._dragging) return;
    this._dragging = false;
    (ev.currentTarget as Element).releasePointerCapture?.(ev.pointerId);

    if (!this._dragMoved) {
      // Click without drag.
      const wasSpinning =
        Math.abs(this._omega) >= STOP_THRESHOLD_RAD_PER_S;
      // Boost-on-click is opt-out via `disable_boost` — kid-friendly
      // dashboards can quiet the "click to add another impulse" feel
      // so the spin settles naturally even under rapid clicking.
      // Drag-to-throw is unaffected (different code path).
      if (wasSpinning && this.config.disable_boost === true) {
        // No-op: ignore the click while the wheel is in motion.
      } else {
        const mag =
          CLICK_IMPULSE_MIN +
          Math.random() * (CLICK_IMPULSE_MAX - CLICK_IMPULSE_MIN);
        if (wasSpinning) {
          // BOOST: add impulse in the wheel's current direction. Cap
          // at MAX_VELOCITY so repeated clicks don't compound past
          // the sane upper bound.
          const sign = this._omega >= 0 ? 1 : -1;
          const next = this._omega + sign * mag;
          this._omega = Math.max(
            -MAX_VELOCITY_RAD_PER_S,
            Math.min(MAX_VELOCITY_RAD_PER_S, next),
          );
        } else {
          // Fresh start from rest — random direction.
          const sign = Math.random() < 0.5 ? -1 : 1;
          this._omega = sign * mag;
          this._result = null;
        }
      }
    } else {
      // Drag release — sample-window-averaged angular velocity.
      const now = ev.timeStamp || performance.now();
      const cutoff = now - VELOCITY_SAMPLE_WINDOW_MS;
      const samples = this._velocitySamples.filter((s) => s.t >= cutoff);
      if (samples.length >= 2) {
        const totalDelta = samples.reduce((s, x) => s + x.angleDelta, 0);
        const span =
          (samples[samples.length - 1]!.t - samples[0]!.t) / 1000;
        if (span > 0) {
          let v = totalDelta / span;
          v = Math.max(
            -MAX_VELOCITY_RAD_PER_S,
            Math.min(MAX_VELOCITY_RAD_PER_S, v),
          );
          this._omega = v;
        }
      }
    }
    this._velocitySamples = [];
    this._dragAccumulated = 0;

    // Start the RAF loop only if it isn't already running.
    if (
      Math.abs(this._omega) >= STOP_THRESHOLD_RAD_PER_S &&
      this._rafId === null
    ) {
      this._spinning = true;
      this._startAnim();
    } else if (this._rafId === null) {
      // Drag-to-stop: drag-commit already called _stopAnim but left
      // _spinning true (the prior RAF loop owned that flag). Snap to
      // rest here so the status line doesn't stay stuck on "Spinning…".
      this._omega = 0;
      this._spinning = false;
      this._lastTickSeg = -1;
      this._announceResult();
      this._draw();
    }
  };

  private _onPointerCancel = (ev: PointerEvent): void => {
    if (!this._dragging) return;
    this._dragging = false;
    (ev.currentTarget as Element).releasePointerCapture?.(ev.pointerId);
    this._velocitySamples = [];
    this._dragAccumulated = 0;
  };

  /** Keyboard equivalent for click-to-spin. Space and Enter trigger the
   *  same impulse-or-boost behaviour as a pointer click without drag.
   *  WCAG 2.1.1 (Keyboard) — pointer-only inputs need a keyboard
   *  alternative for non-trivial card interactions. */
  private _onKeyDown = (ev: KeyboardEvent): void => {
    if (ev.key !== " " && ev.key !== "Enter") return;
    ev.preventDefault();
    // Warm audio on first user gesture; the same pathway pointerdown takes.
    if (this._soundEnabled()) {
      const ctx = this._ensureAudio();
      if (ctx?.state === "suspended") {
        void ctx
          .resume()
          .then(() => {
            this._audioReady = true;
          })
          .catch(() => {});
      }
    }
    const wasSpinning = Math.abs(this._omega) >= STOP_THRESHOLD_RAD_PER_S;
    // Same `disable_boost` gate as the pointer path — keyboard
    // activation is the WCAG-equivalent of a click and should respect
    // the same kid-friendly opt-out.
    if (wasSpinning && this.config.disable_boost === true) return;
    const mag =
      CLICK_IMPULSE_MIN +
      Math.random() * (CLICK_IMPULSE_MAX - CLICK_IMPULSE_MIN);
    if (wasSpinning) {
      const sign = this._omega >= 0 ? 1 : -1;
      const next = this._omega + sign * mag;
      this._omega = Math.max(
        -MAX_VELOCITY_RAD_PER_S,
        Math.min(MAX_VELOCITY_RAD_PER_S, next),
      );
    } else {
      const sign = Math.random() < 0.5 ? -1 : 1;
      this._omega = sign * mag;
      this._result = null;
    }
    if (
      Math.abs(this._omega) >= STOP_THRESHOLD_RAD_PER_S &&
      this._rafId === null
    ) {
      this._spinning = true;
      this._startAnim();
    }
  };

  // ── Rendering ───────────────────────────────────────────────────────

  private _draw(): void {
    const c = this.shadowRoot?.getElementById("wheel") as
      | HTMLCanvasElement
      | null;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;

    // Live size & derived geometry.
    const size = this._size;
    const center = size / 2;
    const radius = size / 2 - size * RIM_INSET_FRAC;
    const hubRadius = size * HUB_RADIUS_FRAC;

    // High-DPI: scale the backing store to size × dpr, draw in CSS px.
    const dpr = window.devicePixelRatio || 1;
    const wantPx = Math.max(1, Math.round(size * dpr));
    if (c.width !== wantPx) {
      c.width = wantPx;
      c.height = wantPx;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);

    const arcs = this._arcs();
    const n = arcs.length;
    const labels = this._expandedLabels();
    const colors = this._segmentColors();
    const labelColors = this._segmentLabelColors();
    const orientation = this._textOrientation();
    const theme = this._resolveTheme(ctx);
    const isTodoMode = this._isTodoMode();

    // Wheel body (rotated to current angle). Segment 0 is centred on the
    // 12-o'clock pointer when _angle = 0: we rotate the canvas by -π/2
    // (puts +X at 12 o'clock) then -arcs[0]/2 (centres segment 0 there).
    const a0 = arcs[0] ?? (Math.PI * 2) / n;
    ctx.save();
    ctx.translate(center, center);
    ctx.rotate(this._angle - Math.PI / 2 - a0 / 2);

    // Label font scales with wheel size; calibrated to ~14 px at 280 px wheel.
    const labelFontPx = Math.max(9, Math.round(size * 0.05));

    let cursor = 0;
    for (let i = 0; i < n; i++) {
      const arc = arcs[i] ?? 0;
      const start = cursor;
      const end = cursor + arc;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, radius, start, end);
      ctx.closePath();
      ctx.fillStyle = colors[i] ?? "#888";
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = "rgba(255,255,255,0.65)";
      ctx.stroke();

      // Tiny segments (below ~15° ≈ 4 % of wheel) suppress their label
      // since there is no readable space inside.
      if (arc > 0.26) {
        const text = labels[i] ?? "";
        const fillColor = labelColors[i] ?? "#1a1a1a";
        const midAngle = start + arc / 2;
        // Todo+radial: shift inward to widen the radial text budget. The
        // rim-side margin (radius - labelRadius) is otherwise the binding
        // constraint at the default 0.66 — at 0.55 the budget is ~35 %
        // larger, which fits noticeably more text before any shrinking
        // is needed. Tangent + non-todo modes keep the original 0.66.
        const labelRadius =
          isTodoMode && orientation === "radial"
            ? radius * 0.55
            : radius * 0.66;

        // If the label looks like an HA icon name (e.g. `mdi:home`,
        // `hass:account`), render the icon path instead of literal text.
        // While the icon is loading we render a non-committal placeholder
        // text; once cached, the next redraw shows the icon.
        if (this._looksLikeIcon(text)) {
          const path = this._getIconPath(text);
          if (typeof path === "string") {
            // ~1.5× the text font size — icons read smaller per pixel
            // than letters of the same height.
            const iconPx = Math.round(labelFontPx * 1.5);
            this._drawSegmentIcon(
              ctx,
              path,
              midAngle,
              labelRadius,
              iconPx,
              fillColor,
              orientation,
            );
          } else if (path === null) {
            // Icon name doesn't resolve in HA's registry — fall back to
            // the literal text so the user can spot a typo.
            ctx.save();
            ctx.fillStyle = fillColor;
            ctx.font = `600 ${labelFontPx}px ui-sans-serif, system-ui, sans-serif`;
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            const maxChars = Math.max(3, Math.floor((arc / 0.26) * 4));
            const display =
              text.length > maxChars
                ? text.slice(0, maxChars - 1) + "…"
                : text;
            if (orientation === "radial") {
              ctx.rotate(midAngle);
              ctx.translate(labelRadius, 0);
              ctx.rotate(Math.PI);
              ctx.fillText(display, 0, 0);
            } else {
              this._drawArchedText(ctx, display, midAngle, labelRadius);
            }
            ctx.restore();
          }
          // path === undefined → still loading; skip render this frame.
          // The async load will trigger _draw() again when ready.
          cursor += arc;
          continue;
        }

        ctx.save();
        ctx.fillStyle = fillColor;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";

        let display: string;
        if (isTodoMode) {
          // Todo summaries are arbitrary user text — measure and shrink
          // before truncating. Width budget per orientation:
          //   radial  → 2 × the smaller of (labelRadius - hubRadius) and
          //             (radius - labelRadius), with a 10 % margin.
          //   tangent → arc-length at labelRadius, with a 15 % margin.
          // Floor at MIN_TODO_FONT_PX so the text stays legible; if it
          // still overruns at that size, ellipsis-truncate to fit.
          const minPx = 7;
          const widthBudget =
            orientation === "radial"
              ? 2 *
                Math.min(labelRadius - hubRadius, radius - labelRadius) *
                0.9
              : arc * labelRadius * 0.85;
          let px = labelFontPx;
          let fits = false;
          while (px >= minPx) {
            ctx.font = `600 ${px}px ui-sans-serif, system-ui, sans-serif`;
            if (ctx.measureText(text).width <= widthBudget) {
              fits = true;
              break;
            }
            px -= 1;
          }
          if (fits) {
            display = text;
          } else {
            // Even at min size — chop characters off the tail until the
            // string + ellipsis fits the budget. Bail at 1 char so we
            // never output just "…".
            ctx.font = `600 ${minPx}px ui-sans-serif, system-ui, sans-serif`;
            let truncated = text;
            while (
              truncated.length > 1 &&
              ctx.measureText(truncated + "…").width > widthBudget
            ) {
              truncated = truncated.slice(0, -1);
            }
            display = truncated + "…";
            px = minPx;
          }
          ctx.font = `600 ${px}px ui-sans-serif, system-ui, sans-serif`;
        } else {
          // Existing static-labels behaviour: fixed font + char-count
          // truncation. Cheaper and matches user expectations from v1.0.
          ctx.font = `600 ${labelFontPx}px ui-sans-serif, system-ui, sans-serif`;
          const maxChars = Math.max(3, Math.floor((arc / 0.26) * 4));
          display =
            text.length > maxChars ? text.slice(0, maxChars - 1) + "…" : text;
        }

        if (orientation === "radial") {
          // Radial — straight text reading along the spoke.
          ctx.rotate(midAngle);
          ctx.translate(labelRadius, 0);
          ctx.rotate(Math.PI);
          ctx.fillText(display, 0, 0);
        } else {
          // Tangent — bend the text along the segment's arc so each
          // glyph is rotated to be locally tangent. Reads as a curved
          // word that follows the slice's outer edge.
          this._drawArchedText(ctx, display, midAngle, labelRadius);
        }
        ctx.restore();
      }

      cursor += arc;
    }

    // Outer ring — kept soft (the CSS drop-shadow carries the depth).
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(0, 0, 0, 0.30)";
    ctx.stroke();

    ctx.restore();

    // Centre hub (does not rotate with the wheel).
    ctx.beginPath();
    ctx.arc(center, center, hubRadius, 0, Math.PI * 2);
    const grad = ctx.createRadialGradient(
      center - hubRadius * 0.22, center - hubRadius * 0.22, 2,
      center, center, hubRadius,
    );
    grad.addColorStop(0, theme.hubLight);
    grad.addColorStop(1, theme.hubDark);
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = theme.hubStroke;
    ctx.stroke();

    // Hub text — fits inside hubRadius. Auto-shrinks for longer strings.
    const hubText = this._hubText();
    if (hubText) {
      ctx.save();
      const baseSize = Math.max(7, Math.round(size * 0.038));
      const minSize = Math.max(6, Math.round(baseSize * 0.55));
      const maxWidth = hubRadius * 1.7;
      let fontSize = baseSize;
      ctx.font = `700 ${fontSize}px ui-sans-serif, system-ui, sans-serif`;
      while (ctx.measureText(hubText).width > maxWidth && fontSize > minSize) {
        fontSize -= 1;
        ctx.font = `700 ${fontSize}px ui-sans-serif, system-ui, sans-serif`;
      }
      ctx.fillStyle = theme.hubText;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(hubText, center, center);
      ctx.restore();
    }

    // Pointer triangle, apex pointing into the wheel.
    const pHalfW = size * POINTER_HALF_WIDTH_FRAC;
    const pTop = size * POINTER_TOP_FRAC;
    const pTip = size * POINTER_TIP_FRAC;
    ctx.beginPath();
    ctx.moveTo(center, pTip);            // tip — into the wheel
    ctx.lineTo(center - pHalfW, pTop);   // top-left base corner
    ctx.lineTo(center + pHalfW, pTop);   // top-right base corner
    ctx.closePath();
    ctx.fillStyle = theme.indicatorFill;
    ctx.fill();
  }

  // Trigger a redraw when HA flips light/dark — _resolveTheme reads
  // CSS vars per-draw but nothing else schedules a paint on theme flip.
  private _prevDarkMode: boolean | undefined = undefined;
  private _prevTheme: string | undefined = undefined;

  protected override updated(changed: PropertyValues): void {
    let needsDraw =
      changed.has("config") ||
      changed.has("_result") ||
      changed.has("_todoItems");
    if (changed.has("hass") && this.hass) {
      const dark = this.hass.themes?.darkMode;
      const themeName = (this.hass.themes as { theme?: string } | undefined)
        ?.theme;
      if (dark !== this._prevDarkMode || themeName !== this._prevTheme) {
        this._prevDarkMode = dark;
        this._prevTheme = themeName;
        needsDraw = true;
      }
    }
    // Todo refetch trigger. Watch the todo entity's `state` (HA reports
    // the open-item count there) and refetch when it changes — covers
    // adds, removes, completions, undos. Also fires the first time we
    // see hass after setConfig.
    if (this.config.todo_entity) {
      const entity = this.hass?.states?.[this.config.todo_entity];
      const stateNow = entity?.state ?? null;
      if (stateNow !== this._todoLastEntityState) {
        this._todoLastEntityState = stateNow;
        if (stateNow !== null) void this._fetchTodoItems();
      }
    }
    if (needsDraw) this._draw();
  }

  protected override render(): TemplateResult {
    const lang = this._lang();
    // When the user wired a todo_entity but the list is empty (or the
    // entity hasn't reported a count yet), say so in the status line
    // instead of letting the wheel render placeholder 1..N labels
    // silently. Once items arrive the normal idle / spinning / result
    // states take over.
    const todoEmpty =
      !!this.config.todo_entity &&
      (this._todoItems === null || this._todoItems.length === 0) &&
      !this._spinning &&
      this._result === null;
    const status = this._spinning
      ? localize("status.spinning", lang)
      : this._result !== null
        ? localize("status.result", lang, { value: this._result })
        : todoEmpty
          ? localize("status.todo_empty", lang)
          : localize("status.idle", lang);
    // Empty / whitespace-only `name` hides the header entirely
    // (ha-card's `.header` falsy-check skips the slot). `undefined` is
    // *also* falsy, so the previous localized-default fallback was
    // dropped on purpose — fresh-installed cards now show a clean
    // wheel without a "Spinning Wheel" title until the user opts in.
    const header = this.config.name?.trim()
      ? this.config.name
      : undefined;

    return html`
      <ha-card .header=${header}>
        <div class="card-content">
          <div class="wheel-wrap">
            <canvas
              id="wheel"
              width=${DEFAULT_SIZE}
              height=${DEFAULT_SIZE}
              role="img"
              tabindex="0"
              aria-label=${localize("status.idle", lang)}
              @pointerdown=${this._onPointerDown}
              @pointermove=${this._onPointerMove}
              @pointerup=${this._onPointerUp}
              @keydown=${this._onKeyDown}
              @pointercancel=${this._onPointerCancel}
            ></canvas>
          </div>
          ${this.config.show_status === false
            ? nothing
            : html`<div class="status" aria-live="polite">${status}</div>`}
        </div>
      </ha-card>
    `;
  }

  static override styles: CSSResultGroup = css`
    /* Section-view grid cells are fixed-size containers; the height
       has to flow through :host → ha-card → card-content → wheel-wrap
       so the canvas can size to the smaller of width / height. Without
       this cascade, ha-card would collapse to its natural content
       height and the row-drag handle in the dashboard editor binds to
       nothing. */
    :host {
      display: block;
      color-scheme: light dark;
      height: 100%;
    }
    ha-card {
      overflow: hidden;
      height: 100%;
      display: flex;
      flex-direction: column;
    }
    .card-content {
      padding: var(--ha-space-4, 16px);
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: var(--ha-space-2, 8px);
      flex: 1 1 auto;
      min-height: 0;
      box-sizing: border-box;
    }
    /* Centred flex container the canvas grows into. The actual
       width/height values are written inline by the ResizeObserver
       in firstUpdated(), based on min(wrap-width, wrap-height) with
       a width-only fallback for indefinite-block-size hosts (masonry
       view, vertical-stack-card, …). Container queries were tried
       earlier but min(100cqi, 100cqb) collapsed to invalid on
       surfaces that didn't propagate a definite block-size, which
       reported as "width is NaN on default" — JS sizing avoids the
       edge case entirely. */
    .wheel-wrap {
      flex: 1 1 auto;
      min-height: 0;
      min-width: 0;
      width: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    #wheel {
      display: block;
      max-width: 600px;
      max-height: 600px;
      touch-action: none;        /* let our pointer handler own gestures */
      cursor: grab;
      user-select: none;
      filter: drop-shadow(0 6px 14px rgba(0, 0, 0, 0.25));
    }
    #wheel:active {
      cursor: grabbing;
    }
    /* Keyboard focus ring on the canvas — Space/Enter triggers a spin
       via the keydown handler, so the canvas needs to be a real focus
       target. WCAG 2.4.7 AA. */
    #wheel:focus-visible {
      outline: 2px solid var(--primary-color);
      outline-offset: 2px;
      border-radius: 6px;
    }
    .status {
      font-size: 0.875rem;
      font-variant-numeric: tabular-nums;
      color: var(--secondary-text-color);
      min-height: 1.4em;
      flex-shrink: 0;
    }

    /* ── Accessibility primitives ────────────────────────────────────
       Forced-colors fallback (Windows High Contrast). */
    @media (forced-colors: active) {
      #wheel:focus-visible {
        outline-color: CanvasText;
      }
    }
    /* Honour user motion preference. The RAF loop itself short-circuits
       in _startAnim when this matches; the catch-all below covers any
       transition we add later (e.g. hover scale, focus ring transitions)
       so they don't bypass the user's choice. */
    @media (prefers-reduced-motion: reduce) {
      #wheel {
        filter: none;
      }
      *,
      *::before,
      *::after {
        animation-duration: 0.01ms !important;
        animation-iteration-count: 1 !important;
        transition-duration: 0.01ms !important;
        scroll-behavior: auto !important;
      }
    }
  `;
}
