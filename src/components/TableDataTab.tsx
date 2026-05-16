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
 * Filtering model: the toolbar input applies a debounced server-side
 * "any column contains" search (case-insensitive `LIKE`/`ILIKE`),
 * so it surfaces matches across the whole table — including rows on
 * other pages. The grid's right-click "Filter by this value" pushes
 * structured `ColumnFilter` entries onto `serverFilters`, which
 * compose with the search via `AND`.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import { api } from "@/lib/tauri";
import { useSchema } from "@/stores/schema";
import { useFilterHistory } from "@/stores/filterHistory";
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
import { DEFAULT_PAGE_SIZE, PAGE_SIZE_OPTIONS } from "@/lib/constants";

interface Props {
  connectionId: string;
  schema?: string;
  table: string;
}

interface PendingDelete {
  rowIndex: number;
  pkValue: CellValue;
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

export function TableDataTab({ connectionId, schema, table }: Props) {
  const loadColumns = useSchema((s) => s.loadColumns);
  const columnsBySchema = useSchema((s) => s.byConnection[connectionId]?.columns);
  const tableKey = `${schema ?? ""}.${table}`;
  const cols = columnsBySchema?.[tableKey];

  const [result, setResult] = useState<QueryResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
  const [sortColumn, setSortColumn] = useState<string | undefined>();
  const [sortDesc, setSortDesc] = useState(false);
  /** Free-text search bound to the toolbar input (raw, not debounced). */
  const [filter, setFilter] = useState("");
  /** Debounced version sent to the backend so we don't refetch per keystroke. */
  const [debouncedFilter, setDebouncedFilter] = useState("");
  const [serverFilters, setServerFilters] = useState<ColumnFilter[]>([]);

  const pushHistory = useFilterHistory((s) => s.push);
  const filterHistory = useFilterHistory(
    (s) => s.byConnection[connectionId],
  );

  /** Debounce the search input: ~250 ms is enough to feel live without
   *  hammering the database on every character. */
  useEffect(() => {
    if (filter === debouncedFilter) return;
    const id = window.setTimeout(() => {
      setDebouncedFilter(filter);
      setOffset(0);
      // Record only meaningful searches — short fragments would crowd
      // the dropdown without giving the user anything to re-apply.
      if (filter.trim().length >= 2) {
        pushHistory(connectionId, filter);
      }
    }, 250);
    return () => window.clearTimeout(id);
  }, [filter, debouncedFilter, connectionId, pushHistory]);

  const searchColumns = useMemo(
    () => cols?.map((c) => c.name) ?? [],
    [cols],
  );

  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [draft, setDraft] = useState<DraftRow | null>(null);

  const pkColumn = useMemo(() => cols?.find((c) => c.is_primary_key), [cols]);

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
        search: debouncedFilter || undefined,
        searchColumns: debouncedFilter ? searchColumns : undefined,
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
    debouncedFilter,
    searchColumns,
  ]);

  useEffect(() => {
    if (!cols) loadColumns(connectionId, schema, table);
  }, [cols, connectionId, schema, table, loadColumns]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  /** Resolve the PK column value for the given row index, or throw. */
  function pkValueAtRow(rowIndex: number): CellValue {
    if (!result || !pkColumn) throw new Error("Table has no primary key");
    const pkIdx = result.columns.findIndex((c) => c.name === pkColumn.name);
    if (pkIdx < 0) throw new Error("Primary key column not in result set");
    return result.rows[rowIndex][pkIdx];
  }

  async function onCellSave(
    rowIndex: number,
    columnName: string,
    value: string | null,
  ) {
    if (!pkColumn) {
      throw new Error("Cannot update: table has no primary key");
    }
    const pkValue = pkValueAtRow(rowIndex);
    await api.updateCell({
      connectionId,
      schema,
      table,
      pkColumn: pkColumn.name,
      pkValue,
      column: columnName,
      value,
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

  function onDeleteRow(rowIndex: number) {
    try {
      const pkValue = pkValueAtRow(rowIndex);
      setPendingDelete({ rowIndex, pkValue });
    } catch (e) {
      setError(String(e));
    }
  }

  async function confirmDelete() {
    if (!pendingDelete || !pkColumn) return;
    try {
      await api.deleteRows({
        connectionId,
        schema,
        table,
        pkColumn: pkColumn.name,
        pkValues: [pendingDelete.pkValue],
      });
      setPendingDelete(null);
      await fetchData();
    } catch (e) {
      setError(String(e));
    }
  }

  function onInsertRow() {
    if (!cols || draft) return;
    setDraft(emptyDraft(cols.map((c) => c.name)));
  }

  function onDuplicateRow(rowIndex: number) {
    if (!result || !cols || draft) return;
    setDraft(
      duplicateDraft(
        result.columns.map((c) => c.name),
        result.rows[rowIndex],
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
      .map(([column, c]) => ({ column, value: c.value }));
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
  const hasPk = !!pkColumn;

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
          title="Refresh"
        >
          <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />
        </Button>
        <div className="ml-auto flex items-center gap-2">
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
            {PAGE_SIZE_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n}/page
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
            onCellSave={onCellSave}
            sortColumn={sortColumn}
            sortDesc={sortDesc}
            onSortChange={(c, d) => {
              setSortColumn(c);
              setSortDesc(d);
            }}
            globalFilter={filter}
            onGlobalFilterChange={setFilter}
            searchHistory={filterHistory ?? []}
            serverFilters={serverFilters}
            onAddFilter={onAddFilter}
            onRemoveFilter={onRemoveFilter}
            onInsertRow={hasPk ? onInsertRow : undefined}
            onDuplicateRow={hasPk ? onDuplicateRow : undefined}
            onDeleteRow={hasPk ? onDeleteRow : undefined}
            draftRow={draft}
            draftColumns={cols}
            onDraftCellChange={onDraftCellChange}
            onDraftCommit={onDraftCommit}
            onDraftCancel={onDraftCancel}
          />
        ) : (
          <div className="p-4 text-xs text-muted-foreground">Loading…</div>
        )}
      </div>

      {/* Confirm-delete dialog */}
      <Dialog
        open={!!pendingDelete}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete row?</DialogTitle>
          </DialogHeader>
          <p className="text-xs text-muted-foreground">
            About to delete from{" "}
            <span className="font-mono">
              {schema ? `${schema}.` : ""}
              {table}
            </span>{" "}
            where{" "}
            <span className="font-mono">
              {pkColumn?.name} = {String(pendingDelete?.pkValue ?? "")}
            </span>
            . This cannot be undone.
          </p>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPendingDelete(null)}>
              Cancel
            </Button>
            <Button onClick={confirmDelete}>Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
