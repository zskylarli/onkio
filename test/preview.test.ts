import { describe, it, expect, beforeEach } from "vitest";
import {
  EXPIRY_MARGIN_MS,
  clearPreviewCache,
  isDurablePreview,
  isUsablePreview,
  previewExpiry,
  resolvePreviewUrl,
  type PreviewDeps,
} from "../src/enrich/preview";
import type { FeatureLookup, Track } from "../src/types";

/** Shape verified live: `?hdnea=exp=<unix>~acl=...~hmac=...`, 900s of life. */
function deezerUrl(expUnixSec: number, tag = "a47dbed0"): string {
  return (
    `https://cdnt-preview.dzcdn.net/api/1/1/a/4/7/${tag}.mp3` +
    `?hdnea=exp=${expUnixSec}~acl=/api/1/1/a/4/7/*~hmac=deadbeef`
  );
}

const ITUNES_URL =
  "https://audio-ssl.itunes.apple.com/itunes-assets/AudioPreview125/v4/ee/22/1a/" +
  "ee221ab0-02dd-7290-47e7-383ad9c81e3b/mzaf_912969547193259322.plus.aac.p.m4a";

function track(over: Partial<Track> = {}): Track {
  return {
    pid: "P1",
    trackId: 1,
    name: "Around the World",
    artist: "Daft Punk",
    durationMs: 429000,
    playlists: [],
    ...over,
  };
}

/** Records what the cascade reached for, so "did not call the network" is testable. */
function deps(over: Partial<PreviewDeps> = {}): PreviewDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    now: () => 1_000_000_000_000,
    mint: async (id) => {
      calls.push(`mint:${id}`);
      return null;
    },
    search: async () => {
      calls.push("search");
      return null;
    },
    lookup: async () => {
      calls.push("lookup");
      return null;
    },
    ...over,
  };
}

beforeEach(() => {
  clearPreviewCache();
});

describe("preview URL expiry", () => {
  it("reads the expiry out of a Deezer signed URL", () => {
    expect(previewExpiry(deezerUrl(1786551864))).toBe(1786551864 * 1000);
  });

  it("treats an unsigned iTunes URL as having no expiry", () => {
    expect(previewExpiry(ITUNES_URL)).toBeNull();
    expect(isDurablePreview(ITUNES_URL)).toBe(true);
    expect(isDurablePreview(deezerUrl(1786551864))).toBe(false);
  });

  it("does not mistake an ordinary path segment for an expiry", () => {
    expect(previewExpiry("https://example.com/export=99/clip.mp3")).toBeNull();
  });

  it("requires more than the safety margin of remaining life", () => {
    const now = 1_000_000_000_000;
    const soon = Math.floor((now + EXPIRY_MARGIN_MS / 2) / 1000);
    const later = Math.floor((now + EXPIRY_MARGIN_MS * 3) / 1000);
    expect(isUsablePreview(deezerUrl(soon), now)).toBe(false);
    expect(isUsablePreview(deezerUrl(later), now)).toBe(true);
    // Nothing to expire, so nothing to be too close to.
    expect(isUsablePreview(ITUNES_URL, now)).toBe(true);
  });
});

describe("resolvePreviewUrl", () => {
  const now = 1_000_000_000_000;
  const fresh = Math.floor((now + 900_000) / 1000);
  const stale = Math.floor((now - 60_000) / 1000);

  it("passes a still-valid stored URL straight through without any request", async () => {
    const d = deps();
    const t = track({ previewUrl: deezerUrl(fresh) });
    const res = await resolvePreviewUrl(t, d);
    expect(res).toEqual({ kind: "url", url: deezerUrl(fresh) });
    expect(d.calls).toEqual([]);
  });

  it("mints a fresh URL by id when the stored one has expired", async () => {
    const minted = deezerUrl(fresh, "minted");
    const d = deps({ mint: async (id) => (id === 42 ? minted : null) });
    const t = track({ previewUrl: deezerUrl(stale), deezerId: 42 });

    const res = await resolvePreviewUrl(t, d);

    expect(res).toEqual({ kind: "url", url: minted });
    // Recorded on the track, so the next hover does not pay for it again.
    expect(t.previewUrl).toBe(minted);
  });

  it("falls back to a search when the stored URL predates the id, and records the id", async () => {
    const found = deezerUrl(fresh, "searched");
    const d = deps({
      search: async (): Promise<FeatureLookup> => ({ previewUrl: found, deezerId: 77 }),
    });
    const t = track({ previewUrl: deezerUrl(stale) });

    const res = await resolvePreviewUrl(t, d);

    expect(res).toEqual({ kind: "url", url: found });
    expect(t.deezerId).toBe(77);
  });

  it("prefers minting over searching when both could work", async () => {
    const minted = deezerUrl(fresh, "minted");
    const seen: string[] = [];
    const d = deps({
      mint: async (id) => {
        seen.push(`mint:${id}`);
        return minted;
      },
      search: async (): Promise<FeatureLookup> => {
        seen.push("search");
        return { previewUrl: deezerUrl(fresh, "searched") };
      },
    });

    await resolvePreviewUrl(track({ previewUrl: deezerUrl(stale), deezerId: 5 }), d);

    // One call rather than two, which is the whole reason the id is kept.
    expect(seen).toEqual(["mint:5"]);
  });

  it("looks a track up when it has no stored URL at all", async () => {
    const d = deps({
      lookup: async (): Promise<FeatureLookup> => ({
        previewUrl: deezerUrl(fresh),
        deezerId: 9,
      }),
    });
    const t = track();

    const res = await resolvePreviewUrl(t, d);

    expect(res.kind).toBe("url");
    expect(t.deezerId).toBe(9);
  });

  it("reports no preview when nothing has one", async () => {
    const res = await resolvePreviewUrl(track(), deps());
    expect(res).toEqual({ kind: "none" });
  });

  it("distinguishes a preview that exists but could not be refreshed", async () => {
    const res = await resolvePreviewUrl(track({ previewUrl: deezerUrl(stale) }), deps());
    // Retrying this one may work; "none" would wrongly say it never will.
    expect(res).toEqual({ kind: "unavailable" });
  });

  it("survives a source that throws rather than returning null", async () => {
    const d = deps({
      mint: async () => {
        throw new Error("JSONP timeout");
      },
    });
    const res = await resolvePreviewUrl(
      track({ previewUrl: deezerUrl(stale), deezerId: 3 }),
      d
    );
    expect(res).toEqual({ kind: "unavailable" });
  });

  it("reuses a minted URL for the rest of its life instead of minting again", async () => {
    let mints = 0;
    const d = deps({
      mint: async () => {
        mints++;
        return deezerUrl(fresh, `m${mints}`);
      },
    });
    const t = track({ previewUrl: deezerUrl(stale), deezerId: 1 });

    const first = await resolvePreviewUrl(t, d);
    const second = await resolvePreviewUrl(t, d);

    expect(mints).toBe(1);
    expect(second).toEqual(first);
  });

  it("mints again once the cached URL has aged out", async () => {
    let mints = 0;
    const clock = { t: now };
    const d = deps({
      now: () => clock.t,
      mint: async () => {
        mints++;
        return deezerUrl(Math.floor((clock.t + 900_000) / 1000), `m${mints}`);
      },
    });
    const t = track({ previewUrl: deezerUrl(stale), deezerId: 1 });

    await resolvePreviewUrl(t, d);
    clock.t += 900_000;
    await resolvePreviewUrl(t, d);

    expect(mints).toBe(2);
  });

  it("keeps separate tracks separate in the session cache", async () => {
    const d = deps({ mint: async (id) => deezerUrl(fresh, `id${id}`) });
    const a = await resolvePreviewUrl(
      track({ pid: "A", previewUrl: deezerUrl(stale), deezerId: 1 }),
      d
    );
    const b = await resolvePreviewUrl(
      track({ pid: "B", previewUrl: deezerUrl(stale), deezerId: 2 }),
      d
    );
    expect(a).not.toEqual(b);
  });
});
