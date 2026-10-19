/**
 * @vitest-environment happy-dom
 *
 * What the editor shows and what it writes back.
 *
 * The editor is several ha-forms over one config, plus the segment rows
 * and the result-helper picker. Each form reports only what the user
 * changed in it, and every save goes through tidyConfig, so the saved
 * YAML holds what differs from the defaults and nothing else.
 *
 * happy-dom has no ha-expansion-panel, so the groups are drawn open
 * here (the editor's fallback); editor-panels.test.ts covers the panels.
 */
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import "../src/editor";
import en from "../src/localize/languages/en.json";
import type { SpinningWheelCardConfig } from "../src/types";

const TYPE = "custom:spinning-wheel-card";

type Config = Record<string, unknown>;
type Field = { name: string; selector?: Record<string, Record<string, unknown>> };
type Form = HTMLElement & {
  data: Config;
  schema: Field[];
  computeLabel(field: { name: string }): string;
  computeHelper(field: { name: string }): string | undefined;
};
type Editor = HTMLElement & {
  hass: unknown;
  setConfig(config: SpinningWheelCardConfig): void;
  updateComplete: Promise<boolean>;
};

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** What the editor asked of hass, and what `callWS` answers. */
const ws = { calls: [] as unknown[], todoItems: [] as unknown[], fail: false };

const fakeHass = (over: Config = {}): Config => ({
  language: "en",
  states: {},
  user: { is_admin: true },
  callWS: async (msg: { type: string }) => {
    ws.calls.push(msg);
    if (ws.fail) throw new Error("ws failed");
    if (msg.type === "todo/item/list") return { items: ws.todoItems };
    return { id: "wheel_result" };
  },
  ...over,
});

beforeEach(() => {
  document.body.innerHTML = "";
  Object.assign(ws, { calls: [], todoItems: [], fail: false });
  vi.restoreAllMocks();
});

/** An open editor, and the events it has fired so far. */
interface Session {
  editor: Editor;
  root: ShadowRoot;
  /** Every `config-changed` payload, oldest first. */
  saved: Config[];
  toasts: string[];
  /** The form that draws `name`, or undefined when no form draws it. */
  form: (name: string) => Form | undefined;
  /** Every field name drawn by any form, rows excluded. */
  fields: () => string[];
  /** Change one field the way ha-form does; returns the latest save. */
  change: (name: string, value: unknown) => Promise<Config>;
  settle: () => Promise<void>;
  /** The segment rows' names, in order. */
  rows: () => string[];
  /** Open (or close) row `index` by clicking its head. */
  toggleRow: (index: number) => Promise<void>;
  /** The open row's form for `name`. */
  rowForm: (name: string) => Form | undefined;
  changeRow: (name: string, value: unknown) => Promise<Config>;
  /** Click the row's icon button: 0 up, 1 down, 2 remove. */
  rowButton: (index: number, which: 0 | 1 | 2) => Promise<Config>;
}

async function open(config: Config = {}, hass: Config = {}): Promise<Session> {
  const editor = document.createElement("spinning-wheel-card-editor") as Editor;
  editor.hass = fakeHass(hass);
  editor.setConfig({ type: TYPE, ...config });
  document.body.append(editor);
  const settle = async (): Promise<void> => {
    await editor.updateComplete;
    await flush();
    await editor.updateComplete;
  };
  await settle();
  const root = editor.shadowRoot!;

  const saved: Config[] = [];
  const toasts: string[] = [];
  editor.addEventListener("config-changed", (event) =>
    saved.push((event as CustomEvent<{ config: Config }>).detail.config),
  );
  editor.addEventListener("hass-notification", (event) =>
    toasts.push((event as CustomEvent<{ message: string }>).detail.message),
  );
  const forms = (scope: ParentNode): Form[] => [...scope.querySelectorAll<Form>("ha-form")];
  const outside = (): Form[] =>
    forms(root).filter((f) => !f.closest(".ed-row-body") && !f.hasAttribute("hidden"));
  const form = (name: string): Form | undefined =>
    outside().find((f) => f.schema.some((field) => field.name === name));
  const emit = async (target: Form, name: string, value: unknown): Promise<Config> => {
    target.dispatchEvent(
      new CustomEvent("value-changed", { detail: { value: { ...target.data, [name]: value } } }),
    );
    await settle();
    return saved[saved.length - 1] ?? {};
  };
  const rowForm = (name: string): Form | undefined =>
    forms(root.querySelector(".ed-row-body") ?? root).find(
      (f) => f.closest(".ed-row-body") && f.schema.some((field) => field.name === name),
    );
  return {
    editor,
    root,
    saved,
    toasts,
    form,
    settle,
    fields: () => outside().flatMap((f) => f.schema.map((field) => field.name)),
    change: (name, value) => emit(form(name)!, name, value),
    rows: () => [...root.querySelectorAll(".ed-row-name")].map((el) => el.textContent ?? ""),
    toggleRow: async (index) => {
      root.querySelectorAll<HTMLButtonElement>(".ed-row-main")[index].click();
      await settle();
    },
    rowForm,
    changeRow: (name, value) => emit(rowForm(name)!, name, value),
    rowButton: async (index, which) => {
      const head = root.querySelectorAll(".ed-row-head")[index];
      head.querySelectorAll<HTMLElement>("ha-icon-button")[which].click();
      await settle();
      return saved[saved.length - 1] ?? {};
    },
  };
}

/** A colour swatch's input in the open row: 0 fill, 1 text. */
const swatch = (session: Session, which: 0 | 1): HTMLInputElement =>
  session.root.querySelectorAll<HTMLInputElement>(".ed-row-body input[type=color]")[which];

const pickColour = async (session: Session, which: 0 | 1, value: string): Promise<Config> => {
  const input = swatch(session, which);
  input.value = value;
  input.dispatchEvent(new Event("change"));
  await session.settle();
  return session.saved[session.saved.length - 1] ?? {};
};

describe("editor save", () => {
  it("writes only the changed field, type first", async () => {
    const saved = await (await open()).change("show_status", false);
    expect(saved).toEqual({ type: TYPE, show_status: false });
    expect(Object.keys(saved)[0]).toBe("type");
  });

  it("drops a field set back to its default", async () => {
    const saved = await (await open({ segments: 6, sound: false })).change("segments", 8);
    expect(saved).toEqual({ type: TYPE, sound: false });
  });

  it("keeps each action on its own segment through an unrelated edit", async () => {
    const session = await open({ labels: ["a", "b"], actions: [null, "script.b"] });
    expect((await session.change("sound", false)).actions).toEqual([null, "script.b"]);
  });

  it("keeps object-form actions through an unrelated edit", async () => {
    const action = { action: "perform-action", perform_action: "light.toggle" };
    const session = await open({ labels: ["a"], actions: [action] });
    expect((await session.change("sound", false)).actions).toEqual([action]);
  });

  it("migrates a pre-v1.2 friction preset to its level", async () => {
    const session = await open({ friction: "high" });
    expect(session.form("friction")!.data.friction).toBe(7);
    expect((await session.change("sound", false)).friction).toBe(7);
  });
});

describe("fields that show a projection", () => {
  it("draw the two disable_ options as switches that are on by default", async () => {
    const session = await open();
    expect(session.form("boost")!.data.boost).toBe(true);
    expect(session.form("confirm")!.data.confirm).toBe(true);
    expect(await session.change("boost", false)).toEqual({ type: TYPE, disable_boost: true });
    expect(await session.change("confirm", false)).toEqual({
      type: TYPE,
      disable_boost: true,
      disable_confirm_actions: true,
    });
    expect(await session.change("boost", true)).toEqual({
      type: TYPE,
      disable_confirm_actions: true,
    });
  });

  it("save the shape and the interaction as their booleans", async () => {
    const session = await open();
    expect(session.form("shape")!.data.shape).toBe("full");
    expect(session.form("mode")!.data.mode).toBe("spin");
    expect((await session.change("shape", "half")).half_circle).toBe(true);
    expect((await session.change("mode", "pick")).selector_mode).toBe(true);
    // Friction and momentum mean nothing without spinning.
    expect(session.fields()).not.toContain("friction");
    expect(session.fields()).not.toContain("boost");
    expect(session.fields()).toContain("sound");
  });

  it("count pegs per segment, boundary peg included, and only with pegs on", async () => {
    const session = await open({ pegs: true, peg_density: 3 });
    expect(session.form("peg_count")!.data.peg_count).toBe(4);
    expect(await session.change("peg_count", 2)).toEqual({ type: TYPE, pegs: true });
    expect(await session.change("pegs", false)).toEqual({ type: TYPE });
    expect(session.fields()).not.toContain("peg_count");
  });

  it("save the text orientation only when it isn't the default", async () => {
    const session = await open();
    expect(session.form("text_orientation")!.data.text_orientation).toBe("tangent");
    expect((await session.change("text_orientation", "radial")).text_orientation).toBe("radial");
    expect("text_orientation" in (await session.change("text_orientation", "tangent"))).toBe(false);
  });

  it("show the language in effect and save following Home Assistant as no language", async () => {
    const session = await open({ language: "de" });
    const field = session.form("language")!;
    expect(field.data.language).toBe("de");
    const options = (field.schema.find((f) => f.name === "language")!.selector!.select.options ??
      []) as Array<{ value: string; label: string }>;
    expect(options[0]).toEqual({ value: "auto", label: "Same as Home Assistant (English)" });
    expect("language" in (await session.change("language", "auto"))).toBe(false);
    expect(session.form("language")!.data.language).toBe("auto");
  });

  it("switch the hub text off as an empty text, and keep the field while it is edited", async () => {
    const session = await open();
    expect(session.form("hub_text")!.data.hub_text).toBe("SPIN");
    expect(await session.change("hub_text", "GO")).toEqual({ type: TYPE, hub_text: "GO" });
    // Typed back to the default, the key goes again.
    expect(await session.change("hub_text", "SPIN")).toEqual({ type: TYPE });
    // Cleared, it saves "no text", and the field stays for the next letter.
    expect(await session.change("hub_text", undefined)).toEqual({ type: TYPE, hub_text: "" });
    expect(session.form("hub_text_on")?.data.hub_text_on).toBe(true);
    expect(session.fields()).toContain("hub_text");
    expect(await session.change("hub_text_on", false)).toEqual({ type: TYPE, hub_text: "" });
    expect(session.fields()).not.toContain("hub_text");
    // Back on, it shows the default again and saves nothing.
    expect(await session.change("hub_text_on", true)).toEqual({ type: TYPE });
    expect(session.form("hub_text")?.data.hub_text).toBe("SPIN");
  });

  it("open with the hub text switched off when it was saved off", async () => {
    const session = await open({ hub_text: "" });
    expect(session.form("hub_text_on")!.data.hub_text_on).toBe(false);
    expect(session.fields()).not.toContain("hub_text");
  });

  it("save an emptied entity list as the feature being off, engine included", async () => {
    const session = await open({
      light_sync_entities: ["light.a"],
      tts_announce_entities: ["media_player.a"],
      tts_engine: "tts.a",
    });
    await session.change("light_sync_entities", []);
    expect(await session.change("tts_announce_entities", [])).toEqual({ type: TYPE });
    expect(session.fields()).not.toContain("tts_engine");
  });

  it("warn while speakers have no engine to speak with", async () => {
    const session = await open({ tts_announce_entities: ["media_player.a"] });
    expect(session.fields()).toContain("tts_engine");
    expect(session.root.querySelector("ha-alert")?.textContent).toContain(
      en.editor.tts_engine_missing,
    );
    await session.change("tts_engine", "tts.a");
    expect(session.root.querySelector("ha-alert")).toBeNull();
  });
});

describe("the segment rows", () => {
  const labels = ["a", "b", "c"];

  it("list the labels, each with its weight and action", async () => {
    const session = await open({
      labels,
      weights: [2, 1, 1],
      actions: ["script.a", { action: "none" }],
    });
    expect(session.rows()).toEqual(labels);
    const summaries = [...session.root.querySelectorAll(".ed-row-summary")].map(
      (el) => el.textContent,
    );
    expect(summaries).toEqual([
      "Weight 2 · script.a",
      en.editor.row.action_yaml,
      // The card cycles a list shorter than the labels: c gets a's action.
      "script.a",
    ]);
  });

  it("open one row at a time, with its label, weight and action", async () => {
    const session = await open({ labels });
    await session.toggleRow(1);
    expect(session.rowForm("label")!.data).toMatchObject({ label: "b", weight: 1, action: "" });
    await session.toggleRow(2);
    expect(session.root.querySelectorAll(".ed-row-body")).toHaveLength(1);
    expect(session.rowForm("label")!.data.label).toBe("c");
  });

  it("keep a row's settings through a rename", async () => {
    const session = await open({ labels: ["a", "b"], colors: ["#111111", "#222222"] });
    await session.toggleRow(0);
    expect(await session.changeRow("label", "z")).toEqual({
      type: TYPE,
      labels: ["z", "b"],
      colors: ["#111111", "#222222"],
    });
  });

  const full = {
    labels,
    weights: [1, 2, 3],
    colors: ["#111111", "#222222", "#333333"],
    label_colors: ["#444444", "#555555", "#666666"],
    actions: ["script.a", "script.b", "script.c"],
  };

  it("move a row with all its settings", async () => {
    const session = await open(full);
    expect(await session.rowButton(2, 0)).toEqual({
      type: TYPE,
      labels: ["a", "c", "b"],
      weights: [1, 3, 2],
      colors: ["#111111", "#333333", "#222222"],
      label_colors: ["#444444", "#666666", "#555555"],
      actions: ["script.a", "script.c", "script.b"],
    });
  });

  it("remove a row with all its settings", async () => {
    const session = await open(full);
    expect(await session.rowButton(1, 2)).toEqual({
      type: TYPE,
      labels: ["a", "c"],
      weights: [1, 3],
      colors: ["#111111", "#333333"],
      label_colors: ["#444444", "#666666"],
      actions: ["script.a", "script.c"],
    });
  });

  it("add a row, open it, and make room for it on the wheel", async () => {
    const eight = ["1", "2", "3", "4", "5", "6", "7", "8"];
    const session = await open({ labels: eight, weights: [2] });
    session.root.querySelector<HTMLElement>(".ed-add ha-button")!.click();
    await session.settle();
    const saved = session.saved[session.saved.length - 1];
    expect(saved.labels).toEqual([...eight, "Segment 9"]);
    expect(saved.segments).toBe(9);
    // A cycled list is written out, so the new row doesn't shift it.
    expect(saved.weights).toEqual([2, 2, 2, 2, 2, 2, 2, 2, 1]);
    expect(session.rowForm("label")!.data.label).toBe("Segment 9");
  });

  it("pick a fill colour for one label and leave the others to the palette", async () => {
    const session = await open({ labels });
    await session.toggleRow(1);
    expect((await pickColour(session, 0, "#123456")).colors).toEqual([null, "#123456", null]);
    expect(session.root.querySelector(".ed-row-body ha-button")?.textContent).toContain(
      en.editor.row.reset,
    );
    session.root.querySelector<HTMLElement>(".ed-row-body ha-button")!.click();
    await session.settle();
    expect(session.saved[session.saved.length - 1]).toEqual({ type: TYPE, labels });
  });

  it("write a cycled colour list out before changing one entry", async () => {
    const session = await open({ labels, colors: ["#ff0000"] });
    await session.toggleRow(1);
    expect(swatch(session, 0).value).toBe("#ff0000");
    expect((await pickColour(session, 0, "#00ff00")).colors).toEqual([
      "#ff0000",
      "#00ff00",
      "#ff0000",
    ]);
  });

  it("pick a text colour", async () => {
    const session = await open({ labels });
    await session.toggleRow(2);
    const saved = await pickColour(session, 1, "#090909");
    expect(saved.label_colors).toEqual([null, null, "#090909"]);
    expect(saved.colors).toBeUndefined();
  });

  it("save a weight, ignore one that isn't positive, and drop them all at 1", async () => {
    const session = await open({ labels });
    await session.toggleRow(1);
    expect((await session.changeRow("weight", 3)).weights).toEqual([1, 3, 1]);
    expect((await session.changeRow("weight", 0)).weights).toEqual([1, 3, 1]);
    expect((await session.changeRow("weight", 1)).weights).toBeUndefined();
  });

  it("save a script, and drop it again when cleared", async () => {
    const session = await open({ labels });
    await session.toggleRow(1);
    expect((await session.changeRow("action", "script.b")).actions).toEqual([
      null,
      "script.b",
      null,
    ]);
    expect((await session.changeRow("action", undefined)).actions).toBeUndefined();
  });

  it("leave an action object alone and offer no script picker for it", async () => {
    const action = { action: "navigate", navigation_path: "/lovelace/0" };
    const session = await open({ labels: ["a", "b"], actions: ["script.a", action] });
    await session.toggleRow(1);
    expect(session.rowForm("action")).toBeUndefined();
    expect(session.root.querySelector(".ed-row-body .ed-note")?.textContent).toBe(
      en.editor.row.action_yaml_note,
    );
    expect((await session.changeRow("weight", 2)).actions).toEqual(["script.a", action]);
  });

  it("share one colour between rows with the same label, as the card does", async () => {
    const session = await open({ labels: ["a", "b", "a"] });
    await session.toggleRow(2);
    expect((await pickColour(session, 0, "#abcdef")).colors).toEqual(["#abcdef", null]);
  });

  it("keep the segment count at or above the number of labels", async () => {
    const ten = Array.from({ length: 10 }, (_, i) => `L${i}`);
    const session = await open({ labels: ten, segments: 12 });
    const count = session.form("segments")!;
    expect(count.schema[0].selector!.number.min).toBe(10);
    expect(count.computeHelper({ name: "segments" })).toBe(
      "Your 10 labels repeat across 12 segments.",
    );
  });

  it("say what the wheel shows without labels", async () => {
    const session = await open();
    expect(session.root.querySelector(".ed-empty")?.textContent?.trim()).toBe(
      "No labels yet. The wheel shows the numbers 1 to 8.",
    );
    expect(session.rows()).toEqual([]);
  });
});

describe("with a todo list", () => {
  const list = (state: string): Config => ({
    states: { "todo.chores": { state, attributes: {} } },
  });

  it("has one row per open item, and hides what the list overrides", async () => {
    ws.todoItems = [
      { summary: "Dishes" },
      { summary: "Laundry", status: "completed" },
      { summary: "Bins" },
      { summary: "Dishes" },
    ];
    const session = await open({ todo_entity: "todo.chores", labels: ["ignored"] }, list("2"));
    expect(ws.calls).toEqual([{ type: "todo/item/list", entity_id: "todo.chores" }]);
    expect(session.rows()).toEqual(["Dishes", "Bins"]);
    // The items are the list's: no moving or removing them here.
    expect(session.root.querySelectorAll(".ed-row-head ha-icon-button")).toHaveLength(0);
    const names = session.fields();
    expect(names).not.toContain("segments");
    expect(names).not.toContain("text_orientation");
    expect(names).not.toContain("label_auto_fit");
    expect(names).toContain("friction");
  });

  it("saves a row edit against the items, and makes room for a long list", async () => {
    ws.todoItems = Array.from({ length: 9 }, (_, i) => ({ summary: `Item ${i}` }));
    const session = await open({ todo_entity: "todo.chores" }, list("9"));
    await session.toggleRow(8);
    const saved = await pickColour(session, 0, "#010203");
    expect(saved.colors).toEqual([null, null, null, null, null, null, null, null, "#010203"]);
    // The card validates lists against `segments`, in to-do mode too.
    expect(saved.segments).toBe(9);
  });

  it("warns when the list has nothing open", async () => {
    const session = await open({ todo_entity: "todo.chores" }, list("0"));
    expect(session.rows()).toEqual([]);
    expect(session.root.querySelector(".ed-segments ha-alert")?.textContent).toContain(
      en.editor.todo_empty,
    );
  });

  it("fetches again when the list changes or another is chosen", async () => {
    ws.todoItems = [{ summary: "Dishes" }];
    const states = {
      "todo.chores": { state: "1", attributes: {} },
      "todo.garden": { state: "4", attributes: {} },
    };
    const session = await open({ todo_entity: "todo.chores" }, { states });
    session.editor.hass = fakeHass({ states });
    await session.settle();
    expect(ws.calls).toHaveLength(1);

    ws.todoItems = [{ summary: "Mow" }];
    await session.change("todo_entity", "todo.garden");
    expect(ws.calls).toHaveLength(2);
    expect(session.rows()).toEqual(["Mow"]);
  });

  it("shows no rows when the list can't be read", async () => {
    ws.fail = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const session = await open({ todo_entity: "todo.chores" }, list("3"));
    expect(warn).toHaveBeenCalledOnce();
    expect(session.rows()).toEqual([]);
  });

  it("can be picked as the source before a list is, saving nothing yet", async () => {
    const session = await open({ labels: ["a"] });
    expect(session.form("source")!.data.source).toBe("list");
    session
      .form("source")!
      .dispatchEvent(new CustomEvent("value-changed", { detail: { value: { source: "todo" } } }));
    await session.settle();
    expect(session.saved).toEqual([]);
    expect(session.fields()).toContain("todo_entity");
    expect(session.fields()).not.toContain("segments");
    expect(session.root.querySelector(".ed-segments .ed-note")?.textContent).toBe(
      en.editor.todo_none,
    );
  });

  it("is dropped when the source goes back to the own list", async () => {
    const session = await open({ todo_entity: "todo.chores", labels: ["a"] }, list("1"));
    expect(session.form("source")!.data.source).toBe("todo");
    expect(await session.change("source", "list")).toEqual({ type: TYPE, labels: ["a"] });
    expect(session.rows()).toEqual(["a"]);
  });
});

describe("the result helper", () => {
  const picker = (session: Session): HTMLElement =>
    session.root.querySelector(".ed-result ha-selector")!;
  const createButton = (session: Session): HTMLElement | null =>
    session.root.querySelector(".ed-result ha-button");
  const pick = (session: Session, value: string): void => {
    picker(session).dispatchEvent(
      new CustomEvent("value-changed", { detail: { value }, bubbles: true }),
    );
  };

  it("is saved from its own picker, and removed when that is cleared", async () => {
    const session = await open();
    pick(session, "input_text.result");
    pick(session, "");
    expect(session.saved).toEqual([
      { type: TYPE, result_entity: "input_text.result" },
      { type: TYPE },
    ]);
  });

  it("survives edits made in the forms", async () => {
    const session = await open({ result_entity: "input_text.result" });
    expect((await session.change("sound", false)).result_entity).toBe("input_text.result");
  });

  it("can be created for an admin with one click", async () => {
    const session = await open();
    createButton(session)!.click();
    await flush();
    await session.settle();
    expect(ws.calls).toEqual([
      {
        type: "input_text/create",
        name: en.editor.result_entity_default_name,
        max: 255,
        icon: "mdi:dharmachakra",
      },
    ]);
    expect(session.saved).toEqual([{ type: TYPE, result_entity: "input_text.wheel_result" }]);
    expect(session.toasts).toEqual(["Helper created: input_text.wheel_result"]);
    expect(createButton(session)).toBeNull();
  });

  it("offers no button to others, or when a helper is already set", async () => {
    expect(createButton(await open({}, { user: { is_admin: false } }))).toBeNull();
    expect(createButton(await open({ result_entity: "input_text.result" }))).toBeNull();
  });

  it("says so when creating it fails", async () => {
    ws.fail = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const session = await open();
    createButton(session)!.click();
    await flush();
    expect(warn).toHaveBeenCalledOnce();
    expect(session.saved).toEqual([]);
    expect(session.toasts).toEqual([en.editor.result_entity_create_failed]);
  });
});

describe("labels and hints", () => {
  it("gives every field a label in plain words", async () => {
    const session = await open({
      pegs: true,
      labels: ["a"],
      tts_announce_entities: ["media_player.a"],
    });
    await session.toggleRow(0);
    const all = [...session.root.querySelectorAll<Form>("ha-form")].filter(
      (f) => !f.hasAttribute("hidden"),
    );
    for (const form of all) {
      for (const { name } of form.schema) {
        const label = form.computeLabel({ name });
        expect(label, name).not.toBe(name);
        expect(label, name).not.toMatch(/^editor\./);
      }
    }
  });

  it("quotes the stop time under the friction, from the card's own physics", async () => {
    const session = await open({ friction: 5 });
    expect(session.form("friction")!.computeHelper({ name: "friction" })).toBe(
      "The wheel stops after about 5 s. 1 spins long, 10 brakes hard.",
    );
  });

  it("adds a hint only where there is one to give", async () => {
    const session = await open();
    const hint = (name: string): unknown => session.form(name)!.computeHelper({ name });
    expect(hint("name")).toBe(en.editor.name_helper);
    expect(hint("shape")).toBeUndefined();
  });

  it("speaks Home Assistant's language, whatever the card's", async () => {
    const german = await open({}, { language: "de" });
    expect(german.form("name")!.computeLabel({ name: "name" })).toBe("Titel");
    const english = await open({ language: "de" });
    expect(english.form("name")!.computeLabel({ name: "name" })).toBe(en.editor.name);
    // The hub's default text follows the card's language.
    expect(english.form("hub_text")!.data.hub_text).toBe("DREH");
  });
});
