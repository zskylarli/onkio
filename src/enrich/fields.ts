import type { FeatureLookup, Track } from "../types";

/**
 * What a lookup is *for*. Routing is per field rather than per track (§3.4), so
 * the vocabulary of fields, and the arithmetic of which ones are still
 * outstanding, is the part every layer shares: the queue derives a track's gaps,
 * the adapter picks tiers from them, and the cache records which of them a pass
 * actually asked about.
 *
 * Kept separate from the adapter deliberately. The adapter reaches IndexedDB and
 * the three provider modules; this is arithmetic over a track, and code that
 * only needs the arithmetic should not have to stand up a database to get it.
 */

export type Field = "bpm" | "key" | "previewUrl" | "tags" | "label";

/** What a caller that says nothing about its needs is taken to want. */
export const ALL_FIELDS: readonly Field[] = ["bpm", "key", "previewUrl", "tags", "label"];

/** Whether an answer actually carries a field. An empty tag list does not. */
export function hasField(data: FeatureLookup, f: Field): boolean {
  return f === "tags" ? !!data.tags?.length : data[f] !== undefined && data[f] !== null;
}

/**
 * Fields a lookup could still add: wanted, not already answered, and not
 * already asked about. `covered` is what an earlier pass spent a call on and
 * came back empty-handed for — asking again buys the same silence at the same
 * price.
 */
export function outstandingFields(
  need: Iterable<Field>,
  have: FeatureLookup = {},
  covered: Iterable<Field> = []
): Set<Field> {
  const settled = new Set(covered);
  const out = new Set<Field>();
  for (const f of need) if (!hasField(have, f) && !settled.has(f)) out.add(f);
  return out;
}

/**
 * What a track could still gain from an online pass.
 *
 * Manual values are never replaced (§4 stage 3), so a manual BPM is not a gap.
 * A genre tag is only worth reaching the iTunes tier for when the track has no
 * genre of its own; both rekordbox and Apple exports carry one for nearly
 * everything, and iTunes' `primaryGenreName` largely restates it at 3.2 s a
 * track.
 */
export function neededFields(t: Track): Field[] {
  const need: Field[] = [];
  if (!t.bpm && t.source?.bpm !== "manual") need.push("bpm");
  if (!t.key && t.source?.key !== "manual") need.push("key");
  if (!t.previewUrl) need.push("previewUrl");
  if (!t.label) need.push("label");
  if (!t.genre && !t.tags?.length) need.push("tags");
  return need;
}
