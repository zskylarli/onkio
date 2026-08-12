import type { Track } from "../types";

/** Taste view analytics (§7.2). Time-based views intentionally absent —
 * Date Added coverage is ~9% in the reference library. */

export type ClusterSummary = {
  cluster: number;
  size: number;
  topGenres: [string, number][];
  topArtists: [string, number][];
  topPlaylists: [string, number][];
  label: string;
};

function topN(counts: Map<string, number>, n: number): [string, number][] {
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

/**
 * TF-IDF-flavored cluster labels (§6): terms frequent in the cluster but rare
 * overall.
 *
 * Only genres and artists are eligible. Playlist names and rekordbox tags
 * score well on TF-IDF precisely because they are narrow, so they used to win
 * the labels and name a region of the map after the folder its tracks were
 * filed in ("SKYLAR 1", "New 3-1-25") or after the pool they were bought from
 * (the Label field, which in a DJ export is often a download-store URL). A
 * label has to describe the music for the legend, the Taste view and the gap
 * headline to mean anything.
 *
 * Labels are unique across the returned set, so everything downstream can name
 * a cluster by its label without disambiguating a second time.
 */
export function summarizeClusters(
  tracks: Track[],
  clusters: Int32Array
): ClusterSummary[] {
  const globalTerm = new Map<string, number>();
  const perCluster = new Map<
    number,
    { genres: Map<string, number>; artists: Map<string, number>; playlists: Map<string, number>; terms: Map<string, number>; size: number }
  >();

  tracks.forEach((t, i) => {
    const c = clusters[i];
    let entry = perCluster.get(c);
    if (!entry) {
      perCluster.set(
        c,
        (entry = {
          genres: new Map(),
          artists: new Map(),
          playlists: new Map(),
          terms: new Map(),
          size: 0,
        })
      );
    }
    entry.size++;
    const terms = [...(t.genre ? [t.genre] : []), ...(t.artist ? [t.artist] : [])];
    for (const term of terms) {
      entry.terms.set(term, (entry.terms.get(term) ?? 0) + 1);
      globalTerm.set(term, (globalTerm.get(term) ?? 0) + 1);
    }
    if (t.genre) entry.genres.set(t.genre, (entry.genres.get(t.genre) ?? 0) + 1);
    if (t.artist) entry.artists.set(t.artist, (entry.artists.get(t.artist) ?? 0) + 1);
    for (const p of t.playlists)
      entry.playlists.set(p, (entry.playlists.get(p) ?? 0) + 1);
  });

  const n = tracks.length;
  const out: ClusterSummary[] = [];
  const ranked = new Map<number, string[]>();
  for (const [cluster, e] of perCluster) {
    const scored = [...e.terms.entries()]
      .map(([term, tf]) => {
        const df = globalTerm.get(term) ?? 1;
        return [term, (tf / e.size) * Math.log(n / df)] as [string, number];
      })
      .sort((a, b) => b[1] - a[1])
      .map(([term]) => term);
    ranked.set(cluster, scored);
    // A band named after its genre would otherwise produce "Techno / Techno".
    const pick: string[] = [];
    for (const term of scored) {
      if (pick.length === 2) break;
      if (!pick.some((p) => p.toLowerCase() === term.toLowerCase())) pick.push(term);
    }
    // Genre-poor clusters can be left with nothing to say. Numbering them from
    // one matches how the legend and the gap markers already count.
    const label = pick.join(" / ") || `Cluster ${cluster + 1}`;
    out.push({
      cluster,
      size: e.size,
      topGenres: topN(e.genres, 5),
      topArtists: topN(e.artists, 5),
      topPlaylists: topN(e.playlists, 5),
      label,
    });
  }
  makeDistinct(out, ranked);
  out.sort((a, b) => b.size - a.size);
  return out;
}

/** Case and term order do not make two names different to read. */
function labelKey(label: string): string {
  return label
    .split(" / ")
    .map((s) => s.trim().toLowerCase())
    .sort()
    .join(" / ");
}

/**
 * k-means splits one dense genre region into several clusters, which then
 * honestly earn the same top terms, and the same name twice in the legend says
 * less than one name does. Qualify each colliding cluster with its strongest
 * term that none of the others it collides with has at all; where nothing
 * separates them, number them, since a dull name beats a repeated one.
 *
 * Every cluster is qualified against the whole colliding set rather than
 * against whichever rival came first, so the outcome does not depend on the
 * order clusters are met in.
 */
function makeDistinct(summaries: ClusterSummary[], ranked: Map<number, string[]>): void {
  const byKey = new Map<string, ClusterSummary[]>();
  for (const s of summaries) {
    const key = labelKey(s.label);
    byKey.set(key, [...(byKey.get(key) ?? []), s]);
  }

  for (const group of byKey.values()) {
    if (group.length < 2) continue;
    for (const s of group) {
      const rivals = new Set(
        group
          .filter((o) => o !== s)
          .flatMap((o) => ranked.get(o.cluster) ?? [])
          .map((t) => t.toLowerCase())
      );
      const mine = new Set(labelKey(s.label).split(" / "));
      const own = (ranked.get(s.cluster) ?? []).find(
        (t) => !rivals.has(t.toLowerCase()) && !mine.has(t.toLowerCase())
      );
      s.label = `${s.label} · ${own ?? `Cluster ${s.cluster + 1}`}`;
    }
  }

  // A qualifier could in principle land on a name some other cluster already
  // holds. Lowest cluster number keeps the plain form, so this is stable.
  const taken = new Set<string>();
  for (const s of [...summaries].sort((a, b) => a.cluster - b.cluster)) {
    if (taken.has(s.label)) s.label = `${s.label} · Cluster ${s.cluster + 1}`;
    taken.add(s.label);
  }
}

export type TasteReport = {
  totalTracks: number;
  genreDistribution: [string, number][];
  artistConcentration: [string, number][];
  /** share of library covered by the top 10 artists */
  top10ArtistShare: number;
  tagDistribution: [string, number][];
};

export function tasteReport(tracks: Track[]): TasteReport {
  const genres = new Map<string, number>();
  const artists = new Map<string, number>();
  const tags = new Map<string, number>();
  for (const t of tracks) {
    if (t.genre) genres.set(t.genre, (genres.get(t.genre) ?? 0) + 1);
    if (t.artist) artists.set(t.artist, (artists.get(t.artist) ?? 0) + 1);
    for (const tag of t.tags ?? []) tags.set(tag, (tags.get(tag) ?? 0) + 1);
  }
  const artistTop = topN(artists, 15);
  const top10 = artistTop.slice(0, 10).reduce((s, [, c]) => s + c, 0);
  return {
    totalTracks: tracks.length,
    genreDistribution: topN(genres, 15),
    artistConcentration: artistTop,
    top10ArtistShare: tracks.length ? top10 / tracks.length : 0,
    tagDistribution: topN(tags, 20),
  };
}
