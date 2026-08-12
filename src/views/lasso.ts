/**
 * Freehand selection over the embedding: the geometry only, with no deck.gl and
 * no DOM, so the part that decides which tracks a gesture caught is testable
 * without a browser.
 *
 * The path is captured in screen pixels but kept in world coordinates, because
 * the polygon has to keep meaning the same set of tracks whatever the zoom does
 * afterwards.
 */

export type Point = [number, number];

/**
 * Distance a pointer has to travel before the path grows, in screen pixels. A
 * pointermove fires per frame of a slow drag, and every captured vertex is an
 * edge that every point gets tested against, so a raw path makes the live count
 * quadratic in how slowly the gesture was drawn.
 */
export const LASSO_MIN_STEP_PX = 6;

/** Below a triangle there is no interior to be inside of. */
export const LASSO_MIN_POINTS = 3;

export function shouldAppend(
  path: readonly Point[],
  next: Point,
  minStep = LASSO_MIN_STEP_PX
): boolean {
  const last = path[path.length - 1];
  if (!last) return true;
  const dx = next[0] - last[0];
  const dy = next[1] - last[1];
  return dx * dx + dy * dy >= minStep * minStep;
}

/**
 * Ray crossing, counting how often a ray to the left of the point crosses the
 * outline. The edge test is half-open in y so that a point exactly level with a
 * vertex is counted for one of the two edges meeting there rather than both,
 * which would flip the answer twice and report a point inside as outside.
 *
 * A freehand loop that crosses itself is read even-odd: the overlap becomes a
 * hole. That is the same rule every drawing tool applies, and it is the honest
 * reading of a gesture that says "inside" twice.
 */
export function pointInPolygon(x: number, y: number, poly: readonly Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

export type Bounds = { minX: number; minY: number; maxX: number; maxY: number };

export function polygonBounds(poly: readonly Point[]): Bounds | null {
  if (poly.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of poly) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

/**
 * Row indices of an x,y pair array that fall inside the polygon, in row order.
 *
 * The bounding box is checked first because a lasso is nearly always a small
 * part of the map: it turns the per-point cost from one test per edge into two
 * comparisons for everything the gesture obviously missed.
 */
export function indicesInPolygon(
  coords: Float32Array,
  poly: readonly Point[],
  count = coords.length >> 1
): number[] {
  const out: number[] = [];
  if (poly.length < LASSO_MIN_POINTS) return out;
  const box = polygonBounds(poly)!;
  for (let i = 0; i < count; i++) {
    const x = coords[i * 2];
    const y = coords[i * 2 + 1];
    if (x < box.minX || x > box.maxX || y < box.minY || y > box.maxY) continue;
    if (pointInPolygon(x, y, poly)) out.push(i);
  }
  return out;
}
