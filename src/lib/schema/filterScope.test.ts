import { describe, expect, it } from "vitest";
import { databaseViewId } from "@/lib/connectionLabel";
import {
  ALL_SCOPE,
  pruneScope,
  sameScope,
  scopeConnectionId,
  scopeIncludes,
  scopeIncludesDatabase,
  scopeLabel,
  widenScope,
  type FilterScope,
} from "./filterScope";

const conn: FilterScope = { kind: "connection", connectionId: "c1" };
const db: FilterScope = { kind: "database", connectionId: "c1", database: "shop" };

describe("widenScope", () => {
  it("goes database → connection → all", () => {
    expect(widenScope(db)).toEqual(conn);
    expect(widenScope(conn)).toEqual(ALL_SCOPE);
  });

  it("is idempotent at the top, so Escape and Backspace need no depth check", () => {
    expect(widenScope(ALL_SCOPE)).toEqual(ALL_SCOPE);
  });
});

describe("scopeIncludes", () => {
  it("lets everything through for the neutral scope", () => {
    expect(scopeIncludes(ALL_SCOPE, "anything")).toBe(true);
    expect(scopeIncludes(ALL_SCOPE, databaseViewId("c9", "x"))).toBe(true);
  });

  it("includes a connection's synthetic per-database children", () => {
    // The case that decides whether a multi-DB server finds anything at all:
    // every one of its tables lives in a `<parent>::db::<db>` child slice.
    expect(scopeIncludes(conn, "c1")).toBe(true);
    expect(scopeIncludes(conn, databaseViewId("c1", "shop"))).toBe(true);
    expect(scopeIncludes(conn, databaseViewId("c1", "logs"))).toBe(true);
  });

  it("excludes another connection and its children", () => {
    expect(scopeIncludes(conn, "c2")).toBe(false);
    expect(scopeIncludes(conn, databaseViewId("c2", "shop"))).toBe(false);
  });

  it("narrows to one child under a database scope, parent row included", () => {
    expect(scopeIncludes(db, "c1")).toBe(true);
    expect(scopeIncludes(db, databaseViewId("c1", "shop"))).toBe(true);
    expect(scopeIncludes(db, databaseViewId("c1", "logs"))).toBe(false);
  });
});

describe("scopeIncludesDatabase", () => {
  it("accepts every database under `all` and under a connection scope", () => {
    expect(scopeIncludesDatabase(ALL_SCOPE, "c1", "logs")).toBe(true);
    expect(scopeIncludesDatabase(conn, "c1", "logs")).toBe(true);
  });

  it("accepts only the named database under a database scope", () => {
    expect(scopeIncludesDatabase(db, "c1", "shop")).toBe(true);
    expect(scopeIncludesDatabase(db, "c1", "logs")).toBe(false);
  });

  it("rejects another connection's databases", () => {
    expect(scopeIncludesDatabase(conn, "c2", "shop")).toBe(false);
  });
});

describe("pruneScope", () => {
  it("keeps a scope whose connection is still reachable", () => {
    expect(pruneScope(db, (id) => id === "c1")).toEqual(db);
  });

  it("drops a scope whose connection disconnected or was hidden", () => {
    expect(pruneScope(db, () => false)).toEqual(ALL_SCOPE);
    expect(pruneScope(conn, () => false)).toEqual(ALL_SCOPE);
  });

  it("never touches the neutral scope", () => {
    expect(pruneScope(ALL_SCOPE, () => false)).toEqual(ALL_SCOPE);
  });
});

describe("scopeConnectionId / scopeLabel / sameScope", () => {
  it("reports the anchoring profile id", () => {
    expect(scopeConnectionId(ALL_SCOPE)).toBeNull();
    expect(scopeConnectionId(db)).toBe("c1");
  });

  it("labels without needing a translator", () => {
    expect(scopeLabel(ALL_SCOPE, "Prod")).toBe("");
    expect(scopeLabel(conn, "Prod")).toBe("Prod");
    expect(scopeLabel(db, "Prod")).toBe("Prod · shop");
  });

  it("compares by value", () => {
    expect(sameScope(db, { ...db })).toBe(true);
    expect(sameScope(db, conn)).toBe(false);
    expect(sameScope(conn, { kind: "connection", connectionId: "c2" })).toBe(false);
  });
});
