import { describe, expect, it } from "vitest";
import {
  TIMBRE_DIMS,
  TIMBRE_FEATURES,
  extractTimbre,
} from "../src/dsp/timbre";
import { mulberry32 } from "../src/util/rng";

const SR = 22050;
const SECONDS = 12;

function synth(fill: (t: number, i: number) => number, seconds = SECONDS): Float32Array {
  const out = new Float32Array(Math.floor(SR * seconds));
  for (let i = 0; i < out.length; i++) out[i] = fill(i / SR, i);
  return out;
}

/** A dull sustained tone: low centroid, tonal, no transients. */
function darkPad(): Float32Array {
  return synth((t) => 0.4 * (Math.sin(2 * Math.PI * 110 * t) + 0.5 * Math.sin(2 * Math.PI * 220 * t)));
}

/** Same energy, an octave-plus higher: the centroid must move. */
function brightPad(): Float32Array {
  return synth((t) => 0.4 * (Math.sin(2 * Math.PI * 1760 * t) + 0.5 * Math.sin(2 * Math.PI * 3520 * t)));
}

/** Broadband noise bursts: high flatness, high onset rate. */
function percussive(): Float32Array {
  const rand = mulberry32(7);
  const out = new Float32Array(SR * SECONDS);
  const interval = SR / 4; // 4 hits a second
  for (let hit = 0; hit * interval < out.length; hit++) {
    const start = Math.floor(hit * interval);
    for (let i = 0; i < 2000 && start + i < out.length; i++) {
      out[start + i] = (rand() * 2 - 1) * Math.exp(-i / 300);
    }
  }
  return out;
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] ** 2;
    nb += b[i] ** 2;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

const feat = (v: Float32Array, name: string) => v[TIMBRE_FEATURES.indexOf(name)];

describe("extractTimbre", () => {
  it("returns a finite vector of the declared shape", () => {
    const v = extractTimbre(darkPad(), SR)!;
    expect(v).not.toBeNull();
    expect(v.length).toBe(TIMBRE_DIMS);
    expect(TIMBRE_FEATURES.length).toBe(TIMBRE_DIMS);
    for (const x of v) expect(Number.isFinite(x)).toBe(true);
  });

  it("is deterministic", () => {
    const a = extractTimbre(percussive(), SR)!;
    const b = extractTimbre(percussive(), SR)!;
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it("hears brightness", () => {
    const dark = extractTimbre(darkPad(), SR)!;
    const bright = extractTimbre(brightPad(), SR)!;
    expect(feat(bright, "centroid_mean")).toBeGreaterThan(feat(dark, "centroid_mean") * 3);
    expect(feat(bright, "rolloff_mean")).toBeGreaterThan(feat(dark, "rolloff_mean"));
  });

  it("separates noisy percussion from sustained tones", () => {
    const tone = extractTimbre(darkPad(), SR)!;
    const drums = extractTimbre(percussive(), SR)!;
    expect(feat(drums, "flatness_mean")).toBeGreaterThan(feat(tone, "flatness_mean"));
    expect(feat(drums, "onset_rate")).toBeGreaterThan(feat(tone, "onset_rate"));
    // Sustained tone barely fluctuates in level; hits do.
    expect(feat(drums, "rms_std")).toBeGreaterThan(feat(tone, "rms_std"));
  });

  it("places two sounds of the same character closer than two different ones", () => {
    // The property the whole embedding rests on: similar audio → nearby vector.
    const padA = extractTimbre(darkPad(), SR)!;
    // Same character, different notes — a fifth up, same waveform and envelope.
    const padB = extractTimbre(
      synth((t) => 0.4 * (Math.sin(2 * Math.PI * 165 * t) + 0.5 * Math.sin(2 * Math.PI * 330 * t))),
      SR
    )!;
    const drums = extractTimbre(percussive(), SR)!;
    expect(cosine(padA, padB)).toBeGreaterThan(cosine(padA, drums));
  });

  it("ignores the silence in an intro rather than averaging it in", () => {
    const loud = darkPad();
    const withIntro = new Float32Array(loud.length + SR * 4);
    withIntro.set(loud, SR * 4); // 4s of digital silence up front
    const a = extractTimbre(loud, SR)!;
    const b = extractTimbre(withIntro, SR)!;
    expect(cosine(a, b)).toBeGreaterThan(0.99);
  });

  it("declines to guess when there is nothing to hear", () => {
    expect(extractTimbre(new Float32Array(SR * 5), SR)).toBeNull(); // silence
    expect(extractTimbre(new Float32Array(100), SR)).toBeNull(); // too short
    expect(extractTimbre(darkPad(), 0)).toBeNull();
  });
});
