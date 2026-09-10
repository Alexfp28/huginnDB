/**
 * One column → operator → value row, shared by {@link AdvancedFilterDialog}
 * and `BulkUpdateDialog`'s "match" section. See `filterConditions.ts` for
 * the operator/coercion helpers this renders around.
 *
 * The row is single-line for every operator except `in`/`not_in`, whose value
 * control is multi-line: those keep the selects and the remove button on the
 * first line and give {@link FilterValueListEditor} the full width underneath.
 *
 * The field control has two shapes, chosen by `customFields`: a closed `Select`
 * where the driver's catalog enumerates every field (SQL), and
 * {@link FilterFieldPicker} where it does not (MongoDB — its nested paths come
 * from the loaded page and a document may hold fields that page never showed).
 * The operator and value halves are identical either way.
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
import type { FilterField } from "@/lib/grid/fieldPaths";
import { FilterFieldPicker } from "./FilterFieldPicker";
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
    /** Selectable fields, in the order the picker lists them. */
    fields: FilterField[];
    /**
     * Whether a field outside `fields` is legal — true for MongoDB, whose
     * documents are schemaless and whose nested paths are sampled from the
     * loaded page rather than enumerated by a catalog. Switches the field
     * control from a closed `Select` to {@link FilterFieldPicker}.
     */
    customFields?: boolean;
    row: FilterConditionDraft;
    onPatch: (patch: Partial<FilterConditionDraft>) => void;
    onRemove: () => void;
    /** Ring the row when the dialog was opened to edit this specific chip. */
    highlighted?: boolean;
  }
>(function FilterConditionRow(
  { fields, customFields, row, onPatch, onRemove, highlighted },
  ref,
) {
  const { t } = useTranslation();
  const ops = opsForColumn(fields.find((f) => f.path === row.column)?.type);
  const valueless = VALUELESS_OPS.includes(row.op);
  const list = isListOp(row.op);

  const columnSelect = customFields ? (
    <FilterFieldPicker
      fields={fields}
      value={row.column}
      onChange={(column) => onPatch({ column })}
    />
  ) : (
    <Select value={row.column} onValueChange={(v) => onPatch({ column: v })}>
      <SelectTrigger className="h-8 flex-1 text-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {fields.map((f) => (
          <SelectItem key={f.path} value={f.path} className="text-xs">
            {f.path}
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
