import type { Track } from "../types";
import { keyCompatibility, type KeyCompatibility } from "../music/camelot";
import { isSyntheticLocation } from "../local/match";

/**
 * Set builder rules (§7.1). Warnings, never hard blocks; every judgment
 * carries the confidence of the derived values it rests on.
 */

export type TransitionWarning =
  | { kind: "key"; compat: KeyCompatibility }
  | { kind: "key-unknown" }
  | { kind: "bpm"; deltaPct: number }
  | { kind: "bpm-unknown" };

export type Transition = {
  from: Track;
  to: Track;
  warnings: TransitionWarning[];
  /** 1 = clean, decays with warnings; scaled by data confidence */
  score: number;
};

export const BPM_TOLERANCE_PCT = 6;

export function bpmDeltaPct(a: number, b: number): number {
  // Compare in the closest octave: 70 → 140 is a legitimate double-time mix.
  const candidates = [b, b * 2, b / 2];
  let best = Infinity;
  for (const bb of candidates) {
    const d = (Math.abs(bb - a) / a) * 100;
    if (d < best) best = d;
  }
  return Math.round(best * 10) / 10;
}

export function evaluateTransition(from: Track, to: Track): Transition {
  const warnings: TransitionWarning[] = [];
  let score = 1;

  if (from.key && to.key) {
    const compat = keyCompatibility(from.key, to.key);
    if (compat === "near") {
      warnings.push({ kind: "key", compat });
      score *= 0.7; // near-miss (relative-key family), not a failure (§4)
    } else if (compat === "clash") {
      warnings.push({ kind: "key", compat });
      score *= 0.35;
    }
    const keyConf = Math.min(from.confidence?.key ?? 1, to.confidence?.key ?? 1);
    score *= 0.5 + 0.5 * keyConf;
  } else {
    warnings.push({ kind: "key-unknown" });
    score *= 0.6;
  }

  if (from.bpm && to.bpm) {
    const delta = bpmDeltaPct(from.bpm, to.bpm);
    if (delta > BPM_TOLERANCE_PCT) {
      warnings.push({ kind: "bpm", deltaPct: delta });
      score *= Math.max(0.2, 1 - (delta - BPM_TOLERANCE_PCT) / 30);
    }
    const bpmConf = Math.min(from.confidence?.bpm ?? 1, to.confidence?.bpm ?? 1);
    score *= 0.5 + 0.5 * bpmConf;
  } else {
    warnings.push({ kind: "bpm-unknown" });
    score *= 0.6;
  }

  return { from, to, warnings, score: Math.round(score * 100) / 100 };
}

/** Valid next tracks for suggestion mode (§7.1): key-compatible and within
 * BPM tolerance, sorted by transition score. */
export function suggestNext(current: Track, pool: Track[], limit = 50): Transition[] {
  const out: Transition[] = [];
  for (const t of pool) {
    if (t.pid === current.pid) continue;
    if (!t.bpm && !t.key) continue; // nothing to judge with
    const tr = evaluateTransition(current, t);
    const hardWarnings = tr.warnings.filter(
      (w) => (w.kind === "key" && w.compat === "clash") || w.kind === "bpm"
    );
    if (hardWarnings.length === 0) out.push(tr);
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}

export function evaluateSet(tracks: Track[]): Transition[] {
  const out: Transition[] = [];
  for (let i = 1; i < tracks.length; i++) {
    out.push(evaluateTransition(tracks[i - 1], tracks[i]));
  }
  return out;
}

// ---- ordering ----

/**
 * Move one entry to a new position, as a drag or an arrow key asks for.
 *
 * `to` is where the entry ends up in the finished list, not where it sat before
 * anything moved, which is the only reading that lets a caller say "third from
 * the top" without knowing where the entry started.
 */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const out = list.slice();
  if (from < 0 || from >= out.length) return out;
  const target = Math.max(0, Math.min(out.length - 1, to));
  if (target === from) return out;
  const [item] = out.splice(from, 1);
  out.splice(target, 0, item);
  return out;
}

/**
 * Put a batch of tracks into a playable order: a tempo ramp, slowest first.
 *
 * A lasso answers with a region of the map, which has no order in it at all,
 * and appending in row order would mean appending in whatever sequence the
 * library file happened to list them. Ascending BPM is the one ordering that is
 * useful before anyone looks at it, and it is a starting point rather than a
 * verdict: rows can be dragged afterwards.
 *
 * Tracks with no BPM sort to the end instead of to the front, where a missing
 * value read as zero would put them, and hold their relative order so a group
 * from one crate stays together.
 */
export function orderForSet(tracks: readonly Track[]): Track[] {
  return tracks
    .map((track, i) => ({ track, i }))
    .sort((a, b) => {
      const ab = a.track.bpm ?? Infinity;
      const bb = b.track.bpm ?? Infinity;
      return ab === bb ? a.i - b.i : ab - bb;
    })
    .map((e) => e.track);
}

// ---- exports (§7.1) ----

export function toM3U8(tracks: Track[], name = "Music Constellation Set"): string {
  const lines = ["#EXTM3U", `#PLAYLIST:${name}`];
  for (const t of tracks) {
    const secs = Math.round(t.durationMs / 1000);
    const artist = t.artist ?? "Unknown Artist";
    lines.push(`#EXTINF:${secs},${artist} - ${t.name}`);
    // No local files in this library mode — reference by title; players that
    // resolve by metadata (and the local-crate mode later) fill in paths. A
    // synthetic location is not a path either, and writing one out would hand a
    // player a file that has never existed.
    const path = t.location && !isSyntheticLocation(t.location) ? t.location : null;
    lines.push(path ?? `${artist} - ${t.name}`);
  }
  return lines.join("\n") + "\n";
}

export function toTextTracklist(tracks: Track[]): string {
  return tracks
    .map((t, i) => {
      const bits = [`${String(i + 1).padStart(2, "0")}. ${t.artist ?? "?"} - ${t.name}`];
      if (t.key || t.bpm) {
        bits.push(
          `[${[t.key, t.bpm ? `${Math.round(t.bpm)} BPM` : null].filter(Boolean).join(", ")}]`
        );
      }
      return bits.join(" ");
    })
    .join("\n");
}
