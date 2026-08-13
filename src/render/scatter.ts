import { Deck, OrthographicView, type Layer, type PickingInfo } from "@deck.gl/core";
import { ScatterplotLayer, LineLayer, PolygonLayer, TextLayer } from "@deck.gl/layers";
import type { Track } from "../types";
import { parseCamelot } from "../music/camelot";
import {
  CLUSTER_COLORS,
  DEFAULT_BPM_SCALE,
  EXTERNAL_COLOR,
  GAP_COLOR,
  LASSO_COLOR,
  NO_DATA,
  bpmBin,
  bpmBinLabel,
  bpmColor,
  collectionColor,
  decadeColor,
  decadeOf,
  genreColor,
  genreDisplayLabel,
  keyColor,
  makeBpmScale,
  normalizeGenre,
  type BpmScale,
  type RGB,
  type Theme,
} from "./palette";
import {
  LASSO_MIN_POINTS,
  indicesInPolygon,
  shouldAppend,
  type Bounds,
  type Point,
} from "../views/lasso";

/**
 * WebGL scatter (§6): deck.gl ScatterplotLayer — picking, zoom and hover come
 * free, which is why it beats hand-rolled Canvas at 6k points.
 *
 * Color encodings live in ./palette; every mode publishes its bins through
 * `legendEntries()` so the map always ships with a key.
 */

export type ColorMode = "cluster" | "collection" | "genre" | "bpm" | "key" | "year";
export type { Theme };

export type ScatterState = {
  tracks: Track[];
  coords: Float32Array; // n × 2
  clusters: Int32Array;
};

/**
 * A gap as the map draws it: the two cluster centres it runs between, and the
 * middle of the empty corridor where the numbered marker sits.
 */
export type GapMarker = {
  index: number;
  x: number;
  y: number;
  a: [number, number];
  b: [number, number];
};

/**
 * A track found outside the library and placed by projection, which has not
 * been added to it. It carries its own position because it is in no track
 * array: `coords` belongs to the embedding run, and this was never in one.
 */
export type GhostPoint = {
  track: Track;
  x: number;
  y: number;
};

export type LegendEntry = {
  label: string;
  color: RGB;
  count: number;
};

type ViewState = {
  target: [number, number, number];
  zoom: number;
  minZoom?: number;
  maxZoom?: number;
};

/**
 * What deck reports back, which is not what it was given: the orthographic
 * controller answers in its own vocabulary, splitting zoom across an axis pair.
 */
export type ControllerViewState = ViewState & { zoomX?: number; zoomY?: number };

/**
 * Reduce what the controller reports back to the fields this module owns.
 *
 * deck answers with `zoomX`/`zoomY` beside the scalar `zoom`, and both the
 * orthographic controller and its viewport read that axis pair in preference to
 * the scalar. Carrying it forward therefore pins the view to wherever the axes
 * last were, and every zoom set as a scalar afterwards is accepted and then
 * ignored: the controller finds nothing changed to transition between, and the
 * viewport renders the stale pair. The axis pair is the truth about where the
 * view is now, so it becomes the scalar here and then stops existing.
 *
 * `target` is passed through by reference on purpose. deck compares it by value
 * to recognise its own updates, and a rebuilt array reads as an outside change,
 * which cancels pan inertia mid-glide.
 */
export function adoptViewState(
  reported: ControllerViewState,
  bounds: { minZoom?: number; maxZoom?: number }
): ViewState {
  const { zoomX, zoomY } = reported;
  return {
    target: reported.target,
    // Matches how the viewport resolves a split pair back to a single number.
    zoom:
      zoomX !== undefined && zoomY !== undefined ? Math.min(zoomX, zoomY) : reported.zoom,
    // Bounds are ours: the controller renames them per axis and never reports
    // them under the names `clampZoom` and deck's own props are keyed by.
    minZoom: bounds.minZoom,
    maxZoom: bounds.maxZoom,
  };
}

type Callbacks = {
  onHover?: (track: Track | null, x: number, y: number) => void;
  onClick?: (track: Track | null, x: number, y: number) => void;
  onGapClick?: (index: number) => void;
  onViewChange?: () => void;
  /**
   * Row indices caught by a freehand selection: repeatedly as it is drawn, then
   * once with `done` when the pointer is released.
   */
  onLasso?: (indices: number[], done: boolean) => void;
};

/** One doubling per press, the step a double-click and every map app uses. */
export const ZOOM_STEP = 1;
/** Long enough to read as movement, short enough not to feel like waiting. */
const ZOOM_TRANSITION_MS = 220;
/** Fraction of the frame left as margin around whatever `zoomTo` is given. */
const FRAME_PADDING = 1.25;
/** One breath of the hovered dot, in milliseconds. */
const PULSE_MS = 1400;

export class Scatter {
  private deck: Deck<OrthographicView>;
  private canvas: HTMLCanvasElement;
  private state: ScatterState | null = null;
  private colorMode: ColorMode = "cluster";
  private theme: Theme = "dark";
  private highlighted: Set<string> = new Set();
  private dimUnhighlighted = false;
  private gaps: GapMarker[] = [];
  private clusterLabels = new Map<number, string>();
  /** imported collections, in import order — drives the Collection color mode */
  private collections: { id: string; label: string }[] = [];
  private collectionIndex = new Map<string, number>();
  private decades: number[] = [];
  private decadeIndex = new Map<number, number>();
  private bpmScale: BpmScale = DEFAULT_BPM_SCALE;
  /** size of the BPM population the current scale was built from */
  private bpmScaleFor = 0;
  /** any track has measured timbre — enables the heard/unheard distinction */
  private showHeard = false;
  private viewState: ViewState = { target: [0, 0, 0], zoom: 4, minZoom: -4, maxZoom: 14 };
  private fitted: ViewState = this.viewState;
  /** widest side of the laid-out data, in world units — framing is relative to it */
  private span = 1;
  /** the laid-out data's extent in world units, as `measureData` found it */
  private dataBounds: Bounds | null = null;
  /**
   * The dot under the pointer, drawn and animated on its own (see hoverLayers).
   * `index` is the row in the laid-out data, or -1 for a ghost, which has no
   * row — hence the position being carried here rather than looked up.
   */
  private hovered: {
    pid: string;
    index: number;
    track: Track;
    at: [number, number];
  } | null = null;
  /** external tracks placed on the map but not added to the library */
  private ghosts: GhostPoint[] = [];
  /** the track whose detail popover is open */
  private selectedPid: string | null = null;
  private pulseHandle: number | null = null;
  private pulseStart = 0;
  private reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)") ?? null;
  /** what `update` last built, so a pulse frame can reuse it untouched */
  private baseLayers: Layer[] = [];
  /**
   * Drag to pan, wheel to zoom, double-click to zoom in where you clicked,
   * arrow keys to nudge. Rotation is meaningless for an embedding, so it stays
   * off. Wheel speed is double deck's default, which asked for four or five
   * notches to cross a single zoom level.
   */
  private readonly controller = {
    dragPan: true,
    dragRotate: false,
    scrollZoom: { smooth: true, speed: 0.02 },
    doubleClickZoom: true,
    touchZoom: true,
    touchRotate: false,
    keyboard: true,
    inertia: 300,
  };
  private lassoMode = false;
  /** the gesture in progress, in world units, or empty when nothing is drawn */
  private lassoWorld: Point[] = [];
  /** the same path in screen pixels, which is where thinning it is meaningful */
  private lassoScreen: Point[] = [];
  private lassoDrawing = false;
  private clickStart: Point | null = null;
  private cb: Callbacks;

  constructor(canvas: HTMLCanvasElement, cb: Callbacks = {}) {
    this.cb = cb;
    this.canvas = canvas;
    this.deck = new Deck({
      canvas,
      views: new OrthographicView({ flipY: false }),
      controller: this.controller,
      pickingRadius: 6, // forgiving hit target — points are 2–3 px
      viewState: this.viewState,
      onViewStateChange: (params: { viewState: unknown }) => {
        this.viewState = adoptViewState(
          params.viewState as ControllerViewState,
          this.viewState
        );
        this.deck.setProps({ viewState: this.viewState });
        this.cb.onViewChange?.();
      },
      getCursor: ({ isDragging, isHovering }) =>
        this.lassoMode ? "crosshair" : isDragging ? "grabbing" : isHovering ? "pointer" : "grab",
      layers: [],
      onHover: (info: PickingInfo) => {
        // Mid-gesture the pointer is drawing, not pointing: a hover would light
        // dots up and, in Browsing mode, start playing whatever it crossed.
        if (this.lassoMode) {
          this.clearHovered();
          this.cb.onHover?.(null, info.x, info.y);
          return;
        }
        const picked = this.pickedTrack(info);
        if (picked) this.setHovered(picked.track, picked.index, picked.at);
        else this.clearHovered();
        this.cb.onHover?.(picked?.track ?? null, info.x, info.y);
      },
      onClick: (info: PickingInfo) => {
        if (this.lassoMode) return;
        if (info.layer?.id === "gaps" && info.object) {
          this.cb.onGapClick?.((info.object as GapMarker).index);
          return;
        }
        this.cb.onClick?.(this.pickedTrack(info)?.track ?? null, info.x, info.y);
      },
    });

    // Own listeners rather than deck's drag events: deck reports a drag as a
    // start, a delta and an end, and a freehand outline needs every position in
    // between.
    //
    // `pointerdown` is taken in the capture phase because that is what decides
    // whether deck sees the gesture at all: mjolnir binds `pointerdown` on this
    // same canvas in the bubble phase and only then starts tracking the drag on
    // the window, so stopping it here is what suspends panning (see
    // setLassoMode). The rest are ordinary bubble-phase listeners.
    canvas.addEventListener("pointerdown", this.onLassoDown, { capture: true });
    canvas.addEventListener("pointermove", this.onLassoMove);
    canvas.addEventListener("pointerup", this.onLassoUp);
    canvas.addEventListener("pointercancel", this.onLassoCancel);
    // deck does not consistently deliver an `onClick` callback when no layer
    // was picked. The native click fills that blank-map case only.
    canvas.addEventListener("click", this.onEmptyClick);
  }

  // ---------- freehand selection ----------

  /**
   * Turn freehand selection on or off. The drag has one meaning at a time: while
   * this is on it draws an outline, and panning is left to the wheel, the arrow
   * keys and the zoom controls.
   *
   * The drag is taken away from deck by swallowing `pointerdown` (see
   * onLassoDown) rather than by handing it `dragPan: false`. Reconfiguring the
   * controller does not work here, and fails in a way that outlives the mode:
   * deck applies a changed `controller` prop by writing it onto the first View
   * and letting ViewManager notice, but ViewManager diffs views with
   * `view.equals`, which short-circuits on identity. The same OrthographicView
   * instance is passed every time, so the write is seen as no change and the
   * live controller keeps its old flag — until something unrelated marks the
   * view manager dirty, which then applies whatever was last written. In
   * practice that meant panning stayed on for the whole of the drawing gesture
   * and was then switched off by the very view-state change that gesture
   * caused, leaving the map unpannable after the mode had been left.
   */
  setLassoMode(on: boolean): void {
    if (this.lassoMode === on) return;
    this.lassoMode = on;
    this.discardLasso();
    // deck re-asserts its own cursor on the next pointer move, by which time it
    // agrees with this; setting it here is what makes the mode visible at once.
    this.canvas.style.cursor = on ? "crosshair" : "grab";
  }

  /** Abandon a gesture in progress, leaving the mode as it is. */
  cancelLasso(): void {
    if (this.lassoWorld.length === 0 && !this.lassoDrawing) return;
    this.discardLasso();
    this.draw();
    this.cb.onLasso?.([], false);
  }

  private discardLasso(): void {
    this.lassoDrawing = false;
    this.lassoWorld = [];
    this.lassoScreen = [];
  }

  private onLassoDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    if (!this.lassoMode) {
      this.clickStart = [e.clientX, e.clientY];
      return;
    }
    // Deck's controller never learns the drag began, so it cannot pan through
    // it. That is not only about feel: the outline is accumulated in world
    // coordinates, so a camera that moved mid-gesture would smear the polygon
    // against the points and select the wrong tracks.
    e.stopImmediatePropagation();
    this.discardLasso();
    this.lassoDrawing = true;
    // Capture, so an outline drawn off the edge of the canvas still finishes on
    // release instead of being left open forever. Not worth abandoning the
    // gesture over: without it a release outside the canvas is simply missed.
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      /* no capture available for this pointer */
    }
    this.appendLassoPoint(e, true);
    e.preventDefault();
  };

  private onLassoMove = (e: PointerEvent): void => {
    if (!this.lassoDrawing) return;
    if (!this.appendLassoPoint(e)) return;
    this.draw();
    this.cb.onLasso?.(this.lassoSelection(), false);
  };

  private onLassoUp = (e: PointerEvent): void => {
    if (!this.lassoDrawing) return;
    this.lassoDrawing = false;
    this.appendLassoPoint(e, true);
    const caught = this.lassoSelection();
    // The outline has said what it was for; leaving it on the map would only
    // obscure the tracks it just named.
    this.discardLasso();
    this.draw();
    this.cb.onLasso?.(caught, true);
  };

  private onLassoCancel = (): void => {
    if (!this.lassoDrawing) return;
    this.cancelLasso();
  };

  private onEmptyClick = (event: MouseEvent): void => {
    if (this.lassoMode || !this.clickStart) return;
    const [startX, startY] = this.clickStart;
    this.clickStart = null;
    if (Math.hypot(event.clientX - startX, event.clientY - startY) > 4) return;
    const rect = this.canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const picked = this.deck.pickMultipleObjects({ x, y, radius: 6, depth: 4 });
    if (
      picked.some((info) =>
        ["tracks", "gaps", "ghosts"].includes(info.layer?.id ?? "")
      )
    ) {
      return;
    }
    this.cb.onClick?.(null, x, y);
  };

  /** Screen position, thinned, then kept in world units. Reports whether it grew. */
  private appendLassoPoint(e: PointerEvent, force = false): boolean {
    const rect = this.canvas.getBoundingClientRect();
    const screen: Point = [e.clientX - rect.left, e.clientY - rect.top];
    if (!force && !shouldAppend(this.lassoScreen, screen)) return false;
    const viewport = this.deck.getViewports()[0];
    if (!viewport) return false;
    const [x, y] = viewport.unproject(screen);
    this.lassoScreen.push(screen);
    this.lassoWorld.push([x, y]);
    return true;
  }

  private lassoSelection(): number[] {
    const s = this.state;
    if (!s || this.lassoWorld.length < LASSO_MIN_POINTS) return [];
    return indicesInPolygon(s.coords, this.lassoWorld, s.tracks.length);
  }

  /** The outline being drawn, above the map and below nothing. */
  private lassoLayers(): Layer[] {
    if (this.lassoWorld.length < LASSO_MIN_POINTS) return [];
    const [r, g, b] = LASSO_COLOR[this.theme];
    return [
      new PolygonLayer<Point[]>({
        id: "lasso",
        data: [this.lassoWorld],
        getPolygon: (p: Point[]) => p,
        filled: true,
        stroked: true,
        getFillColor: [r, g, b, 26],
        getLineColor: [r, g, b, 220],
        getLineWidth: 1.5,
        lineWidthUnits: "pixels",
        pickable: false,
        // The path grows on every captured point, and deck compares data by
        // reference: without this the outline would freeze at its first frame.
        updateTriggers: { getPolygon: this.lassoWorld.length },
      }),
    ];
  }

  /**
   * `keepView` is for data that grew rather than data that was replaced: a
   * track projected onto the existing map has to be able to join it without
   * the camera jumping back to the whole-library framing, which would undo the
   * very act of going to look at it.
   */
  setData(state: ScatterState, { keepView = false }: { keepView?: boolean } = {}): void {
    this.state = state;
    // Row indices and world positions belong to the layout that just went away.
    this.hovered = null;
    this.discardLasso();
    this.stopPulse();
    const decades = new Set<number>();
    for (const t of state.tracks) {
      if (t.year) decades.add(decadeOf(t.year));
    }
    this.decades = [...decades].sort((a, b) => a - b);
    this.decadeIndex = new Map(this.decades.map((d, i) => [d, i]));
    this.bpmScaleFor = 0;
    this.measureData();
    if (!keepView) this.setViewState(this.fitted);
    this.update();
  }

  /** Pending external tracks, drawn on the map without being part of it. */
  setGhosts(ghosts: GhostPoint[]): void {
    this.ghosts = ghosts;
    this.update();
  }

  /**
   * BPM bins are sized from the data, so they have to be rebuilt as lookups
   * fill values in — but rescaling on every arriving track would flicker the
   * whole map through palettes, so it waits until the population has grown by
   * a fifth.
   */
  private refreshBpmScale(): void {
    const s = this.state;
    if (!s) return;
    const bpms: number[] = [];
    for (const t of s.tracks) if (t.bpm) bpms.push(t.bpm);
    if (this.bpmScaleFor > 0 && bpms.length < this.bpmScaleFor * 1.2) return;
    this.bpmScale = makeBpmScale(bpms);
    this.bpmScaleFor = bpms.length;
  }

  setColorMode(mode: ColorMode): void {
    this.colorMode = mode;
    this.update();
  }

  setTheme(theme: Theme): void {
    this.theme = theme;
    this.update();
  }

  setClusterLabels(labels: Map<number, string>): void {
    this.clusterLabels = labels;
  }

  setCollections(collections: { id: string; label: string }[]): void {
    this.collections = collections;
    this.collectionIndex = new Map(collections.map((c, i) => [c.id, i]));
    this.update();
  }

  setHighlight(pids: Iterable<string>, dimOthers: boolean): void {
    this.highlighted = new Set(pids);
    this.dimUnhighlighted = dimOthers;
    this.update();
  }

  /** Mark exactly one track while its detail popover is open. */
  setSelectedTrack(pid: string | null): void {
    if (this.selectedPid === pid) return;
    this.selectedPid = pid;
    this.draw();
  }

  /**
   * Give a track the same transient pulse as a canvas hover without reporting
   * it through `onHover`. HTML controls such as search results can point back
   * into the map without pretending to have pointer coordinates or starting
   * Browsing-mode audio.
   */
  setExternalHover(pid: string | null): void {
    if (pid === null) {
      this.clearHovered();
      return;
    }
    const found = this.locate(pid);
    if (found) this.setHovered(found.track, found.index, found.at);
    else this.clearHovered();
  }

  /** Where a track is, whether it is in the layout or only projected onto it. */
  private locate(
    pid: string
  ): { track: Track; index: number; at: [number, number] } | null {
    const state = this.state;
    const index = state ? state.tracks.findIndex((track) => track.pid === pid) : -1;
    if (state && index >= 0) {
      return {
        track: state.tracks[index],
        index,
        at: [state.coords[index * 2], state.coords[index * 2 + 1]],
      };
    }
    const ghost = this.ghosts.find((candidate) => candidate.track.pid === pid);
    return ghost ? { track: ghost.track, index: -1, at: [ghost.x, ghost.y] } : null;
  }

  /** What a deck picking result points at, in this module's terms. */
  private pickedTrack(
    info: PickingInfo
  ): { track: Track; index: number; at: [number, number] } | null {
    const state = this.state;
    if (info.layer?.id === "tracks" && info.object && state) {
      const index = info.index;
      return {
        track: info.object as Track,
        index,
        at: [state.coords[index * 2], state.coords[index * 2 + 1]],
      };
    }
    if (info.layer?.id === "ghosts" && info.object) {
      const ghost = info.object as GhostPoint;
      return { track: ghost.track, index: -1, at: [ghost.x, ghost.y] };
    }
    return null;
  }

  /** Exposed for lightweight browser verification of the visual hover state. */
  getHoveredTrackPid(): string | null {
    return this.hovered?.pid ?? null;
  }

  setGaps(gaps: GapMarker[]): void {
    this.gaps = gaps;
    this.update();
  }

  /**
   * Where every laid-out point currently sits on screen, as one box in canvas
   * pixels. Outside it the map holds nothing, which is the only honest way for a
   * test to name a pixel a gesture should catch nothing at: the last one to
   * presume an empty corner picked one the legend was sitting on.
   */
  screenBounds(): Bounds | null {
    const b = this.dataBounds;
    if (!b) return null;
    const a = this.project(b.minX, b.minY);
    const c = this.project(b.maxX, b.maxY);
    if (!a || !c) return null;
    return {
      minX: Math.min(a[0], c[0]),
      minY: Math.min(a[1], c[1]),
      maxX: Math.max(a[0], c[0]),
      maxY: Math.max(a[1], c[1]),
    };
  }

  /** World → screen, for anchoring HTML popovers to points. */
  project(x: number, y: number): [number, number] | null {
    const viewport = this.deck.getViewports()[0];
    if (!viewport) return null;
    const p = viewport.project([x, y]);
    return [p[0], p[1]];
  }

  /** Frame a circle of `radius` about a point, with room left around it. */
  zoomTo(x: number, y: number, radius: number): void {
    const viewport = this.deck.getViewports()[0];
    const width = viewport?.width ?? 800;
    const height = viewport?.height ?? 600;
    const span = Math.max(radius * 2 * FRAME_PADDING, 1e-6);
    this.setViewState({
      ...this.viewState,
      target: [x, y, 0],
      zoom: this.clampZoom(Math.log2(Math.min(width, height) / span)),
    });
  }

  /**
   * Centre on a single point at a readable zoom. A point has no extent of its
   * own, so it borrows a slice of the layout's: enough magnification to pick
   * one dot out of a crate, not so much that the neighbours which say where
   * you landed leave the screen.
   */
  focusOn(x: number, y: number): void {
    this.zoomTo(x, y, this.span / 30);
  }

  /**
   * Step the zoom by whole levels, about the centre of the view. Centring on
   * the target rather than on the origin is what keeps the map's focus where
   * it was, and deck's own transition runs the step as movement, which anchored
   * popovers can follow frame by frame.
   */
  zoomBy(steps: number): void {
    const zoom = this.clampZoom(this.viewState.zoom + steps * ZOOM_STEP);
    if (zoom === this.viewState.zoom) return;
    this.setViewState({ ...this.viewState, zoom }, ZOOM_TRANSITION_MS);
  }

  resetView(): void {
    this.setViewState(this.fitted);
  }

  getViewState(): Readonly<ViewState> {
    return this.viewState;
  }

  private clampZoom(zoom: number): number {
    return Math.max(
      this.viewState.minZoom ?? -4,
      Math.min(this.viewState.maxZoom ?? 14, zoom)
    );
  }

  private setViewState(vs: ViewState, transitionMs = 0): void {
    this.viewState = vs;
    this.deck.setProps({
      viewState: transitionMs > 0 ? { ...vs, transitionDuration: transitionMs } : vs,
    });
    this.cb.onViewChange?.();
  }

  /**
   * pids actually inside the viewport, for enrichment priority (§3.3) and for
   * "analyze what I'm looking at". This has to be a real cull: when it
   * returned every point, prioritization and on-demand analysis both silently
   * degraded to "the whole library, in arbitrary order".
   */
  visiblePids(margin = 0.05): string[] {
    const s = this.state;
    if (!s) return [];
    const viewport = this.deck.getViewports()[0];
    if (!viewport) return s.tracks.map((t) => t.pid);

    const [ax, ay] = viewport.unproject([0, 0]);
    const [bx, by] = viewport.unproject([viewport.width, viewport.height]);
    const padX = Math.abs(bx - ax) * margin;
    const padY = Math.abs(by - ay) * margin;
    const minX = Math.min(ax, bx) - padX;
    const maxX = Math.max(ax, bx) + padX;
    const minY = Math.min(ay, by) - padY;
    const maxY = Math.max(ay, by) + padY;

    const out: string[] = [];
    for (let i = 0; i < s.tracks.length; i++) {
      const x = s.coords[i * 2];
      const y = s.coords[i * 2 + 1];
      if (x >= minX && x <= maxX && y >= minY && y <= maxY) out.push(s.tracks[i].pid);
    }
    return out;
  }

  /** Where the data is and how big it is, which framing is derived from. */
  private measureData(): void {
    if (!this.state) return;
    const { coords, tracks } = this.state;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < tracks.length; i++) {
      minX = Math.min(minX, coords[i * 2]);
      maxX = Math.max(maxX, coords[i * 2]);
      minY = Math.min(minY, coords[i * 2 + 1]);
      maxY = Math.max(maxY, coords[i * 2 + 1]);
    }
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const span = Math.max(maxX - minX, maxY - minY) || 1;
    this.span = span;
    this.dataBounds = { minX, minY, maxX, maxY };
    this.fitted = {
      ...this.viewState,
      target: [cx, cy, 0],
      zoom: Math.log2(600 / span),
    };
  }

  private color(track: Track, i: number): [number, number, number, number] {
    const s = this.state!;
    let rgb: RGB | null = null;
    switch (this.colorMode) {
      case "cluster":
        rgb = CLUSTER_COLORS[s.clusters[i] % CLUSTER_COLORS.length];
        break;
      case "collection": {
        const ci = track.collection ? this.collectionIndex.get(track.collection) : undefined;
        rgb = ci === undefined ? null : collectionColor(ci);
        break;
      }
      case "genre":
        rgb = track.genre ? genreColor(track.genre) : null;
        break;
      case "bpm":
        rgb = track.bpm
          ? bpmColor(bpmBin(track.bpm, this.bpmScale), this.bpmScale.count)
          : null;
        break;
      case "key": {
        const k = track.key ? parseCamelot(track.key) : null;
        rgb = k ? keyColor(k.num, k.minor) : null;
        break;
      }
      case "year": {
        const idx = track.year
          ? this.decadeIndex.get(decadeOf(track.year))
          : undefined;
        rgb = idx === undefined ? null : decadeColor(idx, this.decades.length);
        break;
      }
    }
    const solid = rgb ?? NO_DATA[this.theme];
    let alpha = rgb ? 200 : 90; // unknown values recede rather than compete
    if (this.dimUnhighlighted && !this.highlighted.has(track.pid)) alpha = 26;
    return [solid[0], solid[1], solid[2], alpha];
  }

  /** Bins of the active color mode, with live counts, for the on-map legend. */
  legendEntries(): LegendEntry[] {
    const s = this.state;
    if (!s) return [];
    const entries: LegendEntry[] = [];
    let missing = 0;

    switch (this.colorMode) {
      case "cluster": {
        const counts = new Map<number, number>();
        for (let i = 0; i < s.tracks.length; i++) {
          const c = s.clusters[i];
          counts.set(c, (counts.get(c) ?? 0) + 1);
        }
        for (const [c, count] of [...counts].sort((a, b) => b[1] - a[1])) {
          entries.push({
            label: this.clusterLabels.get(c) ?? `Cluster ${c + 1}`,
            color: CLUSTER_COLORS[c % CLUSTER_COLORS.length],
            count,
          });
        }
        return entries;
      }
      case "collection": {
        const counts = new Map<string, number>();
        for (const t of s.tracks) {
          if (t.collection && this.collectionIndex.has(t.collection))
            counts.set(t.collection, (counts.get(t.collection) ?? 0) + 1);
          else missing++;
        }
        this.collections.forEach((c, i) => {
          const count = counts.get(c.id);
          if (count) entries.push({ label: c.label, color: collectionColor(i), count });
        });
        break;
      }
      case "genre": {
        const counts = new Map<string, { count: number; labels: Set<string> }>();
        for (const track of s.tracks) {
          const genre = normalizeGenre(track.genre);
          if (!genre) {
            missing++;
            continue;
          }
          const entry = counts.get(genre.key) ?? { count: 0, labels: new Set<string>() };
          entry.count++;
          entry.labels.add(genre.label);
          counts.set(genre.key, entry);
        }
        for (const [key, entry] of counts) {
          entries.push({
            label: genreDisplayLabel(entry.labels),
            color: genreColor(key),
            count: entry.count,
          });
        }
        entries.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
        if (missing > 0) {
          entries.push({
            label: "Unknown genre",
            color: NO_DATA[this.theme],
            count: missing,
          });
        }
        return entries;
      }
      case "bpm": {
        const scale = this.bpmScale;
        const counts = new Array<number>(scale.count).fill(0);
        for (const t of s.tracks) {
          if (t.bpm) counts[bpmBin(t.bpm, scale)]++;
          else missing++;
        }
        counts.forEach((count, i) => {
          if (count > 0)
            entries.push({
              label: bpmBinLabel(i, scale),
              color: bpmColor(i, scale.count),
              count,
            });
        });
        break;
      }
      case "key": {
        const counts = new Map<string, number>();
        for (const t of s.tracks) {
          const k = t.key ? parseCamelot(t.key) : null;
          if (k) {
            const id = `${k.num}${k.minor ? "A" : "B"}`;
            counts.set(id, (counts.get(id) ?? 0) + 1);
          } else missing++;
        }
        for (let num = 1; num <= 12; num++) {
          for (const minor of [true, false]) {
            const id = `${num}${minor ? "A" : "B"}`;
            const count = counts.get(id);
            if (count) entries.push({ label: id, color: keyColor(num, minor), count });
          }
        }
        break;
      }
      case "year": {
        const counts = new Map<number, number>();
        for (const t of s.tracks) {
          if (t.year) {
            const d = decadeOf(t.year);
            counts.set(d, (counts.get(d) ?? 0) + 1);
          } else missing++;
        }
        this.decades.forEach((d, i) => {
          const count = counts.get(d);
          if (count)
            entries.push({
              label: `${d}s`,
              color: decadeColor(i, this.decades.length),
              count,
            });
        });
        break;
      }
    }

    if (missing > 0) {
      entries.push({ label: "no data", color: NO_DATA[this.theme], count: missing });
    }
    return entries;
  }

  update(): void {
    if (!this.state) return;
    this.refreshBpmScale();
    const s = this.state;
    this.showHeard = s.tracks.some((t) => t.timbre);
    const layers: Layer[] = [];

    // Gaps sit under the tracks so a click always prefers a real track.
    if (this.gaps.length > 0) {
      const gapRgb = GAP_COLOR[this.theme];
      const ends: [number, number][] = this.gaps.flatMap((g) => [g.a, g.b]);
      layers.push(
        // A gap is the space between two clusters, and a single circle cannot
        // say that: it reads as a hole with nothing on either side of it. The
        // connector is drawn between the two cluster centres, ringed at each
        // end, with the numbered marker in the middle of the emptiness.
        new LineLayer<GapMarker>({
          id: "gap-links",
          data: this.gaps,
          getSourcePosition: (g: GapMarker) => g.a,
          getTargetPosition: (g: GapMarker) => g.b,
          getColor: [gapRgb[0], gapRgb[1], gapRgb[2], 150],
          getWidth: 1.5,
          widthUnits: "pixels",
          updateTriggers: { getColor: [this.theme] },
        }),
        new ScatterplotLayer<[number, number]>({
          id: "gap-ends",
          data: ends,
          getPosition: (p: [number, number]) => p,
          getRadius: 7,
          radiusUnits: "pixels",
          stroked: true,
          filled: false,
          getLineColor: [gapRgb[0], gapRgb[1], gapRgb[2], 190],
          getLineWidth: 1.5,
          lineWidthUnits: "pixels",
          pickable: false,
          updateTriggers: { getLineColor: [this.theme] },
        }),
        // Pixel units, not embedding units: a marker sized in world space grew
        // with every zoom step until the markers swallowed each other, and it
        // was never measuring anything the connector does not already show.
        new ScatterplotLayer<GapMarker>({
          id: "gaps",
          data: this.gaps,
          getPosition: (g: GapMarker) => [g.x, g.y],
          getRadius: 13,
          radiusUnits: "pixels",
          stroked: true,
          filled: true,
          getFillColor: [gapRgb[0], gapRgb[1], gapRgb[2], 40],
          getLineColor: [gapRgb[0], gapRgb[1], gapRgb[2], 220],
          getLineWidth: 2,
          lineWidthUnits: "pixels",
          pickable: true,
          updateTriggers: { getFillColor: [this.theme], getLineColor: [this.theme] },
        }),
        new TextLayer<GapMarker>({
          id: "gap-labels",
          data: this.gaps,
          getPosition: (g: GapMarker) => [g.x, g.y],
          getText: (g: GapMarker) => String(g.index + 1),
          getSize: 13,
          sizeUnits: "pixels",
          getColor: [gapRgb[0], gapRgb[1], gapRgb[2], 255],
          getTextAnchor: "middle",
          getAlignmentBaseline: "center",
          fontFamily: "DM Mono, monospace",
          characterSet: "0123456789",
          pickable: false,
          updateTriggers: { getColor: [this.theme] },
        })
      );
    }

    layers.push(
      new ScatterplotLayer<Track>({
        id: "tracks",
        data: s.tracks,
        getPosition: (_t: Track, { index }) => [
          s.coords[index * 2],
          s.coords[index * 2 + 1],
        ],
        getFillColor: (t: Track, { index }) => {
          const c = this.color(t, index);
          // A track we've actually heard is solid; one placed from metadata
          // alone is left hollow, so the map never implies knowledge of a
          // sound it has never analyzed. Only drawn once anything has been
          // analyzed at all, or the whole map would read as provisional.
          if (!this.showHeard || t.timbre) return c;
          return [c[0], c[1], c[2], Math.round(c[3] * 0.12)];
        },
        stroked: true,
        getLineColor: (t: Track, { index }) => this.color(t, index),
        getLineWidth: () => 0.55,
        lineWidthUnits: "pixels",
        getRadius: (t: Track) =>
          this.highlighted.has(t.pid) && this.dimUnhighlighted ? 1.6 : 1.0,
        radiusUnits: "pixels",
        radiusScale: 2.4,
        pickable: true,
        updateTriggers: {
          getFillColor: [
            this.colorMode,
            this.theme,
            this.highlighted,
            this.dimUnhighlighted,
            this.showHeard,
            Date.now(),
          ],
          getLineColor: [this.colorMode, this.theme, Date.now()],
          getRadius: [this.highlighted, this.dimUnhighlighted],
        },
      })
    );

    layers.push(...this.externalLayers());

    this.baseLayers = layers;
    this.draw();
  }

  /**
   * Tracks that came from outside the library, ringed rather than filled.
   *
   * Two sets, drawn the same way on purpose. One is already in the library and
   * so is already a dot in the layer above; the ring is all it needs. The other
   * is a ghost, which is in no track array at all, so it needs the dot too.
   *
   * The ring never comes off. A projected position is an estimate made from the
   * crate the user owns: a record from a genre their library does not hold lands
   * beside the nearest thing it does hold rather than out in open space, and
   * analyzing its audio sharpens that estimate without turning it into a
   * measurement.
   */
  private externalLayers(): Layer[] {
    const s = this.state;
    const ringed: { pid: string; at: [number, number] }[] = [];
    if (s) {
      for (let i = 0; i < s.tracks.length; i++) {
        if (!s.tracks[i].external) continue;
        ringed.push({
          pid: s.tracks[i].pid,
          at: [s.coords[i * 2], s.coords[i * 2 + 1]],
        });
      }
    }
    for (const ghost of this.ghosts) {
      ringed.push({ pid: ghost.track.pid, at: [ghost.x, ghost.y] });
    }
    if (ringed.length === 0) return [];

    const [r, g, b] = EXTERNAL_COLOR[this.theme];
    const layers: Layer[] = [
      new ScatterplotLayer<(typeof ringed)[number]>({
        id: "external-rings",
        data: ringed,
        getPosition: (point) => point.at,
        getRadius: 5,
        radiusUnits: "pixels",
        stroked: true,
        filled: false,
        getLineColor: [r, g, b, 230],
        getLineWidth: 1.4,
        lineWidthUnits: "pixels",
        pickable: false,
        updateTriggers: { getPosition: ringed.length, getLineColor: [this.theme] },
      }),
    ];

    if (this.ghosts.length > 0) {
      layers.push(
        new ScatterplotLayer<GhostPoint>({
          id: "ghosts",
          data: this.ghosts,
          getPosition: (ghost: GhostPoint) => [ghost.x, ghost.y],
          getRadius: 2.2,
          radiusUnits: "pixels",
          radiusScale: 2.4,
          stroked: false,
          filled: true,
          getFillColor: [r, g, b, 235],
          pickable: true,
          updateTriggers: {
            getPosition: this.ghosts.map((ghost) => `${ghost.x},${ghost.y}`).join("|"),
            getFillColor: [this.theme],
          },
        })
      );
    }
    return layers;
  }

  private draw(): void {
    this.deck.setProps({
      layers: [
        ...this.baseLayers,
        ...this.selectedLayers(),
        ...this.hoverLayers(),
        ...this.lassoLayers(),
      ],
    });
  }

  /**
   * A fixed-pixel halo and four short ticks. Their anchor is the selected
   * track's world coordinate, so deck keeps them attached through camera and
   * layout changes without making any part of the marker pickable.
   */
  private selectedLayers(): Layer[] {
    if (!this.selectedPid) return [];
    // Ghosts included: "which dot am I looking at" is a question a projected
    // track raises more sharply than any other, not less.
    const found = this.locate(this.selectedPid);
    if (!found) return [];
    const at = found.at;
    const [r, g, b] = LASSO_COLOR[this.theme];
    const tickData = [
      { at, text: "—", offset: [-10, 0] as [number, number] },
      { at, text: "—", offset: [10, 0] as [number, number] },
      { at, text: "|", offset: [0, -10] as [number, number] },
      { at, text: "|", offset: [0, 10] as [number, number] },
    ];
    return [
      new ScatterplotLayer<[number, number]>({
        id: "selected-halo",
        data: [at],
        getPosition: (position: [number, number]) => position,
        getRadius: 7,
        radiusUnits: "pixels",
        filled: true,
        stroked: true,
        getFillColor: [r, g, b, 32],
        getLineColor: [r, g, b, 255],
        getLineWidth: 2,
        lineWidthUnits: "pixels",
        pickable: false,
      }),
      new TextLayer<(typeof tickData)[number]>({
        id: "selected-crosshair",
        data: tickData,
        getPosition: (tick) => tick.at,
        getText: (tick) => tick.text,
        getPixelOffset: (tick) => tick.offset,
        getSize: 11,
        sizeUnits: "pixels",
        getColor: [r, g, b, 255],
        getTextAnchor: "middle",
        getAlignmentBaseline: "center",
        fontFamily: "DM Mono, monospace",
        fontWeight: 500,
        fontSettings: { sdf: true },
        characterSet: ["—", "|"],
        outlineWidth: 1,
        outlineColor: this.theme === "dark" ? [12, 16, 24, 220] : [255, 252, 246, 220],
        pickable: false,
      }),
    ];
  }

  /**
   * deck reports a hover on every pointer move over the canvas, not only on
   * entering a dot, so this acts only when the dot underneath actually
   * changes: restarting on each move would hold the pulse at its first frame
   * and it would never breathe.
   */
  private setHovered(track: Track, index: number, at: [number, number]): void {
    if (track.pid === this.hovered?.pid) return;
    this.hovered = { pid: track.pid, index, track, at };
    this.startPulse();
    this.draw();
  }

  private clearHovered(): void {
    if (this.hovered === null) return;
    this.hovered = null;
    this.stopPulse();
    this.draw();
  }

  /**
   * One point animates, and only while something is hovered. Driving the pulse
   * through the main layer would re-upload every attribute of a few thousand
   * dots per frame.
   */
  private startPulse(): void {
    this.pulseStart = performance.now();
    if (this.pulseHandle !== null || this.reducedMotion?.matches) return;
    const tick = () => {
      this.pulseHandle = requestAnimationFrame(tick);
      this.draw();
    };
    this.pulseHandle = requestAnimationFrame(tick);
  }

  private stopPulse(): void {
    if (this.pulseHandle === null) return;
    cancelAnimationFrame(this.pulseHandle);
    this.pulseHandle = null;
  }

  /** The hovered dot, lifted above the map and breathing. */
  private hoverLayers(): Layer[] {
    const h = this.hovered;
    const s = this.state;
    if (!h || !s || h.index >= s.tracks.length) return [];
    const at = h.at;
    // A ghost has no row, so no colour mode applies to it; it keeps the same
    // violet it is ringed in, which is the point of the ring.
    const [r, g, b] =
      h.index < 0 ? EXTERNAL_COLOR[this.theme] : this.color(h.track, h.index);
    // Held at the top of the swell when motion is unwelcome: bigger, still.
    const swell = this.reducedMotion?.matches
      ? 1
      : 0.5 - 0.5 * Math.cos(((performance.now() - this.pulseStart) / PULSE_MS) * Math.PI * 2);

    return [
      new ScatterplotLayer<[number, number]>({
        id: "hover-glow",
        data: [at],
        getPosition: (p: [number, number]) => p,
        getRadius: 3.2 + 1.7 * swell,
        radiusUnits: "pixels",
        radiusScale: 2.4,
        stroked: false,
        filled: true,
        getFillColor: [r, g, b, Math.round(36 + 44 * swell)],
        pickable: false,
      }),
      new ScatterplotLayer<[number, number]>({
        id: "hover-dot",
        data: [at],
        getPosition: (p: [number, number]) => p,
        getRadius: 1.7 + 0.5 * swell,
        radiusUnits: "pixels",
        radiusScale: 2.4,
        stroked: true,
        filled: true,
        getFillColor: [r, g, b, 255],
        getLineColor: [r, g, b, 255],
        getLineWidth: 1,
        lineWidthUnits: "pixels",
        pickable: false,
      }),
    ];
  }
}
