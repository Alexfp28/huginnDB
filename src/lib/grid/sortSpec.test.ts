import { describe, expect, it } from "vitest";
import {
  nextSort,
  removeSortLevel,
  sortLevelOf,
  sortOnly,
  toggleSortLevel,
  upsertSortLevel,
} from "@/lib/grid/sortSpec";
import type { SortSpec } from "@/types";

const ts: SortSpec = { column: "ts", desc: true };
const code: SortSpec = { column: "code", desc: false };

describe("nextSort", () => {
  it("cycles a plain click ASC → DESC → none on one column", () => {
    expect(nextSort([], "a", false)).toEqual([{ column: "a", desc: false }]);
    expect(nextSort([{ column: "a", desc: false }], "a", false)).toEqual([
      { column: "a", desc: true },
    ]);
    expect(nextSort([{ column: "a", desc: true }], "a", false)).toEqual([]);
  });

  it("collapses a multi-sort to the clicked column on a plain click", () => {
    expect(nextSort([ts, code], "code", false)).toEqual([
      { column: "code", desc: false },
    ]);
  });

  it("adds, flips, then drops a level on an additive click", () => {
    expect(nextSort([ts], "code", true)).toEqual([ts, code]);
    expect(nextSort([ts, code], "code", true)).toEqual([
      ts,
      { column: "code", desc: true },
    ]);
    expect(nextSort([ts, { column: "code", desc: true }], "code", true)).toEqual(
      [ts],
    );
  });
});

describe("sortOnly", () => {
  it("replaces whatever was there", () => {
    expect(sortOnly("code", true)).toEqual([{ column: "code", desc: true }]);
  });
});

describe("upsertSortLevel", () => {
  it("appends a new column as the lowest-precedence level", () => {
    expect(upsertSortLevel([ts], "code", false)).toEqual([ts, code]);
  });

  it("retargets an existing level in place, keeping its rank", () => {
    expect(upsertSortLevel([ts, code], "ts", false)).toEqual([
      { column: "ts", desc: false },
      code,
    ]);
  });

  it("accepts a dotted MongoDB path as a column like any other", () => {
    expect(upsertSortLevel([], "meta.plant", true)).toEqual([
      { column: "meta.plant", desc: true },
    ]);
  });
});

describe("toggleSortLevel", () => {
  it("flips only the named level", () => {
    expect(toggleSortLevel([ts, code], "code")).toEqual([
      ts,
      { column: "code", desc: true },
    ]);
  });

  it("does not add a column that isn't sorted", () => {
    expect(toggleSortLevel([ts], "code")).toEqual([ts]);
  });
});

describe("removeSortLevel", () => {
  it("drops the level and promotes the ones after it", () => {
    expect(removeSortLevel([ts, code], "ts")).toEqual([code]);
    expect(sortLevelOf(removeSortLevel([ts, code], "ts"), "code")).toEqual({
      desc: false,
      rank: 1,
    });
  });
});

describe("sortLevelOf", () => {
  it("reports direction and 1-based rank, or null", () => {
    expect(sortLevelOf([ts, code], "ts")).toEqual({ desc: true, rank: 1 });
    expect(sortLevelOf([ts, code], "code")).toEqual({ desc: false, rank: 2 });
    expect(sortLevelOf([ts, code], "user")).toBeNull();
  });
});
