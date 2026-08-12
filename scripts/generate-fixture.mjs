#!/usr/bin/env node
/**
 * Generates a synthetic Apple Music Library.xml that reproduces the measured
 * properties of the reference library (§0 of the plan):
 *   - 6,263 tracks, 2 with Location, 0 with BPM/key
 *   - 100% Genre coverage, 90 distinct, ~45% "Pop"/"Alternative"
 *   - 150 playlists (147 real + auto ones), 93% coverage, 82% single-playlist
 *   - 8.8% Date Added, years 1947–2026, CJK subset
 * Deterministic (seeded) so tests are stable.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "..", "test", "fixtures", "Library.xml");
const N_TRACKS = parseInt(process.argv[3] ?? "6263", 10);
const N_REAL_PLAYLISTS = Math.max(3, Math.round(147 * (N_TRACKS / 6263)));

let seed = 20260811;
function rand() {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = (a) => a[Math.floor(rand() * a.length)];
const rint = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));

const GENRES = ["Pop", "Alternative"];
const GENRE_POOL = [
  "House", "Deep House", "Tech House", "Techno", "Trance", "Progressive House",
  "Electro", "Drum & Bass", "UK Garage", "Disco", "Nu-Disco", "Dance", "EDM",
  "Hip-Hop/Rap", "R&B/Soul", "Jazz", "Classical", "Rock", "Indie Rock", "Metal",
  "Folk", "Country", "Blues", "Reggae", "Latin", "K-Pop", "J-Pop", "Mandopop",
  "Cantopop", "City Pop", "Ambient", "IDM", "Downtempo", "Trip-Hop", "Lo-Fi",
  "Soundtrack", "World", "Afrobeats", "Amapiano", "Funk", "Gospel", "Punk",
];
for (let i = 0; GENRES.length < 90; i++) {
  GENRES.push(GENRE_POOL[i % GENRE_POOL.length] + (i >= GENRE_POOL.length ? ` ${Math.floor(i / GENRE_POOL.length) + 1}` : ""));
}

const WORDS = "midnight neon river echo golden shadow velvet electric summer winter broken silent crystal wild lonely burning distant fading rising falling sweet bitter heavy light".split(" ");
const CJK_TITLES = ["想家", "月亮代表我的心", "夜に駆ける", "打上花火", "小幸運", "告白気球", "紅蓮華", "海阔天空", "光年之外", "夜曲"];
const CJK_ARTISTS = ["周杰倫", "鄧紫棋", "YOASOBI", "米津玄師", "五月天", "王菲", "陳奕迅", "宇多田ヒカル"];

const N_ARTISTS = Math.max(20, Math.round(N_TRACKS / 8));
const artists = [];
for (let i = 0; i < N_ARTISTS; i++) {
  if (i < N_ARTISTS * 0.06) artists.push(pick(CJK_ARTISTS) + (i > 8 ? ` ${i}` : ""));
  else artists.push(`${cap(pick(WORDS))} ${cap(pick(WORDS))}${rand() < 0.2 ? " & The " + cap(pick(WORDS)) + "s" : ""}`);
}
function cap(w) { return w[0].toUpperCase() + w.slice(1); }

function title(i) {
  if (rand() < 0.05) return pick(CJK_TITLES);
  let t = `${cap(pick(WORDS))} ${cap(pick(WORDS))}`;
  const r = rand();
  if (r < 0.08) t += " (Extended Mix)";
  else if (r < 0.12) t += " [Remastered 2019]";
  else if (r < 0.15) t += " - Radio Edit";
  else if (r < 0.18) t += ` (feat. ${pick(artists)})`;
  else if (r < 0.2) t += " & More"; // exercise entity escaping
  return t + (rand() < 0.4 ? ` ${i % 97}` : "");
}

function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function pidHex() {
  let s = "";
  for (let i = 0; i < 16; i++) s += "0123456789ABCDEF"[Math.floor(rand() * 16)];
  return s;
}

// --- tracks ---
// Year and duration correlate with genre, as in real libraries: each genre
// has an era center and a typical track length. Without this, the numeric
// block is pure noise, which no real library exhibits.
const genreEra = new Map();
const genreDur = new Map();
GENRES.forEach((g, i) => {
  genreEra.set(g, 1955 + Math.floor(rand() * 62)); // era center 1955–2017
  genreDur.set(g, 180000 + Math.floor(rand() * 180000)); // 3–6 min typical
});

const tracks = [];
const usedPids = new Set();
for (let i = 0; i < N_TRACKS; i++) {
  // ~45% Pop/Alternative (low-information genres, §0)
  const genre = rand() < 0.45 ? (rand() < 0.55 ? "Pop" : "Alternative") : GENRES[rint(2, GENRES.length - 1)];
  // artist correlates with genre so structure exists to find
  const artistIdx = (GENRES.indexOf(genre) * 7 + rint(0, 6)) % artists.length;
  let pid;
  do { pid = pidHex(); } while (usedPids.has(pid));
  usedPids.add(pid);
  const era = genreEra.get(genre);
  const year = Math.max(1947, Math.min(2026, era + rint(-9, 9)));
  const dur = Math.max(90000, genreDur.get(genre) + rint(-45000, 45000));
  tracks.push({
    trackId: 1000 + i * 2, // non-contiguous, like real exports
    pid,
    name: title(i),
    artist: i === 0 ? undefined : artists[artistIdx], // 1 track with no artist (§2)
    album: `${cap(pick(WORDS))} ${cap(pick(WORDS))}`,
    genre,
    year: rint(0, 100) < 92 ? year : undefined,
    totalTime: dur,
    dateAdded: rand() < 0.088 ? `20${rint(15, 25)}-0${rint(1, 9)}-1${rint(0, 9)}T12:00:00Z` : undefined,
    location: i < 2 ? `file:///Users/dj/Music/track${i}.mp3` : undefined,
  });
}

// --- playlists: genre-biased so co-occurrence has structure ---
// 82% of playlisted tracks in exactly one playlist; 93% coverage.
const realPlaylists = [];
const trackPlaylistCount = new Array(N_TRACKS).fill(0);
const byGenre = new Map();
tracks.forEach((t, i) => {
  if (!byGenre.has(t.genre)) byGenre.set(t.genre, []);
  byGenre.get(t.genre).push(i);
});
const genreKeys = [...byGenre.keys()];

const targetCovered = Math.round(N_TRACKS * 0.93);
const coverage = new Set();
for (let p = 0; p < N_REAL_PLAYLISTS; p++) {
  const primary = genreKeys[p % genreKeys.length];
  const secondary = genreKeys[(p * 3 + 1) % genreKeys.length];
  const size = p % 10 === 0 ? rint(180, 360) : rint(12, 60); // a few catch-alls
  // Playlists are ~75% primary genre, ~25% secondary — coherent but not pure.
  const priPool = byGenre.get(primary);
  const secPool = byGenre.get(secondary);
  const items = new Set();
  for (let tries = 0; items.size < size && tries < size * 8; tries++) {
    const pool = rand() < 0.75 ? priPool : secPool;
    const idx = pool[Math.floor(rand() * pool.length)];
    // enforce sparsity: prefer tracks not yet playlisted
    if (trackPlaylistCount[idx] >= 1 && rand() < 0.82) continue;
    items.add(idx);
  }
  for (const idx of items) {
    trackPlaylistCount[idx]++;
    coverage.add(idx);
  }
  realPlaylists.push({
    name: `${primary} ${p % 10 === 0 ? "Everything" : ["Nights", "Warmup", "Peak", "Sunset", "Deep Cuts", "Classics", "2020s", "Gems"][p % 8]} ${Math.floor(p / 8)}`,
    items: [...items].map((i) => tracks[i].trackId),
  });
}
// top up coverage to ~93%
let cursor = 0;
while (coverage.size < targetCovered && cursor < N_TRACKS) {
  if (!coverage.has(cursor)) {
    const p = realPlaylists[cursor % realPlaylists.length];
    p.items.push(tracks[cursor].trackId);
    trackPlaylistCount[cursor]++;
    coverage.add(cursor);
  }
  cursor++;
}

// --- serialize ---
const lines = [];
lines.push('<?xml version="1.0" encoding="UTF-8"?>');
lines.push('<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">');
lines.push('<plist version="1.0">');
lines.push("<dict>");
lines.push("\t<key>Major Version</key><integer>1</integer>");
lines.push("\t<key>Minor Version</key><integer>1</integer>");
lines.push("\t<key>Application Version</key><string>1.4.6.63</string>");
lines.push("\t<key>Tracks</key>");
lines.push("\t<dict>");
for (const t of tracks) {
  lines.push(`\t\t<key>${t.trackId}</key>`);
  lines.push("\t\t<dict>");
  lines.push(`\t\t\t<key>Track ID</key><integer>${t.trackId}</integer>`);
  lines.push(`\t\t\t<key>Name</key><string>${esc(t.name)}</string>`);
  if (t.artist) lines.push(`\t\t\t<key>Artist</key><string>${esc(t.artist)}</string>`);
  lines.push(`\t\t\t<key>Album</key><string>${esc(t.album)}</string>`);
  lines.push(`\t\t\t<key>Genre</key><string>${esc(t.genre)}</string>`);
  if (t.year) lines.push(`\t\t\t<key>Year</key><integer>${t.year}</integer>`);
  lines.push(`\t\t\t<key>Total Time</key><integer>${t.totalTime}</integer>`);
  if (t.dateAdded) lines.push(`\t\t\t<key>Date Added</key><date>${t.dateAdded}</date>`);
  if (t.location) lines.push(`\t\t\t<key>Location</key><string>${esc(t.location)}</string>`);
  lines.push(`\t\t\t<key>Persistent ID</key><string>${t.pid}</string>`);
  lines.push("\t\t</dict>");
}
lines.push("\t</dict>");
lines.push("\t<key>Playlists</key>");
lines.push("\t<array>");

function playlistXml({ name, items, master, distinguishedKind }) {
  const out = [];
  out.push("\t\t<dict>");
  out.push(`\t\t\t<key>Name</key><string>${esc(name)}</string>`);
  if (master) out.push("\t\t\t<key>Master</key><true/>");
  if (distinguishedKind) out.push(`\t\t\t<key>Distinguished Kind</key><integer>${distinguishedKind}</integer>`);
  out.push(`\t\t\t<key>Playlist ID</key><integer>${rint(10000, 99999)}</integer>`);
  out.push(`\t\t\t<key>Playlist Persistent ID</key><string>${pidHex()}</string>`);
  out.push("\t\t\t<key>All Items</key><true/>");
  if (items.length) {
    out.push("\t\t\t<key>Playlist Items</key>");
    out.push("\t\t\t<array>");
    for (const id of items) {
      out.push(`\t\t\t\t<dict><key>Track ID</key><integer>${id}</integer></dict>`);
    }
    out.push("\t\t\t</array>");
  }
  out.push("\t\t</dict>");
  return out.join("\n");
}

// auto playlists first, like real exports (the 550-track duplicate pattern:
// "Library" and "Music" with identical full membership)
const allIds = tracks.map((t) => t.trackId);
lines.push(playlistXml({ name: "Library", items: allIds, master: true }));
lines.push(playlistXml({ name: "Music", items: allIds, distinguishedKind: 4 }));
lines.push(playlistXml({ name: "Downloaded", items: allIds.slice(0, 550), distinguishedKind: 65 }));
for (const p of realPlaylists) lines.push(playlistXml(p));
lines.push("\t</array>");
lines.push("</dict>");
lines.push("</plist>");

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, lines.join("\n"), "utf8");

const covered = coverage.size;
const single = trackPlaylistCount.filter((c) => c === 1).length;
console.log(`Wrote ${OUT}`);
console.log(`tracks=${N_TRACKS} realPlaylists=${realPlaylists.length} (+3 auto)`);
console.log(`coverage=${covered} (${((covered / N_TRACKS) * 100).toFixed(1)}%)`);
console.log(`single-playlist=${single} (${((single / covered) * 100).toFixed(1)}% of covered)`);
