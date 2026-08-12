import { beforeEach, describe, expect, it, vi } from "vitest";

const jsonp = vi.hoisted(() => vi.fn<(url: string) => Promise<unknown>>());
vi.mock("../src/enrich/sources/jsonp", () => ({ jsonp }));
vi.mock("../src/enrich/sources/limiter", () => ({
  RateLimiter: class {
    acquire(): Promise<void> {
      return Promise.resolve();
    }
  },
}));

const { lookupItunes } = await import("../src/enrich/sources/itunes");

beforeEach(() => jsonp.mockReset());

describe("opportunistic iTunes labels", () => {
  it("uses copyright when the response already carries it without an album call", async () => {
    jsonp.mockResolvedValue({
      resultCount: 1,
      results: [
        {
          trackName: "Glue",
          artistName: "Bicep",
          previewUrl: "https://example.test/glue.m4a",
          copyright: "℗ 2017 Ninja Tune",
        },
      ],
    });
    const result = await lookupItunes("Bicep", "Glue");
    expect(result?.label).toBe("Ninja Tune");
    expect(result?.labelSource).toBe("itunes");
    expect(jsonp).toHaveBeenCalledTimes(1);
    expect(jsonp.mock.calls[0][0]).toContain("/search?");
    expect(jsonp.mock.calls[0][0]).not.toContain("/lookup?");
  });

  it("does not invent a label when copyright is absent", async () => {
    jsonp.mockResolvedValue({
      resultCount: 1,
      results: [
        {
          trackName: "Glue",
          artistName: "Bicep",
          previewUrl: "https://example.test/glue.m4a",
        },
      ],
    });
    expect((await lookupItunes("Bicep", "Glue"))?.label).toBeUndefined();
  });
});
