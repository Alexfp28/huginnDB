/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useMultiSelect } from "./useMultiSelect";

const ALL = ["a", "b", "c"];

describe("useMultiSelect", () => {
  it("starts with everything selected when there is no seed", () => {
    const { result } = renderHook(() => useMultiSelect(ALL));
    expect([...result.current.selected].sort()).toEqual(ALL);
    expect(result.current.allSelected).toBe(true);
  });

  it("starts from the seed when a trigger pre-checks one row", () => {
    const { result } = renderHook(() => useMultiSelect(ALL, ["b"]));
    expect([...result.current.selected]).toEqual(["b"]);
    expect(result.current.allSelected).toBe(false);
  });

  // The two callers disagree on which they pass for "no seed".
  it("treats null and undefined alike", () => {
    const withNull = renderHook(() => useMultiSelect(ALL, null));
    expect(withNull.result.current.selected.size).toBe(3);
    const withUndef = renderHook(() => useMultiSelect(ALL, undefined));
    expect(withUndef.result.current.selected.size).toBe(3);
  });

  it("toggles one id without disturbing the rest", () => {
    const { result } = renderHook(() => useMultiSelect(ALL));
    act(() => result.current.toggle("b"));
    expect([...result.current.selected].sort()).toEqual(["a", "c"]);
    act(() => result.current.toggle("b"));
    expect([...result.current.selected].sort()).toEqual(ALL);
  });

  it("clears on toggleAll when everything is selected, and selects all otherwise", () => {
    const { result } = renderHook(() => useMultiSelect(ALL));
    act(() => result.current.toggleAll());
    expect(result.current.selected.size).toBe(0);
    act(() => result.current.toggleAll());
    expect(result.current.selected.size).toBe(3);
    // From a partial selection, toggleAll selects everything rather than clearing.
    act(() => result.current.toggle("a"));
    act(() => result.current.toggleAll());
    expect(result.current.selected.size).toBe(3);
  });

  it("reseeds back to the seed", () => {
    const { result } = renderHook(() => useMultiSelect(ALL, ["b"]));
    act(() => result.current.toggle("a"));
    expect(result.current.selected.size).toBe(2);
    act(() => result.current.reseed());
    expect([...result.current.selected]).toEqual(["b"]);
  });

  // An empty list is not "all selected" — the header checkbox must not read as
  // checked when there is nothing to check.
  it("is not allSelected when the list is empty", () => {
    const { result } = renderHook(() => useMultiSelect([]));
    expect(result.current.allSelected).toBe(false);
  });
});
