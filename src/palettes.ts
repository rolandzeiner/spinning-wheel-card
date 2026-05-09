import type { Theme } from "./types";

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
  "#E40303", // red
  "#FF8C00", // orange
  "#FFED00", // yellow
  "#008026", // green
  "#004DFF", // indigo
  "#750787", // violet
  "#5BCEFA", // trans light blue
  "#F5A9B8", // trans pink
  "#FFFFFF", // trans white
  "#800080", // bi purple
];

const NEON_PALETTE: ReadonlyArray<string> = [
  "#FF14A6", "#FF6700", "#FFFF00", "#39FF14",
  "#00FFFF", "#1F51FF", "#BF00FF", "#FF00FF",
];

export const THEME_PALETTES: Record<Theme, ReadonlyArray<string>> = {
  default: SEGMENT_COLORS,
  pastel: PASTEL_PALETTE,
  pride: PRIDE_PALETTE,
  neon: NEON_PALETTE,
};

export const DEFAULT_LABEL_COLOR = "#1a1a1a";
