import type { Track } from "../types";
import { lookupFeatures } from "./adapter";
import { bpmOutOfRange, suggestBpmCorrection } from "../dsp/tempo";
import { needsLookup } from "../collections/coverage";
import { saveQueueState, loadQueueState } from "../store/db";

/**
 * Enrichment queue (§3.3): lazy, incremental, interruptible. Priority is
 * viewport > open playlist > rest, re-sorted whenever the caller updates
 * priority hints. Remaining work is persisted so a closed tab resumes.
 *
 * Membership is decided by `needsLookup`, so a collection that already carries
 * BPM and key contributes nothing to the queue. With a rekordbox export and an
 * Apple Music export loaded together this is the difference between looking up
 * 5,300 tracks and looking up the 4,400 that stand to gain.
 */

export type EnrichmentUpdate = { pid: string; changed: boolean };

export class EnrichmentQueue {
  private pending: string[] = [];
  private inQueue = new Set<string>();
  private tracks = new Map<string, Track>();
  private running = false;
  private stopped = false;
  private visible = new Set<string>();
  private focused = new Set<string>();
  private persistCounter = 0;

  constructor(
    private onUpdate: (track: Track) => void,
    private onProgress?: (remaining: number) => void
  ) {}

  async init(tracks: Track[]): Promise<void> {
    for (const t of tracks) this.tracks.set(t.pid, t);
    const saved = await loadQueueState();
    // Persisted work is still re-filtered: a track can have gained BPM and key
    // from a later rekordbox import since it was queued, and looking it up
    // again would spend ~2.5s to learn nothing.
    const pids = (saved ?? []).filter((p) => {
      const t = this.tracks.get(p);
      return t !== undefined && needsLookup(t);
    });
    this.pending =
      pids.length > 0 ? pids : tracks.filter(needsLookup).map((t) => t.pid);
    this.inQueue = new Set(this.pending);
  }

  /** Requeue an explicit set of tracks, discarding persisted progress. */
  refill(tracks: Track[]): void {
    for (const t of tracks) this.tracks.set(t.pid, t);
    this.pending = tracks.map((t) => t.pid);
    this.inQueue = new Set(this.pending);
    this.resort();
  }

  /** Update priority hints; cheap, called on viewport/playlist changes. */
  setPriority(visiblePids: Iterable<string>, focusedPids: Iterable<string>): void {
    this.visible = new Set(visiblePids);
    this.focused = new Set(focusedPids);
    this.resort();
  }

  private rank(pid: string): number {
    if (this.visible.has(pid)) return 0;
    if (this.focused.has(pid)) return 1;
    return 2;
  }

  private resort(): void {
    this.pending.sort((a, b) => this.rank(a) - this.rank(b));
  }

  get remaining(): number {
    return this.pending.length;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.stopped = false;
    while (!this.stopped && this.pending.length > 0) {
      const pid = this.pending.shift()!;
      this.inQueue.delete(pid);
      const track = this.tracks.get(pid);
      if (!track) continue;
      try {
        const res = await lookupFeatures(track.artist, track.name);
        if (res) {
          let changed = false;
          // Manual overrides always win (§4 stage 3) — enrichment never
          // touches fields whose source is 'manual'.
          if (res.bpm && !track.bpm && track.source?.bpm !== "manual") {
            track.bpm = res.bpm;
            track.confidence = { ...track.confidence, bpm: res.confidence?.bpm };
            track.source = { ...track.source, bpm: res.source };
            // An external tempo can be a double-time reading of the record, so
            // it goes through the same suspicion the DSP estimate does: shown
            // with a warning, never quietly halved.
            if (bpmOutOfRange(res.bpm) || suggestBpmCorrection(res.bpm, track.genre)) {
              track.bpmSuspect = true;
            }
            changed = true;
          }
          if (res.key && !track.key && track.source?.key !== "manual") {
            track.key = res.key;
            track.confidence = { ...track.confidence, key: res.confidence?.key };
            track.source = { ...track.source, key: res.source };
            changed = true;
          }
          if (res.previewUrl && !track.previewUrl) {
            track.previewUrl = res.previewUrl;
            changed = true;
          }
          if (res.tags?.length) {
            track.tags = [...new Set([...(track.tags ?? []), ...res.tags])];
            changed = true;
          }
          if (changed) this.onUpdate(track);
        }
      } catch {
        // Contained failure; move on.
      }
      this.onProgress?.(this.pending.length);
      if (++this.persistCounter % 20 === 0) await this.persist();
    }
    await this.persist();
    this.running = false;
  }

  stop(): void {
    this.stopped = true;
  }

  private async persist(): Promise<void> {
    await saveQueueState(this.pending);
  }
}
