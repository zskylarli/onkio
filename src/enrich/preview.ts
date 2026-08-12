import type { FeatureLookup, Track } from "../types";
import { jsonp } from "./sources/jsonp";
import { deezerLimiter, lookupDeezer } from "./sources/deezer";
import { lookupFeatures } from "./adapter";

/**
 * Whether a preview can actually be fetched right now, which is a different
 * question from whether one exists.
 *
 * Deezer signs its preview URLs with `hdnea=exp=<unix>` and they live 900
 * seconds, with the token minted fresh on every API response. The lookup cache
 * keeps hits forever on the reasoning that a track's BPM does not change, which
 * is true of BPM and false of a credential: a URL stored on one visit is
 * already dead on the next, and the CDN answers 403. So a stored URL is treated
 * as a hint, and the durable Deezer id is what a fresh one is obtained with.
 *
 * iTunes URLs carry no token and stay good, so they are passed straight through.
 */

/** Milliseconds of remaining life a URL needs before it is worth handing to the
 * audio element. Resolution, the element's own request and a slow first byte all
 * sit between deciding and fetching, and a URL that dies in that window is a
 * silent failure rather than a retryable one. */
export const EXPIRY_MARGIN_MS = 60_000;

/** Absolute expiry in ms, or null when the URL carries no expiry at all. */
export function previewExpiry(url: string): number | null {
  const m = /[?&](?:hdnea=)?[^&]*?\bexp=(\d+)/.exec(url);
  return m ? Number(m[1]) * 1000 : null;
}

export function isDurablePreview(url: string): boolean {
  return previewExpiry(url) === null;
}

export function isUsablePreview(url: string, now = Date.now()): boolean {
  const exp = previewExpiry(url);
  return exp === null || exp - now > EXPIRY_MARGIN_MS;
}

/** One JSONP call, and the cheapest way back to audio once an id is known. */
export async function mintDeezerPreview(id: number): Promise<string | null> {
  await deezerLimiter.acquire();
  const track = await jsonp<{ preview?: string }>(
    `https://api.deezer.com/track/${id}?output=jsonp`
  );
  return track.preview || null;
}

export type PreviewDeps = {
  /** fresh URL for a known Deezer id */
  mint: (id: number) => Promise<string | null>;
  /** uncached Deezer search, for tracks whose stored URL predates the id */
  search: (artist: string | undefined, title: string) => Promise<FeatureLookup | null>;
  /** cached cascade, for tracks with no stored URL at all */
  lookup: (artist: string | undefined, title: string) => Promise<FeatureLookup | null>;
  now: () => number;
};

const defaultDeps: PreviewDeps = {
  mint: mintDeezerPreview,
  search: lookupDeezer,
  lookup: lookupFeatures,
  now: Date.now,
};

/**
 * URLs minted during this session, so sweeping back across a dot inside its 15
 * minute window costs nothing. Keyed by pid and not persisted, because the whole
 * point is that these do not survive.
 */
const session = new Map<string, { url: string; expiresAt: number | null }>();

export function clearPreviewCache(): void {
  session.clear();
}

export type PreviewResolution =
  /** playable now */
  | { kind: "url"; url: string }
  /** no preview exists for this track in any source that was asked */
  | { kind: "none" }
  /** a preview exists but a fresh URL could not be obtained, so retrying may work */
  | { kind: "unavailable" };

/**
 * Trade whatever is known about a track for a URL that will play. A stored URL
 * is used when it still has life in it; otherwise the id mints a new one, and
 * failing that a fresh search does, which also records the id for next time.
 *
 * The track is mutated with anything durable that is learned, so the work is
 * done once per track rather than once per hover.
 */
export async function resolvePreviewUrl(
  track: Track,
  deps: Partial<PreviewDeps> = {}
): Promise<PreviewResolution> {
  const d = { ...defaultDeps, ...deps };
  const now = d.now();

  const cached = session.get(track.pid);
  if (cached && (cached.expiresAt === null || cached.expiresAt - now > EXPIRY_MARGIN_MS)) {
    return { kind: "url", url: cached.url };
  }

  let candidate = track.previewUrl;
  if (!candidate) {
    const found = await d.lookup(track.artist, track.name).catch(() => null);
    if (found?.deezerId) track.deezerId = found.deezerId;
    if (found?.previewUrl) {
      track.previewUrl = found.previewUrl;
      candidate = found.previewUrl;
    }
  }
  if (!candidate) return { kind: "none" };

  if (isUsablePreview(candidate, now)) return keep(track.pid, candidate);

  if (track.deezerId !== undefined) {
    const minted = await d.mint(track.deezerId).catch(() => null);
    if (minted) {
      track.previewUrl = minted;
      return keep(track.pid, minted);
    }
  }

  // Stored by a version that kept the URL but not the id, so the id has to be
  // earned before this track can be cheap again.
  const found = await d.search(track.artist, track.name).catch(() => null);
  if (found?.deezerId) track.deezerId = found.deezerId;
  if (found?.previewUrl) {
    track.previewUrl = found.previewUrl;
    return keep(track.pid, found.previewUrl);
  }

  return { kind: "unavailable" };
}

function keep(pid: string, url: string): PreviewResolution {
  session.set(pid, { url, expiresAt: previewExpiry(url) });
  return { kind: "url", url };
}
