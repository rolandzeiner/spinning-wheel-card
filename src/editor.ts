import { LitElement, html, nothing } from "lit";
import type { TemplateResult, CSSResultGroup, PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";

import type {
  ActionConfig,
  HaFormSchema,
  HomeAssistant,
  LovelaceCardEditor,
  SpinningWheelCardConfig,
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
import { normaliseConfig, textOrientationDefault, tidyConfig } from "./config";
import { fetchOpenTodoItems, uniqueTodoItems } from "./todo";

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

/** `colors` / `label_colors` as the Advanced text field shows them. A
 *  `null` entry (= "use theme palette here") is an empty slot between
 *  commas, so the CSV round-trips faithfully: `parseColorList` turns
 *  those empties back into `null`. */
const colourCsv = (list: ReadonlyArray<string | null> | undefined): string =>
  (list ?? []).map((c) => c ?? "").join(", ");

const nonEmpty = <L extends ReadonlyArray<unknown>>(list: L): L | null =>
  list.length > 0 ? list : null;

/** Save `value` under `key`, or drop the key when there is nothing to
 *  save (`null`). */
const put = (config: EditorData, key: string, value: unknown): void => {
  if (value === null) delete config[key];
  else config[key] = value;
};

/** Label chips trimmed, empties dropped (the paste of a trailing comma
 *  can leave one). `null` when no label is left. */
const cleanLabels = (raw: unknown): string[] | null => {
  if (!Array.isArray(raw)) return null;
  return nonEmpty(
    raw
      .filter((l): l is string => typeof l === "string")
      .map((l) => l.trim())
      .filter((l) => l.length > 0),
  );
};

/** What the form was last shown of the fields it only sees a projection
 *  of: the per-label rows, the multi-picker's strings, the CSV texts. */
interface FormProjection {
  bindings: Record<string, unknown>;
  actionsStrings: ReadonlyArray<string>;
  colorsCsv: string;
  labelColorsCsv: string;
  weightsCsv: string;
}

/** Strip the Advanced CSV texts from `next` and return each one the
 *  user changed since the form was last shown; `null` = untouched. */
const takeCsvEdits = (
  next: EditorData,
  shown: FormProjection | null,
): {
  weights: string | null;
  colors: string | null;
  labelColors: string | null;
} => {
  const take = (key: string, was: string | undefined): string | null => {
    const now = (next[key] as string | undefined) ?? "";
    delete next[key];
    return shown !== null && now !== was ? now : null;
  };
  return {
    weights: take("weights_csv", shown?.weightsCsv),
    colors: take("colors_csv", shown?.colorsCsv),
    labelColors: take("label_colors_csv", shown?.labelColorsCsv),
  };
};

/** One edit in the per-label rows: the row, and the value it now holds. */
type RowEdit = readonly [row: number, value: unknown];

/** Strip the per-label row fields (`binding_<row>_<field>`) from `next`
 *  and return those that differ from what the form was last shown — the
 *  user's edits — grouped by field. */
const takeRowEdits = (
  next: EditorData,
  shown: Record<string, unknown> | undefined,
): Map<string, RowEdit[]> => {
  const edits = new Map<string, RowEdit[]>();
  for (const key of Object.keys(next)) {
    if (!key.startsWith("binding_") && key !== "bindings") continue;
    const m = /^binding_(\d+)_(.+)$/.exec(key);
    if (m && shown && next[key] !== shown[key]) {
      const field = m[2] ?? "";
      edits.set(field, [
        ...(edits.get(field) ?? []),
        [Number(m[1]), next[key]],
      ]);
    }
    delete next[key];
  }
  return edits;
};

/** Row weights laid over the resolved ones. `null` when every weight is
 *  1 — default-equal cycling, nothing to save. */
const mergeWeightEdits = (
  resolved: ReadonlyArray<number>,
  edits: ReadonlyArray<RowEdit>,
): number[] | null => {
  const out = resolved.slice();
  for (const [row, value] of edits) {
    if (
      row < out.length &&
      typeof value === "number" &&
      Number.isFinite(value) &&
      value > 0
    ) {
      out[row] = value;
    }
  }
  return out.some((w) => w !== 1) ? out : null;
};

/** Row colour picks laid over the saved sparse list, padded to one slot
 *  per row. Rows the user never picked stay `null`, so theme-derived
 *  positions stay theme-derived. `null` when no explicit colour is left. */
const mergeColourEdits = (
  saved: ReadonlyArray<string | null>,
  rows: number,
  edits: ReadonlyArray<RowEdit>,
): Array<string | null> | null => {
  const out = Array.from({ length: rows }, (_, i) => {
    const c = saved[i];
    return typeof c === "string" && c.length > 0 ? c : null;
  });
  for (const [row, value] of edits) {
    if (row < out.length && isRgbTuple(value)) out[row] = rgbToCss(value);
  }
  return out.some((c) => c !== null) ? out : null;
};

/** Row script picks laid over the saved actions. A cleared row drops its
 *  script but keeps an object-form action — the picker can't represent
 *  one, so clearing it isn't a delete. Trailing empties are trimmed. */
const mergeActionEdits = (
  saved: ReadonlyArray<string | ActionConfig | null>,
  rows: number,
  edits: ReadonlyArray<RowEdit>,
): Array<string | ActionConfig | null> => {
  const out: Array<string | ActionConfig | null> = [...saved];
  while (out.length < rows) out.push(null);
  for (const [row, value] of edits) {
    if (row >= rows) continue;
    if (typeof value === "string" && value.length > 0) out[row] = value;
    else if (typeof out[row] !== "object") out[row] = null;
  }
  while (out.length > 0 && out[out.length - 1] === null) out.pop();
  return out;
};

/** Labels-shrink cascade. When the chip selector emits a shorter labels
 *  array than what was saved, trim every position-keyed secondary array
 *  (weights / colors / label_colors / actions) to the new labels length.
 *  The chip selector is the user's intent channel — deleting a chip
 *  implies its row's weight, colour and action are gone too. Without
 *  this, a stale weights[6] sticks around after labels drops to 4 and
 *  trips setConfig validation (labels.length is fine vs segments=4, but
 *  weights.length=6 isn't). */
const followLabelShrink = (next: EditorData, savedLabels: unknown): void => {
  const was = Array.isArray(savedLabels) ? savedLabels.length : 0;
  const now = Array.isArray(next.labels) ? next.labels.length : 0;
  if (now === 0 || now >= was) return;
  for (const key of ["weights", "colors", "label_colors", "actions"]) {
    const list = next[key];
    if (Array.isArray(list) && list.length > now) {
      next[key] = list.slice(0, now);
    }
  }
};

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
    this._colorsText = colourCsv(config.colors);
    this._labelColorsText = colourCsv(config.label_colors);
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

  /** Uses the card's shared fetch (`./todo`) so editor and runtime agree
   *  on which items become unique-label slots. */
  private async _fetchTodoItems(): Promise<void> {
    const entity = this._config.todo_entity;
    if (!entity || !this.hass?.callWS) return;
    if (this._todoLoading) return;
    this._todoLoading = true;
    try {
      this._todoItems = (await fetchOpenTodoItems(this.hass, entity)) ?? [];
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
      return uniqueTodoItems(this._todoItems).map((item) => item.summary);
    }
    const segments = normaliseConfig(this._config).segments;
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
    const themeName = normaliseConfig(this._config).theme;
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
        selector: { entity: { filter: { domain: "todo" } } },
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
          ]),
      // Label layout expandable — orientation + sizing + radial-position
      // cluster together. `flatten: true` so its inner fields write
      // straight to the top-level config (expandable footgun if missing).
      // text_orientation only renders here when NOT in todo mode (todo
      // forces radial internally); the three sizing/position controls
      // are always available because they benefit todo mode too (long
      // summaries shrink, slider pushes labels off hub or toward rim).
      {
        type: "expandable" as const,
        name: "label_layout",
        title: localize("editor.label_layout", lang),
        flatten: true,
        schema: [
          ...(todoActive
            ? []
            : [
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
          { name: "label_flip", selector: { boolean: {} } },
        ],
      },
      // Integrations expandable — colour sync + TTS announcement. Both
      // are "set up once and forget" hooks that wire the winning
      // segment to other HA entities: lights match the fill colour,
      // speakers announce the label. Independent of Actions / Segment
      // bindings (those still fire). flatten:true so inner fields write
      // straight to top-level config (expandable footgun if missing).
      {
        type: "expandable" as const,
        name: "integrations",
        title: localize("editor.integrations", lang),
        flatten: true,
        schema: [
          {
            name: "light_sync_entities",
            selector: { entity: { multiple: true, filter: { domain: "light" } } },
          },
          // HA's `tts.speak` needs both a TTS engine entity and a
          // media_player target; both must be set for TTS to fire.
          {
            name: "tts_engine",
            selector: { entity: { filter: { domain: "tts" } } },
          },
          {
            name: "tts_announce_entities",
            selector: {
              entity: { multiple: true, filter: { domain: "media_player" } },
            },
          },
        ],
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
              entity: { multiple: true, filter: { domain: "script" } },
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
          selector: { entity: { filter: { domain: "script" } } },
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
    ["label_flip", { label: "editor.label_flip", helper: "editor.label_flip_helper" }],
    ["light_sync_entities", { label: "editor.light_sync_entities", helper: "editor.light_sync_entities_helper" }],
    ["tts_engine", { label: "editor.tts_engine", helper: "editor.tts_engine_helper" }],
    ["tts_announce_entities", { label: "editor.tts_announce_entities", helper: "editor.tts_announce_entities_helper" }],
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

  /** Last projection given to ha-form. _onFormChanged diffs against it
   *  to detect which surface (bindings panel / Advanced CSV / Advanced
   *  multi-picker) produced the change, so a stale projection on one
   *  surface can't overwrite a fresh edit on another. */
  private _lastProjection: FormProjection | null = null;

  private _onFormChanged = (
    ev: CustomEvent<{ value: EditorData }>,
  ): void => {
    const next: EditorData = { ...ev.detail.value };
    const proj = this._lastProjection;

    // 1. The synthetic fields come out first: the Advanced CSV texts
    // and the per-label rows. Of both, only what differs from the last
    // projection — the user's edits — is kept.
    const csv = takeCsvEdits(next, proj);
    const rows = takeRowEdits(next, proj?.bindings);
    const edited = (field: string): ReadonlyArray<RowEdit> =>
      rows.get(field) ?? [];

    // 2. Labels — the chip selector emits string[] directly; only the
    // cleaning runs here. There is no truncation against `segments`:
    // labels and every secondary array (weights / colors / label_colors
    // / actions) stay at their full user-entered length. When `segments`
    // drops below an array length, setConfig validation throws a clear
    // "labels length (N) must not exceed segments (M)" error in the
    // dashboard's red banner — fail-loud beats silent data loss, and
    // the user can either raise segments back or trim the offending
    // array themselves.
    put(next, "labels", cleanLabels(next.labels));

    // 3. Weights and colours: CSV edit > row edit > unchanged.
    this._mergeWeights(next, csv.weights, edited("weight"));
    this._mergeColours(next, "colors", csv.colors, edited("color"));
    this._mergeColours(
      next,
      "label_colors",
      csv.labelColors,
      edited("label_color"),
    );

    // 4. Actions: multi-picker > row edit > unchanged.
    this._mergeActions(next, proj?.actionsStrings ?? [], edited("action"));

    // 5. A deleted label chip takes its row's values with it.
    followLabelShrink(next, this._config.labels);

    // 6. The special cases, then the defaults: tidyConfig drops every
    // value equal to DEFAULTS and every cleared field (config.ts).
    this._settleSpecialFields(next);
    const saved = tidyConfig(next);

    // 7. Cache CSV verbatim; regenerate when the binding side authored
    // the change so the next render's CSV view stays in sync.
    this._weightsText = csv.weights ?? (next.weights ?? []).join(", ");
    this._colorsText = csv.colors ?? colourCsv(next.colors);
    this._labelColorsText = csv.labelColors ?? colourCsv(next.label_colors);

    this._config = saved;
    fireEvent(this, "config-changed", { config: saved });
  };

  private _mergeWeights(
    next: EditorData,
    typedCsv: string | null,
    edits: ReadonlyArray<RowEdit>,
  ): void {
    if (typedCsv !== null) {
      put(next, "weights", nonEmpty(parseWeights(typedCsv)));
    } else if (edits.length > 0) {
      put(next, "weights", mergeWeightEdits(this._resolvedWeights(), edits));
    }
  }

  /** One colour list. An Advanced CSV edit (`typedCsv`) wins over the
   *  per-row picks; with neither, the list stays as saved. Sparse model
   *  — unedited positions stay `null` so a `theme:` change still pulls
   *  them from the new palette. Only positions the user actually picked
   *  (or typed in CSV) become explicit strings. */
  private _mergeColours(
    next: EditorData,
    key: "colors" | "label_colors",
    typedCsv: string | null,
    edits: ReadonlyArray<RowEdit>,
  ): void {
    if (typedCsv !== null) {
      const parsed = parseColorList(typedCsv);
      put(next, key, parsed.some((c) => c !== null) ? parsed : null);
    } else if (edits.length > 0) {
      put(
        next,
        key,
        mergeColourEdits(
          this._config[key] ?? [],
          this._uniqueLabels().length,
          edits,
        ),
      );
    }
  }

  private _mergeActions(
    next: EditorData,
    shown: ReadonlyArray<string>,
    edits: ReadonlyArray<RowEdit>,
  ): void {
    const saved = this._config.actions ?? [];
    const picked = Array.isArray(next.actions)
      ? (next.actions as ReadonlyArray<unknown>).filter(
          (a): a is string => typeof a === "string",
        )
      : null;
    const pickerChanged =
      picked !== null &&
      (picked.length !== shown.length || picked.some((v, i) => v !== shown[i]));
    if (picked !== null && pickerChanged) {
      // Object-form ActionConfig entries are appended after the picker's
      // strings so they survive a multi-picker save.
      const objects = saved.filter((a) => a !== null && typeof a !== "string");
      put(next, "actions", nonEmpty([...picked, ...objects]));
    } else if (edits.length > 0) {
      put(
        next,
        "actions",
        nonEmpty(mergeActionEdits(saved, this._uniqueLabels().length, edits)),
      );
    } else {
      // Neither the picker nor a binding row touched actions: keep them
      // exactly as saved. The picker's projection holds strings only, so
      // writing it back dropped object-form actions and the null
      // placeholders that keep each action at its own segment — toggling
      // an unrelated option moved scripts onto the wrong segment — and
      // turned "no actions" into `actions: []`.
      put(next, "actions", nonEmpty([...saved]));
    }
  }

  /** The fields whose "unset" tidyConfig can't know about. */
  private _settleSpecialFields(next: EditorData): void {
    // A hub text that was set and comes back cleared is saved as "" —
    // "no hub label" — where dropping the key would bring the localised
    // default back.
    if (typeof this._config.hub_text === "string" && next.hub_text == null) {
      next.hub_text = "";
    }
    // text_orientation's default is dynamic, so it isn't in DEFAULTS.
    // The field is only offered outside todo mode, where it is tangent.
    if (next.text_orientation === textOrientationDefault(false)) {
      delete next.text_orientation;
    }
    if (next.language === "auto") delete next.language;
    // Empty entity list = feature off.
    for (const key of ["light_sync_entities", "tts_announce_entities"]) {
      const list = next[key];
      if (!Array.isArray(list) || list.length === 0) delete next[key];
    }
    // Density is meaningless when pegs are off — strip it so it doesn't
    // leak into saved YAML after a toggle-on / toggle-off.
    if (next.pegs !== true) delete next.peg_density;
    // result_entity is owned by the standalone widget — preserve from
    // _config; whatever ha-form emits here is stale.
    put(next, "result_entity", this._config.result_entity || null);
  }

  protected override render(): TemplateResult {
    const lang = this._lang();
    // Defaults filled in (config.ts), then the projections below.
    // hub_text is deliberately not defaulted: its default is localised,
    // and re-filling it on every render would make "no hub label"
    // impossible.
    const data: EditorData = {
      ...normaliseConfig(this._config),
      // Offered only outside todo mode (see _buildSchema), where the
      // dynamic default is always tangent.
      text_orientation:
        this._config.text_orientation ?? textOrientationDefault(false),
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
            .selector=${{ entity: { filter: { domain: "input_text" } } }}
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
