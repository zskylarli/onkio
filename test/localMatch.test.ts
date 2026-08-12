import { describe, expect, it } from "vitest";
import {
  buildFileIndex,
  describeResolution,
  isSyntheticLocation,
  NO_LOCAL_FILE_PREFIX,
  pathSegments,
  resolveLocation,
  resolveTracks,
  trailingMatchLength,
} from "../src/local/match";
import type { Track } from "../src/types";

/**
 * The File System Access API cannot run here, so the folder is represented the
 * way the matcher actually sees it: a list of paths relative to whatever the
 * user picked.
 */

let seq = 0;

function track(location: string | undefined, over: Partial<Track> = {}): Track {
  seq++;
  return {
    pid: over.pid ?? `pid-${seq}`,
    trackId: seq,
    name: `Track ${seq}`,
    durationMs: 200_000,
    playlists: [],
    location,
    ...over,
  };
}

/** How rekordbox writes a path into a collection export. */
function exported(path: string): string {
  return `file://localhost${path.split("/").map(encodeURIComponent).join("/")}`;
}

describe("pathSegments", () => {
  it("splits on either separator so a Windows export resolves too", () => {
    expect(pathSegments("/Users/sky/Music/Track.aiff")).toEqual([
      "Users",
      "sky",
      "Music",
      "Track.aiff",
    ]);
    expect(pathSegments("C:\\Users\\sky\\Music\\Track.aiff")).toEqual([
      "C:",
      "Users",
      "sky",
      "Music",
      "Track.aiff",
    ]);
  });

  it("drops empty segments from leading, trailing and doubled separators", () => {
    expect(pathSegments("//Music//House//")).toEqual(["Music", "House"]);
    expect(pathSegments("")).toEqual([]);
  });
});

describe("trailingMatchLength", () => {
  it("counts agreeing segments from the filename backwards", () => {
    const a = pathSegments("/Users/sky/Music/House/Track.aiff");
    expect(trailingMatchLength(a, pathSegments("House/Track.aiff"))).toBe(2);
    expect(trailingMatchLength(a, pathSegments("Music/House/Track.aiff"))).toBe(3);
    expect(trailingMatchLength(a, pathSegments("Techno/Track.aiff"))).toBe(1);
    expect(trailingMatchLength(a, pathSegments("House/Other.aiff"))).toBe(0);
  });

  it("stops at the shorter path rather than running off the end", () => {
    expect(trailingMatchLength(pathSegments("Track.aiff"), pathSegments("a/b/Track.aiff"))).toBe(1);
  });
});

describe("resolveLocation", () => {
  it("resolves a library exported on another machine by the tail of the path", () => {
    // The whole point: the export's root is gone, the tail is what carries over.
    const index = buildFileIndex(["House/Deep/Track.aiff"]);
    const r = resolveLocation(index, exported("/Users/skylarli/Music/House/Deep/Track.aiff"));
    expect(r).toEqual({ kind: "matched", file: 0, depth: 3 });
  });

  it("resolves a filename carrying spaces and square brackets", () => {
    // A real personal bounce, and the URL-encoded form rekordbox writes for it.
    const name = "Ice Cold Adryft Remix [Extended] Master.m4a";
    const index = buildFileIndex([`Masters/${name}`]);
    const location = exported(`/Users/skylarli/Music/Bounces/${name}`);
    expect(location).toContain("%5BExtended%5D");
    expect(resolveLocation(index, location)).toEqual({
      kind: "matched",
      file: 0,
      depth: 1,
    });
  });

  it("prefers the deeper trailing match when a filename repeats", () => {
    const index = buildFileIndex([
      "Albums/Nightfall/Intro.mp3",
      "Albums/Daybreak/Intro.mp3",
    ]);
    const r = resolveLocation(index, exported("/Volumes/DJ/Albums/Daybreak/Intro.mp3"));
    expect(r).toEqual({ kind: "matched", file: 1, depth: 3 });
  });

  it("refuses to guess when the best match is a tie", () => {
    // Colliding basenames are normal in a real library, and binding a track to
    // the wrong audio would then be played, analyzed and embedded as the track.
    const index = buildFileIndex(["Nightfall/Intro.mp3", "Daybreak/Intro.mp3"]);
    const r = resolveLocation(index, exported("/Volumes/DJ/Rescued/Intro.mp3"));
    expect(r).toEqual({ kind: "ambiguous", files: [0, 1] });
  });

  it("falls back to the filename alone when no folder above it agrees", () => {
    const index = buildFileIndex(["Everything/Track.wav"]);
    expect(resolveLocation(index, exported("/mnt/old/Crates/Track.wav"))).toEqual({
      kind: "matched",
      file: 0,
      depth: 1,
    });
  });

  it("reports no match rather than the nearest thing available", () => {
    const index = buildFileIndex(["House/Other.aiff"]);
    expect(resolveLocation(index, exported("/Users/sky/House/Track.aiff"))).toEqual({
      kind: "unmatched",
    });
  });

  it("ignores case and Unicode composition, which differ between disk and export", () => {
    // macOS stores filenames decomposed; an export may carry the composed form.
    const composed = "Caf\u00e9 Del Mar.mp3";
    const decomposed = "Cafe\u0301 Del Mar.mp3";
    expect(composed).not.toBe(decomposed);
    const index = buildFileIndex([`Chill/${decomposed}`]);
    const r = resolveLocation(index, exported(`/Users/sky/Music/CHILL/${composed}`));
    expect(r).toEqual({ kind: "matched", file: 0, depth: 2 });
  });

  it("matches a Windows export against a folder walked with forward slashes", () => {
    const index = buildFileIndex(["Crates/Track.flac"]);
    const r = resolveLocation(index, "file://localhost/D:/Music/Crates/Track.flac");
    expect(r).toEqual({ kind: "matched", file: 0, depth: 2 });
  });

  it("accepts a location that was already decoded when it was parsed", () => {
    // rekordbox locations are decoded at parse time, Apple's are not, so both
    // forms reach the matcher and both have to resolve.
    const index = buildFileIndex(["House/My Track.mp3"]);
    expect(resolveLocation(index, "/Users/sky/Music/House/My Track.mp3")).toEqual({
      kind: "matched",
      file: 0,
      depth: 2,
    });
  });

  it("treats an empty folder as no match instead of failing", () => {
    expect(resolveLocation(buildFileIndex([]), exported("/a/Track.mp3"))).toEqual({
      kind: "unmatched",
    });
  });
});

/** The stand-in path used where a source records none. */
function synthetic(applePid: string): string {
  return `file://localhost${NO_LOCAL_FILE_PREFIX}${applePid}`;
}

describe("isSyntheticLocation", () => {
  it("recognizes the stand-in path a pathless export is pinned with", () => {
    expect(isSyntheticLocation(synthetic("C5D490057BA1DC92"))).toBe(true);
    expect(isSyntheticLocation(`${NO_LOCAL_FILE_PREFIX}C5D490057BA1DC92`)).toBe(true);
  });

  it("leaves a real path alone, including one that merely mentions the folder", () => {
    expect(isSyntheticLocation(exported("/Users/sky/Music/Track.aiff"))).toBe(false);
    expect(isSyntheticLocation(exported("/Users/sky/Onkio/no-local-file/Track.aiff"))).toBe(false);
  });
});

describe("resolveTracks", () => {
  const index = buildFileIndex([
    "House/Deep/Track A.aiff",
    "Albums/One/Intro.mp3",
    "Albums/Two/Intro.mp3",
  ]);

  const tracks = [
    track(exported("/Users/sky/Music/House/Deep/Track A.aiff"), { pid: "found" }),
    track(exported("/Users/sky/Music/Elsewhere/Intro.mp3"), { pid: "tied" }),
    track(exported("/Users/sky/Music/Missing.wav"), { pid: "absent" }),
    track(undefined, { pid: "pathless" }),
  ];

  it("separates what resolved from what was ambiguous and what was absent", () => {
    const r = resolveTracks(tracks, index);
    expect([...r.matched]).toEqual([["found", 0]]);
    expect([...r.ambiguous]).toEqual([["tied", [1, 2]]]);
    expect(r.unmatched).toEqual(["absent"]);
    expect(r.withoutLocation).toBe(1);
  });

  it("puts every track in exactly one bucket, so the readout adds up", () => {
    const r = resolveTracks(tracks, index);
    const total =
      r.matched.size + r.ambiguous.size + r.unmatched.length + r.withoutLocation;
    expect(total).toBe(tracks.length);
  });

  it("resolves nothing when the folder holds no audio", () => {
    const r = resolveTracks(tracks, buildFileIndex([]));
    expect(r.matched.size).toBe(0);
    expect(r.unmatched).toEqual(["found", "tied", "absent"]);
  });

  it("counts a stand-in path as no path rather than as a file gone missing", () => {
    // The export recorded nothing, so there is nothing for the folder to fail
    // at. Calling these misses sent people looking for files that never existed.
    const pinned = [
      track(synthetic("C5D490057BA1DC92"), { pid: "no-path-1" }),
      track(synthetic("7D2025A917A52A56"), { pid: "no-path-2" }),
      track(exported("/Users/sky/Music/House/Deep/Track A.aiff"), { pid: "real" }),
    ];
    const r = resolveTracks(pinned, index);
    expect(r.withoutLocation).toBe(2);
    expect(r.unmatched).toEqual([]);
    expect([...r.matched.keys()]).toEqual(["real"]);
  });

  it("still puts every track in exactly one bucket with stand-in paths mixed in", () => {
    const mixed = [...tracks, track(synthetic("80BA2A532B9D4AB4"), { pid: "pinned" })];
    const r = resolveTracks(mixed, index);
    const total =
      r.matched.size + r.ambiguous.size + r.unmatched.length + r.withoutLocation;
    expect(total).toBe(mixed.length);
    expect(r.withoutLocation).toBe(2);
  });
});

describe("describeResolution", () => {
  it("names ambiguity and misses instead of folding them into one total", () => {
    const r = resolveTracks(
      [
        track(exported("/m/A/Track.mp3"), { pid: "a" }),
        track(exported("/m/Elsewhere/Intro.mp3"), { pid: "b" }),
        track(exported("/m/Gone.mp3"), { pid: "c" }),
      ],
      buildFileIndex(["A/Track.mp3", "One/Intro.mp3", "Two/Intro.mp3"])
    );
    const text = describeResolution(r, 3);
    expect(text).toContain("1 of 3 tracks play from this folder");
    expect(text).toContain("several files share the same name");
    expect(text).toContain("1 not found here");
    expect(text).toContain("3 audio files scanned");
  });

  it("says a pathless track was never looked for rather than not found", () => {
    const r = resolveTracks(
      [
        track(exported("/m/A/Track.mp3"), { pid: "a" }),
        track(synthetic("C5D490057BA1DC92"), { pid: "b" }),
        track(exported("/m/Gone.mp3"), { pid: "c" }),
      ],
      buildFileIndex(["A/Track.mp3"])
    );
    const text = describeResolution(r, 1);
    expect(text).toContain("1 not found here");
    expect(text).toContain("1 with no path recorded to match");
  });

  it("stays a single clean sentence when everything resolved", () => {
    const r = resolveTracks(
      [track(exported("/m/A/Track.mp3"))],
      buildFileIndex(["A/Track.mp3"])
    );
    const text = describeResolution(r, 1);
    expect(text).toContain("1 of 1 track plays from this folder");
    expect(text).not.toContain("not found");
    expect(text).not.toContain("share the same name");
  });
});
