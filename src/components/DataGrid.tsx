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

import { useEffect, useMemo, useRef, useState } from "react";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
} from "@tanstack/react-table";
import { ArrowUpDown, ChevronDown, Plus, X } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown";
import { isNumericType } from "@/lib/utils";
import type {
  CellValue,
  ColumnFilter,
  ColumnInfo,
  ColumnMeta,
  DraftCell,
  DraftRow,
  QueryResult,
} from "@/types";
import { CellEditor } from "@/components/CellEditor";
import { CellPreview } from "@/components/CellPreview";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

interface Props {
  result: QueryResult;
  editable?: boolean;
  onCellSave?: (
    rowIndex: number,
    columnName: string,
    value: string | null,
  ) => Promise<void>;
  onSortChange?: (column: string, desc: boolean) => void;
  sortColumn?: string;
  sortDesc?: boolean;
  globalFilter?: string;
  onGlobalFilterChange?: (v: string) => void;
  /**
   * Newest-first list of recent search queries shown in a small
   * dropdown next to the filter input. Empty list → no dropdown button.
   */
  searchHistory?: string[];
  onPickHistory?: (q: string) => void;

  /** Server-side column filters; rendered as chips. */
  serverFilters?: ColumnFilter[];
  onAddFilter?: (f: ColumnFilter) => void;
  onRemoveFilter?: (index: number) => void;

  /** Row-level mutations. Only wired when the table has a PK. */
  onInsertRow?: () => void;
  onDuplicateRow?: (rowIndex: number) => void;
  onDeleteRow?: (rowIndex: number) => void;

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
  rowIndex: number;
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
  onCellSave,
  onSortChange,
  sortColumn,
  sortDesc,
  globalFilter,
  onGlobalFilterChange,
  searchHistory,
  onPickHistory,
  serverFilters,
  onAddFilter,
  onRemoveFilter,
  onInsertRow,
  onDuplicateRow,
  onDeleteRow,
  draftRow,
  draftColumns,
  onDraftCellChange,
  onDraftCommit,
  onDraftCancel,
}: Props) {
  const draftRowRef = useRef<HTMLTableRowElement | null>(null);
  const firstDraftInputRef = useRef<HTMLInputElement | null>(null);

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
    rowIndex: number;
    column: ColumnMeta;
    value: string;
  } | null>(null);

  /** Compact preview panel state. Cleared when the user clicks away or presses Esc. */
  const [selectedCell, setSelectedCell] = useState<SelectedCell | null>(null);
  /** Row index of the currently selected row (blue highlight). */
  const [selectedRowIndex, setSelectedRowIndex] = useState<number | null>(null);

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
    data: visibleRows,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  function openEditor(rowIndex: number, column: ColumnMeta, value: string) {
    setEditorTarget({ rowIndex, column, value });
    setEditorOpen(true);
  }

  async function copyToClipboard(text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // No surfacing — clipboard failures are visually obvious to the user.
    }
  }

  return (
    // `relative` allows CellPreview to be positioned absolute within this container.
    <div className="relative flex h-full flex-col">
      {/* Toolbar: filter chips + text filter + row count + elapsed time + insert */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-background px-3 py-1.5 text-xs">
        <SearchInput
          value={globalFilter ?? ""}
          onChange={onGlobalFilterChange}
          history={searchHistory ?? []}
          onPickHistory={onPickHistory}
        />
        {serverFilters?.map((f, i) => (
          <span
            key={`${f.column}-${f.op}-${i}`}
            className="flex items-center gap-1 rounded-full border border-border bg-muted/40 px-2 py-0.5 font-mono text-[11px]"
            title="Server-side filter"
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
              title="Remove filter"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        <span className="text-muted-foreground">
          {visibleRows.length.toLocaleString()} rows
          {result.total !== null && result.total !== undefined && (
            <> of {result.total.toLocaleString()}</>
          )}
        </span>
        {onInsertRow && (
          <button
            className="flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-[11px] hover:bg-accent"
            onClick={onInsertRow}
            title="Insert new row"
          >
            <Plus className="h-3 w-3" />
            Insert
          </button>
        )}
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
            {draftRow && (
              <DraftRowView
                rowRef={draftRowRef}
                firstInputRef={firstDraftInputRef}
                columns={result.columns}
                draftColumns={draftColumns ?? []}
                draft={draftRow}
                onChange={onDraftCellChange}
                onCommit={onDraftCommit}
                onCancel={onDraftCancel}
              />
            )}
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
                  {row.getVisibleCells().map((cell, colIdx) => {
                    const meta = result.columns[colIdx];
                    const value = row.original[colIdx];
                    return (
                      <ContextMenu key={cell.id}>
                        <ContextMenuTrigger asChild>
                          <td
                            className="cursor-pointer border-b border-border/50 px-2 py-1"
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelectedRowIndex(i);
                              setSelectedCell({
                                rowIndex: i,
                                colIndex: colIdx,
                                column: meta,
                                value,
                              });
                            }}
                            onContextMenu={() => {
                              setSelectedRowIndex(i);
                              setSelectedCell({
                                rowIndex: i,
                                colIndex: colIdx,
                                column: meta,
                                value,
                              });
                            }}
                            onDoubleClick={(e) => {
                              e.stopPropagation();
                              openEditor(i, meta, formatValue(value));
                            }}
                          >
                            {flexRender(cell.column.columnDef.cell, cell.getContext())}
                          </td>
                        </ContextMenuTrigger>
                        <ContextMenuContent>
                          <ContextMenuLabel>
                            {meta.name}
                            {value === null ? " · NULL" : ""}
                          </ContextMenuLabel>
                          <ContextMenuItem
                            onSelect={() => copyToClipboard(formatValue(value))}
                          >
                            Copy
                          </ContextMenuItem>
                          <ContextMenuItem
                            onSelect={() =>
                              copyToClipboard(
                                `${meta.name} = ${sqlLiteral(value)}`,
                              )
                            }
                          >
                            Copy with column name
                          </ContextMenuItem>
                          {editable && onCellSave && (
                            <ContextMenuItem
                              disabled={value === null}
                              onSelect={() =>
                                onCellSave(i, meta.name, null).catch(() => {})
                              }
                            >
                              Set NULL
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
                                Filter by this value
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
                                Filter excluding this value
                              </ContextMenuItem>
                            </>
                          )}
                          {(onInsertRow || onDuplicateRow || onDeleteRow) && (
                            <>
                              <ContextMenuSeparator />
                              {onInsertRow && (
                                <ContextMenuItem onSelect={() => onInsertRow()}>
                                  Insert row…
                                </ContextMenuItem>
                              )}
                              {onDuplicateRow && (
                                <ContextMenuItem
                                  onSelect={() => onDuplicateRow(i)}
                                >
                                  Duplicate row…
                                </ContextMenuItem>
                              )}
                              {onDeleteRow && (
                                <ContextMenuItem
                                  className="text-destructive focus:text-destructive"
                                  onSelect={() => onDeleteRow(i)}
                                >
                                  Delete row
                                </ContextMenuItem>
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
          onSetNull={
            editable && onCellSave
              ? async () => {
                  await onCellSave(
                    selectedCell.rowIndex,
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

/**
 * Toolbar search input with an optional history dropdown.
 *
 * The history list comes in as a controlled prop so the parent decides
 * the scope (per-connection, per-tab, etc.). Picking an entry replaces
 * the input value via `onChange` — the parent's debounce handler then
 * commits it to the backend just like a fresh keystroke.
 */
function SearchInput({
  value,
  onChange,
  history,
  onPickHistory,
}: {
  value: string;
  onChange?: (v: string) => void;
  history: string[];
  onPickHistory?: (q: string) => void;
}) {
  const hasHistory = history.length > 0;
  const hasValue = value.length > 0;
  return (
    <div className="flex h-7 items-stretch overflow-hidden rounded-md border border-input bg-background focus-within:ring-1 focus-within:ring-ring">
      <input
        className="w-56 bg-transparent px-2 text-xs focus:outline-none"
        placeholder="Filter rows…"
        value={value}
        onChange={(e) => onChange?.(e.target.value)}
      />
      {hasValue && (
        <button
          type="button"
          className="flex items-center justify-center px-1.5 text-muted-foreground/70 hover:bg-accent/30 hover:text-foreground"
          title="Clear filter"
          onClick={() => onChange?.("")}
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
                  onPickHistory?.(q);
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
  firstInputRef: React.MutableRefObject<HTMLInputElement | null>;
  columns: ColumnMeta[];
  draftColumns: ColumnInfo[];
  draft: DraftRow;
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
              ) : (
                <div className="flex items-center gap-1">
                  <input
                    ref={idx === firstEditableIdx ? firstInputRef : undefined}
                    className="h-6 w-full min-w-0 rounded-sm border border-input bg-background px-1.5 font-mono text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                    placeholder={cell.value === null ? "NULL" : ""}
                    value={cell.value ?? ""}
                    disabled={draft.saving}
                    onChange={(e) =>
                      onChange?.(col.name, {
                        value: e.target.value,
                        touched: true,
                      })
                    }
                  />
                  {info?.nullable && (
                    <button
                      type="button"
                      tabIndex={-1}
                      title="Set NULL"
                      disabled={draft.saving}
                      className={`shrink-0 rounded px-1 text-[10px] ${
                        cell.value === null && cell.touched
                          ? "bg-primary/20 text-primary"
                          : "text-muted-foreground/50 hover:text-foreground"
                      }`}
                      onMouseDown={(e) => {
                        // Prevent the input from blurring (which would
                        // trigger commit) when the user clicks "∅".
                        e.preventDefault();
                      }}
                      onClick={() =>
                        onChange?.(col.name, { value: null, touched: true })
                      }
                    >
                      ∅
                    </button>
                  )}
                </div>
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
