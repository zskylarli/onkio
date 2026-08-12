import { describe, expect, it } from "vitest";
import { summarizeClusters, tasteReport } from "../src/views/taste";
import type { Track } from "../src/types";

let id = 0;
function track(t: Partial<Track>): Track {
  id++;
  return {
    pid: `p${id}`,
    trackId: id,
    name: `Track ${id}`,
    durationMs: 200_000,
    playlists: [],
    ...t,
  };
}

/** `count` tracks sharing a genre, artist and playlist. */
function block(
  count: number,
  genre: string | undefined,
  artist: string,
  playlists: string[],
  tags?: string[]
): Track[] {
  return Array.from({ length: count }, () => track({ genre, artist, playlists, tags }));
}

describe("summarizeClusters labels", () => {
  it("names a cluster after its music, not the playlist it was filed in", () => {
    const tracks = [
      ...block(30, "Tech House", "Wax Motif", ["UKG ROOF"], ["www.bpmsupreme.com"]),
      ...block(30, "Pop", "Taylor Swift", ["SKYLAR 1"]),
    ];
    const clusters = Int32Array.from(tracks.map((_, i) => (i < 30 ? 0 : 1)));
    const [a, b] = summarizeClusters(tracks, clusters).sort((x, y) => x.cluster - y.cluster);

    for (const label of [a.label, b.label]) {
      expect(label).not.toMatch(/UKG ROOF|SKYLAR 1|bpmsupreme/);
    }
    expect(a.label).toContain("Tech House");
    expect(b.label).toContain("Pop");
  });

  it("still counts playlists for the rest of the summary", () => {
    const tracks = block(10, "House", "Artist A", ["Warmup"]);
    const [only] = summarizeClusters(tracks, new Int32Array(10));
    expect(only.topPlaylists).toEqual([["Warmup", 10]]);
    expect(only.topGenres).toEqual([["House", 10]]);
  });

  it("falls back to a numbered name when a cluster has no genre or artist", () => {
    const tracks = [
      ...Array.from({ length: 5 }, () => track({ playlists: ["mystery"] })),
      ...block(5, "Jazz", "Stacey Kent", []),
    ];
    const clusters = Int32Array.from(tracks.map((_, i) => (i < 5 ? 3 : 4)));
    const summaries = summarizeClusters(tracks, clusters);
    expect(summaries.find((c) => c.cluster === 3)!.label).toBe("Cluster 4");
    expect(summaries.find((c) => c.cluster === 4)!.label).toContain("Jazz");
  });

  it("does not repeat a term when a band shares its genre's name", () => {
    const tracks = block(12, "Techno", "Techno", []);
    const [only] = summarizeClusters(tracks, new Int32Array(12));
    expect(only.label).toBe("Techno");
  });

  it("qualifies clusters the labeller would otherwise name the same", () => {
    // Two halves of one Tech House region, alike down to the artist carrying
    // them, separable only by who else is in each.
    const tracks = [
      ...block(20, "Tech House", "Wax Motif", []),
      ...block(4, "Tech House", "Rossi", []),
      ...block(20, "Tech House", "Wax Motif", []),
      ...block(4, "Tech House", "Kolter", []),
      ...block(52, "Ambient", "Loscil", []),
    ];
    const clusters = Int32Array.from(
      tracks.map((_, i) => (i < 24 ? 0 : i < 48 ? 1 : 2))
    );
    const labels = summarizeClusters(tracks, clusters).map((c) => c.label);
    expect(new Set(labels).size).toBe(3);
    expect(labels).toContain("Wax Motif / Tech House · Rossi");
    expect(labels).toContain("Wax Motif / Tech House · Kolter");
  });

  it("numbers clusters that have nothing at all to tell them apart", () => {
    const tracks = [...block(10, "Pop", "Same Artist", []), ...block(10, "Pop", "Same Artist", [])];
    const clusters = Int32Array.from(tracks.map((_, i) => (i < 10 ? 2 : 5)));
    const labels = summarizeClusters(tracks, clusters).map((c) => c.label);
    expect(new Set(labels).size).toBe(2);
    expect(labels).toContain("Pop / Same Artist · Cluster 3");
    expect(labels).toContain("Pop / Same Artist · Cluster 6");
  });

  it("does not depend on the order the clusters are met in", () => {
    const build = (order: number[]) => {
      const tracks = order.flatMap((c) =>
        c === 0
          ? [...block(6, "Tech House", "Wax Motif", []), ...block(6, "Bass House", "Wax Motif", [])]
          : [
              ...block(6, "Tech House", "Chris Lorenzo", []),
              ...block(6, "Bass House", "Chris Lorenzo", []),
            ]
      );
      const clusters = Int32Array.from(order.flatMap((c) => Array(12).fill(c)));
      return new Map(summarizeClusters(tracks, clusters).map((s) => [s.cluster, s.label]));
    };
    expect([...build([1, 0])].sort()).toEqual([...build([0, 1])].sort());
  });

  it("keeps every label in a crowded set distinct", () => {
    const genres = ["House", "Tech House", "Bass House"];
    const tracks: Track[] = [];
    const assignment: number[] = [];
    for (let c = 0; c < 6; c++) {
      for (const g of genres) {
        tracks.push(...block(4, g, `Artist ${c % 2}`, []));
        assignment.push(...Array(4).fill(c));
      }
    }
    const labels = summarizeClusters(tracks, Int32Array.from(assignment)).map((c) => c.label);
    expect(labels).toHaveLength(6);
    expect(new Set(labels).size).toBe(6);
  });

  it("reaches past a genre everyone shares to say what is particular here", () => {
    const tracks = [
      ...block(40, "Pop", "Taylor Swift", []),
      ...block(40, "Pop", "Frank Ocean", []),
    ];
    const clusters = Int32Array.from(tracks.map((_, i) => (i < 40 ? 0 : 1)));
    const [a, b] = summarizeClusters(tracks, clusters).sort((x, y) => x.cluster - y.cluster);
    expect(a.label).toBe("Taylor Swift / Pop");
    expect(b.label).toBe("Frank Ocean / Pop");
  });
});

describe("tasteReport", () => {
  it("reports tag distribution independently of the labels", () => {
    const tracks = block(6, "House", "Artist A", ["Warmup"], ["Some Label"]);
    const report = tasteReport(tracks);
    expect(report.tagDistribution).toEqual([["Some Label", 6]]);
    expect(report.totalTracks).toBe(6);
  });
});
