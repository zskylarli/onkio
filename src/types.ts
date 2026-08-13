/** Core track model (§2). `pid` (Persistent ID) is the durable key; `trackId`
 * is the per-export integer used only to join playlists at parse time. */
export type Track = {
  pid: string;
  trackId: number;
  name: string;
  artist?: string;
  album?: string;
  genre?: string;
  year?: number;
  durationMs: number;
  dateAdded?: string;
  location?: string;
  playlists: string[];
  bpm?: number;
  /** raw estimate looks like half/double-time given genre (§4) — flagged, not auto-corrected */
  bpmSuspect?: boolean;
  key?: string; // Camelot, e.g. "8A"
  confidence?: { bpm?: number; key?: number };
  tags?: string[];
  /** Record label / imprint, cleaned for display and vocabulary matching. */
  label?: string;
  /** Where bpm/key/label came from. */
  source?: { bpm?: string; key?: string; label?: string };
  previewUrl?: string;
  /** Deezer's track id. Its preview URLs are signed and live 15 minutes, so the
   * id rather than the URL is what makes audio obtainable later (enrich/preview). */
  deezerId?: number;
  /** Timbral fingerprint measured from audio (src/dsp/timbre.ts) — a preview,
   * or an excerpt of the local file where one was resolved. Present only for
   * tracks that could actually be heard. */
  timbre?: Float32Array;
  /** Which imported collection this track came from (`CollectionMeta.id`).
   * Absent on libraries saved before collections existed. */
  collection?: string;
};

export type CollectionFormat = "rekordbox" | "rekordbox-txt" | "apple";

/** One imported file, kept as provenance after a union (src/collections). */
export type CollectionMeta = {
  /** stable key stored on every track of this collection */
  id: string;
  /** user-visible name, normally the file name */
  label: string;
  format: CollectionFormat;
  trackCount: number;
  /** ISO timestamp of the import */
  addedAt: string;
  /** Set only when the import was sampled: how many tracks the file held. */
  sampledFrom?: number;
};

export type Playlist = {
  name: string;
  /** persistent ids of member tracks */
  pids: string[];
};

export type Library = {
  tracks: Track[];
  playlists: Playlist[];
  /** playlists dropped as auto-generated, for UI transparency */
  droppedPlaylists: string[];
  /** Every file that went into this library, in import order. One entry for a
   * plain import, more after a union. */
  collections?: CollectionMeta[];
};

/** Result of an external lookup or DSP pass, merged into Track. */
export type FeatureLookup = {
  bpm?: number;
  key?: string;
  label?: string;
  tags?: string[];
  previewUrl?: string;
  deezerId?: number;
  confidence?: { bpm?: number; key?: number };
  source?: string;
  /** Source of label specifically; other lookup fields may come from another service. */
  labelSource?: string;
};

export type EmbedPoint = {
  pid: string;
  x: number;
  y: number;
  cluster: number;
};
