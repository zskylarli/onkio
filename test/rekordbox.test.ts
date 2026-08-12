import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createRekordboxParser,
  decodeEntities,
  decodeLocation,
  parseRekordbox,
  rekordboxPid,
  rekordboxTrack,
} from "../src/parse/rekordbox";

const SYNTHETIC = `<?xml version="1.0" encoding="UTF-8"?>
<DJ_PLAYLISTS Version="1.0.0">
  <PRODUCT Name="rekordbox" Version="6.7.0" Company="AlphaTheta"/>
  <COLLECTION Entries="6">
    <TRACK TrackID="1" Name="Above" Artist="Vitamin THC" Album="Deep Cuts"
           Genre="Tech House" Kind="MP3 File" TotalTime="222" Year="2020"
           AverageBpm="124.00" Tonality="6A" DateAdded="2021-01-02"
           Location="file://localhost/Users/dj/Music/Vitamin%20THC%20-%20Above.mp3"
           Remixer="" Label="Hot Creations" Mix=""/>
    <TRACK TrackID="2" Name="Love &amp; Fear &gt; All" Artist="Scissors &amp; Co."
           Genre="House" TotalTime="176" AverageBpm="125.00" Tonality="Am"
           Location="file://localhost/Users/dj/Music/love.mp3" Label=""/>
    <TRACK TrackID="3" Name="Open Key Tune" Artist="Someone" TotalTime="300"
           AverageBpm="128.00" Tonality="1m" Location="file://localhost/Users/dj/Music/ok.mp3"/>
    <TRACK TrackID="4" Name="NOISE" Artist="" Genre="" Kind="WAV File" TotalTime="5"
           Year="0" AverageBpm="0.00" Tonality=""
           Location="file://localhost/Users/dj/Music/PioneerDJ/Sampler/NOISE.wav"/>
    <TRACK TrackID="5" Name="No Metadata At All" TotalTime="200"
           Location="file://localhost/Users/dj/Music/plain.mp3"/>
    <TRACK TrackID="6" Name="Sharp Tune" Artist="Nobody" TotalTime="210"
           AverageBpm="140.5" Tonality="F#m" Location="file://localhost/Users/dj/Music/sharp.mp3"/>
  </COLLECTION>
  <PLAYLISTS>
    <NODE Type="0" Name="ROOT" Count="2">
      <NODE Name="Loosie&apos;s" Type="1" KeyType="0" Entries="2">
        <TRACK Key="1"/>
        <TRACK Key="2"/>
      </NODE>
      <NODE Type="0" Name="Crates" Count="2">
        <NODE Name="Deep" Type="1" KeyType="0" Entries="1">
          <TRACK Key="3"/>
        </NODE>
        <NODE Name="Empty" Type="1" KeyType="0" Entries="0"/>
      </NODE>
    </NODE>
  </PLAYLISTS>
</DJ_PLAYLISTS>`;

describe("rekordbox XML parsing", () => {
  const col = parseRekordbox(SYNTHETIC);

  it("reads attributes and decodes entities", () => {
    const t = col.tracks.find((x) => x.trackId === 2)!;
    expect(t.name).toBe("Love & Fear > All");
    expect(t.artist).toBe("Scissors & Co.");
  });

  it("treats TotalTime as seconds, not milliseconds", () => {
    expect(col.tracks.find((x) => x.trackId === 1)!.durationMs).toBe(222_000);
  });

  it("takes BPM and key as ground truth", () => {
    const t = col.tracks.find((x) => x.trackId === 1)!;
    expect(t.bpm).toBe(124);
    expect(t.key).toBe("6A");
    expect(t.source).toEqual({ bpm: "rekordbox", key: "rekordbox" });
    expect(t.confidence).toEqual({ bpm: 1, key: 1 });
  });

  it("normalizes every Tonality notation rekordbox can emit", () => {
    // Camelot as-is, classical, Open Key, and a unicode-free sharp.
    expect(col.tracks.find((x) => x.trackId === 1)!.key).toBe("6A"); // "6A"
    expect(col.tracks.find((x) => x.trackId === 2)!.key).toBe("8A"); // "Am"
    expect(col.tracks.find((x) => x.trackId === 3)!.key).toBe("8A"); // "1m"
    expect(col.tracks.find((x) => x.trackId === 6)!.key).toBe("11A"); // "F#m"
  });

  it("leaves missing and blank attributes undefined", () => {
    const t = col.tracks.find((x) => x.trackId === 5)!;
    expect(t.artist).toBeUndefined();
    expect(t.bpm).toBeUndefined();
    expect(t.key).toBeUndefined();
    expect(t.year).toBeUndefined();
    expect(t.tags).toBeUndefined();
    const blank = col.tracks.find((x) => x.trackId === 2)!;
    expect(blank.tags).toBeUndefined(); // Label="" is not a tag
    expect(col.tracks.find((x) => x.trackId === 1)!.tags).toEqual(["Hot Creations"]);
  });

  it("drops sampler one-shots and reports the count", () => {
    expect(col.tracks.some((t) => t.name === "NOISE")).toBe(false);
    expect(col.stats.skipped).toBe(1);
    expect(col.stats.declared).toBe(6);
    expect(col.stats.parsed).toBe(5);
    expect(col.stats.withBpm).toBe(4);
    expect(col.stats.withKey).toBe(4);
  });

  it("decodes the file location", () => {
    expect(col.tracks.find((x) => x.trackId === 1)!.location).toBe(
      "/Users/dj/Music/Vitamin THC - Above.mp3"
    );
  });

  it("flattens the playlist folder tree and joins track references", () => {
    expect(col.playlists.map((p) => p.name)).toEqual(["Loosie's", "Crates / Deep"]);
    expect(col.playlists[0].pids).toHaveLength(2);
    expect(col.playlists[1].pids).toEqual([
      col.tracks.find((t) => t.trackId === 3)!.pid,
    ]);
    expect(col.tracks.find((t) => t.trackId === 3)!.playlists).toEqual(["Crates / Deep"]);
    expect(col.droppedPlaylists).toEqual(["Crates / Empty"]);
  });

  it("survives being fed in arbitrary chunks", () => {
    for (const size of [1, 7, 64, 997]) {
      const p = createRekordboxParser();
      for (let i = 0; i < SYNTHETIC.length; i += size) {
        p.write(SYNTHETIC.slice(i, i + size));
      }
      const chunked = p.end();
      expect(chunked.tracks.map((t) => `${t.name}|${t.bpm}|${t.key}`)).toEqual(
        col.tracks.map((t) => `${t.name}|${t.bpm}|${t.key}`)
      );
      expect(chunked.playlists).toEqual(col.playlists);
    }
  });

  it("derives a deterministic pid from the file path", () => {
    const attrs = { Name: "x", Location: "file://localhost/Users/dj/a%20b.mp3", TrackID: "7" };
    expect(rekordboxPid(attrs)).toBe(rekordboxPid(attrs));
    // TrackID is a database row id and must not affect identity.
    expect(rekordboxPid({ ...attrs, TrackID: "999" })).toBe(rekordboxPid(attrs));
    expect(rekordboxPid({ ...attrs, Location: "file://localhost/Users/dj/other.mp3" })).not.toBe(
      rekordboxPid(attrs)
    );
    expect(rekordboxPid(attrs).startsWith("rb:")).toBe(true);
  });

  it("falls back to the row id only for attributes that name nothing", () => {
    // `Artist|Name` always carries its separator, so it is never empty and the
    // row id used to be unreachable: two rows with nothing but a TrackID hashed
    // to one pid. Nothing here can be a track, since a nameless track is
    // rejected, but the identity has to be distinct all the same.
    expect(rekordboxPid({ TrackID: "77" })).not.toBe(rekordboxPid({ TrackID: "78" }));
    expect(rekordboxPid({})).not.toBe(rekordboxPid({ TrackID: "77" }));
    // One field is enough to be named, and then the row id stops mattering.
    expect(rekordboxPid({ Name: "Ice Cold", TrackID: "1" })).toBe(
      rekordboxPid({ Name: "Ice Cold", TrackID: "2" })
    );
    expect(rekordboxPid({ Artist: "Adryft", TrackID: "1" })).toBe(
      rekordboxPid({ Artist: "Adryft", TrackID: "2" })
    );
  });

  it("keeps the pid every track that parses already had", () => {
    // pid is what overrides, caches and saved libraries are keyed on, so these
    // are pinned to the exact values the parser produced before the fallback
    // was made reachable. A change here invalidates users' stored data.
    expect(
      rekordboxPid({
        TrackID: "209501597",
        Name: "Ice Cold",
        Artist: "Adryft",
        Location: "file://localhost/Users/skylarli/Music/House/Ice%20Cold.aiff",
      })
    ).toBe("rb:44421abd091dfd13");
    expect(rekordboxPid({ TrackID: "42", Name: "Ice Cold", Artist: "Adryft" })).toBe(
      "rb:03a1fc0690467584"
    );
    expect(rekordboxPid({ TrackID: "42", Name: "Ice Cold" })).toBe("rb:e7ba091ca2d6647a");
    expect(rekordboxPid({ TrackID: "42", Artist: "Adryft" })).toBe("rb:684141f1e9f4e2a3");
    expect(rekordboxPid({ Name: "Caf\u00e9 Del Mar", Artist: "Energy 52" })).toBe(
      "rb:dc2ff07c73baac46"
    );
  });

  it("handles a '>' inside an attribute value", () => {
    const one = parseRekordbox(
      `<DJ_PLAYLISTS><COLLECTION Entries="1"><TRACK TrackID="1" Name="A -> B" TotalTime="100" AverageBpm="120"/></COLLECTION></DJ_PLAYLISTS>`
    );
    expect(one.tracks).toHaveLength(1);
    expect(one.tracks[0].name).toBe("A -> B");
  });

  it("returns null for a track with no name", () => {
    expect(rekordboxTrack({ TrackID: "1", Name: "" })).toBeNull();
  });
});

describe("entity and location decoding", () => {
  it("decodes named and numeric entities", () => {
    expect(decodeEntities("a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;")).toBe(
      `a & b <c> "d" 'e'`
    );
    expect(decodeEntities("&#65;&#x42;")).toBe("AB");
    expect(decodeEntities("no entities")).toBe("no entities");
  });

  it("strips the file://localhost prefix and percent-escapes", () => {
    expect(decodeLocation("file://localhost/Users/a/b%20c.mp3")).toBe("/Users/a/b c.mp3");
    expect(decodeLocation("file:///Users/a/b.mp3")).toBe("/Users/a/b.mp3");
    expect(decodeLocation("file://localhost/Users/a/100%.mp3")).toBe("/Users/a/100%.mp3");
  });
});

// ---------- the real export ----------

const HERE = dirname(fileURLToPath(import.meta.url));
const REAL = join(HERE, "fixtures", "Adryft_recordbox_collection_metadata.xml");

describe.runIf(existsSync(REAL))("a real rekordbox export", () => {
  const col = parseRekordbox(readFileSync(REAL, "utf8"));

  it("parses every declared entry", () => {
    expect(col.stats.declared).toBe(1079);
    expect(col.stats.parsed + col.stats.skipped).toBe(1079);
  });

  it("carries BPM and key for nearly the whole collection", () => {
    const withBpm = col.tracks.filter((t) => t.bpm !== undefined).length;
    const withKey = col.tracks.filter((t) => t.key !== undefined).length;
    expect(withBpm / col.tracks.length).toBeGreaterThan(0.95);
    expect(withKey / col.tracks.length).toBeGreaterThan(0.95);
  });

  it("produces plausible BPMs and valid Camelot keys", () => {
    for (const t of col.tracks) {
      if (t.bpm !== undefined) {
        expect(t.bpm).toBeGreaterThan(40);
        expect(t.bpm).toBeLessThan(220);
      }
      if (t.key !== undefined) expect(t.key).toMatch(/^(?:[1-9]|1[0-2])[AB]$/);
    }
  });

  it("gives every track a unique pid", () => {
    expect(new Set(col.tracks.map((t) => t.pid)).size).toBe(col.tracks.length);
  });

  it("recovers the user's playlists", () => {
    expect(col.playlists.length).toBeGreaterThan(20);
    expect(col.playlists.map((p) => p.name)).toContain("Loosie's");
    const all = col.playlists.find((p) => p.name === "ALL")!;
    expect(all.pids.length).toBeGreaterThan(700);
  });

  it("gives durations in a sane minutes range", () => {
    const withDur = col.tracks.filter((t) => t.durationMs > 0);
    const median = withDur.map((t) => t.durationMs).sort((a, b) => a - b)[
      Math.floor(withDur.length / 2)
    ];
    expect(median).toBeGreaterThan(60_000);
    expect(median).toBeLessThan(900_000);
  });
});
