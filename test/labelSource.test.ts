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

const { clearDeezerAlbumCache, lookupDeezer } = await import(
  "../src/enrich/sources/deezer"
);

beforeEach(() => {
  jsonp.mockReset();
  clearDeezerAlbumCache();
});

function answer(albumLabel: string | undefined): void {
  jsonp.mockImplementation(async (url) => {
    if (url.includes("/search?")) {
      return {
        data: [
          {
            id: 7,
            title: "Losing It",
            preview: "https://example.test/preview.mp3",
            artist: { name: "FISHER" },
            album: { id: 42 },
          },
        ],
      };
    }
    if (url.includes("/track/7")) return { bpm: 0 };
    if (url.includes("/album/42")) return { label: albumLabel };
    throw new Error(`unexpected URL ${url}`);
  });
}

describe("Deezer album labels", () => {
  it("extracts and identifies a label from the matched album", async () => {
    answer("Ultra Records, LLC");
    const result = await lookupDeezer("FISHER", "Losing It");
    expect(result?.label).toBe("Ultra Records");
    expect(result?.labelSource).toBe("deezer");
  });

  it("reuses an album lookup across tracks", async () => {
    answer("Toolroom");
    await lookupDeezer("FISHER", "Losing It");
    await lookupDeezer("FISHER", "Losing It");
    expect(jsonp.mock.calls.filter(([url]) => url.includes("/album/42"))).toHaveLength(1);
  });

  it("represents an absent label as undefined, never an empty string", async () => {
    answer("");
    const result = await lookupDeezer("FISHER", "Losing It");
    expect(result).not.toBeNull();
    expect(result?.label).toBeUndefined();
  });

  it("keeps the matched preview when album metadata fails", async () => {
    answer("Toolroom");
    jsonp.mockImplementation(async (url) => {
      if (url.includes("/search?"))
        return {
          data: [
            {
              id: 7,
              title: "Losing It",
              preview: "https://example.test/preview.mp3",
              artist: { name: "FISHER" },
              album: { id: 42 },
            },
          ],
        };
      if (url.includes("/track/7")) return { bpm: 0 };
      throw new Error("album unavailable");
    });
    const result = await lookupDeezer("FISHER", "Losing It");
    expect(result?.previewUrl).toContain("preview.mp3");
    expect(result?.label).toBeUndefined();
  });
});
