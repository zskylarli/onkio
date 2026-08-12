/**
 * Placement for the sidebar's ⓘ tooltips.
 *
 * These cannot be positioned in CSS. `#sidebar` scrolls, which makes it a
 * clipping box, and a clipping box cuts off every descendant laid out inside
 * it no matter what its stacking order is: `z-index` moves a box in front of
 * its siblings, it does not move it out of its ancestor. A 280px popup in a
 * 300px panel therefore loses its right-hand edge, and `overflow-x: visible`
 * cannot rescue it either, because an element with one axis `visible` and the
 * other scrollable computes the visible axis to `auto`.
 *
 * The way out is `position: fixed`, whose containing block is the viewport
 * rather than the panel. That escapes the clip, and the cost is that the
 * position has to be measured here, from the trigger, whenever the popup
 * appears or anything moves underneath it.
 *
 * Showing and hiding stays in CSS, on `:hover` and `:focus-within`, so the
 * popups still open under the pointer and under the keyboard even if this
 * module never runs; all it adds is where they open.
 */

export type Box = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
};

export type Placement = { left: number; top: number };

/** Distance between the trigger and the popup. */
export const TIP_GAP = 6;
/** Distance kept clear of the viewport edges. */
export const TIP_MARGIN = 8;

/**
 * Where to put a popup of this size, given where its trigger currently is.
 *
 * Below the trigger and left-aligned with it by preference. A popup that would
 * run off the right is slid back inside rather than re-anchored to the
 * trigger's right edge, which keeps it beside the control it belongs to; one
 * that would run off the bottom flips above the trigger, which is the case at
 * the bottom of a scrolled panel. If it fits on neither side, it is clamped to
 * the viewport, because a tooltip half off screen is worse than one that
 * overlaps its own trigger.
 */
export function placeInfoPopup(
  anchor: Box,
  popup: { width: number; height: number },
  viewport: { width: number; height: number }
): Placement {
  let left = anchor.left;
  if (left + popup.width > viewport.width - TIP_MARGIN) {
    left = viewport.width - TIP_MARGIN - popup.width;
  }
  left = Math.max(TIP_MARGIN, left);

  let top = anchor.bottom + TIP_GAP;
  if (top + popup.height > viewport.height - TIP_MARGIN) {
    const above = anchor.top - TIP_GAP - popup.height;
    top =
      above >= TIP_MARGIN
        ? above
        : Math.max(TIP_MARGIN, viewport.height - TIP_MARGIN - popup.height);
  }
  return { left, top };
}

/**
 * Whether the trigger is still somewhere a popup can point at. A trigger
 * scrolled out of the panel, or in a panel that has been collapsed away, has no
 * position worth following, and a popup left floating beside where it used to be
 * is worse than no popup.
 */
export function isAnchorShowing(anchor: Box, clip: Box | null): boolean {
  if (anchor.width === 0 && anchor.height === 0) return false;
  if (!clip) return true;
  return anchor.bottom > clip.top && anchor.top < clip.bottom;
}

type OpenTip = { popup: HTMLElement; clip: HTMLElement | null };

/**
 * The popups currently open, keyed by trigger. Usually one, but hover and focus
 * are separate triggers: the pointer can rest on one ⓘ while the keyboard still
 * holds another, and CSS shows both, so both need following rather than one
 * being tracked and the other left wherever it was last put.
 */
const open = new Map<HTMLElement, OpenTip>();

/** Marks a popup whose trigger has gone, so CSS can keep it hidden while hovered. */
const DETACHED = "info-popup-detached";

function toBox(rect: DOMRect): Box {
  return {
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height,
  };
}

/** The nearest ancestor that clips, which is what the popup has to escape. */
function clippingAncestor(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const style = getComputedStyle(p);
    if (style.overflowX !== "visible" || style.overflowY !== "visible") return p;
  }
  return null;
}

function place(tip: HTMLElement, { popup, clip }: OpenTip): void {
  const anchor = toBox(tip.getBoundingClientRect());
  if (!isAnchorShowing(anchor, clip ? toBox(clip.getBoundingClientRect()) : null)) {
    popup.classList.add(DETACHED);
    return;
  }

  popup.classList.remove(DETACHED);
  // Measurable while still hidden: `visibility: hidden` keeps the box, and the
  // width is fixed in CSS, so the height already reflects the wrapped copy.
  const { left, top } = placeInfoPopup(
    anchor,
    { width: popup.offsetWidth, height: popup.offsetHeight },
    { width: window.innerWidth, height: window.innerHeight }
  );
  popup.style.left = `${left}px`;
  popup.style.top = `${top}px`;
}

/**
 * Re-measure whatever is open. Called for every move of the ground underneath
 * it: the panel scrolling, the window resizing, the panel being collapsed.
 */
export function repositionInfoPopups(): void {
  for (const [tip, entry] of open) place(tip, entry);
}

/** Shut the open popups without waiting for the pointer to leave, for Escape. */
export function dismissInfoPopups(): void {
  for (const { popup } of open.values()) popup.classList.add(DETACHED);
  open.clear();
}

export function initInfoTips(root: ParentNode = document): void {
  for (const tip of root.querySelectorAll<HTMLElement>(".info-tip")) {
    const popup = tip.querySelector<HTMLElement>(".info-popup");
    if (!popup) continue;

    const show = () => {
      const entry = { popup, clip: clippingAncestor(tip) };
      open.set(tip, entry);
      popup.classList.remove(DETACHED);
      place(tip, entry);
    };
    const leave = () => {
      // Pointer and keyboard are independent triggers, so losing one while the
      // other still holds this popup open only means measuring it again.
      if (tip.matches(":hover") || tip.matches(":focus-within")) {
        repositionInfoPopups();
        return;
      }
      open.delete(tip);
      popup.classList.remove(DETACHED);
      popup.style.removeProperty("left");
      popup.style.removeProperty("top");
    };

    tip.addEventListener("pointerenter", show);
    tip.addEventListener("pointerleave", leave);
    // Focus reaches the ⓘ button itself, which is what makes the copy readable
    // without a pointer.
    tip.addEventListener("focusin", show);
    tip.addEventListener("focusout", leave);
  }
}
