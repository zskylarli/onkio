import { describe, expect, it } from "vitest";
import {
  clusterStats,
  findGaps,
  ISOLATION_RATIO,
  suggestQueries,
  type Neighborhood,
} from "../src/views/gaps";

/** Deterministic jitter, so a blob is a blob and not an accident of Math.random. */
function makeRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

type Blob = { x: number; y: number; r: number; n: number };

/** Lay out round clusters, returning the coordinates and their assignments. */
function scatter(blobs: Blob[], seed = 7): { coords: Float32Array; clusters: Int32Array; n: number } {
  const rand = makeRandom(seed);
  const n = blobs.reduce((s, b) => s + b.n, 0);
  const coords = new Float32Array(n * 2);
  const clusters = new Int32Array(n);
  let i = 0;
  blobs.forEach((b, c) => {
    for (let k = 0; k < b.n; k++, i++) {
      const angle = rand() * Math.PI * 2;
      const radius = Math.sqrt(rand()) * b.r;
      coords[i * 2] = b.x + Math.cos(angle) * radius;
      coords[i * 2 + 1] = b.y + Math.sin(angle) * radius;
      clusters[i] = c;
    }
  });
  return { coords, clusters, n };
}

describe("clusterStats", () => {
  it("measures where each cluster sits and how much room it takes up", () => {
    const { coords, clusters, n } = scatter([
      { x: 0, y: 0, r: 1, n: 200 },
      { x: 40, y: 0, r: 2, n: 100 },
    ]);
    const stats = clusterStats(coords, clusters, n);
    // biggest first
    expect(stats.map((s) => s.size)).toEqual([200, 100]);
    expect(stats[0].x).toBeCloseTo(0, 0);
    expect(stats[1].x).toBeCloseTo(40, 0);
    // RMS radius of a uniform disc of radius r is r/√2
    expect(stats[0].spread).toBeGreaterThan(0.5);
    expect(stats[0].spread).toBeLessThan(1);
    expect(stats[1].spread).toBeGreaterThan(stats[0].spread);
  });
});

describe("findGaps", () => {
  it("pairs an isolated cluster with the big one nearest to it (§7.3)", () => {
    // Two main clusters close enough to read as one region, and a satellite
    // far off to one side.
    const { coords, clusters, n } = scatter([
      { x: 0, y: 0, r: 3, n: 300 },
      { x: 6, y: 0, r: 3, n: 300 },
      { x: 60, y: 0, r: 1, n: 20 },
    ]);
    const gaps = findGaps(coords, clusters, n);
    expect(gaps).toHaveLength(1);
    const [g] = gaps;
    expect(new Set([g.a.cluster, g.b.cluster])).toEqual(new Set([1, 2]));
    // The satellite is the isolated side, so it is named first.
    expect(g.a.cluster).toBe(2);
    // The marker sits in the emptiness, not on either cluster.
    expect(g.x).toBeGreaterThan(15);
    expect(g.x).toBeLessThan(55);
    expect(Math.abs(g.y)).toBeLessThan(3);
    expect(g.isolation).toBeGreaterThan(1);
    expect(g.width).toBeGreaterThan(40);
  });

  it("never pairs two outliers with each other", () => {
    // Two specks side by side, a long way from the only real cluster. Pairing
    // them together would report a gap between two things barely owned.
    const { coords, clusters, n } = scatter([
      { x: 0, y: 0, r: 4, n: 400 },
      { x: 80, y: 0, r: 0.5, n: 4 },
      { x: 88, y: 0, r: 0.5, n: 4 },
    ]);
    const gaps = findGaps(coords, clusters, n);
    expect(gaps.length).toBeGreaterThan(0);
    for (const g of gaps) {
      // Every gap has to reach the main cluster; 1 and 2 may never meet.
      expect([g.a.cluster, g.b.cluster]).toContain(0);
    }
    expect(gaps.every((g) => g.b.cluster === 0)).toBe(true);
  });

  it("reports nothing on an evenly filled map", () => {
    // k-means tiles a uniform field, and tiles are not isolated from each
    // other: neighbouring cells sit about as far apart as they are wide.
    const rand = makeRandom(99);
    const n = 2000;
    const coords = new Float32Array(n * 2);
    const clusters = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const x = rand() * 40;
      const y = rand() * 40;
      coords[i * 2] = x;
      coords[i * 2 + 1] = y;
      clusters[i] = (x < 20 ? 0 : 1) + (y < 20 ? 0 : 2);
    }
    expect(findGaps(coords, clusters, n)).toEqual([]);

    // Not by a hair: the threshold has to stay clear of what plain tiling
    // scores, or every loosening of it turns the packing itself into findings.
    // Measured the way findGaps pairs, on each cluster's nearest neighbour —
    // across a tiling that is what keeps the diagonals, which score far
    // higher, from ever being offered as candidates.
    const stats = clusterStats(coords, clusters, n);
    let worst = 0;
    for (const a of stats) {
      let nearest = null;
      let centres = Infinity;
      for (const b of stats) {
        if (b.cluster === a.cluster) continue;
        const d = Math.hypot(b.x - a.x, b.y - a.y);
        if (d < centres) { centres = d; nearest = b; }
      }
      const extent = a.spread + nearest!.spread;
      worst = Math.max(worst, (centres - extent) / extent);
    }
    expect(worst).toBeLessThan(0.3);
    expect(worst).toBeLessThan(ISOLATION_RATIO / 2);
  });

  it("surfaces a marginal corridor, but not one the map could just be packed that way", () => {
    // A satellite placed to sit a little over seven tenths of the combined
    // extent away from the mass, which is the loosest reading that still says
    // there is a corridor there at all.
    const marginal = scatter([
      { x: 0, y: 0, r: 5, n: 400 },
      { x: 9, y: 0, r: 2, n: 100 },
    ]);
    const found = findGaps(marginal.coords, marginal.clusters, marginal.n);
    expect(found).toHaveLength(1);
    expect(found[0].isolation).toBeGreaterThan(ISOLATION_RATIO);
    expect(found[0].isolation).toBeLessThan(1);

    // The same pair pulled in until the corridor is half their extent: normal
    // spacing, and nothing to report.
    const tight = scatter([
      { x: 0, y: 0, r: 5, n: 400 },
      { x: 7.4, y: 0, r: 2, n: 100 },
    ]);
    expect(findGaps(tight.coords, tight.clusters, tight.n)).toEqual([]);
  });

  it("ignores emptiness too small to point at", () => {
    // Well separated relative to their own size, but the whole pair is a
    // rounding error next to the map it sits in.
    const { coords, clusters, n } = scatter([
      { x: 0, y: 0, r: 20, n: 500 },
      { x: 100, y: 0, r: 0.2, n: 10 },
      { x: 101, y: 0, r: 0.2, n: 10 },
    ]);
    const gaps = findGaps(coords, clusters, n);
    expect(gaps.some((g) => g.a.cluster === 1 && g.b.cluster === 2)).toBe(false);
    expect(gaps.some((g) => g.a.cluster === 2 && g.b.cluster === 1)).toBe(false);
  });

  it("has nothing to say about a single cluster, or about nothing at all", () => {
    const { coords, clusters, n } = scatter([{ x: 0, y: 0, r: 5, n: 100 }]);
    expect(findGaps(coords, clusters, n)).toEqual([]);
    expect(findGaps(new Float32Array(0), new Int32Array(0), 0)).toEqual([]);
    expect(findGaps(new Float32Array([1, 1]), new Int32Array([0]), 1)).toEqual([]);
  });

  it("returns each pair once, most isolated first, capped", () => {
    const { coords, clusters, n } = scatter([
      { x: 0, y: 0, r: 3, n: 300 },
      { x: 70, y: 0, r: 1, n: 30 },
      { x: 0, y: 200, r: 1, n: 30 },
    ]);
    const gaps = findGaps(coords, clusters, n, 1);
    expect(gaps).toHaveLength(1);
    // The far satellite is the more isolated of the two.
    expect(gaps[0].a.cluster).toBe(2);

    const all = findGaps(coords, clusters, n);
    expect(all).toHaveLength(2);
    expect(all[0].isolation).toBeGreaterThanOrEqual(all[1].isolation);
    const keys = all.map((g) => [g.a.cluster, g.b.cluster].sort().join(":"));
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("suggestQueries", () => {
  const house: Neighborhood = {
    label: "house / peak",
    genres: ["House", "Tech House"],
    artists: ["Artist A", "Artist B"],
    decade: 2010,
  };
  const ambient: Neighborhood = {
    label: "ambient",
    genres: ["Ambient", "Downtempo"],
    artists: ["Artist C"],
    decade: 1990,
  };

  it("blends the two sides' genres in both word orders", () => {
    const q = suggestQueries(house, ambient);
    expect(q).toContain("House Ambient");
    expect(q).toContain("Ambient House");
  });

  it("adds an era-qualified variant when both sides have one", () => {
    expect(suggestQueries(house, ambient)).toContain("2000s House Ambient");
  });

  it("anchors on artists from each side", () => {
    const q = suggestQueries(house, ambient, 10);
    expect(q).toContain("artists like Artist A and Artist C");
  });

  it("strips punctuation that reads badly in a search box", () => {
    const rap: Neighborhood = { label: "rap", genres: ["Hip-Hop/Rap"], artists: [] };
    const jazz: Neighborhood = { label: "jazz", genres: ["Jazz"], artists: [] };
    expect(suggestQueries(rap, jazz)).toContain("Hip-Hop Rap Jazz");
  });

  it("never repeats a suggestion and honors the limit", () => {
    const q = suggestQueries(house, ambient, 3);
    expect(q).toHaveLength(3);
    expect(new Set(q).size).toBe(3);
  });

  it("degrades gracefully when both sides are the same genre", () => {
    const q = suggestQueries(house, house);
    expect(q.length).toBeGreaterThan(0);
    expect(q.every((s) => s.length > 0)).toBe(true);
  });
});
