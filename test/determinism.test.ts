import { describe, expect, it } from "vitest";
import { UMAP } from "umap-js";
import { buildFeatureMatrix } from "../src/features/matrix";
import { reduceDims } from "../src/features/svd";
import { kmeans } from "../src/embed/kmeans";
import { mulberry32 } from "../src/util/rng";
import type { Playlist, Track } from "../src/types";

/**
 * Where the "same inputs, same map" guarantee starts and stops.
 *
 * It holds inside one JavaScript engine: nothing in the pipeline reads the
 * clock, iterates a hash container in insertion-sensitive ways or touches
 * Math.random, so a rerun is bit-identical.
 *
 * It does not hold across engines, and that is a property of the language
 * rather than of this code. Math.pow, Math.exp and Math.log are
 * implementation-approximated in ECMAScript, and node and Chromium really do
 * disagree on roughly a tenth of Math.pow inputs by one unit in the last
 * place. Everything up to the UMAP layout uses only addition, multiplication
 * and Math.sqrt, which IEEE-754 pins exactly, so features, SVD, the k-nearest
 * neighbour graph and the seeded initial positions come out the same
 * everywhere. The layout optimizer then calls Math.pow twice per edge per
 * epoch and feeds the result back into the positions it is fitting, so a
 * one-ulp disagreement compounds over 500 epochs into a visibly different map.
 *
 * The second test pins that boundary by perturbing Math.pow by exactly one
 * ulp, which is the largest disagreement an engine can plausibly have. If a
 * future change moves work across the line, one of these two tests breaks.
 */

const GENRES = ["Tech House", "Deep House", "UK Garage", "Disco", "Techno", "Trance"];
const ARTISTS = ["Wax Motif", "Sammy Virji", "Chris Lake", "Fisher", "Kolter", "Rossi"];

/** A library that exercises every feature block, laid out the same way each run. */
function fixture(): { tracks: Track[]; playlists: Playlist[] } {
  const rand = mulberry32(7);
  const tracks: Track[] = Array.from({ length: 150 }, (_, i) => ({
    pid: `p${i}`,
    trackId: i,
    name: `Track ${i}`,
    artist: ARTISTS[i % ARTISTS.length],
    genre: GENRES[i % GENRES.length],
    durationMs: 180_000 + Math.round(rand() * 120_000),
    bpm: 120 + Math.round(rand() * 20),
    key: "8A",
    year: 2015 + (i % 8),
    playlists: [`Crate ${i % 5}`],
  }));
  const playlists: Playlist[] = Array.from({ length: 5 }, (_, p) => ({
    name: `Crate ${p}`,
    pids: tracks.filter((_, i) => i % 5 === p).map((t) => t.pid),
  }));
  return { tracks, playlists };
}

const SEED = 42;

/** The embed worker's pipeline, stopping at each stage so a diff can be placed. */
function pipeline(tracks: Track[], playlists: Playlist[]) {
  const matrix = buildFeatureMatrix(tracks, playlists, { semanticWeight: 0.5, timbreWeight: 0 });
  const reduced = reduceDims(matrix.data, matrix.n, matrix.d, 50);
  const rows: number[][] = [];
  for (let i = 0; i < reduced.n; i++) {
    rows.push(Array.from(reduced.data.subarray(i * reduced.d, (i + 1) * reduced.d)));
  }

  const umap = new UMAP({
    nComponents: 2,
    nNeighbors: 15,
    minDist: 0.1,
    random: mulberry32(SEED),
  });
  const epochs = umap.initializeFit(rows);
  // Drawn from the seeded stream after the neighbour graph has consumed its
  // share of it, so matching here means the graph matched too.
  const initial = umap.getEmbedding().map((p) => [...p]);
  for (let e = 0; e < epochs; e++) umap.step();

  const embedding = umap.getEmbedding();
  const coords = new Float32Array(matrix.n * 2);
  for (let i = 0; i < matrix.n; i++) {
    coords[i * 2] = embedding[i][0];
    coords[i * 2 + 1] = embedding[i][1];
  }
  const clusters = kmeans(coords, matrix.n, 8, SEED);
  return { matrix, reduced, initial, coords, clusters };
}

/** The next representable double, the smallest disagreement two engines can have. */
function oneUlpUp(x: number): number {
  if (!Number.isFinite(x) || x === 0) return x;
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  view.setBigUint64(0, view.getBigUint64(0) + 1n);
  return view.getFloat64(0);
}

describe("embedding reproducibility", () => {
  it("gives a bit-identical map when rerun with the same seed", { timeout: 60_000 }, () => {
    const { tracks, playlists } = fixture();
    const a = pipeline(tracks, playlists);
    const b = pipeline(tracks, playlists);

    expect(b.matrix.data).toEqual(a.matrix.data);
    expect(b.reduced.data).toEqual(a.reduced.data);
    expect(b.initial).toEqual(a.initial);
    expect(b.coords).toEqual(a.coords);
    expect(b.clusters).toEqual(a.clusters);
  });

  it("survives a one-ulp Math.pow up to the layout, and not past it", { timeout: 60_000 }, () => {
    const { tracks, playlists } = fixture();
    const base = pipeline(tracks, playlists);

    const realPow = Math.pow;
    let perturbed;
    try {
      Math.pow = (x: number, y: number) => oneUlpUp(realPow(x, y));
      perturbed = pipeline(tracks, playlists);
    } finally {
      Math.pow = realPow;
    }

    // Exactly-rounded arithmetic only: an engine cannot move these.
    expect(perturbed.matrix.data).toEqual(base.matrix.data);
    expect(perturbed.reduced.data).toEqual(base.reduced.data);
    expect(perturbed.initial).toEqual(base.initial);

    // The optimizer compounds it, which is why an offline run of this pipeline
    // cannot be expected to reproduce the browser's coordinates.
    expect(perturbed.coords).not.toEqual(base.coords);
  });
});
