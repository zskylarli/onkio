import { describe, expect, it } from "vitest";
import {
  canonicalLabel,
  labelFromItunesCopyright,
  labelKey,
} from "../src/enrich/label";

describe("record-label canonicalization", () => {
  it("prefers the imprint at the end of a corporate chain", () => {
    expect(canonicalLabel("Warner Music Group, Atlantic Records")).toBe("Atlantic Records");
  });

  it("drops pools, distributors and placeholders", () => {
    for (const raw of [
      "www.bpmsupreme.com",
      "DJ City",
      "DistroKid",
      "The Orchard",
      "Independent Label",
      "[no label]",
    ]) {
      expect(canonicalLabel(raw)).toBeUndefined();
    }
  });

  it("keeps display names while folding vocabulary suffixes", () => {
    expect(labelKey(canonicalLabel("Confession Records"))).toBe(
      labelKey(canonicalLabel("Confession"))
    );
    expect(canonicalLabel("Ultra Records, LLC")).toBe("Ultra Records");
    expect(labelKey("Night & Day Recordings")).toBe("night and day");
  });

  it("drops artist-owned components but keeps another imprint", () => {
    expect(canonicalLabel("Taylor Swift", "Taylor Swift")).toBeUndefined();
    expect(canonicalLabel("KAYTRANADA/RCA Records", "KAYTRANADA")).toBe("RCA Records");
  });

  it("stably extracts parenthesized compound labels", () => {
    const display = canonicalLabel("IN / ROTATION (Insomniac Records)");
    expect(display).toBe("Insomniac Records");
    expect(labelKey(display)).toBe("insomniac");
  });

  it("parses iTunes copyright only from data already supplied", () => {
    expect(labelFromItunesCopyright("℗ 2020 Toolroom Productions Ltd.")).toBe(
      "Toolroom Productions"
    );
    expect(labelFromItunesCopyright(undefined)).toBeUndefined();
  });
});
