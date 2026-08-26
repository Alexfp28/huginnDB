/**
 * Pinned ("frozen") columns: the persisted set and the toggle. Calqued on
 * `useColumnSizing` — same per-table persistence key, same session-only
 * fallback for ad-hoc query grids, same reason there's no resync effect on
 * `persistKey` changing: each table mounts its own `DataGrid` instance, so
 * the lazy `useState` initializer already picks up the right table's set.
 *
 * The set is unordered (membership only) — stacking order for the sticky
 * `left` offsets is always recomputed from the columns' own natural order,
 * never from the order columns were pinned in. See `DataGrid`/`GridRow`.
 */

import { useState } from "react";
import { usePreferences, selectGridPrefs } from "@/stores/preferences/preferences";

export function usePinnedColumns({
  persistKey,
  updateGrid,
}: {
  /** `tableKey(schema, table)`, or `null` for a result grid that never persists. */
  persistKey: string | null;
  updateGrid: (patch: { pinnedColumns: Record<string, string[]> }) => void;
}) {
  const persistedPinnedColumns = usePreferences(
    (s) => selectGridPrefs(s).pinnedColumns,
  );
  const [pinnedColumns, setPinnedColumns] = useState<string[]>(
    () => (persistKey ? (persistedPinnedColumns[persistKey] ?? []) : []),
  );

  function togglePin(colName: string) {
    setPinnedColumns((prev) => {
      const next = prev.includes(colName)
        ? prev.filter((n) => n !== colName)
        : [...prev, colName];
      if (persistKey) {
        const grid = usePreferences.getState().prefs.grid;
        updateGrid({
          pinnedColumns: { ...grid.pinnedColumns, [persistKey]: next },
        });
      }
      return next;
    });
  }

  return { pinnedColumns, togglePin };
}
