/// <reference lib="webworker" />
import { UMAP } from "umap-js";
import { reduceDims } from "../features/svd";
import { kmeans } from "./kmeans";
import { mulberry32 } from "../util/rng";

/**
 * Embedding worker (§6): SVD to ~50 dims, seeded UMAP to 2D, seeded k-means
 * on the 2D result. Posts progress during UMAP epochs.
 */

export type EmbedRequest = {
  data: Float32Array;
  n: number;
  d: number;
  seed?: number;
  nNeighbors?: number;
  minDist?: number;
};

export type EmbedResponse =
  | { type: "progress"; epoch: number; totalEpochs: number }
  | { type: "done"; coords: Float32Array; clusters: Int32Array; elapsedMs: number }
  | { type: "error"; message: string };

self.onmessage = async (e: MessageEvent<EmbedRequest>) => {
  const started = performance.now();
  try {
    const { n, seed = 42, nNeighbors = 15, minDist = 0.1 } = e.data;
    const reduced = reduceDims(e.data.data, n, e.data.d, 50);

    const rows: number[][] = new Array(n);
    for (let i = 0; i < n; i++) {
      rows[i] = Array.from(reduced.data.subarray(i * reduced.d, (i + 1) * reduced.d));
    }

    const rand = mulberry32(seed);
    const umap = new UMAP({
      nComponents: 2,
      nNeighbors: Math.min(nNeighbors, Math.max(2, n - 1)),
      minDist,
      random: rand,
    });

    const nEpochs = umap.initializeFit(rows);
    for (let epoch = 0; epoch < nEpochs; epoch++) {
      umap.step();
      if (epoch % 25 === 0) {
        post({ type: "progress", epoch, totalEpochs: nEpochs });
      }
    }
    const embedding = umap.getEmbedding();

    const coords = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      coords[i * 2] = embedding[i][0];
      coords[i * 2 + 1] = embedding[i][1];
    }

    const k = Math.max(4, Math.min(24, Math.round(Math.sqrt(n) / 4)));
    const clusters = kmeans(coords, n, k, seed);

    post(
      { type: "done", coords, clusters, elapsedMs: performance.now() - started },
      [coords.buffer, clusters.buffer]
    );
  } catch (err) {
    post({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};

function post(msg: EmbedResponse, transfer: Transferable[] = []) {
  (self as unknown as Worker).postMessage(msg, transfer);
}
