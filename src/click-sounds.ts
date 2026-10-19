/**
 * The peg clicks, synthesised with Web Audio — no audio files.
 *
 * Six voices, all with one signature: a strike `intensity` (0..1, from the
 * rim speed; the card maps it) and a start time on the audio clock. A
 * faster strike is louder, shorter and brighter in every voice, so a fast
 * spin reads as a rattle and a slow one as single clicks.
 *
 * `classic` is the click the card has always made. The others add what it
 * lacks — a tuned body, a flapper's snap-back, a metal ring — and were
 * picked by ear in the peg sound lab.
 *
 * Every voice tears its nodes down in `onended`: buffer sources never
 * disconnect themselves, and a fast spin starts several clicks a frame.
 */
import type { ClickSound } from "./types";

export const CLICK_SOUNDS = [
  "classic",
  "wood",
  "flapper",
  "pin",
  "felt",
  "ratchet",
] as const satisfies ReadonlyArray<ClickSound>;

type Voice = (ctx: BaseAudioContext, dest: AudioNode, intensity: number, t0: number) => void;

/** One second of white noise per audio context; each hit starts at a
 *  random offset into it rather than filling a buffer of its own. */
const noiseBuffers = new WeakMap<BaseAudioContext, AudioBuffer>();
function noise(ctx: BaseAudioContext): AudioBuffer {
  let buf = noiseBuffers.get(ctx);
  if (!buf) {
    buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    noiseBuffers.set(ctx, buf);
  }
  return buf;
}

/** ± `amount` of `v`, so a train of clicks isn't one repeated sample. */
const jitter = (v: number, amount: number): number => v * (1 + (Math.random() - 0.5) * 2 * amount);

interface Hit {
  dur: number;
  bp: number;
  q: number;
  lp?: number;
  peak: number;
  attack?: number;
}

/** A filtered noise burst: the strike itself. */
function hit(ctx: BaseAudioContext, dest: AudioNode, t0: number, o: Hit): void {
  const src = ctx.createBufferSource();
  src.buffer = noise(ctx);
  const band = ctx.createBiquadFilter();
  band.type = "bandpass";
  band.frequency.value = o.bp;
  band.Q.value = o.q;
  const low = ctx.createBiquadFilter();
  low.type = "lowpass";
  low.frequency.value = o.lp ?? 8000;
  low.Q.value = 0.7;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.linearRampToValueAtTime(o.peak, t0 + (o.attack ?? 0.001));
  gain.gain.exponentialRampToValueAtTime(0.001, t0 + o.dur);
  src.connect(band).connect(low).connect(gain).connect(dest);
  src.start(t0, Math.random() * 0.9);
  src.stop(t0 + o.dur + 0.02);
  src.onended = (): void => {
    src.disconnect();
    band.disconnect();
    low.disconnect();
    gain.disconnect();
  };
}

interface Mode {
  freq: number;
  decay: number;
  peak: number;
  type?: OscillatorType;
  /** Frequency the mode glides down to over its decay. */
  glide?: number;
  attack?: number;
}

/** A damped tone: the body that rings after the strike. */
function mode(ctx: BaseAudioContext, dest: AudioNode, t0: number, o: Mode): void {
  const osc = ctx.createOscillator();
  osc.type = o.type ?? "sine";
  osc.frequency.setValueAtTime(o.freq, t0);
  if (o.glide) osc.frequency.exponentialRampToValueAtTime(o.glide, t0 + o.decay);
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.linearRampToValueAtTime(o.peak, t0 + (o.attack ?? 0.0008));
  gain.gain.exponentialRampToValueAtTime(0.001, t0 + o.decay);
  osc.connect(gain).connect(dest);
  osc.start(t0);
  osc.stop(t0 + o.decay + 0.02);
  osc.onended = (): void => {
    osc.disconnect();
    gain.disconnect();
  };
}

/** The card's original click: the dry "tok" of a flapper on a plastic
 *  peg. One noise burst, bandpassed tight (Q 3) at a mid frequency, with
 *  a quadratic decay baked into its own buffer. Slow strikes are longer
 *  and woodier (61 ms), fast ones short and bright (13 ms). */
const classic: Voice = (ctx, dest, I, t0) => {
  const dur = 0.061 - 0.048 * I;
  const samples = Math.max(1, Math.floor(ctx.sampleRate * dur));
  const buf = ctx.createBuffer(1, samples, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < samples; i++) {
    const x = i / samples;
    data[i] = (Math.random() * 2 - 1) * (1 - x) * (1 - x);
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = (1500 + 550 * I) * (1 + (Math.random() - 0.5) * 0.16);
  bp.Q.value = 3;
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 3300 + 2200 * I;
  lp.Q.value = 0.7;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0, t0);
  gain.gain.linearRampToValueAtTime(0.09 + 0.08 * I, t0 + 0.0024 - 0.0013 * I);
  gain.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  src.connect(bp).connect(lp).connect(gain).connect(dest);
  src.start(t0);
  src.stop(t0 + dur + 0.02);
  src.onended = (): void => {
    src.disconnect();
    bp.disconnect();
    lp.disconnect();
    gain.disconnect();
  };
};

/** A tap over two tuned body modes. 2.47× is a wood-block ratio:
 *  inharmonic, so it reads as a knock rather than a note. */
const wood: Voice = (ctx, dest, I, t0) => {
  hit(ctx, dest, t0, {
    dur: 0.01 - 0.004 * I,
    bp: jitter(2600, 0.06),
    q: 1.2,
    lp: 6000,
    peak: 0.05 + 0.05 * I,
    attack: 0.0006,
  });
  const decay = 0.05 - 0.022 * I;
  const f = jitter(640, 0.04);
  mode(ctx, dest, t0, { freq: f, decay, peak: 0.11 + 0.06 * I });
  mode(ctx, dest, t0, { freq: f * 2.47, decay: decay * 0.55, peak: 0.035 + 0.03 * I });
};

/** A rubber flap slapping the peg, with a soft thump under it. On a slow
 *  crossing the flap has time to spring back off the peg: a second,
 *  quieter tick. */
const flapper: Voice = (ctx, dest, I, t0) => {
  hit(ctx, dest, t0, {
    dur: 0.024 - 0.01 * I,
    bp: jitter(1200, 0.08),
    q: 0.9,
    lp: 3600 + 1400 * I,
    peak: 0.08 + 0.06 * I,
  });
  mode(ctx, dest, t0, {
    freq: jitter(210, 0.05),
    glide: 110,
    decay: 0.04 - 0.012 * I,
    peak: 0.12 + 0.05 * I,
  });
  if (I < 0.62) {
    hit(ctx, dest, t0 + 0.026 + 0.03 * (0.62 - I), {
      dur: 0.012,
      bp: jitter(1750, 0.08),
      q: 1.4,
      lp: 4000,
      peak: 0.01 + (0.045 * (0.62 - I)) / 0.22,
      attack: 0.0008,
    });
  }
};

/** A steel pin: a bright tick over two inharmonic partials that ring. */
const pin: Voice = (ctx, dest, I, t0) => {
  hit(ctx, dest, t0, {
    dur: 0.006,
    bp: jitter(5200, 0.06),
    q: 2,
    lp: 12000,
    peak: 0.04 + 0.04 * I,
    attack: 0.0004,
  });
  const decay = 0.065 - 0.03 * I;
  const f = jitter(2850, 0.03);
  mode(ctx, dest, t0, { freq: f, decay, peak: 0.045 + 0.025 * I });
  mode(ctx, dest, t0, { freq: f * 1.445, decay: decay * 0.7, peak: 0.025 + 0.02 * I });
};

/** A muted thup: low noise, low-passed, a slow attack and a soft body. */
const felt: Voice = (ctx, dest, I, t0) => {
  hit(ctx, dest, t0, {
    dur: 0.045 - 0.02 * I,
    bp: jitter(850, 0.08),
    q: 1.4,
    lp: 1800,
    peak: 0.11 + 0.05 * I,
    attack: 0.004 - 0.002 * I,
  });
  mode(ctx, dest, t0, {
    freq: jitter(300, 0.05),
    glide: 220,
    decay: 0.03,
    peak: 0.04 + 0.02 * I,
    attack: 0.003,
  });
};

/** A crisp, dry plastic tick with a very short ring, like a freewheel. */
const ratchet: Voice = (ctx, dest, I, t0) => {
  hit(ctx, dest, t0, {
    dur: 0.01 - 0.004 * I,
    bp: jitter(3400, 0.06),
    q: 1.6,
    lp: 7500,
    peak: 0.08 + 0.05 * I,
    attack: 0.0005,
  });
  mode(ctx, dest, t0, {
    freq: jitter(3900, 0.03),
    decay: 0.012,
    peak: 0.025 + 0.015 * I,
    type: "triangle",
    attack: 0.0004,
  });
};

const VOICES: Record<ClickSound, Voice> = { classic, wood, flapper, pin, felt, ratchet };

/** One click in `sound`, starting at `when` on the audio clock (never in
 *  the past). `intensity` is clamped to 0..1. */
export function playClick(
  sound: ClickSound,
  ctx: BaseAudioContext,
  intensity: number,
  when: number,
  dest: AudioNode = ctx.destination,
): void {
  const voice = VOICES[sound] ?? VOICES.classic;
  voice(ctx, dest, Math.max(0, Math.min(1, intensity)), Math.max(when, ctx.currentTime));
}

/** A short spin's worth of clicks, slowing to a stop: what the editor's
 *  Listen button plays. Eleven strikes over about 1.6 s, from a hard one
 *  to the slowest the card makes. */
export function playSample(sound: ClickSound, ctx: BaseAudioContext): void {
  let t = ctx.currentTime + 0.05;
  for (let i = 0; i < 11; i++) {
    const slowing = i / 10;
    playClick(sound, ctx, 1 - 0.6 * slowing, t);
    t += 0.06 + 0.22 * slowing * slowing;
  }
}
