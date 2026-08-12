/**
 * The map has one highlight channel, and three controls want to drive it: a
 * search, suggestion mode and the playlist filter. One visual language for
 * "highlighted" is worth keeping, so they resolve by precedence here instead
 * of overwriting each other, and whatever is being held back is named in the
 * readout — a highlight that silently loses is indistinguishable from a bug.
 */

export type HighlightSource = "search" | "suggestions" | "playlist";

export type HighlightRequest = {
  source: HighlightSource;
  /** what is highlighted, already counted: "12 search matches" */
  label: string;
  /** the control, as the subject of a sentence: "the playlist filter" */
  name: string;
  pids: string[];
};

export type ActiveHighlight = {
  source: HighlightSource;
  pids: string[];
  /** readout naming what is highlighted, and what is paused to allow it */
  note: string;
};

function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** Candidates in precedence order; the first non-empty one wins. */
export function resolveHighlight(
  candidates: (HighlightRequest | null)[]
): ActiveHighlight | null {
  // An empty request is not eligible to win: dimming every point on behalf of
  // a control that selected nothing reads as a map that has broken.
  const active = candidates.filter(
    (c): c is HighlightRequest => c !== null && c.pids.length > 0
  );
  const winner = active[0];
  if (!winner) return null;

  const paused = active.slice(1);
  const names = joinNames(paused.map((p) => p.name));
  const note =
    `Highlighting ${winner.label}.` +
    (paused.length
      ? ` ${names[0].toUpperCase()}${names.slice(1)} ${paused.length === 1 ? "is" : "are"} paused while ${winner.name} is active.`
      : "");
  return { source: winner.source, pids: winner.pids, note };
}
