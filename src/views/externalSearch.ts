import type { Track } from "../types";
import { lookupKey } from "../enrich/normalize";

/**
 * What the "Find a track" box does for a catalogue search.
 *
 * Searching a catalogue is a network request, so it is asked for rather than
 * fired: every keystroke would otherwise be a lookup, and most of them are
 * half-typed words. The button is the whole of the opt-in, and this module is
 * the state behind it — kept apart from the DOM because the interesting part
 * is the ordering, not the markup: a response that arrives after the query
 * moved on must not be shown against the new query, a local hit must not
 * retire the offer, and a failure has to be distinguishable from an empty
 * catalogue rather than both reading as "nothing found".
 */

export type ExternalCandidate = {
  /** Deezer track id — durable, and what the ghost's pid is minted from. */
  id: number;
  title: string;
  artist?: string;
  album?: string;
  albumId?: number;
  durationMs?: number;
  previewUrl?: string;
  /**
   * Set when this result is a track the library already holds. The local one
   * is what gets shown: it is on the map already, with the user's own BPM, key
   * and playlists on it, and a second dot for the same record would be a lie
   * about the size of the crate.
   */
  localPid?: string;
};

export type ExternalSearchState =
  /** nothing to offer: no query */
  | { kind: "off" }
  /** a query is standing and Deezer can be asked */
  | { kind: "offer"; query: string }
  | { kind: "searching"; query: string }
  | { kind: "results"; query: string; candidates: ExternalCandidate[] }
  /** the catalogue was asked and had nothing */
  | { kind: "none"; query: string }
  | { kind: "failed"; query: string; reason: string };

export type ExternalSearchEvent =
  /** the library's own answer for a query, however many it found */
  | { kind: "local"; query: string; matches: number }
  | { kind: "requested"; query: string }
  | { kind: "found"; query: string; candidates: ExternalCandidate[] }
  | { kind: "failed"; query: string; reason: string }
  | { kind: "cleared" };

export const OFF: ExternalSearchState = { kind: "off" };

/** The query a state is about, or "" for the states that are about none. */
function queryOf(state: ExternalSearchState): string {
  return state.kind === "off" ? "" : state.query;
}

/**
 * `local` fires on every search, including the ones that re-run the query that
 * is already on screen (a library save, a focus, a re-render). Re-running the
 * same query therefore leaves an external answer standing: throwing away a
 * result list because the same search was recomputed would make the list
 * vanish for no reason the user can see.
 */
export function nextExternalSearch(
  state: ExternalSearchState,
  event: ExternalSearchEvent
): ExternalSearchState {
  switch (event.kind) {
    case "cleared":
      return OFF;

    case "local": {
      // Local hits do not retire the offer: a title the crate already holds is
      // still a reason to look outside it, for a different recording or mix.
      if (!event.query) return OFF;
      if (queryOf(state) === event.query && state.kind !== "off") return state;
      return { kind: "offer", query: event.query };
    }

    case "requested":
      return event.query ? { kind: "searching", query: event.query } : OFF;

    case "found":
      // A response for a query that has since been retyped, cleared or
      // superseded belongs to a question nobody is asking any more.
      if (state.kind !== "searching" || state.query !== event.query) return state;
      return event.candidates.length > 0
        ? { kind: "results", query: event.query, candidates: event.candidates }
        : { kind: "none", query: event.query };

    case "failed":
      if (state.kind !== "searching" || state.query !== event.query) return state;
      return { kind: "failed", query: event.query, reason: event.reason };
  }
}

/**
 * Titles the library already holds, keyed the way the lookup cache keys them,
 * so "Song (Radio Edit)" and "Song" by the same artist collide as they should.
 * The first track wins a collision, matching every other pid-keyed lookup here.
 */
export function localTitleIndex(tracks: readonly Track[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const track of tracks) {
    const key = lookupKey(track.artist, track.name);
    if (!index.has(key)) index.set(key, track.pid);
  }
  return index;
}

/** Tag every candidate the library already holds with the local pid. */
export function markLocalDuplicates(
  candidates: readonly ExternalCandidate[],
  local: ReadonlyMap<string, string>
): ExternalCandidate[] {
  return candidates.map((candidate) => {
    const pid = local.get(lookupKey(candidate.artist, candidate.title));
    return pid === undefined ? candidate : { ...candidate, localPid: pid };
  });
}

/**
 * What the dropdown says. Terse on purpose — this sits under a search box, and
 * every one of these lines is read while the user is mid-task.
 */
export function externalSearchNote(state: ExternalSearchState): string {
  switch (state.kind) {
    case "off":
      return "";
    case "offer":
      return "";
    case "searching":
      return "Looking on Deezer…";
    case "results":
      return "From Deezer — pick one to place it on the map.";
    case "none":
      return `Deezer has nothing for “${state.query}”.`;
    case "failed":
      return `Deezer could not be reached — ${state.reason}.`;
  }
}
