import { describe, expect, it } from "vitest";
import {
  attachProjectedTrack,
  reprojectAttachedTrack,
  type Embedding,
} from "../src/embed/attach";
import type { Track } from "../src/types";

function track(pid: string): Track {
  return { pid, trackId: 0, name: pid, durationMs: 180_000, playlists: [] };
}

function embedding(n = 3): Embedding {
  return {
    tracks: Array.from({ length: n }, (_, i) => track(`p${i}`)),
    coords: Float32Array.from(Array.from({ length: n }, (_, i) => [i, i * 2]).flat()),
    clusters: Int32Array.from(Array.from({ length: n }, (_, i) => i)),
    similarity: Float32Array.from(Array.from({ length: n }, (_, i) => [i, 0]).flat()),
    similarityD: 2,
  };
}

describe("reprojectAttachedTrack", () => {
  it("moves one row and leaves every other row byte-identical", () => {
    const start = embedding();
    const next = reprojectAttachedTrack(start, "p1", {
      x: 9,
      y: 8,
      clusterId: 4,
      vector: Float32Array.from([3, 4]),
    });
    expect(next).not.toBeNull();
    expect(next!.coords[0]).toBe(start.coords[0]);
    expect(next!.coords[1]).toBe(start.coords[1]);
    expect(next!.coords[2]).toBe(9);
    expect(next!.coords[3]).toBe(8);
    expect(next!.coords[4]).toBe(start.coords[4]);
    expect(next!.coords[5]).toBe(start.coords[5]);
    expect(next!.clusters[0]).toBe(0);
    expect(next!.clusters[1]).toBe(4);
    expect(next!.clusters[2]).toBe(2);
    expect([...next!.similarity.subarray(0, 2)]).toEqual([0, 0]);
    expect([...next!.similarity.subarray(2, 4)]).toEqual([3, 4]);
    expect([...next!.similarity.subarray(4, 6)]).toEqual([2, 0]);
    expect(next!.tracks).toEqual(start.tracks);
    expect(next!.tracks).not.toBe(start.tracks);
  });

  it("returns null for a pid that was never attached", () => {
    expect(reprojectAttachedTrack(embedding(), "ghost", {
      x: 0,
      y: 0,
      clusterId: 0,
      vector: Float32Array.from([0, 0]),
    })).toBeNull();
  });
});

describe("attachProjectedTrack", () => {
  it("appends a row without mutating the original arrays", () => {
    const start = embedding(2);
    const next = attachProjectedTrack(start, track("new"), {
      x: 5,
      y: 6,
      clusterId: 1,
      vector: Float32Array.from([7, 8]),
    });
    expect(next.tracks).toHaveLength(3);
    expect(start.tracks).toHaveLength(2);
    expect(start.coords).toHaveLength(4);
    expect(next.coords[4]).toBe(5);
    expect(next.coords[5]).toBe(6);
    expect([...next.coords.subarray(0, 4)]).toEqual([...start.coords]);
  });
});
