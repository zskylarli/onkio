import type { CollectionMeta, Library, Track } from "../types";

/**
 * Coverage, measured per imported file rather than over the whole library.
 *
 * A single average is actively misleading once more than one file is loaded. A
 * rekordbox export arrives with BPM and key for everything; an Apple Music
 * export has neither for anything. Pooled, a 950-track crate beside a
 * 4,400-track listening library reads as "18% BPM", a number that describes
 * neither file and suggests work is needed on both. Split, it reads as 100%
 * and 0%, which says exactly where the work is.
 *
 * That same split decides what gets looked up. Online lookups cost roughly
 * 2.5s per track and resolve about a third of what they are asked about, so
 * spending them on tracks that already have BPM and key from rekordbox is the
 * one thing worth being careful about.
 */

export type CollectionCoverage = {
  id: string;
  label: string;
  format: "rekordbox" | "apple";
  /** tracks belonging to this collection */
  total: number;
  bpm: number;
  key: number;
  /** tracks with a canonical record label */
  labelCount: number;
  /** tracks with a timbral fingerprint measured from audio */
  sound: number;
  preview: number;
  /** tracks resolved to a file in the connected music folder */
  local: number;
  /** tracks lacking BPM or key, i.e. what lookups would target */
  incomplete: number;
};

/**
 * Whether an online lookup could still tell us something about this track.
 *
 * Preview URL is deliberately not part of this. Previews serve sound analysis,
 * which is an explicit, viewport-scoped action that fetches its own previews on
 * demand; treating a missing preview as outstanding work queued every single
 * rekordbox track for lookup despite all of them already having BPM and key.
 */
export function needsLookup(t: Track): boolean {
  return !t.bpm || !t.key;
}

function emptyRow(meta: CollectionMeta): CollectionCoverage {
  return {
    id: meta.id,
    label: meta.label,
    format: meta.format,
    total: 0,
    bpm: 0,
    key: 0,
    labelCount: 0,
    sound: 0,
    preview: 0,
    local: 0,
    incomplete: 0,
  };
}

/**
 * Per-collection tallies, in import order. Tracks whose `collection` is unknown
 * (a library saved before provenance existed, or one whose collection was
 * removed) are gathered under a trailing synthetic row rather than dropped,
 * because a track that is on the map has to be somewhere in the readout.
 *
 * `localPids` is passed in rather than stored on the track on purpose. Which
 * tracks have a file behind them is only true while a folder is authorized, and
 * a saved library that claimed local audio after the folder was revoked or
 * moved would be a readout describing a state that no longer exists.
 */
export function collectionCoverage(
  lib: Library,
  localPids?: ReadonlySet<string>
): CollectionCoverage[] {
  const metas = lib.collections ?? [];
  const rows = new Map<string, CollectionCoverage>();
  for (const m of metas) rows.set(m.id, emptyRow(m));

  const UNFILED = "\u0000unfiled";
  for (const t of lib.tracks) {
    const id = t.collection ?? UNFILED;
    let row = rows.get(id);
    if (!row) {
      row = emptyRow({
        id,
        label: id === UNFILED ? "Unfiled" : id,
        // A pid prefix is the only evidence of format left once metadata is gone.
        format: t.pid.startsWith("rb:") ? "rekordbox" : "apple",
        trackCount: 0,
        addedAt: "",
      });
      rows.set(id, row);
    }
    row.total++;
    if (t.bpm) row.bpm++;
    if (t.key) row.key++;
    if (t.label) row.labelCount++;
    if (t.timbre) row.sound++;
    if (t.previewUrl) row.preview++;
    if (localPids?.has(t.pid)) row.local++;
    if (needsLookup(t)) row.incomplete++;
  }

  // Import order first, then anything unfiled.
  const ordered = metas.map((m) => rows.get(m.id)!).filter((r) => r.total > 0);
  for (const [id, row] of rows)
    if (!metas.some((m) => m.id === id) && row.total > 0) ordered.push(row);
  return ordered;
}

/**
 * What the sound-influence slider can honestly offer.
 *
 * It weights a timbral fingerprint that only analyzed tracks carry, so with
 * none analyzed there is nothing to weight: moving it rebuilds the whole map,
 * reports a time, and lands on a pixel-identical layout. That is correct and
 * indistinguishable from broken, so the control is held shut until there is
 * sound to weigh, and says how much of the library it can move once there is.
 */
export function describeSoundInfluence(rows: CollectionCoverage[]): {
  enabled: boolean;
  note: string;
} {
  const analyzed = rows.reduce((n, r) => n + r.sound, 0);
  const total = rows.reduce((n, r) => n + r.total, 0);
  if (analyzed === 0) {
    return {
      enabled: false,
      note:
        "No track has been listened to yet, so there is no sound to weigh and " +
        "this can change nothing. Run 'Analyze songs' first.",
    };
  }
  return {
    enabled: true,
    note:
      `${analyzed.toLocaleString()} of ${total.toLocaleString()} tracks have been ` +
      "listened to; only those move when this changes.",
  };
}

export function describeLabelInfluence(rows: CollectionCoverage[]): {
  enabled: boolean;
  note: string;
} {
  const labelled = rows.reduce((n, r) => n + r.labelCount, 0);
  const total = rows.reduce((n, r) => n + r.total, 0);
  if (labelled === 0) {
    return {
      enabled: false,
      note:
        "No track has a known label yet, so there is no label signal to weigh. " +
        "Run 'Analyze songs' to look them up.",
    };
  }
  return {
    enabled: true,
    note:
      `${labelled.toLocaleString()} of ${total.toLocaleString()} tracks have a known label; ` +
      "only those move when this changes.",
  };
}

/**
 * A short sentence naming which collections still have gaps, for the lookup
 * control. Without it the button reports a count with no indication of which
 * file it belongs to, which is the whole question when two are loaded.
 */
export function describeOutstanding(rows: CollectionCoverage[]): string {
  const pending = rows.filter((r) => r.incomplete > 0);
  if (pending.length === 0) return "Every track has BPM and key.";
  const parts = pending.map(
    (r) => `${r.label} (${r.incomplete.toLocaleString()} of ${r.total.toLocaleString()})`
  );
  const complete = rows.filter((r) => r.incomplete === 0);
  const skipped =
    complete.length > 0
      ? ` Skipping ${complete.map((r) => r.label).join(", ")}, already complete.`
      : "";
  return `Missing BPM or key: ${parts.join(", ")}.${skipped}`;
}
