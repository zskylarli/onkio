import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ALL_FIELDS,
  neededFields,
  outstandingFields,
  type Field,
} from "../src/enrich/fields";
import type { CachedLookup } from "../src/store/db";
import type { FeatureLookup, Track } from "../src/types";

/**
 * Tiered, short-circuiting provider routing (§3.4).
 *
 * Every source is stubbed and every call is recorded in one shared list, so
 * these assert the two things that actually cost something: which tiers were
 * reached, and in what order. The three sources are paced at 1.3 s, ~0.45 s and
 * 3.2 s per track, so a tier reached for a field it was not needed for is not a
 * style problem.
 */

const order = vi.hoisted(() => ({ calls: [] as string[] }));
const gsb = vi.hoisted(() => ({
  enabled: false,
  answer: null as FeatureLookup | null,
  throws: false,
}));
const deezer = vi.hoisted(() => ({ answer: null as FeatureLookup | null }));
const apple = vi.hoisted(() => ({ answer: null as FeatureLookup | null }));

vi.mock("../src/enrich/sources/getsongbpm", () => ({
  isSongBpmEnabled: () => gsb.enabled,
  lookupGetSongBpm: async () => {
    order.calls.push("getsongbpm");
    if (gsb.throws) throw new Error("429 rate limited");
    return gsb.answer;
  },
}));
vi.mock("../src/enrich/sources/deezer", () => ({
  lookupDeezer: async () => {
    order.calls.push("deezer");
    return deezer.answer;
  },
}));
vi.mock("../src/enrich/sources/itunes", () => ({
  lookupItunes: async () => {
    order.calls.push("itunes");
    return apple.answer;
  },
}));

/** In-memory stand-in for the IndexedDB lookup cache, so a pass can be replayed. */
const cache = vi.hoisted(() => new Map<string, CachedLookup>());
vi.mock("../src/store/db", () => ({
  getCachedLookup: async (key: string) => cache.get(key),
  putCachedLookup: async (
    key: string,
    hit: boolean,
    data?: FeatureLookup,
    covered?: Field[]
  ) => {
    cache.set(key, { v: 3, ts: Date.now(), hit, data, covered });
  },
}));

const { getSourceStats, lookupFeatures, resetSourceStats } = await import(
  "../src/enrich/adapter"
);

const PREVIEW = "https://cdnt-preview.dzcdn.net/x.mp3?hdnea=exp=1786551864~acl=/*";
const APPLE_PREVIEW = "https://audio-ssl.itunes.apple.com/x.m4a";

function track(over: Partial<Track> = {}): Track {
  return {
    pid: "P1",
    trackId: 1,
    name: "Losing It",
    artist: "FISHER",
    durationMs: 210_000,
    playlists: [],
    ...over,
  };
}

/** One enrichment pass over a track, routed by what that track is missing. */
function pass(t: Track): Promise<FeatureLookup | null> {
  return lookupFeatures(t.artist, t.name, neededFields(t));
}

beforeEach(() => {
  order.calls = [];
  cache.clear();
  resetSourceStats();
  gsb.enabled = false;
  gsb.throws = false;
  gsb.answer = { bpm: 126, key: "8A", source: "getsongbpm" };
  deezer.answer = {
    previewUrl: PREVIEW,
    deezerId: 42,
    label: "Catch & Release",
    labelSource: "deezer",
    source: "deezer",
  };
  apple.answer = { previewUrl: APPLE_PREVIEW, tags: ["Dance"], source: "itunes" };
});

describe("tier order", () => {
  it("asks GetSongBPM first when the user has supplied a key", async () => {
    gsb.enabled = true;
    await lookupFeatures("FISHER", "Losing It", ["bpm", "key", "previewUrl", "label"]);
    expect(order.calls[0]).toBe("getsongbpm");
  });

  it("ends the cascade at GetSongBPM when bpm and key are all that is wanted", async () => {
    gsb.enabled = true;
    // A track with a preview, a label and a genre, missing only tempo and key.
    const res = await pass(
      track({ previewUrl: PREVIEW, label: "Catch & Release", genre: "House" })
    );

    expect(order.calls).toEqual(["getsongbpm"]);
    expect(res).toMatchObject({ bpm: 126, key: "8A" });
  });

  it("skips GetSongBPM entirely without a key rather than calling and failing", async () => {
    await pass(track({ genre: "House" }));
    expect(order.calls).not.toContain("getsongbpm");
    expect(order.calls[0]).toBe("deezer");
  });

  it("lets GetSongBPM win the bpm field it shares with Deezer", async () => {
    gsb.enabled = true;
    deezer.answer = { ...deezer.answer, bpm: 63 };
    const res = await pass(track({ genre: "House" }));
    // A curated tempo over an algorithmic half-time reading, decided by nothing
    // but tier order, since merge is first-wins.
    expect(res?.bpm).toBe(126);
    expect(res?.source).toContain("getsongbpm");
  });
});

describe("per-field short-circuiting", () => {
  it("does not ask Deezer for fields already satisfied", async () => {
    gsb.enabled = true;
    // Everything Deezer covers is known; key is missing, and Deezer has never
    // supplied a key.
    await pass(
      track({ bpm: 126, previewUrl: PREVIEW, label: "Catch & Release", genre: "House" })
    );

    expect(order.calls).toEqual(["getsongbpm"]);
    expect(getSourceStats().deezer.calls).toBe(0);
    expect(getSourceStats().deezer.skipped).toBe(1);
  });

  it("still routes a preview and a label to Deezer when bpm and key are known", async () => {
    // The regression this guards: a rekordbox track arrives complete on bpm and
    // key, and Deezer is the only bulk source of preview audio (which feeds
    // timbre) and of album labels (which feed label clustering). Short-circuiting
    // per track rather than per field would drop both.
    gsb.enabled = true;
    const res = await pass(track({ bpm: 128, key: "5A", genre: "House" }));

    expect(order.calls).toEqual(["deezer"]);
    expect(res?.previewUrl).toBe(PREVIEW);
    expect(res?.deezerId).toBe(42);
    expect(res?.label).toBe("Catch & Release");
    expect(getSourceStats().getsongbpm.skipped).toBe(1);
  });

  it("reaches iTunes only for genuine leftovers", async () => {
    gsb.enabled = true;
    await pass(track({ genre: "House" }));
    // Deezer produced the preview, so the 3.2 s tier has nothing left to add.
    expect(order.calls).toEqual(["getsongbpm", "deezer"]);
    expect(getSourceStats().itunes.calls).toBe(0);
    expect(getSourceStats().itunes.skipped).toBe(1);

    order.calls = [];
    cache.clear();
    deezer.answer = null;
    const res = await pass(track({ pid: "P2", name: "Unknown Bootleg", genre: "House" }));

    expect(order.calls).toEqual(["getsongbpm", "deezer", "itunes"]);
    expect(res?.previewUrl).toBe(APPLE_PREVIEW);
  });

  it("keeps iTunes out of a label-only pass, which it cannot serve", async () => {
    // iTunes parses a label out of `copyright`, which the song-search endpoint
    // does not return: an incidental field, never a reason to spend 3.2 s.
    deezer.answer = { deezerId: 42, source: "deezer" };
    await pass(track({ bpm: 128, key: "5A", previewUrl: PREVIEW, genre: "House" }));
    expect(order.calls).toEqual(["deezer"]);
  });

  it("falls back to iTunes within one pass when Deezer has no preview", async () => {
    // Within a pass a failed tier is not an answer. This fallback is the reason
    // iTunes is in the cascade at all.
    deezer.answer = null;
    await lookupFeatures("FISHER", "Losing It", ["previewUrl"]);
    expect(order.calls).toEqual(["deezer", "itunes"]);
  });
});

describe("what the cache is allowed to stand in for", () => {
  it("does not let a preview-only pass answer for bpm and key", async () => {
    gsb.enabled = true;
    // Hover-play resolves audio and asks for nothing else.
    await lookupFeatures("FISHER", "Losing It", ["previewUrl"]);
    expect(order.calls).toEqual(["deezer"]);

    order.calls = [];
    const res = await pass(track({ genre: "House" }));

    // The partial record must not pass for a complete one.
    expect(order.calls).toContain("getsongbpm");
    expect(res).toMatchObject({ bpm: 126, key: "8A", previewUrl: PREVIEW });
  });

  it("does not spend a second call on a field an earlier pass already asked about", async () => {
    deezer.answer = { deezerId: 42, source: "deezer" };
    apple.answer = null;
    await lookupFeatures("FISHER", "Losing It", ["previewUrl"]);
    expect(order.calls).toEqual(["deezer", "itunes"]);

    order.calls = [];
    await lookupFeatures("FISHER", "Losing It", ["previewUrl", "label"]);
    // Both tiers were asked and had nothing. Asking again buys the same silence
    // at the same price.
    expect(order.calls).toEqual([]);
  });

  it("treats a record written before per-field routing as answering for everything", async () => {
    // Those passes ran every enabled source, so re-querying them would put a
    // whole library back through the cascade to learn nothing.
    cache.set("fisher|losing it", { v: 3, ts: Date.now(), hit: true, data: { bpm: 120 } });
    const res = await pass(track({ genre: "House" }));
    expect(order.calls).toEqual([]);
    expect(res?.bpm).toBe(120);
  });

  it("does not retire a field because a source was rate-limited", async () => {
    gsb.enabled = true;
    gsb.throws = true;
    const keyOnly = () =>
      track({ bpm: 128, previewUrl: PREVIEW, label: "Catch & Release", genre: "House" });
    await pass(keyOnly());
    expect(order.calls).toEqual(["getsongbpm"]);
    expect(getSourceStats().getsongbpm.errors).toBe(1);

    order.calls = [];
    gsb.throws = false;
    const res = await pass(keyOnly());
    expect(order.calls).toEqual(["getsongbpm"]);
    expect(res?.key).toBe("8A");
  });

  it("writes no cache record when every tier that could help is switched off", async () => {
    // Key is GetSongBPM's alone. With no API key there is no one to ask, and a
    // record saying "asked, nothing there" would outlive the missing key.
    await lookupFeatures("FISHER", "Losing It", ["key"]);
    expect(order.calls).toEqual([]);
    expect(cache.size).toBe(0);
  });
});

describe("what a track still needs", () => {
  it("names only the gaps an online pass could fill", () => {
    expect(neededFields(track({ genre: "House" }))).toEqual([
      "bpm",
      "key",
      "previewUrl",
      "label",
    ]);
    const complete = track({
      bpm: 128,
      key: "5A",
      previewUrl: PREVIEW,
      label: "Catch & Release",
      genre: "House",
    });
    expect(neededFields(complete)).toEqual([]);
  });

  it("does not treat a manual value as a gap (§4 stage 3)", () => {
    const manual = track({ source: { bpm: "manual", key: "manual" }, genre: "House" });
    expect(neededFields(manual)).toEqual(["previewUrl", "label"]);
  });

  it("wants a genre tag only from a track that has no genre of its own", () => {
    expect(neededFields(track({ genre: "House" }))).not.toContain("tags");
    expect(neededFields(track())).toContain("tags");
    expect(neededFields(track({ tags: ["Dance"] }))).not.toContain("tags");
  });
});

describe("outstandingFields", () => {
  it("subtracts what is known and what has already been asked", () => {
    // An empty tag list is not an answer.
    const have: FeatureLookup = { bpm: 126, tags: [] };
    expect([...outstandingFields(ALL_FIELDS, have)]).toEqual([
      "key",
      "previewUrl",
      "tags",
      "label",
    ]);
    expect([...outstandingFields(ALL_FIELDS, have, ["key", "tags"])]).toEqual([
      "previewUrl",
      "label",
    ]);
  });
});
