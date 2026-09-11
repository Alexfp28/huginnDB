import { describe, expect, it } from "vitest";
import { panelsFromBatch } from "./resultPanels";
import type { QueryResult, StmtOutcome } from "@/types";

/**
 * Nothing tested the consumption of `BatchResult` before the results area
 * grew past a single grid — which is precisely where the interesting cases
 * are, because the shape is driven by two things the happy path never shows:
 * statements that return nothing, and a SQL Server statement that returns
 * several result sets.
 */

const rows = (n: number): QueryResult => ({
  columns: [{ name: "n", data_type: "int" }],
  rows: Array.from({ length: n }, (_, i) => [i]),
  rows_affected: n,
  elapsed_ms: 1,
  total: null,
});

const stmt = (over: Partial<StmtOutcome> & { index: number }): StmtOutcome => ({
  preview: "SELECT 1",
  rows_affected: 0,
  is_select: true,
  error: null,
  results: [],
  ...over,
});

describe("panelsFromBatch", () => {
  it("gives one panel per statement that returned rows", () => {
    const panels = panelsFromBatch([
      stmt({ index: 0, results: [rows(3)] }),
      stmt({ index: 1, results: [rows(5)] }),
    ]);
    expect(panels.map((p) => p.statement)).toEqual([1, 2]);
    expect(panels.map((p) => p.result.rows.length)).toEqual([3, 5]);
  });

  it("numbers panels by statement, not by panel", () => {
    // The whole point of the summary above being 1-based per statement: a
    // script whose second statement is an UPDATE must label its third
    // statement's panel `#3`, not `#2`.
    const panels = panelsFromBatch([
      stmt({ index: 0, results: [rows(1)] }),
      stmt({ index: 1, is_select: false, rows_affected: 9 }),
      stmt({ index: 2, results: [rows(2)] }),
    ]);
    expect(panels.map((p) => p.statement)).toEqual([1, 3]);
  });

  it("gives a write no panel at all", () => {
    expect(
      panelsFromBatch([stmt({ index: 0, is_select: false, rows_affected: 4 })]),
    ).toEqual([]);
  });

  it("gives the statement that failed no panel", () => {
    // The batch stops there, so the panels before it are all there is — and
    // they must survive, which is what makes the error worth reading.
    const panels = panelsFromBatch([
      stmt({ index: 0, results: [rows(2)] }),
      stmt({ index: 1, error: "no such column: boom" }),
    ]);
    expect(panels).toHaveLength(1);
    expect(panels[0].statement).toBe(1);
  });

  it("numbers the sets of a statement that returned several", () => {
    // SQL Server: one T-SQL statement, several result sets. Without the
    // ordinal both tabs would read `#1`.
    const panels = panelsFromBatch([
      stmt({ index: 0, results: [rows(1), rows(2)] }),
    ]);
    expect(panels.map((p) => p.set)).toEqual([1, 2]);
    expect(panels.map((p) => p.key)).toEqual(["0:0", "0:1"]);
  });

  it("leaves `set` null for the ordinary one-result statement", () => {
    const [only] = panelsFromBatch([stmt({ index: 0, results: [rows(1)] })]);
    expect(only.set).toBeNull();
  });

  it("keys panels uniquely across statements and sets", () => {
    const panels = panelsFromBatch([
      stmt({ index: 0, results: [rows(1), rows(1)] }),
      stmt({ index: 1, results: [rows(1)] }),
    ]);
    expect(new Set(panels.map((p) => p.key)).size).toBe(panels.length);
  });

  it("returns nothing for a batch where nothing returned", () => {
    expect(panelsFromBatch([])).toEqual([]);
    expect(
      panelsFromBatch([stmt({ index: 0, is_select: false })]),
    ).toEqual([]);
  });

  it("keeps a statement's own truncation flag on its panel", () => {
    // The batch-wide row budget marks the result it cut, and that flag has to
    // reach the tab it belongs to rather than the whole strip.
    const [only] = panelsFromBatch([
      stmt({ index: 0, results: [{ ...rows(2), truncated: true }] }),
    ]);
    expect(only.result.truncated).toBe(true);
  });
});
