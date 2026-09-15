import { beforeEach, describe, expect, it } from "vitest";

import { useTabs } from "@/stores/session/tabs";
import type { AppTab } from "@/types";

function tab(id: string, connectionId: string): AppTab {
  return { id, kind: "query", title: id, connectionId };
}

beforeEach(() => {
  useTabs.setState({ tabs: [], activeId: null });
});

describe("queryTargetFor", () => {
  it("returns the parent when nothing is focused", () => {
    expect(useTabs.getState().queryTargetFor("c1")).toBe("c1");
  });

  it("narrows to the focused tab's database view of the same connection", () => {
    // "New query" while browsing one database of a server-wide connection
    // should land the editor on that database, not reset to the connection's
    // default — the whole reason this helper exists.
    useTabs.getState().replaceAll([tab("t1", "c1::db::shop")], "t1");
    expect(useTabs.getState().queryTargetFor("c1")).toBe("c1::db::shop");
  });

  it("ignores a focused tab belonging to another connection", () => {
    // Deliberate: this resolves a *database* within the connection it is
    // handed. Choosing the connection itself is `focusFollowsTab`'s job, and
    // letting a foreign tab redirect here would make the two disagree.
    useTabs.getState().replaceAll([tab("t1", "c2::db::shop")], "t1");
    expect(useTabs.getState().queryTargetFor("c1")).toBe("c1");
  });

  it("ignores a focused tab on the parent itself", () => {
    useTabs.getState().replaceAll([tab("t1", "c1")], "t1");
    expect(useTabs.getState().queryTargetFor("c1")).toBe("c1");
  });

  it("does not mistake a connection whose id merely starts the same", () => {
    // `c1` vs `c10`: the separator is what makes this a prefix test rather
    // than a substring one.
    useTabs.getState().replaceAll([tab("t1", "c10::db::shop")], "t1");
    expect(useTabs.getState().queryTargetFor("c1")).toBe("c1");
  });
});
