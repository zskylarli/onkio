import { describe, expect, it } from "vitest";
import {
  normalizeTitle,
  normalizeArtist,
  lookupKey,
} from "../src/enrich/normalize";

describe("normalizeTitle", () => {
  it("strips edition suffixes in brackets", () => {
    expect(normalizeTitle("One More Time (Extended Mix)")).toBe("one more time");
    expect(normalizeTitle("Blue Monday [Remastered 2019]")).toBe("blue monday");
    expect(normalizeTitle("Levels - Radio Edit")).toBe("levels");
  });

  it("keeps bracketed groups that are part of the name", () => {
    expect(normalizeTitle("(I Can't Get No) Satisfaction")).toContain("satisfaction");
  });

  it("collapses feat./ft./featuring", () => {
    expect(normalizeTitle("Titanium feat. Sia")).toBe("titanium");
    expect(normalizeTitle("Titanium ft Sia")).toBe("titanium");
    expect(normalizeTitle("Titanium (feat. Sia)")).toBe("titanium");
  });

  it("strips diacritics but preserves CJK (§3.2)", () => {
    expect(normalizeTitle("Éclair")).toBe("eclair");
    expect(normalizeTitle("想家")).toBe("想家");
    expect(normalizeTitle("夜に駆ける")).toBe("夜に駆ける");
  });

  it("never returns empty for suffix-only-looking titles", () => {
    expect(normalizeTitle("Remix")).not.toBe("");
  });
});

describe("normalizeArtist", () => {
  it("keeps the primary artist from collab strings", () => {
    expect(normalizeArtist("Calvin Harris & Disciples")).toBe("calvin harris");
    expect(normalizeArtist("A, B, C")).toBe("a");
    expect(normalizeArtist("Skrillex x Boys Noize")).toBe("skrillex");
  });

  it("preserves CJK artist names", () => {
    expect(normalizeArtist("周杰倫")).toBe("周杰倫");
  });
});

describe("lookupKey", () => {
  it("is stable across display variants of the same recording", () => {
    const a = lookupKey("Dave Gahan", "Kingdom (Radio Edit)");
    const b = lookupKey("dave gahan", "Kingdom");
    expect(a).toBe(b);
  });

  it("handles missing artist", () => {
    expect(lookupKey(undefined, "Song")).toBe("|song");
  });
});
