import { StreamingPlistParser, type PlistValue } from "./plist";
import type { Library, Playlist, Track } from "../types";

/** Auto-generated playlists to exclude by name (§0). */
const AUTO_PLAYLIST_NAMES = new Set([
  "Library",
  "Music",
  "Downloaded",
  "Recently Added",
]);

type RawPlaylist = {
  name: string;
  trackIds: number[];
  master: boolean;
  distinguished: boolean;
  smart: boolean;
};

export type ParseProgress = {
  tracks: number;
  playlists: number;
};

export type ParseCallbacks = {
  /** Batches of tracks as they stream out of the parser (playlists not yet joined). */
  onTrackBatch?: (batch: Track[]) => void;
  onProgress?: (p: ParseProgress) => void;
};

function str(v: PlistValue | undefined): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function num(v: PlistValue | undefined): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export function rawToTrack(raw: Record<string, PlistValue>): Track | null {
  const pid = str(raw["Persistent ID"]);
  const trackId = num(raw["Track ID"]);
  const name = str(raw["Name"]);
  if (!pid || trackId === undefined || !name) return null;
  const t: Track = {
    pid,
    trackId,
    name,
    durationMs: num(raw["Total Time"]) ?? 0,
    playlists: [],
  };
  const artist = str(raw["Artist"]);
  if (artist) t.artist = artist;
  const album = str(raw["Album"]);
  if (album) t.album = album;
  const genre = str(raw["Genre"]);
  if (genre) t.genre = genre;
  const year = num(raw["Year"]);
  if (year) t.year = year;
  const loc = str(raw["Location"]);
  if (loc) t.location = loc;
  const added = raw["Date Added"];
  if (added instanceof Date && !isNaN(added.getTime()))
    t.dateAdded = added.toISOString();
  // Some libraries do carry BPM; use it as ground truth with full confidence.
  const bpm = num(raw["BPM"]);
  if (bpm) {
    t.bpm = bpm;
    t.confidence = { bpm: 1 };
    t.source = { bpm: "file" };
  }
  return t;
}

function rawToPlaylist(raw: Record<string, PlistValue>): RawPlaylist | null {
  const name = str(raw["Name"]);
  if (!name) return null;
  const items = raw["Playlist Items"];
  const trackIds: number[] = [];
  if (Array.isArray(items)) {
    for (const item of items) {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const id = num((item as Record<string, PlistValue>)["Track ID"]);
        if (id !== undefined) trackIds.push(id);
      }
    }
  }
  return {
    name,
    trackIds,
    master: raw["Master"] === true,
    distinguished: raw["Distinguished Kind"] !== undefined,
    smart: raw["Smart Info"] !== undefined || raw["Smart Criteria"] !== undefined,
  };
}

/**
 * Drop auto-generated playlists: by flag, by name, and by the duplicate
 * pattern (two "playlists" with identical membership are one real one plus
 * an auto mirror — keep the first).
 */
export function filterPlaylists(raws: RawPlaylist[]): {
  kept: RawPlaylist[];
  dropped: string[];
} {
  const kept: RawPlaylist[] = [];
  const dropped: string[] = [];
  const seenSignatures = new Set<string>();
  for (const p of raws) {
    if (p.master || p.distinguished || AUTO_PLAYLIST_NAMES.has(p.name)) {
      dropped.push(p.name);
      continue;
    }
    if (p.trackIds.length === 0) {
      dropped.push(p.name);
      continue;
    }
    // Membership signature — cheap and exact for the duplicate pattern.
    const sig = p.trackIds.slice().sort((a, b) => a - b).join(",");
    if (seenSignatures.has(sig)) {
      dropped.push(p.name);
      continue;
    }
    seenSignatures.add(sig);
    kept.push(p);
  }
  return { kept, dropped };
}

/**
 * Parse a Library.xml stream into a Library. Feed chunks via the returned
 * `write`/`end`. Tracks stream out in batches through callbacks; the full
 * Library (with playlists joined via Track ID → Persistent ID) is returned
 * from `end()`.
 */
export function createLibraryParser(cb: ParseCallbacks = {}) {
  const tracks: Track[] = [];
  const byTrackId = new Map<number, Track>();
  const rawPlaylists: RawPlaylist[] = [];
  let batch: Track[] = [];
  const BATCH = 500;

  const parser = new StreamingPlistParser({
    onTrack: (_key, raw) => {
      const t = rawToTrack(raw);
      if (!t) return;
      tracks.push(t);
      byTrackId.set(t.trackId, t);
      batch.push(t);
      if (batch.length >= BATCH) {
        cb.onTrackBatch?.(batch);
        cb.onProgress?.({ tracks: tracks.length, playlists: 0 });
        batch = [];
      }
    },
    onPlaylist: (raw) => {
      const p = rawToPlaylist(raw);
      if (p) rawPlaylists.push(p);
    },
  });

  return {
    write(chunk: string) {
      parser.write(chunk);
    },
    end(): Library {
      parser.end();
      if (batch.length > 0) {
        cb.onTrackBatch?.(batch);
        batch = [];
      }
      const { kept, dropped } = filterPlaylists(rawPlaylists);
      const playlists: Playlist[] = [];
      for (const rp of kept) {
        const pids: string[] = [];
        for (const id of rp.trackIds) {
          const t = byTrackId.get(id);
          if (t) {
            pids.push(t.pid);
            t.playlists.push(rp.name);
          }
        }
        playlists.push({ name: rp.name, pids });
      }
      cb.onProgress?.({ tracks: tracks.length, playlists: playlists.length });
      return { tracks, playlists, droppedPlaylists: dropped };
    },
  };
}
