/**
 * One column → operator → value row, shared by {@link AdvancedFilterDialog}
 * and `BulkUpdateDialog`'s "match" section. See `filterConditions.ts` for
 * the operator/coercion helpers this renders around.
 *
 * The row is single-line for every operator except `in`/`not_in`, whose value
 * control is multi-line: those keep the selects and the remove button on the
 * first line and give {@link FilterValueListEditor} the full width underneath.
 */

import { forwardRef } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { IconButton } from "@/components/ui/icon-button";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { FilterOp } from "@/types";
import { FilterValueListEditor } from "./FilterValueListEditor";
import {
  VALUELESS_OPS,
  isListOp,
  listValueCount,
  opsForColumn,
  type FilterConditionDraft,
} from "./filterConditions";

export const FilterConditionRow = forwardRef<
  HTMLDivElement,
  {
    columnNames: string[];
    typeByColumn: Map<string, string>;
    row: FilterConditionDraft;
    onPatch: (patch: Partial<FilterConditionDraft>) => void;
    onRemove: () => void;
    /** Ring the row when the dialog was opened to edit this specific chip. */
    highlighted?: boolean;
  }
>(function FilterConditionRow(
  { columnNames, typeByColumn, row, onPatch, onRemove, highlighted },
  ref,
) {
  const { t } = useTranslation();
  const ops = opsForColumn(typeByColumn.get(row.column));
  const valueless = VALUELESS_OPS.includes(row.op);
  const list = isListOp(row.op);

  const columnSelect = (
    <Select value={row.column} onValueChange={(v) => onPatch({ column: v })}>
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
  );

  const opSelect = (
    <Select value={row.op} onValueChange={(v) => onPatch({ op: v as FilterOp })}>
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
  );

  // Removing one row of a not-yet-applied draft destroys nothing, so `quiet`
  // rather than `destructive` (gotcha #61).
  const removeButton = (
    <IconButton
      type="button"
      icon={X}
      label={t("tableData.filter.removeRow")}
      onClick={onRemove}
      className="shrink-0"
    />
  );

  // `scroll-mt-2` keeps the row clear of the scroll container's top edge when
  // the dialog opens focused on it. Built with `cn` and whole literal classes,
  // never an interpolated template: Tailwind's JIT scans source as text, so a
  // class assembled at runtime is simply never generated (gotcha #60).
  const outer = cn("scroll-mt-2", highlighted && "rounded-md ring-2 ring-brand/40");

  if (list) {
    return (
      <div ref={ref} className={cn("space-y-1.5", outer)}>
        <div className="flex items-center gap-1.5">
          {columnSelect}
          {opSelect}
          {removeButton}
        </div>
        <FilterValueListEditor
          text={row.listText}
          hasNull={row.listHasNull}
          count={listValueCount(row)}
          onTextChange={(listText) => onPatch({ listText })}
          onHasNullChange={(listHasNull) => onPatch({ listHasNull })}
        />
      </div>
    );
  }

  return (
    <div ref={ref} className={cn("flex items-center gap-1.5", outer)}>
      {columnSelect}
      {opSelect}

      {row.op === "between" ? (
        <>
          <Input
            size="xs"
            className="flex-1"
            value={row.value}
            placeholder={t("tableData.filter.fromPlaceholder")}
            onChange={(e) => onPatch({ value: e.target.value })}
          />
          <span className="text-muted-foreground">–</span>
          <Input
            size="xs"
            className="flex-1"
            value={row.value2}
            placeholder={t("tableData.filter.toPlaceholder")}
            onChange={(e) => onPatch({ value2: e.target.value })}
          />
        </>
      ) : (
        <Input
          size="xs"
          className="flex-1"
          value={row.value}
          disabled={valueless}
          placeholder={valueless ? "—" : t("tableData.filter.valuePlaceholder")}
          onChange={(e) => onPatch({ value: e.target.value })}
        />
      )}

      {removeButton}
    </div>
  );
});
