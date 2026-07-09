/**
 * Generic data grid used for both table data and ad-hoc query results.
 * Built on top of TanStack Table; rows are virtualised by the browser
 * via the parent's `overflow-auto`.
 *
 * Visual features:
 * - Numeric columns (int, float, decimal, …) are highlighted in amber.
 * - Clicking a row selects it (blue tint); clicking a cell opens the
 *   compact `CellPreview` panel at the bottom-right of the container.
 * - Double-clicking a cell opens the full Monaco `CellEditor` for
 *   multi-line viewing and, when editable, saving.
 *
 * Interaction features (when `editable`):
 * - Right-click on a cell shows a HeidiSQL-style context menu with
 *   copy / set-null / filter / row ops (insert, duplicate, delete).
 * - Server-side column filters render as removable chips above the
 *   grid. The pre-existing client text filter sits next to them and
 *   keeps acting on the current page only.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type Updater,
} from "@tanstack/react-table";
import { tableKey } from "@/stores/schema";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronDown,
  KeyRound,
  Loader2,
  Plus,
  X,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown";
import { cn, formatBitValue, isBitType, isNumericType } from "@/lib/utils";
import { usePreferences, selectGridPrefs } from "@/stores/preferences";
import type {
  CellValue,
  ColumnFilter,
  ColumnInfo,
  ColumnMeta,
  DraftCell,
  DraftRow,
  QueryResult,
  SortSpec,
} from "@/types";
import { BitInput } from "@/components/BitInput";
import { CellEditor } from "@/components/CellEditor";
import { CellInput } from "@/components/CellInput";
import { CellPreview } from "@/components/CellPreview";
import { FkCombobox } from "@/components/ui/fk-combobox";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  toJson as rowToJson,
  toSqlInsert as rowToSqlInsert,
  toSqlUpdate as rowToSqlUpdate,
} from "@/lib/copyFormats";
import { useCellEditor } from "@/stores/cellEditor";
import { openSideEditor, isSideEditorOpen } from "@/lib/dockview";
import type { Driver } from "@/types";

interface Props {
  result: QueryResult;
  editable?: boolean;
  /**
   * Connection + table coordinates. When set, draft-row cells whose
   * column carries a single-column FK constraint render a searchable
   * combobox of valid referenced values instead of a plain text input.
   */
  connectionId?: string;
  tableSchema?: string;
  tableName?: string;
  /**
   * Driver of the underlying connection. Used purely to make the
   * "Copy as ▸ SQL …" snippets quote identifiers correctly
   * (MySQL backticks vs PG/SQLite double quotes). Optional because
   * query-result grids may not know which connection a row came from
   * — the snippets still render with sensible defaults.
   */
  driver?: Driver;
  /**
   * Names of every column that participates in the table's primary key,
   * in catalog order. The grid uses them (a) to skip PK columns in the
   * "Copy as UPDATE" SET clause and (b) to AND-join the WHERE predicate
   * — keeping the snippet safe on composite-PK tables. When absent or
   * empty, UPDATE renders with `<pk> = <value>` placeholders so the
   * user notices.
   */
  pkColumnNames?: string[];
  /** Names of columns that are a single-column FOREIGN KEY, for the header
   *  key icon (HeidiSQL-style). Purely presentational. */
  fkColumnNames?: string[];
  /**
   * "Go to referenced row" — invoked when the user Ctrl/Cmd+clicks (or picks
   * the context-menu item on) a cell whose column is a single-column FK, with
   * the FK value. The parent resolves the referenced table from its column
   * metadata and opens it filtered to that value (IDE "go to definition").
   * Only the cells whose column carries `referenced_table` (known via
   * `draftColumns`/`columnInfoByName`) trigger it.
   */
  onNavigateFk?: (columnName: string, value: CellValue) => void;
  /**
   * Cell edit callback. Receives the **full row values array** (not a
   * row index) so the parent can resolve identity (PK value) directly
   * from the data, immune to client-side filtering reshuffling
   * positions. The previous index-based contract silently corrupted
   * data when `globalFilter` was active because the index referred to
   * the filtered display order while the parent read from the
   * unfiltered backend page — see plan A1.
   */
  onCellSave?: (
    rowValues: CellValue[],
    columnName: string,
    value: string | null,
  ) => Promise<void>;
  /** Header click handler. `additive` is true when Ctrl/Cmd was held, which
   *  the parent uses to build a multi-column sort. */
  onSortChange?: (column: string, additive: boolean) => void;
  /** Active multi-column sort, in precedence order. */
  sort?: SortSpec[];
  /**
   * Applied filter — drives the client-side `visibleRows` pass and is
   * what the grid believes is the *current* search. For tabs that
   * commit explicitly (table data), pass the committed/applied value
   * here, NOT the uncommitted toolbar input — otherwise the rows
   * actually rendered diverge from the backend page that fed
   * `result.rows`, which silently corrupts cell-save UX (the row the
   * user perceives as "above" can become a different backend row after
   * a refetch). Query-result tabs that have no backend filter just
   * pass the live input value.
   */
  globalFilter?: string;
  /**
   * Optional value shown in the toolbar search box. Use it when the
   * uncommitted draft (what the user is typing) is intentionally
   * different from the applied filter — i.e. table-data tabs that
   * only refetch on Enter. When absent the input mirrors
   * `globalFilter`.
   */
  filterInput?: string;
  onGlobalFilterChange?: (v: string) => void;
  /**
   * Called when the user explicitly commits the current search — by
   * pressing Enter, picking an entry from the history dropdown, or
   * hitting the clear (×) button. Receives the value being committed
   * so callers don't depend on the not-yet-flushed `onChange` state.
   */
  onGlobalFilterSubmit?: (v: string) => void;
  /**
   * Newest-first list of recent search queries shown in a small
   * dropdown next to the filter input. Empty list → no dropdown button.
   */
  searchHistory?: string[];

  /** Server-side column filters; rendered as chips. */
  serverFilters?: ColumnFilter[];
  onAddFilter?: (f: ColumnFilter) => void;
  onRemoveFilter?: (index: number) => void;

  /**
   * Row-level mutations. Only wired when the table has a PK. Like
   * `onCellSave`, these receive the row's full values array to resolve
   * identity safely under client filtering.
   */
  onInsertRow?: () => void;
  onDuplicateRow?: (rowValues: CellValue[]) => void;
  onDeleteRow?: (rowValues: CellValue[]) => void;
  /**
   * Delete several rows at once (the multi-selection path). Receives one
   * values array per selected row. Wired only when the table has a PK; the
   * parent shows the same confirmation dialog used for single-row delete.
   */
  onBulkDelete?: (rows: CellValue[][]) => void;
  /**
   * Stable identity key for a row, derived from its primary key by the
   * parent (`JSON.stringify(pkValues)`). Returns `null` when the row has no
   * resolvable PK, which disables selection — consistent with the existing
   * editable/delete gate. Identity is data-derived (not the display index)
   * so a selection survives refetch / sort / client filtering (gotcha #7).
   */
  getRowKey?: (rowValues: CellValue[]) => string | null;

  /**
   * Reports the live multi-selection count and the visible-row total
   * whenever either changes. Used by the status bar (via the parent, which
   * owns the tab id) to show "N selected". Selection itself stays internal.
   */
  onSelectionChange?: (count: number, total: number) => void;

  /**
   * Inline draft row state (insert / duplicate). When set, an extra
   * editable row is rendered at the top of the grid. Schema-level column
   * metadata is needed so the inputs can show PK / NOT NULL hints.
   */
  draftRow?: DraftRow | null;
  draftColumns?: ColumnInfo[];
  onDraftCellChange?: (column: string, cell: DraftCell) => void;
  onDraftCommit?: () => void;
  onDraftCancel?: () => void;

  /**
   * Optional content rendered at the START of the toolbar row (before the
   * search box), with a divider after it. TableDataTab folds its breadcrumb +
   * refresh + zoom controls in here so a table tab shows ONE toolbar instead
   * of two stacked bars. Query-result tabs omit it.
   */
  toolbarLeading?: ReactNode;
  /**
   * When true, dims the grid body and shows a spinner overlay — used while a
   * refetch is in flight but stale rows are still on screen, so the grid
   * doesn't look frozen. Initial load (no rows yet) is handled by the caller's
   * skeleton placeholder instead.
   */
  loading?: boolean;
}

/** Render a cell value as a plain string for display and search. */
function formatValue(v: CellValue): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/**
 * Quote a value into a SQL literal for "copy with column name". Strings
 * use single quotes with doubling for escapes; numbers and booleans are
 * inlined as-is; null becomes `NULL`. Best-effort — purely for clipboard
 * convenience, never executed.
 */
function sqlLiteral(v: CellValue): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return `'${s.replace(/'/g, "''")}'`;
}

interface SelectedCell {
  /**
   * Full row values array. We carry the row payload (not its display
   * index) so saves stay correct when the visible order diverges from
   * the underlying `result.rows` page — e.g. while `globalFilter` is
   * active.
   */
  rowValues: CellValue[];
  colIndex: number;
  column: ColumnMeta;
  value: CellValue;
}

const FILTER_LABEL: Record<ColumnFilter["op"], string> = {
  eq: "=",
  ne: "<>",
  is_null: "IS NULL",
  is_not_null: "IS NOT NULL",
};

export function DataGrid({
  result,
  editable,
  connectionId,
  tableSchema,
  tableName,
  driver,
  pkColumnNames,
  onCellSave,
  onSortChange,
  sort,
  fkColumnNames,
  onNavigateFk,
  globalFilter,
  filterInput,
  onGlobalFilterChange,
  onGlobalFilterSubmit,
  searchHistory,
  serverFilters,
  onAddFilter,
  onRemoveFilter,
  onInsertRow,
  onDuplicateRow,
  onDeleteRow,
  onBulkDelete,
  getRowKey,
  onSelectionChange,
  draftRow,
  draftColumns,
  onDraftCellChange,
  onDraftCommit,
  onDraftCancel,
  toolbarLeading,
  loading,
}: Props) {
  const { t } = useTranslation();
  const draftRowRef = useRef<HTMLTableRowElement | null>(null);
  // Holds either the plain text input or the FkCombobox trigger, so any
  // editable element type can claim the autofocus slot.
  const firstDraftInputRef = useRef<HTMLElement | null>(null);

  /**
   * Focus the first editable draft cell when a draft is created so the
   * user can start typing immediately. Re-runs only when a new draft
   * appears (identity-stable boolean).
   */
  const draftActive = !!draftRow;
  useEffect(() => {
    if (draftActive) {
      // Defer until the row is mounted.
      const id = requestAnimationFrame(() => {
        firstDraftInputRef.current?.focus();
      });
      return () => cancelAnimationFrame(id);
    }
  }, [draftActive]);

  /** Full Monaco editor (opened via CellPreview F11 or double-click). */
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorTarget, setEditorTarget] = useState<{
    rowValues: CellValue[];
    column: ColumnMeta;
    value: string;
  } | null>(null);

  /**
   * Inline foreign-key editor anchored to a single cell. Activated on
   * double-click when the column carries a single-column FK constraint;
   * supersedes the Monaco dialog for that path so the user picks a
   * value without losing visual context. Tracked by row identity (the
   * values array) instead of a display index so an FK edit survives
   * sort/filter changes between activation and commit.
   */
  const [fkEditCell, setFkEditCell] = useState<{
    rowValues: CellValue[];
    column: ColumnMeta;
  } | null>(null);
  /**
   * Inline single-cell editor anchored to a cell (double-click on an
   * editable, non-FK column). Reuses the draft-row `CellInput` so editing an
   * existing value feels identical to typing a new one. `value` is the live
   * draft; `original` is the value at activation, used to skip a no-op save on
   * blur (notably when escalating to the modal via the expand button).
   * Tracked by row identity (the values array, gotcha #7), not a display
   * index, so it survives sort/filter reshuffles between open and commit.
   */
  const [inlineEdit, setInlineEdit] = useState<{
    rowValues: CellValue[];
    column: ColumnMeta;
    value: string | null;
    original: string | null;
  } | null>(null);
  /** Fast lookup of column metadata by name for FK detection in the cell renderer. */
  const columnInfoByName = useMemo(() => {
    const m = new Map<string, ColumnInfo>();
    for (const c of draftColumns ?? []) m.set(c.name, c);
    return m;
  }, [draftColumns]);

  // Escape exits the inline FK editor without committing. Click-outside
  // dismissal is handled by the combobox itself, but clicks land on the
  // panel's trigger button before the close listener fires; for that
  // path the user can press Esc or pick another cell.
  useEffect(() => {
    if (!fkEditCell) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setFkEditCell(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fkEditCell]);

  /** Compact preview panel state. Cleared when the user clicks away or presses Esc. */
  const [selectedCell, setSelectedCell] = useState<SelectedCell | null>(null);
  /** Row index of the currently selected row (blue highlight). */
  const [selectedRowIndex, setSelectedRowIndex] = useState<number | null>(null);
  /**
   * Keyboard-navigable active cell — `{ r, c }` indexing the visible row model
   * and the visible leaf columns. Drives the inset focus ring and arrow / Home
   * / End / Enter navigation; the grid was otherwise mouse-only, which
   * contradicts the app's keyboard-first identity. Set on cell click (so the
   * keyboard picks up where the mouse left off) and cleared on Escape.
   */
  const [activeCell, setActiveCell] = useState<{ r: number; c: number } | null>(
    null,
  );

  /**
   * Multi-row selection. Keyed by the parent-supplied stable row key
   * (PK-derived) rather than display index or array reference, so a selection
   * survives refetch / sort / client filtering (gotcha #7). Only meaningful
   * when `getRowKey` is wired (i.e. the table has a PK); otherwise the
   * checkbox column is hidden and bulk actions never appear.
   */
  const selectionEnabled = !!getRowKey;
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  /** Anchor for Shift-click range selection (the last row toggled). */
  const lastClickedKeyRef = useRef<string | null>(null);

  /**
   * Optional client-side text filter over the rows already in memory.
   * Used by query results (where there is no underlying table to
   * refetch from). `TableDataTab` instead pushes the same `globalFilter`
   * value to the backend, so a second pass here is a harmless no-op.
   */
  const visibleRows = useMemo(() => {
    if (!globalFilter) return result.rows;
    const q = globalFilter.toLowerCase();
    return result.rows.filter((r) =>
      r.some((c) => formatValue(c).toLowerCase().includes(q)),
    );
  }, [result.rows, globalFilter]);

  /**
   * Visible rows paired with their stable key (or null when unresolvable),
   * memoised so the per-row render and the range-selection math read a stable
   * list. `null`-keyed rows simply can't be selected.
   */
  const keyedVisibleRows = useMemo(() => {
    if (!getRowKey) return [] as { key: string | null; row: CellValue[] }[];
    return visibleRows.map((row) => ({ key: getRowKey(row), row }));
  }, [visibleRows, getRowKey]);

  /**
   * The currently-selected rows, as values arrays, in visible order. Drives
   * the bulk context-menu actions and the selection count. Memoised on the
   * selection set + the visible rows so its identity is stable across
   * unrelated renders.
   */
  const selectedRows = useMemo(() => {
    if (selectedKeys.size === 0) return [] as CellValue[][];
    return keyedVisibleRows
      .filter((r) => r.key !== null && selectedKeys.has(r.key))
      .map((r) => r.row);
  }, [keyedVisibleRows, selectedKeys]);

  /**
   * Mirror the selection count + visible-row total up to the parent (which
   * forwards it to the status bar keyed by tab id). Effect, not a render-time
   * call, so we never set external state during render.
   */
  useEffect(() => {
    onSelectionChange?.(selectedRows.length, keyedVisibleRows.length);
  }, [onSelectionChange, selectedRows.length, keyedVisibleRows.length]);

  /**
   * Prune selected keys that no longer correspond to a visible row (e.g.
   * after a refetch that dropped rows, or a filter narrowing). Keeps the
   * checkbox header's "all selected" state honest and avoids deleting rows
   * the user can no longer see. Runs only when the visible key set changes.
   */
  useEffect(() => {
    if (selectedKeys.size === 0) return;
    const live = new Set(
      keyedVisibleRows.map((r) => r.key).filter((k): k is string => k !== null),
    );
    let changed = false;
    const next = new Set<string>();
    for (const k of selectedKeys) {
      if (live.has(k)) next.add(k);
      else changed = true;
    }
    if (changed) setSelectedKeys(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyedVisibleRows]);

  /** Toggle a single row key (Ctrl/Cmd-click, or plain checkbox click). */
  function toggleRowKey(key: string) {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    lastClickedKeyRef.current = key;
  }

  /** Select the contiguous range (in visible order) between the anchor and
   *  `key`, additively. Falls back to a single toggle when there's no anchor. */
  function selectRangeTo(key: string) {
    const anchor = lastClickedKeyRef.current;
    if (!anchor) {
      toggleRowKey(key);
      return;
    }
    const keys = keyedVisibleRows
      .map((r) => r.key)
      .filter((k): k is string => k !== null);
    const a = keys.indexOf(anchor);
    const b = keys.indexOf(key);
    if (a < 0 || b < 0) {
      toggleRowKey(key);
      return;
    }
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      for (let i = lo; i <= hi; i++) next.add(keys[i]);
      return next;
    });
  }

  /**
   * OS-explorer-style selection from a row/cell click. Ctrl/Cmd-click toggles
   * a single row; Shift-click extends a contiguous range from the anchor; a
   * plain click clears any multi-selection (keeping the single-row blue
   * highlight, handled separately by `setSelectedRowIndex`). No-op for rows
   * without a resolvable key.
   */
  function applyRowSelectionClick(
    rowKey: string | null,
    e: React.MouseEvent,
  ) {
    if (rowKey === null) return;
    if (e.ctrlKey || e.metaKey) {
      toggleRowKey(rowKey);
    } else if (e.shiftKey) {
      selectRangeTo(rowKey);
    } else if (selectedKeys.size > 0) {
      setSelectedKeys(new Set());
      lastClickedKeyRef.current = rowKey;
    } else {
      lastClickedKeyRef.current = rowKey;
    }
  }

  /**
   * Header tri-state select-all state, computed over the *visible* rows that
   * have a resolvable key. `allSelected` when every selectable visible row is
   * in the set; `someSelected` drives the checkbox's indeterminate dash.
   * Toggling only ever touches the visible set — never rows filtered out of
   * view (mirrors the prune effect above that keeps the set honest).
   */
  const selectableVisibleKeys = useMemo(
    () =>
      keyedVisibleRows
        .map((r) => r.key)
        .filter((k): k is string => k !== null),
    [keyedVisibleRows],
  );
  const allSelected =
    selectableVisibleKeys.length > 0 &&
    selectableVisibleKeys.every((k) => selectedKeys.has(k));
  const someSelected = selectedKeys.size > 0 && !allSelected;

  /** Select-all / clear from the header checkbox. */
  function toggleSelectAll() {
    setSelectedKeys((prev) => {
      const everyVisibleSelected =
        prev.size > 0 && selectableVisibleKeys.every((k) => prev.has(k));
      return everyVisibleSelected ? new Set() : new Set(selectableVisibleKeys);
    });
    lastClickedKeyRef.current = null;
  }

  /**
   * Pre-computed set of column names that carry numeric data.
   * Recomputed only when the column list changes (not on every row render).
   */
  const numericColNames = useMemo(
    () =>
      new Set(
        result.columns
          .filter((c) => isNumericType(c.data_type))
          .map((c) => c.name),
      ),
    [result.columns],
  );

  /**
   * Column names whose type is MySQL `BIT`. Rendered through the user's
   * `bitDisplay` preference (true/false vs 0/1) instead of the raw number.
   */
  const bitColNames = useMemo(
    () =>
      new Set(
        result.columns.filter((c) => isBitType(c.data_type)).map((c) => c.name),
      ),
    [result.columns],
  );
  const bitDisplay = usePreferences((s) => selectGridPrefs(s).bitDisplay);
  /** Default surface for the heavyweight editor (modal vs docked side panel).
   *  Subscribed as a primitive so the selector stays reference-stable. */
  const cellEditorMode = usePreferences((s) => s.prefs.ui.cellEditorMode);
  // Grid display prefs, each subscribed as a primitive (gotcha #1).
  const nullDisplay = usePreferences((s) => selectGridPrefs(s).nullDisplay);
  const truncateLongTextAt = usePreferences(
    (s) => selectGridPrefs(s).truncateLongTextAt,
  );
  const zebraStripes = usePreferences((s) => selectGridPrefs(s).zebraStripes);
  const stickyHeader = usePreferences((s) => selectGridPrefs(s).stickyHeader);
  const cellPreview = usePreferences((s) => selectGridPrefs(s).cellPreview);

  /**
   * Persisted grid "zoom" (HeidiSQL-style). A single px row-height drives
   * cell height, padding and font-size together. Subscribed as a primitive
   * so the selector stays reference-stable (see the theme-store banner /
   * CONTRIBUTING "Zustand selectors" rule).
   */
  const rowHeight = usePreferences((s) => selectGridPrefs(s).rowHeight);
  const updateGrid = usePreferences((s) => s.updateGrid);

  /**
   * Persisted column widths are keyed by table (`tableKey`), since widths
   * are inherently per-schema. Ad-hoc query result grids (no `tableName` —
   * see `QueryEditorTab`) never persist: they resize in-session only. The
   * persisted map is a sparse `{ columnName: px }` — TanStack's own
   * `columnSizing` state has the same shape (only explicitly-resized
   * columns appear; everything else falls back to the column's default
   * size), so it can be used directly as the initial state with no
   * reshaping.
   */
  const persistKey = tableName ? tableKey(tableSchema, tableName) : null;
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
   * Inline styles derived from `rowHeight`. Memoised so the object identity
   * is stable across the per-cell render loop (it feeds hundreds of cells).
   * Font-size tracks the row height but is clamped to stay legible.
   */
  const { cellStyle, headerStyle } = useMemo(() => {
    const fontSize = Math.min(22, Math.max(10, Math.round(rowHeight * 0.46)));
    const padY = Math.max(1, Math.round((rowHeight - fontSize) / 2));
    return {
      cellStyle: {
        fontSize,
        paddingTop: padY,
        paddingBottom: padY,
      } as React.CSSProperties,
      headerStyle: {
        fontSize: Math.max(9, fontSize - 2),
      } as React.CSSProperties,
    };
  }, [rowHeight]);

  /**
   * Ctrl + mouse-wheel over the grid zooms the rows in/out, like a code
   * editor. Bound via a non-passive native listener so `preventDefault`
   * actually suppresses the browser's page-zoom; a JSX `onWheel` handler is
   * passive by default and cannot. Persistence is handled by the prefs store
   * (debounced write), so we only push the clamped row height.
   */
  const scrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    function onWheel(e: WheelEvent) {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const step = e.deltaY < 0 ? 2 : -2;
      const next = Math.min(40, Math.max(14, rowHeight + step));
      if (next !== rowHeight) updateGrid({ rowHeight: next });
    }
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [rowHeight, updateGrid]);

  /**
   * Backend column index keyed by name. The cell render loop walks
   * `row.getVisibleCells()` whose position index is TanStack's *visible*
   * order — if a future change ever introduces column reordering /
   * hiding, that index would silently diverge from `result.columns`.
   * Resolving by `cell.column.id` (which we set to `col.name`) keeps
   * cell metadata and underlying row values aligned regardless of
   * display order.
   */
  const columnIndexByName = useMemo(() => {
    const m = new Map<string, number>();
    result.columns.forEach((c, i) => m.set(c.name, i));
    return m;
  }, [result.columns]);

  // Key-icon lookups for the header (PK = amber, FK = sky), HeidiSQL-style.
  const pkNameSet = useMemo(
    () => new Set(pkColumnNames ?? []),
    [pkColumnNames],
  );
  const fkNameSet = useMemo(
    () => new Set(fkColumnNames ?? []),
    [fkColumnNames],
  );

  const columns = useMemo<ColumnDef<CellValue[]>[]>(
    () =>
      result.columns.map((col, idx) => ({
        id: col.name,
        header: () => {
          // Sort level for this column (-1 when not sorted). The arrow shows
          // the direction; the number only renders for a multi-column sort,
          // where precedence matters.
          const sortIndex = sort?.findIndex((s) => s.column === col.name) ?? -1;
          const active = sortIndex >= 0;
          const spec = active ? sort![sortIndex] : null;
          const showRank = active && (sort?.length ?? 0) > 1;
          return (
            <button
              className="group/sort -mx-1 flex w-full items-center gap-1 rounded-sm px-1 hover:bg-accent/50 hover:text-foreground"
              onClick={(e) =>
                onSortChange?.(col.name, e.ctrlKey || e.metaKey)
              }
              title={
                showRank
                  ? `Sort level ${sortIndex + 1} — Ctrl/Cmd+click to add a column`
                  : "Click to sort — Ctrl/Cmd+click to add a column"
              }
            >
              {pkNameSet.has(col.name) && (
                <KeyRound
                  className="h-3 w-3 shrink-0 text-pk"
                  aria-label="primary key"
                />
              )}
              {fkNameSet.has(col.name) && (
                <KeyRound
                  className="h-3 w-3 shrink-0 text-fk"
                  aria-label="foreign key"
                />
              )}
              <span className="truncate">{col.name}</span>
              <span className="text-3xs uppercase text-muted-foreground/50">
                {col.data_type}
              </span>
              {active ? (
                <span className="ml-auto flex shrink-0 items-center text-brand">
                  {spec!.desc ? (
                    <ArrowDown className="h-3 w-3" />
                  ) : (
                    <ArrowUp className="h-3 w-3" />
                  )}
                  {showRank && (
                    <span className="ml-0.5 text-3xs font-semibold tabular-nums">
                      {sortIndex + 1}
                    </span>
                  )}
                </span>
              ) : (
                // Persistent (not near-invisible) glyph that brightens on
                // header hover so sortability is discoverable at a glance.
                <ArrowUpDown className="ml-auto h-3 w-3 shrink-0 opacity-40 transition-opacity group-hover/sort:opacity-100" />
              )}
            </button>
          );
        },
        accessorFn: (row) => row[idx],
        cell: (info) => {
          const v = info.getValue() as CellValue;
          const rowValues = info.row.original as CellValue[];
          const colInfo = columnInfoByName.get(col.name);
          // FK edit identity is the row's value array (referential
          // identity from TanStack's row.original) — stable across
          // sort / filter reshuffles between activation and commit.
          const editingFk =
            fkEditCell?.rowValues === rowValues &&
            fkEditCell.column.name === col.name;
          if (editingFk && connectionId && colInfo?.referenced_table) {
            // Inline overlay: replace the read-only cell content with a
            // combobox of valid referenced values. The popover panel
            // hangs below this anchor so the user keeps the row in view.
            return (
              <FkCombobox
                connectionId={connectionId}
                refSchema={
                  colInfo.referenced_schema ?? tableSchema ?? undefined
                }
                refTable={colInfo.referenced_table}
                refColumn={colInfo.referenced_column ?? "id"}
                value={v === null ? null : formatValue(v)}
                nullable={colInfo.nullable}
                onChange={(picked) => {
                  setFkEditCell(null);
                  // Skip the round-trip if the user picks the same value
                  // that was already there (common when they just open
                  // the dropdown and dismiss).
                  const current = v === null ? null : formatValue(v);
                  if (picked === current) return;
                  onCellSave?.(rowValues, col.name, picked).catch(() => {});
                }}
              />
            );
          }
          // Inline single-cell editor (double-click on an editable, non-FK
          // cell). Same identity rule as the FK overlay above.
          const editingInline =
            inlineEdit?.rowValues === rowValues &&
            inlineEdit.column.name === col.name;
          if (editingInline && inlineEdit) {
            const commit = () => {
              const { value, original, rowValues: rv, column } = inlineEdit;
              setInlineEdit(null);
              // No-op when unchanged — also makes the blur that fires while
              // escalating to the modal harmless (expand leaves value as-is).
              if (value === original) return;
              onCellSave?.(rv, column.name, value).catch(() => {});
            };
            const expand = () => {
              openHeavyEditor(
                inlineEdit.rowValues,
                inlineEdit.column,
                inlineEdit.value ?? "",
              );
              setInlineEdit(null);
            };
            // BIT columns get a dedicated 0/1 control. A `<select>` commits on
            // pick, so we save straight from `onSelect` with the chosen value
            // (no stale-state hop through `inlineEdit.value`).
            if (bitColNames.has(col.name)) {
              return (
                <BitInput
                  autoFocus
                  value={inlineEdit.value}
                  bitDisplay={bitDisplay}
                  nullable={colInfo?.nullable ?? false}
                  onSelect={(nv) => {
                    const { original, rowValues: rv, column } = inlineEdit;
                    setInlineEdit(null);
                    if (nv === original) return;
                    onCellSave?.(rv, column.name, nv).catch(() => {});
                  }}
                  onCancel={() => setInlineEdit(null)}
                />
              );
            }
            return (
              <CellInput
                autoFocus
                value={inlineEdit.value}
                nullable={colInfo?.nullable ?? false}
                nullActive={inlineEdit.value === null}
                onChange={(nv) =>
                  setInlineEdit((prev) => (prev ? { ...prev, value: nv } : prev))
                }
                onCommit={commit}
                onCancel={() => setInlineEdit(null)}
                onExpand={expand}
                expandTitle={t("dataGrid.expandEditor")}
              />
            );
          }
          const isBit = bitColNames.has(col.name);
          const rawDisplay =
            isBit && typeof v === "number"
              ? formatBitValue(v, bitDisplay)
              : formatValue(v);
          // Cap the rendered string so a multi-MB cell can't bloat the DOM;
          // the full value is still reachable via the cell preview / editor.
          // `truncateLongTextAt <= 0` disables the cap.
          const display =
            truncateLongTextAt > 0 && rawDisplay.length > truncateLongTextAt
              ? `${rawDisplay.slice(0, truncateLongTextAt)}…`
              : rawDisplay;
          const isNumeric = numericColNames.has(col.name);
          return (
            <div className="flex min-w-0 items-center gap-1">
              <span
                className={`truncate font-mono ${
                  isNumeric ? "text-numeric" : ""
                }`}
              >
                {v === null ? (
                  <span className="italic text-muted-foreground">
                    {nullDisplay}
                  </span>
                ) : (
                  display
                )}
              </span>
            </div>
          );
        },
      })),
    // numericColNames is derived from result.columns so they change together.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      result.columns,
      numericColNames,
      bitColNames,
      bitDisplay,
      nullDisplay,
      truncateLongTextAt,
      sort,
      pkNameSet,
      fkNameSet,
      onSortChange,
      fkEditCell,
      inlineEdit,
      columnInfoByName,
      columnIndexByName,
      connectionId,
      tableSchema,
      onCellSave,
      t,
    ],
  );

  const table = useReactTable({
    data: visibleRows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    enableColumnResizing: true,
    // "onEnd" defers the (expensive, store-writing) sizing update until the
    // pointer is released instead of on every drag-frame — TanStack still
    // renders a live resize indicator during the drag from its own internal
    // offset tracking, so this costs nothing visually.
    columnResizeMode: "onEnd",
    state: { columnSizing },
    onColumnSizingChange: handleColumnSizingChange,
  });

  /** Open the heavyweight Monaco modal directly (read-only view, or the
   *  "expand" escalation from the inline editor / CellPreview). */
  function openModalEditor(
    rowValues: CellValue[],
    column: ColumnMeta,
    value: string,
  ) {
    setEditorTarget({ rowValues, column, value });
    setEditorOpen(true);
  }

  /** Open the cell in the docked right-side editor (JetBrains-style). Shares
   *  the same commit path as the modal (`onCellSave`), or read-only when the
   *  grid isn't editable. */
  function openSidePanelEditor(
    rowValues: CellValue[],
    column: ColumnMeta,
    value: string,
  ) {
    const canSave = !!(editable && onCellSave);
    useCellEditor.getState().open({
      columnName: column.name,
      value,
      readonly: !canSave,
      onSave: canSave
        ? (v) => onCellSave!(rowValues, column.name, v)
        : undefined,
    });
    openSideEditor();
  }

  /** Escalate from inline/preview to the heavyweight editor, honouring the
   *  user's `cellEditorMode` preference (modal vs docked side panel). */
  function openHeavyEditor(
    rowValues: CellValue[],
    column: ColumnMeta,
    value: string,
  ) {
    if (cellEditorMode === "side") {
      openSidePanelEditor(rowValues, column, value);
    } else {
      openModalEditor(rowValues, column, value);
    }
  }

  /**
   * Double-click entry point. Routes to the right editor for the cell:
   * - single-column FK → inline combobox of valid referenced values;
   * - editable cell → inline `CellInput` (with an expand-to-modal affordance);
   * - read-only result grid → the Monaco modal as a viewer.
   */
  function openCellEdit(rowValues: CellValue[], column: ColumnMeta) {
    const info = columnInfoByName.get(column.name);
    if (editable && onCellSave && connectionId && info?.referenced_table) {
      setFkEditCell({ rowValues, column });
      return;
    }
    const cur = rowValues[columnIndexByName.get(column.name) ?? -1];
    const fmt = cur === null || cur === undefined ? null : formatValue(cur);
    if (editable && onCellSave) {
      setInlineEdit({ rowValues, column, value: fmt, original: fmt });
      return;
    }
    openModalEditor(rowValues, column, fmt ?? "");
  }

  /**
   * Grid-level keyboard navigation, bound to the (focusable) scroll container.
   * Moves the inset-ring active cell with the arrows / Home / End, opens the
   * editor on Enter, clears on Escape. The ring never animates its movement:
   * this fires on every keypress, so motion would read as lag (see the
   * keyboard-action rule). Guards: skip when an inline editor is open or focus
   * is inside a form control, and never swallow modified chords (Ctrl+C etc.).
   */
  function handleGridKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (inlineEdit || fkEditCell) return;
    const target = e.target as HTMLElement;
    if (target.closest("input, textarea, select, [contenteditable='true']")) {
      return;
    }
    const rows = table.getRowModel().rows;
    const colCount = table.getVisibleLeafColumns().length;
    if (rows.length === 0 || colCount === 0) return;

    const focusCell = (r: number, c: number) => {
      setActiveCell({ r, c });
      setSelectedRowIndex(r);
      // Keep the cell in view without smooth scrolling (instant per the
      // no-motion-on-keyboard rule), deferred a frame so the ring has painted.
      requestAnimationFrame(() => {
        scrollRef.current
          ?.querySelector<HTMLElement>(`[data-cell="${r}-${c}"]`)
          ?.scrollIntoView({ block: "nearest", inline: "nearest" });
      });
    };

    if (e.key === "Escape") {
      if (activeCell) {
        e.preventDefault();
        setActiveCell(null);
      }
      return;
    }

    const navKeys = [
      "ArrowDown",
      "ArrowUp",
      "ArrowRight",
      "ArrowLeft",
      "Home",
      "End",
    ];

    // First nav keypress with no active cell just anchors at the top-left
    // rather than jumping a step past it.
    if (!activeCell) {
      if (navKeys.includes(e.key)) {
        e.preventDefault();
        focusCell(0, 0);
      }
      return;
    }

    if (e.key === "Enter") {
      const row = rows[activeCell.r];
      const cell = row?.getVisibleCells()[activeCell.c];
      const bi = cell ? (columnIndexByName.get(cell.column.id) ?? -1) : -1;
      if (!row || bi < 0) return;
      e.preventDefault();
      openCellEdit(row.original as CellValue[], result.columns[bi]);
      return;
    }

    let { r, c } = activeCell;
    switch (e.key) {
      case "ArrowDown":
        r = Math.min(r + 1, rows.length - 1);
        break;
      case "ArrowUp":
        r = Math.max(r - 1, 0);
        break;
      case "ArrowRight":
        c = Math.min(c + 1, colCount - 1);
        break;
      case "ArrowLeft":
        c = Math.max(c - 1, 0);
        break;
      case "Home":
        c = 0;
        break;
      case "End":
        c = colCount - 1;
        break;
      default:
        return;
    }
    e.preventDefault();
    focusCell(r, c);
  }

  async function copyToClipboard(text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // No surfacing — clipboard failures are visually obvious to the user.
    }
  }

  /** Serialise several rows for the bulk "Copy N rows as ▸" menu, reusing the
   *  same per-row formatters as the single-row submenu. JSON yields one array;
   *  INSERT/UPDATE yield newline-joined statements. */
  function bulkCopy(rows: CellValue[][], fmt: "json" | "insert" | "update") {
    if (fmt === "json") {
      const arr = rows.map((r) => {
        const obj: Record<string, unknown> = {};
        result.columns.forEach((c, i) => {
          obj[c.name] = r[i] as unknown;
        });
        return obj;
      });
      return JSON.stringify(arr, null, 2);
    }
    if (fmt === "insert") {
      return rows
        .map((r) =>
          rowToSqlInsert(r, result.columns, driver, tableName, tableSchema),
        )
        .join("\n");
    }
    return rows
      .map((r) =>
        rowToSqlUpdate(
          r,
          result.columns,
          driver,
          tableName,
          tableSchema,
          pkColumnNames,
        ),
      )
      .join("\n");
  }

  return (
    // `relative` allows CellPreview to be positioned absolute within this container.
    <div className="relative flex h-full flex-col">
      {/* Toolbar: optional leading slot (breadcrumb/refresh/zoom from a table
          tab) + filter chips + text filter + row count + elapsed time + insert */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-background px-3 py-1.5 text-xs">
        {toolbarLeading}
        {toolbarLeading && (
          <div className="h-4 w-px shrink-0 bg-border" aria-hidden />
        )}
        <SearchInput
          value={filterInput ?? globalFilter ?? ""}
          onChange={onGlobalFilterChange}
          onSubmit={onGlobalFilterSubmit}
          history={searchHistory ?? []}
        />
        {serverFilters?.map((f, i) => (
          <span
            key={`${f.column}-${f.op}-${i}`}
            className="flex items-center gap-1 rounded-full border border-border bg-muted/40 px-2 py-0.5 font-mono text-[11px]"
            title={t("dataGrid.serverSideFilter")}
          >
            <span className="text-muted-foreground">{f.column}</span>
            <span className="text-muted-foreground/70">{FILTER_LABEL[f.op]}</span>
            {f.op === "eq" || f.op === "ne" ? (
              <span className="truncate max-w-[10rem]">
                {f.value === null || f.value === undefined
                  ? "NULL"
                  : formatValue(f.value)}
              </span>
            ) : null}
            <button
              className="ml-1 text-muted-foreground/60 hover:text-foreground"
              onClick={() => onRemoveFilter?.(i)}
              title={t("dataGrid.removeFilter")}
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        <span className="tabular-nums text-muted-foreground">
          <span className="font-medium text-foreground">
            {visibleRows.length.toLocaleString()}
          </span>{" "}
          {t("dataGrid.rows")}
          {result.total !== null && result.total !== undefined && (
            <>
              {" "}
              {t("dataGrid.of")}{" "}
              <span className="font-medium text-foreground">
                {result.total.toLocaleString()}
              </span>
            </>
          )}
        </span>
        {onInsertRow && (
          <button
            className="flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-[11px] hover:bg-accent"
            onClick={onInsertRow}
            title={t("dataGrid.insertNewRow")}
          >
            <Plus className="h-3 w-3" />
            {t("dataGrid.insert")}
          </button>
        )}
        <span
          className={cn(
            "ml-auto tabular-nums",
            // Draw attention only when a query is slow; fast queries stay
            // muted (colouring every timing green/amber would be noise).
            result.elapsed_ms > 2000
              ? "text-destructive"
              : result.elapsed_ms > 500
                ? "text-warning"
                : "text-muted-foreground",
          )}
        >
          {result.elapsed_ms} ms
        </span>
      </div>

      {/* Scrollable data table, wrapped so the refetch overlay covers only the
          grid body (not the toolbar). */}
      <div className="relative flex-1 overflow-hidden">
        <div
          ref={scrollRef}
          className="h-full overflow-auto outline-none"
        // Focusable so it can receive keyboard navigation; a cell click focuses
        // it (below). The active-cell ring is the visible focus affordance, so
        // the container's own outline is suppressed.
        tabIndex={0}
        onKeyDown={handleGridKeyDown}
        // Close the cell preview when clicking outside the table cells.
        onClick={() => setSelectedCell(null)}
      >
        {/* `select-none`: row range-select via Shift+Click otherwise also
            drags a native text selection across the rows (issue #30). Inline
            cell-edit inputs keep their own selection (form controls override
            an ancestor's user-select), and copying goes through the row
            context menu / cell preview panel rather than raw text selection. */}
        <table className="w-full table-fixed select-none border-separate border-spacing-0 text-left">
          <thead
            className={
              stickyHeader ? "sticky top-0 z-10 bg-card" : "bg-card"
            }
          >
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                <th
                  className="border-b border-border bg-card px-2 py-1 uppercase tracking-wider text-muted-foreground"
                  style={{ ...headerStyle, width: 40 }}
                >
                  {selectionEnabled ? (
                    <input
                      type="checkbox"
                      // Callback ref: native checkboxes only expose the
                      // "indeterminate" (dash) state via JS, so we set it on
                      // every render from `someSelected`.
                      ref={(el) => {
                        if (el) el.indeterminate = someSelected;
                      }}
                      checked={allSelected}
                      onChange={toggleSelectAll}
                      aria-label={
                        allSelected
                          ? t("dataGrid.deselectAll")
                          : t("dataGrid.selectAll")
                      }
                      title={
                        allSelected
                          ? t("dataGrid.deselectAll")
                          : t("dataGrid.selectAll")
                      }
                      className="accent-brand cursor-pointer align-middle"
                    />
                  ) : (
                    "#"
                  )}
                </th>
                {hg.headers.map((h) => (
                  <th
                    key={h.id}
                    className="relative border-b border-border bg-card px-2 py-1 uppercase tracking-wider text-muted-foreground"
                    style={{ ...headerStyle, width: h.getSize() }}
                  >
                    <div className="overflow-hidden">
                      {flexRender(h.column.columnDef.header, h.getContext())}
                    </div>
                    {/* Drag handle — thin strip on the column's trailing edge.
                        `select-none`/`touch-none` stop text selection and
                        mobile scroll-gesture conflicts while dragging. */}
                    <div
                      onMouseDown={h.getResizeHandler()}
                      onTouchStart={h.getResizeHandler()}
                      className={cn(
                        "absolute right-0 top-0 h-full w-1.5 cursor-col-resize select-none touch-none hover:bg-primary/50",
                        h.column.getIsResizing() && "bg-primary",
                      )}
                    />
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {draftRow && (
              <DraftRowView
                rowRef={draftRowRef}
                firstInputRef={firstDraftInputRef}
                columns={result.columns}
                draftColumns={draftColumns ?? []}
                draft={draftRow}
                connectionId={connectionId}
                tableSchema={tableSchema}
                tableName={tableName}
                bitDisplay={bitDisplay}
                onChange={onDraftCellChange}
                onCommit={onDraftCommit}
                onCancel={onDraftCancel}
              />
            )}
            {table.getRowModel().rows.map((row, i) => {
              const isSelected = selectedRowIndex === i;
              // `rowValues` is the underlying payload (CellValue[]) for
              // this row. We thread it through every callback so the
              // parent resolves PK / identity from data — not from `i`,
              // which is the *filtered display index* and silently
              // mismatches `result.rows` when `globalFilter` is active.
              const rowValues = row.original as CellValue[];
              const rowKey = selectionEnabled
                ? (getRowKey?.(rowValues) ?? null)
                : null;
              const isMultiSelected = rowKey !== null && selectedKeys.has(rowKey);
              return (
                <tr
                  key={row.id}
                  className={cn(
                    "group/row",
                    isMultiSelected
                      ? "bg-brand/20"
                      : isSelected
                        ? "bg-brand/10"
                        : zebraStripes && i % 2 === 1
                          ? "bg-muted/30 hover:bg-accent/30"
                          : "hover:bg-accent/30",
                  )}
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelectedRowIndex(i);
                    applyRowSelectionClick(rowKey, e);
                  }}
                >
                  <td
                    className="border-b border-border/50 px-2 tabular-nums text-muted-foreground"
                    style={{ ...cellStyle, width: 40 }}
                  >
                    {selectionEnabled && rowKey !== null ? (
                      <>
                        <input
                          type="checkbox"
                          checked={isMultiSelected}
                          onChange={() => toggleRowKey(rowKey)}
                          // Stop the row's onClick (a plain click there clears
                          // the multi-selection) from firing on checkbox click.
                          onClick={(e) => e.stopPropagation()}
                          aria-label={t("dataGrid.selectRow")}
                          className={cn(
                            "accent-brand cursor-pointer align-middle",
                            isMultiSelected
                              ? "inline-block"
                              : "hidden group-hover/row:inline-block",
                          )}
                        />
                        <span
                          className={
                            isMultiSelected ? "hidden" : "group-hover/row:hidden"
                          }
                        >
                          {i + 1}
                        </span>
                      </>
                    ) : (
                      i + 1
                    )}
                  </td>
                  {row.getVisibleCells().map((cell, cIdx) => {
                    // Resolve column meta + value by *name*, not by the
                    // position of the cell in `getVisibleCells()`. The
                    // grid currently keeps both orders in sync, but a
                    // single column hide / reorder would otherwise
                    // misalign `result.columns[colIdx]` with the actual
                    // cell — see `columnIndexByName` above.
                    const colName = cell.column.id;
                    const backendIdx = columnIndexByName.get(colName) ?? -1;
                    if (backendIdx < 0) return null;
                    const meta = result.columns[backendIdx];
                    const value = rowValues[backendIdx];
                    const colIdx = backendIdx;
                    // FK-navigable iff the parent wired `onNavigateFk` and this
                    // column carries a single-column FK reference. Drives the
                    // Ctrl/Cmd+click accelerator, the context-menu entry, and a
                    // subtle hover affordance.
                    const isFkCell =
                      !!onNavigateFk &&
                      !!columnInfoByName.get(meta.name)?.referenced_table;
                    const isActiveCell =
                      activeCell?.r === i && activeCell?.c === cIdx;
                    return (
                      <ContextMenu key={cell.id}>
                        <ContextMenuTrigger asChild>
                          <td
                            data-cell={`${i}-${cIdx}`}
                            className={cn(
                              "cursor-pointer border-b border-border/50 px-2",
                              isFkCell &&
                                "hover:underline hover:decoration-dotted hover:decoration-fk/70 hover:underline-offset-2",
                              // Inset ring marks the keyboard-active cell.
                              // `relative z-10` lifts it above neighbours so the
                              // ring isn't clipped by adjacent cell borders. No
                              // transition — the ring must track keys instantly.
                              isActiveCell &&
                                "relative z-10 ring-2 ring-inset ring-brand",
                            )}
                            title={isFkCell ? t("dataGrid.fkNavHint") : undefined}
                            style={{ ...cellStyle, width: cell.column.getSize() }}
                            onClick={(e) => {
                              e.stopPropagation();
                              // While this cell hosts its own inline editor
                              // (notably the BIT `<select>`), don't steal focus
                              // back to the scroll container or recompute the
                              // active/selected cell — focusing the container
                              // collapses a just-opened native dropdown, which
                              // made the boolean BIT picker unusable (issue #44).
                              // Let the inline editor own clicks inside itself.
                              if (
                                inlineEdit?.rowValues === rowValues &&
                                inlineEdit.column.name === meta.name
                              ) {
                                return;
                              }
                              // Focus the container so keyboard nav continues
                              // from here, and mark this cell active.
                              scrollRef.current?.focus({ preventScroll: true });
                              setActiveCell({ r: i, c: cIdx });
                              // Ctrl/Cmd+click on a single-column FK cell is the
                              // "go to referenced row" accelerator (IDE-style).
                              // It takes precedence over the multi-selection
                              // toggle that the same chord drives on non-FK
                              // cells, but never over Shift-range selection.
                              if (
                                (e.ctrlKey || e.metaKey) &&
                                !e.shiftKey &&
                                onNavigateFk &&
                                columnInfoByName.get(meta.name)
                                  ?.referenced_table &&
                                value !== null &&
                                value !== undefined
                              ) {
                                onNavigateFk(meta.name, value);
                                return;
                              }
                              setSelectedRowIndex(i);
                              // Ctrl/Cmd/Shift-click on a cell drives the
                              // OS-style multi-selection; a plain click also
                              // opens the cell preview below.
                              applyRowSelectionClick(rowKey, e);
                              if (!e.ctrlKey && !e.metaKey && !e.shiftKey) {
                                setSelectedCell({
                                  rowValues,
                                  colIndex: colIdx,
                                  column: meta,
                                  value,
                                });
                                // If the docked side editor is open, follow
                                // the clicked cell (JetBrains value-viewer
                                // behaviour). The panel guards unsaved edits
                                // before swapping its buffer.
                                if (isSideEditorOpen()) {
                                  openSidePanelEditor(
                                    rowValues,
                                    meta,
                                    formatValue(value),
                                  );
                                }
                              }
                            }}
                            onContextMenu={() => {
                              setSelectedRowIndex(i);
                              setSelectedCell({
                                rowValues,
                                colIndex: colIdx,
                                column: meta,
                                value,
                              });
                            }}
                            onDoubleClick={(e) => {
                              e.stopPropagation();
                              openCellEdit(rowValues, meta);
                            }}
                          >
                            {flexRender(cell.column.columnDef.cell, cell.getContext())}
                          </td>
                        </ContextMenuTrigger>
                        <ContextMenuContent>
                          {/* Bulk variant: shown when more than one row is
                              selected and the right-clicked row is part of
                              that selection. Replaces the per-cell/row entries
                              with selection-wide copy + delete; otherwise the
                              regular single-row menu below renders. */}
                          {selectionEnabled &&
                          selectedRows.length > 1 &&
                          rowKey !== null &&
                          selectedKeys.has(rowKey) ? (
                            <>
                              <ContextMenuLabel>
                                {t("dataGrid.ctxRowsSelected", {
                                  count: selectedRows.length,
                                })}
                              </ContextMenuLabel>
                              <ContextMenuSub>
                                <ContextMenuSubTrigger>
                                  {t("dataGrid.ctxCopyRowsAs", {
                                    count: selectedRows.length,
                                  })}
                                </ContextMenuSubTrigger>
                                <ContextMenuSubContent>
                                  <ContextMenuItem
                                    onSelect={() =>
                                      copyToClipboard(
                                        bulkCopy(selectedRows, "json"),
                                      )
                                    }
                                  >
                                    JSON
                                  </ContextMenuItem>
                                  <ContextMenuItem
                                    onSelect={() =>
                                      copyToClipboard(
                                        bulkCopy(selectedRows, "insert"),
                                      )
                                    }
                                  >
                                    SQL INSERT
                                  </ContextMenuItem>
                                  <ContextMenuItem
                                    onSelect={() =>
                                      copyToClipboard(
                                        bulkCopy(selectedRows, "update"),
                                      )
                                    }
                                  >
                                    SQL UPDATE
                                  </ContextMenuItem>
                                </ContextMenuSubContent>
                              </ContextMenuSub>
                              {onBulkDelete && (
                                <>
                                  <ContextMenuSeparator />
                                  <ContextMenuItem
                                    className="text-destructive focus:text-destructive"
                                    onSelect={() => onBulkDelete(selectedRows)}
                                  >
                                    {t("dataGrid.ctxDeleteRows", {
                                      count: selectedRows.length,
                                    })}
                                  </ContextMenuItem>
                                </>
                              )}
                            </>
                          ) : (
                          <>
                          <ContextMenuLabel>
                            {meta.name}
                            {value === null ? " · NULL" : ""}
                          </ContextMenuLabel>
                          {isFkCell &&
                            value !== null &&
                            value !== undefined && (
                              <>
                                <ContextMenuItem
                                  onSelect={() =>
                                    onNavigateFk?.(meta.name, value)
                                  }
                                >
                                  {t("dataGrid.ctxGoToReference")}
                                </ContextMenuItem>
                                <ContextMenuSeparator />
                              </>
                            )}
                          <ContextMenuItem
                            onSelect={() => copyToClipboard(formatValue(value))}
                          >
                            {t("dataGrid.ctxCopy")}
                          </ContextMenuItem>
                          <ContextMenuItem
                            onSelect={() =>
                              copyToClipboard(
                                `${meta.name} = ${sqlLiteral(value)}`,
                              )
                            }
                          >
                            {t("dataGrid.ctxCopyWithColumn")}
                          </ContextMenuItem>
                          {/* Row-level formatters. We keep the per-cell
                              entries above (single value, single value
                              with column name) because they're the most
                              common path; this submenu covers the
                              less-frequent "I want the whole row" use
                              cases without bloating the top level. */}
                          <ContextMenuSub>
                            <ContextMenuSubTrigger>
                              {t("dataGrid.ctxCopyRowAs")}
                            </ContextMenuSubTrigger>
                            <ContextMenuSubContent>
                              <ContextMenuItem
                                onSelect={() =>
                                  copyToClipboard(
                                    rowToJson(rowValues, result.columns),
                                  )
                                }
                              >
                                JSON
                              </ContextMenuItem>
                              <ContextMenuItem
                                onSelect={() =>
                                  copyToClipboard(
                                    rowToSqlInsert(
                                      rowValues,
                                      result.columns,
                                      driver,
                                      tableName,
                                      tableSchema,
                                    ),
                                  )
                                }
                              >
                                SQL INSERT
                              </ContextMenuItem>
                              <ContextMenuItem
                                onSelect={() =>
                                  copyToClipboard(
                                    rowToSqlUpdate(
                                      rowValues,
                                      result.columns,
                                      driver,
                                      tableName,
                                      tableSchema,
                                      pkColumnNames,
                                    ),
                                  )
                                }
                              >
                                SQL UPDATE
                              </ContextMenuItem>
                            </ContextMenuSubContent>
                          </ContextMenuSub>
                          <ContextMenuItem
                            onSelect={() =>
                              openSidePanelEditor(
                                rowValues,
                                meta,
                                formatValue(value),
                              )
                            }
                          >
                            {t("dataGrid.openInSideEditor")}
                          </ContextMenuItem>
                          {editable && onCellSave && (
                            <ContextMenuItem
                              disabled={value === null}
                              onSelect={() =>
                                onCellSave(rowValues, meta.name, null).catch(
                                  () => {},
                                )
                              }
                            >
                              {t("cellEditor.setNull")}
                            </ContextMenuItem>
                          )}
                          {onAddFilter && (
                            <>
                              <ContextMenuSeparator />
                              <ContextMenuItem
                                onSelect={() =>
                                  onAddFilter(
                                    value === null
                                      ? { column: meta.name, op: "is_null" }
                                      : {
                                          column: meta.name,
                                          op: "eq",
                                          value,
                                        },
                                  )
                                }
                              >
                                {t("dataGrid.ctxFilterBy")}
                              </ContextMenuItem>
                              <ContextMenuItem
                                onSelect={() =>
                                  onAddFilter(
                                    value === null
                                      ? { column: meta.name, op: "is_not_null" }
                                      : {
                                          column: meta.name,
                                          op: "ne",
                                          value,
                                        },
                                  )
                                }
                              >
                                {t("dataGrid.ctxFilterExcluding")}
                              </ContextMenuItem>
                            </>
                          )}
                          {(onInsertRow || onDuplicateRow || onDeleteRow) && (
                            <>
                              <ContextMenuSeparator />
                              {onInsertRow && (
                                <ContextMenuItem onSelect={() => onInsertRow()}>
                                  {t("dataGrid.ctxInsertRow")}
                                </ContextMenuItem>
                              )}
                              {onDuplicateRow && (
                                <ContextMenuItem
                                  onSelect={() => onDuplicateRow(rowValues)}
                                >
                                  {t("dataGrid.ctxDuplicateRow")}
                                </ContextMenuItem>
                              )}
                              {onDeleteRow && (
                                <ContextMenuItem
                                  className="text-destructive focus:text-destructive"
                                  onSelect={() => onDeleteRow(rowValues)}
                                >
                                  {t("dataGrid.ctxDeleteRow")}
                                </ContextMenuItem>
                              )}
                            </>
                          )}
                          </>
                          )}
                        </ContextMenuContent>
                      </ContextMenu>
                    );
                  })}
                </tr>
              );
            })}
            {visibleRows.length === 0 && !draftRow && (
              <tr>
                <td
                  colSpan={result.columns.length + 1}
                  className="px-4 py-8 text-center text-xs text-muted-foreground"
                >
                  No rows
                </td>
              </tr>
            )}
          </tbody>
        </table>
        </div>
        {/* Refetch overlay: dims the (stale) rows and shows a spinner so a
            reload doesn't look frozen. pointer-events-none keeps the stale
            data interactive. Initial load is handled by the caller's skeleton. */}
        {loading && (
          <div
            className="pointer-events-none absolute inset-0 z-20 flex items-start justify-center bg-background/40"
            aria-hidden
          >
            <Loader2 className="mt-6 h-5 w-5 animate-spin text-brand" />
          </div>
        )}
      </div>

      {/* Compact cell preview panel — gated by the `cellPreview` grid pref.
          When disabled, selecting a cell stays pure navigation (the heavy
          editor is still reachable via double-click / context menu). */}
      {cellPreview && selectedCell && (
        <CellPreview
          columnName={selectedCell.column.name}
          value={selectedCell.value}
          onClose={() => setSelectedCell(null)}
          onFullscreen={() => {
            openHeavyEditor(
              selectedCell.rowValues,
              selectedCell.column,
              formatValue(selectedCell.value),
            );
            setSelectedCell(null);
          }}
          onSave={
            editable && onCellSave
              ? async (v) => {
                  await onCellSave(
                    selectedCell.rowValues,
                    selectedCell.column.name,
                    v,
                  );
                  setSelectedCell(null);
                }
              : undefined
          }
          onSetNull={
            editable && onCellSave
              ? async () => {
                  await onCellSave(
                    selectedCell.rowValues,
                    selectedCell.column.name,
                    null,
                  );
                  setSelectedCell(null);
                }
              : undefined
          }
        />
      )}

      {/* Full Monaco editor (escalated from CellPreview or double-click). */}
      {editorTarget && (
        <CellEditor
          open={editorOpen}
          onOpenChange={setEditorOpen}
          initialValue={editorTarget.value}
          columnName={editorTarget.column.name}
          readonly={!editable || !onCellSave}
          onSave={
            editable && onCellSave
              ? async (newValue) => {
                  await onCellSave(
                    editorTarget.rowValues,
                    editorTarget.column.name,
                    newValue,
                  );
                }
              : undefined
          }
        />
      )}
    </div>
  );
}

/**
 * Toolbar search input with an optional history dropdown.
 *
 * Submitting is explicit: typing only updates the input value, and the
 * search is applied to the backend on Enter, on picking a history
 * entry, or on clicking the clear (×) button. This stops every
 * keystroke from creating a history entry and avoids spurious refetches
 * while the user is still composing the query.
 */
function SearchInput({
  value,
  onChange,
  onSubmit,
  history,
}: {
  value: string;
  onChange?: (v: string) => void;
  onSubmit?: (v: string) => void;
  history: string[];
}) {
  const { t } = useTranslation();
  const hasHistory = history.length > 0;
  const hasValue = value.length > 0;
  return (
    <div className="flex h-7 items-stretch overflow-hidden rounded-md border border-input bg-background focus-within:ring-1 focus-within:ring-ring">
      <input
        className="w-56 bg-transparent px-2 text-xs focus:outline-none"
        placeholder={t("dataGrid.filterRows")}
        value={value}
        onChange={(e) => onChange?.(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onSubmit?.(value);
          }
        }}
      />
      {hasValue && (
        <button
          type="button"
          className="flex items-center justify-center px-1.5 text-muted-foreground/70 hover:bg-accent/30 hover:text-foreground"
          title="Clear filter"
          onClick={() => {
            // Clear immediately + apply, so the grid actually refetches
            // and the user sees the unfiltered rows.
            onChange?.("");
            onSubmit?.("");
          }}
        >
          <X className="h-3 w-3" />
        </button>
      )}
      {hasHistory && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex items-center justify-center border-l border-input px-1.5 text-muted-foreground/70 hover:bg-accent/30 hover:text-foreground"
              title="Recent searches on this connection"
            >
              <ChevronDown className="h-3 w-3" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
            {history.map((q) => (
              <DropdownMenuItem
                key={q}
                onSelect={() => {
                  onChange?.(q);
                  onSubmit?.(q);
                }}
                className="font-mono text-xs"
              >
                <span className="truncate max-w-[20rem]">{q}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

/**
 * Editable row pinned at the top of the grid for inline INSERT.
 *
 * Each cell is a plain text input. The empty initial state ("NULL"
 * placeholder) means the column is omitted from the INSERT so the
 * database picks the default; clicking "∅" explicitly forces NULL.
 *
 * Commit fires when focus leaves the row entirely (the user clicks
 * outside). We detect this with a `setTimeout(0)` after `onBlur` and
 * check whether `document.activeElement` is still inside the row.
 * `Esc` cancels; `Enter` commits explicitly.
 */
interface DraftRowViewProps {
  rowRef: React.MutableRefObject<HTMLTableRowElement | null>;
  firstInputRef: React.MutableRefObject<HTMLElement | null>;
  columns: ColumnMeta[];
  draftColumns: ColumnInfo[];
  draft: DraftRow;
  /** Connection + target table — required for FK comboboxes to query options. */
  connectionId?: string;
  tableSchema?: string;
  tableName?: string;
  /** Grid preference for BIT option labels in the dedicated control. */
  bitDisplay: "true_false" | "zero_one";
  onChange?: (column: string, cell: DraftCell) => void;
  onCommit?: () => void;
  onCancel?: () => void;
}

function DraftRowView({
  rowRef,
  firstInputRef,
  columns,
  draftColumns,
  draft,
  connectionId,
  tableSchema,
  tableName: _tableName,
  bitDisplay,
  onChange,
  onCommit,
  onCancel,
}: DraftRowViewProps) {
  const infoByName = useMemo(() => {
    const m = new Map<string, ColumnInfo>();
    for (const c of draftColumns) m.set(c.name, c);
    return m;
  }, [draftColumns]);

  /** First non-auto-PK column index — used to bind the focus-on-mount ref. */
  const firstEditableIdx = useMemo(() => {
    for (let i = 0; i < columns.length; i++) {
      const info = infoByName.get(columns[i].name);
      if (!info) return i;
      const isAutoPk =
        info.is_primary_key &&
        /int|serial|rowid/i.test(info.data_type);
      if (!isAutoPk) return i;
    }
    return 0;
  }, [columns, infoByName]);

  function handleRowBlur() {
    // Wait one tick for focus to settle on the new target.
    setTimeout(() => {
      if (draft.saving) return;
      const active = document.activeElement;
      if (rowRef.current && active && rowRef.current.contains(active)) return;
      onCommit?.();
    }, 0);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel?.();
    } else if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onCommit?.();
    }
  }

  return (
    <>
      <tr
        ref={rowRef}
        className="border-l-2 border-l-primary bg-primary/5"
        onBlur={handleRowBlur}
        onKeyDown={handleKeyDown}
      >
        <td className="border-b border-border/50 px-2 py-1 text-[10px] font-medium text-primary">
          {draft.saving ? "…" : "+"}
        </td>
        {columns.map((col, idx) => {
          const cell: DraftCell =
            draft.cells[col.name] ?? { value: null, touched: false };
          const info = infoByName.get(col.name);
          const isAutoPk =
            info?.is_primary_key &&
            /int|serial|rowid/i.test(info.data_type);
          return (
            <td
              key={col.name}
              className="border-b border-border/50 px-1 py-0.5"
            >
              {isAutoPk ? (
                <span
                  className="block px-1 font-mono text-[11px] italic text-muted-foreground/60"
                  title="Auto-generated by the database"
                >
                  auto
                </span>
              ) : info?.referenced_table && connectionId ? (
                // Single-column FK: pick a valid referenced value instead
                // of typing one. The combobox owns its own NULL handling
                // when the column is nullable, so we don't render the
                // separate "∅" button used for plain inputs.
                <FkCombobox
                  ref={
                    idx === firstEditableIdx
                      ? (firstInputRef as React.MutableRefObject<HTMLButtonElement | null>)
                      : undefined
                  }
                  connectionId={connectionId}
                  refSchema={
                    info.referenced_schema ?? tableSchema ?? undefined
                  }
                  refTable={info.referenced_table}
                  refColumn={info.referenced_column ?? "id"}
                  value={cell.value}
                  nullable={info.nullable}
                  disabled={draft.saving}
                  onChange={(v) =>
                    onChange?.(col.name, { value: v, touched: true })
                  }
                />
              ) : info && isBitType(info.data_type) ? (
                // BIT column: dedicated 0/1 control instead of a text field.
                // Emits the numeric string the backend's CAST expects and
                // seeds a non-null column to 0 (gotcha #15). Row-level
                // onBlur / onKeyDown still drive commit & cancel.
                <BitInput
                  autoFocus={idx === firstEditableIdx}
                  value={cell.value}
                  bitDisplay={bitDisplay}
                  nullable={info.nullable}
                  disabled={draft.saving}
                  seedDefault={!info.nullable}
                  onSelect={(v) =>
                    onChange?.(col.name, { value: v, touched: true })
                  }
                />
              ) : (
                // Row-level onBlur / onKeyDown drive commit & cancel here, so
                // CellInput is left unwired (no onCommit / onCancel).
                <CellInput
                  ref={
                    idx === firstEditableIdx
                      ? (firstInputRef as React.MutableRefObject<HTMLInputElement | null>)
                      : undefined
                  }
                  value={cell.value}
                  nullable={info?.nullable}
                  nullActive={cell.value === null && cell.touched}
                  disabled={draft.saving}
                  onChange={(v) =>
                    onChange?.(col.name, { value: v, touched: true })
                  }
                />
              )}
            </td>
          );
        })}
      </tr>
      {draft.error && (
        <tr>
          <td
            colSpan={columns.length + 1}
            className="border-b border-border/50 bg-destructive/10 px-3 py-1 text-[11px] text-destructive"
          >
            {draft.error}
            <button
              className="ml-3 underline-offset-2 hover:underline"
              onClick={() => onCancel?.()}
            >
              discard
            </button>
          </td>
        </tr>
      )}
    </>
  );
}
