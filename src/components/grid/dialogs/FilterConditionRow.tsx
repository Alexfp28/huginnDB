/**
 * One column → operator → value row, shared by {@link AdvancedFilterDialog}
 * and `BulkUpdateDialog`'s "match" section. See `filterConditions.ts` for
 * the operator/coercion helpers this renders around.
 */

import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { FilterOp } from "@/types";
import {
  VALUELESS_OPS,
  opsForColumn,
  type FilterConditionDraft,
} from "./filterConditions";

export function FilterConditionRow({
  columnNames,
  typeByColumn,
  row,
  onPatch,
  onRemove,
}: {
  columnNames: string[];
  typeByColumn: Map<string, string>;
  row: FilterConditionDraft;
  onPatch: (patch: Partial<FilterConditionDraft>) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const ops = opsForColumn(typeByColumn.get(row.column));
  const valueless = VALUELESS_OPS.includes(row.op);

  return (
    <div className="flex items-center gap-1.5">
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

      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-7 w-7 shrink-0"
        aria-label={t("tableData.filter.removeRow")}
        onClick={onRemove}
      >
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}
