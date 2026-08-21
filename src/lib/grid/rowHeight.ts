/**
 * The grid's row-height ("zoom") bounds and the clamp both gestures share.
 *
 * Two affordances change the same persisted `gridPrefs.rowHeight` — Ctrl+wheel
 * over the grid and the toolbar's +/- buttons — and each had its own copy of
 * `Math.min(40, Math.max(14, …))`. One place, so a future re-range can't apply
 * to only one of them.
 */

export const MIN_ROW_HEIGHT = 14;
export const MAX_ROW_HEIGHT = 40;

export function clampRowHeight(px: number): number {
  return Math.min(MAX_ROW_HEIGHT, Math.max(MIN_ROW_HEIGHT, px));
}
