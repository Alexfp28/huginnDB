import { describe, expect, it } from "vitest";
import type { ActionSpec } from "./actions";
import {
  allBindings,
  findConflicts,
  getBinding,
  resolveBindings,
  scopesOverlap,
  userBindings,
  type Keybindings,
} from "./resolve";

// A fixture catalogue rather than the real `ACTIONS`, so these tests pin the
// *rules* and don't have to be rewritten every time a shortcut is added.
const FIXTURE = [
  { id: "runQuery", category: "query", scope: "editor", defaults: ["Mod+Enter"], labelKey: "a" },
  { id: "expandSelectedCell", category: "grid", scope: "grid", defaults: ["Space"], labelKey: "b" },
  {
    id: "refreshData",
    category: "grid",
    scope: "global",
    defaults: ["F5"],
    fixed: ["Mod+R"],
    labelKey: "c",
  },
  { id: "openSettings", category: "general", scope: "global", defaults: ["Mod+,"], labelKey: "d" },
] as unknown as ActionSpec[];

const NONE: Keybindings = {};

describe("scopesOverlap", () => {
  it("lets global be heard alongside anything", () => {
    expect(scopesOverlap("global", "grid")).toBe(true);
    expect(scopesOverlap("editor", "global")).toBe(true);
  });

  it("lets siblings hold the same key, which is the point of scopes", () => {
    expect(scopesOverlap("grid", "editor")).toBe(false);
    expect(scopesOverlap("tree", "overlay")).toBe(false);
  });

  it("overlaps a scope with itself", () => {
    expect(scopesOverlap("grid", "grid")).toBe(true);
  });
});

describe("userBindings", () => {
  it("falls back to the catalogue when the user has no override", () => {
    expect(userBindings(NONE, "runQuery")).toEqual(["Mod+Enter"]);
  });

  it("treats an empty list as a deliberate unbind, not as 'use the default'", () => {
    expect(userBindings({ runQuery: [] }, "runQuery")).toEqual([]);
  });

  it("returns the override list verbatim, primary first", () => {
    expect(userBindings({ runQuery: ["F9", "Mod+Enter"] }, "runQuery")).toEqual([
      "F9",
      "Mod+Enter",
    ]);
  });

  it("tolerates a bare string, which is the pre-1.19 on-disk shape", () => {
    const legacy = { runQuery: "Ctrl+Enter" } as unknown as Keybindings;
    expect(userBindings(legacy, "runQuery")).toEqual(["Ctrl+Enter"]);
  });
});

describe("getBinding", () => {
  it("returns a string, which is what keeps the Zustand selectors stable", () => {
    expect(typeof getBinding(NONE, "runQuery")).toBe("string");
  });

  it("returns the primary binding, not the aliases", () => {
    expect(getBinding({ runQuery: ["F9", "Mod+Enter"] }, "runQuery")).toBe("F9");
  });

  it("returns an empty string for an unbound action", () => {
    expect(getBinding({ runQuery: [] }, "runQuery")).toBe("");
  });
});

describe("allBindings", () => {
  it("appends the non-rebindable fixed bindings after the user's own", () => {
    expect(allBindings(NONE, "refreshData")).toEqual(["F5", "Mod+R"]);
  });

  it("keeps the fixed binding even when the user unbinds the action", () => {
    expect(allBindings({ refreshData: [] }, "refreshData")).toEqual(["Mod+R"]);
  });
});

describe("resolveBindings", () => {
  it("indexes by the first chord so the dispatcher can look up in one step", () => {
    const { index } = resolveBindings(NONE, FIXTURE);
    expect(index.get("Space")?.map((b) => b.actionId)).toEqual(["expandSelectedCell"]);
    expect(index.get("Mod+Enter")?.map((b) => b.actionId)).toEqual(["runQuery"]);
  });

  it("normalizes legacy Ctrl overrides on the way into the index", () => {
    const { index } = resolveBindings({ runQuery: ["Ctrl+Enter"] }, FIXTURE);
    expect(index.has("Mod+Enter")).toBe(true);
    expect(index.has("Ctrl+Enter")).toBe(false);
  });

  it("marks fixed bindings so the UI can render them as non-editable", () => {
    const { index } = resolveBindings(NONE, FIXTURE);
    expect(index.get("Mod+R")?.[0].fixed).toBe(true);
    expect(index.get("F5")?.[0].fixed).toBe(false);
  });

  it("files a chord sequence under its first chord, not its whole text", () => {
    const { index } = resolveBindings({ runQuery: ["Mod+K Mod+S"] }, FIXTURE);
    expect(index.get("Mod+K")?.[0].sequence).toEqual(["Mod+K", "Mod+S"]);
  });

  it("skips an unbound action rather than indexing an empty sequence", () => {
    const { index } = resolveBindings({ expandSelectedCell: [] }, FIXTURE);
    expect(index.has("Space")).toBe(false);
  });

  it("reports two overlapping scopes on one binding as a conflict", () => {
    const { conflicts } = resolveBindings({ openSettings: ["F5"] }, FIXTURE);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].chordSequence).toBe("F5");
    expect([...conflicts[0].actions].sort()).toEqual(["openSettings", "refreshData"]);
  });

  it("does NOT report two sibling scopes sharing a binding", () => {
    // `Space` in the grid and `Space` in the editor are never both audible.
    const { conflicts } = resolveBindings({ runQuery: ["Space"] }, FIXTURE);
    expect(conflicts).toEqual([]);
  });

  it("does NOT report a one-chord binding shadowed by a longer sequence", () => {
    // `Mod+K` alone and `Mod+K Mod+S` share a prefix, not a binding.
    const { conflicts } = resolveBindings(
      { openSettings: ["Mod+K"], refreshData: ["Mod+K Mod+S"] },
      FIXTURE,
    );
    expect(conflicts).toEqual([]);
  });
});

describe("findConflicts", () => {
  it("names what a candidate binding would collide with", () => {
    const clashes = findConflicts(NONE, "openSettings", "F5", FIXTURE);
    expect(clashes.map((c) => c.actionId)).toEqual(["refreshData"]);
  });

  it("stays quiet when the scopes cannot both be heard", () => {
    expect(findConflicts(NONE, "runQuery", "Space", FIXTURE)).toEqual([]);
  });

  it("never reports an action against itself", () => {
    expect(findConflicts(NONE, "runQuery", "Mod+Enter", FIXTURE)).toEqual([]);
  });

  it("catches a collision with a fixed binding, which the old check could not", () => {
    const clashes = findConflicts(NONE, "openSettings", "Mod+R", FIXTURE);
    expect(clashes.map((c) => c.actionId)).toEqual(["refreshData"]);
    expect(clashes[0].fixed).toBe(true);
  });

  it("compares normalized forms, so Ctrl+R and Mod+R are the same key", () => {
    expect(findConflicts(NONE, "openSettings", "Ctrl+R", FIXTURE)).toHaveLength(1);
  });

  it("returns nothing for an unparseable candidate", () => {
    expect(findConflicts(NONE, "openSettings", "", FIXTURE)).toEqual([]);
  });
});
