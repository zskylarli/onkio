/// <reference lib="webworker" />
import { estimateTempo } from "./tempo";
import { estimateKey } from "./key";
import { extractTimbre } from "./timbre";

/**
 * DSP worker (§4 stage 2). Audio decoding happens on the main thread
 * (AudioContext.decodeAudioData is unavailable in workers); the decoded mono
 * PCM is transferred here and the expensive analysis runs off-thread.
 */

export type DspJob = {
  pid: string;
  samples: Float32Array;
  sampleRate: number;
};

export type DspResult = {
  pid: string;
  bpm?: number;
  bpmConfidence?: number;
  bpmAmbiguous?: boolean;
  key?: string;
  keyConfidence?: number;
  /** timbral fingerprint of the analyzed audio, for the sound-based layout */
  timbre?: Float32Array;
  error?: string;
};

self.onmessage = (e: MessageEvent<DspJob>) => {
  const { pid, samples, sampleRate } = e.data;
  const out: DspResult = { pid };
  try {
    const tempo = estimateTempo(samples, sampleRate);
    if (tempo) {
      out.bpm = tempo.bpm;
      out.bpmConfidence = Math.round(tempo.confidence * 100) / 100;
      out.bpmAmbiguous = tempo.ambiguous;
    }
    const key = estimateKey(samples, sampleRate);
    if (key) {
      out.key = key.camelot;
      out.keyConfidence = key.confidence;
    }
    const timbre = extractTimbre(samples, sampleRate);
    if (timbre) out.timbre = timbre;
  } catch (err) {
    out.error = err instanceof Error ? err.message : String(err);
  }
  (self as unknown as Worker).postMessage(out, out.timbre ? [out.timbre.buffer] : []);
};
