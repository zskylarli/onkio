/**
 * The part of an Apple Music library that GetSongBPM actually resolved, as a
 * library of its own.
 *
 * An Apple export carries no BPM and no key at all, so pairing one with a
 * rekordbox crate measures nothing about music: everything unanalyzed sits at
 * the centre of the tempo/key block, and "has no BPM" becomes its own region
 * of the map. Keeping only the tracks a real GetSongBPM trial resolved gives a
 * collection that is ~100% covered on both fields, which is the only way the
 * two sides can be compared on their content.
 *
 * Trustworthiness is the whole game here, since a wrong BPM moves a track to a
 * confidently wrong place. Three gates, in order:
 *
 * 1. Only the artist-constrained lookup (`via: "combined"`) counts. The
 *    title-only fallback is not shipped and was measured to be wrong on 54 of
 *    its 59 hits — a bare title is ambiguous enough that match.ts's
 *    cross-script rule waves unrelated songs through.
 * 2. The accepted candidate is re-scored with the *current* `pickBest`. The
 *    trial ran before `artistScore` required whole-word containment and a
 *    4-character minimum, so a handful of its matches ("eli" inside
 *    "feliciano") are ones the app would refuse today.
 * 3. Both tempo and key have to survive the same parsing the adapter does.
 *
 * Only the winning candidate's artist and title were recorded, not the whole
 * candidate list, so gate 2 can reject the old winner but never promote a
 * runner-up in its place. That errs towards excluding tracks, which is the
 * right direction for a subset whose point is that its values are believable.
 */
import { readFileSync } from "node:fs";
import { createLibraryParser } from "../src/parse/library";
import { normalizeArtist, normalizeTitle } from "../src/enrich/normalize";
import { pickBest } from "../src/enrich/match";
import { toCamelot } from "../src/music/camelot";
import type { Library, Playlist } from "../src/types";

/**
 * One entry of the checkpoint written by scripts/measure-getsongbpm.ts. The
 * shape is declared again rather than imported because that module starts the
 * trial as soon as it is loaded.
 */
type RecordedOutcome = {
  pid: string;
  artist?: string;
  title: string;
  status: string;
  via?: "combined" | "title-only";
  score?: number;
  matchedArtist?: string;
  matchedTitle?: string;
  rawTempo?: string;
  keyOf?: string;
  openKey?: string;
};

type Checkpoint = {
  seed: number;
  library: string;
  sampleSize: number;
  results: RecordedOutcome[];
};

/**
 * Confidences the shipped adapter attaches to a GetSongBPM answer. Mirrored
 * from src/enrich/sources/getsongbpm.ts, which holds them inline.
 */
const GSB_BPM_CONFIDENCE = 0.85;
const GSB_KEY_CONFIDENCE = 0.8;
const GSB_SOURCE = "getsongbpm";

export type SubsetAudit = {
  /** results present in the checkpoint(s) */
  recorded: number;
  /** tracks in the Apple export the results were joined against */
  libraryTracks: number;
  /** results whose pid a previous checkpoint had already reported */
  duplicatePids: number;
  /** pids that no longer join to a track in the library */
  unknownPids: number;
  /** results the API never matched, by recorded status */
  unmatchedByStatus: Record<string, number>;
  /** matched, but only by the unshipped title-only fallback */
  titleOnlyFallback: number;
  /** matched then, refused by the current whole-word matcher */
  rejectedByCurrentMatcher: number;
  /** accepted, but the tempo field was missing or unusable */
  noUsableTempo: number;
  /** accepted with tempo, but no key spelling that toCamelot() understands */
  noUsableKey: number;
  kept: number;
  /** `artist → matchedArtist` for tracks gate 2 dropped */
  rejectedExamples: string[];
};

/** Streamed in chunks, the way the browser feeds the parser a File. */
export function parseAppleLibrary(path: string): Library {
  const parser = createLibraryParser();
  const xml = readFileSync(path, "utf8");
  const CHUNK = 1 << 20;
  for (let i = 0; i < xml.length; i += CHUNK) parser.write(xml.slice(i, i + CHUNK));
  return parser.end();
}

/**
 * A library holding only `keep`, with playlist membership narrowed on both
 * sides. Both directions matter to the feature matrix: a playlist still
 * listing absent pids gets an IDF weight computed against the wrong size, and
 * a track still naming a dropped playlist claims a column that no longer
 * exists.
 *
 * Tracks are copied so the library passed in stays usable.
 */
export function restrictLibrary(lib: Library, keep: ReadonlySet<string>): Library {
  const playlists: Playlist[] = [];
  for (const p of lib.playlists) {
    const pids = p.pids.filter((pid) => keep.has(pid));
    if (pids.length > 0) playlists.push({ name: p.name, pids });
  }
  const names = new Set(playlists.map((p) => p.name));
  const tracks = lib.tracks
    .filter((t) => keep.has(t.pid))
    .map((t) => ({ ...t, playlists: t.playlists.filter((n) => names.has(n)) }));

  const counts = new Map<string, number>();
  for (const t of tracks) if (t.collection) counts.set(t.collection, (counts.get(t.collection) ?? 0) + 1);

  return {
    tracks,
    playlists,
    droppedPlaylists: lib.droppedPlaylists,
    collections: lib.collections?.map((c) => ({ ...c, trackCount: counts.get(c.id) ?? 0 })),
  };
}

/** Would the app accept this candidate today? */
function acceptedNow(r: RecordedOutcome): boolean {
  const wantArtist = r.artist ? normalizeArtist(r.artist) : "";
  const wantTitle = normalizeTitle(r.title);
  return (
    pickBest(
      [r],
      (c) => c.matchedArtist,
      (c) => c.matchedTitle,
      wantArtist,
      wantTitle
    ) !== null
  );
}

/**
 * `resultsPath` may name several checkpoints, which is how a trial and the
 * later sweep of everything it left over become one collection. They are read
 * in order and a pid is honoured once: a run resumed against the wrong
 * exclusion list would otherwise have its tracks counted twice and, worse,
 * carry whichever answer happened to be read last.
 */
export function buildAnalyzedAppleSubset(
  libraryPath: string,
  resultsPath: string | readonly string[]
): { library: Library; audit: SubsetAudit } {
  const full = parseAppleLibrary(libraryPath);
  const byPid = new Map(full.tracks.map((t) => [t.pid, t]));
  const paths = typeof resultsPath === "string" ? [resultsPath] : resultsPath;
  const recorded = paths.flatMap(
    (p) => (JSON.parse(readFileSync(p, "utf8")) as Checkpoint).results
  );

  const audit: SubsetAudit = {
    recorded: 0,
    libraryTracks: full.tracks.length,
    duplicatePids: 0,
    unknownPids: 0,
    unmatchedByStatus: {},
    titleOnlyFallback: 0,
    rejectedByCurrentMatcher: 0,
    noUsableTempo: 0,
    noUsableKey: 0,
    kept: 0,
    rejectedExamples: [],
  };

  const keep = new Set<string>();
  const seen = new Set<string>();
  for (const r of recorded) {
    audit.recorded++;
    if (seen.has(r.pid)) {
      audit.duplicatePids++;
      continue;
    }
    seen.add(r.pid);
    const track = byPid.get(r.pid);
    if (!track) {
      audit.unknownPids++;
      continue;
    }
    if (r.status !== "matched") {
      audit.unmatchedByStatus[r.status] = (audit.unmatchedByStatus[r.status] ?? 0) + 1;
      continue;
    }
    if (r.via !== "combined") {
      audit.titleOnlyFallback++;
      continue;
    }
    if (!acceptedNow(r)) {
      audit.rejectedByCurrentMatcher++;
      if (audit.rejectedExamples.length < 12)
        audit.rejectedExamples.push(
          `"${r.title}" ${r.artist ?? "?"} → ${r.matchedArtist ?? "?"} (was score ${r.score ?? "?"})`
        );
      continue;
    }

    const bpm = r.rawTempo != null ? parseFloat(r.rawTempo) : NaN;
    if (!(Number.isFinite(bpm) && bpm > 0)) {
      audit.noUsableTempo++;
      continue;
    }
    const key = toCamelot(r.openKey) ?? toCamelot(r.keyOf);
    if (!key) {
      audit.noUsableKey++;
      continue;
    }

    track.bpm = bpm;
    track.key = key;
    track.confidence = { bpm: GSB_BPM_CONFIDENCE, key: GSB_KEY_CONFIDENCE };
    track.source = { bpm: GSB_SOURCE, key: GSB_SOURCE };
    keep.add(r.pid);
    audit.kept++;
  }

  return { library: restrictLibrary(full, keep), audit };
}

export function describeAudit(a: SubsetAudit): string[] {
  const unmatched = Object.entries(a.unmatchedByStatus)
    .sort((x, y) => y[1] - x[1])
    .map(([k, v]) => `${k} ${v}`)
    .join(", ");
  return [
    `GetSongBPM trial: ${a.recorded} tracks queried`,
    `  API never matched:            ${Object.values(a.unmatchedByStatus).reduce((s, x) => s + x, 0)}  (${unmatched})`,
    `  excluded, title-only fallback: ${a.titleOnlyFallback}  (not shipped; 54 of 59 were wrong)`,
    `  excluded, current matcher refuses: ${a.rejectedByCurrentMatcher}  (whole-word + 4-char rule)`,
    `  excluded, no usable tempo:     ${a.noUsableTempo}`,
    `  excluded, no usable key:       ${a.noUsableKey}`,
    `  pid no longer in library:      ${a.unknownPids}`,
    ...(a.duplicatePids > 0 ? [`  pid recorded more than once:   ${a.duplicatePids}`] : []),
    `  kept:                          ${a.kept}`,
    ...a.rejectedExamples.map((e) => `    refused now: ${e}`),
  ];
}
