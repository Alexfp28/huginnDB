/**
 * The server-filter chips above the grid: one per active `ColumnFilter`, plus
 * the "N filters" summary that collapses them when there are too many to show.
 *
 * A chip is `column op value`, and the three pieces come from here:
 * `FILTER_LABEL` maps every `FilterOp` to its symbol (spelled out per variant,
 * so adding an operator is a compile error rather than a blank chip),
 * `filterValueLabel` renders the value half, and `filterValuesTooltip` defers an
 * `IN` list — which can hold hundreds of values — to a tooltip while the chip
 * shows only a count.
 */

import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { ChevronDown, Filter, X } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown";

import { formatValue } from "@/lib/grid/formatValue";
import type { ColumnFilter } from "@/types";

const FILTER_LABEL: Record<ColumnFilter["op"], string> = {
  eq: "=",
  ne: "<>",
  contains: "⊇",
  not_contains: "⊉",
  starts_with: "^…",
  ends_with: "…$",
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
  between: "↔",
  in: "IN",
  not_in: "NOT IN",
  is_null: "IS NULL",
  is_not_null: "IS NOT NULL",
};
/**
 * The value half of a filter chip's label — the part after `column op`. An
 * `IN` list is summarised by count (it can hold hundreds of values, with the
 * values themselves deferred to a tooltip); `IS NULL` and friends have no
 * value at all.
 */
function filterValueLabel(f: ColumnFilter, t: TFunction): string | null {
  if (f.op === "in" || f.op === "not_in") {
    return t("dataGrid.filterValueCount", { count: f.values?.length ?? 0 });
  }
  if (f.op === "eq" || f.op === "ne") {
    return f.value === null || f.value === undefined
      ? "NULL"
      : formatValue(f.value);
  }
  return null;
}

/** Values behind an `IN` / `NOT IN` chip, for its tooltip. */
function filterValuesTooltip(f: ColumnFilter): string | undefined {
  if (f.op !== "in" && f.op !== "not_in") return undefined;
  return (f.values ?? [])
    .map((v) => (v === null || v === undefined ? "NULL" : formatValue(v)))
    .join(", ");
}

/** One active server-side filter, as a removable chip in the toolbar. */
export function ServerFilterChip({
  filter: f,
  onRemove,
}: {
  filter: ColumnFilter;
  onRemove?: () => void;
}) {
  const { t } = useTranslation();
  const value = filterValueLabel(f, t);
  return (
    <span
      className="flex items-center gap-1 rounded-full border border-border bg-muted/40 px-2 py-0.5 font-mono text-2xs"
      title={t("dataGrid.serverSideFilter")}
    >
      <span className="text-muted-foreground">{f.column}</span>
      <span className="text-muted-foreground/70">{FILTER_LABEL[f.op]}</span>
      {value !== null && (
        <span className="max-w-[10rem] truncate" title={filterValuesTooltip(f)}>
          {value}
        </span>
      )}
      {onRemove && (
        <button
          className="ml-1 text-muted-foreground/60 hover:text-foreground"
          onClick={onRemove}
          title={t("dataGrid.removeFilter")}
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </span>
  );
}

/**
 * The narrow-pane form of the chip row: one chip carrying the filter count,
 * whose dropdown still removes filters one by one. Selecting an entry removes
 * that filter and deliberately keeps the menu open (`preventDefault` on the
 * select), since clearing several filters in a row is the common case and
 * re-opening the menu each time would be busywork.
 */
export function ServerFilterSummary({
  filters,
  onRemove,
}: {
  filters: ColumnFilter[];
  onRemove?: (index: number) => void;
}) {
  const { t } = useTranslation();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className="flex shrink-0 items-center gap-1 rounded-full border border-border bg-muted/40 px-2 py-0.5 text-2xs text-muted-foreground hover:text-foreground"
          title={t("dataGrid.serverSideFilter")}
        >
          <Filter className="h-3 w-3 text-brand" />
          {t("dataGrid.activeFilterCount", { count: filters.length })}
          <ChevronDown className="h-3 w-3 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {filters.map((f, i) => {
          const value = filterValueLabel(f, t);
          return (
            <DropdownMenuItem
              key={`${f.column}-${f.op}-${i}`}
              className="gap-2 font-mono text-xs"
              title={filterValuesTooltip(f) ?? t("dataGrid.removeFilter")}
              disabled={!onRemove}
              onSelect={(e) => {
                e.preventDefault();
                onRemove?.(i);
              }}
            >
              <span className="text-muted-foreground">{f.column}</span>
              <span className="text-muted-foreground/70">
                {FILTER_LABEL[f.op]}
              </span>
              {value !== null && (
                <span className="max-w-[14rem] truncate">{value}</span>
              )}
              <X className="ml-auto h-3 w-3 shrink-0 text-muted-foreground/60" />
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
