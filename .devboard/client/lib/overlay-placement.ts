/**
 * Geometry for the feedback overlay's floating panel: the rectangle measured
 * from a picked element, the anchor that opens the panel beside it, and the
 * clamp that keeps a panel inside the viewport. Placement depends on the
 * viewport and on the panel's measured height only, so no component state
 * lives here: a caller supplies the measurement.
 */

/** A rectangle in viewport coordinates, as an element reports it. */
export type Rect = { top: number; left: number; width: number; height: number };

/** A panel corner in viewport coordinates. */
export type Placement = { top: number; left: number };

/** The panel's fixed width, shared with the element that renders it. */
export const PANEL_WIDTH = 380;
/** The height assumed before the panel has been measured. */
export const PANEL_ESTIMATED_HEIGHT = 390;
/** The space between a picked element and the panel placed beside it. */
export const GAP = 12;
/** The smallest distance between a panel edge and the viewport edge. */
export const MARGIN = 8;

/** The viewport-space rectangle an element occupies right now. */
export function viewportRect(element: Element): Rect {
  const box = element.getBoundingClientRect();
  return { top: box.top, left: box.left, width: box.width, height: box.height };
}

/** Places the panel beside the element, flipping and clamping to stay visible. */
export function anchorFor(rect: Rect): Placement {
  const roomRight = window.innerWidth - rect.left - rect.width - GAP;
  const left =
    roomRight >= PANEL_WIDTH ? rect.left + rect.width + GAP : rect.left - PANEL_WIDTH - GAP;
  return {
    left: Math.min(Math.max(left, MARGIN), window.innerWidth - PANEL_WIDTH - MARGIN),
    top: Math.min(
      Math.max(rect.top, MARGIN),
      Math.max(MARGIN, window.innerHeight - PANEL_ESTIMATED_HEIGHT - MARGIN),
    ),
  };
}

/**
 * Keeps a dragged panel on screen, never under the viewport edge. `height` is
 * the panel's measured height, so a grown transcript stays inside the viewport.
 */
export function clampPlacement(top: number, left: number, height: number): Placement {
  return {
    left: Math.min(
      Math.max(left, MARGIN),
      Math.max(MARGIN, window.innerWidth - PANEL_WIDTH - MARGIN),
    ),
    top: Math.min(
      Math.max(top, MARGIN),
      Math.max(MARGIN, window.innerHeight - height - MARGIN),
    ),
  };
}
