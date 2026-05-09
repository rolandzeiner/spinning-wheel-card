import { LitElement, html } from "lit";
import type { TemplateResult, CSSResultGroup } from "lit";
import { customElement, property, state } from "lit/decorators.js";

import type {
  HaFormSchema,
  HomeAssistant,
  LovelaceCardEditor,
  SpinningWheelCardConfig,
} from "./types";
import { fireEvent } from "./types";
import { editorStyles } from "./styles";
import { localize, resolveLang } from "./localize/localize";

// `labels`, `weights` and `colors` live in the YAML config as arrays. The
// visual editor exposes them as comma-separated text fields under the
// synthetic names `*_csv` — the only way to feed an array into ha-form
// without a dedicated `array` selector. We translate at the boundary in
// _onFormChanged: parse CSV → array, drop the *_csv key, store array.
type EditorData = SpinningWheelCardConfig & {
  labels_csv?: string;
  weights_csv?: string;
  colors_csv?: string;
  label_colors_csv?: string;
};

// Form defaults. Used to prefill the form on first open so dropdowns and
// toggles reflect the values the card actually uses (rather than reading
// undefined → empty/false). Stripped back out in _onFormChanged so the
// saved YAML stays minimal — a key only persists when the user picked a
// non-default value.
//
// The hub_text default is computed dynamically from the active locale so
// that on first-open the form shows the localised hub text instead of
// hard-coded English. Stripping in _onFormChanged uses the same locale,
// so accidentally-saved-default values are still removed.
const STATIC_DEFAULTS = {
  segments: 8,
  friction: "medium" as const,
  text_orientation: "tangent" as const,
  sound: true,
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

@customElement("spinning-wheel-card-editor")
export class SpinningWheelCardEditor
  extends LitElement
  implements LovelaceCardEditor
{
  @property({ attribute: false }) public hass!: HomeAssistant;

  @state() private _config: SpinningWheelCardConfig = {
    type: "spinning-wheel-card",
  };
  // The text fields' values live here so what the user typed is preserved
  // verbatim across re-renders (otherwise the trailing comma they were
  // about to type would round-trip away).
  @state() private _labelsText = "";
  @state() private _weightsText = "";
  @state() private _colorsText = "";
  @state() private _labelColorsText = "";

  public setConfig(config: SpinningWheelCardConfig): void {
    this._config = { ...config };
    this._labelsText = (config.labels ?? []).join(", ");
    this._weightsText = (config.weights ?? []).join(", ");
    this._colorsText = (config.colors ?? []).join(", ");
    this._labelColorsText = (config.label_colors ?? []).join(", ");
  }

  private _lang(): string {
    return resolveLang(this.hass);
  }

  /** Schema is rebuilt per render so option labels (Friction presets,
   *  Label-orientation choices) translate when the user's HA language
   *  changes — ha-form bakes label text into the schema rather than
   *  asking computeLabel for option labels. */
  private _buildSchema(): ReadonlyArray<HaFormSchema> {
    const lang = this._lang();
    return [
      { name: "name", selector: { text: {} } },
      {
        name: "segments",
        selector: { number: { min: 4, max: 24, step: 1, mode: "slider" } },
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
              { value: "high", label: localize("editor.friction_high", lang) },
            ],
          },
        },
      },
      {
        name: "labels_csv",
        selector: { text: { multiline: true } },
      },
      {
        name: "weights_csv",
        selector: { text: {} },
      },
      {
        name: "colors_csv",
        selector: { text: { multiline: true } },
      },
      {
        name: "label_colors_csv",
        selector: { text: { multiline: true } },
      },
      { name: "hub_text", selector: { text: {} } },
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
      },
      { name: "sound", selector: { boolean: {} } },
    ];
  }

  private _computeLabel = (field: { name: string }): string => {
    const lang = this._lang();
    switch (field.name) {
      case "name":
        return localize("editor.name", lang);
      case "segments":
        return localize("editor.segments", lang);
      case "friction":
        return localize("editor.friction", lang);
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
      case "text_orientation":
        return localize("editor.text_orientation", lang);
      case "sound":
        return localize("editor.sound", lang);
      default:
        return field.name;
    }
  };

  private _computeHelper = (field: { name: string }): string | undefined => {
    const lang = this._lang();
    const key = (() => {
      switch (field.name) {
        case "segments":
          return "editor.segments_helper";
        case "friction":
          return "editor.friction_helper";
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
        case "text_orientation":
          return "editor.text_orientation_helper";
        case "sound":
          return "editor.sound_helper";
        default:
          return null;
      }
    })();
    return key ? localize(key, lang) : undefined;
  };

  /** Form-data defaults for prefill on first open. NOTE: `hub_text` is
   *  intentionally NOT prefilled here. If we did, ha-form would
   *  re-fill the input with the localised default ("SPIN"/"DREH") on
   *  every render — including immediately after the user clears it —
   *  making "no hub label" impossible to express through the visual
   *  editor. Instead the form input stays blank until the user types
   *  something, and the helper text mentions the localised default. */
  private _formDefaults(): Record<string, unknown> {
    return { ...STATIC_DEFAULTS };
  }

  private _onFormChanged = (
    ev: CustomEvent<{ value: EditorData }>,
  ): void => {
    const next = { ...ev.detail.value };
    const labelsCsv = next.labels_csv ?? "";
    const weightsCsv = next.weights_csv ?? "";
    const colorsCsv = next.colors_csv ?? "";
    const labelColorsCsv = next.label_colors_csv ?? "";
    delete next.labels_csv;
    delete next.weights_csv;
    delete next.colors_csv;
    delete next.label_colors_csv;

    const segments = next.segments ?? STATIC_DEFAULTS.segments;

    const parsedLabels = parseStringList(labelsCsv);
    if (parsedLabels.length === 0) {
      delete next.labels;
    } else {
      next.labels = parsedLabels.slice(0, segments);
    }

    const parsedWeights = parseWeights(weightsCsv);
    if (parsedWeights.length === 0) {
      delete next.weights;
    } else {
      next.weights = parsedWeights.slice(0, segments);
    }

    const parsedColors = parseStringList(colorsCsv);
    if (parsedColors.length === 0) {
      delete next.colors;
    } else {
      next.colors = parsedColors.slice(0, segments);
    }

    const parsedLabelColors = parseStringList(labelColorsCsv);
    if (parsedLabelColors.length === 0) {
      delete next.label_colors;
    } else {
      next.label_colors = parsedLabelColors.slice(0, segments);
    }

    // hub_text: distinguish "user explicitly cleared the input" (should
    // hide the hub label) from "user never set this field" (should fall
    // through to the localised default). ha-form's text selector emits
    // `undefined` (or `""`) when its input is empty; without the guard
    // below, that's ambiguous with a fresh-config undefined and the card
    // can't tell the user wanted the label hidden. If `_config` already
    // had any string for hub_text and the form now reports missing/null,
    // pin it to "" so the "explicit clear" intent survives.
    const hadHubText = typeof this._config.hub_text === "string";
    const formClearedHubText =
      next.hub_text === undefined || next.hub_text === null;
    if (hadHubText && formClearedHubText) {
      next.hub_text = "";
    }

    // Strip values that match defaults — they came from the form's
    // prefill, not from the user, and shouldn't bloat the saved YAML.
    // hub_text is NOT stripped: it's not in the prefill at all, so any
    // value the user typed (including "") is meaningful and persisted.
    if (next.segments === STATIC_DEFAULTS.segments) delete next.segments;
    if (next.friction === STATIC_DEFAULTS.friction) delete next.friction;
    if (next.text_orientation === STATIC_DEFAULTS.text_orientation) {
      delete next.text_orientation;
    }
    if (next.sound === STATIC_DEFAULTS.sound) delete next.sound;

    this._labelsText = labelsCsv;
    this._weightsText = weightsCsv;
    this._colorsText = colorsCsv;
    this._labelColorsText = labelColorsCsv;
    this._config = next;
    fireEvent(this, "config-changed", { config: next });
  };

  protected override render(): TemplateResult {
    const lang = this._lang();
    // Prefill defaults so the form displays the actual operating values
    // on first open. Spread order matters: defaults first, then user
    // config overrides them. CSV synthetics last (they live only in the
    // editor, not in the saved YAML).
    const data: EditorData = {
      ...this._formDefaults(),
      ...this._config,
      labels_csv: this._labelsText,
      weights_csv: this._weightsText,
      colors_csv: this._colorsText,
      label_colors_csv: this._labelColorsText,
    };
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
        <div class="editor-hint">${localize("editor.footer_hint", lang)}</div>
      </div>
    `;
  }

  static override styles: CSSResultGroup = editorStyles;
}
