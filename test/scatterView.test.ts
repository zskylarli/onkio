import { describe, expect, it } from "vitest";
import { adoptViewState, type ControllerViewState } from "../src/render/scatter";

/**
 * The stepped zoom reads the view state back before it steps, so what the map
 * adopts from deck decides whether a second press can move anything. deck's
 * orthographic controller answers in a different vocabulary from the one it was
 * asked in, and the whole of this bug lived in that gap: zoom buttons worked
 * once and then did nothing until Reset.
 *
 * The class around this needs a GL context, so the map itself is verified in a
 * browser. This is the decision that broke, on its own.
 */

const bounds = { minZoom: -4, maxZoom: 14 };

/** what deck reports after any interaction: an axis pair, and no bounds */
const reported = (over: Partial<ControllerViewState> = {}): ControllerViewState =>
  ({
    width: 1600,
    height: 1000,
    target: [0.4, 1.1, 0],
    zoom: 5.5,
    zoomX: 5.5,
    zoomY: 5.5,
    zoomAxis: "all",
    minZoomX: -4,
    maxZoomX: 14,
    ...over,
  }) as ControllerViewState;

describe("adoptViewState", () => {
  it("drops the axis pair, which otherwise outranks every later scalar zoom", () => {
    // The regression: both the controller and the viewport prefer zoomX/zoomY
    // to zoom, so a retained pair silently overrode each new stepped zoom.
    const adopted = adoptViewState(reported(), bounds);
    expect(adopted).not.toHaveProperty("zoomX");
    expect(adopted).not.toHaveProperty("zoomY");
    expect(Object.keys(adopted).sort()).toEqual(["maxZoom", "minZoom", "target", "zoom"]);
  });

  it("takes the axis pair as the truth about where the view is, not the scalar", () => {
    // Mid-transition deck interpolates the pair while the scalar already holds
    // the destination; believing the scalar restarts the transition every frame.
    const adopted = adoptViewState(reported({ zoom: 6, zoomX: 5.25, zoomY: 5.25 }), bounds);
    expect(adopted.zoom).toBe(5.25);
  });

  it("resolves a disagreeing pair the way the viewport does", () => {
    expect(adoptViewState(reported({ zoomX: 3, zoomY: 7 }), bounds).zoom).toBe(3);
  });

  it("keeps the scalar when there is no pair, which is the shape the map sets", () => {
    const initial = { target: [0, 0, 0], zoom: 4 } as ControllerViewState;
    expect(adoptViewState(initial, bounds).zoom).toBe(4);
  });

  it("carries the bounds the controller never reports back", () => {
    // clampZoom reads these, and losing them silently widened the clamp to its
    // fallback rather than the bounds the map was built with.
    const adopted = adoptViewState(reported(), { minZoom: -2, maxZoom: 9 });
    expect(adopted.minZoom).toBe(-2);
    expect(adopted.maxZoom).toBe(9);
  });

  it("passes target through by identity, so deck still knows its own updates", () => {
    // A rebuilt array fails deck's value comparison and cancels pan inertia.
    const vs = reported();
    expect(adoptViewState(vs, bounds).target).toBe(vs.target);
  });

  it("survives being fed its own output, which is what repeated presses do", () => {
    let vs = adoptViewState(reported(), bounds);
    const seen: number[] = [];
    for (let i = 0; i < 5; i++) {
      const stepped = { ...vs, zoom: vs.zoom + 1 };
      // The controller answers the step with a pair agreeing with the scalar.
      vs = adoptViewState(
        { ...stepped, zoomX: stepped.zoom, zoomY: stepped.zoom },
        bounds
      );
      seen.push(vs.zoom);
    }
    expect(seen).toEqual([6.5, 7.5, 8.5, 9.5, 10.5]);
  });
});
