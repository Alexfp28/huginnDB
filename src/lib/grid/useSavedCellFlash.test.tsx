/**
 * @vitest-environment jsdom
 *
 * The success pulse's state machine. Three things are worth pinning and the
 * rest is the animation, which belongs to CSS:
 *
 * - an unkeyed grid never flashes (there is no identity to flash *at*),
 * - the mark clears itself, so a pulse cannot become a permanent highlight,
 * - a second save re-arms rather than being swallowed by the first's timer,
 *   which is what would happen if the timeout were left running.
 */

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSavedCellFlash } from "./useSavedCellFlash";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("marking a saved cell", () => {
  it("records the cell that just saved", () => {
    const { result } = renderHook(() => useSavedCellFlash());
    expect(result.current.flashed).toBeNull();

    act(() => result.current.markSaved("id=1", "email"));
    expect(result.current.flashed).toEqual({ rowKey: "id=1", column: "email" });
  });

  it("ignores a row with no key", () => {
    // A query result with no identity: not editable, and there would be no way
    // to say *which* row pulsed.
    const { result } = renderHook(() => useSavedCellFlash());
    act(() => result.current.markSaved(null, "email"));
    expect(result.current.flashed).toBeNull();
  });
});

describe("the pulse ends on its own", () => {
  it("clears after the animation", () => {
    const { result } = renderHook(() => useSavedCellFlash());
    act(() => result.current.markSaved("id=1", "email"));
    act(() => void vi.advanceTimersByTime(1000));
    expect(result.current.flashed).toBeNull();
  });

  it("is still lit while the animation runs", () => {
    // Clearing before the 520ms animation ends would truncate the pulse.
    const { result } = renderHook(() => useSavedCellFlash());
    act(() => result.current.markSaved("id=1", "email"));
    act(() => void vi.advanceTimersByTime(500));
    expect(result.current.flashed).not.toBeNull();
  });
});

describe("a second save re-arms the pulse", () => {
  it("moves to the new cell", () => {
    const { result } = renderHook(() => useSavedCellFlash());
    act(() => result.current.markSaved("id=1", "email"));
    act(() => result.current.markSaved("id=2", "name"));
    expect(result.current.flashed).toEqual({ rowKey: "id=2", column: "name" });
  });

  it("does not inherit the first save's deadline", () => {
    // The bug a stale timer produces: save, wait 600ms, save again, and the
    // first timeout fires 100ms later and blanks a pulse that just started.
    const { result } = renderHook(() => useSavedCellFlash());
    act(() => result.current.markSaved("id=1", "email"));
    act(() => void vi.advanceTimersByTime(600));
    act(() => result.current.markSaved("id=2", "name"));
    act(() => void vi.advanceTimersByTime(200));
    expect(result.current.flashed).toEqual({ rowKey: "id=2", column: "name" });
  });
});

describe("it does not outlive the grid", () => {
  it("cancels its timer on unmount", () => {
    // A tab closed mid-pulse would otherwise set state on an unmounted tree.
    const { result, unmount } = renderHook(() => useSavedCellFlash());
    act(() => result.current.markSaved("id=1", "email"));
    unmount();
    expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });
});
