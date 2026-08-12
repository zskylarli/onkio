import { describe, expect, it, vi, beforeEach } from "vitest";
import "fake-indexeddb/auto";
import type { FeatureLookup, Track } from "../src/types";

/**
 * The queue is the only path that writes lookup results onto a track outside of
 * an explicit play, so what it chooses to keep is what the library is left
 * holding. These cover the durable half of a Deezer answer.
 */

const lookupFeatures =
  vi.fn<(artist: string | undefined, title: string) => Promise<FeatureLookup | null>>();
vi.mock("../src/enrich/adapter", () => ({ lookupFeatures: (a: string | undefined, t: string) => lookupFeatures(a, t) }));
// Persistence is not what these are about, and a real one would carry state
// between cases.
vi.mock("../src/store/db", () => ({
  saveQueueState: () => Promise.resolve(),
  loadQueueState: () => Promise.resolve(null),
}));

const { EnrichmentQueue } = await import("../src/enrich/queue");

function track(over: Partial<Track> = {}): Track {
  return { pid: "p1", name: "Anodyne", artist: "Kyra", ...over } as Track;
}

/** Run the queue over one track and hand back what it was left holding. */
async function enrich(t: Track): Promise<Track> {
  const q = new EnrichmentQueue(() => {});
  await q.init([t]);
  await q.start();
  return t;
}

beforeEach(() => {
  lookupFeatures.mockReset();
});

describe("EnrichmentQueue result handling", () => {
  it("keeps the Deezer id, not only the URL it arrived with", async () => {
    // Deezer signs preview URLs and they die after about fifteen minutes. The
    // id is what mints a fresh one, so a track saved with the URL alone is a
    // track that has to be searched for all over again.
    lookupFeatures.mockResolvedValue({
      previewUrl: "https://cdn.deezer.com/x.mp3?hdnea=exp=1700000000~acl=/x",
      deezerId: 4242,
      source: "deezer",
    });
    const t = await enrich(track());
    expect(t.deezerId).toBe(4242);
    expect(t.previewUrl).toContain("cdn.deezer.com");
  });

  it("keeps the id even when the answer carried no playable URL", async () => {
    // A hit that found the record but no preview still leaves something worth
    // holding: the id is what a later attempt at the audio starts from.
    lookupFeatures.mockResolvedValue({ bpm: 124, deezerId: 77, source: "deezer" });
    const t = await enrich(track());
    expect(t.deezerId).toBe(77);
    expect(t.previewUrl).toBeUndefined();
  });

  it("reports the track as changed when the id is all that was learned", async () => {
    // onUpdate is what saves the library, so an id that arrives without
    // announcing itself is an id that does not survive the tab closing.
    lookupFeatures.mockResolvedValue({ deezerId: 9, source: "deezer" });
    const seen: Track[] = [];
    const q = new EnrichmentQueue((t) => seen.push(t));
    const t = track();
    await q.init([t]);
    await q.start();
    expect(seen).toEqual([t]);
    expect(t.deezerId).toBe(9);
  });

  it("leaves an id the track already has alone", async () => {
    // Same reasoning as bpm and key: what is already known is not overwritten
    // by a later, less certain answer.
    lookupFeatures.mockResolvedValue({ deezerId: 2, source: "deezer" });
    const t = await enrich(track({ deezerId: 1, bpm: 120 }));
    expect(t.deezerId).toBe(1);
  });

  it("persists a Deezer label without replacing a file label", async () => {
    lookupFeatures.mockResolvedValue({
      label: "Toolroom",
      labelSource: "deezer",
      source: "deezer",
    });
    const missing = track({ bpm: 128, key: "8A" });
    const q = new EnrichmentQueue(() => {});
    await q.init([missing]);
    q.refill([missing]);
    await q.start();
    expect(missing.label).toBe("Toolroom");
    expect(missing.source?.label).toBe("deezer");

    const existing = track({ label: "Local Imprint" });
    await enrich(existing);
    expect(existing.label).toBe("Local Imprint");
  });

  it("asks for nothing when the track already has bpm and key", async () => {
    // Membership is decided by needsLookup: a rekordbox export contributes
    // nothing to the queue at all.
    lookupFeatures.mockResolvedValue({ deezerId: 5 });
    const t = await enrich(track({ bpm: 128, key: "8A" }));
    expect(lookupFeatures).not.toHaveBeenCalled();
    expect(t.deezerId).toBeUndefined();
  });

  it("requeues an in-flight lookup without applying it when stopped", async () => {
    let finish!: (result: FeatureLookup) => void;
    lookupFeatures.mockImplementation(
      () => new Promise<FeatureLookup>((resolve) => { finish = resolve; })
    );
    const seen: Track[] = [];
    const q = new EnrichmentQueue((t) => seen.push(t));
    const t = track();
    await q.init([t]);

    const running = q.start();
    q.stop();
    finish({ bpm: 126, key: "8A", source: "deezer" });
    await running;

    expect(seen).toEqual([]);
    expect(t.bpm).toBeUndefined();
    expect(t.key).toBeUndefined();
    expect(q.remaining).toBe(1);
  });
});
