/**
 * What the visual editor shows, as plain data.
 *
 * The layout is the house one for an editor past about ten options: the
 * title and the segments bare at the top, then collapsed groups, each
 * saying in its header what it is set to. Appearance leads the groups,
 * ahead of the wheel's parts, because its palette colours every segment
 * the list above leaves unset. The rarer options of a group sit below a
 * divider in the same group, never behind another click.
 *
 * Kept apart from the editor element so a node test can read it: the
 * guard in editor-fields.test.ts fails when an option with a default has
 * no field here.
 */
import { DEFAULTS, type NormalisedConfig } from "./config";
import { normalizeFriction, stopSeconds } from "./friction";
import { AVAILABLE_LANGUAGES } from "./localize/localize";
import { THEME_PALETTES } from "./palettes";
import type { HASelector, SelectOption, SpinningWheelCardConfig, Theme } from "./types";

export type Translate = (key: string, vars?: Record<string, string | number>) => string;

/** Config changes a field asks for. `undefined` removes the key. */
export type Changes = Record<string, unknown>;

/** What a field needs to know to draw itself. */
export interface FieldContext {
  config: SpinningWheelCardConfig;
  shown: NormalisedConfig;
  /** Where the segments come from, as picked in the editor. `todo` can be
   *  picked before a list is, so it is not the same as `todo`. */
  source: "list" | "todo";
  /** A to-do list is wired: the card ignores labels and segments. */
  todo: boolean;
  /** Segments on the wheel right now. */
  segmentCount: number;
  /** Entries in `labels`; 0 means the wheel numbers its segments. */
  labelCount: number;
  /** The hub shows text: off once `hub_text` is "", on otherwise. */
  hubTextOn: boolean;
  /** The hub's default text, in the card's language. */
  hubDefault: string;
  /** Home Assistant's language, by its own name. */
  haLanguage: string;
  /** The editor's language, for number formats. */
  lang: string;
  t: Translate;
}

export interface EditorField {
  name: string;
  /** The config key written, where `name` is a projection of it. */
  key?: keyof typeof DEFAULTS;
  selector: HASelector | ((ctx: FieldContext) => HASelector);
  /** Drawn only while this holds. A function rather than ha-form's own
   *  `visible` key, which needs frontend 2026.8. */
  visible?: (ctx: FieldContext) => boolean;
  /** What the form shows. Default: the normalised config's value. */
  get?: (ctx: FieldContext) => unknown;
  /** What a new form value saves. Default: `{ [name]: value }`. */
  set?: (value: unknown, ctx: FieldContext) => Changes;
}

export type GroupItem =
  | EditorField
  | { kind: "divider" }
  /** The result-helper picker. Drawn by the editor, outside ha-form, whose
   *  entity selector drops a helper created a moment ago. */
  | { kind: "result" }
  | { kind: "note"; text: (ctx: FieldContext) => string | null; warning?: boolean };

export const isField = (item: GroupItem): item is EditorField => !("kind" in item);

export type GroupId = "look" | "labels" | "hub" | "lines" | "spin" | "after";

export const GROUPS: ReadonlyArray<{ id: GroupId; icon: string }> = [
  { id: "look", icon: "mdi:palette-outline" },
  { id: "labels", icon: "mdi:format-text" },
  { id: "hub", icon: "mdi:record-circle-outline" },
  { id: "lines", icon: "mdi:dots-circle" },
  { id: "spin", icon: "mdi:rotate-right" },
  { id: "after", icon: "mdi:flag-outline" },
];

/** Speed of a click launch, the middle of the card's 8–16 rad/s. The
 *  friction helper quotes the stop time from it. */
const CLICK_LAUNCH = 12;

// --- tile images ---------------------------------------------------------

interface Ink {
  line: string;
  fill: string;
  fill2: string;
}
const LIGHT: Ink = { line: "#5f6b73", fill: "#d4e9f2", fill2: "#b7d9e8" };
const DARK: Ink = { line: "#c4cbd0", fill: "#1f3f4c", fill2: "#2a5869" };
/** Home Assistant's default primary colour, for the theme-coloured hub. */
const HA_PRIMARY = "#009ac7";

const svg = (body: string): string =>
  `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="58" viewBox="0 0 72 44">${body}</svg>`,
  )}`;

/** A box-select picture, drawn once for light themes and once for dark. */
const picture = (draw: (ink: Ink) => string): { src: string; src_dark: string } => ({
  src: svg(draw(LIGHT)),
  src_dark: svg(draw(DARK)),
});

const ROWS = [0, 1, 2];
const LIST_PICTURE = picture((k) =>
  ROWS.map(
    (i) =>
      `<circle cx="18" cy="${10 + i * 12}" r="2.6" fill="${k.line}"/>` +
      `<rect x="26" y="${8.5 + i * 12}" width="${30 - i * 6}" height="3" rx="1.5" fill="${k.line}"/>`,
  ).join(""),
);
const TODO_PICTURE = picture(
  (k) =>
    `<g fill="none" stroke="${k.line}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">` +
    ROWS.map(
      (i) =>
        `<rect x="14" y="${6.5 + i * 12}" width="7" height="7" rx="1.5"/>` +
        (i < 2 ? `<path d="M15.6 ${10 + i * 12}l1.6 1.6 3-3.2"/>` : "") +
        `<path d="M26 ${10 + i * 12}h${28 - i * 5}"/>`,
    ).join("") +
    "</g>",
);

/** Three slices of a wheel, with the text bars laid around the rim or
 *  along the spokes. */
const orientationPicture = (radial: boolean): { src: string; src_dark: string } =>
  picture((k) =>
    [-40, 0, 40]
      .map(
        (angle, i) =>
          `<g transform="rotate(${angle} 36 42)">` +
          `<path d="M36 42L23 6.3A38 38 0 0 1 49 6.3Z" fill="${i === 1 ? k.fill2 : k.fill}"/>` +
          (radial
            ? `<rect x="34.6" y="9" width="2.8" height="17" rx="1.4" fill="${k.line}"/>`
            : `<rect x="29.5" y="12.5" width="13" height="2.8" rx="1.4" fill="${k.line}"/>`) +
          "</g>",
      )
      .join(""),
  );

const hubPicture = (fill: string, text: string): { src: string; src_dark: string } =>
  picture(
    (k) =>
      `<circle cx="36" cy="27" r="13" fill="${fill}" stroke="${k.line}" stroke-width="1"/>` +
      `<path d="M30 4h12l-6 8z" fill="${fill}" stroke="${k.line}" stroke-width="1" stroke-linejoin="round"/>` +
      `<rect x="30" y="25.6" width="12" height="2.8" rx="1.4" fill="${text}"/>`,
  );

const FULL_PICTURE = picture(
  (k) =>
    `<circle cx="36" cy="22" r="19" fill="${k.fill}" stroke="${k.line}" stroke-width="1.4"/>` +
    `<path d="M36 3v38M17 22h38" stroke="${k.line}" stroke-width="1"/>` +
    `<circle cx="36" cy="22" r="4" fill="${k.line}"/>`,
);
const HALF_PICTURE = picture(
  (k) =>
    `<path d="M14 36A22 22 0 0 1 58 36Z" fill="${k.fill}" stroke="${k.line}" stroke-width="1.4"/>` +
    `<path d="M36 14v22M20.5 20.5L36 36M51.5 20.5L36 36" stroke="${k.line}" stroke-width="1"/>` +
    `<circle cx="36" cy="36" r="4" fill="${k.line}"/>`,
);
const SPIN_PICTURE = picture(
  (k) =>
    `<g fill="none" stroke="${k.line}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">` +
    `<circle cx="34" cy="23" r="15" fill="${k.fill}"/><path d="M34 8v30M19 23h30"/>` +
    `<path d="M55 14a24 24 0 0 1-3 22"/><path d="M48.5 33.5l3.5 3 1.5-4.5"/></g>`,
);
const PICK_PICTURE = picture(
  (k) =>
    `<g fill="none" stroke="${k.line}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">` +
    `<circle cx="36" cy="25" r="14" fill="${k.fill}"/><path d="M36 11v28M22 25h28"/>` +
    `<path d="M31.5 3h9L36 9.5z" fill="${k.line}"/><path d="M17 40c6 4 32 4 38 0"/>` +
    `<path d="M19.5 37l-2.5 3 3.5 1.2M52.5 37l2.5 3-3.5 1.2"/></g>`,
);

/** A palette as a small wheel of its own colours. */
const palettePicture = (colours: ReadonlyArray<string>): { src: string; src_dark: string } => {
  const n = colours.length;
  const point = (i: number): string => {
    const a = -Math.PI / 2 + (i / n) * Math.PI * 2;
    return `${(36 + 20 * Math.cos(a)).toFixed(2)} ${(22 + 20 * Math.sin(a)).toFixed(2)}`;
  };
  return picture(
    (k) =>
      colours
        .map((c, i) => `<path d="M36 22L${point(i)}A20 20 0 0 1 ${point(i + 1)}Z" fill="${c}"/>`)
        .join("") +
      `<circle cx="36" cy="22" r="20" fill="none" stroke="${k.line}" stroke-width=".8"/>`,
  );
};

// --- fields ---------------------------------------------------------------

const TOGGLE: HASelector = { boolean: {} };

const slider = (min: number, max: number, step: number, unit?: string): HASelector => ({
  number: { min, max, step, mode: "slider", ...(unit ? { unit_of_measurement: unit } : {}) },
});

const box = (options: ReadonlyArray<SelectOption>, columns?: number): HASelector => ({
  select: { mode: "box", options, ...(columns ? { box_max_columns: columns } : {}) },
});

const option = (
  ctx: FieldContext,
  value: string,
  key: string,
  image: SelectOption["image"],
  described = true,
): SelectOption => ({
  value,
  label: ctx.t(`editor.${key}`),
  ...(described ? { description: ctx.t(`editor.${key}_desc`) } : {}),
  ...(image ? { image } : {}),
});

/** A picked entity list, or nothing at all once it is emptied. */
const entityList = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.length > 0
    ? value.filter((v): v is string => typeof v === "string")
    : undefined;

const hasSpeakers = (ctx: FieldContext): boolean =>
  (ctx.config.tts_announce_entities?.length ?? 0) > 0;

const THEMES: ReadonlyArray<Theme> = ["default", "pastel", "pride", "neon"];

/** Bare at the top: everyone sets a title. */
export const TOP_FIELDS: ReadonlyArray<EditorField> = [{ name: "name", selector: { text: {} } }];

/** Where the segments come from. The editor keeps the choice, since
 *  picking a to-do list writes nothing until a list is picked. */
export const SOURCE_FIELD: EditorField = {
  name: "source",
  selector: (ctx) =>
    box([
      option(ctx, "list", "source_list", LIST_PICTURE),
      option(ctx, "todo", "source_todo", TODO_PICTURE),
    ]),
  get: (ctx) => ctx.source,
  set: (value) => (value === "list" ? { todo_entity: undefined } : {}),
};

/** Below the label rows. The slider can't go below the number of labels:
 *  the card refuses more labels than segments. */
export const COUNT_FIELD: EditorField = {
  name: "segments",
  selector: (ctx) => slider(Math.max(4, ctx.labelCount), 24, 1),
};

export const TODO_FIELD: EditorField = {
  name: "todo_entity",
  selector: { entity: { filter: { domain: "todo" } } },
  set: (value) => ({ todo_entity: typeof value === "string" && value ? value : undefined }),
};

export const GROUP_ITEMS: Record<GroupId, ReadonlyArray<GroupItem>> = {
  look: [
    {
      name: "theme",
      selector: (ctx) =>
        box(
          THEMES.map((theme) =>
            option(ctx, theme, `theme_${theme}`, palettePicture(THEME_PALETTES[theme]), false),
          ),
          2,
        ),
    },
    {
      name: "shape",
      key: "half_circle",
      selector: (ctx) =>
        box([
          option(ctx, "full", "shape_full", FULL_PICTURE),
          option(ctx, "half", "shape_half", HALF_PICTURE),
        ]),
      get: (ctx) => (ctx.shown.half_circle ? "half" : "full"),
      set: (value) => ({ half_circle: value === "half" }),
    },
    { name: "show_status", selector: TOGGLE },
    { kind: "divider" },
    {
      name: "language",
      selector: (ctx) => ({
        select: {
          mode: "dropdown",
          options: [
            { value: "auto", label: ctx.t("editor.language_auto", { language: ctx.haLanguage }) },
            ...AVAILABLE_LANGUAGES.map((l) => ({ value: l.code, label: l.nativeName })),
          ],
        },
      }),
      get: (ctx) => ctx.config.language ?? "auto",
      set: (value) => ({
        language: typeof value === "string" && value !== "auto" && value ? value : undefined,
      }),
    },
  ],
  labels: [
    { kind: "note", text: (ctx) => (ctx.todo ? ctx.t("editor.labels_todo") : null) },
    {
      name: "text_orientation",
      visible: (ctx) => !ctx.todo,
      selector: (ctx) =>
        box([
          option(ctx, "tangent", "orientation_tangent", orientationPicture(false)),
          option(ctx, "radial", "orientation_radial", orientationPicture(true)),
        ]),
      // The default is tangent everywhere the field is drawn.
      get: (ctx) => ctx.config.text_orientation ?? "tangent",
      set: (value) => ({ text_orientation: value === "radial" ? "radial" : undefined }),
    },
    { name: "label_font_scale", selector: slider(70, 150, 5, "%") },
    { name: "label_auto_fit", visible: (ctx) => !ctx.todo, selector: TOGGLE },
    { kind: "divider" },
    { name: "label_radius_offset", selector: slider(-20, 20, 1, "%") },
    { name: "label_flip", selector: TOGGLE },
  ],
  hub: [
    {
      kind: "note",
      text: (ctx) => (ctx.shown.selector_mode ? ctx.t("editor.hub_pick") : null),
    },
    {
      name: "hub_text_on",
      visible: (ctx) => !ctx.shown.selector_mode,
      selector: TOGGLE,
      get: (ctx) => ctx.hubTextOn,
      set: (value) => ({ hub_text: value === true ? undefined : "" }),
    },
    {
      name: "hub_text",
      visible: (ctx) => !ctx.shown.selector_mode && ctx.hubTextOn,
      selector: { text: {} },
      get: (ctx) => ctx.config.hub_text ?? ctx.hubDefault,
      // Cleared, the field saves "" (no text) rather than dropping the key,
      // which would bring the default back mid-edit.
      set: (value, ctx) => ({
        hub_text:
          typeof value !== "string" || value === ""
            ? ""
            : value === ctx.hubDefault
              ? undefined
              : value,
      }),
    },
    {
      name: "hub_color",
      selector: (ctx) =>
        box([
          option(ctx, "theme", "hub_color_theme", hubPicture(HA_PRIMARY, "#ffffff")),
          option(ctx, "black", "hub_color_black", hubPicture("#141414", "#ffffff")),
          option(ctx, "white", "hub_color_white", hubPicture("#ffffff", "#141414")),
        ]),
    },
  ],
  lines: [
    { name: "segment_borders", selector: TOGGLE },
    { name: "pegs", selector: TOGGLE },
    {
      // Pegs per segment, boundary peg included: the config counts only
      // the extra ones.
      name: "peg_count",
      key: "peg_density",
      visible: (ctx) => ctx.shown.pegs,
      selector: slider(1, 5, 1),
      get: (ctx) => ctx.shown.peg_density + 1,
      set: (value) => ({ peg_density: Number(value) - 1 }),
    },
  ],
  spin: [
    {
      name: "mode",
      key: "selector_mode",
      selector: (ctx) =>
        box([
          option(ctx, "spin", "mode_spin", SPIN_PICTURE),
          option(ctx, "pick", "mode_pick", PICK_PICTURE),
        ]),
      get: (ctx) => (ctx.shown.selector_mode ? "pick" : "spin"),
      set: (value) => ({ selector_mode: value === "pick" }),
    },
    {
      name: "friction",
      visible: (ctx) => !ctx.shown.selector_mode,
      selector: slider(1, 10, 1),
      // Pre-v1.2 presets ("medium") show as their level.
      get: (ctx) => normalizeFriction(ctx.config.friction),
    },
    {
      name: "boost",
      key: "disable_boost",
      visible: (ctx) => !ctx.shown.selector_mode,
      selector: TOGGLE,
      get: (ctx) => !ctx.shown.disable_boost,
      set: (value) => ({ disable_boost: value !== true }),
    },
    { name: "sound", selector: TOGGLE },
  ],
  after: [
    {
      name: "confirm",
      key: "disable_confirm_actions",
      selector: TOGGLE,
      get: (ctx) => !ctx.shown.disable_confirm_actions,
      set: (value) => ({ disable_confirm_actions: value !== true }),
    },
    { kind: "result" },
    {
      name: "light_sync_entities",
      selector: { entity: { multiple: true, filter: { domain: "light" } } },
      get: (ctx) => ctx.config.light_sync_entities ?? [],
      set: (value) => ({ light_sync_entities: entityList(value) }),
    },
    {
      name: "tts_announce_entities",
      selector: { entity: { multiple: true, filter: { domain: "media_player" } } },
      get: (ctx) => ctx.config.tts_announce_entities ?? [],
      // No speakers, no engine: it would only sit in the YAML unseen.
      set: (value) => {
        const list = entityList(value);
        return list
          ? { tts_announce_entities: list }
          : { tts_announce_entities: undefined, tts_engine: undefined };
      },
    },
    {
      name: "tts_engine",
      visible: hasSpeakers,
      selector: { entity: { filter: { domain: "tts" } } },
      set: (value) => ({ tts_engine: typeof value === "string" && value ? value : undefined }),
    },
    {
      kind: "note",
      warning: true,
      text: (ctx) =>
        hasSpeakers(ctx) && !ctx.config.tts_engine ? ctx.t("editor.tts_engine_missing") : null,
    },
    { kind: "divider" },
    { name: "wheel_context", selector: TOGGLE },
  ],
};

/** Every field the editor can draw, for the guard test and label lookups. */
export const ALL_FIELDS: ReadonlyArray<EditorField> = [
  ...TOP_FIELDS,
  SOURCE_FIELD,
  COUNT_FIELD,
  TODO_FIELD,
  ...Object.values(GROUP_ITEMS).flatMap((items) => items.filter(isField)),
];

export const fieldSelector = (field: EditorField, ctx: FieldContext): HASelector =>
  typeof field.selector === "function" ? field.selector(ctx) : field.selector;

export const fieldValue = (field: EditorField, ctx: FieldContext): unknown =>
  field.get ? field.get(ctx) : (ctx.shown as Record<string, unknown>)[field.name];

export const fieldChanges = (field: EditorField, value: unknown, ctx: FieldContext): Changes =>
  field.set ? field.set(value, ctx) : { [field.name]: value };

// --- helpers and summaries -----------------------------------------------

const formatSeconds = (seconds: number, lang: string): string =>
  new Intl.NumberFormat(lang, { maximumFractionDigits: seconds >= 3 ? 0 : 1 }).format(seconds);

function countHelper(ctx: FieldContext): string {
  const count = ctx.shown.segments;
  const labels = ctx.labelCount;
  if (labels === 0) return ctx.t("editor.segments_numbered", { count });
  if (labels >= count) return ctx.t("editor.segments_each");
  if (labels === 1) return ctx.t("editor.segments_repeat_one", { count });
  return ctx.t("editor.segments_repeat", { labels, count });
}

/** The line under a field, where it says more than the label does. Some
 *  follow the config: the stop time under the friction, the peg total
 *  under the pegs per segment. */
export function fieldHelper(name: string, ctx: FieldContext): string | undefined {
  const { shown, t } = ctx;
  switch (name) {
    case "segments":
      return countHelper(ctx);
    case "label_font_scale":
      return shown.label_auto_fit || ctx.todo
        ? t("editor.label_font_scale_helper_fit")
        : t("editor.label_font_scale_helper");
    case "label_flip":
      return ctx.todo || ctx.config.text_orientation === "radial"
        ? t("editor.label_flip_helper_radial")
        : t("editor.label_flip_helper_tangent");
    case "hub_text":
      return t("editor.hub_text_helper", { text: ctx.hubDefault });
    case "peg_count":
      return t("editor.peg_count_helper", {
        count: ctx.segmentCount * (shown.peg_density + 1),
      });
    case "friction": {
      const level = normalizeFriction(ctx.config.friction);
      return t("editor.friction_helper", {
        seconds: formatSeconds(stopSeconds(level, CLICK_LAUNCH), ctx.lang),
      });
    }
  }
  const key = `editor.${name}_helper`;
  const helper = t(key);
  // localize() echoes a missing key; an undefined helper draws nothing.
  return helper === key ? undefined : helper;
}

/** Each group's summary parts; `null` parts are left out. */
const SUMMARY: Record<GroupId, (ctx: FieldContext) => Array<string | null>> = {
  look: ({ shown, t }) => [
    t(`editor.theme_${shown.theme}`),
    t(shown.half_circle ? "editor.shape_half" : "editor.shape_full"),
    shown.show_status ? null : t("editor.summary.no_status"),
  ],
  labels: (ctx) => {
    const radial = ctx.todo || ctx.config.text_orientation === "radial";
    return [
      ctx.t(radial ? "editor.orientation_radial" : "editor.orientation_tangent"),
      `${ctx.shown.label_font_scale} %`,
      ctx.shown.label_auto_fit || ctx.todo ? ctx.t("editor.summary.auto_fit") : null,
    ];
  },
  hub: (ctx) => {
    const text =
      ctx.shown.selector_mode || !ctx.hubTextOn ? "" : (ctx.config.hub_text ?? ctx.hubDefault);
    return [
      text ? ctx.t("editor.summary.quote", { text }) : ctx.t("editor.summary.no_text"),
      ctx.t(`editor.hub_color_${ctx.shown.hub_color}`),
    ];
  },
  lines: ({ shown, t }) => {
    const per = shown.peg_density + 1;
    let pegs = t("editor.summary.no_pegs");
    if (shown.pegs)
      pegs = per === 1 ? t("editor.summary.pegs_one") : t("editor.summary.pegs", { count: per });
    return [
      t(shown.segment_borders ? "editor.summary.borders" : "editor.summary.no_borders"),
      pegs,
    ];
  },
  spin: ({ config, shown, t }) => [
    t(shown.selector_mode ? "editor.mode_pick" : "editor.mode_spin"),
    shown.selector_mode
      ? null
      : t("editor.summary.friction", { level: normalizeFriction(config.friction) }),
    t(shown.sound ? "editor.summary.sound" : "editor.summary.silent"),
  ],
  after: (ctx) => {
    const { config, shown, t } = ctx;
    const lights = config.light_sync_entities?.length ?? 0;
    let lightText: string | null = null;
    if (lights > 0)
      lightText =
        lights === 1
          ? t("editor.summary.lights_one")
          : t("editor.summary.lights", { count: lights });
    return [
      t(shown.disable_confirm_actions ? "editor.summary.no_confirm" : "editor.summary.confirm"),
      config.result_entity ? t("editor.summary.result") : null,
      lightText,
      hasSpeakers(ctx) ? t("editor.summary.announce") : null,
    ];
  },
};

/**
 * The line under a collapsed group: what it is set to, so nobody has to
 * open a panel to find out. Three values at most.
 */
export const groupSummary = (id: GroupId, ctx: FieldContext): string =>
  SUMMARY[id](ctx)
    .filter((part): part is string => part !== null)
    .slice(0, 3)
    .join(" · ");

// --- the segment rows -----------------------------------------------------

/**
 * The slot of each label: its place among the distinct labels, in order of
 * first appearance. The card looks colours and actions up by slot, so two
 * segments with one label share both; weights it reads by position.
 */
export const slotsOf = (labels: ReadonlyArray<string>): Map<string, number> => {
  const slots = new Map<string, number>();
  for (const label of labels) if (!slots.has(label)) slots.set(label, slots.size);
  return slots;
};

/** A list the card cycles (`[a, b]` over four reads `a b a b`), written out
 *  to `n` entries. An empty list is `n` × `fill`. */
export const expandCycle = <T>(list: ReadonlyArray<T> | undefined, n: number, fill: T): T[] =>
  Array.from({ length: n }, (_, i) =>
    list && list.length > 0 ? (list[i % list.length] ?? fill) : fill,
  );

/** The list, or nothing when every entry is `fill`: an unset list means the same. */
const unlessAll = <T>(list: T[], fill: T): T[] | undefined =>
  list.some((v) => v !== fill) ? list : undefined;

const BY_SLOT = ["colors", "label_colors", "actions"] as const;

/**
 * The lists, after the labels change from `before` to `after`. `from[p]` is
 * the position in `before` that `after[p]` came from, or -1 for a new one.
 * Colours and actions follow their label to its new slot, weights their
 * row to its new position, so a moved, renamed or removed row keeps its
 * settings and leaves the others theirs.
 */
export function remapLists(
  config: SpinningWheelCardConfig,
  before: ReadonlyArray<string>,
  after: ReadonlyArray<string>,
  from: ReadonlyArray<number>,
): Changes {
  const oldSlots = slotsOf(before);
  const newSlots = slotsOf(after);
  const firstAt = new Map<number, number>();
  after.forEach((label, p) => {
    const slot = newSlots.get(label) ?? 0;
    if (!firstAt.has(slot)) firstAt.set(slot, p);
  });
  const changes: Changes = { labels: after.length > 0 ? [...after] : undefined };
  for (const key of BY_SLOT) {
    const list = config[key];
    if (!list || list.length === 0) continue;
    const old = expandCycle<unknown>(list, oldSlots.size, null);
    const next = Array.from({ length: newSlots.size }, (_, slot) => {
      const origin = from[firstAt.get(slot) ?? -1] ?? -1;
      if (origin < 0) return null;
      return old[oldSlots.get(before[origin] ?? "") ?? -1] ?? null;
    });
    changes[key] = unlessAll<unknown>(next, null);
  }
  if (config.weights && config.weights.length > 0) {
    const old = expandCycle(config.weights, before.length, 1);
    const next = after.map((_, p) => {
      const origin = from[p] ?? -1;
      return origin < 0 ? 1 : (old[origin] ?? 1);
    });
    changes.weights = unlessAll(next, 1);
  }
  return changes;
}

/** One slot of a by-slot list set, the rest written out as they are. */
export function setSlot(
  list: ReadonlyArray<unknown> | undefined,
  slots: number,
  slot: number,
  value: unknown,
): unknown[] | undefined {
  const next = expandCycle<unknown>(list, slots, null);
  next[slot] = value ?? null;
  return unlessAll<unknown>(next, null);
}

/** One row's weight set, the rest written out as they are. */
export function setWeight(
  weights: ReadonlyArray<number> | undefined,
  rows: number,
  row: number,
  weight: number,
): number[] | undefined {
  const next = expandCycle(weights, rows, 1);
  next[row] = weight;
  return unlessAll(next, 1);
}
