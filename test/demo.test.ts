import { describe, expect, it } from "vitest";
import {
  DEMO_ASSET,
  DEMO_IMPORT_NAME,
  demoCollectionUrl,
  demoImportFile,
} from "../src/util/demo";

describe("demoCollectionUrl", () => {
  it("puts the file under the deployed base, so the demo is not a 404 in production", () => {
    // vite.config.ts sets base "/onkio/" for GitHub Pages. A hardcoded
    // "/Apple_Music_demo.xml" would resolve to the domain root, where the
    // file is not, and the button would fail only after deploying.
    expect(demoCollectionUrl("/onkio/")).toBe("/onkio/Apple_Music_demo.xml");
  });

  it("works at the domain root too, which is what a bare dev server serves", () => {
    expect(demoCollectionUrl("/")).toBe("/Apple_Music_demo.xml");
  });

  it("adds the separator a base without a trailing slash is missing", () => {
    // BASE_URL is normalised with a trailing slash by Vite, but a caller
    // passing a bare prefix should not silently produce "/onkioApple_...".
    expect(demoCollectionUrl("/onkio")).toBe("/onkio/Apple_Music_demo.xml");
    expect(demoCollectionUrl("")).toBe("Apple_Music_demo.xml");
  });

  it("keeps the asset name the build actually publishes", () => {
    // public/ files are copied verbatim; renaming one here without renaming
    // the file is a 404 no test other than this one would catch.
    expect(DEMO_ASSET).toBe("Apple_Music_demo.xml");
  });
});

describe("demoImportFile", () => {
  it("hands the importer a File, so the demo takes the same path as a chosen file", () => {
    const file = demoImportFile(new Blob(["<DJ_PLAYLISTS/>"], { type: "text/xml" }));
    expect(file).toBeInstanceOf(File);
    expect(file.type).toBe("text/xml");
    expect(file.size).toBeGreaterThan(0);
  });

  it("names the import for what it is rather than for the asset filename", () => {
    // adoptImport turns the file name into the collection label shown in the
    // sidebar, and the asset is named Apple_Music_demo while holding a
    // rekordbox export, which would read as a contradiction beside the
    // "rekordbox" format the detector reports.
    const file = demoImportFile(new Blob([""]));
    expect(file.name).toBe(DEMO_IMPORT_NAME);
    expect(file.name.endsWith(".xml")).toBe(true);
  });
});
