import { normalizeArtist, normalizeTitle } from "./normalize";

/**
 * Shared candidate scoring for search-based sources.
 *
 * Every source here is a plain keyword search — Deezer's `artist:"x" track:"y"`
 * field syntax returns zero results in practice, so we cannot ask the API to
 * constrain the match for us. Verifying the result client-side is the only
 * thing standing between us and confidently wrong BPM, and wrong BPM is worse
 * than no BPM: a missing value is visible, a wrong one silently ruins a mix.
 */

export const MIN_SCORE = 2;

const CJK = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/;

/** Two names written in different scripts can't be string-compared usefully. */
function comparableScripts(a: string, b: string): boolean {
  return CJK.test(a) === CJK.test(b);
}

function titleScore(candidate: string, want: string): number {
  if (!candidate || !want) return 0;
  if (candidate === want) return 2;
  const n = Math.min(12, candidate.length, want.length);
  return n >= 4 && candidate.slice(0, n) === want.slice(0, n) ? 1 : 0;
}

const WORDISH = /[\p{L}\p{N}]/u;

/**
 * Containment, but only across whole words. Bare `includes` accepted "eli"
 * (the normalized primary of "Eli & Fur") inside "feliciano" and "ksi" inside
 * "quicksilver": every wrong artist in a 1000-track trial was a fragment
 * landing mid-word like that. Boundaries are tested by codepoint class rather
 * than `\b`, which is ASCII-only and so would never fire between two CJK names.
 */
function containsWord(hay: string, needle: string): boolean {
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) {
    const before = i > 0 ? hay[i - 1] : "";
    const after = hay[i + needle.length] ?? "";
    if (!WORDISH.test(before) && !WORDISH.test(after)) return true;
  }
  return false;
}

/**
 * Shorter than this, a whole-word hit is coincidence more often than it is an
 * abbreviated credit ("me" inside "me first and the gimme gimmes"). Costs
 * nothing on exact names, which never reach the containment branch.
 */
const MIN_CONTAINED_LEN = 4;

function artistScore(candidate: string, want: string): number {
  if (candidate === want) return 2;
  // One side may carry a wider credit than the other: "chemical brothers" and
  // "the chemical brothers" are one artist.
  const [short, long] =
    candidate.length <= want.length ? [candidate, want] : [want, candidate];
  if (short.length >= MIN_CONTAINED_LEN && containsWord(long, short)) return 1;
  return 0;
}

/**
 * 0–4, where 0 means "reject". The title carries the identity of a track, so
 * a title mismatch is fatal no matter how well the artist agrees; a known
 * artist that disagrees is likewise fatal, unless the two names are written
 * in different scripts (an Apple export says 米津玄師 where Deezer says
 * Kenshi Yonezu) — there we lean on an exact title instead.
 *
 * That exact title is load-bearing, not a formality. A different alphabet
 * waives the only check on identity we have left, so anything looser turns
 * every same-titled song on earth into a match. It holds only because each
 * source queries with the artist it has; a title-only search would feed this
 * branch unrelated candidates by the dozen.
 */
export function scoreMatch(
  candidateArtist: string | undefined,
  candidateTitle: string | undefined,
  wantArtist: string,
  wantTitle: string
): number {
  const title = titleScore(
    candidateTitle ? normalizeTitle(candidateTitle) : "",
    wantTitle
  );
  if (title === 0) return 0;
  if (!wantArtist) return title;

  const artist = candidateArtist ? normalizeArtist(candidateArtist) : "";
  if (!artist) return title;

  if (!comparableScripts(artist, wantArtist)) {
    return title === 2 ? title + 1 : 0;
  }
  const a = artistScore(artist, wantArtist);
  return a === 0 ? 0 : title + a;
}

/** Best-scoring candidate, or null when nothing clears MIN_SCORE. */
export function pickBest<T>(
  candidates: readonly T[],
  artistOf: (c: T) => string | undefined,
  titleOf: (c: T) => string | undefined,
  wantArtist: string,
  wantTitle: string
): { item: T; score: number } | null {
  let best: T | null = null;
  let bestScore = -1;
  for (const c of candidates) {
    const s = scoreMatch(artistOf(c), titleOf(c), wantArtist, wantTitle);
    if (s > bestScore) {
      bestScore = s;
      best = c;
    }
  }
  return best !== null && bestScore >= MIN_SCORE ? { item: best, score: bestScore } : null;
}
