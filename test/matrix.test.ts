import { describe, expect, it } from "vitest";
import { buildFeatureMatrix } from "../src/features/matrix";
import { reduceDims, jacobiEigen } from "../src/features/svd";
import { kmeans } from "../src/embed/kmeans";
import type { Playlist, Track } from "../src/types";

function mkTrack(over: Partial<Track> & { pid: string }): Track {
  return {
    trackId: 1,
    name: over.pid,
    durationMs: 200000,
    playlists: [],
    ...over,
  };
}

const tracks: Track[] = [
  mkTrack({ pid: "a", artist: "X", genre: "House", bpm: 126, key: "8A", year: 2020, playlists: ["P1"] }),
  mkTrack({ pid: "b", artist: "X", genre: "House", bpm: 128, key: "9A", year: 2021, playlists: ["P1"] }),
  mkTrack({ pid: "c", artist: "Y", genre: "Folk", bpm: 90, key: "3B", year: 1975, playlists: ["P2"] }),
  mkTrack({ pid: "d", artist: "Y", genre: "Folk", year: 1978, playlists: ["P2"] }),
  mkTrack({ pid: "e", artist: "Z", genre: "Jazz", year: 1960, playlists: [] }),
];
const playlists: Playlist[] = [
  { name: "P1", pids: ["a", "b"] },
  { name: "P2", pids: ["c", "d"] },
];

describe("timbre block (partially observed by nature)", () => {
  const TI = 6;
  const vec = (...v: number[]) => Float32Array.from(v);
  /** Two tracks that sound alike, one that doesn't, one never analyzed. */
  const sound: Track[] = [
    mkTrack({ pid: "a", genre: "House", timbre: vec(1, 2, 3, 4, 5, 6) }),
    mkTrack({ pid: "b", genre: "House", timbre: vec(1.1, 2.1, 3.1, 4.1, 5.1, 6.1) }),
    mkTrack({ pid: "c", genre: "House", timbre: vec(9, 8, 7, 6, 5, 4) }),
    mkTrack({ pid: "d", genre: "House" }),
  ];
  const offTi = (m: { d: number }) => m.d - TI;
  const rowTimbre = (m: { data: Float32Array; d: number }, r: number) =>
    Array.from(m.data.subarray(r * m.d + offTi(m), (r + 1) * m.d));

  it("costs nothing when unused", () => {
    const off = buildFeatureMatrix(sound, [], { timbreWeight: 0 });
    const on = buildFeatureMatrix(sound, [], { timbreWeight: 1 });
    expect(on.d - off.d).toBe(TI);
  });

  it("leaves unanalyzed tracks exactly neutral", () => {
    const m = buildFeatureMatrix(sound, [], { timbreWeight: 1 });
    // Zero after standardization is the mean of the analyzed tracks, so an
    // unheard track sits at the centre of timbre space rather than in an
    // "unknown" cluster of its own.
    expect(rowTimbre(m, 3).every((v) => v === 0)).toBe(true);
    expect(rowTimbre(m, 0).some((v) => v !== 0)).toBe(true);
  });

  it("keeps similar-sounding tracks closer than different-sounding ones", () => {
    const m = buildFeatureMatrix(sound, [], { timbreWeight: 1 });
    const dist = (i: number, j: number) => {
      const a = rowTimbre(m, i);
      const b = rowTimbre(m, j);
      return Math.hypot(...a.map((v, k) => v - b[k]));
    };
    expect(dist(0, 1)).toBeLessThan(dist(0, 2));
  });

  it("does not amplify a handful of analyzed tracks as coverage drops", () => {
    // Scaling by the whole-matrix RMS would divide by coverage and throw the
    // few analyzed tracks to the edge of the map.
    const rms = (m: { data: Float32Array; d: number }, rows: number[]) => {
      let ss = 0;
      for (const r of rows) for (const v of rowTimbre(m, r)) ss += v * v;
      return Math.sqrt(ss / rows.length);
    };
    const sparse = [...sound, ...Array.from({ length: 96 }, (_, i) => mkTrack({ pid: `x${i}`, genre: "House" }))];
    const full = buildFeatureMatrix(sound.slice(0, 3), [], { timbreWeight: 1 });
    const thin = buildFeatureMatrix(sparse, [], { timbreWeight: 1 });
    expect(rms(thin, [0, 1, 2])).toBeCloseTo(rms(full, [0, 1, 2]), 4);
  });

  it("scales with the requested weight", () => {
    const half = buildFeatureMatrix(sound, [], { timbreWeight: 0.5 });
    const one = buildFeatureMatrix(sound, [], { timbreWeight: 1 });
    const mag = (m: { data: Float32Array; d: number }) =>
      Math.hypot(...rowTimbre(m, 0));
    expect(mag(one)).toBeCloseTo(mag(half) * 2, 4);
  });

  it("ignores a vector left over from a different extractor version", () => {
    const stale = [...sound, mkTrack({ pid: "e", genre: "House", timbre: vec(1, 2, 3) })];
    const m = buildFeatureMatrix(stale, [], { timbreWeight: 1 });
    expect(m.d - TI).toBe(buildFeatureMatrix(stale, [], { timbreWeight: 0 }).d);
    expect(rowTimbre(m, 4).every((v) => v === 0)).toBe(true);
  });

  it("produces a finite matrix when every analyzed track sounds identical", () => {
    const same = [
      mkTrack({ pid: "a", timbre: vec(1, 1, 1, 1, 1, 1) }),
      mkTrack({ pid: "b", timbre: vec(1, 1, 1, 1, 1, 1) }),
    ];
    const m = buildFeatureMatrix(same, [], { timbreWeight: 1 });
    for (const v of m.data) expect(Number.isFinite(v)).toBe(true);
  });
});

describe("buildFeatureMatrix", () => {
  it("produces the expected dimensionality", () => {
    const m = buildFeatureMatrix(tracks, playlists);
    // 2 playlists + 3 genres + 0 tags + 8 numeric
    expect(m.d).toBe(2 + 3 + 8);
    expect(m.n).toBe(5);
    expect(m.data.length).toBe(m.n * m.d);
  });

  it("zeroes the numeric block at full semantic weight (§5.3)", () => {
    const m = buildFeatureMatrix(tracks, playlists, { semanticWeight: 1 });
    const OFF_NU = m.d - 8;
    for (let r = 0; r < m.n; r++) {
      for (let c = OFF_NU; c < m.d; c++) {
        expect(Math.abs(m.data[r * m.d + c])).toBe(0);
      }
    }
  });

  it("zeroes the semantic blocks at full numeric weight", () => {
    const m = buildFeatureMatrix(tracks, playlists, { semanticWeight: 0 });
    for (let r = 0; r < m.n; r++) {
      for (let c = 0; c < m.d - 8; c++) {
        expect(Math.abs(m.data[r * m.d + c])).toBe(0);
      }
    }
  });

  it("propagates playlist signal through shared artists (§5.2)", () => {
    const withHermit: Track[] = [
      ...tracks,
      // same artist X but not in any playlist
      mkTrack({ pid: "f", artist: "X", genre: "House" }),
    ];
    const m = buildFeatureMatrix(withHermit, playlists, { artistBlend: 0.3 });
    // track f (row 5) should have inherited nonzero P1 incidence
    const row = 5 * m.d;
    expect(m.data[row + 0]).toBeGreaterThan(0);
    // whereas Z's track (row 4) stays at zero
    expect(m.data[4 * m.d + 0]).toBe(0);
  });

  it("missing numeric data contributes nothing (no fake structure)", () => {
    const m = buildFeatureMatrix(tracks, playlists, { semanticWeight: 0 });
    const OFF_NU = m.d - 8;
    // track e has no bpm/key: bpm + key dims must be 0
    for (let c = OFF_NU; c < OFF_NU + 6; c++) {
      expect(m.data[4 * m.d + c]).toBe(0);
    }
  });
});

describe("reduceDims", () => {
  it("projects to k dims and preserves gross cluster separation", () => {
    // two blobs in 10-d
    const n = 40;
    const d = 10;
    const data = new Float32Array(n * d);
    for (let i = 0; i < n; i++) {
      const blob = i < n / 2 ? 0 : 5;
      for (let j = 0; j < d; j++) {
        data[i * d + j] = blob + Math.sin(i * 13.7 + j) * 0.1;
      }
    }
    const r = reduceDims(data, n, d, 3);
    expect(r.d).toBe(3);
    // first principal direction should separate the blobs
    const a = r.data[0 * 3];
    const b = r.data[(n - 1) * 3];
    expect(Math.abs(a - b)).toBeGreaterThan(1);
  });

  it("is a no-op when d <= k", () => {
    const data = new Float32Array(6);
    const r = reduceDims(data, 3, 2, 50);
    expect(r.d).toBe(2);
  });
});

describe("jacobiEigen", () => {
  it("diagonalizes a known symmetric matrix", () => {
    // [[2,1],[1,2]] → eigenvalues 3 and 1
    const { values } = jacobiEigen(new Float64Array([2, 1, 1, 2]), 2);
    const sorted = [...values].sort((a, b) => b - a);
    expect(sorted[0]).toBeCloseTo(3, 6);
    expect(sorted[1]).toBeCloseTo(1, 6);
  });
});

describe("kmeans", () => {
  it("separates two obvious blobs deterministically", () => {
    const n = 20;
    const pts = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      pts[i * 2] = i < 10 ? 0 + i * 0.01 : 100 + i * 0.01;
      pts[i * 2 + 1] = 0;
    }
    const l1 = kmeans(pts, n, 2, 7);
    const l2 = kmeans(pts, n, 2, 7);
    expect([...l1]).toEqual([...l2]); // seeded → deterministic
    const left = new Set([...l1.slice(0, 10)]);
    const right = new Set([...l1.slice(10)]);
    expect(left.size).toBe(1);
    expect(right.size).toBe(1);
    expect([...left][0]).not.toBe([...right][0]);
  });
});
