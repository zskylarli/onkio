import type { Library, Playlist, Track } from "../types";
import { toCamelot } from "../music/camelot";
import { canonicalLabel } from "../enrich/label";

/**
 * rekordbox `DJ_PLAYLISTS` collection XML.
 *
 * This is the preferred source of BPM and key: the values are the user's own
 * rekordbox analysis of the actual audio, not a guess from a 30s preview or a
 * third-party database keyed on a fuzzy title match. A real export runs ~98%
 * complete on both fields, which is a different world from what the online
 * sources manage.
 *
 * Shape (attributes only — rekordbox puts everything in attributes, and they
 * routinely wrap across lines):
 *
 *   <DJ_PLAYLISTS Version="1.0.0">
 *     <COLLECTION Entries="1079">
 *       <TRACK TrackID="209501597" Name="…" Artist="…" AverageBpm="124.00"
 *              Tonality="6A" TotalTime="222" Location="file://localhost/…"/>
 *     </COLLECTION>
 *     <PLAYLISTS>
 *       <NODE Type="0" Name="ROOT" Count="29">
 *         <NODE Name="Chill House" Type="1" KeyType="0" Entries="50">
 *           <TRACK Key="211916638"/>
 *
 * Parsed incrementally rather than through a DOM: a collection is one tag per
 * track and grows with the crate, and we already stream the Apple export.
 */

// ---------- tag scanner ----------

export type Tag = {
  name: string;
  attrs: Record<string, string>;
  /** `<X/>` */
  selfClosing: boolean;
  /** `</X>` */
  closing: boolean;
};

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

export function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X"
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** `file://localhost/Users/x/My%20Track.mp3` → `/Users/x/My Track.mp3` */
export function decodeLocation(raw: string): string {
  let s = raw.replace(/^file:\/\/(localhost)?/, "");
  try {
    s = decodeURIComponent(s);
  } catch {
    // A stray '%' that isn't an escape — keep the raw form rather than throw.
  }
  return s;
}

function parseAttrs(body: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of body.matchAll(/([A-Za-z_][\w.:-]*)\s*=\s*"([^"]*)"/g)) {
    attrs[m[1]] = decodeEntities(m[2]);
  }
  return attrs;
}

/**
 * Feed chunks, get complete tags. Buffers a partial tag across chunk
 * boundaries and ignores text nodes, comments, and the XML declaration.
 * Quote-aware, because an attribute value may legally contain `>`.
 */
export function createTagScanner(onTag: (tag: Tag) => void) {
  let buf = "";
  return {
    write(chunk: string): void {
      buf += chunk;
      for (;;) {
        const start = buf.indexOf("<");
        if (start < 0) {
          buf = "";
          return;
        }
        // Comments / CDATA / doctype: skip to their own terminator.
        if (buf.startsWith("<!--", start)) {
          const end = buf.indexOf("-->", start);
          if (end < 0) {
            buf = buf.slice(start);
            return;
          }
          buf = buf.slice(end + 3);
          continue;
        }
        let i = start + 1;
        let quoted = false;
        for (; i < buf.length; i++) {
          const c = buf[i];
          if (c === '"') quoted = !quoted;
          else if (c === ">" && !quoted) break;
        }
        if (i >= buf.length) {
          // Incomplete tag — wait for more input.
          buf = buf.slice(start);
          return;
        }
        const inner = buf.slice(start + 1, i);
        buf = buf.slice(i + 1);
        if (inner[0] === "?" || inner[0] === "!") continue;

        const closing = inner[0] === "/";
        const selfClosing = inner.endsWith("/");
        const body = inner.slice(closing ? 1 : 0, selfClosing ? -1 : undefined);
        const nameMatch = body.match(/^([A-Za-z_][\w.:-]*)/);
        if (!nameMatch) continue;
        onTag({
          name: nameMatch[1],
          attrs: closing ? {} : parseAttrs(body.slice(nameMatch[1].length)),
          selfClosing,
          closing,
        });
      }
    },
    end(): void {
      buf = "";
    },
  };
}

// ---------- track mapping ----------

/**
 * rekordbox has no equivalent of Apple's Persistent ID, but `pid` is what
 * overrides and caches are keyed on, so it has to survive a re-export. The
 * file path is the most durable identity available — TrackID is a rekordbox
 * database row id and changes if the collection is rebuilt on another
 * machine, whereas a track keeps its path. Prefixed so a rekordbox pid can
 * never collide with an Apple one.
 */
export function rekordboxPid(attrs: Record<string, string>): string {
  const loc = attrs.Location ? decodeLocation(attrs.Location) : "";
  const named = `${attrs.Artist ?? ""}|${attrs.Name ?? ""}`;
  // `Artist|Name` carries the separator whether or not either field is there,
  // so it is never the empty string and the row id can only be reached by
  // testing for it. Anything that gets that far names nothing at all and
  // `rekordboxTrack` refuses to make a track of it; the branch exists so that
  // two such rows are still told apart rather than hashing to one pid.
  const basis = loc || (named === "|" ? `id:${attrs.TrackID ?? ""}` : named);
  return `rb:${hash64(basis)}`;
}

/** FNV-1a over two offset bases — 64 bits of hex, no dependencies. */
function hash64(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

function nonEmpty(v: string | undefined): string | undefined {
  const s = v?.trim();
  return s ? s : undefined;
}

/**
 * A rekordbox collection also holds the Pioneer sampler one-shots (NOISE,
 * SINEWAVE, …): a few seconds long, no artist, no BPM. They are not music and
 * they distort the map, so they are dropped — but counted and reported rather
 * than silently discarded.
 */
function isSamplerOneShot(t: Track): boolean {
  return t.durationMs > 0 && t.durationMs < 30_000 && t.bpm === undefined;
}

export function rekordboxTrack(attrs: Record<string, string>): Track | null {
  const name = nonEmpty(attrs.Name);
  if (!name) return null;

  const t: Track = {
    pid: rekordboxPid(attrs),
    trackId: parseInt(attrs.TrackID ?? "", 10) || 0,
    name,
    // rekordbox counts TotalTime in seconds; Apple's "Total Time" is already
    // milliseconds. Track.durationMs is milliseconds.
    durationMs: Math.round((parseFloat(attrs.TotalTime ?? "") || 0) * 1000),
    playlists: [],
  };

  const artist = nonEmpty(attrs.Artist);
  if (artist) t.artist = artist;
  const album = nonEmpty(attrs.Album);
  if (album) t.album = album;
  const genre = nonEmpty(attrs.Genre);
  if (genre) t.genre = genre;

  const year = parseInt(attrs.Year ?? "", 10);
  if (year > 0) t.year = year;

  if (attrs.Location) t.location = decodeLocation(attrs.Location);

  const added = nonEmpty(attrs.DateAdded);
  if (added) {
    const d = new Date(added);
    if (!isNaN(d.getTime())) t.dateAdded = d.toISOString();
  }

  // The whole point of the import. Confidence 1: this is the user's own
  // analysis of the actual file, so it outranks every online source.
  const bpm = parseFloat(attrs.AverageBpm ?? "");
  if (Number.isFinite(bpm) && bpm > 0) {
    t.bpm = bpm;
    t.confidence = { ...t.confidence, bpm: 1 };
    t.source = { ...t.source, bpm: "rekordbox" };
  }
  const key = toCamelot(attrs.Tonality);
  if (key) {
    t.key = key;
    t.confidence = { ...t.confidence, key: 1 };
    t.source = { ...t.source, key: "rekordbox" };
  }

  const label = canonicalLabel(attrs.Label, artist);
  if (label) {
    t.label = label;
    t.source = { ...t.source, label: "rekordbox" };
  }
  // Remixer remains a multi-valued external tag. Label is deliberately routed
  // to its own block rather than being mixed into this vocabulary.
  const remixer = nonEmpty(attrs.Remixer);
  if (remixer) t.tags = [remixer];

  return t;
}

// ---------- collection parser ----------

export type RekordboxStats = {
  /** `Entries` as declared by the file. */
  declared: number;
  parsed: number;
  /** sampler one-shots dropped */
  skipped: number;
  withBpm: number;
  withKey: number;
};

export type RekordboxCollection = Library & { stats: RekordboxStats };

export type RekordboxCallbacks = {
  onProgress?: (tracks: number) => void;
};

type PendingPlaylist = { name: string; keys: string[]; keyType: string };

/**
 * Incremental parser for a whole `DJ_PLAYLISTS` document. Feed chunks to
 * `write`, then call `end()` for the assembled collection.
 */
export function createRekordboxParser(cb: RekordboxCallbacks = {}) {
  const tracks: Track[] = [];
  const byTrackId = new Map<number, Track>();
  const byLocation = new Map<string, Track>();
  const stats: RekordboxStats = {
    declared: 0,
    parsed: 0,
    skipped: 0,
    withBpm: 0,
    withKey: 0,
  };

  let inCollection = false;
  let inPlaylists = false;
  /** NODE names from ROOT down, so folders can prefix their playlists. */
  const nodeStack: { name: string; playlist: PendingPlaylist | null }[] = [];
  const playlists: PendingPlaylist[] = [];

  const scanner = createTagScanner((tag) => {
    switch (tag.name) {
      case "COLLECTION":
        if (tag.closing) inCollection = false;
        else {
          inCollection = !tag.selfClosing;
          stats.declared = parseInt(tag.attrs.Entries ?? "", 10) || 0;
        }
        return;

      case "PLAYLISTS":
        inPlaylists = !tag.closing;
        return;

      case "NODE": {
        if (tag.closing) {
          nodeStack.pop();
          return;
        }
        const name = tag.attrs.Name ?? "";
        const isPlaylist = tag.attrs.Type === "1";
        const entry = {
          name,
          playlist: isPlaylist
            ? { name: playlistPath(nodeStack, name), keys: [], keyType: tag.attrs.KeyType ?? "0" }
            : null,
        };
        if (entry.playlist) playlists.push(entry.playlist);
        if (!tag.selfClosing) nodeStack.push(entry);
        return;
      }

      case "TRACK": {
        if (tag.closing) return;
        if (inPlaylists) {
          const current = nodeStack[nodeStack.length - 1]?.playlist;
          if (current && tag.attrs.Key !== undefined) current.keys.push(tag.attrs.Key);
          return;
        }
        if (!inCollection) return;
        const t = rekordboxTrack(tag.attrs);
        if (!t) return;
        if (isSamplerOneShot(t)) {
          stats.skipped++;
          return;
        }
        tracks.push(t);
        if (t.trackId) byTrackId.set(t.trackId, t);
        if (t.location) byLocation.set(t.location, t);
        if (t.bpm !== undefined) stats.withBpm++;
        if (t.key !== undefined) stats.withKey++;
        if (tracks.length % 500 === 0) cb.onProgress?.(tracks.length);
        return;
      }
    }
  });

  return {
    write(chunk: string): void {
      scanner.write(chunk);
    },
    end(): RekordboxCollection {
      scanner.end();
      stats.parsed = tracks.length;

      const out: Playlist[] = [];
      const droppedPlaylists: string[] = [];
      for (const p of playlists) {
        const pids: string[] = [];
        for (const key of p.keys) {
          // KeyType 0 references TrackID; 1 references Location.
          const t =
            p.keyType === "1"
              ? byLocation.get(decodeLocation(key))
              : byTrackId.get(parseInt(key, 10));
          if (t && !t.playlists.includes(p.name)) {
            pids.push(t.pid);
            t.playlists.push(p.name);
          }
        }
        if (pids.length === 0) droppedPlaylists.push(p.name);
        else out.push({ name: p.name, pids });
      }

      cb.onProgress?.(tracks.length);
      return { tracks, playlists: out, droppedPlaylists, stats };
    },
  };
}

/** Folders become a path prefix: "Crates / Deep House". ROOT is not a folder. */
function playlistPath(
  stack: { name: string; playlist: PendingPlaylist | null }[],
  name: string
): string {
  const folders = stack.map((s) => s.name).filter((n) => n && n !== "ROOT");
  return [...folders, name].join(" / ");
}

/** Convenience for tests and small inputs. */
export function parseRekordbox(xml: string): RekordboxCollection {
  const p = createRekordboxParser();
  p.write(xml);
  return p.end();
}
