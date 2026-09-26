/**
 * @vitest-environment happy-dom
 *
 * What the editor writes back when the user changes one unrelated field.
 *
 * ha-form hands back everything it was shown, and the editor shows
 * projections of some fields rather than the fields themselves — `actions`
 * reaches the multi-picker as strings only. Writing a projection back over
 * the saved value is how an unrelated toggle used to move scripts onto the
 * wrong segment and delete object-form actions.
 */
import { describe, expect, it } from "vitest";

import "../src/editor";
import type { SpinningWheelCardConfig } from "../src/types";

const TYPE = "custom:spinning-wheel-card";

type Editor = HTMLElement & {
  hass: unknown;
  setConfig(config: SpinningWheelCardConfig): void;
  updateComplete: Promise<boolean>;
};

/** Mount the editor on `config`, flip one field through ha-form the way
 *  ha-form does it, and return what `config-changed` carries. */
async function saveAfterChange(
  config: SpinningWheelCardConfig,
  change: Record<string, unknown>,
): Promise<SpinningWheelCardConfig> {
  const editor = document.createElement("spinning-wheel-card-editor") as Editor;
  editor.hass = { language: "en", states: {}, localize: () => "" };
  editor.setConfig(config);
  document.body.append(editor);
  await editor.updateComplete;
  const form = editor.shadowRoot?.querySelector("ha-form") as
    | (HTMLElement & { data: Record<string, unknown> })
    | null;
  if (!form) throw new Error("editor rendered no ha-form");
  const saved = new Promise<SpinningWheelCardConfig>((resolve) => {
    editor.addEventListener(
      "config-changed",
      (event) =>
        resolve((event as CustomEvent<{ config: SpinningWheelCardConfig }>).detail.config),
      { once: true },
    );
  });
  form.dispatchEvent(
    new CustomEvent("value-changed", { detail: { value: { ...form.data, ...change } } }),
  );
  const result = await saved;
  editor.remove();
  return result;
}

describe("editor save", () => {
  it("keeps each action on its own segment through an unrelated edit", async () => {
    const saved = await saveAfterChange(
      { type: TYPE, labels: ["a", "b"], actions: [null, "script.b"] },
      { sound: false },
    );
    expect(saved.actions).toEqual([null, "script.b"]);
  });

  it("keeps object-form actions through an unrelated edit", async () => {
    const action = { action: "perform-action", perform_action: "light.toggle" };
    const saved = await saveAfterChange(
      { type: TYPE, labels: ["a"], actions: [action] },
      { sound: false },
    );
    expect(saved.actions).toEqual([action]);
  });

  it("writes only the changed field, type first", async () => {
    const saved = await saveAfterChange({ type: TYPE }, { show_status: false });
    expect(saved).toEqual({ type: TYPE, show_status: false });
    expect(Object.keys(saved)[0]).toBe("type");
  });
});
