import { describe, expect, it } from "vitest";

import {
  MAX_FIELD_PATH_DEPTH,
  collectNestedFieldPaths,
  filterFieldsFor,
  matchFieldPaths,
  type FilterField,
} from "./fieldPaths";
import type { BsonTypeTree, CellValue, ColumnInfo } from "@/types";

const COLS = [{ name: "_id" }, { name: "customData" }];

/** `paths(...)` — just the path strings, for the shape assertions. */
const paths = (fields: FilterField[]) => fields.map((f) => f.path);

/** A `ColumnInfo` with only the fields these helpers read. */
function col(name: string, data_type: string): ColumnInfo {
  return {
    name,
    data_type,
    nullable: true,
    is_primary_key: name === "_id",
  } as ColumnInfo;
}

describe("collectNestedFieldPaths", () => {
  it("offers the fields inside a nested document", () => {
    const rows: CellValue[][] = [
      ["a1", { format: "tile", size: { w: 20, h: 20 } }],
    ];
    expect(paths(collectNestedFieldPaths(COLS, rows))).toEqual([
      "_id",
      "customData",
      "customData.format",
      "customData.size",
      "customData.size.w",
      "customData.size.h",
    ]);
  });

  it("lists a parent before its children", () => {
    const rows: CellValue[][] = [["a1", { size: { w: 1 } }]];
    const got = paths(collectNestedFieldPaths(COLS, rows));
    expect(got.indexOf("customData.size")).toBeLessThan(
      got.indexOf("customData.size.w"),
    );
  });

  it("traverses an array without putting its index in the path", () => {
    // `{"items.sku": x}` is how BSON matches any element, so `items.0.sku`
    // would be a *different*, narrower question than the one the user means.
    const rows: CellValue[][] = [
      ["a1", { items: [{ sku: "A" }, { sku: "B", qty: 2 }] }],
    ];
    expect(paths(collectNestedFieldPaths(COLS, rows))).toEqual([
      "_id",
      "customData",
      "customData.items",
      "customData.items.sku",
      "customData.items.qty",
    ]);
  });

  it("spends no depth on the array between two documents", () => {
    // One array per level would otherwise halve the reachable depth.
    let value: CellValue = { leaf: 1 };
    for (let i = 0; i < MAX_FIELD_PATH_DEPTH - 1; i++) {
      value = { deeper: [value] };
    }
    const got = paths(collectNestedFieldPaths([{ name: "root" }], [[value]]));
    expect(got).toContain(
      `root.${"deeper.".repeat(MAX_FIELD_PATH_DEPTH - 1)}leaf`,
    );
  });

  it("stops descending past the depth cap", () => {
    let value: CellValue = { leaf: 1 };
    for (let i = 0; i < MAX_FIELD_PATH_DEPTH + 3; i++) {
      value = { deeper: value };
    }
    const got = paths(collectNestedFieldPaths([{ name: "root" }], [[value]]));
    const deepest = Math.max(...got.map((p) => p.split(".").length));
    // The column name is the first segment, so the cap allows one more.
    expect(deepest).toBe(MAX_FIELD_PATH_DEPTH + 1);
    // The leaf sits below the cap and is simply never offered.
    expect(got.some((p) => p.endsWith(".leaf"))).toBe(false);
  });

  it("caps how many paths one page can contribute", () => {
    const wide: Record<string, CellValue> = {};
    for (let i = 0; i < 50; i++) wide[`f${i}`] = i;
    const got = collectNestedFieldPaths([{ name: "root" }], [[wide]], null, 10);
    expect(got).toHaveLength(10);
  });

  it("types a field from the backend's tree, not from the JSON shape", () => {
    // Display JSON makes an Int64 and a Double both plain numbers, so a guess
    // from the value would mislabel the field — and the label is what drives
    // the filter value's coercion.
    const rows: CellValue[][] = [["a1", { n: 7 }]];
    const types: BsonTypeTree[][] = [["objectId", { n: "long" }]];
    expect(collectNestedFieldPaths(COLS, rows, types)).toEqual([
      { path: "_id", type: "objectId", nested: false },
      { path: "customData", type: "object", nested: false },
      { path: "customData.n", type: "long", nested: true },
    ]);
  });

  it("merges a path's type across rows the way the backend does", () => {
    const rows: CellValue[][] = [
      ["a1", { a: 1, b: 1, c: null }],
      ["a2", { a: 2, b: "two", c: null }],
      ["a3", { a: 3, b: 3, c: 9 }],
    ];
    const byPath = new Map(
      collectNestedFieldPaths(COLS, rows).map((f) => [f.path, f.type]),
    );
    // Agreeing rows keep the type; disagreeing ones are honestly "mixed";
    // a null-only field stays null until a real value shows up.
    expect(byPath.get("customData.a")).toBe("int");
    expect(byPath.get("customData.b")).toBe("mixed");
    expect(byPath.get("customData.c")).toBe("int");
  });

  it("reports an always-null path as null rather than guessing", () => {
    const rows: CellValue[][] = [["a1", { c: null }]];
    const byPath = new Map(
      collectNestedFieldPaths(COLS, rows).map((f) => [f.path, f.type]),
    );
    expect(byPath.get("customData.c")).toBe("null");
  });

  it("records the top-level columns too, for their type", () => {
    // Flat documents contribute no nested path, but the columns themselves are
    // still the page's answer about what those fields hold — which is what the
    // filter coerces its value with (see `filterFieldsFor`).
    const rows: CellValue[][] = [["a1", "tile"], ["a2", null]];
    expect(collectNestedFieldPaths(COLS, rows)).toEqual([
      { path: "_id", type: "string", nested: false },
      { path: "customData", type: "string", nested: false },
    ]);
  });

  it("merges a column's own type across rows the way a path's is merged", () => {
    const rows: CellValue[][] = [["a1", "tile"], ["a2", 3]];
    const byPath = new Map(
      collectNestedFieldPaths(COLS, rows).map((f) => [f.path, f.type]),
    );
    expect(byPath.get("customData")).toBe("mixed");
  });
});

describe("filterFieldsFor", () => {
  const columns = [col("_id", "objectId"), col("customData", "document")];

  it("puts each nested path under the column it belongs to", () => {
    const nested = collectNestedFieldPaths(COLS, [
      ["a1", { format: "tile" }],
    ]);
    expect(paths(filterFieldsFor(columns, nested))).toEqual([
      "_id",
      "customData",
      "customData.format",
    ]);
  });

  it("carries the catalog type for a column and the sampled one for a path", () => {
    const nested: FilterField[] = [
      { path: "customData.n", type: "long", nested: true },
    ];
    expect(filterFieldsFor(columns, nested)).toEqual([
      { path: "_id", type: "objectId", nested: false },
      { path: "customData", type: "document", nested: false },
      { path: "customData.n", type: "long", nested: true },
    ]);
  });

  it("keeps a path whose root is not a column instead of dropping it", () => {
    // Possible when the page and the sampled catalog disagree; the path is
    // still a field the server can resolve.
    const nested: FilterField[] = [
      { path: "extra.thing", type: "string", nested: true },
    ];
    expect(paths(filterFieldsFor(columns, nested))).toEqual([
      "_id",
      "customData",
      "extra.thing",
    ]);
  });

  it("prefers the page's type for a column over the catalog's", () => {
    // The regression this exists for: `infer_columns` samples 100 documents of
    // the *collection* and said `double`, while every row on screen held a
    // string. The filter coerced `5682380` to an Int32, `$ne` excluded nothing,
    // and the grid header two panels away was showing STRING the whole time.
    const cols = [col("_id", "objectId"), col("value", "double")];
    const page: FilterField[] = [
      { path: "value", type: "string", nested: false },
    ];
    expect(filterFieldsFor(cols, page)).toEqual([
      { path: "_id", type: "objectId", nested: false },
      { path: "value", type: "string", nested: false },
    ]);
  });

  it("falls back to the catalog when the page cannot decide", () => {
    // "mixed" and "null" are the page saying it does not know. A guess from the
    // catalog's sample still beats no type at all, and the row's value-type
    // control is there for when both are wrong.
    const cols = [col("value", "double")];
    for (const undecided of ["mixed", "null"]) {
      const page: FilterField[] = [
        { path: "value", type: undecided, nested: false },
      ];
      expect(filterFieldsFor(cols, page)[0].type).toBe("double");
    }
  });

  it("never lists a column twice", () => {
    const nested: FilterField[] = [
      { path: "customData", type: "document", nested: true },
    ];
    expect(paths(filterFieldsFor(columns, nested))).toEqual([
      "_id",
      "customData",
    ]);
  });
});

describe("matchFieldPaths", () => {
  const fields: FilterField[] = [
    { path: "customData", nested: false },
    { path: "customData.format", nested: true },
    { path: "format", nested: false },
  ];

  it("matches anywhere in the dotted path", () => {
    expect(paths(matchFieldPaths(fields, "format"))).toEqual([
      "format",
      "customData.format",
    ]);
  });

  it("puts prefix matches first", () => {
    expect(paths(matchFieldPaths(fields, "customData."))).toEqual([
      "customData.format",
    ]);
  });

  it("is case-insensitive and ignores surrounding space", () => {
    expect(paths(matchFieldPaths(fields, "  FORMAT "))).toEqual([
      "format",
      "customData.format",
    ]);
  });

  it("returns everything for an empty query", () => {
    expect(matchFieldPaths(fields, "  ")).toEqual(fields);
  });
});
