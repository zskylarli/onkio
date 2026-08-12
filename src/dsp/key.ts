import { hannWindow, magnitudeSpectrum } from "./fft";
import { camelotFromPitchClass } from "../music/camelot";

/**
 * Key estimation (§4 stage 2.3): average chroma over the clip, correlate
 * against Krumhansl-Schmuckler major/minor profiles at all 12 rotations.
 * ~70–80% exact is the realistic ceiling; errors cluster at relative
 * major/minor and the fifth, which downstream scoring treats as near-misses.
 */

export type KeyResult = {
  camelot: string;
  confidence: number; // 0..1, from the margin between best and runner-up
};

// Krumhansl-Schmuckler key profiles
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

const FRAME = 4096;
const HOP = 2048;

export function chromaVector(
  samples: Float32Array,
  sampleRate: number
): Float32Array {
  const win = hannWindow(FRAME);
  const chroma = new Float32Array(12);
  const nFrames = Math.max(0, Math.floor((samples.length - FRAME) / HOP));
  const frame = new Float32Array(FRAME);
  const binHz = sampleRate / FRAME;

  for (let f = 0; f < nFrames; f++) {
    const off = f * HOP;
    for (let i = 0; i < FRAME; i++) frame[i] = samples[off + i] * win[i];
    const mag = magnitudeSpectrum(frame);
    // 60 Hz – 5 kHz: below is rumble, above is mostly noise/harmonics
    const lo = Math.ceil(60 / binHz);
    const hi = Math.min(mag.length - 1, Math.floor(5000 / binHz));
    for (let b = lo; b <= hi; b++) {
      const freq = b * binHz;
      const midi = 69 + 12 * Math.log2(freq / 440);
      const pc = ((Math.round(midi) % 12) + 12) % 12;
      chroma[pc] += mag[b] * mag[b];
    }
  }
  // normalize
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += chroma[i];
  if (sum > 0) for (let i = 0; i < 12; i++) chroma[i] /= sum;
  return chroma;
}

function pearson(a: number[] | Float32Array, b: number[] | Float32Array): number {
  const n = a.length;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const xa = a[i] - ma;
    const xb = b[i] - mb;
    num += xa * xb;
    da += xa * xa;
    db += xb * xb;
  }
  const denom = Math.sqrt(da * db);
  return denom === 0 ? 0 : num / denom;
}

export function estimateKey(
  samples: Float32Array,
  sampleRate: number
): KeyResult | null {
  const chroma = chromaVector(samples, sampleRate);
  let total = 0;
  for (let i = 0; i < 12; i++) total += chroma[i];
  if (total === 0) return null;

  const scores: { pc: number; minor: boolean; r: number }[] = [];
  for (let tonic = 0; tonic < 12; tonic++) {
    const rotated = new Float32Array(12);
    for (let i = 0; i < 12; i++) rotated[i] = chroma[(i + tonic) % 12];
    scores.push({ pc: tonic, minor: false, r: pearson(rotated, MAJOR_PROFILE) });
    scores.push({ pc: tonic, minor: true, r: pearson(rotated, MINOR_PROFILE) });
  }
  scores.sort((a, b) => b.r - a.r);
  const best = scores[0];
  const second = scores[1];
  if (best.r <= 0) return null;

  // Margin-based confidence: identical best/runner-up → 0; wide gap → →1.
  const margin = Math.max(0, best.r - second.r);
  const confidence = Math.max(0, Math.min(1, best.r * 0.5 + margin * 5));
  return {
    camelot: camelotFromPitchClass(best.pc, best.minor),
    confidence: Math.round(confidence * 100) / 100,
  };
}
