/**
 * Tab body for browsing one database table. Loads pages via
 * `api.fetchTableData`, supports sort + server-side column filters +
 * row mutations (insert / duplicate / delete), and routes cell edits
 * to `api.updateCell` (requires a PK column to be present in the
 * result set).
 *
 * Insert / Duplicate model: rather than a dialog, the grid renders an
 * inline draft row pinned to the top. The user fills cells like in
 * HeidiSQL — Tab moves between fields, Esc cancels, and clicking
 * outside the row (or pressing Enter) commits the INSERT. If the
 * backend rejects the row, the draft survives with an inline error so
 * the user can fix and retry without losing what they typed.
 *
 * Filtering model: the toolbar input applies a server-side "any column
 * contains" search (case-insensitive `LIKE`/`ILIKE`), committed on
 * Enter (or via the history dropdown / clear button) so each keystroke
 * does not refetch and the history dropdown only collects deliberate
 * queries. The grid's right-click "Filter by this value" pushes
 * structured `ColumnFilter` entries onto `serverFilters`, which
 * compose with the search via `AND`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  ListFilter,
  Loader2,
  RefreshCw,
  ReplaceAll,
  Rows3,
  Table2,
  Upload,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { api } from "@/lib/tauri";
import { useSchema } from "@/stores/session/schema";
import { useTabs } from "@/stores/session/tabs";
import { useFilterHistory } from "@/stores/grid/filterHistory";
import { useConnections } from "@/stores/session/connections";
import { tableTabTitle } from "@/lib/connectionLabel";
import { useGridSelection } from "@/stores/grid/gridSelection";
import {
  usePreferences,
  selectGridPrefs,
} from "@/stores/preferences/preferences";
import { confirmDestructive } from "@/lib/confirmDestructive";
import type {
  CellValue,
  ColumnFilter,
  DraftCell,
  DraftRow,
  QueryResult,
  RowValue,
  SortSpec,
} from "@/types";
import { DataGrid, type GridToolbarItem } from "@/components/grid/DataGrid";
import { AdvancedFilterDialog } from "@/components/grid/dialogs/AdvancedFilterDialog";
import { BulkUpdateDialog } from "@/components/grid/dialogs/BulkUpdateDialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown";
import { PAGE_SIZE_OPTIONS } from "@/lib/constants";
import {
  registerTableRefresh,
  unregisterTableRefresh,
} from "@/lib/grid/tableRefresh";

interface Props {
  /** The owning tab's id — used to scope the grid-selection report. */
  tabId: string;
  connectionId: string;
  schema?: string;
  table: string;
}

interface PendingDelete {
  /**
   * One tuple per row to delete, each parallel to `pkColumns`. A single-row
   * delete is just a one-element list, so the confirmation dialog and the
   * `deleteRows` call handle one and many rows through the same path.
   */
  pkValueRows: CellValue[][];
}

/** Build an empty draft (all cells untouched / NULL). */
function emptyDraft(columnNames: string[]): DraftRow {
  const cells: Record<string, DraftCell> = {};
  for (const c of columnNames) {
    cells[c] = { value: null, touched: false };
  }
  return { cells, error: null, saving: false };
}

/**
 * Build a draft prefilled from an existing row (for Duplicate). Auto-PK
 * columns (PK whose type contains int/serial/rowid) are left untouched
 * so the database picks the next value.
 */
function duplicateDraft(
  resultColumns: string[],
  values: CellValue[],
  pkColumn:
    | { name: string; is_primary_key: boolean; data_type: string }
    | undefined,
): DraftRow {
  const cells: Record<string, DraftCell> = {};
  const pkIsAuto =
    pkColumn &&
    pkColumn.is_primary_key &&
    /int|serial|rowid/i.test(pkColumn.data_type);
  for (let i = 0; i < resultColumns.length; i++) {
    const name = resultColumns[i];
    if (pkIsAuto && pkColumn?.name === name) {
      cells[name] = { value: null, touched: false };
      continue;
    }
    const v = values[i];
    if (v === null || v === undefined) {
      cells[name] = { value: null, touched: true };
    } else {
      const s = typeof v === "object" ? JSON.stringify(v) : String(v);
      cells[name] = { value: s, touched: true };
    }
  }
  return { cells, error: null, saving: false };
}

/**
 * Compute the next sort state from a header click.
 *
 * - **Plain click** (`additive === false`): collapse to a single key on
 *   `column`, cycling its direction ASC → DESC → none (clicking a third time,
 *   or while already multi-sorted, resets to that one column ascending).
 * - **Ctrl/Cmd+click** (`additive === true`): keep the existing keys and add
 *   `column` as the lowest-precedence level (ASC); if it's already present,
 *   cycle it ASC → DESC → removed in place.
 */
function nextSort(
  current: SortSpec[],
  column: string,
  additive: boolean,
): SortSpec[] {
  const existing = current.find((s) => s.column === column);
  if (additive) {
    if (!existing) return [...current, { column, desc: false }];
    if (!existing.desc)
      return current.map((s) =>
        s.column === column ? { ...s, desc: true } : s,
      );
    return current.filter((s) => s.column !== column);
  }
  // Plain click: a single-key cycle, ignoring any multi-sort already active.
  if (!existing || current.length > 1) return [{ column, desc: false }];
  if (!existing.desc) return [{ column, desc: true }];
  return [];
}

export function TableDataTab({ tabId, connectionId, schema, table }: Props) {
  const reportSelection = useGridSelection((s) => s.report);
  const clearSelection = useGridSelection((s) => s.clear);
  // Drop this tab's selection entry when the tab unmounts (close /
  // disconnect) so the status bar never reads a stale count.
  useEffect(() => () => clearSelection(tabId), [tabId, clearSelection]);
  const loadColumns = useSchema((s) => s.loadColumns);
  // Resolve the driver for this connection — needed by the DataGrid so
  // its "Copy as SQL …" snippets use the right identifier quoting
  // (backticks for MySQL, double quotes for PG/SQLite). Multi-DB
  // synthetic child IDs (`<parent>::db::<name>`) inherit the parent's
  // driver, matching the lookup already done by SchemaExplorer.
  const driver = useConnections((s) => {
    const direct = s.profiles.find((p) => p.id === connectionId);
    if (direct) return direct.driver;
    const sep = connectionId.indexOf("::db::");
    if (sep > 0) {
      const parent = s.profiles.find(
        (p) => p.id === connectionId.slice(0, sep),
      );
      if (parent) return parent.driver;
    }
    return undefined;
  });
  const tableKey = `${schema ?? ""}.${table}`;
  // Subscribe to THIS tab's own column entry, not the whole per-connection
  // `columns` map. `loadColumns` (schema.ts) writes a new map reference on
  // every table load (any table, any tab), so subscribing to the map made
  // every already-open table tab on the connection re-render whenever a
  // sibling tab loaded its columns — harmless on its own (this entry stays
  // reference-stable so the effect below still no-ops), but with several
  // tabs open on the same connection each one paid a full re-render for
  // every unrelated tab's first load, which is what made opening tab N+1
  // feel like it was reloading everything instead of just the new table.
  const cols = useSchema(
    (s) => s.byConnection[connectionId]?.columns[tableKey],
  );

  const [result, setResult] = useState<QueryResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  // Row total for the pagination footer, fetched out-of-band from the data
  // page (see `refreshCount`) so an exact `COUNT(*)` never gates the first
  // rows. `null` while the count is in flight (footer shows the range without
  // "/ N"); `totalEstimated` flags a fast engine estimate, rendered as `~N`.
  const [total, setTotal] = useState<number | null>(null);
  const [totalEstimated, setTotalEstimated] = useState(false);
  // Seed the page size from the user's `defaultPageSize` preference. Lazy
  // initialiser: prefs are hydrated before the UI mounts, and the value is a
  // per-tab starting point the dropdown can override — so we deliberately do
  // not subscribe to live changes here.
  const [pageSize, setPageSize] = useState<number>(
    () => usePreferences.getState().prefs.grid.defaultPageSize,
  );
  // Merge the current page size into the dropdown choices so a custom
  // `defaultPageSize` (e.g. 300) still renders a selected option.
  const pageSizeOptions = useMemo(
    () =>
      Array.from(new Set<number>([...PAGE_SIZE_OPTIONS, pageSize])).sort(
        (a, b) => a - b,
      ),
    [pageSize],
  );
  /**
   * Multi-column sort, in precedence order (`sort[0]` is the primary key).
   * A plain header click replaces it with a single key; Ctrl/Cmd+click adds
   * (or cycles) a level. See [[applySort]].
   */
  /**
   * View state restored with the tab (#112). Read once, at mount: from here on
   * the `useState` values below are the working copy and this component pushes
   * changes back out via `setViewState`, so reading it reactively would fight
   * its own writes.
   */
  const restoredViewState = useRef(
    useTabs.getState().tabs.find((t) => t.id === tabId)?.viewState,
  ).current;
  /**
   * "table" vs "list" row layout — this tab's own choice (#131), not a global
   * preference: two windows (or two tabs on the same table) must be able to
   * show it differently. Falls back to the `GridPrefs.documentViewMode`
   * default only when this tab has never had one set, read once here — same
   * non-reactive, read-once-at-mount treatment as `restoredViewState` itself,
   * so a later change to the global default (or another tab's toggle) never
   * yanks an already-open tab.
   */
  const [documentViewMode, setDocumentViewMode] = useState<"table" | "list">(
    () =>
      restoredViewState?.documentViewMode ??
      usePreferences.getState().prefs.grid.documentViewMode,
  );
  const [sort, setSort] = useState<SortSpec[]>(
    () => restoredViewState?.sort ?? [],
  );
  /** Free-text search bound to the toolbar input (uncommitted draft). */
  const [filter, setFilter] = useState(() => restoredViewState?.search ?? "");
  /** Advanced per-column filter builder dialog (#66). */
  const [advancedOpen, setAdvancedOpen] = useState(false);
  /** What was actually committed via Enter — drives the backend fetch. */
  const [appliedFilter, setAppliedFilter] = useState(
    () => restoredViewState?.search ?? "",
  );
  // Seed filters from the tab's `initialFilters` (set by FK "go to referenced
  // row" navigation) so the table lands pre-filtered to the master record.
  const tabInitialFilters = useTabs(
    (s) => s.tabs.find((t) => t.id === tabId)?.initialFilters,
  );
  const [serverFilters, setServerFilters] = useState<ColumnFilter[]>(
    // FK navigation wins over the restored set: it is an explicit gesture the
    // user just made, while the restored filters are last session's leftovers.
    () => tabInitialFilters ?? restoredViewState?.filters ?? [],
  );
  // Re-apply when a *new* `initialFilters` array arrives — i.e. the user
  // navigated via FK into a table tab that was already open. The initial mount
  // already seeded `serverFilters` above, so the ref starts at that value and
  // the effect skips it; only a later, distinct array triggers a refilter.
  const appliedInitialRef = useRef(tabInitialFilters);
  useEffect(() => {
    if (tabInitialFilters && tabInitialFilters !== appliedInitialRef.current) {
      appliedInitialRef.current = tabInitialFilters;
      setServerFilters(tabInitialFilters);
      setOffset(0);
    }
  }, [tabInitialFilters]);

  // Publish the committed view state onto the tab so it persists with it
  // (#112, #131). Driven off the same values the backend fetch uses (plus
  // `documentViewMode`, which is purely a display choice), so what is saved is
  // always what was actually applied — never the uncommitted toolbar draft.
  // `setViewState` skips no-op writes, which keeps this from scheduling a disk
  // save on every unrelated re-render.
  const setViewState = useTabs((s) => s.setViewState);
  useEffect(() => {
    setViewState(tabId, {
      filters: serverFilters.length > 0 ? serverFilters : undefined,
      sort: sort.length > 0 ? sort : undefined,
      search: appliedFilter || undefined,
      documentViewMode,
    });
  }, [setViewState, tabId, serverFilters, sort, appliedFilter, documentViewMode]);

  const pushHistory = useFilterHistory((s) => s.push);
  const filterHistory = useFilterHistory((s) => s.byConnection[connectionId]);

  const { t } = useTranslation();
  /**
   * Persisted grid "zoom". The same `gridPrefs.rowHeight` the DataGrid reads;
   * the toolbar +/− buttons nudge it (Ctrl+wheel over the grid does the same).
   * Subscribed as a primitive so the selector stays reference-stable.
   */
  const rowHeight = usePreferences((s) => selectGridPrefs(s).rowHeight);
  const updateGrid = usePreferences((s) => s.updateGrid);
  const isMongo = driver === "mongodb";
  const zoomRows = useCallback(
    (delta: number) =>
      updateGrid({ rowHeight: Math.min(40, Math.max(14, rowHeight + delta)) }),
    [rowHeight, updateGrid],
  );

  /**
   * Apply the supplied value: refetch from page 0 and, if the query is
   * non-trivial, record it in the per-connection history. The value is
   * passed explicitly (rather than read from `filter`) so callers can
   * commit a value that `setFilter` hasn't flushed yet — e.g. picking a
   * history entry or hitting the clear button.
   */
  function submitFilter(value: string) {
    setAppliedFilter(value);
    setOffset(0);
    if (value.trim().length >= 2) {
      pushHistory(connectionId, value);
    }
  }

  const searchColumns = useMemo(() => cols?.map((c) => c.name) ?? [], [cols]);

  /** Apply a header click to the sort state and refetch from page 0 (a new
   *  ordering shouldn't leave the user stranded mid-table). */
  const applySort = useCallback((column: string, additive: boolean) => {
    setSort((current) => nextSort(current, column, additive));
    setOffset(0);
  }, []);

  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(
    null,
  );
  const [draft, setDraft] = useState<DraftRow | null>(null);
  const [bulkUpdateOpen, setBulkUpdateOpen] = useState(false);

  /**
   * Every column that participates in the table's PRIMARY KEY, in
   * catalog order. Composite PKs surface multiple entries here; tables
   * without a PK yield an empty list (data is read-only in that case).
   *
   * Using `find` instead of `filter` here used to silently corrupt data
   * on composite-PK tables: the cell-save path would send only the
   * leading column to `update_cell`, and the backend's
   * `WHERE first_pk_col = ?` predicate would match every row sharing
   * that leading value. Always operate on the full list.
   */
  const pkColumns = useMemo(
    () => cols?.filter((c) => c.is_primary_key) ?? [],
    [cols],
  );
  /** Convenience: the first PK column, used for snippet generation and
   *  the (legacy) `RETURNING <pk>` hint on inserts. Do NOT use this for
   *  any UPDATE/DELETE predicate — that needs the full `pkColumns`. */
  const pkColumn = pkColumns[0];
  /** Single-column FK columns, for the grid header key icon (presentational). */
  const fkColumnNames = useMemo(
    () => cols?.filter((c) => c.referenced_table).map((c) => c.name) ?? [],
    [cols],
  );

  // Signature (connection + relation + predicate) the current total was
  // computed for. The count depends only on the WHERE predicate, so
  // sort/offset/page changes reuse it and never re-count; the count request is
  // deduped on this key (StrictMode remount + transient dep-identity changes).
  const countInflightRef = useRef<string | null>(null);

  // `searchColumns` is derived from `cols`, which loads asynchronously after
  // mount. Listing it in `fetchData`'s deps recreated the callback the instant
  // columns arrived, re-firing the `[fetchData]` effect and issuing a second,
  // identical COUNT+SELECT on table open (issue #41). It's only ever sent when
  // a search filter is active, so read it lazily through a ref instead of
  // depending on its identity.
  const searchColumnsRef = useRef(searchColumns);
  searchColumnsRef.current = searchColumns;

  // Signature of the request currently on the wire. React StrictMode (dev)
  // mounts effects twice, and a transient dep-identity change can re-run the
  // fetch effect — either way a byte-identical request must not hit the DB
  // twice (issue #41). We dedupe on the wire: the key is set synchronously
  // before the first `await`, so the StrictMode remount's call sees it and
  // bails; it's cleared in `finally`, so genuine later refetches with the same
  // params still go through.
  const inflightKeyRef = useRef<string | null>(null);

  // The most recently dispatched `fetchData()` call, so `refreshCount` (below)
  // can wait for it to release its pooled connection before asking for one of
  // its own. `fetchTableData` and `countTableRows` used to fire as two
  // genuinely concurrent requests on every table open / predicate change —
  // fine for MongoDB's ~100-connection default pool, but MySQL/Postgres cap
  // at `MAX_CONNECTIONS_SERVER = 5` (`pool.rs`), sized for "a couple of
  // in-flight queries at once". Doubling the concurrent connection demand per
  // open tab saturated that pool with more than a couple of tabs open, which
  // read as "MySQL got slower" even on small tables — a pool-contention
  // regression, not a per-query one (confirmed by profiling: the MySQL
  // estimate query itself runs in single-digit ms). Sequencing restores the
  // pre-regression "1 connection in flight per tab" behaviour without giving
  // up the original point of the split — the data page still renders the
  // moment `fetchTableData` resolves, `refreshCount` just no longer races it
  // for a connection.
  const fetchPromiseRef = useRef<Promise<void> | null>(null);

  const fetchData = useCallback(async () => {
    const reqKey = JSON.stringify({
      connectionId,
      schema,
      table,
      pageSize,
      offset,
      sort,
      serverFilters,
      appliedFilter,
    });
    if (inflightKeyRef.current === reqKey) return;
    inflightKeyRef.current = reqKey;
    setLoading(true);
    setError(null);
    try {
      // Always `withCount: false` — the total is fetched separately by
      // `refreshCount` so the exact `COUNT(*)` never blocks these rows from
      // painting (issue #77).
      const r = await api.fetchTableData({
        connectionId,
        schema,
        table,
        limit: pageSize,
        offset,
        order: sort.length ? sort : undefined,
        filters: serverFilters.length ? serverFilters : undefined,
        search: appliedFilter || undefined,
        searchColumns: appliedFilter ? searchColumnsRef.current : undefined,
        withCount: false,
      });
      setResult(r);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
      // Only clear if a newer fetch hasn't already claimed the slot.
      if (inflightKeyRef.current === reqKey) inflightKeyRef.current = null;
    }
  }, [
    connectionId,
    schema,
    table,
    pageSize,
    offset,
    sort,
    serverFilters,
    appliedFilter,
  ]);

  // Fetch the row total independently of the data page. Keyed only on the
  // predicate (filters + committed search) — not on sort/offset/pageSize — so
  // paging and re-sorting reuse the total and never re-count. With no
  // predicate the backend returns a fast engine estimate (rendered `~N`); any
  // filter/search forces an exact count, but it still runs off the data
  // page's critical path so rows appear first.
  const refreshCount = useCallback(async () => {
    const countKey = JSON.stringify({
      connectionId,
      schema,
      table,
      f: serverFilters,
      s: appliedFilter,
    });
    if (countInflightRef.current === countKey) return;
    countInflightRef.current = countKey;
    setTotal(null);
    // Let the sibling data fetch (if any) release its pooled connection
    // first — see `fetchPromiseRef`'s comment above `fetchData`. A failed
    // data fetch shouldn't block the count from trying anyway.
    await fetchPromiseRef.current?.catch(() => {});
    try {
      const c = await api.countTableRows({
        connectionId,
        schema,
        table,
        filters: serverFilters.length ? serverFilters : undefined,
        search: appliedFilter || undefined,
        searchColumns: appliedFilter ? searchColumnsRef.current : undefined,
      });
      setTotal(c.total);
      setTotalEstimated(c.estimated);
    } catch {
      // Non-fatal: the grid pages fine without a total. Leave it null; the
      // footer shows the current range without "/ N".
    } finally {
      if (countInflightRef.current === countKey)
        countInflightRef.current = null;
    }
  }, [connectionId, schema, table, serverFilters, appliedFilter]);

  useEffect(() => {
    if (!cols) loadColumns(connectionId, schema, table);
  }, [cols, connectionId, schema, table, loadColumns]);

  useEffect(() => {
    // Stash the promise before `refreshCount`'s effect (declared next, runs
    // right after this one within the same commit) reads it.
    fetchPromiseRef.current = fetchData();
  }, [fetchData]);

  useEffect(() => {
    refreshCount();
  }, [refreshCount]);

  // Registered so the global F5 / Ctrl+R interceptor (App.tsx) can reload
  // this tab's data when it's the active one, instead of the WebView's
  // default full-page reload. Re-registered whenever `fetchData`'s identity
  // changes so the handler always closes over the current filters/sort/page.
  useEffect(() => {
    registerTableRefresh(tabId, fetchData);
    return () => unregisterTableRefresh(tabId);
  }, [tabId, fetchData]);

  /**
   * Indices of every PK column inside `result.columns`, memoised so cell
   * mutations don't re-scan the array on every keystroke. A negative
   * entry means that PK column was excluded from the result set — the
   * editable gate below treats the table as read-only in that case so
   * UPDATE/DELETE never run with an incomplete key.
   */
  const pkColumnIndices = useMemo(() => {
    if (!result || pkColumns.length === 0) return [];
    return pkColumns.map((c) =>
      result.columns.findIndex((rc) => rc.name === c.name),
    );
  }, [result, pkColumns]);

  /**
   * Resolve the row's full PK tuple directly from its payload. Returning
   * one value per `pkColumns` entry — composite PKs ship every value to
   * the backend so the WHERE clause stays unambiguous. Using
   * `row.original` rather than a row index sidesteps the client-side
   * filter / sort reshuffle problem documented in CLAUDE.md gotcha #7.
   */
  function pkValuesFromRow(rowValues: CellValue[]): CellValue[] {
    if (pkColumns.length === 0) throw new Error("Table has no primary key");
    if (pkColumnIndices.some((i) => i < 0))
      throw new Error("Primary-key columns missing from the result set");
    return pkColumnIndices.map((i) => rowValues[i]);
  }

  async function onCellSave(
    rowValues: CellValue[],
    columnName: string,
    value: string | null,
  ) {
    if (pkColumns.length === 0) {
      throw new Error("Cannot update: table has no primary key");
    }
    const pkValues = pkValuesFromRow(rowValues);
    // Forward the raw column type so the backend can cast textual literals
    // server-side where a plain string bind would be coerced wrongly (MySQL
    // BIT — see update_cell; MongoDB Date/int/long — see string_to_bson).
    // Prefer the catalog/inferred type from the schema store (`cols`) since a
    // MongoDB result set reports a generic "bson" per column, while the schema
    // store carries the inferred per-field BSON type.
    const columnType =
      cols?.find((c) => c.name === columnName)?.data_type ??
      result?.columns.find((c) => c.name === columnName)?.data_type;
    await api.updateCell({
      connectionId,
      schema,
      table,
      pkColumns: pkColumns.map((c) => c.name),
      pkValues,
      column: columnName,
      value,
      columnType,
    });
    await fetchData();
  }

  /**
   * List-view field commit — `onCellSave` generalised to a field **path**.
   *
   * On MongoDB the path is sent as a dotted update path (`customData.format`,
   * `tags.2`), which `$set` understands natively, together with the field's
   * real BSON type so an edit doesn't silently rewrite a `Long` as an `Int`
   * (the type comes from `QueryResult.row_types`, not from a guess at the
   * display JSON). On the SQL drivers only a top-level column can be
   * addressed, and the type hint is deliberately IGNORED: `update_cell` reads
   * `columnType` to decide whether a MySQL `BIT` needs its
   * `CAST(? AS UNSIGNED)` (gotcha #15), and handing it the list view's
   * inferred `"string"` would both miss the cast and suppress the backend's
   * catalog fallback — so the catalog/schema type wins there, exactly as it
   * does for a table-view cell save.
   */
  async function onFieldSave(
    rowValues: CellValue[],
    path: string[],
    value: string | null,
    typeHint?: string,
  ) {
    if (pkColumns.length === 0) {
      throw new Error("Cannot update: table has no primary key");
    }
    const pkValues = pkValuesFromRow(rowValues);
    const column = path.join(".");
    const catalogType =
      cols?.find((c) => c.name === column)?.data_type ??
      result?.columns.find((c) => c.name === column)?.data_type;
    await api.updateCell({
      connectionId,
      schema,
      table,
      pkColumns: pkColumns.map((c) => c.name),
      pkValues,
      column,
      value,
      columnType: isMongo ? (typeHint ?? catalogType) : catalogType,
    });
    await fetchData();
  }

  /**
   * List-view field removal — MongoDB `$unset` on the document addressed by
   * its `_id`. Only wired for MongoDB: a SQL row's columns are a property of
   * the table, not of the row, so "remove this field from this row" has no
   * counterpart there (setting it to NULL does, and that is `onFieldSave`).
   */
  async function onFieldDelete(rowValues: CellValue[], path: string[]) {
    const idValue = pkValuesFromRow(rowValues)[0] ?? null;
    await api.unsetField({
      connectionId,
      collection: table,
      idValue,
      field: path.join("."),
    });
    await fetchData();
  }

  /**
   * "Go to referenced row": open (or focus) the table the FK column points at,
   * pre-filtered to the clicked value. Resolves the referenced table/column
   * from the schema-store column metadata (`cols`), which carries the
   * single-column FK reference. No-op for non-FK columns. The referenced table
   * lives in the same connection/database, so we reuse `connectionId`.
   */
  function onNavigateFk(columnName: string, value: CellValue) {
    const col = cols?.find((c) => c.name === columnName);
    if (!col?.referenced_table || !col.referenced_column) return;
    useTabs.getState().open({
      kind: "table",
      title: tableTabTitle(
        useConnections.getState().profiles,
        connectionId,
        col.referenced_table,
      ),
      connectionId,
      schema: col.referenced_schema ?? undefined,
      table: col.referenced_table,
      initialFilters: [{ column: col.referenced_column, op: "eq", value }],
    });
  }

  function onAddFilter(f: ColumnFilter) {
    setServerFilters((prev) => {
      const existing = prev.findIndex(
        (p) => p.column === f.column && p.op === f.op,
      );
      if (existing >= 0) {
        const next = prev.slice();
        next[existing] = f;
        return next;
      }
      return [...prev, f];
    });
    setOffset(0);
  }

  function onRemoveFilter(index: number) {
    setServerFilters((prev) => prev.filter((_, i) => i !== index));
    setOffset(0);
  }

  /** Stage rows for deletion. With `ui.confirmDestructive` on (default) this
   *  opens the confirmation dialog; with it off the rows are deleted straight
   *  away (the toggle's whole purpose is to skip the prompt). */
  function requestDelete(pkValueRows: CellValue[][]) {
    if (pkValueRows.length === 0) return;
    if (usePreferences.getState().prefs.ui.confirmDestructive) {
      setPendingDelete({ pkValueRows });
    } else {
      void runDelete(pkValueRows);
    }
  }

  function onDeleteRow(rowValues: CellValue[]) {
    try {
      requestDelete([pkValuesFromRow(rowValues)]);
    } catch (e) {
      setError(String(e));
    }
  }

  /** Multi-selection delete — routes the whole selection through the same
   *  confirmation + bulk `deleteRows` call as a single row. */
  function onBulkDelete(rows: CellValue[][]) {
    try {
      requestDelete(rows.map((r) => pkValuesFromRow(r)));
    } catch (e) {
      setError(String(e));
    }
  }

  /** Actually perform the bulk delete and refresh the page. */
  async function runDelete(pkValueRows: CellValue[][]) {
    if (pkColumns.length === 0) return;
    try {
      await api.deleteRows({
        connectionId,
        schema,
        table,
        pkColumns: pkColumns.map((c) => c.name),
        pkValueRows,
      });
      setPendingDelete(null);
      await fetchData();
    } catch (e) {
      setError(String(e));
    }
  }

  function confirmDelete() {
    if (!pendingDelete) return;
    void runDelete(pendingDelete.pkValueRows);
  }

  /**
   * "Export the full table/collection" — unfiltered, the counterpart of the
   * MongoDB tree's per-collection JSON export (#65), now also available for
   * SQL tables via `exportTable`. A cancelled save dialog is a silent no-op.
   */
  async function exportFull() {
    try {
      const path = isMongo
        ? await api.exportCollection(connectionId, table)
        : await api.exportTable(connectionId, schema, table);
      toast.success(
        isMongo
          ? t("schema.exportCollection.success", { path })
          : t("tableData.exportData.tableSuccess", { path }),
      );
    } catch (e) {
      const message = String(e);
      if (!message.includes("export cancelled")) toast.error(message);
    }
  }

  /**
   * "Export query results" — scoped to the grid's current advanced filter
   * (`serverFilters`) and committed search, without any pagination limit.
   * Identical to `exportFull` when no filter is active.
   */
  async function exportFiltered() {
    try {
      const path = isMongo
        ? await api.exportCollection(connectionId, table, serverFilters)
        : await api.exportTableRows({
            connectionId,
            schema,
            table,
            filters: serverFilters,
            search: appliedFilter || undefined,
            searchColumns: appliedFilter ? searchColumns : undefined,
          });
      toast.success(
        isMongo
          ? t("schema.exportCollection.success", { path })
          : t("tableData.exportData.rowsSuccess", { path }),
      );
    } catch (e) {
      const message = String(e);
      if (!message.includes("export cancelled")) toast.error(message);
    }
  }

  /**
   * "Import JSON…" (Mongo only) — the same `import_collection` flow the
   * schema tree used to expose per-collection (#65), now reachable from the
   * DataGrid toolbar instead. Additive (`insert_many`); existing documents
   * sharing an `_id` stop the import, so it still goes through the
   * destructive-write confirmation like the tree version did.
   */
  async function importCollectionJsonForTab() {
    const picked = await openFileDialog({
      multiple: false,
      directory: false,
      title: t("schema.importCollection.pickTitle"),
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (typeof picked !== "string" || !picked) return;
    if (
      !confirmDestructive(
        t("schema.importCollection.confirm", { collection: table }),
      )
    ) {
      return;
    }
    try {
      const count = await api.importCollection(connectionId, table, picked);
      toast.success(t("schema.importCollection.success", { count }));
      await fetchData();
    } catch (e) {
      toast.error(String(e));
    }
  }

  function onInsertRow() {
    if (!cols || draft) return;
    setDraft(emptyDraft(cols.map((c) => c.name)));
  }

  function onDuplicateRow(rowValues: CellValue[]) {
    if (!result || !cols || draft) return;
    setDraft(
      duplicateDraft(
        result.columns.map((c) => c.name),
        rowValues,
        pkColumn,
      ),
    );
  }

  function onDraftCellChange(column: string, cell: DraftCell) {
    setDraft((prev) =>
      prev
        ? { ...prev, cells: { ...prev.cells, [column]: cell }, error: null }
        : prev,
    );
  }

  function onDraftCancel() {
    setDraft(null);
  }

  async function onDraftCommit() {
    if (!draft || draft.saving) return;
    const values: RowValue[] = Object.entries(draft.cells)
      .filter(([, c]) => c.touched)
      .map(([column, c]) => ({
        column,
        value: c.value,
        // A per-cell type wins over the catalog one: the list view's draft card
        // lets a MongoDB field be written as a chosen BSON type, and only the
        // cell knows about it (see `DraftCell.type`).
        columnType:
          c.type ??
          cols?.find((col) => col.name === column)?.data_type ??
          result?.columns.find((col) => col.name === column)?.data_type,
      }));
    // Empty draft (user never typed) → silently cancel rather than send
    // an `INSERT () VALUES ()` that the backend would reject.
    if (values.length === 0) {
      setDraft(null);
      return;
    }
    setDraft((prev) => (prev ? { ...prev, saving: true, error: null } : prev));
    try {
      await api.insertRow({
        connectionId,
        schema,
        table,
        pkColumn: pkColumn?.name,
        values,
      });
      setDraft(null);
      await fetchData();
    } catch (e) {
      setDraft((prev) =>
        prev ? { ...prev, saving: false, error: String(e) } : prev,
      );
    }
  }

  const canPrev = offset > 0;
  // With an *exact* total, stop at the last page. Otherwise — count still in
  // flight, failed, or only an *estimate* (which can undershoot the real row
  // count on stale stats, and must not strand the user before the true end) —
  // fall back to "there might be more" whenever the current page came back
  // full. A short page then naturally disables Next at the real end.
  const canNext =
    total !== null && !totalEstimated
      ? offset + pageSize < total
      : (result?.rows.length ?? 0) >= pageSize;
  // Editable iff the table has at least one PK column AND every PK
  // column is present in the result set (otherwise we couldn't build a
  // safe WHERE clause).
  const hasPk =
    pkColumns.length > 0 &&
    (result === null || pkColumnIndices.every((i) => i >= 0));

  /**
   * Stable identity for a grid row, derived from its payload rather than a
   * display index (gotcha #7). Drives the grid's multi-row selection.
   *
   * With a usable PK the key is the PK tuple. Without one it falls back to the
   * full values array: a no-PK table used to get no `getRowKey` at all, which
   * switched `selectionEnabled` off in `DataGrid` and left the user with *no*
   * selection whatsoever — no checkbox column, no Shift range, no Ctrl toggle
   * (the third strand of #113). The fallback is honest about its limit: two
   * byte-identical rows share a key and therefore select together, which a PK
   * would have told apart. That's acceptable here because every gesture the
   * fallback unlocks is read-only — copy, and the `IN` filter — while every
   * mutating path (`editable`, insert/duplicate/delete, bulk delete) stays
   * gated on `hasPk` at the call site below and never sees this key.
   *
   * `useCallback` matters beyond tidiness: `DataGrid` lists `getRowKey` in the
   * deps of the memo that pairs every visible row with its key, so an unstable
   * identity would recompute it on each render of a full page of rows.
   */
  const getRowKey = useCallback(
    (rowValues: CellValue[]): string | null => {
      try {
        return JSON.stringify(hasPk ? pkValuesFromRow(rowValues) : rowValues);
      } catch {
        return null;
      }
    },
    // `pkValuesFromRow` closes over `pkColumns`/`pkColumnIndices`; it is a plain
    // function redeclared each render, so key off its inputs instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hasPk, pkColumns, pkColumnIndices],
  );

  // Leading toolbar content folded into the grid's own toolbar (via DataGrid's
  // `toolbarLeading`) so a table tab shows ONE header bar instead of two
  // stacked ones. The schema › table breadcrumb used to live here, but the
  // tab title already shows `database.table` (#57) — repeating it next to the
  // filter was pure redundancy, so the leading area is just the two
  // filter-related actions: refresh and the advanced-filter dialog. Every
  // other action (add/export/bulk data, pagination, zoom, view toggle) lives
  // in the header's right cluster or the footer instead — see `insertExtra`/
  // `footerContent` below — so this left side stays a small, stable cluster.
  //
  // Every entry declares both a `bar` and a `menu` form, because DataGrid's
  // toolbar is responsive: on a narrow pane these move into its overflow menu
  // rather than wrapping onto a second row (see `GridToolbarItem`). The menu
  // form is a labelled row — which is also the chance to spell out what an
  // icon-only button only implies in a tooltip.
  const leadingToolbar: GridToolbarItem[] = [
    {
      id: "refresh",
      bar: (
        <Button
          variant="ghost"
          size="icon"
          onClick={fetchData}
          disabled={loading}
          title={t("tableData.refresh")}
        >
          <RefreshCw
            className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
          />
        </Button>
      ),
      menu: (
        <DropdownMenuItem
          className="text-xs"
          disabled={loading}
          onSelect={fetchData}
        >
          <RefreshCw className="mr-2 h-3.5 w-3.5" />
          {t("tableData.refresh")}
        </DropdownMenuItem>
      ),
    },
    {
      id: "advanced-filter",
      bar: (
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setAdvancedOpen(true)}
          title={t("tableData.filter.title")}
          // Brand-tint the icon while filters are active so it reads as "on"
          // and doubles as an at-a-glance indicator, with the count as a badge.
          className="relative"
        >
          <ListFilter
            className={`h-3.5 w-3.5 ${serverFilters.length ? "text-brand" : ""}`}
          />
          {serverFilters.length > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-brand px-1 text-3xs font-semibold text-white">
              {serverFilters.length}
            </span>
          )}
        </Button>
      ),
      menu: (
        <DropdownMenuItem
          className="text-xs"
          onSelect={() => setAdvancedOpen(true)}
        >
          <ListFilter
            className={`mr-2 h-3.5 w-3.5 ${
              serverFilters.length ? "text-brand" : ""
            }`}
          />
          {t("tableData.filter.title")}
          {serverFilters.length > 0 && (
            <span className="ml-auto pl-3 tabular-nums text-muted-foreground">
              {serverFilters.length}
            </span>
          )}
        </DropdownMenuItem>
      ),
    },
  ];

  // Rendered right beside DataGrid's own "Insert" button (via `insertExtra`),
  // so every action that adds, exports, or mass-edits data reads as one group
  // on the header's right side instead of being split across the toolbar.
  const insertExtraContent: GridToolbarItem[] = [
    // MongoDB only: additive JSON import into this collection (#65), moved
    // here from the schema tree's right-click menu so the action lives with
    // the data it affects instead of the tree. SQL has no table-scoped import
    // primitive (only a whole-connection `.sql` batch), so it keeps that entry
    // point in the tree unchanged.
    ...(isMongo
      ? [
          {
            id: "import-collection",
            bar: (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1 px-2 text-xs"
                onClick={() => void importCollectionJsonForTab()}
                title={t("schema.importCollection.title")}
              >
                <Upload className="h-3.5 w-3.5" />
                {t("schema.importCollection.title")}
              </Button>
            ),
            menu: (
              <DropdownMenuItem
                className="text-xs"
                onSelect={() => void importCollectionJsonForTab()}
              >
                <Upload className="mr-2 h-3.5 w-3.5" />
                {t("schema.importCollection.title")}
              </DropdownMenuItem>
            ),
          },
        ]
      : []),
    {
      id: "export-data",
      bar: (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 px-2 text-xs"
            >
              <Download className="h-3.5 w-3.5" />
              {t("tableData.exportData.label")}
              <ChevronDown className="h-3 w-3 opacity-60" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onSelect={() => void exportFull()}>
              {isMongo
                ? t("schema.exportCollection.title")
                : t("tableData.exportData.table")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void exportFiltered()}>
              {t("tableData.exportData.queryResults")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ),
      // A dropdown can't collapse into a menu as a nested dropdown (it would
      // portal outside the parent's content and dismiss it), so it becomes a
      // submenu with the very same two choices.
      menu: (
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className="text-xs">
            <Download className="mr-2 h-3.5 w-3.5" />
            {t("tableData.exportData.label")}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuItem
              className="text-xs"
              onSelect={() => void exportFull()}
            >
              {isMongo
                ? t("schema.exportCollection.title")
                : t("tableData.exportData.table")}
            </DropdownMenuItem>
            <DropdownMenuItem
              className="text-xs"
              onSelect={() => void exportFiltered()}
            >
              {t("tableData.exportData.queryResults")}
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      ),
    },
    ...(hasPk
      ? [
          {
            id: "bulk-update",
            bar: (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1 px-2 text-xs"
                onClick={() => setBulkUpdateOpen(true)}
                title={t("tableData.bulkUpdate.toolbarTitle")}
              >
                <ReplaceAll className="h-3.5 w-3.5" />
                {t("tableData.bulkUpdate.toolbarLabel")}
              </Button>
            ),
            menu: (
              <DropdownMenuItem
                className="text-xs"
                onSelect={() => setBulkUpdateOpen(true)}
              >
                <ReplaceAll className="mr-2 h-3.5 w-3.5" />
                {t("tableData.bulkUpdate.toolbarLabel")}
              </DropdownMenuItem>
            ),
          },
        ]
      : []),
  ];

  // Trailing (right-aligned) HEADER content, rendered after `insertExtra` —
  // just the table/list view toggle, a *display* control rather than a data
  // action, so it stays apart from the insert/export/bulk group. Offered for
  // every driver: the list view started out MongoDB-only, but a 40-column SQL
  // table (or a row with a big JSONB column) has exactly the same problem it
  // solves. The choice is this tab's own `documentViewMode` state (#131), not
  // a global preference — see its declaration above.
  const trailingToolbar: GridToolbarItem[] = [
    {
      id: "view-mode",
      // One segmented control, so one item — splitting it in two would put a
      // gap through the middle of a control whose two halves ARE the choice.
      bar: (
        <div className="flex items-center overflow-hidden rounded-md border border-border">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setDocumentViewMode("table")}
            title={t("dataGrid.viewModeTable")}
            className={`h-7 w-7 rounded-none ${
              documentViewMode === "table" ? "bg-accent text-brand" : ""
            }`}
          >
            <Table2 className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setDocumentViewMode("list")}
            title={t("dataGrid.viewModeList")}
            className={`h-7 w-7 rounded-none ${
              documentViewMode === "list" ? "bg-accent text-brand" : ""
            }`}
          >
            <Rows3 className="h-3.5 w-3.5" />
          </Button>
        </div>
      ),
      // In the menu the segment becomes two checkable rows: the "which of the
      // two is active" state the segmented control shows by tinting one half
      // has to be readable here too.
      menu: (
        <>
          <DropdownMenuCheckboxItem
            className="text-xs"
            checked={documentViewMode === "table"}
            onSelect={() => setDocumentViewMode("table")}
          >
            {t("dataGrid.viewModeTable")}
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem
            className="text-xs"
            checked={documentViewMode === "list"}
            onSelect={() => setDocumentViewMode("list")}
          >
            {t("dataGrid.viewModeList")}
          </DropdownMenuCheckboxItem>
        </>
      ),
    },
  ];

  // FOOTER content (a second, bottom toolbar row via DataGrid's `footer`) —
  // "how you're browsing", kept apart from the header's data actions. Two
  // groups anchored to opposite edges (DataGrid's footer container has no
  // `justify-end` of its own): row-zoom on the LEFT, and — pushed right via
  // `ml-auto` — the human-format pagination range (`1–100 de 19759`,
  // replacing the grid's redundant "N rows of M" count, hence
  // `showRowCount={false}` below), prev/next page buttons, and the page-size
  // selector.
  const footerContent = (
    <>
      <div className="flex items-center">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => zoomRows(-2)}
          disabled={rowHeight <= 14}
          title={t("dataGrid.zoomOut")}
        >
          <ZoomOut className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => zoomRows(2)}
          disabled={rowHeight >= 40}
          title={t("dataGrid.zoomIn")}
        >
          <ZoomIn className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="ml-auto flex flex-wrap items-center gap-2">
        <span
          className="tabular-nums text-muted-foreground"
          title={totalEstimated ? t("tableData.approxTotal") : undefined}
        >
          {(offset + 1).toLocaleString()}–
          {Math.min(
            offset + pageSize,
            total ?? offset + pageSize,
          ).toLocaleString()}
          {total !== null && (
            <>
              {" "}
              {t("dataGrid.of")}{" "}
              <span className="font-medium text-foreground">
                {totalEstimated ? "~" : ""}
                {total.toLocaleString()}
              </span>
            </>
          )}
        </span>
        <div className="flex items-center">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setOffset(Math.max(0, offset - pageSize))}
            disabled={!canPrev || loading}
            title={t("tableData.prevPage")}
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setOffset(offset + pageSize)}
            disabled={!canNext || loading}
            title={t("tableData.nextPage")}
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </div>
        <select
          value={pageSize}
          onChange={(e) => {
            setOffset(0);
            setPageSize(Number(e.target.value));
          }}
          className="h-7 rounded-md border border-input bg-background px-1.5 text-xs"
        >
          {pageSizeOptions.map((n) => (
            <option key={n} value={n}>
              {t("tableData.perPage", { count: n })}
            </option>
          ))}
        </select>
      </div>
    </>
  );

  return (
    <div className="flex h-full flex-col">
      {error && (
        <div className="border-b border-border bg-destructive/10 px-3 py-1.5 text-xs text-destructive">
          {error}
        </div>
      )}
      <div className="flex-1 overflow-hidden">
        {result ? (
          <DataGrid
            result={result}
            editable={hasPk}
            connectionId={connectionId}
            tableSchema={schema}
            tableName={table}
            tabId={tabId}
            driver={driver}
            pkColumnNames={pkColumns.map((c) => c.name)}
            fkColumnNames={fkColumnNames}
            onNavigateFk={onNavigateFk}
            onCellSave={onCellSave}
            onFieldSave={onFieldSave}
            onFieldDelete={isMongo ? onFieldDelete : undefined}
            sort={sort}
            onSortChange={applySort}
            // `globalFilter` drives the grid's client-side `visibleRows`
            // pass and MUST match the filter the backend used to build
            // `result.rows` — that's `appliedFilter`, not the
            // uncommitted toolbar draft. Mixing the two caused
            // cell saves under a typed-but-not-Enter search to look
            // like they applied to the row above (see gotcha #7 in
            // CLAUDE.md). The toolbar input still reflects the live
            // draft via `filterInput`.
            globalFilter={appliedFilter}
            filterInput={filter}
            onGlobalFilterChange={setFilter}
            onGlobalFilterSubmit={submitFilter}
            searchHistory={filterHistory ?? []}
            serverFilters={serverFilters}
            onAddFilter={onAddFilter}
            onRemoveFilter={onRemoveFilter}
            onInsertRow={hasPk ? onInsertRow : undefined}
            onDuplicateRow={hasPk ? onDuplicateRow : undefined}
            onDeleteRow={hasPk ? onDeleteRow : undefined}
            onBulkDelete={hasPk ? onBulkDelete : undefined}
            getRowKey={getRowKey}
            onSelectionChange={(count, total) =>
              reportSelection(tabId, count, total)
            }
            draftRow={draft}
            draftColumns={cols}
            onDraftCellChange={onDraftCellChange}
            onDraftCommit={onDraftCommit}
            onDraftCancel={onDraftCancel}
            loading={loading}
            toolbarLeading={leadingToolbar}
            insertExtra={insertExtraContent}
            toolbarTrailing={trailingToolbar}
            footer={footerContent}
            showRowCount={false}
            viewMode={documentViewMode}
          />
        ) : (
          // Initial load (no rows yet): a shimmer skeleton that reads as
          // "fetching". The tab title carries the table's identity (#57), so
          // this strip is just the loading indicator. Refetch-with-stale-rows
          // is handled by the grid's own dim overlay (the `loading` prop above).
          <div className="flex h-full flex-col">
            <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
              {t("schema.loading")}
            </div>
            <div className="flex-1 space-y-1.5 p-3" aria-hidden>
              {Array.from({ length: 10 }).map((_, i) => (
                <div
                  key={i}
                  className="h-6 animate-pulse rounded bg-muted-foreground/10"
                />
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Confirm-delete dialog */}
      <Dialog
        open={!!pendingDelete}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {(pendingDelete?.pkValueRows.length ?? 0) > 1
                ? t("tableData.deleteRowsTitle", {
                    count: pendingDelete?.pkValueRows.length,
                  })
                : t("tableData.deleteRowTitle")}
            </DialogTitle>
          </DialogHeader>
          {(pendingDelete?.pkValueRows.length ?? 0) > 1 ? (
            <p className="text-xs text-muted-foreground">
              {t("tableData.deleteRowsBodyLead", {
                count: pendingDelete?.pkValueRows.length,
              })}{" "}
              <span className="font-mono">
                {schema ? `${schema}.` : ""}
                {table}
              </span>
              {t("tableData.deleteBodyTrail")}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              {t("tableData.deleteRowBodyLead")}{" "}
              <span className="font-mono">
                {schema ? `${schema}.` : ""}
                {table}
              </span>{" "}
              {t("tableData.deleteBodyWhere")}{" "}
              <span className="font-mono">
                {pkColumns
                  .map(
                    (c, i) =>
                      `${c.name} = ${String(
                        pendingDelete?.pkValueRows[0]?.[i] ?? "",
                      )}`,
                  )
                  .join(" AND ")}
              </span>
              {t("tableData.deleteBodyTrail")}
            </p>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPendingDelete(null)}>
              {t("common.cancel")}
            </Button>
            <Button variant="destructive" onClick={confirmDelete}>
              {t("tableData.delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {advancedOpen && (
        <AdvancedFilterDialog
          columns={cols ?? []}
          initial={serverFilters}
          onApply={(filters) => {
            setServerFilters(filters);
            setOffset(0);
          }}
          onClose={() => setAdvancedOpen(false)}
        />
      )}

      {bulkUpdateOpen && (
        <BulkUpdateDialog
          connectionId={connectionId}
          schema={schema}
          table={table}
          columns={cols ?? []}
          initialFilters={serverFilters}
          isMongo={isMongo}
          onApplied={() => void fetchData()}
          onClose={() => setBulkUpdateOpen(false)}
        />
      )}
    </div>
  );
}
