import { describe, expect, it, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { StreamingPlistParser, decodeEntities } from "../src/parse/plist";
import { createLibraryParser } from "../src/parse/library";
import type { Library } from "../src/types";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "Library.xml");

const SMALL_DOC = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Tracks</key>
  <dict>
    <key>100</key>
    <dict>
      <key>Track ID</key><integer>100</integer>
      <key>Name</key><string>Fools Gold &amp; Silver</string>
      <key>Artist</key><string>想家 &#38; Friends</string>
      <key>Total Time</key><integer>240000</integer>
      <key>Genre</key><string>House</string>
      <key>Year</key><integer>1989</integer>
      <key>Persistent ID</key><string>AAAAAAAAAAAAAAA1</string>
    </dict>
    <key>102</key>
    <dict>
      <key>Track ID</key><integer>102</integer>
      <key>Name</key><string>Second</string>
      <key>Total Time</key><integer>180000</integer>
      <key>Persistent ID</key><string>AAAAAAAAAAAAAAA2</string>
    </dict>
  </dict>
  <key>Playlists</key>
  <array>
    <dict>
      <key>Name</key><string>Library</string>
      <key>Master</key><true/>
      <key>Playlist Items</key>
      <array>
        <dict><key>Track ID</key><integer>100</integer></dict>
        <dict><key>Track ID</key><integer>102</integer></dict>
      </array>
    </dict>
    <dict>
      <key>Name</key><string>Warmup</string>
      <key>Playlist Items</key>
      <array>
        <dict><key>Track ID</key><integer>100</integer></dict>
      </array>
    </dict>
  </array>
</dict>
</plist>`;

describe("decodeEntities", () => {
  it("decodes named and numeric entities", () => {
    expect(decodeEntities("A &amp; B &lt;C&gt; &#38; &#x26;")).toBe("A & B <C> & &");
  });
});

describe("StreamingPlistParser", () => {
  it("parses a document fed in 7-byte chunks (boundary safety)", () => {
    const tracks: string[] = [];
    const parser = new StreamingPlistParser({
      onTrack: (key) => tracks.push(key),
    });
    for (let i = 0; i < SMALL_DOC.length; i += 7) {
      parser.write(SMALL_DOC.slice(i, i + 7));
    }
    parser.end();
    expect(tracks).toEqual(["100", "102"]);
  });

  it("throws on truncated input", () => {
    const parser = new StreamingPlistParser({});
    parser.write("<plist><dict><key>Tracks</key><dict>");
    expect(() => parser.end()).toThrow(/unclosed/);
  });
});

describe("createLibraryParser", () => {
  function parse(doc: string): Library {
    const p = createLibraryParser();
    p.write(doc);
    return p.end();
  }

  it("maps fields, decodes entities and preserves CJK", () => {
    const lib = parse(SMALL_DOC);
    expect(lib.tracks).toHaveLength(2);
    const t = lib.tracks[0];
    expect(t.name).toBe("Fools Gold & Silver");
    expect(t.artist).toBe("想家 & Friends");
    expect(t.pid).toBe("AAAAAAAAAAAAAAA1");
    expect(t.year).toBe(1989);
    expect(t.durationMs).toBe(240000);
    // artist is optional (§2)
    expect(lib.tracks[1].artist).toBeUndefined();
  });

  it("joins playlists via Track ID → Persistent ID and drops auto ones", () => {
    const lib = parse(SMALL_DOC);
    expect(lib.playlists.map((p) => p.name)).toEqual(["Warmup"]);
    expect(lib.droppedPlaylists).toContain("Library");
    expect(lib.playlists[0].pids).toEqual(["AAAAAAAAAAAAAAA1"]);
    expect(lib.tracks[0].playlists).toEqual(["Warmup"]);
    expect(lib.tracks[1].playlists).toEqual([]);
  });
});

describe("full-size fixture (§8 phase 1 acceptance)", () => {
  beforeAll(() => {
    if (!existsSync(FIXTURE)) {
      execFileSync("node", [join(HERE, "..", "scripts", "generate-fixture.mjs"), FIXTURE]);
    }
  });

  it("parses 6,263 tracks and ~147 playlists in <3s", () => {
    const xml = readFileSync(FIXTURE, "utf8");
    const started = performance.now();
    const batches: number[] = [];
    const parser = createLibraryParser({
      onTrackBatch: (b) => batches.push(b.length),
    });
    // stream in 64 KiB chunks like the worker does
    for (let i = 0; i < xml.length; i += 65536) {
      parser.write(xml.slice(i, i + 65536));
    }
    const lib = parser.end();
    const elapsed = performance.now() - started;

    expect(lib.tracks).toHaveLength(6263);
    expect(lib.playlists.length).toBeGreaterThanOrEqual(140);
    expect(lib.playlists.length).toBeLessThanOrEqual(150);
    expect(lib.droppedPlaylists).toEqual(
      expect.arrayContaining(["Library", "Music", "Downloaded"])
    );
    expect(batches.reduce((a, b) => a + b, 0)).toBe(6263);
    expect(elapsed).toBeLessThan(3000);

    // ground-truth shape (§0)
    const covered = lib.tracks.filter((t) => t.playlists.length > 0).length;
    expect(covered / lib.tracks.length).toBeGreaterThan(0.9);
    const single = lib.tracks.filter((t) => t.playlists.length === 1).length;
    expect(single / covered).toBeGreaterThan(0.7);
    const withGenre = lib.tracks.filter((t) => t.genre).length;
    expect(withGenre).toBe(6263);
    const withLocation = lib.tracks.filter((t) => t.location).length;
    expect(withLocation).toBe(2);
    // every pid unique — the durable cache key (§2)
    expect(new Set(lib.tracks.map((t) => t.pid)).size).toBe(6263);
  });
});
