import { describe, expect, it } from "vitest";
import { databaseViewId } from "@/lib/connectionLabel";
import { parsePatterns } from "./matchesFilter";
import { ALL_SCOPE, type FilterScope } from "./filterScope";
import {
  rowMatchState,
  summarizeMatches,
  totalMatches,
  type SchemaSliceLike,
  type TreeConnectionInput,
} from "./treeMatches";

function slice(part: Partial<SchemaSliceLike> = {}): SchemaSliceLike {
  return {
    databases: [],
    tables: [],
    loading: false,
    initialized: true,
    ...part,
  };
}

const tables = (...names: string[]) => names.map((name) => ({ name }));

const single = (id: string): TreeConnectionInput => ({
  connectionId: id,
  multiDb: false,
  visibleDatabases: null,
});
const multi = (
  id: string,
  visibleDatabases: string[] | null = null,
): TreeConnectionInput => ({ connectionId: id, multiDb: true, visibleDatabases });

describe("summarizeMatches — single-DB connections", () => {
  it("counts matching tables in the connection's own slice", () => {
    const [s] = summarizeMatches(
      [single("c1")],
      { c1: slice({ tables: tables("users", "user_roles", "orders") }) },
      parsePatterns("user"),
      ALL_SCOPE,
    );
    expect(s.count).toBe(2);
    expect(s.byDatabase.size).toBe(0);
    expect(s.coldDatabases).toEqual([]);
  });

  it("is pending while the first fetch is in flight, not zero", () => {
    const [s] = summarizeMatches(
      [single("c1")],
      { c1: slice({ loading: true, initialized: false }) },
      parsePatterns("user"),
      ALL_SCOPE,
    );
    expect(s.pending).toBe(true);
    expect(rowMatchState(s)).toBe("pending");
  });

  it("is a real zero once the slice is initialized and empty", () => {
    const [s] = summarizeMatches(
      [single("c1")],
      { c1: slice({ tables: tables("orders") }) },
      parsePatterns("user"),
      ALL_SCOPE,
    );
    expect(s.count).toBe(0);
    expect(rowMatchState(s)).toBe("none");
  });
});

describe("summarizeMatches — multi-DB connections", () => {
  const byConnection = {
    p: slice({ databases: [{ name: "shop" }, { name: "logs" }, { name: "cold" }] }),
    [databaseViewId("p", "shop")]: slice({ tables: tables("users", "user_roles") }),
    [databaseViewId("p", "logs")]: slice({ tables: tables("access_log") }),
    // "cold" has no slice at all — never opened.
  };

  it("sums the per-database child slices", () => {
    const [s] = summarizeMatches([multi("p")], byConnection, parsePatterns("user"), ALL_SCOPE);
    expect(s.byDatabase.get("shop")).toBe(2);
    expect(s.byDatabase.get("logs")).toBe(0);
    expect(s.count).toBe(2);
  });

  it("reports databases nobody has read as cold rather than as zero", () => {
    const [s] = summarizeMatches([multi("p")], byConnection, parsePatterns("user"), ALL_SCOPE);
    expect(s.coldDatabases).toEqual(["cold"]);
    expect(s.byDatabase.has("cold")).toBe(false);
    // A cold database outranks a real zero: the row must offer to look, not
    // claim there is nothing there.
    const empty = summarizeMatches([multi("p")], byConnection, parsePatterns("zzz"), ALL_SCOPE)[0];
    expect(empty.count).toBe(0);
    expect(rowMatchState(empty)).toBe("unloaded");
  });

  it("respects the visible-databases subset for BOTH counting and coldness", () => {
    // The bug this kills: the old `prefetching` flag walked every database
    // while the warm loop applied the subset, so it stayed true forever.
    const [s] = summarizeMatches(
      [multi("p", ["shop"])],
      byConnection,
      parsePatterns("user"),
      ALL_SCOPE,
    );
    expect(s.byDatabase.has("logs")).toBe(false);
    expect(s.coldDatabases).toEqual([]);
    expect(rowMatchState(s)).toBe("matches");
  });

  it("counts a database matched by its own name", () => {
    const [s] = summarizeMatches([multi("p")], byConnection, parsePatterns("log"), ALL_SCOPE);
    expect(s.databaseNameMatches).toEqual(["logs"]);
    // One for the database name, one for `access_log` inside it.
    expect(s.count).toBe(2);
  });

  it("leaves sibling databases out entirely under a database scope", () => {
    const scope: FilterScope = { kind: "database", connectionId: "p", database: "shop" };
    const [s] = summarizeMatches([multi("p")], byConnection, parsePatterns("user"), scope);
    expect(s.byDatabase.has("logs")).toBe(false);
    expect(s.coldDatabases).toEqual([]);
    expect(s.count).toBe(2);
  });
});

describe("totalMatches", () => {
  it("counts only connections that actually matched", () => {
    const summaries = summarizeMatches(
      [single("a"), single("b"), single("c")],
      {
        a: slice({ tables: tables("users") }),
        b: slice({ tables: tables("orders") }),
        c: slice({ tables: tables("user_roles", "user_tokens") }),
      },
      parsePatterns("user"),
      ALL_SCOPE,
    );
    expect(totalMatches(summaries)).toEqual({
      matches: 3,
      connections: 2,
      cold: 0,
      pending: false,
    });
  });

  it("adds up the cold databases across connections", () => {
    const summaries = summarizeMatches(
      [multi("p"), multi("q")],
      {
        p: slice({ databases: [{ name: "one" }, { name: "two" }] }),
        q: slice({ databases: [{ name: "three" }] }),
      },
      parsePatterns("user"),
      ALL_SCOPE,
    );
    expect(totalMatches(summaries).cold).toBe(3);
  });
});
