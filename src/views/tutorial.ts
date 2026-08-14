/**
 * Tutorial clouds. Copy and targets live here; main.ts owns the toggle,
 * highlighting, and the few auto-advances (demo loaded, Analyze clicked).
 */

export type CloudSide = "right" | "left" | "below" | "above";
export type CloudPin = "inside-bottom" | "bottom-right" | "below-avoid-set";

export type TutorialCloud = {
  body: string;
  /** Imperative: what to click, in one line. Omit on purely signpost clouds. */
  cta?: string;
  /** Element id to sit beside. */
  target: string;
  /** Used when `target` is not in the DOM yet (Search Deezer before a query). */
  fallback?: string;
  prefer?: CloudSide;
  /** Sit beside this id instead of `target`. */
  place?: string;
  pin?: CloudPin;
  align?: "start" | "center";
};

export type TutorialStep = {
  /** Primary cloud; carries the step index and ← →. */
  body: string;
  cta?: string;
  target: string;
  fallback?: string;
  prefer?: CloudSide;
  place?: string;
  pin?: CloudPin;
  align?: "start" | "center";
  /** Extra clouds on the same step, without their own arrows. */
  extras?: TutorialCloud[];
  /** Extra rings with no cloud of their own. */
  rings?: string[];
  panel?: "sidebar" | "set";
  /** Open a <details> by id so the target is actually visible. */
  openDetails?: string | string[];
  /** Unhide elements for this step (legend, music folder, …). */
  reveal?: string[];
  exports?: boolean;
};

export const TUTORIAL_STEPS: TutorialStep[] = [
  {
    body: "Start here with the bundled crate, so you can learn the map before bringing your own.",
    cta: "Click Load the demo collection",
    target: "demo-load",
    panel: "sidebar",
  },
  {
    body: "Each dot is a track. Close dots on the map indicate similarity. Use the slider to adjust how to organize dots by: left is BPM/key, right is playlist identity.",
    cta: "Drag Mixability ⟷ Taste",
    target: "semantic-slider",
    panel: "sidebar",
  },
  {
    body: "This fills BPM, key, labels and sound in the background. You can keep exploring while it runs.",
    cta: "Click Analyze songs",
    target: "dsp-start",
    panel: "sidebar",
  },
  {
    body: "Click a dot to view similar tracks, adjust key/BPM, and add to your set. Solid dots indicate songs that have been analyzed.",
    cta: "Click a dot",
    target: "scatter-canvas",
    pin: "inside-bottom",
  },
  {
    body: "Color by cluster (determined by the algorithm), collection, BPM, key, or year. You can also highlight by playlist.",
    cta: 'Try changing "Color by" and highlight a playlist.',
    target: "legend-controls",
    reveal: ["legend"],
  },
  {
    body: "Browse mode allows you to rest on a dot for quick previews.",
    cta: "Click the ♪ browsing button",
    target: "browse-toggle",
    prefer: "below",
    extras: [
      {
        body: "This is where you would link a music folder on your computer or USB so tracks play from the files themselves.",
        cta: "Optional: click Choose music folder",
        target: "local-section",
        prefer: "right",
      },
    ],
    reveal: ["local-section"],
    panel: "sidebar",
  },
  {
    body: "Search to highlight songs/artists on the map from your collection(s).",
    cta: 'Search for "Nights" by Frank Ocean.',
    target: "map-search",
    place: "map-search",
    prefer: "below",
    align: "center",
  },
  {
    body: 'To add and locate new songs on the map, use "Search Deezer". You can add any searches you like to a new "Searches" collection.',
    cta: "Search for a song and click Search Deezer.",
    target: "search-deezer",
    fallback: "map-search",
    place: "map-search",
    prefer: "below",
    align: "center",
    rings: ["map-search"],
  },
  {
    body: "Rebuild the map by sound (brightness, texture), release label, and playlist.",
    cta: "Adjust the Sound slider.",
    target: "sound-section",
    panel: "sidebar",
    openDetails: "sound-advanced",
    reveal: ["sound-section"],
  },
  {
    body: "Create a new set by lassoing music.",
    cta: "Click Lasso, then draw around a group of dots",
    target: "lasso-toggle",
    pin: "below-avoid-set",
  },
  {
    body: 'Drag to reorder songs, or add new songs by clicking on individual dots → "Add to set". Suggestion mode highlights mixable next tracks.',
    cta: "Turn on Suggestion mode, then add a highlighted song.",
    target: "suggest-label",
    place: "set-panel",
    prefer: "left",
    panel: "set",
  },
  {
    body: "And that's it! You can also look at your taste profile, switch between Dark/Light mode, and find gaps in your music collection.",
    cta: "Toggle dark/light mode",
    target: "tab-taste",
    prefer: "below",
    rings: ["tab-taste", "gaps-toggle", "theme-toggle"],
  },
  {
    body: "Ready to analyze your own collection? Replace the demo with your own XML or TXT file. Instructions below:",
    cta: "Choose a file, then click New map",
    target: "file-drop",
    panel: "sidebar",
    exports: true,
  },
];

export function tutorialActionIds(step: TutorialStep): string[] {
  return [step.target, ...(step.extras?.map((cloud) => cloud.target) ?? [])];
}

export function tutorialRingIds(step: TutorialStep): string[] {
  return [...new Set([step.target, ...(step.extras?.map((c) => c.target) ?? []), ...(step.rings ?? [])])];
}

export function resolveTutorialEl(cloud: Pick<TutorialCloud, "target" | "fallback">): HTMLElement | null {
  return document.getElementById(cloud.target) ?? (cloud.fallback ? document.getElementById(cloud.fallback) : null);
}

const MARGIN = 12;
const HEADER = 56;
const GAP = 14;
const INSET = 24;
/** Matches `#app.set-open` set-column width so the cloud stays clear of it. */
const SET_COL = 340;

type Box = { left: number; top: number; right: number; bottom: number };

function overlaps(a: Box, b: Box, pad = 8): boolean {
  return !(a.right + pad < b.left || a.left - pad > b.right || a.bottom + pad < b.top || a.top - pad > b.bottom);
}

function clampPos(left: number, top: number, cw: number, ch: number, vw: number, vh: number): Box {
  const x = Math.max(MARGIN, Math.min(left, vw - cw - MARGIN));
  const y = Math.max(HEADER, Math.min(top, vh - ch - MARGIN));
  return { left: x, top: y, right: x + cw, bottom: y + ch };
}

const SIDES: CloudSide[] = ["right", "left", "below", "above"];

function along(r: DOMRect, cw: number, align: "start" | "center" | undefined, vertical: boolean): number {
  if (vertical) return align === "center" ? r.top + (r.height - 0) / 2 : r.top;
  return align === "center" ? r.left + (r.width - cw) / 2 : r.left;
}

export function placeCloud(
  cloud: HTMLElement,
  target: HTMLElement | null,
  opts: { avoid?: Box[]; prefer?: CloudSide; pin?: CloudPin; align?: "start" | "center" } = {}
): Box {
  const cw = cloud.offsetWidth;
  const ch = cloud.offsetHeight;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const avoid = opts.avoid ?? [];

  if (opts.pin === "bottom-right") {
    const box = clampPos(vw - cw - MARGIN, vh - ch - MARGIN, cw, ch, vw, vh);
    cloud.style.left = `${box.left}px`;
    cloud.style.top = `${box.top}px`;
    return box;
  }

  if (opts.pin === "below-avoid-set" && target) {
    const r = target.getBoundingClientRect();
    const setEl = document.getElementById("set-panel");
    const setLeft =
      setEl && !setEl.hidden ? setEl.getBoundingClientRect().left : vw - SET_COL;
    const maxRight = Math.min(vw - MARGIN, setLeft - MARGIN);
    let left = r.left;
    if (left + cw > maxRight) left = maxRight - cw;
    const box = clampPos(left, r.bottom + GAP, cw, ch, vw, vh);
    if (box.right > maxRight) {
      const shifted = clampPos(maxRight - cw, r.bottom + GAP, cw, ch, vw, vh);
      cloud.style.left = `${shifted.left}px`;
      cloud.style.top = `${shifted.top}px`;
      return shifted;
    }
    cloud.style.left = `${box.left}px`;
    cloud.style.top = `${box.top}px`;
    return box;
  }

  if (opts.pin === "inside-bottom" && target) {
    const r = target.getBoundingClientRect();
    const box = clampPos(
      r.left + (r.width - cw) / 2,
      r.bottom - ch - INSET,
      cw,
      ch,
      vw,
      vh
    );
    cloud.style.left = `${box.left}px`;
    cloud.style.top = `${box.top}px`;
    return box;
  }

  const candidates: Box[] = [];
  if (target) {
    const r = target.getBoundingClientRect();
    const x = along(r, cw, opts.align, false);
    const bySide: Record<CloudSide, Box> = {
      right: clampPos(r.right + GAP, r.top, cw, ch, vw, vh),
      left: clampPos(r.left - cw - GAP, r.top, cw, ch, vw, vh),
      below: clampPos(x, r.bottom + GAP, cw, ch, vw, vh),
      above: clampPos(x, r.top - ch - GAP, cw, ch, vw, vh),
    };
    const order = opts.prefer ? [opts.prefer, ...SIDES.filter((s) => s !== opts.prefer)] : SIDES;
    for (const side of order) candidates.push(bySide[side]);
  }
  candidates.push(clampPos((vw - cw) / 2, HEADER + MARGIN, cw, ch, vw, vh));

  const chosen =
    candidates.find((box) => !avoid.some((other) => overlaps(box, other))) ?? candidates[0];
  cloud.style.left = `${chosen.left}px`;
  cloud.style.top = `${chosen.top}px`;
  return chosen;
}
