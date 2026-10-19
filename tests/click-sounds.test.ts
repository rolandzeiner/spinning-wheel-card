/**
 * The six click voices, against a recording audio context.
 *
 * Nothing here can listen, so the tests pin what makes a voice safe to
 * fire dozens of times a second: it never schedules in the past, never
 * ramps a gain to 0 (an exponential ramp to 0 throws), stays well under
 * full scale, gets louder with a harder strike, and frees every node.
 */
import { describe, expect, it } from "vite-plus/test";

import { CLICK_SOUNDS, playClick, playSample } from "../src/click-sounds";

type Call = [string, ...unknown[]];

/** An audio context that records what the voices ask of it. */
function recorder(now = 10) {
  const calls: Call[] = [];
  const sources: Array<{ onended: null | (() => void) }> = [];
  let disconnects = 0;
  let nodes = 0;
  const param = (name: string) => ({
    value: 0,
    setValueAtTime: (v: number, t: number) => calls.push([`${name}.set`, v, t]),
    linearRampToValueAtTime: (v: number, t: number) => calls.push([`${name}.linear`, v, t]),
    exponentialRampToValueAtTime: (v: number, t: number) => calls.push([`${name}.exp`, v, t]),
  });
  const node = (kind: string) => {
    nodes++;
    const n = {
      kind,
      type: "",
      buffer: null as unknown,
      frequency: param("frequency"),
      Q: param("Q"),
      gain: param("gain"),
      onended: null as null | (() => void),
      connect: <T>(next: T): T => next,
      disconnect: () => {
        disconnects++;
      },
      start: (t: number) => calls.push(["start", kind, t]),
      stop: (t: number) => calls.push(["stop", kind, t]),
    };
    if (kind === "source" || kind === "oscillator") sources.push(n);
    return n;
  };
  const ctx = {
    currentTime: now,
    sampleRate: 8000,
    destination: node("destination"),
    createBuffer: (_c: number, length: number) => {
      calls.push(["buffer", length]);
      return { getChannelData: () => new Float32Array(length) };
    },
    createBufferSource: () => node("source"),
    createOscillator: () => node("oscillator"),
    createBiquadFilter: () => node("filter"),
    createGain: () => node("gain"),
  };
  return {
    ctx: ctx as unknown as BaseAudioContext,
    calls,
    end: () => sources.forEach((s) => s.onended?.()),
    /** Nodes made, minus the destination. */
    made: () => nodes - 1,
    freed: () => disconnects,
  };
}

const peaks = (calls: Call[]): number[] =>
  calls.filter((c) => c[0] === "gain.linear").map((c) => c[1] as number);

describe.each(CLICK_SOUNDS)("the %s click", (sound) => {
  it("starts no earlier than asked, and never in the past", () => {
    const r = recorder(10);
    playClick(sound, r.ctx, 0.5, 9);
    const starts = r.calls.filter((c) => c[0] === "start").map((c) => c[2] as number);
    expect(starts.length).toBeGreaterThan(0);
    expect(Math.min(...starts)).toBe(10);
  });

  it("fades out towards 0.001, never to zero", () => {
    const r = recorder();
    playClick(sound, r.ctx, 1, 10);
    const targets = r.calls.filter((c) => c[0].endsWith(".exp")).map((c) => c[1] as number);
    expect(targets.every((v) => v > 0)).toBe(true);
  });

  it("stays well under full scale, and is louder struck hard", () => {
    const soft = recorder();
    playClick(sound, soft.ctx, 0, 10);
    const hard = recorder();
    playClick(sound, hard.ctx, 1, 10);
    expect(Math.max(...peaks(hard.calls))).toBeLessThanOrEqual(0.3);
    expect(Math.max(...peaks(hard.calls))).toBeGreaterThan(Math.max(...peaks(soft.calls)));
  });

  it("frees every node it made once it has played", () => {
    const r = recorder();
    playClick(sound, r.ctx, 0.7, 10);
    r.end();
    expect(r.freed()).toBe(r.made());
  });
});

describe("the shared noise", () => {
  it("is made once per audio context, not once per click", () => {
    const r = recorder();
    for (let i = 0; i < 5; i++) playClick("ratchet", r.ctx, 1, 10 + i * 0.05);
    expect(r.calls.filter((c) => c[0] === "buffer")).toHaveLength(1);
  });
});

describe("playSample", () => {
  it("plays eleven strikes, each later and softer than the one before", () => {
    const r = recorder(2);
    playSample("classic", r.ctx);
    const starts = r.calls.filter((c) => c[0] === "start").map((c) => c[2] as number);
    expect(starts).toHaveLength(11);
    for (let i = 1; i < starts.length; i++) expect(starts[i]).toBeGreaterThan(starts[i - 1]);
    const p = peaks(r.calls);
    expect(p[0]).toBeGreaterThan(p[p.length - 1]);
  });
});
