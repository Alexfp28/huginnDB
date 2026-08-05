/**
 * Shared helpers for a single AND-composed column-filter condition —
 * column → operator → value — used by both {@link AdvancedFilterDialog}
 * (the DataGrid's advanced filter) and `BulkUpdateDialog` (the "match"
 * half of a bulk update). Extracted so the two dialogs can't drift on how
 * an operator maps to its allowed value shape or how a raw text input gets
 * coerced to a typed {@link ColumnFilter} value.
 */

import { isBooleanType, isNumericType } from "@/lib/grid/columnKinds";
import type { CellValue, FilterOp } from "@/types";

/** Operators that don't consume a value. */
export const VALUELESS_OPS: FilterOp[] = ["is_null", "is_not_null"];

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
 * Coerce a draft row's raw text input into a properly-typed value for
 * equality/ordering operators, mirroring what the right-click "Filter by
 * this value" chip already sends (the cell's already-typed value, e.g. a
 * JS number). Without this, every filter value left these dialogs as a
 * plain string — harmless for the SQL drivers (Postgres/MySQL/SQLite infer
 * the bound parameter's type from the column it's compared against), but
 * MongoDB's equality is exact-BSON-type: a `string` "183" never matches a
 * stored `int32` 183.
 */
export function coerceFilterValue(
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
export function opsForColumn(dataType: string | undefined): FilterOp[] {
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

/** Draft state for one condition row, before it's coerced into a
 *  {@link ColumnFilter} on apply. */
export interface FilterConditionDraft {
  /** Stable React key, independent of array position. */
  key: number;
  column: string;
  op: FilterOp;
  value: string;
  /** Range upper bound, only used when `op === "between"`. */
  value2: string;
}
