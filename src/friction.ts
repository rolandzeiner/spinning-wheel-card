import type { FrictionPreset } from "./types";

/** Pre-v1.2 string preset → 1–10 slider position. Anchored so
 *  "medium" maps exactly to the new default (5), matching the
 *  historical feel for dashboards saved before the slider migration. */
const FRICTION_PRESET_TO_LEVEL: Record<FrictionPreset, number> = {
  low: 3,
  medium: 5,
  high: 7,
};

/** Normalise the user's `friction` to an integer 1–10. Accepts the
 *  pre-v1.2 string presets as aliases. Falls back to 5 ("medium")
 *  on any unexpected shape. */
export const normalizeFriction = (value: unknown): number => {
  if (typeof value === "string") {
    return FRICTION_PRESET_TO_LEVEL[value as FrictionPreset] ?? 5;
  }
  if (typeof value === "number" && Number.isInteger(value)) {
    if (value < 1) return 1;
    if (value > 10) return 10;
    return value;
  }
  return 5;
};

/** Per-frame velocity multiplier at 60 fps for a given slider level.
 *  Piecewise linear with anchors at the slider extremes and the
 *  centre, where old "medium" lands exactly:
 *    1  → 0.998 (long lazy spin)
 *    3  → 0.994 (close to the old "low" preset of 0.995)
 *    5  → 0.99  (old "medium" — new default)
 *    7  → 0.982 (close to the old "high" preset of 0.98)
 *   10  → 0.97  (stops quickly)
 *  1–5 covers the lighter half (0.998 → 0.99), 5–10 the heavier
 *  (0.99 → 0.97) — extra resolution where it matters. */
export const frictionMultiplier = (level: number): number => {
  if (level <= 5) return 0.998 - (0.008 * (level - 1)) / 4;
  return 0.99 - (0.02 * (level - 5)) / 5;
};

/** Constant angular deceleration (rad/s²) for the Coulomb friction
 *  term — physical model of dry axle / bearing friction. Independent
 *  of speed, so unlike `frictionMultiplier` (viscous, exponential
 *  decay → asymptotic stop) this term drives finite-time stop and
 *  removes the "wheel crawls below the threshold then snaps" tail.
 *
 *  Scaled with the same 1–10 slider as viscous friction so one knob
 *  drives both: level 5 returns the calibration value `0.3 rad/s²`,
 *  giving a slider-5 wheel an ~0.3 s settle from 0.1 rad/s — short
 *  enough to feel snappy, long enough to look natural.
 *
 *  Pure / testable. */
export const coulombDecel = (level: number): number => {
  const calibrated = 0.3; // rad/s² at slider 5
  return calibrated * (level / 5);
};

/** Brake bump a peg gives as it passes the pointer, in rad/s: 0.08 at
 *  level 5, scaled by the same 1–10 slider. The card applies it once per
 *  frame that crosses a peg, however many pegs that frame swept. */
export const pegDrag = (level: number): number => 0.08 * (level / 5);

/** Seconds a wheel launched at `omega` rad/s takes to stop at this
 *  friction level, stepped at 60 fps with the card's own terms and stop
 *  threshold. `pegs` is the number of pegs around the rim, 0 for none;
 *  each frame that crosses one brakes by `pegDrag`, as in the card.
 *  The editor quotes it under the friction slider. */
export const stopSeconds = (level: number, omega: number, pegs = 0): number => {
  const dt = 1 / 60;
  const viscous = frictionMultiplier(level);
  const coulomb = coulombDecel(level) * dt;
  const pegStep = pegs > 0 ? (Math.PI * 2) / pegs : 0;
  let speed = omega;
  let angle = 0;
  let passed = 0;
  let t = 0;
  while (speed >= 0.01 && t < 120) {
    angle += speed * dt;
    speed *= viscous;
    speed = speed <= coulomb ? 0 : speed - coulomb;
    if (pegStep > 0 && Math.floor(angle / pegStep) > passed) {
      passed = Math.floor(angle / pegStep);
      speed = Math.max(0, speed - pegDrag(level));
    }
    t += dt;
  }
  return t;
};
