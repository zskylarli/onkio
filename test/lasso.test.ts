import { describe, expect, it } from "vitest";
import {
  LASSO_MIN_STEP_PX,
  indicesInPolygon,
  pointInPolygon,
  polygonBounds,
  shouldAppend,
  type Point,
} from "../src/views/lasso";

const SQUARE: Point[] = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10],
];

/** Vertices level with the y of the points tested below, which is the trap. */
const DIAMOND: Point[] = [
  [5, 0],
  [10, 5],
  [5, 10],
  [0, 5],
];

describe("shouldAppend", () => {
  it("always takes the first point", () => {
    expect(shouldAppend([], [4, 9])).toBe(true);
  });

  it("ignores movement below the step, and takes it at the step", () => {
    const path: Point[] = [[100, 100]];
    expect(shouldAppend(path, [102, 100])).toBe(false);
    expect(shouldAppend(path, [100 + LASSO_MIN_STEP_PX, 100])).toBe(true);
    // Real distance, not either axis alone: 4 and 4 is 5.7 away and too close,
    // while 5 and 5 is 7.1 and far enough.
    expect(shouldAppend(path, [104, 104])).toBe(false);
    expect(shouldAppend(path, [105, 105])).toBe(true);
  });
});

describe("pointInPolygon", () => {
  it("separates inside from outside on a square", () => {
    expect(pointInPolygon(5, 5, SQUARE)).toBe(true);
    expect(pointInPolygon(-1, 5, SQUARE)).toBe(false);
    expect(pointInPolygon(11, 5, SQUARE)).toBe(false);
    expect(pointInPolygon(5, 20, SQUARE)).toBe(false);
  });

  it("does not count a vertex twice when the point is level with it", () => {
    // Both left and right vertices sit at y=5. Counting the two edges meeting at
    // one of them would flip the answer twice and report inside as outside.
    expect(pointInPolygon(5, 5, DIAMOND)).toBe(true);
    expect(pointInPolygon(2, 5, DIAMOND)).toBe(true);
    expect(pointInPolygon(12, 5, DIAMOND)).toBe(false);
    expect(pointInPolygon(-2, 5, DIAMOND)).toBe(false);
  });

  it("excludes the notch of a concave outline", () => {
    // A U: a gesture drawn around two clumps without the space between them.
    const u: Point[] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [7, 10],
      [7, 3],
      [3, 3],
      [3, 10],
      [0, 10],
    ];
    expect(pointInPolygon(1, 8, u)).toBe(true);
    expect(pointInPolygon(9, 8, u)).toBe(true);
    expect(pointInPolygon(5, 8, u)).toBe(false); // inside the notch
    expect(pointInPolygon(5, 1, u)).toBe(true); // under it
  });

  it("reads a loop crossed over itself as a hole, the even-odd rule", () => {
    // A freehand sweep that comes back over its own line says "inside" twice
    // about the overlap, and every drawing tool answers this the same way.
    const bowtie: Point[] = [
      [0, 0],
      [10, 10],
      [10, 0],
      [0, 10],
    ];
    expect(pointInPolygon(2, 5, bowtie)).toBe(true);
    expect(pointInPolygon(8, 5, bowtie)).toBe(true);
    expect(pointInPolygon(5, 1, bowtie)).toBe(false);
  });

  it("has no interior below three points", () => {
    expect(pointInPolygon(0, 0, [])).toBe(false);
    expect(pointInPolygon(0, 0, [[0, 0]])).toBe(false);
    expect(
      pointInPolygon(0, 0, [
        [-1, -1],
        [1, 1],
      ])
    ).toBe(false);
  });
});

describe("polygonBounds", () => {
  it("boxes the outline, and answers nothing for nothing", () => {
    expect(polygonBounds(DIAMOND)).toEqual({ minX: 0, minY: 0, maxX: 10, maxY: 10 });
    expect(polygonBounds([])).toBeNull();
  });
});

describe("indicesInPolygon", () => {
  const coords = new Float32Array([
    5, 5, // 0: inside
    -3, 5, // 1: outside, left
    9, 1, // 2: inside
    50, 50, // 3: far outside
    0.5, 9.5, // 4: inside, near a corner
  ]);

  it("returns the rows the outline caught, in row order", () => {
    expect(indicesInPolygon(coords, SQUARE)).toEqual([0, 2, 4]);
  });

  it("catches nothing when the outline is not one", () => {
    expect(indicesInPolygon(coords, [])).toEqual([]);
    expect(
      indicesInPolygon(coords, [
        [0, 0],
        [10, 10],
      ])
    ).toEqual([]);
  });

  it("stops at the row count it is given", () => {
    // The coords buffer outlives a layout: a stale tail must not be selectable.
    expect(indicesInPolygon(coords, SQUARE, 1)).toEqual([0]);
    expect(indicesInPolygon(coords, SQUARE, 3)).toEqual([0, 2]);
  });

  it("misses a region that holds nothing", () => {
    const elsewhere: Point[] = [
      [100, 100],
      [110, 100],
      [110, 110],
      [100, 110],
    ];
    expect(indicesInPolygon(coords, elsewhere)).toEqual([]);
  });
});
