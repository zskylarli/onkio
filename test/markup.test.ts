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

describe("document head", () => {
  it("names an icon, so the page stops asking for one that does not exist", () => {
    // The only console error in the app was a 404 for the /favicon.ico a browser
    // requests when nothing else is declared.
    expect(HTML).toMatch(/<link rel="icon" href="\/favicon\.svg"/);
  });
});

describe("sound section", () => {
  const advanced = block('<details id="sound-advanced">');

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

  it("leaves analysis itself out in the open", () => {
    expect(advanced).not.toContain('id="sound-analyze"');
    expect(advanced).not.toContain('id="sound-status"');
    expect(occurrences('id="sound-analyze"')).toBe(1);
  });

  it("starts collapsed", () => {
    expect(HTML).toContain('<details id="sound-advanced">');
    expect(HTML).not.toContain('<details id="sound-advanced" open');
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
  it("carries the search field, its results and the highlight readout", () => {
    expect(occurrences('id="track-search"')).toBe(1);
    expect(occurrences('id="search-results"')).toBe(1);
    expect(occurrences('id="highlight-status"')).toBe(1);
    expect(occurrences('id="playlist-filter"')).toBe(1);
  });
});

describe("map toolbar", () => {
  const toolbar = HTML.slice(
    HTML.indexOf('<div id="map-toolbar">'),
    HTML.indexOf("</div>", HTML.indexOf('<div id="map-toolbar">'))
  );

  it("keeps the browsing toggle in the toolbar beside the other map controls", () => {
    expect(occurrences('id="browse-toggle"')).toBe(1);
    expect(toolbar).toContain('id="browse-toggle"');
    expect(toolbar).toContain('id="gaps-toggle"');
    expect(toolbar).toContain('id="legend-toggle"');
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

  it("offers zoom as buttons, not only as a wheel gesture", () => {
    // Wheel-only zoom is undiscoverable, and a trackpad makes it worse.
    for (const id of ["zoom-in", "zoom-out"]) {
      expect(occurrences(`id="${id}"`)).toBe(1);
      expect(toolbar).toContain(`id="${id}"`);
    }
    // The keyboard shortcuts main.ts binds, said out loud in the tooltip.
    expect(toolbar).toMatch(/id="zoom-in"[^>]*title="[^"]*\+"/);
    expect(toolbar).toMatch(/id="zoom-out"[^>]*title="[^"]*−"/);
  });

  it("states each toggle's state in the accessibility tree, not only in colour", () => {
    // The accent fill is the only cue otherwise, which is nothing to a screen
    // reader. main.ts keeps these in step through setToggleState.
    for (const id of ["gaps-toggle", "legend-toggle", "browse-toggle"]) {
      expect(toolbar).toMatch(new RegExp(`id="${id}"[^>]*aria-pressed="false"`));
    }
    // Reset and the zoom steps are actions, not states, and must not claim to
    // be pressable.
    for (const id of ["reset-view", "zoom-in", "zoom-out"]) {
      expect(toolbar).not.toMatch(new RegExp(`id="${id}"[^>]*aria-pressed`));
    }
  });

  it("does not mark browsing as on in the markup, so it starts off", () => {
    // Default off: playing on every hover is intrusive, and with a music folder
    // connected a hover reads a whole file off disk.
    expect(toolbar).not.toMatch(/id="browse-toggle"[^>]*class="[^"]*\bon\b/);
  });
});
