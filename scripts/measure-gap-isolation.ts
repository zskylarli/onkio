/**
 * What the gap thresholds actually see.
 *
 * Runs the browser's pipeline — parse, union in import order, feature matrix at
 * the default slider position, SVD, seeded UMAP, seeded k-means with the same
 * adaptive k — and prints, for every cluster, the nearest substantial cluster
 * to it and the isolation ratio between the two. The thresholds in
 * src/views/gaps.ts are ratios chosen against a distribution, so the
 * distribution is worth being able to look at rather than guess at.
 *
 * It lands on a different embedding from the running app despite the shared
 * seeds, and cannot be made not to: node and the browser disagree by one ulp on
 * some Math.pow results, which UMAP's optimizer compounds over 500 epochs (see
 * test/determinism.test.ts). Features, SVD and the neighbour graph are
 * identical here and in the browser; the layout is not, so the pairs named
 * below are not the pairs on screen. What carries over is the shape of the
 * distribution, which is what the thresholds are set against.
 * `__onkio.getState().gapDetail` is where to read the live figures.
 *
 * Run:
 *   npx vite-node scripts/measure-gap-isolation.ts
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { UMAP } from "umap-js";
import { parseRekordbox } from "../src/parse/rekordbox";
import { mergeLibraries, tagCollection } from "../src/collections/merge";
import { buildFeatureMatrix } from "../src/features/matrix";
import { reduceDims } from "../src/features/svd";
import { kmeans } from "../src/embed/kmeans";
import { mulberry32 } from "../src/util/rng";
import { summarizeClusters } from "../src/views/taste";
import {
  clusterStats,
  findGaps,
  ISOLATION_RATIO,
  MIN_CORRIDOR_SHARE,
  SUBSTANTIAL_SHARE,
} from "../src/views/gaps";
import type { CollectionMeta, Library } from "../src/types";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "..", "test", "fixtures");
const SEED = 42;

const ADRYFT = "Adryft_recordbox_collection_metadata.xml";
const SKYLAR = "skylar_songs.xml";

function load(file: string): Library {
  const { stats, ...lib } = parseRekordbox(readFileSync(join(FIXTURES, file), "utf8"));
  void stats;
  const meta: CollectionMeta = {
    id: file.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    label: file,
    format: "rekordbox",
    trackCount: lib.tracks.length,
    addedAt: new Date().toISOString(),
  };
  return tagCollection(lib, meta);
}

function embed(lib: Library): { coords: Float32Array; clusters: Int32Array } {
  const matrix = buildFeatureMatrix(lib.tracks, lib.playlists, {
    semanticWeight: 0.5,
    timbreWeight: 0,
  });
  console.log(
    `  matrix ${matrix.n} x ${matrix.d} from ${lib.tracks.length} tracks, ${lib.playlists.length} playlists`
  );
  const reduced = reduceDims(matrix.data, matrix.n, matrix.d, 50);
  const rows: number[][] = [];
  for (let i = 0; i < reduced.n; i++)
    rows.push(Array.from(reduced.data.subarray(i * reduced.d, (i + 1) * reduced.d)));
  // Stepped exactly the way src/embed/embed.worker.ts steps it: fit() consumes
  // the seeded PRNG differently and lands on a different, equally valid map,
  // which would make every number below describe an embedding nobody sees.
  const umap = new UMAP({
    nComponents: 2,
    nNeighbors: Math.min(15, Math.max(2, lib.tracks.length - 1)),
    minDist: 0.1,
    random: mulberry32(SEED),
  });
  const epochs = umap.initializeFit(rows);
  for (let e = 0; e < epochs; e++) umap.step();
  const xy = umap.getEmbedding();
  const n = xy.length;
  const coords = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    coords[i * 2] = xy[i][0];
    coords[i * 2 + 1] = xy[i][1];
  }
  const k = Math.max(4, Math.min(24, Math.round(Math.sqrt(n) / 4)));
  return { coords, clusters: kmeans(coords, n, k, SEED) };
}

function span(coords: Float32Array, n: number): number {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    minX = Math.min(minX, coords[i * 2]);
    maxX = Math.max(maxX, coords[i * 2]);
    minY = Math.min(minY, coords[i * 2 + 1]);
    maxY = Math.max(maxY, coords[i * 2 + 1]);
  }
  return Math.max(maxX - minX, maxY - minY);
}

function report(title: string, lib: Library): void {
  const n = lib.tracks.length;
  const { coords, clusters } = embed(lib);
  const stats = clusterStats(coords, clusters, n);
  const labels = new Map(summarizeClusters(lib.tracks, clusters).map((c) => [c.cluster, c.label]));
  const evenShare = n / stats.length;
  const substantial = stats.filter((c) => c.size >= evenShare * SUBSTANTIAL_SHARE);
  const layout = span(coords, n);

  console.log("\n" + "=".repeat(78));
  console.log(`${title} — ${n} tracks, ${stats.length} clusters, layout span ${layout.toFixed(1)}`);
  console.log(
    `even share ${evenShare.toFixed(0)}, substantial floor ${(evenShare * SUBSTANTIAL_SHARE).toFixed(0)} ` +
      `→ ${substantial.length} substantial, min corridor ${(layout * MIN_CORRIDOR_SHARE).toFixed(2)}`
  );
  console.log("=".repeat(78));
  console.log(
    "  size  spread  corridor  isolation  cluster → nearest substantial".padEnd(60)
  );

  // The same pairing findGaps does, kept local so the sweep below can vary the
  // ratio without rebuilding the library.
  const pairs = new Map<string, { iso: number; width: number; a: number; b: number }>();
  const rows: { iso: number; line: string }[] = [];
  for (const a of stats) {
    let b = null as (typeof stats)[number] | null;
    let centres = Infinity;
    for (const c of substantial) {
      if (c.cluster === a.cluster) continue;
      const d = Math.hypot(c.x - a.x, c.y - a.y);
      if (d < centres) { centres = d; b = c; }
    }
    if (!b) continue;
    const extent = a.spread + b.spread;
    const width = centres - extent;
    const iso = extent > 0 ? width / extent : Infinity;
    rows.push({
      iso,
      line:
        `${String(a.size).padStart(6)}  ${a.spread.toFixed(2).padStart(6)}  ` +
        `${width.toFixed(2).padStart(8)}  ${iso.toFixed(3).padStart(9)}  ` +
        `${labels.get(a.cluster)} → ${labels.get(b.cluster)}` +
        (width < layout * MIN_CORRIDOR_SHARE ? "   [under min corridor]" : ""),
    });
    if (width < layout * MIN_CORRIDOR_SHARE) continue;
    const key = a.cluster < b.cluster ? `${a.cluster}:${b.cluster}` : `${b.cluster}:${a.cluster}`;
    const seen = pairs.get(key);
    if (!seen || iso > seen.iso) pairs.set(key, { iso, width, a: a.cluster, b: b.cluster });
  }
  for (const r of rows.sort((x, y) => y.iso - x.iso)) console.log(r.line);

  console.log("\n  how many gaps each threshold would surface:");
  for (const ratio of [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.25]) {
    const kept = [...pairs.values()].filter((p) => p.iso >= ratio).sort((x, y) => y.iso - x.iso);
    console.log(
      `  ${ratio.toFixed(2)} → ${kept.length} gap(s)` +
        (kept.length
          ? `: ${kept.map((p) => `${labels.get(p.a)} | ${labels.get(p.b)} (${p.iso.toFixed(2)})`).join(" ;; ")}`
          : "")
    );
  }
  console.log(
    `\n  findGaps at the compiled threshold returns ${findGaps(coords, clusters, n, 20).length}`
  );
}

console.log(`current thresholds: ISOLATION_RATIO=${ISOLATION_RATIO} MIN_CORRIDOR_SHARE=${MIN_CORRIDOR_SHARE} SUBSTANTIAL_SHARE=${SUBSTANTIAL_SHARE}`);
const adryft = load(ADRYFT);
report("ADRYFT ALONE", adryft);
report("UNION (Adryft then skylar_songs)", mergeLibraries(adryft, load(SKYLAR)).library);
console.log("");
