import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { UMAP } from "umap-js";
import { parseRekordbox } from "../src/parse/rekordbox";
import { buildFeatureMatrix } from "../src/features/matrix";
import { reduceDims } from "../src/features/svd";
import { kmeans } from "../src/embed/kmeans";
import { mulberry32 } from "../src/util/rng";
import type { Playlist, Track } from "../src/types";

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "Adryft_recordbox_collection_metadata.xml"
);
const LABEL_COLUMNS = 134;

let tracks: Track[];
let playlists: Playlist[];
let unlabelled: Set<string>;

beforeAll(() => {
  const parsed = parseRekordbox(readFileSync(FIXTURE, "utf8"));
  const random = mulberry32(19);
  tracks = parsed.tracks.filter(() => random() < 0.45);
  const kept = new Set(tracks.map((track) => track.pid));
  playlists = parsed.playlists.map((playlist) => ({
    name: playlist.name,
    pids: playlist.pids.filter((pid) => kept.has(pid)),
  }));

  // Measured shape: 78.6% coverage, 134 recurring labels, then a long
  // singleton tail. Every recurring label gets exactly two guaranteed rows.
  for (const track of tracks) {
    track.label = undefined;
    if (track.source) delete track.source.label;
  }
  const labelledCount = Math.floor(tracks.length * 0.786);
  for (let i = 0; i < LABEL_COLUMNS * 2; i++) {
    tracks[i].label = `Roster ${i % LABEL_COLUMNS}`;
  }
  for (let i = LABEL_COLUMNS * 2; i < labelledCount; i++) {
    tracks[i].label = `Singleton ${i}`;
  }
  unlabelled = new Set(tracks.slice(labelledCount).map((track) => track.pid));
});

describe("embedding with partial label coverage", () => {
  it("builds the measured vocabulary and a finite matrix", () => {
    const off = buildFeatureMatrix(tracks, playlists, {
      semanticWeight: 0.5,
      labelWeight: 0,
    });
    const on = buildFeatureMatrix(tracks, playlists, {
      semanticWeight: 0.5,
      labelWeight: 0.75,
    });
    expect(on.d - off.d).toBe(LABEL_COLUMNS);
    for (const value of on.data) expect(Number.isFinite(value)).toBe(true);
  });

  it(
    "does not turn unknown labels into a segregated island",
    { timeout: 180_000 },
    () => {
      const matrix = buildFeatureMatrix(tracks, playlists, {
        semanticWeight: 0.5,
        labelWeight: 0.75,
      });
      const reduced = reduceDims(matrix.data, matrix.n, matrix.d, 50);
      const rows = Array.from({ length: reduced.n }, (_, row) =>
        Array.from(
          reduced.data.subarray(row * reduced.d, (row + 1) * reduced.d)
        )
      );
      const embedding = new UMAP({
        nComponents: 2,
        nNeighbors: 15,
        minDist: 0.1,
        random: mulberry32(42),
      }).fit(rows);
      const coords = new Float32Array(matrix.n * 2);
      for (let i = 0; i < matrix.n; i++) {
        coords[i * 2] = embedding[i][0];
        coords[i * 2 + 1] = embedding[i][1];
        expect(Number.isFinite(coords[i * 2])).toBe(true);
        expect(Number.isFinite(coords[i * 2 + 1])).toBe(true);
      }

      const k = 8;
      const clusters = kmeans(coords, matrix.n, k, 42);
      const total = new Array<number>(k).fill(0);
      const missing = new Array<number>(k).fill(0);
      for (let i = 0; i < tracks.length; i++) {
        total[clusters[i]]++;
        if (unlabelled.has(tracks[i].pid)) missing[clusters[i]]++;
      }
      for (let cluster = 0; cluster < k; cluster++) {
        if (total[cluster] < 10) continue;
        expect(missing[cluster] / total[cluster]).toBeLessThan(0.9);
      }
    }
  );
});
