import type { Track } from "../types";

/**
 * Placing a track that is not in the library onto the map that already exists.
 *
 * This is the projection half of a reference-mapping workflow (Seurat's
 * `ProjectCellEmbeddings` → `ProjectUMAP` → `refdata` label transfer, or
 * uwot's `umap_transform`): the query is pushed through the *fitted* model
 * rather than added to the corpus and re-fit. Re-fitting would move every dot
 * already on screen, which is not something a user can be asked to accept in
 * exchange for one new point.
 *
 * Three steps, in order:
 *   1. `projectVector` — the feature row through the retained SVD basis.
 *   2. `placeVector`   — 50-D coordinates to 2D, by UMAP-weighted mean of the
 *                        query's nearest library neighbours.
 *   3. `transferLabels` — cluster and genre carried over from those neighbours.
 */

/** Matches the pipeline's UMAP `nNeighbors`, so placement sees the same scale
 * of neighbourhood the map itself was built from. */
export const PROJECTION_NEIGHBORS = 15;

/**
 * `U = xV`: the encoded row through the retained eigenvector basis.
 *
 * A `null` basis means the reduction was a no-op (the feature space was
 * already narrower than k), so the row passes through unchanged.
 */
export function projectVector(
  row: Float32Array,
  basis: Float64Array | null,
  inputD: number,
  k: number
): Float32Array {
  if (row.length !== inputD) {
    throw new Error(`Row has ${row.length} values, expected ${inputD}`);
  }
  if (basis === null) {
    if (k !== inputD) {
      throw new Error(`Identity basis cannot map ${inputD} dims to ${k}`);
    }
    return Float32Array.from(row);
  }
  if (basis.length !== inputD * k) {
    throw new Error(
      `Basis has ${basis.length} values, expected ${inputD} × ${k}`
    );
  }
  const out = new Float32Array(k);
  for (let kk = 0; kk < k; kk++) {
    let s = 0;
    for (let i = 0; i < inputD; i++) s += row[i] * basis[i * k + kk];
    out[kk] = s;
  }
  return out;
}

export type ProjectedNeighbor = {
  index: number;
  distance: number;
  /** L1-normalized UMAP membership strength; the weights sum to 1. */
  weight: number;
};

export type Placement = {
  x: number;
  y: number;
  neighbors: ProjectedNeighbor[];
};

const SMOOTH_K_TOLERANCE = 1e-5;
const MIN_K_DIST_SCALE = 1e-3;

/**
 * UMAP's smoothed k-NN distance for a single point: find the bandwidth `sigma`
 * that makes the neighbourhood's fuzzy membership sum to log2(k), with `rho`
 * the distance to the nearest neighbour so that the closest point always has
 * membership 1. Binary search, exactly as in the reference implementation
 * (`smooth_knn_dist` in umap-learn, `smoothKNNDistance` in umap-js).
 *
 * `localConnectivity` here is the transform-time value, i.e. one less than the
 * fit-time setting: an out-of-sample point is not its own neighbour, so its
 * neighbour list has no self-distance-of-zero to skip over.
 */
export function smoothKnnDistance(
  distances: number[],
  k: number,
  localConnectivity: number
): { sigma: number; rho: number } {
  const target = Math.log2(k);
  let lo = 0;
  let hi = Infinity;
  let mid = 1;

  let rho = 0;
  const nonZero = distances.filter((d) => d > 0);
  if (nonZero.length >= localConnectivity) {
    const index = Math.floor(localConnectivity);
    const interpolation = localConnectivity - index;
    if (index > 0) {
      rho = nonZero[index - 1];
      if (interpolation > SMOOTH_K_TOLERANCE) {
        rho += interpolation * (nonZero[index] - nonZero[index - 1]);
      }
    } else {
      rho = interpolation * (nonZero[0] ?? 0);
    }
  } else if (nonZero.length > 0) {
    rho = Math.max(...nonZero);
  }

  for (let iter = 0; iter < 64; iter++) {
    let psum = 0;
    // The reference skips j = 0 deliberately: the first neighbour is the one
    // rho was taken from, and counting it would bias every bandwidth.
    for (let j = 1; j < distances.length; j++) {
      const d = distances[j] - rho;
      psum += d > 0 ? Math.exp(-(d / mid)) : 1;
    }
    if (Math.abs(psum - target) < SMOOTH_K_TOLERANCE) break;
    if (psum > target) {
      hi = mid;
      mid = (lo + hi) / 2;
    } else {
      lo = mid;
      mid = hi === Infinity ? mid * 2 : (lo + hi) / 2;
    }
  }

  // Floor the bandwidth relative to the neighbourhood scale, so a point whose
  // neighbours are all nearly coincident does not get a sigma of ~0 and a
  // membership vector that is one neighbour and fourteen zeroes.
  const meanDistance =
    distances.length > 0
      ? distances.reduce((a, b) => a + b, 0) / distances.length
      : 0;
  const sigma = Math.max(mid, MIN_K_DIST_SCALE * meanDistance);
  return { sigma, rho };
}

/**
 * UMAP's `compute_membership_strengths` for one point: distances become fuzzy
 * edge weights, everything within rho being full membership.
 */
export function membershipStrengths(
  distances: number[],
  sigma: number,
  rho: number
): number[] {
  return distances.map((d) => (d - rho <= 0 ? 1 : Math.exp(-((d - rho) / sigma))));
}

/**
 * Place a query vector on the existing 2D map.
 *
 * This is uwot's `umap_transform(init = "weighted", n_epochs = 0)`: take the
 * query's nearest library neighbours in the 50-D playlist-free space, turn
 * their distances into UMAP edge weights, L1-normalize, and return the
 * weighted mean of their map positions. Running optimization epochs on top
 * would let the point drift and would make placement depend on RNG state; the
 * weighted mean is deterministic and always lands inside the neighbourhood
 * that justified it, which is the honest thing to show for a track that was
 * never part of the layout.
 */
export function placeVector(
  vector: Float32Array,
  vectors: Float32Array,
  d: number,
  coords: Float32Array,
  nNeighbors = PROJECTION_NEIGHBORS,
  localConnectivity = 1,
  skipIndex?: number
): Placement | null {
  const n = Math.floor(vectors.length / d);
  if (n === 0 || vector.length !== d || coords.length < n * 2) return null;
  const skip =
    skipIndex !== undefined && skipIndex >= 0 && skipIndex < n ? skipIndex : -1;
  const k = Math.min(nNeighbors, skip >= 0 ? n - 1 : n);
  if (k <= 0) return null;

  const nearest: { index: number; distance: number }[] = [];
  for (let index = 0; index < n; index++) {
    if (index === skip) continue;
    let sum = 0;
    const base = index * d;
    for (let c = 0; c < d; c++) {
      const delta = vector[c] - vectors[base + c];
      sum += delta * delta;
    }
    if (!Number.isFinite(sum)) continue;
    const distance = Math.sqrt(sum);
    // Same ordering rule as NeighborIndex: nearer first, lower index breaks a
    // tie, so an identical pair of tracks resolves the same way every time.
    const at = nearest.findIndex(
      (other) =>
        distance < other.distance ||
        (distance === other.distance && index < other.index)
    );
    if (at >= 0) nearest.splice(at, 0, { index, distance });
    else nearest.push({ index, distance });
    if (nearest.length > k) nearest.pop();
  }
  if (nearest.length === 0) return null;

  const distances = nearest.map((entry) => entry.distance);
  const { sigma, rho } = smoothKnnDistance(
    distances,
    k,
    Math.max(0, localConnectivity - 1)
  );
  const strengths = membershipStrengths(distances, sigma, rho);
  const total = strengths.reduce((a, b) => a + b, 0);
  // Every strength can only be zero if sigma collapsed; fall back to a plain
  // mean rather than returning NaN coordinates.
  const weights = strengths.map((v) =>
    total > 0 ? v / total : 1 / strengths.length
  );

  let x = 0;
  let y = 0;
  for (let i = 0; i < nearest.length; i++) {
    x += weights[i] * coords[nearest[i].index * 2];
    y += weights[i] * coords[nearest[i].index * 2 + 1];
  }

  return {
    x,
    y,
    neighbors: nearest.map((entry, i) => ({ ...entry, weight: weights[i] })),
  };
}

/**
 * Seurat's `refdata` label transfer: an attribute the query does not have is
 * carried over from its neighbours by weighted majority, using the same
 * membership weights that placed it. The genre is only worth transferring when
 * the external track has none of its own — a stated genre is evidence, a
 * transferred one is an inference, and they should not be confused.
 */
export function transferLabels(
  neighbors: ProjectedNeighbor[],
  clusters: Int32Array | null,
  tracks: readonly Track[] | null
): { clusterId: number | null; genre: string | null } {
  const clusterVotes = new Map<number, number>();
  const genreVotes = new Map<string, number>();
  for (const { index, weight } of neighbors) {
    if (clusters && index < clusters.length) {
      const id = clusters[index];
      clusterVotes.set(id, (clusterVotes.get(id) ?? 0) + weight);
    }
    const genre = tracks?.[index]?.genre;
    if (genre) genreVotes.set(genre, (genreVotes.get(genre) ?? 0) + weight);
  }
  return {
    clusterId: winner(clusterVotes),
    genre: winner(genreVotes),
  };
}

/** Highest total weight wins; ties go to whichever key was seen first, which
 * is the nearest neighbour, since the neighbour list is distance-sorted. */
function winner<T>(votes: Map<T, number>): T | null {
  let best: T | null = null;
  let bestWeight = -Infinity;
  for (const [key, weight] of votes) {
    if (weight > bestWeight) {
      best = key;
      bestWeight = weight;
    }
  }
  return best;
}
