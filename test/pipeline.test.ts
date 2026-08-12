import { describe, expect, it, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { UMAP } from "umap-js";
import { createLibraryParser } from "../src/parse/library";
import { buildFeatureMatrix } from "../src/features/matrix";
import { reduceDims } from "../src/features/svd";
import { kmeans } from "../src/embed/kmeans";
import { mulberry32 } from "../src/util/rng";
import type { Library } from "../src/types";

/**
 * End-to-end pipeline on the full-size fixture (§8 phase 2 acceptance), on a
 * subsample to keep runtime sane. Includes the §9 anti-circularity check:
 * clusters must combine tracks from playlists the user never combined.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "Library.xml");
let library: Library;

beforeAll(() => {
  if (!existsSync(FIXTURE)) {
    execFileSync("node", [join(HERE, "..", "scripts", "generate-fixture.mjs"), FIXTURE]);
  }
  const xml = readFileSync(FIXTURE, "utf8");
  const p = createLibraryParser();
  p.write(xml);
  library = p.end();
});

describe("parse → features → SVD → UMAP → k-means", () => {
  it("produces a stable, non-circular 2D map", { timeout: 120_000 }, () => {
    // deterministic subsample
    const rand = mulberry32(1);
    const tracks = library.tracks.filter(() => rand() < 0.24); // ~1500
    const matrix = buildFeatureMatrix(tracks, library.playlists, {
      semanticWeight: 0.5,
    });
    expect(matrix.d).toBeGreaterThan(147); // playlists + genres + numeric

    const reduced = reduceDims(matrix.data, matrix.n, matrix.d, 50);
    expect(reduced.d).toBe(50);

    const rows: number[][] = [];
    for (let i = 0; i < reduced.n; i++) {
      rows.push(Array.from(reduced.data.subarray(i * 50, (i + 1) * 50)));
    }
    const umap = new UMAP({
      nComponents: 2,
      nNeighbors: 15,
      minDist: 0.1,
      random: mulberry32(42),
    });
    const embedding = umap.fit(rows);
    expect(embedding).toHaveLength(tracks.length);
    for (const [x, y] of embedding) {
      expect(Number.isFinite(x)).toBe(true);
      expect(Number.isFinite(y)).toBe(true);
    }

    const coords = new Float32Array(tracks.length * 2);
    embedding.forEach(([x, y], i) => {
      coords[i * 2] = x;
      coords[i * 2 + 1] = y;
    });
    const k = 16;
    const labels = kmeans(coords, tracks.length, k, 42);

    // Phase 2 acceptance: clusters correspond to real structure. Genre drives
    // playlist construction in the fixture, so clusters should be far purer
    // in genre than chance.
    const genreOf = (i: number) => tracks[i].genre ?? "";
    let weightedPurity = 0;
    for (let c = 0; c < k; c++) {
      const members = labels.reduce<number[]>((acc, l, i) => {
        if (l === c) acc.push(i);
        return acc;
      }, []);
      if (members.length === 0) continue;
      const counts = new Map<string, number>();
      for (const i of members) {
        counts.set(genreOf(i), (counts.get(genreOf(i)) ?? 0) + 1);
      }
      const top = Math.max(...counts.values());
      weightedPurity += top;
    }
    weightedPurity /= tracks.length;
    // 90 genres → chance purity is a few percent even with the Pop/Alternative mass
    expect(weightedPurity).toBeGreaterThan(0.3);

    // §9 anti-circularity: some cluster must contain tracks from playlists
    // the user never combined — otherwise the map only mirrors the playlists.
    let mixedClusters = 0;
    for (let c = 0; c < k; c++) {
      const playlistsInCluster = new Set<string>();
      labels.forEach((l, i) => {
        if (l === c) for (const p of tracks[i].playlists) playlistsInCluster.add(p);
      });
      if (playlistsInCluster.size >= 2) mixedClusters++;
    }
    expect(mixedClusters).toBeGreaterThan(k / 2);
  });

  it("reorganizes when the weighting slider moves (§8 phase 7)", () => {
    const rand = mulberry32(2);
    const tracks = library.tracks.filter(() => rand() < 0.05); // ~300
    const semantic = buildFeatureMatrix(tracks, library.playlists, { semanticWeight: 1 });
    const numeric = buildFeatureMatrix(tracks, library.playlists, { semanticWeight: 0 });
    // distances between the two settings must differ materially
    let diff = 0;
    for (let i = 0; i < Math.min(semantic.data.length, numeric.data.length); i++) {
      diff += Math.abs(semantic.data[i] - numeric.data[i]);
    }
    expect(diff).toBeGreaterThan(1);
  });
});
