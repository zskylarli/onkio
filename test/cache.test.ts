import { describe, expect, it, beforeAll } from "vitest";
import "fake-indexeddb/auto";
import {
  getCachedLookup,
  putCachedLookup,
  putOverride,
  getOverride,
  getAllOverrides,
  saveQueueState,
  loadQueueState,
  clearCachedMisses,
  CACHE_VERSION,
  MISS_TTL_MS,
} from "../src/store/db";

beforeAll(async () => {
  // touch the store so the schema exists before the raw writes below
  await putCachedLookup("warmup|warmup", true, { bpm: 1 });
});

/** Write a record verbatim so tests can backdate it or fake an old version. */
function putRawLookup(key: string, rec: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("music-constellation", 1);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction("lookups", "readwrite");
      tx.objectStore("lookups").put(rec, key);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  });
}

describe("lookup cache (§3.1)", () => {
  it("stores and retrieves positive results", async () => {
    await putCachedLookup("artist|title", true, { bpm: 126, source: "deezer" });
    const rec = await getCachedLookup("artist|title");
    expect(rec?.hit).toBe(true);
    expect(rec?.data?.bpm).toBe(126);
    expect(rec?.v).toBe(CACHE_VERSION);
  });

  it("stores negative results — a miss is expensive to rediscover", async () => {
    await putCachedLookup("nobody|nothing", false);
    const rec = await getCachedLookup("nobody|nothing");
    expect(rec).toBeDefined();
    expect(rec?.hit).toBe(false);
  });

  it("returns undefined for unknown keys", async () => {
    expect(await getCachedLookup("never|seen")).toBeUndefined();
  });

  it("expires misses but keeps hits — most misses are outages in disguise", async () => {
    const stale = Date.now() - MISS_TTL_MS - 1000;
    await putRawLookup("old|miss", { v: CACHE_VERSION, ts: stale, hit: false });
    await putRawLookup("old|hit", {
      v: CACHE_VERSION,
      ts: stale,
      hit: true,
      data: { bpm: 120 },
    });
    expect(await getCachedLookup("old|miss")).toBeUndefined();
    expect((await getCachedLookup("old|hit"))?.data?.bpm).toBe(120);
  });

  it("ignores records written by an earlier cache version", async () => {
    await putRawLookup("stale|version", { v: CACHE_VERSION - 1, ts: Date.now(), hit: true });
    expect(await getCachedLookup("stale|version")).toBeUndefined();
  });

  it("clears misses on demand, leaving hits intact", async () => {
    await putCachedLookup("purge|miss", false);
    await putCachedLookup("purge|hit", true, { bpm: 100 });
    const removed = await clearCachedMisses();
    expect(removed).toBeGreaterThan(0);
    expect(await getCachedLookup("purge|miss")).toBeUndefined();
    expect((await getCachedLookup("purge|hit"))?.hit).toBe(true);
  });
});

describe("manual overrides (§4 stage 3)", () => {
  it("persists per-pid and merges partial updates", async () => {
    await putOverride("PID1", { bpm: 128 });
    await putOverride("PID1", { key: "8A" });
    const o = await getOverride("PID1");
    expect(o).toEqual({ bpm: 128, key: "8A" });
    const all = await getAllOverrides();
    expect(all.get("PID1")).toEqual({ bpm: 128, key: "8A" });
  });
});

describe("queue persistence (§3.3)", () => {
  it("round-trips pending pids", async () => {
    await saveQueueState(["a", "b", "c"]);
    expect(await loadQueueState()).toEqual(["a", "b", "c"]);
  });
});
