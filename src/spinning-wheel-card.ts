import { LitElement, html, css, nothing } from "lit";
import type { TemplateResult, PropertyValues, CSSResultGroup } from "lit";
import { property, state } from "lit/decorators.js";

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

// Idempotent — bundle may re-import (HACS + manual /local both
// registered, dev-push iteration). Without the guard the picker grows
// a duplicate row per load.
const _w = window as unknown as WindowWithCustomCards;
_w.customCards ??= [];
if (!_w.customCards.some((c) => c.type === "spinning-wheel-card")) {
  _w.customCards.push({
    type: "spinning-wheel-card",
    name: localize("picker.name", initialLang),
    description: localize("picker.description", initialLang),
    preview: true,
    documentationURL: "https://github.com/rolandzeiner/spinning-wheel-card",
  });
}

const DEFAULT_SIZE = 280;
const MIN_SIZE = 140;
const MAX_SIZE = 600;
// Geometry as fractions of size, calibrated against 280 px.
const HUB_RADIUS_FRAC = 18 / DEFAULT_SIZE;
const POINTER_HALF_WIDTH_FRAC = 12 / DEFAULT_SIZE;
const POINTER_TOP_FRAC = 2 / DEFAULT_SIZE;
const POINTER_TIP_FRAC = 22 / DEFAULT_SIZE;
const RIM_INSET_FRAC = 6 / DEFAULT_SIZE;
const HALF_BOTTOM_PAD_FRAC = 4 / DEFAULT_SIZE;
/** Canvas height / wheel-diameter ratio in half-circle mode. ≈ 0.578.
 *  Wheel centre at y=size/2, hub on cut line with lower semicircle as a
 *  "dial nub" + HALF_BOTTOM_PAD_FRAC breathing room. */
const HALF_ASPECT = 0.5 + HUB_RADIUS_FRAC + HALF_BOTTOM_PAD_FRAC;

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

/** Wrap to [0, 2π). `%` on multi-billion-radian doubles drifts. */
const wrapAngle = (a: number): number => ((a % TWO_PI) + TWO_PI) % TWO_PI;

const TICK_RATE_LIMIT_MS = 30;      // ≈33 Hz tick ceiling
const TICK_PEAK_SPEED = 12;         // rad/s where ticks are loudest
const TICK_HIGH_SPEED_FLOOR = 0.3;  // intensity floor at MAX_VELOCITY

/** Static velocity decrement on each segment-under-pointer change when
 *  `pegs: true`. Sized so an 8-peg wheel at 40 rad/s loses ~1.4 rad/s
 *  per revolution from pegs alone — meaningful but never stuttery —
 *  while at low speed each click meaningfully chips away ("click click
 *  click stop" settling feel). Capped at zero so it can't reverse the
 *  spin direction. Independent of the continuous friction multiplier;
 *  both compose. */
const PEG_DRAG_RAD_PER_S = 0.18;

/** Peg centre placement as a fraction of the wheel `radius` (the outer
 *  edge of the slice fills). 1.0 sits the peg exactly on the rim;
 *  smaller pulls it inward. 0.96 nudges them visibly into the disc
 *  while still clearly belonging to the rim band. */
const PEG_RADIUS_FRAC = 0.96;

/** Drag-vs-click threshold (~3 px on a 280 px wheel). */
const DRAG_COMMIT_RAD = 0.04;

interface VelocitySample {
  t: number;        // performance.now()
  angleDelta: number;
}

export class SpinningWheelCard extends LitElement {
  public static getConfigElement(): LovelaceCardEditor {
    return document.createElement(
      "spinning-wheel-card-editor",
    ) as LovelaceCardEditor;
  }

  public static getStubConfig(): Record<string, unknown> {
    // Omit `name` — render() falls back to localised default so the
    // header tracks the user's language without baking a string into YAML.
    return { segments: 8, friction: "medium" };
  }

  @property({ attribute: false }) public hass!: HomeAssistant;

  @state() private config: SpinningWheelCardConfig = {
    type: "spinning-wheel-card",
  };

  @state() private _result: string | null = null;
  @state() private _spinning = false;

  // 0 = first segment's leading edge at 12 o'clock (the draw rotates
  // by -π/2 so segment 0 is at the top initially).
  private _angle = 0;
  // Angular velocity, rad/s. Positive = clockwise.
  private _omega = 0;

  private _dragging = false;
  private _dragMoved = false;
  private _dragLastAngle = 0;
  private _velocitySamples: VelocitySample[] = [];

  private _rafId: number | null = null;
  private _lastFrameMs = 0;

  // Canvas CSS size. Backing store = this × devicePixelRatio in _draw.
  private _size = DEFAULT_SIZE;
  private _resizeObserver: ResizeObserver | null = null;

  // null = not yet fetched (or no todo_entity); [] = fetched, empty.
  @state() private _todoItems: ReadonlyArray<TodoItem> | null = null;
  // Cached so we don't callWS on every unrelated hass tick.
  private _todoLastEntityState: string | null = null;
  // Debounce burst hass updates (theme + state on the same tick).
  private _todoLoading = false;

  public setConfig(config: SpinningWheelCardConfig): void {
    // Prefer incoming language so an edit that flips language AND adds
    // an error reports the error in the new language.
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
          // Empty strings tolerated; non-empty must be `script.<name>`.
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
    if (
      config.half_circle !== undefined &&
      typeof config.half_circle !== "boolean"
    ) {
      throw new Error(localize("errors.half_circle_type", lang));
    }
    if (
      config.selector_mode !== undefined &&
      typeof config.selector_mode !== "boolean"
    ) {
      throw new Error(localize("errors.selector_mode_type", lang));
    }
    if (config.pegs !== undefined && typeof config.pegs !== "boolean") {
      throw new Error(localize("errors.pegs_type", lang));
    }
    if (config.peg_density !== undefined) {
      if (
        typeof config.peg_density !== "number" ||
        !Number.isInteger(config.peg_density) ||
        config.peg_density < 0 ||
        config.peg_density > 4
      ) {
        throw new Error(localize("errors.peg_density_range", lang));
      }
    }
    if (config.result_entity !== undefined) {
      if (typeof config.result_entity !== "string") {
        throw new Error(localize("errors.result_entity_type", lang));
      }
      if (
        config.result_entity !== "" &&
        !/^input_text\.[a-z0-9_]+$/.test(config.result_entity)
      ) {
        throw new Error(localize("errors.result_entity_invalid", lang));
      }
    }
    // Drop stale items on todo_entity swap so they don't render briefly
    // before the next state change triggers a refetch.
    const prevTodo = this.config.todo_entity ?? null;
    const nextTodo = config.todo_entity ?? null;
    if (prevTodo !== nextTodo) {
      this._todoItems = null;
      this._todoLastEntityState = null;
    }
    // Pegs toggle and density slider both change the tick index space
    // ((density+1)*N intervals when on, N segments when off). Reset the
    // baseline so the next crossing detection re-seeds in the new
    // scale instead of comparing across scales (would fire a spurious
    // click on the next frame).
    const prevPegsOn = this.config.pegs ?? false;
    const nextPegsOn = config.pegs ?? false;
    const prevDensity = this.config.peg_density ?? 1;
    const nextDensity = config.peg_density ?? 1;
    if (prevPegsOn !== nextPegsOn || prevDensity !== nextDensity) {
      this._lastTickSeg = -1;
    }
    this.config = { ...config };
    this._result = null;
  }

  /** Per-card `language` override wins over HA auto-detect. */
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
    // Long todo summaries read better along the spoke than wrapped on
    // the rim — default radial when filled from a todo list.
    if (this._isTodoMode()) return "radial";
    return "tangent";
  }

  /** Todo mode = entity wired AND ≥1 open items being rendered. */
  private _isTodoMode(): boolean {
    return this._todoLabels() !== null;
  }

  public getCardSize(): number {
    // Masonry: 1 unit ≈ 50 px. Dome ≈ 0.58 × square — surface that so
    // masonry doesn't reserve a square cell for a half-tall card.
    return this._isHalfMode() ? 4 : 6;
  }

  /** Mirrors HA's `LovelaceGridOptions`. `max_columns` is `number`
   *  only — only `columns` accepts the `"full"` sentinel.
   *  Concrete numeric defaults match hui-clock-card (the prior
   *  `rows: "auto"` collapsed ha-card and broke the vertical-resize
   *  drag handle — ha-lovelace-card SKILL § Vertical resize). No
   *  `max_*` caps: canvas clamps internally at MAX_SIZE. */
  public getGridOptions(): {
    columns?: number | "full";
    rows?: number | "auto";
    min_columns?: number;
    min_rows?: number;
    max_columns?: number;
    max_rows?: number;
  } {
    if (this._isHalfMode()) {
      // Dome aspect ≈ 0.58, so for cols=6 (~180 px) the dome wants
      // ~104 px canvas + 32 px padding + 8 px gap + 22 px status =
      // ~166 px total. rows:3 (~176 px @ 56 px/row + gaps) fits with
      // a little slack; rows:4 left visible empty space.
      return {
        columns: 6,
        rows: 3,
        min_columns: 4,
        min_rows: 2,
      };
    }
    return {
      columns: 6,
      rows: 6,
      min_columns: 4,
      min_rows: 4,
    };
  }

  /** Open-item summaries, or null when no todo_entity / not yet
   *  fetched / list is empty (callers fall through to static labels). */
  private _todoLabels(): ReadonlyArray<string> | null {
    if (!this.config.todo_entity) return null;
    if (!this._todoItems || this._todoItems.length === 0) return null;
    return this._todoItems.map((i) => i.summary);
  }

  private _segments(): number {
    const todo = this._todoLabels();
    if (todo) {
      // Clamp to 4..24; < 4 items still render via label cycling.
      return Math.max(4, Math.min(24, todo.length));
    }
    return this.config.segments ?? 8;
  }
  private _frictionFactor(): number {
    return FRICTION[this.config.friction ?? "medium"];
  }
  /** Labels expanded to length = segments; cycles short arrays;
   *  defaults to "1".."N". */
  private _expandedLabels(): ReadonlyArray<string> {
    const n = this._segments();
    // Todo wins over static labels when both are set.
    const todo = this._todoLabels();
    const src = todo ?? this.config.labels;
    if (!src || src.length === 0) {
      return Array.from({ length: n }, (_, i) => String(i + 1));
    }
    return Array.from({ length: n }, (_, i) => src[i % src.length] ?? "");
  }

  /** Fetch open todo items via `todo/item/list`. Dedups by summary —
   *  the same-label-same-colour rule would otherwise collapse two
   *  segments visually. */
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
  private _themePalette(): ReadonlyArray<string> {
    return THEME_PALETTES[this.config.theme ?? "default"];
  }

  /** Per-segment fill colour. Walks labels in order; each new unique
   *  label takes the next palette colour, so segments sharing a label
   *  always share a colour. Palette cycles for >palette.length uniques. */
  private _segmentColors(): ReadonlyArray<string> {
    return this._mapPaletteToLabels(this.config.colors, this._themePalette());
  }

  /** Per-segment label-text colour. Same unique-label rule as
   *  `_segmentColors`; defaults to dark grey for every segment. */
  private _segmentLabelColors(): ReadonlyArray<string> {
    return this._mapPaletteToLabels(this.config.label_colors, [
      DEFAULT_LABEL_COLOR,
    ]);
  }

  /** Palette cycled across unique labels in order of first appearance;
   *  falls back to `defaults` when the user palette is empty. */
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

  /** Per-segment ActionConfig. Same-label-same-action mapping mirrors
   *  the colours rule — the spin result is the label, not the index. */
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

  /** `script.<name>` shorthand → `perform-action`; any other string
   *  or null → null. Object entries pass through (setConfig validated). */
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

  /** Short label for the confirmation prompt. */
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

  /** `disable_confirm_actions: true` skips the prompt; per-action
   *  `confirmation: false` opts a single action out. Falls through to
   *  `window.confirm` — dep-free, blocking. */
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

  /** Hand-rolled Lovelace ActionConfig dispatcher (avoids the
   *  `custom-card-helpers` dep). Accepts both `call-service` /
   *  `service` and the modern `perform-action` / `perform_action`. */
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
        // HA's frontend listens for this on `window` — same event
        // hui-* cards dispatch.
        window.dispatchEvent(
          new CustomEvent("location-changed", {
            detail: { replace: cfg.navigation_replace ?? false },
            bubbles: true,
            composed: true,
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
        // Same CustomEvent HA's own action handler dispatches.
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

  /** Arc widths in radians, summing to 2π. Honours `weights`. */
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
    // Seed from layout if resolved; observer's first delivery fixes
    // it within a frame either way.
    const rect = wrap.getBoundingClientRect();
    if (rect.width > 0 || rect.height > 0) {
      this._size = this._clampSize(this._fitDim(rect.width, rect.height));
      this._applyCanvasSize();
    }
    this._resizeObserver = new ResizeObserver((entries) => {
      // Entries deliver on a microtask; a recent `disconnect()` does
      // not unqueue them — bail when detached.
      if (!this.isConnected) return;
      for (const e of entries) {
        const next = this._clampSize(
          this._fitDim(e.contentRect.width, e.contentRect.height),
        );
        // Tolerance avoids redraws on sub-pixel jitter.
        if (Math.abs(next - this._size) >= 1) {
          this._size = next;
          this._applyCanvasSize();
          this._draw();
        }
      }
    });
    // Observe the wrap, not the canvas — observing the canvas would
    // create a no-op feedback loop (we drive its CSS box ourselves).
    this._resizeObserver.observe(wrap);
    this._draw();
  }

  /** Effective diameter from a container box. Square mode: min(w, h).
   *  Half mode: min(w, h / HALF_ASPECT). Width-only fallback when
   *  height is 0 / NaN — masonry, vertical-stack-card, and other
   *  surfaces don't propagate a definite block-size, and without it
   *  the canvas snaps to MIN_SIZE forever ("width is NaN on default"). */
  private _fitDim(w: number, h: number): number {
    const wOk = Number.isFinite(w) && w > 0;
    const hOk = Number.isFinite(h) && h > 0;
    const aspect = this._isHalfMode() ? HALF_ASPECT : 1;
    if (wOk && hOk) return Math.min(w, h / aspect);
    if (wOk) return w;
    if (hOk) return h / aspect;
    return DEFAULT_SIZE;
  }

  private _isHalfMode(): boolean {
    return this.config.half_circle === true;
  }

  private _isSelectorMode(): boolean {
    return this.config.selector_mode === true;
  }

  private _pegsEnabled(): boolean {
    return this.config.pegs === true;
  }

  /** Nudge `_angle` so the indicator clears any peg by ~1.5× the
   *  peg's angular half-width. No-op when pegs are off, when no peg is
   *  within the deadzone, or when the resulting angle would push the
   *  indicator into a different segment (i.e., the result decision is
   *  always preserved). Direction follows whichever side the indicator
   *  was already on. Called from every wheel-stop branch in pegs mode
   *  so a "stops on a peg" landing always resolves to a clear result. */
  private _nudgeOffPeg(): void {
    if (!this._pegsEnabled()) return;
    const arcs = this._arcs();
    const n = arcs.length;
    if (n === 0) return;
    const a0 = arcs[0] ?? TWO_PI / n;
    const target = wrapAngle(-this._angle + a0 / 2);
    const k = this._pegsPerSegment();
    const radius = this._size / 2 - this._size * RIM_INSET_FRAC;
    const pegPx = Math.max(2, (this._size * 3) / DEFAULT_SIZE);
    // 1.5 × angular half-width — clears the peg's pixel footprint
    // with a small breathing buffer. Scales with wheel size since
    // pegPx scales with size.
    const deadzone = (pegPx / Math.max(1, radius)) * 1.5;

    let nearestSigned = 0;
    let nearestAbs = Infinity;
    let nearestAngle = 0;
    let cursor = 0;
    for (let i = 0; i < n; i++) {
      const arc = arcs[i] ?? 0;
      if (arc <= 0) {
        cursor += arc;
        continue;
      }
      const slice = arc / k;
      for (let j = 0; j < k; j++) {
        const pegAngle = cursor + slice * j;
        let d = target - pegAngle;
        if (d > Math.PI) d -= TWO_PI;
        else if (d <= -Math.PI) d += TWO_PI;
        const ad = Math.abs(d);
        if (ad < nearestAbs) {
          nearestAbs = ad;
          nearestSigned = d;
          nearestAngle = pegAngle;
        }
      }
      cursor += arc;
    }

    if (nearestAbs >= deadzone) return;
    // Push away from the peg in the direction the indicator was
    // naturally on. Tie (signed === 0) goes positive — arbitrary but
    // consistent.
    const sign = nearestSigned >= 0 ? 1 : -1;
    const newTarget = wrapAngle(nearestAngle + sign * deadzone);
    this._angle = wrapAngle(a0 / 2 - newTarget);
  }

  /** Pegs per segment when `pegs` is on: 1 boundary + N mid pegs. The
   *  mid count is the `peg_density` slider (0–4, default 1). Returns 1
   *  when pegs are off (callers gate on `_pegsEnabled` first; this is
   *  defensive). */
  private _pegsPerSegment(): number {
    if (!this._pegsEnabled()) return 1;
    const d = this.config.peg_density;
    const density = typeof d === "number" && Number.isInteger(d) && d >= 0 && d <= 4 ? d : 1;
    return density + 1;
  }

  private _canvasCssHeight(): number {
    return this._isHalfMode()
      ? Math.round(this._size * HALF_ASPECT)
      : this._size;
  }

  /** Inline width/height keeps the next ResizeObserver delivery stable
   *  (CSS-driven sizing re-fires spuriously). */
  private _applyCanvasSize(): void {
    const c = this.shadowRoot?.getElementById("wheel") as
      | HTMLCanvasElement
      | null;
    if (!c) return;
    c.style.width = `${this._size}px`;
    c.style.height = `${this._canvasCssHeight()}px`;
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
    // Reset drag state — a card moved across tabs mid-drag never sees
    // pointerup/cancel, leaving `_dragging` true and a stale lastAngle
    // for the next pointermove on reconnect.
    this._dragging = false;
    this._dragMoved = false;
    this._dragAccumulated = 0;
    this._velocitySamples = [];
    this._lastTickSeg = -1;
    // HA may re-register icon sources between mounts.
    this._iconCache.clear();
    this._iconLoading.clear();
  }

  private _clampSize(w: number): number {
    return Math.max(MIN_SIZE, Math.min(MAX_SIZE, Math.round(w)));
  }

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
      // Subtle gradient (dark grey highlight → black edge) so the hub
      // reads as a button rather than a flat disc.
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

    // Theme accent — indicator + hub use --primary-color; hub label
    // auto-picks black/white via WCAG luminance.
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

  /** CSS colour → [r, g, b] via the canvas fillStyle round-trip. */
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

  /** Tint toward white (positive delta) or black (negative). */
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

  /** Text along an arc of radius R, centred on midAngle. Each glyph
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

  // Icon labels (`mdi:foo`, `hass:foo`) borrow the SVG path from a
  // hidden ha-icon at runtime — no @mdi/js bundle.

  /** path | null (missing) | undefined (not yet looked up). */
  private _iconCache = new Map<string, string | null>();
  /** Prevents N redundant DOM queries per redraw. */
  private _iconLoading = new Set<string>();

  /** Matches `mdi:foo` / `hass:foo` / any namespaced HA icon ref. */
  private _looksLikeIcon(label: string): boolean {
    return /^[a-z][a-z0-9_-]*:[a-z0-9-]+$/i.test(label);
  }

  /** Path when ready, null when missing, undefined while loading. */
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
    try {
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
        // Modern ha-svg-icon.path → its shadow <path> → ha-icon's own
        // <path> (legacy iron-icon flow).
        path =
          svgIcon?.path ??
          svgIcon?.shadowRoot?.querySelector("path")?.getAttribute("d") ??
          probe.shadowRoot?.querySelector("path")?.getAttribute("d") ??
          null;
        if (!path) {
          await new Promise<void>((r) => requestAnimationFrame(() => r()));
        }
      }
      this._iconCache.set(name, path);
    } catch {
      this._iconCache.set(name, null);
    } finally {
      // Always remove — a thrown poll iteration leaks the offscreen
      // probe into document.body.
      probe.remove();
      this._iconLoading.delete(name);
      if (this.isConnected) this._draw();
    }
  }

  /** 24×24 MDI path scaled to iconPx, rotated like the text path. */
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
    // π/2 tangent, π radial — matches text orientation so icons and
    // text labels line up in mixed-content wheels.
    ctx.rotate(orientation === "radial" ? Math.PI : Math.PI / 2);
    const scale = iconPx / 24;
    ctx.scale(scale, scale);
    ctx.translate(-12, -12);
    ctx.fillStyle = fillColor;
    ctx.fill(new Path2D(pathStr));
    ctx.restore();
  }

  /** WCAG relative luminance (sRGB) — drives hub text black/white pick. */
  private _isLight([r, g, b]: [number, number, number]): boolean {
    const lin = (c: number): number => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    return L > 0.5;
  }

  private _startAnim(): void {
    if (this._rafId !== null) return;
    // WCAG 2.3.3 — skip the multi-second decay when reduced motion is
    // requested. Still apply 1.5 s of decay so the result isn't trivially
    // the impulse-application angle.
    if (
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    ) {
      this._angle = wrapAngle(this._angle + this._omega * 1.5);
      this._omega = 0;
      this._spinning = false;
      this._lastTickSeg = -1;
      this._nudgeOffPeg();
      this._announceResult();
      this._draw();
      return;
    }
    this._lastFrameMs = performance.now();
    // Baseline — so the first frame doesn't tick spuriously. Match the
    // index space `_onSegmentCrossing` will use (2N peg intervals when
    // pegs on, N segment intervals otherwise).
    this._lastTickSeg = this._pegsEnabled()
      ? this._pegIntervalIndex()
      : this._segmentIndexUnderPointer();
    const tick = (now: number): void => {
      const dt = Math.min(0.05, (now - this._lastFrameMs) / 1000);
      this._lastFrameMs = now;

      this._angle = wrapAngle(this._angle + this._omega * dt);
      // Frame-rate-independent decay: at 60 fps, dt≈1/60, exponent≈1.
      this._omega *= Math.pow(this._frictionFactor(), 60 * dt);

      // Bell curve — ramp 0 → peak by TICK_PEAK_SPEED, taper to FLOOR
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
      this._onSegmentCrossing(intensity);

      this._draw();

      if (Math.abs(this._omega) < STOP_THRESHOLD_RAD_PER_S) {
        this._omega = 0;
        this._spinning = false;
        this._rafId = null;
        this._lastTickSeg = -1;
        this._nudgeOffPeg();
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

  /** Rotate so the segment under the pointer lands centred at 12. Pure
   *  setter on `_angle` — caller owns redraw + announce. */
  private _snapToSegmentUnderPointer(): void {
    const arcs = this._arcs();
    if (arcs.length === 0) return;
    const idx = this._segmentIndexUnderPointer();
    let cumStart = 0;
    for (let i = 0; i < idx; i++) cumStart += arcs[i] ?? 0;
    const arc = arcs[idx] ?? 0;
    const a0 = arcs[0] ?? TWO_PI / arcs.length;
    // Inverse of `_segmentIndexUnderPointer`: that function reads the
    // segment whose local-frame range contains `target = -angle + a0/2`.
    // To centre segment idx we want `target = cumStart + arc/2`, i.e.
    // `angle = a0/2 - target`.
    this._angle = wrapAngle(a0 / 2 - cumStart - arc / 2);
  }

  /** Segment under the 12-o'clock pointer. Walks cumulative arcs until
   *  the running sum exceeds the pointer angle. */
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

  /** Index of the peg interval under the indicator, 0..(K*N - 1) where
   *  K = `_pegsPerSegment()`. Used by the audio + drag path when
   *  `pegs: true` so every visible peg (boundary + each mid) fires its
   *  own click and brake bump. */
  private _pegIntervalIndex(): number {
    const arcs = this._arcs();
    const n = arcs.length;
    if (n === 0) return 0;
    const k = this._pegsPerSegment();
    const a0 = arcs[0] ?? TWO_PI / n;
    const target = wrapAngle(-this._angle + a0 / 2);
    let cursor = 0;
    let pegIdx = 0;
    for (let i = 0; i < n; i++) {
      const arc = arcs[i] ?? 0;
      const slice = arc / k;
      for (let j = 1; j <= k; j++) {
        if (target < cursor + slice * j) return pegIdx;
        pegIdx++;
      }
      cursor += arc;
    }
    return k * n - 1;
  }

  private _announceResult(): void {
    const labels = this._expandedLabels();
    const idx = this._segmentIndexUnderPointer();
    this._result = labels[idx] ?? null;
    // Write to result_entity BEFORE the action — automations triggered
    // on the entity state-change should see the new value by the time
    // they run. Fire-and-forget; a deleted helper mustn't break the chain.
    void this._writeResultToEntity(this._result);
    // window.confirm blocks the await, so a held click during the
    // prompt can't double-fire.
    const actions = this._segmentActions();
    const action = actions[idx];
    if (action) void this._dispatchAction(action);
  }

  /** Write the winning label to `result_entity`. Truncates to 255
   *  chars (HA's MAX_LENGTH_STATE_STATE — longer todo summaries would
   *  otherwise be rejected by the input_text guard). */
  private async _writeResultToEntity(
    result: string | null,
  ): Promise<void> {
    if (!result) return;
    const entity = this.config.result_entity;
    if (!entity) return;
    if (!this.hass?.callService) return;
    const value = result.length > 255 ? result.slice(0, 255) : result;
    try {
      await this.hass.callService("input_text", "set_value", {
        entity_id: entity,
        value,
      });
      // Diagnostic for "the spin doesn't update my helper" — cheap,
      // quiet for users who never open DevTools.
      console.info(
        `[spinning-wheel-card] result written: ${entity} = ${JSON.stringify(value)}`,
      );
    } catch (err) {
      console.warn(
        "[spinning-wheel-card] input_text.set_value failed:",
        err,
      );
    }
  }

  private _audioCtx: AudioContext | null = null;
  /** True once `ctx.resume()` has resolved. _playTick bails until then
   *  to avoid scheduling against a stale `currentTime` on a still-
   *  suspended context (Safari race). */
  private _audioReady = false;
  /** -1 = no baseline yet. */
  private _lastTickSeg = -1;
  private _lastTickMs = 0;

  private _ensureAudio(): AudioContext | null {
    if (this._audioCtx) return this._audioCtx;
    if (typeof window.AudioContext === "undefined") return null;
    try {
      this._audioCtx = new AudioContext();
      // Safari (and gesture-less Chromium) returns a pending promise
      // here; flip _audioReady when it resolves.
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
    const I = Math.max(0, Math.min(1, intensity));
    const dur = 0.025 + 0.015 * I; // 25..40 ms

    // Quadratic decay envelope on a noise burst — rounder back-end
    // than exponential.
    const sampleRate = ctx.sampleRate;
    const samples = Math.max(1, Math.floor(sampleRate * dur));
    const buf = ctx.createBuffer(1, samples, sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < samples; i++) {
      const x = i / samples;
      const env = (1 - x) * (1 - x);
      data[i] = (Math.random() * 2 - 1) * env;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;

    // Bandpass at 1700 Hz Q=3 → less "ping", more "tok".
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 1700;
    bp.Q.value = 3;

    // Lowpass takes the ice-pick edge off.
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 4000;
    lp.Q.value = 0.7;

    // 2 ms attack ramp — without it the click starts on a sample-zero
    // cliff, which is most of what makes a synthetic click sound hard.
    const gainNode = ctx.createGain();
    const peak = 0.03 + 0.13 * I;
    gainNode.gain.setValueAtTime(0, t0);
    gainNode.gain.linearRampToValueAtTime(peak, t0 + 0.002);
    gainNode.gain.exponentialRampToValueAtTime(0.001, t0 + dur);

    src.connect(bp).connect(lp).connect(gainNode).connect(ctx.destination);
    src.start(t0);
    src.stop(t0 + dur + 0.01);
  }

  /** Detect a peg or segment crossing and react: fire the audio click
   *  (rate-limited to TICK_RATE_LIMIT_MS, gated on `sound`) and / or
   *  apply the per-peg drag (gated on `pegs`). When `pegs: true` the
   *  detector runs at 2N peg intervals so every visible peg (boundary
   *  AND mid-segment) fires; otherwise it runs at N segment intervals
   *  (the original v1.0 audio cadence). Detection runs unconditionally
   *  so a `sound: false` + `pegs: true` user still gets the brake on
   *  each peg. The cursor advances even when audio is rate-limited so
   *  the next crossing isn't spurious. */
  private _onSegmentCrossing(intensity: number): void {
    const audioOn = this._soundEnabled();
    const pegsOn = this._pegsEnabled();
    if (!audioOn && !pegsOn) {
      this._lastTickSeg = -1;
      return;
    }
    const cur = pegsOn
      ? this._pegIntervalIndex()
      : this._segmentIndexUnderPointer();
    if (this._lastTickSeg === -1) {
      this._lastTickSeg = cur;
      return;
    }
    if (cur === this._lastTickSeg) return;
    if (audioOn) {
      const now = performance.now();
      if (now - this._lastTickMs >= TICK_RATE_LIMIT_MS) {
        this._playTick(intensity);
        this._lastTickMs = now;
      }
    }
    if (pegsOn) {
      // Brake bump opposite to current motion. Capped at zero so
      // an at-rest wheel doesn't reverse direction on residual ω.
      const sign = this._omega >= 0 ? 1 : -1;
      const next = this._omega - sign * PEG_DRAG_RAD_PER_S;
      this._omega =
        Math.sign(next) === sign || next === 0 ? next : 0;
    }
    this._lastTickSeg = cur;
  }

  private _wheelRect(): DOMRect | null {
    const c = this.shadowRoot?.getElementById("wheel") as
      | HTMLCanvasElement
      | null;
    return c?.getBoundingClientRect() ?? null;
  }

  // Client (x, y) → angle from canvas centre. 0 = +X axis, CCW.
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
    // Don't zero omega — we don't yet know if this is click or drag.
    // Click-during-spin should boost; only a drag past DRAG_COMMIT_RAD
    // commandeers (handled in pointermove).
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
      // _lastTickSeg and reseeding would race the next tick. Same
      // index-space split as `_onSegmentCrossing` (peg intervals when
      // pegs on, segment intervals otherwise).
      if (this._rafId === null) {
        this._lastTickSeg = this._pegsEnabled()
          ? this._pegIntervalIndex()
          : this._segmentIndexUnderPointer();
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
    // Normalise to (-π, π] for the atan2 wrap.
    if (delta > Math.PI) delta -= Math.PI * 2;
    else if (delta < -Math.PI) delta += Math.PI * 2;

    // Sub-threshold wobble during a click must not take the wheel over.
    this._dragAccumulated += Math.abs(delta);
    if (!this._dragMoved && this._dragAccumulated > DRAG_COMMIT_RAD) {
      this._dragMoved = true;
      this._omega = 0;
      this._stopAnim();
      this._result = null;
    }
    this._dragLastAngle = a;

    if (!this._dragMoved) {
      // Sub-threshold — lastAngle was updated above so the next delta
      // starts from the current position.
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

    this._onSegmentCrossing(Math.min(1, Math.abs(delta) * 6));
    this._draw();
  };

  private _onPointerUp = (ev: PointerEvent): void => {
    if (!this._dragging) return;
    this._dragging = false;
    (ev.currentTarget as Element).releasePointerCapture?.(ev.pointerId);

    const isSelector = this._isSelectorMode();

    if (!this._dragMoved) {
      // Click without drag.
      if (isSelector) {
        // No-op — selector mode treats bare clicks as ambiguous
        // ("where on the wheel did you click?"). Drag picks; Space /
        // Enter re-fires the current selection.
      } else {
        const wasSpinning =
          Math.abs(this._omega) >= STOP_THRESHOLD_RAD_PER_S;
        if (wasSpinning && this.config.disable_boost === true) {
          // disable_boost: ignore clicks during motion (drag-to-throw
          // is a different path and unaffected).
        } else {
          const mag =
            CLICK_IMPULSE_MIN +
            Math.random() * (CLICK_IMPULSE_MAX - CLICK_IMPULSE_MIN);
          if (wasSpinning) {
            // Boost in the wheel's current direction; cap at MAX_VELOCITY
            // so repeated clicks don't compound past the upper bound.
            const sign = this._omega >= 0 ? 1 : -1;
            const next = this._omega + sign * mag;
            this._omega = Math.max(
              -MAX_VELOCITY_RAD_PER_S,
              Math.min(MAX_VELOCITY_RAD_PER_S, next),
            );
          } else {
            // Fresh start — random direction.
            const sign = Math.random() < 0.5 ? -1 : 1;
            this._omega = sign * mag;
            this._result = null;
          }
        }
      }
    } else if (isSelector) {
      // Selector drag release — snap to centre and announce. No
      // momentum sampling, no RAF loop.
      this._snapToSegmentUnderPointer();
      this._omega = 0;
      this._spinning = false;
      this._lastTickSeg = -1;
      this._velocitySamples = [];
      this._dragAccumulated = 0;
      this._announceResult();
      this._draw();
      return;
    } else {
      // Sample-window-averaged angular velocity → ω.
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

    if (
      Math.abs(this._omega) >= STOP_THRESHOLD_RAD_PER_S &&
      this._rafId === null
    ) {
      this._spinning = true;
      this._startAnim();
    } else if (this._rafId === null) {
      // Drag-to-stop: _stopAnim ran on drag-commit but _spinning is
      // still true. Snap to rest so the status line doesn't stay
      // stuck on "Spinning…".
      this._omega = 0;
      this._spinning = false;
      this._lastTickSeg = -1;
      this._nudgeOffPeg();
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

  /** Keyboard equivalent for click-to-spin. WCAG 2.1.1. */
  private _onKeyDown = (ev: KeyboardEvent): void => {
    if (ev.key !== " " && ev.key !== "Enter") return;
    ev.preventDefault();
    // Warm audio on first user gesture (same pathway as pointerdown).
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
    if (this._isSelectorMode()) {
      // Re-fire the existing selection. Gated on `_result !== null`
      // so Tab+Space on a fresh card can't fire segment 0 unintended.
      if (this._result === null) return;
      this._snapToSegmentUnderPointer();
      this._announceResult();
      this._draw();
      return;
    }
    const wasSpinning = Math.abs(this._omega) >= STOP_THRESHOLD_RAD_PER_S;
    // Same `disable_boost` gate as the pointer path.
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

  private _draw(): void {
    const c = this.shadowRoot?.getElementById("wheel") as
      | HTMLCanvasElement
      | null;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;

    const size = this._size;
    const center = size / 2;
    const radius = size / 2 - size * RIM_INSET_FRAC;
    const hubRadius = size * HUB_RADIUS_FRAC;
    const halfMode = this._isHalfMode();
    // canvasH may be shorter than `size` in half mode — using `size`
    // here would clearRect pixels that no longer exist.
    const canvasH = this._canvasCssHeight();

    // DPR scaling — backing store W×H×dpr, draw in CSS px.
    const dpr = window.devicePixelRatio || 1;
    const wantW = Math.max(1, Math.round(size * dpr));
    const wantH = Math.max(1, Math.round(canvasH * dpr));
    if (c.width !== wantW || c.height !== wantH) {
      c.width = wantW;
      c.height = wantH;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, canvasH);

    const arcs = this._arcs();
    const n = arcs.length;
    const labels = this._expandedLabels();
    const colors = this._segmentColors();
    const labelColors = this._segmentLabelColors();
    const orientation = this._textOrientation();
    const theme = this._resolveTheme(ctx);
    const isTodoMode = this._isTodoMode();

    // Half-circle: clip disc paint to the upper half (the lower half
    // still rotates internally). Hub + pointer paint AFTER restore, so
    // the hub renders as a full circle on the cut line (dial nub).
    if (halfMode) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, size, center);
      ctx.clip();
    }

    // Rotate by -π/2 (puts +X at 12 o'clock) then -arcs[0]/2 (centres
    // segment 0 on the pointer at _angle=0).
    const a0 = arcs[0] ?? (Math.PI * 2) / n;
    ctx.save();
    ctx.translate(center, center);
    ctx.rotate(this._angle - Math.PI / 2 - a0 / 2);

    // ~14 px label at the 280 px calibration size.
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

      // Below ~15° (≈ 4 %) there's no readable space.
      if (arc > 0.26) {
        const text = labels[i] ?? "";
        const fillColor = labelColors[i] ?? "#1a1a1a";
        const midAngle = start + arc / 2;
        // Todo+radial: 0.55 widens the budget ~35 % vs 0.66 (the
        // rim-side margin `radius - labelRadius` is the binding
        // constraint), fitting longer summaries before shrinking.
        const labelRadius =
          isTodoMode && orientation === "radial"
            ? radius * 0.55
            : radius * 0.66;

        // HA icon name (`mdi:foo`, `hass:foo`) → render the path.
        // While loading, the next redraw shows the icon.
        if (this._looksLikeIcon(text)) {
          const path = this._getIconPath(text);
          if (typeof path === "string") {
            // ~1.5× text font — icons read smaller per pixel.
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
            // Icon missing — render literal so the user spots a typo.
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
          // undefined → still loading; the async load re-triggers _draw.
          cursor += arc;
          continue;
        }

        ctx.save();
        ctx.fillStyle = fillColor;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";

        let display: string;
        if (isTodoMode) {
          // Arbitrary user text — measure and shrink before truncating.
          // Width budget: radial = 2 × min(labelRadius - hubRadius,
          // radius - labelRadius) × 0.9; tangent = arc × labelRadius
          // × 0.85. Floor at minPx, then ellipsis-truncate.
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
            // Chop tail until str+"…" fits; bail at 1 char so we never
            // output just "…".
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
          // Static-labels path: fixed font + char-count truncation.
          ctx.font = `600 ${labelFontPx}px ui-sans-serif, system-ui, sans-serif`;
          const maxChars = Math.max(3, Math.floor((arc / 0.26) * 4));
          display =
            text.length > maxChars ? text.slice(0, maxChars - 1) + "…" : text;
        }

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

      cursor += arc;
    }

    // Soft outer ring — CSS drop-shadow carries the depth.
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(0, 0, 0, 0.30)";
    ctx.stroke();

    // Rim pegs — opt-in. K pegs per slice (1 boundary + `peg_density`
    // mids, K = density + 1) so the rim reads as a real prize wheel.
    // Painted AFTER the outer ring so a light/white peg colour
    // (`hub_color: white`) doesn't get tinted by the grey ring stroke
    // overlapping it. Half-circle clip handles the lower half
    // automatically. Colour matches the indicator/hub accent so the
    // pegs read against any segment fill.
    if (this._pegsEnabled()) {
      const pegSize = Math.max(2, (size * 3) / DEFAULT_SIZE);
      const pegRadius = radius * PEG_RADIUS_FRAC;
      const k = this._pegsPerSegment();
      ctx.fillStyle = theme.indicatorFill;
      let pegCursor = 0;
      for (let i = 0; i < n; i++) {
        const arc = arcs[i] ?? 0;
        const slice = arc / k;
        // K pegs per segment at j*slice for j=0..K-1 (boundary at j=0,
        // then K-1 mids evenly spaced inside the slice).
        for (let j = 0; j < k; j++) {
          const a = pegCursor + slice * j;
          ctx.beginPath();
          ctx.arc(
            Math.cos(a) * pegRadius,
            Math.sin(a) * pegRadius,
            pegSize,
            0,
            TWO_PI,
          );
          ctx.fill();
        }
        pegCursor += arc;
      }
    }

    ctx.restore();

    // Release the upper-half clip so hub + pointer can paint below.
    if (halfMode) ctx.restore();

    // Hub — does not rotate.
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

    // Hub text auto-shrinks. Hidden in selector mode — the centre
    // "SPIN" prompt no longer matches the drag-to-pick gesture.
    // Half-circle keeps it visible (just paints over the cut line).
    const hubText = this._hubText();
    if (hubText && !this._isSelectorMode()) {
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

    // Pointer triangle, apex into the wheel.
    const pHalfW = size * POINTER_HALF_WIDTH_FRAC;
    const pTop = size * POINTER_TOP_FRAC;
    const pTip = size * POINTER_TIP_FRAC;
    ctx.beginPath();
    ctx.moveTo(center, pTip);
    ctx.lineTo(center - pHalfW, pTop);
    ctx.lineTo(center + pHalfW, pTop);
    ctx.closePath();
    ctx.fillStyle = theme.indicatorFill;
    ctx.fill();
  }

  // _resolveTheme reads CSS vars per-draw — nothing else schedules a
  // paint on a light/dark flip.
  private _prevDarkMode: boolean | undefined = undefined;
  private _prevTheme: string | undefined = undefined;

  /** Filter `hass`-only updates so unrelated entity ticks don't re-run
   *  the update cycle. Care list: locale, theme flip, todo entity state.
   *  Non-hass changes always allow (lit-3 SKILL § identity compare). */
  protected override shouldUpdate(changed: PropertyValues): boolean {
    if (!this.config) return false;
    for (const k of changed.keys()) {
      if (k !== "hass") return true;
    }
    if (!changed.has("hass")) return false;
    const prev = changed.get("hass") as HomeAssistant | undefined;
    if (!prev || !this.hass) return true;
    if (prev.locale?.language !== this.hass.locale?.language) return true;
    if (prev.language !== this.hass.language) return true;
    if (prev.themes?.darkMode !== this.hass.themes?.darkMode) return true;
    const prevTheme = (prev.themes as { theme?: string } | undefined)?.theme;
    const nextTheme = (this.hass.themes as { theme?: string } | undefined)
      ?.theme;
    if (prevTheme !== nextTheme) return true;
    const todoEntity = this.config.todo_entity;
    if (todoEntity) {
      if (prev.states?.[todoEntity]?.state !== this.hass.states?.[todoEntity]?.state) {
        return true;
      }
    }
    return false;
  }

  protected override updated(changed: PropertyValues): void {
    let needsDraw =
      changed.has("config") ||
      changed.has("_result") ||
      changed.has("_todoItems");
    if (changed.has("config")) {
      // half_circle toggle reshapes the canvas without changing the
      // wrap; ResizeObserver wouldn't refire on its own. Idempotent
      // when diameter is unchanged.
      const wrap = this.shadowRoot?.querySelector(".wheel-wrap") as
        | HTMLElement
        | null;
      if (wrap) {
        const rect = wrap.getBoundingClientRect();
        if (rect.width > 0 || rect.height > 0) {
          this._size = this._clampSize(
            this._fitDim(rect.width, rect.height),
          );
        }
      }
      this._applyCanvasSize();
    }
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
    // Watch the todo entity's `state` (open-item count). Covers adds,
    // removes, completions, undos.
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
    // todo wired but empty / not yet fetched — surface in the status
    // line instead of rendering placeholder 1..N labels silently.
    const todoEmpty =
      !!this.config.todo_entity &&
      (this._todoItems === null || this._todoItems.length === 0) &&
      !this._spinning &&
      this._result === null;
    const idleKey = this._isSelectorMode()
      ? "status.idle_selector"
      : "status.idle";
    // Plain-text status string — used for the canvas's aria-label so
    // screen readers always hear a literal value (no "ha-icon" jargon).
    const statusText = this._spinning
      ? localize("status.spinning", lang)
      : this._result !== null
        ? localize("status.result", lang, { value: this._result })
        : todoEmpty
          ? localize("status.todo_empty", lang)
          : localize(idleKey, lang);
    // Rich status node — same content, but when the result is an MDI
    // icon string the {value} slot renders <ha-icon> instead of bare
    // text. Falls back to plain text for typed labels and the other
    // statuses (spinning / idle / todo_empty).
    const statusNode: TemplateResult | string =
      !this._spinning && this._result !== null
        ? this._renderResultLine(this._result, lang)
        : statusText;
    // Empty / whitespace `name` hides ha-card's header — fresh installs
    // show a clean wheel until the user opts in.
    const header = this.config.name?.trim()
      ? this.config.name
      : undefined;
    const halfMode = this._isHalfMode();

    return html`
      <ha-card .header=${header}>
        <div class="card-content">
          <div class=${halfMode ? "wheel-wrap wheel-wrap-half" : "wheel-wrap"}>
            <canvas
              id="wheel"
              width=${DEFAULT_SIZE}
              height=${DEFAULT_SIZE}
              role="img"
              tabindex="0"
              aria-label=${statusText}
              @pointerdown=${this._onPointerDown}
              @pointermove=${this._onPointerMove}
              @pointerup=${this._onPointerUp}
              @keydown=${this._onKeyDown}
              @pointercancel=${this._onPointerCancel}
            ></canvas>
          </div>
          ${this.config.show_status === false
            ? nothing
            : html`<div class="status" aria-live="polite">${statusNode}</div>`}
        </div>
      </ha-card>
    `;
  }

  /** Render the "Result: X" line. When X is an MDI icon string
   *  (`mdi:home`, `hass:foo`), substitute an inline `<ha-icon>` for the
   *  bare text so the user sees the same glyph the wheel painted, not
   *  the literal identifier. The aria-live region stays text-only via
   *  the canvas's `aria-label` (= statusText), so screen readers
   *  continue announcing the literal value. */
  private _renderResultLine(result: string, lang: string): TemplateResult {
    if (!this._looksLikeIcon(result)) {
      return html`${localize("status.result", lang, { value: result })}`;
    }
    // Sentinel-split the localised template at the {value} placeholder
    // so the icon can be inserted positionally without giving up i18n
    // (some languages may put the value at a non-tail position).
    const SENTINEL = " ";
    const template = localize("status.result", lang, { value: SENTINEL });
    const [prefix, suffix] = template.split(SENTINEL);
    return html`${prefix ?? ""}<ha-icon
        class="result-icon"
        icon=${result}
        title=${result}
      ></ha-icon>${suffix ?? ""}`;
  }

  static override styles: CSSResultGroup = css`
    /* Height must flow :host → ha-card → card-content → wheel-wrap so
       the canvas sizes to min(width, height). Without it the row-drag
       handle in the dashboard editor binds to nothing. */
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
    /* Canvas size written inline by the ResizeObserver. Container
       queries were tried; min(100cqi, 100cqb) collapsed on hosts
       without a definite block-size ("width is NaN on default"). */
    .wheel-wrap {
      flex: 1 1 auto;
      min-height: 0;
      min-width: 0;
      width: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    /* Half-circle: anchor the canvas to the bottom of the wrap so any
       slack vertical space sits ABOVE the dome (not between the dome
       and the status line). Status hugs the cut line. */
    .wheel-wrap-half {
      align-items: flex-end;
    }
    /* Inline MDI icon in the "Result: …" line when the winning label
       is an icon string. Sized to the surrounding text. */
    .result-icon {
      --mdc-icon-size: 1.15em;
      vertical-align: -0.22em;
    }
    #wheel {
      display: block;
      max-width: 600px;
      max-height: 600px;
      touch-action: none;        /* pointer handler owns gestures */
      cursor: grab;
      user-select: none;
      filter: drop-shadow(0 6px 14px rgba(0, 0, 0, 0.25));
    }
    #wheel:active {
      cursor: grabbing;
    }
    /* WCAG 2.4.7 AA — Space/Enter triggers spin, canvas must focus. */
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

    /* Windows High Contrast. */
    @media (forced-colors: active) {
      #wheel:focus-visible {
        outline-color: CanvasText;
      }
    }
    /* RAF short-circuits in _startAnim; this catches any future CSS
       transitions so they don't bypass the user's choice. */
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

// Idempotent registration. `@customElement(...)` calls `define`
// unconditionally, which throws on a duplicate Lovelace resource load
// (HACS + manual /local), aborting module init after the editor
// registers but before the card → "Unknown type encountered" on the
// dashboard. ha-lovelace-card SKILL § Editor-event plumbing.
if (!customElements.get("spinning-wheel-card")) {
  customElements.define("spinning-wheel-card", SpinningWheelCard);
}
