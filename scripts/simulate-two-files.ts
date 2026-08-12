/**
 * What it is actually like to load two collections together.
 *
 * Runs the real pipeline the browser runs — parse, union, feature matrix, SVD,
 * UMAP, k-means — on two collections and reports the things that decide
 * whether the shared map is worth looking at:
 *
 * - how much the two overlap, if at all
 * - BPM/key coverage per collection, and how many tracks lookups would target
 * - whether the two interleave in the map or separate into two islands
 *
 * The last one is the load-bearing measurement. Playlist membership is a
 * per-collection fact — no track in A is ever in a playlist from B — so the
 * playlist block can separate the two on provenance alone and present that as a
 * musical finding. This script measures the separation instead of assuming
 * either way, by asking what fraction of each track's nearest neighbours come
 * from its own collection and comparing that against the fraction expected if
 * the two were fully mixed.
 *
 * Playlists turn out not to be the only such channel, so the separation is then
 * re-measured with each suspect block held out. On two rekordbox exports the
 * playlist block is in fact narrow (31 of 334 columns, against 200 for tags),
 * and what actually split them was BPM/key coverage: a track with no BPM sits
 * at the block mean, so a collection that was never analyzed occupies its own
 * region of even a purely numeric space.
 *
 * Which makes the two-rekordbox pairing unable to answer the question it was
 * asked, because one of those exports has BPM for 9.7% of its tracks. Hence the
 * second scenario: the same measurement against only the part of an Apple
 * library that GetSongBPM resolved, where both sides carry real tempo and key
 * and any separation left is a statement about the music.
 *
 * Raw purity does not survive that change of scenario — the fully-mixed
 * baseline is the sum of squared collection shares, so it climbs with size
 * imbalance and a 310-vs-1057 pairing starts from ~0.65 rather than ~0.50.
 * Only the separation index, which normalizes between the baseline and 1, is
 * comparable across scenarios; a seeded size-matched subsample of the larger
 * collection is measured too, so that imbalance can be ruled out directly.
 *
 * Run:
 *   npx vite-node scripts/simulate-two-files.ts
 *   npx vite-node scripts/simulate-two-files.ts -- --scenario=analyzed
 *   npx vite-node scripts/simulate-two-files.ts -- --scenario=analyzed --emit=out.json
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { UMAP } from "umap-js";
import { parseRekordbox } from "../src/parse/rekordbox";
import { createLibraryParser } from "../src/parse/library";
import { mergeLibraries, tagCollection } from "../src/collections/merge";
import { collectionCoverage, describeOutstanding, needsLookup } from "../src/collections/coverage";
import { buildFeatureMatrix } from "../src/features/matrix";
import type { FeatureBlock, MatrixOptions } from "../src/features/matrix";
import { reduceDims } from "../src/features/svd";
import { kmeans } from "../src/embed/kmeans";
import { mulberry32 } from "../src/util/rng";
import { makeBpmScale, bpmBinLabel, bpmBin } from "../src/render/palette";
import { buildAnalyzedAppleSubset, describeAudit, restrictLibrary } from "./analyzed-subset";
import type { CollectionMeta, Library } from "../src/types";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "..", "test", "fixtures");
const SEED = 42;
const K = 15;
const CLUSTERS = 12;

type Loaded = {
  library: Library;
  format: "rekordbox" | "apple";
  /** Extra lines to print under the source header, e.g. a subset's audit. */
  notes?: string[];
};

type CollectionSource = {
  label: string;
  describe: string;
  load: () => Loaded;
};

type Scenario = {
  title: string;
  sources: [CollectionSource, CollectionSource];
  /**
   * Also embed a seeded, size-matched subsample of the larger collection, so
   * that a high separation index cannot be blamed on unequal sizes.
   */
  sizeMatchedControl?: boolean;
};

function parseAny(xml: string): Loaded {
  if (xml.slice(0, 4096).includes("DJ_PLAYLISTS")) {
    const { stats, ...lib } = parseRekordbox(xml);
    void stats;
    return { library: lib, format: "rekordbox" };
  }
  const p = createLibraryParser();
  p.write(xml);
  return { library: p.end(), format: "apple" };
}

function xmlSource(file: string, label: string): CollectionSource {
  return {
    label,
    describe: file,
    load: () => parseAny(readFileSync(join(FIXTURES, file), "utf8")),
  };
}

const appleAnalyzed: CollectionSource = {
  label: "apple_getsongbpm",
  describe: "apple_library.xml, restricted to trustworthy GetSongBPM matches",
  load: () => {
    const { library, audit } = buildAnalyzedAppleSubset(
      join(FIXTURES, "apple_library.xml"),
      join(FIXTURES, "getsongbpm-results.json")
    );
    return { library, format: "apple", notes: describeAudit(audit) };
  },
};

const SCENARIOS: Record<string, Scenario> = {
  "two-rekordbox": {
    title: "two rekordbox exports, one of them barely analyzed",
    sources: [
      xmlSource("skylar_songs.xml", "skylar_songs"),
      xmlSource("Adryft_recordbox_collection_metadata.xml", "Adryft_rekordbox"),
    ],
  },
  analyzed: {
    title: "a rekordbox crate against the analyzed part of an Apple library",
    sources: [
      xmlSource("Adryft_recordbox_collection_metadata.xml", "Adryft_rekordbox"),
      appleAnalyzed,
    ],
    sizeMatchedControl: true,
  },
};

function arg(name: string, dflt: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
}

const scenarioName = arg("scenario", "two-rekordbox");
const scenario = SCENARIOS[scenarioName];
if (!scenario) {
  console.error(
    `unknown --scenario=${scenarioName}; try ${Object.keys(SCENARIOS).join(" | ")}`
  );
  process.exit(1);
}

function meta(label: string, format: "rekordbox" | "apple", n: number): CollectionMeta {
  return {
    id: label.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    label,
    format,
    trackCount: n,
    addedAt: new Date().toISOString(),
  };
}

function pct(a: number, b: number): string {
  return b === 0 ? "n/a" : `${((a / b) * 100).toFixed(1)}%`;
}

/** Fisher-Yates with the app's seeded PRNG, so a subsample is reproducible. */
function sample<T>(items: readonly T[], n: number, seed: number): T[] {
  const rnd = mulberry32(seed);
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, Math.min(n, a.length));
}

// ---------- load and union ----------

console.log("=".repeat(72));
console.log(`TWO-COLLECTION IMPORT SIMULATION — ${scenarioName}`);
console.log(scenario.title);
console.log("=".repeat(72));

let library: Library | null = null;
for (const spec of scenario.sources) {
  const { library: parsed, format, notes } = spec.load();
  const tagged = tagCollection(parsed, meta(spec.label, format, parsed.tracks.length));
  console.log(
    `\n${spec.describe}\n  format=${format}  tracks=${parsed.tracks.length}  playlists=${parsed.playlists.length}`
  );
  for (const line of notes ?? []) console.log(`  ${line}`);
  if (library === null) {
    library = tagged;
  } else {
    const { library: merged, report } = mergeLibraries(library, tagged);
    console.log(
      `  union: +${report.added} added, ${report.duplicatePids} already present, ` +
        `${report.renamedPlaylists.length} playlist names de-duplicated`
    );
    library = merged;
  }
}
const lib = library!;
console.log(
  `\nCombined: ${lib.tracks.length} tracks, ${lib.playlists.length} playlists, ` +
    `${lib.collections!.length} collections`
);

// ---------- coverage, and what lookups would target ----------

console.log("\n" + "-".repeat(72));
console.log("COVERAGE PER COLLECTION");
console.log("-".repeat(72));
const rows = collectionCoverage(lib);
for (const r of rows) {
  console.log(
    `\n${r.label}  (${r.format}, ${r.total} tracks)\n` +
      `  BPM ${pct(r.bpm, r.total).padStart(6)}   key ${pct(r.key, r.total).padStart(6)}` +
      `   sound ${pct(r.sound, r.total).padStart(6)}   preview ${pct(r.preview, r.total).padStart(6)}\n` +
      `  missing BPM or key: ${r.incomplete}`
  );
}
console.log(
  `\nper-collection totals sum to ${rows.reduce((s, r) => s + r.total, 0)} of ${lib.tracks.length} tracks`
);
const pooled = {
  bpm: lib.tracks.filter((t) => t.bpm).length,
  key: lib.tracks.filter((t) => t.key).length,
};
console.log(
  `Pooled over both: BPM ${pct(pooled.bpm, lib.tracks.length)}, key ${pct(pooled.key, lib.tracks.length)}`
);
console.log(`Lookup queue would hold: ${lib.tracks.filter(needsLookup).length} tracks`);
console.log(`Scope line shown in the UI:\n  "${describeOutstanding(rows)}"`);

// ---------- BPM distribution, which drives the adaptive colour scale ----------

console.log("\n" + "-".repeat(72));
console.log("BPM DISTRIBUTION");
console.log("-".repeat(72));
const bpms = lib.tracks.map((t) => t.bpm).filter((b): b is number => !!b);
const scale = makeBpmScale(bpms);
const sorted = [...bpms].sort((a, b) => a - b);
console.log(
  `n=${bpms.length}  min=${sorted[0]?.toFixed(1)}  ` +
    `median=${sorted[Math.floor(sorted.length / 2)]?.toFixed(1)}  max=${sorted.at(-1)?.toFixed(1)}`
);
console.log(`adaptive scale: width=${scale.width} bins=${scale.count} from ${scale.start}`);
const binCounts = new Map<number, number>();
for (const b of bpms) {
  const i = bpmBin(b, scale);
  binCounts.set(i, (binCounts.get(i) ?? 0) + 1);
}
for (const [i, c] of [...binCounts.entries()].sort((a, b) => a[0] - b[0])) {
  const bar = "#".repeat(Math.max(1, Math.round((c / bpms.length) * 60)));
  console.log(`  ${bpmBinLabel(i, scale).padEnd(12)} ${String(c).padStart(5)} ${bar}`);
}
// Per collection as well as pooled: two collections can share a median and
// still be nothing alike, because a crate built to be mixed is a tempo
// monoculture and a listening library is not. The share within ±5 BPM of the
// collection's own median is what the numeric block sees of that difference.
for (const id of lib.collections!.map((c) => c.id)) {
  const s = lib.tracks
    .filter((t) => t.collection === id && t.bpm)
    .map((t) => t.bpm!)
    .sort((a, b) => a - b);
  const median = s[Math.floor(s.length / 2)];
  const near = s.filter((b) => Math.abs(b - median) <= 5).length;
  console.log(
    `  ${id.padEnd(20)} n=${String(s.length).padStart(5)}  ` +
      `p25=${s[Math.floor(s.length * 0.25)]?.toFixed(0)}  median=${median?.toFixed(0)}  ` +
      `p75=${s[Math.floor(s.length * 0.75)]?.toFixed(0)}  within ±5 of median: ${pct(near, s.length)}`
  );
}

// ---------- embed the union ----------

/** One full pass of the browser pipeline, so a block can be ablated out. */
function embed(target: Library, opts: MatrixOptions): { coords: Float32Array; n: number; d: number } {
  const matrix = buildFeatureMatrix(target.tracks, target.playlists, opts);
  const reduced = reduceDims(matrix.data, matrix.n, matrix.d, 50);
  const rows: number[][] = [];
  for (let i = 0; i < reduced.n; i++)
    rows.push(Array.from(reduced.data.subarray(i * reduced.d, (i + 1) * reduced.d)));
  const umap = new UMAP({
    nComponents: 2,
    nNeighbors: 15,
    minDist: 0.1,
    random: mulberry32(SEED),
  });
  const xy = umap.fit(rows);
  const coords = new Float32Array(xy.length * 2);
  for (let i = 0; i < xy.length; i++) {
    coords[i * 2] = xy[i][0];
    coords[i * 2 + 1] = xy[i][1];
  }
  return { coords, n: xy.length, d: matrix.d };
}

/**
 * Provenance as a row-indexed label, plus the purity a fully mixed map would
 * show: if provenance carried no information a neighbourhood would look like
 * the library as a whole, which is the sum of squared collection shares. That
 * baseline rises with size imbalance on its own, so it is reported alongside
 * every purity figure rather than assumed.
 */
function provenance(target: Library): { ids: string[]; own: Int32Array; chance: number } {
  const ids = target.collections!.map((c) => c.id);
  const own = new Int32Array(target.tracks.length);
  target.tracks.forEach((t, i) => (own[i] = ids.indexOf(t.collection!)));
  const chance = ids.reduce((s, _, k) => {
    const share = own.reduce((n, o) => n + (o === k ? 1 : 0), 0) / own.length;
    return s + share * share;
  }, 0);
  return { ids, own, chance };
}

/**
 * Exact k-NN in the 2D embedding, still brute force over every pair, but the
 * per-row candidates go through a bounded max-heap of size k instead of an
 * array that gets fully sorted. Same neighbours — the heap is a selection, not
 * an approximation — at O(n·k) work and zero allocation per row, where sorting
 * every row cost O(n log n) and an object per pair. On a few thousand tracks
 * that is the difference between minutes and milliseconds.
 *
 * Only the neighbour's collection index is retained, since the statistic never
 * asks which track a neighbour was.
 */
function neighbourPurity(coords: Float32Array, n: number, own: Int32Array): number {
  const heapDist = new Float64Array(K);
  const heapOwn = new Int32Array(K);
  let total = 0;

  for (let i = 0; i < n; i++) {
    const xi = coords[i * 2];
    const yi = coords[i * 2 + 1];
    let size = 0;

    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const dx = xi - coords[j * 2];
      const dy = yi - coords[j * 2 + 1];
      const dist = dx * dx + dy * dy;

      if (size < K) {
        let c = size++;
        heapDist[c] = dist;
        heapOwn[c] = own[j];
        while (c > 0) {
          const p = (c - 1) >> 1;
          if (heapDist[p] >= heapDist[c]) break;
          const td = heapDist[p]; heapDist[p] = heapDist[c]; heapDist[c] = td;
          const to = heapOwn[p]; heapOwn[p] = heapOwn[c]; heapOwn[c] = to;
          c = p;
        }
      } else if (dist < heapDist[0]) {
        // Root holds the current k-th best, so it is the only one worth evicting.
        heapDist[0] = dist;
        heapOwn[0] = own[j];
        for (let p = 0; ; ) {
          const l = 2 * p + 1;
          const r = l + 1;
          let m = p;
          if (l < size && heapDist[l] > heapDist[m]) m = l;
          if (r < size && heapDist[r] > heapDist[m]) m = r;
          if (m === p) break;
          const td = heapDist[p]; heapDist[p] = heapDist[m]; heapDist[m] = td;
          const to = heapOwn[p]; heapOwn[p] = heapOwn[m]; heapOwn[m] = to;
          p = m;
        }
      }
    }

    if (size === 0) continue;
    let same = 0;
    for (let s = 0; s < size; s++) if (heapOwn[s] === own[i]) same++;
    total += same / size;
  }
  return n === 0 ? 0 : total / n;
}

console.log("\n" + "-".repeat(72));
console.log("SHARED EMBEDDING");
console.log("-".repeat(72));

const { ids, own, chance } = provenance(lib);
const separation = (p: number) => (p - chance) / (1 - chance);

const t0 = Date.now();
const { coords, n, d } = embed(lib, { semanticWeight: 0.5 });
const assignments = kmeans(coords, n, CLUSTERS, SEED);
console.log(`feature matrix ${n} x ${d} → 50 dims → 2D: ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// ---------- do the two collections interleave, or split into islands? ----------

const tKnn = Date.now();
const purity = neighbourPurity(coords, n, own);
console.log(`exact ${K}-NN over ${n} tracks in ${Date.now() - tKnn}ms`);

console.log(
  `\nneighbour purity (k=${K}): ${(purity * 100).toFixed(1)}%` +
    `  |  fully mixed would be ${(chance * 100).toFixed(1)}%` +
    `  |  fully separated would be 100%`
);
console.log(
  `separation index: ${(separation(purity) * 100).toFixed(1)}% of the way from mixed to two islands`
);

// ---------- hand the coordinates to whatever draws the picture ----------

/**
 * The embedding behind the numbers just printed, written out so figures come
 * from this run rather than from a second one that would only coincidentally
 * agree with it. Provenance is stored as an index into `collections` because
 * the ids repeat on every one of a few thousand rows.
 *
 * Row order is the union's track order throughout — `coords`, `assignments`
 * and `own` are all indexed by it — so a point carries its own metadata and no
 * join is needed downstream.
 */
const emitPath = arg("emit", "");
if (emitPath) {
  const dump = {
    scenario: scenarioName,
    title: scenario.title,
    seed: SEED,
    knn: K,
    clusterCount: CLUSTERS,
    collections: lib.collections!.map((c) => ({
      id: c.id,
      label: c.label,
      format: c.format,
      trackCount: c.trackCount,
    })),
    separation: { purity, fullyMixed: chance, index: separation(purity) },
    points: lib.tracks.map((t, i) => ({
      x: coords[i * 2],
      y: coords[i * 2 + 1],
      collection: own[i],
      cluster: assignments[i],
      bpm: t.bpm ?? null,
      key: t.key ?? null,
      genre: t.genre ?? null,
      artist: t.artist ?? null,
      title: t.name,
    })),
  };
  const target = resolve(emitPath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(dump));
  console.log(`\nembedding written to ${target}  (${dump.points.length} points)`);
}

/**
 * A high separation index does not by itself say whether the two collections
 * are musically different or only differently filed, so the blocks that could
 * be carrying provenance get held out one group at a time.
 *
 * Playlists are the pure case — membership never crosses collections — but
 * they are not the only one: label and remixer tags track which store a crate
 * was built from, and genre vocabularies differ by exporter. The numeric block
 * has a subtler version of the same problem, because a track with no BPM sits
 * at the block mean, so "unanalyzed" is itself a position in the space and
 * separates two collections whenever their coverage differs.
 */
const ablations: [string, FeatureBlock[]][] = [
  ["no playlists", ["playlists"]],
  ["no playlists, no tags", ["playlists", "tags"]],
  ["numeric only", ["playlists", "tags", "genre"]],
];
console.log("\nseparation with feature blocks held out:");
for (const [label, exclude] of ablations) {
  const e = embed(lib, { semanticWeight: 0.5, exclude });
  const p = neighbourPurity(e.coords, e.n, own);
  console.log(
    `  ${label.padEnd(22)} d=${String(e.d).padStart(3)}` +
      `   purity ${(p * 100).toFixed(1).padStart(5)}%` +
      `   separation ${(separation(p) * 100).toFixed(1).padStart(5)}%`
  );
}

// ---------- is the separation index just reading size imbalance? ----------

if (scenario.sizeMatchedControl) {
  const sizes = ids.map((_, k) => own.reduce((s, o) => s + (o === k ? 1 : 0), 0));
  const smaller = sizes.indexOf(Math.min(...sizes));
  const larger = 1 - smaller;
  const target = sizes[smaller];
  const keep = new Set<string>([
    ...lib.tracks.filter((t) => t.collection === ids[smaller]).map((t) => t.pid),
    ...sample(
      lib.tracks.filter((t) => t.collection === ids[larger]).map((t) => t.pid),
      target,
      SEED
    ),
  ]);
  const balanced = restrictLibrary(lib, keep);
  const bp = provenance(balanced);
  const e = embed(balanced, { semanticWeight: 0.5 });
  const p = neighbourPurity(e.coords, e.n, bp.own);
  const sep = (p - bp.chance) / (1 - bp.chance);
  console.log(
    `\nsize-matched control: ${ids[larger]} subsampled to ${target} (seed ${SEED}), ` +
      `${balanced.tracks.length} tracks total`
  );
  console.log(
    `  purity ${(p * 100).toFixed(1)}%  |  fully mixed ${(bp.chance * 100).toFixed(1)}%` +
      `  |  separation ${(sep * 100).toFixed(1)}%`
  );
}

// ---------- where the two meet ----------

console.log("\nper-cluster composition (cluster: total, then share by collection):");
const clusterCounts = new Map<number, number[]>();
const clusterRows = new Map<number, number[]>();
for (let i = 0; i < assignments.length; i++) {
  const c = assignments[i];
  if (!clusterCounts.has(c)) {
    clusterCounts.set(c, ids.map(() => 0));
    clusterRows.set(c, []);
  }
  clusterCounts.get(c)![own[i]]++;
  clusterRows.get(c)!.push(i);
}
const mixed: number[] = [];
for (const [c, counts] of [...clusterCounts.entries()].sort((a, b) => a[0] - b[0])) {
  const total = counts.reduce((s, x) => s + x, 0);
  const parts = counts.map((x, k) => `${ids[k]} ${pct(x, total)}`).join("  ");
  if (Math.min(...counts) / total > 0.1) mixed.push(c);
  console.log(`  ${String(c).padStart(2)}: ${String(total).padStart(5)}   ${parts}`);
}
console.log(
  `\ncluster totals sum to ${[...clusterCounts.values()]
    .flat()
    .reduce((s, x) => s + x, 0)} of ${n} tracks`
);
console.log(`${mixed.length} of ${clusterCounts.size} clusters draw at least 10% from both`);

if (mixed.length > 0) {
  console.log("\nwhat the shared territory holds:");
  for (const c of mixed.sort(
    (a, b) => clusterRows.get(b)!.length - clusterRows.get(a)!.length
  )) {
    const rowsIn = clusterRows.get(c)!;
    const tracks = rowsIn.map((i) => lib.tracks[i]);
    const b = tracks.map((t) => t.bpm).filter((x): x is number => !!x).sort((x, y) => x - y);
    const genres = new Map<string, number>();
    for (const t of tracks) if (t.genre) genres.set(t.genre, (genres.get(t.genre) ?? 0) + 1);
    const top = [...genres.entries()].sort((x, y) => y[1] - x[1]).slice(0, 4);
    console.log(
      `  cluster ${c} (${rowsIn.length} tracks): median BPM ${b[Math.floor(b.length / 2)]?.toFixed(0) ?? "-"}` +
        `, genres ${top.map(([g, k]) => `${g} (${k})`).join(", ") || "none"}`
    );
    for (let k = 0; k < ids.length; k++) {
      const example = tracks.find((t) => t.collection === ids[k]);
      if (example)
        console.log(
          `    ${ids[k]}: ${example.artist ?? "?"} — ${example.name} ` +
            `[${example.key ?? "?"} ${example.bpm?.toFixed(0) ?? "?"}]`
        );
    }
  }
}

// ---------- what the collections share musically ----------

console.log("\n" + "-".repeat(72));
console.log("MUSICAL OVERLAP");
console.log("-".repeat(72));
function topGenres(collection: string, count = 8): [string, number][] {
  const counts = new Map<string, number>();
  for (const t of lib.tracks)
    if (t.collection === collection && t.genre)
      counts.set(t.genre, (counts.get(t.genre) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, count);
}
const genreSets = ids.map((id) => new Set(topGenres(id, 1000).map(([g]) => g)));
for (const id of ids) {
  console.log(`\n${id} top genres: ${topGenres(id).map(([g, c]) => `${g} (${c})`).join(", ")}`);
}
const sharedGenres = [...genreSets[0]].filter((g) => genreSets[1]?.has(g));
console.log(
  `\ngenres in common: ${sharedGenres.length} of ${genreSets[0].size} and ${genreSets[1]?.size}` +
    (sharedGenres.length ? ` — ${sharedGenres.slice(0, 12).join(", ")}` : "")
);

const artistsOf = (id: string) =>
  new Set(
    lib.tracks
      .filter((t) => t.collection === id && t.artist)
      .map((t) => t.artist!.toLowerCase().trim())
  );
const a0 = artistsOf(ids[0]);
const a1 = artistsOf(ids[1]);
const sharedArtists = [...a0].filter((a) => a1.has(a));
console.log(
  `artists in common: ${sharedArtists.length} (of ${a0.size} and ${a1.size})` +
    (sharedArtists.length ? ` — ${sharedArtists.slice(0, 12).join(", ")}` : "")
);
console.log("");
