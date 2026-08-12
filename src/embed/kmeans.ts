import { mulberry32 } from "../util/rng";

/** Seeded k-means++ on the 2D embedding (§6 — no solid HDBSCAN port in JS). */
export function kmeans(
  points: Float32Array, // n × 2
  n: number,
  k: number,
  seed = 42,
  iterations = 60
): Int32Array {
  const rand = mulberry32(seed);
  k = Math.min(k, n);
  const centroids = new Float64Array(k * 2);

  // k-means++ init
  const first = Math.floor(rand() * n);
  centroids[0] = points[first * 2];
  centroids[1] = points[first * 2 + 1];
  const distSq = new Float64Array(n).fill(Infinity);
  for (let c = 1; c < k; c++) {
    let total = 0;
    for (let i = 0; i < n; i++) {
      const dx = points[i * 2] - centroids[(c - 1) * 2];
      const dy = points[i * 2 + 1] - centroids[(c - 1) * 2 + 1];
      const dd = dx * dx + dy * dy;
      if (dd < distSq[i]) distSq[i] = dd;
      total += distSq[i];
    }
    let target = rand() * total;
    let chosen = n - 1;
    for (let i = 0; i < n; i++) {
      target -= distSq[i];
      if (target <= 0) {
        chosen = i;
        break;
      }
    }
    centroids[c * 2] = points[chosen * 2];
    centroids[c * 2 + 1] = points[chosen * 2 + 1];
  }

  const labels = new Int32Array(n);
  const counts = new Float64Array(k);
  const sums = new Float64Array(k * 2);

  for (let it = 0; it < iterations; it++) {
    let moved = false;
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < k; c++) {
        const dx = points[i * 2] - centroids[c * 2];
        const dy = points[i * 2 + 1] - centroids[c * 2 + 1];
        const dd = dx * dx + dy * dy;
        if (dd < bestD) {
          bestD = dd;
          best = c;
        }
      }
      if (labels[i] !== best) {
        labels[i] = best;
        moved = true;
      }
    }
    if (!moved && it > 0) break;
    counts.fill(0);
    sums.fill(0);
    for (let i = 0; i < n; i++) {
      const c = labels[i];
      counts[c]++;
      sums[c * 2] += points[i * 2];
      sums[c * 2 + 1] += points[i * 2 + 1];
    }
    for (let c = 0; c < k; c++) {
      if (counts[c] > 0) {
        centroids[c * 2] = sums[c * 2] / counts[c];
        centroids[c * 2 + 1] = sums[c * 2 + 1] / counts[c];
      }
    }
  }
  return labels;
}
