import { describe, expect, it } from "vitest";
import {
  ANALYSIS_IDLE_LABEL,
  ANALYSIS_STOP_LABEL,
  analysisLookupTargets,
  analysisNeededCount,
  analysisTargets,
  describeAnalysisNeeded,
} from "../src/dsp/analysisControl";
import type { Track } from "../src/types";

function track(pid: string, patch: Partial<Track> = {}): Track {
  return {
    pid,
    trackId: 1,
    name: pid,
    durationMs: 180_000,
    playlists: [],
    ...patch,
  };
}

describe("unified analysis control", () => {
  it("uses the requested idle and active labels", () => {
    expect(ANALYSIS_IDLE_LABEL).toBe("Analyze songs");
    expect(ANALYSIS_STOP_LABEL).toBe("Stop analysis");
  });

  it("includes tracks needed by either former workflow exactly once", () => {
    const soundOnly = track("sound", { bpm: 120, key: "8A" });
    const metadataOnly = track("metadata", { timbre: new Float32Array([1]) });
    const both = track("both");
    const complete = track("complete", {
      bpm: 124,
      key: "9A",
      timbre: new Float32Array([2]),
    });

    const targets = analysisTargets(
      [soundOnly, metadataOnly, both, complete],
      ["complete", "both", "metadata", "sound"]
    );

    expect(targets.map(({ track: value }) => value.pid)).toEqual([
      "both",
      "metadata",
      "sound",
    ]);
    expect(targets.map(({ needsSound, needsMetadata }) => [
      needsSound,
      needsMetadata,
    ])).toEqual([
      [true, true],
      [false, true],
      [true, false],
    ]);
  });

  it("ignores tracks outside the current view", () => {
    expect(analysisTargets([track("hidden")], [])).toEqual([]);
  });

  it("adds missing labels to the unified online pass without changing BPM/key rules", () => {
    const complete = track("complete", { bpm: 124, key: "8A", label: "Toolroom" });
    const noLabel = track("label", { bpm: 124, key: "8A" });
    const noMetadata = track("metadata", { label: "Night Bass" });
    expect(analysisLookupTargets([complete, noLabel, noMetadata]).map((t) => t.pid)).toEqual([
      "label",
      "metadata",
    ]);
  });

  it("counts unique songs Analyze would work on, in one sentence", () => {
    const labelled = track("labelled", { bpm: 124, key: "8A", label: "Toolroom" });
    const noLabel = track("label", { bpm: 124, key: "8A" });
    const inView = track("sound", { bpm: 120, key: "8A", label: "Anjunadeep" });
    expect(analysisNeededCount([labelled, noLabel, inView], ["sound"])).toBe(2);
    expect(describeAnalysisNeeded(0)).toBe("nothing needs analysis");
    expect(describeAnalysisNeeded(1)).toBe("1 song needs analysis");
    expect(describeAnalysisNeeded(1247)).toBe("1,247 songs need analysis");
  });
});
