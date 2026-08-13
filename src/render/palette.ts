/**
 * Color encodings for the map. Kept free of deck.gl/WebGL so the binning
 * rules are unit-testable.
 *
 * Every mode is binned rather than a continuous ramp: at 6k points a smooth
 * gradient is impossible to read back, and an unreadable encoding gets
 * ignored. Each bin is a discrete, nameable class that the legend can list.
 */

export type RGB = [number, number, number];
export type Theme = "dark" | "light";

export function hslToRgb(h: number, s: number, l: number): RGB {
  const f = (n: number) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [f(0), f(8), f(4)];
}

/** Clusters: hue wheel walked by the golden angle so neighbors never collide. */
export const CLUSTER_COLORS: RGB[] = [];
for (let i = 0; i < 24; i++) {
  CLUSTER_COLORS.push(hslToRgb(((i * 137.5) % 360) / 360, 0.65, 0.6));
}

/**
 * Collections: a short hand-picked set rather than the golden-angle wheel.
 * There are normally two, they are compared against each other constantly,
 * and the pair has to stay unambiguous next to the cluster palette.
 */
export const COLLECTION_COLORS: RGB[] = [
  [94, 234, 212],
  [244, 114, 182],
  [250, 204, 21],
  [129, 140, 248],
  [74, 222, 128],
  [248, 113, 113],
];

export function collectionColor(i: number): RGB {
  return COLLECTION_COLORS[i % COLLECTION_COLORS.length];
}

// ---- Genre: deterministic categories ----

export type NormalizedGenre = { key: string; label: string };

/** Collapse cosmetic whitespace and casing while keeping human-readable text. */
export function normalizeGenre(raw: string | undefined): NormalizedGenre | null {
  const label = raw?.trim().replace(/\s+/g, " ");
  if (!label) return null;
  return { key: label.toLocaleLowerCase("en-US"), label };
}

function genreHash(key: string): number {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) {
    hash = Math.imul(hash ^ key.charCodeAt(i), 16777619);
  }
  return hash >>> 0;
}

/** The normalized name, not encounter order, decides a genre's color. */
export function genreColor(raw: string): RGB {
  const key = normalizeGenre(raw)?.key ?? "";
  const hash = genreHash(key);
  const hue = ((hash * 0.61803398875) % 1 + 1) % 1;
  const saturation = 0.58 + ((hash >>> 8) % 16) / 100;
  const lightness = 0.5 + ((hash >>> 16) % 13) / 100;
  return hslToRgb(hue, saturation, lightness);
}

/**
 * Pick a stable display spelling among equivalent values. Prefer ordinary
 * title-like casing, while retaining punctuation and acronyms such as R&B.
 */
export function genreDisplayLabel(labels: Iterable<string>): string {
  const candidates = [...new Set(labels)].sort((a, b) => a.localeCompare(b, "en-US"));
  const score = (label: string): number => {
    const cased = [...label].filter((c) => c.toLocaleLowerCase() !== c.toLocaleUpperCase());
    const first = cased[0];
    const allUpper = cased.length > 2 && cased.every((c) => c === c.toLocaleUpperCase());
    return (first && first === first.toLocaleUpperCase() ? 2 : 0) + (allUpper ? 0 : 1);
  };
  return candidates.sort((a, b) => score(b) - score(a) || a.localeCompare(b, "en-US"))[0] ?? "";
}

// ---- BPM: adaptive bins, slow (blue) → fast (red) ----

/**
 * Bin width adapts to the collection. Fixed 10-BPM groups are right for a
 * general library, but a single-genre DJ crate lives inside one of them —
 * 77% of the reference rekordbox collection falls in 120–130, which paints
 * the entire map one color and says nothing. So the width is chosen from the
 * central spread of the actual data: wide libraries keep 10, tight ones drop
 * to as little as 1 BPM, where 124 and 128 are visibly different tempos.
 *
 * Widths are round numbers only — "122–124" is a legible bin, "121.7–124.3"
 * is not.
 */
export const BPM_BIN_WIDTHS = [1, 2, 2.5, 5, 10];
export const BPM_TARGET_BINS = 10;
export const BPM_MAX_BINS = 14;

export type BpmScale = {
  start: number;
  width: number;
  count: number;
  /** tracks exist below `start` / at or above the top edge — the end bins
   * absorb them, and say so in their label */
  underflow: boolean;
  overflow: boolean;
};

export const DEFAULT_BPM_SCALE: BpmScale = {
  start: 60,
  width: 10,
  count: BPM_MAX_BINS,
  underflow: true,
  overflow: true,
};

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

/**
 * Choose a binning for the BPMs present. Ignores the outer 5% at each end
 * when sizing, so one 70 BPM intro doesn't stretch the scale flat across a
 * crate that is otherwise 120–130; those tracks still get a bin, just a
 * shared one at the edge.
 */
export function makeBpmScale(bpms: readonly number[]): BpmScale {
  const sorted = bpms.filter((b) => Number.isFinite(b) && b > 0).sort((a, b) => a - b);
  if (sorted.length === 0) return DEFAULT_BPM_SCALE;

  const lo = quantile(sorted, 0.05);
  const hi = quantile(sorted, 0.95);
  const ideal = (hi - lo) / BPM_TARGET_BINS;

  let width =
    BPM_BIN_WIDTHS.find((w) => w >= ideal) ?? BPM_BIN_WIDTHS[BPM_BIN_WIDTHS.length - 1];
  let start = Math.floor(lo / width) * width;
  let count = Math.max(1, Math.round((Math.ceil(hi / width) * width - start) / width));

  // A long tail inside the central 90% can still overrun the palette; widen
  // until it fits rather than dropping bins off the end.
  for (let i = BPM_BIN_WIDTHS.indexOf(width) + 1; count > BPM_MAX_BINS && i < BPM_BIN_WIDTHS.length; i++) {
    width = BPM_BIN_WIDTHS[i];
    start = Math.floor(lo / width) * width;
    count = Math.max(1, Math.round((Math.ceil(hi / width) * width - start) / width));
  }
  while (count > BPM_MAX_BINS) {
    width *= 2;
    start = Math.floor(lo / width) * width;
    count = Math.max(1, Math.round((Math.ceil(hi / width) * width - start) / width));
  }

  return {
    start,
    width,
    count,
    underflow: sorted[0] < start,
    overflow: sorted[sorted.length - 1] >= start + count * width,
  };
}

/** Lightness alternates so two adjacent tempo bins never read as one color. */
export function bpmColor(i: number, count: number): RGB {
  const t = count <= 1 ? 0 : i / (count - 1);
  return hslToRgb((240 - 240 * t) / 360, 0.78, i % 2 === 0 ? 0.5 : 0.66);
}

export function bpmBin(bpm: number, scale: BpmScale): number {
  return Math.max(0, Math.min(scale.count - 1, Math.floor((bpm - scale.start) / scale.width)));
}

/** Trim the float noise a 2.5-wide bin would otherwise show. */
function fmtBpm(v: number): string {
  return Number(v.toFixed(1)).toString();
}

export function bpmBinLabel(i: number, scale: BpmScale): string {
  const lo = scale.start + i * scale.width;
  const hi = lo + scale.width;
  if (i === 0 && scale.underflow) return `<${fmtBpm(hi)}`;
  if (i === scale.count - 1 && scale.overflow) return `${fmtBpm(lo)}+`;
  return `${fmtBpm(lo)}–${fmtBpm(hi)}`;
}

// ---- Key: 24 Camelot slots ----

/**
 * Hues are hand-spaced rather than evenly divided — a linear wheel muddies
 * yellow→green, which is where half the Camelot numbers land. Minor (A) is
 * deep and major (B) is bright, so a relative pair reads as one family
 * without the two being confusable.
 */
export const KEY_HUES = [0, 25, 45, 62, 92, 140, 168, 190, 214, 250, 282, 320];

export function keyColor(num: number, minor: boolean): RGB {
  const hue = KEY_HUES[(num - 1) % 12] / 360;
  return minor ? hslToRgb(hue, 0.72, 0.4) : hslToRgb(hue, 0.85, 0.64);
}

// ---- Year: one bin per decade, cool → warm ----

export function decadeColor(i: number, n: number): RGB {
  const t = n <= 1 ? 0 : i / (n - 1);
  return hslToRgb((210 - 190 * t) / 360, 0.7, i % 2 === 0 ? 0.44 : 0.68);
}

export function decadeOf(year: number): number {
  return Math.floor(year / 10) * 10;
}

// ---- theme-dependent chrome ----

export const NO_DATA: Record<Theme, RGB> = {
  dark: [72, 78, 92],
  light: [196, 184, 162],
};
export const GAP_COLOR: Record<Theme, RGB> = {
  dark: [251, 191, 36],
  light: [166, 88, 16],
};
/** The freehand selection outline, matching the accent each theme uses in CSS. */
export const LASSO_COLOR: Record<Theme, RGB> = {
  dark: [94, 234, 212],
  light: [161, 89, 31],
};
/**
 * Tracks found outside the library, ringed rather than filled. Violet is the
 * one hue neither the accent (teal) nor the gap marker (amber) uses, so a ring
 * cannot be mistaken for a selection or for a hole in the crate.
 */
export const EXTERNAL_COLOR: Record<Theme, RGB> = {
  dark: [167, 139, 250],
  light: [109, 40, 217],
};
