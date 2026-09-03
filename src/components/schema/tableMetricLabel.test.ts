/**
 * `tableMetricLabel` is what renders the schema tree's per-table badge. It was
 * exported and untested; these pin the parts that are easy to break by
 * "simplifying" — in particular the `!= null` guards, which a truthiness check
 * would silently turn into "hide zero".
 */

import { describe, expect, it } from "vitest";
import type { TableInfo } from "@/types";
import { tableMetricLabel } from "./SchemaTableRow";

const table = (over: Partial<TableInfo> = {}): TableInfo => ({
  schema: "public",
  name: "users",
  kind: "table",
  ...over,
});

describe("tableMetricLabel", () => {
  it("renders nothing when the metric is off", () => {
    expect(tableMetricLabel(table({ row_count: 10, size_bytes: 2048 }), "none"))
      .toBeNull();
  });

  it("renders the row count alone", () => {
    expect(
      tableMetricLabel(table({ row_count: 12_100, size_bytes: 2048 }), "row-count"),
    ).toBe("12.1k");
  });

  it("renders the size alone", () => {
    expect(
      tableMetricLabel(table({ row_count: 12_100, size_bytes: 2048 }), "size"),
    ).toBe("2.0 KB");
  });

  it("renders both, count first", () => {
    expect(
      tableMetricLabel(table({ row_count: 12_100, size_bytes: 4_509_715 }), "both"),
    ).toBe("12.1k · 4.3 MB");
  });

  it("shows a genuine zero row count", () => {
    // The reason the guard is `!= null` and not `if (t.row_count)`. An empty
    // table is a fact; hiding it makes the badge look broken.
    expect(tableMetricLabel(table({ row_count: 0 }), "row-count")).toBe("0");
    expect(tableMetricLabel(table({ row_count: 0 }), "both")).toBe("0");
  });

  it("shows a genuine zero size", () => {
    expect(tableMetricLabel(table({ size_bytes: 0 }), "size")).toBe("0.0 B");
  });

  it("degrades to the half the driver reported", () => {
    // SQLite reports no row count; a view reports no size. Under "both" the
    // present half still renders rather than the badge vanishing.
    expect(tableMetricLabel(table({ size_bytes: 2048 }), "both")).toBe("2.0 KB");
    expect(tableMetricLabel(table({ row_count: 5 }), "both")).toBe("5");
  });

  it("is null — not an empty string — when neither number exists", () => {
    // The caller renders the badge element only on a non-null return, so ""
    // would paint an empty pill.
    expect(tableMetricLabel(table(), "both")).toBeNull();
    expect(tableMetricLabel(table(), "size")).toBeNull();
  });

  it("treats an explicit null like an absent field", () => {
    // Older payloads serialized `null` rather than omitting the key; the guard
    // has to cover both, which is what `!= null` buys over `!== undefined`.
    const nulled = { ...table(), row_count: null, size_bytes: null } as unknown as TableInfo;
    expect(tableMetricLabel(nulled, "both")).toBeNull();
  });
});
