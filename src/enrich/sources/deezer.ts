import { jsonp } from "./jsonp";
import { RateLimiter } from "./limiter";
import { normalizeArtist, normalizeTitle } from "../normalize";
import { pickBest } from "../match";
import type { FeatureLookup } from "../../types";
import { canonicalLabel } from "../label";

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
  duration?: number;
  artist?: { name?: string };
  album?: { id?: number; title?: string };
};
type DeezerSearch = { data?: DeezerResult[] };
type DeezerTrack = { bpm?: number; preview?: string; release_date?: string };
type DeezerAlbum = { label?: string };

const albumLabels = new Map<number, Promise<string | undefined>>();

async function albumLabel(id: number, artist?: string): Promise<string | undefined> {
  let pending = albumLabels.get(id);
  if (!pending) {
    pending = (async () => {
      try {
        await limiter.acquire();
        const album = await jsonp<DeezerAlbum>(
          `https://api.deezer.com/album/${id}?output=jsonp`
        );
        return canonicalLabel(album.label, artist);
      } catch {
        // Album metadata is additive. An outage must not discard the preview,
        // BPM and durable track id already obtained from this matched result.
        return undefined;
      }
    })();
    albumLabels.set(id, pending);
  }
  return pending;
}

/** Test isolation; production keeps the cache for the lifetime of the tab. */
export function clearDeezerAlbumCache(): void {
  albumLabels.clear();
}

/** One catalogue result, in this app's vocabulary rather than Deezer's. */
export type DeezerHit = {
  id: number;
  title: string;
  artist?: string;
  album?: string;
  albumId?: number;
  durationMs?: number;
  previewUrl?: string;
};

/** Deezer reports 0 for "we don't know", which is not a tempo. */
function realBpm(bpm: number | undefined): number | undefined {
  return bpm && bpm > 0 ? bpm : undefined;
}

/**
 * Free text straight from a search box, rather than a known artist and title.
 *
 * The enrichment path scores candidates against the track it already has
 * (`pickBest`) because a wrong BPM silently ruins a mix. Here there is nothing
 * to score against — the user typed the query and is about to read the results
 * — so the whole page is returned and the choice is theirs. Same endpoint and
 * the same limiter, so an interactive search queues behind a lookup pass
 * instead of racing it into Deezer's quota.
 */
export async function searchDeezerTracks(
  query: string,
  limit = 8
): Promise<DeezerHit[]> {
  const q = query.trim();
  if (!q) return [];
  await limiter.acquire();
  const search = await jsonp<DeezerSearch>(
    `https://api.deezer.com/search?output=jsonp&limit=${limit}&q=${encodeURIComponent(q)}`
  );
  return (search.data ?? [])
    .filter((result) => typeof result.id === "number" && !!result.title)
    .map((result) => ({
      id: result.id,
      title: result.title!,
      artist: result.artist?.name,
      album: result.album?.title,
      albumId: result.album?.id,
      durationMs: result.duration ? result.duration * 1000 : undefined,
      previewUrl: result.preview || undefined,
    }));
}

/**
 * The fields a search result does not carry: tempo, release year and the album
 * label. Two calls at most, both through the shared limiter, and the label goes
 * through the same per-album cache the enrichment path fills.
 *
 * Musical key is not among them. Deezer does not publish one, so an external
 * track arrives without a key until its audio is analyzed — which is the same
 * position most of an Apple Music import starts in.
 */
export async function deezerTrackFacts(
  id: number,
  albumId?: number,
  artist?: string
): Promise<{ bpm?: number; year?: number; previewUrl?: string; label?: string }> {
  const out: { bpm?: number; year?: number; previewUrl?: string; label?: string } = {};
  try {
    await limiter.acquire();
    const track = await jsonp<DeezerTrack>(
      `https://api.deezer.com/track/${id}?output=jsonp`
    );
    out.bpm = realBpm(track.bpm);
    const year = Number(track.release_date?.slice(0, 4));
    if (Number.isFinite(year) && year > 1900) out.year = year;
    if (track.preview) out.previewUrl = track.preview;
  } catch {
    // Every one of these is additive. A track with a preview and no tempo is
    // still worth placing; refusing to place it would be the worse answer.
  }
  if (albumId !== undefined) {
    out.label = await albumLabel(albumId, artist).catch(() => undefined);
  }
  return out;
}

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
  const bpm = realBpm(track.bpm);
  if (bpm) {
    out.bpm = bpm;
    out.confidence = { bpm: 0.9 };
  }

  const albumId = best.item.album?.id;
  if (albumId !== undefined) {
    out.label = await albumLabel(albumId, artist);
    if (out.label) out.labelSource = "deezer";
  }

  return out.bpm || out.previewUrl || out.label ? out : null;
}
