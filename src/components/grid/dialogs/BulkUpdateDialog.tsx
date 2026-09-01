/**
 * Bulk update: apply a `$set`-shaped change to every row/document matching a
 * filter, in one round trip. The "match" half reuses the same
 * {@link FilterConditionRow} + `filterConditions.ts` helpers as
 * {@link AdvancedFilterDialog}; the "set" half reuses the same `RowValue`
 * shape the inline insert draft row already sends to `insert_row`.
 *
 * Every match/set change re-runs `previewBulkUpdate` (debounced) so the
 * dialog always shows the statement that would run and how many rows/
 * documents currently match it — the same preview/apply discipline the
 * structure editor uses for DDL, applied here to data instead. Applying with
 * no match condition requires ticking a separate "no filter" acknowledgement,
 * which is threaded through as `confirmUnfiltered` — a blank filter can't
 * silently become a full-table update.
 */

import { useEffect, useRef, useState } from "react";
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
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api } from "@/lib/tauri";
import { FilterConditionRow } from "./FilterConditionRow";
import {
  coerceFilterValue,
  VALUELESS_OPS,
  type FilterConditionDraft,
} from "./filterConditions";
import type {
  BulkUpdatePreview,
  ColumnFilter,
  ColumnInfo,
  FilterOp,
  RowValue,
} from "@/types";

/** Same rationale as `AdvancedFilterDialog`'s `LIST_OPS`: `in`/`not_in`
 *  filters carry a `values` array this row editor has no field for, so they
 *  are dropped when seeding the match condition rather than silently
 *  mis-rendered. The user can always add an equivalent `eq`/`ne` row here. */
const LIST_OPS: FilterOp[] = ["in", "not_in"];

interface SetFieldDraft {
  key: number;
  column: string;
  value: string;
}

let nextKey = 1;

export function BulkUpdateDialog({
  connectionId,
  schema,
  table,
  columns,
  initialFilters,
  isMongo,
  onApplied,
  onClose,
}: {
  connectionId: string;
  schema?: string;
  table: string;
  columns: ColumnInfo[];
  initialFilters: ColumnFilter[];
  isMongo: boolean;
  onApplied: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();

  const [matchRows, setMatchRows] = useState<FilterConditionDraft[]>(() =>
    initialFilters
      .filter((f) => !LIST_OPS.includes(f.op))
      .map((f) => ({
        key: nextKey++,
        column: f.column,
        op: f.op,
        value: f.value == null ? "" : String(f.value),
        value2: f.value2 == null ? "" : String(f.value2),
      })),
  );
  const [setRows, setSetRows] = useState<SetFieldDraft[]>([]);
  const [confirmUnfiltered, setConfirmUnfiltered] = useState(false);

  const [preview, setPreview] = useState<BulkUpdatePreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);

  const columnNames = columns.map((c) => c.name);
  const typeByColumn = new Map(columns.map((c) => [c.name, c.data_type]));

  const patchMatchRow = (key: number, patch: Partial<FilterConditionDraft>) =>
    setMatchRows((prev) =>
      prev.map((r) => (r.key === key ? { ...r, ...patch } : r)),
    );
  const removeMatchRow = (key: number) =>
    setMatchRows((prev) => prev.filter((r) => r.key !== key));
  const addMatchRow = () =>
    setMatchRows((prev) => [
      ...prev,
      {
        key: nextKey++,
        column: columnNames[0] ?? "",
        op: "eq",
        value: "",
        value2: "",
      },
    ]);

  const patchSetRow = (key: number, patch: Partial<SetFieldDraft>) =>
    setSetRows((prev) =>
      prev.map((r) => (r.key === key ? { ...r, ...patch } : r)),
    );
  const removeSetRow = (key: number) =>
    setSetRows((prev) => prev.filter((r) => r.key !== key));
  const addSetRow = () =>
    setSetRows((prev) => [
      ...prev,
      { key: nextKey++, column: columnNames[0] ?? "", value: "" },
    ]);

  function buildFilters(): ColumnFilter[] {
    return matchRows
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
  }

  function buildSetValues(): RowValue[] {
    return setRows
      .filter((r) => r.column)
      .map((r) => ({
        column: r.column,
        value: r.value === "" ? null : r.value,
        columnType: typeByColumn.get(r.column),
      }));
  }

  // Debounced preview: re-run on every match/set change so the statement +
  // affected count shown never lags behind what Apply would actually send.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const setValues = buildSetValues();
    if (setValues.length === 0) {
      setPreview(null);
      setPreviewError(null);
      return;
    }
    debounceRef.current = setTimeout(() => {
      setPreviewLoading(true);
      setPreviewError(null);
      api
        .previewBulkUpdate({
          connectionId,
          schema,
          table,
          filters: buildFilters(),
          setValues,
          confirmUnfiltered: true, // preview always runs; only apply gates on the checkbox
        })
        .then((p) => setPreview(p))
        .catch((e) => {
          setPreview(null);
          setPreviewError(String(e));
        })
        .finally(() => setPreviewLoading(false));
    }, 400);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, schema, table, matchRows, setRows]);

  const hasMatch = matchRows.some((r) => r.column);
  const hasSet = setRows.some((r) => r.column);
  const canApply = hasSet && (hasMatch || confirmUnfiltered) && !applying;

  async function apply() {
    if (!canApply) return;
    setApplying(true);
    setApplyError(null);
    try {
      await api.applyBulkUpdate({
        connectionId,
        schema,
        table,
        filters: buildFilters(),
        setValues: buildSetValues(),
        confirmUnfiltered: !hasMatch,
      });
      onApplied();
      onClose();
    } catch (e) {
      setApplyError(String(e));
    } finally {
      setApplying(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {isMongo
              ? t("tableData.bulkUpdate.titleDocuments")
              : t("tableData.bulkUpdate.titleRows")}
          </DialogTitle>
          <DialogDescription>
            {t("tableData.bulkUpdate.description")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <p className="mb-1.5 text-xs font-medium text-muted-foreground">
              {t("tableData.bulkUpdate.matchLabel")}
            </p>
            <div className="max-h-40 space-y-2 overflow-y-auto">
              {matchRows.length === 0 ? (
                <p className="py-2 text-xs text-muted-foreground">
                  {t("tableData.bulkUpdate.matchEmpty")}
                </p>
              ) : (
                matchRows.map((r) => (
                  <FilterConditionRow
                    key={r.key}
                    columnNames={columnNames}
                    typeByColumn={typeByColumn}
                    row={r}
                    onPatch={(patch) => patchMatchRow(r.key, patch)}
                    onRemove={() => removeMatchRow(r.key)}
                  />
                ))
              )}
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-1.5 h-7 gap-1 px-2 text-xs"
              disabled={columnNames.length === 0}
              onClick={addMatchRow}
            >
              <Plus className="h-3.5 w-3.5" />
              {t("tableData.bulkUpdate.addCondition")}
            </Button>
            {!hasMatch && (
              <label className="mt-2 flex items-center gap-1.5 text-xs text-destructive">
                <Checkbox
                  checked={confirmUnfiltered}
                  onChange={(e) => setConfirmUnfiltered(e.target.checked)}
                />
                {t("tableData.bulkUpdate.confirmUnfiltered")}
              </label>
            )}
          </div>

          <div>
            <p className="mb-1.5 text-xs font-medium text-muted-foreground">
              {t("tableData.bulkUpdate.setLabel")}
            </p>
            <div className="max-h-40 space-y-2 overflow-y-auto">
              {setRows.length === 0 ? (
                <p className="py-2 text-xs text-muted-foreground">
                  {t("tableData.bulkUpdate.setEmpty")}
                </p>
              ) : (
                setRows.map((r) => (
                  <div key={r.key} className="flex items-center gap-1.5">
                    <Select
                      value={r.column}
                      onValueChange={(v) => patchSetRow(r.key, { column: v })}
                    >
                      <SelectTrigger className="h-8 flex-1 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {columnNames.map((name) => (
                          <SelectItem
                            key={name}
                            value={name}
                            className="text-xs"
                          >
                            {name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Input
                      size="xs"
                      className="flex-1"
                      value={r.value}
                      placeholder={t(
                        "tableData.bulkUpdate.setValuePlaceholder",
                      )}
                      onChange={(e) =>
                        patchSetRow(r.key, { value: e.target.value })
                      }
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 shrink-0"
                      aria-label={t("tableData.filter.removeRow")}
                      onClick={() => removeSetRow(r.key)}
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))
              )}
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-1.5 h-7 gap-1 px-2 text-xs"
              disabled={columnNames.length === 0}
              onClick={addSetRow}
            >
              <Plus className="h-3.5 w-3.5" />
              {t("tableData.bulkUpdate.addField")}
            </Button>
          </div>

          {hasSet && (
            <div className="rounded-md border border-border bg-muted/30 p-2">
              <p className="mb-1 text-xs font-medium text-muted-foreground">
                {t("tableData.bulkUpdate.previewLabel")}
              </p>
              {previewLoading ? (
                <p className="text-xs text-muted-foreground">
                  {t("tableData.bulkUpdate.previewLoading")}
                </p>
              ) : previewError ? (
                <p className="text-xs text-destructive">{previewError}</p>
              ) : preview ? (
                <>
                  <pre className="max-h-24 overflow-y-auto whitespace-pre-wrap break-all font-mono text-2xs text-foreground">
                    {preview.statement}
                  </pre>
                  <p className="mt-1 text-xs font-medium text-foreground">
                    {t("tableData.bulkUpdate.affected", {
                      count: preview.affectedEstimate,
                    })}
                  </p>
                </>
              ) : null}
            </div>
          )}

          {applyError && (
            <p className="text-xs text-destructive">{applyError}</p>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            type="button"
            variant={hasMatch ? "default" : "destructive"}
            disabled={!canApply}
            onClick={() => void apply()}
          >
            {applying
              ? t("tableData.bulkUpdate.applying")
              : t("tableData.bulkUpdate.apply")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
