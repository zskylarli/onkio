import { describe, expect, it } from "vitest";
import {
  bpmOutOfRange,
  estimateTempo,
  PLAUSIBLE_BPM,
  suggestBpmCorrection,
} from "../src/dsp/tempo";
import { estimateKey } from "../src/dsp/key";
import { fft } from "../src/dsp/fft";
import { EXCERPT_SECONDS, excerptRange } from "../src/dsp/pool";

const SR = 22050;

describe("fft", () => {
  it("finds a pure tone in the right bin", () => {
    const n = 1024;
    const re = new Float32Array(n);
    const im = new Float32Array(n);
    const bin = 40;
    for (let i = 0; i < n; i++) re[i] = Math.cos((2 * Math.PI * bin * i) / n);
    fft(re, im);
    let maxBin = 0;
    let maxMag = 0;
    for (let i = 0; i < n / 2; i++) {
      const m = Math.hypot(re[i], im[i]);
      if (m > maxMag) {
        maxMag = m;
        maxBin = i;
      }
    }
    expect(maxBin).toBe(bin);
  });
});

/** Synthesize a click track: short noise bursts at the given BPM. */
function clickTrack(bpm: number, seconds: number): Float32Array {
  const out = new Float32Array(Math.floor(SR * seconds));
  const interval = (60 / bpm) * SR;
  for (let beat = 0; beat * interval < out.length; beat++) {
    const start = Math.floor(beat * interval);
    for (let i = 0; i < 400 && start + i < out.length; i++) {
      // decaying filtered burst — enough spectral change for onset detection
      out[start + i] += Math.sin(i * 0.9) * Math.exp(-i / 60);
    }
  }
  return out;
}

describe("estimateTempo", () => {
  it("recovers 120 BPM from a click track", () => {
    const r = estimateTempo(clickTrack(120, 20), SR);
    expect(r).not.toBeNull();
    // accept the half/double octave family; UI resolves with priors (§4)
    const family = [r!.bpm, r!.bpm * 2, r!.bpm / 2];
    expect(family.some((b) => Math.abs(b - 120) < 3)).toBe(true);
  });

  it("recovers 174 BPM (drum & bass territory)", () => {
    const r = estimateTempo(clickTrack(174, 20), SR);
    expect(r).not.toBeNull();
    const family = [r!.bpm, r!.bpm * 2, r!.bpm / 2];
    expect(family.some((b) => Math.abs(b - 174) < 5)).toBe(true);
  });

  it("returns null on silence", () => {
    expect(estimateTempo(new Float32Array(SR * 10), SR)).toBeNull();
  });
});

describe("suggestBpmCorrection", () => {
  it("suggests doubling a 63 BPM 'House' track (§4)", () => {
    expect(suggestBpmCorrection(63, "House")).toBe(126);
  });
  it("leaves non-dance genres alone", () => {
    expect(suggestBpmCorrection(63, "Folk")).toBeNull();
  });
  it("leaves plausible dance tempos alone", () => {
    expect(suggestBpmCorrection(126, "House")).toBeNull();
  });
});

describe("bpmOutOfRange", () => {
  it("catches a double-time reading of a pop record whatever its genre", () => {
    // GetSongBPM reports 224 for a ~112 BPM record, and "Pop" is not a genre
    // suggestBpmCorrection halves for.
    expect(bpmOutOfRange(224)).toBe(true);
    expect(suggestBpmCorrection(224, "Pop")).toBeNull();
  });
  it("accepts tempos records are actually made at", () => {
    expect(bpmOutOfRange(112)).toBe(false);
    expect(bpmOutOfRange(PLAUSIBLE_BPM.min)).toBe(false);
    expect(bpmOutOfRange(PLAUSIBLE_BPM.max)).toBe(false);
  });
});

/** Synthesize a chord progression in A minor: Am, Dm, Em, Am. */
function aMinorProgression(seconds: number): Float32Array {
  const out = new Float32Array(Math.floor(SR * seconds));
  const chords = [
    [220.0, 261.63, 329.63], // Am: A3 C4 E4
    [293.66, 349.23, 440.0], // Dm: D4 F4 A4
    [329.63, 392.0, 493.88], // Em: E4 G4 B4
    [220.0, 261.63, 329.63], // Am
  ];
  const chordLen = out.length / chords.length;
  for (let i = 0; i < out.length; i++) {
    const chord = chords[Math.min(chords.length - 1, Math.floor(i / chordLen))];
    for (const f of chord) {
      out[i] += 0.3 * Math.sin((2 * Math.PI * f * i) / SR);
      out[i] += 0.1 * Math.sin((2 * Math.PI * 2 * f * i) / SR); // 2nd harmonic
    }
  }
  return out;
}

describe("estimateKey", () => {
  it("identifies A minor (8A) or its relative from an Am progression", () => {
    const r = estimateKey(aMinorProgression(8), SR);
    expect(r).not.toBeNull();
    // relative-key misses are near-misses, not failures (§4)
    expect(["8A", "8B"]).toContain(r!.camelot);
    expect(r!.confidence).toBeGreaterThan(0);
  });

  it("returns null on silence", () => {
    expect(estimateKey(new Float32Array(SR * 5), SR)).toBeNull();
  });
});

describe("excerptRange", () => {
  const RATE = 44_100;
  const want = EXCERPT_SECONDS * RATE;

  it("takes a preview-sized window from a third of the way into a full track", () => {
    // Timbre vectors from files and from previews are standardized against each
    // other, so a whole master must not be measured where a 30s clip would be.
    const total = 6 * 60 * RATE;
    const { start, length } = excerptRange(total, RATE);
    expect(length).toBe(want);
    expect(start).toBe(Math.floor(total / 3));
  });

  it("keeps the window inside the audio when the track is barely longer", () => {
    const total = want + 100;
    const { start, length } = excerptRange(total, RATE);
    expect(length).toBe(want);
    expect(start + length).toBeLessThanOrEqual(total);
  });

  it("uses everything there is when the audio is shorter than the window", () => {
    const total = 12 * RATE;
    expect(excerptRange(total, RATE)).toEqual({ start: 0, length: total });
  });

  it("survives a sample rate or a length it cannot use", () => {
    expect(excerptRange(0, RATE)).toEqual({ start: 0, length: 0 });
    expect(excerptRange(1000, 0)).toEqual({ start: 0, length: 1000 });
    expect(excerptRange(-5, RATE)).toEqual({ start: 0, length: 0 });
  });
});
