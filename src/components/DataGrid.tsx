import { useEffect, useMemo, useState } from "react";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
} from "@tanstack/react-table";
import { ArrowUpDown, Maximize2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { CellValue, ColumnMeta, QueryResult } from "@/types";
import { CellEditor } from "@/components/CellEditor";

interface Props {
  result: QueryResult;
  editable?: boolean;
  onCellSave?: (rowIndex: number, columnName: string, value: string) => Promise<void>;
  onSortChange?: (column: string, desc: boolean) => void;
  sortColumn?: string;
  sortDesc?: boolean;
  globalFilter?: string;
  onGlobalFilterChange?: (v: string) => void;
}

function formatValue(v: CellValue): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export function DataGrid({
  result,
  editable,
  onCellSave,
  onSortChange,
  sortColumn,
  sortDesc,
  globalFilter,
  onGlobalFilterChange,
}: Props) {
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorTarget, setEditorTarget] = useState<{
    rowIndex: number;
    column: ColumnMeta;
    value: string;
  } | null>(null);

  const filteredRows = useMemo(() => {
    if (!globalFilter) return result.rows;
    const q = globalFilter.toLowerCase();
    return result.rows.filter((r) => r.some((c) => formatValue(c).toLowerCase().includes(q)));
  }, [result.rows, globalFilter]);

  const columns = useMemo<ColumnDef<CellValue[]>[]>(
    () =>
      result.columns.map((col, idx) => ({
        id: col.name,
        header: () => (
          <button
            className="flex items-center gap-1 hover:text-foreground"
            onClick={() => onSortChange?.(col.name, sortColumn === col.name ? !sortDesc : false)}
          >
            <span className="truncate">{col.name}</span>
            <span className="text-[9px] uppercase text-muted-foreground/60">
              {col.data_type}
            </span>
            <ArrowUpDown
              className={`h-3 w-3 ${
                sortColumn === col.name ? "text-foreground" : "opacity-30"
              }`}
            />
          </button>
        ),
        accessorFn: (row) => row[idx],
        cell: (info) => {
          const v = info.getValue() as CellValue;
          const display = formatValue(v);
          return (
            <div className="group flex max-w-md items-center gap-1">
              <span className="truncate font-mono text-xs">
                {v === null ? <span className="italic text-muted-foreground">NULL</span> : display}
              </span>
              <button
                className="ml-auto opacity-0 group-hover:opacity-100"
                onClick={(e) => {
                  e.stopPropagation();
                  setEditorTarget({
                    rowIndex: info.row.index,
                    column: col,
                    value: display,
                  });
                  setEditorOpen(true);
                }}
                title="Expand (Ctrl+Enter)"
              >
                <Maximize2 className="h-3 w-3" />
              </button>
            </div>
          );
        },
      })),
    [result.columns, sortColumn, sortDesc, onSortChange],
  );

  const table = useReactTable({
    data: filteredRows,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.ctrlKey && e.key === "Enter" && document.activeElement?.tagName === "TD") {
        // user-triggered cell expansion via shortcut
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border bg-background px-3 py-1.5 text-xs">
        <input
          className="h-7 w-64 rounded-md border border-input bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
          placeholder="Filter rows…"
          value={globalFilter ?? ""}
          onChange={(e) => onGlobalFilterChange?.(e.target.value)}
        />
        <span className="text-muted-foreground">
          {filteredRows.length.toLocaleString()} rows
          {result.total !== null && result.total !== undefined && (
            <> of {result.total.toLocaleString()}</>
          )}
        </span>
        <span className="ml-auto text-muted-foreground">
          {result.elapsed_ms} ms
        </span>
      </div>
      <div className="flex-1 overflow-auto">
        <table className="w-full border-separate border-spacing-0 text-left">
          <thead className="sticky top-0 z-10 bg-card">
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                <th className="border-b border-border bg-card px-2 py-1 text-[10px] uppercase text-muted-foreground">
                  #
                </th>
                {hg.headers.map((h) => (
                  <th
                    key={h.id}
                    className="border-b border-border bg-card px-2 py-1 text-[10px] uppercase text-muted-foreground"
                  >
                    {flexRender(h.column.columnDef.header, h.getContext())}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row, i) => (
              <tr key={row.id} className="hover:bg-accent/30">
                <td className="border-b border-border/50 px-2 py-1 text-[10px] text-muted-foreground">
                  {i + 1}
                </td>
                {row.getVisibleCells().map((cell) => (
                  <td
                    key={cell.id}
                    className="border-b border-border/50 px-2 py-1"
                    onDoubleClick={() => {
                      const colIdx = row
                        .getVisibleCells()
                        .findIndex((c) => c.id === cell.id);
                      const meta = result.columns[colIdx];
                      const v = row.original[colIdx];
                      setEditorTarget({
                        rowIndex: row.index,
                        column: meta,
                        value: formatValue(v),
                      });
                      setEditorOpen(true);
                    }}
                  >
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))}
            {filteredRows.length === 0 && (
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
                  await onCellSave(editorTarget.rowIndex, editorTarget.column.name, newValue);
                }
              : undefined
          }
        />
      )}
    </div>
  );
}
