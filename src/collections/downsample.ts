import type { Library, Playlist, Track } from "../types";

/**
 * Sampling an import down to something a full analysis pass can finish.
 *
 * Analysis is the constraint, not layout: embedding a few thousand tracks costs
 * seconds, while listening to them and looking each one up costs a couple of
 * seconds *each*. Above the threshold below, a first map you can actually use
 * every feature on is worth more than one where the interesting half of the
 * controls stay greyed out because nothing has been analyzed yet.
 */

/** Track count above which the import offers a sample. */
export const DOWNSAMPLE_THRESHOLD = 1000;

/** Sample sizes offered, smallest first. */
export const DOWNSAMPLE_PRESETS = [500, 1000, 2000];

/**
 * The presets worth showing for a file this size. A "sample" that is not
 * smaller than the file is a no-op, and offering it invites the user to pick a
 * number that changes nothing.
 */
export function samplePresets(trackCount: number): number[] {
  return DOWNSAMPLE_PRESETS.filter((n) => n < trackCount);
}

export function needsDownsampleOffer(trackCount: number): boolean {
  return trackCount > DOWNSAMPLE_THRESHOLD && samplePresets(trackCount).length > 0;
}

/**
 * `size` indices out of `n`, without replacement, returned in ascending order.
 *
 * A partial Fisher-Yates shuffle: uniform over subsets, and it touches `size`
 * entries rather than shuffling the whole array. Sorting afterwards keeps the
 * sample in file order, so the track list and search results read the way the
 * export did — the randomness is in *which* tracks survive, not their order.
 */
function pickIndices(n: number, size: number, random: () => number): number[] {
  const idx = Array.from({ length: n }, (_, i) => i);
  for (let i = 0; i < size; i++) {
    const j = i + Math.floor(random() * (n - i));
    const swap = idx[i];
    idx[i] = idx[j];
    idx[j] = swap;
  }
  return idx.slice(0, size).sort((a, b) => a - b);
}

/**
 * A uniform random sample of `size` tracks, with playlists narrowed to the
 * tracks that survived.
 *
 * Playlists are membership seen from two sides — `Playlist.pids` and
 * `Track.playlists` — and both have to agree afterwards, or the playlist filter
 * offers a name that highlights nothing and the feature matrix builds a column
 * for a playlist that no longer exists. Both parsers produce consistent input,
 * where a surviving track always keeps at least one member in each playlist it
 * names, so the second pass is a guard rather than routine work. It is scoped to
 * the names *sampling* removed: names the parser never turned into a playlist
 * are somebody else's inconsistency and are left exactly as they were found.
 */
export function downsampleLibrary(
  lib: Library,
  size: number,
  random: () => number = Math.random
): Library {
  if (size >= lib.tracks.length) return lib;

  const picked = pickIndices(lib.tracks.length, size, random).map((i) => lib.tracks[i]);
  const kept = new Set(picked.map((t) => t.pid));

  const playlists: Playlist[] = [];
  for (const p of lib.playlists) {
    const pids = p.pids.filter((pid) => kept.has(pid));
    if (pids.length > 0) playlists.push({ name: p.name, pids });
  }

  const survived = new Set(playlists.map((p) => p.name));
  const removed = new Set(
    lib.playlists.map((p) => p.name).filter((name) => !survived.has(name))
  );
  const tracks: Track[] = picked.map((t) =>
    t.playlists.some((name) => removed.has(name))
      ? { ...t, playlists: t.playlists.filter((name) => !removed.has(name)) }
      : t
  );

  return { ...lib, tracks, playlists };
}
