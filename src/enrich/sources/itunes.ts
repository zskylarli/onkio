import { jsonp } from "./jsonp";
import { RateLimiter } from "./limiter";
import { normalizeArtist, normalizeTitle } from "../normalize";
import { pickBest } from "../match";
import type { FeatureLookup } from "../../types";

/**
 * iTunes Search API (§4 stage 2.1) — ~20 req/min hard limit (403s beyond it),
 * and a poisoned per-term CORS cache → JSONP.
 *
 * At 3.2 s per request this is by far the slowest source, so the adapter only
 * reaches it when Deezer failed to produce a preview. It stays in the cascade
 * because this is an Apple Music export: when Deezer has never heard of a
 * track, iTunes usually has.
 */

const limiter = new RateLimiter(3200); // ~18/min, under the 20/min ceiling

type ItunesResult = {
  trackName?: string;
  artistName?: string;
  previewUrl?: string;
  primaryGenreName?: string;
};
type ItunesSearch = { resultCount: number; results: ItunesResult[] };

export async function lookupItunes(
  artist: string | undefined,
  title: string
): Promise<FeatureLookup | null> {
  const nArtist = artist ? normalizeArtist(artist) : "";
  const nTitle = normalizeTitle(title);
  const term = `${nArtist ? nArtist + " " : ""}${nTitle}`.trim();
  if (!term) return null;

  await limiter.acquire();
  const res = await jsonp<ItunesSearch>(
    `https://itunes.apple.com/search?media=music&entity=song&limit=5&term=${encodeURIComponent(term)}`
  );
  if (!res.resultCount) return null;

  const best = pickBest(
    res.results,
    (r) => r.artistName,
    (r) => r.trackName,
    nArtist,
    nTitle
  );
  if (!best?.item.previewUrl) return null;

  const out: FeatureLookup = { previewUrl: best.item.previewUrl, source: "itunes" };
  if (best.item.primaryGenreName) out.tags = [best.item.primaryGenreName];
  return out;
}
