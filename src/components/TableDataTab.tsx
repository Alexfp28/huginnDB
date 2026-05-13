import { useCallback, useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import { api } from "@/lib/tauri";
import { useSchema } from "@/stores/schema";
import type { QueryResult } from "@/types";
import { DataGrid } from "@/components/DataGrid";
import { Button } from "@/components/ui/button";

interface Props {
  connectionId: string;
  schema?: string;
  table: string;
}

const PAGE_SIZE_OPTIONS = [50, 100, 250, 500];

export function TableDataTab({ connectionId, schema, table }: Props) {
  const loadColumns = useSchema((s) => s.loadColumns);
  const columnsBySchema = useSchema((s) => s.byConnection[connectionId]?.columns);
  const tableKey = `${schema ?? ""}.${table}`;
  const cols = columnsBySchema?.[tableKey];

  const [result, setResult] = useState<QueryResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [pageSize, setPageSize] = useState(100);
  const [sortColumn, setSortColumn] = useState<string | undefined>();
  const [sortDesc, setSortDesc] = useState(false);
  const [filter, setFilter] = useState("");

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
      });
      setResult(r);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [connectionId, schema, table, pageSize, offset, sortColumn, sortDesc]);

  useEffect(() => {
    if (!cols) loadColumns(connectionId, schema, table);
  }, [cols, connectionId, schema, table, loadColumns]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  async function onCellSave(rowIndex: number, columnName: string, value: string) {
    if (!result || !cols) return;
    const pk = cols.find((c) => c.is_primary_key);
    if (!pk) {
      throw new Error("Cannot update: table has no primary key");
    }
    const pkIdx = result.columns.findIndex((c) => c.name === pk.name);
    if (pkIdx < 0) throw new Error("Primary key column not in result set");
    const pkValue = result.rows[rowIndex][pkIdx];
    await api.updateCell({
      connectionId,
      schema,
      table,
      pkColumn: pk.name,
      pkValue,
      column: columnName,
      value,
    });
    await fetchData();
  }

  const total = result?.total ?? null;
  const canPrev = offset > 0;
  const canNext = total !== null && offset + pageSize < total;

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
            editable={!!cols?.some((c) => c.is_primary_key)}
            onCellSave={onCellSave}
            sortColumn={sortColumn}
            sortDesc={sortDesc}
            onSortChange={(c, d) => {
              setSortColumn(c);
              setSortDesc(d);
            }}
            globalFilter={filter}
            onGlobalFilterChange={setFilter}
          />
        ) : (
          <div className="p-4 text-xs text-muted-foreground">Loading…</div>
        )}
      </div>
    </div>
  );
}
