import { describe, expect, it } from "vitest";
import { computeOpenTableKeys, tableTabKey } from "./useOpenTableKeys";
import type { AppTab } from "@/types";

function tableTab(overrides: Partial<AppTab> & { id: string }): AppTab {
  return {
    kind: "table",
    title: "",
    connectionId: "conn1",
    table: "users",
    ...overrides,
  } as AppTab;
}

describe("computeOpenTableKeys", () => {
  it("is null when the active tab isn't a table", () => {
    const tabs = [
      { id: "q1", kind: "query", title: "", connectionId: "conn1" } as AppTab,
      tableTab({ id: "t1" }),
    ];
    const { activeTableKey, openTableKeys } = computeOpenTableKeys(tabs, "q1");
    expect(activeTableKey).toBeNull();
    expect(openTableKeys.has(tableTabKey("conn1", undefined, "users"))).toBe(true);
  });

  it("is null when nothing is active", () => {
    const tabs = [tableTab({ id: "t1" })];
    expect(computeOpenTableKeys(tabs, null).activeTableKey).toBeNull();
  });

  it("does not collide two tables of the same name in different schemas", () => {
    const tabs = [
      tableTab({ id: "t1", schema: "public", table: "users" }),
      tableTab({ id: "t2", schema: "reporting", table: "users" }),
    ];
    const { openTableKeys } = computeOpenTableKeys(tabs, null);
    expect(openTableKeys.has(tableTabKey("conn1", "public", "users"))).toBe(true);
    expect(openTableKeys.has(tableTabKey("conn1", "reporting", "users"))).toBe(true);
    expect(openTableKeys.size).toBe(2);
  });

  it("resolves the active table's key", () => {
    const tabs = [
      tableTab({ id: "t1", schema: "public", table: "orders" }),
      tableTab({ id: "t2", schema: "public", table: "users" }),
    ];
    const { activeTableKey } = computeOpenTableKeys(tabs, "t2");
    expect(activeTableKey).toBe(tableTabKey("conn1", "public", "users"));
  });
});

describe("tableTabKey", () => {
  it("joins connection/schema/table with the NUL escape, never a literal byte", () => {
    const key = tableTabKey("conn1", "public", "users");
    expect(key).toBe("conn1\0public\0users");
    expect(key).not.toContain("\\0");
  });

  it("normalizes an absent schema to an empty segment", () => {
    expect(tableTabKey("conn1", undefined, "users")).toBe("conn1\0\0users");
  });
});
