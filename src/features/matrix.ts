import type { Playlist, Track } from "../types";
import { keyVector } from "../music/camelot";

/**
 * Feature matrix (§5). Blocks: playlist incidence (TF-IDF), genre one-hot
 * (IDF), external tags (TF-IDF), BPM (log + octave-folded), key (cyclic),
 * year, duration. Each block is RMS-scaled so none dominates the distance
 * metric (§5.2.2), then the numeric-vs-semantic slider (§5.3) reweights.
 *
 * Sparsity mitigations (§5.2): TF-IDF on the incidence matrix and artist
 * propagation (a track inherits a weak mean of its artist's other tracks'
 * playlist vector).
 */

/** The independently switchable pieces of the matrix. */
export type FeatureBlock =
  | "playlists"
  | "genre"
  | "tags"
  | "artist"
  | "bpm"
  | "key"
  | "year"
  | "duration"
  | "timbre";

export type MatrixOptions = {
  /** 0 = fully numeric (mixability map), 1 = fully semantic (taste map). */
  semanticWeight?: number;
  /** 0–1 influence of measured preview timbre, independent of the slider. */
  timbreWeight?: number;
  /** blend factor for artist propagation */
  artistBlend?: number;
  maxTagVocab?: number;
  /** Blocks left out entirely. Excluded vocabularies cost no dimensions. */
  exclude?: readonly FeatureBlock[];
  /**
   * Weight of an explicit artist one-hot block, off by default. Useful when
   * playlists are excluded: artist propagation then has nothing to propagate
   * over, and artist becomes the strongest remaining relational term.
   */
  artistWeight?: number;
  maxArtistVocab?: number;
};

export type FeatureMatrix = {
  data: Float32Array; // row-major n × d
  n: number;
  d: number;
};

function rmsScaleBlock(
  data: Float32Array,
  n: number,
  d: number,
  from: number,
  to: number,
  weight: number
): void {
  let ss = 0;
  for (let r = 0; r < n; r++)
    for (let c = from; c < to; c++) ss += data[r * d + c] ** 2;
  const rms = Math.sqrt(ss / n);
  if (rms === 0) return;
  const f = weight / rms;
  for (let r = 0; r < n; r++)
    for (let c = from; c < to; c++) data[r * d + c] *= f;
}

/**
 * Timbre needs its own scaling pass, because it is the one block that is
 * legitimately absent for much of a library — a 30s preview exists for only
 * ~60% of a DJ crate. Two consequences are handled here:
 *
 * 1. Standardization uses only the rows that have data, and missing rows are
 *    left at zero, which after standardization *is* the mean. Unanalyzed
 *    tracks therefore sit at the centre of timbre space and are positioned by
 *    their other features, rather than drifting into an "unknown" island —
 *    clustering by missingness is the classic way a partially-observed feature
 *    ruins an embedding.
 * 2. Block energy is measured over analyzed rows too. Scaling by the whole-
 *    matrix RMS would divide by coverage, so a library with three analyzed
 *    tracks would fling those three to the edge of the map.
 */
function scaleTimbreBlock(
  data: Float32Array,
  d: number,
  from: number,
  to: number,
  rows: number[],
  weight: number
): void {
  if (rows.length === 0 || weight === 0) return;

  for (let c = from; c < to; c++) {
    let sum = 0;
    for (const r of rows) sum += data[r * d + c];
    const mean = sum / rows.length;
    let ss = 0;
    for (const r of rows) ss += (data[r * d + c] - mean) ** 2;
    const std = Math.sqrt(ss / rows.length) || 1;
    for (const r of rows) data[r * d + c] = (data[r * d + c] - mean) / std;
  }

  let ss = 0;
  for (const r of rows) for (let c = from; c < to; c++) ss += data[r * d + c] ** 2;
  const rms = Math.sqrt(ss / rows.length);
  if (rms === 0) return;
  const f = weight / rms;
  for (const r of rows) for (let c = from; c < to; c++) data[r * d + c] *= f;
}

/** Case- and whitespace-insensitive artist identity, shared by the artist
 * block and by the vocabulary-overlap measurements in views/collections. */
export function artistKey(t: Track): string | undefined {
  const a = t.artist?.trim().toLowerCase();
  return a ? a : undefined;
}

export function buildFeatureMatrix(
  tracks: Track[],
  playlists: Playlist[],
  opts: MatrixOptions = {}
): FeatureMatrix {
  const semantic = opts.semanticWeight ?? 0.5;
  const timbreWeight = opts.timbreWeight ?? 0;
  const artistBlend = opts.artistBlend ?? 0.3;
  const maxTagVocab = opts.maxTagVocab ?? 200;
  const artistWeight = opts.artistWeight ?? 0;
  const maxArtistVocab = opts.maxArtistVocab ?? 200;
  const n = tracks.length;

  const off = new Set<FeatureBlock>(opts.exclude ?? []);
  const use = (b: FeatureBlock) => !off.has(b);

  // --- vocabularies ---
  const usedPlaylists = use("playlists") ? playlists : [];
  const playlistIndex = new Map<string, number>();
  usedPlaylists.forEach((p, i) => playlistIndex.set(p.name, i));
  const nPl = usedPlaylists.length;

  const genreCounts = new Map<string, number>();
  if (use("genre"))
    for (const t of tracks)
      if (t.genre) genreCounts.set(t.genre, (genreCounts.get(t.genre) ?? 0) + 1);
  const genres = [...genreCounts.keys()].sort();
  const genreIndex = new Map(genres.map((g, i) => [g, i]));
  const nGe = genres.length;

  const tagCounts = new Map<string, number>();
  if (use("tags"))
    for (const t of tracks)
      for (const tag of t.tags ?? [])
        tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
  const tags = [...tagCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxTagVocab)
    .map(([t]) => t);
  const tagIndex = new Map(tags.map((t, i) => [t, i]));
  const nTa = tags.length;

  // Artist one-hot, capped by frequency. A singleton artist column carries no
  // relational information — it only shifts one row's norm — and the Jacobi
  // eigensolver is cubic in d, so the tail is not worth its cost.
  const artistCounts = new Map<string, number>();
  if (artistWeight > 0 && use("artist"))
    for (const t of tracks) {
      const a = artistKey(t);
      if (a) artistCounts.set(a, (artistCounts.get(a) ?? 0) + 1);
    }
  const artists = [...artistCounts.entries()]
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxArtistVocab)
    .map(([a]) => a);
  const artistIndex = new Map(artists.map((a, i) => [a, i]));
  const nAr = artists.length;

  const NUMERIC = 8; // bpmLog, bpmOctave(sin,cos), key(sin,cos,minor), year, duration
  // Width comes from the data rather than an import, so a vector cached by an
  // older version of the extractor is ignored instead of corrupting the block.
  const nTi =
    timbreWeight > 0 && use("timbre")
      ? tracks.find((t) => t.timbre && t.timbre.length > 0)?.timbre!.length ?? 0
      : 0;
  const d = nPl + nGe + nTa + nAr + NUMERIC + nTi;
  const data = new Float32Array(n * d);

  // --- IDF weights ---
  const plIdf = usedPlaylists.map((p) =>
    Math.log(n / Math.max(1, p.pids.length))
  );
  const geIdf = genres.map((g) => Math.log(n / (genreCounts.get(g) ?? 1)));
  const taIdf = tags.map((t) => Math.log(n / (tagCounts.get(t) ?? 1)));
  const arIdf = artists.map((a) => Math.log(n / (artistCounts.get(a) ?? 1)));

  const OFF_PL = 0;
  const OFF_GE = nPl;
  const OFF_TA = nPl + nGe;
  const OFF_AR = OFF_TA + nTa;
  const OFF_NU = OFF_AR + nAr;
  const OFF_TI = OFF_NU + NUMERIC;

  // --- numeric stats for normalization (missing → mean, i.e. 0 after centering)
  const years: number[] = [];
  const durs: number[] = [];
  const bpmLogs: number[] = [];
  for (const t of tracks) {
    if (t.year) years.push(t.year);
    if (t.durationMs > 0) durs.push(Math.log(t.durationMs));
    if (t.bpm) bpmLogs.push(Math.log2(t.bpm));
  }
  const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const std = (a: number[], m: number) =>
    a.length > 1 ? Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length) || 1 : 1;
  const yM = mean(years), yS = std(years, yM);
  const dM = mean(durs), dS = std(durs, dM);
  const bM = mean(bpmLogs), bS = std(bpmLogs, bM);

  // --- fill rows ---
  const timbreRows: number[] = [];
  for (let r = 0; r < n; r++) {
    const t = tracks[r];
    const row = r * d;

    for (const pl of t.playlists) {
      const i = playlistIndex.get(pl);
      if (i !== undefined) data[row + OFF_PL + i] = plIdf[i];
    }
    if (t.genre) {
      const i = genreIndex.get(t.genre);
      if (i !== undefined) data[row + OFF_GE + i] = geIdf[i];
    }
    for (const tag of t.tags ?? []) {
      const i = tagIndex.get(tag);
      if (i !== undefined) data[row + OFF_TA + i] = taIdf[i];
    }
    if (nAr > 0) {
      const a = artistKey(t);
      const i = a === undefined ? undefined : artistIndex.get(a);
      if (i !== undefined) data[row + OFF_AR + i] = arIdf[i];
    }

    // numeric block
    const nu = row + OFF_NU;
    if (use("bpm") && t.bpm) {
      data[nu] = (Math.log2(t.bpm) - bM) / bS;
      // octave-folded tempo: half/double-time land in the same place (§3, v1 spec)
      const frac = Math.log2(t.bpm) % 1;
      data[nu + 1] = Math.sin(2 * Math.PI * frac);
      data[nu + 2] = Math.cos(2 * Math.PI * frac);
    }
    if (use("key") && t.key) {
      const kv = keyVector(t.key);
      if (kv) {
        data[nu + 3] = kv[0];
        data[nu + 4] = kv[1];
        data[nu + 5] = kv[2];
      }
    }
    if (use("year") && t.year) data[nu + 6] = (t.year - yM) / yS;
    if (use("duration") && t.durationMs > 0)
      data[nu + 7] = (Math.log(t.durationMs) - dM) / dS;

    if (nTi > 0 && t.timbre?.length === nTi) {
      for (let c = 0; c < nTi; c++) data[row + OFF_TI + c] = t.timbre[c];
      timbreRows.push(r);
    }
  }

  // --- artist propagation (§5.2.3) over the playlist block ---
  if (artistBlend > 0 && nPl > 0) {
    const byArtist = new Map<string, number[]>();
    tracks.forEach((t, r) => {
      if (!t.artist) return;
      let rows = byArtist.get(t.artist);
      if (!rows) byArtist.set(t.artist, (rows = []));
      rows.push(r);
    });
    const original = data.slice(); // propagate from pre-blend values
    for (const rows of byArtist.values()) {
      if (rows.length < 2) continue;
      const meanVec = new Float32Array(nPl);
      for (const r of rows)
        for (let c = 0; c < nPl; c++) meanVec[c] += original[r * d + OFF_PL + c];
      for (let c = 0; c < nPl; c++) meanVec[c] /= rows.length;
      for (const r of rows)
        for (let c = 0; c < nPl; c++) {
          const i = r * d + OFF_PL + c;
          data[i] = (1 - artistBlend) * original[i] + artistBlend * meanVec[c];
        }
    }
  }

  // --- per-block scaling + slider (§5.2.2, §5.3) ---
  // Semantic side: playlists carry the structure; genre is low-information
  // (§0) and gets half weight; tags are the only block with outside knowledge
  // (§5.2.4) and get full weight when present.
  const wSem = 2 * semantic;
  const wNum = 2 * (1 - semantic);
  rmsScaleBlock(data, n, d, OFF_PL, OFF_PL + nPl, 1.0 * wSem);
  rmsScaleBlock(data, n, d, OFF_GE, OFF_GE + nGe, 0.5 * wSem);
  rmsScaleBlock(data, n, d, OFF_TA, OFF_TA + nTa, 1.0 * wSem);
  rmsScaleBlock(data, n, d, OFF_AR, OFF_AR + nAr, artistWeight * wSem);
  rmsScaleBlock(data, n, d, OFF_NU, OFF_NU + NUMERIC, 1.0 * wNum);
  // Measured sound sits outside the taste/mixability trade-off: it is the one
  // block that isn't derived from how the user filed the track, so it gets its
  // own weight rather than competing for the slider's budget.
  if (nTi > 0) {
    scaleTimbreBlock(data, d, OFF_TI, OFF_TI + nTi, timbreRows, 2 * timbreWeight);
  }

  return { data, n, d };
}
