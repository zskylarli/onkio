import type { Library, Track } from "../types";
import { toCamelot } from "../music/camelot";

const EXPECTED_COLUMNS = [
  "#",
  "Artwork",
  "Track Title",
  "Artist",
  "Album",
  "Genre",
  "BPM",
  "Rating",
  "Time",
  "Key",
  "Date Added",
] as const;

export type RekordboxTxtStats = {
  parsed: number;
  skipped: number;
  withBpm: number;
  withKey: number;
};

export type RekordboxTxtCollection = Library & { stats: RekordboxTxtStats };

/** Rekordbox writes this export as UTF-16LE with a BOM. */
export function decodeRekordboxTxt(bytes: ArrayBuffer | Uint8Array): string {
  const view =
    bytes instanceof Uint8Array
      ? bytes
      : new Uint8Array(bytes);
  const utf16le = view[0] === 0xff && view[1] === 0xfe;
  return new TextDecoder(utf16le ? "utf-16le" : "utf-8").decode(view);
}

function hash64(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

function value(row: string[], columns: Map<string, number>, name: string): string | undefined {
  const i = columns.get(name);
  const trimmed = i === undefined ? "" : (row[i] ?? "").trim();
  return trimmed || undefined;
}

function durationMs(raw: string | undefined): number {
  if (!raw) return 0;
  const parts = raw.split(":").map(Number);
  if (parts.some((n) => !Number.isFinite(n) || n < 0)) return 0;
  if (parts.length === 2) return Math.round((parts[0] * 60 + parts[1]) * 1000);
  if (parts.length === 3)
    return Math.round((parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000);
  return 0;
}

function dateAdded(raw: string | undefined): string | undefined {
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return undefined;
  const date = new Date(`${raw}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/**
 * Map one fixed-format rekordbox TXT row. The export has no durable database
 * identifier or path, so identity is derived from all exported metadata plus
 * its stable row number. The row number keeps otherwise identical duplicates
 * distinct without inventing metadata.
 */
export function rekordboxTxtTrack(
  row: string[],
  columns: Map<string, number>,
  lineNumber: number
): Track | null {
  const name = value(row, columns, "Track Title");
  if (!name) return null;
  const exportedNumber = Number.parseInt(value(row, columns, "#") ?? "", 10);
  const trackId = Number.isFinite(exportedNumber) && exportedNumber > 0 ? exportedNumber : lineNumber;
  const basis = EXPECTED_COLUMNS.map((column) => value(row, columns, column) ?? "").join("\t");
  const track: Track = {
    pid: `rbtxt:${hash64(`${trackId}\t${basis}`)}`,
    trackId,
    name,
    durationMs: durationMs(value(row, columns, "Time")),
    playlists: [],
  };

  const artist = value(row, columns, "Artist");
  if (artist) track.artist = artist;
  const album = value(row, columns, "Album");
  if (album) track.album = album;
  const genre = value(row, columns, "Genre");
  if (genre) track.genre = genre;
  const added = dateAdded(value(row, columns, "Date Added"));
  if (added) track.dateAdded = added;

  const bpm = Number.parseFloat(value(row, columns, "BPM") ?? "");
  if (Number.isFinite(bpm) && bpm > 0) {
    track.bpm = bpm;
    track.confidence = { bpm: 1 };
    track.source = { bpm: "rekordbox" };
  }
  const key = toCamelot(value(row, columns, "Key"));
  if (key) {
    track.key = key;
    track.confidence = { ...track.confidence, key: 1 };
    track.source = { ...track.source, key: "rekordbox" };
  }
  return track;
}

export function parseRekordboxTxt(text: string): RekordboxTxtCollection {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const header = (lines.shift() ?? "").split("\t").map((cell) => cell.trim());
  const missing = EXPECTED_COLUMNS.filter((column) => !header.includes(column));
  if (missing.length > 0) {
    throw new Error(`Not a supported rekordbox TXT export (missing ${missing.join(", ")})`);
  }
  const columns = new Map(header.map((name, i) => [name, i]));
  const tracks: Track[] = [];
  const seen = new Set<string>();
  const stats: RekordboxTxtStats = { parsed: 0, skipped: 0, withBpm: 0, withKey: 0 };

  lines.forEach((line, i) => {
    if (!line.trim()) return;
    const track = rekordboxTxtTrack(line.split("\t"), columns, i + 2);
    if (!track) {
      stats.skipped++;
      return;
    }
    if (seen.has(track.pid)) {
      track.pid = `rbtxt:${hash64(`${track.pid}\tline:${i + 2}`)}`;
    }
    seen.add(track.pid);
    tracks.push(track);
    if (track.bpm !== undefined) stats.withBpm++;
    if (track.key !== undefined) stats.withKey++;
  });
  stats.parsed = tracks.length;
  return { tracks, playlists: [], droppedPlaylists: [], stats };
}
