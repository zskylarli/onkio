import { describe, expect, it } from "vitest";
import {
  OFF,
  externalSearchNote,
  nextExternalSearch,
  type ExternalCandidate,
} from "../src/views/externalSearch";

const hit: ExternalCandidate = { id: 1, title: "One More Time", artist: "Daft Punk" };

describe("nextExternalSearch", () => {
  it("offers Deezer even when the library already has matches", () => {
    const next = nextExternalSearch(OFF, {
      kind: "local",
      query: "one more time",
      matches: 3,
    });
    expect(next).toEqual({ kind: "offer", query: "one more time" });
  });

  it("offers Deezer when the library has nothing either", () => {
    const next = nextExternalSearch(OFF, {
      kind: "local",
      query: "gabber",
      matches: 0,
    });
    expect(next).toEqual({ kind: "offer", query: "gabber" });
  });

  it("does not offer against a blank query", () => {
    expect(
      nextExternalSearch(OFF, { kind: "local", query: "", matches: 0 })
    ).toEqual(OFF);
  });

  it("keeps an in-flight or finished answer when the same query is re-run", () => {
    const searching = nextExternalSearch(OFF, {
      kind: "requested",
      query: "one more time",
    });
    expect(
      nextExternalSearch(searching, {
        kind: "local",
        query: "one more time",
        matches: 2,
      })
    ).toEqual(searching);

    const results = nextExternalSearch(searching, {
      kind: "found",
      query: "one more time",
      candidates: [hit],
    });
    expect(
      nextExternalSearch(results, {
        kind: "local",
        query: "one more time",
        matches: 2,
      })
    ).toEqual(results);
  });

  it("starts a fresh offer when the query changes", () => {
    const offered = nextExternalSearch(OFF, {
      kind: "local",
      query: "one more time",
      matches: 1,
    });
    expect(
      nextExternalSearch(offered, { kind: "local", query: "around", matches: 1 })
    ).toEqual({ kind: "offer", query: "around" });
  });
});

describe("externalSearchNote", () => {
  it("leaves the offer silent so local hits are not contradicted", () => {
    expect(externalSearchNote({ kind: "offer", query: "one more time" })).toBe("");
  });
});
