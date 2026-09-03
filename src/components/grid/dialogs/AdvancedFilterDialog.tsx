/**
 * Advanced per-column filter builder (#66).
 *
 * A modal that edits a list of {@link ColumnFilter} conditions — column →
 * operator → value — all AND-composed and applied server-side by
 * `fetch_table_data` (the same `serverFilters` the right-click "Filter by this
 * value" chips feed).
 *
 * **It is a bijection with `serverFilters`, and that is load-bearing.** Every
 * operator the backend accepts is offered for every column, and every filter
 * shape — including the `values` list of `in`/`not_in` — has a control here,
 * so the dialog edits the whole filter array rather than a subset of it, in
 * order. `in`/`not_in` used to be held aside and re-attached verbatim because
 * the row editor had no field for `values`; the reason that mattered is that a
 * dialog editing only *some* of the filters cannot be addressed by position.
 * Now that it edits all of them, a toolbar chip's index *is* a row index,
 * which is the entire mechanism behind {@link focusIndex} — clicking a chip
 * opens this dialog scrolled to the row that chip stands for, with no stable
 * ids, no DTO change and no backend involvement. Keep the correspondence
 * whole: hold a filter shape aside again and chip-editing silently edits the
 * wrong row.
 *
 * Inspired by MongoDB Compass's field-level filter, but scoped to a flat
 * AND list (no nested OR groups) — enough for the "too many columns, the
 * global search feels limiting" case the issue describes without a full
 * query-builder tree.
 */

import { useEffect, useMemo, useRef, useState } from "react";
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
import type { ColumnInfo, ColumnFilter } from "@/types";
import { FilterConditionRow } from "./FilterConditionRow";
import {
  draftFromFilter,
  emptyDraft,
  filterFromDraft,
  overlongListRows,
  patchDraft,
  type FilterConditionDraft,
} from "./filterConditions";

type DraftRow = FilterConditionDraft;

let nextKey = 1;

export function AdvancedFilterDialog({
  columns,
  initial,
  focusIndex,
  onApply,
  onClose,
}: {
  columns: ColumnInfo[];
  initial: ColumnFilter[];
  /**
   * Index into `initial` of the filter the dialog was opened to edit — set
   * when the user clicked a toolbar chip rather than the "Filter" button. The
   * matching row is scrolled into view, ringed and focused on mount.
   */
  focusIndex?: number | null;
  onApply: (filters: ColumnFilter[]) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();

  const [rows, setRows] = useState<DraftRow[]>(() =>
    initial.map((f) => draftFromFilter(f, nextKey++)),
  );

  const focusedKey = useMemo(() => {
    if (focusIndex == null) return null;
    return rows[focusIndex]?.key ?? null;
    // Seeded once: the highlight names the row the user clicked, and must not
    // chase it if the list is later reordered or trimmed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusIndex]);

  const focusedRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (focusedKey == null) return;
    const el = focusedRef.current;
    if (!el) return;
    el.scrollIntoView({ block: "nearest" });
    el.querySelector<HTMLElement>("input, textarea, button")?.focus();
  }, [focusedKey]);

  const columnNames = useMemo(() => columns.map((c) => c.name), [columns]);
  const typeByColumn = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of columns) m.set(c.name, c.data_type);
    return m;
  }, [columns]);

  /** Rows whose value list is over the backend's cap — Apply is blocked while
   *  any exists, rather than truncating or letting the call fail. */
  const overlong = useMemo(() => overlongListRows(rows), [rows]);

  const addRow = () =>
    setRows((prev) => [...prev, emptyDraft(columnNames[0] ?? "", nextKey++)]);

  const removeRow = (key: number) =>
    setRows((prev) => prev.filter((r) => r.key !== key));

  const patchRow = (key: number, patch: Partial<DraftRow>) =>
    setRows((prev) =>
      prev.map((r) => (r.key === key ? patchDraft(r, patch) : r)),
    );

  const apply = () => {
    onApply(
      rows
        .filter((r) => r.column)
        .map((r) => filterFromDraft(r, typeByColumn.get(r.column))),
    );
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
                ref={r.key === focusedKey ? focusedRef : undefined}
                highlighted={r.key === focusedKey}
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
          <Button type="button" disabled={overlong.size > 0} onClick={apply}>
            {t("tableData.filter.apply")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
