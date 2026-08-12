#!/usr/bin/env node
/**
 * A tiny Library.xml of REAL tracks, for verifying enrichment against the live
 * APIs. The synthetic fixture invents artists and titles, so every lookup
 * against it legitimately misses — which makes it useless for telling a
 * working adapter apart from a broken one.
 */
import { writeFileSync } from "node:fs";

const OUT = process.argv[2] ?? "dist/RealTracks.xml";

const TRACKS = [
  ["Daft Punk", "Around the World", "Electronic", 1997],
  ["Fleetwood Mac", "Dreams", "Rock", 1977],
  ["Miles Davis", "So What", "Jazz", 1959],
  ["Radiohead", "Idioteque", "Alternative", 2000],
  ["Taylor Swift", "Anti-Hero", "Pop", 2022],
  ["米津玄師", "Lemon", "J-Pop", 2018],
  ["YOASOBI", "夜に駆ける", "J-Pop", 2019],
  ["NewJeans", "Ditto", "K-Pop", 2022],
  ["The Chemical Brothers", "Block Rockin' Beats", "Electronic", 1997],
  ["Aphex Twin", "Windowlicker", "IDM", 1999],
  ["Nina Simone", "Feeling Good", "Jazz", 1965],
  ["Fela Kuti", "Water No Get Enemy", "Afrobeats", 1975],
  ["Burial", "Archangel", "Electronic", 2007],
  ["Kendrick Lamar", "Money Trees", "Hip-Hop/Rap", 2012],
  ["Portishead", "Glory Box", "Trip-Hop", 1994],
  ["周杰倫", "告白氣球", "Mandopop", 2016],
];

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const pid = (i) => String(i).padStart(16, "A");

const lines = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
  '<plist version="1.0">',
  "<dict>",
  "\t<key>Major Version</key><integer>1</integer>",
  "\t<key>Minor Version</key><integer>1</integer>",
  "\t<key>Tracks</key>",
  "\t<dict>",
];

TRACKS.forEach(([artist, name, genre, year], i) => {
  const id = 1000 + i * 2;
  lines.push(`\t\t<key>${id}</key>`, "\t\t<dict>");
  lines.push(`\t\t\t<key>Track ID</key><integer>${id}</integer>`);
  lines.push(`\t\t\t<key>Name</key><string>${esc(name)}</string>`);
  lines.push(`\t\t\t<key>Artist</key><string>${esc(artist)}</string>`);
  lines.push(`\t\t\t<key>Album</key><string>${esc(name)}</string>`);
  lines.push(`\t\t\t<key>Genre</key><string>${esc(genre)}</string>`);
  lines.push(`\t\t\t<key>Year</key><integer>${year}</integer>`);
  lines.push(`\t\t\t<key>Total Time</key><integer>240000</integer>`);
  lines.push(`\t\t\t<key>Persistent ID</key><string>${pid(i)}</string>`);
  lines.push("\t\t</dict>");
});

lines.push("\t</dict>", "\t<key>Playlists</key>", "\t<array>", "\t\t<dict>");
lines.push("\t\t\t<key>Name</key><string>Real Test</string>");
lines.push("\t\t\t<key>Playlist Persistent ID</key><string>PLAYLIST00000001</string>");
lines.push("\t\t\t<key>Playlist Items</key>", "\t\t\t<array>");
TRACKS.forEach((_t, i) => {
  lines.push("\t\t\t\t<dict>");
  lines.push(`\t\t\t\t\t<key>Track ID</key><integer>${1000 + i * 2}</integer>`);
  lines.push("\t\t\t\t</dict>");
});
lines.push("\t\t\t</array>", "\t\t</dict>", "\t</array>", "</dict>", "</plist>");

writeFileSync(OUT, lines.join("\n"), "utf8");
console.log(`wrote ${OUT} — ${TRACKS.length} real tracks`);
