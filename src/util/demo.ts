/**
 * The bundled demo collection, for someone who wants to see the map before
 * they have an export of their own.
 *
 * It ships in `public/`, so it lands at the root of the build output and is
 * served under whatever base the site is deployed at: `/onkio/` on GitHub
 * Pages, `/` for a bare server. Both of these are pure so the join and the
 * naming can be checked without a browser.
 */

/** The name the file has in `public/`, and so in the deployed build. */
export const DEMO_ASSET = "Apple_Music_demo.xml";

/**
 * The name the import is given. The asset keeps its Apple-flavoured filename
 * for historical reasons, but its contents are a rekordbox export, and that
 * name becomes the collection label in the sidebar, so it says what it is.
 */
export const DEMO_IMPORT_NAME = "Onkio demo collection.xml";

/**
 * An absolute `fetch("/Apple_Music_demo.xml")` works on a bare dev server and
 * 404s on GitHub Pages, where everything sits under `/onkio/`. Building the
 * URL from Vite's base is the difference between the demo working in
 * production and not.
 */
export function demoCollectionUrl(base: string): string {
  const prefix = base === "" ? "" : base.endsWith("/") ? base : `${base}/`;
  return `${prefix}${DEMO_ASSET}`;
}

/**
 * The importer takes a `File`, which is what a picked or dropped file is, so
 * the fetched bytes are wrapped in one rather than given a path of their own
 * through the parsers.
 */
export function demoImportFile(blob: Blob): File {
  return new File([blob], DEMO_IMPORT_NAME, { type: "text/xml" });
}
