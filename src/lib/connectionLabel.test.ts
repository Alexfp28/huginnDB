import { describe, expect, it } from "vitest";

import {
  databaseOfViewId,
  databaseViewId,
  isDatabaseViewOf,
  isServerWide,
  parentConnectionId,
  sqliteFileLabel,
} from "./connectionLabel";

describe("sqliteFileLabel", () => {
  it("keeps only the file name", () => {
    expect(sqliteFileLabel("/home/u/data/chinook.db")).toBe("chinook.db");
  });

  // A profile written on Windows can reach a Linux install through a shared
  // origin, so both separators have to work regardless of the host.
  it("handles backslashes on any platform", () => {
    expect(sqliteFileLabel("C:\\Users\\u\\chinook.db")).toBe("chinook.db");
    expect(sqliteFileLabel("C:/Users/u\\mixed.db")).toBe("mixed.db");
  });

  it("falls back to the input when there is nothing to trim", () => {
    expect(sqliteFileLabel("chinook.db")).toBe("chinook.db");
    expect(sqliteFileLabel("")).toBe("");
    // A trailing separator leaves an empty last segment; the path is a better
    // answer than a blank label.
    expect(sqliteFileLabel("/home/u/")).toBe("/home/u/");
  });
});

describe("synthetic database-view ids", () => {
  it("round-trips a parent and database", () => {
    const id = databaseViewId("prof-1", "shop");
    expect(parentConnectionId(id)).toBe("prof-1");
    expect(databaseOfViewId(id)).toBe("shop");
  });

  it("treats a plain profile id as its own parent, with no database", () => {
    expect(parentConnectionId("prof-1")).toBe("prof-1");
    expect(databaseOfViewId("prof-1")).toBe("");
  });

  it("recognises a parent's own children only", () => {
    const id = databaseViewId("prof-1", "shop");
    expect(isDatabaseViewOf(id, "prof-1")).toBe(true);
    expect(isDatabaseViewOf(id, "prof-2")).toBe(false);
    expect(isDatabaseViewOf("prof-1", "prof-1")).toBe(false);
  });

  // The separator is split at its *first* occurrence, so a database whose name
  // happens to contain it cannot re-parent the id. The Rust twin
  // (`PoolOwnership::for_id`) pins the same rule.
  it("splits at the first separator", () => {
    const id = databaseViewId("prof-1", "weird::db::name");
    expect(parentConnectionId(id)).toBe("prof-1");
    expect(databaseOfViewId(id)).toBe("weird::db::name");
  });
});

describe("isServerWide", () => {
  const p = (driver: "postgres" | "sqlite", database: string) =>
    ({ driver, database }) as Parameters<typeof isServerWide>[0];

  it("is true for a driver with many databases and none bound", () => {
    expect(isServerWide(p("postgres", ""))).toBe(true);
  });

  it("is false once a database is bound", () => {
    expect(isServerWide(p("postgres", "shop"))).toBe(false);
  });

  // SQLite's file *is* the database, so an empty `database` there means an
  // unconfigured profile, not a server-wide one.
  it("is false for SQLite even with an empty database", () => {
    expect(isServerWide(p("sqlite", ""))).toBe(false);
  });

  it("is false for a missing profile", () => {
    expect(isServerWide(undefined)).toBe(false);
    expect(isServerWide(null)).toBe(false);
  });
});
