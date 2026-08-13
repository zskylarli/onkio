import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { detectCollectionFormat } from "../src/parse/format";
import { decodeRekordboxTxt, parseRekordboxTxt } from "../src/parse/rekordboxTxt";

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "example.txt");
const fixture = decodeRekordboxTxt(readFileSync(fixturePath));

describe("rekordbox TXT parsing", () => {
  const library = parseRekordboxTxt(fixture);

  it("parses the fixed export fixture and its available metadata", () => {
    expect(library.tracks).toHaveLength(860);
    expect(library.playlists).toEqual([]);
    expect(library.droppedPlaylists).toEqual([]);
    expect(library.stats).toEqual({
      parsed: 860,
      skipped: 0,
      withBpm: 857,
      withKey: 860,
    });

    expect(library.tracks[0]).toMatchObject({
      trackId: 1,
      name: "Alanis' Interlude",
      artist: "Halsey & Alanis Morissette",
      album: "Manic",
      genre: "Alternative",
      bpm: 94,
      key: "9A",
      durationMs: 161_000,
      dateAdded: "2026-08-12T00:00:00.000Z",
      confidence: { bpm: 1, key: 1 },
      source: { bpm: "rekordbox", key: "rekordbox" },
    });
  });

  it("does not fabricate metadata absent from TXT", () => {
    for (const track of library.tracks) {
      expect(track.location).toBeUndefined();
      expect(track.year).toBeUndefined();
      expect(track.label).toBeUndefined();
      expect(track.playlists).toEqual([]);
    }
    expect(library.tracks.find((track) => track.trackId === 466)?.album).toBeUndefined();
  });

  it("creates stable unique format-specific persistent ids", () => {
    const again = parseRekordboxTxt(fixture);
    const pids = library.tracks.map((track) => track.pid);
    expect(new Set(pids).size).toBe(library.tracks.length);
    expect(pids.every((pid) => pid.startsWith("rbtxt:"))).toBe(true);
    expect(again.tracks.map((track) => track.pid)).toEqual(pids);
  });

  it("rejects files that do not carry the fixed header", () => {
    expect(() => parseRekordboxTxt("#\tTrack Title\n1\tA")).toThrow(
      /Not a supported rekordbox TXT export/
    );
  });
});

describe("collection format detection", () => {
  it("recognizes TXT by extension or its exact header", () => {
    expect(detectCollectionFormat("crate.txt", fixture.slice(0, 200))).toBe("rekordbox-txt");
    expect(detectCollectionFormat("crate.export", fixture.slice(0, 200))).toBe(
      "rekordbox-txt"
    );
  });

  it("leaves both XML formats unchanged", () => {
    expect(detectCollectionFormat("crate.xml", "<DJ_PLAYLISTS Version=\"1.0\">")).toBe(
      "rekordbox"
    );
    expect(detectCollectionFormat("Library.xml", "<?xml?><plist>")).toBe("apple");
  });
});
