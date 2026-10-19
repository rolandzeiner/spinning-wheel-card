/**
 * @vitest-environment happy-dom
 *
 * The groups as ha-expansion-panels.
 *
 * Kept in a file of its own: the stand-in panel below is registered for
 * the whole file, and editor-save.test.ts needs the fallback that draws
 * the groups open when no panel element exists.
 */
import { describe, expect, it } from "vite-plus/test";

class FakePanel extends HTMLElement {
  header = "";
  secondary = "";
  expanded = false;
}
customElements.define("ha-expansion-panel", FakePanel);

await import("../src/editor");

type Editor = HTMLElement & {
  hass: unknown;
  setConfig(config: Record<string, unknown>): void;
  updateComplete: Promise<boolean>;
};

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function open(config: Record<string, unknown> = {}): Promise<Editor> {
  const editor = document.createElement("spinning-wheel-card-editor") as Editor;
  editor.hass = { language: "en", states: {}, user: { is_admin: true } };
  editor.setConfig({ type: "custom:spinning-wheel-card", ...config });
  document.body.append(editor);
  await editor.updateComplete;
  await flush();
  await editor.updateComplete;
  return editor;
}

const panels = (editor: Editor): FakePanel[] => [
  ...editor.shadowRoot!.querySelectorAll<FakePanel>("ha-expansion-panel"),
];

describe("the groups", () => {
  it("are panels in order, each saying what it is set to", async () => {
    const editor = await open({ theme: "pastel" });
    expect(panels(editor).map((p) => p.header)).toEqual([
      "Appearance",
      "Labels",
      "Hub & pointer",
      "Lines & pegs",
      "Spinning",
      "Sound",
      "After a spin",
    ]);
    expect(panels(editor)[0].secondary).toBe("Pastel · Full circle");
  });

  it("build their body only once opened, and never bind `expanded`", async () => {
    const editor = await open();
    const look = panels(editor)[0];
    expect(look.querySelector("ha-form")).toBeNull();
    look.dispatchEvent(new CustomEvent("expanded-will-change", { detail: { expanded: true } }));
    await editor.updateComplete;
    expect(look.querySelector("ha-form")).not.toBeNull();
    // The panel owns its open state; the editor only records it.
    expect(look.expanded).toBe(false);
    look.dispatchEvent(new CustomEvent("expanded-will-change", { detail: { expanded: false } }));
    await editor.updateComplete;
    expect(look.querySelector("ha-form")).toBeNull();
  });
});
