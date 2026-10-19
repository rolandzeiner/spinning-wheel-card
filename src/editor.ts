/**
 * Visual editor.
 *
 * Laid out in the house tiers for an editor past about ten options: the
 * title and the segments bare at the top, then one collapsed group per
 * concern, each saying in its header what it is set to. What the groups
 * hold is data, in editor-fields.ts; this file draws it.
 *
 * Every field goes through ha-form, so it inherits theme, i18n, dark mode
 * and a11y. The bespoke parts are the segment rows (a list, each row its
 * own small form), the colour swatches (Home Assistant ships no selector
 * that takes a CSS colour) and the result-helper picker.
 */
import { LitElement, html, nothing } from "lit";
import type { CSSResultGroup, PropertyValues, TemplateResult } from "lit";
import { property, state } from "lit/decorators.js";

import { DEFAULTS, normaliseConfig, tidyConfig } from "./config";
import {
  COUNT_FIELD,
  type Changes,
  type EditorField,
  type FieldContext,
  fieldChanges,
  fieldHelper,
  fieldSelector,
  fieldValue,
  GROUP_ITEMS,
  GROUPS,
  type GroupId,
  type GroupItem,
  groupSummary,
  isField,
  remapLists,
  setSlot,
  setWeight,
  slotsOf,
  SOURCE_FIELD,
  TODO_FIELD,
  TOP_FIELDS,
} from "./editor-fields";
import { normalizeFriction } from "./friction";
import { AVAILABLE_LANGUAGES, localize, resolveLang } from "./localize/localize";
import { DEFAULT_LABEL_COLOR, THEME_PALETTES } from "./palettes";
import { editorStyles } from "./styles";
import { fetchOpenTodoItems } from "./todo";
import type {
  ActionConfig,
  HASelector,
  HomeAssistant,
  LovelaceCardEditor,
  SpinningWheelCardConfig,
  TodoItem,
} from "./types";
import { fireEvent } from "./types";

type Data = Record<string, unknown>;

/** Parse a CSS colour into [r, g, b] for the swatch. Handles `#RRGGBB`,
 *  `#RGB` and `rgb(r, g, b)`; anything else (named colours, `var(--…)`,
 *  hsl()) is null and keeps working in YAML. Exported for unit tests. */
export const cssToRgb = (s: string | undefined): readonly [number, number, number] | null => {
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
    return [parseInt(a + a, 16), parseInt(b + b, 16), parseInt(c + c, 16)] as const;
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

/** `#rrggbb` for the colour input, which takes nothing else. */
const toHex = (colour: string): string => {
  const rgb = cssToRgb(colour);
  return rgb ? `#${rgb.map((c) => c.toString(16).padStart(2, "0")).join("")}` : "#888888";
};

/** Black or white text on `fill`, by the card's own rule (its `_isLight`). */
const autoText = (fill: string): string => {
  const rgb = cssToRgb(fill);
  if (!rgb) return DEFAULT_LABEL_COLOR;
  const lin = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const l = 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
  return l > 0.5 ? "#1a1a1a" : "#ffffff";
};

/** A cycled list's entry for `slot`, if it holds a real value there. */
const entryAt = <T>(list: ReadonlyArray<T | null> | undefined, slot: number): T | null =>
  list && list.length > 0 ? (list[slot % list.length] ?? null) : null;

/** Lists capped at `segments` by the card's validation. */
const LISTS = ["labels", "weights", "colors", "label_colors", "actions"] as const;

export class SpinningWheelCardEditor extends LitElement implements LovelaceCardEditor {
  @property({ attribute: false }) public hass!: HomeAssistant;

  @state() private _config: SpinningWheelCardConfig = { type: "spinning-wheel-card" };
  /** Groups whose panel is open, so their bodies are built only then. A
   *  record of what the panel did, never an instruction to it: binding
   *  `expanded` pins the panel's height (see _renderGroup). */
  @state() private _open = new Set<GroupId>();
  /** The segment row whose settings are showing; one at a time. */
  @state() private _row: number | null = null;
  /** The source picked in the editor. "todo" can be picked before a list
   *  is, which writes nothing yet; null follows the config. */
  @state() private _source: "list" | "todo" | null = null;
  /** The hub-text switch, kept here so clearing the text field doesn't
   *  switch it off under the cursor. null follows the config. */
  @state() private _hubTextOn: boolean | null = null;
  /** Whether ha-expansion-panel is registered. Home Assistant loads it
   *  lazily, so a card editor can't count on it. Until it is, the groups
   *  are drawn open, and a hidden ha-form expandable loads it. */
  @state() private _panels = customElements.get("ha-expansion-panel") !== undefined;

  /** Survives the post-create empty value-changed race: the entity picker
   *  emits "" briefly after a programmatic update because the helper just
   *  created isn't in `hass.states` yet. Session-scoped; the saved
   *  `result_entity` is the durable check on the next open. */
  @state() private _helperCreatedThisSession = false;

  /** The editor's copy of the card's todo fetch, so the rows are the items
   *  the wheel shows. null until the first answer. */
  @state() private _todoItems: ReadonlyArray<TodoItem> | null = null;
  private _todoLastEntity: string | null = null;
  private _todoLastEntityState: string | null = null;
  private _todoLoading = false;

  public setConfig(config: SpinningWheelCardConfig): void {
    this._config = { ...config };
    // The editor's own choices give way to a config that settles them: a
    // wired list, or hub text that is set. They outlive one that doesn't,
    // so clearing the text field doesn't switch the hub text off.
    if (config.todo_entity) this._source = null;
    if (config.hub_text !== "") this._hubTextOn = null;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    if (!this._panels) {
      void customElements.whenDefined("ha-expansion-panel").then(() => {
        this._panels = true;
      });
    }
  }

  /** The editor speaks Home Assistant's language. */
  private _lang(): string {
    return resolveLang(this.hass);
  }

  /** The card's language: its `language` option, else Home Assistant's. */
  private _cardLang(): string {
    return this._config.language ?? this._lang();
  }

  private _t = (key: string, vars?: Record<string, string | number>): string =>
    localize(key, this._lang(), vars);

  protected override updated(_changed: PropertyValues): void {
    const entityId = this._config.todo_entity ?? null;
    if (entityId !== this._todoLastEntity) {
      this._todoLastEntity = entityId;
      this._todoItems = null;
      this._todoLastEntityState = null;
    }
    if (entityId) {
      const stateNow = this.hass?.states?.[entityId]?.state ?? null;
      if (stateNow !== this._todoLastEntityState) {
        this._todoLastEntityState = stateNow;
        if (stateNow !== null) void this._fetchTodoItems();
      }
    }
  }

  /** The card's own fetch (`./todo`), so editor and wheel agree on which
   *  items become segments. */
  private async _fetchTodoItems(): Promise<void> {
    const entity = this._config.todo_entity;
    if (!entity || !this.hass?.callWS || this._todoLoading) return;
    this._todoLoading = true;
    try {
      this._todoItems = ((await fetchOpenTodoItems(this.hass, entity)) ?? []).slice(0, 24);
    } catch (err) {
      console.warn("[spinning-wheel-card editor] todo/item/list failed:", err);
      this._todoItems = [];
    } finally {
      this._todoLoading = false;
    }
  }

  private _ctx(): FieldContext {
    const config = this._config;
    const shown = normaliseConfig(config);
    const todo = Boolean(config.todo_entity);
    const haCode = this._lang().toLowerCase().split(/[-_]/)[0] ?? "en";
    return {
      config,
      shown,
      todo,
      source: this._source ?? (todo ? "todo" : "list"),
      segmentCount: todo ? (this._todoItems?.length ?? 0) : shown.segments,
      labelCount: config.labels?.length ?? 0,
      hubTextOn: this._hubTextOn ?? config.hub_text !== "",
      hubDefault: localize("hub.default_text", this._cardLang()),
      haLanguage: AVAILABLE_LANGUAGES.find((l) => l.code === haCode)?.nativeName ?? haCode,
      lang: this._lang(),
      t: this._t,
    };
  }

  /** Merge `changes` in and save the tidy result. `undefined` removes a key. */
  private _save(changes: Changes): void {
    const next: Data = { ...this._config, ...changes };
    // A pre-v1.2 friction preset is saved as its level on the first edit.
    if (typeof next.friction === "string") next.friction = normalizeFriction(next.friction);
    // The density means nothing with pegs off; don't leave it in the YAML.
    if (next.pegs !== true) delete next.peg_density;
    // The card refuses a list longer than `segments`, in to-do mode too,
    // where `segments` otherwise goes unused. A row edit on a long list
    // raises it rather than producing a config the card throws on.
    const longest = Math.max(
      0,
      ...LISTS.map((key) => {
        const list = next[key];
        return Array.isArray(list) ? list.length : 0;
      }),
    );
    const segments = typeof next.segments === "number" ? next.segments : DEFAULTS.segments;
    if (longest > segments) next.segments = Math.min(24, longest);
    const saved = tidyConfig(next as SpinningWheelCardConfig);
    this._config = saved;
    fireEvent(this, "config-changed", { config: saved });
  }

  // --- plain fields ------------------------------------------------------

  /**
   * One ha-form over some of the fields.
   *
   * Several forms share one config, so each reports only the fields the
   * user touched, diffed against what it was shown. Replacing the config
   * with a form's whole value would drop every key another form owns.
   */
  private _renderForm(
    fields: ReadonlyArray<EditorField>,
    ctx: FieldContext,
  ): TemplateResult | typeof nothing {
    const visible = fields.filter((field) => !field.visible || field.visible(ctx));
    if (visible.length === 0) return nothing;
    const data: Data = Object.fromEntries(visible.map((f) => [f.name, fieldValue(f, ctx)]));
    const schema = visible.map((f) => ({ name: f.name, selector: fieldSelector(f, ctx) }));
    return html`<ha-form
      .hass=${this.hass}
      .data=${data}
      .schema=${schema}
      .computeLabel=${(s: { name: string }) => this._t(`editor.${s.name}`)}
      .computeHelper=${(s: { name: string }) => fieldHelper(s.name, ctx)}
      @value-changed=${(ev: CustomEvent<{ value: Data }>) => {
        ev.stopPropagation();
        const next = ev.detail.value;
        let changes: Changes = {};
        for (const field of visible) {
          if (next[field.name] === data[field.name]) continue;
          changes = { ...changes, ...fieldChanges(field, next[field.name], ctx) };
          this._noteChoice(field.name, next[field.name]);
        }
        if (Object.keys(changes).length > 0) this._save(changes);
      }}
    ></ha-form>`;
  }

  /** The choices the editor keeps for itself rather than in the config. */
  private _noteChoice(name: string, value: unknown): void {
    if (name === "source") {
      this._source = value === "todo" ? "todo" : "list";
      this._row = null;
    } else if (name === "hub_text_on") {
      this._hubTextOn = value === true;
    } else if (name === "hub_text") {
      // Someone typing in the field has the switch on, even when the text
      // they just cleared saves as "no text".
      this._hubTextOn = true;
    }
  }

  /** A group's items: runs of fields share one form, the rest break it. */
  private _renderItems(items: ReadonlyArray<GroupItem>, ctx: FieldContext): unknown[] {
    const out: unknown[] = [];
    let run: EditorField[] = [];
    const flush = (): void => {
      if (run.length > 0) out.push(this._renderForm(run, ctx));
      run = [];
    };
    for (const item of items) {
      if (isField(item)) {
        run.push(item);
        continue;
      }
      flush();
      if (item.kind === "divider") out.push(html`<hr class="ed-divider" />`);
      else if (item.kind === "result") out.push(this._renderResult(ctx));
      else {
        const text = item.text(ctx);
        if (text === null) continue;
        out.push(
          item.warning
            ? html`<ha-alert alert-type="warning">${text}</ha-alert>`
            : html`<p class="ed-note">${text}</p>`,
        );
      }
    }
    flush();
    return out;
  }

  // --- groups ------------------------------------------------------------

  /**
   * A collapsible group. Its body is built only while it is open: behind a
   * closed panel the forms would otherwise still render on every edit.
   *
   * `expanded` is deliberately not bound. When clicked, the panel fires
   * expanded-will-change, renders its slot, measures it, pins that height
   * in pixels and animates to it; only transitionend unpins it. Bound to
   * this editor's state, the re-render sets `expanded` before the panel
   * measures, nothing animates, transitionend never fires, and whatever
   * the body grows by later spills over the panels below.
   */
  private _renderGroup(group: { id: GroupId; icon: string }, ctx: FieldContext): TemplateResult {
    return html`<ha-expansion-panel
      outlined
      .header=${this._t(`editor.groups.${group.id}`)}
      .secondary=${groupSummary(group.id, ctx)}
      @expanded-will-change=${(ev: CustomEvent<{ expanded: boolean }>) => {
        ev.stopPropagation();
        const open = new Set(this._open);
        if (ev.detail.expanded) open.add(group.id);
        else open.delete(group.id);
        this._open = open;
      }}
    >
      <ha-icon slot="leading-icon" icon=${group.icon}></ha-icon>
      ${
        this._open.has(group.id)
          ? html`<div class="ed-body">${this._renderItems(GROUP_ITEMS[group.id], ctx)}</div>`
          : nothing
      }
    </ha-expansion-panel>`;
  }

  /** Before ha-expansion-panel exists: the groups drawn open, and a hidden
   *  ha-form expandable, which makes Home Assistant load the panel. */
  private _renderFallback(ctx: FieldContext): TemplateResult {
    return html`
      <ha-form
        hidden
        .hass=${this.hass}
        .data=${{}}
        .schema=${[{ type: "expandable", name: "panel_loader", title: "", flatten: true, schema: [] }]}
      ></ha-form>
      ${GROUPS.map(
        (group) => html`<section class="ed-fallback">
          <h3 class="ed-heading">${this._t(`editor.groups.${group.id}`)}</h3>
          <p class="ed-hint">${groupSummary(group.id, ctx)}</p>
          ${this._renderItems(GROUP_ITEMS[group.id], ctx)}
        </section>`,
      )}
    `;
  }

  // --- segments ------------------------------------------------------------

  /** The rows: the labels, or the open to-do items while a list is wired. */
  private _rowLabels(ctx: FieldContext): ReadonlyArray<string> {
    return ctx.todo
      ? (this._todoItems ?? []).map((item) => item.summary)
      : (ctx.config.labels ?? []);
  }

  private _renderSegments(ctx: FieldContext): TemplateResult {
    return html`<section class="ed-segments" aria-labelledby="ed-segments-heading">
      <h3 class="ed-heading" id="ed-segments-heading">${this._t("editor.segments_heading")}</h3>
      ${this._renderForm([SOURCE_FIELD], ctx)}
      ${ctx.source === "list" ? this._renderLabelList(ctx) : this._renderTodo(ctx)}
    </section>`;
  }

  private _renderLabelList(ctx: FieldContext): TemplateResult {
    const labels = this._rowLabels(ctx);
    const full = labels.length >= 24;
    return html`
      ${
        labels.length > 0
          ? this._renderRows(labels, ctx, false)
          : html`<p class="ed-empty">
            ${this._t("editor.no_labels", { count: ctx.shown.segments })}
          </p>`
      }
      <div class="ed-add">
        <ha-button appearance="plain" .disabled=${full} @click=${() => this._addRow(ctx)}>
          <ha-icon icon="mdi:plus" slot="icon" aria-hidden="true"></ha-icon>
          ${this._t("editor.add_segment")}
        </ha-button>
        ${full ? html`<span class="ed-hint">${this._t("editor.max_segments")}</span>` : nothing}
      </div>
      ${this._renderForm([COUNT_FIELD], ctx)}
    `;
  }

  private _renderTodo(ctx: FieldContext): TemplateResult {
    const items = this._todoItems;
    let body: TemplateResult | typeof nothing = nothing;
    if (!ctx.todo) body = html`<p class="ed-note">${this._t("editor.todo_none")}</p>`;
    else if (items !== null && items.length === 0) {
      body = html`<ha-alert alert-type="warning">${this._t("editor.todo_empty")}</ha-alert>`;
    } else if (items !== null) {
      body = html`${this._renderRows(this._rowLabels(ctx), ctx, true)}
        <p class="ed-hint">${this._t("editor.todo_count", { count: items.length })}</p>`;
    }
    return html`${this._renderForm([TODO_FIELD], ctx)}${body}`;
  }

  private _renderRows(
    labels: ReadonlyArray<string>,
    ctx: FieldContext,
    locked: boolean,
  ): TemplateResult {
    const slots = slotsOf(labels);
    return html`<ul class="ed-rows">
      ${labels.map((label, row) =>
        this._renderRow(label, row, slots.get(label) ?? row, labels, slots.size, ctx, locked),
      )}
    </ul>`;
  }

  /** The fill the card paints a slot in: its own colour, else the palette's. */
  private _fill(slot: number, ctx: FieldContext): string {
    const palette = THEME_PALETTES[ctx.shown.theme];
    return entryAt(ctx.config.colors, slot) || (palette[slot % palette.length] ?? "#888888");
  }

  private _textColour(slot: number, ctx: FieldContext): string {
    return entryAt(ctx.config.label_colors, slot) || autoText(this._fill(slot, ctx));
  }

  private _rowTitle(label: string): string {
    return label || this._t("editor.unlabelled");
  }

  /** The collapsed row's line: its weight when it isn't 1, and its action. */
  private _rowSummary(row: number, slot: number, ctx: FieldContext): string {
    const weight = this._weight(row, ctx);
    const action = entryAt<string | ActionConfig>(ctx.config.actions, slot);
    let actionText = this._t("editor.row.no_action");
    if (typeof action === "string" && action) {
      const name = this.hass?.states?.[action]?.attributes.friendly_name;
      actionText = typeof name === "string" && name ? name : action;
    } else if (action && typeof action === "object") {
      actionText = this._t("editor.row.action_yaml");
    }
    const shown = new Intl.NumberFormat(this._lang(), { maximumFractionDigits: 1 }).format(weight);
    return [
      weight === 1 ? null : this._t("editor.row.weight_summary", { weight: shown }),
      actionText,
    ]
      .filter((part): part is string => part !== null)
      .join(" · ");
  }

  /** A row's weight. The card reads weights by position, cycling them,
   *  so a row's is the one at its own position. */
  private _weight(row: number, ctx: FieldContext): number {
    const w = entryAt(ctx.config.weights, row);
    return typeof w === "number" && w > 0 ? w : 1;
  }

  /**
   * One segment in the list.
   *
   * A row rather than a panel: one open at a time, its settings inline
   * beneath it. The head is a real button with aria-expanded; moving and
   * removing are icon buttons beside it, so neither needs the row open.
   * To-do rows are the list's items: they can't be renamed or moved here.
   */
  private _renderRow(
    label: string,
    row: number,
    slot: number,
    labels: ReadonlyArray<string>,
    slots: number,
    ctx: FieldContext,
    locked: boolean,
  ): TemplateResult {
    const open = this._row === row;
    const title = this._rowTitle(label);
    return html`<li class="ed-row ${open ? "open" : ""}">
      <div class="ed-row-head">
        <button
          class="ed-row-main"
          type="button"
          aria-expanded=${open ? "true" : "false"}
          @click=${() => {
            this._row = open ? null : row;
          }}
        >
          <span
            class="ed-dot"
            style="background:${this._fill(slot, ctx)};color:${this._textColour(slot, ctx)}"
            aria-hidden="true"
            >Aa</span
          >
          <span class="ed-row-titles">
            <span class="ed-row-name">${title}</span>
            <span class="ed-row-summary">${this._rowSummary(row, slot, ctx)}</span>
          </span>
          <ha-icon class="ed-chevron" icon="mdi:chevron-down" aria-hidden="true"></ha-icon>
        </button>
        ${
          locked
            ? nothing
            : html`<ha-icon-button
                .label=${`${this._t("editor.move_up")}: ${title}`}
                .disabled=${row === 0}
                @click=${() => this._moveRow(row, -1, ctx)}
              >
                <ha-icon icon="mdi:arrow-up" aria-hidden="true"></ha-icon>
              </ha-icon-button>
              <ha-icon-button
                .label=${`${this._t("editor.move_down")}: ${title}`}
                .disabled=${row === labels.length - 1}
                @click=${() => this._moveRow(row, 1, ctx)}
              >
                <ha-icon icon="mdi:arrow-down" aria-hidden="true"></ha-icon>
              </ha-icon-button>
              <ha-icon-button
                .label=${`${this._t("editor.remove")}: ${title}`}
                @click=${() => this._removeRow(row, ctx)}
              >
                <ha-icon icon="mdi:delete-outline" aria-hidden="true"></ha-icon>
              </ha-icon-button>`
        }
      </div>
      ${open ? this._renderRowBody(label, row, slot, labels, slots, ctx, locked) : nothing}
    </li>`;
  }

  private _renderRowBody(
    label: string,
    row: number,
    slot: number,
    labels: ReadonlyArray<string>,
    slots: number,
    ctx: FieldContext,
    locked: boolean,
  ): TemplateResult {
    const title = this._rowTitle(label);
    const action = entryAt<string | ActionConfig>(ctx.config.actions, slot);
    const yamlAction = action !== null && typeof action === "object";
    const top: Array<{ name: string; selector: HASelector }> = locked
      ? []
      : [{ name: "label", selector: { text: {} } }];
    const bottom: Array<{ name: string; selector: HASelector }> = [
      { name: "weight", selector: { number: { min: 0.1, max: 99, step: 0.1, mode: "box" } } },
      // An action object from YAML has no place in a script picker; it is
      // left alone rather than overwritten by an empty one.
      ...(yamlAction
        ? []
        : [
            {
              name: "action",
              selector: { entity: { filter: { domain: "script" } } } as HASelector,
            },
          ]),
    ];
    const data: Data = {
      label,
      weight: this._weight(row, ctx),
      action: typeof action === "string" ? action : "",
    };
    const form = (schema: Array<{ name: string; selector: HASelector }>): TemplateResult =>
      html`<ha-form
        .hass=${this.hass}
        .data=${data}
        .schema=${schema}
        .computeLabel=${(s: { name: string }) => this._t(`editor.row.${s.name}`)}
        .computeHelper=${(s: { name: string }) => {
          const key = `editor.row.${s.name}_helper`;
          const helper = this._t(key);
          return helper === key ? undefined : helper;
        }}
        @value-changed=${(ev: CustomEvent<{ value: Data }>) => {
          ev.stopPropagation();
          const next = ev.detail.value;
          if (next.label !== data.label) this._renameRow(row, next.label, labels, ctx);
          else if (next.weight !== data.weight) this._setWeight(row, next.weight, labels, ctx);
          else if (next.action !== data.action) this._setAction(slot, slots, next.action, ctx);
        }}
      ></ha-form>`;
    return html`<div class="ed-row-body">
      ${top.length > 0 ? form(top) : nothing}
      <div class="ed-colours">
        ${this._renderSwatch(slot, slots, "colors", title, ctx)}
        ${this._renderSwatch(slot, slots, "label_colors", title, ctx)}
      </div>
      <p class="ed-hint">${this._t("editor.row.text_helper")}</p>
      ${form(bottom)}
      ${yamlAction ? html`<p class="ed-note">${this._t("editor.row.action_yaml_note")}</p>` : nothing}
    </div>`;
  }

  /**
   * A colour swatch. Both @input and @change are wired: @input recolours
   * the preview while the picker is dragged, @change is what some
   * platforms fire when it closes. The reset shows only once a colour is
   * set, and resetting saves no colour for the slot at all.
   */
  private _renderSwatch(
    slot: number,
    slots: number,
    key: "colors" | "label_colors",
    title: string,
    ctx: FieldContext,
  ): TemplateResult {
    const custom = entryAt(ctx.config[key], slot);
    const shown = key === "colors" ? this._fill(slot, ctx) : this._textColour(slot, ctx);
    const name = this._t(key === "colors" ? "editor.row.fill" : "editor.row.text");
    const set = (ev: Event): void =>
      this._setColour(slot, slots, key, (ev.target as HTMLInputElement).value, ctx);
    return html`<div class="ed-color">
      <label class="swatch">
        <input
          type="color"
          aria-label=${`${name}: ${title}`}
          .value=${toHex(shown)}
          @input=${set}
          @change=${set}
        />
        <span class="ed-color-text">
          <span>${name}</span>
          <span class="ed-hint">
            ${custom ?? this._t(key === "colors" ? "editor.row.palette" : "editor.row.automatic")}
          </span>
        </span>
      </label>
      ${
        custom
          ? html`<ha-button
            appearance="plain"
            aria-label=${`${this._t("editor.row.reset")}: ${name}`}
            @click=${() => this._setColour(slot, slots, key, null, ctx)}
          >
            ${this._t("editor.row.reset")}
          </ha-button>`
          : nothing
      }
    </div>`;
  }

  // --- row edits -----------------------------------------------------------

  private _relabel(
    before: ReadonlyArray<string>,
    after: ReadonlyArray<string>,
    from: ReadonlyArray<number>,
    ctx: FieldContext,
  ): void {
    this._save(remapLists(ctx.config, before, after, from));
  }

  private _addRow(ctx: FieldContext): void {
    const labels = this._rowLabels(ctx);
    const added = [...labels, this._t("editor.new_segment", { number: labels.length + 1 })];
    this._relabel(labels, added, [...labels.map((_, i) => i), -1], ctx);
    // A new row opens, so its label field is the next thing on screen.
    this._row = labels.length;
  }

  private _removeRow(row: number, ctx: FieldContext): void {
    const labels = this._rowLabels(ctx);
    const keep = labels.map((_, i) => i).filter((i) => i !== row);
    this._relabel(
      labels,
      keep.map((i) => labels[i] ?? ""),
      keep,
      ctx,
    );
    // The open row goes with the one removed, or moves up with its own.
    if (this._row === row) this._row = null;
    else if (this._row !== null && this._row > row) this._row -= 1;
  }

  private _moveRow(row: number, delta: -1 | 1, ctx: FieldContext): void {
    const labels = this._rowLabels(ctx);
    const target = row + delta;
    if (target < 0 || target >= labels.length) return;
    const from = labels.map((_, i) => i);
    from[row] = target;
    from[target] = row;
    this._relabel(
      labels,
      from.map((i) => labels[i] ?? ""),
      from,
      ctx,
    );
    // The settings stay with the segment they belong to, not with the slot.
    if (this._row === row) this._row = target;
    else if (this._row === target) this._row = row;
  }

  private _renameRow(
    row: number,
    value: unknown,
    labels: ReadonlyArray<string>,
    ctx: FieldContext,
  ): void {
    const after = labels.map((label, i) =>
      i === row ? (typeof value === "string" ? value : "") : label,
    );
    this._relabel(
      labels,
      after,
      labels.map((_, i) => i),
      ctx,
    );
  }

  private _setWeight(
    row: number,
    value: unknown,
    labels: ReadonlyArray<string>,
    ctx: FieldContext,
  ): void {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return;
    this._save({ weights: setWeight(ctx.config.weights, labels.length, row, value) });
  }

  private _setAction(slot: number, slots: number, value: unknown, ctx: FieldContext): void {
    const script = typeof value === "string" && value ? value : null;
    this._save({ actions: setSlot(ctx.config.actions, slots, slot, script) });
  }

  private _setColour(
    slot: number,
    slots: number,
    key: "colors" | "label_colors",
    value: string | null,
    ctx: FieldContext,
  ): void {
    this._save({ [key]: setSlot(ctx.config[key], slots, slot, value) });
  }

  // --- result helper -------------------------------------------------------

  /** Outside ha-form: its entity selector emits "" right after a
   *  programmatic update, which would drop a helper created a moment ago. */
  private _renderResult(ctx: FieldContext): TemplateResult {
    const showCreate =
      !this._helperCreatedThisSession &&
      !ctx.config.result_entity &&
      this.hass?.user?.is_admin === true;
    return html`<div class="ed-result">
      <ha-selector
        .hass=${this.hass}
        .selector=${{ entity: { filter: { domain: "input_text" } } }}
        .value=${ctx.config.result_entity ?? ""}
        .label=${this._t("editor.result_entity")}
        .helper=${this._t("editor.result_entity_helper")}
        @value-changed=${this._onResultEntityChanged}
      ></ha-selector>
      ${
        showCreate
          ? html`<div>
            <ha-button appearance="plain" @click=${this._createResultHelper}>
              <ha-icon icon="mdi:plus" slot="icon" aria-hidden="true"></ha-icon>
              ${this._t("editor.result_entity_create")}
            </ha-button>
          </div>`
          : nothing
      }
    </div>`;
  }

  private _onResultEntityChanged = (ev: CustomEvent<{ value: unknown }>): void => {
    // Some frontend versions catch unhandled value-changed events at the
    // dialog level and try to merge them; keep it ours.
    ev.stopPropagation();
    const value = ev.detail.value;
    this._save({ result_entity: typeof value === "string" && value ? value : undefined });
  };

  /** Admin-only WS call for a helper of the wheel's own. HA numbers slug
   *  collisions, so several wheels can each have one. */
  private _createResultHelper = async (): Promise<void> => {
    if (!this.hass?.callWS) return;
    try {
      const reply = await this.hass.callWS<{ id: string; name: string }>({
        type: "input_text/create",
        name: this._t("editor.result_entity_default_name"),
        max: 255,
        icon: "mdi:dharmachakra",
      });
      if (reply?.id) {
        const entityId = `input_text.${reply.id}`;
        this._helperCreatedThisSession = true;
        this._save({ result_entity: entityId });
        // HA's toast channel: <notification-manager> catches the event.
        fireEvent(this, "hass-notification", {
          message: this._t("editor.result_entity_created", { entity: entityId }),
        });
      }
    } catch (err) {
      console.warn("[spinning-wheel-card editor] input_text/create failed:", err);
      fireEvent(this, "hass-notification", {
        message: this._t("editor.result_entity_create_failed"),
      });
    }
  };

  protected override render(): TemplateResult {
    const ctx = this._ctx();
    return html`<div class="ed">
      ${this._renderForm(TOP_FIELDS, ctx)} ${this._renderSegments(ctx)}
      <div class="ed-groups">
        ${this._panels ? GROUPS.map((group) => this._renderGroup(group, ctx)) : this._renderFallback(ctx)}
      </div>
    </div>`;
  }

  static override styles: CSSResultGroup = editorStyles;
}

// Idempotent registration — see the note at the bottom of
// spinning-wheel-card.ts. Without the guard, a duplicate Lovelace
// resource load aborts module init before the card class registers.
if (!customElements.get("spinning-wheel-card-editor")) {
  customElements.define("spinning-wheel-card-editor", SpinningWheelCardEditor);
}
