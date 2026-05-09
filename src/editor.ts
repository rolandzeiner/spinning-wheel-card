import { LitElement, html, nothing } from "lit";
import type { TemplateResult, CSSResultGroup, PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";

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
import { localize, resolveLang } from "./localize/localize";
import { DEFAULT_LABEL_COLOR, THEME_PALETTES } from "./palettes";

// Editor exposes labels/weights/colors arrays as comma-separated *_csv
// fields. The bindings panel projects per-unique-label values into
// synthetic `binding_<i>_<color|label_color|action>` keys; both shapes
// strip from `next` in _onFormChanged before firing config-changed so
// they never reach saved YAML. `actions` is a real config field
// (string[]) — ha-form's entity selector with multiple:true round-trips
// it directly. The synthetic-keys index signature is permissive
// (`unknown`) because ha-form's data prop is loosely typed and the
// per-binding values are read back via narrow runtime guards.
type EditorData = SpinningWheelCardConfig & {
  labels_csv?: string;
  weights_csv?: string;
  colors_csv?: string;
  label_colors_csv?: string;
  [syntheticKey: string]: unknown;
};

// Form prefill so first-open dropdowns/toggles reflect the actual
// operating values. Stripped back out in _onFormChanged so saved YAML
// stays minimal. hub_text is intentionally NOT included — see
// _formDefaults below.
const STATIC_DEFAULTS = {
  segments: 8,
  friction: "medium" as const,
  text_orientation: "tangent" as const,
  sound: true,
  theme: "default" as const,
  hub_color: "theme" as const,
  show_status: true,
  disable_confirm_actions: false,
  disable_boost: false,
} satisfies Partial<SpinningWheelCardConfig>;

/** Split a comma- or newline-separated text field into trimmed,
 *  non-empty entries. Used for `labels`, `colors`, `label_colors` —
 *  the rules are identical for all three. */
const parseStringList = (csv: string): ReadonlyArray<string> =>
  csv
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

/** Parse a comma/whitespace-separated list of positive numbers. Used
 *  only for `weights`. Skips tokens that don't parse to a finite > 0
 *  rather than throwing — saves the user one trip through validation. */
const parseWeights = (csv: string): ReadonlyArray<number> => {
  const out: number[] = [];
  for (const tok of csv.split(/[,\s]+/)) {
    if (!tok) continue;
    const n = Number(tok);
    if (Number.isFinite(n) && n > 0) out.push(n);
  }
  return out;
};

/** Parse a CSS colour string into an [r, g, b] tuple for ha-form's
 *  color_rgb selector. Handles `#RRGGBB`, `#RGB`, and `rgb(r, g, b)` —
 *  the three forms the editor itself emits. Returns null for anything
 *  else (named colours, `var(--…)`, hsl(), etc.) — those keep working
 *  in YAML / Advanced > Colours but show as undefined in the picker
 *  (defaults to fallback). */
const cssToRgb = (
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

/** Tuple → "rgb(r, g, b)". Canonical, parses cleanly back via cssToRgb. */
const rgbToCss = (rgb: readonly [number, number, number]): string =>
  `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;

/** Type guard for the tuple shape ha-form's color_rgb selector emits. */
const isRgbTuple = (v: unknown): v is readonly [number, number, number] =>
  Array.isArray(v) &&
  v.length === 3 &&
  typeof v[0] === "number" &&
  typeof v[1] === "number" &&
  typeof v[2] === "number";

/** Default Theme used in resolution fallbacks (matches the card's
 *  `THEME_PALETTES[this.config.theme ?? "default"]` pattern). */
const DEFAULT_THEME: Theme = "default";

/** Default segment count when not configured. Mirrors the card's
 *  `this.config.segments ?? 8` (and matches STATIC_DEFAULTS.segments
 *  below — kept as a separate const so the resolution helpers don't
 *  reach across the const declaration order). */
const DEFAULT_SEGMENTS = 8;

@customElement("spinning-wheel-card-editor")
export class SpinningWheelCardEditor
  extends LitElement
  implements LovelaceCardEditor
{
  @property({ attribute: false }) public hass!: HomeAssistant;

  @state() private _config: SpinningWheelCardConfig = {
    type: "spinning-wheel-card",
  };
  // CSV verbatim — preserves the trailing comma the user is about to type.
  @state() private _labelsText = "";
  @state() private _weightsText = "";
  @state() private _colorsText = "";
  @state() private _labelColorsText = "";

  // ── Todo-list integration (editor-side mirror of card's fetch) ──────
  // When `todo_entity` is wired the bindings panel projects per-item
  // rows from the live entity, matching what the card renders at
  // runtime. Without this mirror the panel would show rows for the
  // static `_config.labels` (which are ignored when todo is active),
  // making per-todo-item colour / action configuration impossible.
  @state() private _todoItems: ReadonlyArray<TodoItem> | null = null;
  /** Tracks the entity_id we last fetched against so swapping todo
   *  entities or unsetting drops the cache. */
  private _todoLastEntity: string | null = null;
  /** HA reports a todo entity's open-count as `state` — refetch when
   *  it changes (covers item adds, completes, removes, undos). */
  private _todoLastEntityState: string | null = null;
  /** Debounce flag — `hass` updates burst (theme + state on the same
   *  tick is common); without this we'd kick off duplicate WS calls. */
  private _todoLoading = false;

  public setConfig(config: SpinningWheelCardConfig): void {
    this._config = { ...config };
    this._labelsText = (config.labels ?? []).join(", ");
    this._weightsText = (config.weights ?? []).join(", ");
    this._colorsText = (config.colors ?? []).join(", ");
    this._labelColorsText = (config.label_colors ?? []).join(", ");
  }

  private _lang(): string {
    return this._config?.language ?? resolveLang(this.hass);
  }

  protected override updated(_changed: PropertyValues): void {
    // Editor-side mirror of the card's todo-fetch trigger. Two events
    // refresh the cache:
    //   1. `todo_entity` swapped (or unset) — drop the cache so stale
    //      summaries from the previous entity don't bleed into the
    //      bindings panel.
    //   2. The entity's `state` (open-count) changed — items added /
    //      completed / removed since the last fetch.
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

  /** Fetch open items from the configured todo entity via the
   *  `todo/item/list` WS endpoint. Filters to `needs_action`, dedups
   *  by summary in order — identical logic to the card's fetch at
   *  spinning-wheel-card.ts:_fetchTodoItems so editor and runtime
   *  agree on which items become unique-label slots. */
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

  // ── Bindings-panel resolution (mirrors card's same-label-same-X) ─────

  /** Unique labels in order of first appearance — the binding key for
   *  the per-row panel. Mirrors the walk in spinning-wheel-card.ts's
   *  `_mapPaletteToLabels` so the editor and card agree on which label
   *  occupies which slot.
   *
   *  Resolution priority:
   *    1. Todo-list mode: when `todo_entity` is wired, project the
   *       fetched item summaries (already deduped by `_fetchTodoItems`)
   *       so the bindings panel matches what the card renders at
   *       runtime. While items haven't loaded yet — or the list is
   *       empty — return an empty array so the panel renders 0 rows
   *       (the user sees the todo-empty state instead of mismatched
   *       static labels).
   *    2. Static `labels` config (cycled to length = segments).
   *    3. Default "1".."N" when neither is set. */
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

  /** Resolve the active fill-colour palette: explicit `colors` if set,
   *  otherwise the active `theme`'s palette, otherwise the default
   *  rainbow. Aligned to unique-label indices, cycling shorter sources. */
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

  /** Resolve the active label-text palette. Defaults to a single dark
   *  grey for every unique label when `label_colors` is unset. */
  private _resolvedLabelColors(): ReadonlyArray<string> {
    const uniques = this._uniqueLabels();
    const custom = this._config.label_colors;
    const src = custom && custom.length > 0 ? custom : [DEFAULT_LABEL_COLOR];
    return uniques.map((_, i) => src[i % src.length] ?? DEFAULT_LABEL_COLOR);
  }

  /** Per-unique-label string-shorthand action (or empty). Object-form
   *  ActionConfig entries (set via YAML) are projected as empty in the
   *  picker — they remain in `_config.actions` and are preserved across
   *  per-row edits at indices the user does not touch. */
  private _resolvedActions(): ReadonlyArray<string> {
    const uniques = this._uniqueLabels();
    const src = this._config.actions ?? [];
    return uniques.map((_, i) => {
      const raw = src[i];
      return typeof raw === "string" ? raw : "";
    });
  }

  /** Per-unique-label weight (default 1). Cycles short weight arrays.
   *  Note: the card's underlying model cycles weights per-segment-
   *  position, not per-unique-label — so this projection captures the
   *  common case "label X is bigger than label Y" but loses the rarer
   *  "the second occurrence of X is smaller than the first" pattern.
   *  Power users with per-position weight needs use Advanced > Weights. */
  private _resolvedWeights(): ReadonlyArray<number> {
    const uniques = this._uniqueLabels();
    const src = this._config.weights ?? [];
    return uniques.map((_, i) => {
      if (src.length === 0) return 1;
      const v = src[i % src.length];
      return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 1;
    });
  }

  /** Rebuilt per render so option labels translate when language changes —
   *  ha-form bakes label text into the schema. When `todo_entity` is
   *  wired, the fields whose values are overridden by the entity
   *  (`segments`, `labels_csv`) or whose card-side defaults flip
   *  (`text_orientation` defaults to radial in todo mode for
   *  long-summary readability) are spliced out — the canonical
   *  ha-form pattern for conditional fields per the conditional-
   *  fields gotcha in `ha-lovelace-card` SKILL.md. */
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
              name: "labels_csv",
              selector: { text: { multiline: true } },
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
      // Bindings panel — one expandable per unique label, dynamically
      // generated each render so adding/renaming labels reshapes the
      // form. flatten:true on every layer so binding_<i>_<suffix> keys
      // surface at the top level of `data` (the ha-form expandable
      // footgun: without flatten, ha-form nests them under data["bindings"]
      // and the write-back fails silently — see ha-lovelace-card SKILL.md).
      ...this._buildBindingsBlock(),
      // Advanced wrapper — the raw arrays for paste-from-YAML / power
      // users wanting CSS keywords or var(--…) for colours, full
      // ActionConfig objects for actions, or per-segment-position
      // weight cycling that the per-unique-label bindings panel
      // can't express. Defaults closed.
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
      // `disable_confirm_actions` lives at the very bottom — it's a
      // safety toggle that only matters once the user has wired
      // actions in the Bindings panel above (or the Advanced raw
      // `actions` array). Placing it last keeps the top of the form
      // focused on what's edited most often.
      { name: "disable_confirm_actions", selector: { boolean: {} } },
    ];
  }

  /** Per-unique-label expandables for the bindings panel. Each carries
   *  the unique label as its title, two color_rgb pickers in a grid,
   *  and a single-script entity picker. Empty when there are no labels
   *  (which can't happen in practice — segments default to 8 → 8
   *  unique numeric labels). */
  /** "General" expandable — card-wide style + behaviour preferences.
   *  Defaults closed (matches the Bindings + Advanced expandables) so
   *  the editor opens compact; user clicks once to tweak. Ordered to
   *  group i18n / physics / visual / display / audio / kid-safety
   *  preferences in roughly that flow. */
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
                options: [
                  {
                    value: "auto",
                    label: localize("editor.language_auto", lang),
                  },
                  // Native names — they shouldn't translate.
                  { value: "en", label: "English" },
                  { value: "de", label: "Deutsch" },
                  { value: "fr", label: "Français" },
                  { value: "it", label: "Italiano" },
                  { value: "es", label: "Español" },
                  { value: "pt", label: "Português" },
                  { value: "zh", label: "简体中文" },
                  { value: "ja", label: "日本語" },
                ],
              },
            },
          },
          {
            name: "friction",
            selector: {
              select: {
                mode: "dropdown",
                options: [
                  { value: "low", label: localize("editor.friction_low", lang) },
                  {
                    value: "medium",
                    label: localize("editor.friction_medium", lang),
                  },
                  {
                    value: "high",
                    label: localize("editor.friction_high", lang),
                  },
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
          {
            name: "result_entity",
            selector: { entity: { domain: "input_text" } },
          },
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

  private _computeLabel = (field: { name: string }): string => {
    const lang = this._lang();
    // Bindings-panel synthetics — `binding_<i>_<suffix>`. Match by
    // suffix so the per-row labels translate without a per-index case.
    if (field.name.startsWith("binding_")) {
      if (field.name.endsWith("_label_color")) {
        return localize("editor.binding_label_color", lang);
      }
      if (field.name.endsWith("_color")) {
        return localize("editor.binding_color", lang);
      }
      if (field.name.endsWith("_weight")) {
        return localize("editor.binding_weight", lang);
      }
      if (field.name.endsWith("_action")) {
        return localize("editor.binding_action", lang);
      }
    }
    switch (field.name) {
      case "name":
        return localize("editor.name", lang);
      case "language":
        return localize("editor.language", lang);
      case "todo_entity":
        return localize("editor.todo_entity", lang);
      case "segments":
        return localize("editor.segments", lang);
      case "friction":
        return localize("editor.friction", lang);
      case "theme":
        return localize("editor.theme", lang);
      case "labels_csv":
        return localize("editor.labels", lang);
      case "weights_csv":
        return localize("editor.weights", lang);
      case "colors_csv":
        return localize("editor.colors", lang);
      case "label_colors_csv":
        return localize("editor.label_colors", lang);
      case "hub_text":
        return localize("editor.hub_text", lang);
      case "hub_color":
        return localize("editor.hub_color", lang);
      case "text_orientation":
        return localize("editor.text_orientation", lang);
      case "sound":
        return localize("editor.sound", lang);
      case "show_status":
        return localize("editor.show_status", lang);
      case "actions":
        return localize("editor.actions", lang);
      case "disable_confirm_actions":
        return localize("editor.disable_confirm_actions", lang);
      case "disable_boost":
        return localize("editor.disable_boost", lang);
      case "result_entity":
        return localize("editor.result_entity", lang);
      default:
        return field.name;
    }
  };

  private _computeHelper = (field: { name: string }): string | undefined => {
    const lang = this._lang();
    // Per-row binding inputs are self-explanatory inside the
    // unique-label expandable — no helper text per field.
    if (field.name.startsWith("binding_")) return undefined;
    const key = (() => {
      switch (field.name) {
        case "language":
          return "editor.language_helper";
        case "todo_entity":
          return "editor.todo_entity_helper";
        case "segments":
          return "editor.segments_helper";
        case "friction":
          return "editor.friction_helper";
        case "theme":
          return "editor.theme_helper";
        case "labels_csv":
          return "editor.labels_helper";
        case "weights_csv":
          return "editor.weights_helper";
        case "colors_csv":
          return "editor.colors_helper";
        case "label_colors_csv":
          return "editor.label_colors_helper";
        case "hub_text":
          return "editor.hub_text_helper";
        case "hub_color":
          return "editor.hub_color_helper";
        case "text_orientation":
          return "editor.text_orientation_helper";
        case "sound":
          return "editor.sound_helper";
        case "show_status":
          return "editor.show_status_helper";
        case "actions":
          return "editor.actions_helper";
        case "disable_confirm_actions":
          return "editor.disable_confirm_actions_helper";
        case "disable_boost":
          return "editor.disable_boost_helper";
        case "result_entity":
          return "editor.result_entity_helper";
        case "raw_arrays":
          return "editor.advanced_helper";
        default:
          return null;
      }
    })();
    return key ? localize(key, lang) : undefined;
  };

  /** Prefill defaults for first open. hub_text is intentionally NOT
   *  prefilled — otherwise ha-form would re-fill it with the localised
   *  default after every render, making "no hub label" impossible. */
  private _formDefaults(): Record<string, unknown> {
    return { ...STATIC_DEFAULTS };
  }

  /** Snapshot of the last projection passed to ha-form. Used by
   *  _onFormChanged to detect which surface (bindings panel vs Advanced
   *  CSV vs Advanced multi-picker) produced a change — only that surface's
   *  delta is applied, so a stale projection on another surface doesn't
   *  silently overwrite a fresh edit. */
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

    // ── 1. Pull off CSV synthetics ────────────────────────────────────
    const labelsCsv = (next.labels_csv as string | undefined) ?? "";
    const weightsCsv = (next.weights_csv as string | undefined) ?? "";
    const colorsCsvNext = (next.colors_csv as string | undefined) ?? "";
    const labelColorsCsvNext =
      (next.label_colors_csv as string | undefined) ?? "";
    delete next.labels_csv;
    delete next.weights_csv;
    delete next.colors_csv;
    delete next.label_colors_csv;

    // ── 2. Pull off bindings-panel synthetics ─────────────────────────
    // Strip every binding_* and the wrapper key from `next` (defensive,
    // so a stray expandable-name doesn't reach the saved YAML), and
    // capture only the keys whose values *differ* from the last
    // projection — those are the user's edits.
    const bindingDeltas: Record<string, unknown> = {};
    for (const key of Object.keys(next)) {
      if (key.startsWith("binding_") || key === "bindings") {
        if (proj && next[key] !== proj.bindings[key]) {
          bindingDeltas[key] = next[key];
        }
        delete next[key];
      }
    }

    // ── 3. Labels ────────────────────────────────────────────────────
    const segments = next.segments ?? STATIC_DEFAULTS.segments;
    const parsedLabels = parseStringList(labelsCsv);
    if (parsedLabels.length === 0) {
      delete next.labels;
    } else {
      next.labels = parsedLabels.slice(0, segments);
    }

    // ── 3b. Weights: CSV edit > bindings edit > unchanged ────────────
    const weightsCsvChanged =
      proj !== null && weightsCsv !== proj.weightsCsv;
    if (weightsCsvChanged) {
      const parsed = parseWeights(weightsCsv);
      if (parsed.length === 0) delete next.weights;
      else next.weights = parsed.slice(0, segments);
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
        // All-1 → drop the array entirely (default-equal cycling).
        if (out.every((w) => w === 1)) delete next.weights;
        else next.weights = out;
      }
    }

    // ── 4. Colours: CSV edit > bindings edit > unchanged ─────────────
    const colorsCsvChanged =
      proj !== null && colorsCsvNext !== proj.colorsCsv;
    if (colorsCsvChanged) {
      const parsed = parseStringList(colorsCsvNext);
      if (parsed.length === 0) delete next.colors;
      else next.colors = parsed.slice(0, segments);
    } else {
      const colorDeltas = Object.entries(bindingDeltas).filter(
        ([k]) => /^binding_\d+_color$/.test(k),
      );
      if (colorDeltas.length > 0) {
        // Materialise to length = uniqueLabel count, then splice deltas.
        const resolved = this._resolvedColors();
        const out: string[] = resolved.slice();
        for (const [k, v] of colorDeltas) {
          const m = /^binding_(\d+)_color$/.exec(k);
          if (!m) continue;
          const i = parseInt(m[1] ?? "0", 10);
          if (i < 0 || i >= out.length) continue;
          if (isRgbTuple(v)) out[i] = rgbToCss(v);
        }
        next.colors = out;
      }
    }

    // ── 5. Label colours: same diff strategy as colours ──────────────
    const labelColorsCsvChanged =
      proj !== null && labelColorsCsvNext !== proj.labelColorsCsv;
    if (labelColorsCsvChanged) {
      const parsed = parseStringList(labelColorsCsvNext);
      if (parsed.length === 0) delete next.label_colors;
      else next.label_colors = parsed.slice(0, segments);
    } else {
      const lcDeltas = Object.entries(bindingDeltas).filter(([k]) =>
        /^binding_\d+_label_color$/.test(k),
      );
      if (lcDeltas.length > 0) {
        const resolved = this._resolvedLabelColors();
        const out: string[] = resolved.slice();
        for (const [k, v] of lcDeltas) {
          const m = /^binding_(\d+)_label_color$/.exec(k);
          if (!m) continue;
          const i = parseInt(m[1] ?? "0", 10);
          if (i < 0 || i >= out.length) continue;
          if (isRgbTuple(v)) out[i] = rgbToCss(v);
        }
        next.label_colors = out;
      }
    }

    // ── 6. Actions: multi-picker > bindings > unchanged ──────────────
    // Multi-picker output (string[]) replaces the string slots; object-
    // form ActionConfig entries from old _config.actions are appended
    // at the end so they survive a multi-picker save (documented in
    // editor.actions_helper).
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
        // Start from the current array, materialise to uniqueLabel
        // count by padding with null, then splice deltas. Object
        // entries at non-edited indices survive.
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
            // Empty/cleared, but the slot used to hold an object — keep
            // the object (the picker can't represent it; clearing isn't
            // an explicit "delete the YAML action" gesture).
            i < oldActions.length &&
            typeof oldActions[i] === "object" &&
            oldActions[i] !== null
          ) {
            // No-op: out[i] still references the original object via
            // the spread above.
          } else {
            out[i] = null;
          }
        }
        // Trim trailing nulls so the saved YAML stays compact.
        while (out.length > 0 && out[out.length - 1] === null) out.pop();
        if (out.length === 0) delete next.actions;
        else next.actions = out;
      } else if (next.actions === undefined || next.actions === null) {
        // Multi-picker was empty in projection AND no binding edit —
        // preserve any object-only config (e.g. fresh setConfig from
        // YAML with object actions only).
        if (oldObjects.length > 0) next.actions = [...oldObjects];
        else delete next.actions;
      }
    }

    // ── 7. hub_text + defaults stripping ─────────────────────────────
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
    if (next.language === "auto") delete next.language;
    if (next.todo_entity === "" || next.todo_entity == null) {
      delete next.todo_entity;
    }
    // Same strip for result_entity — empty entity selector emits ""
    // and would trip setConfig's regex check (which is also why we
    // can't pass "" through to the dashboard).
    if (next.result_entity === "" || next.result_entity == null) {
      delete next.result_entity;
    }

    // ── 8. Cache CSV verbatim where applicable; regenerate when the
    //       binding side authored the change so the next render's CSV
    //       view stays in sync with the underlying array. ─────────────
    this._labelsText = labelsCsv;
    this._weightsText = weightsCsvChanged
      ? weightsCsv
      : (next.weights ?? []).join(", ");
    this._colorsText = colorsCsvChanged
      ? colorsCsvNext
      : (next.colors ?? []).join(", ");
    this._labelColorsText = labelColorsCsvChanged
      ? labelColorsCsvNext
      : (next.label_colors ?? []).join(", ");

    this._config = next;
    fireEvent(this, "config-changed", { config: next });
  };

  protected override render(): TemplateResult {
    const lang = this._lang();
    // Spread order: defaults first, then user config (overrides),
    // then CSV synthetics (editor-only, never saved), then bindings-
    // panel synthetics derived from the resolved arrays.
    const data: EditorData = {
      ...this._formDefaults(),
      ...this._config,
      // Map "no override" to the Auto sentinel so the dropdown isn't blank.
      language: this._config.language ?? "auto",
      // ha-form's entity selector with multiple:true expects string[];
      // strip object-form ActionConfig entries here so the selector
      // doesn't choke on them. They stay in `_config.actions` and get
      // re-merged on save (see _onFormChanged).
      actions: (this._config.actions ?? []).filter(
        (a): a is string => typeof a === "string",
      ),
      labels_csv: this._labelsText,
      weights_csv: this._weightsText,
      colors_csv: this._colorsText,
      label_colors_csv: this._labelColorsText,
    };
    // Project resolved per-unique-label values into binding_<i>_<suffix>
    // synthetic keys so the bindings panel shows pre-filled pickers.
    // Pickers fall back to fallback grey when a stored colour is a
    // CSS keyword / var(--…) the boundary helper can't parse.
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
    // Snapshot what we just gave ha-form so _onFormChanged can diff
    // against it. Mutating before the await chain is safe — value-changed
    // fires synchronously after the user input.
    this._lastProjection = {
      bindings: bindingsSnapshot,
      actionsStrings: data.actions as ReadonlyArray<string>,
      colorsCsv: this._colorsText,
      labelColorsCsv: this._labelColorsText,
      weightsCsv: this._weightsText,
    };
    // The "Create dedicated helper" button is admin-only — `input_text/
    // create` is wrapped in `require_admin` upstream. Hidden when a
    // helper is already wired (no point), or when the user isn't
    // admin (the WS call would 4xx anyway). Lives in the same
    // custom-Lit slot as the footer hint — single bespoke widget
    // alongside ha-form, per the skill's "ha-form + targeted custom
    // template" pattern.
    const showCreateHelper =
      !this._config.result_entity && this.hass?.user?.is_admin === true;
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
        ${showCreateHelper
          ? html`
              <div class="create-helper-row">
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

  /** Admin-only WS call to create a dedicated `input_text` helper for
   *  this card. Auto-names "Spinning Wheel Result" (HA generates the
   *  slug `spinning_wheel_result`, auto-incrementing on collision so
   *  multi-instance dashboards Just Work); reply.id is the slug, full
   *  entity_id is `input_text.<slug>`. The post-call `_config` mutation
   *  has to happen BEFORE the config-changed event — the dashboard
   *  catches the event to persist storage but does NOT re-invoke
   *  setConfig on the live editor element (the `_config` lifecycle
   *  gotcha in ha-lovelace-card SKILL.md). */
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
        fireEvent(this, "config-changed", { config: this._config });
        // HA's standard toast slot — fire-and-forget, dashboard's
        // <notification-manager> picks it up via the bubbling +
        // composed CustomEvent. Carries the entity_id so the user
        // can copy it for automation wiring without re-checking the
        // helpers list. Same channel HA core's `showToast` helper
        // uses (frontend/src/util/toast.ts on `dev`).
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
