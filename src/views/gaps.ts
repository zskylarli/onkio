/**
 * Gaps view (§7.3): a gap is a *pair*, not a hole. Find a cluster that sits
 * apart from everything else, pair it with the nearest cluster big enough to
 * be worth naming, and report the empty corridor between the two — "you have
 * THIS and THAT, and almost nothing in between".
 *
 * The k-means assignments the map is already coloured by do the work, so a
 * side of a gap is something the rest of the app can name (src/views/taste.ts
 * labels the same clusters) rather than an anonymous patch of coordinates.
 */

/** Where a cluster sits and how much room it takes up. */
export type ClusterStat = {
  cluster: number;
  size: number;
  /** centroid */
  x: number;
  y: number;
  /** RMS distance of members from the centroid — the cluster's own extent */
  spread: number;
};

/** One side of a gap. */
export type GapSide = ClusterStat;

export type Gap = {
  /** middle of the empty corridor, where the marker sits */
  x: number;
  y: number;
  /** the isolated cluster */
  a: GapSide;
  /** the nearest substantial cluster to it */
  b: GapSide;
  /** width of the corridor: centre distance less both extents, in embedding units */
  width: number;
  /** corridor width over the two extents combined — see ISOLATION_RATIO */
  isolation: number;
};

/** One side of a gap, as the UI describes it. */
export type Neighborhood = {
  label: string;
  genres: string[];
  artists: string[];
  decade?: number;
};

/**
 * How wide the emptiness has to be before it counts as a gap: at least three
 * fifths as wide as the two clusters flanking it put together. The test is a
 * ratio rather than a distance because the embedding has no units — UMAP
 * output is only meaningful relative to itself.
 *
 * The floor is set against what ordinary packing scores, not against taste.
 * k-means on a uniform field tiles it, and neighbouring tiles of side L sit
 * about L apart with an extent of ~0.41L each, so their corridor measures
 * ~0.22 of their combined extent. Real libraries leave an empty band above
 * that: measured over every candidate pair in the two reference collections
 * (scripts/measure-gap-isolation.ts, or __onkio.getState().gapDetail with the
 * thresholds off), one scores 0.376 and the next 0.710, and the other 0.474
 * then 0.647. Three fifths falls inside both bands, so it separates the pairs
 * worth pointing at from the pairs that are only how the map is packed, and
 * still sits nearly three times clear of an even tiling.
 *
 * That last margin holds only because a cluster is ever paired with its
 * nearest substantial neighbour. Diagonally opposite tiles of the same even
 * field measure ~0.76 and would clear this on their own; they never come up.
 */
export const ISOLATION_RATIO = 0.6;

/**
 * And how wide it has to be on the map: 6% of the layout's longer side. The
 * ratio above is scale-free, so two tight clusters a hair apart satisfy it
 * while describing nothing anyone could see or go looking for.
 *
 * 6% of a map the width of a browser window is around 80 pixels, against the
 * ~26 the marker and its connector occupy: below that the thing marking the
 * corridor is most of what is in it.
 */
export const MIN_CORRIDOR_SHARE = 0.06;

/**
 * A cluster is substantial enough to be the far side of a gap when it holds at
 * least half of an even share of the library. Without a floor, two stray
 * outliers pair with each other and produce a gap between two things the user
 * has barely got — the far side has to be somewhere they actually live.
 *
 * It stays where it is while the two thresholds above loosen: the satellites
 * are exactly what a looser setting is meant to surface, and letting them pair
 * with each other rather than with the mass would surface them as noise.
 */
export const SUBSTANTIAL_SHARE = 0.5;

export function clusterStats(
  coords: Float32Array, // n × 2
  clusters: Int32Array,
  n: number
): ClusterStat[] {
  const sums = new Map<number, { n: number; x: number; y: number }>();
  for (let i = 0; i < n; i++) {
    const c = clusters[i];
    const acc = sums.get(c);
    if (acc) {
      acc.n++;
      acc.x += coords[i * 2];
      acc.y += coords[i * 2 + 1];
    } else {
      sums.set(c, { n: 1, x: coords[i * 2], y: coords[i * 2 + 1] });
    }
  }

  const stats = new Map<number, ClusterStat>();
  for (const [c, acc] of sums) {
    stats.set(c, { cluster: c, size: acc.n, x: acc.x / acc.n, y: acc.y / acc.n, spread: 0 });
  }
  for (let i = 0; i < n; i++) {
    const s = stats.get(clusters[i])!;
    const dx = coords[i * 2] - s.x;
    const dy = coords[i * 2 + 1] - s.y;
    s.spread += dx * dx + dy * dy;
  }
  for (const s of stats.values()) s.spread = Math.sqrt(s.spread / s.size);

  return [...stats.values()].sort((a, b) => b.size - a.size);
}

function layoutSpan(coords: Float32Array, n: number): number {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = coords[i * 2];
    const y = coords[i * 2 + 1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return Math.max(maxX - minX, maxY - minY) || 1;
}

export function findGaps(
  coords: Float32Array, // n × 2
  clusters: Int32Array,
  n: number,
  maxGaps = 10
): Gap[] {
  if (n === 0) return [];
  const stats = clusterStats(coords, clusters, n);
  if (stats.length < 2) return [];

  const evenShare = n / stats.length;
  const substantial = stats.filter((c) => c.size >= evenShare * SUBSTANTIAL_SHARE);
  if (substantial.length === 0) return [];
  const minCorridor = layoutSpan(coords, n) * MIN_CORRIDOR_SHARE;

  // Keyed on the unordered pair: a small cluster and its big neighbour often
  // nominate each other, and that is one gap, not two.
  const byPair = new Map<string, Gap>();
  for (const a of stats) {
    let b: GapSide | null = null;
    let centres = Infinity;
    for (const candidate of substantial) {
      if (candidate.cluster === a.cluster) continue;
      const d = Math.hypot(candidate.x - a.x, candidate.y - a.y);
      if (d < centres) {
        centres = d;
        b = candidate;
      }
    }
    if (!b) continue;

    const extent = a.spread + b.spread;
    const width = centres - extent;
    if (width < minCorridor) continue;
    const isolation = extent > 0 ? width / extent : Infinity;
    if (isolation < ISOLATION_RATIO) continue;

    // The marker belongs in the middle of the emptiness, not midway between
    // the centroids: a wide cluster facing a tight one would otherwise put it
    // inside the wide one.
    const t = (a.spread + width / 2) / centres;
    const gap: Gap = {
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
      a,
      b,
      width,
      isolation,
    };
    const key =
      a.cluster < b.cluster ? `${a.cluster}:${b.cluster}` : `${b.cluster}:${a.cluster}`;
    const seen = byPair.get(key);
    // Both directions describe the same corridor; keep the reading whose near
    // side is the more isolated one, which is the side worth naming first.
    if (!seen || gap.isolation > seen.isolation) byPair.set(key, gap);
  }

  return [...byPair.values()]
    .sort((x, y) => y.isolation - x.isolation || y.width - x.width)
    .slice(0, maxGaps);
}

/** Genre strings carry punctuation ("Hip-Hop/Rap") that reads badly in a query. */
function cleanTerm(s: string): string {
  return s.replace(/[/|]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Turn a gap between two neighborhoods into things you could actually go
 * search for: genre blends across the hole, era-qualified variants, and an
 * artist anchor.
 */
export function suggestQueries(
  a: Neighborhood,
  b: Neighborhood,
  limit = 5
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (q: string) => {
    const t = cleanTerm(q);
    if (!t || seen.has(t.toLowerCase())) return;
    seen.add(t.toLowerCase());
    out.push(t);
  };

  const ga = a.genres.map(cleanTerm).filter(Boolean);
  const gb = b.genres.map(cleanTerm).filter(Boolean);
  const g1 = ga[0];
  const g2 = gb[0];

  if (g1 && g2 && g1.toLowerCase() !== g2.toLowerCase()) {
    // Word order changes what a search engine finds ("ambient techno" is a
    // real subgenre, "techno ambient" surfaces different things), so offer both.
    push(`${g1} ${g2}`);
    push(`${g2} ${g1}`);
    if (a.decade && b.decade) {
      push(`${Math.round((a.decade + b.decade) / 20) * 10}s ${g1} ${g2}`);
    }
    if (gb[1]) push(`${g1} ${gb[1]}`);
    if (ga[1]) push(`${ga[1]} ${g2}`);
  } else if (g1) {
    if (ga[1]) push(`${g1} ${ga[1]}`);
    push(`${g1} deep cuts`);
  }

  const aa = a.artists[0];
  const ab = b.artists[0];
  if (aa && ab && aa !== ab) push(`artists like ${aa} and ${ab}`);
  else if (aa) push(`artists like ${aa}`);

  return out.slice(0, limit);
}
