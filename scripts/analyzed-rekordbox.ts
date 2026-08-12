/**
 * Writing a Library back out as a rekordbox `DJ_PLAYLISTS` collection, and in
 * particular writing the GetSongBPM-analyzed slice of an Apple export as one.
 *
 * The app reads two formats and only one of them can carry a key: Apple's
 * plist has no tonal field at all (src/parse/library.ts takes BPM and nothing
 * else), while rekordbox has `AverageBpm` and `Tonality`. An enriched subset
 * that wants its key to survive re-import therefore has to leave as rekordbox,
 * whatever format it arrived in — and `detectFormat` picks that up on its own
 * from `DJ_PLAYLISTS` in the first bytes.
 *
 * Everything here aims at src/parse/rekordbox.ts specifically: `TotalTime` in
 * seconds because the parser multiplies by 1000, Camelot in `Tonality` because
 * `toCamelot` returns it unchanged, playlists keyed by `TrackID` under
 * `KeyType="0"`, and attribute values escaped for exactly what
 * `decodeEntities` reverses.
 *
 * One thing the format cannot express: confidence. GetSongBPM answers are
 * third-party lookups the adapter trusts at 0.85/0.8, but rekordbox numbers are
 * the user's own analysis of their own audio, so the parser reads them back at
 * confidence 1 from source "rekordbox". The values are unchanged; their
 * provenance is flattened, which the file's own header comment says out loud.
 */
import { join } from "node:path";
import type { Library, Track } from "../src/types";
import { buildAnalyzedAppleSubset, type SubsetAudit } from "./analyzed-subset";

/** Fixture names, shared with the test so both sides agree on one file. */
export const ANALYZED_XML = "apple_getsongbpm_analyzed.xml";
/** The same thing over every track of the library, not just the trial sample. */
export const ANALYZED_FULL_XML = "apple_getsongbpm_analyzed_full.xml";
export const APPLE_XML = "apple_library.xml";
export const GSB_RESULTS = "getsongbpm-results.json";
export const GSB_RESULTS_REMAINDER = "getsongbpm-results-remainder.json";
export const GSB_RESULTS_ALL = [GSB_RESULTS, GSB_RESULTS_REMAINDER];

/**
 * Only what `decodeEntities` reverses. `'` needs no escape inside a
 * double-quoted value, and is left alone so names read normally in the file;
 * the tabs and newlines are here because a real library eventually contains
 * one and an attribute value is no place for a raw control character.
 */
const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "\n": "&#10;",
  "\r": "&#13;",
  "\t": "&#9;",
};

function attr(name: string, value: string | number): string {
  const escaped = String(value).replace(/[&<>"\n\r\t]/g, (c) => ESCAPES[c]);
  return `${name}="${escaped}"`;
}

/**
 * Where a track with no path of its own is parked. `rekordboxPid` hashes the
 * decoded `Location` and falls back to `Artist|Name`, so a pathless track takes
 * its identity from its metadata — and six of these tracks share both with
 * another one (two "Almost Love" by Sabrina Carpenter, three "Break Your Heart
 * Right Back"), which would silently fuse them. A streaming Apple library
 * carries a real path for almost nothing, so identity is pinned to the Apple
 * persistent id instead: unique, unchanged by a regeneration or by a later
 * metadata edit, and named so that nobody mistakes it for a file on disk.
 */
const NO_LOCAL_FILE = "/Onkio/no-local-file";

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function locationFor(t: Track): string {
  const path = t.location?.startsWith("file://")
    ? t.location.replace(/^file:\/\/(localhost)?/, "")
    : encodePath(`${NO_LOCAL_FILE}/${t.pid}`);
  return `file://localhost${path}`;
}

/**
 * rekordbox counts `TotalTime` in seconds and writes whole ones. Three decimals
 * costs a few bytes and makes the Apple export's millisecond duration survive
 * the round trip exactly; anything reading this with `parseInt` still sees the
 * seconds it expects.
 */
function totalTime(durationMs: number): string {
  return (durationMs / 1000).toFixed(3);
}

function trackTag(t: Track): string {
  const attrs = [attr("TrackID", t.trackId), attr("Name", t.name)];
  if (t.artist) attrs.push(attr("Artist", t.artist));
  if (t.album) attrs.push(attr("Album", t.album));
  if (t.genre) attrs.push(attr("Genre", t.genre));
  attrs.push(attr("TotalTime", totalTime(t.durationMs)));
  if (t.year) attrs.push(attr("Year", t.year));
  // Two decimals is the rekordbox spelling; every tempo here is a whole number.
  if (t.bpm !== undefined) attrs.push(attr("AverageBpm", t.bpm.toFixed(2)));
  if (t.key) attrs.push(attr("Tonality", t.key));
  // rekordbox's DateAdded is a date, so the time of day is dropped rather than
  // smuggled into a field with no room for it.
  if (t.dateAdded) attrs.push(attr("DateAdded", t.dateAdded.slice(0, 10)));
  return `    <TRACK ${attrs.join(" ")}\n           ${attr("Location", locationFor(t))}/>`;
}

/**
 * Playlists as `Type="1"` nodes directly under ROOT. Apple playlists are flat,
 * and a folder would only add a " / " prefix to every name the parser rebuilds.
 * Members are `TrackID` references, which is what `KeyType="0"` promises.
 *
 * A member listed twice is written once: an Apple playlist can hold the same
 * track twice, the parser ignores the repeat, and `Entries` has to agree with
 * what the file actually says.
 */
function playlistNodes(library: Library): { lines: string[]; count: number } {
  const trackIds = new Map(library.tracks.map((t) => [t.pid, t.trackId]));
  const lines: string[] = [];
  let count = 0;
  for (const p of library.playlists) {
    const keys = [...new Set(p.pids)]
      .map((pid) => trackIds.get(pid))
      .filter((id): id is number => id !== undefined);
    if (keys.length === 0) continue;
    count++;
    lines.push(
      `      <NODE ${attr("Name", p.name)} ${attr("Type", 1)} ${attr("KeyType", 0)} ${attr("Entries", keys.length)}>`,
      ...keys.map((id) => `        <TRACK ${attr("Key", id)}/>`),
      "      </NODE>"
    );
  }
  return { lines, count };
}

export function renderRekordboxXml(library: Library, notes: readonly string[] = []): string {
  const playlists = playlistNodes(library);

  const lines = ['<?xml version="1.0" encoding="UTF-8"?>'];
  if (notes.length > 0) {
    // `--` cannot appear inside an XML comment.
    lines.push("<!--", ...notes.map((n) => (n ? `  ${n.replace(/-{2,}/g, "-")}` : "")), "-->");
  }
  lines.push(
    `<DJ_PLAYLISTS ${attr("Version", "1.0.0")}>`,
    `  <PRODUCT ${attr("Name", "Onkio")} ${attr("Version", "0.1.0")}/>`,
    `  <COLLECTION ${attr("Entries", library.tracks.length)}>`,
    ...library.tracks.map(trackTag),
    "  </COLLECTION>",
    "  <PLAYLISTS>",
    `    <NODE ${attr("Type", 0)} ${attr("Name", "ROOT")} ${attr("Count", playlists.count)}>`,
    ...playlists.lines,
    "    </NODE>",
    "  </PLAYLISTS>",
    "</DJ_PLAYLISTS>"
  );
  return lines.join("\n") + "\n";
}

/** What the file says about itself, in numbers taken from the run that made it. */
function provenance(audit: SubsetAudit, library: Library): string[] {
  const scope =
    audit.recorded >= audit.libraryTracks
      ? `all ${audit.recorded} tracks of that library`
      : `a ${audit.recorded}-track sample of that library`;
  return [
    "Onkio: the GetSongBPM-analyzed slice of an Apple Music library.",
    "",
    `${library.tracks.length} tracks in ${library.playlists.length} playlists: everything that a real GetSongBPM`,
    `trial over ${scope} resolved to a BPM and a`,
    "key trustworthy enough to keep. AverageBpm and Tonality are that",
    "lookup's answers, not an analysis of the audio, so they carry the",
    "adapter's confidence (0.85 tempo, 0.8 key) even though the rekordbox",
    "format has nowhere to say so and re-import will read them as certain.",
    "",
    "Locations are placeholders keyed by Apple persistent id: this library",
    "is a streaming one and has no paths of its own.",
    "",
    "Generated by scripts/emit-analyzed-rekordbox.ts. Regenerate, do not edit.",
  ];
}

/**
 * The subset, rendered. Returns the library too, so a caller can check the XML
 * against what went into it.
 */
export function buildAnalyzedRekordbox(
  fixturesDir: string,
  resultsFiles: readonly string[] = [GSB_RESULTS]
): {
  library: Library;
  audit: SubsetAudit;
  xml: string;
} {
  const { library, audit } = buildAnalyzedAppleSubset(
    join(fixturesDir, APPLE_XML),
    resultsFiles.map((f) => join(fixturesDir, f))
  );
  return { library, audit, xml: renderRekordboxXml(library, provenance(audit, library)) };
}
