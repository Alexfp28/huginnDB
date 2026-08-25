// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useConnectionRailSelection } from "./useConnectionRailSelection";

/** Rows as the rail paints them; `c` and `e` come from a shared origin. */
const VISIBLE = ["a", "b", "c", "d", "e"];
const PROTECTED = new Set(["c", "e"]);

function setup(protectedIds = PROTECTED) {
  return renderHook(() => useConnectionRailSelection(protectedIds));
}

const ids = (s: Set<string>) => [...s].sort();

describe("useConnectionRailSelection", () => {
  it("starts empty — a checklist that opens fully checked is a different tool", () => {
    const { result } = setup();
    expect(result.current.checked.size).toBe(0);
  });

  it("toggles one row in and back out", () => {
    const { result } = setup();
    act(() => result.current.toggle("a"));
    expect(ids(result.current.checked)).toEqual(["a"]);
    act(() => result.current.toggle("a"));
    expect(result.current.checked.size).toBe(0);
  });

  it("extends from the last anchor over the visible rows only", () => {
    const { result } = setup();
    act(() => result.current.toggle("a"));
    act(() => result.current.extendTo("d", VISIBLE));
    // `c` is protected and drops out of the range.
    expect(ids(result.current.checked)).toEqual(["a", "b", "d"]);
  });

  it("extends backwards too", () => {
    const { result } = setup();
    act(() => result.current.toggle("d"));
    act(() => result.current.extendTo("b", VISIBLE));
    expect(ids(result.current.checked)).toEqual(["b", "d"]);
  });

  // Without an anchor there is no range; falling back to a plain toggle is what
  // makes a first-gesture Shift-click do something sensible.
  it("falls back to a single toggle with no anchor", () => {
    const { result } = setup();
    act(() => result.current.extendTo("b", VISIBLE));
    expect(ids(result.current.checked)).toEqual(["b"]);
  });

  it("ignores a range whose endpoints are not on screen", () => {
    const { result } = setup();
    act(() => result.current.toggle("a"));
    act(() => result.current.extendTo("zz", VISIBLE));
    expect(ids(result.current.checked)).toEqual(["a"]);
  });

  it("checks all of a list, then clears it when all are already in", () => {
    const { result } = setup();
    act(() => result.current.toggleAll(["a", "b", "d"]));
    expect(ids(result.current.checked)).toEqual(["a", "b", "d"]);
    act(() => result.current.toggleAll(["a", "b", "d"]));
    expect(result.current.checked.size).toBe(0);
  });

  it("leaves a partial list fully checked rather than inverting it", () => {
    const { result } = setup();
    act(() => result.current.toggle("a"));
    act(() => result.current.toggleAll(["a", "b"]));
    expect(ids(result.current.checked)).toEqual(["a", "b"]);
  });

  it("does nothing when every id in the list is protected", () => {
    const { result } = setup();
    act(() => result.current.toggleAll(["c", "e"]));
    expect(result.current.checked.size).toBe(0);
  });

  // The rule the deletion guard rests on: a profile a shared origin publishes is
  // refused by the backend, so offering it as checkable would be an action that
  // silently does nothing.
  it("never lets a protected id in, by any of the four routes", () => {
    const { result } = setup();
    act(() => result.current.toggle("c"));
    act(() => result.current.extendTo("e", VISIBLE));
    act(() => result.current.toggleAll(VISIBLE));
    expect(ids(result.current.checked)).toEqual(["a", "b", "d"]);
    act(() => result.current.clear());
    expect(result.current.checked.size).toBe(0);
  });

  it("keeps the same Set reference when clearing an already-empty selection", () => {
    const { result } = setup();
    const before = result.current.checked;
    act(() => result.current.clear());
    expect(result.current.checked).toBe(before);
  });
});
