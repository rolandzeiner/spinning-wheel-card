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

// Editor exposes labels/weights/colors arrays as comma-separated *_csv
// fields (no ha-form array selector). _onFormChanged parses CSV → array
// at the boundary.
type EditorData = SpinningWheelCardConfig & {
  labels_csv?: string;
  weights_csv?: string;
  colors_csv?: string;
  label_colors_csv?: string;
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
  // CSV verbatim — preserves the trailing comma the user is about to type.
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
    return this._config?.language ?? resolveLang(this.hass);
  }

  /** Rebuilt per render so option labels translate when language changes —
   *  ha-form bakes label text into the schema. */
  private _buildSchema(): ReadonlyArray<HaFormSchema> {
    const lang = this._lang();
    return [
      { name: "name", selector: { text: {} } },
      {
        name: "language",
        selector: {
          select: {
            mode: "dropdown",
            options: [
              { value: "auto", label: localize("editor.language_auto", lang) },
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
      { name: "show_status", selector: { boolean: {} } },
    ];
  }

  private _computeLabel = (field: { name: string }): string => {
    const lang = this._lang();
    switch (field.name) {
      case "name":
        return localize("editor.name", lang);
      case "language":
        return localize("editor.language", lang);
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
      default:
        return field.name;
    }
  };

  private _computeHelper = (field: { name: string }): string | undefined => {
    const lang = this._lang();
    const key = (() => {
      switch (field.name) {
        case "language":
          return "editor.language_helper";
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

    // Distinguish "explicit clear" (hide label) from "never set"
    // (use localised default). ha-form may emit undefined for empty
    // inputs; pin to "" only when there *was* a previous string.
    const hadHubText = typeof this._config.hub_text === "string";
    const formClearedHubText =
      next.hub_text === undefined || next.hub_text === null;
    if (hadHubText && formClearedHubText) {
      next.hub_text = "";
    }

    // Strip prefilled defaults so saved YAML stays minimal. hub_text
    // isn't stripped — anything the user typed (including "") is meant.
    if (next.segments === STATIC_DEFAULTS.segments) delete next.segments;
    if (next.friction === STATIC_DEFAULTS.friction) delete next.friction;
    if (next.text_orientation === STATIC_DEFAULTS.text_orientation) {
      delete next.text_orientation;
    }
    if (next.sound === STATIC_DEFAULTS.sound) delete next.sound;
    if (next.theme === STATIC_DEFAULTS.theme) delete next.theme;
    if (next.hub_color === STATIC_DEFAULTS.hub_color) delete next.hub_color;
    if (next.show_status === STATIC_DEFAULTS.show_status) delete next.show_status;
    // "auto" is the editor sentinel — strip so saved YAML stays clean.
    if (next.language === "auto") delete next.language;

    this._labelsText = labelsCsv;
    this._weightsText = weightsCsv;
    this._colorsText = colorsCsv;
    this._labelColorsText = labelColorsCsv;
    this._config = next;
    fireEvent(this, "config-changed", { config: next });
  };

  protected override render(): TemplateResult {
    const lang = this._lang();
    // Spread order: defaults first, then user config (overrides),
    // then CSV synthetics (editor-only, never saved).
    const data: EditorData = {
      ...this._formDefaults(),
      ...this._config,
      // Map "no override" to the Auto sentinel so the dropdown isn't blank.
      language: this._config.language ?? "auto",
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
