import { describe, expect, it } from "vitest";

import {
  asTable,
  cellText,
  MAX_CELL_CHARS,
  previewJson,
  statementOf,
} from "./toolResult";

describe("cellText", () => {
  it("keeps a JSON value as JSON instead of [object Object]", () => {
    expect(cellText({ enabled: true, mode: "fast" })).toBe(
      '{"enabled":true,"mode":"fast"}',
    );
    expect(cellText([1, 2, 3])).toBe("[1,2,3]");
  });

  it("names a null rather than rendering it as empty", () => {
    expect(cellText(null)).toBe("NULL");
    expect(cellText(undefined)).toBe("NULL");
  });

  it("elides a long value and says so", () => {
    const text = cellText("x".repeat(MAX_CELL_CHARS + 50));
    expect(text).toHaveLength(MAX_CELL_CHARS + 1);
    expect(text.endsWith("…")).toBe(true);
  });

  it("leaves a short string exactly as it was", () => {
    expect(cellText("prod-eu-1")).toBe("prod-eu-1");
    expect(cellText(0)).toBe("0");
    expect(cellText(false)).toBe("false");
  });
});

describe("asTable", () => {
  it("reads QueryResult's shape, with the total and the cap", () => {
    const table = asTable({
      columns: [{ name: "id", data_type: "int" }, { name: "settings" }],
      rows: [[1, { retries: 3 }], [2, null]],
      truncated: true,
      total: 41892,
    });
    expect(table).toEqual({
      columns: ["id", "settings"],
      rows: [
        ["1", '{"retries":3}'],
        ["2", "NULL"],
      ],
      truncated: true,
      total: 41892,
    });
  });

  it("reads rows shaped as objects by column name", () => {
    const table = asTable({
      columns: ["a", "b"],
      rows: [{ a: 1, b: "x" }],
    });
    expect(table?.rows).toEqual([["1", "x"]]);
  });

  it("returns null for a result that is not row-shaped", () => {
    // `describe_table`'s and the list tools' shapes: rendered as JSON rather
    // than forced into a grid that would misrepresent them.
    expect(asTable({ columns: [{ name: "id" }] })).toBeNull();
    expect(asTable(["orders", "users"])).toBeNull();
    expect(asTable({ version: "8.0.36" })).toBeNull();
    expect(asTable(null)).toBeNull();
    expect(asTable("text")).toBeNull();
  });

  it("survives an empty result set", () => {
    expect(asTable({ columns: [], rows: [] })).toEqual({
      columns: [],
      rows: [],
      truncated: false,
      total: undefined,
    });
  });
});

describe("previewJson", () => {
  it("indents so a nested reply is readable", () => {
    expect(previewJson({ a: { b: 1 } })).toBe('{\n  "a": {\n    "b": 1\n  }\n}');
  });

  it("bounds a huge payload", () => {
    const text = previewJson({ rows: Array.from({ length: 500 }, (_, i) => i) }, 100);
    expect(text).toHaveLength(101);
    expect(text.endsWith("…")).toBe(true);
  });
});

describe("statementOf", () => {
  it("finds the statement a run_query call carried", () => {
    expect(statementOf("run_query", { sql: "SELECT 1" })).toBe("SELECT 1");
  });

  it("offers nothing for a tool that did not take a statement", () => {
    expect(statementOf("browse_table", { table: "orders" })).toBeNull();
    expect(statementOf("describe_table", { table: "orders" })).toBeNull();
    expect(statementOf("run_query", {})).toBeNull();
    expect(statementOf("run_query", { sql: "   " })).toBeNull();
    expect(statementOf("run_query", null)).toBeNull();
  });
});
