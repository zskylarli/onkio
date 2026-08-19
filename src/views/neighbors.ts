import {
  buildFeatureMatrix,
  type FeatureBlock,
  type FeatureMatrix,
  type MatrixOptions,
} from "../features/matrix";
import type { Playlist, Track } from "../types";

export type Neighbor = {
  track: Track;
  index: number;
  distanceSq: number;
};

/**
 * Build the recommendation metric. Playlists and genre labels are absent even
 * when callers pass a broader exclusion list: filing vocabularies do not
 * transfer between people's crates, and genre is a coarse tag that collapses
 * distinct records onto the same island.
 */
export function buildSimilarityMatrix(
  tracks: Track[],
  playlists: Playlist[],
  options: MatrixOptions = {}
): FeatureMatrix {
  const exclude = new Set<FeatureBlock>(options.exclude ?? []);
  exclude.add("playlists");
  exclude.add("genre");
  return buildFeatureMatrix(tracks, playlists, {
    ...options,
    exclude: [...exclude],
  });
}

/**
 * Exact nearest neighbors in the playlist-free feature space.
 *
 * The app normally holds at most a few thousand rows (and now offers sampling
 * above 1,000), so a linear scan is faster and much easier to invalidate than a
 * tree. Five sorted insertions per candidate are negligible beside the 50
 * multiplications needed to measure it.
 */
export class NeighborIndex {
  private readonly byPid: Map<string, number>;
  private readonly cache = new Map<string, Neighbor[]>();

  constructor(
    private readonly tracks: Track[],
    private readonly vectors: Float32Array,
    private readonly d: number,
    private readonly generation: number
  ) {
    if (d <= 0 || vectors.length !== tracks.length * d) {
      throw new Error(
        `Neighbor vectors do not match tracks: ${vectors.length} values for ` +
          `${tracks.length} × ${d}`
      );
    }
    this.byPid = new Map(tracks.map((track, index) => [track.pid, index]));
  }

  nearest(
    pid: string,
    targetCollection: string | null = null,
    limit = 5
  ): Neighbor[] {
    if (limit <= 0) return [];
    const query = this.byPid.get(pid);
    if (query === undefined) return [];

    const key = `${this.generation}\0${pid}\0${targetCollection ?? "*"}\0${limit}`;
    const cached = this.cache.get(key);
    if (cached) return cached;

    const best = this.scan(this.vectors, query * this.d, query, targetCollection, limit);
    this.cache.set(key, best);
    return best;
  }

  /**
   * Neighbours of a vector that is not in the library — an external track
   * projected into this same space. Uncached: the query is not identified by a
   * pid, and an outside track is asked about once.
   */
  nearestToVector(
    vector: Float32Array,
    targetCollection: string | null = null,
    limit = 5
  ): Neighbor[] {
    if (limit <= 0 || vector.length !== this.d) return [];
    return this.scan(vector, 0, -1, targetCollection, limit);
  }

  private scan(
    source: Float32Array,
    at: number,
    skip: number,
    targetCollection: string | null,
    limit: number
  ): Neighbor[] {
    const best: Neighbor[] = [];
    for (let index = 0; index < this.tracks.length; index++) {
      if (index === skip) continue;
      const track = this.tracks[index];
      if (targetCollection !== null && track.collection !== targetCollection) continue;

      let distanceSq = 0;
      const b = index * this.d;
      for (let c = 0; c < this.d; c++) {
        const delta = source[at + c] - this.vectors[b + c];
        distanceSq += delta * delta;
      }
      if (!Number.isFinite(distanceSq)) continue;

      const neighbor = { track, index, distanceSq };
      const insertAt = best.findIndex(
        (other) =>
          distanceSq < other.distanceSq ||
          (distanceSq === other.distanceSq && index < other.index)
      );
      if (insertAt >= 0) best.splice(insertAt, 0, neighbor);
      else best.push(neighbor);
      if (best.length > limit) best.pop();
    }
    return best;
  }
}
