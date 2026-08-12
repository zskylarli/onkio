import { describe, expect, it } from "vitest";
import {
  BPM_MAX_BINS,
  CLUSTER_COLORS,
  KEY_HUES,
  bpmBin,
  bpmBinLabel,
  bpmColor,
  decadeColor,
  decadeOf,
  keyColor,
  makeBpmScale,
  type RGB,
} from "../src/render/palette";

/** Rough perceptual distance — enough to catch "these two look identical". */
function distance(a: RGB, b: RGB): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** A spread of tempos like a general listening library. */
function wideLibrary(): number[] {
  const out: number[] = [];
  for (let bpm = 62; bpm <= 190; bpm += 2) out.push(bpm);
  return out;
}

/** A house/tech-house crate: everything inside one traditional 10-BPM bin. */
function tightCrate(): number[] {
  const out: number[] = [];
  for (let i = 0; i < 800; i++) out.push(120 + (i % 10));
  return out;
}

describe("BPM bins", () => {
  it("keeps 10-BPM groups for a library spread across tempos", () => {
    const scale = makeBpmScale(wideLibrary());
    expect(scale.width).toBe(10);
    expect(bpmBin(120, scale)).toBe(bpmBin(129, scale));
    expect(bpmBin(120, scale)).not.toBe(bpmBin(130, scale));
    expect(bpmBinLabel(bpmBin(124, scale), scale)).toBe("120–130");
  });

  it("narrows the bins when the whole collection sits in one of them", () => {
    const scale = makeBpmScale(tightCrate());
    expect(scale.width).toBeLessThanOrEqual(2);
    // The point of the exercise: these must no longer be the same color.
    expect(bpmBin(122, scale)).not.toBe(bpmBin(128, scale));
  });

  it("never produces more bins than the palette can distinguish", () => {
    for (const bpms of [wideLibrary(), tightCrate(), [60, 200], [128], [90, 128, 174]]) {
      const scale = makeBpmScale(bpms);
      expect(scale.count).toBeGreaterThan(0);
      expect(scale.count).toBeLessThanOrEqual(BPM_MAX_BINS);
    }
  });

  it("sizes from the central mass, so one outlier can't flatten the scale", () => {
    const scale = makeBpmScale([...tightCrate(), 70, 174]);
    expect(scale.width).toBeLessThanOrEqual(2.5);
    // The outliers still get a bin — the end bins absorb them.
    expect(bpmBin(70, scale)).toBe(0);
    expect(bpmBin(174, scale)).toBe(scale.count - 1);
    expect(scale.underflow).toBe(true);
    expect(scale.overflow).toBe(true);
  });

  it("clamps extremes into the end bins instead of dropping them", () => {
    const scale = makeBpmScale(wideLibrary());
    expect(bpmBin(12, scale)).toBe(0);
    expect(bpmBin(4000, scale)).toBe(scale.count - 1);
  });

  it("labels bins as ranges a human can read", () => {
    const scale = makeBpmScale([...tightCrate(), 70, 174]);
    expect(bpmBinLabel(0, scale)).toMatch(/^<\d+(\.\d)?$/);
    expect(bpmBinLabel(scale.count - 1, scale)).toMatch(/^\d+(\.\d)?\+$/);
    expect(bpmBinLabel(1, scale)).toMatch(/^\d+(\.\d)?–\d+(\.\d)?$/);
    // No float noise from a fractional bin width.
    for (let i = 0; i < scale.count; i++) {
      expect(bpmBinLabel(i, scale)).not.toMatch(/\.\d\d/);
    }
  });

  it("falls back to a usable scale when nothing has a BPM yet", () => {
    const scale = makeBpmScale([]);
    expect(scale.count).toBeGreaterThan(0);
    expect(bpmBinLabel(0, scale)).toBeTruthy();
  });

  it("keeps adjacent tempo bins visually distinct", () => {
    for (const count of [4, 8, BPM_MAX_BINS]) {
      for (let i = 1; i < count; i++) {
        expect(distance(bpmColor(i - 1, count), bpmColor(i, count))).toBeGreaterThan(40);
      }
    }
  });
});

describe("key palette", () => {
  it("covers all 24 Camelot slots with distinct colors", () => {
    const colors: RGB[] = [];
    for (let num = 1; num <= 12; num++) {
      colors.push(keyColor(num, true), keyColor(num, false));
    }
    expect(colors).toHaveLength(24);
    for (let i = 0; i < colors.length; i++) {
      for (let j = i + 1; j < colors.length; j++) {
        expect(distance(colors[i], colors[j])).toBeGreaterThan(24);
      }
    }
  });

  it("renders minor darker than its relative major", () => {
    const sum = (c: RGB) => c[0] + c[1] + c[2];
    for (let num = 1; num <= 12; num++) {
      expect(sum(keyColor(num, true))).toBeLessThan(sum(keyColor(num, false)));
    }
  });

  it("spaces hues rather than dividing the wheel evenly", () => {
    expect(KEY_HUES).toHaveLength(12);
    expect(new Set(KEY_HUES).size).toBe(12);
    // an evenly divided wheel would step by exactly 30° every time
    const steps = KEY_HUES.slice(1).map((h, i) => h - KEY_HUES[i]);
    expect(new Set(steps).size).toBeGreaterThan(1);
  });

  it("wraps Camelot numbers above 12 back onto the wheel", () => {
    expect(keyColor(13, true)).toEqual(keyColor(1, true));
  });
});

describe("decade bins", () => {
  it("floors years onto their decade", () => {
    expect(decadeOf(1999)).toBe(1990);
    expect(decadeOf(2000)).toBe(2000);
    expect(decadeOf(2026)).toBe(2020);
  });

  it("keeps adjacent decades distinct and survives a single-decade library", () => {
    for (let i = 1; i < 8; i++) {
      expect(distance(decadeColor(i - 1, 8), decadeColor(i, 8))).toBeGreaterThan(30);
    }
    expect(decadeColor(0, 1)).toHaveLength(3);
  });
});

describe("cluster palette", () => {
  it("provides 24 distinct hues", () => {
    expect(CLUSTER_COLORS).toHaveLength(24);
    for (let i = 1; i < CLUSTER_COLORS.length; i++) {
      expect(distance(CLUSTER_COLORS[i - 1], CLUSTER_COLORS[i])).toBeGreaterThan(30);
    }
  });
});
