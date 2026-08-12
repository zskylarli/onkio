import { describe, expect, it } from "vitest";
import { resolveHighlight, type HighlightRequest } from "../src/views/highlight";

function search(pids: string[]): HighlightRequest {
  return {
    source: "search",
    label: `${pids.length} search matches`,
    name: "the search",
    pids,
  };
}

function suggestions(pids: string[]): HighlightRequest {
  return {
    source: "suggestions",
    label: `${pids.length} suggested next tracks`,
    name: "suggestion mode",
    pids,
  };
}

function playlist(pids: string[]): HighlightRequest {
  return {
    source: "playlist",
    label: `${pids.length} tracks in "Warmup"`,
    name: "the playlist filter",
    pids,
  };
}

describe("resolveHighlight", () => {
  it("highlights nothing when no control is asking for it", () => {
    expect(resolveHighlight([null, null, null])).toBeNull();
  });

  it("takes the first candidate in precedence order", () => {
    const active = resolveHighlight([search(["a"]), suggestions(["b"]), playlist(["c"])]);
    expect(active?.source).toBe("search");
    expect(active?.pids).toEqual(["a"]);
  });

  it("names the control it is overriding, so the loss is never silent", () => {
    const active = resolveHighlight([search(["a", "b"]), null, playlist(["c"])]);
    expect(active?.note).toBe(
      "Highlighting 2 search matches. The playlist filter is paused while the search is active."
    );
  });

  it("lists every overridden control in one sentence", () => {
    const active = resolveHighlight([search(["a"]), suggestions(["b"]), playlist(["c"])]);
    expect(active?.note).toBe(
      "Highlighting 1 search matches. Suggestion mode and the playlist filter are paused " +
        "while the search is active."
    );
  });

  it("claims nothing is paused when only one control is asking", () => {
    const active = resolveHighlight([null, null, playlist(["a", "b"])]);
    expect(active?.note).toBe('Highlighting 2 tracks in "Warmup".');
  });

  it("does not let a search with no matches dim the whole map", () => {
    // An empty winner would blank every point while the sidebar still showed
    // a playlist selected, which reads as the map having broken.
    const active = resolveHighlight([search([]), null, playlist(["c"])]);
    expect(active?.source).toBe("playlist");
    expect(active?.note).not.toContain("paused");
  });

  it("falls back to the playlist when suggestion mode has nothing to suggest", () => {
    const active = resolveHighlight([null, suggestions([]), playlist(["c"])]);
    expect(active?.source).toBe("playlist");
  });
});
