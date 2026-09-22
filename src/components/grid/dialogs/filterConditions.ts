/**
 * Shared helpers for a single AND-composed column-filter condition —
 * column → operator → value — used by both {@link AdvancedFilterDialog}
 * (the DataGrid's advanced filter) and `BulkUpdateDialog` (the "match"
 * half of a bulk update). Extracted so the two dialogs can't drift on how
 * an operator maps to its allowed value shape or how a raw text input gets
 * coerced to a typed `ColumnFilter` value.
 *
 * Everything here is pure and covered by `filterConditions.test.ts`; the two
 * dialogs contribute only React state and markup on top of it.
 */

import { isBooleanType, isNumericType } from "@/lib/grid/columnKinds";
import { MAX_FILTER_LIST_VALUES } from "@/lib/constants";
import type { CellValue, ColumnFilter, FilterOp } from "@/types";

/** Operators that don't consume a value. */
export const VALUELESS_OPS: FilterOp[] = ["is_null", "is_not_null"];

/**
 * Operators whose payload is a value *list* (`values`) rather than
 * `value`/`value2`.
 *
 * Used to live — twice, independently — inside `AdvancedFilterDialog` and
 * `BulkUpdateDialog`, in both cases as the set of filters to *discard* when
 * seeding a row, because neither row editor had a field for `values`. Both now
 * render them through {@link FilterValueListEditor}, so the constant's job is
 * the opposite one: telling the row which value control to show.
 */
export const LIST_OPS: FilterOp[] = ["in", "not_in"];

/** True when `op` reads `values` rather than `value`/`value2`. */
export function isListOp(op: FilterOp): boolean {
  return LIST_OPS.includes(op);
}

/** Operators that match as text/regex regardless of the column's type — the
 *  raw string is always right for these, so they're excluded from the
 *  type-coercion below. */
const TEXT_MATCH_OPS: FilterOp[] = [
  "contains",
  "not_contains",
  "starts_with",
  "ends_with",
];

/** True when `op` matches as text/regex, whatever the field's type is. */
export function isTextMatchOp(op: FilterOp): boolean {
  return TEXT_MATCH_OPS.includes(op);
}

/**
 * How a filter row's raw text is turned into a typed value.
 *
 * `"auto"` is the historical behaviour and the default: the field's type
 * decides (see {@link coerceFilterValue}). The rest are the user overruling
 * that, which on MongoDB is not a power-user nicety — see
 * {@link VALUE_TYPES} for why the inferred answer can be wrong in a way
 * nothing on screen explains.
 */
export type FilterValueType =
  | "auto"
  | "string"
  | "number"
  | "long"
  | "boolean"
  | "date"
  | "objectId";

/**
 * The explicit types offered, in the order the control lists them.
 *
 * **Why a control at all.** BSON equality is exact by type, and the type a
 * filter value *should* have is inferred from a sample — the page on screen,
 * falling back to the catalog's 100-document sample (`lib/grid/fieldPaths.ts`).
 * A schemaless collection can contradict both: a field stored as a `double` for
 * two years and as a `string` since last March has no single right answer, and
 * the failure is silent — `{value: {$ne: 5682380}}` against stored strings
 * excludes nothing and reports no error. The inference picks the likely answer;
 * this picks the one the user knows.
 *
 * **Why no `int` / `double` split.** MongoDB compares the numeric types against
 * each other — `{$eq: 900}` matches an `Int32`, an `Int64` and a `Double` 900
 * alike — so splitting them would offer three ways to ask one question.
 * `"long"` is here for a different reason: it emits `{"$numberLong": "…"}`,
 * which survives past 2^53 where `Number()` silently rounds.
 *
 * `"date"` and `"objectId"` emit `{"$date": …}` / `{"$oid": …}`. Both are
 * Extended JSON the backend already decodes (`db::mongo::values::object_to_bson`),
 * so none of this needs a backend change — and `"objectId"` is the only way to
 * filter an ObjectId held in a field other than `_id`, which is the one
 * `build_filter` special-cases.
 */
export const VALUE_TYPES: FilterValueType[] = [
  "auto",
  "string",
  "number",
  "long",
  "boolean",
  "date",
  "objectId",
];

/** Extended-JSON wrapper keys, by the type that emits one. */
const EXT_JSON_KEY: Partial<Record<FilterValueType, string>> = {
  long: "$numberLong",
  date: "$date",
  objectId: "$oid",
};

/**
 * Coerce a draft row's raw text input into a properly-typed value for
 * equality/ordering operators, mirroring what the right-click "Filter by
 * this value" chip already sends (the cell's already-typed value, e.g. a
 * JS number). Without this, every filter value left these dialogs as a
 * plain string — harmless for the SQL drivers (Postgres/MySQL/SQLite infer
 * the bound parameter's type from the column it's compared against), but
 * MongoDB's equality is exact-BSON-type: a `string` "183" never matches a
 * stored `int32` 183.
 *
 * `valueType` is the user's own answer and wins outright when it is not
 * `"auto"`; `"auto"` is the type-driven path this function has always had.
 *
 * **What `"auto"` still cannot know**, and why {@link VALUE_TYPES} exists: the
 * coercion is driven by the field's type, which for MongoDB is inferred from a
 * sample, and it only knows the three kinds `columnKinds` classifies — numeric,
 * boolean, everything-else-is-a-string. A heterogeneous field, which Mongo
 * permits, has no single true answer for the whole collection. Values the user
 * did **not** touch never reach this function at all: {@link filterFromDraft}
 * returns the original payload verbatim (see `seed` on
 * {@link FilterConditionDraft}), which is what stops a round trip through the
 * dialog from degrading a type on its own.
 */
export function coerceFilterValue(
  raw: string,
  op: FilterOp,
  dataType: string | undefined,
  valueType: FilterValueType = "auto",
): CellValue {
  // A text match is a regex against the field's string form whatever the field
  // holds (`db::mongo::query::text_match_branches`), so the raw string is right
  // for it no matter what either side says the type is.
  if (TEXT_MATCH_OPS.includes(op)) return raw;

  if (valueType !== "auto") {
    if (raw.trim() === "") return raw;
    const key = EXT_JSON_KEY[valueType];
    if (key) return { [key]: raw } as CellValue;
    if (valueType === "string") return raw;
    if (valueType === "number") {
      const n = Number(raw);
      return Number.isFinite(n) ? n : raw;
    }
    // boolean
    const t = raw.trim().toLowerCase();
    if (t === "true" || t === "1") return true;
    if (t === "false" || t === "0") return false;
    return raw;
  }

  if (!dataType) return raw;
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

/**
 * The explicit type a filter value already carries, for seeding a draft row
 * from an existing filter.
 *
 * Deliberately *not* the inverse of every `"auto"` outcome: a bare JS string
 * could equally have come from `"auto"` on a text field or from an explicit
 * `"string"`, and the two are indistinguishable in the payload. Reporting
 * `"string"` for it is the safe reading, because it is what {@link
 * filterFromDraft} will re-emit — whereas answering `"auto"` would let a
 * reopened dialog quietly re-coerce a value the user had already fixed. The
 * chip's job is to show what will be sent, and this is the same contract.
 */
export function valueTypeOf(v: CellValue | undefined): FilterValueType {
  if (v === null || v === undefined) return "auto";
  if (typeof v === "string") return "string";
  if (typeof v === "number") return "number";
  if (typeof v === "boolean") return "boolean";
  if (typeof v === "object" && !Array.isArray(v)) {
    const keys = Object.keys(v as Record<string, unknown>);
    if (keys.length === 1) {
      for (const [type, key] of Object.entries(EXT_JSON_KEY)) {
        if (keys[0] === key) return type as FilterValueType;
      }
    }
  }
  return "auto";
}

/**
 * The text a filter value shows in a draft row's input — the payload's own
 * text, with an Extended JSON wrapper peeled off so the user edits `5682380`
 * rather than `{"$numberLong":"5682380"}`.
 */
export function valueTextOf(v: CellValue | undefined): string {
  if (v === null || v === undefined) return "";
  const inner = extJsonInner(v);
  if (inner !== null) return inner;
  return String(v);
}

/** The single scalar inside a one-key Extended JSON wrapper, or `null`. */
function extJsonInner(v: CellValue | undefined): string | null {
  if (v == null || typeof v !== "object" || Array.isArray(v)) return null;
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length !== 1) return null;
  const [key, inner] = entries[0];
  if (!Object.values(EXT_JSON_KEY).includes(key)) return null;
  if (typeof inner === "string" || typeof inner === "number") return String(inner);
  return null;
}

/**
 * The operators offered for a column — every one the backend accepts, for
 * every column.
 *
 * This used to be type-aware: a numeric or date column lost
 * `contains`/`starts_with`/`ends_with`, and a text column lost
 * `gt`/`gte`/`lt`/`lte`/`between`. The backend restricts neither
 * (`commands::query::FilterOp` is a flat set), the SQL builder already wraps
 * the column in a text cast for the `LIKE` family, and the withheld
 * combinations are ones people genuinely want — "the invoice number contains
 * 4471", "the code sorts after 'M'". Withholding them also made the operator
 * list jump around as the user changed column, which is why the row editors
 * needed a "snap the op to something this column allows" rule that no longer
 * exists.
 *
 * The one combination that did *not* work when it was un-withheld was a text
 * match against a non-string MongoDB field: BSON's `$regex` inspects strings
 * only and answers zero rows rather than erroring. That is fixed at the source
 * in `db::mongo::query::text_match_branches`, which is why offering the full
 * set here is honest — see that function before narrowing this list again.
 */
export function opsForColumn(_dataType?: string | undefined): FilterOp[] {
  // `in`/`not_in` sit straight after `eq`/`ne`: they are equality against a
  // set, and that is where someone reaching for "=" looks when one value is
  // not enough.
  return [
    "eq",
    "ne",
    "in",
    "not_in",
    "contains",
    "not_contains",
    "starts_with",
    "ends_with",
    "gt",
    "gte",
    "lt",
    "lte",
    "between",
    "is_null",
    "is_not_null",
  ];
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
  /**
   * The list editor's text, one value per line. Only read when
   * {@link isListOp} holds for `op`.
   */
  listText: string;
  /**
   * Whether `NULL` is a member of the list, held separately from `listText`
   * on purpose: a magic `NULL` *token* would be indistinguishable from the
   * literal four-character string `"NULL"`, which is a perfectly legal value
   * in a text column. The backend is split the same way — it lifts the null
   * out of `values` and gives it a dedicated `IS NULL` branch before binding
   * the rest — so this mirrors the real model rather than inventing one.
   */
  listHasNull: boolean;
  /**
   * How `value` / `value2` / the list lines become typed values. `"auto"`
   * defers to the field's type, which is what every row did before the control
   * existed. See {@link VALUE_TYPES}.
   */
  valueType: FilterValueType;
  /**
   * The filter this row was seeded from, if any. Kept so
   * {@link filterFromDraft} can hand back the original payload untouched when
   * the row's textual projection is unchanged — see there for why.
   */
  seed?: ColumnFilter;
}

/** Render one filter value as the line the list editor shows for it. */
function valueLine(v: CellValue): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (extJsonInner(v) !== null) return valueTextOf(v);
  return JSON.stringify(v);
}

/**
 * Split the list editor's text into values, one per line.
 *
 * `\r?\n`, not `\n`: text pasted from Excel or any Windows-native source
 * arrives CRLF-delimited, and splitting on the bare newline leaves an
 * invisible `\r` glued to the end of every value — a filter that matches
 * nothing, for a reason nothing on screen can show. Blank lines are dropped
 * (trailing newline, double-tap on Enter) but interior whitespace is *not*
 * trimmed, since a leading or trailing space can be a real part of a value.
 */
export function parseValueList(text: string): string[] {
  return text.split(/\r?\n/).filter((line) => line !== "");
}

/**
 * Render a filter's `values` back into the editor's text, dropping the null
 * member — that one is carried by `listHasNull` instead (see
 * {@link FilterConditionDraft}).
 */
export function formatValueList(values: CellValue[] | undefined): string {
  return (values ?? [])
    .filter((v) => v !== null && v !== undefined)
    .map(valueLine)
    .join("\n");
}

/** True when a filter's `values` contains an explicit null member. */
export function listHasNullMember(values: CellValue[] | undefined): boolean {
  return (values ?? []).some((v) => v === null || v === undefined);
}

/**
 * The one value type a whole filter stands for, read off whichever half it
 * actually carries. A list op holds its values in `values`, and its `null`
 * member says nothing about the type, so it is skipped.
 */
export function filterValueType(f: ColumnFilter): FilterValueType {
  if (isListOp(f.op)) {
    return valueTypeOf((f.values ?? []).find((v) => v != null) ?? null);
  }
  return valueTypeOf(f.value);
}

/** Seed one draft row from an existing filter. */
export function draftFromFilter(
  f: ColumnFilter,
  key: number,
): FilterConditionDraft {
  return {
    key,
    column: f.column,
    op: f.op,
    value: valueTextOf(f.value),
    value2: valueTextOf(f.value2),
    listText: formatValueList(f.values),
    listHasNull: listHasNullMember(f.values),
    valueType: filterValueType(f),
    seed: f,
  };
}

/** An empty draft row for `column`. */
export function emptyDraft(column: string, key: number): FilterConditionDraft {
  return {
    key,
    column,
    op: "eq",
    value: "",
    value2: "",
    listText: "",
    listHasNull: false,
    valueType: "auto",
  };
}

/**
 * Apply a patch to a draft row.
 *
 * Shared so the two dialogs can't drift: `AdvancedFilterDialog` used to snap
 * the operator when the column changed and `BulkUpdateDialog` did not, a
 * divergence with no reason behind it. That rule is gone entirely now that
 * {@link opsForColumn} offers every operator for every column — there is no
 * such thing as an operator a column cannot take, so snapping would be dead
 * code rather than a safeguard.
 */
export function patchDraft(
  row: FilterConditionDraft,
  patch: Partial<FilterConditionDraft>,
): FilterConditionDraft {
  return { ...row, ...patch };
}

/**
 * Build the `ColumnFilter` a draft row stands for.
 *
 * **Pass-through when untouched.** If the row was seeded from an existing
 * filter and its textual projection still matches that filter, the original
 * payload is returned *by reference*, types intact. Without this, merely
 * opening the dialog and pressing Apply would degrade every filter it holds:
 * a MongoDB `Int64`, a JSON object, a value containing a newline — each one
 * survives only as `String(value)` in the draft, and re-coercing that string
 * through {@link coerceFilterValue} cannot reconstruct what it came from. The
 * dialog replaces the whole filter array on apply, so "the user did not touch
 * this row" has to mean "nothing about this filter changed".
 */
export function filterFromDraft(
  row: FilterConditionDraft,
  dataType: string | undefined,
): ColumnFilter {
  if (row.seed && isDraftUnchanged(row, row.seed)) return row.seed;

  if (isListOp(row.op)) {
    const values: CellValue[] = parseValueList(row.listText).map((raw) =>
      coerceFilterValue(raw, row.op, dataType, row.valueType),
    );
    if (row.listHasNull) values.push(null);
    return { column: row.column, op: row.op, values };
  }

  const valueless = VALUELESS_OPS.includes(row.op);
  return {
    column: row.column,
    op: row.op,
    value: valueless
      ? undefined
      : coerceFilterValue(row.value, row.op, dataType, row.valueType),
    value2:
      row.op === "between"
        ? coerceFilterValue(row.value2, row.op, dataType, row.valueType)
        : undefined,
  };
}

/**
 * Whether a draft still projects to exactly the filter it was seeded from.
 *
 * Compares the *textual* projection rather than the rebuilt payload, because
 * the payload is precisely what cannot be rebuilt faithfully — that is the
 * whole reason the seed is kept. The value type is compared too: changing only
 * the type, with the text left alone, is a real edit (it is the whole point of
 * the control) and would otherwise hit the pass-through and be discarded.
 */
function isDraftUnchanged(
  row: FilterConditionDraft,
  seed: ColumnFilter,
): boolean {
  if (row.column !== seed.column || row.op !== seed.op) return false;
  if (row.valueType !== filterValueType(seed)) return false;
  if (isListOp(row.op)) {
    return (
      row.listText === formatValueList(seed.values) &&
      row.listHasNull === listHasNullMember(seed.values)
    );
  }
  return (
    row.value === valueTextOf(seed.value) &&
    row.value2 === valueTextOf(seed.value2)
  );
}

/**
 * How many values a list-op row currently holds, `NULL` included.
 *
 * The `NULL` counts because the backend counts it: `validate_filters` caps the
 * `values` array it receives, and {@link filterFromDraft} pushes the null into
 * that array.
 */
export function listValueCount(row: FilterConditionDraft): number {
  return parseValueList(row.listText).length + (row.listHasNull ? 1 : 0);
}

/**
 * The rows whose value list is over the backend's cap, by `key`.
 *
 * The dialog disables Apply rather than truncating (silent data loss) or
 * letting the call through (a raw backend error string in a toast, well after
 * the user has stopped looking at the list they pasted).
 */
export function overlongListRows(rows: FilterConditionDraft[]): Set<number> {
  const over = new Set<number>();
  for (const r of rows) {
    if (isListOp(r.op) && listValueCount(r) > MAX_FILTER_LIST_VALUES) {
      over.add(r.key);
    }
  }
  return over;
}
