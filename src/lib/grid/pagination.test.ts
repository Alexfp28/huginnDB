import { describe, expect, it } from "vitest";

import { nextOffset, pageWindow, prevOffset } from "./pagination";

const base = { offset: 0, pageSize: 100, total: 250, totalEstimated: false, rowsOnPage: 100 };

describe("pageWindow", () => {
  it("labels the page 1-based and clamps the end to an exact total", () => {
    expect(pageWindow({ ...base, offset: 200 })).toMatchObject({ from: 201, to: 250 });
  });

  it("shows a full-page range while the count is unknown", () => {
    expect(pageWindow({ ...base, offset: 200, total: null })).toMatchObject({
      from: 201,
      to: 300,
    });
  });

  it("stops at the last page when the total is exact", () => {
    expect(pageWindow({ ...base, offset: 200 }).canNext).toBe(false);
    expect(pageWindow({ ...base, offset: 100 }).canNext).toBe(true);
  });

  it("keeps going past an estimated total while pages come back full", () => {
    // A stale-statistics estimate that undershoots must not strand the user:
    // the page is full, so there may well be more.
    const w = pageWindow({ ...base, offset: 200, total: 250, totalEstimated: true });
    expect(w.canNext).toBe(true);
  });

  it("disables Next on a short page when the total is unknown", () => {
    expect(
      pageWindow({ ...base, offset: 200, total: null, rowsOnPage: 42 }).canNext,
    ).toBe(false);
  });

  it("disables Prev only on the first page", () => {
    expect(pageWindow(base).canPrev).toBe(false);
    expect(pageWindow({ ...base, offset: 100 }).canPrev).toBe(true);
  });
});

describe("offsets", () => {
  it("never walks before the first page", () => {
    expect(prevOffset(50, 100)).toBe(0);
    expect(prevOffset(100, 100)).toBe(0);
    expect(nextOffset(100, 100)).toBe(200);
  });
});
