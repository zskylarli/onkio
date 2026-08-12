/**
 * Writes test/fixtures/apple_getsongbpm_analyzed.xml: the tracks a real
 * GetSongBPM trial resolved, as a droppable rekordbox collection with their BPM
 * and key baked in.
 *
 * Deterministic — same fixtures in, byte-identical file out — so it can be
 * re-run whenever the subset's gates change.
 *
 *   npx vite-node scripts/emit-analyzed-rekordbox.ts
 *   npx vite-node scripts/emit-analyzed-rekordbox.ts -- --out=/tmp/other.xml
 *
 * --full folds in the sweep of everything the trial sample left over and writes
 * the whole-library file instead. It is a second file rather than a bigger
 * first one because the trial's 311 tracks are what the measurement in
 * scripts/measure-getsongbpm.ts reports on, and that record is worth keeping.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseRekordbox } from "../src/parse/rekordbox";
import { describeAudit } from "./analyzed-subset";
import {
  ANALYZED_FULL_XML,
  ANALYZED_XML,
  GSB_RESULTS,
  GSB_RESULTS_ALL,
  buildAnalyzedRekordbox,
} from "./analyzed-rekordbox";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "..", "test", "fixtures");

function arg(name: string, dflt: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
}

const FULL = process.argv.includes("--full");
const OUT = resolve(arg("out", join(FIXTURES, FULL ? ANALYZED_FULL_XML : ANALYZED_XML)));

const { library, audit, xml } = buildAnalyzedRekordbox(
  FIXTURES,
  FULL ? GSB_RESULTS_ALL : [GSB_RESULTS]
);
for (const line of describeAudit(audit)) console.log(line);

writeFileSync(OUT, xml, "utf8");
const bytes = readFileSync(OUT).byteLength;

// The file is only worth anything if the app's own parser reads it back whole.
const back = parseRekordbox(xml);
const pct = (n: number) => `${((100 * n) / back.tracks.length).toFixed(1)}%`;

console.log(`\nwrote ${OUT}  (${(bytes / 1024).toFixed(1)} KiB)`);
console.log(`  collection:   ${library.tracks.length} tracks in, ${back.tracks.length} back out`);
console.log(`  dropped:      ${back.stats.skipped} (sampler filter)`);
console.log(`  with BPM:     ${back.stats.withBpm}  ${pct(back.stats.withBpm)}`);
console.log(`  with key:     ${back.stats.withKey}  ${pct(back.stats.withKey)}`);
console.log(`  playlists:    ${library.playlists.length} in, ${back.playlists.length} back out`);
console.log(`  detected as:  ${xml.slice(0, 4096).includes("DJ_PLAYLISTS") ? "rekordbox" : "apple"}`);
