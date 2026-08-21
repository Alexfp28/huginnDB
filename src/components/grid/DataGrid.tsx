/**
 * Generic data grid used for both table data and ad-hoc query results.
 * Built on top of TanStack Table; the table view's rows are windowed by
 * `@tanstack/react-virtual` (list view — MongoDB's `DocumentListView` — is
 * not, see its own file).
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

import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type Updater,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { tableKey } from "@/stores/session/schema";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Inbox,
  KeyRound,
  Loader2,
  Maximize2,
  MoreHorizontal,
  Plus,
  UnfoldHorizontal,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown";
import { cn, formatNumber } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/common/EmptyState";
import {
  defaultColumnWidth,
  formatBitValue,
  isBitType,
  isNumericType,
} from "@/lib/grid/columnKinds";
import {
  computeColumnFitWidth,
  resolveCanvasFont,
} from "@/lib/grid/autoFitColumn";
import { useToolbarDensity } from "@/lib/grid/toolbarDensity";
import { usePreferences, selectGridPrefs } from "@/stores/preferences/preferences";
import {
  DocumentListView,
  type FieldSave,
} from "@/components/grid/DocumentListView";
import { formatComboForDisplay, getBinding, matchesBinding } from "@/lib/keybindings";
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
import { BitInput } from "@/components/grid/BitInput";
import { CellEditor } from "@/components/grid/dialogs/CellEditor";
import { CellInput } from "@/components/grid/CellInput";
import { CellPreview } from "@/components/grid/CellPreview";
import { FkCombobox } from "@/components/ui/fk-combobox";
import { DraftRowView } from "@/components/grid/DraftRowView";
import { GridSearchInput } from "@/components/grid/GridSearchInput";
import {
  GridRow,
  type GridRowCallbacks,
} from "@/components/grid/GridRow";
import {
  ServerFilterChip,
  ServerFilterSummary,
} from "@/components/grid/ServerFilterChips";
import {
  toSqlInsert as rowToSqlInsert,
  toSqlUpdate as rowToSqlUpdate,
} from "@/lib/grid/copyFormats";
import { formatValue } from "@/lib/grid/formatValue";
import {
  useCellEditor,
  type CellBindingContext,
} from "@/stores/grid/cellEditor";
import { useJsonSchemas, relationKey } from "@/stores/jsonSchemas";
import { useSessionPanelLayout } from "@/stores/session/panelLayout";
import type { Driver } from "@/types";

/**
 * One toolbar action, in BOTH of its presentations.
 *
 * The toolbar is responsive: as the grid's pane narrows, actions move out of
 * the bar and into an overflow menu (see `useToolbarDensity`). A plain
 * `ReactNode` can't make that trip — a `<Button>` dropped inside
 * `DropdownMenuContent` looks wrong and loses the menu's keyboard semantics,
 * and a bar control that is itself a dropdown (Export data) has to become a
 * submenu rather than a nested menu. So each action declares both forms and
 * the grid decides which one to mount; nothing here is derived from the other,
 * because the two really are different components (an icon button with a
 * tooltip vs. a labelled row with a check state).
 *
 * `id` is the React key and exists only for that.
 */
export interface GridToolbarItem {
  id: string;
  /** Rendered inline in the toolbar row. */
  bar: ReactNode;
  /**
   * Rendered inside the overflow menu — one or more `DropdownMenuItem`s (or a
   * `DropdownMenuSub`). Must not be a bare `<Button>`.
   */
  menu: ReactNode;
}

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
  /** Id of the tab hosting this grid. Threaded to the docked side editor so it
   *  can close itself when this tab is closed (it lives outside the subtree). */
  tabId?: string;
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
  /**
   * List-view field commit — `onCellSave` generalised to a field **path**, so
   * a nested field (`["customData", "format"]`, `["tags", "2"]`) can be
   * written as well as a top-level one, with the type it should be written
   * as. Only the list view uses it; the table view has no nested cells to
   * address. Absent → the list view renders read-only.
   */
  onFieldSave?: FieldSave;
  /**
   * List-view field removal (MongoDB `$unset`). Its presence is also what puts
   * the list view in *document* mode: the add-field, delete-field and BSON
   * type picker affordances only make sense where a row's field set is a
   * property of the row itself, which is exactly where a `$unset` exists.
   */
  onFieldDelete?: (rowValues: CellValue[], path: string[]) => Promise<void>;
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
   * Actions rendered at the START of the toolbar row (before the search box),
   * with a divider after them. TableDataTab folds its refresh + advanced
   * filter controls in here so a table tab shows ONE toolbar instead of two
   * stacked bars. Query-result tabs omit it.
   */
  toolbarLeading?: GridToolbarItem[];
  /**
   * Actions rendered right beside the built-in "Insert" button, both living in
   * the toolbar's right-aligned cluster. TableDataTab folds its "Add
   * data"/"Export data"/"Bulk update" controls in here so every action that
   * adds, exports, or mass-edits data reads as one group instead of being
   * split across the toolbar.
   */
  insertExtra?: GridToolbarItem[];
  /**
   * Actions rendered on the TRAILING (right) side of the toolbar row, after
   * `insertExtra`, before the elapsed-time readout. TableDataTab folds its
   * table/list view toggle in here.
   */
  toolbarTrailing?: GridToolbarItem[];
  /**
   * Optional second toolbar row, rendered below the grid body (a footer, not
   * a header). TableDataTab folds its pagination range/prev/next/page-size
   * and row-zoom controls in here — those are "how you're browsing", kept
   * apart from the header's "what you're doing to the data" actions. Omitted
   * entirely (no empty bar) when not provided, so query/view result tabs
   * that don't paginate see no change.
   */
  footer?: ReactNode;
  /**
   * Whether to render the built-in "N rows of M" count in the toolbar
   * (default true). TableDataTab sets this false because its trailing slot
   * already shows a human-format pagination range (`1–100 of 19759`), which
   * makes the row count redundant; query/view result tabs keep it, since it's
   * their only row-total indicator (they don't paginate).
   */
  showRowCount?: boolean;
  /**
   * When true, dims the grid body and shows a spinner overlay — used while a
   * refetch is in flight but stale rows are still on screen, so the grid
   * doesn't look frozen. Initial load (no rows yet) is handled by the caller's
   * skeleton placeholder instead.
   */
  loading?: boolean;
  /**
   * Row layout: "table" (default) is the regular column grid; "list" renders
   * each row as a card with one `field: value` line per column, folding
   * nested objects/arrays — see `DocumentListView`. It was built for MongoDB
   * documents but the problem it solves (a wide or nested row that scrolls
   * horizontally and flattens nested values into one unreadable line) is not
   * MongoDB's alone, so every driver can use it.
   *
   * List mode drives its own editing (inline per field, escalating to the
   * same Monaco editor) through `onFieldSave`/`onFieldDelete`; what it does
   * NOT have is the table-specific chrome — FK overlay, keyboard cell
   * navigation, and the draft-row insert/duplicate UI — so Insert and
   * Duplicate stay hidden while it is active.
   */
  viewMode?: "table" | "list";
}

export interface SelectedCell {
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

export function DataGrid({
  result,
  editable,
  connectionId,
  tableSchema,
  tableName,
  tabId,
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
  onFieldSave,
  onFieldDelete,
  getRowKey,
  onSelectionChange,
  draftRow,
  draftColumns,
  onDraftCellChange,
  onDraftCommit,
  onDraftCancel,
  toolbarLeading,
  insertExtra,
  toolbarTrailing,
  footer,
  showRowCount = true,
  loading,
  viewMode = "table",
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
   *
   * The focus is granted in a `setTimeout` *chained after* a frame, not inside
   * the frame itself, and that ordering is load-bearing. "Insert row" is
   * reachable from two Radix menus (the row context menu and the toolbar's
   * overflow menu), and Radix's `FocusScope` restores focus to whatever was
   * focused before the menu opened from inside its own `setTimeout(…, 0)` on
   * unmount. Focusing synchronously in the frame therefore lost the race: Radix
   * pulled focus out of the just-mounted draft a tick later, the row's
   * focus-leave handler fired, and an untouched draft is silently cancelled —
   * so the row appeared and vanished instantly (the only reliable way to insert
   * was the toolbar button, which involves no menu). Our timeout is always
   * queued after Radix's, so the draft ends up focused either way.
   */
  const draftActive = !!draftRow;
  useEffect(() => {
    if (!draftActive) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The frame is what waits for the row / card to be mounted.
    const frame = requestAnimationFrame(() => {
      timer = setTimeout(() => firstDraftInputRef.current?.focus(), 0);
    });
    return () => {
      cancelAnimationFrame(frame);
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [draftActive]);

  /** Full Monaco editor (opened via CellPreview F11 or double-click). */
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorTarget, setEditorTarget] = useState<{
    rowValues: CellValue[];
    column: ColumnMeta;
    value: string;
    /** Set when the editor was opened from the list view: the field's path
     *  from the document root plus its BSON type, so the commit goes through
     *  `onFieldSave` (which can address a nested field) rather than
     *  `onCellSave` (which only knows top-level columns). */
    field?: { path: string[]; type: string };
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
   * when `getRowKey` is wired; otherwise the checkbox column is hidden and
   * bulk actions never appear — which is still the case for ad-hoc query
   * result grids. A *table* grid always wires it: `TableDataTab` derives the
   * key from the PK tuple when there is one and from the whole values array
   * when there isn't, so a no-PK table keeps its selection gestures (see the
   * note there). Selection being enabled therefore no longer implies a PK
   * exists — destructive bulk actions gate on their own callbacks
   * (`onBulkDelete`), which the parent withholds without one.
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
   * Re-resolve `selectedCell` after a refetch replaces every row's array
   * reference (e.g. `onCellSave` awaiting `fetchData()` while the docked side
   * editor stays open across the save). Without this, a cell selected before
   * the save keeps pointing at a now-detached array once the fresh result
   * lands: the selected-cell "expand" affordance and the `cellPreview` panel
   * both key off `rowValues` identity (gotcha #7), so they'd silently go
   * stale — the button vanishes from the grid and, if `cellPreview` is on,
   * the floating panel keeps showing the pre-save value forever, even though
   * the side editor is still open and "focused" on that same logical cell.
   * `visibleRows.includes` is a no-op on a sort/filter reshuffle, which reuses
   * the same row objects — this only does work on a genuine refetch. Falls
   * back to clearing the selection when it can't be resolved (no `getRowKey`,
   * or the row is gone) rather than leaving a phantom target.
   */
  useEffect(() => {
    setSelectedCell((prev) => {
      if (!prev || visibleRows.includes(prev.rowValues)) return prev;
      if (!getRowKey) return null;
      const key = getRowKey(prev.rowValues);
      if (key === null) return null;
      const next = visibleRows.find((r) => getRowKey(r) === key);
      if (!next) return null;
      return { ...prev, rowValues: next, value: next[prev.colIndex] };
    });
    // Deliberately only `visibleRows`: `getRowKey` is a per-render prop and
    // `selectedCell` is what this effect writes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleRows]);

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
   * The selection's values for one column, plus how many of them are actually
   * distinct — the pair behind the "filter by the selected rows" action (#114).
   *
   * The distinct count is what the menu label advertises: selecting 40 rows that
   * share 3 values builds a 3-element `IN` list (the backend dedupes), so
   * promising "40 values" would misdescribe the filter about to be applied.
   * NULL is counted apart from the formatted values instead of being folded in
   * with them: `formatValue(null)` is `""`, indistinguishable from an empty
   * string, so a column holding both would be undercounted.
   */
  function selectedColumnValues(colIndex: number): {
    values: CellValue[];
    distinct: number;
  } {
    const values = selectedRows.map((r) => r[colIndex] ?? null);
    const nonNull = values.filter((v) => v !== null);
    const distinct =
      new Set(nonNull.map((v) => formatValue(v))).size +
      (nonNull.length === values.length ? 0 : 1);
    return { values, distinct };
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
  /** Any row selected at all — drives the always-visible checkbox affordance. */
  const hasSelection = selectedKeys.size > 0;

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
  // List-view layout prefs (Settings → Appearance → data view). Subscribed as
  // primitives so the selectors stay reference-stable (gotcha #1).
  const listExpandNested = usePreferences(
    (s) => selectGridPrefs(s).listExpandNested,
  );
  const listShowTypes = usePreferences((s) => selectGridPrefs(s).listShowTypes);
  const listLineNumbers = usePreferences(
    (s) => selectGridPrefs(s).listLineNumbers,
  );

  /**
   * Persisted grid "zoom" (HeidiSQL-style). A single px row-height drives
   * cell height, padding and font-size together. Subscribed as a primitive
   * so the selector stays reference-stable (see the theme-store banner /
   * CONTRIBUTING "Zustand selectors" rule).
   */
  const rowHeight = usePreferences((s) => selectGridPrefs(s).rowHeight);
  const updateGrid = usePreferences((s) => s.updateGrid);

  /** User-rebindable combo for the "expand selected cell" hotkey (issue
   *  #78/#75). Subscribed as a primitive — `getBinding` returns a string,
   *  which Zustand compares by value, so this stays reference-stable. */
  const expandCellCombo = usePreferences((s) =>
    getBinding(s.prefs.keybindings, "expandSelectedCell"),
  );

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
   * Column currently being dragged to resize, if any — drives the header's
   * highlight + handle tint. Set on mousedown and cleared on mouseup, so it
   * changes exactly twice per drag (never per pixel), unlike the width
   * itself (see `startColumnResize` below).
   */
  const [resizingColId, setResizingColId] = useState<string | null>(null);
  const MIN_COLUMN_WIDTH = 40;
  /**
   * Ceiling for the auto-fit gesture below. A column holding a long free-text
   * value (a serialised config, a description paragraph) would otherwise
   * expand to several thousand px and push every column after it off-screen,
   * turning "let me read this one value" into "I lost the rest of the row".
   * Past this the value belongs in the cell editor / preview panel, and the
   * user can still drag wider by hand.
   */
  const MAX_AUTOFIT_WIDTH = 900;
  /** The header's dimmed type hint renders at the `text-3xs` token (10px). */
  const TYPE_HINT_FONT_SIZE = 10;

  /**
   * Drag a column's header edge to resize it — deliberately NOT TanStack's
   * own `getResizeHandler()`. That tracks the drag through
   * `columnSizingInfo.deltaOffset`, which changes (and forces a re-render of
   * this whole, unvirtualised table) on every single `mousemove`; with
   * hundreds/thousands of rows that's what made the drag feel slow, and it's
   * also why a resize used to need a separate full-height guideline line —
   * the actual column couldn't cheaply track the pointer that way, so there
   * was nothing to visually resize in real time.
   *
   * Instead this mutates the dragged `<th>`'s `style.width` directly. The
   * table is `table-fixed`, so per the CSS spec its column widths come from
   * the header row's cells alone (`<thead>` precedes `<tbody>`, making it the
   * table's first row) — one DOM write here reflows every row's matching
   * cell natively, with zero React re-renders, for a genuinely live preview.
   * `columnSizing` state (and its persistence to `prefs.json`) is only
   * touched once, on release, matching the perf goal the old `onEnd` mode
   * was reaching for — but without giving up live feedback to get there.
   */
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

  /**
   * Size a column to its widest *visible* value — HeidiSQL's double-click on
   * the column's edge, which is the gesture people reach for when a value is
   * clipped and they'd rather read it in place than open the cell editor.
   *
   * Widths are measured off-screen (`computeColumnFitWidth`) rather than by
   * letting the browser do it: the table is `table-fixed`, so there is no
   * `width: auto` shrink-to-fit pass to borrow — the declared header widths
   * *are* the layout, and a column's content never influences it. Measuring
   * the strings ourselves is also what keeps this honest about what's on
   * screen: the same formatting the `cell` renderer applies (BIT display
   * mode, the NULL placeholder, the `truncateLongTextAt` cap) is replayed
   * here, so the fit matches the rendered text and not the raw value.
   *
   * Scope is the rows currently in the grid (`visibleRows`, i.e. the fetched
   * page after the client filter), matching HeidiSQL: fitting to rows the
   * user can't see would need a full-table scan per double-click.
   */
  function autoFitColumns(colIds: readonly string[]) {
    const host = scrollRef.current;
    const cellFontSize = (cellStyle.fontSize as number) ?? 12;
    const headerFontSize = (headerStyle.fontSize as number) ?? 10;
    // Resolved once per gesture, not once per column: each call appends a
    // probe element and reads its computed style, which forces a style
    // recalc. The "fit every column" path would otherwise pay for 3× the
    // column count.
    const cellFont = resolveCanvasFont(host, "font-mono", cellFontSize);
    const headerFont = resolveCanvasFont(host, "", headerFontSize);
    const typeFont = resolveCanvasFont(host, "", TYPE_HINT_FONT_SIZE);

    const widths: Record<string, number> = {};
    for (const colId of colIds) {
      const idx = columnIndexByName.get(colId);
      if (idx === undefined) continue;
      const col = result.columns[idx];
      const isBit = bitColNames.has(col.name);
      const cells = visibleRows.map((row) => {
        const v = row[idx];
        if (v === null) return nullDisplay;
        const raw =
          isBit && typeof v === "number"
            ? formatBitValue(v, bitDisplay)
            : formatValue(v);
        return truncateLongTextAt > 0 && raw.length > truncateLongTextAt
          ? `${raw.slice(0, truncateLongTextAt)}…`
          : raw;
      });
      widths[colId] = computeColumnFitWidth({
        // The header renders `uppercase tracking-wider`; both change its
        // width, and neither is visible to `measureText` unless applied here.
        header: {
          text: col.name.toUpperCase(),
          font: headerFont,
          letterSpacing: headerFontSize * 0.05,
        },
        // The dimmed type hint is `text-3xs` (a fixed token), not derived
        // from the zoom like the rest of the header.
        type: {
          text: col.data_type.toUpperCase(),
          font: typeFont,
          letterSpacing: TYPE_HINT_FONT_SIZE * 0.05,
        },
        // gap before the type (4) + the sort glyph and its gap (16) + one key
        // icon and its gap per PK/FK badge (16 each).
        headerChrome:
          20 +
          (pkNameSet.has(col.name) ? 16 : 0) +
          (fkNameSet.has(col.name) ? 16 : 0) +
          // Multi-sort rank badge ("1", "2", …) next to the arrow.
          ((sort?.length ?? 0) > 1 && sort!.some((s) => s.column === col.name)
            ? 12
            : 0),
        cells,
        cellFont,
        // `px-2` on both the `<th>` and every `<td>`, plus the 1px right
        // border.
        padding: 17,
        min: MIN_COLUMN_WIDTH,
        max: MAX_AUTOFIT_WIDTH,
      });
    }
    // One state update (and therefore one `prefs.json` write) for the whole
    // gesture, however many columns it covered.
    if (Object.keys(widths).length > 0) {
      handleColumnSizingChange((prev) => ({ ...prev, ...widths }));
    }
  }

  /**
   * Live mirror of fkEditCell/inlineEdit/selectedCell, read by the `cell`
   * renderers below instead of closing over the state directly. TanStack's
   * `flexRender` treats `columnDef.cell` as a component TYPE (anything
   * `typeof === "function"` gets rendered as `<Comp {...props} />`), so if
   * these fast-changing values stayed in the `columns` memo's dependency
   * array, every keystroke of an inline edit would rebuild the entire
   * `columns` array with brand-new `cell` function references — React reads
   * that as a different element type for every cell and unmounts + remounts
   * the whole table body, including the input mid-edit. A freshly-mounted
   * `autoFocus` input always plants the caret at the end, which is exactly
   * the "cursor jumps to the end while typing" bug. Updating this ref every
   * render (not via effect) keeps `cell` seeing live state while its own
   * function identity — and therefore the mounted DOM — stays put.
   */
  const interactiveRef = useRef({ fkEditCell, inlineEdit, selectedCell });
  interactiveRef.current = { fkEditCell, inlineEdit, selectedCell };

  // Same idea, for `GridRow` (below): these are plain function declarations
  // recreated on every `DataGrid` render, so passing them as ordinary props
  // would make every row look "changed" on every render and defeat the
  // memoization `GridRow` exists for. See its own doc comment for the full
  // rationale.
  const rowCallbacksRef = useRef<GridRowCallbacks>({
    openCellEdit,
    openSidePanelEditor,
    copyToClipboard,
    bulkCopy,
    selectedColumnValues,
    applyRowSelectionClick,
    toggleRowKey,
  });
  rowCallbacksRef.current = {
    openCellEdit,
    openSidePanelEditor,
    copyToClipboard,
    bulkCopy,
    selectedColumnValues,
    applyRowSelectionClick,
    toggleRowKey,
  };

  // Resolve the relation's schema bindings once, when the grid mounts for a
  // table. One IPC call per data tab — never per cell, and never per render.
  const ensureResolvedSchemas = useJsonSchemas((s) => s.ensureResolved);
  const resolvedSchemas = useJsonSchemas((s) => s.resolved);
  const schemaRevision = useJsonSchemas((s) => s.revision);
  useEffect(() => {
    if (!tableName) return;
    void ensureResolvedSchemas(
      connectionId,
      tableSchema,
      tableName,
      result.columns.map((c) => c.name),
    );
    // `schemaRevision` re-runs it after any library change, since the store
    // clears the cache on every mutation.
  }, [
    connectionId,
    tableSchema,
    tableName,
    result.columns,
    ensureResolvedSchemas,
    schemaRevision,
  ]);

  /**
   * Name of the schema bound to `column`, or `null`.
   *
   * Only used to *signal* — the expand buttons swap their icon and tooltip so the
   * feature is discoverable without opening Settings. Double-click still goes to
   * the inline `CellInput` (gotcha #12 stands); only the icon changed.
   */
  const boundSchemaNames = useMemo(() => {
    if (!tableName) return new Map<string, string>();
    const key = relationKey(connectionId, tableSchema, tableName);
    const bucket = resolvedSchemas[key];
    if (!bucket) return new Map<string, string>();
    return new Map(Object.entries(bucket).map(([col, hit]) => [col, hit.name]));
  }, [connectionId, tableSchema, tableName, resolvedSchemas]);

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
          const info = columnInfoByName.get(col.name);
          // The tooltip describes the FIELD, not what a click does. Two
          // reasons: the name is the first thing a narrow column clips, so
          // the tooltip is where the user recovers it (plus the full type,
          // which is clipped even earlier — see the spans below); and the
          // old wording ("Ctrl/Cmd+click to add a column") was read as an
          // offer to CREATE a column, which is both wrong and alarming in a
          // window that can also run DDL. Sorting stays discoverable through
          // the arrow glyph and the sort state reported on the last line.
          const facts: string[] = [col.data_type];
          if (pkNameSet.has(col.name)) facts.push(t("dataGrid.headerPk"));
          if (fkNameSet.has(col.name)) {
            facts.push(
              info?.referenced_table
                ? t("dataGrid.headerFkTo", {
                    target: `${info.referenced_table}.${
                      info.referenced_column ?? "id"
                    }`,
                  })
                : t("dataGrid.headerFk"),
            );
          }
          // `info` is absent for ad-hoc query results (no catalog metadata),
          // where nullability is unknown — say nothing rather than guess.
          if (info) {
            facts.push(
              info.nullable
                ? t("dataGrid.headerNullable")
                : t("dataGrid.headerNotNull"),
            );
          }
          if (active) {
            const dir = spec!.desc
              ? t("dataGrid.headerSortedDesc")
              : t("dataGrid.headerSortedAsc");
            facts.push(
              showRank
                ? `${dir} (${t("dataGrid.headerSortLevel", {
                    level: sortIndex + 1,
                  })})`
                : dir,
            );
          }
          return (
            <button
              className="group/sort -mx-1 flex w-full items-center gap-1 rounded-sm px-1 hover:bg-accent/50 hover:text-foreground"
              onClick={(e) =>
                onSortChange?.(col.name, e.ctrlKey || e.metaKey)
              }
              title={`${col.name}\n${facts.join(" · ")}`}
            >
              {pkNameSet.has(col.name) && (
                <KeyRound
                  className="h-3 w-3 shrink-0 text-pk"
                  aria-label={t("dataGrid.headerPk")}
                />
              )}
              {fkNameSet.has(col.name) && (
                <KeyRound
                  className="h-3 w-3 shrink-0 text-fk"
                  aria-label={t("dataGrid.headerFk")}
                />
              )}
              {/* The NAME is the header's payload; the type is a hint. Both
                  used to be plain flex items with the default `flex-shrink:
                  1`, but only the name carried `truncate` — and `overflow:
                  hidden` is what lets a flex item shrink past its min-content
                  width. So in a column narrower than its content the name
                  collapsed to nothing while the type stayed fully legible
                  (a `BOOLEAN` column rendering as just "BOOL", with no clue
                  which field it was). Giving the type `overflow-hidden` +
                  a huge shrink factor inverts the priority: the type is
                  clipped away first (down to zero width) and the name only
                  starts eliding once the type is gone. `text-clip` rather
                  than an ellipsis because a lone "…" where the type used to
                  be is noise; the full type lives in the tooltip. */}
              <span className="min-w-0 truncate">{col.name}</span>
              <span className="min-w-0 shrink-[9999] overflow-hidden whitespace-nowrap text-clip text-3xs uppercase text-muted-foreground/50">
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
        // Only a starting point: `columnSizing` (persisted per table, or
        // in-session for ad-hoc results) always wins once the user resizes
        // a column, same as TanStack's own precedence.
        size: defaultColumnWidth(col.data_type) ?? undefined,
        cell: (info) => {
          const v = info.getValue() as CellValue;
          const rowValues = info.row.original as CellValue[];
          const colInfo = columnInfoByName.get(col.name);
          // Read live, not from the outer closure — see `interactiveRef` above.
          const { fkEditCell, inlineEdit, selectedCell } = interactiveRef.current;
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
                schemaBound={boundSchemaNames.has(inlineEdit.column.name)}
                expandTitle={
                  boundSchemaNames.has(inlineEdit.column.name)
                    ? t("dataGrid.expandEditorWithSchema", {
                        name: boundSchemaNames.get(inlineEdit.column.name),
                      })
                    : t("dataGrid.expandEditor")
                }
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
          // Selected-but-not-editing: offer a direct "expand" affordance so
          // the full value can be viewed (modal / side panel per
          // `cellEditorMode`) without first entering inline edit (issue #78).
          const isSelected =
            selectedCell?.rowValues === rowValues &&
            selectedCell.column.name === col.name;
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
              {isSelected && (
                <button
                  type="button"
                  tabIndex={-1}
                  title={`${t("dataGrid.expandEditor")} (${formatComboForDisplay(expandCellCombo)})`}
                  className="ml-auto shrink-0 rounded px-1 text-muted-foreground/80 hover:text-foreground"
                  onMouseDown={(e) => e.stopPropagation()}
                  onDoubleClick={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    openHeavyEditor(rowValues, col, rawDisplay);
                  }}
                >
                  <Maximize2 className="h-3 w-3" />
                </button>
              )}
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
      expandCellCombo,
      columnInfoByName,
      columnIndexByName,
      connectionId,
      tableSchema,
      onCellSave,
      boundSchemaNames,
      t,
    ],
  );

  const table = useReactTable({
    data: visibleRows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    // Column resizing itself is handled by our own `startColumnResize` below,
    // not TanStack's built-in `getResizeHandler()` — see the comment there for
    // why. `columnSizing` stays the single source of truth for committed
    // widths (persisted per table, gotcha-style — see `persistKey` above).
    state: { columnSizing },
    onColumnSizingChange: handleColumnSizingChange,
  });

  /**
   * Windows `<tbody>`'s rows so a large result (up to the backend's
   * `MAX_ADHOC_QUERY_ROWS` cap, or any bigger table-data page) never mounts
   * more than a couple dozen real `<tr>`s at once — see the file-header
   * comment; the previous "virtualised by the browser via overflow-auto" was
   * never true, every row was a real DOM node.
   *
   * `estimateSize` returns the *exact* row height (`rowHeight` is one
   * persisted px value applied uniformly via `cellStyle`, gotcha #13 — not an
   * estimate to refine later), so no `measureElement`/dynamic measurement is
   * needed; the padding-row technique below is exact from the first paint.
   */
  const tableRows = table.getRowModel().rows;
  const rowVirtualizer = useVirtualizer({
    count: tableRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 8,
  });
  // `estimateSize` alone doesn't retroactively resize rows the virtualizer
  // already cached a size for — `measure()` clears that cache so a Ctrl+wheel
  // zoom (which changes `rowHeight` without touching row *count*) takes
  // effect immediately instead of only on the next scroll.
  useEffect(() => {
    rowVirtualizer.measure();
  }, [rowHeight, rowVirtualizer]);

  /**
   * Coordinates for the JSON Schema cascade.
   *
   * All four axes are already props of this component; before this they were
   * dropped at the editor boundary, which is why a schema could not be bound at
   * all. `column.name` is the field's *dotted path* when the value came from the
   * document view (see `onExpandField`, which synthesises the column that way),
   * so a MongoDB nested binding needs nothing extra.
   *
   * Returns `undefined` without a table name: a query result has no column
   * identity, and a binding created there would be an accidental wildcard.
   */
  function bindingContextFor(
    column: ColumnMeta,
    field?: { path: string[]; type: string },
  ): CellBindingContext | undefined {
    if (!tableName) return undefined;
    return {
      connectionId,
      dbSchema: tableSchema,
      table: tableName,
      column: column.name,
      bsonType: field?.type,
    };
  }

  /** Open the heavyweight Monaco modal directly (read-only view, or the
   *  "expand" escalation from the inline editor / CellPreview). */
  function openModalEditor(
    rowValues: CellValue[],
    column: ColumnMeta,
    value: string,
    field?: { path: string[]; type: string },
  ) {
    setEditorTarget({ rowValues, column, value, field });
    setEditorOpen(true);
  }

  /** Open the cell in the docked right-side editor (JetBrains-style). Shares
   *  the same commit path as the modal (`onCellSave`), or read-only when the
   *  grid isn't editable. */
  function openSidePanelEditor(
    rowValues: CellValue[],
    column: ColumnMeta,
    value: string,
    field?: { path: string[]; type: string },
  ) {
    // A list-view field commits through `onFieldSave` (it may be nested and
    // carries its own type); a table cell through `onCellSave` as before.
    const canSave = !!(editable && (field ? onFieldSave : onCellSave));
    useCellEditor.getState().open({
      ownerId: tabId,
      columnName: column.name,
      value,
      binding: bindingContextFor(column, field),
      readonly: !canSave,
      onSave: canSave
        ? (v) =>
            field
              ? onFieldSave!(rowValues, field.path, v, field.type)
              : onCellSave!(rowValues, column.name, v)
        : undefined,
    });
    useSessionPanelLayout.getState().openSideEditor();
  }

  /** Escalate from inline/preview to the heavyweight editor, honouring the
   *  user's `cellEditorMode` preference (modal vs docked side panel). */
  function openHeavyEditor(
    rowValues: CellValue[],
    column: ColumnMeta,
    value: string,
    field?: { path: string[]; type: string },
  ) {
    if (cellEditorMode === "side") {
      openSidePanelEditor(rowValues, column, value, field);
    } else {
      openModalEditor(rowValues, column, value, field);
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

  /** Resolves the cell a Ctrl+C/Ctrl+V chord should act on: the mouse-selected
   *  cell (carries its value already) or, as a keyboard-only fallback, the
   *  active cell resolved the same way the Enter handler below does. */
  function resolveTargetCell(): {
    rowValues: CellValue[];
    column: ColumnMeta;
    value: CellValue;
  } | null {
    if (selectedCell) {
      return {
        rowValues: selectedCell.rowValues,
        column: selectedCell.column,
        value: selectedCell.value,
      };
    }
    if (activeCell) {
      const rows = table.getRowModel().rows;
      const row = rows[activeCell.r];
      const cell = row?.getVisibleCells()[activeCell.c];
      const bi = cell ? (columnIndexByName.get(cell.column.id) ?? -1) : -1;
      if (row && bi >= 0) {
        const rowValues = row.original as CellValue[];
        return { rowValues, column: result.columns[bi], value: rowValues[bi] };
      }
    }
    return null;
  }

  /** Ctrl+C copies the raw value (same as the context menu's "Copy"); Ctrl+V
   *  seeds `inlineEdit` with the pasted text so it flows through the existing
   *  commit/cancel path unchanged. FK/BIT columns have no free-text control to
   *  paste into, so paste is a no-op there (issue #79). */
  function handleCopyPasteChord(key: "c" | "v") {
    const cell = resolveTargetCell();
    if (!cell) return;
    if (key === "c") {
      copyToClipboard(formatValue(cell.value));
      return;
    }
    if (!editable || !onCellSave) return;
    const info = columnInfoByName.get(cell.column.name);
    if (info?.referenced_table || bitColNames.has(cell.column.name)) return;
    navigator.clipboard
      .readText()
      .then((text) => {
        const cur = cell.rowValues[columnIndexByName.get(cell.column.name) ?? -1];
        const original =
          cur === null || cur === undefined ? null : formatValue(cur);
        setInlineEdit({
          rowValues: cell.rowValues,
          column: cell.column,
          value: text,
          original,
        });
      })
      .catch(() => {
        // Clipboard read denied/unsupported in this webview — silent no-op,
        // matching copyToClipboard's own silent-failure convention below.
      });
  }

  /**
   * Grid-level keyboard navigation, bound to the (focusable) scroll container.
   * Moves the inset-ring active cell with the arrows / Home / End, opens the
   * editor on Enter, clears on Escape. The ring never animates its movement:
   * this fires on every keypress, so motion would read as lag (see the
   * keyboard-action rule). Guards: skip when an inline editor is open or focus
   * is inside a form control. Ctrl+C/Ctrl+V are the only modified chords this
   * handles itself; every other modified chord is left alone for the browser.
   */
  function handleGridKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const key = e.key.toLowerCase();
    const isCopyPasteChord =
      (e.ctrlKey || e.metaKey) &&
      !e.altKey &&
      !e.shiftKey &&
      (key === "c" || key === "v");
    const isExpandChord = matchesBinding(e, expandCellCombo);
    if (
      (e.ctrlKey || e.metaKey || e.altKey) &&
      !isCopyPasteChord &&
      !isExpandChord
    )
      return;
    if (inlineEdit || fkEditCell) return;
    const target = e.target as HTMLElement;
    if (target.closest("input, textarea, select, [contenteditable='true']")) {
      return;
    }
    if (isCopyPasteChord) {
      e.preventDefault();
      handleCopyPasteChord(key as "c" | "v");
      return;
    }
    if (isExpandChord) {
      e.preventDefault();
      const cell = resolveTargetCell();
      if (cell) {
        const isBit = bitColNames.has(cell.column.name);
        const rawDisplay =
          isBit && typeof cell.value === "number"
            ? formatBitValue(cell.value, bitDisplay)
            : formatValue(cell.value);
        openHeavyEditor(cell.rowValues, cell.column, rawDisplay);
      }
      return;
    }
    const rows = table.getRowModel().rows;
    const colCount = table.getVisibleLeafColumns().length;
    if (rows.length === 0 || colCount === 0) return;

    const focusCell = (r: number, c: number) => {
      setActiveCell({ r, c });
      setSelectedRowIndex(r);
      // With virtualized rows, target row `r` may have no DOM node at all
      // yet (it's outside the currently-mounted window) — `scrollToIndex`
      // mounts it (a no-op if it's already in view). Keep the cell in view
      // without smooth scrolling (instant per the no-motion-on-keyboard
      // rule); two nested frames give React's render (triggered by the
      // virtualizer's own scroll-driven state update) time to actually mount
      // the row before the `querySelector` below runs — a single frame can
      // race it on a jump of more than a screenful of rows.
      rowVirtualizer.scrollToIndex(r, { align: "auto" });
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          scrollRef.current
            ?.querySelector<HTMLElement>(`[data-cell="${r}-${c}"]`)
            ?.scrollIntoView({ block: "nearest", inline: "nearest" });
        });
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

  /**
   * Responsive toolbar. The bar is measured (not the viewport — the grid lives
   * in a dockview panel), and as it narrows actions move into a single
   * overflow menu instead of wrapping onto a second row, which is what used to
   * happen and left the filter cluster and the action cluster stacked.
   *
   * Two things collapse, in order of how much room they cost and how little
   * their absence hurts:
   * - `collapseData` — the labelled data actions (Insert plus the parent's
   *   import/export/bulk-update group). They carry text, so they're the widest
   *   things in the bar, and they're deliberate operations nobody triggers
   *   twice a minute.
   * - `collapseChrome` — the icon-only controls: the parent's leading cluster
   *   (refresh, advanced filter) and the view controls (fit columns, the
   *   table/list toggle). Cheap in pixels, frequently used, so they only go
   *   when the pane is genuinely too narrow for anything but the search box.
   */
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const density = useToolbarDensity(toolbarRef);
  const collapseData = density !== "wide";
  const collapseChrome = density === "narrow";

  /**
   * The grid's own toolbar actions, in the same two-presentation shape the
   * parent's slots use (`GridToolbarItem`) so the bar and the overflow menu
   * are built from one list each. `null` when the action doesn't apply — no
   * insert callback, or list view, which has no columns to fit. Insert itself
   * *is* offered in list view: the draft is drawn as a card there (see
   * `DraftDocumentCard`) and commits through the same `insert_row` call.
   */
  const insertItem: GridToolbarItem | null = onInsertRow
    ? {
        id: "insert",
        bar: (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-xs"
            onClick={onInsertRow}
            title={t("dataGrid.insertNewRow")}
          >
            <Plus className="h-3.5 w-3.5" />
            {t("dataGrid.insert")}
          </Button>
        ),
        menu: (
          <DropdownMenuItem className="text-xs" onSelect={onInsertRow}>
            <Plus className="mr-2 h-3.5 w-3.5" />
            {t("dataGrid.insertNewRow")}
          </DropdownMenuItem>
        ),
      }
    : null;

  // Same auto-fit as double-clicking a column's edge, applied to every column
  // — the discoverable form of that gesture.
  const fitItem: GridToolbarItem | null =
    viewMode !== "list" && result.columns.length > 0
      ? {
          id: "fit-columns",
          bar: (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => autoFitColumns(result.columns.map((c) => c.name))}
              title={t("dataGrid.fitColumns")}
              aria-label={t("dataGrid.fitColumns")}
            >
              <UnfoldHorizontal className="h-3.5 w-3.5" />
            </Button>
          ),
          menu: (
            <DropdownMenuItem
              className="text-xs"
              onSelect={() => autoFitColumns(result.columns.map((c) => c.name))}
            >
              <UnfoldHorizontal className="mr-2 h-3.5 w-3.5" />
              {t("dataGrid.fitColumns")}
            </DropdownMenuItem>
          ),
        }
      : null;

  /**
   * What the overflow menu holds right now, grouped so the menu keeps the
   * bar's reading order (leading · data · view) with a separator between
   * groups. Empty groups are dropped, and an empty result hides the trigger
   * altogether — a `⋯` that opens nothing is worse than no `⋯`.
   */
  const overflowGroups: { id: string; items: GridToolbarItem[] }[] = [
    { id: "leading", items: collapseChrome ? (toolbarLeading ?? []) : [] },
    {
      id: "data",
      items: collapseData
        ? [...(insertItem ? [insertItem] : []), ...(insertExtra ?? [])]
        : [],
    },
    {
      id: "view",
      items: collapseChrome
        ? [...(fitItem ? [fitItem] : []), ...(toolbarTrailing ?? [])]
        : [],
    },
  ].filter((g) => g.items.length > 0);

  /**
   * The two readouts (row count, elapsed time) are squeezed out of the bar
   * before anything else — nobody acts on them — but only when the overflow
   * menu exists to keep showing them. A query-result tab passes no toolbar
   * slots and has no insert action, so at `compact` it has nothing to collapse
   * and therefore no `⋯`; hiding the timing there would delete it outright,
   * and the timing is precisely what you're watching on an ad-hoc query.
   */
  const hasOverflow = overflowGroups.length > 0;
  const rowCountInBar = density !== "narrow" || !hasOverflow;
  const elapsedInBar = density === "wide" || !hasOverflow;

  return (
    // `relative` allows CellPreview to be positioned absolute within this container.
    <div className="relative flex h-full flex-col">
      {/* Toolbar layout: leading actions (refresh · advanced filter) · growing
          search box · filter chips  ——  then, right-aligned via the cluster's
          `ml-auto`: Insert · insertExtra (TableDataTab's Add/Export
          data/Bulk update, grouped right beside Insert) · optional row count ·
          fit columns · trailing slot (view toggle) · elapsed time · overflow
          menu. The search box flex-grows (capped) so it's the visual anchor on
          the left; every action that adds, exports, or mass-edits data lives
          together on the right instead of crowding the filter cluster.

          As the pane narrows, actions leave the bar for the overflow menu
          instead of wrapping onto a second row (`density`, measured on this
          element): at `compact` the labelled data actions go, at `narrow`
          everything but the search box does. `flex-wrap` is kept as a safety
          net for the cases the breakpoints can't predict (a very long filter
          chip, a future action), not as the normal behaviour. */}
      <div
        ref={toolbarRef}
        className="flex flex-wrap items-center gap-2 border-b border-border bg-background px-3 py-1.5 text-xs"
      >
        {!collapseChrome && toolbarLeading?.map((item) => (
          <Fragment key={item.id}>{item.bar}</Fragment>
        ))}
        {!collapseChrome && toolbarLeading && toolbarLeading.length > 0 && (
          <div className="h-4 w-px shrink-0 bg-border" aria-hidden />
        )}
        <GridSearchInput
          value={filterInput ?? globalFilter ?? ""}
          onChange={onGlobalFilterChange}
          onSubmit={onGlobalFilterSubmit}
          history={searchHistory ?? []}
        />
        {/* Active server-side filters. They're content, not actions, so they
            don't take part in the overflow-menu collapse above — but N chips
            are the single widest thing in the bar (each one spells out
            `column op value`), so from `compact` down they fold into one
            summary chip whose dropdown still removes them individually.
            Collapsing them only at `narrow` was measured and wasn't enough:
            two chips still pushed a 700 px pane onto a second row, which is
            the exact wrap this whole mechanism exists to prevent. */}
        {serverFilters && serverFilters.length > 0 && (
          density !== "wide" ? (
            <ServerFilterSummary
              filters={serverFilters}
              onRemove={onRemoveFilter}
            />
          ) : (
            serverFilters.map((f, i) => (
              <ServerFilterChip
                key={`${f.column}-${f.op}-${i}`}
                filter={f}
                onRemove={onRemoveFilter && (() => onRemoveFilter(i))}
              />
            ))
          )
        )}
        {/* Right-aligned cluster. `ml-auto` opens the gap between the growing
            search box (+ filter chips) on the left and this group. Contents:
            Insert · insertExtra (TableDataTab's Add/Export data/Bulk update)
            · optional row count (query/view tabs) · trailing slot (view
            toggle) · elapsed time. Wrapped so the whole group wraps as a unit
            on narrow panes. */}
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          {!collapseData && insertItem?.bar}
          {!collapseData &&
            insertExtra?.map((item) => (
              <Fragment key={item.id}>{item.bar}</Fragment>
            ))}
          {showRowCount && rowCountInBar && (
            <span className="tabular-nums text-muted-foreground">
              <span className="font-medium text-foreground">
                {formatNumber(visibleRows.length)}
              </span>{" "}
              {t("dataGrid.rows")}
              {result.total !== null && result.total !== undefined && (
                <>
                  {" "}
                  {t("dataGrid.of")}{" "}
                  <span className="font-medium text-foreground">
                    {formatNumber(result.total)}
                  </span>
                </>
              )}
            </span>
          )}
          {/* Never gated by `showRowCount`/collapse — this is a warning about
              missing data, not a "nice to have" readout, so it stays visible
              even when the toolbar is squeezed. See `MAX_ADHOC_QUERY_ROWS`
              in `src-tauri/src/commands/query.rs`. */}
          {result.truncated && (
            <span
              className="flex items-center gap-1 rounded border border-warning/40 bg-warning/10 px-1.5 py-0.5 text-xs font-medium text-warning"
              title={t("dataGrid.truncatedHint")}
            >
              <AlertTriangle className="h-3 w-3 shrink-0" />
              {t("dataGrid.truncated")}
            </span>
          )}
          {!collapseChrome && fitItem?.bar}
          {!collapseChrome &&
            toolbarTrailing?.map((item) => (
              <Fragment key={item.id}>{item.bar}</Fragment>
            ))}
          {/* The timing is the first thing to go: it's a readout nobody acts
              on, and the overflow menu keeps showing it (with the row count)
              once either is squeezed out of the bar. */}
          {elapsedInBar && (
            <span
              className={cn(
                "tabular-nums",
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
          )}
          {overflowGroups.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  title={t("dataGrid.moreActions")}
                  aria-label={t("dataGrid.moreActions")}
                >
                  <MoreHorizontal className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[13rem]">
                {overflowGroups.map((group, gi) => (
                  <Fragment key={group.id}>
                    {gi > 0 && <DropdownMenuSeparator />}
                    {group.items.map((item) => (
                      <Fragment key={item.id}>{item.menu}</Fragment>
                    ))}
                  </Fragment>
                ))}
                {/* Readouts the bar no longer has room for. Not menu items —
                    there's nothing to select — just the numbers, so collapsing
                    the toolbar never hides information outright. */}
                {(!elapsedInBar || (showRowCount && !rowCountInBar)) && (
                  <>
                    <DropdownMenuSeparator />
                    <div className="px-2 py-1 text-xs tabular-nums text-muted-foreground">
                      {showRowCount && !rowCountInBar && (
                        <>
                          {formatNumber(visibleRows.length)}{" "}
                          {t("dataGrid.rows")}
                          {result.total !== null &&
                            result.total !== undefined &&
                            ` ${t("dataGrid.of")} ${formatNumber(result.total)}`}
                          {!elapsedInBar && " · "}
                        </>
                      )}
                      {!elapsedInBar && `${result.elapsed_ms} ms`}
                    </div>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
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
        onKeyDown={viewMode === "list" ? undefined : handleGridKeyDown}
        // Close the cell preview when clicking outside the table cells.
        onClick={() => setSelectedCell(null)}
      >
        {viewMode === "list" ? (
          <DocumentListView
            columns={result.columns}
            rows={visibleRows}
            rowTypes={result.row_types}
            nullDisplay={nullDisplay}
            zebraStripes={zebraStripes}
            fontSize={cellStyle.fontSize}
            expandNested={listExpandNested}
            showTypes={listShowTypes}
            lineNumbers={listLineNumbers}
            onFieldSave={editable ? onFieldSave : undefined}
            onFieldDelete={editable ? onFieldDelete : undefined}
            onDeleteRow={onDeleteRow}
            onExpandField={(rowValues, path, value, type) =>
              openHeavyEditor(
                rowValues,
                // Synthetic column: the heavy editor only reads the name (as
                // its title) and the commit is routed by `field` below.
                { name: path.join("."), data_type: type },
                value,
                { path, type },
              )
            }
            copyToClipboard={copyToClipboard}
            emptyLabel={t("dataGrid.noRows")}
            draft={
              draftRow && onDraftCellChange && onDraftCommit && onDraftCancel
                ? {
                    row: draftRow,
                    columns: draftColumns ?? [],
                    // Same switch the cards use: only the MongoDB tab supplies
                    // the `$unset` callback, and only there is a field's type a
                    // per-document choice.
                    documentMode: !!onFieldDelete,
                    bitDisplay,
                    connectionId,
                    tableSchema,
                    focusRef: firstDraftInputRef,
                    onChange: onDraftCellChange,
                    onCommit: onDraftCommit,
                    onCancel: onDraftCancel,
                  }
                : null
            }
          />
        ) : (
        <>
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
                  className="border-b border-border border-r border-r-border bg-card px-2 py-1 font-semibold uppercase tracking-wider text-muted-foreground"
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
                    data-col-id={h.column.id}
                    className={cn(
                      // Slightly elevated surface (`card` over the grid's
                      // `background`) + semibold, per the brand language: the
                      // header is a label strip, not another data row.
                      "relative border-b border-border border-r border-r-border bg-card px-2 py-1 font-semibold uppercase tracking-wider text-muted-foreground transition-colors duration-150",
                      resizingColId === h.column.id && "bg-brand/10",
                    )}
                    style={{ ...headerStyle, width: h.getSize() }}
                  >
                    <div className="overflow-hidden">
                      {flexRender(h.column.columnDef.header, h.getContext())}
                    </div>
                    {/* Drag handle — thin strip on the column's trailing edge.
                        `select-none` stops text selection while dragging. */}
                    <div
                      onMouseDown={(e) =>
                        startColumnResize(e, h.column.id, h.column.getSize())
                      }
                      // Double-click = fit the column to its content
                      // (HeidiSQL), Ctrl/Cmd held = fit every column at once.
                      // Routed through `click` + `detail`, not `onDoubleClick`:
                      // some Linux WebKitGTK builds never fire `dblclick`
                      // inside a `user-select: none` subtree (this table sets
                      // it globally), the same quirk the cells work around —
                      // see the `e.detail >= 2` note in `GridRow`.
                      onClick={(e) => {
                        if (e.detail < 2) return;
                        e.preventDefault();
                        e.stopPropagation();
                        autoFitColumns(
                          e.ctrlKey || e.metaKey
                            ? result.columns.map((c) => c.name)
                            : [h.column.id],
                        );
                      }}
                      title={t("dataGrid.resizeHandleHint")}
                      className={cn(
                        "absolute right-0 top-0 h-full w-1.5 cursor-col-resize select-none hover:bg-brand/50",
                        resizingColId === h.column.id && "bg-brand",
                      )}
                    />
                  </th>
                ))}
                {/* Filler column: absorbs any leftover width itself, so
                    real columns never get proportionally stretched by the
                    browser's fixed-table-layout algorithm (which otherwise
                    makes a resized column's rendered width outrun the
                    cursor — see `startColumnResize`). Needs a matching
                    empty cell in every row below, not just here. */}
                <th className="border-b border-border bg-card" />
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
            {(() => {
              const virtualRows = rowVirtualizer.getVirtualItems();
              // +2: the gutter column and the filler `<th>`'s matching `<td>`
              // (see the header's own comment on the filler column).
              const colSpan = result.columns.length + 2;
              return (
                <>
                  {virtualRows.length > 0 && (
                    <tr aria-hidden>
                      <td
                        colSpan={colSpan}
                        style={{ height: virtualRows[0].start, padding: 0, border: 0 }}
                      />
                    </tr>
                  )}
                  {virtualRows.map((virtualRow) => {
                    const i = virtualRow.index;
                    const row = tableRows[i];
                    // `rowValues` is the underlying payload (CellValue[]) for
                    // this row — used to resolve identity below rather than
                    // `i`, which is the *filtered display index*.
                    const rowValues = row.original as CellValue[];
                    const rowKey = selectionEnabled
                      ? (getRowKey?.(rowValues) ?? null)
                      : null;
                    // Every prop below is narrowed to "does this concern THIS
                    // row" (isSelected/isMultiSelected/activeColIdx/inlineEditHere)
                    // or already stable across a plain click, so `GridRow`'s
                    // `React.memo` skips re-rendering every row except the (at
                    // most two) actually affected — see `GridRow`'s doc comment.
                    return (
                      <GridRow
                        key={row.id}
                        row={row}
                        rowIndex={i}
                        isSelected={selectedRowIndex === i}
                        isMultiSelected={rowKey !== null && selectedKeys.has(rowKey)}
                        rowKey={rowKey}
                        activeColIdx={activeCell?.r === i ? activeCell.c : null}
                        inlineEditHere={
                          inlineEdit && inlineEdit.rowValues === rowValues
                            ? inlineEdit
                            : null
                        }
                        selectionEnabled={selectionEnabled}
                        hasSelection={hasSelection}
                        selectedRows={selectedRows}
                        zebraStripes={zebraStripes}
                        cellStyle={cellStyle}
                        resultColumns={result.columns}
                        columnIndexByName={columnIndexByName}
                        columnInfoByName={columnInfoByName}
                        driver={driver}
                        tableName={tableName}
                        tableSchema={tableSchema}
                        pkColumnNames={pkColumnNames}
                        editable={editable}
                        onCellSave={onCellSave}
                        onNavigateFk={onNavigateFk}
                        onAddFilter={onAddFilter}
                        onInsertRow={onInsertRow}
                        onDuplicateRow={onDuplicateRow}
                        onDeleteRow={onDeleteRow}
                        onBulkDelete={onBulkDelete}
                        scrollRef={scrollRef}
                        setSelectedRowIndex={setSelectedRowIndex}
                        setActiveCell={setActiveCell}
                        setSelectedCell={setSelectedCell}
                        callbacksRef={rowCallbacksRef}
                      />
                    );
                  })}
                  {virtualRows.length > 0 && (
                    <tr aria-hidden>
                      <td
                        colSpan={colSpan}
                        style={{
                          height:
                            rowVirtualizer.getTotalSize() -
                            virtualRows[virtualRows.length - 1].end,
                          padding: 0,
                          border: 0,
                        }}
                      />
                    </tr>
                  )}
                </>
              );
            })()}
            {visibleRows.length === 0 && !draftRow && (
              <tr>
                <td colSpan={result.columns.length + 2}>
                  <EmptyState
                    size="sm"
                    icon={Inbox}
                    title={t("dataGrid.noRows")}
                    className="h-auto"
                  />
                </td>
              </tr>
            )}
          </tbody>
        </table>
        </>
        )}
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

      {/* Footer: "how you're browsing" (zoom · pagination), kept apart from
          the header's "what you're doing to the data" actions. No
          `justify-end` here — the caller anchors its own left (zoom) and
          right (pagination) groups so they land on opposite edges instead of
          bunching together. Omitted entirely when the caller has nothing to
          put here (query/view result tabs, which don't paginate). */}
      {footer && (
        <div className="flex flex-wrap items-center gap-2 border-t border-border bg-background px-3 py-1.5 text-xs">
          {footer}
        </div>
      )}

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
          ownerId={tabId}
          binding={bindingContextFor(editorTarget.column, editorTarget.field)}
          readonly={
            !editable || !(editorTarget.field ? onFieldSave : onCellSave)
          }
          onSave={
            editable && (editorTarget.field ? onFieldSave : onCellSave)
              ? async (newValue) => {
                  const field = editorTarget.field;
                  if (field) {
                    await onFieldSave!(
                      editorTarget.rowValues,
                      field.path,
                      newValue,
                      field.type,
                    );
                  } else {
                    await onCellSave!(
                      editorTarget.rowValues,
                      editorTarget.column.name,
                      newValue,
                    );
                  }
                }
              : undefined
          }
        />
      )}
    </div>
  );
}

