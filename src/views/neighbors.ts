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
 * Build the recommendation metric. Playlists are deliberately absent even when
 * callers pass a broader exclusion list: filing vocabularies do not transfer
 * between people's crates, so they cannot be evidence of musical similarity.
 */
export function buildSimilarityMatrix(
  tracks: Track[],
  playlists: Playlist[],
  options: MatrixOptions = {}
): FeatureMatrix {
  const exclude = new Set<FeatureBlock>(options.exclude ?? []);
  exclude.add("playlists");
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

    const best: Neighbor[] = [];
    for (let index = 0; index < this.tracks.length; index++) {
      if (index === query) continue;
      const track = this.tracks[index];
      if (targetCollection !== null && track.collection !== targetCollection) continue;

      let distanceSq = 0;
      const a = query * this.d;
      const b = index * this.d;
      for (let c = 0; c < this.d; c++) {
        const delta = this.vectors[a + c] - this.vectors[b + c];
        distanceSq += delta * delta;
      }
      if (!Number.isFinite(distanceSq)) continue;

      const neighbor = { track, index, distanceSq };
      const at = best.findIndex(
        (other) =>
          distanceSq < other.distanceSq ||
          (distanceSq === other.distanceSq && index < other.index)
      );
      if (at >= 0) best.splice(at, 0, neighbor);
      else best.push(neighbor);
      if (best.length > limit) best.pop();
    }

    this.cache.set(key, best);
    return best;
  }
}
