/**
 * @vitest-environment happy-dom
 *
 * The card as a user meets it: a click spins it, it comes to rest on a
 * segment, and that segment's result goes where the config says — the
 * status line, an action, lights, a speaker, a helper entity.
 *
 * The browser pieces happy-dom lacks are faked in ./fakes. `Math.random`
 * is pinned to 0.5 there, so a click always adds 12 rad/s, clockwise.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import de from "../src/localize/languages/de.json";
import en from "../src/localize/languages/en.json";
import {
  type Card,
  TYPE,
  audio,
  calls,
  click,
  clicksPlayed,
  drag,
  env,
  events,
  fakeHass,
  flush,
  frames,
  mount,
  ops,
  pointer,
  press,
  rendered,
  reset,
  runToRest,
  serviceCalls,
  statusText,
  wheel,
} from "./fakes";

beforeEach(reset);

const resting = (card: Card): boolean =>
  wheel(card).classList.contains("wheel-resting");

describe("setting up", () => {
  it("refuses a bad config in the config's own language", () => {
    const card = document.createElement("spinning-wheel-card") as Card;
    expect(() => card.setConfig({ type: TYPE, segments: 99 })).toThrow(
      en.errors.segments_range,
    );
    expect(() =>
      card.setConfig({ type: TYPE, language: "de", segments: 99 }),
    ).toThrow(de.errors.segments_range);
  });

  it("offers its editor and an empty stub config", () => {
    const element = customElements.get("spinning-wheel-card") as unknown as {
      getStubConfig(): unknown;
      getConfigElement(): HTMLElement;
    };
    expect(element.getStubConfig()).toEqual({});
    expect(element.getConfigElement().localName).toBe(
      "spinning-wheel-card-editor",
    );
  });

  it("asks the dashboard for less room as a half circle", async () => {
    const full = await mount();
    const half = await mount({ half_circle: true });
    expect(full.getCardSize()).toBe(6);
    expect(half.getCardSize()).toBe(4);
    expect(full.getGridOptions()).toMatchObject({ rows: 6, max_rows: 17 });
    expect(half.getGridOptions()).toMatchObject({ rows: 3, max_rows: 10 });
  });

  it("shows a header only when the card has a name", async () => {
    const header = async (name?: string): Promise<unknown> =>
      (await mount({ name })).shadowRoot!.querySelector<
        HTMLElement & { header?: string }
      >("ha-card")!.header;
    expect(await header("Chores")).toBe("Chores");
    expect(await header("  ")).toBeUndefined();
    expect(await header()).toBeUndefined();
  });
});

describe("spinning", () => {
  it("spins on a click and settles on a result", async () => {
    const card = await mount();
    expect(statusText(card)).toBe(en.status.idle);
    expect(resting(card)).toBe(true);

    click(card);
    await rendered(card);
    expect(card._omega).toBe(12);
    expect(statusText(card)).toBe(en.status.spinning);
    expect(resting(card)).toBe(false);

    await runToRest();
    await rendered(card);
    expect(card._omega).toBe(0);
    expect(statusText(card)).toMatch(/^Result: [1-8]$/);
    expect(resting(card)).toBe(true);
  });

  it("slows down sooner the higher the friction", async () => {
    const framesToRest = async (friction: number): Promise<number> => {
      click(await mount({ friction, sound: false }));
      return runToRest();
    };
    const light = await framesToRest(1);
    const heavy = await framesToRest(10);
    expect(heavy).toBeLessThan(light);
  });

  it("adds to the spin when clicked again, up to the speed cap", async () => {
    const card = await mount();
    click(card);
    click(card);
    expect(card._omega).toBe(24);
    click(card);
    click(card);
    expect(card._omega).toBe(40);
  });

  it("boosts a wheel turning the other way further that way", async () => {
    vi.mocked(Math.random).mockReturnValue(0.25);
    const card = await mount();
    click(card);
    expect(card._omega).toBe(-10);
    click(card);
    expect(card._omega).toBe(-20);
  });

  it("ignores clicks on a moving wheel when boost is off", async () => {
    const card = await mount({ disable_boost: true });
    click(card);
    click(card);
    press(card, "Enter");
    expect(card._omega).toBe(12);
  });

  it("spins on Space and Enter and leaves other keys alone", async () => {
    const card = await mount();
    expect(press(card, "a")).toBe(true);
    press(card, "ArrowRight");
    expect(card._omega).toBe(0);
    // dispatchEvent answers false once the card has claimed the key.
    expect(press(card, " ")).toBe(false);
    expect(card._omega).toBe(12);
    press(card, "Enter");
    expect(card._omega).toBe(24);
  });

  it("jumps straight to the result under reduced motion", async () => {
    env.reducedMotion = true;
    const card = await mount();
    click(card);
    await rendered(card);
    expect(await runToRest()).toBe(0);
    // 1.5 s of travel at the click's speed, so the result isn't a given.
    expect(card._angle).toBeCloseTo((12 * 1.5) % (2 * Math.PI), 10);
    expect(statusText(card)).toMatch(/^Result: /);
  });

  it("can be spun again once it has stopped", async () => {
    const card = await mount();
    click(card);
    await runToRest();
    click(card);
    await rendered(card);
    expect(card._omega).toBe(12);
    expect(statusText(card)).toBe(en.status.spinning);
  });
});

describe("dragging", () => {
  it("throws the wheel the way it was flicked", async () => {
    const clockwise = await mount();
    drag(clockwise, 0, 90);
    // 90° in 72 ms.
    expect(clockwise._omega).toBeCloseTo(Math.PI / 2 / 0.072, 6);

    const back = await mount();
    drag(back, 90, 0);
    expect(back._omega).toBeCloseTo(-Math.PI / 2 / 0.072, 6);
  });

  it("turns with the pointer while it is held", async () => {
    const card = await mount();
    pointer(card, "pointerdown", 0);
    pointer(card, "pointermove", 30);
    pointer(card, "pointermove", 60);
    expect(card._angle).toBeCloseTo(Math.PI / 3, 10);
  });

  it("follows a drag across the 180° seam the short way round", async () => {
    const card = await mount();
    pointer(card, "pointerdown", 170);
    pointer(card, "pointermove", 190);
    expect(card._angle).toBeCloseTo((20 * Math.PI) / 180, 10);
  });

  it("caps a throw at the top speed", async () => {
    const card = await mount();
    pointer(card, "pointerdown", 0);
    pointer(card, "pointermove", 80, 1);
    pointer(card, "pointermove", 160, 1);
    pointer(card, "pointerup", 160, 1);
    expect(card._omega).toBe(40);
  });

  it("counts a wobble during a click as a click", async () => {
    const card = await mount();
    pointer(card, "pointerdown", 0);
    pointer(card, "pointermove", 1);
    pointer(card, "pointerup", 1);
    expect(card._omega).toBe(12);
    expect(card._angle).toBe(0);
  });

  it("stops a spinning wheel that is grabbed and held", async () => {
    const card = await mount();
    click(card);
    await frames(5);
    pointer(card, "pointerdown", 0);
    pointer(card, "pointermove", 10);
    await rendered(card);
    expect(card._omega).toBe(0);
    expect(statusText(card)).toBe(en.status.idle);

    pointer(card, "pointerup", 10, 500);
    await rendered(card);
    expect(await runToRest()).toBe(0);
    expect(statusText(card)).toMatch(/^Result: /);
  });

  it("only reacts to the primary button", async () => {
    const card = await mount();
    pointer(card, "pointerdown", 0, 8, 2);
    pointer(card, "pointermove", 45);
    pointer(card, "pointerup", 45);
    expect(card._angle).toBe(0);
    expect(card._omega).toBe(0);
  });

  it("lets go when the pointer is cancelled or the card is removed", async () => {
    const card = await mount();
    pointer(card, "pointerdown", 0);
    pointer(card, "pointermove", 45);
    pointer(card, "pointercancel", 45);
    pointer(card, "pointermove", 90);
    expect(card._angle).toBeCloseTo(Math.PI / 4, 10);

    pointer(card, "pointerdown", 0);
    card.remove();
    document.body.append(card);
    await rendered(card);
    pointer(card, "pointermove", 90);
    expect(card._angle).toBeCloseTo(Math.PI / 4, 10);
  });
});

describe("pegs", () => {
  it("brake the wheel", async () => {
    const framesToRest = async (pegs: boolean): Promise<number> => {
      click(await mount({ pegs, sound: false }));
      return runToRest();
    };
    const smooth = await framesToRest(false);
    const pegged = await framesToRest(true);
    expect(pegged).toBeLessThan(smooth);
  });

  it.each([0.1, 0.3, 0.5, 0.7, 0.9])(
    "never leave the pointer resting on one (random %f)",
    async (random) => {
      vi.mocked(Math.random).mockReturnValue(random);
      const card = await mount({ pegs: true, peg_density: 4, friction: 10 });
      click(card);
      await runToRest();
      await rendered(card);
      // Eased off to the edge of the peg's footprint, or never on it.
      const onPeg = card._computeOffPegPlan(card._angle);
      expect(onPeg?.proximity ?? 0).toBeCloseTo(0, 9);
      expect(statusText(card)).toMatch(/^Result: /);
    },
  );

  it("ease off a peg at once under reduced motion", async () => {
    env.reducedMotion = true;
    const card = await mount({ pegs: true, peg_density: 4 });
    for (let i = 0; i < 12; i++) {
      click(card);
      const onPeg = card._computeOffPegPlan(card._angle);
      expect(onPeg?.proximity ?? 0).toBeCloseTo(0, 9);
    }
    expect(await runToRest()).toBe(0);
  });

  it("can be re-spun while the wheel is still easing off one", async () => {
    const card = await mount({ pegs: true, peg_density: 4, friction: 10 });
    for (let spin = 0; spin < 8; spin++) {
      click(card);
      while (card._omega !== 0) await frames();
      // Speed is gone; a settle tween may still hold the frame loop.
      press(card, "Enter");
      expect(card._omega).toBe(12);
      await runToRest();
    }
    await rendered(card);
    expect(statusText(card)).toMatch(/^Result: /);
  });
});

describe("sound", () => {
  it("clicks as segments pass the pointer, harder the faster", async () => {
    const card = await mount();
    click(card);
    await runToRest();
    const peaks = audio.filter((op) => op[0] === "peak").map((op) => op[1]);
    expect(clicksPlayed()).toBeGreaterThan(8);
    expect(peaks[0]).toBeGreaterThan(peaks[peaks.length - 1] as number);
  });

  it("clicks while the wheel is turned by hand", async () => {
    const card = await mount();
    drag(card, 0, 135);
    expect(clicksPlayed()).toBe(3);
  });

  it("clicks once per peg when there are pegs", async () => {
    const card = await mount({ pegs: true, peg_density: 2 });
    pointer(card, "pointerdown", 0);
    for (let degrees = 5; degrees <= 45; degrees += 5) {
      pointer(card, "pointermove", degrees);
    }
    // 8 segments × 3 pegs = one every 15°.
    expect(clicksPlayed()).toBe(3);
  });

  it("stays silent when sound is off", async () => {
    const card = await mount({ sound: false });
    click(card);
    await runToRest();
    expect(audio).toEqual([]);
  });

  it("wakes a suspended audio context on the first gesture", async () => {
    env.audio = "suspended";
    const card = await mount();
    press(card, "Enter");
    expect(audio).toEqual([["resume"]]);
    await runToRest();
    expect(clicksPlayed()).toBeGreaterThan(0);
  });

  it("spins all the same in a browser without Web Audio", async () => {
    env.audio = "none";
    const card = await mount();
    click(card);
    await runToRest();
    await rendered(card);
    expect(statusText(card)).toMatch(/^Result: /);
  });

  it("frees each click's audio nodes and closes down when removed", async () => {
    const card = await mount();
    drag(card, 0, 50);
    const source = audio.length;
    expect(clicksPlayed()).toBe(1);
    card.remove();
    await flush();
    expect(audio.slice(source)).toEqual([["close"]]);
  });
});

describe("selector mode", () => {
  const selector = (extra: Record<string, unknown> = {}): Promise<Card> =>
    mount({
      selector_mode: true,
      segments: 4,
      labels: ["a", "b", "c", "d"],
      ...extra,
    });

  it("steps one segment per arrow key and announces it", async () => {
    const card = await selector();
    expect(statusText(card)).toBe(en.status.idle_selector);
    expect(wheel(card).getAttribute("aria-keyshortcuts")).toContain(
      "ArrowLeft",
    );

    press(card, "ArrowRight");
    await rendered(card);
    expect(statusText(card)).toBe("Result: b");

    press(card, "ArrowLeft");
    press(card, "ArrowLeft");
    await rendered(card);
    expect(statusText(card)).toBe("Result: d");
  });

  it("re-fires the selection on Space, but not before there is one", async () => {
    const card = await selector({ result_entity: "input_text.pick" });
    press(card, " ");
    expect(serviceCalls()).toEqual([]);

    press(card, "ArrowRight");
    press(card, " ");
    press(card, "Enter");
    await flush();
    expect(serviceCalls().map((call) => call[2])).toEqual([
      { entity_id: "input_text.pick", value: "b" },
      { entity_id: "input_text.pick", value: "b" },
      { entity_id: "input_text.pick", value: "b" },
    ]);
  });

  it("picks the segment a drag is released on, without spinning", async () => {
    const card = await selector();
    drag(card, 0, 100);
    await rendered(card);
    expect(statusText(card)).toBe("Result: d");
    expect(card._omega).toBe(0);
    expect(await runToRest()).toBe(0);
    // Snapped so the segment sits centred under the pointer.
    expect(card._angle).toBeCloseTo(Math.PI / 2, 10);
  });
});

describe("actions", () => {
  /** A wheel whose second segment carries `action`, stepped onto it. */
  const fire = async (
    action: unknown,
    extra: Record<string, unknown> = {},
  ): Promise<Card> => {
    const card = await mount({
      selector_mode: true,
      segments: 4,
      labels: ["a", "b", "c", "d"],
      actions: [null, action],
      disable_confirm_actions: true,
      ...extra,
    });
    press(card, "ArrowRight");
    await flush();
    return card;
  };

  it("runs a script given as shorthand", async () => {
    await fire("script.party");
    expect(serviceCalls()).toEqual([["script", "party", {}, undefined]]);
  });

  it("calls a service with its data and target", async () => {
    await fire({
      action: "call-service",
      service: "light.turn_on",
      service_data: { brightness: 10 },
      target: { entity_id: "light.desk" },
    });
    await fire({
      action: "perform-action",
      perform_action: "scene.turn_on",
      data: { transition: 2 },
    });
    expect(serviceCalls()).toEqual([
      ["light", "turn_on", { brightness: 10 }, { entity_id: "light.desk" }],
      ["scene", "turn_on", { transition: 2 }, undefined],
    ]);
  });

  it("prefers `data` over the legacy `service_data`", async () => {
    await fire({
      action: "call-service",
      service: "light.turn_on",
      data: { brightness: 1 },
      service_data: { brightness: 2 },
    });
    expect(serviceCalls()[0]?.[2]).toEqual({ brightness: 1 });
  });

  it("hands the winning segment to the action as wheel context", async () => {
    await fire(
      {
        action: "perform-action",
        perform_action: "script.generic",
        data: { wheel_label: "mine", extra: 1 },
      },
      { wheel_context: true, colors: ["#102030", "rgb(1, 2, 3)"] },
    );
    expect(serviceCalls()[0]?.[2]).toEqual({
      wheel_index: 1,
      // The action's own data wins over what the card injects.
      wheel_label: "mine",
      wheel_color: "rgb(1, 2, 3)",
      wheel_color_rgb: [1, 2, 3],
      wheel_label_color: "#ffffff",
      wheel_label_color_rgb: [255, 255, 255],
      extra: 1,
    });
  });

  it("leaves the RGB out of the context for a colour it can't parse", async () => {
    await fire("script.generic", {
      wheel_context: true,
      colors: [null, "var(--accent-color)"],
    });
    expect(serviceCalls()[0]?.[2]).toEqual({
      wheel_index: 1,
      wheel_label: "b",
      wheel_color: "var(--accent-color)",
      wheel_label_color: "#1a1a1a",
      wheel_label_color_rgb: [26, 26, 26],
    });
  });

  it.each(["nodot", ".leading", "trailing."])(
    "skips the service name %j, which has no domain or no name",
    async (service) => {
      await fire({ action: "perform-action", perform_action: service });
      expect(serviceCalls()).toEqual([]);
    },
  );

  it("navigates, pushing or replacing the history entry", async () => {
    await fire({ action: "navigate", navigation_path: "/lovelace/1" });
    await fire({
      action: "navigate",
      navigation_path: "/lovelace/2",
      navigation_replace: true,
    });
    expect(calls).toEqual([
      ["pushState", "/lovelace/1"],
      ["event", "location-changed", { replace: false }],
      ["replaceState", "/lovelace/2"],
      ["event", "location-changed", { replace: true }],
    ]);
  });

  it("opens a URL in a new tab that can't reach back", async () => {
    await fire({ action: "url", url_path: "https://example.com" });
    expect(calls).toEqual([
      ["open", "https://example.com", "_blank", "noopener,noreferrer"],
    ]);
  });

  it("opens more-info, toggles, starts Assist and fires a DOM event", async () => {
    await fire({ action: "more-info", entity: "sensor.a" });
    await fire({ action: "toggle", entity: "switch.a" });
    await fire({ action: "assist", pipeline_id: "home" });
    await fire({ action: "fire-dom-event", browser_mod: { popup: 1 } });
    expect(events()).toEqual([
      ["hass-more-info", { entityId: "sensor.a" }],
      ["hass-assist-show", { pipeline_id: "home", start_listening: false }],
      ["ll-custom", { browser_mod: { popup: 1 } }],
    ]);
    expect(serviceCalls()).toEqual([
      ["homeassistant", "toggle", {}, { entity_id: "switch.a" }],
    ]);
  });

  it.each([
    { action: "none" },
    { action: "more-info" },
    { action: "toggle" },
    { action: "not-a-real-action" },
    "",
  ])("does nothing for %j", async (action) => {
    await fire(action);
    expect(calls).toEqual([]);
  });

  it("does nothing while hass isn't there yet", async () => {
    const card = await fire(null);
    card.hass = undefined;
    card.setConfig({
      type: TYPE,
      selector_mode: true,
      actions: ["script.party"],
    });
    press(card, "ArrowRight");
    await flush();
    expect(calls).toEqual([]);
  });

  it("gives segments that share a label the same action", async () => {
    const card = await fire("script.b", { labels: ["a", "b", "a", "b"] });
    press(card, "ArrowRight");
    press(card, "ArrowRight");
    await flush();
    expect(serviceCalls()).toEqual([
      ["script", "b", {}, undefined],
      ["script", "b", {}, undefined],
    ]);
  });

  describe("confirmation", () => {
    const asked = (): unknown[] =>
      calls.filter((op) => op[0] === "confirm").map((op) => op[1]);

    it("asks first, naming the action and the result", async () => {
      await fire("script.party", { disable_confirm_actions: false });
      expect(asked()).toEqual(['Run "script.party" for "b"?']);
      expect(serviceCalls()).toHaveLength(1);
    });

    it("doesn't run the action when the answer is no", async () => {
      env.confirm = false;
      await fire("script.party", { disable_confirm_actions: false });
      expect(asked()).toHaveLength(1);
      expect(serviceCalls()).toEqual([]);
    });

    it("skips the prompt for an action that opts out", async () => {
      await fire(
        { action: "url", url_path: "https://a.test", confirmation: false },
        { disable_confirm_actions: false },
      );
      expect(asked()).toEqual([]);
      expect(calls).toHaveLength(1);
    });

    it("uses the action's own wording when it has one", async () => {
      await fire(
        {
          action: "url",
          url_path: "https://a.test",
          confirmation: { text: "Leave the dashboard?" },
        },
        { disable_confirm_actions: false },
      );
      expect(asked()).toEqual(["Leave the dashboard?"]);
    });

    it.each([
      [{ action: "call-service", service: "light.turn_on" }, "light.turn_on"],
      [{ action: "navigate", navigation_path: "/a" }, "navigate: /a"],
      [{ action: "url", url_path: "https://a.test" }, "https://a.test"],
      [{ action: "more-info", entity: "sensor.a" }, "more-info: sensor.a"],
      [{ action: "toggle" }, "toggle: ?"],
      [{ action: "assist" }, "assist"],
      [{ action: "fire-dom-event" }, "fire-dom-event"],
      [{ action: "not-a-real-action" }, "not-a-real-action"],
    ])("names %j as %j in the prompt", async (action, name) => {
      await fire(action, { disable_confirm_actions: false });
      expect(asked()).toEqual([`Run "${name}" for "b"?`]);
    });
  });
});

describe("what a result sets off", () => {
  const winning = async (
    config: Record<string, unknown>,
    hass: Record<string, unknown> = {},
  ): Promise<Card> => {
    const card = await mount(
      { selector_mode: true, segments: 4, ...config },
      hass,
    );
    press(card, "ArrowRight");
    await flush();
    await flush();
    return card;
  };

  it("writes the result to the helper, cut to what a state can hold", async () => {
    await winning({
      labels: ["a", "x".repeat(300)],
      result_entity: "input_text.result",
    });
    expect(serviceCalls()).toEqual([
      [
        "input_text",
        "set_value",
        { entity_id: "input_text.result", value: "x".repeat(255) },
      ],
    ]);
  });

  it("turns the lights that can show it the winning colour", async () => {
    await winning(
      {
        colors: ["#000000", "#f4a261"],
        light_sync_entities: [
          "light.colour",
          "light.white_only",
          "light.unknown",
        ],
      },
      {
        states: {
          "light.colour": {
            state: "on",
            attributes: { supported_color_modes: ["color_temp", "xy"] },
          },
          "light.white_only": {
            state: "on",
            attributes: { supported_color_modes: ["color_temp"] },
          },
        },
      },
    );
    const rgb_color = [244, 162, 97];
    expect(serviceCalls()).toEqual([
      ["light", "turn_on", { entity_id: "light.colour", rgb_color }],
      ["light", "turn_on", { entity_id: "light.unknown", rgb_color }],
    ]);
  });

  it("leaves the lights alone for a colour with no RGB value", async () => {
    await winning({
      colors: [null, "var(--accent-color)"],
      light_sync_entities: ["light.colour"],
    });
    expect(serviceCalls()).toEqual([]);
  });

  it("speaks the result, reading an icon label as words", async () => {
    await winning({
      labels: ["a", "mdi:food-croissant"],
      tts_engine: "tts.piper",
      tts_announce_entities: ["media_player.kitchen", "media_player.hall"],
    });
    expect(serviceCalls()).toEqual([
      [
        "tts",
        "speak",
        {
          media_player_entity_id: ["media_player.kitchen", "media_player.hall"],
          message: "food croissant",
        },
        { entity_id: "tts.piper" },
      ],
    ]);
  });

  it.each([
    { tts_engine: "tts.piper" },
    { tts_announce_entities: ["media_player.kitchen"] },
    { tts_engine: "", tts_announce_entities: [], light_sync_entities: [] },
    { result_entity: "" },
  ])("does nothing with a half-configured %j", async (config) => {
    await winning(config);
    expect(calls).toEqual([]);
  });

  it("carries on when a service call fails", async () => {
    env.failServices = true;
    const card = await winning({
      result_entity: "input_text.result",
      light_sync_entities: ["light.a"],
      tts_engine: "tts.piper",
      tts_announce_entities: ["media_player.kitchen"],
    });
    await rendered(card);
    expect(serviceCalls()).toHaveLength(3);
    expect(console.warn).toHaveBeenCalledTimes(3);
    expect(statusText(card)).toBe("Result: 2");
  });
});

describe("todo list", () => {
  const list = (state: string): Record<string, unknown> => ({
    states: { "todo.chores": { state, attributes: {} } },
  });
  const fetches = (): number =>
    calls.filter((op) => op[0] === "callWS").length;

  it("fills the wheel with the list's open items", async () => {
    env.todoItems = [
      { summary: "Dishes", status: "needs_action" },
      { summary: "Laundry", status: "completed" },
      { summary: "Bins" },
      { summary: "Dishes", status: "needs_action" },
      { summary: "Hoover", status: "needs_action" },
      { summary: "Plants", status: "needs_action" },
      { summary: "Windows", status: "needs_action" },
    ];
    const card = await mount(
      { todo_entity: "todo.chores", labels: ["ignored"], selector_mode: true },
      list("5"),
    );
    expect(calls).toEqual([
      ["callWS", { type: "todo/item/list", entity_id: "todo.chores" }],
    ]);
    // Done items and the repeated one are left out; five are left.
    const seen: string[] = [];
    for (let i = 0; i < 5; i++) {
      press(card, "ArrowRight");
      await rendered(card);
      seen.push(statusText(card));
    }
    expect(seen).toEqual([
      "Result: Bins",
      "Result: Hoover",
      "Result: Plants",
      "Result: Windows",
      "Result: Dishes",
    ]);
  });

  it("repeats the items round the wheel when there are fewer than four", async () => {
    env.todoItems = [{ summary: "Dishes" }, { summary: "Bins" }];
    const card = await mount(
      { todo_entity: "todo.chores", selector_mode: true },
      list("2"),
    );
    press(card, "ArrowLeft");
    await rendered(card);
    expect(statusText(card)).toBe("Result: Bins");
    expect(card._arcs()).toHaveLength(4);
  });

  it("fetches again when the list's state changes, and only then", async () => {
    env.todoItems = [{ summary: "Dishes" }];
    const card = await mount({ todo_entity: "todo.chores" }, list("1"));
    expect(fetches()).toBe(1);

    card.hass = fakeHass(list("1"));
    await rendered(card);
    expect(fetches()).toBe(1);

    card.hass = fakeHass(list("2"));
    await rendered(card);
    expect(fetches()).toBe(2);
  });

  it("says so when the list has nothing open", async () => {
    const card = await mount({ todo_entity: "todo.chores" }, list("0"));
    expect(statusText(card)).toBe(en.status.todo_empty);
  });

  it("waits for a list that hass doesn't know yet", async () => {
    const card = await mount({ todo_entity: "todo.chores" });
    expect(fetches()).toBe(0);
    expect(statusText(card)).toBe(en.status.todo_empty);
  });

  it("shows an empty wheel when the list can't be read", async () => {
    env.failWs = true;
    const card = await mount({ todo_entity: "todo.chores" }, list("3"));
    expect(console.warn).toHaveBeenCalledOnce();
    expect(statusText(card)).toBe(en.status.todo_empty);
  });

  it("drops the old items when another list is chosen", async () => {
    env.todoItems = [{ summary: "Dishes" }];
    const card = await mount({ todo_entity: "todo.chores" }, list("1"));
    expect(card._todoItems).toHaveLength(1);
    card.setConfig({ type: TYPE, todo_entity: "todo.other" });
    expect(card._todoItems).toBeNull();
  });
});

describe("hass updates", () => {
  it("ignores an update that changes nothing the card shows", async () => {
    const card = await mount();
    ops.length = 0;
    card.hass = fakeHass({ states: { "sun.sun": { state: "above_horizon" } } });
    await rendered(card);
    expect(ops).toEqual([]);
  });

  it("repaints when the theme or its dark mode changes", async () => {
    const card = await mount();
    for (const themes of [
      { darkMode: true, theme: "default" },
      { darkMode: true, theme: "midnight" },
    ]) {
      ops.length = 0;
      card.hass = fakeHass({ themes });
      await rendered(card);
      expect(ops.length, JSON.stringify(themes)).toBeGreaterThan(0);
    }
  });

  it("follows the language of hass, unless the card sets its own", async () => {
    const card = await mount();
    card.hass = fakeHass({ locale: { language: "de" } });
    await rendered(card);
    expect(statusText(card)).toBe(de.status.idle);

    const pinned = await mount({ language: "en" }, { language: "de" });
    expect(statusText(pinned)).toBe(en.status.idle);
  });
});

describe("status line", () => {
  it("stays in the page for screen readers when hidden from sight", async () => {
    const card = await mount({ show_status: false });
    const status = card.shadowRoot!.querySelector(".status")!;
    expect(status.className).toBe("status status-sr-only");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(statusText(card)).toBe(en.status.idle);
  });

  it("is marked busy for as long as the wheel turns", async () => {
    const card = await mount();
    const busy = (): string | null =>
      card.shadowRoot!.querySelector(".status")!.getAttribute("aria-busy");
    expect(busy()).toBe("false");
    click(card);
    await rendered(card);
    expect(busy()).toBe("true");
  });

  it("shows an icon result as the icon, and reads it out as text", async () => {
    const config = {
      selector_mode: true,
      segments: 4,
      labels: ["a", "mdi:star"],
    };
    const shown = await mount(config);
    press(shown, "ArrowRight");
    await rendered(shown);
    const icon = shown.shadowRoot!.querySelector(".status ha-icon")!;
    expect(icon.getAttribute("icon")).toBe("mdi:star");
    expect(statusText(shown)).toBe("Result:");

    const hidden = await mount({ ...config, show_status: false });
    press(hidden, "ArrowRight");
    await rendered(hidden);
    expect(statusText(hidden)).toBe("Result: mdi:star");
  });
});
