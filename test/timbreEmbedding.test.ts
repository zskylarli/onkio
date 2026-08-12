import { describe, expect, it, beforeAll } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { UMAP } from "umap-js";
import { parseRekordbox } from "../src/parse/rekordbox";
import { buildFeatureMatrix } from "../src/features/matrix";
import { reduceDims } from "../src/features/svd";
import { kmeans } from "../src/embed/kmeans";
import { mulberry32 } from "../src/util/rng";
import type { Track } from "../src/types";

/**
 * The whole embedding, end to end, with timbre present for only part of the
 * library — which is the permanent condition, since a 30s preview exists for
 * roughly two thirds of a DJ crate and never for the user's own bounces.
 *
 * The failure this guards against is subtle and fatal: if unanalyzed tracks
 * are handled naively they cluster by their own absence, and the map grows a
 * meaningless "tracks we couldn't hear" island that looks exactly like a real
 * musical region.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "Adryft_recordbox_collection_metadata.xml");
const TI = 24;
const COVERAGE = 0.6;

let tracks: Track[];
let playlists: { name: string; pids: string[] }[];
let heard: Set<string>;

beforeAll(() => {
  const col = parseRekordbox(readFileSync(FIXTURE, "utf8"));
  const rand = mulberry32(3);
  // Deterministic subsample, so UMAP stays quick.
  tracks = col.tracks.filter(() => rand() < 0.3);
  playlists = col.playlists.map((p) => ({
    name: p.name,
    pids: p.pids.filter((pid) => tracks.some((t) => t.pid === pid)),
  }));

  // Structured synthetic timbre: three sonic families with real overlap, so
  // the block carries signal rather than noise, on a realistic 60% of tracks.
  heard = new Set();
  const r2 = mulberry32(11);
  for (const t of tracks) {
    if (r2() > COVERAGE) continue;
    const family = Math.floor(r2() * 3);
    const v = new Float32Array(TI);
    for (let i = 0; i < TI; i++) v[i] = family * 2 + (r2() - 0.5) * 1.5;
    t.timbre = v;
    heard.add(t.pid);
  }
});

describe.runIf(existsSync(FIXTURE))("embedding with partial timbre coverage", () => {
  it("keeps a realistic coverage split", () => {
    expect(tracks.length).toBeGreaterThan(200);
    const frac = heard.size / tracks.length;
    expect(frac).toBeGreaterThan(0.4);
    expect(frac).toBeLessThan(0.8);
  });

  it("produces a finite map and does not island the tracks it never heard", { timeout: 180_000 }, () => {
    const matrix = buildFeatureMatrix(tracks, playlists, {
      semanticWeight: 0.5,
      timbreWeight: 0.5,
    });
    for (const v of matrix.data) expect(Number.isFinite(v)).toBe(true);

    const reduced = reduceDims(matrix.data, matrix.n, matrix.d, 50);
    const rows: number[][] = [];
    for (let i = 0; i < matrix.n; i++) {
      rows.push(Array.from(reduced.data.subarray(i * reduced.d, (i + 1) * reduced.d)));
    }
    const umap = new UMAP({
      nComponents: 2,
      nNeighbors: 15,
      minDist: 0.1,
      random: mulberry32(42),
    });
    const embedding = umap.fit(rows);
    const coords = new Float32Array(matrix.n * 2);
    for (let i = 0; i < matrix.n; i++) {
      expect(Number.isFinite(embedding[i][0])).toBe(true);
      expect(Number.isFinite(embedding[i][1])).toBe(true);
      coords[i * 2] = embedding[i][0];
      coords[i * 2 + 1] = embedding[i][1];
    }

    const k = 8;
    const clusters = kmeans(coords, matrix.n, k, 42);
    const total = new Array<number>(k).fill(0);
    const unheard = new Array<number>(k).fill(0);
    for (let i = 0; i < matrix.n; i++) {
      total[clusters[i]]++;
      if (!heard.has(tracks[i].pid)) unheard[clusters[i]]++;
    }

    // No cluster may be a segregated pool of unanalyzed tracks. The baseline
    // rate is ~40%, so a cluster running above 90% would mean the layout had
    // learned "we couldn't hear this" as if it were a musical property.
    for (let c = 0; c < k; c++) {
      if (total[c] < 10) continue;
      expect(unheard[c] / total[c]).toBeLessThan(0.9);
    }
  });

  it("changes the layout when sound is given weight", { timeout: 180_000 }, () => {
    // If the timbre block were being silently dropped, these would match.
    const off = buildFeatureMatrix(tracks, playlists, { semanticWeight: 0.5, timbreWeight: 0 });
    const on = buildFeatureMatrix(tracks, playlists, { semanticWeight: 0.5, timbreWeight: 1 });
    expect(on.d).toBeGreaterThan(off.d);
    expect(on.d - off.d).toBe(TI);
  });
});
