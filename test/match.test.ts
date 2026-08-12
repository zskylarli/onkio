import { describe, expect, it } from "vitest";
import { MIN_SCORE, pickBest, scoreMatch } from "../src/enrich/match";
import { normalizeArtist, normalizeTitle } from "../src/enrich/normalize";

/**
 * These guard the thing that replaced Deezer's field-syntax query: since the
 * API can no longer be asked to constrain a match, wrong results have to be
 * rejected here or they become confidently wrong BPM.
 */

const want = (artist: string, title: string) =>
  [normalizeArtist(artist), normalizeTitle(title)] as const;

describe("scoreMatch", () => {
  it("scores an exact artist + title pair at full marks", () => {
    const [a, t] = want("Daft Punk", "Around the World");
    expect(scoreMatch("Daft Punk", "Around the World", a, t)).toBe(4);
  });

  it("still matches through remaster and feature suffixes", () => {
    const [a, t] = want("Fleetwood Mac", "Dreams");
    expect(
      scoreMatch("Fleetwood Mac", "Dreams (2004 Remaster)", a, t)
    ).toBeGreaterThanOrEqual(MIN_SCORE);
  });

  it("accepts a wider credit for the same artist", () => {
    const [a, t] = want("Kenshi Yonezu", "Lemon");
    expect(scoreMatch("Kenshi Yonezu & Friends", "Lemon", a, t)).toBeGreaterThanOrEqual(
      MIN_SCORE
    );
  });

  it("accepts a romanized credit across scripts on an exact title", () => {
    const [a, t] = want("米津玄師", "Lemon");
    expect(scoreMatch("Kenshi Yonezu", "Lemon", a, t)).toBeGreaterThanOrEqual(MIN_SCORE);
  });

  it("rejects a cross-script candidate when the title only roughly matches", () => {
    const [a, t] = want("米津玄師", "Lemonade Stand");
    expect(scoreMatch("Kenshi Yonezu", "Lemonade Stories", a, t)).toBe(0);
  });

  it("accepts a credit that differs only by a leading article", () => {
    const [a, t] = want("The Chemical Brothers", "Galvanize");
    expect(scoreMatch("Chemical Brothers", "Galvanize", a, t)).toBeGreaterThanOrEqual(
      MIN_SCORE
    );
  });

  // Six wrong matches in the 1000-track GetSongBPM trial were all of this
  // shape: a short normalized artist buried mid-word in an unrelated name.
  it("rejects a short artist that only lands inside a longer word", () => {
    const [a, t] = want("Eli & Fur", "Into The Night");
    expect(scoreMatch("José Feliciano", "Into The Night", a, t)).toBe(0);
  });

  it("rejects an initialism that only lands inside a longer word", () => {
    const [a, t] = want("KSI", "Holiday");
    expect(scoreMatch("Quicksilver Messenger Service", "Holiday", a, t)).toBe(0);
  });

  it("rejects a two-letter artist against an unrelated name", () => {
    const [a, t] = want("Me & George & KATYA", "Grateful");
    expect(scoreMatch("The Gentlemen", "Grateful", a, t)).toBe(0);
  });

  it("rejects an artist that is only a stem of the candidate", () => {
    const [a, t] = want("Astre", "Freedom (Jesse Jacob Remix)");
    expect(scoreMatch("Astreiness", "Freedom Dance", a, t)).toBe(0);
  });

  it("rejects a different song by the same artist", () => {
    const [a, t] = want("Daft Punk", "Around the World");
    expect(scoreMatch("Daft Punk", "Da Funk", a, t)).toBe(0);
  });

  it("rejects a same-titled song by someone else", () => {
    const [a, t] = want("Fleetwood Mac", "Dreams");
    expect(scoreMatch("The Cranberries", "Dreams", a, t)).toBe(0);
  });

  it("accepts on title alone when the library has no artist", () => {
    expect(scoreMatch("The Cranberries", "Dreams", "", normalizeTitle("Dreams"))).toBe(2);
  });

  it("handles missing candidate fields without throwing", () => {
    const [a, t] = want("Someone", "Something");
    expect(scoreMatch(undefined, undefined, a, t)).toBe(0);
  });
});

describe("pickBest", () => {
  type R = { artist: string; title: string; id: number };
  const results: R[] = [
    { artist: "Tribute Band", title: "Around the World", id: 1 },
    { artist: "Daft Punk", title: "Around the World", id: 2 },
    { artist: "Daft Punk", title: "Da Funk", id: 3 },
  ];
  const pick = (a: string, t: string) => {
    const [na, nt] = want(a, t);
    return pickBest(results, (r) => r.artist, (r) => r.title, na, nt);
  };

  it("prefers the best candidate over the first one returned", () => {
    expect(pick("Daft Punk", "Around the World")?.item.id).toBe(2);
  });

  it("returns null when nothing clears the threshold", () => {
    const [a, t] = want("Miles Davis", "So What");
    expect(pickBest(results, (r) => r.artist, (r) => r.title, a, t)).toBeNull();
  });

  it("returns null on an empty result set", () => {
    const [a, t] = want("Anyone", "Anything");
    expect(pickBest([], () => undefined, () => undefined, a, t)).toBeNull();
  });
});
