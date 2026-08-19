import type { Track } from "../types";
import { keyVector } from "../music/camelot";
import { placeVector, transferLabels, PROJECTION_NEIGHBORS } from "./project";

/**
 * Place a track whose BPM or key was typed, by nearest neighbours in tempo/key
 * space — not the SVD similarity space. Encoder-scaled rows bury three BPM
 * columns under tags and timbre, so a typed tempo never moved the dot.
 *
 * Raw log-tempo and Camelot coordinates are the same units the numeric block
 * was designed around, without corpus scaling that can flatten them to zero
 * when the taste slider is high.
 */

export type TempoKeyDims = { bpm: boolean; key: boolean };

const TEMPO_KEY_D = 6;

export function tempoKeyVector(track: Track, dims: TempoKeyDims): Float32Array {
  const v = new Float32Array(TEMPO_KEY_D);
  if (dims.bpm && track.bpm && track.bpm > 0) {
    const log = Math.log2(track.bpm);
    v[0] = log;
    const frac = ((log % 1) + 1) % 1;
    v[1] = Math.sin(2 * Math.PI * frac);
    v[2] = Math.cos(2 * Math.PI * frac);
  }
  if (dims.key && track.key) {
    const kv = keyVector(track.key);
    if (kv) {
      v[3] = kv[0];
      v[4] = kv[1];
      v[5] = kv[2];
    }
  }
  return v;
}

export type TempoKeyPlacement = {
  x: number;
  y: number;
  clusterId: number;
  /** Library row indexes that pulled the query onto the map, nearest first. */
  neighborIndexes: number[];
};

/**
 * `skipPid` must be the edited library track: it already carries the new BPM,
 * so without the skip it is its own nearest neighbour and does not move.
 */
export function placeByTempoKey(
  query: Track,
  tracks: readonly Track[],
  coords: Float32Array,
  clusters: Int32Array | null,
  opts: { skipPid?: string; bpm?: boolean; key?: boolean } = {}
): TempoKeyPlacement | null {
  const dims: TempoKeyDims = {
    bpm: opts.bpm !== false,
    key: opts.key !== false,
  };
  const n = tracks.length;
  if (n === 0 || coords.length < n * 2) return null;

  const rows = new Float32Array(n * TEMPO_KEY_D);
  for (let i = 0; i < n; i++) {
    rows.set(tempoKeyVector(tracks[i], dims), i * TEMPO_KEY_D);
  }
  const skipAt = opts.skipPid
    ? tracks.findIndex((track) => track.pid === opts.skipPid)
    : -1;
  const placement = placeVector(
    tempoKeyVector(query, dims),
    rows,
    TEMPO_KEY_D,
    coords,
    PROJECTION_NEIGHBORS,
    1,
    skipAt >= 0 ? skipAt : undefined
  );
  if (!placement) return null;
  const transferred = transferLabels(placement.neighbors, clusters, tracks);
  return {
    x: placement.x,
    y: placement.y,
    clusterId: transferred.clusterId ?? 0,
    neighborIndexes: placement.neighbors.map((nb) => nb.index),
  };
}
