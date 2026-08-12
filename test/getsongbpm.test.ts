import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MIN_SCORE, scoreMatch } from "../src/enrich/match";
import { normalizeArtist, normalizeTitle } from "../src/enrich/normalize";

/**
 * Two halves. The first pins the shape of the live call — one request, direct
 * to the working host — with `fetch` stubbed. The second replays the recorded
 * 1000-track trial in `fixtures/getsongbpm-results.json`, which is the only
 * honest way to assert things about a third-party API without spending quota
 * or making the suite depend on someone else's uptime.
 */

// The 1.3 s pacing protects the API's quota; here it would only buy dead time.
vi.mock("../src/enrich/sources/limiter", () => ({
  RateLimiter: class {
    acquire(): Promise<void> {
      return Promise.resolve();
    }
  },
}));

import {
  isSongBpmEnabled,
  lookupGetSongBpm,
  setSongBpmApiKey,
  setSongBpmProxy,
} from "../src/enrich/sources/getsongbpm";

// ---------------------------------------------------------------- stubs

const storage = new Map<string, string>();
globalThis.localStorage = {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => void storage.set(k, v),
  removeItem: (k: string) => void storage.delete(k),
  clear: () => storage.clear(),
  key: () => null,
  length: 0,
} as unknown as Storage;

/** A verbatim `/search/` item, copied from the recorded trial. */
const SEARCH_HIT = {
  id: "wA3Jq",
  title: "I Am California",
  artist: { name: "John Craigie" },
  tempo: "118",
  time_sig: "4/4",
  key_of: "D♯",
  open_key: "10d",
};

let calls: string[] = [];

function stubFetch(payload: unknown): void {
  calls = [];
  globalThis.fetch = ((url: string) => {
    calls.push(String(url));
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(payload),
    } as unknown as Response);
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  storage.clear();
  stubFetch({ search: [SEARCH_HIT] });
});

// ---------------------------------------------------------------- the source

describe("getsongbpm source", () => {
  it("stays disabled until a key is supplied, with no proxy involved", async () => {
    expect(isSongBpmEnabled()).toBe(false);
    expect(await lookupGetSongBpm("John Craigie", "I Am California")).toBeNull();
    setSongBpmApiKey("k123");
    expect(isSongBpmEnabled()).toBe(true);
  });

  it("reads bpm and key from a single call to the working host", async () => {
    setSongBpmApiKey("k123");
    const out = await lookupGetSongBpm(
      "John Craigie",
      "I Am California (feat. Gregory Alan Isakov)"
    );
    expect(out).toMatchObject({ bpm: 118, key: "5B", source: "getsongbpm" });
    // One request per track: /search/ already carries tempo and key, so the
    // /song/ detail endpoint would only re-fetch what we have.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/^https:\/\/api\.getsong\.co\/search\/\?/);
    expect(calls[0]).toContain("api_key=k123");
  });

  it("routes through a proxy when one is configured", async () => {
    setSongBpmApiKey("k123");
    setSongBpmProxy("https://worker.example.dev/");
    await lookupGetSongBpm("John Craigie", "I Am California");
    expect(calls[0]).toMatch(/^https:\/\/worker\.example\.dev\/search\/\?/);
  });

  it("rejects a top result that is a different artist", async () => {
    setSongBpmApiKey("k123");
    stubFetch({ search: [{ ...SEARCH_HIT, artist: { name: "Quicksilver Messenger Service" } }] });
    expect(await lookupGetSongBpm("KSI", "I Am California")).toBeNull();
  });

  it("survives the error payload the API returns instead of an HTTP error", async () => {
    setSongBpmApiKey("k123");
    stubFetch({ search: { error: "no result" } });
    expect(await lookupGetSongBpm("John Craigie", "I Am California")).toBeNull();
  });
});

// ---------------------------------------------------------------- the trial

type Outcome = {
  artist?: string;
  title: string;
  status: string;
  via?: "combined" | "title-only";
  cached?: boolean;
  score?: number;
  matchedArtist?: string;
  matchedTitle?: string;
  rawTempo?: string;
  keyOf?: string;
  openKey?: string;
};

const HERE = dirname(fileURLToPath(import.meta.url));
const TRIAL = JSON.parse(
  readFileSync(join(HERE, "fixtures", "getsongbpm-results.json"), "utf8")
) as { results: Outcome[] };

const matched = TRIAL.results.filter((r) => r.status === "matched");
const combined = matched.filter((r) => r.via === "combined");

describe("recorded 1000-track trial", () => {
  it("proves the search response alone carries tempo and key", () => {
    const fresh = matched.filter((r) => !r.cached);
    expect(fresh.length).toBeGreaterThan(300);
    for (const r of fresh) {
      expect(r.rawTempo).toBeDefined();
      expect(r.keyOf).toBeDefined();
      expect(r.openKey).toBeDefined();
    }
  });

  /**
   * Re-scoring only the candidate the trial accepted, since the losing
   * candidates were never recorded. That is enough to answer the question the
   * fix has to answer: which of the matches we shipped does it now throw out?
   */
  const rescore = (r: Outcome) =>
    scoreMatch(
      r.matchedArtist,
      r.matchedTitle,
      r.artist ? normalizeArtist(r.artist) : "",
      normalizeTitle(r.title)
    );

  it("throws out exactly the artists that were fragments of another name", () => {
    const dropped = combined.filter((r) => rescore(r) < MIN_SCORE);
    const pairs = [...new Set(dropped.map((r) => `${r.artist} -> ${r.matchedArtist}`))].sort();
    expect(pairs).toEqual([
      "Astre -> Astreiness",
      "Eli & Fur -> Delinquent Habits",
      "Eli & Fur -> José Feliciano",
      "KSI -> Quicksilver Messenger Service",
      "Me & George & KATYA -> The Gentlemen",
      "Rad&Co -> Broken Radio",
    ]);
  });

  it("keeps every other match the trial found", () => {
    const kept = combined.filter((r) => rescore(r) >= MIN_SCORE);
    expect(kept.length).toBe(combined.length - 6);
    expect(kept.length).toBeGreaterThanOrEqual(313);
  });

  /**
   * The cross-script waiver is what the discarded title-only fallback abused
   * (BTS matched to 家入レオ). These two assertions are its fence: it fires
   * only on an identical title, and it never fired on the artist-constrained
   * lookup that is the app's only code path.
   */
  it("only ever waived artist agreement on an identical title", () => {
    const CJK = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/;
    const waived = matched.filter(
      (r) =>
        r.artist &&
        r.matchedArtist &&
        CJK.test(normalizeArtist(r.matchedArtist)) !== CJK.test(normalizeArtist(r.artist))
    );
    expect(waived.length).toBeGreaterThan(0);
    for (const r of waived) {
      expect(normalizeTitle(r.matchedTitle ?? "")).toBe(normalizeTitle(r.title));
      expect(r.via).toBe("title-only");
    }
  });
});
