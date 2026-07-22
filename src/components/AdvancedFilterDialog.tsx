/**
 * Advanced per-column filter builder (#66).
 *
 * A modal that edits a list of {@link ColumnFilter} conditions — column →
 * operator → value — all AND-composed and applied server-side by
 * `fetch_table_data` (the same `serverFilters` the right-click "Filter by this
 * value" chips feed). The operator choices are type-aware: text columns get
 * substring/prefix/suffix matches, numeric and date columns get ordered
 * comparisons, and every column gets equality + null checks.
 *
 * Inspired by MongoDB Compass's field-level filter, but scoped to a flat
 * AND list (no nested OR groups) — enough for the "too many columns, the
 * global search feels limiting" case the issue describes without a full
 * query-builder tree.
 */

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { isBooleanType, isNumericType } from "@/lib/utils";
import type { CellValue, ColumnInfo, ColumnFilter, FilterOp } from "@/types";

/** Operators that don't consume a value. */
const VALUELESS_OPS: FilterOp[] = ["is_null", "is_not_null"];

/** Operators that match as text/regex regardless of the column's type — the
 *  raw string is always right for these, so they're excluded from the
 *  type-coercion below. */
const TEXT_MATCH_OPS: FilterOp[] = [
  "contains",
  "not_contains",
  "starts_with",
  "ends_with",
];

/**
 * Coerce the draft row's raw text input into a properly-typed value for
 * equality/ordering operators, mirroring what the right-click "Filter by
 * this value" chip already sends (the cell's already-typed value, e.g. a
 * JS number). Without this, every advanced-filter value left this dialog as
 * a plain string — harmless for the SQL drivers (Postgres/MySQL/SQLite
 * infer the bound parameter's type from the column it's compared against),
 * but MongoDB's equality is exact-BSON-type: a `string` "183" never matches
 * a stored `int32` 183, so the same filter that worked from the context
 * menu silently returned nothing from this dialog.
 */
function coerceFilterValue(
  raw: string,
  op: FilterOp,
  dataType: string | undefined,
): CellValue {
  if (!dataType || TEXT_MATCH_OPS.includes(op)) return raw;
  if (isNumericType(dataType)) {
    const n = Number(raw);
    if (raw.trim() !== "" && Number.isFinite(n)) return n;
  } else if (isBooleanType(dataType)) {
    const t = raw.trim().toLowerCase();
    if (t === "true" || t === "1") return true;
    if (t === "false" || t === "0") return false;
  }
  return raw;
}

/** True for date/time-ish column types (used to offer ordered comparisons). */
function isDateType(dataType: string): boolean {
  return /date|time|timestamp/i.test(dataType);
}

/** The operators offered for a column of the given type. Equality + null
 *  checks are universal; text columns add substring matches; numeric/date
 *  columns add ordered comparisons. An unknown/absent type falls back to the
 *  text set (a superset that still works via a text cast in the backend). */
function opsForColumn(dataType: string | undefined): FilterOp[] {
  const numeric = dataType ? isNumericType(dataType) : false;
  const date = dataType ? isDateType(dataType) : false;
  const ops: FilterOp[] = ["eq", "ne"];
  if (!numeric && !date) {
    ops.push("contains", "not_contains", "starts_with", "ends_with");
  }
  if (numeric || date) {
    ops.push("gt", "gte", "lt", "lte", "between");
  }
  ops.push("is_null", "is_not_null");
  return ops;
}

interface DraftRow {
  /** Stable React key, independent of array position. */
  key: number;
  column: string;
  op: FilterOp;
  value: string;
  /** Range upper bound, only used when `op === "between"`. */
  value2: string;
}

let nextKey = 1;

export function AdvancedFilterDialog({
  columns,
  initial,
  onApply,
  onClose,
}: {
  columns: ColumnInfo[];
  initial: ColumnFilter[];
  onApply: (filters: ColumnFilter[]) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();

  const [rows, setRows] = useState<DraftRow[]>(() =>
    initial.map((f) => ({
      key: nextKey++,
      column: f.column,
      op: f.op,
      value: f.value == null ? "" : String(f.value),
      value2: f.value2 == null ? "" : String(f.value2),
    })),
  );

  const columnNames = useMemo(() => columns.map((c) => c.name), [columns]);
  const typeByColumn = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of columns) m.set(c.name, c.data_type);
    return m;
  }, [columns]);

  const addRow = () => {
    const firstCol = columnNames[0] ?? "";
    setRows((prev) => [
      ...prev,
      { key: nextKey++, column: firstCol, op: "eq", value: "", value2: "" },
    ]);
  };

  const removeRow = (key: number) =>
    setRows((prev) => prev.filter((r) => r.key !== key));

  const patchRow = (key: number, patch: Partial<DraftRow>) =>
    setRows((prev) =>
      prev.map((r) => {
        if (r.key !== key) return r;
        const next = { ...r, ...patch };
        // When the column changes, snap the operator to one this column's
        // type actually supports so a stale op (e.g. "contains" on a number)
        // can't leak through.
        if (patch.column !== undefined) {
          const allowed = opsForColumn(typeByColumn.get(next.column));
          if (!allowed.includes(next.op)) next.op = allowed[0];
        }
        return next;
      }),
    );

  const apply = () => {
    const filters: ColumnFilter[] = rows
      .filter((r) => r.column)
      .map((r) => {
        const valueless = VALUELESS_OPS.includes(r.op);
        const dataType = typeByColumn.get(r.column);
        return {
          column: r.column,
          op: r.op,
          value: valueless
            ? undefined
            : coerceFilterValue(r.value, r.op, dataType),
          value2:
            r.op === "between"
              ? coerceFilterValue(r.value2, r.op, dataType)
              : undefined,
        };
      });
    onApply(filters);
    onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("tableData.filter.title")}</DialogTitle>
          <DialogDescription>
            {t("tableData.filter.description")}
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-80 space-y-2 overflow-y-auto">
          {rows.length === 0 ? (
            <p className="py-4 text-center text-xs text-muted-foreground">
              {t("tableData.filter.empty")}
            </p>
          ) : (
            rows.map((r) => {
              const ops = opsForColumn(typeByColumn.get(r.column));
              const valueless = VALUELESS_OPS.includes(r.op);
              return (
                <div key={r.key} className="flex items-center gap-1.5">
                  <Select
                    value={r.column}
                    onValueChange={(v) => patchRow(r.key, { column: v })}
                  >
                    <SelectTrigger className="h-8 flex-1 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {columnNames.map((name) => (
                        <SelectItem key={name} value={name} className="text-xs">
                          {name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>

                  <Select
                    value={r.op}
                    onValueChange={(v) =>
                      patchRow(r.key, { op: v as FilterOp })
                    }
                  >
                    <SelectTrigger className="h-8 w-40 shrink-0 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ops.map((op) => (
                        <SelectItem key={op} value={op} className="text-xs">
                          {t(`tableData.filter.op.${op}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>

                  {r.op === "between" ? (
                    <>
                      <Input
                        inputSize="xs"
                        className="flex-1"
                        value={r.value}
                        placeholder={t("tableData.filter.fromPlaceholder")}
                        onChange={(e) =>
                          patchRow(r.key, { value: e.target.value })
                        }
                      />
                      <span className="text-muted-foreground">–</span>
                      <Input
                        inputSize="xs"
                        className="flex-1"
                        value={r.value2}
                        placeholder={t("tableData.filter.toPlaceholder")}
                        onChange={(e) =>
                          patchRow(r.key, { value2: e.target.value })
                        }
                      />
                    </>
                  ) : (
                    <Input
                      inputSize="xs"
                      className="flex-1"
                      value={r.value}
                      disabled={valueless}
                      placeholder={
                        valueless ? "—" : t("tableData.filter.valuePlaceholder")
                      }
                      onChange={(e) =>
                        patchRow(r.key, { value: e.target.value })
                      }
                    />
                  )}

                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 shrink-0"
                    aria-label={t("tableData.filter.removeRow")}
                    onClick={() => removeRow(r.key)}
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
              );
            })
          )}
        </div>

        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 gap-1 self-start px-2 text-xs"
          disabled={columnNames.length === 0}
          onClick={addRow}
        >
          <Plus className="h-3.5 w-3.5" />
          {t("tableData.filter.addRow")}
        </Button>

        <DialogFooter className="items-center">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="mr-auto text-xs"
            disabled={rows.length === 0}
            onClick={() => setRows([])}
          >
            {t("tableData.filter.clearAll")}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="button" onClick={apply}>
            {t("tableData.filter.apply")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
