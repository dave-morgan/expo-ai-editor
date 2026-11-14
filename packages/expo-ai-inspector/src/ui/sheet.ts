/**
 * Bottom-sheet geometry, kept free of React Native so it can be unit-tested.
 * Detents are fractions of the window height; the middle one is the default.
 */
export const DETENTS = [0.25, 0.5, 0.75] as const;
export type Detent = (typeof DETENTS)[number];
const LOWEST: Detent = 0.25;
const HIGHEST: Detent = 0.75;
export const DEFAULT_DETENT: Detent = 0.5;

/** How far (ms) a fling's velocity is projected forward when choosing where to settle. */
const PROJECTION_MS = 160;
/** Dragging this far below the lowest detent (projected) dismisses the sheet. */
const DISMISS_OVERSHOOT = 72;

export function detentHeight(detent: Detent, windowHeight: number): number {
  return Math.round(windowHeight * detent);
}

/** Height while dragging: free between the detents, rubber-banded beyond them. */
export function dragHeight(start: number, dy: number, windowHeight: number): number {
  const min = detentHeight(LOWEST, windowHeight);
  const max = detentHeight(HIGHEST, windowHeight);
  const raw = start - dy;
  if (raw > max) return max + (raw - max) * 0.25;
  if (raw < min) return min - (min - raw) * 0.5;
  return raw;
}

/**
 * Where to settle after a drag. `velocity` is the gesture's vy in px/ms (positive = downward),
 * as React Native's PanResponder reports it. Returns `"dismiss"` for a decisive downward fling
 * released below the ¼ detent.
 */
export function settle(height: number, velocity: number, windowHeight: number): Detent | "dismiss" {
  const projected = height - velocity * PROJECTION_MS;
  const lowest = detentHeight(LOWEST, windowHeight);
  // Only a release already below ¼ can dismiss; a long fling from ¾ lands on ¼ instead.
  if (height < lowest && projected < lowest - DISMISS_OVERSHOOT) return "dismiss";
  let best: Detent = LOWEST;
  for (const detent of DETENTS) {
    if (
      Math.abs(detentHeight(detent, windowHeight) - projected) <
      Math.abs(detentHeight(best, windowHeight) - projected)
    )
      best = detent;
  }
  return best;
}

/** Next detent up or down, for the grabber's accessibility actions and taps. */
export function stepDetent(current: Detent, direction: 1 | -1): Detent {
  const index = DETENTS.indexOf(current) + direction;
  return DETENTS[Math.max(0, Math.min(DETENTS.length - 1, index))] ?? current;
}
