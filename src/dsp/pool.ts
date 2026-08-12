import type { Track } from "../types";
import type { DspResult } from "./dsp.worker";
import { suggestBpmCorrection } from "./tempo";

/**
 * DSP worker pool (§4): 2–4 workers, strictly lazy. The main thread fetches
 * and decodes the audio (decodeAudioData can't run in a worker), then hands
 * mono PCM to a free worker via transfer.
 */

const POOL_SIZE = Math.max(2, Math.min(4, (navigator.hardwareConcurrency ?? 4) - 1));

/**
 * Where the audio came from. A `file` is the whole track off disk; a `preview`
 * is the 30s clip an online source returned.
 */
export type AudioSource = { url: string; kind: "preview" | "file" };

/**
 * A local file is a whole master where a preview is 30 seconds, and both end up
 * standardized against each other in one feature matrix
 * (src/features/matrix.ts). Measuring a full track would put it on a different
 * scale for every duration-sensitive feature — onset rate, RMS deviation and
 * spectral spread all read differently once an intro, a breakdown and an outro
 * are included — and the embedding would then separate tracks by where their
 * audio came from rather than by how they sound. So a file is cut to a
 * preview-sized excerpt from a third of the way in, which is roughly where a
 * catalogue preview is taken, and the analysis sees comparable input either way.
 */
export const EXCERPT_SECONDS = 30;
export const EXCERPT_START_FRACTION = 1 / 3;

/** The excerpt window, clamped to what the audio actually contains. */
export function excerptRange(
  totalSamples: number,
  sampleRate: number
): { start: number; length: number } {
  const whole = { start: 0, length: Math.max(0, totalSamples) };
  if (!(sampleRate > 0)) return whole;
  const want = Math.round(EXCERPT_SECONDS * sampleRate);
  if (whole.length <= want) return whole;
  const start = Math.min(
    Math.floor(totalSamples * EXCERPT_START_FRACTION),
    totalSamples - want
  );
  return { start, length: want };
}

type Job = {
  track: Track;
  source: AudioSource;
  signal?: AbortSignal;
  resolve: (r: DspResult | null) => void;
};

function createWorker(): Worker {
  return new Worker(new URL("./dsp.worker.ts", import.meta.url), { type: "module" });
}

export class DspPool {
  private workers: { w: Worker; busy: boolean }[] = [];
  private queue: Job[] = [];
  private audioCtx: AudioContext | null = null;

  constructor() {
    for (let i = 0; i < POOL_SIZE; i++) {
      this.workers.push({ w: createWorker(), busy: false });
    }
  }

  /**
   * Analyze a track from `source`, or from its preview when none is given.
   * Resolves null when there is nothing to listen to.
   */
  analyze(
    track: Track,
    source?: AudioSource,
    signal?: AbortSignal
  ): Promise<DspResult | null> {
    const from: AudioSource | null =
      source ?? (track.previewUrl ? { url: track.previewUrl, kind: "preview" } : null);
    if (!from || signal?.aborted) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.queue.push({ track, source: from, signal, resolve });
      this.pump();
    });
  }

  private async pump(): Promise<void> {
    const slot = this.workers.find((s) => !s.busy);
    if (!slot || this.queue.length === 0) return;
    const job = this.queue.shift()!;
    slot.busy = true;
    try {
      const decoded = await this.decode(job.source, job.signal);
      if (!decoded || job.signal?.aborted) {
        job.resolve(null);
        return;
      }
      const result = await new Promise<DspResult | null>((res) => {
        if (job.signal?.aborted) {
          res(null);
          return;
        }
        const onAbort = () => {
          slot.w.terminate();
          slot.w = createWorker();
          res(null);
        };
        job.signal?.addEventListener("abort", onAbort, { once: true });
        slot.w.onmessage = (e: MessageEvent<DspResult>) => {
          job.signal?.removeEventListener("abort", onAbort);
          res(e.data);
        };
        slot.w.postMessage(
          { pid: job.track.pid, samples: decoded.samples, sampleRate: decoded.sampleRate },
          [decoded.samples.buffer]
        );
      });
      job.resolve(result && !result.error ? result : null);
    } catch {
      job.resolve(null);
    } finally {
      slot.busy = false;
      this.pump();
    }
  }

  private async decode(
    source: AudioSource,
    signal?: AbortSignal
  ): Promise<{ samples: Float32Array; sampleRate: number } | null> {
    const res = await fetch(source.url, { signal });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    this.audioCtx ??= new AudioContext();
    const audio = await this.audioCtx.decodeAudioData(buf);
    const { start, length } =
      source.kind === "file"
        ? excerptRange(audio.length, audio.sampleRate)
        : { start: 0, length: audio.length };
    // Mixdown to mono, over the excerpt only: a six-minute master is ~100MB of
    // float samples per channel, and the copy is the part worth not making.
    const mono = new Float32Array(length);
    for (let c = 0; c < audio.numberOfChannels; c++) {
      const ch = audio.getChannelData(c);
      for (let i = 0; i < length; i++) mono[i] += ch[start + i] / audio.numberOfChannels;
    }
    return { samples: mono, sampleRate: audio.sampleRate };
  }

  /** Merge a DSP result into a track, honoring manual overrides. */
  static apply(track: Track, r: DspResult): boolean {
    let changed = false;
    if (r.bpm && !track.bpm && track.source?.bpm !== "manual") {
      track.bpm = r.bpm;
      track.confidence = { ...track.confidence, bpm: r.bpmConfidence };
      track.source = { ...track.source, bpm: "dsp" };
      if (r.bpmAmbiguous || suggestBpmCorrection(r.bpm, track.genre)) {
        track.bpmSuspect = true;
      }
      changed = true;
    }
    if (r.key && !track.key && track.source?.key !== "manual") {
      track.key = r.key;
      track.confidence = { ...track.confidence, key: r.keyConfidence };
      track.source = { ...track.source, key: "dsp" };
      changed = true;
    }
    // Timbre isn't competing with a better source the way BPM and key are —
    // nothing else in the pipeline can produce it, so it always lands.
    if (r.timbre && r.timbre.length > 0) {
      track.timbre = r.timbre;
      changed = true;
    }
    return changed;
  }

  destroy(): void {
    for (const s of this.workers) s.w.terminate();
  }
}
