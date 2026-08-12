import { hannWindow, magnitudeSpectrum } from "./fft";

/**
 * Timbral fingerprint of a preview — what a track *sounds* like, as opposed to
 * what it is filed under.
 *
 * This exists because catalogue metadata can't describe a DJ crate. Measured
 * on the reference collection, an online genre lookup hits 58% of tracks and
 * returns nine coarse labels ("Dance", "Electronic") where the user's own
 * rekordbox tags already give 68 specific ones — so metadata enrichment is a
 * downgrade, and the only genuinely new signal reachable without the original
 * files is the audio of the 30s preview itself.
 *
 * The vector is deliberately small and hand-chosen rather than learned: MFCCs
 * for spectral envelope (the classic "instrumentation and production" proxy),
 * a few interpretable spectral-shape statistics, and dynamics. Each is
 * summarized over the whole preview by mean and standard deviation, because a
 * track that is consistently bright differs from one that lurches between
 * bright and dark, and only the deviation captures that.
 */

export const MFCC_COUNT = 13;
export const MEL_BANDS = 26;
const FRAME = 2048;
const HOP = 1024;
/** Above this, previews carry mostly codec artifacts. */
const MAX_HZ = 11_025;

/** Feature names, in vector order — used by tests and the UI. */
export const TIMBRE_FEATURES: string[] = [
  ...Array.from({ length: MFCC_COUNT - 1 }, (_, i) => `mfcc${i + 1}_mean`),
  ...Array.from({ length: MFCC_COUNT - 1 }, (_, i) => `mfcc${i + 1}_std`),
  "centroid_mean",
  "centroid_std",
  "rolloff_mean",
  "rolloff_std",
  "flatness_mean",
  "flatness_std",
  "bandwidth_mean",
  "zcr_mean",
  "rms_mean",
  "rms_std",
  "onset_rate",
  "percussivity",
];

export const TIMBRE_DIMS = TIMBRE_FEATURES.length;

const hzToMel = (hz: number) => 2595 * Math.log10(1 + hz / 700);
const melToHz = (mel: number) => 700 * (10 ** (mel / 2595) - 1);

/**
 * Triangular mel filterbank as [startBin, weights] pairs — storing only the
 * non-zero span keeps this ~20x cheaper than a dense bands × bins matrix.
 */
function melFilterbank(
  nBins: number,
  sampleRate: number
): { start: number; weights: Float32Array }[] {
  const nyquist = sampleRate / 2;
  const top = Math.min(MAX_HZ, nyquist);
  const lowMel = hzToMel(20);
  const highMel = hzToMel(top);
  const points: number[] = [];
  for (let i = 0; i < MEL_BANDS + 2; i++) {
    const mel = lowMel + ((highMel - lowMel) * i) / (MEL_BANDS + 1);
    points.push((melToHz(mel) / nyquist) * (nBins - 1));
  }

  const bank: { start: number; weights: Float32Array }[] = [];
  for (let b = 0; b < MEL_BANDS; b++) {
    const [lo, mid, hi] = [points[b], points[b + 1], points[b + 2]];
    const start = Math.max(0, Math.floor(lo));
    const end = Math.min(nBins - 1, Math.ceil(hi));
    const weights = new Float32Array(Math.max(0, end - start + 1));
    for (let bin = start; bin <= end; bin++) {
      const w =
        bin <= mid
          ? mid === lo ? 1 : (bin - lo) / (mid - lo)
          : hi === mid ? 1 : (hi - bin) / (hi - mid);
      weights[bin - start] = Math.max(0, w);
    }
    bank.push({ start, weights });
  }
  return bank;
}

/** DCT-II of the log-mel energies, keeping coefficients 1..MFCC_COUNT-1.
 * c0 is dropped: it is overall loudness, which is a mastering choice rather
 * than a timbre, and previews are loudness-normalized anyway. */
function dct(input: Float32Array, count: number): Float32Array {
  const out = new Float32Array(count);
  const n = input.length;
  for (let k = 0; k < count; k++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += input[i] * Math.cos((Math.PI * k * (i + 0.5)) / n);
    out[k] = sum / Math.sqrt(n);
  }
  return out;
}

function meanOf(a: number[]): number {
  return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
}
function stdOf(a: number[], m: number): number {
  if (a.length < 2) return 0;
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length);
}

/**
 * Extract the timbre vector. Returns null when there isn't enough audio to be
 * meaningful — a silent or near-empty preview would otherwise contribute a
 * confident-looking vector of noise.
 */
export function extractTimbre(
  samples: Float32Array,
  sampleRate: number
): Float32Array | null {
  if (sampleRate <= 0 || samples.length < FRAME * 4) return null;

  const window = hannWindow(FRAME);
  const nBins = FRAME / 2 + 1;
  const bank = melFilterbank(nBins, sampleRate);
  const binHz = sampleRate / FRAME;

  const mfccFrames: Float32Array[] = [];
  const centroids: number[] = [];
  const rolloffs: number[] = [];
  const flatnesses: number[] = [];
  const bandwidths: number[] = [];
  const zcrs: number[] = [];
  const rmss: number[] = [];
  const flux: number[] = [];

  const frame = new Float32Array(FRAME);
  const melEnergies = new Float32Array(MEL_BANDS);
  let prevSpectrum: Float32Array | null = null;

  for (let off = 0; off + FRAME <= samples.length; off += HOP) {
    let energy = 0;
    let crossings = 0;
    for (let i = 0; i < FRAME; i++) {
      const s = samples[off + i];
      energy += s * s;
      if (i > 0 && (s >= 0) !== (samples[off + i - 1] >= 0)) crossings++;
      frame[i] = s * window[i];
    }
    const rms = Math.sqrt(energy / FRAME);
    // Skip near-silence: intros and fades would drag every average toward zero.
    if (rms < 1e-4) {
      prevSpectrum = null;
      continue;
    }
    rmss.push(rms);
    zcrs.push(crossings / FRAME);

    const spec = magnitudeSpectrum(frame);

    let total = 0;
    let weighted = 0;
    let logSum = 0;
    for (let i = 1; i < nBins; i++) {
      const m = spec[i];
      total += m;
      weighted += m * i * binHz;
      logSum += Math.log(m + 1e-10);
    }
    if (total <= 0) {
      prevSpectrum = null;
      continue;
    }
    const centroid = weighted / total;
    centroids.push(centroid);
    // Spectral flatness: noisy/percussive → 1, tonal → 0.
    flatnesses.push(Math.exp(logSum / (nBins - 1)) / (total / (nBins - 1)));

    let cum = 0;
    let rolloff = 0;
    for (let i = 1; i < nBins; i++) {
      cum += spec[i];
      if (cum >= 0.85 * total) {
        rolloff = i * binHz;
        break;
      }
    }
    rolloffs.push(rolloff);

    let spread = 0;
    for (let i = 1; i < nBins; i++) spread += spec[i] * (i * binHz - centroid) ** 2;
    bandwidths.push(Math.sqrt(spread / total));

    if (prevSpectrum) {
      let f = 0;
      for (let i = 1; i < nBins; i++) {
        const d = spec[i] - prevSpectrum[i];
        if (d > 0) f += d; // half-wave rectified: onsets, not offsets
      }
      flux.push(f / total);
    }
    prevSpectrum = spec;

    melEnergies.fill(0);
    for (let b = 0; b < MEL_BANDS; b++) {
      const { start, weights } = bank[b];
      let sum = 0;
      for (let i = 0; i < weights.length; i++) sum += spec[start + i] * weights[i];
      melEnergies[b] = Math.log(sum + 1e-10);
    }
    mfccFrames.push(dct(melEnergies, MFCC_COUNT));
  }

  if (mfccFrames.length < 8) return null;

  const out = new Float32Array(TIMBRE_DIMS);
  let w = 0;
  for (let c = 1; c < MFCC_COUNT; c++) {
    const series = mfccFrames.map((f) => f[c]);
    const m = meanOf(series);
    out[w] = m;
    out[w + MFCC_COUNT - 1] = stdOf(series, m);
    w++;
  }
  w += MFCC_COUNT - 1;

  const push = (v: number) => {
    out[w++] = v;
  };
  const cM = meanOf(centroids);
  push(cM);
  push(stdOf(centroids, cM));
  const rM = meanOf(rolloffs);
  push(rM);
  push(stdOf(rolloffs, rM));
  const fM = meanOf(flatnesses);
  push(fM);
  push(stdOf(flatnesses, fM));
  push(meanOf(bandwidths));
  push(meanOf(zcrs));
  const eM = meanOf(rmss);
  push(eM);
  // Relative, so it survives the loudness normalization previews already have.
  push(eM > 0 ? stdOf(rmss, eM) / eM : 0);

  // Onset rate: how often the spectrum lurches, in events per second.
  const fluxMean = meanOf(flux);
  const fluxStd = stdOf(flux, fluxMean);
  const threshold = fluxMean + fluxStd;
  let onsets = 0;
  for (let i = 1; i < flux.length - 1; i++) {
    if (flux[i] > threshold && flux[i] >= flux[i - 1] && flux[i] > flux[i + 1]) onsets++;
  }
  const seconds = (mfccFrames.length * HOP) / sampleRate;
  push(seconds > 0 ? onsets / seconds : 0);
  // Percussivity: how spiky the flux is overall — a proxy for how much of the
  // energy is transient rather than sustained.
  push(fluxMean > 0 ? fluxStd / fluxMean : 0);

  for (let i = 0; i < out.length; i++) {
    if (!Number.isFinite(out[i])) out[i] = 0;
  }
  return out;
}
