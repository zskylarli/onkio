import { describe, expect, it } from "vitest";
import {
  ensureCollections,
  mergeLibraries,
  removeCollection,
  slugifyCollectionId,
  tagCollection,
  uniqueCollectionId,
} from "../src/collections/merge";
import type { CollectionMeta, Library, Track } from "../src/types";

let seq = 0;

function track(over: Partial<Track> = {}): Track {
  seq++;
  return {
    pid: over.pid ?? `pid-${seq}`,
    trackId: seq,
    name: over.name ?? `Track ${seq}`,
    durationMs: 200_000,
    playlists: [],
    ...over,
  };
}

function library(tracks: Track[], playlists: { name: string; pids: string[] }[] = []): Library {
  return { tracks, playlists, droppedPlaylists: [], collections: [] };
}

function meta(id: string, format: "rekordbox" | "apple" = "rekordbox"): CollectionMeta {
  return { id, label: id, format, trackCount: 0, addedAt: "2026-01-01T00:00:00Z" };
}

/** A parsed file the way `adoptImport` hands it over: tagged, one collection. */
function file(id: string, tracks: Track[], playlists: { name: string; pids: string[] }[] = []) {
  return tagCollection(library(tracks, playlists), meta(id));
}

describe("slugifyCollectionId", () => {
  it("makes a file name into an id", () => {
    expect(slugifyCollectionId("Adryft_recordbox_collection_metadata.xml")).toBe(
      "adryft-recordbox-collection-metadata"
    );
    expect(slugifyCollectionId("!!!.xml")).toBe("collection");
  });
});

describe("uniqueCollectionId", () => {
  it("suffixes rather than colliding, so two files of the same name stay apart", () => {
    const existing = [meta("crate"), meta("crate-2")];
    expect(uniqueCollectionId(existing, "crate")).toBe("crate-3");
    expect(uniqueCollectionId(existing, "other")).toBe("other");
  });
});

describe("mergeLibraries", () => {
  it("appends what is new and counts each collection's own tracks", () => {
    const base = file("crate", [track({ pid: "a" }), track({ pid: "b" })]);
    const incoming = file("listening", [track({ pid: "c" })]);
    const { library: merged, report } = mergeLibraries(base, incoming);

    expect(report.added).toBe(1);
    expect(report.duplicatePids).toBe(0);
    expect(report.redundant).toBe(false);
    expect(merged.tracks.map((t) => t.pid)).toEqual(["a", "b", "c"]);
    expect(merged.collections).toEqual([
      expect.objectContaining({ id: "crate", trackCount: 2 }),
      expect.objectContaining({ id: "listening", trackCount: 1 }),
    ]);
  });

  it("keeps the first copy of a shared track but gives it both playlists", () => {
    const shared = track({ pid: "same", playlists: ["Crate"] });
    const base = file("crate", [shared], [{ name: "Crate", pids: ["same"] }]);
    const incoming = file(
      "listening",
      [track({ pid: "same", playlists: ["Faves"] }), track({ pid: "new" })],
      [{ name: "Faves", pids: ["same"] }]
    );
    const { library: merged, report } = mergeLibraries(base, incoming);

    expect(report.added).toBe(1);
    expect(report.duplicatePids).toBe(1);
    expect(merged.tracks.find((t) => t.pid === "same")!.playlists).toEqual(["Crate", "Faves"]);
  });

  it("suffixes a clashing playlist name and rewrites the tracks that carry it", () => {
    const base = file("crate", [track({ pid: "a" })], [{ name: "Chill", pids: ["a"] }]);
    const incoming = file(
      "listening",
      [track({ pid: "b", playlists: ["Chill"] })],
      [{ name: "Chill", pids: ["b"] }]
    );
    const { library: merged, report } = mergeLibraries(base, incoming);

    expect(report.renamedPlaylists).toEqual([["Chill", "Chill [listening]"]]);
    expect(merged.playlists.map((p) => p.name)).toEqual(["Chill", "Chill [listening]"]);
    expect(merged.tracks.find((t) => t.pid === "b")!.playlists).toEqual(["Chill [listening]"]);
  });
});

/**
 * Importing a file that is already loaded. It is not a union of anything: it
 * adds no track, so a collection for it would own none, and its playlists are
 * the playlists already there.
 */
describe("mergeLibraries with a file that is already loaded", () => {
  const loaded = () =>
    file(
      "crate",
      [track({ pid: "a", playlists: ["Chill"] }), track({ pid: "b", playlists: ["Chill"] })],
      [{ name: "Chill", pids: ["a", "b"] }]
    );

  const again = () =>
    file(
      "crate-2",
      [track({ pid: "a", playlists: ["Chill"] }), track({ pid: "b", playlists: ["Chill"] })],
      [{ name: "Chill", pids: ["a", "b"] }]
    );

  it("reports the import as redundant rather than as an addition", () => {
    const { report } = mergeLibraries(loaded(), again());
    expect(report.redundant).toBe(true);
    expect(report.added).toBe(0);
    expect(report.duplicatePids).toBe(2);
  });

  it("adds no collection, so the rows still add up to the library", () => {
    const base = loaded();
    const { library: merged } = mergeLibraries(base, again());
    expect(merged.collections!.map((c) => c.id)).toEqual(["crate"]);
    const claimed = merged.collections!.reduce((n, c) => n + c.trackCount, 0);
    expect(claimed).toBe(merged.tracks.length);
    expect(merged.tracks).toHaveLength(2);
  });

  it("does not suffix playlists, which would file the same tracks twice", () => {
    const { library: merged, report } = mergeLibraries(loaded(), again());
    expect(report.renamedPlaylists).toEqual([]);
    expect(merged.playlists.map((p) => p.name)).toEqual(["Chill"]);
    expect(merged.tracks.every((t) => t.playlists.length === 1)).toBe(true);
  });

  it("treats a partial overlap as a real import, because it brings tracks", () => {
    const { library: merged, report } = mergeLibraries(
      loaded(),
      file("other", [track({ pid: "b" }), track({ pid: "c" })])
    );
    expect(report.redundant).toBe(false);
    expect(report.added).toBe(1);
    expect(merged.collections).toHaveLength(2);
    expect(merged.collections!.find((c) => c.id === "other")!.trackCount).toBe(1);
  });

  it("treats a file with no tracks the same way, since it adds none either", () => {
    const { library: merged, report } = mergeLibraries(loaded(), file("empty", []));
    expect(report.redundant).toBe(true);
    expect(report.duplicatePids).toBe(0);
    expect(merged.collections).toHaveLength(1);
  });
});

describe("removeCollection", () => {
  it("takes a collection's tracks and emptied playlists back out", () => {
    const base = file("crate", [track({ pid: "a" })], [{ name: "Crate", pids: ["a"] }]);
    const incoming = file(
      "listening",
      [track({ pid: "b", playlists: ["Faves"] })],
      [{ name: "Faves", pids: ["b"] }]
    );
    const { library: merged } = mergeLibraries(base, incoming);
    const left = removeCollection(merged, "listening");

    expect(left.tracks.map((t) => t.pid)).toEqual(["a"]);
    expect(left.playlists.map((p) => p.name)).toEqual(["Crate"]);
    expect(left.collections!.map((c) => c.id)).toEqual(["crate"]);
  });
});

describe("ensureCollections", () => {
  it("files a library saved before provenance existed under one collection", () => {
    const restored = library([track({ pid: "rb:1" }), track({ pid: "rb:2" })]);
    restored.collections = [];
    const out = ensureCollections(restored, "Imported library");
    expect(out.collections).toEqual([
      expect.objectContaining({ label: "Imported library", format: "rekordbox", trackCount: 2 }),
    ]);
    expect(out.tracks.every((t) => t.collection === out.collections![0].id)).toBe(true);
  });
});
