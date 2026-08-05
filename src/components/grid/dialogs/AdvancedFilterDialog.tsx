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
import { Plus } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { ColumnInfo, ColumnFilter, FilterOp } from "@/types";
import { FilterConditionRow } from "./FilterConditionRow";
import {
  coerceFilterValue,
  opsForColumn,
  VALUELESS_OPS,
  type FilterConditionDraft,
} from "./filterConditions";

/**
 * Ops whose payload is a value *list* (`values`) rather than `value`/`value2`.
 *
 * They are built by the data grid's "filter by the selected rows" action (#114),
 * never by hand here — `opsForColumn` doesn't offer them, and typing a hundred
 * values into a text box isn't the use case. This dialog replaces the whole
 * filter list on apply, so such a filter has to be held aside and re-attached
 * verbatim: round-tripping it through `DraftRow` would drop `values` (the row
 * model has no field for it) and coerce the empty `value` into a degenerate
 * `IN ()` that matches nothing. They stay visible and removable as toolbar
 * chips, which is where they were created.
 */
const LIST_OPS: FilterOp[] = ["in", "not_in"];

type DraftRow = FilterConditionDraft;

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
    initial
      .filter((f) => !LIST_OPS.includes(f.op))
      .map((f) => ({
        key: nextKey++,
        column: f.column,
        op: f.op,
        value: f.value == null ? "" : String(f.value),
        value2: f.value2 == null ? "" : String(f.value2),
      })),
  );

  /** Active list filters, passed through untouched on apply (see `LIST_OPS`). */
  const listFilters = useMemo(
    () => initial.filter((f) => LIST_OPS.includes(f.op)),
    [initial],
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
    onApply([...listFilters, ...filters]);
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
            rows.map((r) => (
              <FilterConditionRow
                key={r.key}
                columnNames={columnNames}
                typeByColumn={typeByColumn}
                row={r}
                onPatch={(patch) => patchRow(r.key, patch)}
                onRemove={() => removeRow(r.key)}
              />
            ))
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
