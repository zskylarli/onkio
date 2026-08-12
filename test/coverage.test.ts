import { describe, expect, it } from "vitest";
import {
  collectionCoverage,
  describeOutstanding,
  describeSoundInfluence,
  needsLookup,
} from "../src/collections/coverage";
import type { CollectionMeta, Library, Track } from "../src/types";

let seq = 0;

function track(collection: string, over: Partial<Track> = {}): Track {
  seq++;
  return {
    pid: over.pid ?? `pid-${seq}`,
    trackId: seq,
    name: `Track ${seq}`,
    durationMs: 200_000,
    playlists: [],
    collection,
    ...over,
  };
}

function meta(id: string, format: "rekordbox" | "apple" = "rekordbox"): CollectionMeta {
  return { id, label: id, format, trackCount: 0, addedAt: "2026-01-01T00:00:00Z" };
}

function library(collections: CollectionMeta[], tracks: Track[]): Library {
  return { tracks, playlists: [], droppedPlaylists: [], collections };
}

describe("needsLookup", () => {
  it("targets tracks missing BPM or key", () => {
    expect(needsLookup(track("a"))).toBe(true);
    expect(needsLookup(track("a", { bpm: 124 }))).toBe(true);
    expect(needsLookup(track("a", { key: "8A" }))).toBe(true);
    expect(needsLookup(track("a", { bpm: 124, key: "8A" }))).toBe(false);
  });

  it("does not treat a missing preview as outstanding work", () => {
    // The regression this guards: previews serve sound analysis, which fetches
    // its own on demand. Counting them here queued every rekordbox track for
    // lookup even though all of them already had BPM and key.
    const complete = track("rb", { bpm: 124, key: "8A", previewUrl: undefined });
    expect(needsLookup(complete)).toBe(false);
  });
});

describe("collectionCoverage", () => {
  const rb = meta("crate", "rekordbox");
  const am = meta("listening", "apple");

  const lib = library(
    [rb, am],
    [
      track("crate", { bpm: 124, key: "8A" }),
      track("crate", { bpm: 126, key: "9A" }),
      track("crate", { bpm: 128, key: "4A", timbre: new Float32Array([1, 2]) }),
      track("listening"),
      track("listening", { previewUrl: "https://example.test/a.m4a" }),
    ]
  );

  it("reports each file separately rather than pooling them", () => {
    const rows = collectionCoverage(lib);
    expect(rows.map((r) => r.id)).toEqual(["crate", "listening"]);

    const crate = rows[0];
    expect(crate.total).toBe(3);
    expect(crate.bpm).toBe(3);
    expect(crate.key).toBe(3);
    expect(crate.incomplete).toBe(0);

    const listening = rows[1];
    expect(listening.total).toBe(2);
    expect(listening.bpm).toBe(0);
    expect(listening.incomplete).toBe(2);
  });

  it("keeps a complete collection distinguishable from the pooled average", () => {
    // Pooled, this library is 60% BPM, a number describing neither file.
    const rows = collectionCoverage(lib);
    const pct = (r: (typeof rows)[number]) => (r.bpm / r.total) * 100;
    expect(pct(rows[0])).toBe(100);
    expect(pct(rows[1])).toBe(0);
  });

  it("counts sound and preview per file", () => {
    const rows = collectionCoverage(lib);
    expect(rows[0].sound).toBe(1);
    expect(rows[0].preview).toBe(0);
    expect(rows[1].sound).toBe(0);
    expect(rows[1].preview).toBe(1);
  });

  it("counts local files per collection from the tracks that resolved", () => {
    const resolved = new Set([lib.tracks[0].pid, lib.tracks[3].pid]);
    const rows = collectionCoverage(lib, resolved);
    expect(rows[0].local).toBe(1);
    expect(rows[1].local).toBe(1);
  });

  it("reports no local files when no folder is connected", () => {
    // Availability is deliberately not stored on the track: a saved library
    // claiming local audio after the folder was revoked would be a lie.
    const rows = collectionCoverage(lib);
    expect(rows.every((r) => r.local === 0)).toBe(true);
  });

  it("preserves import order", () => {
    const reversed = library([am, rb], lib.tracks);
    expect(collectionCoverage(reversed).map((r) => r.id)).toEqual(["listening", "crate"]);
  });

  it("gathers tracks with no collection instead of dropping them", () => {
    const orphan: Track = { ...track("x", { bpm: 120, key: "1A" }), collection: undefined };
    const rows = collectionCoverage(library([rb], [track("crate", { bpm: 124, key: "8A" }), orphan]));
    expect(rows).toHaveLength(2);
    expect(rows[1].label).toBe("Unfiled");
    expect(rows[1].total).toBe(1);
    // Every track on the map is accounted for somewhere in the readout.
    expect(rows.reduce((s, r) => s + r.total, 0)).toBe(2);
  });

  it("omits a collection whose tracks have all been removed", () => {
    const rows = collectionCoverage(library([rb, am], [track("crate", { bpm: 1, key: "1A" })]));
    expect(rows.map((r) => r.id)).toEqual(["crate"]);
  });

  it("infers format from the pid prefix when metadata is gone", () => {
    const orphan: Track = { ...track("x"), pid: "rb:abc123", collection: undefined };
    const rows = collectionCoverage(library([], [orphan]));
    expect(rows[0].format).toBe("rekordbox");
  });
});

describe("describeSoundInfluence", () => {
  it("holds the slider shut while no track has been listened to", () => {
    // A full rebuild that cannot move a single point is the failure this
    // replaces: "Building features…" then "Embedded in 2.8s", identical map.
    const rows = collectionCoverage(
      library([meta("crate")], [track("crate", { bpm: 124 }), track("crate")])
    );
    const { enabled, note } = describeSoundInfluence(rows);
    expect(enabled).toBe(false);
    expect(note).toContain("no sound to weigh");
    expect(note).toContain("Analyze sound in view");
  });

  it("opens it once there is sound, and says how much of the library moves", () => {
    const rows = collectionCoverage(
      library(
        [meta("crate")],
        [
          track("crate", { timbre: new Float32Array([1, 2]) }),
          track("crate"),
          track("crate"),
          track("crate"),
        ]
      )
    );
    const { enabled, note } = describeSoundInfluence(rows);
    expect(enabled).toBe(true);
    expect(note).toContain("1 of 4 tracks");
  });

  it("counts sound across every loaded file, not just the first", () => {
    const rows = collectionCoverage(
      library(
        [meta("crate"), meta("listening", "apple")],
        [track("crate"), track("listening", { timbre: new Float32Array([1]) })]
      )
    );
    expect(describeSoundInfluence(rows).enabled).toBe(true);
  });

  it("stays shut on an empty library rather than dividing by nothing", () => {
    expect(describeSoundInfluence([])).toEqual({
      enabled: false,
      note: expect.stringContaining("no sound to weigh"),
    });
  });
});

describe("describeOutstanding", () => {
  it("names the file that needs work and the one being skipped", () => {
    const rows = collectionCoverage(
      library(
        [meta("crate"), meta("listening", "apple")],
        [track("crate", { bpm: 124, key: "8A" }), track("listening"), track("listening")]
      )
    );
    const text = describeOutstanding(rows);
    expect(text).toContain("listening (2 of 2)");
    expect(text).toContain("Skipping crate");
  });

  it("says so when there is nothing left to look up", () => {
    const rows = collectionCoverage(
      library([meta("crate")], [track("crate", { bpm: 124, key: "8A" })])
    );
    expect(describeOutstanding(rows)).toBe("Every track has BPM and key.");
  });

  it("does not claim to skip anything when every file has gaps", () => {
    const rows = collectionCoverage(
      library([meta("a"), meta("b")], [track("a"), track("b")])
    );
    expect(describeOutstanding(rows)).not.toContain("Skipping");
  });
});
