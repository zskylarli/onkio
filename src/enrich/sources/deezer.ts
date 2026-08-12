import { jsonp } from "./jsonp";
import { RateLimiter } from "./limiter";
import { normalizeArtist, normalizeTitle } from "../normalize";
import { pickBest } from "../match";
import type { FeatureLookup } from "../../types";

/**
 * Deezer public API (§4 stage 1). No auth, no CORS headers → JSONP.
 * Documented quota ~50 req / 5 s; at 150 ms we sit at a third of that.
 *
 * Two hard-won details, both verified live against the API:
 *
 * 1. The documented field syntax (`artist:"x" track:"y"`) returns ZERO results
 *    through this endpoint, quoted or not. A plain keyword query returns the
 *    right track first. Since the API won't constrain the match, we score
 *    candidates ourselves rather than trusting result order.
 * 2. Search results carry a 30 s `preview` MP3 for essentially every match,
 *    while `bpm` only exists on the per-track detail endpoint (and is 0 for
 *    roughly half the catalog). Those previews are the cheap fuel for DSP —
 *    iTunes' equivalent costs 3.2 s per request instead of 150 ms.
 * 3. Those preview URLs are signed with `hdnea=exp=<unix>` and live 900 s, and
 *    the token is minted per response. `id` is therefore the only part of the
 *    answer worth keeping; enrich/preview trades it for a fresh URL at playback.
 */

/** Shared so a preview minted later counts against the same quota as a search. */
export const deezerLimiter = new RateLimiter(150);
const limiter = deezerLimiter;

type DeezerResult = {
  id: number;
  title?: string;
  preview?: string;
  artist?: { name?: string };
};
type DeezerSearch = { data?: DeezerResult[] };
type DeezerTrack = { bpm?: number };

export async function lookupDeezer(
  artist: string | undefined,
  title: string
): Promise<FeatureLookup | null> {
  const nArtist = artist ? normalizeArtist(artist) : "";
  const nTitle = normalizeTitle(title);
  const q = `${nArtist ? nArtist + " " : ""}${nTitle}`.trim();
  if (!q) return null;

  await limiter.acquire();
  const search = await jsonp<DeezerSearch>(
    `https://api.deezer.com/search?output=jsonp&limit=5&q=${encodeURIComponent(q)}`
  );
  const best = pickBest(
    search.data ?? [],
    (r) => r.artist?.name,
    (r) => r.title,
    nArtist,
    nTitle
  );
  if (!best) return null;

  const out: FeatureLookup = { source: "deezer", deezerId: best.item.id };
  if (best.item.preview) out.previewUrl = best.item.preview;

  await limiter.acquire();
  const track = await jsonp<DeezerTrack>(
    `https://api.deezer.com/track/${best.item.id}?output=jsonp`
  );
  // Deezer reports 0 for "unknown" rather than omitting the field.
  if (track.bpm && track.bpm > 0) {
    out.bpm = track.bpm;
    out.confidence = { bpm: 0.9 };
  }

  return out.bpm || out.previewUrl ? out : null;
}
