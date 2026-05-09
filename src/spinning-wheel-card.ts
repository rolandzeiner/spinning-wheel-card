// Spinning Wheel Card — Lovelace custom card.
//
// Click anywhere on the wheel for a random impulse spin. Click + drag to
// throw the wheel: while dragging, the wheel follows the cursor exactly
// (the angle from centre maps to wheel rotation); on release, the last
// few pointer-move samples are averaged into an angular velocity and
// the wheel keeps spinning, decaying via configurable friction.
//
// Physics uses a frame-rate-independent decay: ω *= friction^(60 * dt)
// where `friction` is the per-frame multiplier at a 60 fps reference.
// The RAF loop only runs while ω is above a small threshold, so the
// card consumes zero CPU once the wheel has stopped.
//
// Standalone — no integration backing, no entities consumed.

import { LitElement, html, css, nothing } from "lit";
import type { TemplateResult, PropertyValues, CSSResultGroup } from "lit";
import { customElement, property, state } from "lit/decorators.js";

import type {
  Friction,
  HomeAssistant,
  HubColor,
  LovelaceCardEditor,
  SpinningWheelCardConfig,
  TextOrientation,
  Theme,
} from "./types";
import { localize, resolveLang } from "./localize/localize";

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
// Module-init context: hass isn't available yet, so use navigator.language
// for the picker entry. The localize helper falls back to English for any
// language outside the supported set (currently en, de).
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
// Default size used until ResizeObserver delivers the live canvas width.
const DEFAULT_SIZE = 280;
const MIN_SIZE = 140;          // floor — at smaller sizes labels become unreadable
const MAX_SIZE = 600;          // ceiling — keeps the canvas reasonable on huge dashboards
// Pointer / hub geometry as fractions of the live size, calibrated to
// match the previous fixed-pixel look at 280 px.
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

// Below this |ω| we snap to zero and stop the RAF loop.
const STOP_THRESHOLD_RAD_PER_S = 0.05;

// Click impulse range (random sign).
const CLICK_IMPULSE_MIN = 8;   // rad/s ≈ 1.3 rev/s
const CLICK_IMPULSE_MAX = 16;  // rad/s ≈ 2.5 rev/s

// During drag, samples older than this are dropped from the velocity
// estimate. Smooths out spikes when the user pauses mid-drag.
const VELOCITY_SAMPLE_WINDOW_MS = 100;

// Bound the release velocity so a panic flick doesn't produce
// 50-rev/s nonsense.
const MAX_VELOCITY_RAD_PER_S = 40;

const TWO_PI = Math.PI * 2;

/** Normalise an angle to [0, 2π). Used after every `_angle` mutation
 *  so the accumulator cannot drift into float-precision territory over
 *  long sessions of repeated spins (`%` on a multi-billion-radian double
 *  is already lossy by several segments). */
const wrapAngle = (a: number): number => ((a % TWO_PI) + TWO_PI) % TWO_PI;

// Tick acoustics — tuned so a fast spin doesn't drown in overlapping ticks.
// At MAX_VELOCITY with 24 segments the wheel naturally crosses ~150
// segments/sec; without these throttles every crossing queued a 40 ms
// tick, producing a noisy buzz. With them: max ~33 ticks/sec, each at
// floor-intensity, each shorter — three multiplicative reductions.
const TICK_RATE_LIMIT_MS = 30;     // floor between consecutive ticks (≈33 Hz max)
const TICK_PEAK_SPEED = 12;         // rad/s where ticks are loudest
const TICK_HIGH_SPEED_FLOOR = 0.3;  // intensity at MAX_VELOCITY (relative to peak)

/** Threshold (radians) of accumulated pointer-angle change before a
 *  press is reclassified from "click" to "drag". With label radius
 *  ≈ 0.66 × wheel radius, this works out to ~3 px of physical movement
 *  on a 280 px wheel — small enough to feel responsive, large enough
 *  to absorb mouse-jitter during a deliberate click. */
const DRAG_COMMIT_RAD = 0.04;

// 8 evenly-spaced HSL colours. Index modulo segments for >8.
const SEGMENT_COLORS: ReadonlyArray<string> = [
  "#e63946", "#f4a261", "#e9c46a", "#a8dadc",
  "#457b9d", "#1d3557", "#9b5de5", "#06d6a0",
];

/** Soft pastel palette (8 colours) — low-saturation, light value. Reads
 *  well with the default dark-grey label text. */
const PASTEL_PALETTE: ReadonlyArray<string> = [
  "#FFB3BA", "#FFDFBA", "#FDFD96", "#B5EAD7",
  "#BAE1FF", "#C7CEEA", "#E0BBE4", "#FFC8DD",
];

/** Pride palette — Gilbert Baker / 1979 simplified six-stripe rainbow
 *  PLUS the three unique colours from the Monica Helms 1999 transgender
 *  flag (light blue, pink, white; the flag itself mirrors them as
 *  five stripes — we only need the unique three for a wheel palette).
 *  Nine colours total; cycles for segments > 9. The Progress Pride
 *  flag (Daniel Quasar 2018) also adds black + brown for POC inclusion
 *  — left out here because pure black and pure brown segments tend to
 *  look like rendering bugs on a wheel rather than deliberate stripes;
 *  users who want them can supply via the `colors` config. */
const PRIDE_PALETTE: ReadonlyArray<string> = [
  // Gilbert Baker rainbow
  "#E40303", // red
  "#FF8C00", // orange
  "#FFED00", // yellow
  "#008026", // green
  "#004DFF", // indigo
  "#750787", // violet
  // Helms transgender flag — unique stripes
  "#5BCEFA", // light blue
  "#F5A9B8", // pink
  "#FFFFFF", // white
  // Bisexual-flag purple (rgb(128, 0, 128))
  "#800080", // purple
];

/** Neon palette (8 colours) — vivid, fully-saturated tones. Pair with
 *  white `label_colors` for the strongest contrast on the saturated
 *  fills, otherwise the dark-grey default still reads at AA. */
const NEON_PALETTE: ReadonlyArray<string> = [
  "#FF14A6", // hot pink
  "#FF6700", // orange
  "#FFFF00", // yellow
  "#39FF14", // green
  "#00FFFF", // cyan
  "#1F51FF", // electric blue
  "#BF00FF", // purple
  "#FF00FF", // magenta
];

const THEME_PALETTES: Record<Theme, ReadonlyArray<string>> = {
  default: SEGMENT_COLORS,
  pastel: PASTEL_PALETTE,
  pride: PRIDE_PALETTE,
  neon: NEON_PALETTE,
};

// Fallback label-text colour when the user hasn't supplied label_colors.
// Dark grey reads well against most of the default segment palette and
// is the value the card used before label_colors became configurable.
const DEFAULT_LABEL_COLOR = "#1a1a1a";

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

  public setConfig(config: SpinningWheelCardConfig): void {
    // setConfig may run before hass is set (HA's lifecycle order isn't
    // guaranteed); use navigator language as a fallback so error text
    // is still localised for the user. Prefer the INCOMING config's
    // language over the current one so an edit that also flips the
    // language gets its error reported in the new language.
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
    // Default `name` is set in render() rather than here, so the display
    // header stays reactive to language changes.
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
    return this.config.text_orientation ?? "tangent";
  }

  public getCardSize(): number {
    return 6;
  }

  public getGridOptions(): {
    columns: number | "full";
    rows: number | "auto";
    min_columns: number;
    min_rows: number;
  } {
    // Canvas is fluid (ResizeObserver-driven, capped at MAX_SIZE px).
    // Default to 6 cols but let the user stretch all the way to "full".
    return { columns: 6, rows: "auto", min_columns: 4, min_rows: 5 };
  }

  // Config-derived helpers
  private _segments(): number {
    return this.config.segments ?? 8;
  }
  private _frictionFactor(): number {
    return FRICTION[this.config.friction ?? "medium"];
  }
  /** Labels expanded to length = segments. Shorter `labels` cycle around;
   *  empty / missing → "1".."N". */
  private _expandedLabels(): ReadonlyArray<string> {
    const n = this._segments();
    const src = this.config.labels;
    if (!src || src.length === 0) {
      return Array.from({ length: n }, (_, i) => String(i + 1));
    }
    return Array.from({ length: n }, (_, i) => src[i % src.length] ?? "");
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
    const c = this.shadowRoot?.getElementById("wheel") as
      | HTMLCanvasElement
      | null;
    if (c) {
      // Seed the size from layout if it has resolved already, otherwise
      // the observer's first delivery will fix it within a frame.
      const rect = c.getBoundingClientRect();
      if (rect.width > 0) this._size = this._clampSize(rect.width);
      this._resizeObserver = new ResizeObserver((entries) => {
        // Entries are delivered on a microtask; a `disconnect()` that
        // ran moments ago does not unqueue them. Bail when detached
        // rather than mutating state on an unmounted element.
        if (!this.isConnected) return;
        for (const e of entries) {
          const next = this._clampSize(e.contentRect.width);
          // Tolerance avoids redraws on sub-pixel jitter from layout
          // recalcs that don't actually change the rendered size.
          if (Math.abs(next - this._size) >= 1) {
            this._size = next;
            this._draw();
          }
        }
      });
      this._resizeObserver.observe(c);
    }
    this._draw();
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
  }

  private _clampSize(w: number): number {
    return Math.max(MIN_SIZE, Math.min(MAX_SIZE, Math.round(w)));
  }

  // ── Theme-aware colours for pointer + hub ──────────────────────────
  // Read live values from the host's computed styles so the indicator
  // and the spin button pick up whatever HA theme is active. Re-resolved
  // on every draw — getComputedStyle is cheap and themes can flip
  // (light/dark mode toggle) between paints.

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

  /** Canvas-backed colour canonicalisation — accepts any CSS colour and
   *  returns [r, g, b]. The trick: setting ctx.fillStyle and reading it
   *  back gives the canonical "#rrggbb" or "rgb(...)" form. CSS variable
   *  refs (var(--…)) are resolved by getComputedStyle upstream, so they
   *  never reach this function. */
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

  /** Draw `text` along an arc of radius R, centred on `midAngle`. The
   *  caller is expected to have already applied the wheel's parent
   *  rotation (so angles are in the wheel-local frame). Each glyph is
   *  positioned at its own angle along the arc and rotated to be tangent
   *  there — the text follows the curve of the segment. Caller owns
   *  ctx.font / fillStyle / textAlign / textBaseline. */
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
    // Honour the user's motion preference: skip the multi-second decay
    // entirely. Snap omega to zero in place, keep the wheel at whatever
    // angle the impulse just left it, announce the result. WCAG 2.3.3
    // compliance — the spin *is* the feature, but the user has asked
    // not to see the animation, so we do not run it.
    if (
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    ) {
      // Run the spin "instantly" — apply a chunk of decay so the final
      // resting angle isn't trivially the impulse-application angle,
      // but skip the per-frame visual playback. 1.5 s of equivalent
      // decay at the configured friction is a balanced middle ground.
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

      // Bell-curve intensity: rises from quiet at low speed to peak
      // around TICK_PEAK_SPEED, then tapers to TICK_HIGH_SPEED_FLOOR by
      // MAX_VELOCITY. Real wheels have loud per-impact clicks at any
      // speed but the ear blurs them at high speed — modelling that
      // taper here keeps the fast-spin sound from piling into a wash.
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

  /** Index of the segment currently under the 12 o'clock pointer.
   *  Segment 0 is centred on the pointer at angle 0 — offset by -arcs[0]/2
   *  in the wheel's local frame. The angle under the pointer (in wheel
   *  local coordinates) is therefore (-_angle + arcs[0]/2), normalised
   *  to [0, 2π). Walks the cumulative arcs to find the containing slice. */
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
  }

  // ── Audio (peg clicks) ──────────────────────────────────────────────
  // Lazy AudioContext — created on first user interaction so we satisfy
  // the browser's gesture requirement, then reused for all subsequent
  // ticks. The synth is one short noise burst per tick through a
  // resonant bandpass; quick exponential decay envelope; gain scales
  // with the passed intensity (0..1) so faster spins click louder.

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
      // `resume()` on a freshly-constructed context is usually a no-op
      // but Safari (and Chromium when the page hasn't received a user
      // gesture yet) returns a pending promise. Flip the readiness flag
      // when it resolves so `_playTick` waits for a usable currentTime.
      const ctx = this._audioCtx;
      if (ctx.state === "running") {
        this._audioReady = true;
      } else {
        void ctx
          .resume()
          .then(() => {
            this._audioReady = true;
          })
          .catch(() => {
            // Suspended context recovers on the next user gesture; no-op.
          });
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
    // Skip the click rather than schedule against a not-yet-resumed
    // context; the very next tick after `resume()` resolves will play.
    // The cost is a single inaudible click on first-spin; in exchange
    // we never produce a phantom-silent burst.
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
    // Duration tracks intensity: 40 ms tail at peak (satisfying "tok"
    // on slow-mid spins), shrinking to 25 ms snap at low intensity
    // (high-speed taper) so adjacent ticks don't blur into a buzz.
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

  /** Call after every angle update. Emits a tick when the segment under
   *  the pointer changes, with a hard cap on tick rate (TICK_RATE_LIMIT_MS).
   *  Above the cap the segment index still advances so we'll fire on the
   *  next crossing past the cooldown — at the cost of dropping some
   *  intermediate clicks at very high spin speeds, which the ear can't
   *  separate anyway. */
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
    // CRUCIALLY: do NOT zero omega or stop the anim here. We don't yet
    // know whether this is a click or a drag. A click during a spin
    // should boost speed (handled in pointerup); only a real drag
    // should commandeer the wheel — that transition happens in
    // pointermove once movement crosses _DRAG_COMMIT_RAD.
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
      // Only seed the tick cursor when the RAF loop is NOT running.
      // While it runs the loop owns `_lastTickSeg`; reseeding here
      // would race the next tick and either suppress a legitimate
      // click or fire a spurious one on first move.
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

    // Track total movement to decide click-vs-drag. Until we cross the
    // threshold the wheel runs unmodified — a spinning wheel keeps
    // spinning, and the user can still click without taking it over.
    this._dragAccumulated += Math.abs(delta);
    if (!this._dragMoved && this._dragAccumulated > DRAG_COMMIT_RAD) {
      this._dragMoved = true;
      // NOW commandeer the wheel: halt momentum so drag-following maps
      // 1:1 with cursor angle.
      this._omega = 0;
      this._stopAnim();
      this._result = null;
    }
    this._dragLastAngle = a;

    if (!this._dragMoved) {
      // Sub-threshold: don't move the wheel yet. Cursor angle still
      // tracked above so the next delta is computed from the latest
      // position (not the initial down position).
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
      const mag =
        CLICK_IMPULSE_MIN +
        Math.random() * (CLICK_IMPULSE_MAX - CLICK_IMPULSE_MIN);
      if (wasSpinning) {
        // BOOST: add impulse in the wheel's current direction. Cap at
        // MAX_VELOCITY so repeated clicks don't compound past the
        // sane upper bound.
        const sign = this._omega >= 0 ? 1 : -1;
        const next = this._omega + sign * mag;
        this._omega = Math.max(
          -MAX_VELOCITY_RAD_PER_S,
          Math.min(MAX_VELOCITY_RAD_PER_S, next),
        );
        // RAF loop is already running; it picks up the new omega next frame.
      } else {
        // Fresh start from rest — random direction.
        const sign = Math.random() < 0.5 ? -1 : 1;
        this._omega = sign * mag;
        this._result = null;
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
      // Insufficient release velocity to spin — typical case is a
      // drag-to-stop where the user grabs a fast-spinning wheel and
      // bleeds momentum off through the cursor. The drag-commit path
      // already called `_stopAnim()` but left `_spinning = true`
      // (the previous RAF loop owned that flag); without resetting it
      // here the status line stays stuck on "Spinning…" indefinitely.
      // Snap to a clean rest, announce the result, repaint.
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
    // Per-segment label-text colours come from the same unique-label
    // mapping as segment fills, so segments sharing a label always
    // share a label colour.
    const labelColors = this._segmentLabelColors();
    const orientation = this._textOrientation();
    const theme = this._resolveTheme(ctx);

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
        ctx.save();
        ctx.fillStyle = labelColors[i] ?? "#1a1a1a";
        ctx.font = `600 ${labelFontPx}px ui-sans-serif, system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const text = labels[i] ?? "";
        // Width budget: smaller segments → fewer chars before truncation.
        const maxChars = Math.max(3, Math.floor((arc / 0.26) * 4));
        const display =
          text.length > maxChars ? text.slice(0, maxChars - 1) + "…" : text;
        if (orientation === "radial") {
          // Radial — straight text reading along the spoke.
          ctx.rotate(start + arc / 2);
          ctx.translate(radius * 0.66, 0);
          ctx.rotate(Math.PI);
          ctx.fillText(display, 0, 0);
        } else {
          // Tangent — bend the text along the segment's arc so each
          // glyph is rotated to be locally tangent. Reads as a curved
          // word that follows the slice's outer edge.
          this._drawArchedText(ctx, display, start + arc / 2, radius * 0.66);
        }
        ctx.restore();
      }

      cursor += arc;
    }

    // Outer ring — softened from the original (3 px / 0.65 α). The
    // canvas's CSS drop-shadow already provides depth, so the rim
    // doesn't need to do much beyond defining the outer edge against
    // the segment fills. 2 px / 0.30 α reads as a subtle boundary on
    // light themes without going hard-pencil; on dark themes it stays
    // visible but unobtrusive.
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(0, 0, 0, 0.30)";
    ctx.stroke();

    ctx.restore();

    // Centre hub (does NOT rotate). Tinted with --primary-color, with a
    // subtle radial gradient (lighter top-left → darker edge) so it still
    // reads as a button rather than a flat disc.
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

    // Pointer (top of card, apex pointing DOWN into the wheel).
    // Borderless — just the accent fill.
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

  // Track theme tokens so we redraw when HA flips light/dark — the
  // colours we read in _resolveTheme are computed fresh each draw, but
  // nothing else triggers a paint when the theme switches.
  private _prevDarkMode: boolean | undefined = undefined;
  private _prevTheme: string | undefined = undefined;

  protected override updated(changed: PropertyValues): void {
    let needsDraw = changed.has("config") || changed.has("_result");
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
    if (needsDraw) this._draw();
  }

  protected override render(): TemplateResult {
    const lang = this._lang();
    const status = this._spinning
      ? localize("status.spinning", lang)
      : this._result !== null
        ? localize("status.result", lang, { value: this._result })
        : localize("status.idle", lang);
    const header = this.config.name ?? localize("common.default_name", lang);

    return html`
      <ha-card .header=${header}>
        <div class="card-content">
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
          ${this.config.show_status === false
            ? nothing
            : html`<div class="status" aria-live="polite">${status}</div>`}
        </div>
      </ha-card>
    `;
  }

  static override styles: CSSResultGroup = css`
    :host {
      display: block;
      color-scheme: light dark;
    }
    ha-card {
      overflow: hidden;
    }
    .card-content {
      padding: var(--ha-space-4, 16px);
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: var(--ha-space-2, 8px);
    }
    #wheel {
      /* Fluid: fills the card width up to MAX_SIZE; aspect-ratio keeps
         the canvas square as the card grows. The HTML width/height attrs
         only set the drawing-buffer; the rendered size comes from CSS. */
      width: 100%;
      max-width: 600px;
      height: auto;
      aspect-ratio: 1 / 1;
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
