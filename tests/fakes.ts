/**
 * Stand-ins for the browser pieces happy-dom doesn't have, so the card can
 * be mounted, spun and painted in a test: a 2D canvas context that records
 * every call, a frame clock, Web Audio, <ha-icon>, and a hass object that
 * records what the card asks of it.
 *
 * Importing this file installs them. Everything is module state — call
 * `reset()` in `beforeEach`.
 */
import { vi } from "vitest";

import "../src/spinning-wheel-card";

export type Op = [name: string, ...args: unknown[]];

/** Everything the tests reach into. Private members are read through this
 *  on purpose: the wheel's state (angle, speed) has no public surface. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Card = HTMLElement & Record<string, any>;

// ---------------------------------------------------------------- canvas

/** Every canvas call since the last `reset()`. Property writes are
 *  recorded as `["set", name, value]`. */
export const ops: Op[] = [];

class FakePath2D {
  constructor(readonly d: string) {}
}

/** Text is as wide as half its font size per character. */
const textWidth = (text: unknown, font: unknown): number => {
  const px = Number(/(\d+(?:\.\d+)?)px/.exec(String(font))?.[1] ?? 10);
  return Array.from(String(text)).length * px * 0.5;
};

const fakeContext = (): unknown => {
  const props: Record<string, unknown> = { fillStyle: "#000000", font: "" };
  const method =
    (name: string) =>
    (...args: unknown[]): unknown => {
      ops.push([name, ...args]);
      if (name === "measureText") {
        return { width: textWidth(args[0], props.font) };
      }
      if (name === "createRadialGradient") return { addColorStop() {} };
      return undefined;
    };
  return new Proxy(props, {
    get: (_, name: string) => (name in props ? props[name] : method(name)),
    set: (_, name: string, value) => {
      props[name] = value;
      ops.push(["set", name, value]);
      return true;
    },
  });
};

/** The canvas calls of the most recent paint. */
export const lastPaint = (): Op[] =>
  ops.slice(ops.map((op) => op[0]).lastIndexOf("setTransform"));

/** Fill colour of each wedge of the most recent paint, in order. */
export const wedgeColours = (): unknown[] => {
  const paint = lastPaint();
  return paint.flatMap((op, i) =>
    op[0] === "moveTo" && op[1] === 0 ? [paint[i + 3]?.[2]] : [],
  );
};

/** Every string drawn by the most recent paint. */
export const texts = (): string[] =>
  lastPaint()
    .filter((op) => op[0] === "fillText")
    .map((op) => String(op[1]));

/** Font sizes (px) the most recent paint set. */
export const fontSizes = (): number[] =>
  lastPaint()
    .filter((op) => op[0] === "set" && op[1] === "font")
    .map((op) => parseFloat(String(op[2]).split(" ")[1] ?? ""));

// ------------------------------------------------------- layout + frames

/** The box the card's wheel area reports. 0×0 = not laid out yet. */
export const wrapBox = { width: 0, height: 0 };

const box = (width: number, height: number): object => ({
  left: 0,
  top: 0,
  width,
  height,
});

const resizeObservers: Array<{
  callback: (entries: unknown[]) => void;
  targets: Element[];
}> = [];

/** Deliver a new size to every live ResizeObserver. */
export const resizeTo = (width: number, height: number): void => {
  for (const observer of resizeObservers) {
    if (observer.targets.length > 0) {
      observer.callback([{ contentRect: { width, height } }]);
    }
  }
};

let now = 1000;
const frameQueue = new Map<number, (time: number) => void>();
let frameId = 0;

export const flush = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

/** Run `count` animation frames, 1/60 s apart. */
export const frames = async (count = 1): Promise<void> => {
  for (let i = 0; i < count; i++) {
    now += 1000 / 60;
    const due = [...frameQueue.values()];
    frameQueue.clear();
    for (const callback of due) callback(now);
    await flush();
  }
};

/** Run frames until nothing asks for another. Returns how many it took. */
export const runToRest = async (limit = 5000): Promise<number> => {
  let count = 0;
  while (frameQueue.size > 0 && count < limit) {
    await frames();
    count += 1;
  }
  return count;
};

// ----------------------------------------------------------------- audio

/** Every Web Audio call since the last `reset()`. */
export const audio: Op[] = [];

/** Switches the tests flip. */
export const env = {
  reducedMotion: false,
  /** How a new AudioContext starts, or "none" for a browser without one. */
  audio: "running" as "running" | "suspended" | "none",
  /** What `window.confirm` answers. */
  confirm: true,
  todoItems: [] as unknown[],
  failServices: false,
  failWs: false,
};

class FakeAudioContext {
  state: string = env.audio;
  sampleRate = 1000;
  destination = {};
  get currentTime(): number {
    return now / 1000;
  }
  async resume(): Promise<void> {
    audio.push(["resume"]);
    this.state = "running";
  }
  async close(): Promise<void> {
    audio.push(["close"]);
  }
  createBuffer(_channels: number, length: number): unknown {
    return { getChannelData: () => new Float32Array(length) };
  }
  private node(kind: string): unknown {
    const node = {
      connect: <T>(next: T): T => next,
      disconnect: () => audio.push(["disconnect", kind]),
      start: (when: number) => audio.push(["start", when]),
      stop() {},
      frequency: {},
      Q: {},
      gain: {
        setValueAtTime() {},
        linearRampToValueAtTime: (peak: number) => audio.push(["peak", peak]),
        exponentialRampToValueAtTime() {},
      },
      onended: null as null | (() => void),
    };
    return node;
  }
  createBufferSource(): unknown {
    return this.node("source");
  }
  createBiquadFilter(): unknown {
    return this.node("filter");
  }
  createGain(): unknown {
    return this.node("gain");
  }
}

/** Clicks the card has scheduled so far. */
export const clicksPlayed = (): number =>
  audio.filter((op) => op[0] === "start").length;

// ------------------------------------------------------------------ hass

/** What the card asked of the outside world since the last `reset()`:
 *  `["callService", domain, service, data, target]`, `["callWS", msg]`,
 *  `["confirm", text]`, `["open", url, ...]`, `["pushState", url]`,
 *  `["replaceState", url]` and `["event", type, detail]`. */
export const calls: Op[] = [];

export const fakeHass = (over: Record<string, unknown> = {}): unknown => ({
  language: "en",
  locale: { language: "en" },
  states: {},
  themes: { darkMode: false, theme: "default" },
  user: { is_admin: true },
  callService: async (...args: unknown[]) => {
    calls.push(["callService", ...args]);
    if (env.failServices) throw new Error("service failed");
  },
  callWS: async (msg: { type: string }) => {
    calls.push(["callWS", msg]);
    if (env.failWs) throw new Error("ws failed");
    if (msg.type === "todo/item/list") return { items: env.todoItems };
    return { id: "wheel_result" };
  },
  ...over,
});

/** Service calls only, as `[domain, service, data, target]`. */
export const serviceCalls = (): unknown[][] =>
  calls.filter((op) => op[0] === "callService").map((op) => op.slice(1));

/** Events the card dispatched, as `[type, detail]`. */
export const events = (): unknown[][] =>
  calls.filter((op) => op[0] === "event").map((op) => op.slice(1));

// ----------------------------------------------------------- <ha-icon>

/** Resolves every icon to a path except `mdi:missing`. */
class FakeHaIcon extends HTMLElement {
  icon = "";
  updateComplete = Promise.resolve();
  connectedCallback(): void {
    const root = this.attachShadow({ mode: "open" });
    if (this.icon === "mdi:missing") return;
    const svg = document.createElement("ha-svg-icon") as HTMLElement & {
      path?: string;
    };
    svg.path = `path-of-${this.icon}`;
    root.append(svg);
  }
}

// --------------------------------------------------------------- install

const install = (name: string, value: unknown): void => {
  Object.defineProperty(globalThis, name, { configurable: true, value });
  Object.defineProperty(window, name, { configurable: true, value });
};

install("Path2D", FakePath2D);
install("requestAnimationFrame", (callback: (time: number) => void) => {
  frameId += 1;
  frameQueue.set(frameId, callback);
  return frameId;
});
install("cancelAnimationFrame", (id: number) => frameQueue.delete(id));
install("matchMedia", () => ({ matches: env.reducedMotion }));
install(
  "ResizeObserver",
  class {
    targets: Element[] = [];
    constructor(readonly callback: (entries: unknown[]) => void) {
      resizeObservers.push(this);
    }
    observe(target: Element): void {
      this.targets.push(target);
    }
    disconnect(): void {
      this.targets = [];
    }
  },
);
const audioContext = {
  configurable: true,
  get: (): unknown => (env.audio === "none" ? undefined : FakeAudioContext),
};
Object.defineProperty(globalThis, "AudioContext", audioContext);
Object.defineProperty(window, "AudioContext", audioContext);
install("confirm", (text: string) => {
  calls.push(["confirm", text]);
  return env.confirm;
});
install("open", (...args: unknown[]) => {
  calls.push(["open", ...args]);
  return null;
});
performance.now = () => now;
window.history.pushState = (_state, _title, url) => {
  calls.push(["pushState", url]);
};
window.history.replaceState = (_state, _title, url) => {
  calls.push(["replaceState", url]);
};
window.addEventListener("location-changed", (event) =>
  calls.push(["event", event.type, (event as CustomEvent).detail]),
);
HTMLCanvasElement.prototype.getContext = function (
  this: HTMLCanvasElement & { fakeContext?: unknown },
) {
  this.fakeContext ??= fakeContext();
  return this.fakeContext;
} as unknown as HTMLCanvasElement["getContext"];
Element.prototype.getBoundingClientRect = function (this: HTMLElement) {
  if (this.classList.contains("wheel-wrap")) {
    return box(wrapBox.width, wrapBox.height);
  }
  if (this.id === "wheel") {
    return box(parseFloat(this.style.width), parseFloat(this.style.height));
  }
  return box(0, 0);
} as Element["getBoundingClientRect"];
customElements.define("ha-icon", FakeHaIcon);

/** Back to a blank page and default switches. `Math.random` is pinned to
 *  0.5: a click then always adds 12 rad/s, clockwise from rest. */
export const reset = (): void => {
  vi.restoreAllMocks();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  document.body.innerHTML = "";
  ops.length = 0;
  audio.length = 0;
  calls.length = 0;
  frameQueue.clear();
  resizeObservers.length = 0;
  Object.assign(wrapBox, { width: 0, height: 0 });
  Object.assign(env, {
    reducedMotion: false,
    audio: "running",
    confirm: true,
    todoItems: [],
    failServices: false,
    failWs: false,
  });
};

// ------------------------------------------------------------ the card

export const TYPE = "custom:spinning-wheel-card";

/** A card on the page with `config`, rendered and painted. */
export const mount = async (
  config: Record<string, unknown> = {},
  hass: Record<string, unknown> = {},
): Promise<Card> => {
  const card = document.createElement("spinning-wheel-card") as Card;
  card.setConfig({ type: TYPE, ...config });
  card.hass = fakeHass(hass);
  for (const type of ["hass-more-info", "hass-assist-show", "ll-custom"]) {
    card.addEventListener(type, (event) =>
      calls.push(["event", type, (event as CustomEvent).detail]),
    );
  }
  document.body.append(card);
  await rendered(card);
  return card;
};

/** Wait for the card's pending render and whatever it awaited. */
export const rendered = async (card: Card): Promise<void> => {
  await card.updateComplete;
  await flush();
  await card.updateComplete;
};

export const wheel = (card: Card): HTMLCanvasElement =>
  card.shadowRoot!.getElementById("wheel") as HTMLCanvasElement;

/** The status line's text. */
export const statusText = (card: Card): string =>
  card.shadowRoot!.querySelector(".status")!.textContent!.trim();

/** A point 100 px from the wheel's centre, `degrees` clockwise from 3
 *  o'clock. */
const at = (
  card: Card,
  degrees: number,
): { clientX: number; clientY: number } => {
  const centre = parseFloat(wheel(card).style.width) / 2;
  const radians = (degrees * Math.PI) / 180;
  return {
    clientX: centre + 100 * Math.cos(radians),
    clientY: centre + 100 * Math.sin(radians),
  };
};

/** A pointer event on the wheel at `degrees`, `afterMs` after the last. */
export const pointer = (
  card: Card,
  type: string,
  degrees = 0,
  afterMs = 8,
  button = 0,
): void => {
  now += afterMs;
  const event = new PointerEvent(type, {
    ...at(card, degrees),
    button,
    pointerId: 1,
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperty(event, "timeStamp", { value: now });
  wheel(card).dispatchEvent(event);
};

export const click = (card: Card): void => {
  pointer(card, "pointerdown");
  pointer(card, "pointerup");
};

/** Press, sweep from `from` to `to` degrees in ten moves, release. */
export const drag = (card: Card, from: number, to: number): void => {
  pointer(card, "pointerdown", from);
  for (let i = 1; i <= 10; i++) {
    pointer(card, "pointermove", from + ((to - from) * i) / 10);
  }
  pointer(card, "pointerup", to);
};

export const press = (card: Card, key: string): boolean =>
  wheel(card).dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
  );
