/**
 * @vitest-environment happy-dom
 *
 * What the editor shows and what it writes back.
 *
 * ha-form hands back everything it was shown, and the editor shows
 * projections of some fields rather than the fields themselves — `actions`
 * reaches the multi-picker as strings only, colours and weights appear a
 * second time as one row per label. Writing a projection back over the
 * saved value is how an unrelated toggle used to move scripts onto the
 * wrong segment and delete object-form actions.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import "../src/editor";
import en from "../src/localize/languages/en.json";
import type { SpinningWheelCardConfig } from "../src/types";

const TYPE = "custom:spinning-wheel-card";

type Config = Record<string, unknown>;
type Field = { name: string; schema?: Field[]; title?: string };
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

const flush = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

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

/** An open editor: its form, and the events it has fired so far. */
interface Session {
  editor: Editor;
  form(): Form;
  /** Every `config-changed` payload, oldest first. */
  saved: Config[];
  /** Every toast message. */
  toasts: string[];
  /** Change fields the way ha-form does; returns what gets saved. */
  change(patch: Config): Promise<Config>;
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

  const saved: Config[] = [];
  const toasts: string[] = [];
  editor.addEventListener("config-changed", (event) =>
    saved.push((event as CustomEvent<{ config: Config }>).detail.config),
  );
  editor.addEventListener("hass-notification", (event) =>
    toasts.push((event as CustomEvent<{ message: string }>).detail.message),
  );
  const form = (): Form => editor.shadowRoot!.querySelector("ha-form") as Form;
  const change = async (patch: Config): Promise<Config> => {
    form().dispatchEvent(
      new CustomEvent("value-changed", {
        detail: { value: { ...form().data, ...patch } },
      }),
    );
    await settle();
    return saved[saved.length - 1]!;
  };
  return { editor, form, saved, toasts, change };
}

/** Open the editor on `config`, make one change, return what is saved. */
const saveAfterChange = async (config: Config, patch: Config): Promise<Config> =>
  (await open(config)).change(patch);

/** Every field name in the form, groups included. */
const fieldNames = (schema: Field[]): string[] =>
  schema.flatMap((field) => [
    ...(field.name ? [field.name] : []),
    ...fieldNames(field.schema ?? []),
  ]);

describe("editor save", () => {
  it("keeps each action on its own segment through an unrelated edit", async () => {
    const saved = await saveAfterChange(
      { labels: ["a", "b"], actions: [null, "script.b"] },
      { sound: false },
    );
    expect(saved.actions).toEqual([null, "script.b"]);
  });

  it("keeps object-form actions through an unrelated edit", async () => {
    const action = { action: "perform-action", perform_action: "light.toggle" };
    const saved = await saveAfterChange(
      { labels: ["a"], actions: [action] },
      { sound: false },
    );
    expect(saved.actions).toEqual([action]);
  });

  it("writes only the changed field, type first", async () => {
    const saved = await saveAfterChange({}, { show_status: false });
    expect(saved).toEqual({ type: TYPE, show_status: false });
    expect(Object.keys(saved)[0]).toBe("type");
  });

  it("drops a field set back to its default", async () => {
    const saved = await saveAfterChange(
      { segments: 6, sound: false },
      { segments: 8 },
    );
    expect(saved).toEqual({ type: TYPE, sound: false });
  });
});

describe("the rows per label", () => {
  const labels = ["a", "b", "c"];

  it("show each label's colour, weight and script", async () => {
    const { form } = await open({
      labels,
      colors: ["#ff0000"],
      weights: [2, 3],
      actions: ["script.a", { action: "none" }],
    });
    expect(form().data).toMatchObject({
      binding_0_color: [255, 0, 0],
      binding_1_color: [255, 0, 0],
      binding_0_label_color: [26, 26, 26],
      binding_0_weight: 2,
      binding_1_weight: 3,
      binding_2_weight: 2,
      binding_0_action: "script.a",
      // An action object has no place in a script picker.
      binding_1_action: "",
      binding_2_action: "",
    });
  });

  it("save a picked colour and leave the other labels to the theme", async () => {
    const saved = await saveAfterChange(
      { labels },
      { binding_1_color: [1, 2, 3] },
    );
    expect(saved.colors).toEqual([null, "rgb(1, 2, 3)", null]);
    expect(saved.label_colors).toBeUndefined();
  });

  it("keep the colours that were already set", async () => {
    const saved = await saveAfterChange(
      { labels, colors: ["#ff0000", null, "#0000ff"] },
      { binding_1_color: [1, 2, 3], binding_2_color: [4, 5, 6] },
    );
    expect(saved.colors).toEqual(["#ff0000", "rgb(1, 2, 3)", "rgb(4, 5, 6)"]);
  });

  it("save a picked text colour", async () => {
    const saved = await saveAfterChange(
      { labels },
      { binding_2_label_color: [9, 9, 9] },
    );
    expect(saved.label_colors).toEqual([null, null, "rgb(9, 9, 9)"]);
    expect(saved.colors).toBeUndefined();
  });

  it("ignore a colour that isn't one, or a row that doesn't exist", async () => {
    const { change } = await open({ labels });
    expect((await change({ binding_0_color: "red" })).colors).toBeUndefined();
    expect(
      (await change({ binding_7_color: [1, 2, 3] })).colors,
    ).toBeUndefined();
  });

  it("save a weight, and nothing once every weight is 1 again", async () => {
    const { change } = await open({ labels });
    expect((await change({ binding_1_weight: 3 })).weights).toEqual([1, 3, 1]);
    expect((await change({ binding_1_weight: 0 })).weights).toEqual([1, 3, 1]);
    expect((await change({ binding_1_weight: 1 })).weights).toBeUndefined();
  });

  it("save a script, and drop it again when the row is cleared", async () => {
    const { change } = await open({ labels });
    expect((await change({ binding_1_action: "script.b" })).actions).toEqual([
      null,
      "script.b",
    ]);
    expect((await change({ binding_1_action: "" })).actions).toBeUndefined();
  });

  it("keep an action object when its row is cleared", async () => {
    const action = { action: "navigate", navigation_path: "/lovelace/0" };
    const { change } = await open({ labels, actions: ["script.a", action] });
    // The picker shows "" for the object; clearing it emits undefined.
    const saved = await change({
      binding_0_action: undefined,
      binding_1_action: undefined,
    });
    expect(saved.actions).toEqual([null, action]);
  });

  it("name the rows after the unique labels, in order", async () => {
    const { form } = await open({
      segments: 6,
      labels: ["a", "b", "a", "c"],
    });
    const group = form().schema.find((field) => field.name === "bindings")!;
    expect(group.schema!.map((row) => row.title)).toEqual(["a", "b", "c"]);
  });
});

describe("the advanced lists", () => {
  it("read colours with a gap as `leave this one to the theme`", async () => {
    const { change } = await open();
    expect((await change({ colors_csv: "#a,,#c" })).colors).toEqual([
      "#a",
      null,
      "#c",
    ]);
    expect((await change({ colors_csv: ",," })).colors).toBeUndefined();
    expect((await change({ label_colors_csv: "white" })).label_colors).toEqual([
      "white",
    ]);
    expect((await change({ label_colors_csv: "" })).label_colors).toBeUndefined();
  });

  it("read weights, skipping what isn't a positive number", async () => {
    const { change } = await open();
    expect((await change({ weights_csv: "1, 2, x, -3, 4" })).weights).toEqual([
      1, 2, 4,
    ]);
    expect((await change({ weights_csv: "none" })).weights).toBeUndefined();
  });

  it("keep the text exactly as typed, so a trailing comma survives", async () => {
    const { change, form } = await open();
    await change({ colors_csv: "#abc, ", weights_csv: "2," });
    expect(form().data).toMatchObject({
      colors_csv: "#abc, ",
      weights_csv: "2,",
      colors: ["#abc"],
      weights: [2],
    });
  });

  it("win over a row edited in the same breath", async () => {
    const saved = await saveAfterChange(
      { labels: ["a", "b"] },
      {
        colors_csv: "#abc",
        binding_0_color: [1, 2, 3],
        weights_csv: "5",
        binding_0_weight: 9,
      },
    );
    expect(saved).toMatchObject({ colors: ["#abc"], weights: [5] });
  });

  it("follow a row edit", async () => {
    const { change, form } = await open({ labels: ["a", "b"] });
    await change({ binding_1_color: [1, 2, 3], binding_1_weight: 4 });
    expect(form().data).toMatchObject({
      colors_csv: ", rgb(1, 2, 3)",
      weights_csv: "1, 4",
    });
  });
});

describe("the actions picker", () => {
  const action = { action: "none" };

  it("lists the scripts only", async () => {
    const { form } = await open({ actions: ["script.a", null, action] });
    expect(form().data.actions).toEqual(["script.a"]);
  });

  it("saves its scripts ahead of the action objects it can't show", async () => {
    const saved = await saveAfterChange(
      { actions: ["script.a", action] },
      { actions: ["script.a", "script.z"] },
    );
    expect(saved.actions).toEqual(["script.a", "script.z", action]);
  });

  it("saves no actions once it is emptied", async () => {
    const saved = await saveAfterChange({ actions: ["script.a"] }, { actions: [] });
    expect(saved).toEqual({ type: TYPE });
  });

  it("wins over a row edited in the same breath", async () => {
    const saved = await saveAfterChange(
      { labels: ["a", "b"] },
      { actions: ["script.z"], binding_1_action: "script.b" },
    );
    expect(saved.actions).toEqual(["script.z"]);
  });
});

describe("labels", () => {
  it("are trimmed, and empty chips dropped", async () => {
    const { change } = await open();
    expect((await change({ labels: [" a ", "", "b ", 5] })).labels).toEqual([
      "a",
      "b",
    ]);
    expect((await change({ labels: [" "] })).labels).toBeUndefined();
    expect((await change({ labels: "a, b" })).labels).toBeUndefined();
  });

  it("take their weight, colours and action with them when deleted", async () => {
    const saved = await saveAfterChange(
      {
        labels: ["a", "b", "c"],
        weights: [1, 2, 3],
        colors: ["#1", "#2", "#3"],
        label_colors: ["#4", "#5", "#6"],
        actions: ["script.a", "script.b", "script.c"],
      },
      { labels: ["a", "b"] },
    );
    expect(saved).toEqual({
      type: TYPE,
      labels: ["a", "b"],
      weights: [1, 2],
      colors: ["#1", "#2"],
      label_colors: ["#4", "#5"],
      actions: ["script.a", "script.b"],
    });
  });

  it("leave the other lists alone when one is added", async () => {
    const saved = await saveAfterChange(
      { labels: ["a", "b"], weights: [1, 2] },
      { labels: ["a", "b", "c"] },
    );
    expect(saved.weights).toEqual([1, 2]);
  });
});

describe("fields with a say of their own", () => {
  it("saves a cleared hub text as `no hub text`, not as the default", async () => {
    const saved = await saveAfterChange({ hub_text: "Go" }, { hub_text: undefined });
    expect(saved.hub_text).toBe("");
    const never = await saveAfterChange({}, { sound: false });
    expect("hub_text" in never).toBe(false);
  });

  it("saves the text orientation only when it isn't the default", async () => {
    const { change, form } = await open();
    expect(form().data.text_orientation).toBe("tangent");
    expect((await change({ text_orientation: "radial" })).text_orientation).toBe(
      "radial",
    );
    expect(
      "text_orientation" in (await change({ text_orientation: "tangent" })),
    ).toBe(false);
  });

  it("shows `auto` for the language and saves it as no language", async () => {
    const { change, form } = await open({ language: "de" });
    expect(form().data.language).toBe("de");
    expect("language" in (await change({ language: "auto" }))).toBe(false);
    expect(form().data.language).toBe("auto");
  });

  it("saves an emptied entity list as the feature being off", async () => {
    const saved = await saveAfterChange(
      {
        light_sync_entities: ["light.a"],
        tts_announce_entities: ["media_player.a"],
      },
      { light_sync_entities: [], tts_announce_entities: undefined },
    );
    expect(saved).toEqual({ type: TYPE });
  });

  it("offers the peg density only with pegs on, and saves it only then", async () => {
    const { change, form } = await open({ pegs: true, peg_density: 3 });
    expect(fieldNames(form().schema)).toContain("peg_density");
    expect(await change({ pegs: false })).toEqual({ type: TYPE });
    expect(fieldNames(form().schema)).not.toContain("peg_density");
  });

  it("migrates a pre-v1.2 friction preset to its level", async () => {
    const { change, form } = await open({ friction: "high" });
    expect(form().data.friction).toBe(7);
    expect((await change({ sound: false })).friction).toBe(7);
  });
});

describe("labels and hints", () => {
  it("gives every field a label in plain words", async () => {
    const { form } = await open({ pegs: true, labels: ["a"] });
    for (const name of fieldNames(form().schema)) {
      const label = form().computeLabel({ name });
      // Groups carry their title in the schema instead.
      if (["general", "label_layout", "integrations", "bindings"].includes(name)) {
        continue;
      }
      if (/^binding_\d+$/.test(name)) continue;
      expect(label, name).not.toBe(name);
      expect(label, name).not.toMatch(/^editor\./);
    }
  });

  it("labels the row fields the same on every row", async () => {
    const { form } = await open({ labels: ["a", "b"] });
    const label = (name: string): string => form().computeLabel({ name });
    expect(label("binding_0_color")).toBe(en.editor.binding_color);
    expect(label("binding_1_color")).toBe(en.editor.binding_color);
    expect(label("binding_1_label_color")).toBe(en.editor.binding_label_color);
    expect(label("binding_0_weight")).toBe(en.editor.binding_weight);
    expect(label("binding_0_action")).toBe(en.editor.binding_action);
  });

  it("adds a hint where there is one to give", async () => {
    const { form } = await open({ labels: ["a"] });
    const hint = (name: string): unknown => form().computeHelper({ name });
    expect(hint("todo_entity")).toBe(en.editor.todo_entity_helper);
    expect(hint("name")).toBeUndefined();
    expect(hint("binding_0_color")).toBeUndefined();
  });

  it("speaks the card's language", async () => {
    const { form } = await open({ language: "de" });
    const german = form().computeLabel({ name: "name" });
    expect(german).not.toBe(en.editor.name);
    expect((await open()).form().computeLabel({ name: "name" })).toBe(
      en.editor.name,
    );
    expect(german).toBe(
      (await open({}, { language: "de" })).form().computeLabel({ name: "name" }),
    );
  });
});

describe("with a todo list", () => {
  const list = (state: string): Config => ({
    states: { "todo.chores": { state, attributes: {} } },
  });
  const rows = (form: Form): unknown[] =>
    (form.schema.find((field) => field.name === "bindings")?.schema ?? []).map(
      (row) => row.title,
    );

  it("has one row per open item, and hides what the list overrides", async () => {
    ws.todoItems = [
      { summary: "Dishes" },
      { summary: "Laundry", status: "completed" },
      { summary: "Bins" },
      { summary: "Dishes" },
    ];
    const { form } = await open(
      { todo_entity: "todo.chores", labels: ["ignored"] },
      list("2"),
    );
    expect(ws.calls).toEqual([
      { type: "todo/item/list", entity_id: "todo.chores" },
    ]);
    expect(rows(form())).toEqual(["Dishes", "Bins"]);
    const names = fieldNames(form().schema);
    expect(names).not.toContain("segments");
    expect(names).not.toContain("labels");
    expect(names).not.toContain("text_orientation");
    expect(names).toContain("friction");
  });

  it("saves a row edit against the items, not the ignored labels", async () => {
    ws.todoItems = [{ summary: "Dishes" }, { summary: "Bins" }];
    const { change } = await open({ todo_entity: "todo.chores" }, list("2"));
    const saved = await change({ binding_1_color: [1, 2, 3] });
    expect(saved.colors).toEqual([null, "rgb(1, 2, 3)"]);
  });

  it("warns when the list has nothing open", async () => {
    const { form } = await open({ todo_entity: "todo.chores" }, list("0"));
    expect(rows(form())).toEqual([]);
    expect(form().computeHelper({ name: "todo_entity" })).toBe(
      en.editor.todo_entity_empty_warning,
    );
  });

  it("fetches again when the list changes or another is chosen", async () => {
    ws.todoItems = [{ summary: "Dishes" }];
    const { editor, change, form } = await open(
      { todo_entity: "todo.chores" },
      {
        states: {
          "todo.chores": { state: "1", attributes: {} },
          "todo.garden": { state: "4", attributes: {} },
        },
      },
    );
    editor.hass = fakeHass(list("1"));
    await editor.updateComplete;
    expect(ws.calls).toHaveLength(1);

    ws.todoItems = [{ summary: "Mow" }];
    editor.hass = fakeHass({
      states: {
        "todo.chores": { state: "1", attributes: {} },
        "todo.garden": { state: "4", attributes: {} },
      },
    });
    await change({ todo_entity: "todo.garden" });
    expect(ws.calls).toHaveLength(2);
    expect(rows(form())).toEqual(["Mow"]);
  });

  it("shows no rows when the list can't be read", async () => {
    ws.fail = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { form } = await open({ todo_entity: "todo.chores" }, list("3"));
    expect(warn).toHaveBeenCalledOnce();
    expect(rows(form())).toEqual([]);
  });
});

describe("the result helper", () => {
  const picker = (session: Session): HTMLElement =>
    session.editor.shadowRoot!.querySelector("ha-selector")!;
  const createButton = (session: Session): HTMLButtonElement | null =>
    session.editor.shadowRoot!.querySelector(".create-helper-btn");
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

  it("survives whatever the form says about it", async () => {
    const session = await open({ result_entity: "input_text.result" });
    const saved = await session.change({ result_entity: "", sound: false });
    expect(saved.result_entity).toBe("input_text.result");

    const none = await open();
    expect(
      "result_entity" in (await none.change({ result_entity: "input_text.x" })),
    ).toBe(false);
  });

  it("can be created for an admin with one click", async () => {
    const session = await open();
    createButton(session)!.click();
    await flush();
    await session.editor.updateComplete;
    expect(ws.calls).toEqual([
      {
        type: "input_text/create",
        name: en.editor.result_entity_default_name,
        max: 255,
        icon: "mdi:dharmachakra",
      },
    ]);
    expect(session.saved).toEqual([
      { type: TYPE, result_entity: "input_text.wheel_result" },
    ]);
    expect(session.toasts).toEqual([
      "Result helper created: input_text.wheel_result",
    ]);
    expect(createButton(session)).toBeNull();
  });

  it("offers no button to others, or when a helper is already set", async () => {
    expect(createButton(await open({}, { user: { is_admin: false } }))).toBeNull();
    expect(
      createButton(await open({ result_entity: "input_text.result" })),
    ).toBeNull();
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
