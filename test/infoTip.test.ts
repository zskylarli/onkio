import { describe, expect, it } from "vitest";
import {
  isAnchorShowing,
  placeInfoPopup,
  TIP_GAP,
  TIP_MARGIN,
  type Box,
} from "../src/views/infoTip";

/**
 * The geometry the ⓘ popups depend on. It is tested rather than eyeballed
 * because the failure it replaces was invisible in the markup: the popup was
 * declared 280px wide inside a 300px scrolling panel and lost up to 211px of
 * its copy to the panel's clip, with nothing in the CSS to suggest it.
 */

function box(left: number, top: number, width = 15, height = 15): Box {
  return { left, top, width, height, right: left + width, bottom: top + height };
}

const POPUP = { width: 280, height: 240 };
const VIEWPORT = { width: 1600, height: 1000 };

function fits(
  p: { left: number; top: number },
  popup: { width: number; height: number },
  viewport: { width: number; height: number }
): boolean {
  return (
    p.left >= 0 &&
    p.top >= 0 &&
    p.left + popup.width <= viewport.width &&
    p.top + popup.height <= viewport.height
  );
}

describe("placeInfoPopup", () => {
  it("opens below the trigger and left-aligned with it", () => {
    const anchor = box(120, 200);
    expect(placeInfoPopup(anchor, POPUP, VIEWPORT)).toEqual({
      left: 120,
      top: anchor.bottom + TIP_GAP,
    });
  });

  it("slides back inside when it would run off the right", () => {
    // The bug in one line: a 280px popup started at x=1500 used to keep going.
    const p = placeInfoPopup(box(1500, 200), POPUP, VIEWPORT);
    expect(p.left).toBe(VIEWPORT.width - TIP_MARGIN - POPUP.width);
    expect(fits(p, POPUP, VIEWPORT)).toBe(true);
  });

  it("flips above the trigger at the bottom of the panel", () => {
    const anchor = box(120, 940);
    const p = placeInfoPopup(anchor, POPUP, VIEWPORT);
    expect(p.top).toBe(anchor.top - TIP_GAP - POPUP.height);
    expect(fits(p, POPUP, VIEWPORT)).toBe(true);
  });

  it("stays on screen when neither side has room", () => {
    // A short viewport with the trigger in the middle: above and below both
    // overflow, so being fully visible wins over being beside the trigger.
    const p = placeInfoPopup(box(120, 130), POPUP, { width: 1600, height: 400 });
    expect(fits(p, POPUP, { width: 1600, height: 400 })).toBe(true);
  });

  it("keeps the whole popup inside the viewport wherever the trigger is", () => {
    for (const width of [1600, 900, 380]) {
      for (const height of [1000, 620]) {
        for (let x = 0; x <= width; x += 37) {
          for (let y = 0; y <= height; y += 41) {
            const p = placeInfoPopup(box(x, y), POPUP, { width, height });
            expect(fits(p, POPUP, { width, height })).toBe(true);
          }
        }
      }
    }
  });

  it("never leaves the viewport by more than it has to when the popup is oversized", () => {
    // Wider than the window: clamped to the near edge rather than centred, so
    // reading starts at the beginning of the text.
    const p = placeInfoPopup(box(200, 100), { width: 2000, height: 100 }, VIEWPORT);
    expect(p.left).toBe(TIP_MARGIN);
  });
});

describe("isAnchorShowing", () => {
  const clip = box(0, 60, 300, 800);

  it("follows a trigger that is inside the panel", () => {
    expect(isAnchorShowing(box(120, 400), clip)).toBe(true);
  });

  it("lets go of one scrolled out of the panel", () => {
    expect(isAnchorShowing(box(120, 20), clip)).toBe(false);
    expect(isAnchorShowing(box(120, 900), clip)).toBe(false);
  });

  it("lets go when the panel is collapsed and the trigger has no box left", () => {
    expect(isAnchorShowing(box(0, 0, 0, 0), clip)).toBe(false);
  });

  it("shows a trigger that nothing clips", () => {
    expect(isAnchorShowing(box(120, 4000), null)).toBe(true);
  });
});
