/**
 * The data tab's page window: which rows this page covers, and whether either
 * arrow is live.
 *
 * Small, but the `canNext` rule is the kind of thing that quietly strands a user
 * on page 3 of a 900-row table, and while it lived inline in `TableDataTab` it
 * could not be tested at all. Everything here is pure.
 */

export interface PageWindow {
  /** 1-based index of the first row on this page. */
  from: number;
  /** 1-based index of the last row this page can hold, clamped to the total. */
  to: number;
  canPrev: boolean;
  canNext: boolean;
}

export interface PageWindowInput {
  offset: number;
  pageSize: number;
  /** Row count, or `null` while the count is in flight or after it failed. */
  total: number | null;
  /** Whether `total` came from the planner's statistics rather than a `COUNT`. */
  totalEstimated: boolean;
  /** Rows the current page actually returned. */
  rowsOnPage: number;
}

export function pageWindow({
  offset,
  pageSize,
  total,
  totalEstimated,
  rowsOnPage,
}: PageWindowInput): PageWindow {
  return {
    from: offset + 1,
    to: Math.min(offset + pageSize, total ?? offset + pageSize),
    canPrev: offset > 0,
    // With an *exact* total, stop at the last page. Otherwise — count still in
    // flight, failed, or only an *estimate*, which can undershoot the real row
    // count on stale statistics and must not strand the user before the true
    // end — fall back to "there might be more" whenever the current page came
    // back full. A short page then naturally disables Next at the real end.
    canNext:
      total !== null && !totalEstimated
        ? offset + pageSize < total
        : rowsOnPage >= pageSize,
  };
}

/** Offset of the previous page, never negative. */
export function prevOffset(offset: number, pageSize: number): number {
  return Math.max(0, offset - pageSize);
}

/** Offset of the next page. Guarding it is `canNext`'s job, not this one's. */
export function nextOffset(offset: number, pageSize: number): number {
  return offset + pageSize;
}
