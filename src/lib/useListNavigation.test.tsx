// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useListNavigation } from "./useListNavigation";

function arrow(key: "ArrowDown" | "ArrowUp") {
  return { key, preventDefault: () => {} } as unknown as React.KeyboardEvent;
}

describe("useListNavigation", () => {
  it("wraps at both ends when asked to", () => {
    const { result } = renderHook(() => useListNavigation(3, { wrap: true }));
    act(() => void result.current.handleArrows(arrow("ArrowUp")));
    expect(result.current.highlight).toBe(2);
    act(() => void result.current.handleArrows(arrow("ArrowDown")));
    expect(result.current.highlight).toBe(0);
  });

  it("clamps at both ends by default", () => {
    const { result } = renderHook(() => useListNavigation(3));
    act(() => void result.current.handleArrows(arrow("ArrowUp")));
    expect(result.current.highlight).toBe(0);
    for (const _ of [0, 1, 2, 3]) {
      act(() => void result.current.handleArrows(arrow("ArrowDown")));
    }
    expect(result.current.highlight).toBe(2);
  });

  it("stays at 0 on an empty list, wrapping or not", () => {
    const wrapped = renderHook(() => useListNavigation(0, { wrap: true }));
    act(() => void wrapped.result.current.handleArrows(arrow("ArrowDown")));
    expect(wrapped.result.current.highlight).toBe(0);
    const clamped = renderHook(() => useListNavigation(0));
    act(() => void clamped.result.current.handleArrows(arrow("ArrowDown")));
    expect(clamped.result.current.highlight).toBe(0);
  });

  it("pulls the highlight back in bounds when the list shrinks", () => {
    // Otherwise Enter silently resolves a row past the end and does nothing.
    const { result, rerender } = renderHook(
      ({ count }) => useListNavigation(count),
      { initialProps: { count: 5 } },
    );
    act(() => result.current.setHighlight(4));
    rerender({ count: 2 });
    expect(result.current.highlight).toBe(1);
  });

  it("reports whether it consumed the key", () => {
    const { result } = renderHook(() => useListNavigation(3));
    expect(result.current.handleArrows(arrow("ArrowDown"))).toBe(true);
    expect(
      result.current.handleArrows({
        key: "Enter",
        preventDefault: () => {},
      } as unknown as React.KeyboardEvent),
    ).toBe(false);
  });
});
