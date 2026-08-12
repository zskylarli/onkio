import type { FeatureLookup } from "../types";
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
 * Sources declare what they can contribute and are skipped when they'd add
 * nothing. That matters because the cascade spans two orders of magnitude in
 * cost: Deezer answers in 150 ms, iTunes is rate-limited to one call every
 * 3.2 s. Running iTunes unconditionally made a full pass take hours, which is
 * indistinguishable from "enrichment is broken".
 */

export type Field = "bpm" | "key" | "previewUrl" | "tags" | "label";

type Source = {
  name: string;
  provides: Field[];
  enabled: () => boolean;
  run: (artist: string | undefined, title: string) => Promise<FeatureLookup | null>;
};

const SOURCES: Source[] = [
  {
    name: "deezer",
    provides: ["bpm", "previewUrl", "label"],
    enabled: () => true,
    run: lookupDeezer,
  },
  {
    name: "getsongbpm",
    provides: ["bpm", "key"],
    enabled: isSongBpmEnabled,
    run: lookupGetSongBpm,
  },
  {
    // iTunes copyright can supply a label if collection lookup is ever added
    // for another reason. This source deliberately makes no extra label call.
    name: "itunes",
    provides: ["previewUrl", "tags", "label"],
    enabled: () => true,
    run: lookupItunes,
  },
];

/** Per-source tallies, surfaced in the UI so a dead source is obvious. */
export type SourceStats = { calls: number; hits: number; misses: number; errors: number };

const stats: Record<string, SourceStats> = {};
for (const s of SOURCES) stats[s.name] = { calls: 0, hits: 0, misses: 0, errors: 0 };

export function getSourceStats(): Record<string, SourceStats> {
  return JSON.parse(JSON.stringify(stats)) as Record<string, SourceStats>;
}

export function resetSourceStats(): void {
  for (const k of Object.keys(stats)) stats[k] = { calls: 0, hits: 0, misses: 0, errors: 0 };
}

function has(acc: FeatureLookup, f: Field): boolean {
  return f === "tags" ? !!acc.tags?.length : acc[f] !== undefined && acc[f] !== null;
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

export async function lookupFeatures(
  artist: string | undefined,
  title: string
): Promise<FeatureLookup | null> {
  const key = lookupKey(artist, title);
  const cached = await getCachedLookup(key);
  if (cached) return cached.hit ? (cached.data ?? null) : null;

  const acc: FeatureLookup = {};
  for (const src of SOURCES) {
    if (!src.enabled()) continue;
    // Skip a source that can only supply fields we already have. Key is never
    // filled by Deezer or iTunes, so without this the expensive tail always ran.
    if (src.provides.every((f) => has(acc, f))) continue;
    const tally = stats[src.name];
    tally.calls++;
    try {
      const res = await src.run(artist, title);
      if (res) {
        tally.hits++;
        merge(acc, res);
      } else {
        tally.misses++;
      }
    } catch {
      // A dead/rate-limited endpoint is a contained non-event (§3.4).
      tally.errors++;
    }
  }

  const hit = !!(acc.bpm || acc.key || acc.previewUrl || acc.tags?.length || acc.label);
  await putCachedLookup(key, hit, hit ? acc : undefined);
  return hit ? acc : null;
}
