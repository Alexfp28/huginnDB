import { describe, expect, it } from "vitest";
import { buildCompletions } from "./sqlCompletions";
import { keywordsFor } from "./sqlKeywords";
import type { ColumnInfo, TableInfo } from "@/types";

/**
 * The two halves of the SQL editor's suggestion list had no tests at all,
 * which is how the MongoDB query tab's autocomplete could look broken for a
 * reason neither file was responsible for. Both are pure functions over data
 * the schema store already holds, so pinning them is cheap — and the ranking
 * in particular is load-bearing: Monaco sorts by `sortText` before it falls
 * back to the label, so the tier prefixes are what keep a table you just
 * typed the first letters of above the ~70 keywords that also match.
 */

const table = (name: string, schema = "public"): TableInfo => ({
  schema,
  name,
  kind: "table",
});

const column = (name: string, data_type = "text"): ColumnInfo => ({
  name,
  data_type,
  nullable: true,
  is_primary_key: false,
});

describe("buildCompletions", () => {
  it("ranks tables above columns above keywords", () => {
    const out = buildCompletions({
      tables: [table("users")],
      columns: { "public.users": [column("email")] },
      keywords: ["SELECT"],
    });
    expect(out.map((s) => s.sortText)).toEqual(["1_users", "2_email", "3_SELECT"]);
    expect(out.map((s) => s.kind)).toEqual(["table", "column", "keyword"]);
  });

  it("carries the schema in a table's detail so two can be told apart", () => {
    const [a, b] = buildCompletions({
      tables: [table("users", "public"), table("users", "audit")],
      columns: {},
      keywords: [],
    });
    expect(a.detail).toBe("table — public");
    expect(b.detail).toBe("table — audit");
  });

  it("omits the schema when a table has none (SQLite)", () => {
    const [only] = buildCompletions({
      tables: [table("users", "")],
      columns: {},
      keywords: [],
    });
    expect(only.detail).toBe("table");
  });

  it("dedupes a column name shared by several tables, and says how many", () => {
    const out = buildCompletions({
      tables: [],
      columns: {
        "public.users": [column("id", "uuid")],
        "public.orders": [column("id", "uuid")],
        "public.items": [column("sku", "text")],
      },
      keywords: [],
    });
    expect(out.map((s) => s.label)).toEqual(["id", "sku"]);
    expect(out[0].detail).toBe("column · 2 tables");
    // A column that appears once keeps its type instead — the more useful
    // thing to show when there is no ambiguity to flag.
    expect(out[1].detail).toBe("column — text");
  });

  it("still produces keywords for an empty schema", () => {
    // A tab opened before the explorer has loaded anything is the common case
    // on first run; a suggestion list that were empty there would read as
    // broken autocomplete rather than as a cold cache.
    const out = buildCompletions({ tables: [], columns: {}, keywords: ["SELECT"] });
    expect(out).toHaveLength(1);
  });
});

describe("keywordsFor", () => {
  it("layers a driver's own vocabulary on top of the shared set", () => {
    expect(keywordsFor("postgres")).toContain("RETURNING");
    expect(keywordsFor("mysql")).toContain("ON DUPLICATE KEY UPDATE");
    expect(keywordsFor("postgres")).not.toContain("ON DUPLICATE KEY UPDATE");
    for (const driver of ["postgres", "mysql", "sqlite", "sqlserver"] as const)
      expect(keywordsFor(driver)).toContain("SELECT");
  });

  it("gives MongoDB shell vocabulary and no SQL at all", () => {
    const mongo = keywordsFor("mongodb");
    expect(mongo).toContain("find");
    expect(mongo).toContain("$match");
    expect(mongo).not.toContain("SELECT");
  });

  it("falls back to the shared SQL set when the driver is unknown", () => {
    // Which is what happens in any tab whose profile has not landed in
    // `useConnections.profiles` yet — and is why a MongoDB tab could show
    // literal SQL keywords before the connection list resolved.
    expect(keywordsFor(undefined)).toContain("SELECT");
  });

  it("returns a fresh array each time, so a caller may sort it in place", () => {
    const a = keywordsFor("postgres");
    a.push("SENTINEL");
    expect(keywordsFor("postgres")).not.toContain("SENTINEL");
  });
});
