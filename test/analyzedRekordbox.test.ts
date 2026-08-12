import { beforeAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRekordboxParser, parseRekordbox } from "../src/parse/rekordbox";
import { toCamelot } from "../src/music/camelot";
import type { Library, Track } from "../src/types";
import {
  ANALYZED_FULL_XML,
  ANALYZED_XML,
  APPLE_XML,
  GSB_RESULTS,
  GSB_RESULTS_ALL,
  GSB_RESULTS_REMAINDER,
  buildAnalyzedRekordbox,
  renderRekordboxXml,
} from "../scripts/analyzed-rekordbox";
import { parseAppleLibrary } from "../scripts/analyzed-subset";

/**
 * The emitted collection has to come back out of the app's own parser as what
 * went in. A file that looks right and imports wrong is worse than no file:
 * the numbers it carries are the whole reason it exists, and a track that
 * silently loses its key, gains a duration 1000x too large, or fuses with
 * another one would land somewhere confidently wrong on the map.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures");
const XML_PATH = join(FIXTURES, ANALYZED_XML);

/** Tracks resolved by the GetSongBPM trial, as recorded in the checkpoint. */
const EXPECTED_TRACKS = 311;
const EXPECTED_PLAYLISTS = 75;
/** Playlist memberships, counting a track once per playlist that holds it. */
const EXPECTED_MEMBERSHIPS = 367;

const xml = readFileSync(XML_PATH, "utf8");
const col = parseRekordbox(xml);
const byName = (name: string, artist: string): Track =>
  col.tracks.find((t) => t.name === name && t.artist === artist)!;

describe("the analyzed collection as the app reads it", () => {
  it("is auto-detected as rekordbox", () => {
    // main.ts sniffs only the first 4096 bytes of the dropped file.
    expect(xml.slice(0, 4096)).toContain("DJ_PLAYLISTS");
  });

  it("gives back every track it declares, with none filtered out", () => {
    expect(col.stats.declared).toBe(EXPECTED_TRACKS);
    expect(col.tracks).toHaveLength(EXPECTED_TRACKS);
    expect(col.stats.parsed).toBe(EXPECTED_TRACKS);
    // No track is short and tempo-less enough to look like a sampler one-shot.
    expect(col.stats.skipped).toBe(0);
  });

  it("covers BPM and key completely", () => {
    expect(col.stats.withBpm).toBe(EXPECTED_TRACKS);
    expect(col.stats.withKey).toBe(EXPECTED_TRACKS);
    for (const t of col.tracks) {
      expect(t.bpm).toBeGreaterThan(40);
      expect(t.bpm).toBeLessThan(220);
      expect(t.key).toMatch(/^(?:[1-9]|1[0-2])[AB]$/);
    }
  });

  it("keeps the semantic fields the embedding needs", () => {
    for (const t of col.tracks) {
      expect(t.artist).toBeTruthy();
      expect(t.album).toBeTruthy();
      expect(t.genre).toBeTruthy();
      expect(t.year).toBeGreaterThan(1900);
      expect(t.durationMs).toBeGreaterThan(30_000);
    }
    expect(new Set(col.tracks.map((t) => t.genre)).size).toBeGreaterThan(10);
  });

  it("reads durations as minutes, not as hours", () => {
    // TotalTime is seconds in this format and the parser multiplies by 1000;
    // emitting Apple's milliseconds verbatim would put every track at ~66h.
    const ms = col.tracks.map((t) => t.durationMs).sort((a, b) => a - b);
    expect(ms[0]).toBeGreaterThan(30_000);
    expect(ms[ms.length - 1]).toBeLessThan(900_000);
    expect(ms[Math.floor(ms.length / 2)]).toBeGreaterThan(120_000);
  });

  it("cannot collide with an Apple library loaded beside it", () => {
    expect(new Set(col.tracks.map((t) => t.pid)).size).toBe(EXPECTED_TRACKS);
    for (const t of col.tracks) {
      expect(t.pid.startsWith("rb:")).toBe(true);
      // Apple persistent ids are bare 16-hex-digit strings.
      expect(t.pid).not.toMatch(/^[0-9A-F]{16}$/);
    }
  });

  it("survives being fed in chunks, as the worker feeds it", () => {
    // Attribute values wrap across lines here, so a chunk boundary lands inside
    // a tag on any realistic chunk size.
    for (const size of [997, 4096, 65_536]) {
      const parser = createRekordboxParser();
      for (let i = 0; i < xml.length; i += size) parser.write(xml.slice(i, i + size));
      const streamed = parser.end();
      expect(streamed.tracks.map(fingerprint)).toEqual(col.tracks.map(fingerprint));
      expect(streamed.playlists).toEqual(col.playlists);
    }
  });
});

const fingerprint = (t: Track): string =>
  `${t.pid}|${t.name}|${t.artist}|${t.bpm}|${t.key}|${t.durationMs}`;

describe("field-by-field spot checks", () => {
  it("escapes and recovers an ampersand in an artist name", () => {
    const t = byName("Woman", "Mumford & Sons");
    expect(xml).toContain('Artist="Mumford &amp; Sons"');
    expect(t.album).toBe("Delta");
    expect(t.genre).toBe("Alternative");
    expect(t.year).toBe(2018);
    expect(t.durationMs).toBe(274_553);
    expect(t.bpm).toBe(156);
    expect(t.key).toBe("12A");
  });

  it("escapes and recovers an ampersand in a genre and a title", () => {
    const t = byName("Cold Sweat", "Tinashe");
    expect(xml).toContain('Genre="R&amp;B/Soul"');
    expect(t.genre).toBe("R&B/Soul");
    expect(t.durationMs).toBe(311_676);
    expect(t.bpm).toBe(130);
    expect(t.key).toBe("2A");

    const feat = byName("1999", "Charli xcx & Troye Sivan");
    expect(feat.bpm).toBe(123);
    expect(feat.key).toBe("9B");
    expect(feat.durationMs).toBe(189_200);
  });

  it("keeps a key that GetSongBPM spelled with a unicode sharp", () => {
    // Recorded as key_of "F♯m"; emitted as Camelot so it round-trips exactly.
    const t = byName("Green Light", "Lorde");
    expect(toCamelot("F♯m")).toBe("11A");
    expect(t.key).toBe("11A");
    expect(xml).toContain('Tonality="11A"');
    expect(t.bpm).toBe(129);
    expect(t.durationMs).toBe(234_653);
    expect(t.year).toBe(2017);
  });

  it("keeps tracks that share an artist and a title apart", () => {
    const almost = col.tracks.filter((t) => t.name === "Almost Love");
    expect(almost).toHaveLength(2);
    expect(new Set(almost.map((t) => t.pid)).size).toBe(2);
    const backRight = col.tracks.filter((t) =>
      t.name.startsWith("Break Your Heart Right Back")
    );
    expect(backRight).toHaveLength(3);
    expect(new Set(backRight.map((t) => t.pid)).size).toBe(3);
  });

  it("reads BPM and key as ground truth, since rekordbox is the user's own analysis", () => {
    for (const t of col.tracks) {
      expect(t.source).toEqual({ bpm: "rekordbox", key: "rekordbox" });
      expect(t.confidence).toEqual({ bpm: 1, key: 1 });
    }
  });
});

describe("playlists", () => {
  it("recovers every playlist, with membership inside the collection", () => {
    expect(col.playlists).toHaveLength(EXPECTED_PLAYLISTS);
    expect(col.droppedPlaylists).toEqual([]);
    const pids = new Set(col.tracks.map((t) => t.pid));
    for (const p of col.playlists) {
      expect(p.name).not.toBe("");
      expect(p.pids.length).toBeGreaterThan(0);
      for (const pid of p.pids) expect(pids.has(pid)).toBe(true);
    }
    // Playlist incidence is the widest block of the feature matrix, so losing
    // memberships would quietly change the map.
    expect(col.playlists.reduce((s, p) => s + p.pids.length, 0)).toBe(EXPECTED_MEMBERSHIPS);
    expect(col.tracks.filter((t) => t.playlists.length > 0)).toHaveLength(286);
  });

  it("keeps names that could have been mangled by the folder syntax", () => {
    const names = col.playlists.map((p) => p.name);
    expect(names).toContain("17 / 5"); // the parser joins folders with " / "
    expect(names).toContain("after/hours");
    expect(names).toContain("peter's housewarming");
    expect(names).toContain("alto contrarian "); // trailing space, as exported
    expect(new Set(names).size).toBe(names.length);
  });

  it("joins members by TrackID", () => {
    const p = col.playlists.find((x) => x.name === "17 / 5")!;
    expect(p.pids).toHaveLength(10);
    const members = p.pids.map((pid) => col.tracks.find((t) => t.pid === pid)!);
    expect(members.map((t) => t.name)).toContain("Tenerife Sea");
    for (const t of members) expect(t.playlists).toContain("17 / 5");
  });
});

describe("cases the source data does not exercise", () => {
  const awkward: Library = {
    tracks: [
      {
        pid: "APPLEPID00000001",
        trackId: 1,
        name: 'A "quoted" <title> & more',
        artist: "X\tY\nZ",
        album: "1 > 2",
        genre: "Drum & Bass",
        year: 2001,
        durationMs: 123_456,
        playlists: ['<odd> & "ends"'],
        bpm: 174.5,
        key: "12B",
      },
      {
        pid: "APPLEPID00000002",
        trackId: 2,
        name: "Downloaded",
        durationMs: 200_000,
        location: "file:///Users/dj/My%20Music/100%25%20Pure.mp3",
        playlists: [],
        bpm: 120,
        key: "8A",
      },
    ],
    playlists: [{ name: '<odd> & "ends"', pids: ["APPLEPID00000001"] }],
    droppedPlaylists: [],
  };
  const out = parseRekordbox(renderRekordboxXml(awkward));

  it("round-trips every character the parser decodes", () => {
    const t = out.tracks[0];
    expect(t.name).toBe('A "quoted" <title> & more');
    expect(t.artist).toBe("X\tY\nZ");
    expect(t.album).toBe("1 > 2");
    expect(t.genre).toBe("Drum & Bass");
    expect(t.durationMs).toBe(123_456);
    expect(t.bpm).toBe(174.5);
    expect(t.key).toBe("12B");
    expect(out.playlists).toEqual([{ name: '<odd> & "ends"', pids: [t.pid] }]);
  });

  it("keeps a real path when the export had one", () => {
    expect(out.tracks[1].location).toBe("/Users/dj/My Music/100% Pure.mp3");
  });

  it("pins identity to the Apple persistent id, not to the metadata", () => {
    // Regenerating after a rename or a re-export must not orphan an override.
    const edited: Library = {
      ...awkward,
      tracks: awkward.tracks.map((t) => ({
        ...t,
        name: `${t.name} (2024 Remaster)`,
        trackId: t.trackId + 900,
      })),
      playlists: [],
    };
    expect(parseRekordbox(renderRekordboxXml(edited)).tracks.map((t) => t.pid)).toEqual(
      out.tracks.map((t) => t.pid)
    );
  });
});

// ---------- against the sources it was generated from ----------

const SOURCES = [join(FIXTURES, APPLE_XML), join(FIXTURES, GSB_RESULTS)];

/**
 * `runIf` still evaluates the suite body while collecting, so anything that
 * touches an optional fixture has to wait for `beforeAll`, which does not run
 * when the suite is skipped.
 */
describe.runIf(SOURCES.every(existsSync))("against the Apple export it came from", () => {
  let built: ReturnType<typeof buildAnalyzedRekordbox>;
  beforeAll(() => {
    built = buildAnalyzedRekordbox(FIXTURES);
  });

  it("regenerates byte for byte", () => {
    expect(built.xml).toBe(xml);
  });

  it("carries every track of the trustworthy subset and nothing else", () => {
    expect(built.library.tracks).toHaveLength(EXPECTED_TRACKS);
    expect(built.audit.kept).toBe(EXPECTED_TRACKS);
    expect(col.tracks).toHaveLength(built.library.tracks.length);
  });

  it("agrees with the Apple source field by field", () => {
    const apple = new Map(
      parseAppleLibrary(join(FIXTURES, APPLE_XML)).tracks.map((t) => [t.trackId, t])
    );
    for (const t of col.tracks) {
      const src = apple.get(t.trackId)!;
      expect(src).toBeDefined();
      expect(t.name).toBe(src.name);
      expect(t.artist).toBe(src.artist);
      expect(t.album).toBe(src.album);
      expect(t.genre).toBe(src.genre);
      expect(t.year).toBe(src.year);
      // Milliseconds in, seconds out, milliseconds back: exactly equal.
      expect(t.durationMs).toBe(src.durationMs);
      // The Apple export has no BPM and no key anywhere; both came from the lookup.
      expect(src.bpm).toBeUndefined();
      expect(src.key).toBeUndefined();
    }
  });

  it("keeps the BPM and key the subset builder resolved", () => {
    const want = new Map(built.library.tracks.map((t) => [t.trackId, t]));
    for (const t of col.tracks) {
      const src = want.get(t.trackId)!;
      expect(t.bpm).toBe(src.bpm);
      expect(t.key).toBe(src.key);
    }
  });

  it("keeps playlist membership identical, restricted to the subset", () => {
    const emitted = new Map(col.tracks.map((t) => [t.pid, t.trackId]));
    const source = new Map(built.library.tracks.map((t) => [t.pid, t.trackId]));
    expect(col.playlists.map((p) => p.name)).toEqual(built.library.playlists.map((p) => p.name));
    for (const [i, p] of col.playlists.entries()) {
      // An Apple playlist may list a track twice; a rekordbox one cannot.
      const want = [...new Set(built.library.playlists[i].pids)].map((pid) => source.get(pid));
      expect(p.pids.map((pid) => emitted.get(pid))).toEqual(want);
    }
  });

  it("holds a playlist that listed a track twice, once", () => {
    const doubled = built.library.playlists.filter((p) => new Set(p.pids).size < p.pids.length);
    expect(doubled).toHaveLength(1);
    const p = col.playlists.find((x) => x.name === doubled[0].name)!;
    expect(new Set(p.pids).size).toBe(p.pids.length);
    expect(p.pids).toHaveLength(new Set(doubled[0].pids).size);
  });
});

// ---------- the same thing over the whole library ----------

/**
 * The trial sampled 1000 of 4381 tracks; a later sweep queried the other 3381
 * under the same gates, and the two checkpoints together make a collection
 * several times the size. Everything above still has to hold at that size — an
 * escaping or identity bug that 311 tracks never trip is exactly the kind that
 * surfaces once the input grows — and the trial's own 311 have to survive the
 * merge unchanged, since folding in more results must never restate an answer
 * that was already settled.
 */

const FULL_XML_PATH = join(FIXTURES, ANALYZED_FULL_XML);
const FULL_SOURCES = [...SOURCES, join(FIXTURES, GSB_RESULTS_REMAINDER)];

/** The trial's 311 plus the 1040 the sweep of the other 3381 resolved. */
const EXPECTED_FULL_TRACKS = 1351;
const EXPECTED_FULL_PLAYLISTS = 101;

describe.runIf(existsSync(FULL_XML_PATH))("the whole-library analyzed collection", () => {
  let fullXml: string;
  let fullCol: ReturnType<typeof parseRekordbox>;
  beforeAll(() => {
    fullXml = readFileSync(FULL_XML_PATH, "utf8");
    fullCol = parseRekordbox(fullXml);
  });

  it("is auto-detected as rekordbox", () => {
    expect(fullXml.slice(0, 4096)).toContain("DJ_PLAYLISTS");
  });

  it("gives back every track it declares, with none filtered out", () => {
    expect(fullCol.stats.declared).toBe(EXPECTED_FULL_TRACKS);
    expect(fullCol.tracks).toHaveLength(EXPECTED_FULL_TRACKS);
    expect(fullCol.stats.parsed).toBe(EXPECTED_FULL_TRACKS);
    expect(fullCol.stats.skipped).toBe(0);
  });

  it("covers BPM and key completely", () => {
    expect(fullCol.stats.withBpm).toBe(EXPECTED_FULL_TRACKS);
    expect(fullCol.stats.withKey).toBe(EXPECTED_FULL_TRACKS);
    for (const t of fullCol.tracks) {
      expect(t.bpm).toBeGreaterThan(0);
      expect(t.key).toMatch(/^(?:[1-9]|1[0-2])[AB]$/);
    }
  });

  it("carries the one tempo outside DJ range that the gates do not screen", () => {
    // Trustworthiness is judged on the match, not on the answer: a tempo only
    // has to parse as a positive number. Over 4381 tracks that lets exactly one
    // through above 220 (a 224 BPM reading), which is worth pinning — a jump
    // here means the matcher started accepting the wrong songs, not that
    // GetSongBPM changed its mind about a drum'n'bass record.
    const wild = fullCol.tracks.filter((t) => t.bpm! < 40 || t.bpm! > 220);
    expect(wild).toHaveLength(1);
    expect(wild[0].bpm).toBe(224);
  });

  it("keeps every track distinct at four times the size", () => {
    // The Location sentinel is the only thing separating two tracks that share
    // an artist and a title, and a bigger collection holds more such pairs.
    expect(new Set(fullCol.tracks.map((t) => t.pid)).size).toBe(EXPECTED_FULL_TRACKS);
    const byMetadata = new Set(fullCol.tracks.map((t) => `${t.artist}|${t.name}`));
    expect(byMetadata.size).toBeLessThan(EXPECTED_FULL_TRACKS);
  });

  it("reads durations as minutes, not as hours", () => {
    const ms = fullCol.tracks.map((t) => t.durationMs).sort((a, b) => a - b);
    expect(ms[0]).toBeGreaterThan(30_000);
    expect(ms[ms.length - 1]).toBeLessThan(3_600_000);
    expect(ms[Math.floor(ms.length / 2)]).toBeGreaterThan(120_000);
  });

  it("survives being fed in chunks, as the worker feeds it", () => {
    for (const size of [997, 65_536]) {
      const parser = createRekordboxParser();
      for (let i = 0; i < fullXml.length; i += size) parser.write(fullXml.slice(i, i + size));
      const streamed = parser.end();
      expect(streamed.tracks.map(fingerprint)).toEqual(fullCol.tracks.map(fingerprint));
      expect(streamed.playlists).toEqual(fullCol.playlists);
    }
  });

  it("recovers every playlist, with membership inside the collection", () => {
    expect(fullCol.droppedPlaylists).toEqual([]);
    expect(fullCol.playlists).toHaveLength(EXPECTED_FULL_PLAYLISTS);
    const pids = new Set(fullCol.tracks.map((t) => t.pid));
    for (const p of fullCol.playlists) {
      expect(p.name).not.toBe("");
      expect(p.pids.length).toBeGreaterThan(0);
      expect(new Set(p.pids).size).toBe(p.pids.length);
      for (const pid of p.pids) expect(pids.has(pid)).toBe(true);
    }
    expect(new Set(fullCol.playlists.map((p) => p.name)).size).toBe(fullCol.playlists.length);
  });

  it("contains the trial's collection unchanged", () => {
    const before = new Map(col.tracks.map((t) => [t.trackId, t]));
    const after = new Map(fullCol.tracks.map((t) => [t.trackId, t]));
    expect(before.size).toBe(EXPECTED_TRACKS);
    for (const [trackId, t] of before) {
      const now = after.get(trackId);
      expect(now).toBeDefined();
      expect(fingerprint(now!)).toBe(fingerprint(t));
    }
  });
});

describe.runIf(FULL_SOURCES.every(existsSync))("against the two checkpoints it came from", () => {
  let built: ReturnType<typeof buildAnalyzedRekordbox>;
  beforeAll(() => {
    built = buildAnalyzedRekordbox(FIXTURES, GSB_RESULTS_ALL);
  });

  it("regenerates byte for byte", () => {
    expect(built.xml).toBe(readFileSync(FULL_XML_PATH, "utf8"));
  });

  it("joins the two checkpoints without double-counting a track", () => {
    // The sweep excluded the trial's pids, so an overlap would mean the wrong
    // exclusion list was passed and some quota was spent twice.
    expect(built.audit.duplicatePids).toBe(0);
    expect(built.audit.unknownPids).toBe(0);
    expect(built.audit.recorded).toBe(built.audit.libraryTracks);
    expect(built.audit.kept).toBe(EXPECTED_FULL_TRACKS);
  });

  it("still refuses everything the title-only fallback found", () => {
    // The trial recorded 59 of these and 54 were wrong. They are the reason the
    // fallback is not shipped, so they must stay out however the results are
    // recombined; the sweep ran without it and contributed none.
    expect(built.audit.titleOnlyFallback).toBe(59);
  });

  it("agrees with the Apple source field by field", () => {
    const apple = new Map(
      parseAppleLibrary(join(FIXTURES, APPLE_XML)).tracks.map((t) => [t.trackId, t])
    );
    const emitted = parseRekordbox(built.xml);
    for (const t of emitted.tracks) {
      const src = apple.get(t.trackId)!;
      expect(src).toBeDefined();
      expect(t.name).toBe(src.name);
      expect(t.artist).toBe(src.artist);
      expect(t.durationMs).toBe(src.durationMs);
      expect(src.bpm).toBeUndefined();
      expect(src.key).toBeUndefined();
    }
  });
});
