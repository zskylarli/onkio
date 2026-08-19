import { describe, expect, it } from "vitest";
import { beatportSearchUrl } from "../src/views/beatport";

describe("beatportSearchUrl", () => {
  it("searches artist and title together", () => {
    expect(beatportSearchUrl("Four Tet", "Baby")).toBe(
      "https://www.beatport.com/search?q=Four%20Tet%20Baby"
    );
  });

  it("falls back to the title when the artist is missing", () => {
    expect(beatportSearchUrl(undefined, "Nights")).toBe(
      "https://www.beatport.com/search?q=Nights"
    );
  });
});
