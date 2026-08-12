import { describe, expect, it } from "vitest";
import {
  bpmDeltaPct,
  evaluateTransition,
  moveItem,
  orderForSet,
  suggestNext,
  toM3U8,
  toTextTracklist,
} from "../src/views/setBuilder";
import type { Track } from "../src/types";

function t(pid: string, over: Partial<Track> = {}): Track {
  return {
    pid,
    trackId: 0,
    name: `Track ${pid}`,
    artist: `Artist ${pid}`,
    durationMs: 200000,
    playlists: [],
    ...over,
  };
}

describe("bpmDeltaPct", () => {
  it("compares in the closest octave (70 vs 140 is mixable)", () => {
    expect(bpmDeltaPct(140, 70)).toBe(0);
    expect(bpmDeltaPct(126, 128)).toBeCloseTo(1.6, 0);
    expect(bpmDeltaPct(120, 140)).toBeGreaterThan(6);
  });
});

describe("evaluateTransition", () => {
  it("passes a clean Camelot-adjacent, tempo-matched transition", () => {
    const tr = evaluateTransition(
      t("a", { bpm: 126, key: "8A" }),
      t("b", { bpm: 128, key: "9A" })
    );
    expect(tr.warnings).toHaveLength(0);
    expect(tr.score).toBeGreaterThan(0.9);
  });

  it("warns on key clash and BPM jump but never blocks", () => {
    const tr = evaluateTransition(
      t("a", { bpm: 126, key: "8A" }),
      t("b", { bpm: 150, key: "3B" })
    );
    const kinds = tr.warnings.map((w) => w.kind);
    expect(kinds).toContain("key");
    expect(kinds).toContain("bpm");
    expect(tr.score).toBeGreaterThan(0); // warning, not a hard block (§7.1)
  });

  it("treats relative-key moves as safe (§4 near-miss doctrine)", () => {
    const tr = evaluateTransition(
      t("a", { bpm: 126, key: "8A" }),
      t("b", { bpm: 126, key: "8B" })
    );
    expect(tr.warnings).toHaveLength(0);
  });

  it("flags unknown data and discounts confidence", () => {
    const tr = evaluateTransition(t("a", { bpm: 126, key: "8A" }), t("b"));
    expect(tr.warnings.map((w) => w.kind)).toEqual(
      expect.arrayContaining(["key-unknown", "bpm-unknown"])
    );
    // low-confidence derived values reduce the score
    const lowConf = evaluateTransition(
      t("a", { bpm: 126, key: "8A", confidence: { bpm: 0.2, key: 0.2 } }),
      t("b", { bpm: 128, key: "9A", confidence: { bpm: 0.2, key: 0.2 } })
    );
    expect(lowConf.score).toBeLessThan(tr.score + 0.5);
  });
});

describe("suggestNext", () => {
  it("returns only key-compatible, tempo-close tracks, best first", () => {
    const current = t("cur", { bpm: 126, key: "8A" });
    const pool = [
      t("good1", { bpm: 127, key: "8B" }),
      t("good2", { bpm: 124, key: "9A" }),
      t("clash", { bpm: 126, key: "2B" }),
      t("fast", { bpm: 160, key: "8A" }),
      t("nodata"),
    ];
    const s = suggestNext(current, pool);
    const pids = s.map((x) => x.to.pid);
    expect(pids).toContain("good1");
    expect(pids).toContain("good2");
    expect(pids).not.toContain("clash");
    expect(pids).not.toContain("fast");
    expect(pids).not.toContain("nodata");
    expect(pids).not.toContain("cur");
  });
});

describe("moveItem", () => {
  const list = ["a", "b", "c", "d"];

  it("counts the destination in the finished list, not the original", () => {
    // Dragging the first row to the end means it ends up last, whatever index
    // the rows below it held before it was lifted out.
    expect(moveItem(list, 0, 3)).toEqual(["b", "c", "d", "a"]);
    expect(moveItem(list, 3, 0)).toEqual(["d", "a", "b", "c"]);
    expect(moveItem(list, 1, 2)).toEqual(["a", "c", "b", "d"]);
  });

  it("leaves the list alone when nothing moves", () => {
    expect(moveItem(list, 2, 2)).toEqual(list);
    expect(moveItem(list, 9, 0)).toEqual(list);
    expect(moveItem(list, -1, 0)).toEqual(list);
  });

  it("clamps a destination past either end", () => {
    expect(moveItem(list, 0, 99)).toEqual(["b", "c", "d", "a"]);
    expect(moveItem(list, 3, -5)).toEqual(["d", "a", "b", "c"]);
  });

  it("copies rather than reordering in place", () => {
    const original = [...list];
    moveItem(list, 0, 2);
    expect(list).toEqual(original);
  });
});

describe("orderForSet", () => {
  it("ramps a lassoed region from slowest to fastest", () => {
    const ordered = orderForSet([
      t("fast", { bpm: 132 }),
      t("slow", { bpm: 118 }),
      t("mid", { bpm: 126 }),
    ]);
    expect(ordered.map((x) => x.pid)).toEqual(["slow", "mid", "fast"]);
  });

  it("puts tracks with no tempo last, not first", () => {
    // A missing BPM read as zero would open every set with the tracks nothing is
    // known about, which is the opposite of useful.
    const ordered = orderForSet([t("unknown"), t("slow", { bpm: 118 })]);
    expect(ordered.map((x) => x.pid)).toEqual(["slow", "unknown"]);
  });

  it("holds the incoming order within one tempo", () => {
    const ordered = orderForSet([
      t("second", { bpm: 128 }),
      t("first", { bpm: 124 }),
      t("third", { bpm: 128 }),
      t("nobpm-a"),
      t("nobpm-b"),
    ]);
    expect(ordered.map((x) => x.pid)).toEqual([
      "first",
      "second",
      "third",
      "nobpm-a",
      "nobpm-b",
    ]);
  });

  it("does not disturb what it was given", () => {
    const input = [t("b", { bpm: 130 }), t("a", { bpm: 120 })];
    orderForSet(input);
    expect(input.map((x) => x.pid)).toEqual(["b", "a"]);
  });
});

describe("exports", () => {
  const set = [
    t("a", { bpm: 126, key: "8A", durationMs: 187000 }),
    t("b", { bpm: 128, key: "9A" }),
  ];

  it("emits valid M3U8", () => {
    const m3u = toM3U8(set, "Test Set");
    expect(m3u.startsWith("#EXTM3U\n")).toBe(true);
    expect(m3u).toContain("#PLAYLIST:Test Set");
    expect(m3u).toContain("#EXTINF:187,Artist a - Track a");
  });

  it("uses Location when present (local-crate compatibility)", () => {
    const m3u = toM3U8([t("c", { location: "file:///x/y.mp3" })]);
    expect(m3u).toContain("file:///x/y.mp3");
  });

  it("falls back to the title when the location is only a stand-in", () => {
    // A pathless export is pinned to a synthetic path for identity's sake.
    // Writing that into a playlist hands a player a file that never existed.
    const m3u = toM3U8([t("d", { location: "/Onkio/no-local-file/C5D490057BA1DC92" })]);
    expect(m3u).not.toContain("no-local-file");
    expect(m3u).toContain("Artist d - Track d\n");
  });

  it("emits a readable text tracklist with key/BPM", () => {
    const txt = toTextTracklist(set);
    expect(txt).toContain("01. Artist a - Track a [8A, 126 BPM]");
  });
});
