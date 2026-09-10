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
    expect(collectNestedFieldPaths(COLS, rows)[0].type).toBe("null");
  });

  it("returns nothing for a page of flat documents", () => {
    const rows: CellValue[][] = [["a1", "tile"], ["a2", null]];
    expect(collectNestedFieldPaths(COLS, rows)).toEqual([]);
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
