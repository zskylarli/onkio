import type { Track } from "../types";
import { decodeLocation } from "../parse/rekordbox";

/**
 * Resolving library tracks to audio files under a folder the user picked.
 *
 * The path recorded in an export is almost never the path underneath the chosen
 * folder: it was written on another machine, at a different mount point, or
 * before the library was moved. `/Users/skylarli/Music/House/Track.aiff` has to
 * find `House/Track.aiff` under whatever folder is handed to us now, so what
 * survives is the *tail* of the path, never its root.
 *
 * Candidates are therefore scored by how many trailing segments agree, and a
 * bare filename match is simply the weakest score rather than a separate rule.
 * Filenames genuinely collide in a real library — one `Intro.mp3` per album —
 * so a tie at the best score is reported as ambiguous and left unresolved.
 * Binding a track to the wrong audio is worse than leaving it silent, because
 * the wrong file would then be played, analyzed, and embedded as if it were the
 * track.
 *
 * Nothing here touches the File System Access API: the folder is reduced to a
 * list of relative paths first, and resolution is a pure function of that list.
 */

/**
 * Path an export never had. Where a source carries no location at all but track
 * identity still has to survive a re-export, the pid is derived from a synthetic
 * path under this prefix instead: an Apple library converted for import has a
 * real path for a handful of its tracks and nothing for the rest. Scanning a
 * folder for those is not a miss to be reported, it is a question that was never
 * asked, so they are recognized here rather than counted as files gone missing.
 */
export const NO_LOCAL_FILE_PREFIX = "/Onkio/no-local-file/";

export function isSyntheticLocation(location: string): boolean {
  return decodeLocation(location).startsWith(NO_LOCAL_FILE_PREFIX);
}

/** Split on either separator, so a Windows export resolves too. */
export function pathSegments(path: string): string[] {
  return path.split(/[/\\]+/).filter((s) => s.length > 0);
}

/**
 * Fold a segment for comparison. macOS stores filenames decomposed while an
 * export may carry the composed form, so `Café.aiff` on disk and `Café.aiff` in
 * the XML are one name in two encodings; and every filesystem a DJ library
 * lives on is case-insensitive in practice.
 */
function fold(segment: string): string {
  return segment.normalize("NFC").toLowerCase();
}

/** How many segments two paths share, counting back from the filename. */
export function trailingMatchLength(
  a: readonly string[],
  b: readonly string[]
): number {
  let n = 0;
  while (n < a.length && n < b.length && fold(a[a.length - 1 - n]) === fold(b[b.length - 1 - n])) {
    n++;
  }
  return n;
}

/**
 * Files grouped by folded filename. A candidate has to share the track's
 * filename to score at all, so this is both the candidate set and the reason
 * resolution stays linear in the library rather than quadratic against the
 * folder. It also means every candidate scores at least 1.
 */
export type FileIndex = {
  paths: readonly string[];
  segments: readonly string[][];
  byFilename: Map<string, number[]>;
};

export function buildFileIndex(paths: readonly string[]): FileIndex {
  const segments = paths.map(pathSegments);
  const byFilename = new Map<string, number[]>();
  segments.forEach((segs, i) => {
    const name = segs[segs.length - 1];
    if (!name) return;
    const key = fold(name);
    const bucket = byFilename.get(key);
    if (bucket) bucket.push(i);
    else byFilename.set(key, [i]);
  });
  return { paths, segments, byFilename };
}

export type Resolution =
  /** `file` indexes into the file list; `depth` is how many segments agreed. */
  | { kind: "matched"; file: number; depth: number }
  /** Several files tie at the best score, so which one is meant is unknown. */
  | { kind: "ambiguous"; files: number[] }
  | { kind: "unmatched" };

/** Resolve one exported location against the folder. */
export function resolveLocation(index: FileIndex, location: string): Resolution {
  const segs = pathSegments(decodeLocation(location));
  const name = segs[segs.length - 1];
  if (!name) return { kind: "unmatched" };

  const candidates = index.byFilename.get(fold(name));
  if (!candidates || candidates.length === 0) return { kind: "unmatched" };

  let best = 0;
  let winners: number[] = [];
  for (const i of candidates) {
    const depth = trailingMatchLength(segs, index.segments[i]);
    if (depth > best) {
      best = depth;
      winners = [i];
    } else if (depth === best) {
      winners.push(i);
    }
  }
  if (winners.length > 1) return { kind: "ambiguous", files: winners };
  return { kind: "matched", file: winners[0], depth: best };
}

export type FolderResolution = {
  /** pid → index into the file list */
  matched: Map<string, number>;
  /** pid → the files that tie, so the reason can be shown rather than guessed */
  ambiguous: Map<string, number[]>;
  /** pids whose filename is nowhere under the folder */
  unmatched: string[];
  /** tracks the export gave no path for, which no folder can resolve */
  withoutLocation: number;
};

/**
 * Resolve a whole library. Every track lands in exactly one bucket, so the
 * counts add up to the library and the readout can be trusted.
 */
export function resolveTracks(
  tracks: readonly Track[],
  index: FileIndex
): FolderResolution {
  const out: FolderResolution = {
    matched: new Map(),
    ambiguous: new Map(),
    unmatched: [],
    withoutLocation: 0,
  };
  for (const t of tracks) {
    // A synthetic path stands where a track never had one, so it belongs with
    // the tracks no folder can resolve rather than with the ones looked for and
    // not found.
    if (!t.location || isSyntheticLocation(t.location)) {
      out.withoutLocation++;
      continue;
    }
    const r = resolveLocation(index, t.location);
    if (r.kind === "matched") out.matched.set(t.pid, r.file);
    else if (r.kind === "ambiguous") out.ambiguous.set(t.pid, r.files);
    else out.unmatched.push(t.pid);
  }
  return out;
}

/**
 * One sentence of what the folder actually resolved. Ambiguity and misses are
 * named rather than folded into the total, because "812 of 950" alone reads as
 * a failure when the truth may be that 130 of the misses were never in the
 * folder to begin with.
 */
export function describeResolution(r: FolderResolution, files: number): string {
  const total =
    r.matched.size + r.ambiguous.size + r.unmatched.length + r.withoutLocation;
  const parts = [
    `${r.matched.size.toLocaleString()} of ${total.toLocaleString()} ` +
      `${total === 1 ? "track plays" : "tracks play"} from this folder`,
  ];
  if (r.ambiguous.size > 0) {
    parts.push(
      `${r.ambiguous.size.toLocaleString()} left alone because several files share the same name`
    );
  }
  if (r.unmatched.length > 0) {
    parts.push(`${r.unmatched.length.toLocaleString()} not found here`);
  }
  // Kept apart from the misses: a track the export gave no path for was never
  // looked for, and calling it missing invites a hunt for files that were never
  // named.
  if (r.withoutLocation > 0) {
    parts.push(`${r.withoutLocation.toLocaleString()} with no path recorded to match`);
  }
  return `${parts.join(", ")}. ${files.toLocaleString()} audio files scanned.`;
}
