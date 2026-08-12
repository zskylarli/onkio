import { describe, expect, it } from "vitest";
import {
  DOWNSAMPLE_THRESHOLD,
  downsampleLibrary,
  needsDownsampleOffer,
  samplePresets,
} from "../src/collections/downsample";
import type { Library, Track } from "../src/types";

function track(i: number, playlists: string[] = []): Track {
  return {
    pid: `p${i}`,
    trackId: i,
    name: `Track ${i}`,
    artist: `Artist ${i}`,
    durationMs: 200_000,
    playlists,
  };
}

function library(n: number, playlists: Library["playlists"] = []): Library {
  const byPid = new Map<string, string[]>();
  for (const p of playlists) {
    for (const pid of p.pids) byPid.set(pid, [...(byPid.get(pid) ?? []), p.name]);
  }
  return {
    tracks: Array.from({ length: n }, (_, i) => track(i, byPid.get(`p${i}`) ?? [])),
    playlists,
    droppedPlaylists: ["Recently Added"],
  };
}

/** A generator that walks 0, 1/k, 2/k … so a sample is predictable in a test. */
function cyclic(values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length];
}

describe("samplePresets", () => {
  it("only offers sizes smaller than the file", () => {
    // A "sample" the size of the file changes nothing, so offering it invites a
    // choice that does no work.
    expect(samplePresets(1200)).toEqual([500, 1000]);
    expect(samplePresets(5000)).toEqual([500, 1000, 2000]);
    expect(samplePresets(400)).toEqual([]);
  });
});

describe("needsDownsampleOffer", () => {
  it("stays quiet at or below the threshold", () => {
    expect(needsDownsampleOffer(DOWNSAMPLE_THRESHOLD)).toBe(false);
    expect(needsDownsampleOffer(300)).toBe(false);
  });

  it("offers once a file is big enough for a smaller preset to exist", () => {
    expect(needsDownsampleOffer(DOWNSAMPLE_THRESHOLD + 1)).toBe(true);
    expect(needsDownsampleOffer(4400)).toBe(true);
  });
});

describe("downsampleLibrary", () => {
  it("returns the library untouched when the sample is not smaller", () => {
    const lib = library(10);
    expect(downsampleLibrary(lib, 10)).toBe(lib);
    expect(downsampleLibrary(lib, 50)).toBe(lib);
  });

  it("keeps exactly the requested number of distinct tracks", () => {
    const sampled = downsampleLibrary(library(100), 30);
    expect(sampled.tracks).toHaveLength(30);
    expect(new Set(sampled.tracks.map((t) => t.pid)).size).toBe(30);
  });

  it("keeps the sample in file order, so only membership is randomised", () => {
    const sampled = downsampleLibrary(library(200), 40);
    const ids = sampled.tracks.map((t) => t.trackId);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
  });

  it("narrows playlists to surviving tracks and drops those left empty", () => {
    const lib = library(6, [
      { name: "Keepers", pids: ["p0", "p1", "p2"] },
      { name: "Gone", pids: ["p4", "p5"] },
    ]);
    // Picks indices 0, 1, 2 in turn, so p4 and p5 cannot survive.
    const sampled = downsampleLibrary(lib, 3, cyclic([0]));

    expect(sampled.tracks.map((t) => t.pid)).toEqual(["p0", "p1", "p2"]);
    expect(sampled.playlists).toEqual([{ name: "Keepers", pids: ["p0", "p1", "p2"] }]);
  });

  it("trims a name whose playlist sampling emptied", () => {
    // Only reachable from inconsistent input — a track naming a playlist that
    // does not list it back — but the two sides still have to agree afterwards,
    // or the matrix builds a column the playlist filter cannot offer.
    const lib: Library = {
      ...library(4),
      playlists: [
        { name: "Kept", pids: ["p0", "p1"] },
        { name: "Emptied", pids: ["p3"] },
      ],
    };
    lib.tracks[0].playlists = ["Kept", "Emptied"];
    const sampled = downsampleLibrary(lib, 2, cyclic([0]));

    expect(sampled.tracks.map((t) => t.pid)).toEqual(["p0", "p1"]);
    expect(sampled.playlists.map((p) => p.name)).toEqual(["Kept"]);
    expect(sampled.tracks[0].playlists).toEqual(["Kept"]);
  });

  it("leaves a name the parser never made a playlist for alone", () => {
    // droppedPlaylists are recorded, not represented, and sampling is not the
    // place to start editing membership it did not change.
    const lib: Library = { ...library(4), playlists: [{ name: "Kept", pids: ["p0", "p1"] }] };
    lib.tracks[0].playlists = ["Kept", "Never a playlist"];
    const sampled = downsampleLibrary(lib, 2, cyclic([0]));

    expect(sampled.tracks[0].playlists).toEqual(["Kept", "Never a playlist"]);
  });

  it("leaves the source library alone", () => {
    const lib = library(5, [{ name: "All", pids: ["p0", "p1", "p2", "p3", "p4"] }]);
    downsampleLibrary(lib, 2, cyclic([0]));

    expect(lib.tracks).toHaveLength(5);
    expect(lib.playlists[0].pids).toHaveLength(5);
    expect(lib.tracks[0].playlists).toEqual(["All"]);
  });

  it("carries the rest of the library through", () => {
    const sampled = downsampleLibrary(library(50), 10);
    expect(sampled.droppedPlaylists).toEqual(["Recently Added"]);
  });

  it("can reach the last track, so the tail is not excluded", () => {
    // A sample that could never pick the final row would bias every export
    // towards whatever was added first.
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      for (const t of downsampleLibrary(library(10), 5).tracks) seen.add(t.pid);
    }
    expect(seen.size).toBe(10);
  });

  it("spreads picks roughly evenly across the file", () => {
    // Uniformity is the property that makes the sample worth trusting: a map of
    // a biased sample is a map of the bias.
    const counts = new Map<string, number>();
    const runs = 3000;
    for (let i = 0; i < runs; i++) {
      for (const t of downsampleLibrary(library(10), 5).tracks) {
        counts.set(t.pid, (counts.get(t.pid) ?? 0) + 1);
      }
    }
    // Each of 10 tracks should appear in about half of the runs.
    for (const [, n] of counts) {
      expect(n / runs).toBeGreaterThan(0.4);
      expect(n / runs).toBeLessThan(0.6);
    }
  });
});
