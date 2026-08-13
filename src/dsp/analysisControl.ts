import type { Track } from "../types";
import { needsLookup } from "../collections/coverage";

export const ANALYSIS_IDLE_LABEL = "Analyze songs";
export const ANALYSIS_STOP_LABEL = "Stop analysis";

export type AnalysisTarget = {
  track: Track;
  needsSound: boolean;
  needsMetadata: boolean;
};

/**
 * One audio pass produces timbre, BPM, and key, so tracks needed by either of
 * the former analysis controls belong in the same queue.
 */
export function analysisTargets(
  tracks: Track[],
  visiblePids: string[]
): AnalysisTarget[] {
  const byPid = new Map(tracks.map((track) => [track.pid, track]));
  return visiblePids.flatMap((pid) => {
    const track = byPid.get(pid);
    if (!track) return [];
    const needsSound = !track.timbre;
    const needsMetadata = !track.bpm || !track.key;
    return needsSound || needsMetadata ? [{ track, needsSound, needsMetadata }] : [];
  });
}

/**
 * Online half of the unified action. Label lookup is explicit here rather than
 * in needsLookup, so loading a complete rekordbox export still queues nothing
 * until the user asks to analyze it.
 */
export function analysisLookupTargets(tracks: Track[]): Track[] {
  return tracks.filter((track) => needsLookup(track) || !track.label);
}

/** Unique tracks Analyze songs would actually work on. */
export function analysisNeededCount(
  tracks: Track[],
  visiblePids: string[]
): number {
  const ids = new Set<string>();
  for (const track of analysisLookupTargets(tracks)) ids.add(track.pid);
  for (const target of analysisTargets(tracks, visiblePids)) ids.add(target.track.pid);
  return ids.size;
}

export function describeAnalysisNeeded(n: number): string {
  if (n <= 0) return "nothing needs analysis";
  return n === 1 ? "1 song needs analysis" : `${n.toLocaleString()} songs need analysis`;
}
