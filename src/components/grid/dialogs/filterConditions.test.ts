/**
 * Characterization tests for the grid's filter-condition model.
 *
 * The subsystem had no coverage at all before `in`/`not_in` reached the UI,
 * which is how a real divergence (only one of the two dialogs snapped the
 * operator when the column changed) survived unnoticed. These pin the parts
 * both dialogs now share.
 */

import { describe, expect, it } from "vitest";
import { MAX_FILTER_LIST_VALUES } from "@/lib/constants";
import type { ColumnFilter } from "@/types";
import {
  coerceFilterValue,
  draftFromFilter,
  filterValueType,
  emptyDraft,
  filterFromDraft,
  formatValueList,
  isListOp,
  listValueCount,
  opsForColumn,
  overlongListRows,
  parseValueList,
  patchDraft,
  valueTextOf,
  valueTypeOf,
} from "./filterConditions";

describe("opsForColumn", () => {
  const ALL = [
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

  it.each([
    ["numeric", "bigint"],
    ["date", "timestamp with time zone"],
    ["text", "varchar(255)"],
    ["unknown", undefined],
  ])("offers every operator for a %s column", (_kind, dataType) => {
    expect(opsForColumn(dataType)).toEqual(ALL);
  });

  it("puts in/not_in straight after eq/ne", () => {
    // Their semantic neighbourhood: equality against a set. Someone reaching
    // for "=" and finding one value is not enough looks right there.
    expect(opsForColumn("text").slice(0, 4)).toEqual(["eq", "ne", "in", "not_in"]);
  });

  it("offers the text-match family on a numeric column", () => {
    // Withheld before. Honest only because `db::mongo::query` stopped
    // answering zero rows for a `$regex` against a non-string field.
    expect(opsForColumn("bigint")).toContain("contains");
  });

  it("offers ordered comparisons on a text column", () => {
    expect(opsForColumn("varchar(255)")).toContain("between");
  });
});

describe("coerceFilterValue", () => {
  it("types a numeric column's input as a number", () => {
    // MongoDB equality is exact-BSON-type: the string "183" never matches a
    // stored int32 183.
    expect(coerceFilterValue("183", "eq", "int")).toBe(183);
  });

  it("leaves an empty string alone on a numeric column", () => {
    // Number("") is 0, not NaN — coercing here would turn "the user typed
    // nothing" into a filter for zero.
    expect(coerceFilterValue("", "eq", "bigint")).toBe("");
  });

  it("leaves unparseable numeric input as a string", () => {
    expect(coerceFilterValue("abc", "eq", "int")).toBe("abc");
  });

  it("types a boolean column's input", () => {
    expect(coerceFilterValue("true", "eq", "boolean")).toBe(true);
    expect(coerceFilterValue("0", "eq", "bool")).toBe(false);
  });

  it("never coerces for a text-match operator", () => {
    // `contains` matches text whatever the column holds, so the raw string is
    // always the right payload.
    expect(coerceFilterValue("1788", "contains", "bigint")).toBe("1788");
  });

  it("passes the raw string through when the column type is unknown", () => {
    expect(coerceFilterValue("183", "eq", undefined)).toBe("183");
  });
});

describe("coerceFilterValue — an explicit value type", () => {
  it("overrules the field's type in both directions", () => {
    // The bug this exists for: the catalog's 100-document sample said `double`
    // for a field every row on screen held as a string, so `$ne` was asked
    // against an Int32 and excluded nothing. Neither sample can settle a
    // schemaless field; the user can.
    expect(coerceFilterValue("5682380", "ne", "double", "string")).toBe(
      "5682380",
    );
    expect(coerceFilterValue("5682380", "ne", "string", "number")).toBe(
      5682380,
    );
  });

  it("emits Extended JSON for the types a JSON scalar cannot carry", () => {
    // All three are wrappers `db::mongo::values::object_to_bson` already
    // decodes, which is why none of this needed a backend change.
    expect(coerceFilterValue("900", "eq", "string", "long")).toEqual({
      $numberLong: "900",
    });
    expect(
      coerceFilterValue("507f1f77bcf86cd799439011", "eq", "string", "objectId"),
    ).toEqual({ $oid: "507f1f77bcf86cd799439011" });
    expect(
      coerceFilterValue("2026-01-01T00:00:00Z", "eq", "string", "date"),
    ).toEqual({ $date: "2026-01-01T00:00:00Z" });
  });

  it("keeps a long as text rather than rounding it through Number()", () => {
    // 9007199254740993 is the first integer a JS number cannot represent; the
    // whole reason `long` is offered separately from `number`.
    const big = "9007199254740993";
    expect(coerceFilterValue(big, "eq", "long", "long")).toEqual({
      $numberLong: big,
    });
    expect(String(coerceFilterValue(big, "eq", "long", "number"))).not.toBe(big);
  });

  it("still yields the raw string for a text match, whatever the type says", () => {
    // `contains` is a regex against the field's string form, so a typed value
    // would be meaningless — see `db::mongo::query::text_match_branches`.
    expect(coerceFilterValue("900", "contains", "string", "number")).toBe("900");
    expect(coerceFilterValue("900", "starts_with", "string", "long")).toBe(
      "900",
    );
  });

  it("leaves an empty input alone rather than inventing a value", () => {
    // Number("") is 0 and { $oid: "" } is a filter that can only error.
    expect(coerceFilterValue("", "eq", "string", "number")).toBe("");
    expect(coerceFilterValue("", "eq", "string", "objectId")).toBe("");
  });
});

describe("valueTypeOf / valueTextOf", () => {
  it("reads a type back off the payload so a reopened dialog agrees", () => {
    expect(valueTypeOf("900")).toBe("string");
    expect(valueTypeOf(900)).toBe("number");
    expect(valueTypeOf(true)).toBe("boolean");
    expect(valueTypeOf({ $numberLong: "900" })).toBe("long");
    expect(valueTypeOf({ $oid: "507f1f77bcf86cd799439011" })).toBe("objectId");
    expect(valueTypeOf({ $date: "2026-01-01T00:00:00Z" })).toBe("date");
  });

  it("falls back to auto for a shape it does not recognise", () => {
    expect(valueTypeOf(null)).toBe("auto");
    expect(valueTypeOf(undefined)).toBe("auto");
    expect(valueTypeOf({ a: 1, b: 2 })).toBe("auto");
  });

  it("shows the value under the wrapper, not the wrapper", () => {
    expect(valueTextOf({ $numberLong: "900" })).toBe("900");
    expect(valueTextOf({ $oid: "abc" })).toBe("abc");
    expect(valueTextOf(undefined)).toBe("");
  });

  it("reads a list filter's type off its first non-null member", () => {
    // The null member says nothing about the type and must not decide it.
    expect(
      filterValueType({ column: "c", op: "in", values: [null, 900] }),
    ).toBe("number");
  });
});

describe("parseValueList", () => {
  it("splits on CRLF as well as LF", () => {
    // The highest-value assertion here: anything pasted from Excel or a
    // Windows-native source is CRLF-delimited, and a bare \n split leaves an
    // invisible \r on every value — a filter that matches nothing, for a
    // reason nothing on screen can show.
    expect(parseValueList("a\r\nb\r\nc")).toEqual(["a", "b", "c"]);
    expect(parseValueList("a\nb")).toEqual(["a", "b"]);
    expect(parseValueList("a\r\nb\nc\r\n")).toEqual(["a", "b", "c"]);
  });

  it("drops blank lines but keeps interior whitespace", () => {
    // A leading or trailing space can be part of a real value.
    expect(parseValueList("a\n\n b \n")).toEqual(["a", " b "]);
  });

  it("is empty for empty text", () => {
    expect(parseValueList("")).toEqual([]);
  });
});

describe("formatValueList ∘ parseValueList", () => {
  it("round-trips a plain list", () => {
    const text = "alpha\nbeta\ngamma";
    expect(formatValueList(parseValueList(text))).toBe(text);
  });

  it("is idempotent across a second pass", () => {
    const once = formatValueList(["a", "b"]);
    expect(formatValueList(parseValueList(once))).toBe(once);
  });

  it("omits the null member — the checkbox carries that", () => {
    // A magic NULL token would be indistinguishable from the literal string
    // "NULL", which is a legal value in a text column.
    expect(formatValueList(["a", null, "NULL"])).toBe("a\nNULL");
  });
});

describe("filterFromDraft", () => {
  it("returns the seed by reference when the row was not edited", () => {
    // Opening the dialog and pressing Apply must not degrade a payload the
    // draft can only hold as String(value).
    const seed: ColumnFilter = { column: "ts", op: "eq", value: 1788422462450 };
    const draft = draftFromFilter(seed, 1);
    expect(filterFromDraft(draft, "long")).toBe(seed);
  });

  it("returns the seed's values array intact for an untouched list filter", () => {
    const seed: ColumnFilter = {
      column: "id",
      op: "in",
      values: [1, 2, 3],
    };
    const draft = draftFromFilter(seed, 1);
    const out = filterFromDraft(draft, "int");
    expect(out).toBe(seed);
    expect(out.values).toEqual([1, 2, 3]);
  });

  it("rebuilds once the list text actually changes", () => {
    const seed: ColumnFilter = { column: "id", op: "in", values: [1, 2] };
    const draft = patchDraft(draftFromFilter(seed, 1), { listText: "1\n2\n3" });
    const out = filterFromDraft(draft, "int");
    expect(out).not.toBe(seed);
    expect(out.values).toEqual([1, 2, 3]);
  });

  it("round-trips an explicit type through the draft", () => {
    // Reopening the dialog on a filter the user typed must not silently
    // re-coerce it: the seed pass-through covers an untouched row, and the
    // recovered `valueType` covers an edited one.
    const seed: ColumnFilter = { column: "value", op: "ne", value: "5682380" };
    const draft = draftFromFilter(seed, 1);
    expect(draft.valueType).toBe("string");
    expect(draft.value).toBe("5682380");
    // `double` is the catalog lying; the recovered type has to beat it.
    const edited = patchDraft(draft, { value: "5682381" });
    expect(filterFromDraft(edited, "double").value).toBe("5682381");
  });

  it("rebuilds when only the type changed", () => {
    // Changing the type with the text untouched is a real edit — it is the
    // whole point of the control — and must not hit the seed pass-through.
    const seed: ColumnFilter = { column: "value", op: "ne", value: "900" };
    const draft = patchDraft(draftFromFilter(seed, 1), { valueType: "number" });
    const out = filterFromDraft(draft, "string");
    expect(out).not.toBe(seed);
    expect(out.value).toBe(900);
  });

  it("applies one type to every member of a list", () => {
    const draft = patchDraft(emptyDraft("code", 1), {
      op: "in",
      listText: "1\n2",
      valueType: "string",
    });
    expect(filterFromDraft(draft, "int").values).toEqual(["1", "2"]);
  });

  it("appends NULL as a real list member when the checkbox is on", () => {
    const draft = patchDraft(emptyDraft("status", 1), {
      op: "in",
      listText: "a\nb",
      listHasNull: true,
    });
    expect(filterFromDraft(draft, "text").values).toEqual(["a", "b", null]);
  });

  it("rebuilds when only the NULL checkbox changed", () => {
    const seed: ColumnFilter = { column: "s", op: "in", values: ["a"] };
    const draft = patchDraft(draftFromFilter(seed, 1), { listHasNull: true });
    expect(filterFromDraft(draft, "text").values).toEqual(["a", null]);
  });

  it("emits an empty values array for an empty list", () => {
    // The backend's degenerate case is well-defined (IN () -> 1=0), so this
    // must reach it rather than being silently dropped.
    const draft = patchDraft(emptyDraft("id", 1), { op: "in" });
    expect(filterFromDraft(draft, "int")).toEqual({
      column: "id",
      op: "in",
      values: [],
    });
  });

  it("drops the value for a valueless operator", () => {
    const draft = patchDraft(emptyDraft("c", 1), { op: "is_null", value: "x" });
    expect(filterFromDraft(draft, "text").value).toBeUndefined();
  });

  it("only emits value2 for between", () => {
    const base = { value: "1", value2: "9" };
    expect(filterFromDraft(patchDraft(emptyDraft("n", 1), { op: "between", ...base }), "int"))
      .toMatchObject({ value: 1, value2: 9 });
    expect(
      filterFromDraft(patchDraft(emptyDraft("n", 1), { op: "gt", ...base }), "int").value2,
    ).toBeUndefined();
  });

  it("coerces each list value with the column's type", () => {
    const draft = patchDraft(emptyDraft("id", 1), { op: "in", listText: "1\n2" });
    expect(filterFromDraft(draft, "int").values).toEqual([1, 2]);
  });
});

describe("patchDraft", () => {
  it("no longer snaps the operator when the column changes", () => {
    // The snap existed only because opsForColumn withheld operators. With
    // every operator offered for every column it would be dead code; keeping
    // it as a no-op branch is worse than removing it.
    const draft = patchDraft(emptyDraft("name", 1), { op: "contains" });
    expect(patchDraft(draft, { column: "amount" }).op).toBe("contains");
  });
});

describe("isListOp / listValueCount / overlongListRows", () => {
  it("recognises only in and not_in as list operators", () => {
    expect(isListOp("in")).toBe(true);
    expect(isListOp("not_in")).toBe(true);
    expect(isListOp("eq")).toBe(false);
    expect(isListOp("between")).toBe(false);
  });

  it("counts the NULL member, because the backend's cap does", () => {
    const draft = patchDraft(emptyDraft("s", 1), {
      op: "in",
      listText: "a\nb",
      listHasNull: true,
    });
    expect(listValueCount(draft)).toBe(3);
  });

  it("flags a row exactly one value over the cap, and not one at it", () => {
    const at = patchDraft(emptyDraft("s", 1), {
      op: "in",
      listText: Array.from({ length: MAX_FILTER_LIST_VALUES }, (_, i) => i).join("\n"),
    });
    expect(overlongListRows([at]).size).toBe(0);

    const over = patchDraft(at, { listHasNull: true });
    expect(overlongListRows([over])).toEqual(new Set([1]));
  });

  it("ignores a long value in a non-list row", () => {
    const row = patchDraft(emptyDraft("s", 1), { value: "x".repeat(5000) });
    expect(overlongListRows([row]).size).toBe(0);
  });
});
