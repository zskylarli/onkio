import { describe, expect, it } from "vitest";
import {
  toCamelot,
  keyVector,
  keyCompatibility,
  isCompatible,
  camelotFromPitchClass,
  camelotDisplay,
} from "../src/music/camelot";

describe("toCamelot", () => {
  it("passes through Camelot notation", () => {
    expect(toCamelot("8A")).toBe("8A");
    expect(toCamelot("08B")).toBe("8B");
    expect(toCamelot("12a")).toBe("12A");
  });

  it("converts Open Key notation", () => {
    expect(toCamelot("1m")).toBe("8A"); // Am
    expect(toCamelot("1d")).toBe("8B"); // C
    expect(toCamelot("6m")).toBe("1A");
  });

  it("converts classical notation", () => {
    expect(toCamelot("Am")).toBe("8A");
    expect(toCamelot("C")).toBe("8B");
    expect(toCamelot("F#maj")).toBe("2B");
    expect(toCamelot("Ebm")).toBe("2A");
    expect(toCamelot("A minor")).toBe("8A");
    expect(toCamelot("F♯ major")).toBe("2B");
    expect(toCamelot("Bb min")).toBe("3A");
  });

  it("returns null for garbage rather than guessing", () => {
    expect(toCamelot("H#")).toBeNull();
    expect(toCamelot("13A")).toBeNull();
    expect(toCamelot("")).toBeNull();
    expect(toCamelot("wobbly")).toBeNull();
  });
});

describe("wheel geometry", () => {
  it("maps the full major wheel correctly", () => {
    const expected: Record<number, string> = {
      0: "8B", 7: "9B", 2: "10B", 9: "11B", 4: "12B", 11: "1B",
      6: "2B", 1: "3B", 8: "4B", 3: "5B", 10: "6B", 5: "7B",
    };
    for (const [pc, cam] of Object.entries(expected)) {
      expect(camelotFromPitchClass(Number(pc), false)).toBe(cam);
    }
  });

  it("relative minor shares the number (Am=8A / C=8B)", () => {
    expect(camelotFromPitchClass(9, true)).toBe("8A");
    expect(camelotFromPitchClass(0, false)).toBe("8B");
  });

  it("encodes 12A and 1A as adjacent, not maximally distant (§5.1)", () => {
    const v12 = keyVector("12A")!;
    const v1 = keyVector("1A")!;
    const v6 = keyVector("6A")!;
    const d = (a: number[], b: number[]) =>
      Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    expect(d(v12, v1)).toBeLessThan(0.6);
    expect(d(v12, v6)).toBeGreaterThan(1.5);
  });
});

describe("keyCompatibility", () => {
  it("classifies transitions per Camelot rules (§7.1)", () => {
    expect(keyCompatibility("8A", "8A")).toBe("same");
    expect(keyCompatibility("8A", "8B")).toBe("relative");
    expect(keyCompatibility("8A", "9A")).toBe("adjacent");
    expect(keyCompatibility("12A", "1A")).toBe("adjacent"); // wraps
    expect(keyCompatibility("8A", "9B")).toBe("near");
    expect(keyCompatibility("8A", "3B")).toBe("clash");
  });

  it("isCompatible allows same/adjacent/relative only", () => {
    expect(isCompatible("8A", "8B")).toBe(true);
    expect(isCompatible("1A", "12A")).toBe(true);
    expect(isCompatible("8A", "2A")).toBe(false);
  });
});

describe("camelotDisplay", () => {
  it("adds the classical name", () => {
    expect(camelotDisplay("8A")).toBe("8A (Am)");
    expect(camelotDisplay("8B")).toBe("8B (C)");
  });
});
