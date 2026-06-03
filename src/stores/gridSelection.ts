/**
 * Live multi-row selection for the data grid, surfaced so the status bar
 * can show "N selected" without the grid and the bar being wired together
 * directly.
 *
 * Keyed by tab id: every table tab's grid reports its own selection, and the
 * status bar reads the entry for the active tab. A tab clears its entry on
 * unmount (close / disconnect) so the map never leaks stale counts.
 *
 * Selection itself still lives inside `DataGrid` (local `selectedKeys`);
 * this store only mirrors the *count* + the visible-row total for display.
 */

import { create } from "zustand";

interface TabSelection {
  /** Number of rows currently selected. */
  count: number;
  /** Visible rows in the grid (the current page, after client filtering). */
  total: number;
}

interface GridSelectionState {
  byTab: Record<string, TabSelection>;
  report: (tabId: string, count: number, total: number) => void;
  clear: (tabId: string) => void;
}

export const useGridSelection = create<GridSelectionState>((set) => ({
  byTab: {},
  report: (tabId, count, total) =>
    set((s) => {
      const prev = s.byTab[tabId];
      if (prev && prev.count === count && prev.total === total) return s;
      return { byTab: { ...s.byTab, [tabId]: { count, total } } };
    }),
  clear: (tabId) =>
    set((s) => {
      if (!(tabId in s.byTab)) return s;
      const next = { ...s.byTab };
      delete next[tabId];
      return { byTab: next };
    }),
}));
