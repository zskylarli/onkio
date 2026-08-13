import type { FeatureLookup } from "../types";
import { ALL_FIELDS, outstandingFields, type Field } from "./fields";
import { lookupKey } from "./normalize";
import { getCachedLookup, putCachedLookup } from "../store/db";
import { lookupDeezer } from "./sources/deezer";
import { lookupGetSongBpm, isSongBpmEnabled } from "./sources/getsongbpm";
import { lookupItunes } from "./sources/itunes";

/**
 * The adapter (§3.4). Every external service lives behind this one function;
 * call sites know nothing about Deezer/GetSongBPM/iTunes. Results — including
 * misses — are cached in IndexedDB keyed on normalized artist|title.
 *
 * Routing is per *field*, not per track. The caller says which fields it is
 * missing and a source is only called when it can still fill one of them, so
 * the cascade stops as soon as the answer is complete. That matters because the
 * tiers span two orders of magnitude in cost — Deezer answers in ~150 ms per
 * call, iTunes is rate-limited to one call every 3.2 s — and because "per
 * track" is the wrong unit: a rekordbox track already has BPM and key and still
 * needs Deezer for its preview and its label.
 *
 * Tier order, which is the order of SOURCES:
 *
 * 1. GetSongBPM, only when the user has supplied an API key. It is the only
 *    source of musical key without analyzing audio and its tempo is curated
 *    rather than inferred, so when it is available it should be the one that
 *    wins the bpm field (merge is first-wins) — and for a track that needs
 *    nothing but bpm and key, one call ends the cascade.
 * 2. Deezer. Cheapest by a wide margin and the only source of preview audio
 *    worth using in bulk plus album labels, so it is asked for everything it
 *    covers that is still outstanding.
 * 3. iTunes, last and rarely. At 3.2 s a call it is 7x the next slowest tier,
 *    and the only thing it uniquely supplies is a genre tag. It is reached for
 *    genuine leftovers: a preview Deezer did not have, or a track with no
 *    genre at all.
 */

export type { Field } from "./fields";

export type Source = {
  name: string;
  /**
   * Fields this source is worth spending a call on. Not the same as the fields
   * its answer may happen to carry: whatever comes back is merged either way,
   * but only these route a call here.
   */
  provides: readonly Field[];
  enabled: () => boolean;
  run: (artist: string | undefined, title: string) => Promise<FeatureLookup | null>;
};

export const SOURCES: readonly Source[] = [
  {
    name: "getsongbpm",
    provides: ["bpm", "key"],
    enabled: isSongBpmEnabled,
    run: lookupGetSongBpm,
  },
  {
    name: "deezer",
    provides: ["bpm", "previewUrl", "label"],
    enabled: () => true,
    run: lookupDeezer,
  },
  {
    // `label` is missing from `provides` on purpose. iTunes parses one out of
    // `copyright`, which the song-search endpoint does not return, so counting
    // it as a capability would route every label-less track through the slowest
    // tier for a field it almost never carries. A label that does arrive is
    // still kept.
    name: "itunes",
    provides: ["previewUrl", "tags"],
    enabled: () => true,
    run: lookupItunes,
  },
];

/**
 * Per-source tallies, surfaced in the UI so a dead source is obvious. `skipped`
 * exists because tiering makes zero calls the normal state of a healthy tier:
 * without it, an iTunes row reading "0 calls" is indistinguishable from an
 * iTunes that has stopped answering.
 */
export type SourceStats = {
  calls: number;
  hits: number;
  misses: number;
  errors: number;
  skipped: number;
};

const stats: Record<string, SourceStats> = {};
function zero(): SourceStats {
  return { calls: 0, hits: 0, misses: 0, errors: 0, skipped: 0 };
}
for (const s of SOURCES) stats[s.name] = zero();

export function getSourceStats(): Record<string, SourceStats> {
  return JSON.parse(JSON.stringify(stats)) as Record<string, SourceStats>;
}

export function resetSourceStats(): void {
  for (const k of Object.keys(stats)) stats[k] = zero();
}

function merge(acc: FeatureLookup, next: FeatureLookup): void {
  if (next.bpm && !acc.bpm) {
    acc.bpm = next.bpm;
    acc.confidence = { ...acc.confidence, bpm: next.confidence?.bpm };
    acc.source = acc.source ? `${acc.source}+${next.source}` : next.source;
  }
  if (next.key && !acc.key) {
    acc.key = next.key;
    acc.confidence = { ...acc.confidence, key: next.confidence?.key };
    if (!acc.source?.includes(next.source ?? ""))
      acc.source = acc.source ? `${acc.source}+${next.source}` : next.source;
  }
  if (next.previewUrl && !acc.previewUrl) acc.previewUrl = next.previewUrl;
  if (next.label && !acc.label) {
    acc.label = next.label;
    acc.labelSource = next.labelSource ?? next.source;
  }
  // Outlives the signed URL it came with, so it is kept even when a preview is not.
  if (next.deezerId && !acc.deezerId) acc.deezerId = next.deezerId;
  if (next.tags?.length) acc.tags = [...new Set([...(acc.tags ?? []), ...next.tags])];
}

/** Whether a call to this source can still serve any wanted field. */
export function serves(src: Source, wanted: ReadonlySet<Field>): boolean {
  return src.enabled() && src.provides.some((f) => wanted.has(f));
}

export type Cascade = {
  data: FeatureLookup;
  /** Sources called, in the order they were called. */
  queried: string[];
  /** Fields now spoken for: some source was asked about them and answered. */
  covered: Field[];
};

/**
 * Walk the tiers, calling only those that can still contribute, and stop as
 * soon as nothing is outstanding. `sources` is injectable so the routing can be
 * exercised without the network.
 *
 * Fields asked about in *earlier* passes (`seed.covered`) are settled and gate
 * routing. Fields asked about during *this* pass do not: a tier that failed to
 * produce a preview is exactly when the next tier is worth its 3.2 s, and
 * treating the failed attempt as an answer would remove the fallback that iTunes
 * is in the cascade for.
 *
 * A source that *throws* covers nothing. Rate limits, timeouts and outages are
 * transient, and recording one as an answer would retire a field permanently
 * over a bad minute.
 */
export async function cascade(
  artist: string | undefined,
  title: string,
  need: Iterable<Field>,
  seed: { data?: FeatureLookup; covered?: Iterable<Field> } = {},
  sources: readonly Source[] = SOURCES
): Promise<Cascade> {
  const data: FeatureLookup = { ...seed.data };
  const settled = new Set<Field>(seed.covered ?? []);
  const covered = new Set<Field>(settled);
  const queried: string[] = [];

  for (const src of sources) {
    // Recomputed per tier, so an answer from one tier retires the next. A
    // completed cascade walks the rest of the list counting skips rather than
    // breaking out: "0 calls" and "nothing left to ask" have to be told apart
    // in the diagnostics readout.
    const wanted = outstandingFields(need, data, settled);
    if (!serves(src, wanted)) {
      if (src.enabled()) stats[src.name].skipped++;
      continue;
    }
    queried.push(src.name);
    const tally = stats[src.name];
    tally.calls++;
    try {
      const res = await src.run(artist, title);
      if (res) {
        tally.hits++;
        merge(data, res);
      } else {
        tally.misses++;
      }
      for (const f of src.provides) covered.add(f);
    } catch {
      // A dead/rate-limited endpoint is a contained non-event (§3.4).
      tally.errors++;
    }
  }

  return { data, queried, covered: [...covered] };
}

function isHit(data: FeatureLookup): boolean {
  return !!(data.bpm || data.key || data.previewUrl || data.tags?.length || data.label);
}

export async function lookupFeatures(
  artist: string | undefined,
  title: string,
  need: Iterable<Field> = ALL_FIELDS
): Promise<FeatureLookup | null> {
  const key = lookupKey(artist, title);
  const cached = await getCachedLookup(key);
  const known = cached?.data ?? {};
  // A record written before per-field routing existed came from a pass that ran
  // every enabled source, so it answers for everything. Treating it as covering
  // nothing would re-query a whole library's worth of cache hits.
  const covered = cached ? (cached.covered ?? ALL_FIELDS) : [];

  const wanted = outstandingFields(need, known, covered);
  if (wanted.size === 0) return cached?.hit ? (cached.data ?? null) : null;

  const run = await cascade(artist, title, need, { data: known, covered });
  // Nothing was reachable — the only sources that could have helped are off.
  // Writing a record here would claim the fields had been asked about.
  if (run.queried.length === 0) return cached?.hit ? (cached.data ?? null) : null;

  const hit = isHit(run.data);
  await putCachedLookup(key, hit, hit ? run.data : undefined, run.covered);
  return hit ? run.data : null;
}
