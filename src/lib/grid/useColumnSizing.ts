/**
 * Column widths: the persisted map, the live drag, and the two numbers that
 * bound both.
 *
 * The drag deliberately does **not** use TanStack's `getResizeHandler()`. That
 * tracks the pointer through `columnSizingInfo.deltaOffset`, which re-renders
 * this whole unvirtualised table on every `mousemove` — with thousands of rows
 * that is what made a resize feel slow, and it is why the old implementation
 * needed a separate full-height guideline: the column itself could not cheaply
 * follow the pointer, so there was nothing live to look at. Instead this writes
 * the dragged `<th>`'s `style.width` directly; the table is `table-fixed`, so
 * per CSS the column widths come from the header row alone and one DOM write
 * reflows every matching cell natively, with zero React renders. State — and
 * therefore the `prefs.json` write — is touched exactly once, on release.
 *
 * Widths persist per *table* (`tableKey`), because a width is a fact about a
 * schema. An ad-hoc query result has no table to key on, so `persistKey` is
 * `null` there and its widths live for the session only. The persisted shape is
 * a sparse `{ columnName: px }`, which is TanStack's own `columnSizing` shape,
 * so it can be used as the initial state with no reshaping.
 */

import { useState } from "react";
import type { Updater } from "@tanstack/react-table";

import { usePreferences, selectGridPrefs } from "@/stores/preferences/preferences";

/** Narrowest a column may be dragged. */
export const MIN_COLUMN_WIDTH = 40;

/**
 * Width of the leading gutter column (row number / selection checkbox).
 * Lives here (rather than on `DataGrid` or `GridRow`) so both sides of the
 * header/body split can import it without a runtime circular dependency
 * between the two sibling components — it's where pinned columns' sticky
 * `left` offsets start counting from.
 */
export const GRID_GUTTER_WIDTH = 40;

/**
 * Ceiling for the auto-fit gesture. A column holding a long free-text value (a
 * serialised config, a description paragraph) would otherwise expand to several
 * thousand px and push every column after it off-screen, turning "let me read
 * this one value" into "I lost the rest of the row". Past this the value belongs
 * in the cell editor, and the user can still drag wider by hand.
 */
export const MAX_AUTOFIT_WIDTH = 900;

export function useColumnSizing({
  persistKey,
  updateGrid,
}: {
  /** `tableKey(schema, table)`, or `null` for a result grid that never persists. */
  persistKey: string | null;
  updateGrid: (patch: { columnWidths: Record<string, Record<string, number>> }) => void;
}) {
  const persistedColumnWidths = usePreferences(
    (s) => selectGridPrefs(s).columnWidths,
  );
  const [columnSizing, setColumnSizing] = useState<Record<string, number>>(
    () => (persistKey ? persistedColumnWidths[persistKey] ?? {} : {}),
  );

  function handleColumnSizingChange(
    updater: Updater<Record<string, number>>,
  ) {
    setColumnSizing((prev) => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      if (persistKey) {
        const grid = usePreferences.getState().prefs.grid;
        updateGrid({
          columnWidths: { ...grid.columnWidths, [persistKey]: next },
        });
      }
      return next;
    });
  }
  /**
   * Column currently being dragged to resize, if any — drives the header's
   * highlight + handle tint. Set on mousedown and cleared on mouseup, so it
   * changes exactly twice per drag (never per pixel), unlike the width
   * itself (see `startColumnResize` below).
   */
  const [resizingColId, setResizingColId] = useState<string | null>(null);
  /** Drag a column's header edge to resize it. See this module's header for
   *  why it writes the DOM directly instead of going through TanStack. */
  function startColumnResize(
    e: React.MouseEvent<HTMLDivElement>,
    colId: string,
    currentSize: number,
  ) {
    e.preventDefault();
    e.stopPropagation();
    const thEl = (e.currentTarget as HTMLElement).closest("th");
    if (!thEl) return;
    const th: HTMLTableCellElement = thEl;
    // Anchor to the column's logical size, not `getBoundingClientRect()`.
    // The table is `table-fixed` + `w-full`; when the declared column
    // widths don't fill the available width, the browser stretches them
    // to fit (CSS2.1 fixed-table-layout, extra-width distribution). That
    // makes the rendered `<th>` wider than its logical size, so measuring
    // the DOM here would bake the cosmetic stretch in as the new
    // committed width the instant the drag starts — the column visibly
    // jumps before the pointer even moves.
    const startWidth = currentSize;
    const startX = e.clientX;
    setResizingColId(colId);
    const prevCursor = document.body.style.cursor;
    const prevUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    function onMove(ev: MouseEvent) {
      const next = Math.max(
        MIN_COLUMN_WIDTH,
        Math.round(startWidth + (ev.clientX - startX)),
      );
      th.style.width = `${next}px`;
    }
    function onUp() {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevUserSelect;
      setResizingColId(null);
      const finalWidth = parseInt(th.style.width, 10);
      // A bare click (no `mousemove` at all) lands here with the width
      // untouched — notably the first click of the double-click that triggers
      // the auto-fit below. Committing then would write an identical width
      // into `columnSizing` (and through to `prefs.json`) for nothing, and
      // would make the auto-fit's own commit the *second* state update of one
      // gesture.
      if (!Number.isFinite(finalWidth) || finalWidth === startWidth) return;
      handleColumnSizingChange((prev) => ({ ...prev, [colId]: finalWidth }));
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  return {
    /** TanStack's `columnSizing` state. */
    columnSizing,
    /** Commit a width patch (used by the auto-fit gesture). */
    commitWidths: handleColumnSizingChange,
    /** Column being dragged, for the header's highlight. */
    resizingColId,
    startColumnResize,
  };
}
