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
 */

import { useMemo, useState } from "react";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
} from "@tanstack/react-table";
import { ArrowUpDown } from "lucide-react";
import { isNumericType } from "@/lib/utils";
import type { CellValue, ColumnMeta, QueryResult } from "@/types";
import { CellEditor } from "@/components/CellEditor";
import { CellPreview } from "@/components/CellPreview";

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

/** Render a cell value as a plain string for display and search. */
function formatValue(v: CellValue): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

interface SelectedCell {
  rowIndex: number;
  colIndex: number;
  column: ColumnMeta;
  value: CellValue;
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
  /** Full Monaco editor (opened via CellPreview F11 or double-click). */
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorTarget, setEditorTarget] = useState<{
    rowIndex: number;
    column: ColumnMeta;
    value: string;
  } | null>(null);

  /** Compact preview panel state. Cleared when the user clicks away or presses Esc. */
  const [selectedCell, setSelectedCell] = useState<SelectedCell | null>(null);
  /** Row index of the currently selected row (blue highlight). */
  const [selectedRowIndex, setSelectedRowIndex] = useState<number | null>(null);

  const filteredRows = useMemo(() => {
    if (!globalFilter) return result.rows;
    const q = globalFilter.toLowerCase();
    return result.rows.filter((r) =>
      r.some((c) => formatValue(c).toLowerCase().includes(q)),
    );
  }, [result.rows, globalFilter]);

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

  const columns = useMemo<ColumnDef<CellValue[]>[]>(
    () =>
      result.columns.map((col, idx) => ({
        id: col.name,
        header: () => (
          <button
            className="flex items-center gap-1 hover:text-foreground"
            onClick={() =>
              onSortChange?.(
                col.name,
                sortColumn === col.name ? !sortDesc : false,
              )
            }
          >
            <span className="truncate">{col.name}</span>
            <span className="text-[9px] uppercase text-muted-foreground/50">
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
          const isNumeric = numericColNames.has(col.name);
          return (
            <div className="flex max-w-md items-center gap-1">
              <span
                className={`truncate font-mono text-xs ${
                  isNumeric ? "text-amber-400" : ""
                }`}
              >
                {v === null ? (
                  <span className="italic text-muted-foreground">NULL</span>
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
    [result.columns, numericColNames, sortColumn, sortDesc, onSortChange],
  );

  const table = useReactTable({
    data: filteredRows,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  function openEditor(rowIndex: number, column: ColumnMeta, value: string) {
    setEditorTarget({ rowIndex, column, value });
    setEditorOpen(true);
  }

  return (
    // `relative` allows CellPreview to be positioned absolute within this container.
    <div className="relative flex h-full flex-col">
      {/* Toolbar: filter input + row count + elapsed time */}
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

      {/* Scrollable data table */}
      <div
        className="flex-1 overflow-auto"
        // Close the cell preview when clicking outside the table cells.
        onClick={() => setSelectedCell(null)}
      >
        <table className="w-full border-separate border-spacing-0 text-left">
          <thead className="sticky top-0 z-10 bg-card">
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                <th className="border-b border-border bg-card px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                  #
                </th>
                {hg.headers.map((h) => (
                  <th
                    key={h.id}
                    className="border-b border-border bg-card px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground"
                  >
                    {flexRender(h.column.columnDef.header, h.getContext())}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row, i) => {
              const isSelected = selectedRowIndex === i;
              return (
                <tr
                  key={row.id}
                  className={
                    isSelected
                      ? "bg-blue-500/10"
                      : "hover:bg-accent/30"
                  }
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelectedRowIndex(i);
                  }}
                >
                  <td className="border-b border-border/50 px-2 py-1 text-[10px] text-muted-foreground">
                    {i + 1}
                  </td>
                  {row.getVisibleCells().map((cell, colIdx) => (
                    <td
                      key={cell.id}
                      className="cursor-pointer border-b border-border/50 px-2 py-1"
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedRowIndex(i);
                        const meta = result.columns[colIdx];
                        setSelectedCell({
                          rowIndex: i,
                          colIndex: colIdx,
                          column: meta,
                          value: row.original[colIdx],
                        });
                      }}
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        const meta = result.columns[colIdx];
                        openEditor(i, meta, formatValue(row.original[colIdx]));
                      }}
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              );
            })}
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

      {/* Compact cell preview panel */}
      {selectedCell && (
        <CellPreview
          columnName={selectedCell.column.name}
          value={selectedCell.value}
          onClose={() => setSelectedCell(null)}
          onFullscreen={() => {
            openEditor(
              selectedCell.rowIndex,
              selectedCell.column,
              formatValue(selectedCell.value),
            );
            setSelectedCell(null);
          }}
          onSave={
            editable && onCellSave
              ? async (v) => {
                  await onCellSave(
                    selectedCell.rowIndex,
                    selectedCell.column.name,
                    v,
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
                    editorTarget.rowIndex,
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
