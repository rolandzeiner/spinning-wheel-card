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
 *  Piecewise linear, anchored so old presets land on the same feel:
 *    1 → 0.998 (long lazy spin)
 *    3 → 0.995  (old "low")
 *    5 → 0.99   (old "medium" — new default)
 *    7 → 0.98   (old "high")
 *   10 → 0.97   (stops quickly)
 *  1–5 covers the lighter half (0.998 → 0.99), 5–10 the heavier
 *  (0.99 → 0.97) — the slot where extra resolution matters. */
export const frictionMultiplier = (level: number): number => {
  if (level <= 5) return 0.998 - (0.008 * (level - 1)) / 4;
  return 0.99 - (0.02 * (level - 5)) / 5;
};
