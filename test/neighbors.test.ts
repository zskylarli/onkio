import { describe, expect, it } from "vitest";
import {
  buildSimilarityMatrix,
  NeighborIndex,
} from "../src/views/neighbors";
import { reduceDims } from "../src/features/svd";
import type { Track } from "../src/types";

function track(pid: string, collection = "a"): Track {
  return {
    pid,
    trackId: Number(pid.replace(/\D/g, "")) || 0,
    name: pid,
    durationMs: 180_000,
    playlists: [],
    collection,
  };
}

describe("NeighborIndex", () => {
  it("returns the five closest rows and excludes the query", () => {
    const tracks = Array.from({ length: 8 }, (_, i) => track(`p${i}`));
    const vectors = Float32Array.from(tracks.flatMap((_, i) => [i, 0]));
    const result = new NeighborIndex(tracks, vectors, 2, 1).nearest("p3");

    expect(result.map((n) => n.track.pid)).toEqual(["p2", "p4", "p1", "p5", "p0"]);
    expect(result.some((n) => n.track.pid === "p3")).toBe(false);
  });

  it("filters candidates to a selected collection", () => {
    const tracks = [
      track("query", "mine"),
      track("same", "mine"),
      track("other-near", "theirs"),
      track("other-far", "theirs"),
    ];
    const vectors = Float32Array.from([0, 0.1, 0.2, 4]);
    const result = new NeighborIndex(tracks, vectors, 1, 1).nearest(
      "query",
      "theirs"
    );

    expect(result.map((n) => n.track.pid)).toEqual(["other-near", "other-far"]);
  });

  it("allows the source collection when selected literally", () => {
    const tracks = [track("query", "mine"), track("same", "mine"), track("other", "theirs")];
    const result = new NeighborIndex(
      tracks,
      Float32Array.from([0, 1, 0.1]),
      1,
      1
    ).nearest("query", "mine");

    expect(result.map((n) => n.track.pid)).toEqual(["same"]);
  });

  it("returns every eligible row when fewer than five exist", () => {
    const tracks = [track("p0"), track("p1"), track("p2")];
    const result = new NeighborIndex(
      tracks,
      Float32Array.from([0, 1, 2]),
      1,
      1
    ).nearest("p0");
    expect(result).toHaveLength(2);
  });

  it("breaks equal-distance ties by library row", () => {
    const tracks = [track("query"), track("first"), track("second")];
    const result = new NeighborIndex(
      tracks,
      Float32Array.from([0, -1, 1]),
      1,
      1
    ).nearest("query");
    expect(result.map((n) => n.track.pid)).toEqual(["first", "second"]);
  });

  it("returns nothing for a missing pid or non-positive limit", () => {
    const index = new NeighborIndex([track("p0")], Float32Array.from([0]), 1, 1);
    expect(index.nearest("missing")).toEqual([]);
    expect(index.nearest("p0", null, 0)).toEqual([]);
  });

  it("rejects vector rows that cannot align with the library", () => {
    expect(
      () => new NeighborIndex([track("p0"), track("p1")], Float32Array.from([0]), 1, 1)
    ).toThrow(/do not match tracks/);
  });

  it("caches a query by pid, collection, limit, and generation", () => {
    const tracks = [track("p0"), track("p1"), track("p2")];
    const index = new NeighborIndex(tracks, Float32Array.from([0, 1, 2]), 1, 9);
    const first = index.nearest("p0", null, 1);
    expect(index.nearest("p0", null, 1)).toBe(first);
    expect(index.nearest("p0", null, 2)).not.toBe(first);
  });
});

describe("buildSimilarityMatrix", () => {
  it("ignores playlist-only differences", () => {
    const tracks = [
      { ...track("query"), playlists: ["Mine"], genre: "House", bpm: 124 },
      { ...track("same-music"), playlists: ["Theirs"], genre: "House", bpm: 124 },
      { ...track("different"), playlists: ["Mine"], genre: "Techno", bpm: 138 },
    ];
    const playlists = [
      { name: "Mine", pids: ["query", "different"] },
      { name: "Theirs", pids: ["same-music"] },
    ];
    const matrix = buildSimilarityMatrix(tracks, playlists);
    expect(matrix.encoder.widths.playlist).toBe(0);
    expect(matrix.encoder.widths.genre).toBe(0);
    const query = matrix.data.subarray(0, matrix.d);
    const same = matrix.data.subarray(matrix.d, matrix.d * 2);

    expect(Array.from(same)).toEqual(Array.from(query));
    const nearest = new NeighborIndex(
      tracks,
      matrix.data,
      matrix.d,
      1
    ).nearest("query");
    expect(nearest[0].track.pid).toBe("same-music");
  });

  it("keeps track rows aligned through reduction and follows feature weights", () => {
    const tracks = [
      { ...track("query"), tags: ["club"], bpm: 124 },
      { ...track("tag-match"), tags: ["club"], bpm: 145 },
      { ...track("bpm-match"), tags: ["swing"], bpm: 125 },
    ];
    const nearestAt = (semanticWeight: number): string => {
      const matrix = buildSimilarityMatrix(tracks, [], { semanticWeight });
      const reduced = reduceDims(matrix.data, matrix.n, matrix.d, 50);
      // NeighborIndex consumes the exact row order returned by the worker.
      return new NeighborIndex(
        tracks,
        reduced.data,
        reduced.d,
        1
      ).nearest("query", null, 1)[0].track.pid;
    };

    expect(nearestAt(0.9)).toBe("tag-match");
    expect(nearestAt(0.1)).toBe("bpm-match");
  });
});
