import { beforeEach, describe, expect, it } from "vitest";
import { ALL_SCOPE, type FilterScope } from "@/lib/schema/filterScope";
import { useTreeSearch } from "./treeSearch";

const conn: FilterScope = { kind: "connection", connectionId: "c1" };
const db: FilterScope = { kind: "database", connectionId: "c1", database: "shop" };

beforeEach(() => {
  useTreeSearch.getState().clear();
});

describe("commit", () => {
  it("normalises and parses the raw value", () => {
    const s = useTreeSearch.getState();
    s.setRaw("  Users; Orders  ");
    s.commit();
    expect(useTreeSearch.getState().needle).toBe("users; orders");
    expect(useTreeSearch.getState().patterns).toEqual(["users", "orders"]);
  });

  it("keeps the patterns reference when the needle did not change", () => {
    const s = useTreeSearch.getState();
    s.setRaw("users");
    s.commit();
    const first = useTreeSearch.getState().patterns;
    // Whitespace and case differences normalise to the same needle, so nothing
    // downstream should be invalidated — this identity is what lets the
    // explorers depend on `patterns` instead of re-parsing a string per table.
    s.setRaw("  USERS ");
    s.commit();
    expect(useTreeSearch.getState().patterns).toBe(first);
  });

  it("accepts an explicit value, for the empty case the box does not debounce", () => {
    const s = useTreeSearch.getState();
    s.setRaw("users");
    s.commit();
    s.commit("");
    expect(useTreeSearch.getState().needle).toBe("");
    expect(useTreeSearch.getState().patterns).toEqual([]);
  });
});

describe("escape — the layers", () => {
  it("clears the text first, keeping the scope the user chose", () => {
    const s = useTreeSearch.getState();
    s.narrowTo(db);
    s.setRaw("users");
    s.commit();
    expect(s.escape()).toBe("cleared-text");
    expect(useTreeSearch.getState().needle).toBe("");
    expect(useTreeSearch.getState().scope).toEqual(db);
  });

  it("then widens the scope one level per press", () => {
    const s = useTreeSearch.getState();
    s.narrowTo(db);
    expect(s.escape()).toBe("widened");
    expect(useTreeSearch.getState().scope).toEqual(conn);
    expect(useTreeSearch.getState().escape()).toBe("widened");
    expect(useTreeSearch.getState().scope).toEqual(ALL_SCOPE);
  });

  it("reports 'none' when there is nothing left to undo, so the caller can move focus", () => {
    expect(useTreeSearch.getState().escape()).toBe("none");
  });
});

describe("scope", () => {
  it("replaces rather than merges when narrowing to another connection", () => {
    const s = useTreeSearch.getState();
    s.narrowTo(db);
    s.narrowTo({ kind: "connection", connectionId: "c2" });
    expect(useTreeSearch.getState().scope).toEqual({
      kind: "connection",
      connectionId: "c2",
    });
  });

  it("is dropped when its connection is no longer reachable", () => {
    const s = useTreeSearch.getState();
    s.narrowTo(db);
    s.pruneScopeAgainst((id) => id === "c2");
    expect(useTreeSearch.getState().scope).toEqual(ALL_SCOPE);
  });

  it("survives a prune while its connection is still there", () => {
    const s = useTreeSearch.getState();
    s.narrowTo(db);
    s.pruneScopeAgainst((id) => id === "c1");
    expect(useTreeSearch.getState().scope).toEqual(db);
  });
});

describe("clear", () => {
  it("drops the text AND the scope, so a scope can never outlive its search", () => {
    const s = useTreeSearch.getState();
    s.narrowTo(db);
    s.setRaw("users");
    s.commit();
    s.setLimitReached(true);
    s.clear();
    const after = useTreeSearch.getState();
    expect(after.raw).toBe("");
    expect(after.needle).toBe("");
    expect(after.patterns).toEqual([]);
    expect(after.scope).toEqual(ALL_SCOPE);
    expect(after.limitReached).toBe(false);
  });
});
