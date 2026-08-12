/**
 * Free-text search over the loaded library, for finding where a track sits on
 * the map. Every match is reported, not just the listed ones: searching an
 * artist is a way of asking where that artist lives in the space, which only
 * works if the map lights up all of them.
 */

import type { Track } from "../types";
import { foldForSearch } from "../enrich/normalize";

export type SearchResults = {
  /** indices into the track array, in library order — every match */
  matches: number[];
  /** best-ranked matches, capped at `limit`, for the result list */
  shown: number[];
};

const EMPTY: SearchResults = { matches: [], shown: [] };

/**
 * Folding the whole library on every keystroke is the expensive part, and the
 * fields being folded never change after import, so the result is kept per
 * track. Enrichment mutates bpm/key/preview, none of which are searched.
 */
const folded = new WeakMap<Track, { title: string; artist: string }>();

function foldTrack(t: Track): { title: string; artist: string } {
  let f = folded.get(t);
  if (!f) {
    f = { title: foldForSearch(t.name), artist: t.artist ? foldForSearch(t.artist) : "" };
    folded.set(t, f);
  }
  return f;
}

/**
 * Rank so that the track someone is actually typing the name of comes first.
 * A whole-phrase hit beats one assembled from separate tokens, and a title
 * beats an artist, because a title is the more specific thing to have typed.
 */
function rank(query: string, title: string, artist: string): number {
  if (title.startsWith(query)) return 4;
  if (artist.startsWith(query)) return 3;
  if (title.includes(query)) return 2;
  if (artist.includes(query)) return 1;
  return 0;
}

export function searchTracks(tracks: Track[], query: string, limit = 20): SearchResults {
  const q = foldForSearch(query);
  if (!q) return EMPTY;
  // Tokens are ANDed across title and artist together, so "daft one more"
  // finds a track neither field matches on its own.
  const tokens = q.split(" ");

  const matches: number[] = [];
  const ranked: { index: number; score: number }[] = [];
  for (let i = 0; i < tracks.length; i++) {
    const { title, artist } = foldTrack(tracks[i]);
    const hay = artist ? `${title} ${artist}` : title;
    if (!tokens.every((tok) => hay.includes(tok))) continue;
    matches.push(i);
    ranked.push({ index: i, score: rank(q, title, artist) });
  }

  // Sort is stable, so equally good matches stay in library order.
  ranked.sort((a, b) => b.score - a.score);
  return { matches, shown: ranked.slice(0, limit).map((r) => r.index) };
}
