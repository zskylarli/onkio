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
