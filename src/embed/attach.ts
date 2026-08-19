import type { Track } from "../types";

/**
 * Adding a projected track to a map that already exists, without re-fitting it.
 *
 * The layout, the clusters and the similarity vectors were all produced by one
 * run over one track list, and every consumer indexes across them by row. A
 * track placed by `embed/project` has a position in that same space but was
 * never part of the run, so joining it means growing all four in step and
 * leaving every existing row byte-identical.
 *
 * That last part is the whole point. Re-running the embedding to include one
 * new track moves every dot on screen: the UMAP layout is not stable under a
 * changed corpus, and a user who asked to see where one record sits would get
 * back a map they no longer recognise. So this never touches the fit — it does
 * not consult the encoder, the SVD basis or the worker, and the caller's
 * embedding generation is not its to change.
 *
 * Pure, and returns fresh arrays rather than growing the originals in place:
 * the renderer diffs its data by reference, so a mutated array is a change it
 * cannot see, and a copy is what makes "nothing else moved" checkable.
 */

export type Embedding = {
  tracks: Track[];
  /** n × 2, laid out by the embedding run */
  coords: Float32Array;
  /** n cluster ids */
  clusters: Int32Array;
  /** n × similarityD, the playlist-free vectors neighbours are found in */
  similarity: Float32Array;
  similarityD: number;
};

/** Where a projected track goes, in every space the embedding indexes by row. */
export type Attachment = {
  x: number;
  y: number;
  clusterId: number;
  /** the track's own coordinates in the similarity space, length similarityD */
  vector: Float32Array;
};

function check(embedding: Embedding): number {
  const { tracks, coords, clusters, similarity, similarityD } = embedding;
  const n = tracks.length;
  if (similarityD <= 0) throw new Error("Similarity space has no width");
  if (coords.length !== n * 2) {
    throw new Error(`Coords hold ${coords.length} values for ${n} tracks`);
  }
  if (clusters.length !== n) {
    throw new Error(`Clusters hold ${clusters.length} values for ${n} tracks`);
  }
  if (similarity.length !== n * similarityD) {
    throw new Error(
      `Similarity holds ${similarity.length} values for ${n} × ${similarityD}`
    );
  }
  return n;
}

function checkVector(vector: Float32Array, d: number): void {
  if (vector.length !== d) {
    throw new Error(`Vector has ${vector.length} values, expected ${d}`);
  }
}

/**
 * Append one projected track. Every existing row is copied across unchanged,
 * which is what lets a caller prove the map held still.
 */
export function attachProjectedTrack(
  embedding: Embedding,
  track: Track,
  at: Attachment
): Embedding {
  const n = check(embedding);
  const d = embedding.similarityD;
  checkVector(at.vector, d);
  if (embedding.tracks.some((existing) => existing.pid === track.pid)) {
    throw new Error(`${track.pid} is already in this embedding`);
  }

  const coords = new Float32Array((n + 1) * 2);
  coords.set(embedding.coords);
  coords[n * 2] = at.x;
  coords[n * 2 + 1] = at.y;

  const clusters = new Int32Array(n + 1);
  clusters.set(embedding.clusters);
  clusters[n] = at.clusterId;

  const similarity = new Float32Array((n + 1) * d);
  similarity.set(embedding.similarity);
  similarity.set(at.vector, n * d);

  return {
    tracks: [...embedding.tracks, track],
    coords,
    clusters,
    similarity,
    similarityD: d,
  };
}

/**
 * Move one already-attached track to a refined position, leaving the rest of
 * the map exactly where it was.
 *
 * This is what a new measurement earns — a timbre vector from audio, or a BPM
 * or key the user typed — without re-laying out everyone else. The track now
 * has a feature nothing knew about when it was placed, so it is projected
 * again rather than embedded again. Returns null when the pid is not here,
 * which is the ordinary answer for a ghost that was never added.
 */
export function reprojectAttachedTrack(
  embedding: Embedding,
  pid: string,
  at: Attachment
): Embedding | null {
  check(embedding);
  const d = embedding.similarityD;
  checkVector(at.vector, d);
  const row = embedding.tracks.findIndex((track) => track.pid === pid);
  if (row < 0) return null;

  const coords = Float32Array.from(embedding.coords);
  coords[row * 2] = at.x;
  coords[row * 2 + 1] = at.y;

  const clusters = Int32Array.from(embedding.clusters);
  clusters[row] = at.clusterId;

  const similarity = Float32Array.from(embedding.similarity);
  similarity.set(at.vector, row * d);

  return {
    // A fresh array with the same members: the renderer only regenerates its
    // attributes when the data it was given is not the array it already has.
    tracks: [...embedding.tracks],
    coords,
    clusters,
    similarity,
    similarityD: d,
  };
}
