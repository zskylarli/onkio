/**
 * Measure GetSongBPM coverage against a real Apple Music library.
 *
 * Answers one question: if we wire GetSongBPM into the app, what fraction of an
 * Apple library (which carries no BPM and no key at all) actually ends up with
 * usable values? It samples deterministically, queries the live API, verifies
 * every candidate with the same scoring the app uses, and checkpoints so a
 * crash or a rate-limit block does not waste the quota already spent.
 *
 * Re-run:
 *   module load nodejs/22.9.0
 *   npx vite-node scripts/measure-getsongbpm.ts -- --key=API_KEY [--n=1000] [--delay=1300]
 *   npx vite-node scripts/measure-getsongbpm.ts -- --report   # analyse the checkpoint
 *
 * The sample is seeded (mulberry32), so a re-run hits the *same* tracks and
 * resumes from the checkpoint rather than spending quota on a fresh set.
 * Pass --restart to discard the checkpoint and start over.
 *
 * To sweep the rest of the library after a trial, exclude what the trial
 * already paid for and write somewhere else, so the trial's record survives:
 *
 *   ... --n=all --exclude=test/fixtures/getsongbpm-results.json \
 *       --out=test/fixtures/getsongbpm-results-remainder.json
 *
 * --plan prints the target set and exits, which is the only honest way to check
 * an exclusion is right: a wrong one is spent quota by the time it shows up.
 *
 * Note the endpoint: api.getsong.co, NOT the documented api.getsongbpm.com.
 * The latter now sits behind a Cloudflare managed challenge and returns 403 to
 * every non-browser client. api.getsong.co does send `access-control-allow-
 * origin: *`, so unlike when the adapter was written, a browser can now read
 * these responses without a proxy.
 *
 * Measured on 2026-08-11 over 1000 tracks of test/fixtures/apple_library.xml:
 * 31.2% of tracks got a trustworthy match, and essentially all of those carried
 * both tempo and key. Search results already include tempo/key_of/open_key, so
 * the /song/ detail call the adapter makes is redundant.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createLibraryParser } from "../src/parse/library";
import { normalizeArtist, normalizeTitle, lookupKey } from "../src/enrich/normalize";
import { pickBest } from "../src/enrich/match";
import { toCamelot } from "../src/music/camelot";
import { mulberry32 } from "../src/util/rng";
import type { Track } from "../src/types";

const API_BASE = "https://api.getsong.co";
const LIBRARY = "test/fixtures/apple_library.xml";
const OUT = "test/fixtures/getsongbpm-results.json";
const SEED = 42;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function arg(name: string, dflt?: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
}
const FLAG = (name: string) => process.argv.includes(`--${name}`);

const API_KEY = arg("key") ?? process.env.GETSONGBPM_KEY;
const N_ARG = arg("n", "1000")!;
const N = N_ARG === "all" ? Infinity : parseInt(N_ARG, 10);
const DELAY_MS = parseInt(arg("delay", "1300")!, 10);
const OUT_PATH = arg("out", OUT)!;
const EXCLUDE_PATHS = (arg("exclude", "") as string).split(",").filter(Boolean);
/** Only --plan is free; everything else either spends quota or needs a key. */
const NEEDS_KEY = !FLAG("report") && !FLAG("plan");

if (!API_KEY && NEEDS_KEY) {
  console.error("missing --key=API_KEY (or set GETSONGBPM_KEY)");
  process.exit(1);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- library

function parseLibrary(): Track[] {
  const xml = readFileSync(LIBRARY, "utf8");
  const parser = createLibraryParser();
  const CHUNK = 1 << 20;
  for (let i = 0; i < xml.length; i += CHUNK) {
    parser.write(xml.slice(i, i + CHUNK));
  }
  return parser.end().tracks;
}

/**
 * Pids already paid for by an earlier run, read from its checkpoint(s).
 *
 * Every entry counts, not just the matches: a miss cost a request too, and
 * re-asking would buy the same miss again. A path that is missing or unreadable
 * is fatal rather than empty, because silently excluding nothing means quietly
 * re-querying a thousand tracks.
 */
function loadExcluded(paths: readonly string[]): Set<string> {
  const pids = new Set<string>();
  for (const p of paths) {
    const prev = JSON.parse(readFileSync(p, "utf8")) as { results?: { pid: string }[] };
    if (!Array.isArray(prev.results)) throw new Error(`${p}: no results array`);
    for (const r of prev.results) pids.add(r.pid);
    console.log(`[exclude] ${p}: ${prev.results.length} results`);
  }
  return pids;
}

/** Fisher-Yates with the app's seeded PRNG, so the sample is reproducible. */
function sample<T>(items: readonly T[], n: number, seed: number): T[] {
  const rnd = mulberry32(seed);
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, Math.min(n, a.length));
}

// ---------------------------------------------------------------- API

type SearchItem = {
  id?: string;
  title?: string;
  tempo?: string;
  key_of?: string;
  open_key?: string;
  time_sig?: string;
  artist?: { name?: string };
};

type Outcome = {
  pid: string;
  artist?: string;
  title: string;
  status:
    | "matched"
    | "no-match" // API returned candidates, none scored high enough
    | "no-result" // API explicitly returned "no result"
    | "http-error"
    | "bad-json"
    | "network-error";
  /** Which query produced the accepted match. */
  via?: "combined" | "title-only";
  cached?: boolean;
  httpStatus?: number;
  candidates?: number;
  /** Candidates seen by the title-only fallback, when it ran. */
  fallbackCandidates?: number;
  score?: number;
  matchedArtist?: string;
  matchedTitle?: string;
  tempo?: number | null;
  rawTempo?: string;
  keyOf?: string;
  openKey?: string;
  camelot?: string | null;
  camelotFromKeyOf?: string | null;
  camelotFromOpenKey?: string | null;
  ms?: number;
};

type SearchResult = {
  status: Outcome["status"];
  httpStatus?: number;
  items: SearchItem[];
};

async function search(
  artist: string | undefined,
  title: string,
  titleOnly = false
): Promise<SearchResult> {
  const wantTitle = normalizeTitle(title);
  const wantArtist = artist && !titleOnly ? normalizeArtist(artist) : "";
  const lookup = wantArtist ? `song:${wantTitle} artist:${wantArtist}` : wantTitle;
  const type = wantArtist ? "both" : "song";
  const url =
    `${API_BASE}/search/?api_key=${encodeURIComponent(API_KEY!)}` +
    `&type=${type}&lookup=${encodeURIComponent(lookup)}`;

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(25_000),
    });
  } catch {
    return { status: "network-error", items: [] };
  }
  if (!res.ok) return { status: "http-error", httpStatus: res.status, items: [] };

  let json: { search?: SearchItem[] | { error?: string } };
  try {
    json = (await res.json()) as typeof json;
  } catch {
    return { status: "bad-json", httpStatus: res.status, items: [] };
  }
  const items = Array.isArray(json.search) ? json.search : [];
  if (items.length === 0) return { status: "no-result", httpStatus: res.status, items: [] };
  return { status: "matched", httpStatus: res.status, items };
}

// ---------------------------------------------------------------- run

async function main() {
  const t0 = Date.now();
  const tracks = parseLibrary();
  const withFileBpm = tracks.filter((t) => t.source?.bpm === "file");
  const all = tracks
    .filter((t) => t.source?.bpm !== "file" && t.name)
    .sort((a, b) => (a.pid < b.pid ? -1 : a.pid > b.pid ? 1 : 0));

  // Excluded before sampling, not after, so that --n=all means "the rest of the
  // library" rather than "the rest of some earlier sample".
  const excludedPids = loadExcluded(EXCLUDE_PATHS);
  const eligible = all.filter((t) => !excludedPids.has(t.pid));

  const stats = {
    totalTracks: tracks.length,
    withFileBpm: withFileBpm.length,
    withoutArtist: tracks.filter((t) => !t.artist).length,
    eligible: eligible.length,
  };
  console.log("[library]", JSON.stringify(stats));
  if (excludedPids.size > 0) {
    const hit = all.length - eligible.length;
    console.log(
      `[exclude] ${excludedPids.size} pids, ${hit} of them in the library; ${eligible.length} left to query`
    );
    if (hit !== excludedPids.size) {
      console.log(`[exclude] ${excludedPids.size - hit} excluded pids are not in ${LIBRARY}`);
    }
  }

  const picked = sample(eligible, N, SEED);
  console.log(`[sample] ${picked.length} tracks, seed=${SEED}`);

  if (FLAG("plan")) {
    const lookups = new Set(picked.map((t) => lookupKey(t.artist, t.name))).size;
    const mins = (lookups * DELAY_MS) / 60_000;
    console.log(
      `[plan] ${picked.length} tracks, ${lookups} distinct lookups ` +
        `(${picked.length - lookups} served from cache), ~${mins.toFixed(0)} min at ${DELAY_MS}ms`
    );
    console.log(`[plan] would write ${OUT_PATH}; no request made`);
    return;
  }

  // Resume from checkpoint so a re-run does not re-spend quota.
  let done: Outcome[] = [];
  if (existsSync(OUT_PATH) && !FLAG("restart")) {
    try {
      const prev = JSON.parse(readFileSync(OUT_PATH, "utf8"));
      if (prev.seed === SEED && Array.isArray(prev.results)) {
        done = prev.results as Outcome[];
        console.log(`[resume] ${done.length} results already on disk`);
      }
    } catch {
      /* corrupt checkpoint: start over */
    }
  }
  const donePids = new Set(done.map((d) => d.pid));

  // One lookup string can serve several tracks (duplicates, re-buys). Reusing
  // the answer saves quota; `cached` marks those so they can be excluded from
  // request counts without distorting coverage.
  const cache = new Map<string, Outcome>();
  for (const d of done) if (!d.cached) cache.set(lookupKey(d.artist, d.title), d);

  let requests = 0;
  let lastCheckpoint = done.length;
  let consecutive429 = 0;
  let consecutiveErrors = 0;
  let stopped: string | null = null;

  const checkpoint = () => {
    mkdirSync(dirname(OUT_PATH), { recursive: true });
    writeFileSync(
      OUT_PATH,
      JSON.stringify(
        {
          seed: SEED,
          apiBase: API_BASE,
          library: LIBRARY,
          libraryStats: stats,
          excludedFrom: EXCLUDE_PATHS,
          excludedPids: excludedPids.size,
          sampleSize: picked.length,
          requests,
          elapsedMs: Date.now() - t0,
          stopped,
          results: done,
        },
        null,
        1
      )
    );
  };

  for (let i = 0; i < picked.length; i++) {
    const t = picked[i];
    if (donePids.has(t.pid)) continue;

    const lk = lookupKey(t.artist, t.name);
    const hit = cache.get(lk);
    if (hit) {
      done.push({ ...hit, pid: t.pid, artist: t.artist, title: t.name, cached: true });
      continue;
    }

    const started = Date.now();
    let r = await search(t.artist, t.name);
    requests++;

    if (r.status === "http-error" && r.httpStatus === 429) {
      consecutive429++;
      if (consecutive429 >= 3) {
        stopped = "rate-limited (3 consecutive 429s)";
        console.log(`[stop] ${stopped} after ${requests} requests`);
        break;
      }
      // Back off hard, then retry this track on the next pass.
      console.log(`[429] backing off 60s (${consecutive429}/3)`);
      await sleep(60_000);
      i--;
      continue;
    }
    consecutive429 = 0;

    if (r.status === "network-error" || r.status === "http-error") {
      consecutiveErrors++;
      if (consecutiveErrors >= 10) {
        stopped = `${r.status} x10 (last HTTP ${r.httpStatus ?? "-"})`;
        console.log(`[stop] ${stopped}`);
        break;
      }
    } else {
      consecutiveErrors = 0;
    }

    const out: Outcome = {
      pid: t.pid,
      artist: t.artist,
      title: t.name,
      status: r.status,
      httpStatus: r.httpStatus,
      candidates: r.items.length,
      ms: Date.now() - started,
    };

    const wantArtist = t.artist ? normalizeArtist(t.artist) : "";
    const wantTitle = normalizeTitle(t.name);
    const accept = (items: SearchItem[], via: Outcome["via"]): boolean => {
      const best = pickBest(items, (c) => c.artist?.name, (c) => c.title, wantArtist, wantTitle);
      if (!best) return false;
      const s = best.item;
      out.status = "matched";
      out.via = via;
      out.score = best.score;
      out.matchedArtist = s.artist?.name;
      out.matchedTitle = s.title;
      out.rawTempo = s.tempo;
      const bpm = s.tempo != null ? parseFloat(s.tempo) : NaN;
      out.tempo = Number.isFinite(bpm) && bpm > 0 ? bpm : null;
      out.keyOf = s.key_of;
      out.openKey = s.open_key;
      out.camelotFromKeyOf = toCamelot(s.key_of);
      out.camelotFromOpenKey = toCamelot(s.open_key);
      out.camelot = out.camelotFromOpenKey ?? out.camelotFromKeyOf;
      return true;
    };

    if (r.status === "matched" && !accept(r.items, "combined")) out.status = "no-match";

    // Opt-in (--fallback), and measured to be a bad idea: retrying on title
    // alone does raise the apparent hit rate by ~4pp, but 54 of the 59 extra
    // "matches" were wrong. A bare title is ambiguous enough that the wrong
    // song outranks nothing at all, and match.ts's cross-script rule — which
    // waives artist agreement when the two names use different alphabets —
    // then waves them through. Kept only so the finding can be reproduced.
    if (out.status !== "matched" && wantArtist && FLAG("fallback")) {
      await sleep(DELAY_MS);
      const f = await search(t.artist, t.name, true);
      requests++;
      out.fallbackCandidates = f.items.length;
      if (f.status === "matched") {
        if (!accept(f.items, "title-only")) out.status = "no-match";
      }
    }

    // Cache every settled answer, not just hits: a repeated miss is just as
    // deterministic and re-asking would burn quota for nothing.
    if (out.status === "matched" || out.status === "no-match" || out.status === "no-result") {
      cache.set(lk, out);
    }
    out.ms = Date.now() - started;
    done.push(out);

    // Counted against the last write rather than tested with `%`: cache hits
    // push without checkpointing and can step the total straight over a
    // multiple of 25, which on a long run means whole windows never saved.
    if (done.length - lastCheckpoint >= 25) {
      lastCheckpoint = done.length;
      checkpoint();
      const matched = done.filter((d) => d.status === "matched").length;
      const el = ((Date.now() - t0) / 1000).toFixed(0);
      console.log(
        `[progress] ${done.length}/${picked.length} matched=${matched} req=${requests} ${el}s`
      );
    }

    await sleep(DELAY_MS);
  }

  checkpoint();
  console.log(
    `[done] results=${done.length} requests=${requests} elapsed=${((Date.now() - t0) / 1000).toFixed(0)}s stopped=${stopped ?? "no"}`
  );
}

// ---------------------------------------------------------------- report

/** Print the coverage analysis from a finished (or in-progress) checkpoint. */
function report() {
  const d = JSON.parse(readFileSync(OUT_PATH, "utf8"));
  const rs: Outcome[] = d.results;
  const n = rs.length;
  const pct = (x: number, of = n) => `${((100 * x) / of).toFixed(1)}%`;

  const by = (s: string) => rs.filter((r) => r.status === s);
  const matched = by("matched");
  const strict = matched.filter((r) => r.via === "combined");
  const viaFallback = matched.filter((r) => r.via === "title-only");

  const withTempo = matched.filter((r) => r.tempo != null);
  const withKey = matched.filter((r) => r.camelot != null);
  const strictTempo = strict.filter((r) => r.tempo != null);
  const strictKey = strict.filter((r) => r.camelot != null);
  const bothStrict = strict.filter((r) => r.tempo != null && r.camelot != null);

  console.log(`\n=== LIBRARY ===`);
  console.log(JSON.stringify(d.libraryStats));
  console.log(`\n=== SAMPLE (n=${n}, seed=${d.seed}) ===`);
  const counts: Record<string, number> = {};
  for (const r of rs) counts[r.status] = (counts[r.status] ?? 0) + 1;
  for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(14)} ${String(v).padStart(4)}  ${pct(v)}`);
  }
  console.log(`  (of which duplicate lookups served from cache: ${rs.filter((r) => r.cached).length})`);

  console.log(`\n=== HIT RATE ===`);
  console.log(`  matched (any)          ${matched.length}  ${pct(matched.length)}`);
  console.log(`   via combined lookup   ${strict.length}  ${pct(strict.length)}`);
  console.log(`   via title-only fallb. ${viaFallback.length}  ${pct(viaFallback.length)}`);

  console.log(`\n=== USABLE VALUES (strict / combined-lookup matches only) ===`);
  console.log(`  tempo  ${strictTempo.length}/${strict.length} of matches   → ${pct(strictTempo.length)} of sample`);
  console.log(`  key    ${strictKey.length}/${strict.length} of matches   → ${pct(strictKey.length)} of sample`);
  console.log(`  both   ${bothStrict.length}/${strict.length} of matches   → ${pct(bothStrict.length)} of sample`);

  console.log(`\n=== USABLE VALUES (including title-only fallback) ===`);
  console.log(`  tempo  ${withTempo.length}  → ${pct(withTempo.length)} of sample`);
  console.log(`  key    ${withKey.length}  → ${pct(withKey.length)} of sample`);

  // Suspect: match.ts lets an exact title stand in for artist agreement when
  // the two names are in different scripts. Broad title-only searches make that
  // escape hatch fire on unrelated songs, so count how much of the hit rate
  // rests on it.
  const CJK = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/;
  const suspect = matched.filter(
    (r) =>
      r.score === 3 &&
      r.matchedArtist &&
      r.artist &&
      CJK.test(normalizeArtist(r.matchedArtist)) !== CJK.test(normalizeArtist(r.artist))
  );
  console.log(`\n=== SUSPECT MATCHES (cross-script rule, score 3) ===`);
  console.log(`  ${suspect.length} total; ${suspect.filter((s) => s.via === "title-only").length} of them via title-only fallback`);
  for (const s of suspect.slice(0, 12)) {
    console.log(`   "${s.title}" ${s.artist} → ${s.matchedArtist} (${s.via}, bpm=${s.tempo ?? "-"})`);
  }

  const tempos = withTempo.map((r) => r.tempo!).sort((a, b) => a - b);
  if (tempos.length) {
    const q = (p: number) => tempos[Math.floor(p * (tempos.length - 1))];
    console.log(`\n=== BPM DISTRIBUTION (n=${tempos.length}) ===`);
    console.log(`  min=${tempos[0]}  p25=${q(0.25)}  median=${q(0.5)}  p75=${q(0.75)}  max=${tempos[tempos.length - 1]}`);
    console.log(`  implausible (<40 or >220): ${tempos.filter((t) => t < 40 || t > 220).length}`);
    const buckets: Record<string, number> = {};
    for (const t of tempos) {
      const b = `${Math.floor(t / 20) * 20}-${Math.floor(t / 20) * 20 + 19}`;
      buckets[b] = (buckets[b] ?? 0) + 1;
    }
    for (const [b, c] of Object.entries(buckets).sort((a, b2) => parseInt(a[0]) - parseInt(b2[0]))) {
      console.log(`   ${b.padEnd(8)} ${String(c).padStart(4)} ${"#".repeat(Math.round((c / tempos.length) * 60))}`);
    }
  }

  console.log(`\n=== CAMELOT KEY DISTRIBUTION (n=${withKey.length}) ===`);
  const keyCounts: Record<string, number> = {};
  for (const r of withKey) keyCounts[r.camelot!] = (keyCounts[r.camelot!] ?? 0) + 1;
  const wheel: string[] = [];
  for (let i = 1; i <= 12; i++) for (const l of ["A", "B"]) wheel.push(`${i}${l}`);
  for (const k of wheel) {
    const c = keyCounts[k] ?? 0;
    console.log(`   ${k.padEnd(4)} ${String(c).padStart(4)} ${"#".repeat(Math.round((c / Math.max(1, withKey.length)) * 120))}`);
  }
  const unseen = wheel.filter((k) => !keyCounts[k]);
  console.log(`  distinct keys present: ${Object.keys(keyCounts).length}/24${unseen.length ? `  missing: ${unseen.join(",")}` : ""}`);

  console.log(`\n=== KEY SPELLINGS THAT FAILED toCamelot() ===`);
  const bad: Record<string, number> = {};
  for (const r of matched) {
    if (r.keyOf != null && toCamelot(r.keyOf) === null) {
      bad[JSON.stringify(r.keyOf)] = (bad[JSON.stringify(r.keyOf)] ?? 0) + 1;
    }
  }
  const badOpen: Record<string, number> = {};
  for (const r of matched) {
    if (r.openKey != null && toCamelot(r.openKey) === null) {
      badOpen[JSON.stringify(r.openKey)] = (badOpen[JSON.stringify(r.openKey)] ?? 0) + 1;
    }
  }
  console.log(`  key_of failures:   ${Object.keys(bad).length} distinct spellings`);
  for (const [k, c] of Object.entries(bad).sort((a, b2) => b2[1] - a[1])) console.log(`    ${k} x${c}`);
  console.log(`  open_key failures: ${Object.keys(badOpen).length} distinct spellings`);
  for (const [k, c] of Object.entries(badOpen).sort((a, b2) => b2[1] - a[1])) console.log(`    ${k} x${c}`);

  // Does open_key ever disagree with key_of? They should be the same key.
  const disagree = matched.filter(
    (r) => r.camelotFromKeyOf && r.camelotFromOpenKey && r.camelotFromKeyOf !== r.camelotFromOpenKey
  );
  console.log(`  open_key vs key_of disagreements: ${disagree.length}`);
  for (const r of disagree.slice(0, 8)) {
    console.log(`    "${r.title}" key_of=${r.keyOf}(${r.camelotFromKeyOf}) open_key=${r.openKey}(${r.camelotFromOpenKey})`);
  }
  const keyOfOnly = matched.filter((r) => !r.camelotFromOpenKey && r.camelotFromKeyOf).length;
  console.log(`  matches where only key_of parsed (open_key null/unparseable): ${keyOfOnly}`);
  console.log(`  matches with no key at all: ${matched.length - withKey.length}`);
  console.log(`  matches with no tempo at all: ${matched.length - withTempo.length}`);

  console.log(`\n=== COST ===`);
  const mins = d.elapsedMs / 60000;
  console.log(`  requests=${d.requests}  elapsed=${mins.toFixed(1)} min  stopped=${d.stopped ?? "no"}`);
  console.log(`  ${(d.requests / n).toFixed(2)} requests/track, ${(d.requests / Math.max(mins / 60, 1e-9)).toFixed(0)} req/hour (limit ~3000)`);
  const lib = d.libraryStats.eligible as number;
  console.log(`  extrapolated to full library (${lib} tracks): ${Math.round((d.requests / n) * lib)} requests, ${((mins / n) * lib).toFixed(0)} min`);
}

if (FLAG("report")) {
  report();
} else {
  main().catch((e) => {
    console.error("[fatal]", e);
    process.exit(1);
  });
}
