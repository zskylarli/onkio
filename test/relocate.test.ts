import { describe, expect, it } from "vitest";
import { placeByTempoKey, tempoKeyVector } from "../src/embed/relocate";
import type { Track } from "../src/types";

function track(over: Partial<Track> & { pid: string; bpm: number }): Track {
  return {
    trackId: 1,
    name: over.pid,
    durationMs: 180_000,
    playlists: [],
    key: "8A",
    ...over,
  };
}

/** Two islands: slow tracks at x=0, fast tracks at x=100. */
function twoIslands(slowBpm = 90, fastBpm = 140) {
  const tracks: Track[] = [
    ...Array.from({ length: 8 }, (_, i) =>
      track({ pid: `slow-${i}`, bpm: slowBpm + (i % 3), artist: "slow" })
    ),
    ...Array.from({ length: 8 }, (_, i) =>
      track({ pid: `fast-${i}`, bpm: fastBpm + (i % 3), artist: "fast" })
    ),
  ];
  const coords = new Float32Array(tracks.length * 2);
  for (let i = 0; i < tracks.length; i++) {
    coords[i * 2] = i < 8 ? 0 : 100;
    coords[i * 2 + 1] = (i % 8) * 2;
  }
  const clusters = Int32Array.from(tracks.map((_, i) => (i < 8 ? 0 : 1)));
  return { tracks, coords, clusters };
}

describe("tempoKeyVector", () => {
  it("changes when BPM changes, including half/double-time in the log column", () => {
    const slow = tempoKeyVector(track({ pid: "a", bpm: 90 }), { bpm: true, key: false });
    const fast = tempoKeyVector(track({ pid: "a", bpm: 140 }), { bpm: true, key: false });
    const doubled = tempoKeyVector(track({ pid: "a", bpm: 180 }), { bpm: true, key: false });
    expect(slow[0]).not.toBe(fast[0]);
    expect(Math.abs(doubled[0] - slow[0])).toBeCloseTo(1, 5);
  });
});

describe("placeByTempoKey", () => {
  it("moves a slow track into the fast island when its BPM is rewritten", () => {
    const { tracks, coords, clusters } = twoIslands();
    const edited = { ...tracks[0], bpm: 140 };
    const before = { x: coords[0], y: coords[1] };
    const placed = placeByTempoKey(edited, tracks, coords, clusters, {
      skipPid: edited.pid,
      bpm: true,
      key: false,
    });
    expect(placed).not.toBeNull();
    expect(placed!.x).toBeGreaterThan(80);
    expect(Math.abs(placed!.x - before.x)).toBeGreaterThan(50);
    expect(placed!.neighborIndexes.includes(0)).toBe(false);
  });

  it("picks the edited row as nearest if it is not skipped", () => {
    const { tracks, coords, clusters } = twoIslands();
    const edited = { ...tracks[0], bpm: 140 };
    tracks[0] = edited;
    const placed = placeByTempoKey(edited, tracks, coords, clusters, {
      bpm: true,
      key: false,
    });
    expect(placed).not.toBeNull();
    expect(placed!.neighborIndexes[0]).toBe(0);
  });

  it("places a key edit among the matching Camelot neighbourhood", () => {
    const tracks = [
      ...Array.from({ length: 6 }, (_, i) =>
        track({ pid: `a-${i}`, bpm: 124, key: "8A" })
      ),
      ...Array.from({ length: 6 }, (_, i) =>
        track({ pid: `b-${i}`, bpm: 124, key: "3A" })
      ),
    ];
    const coords = new Float32Array(tracks.length * 2);
    for (let i = 0; i < tracks.length; i++) {
      coords[i * 2] = i < 6 ? 0 : 100;
      coords[i * 2 + 1] = i % 6;
    }
    const clusters = Int32Array.from(tracks.map((_, i) => (i < 6 ? 0 : 1)));
    const edited = { ...tracks[0], key: "3A" };
    const placed = placeByTempoKey(edited, tracks, coords, clusters, {
      skipPid: edited.pid,
      bpm: false,
      key: true,
    });
    expect(placed).not.toBeNull();
    expect(placed!.x).toBeGreaterThan(80);
  });
});
