import { describe, expect, it } from "vitest";
import { UMAP } from "umap-js";
import { buildFeatureMatrix } from "../src/features/matrix";
import { encodeTrack } from "../src/features/encoder";
import { reduceDims } from "../src/features/svd";
import {
  placeVector,
  projectVector,
  transferLabels,
  PROJECTION_NEIGHBORS,
} from "../src/embed/project";
import { buildSimilarityMatrix, NeighborIndex } from "../src/views/neighbors";
import { kmeans } from "../src/embed/kmeans";
import { mulberry32 } from "../src/util/rng";
import type { Playlist, Track } from "../src/types";

/**
 * Projecting a track that is not in the library onto the map that already
 * exists. The safety net for the whole feature is the encoder property: a
 * library track pushed back through the retained fit must land on exactly the
 * row it had during the fit, or an outside track is being measured with a
 * different ruler than everything it is being compared against.
 */

function mkTrack(over: Partial<Track> & { pid: string }): Track {
  return {
    trackId: 1,
    name: over.pid,
    durationMs: 200_000,
    playlists: [],
    ...over,
  };
}

const KEYS = ["1A", "2A", "3B", "5A", "7B", "8A", "9A", "11B"];

/**
 * Three musically distinct groups, deterministic down to the jitter. Each
 * artist appears once, so artist propagation has nothing to propagate.
 *
 * The tag pools are wide on purpose: they push the feature space past 50
 * dimensions so the pipeline actually reduces, rather than quietly taking the
 * no-reduction path and testing an identity basis.
 */
function makeLibrary(perGroup: number): { tracks: Track[]; playlists: Playlist[] } {
  const groups = [
    { id: "house", genre: "House", label: "Toolroom", tags: ["club", "peak"], bpm: 126, year: 2020 },
    { id: "folk", genre: "Folk", label: "Harvest", tags: ["acoustic"], bpm: 92, year: 1974 },
    { id: "jazz", genre: "Jazz", label: "Blue Note", tags: ["swing"], bpm: 108, year: 1960 },
  ];
  const rand = mulberry32(7);
  const tracks: Track[] = [];
  for (const g of groups) {
    const pool = Array.from({ length: 16 }, (_, i) => `${g.id}-tag-${i}`);
    for (let i = 0; i < perGroup; i++) {
      const drawn = new Set<string>();
      while (drawn.size < 3) drawn.add(pool[Math.floor(rand() * pool.length)]);
      tracks.push(
        mkTrack({
          pid: `${g.id}-${i}`,
          artist: `${g.id} artist ${i}`,
          genre: g.genre,
          label: g.label,
          tags: [...g.tags, ...drawn],
          bpm: g.bpm + Math.round(rand() * 4) - 2,
          key: KEYS[Math.floor(rand() * KEYS.length)],
          year: g.year + Math.round(rand() * 4),
          durationMs: 180_000 + Math.round(rand() * 60_000),
          playlists: [`${g.id} set`],
        })
      );
    }
  }
  const playlists: Playlist[] = groups.map((g) => ({
    name: `${g.id} set`,
    pids: tracks.filter((t) => t.pid.startsWith(g.id)).map((t) => t.pid),
  }));
  return { tracks, playlists };
}

describe("retained SVD basis", () => {
  const n = 30;
  const d = 12;
  const data = new Float32Array(n * d);
  const rand = mulberry32(3);
  for (let i = 0; i < n * d; i++) data[i] = rand() * 2 - 1;

  it("reproduces an original row's reduced coordinates exactly", () => {
    const k = 4;
    const reduced = reduceDims(data, n, d, k);
    expect(reduced.basis).not.toBeNull();
    expect(reduced.inputD).toBe(d);
    expect(reduced.basis!.length).toBe(d * k);

    for (let r = 0; r < n; r++) {
      const row = data.slice(r * d, (r + 1) * d);
      const projected = projectVector(row, reduced.basis, reduced.inputD, reduced.d);
      for (let c = 0; c < k; c++) {
        expect(projected[c]).toBe(reduced.data[r * k + c]);
      }
    }
  });

  it("passes rows through untouched when no reduction was needed", () => {
    const reduced = reduceDims(data, n, d, 50);
    expect(reduced.d).toBe(d);
    expect(reduced.basis).toBeNull();
    expect(reduced.inputD).toBe(d);

    const row = data.slice(0, d);
    const projected = projectVector(row, reduced.basis, reduced.inputD, reduced.d);
    expect([...projected]).toEqual([...row]);
  });

  it("refuses an identity basis that would change the width", () => {
    expect(() => projectVector(new Float32Array(4), null, 4, 3)).toThrow();
  });
});

describe("feature encoder", () => {
  const { tracks, playlists } = makeLibrary(4);
  // A partially observed timbre block, since that is the one block with its
  // own standardization pass to reproduce.
  tracks[0].timbre = Float32Array.from([1, 2, 3, 4, 5, 6]);
  tracks[1].timbre = Float32Array.from([1.5, 2.5, 2, 4.5, 5.5, 6.5]);
  tracks[5].timbre = Float32Array.from([-3, 0, 7, 1, 2, -1]);

  const options = { semanticWeight: 0.5, timbreWeight: 0.6, labelWeight: 0.75 };

  it("reproduces a library track's row outside the playlist block", () => {
    const m = buildFeatureMatrix(tracks, playlists, options);
    const nPl = m.encoder.widths.playlist;
    expect(nPl).toBe(3);
    expect(m.encoder.d).toBe(m.d);

    for (let r = 0; r < m.n; r++) {
      const encoded = encodeTrack(m.encoder, tracks[r]);
      expect(encoded.length).toBe(m.d);
      for (let c = nPl; c < m.d; c++) {
        expect([tracks[r].pid, c, encoded[c]]).toEqual([
          tracks[r].pid,
          c,
          m.data[r * m.d + c],
        ]);
      }
      // The playlist block is left at zero on purpose: an outside track has
      // not been filed by anyone, and guessing where it would have been filed
      // would place it by imputation rather than by what it is.
      for (let c = 0; c < nPl; c++) expect(encoded[c]).toBe(0);
    }
  });

  it("reproduces rows when an artist block is switched on", () => {
    // A repeated artist gives the artist block something to hold, and turns on
    // artist propagation, which only ever writes into the playlist block.
    const shared = tracks.map((t, i) =>
      i % 4 === 0 ? { ...t, artist: "Shared Act" } : t
    );
    const m = buildFeatureMatrix(shared, playlists, { ...options, artistWeight: 0.5 });
    const nPl = m.encoder.widths.playlist;
    expect(m.encoder.widths.artist).toBeGreaterThan(0);
    for (let r = 0; r < m.n; r++) {
      const encoded = encodeTrack(m.encoder, shared[r]);
      for (let c = nPl; c < m.d; c++) {
        expect(encoded[c]).toBe(m.data[r * m.d + c]);
      }
    }
  });

  it("reproduces rows of the playlist-free similarity matrix exactly", () => {
    // With no playlist block there is no excused column at all, so this is a
    // whole-row equality — and it is the matrix projection actually uses.
    const m = buildSimilarityMatrix(tracks, playlists, options);
    expect(m.encoder.widths.playlist).toBe(0);
    expect(m.encoder.widths.genre).toBe(0);
    for (let r = 0; r < m.n; r++) {
      const encoded = encodeTrack(m.encoder, tracks[r]);
      expect([...encoded]).toEqual([...m.data.subarray(r * m.d, (r + 1) * m.d)]);
    }
  });

  it("honours excluded blocks", () => {
    const m = buildSimilarityMatrix(tracks, playlists, {
      ...options,
      exclude: ["bpm", "year", "tags"],
    });
    expect(m.encoder.widths.tag).toBe(0);
    expect(m.encoder.numeric.useBpm).toBe(false);
    expect(m.encoder.numeric.useYear).toBe(false);
    const encoded = encodeTrack(m.encoder, tracks[0]);
    const nu = m.encoder.offsets.numeric;
    for (const c of [nu, nu + 1, nu + 2, nu + 6]) expect(encoded[c]).toBe(0);
    // key and duration are still fitted, so they are still written
    expect(encoded[nu + 7]).not.toBe(0);
  });

  it("gives an unknown label or tag zero weight rather than an error", () => {
    const m = buildSimilarityMatrix(tracks, playlists, options);
    const bare = mkTrack({ pid: "outsider", bpm: 124, key: "8A", year: 2021 });
    const exotic = {
      ...bare,
      genre: "Balearic Trance",
      label: "A Label Nobody Signed To",
      tags: ["never-seen"],
    };
    const encodedBare = encodeTrack(m.encoder, bare);
    const encodedExotic = encodeTrack(m.encoder, exotic);
    expect([...encodedExotic]).toEqual([...encodedBare]);
    expect(encodedExotic.every(Number.isFinite)).toBe(true);
    // Genre is not a similarity feature, so a known genre is also a no-op.
    const knownGenre = encodeTrack(m.encoder, { ...bare, genre: "House" });
    expect([...knownGenre]).toEqual([...encodedBare]);
    // A known tag does move it, so the test above is not vacuous.
    const known = encodeTrack(m.encoder, { ...bare, tags: ["club"] });
    expect([...known]).not.toEqual([...encodedBare]);
  });

  it("ignores a timbre vector left over from a different extractor version", () => {
    const m = buildSimilarityMatrix(tracks, playlists, options);
    const ti = m.encoder.offsets.timbre;
    const stale = encodeTrack(m.encoder, {
      ...tracks[0],
      timbre: Float32Array.from([1, 2, 3]),
    });
    for (let c = ti; c < m.d; c++) expect(stale[c]).toBe(0);
  });
});

describe("playlist demotion", () => {
  const { tracks, playlists } = makeLibrary(6);

  const blockRms = (
    m: { data: Float32Array; d: number; n: number },
    from: number,
    width: number
  ) => {
    let ss = 0;
    for (let r = 0; r < m.n; r++)
      for (let c = from; c < from + width; c++) ss += m.data[r * m.d + c] ** 2;
    return Math.sqrt(ss / m.n);
  };

  it("gives playlist company less energy than genre", () => {
    const m = buildFeatureMatrix(tracks, playlists);
    const { offsets, widths } = m.encoder;
    const playlist = blockRms(m, offsets.playlist, widths.playlist);
    const genre = blockRms(m, offsets.genre, widths.genre);
    expect(playlist).toBeGreaterThan(0);
    expect(playlist).toBeLessThan(genre);
    // 0.25 against genre's 0.5, both times the semantic slider's 2 × 0.5
    expect(playlist).toBeCloseTo(0.25, 5);
    expect(genre).toBeCloseTo(0.5, 5);
  });

  it("follows the requested playlist weight", () => {
    const m = buildFeatureMatrix(tracks, playlists, { playlistWeight: 1 });
    const { offsets, widths } = m.encoder;
    expect(blockRms(m, offsets.playlist, widths.playlist)).toBeCloseTo(1, 5);
    const off = buildFeatureMatrix(tracks, playlists, { playlistWeight: 0 });
    expect(blockRms(off, offsets.playlist, widths.playlist)).toBe(0);
  });
});

describe("placing a track the map has never seen", () => {
  const perGroup = 20;
  const { tracks, playlists } = makeLibrary(perGroup);
  const heldOut = tracks[3]; // a house track
  const rest = tracks.filter((t) => t.pid !== heldOut.pid);

  // The library's own pipeline, minus the held-out track: playlist-free
  // features → 50-D → seeded UMAP → k-means.
  const matrix = buildSimilarityMatrix(rest, playlists, { semanticWeight: 0.5 });
  const reduced = reduceDims(matrix.data, matrix.n, matrix.d, 50);
  // Guards the fixture: if the feature space ever narrows below 50 this whole
  // block would silently be testing an identity basis instead of a real one.
  expect(matrix.d).toBeGreaterThan(50);
  expect(reduced.basis).not.toBeNull();
  const rows: number[][] = [];
  for (let i = 0; i < reduced.n; i++) {
    rows.push(Array.from(reduced.data.subarray(i * reduced.d, (i + 1) * reduced.d)));
  }
  const umap = new UMAP({
    nComponents: 2,
    nNeighbors: 15,
    minDist: 0.1,
    random: mulberry32(42),
  });
  const embedding = umap.fit(rows);
  const coords = new Float32Array(rest.length * 2);
  embedding.forEach(([x, y], i) => {
    coords[i * 2] = x;
    coords[i * 2 + 1] = y;
  });
  const clusters = kmeans(coords, rest.length, 4, 42);

  const vector = projectVector(
    encodeTrack(matrix.encoder, heldOut),
    reduced.basis,
    reduced.inputD,
    reduced.d
  );
  const placement = placeVector(vector, reduced.data, reduced.d, coords)!;

  const groupOf = (pid: string) => pid.split("-")[0];
  const centroid = (group: string) => {
    const rowsIn = rest
      .map((t, i) => [t, i] as const)
      .filter(([t]) => groupOf(t.pid) === group);
    const x = rowsIn.reduce((s, [, i]) => s + coords[i * 2], 0) / rowsIn.length;
    const y = rowsIn.reduce((s, [, i]) => s + coords[i * 2 + 1], 0) / rowsIn.length;
    return { x, y };
  };
  const distTo = (p: { x: number; y: number }) =>
    Math.hypot(placement.x - p.x, placement.y - p.y);

  it("lands among its own kind rather than anywhere else on the map", () => {
    expect(placement.neighbors).toHaveLength(PROJECTION_NEIGHBORS);
    // Every neighbour drawn on is a house track, so the placement below is
    // earned by the metric rather than by an accident of the layout.
    for (const { index } of placement.neighbors) {
      expect(groupOf(rest[index].pid)).toBe("house");
    }
    const own = distTo(centroid("house"));
    expect(own).toBeLessThan(distTo(centroid("folk")));
    expect(own).toBeLessThan(distTo(centroid("jazz")));
    // Not just nearer, but inside its own cluster: closer to the house
    // centroid than the house cluster's own radius.
    const radius = Math.max(
      ...rest
        .map((t, i) => [t, i] as const)
        .filter(([t]) => groupOf(t.pid) === "house")
        .map(([, i]) =>
          Math.hypot(
            coords[i * 2] - centroid("house").x,
            coords[i * 2 + 1] - centroid("house").y
          )
        )
    );
    expect(own).toBeLessThan(radius);
  });

  it("weights neighbours into a proper average", () => {
    const total = placement.neighbors.reduce((s, nb) => s + nb.weight, 0);
    expect(total).toBeCloseTo(1, 10);
    for (const nb of placement.neighbors) expect(nb.weight).toBeGreaterThan(0);
    // Nearest first, and the nearest neighbour is never outweighed by a
    // further one — the membership curve is monotonic in distance.
    const distances = placement.neighbors.map((nb) => nb.distance);
    expect([...distances].sort((a, b) => a - b)).toEqual(distances);
    const weights = placement.neighbors.map((nb) => nb.weight);
    expect(weights[0]).toBeGreaterThanOrEqual(weights[weights.length - 1]);
    // The placement is a convex combination, so it cannot leave the hull.
    const xs = placement.neighbors.map((nb) => coords[nb.index * 2]);
    expect(placement.x).toBeGreaterThanOrEqual(Math.min(...xs));
    expect(placement.x).toBeLessThanOrEqual(Math.max(...xs));
  });

  it("transfers the neighbourhood's cluster and genre", () => {
    const { clusterId, genre } = transferLabels(placement.neighbors, clusters, rest);
    expect(genre).toBe("House");
    const houseClusters = new Set(
      rest.map((t, i) => (groupOf(t.pid) === "house" ? clusters[i] : -1))
    );
    expect(houseClusters.has(clusterId!)).toBe(true);
  });

  it("agrees with a NeighborIndex query on the same vector", () => {
    const index = new NeighborIndex(rest, reduced.data, reduced.d, 1);
    const found = index.nearestToVector(vector, null, 5);
    expect(found.map((f) => f.index)).toEqual(
      placement.neighbors.slice(0, 5).map((nb) => nb.index)
    );
    expect(Math.sqrt(found[0].distanceSq)).toBeCloseTo(
      placement.neighbors[0].distance,
      5
    );
    // The library's own queries are untouched by the new entry point.
    expect(index.nearest(rest[0].pid, null, 3)).toHaveLength(3);
  });

  it("puts a track that belongs nowhere in particular somewhere else", () => {
    // Nothing in common with any group: unknown genre and label, tempo and
    // era between the clusters. It should not land on the house cluster.
    const stranger = mkTrack({
      pid: "stranger",
      genre: "Gqom",
      label: "Unknown Imprint",
      bpm: 150,
      year: 1995,
      durationMs: 400_000,
    });
    const other = placeVector(
      projectVector(
        encodeTrack(matrix.encoder, stranger),
        reduced.basis,
        reduced.inputD,
        reduced.d
      ),
      reduced.data,
      reduced.d,
      coords
    )!;
    expect(Math.hypot(other.x - placement.x, other.y - placement.y)).toBeGreaterThan(
      0
    );
  });

  it("skips a library row so a re-placed track cannot sit on itself", () => {
    const vectors = Float32Array.from([0, 0, 1, 0, 2, 0]);
    const map = Float32Array.from([0, 0, 10, 0, 20, 0]);
    const query = Float32Array.from([0, 0]);
    const withSelf = placeVector(query, vectors, 2, map, 1)!;
    expect(withSelf.neighbors[0].index).toBe(0);
    expect(withSelf.x).toBe(0);
    const skipped = placeVector(query, vectors, 2, map, 1, 1, 0)!;
    expect(skipped.neighbors[0].index).toBe(1);
    expect(skipped.x).toBe(10);
  });

  it("moves a library track when its BPM changes, without keeping it as a neighbour", () => {
    const row = rest[0];
    const retimed = encodeTrack(matrix.encoder, { ...row, bpm: (row.bpm ?? 120) * 1.5 });
    expect([...retimed]).not.toEqual([
      ...encodeTrack(matrix.encoder, row),
    ]);
    const moved = placeVector(
      projectVector(retimed, reduced.basis, reduced.inputD, reduced.d),
      reduced.data,
      reduced.d,
      coords,
      PROJECTION_NEIGHBORS,
      1,
      0
    )!;
    expect(moved.neighbors.every((nb) => nb.index !== 0)).toBe(true);
    expect(moved.x !== coords[0] || moved.y !== coords[1]).toBe(true);
  });

  it("places a tempo-only query among tracks of that tempo", () => {
    const n = 6;
    const d = 6;
    const vectors = new Float32Array(n * d);
    const map = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      const bpm = i < 3 ? 90 : 140;
      const log = Math.log2(bpm);
      vectors[i * d] = log;
      vectors[i * d + 1] = Math.sin(2 * Math.PI * (log % 1));
      vectors[i * d + 2] = Math.cos(2 * Math.PI * (log % 1));
      map[i * 2] = i < 3 ? 0 : 10;
      map[i * 2 + 1] = 0;
    }
    const queryAt = (bpm: number) => {
      const log = Math.log2(bpm);
      const q = new Float32Array(d);
      q[0] = log;
      q[1] = Math.sin(2 * Math.PI * (log % 1));
      q[2] = Math.cos(2 * Math.PI * (log % 1));
      return placeVector(q, vectors, d, map, 3)!;
    };
    expect(queryAt(90).x).toBeLessThan(2);
    expect(queryAt(140).x).toBeGreaterThan(8);
    expect(queryAt(90).neighbors.every((nb) => nb.index < 3)).toBe(true);
    expect(queryAt(140).neighbors.every((nb) => nb.index >= 3)).toBe(true);
  });
});
