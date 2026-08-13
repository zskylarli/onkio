import type { CollectionMeta, Library, Playlist } from "../types";

/**
 * Union of two imported files into one library, with provenance.
 *
 * This is a union, not a match: nothing is fused, no field of one collection
 * is used to fill a hole in the other. Every track keeps its own identity and
 * gains a `collection` tag, so the map can show a DJ crate and a listening
 * library in one space and say which is which.
 *
 * Two identity questions have to be settled for that to work:
 *
 * - **Track identity.** `pid` is already collision-proof across formats —
 *   rekordbox pids are `rb:` + a path hash, Apple's are 16 hex digits — so a
 *   pid appearing in both really is the same track, and the first import
 *   wins. It still inherits the second collection's playlist memberships,
 *   because those are facts about the track.
 * - **Playlist identity.** Names are *not* unique across files: two people's
 *   exports both contain "Chill". Colliding names are suffixed with the
 *   collection they came from, and the tracks' own `playlists` arrays are
 *   rewritten to match, or a highlight would light up the wrong collection.
 */

export type MergeReport = {
  /** tracks actually appended */
  added: number;
  /** incoming tracks whose pid was already present */
  duplicatePids: number;
  /** playlists renamed to avoid a name collision, `[from, to]` */
  renamedPlaylists: [string, string][];
  /** the file contributed no track, so the library is returned untouched */
  redundant: boolean;
};

export function slugifyCollectionId(label: string): string {
  const base = label
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return base || "collection";
}

/** Give every track in a freshly parsed library its provenance tag. */
export function tagCollection(lib: Library, meta: CollectionMeta): Library {
  for (const t of lib.tracks) t.collection = meta.id;
  return {
    ...lib,
    collections: [{ ...meta, trackCount: lib.tracks.length }],
  };
}

/** An id not already used by `existing`. */
export function uniqueCollectionId(existing: CollectionMeta[], wanted: string): string {
  const taken = new Set(existing.map((c) => c.id));
  if (!taken.has(wanted)) return wanted;
  for (let i = 2; ; i++) {
    const candidate = `${wanted}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

function uniquePlaylistName(taken: Set<string>, name: string, suffix: string): string {
  let candidate = `${name} [${suffix}]`;
  for (let i = 2; taken.has(candidate); i++) candidate = `${name} [${suffix} ${i}]`;
  return candidate;
}

/**
 * Append `incoming` to `base`. Both are consumed by reference for track
 * objects (the tracks themselves are reused, not copied), so callers should
 * not keep using the incoming library afterwards.
 */
export function mergeLibraries(
  base: Library,
  incoming: Library
): { library: Library; report: MergeReport } {
  const report: MergeReport = {
    added: 0,
    duplicatePids: 0,
    renamedPlaylists: [],
    redundant: false,
  };

  // A file already loaded in full is not a union, it is a no-op, and it has to
  // be treated as one before anything is appended. Its collection owns no
  // track, so listing it would put a row with a borrowed count beside the real
  // ones and leave `trackCount` summing to more than the library holds; and its
  // playlists are the same playlists, so suffixing them with the collection
  // would file every one of them twice under a second name.
  const basePids = new Set(base.tracks.map((t) => t.pid));
  if (!incoming.tracks.some((t) => !basePids.has(t.pid))) {
    report.duplicatePids = incoming.tracks.length;
    report.redundant = true;
    return { library: base, report };
  }

  const collections = [...(base.collections ?? []), ...(incoming.collections ?? [])];
  const incomingLabel =
    incoming.collections?.[incoming.collections.length - 1]?.label ??
    incoming.collections?.[0]?.id ??
    "added";

  // --- playlist names ---
  const takenNames = new Set(base.playlists.map((p) => p.name));
  const rename = new Map<string, string>();
  for (const p of incoming.playlists) {
    if (!takenNames.has(p.name)) {
      takenNames.add(p.name);
      continue;
    }
    const next = uniquePlaylistName(takenNames, p.name, incomingLabel);
    takenNames.add(next);
    rename.set(p.name, next);
    report.renamedPlaylists.push([p.name, next]);
  }

  if (rename.size > 0) {
    for (const t of incoming.tracks) {
      if (t.playlists.length === 0) continue;
      t.playlists = t.playlists.map((n) => rename.get(n) ?? n);
    }
  }

  // --- tracks ---
  const byPid = new Map(base.tracks.map((t) => [t.pid, t]));
  const tracks = base.tracks.slice();
  for (const t of incoming.tracks) {
    const existing = byPid.get(t.pid);
    if (existing) {
      report.duplicatePids++;
      // The same track filed in both collections: keep the first, but it is
      // genuinely a member of the second collection's playlists too.
      for (const name of t.playlists)
        if (!existing.playlists.includes(name)) existing.playlists.push(name);
      continue;
    }
    byPid.set(t.pid, t);
    tracks.push(t);
    report.added++;
  }

  const playlists: Playlist[] = [
    ...base.playlists,
    ...incoming.playlists.map((p) => ({
      name: rename.get(p.name) ?? p.name,
      pids: p.pids,
    })),
  ];

  const counts = new Map<string, number>();
  for (const t of tracks) if (t.collection) counts.set(t.collection, (counts.get(t.collection) ?? 0) + 1);

  return {
    library: {
      tracks,
      playlists,
      droppedPlaylists: [...base.droppedPlaylists, ...incoming.droppedPlaylists],
      collections: collections.map((c) => ({ ...c, trackCount: counts.get(c.id) ?? c.trackCount })),
    },
    report,
  };
}

/** Drop one collection back out of a union, so an add is reversible. */
export function removeCollection(lib: Library, id: string): Library {
  const tracks = lib.tracks.filter((t) => t.collection !== id);
  const keep = new Set(tracks.map((t) => t.pid));
  const playlists = lib.playlists
    .map((p) => ({ name: p.name, pids: p.pids.filter((pid) => keep.has(pid)) }))
    .filter((p) => p.pids.length > 0);
  const names = new Set(playlists.map((p) => p.name));
  for (const t of tracks) {
    if (t.playlists.some((n) => !names.has(n))) t.playlists = t.playlists.filter((n) => names.has(n));
  }
  return {
    tracks,
    playlists,
    droppedPlaylists: lib.droppedPlaylists,
    collections: (lib.collections ?? []).filter((c) => c.id !== id),
  };
}

/**
 * A library imported before provenance existed, or one restored from a save,
 * still needs every track to carry a collection id — otherwise the comparison
 * views see one unnamed group and a second import cannot be told apart from
 * the first.
 */
export function ensureCollections(lib: Library, fallbackLabel = "Imported library"): Library {
  if (lib.collections?.length && lib.tracks.every((t) => t.collection)) return lib;
  const id = lib.collections?.[0]?.id ?? slugifyCollectionId(fallbackLabel);
  for (const t of lib.tracks) t.collection ??= id;
  return {
    ...lib,
    collections: lib.collections?.length
      ? lib.collections
      : [
          {
            id,
            label: fallbackLabel,
            format: lib.tracks.some((t) => t.pid.startsWith("rbtxt:"))
              ? "rekordbox-txt"
              : lib.tracks.some((t) => t.pid.startsWith("rb:"))
                ? "rekordbox"
                : "apple",
            trackCount: lib.tracks.length,
            addedAt: new Date().toISOString(),
          },
        ],
  };
}
