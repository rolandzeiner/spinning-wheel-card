/**
 * @vitest-environment happy-dom
 *
 * What the card paints and how big it paints it.
 *
 * The canvas is the fake from ./fakes, which records every call, so these
 * tests read the paint the way the browser would run it: a wedge is a
 * path closed and filled, a label is one or more `fillText` calls. Text
 * there is half its font size wide per character.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { THEME_PALETTES } from "../src/palettes";
import {
  type Card,
  type Op,
  TYPE,
  fakeHass,
  fontSizes,
  frames,
  lastPaint,
  mount,
  press,
  rendered,
  reset,
  resizeTo,
  texts,
  wedgeColours,
  wheel,
  wrapBox,
} from "./fakes";

beforeEach(reset);

/** The calls named `name` in the most recent paint. */
const painted = (name: string): Op[] =>
  lastPaint().filter((op) => op[0] === name);

/** Angle each wedge spans, in the most recent paint. */
const wedgeSpans = (): number[] => {
  const paint = lastPaint();
  return paint.flatMap((op, i) => {
    const arc = paint[i + 1];
    return op[0] === "moveTo" && op[1] === 0 && arc
      ? [(arc[5] as number) - (arc[4] as number)]
      : [];
  });
};

/** Text colour of each label (and of the hub text, last). */
const textColours = (): unknown[] => {
  const paint = lastPaint();
  return paint.flatMap((op, i) =>
    op[1] === "textAlign" ? [paint[i - 1]?.[2]] : [],
  );
};

const four = (extra: Record<string, unknown> = {}): Promise<Card> =>
  mount({ segments: 4, hub_text: "", ...extra });

describe("wedges", () => {
  it("paints one per segment in the theme's colours", async () => {
    await four();
    expect(wedgeColours()).toEqual(THEME_PALETTES.default.slice(0, 4));
    await four({ theme: "neon" });
    expect(wedgeColours()).toEqual(THEME_PALETTES.neon.slice(0, 4));
  });

  it("gives segments with the same label the same colour", async () => {
    await four({ labels: ["a", "b", "a", "b"] });
    const [first, second] = THEME_PALETTES.default;
    expect(wedgeColours()).toEqual([first, second, first, second]);
  });

  it("leaves a null colour slot to the theme", async () => {
    await four({ colors: ["#111111", null], theme: "neon" });
    expect(wedgeColours()).toEqual([
      "#111111",
      THEME_PALETTES.neon[1],
      "#111111",
      THEME_PALETTES.neon[3],
    ]);
  });

  it("sizes them by weight", async () => {
    await four({ weights: [3, 1] });
    const eighth = (Math.PI * 2) / 8;
    expect(wedgeSpans()).toEqual([
      expect.closeTo(3 * eighth, 10),
      expect.closeTo(eighth, 10),
      expect.closeTo(3 * eighth, 10),
      expect.closeTo(eighth, 10),
    ]);
  });

  it("draws the dividing lines unless borders are off", async () => {
    await four();
    // Four dividers, the outer ring and the hub's edge.
    expect(painted("stroke")).toHaveLength(6);
    await four({ segment_borders: false });
    expect(painted("stroke")).toHaveLength(2);
    // Borderless wedges overlap a hair so no seam shows between them.
    expect(wedgeSpans()[0]).toBeGreaterThan(Math.PI / 2);
  });

  it("turns with the wheel", async () => {
    const card = await four({ selector_mode: true });
    const rotation = (): number => painted("rotate")[0]?.[1] as number;
    const before = rotation();
    press(card, "ArrowRight");
    await rendered(card);
    // A quarter turn back, to bring the next segment under the pointer.
    expect(Math.sin(rotation() - before)).toBeCloseTo(-1, 10);
  });
});

describe("labels", () => {
  it("numbers the segments when there are none", async () => {
    await four();
    expect(texts()).toEqual(["1", "2", "3", "4"]);
  });

  it("repeats a short list round the wheel", async () => {
    await four({ labels: ["A", "B"] });
    expect(texts()).toEqual(["A", "B", "A", "B"]);
  });

  it("writes along the rim glyph by glyph, or along the spoke in one go", async () => {
    await four({ labels: ["Go"] });
    expect(texts()).toEqual(["G", "o", "G", "o", "G", "o", "G", "o"]);
    await four({ labels: ["Go"], text_orientation: "radial" });
    expect(texts()).toEqual(["Go", "Go", "Go", "Go"]);
  });

  it("reads the other way round when flipped", async () => {
    const turns = (angle: number): number =>
      painted("rotate").filter((op) => op[1] === angle).length;

    await four({ labels: ["Go"], text_orientation: "radial" });
    expect(turns(Math.PI)).toBe(4);
    await four({ labels: ["Go"], text_orientation: "radial", label_flip: true });
    expect(turns(Math.PI)).toBe(0);

    await four({ labels: ["Go"] });
    expect([turns(Math.PI / 2), turns(-Math.PI / 2)]).toEqual([8, 0]);
    await four({ labels: ["Go"], label_flip: true });
    expect([turns(Math.PI / 2), turns(-Math.PI / 2)]).toEqual([0, 8]);
  });

  it("cuts a label that doesn't fit and marks the cut", async () => {
    const long = "A label far too long for one slice";
    await four({ labels: [long], text_orientation: "radial" });
    const [drawn] = texts();
    expect(drawn).toMatch(/^A label.*…$/);
    expect(drawn!.length).toBeLessThan(long.length);
    expect(fontSizes()).toEqual([14, 14, 14, 14]);
  });

  it("shrinks the font instead when auto-fit is on", async () => {
    await four({
      labels: ["Short", "A label far too long for one slice"],
      text_orientation: "radial",
      label_auto_fit: true,
    });
    expect(fontSizes()).toEqual([14, 7, 14, 7]);
    expect(texts()[0]).toBe("Short");
  });

  it("scales the font and moves the labels on request", async () => {
    const distance = (): unknown => painted("translate")[1]?.[1];
    await four({ text_orientation: "radial" });
    const usual = distance() as number;
    expect(fontSizes()[0]).toBe(14);

    await four({
      text_orientation: "radial",
      label_font_scale: 150,
      label_radius_offset: -20,
    });
    expect(fontSizes()[0]).toBe(21);
    expect(distance()).toBeLessThan(usual);
  });

  it("leaves slices too thin for a label blank", async () => {
    await mount({
      segments: 6,
      weights: [50, 1, 1, 1, 1, 50],
      labels: ["a", "b", "c", "d", "e", "f"],
      hub_text: "",
    });
    expect(texts()).toEqual(["a", "f"]);
  });

  it("picks black or white text against each fill", async () => {
    await four({
      colors: ["#000000", "#ffffff", "rgba(0, 0, 0, 0.5)", "rgba(0, 0, 0, 0.1)"],
    });
    // The see-through blacks are judged by how they look on a white
    // card: mid-grey takes white text, the faint one takes dark.
    expect(textColours()).toEqual(["#ffffff", "#1a1a1a", "#ffffff", "#1a1a1a"]);
  });

  it("uses the configured label colours, and contrast where one is null", async () => {
    await four({ colors: ["#000000"], label_colors: [null, "#00ff00"] });
    expect(textColours()).toEqual(["#ffffff", "#00ff00", "#ffffff", "#00ff00"]);
  });

  it("falls back to dark text on a fill it can't read", async () => {
    await four({ colors: ["var(--accent-color)"] });
    expect(textColours()).toEqual(Array(4).fill("#1a1a1a"));
  });
});

describe("icon labels", () => {
  const iconFills = (): unknown[] =>
    painted("fill").flatMap((op) =>
      op[1] ? [(op[1] as { d: string }).d] : [],
    );

  it("paints the icon once Home Assistant has resolved it", async () => {
    const card = await four({ labels: ["mdi:resolves", "b"] });
    await rendered(card);
    expect(iconFills()).toEqual([
      "path-of-mdi:resolves",
      "path-of-mdi:resolves",
    ]);
    expect(texts()).toEqual(["b", "b"]);
  });

  it("shows the name as typed when there is no such icon", async () => {
    const card = await four({
      labels: ["mdi:missing"],
      text_orientation: "radial",
    });
    expect(texts()).toEqual([]);
    // The lookup gives up after thirty frames.
    await frames(31);
    await rendered(card);
    expect(iconFills()).toEqual([]);
    expect(texts()).toEqual(Array(4).fill("mdi:missing"));
  });
});

describe("rim, hub and pointer", () => {
  const pegs = (): Op[] => painted("arc").filter((op) => op[3] === 2.5);
  const pointerColour = (): unknown => lastPaint().at(-2)?.[2];

  it("has no pegs unless asked for", async () => {
    await four();
    expect(pegs()).toHaveLength(0);
  });

  it("sets a peg on every boundary, plus the ones in between", async () => {
    await four({ pegs: true });
    expect(pegs()).toHaveLength(8);
    await four({ pegs: true, peg_density: 0 });
    expect(pegs()).toHaveLength(4);
    await four({ pegs: true, peg_density: 4 });
    expect(pegs()).toHaveLength(20);
  });

  it("writes the hub text, shrunk to fit", async () => {
    await mount();
    expect(texts().at(-1)).toBe("SPIN");
    expect(fontSizes().at(-1)).toBe(11);

    await mount({ hub_text: "SPIN!!" });
    expect(fontSizes().at(-1)).toBe(10);

    // … but never below a little over half the usual size.
    await mount({ hub_text: "A long hub text" });
    expect(texts().at(-1)).toBe("A long hub text");
    expect(fontSizes().at(-1)).toBe(6);
  });

  it("writes none when it is empty, or in selector mode", async () => {
    await mount({ hub_text: "" });
    expect(texts()).not.toContain("SPIN");
    await mount({ selector_mode: true });
    expect(texts()).not.toContain("SPIN");
  });

  it("writes the hub text in the card's language", async () => {
    await mount({ language: "de", hub_text: undefined });
    expect(texts().at(-1)).not.toBe("SPIN");
  });

  it("colours hub and pointer black, white or from the theme", async () => {
    await mount({ hub_color: "black" });
    expect(pointerColour()).toBe("#000000");
    expect(textColours().at(-1)).toBe("#ffffff");

    await mount({ hub_color: "white" });
    expect(pointerColour()).toBe("#ffffff");
    expect(textColours().at(-1)).toBe("#000000");

    await mount();
    expect(pointerColour()).toBe("#03a9f4");
  });

  it("re-reads the theme colour when the theme changes", async () => {
    const card = await mount();
    card.style.setProperty("--primary-color", "#102030");
    card.hass = fakeHass({ themes: { darkMode: true, theme: "default" } });
    await rendered(card);
    expect(pointerColour()).toBe("#102030");
    // Hub text flips to white on the now dark accent.
    expect(textColours().at(-1)).toBe("#ffffff");
  });
});

describe("size", () => {
  const size = (card: Card): string[] => [
    wheel(card).style.width,
    wheel(card).style.height,
  ];

  it("starts at 280 px until it knows its room", async () => {
    expect(size(await mount())).toEqual(["280px", "280px"]);
  });

  it("fits the room it is given", async () => {
    Object.assign(wrapBox, { width: 400, height: 300 });
    const card = await mount();
    expect(size(card)).toEqual(["300px", "300px"]);
    expect(wheel(card).width).toBe(300);
  });

  it("follows its container, between 140 and 1000 px", async () => {
    const card = await mount();
    resizeTo(500, 800);
    expect(size(card)).toEqual(["500px", "500px"]);
    resizeTo(50, 50);
    expect(size(card)).toEqual(["140px", "140px"]);
    resizeTo(5000, 5000);
    expect(size(card)).toEqual(["1000px", "1000px"]);
  });

  it("goes by the one dimension it is given", async () => {
    const card = await mount();
    resizeTo(320, 0);
    expect(size(card)).toEqual(["320px", "320px"]);
    resizeTo(0, 410);
    expect(size(card)).toEqual(["410px", "410px"]);
    resizeTo(0, 0);
    expect(size(card)).toEqual(["280px", "280px"]);
  });

  it("re-lays its labels out for the new size", async () => {
    await mount();
    expect(fontSizes()[0]).toBe(14);
    resizeTo(600, 600);
    expect(fontSizes()[0]).toBe(30);
  });

  it("is a dome as a half circle: full width, a little over half as tall", async () => {
    Object.assign(wrapBox, { width: 400, height: 162 });
    const card = await mount({ half_circle: true });
    expect(size(card)).toEqual(["280px", "162px"]);
    expect(painted("clip")).toHaveLength(1);
    expect(card.shadowRoot!.querySelector(".wheel-wrap-half")).not.toBeNull();
  });

  it("re-measures when half circle is switched on", async () => {
    Object.assign(wrapBox, { width: 400, height: 200 });
    const card = await mount();
    expect(size(card)).toEqual(["200px", "200px"]);
    card.setConfig({ type: TYPE, half_circle: true });
    await rendered(card);
    expect(size(card)).toEqual(["346px", "200px"]);
    // … and the labels are laid out for the new size.
    expect(fontSizes()[0]).toBe(17);
  });

  it("keeps following its container after being moved in the page", async () => {
    const card = await mount();
    card.remove();
    document.body.append(card);
    await rendered(card);
    resizeTo(360, 360);
    expect(size(card)).toEqual(["360px", "360px"]);
  });

  it("paints at the screen's pixel density, up to 2×", async () => {
    Object.defineProperty(window, "devicePixelRatio", {
      configurable: true,
      value: 3,
    });
    const card = await mount();
    expect(wheel(card).width).toBe(560);
    expect(painted("setTransform")[0]?.slice(1, 5)).toEqual([2, 0, 0, 2]);
    Object.defineProperty(window, "devicePixelRatio", {
      configurable: true,
      value: 1,
    });
  });
});
