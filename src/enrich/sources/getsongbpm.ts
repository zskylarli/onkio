import { RateLimiter } from "./limiter";
import { normalizeArtist, normalizeTitle } from "../normalize";
import { pickBest } from "../match";
import { toCamelot } from "../../music/camelot";
import type { FeatureLookup } from "../../types";

/**
 * GetSongBPM (§4 stage 1). The only source that returns musical *key* without
 * analyzing audio.
 *
 * Three constraints, all verified live on 2026-08-11 and again on 2026-08-12:
 *
 * 1. The documented host `api.getsongbpm.com` answers 403 to every non-browser
 *    client — Cloudflare managed challenge, `cf-mitigated: challenge`. The API
 *    itself is served from `api.getsong.co`.
 * 2. `api.getsong.co` sends `access-control-allow-origin: *`, so a browser can
 *    read the response directly. That makes the request worth keeping inside
 *    the CORS "simple request" envelope: no custom headers, or it would earn a
 *    preflight for nothing.
 * 3. `/search/` already carries `tempo`, `key_of` and `open_key`, so there is
 *    nothing left for the per-song `/song/` endpoint to add. Over a 1000-track
 *    trial every single match had all three straight off the search response.
 *
 * That CORS header is third-party runtime behaviour and can regress without
 * warning, so a user-hosted proxy stays available as an override. It has to
 * mirror the upstream path, i.e. `<base>/search/`.
 */

const API_BASE = "https://api.getsong.co";

const limiter = new RateLimiter(1300);
const KEY_STORAGE = "onkio.getsongbpm.apiKey";
const PROXY_STORAGE = "onkio.getsongbpm.proxy";

function readStorage(k: string): string | null {
  try {
    const v = localStorage.getItem(k);
    return v && v.trim() ? v.trim() : null;
  } catch {
    return null;
  }
}

export function getSongBpmApiKey(): string | null {
  return readStorage(KEY_STORAGE);
}

export function setSongBpmApiKey(key: string): void {
  localStorage.setItem(KEY_STORAGE, key.trim());
}

/**
 * Save the key and say which of the two things happened, so the field can
 * confirm it. Emptying it is a real outcome rather than a failed save: it turns
 * this tier off, and a UI that answered "Key saved" would claim the opposite.
 *
 * The key is read from storage on every lookup, so the tier it unlocks takes
 * effect on the next pass with no reload.
 */
export function saveSongBpmApiKey(raw: string): "saved" | "cleared" {
  const trimmed = raw.trim();
  setSongBpmApiKey(trimmed);
  return trimmed ? "saved" : "cleared";
}

/** Optional override: base URL of a user-hosted proxy, without a trailing slash. */
export function getSongBpmProxy(): string | null {
  const v = readStorage(PROXY_STORAGE);
  return v ? v.replace(/\/+$/, "") : null;
}

export function setSongBpmProxy(url: string): void {
  localStorage.setItem(PROXY_STORAGE, url.trim());
}

/** The key is the only requirement; the proxy is an escape hatch, not a gate. */
export function isSongBpmEnabled(): boolean {
  return getSongBpmApiKey() !== null;
}

type GsbSearchItem = {
  id?: string;
  title?: string;
  tempo?: string;
  key_of?: string;
  open_key?: string;
  artist?: { name?: string };
};
/** A failed lookup comes back as `{ search: { error } }`, not as an HTTP error. */
type GsbSearch = { search?: GsbSearchItem[] | { error?: string } };

export async function lookupGetSongBpm(
  artist: string | undefined,
  title: string
): Promise<FeatureLookup | null> {
  const apiKey = getSongBpmApiKey();
  if (!apiKey) return null;
  const base = getSongBpmProxy() ?? API_BASE;

  const nArtist = artist ? normalizeArtist(artist) : "";
  const nTitle = normalizeTitle(title);
  if (!nTitle) return null;
  const lookup = nArtist ? `song:${nTitle} artist:${nArtist}` : nTitle;
  const type = nArtist ? "both" : "song";

  await limiter.acquire();
  const res = await fetch(
    `${base}/search/?api_key=${encodeURIComponent(apiKey)}&type=${type}&lookup=${encodeURIComponent(lookup)}`
  );
  if (!res.ok) return null;
  const json = (await res.json()) as GsbSearch;
  const items = Array.isArray(json.search) ? json.search : [];

  // Result order is not a verdict: the lookup string is a keyword query, so
  // the top hit can be a different song entirely. Score it like every other
  // source rather than trusting position.
  const best = pickBest(items, (c) => c.artist?.name, (c) => c.title, nArtist, nTitle);
  if (!best) return null;
  const song = best.item;

  const out: FeatureLookup = { source: "getsongbpm", confidence: {} };
  const bpm = song.tempo ? parseFloat(song.tempo) : NaN;
  if (Number.isFinite(bpm) && bpm > 0) {
    out.bpm = bpm;
    out.confidence!.bpm = 0.85;
  }
  const key = toCamelot(song.open_key) ?? toCamelot(song.key_of);
  if (key) {
    out.key = key;
    out.confidence!.key = 0.8;
  }
  return out.bpm || out.key ? out : null;
}
