import { LitElement, html, nothing } from "lit";
import type { TemplateResult, CSSResultGroup, PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";

import type {
  ActionConfig,
  HaFormSchema,
  HomeAssistant,
  LovelaceCardEditor,
  SpinningWheelCardConfig,
  Theme,
  TodoItem,
} from "./types";
import { fireEvent } from "./types";
import { editorStyles } from "./styles";
import {
  AVAILABLE_LANGUAGES,
  localize,
  resolveLang,
} from "./localize/localize";
import { DEFAULT_LABEL_COLOR, THEME_PALETTES } from "./palettes";
import { normalizeFriction } from "./friction";

// Editor projects array config (labels / weights / colors / label_colors)
// as `*_csv` strings and per-unique-label values as synthetic
// `binding_<i>_<suffix>` keys. Both shapes are stripped in _onFormChanged
// before config-changed fires so they never reach saved YAML.
type EditorData = SpinningWheelCardConfig & {
  weights_csv?: string;
  colors_csv?: string;
  label_colors_csv?: string;
  [syntheticKey: string]: unknown;
};

// Form prefill so first-open dropdowns/toggles reflect operating values;
// stripped in _onFormChanged so saved YAML stays minimal. hub_text is
// excluded — see _formDefaults.
const STATIC_DEFAULTS = {
  segments: 8,
  friction: 5,
  text_orientation: "tangent" as const,
  label_auto_fit: false,
  label_font_scale: 100,
  label_radius_offset: 0,
  sound: true,
  theme: "default" as const,
  hub_color: "theme" as const,
  show_status: true,
  disable_confirm_actions: false,
  disable_boost: false,
  half_circle: false,
  selector_mode: false,
  segment_borders: true,
  pegs: false,
  peg_density: 1,
  wheel_context: false,
} satisfies Partial<SpinningWheelCardConfig>;

/** Parse CSV / newline-separated colour list. Empty positions become
 *  `null` sentinels so `#a,,#c` produces `["#a", null, "#c"]` — the
 *  middle slot falls through to the active theme palette per
 *  `_mapPaletteToLabels`. Trailing empties are trimmed so a user
 *  typing `#a, #b, ` doesn't accumulate phantom theme slots.
 *  Exported for unit tests. */
export const parseColorList = (csv: string): ReadonlyArray<string | null> => {
  const parts: (string | null)[] = csv.split(/[,\n]/).map((s) => {
    const t = s.trim();
    return t.length > 0 ? t : null;
  });
  while (parts.length > 0 && parts[parts.length - 1] === null) parts.pop();
  return parts;
};

/** Parse CSV / whitespace-separated positive numbers; skips invalid
 *  tokens silently rather than throwing. Exported for unit tests. */
export const parseWeights = (csv: string): ReadonlyArray<number> => {
  const out: number[] = [];
  for (const tok of csv.split(/[,\s]+/)) {
    if (!tok) continue;
    const n = Number(tok);
    if (Number.isFinite(n) && n > 0) out.push(n);
  }
  return out;
};

/** Parse a CSS colour into an [r, g, b] tuple for ha-form's color_rgb
 *  selector. Handles `#RRGGBB`, `#RGB`, `rgb(r, g, b)` — the three forms
 *  the editor itself emits. Returns null for everything else (named
 *  colours, `var(--…)`, hsl()); those keep working in YAML but the
 *  picker falls back to undefined. Exported for unit tests. */
export const cssToRgb = (
  s: string | undefined,
): readonly [number, number, number] | null => {
  if (!s) return null;
  const t = s.trim();
  let m = /^#([0-9a-f]{6})$/i.exec(t);
  if (m) {
    const hex = m[1] ?? "";
    return [
      parseInt(hex.slice(0, 2), 16),
      parseInt(hex.slice(2, 4), 16),
      parseInt(hex.slice(4, 6), 16),
    ] as const;
  }
  m = /^#([0-9a-f]{3})$/i.exec(t);
  if (m) {
    const hex = m[1] ?? "";
    const a = hex[0] ?? "0";
    const b = hex[1] ?? "0";
    const c = hex[2] ?? "0";
    return [
      parseInt(a + a, 16),
      parseInt(b + b, 16),
      parseInt(c + c, 16),
    ] as const;
  }
  m = /^rgb\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i.exec(t);
  if (m) {
    return [
      parseInt(m[1] ?? "0", 10),
      parseInt(m[2] ?? "0", 10),
      parseInt(m[3] ?? "0", 10),
    ] as const;
  }
  return null;
};

/** Format an [r, g, b] tuple as a CSS `rgb(...)` string. Exported for tests. */
export const rgbToCss = (rgb: readonly [number, number, number]): string =>
  `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;

/** Type guard for [r, g, b] number tuples (not range-validated; ha-form's
 *  color_rgb selector emits 0–255). Exported for tests. */
export const isRgbTuple = (v: unknown): v is readonly [number, number, number] =>
  Array.isArray(v) &&
  v.length === 3 &&
  typeof v[0] === "number" &&
  typeof v[1] === "number" &&
  typeof v[2] === "number";

const DEFAULT_THEME: Theme = "default";
const DEFAULT_SEGMENTS = 8;

export class SpinningWheelCardEditor
  extends LitElement
  implements LovelaceCardEditor
{
  @property({ attribute: false }) public hass!: HomeAssistant;

  @state() private _config: SpinningWheelCardConfig = {
    type: "spinning-wheel-card",
  };
  // CSV verbatim — preserves the trailing comma the user is about to type.
  @state() private _weightsText = "";
  @state() private _colorsText = "";
  @state() private _labelColorsText = "";

  /** Survives the post-create empty value-changed race: ha-form's entity
   *  selector emits "" briefly after a programmatic update because the
   *  just-created entity isn't in `hass.states` yet. Session-scoped;
   *  saved `result_entity` is the durable check on next open. */
  @state() private _helperCreatedThisSession = false;

  // Editor-side mirror of the card's todo fetch. Without this the
  // bindings panel would show rows for the static `_config.labels`
  // (ignored at runtime when todo is active).
  @state() private _todoItems: ReadonlyArray<TodoItem> | null = null;
  private _todoLastEntity: string | null = null;
  private _todoLastEntityState: string | null = null;
  private _todoLoading = false;

  public setConfig(config: SpinningWheelCardConfig): void {
    this._config = { ...config };
    this._weightsText = (config.weights ?? []).join(", ");
    this._colorsText = (config.colors ?? []).map((c) => c ?? "").join(", ");
    this._labelColorsText = (config.label_colors ?? [])
      .map((c) => c ?? "")
      .join(", ");
  }

  private _lang(): string {
    return this._config?.language ?? resolveLang(this.hass);
  }

  protected override updated(_changed: PropertyValues): void {
    const entityId = this._config.todo_entity ?? null;
    if (entityId !== this._todoLastEntity) {
      this._todoLastEntity = entityId;
      this._todoItems = null;
      this._todoLastEntityState = null;
    }
    if (entityId) {
      const entity = this.hass?.states?.[entityId];
      const stateNow = entity?.state ?? null;
      if (stateNow !== this._todoLastEntityState) {
        this._todoLastEntityState = stateNow;
        if (stateNow !== null) void this._fetchTodoItems();
      }
    }
  }

  /** Mirrors the card's _fetchTodoItems so editor and runtime agree on
   *  which items become unique-label slots. */
  private async _fetchTodoItems(): Promise<void> {
    const entity = this._config.todo_entity;
    if (!entity || !this.hass?.callWS) return;
    if (this._todoLoading) return;
    this._todoLoading = true;
    try {
      const reply = (await this.hass.callWS({
        type: "todo/item/list",
        entity_id: entity,
      })) as { items?: ReadonlyArray<TodoItem> } | undefined;
      const all = reply?.items ?? [];
      const open = all.filter(
        (i) => (i.status ?? "needs_action") === "needs_action",
      );
      const seen = new Set<string>();
      const unique: TodoItem[] = [];
      for (const item of open) {
        const key = item.summary ?? "";
        if (!key || seen.has(key)) continue;
        seen.add(key);
        unique.push(item);
      }
      this._todoItems = unique;
    } catch (err) {
      console.warn(
        "[spinning-wheel-card editor] todo/item/list failed:",
        err,
      );
      this._todoItems = [];
    } finally {
      this._todoLoading = false;
    }
  }

  /** Unique labels in order of first appearance — the binding key for
   *  the per-row panel. Mirrors the card's `_mapPaletteToLabels` walk
   *  so editor and runtime agree on slot assignment. Priority:
   *  todo items > static `labels` > "1".."N". */
  private _uniqueLabels(): ReadonlyArray<string> {
    if (this._config.todo_entity) {
      if (!this._todoItems || this._todoItems.length === 0) return [];
      const seen = new Set<string>();
      const out: string[] = [];
      for (const item of this._todoItems) {
        const summary = item.summary ?? "";
        if (!summary || seen.has(summary)) continue;
        seen.add(summary);
        out.push(summary);
      }
      return out;
    }
    const segments = this._config.segments ?? DEFAULT_SEGMENTS;
    const src = this._config.labels;
    const expanded =
      src && src.length > 0
        ? Array.from({ length: segments }, (_, i) => src[i % src.length] ?? "")
        : Array.from({ length: segments }, (_, i) => String(i + 1));
    const seen = new Set<string>();
    const out: string[] = [];
    for (const lbl of expanded) {
      if (!seen.has(lbl)) {
        seen.add(lbl);
        out.push(lbl);
      }
    }
    return out;
  }

  /** Per-unique-label fill colour: explicit `colors` > theme palette >
   *  default rainbow. Cycles shorter sources. */
  private _resolvedColors(): ReadonlyArray<string> {
    const uniques = this._uniqueLabels();
    const themeName = this._config.theme ?? DEFAULT_THEME;
    const fallback = THEME_PALETTES[themeName] ?? THEME_PALETTES.default;
    const custom = this._config.colors;
    const src = custom && custom.length > 0 ? custom : fallback;
    return uniques.map(
      (_, i) => src[i % src.length] ?? fallback[i % fallback.length] ?? "#888888",
    );
  }

  /** Per-unique-label text colour. Defaults to a single dark grey. */
  private _resolvedLabelColors(): ReadonlyArray<string> {
    const uniques = this._uniqueLabels();
    const custom = this._config.label_colors;
    const src = custom && custom.length > 0 ? custom : [DEFAULT_LABEL_COLOR];
    return uniques.map((_, i) => src[i % src.length] ?? DEFAULT_LABEL_COLOR);
  }

  /** Per-unique-label string-shorthand action (empty for object-form
   *  ActionConfigs from YAML). Objects survive per-row edits at indices
   *  the user does not touch. */
  private _resolvedActions(): ReadonlyArray<string> {
    const uniques = this._uniqueLabels();
    const src = this._config.actions ?? [];
    return uniques.map((_, i) => {
      const raw = src[i];
      return typeof raw === "string" ? raw : "";
    });
  }

  /** Per-unique-label weight (default 1). The card cycles weights by
   *  segment position, not unique label — this projection captures the
   *  common "label X is bigger than label Y" case; per-position needs
   *  use Advanced > Weights. */
  private _resolvedWeights(): ReadonlyArray<number> {
    const uniques = this._uniqueLabels();
    const src = this._config.weights ?? [];
    return uniques.map((_, i) => {
      if (src.length === 0) return 1;
      const v = src[i % src.length];
      return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 1;
    });
  }

  /** Rebuilt per render — ha-form bakes label text into the schema, so
   *  language changes need a fresh schema. Fields overridden by an
   *  active todo_entity are spliced out (ha-lovelace-card SKILL §
   *  conditional fields). */
  private _buildSchema(): ReadonlyArray<HaFormSchema> {
    const lang = this._lang();
    const todoActive = !!this._config.todo_entity;
    return [
      { name: "name", selector: { text: {} } },
      ...this._buildGeneralBlock(lang),
      {
        name: "todo_entity",
        selector: { entity: { domain: "todo" } },
      },
      // Friction lives at top level (not in General) and stays visible in
      // both todo and labels modes — spin physics are independent of
      // where labels come from.
      {
        name: "friction",
        selector: {
          number: { min: 1, max: 10, step: 1, mode: "slider" },
        },
      },
      ...(todoActive
        ? []
        : [
            {
              name: "segments",
              selector: {
                number: { min: 4, max: 24, step: 1, mode: "slider" },
              },
            } satisfies HaFormSchema,
            {
              name: "labels",
              // Chip-style selector — type a label, press Enter, X to
              // remove. `options: []` + `custom_value: true` lets every
              // entry be user-typed (no fixed dropdown). MDI icon
              // strings (`mdi:home`) round-trip as bare text.
              selector: {
                select: {
                  multiple: true,
                  custom_value: true,
                  options: [],
                },
              },
            } satisfies HaFormSchema,
            {
              name: "text_orientation",
              selector: {
                select: {
                  mode: "dropdown",
                  options: [
                    {
                      value: "tangent",
                      label: localize("editor.orientation_tangent", lang),
                    },
                    {
                      value: "radial",
                      label: localize("editor.orientation_radial", lang),
                    },
                  ],
                },
              },
            } satisfies HaFormSchema,
          ]),
      // Label sizing + radial-position controls. Always visible (todo
      // mode benefits from them too — long summaries shrink, slider
      // pushes labels off the hub or toward the rim). Placed right
      // below text_orientation so the three "how labels look" controls
      // cluster together visually.
      { name: "label_auto_fit", selector: { boolean: {} } },
      {
        name: "label_font_scale",
        selector: {
          number: { min: 70, max: 150, step: 5, mode: "slider" },
        },
      },
      {
        name: "label_radius_offset",
        selector: {
          number: { min: -20, max: 20, step: 1, mode: "slider" },
        },
      },
      // flatten:true on every binding layer — without it ha-form nests
      // values under data["bindings"] and writes fail silently
      // (expandable footgun).
      ...this._buildBindingsBlock(),
      // Advanced raw-arrays escape hatch for paste-from-YAML, CSS
      // keywords, full ActionConfig objects, per-position weight cycling.
      {
        type: "expandable" as const,
        name: "raw_arrays",
        title: localize("editor.advanced", lang),
        flatten: true,
        schema: [
          {
            name: "colors_csv",
            selector: { text: { multiline: true } },
          },
          {
            name: "label_colors_csv",
            selector: { text: { multiline: true } },
          },
          {
            name: "weights_csv",
            selector: { text: {} },
          },
          {
            name: "actions",
            selector: {
              entity: { domain: "script", multiple: true },
            },
          },
        ],
      },
      { name: "wheel_context", selector: { boolean: {} } },
      // Safety toggle pinned to the bottom — only relevant after the
      // user has wired actions above.
      { name: "disable_confirm_actions", selector: { boolean: {} } },
    ];
  }

  /** Card-wide style + behaviour preferences expandable. Ordered
   *  i18n / physics / visual / display / audio / kid-safety. */
  private _buildGeneralBlock(lang: string): ReadonlyArray<HaFormSchema> {
    return [
      {
        type: "expandable" as const,
        name: "general",
        title: localize("editor.general", lang),
        flatten: true,
        schema: [
          {
            name: "language",
            selector: {
              select: {
                mode: "dropdown",
                // "Auto" + every entry from the locale registry, native-
                // named (never translated). Adding a locale is a single
                // edit in localize.ts — the dropdown follows.
                options: [
                  {
                    value: "auto",
                    label: localize("editor.language_auto", lang),
                  },
                  ...AVAILABLE_LANGUAGES.map((l) => ({
                    value: l.code,
                    label: l.nativeName,
                  })),
                ],
              },
            },
          },
          {
            name: "theme",
            selector: {
              select: {
                mode: "dropdown",
                options: [
                  {
                    value: "default",
                    label: localize("editor.theme_default", lang),
                  },
                  {
                    value: "pastel",
                    label: localize("editor.theme_pastel", lang),
                  },
                  {
                    value: "pride",
                    label: localize("editor.theme_pride", lang),
                  },
                  {
                    value: "neon",
                    label: localize("editor.theme_neon", lang),
                  },
                ],
              },
            },
          },
          { name: "hub_text", selector: { text: {} } },
          {
            name: "hub_color",
            selector: {
              select: {
                mode: "dropdown",
                options: [
                  {
                    value: "theme",
                    label: localize("editor.hub_color_theme", lang),
                  },
                  {
                    value: "black",
                    label: localize("editor.hub_color_black", lang),
                  },
                  {
                    value: "white",
                    label: localize("editor.hub_color_white", lang),
                  },
                ],
              },
            },
          },
          { name: "show_status", selector: { boolean: {} } },
          { name: "sound", selector: { boolean: {} } },
          { name: "disable_boost", selector: { boolean: {} } },
          { name: "half_circle", selector: { boolean: {} } },
          { name: "selector_mode", selector: { boolean: {} } },
          { name: "segment_borders", selector: { boolean: {} } },
          { name: "pegs", selector: { boolean: {} } },
          // Mid-segment peg slider only when pegs are on — splice
          // pattern per ha-lovelace-card SKILL § conditional fields.
          // Spliced-out values are dropped on save (see _onFormChanged
          // strip block) so a quick toggle off→on doesn't leak a
          // stored density into the YAML.
          ...(this._config.pegs === true
            ? [
                {
                  name: "peg_density",
                  selector: {
                    number: {
                      min: 0,
                      max: 4,
                      step: 1,
                      mode: "slider",
                    },
                  },
                } satisfies HaFormSchema,
              ]
            : []),
          // result_entity rendered standalone (see render()) to dodge
          // ha-form's entity-selector-emits-empty-after-programmatic-set
          // race that was dropping the just-created helper.
        ],
      },
    ];
  }

  private _buildBindingsBlock(): ReadonlyArray<HaFormSchema> {
    const lang = this._lang();
    const uniques = this._uniqueLabels();
    if (uniques.length === 0) return [];
    const inner: HaFormSchema[] = uniques.map((label, i) => ({
      type: "expandable" as const,
      name: `binding_${i}`,
      title: label,
      flatten: true,
      schema: [
        {
          type: "grid" as const,
          name: "" as const,
          schema: [
            { name: `binding_${i}_color`, selector: { color_rgb: {} } },
            {
              name: `binding_${i}_label_color`,
              selector: { color_rgb: {} },
            },
          ],
        },
        {
          name: `binding_${i}_weight`,
          selector: {
            number: { min: 0.1, max: 99, step: 0.1, mode: "box" },
          },
        },
        {
          name: `binding_${i}_action`,
          selector: { entity: { domain: "script" } },
        },
      ],
    }));
    return [
      {
        type: "expandable" as const,
        name: "bindings",
        title: localize("editor.bindings", lang),
        flatten: true,
        schema: inner,
      },
    ];
  }

  /** Per-field i18n bindings keyed by schema name. Bindings-panel
   *  synthetics (`binding_<i>_<suffix>`) live in BINDING_SUFFIX_LABELS
   *  below — same label per suffix across rows. */
  private static readonly FIELD_I18N: ReadonlyMap<
    string,
    { label: string; helper?: string }
  > = new Map([
    ["name", { label: "editor.name" }],
    ["language", { label: "editor.language", helper: "editor.language_helper" }],
    ["todo_entity", { label: "editor.todo_entity", helper: "editor.todo_entity_helper" }],
    ["segments", { label: "editor.segments", helper: "editor.segments_helper" }],
    ["friction", { label: "editor.friction", helper: "editor.friction_helper" }],
    ["theme", { label: "editor.theme", helper: "editor.theme_helper" }],
    ["labels", { label: "editor.labels", helper: "editor.labels_helper" }],
    ["weights_csv", { label: "editor.weights", helper: "editor.weights_helper" }],
    ["colors_csv", { label: "editor.colors", helper: "editor.colors_helper" }],
    ["label_colors_csv", { label: "editor.label_colors", helper: "editor.label_colors_helper" }],
    ["hub_text", { label: "editor.hub_text", helper: "editor.hub_text_helper" }],
    ["hub_color", { label: "editor.hub_color", helper: "editor.hub_color_helper" }],
    ["text_orientation", { label: "editor.text_orientation", helper: "editor.text_orientation_helper" }],
    ["label_auto_fit", { label: "editor.label_auto_fit", helper: "editor.label_auto_fit_helper" }],
    ["label_font_scale", { label: "editor.label_font_scale", helper: "editor.label_font_scale_helper" }],
    ["label_radius_offset", { label: "editor.label_radius_offset", helper: "editor.label_radius_offset_helper" }],
    ["sound", { label: "editor.sound", helper: "editor.sound_helper" }],
    ["show_status", { label: "editor.show_status", helper: "editor.show_status_helper" }],
    ["actions", { label: "editor.actions", helper: "editor.actions_helper" }],
    ["disable_confirm_actions", { label: "editor.disable_confirm_actions", helper: "editor.disable_confirm_actions_helper" }],
    ["disable_boost", { label: "editor.disable_boost", helper: "editor.disable_boost_helper" }],
    ["half_circle", { label: "editor.half_circle", helper: "editor.half_circle_helper" }],
    ["selector_mode", { label: "editor.selector_mode", helper: "editor.selector_mode_helper" }],
    ["segment_borders", { label: "editor.segment_borders", helper: "editor.segment_borders_helper" }],
    ["pegs", { label: "editor.pegs", helper: "editor.pegs_helper" }],
    ["peg_density", { label: "editor.peg_density", helper: "editor.peg_density_helper" }],
    ["wheel_context", { label: "editor.wheel_context", helper: "editor.wheel_context_helper" }],
    ["raw_arrays", { label: "editor.advanced", helper: "editor.advanced_helper" }],
  ]);

  private static readonly BINDING_SUFFIX_LABELS: ReadonlyArray<
    readonly [string, string]
  > = [
    ["_label_color", "editor.binding_label_color"],
    ["_color", "editor.binding_color"],
    ["_weight", "editor.binding_weight"],
    ["_action", "editor.binding_action"],
  ];

  private _computeLabel = (field: { name: string }): string => {
    const lang = this._lang();
    if (field.name.startsWith("binding_")) {
      for (const [suffix, key] of SpinningWheelCardEditor.BINDING_SUFFIX_LABELS) {
        if (field.name.endsWith(suffix)) return localize(key, lang);
      }
    }
    const entry = SpinningWheelCardEditor.FIELD_I18N.get(field.name);
    return entry ? localize(entry.label, lang) : field.name;
  };

  private _computeHelper = (field: { name: string }): string | undefined => {
    if (field.name.startsWith("binding_")) return undefined;
    // Surface a soft warning under todo_entity when a list is wired but
    // has zero open items right now — otherwise the wheel renders blank
    // and it isn't obvious why. ha-form has no per-field warning slot,
    // so we hijack the helper text with a ⚠ prefix; styling stays
    // standard helper.
    if (field.name === "todo_entity") {
      const entity = this._config.todo_entity;
      const wired = typeof entity === "string" && entity.length > 0;
      if (
        wired &&
        this._todoItems !== null &&
        this._todoItems.length === 0
      ) {
        return localize("editor.todo_entity_empty_warning", this._lang());
      }
    }
    const entry = SpinningWheelCardEditor.FIELD_I18N.get(field.name);
    return entry?.helper ? localize(entry.helper, this._lang()) : undefined;
  };

  /** hub_text is NOT prefilled — otherwise ha-form would re-fill it
   *  with the localised default after every render, making "no hub
   *  label" impossible. */
  private _formDefaults(): Record<string, unknown> {
    return { ...STATIC_DEFAULTS };
  }

  /** Last projection given to ha-form. _onFormChanged diffs against it
   *  to detect which surface (bindings panel / Advanced CSV / Advanced
   *  multi-picker) produced the change, so a stale projection on one
   *  surface can't overwrite a fresh edit on another. */
  private _lastProjection: {
    bindings: Record<string, unknown>;
    actionsStrings: ReadonlyArray<string>;
    colorsCsv: string;
    labelColorsCsv: string;
    weightsCsv: string;
  } | null = null;

  private _onFormChanged = (
    ev: CustomEvent<{ value: EditorData }>,
  ): void => {
    const next: EditorData = { ...ev.detail.value };
    const proj = this._lastProjection;

    // 1. CSV synthetics (Advanced section).
    const weightsCsv = (next.weights_csv as string | undefined) ?? "";
    const colorsCsvNext = (next.colors_csv as string | undefined) ?? "";
    const labelColorsCsvNext =
      (next.label_colors_csv as string | undefined) ?? "";
    delete next.weights_csv;
    delete next.colors_csv;
    delete next.label_colors_csv;

    // 2. Bindings synthetics — strip from `next`, capture only the
    // values that differ from the last projection (= user edits).
    const bindingDeltas: Record<string, unknown> = {};
    for (const key of Object.keys(next)) {
      if (key.startsWith("binding_") || key === "bindings") {
        if (proj && next[key] !== proj.bindings[key]) {
          bindingDeltas[key] = next[key];
        }
        delete next[key];
      }
    }

    // 3. Labels — chip selector emits string[] directly. Trim each chip
    // and drop empties (paste of a trailing comma can leave one), clamp
    // to the wheel's segment count.
    // No editor-side truncation against `segments`. Labels and every
    // secondary array (weights / colors / label_colors / actions)
    // stay at their full user-entered length. When `segments` drops
    // below an array length, setConfig validation throws a clear
    // "labels length (N) must not exceed segments (M)" error in the
    // dashboard's red banner — fail-loud beats silent data loss, and
    // the user can either raise segments back or trim the offending
    // array themselves. Only label cleaning (trim + drop empties from
    // a paste) runs here.
    const rawLabels = next.labels;
    if (Array.isArray(rawLabels)) {
      const cleaned = rawLabels
        .filter((l): l is string => typeof l === "string")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      if (cleaned.length === 0) delete next.labels;
      else next.labels = cleaned;
    } else {
      delete next.labels;
    }

    // 3b. Weights: CSV edit > bindings edit > unchanged.
    const weightsCsvChanged =
      proj !== null && weightsCsv !== proj.weightsCsv;
    if (weightsCsvChanged) {
      const parsed = parseWeights(weightsCsv);
      if (parsed.length === 0) delete next.weights;
      else next.weights = parsed;
    } else {
      const wDeltas = Object.entries(bindingDeltas).filter(([k]) =>
        /^binding_\d+_weight$/.test(k),
      );
      if (wDeltas.length > 0) {
        const resolved = this._resolvedWeights();
        const out: number[] = resolved.slice();
        for (const [k, v] of wDeltas) {
          const m = /^binding_(\d+)_weight$/.exec(k);
          if (!m) continue;
          const i = parseInt(m[1] ?? "0", 10);
          if (i < 0 || i >= out.length) continue;
          if (typeof v === "number" && Number.isFinite(v) && v > 0) {
            out[i] = v;
          }
        }
        // All-1 → drop entirely (default-equal cycling).
        if (out.every((w) => w === 1)) delete next.weights;
        else next.weights = out;
      }
    }

    // 4. Colours: CSV edit > bindings edit > unchanged. Sparse model —
    // unedited positions stay `null` so a `theme:` change still pulls
    // them from the new palette. Only positions the user actually
    // picked (or typed in CSV) become explicit strings.
    const colorsCsvChanged =
      proj !== null && colorsCsvNext !== proj.colorsCsv;
    if (colorsCsvChanged) {
      const parsed = parseColorList(colorsCsvNext);
      if (parsed.length === 0 || parsed.every((c) => c === null)) {
        delete next.colors;
      } else {
        next.colors = parsed;
      }
    } else {
      const colorDeltas = Object.entries(bindingDeltas).filter(
        ([k]) => /^binding_\d+_color$/.test(k),
      );
      if (colorDeltas.length > 0) {
        const uniqueCount = this._uniqueLabels().length;
        const existing = this._config.colors ?? [];
        // Start from existing entries (preserving null where set);
        // pad to unique-label length with null so theme-derived
        // positions stay theme-derived after this edit.
        const out: (string | null)[] = [];
        for (let i = 0; i < uniqueCount; i++) {
          const e = existing[i];
          out.push(typeof e === "string" && e.length > 0 ? e : null);
        }
        for (const [k, v] of colorDeltas) {
          const m = /^binding_(\d+)_color$/.exec(k);
          if (!m) continue;
          const i = parseInt(m[1] ?? "0", 10);
          if (i < 0 || i >= out.length) continue;
          if (isRgbTuple(v)) out[i] = rgbToCss(v);
        }
        if (out.every((c) => c === null)) delete next.colors;
        else next.colors = out;
      }
    }

    // 5. Label colours: same sparse strategy as colours.
    const labelColorsCsvChanged =
      proj !== null && labelColorsCsvNext !== proj.labelColorsCsv;
    if (labelColorsCsvChanged) {
      const parsed = parseColorList(labelColorsCsvNext);
      if (parsed.length === 0 || parsed.every((c) => c === null)) {
        delete next.label_colors;
      } else {
        next.label_colors = parsed;
      }
    } else {
      const lcDeltas = Object.entries(bindingDeltas).filter(([k]) =>
        /^binding_\d+_label_color$/.test(k),
      );
      if (lcDeltas.length > 0) {
        const uniqueCount = this._uniqueLabels().length;
        const existing = this._config.label_colors ?? [];
        const out: (string | null)[] = [];
        for (let i = 0; i < uniqueCount; i++) {
          const e = existing[i];
          out.push(typeof e === "string" && e.length > 0 ? e : null);
        }
        for (const [k, v] of lcDeltas) {
          const m = /^binding_(\d+)_label_color$/.exec(k);
          if (!m) continue;
          const i = parseInt(m[1] ?? "0", 10);
          if (i < 0 || i >= out.length) continue;
          if (isRgbTuple(v)) out[i] = rgbToCss(v);
        }
        if (out.every((c) => c === null)) delete next.label_colors;
        else next.label_colors = out;
      }
    }

    // 6. Actions: multi-picker > bindings > unchanged. Object-form
    // ActionConfig entries are appended after the picker's strings so
    // they survive a multi-picker save.
    const pickerNext = Array.isArray(next.actions)
      ? (next.actions as ReadonlyArray<unknown>).filter(
          (a): a is string => typeof a === "string",
        )
      : null;
    const projActions = proj?.actionsStrings ?? [];
    const pickerChanged =
      pickerNext !== null &&
      (pickerNext.length !== projActions.length ||
        pickerNext.some((v, i) => v !== projActions[i]));
    const oldActions = this._config.actions ?? [];
    const oldObjects = oldActions.filter(
      (a): a is Exclude<(typeof oldActions)[number], string | null> =>
        a !== null && typeof a !== "string",
    );
    if (pickerChanged && pickerNext) {
      const merged: Array<string | ActionConfig> = [
        ...pickerNext,
        ...oldObjects,
      ];
      if (merged.length === 0) delete next.actions;
      else next.actions = merged;
    } else {
      const actionDeltas = Object.entries(bindingDeltas).filter(([k]) =>
        /^binding_\d+_action$/.test(k),
      );
      if (actionDeltas.length > 0) {
        // Pad with nulls then splice deltas; object entries at
        // non-edited indices survive via the spread.
        const uniqueCount = this._uniqueLabels().length;
        const out: Array<string | ActionConfig | null> = [...oldActions];
        while (out.length < uniqueCount) out.push(null);
        for (const [k, v] of actionDeltas) {
          const m = /^binding_(\d+)_action$/.exec(k);
          if (!m) continue;
          const i = parseInt(m[1] ?? "0", 10);
          if (i < 0 || i >= uniqueCount) continue;
          if (typeof v === "string" && v.length > 0) {
            out[i] = v;
          } else if (
            // Cleared, but the slot held an object — keep the object
            // (the picker can't represent it; clearing isn't a delete).
            i < oldActions.length &&
            typeof oldActions[i] === "object" &&
            oldActions[i] !== null
          ) {
            // No-op: out[i] still references the object via spread.
          } else {
            out[i] = null;
          }
        }
        while (out.length > 0 && out[out.length - 1] === null) out.pop();
        if (out.length === 0) delete next.actions;
        else next.actions = out;
      } else if (next.actions === undefined || next.actions === null) {
        // Empty picker AND no binding edit — preserve object-only
        // config from a fresh YAML setConfig.
        if (oldObjects.length > 0) next.actions = [...oldObjects];
        else delete next.actions;
      }
    }

    // 6.5 Labels-shrink cascade. When the chip selector emits a shorter
    // labels array than what was saved, trim every position-keyed
    // secondary array (weights / colors / label_colors / actions) to
    // the new labels length. The chip selector is the user's intent
    // channel — deleting a chip implies its row's weight, colour and
    // action are gone too. Without this, a stale weights[6] sticks
    // around after labels drops to 4 and trips setConfig validation
    // (labels.length is fine vs segments=4, but weights.length=6
    // isn't).
    const oldLabelsLen = Array.isArray(this._config.labels)
      ? this._config.labels.length
      : 0;
    const newLabelsLen = Array.isArray(next.labels) ? next.labels.length : 0;
    if (newLabelsLen > 0 && newLabelsLen < oldLabelsLen) {
      if (Array.isArray(next.weights) && next.weights.length > newLabelsLen) {
        next.weights = next.weights.slice(0, newLabelsLen);
      }
      if (Array.isArray(next.colors) && next.colors.length > newLabelsLen) {
        next.colors = next.colors.slice(0, newLabelsLen);
      }
      if (
        Array.isArray(next.label_colors) &&
        next.label_colors.length > newLabelsLen
      ) {
        next.label_colors = next.label_colors.slice(0, newLabelsLen);
      }
      if (Array.isArray(next.actions) && next.actions.length > newLabelsLen) {
        next.actions = next.actions.slice(0, newLabelsLen);
      }
    }

    // 7. hub_text + defaults stripping.
    const hadHubText = typeof this._config.hub_text === "string";
    const formClearedHubText =
      next.hub_text === undefined || next.hub_text === null;
    if (hadHubText && formClearedHubText) {
      next.hub_text = "";
    }
    if (next.segments === STATIC_DEFAULTS.segments) delete next.segments;
    if (next.friction === STATIC_DEFAULTS.friction) delete next.friction;
    if (next.text_orientation === STATIC_DEFAULTS.text_orientation) {
      delete next.text_orientation;
    }
    if (next.label_auto_fit === STATIC_DEFAULTS.label_auto_fit) {
      delete next.label_auto_fit;
    }
    if (next.label_font_scale === STATIC_DEFAULTS.label_font_scale) {
      delete next.label_font_scale;
    }
    if (next.label_radius_offset === STATIC_DEFAULTS.label_radius_offset) {
      delete next.label_radius_offset;
    }
    if (next.sound === STATIC_DEFAULTS.sound) delete next.sound;
    if (next.theme === STATIC_DEFAULTS.theme) delete next.theme;
    if (next.hub_color === STATIC_DEFAULTS.hub_color) delete next.hub_color;
    if (next.show_status === STATIC_DEFAULTS.show_status) {
      delete next.show_status;
    }
    if (
      next.disable_confirm_actions === STATIC_DEFAULTS.disable_confirm_actions
    ) {
      delete next.disable_confirm_actions;
    }
    if (next.disable_boost === STATIC_DEFAULTS.disable_boost) {
      delete next.disable_boost;
    }
    if (next.half_circle === STATIC_DEFAULTS.half_circle) {
      delete next.half_circle;
    }
    if (next.selector_mode === STATIC_DEFAULTS.selector_mode) {
      delete next.selector_mode;
    }
    if (next.segment_borders === STATIC_DEFAULTS.segment_borders) {
      delete next.segment_borders;
    }
    if (next.pegs === STATIC_DEFAULTS.pegs) {
      delete next.pegs;
      // Density is meaningless when pegs are off — strip too so it
      // doesn't leak into saved YAML after a toggle-on / toggle-off.
      delete next.peg_density;
    } else if (next.peg_density === STATIC_DEFAULTS.peg_density) {
      delete next.peg_density;
    }
    if (next.wheel_context === STATIC_DEFAULTS.wheel_context) {
      delete next.wheel_context;
    }
    if (next.language === "auto") delete next.language;
    if (next.todo_entity === "" || next.todo_entity == null) {
      delete next.todo_entity;
    }
    // result_entity is owned by the standalone widget — preserve from
    // _config; whatever ha-form emits here is stale.
    if (this._config.result_entity) {
      next.result_entity = this._config.result_entity;
    } else {
      delete next.result_entity;
    }

    // 8. Cache CSV verbatim; regenerate when the binding side authored
    // the change so the next render's CSV view stays in sync.
    this._weightsText = weightsCsvChanged
      ? weightsCsv
      : (next.weights ?? []).join(", ");
    // null entries (= "use theme palette here") render as an empty
    // slot between commas so the CSV round-trips faithfully. The
    // parser turns those empties back into null.
    this._colorsText = colorsCsvChanged
      ? colorsCsvNext
      : (next.colors ?? []).map((c) => c ?? "").join(", ");
    this._labelColorsText = labelColorsCsvChanged
      ? labelColorsCsvNext
      : (next.label_colors ?? []).map((c) => c ?? "").join(", ");

    this._config = next;
    fireEvent(this, "config-changed", { config: next });
  };

  protected override render(): TemplateResult {
    const lang = this._lang();
    // Spread order: defaults < user config < CSV synthetics < bindings.
    const data: EditorData = {
      ...this._formDefaults(),
      ...this._config,
      // Map "no override" to the Auto sentinel so the dropdown isn't blank.
      language: this._config.language ?? "auto",
      // multi:true entity selector expects string[]; object-form
      // ActionConfigs stay in _config.actions and re-merge on save.
      actions: (this._config.actions ?? []).filter(
        (a): a is string => typeof a === "string",
      ),
      // Migrate pre-v1.2 string presets to the new 1–10 slider on the
      // fly so the slider widget displays a value (the dropdown is gone).
      // Save path re-strips if the result equals the default.
      friction: normalizeFriction(this._config.friction),
      weights_csv: this._weightsText,
      colors_csv: this._colorsText,
      label_colors_csv: this._labelColorsText,
    };
    const uniques = this._uniqueLabels();
    const colors = this._resolvedColors();
    const labelColors = this._resolvedLabelColors();
    const actions = this._resolvedActions();
    const weights = this._resolvedWeights();
    const bindingsSnapshot: Record<string, unknown> = {};
    for (let i = 0; i < uniques.length; i++) {
      const c = cssToRgb(colors[i]);
      const lc = cssToRgb(labelColors[i]);
      const cKey = `binding_${i}_color`;
      const lcKey = `binding_${i}_label_color`;
      const wKey = `binding_${i}_weight`;
      const aKey = `binding_${i}_action`;
      data[cKey] = c ?? undefined;
      data[lcKey] = lc ?? undefined;
      data[wKey] = weights[i] ?? 1;
      data[aKey] = actions[i] ?? "";
      bindingsSnapshot[cKey] = data[cKey];
      bindingsSnapshot[lcKey] = data[lcKey];
      bindingsSnapshot[wKey] = data[wKey];
      bindingsSnapshot[aKey] = data[aKey];
    }
    // Snapshot for _onFormChanged to diff against.
    this._lastProjection = {
      bindings: bindingsSnapshot,
      actionsStrings: data.actions as ReadonlyArray<string>,
      colorsCsv: this._colorsText,
      labelColorsCsv: this._labelColorsText,
      weightsCsv: this._weightsText,
    };
    // Admin-only — `input_text/create` is `require_admin` upstream.
    const showCreateHelper =
      !this._helperCreatedThisSession &&
      !this._config.result_entity &&
      this.hass?.user?.is_admin === true;
    return html`
      <div class="editor">
        <ha-form
          .hass=${this.hass}
          .data=${data}
          .schema=${this._buildSchema()}
          .computeLabel=${this._computeLabel}
          .computeHelper=${this._computeHelper}
          @value-changed=${this._onFormChanged}
        ></ha-form>
        <!-- Standalone (not via ha-form) — dodges the entity-selector-
             emits-empty-after-programmatic-set race. -->
        <div class="result-entity-row">
          <ha-selector
            .hass=${this.hass}
            .selector=${{ entity: { domain: "input_text" } }}
            .value=${this._config.result_entity ?? ""}
            .label=${localize("editor.result_entity", lang)}
            .helper=${localize("editor.result_entity_helper", lang)}
            @value-changed=${this._onResultEntityChanged}
          ></ha-selector>
        </div>
        ${showCreateHelper
          ? html`
              <div class="create-helper-row">
                <p class="create-helper-hint">
                  ${localize("editor.result_entity_create_hint", lang)}
                </p>
                <button
                  type="button"
                  class="create-helper-btn"
                  @click=${this._createResultHelper}
                >
                  ${localize("editor.result_entity_create", lang)}
                </button>
              </div>
            `
          : nothing}
        <div class="editor-hint">${localize("editor.footer_hint", lang)}</div>
      </div>
    `;
  }

  /** Standalone result_entity handler — bypasses ha-form so the racy
   *  entity-selector-emits-empty-after-programmatic-set can't drop the
   *  value between Create and Save. */
  private _onResultEntityChanged = (
    ev: CustomEvent<{ value: string }>,
  ): void => {
    // Some HA frontend versions catch unhandled value-changed events
    // at the dialog level and try to merge them; scope to us only.
    ev.stopPropagation();
    const newValue = ev.detail.value;
    if (newValue && typeof newValue === "string") {
      this._config = { ...this._config, result_entity: newValue };
    } else {
      // Picker emits "" when cleared — drop rather than persist "".
      const next = { ...this._config };
      delete next.result_entity;
      this._config = next;
    }
    fireEvent(this, "config-changed", { config: this._config });
  };

  /** Admin-only WS call to provision a dedicated `input_text` helper.
   *  HA auto-increments slug collisions so multi-instance dashboards
   *  work. _config mutation MUST happen before config-changed — the
   *  dashboard persists storage but does NOT re-invoke setConfig on
   *  the live editor (ha-lovelace-card SKILL § _config lifecycle). */
  private async _createResultHelper(): Promise<void> {
    if (!this.hass?.callWS) return;
    const lang = this._lang();
    try {
      const reply = await this.hass.callWS<{
        id: string;
        name: string;
      }>({
        type: "input_text/create",
        name: localize("editor.result_entity_default_name", lang),
        max: 255,
        icon: "mdi:dharmachakra",
      });
      if (reply?.id) {
        const entityId = `input_text.${reply.id}`;
        this._config = { ...this._config, result_entity: entityId };
        this._helperCreatedThisSession = true;
        fireEvent(this, "config-changed", { config: this._config });
        // HA's standard toast channel (frontend/src/util/toast.ts) —
        // <notification-manager> catches the bubbling+composed event.
        fireEvent(this, "hass-notification", {
          message: localize("editor.result_entity_created", lang, {
            entity: entityId,
          }),
        });
      }
    } catch (err) {
      console.warn(
        "[spinning-wheel-card editor] input_text/create failed:",
        err,
      );
      fireEvent(this, "hass-notification", {
        message: localize("editor.result_entity_create_failed", lang),
      });
    }
  }

  static override styles: CSSResultGroup = editorStyles;
}

// Idempotent registration — see the note at the bottom of
// spinning-wheel-card.ts. Without the guard, a duplicate Lovelace
// resource load aborts module init before the card class registers.
if (!customElements.get("spinning-wheel-card-editor")) {
  customElements.define(
    "spinning-wheel-card-editor",
    SpinningWheelCardEditor,
  );
}
