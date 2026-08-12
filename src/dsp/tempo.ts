import { hannWindow, magnitudeSpectrum } from "./fft";

/**
 * Tempo estimation (§4 stage 2.3, hand-rolled alternative to essentia.js):
 * spectral-flux onset envelope → autocorrelation over the 60–200 BPM lag
 * range → parabolic peak interpolation.
 *
 * Half/double-time ambiguity is inherent (§4). We return the raw estimate
 * plus the score of its half/double competitor so the caller can apply a
 * genre prior and FLAG rather than silently correct.
 */

export type TempoResult = {
  bpm: number;
  confidence: number; // 0..1
  /** competing interpretation (bpm*2 or bpm/2) scored within 90% of the peak */
  ambiguous: boolean;
};

const FRAME = 1024;
const HOP = 512;

/**
 * The band a recorded tempo realistically sits in, and the only band the
 * estimator below searches.
 */
export const PLAUSIBLE_BPM = { min: 60, max: 200 };

/**
 * A tempo no beat grid would produce, which for an external lookup means the
 * catalogue recorded a double-time (or half-time) reading: 224 for a record
 * that runs at 112. Out of range is evidence of a doubling rather than proof
 * of one, so callers flag it like any other half/double suspicion instead of
 * rewriting the number.
 */
export function bpmOutOfRange(bpm: number): boolean {
  return bpm < PLAUSIBLE_BPM.min || bpm > PLAUSIBLE_BPM.max;
}

export function onsetEnvelope(
  samples: Float32Array,
  _sampleRate: number
): Float32Array {
  const win = hannWindow(FRAME);
  const nFrames = Math.max(0, Math.floor((samples.length - FRAME) / HOP));
  const env = new Float32Array(nFrames);
  let prev: Float32Array | null = null;
  const frame = new Float32Array(FRAME);
  for (let f = 0; f < nFrames; f++) {
    const off = f * HOP;
    for (let i = 0; i < FRAME; i++) frame[i] = samples[off + i] * win[i];
    const mag = magnitudeSpectrum(frame);
    if (prev) {
      let flux = 0;
      for (let i = 0; i < mag.length; i++) {
        const d = mag[i] - prev[i];
        if (d > 0) flux += d; // half-wave rectified
      }
      env[f] = flux;
    }
    prev = mag;
  }
  // remove local mean to suppress slow dynamics
  const meanWin = 16;
  const out = new Float32Array(nFrames);
  for (let i = 0; i < nFrames; i++) {
    let s = 0;
    let c = 0;
    for (let j = Math.max(0, i - meanWin); j < Math.min(nFrames, i + meanWin); j++) {
      s += env[j];
      c++;
    }
    out[i] = Math.max(0, env[i] - s / c);
  }
  return out;
}

export function estimateTempo(
  samples: Float32Array,
  sampleRate: number
): TempoResult | null {
  const env = onsetEnvelope(samples, sampleRate);
  if (env.length < 64) return null;
  const fps = sampleRate / HOP; // envelope frames per second

  const { min: minBpm, max: maxBpm } = PLAUSIBLE_BPM;
  const minLag = Math.floor((60 / maxBpm) * fps);
  const maxLag = Math.min(env.length - 1, Math.ceil((60 / minBpm) * fps));
  if (maxLag <= minLag) return null;

  // autocorrelation over candidate lags
  const ac = new Float32Array(maxLag + 1);
  let energy = 0;
  for (let i = 0; i < env.length; i++) energy += env[i] * env[i];
  if (energy === 0) return null;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = 0; i + lag < env.length; i++) s += env[i] * env[i + lag];
    ac[lag] = s / energy;
  }

  // peak pick with a mild preference for the 90–180 BPM octave
  let bestLag = -1;
  let bestScore = -Infinity;
  for (let lag = minLag + 1; lag < maxLag; lag++) {
    if (ac[lag] < ac[lag - 1] || ac[lag] < ac[lag + 1]) continue;
    const bpm = (60 * fps) / lag;
    const octavePref = bpm >= 90 && bpm <= 180 ? 1.05 : 1.0;
    const score = ac[lag] * octavePref;
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }
  if (bestLag < 0) return null;

  // parabolic interpolation around the peak
  const y0 = ac[bestLag - 1];
  const y1 = ac[bestLag];
  const y2 = ac[bestLag + 1];
  const denom = y0 - 2 * y1 + y2;
  const delta = denom !== 0 ? (0.5 * (y0 - y2)) / denom : 0;
  const lag = bestLag + Math.max(-0.5, Math.min(0.5, delta));
  const bpm = (60 * fps) / lag;

  // Check the half/double competitor.
  const compLags = [Math.round(lag * 2), Math.round(lag / 2)].filter(
    (l) => l >= minLag && l <= maxLag
  );
  let ambiguous = false;
  for (const l of compLags) {
    if (ac[l] > 0.9 * ac[bestLag]) ambiguous = true;
  }

  const confidence = Math.max(0, Math.min(1, ac[bestLag]));
  return { bpm: Math.round(bpm * 10) / 10, confidence, ambiguous };
}

/**
 * Genre prior for half/double-time (§4): dance genres essentially never sit
 * below 100 BPM. Returns a suggested correction; the caller flags it in the
 * UI instead of silently rewriting.
 */
const DANCE_GENRES =
  /house|techno|trance|electro|dance|edm|drum\s*&?\s*bass|dnb|garage|hardstyle|disco/i;

export function suggestBpmCorrection(
  bpm: number,
  genre: string | undefined
): number | null {
  if (!genre || !DANCE_GENRES.test(genre)) return null;
  if (bpm < 95 && bpm * 2 <= 200) return bpm * 2;
  return null;
}
