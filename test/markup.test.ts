import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * main.ts reaches into the page by id, and nothing in the type system says
 * those ids exist. These check the handful whose disappearance would break a
 * control silently rather than loudly.
 */
const HTML = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "index.html"),
  "utf8"
);

function block(openTag: string): string {
  const start = HTML.indexOf(openTag);
  expect(start).toBeGreaterThan(-1);
  const end = HTML.indexOf("</details>", start);
  return HTML.slice(start, end);
}

const occurrences = (needle: string) => HTML.split(needle).length - 1;

/**
 * The markup of one `<div id="…">` including any divs nested inside it, found by
 * counting tags rather than by looking for the next `</div>`. Several of the map
 * overlays now hold a div of their own, and a slice that stopped at the first
 * close would silently test only the first line of them.
 */
function divBlock(id: string): string {
  const start = HTML.indexOf(`<div id="${id}"`);
  expect(start).toBeGreaterThan(-1);
  const tag = /<(\/?)div\b/g;
  tag.lastIndex = start;
  let depth = 0;
  let m: RegExpExecArray | null;
  while ((m = tag.exec(HTML)) !== null) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return HTML.slice(start, tag.lastIndex);
  }
  throw new Error(`unbalanced <div id="${id}">`);
}

describe("document head", () => {
  it("names an icon, so the page stops asking for one that does not exist", () => {
    // The only console error in the app was a 404 for the /favicon.ico a browser
    // requests when nothing else is declared.
    expect(HTML).toMatch(/<link rel="icon" href="\/favicon\.svg"/);
  });
});

describe("downsample offer", () => {
  it("ships hidden, since it only appears while an import waits on an answer", () => {
    expect(HTML).toContain('<div id="downsample-prompt" role="group"');
    expect(HTML).toMatch(/id="downsample-prompt"[^>]*hidden/);
  });

  it("keeps the note and the choice row main.ts fills by id", () => {
    for (const id of ["downsample-note", "downsample-choices"]) {
      expect(occurrences(`id="${id}"`)).toBe(1);
    }
    // The question names the group for a reader who cannot see the border.
    expect(HTML).toMatch(/id="downsample-prompt"[^>]*aria-labelledby="downsample-note"/);
  });

  it("sits in the library section, where the import it interrupts lives", () => {
    const start = HTML.indexOf('<section id="library-section"') >= 0
      ? HTML.indexOf('<section id="library-section"')
      : HTML.indexOf("<h2>Library</h2>");
    expect(start).toBeGreaterThan(-1);
    expect(HTML.indexOf('id="downsample-prompt"')).toBeGreaterThan(start);
    expect(HTML.indexOf('id="downsample-prompt"')).toBeLessThan(
      HTML.indexOf('id="import-status"')
    );
  });
});

describe("sound section", () => {
  const advanced = block('<details id="sound-advanced">');

  it("presents sound and label weighting as advanced clustering", () => {
    const start = HTML.indexOf('<section id="sound-section"');
    const section = HTML.slice(start, HTML.indexOf("</section>", start));
    expect(section).toContain("<h2>Advanced clustering</h2>");
    expect(section).not.toContain('aria-label="About sound analysis"');
    expect(section).toContain("<summary>Sound influence</summary>");
    expect(section).toContain("<summary>Label influence</summary>");
    expect(section).toContain(
      "Listens to each track and measures how it actually sounds"
    );
    expect(section).not.toContain("Sound influence (advanced)");
    expect(section).not.toContain("Label influence (advanced)");
  });

  it("keeps the timbre slider in the document under the advanced toggle", () => {
    // A collapsed <details> keeps its children, so runEmbedding can still read
    // the value; a renamed or dropped id could not be caught by the compiler.
    expect(occurrences('id="timbre-slider"')).toBe(1);
    expect(advanced).toContain('id="timbre-slider"');
    expect(advanced).toContain("Sound influence on the map");
  });

  it("ships the slider disabled, with somewhere to say why", () => {
    // Nothing is analyzed before an import, and weighting sound that does not
    // exist rebuilds the map to the identical layout while reporting a time.
    // renderCoverage switches it on once a track has been listened to.
    expect(advanced).toMatch(/id="timbre-slider"[^>]*\sdisabled/);
    expect(occurrences('id="timbre-note"')).toBe(1);
    expect(advanced).toContain('id="timbre-note"');
  });

  it("leaves analysis to the single Analysis control", () => {
    expect(advanced).not.toContain('id="sound-analyze"');
    expect(occurrences('id="sound-analyze"')).toBe(0);
    expect(occurrences('id="sound-status"')).toBe(0);
  });

  it("starts collapsed", () => {
    expect(HTML).toContain('<details id="sound-advanced">');
    expect(HTML).not.toContain('<details id="sound-advanced" open');
  });
});

describe("label influence", () => {
  const advanced = block('<details id="label-advanced">');

  it("ships one collapsed influence slider at the measured default", () => {
    expect(occurrences('id="label-slider"')).toBe(1);
    expect(advanced).toMatch(/id="label-slider"[^>]*value="75"[^>]*disabled/);
    expect(HTML).not.toContain('<details id="label-advanced" open');
  });

  it("has a coverage note and an explanatory info tip", () => {
    expect(advanced).toContain('id="label-note"');
    expect(HTML).toContain('aria-label="About label influence"');
    expect(HTML).toContain("tracks with no known label get no label signal");
  });
});

describe("demo collection button", () => {
  const importSection = HTML.slice(
    HTML.indexOf('<section id="import-section">'),
    HTML.indexOf("</section>", HTML.indexOf('<section id="import-section">'))
  );

  it("offers the bundled demo in the import section, where a missing file is felt", () => {
    expect(occurrences('id="demo-load"')).toBe(1);
    expect(occurrences('id="demo-load-label"')).toBe(1);
    expect(importSection).toContain('id="demo-load"');
    expect(importSection).toContain("No file? Load the demo collection");
  });

  it("sits outside the drop label, so clicking it cannot open the file picker", () => {
    // #file-drop is a <label> wrapping #file-input: the browser forwards a
    // click on anything inside it to that input, which would pop the OS file
    // dialog on top of loading the demo.
    const label = HTML.slice(
      HTML.indexOf('<label class="file-drop"'),
      HTML.indexOf("</label>", HTML.indexOf('<label class="file-drop"'))
    );
    expect(label).not.toContain('id="demo-load"');
    // Still adjacent: between the drop box and the add/replace choice.
    expect(importSection.indexOf('id="file-drop"')).toBeLessThan(
      importSection.indexOf('id="demo-load"')
    );
    expect(importSection.indexOf('id="demo-load"')).toBeLessThan(
      importSection.indexOf('id="import-mode"')
    );
  });

  it("is a real button with a readable name rather than a clickable span", () => {
    // Keyboard reach and the accessible name both come from being a <button>;
    // main.ts swaps the label text while the fetch runs, so the busy state is
    // announced rather than being only a greyed-out colour.
    expect(importSection).toMatch(/<button type="button" id="demo-load"/);
    expect(importSection).toMatch(/<span class="demo-icon" aria-hidden="true">/);
  });
});

describe("library file picker", () => {
  it("accepts both XML and fixed-format rekordbox TXT exports", () => {
    expect(HTML).toMatch(/id="file-input"[^>]*accept="[^"]*\.xml[^"]*\.txt[^"]*"/);
    expect(HTML).toContain("Drop collection XML or TXT files");
    expect(HTML).toContain("rekordbox TXT exports");
  });
});

describe("music folder section", () => {
  it("carries the controls main.ts reaches for by id", () => {
    expect(occurrences('id="local-section"')).toBe(1);
    expect(occurrences('id="local-pick"')).toBe(1);
    expect(occurrences('id="local-status"')).toBe(1);
    expect(occurrences('id="local-forget"')).toBe(1);
  });

  it("states the Chromium-only limitation rather than letting it be discovered", () => {
    // Firefox and Safari have no directory picker, and a control that silently
    // does nothing there is worse than one that says why.
    const section = HTML.slice(
      HTML.indexOf('<section id="local-section"'),
      HTML.indexOf("</section>", HTML.indexOf('<section id="local-section"'))
    );
    expect(section).toContain("Chromium");
    expect(section).toMatch(/Firefox and Safari/);
  });

  it("starts hidden, because there is nothing to match before an import", () => {
    expect(HTML).toContain('<section id="local-section" hidden>');
  });
});

describe("info tooltips", () => {
  it("keeps user-facing copy free of em-dashes and first-person language", () => {
    const popups = [...HTML.matchAll(/<span class="info-popup"[^>]*>([\s\S]*?)<\/span>\s*<\/span>/g)];
    expect(popups.length).toBeGreaterThan(5);
    for (const [, body] of popups) {
      expect(body).not.toContain("—");
      expect(body).not.toMatch(/\b(we|our|us|I'?m|I've)\b/i);
    }
  });

  it("keeps every popup inside a trigger initInfoTips can find and place", () => {
    // The popups are positioned from JS because the panel clips them, so one
    // that is not inside a .info-tip would silently go back to being cut off.
    const tips = HTML.split('class="info-tip"').length - 1;
    expect(occurrences('class="info-popup"')).toBe(tips);
    for (const m of HTML.matchAll(/<span class="info-tip">([\s\S]*?)<\/span>\s*<\/span>/g)) {
      expect(m[1]).toContain('class="info-popup"');
    }
  });
});

describe("map controls", () => {
  const mapControls = HTML.slice(
    HTML.indexOf('<section id="map-controls"'),
    HTML.indexOf("</section>", HTML.indexOf('<section id="map-controls"'))
  );

  it("carries the controls main.ts reaches for by id, exactly once each", () => {
    for (const id of [
      "track-search",
      "search-results",
      "color-mode",
      "playlist-filter",
      "highlight-status",
    ]) {
      expect(occurrences(`id="${id}"`)).toBe(1);
    }
  });

  it("has moved color and playlist controls out of the panel", () => {
    expect(mapControls).not.toContain('id="color-mode"');
    expect(mapControls).not.toContain('id="playlist-filter"');
    expect(mapControls).not.toContain('id="highlight-status"');
  });

  it("has moved the search out of the panel and onto the map", () => {
    // A browser-style field over the canvas, reachable with the panel collapsed.
    expect(mapControls).not.toContain('id="track-search"');
    expect(mapControls).not.toContain('id="search-results"');
  });
});

describe("map search", () => {
  const search = divBlock("map-search");

  it("puts the field and its results together above the canvas", () => {
    expect(search).toContain('id="track-search"');
    // A dropdown under the field, so it starts closed rather than empty.
    expect(search).toMatch(/<div id="search-results"[^>]*hidden>/);
    expect(search.indexOf('id="track-search"')).toBeLessThan(
      search.indexOf('id="search-results"')
    );
  });

  it("names itself, since the label it used to carry stayed in the panel", () => {
    // The placeholder is not an accessible name: it disappears on the first
    // keystroke and is not read as one.
    expect(search).toMatch(/id="track-search"[^>]*aria-label="Find a track"/);
    // The magnifier is decoration beside that name, not a second reading of it.
    expect(search).toMatch(/<span class="search-icon" aria-hidden="true">/);
  });

  it("connects the field to its candidate dropdown and publishes open state", () => {
    expect(search).toMatch(/id="track-search"[^>]*aria-controls="search-results"/);
    expect(search).toMatch(/id="track-search"[^>]*aria-expanded="false"/);
    expect(search).toMatch(/id="track-search"[^>]*aria-autocomplete="list"/);
    expect(search).toMatch(/id="search-results"[^>]*aria-label="Search candidates"/);
  });
});

describe("map toolbar", () => {
  const toolbar = divBlock("map-toolbar");

  it("keeps the modes that act on the map, and nothing that is not a mode", () => {
    for (const id of ["browse-toggle", "gaps-toggle", "lasso-toggle"]) {
      expect(occurrences(`id="${id}"`)).toBe(1);
      expect(toolbar).toContain(`id="${id}"`);
    }
    // The legend puts itself away and zoom lives at the other corner, so
    // neither is a button here any more.
    expect(occurrences('id="legend-toggle"')).toBe(0);
    expect(toolbar).not.toContain('id="zoom-in"');
  });

  it("ships the autoplay note hidden and ahead of the buttons", () => {
    // Placed first so that appearing grows the row leftwards instead of shifting
    // the buttons out from under the pointer.
    expect(occurrences('id="browse-note"')).toBe(1);
    expect(toolbar).toContain('<span id="browse-note" hidden>');
    expect(toolbar.indexOf('id="browse-note"')).toBeLessThan(
      toolbar.indexOf('id="gaps-toggle"')
    );
  });

  it("offers the lasso, and says how to use it on hover rather than on the map", () => {
    expect(toolbar).toMatch(/id="lasso-toggle"[^>]*title="Draw a circle around tracks"/);
    // The instruction is a tooltip now; only what a gesture found is shown on
    // the map, and only while it is recent.
    expect(occurrences('id="lasso-hint"')).toBe(0);
    expect(occurrences('id="lasso-feedback"')).toBe(1);
    expect(toolbar).not.toContain('id="lasso-feedback"');
    expect(HTML).toMatch(/<div id="lasso-feedback" role="status" aria-live="polite" hidden>/);
  });

  it("gives the icon-only browsing toggle a name a screen reader can read", () => {
    // A note glyph is not a name. #theme-toggle and #sidebar-toggle carry both
    // an aria-label and a title for the same reason.
    expect(toolbar).toMatch(/id="browse-toggle"[^>]*aria-label="[^"]+"/);
    expect(toolbar).toMatch(/id="browse-toggle"[^>]*title="[^"]*rest the pointer[^"]*"/);
    expect(toolbar).not.toContain(">Browsing<");
  });

  it("states each toggle's state in the accessibility tree, not only in colour", () => {
    // The accent fill is the only cue otherwise, which is nothing to a screen
    // reader. main.ts keeps these in step through setToggleState.
    for (const id of ["gaps-toggle", "browse-toggle", "lasso-toggle"]) {
      expect(toolbar).toMatch(new RegExp(`id="${id}"[^>]*aria-pressed="false"`));
    }
  });

  it("does not mark browsing as on in the markup, so it starts off", () => {
    // Default off: playing on every hover is intrusive, and with a music folder
    // connected a hover reads a whole file off disk.
    expect(toolbar).not.toMatch(/id="browse-toggle"[^>]*class="[^"]*\bon\b/);
  });
});

describe("map zoom stack", () => {
  const zoom = divBlock("map-zoom");

  it("offers zoom as buttons, not only as a wheel gesture", () => {
    // Wheel-only zoom is undiscoverable, and a trackpad makes it worse. The ids
    // are unchanged because main.ts and the browser scripts bind to them.
    for (const id of ["zoom-in", "zoom-out", "reset-view"]) {
      expect(occurrences(`id="${id}"`)).toBe(1);
      expect(zoom).toContain(`id="${id}"`);
    }
    // The keyboard shortcuts main.ts binds, said out loud in the tooltip.
    expect(zoom).toMatch(/id="zoom-in"[^>]*title="[^"]*\+"/);
    expect(zoom).toMatch(/id="zoom-out"[^>]*title="[^"]*−"/);
  });

  it("stacks in reading order: in, out, then reset", () => {
    expect(zoom.indexOf('id="zoom-in"')).toBeLessThan(zoom.indexOf('id="zoom-out"'));
    expect(zoom.indexOf('id="zoom-out"')).toBeLessThan(zoom.indexOf('id="reset-view"'));
  });

  it("names each one, since all three are glyphs rather than words", () => {
    for (const id of ["zoom-in", "zoom-out", "reset-view"]) {
      expect(zoom).toMatch(new RegExp(`id="${id}"[^>]*aria-label="[^"]+"`));
      // These are actions, not states, and must not claim to be pressable.
      expect(zoom).not.toMatch(new RegExp(`id="${id}"[^>]*aria-pressed`));
    }
  });
});

describe("legend", () => {
  const legend = divBlock("legend");

  it("carries its own collapse control rather than a toolbar button", () => {
    expect(occurrences('id="legend-collapse"')).toBe(1);
    expect(legend).toContain('id="legend-collapse"');
    expect(legend).toContain('id="legend-body"');
    expect(occurrences('id="legend-title"')).toBe(1);
    expect(occurrences('id="legend-items"')).toBe(1);
  });

  it("keeps map color and playlist highlighting inside the legend", () => {
    for (const id of ["color-mode", "playlist-filter", "highlight-status"]) {
      expect(legend).toContain(`id="${id}"`);
    }
    expect(legend).toMatch(/id="playlist-filter"[^>]*aria-label="Highlight playlist"/);
    expect(legend.indexOf('id="playlist-filter"')).toBeLessThan(
      legend.indexOf('id="highlight-status"')
    );
  });

  it("offers genre without removing any existing color mode", () => {
    for (const [value, label] of [
      ["cluster", "Cluster"],
      ["collection", "Collection"],
      ["genre", "Genre"],
      ["bpm", "BPM"],
      ["key", "Key"],
      ["year", "Year"],
    ]) {
      expect(legend).toContain(`<option value="${value}">${label}</option>`);
    }
  });

  it("says what it collapses, and whether it is collapsed", () => {
    // Collapsing to the title bar rather than disappearing is what keeps a way
    // back; aria-expanded is that state for a reader who cannot see the box.
    expect(legend).toMatch(/id="legend-collapse"[^>]*aria-expanded="true"/);
    expect(legend).toMatch(/id="legend-collapse"[^>]*aria-controls="legend-body"/);
    expect(legend).toMatch(/id="legend-collapse"[^>]*aria-label="[^"]+"/);
  });
});

describe("analysis", () => {
  const sectionStart = HTML.indexOf('<section id="enrich-section"');
  const section = HTML.slice(
    sectionStart,
    HTML.indexOf("</section>", sectionStart)
  );
  const lookups = block('<details id="online-lookups">');

  it("names the section Analysis and places the control beside it", () => {
    expect(section).toContain("<h2>Analysis</h2>");
    expect(lookups).toContain("<summary>Options</summary>");
    expect(lookups).not.toContain("Online lookups");
    expect(occurrences('id="dsp-start"')).toBe(1);
    expect(section).toContain('class="section-head analysis-head"');
    expect(section.indexOf('id="dsp-start"')).toBeLessThan(
      section.indexOf('id="online-lookups"')
    );
    expect(section).toContain("Analyze songs");
    expect(occurrences('id="enrich-toggle"')).toBe(0);
    expect(occurrences('id="enrich-status"')).toBe(0);
    expect(section).not.toContain("Start lookups");
    expect(occurrences('id="sound-analyze"')).toBe(0);
    expect(section).not.toMatch(/id="dsp-stop"/);
  });

  it("shows analysis status in the small muted style used elsewhere", () => {
    expect(occurrences('id="dsp-status"')).toBe(1);
    expect(section).toMatch(/id="dsp-status" class="muted small"/);
  });

  it("keeps the analysis explanation short", () => {
    expect(section).toContain("Best-effort analysis for tracks missing BPM and key information");
    expect(section).toContain("label-based");
    expect(section).toContain("clustering");
    expect(section).not.toContain("Browser analysis");
  });

  it("appears above advanced clustering", () => {
    expect(HTML.indexOf('id="enrich-section"')).toBeLessThan(
      HTML.indexOf('id="sound-section"')
    );
  });
});

describe("set builder panel", () => {
  const panel = HTML.slice(
    HTML.indexOf('<aside id="set-panel"'),
    HTML.indexOf("</aside>", HTML.indexOf('<aside id="set-panel"'))
  );

  it("is a panel rather than a tab, so the map it is built from stays visible", () => {
    expect(HTML).toContain('<aside id="set-panel" hidden');
    expect(HTML).not.toContain('data-tab="set"');
    expect(HTML).not.toContain('id="view-set"');
    // Outside <main>, which holds only the tabbed views.
    expect(HTML.indexOf("</main>")).toBeLessThan(HTML.indexOf('<aside id="set-panel"'));
  });

  it("keeps the controls main.ts reaches for by id", () => {
    for (const id of [
      "suggest-toggle",
      "sparkline",
      "export-m3u8",
      "export-text",
      "set-clear",
      "set-list",
      "set-empty",
      "set-close",
    ]) {
      expect(occurrences(`id="${id}"`)).toBe(1);
      expect(panel).toContain(`id="${id}"`);
    }
  });

  it("is opened from a header button that names itself and carries the count", () => {
    expect(occurrences('id="set-toggle"')).toBe(1);
    expect(occurrences('id="set-count"')).toBe(1);
    expect(HTML).toMatch(/id="set-toggle"[^>]*aria-expanded="false"/);
    expect(HTML).toMatch(/id="set-toggle"[^>]*aria-controls="set-panel"/);
    // The count is filled by renderSet and left empty while the set is, so the
    // markup must not ship a zero for it to read "Set Builder 0" on load.
    expect(HTML).toContain('>Set Builder<span id="set-count"></span>');
  });

  it("gives the sparkline no fixed width, since the panel decides it", () => {
    // A width attribute became a stale drawing surface once the set moved out of
    // a full-width tab; drawSparkline sizes it from its box instead.
    expect(panel).not.toMatch(/id="sparkline"[^>]*\bwidth=/);
  });
});
