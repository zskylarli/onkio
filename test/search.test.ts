import { describe, expect, it } from "vitest";
import { nextSearchMenuDismissed, searchTracks } from "../src/views/search";
import type { Track } from "../src/types";

let seq = 0;

function track(name: string, artist?: string): Track {
  seq++;
  return { pid: `pid-${seq}`, trackId: seq, name, durationMs: 200_000, playlists: [], artist };
}

const LIBRARY = [
  track("One More Time", "Daft Punk"),
  track("Around the World", "Daft Punk"),
  track("Time After Time", "Cyndi Lauper"),
  track("Jóga", "Björk"),
  track("Don't Stop 'Til You Get Enough", "Michael Jackson"),
  track("Levels (Extended Mix)", "Avicii"),
  track("Untitled"),
];

const names = (indices: number[]) => indices.map((i) => LIBRARY[i].name);

describe("searchTracks", () => {
  it("matches a title whatever case it is typed in", () => {
    expect(names(searchTracks(LIBRARY, "ONE more TIME").matches)).toEqual(["One More Time"]);
  });

  it("matches on the artist as well as the title", () => {
    expect(names(searchTracks(LIBRARY, "daft punk").matches)).toEqual([
      "One More Time",
      "Around the World",
    ]);
  });

  it("finds accented names typed without accents", () => {
    expect(names(searchTracks(LIBRARY, "bjork").matches)).toEqual(["Jóga"]);
    expect(names(searchTracks(LIBRARY, "joga").matches)).toEqual(["Jóga"]);
  });

  it("ignores apostrophes on either side of the comparison", () => {
    expect(names(searchTracks(LIBRARY, "dont stop").matches)).toEqual([
      "Don't Stop 'Til You Get Enough",
    ]);
  });

  it("lets the words of a query span title and artist", () => {
    expect(names(searchTracks(LIBRARY, "daft one more").matches)).toEqual(["One More Time"]);
  });

  it("keeps mix and edition suffixes searchable", () => {
    // The lookup normalizers strip these to collide two spellings of one
    // recording; searching for them is a legitimate thing to want.
    expect(names(searchTracks(LIBRARY, "extended mix").matches)).toEqual([
      "Levels (Extended Mix)",
    ]);
  });

  it("handles tracks with no artist", () => {
    expect(names(searchTracks(LIBRARY, "untitled").matches)).toEqual(["Untitled"]);
  });

  it("treats a blank or punctuation-only query as no search at all", () => {
    for (const q of ["", "   ", "''"]) {
      const r = searchTracks(LIBRARY, q);
      expect(r.matches).toEqual([]);
      expect(r.shown).toEqual([]);
    }
  });

  it("reports no matches rather than falling back to everything", () => {
    expect(searchTracks(LIBRARY, "gabber").matches).toEqual([]);
  });

  it("reports every match for the map but caps the list", () => {
    const many = Array.from({ length: 50 }, (_, i) => track(`Rush ${i}`, "Sound Support"));
    const r = searchTracks(many, "rush", 20);
    expect(r.matches).toHaveLength(50);
    expect(r.shown).toHaveLength(20);
  });

  it("ranks a title that starts with the query above one that merely contains it", () => {
    const r = searchTracks(LIBRARY, "time");
    expect(names(r.shown)[0]).toBe("Time After Time");
  });

  it("ranks a whole-phrase match above one assembled from separate words", () => {
    const lib = [
      track("Time to Get Ill", "Beastie Boys"),
      track("Ill Communication", "Gettin Busy"),
      track("Get Ill", "Time Wharp"),
    ];
    const shown = searchTracks(lib, "get ill").shown;
    expect(shown.map((i) => lib[i].name)).toEqual([
      "Get Ill",
      "Time to Get Ill",
      "Ill Communication",
    ]);
  });

  it("returns matches in library order so the map highlight is stable", () => {
    const r = searchTracks(LIBRARY, "t");
    expect([...r.matches]).toEqual([...r.matches].sort((a, b) => a - b));
  });
});

describe("search result menu state", () => {
  it("dismisses only the candidate menu when a result is selected", () => {
    expect(nextSearchMenuDismissed(false, "result-selected")).toBe(true);
  });

  it("reopens for a changed query or intentional return to the field", () => {
    expect(nextSearchMenuDismissed(true, "query-changed")).toBe(false);
    expect(nextSearchMenuDismissed(true, "search-focused")).toBe(false);
  });

  it("returns to its initial open state when search is cleared", () => {
    expect(nextSearchMenuDismissed(true, "cleared")).toBe(false);
  });
});
