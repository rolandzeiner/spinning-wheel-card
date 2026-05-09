// Built-in colour-theme palettes + the default segment-label colour.
// Shared by the card (which renders them) and the editor (which projects
// the active palette into the bindings-panel pickers as fallbacks).

import type { Theme } from "./types";

// 8 evenly-spaced HSL colours. Index modulo segments for >8.
const SEGMENT_COLORS: ReadonlyArray<string> = [
  "#e63946", "#f4a261", "#e9c46a", "#a8dadc",
  "#457b9d", "#1d3557", "#9b5de5", "#06d6a0",
];

const PASTEL_PALETTE: ReadonlyArray<string> = [
  "#FFB3BA", "#FFDFBA", "#FDFD96", "#B5EAD7",
  "#BAE1FF", "#C7CEEA", "#E0BBE4", "#FFC8DD",
];

/** Gilbert Baker rainbow (6) + Helms transgender unique stripes (3) +
 *  bisexual purple. Ten colours; cycles for segments > 10. */
const PRIDE_PALETTE: ReadonlyArray<string> = [
  // Gilbert Baker rainbow
  "#E40303", // red
  "#FF8C00", // orange
  "#FFED00", // yellow
  "#008026", // green
  "#004DFF", // indigo
  "#750787", // violet
  // Helms transgender flag — unique stripes
  "#5BCEFA", // light blue
  "#F5A9B8", // pink
  "#FFFFFF", // white
  // Bisexual-flag purple (rgb(128, 0, 128))
  "#800080", // purple
];

const NEON_PALETTE: ReadonlyArray<string> = [
  "#FF14A6", // hot pink
  "#FF6700", // orange
  "#FFFF00", // yellow
  "#39FF14", // green
  "#00FFFF", // cyan
  "#1F51FF", // electric blue
  "#BF00FF", // purple
  "#FF00FF", // magenta
];

export const THEME_PALETTES: Record<Theme, ReadonlyArray<string>> = {
  default: SEGMENT_COLORS,
  pastel: PASTEL_PALETTE,
  pride: PRIDE_PALETTE,
  neon: NEON_PALETTE,
};

export const DEFAULT_LABEL_COLOR = "#1a1a1a";
