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

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "@/lib/tauri";
import { useSchema } from "@/stores/schema";
import { useFilterHistory } from "@/stores/filterHistory";
import { useConnections } from "@/stores/connections";
import { useGridSelection } from "@/stores/gridSelection";
import { usePreferences, selectGridPrefs } from "@/stores/preferences";
import type {
  CellValue,
  ColumnFilter,
  DraftCell,
  DraftRow,
  QueryResult,
  RowValue,
} from "@/types";
import { DataGrid } from "@/components/DataGrid";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { PAGE_SIZE_OPTIONS } from "@/lib/constants";

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

export function TableDataTab({ tabId, connectionId, schema, table }: Props) {
  const reportSelection = useGridSelection((s) => s.report);
  const clearSelection = useGridSelection((s) => s.clear);
  // Drop this tab's selection entry when the tab unmounts (close /
  // disconnect) so the status bar never reads a stale count.
  useEffect(() => () => clearSelection(tabId), [tabId, clearSelection]);
  const loadColumns = useSchema((s) => s.loadColumns);
  const columnsBySchema = useSchema((s) => s.byConnection[connectionId]?.columns);
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
      const parent = s.profiles.find((p) => p.id === connectionId.slice(0, sep));
      if (parent) return parent.driver;
    }
    return undefined;
  });
  const tableKey = `${schema ?? ""}.${table}`;
  const cols = columnsBySchema?.[tableKey];

  const [result, setResult] = useState<QueryResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
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
  const [sortColumn, setSortColumn] = useState<string | undefined>();
  const [sortDesc, setSortDesc] = useState(false);
  /** Free-text search bound to the toolbar input (uncommitted draft). */
  const [filter, setFilter] = useState("");
  /** What was actually committed via Enter — drives the backend fetch. */
  const [appliedFilter, setAppliedFilter] = useState("");
  const [serverFilters, setServerFilters] = useState<ColumnFilter[]>([]);

  const pushHistory = useFilterHistory((s) => s.push);
  const filterHistory = useFilterHistory(
    (s) => s.byConnection[connectionId],
  );

  const { t } = useTranslation();
  /**
   * Persisted grid "zoom". The same `gridPrefs.rowHeight` the DataGrid reads;
   * the toolbar +/− buttons nudge it (Ctrl+wheel over the grid does the same).
   * Subscribed as a primitive so the selector stays reference-stable.
   */
  const rowHeight = usePreferences((s) => selectGridPrefs(s).rowHeight);
  const updateGrid = usePreferences((s) => s.updateGrid);
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

  const searchColumns = useMemo(
    () => cols?.map((c) => c.name) ?? [],
    [cols],
  );

  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [draft, setDraft] = useState<DraftRow | null>(null);

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

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await api.fetchTableData({
        connectionId,
        schema,
        table,
        limit: pageSize,
        offset,
        orderBy: sortColumn,
        orderDesc: sortDesc,
        filters: serverFilters.length ? serverFilters : undefined,
        search: appliedFilter || undefined,
        searchColumns: appliedFilter ? searchColumns : undefined,
      });
      setResult(r);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [
    connectionId,
    schema,
    table,
    pageSize,
    offset,
    sortColumn,
    sortDesc,
    serverFilters,
    appliedFilter,
    searchColumns,
  ]);

  useEffect(() => {
    if (!cols) loadColumns(connectionId, schema, table);
  }, [cols, connectionId, schema, table, loadColumns]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

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
        columnType:
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

  const total = result?.total ?? null;
  const canPrev = offset > 0;
  const canNext = total !== null && offset + pageSize < total;
  // Editable iff the table has at least one PK column AND every PK
  // column is present in the result set (otherwise we couldn't build a
  // safe WHERE clause).
  const hasPk =
    pkColumns.length > 0 &&
    (result === null || pkColumnIndices.every((i) => i >= 0));

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-background px-3 py-1.5 text-xs">
        <span className="font-medium">
          {schema ? `${schema}.` : ""}
          {table}
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={fetchData}
          disabled={loading}
          title={t("tableData.refresh")}
        >
          <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />
        </Button>
        <div className="ml-auto flex items-center gap-2">
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
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setOffset(Math.max(0, offset - pageSize))}
            disabled={!canPrev || loading}
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </Button>
          <span className="text-muted-foreground">
            {(offset + 1).toLocaleString()}–
            {Math.min(offset + pageSize, (total ?? offset + pageSize)).toLocaleString()}
            {total !== null && ` / ${total.toLocaleString()}`}
          </span>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setOffset(offset + pageSize)}
            disabled={!canNext || loading}
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
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
      </div>
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
            driver={driver}
            pkColumnNames={pkColumns.map((c) => c.name)}
            onCellSave={onCellSave}
            sortColumn={sortColumn}
            sortDesc={sortDesc}
            onSortChange={(c, d) => {
              setSortColumn(c);
              setSortDesc(d);
            }}
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
            getRowKey={
              hasPk
                ? (rowValues) => {
                    try {
                      return JSON.stringify(pkValuesFromRow(rowValues));
                    } catch {
                      return null;
                    }
                  }
                : undefined
            }
            onSelectionChange={(count, total) =>
              reportSelection(tabId, count, total)
            }
            draftRow={draft}
            draftColumns={cols}
            onDraftCellChange={onDraftCellChange}
            onDraftCommit={onDraftCommit}
            onDraftCancel={onDraftCancel}
          />
        ) : (
          <div className="p-4 text-xs text-muted-foreground">
            {t("tableData.loading")}
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
            <Button onClick={confirmDelete}>{t("tableData.delete")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
